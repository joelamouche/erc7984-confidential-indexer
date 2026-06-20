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
cp .env.example .env        # set SEPOLIA_RPC_URL (indexing); MNEMONIC defaults to a test phrase
( cd contracts && ./setup.sh )   # one-time: build the toy contracts (only needed to (re)deploy)
```

### End-to-end demo (fresh deploy → cleartext over the API)

The full path the brief asks for, verified on Sepolia:

```bash
npm run accounts     # print the role addresses; fund the FUNDER (index 0) from a Sepolia faucet
npm run fund         # funder fans gas out to deployer + indexer holder + test users
npm run deploy       # deploy ToyUSD + ConfidentialUSD; writes TOKEN/WRAPPER/START_BLOCK into .env
npm run seed         # users mint + wrap (shield) -> ConfidentialTransfer events
npm run dev          # start indexer + API: shields show up as kind=shield, decryptionState=pending_rights

# in another shell — a user grants the indexer decrypt rights, then it backfills cleartext:
npm run delegate     # user0 delegates to the holder (ACL event). After ~1-2 min gateway sync,
                     # the backfill decrypts user0's amounts -> decryptionState=decrypted, amount=cleartext.
                     # user1/user2 never delegate -> stay pending_rights (indexed, not dropped).

# confidential transfers between users (SDK-encrypted) — sent while the indexer runs,
# so you watch them get caught LIVE and decrypted-or-not by delegation:
npm run transfer -- 0 1 40   # user0 (delegated) -> user1: amount comes out CLEARTEXT in BOTH
                             #   histories — the amount handle is decryptable via user0's delegation,
                             #   even though user1 never delegated.
npm run transfer -- 1 2 30   # user1 -> user2: neither delegated -> stays pending_rights.

# unshield (unwrap confidential -> ERC-20) — the burn is decrypted via delegation:
npm run unshield -- 0 20     # user0 unwraps 20 cUSD; indexed as kind=unshield, cleartext via delegation.
```

> The transfer amount is ACL-allowed for **both** parties, so it decrypts if **either**
> party delegated to the holder — `npm run transfer -- 0 1 40` shows up as cleartext in
> user1's history despite user1 never delegating. Balances update too (user0: 100→60).

### Run the indexer + API on their own

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
npm test               # unit + integration (happy path: event in -> cleartext out of the API)
npm run test:contracts # forge-fhevm contract tests (run from contracts/ after ./setup.sh)
```

The unit test (error→state mapping) always runs. The two integration tests (a
delegated user's amount comes out as cleartext; a non-delegated user's amount is
surfaced as `pending_rights`, not dropped) hit the live API and **skip** unless the
demo above is running — so a fresh `npm test` stays green, and once the demo is up
they prove the end-to-end path.

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
docs/             CHALLENGE.md (brief), ARCHITECTURE.md, INDEXER.md, SDK-NOTES.md, AI-WORKFLOW.md, DEMO.md
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

Set `SEPOLIA_RPC_URL` to any Sepolia endpoint; the default is a public node
(no key). **Indexing alone is fine on a free Infura key** (Core plan: 6M
credits/day, 2k credits/sec — far more than indexing one contract needs; the
`HttpRequestError` warnings during backfill are just the per-second burst cap,
which Ponder retries automatically).

**But the SDK's decryption path is RPC-heavier than expected:** each decrypt makes
batched on-chain calls (an ACL delegation check, etc.), and on a free Infura key
those bursts get `-32005 Too Many Requests`, which surfaces as a confusing
`DECRYPTION_FAILED`. Use a **public node** (the default) or a **free Alchemy key**
for the decryption flow — both have enough burst headroom. (Found the hard way;
noted in DECISIONS as SDK feedback.)
