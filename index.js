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
    loggedOut: 401,
    forbidden: 403,
    connectionClosed: 408,
    connectionLost: 408,
    connectionReplaced: 440,
    timedOut: 408,
    badSession: 500,
    restartRequired: 515,
    multideviceMismatch: 411
};

const C = {
    reset:  "\x1b[0m",
    bold:   "\x1b[1m",
    green:  "\x1b[92m",
    cyan:   "\x1b[96m",
    yellow: "\x1b[93m",
    red:    "\x1b[91m",
    white:  "\x1b[97m",
    gray:   "\x1b[90m"
};

const logger = pino({ level: "fatal" });

["temp", "backups"].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

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

function backupAuth() {
    if (!state.authPath) return;
    try {
        const dest = path.join("backups", `${path.basename(state.authPath)}_${Date.now()}`);
        fs.cpSync(state.authPath, dest, { recursive: true, force: true });
        console.log(`${C.gray}💾 Auth backup: ${dest}${C.reset}`);
    } catch (e) {
        console.error("Backup failed:", e.message);
    }
}

function closeSocket(client = state.client, timeout = 2500) {
    return new Promise(resolve => {
        if (!client) return resolve();
        let settled = false;
        const done  = () => { if (!settled) { settled = true; resolve(); } };
        try { client.ev.removeAllListeners(); } catch (e) {}
        try { client.end(); }                  catch (e) {}
        setTimeout(done, timeout);
    });
}

async function withSocketLock(fn) {
    while (socketLockPromise) {
        try { await socketLockPromise; } catch (e) {}
    }
    const p = (async () => fn())();
    socketLockPromise = p;
    try   { return await p; }
    finally { if (socketLockPromise === p) socketLockPromise = null; }
}

function isAuthFailure(statusCode, errMsg) {
    return (
        statusCode === DR.loggedOut          ||
        statusCode === DR.forbidden          ||
        statusCode === DR.multideviceMismatch||
        statusCode === DR.badSession         ||
        statusCode === DR.connectionReplaced ||
        /logout|logged out|invalid auth|401|403|bad session|multidevice mismatch|connection replaced/i
            .test(errMsg || "")
    );
}

// ============================================================
//  SOCKET CREATION
// ============================================================

async function createSocket(number, authPath, qr = false) {
    const oldClient = state.client;
    if (oldClient) {
        state.client = null;
        await closeSocket(oldClient);
    }

    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    let authState, saveCreds;
    try {
        const loaded = await useMultiFileAuthState(authPath);
        authState  = loaded.state;
        saveCreds  = loaded.saveCreds;
    } catch (e) {
        state.authRequired = true;
        state.lastError    = `AUTH_READ_FAILED: ${e.message}`;
        throw new Error(state.lastError);
    }

    let version;
    try   { ({ version } = await fetchLatestBaileysVersion()); }
    catch (e) { version = [2, 3000, 0]; }

    const client = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys:  makeCacheableSignalKeyStore(authState.keys, logger)
        },
        printQRInTerminal: qr,
        logger,
        browser:          Browsers.windows("Chrome"),
        syncFullHistory:  false,
        shouldIgnoreJid:  jid => isJidBroadcast(jid),
        getMessage:       async () => ({})
    });

    state.client          = client;
    state.saveCreds       = saveCreds;
    state.credsRegistered = !!(authState.creds && authState.creds.registered);

    return { client, state: authState, saveCreds };
}

// ============================================================
//  REGISTER PERSISTENT HANDLERS
// ============================================================

function registerHandlers() {
    const client = state.client;
    if (!client) return;

    client.ev.removeAllListeners("creds.update");
    client.ev.removeAllListeners("connection.update");

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
        if (isNewLogin) console.log(`${C.yellow}🔑 New login established!${C.reset}`);
        console.log(`${C.green}✅ Connected!${C.reset}`);
        return;
    }

    if (connection === "close") {
        state.connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg     = lastDisconnect?.error?.message || "";
        state.lastError  = errMsg || `Connection closed (code=${statusCode})`;
        console.log(`${C.red}❌ Disconnected — code=${statusCode} reason=${errMsg}${C.reset}`);

        if (state.stopReconnect || state.pairingInProgress) return;

        if (isAuthFailure(statusCode, errMsg)) {
            state.loggedOut    = true;
            state.authRequired = true;
            console.log(`${C.yellow}🔐 Auth invalid. Use option 5 to delete session and pair again.${C.reset}`);
            return;
        }

        attemptReconnect().catch(e => console.error("Reconnect error:", e));
    }
}

