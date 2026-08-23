const crypto = require("crypto");
if (!global.crypto) global.crypto = crypto.webcrypto;

const fs   = require("fs");
const path = require("path");
const readline = require("readline");
const pino = require("pino");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason
} = require("@whiskeysockets/baileys");

// ============================================================
//  CONSTANTS
// ============================================================

const MAX_RECONNECT_ATTEMPTS = 10;
const DR = DisconnectReason || {
    loggedOut:           401,
    forbidden:           403,
    connectionClosed:    408,
    connectionLost:      408,
    connectionReplaced:  440,
    timedOut:            408,
    badSession:          500,
    restartRequired:     515,
    multideviceMismatch: 411
};

const logger = pino({ level: "fatal" });

["temp", "backups"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// ============================================================
//  EVENT HELPERS — Baileys ke liye safe versions
// ============================================================

// Kisi bhi event emitter se listener hatao — off / removeListener dono try karta hai
function safeRemoveListener(emitter, event, listener) {
    try { emitter.off?.(event, listener); } catch (_) {}
    try { emitter.removeListener?.(event, listener); } catch (_) {}
}

// once() ka safe version: on() use karta hai, fir khud ko cleanup kar leta hai
function safeOnce(emitter, event, handler) {
    const wrapped = (...args) => {
        cleanup();
        handler(...args);
    };
    function cleanup() {
        safeRemoveListener(emitter, event, wrapped);
    }
    emitter.on(event, wrapped);
    return cleanup;  // manual cleanup ke liye bhi return karta hai
}

// ============================================================
//  GLOBAL STATE
// ============================================================

const state = {
    client:            null,
    number:            null,
    authPath:          null,
    connected:         false,
    loggedOut:         false,
    authRequired:      false,
    reconnecting:      false,
    stopReconnect:     false,
    reconnectAttempts: 0,
    lastError:         null,
    saveCreds:         null,
    credsRegistered:   false,
    pairing:           false,
    pairingInProgress: false
};

let socketLockPromise = null;
let currentTask       = null;

// ============================================================
//  HELPERS
// ============================================================

function debounce(fn, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

function withTimeout(promise, ms, msg) {
    let timer;
    const tp = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg || "Timeout")), ms);
    });
    return Promise.race([promise, tp]).finally(() => clearTimeout(timer));
}

function getAuthPath(number) {
    return path.join("temp", `auth_${number}`);
}

function findExistingSession() {
    if (!fs.existsSync("temp")) return null;
    const dirs = fs.readdirSync("temp").filter(d => d.startsWith("auth_"));
    if (!dirs.length) return null;
    dirs.sort((a, b) =>
        fs.statSync(path.join("temp", b)).mtimeMs -
        fs.statSync(path.join("temp", a)).mtimeMs
    );
    return path.join("temp", dirs[0]);
}

function normalizeNumber(input) {
    let n = (input || "").replace(/[^0-9]/g, "");
    if (n.startsWith("00")) n = n.slice(2);
    if (n.startsWith("0"))  n = n.slice(1);
    if (n.length < 7 || n.length > 15) return null;
    return n;
}

function buildJid(rawTarget) {
    let jid = rawTarget.replace(/\s/g, "");
    if (jid.includes("@")) return jid;                   // already a JID
    const clean = jid.replace(/[^0-9\-]/g, "");
    if (clean.includes("-") || clean.length > 15) {      // group ID
        return `${clean}@g.us`;
    }
    let num = clean;
    if (num.startsWith("00")) num = num.slice(2);
    return `${num}@s.whatsapp.net`;
}

function backupAuth() {
    if (!state.authPath) return;
    try {
        const dest = path.join("backups", `${path.basename(state.authPath)}_${Date.now()}`);
        fs.cpSync(state.authPath, dest, { recursive: true, force: true });
        console.log(`💾 Auth backup done: ${dest}`);
    } catch (e) {
        console.error("Backup failed:", e.message);
    }
}

function closeSocket(client = state.client, timeout = 2500) {
    return new Promise(resolve => {
        if (!client) return resolve();
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        try { client.ev.removeAllListeners?.("connection.update"); } catch (_) {}
        try { client.ev.removeAllListeners?.("creds.update"); }      catch (_) {}
        try {
            client.ev.on("connection.update", u => {
                if (u.connection === "close") done();
            });
        } catch (_) {}
        try { client.end(); } catch (_) {}
        setTimeout(done, timeout);
    });
}

