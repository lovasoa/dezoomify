# Phase 00: Program Rules and Gates

## Objective

Establish the migration's immutable inputs, architectural boundaries, command
conventions, evidence format, phase gates, and safe-worktree rules before any
production code is moved. Make later agents stop on ambiguity instead of
silently changing compatibility behavior.

## Non-Goals

- Do not copy or refactor application code.
- Do not create the new Rust crates, JavaScript packages, website, desktop app,
  or extension.
- Do not decide parity outcomes; phase 02 owns the behavior inventory.
- Do not remove, format, regenerate, or install dependencies inside
  `migration-sources/`.
- Do not claim any `cargo xtask` command exists. Phase 03 creates the root Cargo
  workspace, `crates/xtask`, `crates/fixture-server`, and fixture commands.

## Dependencies and Preconditions

- Repository root: `/home/ophir/dev/dezoomify-ng`.
- `git`, a Rust toolchain compatible with edition 2024, Node.js, and npm are
  available for inspection. Installing/pinning versions is a separately
  reviewed phase-00 change.
- The current repository contains all four required Git objects:
  `f7caa07`, `cb13f0b`, `23c4639`, and `d231dd0`.
- Existing worktree changes have been listed with `git status --short` and will
  not be reset, cleaned, stashed, or overwritten.

## Exact Source and Destination Paths

| Purpose | Source path/object | Destination path and phase-00 action |
|---|---|---|
| Program index | `plans/README.md` | Existing; read in place, do not duplicate |
| Web evidence | `migration-sources/dezoomify-web/` at `f7caa07` | Remains read-only in place |
| Rust upstream baseline | Git tree `cb13f0b^{tree}` | Referenced by new `docs/migration/source-lock.json` |
| Rust migration snapshot | `migration-sources/dezoomify-rs/` at `23c4639` | Remains read-only in place |
| Extension evidence | `migration-sources/dezoomify-extension/` at `d231dd0` | Remains read-only in place |
| Repository rules | Source README and source `AGENTS.md` files | Existing `AGENTS.md`; update in place |
| Architecture boundary | Existing architecture and source `AGENTS.md` files | Existing `docs/architecture.md`; update in place |
| Snapshot lock | Four Git objects above | New `docs/migration/source-lock.json` |
| Gate ledger | This plan and `plans/README.md` | New `docs/migration/gates.md` |
| Exceptions | None initially | New `docs/migration/exceptions.md` |
| Validation guide | Existing test documentation and source test docs | Existing `docs/testing.md`; update in place |
| Toolchain policy | Source manifests and CI files | New `rust-toolchain.toml` and `.node-version` only after versions are approved |
| License policy | Source `LICENSE` files and package metadata | Root `LICENSE`, `docs/licensing.md`, and an attribution inventory only after compatibility is reviewed and approved |

Update existing destination documents in place and create only the files marked
new above. Do not mechanically copy an entire source `AGENTS.md`; reconcile
conflicts while retaining the strictest purity and test requirements.

## Command Status

### Available Now

Run from `/home/ophir/dev/dezoomify-ng` unless a command explicitly names a
different working directory.

```sh
git status --short
git cat-file -e f7caa07^{commit}
git cat-file -e cb13f0b^{commit}
git cat-file -e 23c4639^{commit}
git cat-file -e d231dd0^{commit}
git diff --check
```

Source-local test commands are documented in phases 01-03. They are available
now but are not phase-00 gates because dependencies may not yet be installed.

### Added Later; Do Not Run Yet

```sh
# Added in phase 03:
cargo xtask setup
cargo xtask check
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr
cargo xtask parity validate
cargo xtask parity report
cargo xtask test

# Added in phase 04:
cargo xtask test core
cargo xtask test core --purity
cargo xtask test core --parity

# Added in phase 05:
cargo xtask protocol generate
cargo xtask protocol check
cargo xtask protocol generate --check
cargo xtask test protocol

# Added in phase 06:
cargo xtask test job
cargo xtask test job --transcripts

# Added in phase 07:
cargo xtask build wasm
cargo xtask test wasm
cargo xtask test wasm --transcripts
cargo xtask test wasm --browser chrome
```