// ============================================================
//  RECONNECT
// ============================================================

async function attemptReconnect() {
    if (state.pairingInProgress || state.stopReconnect ||
        state.loggedOut          || state.reconnecting) return;

    state.reconnecting = true;
    try {
        if (state.client) {
            const old   = state.client;
            state.client = null;
            await closeSocket(old);
        }

        state.reconnectAttempts++;
        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error(`${C.red}⛔ Max reconnect attempts reached.${C.reset}`);
            return;
        }

        const backoff = Math.min(20000, 1000 * Math.pow(2, state.reconnectAttempts - 1));
        console.log(`${C.cyan}🔄 Reconnecting in ${(backoff/1000).toFixed(1)}s ` +
                    `(attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...${C.reset}`);
        await delay(backoff);

        if (state.stopReconnect || state.loggedOut || state.pairingInProgress) return;

        backupAuth();
        const res = await withSocketLock(() => createSocket(state.number, state.authPath));
        if (!res) return;

        registerHandlers();
        console.log(`${C.green}✅ Socket recreated.${C.reset}`);
    } catch (e) {
        console.error(`${C.red}❌ Reconnect failed:${C.reset}`, e.message);
        if (/AUTH_READ_FAILED|Bad file|ENOENT|Invalid key/i.test(e.message)) {
            state.authRequired = true;
            return;
        }
        if (state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            setTimeout(() => attemptReconnect(), 5000);
        }
    } finally {
        state.reconnecting = false;
    }
}

// ============================================================
//  WAIT FOR CONNECTION HELPER
// ============================================================

function waitForConnection(timeoutMs) {
    return new Promise(resolve => {
        let done = false;

        const onUpdate = (update) => {
            if (done) return;
            if (update.connection === "open") {
                done = true;
                try { state.client.ev.off("connection.update", onUpdate); } catch (e) {}
                resolve(true);
            } else if (update.connection === "close") {
                done = true;
                try { state.client.ev.off("connection.update", onUpdate); } catch (e) {}
                resolve(false);
            }
        };

        state.client.ev.on("connection.update", onUpdate);

        setTimeout(() => {
            if (!done) {
                done = true;
                try { state.client.ev.off("connection.update", onUpdate); } catch (e) {}
                resolve(false);
            }
        }, timeoutMs);
    });
}

// ============================================================
//  PAIRING CODE (FIXED)
// ============================================================

async function generatePairingCode() {
    const input  = await ask(`${C.cyan}Enter WhatsApp number (with country code, no +/spaces): ${C.reset}`);
    const number = normalizeNumber(input);

    if (!number) {
        console.log(`${C.red}❌ Invalid number. Example: 923001234567${C.reset}`);
        return;
    }

    if (state.client && state.connected) {
        console.log(`${C.yellow}⚠️  Already connected. Use option 5 to logout first.${C.reset}`);
        return;
    }

    if (state.client) {
        const old   = state.client;
        state.client = null;
        await closeSocket(old);
    }

    const authPath = getAuthPath(number);
    state.number   = number;
    state.authPath = authPath;

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log(`\n${C.cyan}🔄 Attempt ${attempt}/${maxAttempts} – Creating socket...${C.reset}`);

        state.pairingInProgress = true;
        state.connected         = false;

        try {
            const res = await withSocketLock(() => createSocket(number, authPath, false));
            if (!res) { state.pairingInProgress = false; continue; }
        } catch (err) {
            console.error(`${C.red}❌ Socket error:${C.reset}`, err.message);
            state.pairingInProgress = false;
            await delay(3000);
            continue;
        }

        if (state.credsRegistered) {
            console.log(`${C.yellow}ℹ️  Already registered. Use option 5 to logout first.${C.reset}`);
            state.pairingInProgress = false;
            return;
        }

        // Setup temporary creds saver
        state.client.ev.on("creds.update", debounce(async () => {
            try { await state.saveCreds(); } catch (e) {}
        }, 2000));

        console.log(`${C.cyan}⏳ Waiting for socket initialization...${C.reset}`);
        
        // FIX: Wait for the socket to actually be ready before requesting pairing code
        await new Promise((resolve) => {
            const onReady = (update) => {
                if (update.qr || update.connection === "open" || update.connection === "close") {
                    state.client.ev.off("connection.update", onReady);
                    resolve();
                }
            };
            state.client.ev.on("connection.update", onReady);
            // Backup timeout in case the ready event is missed
            setTimeout(() => {
                state.client.ev.off("connection.update", onReady);
                resolve();
            }, 7000);
        });

        // Start listening for connection results BEFORE requesting the code to avoid missing events
        const connectionPromise = waitForConnection(60000);

        let code;
        try {
            console.log(`${C.cyan}📲 Requesting pairing code...${C.reset}`);
            code = await withTimeout(
                state.client.requestPairingCode(number),
                15000,
                "Pairing code request timed out"
            );
            // Format code cleanly (e.g., XXXX-XXXX)
            code = code?.match(/.{1,4}/g)?.join('-') || code;
        } catch (err) {
            console.error(`${C.red}❌ Could not get pairing code:${C.reset}`, err.message);
            await closeSocket(state.client);
            state.client          = null;
            state.pairingInProgress = false;
            if (attempt < maxAttempts) { await delay(3000); continue; }
            break;
        }

        console.log(`\n${C.green}╔══════════════════════════════════╗${C.reset}`);
        console.log(`${C.green}║  🔐 PAIRING CODE: ${C.bold}${C.white}${code}${C.reset}${C.green}  ║${C.reset}`);
        console.log(`${C.green}╚══════════════════════════════════╝${C.reset}`);
        console.log(`${C.yellow}➤ WhatsApp → Linked Devices → Link with phone number${C.reset}`);
        console.log(`${C.gray}⏳ Waiting up to 60s for connection...\n${C.reset}`);

        // Await the promise we started earlier
        const connected = await connectionPromise;
        state.pairingInProgress = false;

        if (connected && state.client) {
            state.connected    = true;
            state.loggedOut    = false;
            state.authRequired = false;
            console.log(`${C.green}✅ Pairing successful! WhatsApp connected.${C.reset}`);
            registerHandlers(); 
            return;
        }

        if (state.client) {
            await closeSocket(state.client);
            state.client = null;
        }

        if (attempt < maxAttempts) {
            console.log(`${C.yellow}🔁 Retrying with a new code...${C.reset}`);
            await delay(2000);
        }
    }

    console.log(`\n${C.red}❌ All pairing attempts failed. Trying QR code fallback...${C.reset}`);
    await fallbackToQR(number, authPath);
}

