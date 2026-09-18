# dezoomify-native (native effect runtime)

Real native egress and output: a reqwest-based HTTP client (one reusable
client per job, per-redirect header rebuild, credential rescoping every hop)
with size/time limits and zero transport retries (the engine owns the whole
retry budget); the job-driven download pipeline (`dezoomify-engine` owns
discovery, selection, planning, retry, and lifecycle policy while
`pipeline`/`exec` execute fetch, probe, decode, assemble, output encode
(PNG, JPEG, TIFF, ZIF pyramid, WebP, static `iiif-dir` tile trees), atomic
write, and real sha256); plus auth/header scope (credentials redacted from
every error, log, and snapshot), engine-slot concurrency bounds, an optional
tile resume cache (storage `cache`: response bodies under per-job digest
namespaces, reused across runs, headers and cookies never stored), and
output validation.

```sh
cargo xtask test native     # runtime + CLI suites, loopback egress tests
cargo xtask test scenario   # fixture-server scenarios pinning real digests
cargo xtask build cli       # the `dezoomify` executable
```

The native and scenario suites also run once through the workspace Cargo
invocation in bare `cargo xtask test`; `test all` does not repeat them. Cargo's
terse runner keeps passing output compact and prints detailed failures. Direct
Cargo commands remain valid for debugging, while xtask is the unified front
door.
