/**
 * Grant the indexer holder decrypt rights, as a partner user would.
 *
 *   npm run delegate           # user0 delegates
 *   npm run delegate -- 1      # user1 delegates
 *
 * Calls the ACL `delegateForUserDecryption(holder, token, expiry)` from the user's
 * own wallet (the indexer never holds the user key — the API only *builds* this tx
 * via /delegations/quote; here the script signs it for the demo). The indexer then
 * sees the DelegatedForUserDecryption event and backfills that user's amounts after
 * the gateway propagation window (measured ~4s on Sepolia; up to ~1–2 min worst case).
 */
import { createWalletClient, http, maxUint64, parseGwei } from "viem";
import { accounts, env } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { aclAbi } from "../src/abis/acl";

/** Grant the indexer holder decrypt rights, signed by a test user (the delegator). */
async function main() {
  if (!env.TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS not set — run `npm run deploy`.");
  const idx = Number(process.argv[2] ?? 0);
  const user = accounts.testUsers[idx];
  if (!user) throw new Error(`No test user at index ${idx}`);
  const holder = accounts.indexerHolder.address;

  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? parseGwei("1");
  const maxPriorityFeePerGas = parseGwei("2");

  console.log(`\n${user.role} (${user.address}) delegating decrypt rights over`);
  console.log(`token ${env.TOKEN_ADDRESS} to holder ${holder} (permanent)\n`);

  const hash = await createWalletClient({ account: user.account, chain, transport: http(env.SEPOLIA_RPC_URL) }).writeContract({
    address: env.ACL_ADDRESS,
    abi: aclAbi,
    functionName: "delegateForUserDecryption",
    args: [holder, env.TOKEN_ADDRESS, maxUint64],
    account: user.account,
    chain,
    maxPriorityFeePerGas,
    maxFeePerGas: base * 3n + maxPriorityFeePerGas,
  });
  console.log(`delegation tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
  console.log(`\n✅ Delegated. The indexer will pick up the ACL event and backfill ${user.role}'s amounts`);
  console.log(`   after the gateway propagation window (~4s measured; up to ~1–2 min worst case).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
