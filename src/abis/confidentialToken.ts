/**
 * ERC-7984 confidential token + ERC-20 wrapper — the events the indexer reads and
 * the one view it calls. Transcribed from the compiled ConfidentialUSD artifact so
 * topic hashes match exactly (euint64 is `bytes32` at the ABI/log level).
 *
 * Vendored as a const so the indexer runs from a fresh clone without compiling the
 * Solidity. Keep in sync with contracts/src if the token changes.
 */
export const confidentialTokenAbi = [
  // transfer / mint(from=0) / burn(to=0) / shield(from=0 via wrap). amount is a handle.
  {
    type: "event",
    name: "ConfidentialTransfer",
    anonymous: false,
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "bytes32", indexed: true },
    ],
  },
  // public cleartext reveal of a handle -> uint64 (lets us backfill without rights).
  {
    type: "event",
    name: "AmountDisclosed",
    anonymous: false,
    inputs: [
      { name: "encryptedAmount", type: "bytes32", indexed: true },
      { name: "amount", type: "uint64", indexed: false },
    ],
  },
  // unshield, step 1 (async).
  {
    type: "event",
    name: "UnwrapRequested",
    anonymous: false,
    inputs: [
      { name: "receiver", type: "address", indexed: true },
      { name: "unwrapRequestId", type: "bytes32", indexed: true },
      { name: "amount", type: "bytes32", indexed: false },
    ],
  },
  // unshield, step 2 — cleartextAmount is plaintext on-chain.
  {
    type: "event",
    name: "UnwrapFinalized",
    anonymous: false,
    inputs: [
      { name: "receiver", type: "address", indexed: true },
      { name: "unwrapRequestId", type: "bytes32", indexed: true },
      { name: "encryptedAmount", type: "bytes32", indexed: false },
      { name: "cleartextAmount", type: "uint64", indexed: false },
    ],
  },
  // confidential balance handle for an account (decrypt off-chain when entitled).
  {
    type: "function",
    name: "confidentialBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;
