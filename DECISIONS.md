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

## 2. Indexer: Ponder (not Subsquid, not hand-rolled viem)

**Decision:** **Ponder** as the indexing library.

**Why:** TypeScript-native, ships an embedded store (pglite), handles reorgs and
historical backfill, and — the deciding factor — its event handlers are plain TS
where I can call the Zama SDK inline and write the decrypt-on-index logic without
fighting a processor abstraction. Its built-in Hono server means the read API and
the indexer share one process and one DB with no glue. The brief explicitly says
**compose, don't build an EVM indexer** — Ponder is the cleanest "compose."

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

## 7. Where I'd push back on the brief

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

## 8. Reflection — least-confident component under partner load

_(to be completed after implementation — candidate as of design: the
decrypt-on-index path inside the Ponder event handler. Decryption is a
synchronous-looking `await` over an async gateway call inside the indexing loop;
under a burst of transfers this serialises indexing behind network latency and
rate limits. Hypothesis for what breaks first and how I'd prove it to be filled
in with the real handler + a load probe.)_

## 9. Reflection — what I cut, and the next four hours

_(to be completed — running list of cuts as they happen: e.g. per-user identity
management, websocket/subscription API, auth on the read API, multi-token support,
metrics/observability beyond /health. Plus the ordered "next 4h" list.)_

## 10. SDK feedback (concrete, design-review-shaped)

_(to be completed after a few hours of real use — seeded candidates from initial
grounding, to be confirmed/reprioritised against actual integration pain:)_

- **`NoCiphertextError` (HTTP 400) conflates two states.** It means both "you lack
  rights, retry after a grant" and "this handle genuinely has no ciphertext." An
  indexer's retry policy needs to tell these apart. _(change / scenario / priority
  to be argued.)_
- **`DelegationNotPropagatedError` is a heuristic over a bare HTTP 500.** A real
  gateway error masquerades as "just wait 30s." _(change / scenario / priority.)_
- **Sub-path import surface** (`/node`, `/chains`, `/ethers`, `/viem`) +
  self-registering `node()` transport is easy to wire wrong with no clear error.
  _(change / scenario / priority.)_

## 11. AI assistance

I used **Claude Code** (this submission's authoring environment) throughout, as a
daily-driver agentic tool. Process and the specific subtly-wrong thing it produced
_(expanded as the build proceeds)_:

- **Process:** problem analysis and pushback-framing first; then I deliberately
  had it **ground the SDK API against the prerelease branch and the installed
  package rather than model memory**, because the brief warns training data
  predates `@zama-fhe/sdk`. That grounding lives in `docs/SDK-NOTES.md`.
- **One thing it got subtly wrong (already caught):** from memory it initially
  described the integration in terms of the **legacy** `@zama-fhe/relayer-sdk`
  shape — `createInstance(SepoliaConfig)`, `createEncryptedInput`, `userDecrypt`,
  manual keypair + EIP-712 — which is exactly the pre-3.x API that the new
  `ZamaSDK` class supersedes. It also initially assumed a plain ERC-20
  `Transfer(address,address,uint256)` event; the real ERC-7984 emits
  `ConfidentialTransfer(from, to, euint64 indexed amount)` with an **encrypted
  handle** in a log topic. Both were corrected by forcing a source-grounded
  research pass before any code. _(More instances added as they occur.)_
