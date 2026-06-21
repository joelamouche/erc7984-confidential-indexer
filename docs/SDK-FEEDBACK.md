# SDK feedback — `@zama-fhe/sdk`

Design-review-shaped feedback from wiring `@zama-fhe/sdk@3.1.0-alpha.15` into a
real backend indexer. Every claim below is **verified against the installed
source** (paths cited), not recalled. [DECISIONS.md](../DECISIONS.md) carries the
three-line summary; this is the detail, the root-cause analysis, and an
**AI-native-SDK** section (relevant to the role's "treat AI agents as first-class
SDK consumers" mandate).

Order is by impact: (1) the SSR/worker blocker, (2) misleading errors, (3) API
ergonomics, then (4) AI-native surface.

---

## 1. `node()` can't run under a bundler's SSR transform — highest impact

### What happens

Calling any decryption inside a framework that runs code through a bundler's SSR
transform (Ponder, Next.js route handlers / server components, Remix loaders,
SvelteKit, anything on Vite or esbuild-SSR) throws:

```
__vite_ssr_import_meta__.resolve is not a function
```

The same call works in plain `node`/`tsx`. So it presents as an environment
gremlin, not an SDK issue — which is exactly why it cost the most time to diagnose.

### Root cause (verified)

`dist/esm/node/index.js`, the Node relayer transport's `createWorker`:

```js
createWorker() {
  const base = new URL(import.meta.resolve("@zama-fhe/sdk/node"));
  return new Worker(new URL("relayer-sdk.node-worker.js", base));
}
```

Two facts compound:
- The `./node` subpath is **ESM-only** (verified in `package.json` `exports`: both
  `import` and `default` point at `dist/esm/node/index.js`; there is no CJS node
  build). So a consumer can't sidestep via `require`.
- Worker resolution uses **`import.meta.resolve(...)`**. A bundler's SSR transform
  replaces `import.meta` with an internal object (`__vite_ssr_import_meta__`) that
  exposes `url`/`env` but **not** `resolve` → `undefined` is called as a function.

### Did they have a good reason? Yes — anticipate it before critiquing

This is **not** a "why use workers / why use `import.meta.resolve`" critique — both
choices are defensible:

- **`worker_threads`** is the right call. FHE work (ML-KEM transport-keypair
  generation, ciphertext re-encryption, proof handling) is CPU-bound and blocking;
  running it on the main thread would stall a server's event loop. Offloading to a
  worker pool is correct backend design.
- **`import.meta.resolve`** is the spec-compliant, modern-ESM way to locate a
  package-relative asset robustly across install layouts (hoisting, pnpm,
  monorepos), honoring the export map. It's stable since Node 20.6, and the SDK
  targets Node ≥ 22. In a *pure-Node ESM* runtime this is arguably the most-correct
  choice.

The flaw is narrower and real: **the worker-resolution strategy assumes a pure-Node
ESM runtime, but a large share of the target audience consumes the SDK through a
bundler**, where `import.meta.resolve` is unavailable (SSR) or the package-relative
URL is lost (full bundling) — and it fails with an error that doesn't even name the
SDK.

### How hard is it to fix? Easy → medium, with a trivial immediate mitigation

**(a) The proper fix — switch to `import.meta.url` (LOW difficulty).** The worker is
a sibling file, so:

```js
new Worker(new URL("./relayer-sdk.node-worker.js", import.meta.url));
```

- `import.meta.url` **is** provided by Vite/esbuild SSR (unlike `.resolve`), so this
  fixes the SSR case directly.
- The literal `new Worker(new URL("./file.js", import.meta.url))` pattern is the one
  that Vite/Rollup/webpack-5/Turbopack specifically detect and emit as a worker
  asset — so it also fixes *full bundling*, not just SSR. It's the ecosystem's
  canonical worker pattern.
- It still works in plain Node ESM. So it's strictly better than `import.meta.resolve`
  here (the export-map indirection buys nothing for a sibling file).
- Residual work (the "medium" part): a cross-bundler test matrix (Vite/Next/Remix/
  webpack) to confirm the worker asset is emitted and located everywhere.

**(b) Immediate, zero-risk mitigations — ship today (TRIVIAL):**
- Add a `node({ workerUrl })` option so a consumer can pass the worker path
  explicitly (escape hatch for any environment).
- **Detect and rename the failure.** Guard the `import.meta.resolve` call; if it's
  missing, throw a *named* `ZamaWorkerResolutionError` whose message says "the
  `node()` transport's worker couldn't be located — you're likely under a bundler
  SSR transform; pass `workerUrl` or see <link>." This alone turns an opaque
  multi-hour debug into a 30-second fix, even before (a) lands.

**(c) Belt-and-suspenders:** a synchronous in-process fallback (no worker) for
environments where a worker genuinely can't be spawned — slower, but functional
instead of broken.

**Bottom line:** the escape hatch + named error is trivial and high-value; the
proper `import.meta.url` switch is a small change whose only cost is cross-bundler
test coverage. The current state forces consumers like this project to run
decryption in a **separate spawned plain-Node process** to dodge the bundler
entirely — which works, but is a workaround for a fixable footgun.

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