async function withSocketLock(fn) {
    while (socketLockPromise) {
        try { await socketLockPromise; } catch (_) {}
    }
    const p = (async () => fn())();
    socketLockPromise = p;
    try     { return await p; }
    finally { if (socketLockPromise === p) socketLockPromise = null; }
}

function isAuthFailure(code, msg) {
    return (
        code === DR.loggedOut          ||
        code === DR.forbidden          ||
        code === DR.multideviceMismatch||
        code === DR.badSession         ||
        code === DR.connectionReplaced ||
        /logout|logged out|invalid auth|401|403|bad session|multidevice mismatch|connection replaced/i
            .test(msg || "")
    );
}

// ============================================================
//  BANNER
// ============================================================

function showBanner() {
    const C = "\x1b[36m"; // cyan
    const G = "\x1b[32m"; // green
    const Y = "\x1b[33m"; // yellow
    const R = "\x1b[0m";  // reset

    console.log(C + "");
    console.log("  ╔═══════════════════════════════════════════════╗");
    console.log("  ║  ██╗  ██╗██████╗ ██╗██╗  ██╗               ║");
    console.log("  ║  ██║ ██╔╝██╔══██╗██║╚██╗██╔╝               ║");
    console.log("  ║  █████╔╝ ██████╔╝██║ ╚███╔╝                ║");
    console.log("  ║  ██╔═██╗ ██╔══██╗██║ ██╔██╗                ║");
    console.log("  ║  ██║  ██╗██║  ██║██║██╔╝ ██╗               ║");
    console.log("  ║  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝               ║");
    console.log("  ╠═══════════════════════════════════════════════╣");
    console.log(G + "  ║  🔥 WhatsApp Tool   │  Powered by Baileys   " + C + "║");
    console.log(G + "  ║  📱 Termux CLI      │  Auto-Reconnect v2.0  " + C + "║");
    console.log(Y + "  ║  ⚡ Multi-Session   │  Pairing + QR Mode    " + C + "║");
    console.log("  ╚═══════════════════════════════════════════════╝" + R);
    console.log("");
}

// ============================================================
//  MENU
// ============================================================

async function showMenu() {
    const connected = state.connected;
    const dot   = connected ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    const label = connected ? "\x1b[32mCONNECTED\x1b[0m" : "\x1b[31mDISCONNECTED\x1b[0m";
    const num   = state.number ? ` (${state.number})` : "";
    const task  = currentTask && currentTask.isRunning
        ? `\x1b[33m▶ Task running → sent: ${currentTask.sent}\x1b[0m`
        : "";

    console.log("\x1b[33m");
    console.log("  ╔══════════════════════════════════╗");
    console.log(`  ║  ${dot} ${label}${num}`);
    if (task) console.log(`  ║  ${task}`);
    console.log("  ╠══════════════════════════════════╣");
    console.log("  ║  1. Pair / Restore Session       ║");
    console.log("  ║  2. Send Messages (Bulk)         ║");
    console.log("  ║  3. Show Groups                  ║");
    console.log("  ║  4. Stop Current Task            ║");
    console.log("  ║  5. Logout / Delete Session      ║");
    console.log("  ║  6. Exit                         ║");
    console.log("  ╚══════════════════════════════════╝");
    console.log("\x1b[0m");
}

// ============================================================
//  CLI
// ============================================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) {
    return new Promise(resolve => rl.question(q, resolve));
}

// ============================================================
//  SOCKET CREATION
// ============================================================

async function createSocket(number, authPath, qr = false) {
    const old = state.client;
    if (old) { state.client = null; await closeSocket(old); }

    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    let authState, saveCreds;
    try {
        ({ state: authState, saveCreds } = await useMultiFileAuthState(authPath));
    } catch (e) {
        state.authRequired = true;
        state.lastError    = `AUTH_READ_FAILED: ${e.message}`;
        throw new Error(state.lastError);
    }

    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); }
    catch (_) { version = [2, 3000, 0]; }

    const client = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys:  makeCacheableSignalKeyStore(authState.keys, logger)
        },
        printQRInTerminal: qr,
        logger,
        browser:              Browsers.ubuntu("Chrome"),
        syncFullHistory:      false,
        markOnlineOnConnect:  false,
        shouldIgnoreJid:      jid => isJidBroadcast(jid),
        getMessage:           async () => ({})
    });

    state.client          = client;
    state.saveCreds       = saveCreds;
    state.credsRegistered = !!(authState.creds && authState.creds.registered);
    return { client, state: authState, saveCreds };
}

