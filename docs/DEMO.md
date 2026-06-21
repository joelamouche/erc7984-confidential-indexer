# Demo runbook (for the screen recording)

A tight, copy-pasteable sequence for a 3–5 min walkthrough. Two terminals:

- **Terminal 1** — the indexer + API (long-running).
- **Terminal 2** — queries and live actions.

The story to tell: *on-chain confidential events go in; cleartext (or an honest
"pending") comes out of a normal REST API — and decryption follows on-chain
delegation, not an API key.*

---

## Before you hit record

The contracts are already deployed on Sepolia and the chain has demo history
(shields, a delegation, transfers, an unshield). So you don't need to deploy on
camera — just point `.env` at the deployment and run the indexer.

```bash
# .env essentials (already set if you ran the deploy):
#   SEPOLIA_RPC_URL="https://sepolia.drpc.org"     # fast indexing, no key
#   DECRYPT_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
#   TOKEN_ADDRESS / WRAPPER_ADDRESS / START_BLOCK  # written by `npm run deploy`

npm install            # if fresh clone
```

**Set a known, clean demo state** (so you never hand-edit this doc — see
"Resetting between demos" for why). This re-delegates the test-user cohort
(→ cleartext history) and provisions one *fresh* non-delegated subject (→ pending),
then prints the addresses to use:

```bash
npm run demo:reset
# ...
#   DELEGATED   (cleartext): 0xE80B…, 0xA05a…, 0x4526…, 0x0d46…
#   NONDELEGATED (pending) : 0x35bea8…
```

Export the addresses it prints (the delegated cohort is stable; the non-delegated
subject is whatever `demo:reset` reports — it advances to a fresh one each time):

```bash
export TOKEN=$(grep '^TOKEN_ADDRESS' .env | cut -d'"' -f2)
export DELEGATED=0xE80BCB2f35864E63Bd4E58E25C08538868eE1521    # a delegated user (cleartext) — from demo:reset
export NONDELEGATED=0x35bea82Efa37dAFeE1b93bEe230334fD24a7300B # the fresh non-delegated subject — from demo:reset
alias jqp='python3 -m json.tool'
```

> The doc never asserts "X is delegated" — you can always *check* live with
> `curl localhost:42069/v1/tokens/$TOKEN/delegations/$ADDR`.

> Tip: start the indexer ~5 min before recording so it's caught up. Or record the
> catch-up — `/v1/health` going `degraded → ok` is a nice live illustration of "how
> far behind." (A fresh `.ponder` re-sync is ~4–5 min for this deployment; or skip
> it and resume an existing DB instantly.)

---

## Terminal 1 — start the indexer + API

```bash
npm run dev
```

Point at: Ponder's TUI — it indexes **two** contracts (the ERC-7984 token *and*
the fhEVM **ACL**, filtered to our holder), and serves the API at
`http://localhost:42069`. Leave it running.

**Watch the activity logs here** — the indexer narrates what it's doing, which is
the whole point of pointing the camera at this terminal:
- `[index] shield/transfer/unshield …→… (pending_rights)` — each event as it's indexed
- `[acl]   DELEGATION observed: … → holder` — a user granting rights
- `[backfill] N transfer(s) pending + due; routing to decrypt…` and
  `[backfill] decrypted transfer … = 40000000 (via delegation)` — the decryption

On a fresh start you'll see a burst of `[index]` lines (the history) followed by
`[backfill] decrypted …` as it catches up.

---

## Terminal 2 — the walkthrough

### 1. How far behind is the indexer?

```bash
curl -s localhost:42069/v1/health | jqp
```

Point at the **two axes**: `indexing` (blocksBehind / secondsBehind vs the chain
head) and `decryptable` (the backlog we're *entitled* to decrypt but haven't —
`pending` count + `oldestAgeSeconds`, i.e. size **and** age). If you're recording
the catch-up, re-run this and watch `blocksBehind` fall to 0,
`decryptable.inFlight` drain to 0 as the backfill runs, and `status` flip
`degraded → ok` (overall `status` is the worst of `indexing.status` and
`decryptable.status`, each `ok | degraded | down`).

