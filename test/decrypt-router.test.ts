/**
 * Unit tests for the backfill's decision logic (src/decrypt-router.ts) — the most
 * load-bearing piece, exercised here without the live indexer via a fake `update`
 * sink and a stubbed decrypt runner. Covers routing (holder vs delegated vs
 * no-rights), the no-gateway-call guarantee for no-rights, success mapping, the
 * per-group error→state mapping, and whole-job failure.
 */
import { describe, expect, it, vi } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { routeAndDecrypt, type DecryptItem, type DecryptJob, type Patch } from "../src/decrypt-router";

const HOLDER = getAddress("0x1111111111111111111111111111111111111111");
const TOKEN = getAddress("0x2222222222222222222222222222222222222222");
const ALICE = getAddress("0x3333333333333333333333333333333333333333"); // delegated to holder
const BOB = getAddress("0x4444444444444444444444444444444444444444"); // no delegation

const H_HOLDER = `0x${"a".repeat(64)}` as Hex;
const H_DELEGATED = `0x${"b".repeat(64)}` as Hex;
const H_NORIGHTS = `0x${"c".repeat(64)}` as Hex;

const itemHolder: DecryptItem = { id: "holder-1", handle: H_HOLDER, parties: [HOLDER] };
const itemDelegated: DecryptItem = { id: "deleg-1", handle: H_DELEGATED, parties: [ALICE, BOB] };
const itemNoRights: DecryptItem = { id: "norights-1", handle: H_NORIGHTS, parties: [BOB] };

/** Collects update() calls; last patch per id. */
function makeSink() {
  const patches = new Map<string, Patch>();
  const update = vi.fn(async (id: string, patch: Patch) => {
    patches.set(id, patch);
  });
  return { update, patches };
}

describe("routeAndDecrypt", () => {
  it("routes each handle correctly and surfaces cleartext via the right path", async () => {
    const { update, patches } = makeSink();
    let seenJob: DecryptJob | undefined;
    const runDecrypt = vi.fn(async (job: DecryptJob) => {
      seenJob = job;
      return {
        groups: [
          { values: { [H_HOLDER]: "111" } }, // holder group (built first)
          { values: { [H_DELEGATED]: "222" } }, // delegated group
        ],
      };
    });

    await routeAndDecrypt(TOKEN, HOLDER, new Set([ALICE]), [itemHolder, itemDelegated, itemNoRights], runDecrypt, update);

    // No-rights item: recorded as pending, and NEVER sent to the gateway.
    expect(patches.get("norights-1")).toEqual({ state: "pending_rights", via: null });
    const allHandles = seenJob!.groups.flatMap((g) => g.handles);
    expect(allHandles).not.toContain(H_NORIGHTS);

    // Job grouping: holder group (delegator null) + a group delegated by ALICE.
    expect(seenJob!.groups[0]).toEqual({ delegator: null, handles: [H_HOLDER] });
    expect(seenJob!.groups[1]).toEqual({ delegator: ALICE, handles: [H_DELEGATED] });

    // Cleartext written with the correct provenance.
    expect(patches.get("holder-1")).toEqual({ amount: 111n, state: "decrypted", via: "holder" });
    expect(patches.get("deleg-1")).toEqual({ amount: 222n, state: "decrypted", via: "delegation" });
  });

  it("does not call the gateway when nothing is decryptable", async () => {
    const { update, patches } = makeSink();
    const runDecrypt = vi.fn();

    await routeAndDecrypt(TOKEN, HOLDER, new Set(), [itemNoRights], runDecrypt, update);

    expect(runDecrypt).not.toHaveBeenCalled();
    expect(patches.get("norights-1")).toEqual({ state: "pending_rights", via: null });
  });

  it("maps a per-group error name to the right state (propagation lag → pending_propagation)", async () => {
    const { update, patches } = makeSink();
    const runDecrypt = vi.fn(async () => ({ groups: [{ errorName: "DelegationNotPropagatedError" }] }));

    await routeAndDecrypt(TOKEN, HOLDER, new Set([ALICE]), [itemDelegated], runDecrypt, update);

    expect(patches.get("deleg-1")).toEqual({ state: "pending_propagation", via: null });
  });

  it("marks everything failed (retryable) when the decrypt job throws", async () => {
    const { update, patches } = makeSink();
    const runDecrypt = vi.fn(async () => {
      throw new Error("subprocess died");
    });

    await routeAndDecrypt(TOKEN, HOLDER, new Set([ALICE]), [itemHolder, itemDelegated], runDecrypt, update);

    expect(patches.get("holder-1")).toEqual({ state: "failed", via: null });
    expect(patches.get("deleg-1")).toEqual({ state: "failed", via: null });
  });
});
