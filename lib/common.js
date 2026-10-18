const axios = require("axios");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const ENCRYPTED_PREFIX = "e1.";

const BASE_URL = "https://sktorrent.eu";
const agentOptions = { keepAlive: true, maxSockets: 50 };
// Zdieľané keepAlive agenty (nový agent per request by leakoval sockety)
const sharedHttpAgent = new http.Agent(agentOptions);
const sharedHttpsAgent = new https.Agent(agentOptions);

function getTime() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

// QUIET_LOGS=1 vypne všetky logy okrem chýb (súkromie používateľov na verejnej inštancii)
const QUIET = ["1", "true", "yes"].includes(String(process.env.QUIET_LOGS || "").toLowerCase());
function logInfo(msg) { if (!QUIET) console.log(`[${getTime()}] ℹ️ INFO: ${msg}`); }
function logSuccess(msg) { if (!QUIET) console.log(`[${getTime()}] ✅ SUCCESS: ${msg}`); }
function logWarn(msg) { if (!QUIET) console.warn(`[${getTime()}] ⚠️ WARN: ${msg}`); }
function logError(msg, err = "") { console.error(`[${getTime()}] ❌ ERROR: ${msg}`, err ? err.message || err : ""); }
function logCache(msg) { if (!QUIET) console.log(`[${getTime()}] 📦 CACHE: ${msg}`); }
function logApi(msg) { if (!QUIET) console.log(`[${getTime()}] 🌐 API: ${msg}`); }

const cache = new Map();
const pendingCacheRequests = new Map();

// Prázdne výsledky (výpadok ČSFD/TMDB, prázdny search) sa cachujú len 60 s, aby krátky výpadok nezamrzol addon na hodiny.
const PRAZDNY_TTL_MS = 60 * 1000;

function jePrazdnyVysledok(data) {
    if (data === null || data === undefined) return true;
    if (Array.isArray(data)) return data.length === 0;
    if (typeof data === "object") {
        if (Array.isArray(data.nazvy)) return data.nazvy.length === 0;
        return Object.keys(data).length === 0;
    }
    return false;
}

async function withCache(key, ttlMs, fetcher) {
    const now = Date.now();
    const cached = cache.get(key);

    if (cached && cached.expiresAt > now) {
        logCache(`HIT: ${key}`);
        return cached.value;
    }

    if (cached) cache.delete(key);

    // single-flight: rovnaký key sa nefetchuje paralelne (Stremio retry)
    if (pendingCacheRequests.has(key)) {
        logCache(`WAIT: ${key}`);
        return pendingCacheRequests.get(key);
    }

    logCache(`MISS: ${key}`);

    const request = Promise.resolve()
        .then(fetcher)
        .then(value => {
            if (value !== null && value !== undefined) {
                const ttl = Math.max(0, Number(ttlMs) || 0);
                cache.set(key, { value, expiresAt: Date.now() + (jePrazdnyVysledok(value) ? Math.min(ttl, PRAZDNY_TTL_MS) : ttl) });
            }
            return value;
        })
        .catch(error => {
            logError(`Failed to fetch cache key: ${key}`, error);
            return null;
        })
        .finally(() => pendingCacheRequests.delete(key));

    pendingCacheRequests.set(key, request);
    return request;
}

// Pravidelné čistenie expirovaných záznamov (cache inak rastie donekonečna)
setInterval(() => {
    const teraz = Date.now();
    for (const [k, v] of cache) {
        if (teraz >= v.expiresAt) cache.delete(k);
    }
}, 600000).unref();

function pLimit(limit) {
    let active = 0; const q = [];
    const next = () => {
        if (active >= limit || q.length === 0) return;
        active++;
        const { fn, resolve, reject } = q.shift();
        fn().then(resolve, reject).finally(() => { active--; next(); });
    };
    return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
}

function getEncryptionKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret) return null;
    return crypto.createHash("sha256").update(secret).digest();
}

function encodeConfig(config) {
    const key = getEncryptionKey();
    if (!key) {
        throw new Error("ENCRYPTION_KEY is not set");
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
    return ENCRYPTED_PREFIX + payload;
}

function decryptConfig(payload) {
    const key = getEncryptionKey();
    if (!key) {
        logWarn("Encrypted config received but ENCRYPTION_KEY is not set");
        return null;
    }
    const buf = Buffer.from(payload, "base64url");
    if (buf.length < 29) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const encrypted = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(json);
}

function decodeLegacyConfig(configString) {
    let base64 = configString.replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) { base64 += "="; }
    return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

function decodeConfig(configString) {
    try {
        if (!configString || configString.includes(".json")) return null;
        if (configString.startsWith(ENCRYPTED_PREFIX)) {
            return decryptConfig(configString.slice(ENCRYPTED_PREFIX.length));
        }
        return decodeLegacyConfig(configString);
    } catch (e) {
        logWarn("Failed to decode config");
        return null;
    }
}

function getFastAxios(userConfig) {
    const { uid, pass } = userConfig;
    return axios.create({
        timeout: 5000,
        httpAgent: sharedHttpAgent,
        httpsAgent: sharedHttpsAgent,
        headers: {
            "User-Agent": "Mozilla/5.0",
            "Cookie": `uid=${uid}; pass=${pass}`,
            "Referer": BASE_URL,
            "Connection": "keep-alive"
        }
    });
}

const langToFlag = { CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸", DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸", RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵" };

function odstranDiakritiku(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function skratNazov(title, pocetSlov = 3) { return title.split(/\s+/).slice(0, pocetSlov).join(" "); }

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "?";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0; let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i >= 2 ? 2 : 0)} ${u[i]}`;
}

function normalizeTorrentName(str) {
    return odstranDiakritiku(String(str || ''))
        .toLowerCase()
        .replace(/stiahni si/gi, ' ')
        .replace(/[._\-()[\]{}:]+/g, ' ')
        .replace(/\b(1080p|720p|2160p|4k|hdr|web-?dl|webrip|brrip|bluray|dvdrip|tvrip|uhd|fhd|hevc|x265|x264|h264|h265|cam|cz|sk|en)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getQualityRank(text = "") {
    const t = text.toLowerCase();
    if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) return 4;
    if (t.includes("1080p") || t.includes("fhd")) return 3;
    if (t.includes("720p") || /\bhd\b/.test(t)) return 2;
    if (t.includes("480p")) return 1;
    return 0;
}

function getSizeBytes(text = "") {
    const m = text.match(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/i);
    if (!m) return 0;
    const value = parseFloat(m[1].replace(",", "."));
    const mult = { tb: 1024 ** 4, gb: 1024 ** 3, mb: 1024 ** 2, kb: 1024 }[m[2].toLowerCase()];
    return value * mult;
}

module.exports = {
    cache,
    getQualityRank,
    getSizeBytes,
    decodeConfig,
    encodeConfig,
    escapeRegExp,
    formatBytes,
    getFastAxios,
    getTime,
    logApi,
    logCache,
    logError,
    logInfo,
    logSuccess,
    logWarn,
    langToFlag,
    normalizeTorrentName,
    odstranDiakritiku,
    pLimit,
    skratNazov,
    withCache
};
