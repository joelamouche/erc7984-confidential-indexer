/**
 * Fan gas out from the funder (index 0) to the other roles.
 *
 *   npm run fund
 *
 * Idempotent: each role is topped up TO its target balance (FUND_*_ETH), so
 * re-running only sends the shortfall. Bails out with a clear message (and the
 * funder address to faucet) if the funder can't cover the required total + a gas
 * buffer, rather than half-funding and leaving a confusing state.
 */
import { createWalletClient, formatEther, http, parseEther } from "viem";
import { accounts, env, type RoleAccount } from "../src/config";
import { chain, publicClient } from "../src/chain";

interface Target {
  role: RoleAccount;
  target: bigint;
}

async function main() {
  const targets: Target[] = [
    { role: accounts.deployer, target: parseEther(env.FUND_DEPLOYER_ETH) },
    { role: accounts.indexerHolder, target: parseEther(env.FUND_INDEXER_HOLDER_ETH) },
    ...accounts.testUsers.map((u) => ({ role: u, target: parseEther(env.FUND_TEST_USER_ETH) })),
  ];

  // Compute shortfalls (top-up semantics).
  const plan = await Promise.all(
    targets.map(async ({ role, target }) => {
      const balance = await publicClient.getBalance({ address: role.address });
      const topUp = balance >= target ? 0n : target - balance;
      return { role, target, balance, topUp };
    }),
  );

  const required = plan.reduce((sum, p) => sum + p.topUp, 0n);
  const transfers = plan.filter((p) => p.topUp > 0n);

  console.log(`\nFunder: ${accounts.funder.address}`);
  const funderBalance = await publicClient.getBalance({ address: accounts.funder.address });
  console.log(`Funder balance: ${formatEther(funderBalance)} ETH\n`);

  console.table(
    plan.map((p) => ({
      role: p.role.role,
      address: p.role.address,
      current: formatEther(p.balance),
      target: formatEther(p.target),
      topUp: formatEther(p.topUp),
    })),
  );

  if (transfers.length === 0) {
    console.log("\n✅ All roles already at target. Nothing to send.");
    return;
  }

  // Gas buffer for the funding transactions themselves (plain 21k transfers).
  const gasPrice = await publicClient.getGasPrice();
  const gasBuffer = gasPrice * 21_000n * BigInt(transfers.length) * 2n; // 2x margin
  const needed = required + gasBuffer;

  if (funderBalance < needed) {
    console.error(
      `\n❌ Funder is short. Need ~${formatEther(needed)} ETH (top-ups ${formatEther(
        required,
      )} + gas ${formatEther(gasBuffer)}), have ${formatEther(funderBalance)}.`,
    );
    console.error(`   Faucet the funder (${accounts.funder.address}) and re-run \`npm run fund\`.`);
    process.exit(1);
  }

  const wallet = createWalletClient({
    account: accounts.funder.account,
    chain,
    transport: http(env.SEPOLIA_RPC_URL),
  });

  // Sequential to keep nonces simple and output legible.
  for (const { role, topUp } of transfers) {
    const hash = await wallet.sendTransaction({ to: role.address, value: topUp });
    console.log(`→ ${formatEther(topUp)} ETH to ${role.role} (${role.address})  ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
  }

  console.log("\n✅ Funding complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