// ============================================================
//  QR FALLBACK
// ============================================================

async function fallbackToQR(number, authPath) {
    if (state.client) {
        await closeSocket(state.client);
        state.client = null;
    }

    console.log(`${C.cyan}🔄 Starting QR mode...${C.reset}`);
    state.pairingInProgress = true;

    try {
        const res = await withSocketLock(() => createSocket(number, authPath, true));
        if (!res) { state.pairingInProgress = false; return; }

        state.client.ev.on("creds.update", debounce(async () => {
            try { await state.saveCreds(); } catch (e) {}
        }, 2000));

        console.log(`${C.yellow}📱 Scan QR → WhatsApp → Linked Devices → Link a device${C.reset}`);
        console.log(`${C.gray}⏳ Waiting up to 120s...\n${C.reset}`);

        const connected         = await waitForConnection(120000);
        state.pairingInProgress = false;

        if (connected && state.client) {
            state.connected = true;
            console.log(`${C.green}✅ QR scan successful! Connected.${C.reset}`);
            registerHandlers();
        } else {
            console.log(`${C.red}❌ QR scan failed or timed out.${C.reset}`);
        }
    } catch (err) {
        console.error(`${C.red}❌ QR mode error:${C.reset}`, err.message);
        state.pairingInProgress = false;
    }
}

// ============================================================
//  AUTO RESTORE
// ============================================================

async function tryRestoreSession() {
    const authPath = findExistingSession();
    if (!authPath) return;

    const number = path.basename(authPath).replace(/^auth_/, "");
    console.log(`${C.cyan}🔄 Found saved session for ${number}. Restoring...${C.reset}`);

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

        if (state.connected) {
            console.log(`${C.green}✅ Session restored and connected.${C.reset}`);
        } else if (state.authRequired) {
            console.log(`${C.yellow}⚠️  Session invalid. Use option 1 to pair again.${C.reset}`);
        } else {
            console.log(`${C.gray}🔄 Connecting in background...${C.reset}`);
        }
    } catch (e) {
        console.error(`${C.red}❌ Restore failed:${C.reset}`, e.message);
    }
}

// ============================================================
//  SEND MESSAGES
// ============================================================

