// Pôvodne: Judzim/Cz-SkTorrent-Stremio-Addon (AGPL-3.0), upravené pre zlúčený projekt
const axios = require("axios");
const crypto = require("crypto");
const { logInfo, logSuccess, logWarn } = require("./common");

const precacheCasovac = new Map();
const PRECACHE_MIN_INTERVAL_MS = 30 * 60 * 1000;
// hash torrentu -> pôvodné stream ID (trigger z /play pozná len hash + S:E)
const precacheIdMap = new Map();

function ziskatAddonBaseUrl(req) {
    if (process.env.PUBLIC_URL && process.env.PUBLIC_URL.trim()) {
        return process.env.PUBLIC_URL.trim().replace(/\/$/, "");
    }
    if (req) {
        const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
        const host = req.get("host");
        if (host) return `${proto}://${host}`.replace(/\/$/, "");
    }
    const port = process.env.PORT || 7000;
    return `http://127.0.0.1:${port}`;
}

function spustitPrecacheDalsejEpizody(userConfig, debridProvider, debridApiKey, hash, seria, epizoda, configSegment, req) {
    try {
        if (!userConfig || userConfig.precacheNextEpisode !== true || !debridProvider || !debridApiKey) return;
        const s = parseInt(seria, 10);
        const e = parseInt(epizoda, 10);
        if (!(s > 0) || !(e > 0)) return; // filmy (0:0) a špeciály (S0) preskakujeme

        const povodneId = precacheIdMap.get(String(hash || '').toLowerCase());
        if (!povodneId || !/:\d+:\d+$/.test(povodneId)) {
            logInfo(`[PRECACHE] S${s}E${e}: preskočené (hash ${String(hash).slice(0, 12)}... nemáme ID, streamy sa možno hľadali pred reštartom)`);
            return;
        }

        const dalsiaEpizoda = e + 1;
        const showCast = povodneId.replace(/:\d+:\d+$/, '');
        const nextId = `${showCast}:${s}:${dalsiaEpizoda}`;
        const userKey = crypto.createHash('sha1').update(String(userConfig.user_id || userConfig.uid || '')).digest('hex').slice(0, 8);
        const precacheKluc = `${userKey}|${showCast}|${s}|${dalsiaEpizoda}`;
        const naposledy = precacheCasovac.get(precacheKluc) || 0;

        if (Date.now() - naposledy > PRECACHE_MIN_INTERVAL_MS) {
            precacheCasovac.set(precacheKluc, Date.now());

            // Občasné upratovanie mapy, nech nerastie donekonečna
            if (precacheCasovac.size > 200) {
                for (const [k, v] of precacheCasovac) {
                    if (Date.now() - v > PRECACHE_MIN_INTERVAL_MS * 2) precacheCasovac.delete(k);
                }
            }

            const baseUrl = ziskatAddonBaseUrl(req);
            const targetUrl = `${baseUrl}/${configSegment}/stream/series/${nextId}.json?precache=1`;

            logInfo(`[PRECACHE] S${s}E${e} sa začína prehrávať → S${s}E${dalsiaEpizoda} (${nextId}): spúšťam na pozadí cez ${baseUrl}`);

            setImmediate(() => {
                axios.get(targetUrl, {
                    timeout: 90000,
                    validateStatus: () => true
                }).then(r => {
                    const pocet = (r.data && Array.isArray(r.data.streams)) ? r.data.streams.length : '?';
                    logSuccess(`[PRECACHE] S${s}E${dalsiaEpizoda}: interný request hotový (HTTP ${r.status}, ${pocet} streamov)`);
                }).catch(err => {
                    logWarn(`[PRECACHE] S${s}E${dalsiaEpizoda}: interný request zlyhal: ${err.message}`);
                });
            });
        } else {
            logInfo(`[PRECACHE] S${s}E${dalsiaEpizoda}: preskočené (pre-cache bežal pred menej ako 30 min)`);
        }
    } catch (chyba) {
        logWarn(`[PRECACHE] trigger zlyhal: ${chyba.message}`);
    }
}

module.exports = { spustitPrecacheDalsejEpizody, precacheIdMap };