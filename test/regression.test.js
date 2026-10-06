const test = require("node:test");
const assert = require("node:assert/strict");

const { decodeConfig, encodeConfig } = require("../lib/common");
const { movieFileMatches, movieTorrentMatches } = require("../lib/movie-matcher");
const { torrentSediSEpizodou, torrentSedisSeriou } = require("../lib/episode-matcher");

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

test("episode matcher supports normal episodes, packs, and rejects a wrong episode", () => {
    assert.equal(torrentSedisSeriou("Show.S01E02.1080p", 1), true);
    assert.equal(torrentSedisSeriou("Show.S02E02.1080p", 1), false);
    assert.equal(torrentSediSEpizodou("Show.S01E02.1080p", 1, 2), true);
    assert.equal(torrentSediSEpizodou("Show.S01E03.1080p", 1, 2), false);
    assert.equal(torrentSediSEpizodou("Show.S01-S03.Pack", 2, 8), true);
});
