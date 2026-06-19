# Architecture

> Status: **design, pre-implementation.** This document is the plan the code in
> later commits will follow. Anchored to [`docs/SDK-NOTES.md`](./SDK-NOTES.md)
> (real alpha API) and verified ERC-7984 event/ACL facts. Decisions and their
> justifications live in [`../DECISIONS.md`](../DECISIONS.md); this file is the
> "how it's wired."

## One-paragraph shape

A **Ponder** indexer watches a single ERC-7984 token (+ its ERC-20 wrapper) on
**Sepolia**. On every relevant event it records the transfer/activity row
immediately with the **encrypted amount handle**, then attempts decryption via
**`@zama-fhe/sdk`** using the **indexer holder's** identity (party-to-transfer or
ACL delegation). Cleartext lands in the same row when available; when it doesn't,
the row is kept in an explicit `pending_*` state — never dropped — and a
**backfill worker** re-attempts it later (e.g. after a partner grants
delegation). Ponder's built-in **Hono** server exposes the cleartext read API.

```
Sepolia ──logs──> Ponder indexer ──┬─> transfers table (handle + state + cleartext?)
  ERC-7984 token                   ├─> balances cache (handle + cleartext?)
  ERC-20 wrapper                   ├─> decrypt jobs queue
  ACL contract  ─(delegate==holder)┘                                     │
   (rights events)         └────────────> delegations table ──promotes──►│
                                          │                              │
                              @zama-fhe/sdk (holder identity)            │
                                          │                              │
                              backfill worker  ──(rights granted later)──┘
                                          │
                                   Hono read API  <── DB
                                   (balances · history · health · delegation quote)
```

## Events we index (verified against OZ `openzeppelin-confidential-contracts`)

There is **no plain `Transfer`**. The token emits a single transfer event; the
wrapper adds unshield events. Mint/burn reuse `ConfidentialTransfer` with the
zero address (ERC-20 convention).

| Event | Source | What we extract |
| --- | --- | --- |
| `ConfidentialTransfer(address indexed from, address indexed to, euint64 indexed amount)` | ERC-7984 token | transfer/mint/burn; `amount` is a **ciphertext handle** (bytes32 log topic), **not** cleartext |
| `AmountDisclosed(euint64 indexed handle, uint64 amount)` | ERC-7984 token | a **public** cleartext reveal — lets us backfill a `handle → amount` even with no holder rights |
| `UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, euint64 amount)` | wrapper (unshield, step 1) | pending unshield, encrypted amount |
| `UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, euint64 encryptedAmount, uint64 cleartextAmount)` | wrapper (unshield, step 2) | **cleartext** unshield amount arrives directly on-chain |
| `OperatorSet(address indexed holder, address indexed operator, uint48 until)` | ERC-7984 token | (optional) operator lifecycle |

Notes that shape the design:
- The emitted `ConfidentialTransfer.amount` is the **actually-transferred** amount
  (`FHE.select(success, amount, 0)`). A failed/over-balance transfer still emits
  an event whose handle decrypts to `0`. We surface that honestly rather than
  hiding the row.
- **Shield (`wrap`)** has no dedicated event — it appears as
  `ConfidentialTransfer(address(0), to, handle)`. We tag mint-from-wrapper as
  `shield` by matching the wrapper address.
- **Unshield (`unwrap`)** is two-phase and async; `UnwrapFinalized.cleartextAmount`
  gives us plaintext without any decryption round-trip — a cheap, authoritative
  cross-check on our SDK-decrypted values.

### Rights-discovery events (the ACL contract — second indexed source)

The indexer also watches the **fhEVM ACL contract**
(`0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D` on Sepolia), topic-filtered to its
own holder, so it learns what it may decrypt **event-driven** rather than by
trial-and-error:

| Event | What we extract |
| --- | --- |
| `DelegatedForUserDecryption(address indexed delegator, address indexed delegate, address contractAddress, uint64 counter, uint64 oldExp, uint64 newExp)` | a partner address granted our holder decrypt rights → add/refresh `delegations` row; mark that delegator's `pending_rights` amounts eligible |
| `RevokedDelegationForUserDecryption(...)` | rights revoked → deactivate the `delegations` row |
| `Allowed(address indexed caller, address indexed account, bytes32 handle)` | (optional) a specific handle persistently granted to our holder |