## Numbered Atomic Steps

1. Capture the starting worktree state.

   Save the exact output of `git status --short` in the phase execution record,
   not in a temporary file under source directories. Mark every pre-existing
   changed path as out of scope. Do not require a globally clean worktree.

   Validation:

   ```sh
   git status --short
   git diff --check
   ```

   Stop if an existing change directly conflicts with a destination path in the
   table above. Ask the owner whether to integrate or defer it.

2. Prove that all required snapshot commits exist before writing policy.

   Use the full SHAs in `source-lock.json`; abbreviated SHAs are only for prose.
   Record commit object IDs and root tree IDs. Record that `cb13f0b` is the Rust
   upstream baseline and `23c4639` is a destination-only follow-up snapshot.

   Validation:

   ```sh
   git cat-file -e f7caa07e1ebd3e7d600075ca54a152cee30d8602^{commit}
   git cat-file -e cb13f0b^{commit}
   git cat-file -e 23c46390c4e3245c278aa3d21145f8b692f19aef^{commit}
   git cat-file -e d231dd0bef310a46604140baa50ef29702aef53e^{commit}
   git rev-parse f7caa07^{tree}
   git rev-parse cb13f0b^{tree}
   git rev-parse 23c4639^{tree}
   git rev-parse d231dd0^{tree}
   ```

3. Create `docs/migration/source-lock.json` as deterministic JSON.

   First verify that `docs/migration` is absent or a directory, then create that
   directory if needed. Do not create a directory beside an existing same-name
   file. Include schema version, source name, canonical historical repository URL,
   full commit SHA, tree SHA, imported prefix, role, and whether the checked-in
   directory must equal that tree. Sort source entries by stable source name and
   JSON keys lexicographically. For Rust, use two entries: `rust-upstream` for
   `cb13f0b` without a checked-in prefix and `rust-destination-snapshot` for
   `23c4639` with `migration-sources/dezoomify-rs`.

   Validation:

   ```sh
   test ! -e docs/migration || test -d docs/migration
   node -e "const fs=require('fs');const p='docs/migration/source-lock.json';const x=JSON.parse(fs.readFileSync(p));if(x.schema_version!==1||x.sources.length!==4)process.exit(1)"
   git diff --check -- docs/migration/source-lock.json
   ```

4. Update the existing `AGENTS.md` with repository-wide ownership and safety rules.

   Require phase-scoped path ownership, no edits under `migration-sources`, no
   destructive Git commands, no legacy removal before phase 14, deterministic
   tests before live tests, and explicit labeling of future commands. State that
   concurrent unrelated changes must be preserved.

   Validation:

   ```sh
   git diff --check -- AGENTS.md
   git diff --exit-code -- migration-sources
   ```

5. Update the boundary section in the existing flat `docs/architecture.md`.

   Define dependency direction as adapters and hosts depending inward on the
   protocol, job engine, and pure core. Define `dezoomify-core` purity as no
   network, filesystem, async runtime, image decoding/encoding, UI, DOM, clock,
   random source, process, or environment access in library code. Permit pure
   parsing/crypto/URL/data libraries and the `log` facade. State that tests may
   invoke tooling without making it a normal dependency.

   Preserve its existing component documentation while making dependency
   direction and forbidden capabilities normative. `docs/architecture.md` is
   the canonical architecture document and remains a flat file. Record the
   hosted-browser transport invariant: direct readable fetch first with browser
   credentials omitted; automatic restricted-proxy fallback only after a
   classified CORS/network failure, only for eligible public non-credential
   resources, and only while the user's proxy opt-out is disabled; visible
   active transport; and no cookies, `Authorization`, browser credentials, or
   user-supplied credential headers sent to or by the proxy. Keep extension
   no-proxy behavior and separately consent-gated extension-to-native cookie
   handoff explicit.

   Validation:

   ```sh
   git diff --check -- docs/architecture.md
   git diff --exit-code -- migration-sources/dezoomify-rs/dezoomify-core
   ```

