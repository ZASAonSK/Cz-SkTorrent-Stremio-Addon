// Pôvodne: Judzim/Cz-SkTorrent-Stremio-Addon (AGPL-3.0), upravené pre zlúčený projekt
const { formatBytes, langToFlag, logInfo, logSuccess, logWarn } = require("./common");
const { movieFileMatches } = require("./movie-matcher");
const { stiahnutTorrentData } = require("./sktorrent");
const { jeRDNazovBlokovany } = require("./realdebrid");

// ---------------------------------------------------------------------------
// JAZYKY (rovnaká sada ako badge v Nuvio) - vlajka, slová/skratky (nezáleží na
// veľkosti písmen) a krátke 2-písmenové kódy (rátajú sa len VEĽKÝMI písmenami,
// aby sa nechytali bežné slová ako "it", "no", "he"...)
// ---------------------------------------------------------------------------
const JAZYKY = {
    CZ: { flag: "🇨🇿", slova: ["czech", "cesky", "česky", "ces", "cze", "cz"], kody: ["CS"] },
    SK: { flag: "🇸🇰", slova: ["slovak", "slovensky", "slk", "slo", "sk"], kody: [] },
    EN: { flag: "🇬🇧", slova: ["english", "eng", "en"], kody: [] },
    PL: { flag: "🇵🇱", slova: ["polish", "polski", "pol"], kody: ["PL"] },
    ES: { flag: "🇪🇸", slova: ["spanish", "spa", "esp"], kody: ["ES"] },
    FR: { flag: "🇫🇷", slova: ["french", "fre", "fra"], kody: ["FR"] },
    DE: { flag: "🇩🇪", slova: ["german", "ger", "deu"], kody: ["DE"] },
    IT: { flag: "🇮🇹", slova: ["italian", "ita"], kody: [] },
    PT: { flag: "🇵🇹", slova: ["portuguese", "por"], kody: ["PT"] },
    BR: { flag: "🇧🇷", slova: ["brazilian", "ptbr", "pt-br"], kody: [] },
    RU: { flag: "🇷🇺", slova: ["russian", "rus"], kody: ["RU"] },
    JP: { flag: "🇯🇵", slova: ["japanese", "jpn", "jap"], kody: ["JA", "JP"] },
    KR: { flag: "🇰🇷", slova: ["korean", "kor"], kody: ["KO"] },
    CN: { flag: "🇨🇳", slova: ["chinese", "chi", "zho"], kody: ["ZH", "CN"] },
    IN: { flag: "🇮🇳", slova: ["hindi", "hin"], kody: [] },
    SA: { flag: "🇸🇦", slova: ["arabic", "ara"], kody: [] },
    TR: { flag: "🇹🇷", slova: ["turkish", "tur"], kody: ["TR"] },
    NL: { flag: "🇳🇱", slova: ["dutch", "nld", "dut"], kody: ["NL"] },
    SE: { flag: "🇸🇪", slova: ["swedish", "swe"], kody: ["SV"] },
    NO: { flag: "🇳🇴", slova: ["norwegian", "nob"], kody: [] },
    DK: { flag: "🇩🇰", slova: ["danish", "dan"], kody: ["DA", "DK"] },
    FI: { flag: "🇫🇮", slova: ["finnish", "fin"], kody: ["FI"] },
    HU: { flag: "🇭🇺", slova: ["hungarian", "hun"], kody: ["HU"] },
    RO: { flag: "🇷🇴", slova: ["romanian", "ron", "rum"], kody: ["RO"] },
    UA: { flag: "🇺🇦", slova: ["ukrainian", "ukr"], kody: ["UA"] },
    GR: { flag: "🇬🇷", slova: ["greek", "ell", "gre"], kody: ["EL"] },
    IL: { flag: "🇮🇱", slova: ["hebrew", "heb"], kody: [] },
    TH: { flag: "🇹🇭", slova: ["thai", "tha"], kody: ["TH"] },
    VN: { flag: "🇻🇳", slova: ["vietnamese", "vie"], kody: ["VI"] },
    ID: { flag: "🇮🇩", slova: ["indonesian"], kody: [] },
    MY: { flag: "🇲🇾", slova: ["malay", "msa"], kody: [] },
    HR: { flag: "🇭🇷", slova: ["croatian", "hrv"], kody: ["HR"] },
    RS: { flag: "🇷🇸", slova: ["serbian", "srp"], kody: ["SR"] },
    BG: { flag: "🇧🇬", slova: ["bulgarian", "bul"], kody: ["BG"] },
    SI: { flag: "🇸🇮", slova: ["slovenian", "slovene", "slv"], kody: ["SL"] }
};

