/**
 * Revoke the indexer holder's decrypt rights for a test user — the on-chain half of
 * resetting the demo (so a previously-delegated user starts un-delegated again).
 *
 *   npm run revoke -- 0        # user0 revokes
 *   npm run revoke             # revokes ALL currently-delegated test users
 *
 * Signed by the user (the delegator), like delegate.ts. After this + clearing the
 * DB (`rm -rf .ponder`), a fresh `npm run dev` re-indexes Delegated→Revoked and the
 * user shows as not delegated, ready to delegate live on camera. See docs/DEMO.md.
 */
import { createWalletClient, http, parseGwei } from "viem";
import { accounts, env, type RoleAccount } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { aclAbi } from "../src/abis/acl";

/** Revoke one user's delegation to the holder; no-op (logged) if not delegated. */
async function revokeFor(user: RoleAccount): Promise<void> {
  const holder = accounts.indexerHolder.address;
  const token = env.TOKEN_ADDRESS!;
  const expiry = await publicClient.readContract({
    address: env.ACL_ADDRESS,
    abi: aclAbi,
    functionName: "getUserDecryptionDelegationExpirationDate",
    args: [user.address, holder, token],
  });
  if (expiry === 0n) {
    console.log(`${user.role} (${user.address}) — already not delegated, skipping`);
    return;
  }

  const block = await publicClient.getBlock();
  const prio = parseGwei("2");
  const hash = await createWalletClient({ account: user.account, chain, transport: http(env.SEPOLIA_RPC_URL) }).writeContract(
    {
      address: env.ACL_ADDRESS,
      abi: aclAbi,
      functionName: "revokeDelegationForUserDecryption",
      args: [holder, token],
      account: user.account,
      chain,
      maxPriorityFeePerGas: prio,
      maxFeePerGas: (block.baseFeePerGas ?? parseGwei("1")) * 3n + prio,
    },
  );
  await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
  console.log(`${user.role} (${user.address}) — revoked  ${hash}`);
}

/** Revoke one test user (by index arg) or all of them. */
async function main() {
  if (!env.TOKEN_ADDRESS) throw new Error("TOKEN_ADDRESS not set.");
  const arg = process.argv[2];
  const users = arg !== undefined ? [accounts.testUsers[Number(arg)]!] : accounts.testUsers;
  console.log(`Revoking decrypt rights over ${env.TOKEN_ADDRESS} from holder ${accounts.indexerHolder.address}\n`);
  for (const user of users) await revokeFor(user);
  console.log(`\n✅ Done. Now clear the DB (rm -rf .ponder) for a fully fresh demo.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
