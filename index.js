(async () => {
  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      delay,
      DisconnectReason,
      fetchLatestBaileysVersion
    } = await import("@whiskeysockets/baileys");
    const fs = await import("fs");
    const pino = (await import("pino")).default;
    const readline = await import("readline");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (text) => new Promise((resolve) => rl.question(text, resolve));

    const printBanner = () => {
      console.clear();
      console.log(`
\x1b[1;32m
 __    __ _           _                         
/ /\\ /\\ \\ |__   __ _| |_ ___  __ _ _ __  _ __  
\\ \\/  \\/ / '_ \\ / _\` | __/ __|/ _\` | '_ \\| '_ \\ 
 \\  /\\  /| | | | (_| | |\\__ \\ (_| | |_) | |_) |
  \\/  \\/ |_| |_|\\__,_|\\__|___/\\__,_| .__/| .__/ 
                                   |_|   |_|    
<<============================================================>>
[N+A] OWNER   : BHAT WASU
[A+N] GITHUB  : BHATWASUXWD
[N+A] TOOL    : AUTOMATIC WHATSAPP MESSAGE SENDER
<<============================================================>>\x1b[0m
`);
    };

    let targetNumbers = [];
    let groupUids = [];
    let messageList = null;
    let delaySeconds = null;
    let haterName = null;
    let currentMsgIndex = 0;

    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");
    const { version } = await fetchLatestBaileysVersion();

    async function sendMessageLoop(sock) {
      while (true) {
        for (let i = currentMsgIndex; i < messageList.length; i++) {
          try {
            const timeString = new Date().toLocaleTimeString();
            const fullMessage = haterName + " " + messageList[i];

            if (targetNumbers.length > 0) {
              for (const number of targetNumbers) {
                await sock.sendMessage(number + "@c.us", { text: fullMessage });
                console.log("\x1b[1;32mTARGET NUMBER => \x1b[0m" + number);
              }
            } else {
              for (const groupUid of groupUids) {
                await sock.sendMessage(groupUid + "@g.us", { text: fullMessage });
                console.log("\x1b[1;32mGROUP UID => \x1b[0m" + groupUid);
              }
            }

            console.log("\x1b[1;32m>>TIME => \x1b[0m" + timeString);
            console.log("\x1b[1;32mMESSAGE=> \x1b[0m" + fullMessage);
            console.log(" \x1b[1;32m[<<=========== BHAT WASU XWD ===========>>]\x1b[0m");
            await delay(delaySeconds * 1000);
          } catch (err) {
            console.log("\x1b[1;33mError sending message: " + err.message + ". Retrying...\x1b[0m");
            currentMsgIndex = i;
            await delay(5000);
          }
        }
        currentMsgIndex = 0;
      }
    }

    const connectToWhatsApp = async () => {
      const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false,
        // Custom browser tuple prevents WhatsApp from immediately blocking unknown device signatures
        browser: ["Ubuntu", "Chrome", "20.0.04"]
      });

      if (!sock.authState.creds.registered) {
        printBanner();
        let phoneNumber = await question("\x1b[1;32m[+] ENTER YOUR PHONE NUMBER (with country code, e.g. 919876543210) => \x1b[0m");
        phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

        if (!phoneNumber) {
          console.log("\x1b[1;31mInvalid phone number!\x1b[0m");
          process.exit(1);
        }

        await delay(2000);
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          printBanner();
          console.log("\x1b[1;32m[√] YOUR PAIRING CODE IS => \x1b[1;33m" + code + "\x1b[0m\n");
        } catch (err) {
          console.error("\x1b[1;31mFailed to request pairing code:\x1b[0m", err.message);
          process.exit(1);
        }
      }

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
          printBanner();
          console.log("\x1b[1;32m[Your WHATSAPP LOGIN ✓]\x1b[0m");

          const choice = await question("\x1b[1;32m[1] SEND TO TARGET NUMBER\n[2] SEND TO WHATSAPP GROUP\nCHOOSE OPTION => \x1b[0m");

          if (choice === "1") {
            const count = await question("\x1b[1;32m[+] HOW MANY TARGET NUMBERS? => \x1b[0m");
            for (let i = 0; i < parseInt(count); i++) {
              let num = await question("\x1b[1;32m[+] ENTER TARGET NUMBER " + (i + 1) + " => \x1b[0m");
              targetNumbers.push(num.replace(/[^0-9]/g, ""));
            }
          } else if (choice === "2") {
            const groups = await sock.groupFetchAllParticipating();
            const groupKeys = Object.keys(groups);
            console.log("\x1b[1;32m[√] WHATSAPP GROUPS =>\x1b[0m");
            groupKeys.forEach((gid, index) => {
              console.log("\x1b[1;32m[" + (index + 1) + "] GROUP NAME: \x1b[0m" + groups[gid].subject + " \x1b[1;32mUID: \x1b[0m" + gid);
            });
            const count = await question("\x1b[1;32m[+] HOW MANY GROUPS TO TARGET => \x1b[0m");
            for (let i = 0; i < parseInt(count); i++) {
              const gid = await question("\x1b[1;32m[+] ENTER GROUP UID " + (i + 1) + " => \x1b[0m");
              groupUids.push(gid.trim());
            }
          }

          const filePath = await question("\x1b[1;32m[+] ENTER MESSAGE FILE PATH => \x1b[0m");
          messageList = fs.readFileSync(filePath.trim(), "utf-8").split("\n").filter(Boolean);
          haterName = await question("\x1b[1;32m[+] ENTER HATER NAME => \x1b[0m");
          delaySeconds = parseInt(await question("\x1b[1;32m[+] ENTER MESSAGE DELAY (seconds) => \x1b[0m"));

          console.log("\x1b[1;32mAll Details Are Filled Correctly\x1b[0m");
          printBanner();
          console.log("\x1b[1;32mNOW START MESSAGE SENDING.......\x1b[0m");
          await sendMessageLoop(sock);
        }

        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          if (shouldReconnect) {
            console.log("NETWORK ISSUE, RETRYING IN 5 SECONDS...");
            setTimeout(connectToWhatsApp, 5000);
          } else {
            console.log("Session logged out. Delete the ./auth_info folder and run the script again.");
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);
    };

    // Direct initialization - Approval system removed
    connectToWhatsApp();

    process.on("uncaughtException", function (err) {
      let strErr = String(err);
      if (strErr.includes("Socket connection timeout") || strErr.includes("rate-overlimit")) {
        return;
      }
      console.log("Caught exception: ", err);
    });
  } catch (err) {
    console.error("Error starting application:", err);
  }
})();
