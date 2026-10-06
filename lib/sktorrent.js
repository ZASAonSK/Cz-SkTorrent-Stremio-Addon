const bencode = require("bncode");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { logApi, logError, logInfo, logSuccess, logWarn, withCache } = require("./common");

const BASE_URL = "https://sktorrent.eu";
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

async function hladatTorrenty(dotaz, userAxios, maxPages = 1) {
    if (!dotaz || dotaz.trim().length < 2) return [];

    const skutocneMaxPages = dotaz.includes("csfd.cz") ? 20 : maxPages;

    return withCache(`search_paged_${skutocneMaxPages}:${dotaz}`, 600000, async () => {
        logApi(`Searching SKTorrent for: "${dotaz}" (Max pages: ${skutocneMaxPages})`);

        let vsetkyVysledky = [];
        const videnieIds = new Set();

        for (let page = 0; page < skutocneMaxPages; page++) {
            try {
                logInfo(`Fetching page ${page} for query: ${dotaz}`);
                const res = await userAxios.get(SEARCH_URL, {
                    params: {
                        search: dotaz,
                        category: 0,
                        active: 0,
                        order: 'data',
                        by: 'DESC',
                        page: page
                    }
                });

                const $ = cheerio.load(res.data);
                let najdeneNaStranke = 0;

                $('a[href^="details.php"] img').each((i, img) => {
                    const rodic = $(img).closest("a");
                    const bunka = rodic.closest("td");
                    const text = bunka.text().replace(/\s+/g, " ").trim();
                    const odkaz = rodic.attr("href") || "";
                    const nazov = rodic.attr("title") || "";
                    const torrentId = odkaz.split("id=").pop();

                    if (videnieIds.has(torrentId)) return;

                    const kategoria = bunka.find("b").first().text().trim();
                    const velkostMatch = text.match(/Velkost\s([^|]+)/i);
                    const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);

                    if (!kategoria.toLowerCase().includes("film") && !kategoria.toLowerCase().includes("seri") &&
                        !kategoria.toLowerCase().includes("dokum") && !kategoria.toLowerCase().includes("tv")) return;

                    videnieIds.add(torrentId);
                    vsetkyVysledky.push({
                        name: nazov, id: torrentId,
                        size: velkostMatch ? velkostMatch[1].trim() : "?",
                        seeds: seedMatch ? parseInt(seedMatch[1]) : 0,
                        category: kategoria,
                        downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
                    });
                    najdeneNaStranke++;
                });

                logSuccess(`Found ${najdeneNaStranke} torrents on page ${page}`);
                if (najdeneNaStranke < 10) {
                    logInfo(`Reached end of search results at page ${page}.`);
                    break;
                }
            } catch (chyba) {
                logError(`SKTorrent search failed on page ${page} for: "${dotaz}"`, chyba);
                break;
            }
        }

        return vsetkyVysledky.sort((a, b) => b.seeds - a.seeds);
    });
}

async function stiahnutTorrentData(url, userAxios) {
    return withCache(`torrent:${url}`, 86400000, async () => {
        logApi(`Downloading .torrent file from: ${url}`);
        try {
            const res = await userAxios.get(url, { responseType: "arraybuffer" });
            const bufferString = res.data.toString("utf8", 0, 50);
            if (bufferString.includes("<html") || bufferString.includes("<!DOC")) {
                logWarn(`Received HTML instead of .torrent file from ${url}`);
                return null;
            }

            const torrent = bencode.decode(res.data);
            const info = bencode.encode(torrent.info);
            const infoHash = crypto.createHash("sha1").update(info).digest("hex");

            let subory = [];
            if (torrent.info.files) {
                subory = torrent.info.files.map((file, index) => {
                    const cesta = (file["path.utf-8"] || file.path || []).map(p => p.toString()).join("/");
                    const length = Number(file.length || 0);
                    return { path: cesta, index, length };
                });
            } else {
                const nazov = (torrent.info["name.utf-8"] || torrent.info.name || "").toString();
                const length = Number(torrent.info.length || 0);
                subory = [{ path: nazov, index: 0, length }];
            }

            logSuccess(`Successfully parsed .torrent (Hash: ${infoHash}) from ${url}`);
            return { infoHash, files: subory };
        } catch (chyba) {
            logError(`Failed to download/parse .torrent from ${url}`, chyba);
            return null;
        }
    });
}

async function stiahnutSurovyTorrent(url, userAxios) {
    return withCache(`rawtorrent:${url}`, 86400000, async () => {
        try {
            const res = await userAxios.get(url, { responseType: "arraybuffer" });
            const bufferString = res.data.toString("utf8", 0, 50);
            if (bufferString.includes("<html") || bufferString.includes("<!DOC")) return null;
            return res.data;
        } catch (chyba) {
            return null;
        }
    });
}

module.exports = { hladatTorrenty, stiahnutSurovyTorrent, stiahnutTorrentData };
