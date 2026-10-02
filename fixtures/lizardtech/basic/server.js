import { readFileSync } from "node:fs";
export function serve(request) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/fixtures/lizardtech/basic/"))
    return new Response(null, { status: 404 });
  const image = url.pathname.endsWith("/getimage");
  return new Response(
    readFileSync(new URL(image ? "../../tiles/whole.jpg" : "metadata.xml", import.meta.url)),
    { headers: { "content-type": image ? "image/jpeg" : "application/xml" } },
  );
}
