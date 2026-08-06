#!/usr/bin/env bash
# One-shot release. Run it, enter your 2FA code when asked.
#
#   ./publish.sh
#
# Publishes fixui, retires the two renamed packages, then proves the result
# works by installing it from the registry into a throwaway project.
set -euo pipefail

cd "$(dirname "$0")/packages/fixui"

echo "→ publishing fixui@$(node -p "require('./package.json').version")"
pnpm publish

echo
echo "→ retiring the renamed packages (a 404 here is fine — it means it was never published)"
npm deprecate "@hulbu/fixui@0.0.1" "Renamed. Use: npm i fixui" || true
npm deprecate "fixui-bridge@0.0.1" "Renamed. Use: npm i fixui" || true

echo
echo "→ verifying from the registry, in a clean directory"
tmp="$(mktemp -d)"
cd "$tmp" && npm init -y >/dev/null
npx --yes fixui@latest init

echo
echo "✓ published and verified — https://www.npmjs.com/package/fixui"
echo "  scratch project left at $tmp if you want to look"
