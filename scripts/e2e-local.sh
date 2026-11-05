#!/usr/bin/env bash
# Local end-to-end run: fresh local D1, `wrangler dev`, the admin CLI, then scripts/smoke.mjs. No Cloudflare account needed.
set -euo pipefail
cd "$(dirname "$0")/.."
if curl -s -o /dev/null http://127.0.0.1:8787/; then echo "port 8787 is busy (an old wrangler dev?)"; exit 1; fi
STATE=$(mktemp -d)
ADMIN=$(openssl rand -hex 24); SECRET=$(openssl rand -hex 16)
cat > "$STATE/vars" <<VARS
ADMIN_KEY=$ADMIN
TELEGRAM_WEBHOOK_SECRET=$SECRET
OWNER_TELEGRAM_ID=4242
TELEGRAM_API_BASE=http://127.0.0.1:8788
TG_TOKEN_MUSE=MUSE-SMOKE-TOKEN
TELEGRAM_HUB_TOKEN=HUB-SMOKE-TOKEN
VARS
npx wrangler d1 execute oh-my-bot --local --persist-to "$STATE" --file schema.sql >/dev/null
set -m # the dev server gets its own process group, so the trap stops wrangler and workerd together
npx wrangler dev --local --port 8787 --persist-to "$STATE" --env-file "$STATE/vars" >"$STATE/dev.log" 2>&1 &
DEV=$!
set +m
cleanup() { rc=$?; kill -- -"$DEV" 2>/dev/null || true; sleep 1; kill -9 -- -"$DEV" 2>/dev/null || true; rm -rf "$STATE"; exit $rc; }
trap cleanup EXIT
for _ in $(seq 60); do curl -sf http://127.0.0.1:8787/ >/dev/null && break; sleep 1; done
export OMB_URL=http://127.0.0.1:8787 OMB_ADMIN_KEY=$ADMIN
node scripts/omb.mjs apply oh-my-bot.config.example.json
node scripts/omb.mjs list
TELEGRAM_WEBHOOK_SECRET=$SECRET OWNER_TELEGRAM_ID=4242 node scripts/smoke.mjs
