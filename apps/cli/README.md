# CLI Application

- **Responsibility:** Parse command-line input, configure the native runtime,
  render progress/errors, and choose process exit status.
- **Allowed dependencies:** `dezoomify-native`, `dezoomify-protocol`, and focused
  CLI/presentation libraries.
- **Forbidden responsibilities:** No format parsing, downloader implementation,
  codec logic, or protocol DTO duplication; never print secrets.
- **Interfaces and tests:** Expose the `dezoomify` executable and stable help/exit
  behavior. Test argument parsing, headers, batch mode, cancellation, output
  selection, redacted errors, and fixture-backed end-to-end downloads.
- **Migration source:** Migrate CLI arguments and composition from
  `migration-sources/dezoomify-rs/src`.
