// Node HTTP adapter for the pure metadata proxy relay.
//
// This is the local-development twin of functions/api/proxy.ts (Cloudflare
// Pages Function) and the node:test seam. All three call the exact same core
// (`handleProxyRequest` in ./proxy.ts) and differ only in how they translate
// the host transport:
//
//   functions/api/proxy.ts   Request/Response (Cloudflare)
//   src/server/proxy-node.ts IncomingMessage/ServerResponse (Node dev server)
//   test/proxy-*.test.mjs     injected fakes (node:test)
//
// The relay itself owns every policy decision (SSRF, credentials, redirects,
// size, content type, CORS). This file only reads a bounded JSON body and
// writes the relay's result back over Node's HTTP types.
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleProxyRequest } from "./proxy.ts";
import { buildProxyCorsHeaders } from "./security.ts";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function websiteOriginOf(req: IncomingMessage): string {
  // Local dev binds plain HTTP on loopback; the origin is derived from the
  // Host header exactly as Cloudflare derives it from request.url.
  return `http://${req.headers.host ?? "127.0.0.1"}`;
}

function requestSignal(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  if (req.destroyed) {
    controller.abort();
    return controller.signal;
  }
  // `aborted` is the precise client-cancel signal; a normal body end is not
  // an abort, so upstream fetches keep running until the relay finishes.
  req.once("aborted", () => controller.abort());
  return controller.signal;
}

async function readBoundedJson(req: IncomingMessage): Promise<unknown | null> {
  const declared = Number(req.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  code: string,
  requestId?: string,
): void {
  const body = JSON.stringify({ code, ...(requestId !== undefined ? { requestId } : {}) });
  const bytes = Buffer.from(body);
  res.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": bytes.byteLength,
  });
  res.end(bytes);
}

/**
 * Serve one /api/proxy request from a Node HTTP server. The optional
 * fetchUpstream override is a test seam only; production and dev both use
 * the global fetch with redirect: "manual" so every hop is revalidated by
 * the relay (never followed inside fetch).
 */
export async function handleNodeProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    fetchUpstream?: (
      url: string,
      init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
    ) => Promise<Response>;
  } = {},
): Promise<void> {
  const signal = requestSignal(req);
  const websiteOrigin = websiteOriginOf(req);
  const cors = buildProxyCorsHeaders(websiteOrigin, req.headers.origin);

  if (req.method === "OPTIONS") {
    if (cors["access-control-allow-origin"] === undefined) {
      res.writeHead(403, { "cache-control": "no-store" });
      res.end();
      return;
    }
    res.writeHead(204, {
      ...cors,
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    });
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, cors, "PROXY_POLICY_DENIED");
    return;
  }

  const parsed = await readBoundedJson(req);
  if (parsed === null || typeof parsed !== "object") {
    sendJson(res, 400, cors, "PROXY_POLICY_DENIED");
    return;
  }
  const body = parsed as { targetUrl?: unknown; protocolVersion?: unknown };
  if (typeof body.targetUrl !== "string" || typeof body.protocolVersion !== "number") {
    sendJson(res, 422, cors, "PROXY_POLICY_DENIED");
    return;
  }

  const result = await handleProxyRequest(
    {
      method: req.method,
      targetUrl: body.targetUrl,
      protocolVersion: body.protocolVersion,
      origin: req.headers.origin,
    },
    {
      fetchUpstream:
        opts.fetchUpstream ??
        ((url, init) =>
          fetch(url, {
            method: init.method,
            headers: init.headers,
            redirect: "manual",
            signal: init.signal ?? signal,
          })),
      websiteOrigin,
      signal,
    },
  );

  if (result.body !== undefined) {
    const bytes = Buffer.from(result.body);
    res.writeHead(result.status, { ...result.headers, "content-length": bytes.byteLength });
    res.end(bytes);
    return;
  }
  sendJson(res, result.status, result.headers, result.code ?? "PROXY_ERROR", result.requestId);
}
