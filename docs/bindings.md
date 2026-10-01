# Bindings

`crates/dezoomify/src/model.rs` is the source of cross-language values.
Rust derives serialization and TypeScript declarations through tsify.
`host.rs` contains one authored method list used by the Rust Host trait and
the WASM imports, delegating implementation, and TypeScript Host interface.

`cargo xtask bindings generate` builds real WASM and refreshes the tracked
`packages/wasm-bindings/src/generated.d.ts`. Browser modules import these generated types.
The website imports the package for both its types and runtime calls. Vite resolves
that runtime import to the built WASM glue; typechecking uses the tracked declaration
and works before the ignored build artifacts exist.

## Calls

`dezoomify(inputs, options, host): Promise<Output>` invokes the shared Rust
algorithm. The supplied Host implements fetch, probe, tile acquisition, output,
image/level/partial choices, checkpoints, sleep, progress, warnings, and settlement.
`warn(message)` writes format warnings to the Host's bounded diagnostic recorder.

Calls return their values through ordinary futures and promises. A rejected
capability preserves a structured domain Error. Invalid JavaScript values
produce `binding.invalid-value` with diagnostic detail. Invalid arguments also
await Host settlement before the invocation rejects.

Metadata bytes use `Uint8Array` through serde_bytes. Pure tile processing uses
`applyProcessing(recipe, bytes)` and returns `Uint8Array`. Independent
invocations receive independent Host objects.

## Domain values

Inputs preserve URLs, optional source contents, and evidence kind. Resource
responses preserve bytes and redirected addresses. Tile values carry their
index, exact request, placement (including the tile's probe and output
participation), declared canvas, and processing recipe.
The finish request identifies acquired probes by their final tile index and
position. Missing tiles preserve the complete errors from their acquisition attempts.

Errors are one closed enum with an internally tagged `kind` (the kebab-case
variant name): the single stable identifier across the boundary. Variants
carry structured facts (HTTP status, request address, retry hint, bounded
server preview, policy reason, attempted transport, structured limit facts,
and bounded diagnostic detail): `request` and `detail` ride on one flattened
`Failure` context shared by every variant and serialize inline, so the wire
shape stays flat. The `resource` composition variant (exact URI and resource
kind over a nested cause) and `discovery-failed`'s retained cause keep their
underlying error through `#[source]` chains. Display messages render from
those fields only and never cross as stored text; the derived retry verdict
(`Error::retryable`) is a method, not a field. Both sides raise the same
shapes: JavaScript hosts throw plain objects matching variant shapes and
serde round-trips them through the tag. The WASM bindings are generated
(`cargo xtask bindings generate`); never hand-edit them. Secret query-key
vocabulary and the policies duplicated across the frontier are pinned by
`testdata/policy-vectors.json`; deep-link parsing lives once in the native
shell, pinned by `testdata/deep-link-vectors.json` (see
[Security](security.md#credentials)).
Progress reports work and geometry; Output reports missing tiles
(completeness is derived from their absence), canvas, format, and actual
save disposition.

Browser products save PNG. Native output formats are defined in
[Native apps](native-apps.md#output-naming-and-encoders). Native
encoders `[png, jpeg, tiff, zif, webp]` match `generated/desktop-capabilities.json`.

## Handoff and diagnostics

A `dezoomify://` link carries bounded non-secret input to the desktop app.
Receivers validate it and confirm it with the user. Browser credentials never
transfer through a handoff.

DiagnosticReport and its record/value types derive from model.rs. Reports stay
bounded and local; they record observations and do not authorize actions.
