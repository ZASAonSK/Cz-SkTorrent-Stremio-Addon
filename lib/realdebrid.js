// Pôvodne: Judzim/Cz-SkTorrent-Stremio-Addon (AGPL-3.0), upravené pre zlúčený projekt
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { logApi, logCache, logError, logInfo, logSuccess, logWarn } = require("./common");
const { overitTorboxCache } = require("./torbox");

// ===================================================================
// REAL-DEBRID FUNKCIE (priame RD API + lokálna cache)
// ===================================================================
const RD_API_BASE = "https://api.real-debrid.com/rest/1.0";
const RD_CACHE_FILE = path.join(__dirname, "..", "rd_cache.json");
const RD_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 dni
const RD_CACHE_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minut medzi pagináciami

// Zoznam patternov, ktore Real-Debrid blokuje (451 infringing_file)
const RD_BLOCKED_PATTERNS = [
    'bdrip', 'bd-rip', 'bd remux',
    'web-dl', 'webdl', 'web.dl',
    'webrip', 'web-rip', 'web.rip',
    'hdrip', 'hd-rip', 'hd.rip',
    'dvdrip', 'dvd-rip', 'dvd.rip',
    'rarbg', 'yts', 'eztv', 'tgx', 'amzn'
];

function jeRDNazovBlokovany(nazov) {
    if (!nazov) return false;
    const lower = nazov.toLowerCase();
    return RD_BLOCKED_PATTERNS.some(p => lower.includes(p));
}

// ===================================================================
// RD JSON CACHE (distribuovaná medzi userov)
// ===================================================================
let rdCache = {};
let rdCacheLoaded = false;
let rdLastRefresh = 0;
let rdRefreshPromise = null;

function nacitatRdCache() {
    try {
        if (fs.existsSync(RD_CACHE_FILE)) {
            const raw = fs.readFileSync(RD_CACHE_FILE, 'utf-8');
            rdCache = JSON.parse(raw);
            const now = Date.now();
            for (const hash in rdCache) {
                if (now - rdCache[hash].cached_at > RD_CACHE_MAX_AGE) {
                    delete rdCache[hash];
                }
            }
        }
    } catch (e) {
        logWarn(`RD cache load failed: ${e.message}`);
        rdCache = {};
    }
    rdCacheLoaded = true;
    logInfo(`RD cache loaded: ${Object.keys(rdCache).length} hashes`);
}

