# shared-ui

- **Responsibility:** Provide the shared accessible workflow for source entry,
  discovery/selection, options, progress, cancellation, results, and errors.
- **Allowed dependencies:** `protocol-ts`, a narrow runtime interface, and
  host-neutral UI/style libraries; hosts inject platform capabilities.
- **Forbidden responsibilities:** No direct network/filesystem/extension APIs,
  protocol redefinition, job orchestration, secrets, or host-specific branching
  hidden in shared components.
- **Interfaces and tests:** Expose the shared UI components and runtime
  integration contract. Test state rendering, accessibility, responsive layouts,
  cancellation, partial results, stable error codes, and host-integration contract
  fixtures. Always identify the active transport and expose the metadata CORS proxy  setting/opt-out without a per-attempt proxy consent prompt; do not present
  automatic credential-free metadata proxy fallback as consent for native cookie
  handoff. Parse website/deep-link handoffs as bounded, versioned, non-secret,
  untrusted input and require validation plus user confirmation before work.
- **Migration source:** Migrate the browser interaction flow from
  `migration-sources/dezoomify-web`, not its legacy global runtime structure.
