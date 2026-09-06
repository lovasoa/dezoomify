# dezoomify-job

Deterministic state machine for one job: format-aware discovery through
`dezoomify-core`, real catalog projection, explicit image/level selection
over real ids, real per-level tile plans (probe-driven levels through the
core probe step machine when `plan_probes` allows), retries, cancellation,
and progress. Hosts inject fetch/save capabilities; the machine itself does
no I/O, so workflows replay identically everywhere, including in tests.

```sh
cargo xtask test job                 # workflows + adversarial cases
cargo xtask test job --transcripts   # recorded event transcripts
```