function ulozitRdCache() {
    try {
        const dir = path.dirname(RD_CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(RD_CACHE_FILE, JSON.stringify(rdCache, null, 0), 'utf-8');
    } catch (e) {
        logWarn(`RD cache save failed: ${e.message}`);
    }
}

// ===================================================================
// RD API HELPERY (priame volania)
// ===================================================================
const RD_AXIOS_TIMEOUT = 20000;

function rdHeaders(apiKey) {
    return { "Authorization": `Bearer ${apiKey}`, "User-Agent": "TorrentSK/1.0" };
}

async function rdAddMagnet(apiKey, hash) {
    const magnet = `magnet:?xt=urn:btih:${hash}`;
    const res = await axios.post(`${RD_API_BASE}/torrents/addMagnet`,
        `magnet=${encodeURIComponent(magnet)}`,
        { headers: { ...rdHeaders(apiKey), "Content-Type": "application/x-www-form-urlencoded" }, timeout: RD_AXIOS_TIMEOUT }
    );
    return res.data;
}

async function rdSelectFiles(apiKey, torrentId, fileIds) {
    const res = await axios.post(`${RD_API_BASE}/torrents/selectFiles/${torrentId}`,
        `files=${fileIds}`,
        { headers: { ...rdHeaders(apiKey), "Content-Type": "application/x-www-form-urlencoded" }, timeout: RD_AXIOS_TIMEOUT }
    );
    return res.status === 204;
}

async function rdTorrentInfo(apiKey, torrentId) {
    const res = await axios.get(`${RD_API_BASE}/torrents/info/${torrentId}`,
        { headers: rdHeaders(apiKey), timeout: RD_AXIOS_TIMEOUT }
    );
    return res.data;
}

async function rdUnrestrictLink(apiKey, link) {
    const res = await axios.post(`${RD_API_BASE}/unrestrict/link`,
        `link=${encodeURIComponent(link)}`,
        { headers: { ...rdHeaders(apiKey), "Content-Type": "application/x-www-form-urlencoded" }, timeout: RD_AXIOS_TIMEOUT }
    );
    return res.data;
}

async function rdDeleteTorrent(apiKey, torrentId) {
    await axios.delete(`${RD_API_BASE}/torrents/delete/${torrentId}`,
        { headers: rdHeaders(apiKey), timeout: 10000 }
    );
}

async function rdListTorrents(apiKey, page = 1, limit = 100) {
    const res = await axios.get(`${RD_API_BASE}/torrents?page=${page}&limit=${limit}`,
        { headers: rdHeaders(apiKey), timeout: 15000 }
    );
    return Array.isArray(res.data) ? res.data : [];
}

// ===================================================================
// PAGINÁCIA /torrents DO CACHE
// ===================================================================
async function rdPaginateTorrents(apiKey) {
    logApi(`RD paginácia /torrents na refresh cache...`);
    let page = 1;
    const limit = 100;
    let total = 0;

    while (page <= 50) {
        const items = await rdListTorrents(apiKey, page, limit);
        if (!items.length) break;

        for (const t of items) {
            if (t.status === 'downloaded' && t.hash) {
                const h = t.hash.toLowerCase();
                if (!rdCache[h]) {
                    rdCache[h] = { cached_at: Date.now() };
                    total++;
                }
            }
        }

        if (items.length < limit) break;
        page++;
    }

    rdLastRefresh = Date.now();
    ulozitRdCache();
    logSuccess(`RD cache refresh: pridaných ${total} nových hashov (spolu ${Object.keys(rdCache).length})`);
}

// ===================================================================
// NOVÝ RD CACHE CHECK (lokálna cache + fallback /torrents)
// ===================================================================
async function overitRealDebridCache(infoHashes, rdKey) {
    if (!rdKey || !infoHashes || infoHashes.length === 0) return {};

    if (!rdCacheLoaded) nacitatRdCache();

    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const cacheMap = {};

    // 1. Lokálna cache — instant (zdieľaná databáza: hashe nahrané všetkými
    //    userami addonu pri úspešnom prehratí/stiahnutí cez RD + refresh)
    for (const hash of unikatneHashe) {
        if (rdCache[hash]) {
            cacheMap[hash] = true;
        }
    }
    logCache(`RD cache: ${Object.keys(cacheMap).length}/${unikatneHashe.length} z lokálnej cache`);

    // 2. Ak nejaké chýbajú, skúsime refresh /torrents (max 1x za 5 min)
    //    — pridá hashe so statusom 'downloaded' z účtu aktívneho usera
    const chybajuceHashe = unikatneHashe.filter(h => !cacheMap[h]);
    const now = Date.now();

    if (chybajuceHashe.length > 0 && (now - rdLastRefresh > RD_CACHE_REFRESH_INTERVAL)) {
        if (!rdRefreshPromise) {
            rdRefreshPromise = rdPaginateTorrents(rdKey).finally(() => {
                rdRefreshPromise = null;
            });
        }

        try {
            await Promise.race([
                rdRefreshPromise,
                new Promise(r => setTimeout(r, 30000))
            ]);
        } catch (e) {
            logWarn(`RD cache refresh zlyhal: ${e.message}`);
        }

        for (const hash of chybajuceHashe) {
            if (rdCache[hash]) {
                cacheMap[hash] = true;
                logCache(`RD cached po refreshi: ${hash.substring(0,12)}...`);
            }
        }
    }

    return cacheMap;
}

async function overitDebridCache(infoHashes, apiKey, provider) {
    if (provider === 'torbox') {
        return overitTorboxCache(infoHashes, apiKey);
    } else if (provider === 'realdebrid') {
        return overitRealDebridCache(infoHashes, apiKey);
    }
    return {};
}


// Zápis hashu do zdieľanej RD cache (volá sa po úspešnom prehratí/stiahnutí)
function zapisatDoRdCache(hash) {
    if (!hash) return;
    if (!rdCacheLoaded) nacitatRdCache();
    rdCache[String(hash).toLowerCase()] = { cached_at: Date.now() };
    ulozitRdCache();
}

module.exports = {
    RD_API_BASE, RD_BLOCKED_PATTERNS, jeRDNazovBlokovany, nacitatRdCache, ulozitRdCache, zapisatDoRdCache,
    rdHeaders, rdAddMagnet, rdSelectFiles, rdTorrentInfo, rdUnrestrictLink, rdDeleteTorrent, rdListTorrents,
    rdPaginateTorrents, overitRealDebridCache, overitDebridCache
};
