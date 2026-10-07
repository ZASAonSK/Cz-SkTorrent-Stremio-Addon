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

const CSFD_STORAGE_PATH =
  process.env.CSFD_STORAGE_PATH ||
  path.join(
    os.tmpdir(),
    "csfd-storage-state.json"
  );

function normalizujUrl(url) {
  if (!url) {
    return null;
  }

  return url.replace(/\/prehled\/?$/, "/");
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

function ziskajUserAgent() {
  if (os.platform() === "win32") {
    return (
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/131.0.0.0 Safari/537.36"
    );
  }

  return (
    "Mozilla/5.0 (X11; Linux x86_64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/131.0.0.0 Safari/537.36"
  );
}

async function otvorBrowser() {
  const {
    chromium: playwright
  } = require("playwright-core");

  if (os.platform() === "win32") {
    const chromePath = najdiChromeWindows();

    if (!chromePath) {
      throw new Error(
        "Nenašiel som Google Chrome ani Microsoft Edge. " +
        "Nainštaluj Chrome alebo Edge, prípadne nastav CHROME_PATH."
      );
    }

    logApi(
      `Lokálny Windows browser: ${chromePath}`
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
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }

  if (os.platform() === "linux") {
    const chromium = require(
      "@sparticuz/chromium"
    );

    logApi(
      "Serverové Linux Chromium: @sparticuz/chromium"
    );

    chromium.setGraphicsMode = false;

    const executablePath =
      await chromium.executablePath();

    logApi(
      `Chromium executable: ${executablePath}`
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
        "--disable-blink-features=AutomationControlled"
      ]
    });
  }

  throw new Error(
    `Nepodporovaný operačný systém: ${os.platform()}`
  );
}

function nacitajCsfdStorageState() {
  if (!fs.existsSync(CSFD_STORAGE_PATH)) {
    logApi(
      "ČSFD cookies zatiaľ nie sú uložené."
    );

    return null;
  }

  try {
    const obsah = fs.readFileSync(
      CSFD_STORAGE_PATH,
      "utf8"
    );

    const storageState = JSON.parse(obsah);

    if (
      !storageState ||
      !Array.isArray(storageState.cookies) ||
      !Array.isArray(storageState.origins)
    ) {
      throw new Error(
        "Neplatný formát storageState."
      );
    }

    logSuccess(
      `Načítané uložené ČSFD cookies: ` +
      `${storageState.cookies.length}`
    );

    return storageState;
  } catch (error) {
    logWarn(
      `Uložené ČSFD cookies sa nepodarilo načítať: ` +
      `${error.message}`
    );

    zmazCsfdStorageState();

    return null;
  }
}

function zmazCsfdStorageState() {
  try {
    if (fs.existsSync(CSFD_STORAGE_PATH)) {
      fs.rmSync(CSFD_STORAGE_PATH, {
        force: true
      });

      logApi(
        "Starý ČSFD storage state bol odstránený."
      );
    }
  } catch (error) {
    logWarn(
      `Nepodarilo sa odstrániť ČSFD storage state: ` +
      `${error.message}`
    );
  }
}

