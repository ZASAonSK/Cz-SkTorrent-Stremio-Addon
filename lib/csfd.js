"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
  "csfd:storage-state:v3";

const CSFD_REDIS_LOCK_KEY =
  process.env.CSFD_REDIS_LOCK_KEY ||
  "csfd:challenge-lock:v3";

const CSFD_REDIS_TTL_SECONDS =
  Number(process.env.CSFD_REDIS_TTL_SECONDS) ||
  30 * 24 * 60 * 60;

const CSFD_REDIS_LOCK_TTL_SECONDS =
  Number(process.env.CSFD_REDIS_LOCK_TTL_SECONDS) ||
  120;

const CSFD_HTTP_TIMEOUT_MS =
  Number(process.env.CSFD_HTTP_TIMEOUT_MS) || 15000;

const CSFD_CHALLENGE_TIMEOUT_MS =
  Number(process.env.CSFD_CHALLENGE_TIMEOUT_MS) || 45000;

const CSFD_CHALLENGE_RETRY_DELAY_MS =
  Number(process.env.CSFD_CHALLENGE_RETRY_DELAY_MS) || 800;

const CSFD_CACHE_TTL_MS =
  Number(process.env.CSFD_CACHE_TTL_MS) ||
  24 * 60 * 60 * 1000;

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

// Rovnaký User-Agent musí použiť Axios aj Playwright.
const CSFD_USER_AGENT =
  process.env.CSFD_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36";

const CSFD_ACCEPT_LANGUAGE =
  process.env.CSFD_ACCEPT_LANGUAGE ||
  "cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7";

let storageStateCache = null;
let storageStateLoaded = false;
let challengePromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizujUrl(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url, CSFD_BASE_URL);

    parsed.hash = "";

    return parsed
      .toString()
      .replace(/\/prehled\/?$/, "/");
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

/**
 * Dôležité:
 * Nepoužívame iba text "challenge".
 * To bolo príliš široké a mohlo označiť aj normálnu stránku.
 */
function jeChallenge(title, text) {
  const titleLower = String(title || "")
    .toLowerCase();

  const textLower = String(text || "")
    .toLowerCase();

  return (
    titleLower.includes("nejste robot") ||
    titleLower.includes("not a robot") ||
    titleLower.includes("overenie") ||
    titleLower.includes("ověření") ||
    textLower.includes("within.website") ||
    textLower.includes("anubis") ||
    textLower.includes("proof-of-work") ||
    textLower.includes("proof of work") ||
    textLower.includes("ujišťujeme se, že nejste robot") ||
    textLower.includes("ujistujeme se, ze nejste robot") ||
    textLower.includes("ověřujeme, že nejste robot") ||
    textLower.includes("overujeme, ze nie ste robot")
  );
}

function normalizujStorageState(value) {
  if (!value) {
    return null;
  }

  try {
    const state =
      typeof value === "string"
        ? JSON.parse(value)
        : value;

    if (
      !state ||
      !Array.isArray(state.cookies)
    ) {
      return null;
    }

    if (!Array.isArray(state.origins)) {
      state.origins = [];
    }

    return state;
  } catch {
    return null;
  }
}

