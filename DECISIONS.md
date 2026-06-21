# DECISIONS

A working log of the trade-offs, written as the project was built. **Design
decisions** first (each: the call, why, and the sharp bits), then the
**reflections** the brief asks for. Deep mechanism lives in
[ARCHITECTURE](docs/ARCHITECTURE.md) / [INDEXER](docs/INDEXER.md); this is the
*why*.

## Decisions at a glance

| # | Decision | In one line |
| --- | --- | --- |
| 1 | **Chain: Sepolia**, not local forge-fhevm | the decryption-rights model only exercises for real against the live gateway |
| 2 | **Indexer: Ponder** | TS-native, embedded DB + Hono, "compose don't build" — but the SDK can't run *inside* it (§2) |
| 3 | **Deploy our own toy ERC-7984 + wrapper** | the only way to grant rights on demand and show the backfill |
| 4 | **Explicit per-amount `decryptionState`** | "never drop / backfill later" turned into a data model |
| 5 | **Event-driven rights discovery** (index the ACL) + decryption off the indexing path | learn delegations from events, not trial-and-error; never block ingestion |
| 6 | **Storage: Ponder's pglite** | zero-setup; storage explicitly not graded |
| 7 | **One HD mnemonic**, role-indexed, funder fans gas | one secret, reproducible actors |
| 8 | **No API auth** — postponed, documented as a real gap | scoped out by the brief; not pretending it's fine |

## How I read the brief

The "ERC-20 view of confidential holdings" headline is the easy part. The graded
signal lives in three places, and I optimised for them over breadth:

1. **The decryption-rights lifecycle.** One holder identity ⇒ an amount isn't
   cleartext-or-nothing; it has states (`pending_rights` → `pending_propagation` →
   `decrypted` / `failed`). The brief is emphatic: never silently drop, and
   backfill when rights arrive later. That loop is the most interesting thing.
2. **Transaction-lifecycle judgement** — reorgs, the async gap between "indexed"
   and "decrypted," the delegation propagation window. The API must be honest
   about "I see it but don't have cleartext yet."
3. **Taste at the seam + concrete SDK feedback.**

I treated "3–4 focused hours" as a forcing function — cut breadth (§ Reflections)
to make the lifecycle and the API honesty actually good.

---

# Design decisions

## 1. Chain: Sepolia (not local forge-fhevm)

The heart of the brief is decryption rights + ACL delegation, which only behave
for real against the live Zama gateway (local stacks mock it away). Cost: slower
iteration + faucet dependence — mitigated by using forge-fhevm for the
deterministic *contract* tests and Sepolia for the decrypt path. Pushback on "pick
whichever iterates fastest": for this task the slow part *is* the gateway, which
local doesn't help. **Lived precedent:** in the Zama Builder Program (CipherMint) I
had FHE tests pass locally then fail on Sepolia — I'm validating against the real
gateway from the start this time.

## 2. Indexer: Ponder