### 2. A delegated address's history — all cleartext

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$DELEGATED/transfers" | jqp
```

Point at: this address **delegated** decrypt rights to the indexer, so every amount
comes out cleartext — a `shield`, two `transfer`s, and an `unshield`, each
`decryptionState: "decrypted"`, `decryptedVia: "delegation"`. Note the `unshield`
also carries `unwrapStatus: "requested"` — we know the amount, but the gateway
hasn't finalized the unwrap yet (a real in-between state, surfaced honestly).

### 3. A non-delegated address — indexed, but no cleartext (never dropped)

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$NONDELEGATED/transfers" | jqp
curl -s "localhost:42069/v1/tokens/$TOKEN/delegations/$NONDELEGATED" | jqp   # active: false
```

Point at: this address **never delegated**, so its `shield` is `pending_rights`,
`amount: null` — **indexed, never dropped, and never a fabricated number.** The
indexer is honest about what it can't decrypt. (This is the negative test, live.)

### 4. Current balance — delegated vs not

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/balances/$DELEGATED" | jqp     # decrypted, cleartext
curl -s "localhost:42069/v1/tokens/$TOKEN/balances/$NONDELEGATED" | jqp  # pending_rights, null
```

### 5. How a partner gets a user to delegate (the indexer never holds a key)

```bash
curl -s -X POST "localhost:42069/v1/tokens/$TOKEN/delegations/quote" | jqp
```

Point at: the API returns `sdkDelegateInput` (`{ contractAddress, delegateAddress }`)
for `sdk.delegations.delegateDecryption(...)` — the partner calls that in the
user's wallet context — plus a raw `unsignedTx` fallback. **Honest caveat to
mention on camera:** the user still has to sign, because delegation *is* the user's
authorization — no SDK can remove that. What the SDK abstracts is building/sending
the tx, not the signature. (See DECISIONS §5 — I'm explicitly not fully satisfied
with this; a typed-data permit would be the nicer v2.)

### 6. ⭐ The headline — a user opts in, and watch the backfill live

This is the whole thesis in one move. `$NONDELEGATED` is pending (step 3). Have it
delegate, then watch Terminal 1 and `/v1/health` react.

```bash
npm run delegate -- subject    # the non-delegated subject grants the indexer decrypt rights (ACL tx)
```

Immediately on **Terminal 1** you'll see:
```
[acl]   DELEGATION observed: 0x35bea8 → holder; promoting their pending rows for backfill
```
Now check the backlog — it should **jump**, because the subject's history just
became work we're *entitled* to do:

```bash
curl -s localhost:42069/v1/health | jqp     # decryptable.inFlight > 0, oldestAgeSeconds large
```

Wait only a few seconds (measured ~4s gateway sync on Sepolia; the flip is gated by
the next backfill tick, not minutes). Terminal 1 then prints:
```
[backfill] decrypted transfer 0x…- = 50000000 (via delegation)
[backfill] decrypted balance  …    = 50000000 (via delegation)
```
And the API flips:

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$NONDELEGATED/transfers" | jqp   # now cleartext
curl -s localhost:42069/v1/health | jqp                                             # decryptable.inFlight back to 0
```

