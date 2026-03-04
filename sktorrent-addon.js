// SKTorrent Addon v1.6.0
// TORBOX + SFD API + ADVANCED METADATA + UNIFIED PROXY

const { addonBuilder } = require('stremio-addon-sdk');
const decode = require('entities');
const axios = require('axios');
const cheerio = require('cheerio');
const bencode = require('bencode');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const express = require('express');
const FormData = require('form-data');
const path = require('path');
const cors = require('cors');
const csfd = require('node-csfd-api');

const PORT = process.env.PORT || 7000;
const PUBLIC_URL = 'https://bda31382-bef9-4743-b2e2-e9838ecb6690.eu-central-1.cloud.genez.io';

const BASE_URL = 'https://sktorrent.eu';
const SEARCH_URL = `${BASE_URL}/torrent/torrentsv2.php`;

const agentOptions = { keepAlive: true, maxSockets: 50 };

// --- LOGOVACÍ SYSTÉM ---
function getTime() {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
}
function logInfo(msg) { console.log(`[${getTime()}] [INFO] ${msg}`); }
function logSuccess(msg) { console.log(`[${getTime()}] [SUCCESS] ${msg}`); }
function logWarn(msg) { console.warn(`[${getTime()}] [WARN] ${msg}`); }
function logError(msg, err) { console.error(`[${getTime()}] [ERROR] ${msg}`, err ? err.message || err : ''); }
function logCache(msg) { console.log(`[${getTime()}] [CACHE] ${msg}`); }
function logApi(msg) { console.log(`[${getTime()}] [API] ${msg}`); }

// --- CACHE a CONCURRENCY SYSTÉM ---
const cache = new Map(); // Nechame tu len aby to nehodilo error ak sa na to nieco iné odkazuje

async function withCache(key, ttlMs, fetcher) {
    logCache(`BYPASS CACHE - Ziskavam data nazivo pre: ${key}`);
    try {
        const data = await fetcher();
        return data;
    } catch (error) {
        logError(`Failed to fetch key (no cache): ${key}`, error);
        return null;
    }
}

function pLimit(limit) {
    let active = 0;
    const q = [];
    const next = () => {
        if (active < limit && q.length > 0) {
            return active++;
            const { fn, resolve, reject } = q.shift();
            fn().then(resolve, reject).finally(() => {
                active--;
                next();
            });
        }
    };
    return (fn) => new Promise((resolve, reject) => {
        q.push({ fn, resolve, reject });
        next();
    });
}

// --- POMOCNÉ FUNKCIE PRE CONFIG A TEXT ---
function decodeConfig(configString) {
    try {
        if (!configString || configString.includes('.json')) return null;
        let base64 = configString.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch (e) {
        logWarn(`Failed to decode config: ${configString}`);
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
            'User-Agent': 'Mozilla/5.0',
            'Cookie': `uid=${uid}; pass=${pass}`,
            'Referer': BASE_URL,
            'Connection': 'keep-alive'
        }
    });
}

const langToFlag = { 'CZ': '🇨🇿', 'SK': '🇸🇰', 'EN': '🇬🇧', 'US': '🇺🇸', 'DE': '🇩🇪', 'FR': '🇫🇷', 'IT': '🇮🇹', 'ES': '🇪🇸', 'RU': '🇷🇺', 'PL': '🇵🇱', 'HU': '🇭🇺', 'JP': '🇯🇵' };

function odstranDiakritiku(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
}

function skratNazov(title, pocetSlov = 3) {
    return title.split(" ").slice(0, pocetSlov).join(" ");
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '?';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i >= 2 ? 2 : 0)} ${u[i]}`;
}

async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || infoHashes.length === 0) return {};
    const unikatneHashe = [...new Set(infoHashes.map(h => h.toLowerCase()))];
    const hashString = unikatneHashe.sort().join(',');

    logApi(`Checking TorBox cache directly for ${unikatneHashe.length} hashes`);
    try {
        const res = await axios.get('https://api.torbox.app/v1/api/torrents/checkcached', {
            params: { hash: hashString, format: 'list' },
            headers: { Authorization: `Bearer ${torboxKey}` },
            timeout: 5000
        });

        const cacheMap = {};
        if (res.data && res.data.success && res.data.data) {
            const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
            poleDat.forEach(item => {
                if (item.hash) cacheMap[item.hash.toLowerCase()] = true;
            });
        }
        logSuccess(`TorBox cache check complete. Found ${Object.keys(cacheMap).length} cached items.`);
        return cacheMap;
    } catch (error) {
        logError("TorBox cache check failed", error);
        return {};
    }
}

// --- ZÍSKANIE ČSFD LINKU CEZ node-csfd-api ---
async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
    return withCache(`csfdurlv2_${imdbId}`, 86400000, async () => {
        logApi(`Hľadám ČSFD dáta pre IMDB: ${imdbId} | Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp}`);
        try {
            const hladanie = await csfd.search(nazov);
            let vsetkyVysledky = [];
            if (vlastnyTyp === 'series' && hladanie.tvSeries) vsetkyVysledky = hladanie.tvSeries;
            else if (vlastnyTyp === 'movie' && hladanie.movies) vsetkyVysledky = hladanie.movies;
            else vsetkyVysledky = [...(hladanie.movies || []), ...(hladanie.tvSeries || [])];

            if (vsetkyVysledky.length === 0) {
                logWarn(`ČSFD nenašlo žiadne '${vlastnyTyp}' výsledky pre: ${nazov}`);
                return null;
            }

            let najdeny = vsetkyVysledky.find(v => v.year === rok || v.year === rok - 1 || v.year === rok + 1);
            if (!najdeny) najdeny = vsetkyVysledky[0];

            let urlPath = najdeny.url;
            const csfdUrl = urlPath.startsWith('http') ? urlPath : `https://www.csfd.cz${urlPath}`;

            logSuccess(`Úspešne nájdené ČSFD URL: ${csfdUrl}`);
            return csfdUrl;
        } catch (error) {
            logError(`Chyba pri získavaní ČSFD URL pre: ${nazov}`, error);
            return null;
        }
    });
}

