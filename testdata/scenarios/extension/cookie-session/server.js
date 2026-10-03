import { fileResponse } from "../../../../test/fixture-files.mjs";

export function serve(request, { file, origin }) {
  const url = new URL(request.url);
  if (url.hostname !== "127.0.0.1") return null;
  if (url.pathname === "/target.html" && url.search === "?scenario=cookie-session")
    return fileResponse(new URL("./viewer.html", import.meta.url), {
      headers: {
        "Set-Cookie": "fixture_session=extension-e2e; Path=/; HttpOnly; SameSite=Lax",
      },
    });
  if (
    !url.pathname.startsWith("/protected/") &&
    !["/__source-access-proof", "/source-access-proof.txt"].includes(url.pathname)
  )
    return null;
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((pair) => pair.trim());
  if (!cookies.includes("fixture_session=extension-e2e"))
    return new Response("fixture auth required: missing cookie fixture_session", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  if (request.headers.get("referer") !== `${origin}/target.html?scenario=cookie-session`)
    return new Response("fixture requires header Referer", {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  return file ? fileResponse(file) : new Response("not found", { status: 404 });
}
