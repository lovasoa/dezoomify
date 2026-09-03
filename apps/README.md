# Applications

- **Responsibility:** Compose reusable crates and packages into CLI, desktop,
  web, and extension products.
- **Allowed dependencies:** Apps may depend on their host runtime and shared UI;
  no application may depend on another application.
- **Forbidden responsibilities:** Do not duplicate domain, protocol, job, or
  reusable transport logic inside an app.
- **Interfaces and tests:** Each app owns its entry point, configuration, smoke
  tests, packaging, and end-to-end scenarios while shared behavior is tested at
  its lower owning layer.
- **Migration sources:** Product behavior comes from the corresponding roots in
  `migration-sources`; shared behavior must move to crates/packages first.
