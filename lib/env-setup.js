// Lokálne spustenie: ak chýba ENCRYPTION_KEY, vytvorí (alebo doplní) súbor .env s náhodným kľúčom.
// Spúšťa sa hneď po dotenv.config(). Na hostingu (Koyeb, Vercel, produkcia) sa nič negeneruje -
// tam nastav ENCRYPTION_KEY v premenných prostredia, inak by sa kľúč po každom redeployi zmenil.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function jeHosting() {
    return process.env.NODE_ENV === "production" || !!process.env.VERCEL || !!process.env.KOYEB_APP_NAME ||
        !!process.env.DISABLE_ENV_AUTOGEN;
}

function zabezpecEnv() {
    if (process.env.ENCRYPTION_KEY) return false;
    if (jeHosting()) return false;
    if (!process.stdout.isTTY && process.env.ENV_AUTOGEN !== "1") return false;

    const envPath = path.join(__dirname, "..", ".env");
    const kluc = crypto.randomBytes(32).toString("hex");
    try {
        let obsah = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
        if (/^ENCRYPTION_KEY=\s*$/m.test(obsah)) {
            obsah = obsah.replace(/^ENCRYPTION_KEY=\s*$/m, `ENCRYPTION_KEY=${kluc}`);
        } else {
            if (obsah && !obsah.endsWith("\n")) obsah += "\n";
            if (!obsah) {
                obsah += "# Vygenerované automaticky. NEZDIEĽAJ a NECOMMITUJ (súbor .env patrí do .gitignore).\n";
                obsah += "# Zmena kľúča zneplatní všetky doteraz vygenerované inštalačné odkazy.\n";
            }
            obsah += `ENCRYPTION_KEY=${kluc}\n`;
        }
        fs.writeFileSync(envPath, obsah, { encoding: "utf8", mode: 0o600 });
        process.env.ENCRYPTION_KEY = kluc;
        console.log(`🔐 ENCRYPTION_KEY bol vygenerovaný a uložený do ${envPath}`);
        return true;
    } catch (e) {
        // Súborový systém je len na čítanie - kľúč platí len do ukončenia procesu
        process.env.ENCRYPTION_KEY = kluc;
        console.warn(`⚠️  .env sa nepodarilo zapísať (${e.message}). Kľúč platí len pre tento beh, nastav ENCRYPTION_KEY natrvalo.`);
        return false;
    }
}

zabezpecEnv();

module.exports = { zabezpecEnv };
