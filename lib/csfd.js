"use strict";

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

const CSFD_REDIS_KEY =
  process.env.CSFD_REDIS_KEY ||
  "csfd:storage-state:v2";

const CSFD_REDIS_LOCK_KEY =
  process.env.CSFD_REDIS_LOCK_KEY ||
  "csfd:challenge-lock:v1";

const CSFD_REDIS_TTL_SECONDS =
  Number(process.env.CSFD_REDIS_TTL_SECONDS) ||
  30 * 24 * 60 * 60;

const CSFD_REDIS_LOCK_TTL_SECONDS =
  Number(process.env.CSFD_REDIS_LOCK_TTL_SECONDS) ||
  120;

const CSFD_HTTP_TIMEOUT_MS =
  Number(process.env.CSFD_HTTP_TIMEOUT_MS) || 10000;

const CSFD_CHALLENGE_TIMEOUT_MS =
  Number(process.env.CSFD_CHALLENGE_TIMEOUT_MS) || 30000;

const CSFD_CACHE_TTL_MS =
  Number(process.env.CSFD_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;

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

// Musí zostať rovnaký pre Axios aj Playwright.
// Zmena UA medzi challenge a HTTP requestom môže spôsobiť opätovný challenge.
const CSFD_USER_AGENT =
  process.env.CSFD_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36";

const CSFD_ACCEPT_LANGUAGE =
  process.env.CSFD_ACCEPT_LANGUAGE ||
  "cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7";

let csfdStorageStateCache = null;
let csfdStorageLoaded = false;

let challengePromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizujUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const absolutnaUrl = new URL(url, CSFD_BASE_URL);

    absolutnaUrl.hash = "";

    const vyslednaUrl = absolutnaUrl.toString();

    return vyslednaUrl.replace(/\/prehled\/?$/, "/");
  } catch {
    return null;
  }
}

function jeCsfdUrl(url) {
  try {
    const parsed = new URL(url, CSFD_BASE_URL);
    const hostname = parsed.hostname.toLowerCase();

    return (
      hostname === "csfd.cz" ||
      hostname.endsWith(".csfd.cz")
    );
  } catch {
    return false;
  }
}

function jeCsfdFilmUrl(url) {
  try {
    const parsed = new URL(url, CSFD_BASE_URL);

    return (
      jeCsfdUrl(parsed.toString()) &&
      parsed.pathname.includes("/film/")
    );
  } catch {
    return false;
  }
}

function jeChallenge(title, text) {
  const titleLower = String(title || "").toLowerCase();
  const textLower = String(text || "").toLowerCase();

  return (
    titleLower.includes("nejste robot") ||
    titleLower.includes("not a robot") ||
    textLower.includes("within.website") ||
    textLower.includes("anubis") ||
    textLower.includes("proof-of-work") ||
    textLower.includes("proof of work") ||
    textLower.includes("challenge") ||
    textLower.includes("ujišťujeme se, že nejste robot") ||
    textLower.includes("ujistujeme se, ze nejste robot") ||
    textLower.includes("ověřujeme, že nejste robot") ||
    textLower.includes("overujeme, ze nie ste robot")
  );
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
      !Array.isArray(storageState.cookies)
    ) {
      return null;
    }

    if (!Array.isArray(storageState.origins)) {
      storageState.origins = [];
    }

    return storageState;
  } catch {
    return null;
  }
}

function jeCsfdCookie(cookie) {
  const domena = String(cookie?.domain || "")
    .replace(/^\./, "")
    .toLowerCase();

  return (
    domena === "csfd.cz" ||
    domena.endsWith(".csfd.cz")
  );
}

function cookieJePlatna(cookie) {
  if (!cookie || !jeCsfdCookie(cookie)) {
    return false;
  }

  if (
    cookie.expires === undefined ||
    cookie.expires === null ||
    cookie.expires === -1 ||
    cookie.expires === 0
  ) {
    return true;
  }

  return Number(cookie.expires) > Date.now() / 1000 + 30;
}

function maPlatnuCsfdCookie(storageState) {
  return Boolean(
    storageState?.cookies?.some(cookie =>
      cookieJePlatna(cookie)
    )
  );
}

