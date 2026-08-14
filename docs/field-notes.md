# Field notes: getting an FCC extension working on Coston2

Seven things cost real time. All are now fixed, and none of them are
documented in an obvious place, so they are written up here.

## 1. A stale indexer silently breaks TEE registration

**Symptom.** `register-tee` dispatches the FTDC availability check cleanly —
the transaction mines, an instruction id comes back — and then
`/action/result/<id>` returns 404 forever, on both `tee-proxy-coston2-1` and
`-2`. The promote step never runs, `getActiveTeeMachines` stays empty, and the
venue cannot route instructions.

**What it looks like.** Everything checkable appears healthy: the machine's
on-chain URL is correct and reachable, the TEE is processing actions, and — the
misleading part — the registration tool's own **policy-consistency preflight
passes**. That check has a ±1 tolerance and compares against the FTDC proxy, so
a genuinely stale indexer can still clear it.

**The real check.** Compare the proxy's reported signing policy to the current
on-chain reward epoch:

```bash
curl -s "$EXT_PROXY_URL/info" | jq .teeInfo.lastSigningPolicyId
cast call 0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52 \
  "getCurrentRewardEpochId()(uint32)" --rpc-url "$CHAIN_URL"
```

These must be **equal**. Ours read 5931 against a chain at 5935 — four epochs
behind — and the availability check 404'd every time. Pointing the proxy at
Flare's shared indexer brought it to 5935, and the very next registration
returned `availability check proof obtained` in about four seconds.

We had been running our own indexer (see [`indexer.md`](indexer.md)) to avoid
waiting on credentials. It syncs and looks healthy, but on a public RPC it
cannot keep pace with the chain head, and being a few epochs behind is enough
to break registration. **Use Flare's shared indexer.** Self-hosting is a fine
way to get unblocked on day one; it is not a substitute once you need to
register a TEE.

Also worth knowing: **restarting the `extension-tee` container mints a new
teeId** and forces registration from scratch. Restart only `ext-proxy` unless
you actually want a new machine identity. Conversely, `/info` is served through
the proxy and caches machine data — after changing `EXTENSION_ID` you must
restart the proxy or it keeps reporting the old extension.

## 2. The TEE signs with an EIP-191 prefix

**Symptom.** Everything works — orders seal, the enclave matches, a 65-byte
signature comes back — and then `settle()` reverts with `BadSignature`.

**Cause.** The obvious assumption is that the node signs the hash you hand it.
It does not. `tee-node`'s sign endpoint does:

```go
msgHash := crypto.Keccak256(signRequest.Message)   // hashes your payload
signature, err := s.node.Sign(msgHash)             // → utils.Sign
```

and `utils.Sign` is:

```go
crypto.Sign(accounts.TextHash(msgHash), privKey)   // adds the EIP-191 prefix
```

So the digest actually signed is:

```
keccak256("\x19Ethereum Signed Message:\n32" || keccak256(payload))
```

Recovering against a bare `keccak256(payload)` returns an unrelated address and
every settlement fails. The contract must apply the prefix:

```solidity
bytes32 digest = keccak256(
    abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(_settlement))
);
```

Worth stressing because it is invisible to unit tests unless your test signs
the way the node does. Ours originally signed the bare hash, so 14 Solidity
tests passed against a contract that could never verify a real TEE signature.
The test helper now mirrors `accounts.TextHash` exactly.

## 3. Gas estimation is too tight for FTSO reads

**Symptom.** A transaction that calls `FtsoV2.getFeedById` reverts on-chain
while `eth_call` and `eth_estimateGas` both succeed against the same state.

**Cause.** Plain out-of-gas. The receipt makes it obvious once you look:

```
gasUsed 243887 / gasLimit 246529   isError 1
```

98.9% of the limit consumed. Estimation runs against a block where the feed's
storage is warm; execution can touch cold slots and exceed the estimate. The
63/64 rule on the external call makes the margin worse.

**Fix.** Set an explicit ceiling on any transaction that reads a feed rather
than trusting the estimate. Unused gas is refunded:

```go
opts.GasLimit = 1_500_000
```

## 4. `getRandomTeeIds` decides your matching rule for you

Not a bug — a design consequence worth writing down, because it is invisible
until you try to run more than one machine and then it is structural.

`TeeMachineRegistry.getRandomTeeIds(extensionId, n)` lets you fan one
instruction out to `n` enclaves, which is the obvious route to not trusting a
single box. But whether that is *usable* depends entirely on what your
extension computes.

If your enclave holds a price-time-priority order book, it cannot be. Matching
depends on arrival order, and `n` machines receiving the same instructions over
a network will not see them in the same order. They produce different fills and
sign different bytes, so there is no quorum to take — the extension is
single-machine by construction, no matter what the registry offers.

Anything whose output is a pure function of the *set* of inputs replicates
cleanly. A uniform-price batch auction is the obvious example: it consumes the
whole book and returns the volume-maximising price, so every enclave emits
byte-identical output regardless of arrival order. We have that as a test
(`TestDeterministicUnderReordering`) precisely because the quorum rests on it.

Worth a paragraph in the FCC docs, because "fan out to N machines" reads like a
free reliability knob and it is actually a constraint on your application
design. Pick the replicable rule first; the fan-out is only available to you
afterwards.

