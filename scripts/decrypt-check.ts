/**
 * Isolation test for the SDK decryption path (independent of Ponder).
 *
 *   npm run decrypt:check -- 0    # decrypt user0's confidential balance as the holder
 *
 * Reads confidentialBalanceOf(user) on-chain, then delegated-decrypts that handle
 * as the indexer holder. Requires the user to have delegated to the holder first
 * (`npm run delegate`) and a few seconds for gateway propagation (~4s measured).
 * Prints the cleartext.
 */
import { DelegationNotPropagatedError } from "@zama-fhe/sdk";
import { accounts, env } from "../src/config";
import { publicClient } from "../src/chain";
import { confidentialTokenAbi } from "../src/abis/confidentialToken";
import { delegatedDecrypt } from "../src/zama/sdk";

async function main() {
  if (!env.TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS not set.");
  const idx = Number(process.argv[2] ?? 0);
  const user = accounts.testUsers[idx];
  if (!user) throw new Error(`No test user at index ${idx}`);

  const handle = await publicClient.readContract({
    address: env.TOKEN_ADDRESS,
    abi: confidentialTokenAbi,
    functionName: "confidentialBalanceOf",
    args: [user.address],
  });
  console.log(`\n${user.role} (${user.address})`);
  console.log(`balance handle: ${handle}`);
  console.log(`decrypting as holder ${accounts.indexerHolder.address} via delegation…\n`);

  try {
    const result = await delegatedDecrypt([handle], env.TOKEN_ADDRESS, user.address);
    console.log("✅ cleartext:", result[handle]?.toString());
  } catch (err) {
    if (err instanceof DelegationNotPropagatedError) {
      console.log("⏳ DelegationNotPropagated — grant not synced to the gateway yet. Wait ~30s and retry.");
    } else {
      throw err;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
