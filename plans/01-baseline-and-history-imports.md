# Phase 01: Baseline and History Imports

## Objective

Prove that the complete source histories are reachable from the unified
repository, that each checked-in `migration-sources` prefix exactly matches its
locked snapshot, and that the Rust upstream baseline and destination-only
snapshot are distinguishable. Preserve historical authorship and commit
identity without replaying imports that already exist.

## Non-Goals

- Do not re-run a subtree import that is already present.
- Do not squash, rebase, filter, rewrite, or garbage-collect imported history.
- Do not copy source code into final workspace paths.
- Do not resolve Rust parity deltas; classify them in phase 02 and adopt them in
  phase 04.
- Do not add remotes merely for convenience after all required objects have
  been proven present.
- Do not run or claim any `cargo xtask` command.

## Dependencies and Preconditions

- Phase 00 is complete and `docs/migration/source-lock.json` parses.
- The phase-start `git status --short` is recorded.
- The unified repository currently contains subtree merge commits for web,
  Rust, and extension imports. This must be verified, not assumed.
- Network access is not required for the normal path. Fetching is a recovery
  path requiring human approval and a canonical remote URL.

## Exact Source and Destination Paths

| Source identity | Source tree | Checked-in destination/evidence |
|---|---|---|
| Web snapshot | `f7caa07^{tree}` | `migration-sources/dezoomify-web/` |
| Rust upstream baseline | `cb13f0b^{tree}` | Git object only; no checked-in prefix is allowed to masquerade as this tree |
| Rust destination snapshot | `23c4639^{tree}` | `migration-sources/dezoomify-rs/` |
| Extension snapshot | `d231dd0^{tree}` | `migration-sources/dezoomify-extension/` |
| Import metadata report | Subtree merge commits and source commits | `docs/migration/history-imports.md` |
| Machine lock | `docs/migration/source-lock.json` | Update tree IDs/import commit IDs in place |
| Gate evidence | Commands in this plan | Phase 01 row in `docs/migration/gates.md` |

Expected existing subtree merge commits are:

| Prefix | Import commit | Required second parent |
|---|---:|---:|
| `migration-sources/dezoomify-web` | `04df950ad8c6a2a06a5e2dde49c4344ab70aa37f` | `f7caa07e1ebd3e7d600075ca54a152cee30d8602` |
| `migration-sources/dezoomify-rs` | `857043513d3c4f2ecda3de85386fbea1b9245bd0` | `23c46390c4e3245c278aa3d21145f8b692f19aef` |
| `migration-sources/dezoomify-extension` | `a539c0d83cc4b2eb5f185cd960e0095eb222972c` | `d231dd0bef310a46604140baa50ef29702aef53e` |

## Command Status

### Available Now

```sh
git show --no-patch --pretty=raw 04df950
git show --no-patch --pretty=raw 8570435
git show --no-patch --pretty=raw a539c0d
git diff --quiet f7caa07 HEAD:migration-sources/dezoomify-web
git diff --quiet 23c4639 HEAD:migration-sources/dezoomify-rs
git diff --quiet d231dd0 HEAD:migration-sources/dezoomify-extension
git log --oneline --decorate --all
```

`git diff --quiet <tree> HEAD:<prefix>` compares Git tree objects and returns
zero on exact equality. It does not alter the worktree.

### Added Later; Do Not Run Yet

```sh
# Added in phase 03:
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask parity validate
```

## Numbered Atomic Steps

1. Record the phase-start state and current `HEAD`.

   Record but do not clean unrelated changes. Confirm phase-00-owned files are
   present. All writes in this phase are restricted to
   `docs/migration/history-imports.md`, `docs/migration/source-lock.json`, and
   the phase 01 gate row.

   Validation:

   ```sh
   git status --short
   git rev-parse HEAD
   node -e "JSON.parse(require('fs').readFileSync('docs/migration/source-lock.json'))"
   ```

2. Verify web import ancestry and subtree metadata.

   Confirm `04df950` has exactly the unified mainline parent and `f7caa07` as
   its source parent. Confirm its commit message contains
   `git-subtree-dir: migration-sources/dezoomify-web` and
   `git-subtree-split: f7caa07...`.

   Validation:

   ```sh
   git cat-file -e f7caa07e1ebd3e7d600075ca54a152cee30d8602^{commit}
   git show --no-patch --pretty=raw 04df950ad8c6a2a06a5e2dde49c4344ab70aa37f
   git merge-base --is-ancestor f7caa07e1ebd3e7d600075ca54a152cee30d8602 HEAD
   git diff --quiet f7caa07e1ebd3e7d600075ca54a152cee30d8602 HEAD:migration-sources/dezoomify-web
   ```

