const test = require("node:test");
const assert = require("node:assert/strict");

const { decodeConfig, encodeConfig, jeCelyTitulokVNazve } = require("../lib/common");
const { movieFileMatches, movieTorrentMatches } = require("../lib/movie-matcher");
const { torrentSediSEpizodou, torrentSedisSeriou } = require("../lib/episode-matcher");
const { vyberSuborPreEpizodu, jeFilmovySpecial } = require("../lib/stream-builder");

const subor = (index, path) => ({ index, path });

test("configuration keeps the existing URL-safe Base64 format", () => {
    const config = { uid: "123", pass: "secret", tmdb: "tmdb-key", qualityOrder: [4, 3, 2, 1] };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64url");
    assert.deepEqual(decodeConfig(encoded), config);
    assert.equal(decodeConfig("manifest.json"), null);
});

test("new links encrypt and still decode, legacy links keep working", () => {
    process.env.ENCRYPTION_KEY = "unit-test-encryption-key";
    const config = { uid: "123", pass: "secret", torbox: "tb", qualityOrder: [4, 3, 2, 1, 0] };
    const token = encodeConfig(config);
    assert.match(token, /^e1\./);
    assert.deepEqual(decodeConfig(token), config);
    const legacy = Buffer.from(JSON.stringify(config)).toString("base64url");
    assert.deepEqual(decodeConfig(legacy), config);
    assert.notEqual(token, legacy);
});

test("movie matcher distinguishes sequels, packs, and years", () => {
    const meta = { titleOriginal: "Avatar 2", titleCz: "Avatar 2", yearStart: 2022 };
    assert.equal(movieTorrentMatches("Avatar.2.2022.1080p", meta), true);
    assert.equal(movieTorrentMatches("Avatar.2.2021.1080p", meta), true);
    assert.equal(movieTorrentMatches("Avatar.1.2009.1080p", meta), false);
    assert.equal(movieTorrentMatches("Avatar.1-3.Kolekce", meta), true);
    assert.equal(movieFileMatches("Avatar.2.2022.mkv", meta), true);
    assert.equal(movieFileMatches("Avatar.2.2021.mkv", meta), true);
});

test("movie matcher treats a middle dot and hyphen as equivalent title separators", () => {
    const meta = { titleOriginal: "WALL·E", titleCz: "VALL-I", yearStart: 2008 };
    assert.equal(movieTorrentMatches("VALL-I / WALL-E (2008)(CZ/SK/EN)[1080p]", meta), true);
    assert.equal(movieFileMatches("WALL-E.2008.1080p.mkv", meta), true);
});

test("title filter rejects a longer title that only starts with the requested one", () => {
    assert.equal(jeCelyTitulokVNazve("Lucky Louie S01E01 - Pilot 1080p WEBRip CZ EN", "Lucky"), false);
    assert.equal(jeCelyTitulokVNazve("Lucky S01E01 (2026)[1080p][WEB-DL] = CSFD 80%", "Lucky"), true);
    assert.equal(jeCelyTitulokVNazve("Lucky_S01E01_Zadne zkratky", "Lucky"), true);
    assert.equal(jeCelyTitulokVNazve("Lucky.S01E01.1080p.WEB-DL.HEVC", "Lucky"), true);
    assert.equal(jeCelyTitulokVNazve("Lucky 2026 CZ Dabing 1080p", "Lucky"), true);
    assert.equal(jeCelyTitulokVNazve("Lucky / Stastny (2026)", "Lucky"), true);
    assert.equal(jeCelyTitulokVNazve("Lucky - Pilot S01E01", "Lucky"), true);
    assert.equal(jeCelyTitulokVNazve("Lucky Charm 2026 1080p", "Lucky"), false);
    assert.equal(jeCelyTitulokVNazve("Lucky", "Lucky"), true);
    // celý viacslovný titul musí stále sedieť
    assert.equal(jeCelyTitulokVNazve("Lucky Louie S01E01 1080p", "Lucky Louie"), true);
    // dvojbodka + cudzie slovo = iný titul (spin-off), nie alternatívny názov
    assert.equal(jeCelyTitulokVNazve("Pokémon: Horizonty (E01-E45)(EN/CZ)[WEB-DL/1080p]", "Pokémon"), false);
    assert.equal(jeCelyTitulokVNazve("Pokemon: Horizonty S01E36 1080p", "Pokemon"), false);
    assert.equal(jeCelyTitulokVNazve("Pokemon: The First Movie (1998)", "Pokemon"), false);
    // za dvojbodkou ale môže byť release tag alebo číslo epizódy
    assert.equal(jeCelyTitulokVNazve("Show: CZ Dabing 1080p", "Show"), true);
    assert.equal(jeCelyTitulokVNazve("Show: S01E01", "Show"), true);
    assert.equal(jeCelyTitulokVNazve("Show: 1. séria", "Show"), true);
    // keď je dvojbodka súčasťou požadovaného titulu, musí sedieť celá
    assert.equal(jeCelyTitulokVNazve("Pokémon: Horizonty S01E36", "Pokémon: Horizonty"), true);
});