// ============================================================
//  HANDLERS
// ============================================================

function registerHandlers() {
    const client = state.client;
    if (!client) return;

    client.ev.on("creds.update", debounce(async () => {
        try { await state.saveCreds(); }
        catch (e) { console.error("creds save error:", e.message); }
    }, 3000));

    client.ev.on("connection.update", handleConnectionUpdate);
}

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, isNewLogin } = update;

    if (connection === "open") {
        state.connected         = true;
        state.reconnectAttempts = 0;
        state.authRequired      = false;
        state.loggedOut         = false;
        state.lastError         = null;
        state.pairing           = false;
        state.pairingInProgress = false;
        if (isNewLogin) console.log("🔑 New login established!");
        console.log("✅ Connected!");
        return;
    }

    if (connection === "close") {
        state.connected = false;
        const code   = lastDisconnect?.error?.output?.statusCode;
        const errMsg = lastDisconnect?.error?.message || "";
        state.lastError = errMsg || `Connection closed (code=${code})`;
        console.log(`❌ Connection closed — code=${code}  reason=${errMsg}`);

        if (state.pairingInProgress) {
            console.log("⏳ Pairing interrupted...");
            return;
        }
        if (state.stopReconnect) return;

        if (isAuthFailure(code, errMsg)) {
            state.loggedOut    = true;
            state.authRequired = true;
            console.log("🔐 Auth invalid. Use option 5 to delete session, then pair again.");
            return;
        }

        attemptReconnect().catch(e => console.error("Reconnect error:", e));
    }
}

// ============================================================
//  AUTO-RECONNECT
// ============================================================

