export function serve(request) {
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/fixtures/assembly/tile.svg") return null;
  const params = url.searchParams;
  const width = params.get("w");
  const height = params.get("h");
  const color = params.get("color");
  const positive = (value) =>
    /^\d+$/.test(value ?? "") && Number(value) > 0 && Number(value) <= 0xffffffff;
  if (!positive(width) || !positive(height) || !/^[a-f\d]{6}$/i.test(color ?? "")) {
    return new Response("fixture error", {
      status: 400,
      headers: { "content-type": "text/plain" },
    });
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Number(width)}" height="${Number(height)}"><rect width="100%" height="100%" fill="#${color}"/></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
}