3. Verify Rust import ancestry and the two Rust reference points.

   Confirm `8570435` has `23c4639` as its source parent and subtree split.
   Independently confirm `cb13f0b` is reachable and is an ancestor of
   `23c4639`. Never label the checked-in Rust prefix as `cb13f0b`; it equals
   `23c4639` and contains destination-only in-progress work.

   Validation:

   ```sh
   git cat-file -e cb13f0b^{commit}
   git cat-file -e 23c46390c4e3245c278aa3d21145f8b692f19aef^{commit}
   git show --no-patch --pretty=raw 857043513d3c4f2ecda3de85386fbea1b9245bd0
   git merge-base --is-ancestor cb13f0b 23c46390c4e3245c278aa3d21145f8b692f19aef
   git merge-base --is-ancestor 23c46390c4e3245c278aa3d21145f8b692f19aef HEAD
   git diff --quiet 23c46390c4e3245c278aa3d21145f8b692f19aef HEAD:migration-sources/dezoomify-rs
   ```

4. Verify extension import ancestry and subtree metadata.

   Confirm `a539c0d` has `d231dd0` as its source parent and correct subtree
   trailers.

   Validation:

   ```sh
   git cat-file -e d231dd0bef310a46604140baa50ef29702aef53e^{commit}
   git show --no-patch --pretty=raw a539c0d83cc4b2eb5f185cd960e0095eb222972c
   git merge-base --is-ancestor d231dd0bef310a46604140baa50ef29702aef53e HEAD
   git diff --quiet d231dd0bef310a46604140baa50ef29702aef53e HEAD:migration-sources/dezoomify-extension
   ```

5. Inventory reachable history for each source.

   Record the snapshot commit subject, author, committer, parent list, tree ID,
   oldest reachable commit, and commit count. Counts are evidence, not a parity
   target. Use first-parent history only for the unified line and ordinary
   source ancestry for imported source lines.

   Validation:

   ```sh
   git show -s --format=fuller f7caa07
   git show -s --format=fuller cb13f0b
   git show -s --format=fuller 23c4639
   git show -s --format=fuller d231dd0
   git rev-list --count f7caa07
   git rev-list --count cb13f0b
   git rev-list --count 23c4639
   git rev-list --count d231dd0
   ```

6. Create `docs/migration/history-imports.md`.

   Include one section per source with canonical repository URL, snapshot SHA,
   tree SHA, subtree prefix, import commit, import parents, exact verification
   commands, and result. Add a Rust subsection listing every commit and changed
   path in `cb13f0b..23c4639`; label the range "destination-only candidate
   changes, not automatically accepted parity." Do not summarize away file
   names.

   Validation:

   ```sh
   git log --reverse --oneline cb13f0b..23c4639
   git diff --name-status cb13f0b..23c4639
   git diff --check -- docs/migration/history-imports.md
   ```

7. Complete machine-readable lock metadata.

   Add each import commit and verified prefix tree to
   `docs/migration/source-lock.json`. For the Rust baseline, use `null` for
   `import_prefix` and `import_commit`, and retain its tree ID. Do not modify
   schema version or reorder entries non-deterministically.

   Validation:

   ```sh
   node -e "const x=JSON.parse(require('fs').readFileSync('docs/migration/source-lock.json'));for(const s of x.sources){if(!/^[0-9a-f]{40}$/.test(s.commit)||!/^[0-9a-f]{40}$/.test(s.tree))process.exit(1)}"
   git diff --check -- docs/migration/source-lock.json
   ```

8. Handle the recovery path only if an object/import is missing.

   Stop normal execution. Obtain human approval for the canonical URL. Add a
   temporary uniquely named remote, fetch the exact full SHA, and verify its
   object ID before any subtree operation. If the prefix is absent, import with
   a non-squashed `git subtree add --prefix=<exact-prefix> <remote> <full-sha>`.
   If the prefix or merge already exists, do not import again. Record the
   recovery command and remote URL. Remove only the temporary remote after
   verification; removing a remote does not remove history.

   Validation after an approved recovery:

   ```sh
   git cat-file -e <full-approved-sha>^{commit}
   git show -s --format=%H <full-approved-sha>
   git status --short
   ```

