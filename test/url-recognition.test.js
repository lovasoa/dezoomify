const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const source = fs.readFileSync("url-recognition.js", "utf8");
const context = {};
vm.runInNewContext(source, context);
const recognize = context.recognizeZoomableUrl;

const cases = [
    ["https://example.com/ImageProperties.xml?t123", "https://example.com/ImageProperties.xml"],
    ["https://example.com/image/info.json", "https://example.com/image/info.json"],
    ["https://example.com/image.dzi?cache=1", "https://example.com/image_files/0/0_0.jpg"],
    ["https://example.com/image_files/12/3_4.jpg?cache=1", "https://example.com/image_files/0/0_0.jpg"],
    ["https://example.com/image_files/12/3_4.jpeg", "https://example.com/image_files/0/0_0.jpg"],
    ["https://example.com/TileGroup2/5-3-4.jpg", "https://example.com/ImageProperties.xml"],
    ["https://example.com/iip?FIF=image.tif&WID=500", "https://example.com/iip?FIF=image.tif"],
    ["https://example.com/image.imgi?cmd=info", "https://example.com/image.imgi?cmd=info"],
    ["https://example.com/image.pff", "https://example.com/image.pff"],
    ["https://example.com/image.ecw", "https://example.com/image.ecw"],
    ["https://example.com/viewer/p.xml", "https://example.com/viewer/p.xml"],
    ["https://example.com/id/full/512,/0/default.jpg", "https://example.com/id/info.json"],
    ["https://www.rijksmuseum.nl/api/getTilesInfo?object_id=1&callback=x", "https://www.rijksmuseum.nl/api/getTilesInfo?object_id=1"],
    ["https://artsandculture.google.com/asset/title/id?hl=en", "https://artsandculture.google.com/asset/title/id"],
];

for (const [input, expected] of cases) {
    assert.strictEqual(recognize(input), expected, input);
}

assert.strictEqual(recognize("https://example.com/photo.jpg"), undefined);
assert.strictEqual(
    recognize("https://dezoomify.ophir.dev/#https://example.com/info.json"),
    undefined
);

console.log(`Passed ${cases.length + 2} URL recognition tests`);
