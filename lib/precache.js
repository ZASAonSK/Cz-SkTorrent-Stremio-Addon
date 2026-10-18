// Pôvodne: Judzim/Cz-SkTorrent-Stremio-Addon (AGPL-3.0), upravené pre zlúčený projekt
const axios = require("axios");
const crypto = require("crypto");
const { logInfo, logSuccess, logWarn } = require("./common");

const PORT = process.env.PORT || 7000;
const precacheCasovac = new Map();
const PRECACHE_MIN_INTERVAL_MS = 30 * 60 * 1000;
// hash torrentu -> pôvodné stream ID (trigger z /play pozná len hash + S:E)
const precacheIdMap = new Map();

function spustitPrecacheDalsejEpizody(userConfig, debridProvider, debridApiKey, hash, seria, epizoda, configSegment) {
    try {
        if (!userConfig || userConfig.precacheNextEpisode !== true || !debridProvider || !debridApiKey) return;
        const s = parseInt(seria, 10);
        const e = parseInt(epizoda, 10);
        if (!(s > 0) || !(e > 0)) return; // filmy (0:0) a specialy (S0) preskakujeme
        const povodneId = precacheIdMap.get(String(hash || '').toLowerCase());
        if (!povodneId || !/:\d+:\d+$/.test(povodneId)) {
            logInfo(`[PRECACHE] S${s}E${e}: preskočené (hash ${String(hash).slice(0, 12)}... nemáme ID, streamy sa možno hľadali pred reštartom)`);
            return;
        }
        const dalsiaEpizoda = e + 1;
        const showCast = povodneId.replace(/:\d+:\d+$/, '');
        const nextId = `${showCast}:${s}:${dalsiaEpizoda}`;
        const userKey = crypto.createHash('sha1').update(String(userConfig.user_id || userConfig.uid || '')).digest('hex').slice(0, 8);
        const precacheKluč = `${userKey}|${showCast}|${s}|${dalsiaEpizoda}`;
        const naposledy = precacheCasovac.get(precacheKluč) || 0;
        if (Date.now() - naposledy > PRECACHE_MIN_INTERVAL_MS) {
            precacheCasovac.set(precacheKluč, Date.now());
            // Občasné upratovanie mapy, nech nerastie donekonečna
            if (precacheCasovac.size > 200) {
                for (const [k, v] of precacheCasovac) {
                    if (Date.now() - v > PRECACHE_MIN_INTERVAL_MS * 2) precacheCasovac.delete(k);
                }
            }
            logInfo(`[PRECACHE] S${s}E${e} sa začína prehrávať → S${s}E${dalsiaEpizoda} (${nextId}): spúšťam na pozadí`);
            setImmediate(() => {
                axios.get(`http://127.0.0.1:${PORT}/${configSegment}/stream/series/${nextId}.json?precache=1`, {
                    timeout: 90000,
                    validateStatus: () => true
                }).then(r => {
                    const pocet = (r.data && Array.isArray(r.data.streams)) ? r.data.streams.length : '?';
                    logSuccess(`[PRECACHE] S${s}E${dalsiaEpizoda}: interný request hotový (HTTP ${r.status}, ${pocet} streamov)`);
                }).catch(e => {
                    logWarn(`[PRECACHE] S${s}E${dalsiaEpizoda}: interný request zlyhal: ${e.message}`);
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
