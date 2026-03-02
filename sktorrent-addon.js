// SKTorrent Addon v1.4.0 + TORBOX + MULTI-USER CONFIG
const { addonBuilder } = require("stremio-addon-sdk");
const { decode } = require("entities");
const axios = require("axios");
const cheerio = require("cheerio");
const bencode = require("bncode");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const express = require("express");
const FormData = require("form-data");
const path = require("path");
const cors = require("cors"); 

const PORT = process.env.PORT || 7000; 
const PUBLIC_URL = "https://b8ab33049f87-sk-cztorrent-addon.baby-beamup.club"; 
const BASE_URL = "https://sktorrent.eu"; 
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;

const agentOptions = { keepAlive: true, maxSockets: 50 };

// ===================================================================
// CACHE a CONCURRENCY SYSTÉM
// ===================================================================
const cache = new Map();
async function withCache(key, ttlMs, fetcher) {
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expires) return cached.data;
    
    const data = await fetcher();
    if (data && (!Array.isArray(data) || data.length > 0) && Object.keys(data).length !== 0) {
        cache.set(key, { data, expires: Date.now() + ttlMs });
    }
    return data;
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

// ===================================================================
// POMOCNÉ FUNKCIE PRE CONFIG
// ===================================================================
function decodeConfig(configString) {
    try {
        if (!configString || configString.includes(".json")) return null;
        
        let base64 = configString.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) {
            base64 += '=';
        }
        
        const decoded = Buffer.from(base64, 'base64').toString('utf8');
        return JSON.parse(decoded);
    } catch (e) {
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

// ===================================================================
// POMOCNÉ TEXTOVÉ FUNKCIE
// ===================================================================
const langToFlag = {
    CZ: "🇨🇿", SK: "🇸🇰", EN: "🇬🇧", US: "🇺🇸",
    DE: "🇩🇪", FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸",
    RU: "🇷🇺", PL: "🇵🇱", HU: "🇭🇺", JP: "🇯🇵"
};

function odstranDiakritiku(str) { return str.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function skratNazov(title, pocetSlov = 3) { return title.split(/\s+/).slice(0, pocetSlov).join(" "); }

// ===================================================================
// TORBOX: OVERENIE CACHE
// ===================================================================
async function overitTorboxCache(infoHashes, torboxKey) {
    if (!torboxKey || infoHashes.length === 0) return {};
    
    const unikatneHashe = [...new Set(infoHashes)].map(h => h.toLowerCase());
    const hashString = unikatneHashe.sort().join(",");
    
    return withCache(`torbox:${hashString}`, 600000, async () => { 
        try {
            const res = await axios.get(`https://api.torbox.app/v1/api/torrents/checkcached`, {
                params: { hash: unikatneHashe.join(","), format: "list" },
                headers: { "Authorization": `Bearer ${torboxKey}` },
                timeout: 5000
            });
            
            const cacheMap = {};
            if (res.data && res.data.success && res.data.data) {
                const poleDat = Array.isArray(res.data.data) ? res.data.data : [res.data.data];
                poleDat.forEach(item => {
                    if (item.hash) cacheMap[item.hash.toLowerCase()] = true; 
                });
            }
            return cacheMap;
        } catch (error) {
            return {};
        }
    });
}

// ===================================================================
// FILTRE PRE SERIÁLY
// ===================================================================
function torrentSedisSeriou(nazovTorrentu, seria) {
    if (/S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(nazovTorrentu) || /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(nazovTorrentu)) return true; 
    const serieMatch = nazovTorrentu.match(/\b(\d+)\.Serie\b/i);
    if (serieMatch && parseInt(serieMatch[1]) !== seria) return false;
    const seasonMatch = nazovTorrentu.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1]) !== seria) return false;
    const sMatch = nazovTorrentu.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1]) !== seria) return false;
    return true;
}