test("episode matcher supports normal episodes, packs, and rejects a wrong episode", () => {
    assert.equal(torrentSedisSeriou("Show.S01E02.1080p", 1), true);
    assert.equal(torrentSedisSeriou("Show.S02E02.1080p", 1), false);
    assert.equal(torrentSediSEpizodou("Show.S01E02.1080p", 1, 2), true);
    assert.equal(torrentSediSEpizodou("Show.S01E03.1080p", 1, 2), false);
    assert.equal(torrentSediSEpizodou("Show.S01-S03.Pack", 2, 8), true);
    assert.equal(torrentSedisSeriou("VisionQuest 1 série (2026)", 1), true);
    assert.equal(torrentSediSEpizodou("VisionQuest 1 série (2026)", 1, 8), true);
    assert.equal(torrentSedisSeriou("VisionQuest 1 série (2026)", 2), false);
    // slovenský zápis "séria" musí fungovať rovnako ako český "série"
    assert.equal(torrentSedisSeriou("South Park 6. séria 1080p", 6), true);
    assert.equal(torrentSediSEpizodou("South Park 6. séria 1080p", 6, 3), true);
    assert.equal(torrentSedisSeriou("South Park 6. séria 1080p", 2), false);
    // nulou doplnené číslo sezóny ("06. séria") musí sedieť na sezónu 6
    assert.equal(torrentSedisSeriou("South Park 06. série 1080p", 6), true);
    assert.equal(torrentSediSEpizodou("South Park 06. série 1080p", 6, 3), true);
    assert.equal(torrentSediSEpizodou("South Park 06. série 1080p", 1, 3), false);
});

test("episode matcher rejects movie specials with 'Part' in the name", () => {
    // Filmový špeciál sa nesmie zobraziť ako epizóda seriálu.
    assert.equal(torrentSediSEpizodou("South Park: The Streaming Wars, Part 2 (2022)[WebRip][1080p]", 6, 3), false);
    assert.equal(torrentSediSEpizodou("South Park: The Streaming Wars Part 1 + Part 2 (2022)[WebRip][1080p]", 6, 3), false);
    // to isté so slovenským označením časti
    assert.equal(torrentSediSEpizodou("South Park: The Streaming Wars Časť 2 (2022)[WebRip][1080p]", 6, 3), false);
    // Legitímna epizóda s "Part" v názve stále prejde vďaka SxxExx.
    assert.equal(torrentSediSEpizodou("Show S01E01 Part 1 1080p", 1, 1), true);
    assert.equal(torrentSediSEpizodou("Show S01E01 Časť 1 1080p", 1, 1), true);
});

test("single-file movie specials are rejected for a series episode", () => {
    const film = "South.Park.The.Streaming.Wars.Part.2.2022.1080p.AMZN.WEB-DL.DDP5.1.H264-CMRG.mkv";
    const torrent = "Stiahni si Filmy s titulkama South Park: The Streaming Wars, Part 2 (2022)[WebRip][1080p] = CSFD 76%";
    assert.equal(jeFilmovySpecial(film, torrent, 6, 3), true);

    // rok len v názve torrentu (súbor bez roku) tiež nestačí na epizódu
    assert.equal(jeFilmovySpecial("South.Park.Post.COVID.mkv", "South Park: Post COVID (2021)", 6, 3), true);

    // legitímna epizóda z balíka série sa nezamietne
    assert.equal(jeFilmovySpecial("03. Stávka postižených.mkv", "South Park 06. série (2022) 1080p", 6, 3), false);
    assert.equal(jeFilmovySpecial("South.Park.S06E03.2022.1080p.mkv", "South Park (2022) 1080p", 6, 3), false);

    // súbor s rokom bez kontextu série, ale torrent je jednoznačne epizóda
    assert.equal(jeFilmovySpecial("Show.2022.03.mkv", "Show S06E03 1080p", 6, 3), false);
});

