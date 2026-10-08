// SKTorrent Stremio/Nuvio Addon v3.0.0 + TorBox + ČSFD + TMDB
require("dotenv").config();
const { addonBuilder } = require("stremio-addon-sdk");
const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const FormData = require("form-data");
const path = require("path");
const cors = require("cors"); 
const {
    decodeConfig, encodeConfig, escapeRegExp, formatBytes, getFastAxios, getTime, langToFlag,
    logApi, logError, logInfo, logSuccess, logWarn, normalizeTorrentName,
    odstranDiakritiku, pLimit, skratNazov, withCache
} = require("./lib/common");
const { overitTorboxCache, pockajNaTorrentFiles } = require("./lib/torbox");
const { hladatTorrenty, stiahnutSurovyTorrent, stiahnutTorrentData } = require("./lib/sktorrent");
const { ziskatVsetkyNazvyARok } = require("./lib/metadata");
const { ziskatCsfdUrl } = require("./lib/csfd");
const { movieFileMatches, vyfiltrujMovieTorrenty } = require("./lib/movie-matcher");
const { torrentSediSEpizodou, torrentSedisSeriou } = require("./lib/episode-matcher");
const { vytvoritStream } = require("./lib/stream-builder");
// const { csfd } = require('node-csfd-api'); 

const PORT = process.env.PORT || 7000; 
// const PUBLIC_URL = "https://bda31382-bef9-4743-b2e2-e9838ecb6690.eu-central-1.cloud.genez.io"; 
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`; 
const BASE_URL = "https://sktorrent.eu"; 


/*function ziskajMovieTarget(metaInfo, zakladneNazvy = []) {
    const kandidati = [
        metaInfo?.titleOriginal,
        metaInfo?.titleCz,
        ...(Array.isArray(zakladneNazvy) ? zakladneNazvy : [])
    ].filter(Boolean);

    for (const raw of kandidati) {
        const normalized = normalizeTorrentName(raw)
            .replace(/\b(19|20)\d{2}\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const match = normalized.match(/^(.*?)(?:\s+(\d+))?$/);
        if (!match) continue;

        const baseTitle = (match[1] || '').trim();
        const sequelNumber = match[2] ? parseInt(match[2], 10) : null;

        if (baseTitle) {
            return { baseTitle, sequelNumber };
        }
    }

    return { baseTitle: null, sequelNumber: null };
}

function movieTorrentMatches(torrentName, metaInfo, zakladneNazvy = []) {
    const normalize = (s) => odstranDiakritiku(String(s || ''))
        .toLowerCase()
        .replace(/stiahni si/gi, ' ')
        .replace(/[._\-()[\]{}:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const name = normalize(torrentName);

    const targets = [
        metaInfo?.titleOriginal,
        metaInfo?.titleCz,
        ...(Array.isArray(zakladneNazvy) ? zakladneNazvy : [])
    ].filter(Boolean).map(normalize);

    if (targets.length === 0) return true;

    let baseTitle = null;
    let sequelNumber = null;

    for (const t of targets) {
        const clean = t.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
        const m = clean.match(/^(.*?)(?:\s+(\d+))?$/);
        if (m && m[1]) {
            baseTitle = m[1].trim();
            sequelNumber = m[2] ? parseInt(m[2], 10) : null;
            break;
        }
    }

    if (!baseTitle) return true;

    const escapedBase = escapeRegExp(baseTitle);
    if (!new RegExp(`\\b${escapedBase}\\b`, 'i').test(name)) {
        logWarn(`[FILTER OUT] ${torrentName} | reason=BASE_MISMATCH`);
        return false;
    }

    const pack = /\b(komplet|pack|kolekce|kolekcia|collection|saga|trilogy|quadrilogy)\b/i.test(name);

    // Rozsah checkujeme na PÔVODNOM názve (pred normalize), lebo normalize maže pomlčky
// range výnimka platí len keď hľadáme konkrétne číslo (sequelNumber !== null)
const rawName = odstranDiakritiku(String(torrentName || '')).toLowerCase();
const range = (sequelNumber !== null) ? rawName.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/) : null;

if (metaInfo?.yearStart && !pack && !range) {
    const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map(m => parseInt(m[0], 10));
    if (years.length > 0 && !years.includes(metaInfo.yearStart)) {
        logWarn(`[FILTER OUT] ${torrentName} | reason=YEAR_MISMATCH`);
        return false;
    }
    // NOVÉ: ak hľadáme nenumerovaný film (sequelNumber=null) a pack nemá rok vôbec,
    // ale obsahuje slovo "komplet/bijak/kolekcia" → vyhodiť
    if (years.length === 0 && sequelNumber === null) {
        const jeKolekcia = /\b(komplet|bijak|kolekce|kolekcia|collection|saga|trilogy|desnej)\b/i.test(name);
        if (jeKolekcia) {
            logWarn(`[FILTER OUT] ${torrentName} | reason=COLLECTION_NO_YEAR`);
            return false;
        }
    }
}

    if (sequelNumber !== null) {
        if (pack) return true;

        if (range) {
            const lo = parseInt(range[1], 10);
            const hi = parseInt(range[2], 10);
            if (sequelNumber >= lo && sequelNumber <= hi) return true;
        }

        const digitMatches = [...name.matchAll(/\b(\d{1,2})\b/g)].map(m => parseInt(m[1], 10));
        if (digitMatches.includes(sequelNumber)) return true;

        if (sequelNumber === 2 && /\bii\b/i.test(name)) return true;

        logWarn(`[FILTER OUT] ${torrentName} | reason=SEQUEL_MISMATCH`);
        return false;
    }

    // ZMENENÉ: pack bez čísla nie je relevantný pre nenumerovaný film
    if (pack) {
        logWarn(`[FILTER OUT] ${torrentName} | reason=PACK_NO_SEQUEL`);
        return false;
    }

    return true;
}

function vyfiltrujMovieTorrenty(torrenty, metaInfo, zakladneNazvy = []) {
    const before = torrenty.length;
    const filtered = torrenty.filter(t => movieTorrentMatches(t.name, metaInfo, zakladneNazvy));
    logWarn(`MOVIE FILTER: ${before} -> ${filtered.length}`);
    return filtered;
}
function romanToInt(str) {
    const map = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
    return map[str.toLowerCase()] || null;
}

function movieFileMatches(filePath, meta, zakladneNazvy = []) {
    const normalize = (s) => odstranDiakritiku(String(s || ''))
        .toLowerCase()
        .replace(/[._\-()[\]{}:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const name = normalize(filePath);
    const targets = [
        meta?.titleOriginal,
        meta?.titleCz,
        ...(Array.isArray(zakladneNazvy) ? zakladneNazvy : [])
    ].filter(Boolean).map(normalize);

    let baseTitle = null;
    let sequelNumber = null;

    for (const t of targets) {
        const clean = t.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
        const m = clean.match(/^(.*?)(?:\s+(\d+))?$/);
        if (m && m[1]) {
            baseTitle = m[1].trim();
            sequelNumber = m[2] ? parseInt(m[2], 10) : null;
            break;
        }
    }

    if (!baseTitle) return false;

    const escapedBase = escapeRegExp(baseTitle);
    if (!new RegExp(`\\b${escapedBase}\\b`, 'i').test(name)) return false;

    if (sequelNumber !== null) {
        // Arabské čísla
        const nums = [...name.matchAll(/\b(\d{1,2})\b/g)].map(m => parseInt(m[1], 10));
        if (nums.includes(sequelNumber)) return true;

        // Rímske číslice (I až X)
        const romanMatches = [...name.matchAll(/\b(x|ix|viii|vii|vi|v|iv|iii|ii|i)\b/gi)];
        for (const rm of romanMatches) {
            if (romanToInt(rm[1]) === sequelNumber) return true;
        }

        return false;
    }

    if (meta?.yearStart) {
        const years = [...name.matchAll(/\b(19|20)\d{2}\b/g)].map(m => parseInt(m[0], 10));
        if (years.length > 0 && !years.includes(meta.yearStart)) return false;
    }

    return true;
}

// ===================================================================
// ZÍSKANIE ČSFD LINKU CEZ node-csfd-api
// ===================================================================
// async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
//     return withCache(`csfd_url_v2:${imdbId}`, 86400000, async () => {
//         logApi(`Hľadám ČSFD dáta pre IMDB: ${imdbId} (Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp})`);
//         try {
//             const hladanie = await csfd.search(nazov);

//             let vsetkyVysledky = [];
//             if (vlastnyTyp === "series" && hladanie.tvSeries) {
//                 vsetkyVysledky = hladanie.tvSeries;
//             } else if (vlastnyTyp === "movie" && hladanie.movies) {
//                 vsetkyVysledky = hladanie.movies;
//             } else {
//                 vsetkyVysledky = [...(hladanie.movies || []), ...(hladanie.tvSeries || [])];
//             }

//             if (vsetkyVysledky.length === 0) {
//                 logWarn(`ČSFD nenašlo žiadne ${vlastnyTyp} výsledky pre: ${nazov}`);
//                 return null;
//             }

//             let najdeny = vsetkyVysledky.find(v => v.year === rok || v.year === rok - 1 || v.year === rok + 1);
//             if (!najdeny) najdeny = vsetkyVysledky[0];

//             let urlPath = najdeny.url;
//             const csfdUrl = urlPath.startsWith("http") ? urlPath : `https://www.csfd.cz${urlPath}`;