// --- FILTRE PRE NÁZVY A SERIÁLY ---
function torrentSedisSeriou(nazovTorrentu, seria) {
    if (/S([1,2]-[S]?\d{1,2})/i.test(nazovTorrentu) || /Seasons?\s*([1,2]-\d{1,2})/i.test(nazovTorrentu) || /\b([1,2]\.?\s*-\s*\d{1,2}\.?\s*serie)\b/i.test(nazovTorrentu)) return true;
    const serieMatch = nazovTorrentu.match(/(\d+)\.\s*serie/i);
    if (serieMatch && parseInt(serieMatch[1]) !== seria) return false;
    const seasonMatch = nazovTorrentu.match(/season\s*(\d+)/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== seria) return false;
    const sMatch = nazovTorrentu.match(/s(\d{1,2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1]) !== seria) return false;
    return true;
}

function torrentSediSEpizodou(nazov, seria, epizoda) {
    const range = nazov.match(/([1,2]-[S]?\d{1,2})/i) || nazov.match(/([1,2]-\d{1,2})/i) || nazov.match(/\b([1,2]\.?\s*-\s*\d{1,2}\.?\s*serie)\b/i) || nazov.match(/\bS[e|é]ria[\s:]*([1,2]-\d{1,2})\b/i);
    if (range) {
        const nums = range.filter(x => x !== undefined && /\d/.test(x));
        if (nums.length >= 2) {
            const a = parseInt(nums[0], 10);
            const b = parseInt(nums[1], 10);
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            if (seria >= lo && seria <= hi) return true;
        }
    }

    const seriaStr = String(seria).padStart(2, '0');
    const epStr = String(epizoda).padStart(2, '0');
    let toMaZluEpizodu = false;

    const vsetkyE = [...nazov.matchAll(new RegExp(`S${seriaStr}[.\-]?E(\\d{1,3})`, 'gi'))];
    if (vsetkyE.length > 0) {
        const maNasu = vsetkyE.some(m => parseInt(m[1]) === parseInt(epizoda));
        if (!maNasu) toMaZluEpizodu = true;
    }

    const vsetkyX = [...nazov.matchAll(new RegExp(`${seria}x(\\d{1,3})`, 'gi'))];
    if (vsetkyX.length > 0) {
        const maNasu = vsetkyX.some(m => parseInt(m[1]) === parseInt(epizoda));
        if (!maNasu) toMaZluEpizodu = true;
    }

    const jeToRozsahE = nazov.match(/E(\d{1,3})-E?(\d{1,3})/i);
    if (jeToRozsahE) {
        const zaciatokE = parseInt(jeToRozsahE[1]);
        const koniecE = parseInt(jeToRozsahE[2]);
        if (epizoda >= zaciatokE && epizoda <= koniecE) toMaZluEpizodu = false;
    }

    if (toMaZluEpizodu) return false;

    if (new RegExp(`S${seriaStr}[.\-]?E${epStr}`, 'i').test(nazov)) return true;
    if (new RegExp(`${seria}x${epStr}`, 'i').test(nazov)) return true;

    const rozsahEpizod = nazov.match(/E(\d{1,3})-E?(\d{1,3})/i) || nazov.match(/(?:Dily|Parts|Epizody|Eps|Ep\.)\s*(\d{1,3})-(\d{1,3})/i);
    if (rozsahEpizod) {
        const zaciatok = parseInt(rozsahEpizod[1] || rozsahEpizod[2]);
        const koniec = parseInt(rozsahEpizod[2] || rozsahEpizod[3]);
        if (epizoda >= zaciatok && epizoda <= koniec) return true;
    }

    const jeToCelaSeria = new RegExp(`${seria}.\\s*serie`, 'i').test(nazov) ||
                          new RegExp(`S[e|é]ria\\s*${seria}`, 'i').test(nazov) ||
                          new RegExp(`season\\s*${seria}`, 'i').test(nazov) ||
                          new RegExp(`S${seriaStr}`, 'i').test(nazov) ||
                          /(Pack|Komplet|Complete|Vol|Volume|Part|C\s*ast|1\.-[1,2]\.)/i.test(nazov);
    return jeToCelaSeria;
}

// --- Získanie názvov Súbežne TMDB / Cinemeta a ADVANCED METADATA ---
function parseYearRange(y) {
    if (!y) return { yearStart: null, yearEnd: null };
    const s = String(y).trim();
    const m = s.match(/^(\d{4})?(?:-(\d{4})?)?$/);
    if (!m) return { yearStart: null, yearEnd: null };
    return {
        yearStart: m[1] ? parseInt(m[1]) : null,
        yearEnd: m[2] ? parseInt(m[2]) : null
    };
}

