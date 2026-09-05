// Typed build-time website configuration.
export interface WebConfig {
  websiteOrigin: string;
  allowLoopbackHttp: boolean;
  minProtocolVersion: number;
  maxProtocolVersion: number;
  proxyPath: string;
  supportUrl: string;
}

export function loadWebConfig(env: Record<string, string | undefined>): WebConfig {
  const websiteOrigin = env.WEBSITE_ORIGIN ?? "https://example.example";
  const nodeEnv = env.NODE_ENV ?? "production";
  const allowLoopbackHttp = nodeEnv === "test" || nodeEnv === "development";
  let parsed: URL;
  try {
    parsed = new URL(websiteOrigin);
  } catch {
    throw new Error(`invalid WEBSITE_ORIGIN: ${websiteOrigin}`);
  }
  if (parsed.protocol !== "https:" && !(allowLoopbackHttp && parsed.protocol === "http:")) {
    throw new Error(`WEBSITE_ORIGIN must be https (got ${parsed.protocol})`);
  }
  return {
    websiteOrigin: parsed.origin,
    allowLoopbackHttp,
    minProtocolVersion: 1,
    maxProtocolVersion: 1,
    proxyPath: "/api/proxy",
    supportUrl: env.SUPPORT_URL ?? "https://example.example/support",
  };
}

export function isAllowedSourceUrl(urlString: string, config: WebConfig): boolean {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.protocol === "http:") {
    const host = u.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!(config.allowLoopbackHttp && loopback)) return false;
  }
  void config;
  return true;
}