TypeScript-native, embedded store (pglite), reorg + backfill handling, plain-TS
handlers, and a built-in Hono server so the API and indexer share one process/DB.
The brief says **compose, don't build an EVM indexer** — Ponder is the cleanest
compose. Rejected: Subsquid (heavier than a 3–4h task wants), hand-rolled
`getLogs` (that's *building* the indexer).

**The thing I got wrong:** I'd planned to "call the SDK inline" in a handler — it
**can't be done.** Ponder runs handlers through Vite's SSR transform, and the SDK's
`node()` transport finds its worker via `import.meta.resolve`, which SSR rewrites
to an undefined shim → `__vite_ssr_import_meta__.resolve is not a function`. The
same call works in plain Node. So decryption runs **out-of-process** (a spawned
plain-Node helper) — which is the decoupling I'd want for scale anyway (§5). This
became SDK-feedback #1. Detail: [INDEXER §5](docs/INDEXER.md).

## 3. Token: our own toy ERC-7984 + ERC-20 wrapper (OpenZeppelin)

Owning the contract lets me control the event stream, **grant ACL delegation on
demand** (the only way to actually demo "rights granted later → backfill"), and
get real `wrap`/`unwrap` events. Clarified from the brief: "shield/unshield" isn't
ERC-7984 core — it's the wrapper. `wrap` = a zero-address `ConfidentialTransfer`;
`unwrap` is two-phase (`UnwrapRequested` → `UnwrapFinalized`), and
`UnwrapFinalized.cleartextAmount` is plaintext on-chain — a free cross-check.

## 4. Explicit per-amount state machine

Decrypt via `sdk.decryption.decryptValues` (holder is a party) /
`delegatedDecryptValues` (delegated), and map SDK errors onto an explicit
`decryptionState` column instead of try/catch-and-drop. That column is the brief's
"don't drop / backfill later" turned into data — surfaced on every amount-bearing
API row, and what the backfill queries. (Open tension, defended in ARCHITECTURE:
balance via decrypting the on-chain `confidentialBalanceOf` handle — survives
rights gaps — vs. summing deltas, kept only as a logged cross-check.)

## 5. Event-driven rights discovery + decryption off the indexing path

**Index the fhEVM ACL contract** (filtered to our holder) as a second source, so a
`delegations` table is the holder's live picture of what it may decrypt. Why over
pure trial-and-error: the moment a user delegates, the indexer *knows* and promotes
their pending rows — instead of every not-yet-permitted amount costing a failed
gateway round-trip. (The error path stays as a safety net.)

**Decryption never blocks indexing.** A gateway decrypt is slow + rate-limited, so
it's off the indexing path — on a block-interval backfill today, shaped to move
onto a separate queue/worker fleet that scales independently ([INDEXER §6](docs/INDEXER.md)).

**"Rights observed" ≠ "rights usable," and we detect the gap by *trying*, not
polling.** The ACL grant emits an event immediately, but delegated decrypt only
works once the gateway syncs cross-chain. There's no usable propagation status to
query (`isActive` reads the host chain, true before the gateway syncs), so the
backfill just retries; **the first attempt that returns cleartext is the signal.**
I *measured* the real delay (poll every 1s after a fresh delegation): **~4 seconds**
(user1 3.9s, user2 3.5s, first attempt) — not the "1–2 min" the SDK docs cite as
worst case. So the user-visible flip is gated by our backfill cadence, not the
gateway. Because real propagation is seconds, a row still "propagating" after
`MAX_PROPAGATION_ATTEMPTS` (5) is escalated `pending_propagation → failed`, so it
surfaces in `/v1/health` instead of hiding behind a reassuring label.

**Delegation facilitation — and what I'm *not* satisfied with.** `POST
.../delegations/quote` returns the inputs for the SDK's `delegateDecryption(...)`
(preferred) + a raw unsigned tx (fallback); the indexer never holds a user key. But
the SDK's pitch is to abstract crypto plumbing, and the user *still signs a tx*. The
irreducible part: delegation is the user's **authorization** — no SDK can remove
the signature. What the SDK abstracts is tx construction, which is why I lead with
`sdkDelegateInput` over raw calldata. Honest limit: **rights delegation is a wallet
action, not an indexer action.** v2: an EIP-712 typed-data permit (sign a message,
not a tx) if the ACL ever supports it.

## 6. Storage: Ponder's pglite

Embedded Postgres, zero-setup on fresh clone. The brief says storage isn't graded;
Postgres is a one-env-var swap when scaling out (§ Reflections).

## 7. Test accounts: one HD mnemonic, role-indexed

Every actor (funder=0, deployer=1, holder=2, users=3+) derives from **one
mnemonic** rather than a grab-bag of `*_PRIVATE_KEY`s; `scripts/fund.ts` fans gas
from the funder (the only address you faucet). One secret, no raw keys, and
deterministic actors — the same Alice/Bob in scripts, seed data, and tests. The
holder is deliberately **separate** from the deployer: it's a pure decryption
identity that signs EIP-712 off-chain and needs ~no gas. Default mnemonic is the
public hardhat test phrase.

## 8. API auth — postponed under time pressure (a known gap, not a non-issue)

The read API ships **unauthenticated**, and I won't pretend that's fine: an open
endpoint returning a user's cleartext balances to anyone is a real hole. I'm
deferring it because the brief scopes auth out ("no shared secrets / not testing
ops," not in the API-design list). Blast-radius limiter (not a fix): the indexer
only holds cleartext for addresses that delegated, so it can't fabricate data for
non-opted-in users — but it *does* leak opted-in users to any caller. How I'd close
it: a single-customer **`X-API-Key`** (the caller is the wallet's backend) shuts the
hole; a per-user model keeps the key as the gate and uses **SIWE/EIP-712 only to
prove address ownership** (`user_addresses` table), scoping responses to
ownership ∩ decrypt-rights. Those auth tables are off-chain, not Ponder-managed.

## 9. Where I'd push back on the brief

- **"Cleartext balance for an address"** assumes the indexer can decrypt arbitrary
  addresses — it structurally can't (ACL is per-handle). I surface this via
  `decryptionState` instead of implying universal visibility; the honest framing is
  *the indexer is a delegated observer for opted-in users*.
- **"Pick whichever chain iterates fastest"** — the slow path is the gateway, not
  the chain (§1).
- A **single-holder indexer + multi-address API** is an inherent mismatch; the real
  product question (out of scope) is whether the indexer should manage per-user
  delegated identities at all.

---

# Reflections (brief)

## Least-confident component under partner load

The **backfill decryption tick.** The indexer is cheap and Ponder carries it;
decryption is the scarce, network-bound, rate-limited resource. If a partner's
transfer volume outruns decrypt throughput, the backlog grows and `/v1/health`'s
`decryptable` shows it rising — that's what breaks first, and it's a *gateway*
limit, not a Ponder one. I'd prove it with a load probe: K transfers/min, watch
backlog depth and decrypt latency, find the rate where the backlog stops draining —
that's the single-process ceiling. Mitigations + the Postgres/worker-fleet scale-out
are in [INDEXER §6](docs/INDEXER.md); this is exactly why decryption is decoupled
(§5).

## What I cut, and the next four hours

**Cut (safely, for this exercise):** API auth (§8); a real decryption worker/queue
(today it's a per-tick subprocess — works, doesn't scale); the unwrap/unshield path
end-to-end (handlers exist + a delegated unshield is verified, but the gateway never
*finalized* an unwrap for our contract, so the public-`UnwrapFinalized` cleartext
path is coded-but-unproven, and the forge test is a stub); deeper API-layer tests;
multi-token, websocket push, observability beyond `/health`, CI.

**Next four hours, in order:** (1) close the auth hole — the `X-API-Key` middleware
(§8), highest security payoff; (2) promote decryption to a **RabbitMQ broker + two
worker pools** (`live.decrypt` autoscaled vs `backfill.decrypt` capped, so a
delegation storm can't starve realtime), writing to Postgres — [INDEXER §6](docs/INDEXER.md);
(3) exercise + test unwrap/unshield (the one path with no live proof); (4) API tests
via a small DI refactor; (5) light observability + CI.

## SDK feedback (concrete, design-review-shaped)

Three findings from actually wiring decryption in, by impact — each **verified
against the installed source**, each in the brief's _Fix / Unblocks / Priority_
shape. Full root-cause analysis, the fix-difficulty breakdown, and an
**AI-native-SDK** section are in **[docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md)**.

**1. The `node()` transport can't locate its worker inside a bundler.** Decryption
from any bundler-based backend (Ponder, Next.js, Remix — anything on Vite/esbuild)
throws `__vite_ssr_import_meta__.resolve is not a function`. The exact same code run
directly with `node`/`tsx` works, so the failure looks like your own build config,
not the SDK — which is what made it a multi-hour misattribution. Root cause
(verified, `dist/esm/node/index.js`): the worker is located with
`import.meta.resolve("@zama-fhe/sdk/node")`, and a bundler's SSR transform replaces
`import.meta` with a shim that has `.url` but not `.resolve`. The `worker_threads`
design is correct and stays; only the worker *path lookup* is at fault.
- **Fix:** locate the worker with `import.meta.url` instead — `new Worker(new
  URL("./relayer-sdk.node-worker.js", import.meta.url))` — which bundlers do provide
  and which is also their native worker-asset pattern; ship a `workerUrl` escape
  hatch + a named error first. Loses nothing (the worker is a sibling file, so the
  export-map indirection bought nothing).
- **Unblocks:** in-process decryption inside the backends partners actually run; I
  had to shell decryption out to a separate plain-Node process to dodge it.
- **Priority:** #1 — a hard blocker for the most common integration surface.

**2. Errors point at the wrong fix.** An RPC 429 during the SDK's own on-chain
`eth_call` surfaces as `DECRYPTION_FAILED` (so you "fix decryption," not the RPC);
and `DelegationNotPropagatedError` is — per the SDK's own docstring — a *heuristic*
over a bare HTTP 500 that "can also be an unrelated internal error." There's also no
way to *query* whether a delegation has propagated (`isActive` reads the host chain,
true before the gateway syncs), so you can only fail-and-retry against that heuristic.
- **Fix:** a typed `RpcRateLimitedError` (detect 429/`-32005`); distinguish
  propagation-lag from gateway-error; expose an `isPropagated()` check.
- **Unblocks:** every free-tier-RPC partner, and correct (non-guessy) retry loops.
- **Priority:** #2 — a guaranteed time-sink with a misleading trail.

**3. Duplicate decrypt APIs + the legacy shadow.** `sdk.decryption` ships a
lower-level pair (`userDecrypt` / `delegatedUserDecrypt`) *and* a convenience pair
(`decryptValues` / `delegatedDecryptValues`) with no "prefer this" signpost; and the
package wraps the legacy `relayer-sdk`, whose `createInstance`/`userDecrypt` shape is
what nearly every doc + LLM still emits.
- **Fix:** one documented entrypoint, `@deprecated` the rest, a "migrating from
  relayer-sdk" symbol map.
- **Unblocks:** faster onboarding for humans *and* AI agents (which can't guess the
  canonical path — see the AI-native section in the linked doc).
- **Priority:** #3 — a papercut, but it taxes every new integrator.

## AI assistance

Built with **Claude Code** as a daily-driver. Full narrative:
**[docs/AI-WORKFLOW.md](docs/AI-WORKFLOW.md)**. The short version:

- **Process:** frame before code (analyse, surface ambiguities, push back — no code
  on turn one); build outward-in, verifying each layer on real Sepolia in small
  commits; then **drive the work via GitHub issues I filed and the agent
  claimed/answered/fixed** — which is where most of the real corrections happened
  (below). A safeguard I imposed up front: **ground the SDK against the installed
  package + prerelease branch, not model memory** — and it earned its keep, catching
  the agent's *own* from-memory first draft, which used the legacy
  `@zama-fhe/relayer-sdk` shape (`createInstance`/`userDecrypt`) and a plain ERC-20
  `Transfer` event instead of ERC-7984's `ConfidentialTransfer(from, to, euint64
  indexed amount)`. The lesson, applied throughout: against a fast-moving alpha,
  make the tool *read the installed types*, never recall them.

- **The subtly-wrong thing *I* had to correct.** The most impactful catch was mine,
  not the agent's. It had been confidently quoting "~1–2 min" for delegation
  propagation — lifted straight from the SDK docs — and had baked that figure into
  the retry windows and the demo pacing. I didn't believe it, and asked it to
  *measure* (delegate a fresh user, poll the decrypt every 1s). Reality was **~4
  seconds** — off by ~30×. That one correction reshaped the retry/escalation design
  and the demo, and is now documented as a doc gap in the SDK feedback. The pattern
  recurred: the agent produced plausible, doc-consistent output, and my job was to
  distrust it where it mattered and force verification against reality — e.g. it
  first shipped a one-dimensional `/v1/health` `status` (and a version where the two
  axes meant different things), which I sent back until it was a uniform two-axis
  model. The agent is fast and tireless at the legwork; the judgement about *what to
  verify and where the plausible answer is wrong* stayed with me.