`delegate`/`account` are indexed, so we subscribe with `delegate == holder`.
`contractAddress` is in data (can be the wildcard `0xFF…FfF` = all contracts).
`delegationCounter` orders grants. `allowTransient` emits nothing, so transient
rights are intentionally invisible — we only act on persistent grants. The ACL
exposes no enumeration, so on cold start we backfill ACL logs from its deploy
block and validate each tuple with `sdk.delegations.isActive`/`getExpiry`. The
SDK-error path (`NoCiphertextError → pending_rights`) remains a safety net for
anything the event stream didn't predict.

## Decryption rights model (the crux)

ACL is **per-handle and persistent rights go only to the handle owner + the
contract**. From `ERC7984._update`:

| Handle | sender | receiver | contract | third party |
| --- | --- | --- | --- | --- |
| sender's new balance | ✅ | ❌ | ✅ | only via `FHE.allow(handle, addr)` |
| receiver's new balance | ❌ | ✅ | ✅ | only via `FHE.allow(handle, addr)` |
| transferred amount | ✅ | ✅ | ✅ | only via delegation |

Consequence for an indexer with a **single holder identity**:
- It can decrypt a transfer **amount** iff the holder is the sender or receiver,
  **or** the relevant party delegated decrypt rights to the holder
  (`sdk.delegations.delegateDecryption`).
