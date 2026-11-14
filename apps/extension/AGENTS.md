Scans require explicit user action. Request host permission directly from a
visible action, preserving browser user activation. Declare only permissions
used by shipped code in `wxt.config.ts`; ship no permanent host access or
content scripts.

Use `cargo xtask test extension` for packaged Chromium/Firefox coverage.
Package-local `pnpm test` runs units only. Development:
`cargo xtask dev extension --browser chromium`.
