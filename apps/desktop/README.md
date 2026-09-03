# Desktop Application

- **Responsibility:** Package the shared studio UI with native job capabilities,
  desktop lifecycle, file dialogs, updates, and platform integration.
- **Allowed dependencies:** `dezoomify-native`, `dezoomify-protocol`,
  `packages/studio-ui`, and the selected desktop shell.
- **Forbidden responsibilities:** No duplicate web UI, core parsing, job state
  machine, or unrestricted bridge from web content to native capabilities.
- **Interfaces and tests:** Expose a narrow validated IPC bridge. Test capability
  authorization, window/job shutdown, file selection, output flow, packaging
  smoke, and shared UI contracts.
- **Migration source:** Native workflows and output behavior come from
  `migration-sources/dezoomify-rs`; the shared interaction model starts from
  `migration-sources/dezoomify-web`.
