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
  blocks: {
    // Drives the decryption backfill, decoupled from per-transfer events.
    // interval 5 ≈ every ~60s on Sepolia — roughly the delegation propagation window.
    Backfill: {
      chain: "sepolia",
      startBlock: env.START_BLOCK,
      interval: 5,
    },
  },
});