const HRANICA_PRED = "(?<![\\p{L}\\p{N}])";
const HRANICA_ZA = "(?![\\p{L}\\p{N}])";
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Predkompilované regexy pre každý jazyk
const JAZYK_REGEXY = Object.entries(JAZYKY).map(([kod, d]) => ({
    kod,
    flag: d.flag,
    reSlova: d.slova.length
        ? new RegExp(`${HRANICA_PRED}(?:${d.slova.map(escRe).join("|")})${HRANICA_ZA}`, "iu")
        : null,
    reKody: d.kody.length
        ? new RegExp(`${HRANICA_PRED}(?:${d.kody.map(escRe).join("|")})${HRANICA_ZA}`, "u")
        : null
}));

// Vráti kódy jazykov (CZ, SK, EN, ...) v poradí, v akom sa objavili v texte
function detekujJazyky(text) {
    const nalezene = [];
    for (const j of JAZYK_REGEXY) {
        let pozicia = -1;
        const idxFlag = text.indexOf(j.flag);
        if (idxFlag !== -1) pozicia = idxFlag;
        for (const re of [j.reSlova, j.reKody]) {
            if (!re) continue;
            const m = re.exec(text);
            if (m && (pozicia === -1 || m.index < pozicia)) pozicia = m.index;
        }
        if (pozicia !== -1) nalezene.push({ kod: j.kod, flag: j.flag, pozicia });
    }
    nalezene.sort((a, b) => a.pozicia - b.pozicia);
    return nalezene;
}

