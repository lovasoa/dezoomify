import { readFileSync } from "node:fs";
export function serve(request) {
  if (new URL(request.url).pathname !== "/image/tiler/square/vls-fixture/0/0/0")
    return new Response(null, { status: 404 });
  return new Response(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)), {
    headers: { "content-type": "image/jpeg" },
  });
}
