# Operations

Health: `cargo xtask ci postcutover-snapshot --state fixtures`. Validation:
`cargo xtask ci postcutover-validation --matrix current-current,current-n-1,n-1-current`.
Rollback: `docs/rollback-runbook.md`. On-call verifies asset digests before
interpreting results; source URLs never enter monitoring.
