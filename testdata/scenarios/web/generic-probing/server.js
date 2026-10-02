export function serve(request) {
  const url = new URL(request.url);
  const integer = (name) =>
    /^-?\d+$/.test(url.searchParams.get(name) ?? "") ? Number(url.searchParams.get(name)) : NaN;
  const x = integer("x");
  const y = integer("y");
  const square = x >= 0 && x < 2 && y >= 0 && y < 2;
  const shape = url.pathname
    .split("/")
    .at(-1)
    .replace(/\.svg$/, "");
  const dimensions = {
    padded: square && [256, 256],
    large: x >= 0 && x < 2 && y === 0 && [512, 512],
    edge: square && [x === 1 ? 1 : 256, y === 1 ? 14 : 256],
    boundary: x >= 0 && x < 1000 && y === 0 && [256, 256],
    one: x >= 0 && x < 3 && y === 0 && [256, 256],
    "missing-origin": square && (x !== 0 || y !== 0) && [256, 256],
    placeholder: Number.isFinite(x) && Number.isFinite(y) && (square ? [256, 256] : [1, 1]),
  }[shape];
  if (!dimensions)
    return new Response("fixture error", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  const [width, height] = dimensions;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#888888"/></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
}