function torrentSediSEpizodou(nazov, seria, epizoda) {
    const seriaStr = String(seria).padStart(2, "0");
    const epStr = String(epizoda).padStart(2, "0");

    const najdeneE = nazov.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})`, "i"));
    const najdeneX = nazov.match(new RegExp(`${seria}x(\\d{1,3})`, "i"));
    let toMaZluEpizodu = false;
    
    if (najdeneE && parseInt(najdeneE[1]) !== parseInt(epizoda)) toMaZluEpizodu = true;
    if (najdeneX && parseInt(najdeneX[1]) !== parseInt(epizoda)) toMaZluEpizodu = true;

    const jeToRozsahE = nazov.match(/E(\d{1,3})[._-]?E?(\d{1,3})/i);
    if (jeToRozsahE) {
        const zaciatokE = parseInt(jeToRozsahE[1]);
        const koniecE = parseInt(jeToRozsahE[2]);
        if (epizoda >= zaciatokE && epizoda <= koniecE) toMaZluEpizodu = false; 
    }

    if (toMaZluEpizodu) return false; 

    if (new RegExp(`S${seriaStr}[._-]?E${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b${seria}x${epStr}\\b`, "i").test(nazov)) return true;

    const rozsahEpizod = nazov.match(/E(\d{1,3})[._-]?E?(\d{1,3})/i) || nazov.match(/(?:Dily?|Parts?|Epizody?|Eps?|Ep)?[._\s]*(\d{1,3})\s*[-–]\s*(\d{1,3})/i);
    if (rozsahEpizod) {
        const zaciatok = parseInt(rozsahEpizod[1] || rozsahEpizod[2]);
        const koniec = parseInt(rozsahEpizod[2] || rozsahEpizod[3]);
        if (epizoda >= zaciatok && epizoda <= koniec) return true;
    }

    const rozsahSerii = nazov.match(/S(\d{1,2})\s*[-–]\s*S?(\d{1,2})/i) || 
                        nazov.match(/(?:Season|S[eé]rie)\s*(\d{1,2})\s*[-–]\s*(\d{1,2})/i) ||
                        nazov.match(/(\d{1,2})\.\s*[-–]\s*(\d{1,2})\.\s*s[eé]rie/i);
    if (rozsahSerii) {
        const zaciatokSer = parseInt(rozsahSerii[1]);
        const koniecSer = parseInt(rozsahSerii[2]);
        if (seria >= zaciatokSer && seria <= koniecSer) return true;
    }

    const jeToCelaSeria = new RegExp(`\\b${seria}\\.\\s*s[eé]rie\\b`, "i").test(nazov) || 
                          new RegExp(`\\bSeason\\s*${seria}\\b`, "i").test(nazov) || 
                          new RegExp(`\\bS${seriaStr}\\b`, "i").test(nazov) ||
                          /\b(Pack|Komplet|Complete|Vol|Volume)\b/i.test(nazov);
                          
    return jeToCelaSeria;
}

// ===================================================================
// Získanie názvov (Súbežne TMDB + Cinemeta)
// ===================================================================
async function ziskatVsetkyNazvy(imdbId, vlastnyTyp, tmdbKey) {
    return withCache(`names:${imdbId}`, 21600000, async () => { 
        const nazvy = new Set();
        const tmdbTyp = vlastnyTyp === "series" ? "tv" : "movie";
        
        const promises = [
            axios.get(`https://v3-cinemeta.strem.io/meta/${vlastnyTyp}/${imdbId}.json`, { timeout: 4000 }).catch(() => null)
        ];

        if (tmdbKey) {
            promises.push(
                axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, { params: { api_key: tmdbKey, external_source: "imdb_id" }, timeout: 4000 }).catch(() => null)
            );
        }

        const [cineRes, tmdbRes] = await Promise.all(promises);

        if (cineRes && cineRes.data?.meta) {
            const m = cineRes.data.meta;
            if (m.name) nazvy.add(decode(m.name).trim());
            if (m.original_name) nazvy.add(decode(m.original_name).trim());
            if (m.aliases) m.aliases.forEach(a => nazvy.add(decode(a).trim()));
        }

        if (tmdbRes && tmdbRes.data) {
            let tmdbId = null;
            if (vlastnyTyp === "series" && tmdbRes.data.tv_results?.length > 0) {
                tmdbId = tmdbRes.data.tv_results[0].id;
                nazvy.add(tmdbRes.data.tv_results[0].name);
            } else if (vlastnyTyp === "movie" && tmdbRes.data.movie_results?.length > 0) {
                tmdbId = tmdbRes.data.movie_results[0].id;
                nazvy.add(tmdbRes.data.movie_results[0].title);
            }

            if (tmdbId) {
                try {
                    const trans = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (trans.data?.translations) {
                        trans.data.translations.forEach(tr => {
                            const m = (tr.data || {}).title || (tr.data || {}).name;
                            if (m && ["cs", "sk", "en"].includes(tr.iso_639_1)) nazvy.add(m);
                        });
                    }
                } catch (e) { /* ignore */ }
            }
        }

        if (imdbId === "tt27543632") { nazvy.add("Pomocnice"); nazvy.add("Pomocníčka"); }
        if (imdbId === "tt0903747")  { nazvy.add("Perníkový táta"); nazvy.add("Pernikovy tata"); }
        if (imdbId === "tt27497448") { nazvy.add("Rytíř sedmi království"); nazvy.add("Rytier siedmich kráľovstiev"); }

        return [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
    });
}

