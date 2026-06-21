import { createConfig } from "ponder";
import { confidentialTokenAbi } from "./src/abis/confidentialToken";
import { aclAbi } from "./src/abis/acl";
import { accounts, env } from "./src/config";

if (!env.TOKEN_ADDRESS) {
  throw new Error("TOKEN_ADDRESS not set — run `npm run deploy` first.");
}

export default createConfig({
  chains: {
    sepolia: { id: env.CHAIN_ID, rpc: env.SEPOLIA_RPC_URL },
  },
  contracts: {
    // The ERC-7984 confidential token (= the wrapper): transfers, shield/unshield.
    ConfidentialToken: {
      chain: "sepolia",
      abi: confidentialTokenAbi,
      address: env.TOKEN_ADDRESS,
      startBlock: env.START_BLOCK,
    },
    // The fhEVM ACL contract — only delegation events naming our holder as the
    // delegate, so the indexer discovers what it's allowed to decrypt.
    Acl: {
      chain: "sepolia",
      abi: aclAbi,
      address: env.ACL_ADDRESS,
      startBlock: env.START_BLOCK,
      filter: [
        { event: "DelegatedForUserDecryption", args: { delegate: accounts.indexerHolder.address } },
        { event: "RevokedDelegationForUserDecryption", args: { delegate: accounts.indexerHolder.address } },
      ],
    },
  },
  // A Ponder *block source* (vs. the contract sources above): instead of firing a
  // handler on a contract log, it fires one on a block schedule. This is how we run
  // the decryption backfill periodically — Ponder has no cron, so block progress is
  // the clock. The handler is `Backfill:block` in src/index.ts.
  blocks: {
    Backfill: {
      chain: "sepolia",
      startBlock: env.START_BLOCK,
      // Run the backfill every 2 newly-indexed blocks. Sepolia blocks are ~12s
      // apart, so that's ~24s of wall-clock (derived, not configured — it tracks
      // block time). Gateway propagation is only ~4s (measured), so the user-visible
      // decrypt flip after a delegation is gated by THIS cadence, not the gateway —
      // kept tight so freshly-granted rows decrypt promptly and the demo flips fast.
      interval: 2,
    },
  },
});
