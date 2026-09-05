#!/usr/bin/env bash
# Package a store-ready extension zip for the EXISTING listings
# (release/config.toml [extension.*]; never a new store item).
#
# Extension sources are plain JavaScript with JSDoc kept in `.ts` files
# (no TypeScript syntax; unit tests import them as text/javascript).
# This script stages the package-root layout the manifest references:
# manifest.json, icons/, and background/app/content modules copied from
# `.ts` to `.js`, syntax-checked with `node --check`, then zipped.
#
# Usage: ./package-store.sh <chromium|firefox> <output-zip>
set -euo pipefail

browser="${1:?usage: $0 <chromium|firefox> <output-zip>}"
case "$2" in /*) out_zip="$2" ;; *) out_zip="$PWD/$2" ;; esac
case "$browser" in chromium|firefox) ;; *) echo "unknown browser: $browser"; exit 1 ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$REPO_ROOT/apps/extension/src"
manifest="$REPO_ROOT/apps/extension/generated/manifest.$browser.json"
test -f "$manifest" || { echo "missing $manifest"; exit 1; }

command -v node >/dev/null || { echo "missing: node"; exit 1; }
command -v python3 >/dev/null || { echo "missing: python3"; exit 1; }
command -v zip >/dev/null || { echo "missing: zip"; exit 1; }

version=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("manifest_version"); print(d["version"])' "$manifest")
name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name",""))' "$manifest")

staging="$(mktemp -d)"
cp "$manifest" "$staging/manifest.json"
for d in icons background app content; do
  test -d "$SRC/$d" || { echo "missing $SRC/$d"; rm -rf "$staging"; exit 1; }
  mkdir -p "$staging/$d"
  for f in "$SRC/$d"/*; do
    base="$(basename "$f")"
    case "$base" in
      *.ts)
        dest="$staging/$d/${base%.ts}.js"
        test -e "$dest" && { echo "collision: $dest"; rm -rf "$staging"; exit 1; }
        cp "$f" "$dest" ;;
      *) cp "$f" "$staging/$d/$base" ;;
    esac
  done
done

# Every staged .js must parse; then every manifest-referenced file must exist.
while IFS= read -r js; do node --check "$js" || { echo "syntax error: $js"; rm -rf "$staging"; exit 1; }; done \
  < <(find "$staging/background" "$staging/app" "$staging/content" -name '*.js')
(cd "$staging" && python3 -c '
import json, os, sys
d = json.load(open("manifest.json"))
need = list(d.get("icons", {}).values())
bg = d.get("background", {})
need += ([bg["service_worker"]] if "service_worker" in bg else []) + bg.get("scripts", [])
missing = [p for p in need if not os.path.exists(p)]
sys.exit(f"missing in package: {missing}") if missing else print(f"package contents: ok ({len(need)} referenced files present)")
') || { rm -rf "$staging"; exit 1; }

rm -f "$out_zip"
(cd "$staging" && zip -qr "$out_zip" manifest.json icons background app content)
rm -rf "$staging"
echo "package: $name v$version ($browser) -> $out_zip"
