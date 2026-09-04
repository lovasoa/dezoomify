// Extension recognition oracle: runs the untouched url-recognition.js cases
// and writes testdata/scenarios/extension/recognition/expected/legacy-web.json.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..", "..", "..");
const src = fs.readFileSync(
  path.join(root, "migration-sources", "dezoomify-extension", "url-recognition.js"),
  "utf8"
);
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${src}\nglobalThis.__rec = recognizeZoomableUrl;`, sandbox);
const recognize = sandbox.__rec;

const positives = [
  ["https://example.com/ImageProperties.xml?t123", "https://example.com/ImageProperties.xml"],
  ["https://example.com/image/info.json", "https://example.com/image/info.json"],
  ["https://example.com/image.dzi?cache=1", "https://example.com/image_files/0/0_0.jpg"],
  ["https://example.com/image_files/12/3_4.jpg?cache=1", "https://example.com/image_files/0/0_0.jpg"],
  ["https://example.com/image_files/12/3_4.jpeg", "https://example.com/image_files/0/0_0.jpg"],
  ["https://example.com/TileGroup2/5-3-4.jpg", "https://example.com/ImageProperties.xml"],
  ["https://example.com/iip?FIF=image.tif&WID=500", "https://example.com/iip?FIF=image.tif"],
  ["https://example.com/image.imgi?cmd=info", "https://example.com/image.imgi?cmd=info"],
  ["https://example.com/image.ecw", "https://example.com/image.ecw"],
  ["https://example.com/id/full/512,/0/default.jpg", "https://example.com/id/info.json"],
  ["https://artsandculture.google.com/asset/title/id?hl=en", "https://artsandculture.google.com/asset/title/id"],
];
const negatives = [
  "https://example.com/photo.jpg",
  "https://example.com/image.pff",
  "https://example.com/viewer/p.xml",
  "https://www.rijksmuseum.nl/api/getTilesInfo?object_id=1&callback=x",
  "https://dezoomify.ophir.dev/#https://example.com/info.json",
];

let failed = 0;
const cases = [];
for (const [input, expected] of positives) {
  const got = recognize(input) ?? null;
  if (got !== expected) {
    console.error(`MISMATCH ${input}: got ${got}, want ${expected}`);
    failed += 1;
  }
  cases.push({ input, expected, got });
}
for (const input of negatives) {
  const got = recognize(input) ?? null;
  if (got !== null) {
    console.error(`MISMATCH ${input}: got ${got}, want null`);
    failed += 1;
  }
  cases.push({ input, expected: null, got });
}
const transcript = { scenario: "extension/recognition", cases, metadata_requests: [], tile_requests: [] };
const dir = path.join(root, "testdata", "scenarios", "extension", "recognition", "expected");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "legacy-web.json"), JSON.stringify(transcript, null, 2) + "\n");
console.log(`recognition oracle: ${cases.length} cases, ${failed} mismatches`);
process.exit(failed ? 1 : 0);
