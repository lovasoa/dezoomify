# Desktop Application (lean shell)

Dezoomify native shell: validated deep links, command registry, job
lifecycle table, capability manifests, framed Native Messaging handoff
execution with origin-scoped cookies, and per-user initial registration
(Native Messaging manifests plus the `dezoomify://` protocol handler).

- Shell: lean `src-tauri/` (pure Rust, no Tauri SDK vendored); frontend contract from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Native handoff runs over length-prefixed Native Messaging: handshake,
  one-use challenge/nonce sessions, explicit consent, single bounded cookie
  message, sibling isolation, redacted diagnostics. See `src/native_host/`.
- First-run registration is per-user only: `dezoomify-desktop
  --register-native-host` writes the manifests and protocol handler;
  `--check-native-host` inspects, `--unregister-native-host` cleans up.
- Installers ship unsigned (no paid signing in this free project); update
  payloads carry free self-generated signatures.

- Shell: lean `src-tauri/` (no Tauri SDK vendored); frontend contract from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Installers ship unsigned (no paid signing in this free project); update
  payloads carry free self-generated signatures.

Contributing: talk to the engine only through the narrow validated IPC
bridge. Tests: `cargo xtask test desktop`.
