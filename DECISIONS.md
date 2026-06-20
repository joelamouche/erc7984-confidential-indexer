# DECISIONS

This is a working decision log, written as the project is built, not a
retrospective checklist. Sections marked _(to be completed during/after
implementation)_ are deliberate placeholders — the brief asks for reflection on
what was actually built, so I'd rather fill them with real observations than
guesses. Entries are roughly chronological so the reasoning is auditable
alongside the commit history.

---

## 0. How I read the brief

The headline ("ERC-20 view of confidential holdings") is the straightforward
part. The signal I think is actually being graded lives in three places, and I've
optimised for them over feature breadth:

1. **The decryption-rights lifecycle.** The indexer holds one identity. It can
   only decrypt amounts it's a party to or has been delegated. So a transfer
   amount is not binary (cleartext / not) — it has explicit states:
   `pending_rights`, `pending_propagation`, `failed`, `decrypted`. The brief is
   emphatic that undecryptable events must **not be silently dropped** and that
   the indexer must **backfill** when rights arrive later. That backfill loop is
   the most interesting thing to get right.
2. **Transaction-lifecycle judgement.** Reorgs, the gap between "event indexed"
   and "amount decrypted" (decryption is an async gateway round-trip, not local
   compute), and the cross-chain delegation propagation window. The API has to be
   honest about "I see the transfer but don't have cleartext yet."
3. **Engineering taste at the seam + concrete SDK feedback.** Composing the right
   primitives cleanly and bringing back design-review-shaped SDK feedback.

I treated the 3–4h guidance as a forcing function: deliberately cut breadth
(below) to make the rights lifecycle and the API honesty actually good.

---

## 1. Chain: Sepolia (not local forge-fhevm)

**Decision:** run the primary path against **Sepolia testnet**.

**Why:** the heart of the brief is the decryption-rights and ACL-delegation
model. That only exercises for real against the live Zama gateway —
`userDecrypt`, delegated decrypt, and the cross-chain propagation delay all
behave differently (or are mocked away) on a local stack. forge-fhevm deploys the
real host contracts but decryption is the part I most need to be _real_.

**Cost I'm accepting:** slower iteration and faucet dependence. I mitigate by
using **forge-fhevm for fast contract unit tests** (the deterministic part) and
reserving Sepolia for the end-to-end decrypt path and the demo. Where I'd push
back on the brief: "pick whichever lets you iterate fastest" implicitly assumes
local is faster — for this task the slow part is the gateway, which local doesn't
help with, so the iteration-speed argument partly inverts.

**Lived precedent.** During the Zama Builder Program (CipherMint) I had FHE
contract tests pass green locally and then *fail on Sepolia* — the gateway/coprocessor
behaviour the local stack mocks is exactly where reality bites. That burned me
once; this time I'm validating the decrypt path against the real gateway from the
start rather than discovering the gap at demo time.

## 2. Indexer: Ponder (not Subsquid, not hand-rolled viem)

**Decision:** **Ponder** as the indexing library.

**Why:** TypeScript-native, ships an embedded store (pglite), handles reorgs and
historical backfill, and its event handlers are plain TS where I write the
decrypt-on-index *orchestration* without fighting a processor abstraction. Its
built-in Hono server means the read API and the indexer share one process and one
DB with no glue. The brief explicitly says **compose, don't build an EVM indexer**
— Ponder is the cleanest "compose."

