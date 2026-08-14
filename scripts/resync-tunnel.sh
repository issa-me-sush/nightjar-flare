#!/usr/bin/env bash
#
# Recover from a rotated Cloudflare quick tunnel.
#
# A quick tunnel gets a new hostname every time it restarts. That hostname is
# written on-chain when the TEE machine registers, and there is no update path
# on the registry — so once it rotates, the machine's registered URL points at
# nothing and two things break at once:
#
#   * the FTDC availability check 404s forever (it probes the registered URL)
#   * instructions stop being delivered, while the enclave keeps polling and
#     its logs look completely healthy
#
# The second one is the dangerous one: nothing looks broken until a batch
# hangs. This script detects the drift and repairs it end to end.
#
#   ./scripts/resync-tunnel.sh --chain coston2            # check, repair if needed
#   ./scripts/resync-tunnel.sh --chain coston2 --check    # report only
#
# Repair means a NEW machine identity, because the URL cannot be rewritten:
# restart extension-tee, re-register, then add the new signer to the venue.
# The venue address and extension id are unchanged, so nothing downstream of
# this script needs repointing.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

CHAIN="coston2"
CHECK_ONLY=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --chain) CHAIN="$2"; shift 2 ;;
        --check) CHECK_ONLY=true; shift ;;
        *) echo "unknown flag: $1" >&2; exit 2 ;;
    esac
done

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
info()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
die()   { red "resync-tunnel: $*"; exit 1; }

[[ -f .env ]] || die ".env not found"
set -a; source .env; source config/extension.env; set +a

REGISTRY="${TEE_MANAGER:-0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE}"
EXT_DEC=$((EXTENSION_ID))

# ── 1. what the tunnel is actually serving right now ──────────────────────
info "== Reading the live tunnel =="
LIVE_URL=$(docker compose -f docker-compose.cloudflared.yaml logs cloudflared 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true)
[[ -n "$LIVE_URL" ]] || die "no trycloudflare URL in cloudflared logs — is the tunnel up?"
echo "  tunnel now:      $LIVE_URL"
echo "  .env says:       ${EXT_PROXY_URL:-<unset>}"

curl -sf -m 10 "$LIVE_URL/info" >/dev/null 2>&1 \
    || die "tunnel is up but $LIVE_URL/info does not answer — check ext-proxy"

# ── 2. what the chain thinks the machine's URL is ─────────────────────────
info "== Reading the registered machine URL from chain =="
REGISTERED=$(cd tools && go run ./cmd/query-tee -ext "$EXT_DEC" -reg "$REGISTRY" 2>/dev/null \
    | grep -oE 'url="[^"]*"' | head -1 | sed 's/url="//;s/"//' || true)
echo "  on-chain url:    ${REGISTERED:-<none registered>}"

if [[ "$REGISTERED" == "$LIVE_URL" ]]; then
    green "In sync — the registered URL matches the live tunnel. Nothing to do."
    # .env can still drift even when the chain is fine.
    if [[ "${EXT_PROXY_URL:-}" != "$LIVE_URL" ]]; then
        red  "  ...but .env is stale. Fixing the local files only."
        "$PROJECT_DIR/scripts/lib/write-proxy-url.sh" "$LIVE_URL" 2>/dev/null || {
            sed -i '' "s|^EXT_PROXY_URL=.*|EXT_PROXY_URL=$LIVE_URL|" .env
            [[ -f frontend/.env.local ]] && sed -i '' "s|^EXT_PROXY_URL=.*|EXT_PROXY_URL=$LIVE_URL|" frontend/.env.local
        }
        green "  .env and frontend/.env.local updated."
    fi
    exit 0
fi

red "DRIFT: the chain has a URL that is no longer served."
echo "  Instructions are not reaching the enclave, even though it looks healthy."

if $CHECK_ONLY; then
    echo
    echo "  Re-run without --check to repair."
    exit 1
fi

# ── 3. local files first ──────────────────────────────────────────────────
info "== Updating local config =="
sed -i '' "s|^EXT_PROXY_URL=.*|EXT_PROXY_URL=$LIVE_URL|" .env
[[ -f frontend/.env.local ]] && sed -i '' "s|^EXT_PROXY_URL=.*|EXT_PROXY_URL=$LIVE_URL|" frontend/.env.local
green "  .env and frontend/.env.local point at $LIVE_URL"
export EXT_PROXY_URL="$LIVE_URL"

# ── 4. new machine identity ───────────────────────────────────────────────
# The registry has no setUrl, and post-build.sh will not re-register a machine
# it considers already registered — so the only way to write a fresh URL is a
# fresh teeId. Restarting extension-tee mints one.
info "== Minting a new machine identity =="
set -a; source config/extension.env; set +a
docker compose -f docker-compose.yaml -f "docker-compose.$CHAIN.yaml" \
    up -d --force-recreate --no-build extension-tee >/dev/null 2>&1 \
    || die "could not restart extension-tee"
docker restart nightjar-ext-proxy-1 >/dev/null 2>&1 || true   # /info is cached
green "  extension-tee recreated, proxy restarted"

info "== Waiting for the enclave to come back =="
for _ in $(seq 1 60); do
    curl -sf -m 8 "$LIVE_URL/info" >/dev/null 2>&1 && break
    sleep 5
done
curl -sf -m 8 "$LIVE_URL/info" >/dev/null 2>&1 || die "enclave did not come back"
green "  serving"

info "== Registering =="
rm -f config/register-tee.state
./scripts/post-build.sh --chain "$CHAIN" || die "registration failed — see docs/field-notes.md note 1"

# /info does not carry the machine address; the registry does.
NEW_TEE=$(cd tools && go run ./cmd/query-tee -ext "$EXT_DEC" -reg "$REGISTRY" 2>/dev/null \
    | grep -oE '0x[0-9a-fA-F]{40}' | head -1 || true)

echo
green "Re-registered on $LIVE_URL"
echo
echo "  One manual step left, because only the venue owner can do it:"
echo
echo "    cast send $INSTRUCTION_SENDER \"addTee(address)\" ${NEW_TEE:-<new-tee-address>} \\"
echo "      --rpc-url \$CHAIN_URL --private-key \$DEPLOYMENT_PRIVATE_KEY --gas-limit 200000"
echo
echo "  Then re-run the E2E to confirm instructions are flowing again:"
echo "    cd tools && go run ./cmd/run-test -instructionSender $INSTRUCTION_SENDER \\"
echo "      -base \$BASE_TOKEN -quote \$QUOTE_TOKEN -traderB \$TRADER_B_SELLER_KEY"
