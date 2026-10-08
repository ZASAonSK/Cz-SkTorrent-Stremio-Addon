const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const cheerio = require("cheerio");
const { Redis } = require("@upstash/redis");

const {
  logApi,
  logError,
  logSuccess,
  logWarn,
  withCache
} = require("./common");

const CSFD_BASE_URL = "https://www.csfd.cz";
const CSFD_STORAGE_PATH =
  process.env.CSFD_STORAGE_PATH ||
  path.join(os.tmpdir(), "csfd-storage-state.json");

const CSFD_REDIS_KEY = "csfd:storage-state:v1";
const CSFD_REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;

const redisUrl =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL;

const redisToken =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN;

const csfdRedis =
  redisUrl && redisToken
    ? new Redis({
        url: redisUrl,
        token: redisToken
      })
    : null;

const CSFD_USER_AGENT =
  os.platform() === "win32"
    ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36"
    : "Mozilla/5.0 (X11; Linux x86_64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36";

let challengePromise = null;

function normalizujImdbId(imdbId) {
  const value = String(imdbId || "").trim();
  return /^tt\d+$/i.test(value) ? value.toLowerCase() : null;
}

function normalizujTmdbId(tmdbId) {
  const value = String(tmdbId || "").trim();
  return /^\d+$/.test(value) ? value : null;
}

const WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql";

async function najdiCsfdCezWikidata({ tmdbId = null, imdbId = null } = {}) {
  const normalizedTmdb = normalizujTmdbId(tmdbId);
  const normalizedImdb = normalizujImdbId(imdbId);

  if (!normalizedTmdb && !normalizedImdb) {
    return null;
  }

  const lookupParts = [];

  if (normalizedTmdb) {
    lookupParts.push(`?item wdt:P4983 "${normalizedTmdb}".`);
  }

  if (normalizedImdb) {
    lookupParts.push(`?item wdt:P345 "${normalizedImdb}".`);
  }

  const query = `
    SELECT ?item ?csfdId WHERE {
      {
        ${lookupParts.join("\n      } UNION {\n        ")}
      }
      OPTIONAL { ?item wdt:P2529 ?csfdId. }
      FILTER(BOUND(?csfdId))
    }
    LIMIT 10
  `;

  try {
    logApi(
      `Wikidata lookup: TMDB=${normalizedTmdb || "-"}, IMDb=${normalizedImdb || "-"}`
    );

    const response = await axios.get(WIKIDATA_SPARQL_URL, {
      params: {
        query,
        format: "json"
      },
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": "Stremio-CSFD-Resolver/1.0"
      },
      timeout: 8000
    });

    const bindings = response.data?.results?.bindings || [];

    for (const row of bindings) {
      const csfdId = String(row.csfdId?.value || "").trim();

      if (!/^\d+$/.test(csfdId)) {
        continue;
      }

      const url = normalizujUrl(`${CSFD_BASE_URL}/film/${csfdId}`);

      if (!url) {
        continue;
      }

      const item = row.item?.value || null;

      logSuccess(
        `Wikidata: nájdené ČSFD ID ${csfdId}` +
        `${item ? ` (${item})` : ""} → ${url}`
      );

      return url;
    }

    logApi(
      `Wikidata: ČSFD ID sa nenašlo pre TMDB=${normalizedTmdb || "-"}, IMDb=${normalizedImdb || "-"}`
    );

    return null;
  } catch (error) {
    logWarn(
      `Wikidata lookup zlyhal: ${error?.message || error}`
    );
    return null;
  }
}

