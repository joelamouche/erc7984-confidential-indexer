/**
 * Unshield (unwrap) confidential tokens back to the underlying ERC-20.
 *
 *   npm run unshield -- 0 20     # user0 unwraps 20 cUSD back to ToyUSD
 *
 * Calls the wrapper's `unwrap(from, to, externalEuint64, proof)` with an
 * SDK-encrypted amount. This burns the confidential tokens — emitting
 * ConfidentialTransfer(user, address(0), handle), which the indexer records as
 * kind=unshield. For a delegated user that burn amount decrypts via the normal
 * delegation path (the handle is ACL-allowed for the burner). The wrapper also
 * emits UnwrapRequested, and the gateway later calls finalizeUnwrap →
 * UnwrapFinalized(…, cleartextAmount) which carries the plaintext on-chain.
 */
import { MemoryStorage, ZamaSDK, type FheChain } from "@zama-fhe/sdk";
import { sepolia as zamaSepolia } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { node } from "@zama-fhe/sdk/node";
import { createPublicClient, createWalletClient, http, parseGwei, parseUnits } from "viem";
import { accounts, env } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { loadAbi } from "../src/artifacts";

async function main() {
  if (!env.TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS not set — run `npm run deploy`.");
  const user = accounts.testUsers[Number(process.argv[2] ?? 0)];
  if (!user) throw new Error("usage: unshield <userIdx> <amount>");
  const token = env.TOKEN_ADDRESS;
  const amount = parseUnits(process.argv[3] ?? "20", 6); // cUSD, 6 decimals

  const rpc = env.DECRYPT_RPC_URL ?? env.SEPOLIA_RPC_URL;
  const fheChain = { ...zamaSepolia, network: rpc } as FheChain;
  using sdk = new ZamaSDK(
    createConfig({
      chains: [fheChain],
      relayers: { [fheChain.id]: node() },
      storage: new MemoryStorage(),
      publicClient: createPublicClient({ chain, transport: http(rpc) }),
      walletClient: createWalletClient({ account: user.account, chain, transport: http(rpc) }),
    }),
  );

  console.log(`\n${user.role} (${user.address}) unwrapping ${process.argv[3] ?? "20"} cUSD → ToyUSD…`);
  const { encryptedValues, inputProof } = await sdk.encrypt({
    values: [{ value: amount, type: "euint64" }],
    contractAddress: token,
    userAddress: user.address,
  });

  const block = await publicClient.getBlock();
  const maxPriorityFeePerGas = parseGwei("2");
  const hash = await createWalletClient({ account: user.account, chain, transport: http(env.SEPOLIA_RPC_URL) }).writeContract({
    address: token,
    abi: loadAbi("ConfidentialUSD"),
    functionName: "unwrap",
    args: [user.address, user.address, encryptedValues[0], inputProof],
    account: user.account,
    chain,
    maxPriorityFeePerGas,
    maxFeePerGas: (block.baseFeePerGas ?? parseGwei("1")) * 3n + maxPriorityFeePerGas,
  });
  console.log(`unwrap tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
  console.log(`\n✅ Unshield burn sent. Indexer records kind=unshield; decrypts via delegation if entitled.`);
  console.log(`   The gateway will finalize the unwrap (UnwrapFinalized) shortly with the cleartext amount.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
