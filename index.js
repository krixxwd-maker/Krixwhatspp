import { makeWASocket, useMultiFileAuthState, delay, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import fs from 'fs';
import pino from 'pino';
import readline from 'readline';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

function banner() {
    console.clear();
    console.log("\x1b[32m============================================================\x1b[0m");
    console.log("\x1b[32m[N+A] TOOL : FAST WHATSAPP MESSAGE SENDER (UPDATED)\x1b[0m");
    console.log("\x1b[32m============================================================\x1b[0m");
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        browser: Browsers.macOS("Chrome"),
        printQRInTerminal: false
    });

    if (!sock.authState.creds.registered) {
        banner();
        let phoneNumber = await question("\x1b[32m[+] ENTER YOUR PHONE NUMBER (e.g., 91xxxxxxxxxx) => \x1b[0m");
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        await delay(3000); 
        const code = await sock.requestPairingCode(phoneNumber);
        banner();
        console.log(`\x1b[32m[✓] YOUR PAIRING CODE IS => \x1b[33m${code?.match(/.{1,4}/g)?.join("-") || code}\x1b[0m`);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            banner();
            console.log("\x1b[32m[✓] WHATSAPP LOGIN SUCCESSFUL!\x1b[0m");

            let targetType = await question("\x1b[32m[1] SEND TO TARGET NUMBER\n[2] SEND TO WHATSAPP GROUP\nCHOOSE OPTION => \x1b[0m");
            
            let targets = [];
            if (targetType === '1') {
                let count = await question("\x1b[32m[+] HOW MANY TARGET NUMBERS? => \x1b[0m");
                for (let i = 0; i < parseInt(count); i++) {
                    let num = await question(`\x1b[32m[+] ENTER TARGET NUMBER ${i + 1} => \x1b[0m`);
                    targets.push(num.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
                }
            } else if (targetType === '2') {
                const groups = await sock.groupFetchAllParticipating();
                const groupIds = Object.keys(groups);
                console.log("\x1b[32m[✓] AVAILABLE WHATSAPP GROUPS:\x1b[0m");
                groupIds.forEach((id, index) => {
                    console.log(`\x1b[32m[${index + 1}] GROUP: ${groups[id].subject} | UID: ${id}\x1b[0m`);
                });
                let count = await question("\x1b[32m[+] HOW MANY GROUPS TO TARGET => \x1b[0m");
                for (let i = 0; i < parseInt(count); i++) {
                    let uid = await question(`\x1b[32m[+] ENTER GROUP UID ${i + 1} => \x1b[0m`);
                targets.push(uid.includes('@g.us') ? uid : uid + '@g.us');
                }
            }

            let filePath = await question("\x1b[32m[+] ENTER MESSAGE FILE PATH => \x1b[0m");
            let messages = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
            let haterName = await question("\x1b[32m[+] ENTER HATER/PREFIX NAME => \x1b[0m");
            let msgDelay = parseInt(await question("\x1b[32m[+] ENTER MESSAGE DELAY (in seconds) => \x1b[0m")) || 5;

            console.log("\x1b[32m[✓] ALL DETAILS LOADED. STARTING MESSAGE SENDER...\x1b[0m");

            let msgIndex = 0;
            while (true) {
                for (let target of targets) {
                    try {
                        let text = `${haterName} ${messages[msgIndex]}`;
                        await sock.sendMessage(target, { text: text });
                        console.log(`\x1b[32m[SENT] TO ${target} => ${text}\x1b[0m`);
                        await delay(msgDelay * 1000);
                    } catch (err) {
                        console.log(`\x1b[33mError: ${err.message}. Retrying...\x1b[0m`);
                        await delay(5000);
                    }
                }
                msgIndex = (msgIndex + 1) % messages.length;
            }
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(startBot, 5000);
            } else {
                console.log("Connection closed. Logged out.");
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startBot();
