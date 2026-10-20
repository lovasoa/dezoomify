import { readFileSync } from "node:fs";
import sharp from "sharp";

export async function serve(request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/fixtures\/iiif\/catalog\/(first|second)\/(.*)$/);
  if (!match) return null;
  const [, image, path] = match;
  if (path === "info.json") {
    return Response.json({
      "@context": "http://iiif.io/api/image/3/context.json",
      id: `${url.origin}/fixtures/iiif/catalog/${image}`,
      type: "ImageService3",
      profile: "level2",
      preferredFormats: ["png"],
      width: 512,
      height: 512,
      tiles: [{ width: 256, scaleFactors: [1, 2] }],
    });
  }
  const preview = path.match(/^full\/(\d+),(\d+)\/0\/default.jpg$/);
  if (preview) {
    const file = image === "first" ? "0-0.png" : "whole.jpg";
    const bytes = await sharp(readFileSync(new URL(`../../tiles/${file}`, import.meta.url)))
      .resize(Number(preview[1]), Number(preview[2]))
      .jpeg()
      .toBuffer();
    return new Response(bytes, { headers: { "content-type": "image/jpeg" } });
  }
  const tile = path.match(/^(0|256),(0|256),256,256\/256,256\/0\/default.png$/);
  if (!tile) return new Response(null, { status: 404 });
  const file = image === "first" ? "0-0" : `${Number(tile[1]) / 256}-${Number(tile[2]) / 256}`;
  return new Response(readFileSync(new URL(`../../tiles/${file}.png`, import.meta.url)), {
    headers: { "content-type": "image/png" },
  });
}
