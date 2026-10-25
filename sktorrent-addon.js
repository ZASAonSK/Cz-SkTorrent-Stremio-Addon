// SKTorrent Stremio/Nuvio Addon - zlúčený projekt (ZASAonSK + Judzim)
// Časti pôvodne z Judzim/Cz-SkTorrent-Stremio-Addon sú pod AGPL-3.0 (pozri LICENSE).
require("dotenv").config();
require("./lib/env-setup");
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const FormData = require("form-data");
const path = require("path");
const cors = require("cors");
const {
    decodeConfig, encodeConfig, getFastAxios, getQualityRank, getSizeBytes,
    logApi, logError, logInfo, logSuccess, logWarn, odstranDiakritiku, pLimit, skratNazov, withCache
} = require("./lib/common");
const { pockajNaTorrentFiles } = require("./lib/torbox");
const { overitDebridCache, rdAddMagnet, rdSelectFiles, rdTorrentInfo, rdUnrestrictLink, rdListTorrents, zapisatDoRdCache } = require("./lib/realdebrid");
const { hladatTorrenty, stiahnutSurovyTorrent } = require("./lib/sktorrent");
const { ziskatVsetkyNazvyARok } = require("./lib/metadata");
const { pridajTvdbNazvy } = require("./lib/tvdb");
const { ziskatCsfdUrl } = require("./lib/csfd");
const { vyfiltrujMovieTorrenty } = require("./lib/movie-matcher");
const { torrentSediSEpizodou, torrentSedisSeriou } = require("./lib/episode-matcher");
const { vytvoritStream } = require("./lib/stream-builder");
const { maskConfigVUrl, asyncRoute, skontrolujLoginRateLimit } = require("./lib/security");
const { spustitPrecacheDalsejEpizody, precacheIdMap } = require("./lib/precache");
const pkg = require("./package.json");

const PORT = process.env.PORT || 7000;
const BASE_URL = "https://sktorrent.eu";
// Ko-fi odkaz sa zobrazí na konfiguračnej stránke len ak je nastavený (KOFI_URL=https://ko-fi.com/tvoje-meno)
const KOFI_URL = String(process.env.KOFI_URL || "").trim();

function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
}

function getPublicBaseUrl(req) {
    const configured = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
    if (configured) return configured;
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const protocol = forwardedProto || req.protocol || "https";
    return `${protocol}://${req.get("host")}`.replace(/\/+$/, "");
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "32kb" }));

app.use((req, res, next) => {
    // Referer nesmie uniknúť na CDN/debrid (URL obsahuje config s kľúčmi používateľa)
    res.setHeader("Referrer-Policy", "no-referrer");
    logInfo(`HTTP ${req.method} ${maskConfigVUrl(req.originalUrl)}`);
    next();
});

app.get("/health", (req, res) => {
    res.json({ ok: true, service: "sktorrent-addon", version: pkg.version });
});

app.get("/health/csfd", (req, res) => {
    res.json({ ok: true, tmdbWikidataFallback: true });
});

// --- Generovanie šifrovaného config tokenu ---
const CFG_STR = ["uid", "pass", "debridProvider", "torbox", "realdebrid", "tmdb", "tvdb", "sizeOrder", "maxResults", "maxPerRes", "maxSize", "minSeeds"];
const CFG_ARR = ["lang", "show", "hdr", "adult", "source", "res", "sort", "qualityOrder"];
const CFG_BOOL = ["cachedOnly", "precacheNextEpisode", "showUncached"];

function sanitizeConfig(body) {
    const out = {};
    for (const k of CFG_STR) if (body[k] !== undefined && body[k] !== null) out[k] = String(body[k]).slice(0, 512);
    for (const k of CFG_ARR) {
        if (Array.isArray(body[k])) out[k] = body[k].slice(0, 20).map(x => (typeof x === "number" ? x : String(x).slice(0, 32)));
    }
    for (const k of CFG_BOOL) if (body[k] !== undefined) out[k] = Boolean(body[k]);
    if (!["", "p2p", "torbox", "realdebrid"].includes(out.debridProvider || "")) delete out.debridProvider;
    out.cb = Date.now();
    return out;
}

app.post("/api/config-token", (req, res) => {
    const cfg = sanitizeConfig(req.body || {});
    const provider = cfg.debridProvider || "";
    const ok = (cfg.uid && cfg.pass) || (provider === "torbox" && cfg.torbox) || (provider === "realdebrid" && cfg.realdebrid);
    if (!ok) {
        return res.status(400).json({ error: "Chýba SKTorrent UID/PASS alebo API kľúč debrid služby." });
    }
    if (process.env.ENCRYPTION_KEY) {
        try {
            return res.json({ token: encodeConfig(cfg) });
        } catch (error) {
            logError("Failed to encrypt config", error);
            return res.status(500).json({ error: "Šifrovanie configu zlyhalo." });
        }
    }
    if (process.env.ALLOW_PLAINTEXT_CONFIG === "1") {
        return res.json({ token: Buffer.from(JSON.stringify(cfg), "utf8").toString("base64url") });
    }
    return res.status(503).json({ error: "ENCRYPTION_KEY nie je nastavený na serveri." });
});

// --- API: SKTorrent login proxy ---
app.post('/api/sktorrent-login', asyncRoute(async (req, res) => {
    if (skontrolujLoginRateLimit(req.ip || "unknown")) {
        return res.status(429).json({ error: 'Príliš veľa pokusov o prihlásenie, skús to neskôr.' });
    }
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Chýba meno alebo heslo' });
    }
    try {
        const loginRes = await axios({
            method: 'post',
            url: 'https://sktorrent.eu/torrent/login.php',
            data: `uid=${encodeURIComponent(username)}&pwd=${encodeURIComponent(password)}`,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
                'Origin': 'https://sktorrent.eu',
                'Referer': 'https://sktorrent.eu/torrent/'
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });

        const setCookie = loginRes.headers['set-cookie'];
        if (!setCookie || !Array.isArray(setCookie) || setCookie.length === 0) {
            return res.status(401).json({ error: 'Nesprávne meno alebo heslo' });
        }

        let uid = '', pass = '';
        for (const cookie of setCookie) {
            if (cookie.startsWith('uid=')) uid = cookie.split(';')[0].substring(4);
            if (cookie.startsWith('pass=')) pass = cookie.split(';')[0].substring(5);
        }

        if (!uid || !pass) {
            return res.status(401).json({ error: 'Nesprávne meno alebo heslo' });
        }
        logSuccess('SKTorrent login OK');
        res.json({ uid, pass, username });
    } catch (error) {
        logError('SKTorrent login proxy error', error);
        res.status(500).json({ error: 'Chyba pri prihlasovaní k SKTorrent' });
    }
}));
app.get('/', (req, res) => {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(302, '/configure' + qs);
});