async function runSendLoop(task) {
    const { messages, jid, delaySec, prefix } = task;

    while (task.isRunning && !task.stopRequested) {
        if (state.authRequired || state.loggedOut) {
            console.log(`${C.red}🔐 Auth invalid. Task stopped.${C.reset}`);
            break;
        }

        if (!state.client || !state.connected) {
            console.log(`${C.gray}⏸  Not connected, waiting 5s...${C.reset}`);
            await delay(5000);
            continue;
        }

        const raw = messages[task.index];
        const msg = prefix ? `${prefix.trim()} ${raw}` : raw;

        try {
            await state.client.sendMessage(jid, { text: msg });
            task.sent++;
            console.log(`${C.green}✅ Sent #${task.sent}:${C.reset} ${msg.substring(0, 50)}`);
            task.index = (task.index + 1) % messages.length;
        } catch (err) {
            console.error(`${C.red}❌ Send failed:${C.reset}`, err.message);
        }

        await delay(delaySec * 1000);
    }

    task.isRunning = false;
    console.log(`${C.yellow}🏁 Task done. Total sent: ${task.sent}${C.reset}`);
}

async function sendMessages() {
    if (!state.client || !state.connected)
        return console.log(`${C.red}❌ Not connected. Pair first (option 1).${C.reset}`);
    if (state.authRequired || state.loggedOut)
        return console.log(`${C.red}🔐 Auth invalid. Pair again (option 1).${C.reset}`);
    if (currentTask && currentTask.isRunning)
        return console.log(`${C.yellow}⚠️  Task already running. Stop it first (option 4).${C.reset}`);

    const targetType = (await ask(`${C.cyan}Target type [number/group]: ${C.reset}`)).trim().toLowerCase();
    const rawTarget  = (await ask(`${C.cyan}Target (number or group ID): ${C.reset}`)).trim();
    const filePath   = (await ask(`${C.cyan}Message file path (e.g. messages.txt): ${C.reset}`)).trim();
    const prefix     = (await ask(`${C.cyan}Prefix / Hater name [Enter to skip]: ${C.reset}`)).trim();
    const delaySec   = parseInt(await ask(`${C.cyan}Delay in seconds [default 10]: ${C.reset}`)) || 10;

    if (!fs.existsSync(filePath))
        return console.log(`${C.red}❌ File not found: ${filePath}${C.reset}`);

    const messages = fs.readFileSync(filePath, "utf-8")
        .split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    if (!messages.length)
        return console.log(`${C.red}❌ Message file is empty.${C.reset}`);

    let jid;
    if (targetType === "group") {
        const gid = rawTarget.replace(/[^0-9-]/g, "");
        jid = gid.endsWith("@g.us") ? gid : `${gid}@g.us`;
    } else {
        const normalized = normalizeNumber(rawTarget);
        if (!normalized)
            return console.log(`${C.red}❌ Invalid number. Use country code (e.g. 923001234567).${C.reset}`);
        jid = `${normalized}@s.whatsapp.net`;
    }

    currentTask = {
        jid, messages, delaySec,
        prefix: prefix || "",
        index: 0, sent: 0,
        isRunning: true, stopRequested: false
    };

    console.log(`${C.green}🚀 Sending to ${jid}. Option 4 to stop.${C.reset}`);
    runSendLoop(currentTask);
}

// ============================================================
//  SHOW GROUPS
// ============================================================

async function showGroups() {
    if (!state.client || !state.connected)
        return console.log(`${C.red}❌ Not connected.${C.reset}`);

    console.log(`${C.cyan}🔄 Fetching groups...${C.reset}`);
    try {
        const groups = await state.client.groupFetchAllParticipating();
        let i = 1;
        for (const [gid, g] of Object.entries(groups)) {
            const id = gid.replace("@g.us", "");
            console.log(`${C.white}${i}. ${g.subject}${C.reset}`);
            console.log(`   ${C.gray}ID: ${id}${C.reset}`);
            console.log(`   ${C.gray}Members: ${g.participants ? g.participants.length : "N/A"}${C.reset}`);
            i++;
        }
        if (i === 1) console.log(`${C.yellow}No groups found.${C.reset}`);
    } catch (e) {
        console.error(`${C.red}❌ Error:${C.reset}`, e.message);
    }
}

// ============================================================
//  LOGOUT / DELETE SESSION
// ============================================================

