/**
 * Confidential transfer between two test users (exercises the SDK *encrypt* path).
 *
 *   npm run transfer -- 0 1 40     # user0 sends 40 cUSD to user1
 *   npm run transfer -- 1 2 30     # user1 sends 30 cUSD to user2
 *
 * The sender encrypts the amount with the SDK (externalEuint64 + input proof) and
 * calls confidentialTransfer(to, handle, proof) from their own wallet. The amount
 * handle is ACL-allowed for BOTH parties, so the indexer can decrypt it if EITHER
 * party delegated to the holder; otherwise it stays pending_rights. Run this while
 * `npm run dev` is up to see the indexer catch the event live.
 */
import { MemoryStorage, ZamaSDK, type FheChain } from "@zama-fhe/sdk";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import { createPublicClient, createWalletClient, http, parseGwei, parseUnits } from "viem";
import { accounts, env } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { loadAbi } from "../src/artifacts";

/** SDK-encrypt an amount and send a confidential transfer between two test users. */
async function main() {
  if (!env.TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS not set — run `npm run deploy`.");
  const sender = accounts.testUsers[Number(process.argv[2] ?? 0)];
  const recipient = accounts.testUsers[Number(process.argv[3] ?? 1)];
  if (!sender || !recipient) throw new Error("usage: transfer <senderIdx> <recipientIdx> <amount>");
  const token = env.TOKEN_ADDRESS;
  const amount = parseUnits(process.argv[4] ?? "40", 6); // cUSD, 6 decimals

  // SDK on the decryption RPC (publicnode) — its encrypt makes batched calls too.
  const rpc = env.DECRYPT_RPC_URL ?? env.SEPOLIA_RPC_URL;
  const fheChain = { ...zamaSepolia, network: rpc } as FheChain;
  using sdk = new ZamaSDK(
    createConfig({
      chains: [fheChain],
      relayers: { [fheChain.id]: node() },
      storage: new MemoryStorage(),
      publicClient: createPublicClient({ chain, transport: http(rpc) }),
      walletClient: createWalletClient({ account: sender.account, chain, transport: http(rpc) }),
    }),
  );

  console.log(`\n${sender.role} (${sender.address}) -> ${recipient.role} (${recipient.address})`);

  // Encrypt + send, retrying transient coprocessor reverts (ZamaProtocolUnsupported).
  // We re-encrypt on each attempt because a rejected input proof must not be reused.
  const wallet = createWalletClient({ account: sender.account, chain, transport: http(env.SEPOLIA_RPC_URL) });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`encrypting ${process.argv[4] ?? "40"} cUSD…${attempt > 1 ? ` (attempt ${attempt}/3)` : ""}`);
      const { encryptedValues, inputProof } = await sdk.encrypt({
        values: [{ value: amount, type: "euint64" }],
        contractAddress: token,
        userAddress: sender.address,
      });
      const block = await publicClient.getBlock();
      const maxPriorityFeePerGas = parseGwei("2");
      const hash = await wallet.writeContract({
        address: token,
        abi: loadAbi("ConfidentialUSD"),
        functionName: "confidentialTransfer",
        args: [recipient.address, encryptedValues[0], inputProof],
        account: sender.account,
        chain,
        // Explicit gas so viem skips eth_estimateGas — the estimation (eth_call
        // simulation) intermittently reverts on Sepolia because the just-registered
        // FHE input isn't yet visible to the simulating node. A real transfer uses
        // ~440k; 1M is generous headroom. This is the actual fix for the "unknown
        // reason" reverts, not the retry below (which stays as a backstop).
        gas: 1_000_000n,
        maxPriorityFeePerGas,
        maxFeePerGas: (block.baseFeePerGas ?? parseGwei("1")) * 3n + maxPriorityFeePerGas,
      });
      console.log(`confidentialTransfer tx: ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
      console.log(`\n✅ Transferred. Watch the running indexer pick it up live as kind=transfer.`);
      return;
    } catch (err) {
      lastError = err;
      console.log(`  transfer attempt ${attempt}/3 reverted (transient coprocessor error?), retrying…`);
    }
  }
  throw lastError;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
