#!/usr/bin/env bash
# Make the venue accept whichever enclave is actually running.
#
# A container restart mints a new machine identity, and the venue only accepts
# signatures from identities it has been told about. When those drift apart the
# symptom is silence: batches hang, the enclave logs look healthy, and nothing
# reports an error. This closes that gap.
#
#   ./scripts/heal-enclave.sh --check     # report only, exit 1 if drifted
#   ./scripts/heal-enclave.sh             # repair
#
# Repairing needs Flare's FTDC availability check to be working. When it is not
# — it returns 404 for the instruction and never produces a proof — this exits
# cleanly and says so, so it is safe to run on a timer until the service comes
# back.
set -euo pipefail

cd "$(dirname "$0")/.."
CHECK_ONLY=false
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=true

# shellcheck disable=SC1091
set -a; source .env; source config/extension.env; set +a

VENUE="${INSTRUCTION_SENDER:?INSTRUCTION_SENDER not set in config/extension.env}"
RPC="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
MACHINE_REGISTRY="${TEE_MACHINE_REGISTRY:-0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE}"
EXT_DEC=$(( EXTENSION_ID ))

say() { printf '\033[0;36m[heal]\033[0m %s\n' "$*"; }
ok()  { printf '\033[0;32m[heal]\033[0m %s\n' "$*"; }
bad() { printf '\033[0;31m[heal]\033[0m %s\n' "$*" >&2; }

# --- who is actually running? -------------------------------------------------
# The machine's address is the keccak of its uncompressed public key, which the
# proxy publishes. Deriving it here avoids trusting any local state file.
info=$(curl -sf -m 20 "$EXT_PROXY_URL/info" || true)
if [[ -z "$info" ]]; then
  bad "proxy at $EXT_PROXY_URL is not answering — nothing to do until it is"
  exit 1
fi

pub=$(printf '%s' "$info" | python3 -c \
  "import json,sys;d=json.load(sys.stdin)['teeInfo']['publicKey'];print(d['x'][2:]+d['y'][2:])")
running="0x$(cast keccak "0x$pub" | tail -c 41)"

accepted=$(cast call "$VENUE" "isTee(address)(bool)" "$running" --rpc-url "$RPC")

say "running enclave : $running"
say "venue accepts it: $accepted"

if [[ "$accepted" == "true" ]]; then
  ok "in sync — nothing to do"
  exit 0
fi

if [[ "$CHECK_ONLY" == "true" ]]; then
  bad "DRIFTED — the venue does not accept the running enclave, so batches will hang"
  bad "run without --check to repair"
  exit 1
fi

# --- repair -------------------------------------------------------------------
say "registering $running with the machine registry…"
rm -f config/register-tee.state

if ! ./scripts/post-build.sh --chain coston2 2>&1 | tail -40; then
  bad "registration failed."
  bad "If it ended on a 404 from GetFTDCAvailabilityCheckResult, that is Flare's"
  bad "FTDC failing to produce the availability proof, not anything here. Both"
  bad "of their proxies can be up and in sync and still not answer. Re-run this"
  bad "later; it is idempotent."
  exit 1
fi

say "telling the venue to accept it…"
cast send "$VENUE" "addTee(address)" "$running" \
  --rpc-url "$RPC" --private-key "$DEPLOYMENT_PRIVATE_KEY" --gas-limit 200000 >/dev/null

# Retire every other active machine on this extension. Instructions are fanned
# out at random, so one stale entry means a share of batches quietly go nowhere.
say "retiring stale machines…"
others=$(cd tools && go run ./cmd/query-tee -ext "$EXT_DEC" -reg "$MACHINE_REGISTRY" 2>/dev/null \
  | grep -oE '0x[0-9a-fA-F]{40}' | grep -iv "$running" || true)

for old in $others; do
  say "  pausing $old"
  cast send "$MACHINE_REGISTRY" "pause(address)" "$old" \
    --rpc-url "$RPC" --private-key "$DEPLOYMENT_PRIVATE_KEY" --gas-limit 400000 >/dev/null || true
done

ok "repaired. $running is registered and accepted."
say "confirm with a real batch:"
say "  cd tools && go run ./cmd/run-test -instructionSender $VENUE \\"
say "    -base \$BASE_TOKEN -quote \$QUOTE_TOKEN -traderB \$TRADER_B_SELLER_KEY"
