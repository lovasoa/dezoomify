#!/usr/bin/env bash
# Package a store-ready extension zip for the EXISTING listings
# (release/config.toml [extension.*]; never a new store item).
#
# Extension sources are plain JavaScript with JSDoc kept in `.ts` files
# (no TypeScript syntax; unit tests import them as text/javascript).
# Staging rules (least privilege: ship only what the manifest loads):
# - background/ ships ONLY background/index.js as a CLASSIC script in both
#   browsers (Chromium MV3 service worker is declared without type:module;
#   Firefox MV3 event pages do not support modules), so `export` is stripped
#   and the result must parse as a classic script. The entry owns the
#   explicit toolbar action and invokes finite source operations with
#   scripting.executeScript on the clicked tab only (no tab enumeration).
#   background helpers are pure unit-tested libraries, never loaded by the
#   manifest, and never shipped.
# - job/ ships the dedicated extension job tab and its Rust engine worker.
#   vendor/ ships generated shared-ui and browser-runtime mirrors. There is no
#   source-tab content script or fallback page.
# - icons/ ships the declared manifest icons (blue brand set) plus the grey
#   idle set the background swaps out via action.setIcon (grey idle, blue
#   with a badge dot while the job is active).
# - wasm/ artifacts are copied from the repository build output (generated;
#   run `cargo xtask build web` or `cargo xtask build extension` first) and
#   placed at the top-level wasm/; the job tab imports it as ../wasm/.
# - No offscreen document ships (and none is declared): offscreen is
#   Chromium-only and unnecessary for finite source operations.
#
# DEZOOMIFY_TEST_HOST_PERMISSIONS=1 additionally grants loopback host
# permissions in the STAGED manifest only. This is for browser E2E and must
# never be used for store payloads.
#
# Usage: ./package-store.sh <chromium|firefox> <output-zip>
set -euo pipefail

browser="${1:?usage: $0 <chromium|firefox> <output-zip>}"
case "$2" in /*) out_zip="$2" ;; *) out_zip="$PWD/$2" ;; esac
case "$browser" in chromium|firefox) ;; *) echo "unknown browser: $browser"; exit 1 ;; esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
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

# Compile the reviewed entrypoint graph. This is deliberately the only way a
# source module reaches a package: no extension source is renamed, copied, or
# transformed with sed during staging. The build wipes its output directory,
# so the manifest (and every appended test-only entry below) is staged only
# after the graph has been compiled.
node "$REPO_ROOT/apps/extension/scripts/build.mjs" --out "$staging"
cp "$manifest" "$staging/manifest.json"
if [ "${DEZOOMIFY_TEST_DRIVER:-0}" = "1" ]; then
  mkdir -p "$staging/test"
  cp "$REPO_ROOT/apps/extension/src/test/driver.html" "$staging/test/driver.html"
  cat >> "$staging/background/index.js" <<'EOF'

// Test-only extension context entry; never present in store packages.
// Arms the headless-E2E job trigger (the real entry is the toolbar action,
// which headless browsers cannot click) and opens the driver page. The
// compiled entry above is an IIFE with its own scope, so this block reaches
// the extension APIs through the globals only: a reference to bundle
// internals would throw at load and take the service worker down.
globalThis.__DEZOOMIFY_TEST__ = true;
(globalThis.browser ?? globalThis.chrome).runtime.onInstalled.addListener(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  api.tabs.create({ url: api.runtime.getURL("test/driver.html") });
});
EOF
fi

if [ "${DEZOOMIFY_TEST_HOST_PERMISSIONS:-0}" = "1" ]; then
  # DEZOOMIFY_TEST_ORIGIN (E2E-only): exact `scheme://host[:port]` fixture
  # origin, appended so `permissions.contains` matches it exactly. Firefox's
  # matching is strict about ports, so the portless loopback patterns alone
  # do not satisfy a port-specific request there.
  DEZOOMIFY_TEST_ORIGIN="${DEZOOMIFY_TEST_ORIGIN:-}" python3 - "$staging/manifest.json" <<'PY'
import json, os, sys
path = sys.argv[1]
d = json.load(open(path))
# E2E-only variant: headless drivers cannot click browser chrome to grant
# activeTab, so the staged manifest grants loopback hosts directly. Shipped
# code never enumerates tabs, so no `tabs` permission is ever injected.
hosts = ["http://127.0.0.1/*", "http://localhost/*"]
extra = os.environ.get("DEZOOMIFY_TEST_ORIGIN", "")
if extra and (extra.startswith("http://") or extra.startswith("https://")) and len(extra) <= 256:
    hosts.append(extra + "/*")
d["host_permissions"] = hosts
json.dump(d, open(path, "w"), indent=2)
print("staged manifest: loopback host permissions injected (E2E only, no tabs)")
PY
fi

# The compiled classic entries must parse before packaging.
node --check "$staging/background/index.js" || { echo "syntax error: background/index.js"; exit 1; }

(cd "$staging" && python3 -c '
import json, os, sys
d = json.load(open("manifest.json"))
need = list(d.get("icons", {}).values())
need += list(d.get("action", {}).get("default_icon", {}).values())
bg = d.get("background", {})
need += ([bg["service_worker"]] if "service_worker" in bg else []) + bg.get("scripts", [])
need += ["job/job.html", "job/index.js", "job/worker.js", "vendor/theme.css", "wasm/dezoomify-wasm.js", "wasm/dezoomify-wasm_bg.wasm"]
if os.path.exists("test/driver.html"):
    need += ["test/driver.html"]
for war in d.get("web_accessible_resources", []):
    need += war.get("resources", [])
missing = [p for p in need if not os.path.exists(p)]
sys.exit(f"missing in package: {missing}") if missing else print(f"package contents: ok ({len(need)} referenced files present)")
# Least-privilege ship guard: fail on dead/never-loaded files.
import glob
shipped = set(glob.glob("background/*.js") + glob.glob("vendor/*.js") + glob.glob("content/**/*.js", recursive=True) + glob.glob("job/*.js", recursive=True))
allowed = {"background/index.js", "job/index.js", "job/worker.js", "vendor/theme.css"}
extra = shipped - allowed
sys.exit(f"dead files shipped (never loaded by manifest/page): {sorted(extra)}") if extra else print("package contents: no dead files")
') || exit 1

rm -f "$out_zip"
(cd "$staging" && zip -qr "$out_zip" manifest.json icons background job vendor wasm ${DEZOOMIFY_TEST_DRIVER:+test})
echo "package: $name v$version ($browser) -> $out_zip"