app.get(['/configure', '/:config/configure'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Config môže prísť v ceste (/<config>/configure), ako ?config=<token> alebo ako ?manifest=<url manifestu>
    // (rôzne klienty - Stremio, Nuvio - otvárajú konfiguráciu rôzne)
    let cfgToken = req.params.config || (typeof req.query.config === 'string' ? req.query.config : '');
    if (!cfgToken) {
        const mu = req.query.manifest || req.query.manifestUrl || req.query.url;
        const mm = typeof mu === 'string' ? mu.match(/\/([^\/?#]+)\/manifest\.json/) : null;
        if (mm) cfgToken = decodeURIComponent(mm[1]);
    }
    let currentConfig = {};
    if (cfgToken) {
        try {
            currentConfig = decodeConfig(cfgToken) || {};
        } catch (e) {
            console.error("Chyba pri dekódovaní configu:", e);
        }
    }
    logInfo(`Configure: config ${cfgToken ? (Object.keys(currentConfig).length ? 'načítaný (provider: ' + (currentConfig.debridProvider || (currentConfig.torbox ? 'torbox' : 'žiadny')) + ')' : 'prijatý, ale NEDEKÓDOVATEĽNÝ (zlý ENCRYPTION_KEY?)') : 'chýba v URL'}`);

    const getVal = (key) => currentConfig[key] ? currentConfig[key] : '';
    const getCheck = (key, defaultVal) => {
        if (currentConfig[key] !== undefined) return currentConfig[key] ? 'checked' : '';
        return defaultVal ? 'checked' : '';
    };
    const getSelect = (key, val, defaultVal) => {
        if (currentConfig[key] !== undefined) return currentConfig[key] === val ? 'selected' : '';
        return val === defaultVal ? 'selected' : '';
    };
    const hasArrVal = (key, val, defaultActive) => {
        const v = currentConfig[key];
        if (v === undefined) return defaultActive ? 'active' : '';
        if (Array.isArray(v)) return v.includes(val) ? 'active' : '';
        return String(v).split(',').includes(val) ? 'active' : '';
    };
    const getSortSelectVal = (idx) => {
        const sort = currentConfig.sort;
        if (sort && Array.isArray(sort) && sort[idx]) return sort[idx];
        if (sort && typeof sort === 'string') {
            try { const arr = JSON.parse(sort); if (arr[idx]) return arr[idx]; } catch(e) {}
        }
        return ['cached','quality','lang','seeds','size'][idx] || 'cached';
    };


    const html = `
    <!DOCTYPE html>
    <html lang="sk">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SKTorrent</title>
        <link rel="icon" type="image/png" href="/logo.png">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f6f7fb; background: radial-gradient(circle at 15% 0%, #30225e 0, transparent 34rem), radial-gradient(circle at 90% 100%, #123d4a 0, transparent 32rem), #090a10; display: flex; justify-content: center; padding: 42px 20px; }
            :root { color-scheme: dark; }
            .container { position: relative; background: rgba(22,24,36,.92); padding: 0; border: 1px solid rgba(255,255,255,.1); border-radius: 24px; width: 100%; max-width: 540px; box-shadow: 0 24px 80px rgba(0,0,0,.42); backdrop-filter: blur(18px); overflow: hidden; height: fit-content; }
            .container::before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: linear-gradient(90deg, #a970ff, #75d6ff, #24c87a); }
            .header { background: transparent; padding: 32px 24px 20px; text-align: center; border-bottom: 1px solid rgba(255,255,255,.1); }
            .header h2 { font-size: 26px; font-weight: 750; letter-spacing: -.6px; color: #f6f7fb; }
            .header h2::before { content: ""; display: block; width: 64px; height: 64px; margin: 0 auto 13px; border-radius: 16px; background: url('/logo.png') center / cover no-repeat; box-shadow: 0 10px 26px rgba(145,100,255,.35); }
            .header p { font-size: 13px; color: #888; margin-top: 6px; }

            .section { border-bottom: 1px solid rgba(255,255,255,.12); }
            .section:last-child { border-bottom: none; }
            .section-header { display: flex; align-items: center; gap: 10px; padding: 16px 20px 8px; font-size: 13px; font-weight: 600; color: #a970ff; text-transform: uppercase; letter-spacing: 0.5px; }
            .section-header .icon { font-size: 18px; }
            .section-desc { padding: 0 20px 12px; font-size: 12px; color: #666; }

            .field { padding: 8px 20px; }
            .field label { display: block; font-size: 12px; font-weight: 600; color: #aaa; margin-bottom: 4px; }
            .field input, .field select { width: 100%; padding: 10px 12px; background: rgba(4,5,11,.45); border: 1px solid rgba(255,255,255,.12); color: #e0e0e0; border-radius: 11px; font-size: 14px; outline: none; transition: border-color .18s, box-shadow .18s; }
            .field input:focus, .field select:focus { border-color: #a970ff; box-shadow: 0 0 0 3px rgba(169,112,255,.16); }
            .field select { cursor: pointer; appearance: auto; }

            .checkbox-row { display: flex; align-items: center; gap: 10px; padding: 6px 20px; cursor: pointer; }
            .checkbox-row:hover { background: rgba(169,112,255,0.05); }
            .checkbox-row input[type="checkbox"] { width: 18px; height: 18px; accent-color: #a970ff; cursor: pointer; }
            .checkbox-row .label-text { font-size: 14px; color: #ccc; }
            .checkbox-row .label-desc { font-size: 11px; color: #666; margin-left: auto; }

            .chip-group { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 20px; }
            .chip { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; background: rgba(4,5,11,.45); border: 1px solid rgba(255,255,255,.12); border-radius: 20px; font-size: 13px; color: #ccc; cursor: pointer; transition: all 0.2s; user-select: none; }
            .chip:hover { border-color: #a970ff; }
            .chip.active { border-color: #a970ff; color: #efe6ff; background: rgba(169,112,255,0.2); }

            .sort-row { display: flex; align-items: center; gap: 8px; padding: 6px 20px; }
            .sort-row .num { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: rgba(4,5,11,.45); border: 1px solid rgba(255,255,255,.12); border-radius: 50%; font-size: 11px; color: #666; flex-shrink: 0; }
            .sort-row select { flex: 1; padding: 8px 10px; background: rgba(4,5,11,.45); border: 1px solid rgba(255,255,255,.12); color: #e0e0e0; border-radius: 8px; font-size: 13px; outline: none; cursor: pointer; }
            .sort-row select:focus { border-color: #a970ff; }
            .sort-btn { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; background: rgba(4,5,11,.45); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; color: #666; cursor: pointer; font-size: 14px; flex-shrink: 0; transition: all 0.2s; }
            .sort-btn:hover { border-color: #a970ff; color: #a970ff; }
            .sort-btn:disabled { opacity: 0.3; cursor: not-allowed; }
            .sort-toggle { width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #a970ff; cursor: pointer; font-size: 16px; flex-shrink: 0; padding: 0; transition: opacity 0.2s; }
            .sort-toggle:hover { opacity: 0.7; }

            .btn-primary { width: calc(100% - 40px); margin: 16px 20px; padding: 12px; background: linear-gradient(135deg, #a970ff, #6f5cff); color: white; border: none; font-size: 15px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: all 0.2s; }
            .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(169,112,255,0.4); }

            #result-box { display: none; margin: 0 20px 20px; padding: 20px; background: rgba(169,112,255,0.06); border: 1px solid #a970ff; border-radius: 10px; text-align: center; }
            #result-box p { font-size: 12px; color: #a970ff; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
            #generated-url { width: 100%; font-size: 12px; font-family: 'Courier New', monospace; padding: 10px; margin-bottom: 14px; background: rgba(4,5,11,.45); color: #e0e0e0; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; word-break: break-all; resize: none; height: 52px; outline: none; transition: border 0.2s; }
            #generated-url:focus { border-color: #a970ff; }
            .btn-sm { padding: 8px 16px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; font-size: 13px; cursor: pointer; margin: 3px; transition: all 0.2s; }
            .btn-copy { background: rgba(4,5,11,.45); color: #ccc; }
            .btn-copy:hover { background: rgba(169,112,255,0.2); border-color: #a970ff; color: #fff; }
            .btn-install { background: linear-gradient(135deg, #a970ff, #6f5cff); color: white; border: none; }
            .btn-install:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(169,112,255,0.4); }
            .lang-btn { background:none; border:1px solid rgba(255,255,255,.12); border-radius:6px; padding:4px 10px; font-size:13px; color:#ccc; cursor:pointer; transition:all 0.2s; }
            .lang-btn:hover { border-color: #a970ff; }
            .lang-btn.active { border-color: #a970ff; background: rgba(169,112,255,0.2); color:#efe6ff; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div style="display:flex;align-items:stretch;justify-content:space-between;gap:12px;">
                    <div style="flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;gap:4px;min-width:36px;">
                        <button class="lang-btn active" data-lang-btn="sk" onclick="setLang('sk')" style="display:block;width:100%;">🇸🇰</button>
                        <button class="lang-btn" data-lang-btn="en" onclick="setLang('en')" style="display:block;width:100%;">🇬🇧</button>
                    </div>
                    <div style="flex:1;text-align:center;display:flex;flex-direction:column;justify-content:center;">
                        <h2 data-i18n="title">SKTorrent</h2>
                        <p data-i18n="subtitle" style="font-size:13px;color:#888;margin-top:4px;">Nastav si preferencie a vygeneruj inštalačný odkaz</p>
                    </div>
                    <div style="flex:0 0 auto;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;min-width:36px;">
                        <a href="https://github.com/ZASAonSK/Cz-SkTorrent-Stremio-Addon" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;color:#888;transition:color 0.2s;margin-left:-2px;" title="GitHub">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                        </a>
${KOFI_URL ? `
                        <a href="${KOFI_URL}" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;transition:opacity 0.2s;" title="Ko-fi">
                            <img src="/ko-fi-logo.jpg" alt="Ko-fi" style="width:95%;height:95%;object-fit:contain;border-radius:3px;">
                        </a>
` : ''}
                    </div>
                </div>
            </div>

            <!-- 🔌 Connection -->
            <div class="section">
                <div class="section-header"><span class="icon">🔌</span> <span data-i18n="section.connection">Connection</span></div>
                <div class="section-desc" data-i18n="desc.connection">Prihlasovacie údaje a API kľúče</div>
                
                <!-- Najprv výber služby -->
                <div class="field" id="debridServiceField">
                    <label data-i18n="label.debrid">Debrid služba</label>
                    <select id="debridProvider" onchange="toggleDebridFields()">
                        <option value="" ${getSelect('debridProvider','','') || (!currentConfig.debridProvider && !currentConfig.torbox ? 'selected' : '')} data-i18n="debrid.choose">— Vyber —</option>
                        <option value="p2p" data-i18n="debrid.p2p">Klasický torrent (P2P)</option>
                        <option value="torbox" ${getSelect('debridProvider','torbox','') || (currentConfig.torbox && !currentConfig.debridProvider ? 'selected' : '')}>TorBox</option>
                        <option value="realdebrid" ${getSelect('debridProvider','realdebrid','')}>Real-Debrid</option>
                    </select>
                </div>

                <!-- SKTorrent login — vždy viditeľný (zrýchli vyhľadávanie aj v debrid móde) -->
                <div id="sktorrentSection" style="display:block;padding-left:16px;border-left:2px solid #333;margin:0 20px 8px;">
                <div class="field" id="loginFields" style="display:block;">
                    <label>🔑 <span data-i18n="label.sktorrentLogin">Prihlásiť sa na SKTorrent</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.sktorrentLogin.optional">(voliteľné)</span></label>
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <input type="text" id="loginUser" data-i18n-placeholder="login.uid.placeholder" placeholder="Používateľské meno" style="flex:1;min-width:120px;">
                        <input type="password" id="loginPass" data-i18n-placeholder="login.pass.placeholder" placeholder="Heslo" style="flex:1;min-width:120px;">
                    </div>
                    <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;">
                        <button id="loginBtn" onclick="loginToSKTorrent()" style="padding:8px 16px;background:linear-gradient(135deg,#a970ff,#6f5cff);color:white;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;" data-i18n="button.login">Prihlásiť sa</button>
                        <a href="https://sktorrent.eu/torrent/account.php" target="_blank" rel="noopener" style="padding:8px 16px;background:#333;color:#999;border:none;border-radius:8px;font-size:13px;font-weight:400;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;" data-i18n="button.register">Registrovať sa</a>
                    </div>
                    <div id="loginStatus" style="font-size:12px;margin-top:6px;"></div>
                </div>
                
                <div id="manualSection">
                <!-- Hidden uid/pass fields (vyplnia sa automaticky po prihlásení) -->
                <div id="hiddenCredentials" style="display:none;">
                    <input type="hidden" id="uid" value="">
                    <input type="hidden" id="pass" value="">
                </div>
                
                <!-- Manual fallback - ak niekto chce rucne zadat uid/pass -->
                <div style="padding:0 0 8px;">
                    <a href="#" onclick="toggleManualFields(event)" style="font-size:12px;color:#666;text-decoration:none;" data-i18n="link.manual">▶ Manuálne zadať UID a PASS</a>
                </div>
                <div id="manualFields" style="display:none;">
                    <div class="field">
                        <label data-i18n="label.uid">SKTorrent UID</label>
                        <input type="text" id="manualUid" data-i18n-placeholder="uid.placeholder" placeholder="Napr. 123987" value="${getVal('uid')}">
                        <div style="font-size:11px;color:#666;margin-top:2px;" data-i18n="uid.help">ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu</div>
                    </div>
                    <div class="field">
                        <label data-i18n="label.pass">SKTorrent pass</label>
                        <input type="password" id="manualPass" data-i18n-placeholder="pass.placeholder" placeholder="Tvoj pass" value="${getVal('pass')}">
                        <div style="font-size:11px;color:#666;margin-top:2px;" data-i18n="pass.help">ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu</div>
                    </div>
                </div>
                </div>
                </div>
                <div class="field" id="torboxField" style="display:${currentConfig.debridProvider === 'torbox' || (!currentConfig.debridProvider && currentConfig.torbox) ? '' : 'none'};">
                    <label data-i18n="label.torbox">TorBox API kľúč</label>
                    <input type="text" id="torbox" data-i18n-placeholder="torbox.placeholder" placeholder="TorBox token" value="${getVal('torbox')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://torbox.app/settings?section=account" target="_blank" rel="noopener" style="color:#a970ff;text-decoration:none;" data-i18n-link="torbox.help">🔗 torbox.app/settings?section=account</a></div>
                </div>
                <div class="field" id="realdebridField" style="display:${currentConfig.debridProvider === 'realdebrid' ? '' : 'none'};">
                    <label data-i18n="label.realdebrid">Real-Debrid API kľúč</label>
                    <input type="text" id="realdebrid" data-i18n-placeholder="realdebrid.placeholder" placeholder="Real-Debrid API token" value="${getVal('realdebrid')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://real-debrid.com/devices" target="_blank" rel="noopener" style="color:#a970ff;text-decoration:none;" data-i18n-link="realdebrid.help">🔗 real-debrid.com/devices</a></div>
                </div>
                <div class="field">
                    <label><span data-i18n="label.tmdb">TMDB API kľúč</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.tmdb.optional">(voliteľné)</span></label>
                    <input type="text" id="tmdb" data-i18n-placeholder="tmdb.placeholder" placeholder="TMDB token" value="${getVal('tmdb')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener" style="color:#a970ff;text-decoration:none;" data-i18n-link="tmdb.help">🔗 themoviedb.org/settings/api</a></div>
                </div>
                <div class="field" style="padding-bottom:16px;">
                    <label><span data-i18n="label.tvdb">TVDB API kľúč</span> <span style="color:#666;font-weight:400;" data-i18n-optional="label.tvdb.optional">(voliteľné)</span></label>
                    <input type="text" id="tvdb" data-i18n-placeholder="tvdb.placeholder" placeholder="TVDB token" value="${getVal('tvdb')}">
                    <div style="font-size:11px;color:#666;margin-top:2px;"><a href="https://thetvdb.com/dashboard/account/apikey" target="_blank" rel="noopener" style="color:#a970ff;text-decoration:none;" data-i18n-link="tvdb.help">🔗 thetvdb.com/dashboard/account/apikey</a></div>
                </div>
            </div>

            <!-- 🌐 Language & Display -->
            <div class="section">
                <div class="section-header"><span class="icon">🌐</span> <span data-i18n="section.display">Language &amp; Display</span></div>
                <div class="section-desc" data-i18n="desc.display">Nastavenia jazyka a zobrazenia výsledkov</div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.preferLangs">Preferované jazyky</label></div>
                <div class="chip-group" id="langChips">
                    <span class="chip ${hasArrVal('lang','sk',true)}" data-lang="sk" onclick="toggleChip(this)">🇸🇰 SK</span>
                    <span class="chip ${hasArrVal('lang','cz',true)}" data-lang="cz" onclick="toggleChip(this)">🇨🇿 CZ</span>
                    <span class="chip ${hasArrVal('lang','en',false)}" data-lang="en" onclick="toggleChip(this)">🇬🇧 EN</span>
                    <span class="chip ${hasArrVal('lang','multi',false)}" data-lang="multi" onclick="toggleChip(this)">🌍 Multi</span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.showInStream">Zobraziť v názve streamu</label></div>
                <div class="chip-group" id="showChips" style="padding-bottom:12px;">
                    <span class="chip ${hasArrVal('show','title',true)}" data-show="title" onclick="toggleChip(this)"><span data-i18n="chip.title">Názov</span></span>
                    <span class="chip ${hasArrVal('show','quality',true)}" data-show="quality" onclick="toggleChip(this)"><span data-i18n="chip.quality">Kvalita</span></span>
                    <span class="chip ${hasArrVal('show','size',true)}" data-show="size" onclick="toggleChip(this)"><span data-i18n="chip.size">Veľkosť</span></span>
                    <span class="chip ${hasArrVal('show','lang',true)}" data-show="lang" onclick="toggleChip(this)"><span data-i18n="chip.lang">Jazyk</span></span>
                    <span class="chip ${hasArrVal('show','seeds',true)}" data-show="seeds" onclick="toggleChip(this)"><span data-i18n="chip.seeds">Seedery</span></span>
                </div>
            </div>

            <!-- 🎚️ Quality & Filters -->
            <div class="section">
                <div class="section-header"><span class="icon">🎚️</span> <span data-i18n="section.filters">Quality &amp; Filters</span></div>
                <div class="section-desc" data-i18n="desc.filters">Obmedz kvalitu, veľkosť a počet výsledkov</div>

                <div class="checkbox-row" id="cachedOnlyRow" onclick="toggleCheckbox('cachedOnly', event)">
                    <input type="checkbox" id="cachedOnly" onchange="aktualizujCachedOnlyWarning()" ${getCheck('cachedOnly', false)}>
                    <span class="label-text" data-i18n="checkbox.cached">Cached Only</span>
                    <span class="label-desc" data-i18n="checkbox.cached.desc">Len cachované streamy</span>
                </div>
                <div id="cachedOnlyRdWarning" style="display:none;margin:-2px 20px 12px;padding:8px 12px;background:rgba(255,183,77,0.1);border:1px solid rgba(255,183,77,0.35);border-radius:8px;font-size:12px;line-height:1.5;color:#ffb74d;" data-i18n="checkbox.cached.rdWarning">⚠️ Pri Real-Debrid je Cached Only nespoľahlivé: RD nemá API na kontrolu cache. ⚡ označuje len torrenty, ktoré už stiahol niekto cez tento addon, filter môže skryť hrateľné streamy.</div>
                <div class="checkbox-row" id="precacheRow" onclick="toggleCheckbox('precacheNextEpisode', event)">
                    <input type="checkbox" id="precacheNextEpisode" ${getCheck('precacheNextEpisode', false)}>
                    <span class="label-text" data-i18n="checkbox.precache">Pre-cache ďalšej epizódy</span>
                    <span class="label-desc" data-i18n="checkbox.precache.desc">Seriály: na pozadí začať sťahovať ďalšiu epizódu</span>
                </div>
                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.videoQuality">Kvalita videa</label></div>
                <div class="chip-group" id="hdrChips" style="padding-bottom:12px;">
                    <span class="chip ${hasArrVal('hdr','hdr',true)}" data-hdr="hdr" onclick="toggleChip(this)">HDR</span>
                    <span class="chip ${hasArrVal('hdr','dv',true)}" data-hdr="dv" onclick="toggleChip(this)">Dolby Vision</span>
                    <span class="chip ${hasArrVal('hdr','hevc',true)}" data-hdr="hevc" onclick="toggleChip(this)">HEVC</span>
                    <span class="chip ${hasArrVal('hdr','atmos',true)}" data-hdr="atmos" onclick="toggleChip(this)">Atmos</span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.filter18">18+ filter</label></div>
                <div class="chip-group" id="adultChips" style="padding-bottom:4px;">
                    <span class="chip ${hasArrVal('adult','hide',true)}" data-adult="hide" onclick="toggleChip(this)"><span data-i18n="chip.hide18">Skryť 18+ obsah</span></span>
                </div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.sourceType">🎞️ Typ zdroja</label></div>
                <div class="chip-group" id="sourceChips" style="padding-bottom:12px;">
                    <span class="chip ${hasArrVal('source','webdl',true)}" data-source="webdl" onclick="toggleChip(this)">WEB-DL</span>
                    <span class="chip ${hasArrVal('source','bluray',true)}" data-source="bluray" onclick="toggleChip(this)">BluRay</span>
                    <span class="chip ${hasArrVal('source','hdtv',true)}" data-source="hdtv" onclick="toggleChip(this)">HDTV</span>
                    <span class="chip ${hasArrVal('source','dvdrip',true)}" data-source="dvdrip" onclick="toggleChip(this)">DVDRip</span>
                    <span class="chip ${hasArrVal('source','webrip',true)}" data-source="webrip" onclick="toggleChip(this)">WEBRip</span>
                    <span class="chip ${hasArrVal('source','hdrip',true)}" data-source="hdrip" onclick="toggleChip(this)">HDRip</span>
                    <span class="chip ${hasArrVal('source','ppv',true)}" data-source="ppv" onclick="toggleChip(this)">PPV</span>
                    <span class="chip ${hasArrVal('source','remux',true)}" data-source="remux" onclick="toggleChip(this)">Remux</span>
                    <span class="chip ${hasArrVal('source','cam',true)}" data-source="cam" onclick="toggleChip(this)">CAM / KINO</span>
                    <span class="chip ${hasArrVal('source','screener',true)}" data-source="screener" onclick="toggleChip(this)">Screener</span>
                    <span class="chip ${hasArrVal('source','vodrip',true)}" data-source="vodrip" onclick="toggleChip(this)">VODRip</span>
                    <span class="chip ${hasArrVal('source','tvrip',true)}" data-source="tvrip" onclick="toggleChip(this)">TVRip</span>
                </div>
                <div style="padding: 0 20px 8px;font-size:11px;color:#555;" data-i18n="hint.allSources">Prázdne = všetky zdroje</div>

                <div style="padding: 8px 20px 4px;"><label style="font-size:12px;font-weight:600;color:#aaa;" data-i18n="label.resolution">Rozlíšenie</label></div>
                <div class="chip-group" id="resChips" style="padding-bottom:4px;">
                    <span class="chip ${hasArrVal('res','2160p',true)}" data-res="2160p" onclick="toggleChip(this)">4K</span>
                    <span class="chip ${hasArrVal('res','1080p',true)}" data-res="1080p" onclick="toggleChip(this)">1080p</span>
                    <span class="chip ${hasArrVal('res','720p',true)}" data-res="720p" onclick="toggleChip(this)">720p</span>
                    <span class="chip ${hasArrVal('res','sd',true)}" data-res="sd" onclick="toggleChip(this)">SD</span>
                </div>
                <div style="padding: 0 20px 8px;font-size:11px;color:#555;" data-i18n="hint.allResolutions">Prázdne = všetky rozlíšenia</div>

                <div class="field">
                    <label data-i18n="label.maxResults">Maximálny počet výsledkov</label>
                    <select id="maxResults">
                        <option value="0" ${getSelect('maxResults', '0', '0')} data-i18n="opt.unlimited">Neobmedzene</option>
                        <option value="5" ${getSelect('maxResults', '5', '0')}>5</option>
                        <option value="10" ${getSelect('maxResults', '10', '0')}>10</option>
                        <option value="20" ${getSelect('maxResults', '20', '0')}>20</option>
                        <option value="50" ${getSelect('maxResults', '50', '0')}>50</option>
                    </select>
                </div>

                <div class="field">
                    <label data-i18n="label.maxPerRes">Max. na rozlíšenie</label>
                    <select id="maxPerRes">
                        <option value="0" ${getSelect('maxPerRes', '0', '0')}><span data-i18n="opt.unlimited">Neobmedzene</span></option>
                        <option value="1" ${getSelect('maxPerRes', '1', '0')}>1</option>
                        <option value="2" ${getSelect('maxPerRes', '2', '0')}>2</option>
                        <option value="3" ${getSelect('maxPerRes', '3', '0')}>3</option>
                        <option value="5" ${getSelect('maxPerRes', '5', '0')}>5</option>
                        <option value="10" ${getSelect('maxPerRes', '10', '0')}>10</option>
                    </select>
                </div>

                <div class="field">
                    <label data-i18n="label.maxSize">Max. veľkosť súboru</label>
                    <select id="maxSize">
                        <option value="0" ${getSelect('maxSize', '0', '0')}><span data-i18n="opt.unlimited">Neobmedzene</span></option>
                        <option value="2" ${getSelect('maxSize', '2', '0')}>2 GB</option>
                        <option value="4" ${getSelect('maxSize', '4', '0')}>4 GB</option>
                        <option value="8" ${getSelect('maxSize', '8', '0')}>8 GB</option>
                        <option value="16" ${getSelect('maxSize', '16', '0')}>16 GB</option>
                        <option value="50" ${getSelect('maxSize', '50', '0')}>50 GB</option>
                    </select>
                </div>

                <div class="field" style="padding-bottom:16px;">
                    <label data-i18n="label.minSeeds">Minimálny počet seedov</label>
                    <input type="number" id="minSeeds" value="${getVal('minSeeds') || '0'}" min="0" style="width:100px;">
                </div>
            </div>

            <!-- 📊 Sort Order -->
            <div class="section">
                <div class="section-header"><span class="icon">📊</span> <span data-i18n="section.sort">Sort Order</span></div>
                <div class="section-desc" data-i18n="desc.sort">Priorita radenia výsledkov</div>

                <div id="sortOrders">
                    <!-- Dynamicky vytvorene cez JS -->
                </div>
            </div>

            <button class="btn-primary" onclick="generateLink()"><span data-i18n="button.generate">✨ Vygenerovať odkaz</span></button>

            <div id="result-box">
                <p data-i18n="result.title">Tvoj inštalačný odkaz</p>
                <textarea id="generated-url" readonly></textarea>
                <button class="btn-sm btn-copy" onclick="copyUrl()"><span data-i18n="button.copy">📋 Kopírovať</span></button>
                <button class="btn-sm btn-install" onclick="openStremio()"><span data-i18n="button.install">🚀 Inštalovať</span></button>
            </div>
        </div>

        <script>
            // SORT_OPTIONS = poradie aj identita riadkov; select neni potrebný
            var SORT_OPTIONS = ['cached', 'quality', 'lang', 'seeds', 'size'];
            var SORT_LABELS = { cached: 'Cached', quality: 'Rozlíšenie', lang: 'Jazyk', seeds: 'Seedy', size: 'Veľkosť' };
            var CURR_LANG = localStorage.getItem('sktorrent_lang') || 'sk';

            var I18N = {
                sk: {
                    'title': 'SKTorrent',
                    'subtitle': 'Nastav si preferencie a vygeneruj inštalačný odkaz',
                    'section.connection': 'Pripojenie',
                    'desc.connection': 'Prihlasovacie údaje a API kľúče',
                    'label.uid': 'SKTorrent UID',
                    'uid.help': 'ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu',
                    'uid.placeholder': 'Napr. 123987',
                    'label.pass': 'SKTorrent pass',
                    'pass.help': 'ℹ️ Nájdeš v cookies po prihlásení na sktorrent.eu',
                    'pass.placeholder': 'Tvoj pass',
                    'label.debrid': 'Debrid služba',
                    'debrid.choose': '— Vyber —',
                    'debrid.p2p': 'Klasický torrent (P2P)',
                    'label.realdebrid': 'Real-Debrid API kľúč',
                    'realdebrid.placeholder': 'Real-Debrid API token',
                    'realdebrid.help': '🔗 real-debrid.com/devices',
                    'label.torbox': 'TorBox API kľúč',
                    'torbox.help': '🔗 https://torbox.app/settings?section=account',
                    'torbox.placeholder': 'TorBox token',
                    'label.tmdb': 'TMDB API kľúč',
                    'label.tmdb.optional': '(voliteľné)',
                    'tmdb.help': '🔗 https://www.themoviedb.org/settings/api',
                    'tmdb.placeholder': 'TMDB token',
                    'label.tvdb': 'TVDB API kľúč',
                    'label.tvdb.optional': '(voliteľné)',
                    'label.sktorrentLogin.optional': '(voliteľné)',
                    'tvdb.help': '🔗 https://thetvdb.com/dashboard/account/apikey',
                    'tvdb.placeholder': 'TVDB token',
                    'section.display': 'Jazyk a zobrazenie',
                    'desc.display': 'Nastavenia jazyka a zobrazenia výsledkov',
                    'label.preferLangs': 'Preferované jazyky',
                    'label.showInStream': 'Zobraziť v názve streamu',
                    'chip.title': 'Názov',
                    'chip.quality': 'Kvalita',
                    'chip.size': 'Veľkosť',
                    'chip.lang': 'Jazyk',
                    'chip.seeds': 'Seedery',
                    'section.filters': 'Kvalita a filtre',
                    'desc.filters': 'Obmedz kvalitu, veľkosť a počet výsledkov',
                    'checkbox.cached': 'Cached Only',
                    'checkbox.cached.desc': 'Len cachované streamy',
                    'checkbox.cached.rdWarning': '⚠️ Pri Real-Debrid je Cached Only nespoľahlivé: RD nemá API na kontrolu cache. ⚡ označuje len torrenty, ktoré už stiahol niekto cez tento addon, filter môže skryť hrateľné streamy.',
                    'checkbox.precache': 'Pre-cache ďalšej epizódy',
                    'checkbox.precache.desc': 'Seriály: po otvorení epizódy začni na pozadí sťahovať ďalšiu (ak nie je cached)',
                    'label.videoQuality': 'Kvalita videa',
                    'label.filter18': '18+ filter',
                    'chip.hide18': 'Skryť 18+ obsah',
                    'label.sourceType': '🎞️ Typ zdroja',
                    'hint.allSources': 'Prázdne = všetky zdroje',
                    'label.resolution': 'Rozlíšenie',
                    'hint.allResolutions': 'Prázdne = všetky rozlíšenia',
                    'label.maxResults': 'Maximálny počet výsledkov',
                    'opt.unlimited': 'Neobmedzene',
                    'label.maxPerRes': 'Max. na rozlíšenie',
                    'label.maxSize': 'Max. veľkosť súboru',
                    'label.minSeeds': 'Minimálny počet seedov',
                    'desc.sort': 'Priorita radenia výsledkov',
                    'button.generate': '✨ Vygenerovať odkaz',
                    'result.title': 'Tvoj inštalačný odkaz',
                    'button.copy': '📋 Kopírovať',
                    'button.install': '🚀 Inštalovať',
                    'alert.fillUidPass': 'Pre P2P režim vyplň SKTorrent UID a PASS, alebo vyber TorBox/Real-Debrid.',
                    'alert.codeError': 'Chyba pri generovaní kódu.',
                    'button.copied': 'Skopírované!',
                    'button.copyIdle': 'Kopírovať',
                    'sort.toggleOn': 'Klikni pre vypnutie',
                    'sort.toggleOff': 'Klikni pre zapnutie',
                    'sort.cached': 'Cached',
                    'sort.quality': 'Rozlíšenie',
                    'sort.lang': 'Jazyk',
                    'sort.seeds': 'Seedy',
                    'sort.size': 'Veľkosť',
                    'label.sktorrentLogin': 'Prihlásiť sa na SKTorrent',
                    'login.uid.placeholder': 'Používateľské meno',
                    'login.pass.placeholder': 'Heslo',
                    'button.login': 'Prihlásiť sa',
                    'button.register': 'Registrovať sa',
                    'button.loggingIn': 'Prihlasujem...',
                    'link.manual': '▶ Manuálne zadať UID a PASS',
                    'link.manualHide': '▼ Skryť manuálne polia',
                    'lang.sk': 'Slovenčina',
                    'lang.en': 'English',
                    'section.sort': 'Zoradenie',
                },
                en: {
                    'title': 'SKTorrent',
                    'subtitle': 'Configure your preferences and generate install link',
                    'section.sort': 'Sort Order',
                    'section.connection': 'Connection',
                    'desc.connection': 'Login credentials and API keys',
                    'label.uid': 'SKTorrent UID',
                    'uid.help': 'ℹ️ Found in cookies after logging in at sktorrent.eu',
                    'uid.placeholder': 'e.g. 123987',
                    'label.pass': 'SKTorrent pass',
                    'pass.help': 'ℹ️ Found in cookies after logging in at sktorrent.eu',
                    'pass.placeholder': 'Your pass',
                    'label.debrid': 'Debrid Service',
                    'debrid.choose': '— Choose —',
                    'debrid.p2p': 'Classic torrent (P2P)',
                    'label.realdebrid': 'Real-Debrid API Key',
                    'realdebrid.placeholder': 'Real-Debrid API token',
                    'realdebrid.help': '🔗 real-debrid.com/devices',
                    'label.torbox': 'TorBox API Key',
                    'torbox.help': '🔗 https://torbox.app/settings?section=account',
                    'torbox.placeholder': 'TorBox token',
                    'label.tmdb': 'TMDB API Key',
                    'label.tmdb.optional': '(optional)',
                    'tmdb.help': '🔗 https://www.themoviedb.org/settings/api',
                    'tmdb.placeholder': 'TMDB token',
                    'label.tvdb': 'TVDB API Key',
                    'label.tvdb.optional': '(optional)',
                    'label.sktorrentLogin.optional': '(optional)',
                    'tvdb.help': '🔗 https://thetvdb.com/dashboard/account/apikey',
                    'tvdb.placeholder': 'TVDB token',
                    'section.display': 'Language & Display',
                    'desc.display': 'Language and stream display settings',
                    'label.preferLangs': 'Preferred languages',
                    'label.showInStream': 'Show in stream name',
                    'chip.title': 'Title',
                    'chip.quality': 'Quality',
                    'chip.size': 'Size',
                    'chip.lang': 'Language',
                    'chip.seeds': 'Seeders',
                    'section.filters': 'Quality & Filters',
                    'desc.filters': 'Limit quality, size, and number of results',
                    'checkbox.cached': 'Cached Only',
                    'checkbox.cached.desc': 'Cached streams only',
                    'checkbox.cached.rdWarning': '⚠️ With Real-Debrid the Cached Only filter is unreliable: RD has no cache-check API, ⚡ only marks torrents already downloaded through this addon, so it may hide playable streams.',
                    'checkbox.precache': 'Pre-cache next episode',
                    'checkbox.precache.desc': 'Series: when opening an episode, start downloading the next one in background (if not cached)',
                    'label.videoQuality': 'Video quality',
                    'label.filter18': '18+ filter',
                    'chip.hide18': 'Hide 18+ content',
                    'label.sourceType': '🎞️ Source type',
                    'hint.allSources': 'Empty = all sources',
                    'label.resolution': 'Resolution',
                    'hint.allResolutions': 'Empty = all resolutions',
                    'label.maxResults': 'Max results',
                    'opt.unlimited': 'Unlimited',
                    'label.maxPerRes': 'Max per resolution',
                    'label.maxSize': 'Max file size',
                    'label.minSeeds': 'Minimum seeders',
                    'section.sort': 'Sort Order',
                    'desc.sort': 'Result sorting priority',
                    'button.generate': '✨ Generate link',
                    'result.title': 'Your install link',
                    'button.copy': '📋 Copy',
                    'button.install': '🚀 Install',
                    'alert.fillUidPass': 'For P2P mode fill SKTorrent UID and PASS, or choose TorBox/Real-Debrid.',
                    'alert.codeError': 'Error generating code.',
                    'button.copied': 'Copied!',
                    'button.copyIdle': 'Copy',
                    'sort.toggleOn': 'Click to disable',
                    'sort.toggleOff': 'Click to enable',
                    'sort.cached': 'Cached',
                    'sort.quality': 'Resolution',
                    'sort.lang': 'Language',
                    'sort.seeds': 'Seeders',
                    'sort.size': 'Size',
                    'label.sktorrentLogin': 'Login to SKTorrent',
                    'login.uid.placeholder': 'Username',
                    'login.pass.placeholder': 'Password',
                    'button.login': 'Login',
                    'button.register': 'Register',
                    'button.loggingIn': 'Logging in...',
                    'link.manual': '▶ Enter UID and PASS manually',
                    'link.manualHide': '▼ Hide manual fields',
                    'lang.sk': 'Slovenčina',
                    'lang.en': 'English',
                }
            };

            function t(key) { return (I18N[CURR_LANG] && I18N[CURR_LANG][key]) || (I18N['en'] && I18N['en'][key]) || key; }

            function setLang(lang) {
                CURR_LANG = lang;
                localStorage.setItem('sktorrent_lang', lang);
                applyLang();
            }

            function applyLang() {
                document.querySelectorAll('[data-i18n]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n');
                    el.textContent = t(key);
                });
                document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-placeholder');
                    el.placeholder = t(key);
                });
                document.querySelectorAll('[data-i18n-optional]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-optional');
                    el.textContent = t(key);
                });
                document.querySelectorAll('[data-i18n-link]').forEach(function(el) {
                    var key = el.getAttribute('data-i18n-link');
                    el.textContent = t(key);
                });
                // Update SORT_LABELS
                SORT_LABELS = { cached: t('sort.cached'), quality: t('sort.quality'), lang: t('sort.lang'), seeds: t('sort.seeds'), size: t('sort.size') };
                // Re-render sort rows with new labels
                var sortContainer = document.getElementById('sortOrders');
                if (sortContainer) {
                    var vals = [];
                    var activeMask = [];
                    var rows = sortContainer.querySelectorAll('.sort-row');
                    for (var si = 0; si < rows.length; si++) {
                        vals.push(rows[si].dataset.value);
                        activeMask.push(rows[si].dataset.active !== 'false');
                    }
                    if (vals.length) initSortRows(vals, activeMask);
                }
                // Update lang switcher active state
                document.querySelectorAll('.lang-btn').forEach(function(btn) {
                    var lb = btn.getAttribute('data-lang-btn');
                    btn.classList.toggle('active', lb === CURR_LANG);
                });
            }

            function getSortValues() {
                var rows = document.querySelectorAll('.sort-row');
                var vals = [];
                for (var i = 0; i < rows.length; i++) {
                    if (rows[i].dataset.active !== 'false') {
                        vals.push(rows[i].dataset.value);
                    }
                }
                return vals;
            }

            function initSortRows(saved, activeMask) {
                var container = document.getElementById('sortOrders');
                container.innerHTML = '';
                var used = saved && saved.length ? saved : SORT_OPTIONS;
                if (!activeMask || activeMask.length !== used.length) {
                    activeMask = [];
                    for (var mi = 0; mi < used.length; mi++) activeMask.push(true);
                }
                for (var i = 0; i < used.length; i++) {
                    var row = document.createElement('div');
                    row.className = 'sort-row';
                    row.dataset.idx = i;
                    row.dataset.active = activeMask[i] ? 'true' : 'false';
                    row.dataset.value = used[i];
                    var numSpan = document.createElement('span');
                    numSpan.className = 'num';
                    numSpan.textContent = i + 1;
                    row.appendChild(numSpan);

                    var toggle = document.createElement('button');
                    toggle.className = 'sort-toggle';
                    toggle.innerHTML = activeMask[i] ? '\u25CF' : '\u25CB';
                    toggle.setAttribute('onclick', 'toggleSortActive(this)');
                    toggle.title = activeMask[i] ? 'Klikni pre vypnutie' : 'Klikni pre zapnutie';
                    row.appendChild(toggle);

                    // Fixed label namiesto selectu — criterion je identita riadku
                    var label = document.createElement('span');
                    label.className = 'sort-label';
                    label.textContent = SORT_LABELS[used[i]] || used[i];
                    label.style.flex = '1';
                    label.style.fontSize = '13px';
                    label.style.color = '#ccc';
                    row.appendChild(label);

                    var up = document.createElement('button');
                    up.className = 'sort-btn';
                    up.innerHTML = '\u25B2';
                    up.setAttribute('onclick', 'moveSort(this, -1)');
                    if (i === 0) up.disabled = true;
                    row.appendChild(up);

                    var down = document.createElement('button');
                    down.className = 'sort-btn';
                    down.innerHTML = '\u25BC';
                    down.setAttribute('onclick', 'moveSort(this, 1)');
                    if (i === used.length - 1) down.disabled = true;
                    row.appendChild(down);

                    container.appendChild(row);
                }
            }

            function moveSort(btn, dir) {
                var row = btn.parentNode;
                var container = document.getElementById('sortOrders');
                var rows = container.querySelectorAll('.sort-row');
                var idx = Array.prototype.indexOf.call(rows, row);
                var newIdx = idx + dir;
                if (newIdx < 0 || newIdx >= rows.length) return;
                // Read ALL values and active states from DOM
                var vals = [];
                var activeMask = [];
                for (var si = 0; si < rows.length; si++) {
                    vals.push(rows[si].dataset.value);
                    activeMask.push(rows[si].dataset.active !== 'false');
                }
                var tmp = vals[idx];
                vals[idx] = vals[newIdx];
                vals[newIdx] = tmp;
                var tmpMask = activeMask[idx];
                activeMask[idx] = activeMask[newIdx];
                activeMask[newIdx] = tmpMask;
                initSortRows(vals, activeMask);
            }

            function toggleChip(el) {
                el.classList.toggle('active');
            }

            function toggleCheckbox(id, event) {
                if (event && event.target && event.target.type === 'checkbox') return;
                var cb = document.getElementById(id);
                cb.checked = !cb.checked;
                aktualizujCachedOnlyWarning();
            }

            function aktualizujCachedOnlyWarning() {
                var warn = document.getElementById('cachedOnlyRdWarning');
                if (!warn) return;
                var providerSel = document.getElementById('debridProvider');
                var cb = document.getElementById('cachedOnly');
                var viditelne = providerSel && providerSel.value === 'realdebrid' && cb && cb.checked;
                warn.style.display = viditelne ? '' : 'none';
            }

            function toggleSortActive(btn) {
                var row = btn.parentNode;
                var isActive = row.dataset.active !== 'false';
                row.dataset.active = isActive ? 'false' : 'true';
                btn.innerHTML = isActive ? '\u25CB' : '\u25CF';
                btn.title = isActive ? t('sort.toggleOff') : t('sort.toggleOn');
            }

            function getActiveChips(selector) {
                var chips = document.querySelectorAll(selector + '.active');
                var vals = [];
                for (var i = 0; i < chips.length; i++) {
                    var chip = chips[i];
                    var v = chip.dataset.lang || chip.dataset.show || chip.dataset.res || chip.dataset.hdr || chip.dataset.adult || chip.dataset.source || '';
                    vals.push(v);
                }
                return vals;
            }

            function generateLink() {
                var uidVal = document.getElementById('uid').value;
                var passVal = document.getElementById('pass').value;
                // Ak hidden polia su prazdne, skus manualne
                if (!uidVal || !passVal) {
                    uidVal = document.getElementById('manualUid').value;
                    passVal = document.getElementById('manualPass').value;
                }
                var debridProvider = document.getElementById('debridProvider').value;
                var jeDebridMod = debridProvider === 'torbox' || debridProvider === 'realdebrid';
                var config = {
                    uid: uidVal,
                    pass: passVal,
                    debridProvider: debridProvider,
                    torbox: document.getElementById('torbox').value,
                    realdebrid: document.getElementById('realdebrid').value,
                    tmdb: document.getElementById('tmdb').value,
                    tvdb: document.getElementById('tvdb').value,
                    lang: getActiveChips('#langChips .chip'),
                    show: getActiveChips('#showChips .chip'),
                    cachedOnly: jeDebridMod && document.getElementById('cachedOnly').checked,
                    precacheNextEpisode: jeDebridMod && document.getElementById('precacheNextEpisode').checked,
                    hdr: getActiveChips('#hdrChips .chip'),
                    adult: getActiveChips('#adultChips .chip'),
                    source: getActiveChips('#sourceChips .chip'),
                    res: getActiveChips('#resChips .chip'),
                    maxResults: document.getElementById('maxResults').value,
                    maxPerRes: document.getElementById('maxPerRes').value,
                    maxSize: document.getElementById('maxSize').value,
                    minSeeds: document.getElementById('minSeeds').value,
                    sort: getSortValues(),
                    cb: Date.now()
                };

                if ((!config.uid || !config.pass) && (!debridProvider || debridProvider === 'p2p')) {
                    alert(t('alert.fillUidPass'));
                    return;
                }
                
                // Ak je debrid, uid/pass nie su potrebne — pouzijeme placeholder aby
                // server neodmietol config (uid/pass sa ignoruju pre debrid)
                if (!config.uid) config.uid = '';
                if (!config.pass) config.pass = '';

                fetch('/api/config-token', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(config)
                    }).then(function(response) {
                        return response.json().then(function(data) {
                            if (!response.ok) { throw new Error(data.error || t('alert.codeError')); }
                            var baseUrl = window.location.origin;
                            if (!baseUrl || baseUrl === "null") {
                                baseUrl = window.location.protocol + "//" + window.location.host;
                            }
                            document.getElementById('result-box').style.display = 'block';
                            document.getElementById('generated-url').value = baseUrl + '/' + data.token + '/manifest.json';
                            setTimeout(function() {
                                document.getElementById('result-box').scrollIntoView({ behavior: 'smooth', block: 'center' });
                            }, 100);
                        });
                    }).catch(function(error) {
                        alert(error.message || t('alert.codeError'));
                        console.error(error);
                    });
            }

            function copyUrl() {
                var urlText = document.getElementById('generated-url');
                urlText.select();
                document.execCommand('copy');
                var copyBtn = document.querySelector('.btn-copy span[data-i18n="button.copy"]');
                if (copyBtn) {
                    copyBtn.textContent = t('button.copied');
                    setTimeout(function() { copyBtn.textContent = t('button.copyIdle'); }, 2000);
                }
            }

            function openStremio() {
                document.getElementById('install-modal').style.display = 'flex';
                document.getElementById('nuvio-hint').style.display = 'none';
                document.getElementById('stremio-hint').style.display = 'none';
            }

            function closeInstallModal() {
                document.getElementById('install-modal').style.display = 'none';
            }

            function kopirujOdkaz(done) {
                var httpUrl = document.getElementById('generated-url').value;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(httpUrl).then(done, function() { copyUrl(); done(); });
                } else {
                    copyUrl();
                    done();
                }
            }

            function installToStremio() {
                var httpUrl = document.getElementById('generated-url').value;
                var host = window.location.hostname;
                // stremio:// odkaz Stremio vždy otvorí cez https - lokálny alebo http server by zlyhal ("Failed to get addon manifest")
                var jeLokalna = window.location.protocol !== 'https:' || host === 'localhost' || host === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host);
                if (jeLokalna) {
                    kopirujOdkaz(function() { document.getElementById('stremio-hint').style.display = 'block'; });
                    return;
                }
                window.location.assign(httpUrl.replace("https://", "stremio://").replace("http://", "stremio://"));
                closeInstallModal();
            }

            function installToNuvio() {
                kopirujOdkaz(function() { document.getElementById('nuvio-hint').style.display = 'block'; });
            }

            function toggleDebridFields() {
                var provider = document.getElementById('debridProvider').value;
                var torboxField = document.getElementById('torboxField');
                var realdebridField = document.getElementById('realdebridField');
                var sktorrentSection = document.getElementById('sktorrentSection');
                var debridMod = provider === 'torbox' || provider === 'realdebrid';

                // Debrid API fields
                if (torboxField) torboxField.style.display = (provider === 'torbox') ? '' : 'none';
                if (realdebridField) realdebridField.style.display = (provider === 'realdebrid') ? '' : 'none';

                // SKTorrent login: vždy viditeľný (zrýchli vyhľadávanie v každom móde)
                if (sktorrentSection) sktorrentSection.style.display = 'block';

                // Cached Only aj Pre-cache dávajú zmysel len s debrid službou (P2P nemá cache)
                var cachedRow = document.getElementById('cachedOnlyRow');
                var precacheRow = document.getElementById('precacheRow');
                if (cachedRow) cachedRow.style.display = debridMod ? '' : 'none';
                if (precacheRow) precacheRow.style.display = debridMod ? '' : 'none';

                // Sortovanie podľa Cached tiež len v debrid móde
                upravitSortPreProvider();
                aktualizujCachedOnlyWarning();
            }

            function upravitSortPreProvider() {
                var providerSel = document.getElementById('debridProvider');
                var container = document.getElementById('sortOrders');
                if (!providerSel || !container) return;
                var debridMod = providerSel.value === 'torbox' || providerSel.value === 'realdebrid';
                var vals = [], act = [];
                var rows = container.querySelectorAll('.sort-row');
                for (var i = 0; i < rows.length; i++) {
                    vals.push(rows[i].dataset.value);
                    act.push(rows[i].dataset.active !== 'false');
                }
                var idx = vals.indexOf('cached');
                if (debridMod && idx === -1) {
                    // Debrid: Cached vrátime na prvú pozíciu (predvolené poradie)
                    vals.unshift('cached');
                    act.unshift(true);
                    initSortRows(vals, act);
                } else if (!debridMod && idx !== -1) {
                    // P2P / žiadna služba: Cached nemá zmysel, odstránime
                    vals.splice(idx, 1);
                    act.splice(idx, 1);
                    initSortRows(vals, act);
                }
            }

            function toggleManualFields(e) {
                e.preventDefault();
                var el = document.getElementById('manualFields');
                var link = e.target;
                if (el.style.display === 'none') {
                    el.style.display = 'block';
                    link.innerHTML = '▼ ' + t('link.manualHide') || '▼ Skryť manuálne polia';
                } else {
                    el.style.display = 'none';
                    link.innerHTML = '▶ ' + t('link.manual') || '▶ Manuálne zadať UID a PASS';
                }
            }

            function loginToSKTorrent() {
                var username = document.getElementById('loginUser').value.trim();
                var password = document.getElementById('loginPass').value;
                var statusEl = document.getElementById('loginStatus');
                var btn = document.getElementById('loginBtn');

                if (!username || !password) {
                    statusEl.innerHTML = '<span style="color:#ff6b6b;">❌ Vyplň meno aj heslo</span>';
                    return;
                }

                btn.disabled = true;
                btn.style.opacity = '0.6';
                btn.textContent = t('button.loggingIn') || 'Prihlasujem...';
                statusEl.innerHTML = '<span style="color:#888;">⏳ Prihlasujem na SKTorrent...</span>';

                fetch('/api/sktorrent-login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                })
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (data.error) {
                        statusEl.innerHTML = '<span style="color:#ff6b6b;">❌ ' + data.error + '</span>';
                        btn.disabled = false;
                        btn.style.opacity = '1';
                        btn.textContent = t('button.login') || 'Prihlásiť sa';
                        return;
                    }
                    // Uloz uid/pass do hidden fields
                    document.getElementById('uid').value = data.uid;
                    document.getElementById('pass').value = data.pass;
                    // Vypis uid/pass aj do manual fields
                    document.getElementById('manualUid').value = data.uid;
                    document.getElementById('manualPass').value = data.pass;
                    // Schovaj login polia, ukaz success s uid/pass
                    document.getElementById('loginFields').style.display = 'none';
                    statusEl.innerHTML = '<span style="color:#24c87a;">✅ Prihlásený ako <strong>' + data.username + '</strong><br><span style="font-size:11px;color:#888;">UID: ' + data.uid + ' | PASS: ' + data.pass.substring(0, 8) + '...</span></span>';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                })
                .catch(function(err) {
                    statusEl.innerHTML = '<span style="color:#ff6b6b;">❌ Chyba spojenia so serverom</span>';
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.textContent = t('button.login') || 'Prihlásiť sa';
                });
            }

            // Initialise sort order
            var savedSort = ${(() => {
                const sort = currentConfig.sort;
                if (sort && Array.isArray(sort)) return JSON.stringify(sort);
                if (sort && typeof sort === 'string') {
                    try { return JSON.stringify(JSON.parse(sort)); } catch(e) {}
                }
                return 'null';
            })()};
            initSortRows(savedSort);
            // Apply debrid field visibility on load
            toggleDebridFields();
            // Apply saved language on load
            applyLang();
        </script>
        <div id="install-modal" style="display:none;position:fixed;inset:0;z-index:50;align-items:center;justify-content:center;background:rgba(5,6,12,.72);padding:20px;" onclick="if(event.target===this)closeInstallModal()">
            <div style="width:100%;max-width:400px;background:rgba(22,24,36,.98);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:24px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.5);">
                <h3 style="margin-bottom:6px;color:#f6f7fb;">Kam chceš addon nainštalovať?</h3>
                <p style="font-size:13px;color:#a9adbd;margin-bottom:16px;">Where do you want to install the addon?</p>
                <button class="btn-sm btn-install" style="width:100%;padding:12px;margin:4px 0;" onclick="installToStremio()">Stremio</button>
                <button class="btn-sm btn-install" style="width:100%;padding:12px;margin:4px 0;" onclick="installToNuvio()">Nuvio</button>
                <p id="stremio-hint" style="display:none;font-size:12px;color:#a9adbd;margin-top:12px;line-height:1.5;">✅ Odkaz je skopírovaný. Lokálny (http) server sa cez stremio:// otvoriť nedá. V Stremiu: Addons → + Add addon, vlož odkaz a daj Install. Ak localhost nejde, použi 127.0.0.1 namiesto localhost.</p>
                <p id="nuvio-hint" style="display:none;font-size:12px;color:#a9adbd;margin-top:12px;line-height:1.5;">✅ Odkaz je skopírovaný. V Nuviu: Settings → Content &amp; Discovery → Addons → Install from URL a vlož ho. Alebo na nuvio.tv v účte: Addons → Add Addon.</p>
                <button class="btn-sm btn-copy" style="width:100%;margin-top:10px;" onclick="closeInstallModal()">Zavrieť / Close</button>
            </div>
        </div>
    </body>
    </html>
    `;

    res.send(html);
});

// --- Manifest Route ---
// --- Manifest ---
const handleManifest = (req, res) => {
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
        'Surrogate-Control': 'no-store'
    });
    const base = getPublicBaseUrl(req);
    res.json({
        id: "org.stremio.skcztorrent.addon",
        version: pkg.version,
        name: "SKTorrent",
        description: "SKTorrent s TorBox / Real-Debrid, ČSFD, TMDB a TVDB metadátami",
        logo: `${base}/logo.png`,
        icon: `${base}/logo.png`,
        types: ["movie", "series"],
        catalogs: [],
        resources: ["stream"],
        idPrefixes: ["tt", "tmdb", "tvdb"],
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

app.get('/:config/stream/:type/:id.json', asyncRoute(async (req, res) => {
    // Zabránime cacheovaniu na úrovni nginx/CDN — každý refresh musí ísť do addonu
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0, s-maxage=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('CDN-Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('X-Accel-Expires', '0');
    
    const { type: aplikaciaTyp, id, config } = req.params;
    const requestPublicUrl = getPublicBaseUrl(req);
    const startCas = Date.now();
    
    logInfo(`Stream request started | Type: ${aplikaciaTyp} | ID: ${id}`);
    
    const userConfig = decodeConfig(config);
    const activeUid = userConfig?.user_id || userConfig?.uid;
    const activePass = userConfig?.password || userConfig?.pass;
    const activeTorbox = userConfig?.tb_key || userConfig?.torbox;
    const activeTmdb = userConfig?.tm_key || userConfig?.tmdb;
    const activePreferDub = userConfig?.preferDub === true;

    if (!activeUid || !activePass) {
        // Debrid-only režim (TorBox/RD) nepotrebuje SKTorrent login
        const maDebrid = !!(activeTorbox || userConfig?.realdebrid);
        if (!maDebrid) {
            logWarn(`Stream request denied - Invalid or missing config (no login, no debrid).`);
            return res.json({ streams: [], error: "Neplatná konfigurácia." });
        }
        logInfo(`Debrid-only config: ${activeTorbox ? 'TorBox' : 'Real-Debrid'} — SKTorrent login not required`);
    }
    
    // Backward compatibility: map old config fields to new ones
    // Old showUncached → new cachedOnly (inverted)
    if (userConfig.showUncached !== undefined && userConfig.cachedOnly === undefined) {
        userConfig.cachedOnly = !userConfig.showUncached;
    }
    // Old sizeOrder → new sort array
    if (userConfig.sizeOrder && !userConfig.sort) {
        if (userConfig.sizeOrder === 'asc') {
            userConfig.sort = ['quality', 'size', 'seeds'];
        } else {
            userConfig.sort = ['cached', 'quality', 'seeds', 'size'];
        }
    }
    // Old sortBy → new sort array
    if (userConfig.sortBy && !userConfig.sort) {
        if (userConfig.sortBy === 'quality') userConfig.sort = ['cached', 'quality', 'lang', 'seeds', 'size'];
        else if (userConfig.sortBy === 'seeds') userConfig.sort = ['cached', 'seeds', 'quality', 'size'];
        else if (userConfig.sortBy === 'size') userConfig.sort = ['cached', 'size', 'quality', 'seeds'];
        else if (userConfig.sortBy === 'sizeAsc') userConfig.sort = ['cached', 'size', 'quality', 'seeds'];
    }
    // Old maxQuality → new res array
    if (userConfig.maxQuality && !userConfig.res) {
        const mq = parseInt(userConfig.maxQuality);
        const allRes = ['2160p', '1080p', '720p', 'sd'];
        if (mq >= 4) userConfig.res = allRes; // 4K = all
        else if (mq === 3) userConfig.res = ['1080p', '720p', 'sd']; // 1080p max
        else if (mq === 2) userConfig.res = ['720p', 'sd'];
        else userConfig.res = ['sd'];
    }
    // Old language single string → new lang array
    if (userConfig.language && !userConfig.lang) {
        if (userConfig.language === 'all' || userConfig.language === '') userConfig.lang = ['sk', 'cz', 'en', 'multi'];
        else if (userConfig.language === 'skcz') userConfig.lang = ['sk', 'cz'];
        else userConfig.lang = [userConfig.language];
    }

    // Legacy config (showUncached/sizeOrder/qualityOrder bez debridProvider)
    if (userConfig.sizeOrder === 'asc') userConfig.sizeAsc = true;
    if (Array.isArray(userConfig.qualityOrder) && !userConfig.sort) userConfig.sort = ['cached', 'quality', 'seeds', 'size'];

    const normalizedConfig = { uid: activeUid, pass: activePass, torbox: activeTorbox, tmdb: activeTmdb, tvdb: userConfig.tvdb, preferDub: activePreferDub };
    const userAxios = getFastAxios(normalizedConfig);
    // userKey = hash uid — fingerprint účtu pre cache namespacing (bez raw UID v logoch)
    const userKey = crypto.createHash("sha1").update(String(activeUid || "")).digest("hex").slice(0, 8);
    console.log(`\n====== 🎬 Hľadám (user: ${userKey}) | id='${id}' ======`);

    // Parsovanie ID — podporuje všetky formáty:
    //   tt1234567           (movie)
    //   tt1234567:1:1       (series, IMDb)
    //   tmdb:295879:1:1     (series, AioMetadata)
    //   tvdb:466037:1:1     (series, TVDB addon)
    //   tvdb-466037:1:1     (series, TVDB addon variant)
    //   tvdb:466037:official:1:1  (series, TVDB addon — oficiálny formát s 'official')
    const imdbMatch = id.match(/^(tt\d+)(?::(\d+):(\d+))?$/);
    const tmdbMatch = id.match(/^tmdb:(\d+)(?::(\d+):(\d+))?$/);
    const tvdbMatch = id.match(/^tvdb[-: ]?(\d+)(?::official)?(?::(\d+):(\d+))?$/);

    let rawId, seria, epizoda, vlastnyTyp;
    if (imdbMatch) {
        rawId = imdbMatch[1];
        seria = imdbMatch[2] ? parseInt(imdbMatch[2]) : undefined;
        epizoda = imdbMatch[3] ? parseInt(imdbMatch[3]) : undefined;
        vlastnyTyp = imdbMatch[2] ? "series" : "movie";
    } else if (tmdbMatch) {
        rawId = `tmdb:${tmdbMatch[1]}`;
        seria = tmdbMatch[2] ? parseInt(tmdbMatch[2]) : undefined;
        epizoda = tmdbMatch[3] ? parseInt(tmdbMatch[3]) : undefined;
        vlastnyTyp = tmdbMatch[2] ? "series" : "movie";
    } else if (tvdbMatch) {
        rawId = `tvdb:${tvdbMatch[1]}`;
        seria = tvdbMatch[2] ? parseInt(tvdbMatch[2]) : undefined;
        epizoda = tvdbMatch[3] ? parseInt(tvdbMatch[3]) : undefined;
        vlastnyTyp = tvdbMatch[2] ? "series" : "movie";
    } else {
        // Neznámy formát — spadneme na pôvodnú logiku (aspoň niečo)
        const jeToSerialPodlaId = id.includes(":");
        const [r, s, e] = id.split(":");
        rawId = r;
        seria = (jeToSerialPodlaId && s) ? parseInt(s) : undefined;
        epizoda = (jeToSerialPodlaId && e) ? parseInt(e) : undefined;
        vlastnyTyp = jeToSerialPodlaId ? "series" : "movie";
    }

    // TVDB ID formát (z TVDB addonu / AioMetadata): tvdb-466037, tvdb:466037
    // alebo tvdb-466037:1:1. Cinemeta/TMDB takéto seriály často nepoznajú
    // (napr. Party Shore Slovensko), preto názvy načítame priamo z TVDB API.
    const tvdbIdMatch = rawId.match(/^tvdb[-: ]?(\d+)$/);
    const jeTvdbId = !!tvdbIdMatch;

    // TMDB ID formát (z AioMetadata): tmdb:295879 alebo tmdb:295879:1:1
    const tmdbIdMatch = rawId.match(/^tmdb:(\d+)$/);
    const jeTmdbId = !!tmdbIdMatch;

    // 1. ZÍSKAME NÁZVY A ROK a META
    let metaData = null;
    if (jeTvdbId) {
        const tvdbId = tvdbIdMatch[1];
        const nazvy = new Set();
        await pridajTvdbNazvy(nazvy, tvdbId, userConfig.tvdb);
        if (nazvy.size > 0) {
            metaData = {
                nazvy: [...nazvy],
                rok: null,
                meta: { titleOriginal: [...nazvy][0], titleCz: [...nazvy][0], yearStart: null, yearEnd: null }
            };
            logApi(`TVDB ID ${tvdbId} → názvy: ${[...nazvy].join(", ")}`);
        }
    }
    // tmdb: ID rieši ziskatVsetkyNazvyARok (názvy + rok + IMDb ID pre ČSFD)
    if (!metaData) {
        metaData = await ziskatVsetkyNazvyARok(rawId, vlastnyTyp, activeTmdb, userConfig.tvdb);
    }
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

    // 2. ČSFD LINK — hľadáme podľa presného ČSFD URL (nájde aj tituly s odlišným SK/CZ názvom)
    // Pre TVDB ID nemáme IMDb ID — ČSFD vynecháme, hľadáme priamo podľa názvu.
        const hlavnyNazov = metaData?.meta?.titleOriginal || unikatneNazvy[0];
        const csfdLink = jeTvdbId ? null : await ziskatCsfdUrl(metaData?.imdbId || rawId, hlavnyNazov, vydanyRok, vlastnyTyp, metaData?.tmdbId, unikatneNazvy);
    
    let torrenty = [];
    const videnieTorrentIds = new Set();
    let uspesneNajdeneCezCsfd = false;

    const spracujVysledky = (d, najdene) => {
        logInfo(`Search result: "${d?.slice(0, 60)}" → ${najdene.length} torrentov`);
        for (const t of najdene) {
            if (!videnieTorrentIds.has(t.id)) {
                torrenty.push(t);
                videnieTorrentIds.add(t.id);
            }
        }
        if (d === csfdLink && najdene.length > 0) {
            logSuccess(`Nájdené cez ČSFD Link. Mám ${torrenty.length} výsledkov.`);
            uspesneNajdeneCezCsfd = true;
        }
    };

    // ── BATCH 1: CSFD URL + primárny názov (max 2 query, paralelne) ──
    // SKTorrent search je čistý substring search — primárny názov (bez diakritiky)
    // nájde pack aj epizódy, správnu epizódu vyberie client-side filter.
    const primarnyBezDia = odstranDiakritiku(unikatneNazvy[0] || "").trim();
    const prveDotazy = [];
    if (csfdLink) prveDotazy.push(csfdLink);
    if (primarnyBezDia) prveDotazy.push(primarnyBezDia);

    const vysledkyBatch = await Promise.all(prveDotazy.map(d =>
        hladatTorrenty(d, userAxios, 2, userKey)
    ));
    prveDotazy.forEach((d, i) => spracujVysledky(d, vysledkyBatch[i] || []));

    // ── FALLBACK: len ak batch 1 nič nenašiel ──
    // Kratšie názvy (3 slová) a ostatné jazykové varianty — ale NIE epizódové tagy
    // (sú vždy podmnožina základného názvu) a nie generické jednoslovné query
    // (vracajú garbage — napr. "Odysea" → 36 irelevantných torrentov).
    if (torrenty.length === 0) {
        const fallback = [];
        unikatneNazvy.forEach(z => {
            const bezDia = odstranDiakritiku(z).trim();
            if (!bezDia || bezDia === primarnyBezDia) return;
            fallback.push(bezDia);
            const kratky = skratNazov(bezDia, 3);
            if (kratky && kratky !== bezDia) fallback.push(kratky);
        });
        // kratší variant primárneho názvu ako prvý (ak je dlhý)
        const primKratky = skratNazov(primarnyBezDia, 3);
        if (primKratky && primKratky !== primarnyBezDia) fallback.unshift(primKratky);

        const unikFallback = [...new Set(fallback)].slice(0, 4); // max 4, nech nepreťažíme tracker
        const vysledkyFb = await Promise.all(unikFallback.map(d =>
            hladatTorrenty(d, userAxios, 2, userKey)
        ));
        unikFallback.forEach((d, i) => spracujVysledky(d, vysledkyFb[i] || []));
    }

    // Name filter preskočíme LEN ak CSFD query reálne našla torrenty (sú to presné
    // zhody). Ak CSFD link existuje ale query nič nevrátila, filter beží — inak by
    // cez generické fallback query prešiel garbage (iné filmy s podobným názvom).
    if (!uspesneNajdeneCezCsfd) {
        const predNameFiltrom = torrenty.length;
        torrenty = torrenty.filter(t => {
            let rawName = odstranDiakritiku(t.name.toLowerCase()).replace(/^stiahni si\s*/i, "").trim();
            const prefixRe = /^(?:filmy|film|serialy|serial|seriál|seria|serie|dokumenty|dokument|tv|kreslene|kreslené|anime)\b/i;
            const junkRe = /^(?:\s+|[-–_|/]+|\[[^\]]*]|\([^)]+\)|1080p|720p|2160p|4k|hdr|web[-\s]?dl|webrip|brrip|bluray|dvdrip|tvrip|cz|sk|en)\b/i;
            
            let prev;
            do {
                prev = rawName;
                rawName = rawName.replace(prefixRe, "").trim();
                rawName = rawName.replace(junkRe, "").trim();
            } while (rawName !== prev);

            for (const nazov of unikatneNazvy) {
                const hl = odstranDiakritiku(nazov.toLowerCase()).trim();
                if (!hl) continue;
                const escaped = hl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                if (new RegExp(`\\b${escaped}\\b`, "i").test(rawName)) return true;
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

    if (vlastnyTyp === 'movie') {
        torrenty = vyfiltrujMovieTorrenty(torrenty, metaInfo, zakladneNazvy);
    }

    const execLimit = pLimit(5);
    logInfo(`Creating streams for ${torrenty.length} torrents (Max concurrency: 5)...`);
    
    // POSIELAME `metaInfo` do `vytvoritStream`
    let streamy = (await Promise.all(
        torrenty.map(t => execLimit(() => vytvoritStream(t, seria, epizoda, userAxios, metaInfo, userConfig)))
    )).filter(Boolean);

        // ── DEBRID REŽIM (TorBox / Real-Debrid) ──
        const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
        const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

        if (debridProvider && debridApiKey) {
            const providerLabel = debridProvider === 'torbox' ? 'TorBox' : 'Real-Debrid';
            const providerPrefix = debridProvider === 'torbox' ? 'TB' : 'RD';
            logInfo(`${providerLabel} enabled. Preparing streams for ${providerLabel} playback...`);
            
            const hasheKONTROLA = streamy.map(s => s.infoHash).filter(Boolean);
            const debridCache = await overitDebridCache(hasheKONTROLA, debridApiKey, debridProvider);

            streamy = streamy.map(stream => {
                const hash = stream.infoHash.toLowerCase();
                if (!precacheIdMap.has(hash)) {
                    precacheIdMap.set(hash, id); // hash → pôvodné stream ID (pre pre-cache z /play)
                    if (precacheIdMap.size > 3000) precacheIdMap.delete(precacheIdMap.keys().next().value);
                }
                const jeCached = debridCache[hash] === true;
                const jeRdBlocked = stream._sortRdBlocked === 1;
                const staraKategoria = stream.name.split("\n")[1] || "";
                const proxySeria = seria || 0;
                const proxyEpizoda = epizoda || 0;
                const sortText = `${staraKategoria} ${stream.title || ""}`;

                // Prefix podľa stavu (❌ len pre Real-Debrid)
                let streamPrefix;
                if (jeRdBlocked && debridProvider === 'realdebrid') {
                    streamPrefix = `[${providerPrefix} ❌]`;
                } else if (jeCached) {
                    streamPrefix = `[${providerPrefix} ⚡]`;
                } else {
                    streamPrefix = `[${providerPrefix} ⏳]`;
                }

                let finalStream = {
                    name: `${streamPrefix} SKT\n${staraKategoria}`,
                    title: stream.title,
                    type: vlastnyTyp,
                    behaviorHints: stream.behaviorHints,
                    _sortCached: jeCached ? 1 : 0,
                    _sortRdBlocked: jeRdBlocked ? 1 : 0,
                    _sortDub: stream.isDub ? 1 : 0,
                    _sortDubLang: stream.isDub ? (stream.dubLang || '') : '',
                    _sortHdr: stream._sortHdr || '',
                    _sortSource: stream._sortSource || 'neznámy',
                    _sortName: stream._sortName || '',
                    _sortCategory: stream._sortCategory || '',
                    _sortZaner: stream._sortZaner || '',
                    _sortQuality: getQualityRank(sortText),
                    _sortSize: getSizeBytes(sortText),
                    _sortSeeds: stream.seeds || 0
                };

                const safeName = (stream.fileName || "video.mkv").split('/').join('|');
                if (jeCached) {
                    // Cached: cez /play – okamžité prehratie
                    finalStream.url = `${requestPublicUrl}/${config}/play/${hash}/${proxySeria}/${proxyEpizoda}/${encodeURIComponent(safeName)}`;
                } else {
                    // Necachovaný: cez /download – nahranie do debridu, info video
                    finalStream.url = `${requestPublicUrl}/${config}/download/${hash}/${stream.sktId}`;
                }
                return finalStream;
            });

            const cachedOnly = userConfig.cachedOnly === true;
            if (cachedOnly) {
                streamy = streamy.filter(s => s._sortCached === 1);
            }
        }

        // ── P2P REŽIM (bez debridu) ──
        if ((!debridProvider || !debridApiKey) && streamy.length > 0) {
            logInfo("TorBox not configured. Using P2P mode (WebTorrent).");
            streamy = streamy.map(stream => {
                const staraKategoria = stream.name.split("\n")[1] || "";
                const sortText = `${staraKategoria} ${stream.title || ""}`;
                return {
                    name: `[P2P] SKT\n${staraKategoria}`,
                    title: stream.title,
                    infoHash: stream.infoHash,
                    fileIdx: stream.fileIdx,
                    sources: stream.sources,
                    behaviorHints: stream.behaviorHints,
                    _sortCached: 0,
                    _sortDub: stream.isDub ? 1 : 0,
                    _sortDubLang: stream.isDub ? (stream.dubLang || '') : '',
                    _sortName: stream._sortName || '',
                    _sortCategory: stream._sortCategory || '',
                    _sortHdr: stream._sortHdr || '',
                    _sortSource: stream._sortSource || 'neznámy',
                    _sortQuality: getQualityRank(sortText),
                    _sortSize: getSizeBytes(sortText),
                    _sortSeeds: stream.seeds || 0
                };
            });
        }

        // ── Ak nie sú žiadne streamy ──
        if (streamy.length === 0) {
            logInfo("No streams found. Returning empty list.");
            return res.json({ streams: [] });
        }

        // ── FILTROVANIE (Meteor-štýl) ──

        // 1. Cached Only filter — pre debrid režim už ošetrený vyššie; pre P2P nedáva zmysel
        const userRes = userConfig.res;
        if (userRes && Array.isArray(userRes) && userRes.length > 0 && userRes.length < 4) {
            const allowedQualities = [];
            if (userRes.includes('2160p')) allowedQualities.push(4);
            if (userRes.includes('1080p')) allowedQualities.push(3);
            if (userRes.includes('720p')) allowedQualities.push(2);
            if (userRes.includes('sd')) allowedQualities.push(1);
            if (allowedQualities.length > 0) {
                streamy = streamy.filter(s => allowedQualities.includes(s._sortQuality));
            }
        }

        
        // 2b. HDR/DV/HEVC filter (chips: hdr, dv, hevc, atmos)
        const userHdr = userConfig.hdr;
        if (userHdr && Array.isArray(userHdr) && userHdr.length > 0 && userHdr.length < 4) {
            streamy = streamy.filter(s => {
                const hdr = s._sortHdr || '';
                if (!hdr) return true; // streamy bez HDR metadát prejdú cez filter
                return userHdr.some(function(h) { return hdr.includes(h); });
            });
        }

        // 2c. 18+ filter (chips: hide)
        const userAdult = userConfig.adult;
        if (userAdult && Array.isArray(userAdult) && userAdult.includes('hide')) {
            streamy = streamy.filter(s => {
                const name = (s._sortName || '').toLowerCase();
                const cat = (s._sortCategory || '').toLowerCase();
                const zaner = (s._sortZaner || '').toLowerCase();
                const adultKeywords = ['erotick','porn','xxx','adult','18+','sex','onlyfans','erotika'];
                // Kategória xXx (aj "xXx hry (18+)") a žáner Eroticky — podľa sktorrent.eu
                if (cat.includes('xxx') || zaner.includes('erotick')) return false;
                // Názov torrentu obsahuje adult výrazy
                for (let ki = 0; ki < adultKeywords.length; ki++) {
                    if (name.includes(adultKeywords[ki])) return false;
                }
                return true;
            });
        }

        // 2d. Source type filter (chips: webdl, bluray, hdtv, dvdrip, webrip, hdrip, ppv, remux, cam)
        const userSource = userConfig.source;
        if (userSource && Array.isArray(userSource) && userSource.length > 0 && userSource.length < 12) {
            streamy = streamy.filter(s => {
                const src = (s._sortSource || 'neznámy').toLowerCase();
                // Unknown source type always passes through
                if (src === 'neznámy') return true;
                return userSource.some(function(us) { return src.includes(us); });
            });
        }

        // 3. Min seeds filter
        const minSeedsVal = parseInt(userConfig.minSeeds || '0');
        if (minSeedsVal > 0) {
            streamy = streamy.filter(s => (s._sortSeeds || 0) >= minSeedsVal);
        }

        // 4. Max size filter (in GB)
        const maxSizeVal = parseFloat(userConfig.maxSize || '0');
        if (maxSizeVal > 0) {
            const maxSizeBytes = maxSizeVal * 1024 * 1024 * 1024;
            streamy = streamy.filter(s => s._sortSize > 0 && s._sortSize <= maxSizeBytes);
        }

        // 5. Language preference — iba priorita, nefiltruje
        const userLangs = userConfig.lang;

        // ── RADENIE (podľa používateľského sort order) ──
        const sortOrder = userConfig.sort;
        if (sortOrder && Array.isArray(sortOrder) && sortOrder.length > 0) {
            streamy.sort((a, b) => {
                for (let i = 0; i < sortOrder.length; i++) {
                    const criterion = sortOrder[i];
                    let cmp = 0;

                    if (criterion === 'cached') {
                        const cacheLevel = (s) => {
                            if (debridProvider === 'realdebrid' && s._sortRdBlocked === 1) return -1; // RD blocked → najnižšia priorita
                            return s._sortCached || 0;              // cached=1, not cached=0
                        };
                        cmp = cacheLevel(b) - cacheLevel(a);
                    } else if (criterion === 'quality') {
                        cmp = (b._sortQuality || 0) - (a._sortQuality || 0);
                    } else if (criterion === 'lang') {
                        function langScore(s) {
                            if (!userLangs || !Array.isArray(userLangs) || userLangs.length === 0 || userLangs.length >= 4) return 0;
                            const dubLang = s._sortDubLang || '';
                            const isDub = s._sortDub === 1;
                            if (userLangs.includes('multi')) return 1;
                            if (userLangs.includes('sk') && (dubLang === 'sk' || dubLang === 'cz')) return 1;
                            if (userLangs.includes('cz') && (dubLang === 'cz' || dubLang === 'sk')) return 1;
                            if (userLangs.includes('en') && (!isDub || dubLang === 'en')) return 1;
                            return 0;
                        }
                        cmp = langScore(b) - langScore(a);
                    } else if (criterion === 'seeds') {
                        cmp = (b._sortSeeds || 0) - (a._sortSeeds || 0);
                    } else if (criterion === 'size') {
                        cmp = userConfig.sizeAsc ? (a._sortSize || 0) - (b._sortSize || 0) : (b._sortSize || 0) - (a._sortSize || 0);
                    }

                    if (cmp !== 0) return cmp;
                }
                return 0;
            });
        }

        // 6. Max per resolution limit (po sorte, pred cleanup)
        // POZOR: Zachováva sort order — neprehadzuje kvality!
        const maxPerResVal = parseInt(userConfig.maxPerRes || '0');
        if (maxPerResVal > 0) {
            const taken = {};
            const result = [];
            for (let i = 0; i < streamy.length; i++) {
                const s = streamy[i];
                const q = s._sortQuality || 0;
                if (!taken[q]) taken[q] = 0;
                if (taken[q] < maxPerResVal) {
                    taken[q]++;
                    result.push(s);
                }
            }
            streamy = result;
        }

        // ── PRECACHE ĎALŠEJ EPIZÓDY: rozhodovanie pre vnútorný request ──
        if (req.query.precache === '1' && seria !== undefined && epizoda !== undefined && debridProvider && debridApiKey && streamy.length > 0) {
        const cachedStream = streamy.find(s => s._sortCached === 1);
        if (cachedStream && cachedStream.url) {
            logInfo(`[PRECACHE] S${seria}E${epizoda}: cached stream nájdený, predhrievam Play Cache...`);
            axios.get(cachedStream.url, { timeout: 30000, maxRedirects: 0, validateStatus: () => true })
                .then(() => logSuccess(`[PRECACHE] S${seria}E${epizoda}: Play link úspešne predpripravený`))
                .catch(e => logWarn(`[PRECACHE] S${seria}E${epizoda}: Chyba predohrevu: ${e.message}`));
        } else {
                // Žiadna cached verzia — stiahneme najlepší uncached torrent do debridu
                const kandidat = streamy.find(s => s._sortCached === 0 && !(debridProvider === 'realdebrid' && s._sortRdBlocked === 1));
                if (kandidat && kandidat.url) {
                    const nazovKandidata = (kandidat.title || '').split('\n')[0] || 'neznámy';
                    logInfo(`[PRECACHE] S${seria}E${epizoda}: sťahujem do debridu: ${nazovKandidata}`);
                    const lokalnaUrl = kandidat.url.replace(requestPublicUrl, `http://127.0.0.1:${PORT}`);
                    axios.get(lokalnaUrl, { timeout: 30000, maxRedirects: 0, validateStatus: () => true })
                        .then(() => logSuccess(`[PRECACHE] S${seria}E${epizoda}: /download požiadavka odoslaná do debridu`))
                        .catch(e => logInfo(`[PRECACHE] S${seria}E${epizoda}: /download zlyhalo: ${e.message}`));
                } else {
                    logInfo(`[PRECACHE] S${seria}E${epizoda}: žiadny vhodný stream na stiahnutie`);
                }
            }
        }

        // Odstrániť interné _sort polia
        streamy = streamy.map(({ _sortCached, _sortRdBlocked, _sortDub, _sortDubLang, _sortName, _sortCategory, _sortZaner, _sortHdr, _sortSource, _sortQuality, _sortSize, _sortSeeds, ...rest }) => rest);

        // 7. Max results limit
        const maxResultsVal = parseInt(userConfig.maxResults || '0');
        if (maxResultsVal > 0 && streamy.length > maxResultsVal) {
            streamy = streamy.slice(0, maxResultsVal);
        }

        const trvanie = Date.now() - startCas;
        logSuccess(`Stream request finished in ${trvanie}ms. Returning ${streamy.length} streams to Stremio.`);

        // Cache-Control len pre debrid režim
        if (debridProvider && debridApiKey) {
            const maUncachedStreamy = streamy.some(s => s.name && s.name.includes("⏳"));
            const cacheMaxAge = maUncachedStreamy ? 60 : 3600;
            res.setHeader('Cache-Control', `max-age=${cacheMaxAge}, stale-while-revalidate=${cacheMaxAge}, stale-if-error=${cacheMaxAge}`);
        }

        if (!(debridProvider && debridApiKey)) {
            res.setHeader('Cache-Control', 'max-age=300, stale-while-revalidate=300, stale-if-error=300');
        }

        return res.json({ streams: streamy });
    }));


// =========================================================================
// TORBOX PROXY ROUTER
// =========================================================================

// --- Play (dispatcher TorBox / Real-Debrid) ---
app.get('/:config/play/:hash/:seria/:epizoda/:fileName', asyncRoute(async (req, res) => {
    const { hash, seria, epizoda, config } = req.params;
    const decodedFileName = safeDecode(req.params.fileName || "").replace(/\|/g, "/");
    logApi(`Play Request: Hash: ${hash} | S${seria}E${epizoda} | File: ${decodedFileName}`);

    const userConfig = decodeConfig(config);
    if (!userConfig) return res.status(400).send("Chyba konfigurácie.");

    const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
    const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

    if (!debridApiKey) {
        return res.status(400).send("Chýba debrid API kľúč.");
    }

    // PRECACHE ĎALŠEJ EPIZÓDY — /play znamená, že sa epizóda reálne začala
    // prehrávať (cached ⚡ stream). Naplánujeme pre-cache nasledujúcej epizódy.
    spustitPrecacheDalsejEpizody(userConfig, debridProvider, debridApiKey, hash, seria, epizoda, config, req);

    if (debridProvider === 'torbox') {
        return torboxPlayHandler(req, res);
    } else if (debridProvider === 'realdebrid') {
        return handleRealDebridPlay(req, res, hash, decodedFileName, debridApiKey);
    }

    return res.status(400).send("Neznámy debrid provider.");
}));

// =========================================================================
// TORBOX PLAY (play cache, čakanie na súbory) - z ZASAonSK
// =========================================================================
const torboxPlayHandler = async (req, res) => {
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
            timeout: 15000
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
};

// =========================================================================
// REAL-DEBRID PLAY - z Judzim
// =========================================================================
async function handleRealDebridPlay(req, res, hash, decodedFileName, RD_API_KEY) {
    logApi(`[RD PLAY] priame RD API pre hash: ${hash}`);
    try {
        // 1. Pridáme magnet (ak už existuje, error_code 33 = nájdeme ho v liste)
        let torrentId;
        try {
            const magnetId = await rdAddMagnet(RD_API_KEY, hash);
            torrentId = magnetId.id;
            logApi(`[RD PLAY] Magnet pridaný: ${torrentId}`);
        } catch (addErr) {
            if (addErr.response?.data?.error_code === 33) {
                // Torrent už existuje — nájdeme ho v userovom liste
                logApi(`[RD PLAY] Magnet už existuje, hľadám v liste...`);
                const listItems = await rdListTorrents(RD_API_KEY, 1, 100);
                const existing = listItems.find(t => t.hash?.toLowerCase() === hash.toLowerCase());
                if (!existing) {
                    logError(`[RD PLAY] Torrent s hash ${hash.substring(0,12)}... nenašiel v liste`);
                    return res.redirect(302, '/info-video');
                }
                torrentId = existing.id;
                logApi(`[RD PLAY] Nájdený existujúci torrent: ${torrentId} (status: ${existing.status})`);
            } else {
                throw addErr;
            }
        }

        // 2. Počkáme na magnet conversion (poll max 15x po 500ms)
        let info;
        for (let i = 0; i < 15; i++) {
            info = await rdTorrentInfo(RD_API_KEY, torrentId);
            if (info.status === 'waiting_files_selection') break;
            if (info.status === 'downloaded' || info.status === 'downloading') break;
            await new Promise(r => setTimeout(r, 500));
        }

        if (!info || info.status === 'magnet_error' || info.status === 'error') {
            logError(`[RD PLAY] Magnet conversion failed: ${info?.status}`);
            return res.redirect(302, '/info-video');
        }

        // 3. Vyberieme video súbory
        const videoFiles = (info.files || []).filter(f => /\.(mp4|mkv|avi|m4v|mov)$/i.test(f.path || ''));
        const fileIds = videoFiles.length > 0
            ? videoFiles.map(f => f.id).join(',')
            : (info.files || []).map(f => f.id).join(',');

        if (fileIds) {
            await rdSelectFiles(RD_API_KEY, torrentId, fileIds);
        }

        // 4. Skontrolujeme či je cached (progress 100 = torrent je hotový)
        info = await rdTorrentInfo(RD_API_KEY, torrentId);
        // Po selectFiles potrebuje RD chvíľu, kým prejde na status downloaded —
        // aj keď je torrent už hotový (progress 100, status ešte downloading).
        // Čakáme max 10 s LEN ak je progress 100; ak sa reálne sťahuje
        // (progress < 100), nejdeme čakať a rovno presmerujeme na info-video.
        if (info.progress === 100 && info.status !== 'downloaded') {
            for (let i = 0; i < 10 && info.status !== 'downloaded'; i++) {
                await new Promise(r => setTimeout(r, 1000));
                info = await rdTorrentInfo(RD_API_KEY, torrentId);
            }
        }

        if (info.progress === 100 && info.status === 'downloaded') {
            // 5. Nájdeme správny link a unrestrict
            const fileName = decodedFileName.split('/').pop() || '';
            let targetLink = null;

            if (info.links && info.links.length > 0) {
                // Ak máme file-level linky, vyberieme správny
                const selectedFiles = info.files.filter(f => f.selected);
                if (selectedFiles.length === info.links.length) {
                    const targetFileIdx = selectedFiles.findIndex(f =>
                        (f.path || '').includes(fileName) || fileName.includes((f.path || '').split('/').pop())
                    );
                    targetLink = targetFileIdx >= 0 ? info.links[targetFileIdx] : info.links[0];
                } else {
                    targetLink = info.links[0];
                }
            }

            if (targetLink) {
                const unrestricted = await rdUnrestrictLink(RD_API_KEY, targetLink);
                if (unrestricted && unrestricted.download) {
                    // Uložíme do cache
                    zapisatDoRdCache(hash);
                    logSuccess(`[RD PLAY] Hash ${hash.substring(0,12)} uložený do cache + redirect`);
                    return res.redirect(302, unrestricted.download);
                }
            }
        }

        logApi(`[RD PLAY] Torrent nie je cached (${info?.status}), redirect na info-video`);
        return res.redirect(302, '/info-video');

    } catch (err) {
        const status = err.response?.status;
        const rdErrCode = err.response?.data?.error_code;
        const isBlocked = status === 451 || status === 503 || err.response?.data?.code === 'UNAVAILABLE_FOR_LEGAL_REASONS' || rdErrCode === 35;

        if (isBlocked) {
            const dekNazov = safeDecode(decodedFileName || '').split('/').pop() || 'neznámy';
            logError(`[RD PLAY] RD blokuje súbor: ${dekNazov}`);
            return res.status(500).send('Real-Debrid blokuje tento súbor (infringing_file). Skús iný zdroj.');
        }

        logError(`[RD PLAY] RD API chyba`, err);
        if (err.response) {
            logError(`[RD PLAY] HTTP ${status} - ${JSON.stringify(err.response.data).substring(0, 200)}`);
        }
        return res.status(500).send(`Chyba Real-Debrid: ${err.message}`);
    }
}




// --- Download (uncached -> nahranie do debridu) ---
app.get("/:config/download/:hash/:sktId", asyncRoute(async (req, res) => {
    const { hash, sktId, config } = req.params;

    const userConfig = decodeConfig(config);
    if (!userConfig) return res.status(400).send("Chyba Configu");

    const debridProvider = userConfig.debridProvider || (userConfig.torbox ? 'torbox' : '');
    const debridApiKey = debridProvider === 'torbox' ? userConfig.torbox : (debridProvider === 'realdebrid' ? userConfig.realdebrid : null);

    if (!debridApiKey) return res.status(400).send("Chýba debrid API kľúč.");

    try {

        if (debridProvider === 'torbox') {
            // ========== TORBOX DOWNLOAD (.torrent súbor alebo magnet) ==========
            const formData = new FormData();
            // Ak má používateľ SKTorrent login, nahráme priamo .torrent (spoľahlivejšie pre súkromný tracker); inak magnet
            const sktUid = userConfig.user_id || userConfig.uid;
            const sktPass = userConfig.password || userConfig.pass;
            let torrentBuffer = null;
            if (sktUid && sktPass && sktId) {
                const dlAxios = getFastAxios({ uid: sktUid, pass: sktPass });
                const raw = await stiahnutSurovyTorrent(`${BASE_URL}/torrent/download.php?id=${encodeURIComponent(sktId)}`, dlAxios);
                torrentBuffer = Buffer.isBuffer(raw) ? raw : raw ? Buffer.from(raw) : null;
                if (torrentBuffer && torrentBuffer.length < 100) torrentBuffer = null;
            }
            logApi(torrentBuffer
                ? `[TB DOWNLOAD] nahrávam .torrent súbor (${torrentBuffer.length} B)`
                : `[TB DOWNLOAD] .torrent sa nepodarilo získať, používam magnet`);
            if (torrentBuffer) {
                formData.append("file", torrentBuffer, { filename: `${hash}.torrent`, contentType: "application/x-bittorrent" });
                formData.append("seed", "1");
            } else {
                formData.append("seed_instantly", "true");
                formData.append("allow_zip", "false");
                formData.append("seed", "2");
                formData.append("magnet", `magnet:?xt=urn:btih:${hash}`);
            }

            const createRes = await axios.post("https://api.torbox.app/v1/api/torrents/createtorrent", formData, {
                headers: { "Authorization": `Bearer ${debridApiKey}`, ...formData.getHeaders() },
                timeout: 15000
            });

            const tbData = createRes.data?.data;
            let torrentId = tbData?.torrent_id ?? tbData?.id ?? tbData?.queued_id ?? null;
            const bolQueued = !!tbData?.queued_id;

            if (torrentId) {
                try {
                    const dlRes = await axios.get("https://api.torbox.app/v1/api/torrents/requestdl", {
                        params: { token: debridApiKey, torrent_id: torrentId, zip_link: false },
                        headers: { Authorization: `Bearer ${debridApiKey}` },
                        timeout: 10000
                    });
                    const streamUrl = dlRes.data?.data;
                    if (streamUrl) {
                        logSuccess(`[TB DOWNLOAD] Torrent je rovno hrateľný, redirectujem na stream`);
                        return res.redirect(302, streamUrl);
                    }
                    logApi(`[TB DOWNLOAD] Torrent nahratý, čaká na stiahnutie`);
                } catch (dlErr) {
                    logApi(`[TB DOWNLOAD] requestdl zlyhal: ${dlErr.message}`);
                }
            }

            if (bolQueued || (!torrentId && createRes.data?.error === 'DUPLICATE_ITEM')) {
                try {
                    const mylistRes = await axios.get("https://api.torbox.app/v1/api/torrents/mylist", {
                        headers: { Authorization: `Bearer ${debridApiKey}` },
                        timeout: 15000,
                        params: { bypass_cache: true }
                    });

                    if (mylistRes.data?.success && Array.isArray(mylistRes.data.data)) {
                        const finishedSeeding = mylistRes.data.data
                            .filter(t => t.download_finished && t.active)
                            .sort((a, b) => (a.download_finished_at || 0) - (b.download_finished_at || 0));

                        if (finishedSeeding.length > 0) {
                            const toStop = finishedSeeding[0];
                            await axios.post("https://api.torbox.app/v1/api/torrents/controltorrent",
                                { torrent_id: String(toStop.id), operation: "stop_seeding" },
                                { headers: { Authorization: `Bearer ${debridApiKey}` }, timeout: 15000 }
                            );
                            logApi(`[TB SLOTS] Zastavený seeding torrentu ${toStop.id}`);

                            const queuedId = torrentId || tbData?.queued_id;
                            if (queuedId) {
                                await new Promise(r => setTimeout(r, 2000));

                                if (bolQueued) {
                                    await axios.post("https://api.torbox.app/v1/api/queued/controlqueued",
                                        { queued_id: Number(queuedId), operation: "start" },
                                        { headers: { Authorization: `Bearer ${debridApiKey}`, "Content-Type": "application/json" }, timeout: 10000 }
                                    );
                                    logApi(`[TB SLOTS] Spustený queued torrent ${queuedId}`);
                                } else {
                                    await axios.post("https://api.torbox.app/v1/api/torrents/controltorrent",
                                        { torrent_id: String(queuedId), operation: "resume" },
                                        { headers: { Authorization: `Bearer ${debridApiKey}` }, timeout: 10000 }
                                    );
                                    logApi(`[TB SLOTS] Resume queued torrent ${queuedId}`);
                                }
                            }
                        } else {
                            logApi(`[TB SLOTS] Žiadny hotový seeding torrent na uvoľnenie`);
                        }
                    }
                } catch (slotErr) {
                    logWarn(`[TB SLOTS] Chyba pri uvoľňovaní slotu: ${slotErr.message}`);
                }
            }
        } else if (debridProvider === 'realdebrid') {
            // ========== REAL-DEBRID DOWNLOAD (priame RD API) ==========
            logApi(`[RD DOWNLOAD] priame RD API pre hash: ${hash}`);

            let torrentId;
            try {
                const magnetId = await rdAddMagnet(debridApiKey, hash);
                torrentId = magnetId.id;
                logApi(`[RD DOWNLOAD] Magnet pridaný: ${torrentId}`);
            } catch (addErr) {
                if (addErr.response?.data?.error_code === 33) {
                    logApi(`[RD DOWNLOAD] Magnet už existuje, hľadám v liste...`);
                    const listItems = await rdListTorrents(debridApiKey, 1, 100);
                    const existing = listItems.find(t => t.hash?.toLowerCase() === hash.toLowerCase());
                    if (!existing) {
                        logError(`[RD DOWNLOAD] Torrent s hash ${hash.substring(0,12)}... nenašiel v liste`);
                        return res.redirect(302, '/info-video');
                    }
                    torrentId = existing.id;
                    logApi(`[RD DOWNLOAD] Nájdený existujúci torrent: ${torrentId} (status: ${existing.status})`);
                } else {
                    throw addErr;
                }
            }

            // Počkáme na magnet conversion
            let info;
            for (let i = 0; i < 15; i++) {
                info = await rdTorrentInfo(debridApiKey, torrentId);
                if (info.status === 'waiting_files_selection') break;
                if (info.status === 'downloaded' || info.status === 'downloading') break;
                await new Promise(r => setTimeout(r, 500));
            }

            if (!info || info.status === 'magnet_error' || info.status === 'error') {
                logError(`[RD DOWNLOAD] Magnet conversion failed: ${info?.status}`);
                return res.redirect(302, '/info-video');
            }

            // Vyberieme video súbory
            const videoFiles = (info.files || []).filter(f => /\.(mp4|mkv|avi|m4v|mov)$/i.test(f.path || ''));
            const fileIds = videoFiles.length > 0
                ? videoFiles.map(f => f.id).join(',')
                : (info.files || []).map(f => f.id).join(',');

            if (fileIds) {
                await rdSelectFiles(debridApiKey, torrentId, fileIds);
            }

            info = await rdTorrentInfo(debridApiKey, torrentId);
            // Keď je torrent hotový (progress 100), RD prejde na status downloaded
            // behom pár sekúnd — počkáme max 10 s, inak info-video.
            if (info.progress === 100 && info.status !== 'downloaded') {
                for (let i = 0; i < 10 && info.status !== 'downloaded'; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    info = await rdTorrentInfo(debridApiKey, torrentId);
                }
            }

            if (info.progress === 100 && info.status === 'downloaded' && info.links?.length > 0) {
                const targetLink = info.links[0];
                const unrestricted = await rdUnrestrictLink(debridApiKey, targetLink);
                if (unrestricted && unrestricted.download) {
                    // Uložíme do cache
                    zapisatDoRdCache(hash);
                    logSuccess(`[RD DOWNLOAD] Hash ${hash.substring(0,12)} uložený do cache + redirect`);
                    return res.redirect(302, unrestricted.download);
                }
            }

            logApi(`[RD DOWNLOAD] Torrent nie je cached (${info?.status}), info-video`);
        }

        res.redirect(302, '/info-video');
    } catch (err) {
        logError("Debrid API download/upload error", err);
        res.status(500).send("Chyba API sťahovania debrid služby.");
    }
}));


app.get("/logo.jpg", (req, res) => { res.sendFile(path.join(__dirname, "logo.jpg")); });
app.get("/logo.png", (req, res) => { res.sendFile(path.join(__dirname, "logo.png")); });
app.get("/ko-fi-logo.jpg", (req, res) => { res.sendFile(path.join(__dirname, "ko-fi-logo.jpg")); });

app.get("/info-video", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "stahuje-sa.mp4"));
});

// Error middleware - bez leaknutia interných detailov
app.use((err, req, res, next) => {
    logError(`Unhandled error na ${req.method} ${maskConfigVUrl(req.originalUrl)}`, err);
    if (res.headersSent) return next(err);
    if (req.path.includes("/stream/")) return res.status(500).json({ streams: [] });
    res.status(500).send("Chyba servera.");
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`🚀 SKTorrent Stremio/Nuvio Addon v${pkg.version} beží na porte ${PORT}`);
        console.log(`🌐 Public URL: ${process.env.PUBLIC_URL || `automaticky podľa requestu (lokálne http://localhost:${PORT})`}`);
        if (!process.env.ENCRYPTION_KEY) {
            console.log(`⚠️  ENCRYPTION_KEY nie je nastavený - nové linky sa nevygenerujú (alebo ALLOW_PLAINTEXT_CONFIG=1), staré Base64 stále fungujú`);
        } else {
            console.log(`🔐 Nové linky: AES-256-GCM | staré Base64 linky ostávajú platné`);
        }
        console.log(`======================================================\n`);
    });
}

module.exports = app;
module.exports.handler = app;
