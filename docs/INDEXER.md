# The indexer: how Ponder works and how we customize it

This explains the indexing layer in depth — what [Ponder](https://ponder.sh) gives
us for free, how we bend it to decrypt confidential amounts, where the database
lives and how we shape it, and how the design behaves under partner load. It is
the companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (the what) — this is the how.

---

## 1. What Ponder does for us

Ponder is a TypeScript indexing framework. You give it (a) which chains/contracts/
events to watch, (b) a database schema, and (c) handler functions; it gives you:

- **Historical backfill** — fetches logs from a `startBlock` to chain head.
- **Realtime tracking** — follows new blocks and emits events as they land.
- **Reorg handling** — if the chain reorgs, Ponder rolls back the affected rows
  and re-indexes. This is the main reason we don't hand-roll a `getLogs` loop.
- **An embedded database** — PGlite (embedded Postgres) by default, or real
  Postgres via one env var. We never write migrations by hand; the schema *is*
  the migration.
- **An HTTP server** — a Hono app (our read API mounts straight into it).
- **RPC hygiene** — request batching, caching, and automatic retry/rate-limit
  backoff (this is why the Infura per-second 429s show up as warnings, not crashes).

The brief explicitly says *compose an off-the-shelf indexer, don't build one*.
Ponder is that composition: we write ~3 files of glue, not an EVM indexer.

## 2. How a Ponder project is wired (the three files)

```
ponder.config.ts   →  chains + contracts + which events, from which block
ponder.schema.ts   →  database tables (drizzle)
src/index.ts       →  ponder.on("Contract:Event", handler) — writes rows
src/api/index.ts   →  Hono app reading those tables (the read API)
```

- **config**: we declare two contracts — `ConfidentialToken` (our deployed
  ConfidentialUSD) and `Acl` (the canonical fhEVM ACL). The ACL source is
  **filtered** to only events where `delegate == our holder`, so we index
  delegations *to us* and nothing else.
- **schema**: drizzle table definitions via `onchainTable`. This answers
  "can we customize the Ponder DB?" — **yes, completely**. The schema is ours to
  define; Ponder creates and reorg-manages exactly these tables. See §4.
- **handlers**: plain async TS. Each gets `{ event, context }`. `event.args` is
  the decoded log; `context.db` is a typed writer (`insert`/`find`/`update`/
  `delete`); `context.client` is a viem client for on-chain reads. We write one
  row per event and **never drop** an amount we can't yet decrypt — it goes in
  with an explicit state.

Ponder runs as **two processes**: an *indexing* process (runs handlers, writes
the DB) and an *api* process (serves the Hono app, **read-only** DB access). This
split matters for the decryption design (§5): the API can't write, so cleartext
must be produced on the indexing side.

## 3. The two-contract trick: event-driven rights discovery

Most confidential-token indexers would watch only the token. We also watch the
**ACL contract**, because that's where the "who is allowed to decrypt what"
signal lives. When a partner user calls `delegateForUserDecryption(holder, token,
expiry)`, the ACL emits:

```solidity
event DelegatedForUserDecryption(address indexed delegator, address indexed delegate, ...);
```

`delegate` is indexed, so Ponder filters server-side to just our holder. The
handler writes a `delegations` row. That row is the indexer's live answer to
*"which addresses have granted us decrypt rights?"* — built from chain events, not
guessed by trial-and-error. (Fallback: if a decrypt attempt 400s with
`NoCiphertextError`, we still park the row as `pending_rights` — belt and braces.)

## 4. The database tables (our customization of Ponder's DB)

Defined in `ponder.schema.ts`. Three tables, all reorg-managed by Ponder:

| Table | One row per | Key columns | Filled by |
| --- | --- | --- | --- |
| `transfers` | transfer / mint / burn / shield / unshield | `amountHandle`, `amount?`, `decryptionState`, `from`, `to`, `kind` | `ConfidentialTransfer` handler; cleartext later |
| `balances` | (token, account) | `balanceHandle?`, `balance?`, `decryptionState` | transfer handler (handle), decryption (cleartext) |
| `delegations` | (contract, delegator) | `delegator`, `delegate`, `active`, `expiry`, `delegationCounter` | ACL `Delegated/Revoked` handlers |

The load-bearing column is **`decryptionState`** on every amount-bearing row:
`pending_decrypt → pending_rights → pending_propagation → decrypted` (or `failed`),
where each `pending_*` names what we're waiting on (us / the user / the gateway).
It's a real enum column, queryable, and it's what the backfill and `/v1/health` read.

> **Customizing Ponder's DB = editing `ponder.schema.ts`.** Add a column, add a
> table, add an index — it's drizzle. The only rule: tables declared with
> `onchainTable` are owned and reorg-reconciled by Ponder's indexing engine, so
> they should be written from the **indexing** side, not from the api process or
> an outside script (which is why §5 matters).

## 5. Decrypting: the customization that makes this a *confidential* indexer

This is the part Ponder doesn't do — we wire in `@zama-fhe/sdk`. The naive version
is "decrypt inside the `ConfidentialTransfer` handler." We deliberately **don't**,
for two reasons:

1. **Decryption is a slow async round-trip** to the Zama gateway (re-encrypt →
   relayer → KMS → decrypt), on the order of hundreds of ms to seconds, and rate-
   limited. Doing it inline serialises indexing behind network latency — a burst
   of transfers would stall the whole indexer.
2. **Rights arrive later.** The brief requires backfilling cleartext when a
   partner grants delegation *after* the transfer was indexed. An inline-only
   decrypt can't express "try again once rights show up."

So we **decouple indexing from decryption**:

```
ConfidentialTransfer ──► transfers row (handle + pending_decrypt)   [fast, deterministic]
                                  │
        Ponder `block` interval ──┴──► backfill tick:               [decoupled cadence]
            1. load a bounded batch of pending/failed rows due for retry
            2. group handles by the delegator we can act for (delegations table)
            3. SDK BATCH decrypt  (decryptValues / delegatedDecryptValues)
            4. write cleartext + state back; on error → state + backoff
```

The backfill runs on a **Ponder `block` source** (a handler that fires every N
blocks) rather than the per-transfer event. That keeps it on the indexing side
(so it can write the reorg-managed tables), driven by chain progress, and at a
cadence independent of transfer volume. Each tick processes a bounded batch, which
is natural backpressure.

Handles whose cleartext arrives **on-chain** skip the gateway entirely:
`AmountDisclosed` and `UnwrapFinalized.cleartextAmount` are handled inline and go
straight to `decrypted` — a free, authoritative fast path.

**Out-of-process decryption (a constraint that became an architecture).** The
Zama SDK can't actually be called from inside a Ponder handler: its `node()`
transport bootstraps worker threads via `import.meta.resolve`, which Ponder's
**Vite SSR** runtime doesn't provide (`__vite_ssr_import_meta__.resolve is not a
function`). The isolation test (plain Node) decrypts fine; the same call inside a
handler throws. So the backfill tick spawns a short-lived **plain-Node helper**
(`scripts/decrypt-handles.ts`) — pipes the handles in, gets cleartext out — and
writes the result to the DB. This is the same decoupling §6 describes for scale,
forced earlier by a runtime constraint rather than by load. (At scale this becomes
a long-lived worker fleet against Postgres; the spawn-per-tick here is a demo
simplification, and the SDK-feedback note in DECISIONS flags the Vite footgun.)

**Determinism caveat (a real tradeoff, logged in DECISIONS):** Ponder handlers are
meant to be deterministic so reorg-replays and caching are sound. A decrypt call
isn't deterministic. We accept this because the write is **idempotent** —
cleartext is keyed by the immutable ciphertext `handle`, so re-running a decrypt
yields the same value and a reorg can't corrupt it. We isolate the
non-determinism to the `block` backfill handler, never the transfer handler.

## 6. Designing for scale — and what the brief actually asks

**What the brief asks:** it caps the work at "roughly 3–4 focused hours," says
storage is explicitly *not* being tested ("not testing your ops setup"), and asks
in the reflection to name the piece we're *least confident about under partner
load — what breaks first and how we'd prove it*. So the brief wants us to **design
with scale in mind and reason about it**, not to ship a horizontally-scaled
system. We implement a *correct, bounded, batched* decryptor and document the path
to scale.

**The bottleneck is the gateway, not the indexer.** Indexing one contract is
cheap and Ponder handles it. Decryption is the scarce resource: it's network-
bound, rate-limited, and serial-ish per identity. Under a partner with thousands
of users and high transfer volume, the decrypt backlog is what grows. So the scale
design is entirely about draining that backlog efficiently:

- **Batch.** The SDK's `decryptValues` takes an array and groups by contract,
  dedupes, and caches. One round-trip for many handles. We always batch a tick.
- **Bound concurrency.** Cap in-flight decrypt requests so we respect gateway/
  relayer rate limits instead of getting throttled. Backoff on `RelayerRequestFailed`.
- **Dedup by handle.** Many transfers can share an amount handle; decrypt once,
  fan the cleartext out to all rows with that handle (and cache it).
- **Prioritise.** Drain `pending_propagation` (rights just landed) and fresh
  `pending_decrypt` before old `failed` retries; balances before deep history.
- **Idempotent + keyed by handle** so retries and reorgs are safe and a crashed
  tick simply re-runs.

### Scaling out: two queues + worker pools (RabbitMQ)

The single-process backfill is fine for the demo, but the real shape is a
**message broker (RabbitMQ) feeding worker pools**, with **two separate queues**
because there are two genuinely different decryption workloads with different SLAs:

```
                        ┌──────────────────────────── live.decrypt ──────────┐
Ponder indexer ─emits─▶ producer ─┤  (new at-head events the holder can decrypt) │
  (events + ACL)        │         └─────────────────────────────────────────────┘
                        │                                  │  high priority, autoscale
                        │                          live worker pool ──┐
                        │                                              ▼
                        │         ┌──────── backfill.decrypt ───────┐  Postgres
                        └─emits──▶┤ (a newly-delegated address's     │  (decryptions,
                          (on      │  whole history — bulk job)      │   handle→cleartext)
                          Delegated)└─────────────────────────────────┘  ▲
                                              │ low priority, CAPPED pool │
                                       backfill worker pool ─────────────┘
