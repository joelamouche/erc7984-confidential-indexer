# `@zama-fhe/sdk` (alpha) — grounded reference notes

> The brief warns that **most public LLM training data predates this package**.
> These notes were reconstructed from the **`prerelease`** branch of
> [`zama-ai/sdk`](https://github.com/zama-ai/sdk) and the installed package, not
> from model memory. They pin **`@zama-fhe/sdk@3.1.0-alpha.15`**; signatures may
> drift in later alphas — re-verify against the prerelease branch before relying
> on a symbol name. This file exists so the architecture below is anchored to the
> real API surface and so the SDK-feedback section of `DECISIONS.md` is concrete.

## TL;DR of the shape

The 3.x line is a **new high-level abstraction** over the legacy
`@zama-fhe/relayer-sdk`. You generally do **not** call `createInstance`,
`createEncryptedInput`, `generateKeypair`, or `userDecrypt` yourself anymore — a
`ZamaSDK` instance owns the keypair/EIP-712 permit/relayer flow. This is the
single biggest gotcha: pre-3.x snippets (and most LLM output) describe an API
that no longer is the entrypoint.

## Init (Node backend, ethers flavour)

```ts
import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { sepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/ethers";   // or "@zama-fhe/sdk/viem"
import { node } from "@zama-fhe/sdk/node";             // relayer transport (worker_threads)

const zamaSepolia = {
  ...sepolia,
  network: SEPOLIA_RPC_URL,
} as const satisfies FheChain;

using sdk = new ZamaSDK(
  createConfig({
    chains: [zamaSepolia],
    signer: indexerHolderWallet,        // ethers Wallet — the indexer's decryption identity
    storage: new MemoryStorage(),       // swap for a persistent store in prod (caches FHE creds)
    relayers: { [zamaSepolia.id]: node() },
  }),
);
```

- **No manual WASM init.** The `node()` transport self-registers and runs FHE
  work on `worker_threads`. Sub-path imports are load-bearing and easy to get
  wrong: `@zama-fhe/sdk` (barrel), `@zama-fhe/sdk/node`, `@zama-fhe/sdk/chains`,
  `@zama-fhe/sdk/ethers` | `/viem`.
- `using sdk = …` (explicit-resource-management) tears down the worker pool via
  `sdk.terminate()` even on throw. One `ZamaSDK` per signer/credential context.

## Decrypting handles the holder is a party to

```ts
// sdk.decryption.decryptValues(EncryptedInput[]) -> Record<handle, bigint|boolean|string>
const values = await sdk.decryption.decryptValues([
  { encryptedValue: amountHandle, contractAddress: tokenAddress },
]);
const cleartext = values[amountHandle]; // e.g. 1000n
```

- **Batches**: pass many handles in one call; the SDK groups by contract,
  dedupes, caches, runs with concurrency 5. Good fit for draining a backlog.
- Requires a configured signer (EIP-712 permit signed lazily on first decrypt,
  then cached in `storage`). Throws `SignerNotConfiguredError` / `ChainMismatchError`
  before hitting the network.

## Delegated decryption (the "partner grants the indexer rights later" path)

On-chain grant (delegator signs), then SDK-side decrypt as the delegate:

```ts
// Delegator (the partner user) grants the indexer holder rights for this token:
await sdk.delegations.delegateDecryption({ contractAddress, delegateAddress });

// Indexer (NOT a party to the transfer) decrypts on the delegator's behalf:
const values = await sdk.decryption.delegatedDecryptValues(
  [{ encryptedValue: handle, contractAddress }],
  delegatorAddress,
);

// Error-isolated batch variant — per-entry value-or-error:
const { items } = await sdk.decryption.delegatedBatchDecryptValues({
  encryptedInputs, delegatorAddress, maxConcurrency,
});
```

- Read helpers: `sdk.delegations.isActive({ contractAddress, delegatorAddress, delegateAddress })`,
  `sdk.delegations.getExpiry({...})`. `delegatedDecryptValues` fail-fasts with
  `DelegationNotFoundError`/`DelegationExpiredError` **before** any network call.
- **Propagation window (critical for the backfill loop):** the on-chain grant is
  immediate, but the gateway must sync cross-chain — **~1–2 min on Sepolia**.
  Decrypting in that window throws **`DelegationNotPropagatedError`** (heuristically
  mapped from an HTTP 500). The official example retries 5× at 30s. **The on-chain
  delegation _event_ is emitted immediately at grant time** — only the
  _decryption_ is delayed. So "rights observed" and "rights usable" are two
  distinct moments; the state machine models both.

## ACL on-chain facts (verified, drives rights discovery + facilitation)

Source: `zama-ai/fhevm` `host-contracts/contracts/ACL.sol` + `ACLEvents.sol`;
SDK `packages/sdk/src/contracts/acl.ts` + `abi/acl.abi.ts` (prerelease).

- **ACL contract on Sepolia:** `0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D`.
- **Delegation grant function (the user signs this):**
  ```solidity
  // single contractAddress (NOT an address[]); expiry in unix seconds, must be > now.
  // contractAddress may be the wildcard 0xFFf...FfF meaning "all contracts".
  function delegateForUserDecryption(address delegate, address contractAddress, uint64 expirationDate);
  function revokeDelegationForUserDecryption(address delegate, address contractAddress);
  ```
- **Events the indexer subscribes to** (`delegate`/`account` are indexed → topic-filter on the holder):
  ```solidity
  event DelegatedForUserDecryption(address indexed delegator, address indexed delegate,
      address contractAddress, uint64 delegationCounter, uint64 oldExpirationDate, uint64 newExpirationDate);
  event RevokedDelegationForUserDecryption(address indexed delegator, address indexed delegate,
      address contractAddress, uint64 delegationCounter, uint64 oldExpirationDate);
  event Allowed(address indexed caller, address indexed account, bytes32 handle); // per-handle persistent grant
  ```
  `contractAddress` is in data, not indexed. `delegationCounter` orders/dedupes
  grants per `(delegator, delegate, contractAddress)`. `allowTransient` emits
  **nothing** (transient storage) — only persistent `allow` is observable.
- **No on-chain enumeration** of "delegations where I'm the delegate" — mappings
  aren't iterable. Reconstruct the delegator set from historical events
  (`eth_getLogs` from the ACL deploy block, filtered `delegate == holder`) +
  validate each tuple with `sdk.delegations.isActive`/`getExpiry`.

### Build delegation calldata WITHOUT signing (for the facilitation endpoint)

`sdk.delegations.delegateDecryption(...)` signs+sends (needs the delegator's
signer) — wrong for a server that must not hold user keys. Use the build-only
helper instead and hand the result to the user's wallet:

```ts
import { delegateForUserDecryptionContract } from "@zama-fhe/sdk"; // contracts/acl.ts
const call = delegateForUserDecryptionContract(aclAddress, holderAddress, tokenAddress, expiry);
// -> { address, abi, functionName: "delegateForUserDecryption", args: [holder, token, expiry] }
// API returns { to: call.address, data: encodeFunctionData(call), chainId }; the wallet signs+sends.
```

## Public decryption (signer-independent reveal)

```ts
const { clearValues, decryptionProof, abiEncodedClearValues } =
  await sdk.decryption.decryptPublicValues([encryptedValue]);
```

Use for values meant to become public (e.g. the `finalizeUnwrap` proof step), not
for per-party balances.

## Error taxonomy (what we key the DB state machine on)

All extend `ZamaError`; decryption errors normalized by `wrapDecryptError`:

| Condition | Error | Our interpretation |
| --- | --- | --- |
| Relayer HTTP 400 (no usable handle for this account) | `NoCiphertextError` | holder lacks rights / nothing to decrypt → `pending_rights` |
| Delegated decrypt HTTP 500 (heuristic) | `DelegationNotPropagatedError` | grant not synced yet → `pending_propagation`, retry |
| Missing/expired delegation (pre-flight) | `DelegationNotFoundError` / `DelegationExpiredError` | `pending_rights` |
| Other relayer HTTP failure (has `.statusCode`) | `RelayerRequestFailedError` | transient → `failed`, backoff retry |
| Unknown | `DecryptionFailedError` (with `cause`) | `failed`, backoff retry |

> **Footgun noted for SDK feedback:** `NoCiphertextError` (400) conflates "you
> lack rights, retry after a grant" with "this handle has no ciphertext"; and
> `DelegationNotPropagatedError` is a *heuristic* over a bare 500, so a genuine
> gateway error masquerades as "just wait." Distinguishing these cleanly is exactly
> what an indexer's retry policy needs. See `DECISIONS.md` § SDK feedback.

## Encryption (only needed by the test harness / contract seeding)

```ts
const { encryptedValues, inputProof } = await sdk.encrypt({
  values: [{ value: 1000n, type: "euint64" }],
  contractAddress, userAddress,
});
```

The high-level `Token` helpers (`sdk.createToken(addr)` → `confidentialTransfer`,
`wrap`, `unwrap`, `balanceOf`, `decryptBalanceAs({ delegatorAddress })`) wrap
encrypt+decrypt and are handy for the seed/test scripts.
