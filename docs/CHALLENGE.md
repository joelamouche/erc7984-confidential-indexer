# Challenge brief (verbatim)

> This is the take-home challenge sent by **Ankur** (Zama) for the
> [Tech Lead, Product Integrations](https://jobs.zama.org/jobs/tech-lead-product-integrations_paris)
> role. It is reproduced here unedited as the source of truth for scope and
> acceptance criteria. Nothing in this repo is production code or uses real
> funds/keys.

---

We use this fictional, self-contained challenge to understand how you approach
product-integration engineering in our domain. Nothing you build will be used in
production.

## Objective

This challenge assesses your ability to design and ship a small piece of
infrastructure that sits between the Zama Protocol and a partner product. We are
looking for signals on indexer design, transaction-lifecycle judgement, fluency
with the Zama SDK in a real backend setting, and the engineering taste you bring
to the seam between an FHE-aware service and a familiar cleartext-style API.

A successful submission is a small, well-tested service plus a DECISIONS.md that
argues clearly for its choices.

## The task

### Scenario

A wallet partner wants to show their users an ERC-20-style view of their
ERC-7984 confidential token holdings: cleartext balances, a transfer history
with cleartext amounts, and read endpoints that look like any other indexer. The
wallet does not want to learn FHE — it wants to call your service.

You are building the confidential indexer: a small Node service that watches a
single ERC-7984 confidential token contract, auto-decrypts all transfer amounts
the indexer holder has decryption rights on (as a party to the transfer or via
an ACL delegation), and exposes a small read API with cleartext data.

We expect you to compose existing primitives — an off-the-shelf indexing
library, the Zama SDK for decryption, a database of your choice, an HTTP server —
not to write a new EVM indexer from scratch in a few hours. What we want to see
are the choices you make: which primitives you pick, why, and how cleanly you
wire them together. Storage, throttling, and how the API surfaces the awkward
in-between states are all your call.

### Build

A single TypeScript Node project that proves an end-to-end path from a fresh
clone to a running indexer plus queryable API.

- **Indexer:** Use an existing indexing library to track the events relevant to
  balance and transfer history (confidential transfers and shield/unshield
  activity) on a single ERC-7984 contract. Wire the Zama SDK in so amounts are
  decrypted as events are indexed; cleartext lands in your database. Events the
  holder is not currently entitled to decrypt must not be silently dropped.
  Partners may grant decrypt rights later, and the indexer should be able to
  backfill cleartext when that happens.
- **Read API:** A small HTTP service that lets a partner ask, at minimum: what is
  the current cleartext balance for an address?, what is the transfer history for
  an address, with cleartext amounts where available?, and how healthy and how
  far behind is the indexer? Endpoint shapes, paths, field names, pagination, and
  error taxonomy are all your design. Partner DX is part of what we are
  evaluating.
- **DECISIONS.md:** Document and defend the trade-offs you made — what you
  composed, what you wrote yourself, what you cut, and where you would push back
  on the brief. We do not want a checklist; we want to see how you think.
- **Light tests:** A happy-path test that proves an event going in produces
  correct cleartext coming out of the API. One negative test of your choice —
  pick one and explain why.

### Reflection (in DECISIONS.md)

- Pick one piece of what you built — a function, a callback, a chunk of the
  indexer config, an API handler — that you are least confident about under
  partner load. What would break first, and how would you prove it?
- What did you cut from this submission, and what would you do first if you had
  another four hours?
- **SDK feedback (we genuinely want this):** You have now been a user of
  `@zama-fhe/sdk` for a few hours. Pick two or three specific improvements you
  would make: a missing API, a confusing name, an error that did not help you
  debug, a doc gap, a footgun. For each, say (a) the concrete change, (b) the
  partner-integration scenario it unblocks, and (c) where it sits in priority
  order against the others. We are not looking for a grievance list; we are
  looking for the shape of feedback you would bring to a design review.
- **AI assistance:** If you used Copilot, Claude Code, ChatGPT, or similar,
  explain the process of how you leveraged these tools. Also explain one place it
  gave you something subtly wrong that you had to correct.

### Constraints

- **SDK:** Install from the alpha channel: `npm i @zama-fhe/sdk@alpha` and refer
  to docs in the prerelease branch. This includes significant
  refactors/improvements we're working on.
- **Chain:** Sepolia testnet or a local fhEVM stack via forge-fhevm
  (<https://github.com/zama-ai/forge-fhevm>). Pick whichever lets you iterate
  fastest.
- **No production data, no real funds, no shared secrets.** Toy values, EOA test
  keys, `.env.example` only.
- **Storage:** Any choice of database (whether embedded or not) is fine. We are
  not testing your ops setup.

### Useful starting points

- Zama SDK repo: [zama-ai/sdk](https://github.com/zama-ai/sdk). Note this is the
  high-level `@zama-fhe/sdk`, not the legacy `@zama-fhe/relayer-sdk` (which is
  wrapped as a dependency). Most public LLM training data predates this package.
- The `examples/` folder in the SDK repo has working integrations against Sepolia
  in both ethers and viem flavours, including delegated decryption.
- For local fhEVM dev: [zama-ai/forge-fhevm](https://github.com/zama-ai/forge-fhevm).
  The SDK's own contract tests use it.
- Branches matter: the prerelease branch tracks the alpha. Stable docs lag — pin
  to prerelease for accurate references.

### Time and scope

You have one week to submit. We expect roughly 3 to 4 focused hours of work, not
a full week of polish. If a part is taking much longer than that, stop and write
the reasoning into DECISIONS.md. We would rather see a small, sharp submission
with strong trade-off notes than a sprawling one.

### Submission

- A Git repository (public preferred; if private, let us know and we'll tell you
  which GitHub handles to add).
- A `README.md` with copy-pasteable setup, run, and test instructions.
- All source, tests, and a `DECISIONS.md`.
- A `.env.example` with every variable you read. Never commit a real key.
- (Optional but useful) a 3–5 minute screen recording walking us through the
  indexer running and one read-API call.

In case you need any clarifications, please let me know. Otherwise, good luck with
the submission!