```

1. **`live.decrypt` — keep current data fresh.** New events at chain head that the
   holder is already entitled to decrypt. Target: near-zero lag. The live worker
   pool **autoscales** to keep this queue almost empty, because this is what a
   partner watching balances in real time feels. High priority / high prefetch.

2. **`backfill.decrypt` — drain a newly-delegated address's history.** When a
   `DelegatedForUserDecryption` lands, we enqueue a **bulk** job to decrypt that
   address's entire backlog of `pending_rights` handles. This can be **huge** (a
   whale with thousands of historical transfers), so it runs on a **capped** worker
   pool at **low priority** and a delay is **acceptable in UX** — the user just
   opted in, so "decrypting your history… 73%" is a fine experience. Critically,
   backfill must **never starve live**: separate pools (or a strict priority +
   bounded backfill prefetch) guarantee a delegation storm can't stall realtime.

**Why this matters for the read API ("how far behind am I?").** The two queues map
to **two different freshness numbers**, and `/v1/health` should report both
distinctly so a partner isn't misled by a single lag figure:

- **live lag** (`secondsBehind` ≈ 0 target) — am I current with the chain head?
- **backfill backlog** — how much delegated-history is still being decrypted,
  ideally **per address** ("user X: 73% decrypted") plus a global pending count.

Mixing these into one "behind" number would be wrong: a 2M-handle backfill for one
whale shouldn't make the API look "5 hours behind" for everyone else who is live.
The `decryptable` metric already in `/v1/health` (entitled rows split into
`inFlight` / `failed`, with the oldest in-flight age) generalises straight into
this split — one `decryptable` per queue, with the backfill one reported per
address.

**Mechanics.** Workers are stateless plain-Node processes (the SDK already has to
run outside Ponder, §5, so an out-of-process worker is its *natural* home — no
new constraint). Each worker: pull a job → batch-decrypt via the SDK → upsert
cleartext into a Postgres `decryptions(handle → cleartext)` table the API joins →
ack. **Idempotent and keyed by the immutable handle**, so redeliveries and reorgs
are safe. Transient failures go to a **DLQ with exponential backoff**;
`pending_propagation` (delegation not yet synced) is a **delayed requeue**, not a
failure. A shared **gateway rate-limit / token bucket** across all workers keeps
total relayer RPS under the cap, with `backfill` yielding to `live`.

We don't build the broker for this submission — it's the "next four hours" — but
the in-process design is shaped so the move is mechanical: the routing logic
(`src/decrypt-router.ts`) and the handle-keyed idempotency don't change; only the
*transport* (a block-interval tick → a queue consumer) and the *store* (PGlite →
Postgres, one env var) do.

**The honest "what breaks first" (reflection seed):** under load, the backfill
tick is the fragile piece. If transfer volume outruns decrypt throughput, the
`pending_*` backlog grows unbounded and `/v1/health` shows rising
`secondsBehind` + backlog counts. We'd prove it with a load test: seed K
transfers/min, watch backlog depth and decrypt latency, and find the transfers/min
at which the backlog stops draining — that number is the single-process ceiling,
and it's a gateway-throughput function, not a Ponder one.

## 7. RPC / rate limits (operational note)

Indexing reads blocks/logs from `SEPOLIA_RPC_URL`. Infura's free Core plan is
**6M credits/day, 2,000 credits/sec** (`eth_getBlockByNumber` 80 credits,
`eth_getLogs` 255). The daily cap is far more than this indexer uses; only the
per-second burst during historical backfill trips it, and Ponder retries
automatically (the `HttpRequestError` warnings). **No paid plan is needed.** A free
Alchemy key has a higher burst ceiling if you want a quieter log. Decryption talks
to the Zama relayer/gateway, not Infura, so it doesn't consume RPC credits (beyond
the occasional `eth_call` to read a balance handle).
