// Cloudflare Pages Function: binds POST /api/proxy to the pure relay in
// ../../src/server/proxy.ts. Metadata files only, never tiles; no cookies or
// credentials are accepted or forwarded. Pure modules live outside functions/
// so that every file under it is a real route (legacy/functions/proxy.js owns
// the /proxy route for the legacy site).
import { handleProxyRequest } from "../../src/server/proxy.ts";
import { buildProxyCorsHeaders } from "../../src/server/security.ts";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function websiteOriginOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function policyJsonResponse(status: number): Response {
  return Response.json(
    { code: "PROXY_POLICY_DENIED" },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function readBoundedJson(request: Request): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_REQUEST_BODY_BYTES) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function onRequestPost(context: { request: Request }): Promise<Response> {
  const { request } = context;
  const websiteOrigin = websiteOriginOf(request.url);
  const parsed = await readBoundedJson(request);
  if (parsed === null || typeof parsed !== "object") {
    return policyJsonResponse(400);
  }
  const body = parsed as {
    targetUrl?: unknown;
    protocolVersion?: unknown;
  };
  if (typeof body.targetUrl !== "string" || typeof body.protocolVersion !== "number") {
    return policyJsonResponse(422);
  }
  const result = await handleProxyRequest(
    {
      method: request.method,
      targetUrl: body.targetUrl,
      protocolVersion: body.protocolVersion,
      origin: request.headers.get("origin") ?? undefined,
    },
    {
      // redirect: "manual" is required so every 3xx hop surfaces back through
      // handleProxyRequest's validateProxyTarget revalidation; the default
      // "follow" would consume redirects inside fetch and bypass the SSRF check.
      fetchUpstream: (url, init) =>
        fetch(url, {
          method: init.method,
          headers: init.headers,
          redirect: "manual",
          signal: init.signal ?? request.signal,
        }),
      websiteOrigin,
      signal: request.signal,
    },
  );
  if (result.body !== undefined) {
    return new Response(result.body, { status: result.status, headers: result.headers });
  }
  return Response.json(
    { code: result.code ?? "PROXY_ERROR", requestId: result.requestId },
    { status: result.status, headers: result.headers },
  );
}

export async function onRequestOptions(context: { request: Request }): Promise<Response> {
  const { request } = context;
  const websiteOrigin = websiteOriginOf(request.url);
  const cors = buildProxyCorsHeaders(websiteOrigin, request.headers.get("origin") ?? undefined);
  if (cors["access-control-allow-origin"] === undefined) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    },
  });
}