function vytvorCsfdCacheKey(imdbId, tmdbId, nazov, rok, vlastnyTyp) {
  const normalizedImdb = normalizujImdbId(imdbId);
  if (normalizedImdb) {
    return `csfd_url_v9:imdb:${normalizedImdb}`;
  }

  const normalizedTmdb = normalizujTmdbId(tmdbId);
  if (normalizedTmdb) {
    return `csfd_url_v9:tmdb:${String(vlastnyTyp || "unknown").toLowerCase()}:${normalizedTmdb}`;
  }

  const normalizedTitle = String(nazov || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");

  const normalizedYear = Number.isFinite(Number(rok)) ? String(Number(rok)) : "na";
  const normalizedType = String(vlastnyTyp || "unknown").toLowerCase();

  return `csfd_url_v9:title:${normalizedType}:${normalizedTitle}:${normalizedYear}`;
}

function normalizujUrl(url) {
  if (!url) return null;

  try {
    const parsed = new URL(url, CSFD_BASE_URL);
    const hostname = parsed.hostname.toLowerCase();

    if (hostname !== "csfd.cz" && !hostname.endsWith(".csfd.cz")) {
      return null;
    }

    parsed.protocol = "https:";
    parsed.hostname = "www.csfd.cz";
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = parsed.pathname
      .replace(/\/prehled\/?$/, "")
      .replace(/\/+$/, "");

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function jeChallenge(title, text) {
  const titleLower = String(title || "").toLowerCase();
  const textLower = String(text || "").toLowerCase();

  return (
    titleLower.includes("nejste robot") ||
    textLower.includes("within.website") ||
    textLower.includes("anubis") ||
    textLower.includes("proof-of-work") ||
    textLower.includes("ujišťujeme se, že nejste robot") ||
    textLower.includes("ujistujeme se, ze nejste robot")
  );
}

function jeCsfdFilmUrl(url) {
  try {
    const parsed = new URL(url, CSFD_BASE_URL);

    return (
      parsed.hostname.endsWith("csfd.cz") &&
      parsed.pathname.includes("/film/")
    );
  } catch {
    return false;
  }
}

function normalizujStorageState(hodnota) {
  if (!hodnota) {
    return null;
  }

  try {
    const storageState =
      typeof hodnota === "string"
        ? JSON.parse(hodnota)
        : hodnota;

    if (
      !storageState ||
      !Array.isArray(storageState.cookies) ||
      !Array.isArray(storageState.origins)
    ) {
      return null;
    }

    return storageState;
  } catch {
    return null;
  }
}

function ulozStorageStateDoSuboru(storageState) {
  const adresar = path.dirname(CSFD_STORAGE_PATH);
  const docasnaCesta =
    `${CSFD_STORAGE_PATH}.tmp-${process.pid}-${Date.now()}`;

  fs.mkdirSync(adresar, { recursive: true });
  fs.writeFileSync(
    docasnaCesta,
    JSON.stringify(storageState),
    { encoding: "utf8", mode: 0o600 }
  );

  try {
    fs.renameSync(docasnaCesta, CSFD_STORAGE_PATH);
  } catch {
    fs.rmSync(CSFD_STORAGE_PATH, { force: true });
    fs.renameSync(docasnaCesta, CSFD_STORAGE_PATH);
  }
}

async function nacitajCsfdStorageState() {
  if (fs.existsSync(CSFD_STORAGE_PATH)) {
    try {
      const storageState = normalizujStorageState(
        fs.readFileSync(CSFD_STORAGE_PATH, "utf8")
      );

      if (!storageState) {
        throw new Error("Neplatný formát storageState.");
      }

      logSuccess(
        `ČSFD cookies načítané z lokálneho súboru: ` +
        `${storageState.cookies.length}`
      );

      return storageState;
    } catch (error) {
      logWarn(
        `Lokálny ČSFD storage state je neplatný: ${error.message}`
      );

      try {
        fs.rmSync(CSFD_STORAGE_PATH, { force: true });
      } catch {}
    }
  }

  if (!csfdRedis) {
    logApi(
      "ČSFD Redis nie je nakonfigurovaný. Používam iba lokálny súbor."
    );
    return null;
  }

  try {
    const redisHodnota = await csfdRedis.get(CSFD_REDIS_KEY);
    const storageState = normalizujStorageState(redisHodnota);

    if (!storageState) {
      logApi("ČSFD Redis cache: MISS");
      return null;
    }

    logSuccess(
      `ČSFD Redis cache: HIT, cookies: ${storageState.cookies.length}`
    );

    try {
      ulozStorageStateDoSuboru(storageState);
      logApi("ČSFD cookies obnovené z Redis do lokálneho súboru.");
    } catch (error) {
      logWarn(
        `Cookies z Redis sa nepodarilo uložiť lokálne: ${error.message}`
      );
    }

    return storageState;
  } catch (error) {
    logWarn(
      `Čítanie ČSFD cookies z Redis zlyhalo: ${error.message}`
    );
    return null;
  }
}

async function ulozCsfdStorageState(context) {
  try {
    const storageState = await context.storageState();

    try {
      ulozStorageStateDoSuboru(storageState);
      logSuccess(
        `ČSFD cookies uložené lokálne do: ${CSFD_STORAGE_PATH}`
      );
    } catch (error) {
      logWarn(
        `Lokálne uloženie ČSFD cookies zlyhalo: ${error.message}`
      );
    }

    if (!csfdRedis) {
      logWarn(
        "ČSFD Redis nie je nakonfigurovaný. Cookies zostali iba lokálne."
      );
      return;
    }

    try {
      await csfdRedis.set(
        CSFD_REDIS_KEY,
        storageState,
        { ex: CSFD_REDIS_TTL_SECONDS }
      );

      logSuccess(
        "ČSFD cookies uložené do Redis cache na 30 dní."
      );
    } catch (error) {
      logWarn(
        `Uloženie ČSFD cookies do Redis zlyhalo: ${error.message}`
      );
    }
  } catch (error) {
    logWarn(
      `Nepodarilo sa exportovať ČSFD cookies: ${error.message}`
    );
  }
}

function vytvorCookieHeader(storageState) {
  if (!storageState?.cookies?.length) {
    return "";
  }

  const teraz = Date.now() / 1000;

  return storageState.cookies
    .filter(cookie => {
      const domena = String(cookie.domain || "")
        .replace(/^\./, "")
        .toLowerCase();

      const patriCsfd =
        domena === "csfd.cz" ||
        domena.endsWith(".csfd.cz");

      const nevyprsala =
        !cookie.expires ||
        cookie.expires === -1 ||
        cookie.expires > teraz;

      return patriCsfd && nevyprsala;
    })
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function normalizujNazov(hodnota) {
  return String(hodnota || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ČSFD označuje reality show a podobné relácie ako "TV pořad", nie "seriál".
// TMDB/Stremio ich pritom vedie ako series, preto ich berieme ako seriálový typ.
function zistiTypVysledku(text) {
  const t = normalizujNazov(text);

  return {
    jeSerial: /\b(serial|serie|series)\b/.test(t),
    jeTvPorad: /\btv porad\b/.test(t)
  };
}

function ohodnotVysledok(vysledok, { rok, vlastnyTyp, nazvy }) {
  let skore = 0;
  let rokSedi = null;

  const jeSeriovy = vysledok.jeSerial || vysledok.jeTvPorad;

  // Typ je iba mäkký signál, nie tvrdý filter.
  if (vlastnyTyp === "series") {
    skore += jeSeriovy ? 20 : -30;
  } else if (vlastnyTyp === "movie") {
    skore += jeSeriovy ? -30 : 10;
  }

  // Rok je rozhodujúci: ak ho poznáme a výsledok ho má, musí sedieť (+-1).
  const hladanyRok = Number(rok);
  const maPlatnyRok = Number.isFinite(hladanyRok) && hladanyRok > 0;

  if (maPlatnyRok && vysledok.roky.length > 0) {
    const rozdiel = Math.min(
      ...vysledok.roky.map(zaznamRok => Math.abs(zaznamRok - hladanyRok))
    );

    rokSedi = rozdiel <= 1;
    skore += rokSedi ? 40 : -100;
  }

  // Zhoda názvu: presná zhoda nadpisu > názov niekde v karte (alias / pôvodný názov).
  const nazovVysledku = normalizujNazov(vysledok.title);

  if (nazvy.includes(nazovVysledku)) {
    skore += 50;
  } else if (
    vysledok.textNorm &&
    nazvy.some(nazov => ` ${vysledok.textNorm} `.includes(` ${nazov} `))
  ) {
    skore += 15;
  }

  return { skore, rokSedi };
}

function vyberNajlepsiVysledok(
  vysledky,
  rok,
  vlastnyTyp,
  alternativneNazvy = []
) {
  const nazvy = [...new Set(
    alternativneNazvy.map(normalizujNazov).filter(Boolean)
  )];

  const ohodnotene = vysledky
    .map(vysledok => ({
      vysledok,
      ...ohodnotVysledok(vysledok, { rok, vlastnyTyp, nazvy })
    }))
    // Array.sort je stabilný, takže pri rovnakom skóre ostáva poradie z ČSFD.
    .sort((a, b) => b.skore - a.skore);

  ohodnotene.slice(0, 5).forEach(({ vysledok, skore, rokSedi }, i) => {
    logApi(
      `ČSFD kandidát #${i + 1}: "${vysledok.title}" ` +
      `roky=[${vysledok.roky.join(",")}] ` +
      `serial=${vysledok.jeSerial} tvPorad=${vysledok.jeTvPorad} ` +
      `rokSedi=${rokSedi} skóre=${skore} ${vysledok.url}`
    );
  });

  const najlepsi = ohodnotene[0];

  if (!najlepsi) {
    return null;
  }

  // Radšej žiadny ČSFD link (zaberie textové hľadanie) než zlý film/seriál.
  if (najlepsi.rokSedi === false) {
    logWarn(
      `ČSFD: žiadny výsledok nesedí na rok ${rok}. ` +
      `Najlepší kandidát "${najlepsi.vysledok.title}" zamietnutý.`
    );
    return null;
  }

  return najlepsi.vysledok;
}

function ziskatVysledkyZHtml(html) {
  const $ = cheerio.load(html);
  const vysledky = [];

  $("a.film-title-name").each((_, element) => {
    const link = $(element);
    const url = link.attr("href");

    if (!url || !url.includes("/film/")) {
      return;
    }

    let kontajner = link.closest("article");

    if (!kontajner.length) {
      kontajner = link.closest(".article-header");
    }

    if (!kontajner.length) {
      kontajner = link.parent().parent();
    }

    const text = kontajner.text().trim();

    // Typ a rok najprv hľadáme v hlavičke (rok/typ pri názve), až potom v celej karte,
    // aby popis alebo herci nespôsobili falošnú zhodu.
    const info = kontajner.find(".film-title-info").first().text().trim();

    const rokyZ = zdroj =>
      Array.from(zdroj.matchAll(/\b(19|20)\d{2}\b/g)).map(m => Number(m[0]));

    let roky = rokyZ(info);
    if (roky.length === 0) roky = rokyZ(text);

    let typ = zistiTypVysledku(info);
    if (!typ.jeSerial && !typ.jeTvPorad) typ = zistiTypVysledku(text);

    vysledky.push({
      title: link.text().trim(),
      url: normalizujUrl(url),
      roky,
      textNorm: normalizujNazov(text),
      jeSerial: typ.jeSerial,
      jeTvPorad: typ.jeTvPorad
    });
  });

  return vysledky;
}

async function skusHttpVyhladavanie(searchUrl) {
  const storageState = await nacitajCsfdStorageState();
  const cookieHeader = vytvorCookieHeader(storageState);

  if (!cookieHeader) {
    logApi("ČSFD HTTP fast-path: chýba platná cookie.");
    return { typ: "challenge" };
  }

  try {
    logApi("ČSFD HTTP fast-path: skúšam požiadavku bez browsera.");

    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": CSFD_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7",
        Cookie: cookieHeader,
        "Cache-Control": "no-cache"
      },
      timeout: 10000,
      maxRedirects: 5,
      responseType: "text",
      validateStatus: status => status >= 200 && status < 500
    });

    const html = String(response.data || "");
    const finalUrl =
      response.request?.res?.responseUrl || searchUrl;

    if (jeCsfdFilmUrl(finalUrl) && !jeChallenge("", html)) {
      logSuccess(
        "ČSFD HTTP fast-path: priame presmerovanie na film."
      );

      return {
        typ: "uspech",
        directUrl: normalizujUrl(finalUrl),
        vysledky: []
      };
    }

    if (
      response.status === 403 ||
      response.status === 429 ||
      jeChallenge("", html)
    ) {
      logWarn(
        "ČSFD HTTP fast-path: cookie neplatí, treba browser challenge."
      );
      return { typ: "challenge" };
    }

    if (response.status < 200 || response.status >= 300) {
      logWarn(
        `ČSFD HTTP fast-path vrátil HTTP ${response.status}.`
      );
      return { typ: "chyba" };
    }

    const vysledky = ziskatVysledkyZHtml(html);

    if (vysledky.length === 0) {
      logWarn("ČSFD HTTP fast-path nenašiel výsledky.");
      return { typ: "chyba" };
    }

    logSuccess(
      `ČSFD HTTP fast-path úspešný. Výsledkov: ${vysledky.length}`
    );

    return { typ: "uspech", vysledky };
  } catch (error) {
    logWarn(
      `ČSFD HTTP fast-path zlyhal: ${error.message}`
    );
    return { typ: "chyba" };
  }
}

function najdiChromeWindows() {
  const moznosti = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(
      process.env.LOCALAPPDATA || "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe"
    ),
    path.join(
      process.env.LOCALAPPDATA || "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe"
    )
  ].filter(Boolean);

  return moznosti.find(cesta => fs.existsSync(cesta)) || null;
}

async function otvorBrowser() {
  const { chromium: playwright } = require("playwright-core");

  if (os.platform() === "win32") {
    const chromePath = najdiChromeWindows();

    if (!chromePath) {
      throw new Error(
        "Nenašiel som Google Chrome ani Microsoft Edge. " +
        "Nainštaluj Chrome alebo Edge, prípadne nastav CHROME_PATH."
      );
    }

    logApi(`Lokálny Windows browser: ${chromePath}`);

    return playwright.launch({
      executablePath: chromePath,
      headless: true,
      chromiumSandbox: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }

  if (os.platform() === "linux") {
    const chromium = require("@sparticuz/chromium");

    logApi("Serverové Linux Chromium: @sparticuz/chromium");
    chromium.setGraphicsMode = false;

    const executablePath = await chromium.executablePath();
    logApi(`Chromium executable: ${executablePath}`);

    return playwright.launch({
      executablePath,
      headless: true,
      chromiumSandbox: false,
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }

  throw new Error(
    `Nepodporovaný operačný systém: ${os.platform()}`
  );
}

async function vytvorBrowserContext(browser) {
  const storageState = await nacitajCsfdStorageState();

  const options = {
    locale: "cs-CZ",
    timezoneId: "Europe/Prague",
    colorScheme: "light",
    userAgent: CSFD_USER_AGENT,
    viewport: {
      width: 1365,
      height: 768
    },
    extraHTTPHeaders: {
      "Accept-Language":
        "cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7"
    }
  };

  if (storageState) {
    options.storageState = storageState;
  }

  try {
    return await browser.newContext(options);
  } catch (error) {
    if (!storageState) {
      throw error;
    }

    logWarn(
      "Browser odmietol uložený ČSFD stav. Používam čistý context."
    );

    delete options.storageState;
    return browser.newContext(options);
  }
}

async function ziskatTextStranky(page) {
  try {
    return await page.locator("body").innerText({
      timeout: 2000
    });
  } catch {
    return "";
  }
}

async function ziskatPocetVysledkov(page) {
  try {
    return await page.locator("a.film-title-name").count();
  } catch {
    return 0;
  }
}

async function pockajNaChallenge(page, context, timeoutMs = 30000) {
  const zaciatok = Date.now();
  let reloadPouzity = false;

  while (Date.now() - zaciatok < timeoutMs) {
    let title = "";
    let textStranky = "";
    let pocetVysledkov = 0;
    let cookies = [];

    try {
      title = await page.title();
      textStranky = await ziskatTextStranky(page);
      pocetVysledkov = await ziskatPocetVysledkov(page);
      cookies = await context.cookies();
    } catch (error) {
      const sprava = String(error.message || "");

      if (
        sprava.includes("page is navigating") ||
        sprava.includes("Target page") ||
        sprava.includes("Execution context was destroyed")
      ) {
        await page.waitForTimeout(400);
        continue;
      }

      throw error;
    }

    const challenge = jeChallenge(title, textStranky);

    if (
      !challenge &&
      (
        pocetVysledkov > 0 ||
        jeCsfdFilmUrl(page.url())
      )
    ) {
      return true;
    }

    const authCookie = cookies.find(cookie => {
      const nazov = cookie.name.toLowerCase();

      return (
        nazov.includes("anubis") ||
        nazov.includes("challenge")
      );
    });

    if (authCookie && challenge && !reloadPouzity) {
      reloadPouzity = true;

      logApi(
        "Overovacia cookie nájdená. Robím jedno riadené obnovenie."
      );

      try {
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
      } catch (error) {
        if (!String(error.message || "").includes("Timeout")) {
          throw error;
        }
      }

      await page.waitForTimeout(1000);
      continue;
    }

    const sekundy = Math.round(
      (Date.now() - zaciatok) / 1000
    );

    logApi(
      `Čakám na ČSFD challenge... ${sekundy}s, ` +
      `výsledkov: ${pocetVysledkov}, ` +
      `cookie: ${Boolean(authCookie)}`
    );

    await page.waitForTimeout(800);
  }

  return false;
}

async function vyriesChallenge(searchUrl) {
  let browser = null;
  let context = null;

  try {
    browser = await otvorBrowser();
    context = await vytvorBrowserContext(browser);

    const page = await context.newPage();

    await page.route("**/*", async route => {
      const typ = route.request().resourceType();

      if (
        typ === "image" ||
        typ === "media" ||
        typ === "font"
      ) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    logApi(`Otváram ČSFD challenge: ${searchUrl}`);

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const uspesne = await pockajNaChallenge(
      page,
      context,
      30000
    );

    if (!uspesne) {
      logWarn("ČSFD challenge sa do 30 sekúnd nevyriešila.");
      return false;
    }

    await ulozCsfdStorageState(context);

    logSuccess(
      "ČSFD challenge úspešne vyriešená a cookie uložená."
    );

    return true;
  } catch (error) {
    logError("Chyba pri riešení ČSFD challenge", error);
    return false;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {}
    }

    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

async function zabezpecPlatnuCsfdCookie(searchUrl) {
  if (!challengePromise) {
    challengePromise = vyriesChallenge(searchUrl).finally(() => {
      challengePromise = null;
    });
  } else {
    logApi(
      "ČSFD challenge už rieši iná požiadavka. Čakám na dokončenie."
    );
  }

  return challengePromise;
}

function vyberUrlZOdpovede(odpoved, rok, vlastnyTyp, nazvy = []) {
  if (odpoved.directUrl) {
    return odpoved.directUrl;
  }

  const najdeny = vyberNajlepsiVysledok(
    odpoved.vysledky || [],
    rok,
    vlastnyTyp,
    nazvy
  );

  return najdeny?.url
    ? normalizujUrl(najdeny.url)
    : null;
}

async function ziskatCsfdUrl(
  imdbId,
  nazov,
  rok,
  vlastnyTyp,
  tmdbId = null,
  alternativneNazvy = []
) {
  return withCache(
    vytvorCsfdCacheKey(imdbId, tmdbId, nazov, rok, vlastnyTyp),
    86400000,
    async () => {
      // 1. PRIMÁRNY RESOLVER: Wikidata
      // Najprv skúšame presné ID prepojenie TMDB/IMDb -> Wikidata -> ČSFD.
      // Nehľadáme sezónu ani epizódu; ČSFD URL je vždy URL celého seriálu/filmu.
      const wikidataUrl = await najdiCsfdCezWikidata({
        tmdbId,
        imdbId
      });

      if (wikidataUrl) {
        logSuccess(
          `ČSFD URL získané cez Wikidata: ${wikidataUrl}`
        );
        return wikidataUrl;
      }

      // 2. FALLBACK: pôvodné vyhľadávanie podľa názvu na ČSFD.
      if (!nazov || !String(nazov).trim()) {
        logWarn("Chýba názov filmu alebo seriálu.");
        return null;
      }

      const query = encodeURIComponent(
        String(nazov).trim()
      );

      const searchUrl =
        `${CSFD_BASE_URL}/hledat/?q=${query}`;

      logApi(
        `Hľadám ČSFD URL pre IMDB: ${imdbId} ` +
        `(Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp})`
      );

      let odpoved = await skusHttpVyhladavanie(searchUrl);

      if (odpoved.typ === "uspech") {
        const url = vyberUrlZOdpovede(
          odpoved,
          rok,
          vlastnyTyp,
          [nazov, ...alternativneNazvy]
        );

        if (url) {
          logSuccess(
            `Úspešne nájdené ČSFD URL bez browsera: ${url}`
          );
          return url;
        }
      }

      if (odpoved.typ !== "challenge") {
        return null;
      }

      const challengeOk =
        await zabezpecPlatnuCsfdCookie(searchUrl);

      if (!challengeOk) {
        return null;
      }

      odpoved = await skusHttpVyhladavanie(searchUrl);

      if (odpoved.typ !== "uspech") {
        logWarn(
          "ČSFD HTTP vyhľadávanie neuspelo ani po challenge."
        );
        return null;
      }

      const finalnaUrl = vyberUrlZOdpovede(
        odpoved,
        rok,
        vlastnyTyp,
        [nazov, ...alternativneNazvy]
      );

      if (!finalnaUrl) {
        logWarn(
          `Nepodarilo sa vybrať výsledok pre: ${nazov}`
        );
        return null;
      }

      logSuccess(
        `Úspešne nájdené ČSFD URL: ${finalnaUrl}`
      );

      return finalnaUrl;
    }
  );
}

module.exports = {
  normalizujUrl,
  vyberNajlepsiVysledok,
  ziskatCsfdUrl
};