# TypeScript Packages

- **Responsibility:** Hold reusable host-neutral UI, browser runtime, and
  generated protocol bindings shared by browser-facing applications.
- **Allowed dependencies:** Packages may depend on lower packages as documented;
  applications consume packages, never the reverse.
- **Forbidden responsibilities:** No application entry points, Rust domain
  duplication, dependency cycles, or native-only implementation.
- **Interfaces and tests:** Publish explicit exports with type tests, unit tests,
  browser integration tests where needed, and no reliance on deep imports.
- **Migration source:** Extract reusable browser behavior from
  `migration-sources/dezoomify-web` and extension integration from
  `migration-sources/dezoomify-extension`.
