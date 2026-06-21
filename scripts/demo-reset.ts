/**
 * Put the chain into a known, clean state for a fresh demo, and print the
 * addresses to use — so docs/DEMO.md never hardcodes who's delegated.
 *
 *   npm run demo:reset
 *
 * It establishes:
 *   - a DELEGATED cohort (the configured test users) → clean *decrypted* history;
 *   - one NON-DELEGATED subject: a fresh account (derived beyond the test users)
 *     with a single shield → clean *pending* history.
 *
 * Why a *fresh* subject and not a revoked one: a user that was ever delegated
 * re-syncs to `failed` (the gateway rejects historical decrypts once it's revoked),
 * not a tidy `pending`. A never-delegated account stays cleanly pending. See the
 * "Resetting between demos" caveats in docs/DEMO.md.
 *
 * Idempotent: re-delegates only cohort members that aren't, and provisions the
 * subject only if it has no shield yet. If a prior demo delegated the subject on
 * camera, this advances to the next fresh subject automatically.
 */
import { createWalletClient, http, maxUint64, parseEther, parseGwei, parseUnits, zeroHash, type Address } from "viem";
import { type HDAccount } from "viem/accounts";
import { accounts, demoSubjectAccount, env, type RoleAccount } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { aclAbi } from "../src/abis/acl";
import { loadAbi } from "../src/artifacts";
import { confidentialTokenAbi } from "../src/abis/confidentialToken";

const HOLDER = accounts.indexerHolder.address;
const TOKEN = env.TOKEN_ADDRESS!;
const UNDERLYING = env.UNDERLYING_USD_ADDRESS!;
// Whole cUSD a fresh subject wraps — several shields so it has *multiple* pending
// rows that all flip to decrypted when it delegates on camera (more dramatic than one).
const SUBJECT_SHIELDS = ["50", "30", "20"];
const SUBJECT_GAS_ETH = "0.03"; // enough for 3× (mint+approve+wrap) + a later on-camera delegate
const MAX_SUBJECTS = 16; // how far past the test users we'll look for a fresh subject

/** Current EIP-1559 fee overrides with headroom for Sepolia volatility. */
async function fees() {
  const block = await publicClient.getBlock();
  const maxPriorityFeePerGas = parseGwei("2");
  return { maxPriorityFeePerGas, maxFeePerGas: (block.baseFeePerGas ?? parseGwei("1")) * 3n + maxPriorityFeePerGas };
}

/** Is this address's delegation to the holder currently active (unexpired)? */
async function isDelegated(addr: Address): Promise<boolean> {
  const expiry = await publicClient.readContract({
    address: env.ACL_ADDRESS,
    abi: aclAbi,
    functionName: "getUserDecryptionDelegationExpirationDate",
    args: [addr, HOLDER, TOKEN],
  });
  return expiry > BigInt(Math.floor(Date.now() / 1000));
}

/** Does this account already hold a confidential balance (a prior shield)? */
async function hasShield(addr: Address): Promise<boolean> {
  const handle = await publicClient.readContract({
    address: TOKEN,
    abi: confidentialTokenAbi,
    functionName: "confidentialBalanceOf",
    args: [addr],
  });
  return handle !== zeroHash; // a never-funded account returns the zero handle
}

/** Send a write from `account` and wait for the receipt; retry transient reverts.
 * FHE writes (e.g. `wrap`) occasionally revert with a transient coprocessor error
 * (ZamaProtocolUnsupported) on Sepolia — a retry clears it, so the reset is reliable. */
async function send(account: HDAccount, address: Address, abi: ReturnType<typeof loadAbi>, fn: string, args: unknown[], gas?: bigint) {
  const wallet = createWalletClient({ account, chain, transport: http(env.SEPOLIA_RPC_URL) });
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Explicit gas for FHE ops (`wrap`) so viem skips the flaky eth_estimateGas simulation (see transfer.ts).
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

/** Re-delegate any cohort member that isn't currently delegated. */
async function ensureCohortDelegated(cohort: RoleAccount[]) {
  for (const member of cohort) {
    if (await isDelegated(member.address)) {
      console.log(`  ${member.role} (${member.address}) — already delegated ✓`);
      continue;
    }
    await send(member.account, env.ACL_ADDRESS, aclAbi, "delegateForUserDecryption", [HOLDER, TOKEN, maxUint64]);
    console.log(`  ${member.role} (${member.address}) — re-delegated`);
  }
}

/** Find the first fresh (never-delegated) subject and ensure it has a pending shield. */
async function provisionSubject(): Promise<Address> {
  for (let n = 0; n < MAX_SUBJECTS; n++) {
    const subject = demoSubjectAccount(n).account;
    if (await isDelegated(subject.address)) continue; // used by a prior demo — skip
    console.log(`\nNon-delegated subject: ${subject.address}`);
    if (await hasShield(subject.address)) {
      console.log("  already has shields ✓ (run `npm run subject:topup` to add more)");
    } else {
      await ensureGas(subject.address, SUBJECT_GAS_ETH);
      for (const whole of SUBJECT_SHIELDS) {
        const amount = parseUnits(whole, 6);
        await send(subject, UNDERLYING, loadAbi("ToyUSD"), "mint", [subject.address, amount]);
        await send(subject, UNDERLYING, loadAbi("ToyUSD"), "approve", [TOKEN, amount]);
        await send(subject, TOKEN, loadAbi("ConfidentialUSD"), "wrap", [subject.address, amount], 900_000n);
        console.log(`  shielded ${whole} cUSD (pending, never delegated)`);
      }
    }
    return subject.address;
  }
  throw new Error(`No fresh subject in the first ${MAX_SUBJECTS} indices — they're all delegated.`);
}

/** Establish the demo's known state and print the addresses to use. */
async function main() {
  if (!env.TOKEN_ADDRESS || !env.UNDERLYING_USD_ADDRESS) throw new Error("TOKEN/UNDERLYING not set — run `npm run deploy`.");
  console.log(`\nResetting demo state on ${chain.name}. Holder: ${HOLDER}\n`);

  console.log("Delegated cohort (clean decrypted history):");
  await ensureCohortDelegated(accounts.testUsers);

  const subject = await provisionSubject();

  console.log(`\n✅ Demo state ready.\n`);
  console.log(`   DELEGATED   (cleartext): ${accounts.testUsers.map((u) => u.address).join(", ")}`);
  console.log(`   NONDELEGATED (pending) : ${subject}`);
  console.log(`\nNext: clear the DB for a fresh sync (rm -rf .ponder) or just \`npm run dev\` to resume.`);
  console.log(`Use the addresses above in the demo (export DELEGATED=… NONDELEGATED=${subject}).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
