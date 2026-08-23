const { makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const fs = require("fs");
const pino = require("pino");
const readline = require("readline");
const axios = require("axios");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");

// Readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Colors for console
const colors = {
    green: "\x1b[32m",
    cyan: "\x1b[36m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    reset: "\x1b[0m"
};

const color = (text, colorCode) => `${colorCode}${text}${colors.reset}`;

// Banner
const showBanner = () => {
    console.clear();
    console.log(color("██╗    ██╗██╗  ██╗ █████╗ ████████╗███████╗ █████╗ ██████╗", colors.green));
    console.log(color("██║    ██║██║  ██║██╔══██╗╚══██╔══╝██╔════╝██╔══██╗██╔══██╗", colors.magenta));
    console.log(color("██║ █╗ ██║███████║███████║   ██║   ███████╗███████║██████╔╝", colors.blue));
    console.log(color("██║███╗██║██╔══██║██╔══██║   ██║   ╚════██║██╔══██║██╔═══╝", colors.yellow));
    console.log(color("╚███╔███╔╝██║  ██║██║  ██║   ██║   ███████║██║  ██║██║     ", colors.cyan));
    console.log(color(" ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ", colors.red));
    console.log(color("╔═════════════════════════════════════════════════════════════╗", colors.green));
    console.log(color("║  TOOLS       : WHATSAPP MESSENGER                           ║", colors.yellow));
    console.log(color("║  VERSION     : 2.376                                       ║", colors.blue));
    console.log(color("║  OWNER       : ERIIC BRAND                                 ║", colors.magenta));
    console.log(color("╚═════════════════════════════════════════════════════════════╝", colors.cyan));
};

let targetNumbers = [];
let groupIds = [];
let messages = [];
let hateName = "";
let delayTime = 0;
let currentIndex = 0;
let sock = null;

// Auto seen status
const autoSeeStatuses = async (socket) => {
    socket.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (msg.message?.protocolMessage) continue;
            await socket.readMessages([msg.key]);
        }
    });
};

// Main sending function
async function startSending(socket) {
    while (true) {
        for (let i = currentIndex; i < messages.length; i++) {
            try {
                const time = new Date().toLocaleTimeString();
                const finalMessage = hateName + " " + messages[i];

                if (targetNumbers.length > 0) {
                    for (const number of targetNumbers) {
                        await socket.sendMessage(number + "@s.whatsapp.net", { text: finalMessage });
                        console.log(color(`[✓] Sent to: ${number}`, colors.green));
                    }
                } else if (groupIds.length > 0) {
                    for (const group of groupIds) {
                        await socket.sendMessage(group + "@g.us", { text: finalMessage });
                        console.log(color(`[✓] Sent to group: ${group}`, colors.cyan));
                    }
                }

                console.log(color(`[TIME] ${time}`, colors.blue));
                console.log(color(`[MESSAGE] ${finalMessage}`, colors.magenta));
                console.log(color(`[DELAY] ${delayTime} seconds`, colors.yellow));
                
                await delay(delayTime * 1000);
            } catch (err) {
                console.log(color(`[ERROR] ${err.message}`, colors.red));
                currentIndex = i;
                await delay(5000);
            }
        }
        currentIndex = 0;
    }
}

// Main connection function
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: true
    });

    // Handle pairing code
    if (!sock.authState.creds.registered) {
        showBanner();
        const phoneNumber = await question(color("[+] Enter your phone number (with country code): ", colors.cyan));
        const code = await sock.requestPairingCode(phoneNumber);
        showBanner();
        console.log(color(`[✓] Your pairing code: ${code}`, colors.green));
    }

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            showBanner();
            console.log(color("[✓] WhatsApp Connected Successfully!", colors.green));

            // Choose target type
            const choice = await question(color("\n[1] Send to Numbers\n[2] Send to Groups\nChoose option: ", colors.yellow));

            if (choice === '1') {
                const count = parseInt(await question(color("[+] How many target numbers? ", colors.cyan)));
                for (let i = 0; i < count; i++) {
                    const number = await question(color(`[+] Enter target number ${i + 1}: `, colors.blue));
                    targetNumbers.push(number);
                }
            } else if (choice === '2') {
                const groups = await sock.groupFetchAllParticipating();
                const groupList = Object.keys(groups);
                console.log(color("\n[✓] Your WhatsApp Groups:", colors.green));
                groupList.forEach((id, idx) => {
                    console.log(color(`[${idx + 1}] ${groups[id].subject} - ${id}`, colors.cyan));
                });
                const groupCount = parseInt(await question(color("\n[+] How many groups to target? ", colors.yellow)));
                for (let i = 0; i < groupCount; i++) {
                    const groupId = await question(color(`[+] Enter group UID ${i + 1}: `, colors.blue));
                    groupIds.push(groupId);
                }
            }

            // Get message file
            const msgFile = await question(color("[+] Enter message file path: ", colors.magenta));
            messages = fs.readFileSync(msgFile, "utf-8").split("\n").filter(line => line.trim());

            // Get hate name
            hateName = await question(color("[+] Enter hate name: ", colors.red));

            // Get delay
            delayTime = parseFloat(await question(color("[+] Enter message delay (seconds): ", colors.yellow)));

            console.log(color("\n[✓] All details filled! Starting message sending...\n", colors.green));
            showBanner();
            
            await startSending(sock);
            autoSeeStatuses(sock);
        }

        if (connection === "close" && lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            console.log(color("[!] Connection closed! Reconnecting...", colors.yellow));
            setTimeout(connectToWhatsApp, 5000);
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

// Generate user key
const userKey = crypto.createHash("sha256").update(os.platform() + os.userInfo().username).digest("hex");
console.log(color(`Your Key: ${userKey}`, colors.cyan));
console.log(color("[!] Waiting for connection...", colors.yellow));

connectToWhatsApp();

process.on('exit', () => {
    console.log(color("[!] Script stopped.", colors.red));
});
