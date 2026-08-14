# Flare Summer Signal — BUIDL submission

**Nightjar** — a sealed-bid venue for FXRP, matched inside a Flare Confidential
Compute enclave and settled on Flare.

**Targets both bounties:**
- **Bounty 2 — Confidential Compute Apps** (primary)
- **Bounty 1 — Interoperable Asset Products**

| | |
|---|---|
| Repo | <https://github.com/issa-me-sush/nightjar-flare> |
| Live page, no wallet | <https://issa-me-sush.github.io/nightjar-flare/> |
| Network | Flare Coston2 (chain id 114) |
| Venue | [`0xA290b54398a0D8C0EbD719Ec33846b69Cf913094`](https://coston2-explorer.flare.network/address/0xA290b54398a0D8C0EbD719Ec33846b69Cf913094) |
| FCC extension | `66250` (`0x102ca`) |
| Registered enclave | `0x32fcFE8ec942aC617363E123D9ACBDA7aDE8dC70` |
| XRPL gateway | [`0xbc62e861C31Ce6581524b4A6d5518eb3a48eF708`](https://coston2-explorer.flare.network/address/0xbc62e861C31Ce6581524b4A6d5518eb3a48eF708) |
| Base asset | **Real FAssets FXRP** on Coston2 — `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| Tests | 51 Solidity + 26 Go, all passing |

---

## The one-line version

FXRP has 149.6 million tokens outstanding and about $1.23 million of stablecoin
on the other side of the trade. Nightjar is a venue where size can rest without
being seen, because the reason that depth is missing is that showing it is what
costs you. We shipped the counterfactual to show it: an ordinary order book,
the same trade both ways, and the leak is one public view call.

## Short product description

Nightjar is a sealed-bid batch auction for FXRP. You seal an order in your
browser, encrypted to a Flare TEE's public key; the chain stores only the
ciphertext. Inside the enclave, orders rest in memory and clear at a single
uniform price — the price that matches the most volume. The enclave signs a set
of net balance deltas, and the venue contract executes them only after checking
a quorum of enclave signatures, that both assets conserve exactly, and that the
clearing price sits inside a band around Flare's own FTSO XRP/USD feed, re-read
on-chain at settlement.

Orders that do not match are never revealed. Not their side, not their price,
not their size. That is the product: **you can quote real size and keep it.**

There are two ways in. Deposit on Flare, or **pay XRP on the XRP Ledger** — the
payment names the Flare address to credit, Flare's Data Connector attests it,
and `XrplGateway` verifies that proof on-chain before crediting anything. Both
doors lead to the same sealed book.

## The problem — measured, not asserted

Run `cd tools && go run ./cmd/fxrp-depth`. It takes no key, reads **Flare
mainnet**, and prints the contract addresses it read so every line can be
checked independently:

```
supply         149,614,009 FXRP

Where the float sits
  Firelight vault            58,464,556 FXRP  39.07%   yield vault — deposited, not quoted
  Morpho                     31,347,660 FXRP  20.95%   lending collateral
  Kinetic                    20,403,986 FXRP  13.63%   lending collateral
  LayerZero OFT adapter      16,116,081 FXRP  10.77%   bridged off Flare
  four contracts            126,332,285 FXRP  84.43%

What a seller can trade into
  in DEX pools at all         5,950,943 FXRP   3.97% of supply
  stablecoin on the far side  1,230,170        0.82% of supply, across 3 pools
```

- **84% of FXRP is parked, not quoted** — sitting in vaults and lending markets.
- **10.8% has already bridged off Flare** via the LayerZero adapter. The
  sophisticated holders left.
- **Exit depth is 0.82% of the float.** And the two *deepest* FXRP pools are
  FXRP/stXRP — trading FXRP for staked XRP is not an exit, it is the same risk
  rewrapped.

Incentives were tried at scale and the float responded by parking or leaving.
Depth is missing because quoting it publicly is what it costs you — the one
problem a smart contract cannot fix, since on-chain state is public by
construction.

## The leak, demonstrated rather than asserted

A resting order answers questions about itself. The repo ships
`TransparentVenue.sol`, an ordinary on-chain limit order book, so the claim can
be shown rather than stated. The same trade runs
through both venues. On the transparent one the seller calls a public view
function, reads that the buyer will pay up to 1.06, and asks exactly that
instead of the 1.02 he would have accepted.

| | Executed at | She paid |
|---|---|---|
| Transparent book | 1.06 — her own limit | **3.18** |
| Nightjar | 1.02 — the clearing price | **3.06** |

For this pair that is **392 basis points**. Both prices are parameters we chose,
so the magnitude belongs to the example; what generalises is that `getOrder` is
a public view function and the information is free to the counterparty.

Reproduce: `cd tools && go run ./cmd/run-comparison`.

No mempool access, no searcher infrastructure, no bots. One view call.

## What is genuinely new here: the matching rule enables the security model

The obvious confidential venue is a price-time-priority order book inside an
enclave. Flare's own reference implementation is exactly that. It works, and it
permanently limits you to **one** enclave — because price-time priority depends
on arrival order, so two enclaves fed the same orders over a network produce
different matches and sign different settlements. There is nothing for them to
agree on.

A uniform-price batch auction has no such dependency. It consumes a *set* of
orders and returns the volume-maximising price; feed it the same set in any
order and every enclave emits byte-identical bytes. Determinism under reordering
is one of the eleven matching-engine tests, and it is there because it is what
the security model rests on.

So the venue fans instructions to `signatureThreshold` enclaves via
`getRandomTeeIds`, and `settle()` requires **k distinct registered enclaves to
have signed the same settlement**. This matters more in 2026 than it did in
2024: `wiretap.fail` and `tee.fail` demonstrated sub-$1,000 memory-bus
interposer attacks that forge attestations on Intel SGX/TDX and AMD SEV-SNP,
and both vendors treat physical interposition as out of scope with no fix
planned. Single-enclave confidentiality now has a cheap, known, unpatched
single point of failure. k-of-n turns "compromise one box" into "compromise k
boxes under different operators."

**Honest status:** the quorum path is deployed and covered by six dedicated
tests: one signature under threshold two fails; two enclaves settle; the same
enclave cannot sign twice; an unregistered signer does not count; disagreeing
enclaves cannot settle; and a threshold cannot exceed the number of registered
enclaves. Coston2 runs **1-of-1** because a second registered TEE
needs a second host we do not have. `addTee()` and `setSignatureThreshold()` are
live on the deployed venue and raise it without a redeploy.

---

## Bounty 2 — the four questions, answered in order

### What runs privately inside the TEE

Decryption, the resting book, and the auction. Orders arrive as ECIES
ciphertext encrypted to the enclave key; the enclave calls the node's
`/decrypt` port and the plaintext `{trader, side, limitPrice, size, nonce}`
exists only in enclave memory — never logged, returned, or persisted. Open
orders rest in that memory for the life of the batch. The enclave computes the
volume-maximising uniform price and the resulting per-trader net deltas.

Orders that do not match are simply absent from the settlement. Demonstrated
on-chain: batch 2 took **five orders, matched one pair, and three orders were
never revealed** —
[`0xa37aee2f…`](https://coston2-explorer.flare.network/tx/0xa37aee2f156bc18bf5cd2699c15b25e7ff12d277b8d6730f6232f8364aab35f2).

### What is verified or consumed on-chain

Deliberately a lot — the enclave proposes, the chain disposes. `settle()`
rejects the enclave's own signed output unless:

| Check | What it stops |
|---|---|
| **Quorum** — k distinct registered enclave signatures over the digest | Forged or single-compromised-enclave settlements |
| **Conservation** — base and quote deltas each sum to zero, checked *before* fees | A batch inventing value instead of moving it |
| **Oracle band** — clearing price re-read against FTSO XRP/USD **on-chain at settlement** | An enclave clearing at a price it made up |
| **Binding** — one chain id, one venue, one batch id; each batch settles once | Replay onto another venue or batch |
| **Attribution** — `msg.sender` at submission; enclave rejects mismatched `trader` | Someone replaying your ciphertext |
| **Fee ceiling** — `MAX_FEE_BPS = 30`, immutable | Governance changing the deal after you deposit |

Consumed on-chain: **FTSO** XRP/USD via `ContractRegistry`, read twice — once to
seed the batch reference price, once independently at settlement. And **FDC**,
in `XrplGateway`, where a Data Connector `Payment` proof is the only thing that
can credit a balance from the XRP Ledger.

### What trust assumptions exist

**You must trust:**
- The TEE hardware and its attestation to keep order terms confidential during
  matching — subject to the physical-attack caveat above, which is why the
  quorum exists.
- That the registered code hash is the code running (`TeeExtensionRegistry` +
  reproducible builds).
- **On Coston2 this is a simulated attestation** (`SIMULATED_TEE=true`, platform
  `TEST_PLATFORM`). The code hash is a test value, not a hardware quote. The
  registration path and architecture are real; the hardware guarantee is not yet
  there. We would rather say this than have you find it.

**You do not have to trust:**
- That the enclave will not steal funds — it never holds them, and conservation
  is enforced on-chain.
- That the enclave is honest about price — the FTSO band is re-checked on-chain
  after the enclave has spoken. A valid enclave signature is necessary and
  deliberately not sufficient.
- That the operator will not raise fees — the ceiling is in bytecode.

**Deliberately public:** that an address submitted *an* order in a batch (they
sent a transaction — we do not pretend otherwise); the batch's order count; and
a settled batch's clearing price, matched volume, and per-trader net deltas.

### Why confidential compute rather than a normal smart contract

Because the property being sold is *the absence of readable state*, and a
contract cannot offer it — everything a contract knows, everyone knows.

- **Commit–reveal** needs the reveal; a losing participant just declines, and it
  cannot support a resting book at all.
- **Encrypted state decrypted on-chain** publishes the plaintext exactly when it
  becomes valuable.
- **ZK** hides inputs but cannot match across parties' private inputs without an
  MPC layer or a trusted aggregator, and per-block proving over a live book is
  not close on cost.
- **An off-chain matcher** is what an OTC desk already is — it requires trusting
  an operator who sees everything, which is the thing being removed.
- **FHE** benchmarks for sealed-bid auction workloads run to hours for tens of
  participants.

A TEE can hold plaintext, act on it, and prove which code it runs, while the
chain independently constrains what it is allowed to output. Flare is the only
place that sits next to the asset (FXRP) and the price feed (FTSO) the venue
needs.

---

## Bounty 1 — arrive from the XRP Ledger, then trade without showing your hand

FXRP's problem is no longer minting; v1.3 fixed that. It is that once minted
there is nowhere to go with size — and the mainnet measurement says the holders
noticed, because **the fourth-largest holder of FXRP is the bridge taking it off
Flare.**

So the venue has a second door: **pay XRP on the XRP Ledger, and the payment
itself funds your balance on Flare.**

```
XRP paid on XRPL → FDC attests it → XrplGateway verifies the proof on Flare
   → balance credited → seal an order → matched in the enclave → settled
```

You pay from whatever XRPL wallet you already use, with the Flare address to
credit as the payment's standard reference.
[`XrplGateway.sol`](contracts/XrplGateway.sol) verifies the Data Connector's
Merkle proof, checks the payment landed in the desk's XRPL account, prices the
XRP at Flare's own FTSO feed, and credits the address the payment named —
**straight into that address's venue balance, ready to seal an order.** Not
their wallet: they hold no FLR, so a credit needing a further deposit
transaction would have stranded them one step short.

**Live, and run twice against real XRPL testnet payments:**

| XRPL payment | Credited on Flare |
|---|---|
| [12 XRP](https://testnet.xrpl.org/transactions/7C68E09EDA054D708A808DD18DC50AC9019313D6C01797F31F53958BB13047DA) | [`0xe09d510e…`](https://coston2-explorer.flare.network/tx/0xe09d510e776810c1243bdb13a6c36f43a7a0f40f18862f6e106896aa28985ec8) |
| [25 XRP](https://testnet.xrpl.org/transactions/9A275B13DBABBC9FE2F98496BE840CAB369ED56C5E47D91E99B111A3B449FE58) | [`0x64ba0a3d…`](https://coston2-explorer.flare.network/tx/0x64ba0a3d04258acc89c809046148a350ffb47a29d7716709cb2f0a6e0d864f12) |

**It is in the product, not just the repo.** The terminal's funding panel has a
*From the XRP Ledger* section showing the desk's account and your reference; you
paste the payment hash and it carries the attestation through to the credit. The
relayer pays the Flare-side fees, since someone arriving from the XRPL has no FLR
yet — and cannot redirect a drop, because the proof names its own beneficiary.

Or from the command line, against your own payment:

```bash
cd tools && go run ./cmd/xrpl-fund -tx 0x<your-xrpl-transaction-hash>
```

**Why this is not just a bridge.** The gateway never takes custody of the XRP
and cannot credit anyone on our say-so: the only thing that moves value is a
proof Flare's validators produced. `fund()` is permissionless on purpose, so a
relayer can carry the proof for a payer holding no FLR — the realistic case for
someone arriving from the XRPL. Eighteen tests cover the ways it could
otherwise be drained: replay, payment to another account, a failed ledger
transaction, a proof about another chain, a proof the Data Connector rejects,
and a payment naming nobody.

And the destination is the point. Getting XRP onto Flare is not new. Getting it
onto Flare *into a venue where size can then move without announcing itself* is
what is missing — which is why both halves belong in one product. The reason
10.8% of FXRP has already left is the reason the new door is worth building.

Base asset is the **real FAssets FXRP** on Coston2 (`FTestXRP`, not a mock).

## Target user

Institutional flow that cannot use a public book: OTC desks moving size, market
makers who currently will not quote real depth because quoting it is being
adversely selected, and treasuries or funds that cannot rebalance an XRP
position without broadcasting the position.

Explicitly **not** for someone swapping 50 FXRP — too small to be worth
anyone's attention, and an ordinary DEX serves them fine.

## Business model

**5 bps of matched notional**, charged to both sides and only on volume that
actually trades. An order that never matches is free — the right incentive for
a venue whose promise is that size can rest without consequence. Ceiling of
**30 bps fixed in the bytecode**: governance can lower the fee and can never
raise it past that, so depositing does not require trusting the owner not to
change the deal.

At 5 bps, $10M of monthly matched volume is $5,000 of monthly revenue. Small,
and deliberately so — the number that matters at this stage is whether size
shows up at all.

## What was built during the program

**Pre-existing, not ours:** `flare-foundation/fce-extension-scaffold` (extension
skeleton, `tools/` support packages, docker/proxy topology, `scripts/*.sh`);
`tee-node`, `tee-proxy`, `go-flare-common` as dependencies; FAssets `FTestXRP`
and the FTSO contracts on Coston2.

**Built during the program — all of the following:**

| Component | What it is |
|---|---|
| `contracts/InstructionSender.sol` | NightjarAuction — custody, sealed submission, k-of-n quorum, FTSO band, conservation, fee, batch history |
| `contracts/TransparentVenue.sol` | The control venue. Exists only to measure the harm |
| `contracts/XrplGateway.sol` | XRPL → Flare on an FDC Payment proof, priced at FTSO. 18 tests |
| `contracts/test/NightjarAuction.t.sol` | 30 tests — forged signatures, replay, wrong venue, unconserved fills, out-of-band price, quorum edge cases |
| `go/internal/matching/` | The auction engine. Pure, no I/O, 11 tests incl. determinism under reordering |
| `go/internal/extension/` | Instruction routing and handlers |
| `frontend/` | Next.js terminal, landing, proof and depth pages; browser-side sealing |
| `frontend/lib/ecies.ts` | geth ECIES against Web Crypto + `@noble`, round-trip verified against the Go decrypt path |
| `tools/cmd/run-comparison` | The control venue, and the same trade both ways |
| `tools/cmd/make-market` | Two-sided ladder producing genuinely unmatched orders |
| `tools/cmd/fxrp-depth` | The Flare-mainnet liquidity measurement |
| `tools/cmd/xrpl-fund` | Attestation request → FdcHub → DA-layer proof → `fund()` |
| `site/` | The wallet-free public page |
| `docs/field-notes.md` | Six FCC failure modes, written up for the next builder |

Nothing was ported from an earlier project. The git history is the record.

## Deployment details — Coston2

| What | Address |
|---|---|
| NightjarAuction | `0xA290b54398a0D8C0EbD719Ec33846b69Cf913094` |
| TransparentVenue (control) | `0xD2Ce3f06E446Cf967eEC4F3D6fdBB0063be44456` |
| Base — FAssets FXRP (`FTestXRP`) | `0x0b6A3645c240605887a5532109323A3E12273dc7` |
| Quote — `nUSD` (demo stand-in) | `0x4AAFF8FCe43dCfdCF2AA2Bbf07B98707A3547036` |
| FCC extension id | `66250` (`0x102ca`) |
| Registered enclave | `0x32fcFE8ec942aC617363E123D9ACBDA7aDE8dC70` |
| XrplGateway | `0xbc62e861C31Ce6581524b4A6d5518eb3a48eF708` |
| Signature threshold | 1 of 1 registered |

Coston2 has no canonical USD₮0 and the FAssets vault-collateral `testUSD` is
permissioned, so the quote side is a mintable stand-in. On mainnet the quote
side is USD₮0 and `TestUSD.sol` is not deployed.

### Verifiable on-chain evidence

| What | Transaction |
|---|---|
| Batch 1 settled — two orders cross at the uniform price | [`0x083d86d7…`](https://coston2-explorer.flare.network/tx/0x083d86d734cb021fc58b6225d4fe5f4964f65ed0c1c20990f8eb22dd5cfb2c6d) |
| Batch 2 settled — **5 orders in, 3 never revealed** | [`0xa37aee2f…`](https://coston2-explorer.flare.network/tx/0xa37aee2f156bc18bf5cd2699c15b25e7ff12d277b8d6730f6232f8364aab35f2) |
| Control: bid posted publicly | [`0xc63d2cd0…`](https://coston2-explorer.flare.network/tx/0xc63d2cd004115c2f5edbf11393845db28917c82594f2a5521fc6b618b372262b) |
| Control: seller reads it and takes the full limit | [`0xb87f6b7c…`](https://coston2-explorer.flare.network/tx/0xb87f6b7c9918cb4fcf1e8a19773af0ad748e6faefce2ba6ea1b587e83958cb5c) |

## Feedback on building with FCC

Requested at previous Flare hackathons, and the one thing a sponsor cannot get
elsewhere. Full write-up in `docs/field-notes.md`.

1. **The indexer is a hidden dependency and it fails silently.** TEE
   registration does an FTDC availability check against a C-chain indexer. A
   self-hosted one on a public RPC drifts a few reward epochs behind the head —
   and because the policy-consistency preflight has ±1 tolerance it *passes*,
   then registration 404s with nothing pointing at the cause. Ours sat at
   signing policy 5931 against a chain at 5935. Switching to Flare's shared
   indexer made registration succeed in four seconds. Suggestion: compare
   exactly, and name the indexer in the error.

2. **`tee-node` signs with the EIP-191 prefix and the docs do not say so.** It
   signs `accounts.TextHash(payload)`. A contract recovering against the bare
   hash fails every time with an opaque error — and unit tests that build
   signatures the same wrong way pass happily. Ours did, fourteen of them. One
   line in the signing guide would save a day.

3. **FTSO reads blow the default gas estimate.** `ContractRegistry` →
   `FtsoV2.getFeedById` inside a settlement pushed `gasUsed` to 243,887 against
   an estimate of 246,529 — simulation succeeded, the transaction reverted. An
   explicit gas limit fixes it; the failure looks like a contract bug.

The scaffold itself is good, and OPType/OPCommand routing extended cleanly to a
real application.

## Known limitations

Stated because a submission that hides them deserves to have everything else
doubted:

- **One enclave, not k.** Quorum path deployed and tested; a second registered
  TEE needs a second host.
- **Simulated attestation** on Coston2. Registration flow real, hardware quote
  not.
- **The book is in enclave memory.** Restart mid-batch loses resting orders;
  funds unaffected, `cancelBatch()` releases locks.
- **Small batches leak.** Per-trader deltas are informative when a batch has two
  participants. Wants a minimum batch size or padding.
- **No mainnet deployment.** FCC third-party extension registration is not open
  beyond Coston2 — Songbird has the contracts but registration is switched off.
  The measurement tool reads mainnet; the venue cannot yet live there.
- **Cold start is the real risk.** Every standalone crypto dark pool has died on
  liquidity, not cryptography. Renegade and Penumbra shipped good technology to
  negligible volume. That is a distribution problem, and the roadmap treats it
  as the first one.

## Roadmap

1. **A second and third enclave** on independent hosts, threshold 2. Everything
   needed is already deployed.
2. **Approach the four addresses holding 84% of FXRP** — Firelight, Morpho,
   Kinetic, and whoever operates the LayerZero adapter flow. They are named,
   on-chain, and reachable. Counterparties are the binding constraint, not
   features.
3. **Minimum batch size and padding**, so a settled batch stops being
   informative about individual traders.
4. **Mainnet when FCC opens** beyond Coston2.

## Notes for judges

- Nothing needs a wallet: the public page and both measurement tools run
  read-only.
- Every number in this document is reproducible from a command in this repo or
  a transaction link above.
- The live enclave runs behind a Cloudflare quick tunnel, whose URL rotates. If
  the terminal cannot reach it, the recorded demo and the on-chain transactions
  are the canonical evidence — please do not read a dead tunnel as a broken
  project.
- AI assistance was used throughout for implementation, in the way one would use
  a very fast pair. The design decisions, the control-experiment idea, the
  batch-auction-enables-quorum argument, and every number that was measured
  rather than quoted are ours, and all of them are checkable.
