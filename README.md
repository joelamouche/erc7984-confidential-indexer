# Confidential Indexer — ERC-7984 → cleartext read API

A small TypeScript service that watches one **ERC-7984 confidential token** on
Sepolia, **auto-decrypts transfer amounts** the indexer holder is entitled to (as
a party, or via an ACL delegation) using **`@zama-fhe/sdk`**, and serves an
**ERC-20-style read API** — cleartext balances and transfer history. A wallet
partner calls it without learning FHE.

Built for Zama's _Tech Lead, Product Integrations_ take-home ([full brief](docs/CHALLENGE.md)).

### The interesting part — the seam

The amount in a `ConfidentialTransfer` is an **encrypted handle**, and the indexer
holds **one** decryption identity. So an amount isn't cleartext-or-nothing — it has
a lifecycle the API surfaces honestly instead of hiding:

```
indexed ▶ pending_decrypt ─backfill, no rights yet─▶ pending_rights ─user delegates─▶ pending_propagation ─gateway sync ~4s─▶ decrypted
              (or, if the holder is already entitled, pending_decrypt ─▶ decrypted directly)
```

Each `pending_*` state names *what we're waiting on*: **us** (`pending_decrypt`,
queued), the **user** (`pending_rights`, no rights yet), or the **gateway**
(`pending_propagation`, grant not synced).

Events the holder can't yet decrypt are **never dropped** — they're kept with an
explicit `decryptionState`, and a backfill **decrypts them later** when a partner
grants rights. The whole design defends this lifecycle: see **[DECISIONS.md](DECISIONS.md)**.

## Quick start

Requires Node ≥ 22. `.env.example` is pre-pointed at our **live Sepolia
deployment**, so you can index real data in one step:

```bash
npm install
cp .env.example .env          # set SEPOLIA_RPC_URL (any Sepolia endpoint); rest has working defaults
npm run dev                   # indexes our deployed token + serves the API on :42069
```

```bash
curl localhost:42069/v1/health                                              # how far behind + decrypt backlog
curl localhost:42069/v1/tokens/$TOKEN_ADDRESS/balances/$ADDRESS             # cleartext balance (or honest pending)
curl "localhost:42069/v1/tokens/$TOKEN_ADDRESS/addresses/$ADDRESS/transfers" # history, cleartext where available
```

> Cleartext for the live data was decrypted by **our** holder identity. With the
> default mnemonic you'll see the events + honest `pending_rights` states; for the
> cleartext payoff, **watch the video** or run the full demo with your own funded
> mnemonic. The end-to-end demo (deploy → seed → delegate → transfer → unshield,
> all on Sepolia) is scripted and narrated in **[docs/DEMO.md](docs/DEMO.md)**.

## API

| Endpoint | Returns |
| --- | --- |
| `GET /v1/tokens/:token/balances/:address` | cleartext balance + `decryptionState` |
| `GET /v1/tokens/:token/addresses/:address/transfers?cursor=&limit=` | paginated history; cleartext where available |
| `GET /v1/tokens/:token/delegations/:address` | has this address delegated to the holder? |
| `POST /v1/tokens/:token/delegations/quote` | inputs/unsigned-tx for a user to grant the holder rights |
| `GET /v1/health` | two-axis status: indexing lag + decryption backlog |

Shapes, pagination, and error taxonomy: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Tests

```bash
npm test                 # unit (always) + integration (skip unless the demo is live)
npm run lint             # no `any` allowed
npm run test:contracts   # forge-fhevm contract tests (from contracts/, after ./setup.sh)
INTEGRATION_SLOW=true npm test -- transition   # gated: full pending→delegate→decrypted on Sepolia
```

Happy path (event → cleartext via the API) + a negative test (no-rights address →
honest `pending`, never fabricated) + the gated transition test.

## How it works (one screen)

- **Ponder** indexes two contracts: the ERC-7984 token (+wrapper) for activity, and
  the fhEVM **ACL** filtered to our holder — so delegations are discovered from
  events, not guessed.
- Indexing stays fast and deterministic; **decryption is decoupled** onto a
  block-interval backfill (the SDK can't run inside Ponder's Vite SSR runtime — see
  [INDEXER.md §5](docs/INDEXER.md)). Idempotent, keyed by the ciphertext handle.
- The read API is Ponder's built-in **Hono** server; the DB is its embedded pglite.

Full design: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** · indexer deep-dive +
scale: **[docs/INDEXER.md](docs/INDEXER.md)**.

## Stack

| Concern | Choice |
| --- | --- |
| Indexer + reorgs + backfill + DB + HTTP | [Ponder](https://ponder.sh) (pglite + Hono) |
| FHE decryption / delegation | [`@zama-fhe/sdk@alpha`](https://github.com/zama-ai/sdk) |
| Token + wrapper | OpenZeppelin confidential-contracts, deployed via [forge-fhevm](https://github.com/zama-ai/forge-fhevm) |
| Chain | Sepolia |

## Docs

| Doc | What's in it |
| --- | --- |
| **[DECISIONS.md](DECISIONS.md)** | the trade-offs, reflections, SDK feedback, AI-assistance notes — start here |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | full design: events, state machine, API shapes, data model |
| [docs/INDEXER.md](docs/INDEXER.md) | how Ponder is wired, decryption backfill, designing for scale |
| [docs/SDK-NOTES.md](docs/SDK-NOTES.md) | grounded `@zama-fhe/sdk` alpha reference (training data predates it) |
| [docs/SDK-FEEDBACK.md](docs/SDK-FEEDBACK.md) | detailed SDK feedback: root causes, fix analysis, AI-native-SDK |
| [docs/DEMO.md](docs/DEMO.md) | terminal-by-terminal demo runbook |
| [docs/AI-WORKFLOW.md](docs/AI-WORKFLOW.md) | how this was built with Claude Code |
| [docs/CHALLENGE.md](docs/CHALLENGE.md) | the brief, verbatim |

## Layout & environment

```
contracts/        Foundry: ToyUSD + ConfidentialUSD (ERC-7984 wrapper) + forge-fhevm tests
ponder.config.ts  indexed contracts (token + ACL, filtered to the holder)
ponder.schema.ts  DB tables: transfers, balances, delegations
src/index.ts      indexing handlers   src/backfill.ts  decryption backfill
src/api/          Hono read API        src/abis/        vendored event ABIs
scripts/          accounts · fund · deploy · seed · delegate · transfer · unshield
```

All actors derive from **one HD mnemonic** at fixed indices (funder=0, deployer=1,
holder=2, users=3+); `scripts/fund.ts` fans gas from the funder. No real keys —
the default is the public hardhat test phrase. Every variable is in
[`.env.example`](.env.example).

> **RPC note:** any Sepolia endpoint works for indexing; the SDK's decryption path
> is RPC-heavy and 429s on a free Infura key, so it uses a separate `DECRYPT_RPC_URL`
> (a public node by default). Details in [DECISIONS.md](DECISIONS.md) (SDK feedback).