// ===================================================================
// Hľadanie a spracovanie Torrentov
// ===================================================================
async function hladatTorrenty(dotaz, userAxios) {
    if (!dotaz || dotaz.trim().length < 2) return [];
    
    return withCache(`search:${dotaz}`, 600000, async () => {
        try {
            const res = await userAxios.get(SEARCH_URL, { params: { search: dotaz, category: 0 } });
            const $ = cheerio.load(res.data);
            const vysledky = [];

            $('a[href^="details.php"] img').each((i, img) => {
                const rodic = $(img).closest("a");
                const bunka = rodic.closest("td");
                const text = bunka.text().replace(/\s+/g, " ").trim();
                const odkaz = rodic.attr("href") || "";
                const nazov = rodic.attr("title") || "";
                const torrentId = odkaz.split("id=").pop();
                const kategoria = bunka.find("b").first().text().trim();
                const velkostMatch = text.match(/Velkost\s([^|]+)/i);
                const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);

                if (!kategoria.toLowerCase().includes("film") && !kategoria.toLowerCase().includes("seri") &&
                    !kategoria.toLowerCase().includes("dokum") && !kategoria.toLowerCase().includes("tv")) return;

                vysledky.push({
                    name: nazov, id: torrentId,
                    size: velkostMatch ? velkostMatch[1].trim() : "?",
                    seeds: seedMatch ? parseInt(seedMatch[1]) : 0,
                    category: kategoria,
                    downloadUrl: `${BASE_URL}/torrent/download.php?id=${torrentId}`
                });
            });

            return vysledky.sort((a, b) => b.seeds - a.seeds); 
        } catch (chyba) {
            return [];
        }
    });
}

