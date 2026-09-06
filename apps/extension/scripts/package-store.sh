#!/usr/bin/env bash
# Package a store-ready extension zip for the EXISTING listings
# (release/config.toml [extension.*]; never a new store item).
#
# Extension sources are plain JavaScript with JSDoc kept in `.ts` files
# (no TypeScript syntax; unit tests import them as text/javascript).
# Staging rules:
# - background/ and content/ are loaded as CLASSIC scripts in both browsers
#   (Chromium MV3 service worker is declared without type:module; Firefox MV3
#   event pages do not support modules), so `export` is stripped and the
#   result must parse as a classic script.
# - page/ ships verbatim as ES modules (the page is a module document; it
#   imports the wasm glue).
# - wasm/ artifacts are copied from the repository build output (generated;
#   run `cargo xtask build web` or `cargo xtask build extension` first).
#
# DEZOOMIFY_TEST_HOST_PERMISSIONS=1 additionally grants loopback host
# permissions in the STAGED manifest only. This is for the headless E2E
# (which cannot click browser chrome to grant activeTab) and must never be
# used for store payloads.
#
# Usage: ./package-store.sh <chromium|firefox> <output-zip>
set -euo pipefail

browser="${1:?usage: $0 <chromium|firefox> <output-zip>}"
case "$2" in /*) out_zip="$2" ;; *) out_zip="$PWD/$2" ;; esac
case "$browser" in chromium|firefox) ;; *) echo "unknown browser: $browser"; exit 1 ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$REPO_ROOT/apps/extension/src"
WASM="$REPO_ROOT/wasm"
manifest="$REPO_ROOT/apps/extension/generated/manifest.$browser.json"
test -f "$manifest" || { echo "missing $manifest"; exit 1; }

command -v node >/dev/null || { echo "missing: node"; exit 1; }
command -v python3 >/dev/null || { echo "missing: python3"; exit 1; }
command -v zip >/dev/null || { echo "missing: zip"; exit 1; }

for f in "$WASM/dezoomify-wasm.js" "$WASM/dezoomify-wasm_bg.wasm"; do
  test -f "$f" || { echo "missing $f (wasm glue; run: cargo xtask build web)"; exit 1; }
done

version=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d.get("manifest_version"); print(d["version"])' "$manifest")
name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name",""))' "$manifest")

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
cp "$manifest" "$staging/manifest.json"

# background/ and content/ must parse as classic scripts: strip `export`.
strip_exports() {
  sed -E 's/^export[[:space:]]+//' "$1"
}

stage_classic_dir() {
  local dir="$1"
  test -d "$SRC/$dir" || { echo "missing $SRC/$dir"; exit 1; }
  mkdir -p "$staging/$dir"
  for f in "$SRC/$dir"/*; do
    base="$(basename "$f")"
    case "$base" in
      *.ts) strip_exports "$f" > "$staging/$dir/${base%.ts}.js" ;;
      *) cp "$f" "$staging/$dir/$base" ;;
    esac
  done
}

stage_module_dir() {
  local dir="$1"
  test -d "$SRC/$dir" || { echo "missing $SRC/$dir"; exit 1; }
  mkdir -p "$staging/$dir"
  for f in "$SRC/$dir"/*; do
    base="$(basename "$f")"
    case "$base" in
      *.ts) cp "$f" "$staging/$dir/${base%.ts}.js" ;;
      *) cp "$f" "$staging/$dir/$base" ;;
    esac
  done
}

stage_classic_dir background
stage_classic_dir content
stage_module_dir page

mkdir -p "$staging/wasm"
cp "$WASM/dezoomify-wasm.js" "$WASM/dezoomify-wasm_bg.wasm" "$staging/wasm/"

if [ "${DEZOOMIFY_TEST_HOST_PERMISSIONS:-0}" = "1" ]; then
  python3 - "$staging/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
# E2E-only variant: headless drivers cannot click browser chrome to grant
# activeTab, so the staged manifest grants loopback hosts directly plus the
# tabs permission (needed to show tab URLs in the page's tab list).
d["host_permissions"] = ["http://127.0.0.1/*", "http://localhost/*"]
if "tabs" not in d["permissions"]:
    d["permissions"].append("tabs")
json.dump(d, open(path, "w"), indent=2)
print("staged manifest: loopback host permissions + tabs injected (E2E only)")
PY
fi

# Every staged .js in classic contexts must parse as a CLASSIC script.
while IFS= read -r js; do node --check "$js" || { echo "syntax error: $js"; exit 1; }; done \
  < <(find "$staging/background" "$staging/content" -name '*.js')

(cd "$staging" && python3 -c '
import json, os, sys
d = json.load(open("manifest.json"))
need = list(d.get("icons", {}).values())
bg = d.get("background", {})
need += ([bg["service_worker"]] if "service_worker" in bg else []) + bg.get("scripts", [])
need += ["page/page.html", "page/page.js", "wasm/dezoomify-wasm.js", "wasm/dezoomify-wasm_bg.wasm"]
missing = [p for p in need if not os.path.exists(p)]
sys.exit(f"missing in package: {missing}") if missing else print(f"package contents: ok ({len(need)} referenced files present)")
') || exit 1

rm -f "$out_zip"
(cd "$staging" && zip -qr "$out_zip" manifest.json icons background page content wasm)
echo "package: $name v$version ($browser) -> $out_zip"
