const axios = require("axios");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const ENCRYPTED_PREFIX = "e1.";

const BASE_URL = "https://sktorrent.eu";
const agentOptions = { keepAlive: true, maxSockets: 50 };

function getTime() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function logInfo(msg) { console.log(`[${getTime()}] ℹ️ INFO: ${msg}`); }
function logSuccess(msg) { console.log(`[${getTime()}] ✅ SUCCESS: ${msg}`); }
function logWarn(msg) { console.warn(`[${getTime()}] ⚠️ WARN: ${msg}`); }
function logError(msg, err = "") { console.error(`[${getTime()}] ❌ ERROR: ${msg}`, err ? err.message || err : ""); }
function logCache(msg) { console.log(`[${getTime()}] 📦 CACHE: ${msg}`); }
function logApi(msg) { console.log(`[${getTime()}] 🌐 API: ${msg}`); }

const cache = new Map();
const pendingCacheRequests = new Map();

async function withCache(key, ttlMs, fetcher) {
    const now = Date.now();
    const cached = cache.get(key);

    if (cached && cached.expiresAt > now) {
        logCache(`HIT: ${key}`);
        return cached.value;
    }

    if (cached) cache.delete(key);

    if (pendingCacheRequests.has(key)) {
        logCache(`WAIT: ${key}`);
        return pendingCacheRequests.get(key);
    }

    logCache(`MISS: ${key}`);

    const request = Promise.resolve()
        .then(fetcher)
        .then(value => {
            if (value !== null && value !== undefined) {
                cache.set(key, {
                    value,
                    expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0)
                });
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
        httpAgent: new http.Agent(agentOptions),
        httpsAgent: new https.Agent(agentOptions),
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

module.exports = {
    cache,
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
