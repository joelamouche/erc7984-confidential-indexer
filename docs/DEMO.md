# Demo runbook (for the screen recording)

A tight, copy-pasteable sequence for a 3–5 min walkthrough. Two terminals:

- **Terminal 1** — the indexer + API (long-running).
- **Terminal 2** — queries and live actions.

The story to tell: *on-chain confidential events go in; cleartext (or an honest
"pending") comes out of a normal REST API — and decryption follows on-chain
delegation, not an API key.*

---

## Before you hit record

The contracts are already deployed on Sepolia and the chain has demo history
(shields, a delegation, transfers, an unshield). So you don't need to deploy on
camera — just point `.env` at the deployment and run the indexer.

```bash
# .env essentials (already set if you ran the deploy):
#   SEPOLIA_RPC_URL="https://sepolia.drpc.org"     # fast indexing, no key
#   DECRYPT_RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
#   TOKEN_ADDRESS / WRAPPER_ADDRESS / START_BLOCK  # written by `npm run deploy`

npm install            # if fresh clone
npm run accounts       # note the role addresses; user0 is the delegated one
```

Export a few shell vars so the curls are copy-pasteable (Terminal 2):

```bash
export TOKEN=$(grep '^TOKEN_ADDRESS' .env | cut -d'"' -f2)
export U0=0xE80BCB2f35864E63Bd4E58E25C08538868eE1521   # user0 (delegated to the indexer)
export U1=0xA05a9Aba3327D9575Adf5B0Eb68387185ba1Bb2C   # user1 (NOT delegated)
export U2=0x4526AC35c2BbDB3890DA3901Fd5B3b1F568f1015   # user2 (NOT delegated)
alias jqp='python3 -m json.tool'
```

> Tip: start the indexer ~1–2 min before recording if you want it already caught
> up. Or record the catch-up — `/v1/health` going `degraded → ok` is a nice live
> illustration of "how far behind."

---

## Terminal 1 — start the indexer + API

```bash
npm run dev
```

Point at: Ponder's TUI — it indexes **two** contracts (the ERC-7984 token *and*
the fhEVM **ACL**, filtered to our holder), and serves the API at
`http://localhost:42069`. Leave it running.

---

## Terminal 2 — the walkthrough

### 1. How far behind is the indexer?

```bash
curl -s localhost:42069/v1/health | jqp
```

Point at the **two axes**: `indexing` (blocksBehind / secondsBehind vs the chain
head) and `decryptBacklog` (how much cleartext is still pending). If you're
recording the catch-up, re-run this and watch `blocksBehind` fall to 0 and
`status` flip `degraded → ok`.

### 2. A delegated user's history — all cleartext

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U0/transfers" | jqp
```

Point at: user0 **delegated** decrypt rights to the indexer, so every amount comes
out cleartext — a `shield`, two `transfer`s, and an `unshield`, each
`decryptionState: "decrypted"`, `decryptedVia: "delegation"`. Note the `unshield`
also carries `unwrapStatus: "requested"` — we know the amount, but the gateway
hasn't finalized the unwrap yet (a real in-between state, surfaced honestly).

### 3. The money shot — a non-delegated user

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U1/transfers" | jqp
```

Point at user1, who **never delegated**:
- their own `shield` and their outgoing `transfer` to user2 are `pending_rights`,
  `amount: null` — **indexed, never dropped**, just not decryptable by us;
- but the `transfer` they **received from user0** is **cleartext** — because the
  transfer amount handle is readable by *both* parties, and user0 (the sender)
  delegated. Decryption follows on-chain rights, exactly.

### 4. Current balance

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/balances/$U0" | jqp   # decrypted
curl -s "localhost:42069/v1/tokens/$TOKEN/balances/$U1" | jqp   # pending_rights
```

### 5. How a partner gets a user to delegate (the indexer never holds a key)

```bash
curl -s -X POST "localhost:42069/v1/tokens/$TOKEN/delegations/quote" | jqp
```

Point at: the API returns an **unsigned** transaction (`to` = ACL contract,
`data`, `chainId`). The wallet has its user sign and send it; the indexer only
*builds* it. Then `GET .../delegations/$U1` shows whether a user has delegated.

### 6. Live indexing — send an event on camera

With Terminal 1 still running, in Terminal 2:

```bash
npm run transfer -- 0 1 5     # user0 sends 5 cUSD to user1 (SDK-encrypted)
```

Wait ~15–20s, then re-run the user1 history:

```bash
curl -s "localhost:42069/v1/tokens/$TOKEN/addresses/$U1/transfers" | jqp
```

Point at: the new transfer appears **live** (no restart, no re-scan) and is
already `decrypted` (user0 is delegated). That's realtime indexing + decrypt.

---

## Appendix — full reproduction from a fresh clone

If you want to show the whole thing end-to-end (slower; has on-chain waits):

```bash
# Terminal 2 — one-time setup
npm install
cp .env.example .env                 # set SEPOLIA_RPC_URL (drpc is fine, no key)
npm run accounts                     # fund the FUNDER (index 0) from a Sepolia faucet
npm run fund                         # funder -> deployer + holder + users
npm run deploy                       # deploys token+wrapper; writes addresses to .env
npm run seed                         # users mint + wrap (shield)

# Terminal 1
npm run dev                          # indexer + API

# Terminal 2 — drive the scenarios
npm run delegate                     # user0 delegates to the holder (ACL event)
#   ⏳ wait ~1–2 min: the gateway must sync the delegation before decrypt works.
#      Watch a shield flip pending_rights -> decrypted in the API (the backfill).
npm run transfer -- 0 1 40           # cleartext to both (user0 delegated)
npm run transfer -- 1 2 30           # pending (neither delegated)
npm run unshield -- 0 20             # unshield; kind=unshield, unwrapStatus=requested
```

Timing notes for the recording:
- **Indexer catch-up** from the deploy block is seconds-to-~2-min depending on how
  old the deploy is (drpc is ~23 req/s). `/v1/health` shows the progress.
- **Delegation propagation** is ~1–2 min (the gateway syncs ACL state cross-chain).
  That's why a freshly-delegated user's amounts sit in `pending_propagation`
  briefly before flipping to `decrypted`.

## Tests (optional to show)

```bash
npm test                 # unit + (if the demo above is live) integration matrix
npm run lint             # no `any` allowed
```
