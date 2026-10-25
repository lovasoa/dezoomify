import { readFileSync } from "node:fs";
import sharp from "sharp";
import { tile } from "../../tiles/server.js";

export async function serve(request) {
  const url = new URL(request.url);
  const prefix = "/fixtures/iiif/approximate-emuseum/zoomdispatcher/78199/";
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(prefix.length);
  if (path === "info.json") {
    return new Response("[[missing key: error.i-i-i-f-parameters-invalid-title]]", { status: 400 });
  }
  const full = path.match(/^(0|256),(0|256),256,256\/256,\/0\/default.jpg$/);
  if (full) return tile(Number(full[1]) / 256, Number(full[2]) / 256);
  const scaled = path.match(/^0,0,512,512\/(64|128|256),\/0\/default.jpg$/);
  if (!scaled) return new Response(null, { status: 404 });
  const bytes = await sharp(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)))
    .resize(Number(scaled[1]))
    .jpeg()
    .toBuffer();
  return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
}