//             logSuccess(`Úspešne nájdené ČSFD URL: ${csfdUrl}`);
//             return csfdUrl;
//         } catch (error) {
//             logError(`Chyba pri získavaní ČSFD URL pre ${nazov}`, error);
//             return null;
//         }
//     });
// }

// ===================================================================
// FILTRE PRE NÁZVY A SERIÁLY
// ===================================================================
*/

/*function torrentSedisSeriou(nazovTorrentu, seria) {
    // 1. Zistíme, či ide o rozsah sérií (vrátane zápisov ako "1. - 4. serie").
    // Ak je to rozsah (napr. S01-S03), necháme ho prejsť.
    if (
        /S\d{1,2}\s*[-–]\s*S?\d{1,2}/i.test(nazovTorrentu) || 
        /Seasons?\s*\d{1,2}\s*[-–]\s*\d{1,2}/i.test(nazovTorrentu) ||
        /\b\d{1,2}\.?\s*[-–]\s*\d{1,2}\.?\s*s[eé]rie/i.test(nazovTorrentu) ||
        /\bs[eé]ri[ae]\s*\d{1,2}\s*[-–]\s*\d{1,2}\b/i.test(nazovTorrentu)
    ) {
        return true; 
    }
    // 2. Kontrola, či to nie je EXPLICITNE INÁ samostatná séria 
    const serieMatch = nazovTorrentu.match(/\b(\d+)\.\s*s[eé]rie/i);
    if (serieMatch && parseInt(serieMatch[1], 10) !== seria) {
    logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
    return false;
}

    const seasonMatch = nazovTorrentu.match(/\bSeason\s+(\d+)\b/i);
    if (seasonMatch && parseInt(seasonMatch[1], 10) !== seria){
    logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
    return false;
}
    // --- PRIDANÁ OPRAVA: Kontrola presného formátu SxxEyy ---
    // Ak torrent jasne hovorí, že ide napr. o S01E10, a my hľadáme Sériu 3, okamžite ho vyradíme
    const seMatch = nazovTorrentu.match(/\bS(\d{1,2})[._-]?E\d{1,3}\b/i);
    if (seMatch && parseInt(seMatch[1], 10) !== seria) {
    logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
    return false;
}
    // --- PRIDANÁ OPRAVA: Kontrola formátu 1x01 ---
    const xMatch = nazovTorrentu.match(/\b(\d{1,2})x\d{1,3}\b/i);
    if (xMatch && parseInt(xMatch[1], 10) !== seria) {
    logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
    return false;
}
    // Kontrola pre osamotené Sxx (napríklad S01, ale ignoruje, ak nasleduje E)
    const sMatch = nazovTorrentu.match(/\bS(\d{2})(?!E)/i);
    if (sMatch && parseInt(sMatch[1], 10) !== seria){
    logWarn(`[FILTER OUT] ${nazovTorrentu} | reason=BASE_MISMATCH`);
    return false;
}
    return true;
}

function torrentSediSEpizodou(nazov, seria, epizoda) {
    // 1. Hľadáme rozsahy sérií naprieč rôznymi formátmi
    const range =
        nazov.match(/\bS(\d{1,2})\s*[-–]\s*S?(\d{1,2})\b/i) ||
        nazov.match(/\bSeason\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
        nazov.match(/\bSeasons\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i) ||
        nazov.match(/\b(\d{1,2})\.?\s*[-–]\s*(\d{1,2})\.?\s*s[eé]rie\b/i) ||
        // TOTO JE NOVE: zachyti "Seria 1-13", "Série 1-12", atď.
        nazov.match(/\bs[eé]ri[ae]\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\b/i); 

    if (range) {
        // Musíme si dať pozor, ktoré zachytené skupiny čísel idú do 'a' a 'b'.
        // Pretože pri rôznych regexoch môžu byť zachytené v iných skupinách (vďaka '||')
        // Najbezpečnejšie je jednoducho nájsť prvé dve čísla z výsledku .match
        const nums = range.filter(x => x !== undefined && /^\d+$/.test(x));
        if (nums.length >= 2) {
            const a = parseInt(nums[0], 10);
            const b = parseInt(nums[1], 10);
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            // Ak naša hľadaná séria spadá do tohto rozsahu ("1. - 4."), pustíme ho ako Pack
            if (seria >= lo && seria <= hi) return true; 
        }
    }

    const seriaStr = String(seria).padStart(2, "0");
    const epStr = String(epizoda).padStart(2, "0");
    let toMaZluEpizodu = false;

    // Overenie špecifických epizód S01E01 a pod.
    const vsetkyE = [...nazov.matchAll(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})\\b`, "gi"))];
    if (vsetkyE.length > 0) {
        const maNasu = vsetkyE.some(m => parseInt(m[1]) === parseInt(epizoda));
        if (!maNasu) toMaZluEpizodu = true;
    }

    const vsetkyX = [...nazov.matchAll(new RegExp(`\\b${seria}x(\\d{1,3})\\b`, "gi"))];
    if (vsetkyX.length > 0) {
        const maNasu = vsetkyX.some(m => parseInt(m[1]) === parseInt(epizoda));
        if (!maNasu) toMaZluEpizodu = true;
    }

    const jeToRozsahE = nazov.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i);
    if (jeToRozsahE) {
        const zaciatokE = parseInt(jeToRozsahE[1]);
        const koniecE = parseInt(jeToRozsahE[2]);
        if (epizoda >= zaciatokE && epizoda <= koniecE) {
            toMaZluEpizodu = false; 
        }
    }

if (toMaZluEpizodu) {
    logWarn(`[FILTER OUT] ${nazov} | reason=EPISODE_MISMATCH`);
    return false;
}
    // Explicitná zhoda pre požadovanú epizódu
    if (new RegExp(`S${seriaStr}[._-]?E${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b${seria}x${epStr}\\b`, "i").test(nazov)) return true;
    if (new RegExp(`\\b0*${epizoda}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i").test(nazov)) return true;
    // Rozsahy epizód ako "E01-E10" alebo "Dily 1-10"
    const rozsahEpizod = nazov.match(/E(\d{1,3})\s*[-–]\s*E?(\d{1,3})\b/i) || 
                         nazov.match(/(?:Dily?|Parts?|Epizody?|Eps?|Ep)[._\s]*(\d{1,3})\s*[-–]\s*(\d{1,3})\b/i);
    if (rozsahEpizod) {
        const zaciatok = parseInt(rozsahEpizod[1] || rozsahEpizod[2]);
        const koniec = parseInt(rozsahEpizod[2] || rozsahEpizod[3]);
        if (epizoda >= zaciatok && epizoda <= koniec) return true;
    }

    // Ak nie je špecifikovaná epizóda, ale sedí séria (Alebo obsahuje kľúčové slovo pre celý Pack / Part)
    const jeToCelaSeria = new RegExp(`\\b${seria}\\.\\s*s[eé]rie\\b`, "i").test(nazov) || 
                          new RegExp(`\\bs[eé]ri[ae]\\s*${seria}\\b`, "i").test(nazov) || 
                          new RegExp(`\\bSeason\\s*${seria}\\b`, "i").test(nazov) || 
                          new RegExp(`\\bS${seriaStr}\\b`, "i").test(nazov) ||
                          /\b(Pack|Komplet|Complete|Vol|Volume|Part|Časť|Cast|1\.\s*-\s*\d{1,2}\.)\b/i.test(nazov);
                          
    return jeToCelaSeria;
}


*/

