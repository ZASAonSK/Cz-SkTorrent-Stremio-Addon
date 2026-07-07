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

console.log("non-TorBox regression checks passed");
