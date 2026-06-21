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
    child.stdout.on("data", (chunk) => (out += chunk.toString()));
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

// Max rows drained per backfill run, *per table* (so up to BATCH transfers + BATCH
// balances each run). The batch is decrypted in ONE batched SDK call, so this
// bounds per-run work and gateway payload size — not the number of round-trips.
// Sustained throughput ≈ BATCH ÷ the Backfill block interval (~24s, see
// ponder.config.ts) ≈ ~1 row/s; raise BATCH and/or shorten the interval for more.
// The real scale answer (worker fleet, parallel batches) is docs/INDEXER.md §6.
const BATCH = 25;
// Minimum seconds between decrypt retries for the *same* row (gated via
// lastAttemptAt). Stops not-yet-decryptable rows from re-consuming the batch every
// run, so genuinely-due work isn't crowded out.
const BACKOFF_SECONDS = 60n;
// The states the backfill re-attempts. `pending_rights` is kept here as a safety
// net — rows are normally promoted out of it event-driven by the ACL handler when
// a delegation is indexed; this re-scan only catches anything the events missed.
const PENDING: DecryptState[] = ["pending_rights", "pending_propagation", "failed"];

/** One backfill tick: resolve who we can decrypt for, then drain pending transfers + balances. */
export async function runBackfill(db: Context["db"], blockTime: bigint): Promise<void> {
  const token = getAddress(env.TOKEN_ADDRESS as string);

  // Delegators whose grants are currently usable by the holder (active + unexpired).
  const activeDelegations = await db.sql.select().from(delegations).where(eq(delegations.active, true));
  const activeDelegators = new Set<Address>(
    activeDelegations
      .filter((delegation: { expiry: bigint }) => delegation.expiry > blockTime)
      .map((delegation: { delegator: string }) => getAddress(delegation.delegator)),
  );

  await backfillTransfers(db, token, blockTime, activeDelegators);
  await backfillBalances(db, token, blockTime, activeDelegators);
}

/** Decrypt a bounded batch of pending, retry-due transfer amounts; persist outcomes. */
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

/** Decrypt a bounded batch of pending, retry-due balance handles; persist outcomes. */
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
