// GENERATED from src/proxyTransport.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: src/proxyTransport.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Browser-side proxy client: POST same-origin /api/proxy, credentials omit.
//
// The response-size cap mirrors the server limit (`PROXY_MAX_BYTES` in
// `src/server/security.ts`): the server stays authoritative, this browser-side
// guard only fails closed early instead of buffering an over-budget body.
export const PROXY_METADATA_MAX_BYTES = 2 * 1024 * 1024;

function safeHeaders(input         )                         {
  const out                         = {};
  if (!input) return out;
  try {
    const h = input

     ;
    if (typeof h.get === "function") {
      for (const k of ["content-type", "content-length"]) {
        const v = h.get(k);
        if (v !== null && v !== undefined) out[k] = String(v);
      }
      return out;
    }
    if (typeof h.forEach === "function") {
      h.forEach((v        , k        ) => {
        out[String(k).toLowerCase()] = String(v);
      });
      return out;
    }
  } catch {
    // ignore
  }
  return out;
}

export function createProxyTransport(
  fetchImpl                ,
  opts                                                                   ,
)

  {
  const proxyPath = opts.proxyPath ?? "/api/proxy";

  async function fetchViaProxy(
    targetUrl        ,
    callOpts                           ,
  )                            {
    // Reject credential-bearing targets before any proxy request.
    let parsed     ;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return { ok: false, status: 0, code: "PROXY_POLICY_DENIED" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, status: 0, code: "PROXY_POLICY_DENIED" };
    }
    if (callOpts?.signal?.aborted) {
      return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    }
    let response

     ;
    try {
      response = await fetchImpl(proxyPath, {
        method: "POST",
        credentials: "omit",
        signal: callOpts?.signal,
        headers: { "content-type": "application/json" },
        // Only target URL + protocol version; no cookies/auth/referrer/user headers.
        body: JSON.stringify({ targetUrl, protocolVersion: opts.protocolVersion }),
      });
    } catch (err         ) {
      if (callOpts?.signal?.aborted) {
        return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
      }
      void err;
      return { ok: false, status: 0, code: "TRANSPORT_NETWORK_ERROR" };
    }
    if (callOpts?.signal?.aborted) {
      return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    }
    const headers = safeHeaders(response.headers);
    // Response-size guard before trusting body.
    const declared = headers["content-length"] ? Number(headers["content-length"]) : NaN;
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      return { ok: false, status: response.status, code: "PROXY_BUDGET_EXCEEDED" };
    }
    let bytes             ;
    try {
      bytes = await response.arrayBuffer();
    } catch {
      return { ok: false, status: response.status, code: "TRANSPORT_NETWORK_ERROR" };
    }
    if (bytes.byteLength > opts.maxBytes) {
      return { ok: false, status: response.status, code: "PROXY_BUDGET_EXCEEDED" };
    }
    if (response.status === 429) return { ok: false, status: 429, code: "PROXY_RATE_LIMITED" };
    if (response.status === 413) return { ok: false, status: 413, code: "PROXY_BUDGET_EXCEEDED" };
    if (response.status === 403 || response.status === 422) {
      return { ok: false, status: response.status, code: "PROXY_POLICY_DENIED" };
    }
    if (response.status < 200 || response.status > 299) {
      return { ok: false, status: response.status, code: "TRANSPORT_HTTP_ERROR" };
    }
    return {
      ok: true,
      status: response.status,
      bytes,
      contentType: headers["content-type"],
    };
  }

  return { fetchViaProxy };
}
