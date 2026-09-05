# fixture-server

A local HTTP server that pretends to be museums, archives, and tile servers
so tests never touch the real internet: redirects, ranges, cookies, CORS
success/failure, throttling, truncation, and malformed responses, all on an
ephemeral loopback port with recorded request logs.

```sh
cargo xtask fixtures serve --port 0   # run it manually
cargo xtask fixtures verify           # validate the scenario corpus
```

Test-only by construction: no proxying to public hosts, loopback-only.
