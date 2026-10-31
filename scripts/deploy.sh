#!/usr/bin/env bash
# Builds the static site, deploys the Worker (site + room API) to Cloudflare and
# checks the live result. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID
# (or `wrangler login` on your machine). Optional: DOMAIN_NAME (serves it and its
# www), TURN_KEY_ID and TURN_KEY_API_TOKEN (TURN relay), ATTENDLESS_APTABASE_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
export ATTENDLESS_API_URL=/api
node scripts/build.mjs

args=()
if [[ -n "${DOMAIN_NAME:-}" ]]; then args+=(--domain "$DOMAIN_NAME" --domain "www.$DOMAIN_NAME"); fi
mkdir -p .build
secrets=.build/secrets.json
trap 'rm -f "$secrets"' EXIT
if [[ -n "${TURN_KEY_ID:-}" && -n "${TURN_KEY_API_TOKEN:-}" ]]; then
  # Written by Node from the environment, never echoed; deleted on exit.
  (umask 077 && node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ TURN_KEY_ID: process.env.TURN_KEY_ID, TURN_KEY_API_TOKEN: process.env.TURN_KEY_API_TOKEN }))' "$secrets")
  args+=(--secrets-file "$secrets")
fi

npx wrangler deploy "${args[@]}" | tee .build/deploy.log
if [[ -n "${DOMAIN_NAME:-}" ]]; then SITE_URL="https://$DOMAIN_NAME"
else SITE_URL="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' .build/deploy.log | head -n 1)"; fi
export SITE_URL
node scripts/smoke.mjs
printf 'Attendless deployed: %s\n' "$SITE_URL"
