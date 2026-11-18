const axios = require("axios");
const crypto = require("crypto");
const { logApi, logCache, logError, logSuccess, logWarn } = require("./common");

// `mylist` vracia celý zoznam torrentov účtu (drahý call — v logoch bežne 4+ s).
// Krátka cache podľa API kľúča zrýchli opakované requesty (Stremio/Nuvio retry,
// prepínanie epizód) a zníži počet volaní na TorBox.
const MYLIST_TTL_MS = 60 * 1000;
const mylistCache = new Map();

async function nacitajMylistMapu(torboxKey) {
    const key = crypto.createHash("sha1").update(String(torboxKey)).digest("hex").slice(0, 12);
    const cached = mylistCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        logCache("HIT: torbox mylist");
        return cached.value;
    }

    const mylistRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
        headers: { Authorization: `Bearer ${torboxKey}` },
        timeout: 12000
    });

    const mapa = new Map();
    if (mylistRes.data?.success && Array.isArray(mylistRes.data.data)) {
        for (const item of mylistRes.data.data) {
            if (!item?.hash) continue;
            mapa.set(item.hash.toLowerCase(), item.cached === true);
        }
    }

    mylistCache.set(key, { value: mapa, expiresAt: Date.now() + MYLIST_TTL_MS });
    if (mylistCache.size > 200) mylistCache.delete(mylistCache.keys().next().value);
    return mapa;
}

async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || !infoHashes || infoHashes.length === 0) return {};
    
    // Filtrovanie neplatných hodnôt
    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe.map(h => h.toLowerCase()))];
    const hashString = unikatneHashe.sort().join(",");
    
    const cacheMap = {};
    let apiError = null;
    
    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);

    // 1. Shared cache (checkcached) — zvýšený timeout na 12000 ms
    try {
        const res = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached`, {
            params: { hash: hashString, format: "list" },
            headers: { "Authorization": `Bearer ${torboxKey}` },
            timeout: 12000
        });

        if (res.data && res.data.success && res.data.data) {
            const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
            poleDat.forEach(item => { 
                if (item && item.hash) {
                    cacheMap[item.hash.toLowerCase()] = true;
                }
            });
        }
    } catch (error) {
        logWarn(`TorBox checkcached failed (timeout/error): ${error.message}`);
        apiError = error.response?.status === 401 || error.response?.status === 403
            ? "TorBox odmietol API kľúč. Skontroluj ho v nastaveniach addonu."
            : "TorBox API momentálne neodpovedá. Skús to znova o chvíľu.";
    }

    // 2. Osobný účet (mylist) — len pre hashe, ktoré checkcached nenašiel
    const chybajuceHashe = unikatneHashe.filter(h => !cacheMap[h]);
    if (chybajuceHashe.length > 0) {
        logApi(`checkcached nenašiel ${chybajuceHashe.length} hashov, skúšam mylist`);
        try {
            const mylistMapa = await nacitajMylistMapu(torboxKey);
            for (const h of chybajuceHashe) {
                if (mylistMapa.get(h) === true) {
                    cacheMap[h] = true;
                    logCache(`Torrent nájdený v mylist (cached): ${h.substring(0, 12)}...`);
                }
            }
        } catch (error) {
            logWarn(`TorBox mylist check failed (voliteľné): ${error.message}`);
            if (!apiError) {
                apiError = error.response?.status === 401 || error.response?.status === 403
                    ? "TorBox odmietol API kľúč. Skontroluj ho v nastaveniach addonu."
                    : "TorBox API momentálne neodpovedá. Skús to znova o chvíľu.";
            }
        }
    } else {
        logApi(`checkcached našiel všetky hashe, mylist nepotrebný`);
    }

    logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length}/${unikatneHashe.length} cached items.`);
    // Neenumerovateľné, aby sa tento interný stav nikdy nemiešal medzi hashe.
    if (apiError) Object.defineProperty(cacheMap, "apiError", { value: apiError });
    return cacheMap;
}

async function pockajNaTorrentFiles(torrentId, torboxKey, maxPokusov = 15, intervalMs = 1500) {
    for (let pokus = 0; pokus < maxPokusov; pokus++) {
        await new Promise(r => setTimeout(r, intervalMs));

        try {
            const tbRefreshRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                params: { bypass_cache: true, id: torrentId },
                headers: { Authorization: `Bearer ${torboxKey}` },
                timeout: 10000
            });
            if (tbRefreshRes.data && tbRefreshRes.data.data) {
                const zoznamRefresh = Array.isArray(tbRefreshRes.data.data) 
                    ? tbRefreshRes.data.data 
                    : [tbRefreshRes.data.data];
                const kandidat = zoznamRefresh.find(t => t.id === torrentId);

                if (kandidat && Array.isArray(kandidat.files) && kandidat.files.length > 0) {
                    logSuccess(`TorBox torrent ${torrentId} pripravený po ${pokus + 1}. pokuse (${kandidat.files.length} súborov).`);
                    return kandidat;
                }
            }
        } catch (e) {
            logWarn(`Pokus ${pokus + 1}/${maxPokusov}: mylist request zlyhal (${e.message})`);
        }

        logWarn(`Pokus ${pokus + 1}/${maxPokusov}: torrent ${torrentId} ešte nemá pripravené súbory, čakám...`);
    }
    return null;
}

module.exports = { overitTorboxCache, pockajNaTorrentFiles };
