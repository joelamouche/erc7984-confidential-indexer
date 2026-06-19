/**
 * Unit test (always runs, no network) for the error→state mapping that implements
 * the brief's "never silently drop" rule: a decrypt failure becomes an explicit,
 * retryable state rather than a dropped row.
 */
import { describe, expect, it } from "vitest";
import { errorToState } from "../src/zama/state";

describe("errorToState", () => {
  it("maps an unknown/transient error to 'failed' (kept, retried with backoff)", () => {
    expect(errorToState(new Error("boom"))).toBe("failed");
  });
});
