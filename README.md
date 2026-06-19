# Confidential Indexer — ERC-7984 → cleartext read API

A small TypeScript Node service that watches a single **ERC-7984 confidential
token** on Sepolia, **auto-decrypts transfer amounts** the indexer holder is
entitled to (as a party to the transfer or via an ACL delegation) using the
**`@zama-fhe/sdk`**, and exposes an **ERC-20-style read API** with cleartext
balances and transfer history. A wallet partner can call it without learning FHE.

Built for the Zama _Tech Lead, Product Integrations_ take-home. The full brief is
in [`docs/CHALLENGE.md`](docs/CHALLENGE.md); the reasoning behind every choice is
in [`DECISIONS.md`](DECISIONS.md).

> **Status: in progress.** This repo is being built in small, reviewable commits.
> The architecture and decisions are locked (see below); the indexer, API, and
> tests land in subsequent commits. The run/test commands below describe the
> intended fresh-clone path and will be live as the code is committed.

## What it does

- Indexes `ConfidentialTransfer`, `AmountDisclosed`, and wrapper
  `UnwrapRequested` / `UnwrapFinalized` events for one ERC-7984 token (+ its
  ERC-20 wrapper) using **Ponder**.
- Decrypts each amount handle on index. Amounts the holder can't yet decrypt are
  **kept in an explicit `pending_rights` / `pending_propagation` state, never
  dropped**, and a **backfill worker** drains them once a partner grants
  delegation.
- Serves cleartext balances and transfer history over HTTP (Ponder's built-in
  Hono server), with every amount-bearing row carrying its decryption state so
  the partner sees the truth, not a clean lie.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
[`docs/SDK-NOTES.md`](docs/SDK-NOTES.md) for the grounded `@zama-fhe/sdk` API
reference (the brief warns LLM training data predates this package).

## Stack

| Concern | Choice |
| --- | --- |
| Indexer + reorgs + backfill + DB + HTTP | [Ponder](https://ponder.sh) (pglite embedded store, Hono server) |
| FHE decryption / delegation | [`@zama-fhe/sdk@alpha`](https://github.com/zama-ai/sdk) |
| Token + wrapper | OpenZeppelin `openzeppelin-confidential-contracts`, deployed via Foundry / [forge-fhevm](https://github.com/zama-ai/forge-fhevm) |
| Chain | Sepolia testnet |
| Tests | Vitest (e2e) + forge-fhevm (contracts) |

## Quick start

> Requires Node ≥ 22 and (for the contracts) Foundry. Uses **EOA test keys and
> toy values only** — never a real key.

```bash
git clone https://github.com/joelamouche/erc7984-confidential-indexer.git
cd erc7984-confidential-indexer
npm install
cp .env.example .env        # fill in SEPOLIA_RPC_URL, INDEXER_HOLDER_PRIVATE_KEY, TOKEN_ADDRESS, ...
```

### Run the indexer + API

```bash
npm run dev        # starts Ponder: indexes from START_BLOCK and serves the read API on PORT
```

### Call the API

```bash
# how far behind is the indexer?
curl localhost:42069/health

# current cleartext balance for an address
curl localhost:42069/v1/tokens/$TOKEN_ADDRESS/balances/$ADDRESS

# transfer history with cleartext amounts where available
curl "localhost:42069/v1/tokens/$TOKEN_ADDRESS/addresses/$ADDRESS/transfers?limit=20"
```

### Tests

```bash
npm test               # happy path: event in -> correct cleartext out of the API
npm run test:contracts # forge-fhevm contract tests
```

## Repository layout

```
contracts/   toy ERC-7984 token + ERC-20 wrapper (Foundry) + deploy script
src/         ponder config + schema, event handlers, Zama SDK wiring, backfill worker, API
test/        happy-path + one negative test
docs/        CHALLENGE.md (brief), ARCHITECTURE.md, SDK-NOTES.md
DECISIONS.md trade-offs, reflection, SDK feedback, AI-assistance notes
```

## Environment

Every variable the service reads is documented in
[`.env.example`](.env.example). No real keys or funds — Sepolia EOA test keys
only.