function jeCsfdCookie(cookie) {
  const domain = String(cookie?.domain || "")
    .replace(/^\./, "")
    .toLowerCase();

  return (
    domain === "csfd.cz" ||
    domain.endsWith(".csfd.cz")
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

  return Number(cookie.expires) >
    Date.now() / 1000 + 30;
}

function maPlatnuCookie(state) {
  return Boolean(
    state?.cookies?.some(cookie =>
      cookieJePlatna(cookie)
    )
  );
}

function najdiAnubisCookie(state) {
  return state?.cookies?.find(cookie => {
    const name = String(cookie?.name || "")
      .toLowerCase();

    return (
      name.includes("anubis") &&
      cookieJePlatna(cookie)
    );
  }) || null;
}

function vytvorCookieHeader(state) {
  if (!state?.cookies?.length) {
    return "";
  }

  return state.cookies
    .filter(cookie => cookieJePlatna(cookie))
    .map(cookie =>
      `${cookie.name}=${cookie.value}`
    )
    .join("; ");
}

function najdiExpiraciu(state) {
  const expiracie = (state?.cookies || [])
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

  return expiracie.length
    ? Math.max(...expiracie)
    : Infinity;
}

function vyberNovsiState(a, b) {
  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  return najdiExpiraciu(b) > najdiExpiraciu(a)
    ? b
    : a;
}

function ulozStateDoSuboru(state) {
  const directory =
    path.dirname(CSFD_STORAGE_PATH);

  const tempPath =
    `${CSFD_STORAGE_PATH}.tmp-${process.pid}-${Date.now()}`;

  fs.mkdirSync(directory, {
    recursive: true
  });

  fs.writeFileSync(
    tempPath,
    JSON.stringify(state),
    {
      encoding: "utf8",
      mode: 0o600
    }
  );

  try {
    fs.renameSync(
      tempPath,
      CSFD_STORAGE_PATH
    );
  } catch {
    fs.rmSync(CSFD_STORAGE_PATH, {
      force: true
    });

    fs.renameSync(
      tempPath,
      CSFD_STORAGE_PATH
    );
  }
}

async function nacitajStateZoSuboru() {
  if (!fs.existsSync(CSFD_STORAGE_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(
      CSFD_STORAGE_PATH,
      "utf8"
    );

    const state =
      normalizujStorageState(content);

    if (!state) {
      throw new Error(
        "Neplatný JSON storage state."
      );
    }

    return state;
  } catch (error) {
    logWarn(
      `Lokálny ČSFD storage state je neplatný: ${error.message}`
    );

    try {
      fs.rmSync(CSFD_STORAGE_PATH, {
        force: true
      });
    } catch {}

    return null;
  }
}

async function nacitajStateZRedis() {
  if (!csfdRedis) {
    return null;
  }

  try {
    const value = await csfdRedis.get(
      CSFD_REDIS_KEY
    );

    return normalizujStorageState(value);
  } catch (error) {
    logWarn(
      `Čítanie ČSFD state z Redis zlyhalo: ${error.message}`
    );

    return null;
  }
}

async function nacitajStorageState() {
  if (storageStateLoaded) {
    return storageStateCache;
  }

  storageStateLoaded = true;

  const [localState, redisState] =
    await Promise.all([
      nacitajStateZoSuboru(),
      nacitajStateZRedis()
    ]);

  const localValid =
    maPlatnuCookie(localState);

  const redisValid =
    maPlatnuCookie(redisState);

  let selectedState = null;

  if (localValid && redisValid) {
    selectedState =
      vyberNovsiState(
        localState,
        redisState
      );
  } else if (localValid) {
    selectedState = localState;
  } else if (redisValid) {
    selectedState = redisState;
  }

  storageStateCache = selectedState;

  if (!selectedState) {
    logWarn(
      "ČSFD: nebola nájdená platná auth cookie."
    );

    return null;
  }

  logSuccess(
    `ČSFD cookie načítaná do RAM: ` +
      `${selectedState.cookies.length}`
  );

  try {
    const localExpiry =
      najdiExpiraciu(localState);

    const selectedExpiry =
      najdiExpiraciu(selectedState);

    if (selectedExpiry > localExpiry) {
      ulozStateDoSuboru(selectedState);
    }
  } catch (error) {
    logWarn(
      `Synchronizácia lokálneho state zlyhala: ${error.message}`
    );
  }

  return selectedState;
}

async function ulozStorageState(context) {
  try {
    const state =
      normalizujStorageState(
        await context.storageState()
      );

    if (!state) {
      throw new Error(
        "Playwright vrátil neplatný storage state."
      );
    }

    const anubisCookie =
      najdiAnubisCookie(state);

    if (!anubisCookie) {
      logWarn(
        "Browser skončil bez platnej Anubis cookie. " +
          "State sa neuloží ako úspešný."
      );

      return null;
    }

    storageStateCache = state;
    storageStateLoaded = true;

    ulozStateDoSuboru(state);

    if (csfdRedis) {
      await csfdRedis.set(
        CSFD_REDIS_KEY,
        state,
        {
          ex: CSFD_REDIS_TTL_SECONDS
        }
      );
    }

    logSuccess(
      "ČSFD auth cookie uložená do RAM, súboru a Redis."
    );

    return state;
  } catch (error) {
    logError(
      "Uloženie ČSFD storage state zlyhalo",
      error
    );

    return null;
  }
}

function jeChallengeResponse(response, html) {
  const headers = response?.headers || {};

  const server = String(
    headers.server || ""
  ).toLowerCase();

  const body = String(html || "");

  return (
    response?.status === 403 ||
    response?.status === 429 ||
    server.includes("anubis") ||
    jeChallenge("", body)
  );
}

function ziskajRoky(text) {
  return Array.from(
    String(text || "").matchAll(
      /\b(?:19|20)\d{2}\b/g
    )
  ).map(match => Number(match[0]));
}

function ziskatVysledkyZHtml(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("a.film-title-name").each((_, element) => {
    const link = $(element);
    const href = link.attr("href");
    const url = normalizujUrl(href);

    if (!url || !url.includes("/film/")) {
      return;
    }

    if (seen.has(url)) {
      return;
    }

    seen.add(url);

    let container = link.closest("article");

    if (!container.length) {
      container = link.closest(
        ".article-header"
      );
    }

    if (!container.length) {
      container = link.parent().parent();
    }

    const text = container.text().trim();
    const lower = text.toLowerCase();

    results.push({
      title: link.text().trim(),
      url,
      roky: ziskajRoky(text),
      jeSerial:
        lower.includes("seriál") ||
        lower.includes("serial") ||
        lower.includes("série") ||
        lower.includes("series")
    });
  });

  return results;
}

function vyberNajlepsiVysledok(
  results,
  rok,
  type
) {
  if (!Array.isArray(results) ||
      results.length === 0) {
    return null;
  }

  const normalizedType =
    String(type || "").toLowerCase();

  let filtered = results;

  if (
    normalizedType === "series" ||
    normalizedType === "tv"
  ) {
    const series = results.filter(
      item => item.jeSerial
    );

    if (series.length) {
      filtered = series;
    }
  }

  if (
    normalizedType === "movie" ||
    normalizedType === "film"
  ) {
    const movies = results.filter(
      item => !item.jeSerial
    );

    if (movies.length) {
      filtered = movies;
    }
  }

  const wantedYear = Number(rok);

  if (Number.isFinite(wantedYear)) {
    const byYear = filtered.find(item =>
      item.roky.some(itemYear =>
        Math.abs(itemYear - wantedYear) <= 1
      )
    );

    if (byYear) {
      return byYear;
    }
  }

  return filtered[0] || null;
}

async function skusHttpVyhladavanie(searchUrl) {
  const state =
    await nacitajStorageState();

  const cookieHeader =
    vytvorCookieHeader(state);

  if (!cookieHeader) {
    logApi(
      "ČSFD HTTP: bez platnej cookie."
    );

    return {
      typ: "challenge"
    };
  }

  try {
    const response = await axios.get(
      searchUrl,
      {
        headers: {
          "User-Agent": CSFD_USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml," +
            "application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            CSFD_ACCEPT_LANGUAGE,
          Cookie: cookieHeader,
          "Cache-Control": "no-cache",
          Pragma: "no-cache"
        },
        timeout: CSFD_HTTP_TIMEOUT_MS,
        maxRedirects: 5,
        responseType: "text",
        validateStatus: status =>
          status >= 200 && status < 500
      }
    );

    const html = String(response.data || "");

    const finalUrl =
      response.request?.res?.responseUrl ||
      searchUrl;

    if (
      jeChallengeResponse(response, html)
    ) {
      logWarn(
        `ČSFD HTTP: Anubis challenge ` +
          `(HTTP ${response.status}).`
      );

      return {
        typ: "challenge",
        status: response.status,
        html
      };
    }

    if (jeCsfdFilmUrl(finalUrl)) {
      return {
        typ: "uspech",
        directUrl: normalizujUrl(finalUrl),
        vysledky: []
      };
    }

    if (
      response.status < 200 ||
      response.status >= 300
    ) {
      return {
        typ: "chyba",
        status: response.status
      };
    }

    const results =
      ziskatVysledkyZHtml(html);

    if (!results.length) {
      logWarn(
        "ČSFD HTTP: odpoveď bez výsledkov."
      );

      return {
        typ: "chyba"
      };
    }

    logSuccess(
      `ČSFD HTTP úspešné. Výsledkov: ${results.length}`
    );

    return {
      typ: "uspech",
      vysledky: results
    };
  } catch (error) {
    logWarn(
      `ČSFD HTTP request zlyhal: ${error.message}`
    );

    return {
      typ: "chyba",
      error
    };
  }
}

function najdiChromeWindows() {
  const candidates = [
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

  return candidates.find(candidate =>
    fs.existsSync(candidate)
  ) || null;
}

async function otvorBrowser() {
  const {
    chromium
  } = require("playwright-core");

  if (os.platform() === "win32") {
    const executablePath =
      najdiChromeWindows();

    if (!executablePath) {
      throw new Error(
        "Chrome/Edge nebol nájdený. " +
          "Nastav CHROME_PATH."
      );
    }

    return chromium.launch({
      executablePath,
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
    const chromiumPackage =
      require("@sparticuz/chromium");

    chromiumPackage.setGraphicsMode = false;

    const executablePath =
      await chromiumPackage.executablePath();

    return chromium.launch({
      executablePath,
      headless: true,
      chromiumSandbox: false,
      args: [
        ...chromiumPackage.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-extensions",
        "--disable-background-networking",
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
    `Nepodporovaný OS: ${os.platform()}`
  );
}

async function vytvorBrowserContext(browser) {
  const state =
    await nacitajStorageState();

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
        CSFD_ACCEPT_LANGUAGE
    }
  };

  if (state) {
    options.storageState = state;
  }

  try {
    return await browser.newContext(options);
  } catch (error) {
    logWarn(
      `Vytvorenie browser contextu so state zlyhalo: ${error.message}`
    );

    delete options.storageState;

    return browser.newContext(options);
  }
}

async function nastavMinimalnyRequestFilter(page) {
  await page.route("**/*", async route => {
    const request = route.request();
    const type = request.resourceType();
    const url = request.url().toLowerCase();

    // JavaScript a stylesheet nechávame.
    // Anubis ich môže potrebovať.
    const blockType =
      type === "image" ||
      type === "media" ||
      type === "font" ||
      type === "websocket";

    const blockTracker =
      url.includes("google-analytics") ||
      url.includes("googletagmanager") ||
      url.includes("doubleclick") ||
      url.includes("facebook.com/tr") ||
      url.includes("connect.facebook.net") ||
      url.includes("hotjar");

    if (blockType || blockTracker) {
      await route.abort();
      return;
    }

    await route.continue();
  });
}

async function ziskajChallengeStav(page, context) {
  const title =
    await page.title().catch(() => "");

  const body =
    await page.locator("body")
      .innerText({ timeout: 1500 })
      .catch(() => "");

  const cookies =
    await context.cookies();

  const anubisCookie =
    najdiAnubisCookie({
      cookies
    });

  const challenge =
    jeChallenge(title, body);

  const resultCount =
    await page.locator("a.film-title-name")
      .count()
      .catch(() => 0);

  const filmUrl =
    jeCsfdFilmUrl(page.url());

  return {
    title,
    body,
    cookies,
    anubisCookie,
    challenge,
    resultCount,
    filmUrl
  };
}

async function pockajNaVyriesenieChallenge(
  page,
  context,
  timeoutMs = CSFD_CHALLENGE_TIMEOUT_MS
) {
  const startedAt = Date.now();
  let lastLog = 0;
  let reloadDone = false;

  while (
    Date.now() - startedAt < timeoutMs
  ) {
    const state =
      await ziskajChallengeStav(
        page,
        context
      );

    // Normálna stránka je pripravená.
    if (
      !state.challenge &&
      (
        state.resultCount > 0 ||
        state.filmUrl
      )
    ) {
      return true;
    }

    // Cookie sa získala, ale stránka ešte môže
    // byť na pôvodnom interstitiale.
    if (
      state.anubisCookie &&
      !state.challenge
    ) {
      return true;
    }

    // Ak je cookie získaná, urobíme jedno reload.
    // Tým sa interstitial prepne na cieľovú stránku.
    if (
      state.anubisCookie &&
      state.challenge &&
      !reloadDone
    ) {
      reloadDone = true;

      logApi(
        "Anubis cookie získaná. " +
          "Obnovujem stránku."
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

    const now = Date.now();

    if (now - lastLog > 5000) {
      lastLog = now;

      logApi(
        `ČSFD challenge čaká... ` +
          `${Math.round(
            (now - startedAt) / 1000
          )}s, ` +
          `cookie=${Boolean(state.anubisCookie)}, ` +
          `challenge=${state.challenge}, ` +
          `results=${state.resultCount}`
      );
    }

    await sleep(
      CSFD_CHALLENGE_RETRY_DELAY_MS
    );
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

    const page =
      await context.newPage();

    await nastavMinimalnyRequestFilter(page);

    logApi(
      `Browser rieši ČSFD challenge: ${searchUrl}`
    );

    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const solved =
      await pockajNaVyriesenieChallenge(
        page,
        context
      );

    if (!solved) {
      logWarn(
        "ČSFD challenge sa v browseri nevyriešila."
      );

      return false;
    }

    const state =
      normalizujStorageState(
        await context.storageState()
      );

    const authCookie =
      najdiAnubisCookie(state);

    if (!authCookie) {
      logWarn(
        "Browser tvrdil, že challenge skončil, " +
          "ale Anubis cookie chýba."
      );

      return false;
    }

    storageStateCache = state;
    storageStateLoaded = true;

    ulozStateDoSuboru(state);

    if (csfdRedis) {
      await csfdRedis.set(
        CSFD_REDIS_KEY,
        state,
        {
          ex: CSFD_REDIS_TTL_SECONDS
        }
      );
    }

    logSuccess(
      "ČSFD challenge vyriešená a auth cookie uložená."
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
    crypto.randomUUID()
  ].join(":");
}

async function uvolniLock(lockValue) {
  if (!csfdRedis) {
    return;
  }

  try {
    const current =
      await csfdRedis.get(
        CSFD_REDIS_LOCK_KEY
      );

    if (current === lockValue) {
      await csfdRedis.del(
        CSFD_REDIS_LOCK_KEY
      );
    }
  } catch (error) {
    logWarn(
      `ČSFD lock sa nepodarilo uvoľniť: ${error.message}`
    );
  }
}

async function pockajNaChallengeInyProces() {
  const startedAt = Date.now();

  while (
    Date.now() - startedAt <
    CSFD_CHALLENGE_TIMEOUT_MS + 15000
  ) {
    await sleep(1000);

    const redisState =
      await nacitajStateZRedis();

    if (maPlatnuCookie(redisState)) {
      storageStateCache = redisState;
      storageStateLoaded = true;

      try {
        ulozStateDoSuboru(redisState);
      } catch {}

      return true;
    }
  }

  return false;
}

async function vyriesChallengeSLockom(searchUrl) {
  if (!csfdRedis) {
    return vyriesChallenge(searchUrl);
  }

  const lockValue =
    vytvorLockValue();

  try {
    const lockResult =
      await csfdRedis.set(
        CSFD_REDIS_LOCK_KEY,
        lockValue,
        {
          nx: true,
          ex: CSFD_REDIS_LOCK_TTL_SECONDS
        }
      );

    if (lockResult !== "OK") {
      logApi(
        "ČSFD challenge rieši iný worker."
      );

      return pockajNaChallengeInyProces();
    }

    try {
      const freshState =
        await nacitajStateZRedis();

      if (maPlatnuCookie(freshState)) {
        storageStateCache = freshState;
        storageStateLoaded = true;

        return true;
      }

      return vyriesChallenge(searchUrl);
    } finally {
      await uvolniLock(lockValue);
    }
  } catch (error) {
    logWarn(
      `ČSFD Redis lock zlyhal: ${error.message}`
    );

    return vyriesChallenge(searchUrl);
  }
}

async function zabezpecCookie(searchUrl) {
  if (challengePromise) {
    return challengePromise;
  }

  challengePromise =
    vyriesChallengeSLockom(searchUrl)
      .finally(() => {
        challengePromise = null;
      });

  return challengePromise;
}

function vyberUrlZOdpovede(
  response,
  rok,
  type
) {
  if (response?.directUrl) {
    return response.directUrl;
  }

  const result =
    vyberNajlepsiVysledok(
      response?.vysledky || [],
      rok,
      type
    );

  return result?.url
    ? normalizujUrl(result.url)
    : null;
}

function vytvorCacheKey(
  imdbId,
  title,
  year,
  type
) {
  const base =
    imdbId ||
    `${title}|${year || ""}|${type || ""}`;

  return (
    "csfd_url_v9:" +
    String(base)
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
      const title =
        String(nazov || "").trim();

      if (!title) {
        logWarn(
          "Chýba názov filmu alebo seriálu."
        );

        return null;
      }

      const searchUrl =
        `${CSFD_BASE_URL}/hledat/?q=` +
        encodeURIComponent(title);

      logApi(
        `Hľadám ČSFD URL pre IMDb: ` +
          `${imdbId || "bez ID"} ` +
          `(Názov: ${title}, Rok: ${rok || "?"}, ` +
          `Typ: ${vlastnyTyp || "?"})`
      );

      let response =
        await skusHttpVyhladavanie(searchUrl);

      if (response.typ === "uspech") {
        const url =
          vyberUrlZOdpovede(
            response,
            rok,
            vlastnyTyp
          );

        if (url) {
          logSuccess(
            `ČSFD URL nájdené bez browsera: ${url}`
          );
        }

        return url;
      }

      if (response.typ !== "challenge") {
        return null;
      }

      const solved =
        await zabezpecCookie(searchUrl);

      if (!solved) {
        logWarn(
          "ČSFD challenge sa nepodarilo vyriešiť."
        );

        return null;
      }

      // Overenie, že cookie je naozaj akceptovaná.
      response =
        await skusHttpVyhladavanie(searchUrl);

      if (response.typ !== "uspech") {
        logWarn(
          "Cookie bola získaná, ale ČSFD ju " +
            "neakceptovalo pri HTTP requeste."
        );

        // Zahoď nefunkčný state, aby sa pri ďalšom
        // requeste neopakoval nekonečný cyklus.
        storageStateCache = null;

        return null;
      }

      const finalUrl =
        vyberUrlZOdpovede(
          response,
          rok,
          vlastnyTyp
        );

      if (!finalUrl) {
        logWarn(
          `Výsledok sa nepodarilo vybrať pre: ${title}`
        );

        return null;
      }

      logSuccess(
        `ČSFD URL úspešne nájdené: ${finalUrl}`
      );

      return finalUrl;
    }
  );
}

module.exports = {
  ziskatCsfdUrl
};