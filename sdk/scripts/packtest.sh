#!/usr/bin/env bash
# Packs the SDK and installs the tarball into an empty project, as a user would: the ESM import
# must load, the types must check, and the tarball must hold only dist/, README.md, LICENSE and
# package.json.
set -euo pipefail
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
npm pack --pack-destination "$WORK" --silent >/dev/null
TGZ=$(ls "$WORK"/fillmark-sdk-*.tgz)
tar -tzf "$TGZ" | sed 's#^package/##' | sort > "$WORK/files"
if grep -vE '^(dist/.*\.(js|d\.ts)|README\.md|LICENSE|package\.json)$' "$WORK/files"; then
  echo "STOP: unexpected files in the tarball" >&2
  exit 1
fi
mkdir "$WORK/app"
cd "$WORK/app"
printf '{ "name": "app", "private": true, "type": "module" }\n' > package.json
VIEM=$(node -p 'require("'"$OLDPWD"'/package.json").devDependencies.viem')
npm install --no-audit --no-fund --silent "$TGZ" "viem@$VIEM" typescript@5.9.3 >/dev/null
cat > check.ts <<'EOF'
import { createPublicClient, http } from "viem";
import { robinhood } from "viem/chains";
import { ADDRESSES, ASSETS, fillmarkAgent, type Quote } from "@fillmark/sdk";
const agent = fillmarkAgent({ publicClient: createPublicClient({ chain: robinhood, transport: http() }), agentId: 1n });
const q: Quote = { ok: false, reason: "TooSmall", message: "" };
export const out = [agent.agentId, ADDRESSES.router, ASSETS.length, q.ok];
EOF
npx tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck false check.ts
node --input-type=module -e 'import { ASSETS, ADDRESSES, fillmarkAgent } from "@fillmark/sdk"; if (ASSETS.length < 28 || typeof fillmarkAgent !== "function" || !ADDRESSES.router) process.exit(1); console.log("import OK")'
echo "PACK OK ($(wc -l < "$WORK/files") files)"
