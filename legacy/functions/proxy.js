const MAX_REDIRECTS = 3;

function corsHeaders(headers) {
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "X-Set-Cookie");
  return headers;
}

function errorResponse(error, status = 500) {
  return new Response(String(error) + "\n", {
    status,
    headers: corsHeaders(new Headers({ "Content-Type": "text/plain" })),
  });
}

export async function proxy(request) {
  const proxyUrl = new URL(request.url);
  const targetUrl = proxyUrl.searchParams.get("url");
  if (!targetUrl) return errorResponse("Missing url query parameter", 400);

  const target = new URL(targetUrl);
  const headers = new Headers({
    "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
    "Accept": request.headers.get("Accept") || "*/*",
    "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.5",
    "Accept-Encoding": "identity",
    "Origin": target.origin,
    "Referer": targetUrl,
  });

  const cookies = proxyUrl.searchParams.get("cookies");
  if (cookies) headers.set("Cookie", cookies);

  let response = await fetch(targetUrl, { headers, redirect: "manual" });
  let location = response.headers.get("Location");
  for (let i = 0; i < MAX_REDIRECTS && location; i++) {
    response = await fetch(new URL(location, response.url), { headers, redirect: "manual" });
    location = response.headers.get("Location");
  }

  const responseHeaders = corsHeaders(new Headers(response.headers));
  const setCookie = responseHeaders.get("Set-Cookie");
  if (setCookie) responseHeaders.set("X-Set-Cookie", setCookie);
  responseHeaders.delete("Set-Cookie");

  if (location) {
    responseHeaders.set("X-Disabled-Location", location);
    responseHeaders.set("Location", "");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

export function onRequestGet({ request }) {
  return proxy(request).catch(errorResponse);
}

export async function onRequestHead({ request }) {
  const response = await proxy(request).catch(errorResponse);
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(new Headers({
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
      "Access-Control-Max-Age": "86400",
    })),
  });
}