## 5. Restarting your tunnel silently unregisters your TEE

This is the second distinct cause of the availability-check 404 in note 1, and
it is worth separating because the symptom is identical and the fix is not.

Your machine's host URL is written **on-chain** at registration. A Cloudflare
quick tunnel gets a new random hostname every time it restarts. The moment it
rotates, the registry holds a URL that resolves to nothing, and two things
break at once:

- **The FTDC availability check 404s forever**, because it probes the
  registered URL. Re-running `post-build.sh` does not help: the machine is
  already registered, so the tool requests a fresh attestation instead of
  re-registering, and never rewrites the URL.
- **Instructions stop being delivered.** This is the quiet one. The enclave
  still polls the proxy and its logs look perfectly healthy — `F_GET /
  TEE_INFO` every ten seconds, forever — while every `runBatch` you send is
  simply never routed to it. `getActiveTeeMachines` still lists the machine,
  so it looks registered and alive.

Diagnosing it takes one command:

```bash
cd tools && go run ./cmd/query-tee -ext <id> -reg <FlareTeeManager>
# compare url="..." against your current $EXT_PROXY_URL
```

There is no update-URL path on the registry, so the fix is a new machine
identity: restart `extension-tee` to mint a fresh teeId, `rm -f
config/register-tee.state`, and register again — the fresh registration writes
the current URL. If your venue pins signer addresses, add the new one.

Two things follow. Use a **named** tunnel with a fixed hostname if you can;
they are free and this whole class of failure disappears. And if you cannot,
re-register immediately after any tunnel restart rather than discovering it
when a demo hangs.

## 6. A fresh proxy does not have enough signing-policy history to register

**Symptom.** Everything looks right on a brand-new host. The proxy is up,
`/info` returns a real `teeInfo`, the policy-consistency preflight passes, the
availability check is dispatched, and then the result 404s forever. The enclave
log is the only place that says why:

```
main queue: processing action 0x… error: policy of the given reward epoch not in the storage
```

**Cause.** `initial_signing_policy_offset` decides how far back the proxy loads
signing policies when it starts. On a machine that has been running a while
this never bites, because it has accumulated history. A fresh deployment has
only the last couple of epochs — and TEE attestation is verified against the
epoch in which the *extension's governance* was set, which may be several
epochs older. The enclave cannot verify what it cannot see.

**Fix.** Set the offset far enough back to cover the extension's governance
epoch, and restart the proxy and then the enclave, in that order.

```bash
# how far back do you need? compare
cast call 0xA90Db6D10F856799b10ef2A77EBCbF460aC71e52 \
  "getCurrentRewardEpochId()(uint32)" --rpc-url "$CHAIN_URL"     # now
curl -s "$EXT_PROXY_URL/info" | jq .teeInfo.initialSigningPolicyId  # what the enclave has
```

Ours needed to reach back five epochs: the extension was registered at 5936 and
a freshly started proxy began at 5938. Offset 5 covered it and registration
succeeded on the next attempt.

**Do not overshoot.** Too large an offset asks the indexer for policies outside
its retention and the proxy hangs on startup at `fetching initial TEE info`,
never reaching `serving external`. Six was already too many for us. Widen it
one step at a time.

**Order matters on a restart.** The proxy has to be healthy and past
`initialized for policy N` before the enclave starts, or the enclave comes up
with no policies at all and you are back to the same 404 for a different
reason.

## 7. Two smaller ones

**A rotated tunnel URL lives in more than one file.** `.env`
(`EXT_PROXY_URL`), `frontend/.env.local`, and the on-chain registration above.
The frontend failure is a clean `fetch failed`; the on-chain one is not.

**Widening a settlement signature to `bytes[]` breaks callers silently.** When
the venue moved from one enclave signature to a quorum, the Go tooling was
updated and the browser was not — and a bare `bytes` where the ABI wants
`bytes[]` fails at encode time, in the user's browser, in a path no test
covered. The cheap check, if you have a settlement that already succeeded:
decode its calldata with your current ABI, re-encode it the way the client
builds the call, and require the bytes to be identical. That caught it in
seconds and would have caught it the moment the ABI changed.

## Sequence that works

```bash
# 1. Deploy and register the extension
./scripts/pre-build.sh

# 2. Bring up the stack; note the tunnel URL
./scripts/start-services.sh --chain coston2 --tunnel

# 3. Wait for the signing policy to reach the current reward epoch.
#    Registering before this is the single biggest time sink.

# 4. Register the TEE
rm -f config/register-tee.state
./scripts/post-build.sh

# 5. Confirm the machine is actually serving
cd tools && go run ./cmd/query-tee -ext <id> \
  -reg 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE
```

Step 5 should list your machine. If it prints `(none)`, go back to step 3 —
it is almost always the signing policy.

## Environment

macOS notes, since the scripts assume GNU userland: the shipped bash is 3.2 and
trips `set -u` on empty array expansion in `start-services.sh` (`brew install
bash` fixes it); Docker Compose needs BuildKit, so `docker-buildx` must be
present; and under Colima the project directory has to be mounted explicitly
(`colima start --mount /path:w`) or bind-mounted config files silently become
directories. Finally, Foundry auto-loads `.env`, so a `CHAIN=coston2` variable
there collides with `cast --chain` and breaks every `cast` call in the repo.