async function ulozCsfdStorageState(context) {
  try {
    const storageState =
      await context.storageState();

    const adresar = path.dirname(
      CSFD_STORAGE_PATH
    );

    fs.mkdirSync(adresar, {
      recursive: true
    });

    const docasnaCesta =
      `${CSFD_STORAGE_PATH}.tmp-` +
      `${process.pid}-${Date.now()}`;

    fs.writeFileSync(
      docasnaCesta,
      JSON.stringify(storageState, null, 2),
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    try {
      fs.renameSync(
        docasnaCesta,
        CSFD_STORAGE_PATH
      );
    } catch {
      fs.rmSync(CSFD_STORAGE_PATH, {
        force: true
      });

      fs.renameSync(
        docasnaCesta,
        CSFD_STORAGE_PATH
      );
    }

    logSuccess(
      `ČSFD cookies uložené do: ` +
      `${CSFD_STORAGE_PATH}`
    );
  } catch (error) {
    logWarn(
      `Nepodarilo sa uložiť ČSFD cookies: ` +
      `${error.message}`
    );
  }
}

async function vytvorBrowserContext(browser) {
  const ulozenyStav =
    nacitajCsfdStorageState();

  const options = {
    locale: "cs-CZ",
    timezoneId: "Europe/Prague",
    colorScheme: "light",
    userAgent: ziskajUserAgent(),

    viewport: {
      width: 1365,
      height: 768
    },

    extraHTTPHeaders: {
      "Accept-Language":
        "cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7"
    }
  };

  if (ulozenyStav) {
    options.storageState = ulozenyStav;
  }

  try {
    return await browser.newContext(options);
  } catch (error) {
    if (!ulozenyStav) {
      throw error;
    }

    logWarn(
      "Browser odmietol uložené ČSFD cookies. " +
      "Vytváram čistý browser context."
    );

    zmazCsfdStorageState();

    delete options.storageState;

    return browser.newContext(options);
  }
}

function jeChallenge(title, text) {
  const titleLower = String(
    title || ""
  ).toLowerCase();

  const textLower = String(
    text || ""
  ).toLowerCase();

  return (
    titleLower.includes("nejste robot") ||
    textLower.includes("within.website") ||
    textLower.includes("anubis") ||
    textLower.includes("proof-of-work") ||
    textLower.includes(
      "ujišťujeme se, že nejste robot"
    ) ||
    textLower.includes(
      "ujistujeme se, ze nejste robot"
    )
  );
}

function vyberNajlepsiVysledok(
  vysledky,
  rok,
  vlastnyTyp
) {
  let filtrovane = vysledky;

  if (vlastnyTyp === "series") {
    const serialy = vysledky.filter(
      vysledok => vysledok.jeSerial
    );

    if (serialy.length > 0) {
      filtrovane = serialy;
    }
  }

  if (vlastnyTyp === "movie") {
    const filmy = vysledky.filter(
      vysledok => !vysledok.jeSerial
    );

    if (filmy.length > 0) {
      filtrovane = filmy;
    }
  }

  const hladanyRok = Number(rok);

  const podlaRoku = filtrovane.find(
    vysledok => {
      return vysledok.roky.some(
        zaznamRok => {
          return (
            zaznamRok === hladanyRok ||
            zaznamRok === hladanyRok - 1 ||
            zaznamRok === hladanyRok + 1
          );
        }
      );
    }
  );

  return (
    podlaRoku ||
    filtrovane[0] ||
    null
  );
}

async function ziskatTextStranky(page) {
  try {
    return await page
      .locator("body")
      .innerText({
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

async function pockajNaVysledky(
  page,
  context,
  timeoutMs = 30000
) {
  const zaciatok = Date.now();
  let reloadPouzity = false;

  while (
    Date.now() - zaciatok < timeoutMs
  ) {
    let title = "";
    let pocetVysledkov = 0;
    let textStranky = "";
    let cookies = [];

    try {
      title = await page.title();

      pocetVysledkov =
        await ziskatPocetVysledkov(page);

      textStranky =
        await ziskatTextStranky(page);

      cookies = await context.cookies();
    } catch (error) {
      const sprava = String(
        error.message || ""
      );

      if (
        sprava.includes(
          "page is navigating"
        ) ||
        sprava.includes("Target page") ||
        sprava.includes(
          "Execution context was destroyed"
        )
      ) {
        await page.waitForTimeout(500);
        continue;
      }

      throw error;
    }

    if (pocetVysledkov > 0) {
      return {
        uspesne: true,
        title,
        pocetVysledkov,
        cookies
      };
    }

    const challenge = jeChallenge(
      title,
      textStranky
    );

    const authCookie = cookies.find(
      cookie => {
        const nazov =
          cookie.name.toLowerCase();

        return (
          nazov.includes("anubis") ||
          nazov.includes("challenge")
        );
      }
    );

    if (
      authCookie &&
      challenge &&
      !reloadPouzity
    ) {
      reloadPouzity = true;

      logApi(
        "Overovacia cookie nájdená. " +
        "Robím jedno riadené obnovenie stránky."
      );

      try {
        await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
      } catch (error) {
        const sprava = String(
          error.message || ""
        );

        if (
          sprava.includes("Timeout")
        ) {
          logWarn(
            "ČSFD reload trval príliš dlho. " +
            "Pokračujem v kontrole stránky."
          );
        } else if (
          !sprava.includes(
            "page is navigating"
          ) &&
          !sprava.includes("Target page")
        ) {
          throw error;
        }
      }

      await page.waitForTimeout(1500);
      continue;
    }

    const sekundy = Math.round(
      (Date.now() - zaciatok) / 1000
    );

    logApi(
      `Čakám na ČSFD challenge... ` +
      `${sekundy}s, ` +
      `výsledkov: ${pocetVysledkov}, ` +
      `cookie: ${Boolean(authCookie)}`
    );

    await page.waitForTimeout(1000);
  }

  return {
    uspesne: false,

    title: await page
      .title()
      .catch(() => ""),

    pocetVysledkov:
      await ziskatPocetVysledkov(page),

    cookies: await context
      .cookies()
      .catch(() => [])
  };
}

async function ziskatVysledky(page) {
  try {
    return await page
      .locator("a.film-title-name")
      .evaluateAll(elements => {
        return elements.map(element => {
          const article =
            element.closest("article") ||
            element.closest(
              ".article-header"
            ) ||
            element.parentElement
              ?.parentElement;

          const text =
            article?.textContent
              ?.trim() || "";

          const textLower =
            text.toLowerCase();

          const roky = Array.from(
            text.matchAll(
              /\b(19|20)\d{2}\b/g
            )
          ).map(
            match => Number(match[0])
          );

          return {
            title:
              element.textContent
                ?.trim() || "",

            url: element.href,

            roky,

            jeSerial:
              textLower.includes(
                "seriál"
              ) ||
              textLower.includes(
                "serial"
              ) ||
              textLower.includes(
                "série"
              ) ||
              textLower.includes(
                "series"
              )
          };
        });
      });
  } catch (error) {
    logError(
      "Nepodarilo sa prečítať výsledky z ČSFD",
      error
    );

    return [];
  }
}

async function ziskatCsfdUrl(
  imdbId,
  nazov,
  rok,
  vlastnyTyp
) {
  return withCache(
    `csfd_url_v5:${imdbId}`,
    86400000,

    async () => {
      logApi(
        `Hľadám ČSFD URL cez browser pre IMDB: ` +
        `${imdbId} ` +
        `(Názov: ${nazov}, ` +
        `Rok: ${rok}, ` +
        `Typ: ${vlastnyTyp})`
      );

      if (
        !nazov ||
        !String(nazov).trim()
      ) {
        logWarn(
          "Chýba názov filmu alebo seriálu."
        );

        return null;
      }

      let browser = null;
      let context = null;

      try {
        browser = await otvorBrowser();

        context =
          await vytvorBrowserContext(
            browser
          );

        const page =
          await context.newPage();

        page.on(
          "console",
          message => {
            if (
              message.type() === "error"
            ) {
              const text =
                message.text();

              if (
                !text.includes(
                  "custom.css"
                )
              ) {
                console.error(
                  "ČSFD browser console:",
                  text
                );
              }
            }
          }
        );

        page.on(
          "pageerror",
          error => {
            console.error(
              "ČSFD page error:",
              error.message
            );
          }
        );

        const query =
          encodeURIComponent(
            String(nazov).trim()
          );

        const searchUrl =
          `${CSFD_BASE_URL}/hledat/` +
          `?q=${query}`;

        logApi(
          `Otváram ČSFD: ${searchUrl}`
        );

        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        const stav =
          await pockajNaVysledky(
            page,
            context,
            30000
          );

        if (!stav.uspesne) {
          logWarn(
            "ČSFD challenge sa do 30 sekúnd " +
            "nevyriešila alebo sa nenašli výsledky."
          );

          console.log(
            "ČSFD diagnostika:",
            {
              title: stav.title,
              url: page.url(),
              resultCount:
                stav.pocetVysledkov,

              cookieNames:
                stav.cookies.map(
                  cookie => cookie.name
                )
            }
          );

          return null;
        }

        await ulozCsfdStorageState(
          context
        );

        logSuccess(
          `ČSFD stránka úspešne načítaná. ` +
          `Nájdených výsledkov: ` +
          `${stav.pocetVysledkov}`
        );

        const vysledky =
          await ziskatVysledky(page);

        if (
          !vysledky ||
          vysledky.length === 0
        ) {
          logWarn(
            `ČSFD nenašlo výsledky pre: ` +
            `${nazov}`
          );

          return null;
        }

        const najdeny =
          vyberNajlepsiVysledok(
            vysledky,
            rok,
            vlastnyTyp
          );

        if (
          !najdeny ||
          !najdeny.url
        ) {
          logWarn(
            `Nepodarilo sa vybrať výsledok pre: ` +
            `${nazov}`
          );

          return null;
        }

        const finalnaUrl =
          normalizujUrl(
            najdeny.url
          );

        logSuccess(
          `Úspešne nájdené ČSFD URL: ` +
          `${finalnaUrl}`
        );

        return finalnaUrl;
      } catch (error) {
        logError(
          `Chyba pri browserovom získavaní ` +
          `ČSFD URL pre ${nazov}`,
          error
        );

        console.error(
          "ČSFD browser detail:",
          {
            message: error.message,
            code: error.code || null,
            stack: error.stack
          }
        );

        return null;
      } finally {
        if (context) {
          try {
            await context.close();
          } catch (error) {
            console.error(
              "Chyba pri zatváraní " +
              "browser contextu:",
              error.message
            );
          }
        }

        if (browser) {
          try {
            await browser.close();
          } catch (error) {
            console.error(
              "Chyba pri zatváraní browsera:",
              error.message
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