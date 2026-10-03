import { readFileSync } from "node:fs";
export function serve(request, { file }) {
  if (file) return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/fixtures/fsi/approximate-basic/")) return null;
  return url.searchParams.get("type") === "image"
    ? new Response(readFileSync(new URL("../../tiles/whole.jpg", import.meta.url)), {
        headers: { "content-type": "image/jpeg" },
      })
    : new Response('<property width value="512" /><property height value="512" />');
}
