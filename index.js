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
// CONSTANTS
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

for (const dir of ["temp", "backups"]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// GLOBAL STATE
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

// ============================================================
// HELPERS
// ============================================================

function debounce(fn, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), wait);
    };
}

function withTimeout(promise, ms, message) {
    let timer;
    const tp = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(message || "Timeout")),
            ms
        );
    });
    return Promise.race([promise, tp]).finally(() => clearTimeout(timer));
}

function normalizeNumber(input) {
    let n = String(input || "").replace(/[^0-9]/g, "");
    if (n.startsWith("00")) n = n.slice(2);
    if (n.startsWith("0"))  n = n.slice(1);
    if (n.length < 7 || n.length > 15) return null;
    return n;
}

function getAuthPath(number) {
    return path.join("temp", `auth_${number}`);
}

function findExistingSession() {
    if (!fs.existsSync("temp")) return null;
    const dirs = fs.readdirSync("temp")
        .filter(name => name.startsWith("auth_"))
        .filter(name => {
            try { return fs.statSync(path.join("temp", name)).isDirectory(); }
            catch { return false; }
        });
    if (!dirs.length) return null;
    dirs.sort((a, b) =>
        fs.statSync(path.join("temp", b)).mtimeMs -
        fs.statSync(path.join("temp", a)).mtimeMs
    );
    return path.join("temp", dirs[0]);
}

function backupAuth() {
    if (!state.authPath || !fs.existsSync(state.authPath)) return;
    try {
        const dest = path.join(
            "backups",
            `${path.basename(state.authPath)}_${Date.now()}`
        );
        fs.cpSync(state.authPath, dest, { recursive: true, force: true });
        console.log(`${C.gray}💾 Backup: ${dest}${C.reset}`);
    } catch (e) {
        console.log(`${C.red}Backup failed: ${e.message}${C.reset}`);
    }
}

async function closeSocket(client) {
    if (!client) return;
    try { client.ev.removeAllListeners(); } catch {}
    try { client.end(); }                  catch {}
    await delay(500);
}

async function withSocketLock(fn) {
    while (socketLockPromise) {
        try { await socketLockPromise; } catch {}
    }
    const p = (async () => fn())();
    socketLockPromise = p;
    try   { return await p; }
    finally { if (socketLockPromise === p) socketLockPromise = null; }
}

function isAuthFailure(statusCode, errorMessage) {
    return (
        statusCode === DR.loggedOut           ||
        statusCode === DR.forbidden           ||
        statusCode === DR.multideviceMismatch ||
        statusCode === DR.badSession          ||
        statusCode === DR.connectionReplaced  ||
        /logout|logged out|invalid auth|bad session|multidevice mismatch|connection replaced/i
            .test(errorMessage || "")
    );
}

// ============================================================
// SOCKET CREATION
// ============================================================

// BUG FIX: added printQRInTerminal param so pairing mode never shows QR
async function createSocket(number, authPath, printQR = false) {

    if (state.client) {
        const old   = state.client;
        state.client = null;
        await closeSocket(old);
    }

    if (!fs.existsSync(authPath)) fs.mkdirSync(authPath, { recursive: true });

    let authState, saveCreds;
    try {
        const result  = await useMultiFileAuthState(authPath);
        authState     = result.state;
        saveCreds     = result.saveCreds;
    } catch (e) {
        state.authRequired = true;
        state.lastError    = `AUTH_READ_FAILED: ${e.message}`;
        throw new Error(state.lastError);
    }

    let version;
    try   { ({ version } = await fetchLatestBaileysVersion()); }
    catch { version = [2, 3000, 0]; }

    const client = makeWASocket({
        version,
        auth: {
            creds: authState.creds,
            keys:  makeCacheableSignalKeyStore(authState.keys, logger)
        },
        printQRInTerminal: printQR,   // ← FIXED: false during pairing
        logger,
        browser:         Browsers.windows("Chrome"),
        syncFullHistory: false,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage:      async () => ({})
    });

    state.client          = client;
    state.saveCreds       = saveCreds;
    state.credsRegistered = !!authState.creds?.registered;

    return { client, authState, saveCreds };
}

