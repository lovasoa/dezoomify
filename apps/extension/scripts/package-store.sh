#!/usr/bin/env bash
# Package a store-ready extension zip for the EXISTING listings
# (release/config.toml [extension.*]; never a new store item).
#
# Extension sources are plain JavaScript with JSDoc kept in `.ts` files
# (no TypeScript syntax; unit tests import them as text/javascript).
# Staging rules (least privilege: ship only what the manifest loads or the
# background injects):
# - background/ ships ONLY background/index.js as a CLASSIC script in both
#   browsers (Chromium MV3 service worker is declared without type:module;
#   Firefox MV3 event pages do not support modules), so `export` is stripped
#   and the result must parse as a classic script. The entry is the
#   click-to-monitor owner: the toolbar click arms an indefinite exact-tabId
#   observer, performs a single reload, and on detection injects the in-tab
#   modal on the clicked tab only via scripting (no tab enumeration).
#   background/detect.ts, background/handoff.ts, and background/native.ts are
#   pure unit-tested libraries, never loaded by the manifest, and never
#   shipped.
# - content/ ships ONLY the injected in-tab modal (content/modal.js as a
#   CLASSIC script with `export` stripped, plus content/modal.css): injected
#   programmatically via scripting on the clicked tab only, never declared
#   via content_scripts. src/content/reload-marker.ts stays unit-test only
#   and is never staged.
# - modal/ ships the job iframe document (modal/modal.html + modal/modal.js
#   from modal/modal.ts as an ES module): the extension page mounted by the
#   injected modal in the SAME tab. It reuses the page entry's direct imports
#   plus the vendored shared-ui view graph (theme + renderView geometry,
#   never a visual fork).
# - page/ ships verbatim as ES modules ONLY the files page.js imports
#   (page.html + first-run guide + page/scan/candidates/fetch/nativeHandoff):
#   the page is a module document and imports the wasm glue.
#   page/redaction.ts and app/* are unit-tested helpers, never imported by
#   the page, and never shipped.
# - icons/ ships the declared manifest icons (blue brand set) plus the grey
#   idle set the background swaps out via action.setIcon (grey idle, blue
#   with a badge dot while monitoring).
# - wasm/ artifacts are copied from the repository build output (generated;
#   run `cargo xtask build web` or `cargo xtask build extension` first) and
#   placed at the top-level wasm/ the page and modal iframe import as
#   ../wasm/.
# - No offscreen document ships (and none is declared): offscreen is
#   Chromium-only and unnecessary for a reload monitor.
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

# background/index.js ships as a CLASSIC script (service worker / event page):
# strip `export` so it parses without module syntax.
strip_exports() {
  sed -E 's/^export[[:space:]]+//' "$1"
}

# Ship only the background entry the manifest loads (never handoff/native libs).
mkdir -p "$staging/background"
strip_exports "$SRC/background/index.ts" > "$staging/background/index.js"
# Ship only the injected in-tab modal (classic; exports stripped like the
# background entry). The reload marker stays unit-test only and never ships.
# (Staged by exact file, never by directory copy: src/content/* as a tree
# stays unit-test only.)
CONTENT="$SRC/content"
mkdir -p "$staging/content"
strip_exports "$CONTENT/modal.js" > "$staging/content/modal.js"
cp "$CONTENT/modal.css" "$staging/content/modal.css"
# Ship the job iframe document mounted by the injected modal in the same tab.
mkdir -p "$staging/modal"
cp "$SRC/modal/modal.html" "$staging/modal/modal.html"
cp "$SRC/modal/modal.ts" "$staging/modal/modal.js"
# Ship only the page entry + its direct imports (never redaction/app libs).
mkdir -p "$staging/page"
for f in page.html page.ts scan.ts candidates.ts fetch.ts nativeHandoff.ts; do
  src="$SRC/page/$f"
  test -f "$src" || { echo "missing $src"; exit 1; }
  case "$f" in
    *.ts) cp "$src" "$staging/page/${f%.ts}.js" ;;
    *) cp "$src" "$staging/page/$f" ;;
  esac
done
# Generate the first-run guide from docs/user/browser-extension.md. The
# documentation is the source of truth; the extension ships only its HTML
# rendering.
node "$REPO_ROOT/scripts/build-extension-guide.mjs" "$staging/page/guide.html"
# Screenshots used by the first-run guide.
for f in guide-step-1.png guide-step-2.png guide-step-3.png; do
  src="$SRC/page/$f"
  test -f "$src" || { echo "missing $src"; exit 1; }
  cp "$src" "$staging/page/$f"