- It can decrypt an address's **balance** iff that address delegated to the holder
  (you never get rights on a counterparty's balance just by transacting).

So the API is multi-address but decryption is holder-scoped. We do **not** pretend
otherwise — see the `decryptionState` field below.

## Per-amount state machine

Every amount handle (transfer or unwrap) carries an explicit state. This is the
"awkward in-between" surface the brief asks us to design well.

```
                    ┌─────────────► decrypted ◄──────────┐
                    │ (SDK ok, or                        │ (AmountDisclosed /
 indexed ──► pending_rights        AmountDisclosed)      │  UnwrapFinalized seen)
                    │ (NoCiphertext / DelegationNotFound) │
                    ├──► pending_propagation ─────────────┘
                    │   (DelegationNotPropagated; retry ~30s)
                    └──► failed
                        (RelayerRequestFailed / unknown; backoff retry)
```

- `pending_rights` → an amount whose party (`from`/`to`) hasn't delegated to the
  holder. **Promoted event-driven:** when a `DelegatedForUserDecryption` for that
  party is indexed on the ACL contract, its `pending_rights` rows move to
  `pending_propagation`. (A periodic `sdk.delegations.isActive` sweep is the
  fallback for anything missed.)
- `pending_propagation` → rights observed on-chain but the gateway hasn't synced
  yet (the event is immediate, decryption lags ~1–2 min). Short retry loop;
  `DelegationNotPropagatedError` keeps it here rather than failing.
- `failed` → exponential backoff, capped retries, then surfaced as `failed` (not
  hidden) so the partner can see the indexer couldn't decrypt.
- Cleartext from `AmountDisclosed`/`UnwrapFinalized` short-circuits straight to
  `decrypted` regardless of holder rights.

## Balance computation

Source of truth: **decrypt the on-chain `confidentialBalanceOf(addr)` handle**
when the holder has rights (own identity or delegation). We re-read the handle on
each relevant transfer touching `addr` and decrypt it, rather than reconstructing
from summed deltas, because:
- it survives missed events / rights gaps (a reconstruction drifts permanently
  once one amount is undecryptable);
- it's authoritative for shield/unshield without special-casing.

Reconstruction-from-deltas is kept only as a **consistency check** logged when it
disagrees with the decrypted balance (useful signal under load; see DECISIONS
reflection).

## Data model (Ponder schema, sketch)

```
transfers
  id            (txHash-logIndex)
  token         address
  kind          enum: transfer | shield | unshield | mint | burn
  from, to      address
  amountHandle  bytes32            -- the ciphertext handle (always present)
  amount        bigint?            -- cleartext when known
  decryptionState enum: decrypted | pending_rights | pending_propagation | failed
  blockNumber, blockTime, logIndex
  decryptedVia  enum?: holder | delegation | amount_disclosed | unwrap_finalized
  lastAttemptAt, attempts

balances
  id            (token-address)
  token, account address
  balanceHandle bytes32
  balance       bigint?
  decryptionState  enum (as above)
  updatedAtBlock

delegations            -- rights the holder can use, sourced from ACL events
  id (contract-delegator), delegator, contractAddress (or wildcard),
  active, expiry, delegationCounter, observedAtBlock, lastCheckedAt

indexer_status         -- 1 row, for /health: chainHead, lastIndexedBlock, lag, decryptBacklog
```

## Read API (shapes are our design — DX matters)

| Method & path | Returns |
| --- | --- |
| `GET /v1/tokens/:token/balances/:address` | current cleartext balance + `decryptionState`; `null` cleartext with a reason when no rights |
| `GET /v1/tokens/:token/addresses/:address/transfers?cursor=&limit=` | paginated transfer history, cleartext amounts where available, each row carrying its `decryptionState` |
| `GET /v1/tokens/:token/delegations/:address` | whether `address` has delegated decrypt rights to the indexer holder (`active`, `expiry`) — so a partner can check status |
| `POST /v1/tokens/:token/delegations/quote` | returns an **unsigned** delegation tx `{ to: aclAddress, data, chainId }` for `address` to grant the holder rights. The indexer builds calldata (`delegateForUserDecryptionContract`); the user's wallet signs+sends. The indexer never holds a user key. |
| `GET /health` | `{ status, chainHead, lastIndexedBlock, blocksBehind, secondsBehind, decryptBacklog: { pendingRights, pendingPropagation, failed } }` |

Design choices to defend in DECISIONS: cursor pagination (stable under new
inserts), `decryptionState` on every amount-bearing row (honesty over a clean
lie), error taxonomy (`404 unknown token`, `422 bad address`, `503` when the
indexer is too far behind a freshness threshold), and a partner-facing reason
string for undecryptable amounts.

## Component inventory: composed vs. written

| Concern | Choice | Composed / written |
| --- | --- | --- |
| EVM indexing, reorgs, backfill, DB, HTTP | **Ponder** (+ Hono, pglite) | composed |
| FHE decryption / delegation | **`@zama-fhe/sdk@alpha`** | composed |
| Toy ERC-7984 token + ERC-20 wrapper | **OpenZeppelin confidential-contracts**, deployed via **forge-fhevm**/Foundry | composed (contracts) |
| Decrypt-on-index wiring + state machine | our event handlers | **written** |
| Backfill worker | our cron/loop over `pending_*` rows | **written** |
| Read API handlers + error taxonomy + pagination | our Hono routes | **written** |
| Tests (happy path + one negative) | Vitest + forge-fhevm | **written** |

## Chain & deployment

- **Sepolia testnet.** Picked for a *real* gateway, so `userDecrypt` and ACL
  delegation actually exercise the rights model that is the heart of the brief.
- Toy ERC-7984 token + wrapper deployed with **EOA test keys** (`.env.example`
  only). Foundry/forge-fhevm for local contract tests and for the deploy script.
- Two indexed contracts: the token (+wrapper) for activity, and the canonical
  **ACL contract** (`0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D`) filtered to the
  holder for rights discovery. The ACL address is a constant, not deployed by us.
- Local fhEVM was considered for speed but rejected for the primary path because
  its mocked decryption weakens exactly the signal being graded. Rationale in
  DECISIONS.

## Source layout (planned)

```
contracts/        Foundry project: toy ERC-7984 token + ERC-20 wrapper, deploy script
src/
  ponder.config.ts        chain + contract + start-block config
  ponder.schema.ts        tables above
  index.ts                event handlers (decrypt-on-index)
  zama/sdk.ts             ZamaSDK init (holder identity) + decrypt helpers
  zama/state.ts           error -> decryptionState mapping
  backfill/worker.ts      drain pending_* rows; re-check delegations
  api/index.ts            Hono read routes + error taxonomy
  config.ts               env parsing/validation
scripts/                  seed transfers / grant-delegation demo
test/                     happy-path + one negative test
```
