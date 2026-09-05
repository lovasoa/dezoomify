#!/usr/bin/env bash
# Chrome Web Store publish helper for the Dezoomify NG extension.
#
# Secrets policy: the OAuth client JSON stays OUTSIDE the repo at
#   ~/.config/dezoomify-ng/secrets/chrome-webstore-oauth-client.json (mode 600)
# and the refresh token / extension ID come from the environment (local `.env`,
# never committed). This script never prints secret values: no `set -x`, values
# travel only in curl POST bodies or shell variables, and `check` reports field
# presence — never field contents.
#
# Usage:
#   ./chrome-webstore-publish.sh check                 verify wiring, no secrets shown
#   ./chrome-webstore-publish.sh authorize              one-time OAuth consent -> refresh token
#   ./chrome-webstore-publish.sh upload <store.zip>     upload a store-ready zip
#   ./chrome-webstore-publish.sh publish <store.zip>    upload + publish to testers
set -euo pipefail

CLIENT_JSON="${CHROME_WS_CLIENT_JSON:-$HOME/.config/dezoomify-ng/secrets/chrome-webstore-oauth-client.json}"
TOKEN_URL="https://oauth2.googleapis.com/token"
STORE_API="https://www.googleapis.com/chromewebstore/v1.1/items"

# Print one field from the OAuth client JSON (stdout carries only that value).
client_field() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d.get("installed",d.get("web",{})); print(c.get(sys.argv[2],""))' \
    "$CLIENT_JSON" "$1"
}

cmd_check() {
  command -v curl >/dev/null || { echo "missing: curl"; return 1; }
  command -v python3 >/dev/null || { echo "missing: python3"; return 1; }
  [ -f "$CLIENT_JSON" ] || { echo "missing client JSON at $CLIENT_JSON"; return 1; }
  perms="$(stat -c %a "$CLIENT_JSON")"
  [ "$perms" = "600" ] || echo "warn: $CLIENT_JSON has mode $perms (run: chmod 600)"
  shape="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); c=d.get("installed",d.get("web",{})); m=[k for k in ("client_id","client_secret") if not c.get(k)]; print("shape-ok" if not m else "missing:"+",".join(m))' "$CLIENT_JSON")"
  [ "$shape" = "shape-ok" ] || { echo "bad client JSON: $shape"; return 1; }
  echo "check: ok (client JSON present, mode $perms, shape-ok; refresh token and extension ID come from env)"
}

cmd_authorize() {
  client_id="$(client_field client_id)"
  [ -n "$client_id" ] || { echo "client JSON lacks client_id"; return 1; }
  echo "1. Open this consent URL in your browser:"
  echo "   https://accounts.google.com/o/oauth2/auth?client_id=${client_id}&redirect_uri=urn:ietf:wg:oauth:2.0:oob&scope=https://www.googleapis.com/auth/chromewebstore&response_type=code&access_type=offline"
  printf '2. Paste the authorization code: '
  read -r code
  client_secret="$(client_field client_secret)"
  resp="$(curl -sS --fail --proto '=https' --max-time 30 -X POST "$TOKEN_URL" \
    -d "code=${code}" \
    -d "client_id=${client_id}" \
    -d "client_secret=${client_secret}" \
    -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob" \
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
  id="${CHROME_WS_EXTENSION_ID:?set CHROME_WS_EXTENSION_ID}"
  token="$(access_token)"
  curl -sS --fail --proto '=https' --max-time 120 \
    -H "Authorization: Bearer ${token}" -X PUT \
    -T "$zip" "${STORE_API}/${id}" | python3 -c 'import json,sys; print("upload:", json.load(sys.stdin).get("uploadState","unknown"))'
  unset token
}

cmd_publish() {
  cmd_upload "$1"
  id="${CHROME_WS_EXTENSION_ID:?set CHROME_WS_EXTENSION_ID}"
  token="$(access_token)"
  curl -sS --fail --proto '=https' --max-time 120 \
    -H "Authorization: Bearer ${token}" -X POST \
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
