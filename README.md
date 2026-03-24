# 🎬 SKTorrent Stremio Addon

Neoficiálny Stremio doplnok pre vyhľadávanie a streamovanie filmov a seriálov z populárneho slovenského trackera **SKTorrent.eu**. Addon funguje na princípe vlastnej konfigurácie – každý používateľ si zadáva svoje vlastné prihlasovacie údaje (cookies) z SKTorrentu.

## 🚀 Inštalácia (Dostupné inštancie)

Addon si môžeš nainštalovať a nakonfigurovať na jednej z týchto verejne bežiacich inštancií:

🔗 **[Genez.io Inštancia](https://bda31382-bef9-4743-b2e2-e9838ecb6690.eu-central-1.cloud.genez.io/)**  
🔗 **[Koyeb Inštancia](https://managerial-karol-zasaonsk-d57eb595.koyeb.app/)**  

*Vyber si ktorúkoľvek, obe obsahujú rovnakú verziu addonu.*

---

## ⭐ Hlavné funkcie a vlastnosti

*   ⚡ **Podpora TorBox (Debrid/Cache)**: Ak vložíš svoj TorBox API kľúč, addon automaticky overí, či je torrent už stiahnutý na serveroch TorBoxu. Ak áno, streamuje sa okamžite priamo z ich serverov (označené ako `[TB ⚡]`).
*   🔍 **Smart vyhľadávanie cez ČSFD**: Addon obsahuje vlastný scraper, ktorý dokáže nájsť presný film alebo seriál na základe ČSFD ID. Prehľadáva až 20 stránok výsledkov pre zaručené nájdenie aj starších epizód.
*   🧠 **Pokročilý Regex pre SK/CZ seriály**: Rozpoznáva obrovské množstvo našských formátov seriálov (napr. `S01E01`, `1x01`, `1. - 4. serie`, `1. Epizoda`, `105.Epizóda`, `Pack`, `Komplet`). Automaticky extrahuje správny video súbor aj z veľkých gigabajtových packov.
*   🎥 **Detailné informácie o streame**: Priamo v Stremio vidíš krásne naformátované dáta:
    *   **Kvalita & Formát:** 4K, 1080p, HDR, Dolby Vision, HEVC, H.264, Atmos...
    *   **Jazyk (Vlajky):** 🇸🇰 🇨🇿 🇬🇧 🇺🇸 na základe analýzy názvu.
    *   **Veľkosť:** Skutočná veľkosť daného video súboru + veľkosť celého torrentu.
*   🌐 **TMDB a Cinemeta integrácia**: Hľadá podľa pôvodného aj preloženého (českého/slovenského) názvu pre maximálnu presnosť výsledkov.

---

## ⚙️ Ako získať údaje pre konfiguráciu (UID a PASS)

Aby addon fungoval, potrebuješ mať účet na SKTorrent.eu. Addon pre svoju funkčnosť vyžaduje hodnoty z tvojich **Cookies** (`uid` a `pass`).

**Postup pre Chrome/Edge/Firefox:**
1. Otvor si stránku [sktorrent.eu](https://sktorrent.eu) a prihlás sa.
2. Stlač klávesu `F12` (otvoria sa Vývojárske nástroje / Developer Tools).
3. Choď do záložky **Application** (Aplikácia) -> vľavo v menu rozbaľ **Cookies** a klikni na `https://sktorrent.eu`.
4. V tabuľke nájdi riadok s názvom `uid` a skopíruj si jeho hodnotu (napr. `123456`).
5. Nájdi riadok s názvom `pass` a skopíruj si jeho hodnotu (dlhý alfanumerický reťazec).
6. Tieto dva údaje vlož do konfiguračného okna na jednej z webových inštancií vyššie a vygeneruj si inštalačný odkaz.

*(Voliteľné: Pre najlepší zážitok odporúčame pridať aj TorBox API kľúč a TMDB API kľúč).*

---

## 👨‍💻 Pre vývojárov (Lokálne spustenie)

Ak si chceš addon spustiť lokálne alebo upravovať kód:

```bash
# Naklonovanie repozitára
git clone https://github.com/TvojGithub/TvojRepozitar.git
cd TvojRepozitar

# Inštalácia závislostí
npm install

# Spustenie servera
npm start

Server štandardne pobeží na porte 7000. Konfiguračnú stránku nájdeš na http://localhost:7000/.
```
⚠️ Upozornenie: Tento addon slúži len na technické, vzdelávacie a vyhľadávacie účely. Addon neobsahuje žiadne mediálne súbory, len spracováva a formátuje metadáta dostupné na internete na základe požiadavky používateľa.

