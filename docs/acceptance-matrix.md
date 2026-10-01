# Acceptance matrix

Behavior is checked through the shared Rust function, real platform operations,
and product entry points. Fixture data lives under `testdata/scenarios`; required
tests contact no public source websites.

| Behavior | Executable evidence | Lane |
|---|---|---|
| Format parsing, geometry, exact URLs, headers, processing | Rust format tests, `core_parity.rs`, `discovery_navigation.rs` | `test core` |
| Image/level precedence, deferred resources, budgets | Direct async discovery and algorithm tests with injected capabilities | `test core` |
| Bounded acquisition, retry, missing-only retry, cancellation | Direct Host tests and native loopback tests | `test core`, `test native` |
| Async binding success, structured rejection, invalid values, binary data, concurrent invocations, late cancellation | `packages/wasm-harness/src/node.spec.mjs`, fresh WASM build | `test wasm` |
| Direct metadata success avoids proxy; eligible failures use proxy; HTTP refusals stay refusals | `test/integration.test.mjs`, browser transport tests | `test web`, `test browser` |
| Body limits, decode disposal, image placement, canvas failure, ordinary image display | Browser operation tests, website assembly fixtures | `test browser`, `test web --e2e` |
| Progress, completed output, partial gaps, resolution notice, error details | `test/presentation.test.mjs`, `test/view-rendering.test.mjs` | `test ui` |
| Keyboard, accessible names, translated controls | `test/ui-a11y.test.mjs`, `test/ui-i18n.test.mjs` | `test ui` |
| FIFO advancement, isolated failures, cancellation, retry | Shared queue tests and desktop queue tests | `test`, `test desktop` |
| Local history retention and canonical labels | `test/history.test.mjs`, `test/labels.test.mjs` | `test` |
| Source-document identity, scan limits, permission user activation, authenticated fetch, redirects | Extension source tests and packaged Chromium/Firefox fixture journeys | `test extension` |
| Native file/HTTP reads, cache, output formats, ICC/EXIF, overwrite policy, publication | Native I/O tests and actual CLI scenarios | `test native`, `test scenario` |
| Bounded decode, memory/spool accounting, cancellation/publication ordering | Native pipeline and sink tests | `test native` |
| Desktop settings, save, cancel, queue, partial, open/reveal, confirmed handoff | Desktop tests and real-window fixture journeys | `test desktop`, `test desktop --e2e-window` |
| Legacy `/` and new `/beta` routes, fresh WASM, packaged assets | Assembled-site build and website/extension E2E | `build web`, `test all` |

`cargo xtask check` validates formatting, Clippy, TypeScript, architecture,
fixtures, content, and generated bindings. `cargo xtask test` runs fast Rust and
Node tests once. `test all` adds built-WASM and packaged-browser journeys.
`ci local` also validates portability and dependencies.

The desktop real-window gate runs explicitly. Production builds cover web,
CLI, extension, and desktop. Product observations
compare selected dimensions, decoded pixels, required/forbidden requests,
attempt counts, visible choices, actual saved output, and cleanup. Pure parser
and platform tests remain focused where full product tests cannot economically
exercise exhaustive combinations.
