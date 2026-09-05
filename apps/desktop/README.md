# Desktop Application

Dezoomify as a native app: same interface as the website, plus local file
output, `dezoomify://` deep links, and hosting the extension's Native
Messaging bridge.

- Shell: Tauri (`src-tauri/`), frontend from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Installers ship unsigned (no paid signing in this free project); update
  payloads carry free self-generated signatures.

Contributing: talk to the engine only through the narrow validated IPC
bridge. Tests: `cargo xtask test desktop`.
