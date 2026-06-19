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
cp .env.example .env        # set SEPOLIA_RPC_URL; MNEMONIC defaults to a test phrase; TOKEN_ADDRESS filled after deploy
```

### Run the indexer + API

```bash
npm run dev        # starts Ponder: indexes from START_BLOCK and serves the read API on PORT
```

### Call the API

```bash
# how far behind is the indexer + decrypt backlog
curl localhost:42069/v1/health

# current cleartext balance for an address
curl localhost:42069/v1/tokens/$TOKEN_ADDRESS/balances/$ADDRESS

# transfer history with cleartext amounts where available
curl "localhost:42069/v1/tokens/$TOKEN_ADDRESS/addresses/$ADDRESS/transfers?limit=20"

# build the unsigned tx a user signs to grant the indexer decrypt rights
curl -X POST localhost:42069/v1/tokens/$TOKEN_ADDRESS/delegations/quote
```

(Ponder also mounts its own `/health`, `/ready`, and `/status` on the same port.)

### Tests

```bash
npm test               # happy path: event in -> correct cleartext out of the API
npm run test:contracts # forge-fhevm contract tests
```

## Repository layout

```
contracts/        Foundry: ToyUSD + ConfidentialUSD (ERC-7984 wrapper) + forge-fhevm tests
ponder.config.ts  chains + indexed contracts (token + ACL, filtered to the holder)
ponder.schema.ts  database tables (see below)
src/index.ts      indexing handlers (record every amount with a decryption state)
src/api/          Hono read API (balances, history, delegations, health)
src/abis/         vendored event ABIs (topic-exact) so the indexer runs without compiling Solidity
src/config.ts     env parsing + HD account derivation
scripts/          accounts, fund, deploy, seed
docs/             CHALLENGE.md (brief), ARCHITECTURE.md, INDEXER.md, SDK-NOTES.md
DECISIONS.md      trade-offs, reflection, SDK feedback, AI-assistance notes
```

## Database tables

Ponder owns and reorg-manages the database; we define the tables in
`ponder.schema.ts` (it's [drizzle](https://orm.drizzle.team/) — fully
customizable). See [`docs/INDEXER.md`](docs/INDEXER.md) for how this is wired and
how decryption backfills cleartext.

| Table | One row per | Notable columns |
| --- | --- | --- |
| `transfers` | transfer / mint / burn / shield / unshield event | `amountHandle` (ciphertext, always set), `amount` (cleartext, when known), `decryptionState`, `kind`, `from`, `to` |
| `balances` | (token, account) | `balanceHandle`, `balance` (cleartext when entitled), `decryptionState` |
| `delegations` | (token, delegator) | which addresses granted the holder decrypt rights: `delegator`, `delegate`, `active`, `expiry` |

`decryptionState` (`pending_rights` → `pending_propagation` → `decrypted`, or
`failed`) appears on every amount-bearing row, so the API never hides an
undecryptable amount — it reports the state instead.

## Environment

Every variable the service reads is documented in
[`.env.example`](.env.example). All actors (funder, deployer, indexer holder,
test users) derive from **one HD mnemonic** at fixed indices; `scripts/fund.ts`
tops the others up from the funder (index 0, the only address you faucet). No real
keys or funds — the default mnemonic is the public hardhat/anvil test phrase.

### RPC rate limits

Set `SEPOLIA_RPC_URL` to any Sepolia endpoint. **A free Infura key is enough** —
its Core plan (6M credits/day, 2,000 credits/sec) far exceeds what indexing one
contract from its deploy block needs. During the initial historical backfill you
may see `HttpRequestError` warnings: that's the 2,000 credits/sec *burst* cap, and
Ponder retries automatically, so it's noise, not failure. A free Alchemy key has a
higher burst ceiling if you want a quieter log. Decryption talks to the Zama
gateway, not your RPC, so it doesn't consume RPC credits.
