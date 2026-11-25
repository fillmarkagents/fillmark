#!/usr/bin/env bash
# Packs the server and installs the tarball into an empty project from the npm registry, as
# `npx @fillmark/mcp` would: the tarball holds only the expected files, the bin runs, and with no
# configuration it stops with the setup message.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/check-release.mjs
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
npm pack --pack-destination "$WORK" --silent >/dev/null
TGZ=$(ls "$WORK"/fillmark-mcp-*.tgz)
tar -tzf "$TGZ" | sed 's#^package/##' | sort > "$WORK/files"
grep -qx npm-shrinkwrap.json "$WORK/files" || { echo "STOP: npm-shrinkwrap.json is not in the tarball" >&2; exit 1; }
if grep -vE '^(dist/.*\.(js|d\.ts)|README\.md|LICENSE|package\.json|npm-shrinkwrap\.json)$' "$WORK/files"; then
  echo "STOP: unexpected files in the tarball" >&2
  exit 1
fi
mkdir "$WORK/app" && cd "$WORK/app"
printf '{ "name": "app", "private": true }\n' > package.json
npm install --no-audit --no-fund --silent "$TGZ" >/dev/null
head -1 node_modules/@fillmark/mcp/dist/index.js | grep -qx '#!/usr/bin/env node'
if out=$(env -u FILLMARK_AGENT_ID ./node_modules/.bin/fillmark-mcp </dev/null 2>&1); then
  echo "STOP: the server started without FILLMARK_AGENT_ID" >&2
  exit 1
fi
grep -q "set FILLMARK_AGENT_ID" <<<"$out"
echo "PACK OK ($(wc -l < "$WORK/files") files)"
