# Licensing

## Root license

The unified dezoomify-ng tree is conveyed under **GPL-3.0-or-later**. The
exact license text is the root `LICENSE` file (byte-identical to the GPL-3.0
text shipped by the imported Rust and extension sources). All newly authored
destination code is GPL-3.0-or-later unless a file carries a narrower notice,
which is preserved.

## Imported source grants

The three legacy projects that this tree derives from are preserved in Git
history at the recorded commits (their working trees were removed after the
rewrite completed):

| Source | License evidence | Grant |
|---|---|---|
| `dezoomify-web` at `f7caa07` | `LICENSE` is the GPL version 2 text; project `README.md` ("GPL" section) states "either version 2 of the License, or (at your option) any later version" | GPL-2.0-or-later |
| `dezoomify-rs` at `23c4639` | `LICENSE` is the GPL version 3 text; no per-file or-later statement found | GPL-3.0-only (conservative) |
| `dezoomify-extension` at `d231dd0` | `LICENSE` is the GPL version 3 text; `package.json` declares `GPL-3.0-or-later` | GPL-3.0-or-later |

## Compatibility

GPL-2.0-or-later material may be conveyed under GPL-3.0 terms through its
or-later grant, so curated web fixtures, scenario data derived from web
behavior, and reimplemented (not copied) web logic are compatible with the
GPL-3.0-or-later root. GPL-3.0-only Rust files keep their narrower grant when
copied; they are not upgraded by the root license. No relicensing permission
beyond these grants is inferred: every future copy must retain the source
copyright notice and record provenance in the owning scenario manifest.

## Notice retention

- Keep every source copyright notice (`Copyright © 2011-2017 Lovasoa` for web
  material and equivalents) in copied files and in fixture provenance records.
- Per-file notices narrower than the root license win for that file.
- Fixtures with unclear provenance are blocked from the canonical corpus by
  `cargo xtask fixtures verify`.
