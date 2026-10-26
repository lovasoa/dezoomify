import { readFileSync } from "node:fs";

export function serve(request) {
  const { pathname } = new URL(request.url);
  const prefix = "/fixtures/iiif/approximate-gallica/";
  if (!pathname.startsWith(prefix) || pathname.endsWith(".json") || pathname.endsWith(".html"))
    return null;
  if (pathname !== `${prefix}0,0,512,512/512,512/0/native.jpg`)
    return new Response(null, { status: 404 });
  return new Response(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)), {
    headers: { "content-type": "image/jpeg" },
  });
}
