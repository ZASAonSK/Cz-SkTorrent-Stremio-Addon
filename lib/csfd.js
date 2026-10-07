const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const {
  logApi,
  logError,
  logSuccess,
  logWarn,
  withCache
} = require("./common");

const CSFD_BASE_URL = "https://www.csfd.cz";

function normalizujUrl(url) {
  if (!url) {
    return null;
  }

  return url.replace(/\/prehled\/?$/, "/");
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

  const podlaRoku = filtrovane.find(vysledok =>
    vysledok.roky.some(zaznamRok =>
      zaznamRok === hladanyRok ||
      zaznamRok === hladanyRok - 1 ||
      zaznamRok === hladanyRok + 1
    )
  );

  return podlaRoku || filtrovane[0] || null;
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

  const jeWindows = os.platform() === "win32";
  const jeLinux = os.platform() === "linux";

  if (jeWindows) {
    const chromePath = najdiChromeWindows();

    if (!chromePath) {
      throw new Error(
        "Nenašiel som Google Chrome ani Microsoft Edge. " +
        "Nainštaluj jeden z nich alebo nastav CHROME_PATH."
      );
    }

    logApi(`Lokálne Windows Chromium: ${chromePath}`);

    return playwright.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage"
      ]
    });
  }

  if (jeLinux) {
    const chromium = require("@sparticuz/chromium");

    logApi("Serverové Linux Chromium: @sparticuz/chromium");

    const executablePath = await chromium.executablePath();

    return playwright.launch({
      executablePath,
      headless: true,
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
  }

  throw new Error(
    `Nepodporovaný operačný systém pre browser: ${os.platform()}`
  );
}

async function ziskatCsfdUrl(imdbId, nazov, rok, vlastnyTyp) {
  return withCache(
    `csfd_url_v3:${imdbId}`,
    86400000,
    async () => {
      logApi(
        `Hľadám ČSFD URL cez browser pre IMDB: ${imdbId} ` +
        `(Názov: ${nazov}, Rok: ${rok}, Typ: ${vlastnyTyp})`
      );

      if (!nazov || !String(nazov).trim()) {
        logWarn("Chýba názov filmu alebo seriálu.");
        return null;
      }

      let browser = null;

      try {
        browser = await otvorBrowser();

        const page = await browser.newPage({
          locale: "cs-CZ",
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",
          viewport: {
            width: 1365,
            height: 768
          },
          extraHTTPHeaders: {
            "Accept-Language":
              "cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7"
          }
        });

        const query = encodeURIComponent(String(nazov).trim());
        const searchUrl = `${CSFD_BASE_URL}/hledat/?q=${query}`;

        logApi(`Otváram ČSFD: ${searchUrl}`);

        const response = await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        await page.waitForTimeout(10000);

        const title = await page.title();
        const html = await page.content();

        const challenge =
          title.toLowerCase().includes("nejste robot") ||
          html.includes("within.website") ||
          html.toLowerCase().includes("anubis");

        if (challenge) {
          logWarn(
            "ČSFD vrátilo anti-bot challenge aj v browseri."
          );

          return null;
        }

        const vysledky = await page
          .locator("a.film-title-name")
          .evaluateAll(elements =>
            elements.map(element => {
              const article =
                element.closest("article") ||
                element.closest(".article-header") ||
                element.parentElement?.parentElement;

              const text =
                article?.textContent?.trim() || "";

              const roky = Array.from(
                text.matchAll(/\b(19|20)\d{2}\b/g)
              ).map(match => Number(match[0]));

              const textLower = text.toLowerCase();

              return {
                title: element.textContent?.trim() || "",
                url: element.href,
                roky,
                jeSerial:
                  textLower.includes("seriál") ||
                  textLower.includes("serial") ||
                  textLower.includes("série") ||
                  textLower.includes("series")
              };
            })
          );

        if (!vysledky.length) {
          logWarn(
            `ČSFD nenašlo výsledky pre: ${nazov}`
          );

          return null;
        }

        const najdeny = vyberNajlepsiVysledok(
          vysledky,
          rok,
          vlastnyTyp
        );

        if (!najdeny || !najdeny.url) {
          logWarn(
            `Nepodarilo sa vybrať výsledok pre: ${nazov}`
          );

          return null;
        }

        const finalnaUrl = normalizujUrl(najdeny.url);

        logSuccess(
          `Úspešne nájdené ČSFD URL: ${finalnaUrl}`
        );

        return finalnaUrl;
      } catch (error) {
        logError(
          `Chyba pri browserovom získavaní ČSFD URL pre ${nazov}`,
          error
        );

        console.error("ČSFD browser detail:", {
          message: error.message,
          code: error.code || null,
          stack: error.stack
        });

        return null;
      } finally {
        if (browser) {
          try {
            await browser.close();
          } catch (closeError) {
            console.error(
              "Chyba pri zatváraní browsera:",
              closeError.message
            );
          }
        }
      }
    }
  );
}

module.exports = {
  ziskatCsfdUrl
};