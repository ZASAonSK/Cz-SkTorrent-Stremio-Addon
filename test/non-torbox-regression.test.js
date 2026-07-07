const assert = require("assert");
const fs = require("fs");
const path = require("path");

const sourcePath = path.join(__dirname, "..", "sktorrent-addon.js");
const source = fs.readFileSync(sourcePath, "utf8");

const streamResponseCount = (source.match(/return res\.json\(\{ streams: streamy \}\);/g) || []).length;
assert(
    streamResponseCount >= 2,
    "stream route must return streams for both TorBox and non-TorBox configurations"
);

assert(
    source.includes("sources: torrentData.trackers"),
    "torrent stream objects should include tracker sources extracted from the .torrent file"
);

assert(
    source.includes('`tracker:${tracker}`'),
    "tracker sources should use Stremio's tracker:<url> source format"
);

assert(
    source.includes("process.env.ADDON_ID") && source.includes("process.env.ADDON_NAME"),
    "manifest addon id and name should be configurable for local Stremio testing"
);

assert(
    source.includes("id: ADDON_ID") && source.includes("name: ADDON_NAME"),
    "manifest should use configurable addon identity values"
);

console.log("non-TorBox regression checks passed");
