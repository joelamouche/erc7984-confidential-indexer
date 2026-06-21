/**
 * INTEGRATION_SLOW — the full decryption-rights transition, end to end on Sepolia.
 *
 * This is the one flow the fast matrix can't pin: a row going
 *   indexed (pending_rights) → user delegates → entitled → decrypted
 * plus the matching /v1/health movement (decryptable.inFlight rises then drains).
 * It does REAL on-chain writes (mint + shield + delegate) and waits for the gateway
 * + a backfill tick, so it's gated and slow (~1–2 min) and skipped by default.
 *
 * Run it:
 *   1. start the indexer:  npm run dev   (and let it catch up to head)
 *   2. fund a FRESH, un-delegated user (default index 3 = user3) with a little gas
 *   3. INTEGRATION_SLOW=true npm test -- transition
 *
 * Single-use per user: once index N is delegated it stays delegated, so re-run with
 * a different TRANSITION_USER_INDEX (or revoke first).
 */
import { describe, expect, it } from "vitest";
import { createWalletClient, http, maxUint64, parseGwei, parseUnits, type Hex } from "viem";
import { accounts, env } from "../src/config";
import { chain, publicClient } from "../src/chain";
import { loadAbi } from "../src/artifacts";
import { aclAbi } from "../src/abis/acl";

const BASE = `http://localhost:${env.PORT}`;
const RUN = process.env.INTEGRATION_SLOW === "true";
const userIdx = Number(process.env.TRANSITION_USER_INDEX ?? 3);

interface TransferRow {
  kind: string;
  to: string;
  amount: string | null;
  decryptionState: string;
}
interface Health {
  decryptable: { inFlight: number; status: string };
}

async function reachable() {
  try {
    return (await fetch(`${BASE}/v1/health`)).status < 600;
  } catch {
    return false;
  }
}
const UP = RUN && (await reachable());

async function shieldRow(addr: string): Promise<TransferRow | undefined> {
  const res = await fetch(`${BASE}/v1/tokens/${env.TOKEN_ADDRESS}/addresses/${addr}/transfers`);
  const body = (await res.json()) as { transfers: TransferRow[] };
  return body.transfers.find((t) => t.kind === "shield" && t.to.toLowerCase() === addr.toLowerCase());
}
async function health(): Promise<Health> {
  return (await fetch(`${BASE}/v1/health`).then((r) => r.json())) as Health;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!UP)("decryption-rights transition (INTEGRATION_SLOW)", () => {
  it("pending_rights → delegate → decrypted, with health backlog rising then draining", async () => {
    const user = accounts.testUsers[userIdx]!;
    const token = env.TOKEN_ADDRESS!;
    const underlying = env.UNDERLYING_USD_ADDRESS!;
    const dec = 6;
    const whole = "70";
    const amount = parseUnits(whole, dec);
    const cleartext = amount.toString();
    const wallet = createWalletClient({ account: user.account, chain, transport: http(env.SEPOLIA_RPC_URL) });

    async function send(address: Hex, abi: ReturnType<typeof loadAbi>, fn: string, args: unknown[]) {
      const block = await publicClient.getBlock();
      const prio = parseGwei("2");
      const hash = await wallet.writeContract({
        address,
        abi,
        functionName: fn,
        args,
        account: user.account,
        chain,
        maxPriorityFeePerGas: prio,
        maxFeePerGas: (block.baseFeePerGas ?? parseGwei("1")) * 3n + prio,
      });
      await publicClient.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 3_000 });
    }

    // 1. Self-provision + shield (mint is a public faucet). Produces a
    //    ConfidentialTransfer(0, user, handle) the indexer records as a shield.
    await send(underlying, loadAbi("ToyUSD"), "mint", [user.address, amount]);
    await send(underlying, loadAbi("ToyUSD"), "approve", [token, amount]);
    await send(token, loadAbi("ConfidentialUSD"), "wrap", [user.address, amount]);

    // 2. Before delegation: indexed but NOT decryptable → pending_rights, not dropped.
    let row: TransferRow | undefined;
    for (let i = 0; i < 30 && !row; i++) {
      row = await shieldRow(user.address);
      if (!row) await sleep(3000);
    }
    expect(row, "shield must be indexed").toBeDefined();
    expect(row?.amount, "no rights yet → no cleartext").toBeNull();
    expect(row?.decryptionState).toBe("pending_rights");

    // 3. Delegate → the row becomes entitled work; health backlog should rise.
    await send(env.ACL_ADDRESS, aclAbi, "delegateForUserDecryption", [
      accounts.indexerHolder.address,
      token,
      maxUint64,
    ]);
    let rose = false;
    for (let i = 0; i < 30 && !rose; i++) {
      if ((await health()).decryptable.inFlight > 0) rose = true;
      else await sleep(3000);
    }
    expect(rose, "entitled-but-pending backlog must appear in /v1/health").toBe(true);

    // 4. Backfill decrypts it (gateway ~4s + a tick): pending → decrypted, drains.
    for (let i = 0; i < 40; i++) {
      row = await shieldRow(user.address);
      if (row?.amount != null) break;
      await sleep(3000);
    }
    expect(row?.decryptionState).toBe("decrypted");
    expect(row?.amount).toBe(cleartext);

    for (let i = 0; i < 20; i++) {
      if ((await health()).decryptable.inFlight === 0) break;
      await sleep(3000);
    }
    expect((await health()).decryptable.inFlight).toBe(0);
  }, 600_000);
});
