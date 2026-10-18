const axios = require("axios");
const { logApi, logCache, logError, logSuccess, logWarn } = require("./common");

async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || !infoHashes || infoHashes.length === 0) return {};
    
    // TOTO JE TA OPRAVA: Najprv vyfiltruje vsetko co nie je undefined/null a az potom robi toLowerCase
    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const hashString = unikatneHashe.sort().join(",");
    
    const cacheMap = {};
    
    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);

    // 1. Shared cache (checkcached) — rýchly, vždy prvý
    try {
        const res = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached`, {
            params: { hash: hashString, format: "list" },
            headers: { "Authorization": `Bearer ${torboxKey}` },
            timeout: 5000
        });

        if (res.data && res.data.success && res.data.data) {
            const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
            poleDat.forEach(item => { 
                if (item && item.hash) cacheMap[item.hash.toLowerCase()] = true; 
            });
        }
    } catch (error) {
        logError("TorBox checkcached failed", error);
    }

    // 2. Osobný účet (mylist) — len pre hashe ktoré checkcached nenašiel
    const chybajuceHashe = unikatneHashe.filter(h => !cacheMap[h]);
    if (chybajuceHashe.length > 0) {
        logApi(`checkcached nenasiel ${chybajuceHashe.length} hashov, skusam mylist`);
        try {
            const mylistRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                headers: { Authorization: `Bearer ${torboxKey}` },
                timeout: 5000
            });

            if (mylistRes.data?.success && Array.isArray(mylistRes.data.data)) {
                for (const item of mylistRes.data.data) {
                    if (!item.hash) continue;
                    const h = item.hash.toLowerCase();
                    // POZOR: `download_finished` ostáva true AJ po expirácii — torrent
                    // v stave expired/incomplete/reported missing už nie je hrateľný
                    // (requestdl vracia DATABASE_ERROR). Jediný spoľahlivý indikátor
                    // dostupnosti súborov je `cached === true` (overené na reálnych
                    // dátach: completed/uploading/stopped seeding → cached=true,
                    // expired/incomplete/reported missing → cached=false).
                    if (chybajuceHashe.includes(h) && item.cached === true) {
                        if (!cacheMap[h]) {
                            cacheMap[h] = true;
                            logCache(`Torrent najdeny v mylist (cached): ${h.substring(0,12)}...`);
                        }
                    }
                }
            }
        } catch (error) {
            logWarn(`TorBox mylist check failed (volitelne): ${error.message}`);
        }
    } else {
        logApi(`checkcached nasiel vsetky hashe, mylist nepotrebny`);
    }

    logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length}/${unikatneHashe.length} cached items.`);
    return cacheMap;
}

async function pockajNaTorrentFiles(torrentId, torboxKey, maxPokusov = 15, intervalMs = 1500) {
    for (let pokus = 0; pokus < maxPokusov; pokus++) {
        await new Promise(r => setTimeout(r, intervalMs));

        try {
            const tbRefreshRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                params: { bypass_cache: true, id: torrentId },
                headers: { Authorization: `Bearer ${torboxKey}` },
                timeout: 8000
            });
            if (tbRefreshRes.data && tbRefreshRes.data.data) {
                const zoznamRefresh = Array.isArray(tbRefreshRes.data.data) ? tbRefreshRes.data.data : [tbRefreshRes.data.data];
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
