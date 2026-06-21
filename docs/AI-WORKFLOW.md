# How this was built with AI

I built this submission with **Claude Code** as a pair-programmer, not a code
vending machine. The difference shows up in the commit history: it isn't one big
"here's the app" drop, it's a sequence of small, verified steps where I set
direction and the tool did the legwork — and where I caught it when it was wrong.
This is the honest walkthrough.

## 0. Rule of engagement: frame before code

My first instruction was literally *"don't jump right in."* I had it read the
brief, my CV, and my prior Zama work (CipherMint), then produce an **analysis**:
what's ambiguous, where I'd push back, what the brief is really testing. No code on
turn one. That framing — the seam between an FHE rights model and a cleartext API,
the "never drop an event" rule, the delegation lifecycle — became the spine of the
whole project. Cheap to do, and it stopped me from building the wrong thing fast.

## 1. Ground against source, never against memory

The brief warns that *most LLM training data predates `@zama-fhe/sdk`*. So before
any integration code, I made the tool do something it doesn't do by default:
**read the actual installed package and the prerelease branch**, and write down
what it found (`docs/SDK-NOTES.md`, `docs/ARCHITECTURE.md`). This immediately paid
off — it had been about to use the **legacy** SDK shape from memory
(`createInstance`, `userDecrypt`) and a plain ERC-20 `Transfer` event, both wrong
(see §6). The rule for the rest of the build: against a fast-moving alpha, make it
*read the types*, not recall them.

## 2. Decide the forks explicitly, then scaffold

Rather than let it silently pick, I had it surface the branching decisions —
chain (Sepolia vs local), indexer (Ponder vs Subsquid vs hand-rolled), token model
— with a recommendation and the trade-off for each, and I chose. Those choices and
their reasoning went straight into `DECISIONS.md` as they were made, in the same
commits. The decision log is a byproduct of the process, not a thing I wrote at the
end.

## 3. Build outward-in, verify every layer on real Sepolia

The middle of the history is deliberately boring in the best way: one thin layer at
a time, each proven against the live chain before moving on.

- HD accounts + a funder fan-out → **ran it, watched gas land on six addresses.**
- Toy ERC-7984 + wrapper contracts → **forge tests green.**
- Deploy script → **hit a stuck nonce-0 tx, fixed it with explicit nonce + bumped
  fees, deployed for real**, wrote the addresses back to `.env`.
- Seed (shields) → **3 events on-chain.**
- Ponder indexer + read API → **queried the live API and saw the shields with
  honest `pending_rights` state.**

Each bullet is a commit. When something broke (the stuck nonce), the fix is in the
history with its reasoning, not silently patched.

## 4. The hard part, and the wall

Then the actual thesis: wire the Zama SDK so amounts decrypt as events are indexed.
I had it verify the SDK decryption **in isolation first** — a standalone script
that decrypted a delegated balance to `100000000`. It worked. Then the same call
**inside a Ponder handler threw** `__vite_ssr_import_meta__.resolve is not a
function`.

This is where a pair-programmer earns its keep. Instead of thrashing, I had it
diagnose the *difference* between the two contexts: Ponder runs handlers through
Vite's SSR transform, which rewrites `import.meta` and breaks the SDK's worker
bootstrap. The fix wasn't a hack — it was to run decryption **out-of-process** in
plain Node, which happens to be the exact decoupling you'd want for scale anyway.
The constraint pushed the architecture toward the right shape.

## 5. RPC reality, discovered by failing

Two more things only surfaced by actually running against the network, not by
reasoning:

- Free Infura **indexes** fine but **429s the SDK's decrypt** (it makes bursty
  batched `eth_call`s), surfacing as a misleading `DECRYPTION_FAILED`.
- A public node **decrypts** fine but **times out on Ponder's `getLogs`**.

So I split the RPCs — `SEPOLIA_RPC_URL` for indexing, `DECRYPT_RPC_URL` for the
SDK. Later, when a day-old catch-up crawled on throttled Infura, I had it bench a
faster free endpoint (drpc, ~23 req/s) and switch the default. None of this was
predictable from docs; it came from watching real failures and fixing the actual
cause.

## 6. The one subtly-wrong thing I had to correct

The honest answer the brief asks for: early on, from memory, it framed the whole
integration in the **legacy `@zama-fhe/relayer-sdk`** API —
`createInstance(SepoliaConfig)` / `createEncryptedInput` / `userDecrypt` / manual
keypair + EIP-712 — which is precisely the pre-3.x surface the new `ZamaSDK` class
replaces. It *looked* authoritative. If I'd trusted it, I'd have built against an
API that doesn't exist in this package. It also assumed a vanilla ERC-20
`Transfer(address,address,uint256)`; ERC-7984 actually emits
`ConfidentialTransfer(from, to, euint64 indexed amount)` with the amount as an
encrypted handle in a log topic. Both were caught by the §1 rule — forcing a
source-grounded pass before writing code — and both corrections are recorded in
`DECISIONS.md` (AI assistance).

## 7. Tests after the system existed — and being honest about coverage

Once the e2e worked, I asked a pointed question: *what's actually covered?* The
honest answer was "the happy path ran once, live" — thin. So I had it extract the
backfill's routing logic into a pure module and unit-test it (and the error→state
machine) directly, separate from the live integration tests. The point wasn't a
green checkmark; it was pinning the two most load-bearing pure units without
needing the chain.

## 8. Ticket-driven review (the part that feels like a real job)

Toward the end I switched to a workflow that mirrors how I'd actually run this with
a teammate: I filed **GitHub issues**, and the tool **claimed each one (a label +
a comment with its plan), did the work, and reported back on the ticket** before I
closed it.

- *"Missing test scenarios"* → it added confidential transfers between users,
  proved cleartext-or-not by delegation rights, and demonstrated **live** indexing
  (a transfer caught at head in seconds). Along the way it surfaced a genuinely
  nice subtlety: a transfer decrypts if *either* party delegated.
- *"any types"* → it explained the `db: any` was avoidable, typed it via Ponder's
  `Context`, and — the real win — that typing **caught two latent bugs** (a too-loose
  `via`, a non-narrowed nullable handle).
- *"Feedback on DECISIONS.md"* → it folded my corrections back in, including
  reframing the auth section from "defensible" to "a known hole I'm postponing."
- *"Prepare for demo" / "how far behind"* → designing the health endpoint, it
  pushed back on my own assumptions twice: it noted that firing huge transfer
  volumes would be the *wrong* way to test decryption-lag (volume drains
  successfully, so it never trips the health flag), and — when I doubted the
  "~1–2 min" propagation figure I'd been quoting from the SDK docs — it wrote a
  one-second-poll probe and **measured the real number: ~4 seconds.** That single
  measurement reshaped the retry design and the demo pacing. Exactly the
  "verify against reality" instinct I most wanted from it.

## What I take from it

The tool was fastest at the *legwork* — reading types, wiring layers, running the
chain dance, writing the boring-but-necessary scripts — and most dangerous when it
spoke from memory about a moving target. My job was to **set the frame, force it to
ground in source, choose the forks, and verify against reality at every step.** The
commit history is the receipt: small, reasoned, verifiable steps, with the wrong
turns left visible and explained rather than airbrushed out.
