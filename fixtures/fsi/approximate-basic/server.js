import { readFileSync } from "node:fs";
export function serve(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/fixtures/fsi/approximate-basic/"))
    return new Response(null, { status: 404 });
  return url.searchParams.get("type") === "image"
    ? new Response(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)), {
        headers: { "content-type": "image/jpeg" },
      })
    : new Response('<property width value="512" /><property height value="512" />');
}
