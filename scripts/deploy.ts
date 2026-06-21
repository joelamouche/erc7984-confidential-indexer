/**
 * Deploy ToyUSD + ConfidentialUSD to the configured chain (Sepolia) and write the
 * resulting addresses + start block back into .env.
 *
 *   npm run deploy
 *
 * Uses the compiled Foundry artifacts in contracts/out (run contracts/setup.sh
 * first if they're missing). Deploys as the deployer role (mnemonic index 1).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWalletClient, getAddress, http, parseGwei, type Abi, type Hex } from "viem";
import { accounts, env } from "../src/config";
import { chain, publicClient } from "../src/chain";

/** Load a compiled contract's ABI + bytecode from contracts/out. */
function loadArtifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(`contracts/out/${name}.sol/${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  const bytecode = json.bytecode?.object as Hex | undefined;
  if (!bytecode || bytecode === "0x") {
    throw new Error(`No bytecode in ${path} — run contracts/setup.sh to build.`);
  }
  return { abi: json.abi as Abi, bytecode };
}

/** Upsert KEY="value" lines into .env, preserving the rest of the file. */
function updateEnvFile(updates: Record<string, string>) {
  const path = resolve(".env");
  let content = readFileSync(path, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}="${value}"`;
    const re = new RegExp(`^${key}=.*$`, "m");
    content = re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync(path, content);
}

interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Deploy one contract (explicit nonce + bumped fees) and return its address + block. */
async function deploy(
  wallet: ReturnType<typeof createWalletClient>,
  name: string,
  args: unknown[],
  nonce: number,
  fees: Fees,
): Promise<{ address: `0x${string}`; blockNumber: bigint }> {
  const { abi, bytecode } = loadArtifact(name);
  // Explicit nonce + bumped fees so a previously stuck tx at this nonce is
  // replaced rather than queued behind, and so we don't underprice on Sepolia.
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args,
    account: accounts.deployer.account,
    chain,
    nonce,
    ...fees,
  });
  console.log(`  ${name} tx (nonce ${nonce}): ${hash} — waiting for confirmation…`);
  // Sepolia public RPCs can be slow; wait generously rather than failing fast.
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: 240_000,
    pollingInterval: 4_000,
    retryCount: 10,
  });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name} deploy failed (${hash})`);
  }
  console.log(`→ ${name}: ${receipt.contractAddress}  (block ${receipt.blockNumber}, tx ${hash})`);
  return { address: getAddress(receipt.contractAddress), blockNumber: receipt.blockNumber };
}

/** Deploy ToyUSD + ConfidentialUSD to Sepolia and write the addresses into .env. */
async function main() {
  console.log(`\nDeploying to ${chain.name} (${env.CHAIN_ID}) as deployer ${accounts.deployer.address}\n`);

  const wallet = createWalletClient({
    account: accounts.deployer.account,
    chain,
    transport: http(env.SEPOLIA_RPC_URL),
  });

  // Start from the latest (mined) nonce so we replace any stuck pending tx, and
  // price with a healthy priority fee + 3x base headroom for Sepolia volatility.
  const nonce = await publicClient.getTransactionCount({
    address: accounts.deployer.address,
    blockTag: "latest",
  });
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? parseGwei("1");
  const maxPriorityFeePerGas = parseGwei("2");
  const fees: Fees = { maxPriorityFeePerGas, maxFeePerGas: baseFee * 3n + maxPriorityFeePerGas };
  console.log(`Nonce ${nonce}, maxFee ${fees.maxFeePerGas} wei, priority ${maxPriorityFeePerGas} wei\n`);

  const toyUSD = await deploy(wallet, "ToyUSD", [], nonce, fees);
  const confidentialUSD = await deploy(wallet, "ConfidentialUSD", [toyUSD.address], nonce + 1, fees);

  // The confidential token IS the wrapper: TOKEN and WRAPPER point at the same
  // address; START_BLOCK is its deploy block so the indexer backfills from there.
  updateEnvFile({
    UNDERLYING_USD_ADDRESS: toyUSD.address,
    TOKEN_ADDRESS: confidentialUSD.address,
    WRAPPER_ADDRESS: confidentialUSD.address,
    START_BLOCK: confidentialUSD.blockNumber.toString(),
  });

  console.log(`\n✅ Deployed. Wrote TOKEN/WRAPPER/UNDERLYING/START_BLOCK to .env.`);
  console.log(`   ConfidentialUSD (indexer target): ${confidentialUSD.address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
