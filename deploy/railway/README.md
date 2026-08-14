# Running the enclave stack on Railway

Moving the backend off a laptop and a quick tunnel onto a stable host. The
point is not uptime for its own sake — it is that **the proxy's public URL is
written on-chain when the enclave registers**, so a URL that changes silently
unregisters your machine. A fixed hostname ends that entire class of failure.

Three services, and one transaction at the end.

---

## Why three

| Service | What it does | Public? |
|---|---|---|
| `redis` | the proxy's action queue | no |
| `ext-proxy` | fronts the enclave; serves `/info` and action results | **yes, port 6664** |
| `extension-tee` | the enclave itself — holds the book, matches, signs | no |

`extension-tee` reaches the proxy over Railway's private network. Only the
proxy is exposed, because two things outside need it: your frontend, and
Flare's availability check.

---

## 1 · Redis

Railway's Redis template. Nothing to configure. Note its internal host —
something like `redis.railway.internal:6379`.

## 2 · ext-proxy

New service from this repo.

- **Dockerfile path:** `deploy/railway/proxy.Dockerfile`
- **Root directory:** repository root (the Dockerfile copies the entrypoint from
  `deploy/railway/`)
- **Public port:** `6664`

Variables:

```
REDIS_URL_HOST    = redis.railway.internal:6379
INDEXER_HOST      = 34.38.42.208
INDEXER_USER      = <shared hackathon indexer user>
INDEXER_PASSWORD  = <shared hackathon indexer password>
PROXY_PRIVATE_KEY = <the value from your .env>
CHAIN_ID          = 114
```

The config is rendered at startup from these rather than committed, because two
of them are credentials. `deploy/railway/proxy-entrypoint.sh` is the whole of
that logic and it is worth reading before you trust it.

**Use Flare's shared indexer, not your own.** A self-hosted indexer on a public
RPC drifts behind the chain head, and registration then fails in a way that
looks like a Flare outage. See `docs/field-notes.md` note 1.

Once it is up, `https://<proxy>.up.railway.app/info` should return JSON with a
`teeInfo` block. If it does not, nothing below will work.

## 3 · extension-tee

New service from this repo.

- **Dockerfile path:** `go/Dockerfile`
- **Root directory:** repository root
- **No public port** — it only talks to the proxy.

Variables:

```
EXTENSION_ID       = 0x00000000000000000000000000000000000000000000000000000000000102ca
INSTRUCTION_SENDER = 0xA290b54398a0D8C0EbD719Ec33846b69Cf913094
CHAIN_ID           = 114
CHAIN_URL          = https://coston2-api.flare.network/ext/C/rpc
INITIAL_OWNER      = <your deployer address>
GOVERNANCE_SIGNERS = <same deployer address>
GOVERNANCE_THRESHOLD = 1
PROXY_URL          = http://ext-proxy.railway.internal:6663
SIMULATED_TEE      = true
MODE               = 1
CONFIG_PORT        = 5501
SIGN_PORT          = 7701
EXTENSION_PORT     = 7702
LOG_LEVEL          = INFO
```

`SIMULATED_TEE=true` because Railway is not a Confidential Space host. The
registration flow and the architecture are unchanged; the hardware attestation
is not real, and the submission says so rather than implying otherwise.

---

## 4 · Register this enclave, once

A new container is a new machine identity, and its URL has to be the Railway
one. From your laptop, with `EXT_PROXY_URL` pointed at Railway:

```bash
# .env
EXT_PROXY_URL=https://<proxy>.up.railway.app

# wait for the proxy's signing policy to reach the current reward epoch
curl -s "$EXT_PROXY_URL/info" | jq .teeInfo.lastSigningPolicyId
cast call 0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52 \
  "getCurrentRewardEpochId()(uint32)" --rpc-url "$CHAIN_URL"

rm -f config/register-tee.state
./scripts/post-build.sh --chain coston2
```

Then tell the venue to accept it — only the owner can:

```bash
cd tools && go run ./cmd/query-tee -ext 66250 \
  -reg 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE      # read the new tee id

cast send 0xA290b54398a0D8C0EbD719Ec33846b69Cf913094 \
  "addTee(address)" <new-tee-id> \
  --rpc-url "$CHAIN_URL" --private-key "$DEPLOYMENT_PRIVATE_KEY" --gas-limit 200000
```

**Retire the old machine**, or the venue's random fan-out will keep picking a
box that no longer answers and batches will hang with no error:

```bash
cast send 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "pause(address)" <old-tee-id> \
  --rpc-url "$CHAIN_URL" --private-key "$DEPLOYMENT_PRIVATE_KEY" --gas-limit 400000
```

Confirm only the live one remains:

```bash
cd tools && go run ./cmd/query-tee -ext 66250 -reg 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE
```

## 5 · Verify end to end

```bash
cd tools && go run ./cmd/run-test \
  -instructionSender 0xA290b54398a0D8C0EbD719Ec33846b69Cf913094 \
  -base "$BASE_TOKEN" -quote "$QUOTE_TOKEN" -traderB "$TRADER_B_SELLER_KEY"
```

`All tests passed` means instructions are being delivered and settlement
verifies. Anything else, check `query-tee` first — a stale registered URL is
the usual cause and it presents as silence rather than an error.

## 6 · Point the frontend at it

In Vercel:

```
EXT_PROXY_URL       = https://<proxy>.up.railway.app
RELAYER_PRIVATE_KEY = <testnet key that pays FDC request fees>
```

Server-side only. No `NEXT_PUBLIC_` prefix on either — `RELAYER_PRIVATE_KEY`
signs transactions and must never reach the browser bundle.

---

## What this does and does not fix

**Fixed:** the URL stops changing, so the enclave stays registered and
instructions keep arriving. `./scripts/resync-tunnel.sh --check` becomes
something you run out of habit rather than necessity.

**Not fixed:** the attestation is still simulated, and there is still one
enclave. A second Railway `extension-tee` service, registered the same way and
added with `addTee`, plus `setSignatureThreshold(2)`, is what makes the quorum
real — and the contract already supports it.
