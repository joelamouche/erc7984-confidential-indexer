/**
 * Seed on-chain activity to give the indexer something to read.
 *
 *   npm run seed
 *
 * Phase 1 (this script, no SDK needed): deployer mints ToyUSD to a few users,
 * each user approves the wrapper and `wrap`s (shield) — producing
 * ConfidentialTransfer(address(0), user, handle) events. Confidential user→user
 * transfers (which need SDK-encrypted inputs) and a delegation step are layered
 * in later.
 */
import { createWalletClient, http, parseGwei, parseUnits, type Address, type Hex } from "viem";
import { accounts, env, type RoleAccount } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { loadAbi } from "../src/artifacts";

if (!env.UNDERLYING_USD_ADDRESS || !env.WRAPPER_ADDRESS) {
  throw new Error("UNDERLYING_USD_ADDRESS / WRAPPER_ADDRESS not set — run `npm run deploy` first.");
}
const TOY_USD = env.UNDERLYING_USD_ADDRESS;
const WRAPPER = env.WRAPPER_ADDRESS;
const toyUsdAbi = loadAbi("ToyUSD");
const wrapperAbi = loadAbi("ConfidentialUSD");

// (user, wrapAmount in whole tUSD) — 6 decimals applied below.
const PLAN: Array<{ user: RoleAccount; mint: string; wrap: string }> = [
  { user: accounts.testUsers[0]!, mint: "1000", wrap: "100" },
  { user: accounts.testUsers[1]!, mint: "1000", wrap: "250" },
  { user: accounts.testUsers[2]!, mint: "1000", wrap: "50" },
];

async function fees() {
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? parseGwei("1");
  const maxPriorityFeePerGas = parseGwei("2");
  return { maxPriorityFeePerGas, maxFeePerGas: base * 3n + maxPriorityFeePerGas };
}

function walletFor(role: RoleAccount) {
  return createWalletClient({ account: role.account, chain, transport: http(env.SEPOLIA_RPC_URL) });
}

async function write(
  role: RoleAccount,
  address: Address,
  abi: ReturnType<typeof loadAbi>,
  functionName: string,
  args: unknown[],
  feeOverrides: Awaited<ReturnType<typeof fees>>,
): Promise<Hex> {
  const hash = await walletFor(role).writeContract({
    address,
    abi,
    functionName,
    args,
    account: role.account,
    chain,
    ...feeOverrides,
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
  return hash;
}

async function main() {
  const f = await fees();
  const dec = 6;

  for (const { user, mint, wrap } of PLAN) {
    const mintAmt = parseUnits(mint, dec);
    const wrapAmt = parseUnits(wrap, dec);

    console.log(`\n${user.role} (${user.address})`);
    const m = await write(accounts.deployer, TOY_USD, toyUsdAbi, "mint", [user.address, mintAmt], f);
    console.log(`  mint ${mint} tUSD  ${m}`);
    const a = await write(user, TOY_USD, toyUsdAbi, "approve", [WRAPPER, wrapAmt], f);
    console.log(`  approve ${wrap}     ${a}`);
    const w = await write(user, WRAPPER, wrapperAbi, "wrap", [user.address, wrapAmt], f);
    console.log(`  wrap (shield) ${wrap} -> cUSD  ${w}`);
  }

  console.log(`\n✅ Seed complete. ${PLAN.length} shields on ${WRAPPER}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
