const { formatBytes, langToFlag, logInfo, logSuccess, logWarn } = require("./common");
const { movieFileMatches } = require("./movie-matcher");
const { stiahnutTorrentData } = require("./sktorrent");

async function vytvoritStream(t, seria, epizoda, userAxios, meta, userConfig) {
    logInfo(`Creating stream for torrent ID: ${t.id} (${t.name})`);
    const torrentData = await stiahnutTorrentData(t.downloadUrl, userAxios);
    if (!torrentData) return null;

    let najdenyIndex = -1;
    let najdenyNazovSuboru = null;
    let cistyNazov = t.name.replace(/^Stiahni si\s*/i, "").trim();
    if (cistyNazov.toLowerCase().startsWith(t.category.trim().toLowerCase())) cistyNazov = cistyNazov.slice(t.category.length).trim();

    if (seria !== undefined && epizoda !== undefined) {
        const videoSubory = torrentData.files.filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path)).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: "base" }));
        if (videoSubory.length === 0) return null;
        const epCislo = parseInt(epizoda);
        const epStr = String(epCislo).padStart(2, "0");
        const seriaStr = String(seria).padStart(2, "0");

        if (videoSubory.length === 1) {
            const nazovSuboru = videoSubory[0].path;
            const najdeneESubor = nazovSuboru.match(new RegExp(`S${seriaStr}[._-]?E(\\d{1,3})\\b`, "i")) || nazovSuboru.match(new RegExp(`\\b${seria}x(\\d{1,3})\\b`, "i")) || nazovSuboru.match(new RegExp(`Ep(?:isode)?[._\\s]*(\\d{1,3})\\b`, "i")) || nazovSuboru.match(new RegExp(`\\b(\\d{1,3})[._\\s]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i")) || nazovSuboru.match(new RegExp(`\\bE(\\d{1,3})\\b`, "i"));
            if (najdeneESubor && parseInt(najdeneESubor[1]) !== epCislo) return null;
            najdenyIndex = videoSubory[0].index;
            najdenyNazovSuboru = videoSubory[0].path;
        } else {
            const epRegexy = [new RegExp(`[\\\\/](?:\\d+\\.\\s*s[eé]rie[\\\\/])?0*${epCislo}[\\s._-][^\\\\/]*\\.(?:mp4|mkv|avi|m4v)$`, "i"), new RegExp(`\\bS${seriaStr}[._-]?E${epStr}\\b`, "i"), new RegExp(`\\b${seria}x${epStr}\\b`, "i"), new RegExp(`\\b${seriaStr}x${epStr}\\b`, "i"), new RegExp(`\\b${seria}x0*${epCislo}\\b`, "i"), new RegExp(`S${seriaStr}[._-]?E${epStr}(?![0-9])`, "i"), new RegExp(`Ep(?:isode)?[._\\s]*0*${epCislo}\\b`, "i"), new RegExp(`\\b0*${epCislo}[._\\s-]*(?:Epiz[oó]da|Diel|Časť|Cast)\\b`, "i"), new RegExp(`\\bE${epStr}\\b`, "i"), new RegExp(`(?:^|[\\\\/])[\\s._-]*0*${epCislo}[\\s._-].*\\.(?:mp4|mkv|avi|m4v)$`, "i")];
            for (const reg of epRegexy) {
                const zhoda = videoSubory.find(f => reg.test(f.path));
                if (zhoda) { najdenyIndex = zhoda.index; najdenyNazovSuboru = zhoda.path; break; }
            }
            if (najdenyIndex === -1) {
                logWarn(`[TORRENT: ${t.name}] VYRADENÝ! Vo vnútri ${videoSubory.length} súborov nebol nájdený žiadny zodpovedajúci S${seria}E${epizoda}.`);
                return null;
            }
            logSuccess(`[TORRENT: ${t.name}] ÚSPECH! Pre S${seria}E${epizoda} vybraný súbor: ${najdenyNazovSuboru}`);
        }
    } else {
        const videoSubory = torrentData.files.filter(f => /\.(mp4|mkv|avi|m4v)$/i.test(f.path)).sort((a, b) => (b.length || 0) - (a.length || 0));
        if (videoSubory.length > 0) {
            const matchingFile = videoSubory.find(f => movieFileMatches(f.path, meta));
            najdenyIndex = (matchingFile || videoSubory[0]).index;
            najdenyNazovSuboru = (matchingFile || videoSubory[0]).path;
        } else if (torrentData.files.length > 0) {
            const najvacsiSubor = [...torrentData.files].sort((a, b) => (b.length || 0) - (a.length || 0))[0];
            najdenyIndex = najvacsiSubor.index;
            najdenyNazovSuboru = najvacsiSubor.path;
        }
    }

    const titleOriginalText = meta?.titleOriginal ? `${meta.titleOriginal}` : "";
    const titleCzText = meta?.titleCz ? `${meta.titleCz}` : "";
    const titleLine = titleCzText !== "" && titleOriginalText !== "" ? `${titleCzText} / ${titleOriginalText}` : (titleCzText !== "" ? titleCzText : titleOriginalText);
    let rokText = "📅 N/A";
    if (meta?.yearStart) rokText = seria !== undefined && meta.yearEnd && meta.yearStart !== meta.yearEnd ? `📅 ${meta.yearStart}-${meta.yearEnd}` : `📅 ${meta.yearStart}`;
    const seriaEpizodaText = (seria !== undefined && epizoda !== undefined) ? `📺 Séria ${seria} • Epizóda ${epizoda}` : "";
    const analyzaNazvu = cistyNazov.toLowerCase();
    const kvality = [];
    if (analyzaNazvu.includes("2160p") || analyzaNazvu.includes("4k") || analyzaNazvu.includes("uhd")) kvality.push("4K"); else if (analyzaNazvu.includes("1080p") || analyzaNazvu.includes("fhd")) kvality.push("1080p"); else if (analyzaNazvu.includes("720p") || analyzaNazvu.includes("hd")) kvality.push("720p"); else if (analyzaNazvu.includes("480p")) kvality.push("480p");
    if (analyzaNazvu.includes("hdr")) kvality.push("HDR");
    if (analyzaNazvu.includes("dovi") || analyzaNazvu.includes("vision")) kvality.push("Dolby Vision");
    if (analyzaNazvu.includes("hevc") || analyzaNazvu.includes("h265") || analyzaNazvu.includes("h.265") || analyzaNazvu.includes("x265")) kvality.push("HEVC"); else if (analyzaNazvu.includes("x264") || analyzaNazvu.includes("h264") || analyzaNazvu.includes("h.264") || analyzaNazvu.includes("avc")) kvality.push("H.264");
    if (analyzaNazvu.includes("atmos")) kvality.push("Atmos");
    const kvalitaText = kvality.length > 0 ? `🎥 ${kvality.join(" • ")}` : "🎥 Kvalita neznáma";
    const fileSize = najdenyIndex !== -1 ? (torrentData.files.find(f => f.index === najdenyIndex)?.length || 0) : torrentData.files.reduce((acc, f) => acc + (f.length || 0), 0);
    const velkostText = `💿 ${formatBytes(fileSize)} (🧩 ${t.size})`;
    const langMatch = cistyNazov.match(/\b(CZ|SK|EN)\b/ig) || [];
    const unikatneVlajky = [...new Set(langMatch.map(kod => langToFlag[kod.toUpperCase()]).filter(Boolean))];
    let jazykText = "Neznámy jazyk";
    if (unikatneVlajky.length > 0) jazykText = unikatneVlajky.join(" / "); else if (langMatch.length > 0) jazykText = [...new Set(langMatch.map(l => l.toUpperCase()))].join(" / ");
    const seedersText = t.seeds !== undefined ? `👥 Seeders: ${t.seeds}` : "👥 N/A";
    const riadkyTitle = [];
    if (titleLine) { const rokCisty = rokText.replace("📅 ", ""); riadkyTitle.push(`${titleLine} ${rokCisty !== "N/A" ? `(${rokCisty})` : ""}`); }
    if (seriaEpizodaText) riadkyTitle.push(seriaEpizodaText);
    riadkyTitle.push(`🔊 ${jazykText}   |   ${kvalitaText}`);
    riadkyTitle.push(`${velkostText}   |   ${seedersText}`);
    if (najdenyNazovSuboru) riadkyTitle.push(`📄 Súbor: ${najdenyNazovSuboru.split('/').pop().split('\\').pop()}`);
    riadkyTitle.push(`🗂️ Torrent: ${cistyNazov}`);
    const povodnySubor = najdenyNazovSuboru || "video.mkv";
    const fileName = povodnySubor.split('/').pop().split('\\').pop().replace(/[^a-zA-Z0-9.\-]/g, '_');
    return { name: `SKT\n${t.category.toUpperCase()}`, title: riadkyTitle.join("\n"), behaviorHints: { bingeGroup: `sktorrent-${kvality.length > 0 ? kvality.join("-").replace(/\s/g, "") : "standard"}` }, sktId: t.id, fileName, infoHash: torrentData.infoHash, fileIdx: najdenyIndex === -1 ? 0 : najdenyIndex };
}

module.exports = { vytvoritStream };
