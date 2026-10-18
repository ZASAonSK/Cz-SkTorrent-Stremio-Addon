# 🎬 SKTorrent Stremio & Nuvio Addon

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-purple.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Stremio%20%7C%20Nuvio-blue.svg)](#inštalácia)

Neoficiálny doplnok pre **Stremio** a **Nuvio** na vyhľadávanie a streamovanie filmov a seriálov z trackera **SKTorrent.eu**.

Funguje na princípe klientskej konfigurácie – každý používateľ zadáva vlastné prihlasovacie údaje a API kľúče, ktoré sa bezpečne zašifrujú priamo do inštalačného odkazu pomocou **AES-256-GCM**.

---

## 🚀 Inštalácia

### 1. Verejná inštancia
Konfiguráciu a inštalačný odkaz si vygeneruješ na:  
🔗 **[Koyeb Inštancia](https://managerial-karol-zasaonsk-d57eb595.koyeb.app/)**

### 2. Ako pridať addon do aplikácie

Po kliknutí na **Inštalovať** sa zobrazí dialóg s voľbou aplikácie:

- **Stremio:**
  - Na zabezpečenom hostingu (`https://`) sa addon otvorí a nainštaluje priamo na jedno kliknutie.
  - Pri lokálnom serveri (`http://localhost`) klikni na **Stremio**, odkaz sa automaticky skopíruje do schránky. V aplikácii Stremio prejdi do sekcie **Addons → + Add addon** a vlož skopírovanú URL.
- **Nuvio:**
  - Klikni na **Nuvio**, čím sa manifest URL skopíruje do schránky.
  - V aplikácii Nuvio prejdi do **Settings → Content & Discovery → Addons → Install from URL** a vlož odkaz (prípadne cez webové rozhranie **nuvio.tv** v profile: *Addons → Add Addon*).

---

## ⭐ Hlavné vlastnosti

* **3 podporované režimy:**
  * **P2P (WebTorrent):** Priame sťahovanie/streamovanie cez P2P sieť vrátane automatického načítania trackerov z `.torrent` súborov.
  * **TorBox:** Okamžité streamovanie z TorBox cache alebo automatické zaradenie do sťahovania na servery TorBoxu.
  * **Real-Debrid:** Streamovanie z Real-Debrid cache, riešenie duplikátov a podpora automatického unrestrictovania.

* **Prehľadné stavové značky pri streamoch:**
  * `[TB ⚡]` / `[RD ⚡]` – **Cachované:** Súbor je okamžite pripravený na prehrávanie.
  * `[TB ⏳]` / `[RD ⏳]` – **Necachované:** Kliknutím sa torrent automaticky nahrá na debrid servery a prehrá sa informatívne video *Sťahovanie začalo*.
  * `[RD ❌]` – **Blokované:** Názov obsahuje zakázané reťazce (BDRip, WEB-DL, RARBG...), ktoré Real-Debrid odmieta. Tieto streamy sa radia na koniec.
  * `[P2P]` – Klasický peer-to-peer torrent stream.

* **Inteligentné vyhľadávanie a viacúrovňové metadáta:**
  * **ČSFD scraper & Wikidata:** Vyhľadáva presné české/slovenské názvy filmov a seriálov na základe ČSFD profilov (až 20 stránok výsledkov pre staršie epizódy).
  * **TMDB, TVDB & Cinemeta:** Automatický preklad názvov do slovenčiny, češtiny aj angličtiny.
  * **IMDb Suggestion Fallback:** Záložné dohľadanie názvov pri nových či atypických tituloch.

* **Podpora ID formátov z rôznych addonových katalógov:**
  * `tt1234567` (IMDb filmy aj seriály)
  * `tmdb:12345` (AioMetadata formát)
  * `tvdb:12345`, `tvdb-12345` a `tvdb:12345:official:S:E` (oficiálny TVDB formát)

* **Pokročilý regex parser pre SK/CZ seriály:**
  * Bezchybne triedi formáty ako `S01E01`, `1x01`, `1. - 4. serie`, `1. Epizoda`, `105.Epizóda`, `Komplet`, `Pack`.
  * Zo seriálových balíčkov automaticky vyberie presný video súbor zodpovedajúci zvolenej epizóde.

* **Detailné informácie v popise streamu:**
  * **Formát & Audio:** 4K, 1080p, HDR, Dolby Vision, HEVC, H.264, Atmos...
  * **Jazyk:** Vlajky 🇸🇰 🇨🇿 🇬🇧 🇺🇸 na základe lingvistickej analýzy názvu.
  * **Veľkosť & Súbor:** Zobrazenie skutočnej veľkosti video súboru, celkovej veľkosti torrentu, počtu seedov aj konkrétneho prehrávaného súboru (`📄 Súbor: ...`).

* **Filtre a používateľské radenie:**
  * Možnosť obmedziť rozlíšenie (4K / 1080p / 720p / SD), max. veľkosť súboru, min. počet seedov či max. počet streamov na rozlíšenie.
  * **18+ filter:** Automatické vyradenie kategórií xXx, žánru Erotický a adult výrazov.
  * **Pre-cache ďalšej epizódy:** Pri reálnom spustení epizódy sa na pozadí automaticky odošle požiadavka na prípravu nasledujúceho dielu do debridu.
  * **Vlastné poradie triedenia:** Nastaviteľná priorita podľa cache stavu, kvality, jazyka, seedov a veľkosti.

---

## ⚙️ Potrebné údaje pre konfiguráciu

### 1. SKTorrent UID a PASS *(Dôrazne odporúčané)*
Pre plnú funkčnosť potrebuješ mať účet na [sktorrent.eu](https://sktorrent.eu).

1. Otvor [sktorrent.eu](https://sktorrent.eu) a prihlás sa.
2. Stlač kláves `F12` (Vývojárske nástroje / Developer Tools).
3. Prejdi na záložku **Application** (alebo **Storage** / **Úložisko**) → vľavo rozbaľ **Cookies** → klikni na `https://sktorrent.eu`.
4. Skopíruj hodnotu riadku `uid` (napr. `123456`) a `pass` (dlhý alfanumerický reťazec).
5. Vlož ich do konfigurátora (alebo použi tlačidlo *Prihlásiť sa* na stránke addonu).

> 💡 **Prečo vyplniť login aj pri TorBoxe / Real-Debride?**  
> Bez prihlásenia addon nedokáže stiahnuť `.torrent` súbor. V takom prípade nepozná vnútornú štruktúru packu, zobrazí náhradnú veľkosť `1 MB` a chýba riadok `📄 Súbor`. Prihlásenie zabezpečuje presnú identifikáciu súborov a spoľahlivejšie nahrávanie do debridu.

### 2. Voliteľné kľúče debrid a metadátových služieb
| Služba | Kde získať kľúč |
|---|---|
| **TorBox** | [torbox.app/settings](https://torbox.app/settings?section=account) → Account → API Key |
| **Real-Debrid** | [real-debrid.com/devices](https://real-debrid.com/devices) → API Token |
| **TMDB** | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) → API Key |
| **TVDB** | [thetvdb.com/dashboard/account/apikey](https://thetvdb.com/dashboard/account/apikey) → Project API Key |

---

## 👨‍💻 Lokálne spustenie (Pre vývojárov)

### Rýchly štart
```bash
# 1. Naklonovanie repozitára
git clone [https://github.com/ZASAonSK/Cz-SkTorrent-Stremio-Addon.git](https://github.com/ZASAonSK/Cz-SkTorrent-Stremio-Addon.git)
cd Cz-SkTorrent-Stremio-Addon

# 2. Inštalácia závislostí
npm install

# 3. Spustenie servera
npm start
```

Pri prvom lokálnom spustení v termináli sa **automaticky vygeneruje súbor `.env`** s bezpečným náhodným `ENCRYPTION_KEY`. Server štandardne pobeží na porte `7000` a konfigurátor nájdeš na adrese `http://localhost:7000/`.

### Konfigurácia prostredia (`.env`)

Ak potrebuješ upraviť nastavenia, vytvor alebo uprav súbor `.env`:

```env
# Jediná povinná premenná (na produkčnom hostingu zadaj natrvalo):
ENCRYPTION_KEY=dopln-sem-dlhy-nahodny-retazec-pre-aes256

# Voliteľné premenné:
PORT=7000
PUBLIC_URL=http://localhost:7000
# KOFI_URL=[https://ko-fi.com/tvoje-meno](https://ko-fi.com/tvoje-meno)
# QUIET_LOGS=1
# CSFD_MAX_PAGES=20
# ALLOW_PLAINTEXT_CONFIG=1
```

| Premenná | Význam |
|---|---|
| `ENCRYPTION_KEY` | Kľúč pre AES-256-GCM šifrovanie konfigurácií v URL. Na hostingu ho nastav v env premenných, inak redeploy zneplatní vygenerované odkazy. |
| `PUBLIC_URL` | Verejná adresa servera. Zisťuje sa automaticky z requestu, no pri reverznom proxy / tuneli ju nastav manuálne. |
| `PORT` | Port, na ktorom počúva HTTP server (predvolene `7000`). |
| `KOFI_URL` | Ak je nastavené, v záhlaví konfigurátora sa zobrazí ikona podpory cez Ko-fi. |
| `QUIET_LOGS` | Nastavením na `1` vypneš bežné informačné logy kvôli maximálnemu súkromiu. |
| `CSFD_MAX_PAGES` | Maximálny počet prehľadávaných stránok pri ČSFD vyhľadávaní (predvolene `20`). |
| `ALLOW_PLAINTEXT_CONFIG` | Núdzové povolenie nešifrovaných Base64 odkazov v prípade absencie šifrovacieho kľúča. |

---

## 📁 Štruktúra projektu

```text
├── sktorrent-addon.js      # Hlavný Express server (routing, stream handler, play proxy, UI)
├── lib/
│   ├── common.js           # Pomocné funkcie, šifrovanie configu, zdieľané HTTP agenty, cache
│   ├── env-setup.js        # Automatický generátor .env súboru pri lokálnom štarte
│   ├── sktorrent.js        # Parser a scraper vyhľadávania a sťahovania z SKTorrent.eu
│   ├── metadata.js         # Zlučovanie metadát (Cinemeta, TMDB, TVDB, IMDb)
│   ├── csfd.js             # ČSFD vyhľadávací modul s podporou Playwright / Redis cache
│   ├── stream-builder.js   # Analýza názvov, párovanie video súborov a zostavenie stream objektov
│   ├── movie-matcher.js    # Filtrovanie filmov podľa dielov a rokov
│   ├── episode-matcher.js  # Regex parser sérií, epizód a balíčkov
│   ├── torbox.js           # TorBox API klient, kontrola cache a správa úložiska
│   ├── realdebrid.js       # Real-Debrid API klient, lokálna rd_cache.json a blacklisting
│   ├── tvdb.js             # TVDB autentifikácia a jazykové preklady
│   ├── precache.js         # Mechanizmus pre-cacheovania nasledujúcich epizód
│   └── security.js         # Rate limiting, maskovanie tokenov v logoch a async wrappery
├── logo.png                # Ikona addonu pre Stremio / Nuvio a favicon
├── stahuje-sa.mp4          # Krátke video upozornenie pri začatí sťahovania do debridu
└── tools/
    └── smoke-test.js       # Rýchly integračný test so stubmi (spustenie cez node tools/smoke-test.js)
```

---

## 🛠️ Riešenie častých problémov

* **Stremio hlási `Failed to get addon manifest / Failed to fetch`:**  
  Protokol `stremio://` vyžaduje HTTPS. Pri lokálnom behu na HTTP adrese (`http://localhost:7000`) skopíruj manifest odkaz manuálne a vlož ho v aplikácii Stremio do poľa vyhľadávania / pridania addonov.
* **Stream ukazuje veľkosť `1 MB` a chýba riadok `📄 Súbor`:**  
  V konfigurácii nie je vyplnený SKTorrent login (`uid` a `pass`). Bez neho addon nemôže stiahnuť `.torrent` dáta a nepozná presnú veľkosť vnútorného videa.
* **V logoch sa zobrazuje chyba `ENOENT: no such file or directory, stat ... stahuje-sa.mp4`:**  
  Uisti sa, že videosúbor `stahuje-sa.mp4` je umiestnený priamo v koreňovom adresári vedľa `sktorrent-addon.js`.
* **Nuvio po otvorení konfigurácie nenačíta existujúce kľúče:**  
  Skontroluj, či otváraš adresu obsahujúcu token (napr. `/<config>/configure`). Server podporuje aj query parametre `?config=` a `?manifest=`.

---

## 📄 Licencia

Tento projekt je licencovaný pod **GNU Affero General Public License v3.0** (AGPL-3.0) – podrobnosti nájdeš v súbore [LICENSE](LICENSE).

Časť funkcionality (Real-Debrid podpora, TVDB integrácia, pre-cache architektúra a filtre) vychádza z projektu [Judzim/Cz-SkTorrent-Stremio-Addon](https://github.com/Judzim/Cz-SkTorrent-Stremio-Addon) (licencovaného pod AGPL-3.0).

---

⚠️ **Upozornenie:** Tento doplnok slúži výhradne na vzdelávacie a vyhľadávacie účely. Addon sám o sebe nehostuje ani nešíri žiadne mediálne súbory – iba spracováva a formátuje verejne dostupné metadáta na základe požiadavky používateľa.