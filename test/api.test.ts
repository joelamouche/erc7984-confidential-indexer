/**
 * Integration tests against a running indexer (event in → cleartext out of the API).
 *
 * These assert **invariants** that hold regardless of how much on-chain state has
 * accumulated — deliberately NOT a frozen snapshot of specific amounts/users. An
 * earlier version hardcoded "user1 is not delegated / there is one 40-transfer";
 * later demo + measurement runs delegated those users and added more transfers, and
 * the snapshot assertions broke. Integration tests over mutable shared chain state
 * should pin rules, not fixtures. The full pending→decrypted *transition* (which
 * needs fresh on-chain setup) lives in `transition.slow.test.ts`.
 *
 * Requires the live demo state: `npm run dev` running, `npm run seed` done, and
 * user0 delegated (`npm run delegate`). Skips if the API isn't reachable.
 */
import { describe, expect, it } from "vitest";
import { accounts, env } from "../src/config";

const BASE = `http://localhost:${env.PORT}`;
const TOKEN = env.TOKEN_ADDRESS;
const user0 = accounts.testUsers[0]!.address; // reliably delegated (seeded + delegated)

interface TransferRow {
  kind: string;
  to: string;
  amount: string | null;
  decryptionState: string;
  decryptedVia: string | null;
}

async function getTransfers(addr: string): Promise<TransferRow[]> {
  const res = await fetch(`${BASE}/v1/tokens/${TOKEN}/addresses/${addr}/transfers`);
  return ((await res.json()) as { transfers: TransferRow[] }).transfers;
}

async function reachable(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/v1/health`)).status < 600;
  } catch {
    return false;
  }
}
const UP = await reachable();

describe.skipIf(!UP)("read API (integration — needs the live demo running)", () => {
  it("happy path: a delegated user's shield comes out as cleartext (100 cUSD)", async () => {
    let row: TransferRow | undefined;
    for (let i = 0; i < 40; i++) {
      row = (await getTransfers(user0)).find((t) => t.kind === "shield" && t.to.toLowerCase() === user0.toLowerCase());
      if (row?.amount != null) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(row?.decryptionState).toBe("decrypted");
    expect(row?.amount).toBe("100000000"); // user0 wrapped 100 cUSD (6 decimals)
    expect(row?.decryptedVia).toBe("delegation");
  }, 150_000);

  it("invariant: amount is set iff decrypted, and decrypted rows carry a provenance", async () => {
    const rows = await getTransfers(user0);
    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      // The core honesty rule: cleartext present exactly when decrypted, never faked.
      expect(t.amount != null).toBe(t.decryptionState === "decrypted");
      if (t.decryptionState === "decrypted") expect(t.decryptedVia).not.toBeNull();
    }
  });

  it("negative: an address with no rights gets an honest pending balance, not an error or a fabricated value", async () => {
    // A never-seen address: the holder can't decrypt it, so the API must surface
    // pending_rights / null — not 500, not a made-up number. (Brief: never drop /
    // never fabricate.) Robust forever — this address is never delegated.
    const stranger = "0x000000000000000000000000000000000000dEaD";
    const res = await fetch(`${BASE}/v1/tokens/${TOKEN}/balances/${stranger}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance: string | null; decryptionState: string };
    expect(body.balance).toBeNull();
    expect(body.decryptionState).toBe("pending_rights");
  });
});
