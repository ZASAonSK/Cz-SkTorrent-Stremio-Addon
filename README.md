# SKTorrent + TorBox (Stremio Addon)

Stremio addon, ktorý vyhľadáva CZ/SK torrenty na **sktorrent.eu** a prehráva ich cez TorBox (debrid) – bez P2P streamovania v Stremio.

Addon pri každom streame zobrazí stav TorBox cache:
- `[TB ⚡]` = už je cached v TorBoxe a po kliknutí sa prehráva priamo z TorBoxu (HTTP redirect).
- `[TB ⏳]` = nie je cached; po kliknutí sa torrent odošle do TorBoxu a zobrazí sa info video („sťahuje sa“).

> Poznámka: Toto je komunitný projekt/fork. Používaj len obsah, na ktorý máš práva.

---

## Funkcie
- Vyhľadávanie torrentov na SKTorrent (filmy/seriály) a filtrovanie epizód podľa názvu + súborov v torrente.
- Hromadná kontrola TorBox cache a zoradenie výsledkov tak, aby cached boli navrchu.
- TorBox proxy router:
  - `/play/...` presmeruje prehrávač Stremia na priamy TorBox link.
  - `/download/...` pridá torrent do TorBoxu (spoľahlivé aj pre private torrenty – odosielaním `.torrent` súboru).

---

## Požiadavky
- Node.js 18+ (odporúčané 20+)
- Stremio (Desktop / Android / TV)
- Účet na sktorrent.eu (kvôli cookie `uid` a `pass`)
- TorBox účet + API key (kvôli cache check + stream + download)

---

## Inštalácia (lokálne)
1. Naklonuj repo:
   ```bash
   git clone https://github.com/ZASAonSK/Sktorrent-Stremio-addon.git
   cd Sktorrent-Stremio-addon

    Nainštaluj balíčky:

    bash
    npm install

    Vytvor .env v koreňovom priečinku (vedľa hlavného .js súboru) a doplň hodnoty:

    # SKTorrent cookies (z prehliadača po prihlásení na sktorrent.eu)
    SKT_UID=xxx
    SKT_PASS=xxx

    # TorBox
    TORBOX_API_KEY=xxx

    # Voliteľné (lepšie názvy cez TMDB)
    TMDB_API_KEY=xxx

    # Port/URL (lokálne zvyčajne netreba meniť)
    PORT=7000
    PUBLIC_URL=http://localhost:7000

    Uisti sa, že máš súbor stahuje-sa.mp4 vedľa addonu (server ho posiela pri ⏳ kliknutí).

    Spusti addon:

    bash
    node sktorrent-addon.js

    (ak sa tvoj hlavný súbor volá inak, spusti ten správny)

    V Stremio → Addons → „Add addon“ vlož URL:

    http://localhost:7000/manifest.json

Inštalácia do Stremio

Po nainštalovaní addonu bude Stremio zobrazovať streamy s prefixmi:

    [TB ⚡] → okamžité prehratie z TorBoxu

    [TB ⏳] → pridanie do TorBoxu + info video, potom refresh a časom sa zmení na ⚡

Tip: Po kliknutí na ⏳ počkaj pár minút (podľa veľkosti a seedov), potom znova otvor daný film/epizódu v Stremio.
Deploy (Render / cloud)

Ak to chceš mať 24/7 aj na mobile/TV bez zapnutého PC:

    nastav v hostingu env premenné ako vyššie

    PORT nechaj na platformu (Render ho nastaví sám)

    PUBLIC_URL nastav na verejnú URL služby (napr. https://tvoj-addon.onrender.com)

Potom do Stremio pridáš:

https://tvoj-addon.onrender.com/manifest.json

Troubleshooting

    V Stremio sa nič nedeje po kliknutí na ⏳
    Skontroluj log servera, či TorBox nevracia chybu a či sa volá endpoint /download/.... 

    ⚡ stream načítava donekonečna
    TorBox niekedy potrebuje chvíľu, kým sa torrent objaví v mylist/kým sú dostupné súbory; pomôže refresh v Stremio alebo malé oneskorenie v /play logike. 

    Nenachádza to výsledky zo SKTorrentu
    Skontroluj, či SKT_UID a SKT_PASS sú správne (cookie), a či nie je dočasne zmenená stránka/HTML selektory.

    Niektoré private torrenty sa nestiahnu
    Toto je väčšinou tracker/seed problém (žiadni seedri, ratio pravidlá, IP/UA obmedzenia). Pomôže mať v TorBoxe povolené správne nastavenia pre private trackery (ak to TorBox vyžaduje).

Bezpečnosť

    Nikdy nezdieľaj .env ani logy s API kľúčmi.

    Repo odporúčam používať ako „private“ ak si tam nechávaš čokoľvek citlivé.

License
