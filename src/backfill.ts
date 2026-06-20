/**
 * Decryption backfill — runs on a Ponder `block` interval (see docs/INDEXER.md §5),
 * decoupled from the per-transfer handlers so gateway latency never blocks indexing.
 *
 * Each tick: load a bounded batch of pending/failed rows that are due for retry,
 * hand them to the pure router (src/decrypt-router.ts), and persist the outcomes.
 * Decryption runs in a child process because the SDK can't run inside Ponder's Vite
 * SSR runtime. Idempotent and keyed by the immutable ciphertext handle.
 */
import { spawn } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { transfers, balances, delegations } from "ponder:schema";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { env } from "./config";
import { HOLDER } from "./zama/sdk";
import type { DecryptState } from "./zama/state";
import { routeAndDecrypt, type DecryptItem, type DecryptJob, type DecryptResult, type Update } from "./decrypt-router";

/**
 * Run decryption in a plain-Node child process (the SDK can't run inside Ponder's
 * Vite SSR runtime — see scripts/decrypt-handles.ts). One spawn per tick handles
 * all groups; pipes the job in and parses cleartext out.
 */
function runDecryptSubprocess(job: DecryptJob): Promise<DecryptResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(pathResolve("node_modules/.bin/tsx"), ["scripts/decrypt-handles.ts"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => {
      if (code !== 0) return rejectP(new Error(`decrypt subprocess exited ${code}`));
      try {
        resolveP(JSON.parse(out));
      } catch (e) {
        rejectP(e);
      }
    });
    child.stdin.write(JSON.stringify(job));
    child.stdin.end();
  });
}

const BATCH = 25;
const BACKOFF_SECONDS = 60n;
const PENDING: DecryptState[] = ["pending_rights", "pending_propagation", "failed"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runBackfill(db: any, blockTime: bigint): Promise<void> {
  const token = getAddress(env.TOKEN_ADDRESS as string);

  // Delegators whose grants are currently usable by the holder.
  const dels = await db.sql.select().from(delegations).where(eq(delegations.active, true));
  const activeDelegators = new Set<Address>(
    dels.filter((d: { expiry: bigint }) => d.expiry > blockTime).map((d: { delegator: string }) => getAddress(d.delegator)),
  );

  await backfillTransfers(db, token, blockTime, activeDelegators);
  await backfillBalances(db, token, blockTime, activeDelegators);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function backfillTransfers(db: any, token: Address, blockTime: bigint, activeDelegators: Set<Address>) {
  const due = or(isNull(transfers.lastAttemptAt), lt(transfers.lastAttemptAt, blockTime - BACKOFF_SECONDS));
  const rows = await db.sql
    .select()
    .from(transfers)
    .where(and(eq(transfers.token, token), inArray(transfers.decryptionState, PENDING), isNull(transfers.amount), due))
    .limit(BATCH);

  const items: DecryptItem[] = rows.map((r: { id: string; amountHandle: Hex; from: string; to: string }) => ({
    id: r.id,
    handle: r.amountHandle,
    parties: [getAddress(r.from), getAddress(r.to)].filter((a) => a !== zeroAddress),
  }));

  const update: Update = async (id, patch) => {
    await db.update(transfers, { id }).set((row: { amount: bigint | null; decryptedVia: string | null; attempts: number }) => ({
      amount: patch.amount ?? row.amount,
      decryptionState: patch.state,
      decryptedVia: patch.via ?? row.decryptedVia,
      attempts: row.attempts + 1,
      lastAttemptAt: blockTime,
    }));
  };

  await routeAndDecrypt(token, HOLDER, activeDelegators, items, runDecryptSubprocess, update);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function backfillBalances(db: any, token: Address, blockTime: bigint, activeDelegators: Set<Address>) {
  const due = or(isNull(balances.lastAttemptAt), lt(balances.lastAttemptAt, blockTime - BACKOFF_SECONDS));
  const rows = await db.sql
    .select()
    .from(balances)
    .where(and(eq(balances.token, token), inArray(balances.decryptionState, PENDING), isNull(balances.balance), due))
    .limit(BATCH);

  const items: DecryptItem[] = rows
    .filter((r: { balanceHandle: Hex | null }) => r.balanceHandle != null)
    .map((r: { id: string; balanceHandle: Hex; account: string }) => ({
      id: r.id,
      handle: r.balanceHandle,
      parties: [getAddress(r.account)],
    }));

  const update: Update = async (id, patch) => {
    await db.update(balances, { id }).set((row: { balance: bigint | null; attempts: number }) => ({
      balance: patch.amount ?? row.balance,
      decryptionState: patch.state,
      attempts: row.attempts + 1,
      lastAttemptAt: blockTime,
    }));
  };

  await routeAndDecrypt(token, HOLDER, activeDelegators, items, runDecryptSubprocess, update);
}
