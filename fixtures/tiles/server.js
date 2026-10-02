import { readFileSync } from "node:fs";

export function tile(x, y) {
  if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n < 2))
    return new Response(null, { status: 404 });
  return new Response(readFileSync(new URL(`${x}-${y}.jpg`, import.meta.url)), {
    headers: { "content-type": "image/jpeg" },
  });
}