// ============================================================
// REGISTER PERSISTENT HANDLERS
// ============================================================

function registerHandlers() {
    const client = state.client;
    if (!client) return;

    // Remove old listeners before adding — prevents duplicate handlers
    try { client.ev.removeAllListeners("creds.update");       } catch {}
    try { client.ev.removeAllListeners("connection.update");  } catch {}

    client.ev.on("creds.update", debounce(async () => {
        if (!state.saveCreds) return;
        try { await state.saveCreds(); }
        catch (e) { console.log(`${C.red}Creds save error: ${e.message}${C.reset}`); }
    }, 1000));

    client.ev.on("connection.update", handleConnectionUpdate);
}

// ============================================================
// CONNECTION UPDATE HANDLER (normal — after pairing done)
// ============================================================

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, isNewLogin } = update;

    if (connection === "open") {
        state.connected         = true;
        state.loggedOut         = false;
        state.authRequired      = false;
        state.reconnectAttempts = 0;
        state.reconnecting      = false;
        state.lastError         = null;

        if (isNewLogin) {
            console.log(`${C.yellow}🔑 New login!${C.reset}`);
        }

        printConnected();
        return;
    }

    if (connection === "close") {
        state.connected = false;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const errMsg     = lastDisconnect?.error?.message || "";
        state.lastError  = errMsg || `Closed (${statusCode})`;

        console.log(`\n${C.red}❌ Disconnected — code: ${statusCode || "?"}, reason: ${errMsg || "?"}${C.reset}\n`);

        if (state.stopReconnect || state.pairingInProgress) return;

        if (isAuthFailure(statusCode, errMsg)) {
            state.loggedOut    = true;
            state.authRequired = true;
            console.log(`${C.yellow}🔐 Session invalid. Use option 3 to logout and pair again.${C.reset}`);
            return;
        }

        attemptReconnect();
    }
}

// ============================================================
// RECONNECT
// ============================================================

async function attemptReconnect() {
    if (
        state.reconnecting    ||
        state.stopReconnect   ||
        state.loggedOut       ||
        state.pairingInProgress
    ) return;

    state.reconnecting = true;

    try {
        if (state.client) {
            const old   = state.client;
            state.client = null;
            await closeSocket(old);
        }

        state.reconnectAttempts++;

        if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.log(`${C.red}⛔ Max reconnect attempts reached.${C.reset}`);
            return;
        }

        const wait = Math.min(20000, 1000 * Math.pow(2, state.reconnectAttempts - 1));

        console.log(
            `${C.cyan}🔄 Reconnecting in ${(wait / 1000).toFixed(1)}s ` +
            `(${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...${C.reset}`
        );

        await delay(wait);

        if (state.stopReconnect || state.loggedOut || state.pairingInProgress) return;

        backupAuth();

        const res = await withSocketLock(() =>
            createSocket(state.number, state.authPath)
        );

        if (!res) return;

        registerHandlers();
        console.log(`${C.green}🔌 Socket recreated. Waiting for WhatsApp...${C.reset}`);

    } catch (e) {
        console.log(`${C.red}❌ Reconnect failed: ${e.message}${C.reset}`);

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
// WAIT FOR CONNECTION — PAIRING AWARE
//
// BUG FIX (MAIN):
// Old code resolved false on ANY "close" event.
// During pairing, WhatsApp often has a brief disconnect
// during the handshake. Resolving false there meant the
// function exited with "failed" even though code was valid.
//
// Fix: only fail on auth-failure closes or timeout.
//      Ignore transient disconnects and keep waiting.
// ============================================================

function waitForPairingConnection(timeoutMs) {
    return new Promise(resolve => {
        const client = state.client;
        if (!client) { resolve(false); return; }

        let finished = false;

        const finish = (result) => {
            if (finished) return;
            finished = true;
            try { client.ev.off("connection.update", onUpdate); } catch {}
            resolve(result);
        };

        const onUpdate = (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                // SUCCESS — pairing worked
                finish(true);
                return;
            }

            if (connection === "close") {
                const code = lastDisconnect?.error?.output?.statusCode;
                const msg  = lastDisconnect?.error?.message || "";

                // Only fail on permanent auth errors
                // (wrong number, logged out from another device, etc.)
                if (isAuthFailure(code, msg)) {
                    console.log(
                        `${C.red}❌ Auth failure during pairing (code: ${code})${C.reset}`
                    );
                    finish(false);
                    return;
                }

                // Transient close (network hiccup) — keep waiting.
                // Don't resolve false. Timeout will handle the worst case.
                console.log(
                    `${C.gray}⚠️  Brief disconnect (code: ${code}) — still waiting...${C.reset}`
                );
            }
        };

        client.ev.on("connection.update", onUpdate);

        setTimeout(() => {
            if (!finished) {
                console.log(`${C.yellow}⏰ Pairing wait timed out.${C.reset}`);
                finish(false);
            }
        }, timeoutMs);
    });
}

