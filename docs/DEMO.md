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
npm run accounts       # note the role addresses; user0 is the delegated one
```

Export a few shell vars so the curls are copy-pasteable (Terminal 2):

```bash
export TOKEN=$(grep '^TOKEN_ADDRESS' .env | cut -d'"' -f2)
export U0=0xE80BCB2f35864E63Bd4E58E25C08538868eE1521   # user0 (delegated to the indexer)
export U1=0xA05a9Aba3327D9575Adf5B0Eb68387185ba1Bb2C   # user1 (NOT delegated)
export U2=0x4526AC35c2BbDB3890DA3901Fd5B3b1F568f1015   # user2 (NOT delegated)
alias jqp='python3 -m json.tool'
```

> Tip: start the indexer ~1–2 min before recording if you want it already caught
> up. Or record the catch-up — `/v1/health` going `degraded → ok` is a nice live
> illustration of "how far behind."

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

### 2. A delegated user's history — all cleartext

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U0/transfers" | jqp
```

Point at: user0 **delegated** decrypt rights to the indexer, so every amount comes
out cleartext — a `shield`, two `transfer`s, and an `unshield`, each
`decryptionState: "decrypted"`, `decryptedVia: "delegation"`. Note the `unshield`
also carries `unwrapStatus: "requested"` — we know the amount, but the gateway
hasn't finalized the unwrap yet (a real in-between state, surfaced honestly).

### 3. The money shot — a non-delegated user

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U1/transfers" | jqp
```

Point at user1, who **never delegated**:
- their own `shield` and their outgoing `transfer` to user2 are `pending_rights`,
  `amount: null` — **indexed, never dropped**, just not decryptable by us;
- but the `transfer` they **received from user0** is **cleartext** — because the
  transfer amount handle is readable by *both* parties, and user0 (the sender)
  delegated. Decryption follows on-chain rights, exactly.

### 4. Current balance

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/balances/$U0" | jqp   # decrypted
curl -s "localhost:42069/v1/tokens/$TOKEN/balances/$U1" | jqp   # pending_rights
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

This is the whole thesis in one move. **user1 is not delegated** (step 3). Have
them delegate, then watch Terminal 1 and `/v1/health` react.

```bash
npm run delegate -- 1          # user1 grants the indexer decrypt rights (ACL tx)
```

Immediately on **Terminal 1** you'll see:
```
[acl]   DELEGATION observed: 0xA05a9A → holder; promoting their pending rows for backfill
```
Now check the backlog — it should **jump**, because user1's history just became
work we're *entitled* to do:

```bash
curl -s localhost:42069/v1/health | jqp     # decryptable.inFlight > 0, oldestAgeSeconds large
```

Wait only a few seconds (measured ~4s gateway sync on Sepolia; the flip is gated by
the next backfill tick, not minutes). Terminal 1 then prints:
```
[backfill] decrypted transfer 0x…- = 250000000 (via delegation)
[backfill] decrypted balance  …    = … (via delegation)
```
And the API flips:

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U1/transfers" | jqp   # user1's history now cleartext
curl -s localhost:42069/v1/health | jqp                                   # decryptable.inFlight back to 0
```

That's the full loop: **opt-in → ACL event → promote → backfill → cleartext**, with
the health endpoint showing the backlog rise and drain (ref. issue #5).

### 7. (Optional) Live indexing — a brand-new event on camera

With Terminal 1 still running:

```bash
npm run transfer -- 0 2 5     # user0 sends 5 cUSD to user2 (SDK-encrypted)
```

Wait ~15–20s (watch Terminal 1 for the `[index] transfer …` then
`[backfill] decrypted transfer …` lines), then re-run user2's history:

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U2/transfers" | jqp
```

Point at: the new transfer appears **live** (no restart, no re-scan) and is
already `decrypted` (user0, the sender, is delegated). That's realtime indexing +
decrypt.

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

To re-run the "non-delegated user delegates → backfill decrypts" beat, the demo
users need to start **un-delegated**:

```bash
npm run revoke          # revoke ALL test users' delegations on-chain (or: npm run revoke -- 0)
```

⚠️ **Two non-obvious caveats** (learned the hard way — see DECISIONS, indexer
limitations):

1. **`rm -rf .ponder` triggers a *slow* re-sync.** A fresh DB replays the whole
   on-chain history, and the block-interval backfill re-runs across all of it
   (re-attempting decryption block-by-block). For a multi-day-old deployment that's
   **several minutes to ~30 min**, not the "1–2 min" you'd hope. Start the indexer
   well before recording, or don't clear the DB at all (see below).

2. **A cleared + re-synced DB does *not* land in a clean "all pending" state.**
   During replay the indexer sees the *old* `DelegatedForUserDecryption` events and
   tries to decrypt — but the **gateway checks *current* on-chain state**, where the
   user is now revoked, so those attempts **fail** and the rows show
   `decryptionState: failed`, not a tidy `pending_rights`. (This is itself a correct,
   honest outcome — the API never fabricates — but it's noisy for a demo.)

**Recommended reset (clean + fast):** keep a DB that's already synced to head and
demo with **fresh activity** instead of a pristine re-sync:

```bash
# indexer already running and at head (users revoked, so their history shows pending/failed)
npm run transfer -- 0 1 5     # a NEW confidential transfer → indexed as pending (user0 revoked)
npm run delegate -- 0         # user0 delegates on camera → the new transfer decrypts live
```

This shows the exact money-shot (pending → delegate → decrypted) without the slow,
noisy re-sync. The "re-decrypts history on a fresh sync" cost is a real
single-process limitation; the worker-fleet design (DECISIONS / INDEXER §6) is where
a production reset would be clean.
