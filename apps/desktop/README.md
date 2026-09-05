# Desktop Application (lean shell scaffold)

Dezoomify native shell scaffold: validated deep links, command registry, job
lifecycle table, and capability manifests. Standard library only, no Tauri
window, installer, or execution yet.

- Shell: lean `src-tauri/` (no Tauri SDK vendored); frontend contract from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Installers ship unsigned (no paid signing in this free project); update
  payloads carry free self-generated signatures.

Contributing: talk to the engine only through the narrow validated IPC
bridge. Tests: `cargo xtask test desktop`.
