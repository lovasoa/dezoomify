import { readFileSync } from "node:fs";
import sharp from "sharp";

const preview = sharp(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)))
  .resize(256, 256)
  .png()
  .toBuffer();

export async function serve(request) {
  const match = new URL(request.url).pathname.match(
    /^\/fixtures\/deepzoom\/catalog\/(first|second)\/(8|9)\/(\d)_(\d)\.png$/,
  );
  if (!match) return null;
  const [, image, level, x, y] = match;
  const bytes =
    level === "8" && image === "second"
      ? await preview
      : readFileSync(
          new URL(`../../tiles/${image === "first" ? "0-0" : `${x}-${y}`}.png`, import.meta.url),
        );
  return new Response(bytes, { headers: { "content-type": "image/png" } });
}
