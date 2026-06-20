/**
 * Integration tests against a running indexer (the real end-to-end path the brief
 * asks for: an on-chain event in → cleartext out of the API).
 *
 * Requires the live demo state: `npm run dev` running, then `npm run seed`,
 * `npm run delegate` (user0 only), `npm run transfer -- 0 1 40`,
 * `npm run transfer -- 1 2 30`, and `npm run unshield -- 0 20`. If the API isn't
 * reachable these skip (so a fresh `npm test` stays green on the unit tests). See
 * README "Tests".
 *
 * The matrix below pins the core rule across both event kinds: an amount is
 * cleartext iff the holder is entitled to decrypt it (a party delegated), and is
 * otherwise surfaced as `pending_rights` — never dropped. A transfer amount handle
 * is ACL-allowed for BOTH parties, so it decrypts if EITHER delegated.
 */
import { describe, expect, it } from "vitest";
import { accounts, env } from "../src/config";

const BASE = `http://localhost:${env.PORT}`;
const TOKEN = env.TOKEN_ADDRESS;
// API returns addresses lowercased (hex columns normalize) — compare case-insensitively.
const user0 = accounts.testUsers[0]!.address.toLowerCase(); // delegated to the holder
const user1 = accounts.testUsers[1]!.address.toLowerCase(); // did NOT delegate
const user2 = accounts.testUsers[2]!.address.toLowerCase(); // did NOT delegate
const addr = (a: string) => a.toLowerCase();

interface TransferRow {
  kind: string;
  from: string;
  to: string;
  amount: string | null;
  decryptionState: string;
  decryptedVia: string | null;
}

async function getTransfers(addr: string): Promise<TransferRow[]> {
  const res = await fetch(`${BASE}/v1/tokens/${TOKEN}/addresses/${addr}/transfers`);
  return ((await res.json()) as { transfers: TransferRow[] }).transfers;
}

/** Poll until a matching row exists; if wantDecrypted, also until its amount lands. */
async function awaitRow(
  addr: string,
  pred: (t: TransferRow) => boolean,
  wantDecrypted: boolean,
): Promise<TransferRow | undefined> {
  let row: TransferRow | undefined;
  for (let i = 0; i < 40; i++) {
    row = (await getTransfers(addr)).find(pred);
    if (row && (!wantDecrypted || row.amount != null)) return row;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return row;
}

async function reachable(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/v1/health`)).status < 600;
  } catch {
    return false;
  }
}

const UP = await reachable();

interface Scenario {
  name: string;
  queryAddr: string;
  match: (t: TransferRow) => boolean;
  cleartext: string | null; // expected amount; null = must stay pending (not dropped)
}

const SCENARIOS: Scenario[] = [
  {
    name: "shield → delegated user (user0): cleartext",
    queryAddr: user0,
    match: (t) => t.kind === "shield" && addr(t.to) === user0,
    cleartext: "100000000",
  },
  {
    name: "shield → non-delegated user (user1): NOT cleartext, surfaced pending (not dropped)",
    queryAddr: user1,
    match: (t) => t.kind === "shield" && addr(t.to) === user1,
    cleartext: null,
  },
  {
    name: "transfer user0→user1 (user0 delegated): cleartext to BOTH parties",
    queryAddr: user1,
    match: (t) => t.kind === "transfer" && addr(t.from) === user0 && addr(t.to) === user1,
    cleartext: "40000000",
  },
  {
    name: "transfer user1→user2 (neither delegated): NOT cleartext, surfaced pending",
    queryAddr: user1,
    match: (t) => t.kind === "transfer" && addr(t.from) === user1 && addr(t.to) === user2,
    cleartext: null,
  },
  {
    name: "unshield by delegated user0 (burn): cleartext via delegation",
    queryAddr: user0,
    match: (t) => t.kind === "unshield" && addr(t.from) === user0,
    cleartext: "20000000",
  },
];

describe.skipIf(!UP)("read API — cleartext-or-pending by delegation, across event kinds", () => {
  it.each(SCENARIOS)("$name", async ({ queryAddr, match, cleartext }) => {
    const row = await awaitRow(queryAddr, match, cleartext != null);
    expect(row, "event must be indexed, never dropped").toBeDefined();
    if (cleartext != null) {
      expect(row?.decryptionState).toBe("decrypted");
      expect(row?.amount).toBe(cleartext);
    } else {
      expect(row?.amount).toBeNull();
      expect(["pending_rights", "pending_propagation"]).toContain(row?.decryptionState);
    }
  }, 150_000);
});
