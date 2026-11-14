- Keep application behavior outside tooling. Own cleanup of every child process,
  temporary profile, server, and integration registration the task starts.
- Treat unknown tasks, targets, lanes, and flags as usage errors. Verification
  must be read-only; generation must be explicit. Deterministic tasks must not
  contact public source sites.
- Test argument rejection, failure propagation, cleanup, and deterministic output.
  Keep command vocabulary in CLI help and dependency policy in manifests/setup.
