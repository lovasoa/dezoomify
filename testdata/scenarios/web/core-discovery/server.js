import { readFile } from "node:fs/promises";

export async function serve(request) {
  const params = new URL(request.url).searchParams;
  const available = ["x", "y"].every((name) => {
    const value = params.get(name);
    return /^-?\d+$/.test(value ?? "") && Number(value) >= 0 && Number(value) < 2;
  });
  if (!available)
    return new Response("fixture error", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  return new Response(
    await readFile(new URL("./payloads/127.0.0.1/fixtures/pnav/image.jpg", import.meta.url)),
    {
      headers: { "content-type": "image/jpeg" },
    },
  );
}