async function vytvoritStream(t, seria, epizoda, userAxios, meta, userConfig) {
    logInfo(`Creating stream for torrent ID: ${t.id} (${t.name})`);

    const debridProv = userConfig?.debridProvider || (userConfig?.torbox ? "torbox" : "");
    const maDebrid = (debridProv === "torbox" && !!userConfig?.torbox) || (debridProv === "realdebrid" && !!userConfig?.realdebrid);

    const maLogin = !!((userConfig?.uid || userConfig?.user_id) && (userConfig?.pass || userConfig?.password));
    let torrentData = null;
    if (!maDebrid || maLogin) {
        torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
        if (!torrentData && !maDebrid) return null;
    }

    let najdenyIndex = -1;
    let najdenyNazovSuboru = null;

    // --- OČISTENIE NÁZVU ---
    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) {
        cistyNazov = cistyNazov.slice(t.category.length).trim();
    }

    // --- VYHĽADANIE KONKRÉTNEJ EPIZÓDY ---
    if (torrentData && seria !== undefined && epizoda !== undefined) {
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
    } else if (torrentData) {
        // --- VYHĽADANIE SÚBORU PRE FILMY ---
        const videoSubory = torrentData.files
            .filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path))
            .sort((a, b) => (b.length || 0) - (a.length || 0));

        if (videoSubory.length > 0) {
            const filmovySubor = videoSubory.find(f => movieFileMatches(f.path, meta)) || videoSubory[0];
            najdenyIndex = filmovySubor.index;
            najdenyNazovSuboru = filmovySubor.path;
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

    const sourceTypes = [];
    if (/\bweb[\s.-]?dl\b/i.test(cistyNazov)) sourceTypes.push('webdl');
    else if (/\bbluray\b|\bbdrip\b|\bbdremux\b/i.test(cistyNazov)) sourceTypes.push('bluray');
    if (/\bhdtv\b/i.test(cistyNazov)) sourceTypes.push('hdtv');
    if (/\bdvdrip\b/i.test(cistyNazov)) sourceTypes.push('dvdrip');
    if (/\bweb[\s.-]?rip\b/i.test(cistyNazov)) sourceTypes.push('webrip');
    if (/\bhdrip\b/i.test(cistyNazov)) sourceTypes.push('hdrip');
    if (/\bppv\b/i.test(cistyNazov)) sourceTypes.push('ppv');
    if (/\b(?:remux|remastered)\b/i.test(cistyNazov)) sourceTypes.push('remux');
    if (/\b(?:cam|tsrip|tele(?:sync|cine)|kino(?:rip)?)\b/i.test(cistyNazov)) sourceTypes.push('cam');
    if (/\b(?:scr(?:eener)?|dvdscr|bdscr|dvdscreener)\b/i.test(cistyNazov)) sourceTypes.push('screener');
    if (/\bvodrip\b|\bvod[-.\s]?rip\b/i.test(cistyNazov)) sourceTypes.push('vodrip');
    if (/\b(?:tvrip|satrip|dvbrip)\b/i.test(cistyNazov)) sourceTypes.push('tvrip');
    const sourceTag = sourceTypes.length > 0 ? sourceTypes.join(',') : 'neznámy';
    const kvalitaText = kvality.length > 0 ? `🎥 ${kvality.join(" • ")}` : "🎥 Kvalita neznáma";

    const hdrFeatures = [];
    if (analyzaNazvu.includes('hdr10')) hdrFeatures.push('hdr10');
    else if (analyzaNazvu.includes('hdr')) hdrFeatures.push('hdr');
    if (analyzaNazvu.includes('dovi') || analyzaNazvu.includes('vision')) hdrFeatures.push('dv');
    if (analyzaNazvu.includes('hevc') || analyzaNazvu.includes('h265') || analyzaNazvu.includes('x265')) hdrFeatures.push('hevc');
    if (analyzaNazvu.includes('atmos')) hdrFeatures.push('atmos');
    const hdrTag = hdrFeatures.length > 0 ? hdrFeatures.join(',') : '';

    const fileSize = torrentData && najdenyIndex !== -1 ?
        (torrentData.files.find(f => f.index === najdenyIndex)?.length || 0) :
        (torrentData ? torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0) : 1048576);
    const formatFileSize = formatBytes(fileSize);
    const velkostText = `💿 ${formatFileSize} (🧩 ${t.size})`;

    // --- JAZYKY: rozpoznáva všetky jazyky z JAZYKY (slová, skratky aj vlajky) ---
    const najdeneJazyky = detekujJazyky(cistyNazov);
    const unikatneKody = najdeneJazyky.map(j => j.kod);
    const unikatneVlajky = najdeneJazyky.map(j => langToFlag[j.kod] || j.flag);
    let jazykText = "Neznámy jazyk";
    const jeSKCZ = unikatneKody.includes("CZ") || unikatneKody.includes("SK");
    if (unikatneVlajky.length > 0) {
        jazykText = unikatneVlajky.join(" / ");
    }
    // Textové kódy navyše, aby ich videli regexy pre badge (CZ SK EN ...)
    const jazykKodyText = unikatneKody.join(" ");

    const seedersText = t.seeds !== undefined ? `👥 Seeders: ${t.seeds}` : "👥 N/A";

    const riadkyTitle = [];
    const showConfig = userConfig && userConfig.show;
    const shouldShow = function(field) {
        if (!showConfig || !Array.isArray(showConfig) || showConfig.length === 0) return true;
        return showConfig.indexOf(field) >= 0;
    };

    if (titleLine) {
        let rokCisty = rokText.replace("📅 ", "");
        riadkyTitle.push(`${titleLine} ${rokCisty !== "N/A" ? `(${rokCisty})` : ""}`);
    }

    if (seriaEpizodaText) {
        riadkyTitle.push(seriaEpizodaText);
    }

    if (shouldShow('lang') || shouldShow('quality')) {
        var langPart = shouldShow('lang') ? jazykText : '';
        var qualPart = shouldShow('quality') ? kvalitaText : '';
        var sep = langPart && qualPart ? '   |   ' : '';
        riadkyTitle.push(`🔊 ${langPart}${sep}${qualPart}`);
    }

    if (shouldShow('size') || shouldShow('seeds')) {
        var sizePart = shouldShow('size') ? velkostText : '';
        var seedPart = shouldShow('seeds') ? seedersText : '';
        var sep2 = sizePart && seedPart ? '   |   ' : '';
        riadkyTitle.push(`${sizePart}${sep2}${seedPart}`);
    }

    if (najdenyNazovSuboru) {
        const ibaNazovSuboru = najdenyNazovSuboru.split('/').pop().split('\\').pop();
        riadkyTitle.push(`📄 Súbor: ${ibaNazovSuboru}`);
    }

    riadkyTitle.push(`🗂️ Torrent: ${cistyNazov}`);

    const bezpecnaVelkost = (fileSize && fileSize > 0) ? fileSize : 1048576;

    const povodnySubor = najdenyNazovSuboru || "video.mkv";
    let cistyNazovSuboru = povodnySubor.split('/').pop().split('\\').pop();

    const kontrolaNazvov = [cistyNazov, najdenyNazovSuboru || ''].filter(Boolean).join(' ');
    const jeRdBlokovany = jeRDNazovBlokovany(kontrolaNazvov);

    // --- BINGE GROUP LOGIKA PRE NUVIO / STREMIO ---
    const hlavneRozlisenie = kvality.find(k => /^(4K|2160p|1080p|720p|480p)$/i.test(k)) || (kvality.length > 0 ? kvality[0] : '1080p');
    const dubLangCode = jeSKCZ ? (unikatneKody.find(k => k === "CZ" || k === "SK") || 'czsk').toLowerCase() : 'orig';
    const dynamickyBingeGroup = `skt-series-${hlavneRozlisenie.toLowerCase()}-${dubLangCode}`;

    const popis = riadkyTitle.join("\n");

    // filename pre badge regexy: názov súboru + názov torrentu + jazykové kódy
    const filenameProBadge = [cistyNazovSuboru, cistyNazov, jazykKodyText].filter(Boolean).join(" ");

    // --- FINÁLNE TVORENIE OBJEKTU ---
    let streamObj = {
        name: `SKT\n${t.category.toUpperCase()}`,
        title: popis,
        description: popis,
        behaviorHints: {
            bingeGroup: dynamickyBingeGroup,
            filename: filenameProBadge,
            videoSize: bezpecnaVelkost
        },
        sktId: t.id,
        fileName: cistyNazovSuboru,
        infoHash: torrentData ? torrentData.infoHash : t.id,
        sources: torrentData ? (torrentData.trackers || []) : [],
        fileIdx: najdenyIndex === -1 ? 0 : najdenyIndex,
        isDub: jeSKCZ,
        seeds: t.seeds,
        languages: unikatneKody,
        _sortHdr: hdrTag,
        _sortSource: sourceTag,
        _sortRdBlocked: jeRdBlokovany ? 1 : 0,
        _sortName: cistyNazov,
        _sortCategory: t.category || "",
        _sortZaner: Array.isArray(t.zanre) ? t.zanre.join(",") : "",
        dubLang: dubLangCode
    };

    return streamObj;
}

module.exports = { vytvoritStream, detekujJazyky };
