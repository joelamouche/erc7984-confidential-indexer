# CLAUDE.md — context for AI agents working in this repo

## What this is

A take-home submission for Zama's **Tech Lead, Product Integrations** role. It's a
**confidential indexer**: a Node/TypeScript service that watches one ERC-7984
confidential token on Sepolia, auto-decrypts transfer amounts via `@zama-fhe/sdk`,
and serves a cleartext ERC-20-style read API. The full brief (from Ankur at Zama)
is in [`docs/CHALLENGE.md`](docs/CHALLENGE.md) — treat it as the source of truth
for scope and acceptance.

This is a **portfolio/recruitment artifact**, so two things matter as much as the
code:
1. **Clean, regular, reviewable commits** — small logical commits with clear
   conventional-commit messages. The commit history is itself evaluated.
2. **`DECISIONS.md`** — every non-trivial choice gets argued there as it's made,
   not retrofitted. Update it in the same commit as the change it explains.

## Hard constraints (from the brief)

- **SDK:** `@zama-fhe/sdk@alpha` (the high-level package), **not** the legacy
  `@zama-fhe/relayer-sdk`. Pin to the prerelease branch's behaviour. Most LLM
  training data predates this package — **do not write SDK calls from memory;
  verify against [`docs/SDK-NOTES.md`](docs/SDK-NOTES.md)** or the installed
  package / prerelease branch.
- **No real keys, funds, or secrets.** All actors derive from a single HD
  **mnemonic** (role-indexed: funder=0, deployer=1, indexer holder=2, test
  users=3+); `scripts/fund.ts` fans gas from the funder. Default is the public
  hardhat/anvil test phrase — never a seed controlling real funds. `.env.example`
  lists every variable; never commit a real `.env`.
- **Scope:** ~3–4 focused hours. Favor a small, sharp submission with strong
  trade-off notes over breadth. If something balloons, write the reasoning into
  `DECISIONS.md` and cut it.

## Key technical facts (verified, not from memory)

- ERC-7984 emits **`ConfidentialTransfer(address indexed from, address indexed to,
  euint64 indexed amount)`** — the amount is an **encrypted handle** (bytes32 log
  topic), not cleartext. There is **no plain `Transfer`**. Mint/burn reuse it with
  the zero address.
- `AmountDisclosed(euint64 indexed handle, uint64 amount)` is a public cleartext
  reveal — index it to backfill amounts without holder rights.
- Balance is **`confidentialBalanceOf(address) → euint64`** (encrypted handle).
- Wrapper = `ERC7984ERC20Wrapper`; **`wrap`/`unwrap`** (not shield/unshield in
  code). `wrap` shows up as a zero-address `ConfidentialTransfer`; `unwrap` is
  two-phase (`UnwrapRequested` → `UnwrapFinalized`), and
  `UnwrapFinalized.cleartextAmount` is plaintext on-chain.
- ACL is **per-handle**; persistent rights go only to the handle owner + contract.
  A third party (our indexer holder) decrypts only via `FHE.allow(handle, addr)` /
  SDK delegation. Delegation has a gateway propagation delay (**measured ~4s** on
  Sepolia; SDK docs cite up to ~1–2 min worst case) surfaced as
  `DelegationNotPropagatedError`.
- New SDK shape: `new ZamaSDK(createConfig({...}))`, `sdk.decryption.decryptValues`,
  `sdk.decryption.delegatedDecryptValues`, `sdk.delegations.delegateDecryption`.
  See [`docs/SDK-NOTES.md`](docs/SDK-NOTES.md).

## Architecture in one line

Ponder indexes the events → each amount handle gets an explicit
`decryptionState` (`decrypted | pending_decrypt | pending_rights | pending_propagation | failed`) →
decrypt-on-index via the SDK with the holder identity → backfill worker drains
`pending_*` rows when delegations arrive → Hono read API serves cleartext + state.
Full design in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Working agreements

- Update `DECISIONS.md` in the same commit as the decision it documents.
- Conventional commits (`feat:`, `docs:`, `chore:`, `test:`, `fix:`). One logical
  change per commit; keep them reviewable.
- Don't silently drop undecryptable events — that's the brief's central rule.
- Prefer composing the chosen primitives over hand-rolling; if you hand-roll
  something the libraries should do, justify it in `DECISIONS.md`.
- Keep `.env.example` in sync with every `process.env` / config var you read.

## Code style preferences

- **Name variables for what they hold**, not their shape. No `rows` / `items` /
  `r` / `d` / `x`; prefer `pendingTransfers`, `decryptItems`, `transfer`,
  `delegation`, `current`. Single-letter params are OK only in trivial idiomatic
  scopes (a loop `i`, a zod `(v) => …` transform).
- **Every named/exported function gets a short doc comment** (`/** … */`) saying
  what it does and any non-obvious why — so the code reads top-down without
  decoding the body. Inline anonymous callbacks don't each need one.
- **Comment generously — err toward more explanation.** Any non-obvious constant,
  config value, magic number, or tricky line gets a comment on *why* (e.g. a `BATCH`
  size should explain the throughput implication; an `interval` should explain the
  cadence it produces). Prefer over-explaining to leaving the next reader guessing.
