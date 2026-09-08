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
#   background helpers are pure unit-tested libraries, never loaded by the
#   manifest, and never shipped.
# - content/ ships ONLY the injected in-tab modal (content/modal.js as a
#   CLASSIC script with `export` stripped, plus content/modal.css): injected
#   programmatically via scripting on the clicked tab only, never declared
#   via content_scripts.
# - modal/ ships the job iframe document (modal/modal.html + modal/modal.js
#   from modal/modal.ts as an ES module): the extension page mounted by the
#   injected modal in the SAME tab. It reuses the page entry's direct imports
#   plus the vendored shared-ui view graph (theme + renderView geometry,
#   never a visual fork).
# - runtime/ ships the tab-side fetch, candidate, and native-handoff modules
#   imported by the modal job. vendor/ ships generated shared-ui and
#   browser-runtime mirrors. There is no fallback page.
# - icons/ ships the declared manifest icons (blue brand set) plus the grey
#   idle set the background swaps out via action.setIcon (grey idle, blue
#   with a badge dot while monitoring).
# - wasm/ artifacts are copied from the repository build output (generated;
#   run `cargo xtask build web` or `cargo xtask build extension` first) and
#   placed at the top-level wasm/; the modal iframe imports it as ../wasm/.
# - No offscreen document ships (and none is declared): offscreen is
#   Chromium-only and unnecessary for a reload monitor.
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
cp "$manifest" "$staging/manifest.json"

# Compile the reviewed entrypoint graph. This is deliberately the only way a
# source module reaches a package: no extension source is renamed, copied, or
# transformed with sed during staging.
node "$REPO_ROOT/apps/extension/scripts/build.mjs" --out "$staging"
if [ "${DEZOOMIFY_TEST_DRIVER:-0}" = "1" ]; then
  mkdir -p "$staging/test"
  cp "$REPO_ROOT/apps/extension/src/test/driver.html" "$staging/test/driver.html"
  cat >> "$staging/background/index.js" <<'EOF'

// Test-only extension context entry; never present in store packages.
api.runtime.onInstalled.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL("test/driver.html") });
});
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "dezoomify-test-inject" || typeof message.tabId !== "number") return;
  api.scripting.executeScript({ target: { tabId: message.tabId }, files: ["content/modal.js"] })
    .then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error && error.message || error) }));
  return true;
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
node --check "$staging/content/modal.js" || { echo "syntax error: content/modal.js"; exit 1; }

(cd "$staging" && python3 -c '
import json, os, sys
d = json.load(open("manifest.json"))
need = list(d.get("icons", {}).values())
need += list(d.get("action", {}).get("default_icon", {}).values())
bg = d.get("background", {})
need += ([bg["service_worker"]] if "service_worker" in bg else []) + bg.get("scripts", [])
need += ["content/modal.js", "content/modal.css", "job/job.html", "job/index.js", "job/worker.js", "vendor/theme.css", "vendor/view.js", "wasm/dezoomify-wasm.js", "wasm/dezoomify-wasm_bg.wasm"]
if os.path.exists("test/driver.html"):
    need += ["test/driver.html"]
for war in d.get("web_accessible_resources", []):
    need += war.get("resources", [])
missing = [p for p in need if not os.path.exists(p)]
sys.exit(f"missing in package: {missing}") if missing else print(f"package contents: ok ({len(need)} referenced files present)")
# Least-privilege ship guard: fail on dead/never-loaded files.
import glob
shipped = set(glob.glob("background/*.js") + glob.glob("vendor/*.js") + glob.glob("content/**/*.js", recursive=True) + glob.glob("job/*.js", recursive=True))
allowed = {"background/index.js", "content/modal.js", "job/index.js", "job/worker.js", "vendor/theme.css", "vendor/view.js"}
extra = shipped - allowed
sys.exit(f"dead files shipped (never loaded by manifest/page): {sorted(extra)}") if extra else print("package contents: no dead files")
') || exit 1

rm -f "$out_zip"
(cd "$staging" && zip -qr "$out_zip" manifest.json icons background content job vendor wasm ${DEZOOMIFY_TEST_DRIVER:+test})
echo "package: $name v$version ($browser) -> $out_zip"
