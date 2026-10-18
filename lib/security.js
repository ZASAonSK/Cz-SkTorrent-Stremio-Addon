// Pôvodne: Judzim/Cz-SkTorrent-Stremio-Addon (AGPL-3.0), upravené pre zlúčený projekt
const crypto = require("crypto");

// Config segment v URL obsahuje uid/pass/API kľúče - do logov ho dávame len ako hash (podporuje aj šifrovaný formát e1.xxx).
function maskConfigVUrl(url) {
    const match = String(url).match(/^\/([A-Za-z0-9_.-]{20,})(?=\/)/);
    if (!match) return url;
    const hash = crypto.createHash("sha1").update(match[1]).digest("hex").slice(0, 8);
    return url.replace(match[1], `cfg:${hash}`);
}

// Express 4 nechytá rejected promises v async handleroch.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Rate limit pre login proxy: 20 pokusov / 10 min / IP.
const loginPokusy = new Map();
function skontrolujLoginRateLimit(ip) {
    const teraz = Date.now();
    const okno = 10 * 60 * 1000; // 10 min
    const zoznam = (loginPokusy.get(ip) || []).filter(t => teraz - t < okno);
    if (zoznam.length >= 20) {
        loginPokusy.set(ip, zoznam);
        return true; // limit dosiahnutý
    }
    zoznam.push(teraz);
    loginPokusy.set(ip, zoznam);
    // občasné upratovanie, nech mapa nerastie donekonečna
    if (loginPokusy.size > 1000) {
        for (const [k, v] of loginPokusy) {
            if (v.every(t => teraz - t >= okno)) loginPokusy.delete(k);
        }
    }
    return false;
}

function hashUser(uid) {
    return crypto.createHash("sha1").update(String(uid || "")).digest("hex").slice(0, 8);
}

module.exports = { maskConfigVUrl, asyncRoute, skontrolujLoginRateLimit, hashUser };
