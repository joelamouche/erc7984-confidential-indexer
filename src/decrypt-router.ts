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
 * Route items, decrypt the entitled ones in a single job, and persist outcomes.
 * No-rights items never reach the runner (no wasted gateway call) — they're just
 * recorded as `pending_rights`.
 */
export async function routeAndDecrypt(
  token: Address,
  holder: Address,
  activeDelegators: Set<Address>,
  items: DecryptItem[],
  runDecrypt: DecryptRunner,
  update: Update,
): Promise<void> {
  const holderGroup: DecryptItem[] = [];
  const delegatedGroups = new Map<Address, DecryptItem[]>();
  const noRights: DecryptItem[] = [];

  for (const it of items) {
    if (it.parties.includes(holder)) {
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

  // No rights: record the attempt, stay pending_rights — do NOT call the gateway.
  for (const it of noRights) await update(it.id, { state: "pending_rights", via: null });

  const groups: Array<{ delegator: Address | null; via: DecryptedVia; items: DecryptItem[] }> = [];
  if (holderGroup.length) groups.push({ delegator: null, via: "holder", items: holderGroup });
  for (const [delegator, group] of delegatedGroups) groups.push({ delegator, via: "delegation", items: group });
  if (groups.length === 0) return;

  let result: DecryptResult;
  try {
    result = await runDecrypt({
      contractAddress: token,
      groups: groups.map((g) => ({ delegator: g.delegator, handles: uniqueHandles(g.items) })),
    });
  } catch {
    // Whole job failed (e.g. subprocess died) → transient, back off and retry.
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
      for (const it of g.items) await update(it.id, { state, via: null });
    }
  }
}
