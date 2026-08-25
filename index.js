const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    delay, 
    DisconnectReason, 
    Browsers 
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const pino = require("pino");
const readline = require("readline");
const os = require("os");
const crypto = require("crypto");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Total Green Theme
const colors = {
    green: "\x1b[32m",
    brightGreen: "\x1b[92m",
    reset: "\x1b[0m"
};

const color = (text, colorCode = colors.green) => `${colorCode}${text}${colors.reset}`;

const showBanner = () => {
    console.clear();
    console.log(color("██╗    ██╗██╗  ██╗ █████╗ ████████╗███████╗ █████╗ ██████╗", colors.brightGreen));
    console.log(color("██║    ██║██║  ██║██╔══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗", colors.green));
    console.log(color("██║ █╗ ██║███████║███████║   ██║   ███████╗███████║██████╔╝", colors.green));
    console.log(color("██║███╗██║██╔══██║██╔══██║   ██║   ╚════██║██╔══██║██╔═══╝", colors.brightGreen));
    console.log(color("╚███╔███╔╝██║  ██║██║  ██║   ██║   ███████║██║  ██║██║     ", colors.green));
    console.log(color(" ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ", colors.green));
    console.log(color("╔═════════════════════════════════════════════════════════════╗", colors.green));
    console.log(color("║  TOOLS       : WHATSAPP MESSENGER                           ║", colors.brightGreen));
    console.log(color("║  VERSION     : 3.1.0 (LOGIN FIX)                            ║", colors.green));
    console.log(color("║  OWNER       : KRIX                                        ║", colors.brightGreen));
    console.log(color("╚═════════════════════════════════════════════════════════════╝", colors.green));
};

let targetNumbers = [];
let groupIds = [];
let messages = [];
let hateName = "";
let delayTime = 0;
let currentIndex = 0;
let sock = null;
let isConfigured = false;
let isSending = false;

const autoSeeStatuses = (socket) => {
    socket.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.fromMe || msg.message?.protocolMessage) continue;
            try {
                await socket.readMessages([msg.key]);
            } catch (e) {}
        }
    });
};

async function startSending() {
    if (isSending) return;
    isSending = true;

    while (isSending) {
        for (let i = currentIndex; i < messages.length; i++) {
            try {
                if (!sock) {
                    await delay(2000);
                    continue;
                }
                const time = new Date().toLocaleTimeString();
                const finalMessage = hateName ? `${hateName} ${messages[i]}` : messages[i];

                if (targetNumbers.length > 0) {
                    for (const number of targetNumbers) {
                        const jid = number.endsWith("@s.whatsapp.net") ? number : `${number}@s.whatsapp.net`;
                        await sock.sendMessage(jid, { text: finalMessage });
                        console.log(color(`[✓] Sent to: ${number}`));
                    }
                } else if (groupIds.length > 0) {
                    for (const group of groupIds) {
                        const jid = group.endsWith("@g.us") ? group : `${group}@g.us`;
                        await sock.sendMessage(jid, { text: finalMessage });
                        console.log(color(`[✓] Sent to group: ${group}`));
                    }
                }

                console.log(color(`[TIME] ${time}`));
                console.log(color(`[MESSAGE] ${finalMessage}`));
                console.log(color(`[DELAY] ${delayTime} seconds`));
                
                await delay(delayTime * 1000);
            } catch (err) {
                console.log(color(`[ERROR] ${err.message}`));
                currentIndex = i;
                await delay(5000);
            }
        }
        currentIndex = 0;
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    });

    sock.ev.on("creds.update", saveCreds);

    if (!sock.authState.creds.registered) {
        showBanner();
        let phoneNumber = await question(color("[+] Enter phone number with country code (e.g. 919876543210): "));
        phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

        if (!phoneNumber) {
            console.log(color("[!] Invalid phone number provided. Restarting..."));
            return setTimeout(connectToWhatsApp, 2000);
        }

        await delay(5000);

        try {
            const code = await sock.requestPairingCode(phoneNumber);
            showBanner();
            console.log(color(`\n[✓] YOUR PAIRING CODE: ${code}\n`, colors.brightGreen));
            console.log(color("[!] Enter this code on WhatsApp (Linked Devices -> Link with phone number)\n"));
        } catch (err) {
            console.log(color(`[!] Pairing Code Request Failed: ${err.message}`));
            console.log(color("[!] Deleting old 'auth_info' session and retrying..."));
            if (fs.existsSync("./auth_info")) {
                fs.rmSync("./auth_info", { recursive: true, force: true });
            }
            return setTimeout(connectToWhatsApp, 3000);
        }
    }

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            showBanner();
            console.log(color("[✓] WhatsApp Connected Successfully!", colors.brightGreen));

            autoSeeStatuses(sock);

            if (!isConfigured) {
                isConfigured = true;

                const choice = await question(color("\n[1] Send to Numbers\n[2] Send to Groups\nChoose option: "));

                if (choice === '1') {
                    const count = parseInt(await question(color("[+] How many target numbers? ")));
                    for (let i = 0; i < count; i++) {
                        const number = await question(color(`[+] Enter target number ${i + 1}: `));
                        targetNumbers.push(number.replace(/[^0-9]/g, ""));
                    }
                } else if (choice === '2') {
                    try {
                        const groups = await sock.groupFetchAllParticipating();
                        const groupList = Object.keys(groups);
                        console.log(color("\n[✓] Your WhatsApp Groups:"));
                        groupList.forEach((id, idx) => {
                            console.log(color(`[${idx + 1}] ${groups[id].subject} - ${id}`));
                        });
                        const groupCount = parseInt(await question(color("\n[+] How many groups to target? ")));
                        for (let i = 0; i < groupCount; i++) {
                            const groupId = await question(color(`[+] Enter group UID ${i + 1}: `));
                            groupIds.push(groupId);
                        }
                    } catch (e) {
                        console.log(color(`[!] Group fetch error: ${e.message}`));
                    }
                }

                const msgFile = await question(color("[+] Enter message file path: "));
                if (!fs.existsSync(msgFile)) {
                    console.log(color("[!] File does not exist! Please re-run the script with a valid path."));
                    process.exit(1);
                }
                messages = fs.readFileSync(msgFile, "utf-8").split("\n").filter(line => line.trim());

                hateName = await question(color("[+] Enter prefix name (or press Enter to skip): "));
                const delayInput = await question(color("[+] Enter delay in seconds: "));
                delayTime = parseFloat(delayInput) || 5;

                console.log(color("\n[✓] Target setup complete. Starting sending task...\n", colors.brightGreen));
                showBanner();
                
                startSending();
            }
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;

            if (isLoggedOut) {
                console.log(color("[!] Session logged out by WhatsApp. Clearing './auth_info'..."));
                if (fs.existsSync("./auth_info")) {
                    fs.rmSync("./auth_info", { recursive: true, force: true });
                }
                isConfigured = false;
                isSending = false;
                setTimeout(connectToWhatsApp, 3000);
            } else {
                console.log(color("[!] Connection lost. Reconnecting..."));
                setTimeout(connectToWhatsApp, 5000);
            }
        }
    });
}

const userKey = crypto.createHash("sha256").update(os.platform() + os.userInfo().username).digest("hex");
console.log(color(`Your Key: ${userKey}`, colors.brightGreen));
console.log(color("[!] Initializing..."));

connectToWhatsApp();

process.on('uncaughtException', (err) => {
    console.log(color(`[!] Uncaught Exception: ${err.message}`));
});