// ============================================================
// PAIRING CODE — WITH RETRY
// ============================================================

async function generatePairingCode() {

    if (state.client && state.connected) {
        console.log(`${C.yellow}⚠️  Already connected.${C.reset}`);
        return;
    }

    const input  = await ask(`${C.cyan}Enter WhatsApp number (with country code, no + or spaces): ${C.reset}`);
    const number = normalizeNumber(input);

    if (!number) {
        console.log(`${C.red}❌ Invalid number. Example: 923001234567${C.reset}`);
        return;
    }

    state.number        = number;
    state.authPath      = getAuthPath(number);
    state.stopReconnect = false;
    state.loggedOut     = false;
    state.authRequired  = false;

    if (state.client) {
        const old   = state.client;
        state.client = null;
        await closeSocket(old);
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        console.log(`\n${C.cyan}🔄 Attempt ${attempt}/${maxAttempts} — Creating socket...${C.reset}`);

        state.pairingInProgress = true;
        state.connected         = false;

        // ── Create socket (QR disabled) ──────────────────────
        try {
            const res = await withSocketLock(() =>
                createSocket(number, state.authPath, false)
            );
            if (!res) throw new Error("Socket creation returned null");
        } catch (e) {
            console.log(`${C.red}❌ Socket error: ${e.message}${C.reset}`);
            state.pairingInProgress = false;
            if (attempt < maxAttempts) { await delay(3000); continue; }
            break;
        }

        // Already registered — no need to pair
        if (state.credsRegistered) {
            console.log(`${C.yellow}ℹ️  Session already registered. Use option 3 to logout.${C.reset}`);
            state.pairingInProgress = false;
            registerHandlers();
            return;
        }

        // ── Temp creds saver (replaced by registerHandlers later) ──
        state.client.ev.removeAllListeners("creds.update");
        state.client.ev.on("creds.update", debounce(async () => {
            if (!state.saveCreds) return;
            try { await state.saveCreds(); } catch {}
        }, 1000));

        await delay(1500); // let socket settle

        // ── Request pairing code ─────────────────────────────
        let code;
        try {
            console.log(`${C.cyan}📲 Requesting pairing code...${C.reset}`);
            code = await withTimeout(
                state.client.requestPairingCode(number),
                30000,
                "Pairing code request timed out"
            );
        } catch (e) {
            console.log(`${C.red}❌ Could not get pairing code: ${e.message}${C.reset}`);
            const old   = state.client;
            state.client = null;
            await closeSocket(old);
            state.pairingInProgress = false;
            if (attempt < maxAttempts) { await delay(3000); continue; }
            break;
        }

        // ── Show code ────────────────────────────────────────
        console.log("");
        console.log(`${C.green}${C.bold}╔══════════════════════════════════════╗${C.reset}`);
        console.log(`${C.green}${C.bold}║   🔐 PAIRING CODE : ${C.white}${C.bold}${code}${C.reset}${C.green}${C.bold}      ║${C.reset}`);
        console.log(`${C.green}${C.bold}╚══════════════════════════════════════╝${C.reset}`);
        console.log(`\n${C.yellow}➤ WhatsApp → Linked Devices → Link with phone number${C.reset}`);
        console.log(`${C.gray}⏳ Waiting up to 2 minutes for you to enter the code...\n${C.reset}`);

        // ── Wait (pairing-aware — ignores transient closes) ──
        const connected = await waitForPairingConnection(120000);

        state.pairingInProgress = false;

        if (connected && state.client) {
            state.connected    = true;
            state.authRequired = false;
            state.loggedOut    = false;
            console.log(`\n${C.green}✅ Pairing successful!${C.reset}`);
            printConnected();
            // Register full persistent handlers
            registerHandlers();
            return;
        }

        // ── Attempt failed ────────────────────────────────────
        if (state.client) {
            const old   = state.client;
            state.client = null;
            await closeSocket(old);
        }

        if (attempt < maxAttempts) {
            console.log(`${C.yellow}🔁 Generating new code and retrying...${C.reset}`);
            await delay(2000);
        }
    }

    console.log(`\n${C.red}❌ All pairing attempts failed.${C.reset}`);
    console.log(`${C.yellow}Try again with option 1, or delete session with option 3 first.${C.reset}`);
}

