const axios = require("axios");
const { logApi, logError, logSuccess, logWarn } = require("./common");

async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || !infoHashes || infoHashes.length === 0) return {};

    const platneHashe = infoHashes.filter(h => h && typeof h === 'string');
    if (platneHashe.length === 0) return {};

    const unikatneHashe = [...new Set(platneHashe)].map(h => h.toLowerCase());
    const hashString = unikatneHashe.sort().join(",");

    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);
    try {
        const res = await axios.get("https://api.torbox.app/v1/api/torrents/checkcached", {
            params: { hash: hashString, format: "list" },
            headers: { "Authorization": `Bearer ${torboxKey}` },
            timeout: 5000
        });

        const cacheMap = {};
        if (res.data && res.data.success && res.data.data) {
            const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
            poleDat.forEach(item => {
                if (item && item.hash) cacheMap[item.hash.toLowerCase()] = true;
            });
        }
        logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length} cached items.`);
        return cacheMap;
    } catch (error) {
        logError("TorBox cache check failed", error);
        return {};
    }
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