done
# Ship the vendored no-bundler mirrors the page imports plus the theme the
# page links (generated by scripts/sync-web-js.mjs, never hand-edited),
# plus the shared-ui view graph the job iframe (modal/modal.js) renders
# through (renderView geometry, never a visual fork).
mkdir -p "$staging/page/vendor"
for f in vendor/limits.js vendor/theme.css vendor/view.js vendor/controller.js vendor/components.js vendor/transport-labels.js vendor/save-name.js; do
  src="$SRC/page/$f"
  test -f "$src" || { echo "missing $src (run: node scripts/sync-web-js.mjs)"; exit 1; }
  cp "$src" "$staging/page/$f"
done
# Ship the declared manifest icons (blue brand set) plus the grey idle set
# the background swaps via action.setIcon (grey idle, blue + badge dot
# while monitoring).
mkdir -p "$staging/icons"
for icon in icon16.png icon48.png icon128.png icon16-grey.png icon48-grey.png icon128-grey.png; do
  test -f "$SRC/icons/$icon" || { echo "missing $SRC/icons/$icon"; exit 1; }
  cp "$SRC/icons/$icon" "$staging/icons/$icon"
done

mkdir -p "$staging/wasm"
cp "$WASM/dezoomify-wasm.js" "$WASM/dezoomify-wasm_bg.wasm" "$staging/wasm/"

if [ "${DEZOOMIFY_TEST_HOST_PERMISSIONS:-0}" = "1" ]; then
  python3 - "$staging/manifest.json" <<'PY'
import json, sys
path = sys.argv[1]
d = json.load(open(path))
# E2E-only variant: headless drivers cannot click browser chrome to grant
# activeTab, so the staged manifest grants loopback hosts directly. Shipped
# code never enumerates tabs (bound `tabs.get` only), so no `tabs`
# permission is ever injected: the harness creates its target via a single
# `tabs.create` returning one id and drives the bound `?tab=` flow.
d["host_permissions"] = ["http://127.0.0.1/*", "http://localhost/*"]
json.dump(d, open(path, "w"), indent=2)
print("staged manifest: loopback host permissions injected (E2E only, no tabs)")
PY
fi

# The shipped background entry and injected loader must parse as CLASSIC scripts.
node --check "$staging/background/index.js" || { echo "syntax error: background/index.js"; exit 1; }
node --check "$staging/content/modal.js" || { echo "syntax error: content/modal.js"; exit 1; }

(cd "$staging" && python3 -c '
import json, os, sys
d = json.load(open("manifest.json"))
need = list(d.get("icons", {}).values())
need += list(d.get("action", {}).get("default_icon", {}).values())
bg = d.get("background", {})
need += ([bg["service_worker"]] if "service_worker" in bg else []) + bg.get("scripts", [])
need += ["page/page.html", "page/page.js", "page/guide.html", "page/guide-step-1.png", "page/guide-step-2.png", "page/guide-step-3.png", "page/vendor/limits.js", "page/vendor/theme.css", "page/vendor/view.js", "page/vendor/controller.js", "page/vendor/components.js", "page/vendor/transport-labels.js", "page/vendor/save-name.js", "content/modal.js", "content/modal.css", "modal/modal.html", "modal/modal.js", "wasm/dezoomify-wasm.js", "wasm/dezoomify-wasm_bg.wasm"]
for war in d.get("web_accessible_resources", []):
    need += war.get("resources", [])
missing = [p for p in need if not os.path.exists(p)]
sys.exit(f"missing in package: {missing}") if missing else print(f"package contents: ok ({len(need)} referenced files present)")
# Least-privilege ship guard: fail on dead/never-loaded files.
import glob
shipped = set(glob.glob("background/*.js") + glob.glob("page/*.js") + glob.glob("page/vendor/*.js") + glob.glob("content/**/*.js", recursive=True) + glob.glob("modal/*.js", recursive=True))
allowed = {"background/index.js", "page/page.js", "page/scan.js", "page/candidates.js", "page/fetch.js", "page/nativeHandoff.js", "page/vendor/limits.js", "page/vendor/view.js", "page/vendor/controller.js", "page/vendor/components.js", "page/vendor/transport-labels.js", "page/vendor/save-name.js", "content/modal.js", "modal/modal.js"}
extra = shipped - allowed
sys.exit(f"dead files shipped (never loaded by manifest/page): {sorted(extra)}") if extra else print("package contents: no dead files")
if os.path.exists("content/reload-marker.js"):
    sys.exit("content/reload-marker.js must not ship (unit tests only)")
') || exit 1

rm -f "$out_zip"
(cd "$staging" && zip -qr "$out_zip" manifest.json icons background content modal page wasm)
echo "package: $name v$version ($browser) -> $out_zip"
