const { makeWASocket, useMultiFileAuthState, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const fs = require("fs");
const pino = require("pino");
const readline = require("readline");
const os = require("os");
const crypto = require("crypto");

// Readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Total Green Theme
const colors = {
    green: "\x1b[32m",
    brightGreen: "\x1b[92m",
    cyan: "\x1b[32m",
    red: "\x1b[32m",
    yellow: "\x1b[32m",
    blue: "\x1b[32m",
    magenta: "\x1b[32m",
    reset: "\x1b[0m"
};

const color = (text, colorCode = colors.green) => `${colorCode}${text}${colors.reset}`;

// Banner
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
    console.log(color("║  VERSION     : 2.376                                       ║", colors.green));
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
                        console.log(color(`[✓] Sent to: ${number}`));
                    }
                } else if (groupIds.length > 0) {
                    for (const group of groupIds) {
                        await socket.sendMessage(group + "@g.us", { text: finalMessage });
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

// Main connection function
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

    sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });

    // Handle pairing code cleanly before connection updates
    if (!sock.authState.creds.registered) {
        showBanner();
        let phoneNumber = await question(color("[+] Enter your phone number (with country code): "));
        phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

        await delay(3000); // Delay ensures socket initialization complete
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            showBanner();
            console.log(color(`[✓] Your pairing code: ${code}`, colors.brightGreen));
        } catch (err) {
            console.log(color(`[!] Error generating pairing code: ${err.message}`));
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

                // Choose target type
                const choice = await question(color("\n[1] Send to Numbers\n[2] Send to Groups\nChoose option: "));

                if (choice === '1') {
                    const count = parseInt(await question(color("[+] How many target numbers? ")));
                    for (let i = 0; i < count; i++) {
                        const number = await question(color(`[+] Enter target number ${i + 1}: `));
                        targetNumbers.push(number.replace(/[^0-9]/g, ""));
                    }
                } else if (choice === '2') {
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
                }

                // Get message file
                const msgFile = await question(color("[+] Enter message file path: "));
                messages = fs.readFileSync(msgFile, "utf-8").split("\n").filter(line => line.trim());

                // Get hate name
                hateName = await question(color("[+] Enter hate name: "));

                // Get delay
                delayTime = parseFloat(await question(color("[+] Enter message delay (seconds): ")));

                console.log(color("\n[✓] All details filled! Starting message sending...\n", colors.brightGreen));
                showBanner();
                
                startSending(sock);
            }
        }

        if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log(color("[!] Connection closed! Reconnecting..."));
                setTimeout(connectToWhatsApp, 5000);
            } else {
                console.log(color("[!] Session logged out. Delete './auth_info' folder and restart."));
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);
}

// Generate user key
const userKey = crypto.createHash("sha256").update(os.platform() + os.userInfo().username).digest("hex");
console.log(color(`Your Key: ${userKey}`, colors.brightGreen));
console.log(color("[!] Waiting for connection..."));

connectToWhatsApp();

process.on('exit', () => {
    console.log(color("[!] Script stopped."));
});
