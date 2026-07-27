version=$(jq '.version' < package.json)

TMPDIR=$(mktemp -d)
jq '.version |= '"$version"' ' < manifest.json > "$TMPDIR/manifest.json"

rm -f dezoomify.zip
zip -r dezoomify.zip icons/ url-recognition.js background.js manifest.json
zip -r --junk-paths dezoomify.zip "$TMPDIR/manifest.json"
