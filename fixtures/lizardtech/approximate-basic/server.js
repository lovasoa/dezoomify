import { readFileSync } from "node:fs";
export function serve(request, { file }) {
  if (file) return null;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/fixtures/lizardtech/approximate-basic/")) return null;
  const image = url.pathname.endsWith("/getimage");
  return new Response(
    readFileSync(new URL(image ? "../../tiles/whole.jpg" : "metadata.xml", import.meta.url)),
    { headers: { "content-type": image ? "image/jpeg" : "application/xml" } },
  );
}
