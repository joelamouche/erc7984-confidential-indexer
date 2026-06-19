/**
 * Decryption backfill — runs on a Ponder `block` interval (see docs/INDEXER.md §5),
 * decoupled from the per-transfer handlers so gateway latency never blocks indexing.
 *
 * Each tick: load a bounded batch of pending/failed rows that are due for retry,
 * route each to a decrypt path (holder is a party, or a delegator delegated to the
 * holder), batch-decrypt via the SDK, and write cleartext + state back. Idempotent
 * and keyed by the immutable ciphertext handle, so reruns/reorgs are safe.
 */
import { transfers, balances, delegations } from "ponder:schema";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { env } from "./config";
import { HOLDER, holderDecrypt, delegatedDecrypt } from "./zama/sdk";
import { errorToState, type DecryptState } from "./zama/state";

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

/** Route items to a decrypt path, batch per path, decrypt, and write results back. */
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

  if (holderGroup.length) {
    await runGroup(holderGroup, () => holderDecrypt(handles(holderGroup), token), "holder", update);
  }
  for (const [delegator, group] of delegatedGroups) {
    await runGroup(group, () => delegatedDecrypt(handles(group), token, delegator), "delegation", update);
  }
}

async function runGroup(
  group: Item[],
  call: () => Promise<Record<Hex, bigint>>,
  via: string,
  update: Update,
) {
  try {
    const result = await call();
    for (const it of group) {
      const cleartext = result[it.handle];
      if (cleartext !== undefined) await update(it.id, { amount: cleartext, state: "decrypted", via });
      else await update(it.id, { state: "pending_rights", via: null });
    }
  } catch (err) {
    const state = errorToState(err);
    for (const it of group) await update(it.id, { state, via: null });
  }
}

function handles(items: Item[]): Hex[] {
  return [...new Set(items.map((i) => i.handle))];
}