That's the full loop: **opt-in → ACL event → promote → backfill → cleartext**, with
the health endpoint showing the backlog rise and drain (ref. issue #5).

### 7. (Optional) Live indexing — a brand-new event on camera

With Terminal 1 still running, send a fresh transfer between two delegated users:

```bash
npm run transfer -- 0 1 5     # user0 sends 5 cUSD to user1 (SDK-encrypted; both delegated)
```

Wait ~15–20s (watch Terminal 1 for the `[index] transfer …` then
`[backfill] decrypted transfer …` lines), then re-run user1's history:

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$DELEGATED/transfers" | jqp
```

Point at: the new transfer appears **live** (no restart, no re-scan) and is already
`decrypted`. That's realtime indexing + decrypt.

---

## Appendix — full reproduction from a fresh clone

If you want to show the whole thing end-to-end (slower; has on-chain waits):

```bash
# Terminal 2 — one-time setup
npm install
cp .env.example .env                 # set SEPOLIA_RPC_URL (drpc is fine, no key)
npm run accounts                     # fund the FUNDER (index 0) from a Sepolia faucet
npm run fund                         # funder -> deployer + holder + users
npm run deploy                       # deploys token+wrapper; writes addresses to .env
npm run seed                         # users mint + wrap (shield)

# Terminal 1
npm run dev                          # indexer + API

# Terminal 2 — drive the scenarios
npm run delegate                     # user0 delegates to the holder (ACL event)
#   ⏳ wait a few seconds (gateway sync ~4s) + the next backfill tick: a shield
#      flips pending_rights -> decrypted in the API.
npm run transfer -- 0 1 40           # cleartext to both (user0 delegated)
npm run transfer -- 1 2 30           # pending (neither delegated)
npm run unshield -- 0 20             # unshield; kind=unshield, unwrapStatus=requested
```

Timing notes for the recording:
- **Indexer catch-up** from the deploy block is seconds-to-~2-min depending on how
  old the deploy is (drpc is ~23 req/s). `/v1/health` shows the progress.
- **Delegation propagation** is fast — **measured ~4s** on Sepolia (SDK docs cite
  up to ~1–2 min as the worst case). A freshly-delegated user's amounts sit in
  `pending_propagation` only until the next backfill tick, then flip to
  `decrypted`. So the user-visible wait is mostly the backfill cadence, not the
  gateway.

## Tests — the brief's "light tests" ask

The brief asks for *a happy-path test (event in → correct cleartext out of the API)*
and *one negative test of your choice, explained*. To say on camera:

- **Happy path** (`test/api.test.ts`): a delegated user's `shield` event went in →
  the API returns `decryptionState: "decrypted", amount: "100000000"` (100 cUSD).
  Event in, correct cleartext out — end to end through the real API.
- **Negative test (the one I picked):** an address the holder has **no decrypt
  rights** for → the API returns an honest `pending` with `amount: null` — **not a
  500, not a fabricated number.**
- **Why this negative:** it pins the brief's *central* rule. For a confidential
  indexer the interesting failure mode isn't "decryption errored" — it's *what the
  API does when it legitimately can't decrypt*. The only correct answers are
  **never drop the event** and **never invent a value**; surfacing an honest
  "pending, no cleartext" is exactly that. A test that proves we don't fabricate is
  worth more here than any other negative.

Backing those up: unit tests for the state machine + the decrypt router, and a
gated end-to-end **transition** test (`pending → delegate → decrypted`, with the
health backlog rising and draining).

```bash
npm test                                       # unit + (if the demo is live) integration matrix
npm run lint                                   # no `any` allowed
INTEGRATION_SLOW=true npm test -- transition   # gated full transition on Sepolia
```

## Resetting between demos

Just run **`npm run demo:reset`** (covered at the top). It re-delegates the cohort
(→ cleartext history) and provisions a *fresh* non-delegated subject (→ pending),
then prints the addresses to use. It's idempotent, and after you delegate the
subject on camera it automatically advances to the next fresh subject next time.

Then either resume the existing DB (instant) or `rm -rf .ponder` for a clean
re-sync (~4–5 min) — both land in the same clean state.

**Why a `revoke`-based reset is the wrong tool** (and why `demo:reset` provisions a
*fresh* subject instead — two real, documented indexer limitations):

1. **A cleared `.ponder` re-sync is slow**, because Ponder replays the whole on-chain
   history and the block-interval backfill re-runs across all of it. Worse, if you
   *revoke* a user first, the re-sync wastes time **retrying decryptions the gateway
   now rejects** — that's what blew a reset up to ~30 min once.

2. **A revoked-then-resynced user lands in `failed`, not `pending`.** On replay the
   indexer sees the user's *old* `Delegated` event and tries to decrypt, but the
   gateway checks *current* on-chain state (now revoked) and rejects → the row shows
   `decryptionState: failed`. Honest (we never fabricate), but noisy on camera. A
   *never-delegated* subject stays cleanly `pending` — which is why `demo:reset`
   uses one. `npm run revoke [-- idx]` still exists if you need it.

Both are single-process characteristics; the worker-fleet design (DECISIONS /
INDEXER §6) is where a production reset would be clean.