async function attemptReconnect() {
    if (state.pairingInProgress || state.stopReconnect ||
        state.loggedOut || state.reconnecting || socketLockPromise) return;

    state.reconnecting = true;
    try {
        const old = state.client;
        if (old) { state.client = null; await closeSocket(old); }

        if (state.stopReconnect || state.loggedOut || state.pairingInProgress) return;

        state.reconnectAttempts++;
        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error("⛔ Max reconnect attempts reached.");
            return;
        }

        const backoff = Math.min(20000, 1000 * Math.pow(2, state.reconnectAttempts - 1));
        console.log(`🔄 Reconnecting in ${(backoff / 1000).toFixed(1)}s (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        await delay(backoff);

        if (state.stopReconnect || state.loggedOut || state.pairingInProgress) return;

        backupAuth();

        const res = await withSocketLock(() => createSocket(state.number, state.authPath));
        if (!res) return;
        registerHandlers();
        console.log("✅ Socket recreated.");
    } catch (e) {
        console.error("❌ Reconnect failed:", e.message);
        if (/AUTH_READ_FAILED|Bad file|ENOENT|Invalid key/i.test(e.message)) {
            state.authRequired = true;
            return;
        }
        if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS)
            setTimeout(() => attemptReconnect(), 5000);
    } finally {
        state.reconnecting = false;
    }
}

// ============================================================
//  AUTO-RESTORE SESSION
// ============================================================

async function tryRestoreSession() {
    const authPath = findExistingSession();
    if (!authPath) return;

    const number = path.basename(authPath).replace(/^auth_/, "");
    console.log(`🔄 Found saved session for ${number}. Restoring...`);
    state.number   = number;
    state.authPath = authPath;

    try {
        const res = await withSocketLock(() => createSocket(number, authPath));
        if (!res) return;
        registerHandlers();

        for (let i = 0; i < 15; i++) {
            if (state.connected || state.authRequired) break;
            await delay(1000);
        }

        if (state.connected)         console.log("✅ Session restored and connected.");
        else if (state.authRequired) console.log("⚠️ Session invalid. Use option 1 to pair again.");
        else                         console.log("🔄 Waiting for auto-reconnect...");
    } catch (e) {
        console.error("❌ Restore failed:", e.message);
    }
}

// ============================================================
//  PAIRING
// ============================================================

async function generatePairingCode() {
    const input  = await ask("Enter WhatsApp number (with country code): ");
    const number = normalizeNumber(input);
    if (!number) {
        console.log("❌ Invalid number. Example: 923001234567");
        return;
    }

    const authPath = getAuthPath(number);
    state.number   = number;
    state.authPath = authPath;

    if (state.client && state.connected) {
        console.log("⚠️ Already connected. Use option 5 to logout first.");
        return;
    }
    if (state.client) { await closeSocket(state.client); state.client = null; }

    const MAX_PAIR = 3;
    for (let attempt = 1; attempt <= MAX_PAIR; attempt++) {
        if (attempt > 1) console.log(`\n🔄 Retry ${attempt}/${MAX_PAIR}...`);

        state.pairingInProgress = true;
        state.pairing           = false;

        // Create socket
        try {
            const res = await withSocketLock(() => createSocket(number, authPath, false));
            if (!res) { state.pairingInProgress = false; continue; }
        } catch (e) {
            console.error("❌ Socket failed:", e.message);
            state.pairingInProgress = false;
            if (attempt >= MAX_PAIR) break;
            await delay(3000);
            continue;
        }

        if (state.credsRegistered) {
            console.log("ℹ️ Session already registered. Use option 5 to logout first.");
            state.pairingInProgress = false;
            return;
        }

        // Socket ka pehla update aane tak wait karo
        console.log("⏳ Socket ready hone ka wait...");
        let initCleanup;
        await withTimeout(
            new Promise(resolve => {
                initCleanup = safeOnce(state.client.ev, "connection.update", () => {
                    resolve();
                });
            }),
            8000,
            "Socket init timeout"
        ).catch(() => {
            // Agar 8s mein update nahi aaya toh bhi aage badho
        }).finally(() => {
            if (initCleanup) initCleanup();
        });

        await delay(500); // small buffer

        // Request pairing code
        let code;
        try {
            console.log("🔄 Requesting pairing code...");
            code = await withTimeout(
                state.client.requestPairingCode(number),
                30000,
                "Pairing code request timed out"
            );
        } catch (e) {
            console.error("❌ Could not get code:", e.message);
            state.pairingInProgress = false;
            if (attempt >= MAX_PAIR) break;
            await delay(3000);
            continue;
        }

        // Format: KRIX-WXYZ style agar code 8 chars hai
        const formatted = code && code.length === 8
            ? `${code.slice(0,4)}-${code.slice(4)}`
            : code;

        console.log("\n  ╔══════════════════════════════════════╗");
        console.log(`  ║   🔐 PAIRING CODE:  ${(formatted || "").padEnd(13)} ║`);
        console.log("  ╠══════════════════════════════════════╣");
        console.log("  ║  WhatsApp > Linked Devices >          ║");
        console.log("  ║  Link with phone number > Enter Code  ║");
        console.log("  ╚══════════════════════════════════════╝");
        console.log("  ⏳ Code enter karo (90s mein)...\n");

        state.pairing = true;

        // Listen for open/close
        let onUpdate;
        let credsCleanup;
        let done = false;
        const cleanupPair = () => {
            if (done) return;
            done = true;
            if (onUpdate) safeRemoveListener(state.client.ev, "connection.update", onUpdate);
            if (credsCleanup) credsCleanup();
        };

        const credsHandler = debounce(async () => {
            try { await state.saveCreds(); } catch (_) {}
        }, 3000);

        try {
            await withTimeout(
                new Promise((resolve, reject) => {
                    onUpdate = (update) => {
                        if (update.connection === "open") {
                            state.connected         = true;
                            state.pairing           = false;
                            state.pairingInProgress = false;
                            cleanupPair();
                            resolve();
                        } else if (update.connection === "close") {
                            const code = update.lastDisconnect?.error?.output?.statusCode;
                            // Auth failure = reject, otherwise ignore (might reconnect)
                            if (isAuthFailure(code, update.lastDisconnect?.error?.message)) {
                                cleanupPair();
                                reject(new Error(`Auth failed during pairing (code=${code})`));
                            }
                            // else: ignore close, keep waiting
                        }
                    };
                    state.client.ev.on("connection.update", onUpdate);
                    credsCleanup = safeOnce(state.client.ev, "creds.update", credsHandler);
                }),
                95000,
                "Pairing timeout — code expired ya enter nahi kiya"
            );

            // Success
            console.log("✅ Pairing successful!");
            state.pairingInProgress = false;
            registerHandlers();
            return;

        } catch (e) {
            // Clean up listener if timeout or close fired without removing
            cleanupPair();
            console.log(`⚠️ ${e.message}`);
            state.pairing           = false;
            state.pairingInProgress = false;
            if (attempt >= MAX_PAIR) break;
            await delay(2000);
        }
    }

    // All pairing attempts failed — QR fallback
    state.pairingInProgress = false;
    console.log("❌ Pairing code failed. Falling back to QR code...");
    await fallbackToQR(number, authPath);
}

async function fallbackToQR(number, authPath) {
    if (state.client) { await closeSocket(state.client); state.client = null; }
    console.log("🔄 Starting QR mode...");

    state.pairingInProgress = true;
    let onUpdate;
    let credsCleanup;
    let done = false;
    const cleanupQR = () => {
        if (done) return;
        done = true;
        if (onUpdate && state.client) safeRemoveListener(state.client.ev, "connection.update", onUpdate);
        if (credsCleanup) credsCleanup();
    };

    try {
        const res = await withSocketLock(() => createSocket(number, authPath, true));
        if (!res) return;

        state.pairing = true;
        console.log("📱 Scan the QR above: WhatsApp → Linked Devices → Link a device");
        console.log("⏳ Waiting 120s...\n");

        const credsHandler = debounce(async () => {
            try { await state.saveCreds(); } catch (_) {}
        }, 3000);

        await withTimeout(
            new Promise((resolve, reject) => {
                onUpdate = (update) => {
                    if (update.connection === "open") {
                        state.connected = true;
                        state.pairing   = false;
                        cleanupQR();
                        resolve();
                    } else if (update.connection === "close") {
                        cleanupQR();
                        reject(new Error("Connection closed during QR scan"));
                    }
                };
                state.client.ev.on("connection.update", onUpdate);
                credsCleanup = safeOnce(state.client.ev, "creds.update", credsHandler);
            }),
            122000,
            "QR scan timeout"
        );

        console.log("✅ QR scan successful!");
        registerHandlers();

    } catch (e) {
        cleanupQR();
        console.log(`⚠️ ${e.message}`);
        state.pairing = false;
    } finally {
        state.pairingInProgress = false;
    }
}

// ============================================================
//  SEND MESSAGES
// ============================================================

async function runSendLoop(task) {
    while (task.isRunning && !task.stopRequested) {

        if (state.authRequired || state.loggedOut) {
            console.log("🔐 Auth invalid. Task stopped.");
            task.stopRequested = true;
            break;
        }

        if (!state.client || !state.connected) {
            console.log("⏸  Connection lost. Waiting 5s...");
            await delay(5000);
            continue;
        }

        const raw = task.messages[task.index];
        const msg = task.prefix ? `${task.prefix} ${raw}` : raw;

        try {
            await state.client.sendMessage(task.jid, { text: msg });
            task.sent++;
            console.log(`✅ Sent #${task.sent}${task.jid.includes("@g.us") ? " (group)" : ""}: ${msg.substring(0, 40)}...`);
            task.index = (task.index + 1) % task.messages.length;
        } catch (e) {
            console.error(`❌ Send failed: ${e.message}`);
        }

        await delay(task.delaySec * 1000);
    }

    task.isRunning = false;
    console.log(`🏁 Task finished. Total sent: ${task.sent}`);
}

