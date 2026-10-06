const axios = require("axios");
const cheerio = require("cheerio");
const { logApi, logError, logSuccess, logWarn, withCache } = require("./common");

async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
    return withCache(`csfd_url_v2:${imdbId}`, 86400000, async () => {
        logApi(`Hľadám ČSFD dáta (vlastný scraper) pre IMDB: ${imdbId} (Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp})`);
        try {
            const query = encodeURIComponent(nazov);
            const searchUrl = `https://www.csfd.cz/hledat/?q=${query}`;
            const res = await axios.get(searchUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "sk,cs;q=0.9,en-US;q=0.8,en;q=0.7"
                },
                timeout: 6000
            });

            const finalUrl = res.request?.res?.responseUrl;
            if (finalUrl && finalUrl.includes("/film/")) {
                logSuccess(`ČSFD priamo presmerovalo na: ${finalUrl}`);
                return finalUrl;
            }

            const $ = cheerio.load(res.data);
            const najdeneVysledky = [];
            $('.article-header').each((i, el) => {
                const linkElement = $(el).find('a.film-title-name');
                const urlPath = linkElement.attr('href');
                const rawInfo = $(el).find('.info').text() || "";

                if (urlPath && urlPath.includes('/film/')) {
                    const rokMatch = rawInfo.match(/\b(19|20)\d{2}\b/);
                    const zaznamRok = rokMatch ? parseInt(rokMatch[0]) : null;
                    const jeSerial = rawInfo.toLowerCase().includes('seriál') || rawInfo.toLowerCase().includes('série');
                    najdeneVysledky.push({
                        url: urlPath.startsWith("http") ? urlPath : `https://www.csfd.cz${urlPath}`,
                        rok: zaznamRok,
                        jeSerial: jeSerial
                    });
                }
            });

            if (najdeneVysledky.length === 0) {
                logWarn(`Vlastný scraper nenašiel žiadne výsledky pre: ${nazov}`);
                return null;
            }

            let filtrovane = najdeneVysledky;
            if (vlastnyTyp === "series") {
                const serialy = najdeneVysledky.filter(v => v.jeSerial);
                if (serialy.length > 0) filtrovane = serialy;
            } else if (vlastnyTyp === "movie") {
                const filmy = najdeneVysledky.filter(v => !v.jeSerial);
                if (filmy.length > 0) filtrovane = filmy;
            }

            let najdeny = filtrovane.find(v => v.rok === rok || v.rok === rok - 1 || v.rok === rok + 1);
            if (!najdeny) najdeny = filtrovane[0];

            logSuccess(`Úspešne nájdené ČSFD URL (vlastný scraper): ${najdeny.url}`);
            return najdeny.url;
        } catch (error) {
            logError(`Chyba pri vlastnom získavaní ČSFD URL pre ${nazov}`, error);
            return null;
        }
    });
}

module.exports = { ziskatCsfdUrl };
