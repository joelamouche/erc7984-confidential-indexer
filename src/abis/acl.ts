/**
 * fhEVM ACL host contract — the delegation events the indexer watches (filtered to
 * its holder) for rights discovery, plus the calls used to read delegation state
 * and to build the unsigned delegation tx for the facilitation endpoint.
 *
 * Hand-written from the source-verified signatures in `host-contracts/contracts/
 * ACLEvents.sol` + `ACL.sol` (see docs/SDK-NOTES.md). NOTE: event topic hashes
 * must match the deployed ACL exactly — re-verify against a real
 * DelegatedForUserDecryption log (or the Etherscan-verified ABI) when first
 * exercising the delegation flow.
 */
export const aclAbi = [
  {
    type: "event",
    name: "DelegatedForUserDecryption",
    anonymous: false,
    inputs: [
      { name: "delegator", type: "address", indexed: true },
      { name: "delegate", type: "address", indexed: true },
      { name: "contractAddress", type: "address", indexed: false },
      { name: "delegationCounter", type: "uint64", indexed: false },
      { name: "oldExpirationDate", type: "uint64", indexed: false },
      { name: "newExpirationDate", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "RevokedDelegationForUserDecryption",
    anonymous: false,
    inputs: [
      { name: "delegator", type: "address", indexed: true },
      { name: "delegate", type: "address", indexed: true },
      { name: "contractAddress", type: "address", indexed: false },
      { name: "delegationCounter", type: "uint64", indexed: false },
      { name: "oldExpirationDate", type: "uint64", indexed: false },
    ],
  },
  // The user signs this to grant the indexer holder decrypt rights.
  {
    type: "function",
    name: "delegateForUserDecryption",
    stateMutability: "nonpayable",
    inputs: [
      { name: "delegate", type: "address" },
      { name: "contractAddress", type: "address" },
      { name: "expirationDate", type: "uint64" },
    ],
    outputs: [],
  },
  // Read current delegation expiry (0 = none/revoked).
  {
    type: "function",
    name: "getUserDecryptionDelegationExpirationDate",
    stateMutability: "view",
    inputs: [
      { name: "delegator", type: "address" },
      { name: "delegate", type: "address" },
      { name: "contractAddress", type: "address" },
    ],
    outputs: [{ name: "", type: "uint64" }],
  },
] as const;
