/**
 * Decryption backfill — runs on a Ponder `block` interval (see docs/INDEXER.md §5),
 * decoupled from the per-transfer handlers so gateway latency never blocks indexing.
 *
 * Each tick: load a bounded batch of pending/failed rows that are due for retry,
 * route each to a decrypt path (holder is a party, or a delegator delegated to the
 * holder), batch-decrypt via the SDK, and write cleartext + state back. Idempotent
 * and keyed by the immutable ciphertext handle, so reruns/reorgs are safe.
 */
import { spawn } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { transfers, balances, delegations } from "ponder:schema";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { env } from "./config";
import { HOLDER } from "./zama/sdk";
import { errorNameToState, type DecryptState } from "./zama/state";

interface SubprocessGroup {
  delegator: Address | null;
  handles: Hex[];
}
interface SubprocessResult {
  groups: Array<{ values?: Record<string, string>; errorName?: string }>;
}

/**
 * Run decryption in a plain-Node child process (the SDK can't run inside Ponder's
 * Vite SSR runtime — see scripts/decrypt-handles.ts). One spawn per tick handles
 * all groups; pipes the job in and parses cleartext out.
 */
function runDecryptSubprocess(job: { contractAddress: Address; groups: SubprocessGroup[] }): Promise<SubprocessResult> {
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

/** A unit of work: a handle to decrypt, plus the accounts that may be entitled. */
interface Item {
  id: string;
  handle: Hex;
  parties: Address[];
}

type Patch = { amount?: bigint; state: DecryptState; via: string | null };
type Update = (id: string, patch: Patch) => Promise<void>;

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

async function backfillTransfers(db: any, token: Address, blockTime: bigint, activeDelegators: Set<Address>) {
  const due = or(isNull(transfers.lastAttemptAt), lt(transfers.lastAttemptAt, blockTime - BACKOFF_SECONDS));
  const rows = await db.sql
    .select()
    .from(transfers)
    .where(and(eq(transfers.token, token), inArray(transfers.decryptionState, PENDING), isNull(transfers.amount), due))
    .limit(BATCH);

  const items: Item[] = rows.map((r: { id: string; amountHandle: Hex; from: string; to: string }) => ({
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

  await decryptItems(token, activeDelegators, items, update);
}

async function backfillBalances(db: any, token: Address, blockTime: bigint, activeDelegators: Set<Address>) {
  const due = or(isNull(balances.lastAttemptAt), lt(balances.lastAttemptAt, blockTime - BACKOFF_SECONDS));
  const rows = await db.sql
    .select()
    .from(balances)
    .where(and(eq(balances.token, token), inArray(balances.decryptionState, PENDING), isNull(balances.balance), due))
    .limit(BATCH);

  const items: Item[] = rows
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

  await decryptItems(token, activeDelegators, items, update);
}

/** Route items to a decrypt path, batch per path, decrypt out-of-process, write back. */
async function decryptItems(token: Address, activeDelegators: Set<Address>, items: Item[], update: Update) {
  const holderGroup: Item[] = [];
  const delegatedGroups = new Map<Address, Item[]>();
  const noRights: Item[] = [];

  for (const it of items) {
    if (it.parties.includes(HOLDER)) {
      holderGroup.push(it);
    } else {
      const delegator = it.parties.find((p) => activeDelegators.has(p));
      if (delegator) {
        const g = delegatedGroups.get(delegator) ?? [];
        g.push(it);
        delegatedGroups.set(delegator, g);
      } else {
        noRights.push(it);
      }
    }
  }

  // No rights: don't call the gateway — just record the attempt (stays pending_rights).
  for (const it of noRights) await update(it.id, { state: "pending_rights", via: null });

  // Build one job (holder group + a group per delegator) and decrypt in one spawn.
  const groups: Array<{ delegator: Address | null; via: string; items: Item[] }> = [];
  if (holderGroup.length) groups.push({ delegator: null, via: "holder", items: holderGroup });
  for (const [delegator, group] of delegatedGroups) groups.push({ delegator, via: "delegation", items: group });
  if (groups.length === 0) return;

  let result: SubprocessResult;
  try {
    result = await runDecryptSubprocess({
      contractAddress: token,
      groups: groups.map((g) => ({ delegator: g.delegator, handles: handles(g.items) })),
    });
  } catch (err) {
    console.warn("[backfill] decrypt subprocess failed:", (err as Error)?.message ?? err);
    for (const g of groups) for (const it of g.items) await update(it.id, { state: "failed", via: null });
    return;
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const r = result.groups[i];
    if (r?.values) {
      for (const it of g.items) {
        const cv = r.values[it.handle];
        if (cv !== undefined) await update(it.id, { amount: BigInt(cv), state: "decrypted", via: g.via });
        else await update(it.id, { state: "pending_rights", via: null });
      }
    } else {
      const state = errorNameToState(r?.errorName);
      console.warn(`[backfill] ${g.via} decrypt of ${g.items.length} -> ${state} (${r?.errorName})`);
      for (const it of g.items) await update(it.id, { state, via: null });
    }
  }
}

function handles(items: Item[]): Hex[] {
  return [...new Set(items.map((i) => i.handle))];
}
