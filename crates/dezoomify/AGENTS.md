- Keep parsers and geometry pure. Return requests for missing bytes; Hosts own
  I/O, clocks, codecs, HTML parsing, and task lifetimes.
- Add formats through `SPEC` and `core/registry.rs`. The route API in
  `core/discovery.rs` owns evidence, fallback, canonical URL, and file-picker
  contracts; reuse its matchers rather than adding format checks to hosts.
- For containers, request bounded byte ranges and replay discovery context.
  Keep container parsing in its Sans-I/O library; see `zif.rs`.
- Add a minimal shared product fixture under `fixtures/` for new format support;
  parser tests should cover malformed metadata and unusual geometry.
- Validate with `cargo xtask test core` and the affected product fixture matrix.