async function ziskatVsetkyNazvyARok(imdbId, vlastnyTyp, tmdbKey) {
    return withCache(`namesyearv2_${imdbId}`, 21600000, async () => {
        logApi(`Fetching metadata pre IMDB ID: ${imdbId} (${vlastnyTyp})`);
        const nazvy = new Set();
        let titleOriginal = null;
        let titleCz = null;
        let yearStart = null;
        let yearEnd = null;

        const tmdbTyp = (vlastnyTyp === 'series') ? 'tv' : 'movie';
        const promises = [
            axios.get(`https://v3-cinemeta.strem.io/meta/${vlastnyTyp}/${imdbId}.json`, { timeout: 4000 }).catch(() => null)
        ];

        if (tmdbKey) {
            promises.push(
                axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                    params: { api_key: tmdbKey, external_source: 'imdb_id' },
                    timeout: 4000
                }).catch(() => null)
            );
        }

        const [cineRes, tmdbRes] = await Promise.all(promises);

        if (cineRes && cineRes.data?.meta) {
            const m = cineRes.data.meta;
            if (m.name) {
                nazvy.add(decode(m.name).trim());
                titleCz = decode(m.name).trim();
            }
            if (m.original_name) {
                nazvy.add(decode(m.original_name).trim());
                if (!titleOriginal) titleOriginal = decode(m.original_name).trim();
            }
            if (m.aliases) m.aliases.forEach(a => nazvy.add(decode(a).trim()));
            if (m.year) {
                const r = parseYearRange(m.year);
                yearStart = r.yearStart;
                yearEnd = r.yearEnd;
            }
        }

        let tmdbId = null;
        if (tmdbRes && tmdbRes.data) {
            if (vlastnyTyp === 'series' && tmdbRes.data.tv_results?.length > 0) {
                const res = tmdbRes.data.tv_results[0];
                tmdbId = res.id;
                nazvy.add(res.name);
            } else if (vlastnyTyp === 'movie' && tmdbRes.data.movie_results?.length > 0) {
                const res = tmdbRes.data.movie_results[0];
                tmdbId = res.id;
                nazvy.add(res.title);
            }
        }

        if (tmdbKey && tmdbId) {
            try {
                if (vlastnyTyp === 'series') {
                    const det = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (!titleOriginal && det.data?.original_name) titleOriginal = det.data.original_name;
                    if (!yearStart && det.data?.first_air_date) yearStart = parseInt(det.data.first_air_date.slice(0,4));
                    if (!yearEnd && det.data?.last_air_date) yearEnd = parseInt(det.data.last_air_date.slice(0,4));
                } else {
                    const det = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (!titleOriginal && det.data?.original_title) titleOriginal = det.data.original_title;
                    if (!yearStart && det.data?.release_date) yearStart = parseInt(det.data.release_date.slice(0,4));
                }

                const trans = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, { params: { api_key: tmdbKey }, timeout: 4000 });
                if (trans.data?.translations) {
                    trans.data.translations.forEach(tr => {
                        const m = (tr.data && (tr.data.title || tr.data.name));
                        if (m && ['cs', 'sk', 'en'].includes(tr.iso_639_1)) {
                            nazvy.add(m);
                            if (tr.iso_639_1 === 'cs') { titleCz = m; }
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        if (!titleOriginal) titleOriginal = titleCz;

        const vysledokNazvy = [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith('výsledky'));
        return { nazvy: vysledokNazvy, rok: yearStart, meta: { titleOriginal, titleCz, yearStart, yearEnd } };
    });
}

// --- Hľadanie a spracovanie Torrentov ---
async function hladatTorrenty(dotaz, userAxios, maxPages = 1) {
    if (!dotaz || dotaz.trim().length < 2) return [];

    const skutocneMaxPages = dotaz.includes('csfd.cz') ? 4 : maxPages;

    return withCache(`search_paged_${skutocneMaxPages}_${dotaz}`, 600000, async () => {
        logApi(`Searching SKTorrent for: ${dotaz} (Max pages: ${skutocneMaxPages})`);
        let vsetkyVysledky = [];
        const videnieIds = new Set();

        for (let page = 0; page < skutocneMaxPages; page++) {
            try {
                logInfo(`Fetching page ${page} for query: ${dotaz}`);
                const res = await userAxios.get(SEARCH_URL, {
                    params: { search: dotaz, category: 0, active: 0, order: 'data', by: 'DESC', page: page }
                });

                const $ = cheerio.load(res.data);
                let najdeneNaStranke = 0;

                $('a[href^="details.php"]').find('img').each((i, img) => {
                    const rodic = $(img).closest('a');
                    const bunka = rodic.closest('td');
                    const text = bunka.text().replace(/\s+/g, ' ').trim();

                    const odkaz = rodic.attr('href');
                    const nazov = rodic.attr('title');
                    const torrentId = odkaz.split('id=')[1].split('&')[0];

                    if (videnieIds.has(torrentId)) return;

                    const kategoria = bunka.find('b').first().text().trim();
                    const velkostMatch = text.match(/Veľkosť:\s*([\d.]+\s*[KMGT]?B)/i);
                    const seedMatch = text.match(/Odosielajú:\s*(\d+)/i);

                    if (!kategoria.toLowerCase().includes('film') &&
                        !kategoria.toLowerCase().includes('seri') &&
                        !kategoria.toLowerCase().includes('dokum') &&
                        !kategoria.toLowerCase().includes('tv')) return;

                    videnieIds.add(torrentId);
                    vsetkyVysledky.push({
                        name: nazov, id: torrentId,
                        size: velkostMatch ? velkostMatch[1].trim() : '?',
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
                logError(`SKTorrent search failed on page ${page} for: ${dotaz}`, chyba);
                break;
            }
        }
        return vsetkyVysledky.sort((a, b) => b.seeds - a.seeds);
    });
}

async function stiahnutTorrentData(url, userAxios) {
    return withCache(`torrent_${url}`, 86400000, async () => {
        logApi(`Downloading .torrent file from: ${url}`);
        try {
            const res = await userAxios.get(url, { responseType: 'arraybuffer' });
            const bufferString = res.data.toString('utf8', 0, 50);
            if (bufferString.includes('<html') || bufferString.includes('<!DOC')) {
                logWarn(`Received HTML instead of .torrent file from: ${url}`);
                return null;
            }
            const torrent = bencode.decode(res.data);
            const info = bencode.encode(torrent.info);
            const infoHash = crypto.createHash('sha1').update(info).digest('hex');

            let subory = [];
            if (torrent.info.files) {
                subory = torrent.info.files.map((file, index) => {
                    const cesta = file['path.utf-8'] || file.path;
                    return { path: cesta.map(p => p.toString()).join('/'), index, length: Number(file.length) || 0 };
                });
            } else {
                const nazov = (torrent.info['name.utf-8'] || torrent.info.name).toString();
                subory = [{ path: nazov, index: 0, length: Number(torrent.info.length) || 0 }];
            }

            logSuccess(`Successfully parsed .torrent (Hash: ${infoHash}) from: ${url}`);
            return { infoHash, files: subory };
        } catch (chyba) {
            logError(`Failed to download/parse .torrent from: ${url}`, chyba);
            return null;
        }
    });
}

async function stiahnutSurovyTorrent(url, userAxios) {
    return withCache(`rawtorrent_${url}`, 86400000, async () => {
        try {
            const res = await userAxios.get(url, { responseType: 'arraybuffer' });
            const bufferString = res.data.toString('utf8', 0, 50);
            if (bufferString.includes('<html') || bufferString.includes('<!DOC')) return null;
            return res.data;
        } catch (chyba) { return null; }
    });
}

async function vytvoritStream(t, seria, epizoda, userAxios, meta) {
    logInfo(`Creating stream for torrent ID: ${t.id} - ${t.name}`);
    const torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
    if (!torrentData) return null;

    const langZhody = t.name.match(/\[([A-Z]{2})\]/g) || [];
    const vlajky = langZhody.map(kod => langToFlag[kod.replace(/[\[\]]/g, '').toUpperCase()]).filter(Boolean);
    const vlajkyText = vlajky.length ? vlajky.join(' ') + ' ' : '';
    let cistyNazov = t.name.replace(/\[Stiahni si\]/i, '').trim();
    if (cistyNazov.toLowerCase().startsWith(`[${t.category.trim().toLowerCase()}]`)) {
        cistyNazov = cistyNazov.slice(t.category.length + 2).trim();
    }

    let streamObj = {
        name: `[SKT] ${t.category.toUpperCase()}`,
        behaviorHints: { bingeGroup: `[${cistyNazov}]` },
        infoHash: torrentData.infoHash,
        sktId: t.id
    };

    if (seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

        if (videoSubory.length === 0) return null;

        let najdenyIndex = -1;
        const epCislo = parseInt(epizoda);
        const epStr = String(epCislo).padStart(2, '0');
        const seriaStr = String(seria).padStart(2, '0');

        if (videoSubory.length === 1) {
            const nazovSuboru = videoSubory[0].path;
            const najdeneESubor = nazovSuboru.match(new RegExp(`S${seriaStr}[.\-]?E(\\d{1,3})`, 'i')) ||
                                  nazovSuboru.match(new RegExp(`${seria}x(\\d{1,3})`, 'i')) ||
                                  nazovSuboru.match(new RegExp(`Ep(?:isode)?\\.\\s*(\\d{1,3})`, 'i')) ||
                                  nazovSuboru.match(new RegExp(`(\\d{1,3})`, 'i'));
            if (najdeneESubor && parseInt(najdeneESubor[1]) !== epCislo) return null;
            najdenyIndex = videoSubory[0].index;
        } else {
            const epRegexy = [
                new RegExp(`(?:^|[^0-9])0?${epCislo}\\.(?:-|\\s|\\.).*\\.(?:mp4|mkv|avi|m4v)$`, 'i'),
                new RegExp(`S${seriaStr}[.\-]?E${epStr}`, 'i'),
                new RegExp(`${seria}x${epStr}`, 'i'),
                new RegExp(`S${seriaStr}x${epStr}`, 'i'),
                new RegExp(`${seria}x0?${epCislo}(?!\\d)`, 'i'),
                new RegExp(`S${seriaStr}[.\-]?E${epStr}(?![0-9])`, 'i'),
                new RegExp(`Ep(?:isode)?\\.\\s*0?${epCislo}(?!\\d)`, 'i'),
                new RegExp(`[.\-]${epStr}[.\-]`, 'i'),
                new RegExp(`(?:^|\\/)[.\-]*0?${epCislo}[.\-]+\\.*\\.(?:mp4|mkv|avi|m4v)$`, 'i')
            ];

            for (let i = 0; i < epRegexy.length; i++) {
                const reg = epRegexy[i];
                const zhoda = videoSubory.find(f => reg.test(f.path));
                if (zhoda) { najdenyIndex = zhoda.index; break; }
            }

            if (najdenyIndex === -1) return null;
        }
        streamObj.fileIdx = najdenyIndex;
    } else {
        // PRE FILMY zistíme index najväčšieho video súboru už priamo tu
         const videoSubory = torrentData.files
             .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
             .sort((a, b) => b.length - a.length);

         if (videoSubory.length > 0) {
              streamObj.fileIdx = videoSubory[0].index;
         }
    }

    // --- FORMÁTOVANIE NOVÉHO TITLE ---
    let originalNazov = t.name.replace(/\[Stiahni si\]/i, '').trim();
    if (originalNazov.toLowerCase().startsWith(`[${t.category.trim().toLowerCase()}]`)) {
        originalNazov = originalNazov.slice(t.category.length + 2).trim();
    }

    const titleOriginalText = meta?.titleOriginal ? meta.titleOriginal : '';
    const titleCzText = meta?.titleCz ? meta.titleCz : '';
    const titleLine = (titleCzText !== '' && titleOriginalText !== '') ? `${titleCzText} / ${titleOriginalText}` :
                      (titleCzText !== '' ? titleCzText : titleOriginalText);

    let rokText = "N/A";
    if (meta?.yearStart) {
        if (seria !== undefined) {
             rokText = (meta.yearEnd && meta.yearStart !== meta.yearEnd) ? `${meta.yearStart}-${meta.yearEnd}` : `${meta.yearStart}`;
        } else {
             rokText = `${meta.yearStart}`;
        }
    }

    const seriaEpizodaText = (seria !== undefined && epizoda !== undefined) ? `Séria: ${seria} | Epizóda: ${epizoda}` : '';

    const analyzaNazvu = originalNazov.toLowerCase();
    const kvality = [];
    if (analyzaNazvu.includes('2160p') || analyzaNazvu.includes('4k') || analyzaNazvu.includes('uhd')) kvality.push('4K');
    else if (analyzaNazvu.includes('1080p') || analyzaNazvu.includes('fhd')) kvality.push('1080p');
    else if (analyzaNazvu.includes('720p') || analyzaNazvu.includes('hd')) kvality.push('720p');
    else if (analyzaNazvu.includes('480p')) kvality.push('480p');

    if (analyzaNazvu.includes('hdr')) kvality.push('HDR');
    if (analyzaNazvu.includes('dovi') || analyzaNazvu.includes('vision')) kvality.push('Dolby Vision');

    if (analyzaNazvu.includes('hevc') || analyzaNazvu.includes('h265') || analyzaNazvu.includes('h.265') || analyzaNazvu.includes('x265')) kvality.push('HEVC');
    else if (analyzaNazvu.includes('x264') || analyzaNazvu.includes('h264') || analyzaNazvu.includes('h.264') || analyzaNazvu.includes('avc')) kvality.push('H.264');

    if (analyzaNazvu.includes('atmos')) kvality.push('Atmos');

    const kvalitaText = kvality.length > 0 ? kvality.join(' | ') : 'Kvalita neznáma';

    const fileSize = (streamObj.fileIdx !== undefined) ?
        (torrentData.files.find(f => f.index === streamObj.fileIdx)?.length || 0) :
        torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0);
    const formatFileSize = formatBytes(fileSize);
    const velkostText = `💿 ${formatFileSize} | 🧩 ${t.size}`;

    const langMatch = originalNazov.match(/\[(CZ|SK|EN|IT)\]/ig);
    const vlajkyList = (langMatch || []).map(kod => langToFlag[kod.replace(/[\[\]]/g, '').toUpperCase()]).filter(Boolean);
    const unikatneVlajky = [...new Set(vlajkyList)];

    let jazykText = 'Neznámy jazyk';
    if (unikatneVlajky.length > 0) {
        jazykText = unikatneVlajky.join(' | ');
    } else if (langMatch && langMatch.length > 0) {
        const textoveJazyky = [...new Set(langMatch.map(l => l.replace(/[\[\]]/g, '').toUpperCase()))];
        jazykText = textoveJazyky.join(' | ');
    }

    const riadkyTitle = [originalNazov, titleLine, rokText];
    if (seriaEpizodaText) riadkyTitle.push(seriaEpizodaText);
    riadkyTitle.push(kvalitaText);
    riadkyTitle.push(velkostText);
    riadkyTitle.push(`Jazyk: ${jazykText}`);

    streamObj.title = riadkyTitle.join('\n');
    return streamObj;
}

// --- VLASTNÝ EXPRESS SERVER BEZ getRouter Z SDK ---
const app = express();
app.use(cors());

app.use((req, res, next) => {
    // console.log(`[${getTime()}] HTTP REQUEST - ${req.method} ${req.originalUrl}`);
    // console.log(`[${getTime()}] IP: ${req.ip} | User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    next();
});

// --- Web UI ---
app.get('/:configure?', (req, res) => {
    const html = `
    <!DOCTYPE html>
    <html lang="sk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SKTorrent Multi-User Addon</title>
        <style>
            body { font-family: Arial, sans-serif; background: #111; color: white; display: flex; justify-content: center; padding-top: 50px; }
            .container { background: #222; padding: 30px; border-radius: 8px; width: 100%; max-width: 450px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
            h2 { text-align: center; color: #8A5A9E; margin-bottom: 5px; }
            label { display: block; margin-top: 15px; font-size: 14px; font-weight: bold; }
            input { width: 100%; padding: 10px; margin-top: 5px; background: #333; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box; }
            button { width: 100%; padding: 12px; margin-top: 25px; background: #8A5A9E; color: white; border: none; font-size: 16px; border-radius: 4px; cursor: pointer; font-weight: bold; }
            button:hover { background: #6b467a; }
            #result-box { display: none; margin-top: 20px; padding: 15px; background: #1a1a1a; border: 1px solid #8A5A9E; border-radius: 4px; text-align: center; }
            #generated-url { width: 100%; font-size: 12px; padding: 8px; margin: 10px 0; background: #000; color: #0f0; border: 1px solid #333; word-break: break-all; box-sizing: border-box; resize: none; overflow: hidden; height: 60px; }
            .copy-btn { background: #444; margin-top: 5px; }
            .copy-btn:hover { background: #555; }
            .install-btn { background: #28a745; margin-top: 10px; }
            .install-btn:hover { background: #218838; }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>SKTorrent Addon</h2>
            <p style="text-align:center; font-size:13px; color:#aaa;">Vyplň svoje údaje na vygenerovanie inštalačného odkazu.</p>

            <label>SKTorrent UID (Cookie s názvom 'uid')</label>
            <input type="text" id="uid" placeholder="Napr. 123987" required>

            <label>SKTorrent pass (Tiež z cookies s názvom 'pass')</label>
            <input type="password" id="pass" placeholder="Tvoj pass" required>

            <label>TorBox API Key (Odporúčané)</label>
            <input type="text" id="torbox" placeholder="TorBox token">

            <label>TMDB API Key (Voliteľné)</label>
            <input type="text" id="tmdb" placeholder="TMDB token">

            <button onclick="generateLink()">Vygenerovať odkaz</button>

            <div id="result-box">
                <p style="margin:0; font-size:14px; font-weight:bold; color:#8A5A9E;">Tvoj inštalačný odkaz:</p>
                <textarea id="generated-url" readonly></textarea>
                <button class="copy-btn" onclick="copyUrl()">📋 Kopírovať do schránky</button>
                <button class="install-btn" onclick="openStremio()">🚀 Nainštalovať do Stremia</button>
            </div>
        </div>

        <script>
            function generateLink() {
                var config = {
                    uid: document.getElementById('uid').value,
                    pass: document.getElementById('pass').value,
                    torbox: document.getElementById('torbox').value,
                    tmdb: document.getElementById('tmdb').value,
                    cb: Date.now() // CACHE BUSTER - oklame Stremio ze ide o novy addon
                };

                if(!config.uid || !config.pass) {
                    alert("Prosím, vyplň aspoň UID a Heslo pre SKTorrent.");
                    return;
                }

                try {
                    var jsonString = JSON.stringify(config);
                    var encodedConfig = btoa(unescape(encodeURIComponent(jsonString)));
                    var currentUrl = '${PUBLIC_URL}';
                    var finalHttpUrl = currentUrl + '/' + encodedConfig + '/manifest.json';
                    
                    document.getElementById('result-box').style.display = 'block';
                    document.getElementById('generated-url').value = finalHttpUrl;
                } catch (error) {
                    alert("Chyba pri generovaní kódu.");
                    console.error(error);
                }
            }

            function copyUrl() {
                var urlText = document.getElementById('generated-url');
                urlText.select();
                document.execCommand("copy");
                var copyBtn = document.querySelector('.copy-btn');
                copyBtn.innerText = '✅ Skopírované!';
                setTimeout(function() { copyBtn.innerText = '📋 Kopírovať do schránky'; }, 2000);
            }

            function openStremio() {
                var httpUrl = document.getElementById('generated-url').value;
                var stremioUrl = httpUrl.replace(/^https?:\/\//i, 'stremio://');
                window.location.assign(stremioUrl);
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

// --- Manifest Route ---
const handleManifest = (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    res.json({
        id: 'org.stremio.skcztorrent.addon',
        version: '1.6.7',
        name: 'SKTorrent TorBox Multi-User',
        description: 'SKTorrent s TorBox prehrávaním, SFD a metadátami',
        types: ['movie', 'series'],
        catalogs: [],
        resources: ['stream'],
        idPrefixes: ['tt'],
        behaviorHints: { configurable: true, configurationRequired: false }
    });
};

app.get('/manifest.json', handleManifest);
app.get('/:config/manifest.json', handleManifest);

app.get('/:config/catalog/:type/:id.json', (req, res) => {
    res.json({ metas: [] });
});

// --- Stream Route ---
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const { type: aplikaciaTyp, id, config } = req.params;
    const startCas = Date.now();

    logInfo(`Stream request started | Type: ${aplikaciaTyp} | ID: ${id}`);

    const userConfig = decodeConfig(config);
    const activeUid = userConfig?.userid || userConfig?.uid;
    const activePass = userConfig?.password || userConfig?.pass;
    const activeTorbox = userConfig?.tbkey || userConfig?.torbox;
    const activeTmdb = userConfig?.tmkey || userConfig?.tmdb;

    if (!activeUid || !activePass) {
        logWarn(`Stream request denied - Invalid or missing config.`);
        return res.json({ streams: [], error: "Neplatná konfigurácia." });
    }

    const normalizedConfig = { uid: activeUid, pass: activePass, torbox: activeTorbox, tmdb: activeTmdb };
    const userAxios = getFastAxios(normalizedConfig);

    const jeToSerialPodlaId = id.includes(':');
    const [imdbId, sRaw, eRaw] = id.split(':');
    const seria = jeToSerialPodlaId && sRaw ? parseInt(sRaw) : undefined;
    const epizoda = jeToSerialPodlaId && eRaw ? parseInt(eRaw) : undefined;
    const vlastnyTyp = jeToSerialPodlaId ? 'series' : 'movie';

    // 1. ZÍSKAME NÁZVY A ROK a META
    const metaData = await ziskatVsetkyNazvyARok(imdbId, vlastnyTyp, userConfig.tmdb);
    const suroveNazvy = metaData?.nazvy || [];
    const vydanyRok = metaData?.rok;
    const metaInfo = metaData?.meta;

    if (!suroveNazvy.length) {
        logWarn(`No metadata names found. Returning empty list.`);
        return res.json({ streams: [] });
    }

    const zakladneNazvy = [];
    suroveNazvy.forEach(t => {
        let cistyT = t.replace(/\.\s*/g, ' ').replace(/TV Mini[ \-]?Series/gi, '').trim();
        zakladneNazvy.push(cistyT);
        if (cistyT.includes(':')) {
            zakladneNazvy.push(cistyT.split(':')[0].trim());
        }
    });

    const unikatneNazvy = [...new Set(zakladneNazvy)];
    const dotazy = new Set();

    // 2. ČSFD LINK (Snažíme sa použiť primárne český názov z metadát pre ČSFD vyhľadávanie)
    const hlavnyNazov = metaData?.meta?.titleOriginal || unikatneNazvy[0];
    const csfdLink = await ziskatCsfdUrl(imdbId, hlavnyNazov, vydanyRok, vlastnyTyp);
    if (csfdLink) {
        dotazy.add(csfdLink);
    }

    // 3. Fallback na klasické textové hľadanie
    unikatneNazvy.forEach(zaklad => {
        const bezDia = odstranDiakritiku(zaklad);
        const kratky = skratNazov(bezDia, 3);

        if (vlastnyTyp === 'series' && seria !== undefined && epizoda !== undefined) {
            const epTag = `S${String(seria).padStart(2, '0')}E${String(epizoda).padStart(2, '0')}`;
            const epTag2 = `${seria}x${String(epizoda).padStart(2, '0')}`;
            const sTag1 = `S${String(seria).padStart(2, '0')}`;
            const sTag2 = `${seria}.série`;
            const sTag3 = `${seria}. série`;

            dotazy.add(`${bezDia} ${epTag}`);
            dotazy.add(`${zaklad} ${epTag}`);
            dotazy.add(`${bezDia} ${sTag3}`);
            dotazy.add(`${kratky} ${sTag3}`);
            dotazy.add(`${bezDia} ${sTag2}`);
            dotazy.add(`${kratky} ${sTag2}`);
            dotazy.add(`${bezDia} ${sTag1}`);
            dotazy.add(`${kratky} ${sTag1}`);
            dotazy.add(`${bezDia} ${epTag2}`);
            dotazy.add(`${kratky} ${epTag2}`);
            dotazy.add(bezDia);
            dotazy.add(kratky);
        } else {
            [zaklad, bezDia, kratky].forEach(b => {
                if (!b.trim()) return;
                dotazy.add(b);
            });
        }
    });

    let torrenty = [];
    let pokus = 1;
    const videnieTorrentIds = new Set();
    let uspesneNajdeneCezCsfd = false;

    for (const d of dotazy) {
        logInfo(`Search attempt ${pokus}: ${d}`);
        const najdene = await hladatTorrenty(d, userAxios);

        let pocetNovych = 0;
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
                pocetNovych++;
            }
        }

        if (d === csfdLink && torrenty.length > 0) {
            logSuccess(`Nájdené cez ČSFD Link. Mám ${torrenty.length} výsledkov.`);
            uspesneNajdeneCezCsfd = true;
        }

        if (uspesneNajdeneCezCsfd && torrenty.length > 30) {
            logInfo(`Dostatok torrentov nájdených alebo použitý presný link, preskakujem ďalšie dotazy.`);
            break;
        }

        if (pokus >= 10) break;
        pokus++;
    }

    if (!uspesneNajdeneCezCsfd) {
        const predNameFiltrom = torrenty.length;
        torrenty = torrenty.filter(t => {
            let rawName = odstranDiakritiku(t.name).toLowerCase().replace(/\[stiahni si\]/i, '').trim();
            const prefixRe = /^\[?(filmy|film|serialy|serial|seriál|seria|serie|dokumenty|dokument|tv|kreslene|kreslené|anime)\]?/i;
            const junkRe = /[\[\-\_](1080p|720p|2160p|4k|hdr|web-?dl|webrip|brrip|bluray|dvdrip|tvrip|cz|sk|en)[\]\-\_]/i;
            let prev;
            do {
                prev = rawName;
                rawName = rawName.replace(prefixRe, '').trim();
                rawName = rawName.replace(junkRe, '').trim();
            } while (rawName !== prev);

            for (const nazov of unikatneNazvy) {
                const hl = odstranDiakritiku(nazov).toLowerCase().trim();
                if (!hl) continue;
                const escaped = hl.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                if (new RegExp(`^${escaped}`, 'i').test(rawName)) return true;
            }
            return false;
        });
        logInfo(`Title accuracy filter complete. Remaining: ${torrenty.length} (filtered out ${predNameFiltrom - torrenty.length} unrelated titles)`);
    }

    if (seria !== undefined) {
        logInfo(`Filtering series torrents for S${seria} E${epizoda}...`);
        const predFiltrom = torrenty.length;
        torrenty = torrenty.filter(t => torrentSedisSeriou(t.name, seria) && torrentSediSEpizodou(t.name, seria, epizoda));
        logInfo(`Series filter complete. Remaining: ${torrenty.length} (filtered out ${predFiltrom - torrenty.length})`);
    }

    const execLimit = pLimit(5);
    logInfo(`Creating streams for ${torrenty.length} torrents (Max concurrency 5)...`);

    let streamy = (await Promise.all(
        torrenty.map(t => execLimit(() => vytvoritStream(t, seria, epizoda, userAxios, metaInfo)))
    )).filter(Boolean);

    if (userConfig.torbox && streamy.length > 0) {
        logInfo(`TorBox enabled. Preparing streams for TorBox playback...`);
        const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean);
        const torboxCache = await overitTorboxCache(hasheKONTROLA, userConfig.torbox);

        streamy = streamy.map(stream => {
            const hash = stream.infoHash.toLowerCase();
            const jeCached = torboxCache[hash] === true;
            const staraKategoria = stream.name.split('] ')[1];

            if (jeCached) {
                stream.name = `[TB] [SKT] ${staraKategoria}`;
                // ZJEDNOTENA PROXY ROUTA - Preposielame vzdy index suboru!
                stream.url = `${PUBLIC_URL}/${config}/playproxy/${hash}/${stream.fileIdx !== undefined ? stream.fileIdx : 0}`;
            } else {
                stream.name = `[TB⬇] [SKT] ${staraKategoria}`;
                stream.url = `${PUBLIC_URL}/${config}/download/${hash}/${stream.sktId}`;
            }

            delete stream.infoHash;
            delete stream.fileIdx;
            delete stream.sktId;
            return stream;
        });

        streamy = streamy.sort((a, b) => {
            const aCached = a.name.includes('[TB]') ? 1 : 0;
            const bCached = b.name.includes('[TB]') ? 1 : 0;
            return bCached - aCached;
        });

        logSuccess(`TorBox stream formatting complete. Cached: ${streamy.filter(s => s.name.includes('[TB]')).length}, Uncached: ${streamy.filter(s => s.name.includes('[TB⬇]')).length}`);
    }

    const trvanie = Date.now() - startCas;
    logSuccess(`Stream request finished in ${trvanie}ms. Returning ${streamy.length} streams to Stremio.`);

    const maUncachedStreamy = streamy.some(s => s.name && s.name.includes('[TB⬇]'));
    const cacheMaxAge = maUncachedStreamy ? 60 : 3600;

    res.setHeader('Cache-Control', `max-age=${cacheMaxAge}, stale-while-revalidate=${cacheMaxAge}, stale-if-error=${cacheMaxAge}`);

    return res.json({ streams: streamy });
});

// --- ZJEDNOTENÁ TORBOX PROXY ROUTA PRE VŠETKO (FILMY AJ SERIÁLY) ---
app.all('/:config/playproxy/:hash/:fileIdx', async (req, res) => {
    if (req.method === 'HEAD') {
        res.status(200);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        return res.end();
    }

    const { hash, fileIdx, config } = req.params;
    const redirectPlaceholder = () => res.redirect(302, '/info-video');

    logApi(`TORBOX PROXY | Hash: ${hash} | Request for file ID/Index: ${fileIdx}`);

    if (!hash || fileIdx === undefined) return redirectPlaceholder();

    const userConfig = decodeConfig(config);
    if (!userConfig || !userConfig.torbox) return redirectPlaceholder();

    const TORBOX_API_KEY = userConfig.torbox;
    const hashLower = hash.toLowerCase();

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function getTorrentObjByHashOrId(hashLower, torrentIdMaybe) {
        const tbRes = await axios.get('https://api.torbox.app/v1/api/torrents/mylist', {
            headers: { 'Authorization': `Bearer ${TORBOX_API_KEY}` },
            timeout: 15000
        });
        const list = tbRes.data?.data;
        const arr = Array.isArray(list) ? list : (list ? [list] : []);
        if (torrentIdMaybe) {
            const byId = arr.find(t => t?.id == torrentIdMaybe);
            if (byId) return byId;
        }
        return arr.find(t => t?.hash && String(t.hash).toLowerCase() === hashLower) || null;
    }

    try {
        // 1. Zisti či ho máme v Torboxe
        let tbTorrent = await getTorrentObjByHashOrId(hashLower, null);
        let torrentId = tbTorrent?.id || null;

        // 2. Ak nie, vytvoríme ho
        if (!torrentId) {
            const formData = new FormData();
            formData.append('magnet', `magnet:?xt=urn:btih:${hash}`);
            const addRes = await axios.post('https://api.torbox.app/v1/api/torrents/createtorrent', formData, {
                headers: { 'Authorization': `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() },
                timeout: 15000
            });
            torrentId = addRes.data?.data?.torrent_id || addRes.data?.data?.torrentId || null;
        }

        if (!torrentId) return redirectPlaceholder();

        // 3. Počkáme, kým sa načítajú "files"
        for (let i = 0; i < 4; i++) {
            tbTorrent = await getTorrentObjByHashOrId(hashLower, torrentId);
            if (tbTorrent?.files?.length) break;
            await sleep(2000);
        }

        if (!tbTorrent?.files?.length) return redirectPlaceholder();

        const files = Array.isArray(tbTorrent.files) ? tbTorrent.files : [];
        if (files.length === 0) return redirectPlaceholder();

        // 4. Nájdeme súbor podľa presného indexu ktorý sme vypočítali priamo na SKTorrente!
        // TorBox priraďuje 'id' súboru presne podľa .torrent indexu (ale preistotu ho hladáme stringovo/číselne)
        let targetFile = files.find(f => f.id != null && parseInt(f.id, 10) === parseInt(fileIdx, 10));

        // Ak zlyhá hľadanie podľa indexu (veľmi ojedinelý prípad v Torboxe), zoberieme najväčšie video ako fallback
        if (!targetFile) {
            logWarn(`TORBOX PROXY | File ID ${fileIdx} nenájdené. Používam fallback na najväčšie video.`);
            const videoFiles = files.filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.name));
            videoFiles.sort((a, b) => (b.size || 0) - (a.size || 0));
            targetFile = videoFiles[0];
        }

        if (!targetFile || targetFile.id === undefined) {
            logWarn(`TORBOX PROXY | Nepodarilo sa nájsť video pre prehranie.`);
            return redirectPlaceholder();
        }

        logSuccess(`TORBOX PROXY | Vybraný súbor ID: ${targetFile.id} | Názov: ${targetFile.name}`);

        // 5. Presmerovanie na Torbox video stream
        const url = `https://api.torbox.app/v1/api/torrents/requestdl?token=${encodeURIComponent(TORBOX_API_KEY)}&torrent_id=${encodeURIComponent(torrentId)}&file_id=${encodeURIComponent(targetFile.id)}&zip_link=false&redirect=true`;
        return res.redirect(302, url);

    } catch (err) {
        logError("TorBox proxy error:", err);
        return redirectPlaceholder();
    }
});