async function logoutAndDelete() {
    if (!state.client && !state.authPath)
        return console.log(`${C.yellow}⚠️  No active session.${C.reset}`);

    console.log(`${C.red}🛑 Logging out...${C.reset}`);

    if (currentTask && currentTask.isRunning) {
        currentTask.stopRequested = true;
        currentTask.isRunning     = false;
    }

    state.stopReconnect = true;

    if (state.client) {
        try { state.client.ev.removeAllListeners(); state.client.end(); } catch (e) {}
    }

    if (state.authPath && fs.existsSync(state.authPath)) {
        fs.rmSync(state.authPath, { recursive: true, force: true });
        console.log(`${C.gray}🧹 Auth files deleted.${C.reset}`);
    }

    Object.assign(state, {
        client: null, number: null, authPath: null,
        connected: false, loggedOut: false, authRequired: false,
        reconnecting: false, stopReconnect: false, reconnectAttempts: 0,
        lastError: null, saveCreds: null, credsRegistered: false,
        pairingInProgress: false
    });
    currentTask = null;

    console.log(`${C.green}✅ Session deleted. You can pair again (option 1).${C.reset}`);
}

// ============================================================
//  CLI — READLINE
// ============================================================

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(resolve => rl.question(q, resolve)); }

// ============================================================
//  BANNER + MENU
// ============================================================

function showBanner() {
    console.clear();
    console.log(`${C.green}${C.bold}`);
    console.log("  ██╗  ██╗██████╗ ██╗██╗  ██╗");
    console.log("  ██║ ██╔╝██╔══██╗██║╚██╗██╔╝");
    console.log("  █████╔╝ ██████╔╝██║ ╚███╔╝ ");
    console.log("  ██╔═██╗ ██╔══██╗██║ ██╔██╗ ");
    console.log("  ██║  ██╗██║  ██║██║██╔╝ ██╗");
    console.log("  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═╝");
    console.log(`${C.reset}`);
    console.log(`${C.cyan}  ╔═══════════════════════════════════════╗${C.reset}`);
    console.log(`${C.cyan}  ║${C.reset}  📱 ${C.white}WhatsApp Automation Tool${C.reset}             ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}  ║${C.reset}  🔗 ${C.white}Powered by Baileys  •  Termux CLI${C.reset}    ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}  ║${C.reset}  👑 ${C.yellow}Made by KRIX${C.reset}                         ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}  ╚═══════════════════════════════════════╝${C.reset}`);
}

function showMenu() {
    const status = state.connected
        ? `${C.green}● Connected${C.reset}`
        : `${C.red}● Disconnected${C.reset}`;
    const task   = currentTask && currentTask.isRunning
        ? `${C.yellow}● Task running (sent: ${currentTask.sent})${C.reset}`
        : `${C.gray}● No task${C.reset}`;

    console.log(`\n${C.cyan}  ┌─────────────────────────────┐${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}   ${C.white}KRIX – TERMUX MENU${C.reset}           ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  ├─────────────────────────────┤${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${status}           ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${task}     ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  ├─────────────────────────────┤${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${C.white}1.${C.reset} Pair / Restore Session       ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${C.white}2.${C.reset} Send Messages (bulk)         ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${C.white}3.${C.reset} Show Groups                  ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${C.white}4.${C.reset} Stop Current Task            ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${C.white}5.${C.reset} Logout / Delete Session      ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  │${C.reset}  ${C.white}6.${C.reset} Exit                         ${C.cyan}│${C.reset}`);
    console.log(`${C.cyan}  └─────────────────────────────┘${C.reset}`);
}

// ============================================================
//  MAIN
// ============================================================

async function main() {
    showBanner();

    await tryRestoreSession();

    while (true) {
        showMenu();
        const choice = (await ask(`\n${C.yellow}  Select option: ${C.reset}`)).trim();

        switch (choice) {
            case "1": await generatePairingCode(); break;
            case "2": await sendMessages();        break;
            case "3": await showGroups();          break;
            case "4":
                if (currentTask && currentTask.isRunning) {
                    currentTask.stopRequested = true;
                    console.log(`${C.yellow}🛑 Stop requested. Will stop after current message.${C.reset}`);
                } else {
                    console.log(`${C.gray}ℹ️  No task running.${C.reset}`);
                }
                break;
            case "5": await logoutAndDelete(); break;
            case "6":
                console.log(`${C.yellow}👋 Exiting KRIX...${C.reset}`);
                if (currentTask) {
                    currentTask.stopRequested = true;
                    currentTask.isRunning     = false;
                }
                if (state.client) {
                    try { state.client.ev.removeAllListeners(); state.client.end(); } catch (e) {}
                }
                rl.close();
                process.exit(0);
                break;
            default:
                console.log(`${C.red}❌ Invalid option. Enter 1-6.${C.reset}`);
        }
    }
}

// ============================================================
//  CRASH GUARDS
// ============================================================

process.on("uncaughtException",  err    => console.error(`${C.red}🔥 Uncaught:${C.reset}`, err));
process.on("unhandledRejection", reason => console.error(`${C.red}🔥 Rejection:${C.reset}`, reason));

main();