6. Update the validation policy in the existing flat `docs/testing.md`.

   Define four result classes: deterministic blocking, deterministic
   platform-specific, live diagnostic, and manual release check. Require every
   parity behavior to have at least one deterministic blocking test. Define
   reproducibility requirements: fixed fixture bytes, no public DNS/network,
   stable ordering, explicit seeds, controlled time, and canonical snapshots.
   Require website transport tests to assert direct-before-proxy ordering, no
   proxy before a classified CORS/network failure, automatic eligible fallback,
   proxy opt-out, visible active transport, ineligible credential/private target
   rejection, and credential stripping on both proxy hops. Proxy tests model the
   opt-out rather than an approval transition. Cookie-handoff consent is a
   separate extension-to-native security test.

   Validation:

   ```sh
   git diff --check -- docs/testing.md
   ```

7. Initialize `docs/migration/gates.md` and
   `docs/migration/exceptions.md`.

   Add one gate table row per phase 00-15. An exception record must contain a
   unique ID, affected parity IDs, owner, rationale, user impact, compensating
   test, expiry phase/date, and approval. Empty exception fields are not an
   approval. Mark only phase 00 in progress.

   Validation:

   ```sh
   git diff --check -- docs/migration/gates.md docs/migration/exceptions.md
   ```

8. Pin toolchain policy without guessing versions.

   Read source CI files and lockfiles. Select versions supported by all required
   build tools, record the evidence in the gate ledger, then create
   `rust-toolchain.toml` and `.node-version`. Do not upgrade dependencies in
   source snapshots. If exact compatible versions cannot be established, leave
   these destination files absent and stop for a human decision.

   Validation after versions are approved:

   ```sh
   rustc --version
   cargo --version
   node --version
   npm --version
   git diff --check -- rust-toolchain.toml .node-version
   ```

9. Resolve the repository license before moving source code.

   Inventory the exact license text and SPDX declaration of every imported
   project and every code/fixture dependency that will move into a shared
   destination. Record whether files have different copyright notices or an
   `-or-later` grant. Have a human approve one compatible root license and the
   notice-retention policy; do not infer relicensing permission from a package
   name. Only then add the exact approved `LICENSE`, `docs/licensing.md`, and a
   machine-readable attribution inventory. Preserve narrower per-file notices.

   Validation after approval:

   ```sh
   git show f7caa07:LICENSE >/dev/null
   git show 23c4639:LICENSE >/dev/null
   git show d231dd0:LICENSE >/dev/null
   test -s LICENSE
   git diff --check -- LICENSE docs/licensing.md docs/migration/attribution.json
   ```

10. Perform the phase-00 deterministic workflow test.

   In two independent reads, resolve each locked commit and tree. The values
   must remain byte-identical to `source-lock.json`. This test validates the
   evidence chain, not application behavior.

   Validation:

   ```sh
   git rev-parse f7caa07^{commit} f7caa07^{tree}
   git rev-parse cb13f0b^{commit} cb13f0b^{tree}
   git rev-parse 23c4639^{commit} 23c4639^{tree}
   git rev-parse d231dd0^{commit} d231dd0^{tree}
   node -e "JSON.parse(require('fs').readFileSync('docs/migration/source-lock.json'))"
   git diff --exit-code -- migration-sources
   git diff --check
   ```