// ============================================================
// RESTORE SESSION
// ============================================================

async function tryRestoreSession() {
    const authPath = findExistingSession();
    if (!authPath) return;

    const number = path.basename(authPath).replace(/^auth_/, "");
    state.number        = number;
    state.authPath      = authPath;
    state.stopReconnect = false;

    console.log(`\n${C.cyan}🔄 Saved session found for ${number}. Restoring...${C.reset}`);

    try {
        const res = await withSocketLock(() => createSocket(number, authPath));
        if (!res) return;

        registerHandlers();

        for (let i = 0; i < 20; i++) {
            if (state.connected || state.authRequired) break;
            await delay(1000);
        }

        if (state.connected) {
            console.log(`${C.green}✅ Session restored!${C.reset}`);
        } else if (state.authRequired) {
            console.log(`${C.yellow}⚠️  Session invalid. Use option 3 then option 1.${C.reset}`);
        } else {
            console.log(`${C.gray}⏳ Connecting in background...${C.reset}`);
        }
    } catch (e) {
        console.log(`${C.red}❌ Restore failed: ${e.message}${C.reset}`);
    }
}

// ============================================================
// SHOW GROUPS
// ============================================================

async function showGroups() {
    if (!state.client || !state.connected) {
        console.log(`${C.red}❌ Not connected.${C.reset}`);
        return;
    }

    console.log(`${C.cyan}🔄 Fetching groups...${C.reset}`);

    try {
        const groups  = await state.client.groupFetchAllParticipating();
        const entries = Object.entries(groups);

        if (!entries.length) {
            console.log(`${C.yellow}No groups found.${C.reset}`);
            return;
        }

        let idx = 1;
        for (const [jid, g] of entries) {
            console.log(`\n${C.white}${idx}. ${g.subject || "Unnamed"}${C.reset}`);
            console.log(`${C.gray}   ID      : ${jid.replace("@g.us", "")}${C.reset}`);
            console.log(`${C.gray}   Members : ${g.participants?.length ?? "N/A"}${C.reset}`);
            idx++;
        }
        console.log("");
    } catch (e) {
        console.log(`${C.red}❌ Group fetch error: ${e.message}${C.reset}`);
    }
}

// ============================================================
// LOGOUT
// ============================================================

async function logoutAndDelete() {
    if (!state.client && !state.authPath) {
        console.log(`${C.yellow}⚠️  No active session.${C.reset}`);
        return;
    }

    console.log(`${C.red}🛑 Logging out...${C.reset}`);

    state.stopReconnect     = true;
    state.pairingInProgress = false;

    if (state.client) {
        try { state.client.ev.removeAllListeners(); } catch {}
        try { state.client.end(); }                  catch {}
    }

    if (state.authPath && fs.existsSync(state.authPath)) {
        try {
            fs.rmSync(state.authPath, { recursive: true, force: true });
            console.log(`${C.gray}🧹 Auth session deleted.${C.reset}`);
        } catch (e) {
            console.log(`${C.red}❌ Could not delete session: ${e.message}${C.reset}`);
        }
    }

    Object.assign(state, {
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
    });

    console.log(`\n${C.green}✅ Session deleted.${C.reset}`);
    console.log(`${C.cyan}Use option 1 to pair again.${C.reset}`);
}

