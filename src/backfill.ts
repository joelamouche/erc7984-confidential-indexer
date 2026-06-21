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
import type { Context } from "ponder:registry";
import { transfers, balances, delegations } from "ponder:schema";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getAddress, zeroAddress, type Address } from "viem";
import { env } from "./config";
import { HOLDER } from "./zama/sdk";
import type { DecryptState } from "./zama/state";
import { escalateState, routeAndDecrypt, type DecryptItem, type DecryptJob, type DecryptResult, type Update } from "./decrypt-router";

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

export async function runBackfill(db: Context["db"], blockTime: bigint): Promise<void> {
  const token = getAddress(env.TOKEN_ADDRESS as string);

  // Delegators whose grants are currently usable by the holder.
  const dels = await db.sql.select().from(delegations).where(eq(delegations.active, true));
  const activeDelegators = new Set<Address>(
    dels.filter((d: { expiry: bigint }) => d.expiry > blockTime).map((d: { delegator: string }) => getAddress(d.delegator)),
  );

  await backfillTransfers(db, token, blockTime, activeDelegators);
  await backfillBalances(db, token, blockTime, activeDelegators);
}

async function backfillTransfers(db: Context["db"], token: Address, blockTime: bigint, activeDelegators: Set<Address>) {
  const dueForRetry = or(isNull(transfers.lastAttemptAt), lt(transfers.lastAttemptAt, blockTime - BACKOFF_SECONDS));
  const pendingTransfers = await db.sql
    .select()
    .from(transfers)
    .where(and(eq(transfers.token, token), inArray(transfers.decryptionState, PENDING), isNull(transfers.amount), dueForRetry))
    .limit(BATCH);

  const decryptItems: DecryptItem[] = pendingTransfers.map((transfer) => ({
    id: transfer.id,
    handle: transfer.amountHandle,
    parties: [getAddress(transfer.from), getAddress(transfer.to)].filter((a) => a !== zeroAddress),
  }));

  const update: Update = async (id, patch) => {
    if (patch.state === "decrypted") console.log(`[backfill] decrypted transfer ${id} = ${patch.amount} (via ${patch.via})`);
    await db.update(transfers, { id }).set((current) => ({
      amount: patch.amount ?? current.amount,
      decryptionState: escalateState(patch.state, current.attempts + 1),
      decryptedVia: patch.via ?? current.decryptedVia,
      attempts: current.attempts + 1,
      lastAttemptAt: blockTime,
    }));
  };

  if (decryptItems.length) console.log(`[backfill] ${decryptItems.length} transfer(s) pending + due; routing to decrypt…`);
  await routeAndDecrypt(token, HOLDER, activeDelegators, decryptItems, runDecryptSubprocess, update);
}

async function backfillBalances(db: Context["db"], token: Address, blockTime: bigint, activeDelegators: Set<Address>) {
  const dueForRetry = or(isNull(balances.lastAttemptAt), lt(balances.lastAttemptAt, blockTime - BACKOFF_SECONDS));
  const pendingBalances = await db.sql
    .select()
    .from(balances)
    .where(and(eq(balances.token, token), inArray(balances.decryptionState, PENDING), isNull(balances.balance), dueForRetry))
    .limit(BATCH);

  const decryptItems: DecryptItem[] = pendingBalances.flatMap((balance) =>
    balance.balanceHandle == null ? [] : [{ id: balance.id, handle: balance.balanceHandle, parties: [getAddress(balance.account)] }],
  );

  const update: Update = async (id, patch) => {
    if (patch.state === "decrypted") console.log(`[backfill] decrypted balance  ${id} = ${patch.amount} (via ${patch.via})`);
    await db.update(balances, { id }).set((current) => ({
      balance: patch.amount ?? current.balance,
      decryptionState: escalateState(patch.state, current.attempts + 1),
      attempts: current.attempts + 1,
      lastAttemptAt: blockTime,
    }));
  };

  await routeAndDecrypt(token, HOLDER, activeDelegators, decryptItems, runDecryptSubprocess, update);
}
