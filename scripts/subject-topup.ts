/**
 * Add more shields to the current non-delegated demo subject, so it has several
 * pending rows — a more dramatic on-camera flip when it delegates (many rows go
 * pending → decrypted at once), instead of a lone single tx.
 *
 *   npm run subject:topup              # adds the default extra shields (30, 20)
 *   npm run subject:topup -- 40 25 15  # custom amounts (whole cUSD)
 *
 * Targets the same subject demo:reset reports (the first non-delegated one). Each
 * amount is a fresh mint + wrap → one more ConfidentialTransfer(0x0, subject), which
 * stays pending_rights until the subject delegates. See docs/DEMO.md.
 */
import { createWalletClient, http, parseEther, parseGwei, parseUnits, type Address } from "viem";
import { type HDAccount } from "viem/accounts";
import { accounts, demoSubjectAccount, env, type RoleAccount } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { aclAbi } from "../src/abis/acl";
import { loadAbi } from "../src/artifacts";

const DEFAULT_SHIELDS = ["30", "20"]; // extra wraps if no amounts are passed
const WRAP_GAS = 900_000n; // explicit so viem skips the flaky eth_estimateGas (see transfer.ts)

/** Current EIP-1559 fee overrides with headroom for Sepolia volatility. */
async function fees() {
  const block = await publicClient.getBlock();
  const maxPriorityFeePerGas = parseGwei("2");
  return { maxPriorityFeePerGas, maxFeePerGas: (block.baseFeePerGas ?? parseGwei("1")) * 3n + maxPriorityFeePerGas };
}

/** Send a write from `account`, retrying transient coprocessor reverts; explicit gas for FHE ops. */
async function send(account: HDAccount, address: Address, abi: ReturnType<typeof loadAbi>, fn: string, args: unknown[], gas?: bigint) {
  const wallet = createWalletClient({ account, chain, transport: http(env.SEPOLIA_RPC_URL) });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const hash = await wallet.writeContract({ address, abi, functionName: fn, args, account, chain, ...(await fees()), ...(gas ? { gas } : {}) });
      await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
      return hash;
    } catch (err) {
      lastError = err;
      console.log(`  ${fn} attempt ${attempt}/3 failed (transient?), retrying…`);
    }
  }
  throw lastError;
}

/** Top an account up to `minEth` from the funder if it's below. */
async function ensureGas(addr: Address, minEth: string) {
  const have = await publicClient.getBalance({ address: addr });
  const min = parseEther(minEth);
  if (have >= min) return;
  const wallet = createWalletClient({ account: accounts.funder.account, chain, transport: http(env.SEPOLIA_RPC_URL) });
  const hash = await wallet.sendTransaction({ to: addr, value: min - have, ...(await fees()) });
  await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 4_000 });
}

/** The demo's current non-delegated subject (first one without an active delegation). */
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

/** Add extra shields to the current non-delegated subject. */
async function main() {
  if (!env.TOKEN_ADDRESS || !env.UNDERLYING_USD_ADDRESS) throw new Error("TOKEN/UNDERLYING not set — run `npm run deploy`.");
  const amounts = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SHIELDS;
  const subject = await currentSubject();
  console.log(`\nAdding ${amounts.length} shield(s) to non-delegated subject ${subject.address}\n`);

  // One mint + wrap per amount → one pending ConfidentialTransfer row each.
  await ensureGas(subject.address, "0.012");
  for (const whole of amounts) {
    const amount = parseUnits(whole, 6);
    await send(subject.account, env.UNDERLYING_USD_ADDRESS, loadAbi("ToyUSD"), "mint", [subject.address, amount]);
    await send(subject.account, env.UNDERLYING_USD_ADDRESS, loadAbi("ToyUSD"), "approve", [env.TOKEN_ADDRESS, amount]);
    await send(subject.account, env.TOKEN_ADDRESS, loadAbi("ConfidentialUSD"), "wrap", [subject.address, amount], WRAP_GAS);
    console.log(`  shielded ${whole} cUSD (pending)`);
  }
  console.log(`\n✅ Subject ${subject.address} now has more pending rows; they all flip when it delegates.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