async function sendMessages() {
    if (!state.client || !state.connected)
        return console.log("❌ Not connected. Use option 1 to pair first.");
    if (state.authRequired || state.loggedOut)
        return console.log("🔐 Auth invalid. Use option 5 then pair again.");
    if (currentTask && currentTask.isRunning)
        return console.log("⚠️ Task already running. Use option 4 to stop it.");

    const rawTarget = await ask("Target (number with country code or Group ID): ");
    const filePath  = await ask("Message file path (e.g., messages.txt): ");
    const prefix    = (await ask("Prefix / Hater Name [Enter to skip]: ")).trim();
    const delaySec  = parseInt(await ask("Delay in seconds [Default 10]: ")) || 10;

    if (!fs.existsSync(filePath)) return console.log("❌ File not found.");

    const messages = fs.readFileSync(filePath, "utf-8")
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l.length > 0);

    if (!messages.length) return console.log("❌ Message file is empty.");

    const jid = buildJid(rawTarget);
    currentTask = {
        jid, messages, delaySec,
        prefix: prefix || null,
        index: 0, sent: 0,
        isRunning: true, stopRequested: false
    };

    console.log(`🚀 Started! Sending to ${jid}. Use option 4 to stop.`);
    runSendLoop(currentTask); // non-blocking
}

