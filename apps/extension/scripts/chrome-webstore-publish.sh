#!/usr/bin/env bash
# Chrome Web Store publish helper for the Dezoomify NG extension.
#
# This script UPDATES the existing store listing
# (release/config.toml [extension.chromium]: iapjjopjejpelnfdonefbffahmcndfbm).
# Never create a new store item. The extension ID is public and defaults to
# the reviewed release config; CHROME_WS_EXTENSION_ID overrides it only in an
# emergency.
#
# Secrets policy: the OAuth client JSON stays OUTSIDE the repo at
#   ~/.config/dezoomify-ng/secrets/chrome-webstore-oauth-client.json (mode 600)
# and the refresh token comes from the environment (local `.env`,
# never committed). This script never prints secret values: no `set -x`, values
# travel only in curl POST bodies or shell variables, and `check` reports field
# presence — never field contents.
#
# Usage:
#   ./chrome-webstore-publish.sh check                 verify wiring, no secrets shown
#   ./chrome-webstore-publish.sh authorize              one-time OAuth consent -> refresh token
#   ./chrome-webstore-publish.sh upload <store.zip>     upload a draft to the EXISTING listing
#   ./chrome-webstore-publish.sh publish <store.zip>    upload + publish to testers
set -euo pipefail

# Repo root (this script lives at apps/extension/scripts/).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Extension ID override (emergency only); empty means "read release/config.toml".
ENV_EXTENSION_ID="${CHROME_WS_EXTENSION_ID:-}"

CLIENT_JSON="${CHROME_WS_CLIENT_JSON:-$HOME/.config/dezoomify-ng/secrets/chrome-webstore-oauth-client.json}"
TOKEN_URL="https://oauth2.googleapis.com/token"
# Binary uploads go to the /upload/ media endpoint; publish stays on items/.
UPLOAD_API="https://www.googleapis.com/upload/chromewebstore/v1.1/items"
STORE_API="https://www.googleapis.com/chromewebstore/v1.1/items"

# Print one field from the OAuth client JSON (stdout carries only that value).
client_field() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d.get("installed",d.get("web",{})); print(c.get(sys.argv[2],""))' \
    "$CLIENT_JSON" "$1"
}

# Extension ID for the EXISTING listing: emergency env override wins,
# otherwise the reviewed release config is the single source of truth.
# Prints the id on stdout; fails if it is missing or malformed.
extension_id() {
  if [ -n "$ENV_EXTENSION_ID" ]; then
    printf '%s' "$ENV_EXTENSION_ID"
    return 0
  fi
  python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb"))["extension"]["chromium"]["id"])' \
    "$REPO_ROOT/release/config.toml"
}

# Verify the resolved extension ID has the Chromium shape (32 lowercase
# letters) and matches release/config.toml unless explicitly overridden.
cmd_check() {
  command -v curl >/dev/null || { echo "missing: curl"; return 1; }
  command -v python3 >/dev/null || { echo "missing: python3"; return 1; }
  id="$(extension_id)" || { echo "cannot resolve extension ID from release/config.toml"; return 1; }
  case "$id" in
    [a-z]*)
      if [ "${#id}" -ne 32 ] || printf '%s' "$id" | grep -q '[^a-z]'; then
        echo "bad extension ID shape: ${#id} chars (want 32 lowercase letters)"; return 1;
      fi ;;
    *) echo "bad extension ID shape: $id"; return 1 ;;
  esac
  if [ -n "$ENV_EXTENSION_ID" ]; then
    cfg="$(python3 -c 'import sys,tomllib; print(tomllib.load(open(sys.argv[1],"rb"))["extension"]["chromium"]["id"])' "$REPO_ROOT/release/config.toml")"
    [ "$id" = "$cfg" ] || echo "warn: CHROME_WS_EXTENSION_ID overrides release/config.toml ($cfg)"
  fi
  [ -f "$CLIENT_JSON" ] || { echo "missing client JSON at $CLIENT_JSON"; return 1; }
  perms="$(stat -c %a "$CLIENT_JSON")"
  [ "$perms" = "600" ] || echo "warn: $CLIENT_JSON has mode $perms (run: chmod 600)"
  shape="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d.get("installed",d.get("web",{})); m=[k for k in ("client_id","client_secret") if not c.get(k)]; print("shape-ok" if not m else "missing:"+",".join(m))' "$CLIENT_JSON")"
  [ "$shape" = "shape-ok" ] || { echo "bad client JSON: $shape"; return 1; }
  echo "check: ok (client JSON present, mode $perms, shape-ok; existing listing $id; refresh token comes from env)"
}

