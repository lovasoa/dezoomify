#!/usr/bin/env bash
set -euo pipefail
cargo xtask build desktop 2>&1 | tee bundle.log
DMG="$(ls -t target/release/bundle/dmg/*.dmg | head -n 1)"
MNT="/Volumes/DezoomifyCI"
printf 'Y\n' | hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT"
APP_DIR="$(ls -d "$MNT"/*.app | head -n 1)"
cmp target/desktop-dmg/background.png "$MNT/.background/background.png"
test -s "$MNT/.DS_Store"
codesign --verify --deep --strict --verbose=4 "$APP_DIR" 2>&1 | tee signature.log
osascript - "$MNT" <<'APPLESCRIPT'
on run argv
  tell application "Finder"
    open (POSIX file (item 1 of argv) as alias)
    activate
  end tell
end run
APPLESCRIPT
sleep 2
screencapture -x dmg-installation.png
APP_BIN="$APP_DIR/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$APP_DIR/Contents/Info.plist")"
"$APP_BIN" >bundle-launch.log 2>&1 & APP_PID=$!
sleep 15
kill -0 "$APP_PID"
kill "$APP_PID"
wait "$APP_PID" 2>/dev/null || true
hdiutil detach "$MNT"
