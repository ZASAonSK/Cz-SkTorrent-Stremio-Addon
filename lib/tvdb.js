// Pôvodne: Judzim/Cz-SkTorrent-Stremio-Addon (AGPL-3.0), upravené pre zlúčený projekt
const axios = require("axios");
const { logApi, logError, logSuccess, logWarn } = require("./common");


// ── TVDB global token cache ──────────────────────────────────────────────
let tvdbTokenCache = { token: null, expiresAt: 0 };

async function getTvdbToken(tvdbKey) {
    if (tvdbKey && tvdbTokenCache.token && Date.now() < tvdbTokenCache.expiresAt - 60000) {
        return tvdbTokenCache.token;
    }
    try {
        const res = await axios.post("https://api4.thetvdb.com/v4/login", { apikey: tvdbKey }, { timeout: 5000 });
        const data = res.data?.data;
        if (data?.token) {
            tvdbTokenCache.token = data.token;
            tvdbTokenCache.expiresAt = Date.now() + 3600000; // 1h default
            logSuccess(`TVDB token obtained`);
            return data.token;
        }
    } catch (e) { logError("TVDB login failed", e); }
    return null;
}

async function pridajTvdbNazvy(nazvy, tvdbId, tvdbKey) {
    const token = await getTvdbToken(tvdbKey);
    if (!token) return;
    
    // Paralelne namiesto sekvenčne — 3 volania naraz (ušetrí ~2x latenciu)
    await Promise.allSettled(["slk", "ces", "eng"].map(async (lang) => {
        try {
            const res = await axios.get(`https://api4.thetvdb.com/v4/series/${tvdbId}/translations/${lang}`, {
                headers: { "Authorization": `Bearer ${token}` },
                timeout: 4000
            });
            const name = res.data?.data?.name;
            if (name && name.trim()) {
                nazvy.add(name.trim());
                logApi(`TVDB (${lang}): ${name.trim()}`);
            }
        } catch (e) { /* translation not found for this lang, skip */ }
    }));
}

// IMDb suggestion fallback — keď Cinemeta aj TMDB zlyhajú (nové/neznáme tituly).
// IMDb suggestion API je verejné, bez kľúča: https://v2.sg.media-imdb.com/suggestion/t/<id>.json
async function pridajImdbSuggestionNazov(nazvy, imdbId) {
    if (!imdbId || !/^tt\d+$/.test(imdbId)) return false;
    try {
        const res = await axios.get(`https://v2.sg.media-imdb.com/suggestion/t/${imdbId}.json`, {
            timeout: 4000
        });
        const item = res.data?.d?.[0];
        if (item?.l && item.l.trim()) {
            nazvy.add(item.l.trim());
            logApi(`IMDb suggestion: ${item.l.trim()}`);
            return true;
        }
    } catch (e) { /* ignore */ }
    return false;
}

// TMDB fallback podľa TMDB ID — pre seriály z AioMetadata (tmdb:295879),
// ktoré Cinemeta nepozná. Používa tmdbKey z user configu (rovnaký vzor ako ziskatVsetkyNazvyARok).
async function pridajTmdbNazvy(nazvy, tmdbId, tmdbKey) {
    if (!tmdbKey) return;
    try {
        const [det, trans] = await Promise.all([
            axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 }).catch(() => null),
            axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}/translations`, { params: { api_key: tmdbKey }, timeout: 4000 }).catch(() => null)
        ]);
        if (det?.data) {
            if (det.data.name) nazvy.add(det.data.name.trim());
            if (det.data.original_name && det.data.original_name !== det.data.name) nazvy.add(det.data.original_name.trim());
        }
        if (trans?.data?.translations) {
            ["sk", "cs", "en"].forEach(lang => {
                const t = trans.data.translations.find(x => x.iso_639_1 === lang && x.data?.name);
                if (t?.data?.name) nazvy.add(t.data.name.trim());
            });
        }
    } catch (e) { /* ignore */ }
}

// TVDB fallback podľa IMDb ID — pre seriály, ktoré TMDB nepozná
// (napr. nové SK/CZ relácie ako "Párty Shore Slovensko" — TMDB prázdne,
// ale TVDB ich má). Search podľa imdbId → TVDB ID → preklady názvov.
async function pridajTvdbNazvyPodlaImdb(nazvy, imdbId, tvdbKey) {
    if (!imdbId || !tvdbKey) return false;
    const token = await getTvdbToken(tvdbKey);
    if (!token) return false;
    try {
        const res = await axios.get("https://api4.thetvdb.com/v4/search", {
            params: { imdbId },
            headers: { "Authorization": `Bearer ${token}` },
            timeout: 5000
        });
        const items = res.data?.data;
        if (Array.isArray(items) && items.length > 0) {
            const tvdbId = items[0].id;
            logApi(`TVDB search IMDb ${imdbId} → TVDB ID ${tvdbId}`);
            await pridajTvdbNazvy(nazvy, tvdbId, tvdbKey);
            return true;
        }
    } catch (e) {
        logWarn(`TVDB search IMDb ${imdbId} zlyhal: ${e.message}`);
    }
    return false;
}

module.exports = { getTvdbToken, pridajTvdbNazvy, pridajImdbSuggestionNazov, pridajTmdbNazvy, pridajTvdbNazvyPodlaImdb };