async function legacyVytvoritStream(t, seria, epizoda, userAxios, meta, userConfig) {
    logInfo(`Creating stream for torrent ID: ${t.id} (${t.name})`);
    const torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
    if (!torrentData) return null;
    
    let najdenyIndex = -1;
    let najdenyNazovSuboru = null;

    // --- OČISTENIE NÁZVU (Hneď na začiatku, aby ho videl streamObj) ---
    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    // --- VYHĽADANIE KONKRÉTNEJ EPIZÓDY ---
    if (seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
        if (videoSubory.length === 0) return null;

        const epCislo = parseInt(epizoda);
        const epStr = String(epCislo).padStart(2, "0");
        const seriaStr = String(seria).padStart(2, "0");

if (videoSubory.length === 1) {
    const nazovSuboru = videoSubory[0].path;
    const najdeneESubor =
        nazovSuboru.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`\\b${seria}x(\\d{1,3})\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`Ep(?:isode)?[._\\s]*(\\d{1,3})\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`\\b(\\d{1,3})[._\\s]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i")) ||
        nazovSuboru.match(new RegExp(`\\bE(\\d{1,3})\\b`, "i"));

    if (najdeneESubor && parseInt(najdeneESubor[1]) !== epCislo) return null;

    najdenyIndex = videoSubory[0].index;
    najdenyNazovSuboru = videoSubory[0].path;
} else {
    const epRegexy = [
        new RegExp(`[\\\\/](?:\\d+\\.\\s*s[eé]rie[\\\\/])?0*${epCislo}[\\s._-][^\\\\/]*\\.(?:mp4|mkv|avi|m4v)$`, "i"),
        new RegExp(`\\bS${seriaStr}[._-]?E${epStr}\\b`, "i"),
        new RegExp(`\\b${seria}x${epStr}\\b`, "i"),
        new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"),
        new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"),
        new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"),
        new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"),
        new RegExp(`\\b0*${epCislo}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i"),
        new RegExp(`\\bE${epStr}\\b`, "i"),
        new RegExp(`(?:^|[\\\\/])[\\s._-]*0*${epCislo}[\\s._-].*\\.(?:mp4|mkv|avi|m4v)$`, "i")
    ];

    for (let i = 0; i < epRegexy.length; i++) {
        const reg = epRegexy[i];
        const zhoda = videoSubory.find(f => reg.test(f.path));
        if (zhoda) {
            najdenyIndex = zhoda.index;
            najdenyNazovSuboru = zhoda.path;
            break;
        }
    }

    if (najdenyIndex === -1) {
        if (videoSubory.length === 1) {
            najdenyIndex = videoSubory[0].index;
            najdenyNazovSuboru = videoSubory[0].path;
            logWarn(`[TORRENT: ${t.name}] Nenájdená zhoda pre S${seria}E${epizoda}, ale použijem: ${najdenyNazovSuboru}`);
        } else {
            logWarn(`[TORRENT: ${t.name}] VYRADENÝ! Vo vnútri ${videoSubory.length} súborov nebol nájdený žiadny zodpovedajúci S${seria}E${epizoda}.`);
            return null;
        }
    } else {
        logSuccess(`[TORRENT: ${t.name}] ÚSPECH! Pre S${seria}E${epizoda} vybraný súbor: ${najdenyNazovSuboru}`);
    }
}
  // --- VYHADANIE SBORU PRE FILMY ---
} else {
    const videoSubory = torrentData.files
        .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
        .sort((a, b) => (b.length || 0) - (a.length || 0));

    if (videoSubory.length > 0) {
        const matchingFile = videoSubory.find(f => movieFileMatches(f.path, meta));
        if (matchingFile) {
            najdenyIndex = matchingFile.index;
            najdenyNazovSuboru = matchingFile.path;
        } else {
            najdenyIndex = videoSubory[0].index;
            najdenyNazovSuboru = videoSubory[0].path;
        }
    } else if (torrentData.files.length > 0) {
        const najvacsiSubor = [...torrentData.files].sort((a, b) => (b.length || 0) - (a.length || 0))[0];
        najdenyIndex = najvacsiSubor.index;
        najdenyNazovSuboru = najvacsiSubor.path;
    }
}
    

    // --- FORMÁTOVANIE METADÁT PRE TITLE ---
    const titleOriginalText = meta?.titleOriginal ? `${meta.titleOriginal}` : "";
    const titleCzText = meta?.titleCz ? `${meta.titleCz}` : "";
    const titleLine = titleCzText !== "" && titleOriginalText !== "" ? `${titleCzText} / ${titleOriginalText}` : (titleCzText !== "" ? titleCzText : titleOriginalText);

    let rokText = "📅 N/A";
    if (meta?.yearStart) {
        if (seria !== undefined) {
            rokText = meta.yearEnd && meta.yearStart !== meta.yearEnd ? `📅 ${meta.yearStart}-${meta.yearEnd}` : `📅 ${meta.yearStart}`;
        } else {
            rokText = `📅 ${meta.yearStart}`;
        }
    }

    const seriaEpizodaText = (seria !== undefined && epizoda !== undefined) ? `📺 Séria ${seria} • Epizóda ${epizoda}` : "";

    const analyzaNazvu = cistyNazov.toLowerCase();
    const kvality = [];
    if (analyzaNazvu.includes("2160p") || analyzaNazvu.includes("4k") || analyzaNazvu.includes("uhd")) kvality.push("4K");
    else if (analyzaNazvu.includes("1080p") || analyzaNazvu.includes("fhd")) kvality.push("1080p");
    else if (analyzaNazvu.includes("720p") || analyzaNazvu.includes("hd")) kvality.push("720p");
    else if (analyzaNazvu.includes("480p")) kvality.push("480p");

    if (analyzaNazvu.includes("hdr")) kvality.push("HDR");
    if (analyzaNazvu.includes("dovi") || analyzaNazvu.includes("vision")) kvality.push("Dolby Vision");
    if (analyzaNazvu.includes("hevc") || analyzaNazvu.includes("h265") || analyzaNazvu.includes("h.265") || analyzaNazvu.includes("x265")) kvality.push("HEVC");
    else if (analyzaNazvu.includes("x264") || analyzaNazvu.includes("h264") || analyzaNazvu.includes("h.264") || analyzaNazvu.includes("avc")) kvality.push("H.264");
    if (analyzaNazvu.includes("atmos")) kvality.push("Atmos");
    const kvalitaText = kvality.length > 0 ? `🎥 ${kvality.join(" • ")}` : "🎥 Kvalita neznáma";

    const fileSize = najdenyIndex !== -1 ? 
        (torrentData.files.find(f => f.index === najdenyIndex)?.length || 0) : 
        torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0);
    const formatFileSize = formatBytes(fileSize);
    const velkostText = `💿 ${formatFileSize} (🧩 ${t.size})`;

    const langMatch = cistyNazov.match(/\b(CZ|SK|EN)\b/ig) || [];
    const vlajkyList = langMatch.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean);
    const unikatneVlajky = [...new Set(vlajkyList)];
    let jazykText = "Neznámy jazyk";
    if (unikatneVlajky.length > 0) {
        jazykText = unikatneVlajky.join(" / ");
    } else if (langMatch.length > 0) {
        const textoveJazyky = [...new Set(langMatch.map(l => l.toUpperCase()))];
        jazykText = textoveJazyky.join(" / ");
    }

    // Získanie počtu seedov (t.seeds je dostupné z tvojho vyhľadávacieho scrapera)
    const seedersText = t.seeds !== undefined ? `👥 Seeders: ${t.seeds}` : "👥 N/A";

    // Vytvorenie lepšie usporiadaného zoznamu
    const riadkyTitle = [];

    // Riadok 1: Skutočný Názov (CZ/EN) + Rok (čistý rok v zátvorke pre krajší dizajn)
    if (titleLine) {
        let rokCisty = rokText.replace("📅 ", ""); // Odstránime ikonu, nech to vyzerá filmovejšie
        riadkyTitle.push(`${titleLine} ${rokCisty !== "N/A" ? `(${rokCisty})` : ""}`);
    }

    // Riadok 2: TV Info (Séria a Epizóda) - zobrazí sa iba pri seriáloch
    if (seriaEpizodaText) {
        riadkyTitle.push(seriaEpizodaText);
    }

    // Riadok 3: Vlastnosti streamu (Jazyk a Kvalita oddelené čiarou)
    riadkyTitle.push(`🔊 ${jazykText}   |   ${kvalitaText}`);

    // Riadok 4: Technické info (Veľkosť a počet Seedov)
    riadkyTitle.push(`${velkostText}   |   ${seedersText}`);

    // Riadok 5: Konkrétny nájdený súbor, ktorý sa ide prehrať (Ak sa našiel v packu)
    if (najdenyNazovSuboru) {
        const ibaNazovSuboru = najdenyNazovSuboru.split('/').pop().split('\\').pop();
        riadkyTitle.push(`📄 Súbor: ${ibaNazovSuboru}`);
    }

    // Riadok 6: Originálny názov Torrent / Pack názov (na konci, lebo býva najdlhší a najviac "škaredý")
    riadkyTitle.push(`🗂️ Torrent: ${cistyNazov}`);

    // -- OŠETRENIE BEZPEČNEJ VEĽKOSTI --
    const bezpecnaVelkost = (fileSize && fileSize > 0) ? fileSize : 1048576; 

    // OČISTENIE NÁZVU SÚBORU
    const povodnySubor = najdenyNazovSuboru || "video.mkv";
    let cistyNazovSuboru = povodnySubor.split('/').pop().split('\\').pop();
    cistyNazovSuboru = cistyNazovSuboru.replace(/[^a-zA-Z0-9.\-]/g, '_');

    // --- FINÁLNE TVORENIE OBJEKTU
    let streamObj = {
        name: `SKT\n${t.category.toUpperCase()}`,
        title: riadkyTitle.join("\n"),
        behaviorHints: { 
            bingeGroup: `sktorrent-${kvality.length > 0 ? kvality.join("-").replace(/\s/g, "") : "standard"}`
        },
        sktId: t.id, 
        fileName: cistyNazovSuboru,
        infoHash: torrentData.infoHash,
        fileIdx: najdenyIndex === -1 ? 0 : najdenyIndex
    };

    return streamObj;
}
// ===================================================================
// VLASTNÝ EXPRESS SERVER BEZ `getRouter` Z SDK
// ===================================================================
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "32kb" }));

function getPublicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "https";
    return `${protocol}://${req.get("host")}`.replace(/\/+$/, "");
}

app.post("/api/config-token", (req, res) => {
    const body = req.body || {};
    if (!body.uid || !body.pass) {
        return res.status(400).json({ error: "Chýba uid alebo pass." });
    }
    if (!process.env.ENCRYPTION_KEY) {
        return res.status(503).json({ error: "ENCRYPTION_KEY nie je nastavený na serveri." });
    }
    try {
        const token = encodeConfig({
            uid: String(body.uid),
            pass: String(body.pass),
            torbox: body.torbox ? String(body.torbox) : "",
            tmdb: body.tmdb ? String(body.tmdb) : "",
            showUncached: Boolean(body.showUncached),
            sizeOrder: body.sizeOrder === "asc" ? "asc" : "desc",
            qualityOrder: Array.isArray(body.qualityOrder) ? body.qualityOrder : [4, 3, 2, 1, 0],
            cb: Date.now()
        });
        res.json({ token });
    } catch (error) {
        logError("Failed to encrypt config", error);
        res.status(500).json({ error: "Šifrovanie configu zlyhalo." });
    }
}); 

app.use((req, res, next) => {
    console.log(`\n======================================================`);
    console.log(`[${getTime()}] 🌍 [HTTP REQUEST] -> ${req.method} ${req.originalUrl}`);
    console.log(`[${getTime()}] 📡 IP: ${req.ip} | User-Agent: ${req.headers['user-agent']?.substring(0, 50)}...`);
    next(); 
});

app.get("/health", (req, res) => {
    res.json({ ok: true, service: "sktorrent-addon", version: "3.0.3" });
});

app.get("/health/csfd", (req, res) => {
    res.json({ ok: true, tmdbWikidataFallback: true });
});