9. Run source baseline tests without changing source manifests or lockfiles.

   Run deterministic suites in their source working directories. `npm ci`
   creates ignored dependency directories and must not alter lockfiles. The
   Rust core coverage and architecture tests are deterministic; do not use the
   workspace-wide Rust test command here because source documentation warns
   that some tests access the network.

   Available-now commands, each run separately:

   ```sh
   # workdir: migration-sources/dezoomify-web/tests
   npm ci
   npm test

   # workdir: migration-sources/dezoomify-rs
   cargo test -p dezoomify-core --test dezoomer_coverage
   cargo test -p dezoomify-core --test dependency_architecture

   # workdir: migration-sources/dezoomify-extension
   npm ci
   npm test
   ```

   Validation:

   ```sh
   git diff --exit-code -- migration-sources
   git status --short
   ```

10. Run the phase-01 deterministic import workflow.

    Repeat all three tree comparisons and all four ancestry checks in a fresh
    shell. Results must not depend on installed dependencies or network access.
    Record exit status zero for every command.

    Validation:

    ```sh
    git diff --quiet f7caa07 HEAD:migration-sources/dezoomify-web
    git diff --quiet 23c4639 HEAD:migration-sources/dezoomify-rs
    git diff --quiet d231dd0 HEAD:migration-sources/dezoomify-extension
    git merge-base --is-ancestor cb13f0b 23c4639
    git diff --exit-code -- migration-sources
    git diff --check
    ```

11. Close the phase gate.

    Record source test pass/fail separately from history proof. A test failure
    does not authorize changing the source snapshot; capture it as baseline
    evidence and stop before phase 02 unless explicitly triaged.

    Validation:

    ```sh
    git diff --check -- docs/migration/gates.md docs/migration/history-imports.md
    git status --short
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P01-WEB-TREE` | Compare `f7caa07` tree to web prefix | No path/content difference |
| `P01-RUST-TREE` | Compare `23c4639` tree to Rust prefix | No path/content difference |
| `P01-EXT-TREE` | Compare `d231dd0` tree to extension prefix | No path/content difference |
| `P01-RUST-LINEAGE` | Test ancestry `cb13f0b -> 23c4639 -> unified HEAD` | Both ancestry checks return zero |
| `P01-SUBTREE-PARENTS` | Inspect three import merge commits | Locked snapshot is the source parent and trailers match prefix |
| `P01-LEGACY-TESTS` | Run the three deterministic source suites | Results are recorded without source modifications |

## Explicit Stop Conditions

- A source prefix differs from its locked source tree.
- An expected import commit lacks the source commit as a parent or has an
  incorrect subtree prefix/split trailer.
- `cb13f0b` is not an ancestor of `23c4639`.
- Any required history object is missing and no canonical recovery URL is
  approved.
- Source tests modify tracked source files or lockfiles.
- A baseline deterministic test fails without a documented triage decision.
- Re-importing would duplicate a source prefix or rewrite existing history.
- Unrelated work overlaps this phase's three destination documents.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Squashed imports lose attribution | Verify non-squashed merge parents and source ancestry. |
| Rust in-progress work is mistaken for baseline | Lock `cb13f0b` and `23c4639` as separate roles and audit their range. |
| Re-running subtree add duplicates files/history | Detect exact existing import and make normal path verification-only. |
| Dependency install dirties snapshots | Verify path diff afterward; never commit generated source artifacts. |
| Missing object triggers an untrusted fetch | Require canonical URL and human approval for recovery. |
| Test failure causes source repair | Record immutable baseline failure; fixes happen only in destination phases. |

## Rollback Guidance

Normal execution writes documentation only. Reverse only this phase's hunks in
`docs/migration/history-imports.md`, `docs/migration/source-lock.json`, and the
phase 01 gate row. Never delete imported commits, rewrite parents, remove source
prefixes, or run repository-wide reset/clean. If an approved temporary remote
was added, remove only that named remote after recording its URL. If an
accidental duplicate subtree import was committed, stop and have a human choose
a normal revert commit; do not rewrite shared history.

## Deliverables

- `docs/migration/history-imports.md` with exact ancestry evidence
- Updated `docs/migration/source-lock.json` with import metadata
- Complete `cb13f0b..23c4639` changed-path inventory
- Recorded deterministic baseline results for web, Rust core, and extension
- Phase-01 gate record

## Completion Checklist

- [ ] Web prefix equals `f7caa07` exactly.
- [ ] Rust prefix equals destination-only snapshot `23c4639` exactly.
- [ ] Extension prefix equals `d231dd0` exactly.
- [ ] `cb13f0b` remains separately identified as Rust upstream baseline.
- [ ] All source commits and histories are reachable from unified `HEAD`.
- [ ] No subtree import was unnecessarily replayed.
- [ ] Deterministic source tests and their tool versions are recorded.
- [ ] No tracked file under `migration-sources` changed.
- [ ] No stop condition remains unresolved.
- [ ] Phase 01 is marked complete in the gate ledger.
