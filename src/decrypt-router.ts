/**
 * Pure decryption routing — the decision logic for the backfill, separated from
 * the Ponder-coupled db/subprocess layer (src/backfill.ts) so it's unit-testable
 * without the indexing runtime.
 *
 * Given a batch of pending handles, route each to a decrypt path — the holder is a
 * party, or a delegator that delegated to the holder, or no rights at all — group
 * accordingly, run one decrypt job, and write results back via the injected
 * `update`. The decrypt runner is injected too (the real one spawns a subprocess).
 */
import type { Address, Hex } from "viem";
import { errorNameToState, type DecryptState } from "./zama/state";

/** A unit of work: a handle to decrypt, plus the accounts that may be entitled. */
export interface DecryptItem {
  id: string;
  handle: Hex;
  parties: Address[];
}

export interface SubprocessGroup {
  delegator: Address | null; // null = decrypt as the holder (a party)
  handles: Hex[];
}

export interface DecryptJob {
  contractAddress: Address;
  groups: SubprocessGroup[];
}

export interface DecryptResult {
  groups: Array<{ values?: Record<string, string>; errorName?: string }>;
}

export type DecryptRunner = (job: DecryptJob) => Promise<DecryptResult>;

/** How a row was decrypted — the subset of `decryptedVia` the backfill can set. */
export type DecryptedVia = "holder" | "delegation";

export interface Patch {
  amount?: bigint;
  state: DecryptState;
  via: DecryptedVia | null;
}
export type Update = (id: string, patch: Patch) => Promise<void>;

/** The distinct ciphertext handles in a set of items (one decrypt per handle). */
export function uniqueHandles(items: DecryptItem[]): Hex[] {
  return [...new Set(items.map((i) => i.handle))];
}

// Real gateway propagation after a delegation is ~4s (measured on Sepolia). So a
// row *still* reporting "not propagated" after several backfill ticks isn't
// propagating — it's a real error the SDK mislabels (it maps a bare relayer HTTP
// 500 to DelegationNotPropagatedError; see DECISIONS SDK feedback). Cap how long a row may
// sit in the optimistic `pending_propagation` state before it escalates to
// `failed`, so it surfaces in /v1/health instead of retrying forever silently.
export const MAX_PROPAGATION_ATTEMPTS = 5;

/** A still-"propagating" row that's exhausted its grace window becomes `failed`. */
export function escalateState(state: DecryptState, attemptsAfter: number): DecryptState {
  return state === "pending_propagation" && attemptsAfter >= MAX_PROPAGATION_ATTEMPTS ? "failed" : state;
}

/**
 * Route each item to a decrypt path and persist the outcome. Shared by both the
 * transfer and balance backfills (an `item` is a handle + the accounts that could
 * decrypt it), so this is the single place the rights logic lives.
 *
 * Three buckets:
 *  - **holder is a party** → decrypt as the holder
 *  - **a party delegated to the holder** → decrypt as that delegate
 *  - **neither (no rights yet)** → re-record `pending_rights` WITHOUT a gateway
 *    call. We still bump `lastAttemptAt` (in the caller's `update`) so the row
 *    backs off and doesn't hog the batch every tick. These rows are normally
 *    promoted *event-driven* — the ACL handler moves a delegator's `pending_rights`
 *    rows to `pending_propagation` when a delegation is indexed — so this poll is
 *    only the safety net for anything the events missed.
 *
 * So `pending_rights` rows are selected by the backfill for a reason: the first
 * two buckets are decryptable-but-not-yet-decrypted; only the third is a no-op.
 */
export async function routeAndDecrypt(
  token: Address,
  holder: Address,
  activeDelegators: Set<Address>,
  items: DecryptItem[],
  runDecrypt: DecryptRunner,
  update: Update,
): Promise<void> {
  // First, sort each item by *how* we'd decrypt it.
  const itemsHolderCanDecrypt: DecryptItem[] = []; // holder is a party
  const itemsByDelegator = new Map<Address, DecryptItem[]>(); // a party delegated to the holder
  const itemsWithNoRights: DecryptItem[] = []; // neither — nothing we can do yet

  for (const item of items) {
    if (item.parties.includes(holder)) {
      itemsHolderCanDecrypt.push(item);
    } else {
      const delegator = item.parties.find((party) => activeDelegators.has(party));
      if (delegator) {
        const itemsForDelegator = itemsByDelegator.get(delegator) ?? [];
        itemsForDelegator.push(item);
        itemsByDelegator.set(delegator, itemsForDelegator);
      } else {
        itemsWithNoRights.push(item);
      }
    }
  }

  // No rights: record the attempt, stay pending_rights — do NOT call the gateway.
  for (const item of itemsWithNoRights) await update(item.id, { state: "pending_rights", via: null });

  // Build one decrypt job per identity we can decrypt as: the holder, then one per delegator.
  const groupsToDecrypt: Array<{ delegator: Address | null; via: DecryptedVia; items: DecryptItem[] }> = [];
  if (itemsHolderCanDecrypt.length) groupsToDecrypt.push({ delegator: null, via: "holder", items: itemsHolderCanDecrypt });
  for (const [delegator, items] of itemsByDelegator) groupsToDecrypt.push({ delegator, via: "delegation", items });
  if (groupsToDecrypt.length === 0) return;

  let decryptResult: DecryptResult;
  try {
    decryptResult = await runDecrypt({
      contractAddress: token,
      groups: groupsToDecrypt.map((group) => ({ delegator: group.delegator, handles: uniqueHandles(group.items) })),
    });
  } catch {
    // Whole job failed (e.g. subprocess died) → transient, back off and retry.
    for (const group of groupsToDecrypt) for (const item of group.items) await update(item.id, { state: "failed", via: null });
    return;
  }

  // decryptResult.groups is positionally aligned with groupsToDecrypt.
  for (let i = 0; i < groupsToDecrypt.length; i++) {
    const group = groupsToDecrypt[i]!;
    const groupResult = decryptResult.groups[i];
    if (groupResult?.values) {
      for (const item of group.items) {
        const cleartext = groupResult.values[item.handle];
        if (cleartext !== undefined) await update(item.id, { amount: BigInt(cleartext), state: "decrypted", via: group.via });
        else await update(item.id, { state: "pending_rights", via: null });
      }
    } else {
      const state = errorNameToState(groupResult?.errorName);
      for (const item of group.items) await update(item.id, { state, via: null });
    }
  }
}