11. Close the gate record.

    Record exact commands, results, artifacts, and tool versions. Mark phase 00
    complete only if there are no unapproved exceptions and source directories
    are unchanged.

    Validation:

    ```sh
    git diff --check -- docs/migration/gates.md
    git status --short
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P00-SOURCE-LOCK` | Resolve each full SHA and tree twice | Both resolutions equal the checked-in lock file |
| `P00-SOURCE-READONLY` | Compare worktree source paths before and after phase | No source snapshot content changed |
| `P00-GATE-SHAPE` | Parse lock JSON and inspect gate/exception tables | Four sources and phases 00-15 are represented |
| `P00-LICENSE` | Compare source licenses, root license, and attribution inventory | Every migrated source has a compatible approved grant and retained notice policy |
| `P00-WHITESPACE` | Run path-scoped and repository diff checks | No malformed patch or whitespace error |
| `P00-BROWSER-TRANSPORT-POLICY` | Inspect architecture/testing policy | Direct-first, classified automatic restricted fallback, opt-out, visible transport, credential omission/stripping, extension no-proxy, and separate cookie-handoff consent are explicit |

## Explicit Stop Conditions

- Any required Git object is absent, ambiguous, or does not match the supplied
  full SHA.
- A checked-in migration source differs from its subtree snapshot before this
  phase starts.
- The Rust roles of `cb13f0b` and `23c4639` cannot be represented separately.
- An existing unowned change overlaps a destination file.
- Toolchain versions cannot be supported by both source tests and intended
  targets without an upgrade decision.
- Source license compatibility, fixture redistribution rights, or required
  attribution cannot be established and approved.
- A requested rule would permit I/O or runtime dependencies in
  `dezoomify-core`.
- Anyone requests deleting legacy material before the parity and cutover gates.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Snapshot drift | Lock full commit and tree IDs; verify source prefixes in phase 01. |
| Policy becomes vague | Use measurable SHALL/STOP rules and named gate artifacts. |
| Future command is mistaken for an existing tool | Label every command with the phase that creates it. |
| Incompatible code or fixtures are combined | Approve the common license and attribution inventory before moving any source. |
| Global cleanliness destroys concurrent work | Use path ownership and status capture; never reset or clean. |
| Core purity erodes through convenience dependencies | Define forbidden capabilities now and automate the check in phase 04. |
| Live sites hide fixture gaps | Make live checks diagnostic and deterministic coverage mandatory. |

## Rollback Guidance

Rollback means reverting only phase-owned destination paths to the recorded
phase-start state. Do not run `git reset --hard`, `git clean`, broad
`git checkout`, or restore `migration-sources`. If the phase is uncommitted,
inspect `git diff -- AGENTS.md docs/architecture.md docs/testing.md docs/migration
rust-toolchain.toml .node-version`, then reverse only hunks created by this
phase. If changes were committed, create a normal inverse commit limited to
those paths after checking for later edits. Preserve the source-lock evidence
in a patch or issue before removing a mistaken version.

## Deliverables

- Updated `AGENTS.md`
- Updated `docs/architecture.md`
- `docs/migration/source-lock.json`
- `docs/migration/gates.md`
- `docs/migration/exceptions.md`
- Updated `docs/testing.md`
- Approved `rust-toolchain.toml` and `.node-version`, or a documented stop
- Approved root `LICENSE`, `docs/licensing.md`, and attribution inventory, or a documented stop
- Phase-00 gate record with deterministic evidence

## Completion Checklist

- [ ] All four required commit objects and tree IDs are locked.
- [ ] `cb13f0b` and `23c4639` have distinct documented roles.
- [ ] All migration source paths are unchanged.
- [ ] Core purity and dependency direction are explicit.
- [ ] Deterministic, live, and manual validations are distinguished.
- [ ] Browser transport policy and its deterministic ordering, opt-out,
  visibility, eligibility, and credential-stripping assertions are explicit.
- [ ] Future `cargo xtask` commands are labeled unavailable until their phase.
- [ ] Worktree safety and rollback rules preserve unrelated work.
- [ ] Root licensing and notice retention are approved and mechanically inventoried.
- [ ] Phase 00 deterministic workflow tests pass.
- [ ] No stop condition remains unresolved.
- [ ] `docs/migration/gates.md` marks phase 00 complete with evidence.
