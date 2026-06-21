# SDK feedback — `@zama-fhe/sdk`

Design-review-shaped feedback from wiring `@zama-fhe/sdk@3.1.0-alpha.15` into a
real backend indexer. Every claim below is **verified against the installed
source** (paths cited), not recalled. [DECISIONS.md](../DECISIONS.md) carries the
three-line summary; this is the detail, the root-cause analysis, and an
**AI-native-SDK** section (relevant to the role's "treat AI agents as first-class
SDK consumers" mandate).

Order is by impact: (1) the bundler/worker blocker, (2) misleading errors, (3) API
ergonomics, then (4) AI-native surface.

---

## 1. `node()` can't find its worker inside a bundler — highest impact

### What happens

Calling decryption from a backend that runs through a JS bundler — Ponder (what
this project uses), Next.js route handlers / server components, Remix loaders,
SvelteKit, anything built on Vite or esbuild — throws:

```
__vite_ssr_import_meta__.resolve is not a function
```

Run the **exact same code directly with `node` or `tsx` and it works.** Because it
only breaks under the bundler, and the error names Vite internals rather than
anything Zama, the natural assumption is that your own build config is wrong — so
you debug your app, not the SDK. That misdirection is what made it expensive (we
only resolved it by isolating decryption in a separate plain-Node process).

### Two independent design choices — only the second is the problem

It's worth separating these up front, because the critique and the fix touch only
one of them — and a reviewer's first instinct will be to defend the other.

**Choice A — run FHE in a `worker_threads` pool. _Correct; keep it; the fix does not
touch it._** FHE work (transport-keypair generation, ciphertext re-encryption, proof
handling) is CPU-bound and synchronous; on the main thread it would block Node's
event loop and stall the server. Offloading to a worker pool is the right backend
design. **We lose none of this.**

**Choice B — locate the worker file with `import.meta.resolve(...)`. _This is what
breaks._** Verified in `dist/esm/node/index.js`:

```js
createWorker() {
  const base = new URL(import.meta.resolve("@zama-fhe/sdk/node"));   // ← the break
  return new Worker(new URL("relayer-sdk.node-worker.js", base));
}
```

(Also verified: the `./node` subpath is **ESM-only** — `package.json` `exports` has
no CJS build for it — so you can't sidestep via `require` either.)

### Why they used `import.meta.resolve` — the legitimate intent (so you can pre-empt it)

`import.meta.resolve(spec)` runs Node's module resolver on a specifier and returns
its URL, honoring the package `exports` map and node_modules layout.
`import.meta.url`, by contrast, is just the URL of the *current file*.

Resolving the package's **own subpath** (`"@zama-fhe/sdk/node"`) rather than using
`import.meta.url` is a deliberate "find the worker inside the installed package,
wherever it lives" instinct — robust to monorepos, pnpm symlinks, and the case where
the *consumer's* code is bundled while the SDK stays in node_modules. It's
spec-compliant and stable since Node 20.6, and the SDK targets Node ≥ 22. **In a
pure-Node ESM runtime it's a reasonable, even tasteful choice.** That's the steelman;
have it ready.

### Why it breaks

A bundler doesn't run your ESM as-is — it transforms each module and replaces
`import.meta` with a controlled object so it can manage resolution itself. Vite's is
`__vite_ssr_import_meta__`; it provides `.url` (set to the module's real file URL)
and `.env`, but deliberately **not** `.resolve` — once a bundler owns resolution, a
runtime `resolve()` doesn't fit its model. So `import.meta.resolve(...)` becomes
`undefined(...)`. esbuild/Turbopack behave the same way. In other words: the
choice that is *most correct for pure Node* is exactly the one bundlers don't carry
over.

### The fix — and, precisely, what it would cost

**The code change is small and loses nothing of value.** Because the worker is a
**sibling file** of `node/index.js`, the export-map indirection buys nothing here —
the same file is reachable from `import.meta.url`, which bundlers *do* provide:

```js
new Worker(new URL("./relayer-sdk.node-worker.js", import.meta.url));
```

| Runtime | `import.meta.resolve` (today) | `import.meta.url` (fix) |
| --- | --- | --- |
| Plain Node (SDK in node_modules) | ✅ works | ✅ works |
| **Bundler SSR transform** (Ponder/Next/Remix today) | ❌ `.resolve` undefined | ✅ `.url` is provided |
| SDK statically bundled into the app | ❌ (path lost) | ✅ *if* the bundler emits the worker asset — see below |

**What we'd lose by switching: nothing real.** The only thing `import.meta.resolve`
did beyond `import.meta.url` was resolve through the export map — which matters only
if the worker were *not* a sibling of the module. It is a sibling, so there's no
capability lost; the `worker_threads` architecture (Choice A, the part with the good
reason) is untouched. If anything `import.meta.url` is *more* faithful: it points at
the file that is actually executing, which is what you want when locating a sibling.

**Why this is a "small change" but not "one commit and done" — the cross-bundler
tail.** Shipping a worker *from inside a library* is historically the flaky corner
of JS bundling, because each bundler discovers and emits worker assets differently:

- **Vite / Rollup** natively recognize the literal `new Worker(new URL("./x.js",
  import.meta.url))` form and emit `x.js` as a separate chunk — no config.
- **webpack 5** supports the same pattern but via its asset/worker handling, which
  some setups must enable.
- **esbuild** needs the worker declared as an entry point (it won't auto-emit it).
- **Turbopack / Bun / Metro** each differ again, and configs like `ssr.noExternal`
  or monorepo hoisting change where the emitted worker lands.

So the *diff* is a few lines, but "**done**" means a **test matrix** — build a tiny
consumer on Vite, Next.js, Remix, and webpack, run a decrypt in each, and confirm
the worker is found and spawned — plus a per-bundler note where config is required.
That validation + documentation is the actual cost I mean by "cross-bundler test
coverage," not the code. It's bounded, well-trodden work, not research.

### Recommendation — ship in two steps

1. **Now, trivial, zero-risk:** add a `node({ workerUrl })` option (point at the
   worker explicitly) **and** guard the resolve call — if `import.meta.resolve` is
   absent, throw a named `ZamaWorkerResolutionError`: *"the node() worker couldn't be
   located — you're likely under a bundler; pass `workerUrl` or see <link>."* This
   alone converts a multi-hour misattributed debug into a 30-second fix, before any
   deeper change lands.
2. **Then, small + validated:** switch to the `import.meta.url` pattern, backed by
   the cross-bundler test matrix above. (Optional belt-and-suspenders: a synchronous
   no-worker fallback for environments where a worker can't be spawned at all —
   slower, but functional instead of broken.)

**Net for the reviewer:** a defensible original design *for a pure-Node world*; a
narrow but real break under bundlers, which is where much of the backend audience
lives; a fix with no architectural downside; and a clear, low-risk rollout. The
current state forces an integrator to run decryption in a separate process to dodge
the bundler — a workaround for an eminently fixable footgun.

---

## 2. Errors that mislead the caller's next action

The typed error hierarchy (`ZamaError` base, `ZamaErrorCode` enum, per-error
classes, `matchZamaError` helper) is a genuinely good foundation. Two cases
undermine it by pointing the caller (human or agent) at the wrong fix.

### 2a. RPC rate-limits surface as `DECRYPTION_FAILED`

When the consumer's RPC 429s **during the on-chain reads the SDK itself makes**
(e.g. the ACL delegation check), the failure surfaces as `DecryptionFailedError`
(`code: DECRYPTION_FAILED`) wrapping an ethers `BAD_DATA / missing response …
-32005 Too Many Requests`. Observed exactly this on a free Infura key; the message
reads as "decryption is broken," so the instinct is to re-check rights / re-delegate
— when the fix is the RPC. (We lost ~an hour before splitting `DECRYPT_RPC_URL`
onto a less-throttled endpoint.)

- **Change:** detect upstream `429` / JSON-RPC `-32005` from the provider and raise
  a typed `RpcRateLimitedError` (the error classes already carry an optional
  `statusCode`, verified in `relayer-cleartext-*.d.ts` — extend that to the
  provider-read path), distinct from a real decryption failure.
- **Also document** that decryption is **RPC-heavy** — it makes batched on-chain
  `eth_call`s, which is surprising for something framed as "talk to the gateway."

### 2b. `DelegationNotPropagatedError` is a heuristic the SDK itself flags

Its own docstring (`index-DMv-qtTr.d.ts`) says the quiet part out loud: it's raised
on a relayer HTTP 500 that is *most likely* propagation lag, "However, the same
status code can occur if the gateway or relayer experiences an unrelated internal
error." So a genuine gateway error can masquerade as "just wait." Our backfill
defends against this by capping `pending_propagation` retries and escalating to
`failed` (see [INDEXER.md](INDEXER.md)) — i.e. we wrote application logic to
compensate for an error we can't trust.

- **Change:** if the relayer can distinguish "ACL not yet synced" from "internal
  error" (even via a response header/body code), surface them as distinct typed
  errors. If it genuinely can't, name the ambiguity in the type (e.g.
  `RelayerUnavailableError` with a `likelyPropagation: boolean`) rather than
  asserting a cause.

### 2c. No way to *query* propagation — you can only fail and retry

A delegation grant is immediate on the host chain, but delegated decryption only
works after the gateway syncs cross-chain. There is **no API to ask "has it
propagated yet."** `sdk.delegations.isActive`/`getExpiry` read the *host-chain* ACL,
which returns `true` the instant the grant tx mines — so they confirm the grant
*exists*, not that it's *usable*. The only signal is "try to decrypt and see if it
throws." That forces every integrator to write a retry-on-specific-error loop
against a heuristic error (2b).

- **Change:** expose the gateway-side check (the gateway already has
  `isHandleDelegatedForUserDecryption` against its synced copy) as
  `sdk.delegations.isPropagated({ delegator, contractAddress })`, or have the
  delegated decrypt return a structured "not-ready, retry-after" instead of
  throwing. Either makes a correct wait loop trivial.
- **Doc gap (measured):** the docs cite "~1–2 minutes" for propagation. We measured
  it (poll the delegated decrypt every 1s after a fresh grant): **~4 seconds**
  (3.9s / 3.5s on two trials, first attempt). Treating the worst case as the
  expected value over-pessimizes retry windows and demo pacing. Document the typical
  and the ceiling separately.

---

## 3. API ergonomics: duplicate decrypt methods + the legacy shadow

### 3a. Two parallel decrypt APIs, no signposting

`sdk.decryption` (verified) exposes **both**:

```ts
userDecrypt(handles, signerAddress)                                  // lower-level: explicit signer
delegatedUserDecrypt(values, delegatorAddress, delegateAddress, accountAddress)
decryptValues(encryptedInput)                                       // convenience: uses configured signer
delegatedDecryptValues(encryptedInputs, delegatorAddress, accountAddress?)
```

They're not identical (the `*Values` pair is the convenience layer over the
explicit-address pair), but nothing on the surface says which is canonical or when
to prefer which. A new integrator — or an LLM — picks one at random.

- **Change:** make one pair the documented entrypoint, mark the other
  `@internal`/`@deprecated` or move it under a `.lowLevel` namespace, and add JSDoc
  "prefer `decryptValues`" cross-links.

### 3b. The legacy `relayer-sdk` shadow

`@zama-fhe/sdk` wraps the legacy `@zama-fhe/relayer-sdk`, whose
`createInstance(SepoliaConfig)` / `createEncryptedInput` / `userDecrypt` shape is
what virtually all public docs **and LLM training data** still show. The new
`ZamaSDK` class supersedes it, but nothing actively steers a caller off the old
shape. (This bit us — see the AI-assistance note in DECISIONS: a from-memory first
draft used the legacy API and a plain ERC-20 `Transfer` event; only a
source-grounded pass caught it.)

- **Change:** a runtime deprecation shim that throws a *named* error pointing at the
  new symbol if the legacy shape is invoked through this package; a one-page
  "migrating from relayer-sdk" symbol map; and (see §4) machine-readable current-API
  docs so tools don't regress to the old shape.

---

## 4. AI-native SDK: agents as first-class consumers

The role frames AI agents (Claude Code, Codex, …) as first-class SDK consumers
alongside humans. Having just integrated the SDK *with* such an agent, here's the
honest read on where the current surface helps an agent and where it actively
misleads one. The throughline: **an agent acts on what the types and errors say —
so accuracy and self-description matter more for agents than for humans, who route
around ambiguity with intuition.**

### What's already agent-friendly (keep / lean into)

- **Typed error hierarchy + `ZamaErrorCode` + `matchZamaError`.** Machine-
  discriminable errors are exactly what an agent needs to branch on. This is the
  right foundation.
- **Strong static types** (tagged unions like `EncryptInput`, typed configs, the
  `Token`/namespace structure). Agents lean hard on types for discovery.
- **Lifecycle events** (`ZamaSDKEvents`: `DecryptStart/End/Error` …) — observable,
  good for an agent building a progress UI.
- **The `examples/` folder** — usable few-shot material.

### What's missing or actively anti-agent

1. **Stale training data is the #1 agent hazard — and nothing counters it.** Every
   LLM has seen mostly `relayer-sdk` (`createInstance`/`userDecrypt`). Asked to use
   "the Zama SDK," an agent confidently emits pre-3.x code that matches no current
   symbol. The single highest-leverage AI-native investment: ship a stable,
   machine-readable **current-API manifest** (an `llms.txt` / a generated
   symbol+signature JSON at a versioned URL) and **runtime deprecation errors** that
   name the new symbol — so both the agent's *generation* and its *self-correction
   loop* are steered onto the real API. The brief for this very challenge had to
   warn "training data predates this package"; the SDK should make that warning
   unnecessary.

2. **Errors must encode the *next action*, not just the failure.** An agent reads
   the error and does the next thing. `DECRYPTION_FAILED` over an RPC 429 (§2a) →
   the agent "fixes decryption." `DelegationNotPropagatedError` over a real 500
   (§2b) → the agent waits forever. Agent-facing errors want an accurate `code`
   **plus a remediation field** (`hint` / `nextStep` / `retryable` / `retryAfter`)
   the agent can act on deterministically.

3. **SDK failures must always be named SDK errors.** The SSR worker failure (§1)
   surfaces as `__vite_ssr_import_meta__.resolve is not a function` — zero
   connection to Zama in the text. An agent can't even classify it as an SDK
   problem, let alone fix it. Invariant worth adopting: *every* failure originating
   in the SDK is a `ZamaError` subclass with a remediation string.

4. **One obvious path.** Duplicate decrypt methods (§3a) with no "prefer this"
   marker make an agent guess. Humans shrug and pick one; an agent bakes the guess
   into generated code that then propagates. Deprecate/`@internal` the non-canonical
   surface so there's a single discoverable entrypoint.

5. **Make async state queryable, not catch-the-right-error.** "Try to decrypt and
   interpret a heuristic error" (§2c) is a fragile control-flow pattern for an
   agent. A boolean/structured `isPropagated()` lets an agent write a correct,
   deterministic wait loop instead of pattern-matching on error strings.

6. **Task-shaped, version-pinned recipes (or MCP tools).** Agents do best with
   copy-paste-correct, task-indexed snippets pinned to a version ("delegate + decrypt
   a balance on Sepolia"), or first-class **MCP tools** that expose SDK operations
   directly to an agent. The current examples are human-oriented prose; an
   agent-facing surface would be structured and machine-consumable.

**In one line:** the typed-error + strong-types foundation is the right substrate
for AI-native; the gaps are (a) actively countering stale training data, (b) errors
that carry accurate, actionable remediation, (c) a single obvious path, and (d)
queryable async state instead of error-driven control flow.
