#!/usr/bin/env bash
set -euo pipefail
cargo xtask build desktop 2>&1 | tee bundle.log
DEB="$(ls -t target/release/bundle/deb/*.deb | head -n 1)"
sudo dpkg -i "$DEB" || { sudo apt-get install -f -y; sudo dpkg -i "$DEB"; }
PKG="$(dpkg-deb -f "$DEB" Package)"
BIN="$(dpkg -L "$PKG" | grep -m1 '/dezoomify-desktop$')"
code=0
xvfb-run -a timeout 20 "$BIN" >bundle-launch.log 2>&1 || code=$?
test "$code" -eq 124