function najdiNajneskorsiuExpiraciu(storageState) {
  const expiracie = (storageState?.cookies || [])
    .filter(cookie => jeCsfdCookie(cookie))
    .map(cookie => {
      if (
        cookie.expires === undefined ||
        cookie.expires === null ||
        cookie.expires === -1 ||
        cookie.expires === 0
      ) {
        return Infinity;
      }

      return Number(cookie.expires);
    })
    .filter(Number.isFinite);

  if (expiracie.length === 0) {
    return Infinity;
  }

  return Math.max(...expiracie);
}

function maNovsiStorageState(a, b) {
  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  const expiraciaA = najdiNajneskorsiuExpiraciu(a);
  const expiraciaB = najdiNajneskorsiuExpiraciu(b);

  return expiraciaB > expiraciaA ? b : a;
}

function ulozStorageStateDoSuboru(storageState) {
  const adresar = path.dirname(CSFD_STORAGE_PATH);

  const docasnaCesta =
    `${CSFD_STORAGE_PATH}.tmp-${process.pid}-${Date.now()}`;

  fs.mkdirSync(adresar, { recursive: true });

  fs.writeFileSync(
    docasnaCesta,
    JSON.stringify(storageState),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  try {
    fs.renameSync(docasnaCesta, CSFD_STORAGE_PATH);
  } catch {
    fs.rmSync(CSFD_STORAGE_PATH, { force: true });
    fs.renameSync(docasnaCesta, CSFD_STORAGE_PATH);
  }
}

async function precitajStorageStateZoSuboru() {
  if (!fs.existsSync(CSFD_STORAGE_PATH)) {
    return null;
  }

  try {
    const obsah = fs.readFileSync(
      CSFD_STORAGE_PATH,
      "utf8"
    );

    const storageState = normalizujStorageState(obsah);

    if (!storageState) {
      throw new Error("Neplatný formát storage state.");
    }

    return storageState;
  } catch (error) {
    logWarn(
      `Lokálny ČSFD storage state je neplatný: ${error.message}`
    );

    try {
      fs.rmSync(CSFD_STORAGE_PATH, { force: true });
    } catch {}

    return null;
  }
}

async function precitajStorageStateZRedis() {
  if (!csfdRedis) {
    return null;
  }

  try {
    const hodnota = await csfdRedis.get(CSFD_REDIS_KEY);

    return normalizujStorageState(hodnota);
  } catch (error) {
    logWarn(
      `Čítanie ČSFD storage state z Redis zlyhalo: ${error.message}`
    );

    return null;
  }
}

async function nacitajCsfdStorageState() {
  if (csfdStorageLoaded) {
    return csfdStorageStateCache;
  }

  csfdStorageLoaded = true;

  const lokalnyState =
    await precitajStorageStateZoSuboru();

  const redisState =
    await precitajStorageStateZRedis();

  const lokalnyPlatny =
    maPlatnuCsfdCookie(lokalnyState);

  const redisPlatny =
    maPlatnuCsfdCookie(redisState);

  let najlepsiState = null;

  if (lokalnyPlatny && redisPlatny) {
    najlepsiState = maNovsiStorageState(
      lokalnyState,
      redisState
    );
  } else if (lokalnyPlatny) {
    najlepsiState = lokalnyState;
  } else if (redisPlatny) {
    najlepsiState = redisState;
  }

  if (!najlepsiState) {
    if (csfdRedis) {
      logApi(
        "ČSFD storage state: platná cookie sa nenašla."
      );
    } else {
      logApi(
        "ČSFD Redis nie je nakonfigurovaný. " +
          "Používa sa iba lokálny súbor."
      );
    }

    csfdStorageStateCache = null;

    return null;
  }

  csfdStorageStateCache = najlepsiState;

  logSuccess(
    `ČSFD cookies načítané do RAM: ` +
      `${najlepsiState.cookies.length}`
  );

  // Ak bol novší Redis state, synchronizuj ho lokálne.
  try {
    const lokalnyExp =
      najdiNajneskorsiuExpiraciu(lokalnyState);

    const vybranyExp =
      najdiNajneskorsiuExpiraciu(najlepsiState);

    if (vybranyExp > lokalnyExp) {
      ulozStorageStateDoSuboru(najlepsiState);
      logApi(
        "ČSFD storage state synchronizovaný z Redis do súboru."
      );
    }
  } catch (error) {
    logWarn(
      `Synchronizácia ČSFD storage state zlyhala: ${error.message}`
    );
  }

  return csfdStorageStateCache;
}

async function ulozCsfdStorageState(context) {
  try {
    const storageState =
      normalizujStorageState(
        await context.storageState()
      );

    if (!storageState) {
      throw new Error(
        "Playwright vrátil neplatný storage state."
      );
    }

    csfdStorageStateCache = storageState;
    csfdStorageLoaded = true;

    ulozStorageStateDoSuboru(storageState);

    if (csfdRedis) {
      await csfdRedis.set(
        CSFD_REDIS_KEY,
        storageState,
        {
          ex: CSFD_REDIS_TTL_SECONDS
        }
      );
    }

    logSuccess(
      "ČSFD storage state aktualizovaný v RAM, " +
        "lokálnom súbore aj Redis."
    );

    return storageState;
  } catch (error) {
    logError(
      "Nepodarilo sa uložiť ČSFD storage state",
      error
    );

    return null;
  }
}

function vytvorCookieHeader(storageState) {
  if (!storageState?.cookies?.length) {
    return "";
  }

  return storageState.cookies
    .filter(cookie => cookieJePlatna(cookie))
    .map(cookie =>
      `${cookie.name}=${cookie.value}`
    )
    .join("; ");
}

function obsahujeChallengeCookie(cookies) {
  return cookies.some(cookie => {
    const nazov = String(cookie?.name || "")
      .toLowerCase();

    return (
      nazov.includes("anubis") ||
      nazov.includes("challenge")
    );
  });
}

function jeChallengeResponse(response, html) {
  const headers = response?.headers || {};

  const server = String(
    headers.server || ""
  ).toLowerCase();

  const contentType = String(
    headers["content-type"] || ""
  ).toLowerCase();

  return (
    response?.status === 403 ||
    response?.status === 429 ||
    server.includes("anubis") ||
    (
      contentType.includes("text/html") &&
      jeChallenge("", html)
    )
  );
}

function vyberNajlepsiVysledok(
  vysledky,
  rok,
  vlastnyTyp
) {
  if (!Array.isArray(vysledky) || vysledky.length === 0) {
    return null;
  }

  let filtrovane = vysledky;

  const typ = String(vlastnyTyp || "")
    .toLowerCase();

  if (typ === "series" || typ === "tv") {
    const serialy = vysledky.filter(
      vysledok => vysledok.jeSerial
    );

    if (serialy.length > 0) {
      filtrovane = serialy;
    }
  }

  if (typ === "movie" || typ === "film") {
    const filmy = vysledky.filter(
      vysledok => !vysledok.jeSerial
    );

    if (filmy.length > 0) {
      filtrovane = filmy;
    }
  }

  const hladanyRok = Number(rok);

  if (Number.isFinite(hladanyRok)) {
    const podlaRoku = filtrovane.find(vysledok =>
      vysledok.roky.some(
        zaznamRok =>
          Math.abs(zaznamRok - hladanyRok) <= 1
      )
    );

    if (podlaRoku) {
      return podlaRoku;
    }
  }

  return filtrovane[0] || null;
}

function ziskatRoky(text) {
  return Array.from(
    String(text || "").matchAll(
      /\b(?:19|20)\d{2}\b/g
    )
  ).map(match => Number(match[0]));
}

function ziskatVysledkyZHtml(html) {
  const $ = cheerio.load(html);
  const vysledky = [];
  const pouziteUrl = new Set();

  $("a.film-title-name").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    const url = normalizujUrl(href);

    if (!url || !url.includes("/film/")) {
      return;
    }

    if (pouziteUrl.has(url)) {
      return;
    }

    pouziteUrl.add(url);

    let kontajner = link.closest("article");

    if (!kontajner.length) {
      kontajner = link.closest(".article-header");
    }

    if (!kontajner.length) {
      kontajner = link.parent().parent();
    }

    const text = kontajner.text().trim();
    const textLower = text.toLowerCase();

    vysledky.push({
      title: link.text().trim(),
      url,
      roky: ziskatRoky(text),
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
  const storageState =
    await nacitajCsfdStorageState();

  const cookieHeader =
    vytvorCookieHeader(storageState);

  if (!cookieHeader) {
    logApi(
      "ČSFD HTTP fast-path: chýba platná cookie."
    );

    return {
      typ: "challenge"
    };
  }

  try {
    logApi(
      "ČSFD HTTP fast-path: požiadavka bez browsera."
    );

    const response = await axios.get(searchUrl, {
      headers: {
        "User-Agent": CSFD_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml," +
          "application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": CSFD_ACCEPT_LANGUAGE,
        Cookie: cookieHeader,
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      },
      timeout: CSFD_HTTP_TIMEOUT_MS,
      maxRedirects: 5,
      responseType: "text",
      validateStatus: status =>
        status >= 200 && status < 500
    });

    const html = String(response.data || "");

    const finalUrl =
      response.request?.res?.responseUrl ||
      searchUrl;

    if (
      jeCsfdFilmUrl(finalUrl) &&
      !jeChallengeResponse(response, html)
    ) {
      logSuccess(
        "ČSFD HTTP fast-path: priame presmerovanie na film."
      );

      return {
        typ: "uspech",
        directUrl: normalizujUrl(finalUrl),
        vysledky: []
      };
    }

    if (jeChallengeResponse(response, html)) {
      logWarn(
        `ČSFD HTTP fast-path: challenge ` +
          `(HTTP ${response.status}).`
      );

      return {
        typ: "challenge",
        status: response.status
      };
    }

    if (response.status < 200 || response.status >= 300) {
      logWarn(
        `ČSFD HTTP fast-path vrátil ` +
          `HTTP ${response.status}.`
      );

      return {
        typ: "chyba",
        status: response.status
      };
    }

    const vysledky =
      ziskatVysledkyZHtml(html);

    if (vysledky.length === 0) {
      logWarn(
        "ČSFD HTTP fast-path nenašiel výsledky."
      );

      return {
        typ: "chyba"
      };
    }

    logSuccess(
      `ČSFD HTTP fast-path úspešný. ` +
        `Výsledkov: ${vysledky.length}`
    );

    return {
      typ: "uspech",
      vysledky
    };
  } catch (error) {
    logWarn(
      `ČSFD HTTP fast-path zlyhal: ${error.message}`
    );

    return {
      typ: "chyba",
      error
    };
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

  return (
    moznosti.find(cesta =>
      fs.existsSync(cesta)
    ) || null
  );
}

async function otvorBrowser() {
  const {
    chromium: playwright
  } = require("playwright-core");

  if (os.platform() === "win32") {
    const chromePath =
      najdiChromeWindows();

    if (!chromePath) {
      throw new Error(
        "Nenašiel som Google Chrome ani Microsoft Edge. " +
          "Nainštaluj Chrome/Edge alebo nastav CHROME_PATH."
      );
    }

    logApi(
      `Lokálny browser: ${chromePath}`
    );

    return playwright.launch({
      executablePath: chromePath,
      headless: true,
      chromiumSandbox: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-sync",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-notifications",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--disable-features=Translate,BackForwardCache",
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }

  if (os.platform() === "linux") {
    const chromium =
      require("@sparticuz/chromium");

    chromium.setGraphicsMode = false;

    const executablePath =
      await chromium.executablePath();

    logApi(
      `Serverové Chromium: ${executablePath}`
    );

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
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--disable-sync",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-notifications",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
        "--disable-features=Translate,BackForwardCache",
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }

  throw new Error(
    `Nepodporovaný operačný systém: ${os.platform()}`
  );
}

async function vytvorBrowserContext(browser) {
  const storageState =
    await nacitajCsfdStorageState();

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
      "Accept-Language": CSFD_ACCEPT_LANGUAGE
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
      "Browser odmietol uložený storage state. " +
        "Používam čistý context."
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
    return await page
      .locator("a.film-title-name")
      .count();
  } catch {
    return 0;
  }
}

async function jeStrankaPripravena(page) {
  const title = await page.title().catch(() => "");
  const text = await ziskatTextStranky(page);
  const pocetVysledkov =
    await ziskatPocetVysledkov(page);

  const challenge =
    jeChallenge(title, text);

  const filmovaUrl =
    jeCsfdFilmUrl(page.url());

  return (
    !challenge &&
    (
      pocetVysledkov > 0 ||
      filmovaUrl
    )
  );
}

async function pockajNaChallenge(
  page,
  context,
  timeoutMs = CSFD_CHALLENGE_TIMEOUT_MS
) {
  const zaciatok = Date.now();
  let reloadPouzity = false;

  while (Date.now() - zaciatok < timeoutMs) {
    try {
      if (await jeStrankaPripravena(page)) {
        return true;
      }

      const title = await page.title().catch(() => "");
      const text = await ziskatTextStranky(page);
      const cookies = await context.cookies();

      const challenge =
        jeChallenge(title, text);

      const authCookie =
        obsahujeChallengeCookie(cookies);

      if (
        authCookie &&
        challenge &&
        !reloadPouzity
      ) {
        reloadPouzity = true;

        logApi(
          "Overovacia cookie nájdená. " +
            "Vykonávam jedno riadené obnovenie."
        );

        try {
          await page.reload({
            waitUntil: "domcontentloaded",
            timeout: 30000
          });
        } catch (error) {
          if (
            !String(error.message || "")
              .toLowerCase()
              .includes("timeout")
          ) {
            throw error;
          }
        }

        await sleep(500);
        continue;
      }

      const sekundy = Math.round(
        (Date.now() - zaciatok) / 1000
      );

      logApi(
        `Čakám na ČSFD challenge... ${sekundy}s`
      );

      await sleep(800);
    } catch (error) {
      const sprava =
        String(error.message || "");

      const prechodnaChyba =
        sprava.includes("page is navigating") ||
        sprava.includes("Target page") ||
        sprava.includes("Execution context was destroyed");

      if (!prechodnaChyba) {
        throw error;
      }

      await sleep(400);
    }
  }

  return false;
}

async function vyriesChallenge(searchUrl) {
  let browser = null;
  let context = null;

  try {
    browser = await otvorBrowser();
    context =
      await vytvorBrowserContext(browser);

    const page = await context.newPage();

    await page.route("**/*", async route => {
      const request = route.request();
      const resourceType =
        request.resourceType();

      const requestUrl =
        request.url().toLowerCase();

      const blokovaneTypy = new Set([
        "image",
        "media",
        "font",
        "stylesheet",
        "websocket"
      ]);

      const blokovaneSluzby =
        requestUrl.includes("google-analytics") ||
        requestUrl.includes("googletagmanager") ||
        requestUrl.includes("doubleclick") ||
        requestUrl.includes("facebook.com/tr");

      if (
        blokovaneTypy.has(resourceType) ||
        blokovaneSluzby
      ) {
        await route.abort();
        return;
      }

      await route.continue();
    });

    logApi(
      `Otváram ČSFD challenge: ${searchUrl}`
    );

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const uspesne =
      await pockajNaChallenge(
        page,
        context,
        CSFD_CHALLENGE_TIMEOUT_MS
      );

    if (!uspesne) {
      logWarn(
        "ČSFD challenge sa v limite nevyriešila."
      );

      return false;
    }

    const ulozenyState =
      await ulozCsfdStorageState(context);

    if (!ulozenyState) {
      return false;
    }

    logSuccess(
      "ČSFD challenge úspešne vyriešená."
    );

    return true;
  } catch (error) {
    logError(
      "Chyba pri riešení ČSFD challenge",
      error
    );

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

function vytvorLockValue() {
  return [
    process.pid,
    Date.now(),
    Math.random().toString(36).slice(2)
  ].join(":");
}

async function uvolniRedisLock(lockValue) {
  if (!csfdRedis) {
    return;
  }

  try {
    const aktualnaHodnota =
      await csfdRedis.get(CSFD_REDIS_LOCK_KEY);

    if (aktualnaHodnota === lockValue) {
      await csfdRedis.del(CSFD_REDIS_LOCK_KEY);
    }
  } catch (error) {
    logWarn(
      `Uvoľnenie ČSFD Redis locku zlyhalo: ${error.message}`
    );
  }
}

async function pockajNaCudziChallenge() {
  const zaciatok = Date.now();

  while (
    Date.now() - zaciatok <
    (CSFD_CHALLENGE_TIMEOUT_MS + 10000)
  ) {
    await sleep(1000);

    const redisState =
      await precitajStorageStateZRedis();

    if (maPlatnuCsfdCookie(redisState)) {
      csfdStorageStateCache = redisState;
      csfdStorageLoaded = true;

      try {
        ulozStorageStateDoSuboru(redisState);
      } catch {}

      logSuccess(
        "Používam cookie vyriešenú iným procesom."
      );

      return true;
    }

    if (challengePromise) {
      return challengePromise;
    }
  }

  return false;
}

async function spustiChallengeSLockom(searchUrl) {
  if (!csfdRedis) {
    return vyriesChallenge(searchUrl);
  }

  const lockValue = vytvorLockValue();

  try {
    const lockResult = await csfdRedis.set(
      CSFD_REDIS_LOCK_KEY,
      lockValue,
      {
        nx: true,
        ex: CSFD_REDIS_LOCK_TTL_SECONDS
      }
    );

    if (lockResult !== "OK") {
      logApi(
        "ČSFD challenge už rieši iný proces. " +
          "Čakám na jeho cookie."
      );

      return pockajNaCudziChallenge();
    }

    try {
      // Medzitým mohol cookie vyriešiť iný proces.
      const aktualnyState =
        await precitajStorageStateZRedis();

      if (maPlatnuCsfdCookie(aktualnyState)) {
        csfdStorageStateCache = aktualnyState;
        csfdStorageLoaded = true;

        return true;
      }

      return await vyriesChallenge(searchUrl);
    } finally {
      await uvolniRedisLock(lockValue);
    }
  } catch (error) {
    logWarn(
      `Redis challenge lock zlyhal: ${error.message}`
    );

    return vyriesChallenge(searchUrl);
  }
}

async function zabezpecPlatnuCsfdCookie(searchUrl) {
  if (challengePromise) {
    logApi(
      "ČSFD challenge už rieši iná požiadavka."
    );

    return challengePromise;
  }

  challengePromise =
    spustiChallengeSLockom(searchUrl)
      .finally(() => {
        challengePromise = null;
      });

  return challengePromise;
}

function vyberUrlZOdpovede(
  odpoved,
  rok,
  vlastnyTyp
) {
  if (odpoved?.directUrl) {
    return odpoved.directUrl;
  }

  const najdeny =
    vyberNajlepsiVysledok(
      odpoved?.vysledky || [],
      rok,
      vlastnyTyp
    );

  return najdeny?.url
    ? normalizujUrl(najdeny.url)
    : null;
}

function vytvorCacheKey(
  imdbId,
  nazov,
  rok,
  vlastnyTyp
) {
  const identifikator =
    imdbId ||
    `${nazov}|${rok || ""}|${vlastnyTyp || ""}`;

  return (
    "csfd_url_v8:" +
    String(identifikator)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
  );
}

async function ziskatCsfdUrl(
  imdbId,
  nazov,
  rok,
  vlastnyTyp
) {
  return withCache(
    vytvorCacheKey(
      imdbId,
      nazov,
      rok,
      vlastnyTyp
    ),
    CSFD_CACHE_TTL_MS,
    async () => {
      const cistyNazov =
        String(nazov || "").trim();

      if (!cistyNazov) {
        logWarn(
          "Chýba názov filmu alebo seriálu."
        );

        return null;
      }

      const query =
        encodeURIComponent(cistyNazov);

      const searchUrl =
        `${CSFD_BASE_URL}/hledat/?q=${query}`;

      logApi(
        `Hľadám ČSFD URL pre IMDb: ${imdbId || "bez ID"} ` +
          `(Názov: ${cistyNazov}, Rok: ${rok || "?"}, ` +
          `Typ: ${vlastnyTyp || "?"})`
      );

      let odpoved =
        await skusHttpVyhladavanie(searchUrl);

      if (odpoved.typ === "uspech") {
        const url =
          vyberUrlZOdpovede(
            odpoved,
            rok,
            vlastnyTyp
          );

        if (url) {
          logSuccess(
            `ČSFD URL nájdené bez browsera: ${url}`
          );

          return url;
        }

        logWarn(
          "HTTP odpoveď bola úspešná, " +
            "ale výsledok sa nepodarilo vybrať."
        );

        return null;
      }

      if (odpoved.typ !== "challenge") {
        return null;
      }

      const challengeOk =
        await zabezpecPlatnuCsfdCookie(searchUrl);

      if (!challengeOk) {
        logWarn(
          "ČSFD challenge sa nepodarilo vyriešiť."
        );

        return null;
      }

      // Po challenge načítaj cookie z RAM,
      // bez zbytočného čítania súboru/Redis.
      odpoved =
        await skusHttpVyhladavanie(searchUrl);

      if (odpoved.typ !== "uspech") {
        logWarn(
          "ČSFD HTTP vyhľadávanie neuspelo " +
            "ani po challenge."
        );

        return null;
      }

      const finalnaUrl =
        vyberUrlZOdpovede(
          odpoved,
          rok,
          vlastnyTyp
        );

      if (!finalnaUrl) {
        logWarn(
          `Nepodarilo sa vybrať výsledok pre: ${cistyNazov}`
        );

        return null;
      }

      logSuccess(
        `ČSFD URL úspešne nájdené: ${finalnaUrl}`
      );

      return finalnaUrl;
    }
  );
}

module.exports = {
  ziskatCsfdUrl
};