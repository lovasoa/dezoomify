#!/usr/bin/env bash
# Run the wasm conformance suite in a real browser via wasm-pack.
#
# Finds a Chromium binary (Playwright cache or PATH), obtains a matching
# chromedriver (Chrome for Testing) if one is not already available, and
# runs `wasm-pack test --headless --chrome` plus the Node runner.
#
# Usage: ./scripts/browser-test.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CRATE="$REPO_ROOT/crates/dezoomify-wasm"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || true)}"
if [ -z "$CHROME" ]; then
  CHROME="$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1 || true)"
fi
[ -n "$CHROME" ] || { echo "no Chromium found (set CHROME=/path/to/chrome)"; exit 1; }
CHROME_VERSION="$("$CHROME" --version | grep -oE '[0-9]+\.' | head -1 | tr -d '.')"
echo "chrome: $CHROME ($("$CHROME" --version))"

CHROMEDRIVER="${CHROMEDRIVER:-$(command -v chromedriver || true)}"
if [ -n "$CHROMEDRIVER" ]; then
  DRIVER_VERSION="$("$CHROMEDRIVER" --version | grep -oE '[0-9]+\.' | head -1 | tr -d '.')"
  [ "$DRIVER_VERSION" = "$CHROME_VERSION" ] || CHROMEDRIVER=""
fi
if [ -z "$CHROMEDRIVER" ]; then
  echo "fetching matching chromedriver $CHROME_VERSION ..."
  latest="$(curl -fsSL "https://googlechromelabs.github.io/chrome-for-testing/LATEST_RELEASE_$CHROME_VERSION")"
  curl -fsSL -o "$TMP/chromedriver.zip" \
    "https://storage.googleapis.com/chrome-for-testing-public/$latest/linux64/chromedriver-linux64.zip"
  unzip -oq "$TMP/chromedriver.zip" -d "$TMP"
  CHROMEDRIVER="$(find "$TMP" -name chromedriver -type f | head -1)"
  chmod +x "$CHROMEDRIVER"
fi
echo "chromedriver: $CHROMEDRIVER"

cat > "$CRATE/webdriver.json" <<EOF
{
  "alwaysMatch": {
    "goog:chromeOptions": {
      "binary": "$CHROME",
      "args": ["--no-sandbox", "--disable-dev-shm-usage"]
    }
  }
}
EOF

cd "$CRATE"
# Browser leg: wasm-pack pins its own (possibly mismatched) chromedriver, so
# drive wasm-bindgen-test-runner directly with the matching driver.
cargo build --tests --target wasm32-unknown-unknown
RUNNER="$(command -v wasm-bindgen-test-runner)"
for wasm in target/wasm32-unknown-unknown/debug/deps/wasm_pack_browser-*.wasm \
            ../../target/wasm32-unknown-unknown/debug/deps/wasm_pack_browser-*.wasm; do
  [ -e "$wasm" ] || continue
  CHROMEDRIVER="$CHROMEDRIVER" WASM_BINDGEN_TEST_ONLY_WEB=1 "$RUNNER" "$wasm"
done
# Node leg goes through wasm-pack proper.
wasm-pack test --node .
rm -f "$CRATE/webdriver.json"
echo "wasm-pack browser + node conformance: ok"