// --- Web UI ---
app.get(['/', '/configure', '/:config/configure'], (req, res) => {
    
    let currentConfig = {};
    if (req.params.config) {
        try {
            currentConfig = decodeConfig(req.params.config) || {};
        } catch (e) {
            console.error("Chyba pri dekódovaní configu:", e);
        }
    }

    const getVal = (key) => currentConfig[key] ? currentConfig[key] : '';
    const getCheck = (key, defaultVal) => {
        if (currentConfig[key] !== undefined) return currentConfig[key] ? 'checked' : '';
        return defaultVal ? 'checked' : '';
    };
    const getSelect = (key, val, defaultVal) => {
        if (currentConfig[key] !== undefined) return currentConfig[key] === val ? 'selected' : '';
        return val === defaultVal ? 'selected' : '';
    };

    const getQualityVal = (index, defaultVal) => {
        if (currentConfig.qualityOrder && currentConfig.qualityOrder[index] !== undefined) {
            return currentConfig.qualityOrder[index];
        }
        return defaultVal;
    };

    const q1 = getQualityVal(0, 4);
    const q2 = getQualityVal(1, 3);
    const q3 = getQualityVal(2, 2);
    const q4 = getQualityVal(3, 1);

    const html = `
    <!DOCTYPE html>
    <html lang="sk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SKTorrent Stremio/Nuvio Addon</title>
        <style>
            :root { color-scheme: dark; --bg: #090a10; --panel: rgba(22, 24, 36, .92); --line: rgba(255,255,255,.1); --muted: #a9adbd; --text: #f6f7fb; --accent: #a970ff; --accent2: #6f5cff; --success: #24c87a; }
            * { box-sizing: border-box; }
            body { min-height: 100vh; margin: 0; padding: 42px 20px; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--text); background: radial-gradient(circle at 15% 0%, #30225e 0, transparent 34rem), radial-gradient(circle at 90% 100%, #123d4a 0, transparent 32rem), var(--bg); }
            .container { position: relative; width: 100%; max-width: 540px; margin: 0 auto; padding: 32px; overflow: hidden; border: 1px solid var(--line); border-radius: 24px; background: var(--panel); box-shadow: 0 24px 80px rgba(0,0,0,.42); backdrop-filter: blur(18px); }
            .container::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, var(--accent), #75d6ff, var(--success)); }
            h2 { margin: 0; color: var(--text); font-size: 26px; letter-spacing: -.6px; text-align: center; }
            h2::before { content: "🎬"; display: block; width: 48px; height: 48px; margin: 0 auto 13px; border-radius: 15px; background: linear-gradient(135deg, var(--accent), var(--accent2)); box-shadow: 0 10px 26px rgba(145,100,255,.35); font-size: 24px; line-height: 48px; }
            h3 { margin: 25px 0 4px !important; color: #e6e2ff !important; font-size: 14px; letter-spacing: .04em; text-align: left !important; text-transform: uppercase; }
            h3 + label { margin-top: 14px; }
            p { color: var(--muted) !important; line-height: 1.55; }
            label { display: block; margin-top: 18px; color: #e5e7ef; font-size: 13px; font-weight: 650; }
            input, select { width: 100%; height: 45px; margin-top: 7px; padding: 0 13px; border: 1px solid var(--line); border-radius: 11px; outline: none; background: rgba(4,5,11,.45); color: var(--text); font: inherit; transition: border-color .18s, box-shadow .18s, background .18s; }
            input::placeholder { color: #73788b; }
            input:focus, select:focus { border-color: var(--accent); background: rgba(10,11,20,.75); box-shadow: 0 0 0 3px rgba(169,112,255,.16); }
            hr { margin: 29px 0 0 !important; border: 0 !important; border-top: 1px solid var(--line) !important; }
            .inline-selects { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 7px; }
            .inline-selects select { width: 100%; padding: 0 4px; text-align: center; }
            button { width: 100%; min-height: 48px; margin-top: 27px; border: 0; border-radius: 12px; background: linear-gradient(135deg, var(--accent), var(--accent2)); color: #fff; cursor: pointer; font-size: 15px; font-weight: 750; letter-spacing: .01em; box-shadow: 0 12px 28px rgba(115,86,255,.28); transition: transform .18s, filter .18s, box-shadow .18s; }
            button:hover { filter: brightness(1.12); box-shadow: 0 15px 34px rgba(115,86,255,.4); transform: translateY(-1px); }
            button:active { transform: translateY(0); }
            #result-box { display: none; margin-top: 22px; padding: 18px; border: 1px solid rgba(169,112,255,.42); border-radius: 16px; background: rgba(114,87,221,.1); text-align: center; }
            #result-box p { margin: 0 !important; color: #e7dcff !important; font-size: 14px !important; font-weight: 750 !important; }
            #generated-url { width: 100%; height: 70px; margin: 13px 0 2px; padding: 10px; resize: none; border: 1px solid var(--line); border-radius: 10px; background: #090b12; color: #9af0ca; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; line-height: 1.4; word-break: break-all; }
            .copy-btn, .install-btn { margin-top: 10px; box-shadow: none; }
            .copy-btn { background: #313648; }
            .copy-btn:hover { background: #40465b; }
            .install-btn { background: linear-gradient(135deg, #20b96e, #159c73); }
            .checkbox-label { display: flex; gap: 10px; align-items: center; min-height: 45px; margin-top: 14px; padding: 0 13px; border: 1px solid var(--line); border-radius: 11px; background: rgba(4,5,11,.32); font-weight: 500; }
            .checkbox-label input { width: 17px; height: 17px; margin: 0; accent-color: var(--accent); }
            @media (max-width: 520px) { body { padding: 18px 12px; } .container { padding: 25px 19px; border-radius: 18px; } }
        </style>
    </head>
    <body>
        <div class="container">
            <h2>SKTorrent Stremio/Nuvio Addon</h2>
            <p style="text-align:center; font-size:13px; color:#aaa;">Vyplň svoje údaje na vygenerovanie inštalačného odkazu.</p>
            
            <label>SKTorrent UID (Cookie s názvom uid)</label>
            <input type="text" id="uid" placeholder="Napr. 123987" value="${getVal('uid')}" required>
            
            <label>SKTorrent pass (Tiež z cookies s názvom pass)</label>
            <input type="password" id="pass" placeholder="Tvoj pass" value="${getVal('pass')}" required>
            
            <label>TorBox API Key (Odporúčané)</label>
            <input type="text" id="torbox" placeholder="TorBox token" value="${getVal('torbox')}">
            
            <label>TMDB API Key (Voliteľné)</label>
            <input type="text" id="tmdb" placeholder="TMDB token" value="${getVal('tmdb')}">
            
            <hr style="border: 1px solid #444; margin-top: 20px;">
            <h3 style="text-align: center; color: #aaa; margin-bottom: 5px;">Nastavenia zobrazenia</h3>

            <label class="checkbox-label">
                <input type="checkbox" id="showUncached" ${getCheck('showUncached', true)}> Zobraziť nenastiahnuté (Uncached ⏳)
            </label>

            <label>Zoradenie podľa veľkosti:</label>
            <select id="sizeOrder">
                <option value="desc" ${getSelect('sizeOrder', 'desc', 'desc')}>Najväčšie prvé (Odporúčané)</option>
                <option value="asc" ${getSelect('sizeOrder', 'asc', 'desc')}>Najmenšie prvé</option>
            </select>

            <label>Priorita kvality (1. až 4.):</label>
            <div class="inline-selects">
                <select class="q-order"><option value="4" ${q1 === 4 ? 'selected':''}>4K</option><option value="3" ${q1 === 3 ? 'selected':''}>1080p</option><option value="2" ${q1 === 2 ? 'selected':''}>720p</option><option value="1" ${q1 === 1 ? 'selected':''}>SD</option></select>
                <select class="q-order"><option value="4" ${q2 === 4 ? 'selected':''}>4K</option><option value="3" ${q2 === 3 ? 'selected':''}>1080p</option><option value="2" ${q2 === 2 ? 'selected':''}>720p</option><option value="1" ${q2 === 1 ? 'selected':''}>SD</option></select>
                <select class="q-order"><option value="4" ${q3 === 4 ? 'selected':''}>4K</option><option value="3" ${q3 === 3 ? 'selected':''}>1080p</option><option value="2" ${q3 === 2 ? 'selected':''}>720p</option><option value="1" ${q3 === 1 ? 'selected':''}>SD</option></select>
                <select class="q-order"><option value="4" ${q4 === 4 ? 'selected':''}>4K</option><option value="3" ${q4 === 3 ? 'selected':''}>1080p</option><option value="2" ${q4 === 2 ? 'selected':''}>720p</option><option value="1" ${q4 === 1 ? 'selected':''}>SD</option></select>
            </div>

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
                var qSelects = document.querySelectorAll('.q-order');
                var qArray = [];
                for(var i = 0; i < qSelects.length; i++) {
                    qArray.push(parseInt(qSelects[i].value));
                }
                qArray.push(0); 

                var uniqueQArray = [];
                for(var j = 0; j < qArray.length; j++) {
                    if(uniqueQArray.indexOf(qArray[j]) === -1) {
                        uniqueQArray.push(qArray[j]);
                    }
                }

                var config = {
                    uid: document.getElementById('uid').value,
                    pass: document.getElementById('pass').value,
                    torbox: document.getElementById('torbox').value,
                    tmdb: document.getElementById('tmdb').value,
                    showUncached: document.getElementById('showUncached').checked,
                    sizeOrder: document.getElementById('sizeOrder').value,
                    qualityOrder: uniqueQArray
                };

                if(!config.uid || !config.pass) {
                    alert('Prosím, vyplň aspoň UID a Heslo pre SKTorrent.'); 
                    return;
                }

                fetch('/api/config-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                }).then(function(response) {
                    return response.json().then(function(data) {
                        if (!response.ok) {
                            throw new Error(data.error || 'Šifrovanie zlyhalo');
                        }
                        var baseUrl = window.location.origin;
                        if (!baseUrl || baseUrl === "null") {
                            baseUrl = window.location.protocol + "//" + window.location.host;
                        }
                        document.getElementById('result-box').style.display = 'block';
                        document.getElementById('generated-url').value = baseUrl + '/' + data.token + '/manifest.json';
                    });
                }).catch(function(error) {
                    alert(error.message || 'Chyba pri generovaní kódu.');
                    console.error(error);
                });
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
                var stremioUrl = httpUrl.replace("https://", "stremio://").replace("http://", "stremio://");
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
        version: "3.0.0",
        name: "SKTorrent",
        description: "SKTorrent s TorBox, ČSFD a TMDB metadátami",
        types: ["movie", "series"],
        catalogs: [],
        resources: ["stream"],
        idPrefixes: ["tt", "tmdb"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    });
};

app.get('/manifest.json', handleManifest);
app.get('/:config/manifest.json', handleManifest);

app.get('/:config?/catalog/:type/:id.json', (req, res) => {
    res.json({ metas: [] });
});

// --- Stream Route ---
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    const { type: aplikaciaTyp, id, config } = req.params;
    const startCas = Date.now();
    const requestPublicUrl = getPublicBaseUrl(req);
    
    logInfo(`Stream request started | Type: ${aplikaciaTyp} | ID: ${id}`);
    
    const userConfig = decodeConfig(config);
    const activeUid = userConfig?.user_id || userConfig?.uid;
    const activePass = userConfig?.password || userConfig?.pass;
    const activeTorbox = userConfig?.tb_key || userConfig?.torbox;
    const activeTmdb = userConfig?.tm_key || userConfig?.tmdb;

    if (!activeUid || !activePass) {
        logWarn(`Stream request denied - Invalid or missing config.`);
        return res.json({ streams: [], error: "Neplatná konfigurácia." });
    }
    
    const normalizedConfig = { uid: activeUid, pass: activePass, torbox: activeTorbox, tmdb: activeTmdb };
    const userAxios = getFastAxios(normalizedConfig);
    console.log(`\n====== 🎬 Hľadám pre UID: ${normalizedConfig.uid} | id='${id}' ======`);

    const idParts = id.split(":");
    const isTmdb = idParts[0] === "tmdb";
    let zdrojId, seria, epizoda, vlastnyTyp;
    if (isTmdb) {
        const [, tmdbRawId, sRaw, eRaw] = idParts;
        vlastnyTyp = sRaw !== undefined ? "series" : "movie";
        seria = sRaw !== undefined ? parseInt(sRaw) : undefined;
        epizoda = eRaw !== undefined ? parseInt(eRaw) : undefined;
        zdrojId = `tmdb:${tmdbRawId}`;
    } else {
        const [ttId, sRaw, eRaw] = idParts;
        vlastnyTyp = id.includes(":") ? "series" : "movie";
        seria = sRaw ? parseInt(sRaw) : undefined;
        epizoda = eRaw ? parseInt(eRaw) : undefined;
        zdrojId = ttId;
    }

    // 1. ZÍSKAME NÁZVY A ROK a META
    const metaData = await ziskatVsetkyNazvyARok(zdrojId, vlastnyTyp, normalizedConfig.tmdb);
    const suroveNazvy = metaData?.nazvy || [];
    const vydanyRok = metaData?.rok;
    const metaInfo = metaData?.meta;

    if (!suroveNazvy.length) {
        logWarn(`No metadata names found. Returning empty list.`);
        return res.json({ streams: [] });
    }

    const zakladneNazvy = [];
    suroveNazvy.forEach(t => {
        let cistyT = t.replace(/\(.*?\)/g, "").replace(/TV (Mini )?Series/gi, "").trim();
        zakladneNazvy.push(cistyT);
        if (cistyT.includes(":")) zakladneNazvy.push(cistyT.split(":")[0].trim());
    });
    const unikatneNazvy = [...new Set(zakladneNazvy)];

    const dotazy = new Set();

    // 2. ČSFD LINK
    // Snažíme sa použiť primárne český názov z metadát pre ČSFD vyhľadávanie
        const hlavnyNazov = metaData?.meta?.titleOriginal || unikatneNazvy[0];
        const csfdLink = await ziskatCsfdUrl(
            metaData?.imdbId || zdrojId,
            hlavnyNazov,
            vydanyRok,
            vlastnyTyp,
            metaData?.tmdbId,
            unikatneNazvy
        );
    
    if (csfdLink) {
        dotazy.add(csfdLink); 
    }

    // 3. Fallback na klasické textové hľadanie
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
        // --- PRIDANÉ: Najprv hľadáme základný názov bez čísla (pre packy) ---
        const numMatch = bezDia.match(/^(.*?)\s+(\d+)$/);
        if (numMatch) {
            const baseName = numMatch[1].trim();
            if (baseName.length > 2) {
                dotazy.add(baseName); // Pridá napr. "Scary Movie"
            }
        }
        
        // --- PÔVODNÉ: Potom hľadá presný názov s číslom ---
        [zaklad, bezDia, kratky].forEach(b => {
          if (!b.trim()) return;
          dotazy.add(b); // Pridá napr. "Scary Movie 4"
        });
      }
    });

    let torrenty = [];
    let pokus = 1;
    const videnieTorrentIds = new Set();
    let uspesneNajdeneCezCsfd = false;

    for (const d of dotazy) { 
        logInfo(`Search attempt ${pokus}: "${d}"`);
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

      // Ak sme našli film cez CSFD link (pokus 1), necháme prejsť ešte jeden 
      // textový vyhľadávací pokus (pokus 2), aby sme našli packy.
      if (uspesneNajdeneCezCsfd) {
          if (vlastnyTyp === 'series' || pokus > 1) {
              logInfo(`ČSFD link a packy spracované. Preskakujem ďalšie dotazy.`);
              break;
          }
      } else if (torrenty.length >= 30) {
        logInfo(`Dostatok torrentov nájdených, preskakujem ďalšie dotazy.`);
        break;
      }

        if (pokus > 10) break; 
        pokus++;
    }

if (seria !== undefined) {
    logInfo(`Filtering series torrents for S${seria} E${epizoda}...`);
    const predFiltrom = torrenty.length;
    torrenty = torrenty.filter(t => {
        const ok = torrentSedisSeriou(t.name, seria) && torrentSediSEpizodou(t.name, seria, epizoda);
        if (!ok) logWarn(`[FILTER OUT] ${t.name}`);
        else logWarn(`[FILTER IN] ${t.name}`);
        return ok;
    });
    logInfo(`Series filter complete. Remaining: ${torrenty.length} (filtered out ${predFiltrom - torrenty.length})`);
}

if (vlastnyTyp === 'movie') {
    torrenty = vyfiltrujMovieTorrenty(torrenty, metaInfo, zakladneNazvy);
}

const execLimit = pLimit(5);
logInfo(`Creating streams for ${torrenty.length} torrents (Max concurrency: 5)...`);
    
    // POSIELAME `metaInfo` do `vytvoritStream`
    let streamy = (await Promise.all(
        torrenty.map(t => execLimit(() => vytvoritStream(t, seria, epizoda, userAxios, metaInfo, userConfig)))
    )).filter(Boolean);

        if (userConfig.torbox && streamy.length > 0) {
        logInfo("TorBox enabled. Preparing streams for TorBox playback...");
        const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean); 
        const torboxCache = await overitTorboxCache(hasheKONTROLA, userConfig.torbox);

        function getQualityRank(text = "") {
            const t = text.toLowerCase();
            if (t.includes("2160p") || t.includes("4k") || t.includes("uhd")) return 4;
            if (t.includes("1080p") || t.includes("fhd")) return 3;
            if (t.includes("720p") || /\bhd\b/.test(t)) return 2;
            if (t.includes("480p")) return 1;
            return 0;
        }

        function getSizeBytes(text = "") {
            const m = text.match(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb|kb)\b/i);
            if (!m) return 0;
            const value = parseFloat(m[1].replace(",", "."));
            const unit = m[2].toLowerCase();
            if (unit === "tb") return value * 1024 * 1024 * 1024 * 1024;
            if (unit === "gb") return value * 1024 * 1024 * 1024;
            if (unit === "mb") return value * 1024 * 1024;
            if (unit === "kb") return value * 1024;
            return 0;
        }
        
        streamy = streamy.map(stream => {
            const hash = stream.infoHash.toLowerCase();
            const jeCached = torboxCache[hash] === true;
            const staraKategoria = stream.name.split("\n")[1] || "";
            const proxySeria = seria || 0;
            const proxyEpizoda = epizoda || 0;
            
            const sortText = `${staraKategoria} ${stream.title || ""}`;
            
            let finalStream = {
                name: jeCached ? `[TB ⚡] SKT\n${staraKategoria}` : `[TB ⏳] SKT\n${staraKategoria}`,
                title: stream.title,
                type: vlastnyTyp,
                behaviorHints: stream.behaviorHints,

                _sortCached: jeCached ? 1 : 0,
                _sortQuality: getQualityRank(sortText),
                _sortSize: getSizeBytes(sortText)
            };

            if (jeCached) {
                const safeName = (stream.fileName || "video.mkv").split('/').join('|');
                finalStream.url = `${requestPublicUrl}/${config}/play/${hash}/${proxySeria}/${proxyEpizoda}/${encodeURIComponent(safeName)}`;
            } else {
                finalStream.behaviorHints = { ...(stream.behaviorHints || {}), notWebReady: true };
                finalStream.url = `${requestPublicUrl}/${config}/download/${hash}/${encodeURIComponent(stream.sktId)}`;
            }
            return finalStream;
        });

        const showUncached = userConfig.showUncached !== undefined ? userConfig.showUncached : true;
        if (!showUncached) {
            streamy = streamy.filter(s => s._sortCached === 1);
        }

        const sizeOrder = userConfig.sizeOrder || "desc"; 
        const defaultQualityOrder = [4, 3, 2, 1, 0];
        const qualityOrder = userConfig.qualityOrder || defaultQualityOrder;

        streamy = streamy.sort((a, b) => {
            if (b._sortCached !== a._sortCached) {
                return b._sortCached - a._sortCached;
            }

            const indexA = qualityOrder.indexOf(a._sortQuality);
            const indexB = qualityOrder.indexOf(b._sortQuality);
            
            const rankA = indexA === -1 ? 99 : indexA;
            const rankB = indexB === -1 ? 99 : indexB;

            if (rankA !== rankB) {
                return rankA - rankB;
            }

            if (sizeOrder === "asc") {
                return a._sortSize - b._sortSize;
            } else {
                return b._sortSize - a._sortSize;
            }
        });

        streamy = streamy.map(({ _sortCached, _sortQuality, _sortSize, ...rest }) => rest);

        logSuccess(`TorBox stream formatting complete. Cached: ${streamy.filter(s => s.name.includes("⚡")).length}, Uncached: ${streamy.filter(s => s.name.includes("⏳")).length}`);

        const trvanie = Date.now() - startCas;
        logSuccess(`Stream request finished in ${trvanie}ms. Returning ${streamy.length} streams to Stremio.`);

        const maUncachedStreamy = streamy.some(s => s.name && s.name.includes("⏳"));
        const cacheMaxAge = maUncachedStreamy ? 60 : 3600;
        res.setHeader('Cache-Control', `max-age=${cacheMaxAge}, stale-while-revalidate=${cacheMaxAge}, stale-if-error=${cacheMaxAge}`);
        // ---------------------------------

        return res.json({ streams: streamy });


    } 
});


// =========================================================================
// TORBOX PROXY ROUTER
// =========================================================================
app.get('/:config/play/:hash/:seria/:epizoda/:fileName', async (req, res) => {
  const { config, hash, seria, epizoda, fileName } = req.params;
  const userConfig = decodeConfig(config);
  const torboxKey = userConfig?.torbox;

  if (!torboxKey) {
    return res.status(400).send('Chýba TorBox API kľúč.');
  }

  /*
   * PLAY CACHE
   *
   * Cacheujeme iba torrentId + fileId, nie samotný TorBox CDN URL.
   *
   * TTL: 2 hodiny 30 minút.
   *
   * Dôvod:
   * - libmpv/Stremio môže zavolať /play viackrát pri štarte alebo seekovaní
   * - pri CACHE HIT už nerobíme mylist + pockajNaTorrentFiles + výber súboru
   * - pri každom /play sa však spraví nový requestdl, takže dostaneme nový
   *   TorBox CDN URL a nevraciame starý/expirovaný direct link
   *
   * API key sa nedáva priamo do cache key, iba jeho SHA-256 hash.
   */
  const PLAY_CACHE_TTL = 2 * 60 * 60 * 1000 + 30 * 60 * 1000;

  const torboxUserHash = crypto
    .createHash('sha256')
    .update(String(torboxKey))
    .digest('hex')
    .slice(0, 16);

  const playCacheKey =
    `torbox-play:${torboxUserHash}:` +
    `${String(hash || '').toLowerCase()}:` +
    `${String(seria || '')}:` +
    `${String(epizoda || '')}:` +
    `${String(fileName || '').toLowerCase()}`;

  try {
    /*
     * Pri CACHE MISS sa vykoná celý TorBox lookup iba raz.
     * Ak príde viac rovnakých requestov naraz, withCache ich deduplikuje
     * cez pendingCacheRequests.
     */
    const playData = await withCache(
      playCacheKey,
      PLAY_CACHE_TTL,
      async () => {

        // ============================================================
        // 1. Skontroluj, či torrent už existuje v mylist
        // ============================================================
        const mylistRes = await axios.get(
          "https://api.torbox.app/v1/api/torrents/mylist",
          {
            params: { bypass_cache: true },
            headers: {
              Authorization: `Bearer ${torboxKey}`
            },
            timeout: 8000
          }
        );

        const zoznam = Array.isArray(mylistRes.data?.data)
          ? mylistRes.data.data
          : [mylistRes.data?.data];

        const torrentObj = zoznam.find(
          t => t && t.hash?.toLowerCase() === hash.toLowerCase()
        );

        let torrentId;

        // ============================================================
        // 2. Torrent neexistuje -> vytvor ho
        // ============================================================
        if (!torrentObj) {
          const magnet = `magnet:?xt=urn:btih:${hash}`;

          const form = new FormData();
          form.append('magnet', magnet);
          form.append('seed', '1');

          const createRes = await axios.post(
            'https://api.torbox.app/v1/api/torrents/createtorrent',
            form,
            {
              headers: {
                Authorization: `Bearer ${torboxKey}`,
                ...form.getHeaders()
              },
              timeout: 15000
            }
          );

          torrentId = createRes.data?.data?.torrent_id;

          if (!torrentId) {
            throw new Error('TorBox nevytvoril torrent.');
          }

        } else {
          torrentId = torrentObj.id;
        }

        // ============================================================
        // 3. Počkaj, kým TorBox pripraví files
        // ============================================================
        const hotovyTorrent = await pockajNaTorrentFiles(
          torrentId,
          torboxKey
        );

        if (!hotovyTorrent) {
          logWarn(
            `PLAY CACHE: TorBox torrent ${torrentId} ešte nie je pripravený.`
          );

          // null sa do withCache neuloží -> ďalší request môže skúsiť znova
          return null;
        }

        // ============================================================
        // 4. Vyber iba video súbory
        // ============================================================
        const videoSubory = hotovyTorrent.files.filter(f =>
          /\.(mp4|mkv|avi|m4v)$/i.test(
            f.name || f.short_name || ''
          )
        );

        if (videoSubory.length === 0) {
          throw new Error(
            'V torrente sa nenašiel žiadny video súbor.'
          );
        }

        let vybranySubor;

        // ============================================================
        // 5. Pokus podľa fileName
        // ============================================================
        if (fileName && fileName !== 'undefined') {

          const hladanyNazov = fileName
            .replace(/[^a-zA-Z0-9]/g, '')
            .toLowerCase();

          vybranySubor = videoSubory.find(f => {

            const torboxNazov = (
              f.name ||
              f.short_name ||
              ""
            )
              .replace(/[^a-zA-Z0-9]/g, '')
              .toLowerCase();

            return (
              torboxNazov.includes(hladanyNazov) ||
              hladanyNazov.includes(torboxNazov)
            );
          });
        }

        // ============================================================
        // 6. Pokus podľa SxxEyy
        // ============================================================
        if (
          !vybranySubor &&
          seria !== undefined &&
          epizoda !== undefined &&
          seria !== 'undefined' &&
          seria !== '0'
        ) {

          const epCislo = parseInt(epizoda);
          const epStr = String(epCislo).padStart(2, "0");
          const seriaStr = String(seria).padStart(2, "0");

          const rozsireneRegexy = [
            new RegExp(
              `S${seriaStr}[._-]?E${epStr}\\b`,
              "i"
            ),

            new RegExp(
              `\\b${seria}x${epStr}\\b`,
              "i"
            ),

            new RegExp(
              `\\b${seria}x0*${epCislo}\\b`,
              "i"
            ),

            new RegExp(
              `S${seriaStr}[._-]?E${epStr}(?![0-9])`,
              "i"
            ),

            new RegExp(
              `Ep(?:isode)?[._\\s]*0*${epCislo}\\b`,
              "i"
            ),

            new RegExp(
              `\\b0*${epCislo}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`,
              "i"
            ),

            new RegExp(
              `\\bE${epStr}\\b`,
              "i"
            )
          ];

          for (const r of rozsireneRegexy) {

            vybranySubor = videoSubory.find(
              f => r.test(f.name || f.short_name || "")
            );

            if (vybranySubor) {
              break;
            }
          }
        }

        // ============================================================
        // 7. Fallback iba pre filmy
        // ============================================================
        if (!vybranySubor) {

          if (
            seria === 'undefined' ||
            seria === '0' ||
            !seria
          ) {

            vybranySubor = [...videoSubory]
              .sort(
                (a, b) =>
                  (b.size || 0) - (a.size || 0)
              )[0];

          } else {

            throw new Error(
              `V torrente sa nenašla epizóda S${seria}E${epizoda}. ` +
              `TorBox zoznam: ` +
              videoSubory
                .map(f => f.name)
                .join(", ")
            );
          }
        }

        const fileId = vybranySubor.id;

        logInfo(
          `PLAY CACHE: vybraný súbor "${vybranySubor.name || vybranySubor.short_name}" ` +
          `(torrentId=${torrentId}, fileId=${fileId})`
        );

        // ============================================================
        // 8. Do cache ulož iba stabilné ID
        // ============================================================
        logSuccess(
          `PLAY CACHE: torrentId=${torrentId}, fileId=${fileId} ` +
          `uložené na 2 hodiny 30 minút.`
        );

        return {
          torrentId,
          fileId
        };
      }
    );

    // ============================================================
    // CACHE MISS + TorBox ešte nie je pripravený
    // ============================================================
    if (!playData) {
      return res.status(202).send(
        'Torrent sa ešte spracováva na TorBoxe. ' +
        'Skús o 20-30 sekúnd znova.'
      );
    }

    // ============================================================
    // 9. TorBox CDN URL cacheujeme minimálne 60 sekúnd
    // ============================================================
    //
    // torrentId + fileId máme v cache 2 h 30 min.
    // Samotný CDN URL držíme 60 sekúnd.
    //
    // To znamená:
    // - opakované /play requesty v priebehu 60 s
    //   dostanú rovnaký URL
    // - po 60 s sa cez requestdl vyžiada nový URL
    //
    const playUrlCacheKey = `${playCacheKey}:url`;

    const finalUrl = await withCache(
      playUrlCacheKey,
      60 * 1000,
      async () => {

        const linkRes = await axios.get(
          'https://api.torbox.app/v1/api/torrents/requestdl',
          {
            params: {
              token: torboxKey,
              torrent_id: playData.torrentId,
              file_id: playData.fileId
            },
            headers: {
              Authorization: `Bearer ${torboxKey}`
            },
            timeout: 10000
          }
        );

        const url = linkRes.data?.data;

        if (!url) {
          throw new Error(
            'Nepodarilo sa získať streamovací link.'
          );
        }

        logSuccess(
          `PLAY URL CACHE: nový TorBox CDN URL získaný ` +
          `(cache 60 sekúnd)`
        );

        return url;
      }
    );

    if (!finalUrl) {
      return res.status(500).send(
        'Nepodarilo sa získať streamovací link.'
      );
    }

    return res.redirect(302, finalUrl);

  } catch (err) {

    logError('Play route failed', err);

    return res
      .status(500)
      .send('Interná chyba pri spracovaní streamu.');
  }
});

app.get("/:config/download/:hash/:sktId", async (req, res) => {
    const { hash, sktId, config } = req.params;
    logInfo(`[UNCACHED] Endpoint zavolaný | hash=${hash} | sktId=${sktId}`);

    const userConfig = decodeConfig(config);
    const activeUid = userConfig?.user_id || userConfig?.uid;
    const activePass = userConfig?.password || userConfig?.pass;
    const torboxKey = userConfig?.tb_key || userConfig?.torbox;

    if (!activeUid || !activePass) return res.status(400).send("Chyba konfigurácie SKTorrent.");
    if (!torboxKey) return res.status(400).send("Chýba TorBox API kľúč.");

    const userAxios = getFastAxios({ uid: activeUid, pass: activePass, torbox: torboxKey });

    try {
        const torrentUrl = `${BASE_URL}/torrent/download.php?id=${encodeURIComponent(sktId)}`;
        const rawTorrent = await stiahnutSurovyTorrent(torrentUrl, userAxios);
        const torrentBuffer = Buffer.isBuffer(rawTorrent) ? rawTorrent : rawTorrent ? Buffer.from(rawTorrent) : null;
        if (!torrentBuffer || torrentBuffer.length < 100) return res.status(502).send("Nepodarilo sa stiahnuť platný .torrent súbor.");

        const formData = new FormData();
        formData.append("file", torrentBuffer, { filename: `${hash}.torrent`, contentType: "application/x-bittorrent" });
        formData.append("seed", "1");

        const createRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
            headers: { Authorization: `Bearer ${torboxKey}`, ...formData.getHeaders() },
            timeout: 30000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        if (createRes.data?.success === false) {
            const message = createRes.data?.detail || createRes.data?.error || "TorBox odmietol torrent.";
            return res.status(502).send(String(message));
        }

        res.setHeader("Cache-Control", "no-store");
        return res.sendFile(path.join(__dirname, "stahuje-sa.mp4"));
    } catch (error) {
        const apiData = error.response?.data;
        const message = apiData?.detail || apiData?.error || error.message || "Neznáma chyba";
        logError(`[UNCACHED] Chyba: ${message}`, error);
        return res.status(error.response?.status || 500).send(`Chyba pri pridávaní do TorBoxu: ${message}`);
    }
});

app.get("/info-video", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4"));
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`
======================================================`);
        console.log(`🚀 SKTorrent Stremio/Nuvio Addon v3.0.3 beží na porte ${PORT}`);
        console.log(`🌐 Public URL: ${process.env.PUBLIC_URL || `automaticky podľa requestu (lokálne http://localhost:${PORT})`}`);
        if (!process.env.ENCRYPTION_KEY) {
            console.log(`⚠️  ENCRYPTION_KEY nie je nastavený — nové linky sa nevygenerujú, staré Base64 stále fungujú`);
        } else {
            console.log(`🔐 Nové linky: AES-256-GCM | staré Base64 linky ostávajú platné`);
        }
        console.log(`======================================================
`);
    });
}

module.exports = app;
module.exports.handler = app;