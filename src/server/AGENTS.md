- Proxy only public image-download resources without credentials. Preserve
  destination checks across DNS resolution and redirects, bounded responses,
  and the header allowlist. Local and deployed adapters must share this policy.
- Source URLs must not enter server logs or monitoring.
- Preserve HTTP refusal facts; fallback must never reinterpret them as CORS
  failures. Use the shared signed-query policy rather than a new credential list.
