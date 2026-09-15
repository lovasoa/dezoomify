# dezoomify-native (native effect runtime)

Real native egress and output: a rustls-based HTTP client with per-redirect
header rebuild, size/time limits and bounded retries; the job-driven download
pipeline (`dezoomify-job` owns discovery, selection, planning, retry, and
lifecycle policy while `pipeline`/`job_driver` execute fetch, probe, decode,
assemble, output encode (PNG, JPEG, TIFF, static `iiif-dir` tile trees),
atomic write, and real sha256); plus auth/header scope
(credentials redacted from every error, log, and snapshot), bounded scheduler
counters, an optional tile resume cache (storage `cache`: response bodies
under per-job digest namespaces, reused across runs, headers and cookies
never stored), and output validation.

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
