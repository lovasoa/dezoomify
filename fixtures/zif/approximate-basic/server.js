import { readFileSync } from "node:fs";

// Synthetic JPEG BigTIFF with its tile indexes past the metadata body limit.
// A full-file fetch is deliberately refused: every product must use ranges.
const tiles = ["0-0", "1-0", "0-1", "1-1"].map((name) =>
  readFileSync(new URL(`../../tiles/${name}.jpg`, import.meta.url)),
);
const indexStart = 9 * 1024 * 1024;
const bytes = Buffer.alloc(indexStart + 48);
bytes.write("II");
bytes.writeUInt16LE(43, 2);
bytes.writeUInt16LE(8, 4);
bytes.writeBigUInt64LE(16n, 8);
const offsets = [];
let cursor = 568;
for (const tile of tiles) {
  offsets.push(cursor);
  tile.copy(bytes, cursor);
  cursor += tile.length;
}

function directory(at, size, offsetsValue, countsValue, next) {
  const count = size === 512 ? 4 : 1;
  const entries = [
    [254, 4, 1, next ? 0 : 1],
    [256, 4, 1, size],
    [257, 4, 1, size],
    [258, 3, 3, 8n | (8n << 16n) | (8n << 32n)],
    [259, 3, 1, 7],
    [262, 3, 1, 6],
    [274, 3, 1, 1],
    [277, 3, 1, 3],
    [284, 3, 1, 1],
    [322, 3, 1, 256],
    [323, 3, 1, 256],
    [324, 16, count, offsetsValue],
    [325, 4, count, countsValue],
  ];
  bytes.writeBigUInt64LE(BigInt(entries.length), at);
  for (const [tag, type, length, value] of entries) {
    at += 8;
    bytes.writeUInt16LE(tag, at);
    bytes.writeUInt16LE(type, at + 2);
    bytes.writeBigUInt64LE(BigInt(length), at + 4);
    bytes.writeBigUInt64LE(BigInt(value), at + 12);
    at += 12;
  }
  bytes.writeBigUInt64LE(BigInt(next), at + 8);
}

directory(16, 512, indexStart, indexStart + 32, 292);
directory(292, 256, offsets[0], tiles[0].length, 0);
for (let i = 0; i < tiles.length; i++) {
  bytes.writeBigUInt64LE(BigInt(offsets[i]), indexStart + 8 * i);
  bytes.writeUInt32LE(tiles[i].length, indexStart + 32 + 4 * i);
}

export function serve(request) {
  const url = new URL(request.url);
  if (!/^\/fixtures\/zif\/approximate-(?:basic|direct)\/image\.zif$/.test(url.pathname))
    return null;
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
  if (!match) return new Response("A byte range is required", { status: 400 });
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > end || end >= bytes.length) return new Response(null, { status: 416 });
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      "content-type": "image/tiff",
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${bytes.length}`,
    },
  });
}
