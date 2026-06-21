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
import { createWalletClient, http, parseGwei, parseUnits, zeroHash, type Address, type Hex } from "viem";
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

/** Current EIP-1559 fee overrides with headroom for Sepolia volatility. */
async function fees() {
  const block = await publicClient.getBlock();
  const base = block.baseFeePerGas ?? parseGwei("1");
  const maxPriorityFeePerGas = parseGwei("2");
  return { maxPriorityFeePerGas, maxFeePerGas: base * 3n + maxPriorityFeePerGas };
}

/** A wallet client bound to a given role's account. */
function walletFor(role: RoleAccount) {
  return createWalletClient({ account: role.account, chain, transport: http(env.SEPOLIA_RPC_URL) });
}

/** Send a contract write from a role and wait for its receipt; retry transient reverts.
 * FHE writes (`wrap`) intermittently revert with a transient coprocessor error
 * (ZamaProtocolUnsupported) on Sepolia — a retry clears it, so the seed is reliable. */
async function write(
  role: RoleAccount,
  address: Address,
  abi: ReturnType<typeof loadAbi>,
  functionName: string,
  args: unknown[],
  feeOverrides: Awaited<ReturnType<typeof fees>>,
  // Explicit gas for FHE ops (`wrap`) so viem skips the flaky eth_estimateGas
  // simulation (see transfer.ts); omitted for cheap ERC20 calls that estimate fine.
  gas?: bigint,
): Promise<Hex> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const hash = await walletFor(role).writeContract({ address, abi, functionName, args, account: role.account, chain, ...feeOverrides, ...(gas ? { gas } : {}) });
      await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
      return hash;
    } catch (err) {
      lastError = err;
      console.log(`  ${functionName} attempt ${attempt}/3 failed (transient?), retrying…`);
    }
  }
  throw lastError;
}

/** Already holds a confidential balance (a prior shield)? Lets the seed be idempotent. */
async function hasShield(addr: Address): Promise<boolean> {
  const handle = await publicClient.readContract({ address: WRAPPER, abi: wrapperAbi, functionName: "confidentialBalanceOf", args: [addr] });
  return handle !== zeroHash;
}

/** Mint ToyUSD to each test user and wrap (shield) a chunk into confidential cUSD. */
async function main() {
  const f = await fees();
  const dec = 6;

  for (const { user, mint, wrap } of PLAN) {
    console.log(`\n${user.role} (${user.address})`);
    if (await hasShield(user.address)) {
      console.log(`  already shielded ✓ (skipping)`);
      continue;
    }
    const mintAmt = parseUnits(mint, dec);
    const wrapAmt = parseUnits(wrap, dec);

    const m = await write(accounts.deployer, TOY_USD, toyUsdAbi, "mint", [user.address, mintAmt], f);
    console.log(`  mint ${mint} tUSD  ${m}`);
    const a = await write(user, TOY_USD, toyUsdAbi, "approve", [WRAPPER, wrapAmt], f);
    console.log(`  approve ${wrap}     ${a}`);
    const w = await write(user, WRAPPER, wrapperAbi, "wrap", [user.address, wrapAmt], f, 900_000n);
    console.log(`  wrap (shield) ${wrap} -> cUSD  ${w}`);
  }

  console.log(`\n✅ Seed complete. ${PLAN.length} shields on ${WRAPPER}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
