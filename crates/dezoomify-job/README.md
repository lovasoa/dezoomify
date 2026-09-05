# dezoomify-job (Phase 06 lean scope)

Deterministic state machine for one job: discovery-by-length, fixed
`img:0`/`lvl:0` selection, fixed `tile:0`/`tile:1` plan, retries,
cancellation, and progress. Hosts inject fetch/save capabilities; the machine
itself does no I/O, so workflows replay identically everywhere, including in
tests. Full format-aware planning via `dezoomify-core` is future work.

```sh
cargo xtask test job                 # workflows + adversarial cases
cargo xtask test job --transcripts   # recorded event transcripts
```
