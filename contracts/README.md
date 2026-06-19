# Contracts — toy confidential token

Foundry project for the ERC-7984 token the indexer watches.

- **`src/ToyUSD.sol`** — a minimal 6-decimal ERC-20 (cleartext underlying), with a
  public `mint` to seed test users.
- **`src/ConfidentialUSD.sol`** — the ERC-7984 **confidential token**: a concrete
  `ERC7984ERC20Wrapper` (OpenZeppelin confidential-contracts) over `ToyUSD`. It
  emits `ConfidentialTransfer` and supports `confidentialTransfer`,
  `confidentialBalanceOf`, and the wrapper's `wrap`/`unwrap`/`finalizeUnwrap`
  (shield/unshield) with `UnwrapRequested`/`UnwrapFinalized`. Inherits
  `ZamaEthereumConfig`, which wires the **Sepolia** fhEVM coprocessor/ACL/KMS when
  deployed at chainid 11155111. (In `@fhevm/solidity@0.11.1` this is the renamed
  equivalent of the old `SepoliaConfig`.)

The confidential token **is** the wrapper, so the indexer watches a single address
for transfers, mints/burns, and shield/unshield.

## Build / test

```bash
./setup.sh          # one-time: install pinned deps (forge + npm) and build
forge test -vv      # wrap (shield) + confidentialTransfer pass under forge-fhevm
```

Dependencies are installed with `forge install --no-git` (plain dirs, gitignored)
plus npm for `@fhevm/solidity` — see `setup.sh` for the exact pinned set. Deploy is
driven from the repo root (`npm run deploy`), which uses the compiled artifacts in
`out/`.

## Known gap

`unwrap`/`finalizeUnwrap` is exercised by the contract but its forge-fhevm test is
stubbed — `finalizeUnwrap` needs a KMS-signed decryption proof, out of scope for
the test budget. The events still fire for the indexer to consume.
