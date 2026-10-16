import { readFileSync } from "node:fs";

export function serve(request) {
  const url = new URL(request.url);
  let column, row;
  const dzi = url.pathname.match(/^\/memory-tiles\/\d+\/([01])_([01])\.png$/);
  const zoomify = url.pathname.match(/^\/memory-zoomify\/TileGroup\d+\/\d+-([01])-([01])\.jpg$/);
  const iiif = url.pathname.match(/^\/memory-iiif\/(\d+),(\d+),\d+,\d+\//);
  if (dzi || zoomify) {
    column = Number((dzi ?? zoomify)[1]);
    row = Number((dzi ?? zoomify)[2]);
  } else if (iiif) {
    column = Number(iiif[1]) / 256;
    row = Number(iiif[2]) / 256;
  } else if (url.pathname === "/memory-iip") {
    if (url.searchParams.has("obj"))
      return new Response(
        "IIP:1.0\nMax-size:512 512\nTile-size:256 256\nResolution-number:2\nResolutions:256 256,512 512\n",
      );
    const tile = url.searchParams.get("JTL");
    if (!tile) return new Response("memory fixture accepts JTL tiles only", { status: 404 });
    const [, ordinal] = tile.split(",").map(Number);
    column = ordinal % 2;
    row = Math.floor(ordinal / 2);
  } else return null;
  if (![0, 1].includes(column) || ![0, 1].includes(row))
    return new Response("invalid tile", { status: 404 });
  const bytes = readFileSync(
    new URL(`../../../../fixtures/tiles/${column}-${row}.png`, import.meta.url),
  );
  return new Response(bytes, { headers: { "content-type": "image/png" } });
}