**Correction (what I got wrong about Ponder).** My original pitch said I could
"call the Zama SDK inline" in a handler. That turned out to be **false**: the SDK
cannot run inside a Ponder indexing handler at all. Ponder executes handler code
through **Vite's SSR transform**, and the SDK's `node()` transport locates its
worker-thread entry with `import.meta.resolve(...)`. Vite SSR rewrites `import.meta`
to an internal shim that has no `resolve`, so the call throws
`__vite_ssr_import_meta__.resolve is not a function`. The exact same call works in
plain Node (the isolation test proved it). So I run the *decryption itself* in a
short-lived plain-Node child process (`scripts/decrypt-handles.ts`) that the
backfill spawns. **What's still true:** the read API + indexer share one process
and one DB, and the handlers are plain TS — only the SDK call had to move
out-of-process. And that move is the decoupling I'd have wanted for scale anyway
(see §5), so the constraint pushed me toward the right shape. Full detail in
[`docs/INDEXER.md` §5](./docs/INDEXER.md#5-decrypting-the-customization-that-makes-this-a-confidential-indexer).

**Rejected:** Subsquid (heavier processor/archive model than a 3–4h task wants);
hand-rolled `viem.getLogs` loop (that _is_ writing the indexer the brief says not
to). rindexer was tempting for minimalism but Ponder's reorg/backfill maturity
wins.

## 3. Token model: deploy a toy ERC-7984 + ERC-20 wrapper (OpenZeppelin)

**Decision:** deploy our **own** toy `ERC7984` token plus an
`ERC7984ERC20Wrapper`, from OpenZeppelin `openzeppelin-confidential-contracts`.

**Why:** owning the contract lets me (a) control the event stream, (b) grant ACL
delegation to the indexer holder _on demand_ — which is the only way to actually
demo the "partner grants rights later → indexer backfills" requirement, and (c)
get real `wrap`/`unwrap` (shield/unshield) events rather than faking them.
Finding an existing token on Sepolia would kill the delegation demo.

**Clarified from the brief's wording:** "shield/unshield" isn't ERC-7984 core —
it's the wrapper extension. `wrap` surfaces only as a zero-address
`ConfidentialTransfer`; `unwrap` is two-phase (`UnwrapRequested` →
`UnwrapFinalized`), and `UnwrapFinalized.cleartextAmount` hands us a plaintext
amount on-chain. I lean into that: it's a free authoritative cross-check on
SDK-decrypted values.

## 4. Decryption strategy & the per-amount state machine

**Decision:** decrypt on index via `sdk.decryption.decryptValues` (holder is a
party) / `sdk.decryption.delegatedDecryptValues` (delegated), and map SDK errors
onto an explicit per-amount state rather than try/catch-and-drop. States:
`decrypted | pending_rights | pending_propagation | failed`. See
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#per-amount-state-machine) and the
error→state table in [`docs/SDK-NOTES.md`](./docs/SDK-NOTES.md).

**Why:** this is the brief's "do not silently drop" + "backfill later" turned into
a data model. The state is a first-class column, surfaced on every amount-bearing
API row, and is what the backfill worker queries.

**Open tension I'm tracking:** balance-as-decrypted-on-chain-handle vs.
balance-as-summed-deltas. I chose decrypting the on-chain
`confidentialBalanceOf` handle as source of truth (survives rights gaps; correct
for shield/unshield) and keep delta-reconstruction only as a logged consistency
check. Defended in ARCHITECTURE.

## 5. Rights discovery is event-driven (index the ACL contract), + delegation facilitation

**Decision:** the indexer treats the canonical fhEVM **ACL contract** as a second
indexed source, topic-filtered to its own holder
(`DelegatedForUserDecryption` / `RevokedDelegationForUserDecryption` where
`delegate == holder`, plus optionally `Allowed` where `account == holder`). A
`delegations` table is the holder's live picture of what it may decrypt.

**Why this over pure trial-and-error:** catching `NoCiphertextError` per handle
and parking as `pending_rights` works, but it's reactive and noisy — every
not-yet-permitted amount costs a failed gateway round-trip. Indexing ACL events
means the moment a partner user delegates, the indexer *knows*, promotes that
user's `pending_rights` amounts, and decrypts them after the propagation window.
The error path stays as a safety net for anything the events didn't predict.

**And decryption must never block indexing.** A gateway decrypt is slow
(hundreds of ms to seconds) and rate-limited; doing it on the indexing path would
stall event ingestion behind network latency under any real load. So decryption is
deliberately *off* the indexing path — driven by the block-interval backfill today,
and shaped to move onto a **separate queue/worker that scales independently** of
the indexer (§6 and `docs/INDEXER.md`). Event-driven rights discovery feeds that
queue precisely (only the now-decryptable rows) instead of having the indexer
spin on speculative decrypts.

**A timing subtlety I'm encoding (verified on-chain):** the
`DelegatedForUserDecryption` event is emitted **immediately** at grant, but
delegated decryption only works **~1–2 min later** (the gateway syncs ACL state
cross-chain on Arbitrum). So "rights observed" ≠ "rights usable" — they're
separate states (`pending_rights` → `pending_propagation` → `decrypted`).

**Delegation facilitation — and the security boundary I won't cross.** Partners
need a frictionless way for their users to grant rights. The SDK's
`sdk.delegations.delegateDecryption(...)` signs+sends from the configured signer,
which would mean the indexer holding user keys — a non-starter. Instead the API
exposes `POST .../delegations/quote` that returns an **unsigned** tx
(`{ to: aclAddress, data, chainId }`) built with the SDK's calldata-only helper
`delegateForUserDecryptionContract(...)`; the user's wallet signs and sends. The
indexer constructs intent, the user authorizes. A `GET .../delegations/:address`
status route (backed by `sdk.delegations.isActive`/`getExpiry`) closes the loop.

**Correction logged:** the first research pass reported the ACL grant as taking
an `address[] contractAddresses`. The on-chain function is
`delegateForUserDecryption(address delegate, address contractAddress, uint64 expirationDate)`
— a single contract (or the wildcard `0xFF…FfF` = all contracts). Verified against
`host-contracts/contracts/ACL.sol`. Noted here because getting this wrong would
have produced calldata that reverts.

## 6. Storage: Ponder's embedded pglite

**Decision:** use Ponder's built-in store (pglite, embedded Postgres). The brief
says storage choice is explicitly not graded ("not testing your ops setup"), so I
optimise for zero-setup-on-fresh-clone over production-shaped infra. Postgres is a
one-env-var swap if needed.

## 7. Test accounts: one HD mnemonic, role-indexed, with a funder fan-out

**Decision:** every actor — funder, deployer, indexer holder, and N test users —
derives from a **single HD mnemonic** at fixed BIP-44 indices, rather than a
grab-bag of `*_PRIVATE_KEY` env vars. A `scripts/fund.ts` reads the **funder**
(index 0, the only address you top up from a faucet) and fans out role-appropriate
gas to the rest.

**Why:** (a) one secret instead of five, and no raw private keys in `.env`;
(b) deterministic, reproducible actors — the same mnemonic yields the same Alice,
Bob, deployer everywhere (the script, the seed data, the tests), which makes the
"realistic multi-party activity" the demo needs trivial to regenerate from a fresh
clone; (c) it matches how Foundry/anvil already think (`--mnemonic` +
`--mnemonic-index`), so the contract and TS sides share one account model.

**Role split (see `.env.example`):** deployer is **separate** from the indexer
holder on purpose — the holder is a pure decryption identity that signs EIP-712
off-chain and submits no transactions, so it needs ~no gas; the deployer needs the
most (FHE-heavy deploys); test users get small amounts sized to what they do
(transfer / wrap / unwrap / delegate). Funding amounts are env-configurable so a
thin faucet balance still gets a working demo.

**Boundary kept:** the default mnemonic in `.env.example` is the public
hardhat/anvil test phrase — convenient and obviously not a real key. The repo
never derives or stores a key controlling real funds.

## 8. API authentication — postponed under time pressure (a known gap, not a non-issue)

**Decision:** the read API ships **unauthenticated** for this submission — and I
want to be clear that this is a **deliberate postponement under the exercise's time
box, not a claim that it's fine.** An open endpoint that returns a user's cleartext
balances and transfer amounts to *anyone who can reach it* is a real security hole.
I'm not minimizing it; I'm deferring it because the brief explicitly scopes auth
out ("no shared secrets / .env.example only / not testing your ops setup," and auth
isn't in the API-design list) and asks for something small and sharp.

**One thing that does limit the blast radius** (mitigation, not a fix): the indexer
only ever holds cleartext for addresses that delegated to the holder, so the API
can't fabricate cleartext for users who never opted in. But for the users who *did*
opt in, an open API leaks their balances — so this must be closed before anything
real.

**How I'd close it:**

- **Single API customer → `X-API-Key` is enough.** The intended caller is the
  wallet's backend, not end users ("the wallet … wants to call your service"). One
  partner consuming the API → a shared `X-API-Key` (off unless an `API_KEY` env var
  is set, to keep fresh-clone DX zero-config), upgrading to mTLS / a signed JWT in
  production. This alone shuts the open-endpoint hole.

- **Per-user accounts (when end users hit the API directly).** `X-API-Key` stays
  the gate; on top of it:
  1. A **profile** is created behind the API key (or via a signed nonce if there's
     no trusted front-end to vouch for the user).
  2. **Address ownership is proven by signature.** This is the *only* place SIWE /
     EIP-191/712 is load-bearing: a user proves control of each address they want to
     read by signing, and the service stores `(user_id, address, verified_at)` in a
     `user_addresses` table. (SIWE is for *proving address ownership*, not as the
     primary auth gate — that's the API key.)
  3. **Scope every response** to the requesting user's *verified* addresses.

  Visibility is then the intersection of two gates: **ownership** (addresses the
  user proved) ∩ **decrypt-rights** (addresses the holder can decrypt). The
  `profiles` / `user_addresses` tables are **off-chain** (not reorg-derived), so
  they live in a separate store / plain Postgres tables written by the API — *not*
  Ponder `onchainTable`s, consistent with the indexer-owns-onchain-tables rule in
  [`docs/INDEXER.md`](./docs/INDEXER.md#4-the-database-tables-our-customization-of-ponders-db).

## 9. Where I'd push back on the brief

- "Current cleartext balance **for an address**" assumes the indexer can decrypt
  arbitrary addresses. It structurally can't — ACL rights are per-handle and only
  the owner (or a delegate) can decrypt a balance. I surface this honestly via
  `decryptionState` instead of implying universal visibility. The realistic
  framing is: the indexer is a **delegated observer** for the partner's opted-in
  users.
- "Pick whichever chain iterates fastest" — addressed in §1; for this task the
  slow path is the gateway, not the chain.
- A single-holder indexer + a multi-address API is an inherent mismatch; I think
  the interesting product question (out of scope here, flagged for discussion) is
  whether the indexer should manage _per-user_ delegated identities at all.

---

## 10. Reflection — least-confident component under partner load

The **backfill decryption tick** (the `block`-interval handler that drains
`pending_*` rows through the gateway). The indexer itself is cheap and Ponder
carries it; decryption is the scarce, network-bound, rate-limited resource. Under
a partner whose transfer volume outruns decrypt throughput, the `pending_*`
backlog grows unbounded and `/v1/health` shows rising `secondsBehind` + backlog
counts — that's what breaks first, and it's a *gateway-throughput* limit, not a
Ponder one. I'd prove it with a load probe: seed K transfers/min, watch backlog
depth and decrypt latency, and find the rate at which the backlog stops draining —
that number is the single-process ceiling. Full analysis, the batching/bounded-
concurrency mitigations, and the Postgres + worker-fleet scale-out path are in
[`docs/INDEXER.md` §6](./docs/INDEXER.md#6-designing-for-scale--and-what-the-brief-actually-asks).
This is also exactly why decryption is **decoupled** from the transfer handler
(§4) rather than run inline.

## 11. Reflection — what I cut, and the next four hours

**What I cut (and why it was safe to cut for this exercise):**

- **API auth** (§8) — the biggest one; scoped out by the brief, but a real gap.
- **A real decryption worker / queue.** Today decryption is a subprocess spawned
  per backfill tick (forced out-of-process by the Vite constraint, §2). That's
  fine for the demo but pays a process-spawn + SDK-init cost each tick and can't
  scale horizontally. The documented shape (Postgres + a long-lived worker fleet,
  §6) is *designed* but not built.
- **The unwrap / unshield path end-to-end.** The contract supports it and the
  `UnwrapRequested` / `UnwrapFinalized` (+ `AmountDisclosed`) handlers exist, but
  no demo event exercises them, and the forge test is a stub — so that branch is
  unrun. Shield is fully covered; unshield isn't.
- **API-layer tests** (pagination, error taxonomy, `/delegations/quote`) — need a
  small dependency-injection refactor of `src/api` to test off a seeded store.
- **Multi-token, subscription/websocket push, observability beyond `/health`,
  ESLint enforcement + CI.** All reasonable v2, none load-bearing for the thesis.

**If I had another four hours, in order:**

1. **Close the auth hole** — the `X-API-Key` middleware from §8. Cheapest action
   with the highest security payoff; it's the one cut I'm uncomfortable shipping.
2. **Promote decryption to a broker + worker pools.** Since the SDK can't run
   inside Ponder anyway, standalone workers are its natural home. Move to RabbitMQ
   with **two queues** — `live.decrypt` (autoscaled, keep head fresh) and
   `backfill.decrypt` (capped, low-priority, drains a newly-delegated address's
   whole history) so a delegation storm can't starve realtime — writing cleartext
   to Postgres. `/v1/health` then reports **two** freshness numbers (live lag vs
   per-address backfill backlog). Full design in
   [`docs/INDEXER.md` §6](./docs/INDEXER.md#6-designing-for-scale--and-what-the-brief-actually-asks).
3. **Exercise + test unwrap/unshield** — the one feature path with no live proof.
4. **API tests via the DI refactor** — pin pagination, the 404/422 taxonomy, and
   the delegation-quote calldata.
5. **Light observability + CI** — decrypt latency / backlog gauges and a GitHub
   Action running `typecheck` + `test` + `forge test`.

## 12. SDK feedback (concrete, design-review-shaped)

Three findings from actually wiring decryption into a backend, in priority order.

**1 — The `node()` transport can't run under a bundler's SSR runtime (highest).**
The worker bootstrap uses `import.meta.resolve`, which Vite/esbuild SSR replaces
with an undefined `__vite_ssr_import_meta__.resolve`. The decrypt then throws
`__vite_ssr_import_meta__.resolve is not a function` — opaque, and it cost the most
time to diagnose (the same call works in plain Node, so it looks like an
environment gremlin).
- **(a) Change:** don't depend on `import.meta.resolve` to locate the worker;
  resolve via a packaged worker entry / `new URL('./worker.js', import.meta.url)`
  with a CJS fallback, or expose a `workerPath` option. At minimum, detect the
  missing resolver and throw a *named* error that says "run me outside SSR."
- **(b) Unblocks:** decryption inside **Ponder**, **Next.js** route handlers,
  **Remix loaders** — i.e. exactly the backends a wallet partner already runs. I
  had to shell out to a plain-Node subprocess to work around it.
- **(c) Priority:** #1 — a hard blocker for the most common integration surface.

**2 — RPC rate-limit failures masquerade as `DECRYPTION_FAILED`.** When the RPC
429s during the SDK's internal `eth_call` (the ACL delegation check), the error
surfaces as `DECRYPTION_FAILED` wrapping an ethers `BAD_DATA / missing response`.
Nothing says "your RPC throttled me," so it reads as "rights/decryption are
broken."
- **(a) Change:** detect upstream 429/`-32005` and throw a typed
  `RpcRateLimitedError` (carrying the provider status), distinct from a real
  decryption failure.
- **(b) Unblocks:** every partner on a free-tier RPC (we burned an hour here before
  splitting the RPC). Also worth documenting that decryption is *RPC-heavy* — it
  makes batched on-chain calls, which is surprising for something that "talks to
  the gateway."
- **(c) Priority:** #2 — not a hard blocker, but a guaranteed time-sink with a
  misleading error.

**3 — Two names for the same operation, and the legacy shadow.** `sdk.decryption`
exposes both `userDecrypt`/`delegatedUserDecrypt` *and*
`decryptValues`/`delegatedDecryptValues` (subtly different signatures), and the
package wraps the legacy `@zama-fhe/relayer-sdk` whose `createInstance` /
`userDecrypt` shape is what every doc and LLM still shows.
- **(a) Change:** pick one decrypt name and deprecate the other; ship a short
  "migrating from relayer-sdk" page mapping old → new symbols.
- **(b) Unblocks:** faster onboarding — I spent real time disambiguating which
  method was the intended entrypoint (resolved by reading the source, see
  `docs/SDK-NOTES.md`).
- **(c) Priority:** #3 — a naming/doc papercut, not a blocker, but it taxes every
  new integrator.

## 13. AI assistance

I built this with **Claude Code** as a daily-driver agentic tool. The full,
step-by-step narrative of how — what I delegated, where I made it ground against
source instead of trusting memory, where it went wrong, and the ticket-driven
review loop — is in **[`docs/AI-WORKFLOW.md`](./docs/AI-WORKFLOW.md)**. The short
version the brief asks for:

- **Process:** frame before code (analyze the brief, surface ambiguities, push
  back — no code on turn one); then **ground the SDK against the prerelease branch
  and the installed package rather than model memory** (the brief warns training
  data predates `@zama-fhe/sdk`); then build outward-in, verifying each layer on
  real Sepolia with small commits; then iterate via GitHub issues I filed and it
  claimed/answered/fixed.

- **The thing it got subtly wrong (and I caught):** from memory it first described
  the integration in the **legacy `@zama-fhe/relayer-sdk`** shape —
  `createInstance(SepoliaConfig)`, `createEncryptedInput`, `userDecrypt`, manual
  keypair + EIP-712 — the exact pre-3.x API the new `ZamaSDK` class supersedes. It
  also assumed a plain ERC-20 `Transfer(address,address,uint256)` event; the real
  ERC-7984 emits `ConfidentialTransfer(from, to, euint64 indexed amount)` with an
  **encrypted handle** in a log topic. Both would have sent me down a wrong path;
  both were caught by forcing a **source-grounded research pass before any code**
  (now `docs/SDK-NOTES.md`). The lesson I leaned on for the rest of the build:
  against a fast-moving alpha, make the tool *read the installed types*, never
  recall them.
