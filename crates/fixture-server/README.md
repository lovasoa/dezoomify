# fixture-server

Rust corpus readers and process adapters for the Node server in
[`test/fixture-server.mjs`](../../test/fixture-server.mjs). Node pretends to be museums, archives, and tile servers
so tests never touch the real internet: redirects, ranges, cookie-gated routes, CORS
success/failure, throttling, truncation, and malformed responses, all on an
ephemeral loopback port with recorded request logs.

```sh
cargo xtask fixtures serve --port 0   # run it manually
```

Test-only by construction: no proxying to public hosts, loopback-only.

The server uses Node built-ins and requires no Cargo build. Rust tests launch
Node with piped stdin; closing that pipe stops the server. Deliberately malformed
transport responses use [`test/raw-server.mjs`](../../test/raw-server.mjs).