// ============================================================
// PRINT CONNECTED
// ============================================================

function printConnected() {
    console.log("");
    console.log(`${C.green}${C.bold}╔══════════════════════════════════════╗${C.reset}`);
    console.log(`${C.green}${C.bold}║      ✅  WHATSAPP CONNECTED!         ║${C.reset}`);
    console.log(`${C.green}${C.bold}╚══════════════════════════════════════╝${C.reset}`);
    console.log(`${C.cyan}📱 Number : ${state.number}${C.reset}`);
    console.log(`${C.green}🟢 Status : Online${C.reset}\n`);
}

// ============================================================
// READLINE
// ============================================================

const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout
});

function ask(question) {
    return new Promise(resolve => rl.question(question, resolve));
}

// ============================================================
// BANNER
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
    console.log(`${C.cyan}  ╔══════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.cyan}  ║${C.reset}  📱 ${C.white}WhatsApp Automation Tool${C.reset}             ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}  ║${C.reset}  🔗 ${C.white}Powered by Baileys  •  Termux CLI${C.reset}    ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}  ║${C.reset}  👑 ${C.yellow}Made by KRIX${C.reset}                          ${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}  ╚══════════════════════════════════════════╝${C.reset}`);
}

// ============================================================
// MENU
// ============================================================

function showMenu() {
    const status = state.connected
        ? `${C.green}● Connected (${state.number})${C.reset}`
        : `${C.red}● Disconnected${C.reset}`;

    console.log(`\n${C.cyan}  ┌─────────────────────────────────┐${C.reset}`);
    console.log(    `${C.cyan}  │${C.reset}   ${C.white}${C.bold}KRIX – WhatsApp Menu${C.reset}           ${C.cyan}│${C.reset}`);
    console.log(    `${C.cyan}  ├─────────────────────────────────┤${C.reset}`);
    console.log(    `${C.cyan}  │${C.reset}  ${status}  ${C.cyan}│${C.reset}`);
    console.log(    `${C.cyan}  ├─────────────────────────────────┤${C.reset}`);
    console.log(    `${C.cyan}  │${C.reset}  ${C.white}1.${C.reset} Pair WhatsApp               ${C.cyan}│${C.reset}`);
    console.log(    `${C.cyan}  │${C.reset}  ${C.white}2.${C.reset} Show Groups                 ${C.cyan}│${C.reset}`);
    console.log(    `${C.cyan}  │${C.reset}  ${C.white}3.${C.reset} Logout / Delete Session      ${C.cyan}│${C.reset}`);
    console.log(    `${C.cyan}  │${C.reset}  ${C.white}4.${C.reset} Exit                         ${C.cyan}│${C.reset}`);
    console.log(    `${C.cyan}  └─────────────────────────────────┘${C.reset}`);
}

// ============================================================
// MAIN
// ============================================================

async function main() {

    showBanner();

    await tryRestoreSession();

    while (true) {
        showMenu();
        const choice = (await ask(`\n${C.yellow}  Select option: ${C.reset}`)).trim();

        switch (choice) {
            case "1": await generatePairingCode(); break;
            case "2": await showGroups();          break;
            case "3": await logoutAndDelete();     break;
            case "4":
                console.log(`${C.yellow}👋 Exiting KRIX...${C.reset}`);
                state.stopReconnect = true;
                if (state.client) {
                    try { state.client.ev.removeAllListeners(); } catch {}
                    try { state.client.end(); }                  catch {}
                }
                rl.close();
                process.exit(0);
                break;
            default:
                console.log(`${C.red}❌ Invalid option. Enter 1-4.${C.reset}`);
        }
    }
}

// ============================================================
// CRASH GUARDS
// ============================================================

process.on("uncaughtException",  e => console.log(`${C.red}🔥 Uncaught: ${e.message}${C.reset}`));
process.on("unhandledRejection", r => console.log(`${C.red}🔥 Rejection: ${r}${C.reset}`));

main().catch(e => console.log(`${C.red}🔥 Main error: ${e.message}${C.reset}`));
