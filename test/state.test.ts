/**
 * Unit tests (no network) for the error→state mapping that implements the brief's
 * "never silently drop" rule: a decrypt failure becomes an explicit, retryable
 * state rather than a dropped row. `errorNameToState` is the path actually used in
 * production (decryption runs out-of-process, so error *instances* don't survive
 * the boundary — only their class names do).
 */
import { describe, expect, it } from "vitest";
import { errorNameToState, errorToState } from "../src/zama/state";

describe("errorNameToState", () => {
  const cases: Array<[string | undefined, string]> = [
    // lack-of-rights family → wait for a (further) delegation
    ["NoCiphertextError", "pending_rights"],
    ["DelegationNotFoundError", "pending_rights"],
    ["DelegationExpiredError", "pending_rights"],
    // grant exists on-chain, gateway not synced yet → short retry loop
    ["DelegationNotPropagatedError", "pending_propagation"],
    // transient / unknown → back off and retry
    ["RelayerRequestFailedError", "failed"],
    ["DecryptionFailedError", "failed"],
    ["SomethingNobodyHasSeen", "failed"],
    [undefined, "failed"],
  ];

  it.each(cases)("maps %s → %s", (name, expected) => {
    expect(errorNameToState(name)).toBe(expected);
  });
});

describe("errorToState", () => {
  it("maps an unknown/transient error instance to 'failed'", () => {
    expect(errorToState(new Error("boom"))).toBe("failed");
  });
});
