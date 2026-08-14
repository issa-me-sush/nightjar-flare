#!/bin/sh
# Render the proxy config from environment, then run the proxy.
#
# The proxy reads a TOML file, but two of the values in it are credentials for
# Flare's shared indexer. Baking those into an image or committing them to a
# repo is the wrong place for them, so the file is written at startup from
# Railway's variables and never exists anywhere else.
#
# Required:
#   REDIS_URL_HOST   host:port of the Redis service   e.g. redis.railway.internal:6379
#   INDEXER_HOST     Flare C-chain indexer host
#   INDEXER_USER     indexer username
#   INDEXER_PASSWORD indexer password
#   PROXY_PRIVATE_KEY  read by the proxy itself, not written here
#
# Optional, with Coston2 defaults:
#   CHAIN_ID, INDEXER_PORT, INDEXER_DB, PORT_INTERNAL, PORT_EXTERNAL
set -eu

: "${REDIS_URL_HOST:?set REDIS_URL_HOST, e.g. redis.railway.internal:6379}"
: "${INDEXER_HOST:?set INDEXER_HOST}"
: "${INDEXER_USER:?set INDEXER_USER}"
: "${INDEXER_PASSWORD:?set INDEXER_PASSWORD}"

CHAIN_ID="${CHAIN_ID:-114}"
INDEXER_PORT="${INDEXER_PORT:-3306}"
INDEXER_DB="${INDEXER_DB:-indexer}"
PORT_INTERNAL="${PORT_INTERNAL:-6663}"
PORT_EXTERNAL="${PORT_EXTERNAL:-6664}"

# offset 2 on Coston2 — the proxy starts a couple of signing policies back so it
# has history to verify against rather than only the current one.
cat > /app/config/config.toml <<EOF
redis_port = "${REDIS_URL_HOST}"
private_key_variable = "PROXY_PRIVATE_KEY"
initial_signing_policy_offset = ${SIGNING_POLICY_OFFSET:-2}
signing_policy_fetch_interval = "20s"

chain_id = ${CHAIN_ID}

[db]
host = "${INDEXER_HOST}"
port = ${INDEXER_PORT}
database = "${INDEXER_DB}"
username = "${INDEXER_USER}"
password = "${INDEXER_PASSWORD}"
log_queries = false

[addresses]
flare_systems_manager = "${FLARE_SYSTEMS_MANAGER:-0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52}"
relay = "${RELAY_ADDRESS:-0xa10B672D1c62e5457b17af63d4302add6A99d7dE}"
voter_registry = "${VOTER_REGISTRY:-0x6a0AF07b7972177B176d3D422555cbc98DfDe914}"

[ports]
internal = "${PORT_INTERNAL}"
external = "${PORT_EXTERNAL}"

[info_timing]
cycle_internal = "10s"
cycle_queue_response_wait = "2s"

[voting]
proposal_expiration = "12s"
max_pending_request = 10000
EOF

echo "proxy config rendered — chain ${CHAIN_ID}, redis ${REDIS_URL_HOST}, indexer ${INDEXER_HOST}"
exec ./main
