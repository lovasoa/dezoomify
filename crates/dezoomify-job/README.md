# dezoomify-job

Runs one download end-to-end as a deterministic state machine: discovery,
selection, scheduling, retries, cancellation, and progress. Hosts (browser,
native) inject fetch/save capabilities; the machine itself does no I/O, so
workflows replay identically everywhere, including in tests.

```sh
cargo xtask test job                 # workflows + adversarial cases
cargo xtask test job --transcripts   # recorded event transcripts
```
