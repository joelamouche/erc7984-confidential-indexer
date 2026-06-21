/**
 * Grant the indexer holder decrypt rights, as a partner user would.
 *
 *   npm run delegate              # user0 delegates
 *   npm run delegate -- 1         # user1 delegates
 *   npm run delegate -- subject   # the fresh non-delegated subject (from demo:reset) delegates
 *                                 # — this is the on-camera "delegate live → decrypt" beat
 *
 * Calls the ACL `delegateForUserDecryption(holder, token, expiry)` from the user's
 * own wallet (the indexer never holds the user key — the API only *builds* this tx
 * via /delegations/quote; here the script signs it for the demo). The indexer then
 * sees the DelegatedForUserDecryption event and backfills that user's amounts after
 * the gateway propagation window (measured ~4s on Sepolia; up to ~1–2 min worst case).
 */
import { createWalletClient, http, maxUint64, parseGwei } from "viem";
import { accounts, demoSubjectAccount, env, type RoleAccount } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { aclAbi } from "../src/abis/acl";

/** The demo's current non-delegated subject: the first one that isn't delegated yet. */
async function currentSubject(): Promise<RoleAccount> {
  for (let n = 0; n < 16; n++) {
    const subject = demoSubjectAccount(n);
    const expiry = await publicClient.readContract({
      address: env.ACL_ADDRESS,
      abi: aclAbi,
      functionName: "getUserDecryptionDelegationExpirationDate",
      args: [subject.address, accounts.indexerHolder.address, env.TOKEN_ADDRESS!],
    });
    if (expiry <= BigInt(Math.floor(Date.now() / 1000))) return subject;
  }
  throw new Error("No un-delegated demo subject found — run `npm run demo:reset` first.");
}

/** Grant the indexer holder decrypt rights, signed by a test user or the demo subject. */
async function main() {
  if (!env.TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS not set — run `npm run deploy`.");
  const arg = process.argv[2];
  const user = arg === "subject" ? await currentSubject() : accounts.testUsers[Number(arg ?? 0)];
  if (!user) throw new Error(`No test user at index ${arg}`);
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