// ============================================================
//  SHOW GROUPS
// ============================================================

async function showGroups() {
    if (!state.client || !state.connected)
        return console.log("❌ Not connected. Pair first.");

    console.log("🔄 Fetching groups...");
    try {
        const groups  = await state.client.groupFetchAllParticipating();
        const entries = Object.entries(groups);
        if (!entries.length) return console.log("No groups found.");
        entries.forEach(([gid, g], i) => {
            console.log(`\n  ${i + 1}. ${g.subject}`);
            console.log(`     ID      : ${gid.replace("@g.us", "")}`);
            console.log(`     Members : ${g.participants?.length ?? "N/A"}`);
        });
        console.log("");
    } catch (e) {
        console.error("❌ Error fetching groups:", e.message);
    }
}

// ============================================================
//  LOGOUT / DELETE SESSION
// ============================================================

async function logoutAndDelete() {
    if (!state.client && !state.authPath)
        return console.log("⚠️ No active session found.");

    console.log("🛑 Logging out...");

    if (currentTask && currentTask.isRunning) {
        currentTask.stopRequested = true;
        currentTask.isRunning     = false;
    }

    state.stopReconnect = true;

    if (state.client) {
        try { await state.client.logout().catch(() => {}); } catch (_) {}
        try { state.client.ev.removeAllListeners?.(); state.client.end(); } catch (_) {}
    }

    if (state.authPath && fs.existsSync(state.authPath)) {
        fs.rmSync(state.authPath, { recursive: true, force: true });
        console.log("🧹 Auth files deleted.");
    }

    Object.assign(state, {
        client: null, number: null, authPath: null,
        connected: false, loggedOut: false, authRequired: false,
        reconnecting: false, stopReconnect: false,
        reconnectAttempts: 0, lastError: null,
        saveCreds: null, credsRegistered: false,
        pairing: false, pairingInProgress: false
    });
    currentTask = null;
    console.log("✅ Session cleared. You can pair again.");
}

// ============================================================
//  MAIN LOOP
// ============================================================

async function main() {
    showBanner();
    console.log("  Background Venom — Termux CLI  |  No port. No web. Pure terminal.\n");

    await tryRestoreSession();

    while (true) {
        await showMenu();
        const choice = (await ask("  Select option: ")).trim();

        switch (choice) {
            case "1": await generatePairingCode(); break;
            case "2": await sendMessages();        break;
            case "3": await showGroups();           break;
            case "4":
                if (currentTask && currentTask.isRunning) {
                    currentTask.stopRequested = true;
                    console.log("🛑 Stop requested. Will stop after current message.");
                } else {
                    console.log("ℹ️  No task running.");
                }
                break;
            case "5": await logoutAndDelete(); break;
            case "6":
                console.log("\n  👋 Exiting. Goodbye!\n");
                if (currentTask && currentTask.isRunning) {
                    currentTask.stopRequested = true;
                    currentTask.isRunning     = false;
                }
                if (state.client) {
                    try { state.client.ev.removeAllListeners?.(); state.client.end(); } catch (_) {}
                }
                rl.close();
                process.exit(0);
                break;
            default:
                console.log("❌ Invalid option. Choose 1–6.");
        }
    }
}

// ============================================================
//  CRASH HANDLERS
// ============================================================

process.on("uncaughtException",  err    => console.error("🔥 Uncaught Exception:", err.message));
process.on("unhandledRejection", reason => console.error("🔥 Unhandled Rejection:", reason));

// ============================================================
//  START
// ============================================================
main();
