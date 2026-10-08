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

function vyberNajlepsiVysledok(vysledky, rok, vlastnyTyp) {
  let filtrovane = vysledky;

  if (vlastnyTyp === "series") {
    const serialy = vysledky.filter(vysledok => vysledok.jeSerial);

    if (serialy.length > 0) {
      filtrovane = serialy;
    }
  }

  if (vlastnyTyp === "movie") {
    const filmy = vysledky.filter(vysledok => !vysledok.jeSerial);

    if (filmy.length > 0) {
      filtrovane = filmy;
    }
  }

  const hladanyRok = Number(rok);
  const maPlatnyRok = Number.isFinite(hladanyRok);

  const podlaRoku = maPlatnyRok
    ? filtrovane.find(vysledok =>
        vysledok.roky.some(
          zaznamRok => Math.abs(zaznamRok - hladanyRok) <= 1
        )
      )
    : null;

  return podlaRoku || filtrovane[0] || null;
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
    const textLower = text.toLowerCase();
    const roky = Array.from(
      text.matchAll(/\b(19|20)\d{2}\b/g)
    ).map(match => Number(match[0]));

    vysledky.push({
      title: link.text().trim(),
      url: normalizujUrl(url),
      roky,
      jeSerial:
        textLower.includes("seriál") ||
        textLower.includes("serial") ||
        textLower.includes("série") ||
        textLower.includes("series")
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

function vyberUrlZOdpovede(odpoved, rok, vlastnyTyp) {
  if (odpoved.directUrl) {
    return odpoved.directUrl;
  }

  const najdeny = vyberNajlepsiVysledok(
    odpoved.vysledky || [],
    rok,
    vlastnyTyp
  );

  return najdeny?.url
    ? normalizujUrl(najdeny.url)
    : null;
}

async function ziskatCsfdUrlZWikidata(imdbId) {
  const normalizedImdb = String(imdbId || "").trim();
  if (!/^tt\d+$/i.test(normalizedImdb)) return null;

  const redisKey = `csfd:url:v1:${normalizedImdb.toLowerCase()}`;

  if (csfdRedis) {
    try {
      const cachedUrl = normalizujUrl(await csfdRedis.get(redisKey));
      if (cachedUrl) {
        logSuccess(`ČSFD URL cache HIT: ${cachedUrl}`);
        return cachedUrl;
      }
    } catch (error) {
      logWarn(`Čítanie ČSFD URL z Redis zlyhalo: ${error.message}`);
    }
  }

  try {
    const query = `SELECT ?csfd WHERE { ?item wdt:P345 "${normalizedImdb}"; wdt:P2529 ?csfd. } LIMIT 1`;
    const response = await axios.get("https://query.wikidata.org/sparql", {
      params: { query, format: "json" },
      headers: {
        "User-Agent": "SKTorrent-Stremio-Addon/3.0",
        Accept: "application/sparql-results+json"
      },
      timeout: 10000
    });

    const rawId = response.data?.results?.bindings?.[0]?.csfd?.value;
    const id = String(rawId || "").match(/\d+/)?.[0];
    if (!id) return null;

    const url = `${CSFD_BASE_URL}/film/${id}`;

    if (csfdRedis) {
      try {
        await csfdRedis.set(redisKey, url, { ex: 365 * 24 * 60 * 60 });
      } catch (error) {
        logWarn(`Uloženie ČSFD URL do Redis zlyhalo: ${error.message}`);
      }
    }

    logSuccess(`ČSFD URL cez Wikidata bez browsera: ${url}`);
    return url;
  } catch (error) {
    logWarn(`Wikidata mapovanie zlyhalo: ${error.message}`);
    return null;
  }
}

function getCsfdStatus() {
  return {
    redisConfigured: Boolean(csfdRedis),
    storagePath: CSFD_STORAGE_PATH,
    browserFallbackEnabled: true,
    wikidataEnabled: true
  };
}

async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
  return withCache(
    `csfd_url_v7:${imdbId}`,
    86400000,
    async () => {
      const wikidataUrl = await ziskatCsfdUrlZWikidata(imdbId);
      if (wikidataUrl) return normalizujUrl(wikidataUrl);

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
          vlastnyTyp
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
        vlastnyTyp
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
  getCsfdStatus,
  normalizujUrl,
  ziskatCsfdUrl
};
