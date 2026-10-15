#!/usr/bin/env bash
# Shared by release builds and the manually dispatched PR signing check.
set -euo pipefail

dist="target/release-dist/${DEZOOMIFY_VERSION:?}/desktop-macos-aarch64"
requirement="anchor apple generic and certificate leaf[subject.OU] = \"${APPLE_TEAM_ID:?}\""
identifier="$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").identifier')"
product="$(node -p 'require("./apps/desktop/src-tauri/tauri.conf.json").productName')"

# Tauri signs and notarizes the app before packaging its signed updater archive.
cargo xtask release build --plan "target/release-dist/$DEZOOMIFY_VERSION/plan.json" --target desktop-macos-aarch64
set -- "$dist"/*.dmg
test "$#" -eq 1
dmg="$1"
set -- "$dist"/*.app.tar.gz
test "$#" -eq 1
archive="$1"
xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$dmg"
codesign --verify --strict --verbose=4 -R="$requirement" "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"

mount="$(mktemp -d)"
staging="$(mktemp -d)"
pid=""
cleanup() {
  if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  hdiutil detach "$mount" || true
  rmdir "$mount" || true
  rm -rf "$staging"
}
trap cleanup EXIT
printf 'Y\n' | hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mount"
test -s "$archive.sig"
tar -xzf "$archive" -C "$staging"
mkdir -p target/macos-signing
for source in installer updater; do
  # Exercise the installed copy from both distribution formats.
  app="$mount/$product.app"
  if [ "$source" = updater ]; then app="$staging/$product.app"; fi
  mkdir -p "$staging/installed"
  installed="$staging/installed/$product.app"
  ditto "$app" "$installed"
  codesign --verify --deep --strict --verbose=4 -R="$requirement and identifier \"$identifier\"" "$installed"
  codesign --display --verbose=4 "$installed" 2>&1 | grep -E 'flags=.*\(.*runtime.*\)'
  xcrun stapler validate "$installed"
  spctl --assess --type execute --verbose=4 "$installed"
  executable="$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$installed/Contents/Info.plist")"
  "$installed/Contents/MacOS/$executable" > "target/macos-signing/$source.log" 2>&1 &
  pid=$!
  sleep 15
  kill -0 "$pid"
  kill "$pid"
  wait "$pid" 2>/dev/null || true
  pid=""
  rm -rf "$staging/installed"
done