// DOWNLOAD / CACHE-ADD ROUTER
app.get('/:config/download/:hash/:sktId', async (req, res) => {
    const { hash, sktId, config } = req.params;

    const userConfig = decodeConfig(config);
    if (!userConfig || !userConfig.uid || !userConfig.pass) {
        return res.status(400).send("Chyba Configu");
    }
    if (!userConfig.torbox) {
        return res.status(400).send("Chyba Torbox Key");
    }

    const TORBOX_API_KEY = userConfig.torbox;
    const userAxios = getFastAxios(userConfig);

    try {
        const torrentUrl = `${BASE_URL}/torrent/download.php?id=${sktId}`;
        const torrentBuffer = await stiahnutSurovyTorrent(torrentUrl, userAxios);

        if (!torrentBuffer) return res.status(500).send("Nepodarilo sa stiahnuť .torrent súbor.");

        const formData = new FormData();
        formData.append('file', torrentBuffer, { filename: `${hash}.torrent`, contentType: 'application/x-bittorrent' });

        await axios.post('https://api.torbox.app/v1/api/torrents/createtorrent', formData, {
            headers: { 'Authorization': `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() },
            timeout: 15000
        });

        return res.redirect(302, '/info-video');
    } catch (err) {
        logError("TorBox API download/upload error", err);
        res.status(500).send("Chyba API stahovania TorBox.");
    }
});

// PLACEHOLDER VIDEO ROUTER
app.get('/info-video', (req, res) => {
    res.sendFile(path.join(__dirname, 'stahuje-sa.mp4'));
});

// --- SERVER START ---
app.listen(PORT, () => {
    console.log(`🚀 SKTorrent Multi-User beží na portu ${PORT}`);
    console.log(`🌐 Public URL: ${PUBLIC_URL}`);
});
