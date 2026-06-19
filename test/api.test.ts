/**
 * Integration tests against a running indexer (the real end-to-end path the brief
 * asks for: an on-chain event in → cleartext out of the API).
 *
 * Requires the live demo state: `npm run dev` running, `npm run seed` done, and
 * user0 delegated (`npm run delegate`) while user1 has NOT. If the API isn't
 * reachable these skip (so a fresh `npm test` stays green on the unit test alone);
 * run the demo, then `npm test` to see them pass. See README "Tests".
 *
 * Negative test choice: a non-delegated user's transfer must still be indexed and
 * surfaced as `pending_rights`, never dropped. That's the brief's central rule —
 * "events the holder is not entitled to decrypt must not be silently dropped" — so
 * it's the most load-bearing negative case to pin.
 */
import { describe, expect, it } from "vitest";
import { accounts, env } from "../src/config";

const BASE = `http://localhost:${env.PORT}`;
const TOKEN = env.TOKEN_ADDRESS;
const user0 = accounts.testUsers[0]!.address; // delegated to the holder
const user1 = accounts.testUsers[1]!.address; // did NOT delegate

interface TransferRow {
  kind: string;
  amount: string | null;
  decryptionState: string;
}

async function shieldFor(addr: string): Promise<TransferRow | undefined> {
  const res = await fetch(`${BASE}/v1/tokens/${TOKEN}/addresses/${addr}/transfers`);
  const body = (await res.json()) as { transfers: TransferRow[] };
  return body.transfers.find((t) => t.kind === "shield");
}

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/v1/health`);
    return r.status < 600;
  } catch {
    return false;
  }
}

const UP = await reachable();

describe.skipIf(!UP)("read API (integration — needs the live demo running)", () => {
  it("happy path: a delegated user's shield comes out as cleartext", async () => {
    // Poll while the block-interval backfill decrypts (after delegation + propagation).
    let row: TransferRow | undefined;
    for (let i = 0; i < 40; i++) {
      row = await shieldFor(user0);
      if (row?.amount != null) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(row?.decryptionState).toBe("decrypted");
    expect(row?.amount).toBe("100000000"); // user0 wrapped 100 cUSD (6 decimals)
  }, 150_000);

  it("negative: a non-delegated user's amount is not dropped — surfaced as pending", async () => {
    const row = await shieldFor(user1);
    expect(row).toBeDefined(); // event indexed, NOT dropped
    expect(row?.amount).toBeNull(); // no cleartext — holder has no rights
    expect(["pending_rights", "pending_propagation"]).toContain(row?.decryptionState);
  });
});