async function stiahnutTorrentData(url, userAxios) {
    return withCache(`torrent:${url}`, 86400000, async () => { 
        try {
            const res = await userAxios.get(url, { responseType: "arraybuffer" });
            const bufferString = res.data.toString("utf8", 0, 50);
            if (bufferString.includes("<html") || bufferString.includes("<!DOC")) return null;

            const torrent = bencode.decode(res.data);
            const info = bencode.encode(torrent.info);
            const infoHash = crypto.createHash("sha1").update(info).digest("hex");

            let subory = [];
            if (torrent.info.files) {
                subory = torrent.info.files.map((file, index) => {
                    const cesta = (file["path.utf-8"] || file.path || []).map(p => p.toString()).join("/");
                    return { path: cesta, index };
                });
            } else {
                const nazov = (torrent.info["name.utf-8"] || torrent.info.name || "").toString();
                subory = [{ path: nazov, index: 0 }];
            }

            return { infoHash, files: subory };
        } catch (chyba) {
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

async function vytvoritStream(t, seria, epizoda, userAxios) {
    const torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
    if (!torrentData) return null;

    const langZhody = t.name.match(/\b([A-Z]{2})\b/g) || [];
    const vlajky = langZhody.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean);
    const vlajkyText = vlajky.length ? `\n${vlajky.join(" / ")}` : "";

    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    let streamObj = {
        title: `${cistyNazov}\n👤 ${t.seeds}  📀 ${t.size}  🌐 SKTorrent${vlajkyText}`,
        name: `SKT\n${t.category.toUpperCase()}`,
        behaviorHints: { bingeGroup: cistyNazov },
        infoHash: torrentData.infoHash,
        sktId: t.id
    };

    if (seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));

        if (videoSubory.length === 0) return null;
        let najdenyIndex = -1;

        const epCislo = parseInt(epizoda);
        const epStr = String(epCislo).padStart(2, "0");
        const seriaStr = String(seria).padStart(2, "0");

        if (videoSubory.length === 1) {
            const nazovSuboru = videoSubory[0].path;
            const najdeneESubor = nazovSuboru.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})`, "i")) || 
                                  nazovSuboru.match(new RegExp(`\\b${seria}x(\\d{1,3})`, "i")) ||
                                  nazovSuboru.match(new RegExp(`Ep(?:isode)?[._\\s]*(\\d{1,3})\\b`, "i"));
            
            if (najdeneESubor && parseInt(najdeneESubor[1]) !== epCislo) return null;
            najdenyIndex = videoSubory[0].index;
        } else {
            const epRegexy = [
                new RegExp(`\\b${seria}x${epStr}\\b`, "i"),
                new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"),
                new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"),
                new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"),
                new RegExp(`\\b0*${epCislo}\\.(?:mp4|mkv|avi|m4v)$`, "i"),
                new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"),
                new RegExp(`(^|/)[\\s._-]*0*${epCislo}[\\s._-]+.*\\.(?:mp4|mkv|avi|m4v)$`, "i")
            ];

            for (const reg of epRegexy) {
                const zhoda = videoSubory.find(f => reg.test(f.path));
                if (zhoda) { najdenyIndex = zhoda.index; break; }
            }
        }

        if (najdenyIndex === -1) return null;
        streamObj.fileIdx = najdenyIndex;
    }

    return streamObj;
}

// ===================================================================
// VLASTNÝ EXPRESS SERVER BEZ `getRouter` Z SDK
// ===================================================================
const app = express();
app.use(cors()); 

app.use((req, res, next) => {
    console.log(`[HTTP REQUEST] -> Typ: ${req.method} | URL: ${req.originalUrl} | IP: ${req.ip}`);
    next(); 
});


// --- Web UI ---
app.get(['/', '/configure'], (req, res) => {
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
            input { width: 100%; padding: 10px; margin-top: 5px; background: #333; border: 1px solid #444; color: white; border-radius: 4px; box-sizing: border-box;}
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
            
            <label>SKTorrent UID (Cookie s názvom uid)</label>
            <input type="text" id="uid" placeholder="Napr. 123987" required>
            
            <label>SKTorrent pass (Tiež z cookies s názvom pass)</label>
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
                    tmdb: document.getElementById('tmdb').value
                };
                
                if(!config.uid || !config.pass) {
                    alert('Prosím, vyplň aspoň UID a Heslo pre SKTorrent.'); 
                    return;
                }
                
                try {
                    var jsonString = JSON.stringify(config);
                    var encodedConfig = btoa(unescape(encodeURIComponent(jsonString)));
                    
                    var currentUrl = "${PUBLIC_URL}"; 
                    var finalHttpUrl = currentUrl + '/' + encodedConfig + '/manifest.json';
                    
                    document.getElementById('result-box').style.display = 'block';
                    document.getElementById('generated-url').value = finalHttpUrl;
                } catch (error) {
                    alert('Chyba pri generovaní kódu.');
                    console.error(error);
                }
            }

            function copyUrl() {
                var urlText = document.getElementById('generated-url');
                urlText.select();
                document.execCommand('copy');
                var copyBtn = document.querySelector('.copy-btn');
                copyBtn.innerText = "✅ Skopírované!";
                setTimeout(function() { copyBtn.innerText = "📋 Kopírovať do schránky"; }, 2000);
            }

            function openStremio() {
                var httpUrl = document.getElementById('generated-url').value;
                var stremioUrl = httpUrl.replace(/^https?:\\/\\//i, 'stremio://');
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
        id: "org.stremio.skcztorrent.addon", 
        version: "1.5.1",
        name: "SKTorrent + TorBox (Multi-User)",
        description: "SKTorrent s TorBox prehrávaním",
        types: ["movie", "series"],
        catalogs: [],
        resources: ["stream"],
        idPrefixes: ["tt"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    });
};

app.get('/manifest.json', handleManifest);
app.get('/:config/manifest.json', handleManifest);


// --- Catalog fallback ---
app.get('/:config?/catalog/:type/:id.json', (req, res) => {
    res.json({ metas: [] });
});

// --- Stream Route ---
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const { type: aplikaciaTyp, id, config } = req.params;
    
    const userConfig = decodeConfig(config);
    const activeUid = userConfig?.user_id || userConfig?.uid;
    const activePass = userConfig?.password || userConfig?.pass;
    const activeTorbox = userConfig?.tb_key || userConfig?.torbox;
    const activeTmdb = userConfig?.tm_key || userConfig?.tmdb;

    if (!activeUid || !activePass) {
        return res.json({ streams: [], error: "Neplatná alebo chýbajúca konfigurácia. Prosím kliknite na ozubené koliesko." });
    }
    
    const normalizedConfig = { uid: activeUid, pass: activePass, torbox: activeTorbox, tmdb: activeTmdb };
    const userAxios = getFastAxios(normalizedConfig);
    console.log(`\n====== 🎮 Hľadám pre UID: ${normalizedConfig.uid} | id='${id}' ======`);


    const jeToSerialPodlaId = id.includes(":");
    const [imdbId, sRaw, eRaw] = id.split(":");
    const seria = (jeToSerialPodlaId && sRaw) ? parseInt(sRaw) : undefined;
    const epizoda = (jeToSerialPodlaId && eRaw) ? parseInt(eRaw) : undefined;
    const vlastnyTyp = jeToSerialPodlaId ? "series" : "movie";

    const suroveNazvy = await ziskatVsetkyNazvy(imdbId, vlastnyTyp, userConfig.tmdb);
    if (!suroveNazvy.length) return res.json({ streams: [] });

    const zakladneNazvy = [];
    suroveNazvy.forEach(t => {
        let cistyT = t.replace(/\(.*?\)/g, "").replace(/TV (Mini )?Series/gi, "").trim();
        zakladneNazvy.push(cistyT);
        if (cistyT.includes(":")) zakladneNazvy.push(cistyT.split(":")[0].trim());
    });
    const unikatneNazvy = [...new Set(zakladneNazvy)];

    const dotazy = new Set();
    unikatneNazvy.forEach(zaklad => {
        const bezDia = odstranDiakritiku(zaklad);
        const kratky = skratNazov(bezDia, 3); 

        if (vlastnyTyp === "series" && seria !== undefined && epizoda !== undefined) {
            const epTag  = ` S${String(seria).padStart(2, "0")}E${String(epizoda).padStart(2, "0")}`; 
            const epTag2 = ` ${seria}x${String(epizoda).padStart(2, "0")}`; 
            const sTag1  = ` S${String(seria).padStart(2, "0")}`; 
            const sTag2  = ` ${seria}.série`; 
            const sTag3  = ` ${seria}. série`; 

            dotazy.add(bezDia + epTag);
            dotazy.add(zaklad + epTag);
            dotazy.add(bezDia + sTag3); 
            dotazy.add(kratky + sTag3); 
            dotazy.add(bezDia + sTag2); 
            dotazy.add(kratky + sTag2); 
            dotazy.add(bezDia + sTag1); 
            dotazy.add(kratky + sTag1); 
            dotazy.add(bezDia + epTag2);
            dotazy.add(kratky + epTag2);
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

    for (const d of dotazy) { 
        const najdene = await hladatTorrenty(d, userAxios);
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
            }
        }
        if (torrenty.length >= 8) break; 
        if (pokus > 8) break; 
        pokus++;
    }

    if (seria !== undefined) {
        torrenty = torrenty.filter(t => torrentSedisSeriou(t.name, seria) && torrentSediSEpizodou(t.name, seria, epizoda));
    }

    const execLimit = pLimit(5);
    let streamy = (await Promise.all(
        torrenty.map(t => execLimit(() => vytvoritStream(t, seria, epizoda, userAxios)))
    )).filter(Boolean);

    if (userConfig.torbox && streamy.length > 0) {
        const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean); 
        const torboxCache = await overitTorboxCache(hasheKONTROLA, userConfig.torbox);

        streamy = streamy.map(stream => {
            const hash = stream.infoHash.toLowerCase();
            const jeCached = torboxCache[hash] === true;
            const staraKategoria = stream.name.split("\n")[1] || "";
            
            if (jeCached) {
                stream.name = `[TB ⚡] SKT\n${staraKategoria}`;
                const proxySeria = seria || "1";
                const proxyEpizoda = epizoda || "1";
                
                stream.url = `${PUBLIC_URL}/${config}/play/${hash}/${proxySeria}/${proxyEpizoda}`;
                
                delete stream.infoHash;
                delete stream.fileIdx;
            } else {
                stream.name = `[TB ⏳] SKT\n${staraKategoria}`;
                
                stream.url = `${PUBLIC_URL}/${config}/download/${hash}/${stream.sktId}`;
                
                delete stream.infoHash;
                delete stream.fileIdx;
                delete stream.sktId;
            }

            return stream;
        });

        streamy.sort((a, b) => {
            const aCached = a.name.includes("⚡") ? 1 : 0;
            const bCached = b.name.includes("⚡") ? 1 : 0;
            return bCached - aCached;
        });
    } else {
        // Fallback pre ostatnych 
    }

    return res.json({ streams: streamy });
});

// ===================================================================
// TORBOX PROXY ROUTER
// ===================================================================

app.get("/:config/play/:hash/:seria/:epizoda", async (req, res) => {
    const { hash, seria, epizoda, config } = req.params;
    const userConfig = decodeConfig(config);
    if (!userConfig || !userConfig.torbox) return res.status(400).send("Chýba TorBox klúč");
    const TORBOX_API_KEY = userConfig.torbox;

    try {
        const tbTorrentsRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
            headers: { "Authorization": `Bearer ${TORBOX_API_KEY}` }
        });
        
        let torrentId = null;
        let najdenyTorrentObj = null;

        if (tbTorrentsRes.data && tbTorrentsRes.data.data) {
            const zoznam = Array.isArray(tbTorrentsRes.data.data) ? tbTorrentsRes.data.data : [tbTorrentsRes.data.data];
            najdenyTorrentObj = zoznam.find(t => t.hash && t.hash.toLowerCase() === hash.toLowerCase());
            if (najdenyTorrentObj) torrentId = najdenyTorrentObj.id;
        }

        if (!torrentId) {
            const formData = new FormData();
            formData.append("magnet", `magnet:?xt=urn:btih:${hash}`);

            const addRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
                headers: { "Authorization": `Bearer ${TORBOX_API_KEY}`, ...formData.getHeaders() }
            });
            torrentId = addRes.data?.data?.torrent_id;
            await new Promise(r => setTimeout(r, 3000));
            
            const tbRefreshRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                headers: { "Authorization": `Bearer ${TORBOX_API_KEY}` }
            });
            if (tbRefreshRes.data && tbRefreshRes.data.data) {
                const zoznamRefresh = Array.isArray(tbRefreshRes.data.data) ? tbRefreshRes.data.data : [tbRefreshRes.data.data];
                najdenyTorrentObj = zoznamRefresh.find(t => t.id === torrentId);
            }
        }

        let spravneFileId = null;
        
        if (najdenyTorrentObj && najdenyTorrentObj.files && seria && epizoda) {
            const epCislo = parseInt(epizoda);
            const epStr = String(epCislo).padStart(2, "0");
            const seriaStr = String(seria).padStart(2, "0");

            const epRegexy = [
                new RegExp(`\\b${seria}x${epStr}\\b`, "i"), 
                new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"), 
                new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"), 
                new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"), 
                new RegExp(`\\b0*${epCislo}\\.(?:mp4|mkv|avi|m4v)$`, "i") 
            ];

            const videoSúbory = najdenyTorrentObj.files.filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.name));

            for (const reg of epRegexy) {
                const zhoda = videoSúbory.find(f => reg.test(f.name));
                if (zhoda) { spravneFileId = zhoda.id; break; }
            }
            
            if (spravneFileId === null && videoSúbory.length > 0) {
                videoSúbory.sort((a, b) => b.size - a.size);
                spravneFileId = videoSúbory[0].id;
            }
        }

        if (spravneFileId === null) spravneFileId = 0;

        const downloadRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl", {
            params: { token: TORBOX_API_KEY, torrent_id: torrentId, file_id: spravneFileId, zip_link: false },
            headers: { "Authorization": `Bearer ${TORBOX_API_KEY}` }
        });

        const directLink = downloadRes.data?.data;
        if (directLink) {
            res.redirect(302, directLink);
        } else {
            res.status(404).send("Torbox nevrátil URL.");
        }
    } catch (err) {
        res.status(500).send("Chyba proxy servera.");
    }
});

app.get("/:config/download/:hash/:sktId", async (req, res) => {
    const { hash, sktId, config } = req.params;
    const userConfig = decodeConfig(config);
    
    if (!userConfig || !userConfig.uid || !userConfig.pass) return res.status(400).send("Chyba Configu");
    if (!userConfig.torbox) return res.status(400).send("Chyba Torbox Key");

    const TORBOX_API_KEY = userConfig.torbox;
    const userAxios = getFastAxios(userConfig);

    try {
        const torrentUrl = `${BASE_URL}/torrent/download.php?id=${sktId}`;
        const torrentBuffer = await stiahnutSurovyTorrent(torrentUrl, userAxios);

        if (!torrentBuffer) {
            return res.status(500).send("Nepodarilo sa stiahnuť .torrent súbor.");
        }

        const formData = new FormData();
        formData.append("file", torrentBuffer, {
            filename: `${hash}.torrent`,
            contentType: "application/x-bittorrent"
        });

        await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
            headers: {
                "Authorization": `Bearer ${TORBOX_API_KEY}`,
                ...formData.getHeaders()
            },
            timeout: 15000
        });

        for (const key of cache.keys()) {
            if (key.startsWith("torbox:") && key.includes(hash.toLowerCase())) {
                cache.delete(key);
            }
        }

        res.redirect(302, `/info-video`);
    } catch (err) {
        res.status(500).send("Chyba API stahovania TorBox.");
    }
});

app.get("/info-video", (req, res) => {
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4")); 
});

app.listen(PORT, () => {
    console.log(`🚀 SKTorrent Multi-User beží na ${PUBLIC_URL}/`);
});
