const axios = require("axios");
const { decode } = require("entities");
const { logApi, logError, logSuccess, logWarn, withCache } = require("./common");

function parseYearRange(y) {
    if (!y) return { yearStart: null, yearEnd: null };
    const s = String(y).trim();
    const m = s.match(/^(\d{4})(?:\s*-\s*(\d{4})?)?$/);
    if (!m) return { yearStart: null, yearEnd: null };
    return { yearStart: m[1] ? parseInt(m[1]) : null, yearEnd: m[2] ? parseInt(m[2]) : null };
}

async function ziskatVsetkyNazvyARok(zdrojId, vlastnyTyp, tmdbKey) {
    const isTmdbSource = zdrojId.startsWith("tmdb:");
    return withCache(`names_year_v3:${zdrojId}`, 21600000, async () => {
        logApi(`Fetching metadata pre ID: ${zdrojId} (${vlastnyTyp})`);
        const nazvy = new Set();

        let titleOriginal = null;
        let titleCz = null;
        let yearStart = null;
        let yearEnd = null;

        const tmdbTyp = vlastnyTyp === "series" ? "tv" : "movie";
        let imdbId = isTmdbSource ? null : zdrojId;
        let tmdbId = null;

        if (isTmdbSource) {
            tmdbId = zdrojId.split(":")[1];
            if (!tmdbKey) {
                logWarn(`TMDB ID ${tmdbId} prišlo, ale chýba TMDB API kľúč v konfigurácii.`);
                return { nazvy: [], rok: null, meta: {}, imdbId: null };
            }

            try {
                const det = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}`, {
                    params: { api_key: tmdbKey }, timeout: 4000
                });
                if (vlastnyTyp === "series") {
                    titleOriginal = det.data?.original_name || null;
                    if (det.data?.name) { nazvy.add(det.data.name); titleCz = det.data.name; }
                    if (det.data?.first_air_date) yearStart = parseInt(det.data.first_air_date.slice(0, 4));
                    if (det.data?.last_air_date) yearEnd = parseInt(det.data.last_air_date.slice(0, 4));
                } else {
                    titleOriginal = det.data?.original_title || null;
                    if (det.data?.title) { nazvy.add(det.data.title); titleCz = det.data.title; }
                    if (det.data?.release_date) yearStart = parseInt(det.data.release_date.slice(0, 4));
                }
                if (titleOriginal) nazvy.add(titleOriginal);

                const trans = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, {
                    params: { api_key: tmdbKey }, timeout: 4000
                });
                if (trans.data?.translations) {
                    trans.data.translations.forEach(tr => {
                        const name = (tr.data || {}).title || (tr.data || {}).name;
                        if (name && ["cs", "sk", "en"].includes(tr.iso_639_1)) {
                            nazvy.add(name);
                            if (tr.iso_639_1 === "cs") titleCz = name;
                        }
                    });
                }

                try {
                    const ext = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/external_ids`, {
                        params: { api_key: tmdbKey }, timeout: 4000
                    });
                    imdbId = ext.data?.imdb_id || null;
                    if (imdbId) {
                        logSuccess(`TMDB ${tmdbId} má aj IMDb ID: ${imdbId}.`);
                        const cineRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${vlastnyTyp}/${imdbId}.json`, { timeout: 4000 }).catch(() => null);
                        if (cineRes?.data?.meta?.aliases) cineRes.data.meta.aliases.forEach(a => nazvy.add(decode(a).trim()));
                    }
                } catch (_) { /* IMDb enrichment is optional. */ }
            } catch (error) {
                logError(`Zlyhalo TMDB fetch pre tmdbId=${tmdbId}`, error);
                return { nazvy: [], rok: null, meta: {}, imdbId: null };
            }

            const vysledokNazvy = [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
            return { nazvy: vysledokNazvy, rok: yearStart, meta: { titleOriginal: titleOriginal || titleCz, titleCz, yearStart, yearEnd }, imdbId };
        }

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

        if (tmdbRes && tmdbRes.data) {
            if (vlastnyTyp === "series" && tmdbRes.data.tv_results?.length > 0) {
                const res = tmdbRes.data.tv_results[0];
                tmdbId = res.id;
                nazvy.add(res.name);
            } else if (vlastnyTyp === "movie" && tmdbRes.data.movie_results?.length > 0) {
                const res = tmdbRes.data.movie_results[0];
                tmdbId = res.id;
                nazvy.add(res.title);
            }
        }

        if (tmdbKey && tmdbId) {
            try {
                if (vlastnyTyp === "series") {
                    const det = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (!titleOriginal && det.data?.original_name) titleOriginal = det.data.original_name;
                    if (!yearStart && det.data?.first_air_date) yearStart = parseInt(det.data.first_air_date.slice(0, 4));
                    if (!yearEnd && det.data?.last_air_date) yearEnd = parseInt(det.data.last_air_date.slice(0, 4));
                } else {
                    const det = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, { params: { api_key: tmdbKey }, timeout: 4000 });
                    if (!titleOriginal && det.data?.original_title) titleOriginal = det.data.original_title;
                    if (!yearStart && det.data?.release_date) yearStart = parseInt(det.data.release_date.slice(0, 4));
                }

                const trans = await axios.get(`https://api.themoviedb.org/3/${tmdbTyp}/${tmdbId}/translations`, { params: { api_key: tmdbKey }, timeout: 4000 });
                if (trans.data?.translations) {
                    trans.data.translations.forEach(tr => {
                        const m = (tr.data || {}).title || (tr.data || {}).name;
                        if (m && ["cs", "sk", "en"].includes(tr.iso_639_1)) {
                            nazvy.add(m);
                            if (tr.iso_639_1 === "cs" && m) titleCz = m;
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        if (!titleOriginal) titleOriginal = titleCz;

        const vysledokNazvy = [...nazvy].filter(Boolean).filter(t => !t.toLowerCase().startsWith("výsledky"));
        return {
            nazvy: vysledokNazvy,
            rok: yearStart,
            meta: { titleOriginal, titleCz, yearStart, yearEnd },
            imdbId
        };
    });
}

module.exports = { ziskatVsetkyNazvyARok };