cmd_authorize() {
  # Loopback flow (Google retired the oob flow for new clients: oob yields
  # Error 400 invalid_request). Any 127.0.0.1 port is accepted without
  # pre-registration; the same redirect_uri must be used at exchange time.
  port="${CHROME_WS_LOOPBACK_PORT:-8085}"
  redirect="http://127.0.0.1:${port}/"
  client_id="$(client_field client_id)"
  [ -n "$client_id" ] || { echo "client JSON lacks client_id"; return 1; }
  echo "1. Open this consent URL in your browser (the Google account that owns the existing listing iapjjopjejpelnfdonefbffahmcndfbm):"
  echo "   https://accounts.google.com/o/oauth2/auth?client_id=${client_id}&redirect_uri=$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$redirect")&scope=https://www.googleapis.com/auth/chromewebstore&response_type=code&access_type=offline&prompt=consent"
  echo "   (If Google warns the app is unverified, Advanced -> continue: consent by the owner account is allowed.)"
  echo "2. After Allow, your browser lands on $redirect"
  echo "   If nothing listens there, copy the code= value from the address bar."
  code_file="$(mktemp)"
  python3 - "$port" "$code_file" <<'EOF' &
import http.server, sys, urllib.parse
port, dest = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "code" in q:
            open(dest, "w").write(q["code"][0])
        self.send_response(200); self.end_headers()
        self.wfile.write(b"Code received. You can close this tab and return to the terminal.")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).handle_request()
EOF
  server_pid=$!
  printf '3. Paste the authorization code (empty if the local listener captured it): '
  read -r code
  wait "$server_pid" 2>/dev/null || true
  if [ -z "$code" ] && [ -s "$code_file" ]; then code="$(cat "$code_file")"; fi
  rm -f "$code_file"
  [ -n "$code" ] || { echo "no code received"; return 1; }
  client_secret="$(client_field client_secret)"
  resp="$(curl -sS --fail --proto '=https' --max-time 30 -X POST "$TOKEN_URL" \
    -d "code=${code}" \
    -d "client_id=${client_id}" \
    -d "client_secret=${client_secret}" \
    -d "redirect_uri=${redirect}" \
    -d "grant_type=authorization_code")"
  unset client_secret code
  refresh="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refresh_token",""))')"
  unset resp
  [ -n "$refresh" ] || { echo "exchange failed (no refresh_token returned)"; return 1; }
  echo "3. Store this refresh token in your LOCAL .env only (mode 600), never in git:"
  echo "   CHROME_WS_REFRESH_TOKEN=${refresh}"
  unset refresh
}

access_token() {
  client_id="$(client_field client_id)"
  client_secret="$(client_field client_secret)"
  resp="$(curl -sS --fail --proto '=https' --max-time 30 -X POST "$TOKEN_URL" \
    -d "client_id=${client_id}" \
    -d "client_secret=${client_secret}" \
    -d "refresh_token=${CHROME_WS_REFRESH_TOKEN:?set CHROME_WS_REFRESH_TOKEN}" \
    -d "grant_type=refresh_token")"
  unset client_id client_secret
  token="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')"
  unset resp
  [ -n "$token" ] || { echo "token refresh failed"; return 1; }
  printf '%s' "$token"
}

cmd_upload() {
  zip="$1"
  [ -f "$zip" ] || { echo "missing zip: $zip"; return 1; }
  id="$(extension_id)"
  token="$(access_token)"
  curl -sS --fail --proto '=https' --max-time 120 \
    -H "Authorization: Bearer ${token}" -H "x-goog-api-version: 2" -X PUT \
    -T "$zip" "${UPLOAD_API}/${id}" | python3 -c 'import json,sys; print("upload:", json.load(sys.stdin).get("uploadState","unknown"))'
  unset token
}

cmd_publish() {
  cmd_upload "$1"
  id="$(extension_id)"
  token="$(access_token)"
  curl -sS --fail --proto '=https' --max-time 120 \
    -H "Authorization: Bearer ${token}" -H "x-goog-api-version: 2" -X POST \
    "${STORE_API}/${id}/publish?deployPercentage=100" | python3 -c 'import json,sys; print("publish:", json.load(sys.stdin).get("status","unknown"))'
  unset token
}

case "${1:-check}" in
  check) cmd_check ;;
  authorize) cmd_authorize ;;
  upload) cmd_upload "${2:?usage: $0 upload <store.zip>}" ;;
  publish) cmd_publish "${2:?usage: $0 publish <store.zip>}" ;;
  *) echo "usage: $0 <check|authorize|upload <zip>|publish <zip>>"; exit 1 ;;
esac