test("file picker prefers the requested season folder for season-pack torrents", () => {
    const sezona6 = [
        subor(1, "Sezona 6/01. Jaredovy potíže.mkv"),
        subor(2, "Sezona 6/02. Vikend v Aspenu.mkv"),
        subor(3, "Sezona 6/03. Stávka postižených.mkv")
    ];
    const sezona2 = [subor(4, "Sezona 2/03. Sopka.mkv")];
    const zmesi = [...sezona6, ...sezona2];

    // S06E03 vzorka má prioritu
    assert.deepEqual(vyberSuborPreEpizodu(zmesi.map(s => ({ ...s })), 6, 3), subor(3, "Sezona 6/03. Stávka postižených.mkv"));

    // sezóna-agnózne názvy ("03. X.mkv") v rôznych zložkách → vyberie zložku sezóny 6, nie Sezóna 2 (Sopka)
    assert.deepEqual(
        vyberSuborPreEpizodu([subor(1, "Sezona 2/03. Sopka.mkv"), subor(2, "Sezona 6/03. Stávka postižených.mkv")], 6, 3),
        subor(2, "Sezona 6/03. Stávka postižených.mkv")
    );

    // opačne: pýtame sa sezóny 2 → vyberie Sopku z Sezóny 2
    assert.deepEqual(
        vyberSuborPreEpizodu([subor(1, "Sezona 2/03. Sopka.mkv"), subor(2, "Sezona 6/03. Stávka postižených.mkv")], 2, 3),
        subor(1, "Sezona 2/03. Sopka.mkv")
    );

    // jediné číslo bez zložky sa vyberie podľa čísla
    assert.deepEqual(
        vyberSuborPreEpizodu([subor(1, "03. Stávka postižených.mkv"), subor(2, "04. Nieco ine.mkv")], 6, 3),
        subor(1, "03. Stávka postižených.mkv")
    );

    // SxxExx názov sa vyberie správne
    assert.deepEqual(
        vyberSuborPreEpizodu([subor(1, "Show.S06E01.mkv"), subor(2, "Show.S06E03.mkv")], 6, 3),
        subor(2, "Show.S06E03.mkv")
    );

    // formát "NN. série" z logov: 01. série/03. Sopka.mkv vs 06. série/03. Stávka postižených.mkv
    assert.deepEqual(
        vyberSuborPreEpizodu([
            subor(1, "01. série/03. Sopka.mkv"),
            subor(2, "06. série/03. Stávka postižených.mkv")
        ], 6, 3),
        subor(2, "06. série/03. Stávka postižených.mkv")
    );

    // opačne: séria 1 → Sopka z 01. séria
    assert.deepEqual(
        vyberSuborPreEpizodu([
            subor(1, "01. série/03. Sopka.mkv"),
            subor(2, "06. série/03. Stávka postižených.mkv")
        ], 1, 3),
        subor(1, "01. série/03. Sopka.mkv")
    );
    assert.deepEqual(
        vyberSuborPreEpizodu([
            subor(1, "01. Season/03. Sopka.mp4"),
            subor(2, "06. Season/03. Stávka postižených.mp4")
        ], 6, 3),
        subor(2, "06. Season/03. Stávka postižených.mp4")
    );

    // slovenský zápis zložky "06. séria/"
    assert.deepEqual(
        vyberSuborPreEpizodu([
            subor(1, "01. séria/03. Sopka.mkv"),
            subor(2, "06. séria/03. Stávka postižených.mkv")
        ], 6, 3),
        subor(2, "06. séria/03. Stávka postižených.mkv")
    );

    // žiadna zhoda → null
    assert.equal(vyberSuborPreEpizodu([subor(1, "Show.S01E01.mkv")], 6, 3), null);
});
