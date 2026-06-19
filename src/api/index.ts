/**
 * Read API (Ponder's built-in Hono server).
 *
 * ERC-20-style cleartext views over the confidential token. Every amount-bearing
 * row carries its `decryptionState` so partners see the truth, not a clean lie.
 * Ponder also mounts /health, /ready, /status itself; ours add the domain views.
 */
import { db } from "ponder:api";
import { transfers, balances, delegations } from "ponder:schema";
import { Hono } from "hono";
import { and, count, desc, eq, lt, or, sql } from "drizzle-orm";
import { encodeFunctionData, getAddress, isAddress } from "viem";
import { accounts, env } from "../config";
import { aclAbi } from "../abis/acl";

const app = new Hono();

const TOKEN = env.TOKEN_ADDRESS ? getAddress(env.TOKEN_ADDRESS) : undefined;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** bigint -> string so responses are JSON-safe. */
function jsonable<T>(row: T): T {
  return JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

class ApiError extends Error {
  constructor(public status: 400 | 404 | 422 | 503, public code: string, msg: string) {
    super(msg);
  }
}

function requireToken(token: string) {
  if (!isAddress(token)) throw new ApiError(422, "invalid_token", `Not an address: ${token}`);
  const t = getAddress(token);
  if (!TOKEN || t !== TOKEN) throw new ApiError(404, "unknown_token", `Indexer does not track ${t}`);
  return t;
}

function requireAddress(addr: string) {
  if (!isAddress(addr)) throw new ApiError(422, "invalid_address", `Not an address: ${addr}`);
  return getAddress(addr);
}

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message } }, err.status);
  }
  console.error(err);
  return c.json({ error: { code: "internal", message: "Internal error" } }, 500);
});

app.get("/", (c) =>
  c.json({
    name: "confidential-indexer",
    token: TOKEN,
    endpoints: [
      "GET /v1/tokens/:token/balances/:address",
      "GET /v1/tokens/:token/addresses/:address/transfers?limit&cursor",
      "GET /v1/tokens/:token/delegations/:address",
      "POST /v1/tokens/:token/delegations/quote",
      "GET /v1/health",
    ],
  }),
);

// Current cleartext balance for an address (where the holder is entitled).
app.get("/v1/tokens/:token/balances/:address", async (c) => {
  const token = requireToken(c.req.param("token"));
  const address = requireAddress(c.req.param("address"));
  const row = await db.select().from(balances).where(eq(balances.id, `${token}-${address}`)).limit(1);

  if (row.length === 0) {
    return c.json({
      token,
      address,
      balance: null,
      decryptionState: "pending_rights",
      reason: "No confidential balance indexed for this address yet, or the holder has no decrypt rights.",
    });
  }
  const b = row[0]!;
  return c.json(
    jsonable({
      token,
      address,
      balance: b.balance, // null when not yet decryptable
      decryptionState: b.decryptionState,
      updatedAtBlock: b.updatedAtBlock,
    }),
  );
});

// Transfer history for an address, cleartext amounts where available. Cursor
// pagination is stable under new inserts (keyed on blockNumber, logIndex).
app.get("/v1/tokens/:token/addresses/:address/transfers", async (c) => {
  const token = requireToken(c.req.param("token"));
  const address = requireAddress(c.req.param("address"));
  const limit = Math.min(Number(c.req.query("limit")) || DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = decodeCursor(c.req.query("cursor"));

  const base = and(
    eq(transfers.token, token),
    or(eq(transfers.from, address), eq(transfers.to, address)),
    cursor
      ? sql`(${transfers.blockNumber}, ${transfers.logIndex}) < (${cursor.block}, ${cursor.logIndex})`
      : undefined,
  );

  const rows = await db
    .select()
    .from(transfers)
    .where(base)
    .orderBy(desc(transfers.blockNumber), desc(transfers.logIndex))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const next =
    rows.length > limit ? encodeCursor(page[page.length - 1]!.blockNumber, page[page.length - 1]!.logIndex) : null;

  return c.json({
    token,
    address,
    transfers: page.map((t) =>
      jsonable({
        id: t.id,
        kind: t.kind,
        from: t.from,
        to: t.to,
        amount: t.amount, // null where not yet decryptable
        amountHandle: t.amountHandle,
        decryptionState: t.decryptionState,
        decryptedVia: t.decryptedVia,
        blockNumber: t.blockNumber,
        blockTime: t.blockTime,
        txHash: t.txHash,
      }),
    ),
    nextCursor: next,
  });
});

// Has this address delegated decrypt rights to the indexer holder?
app.get("/v1/tokens/:token/delegations/:address", async (c) => {
  const token = requireToken(c.req.param("token"));
  const address = requireAddress(c.req.param("address"));
  const row = await db.select().from(delegations).where(eq(delegations.id, `${token}-${address}`)).limit(1);
  const d = row[0];
  return c.json(
    jsonable({
      token,
      delegator: address,
      delegate: accounts.indexerHolder.address,
      active: d?.active ?? false,
      expiry: d?.expiry ?? null,
    }),
  );
});

// Build the unsigned tx the user signs to grant the holder decrypt rights.
app.post("/v1/tokens/:token/delegations/quote", async (c) => {
  const token = requireToken(c.req.param("token"));
  const holder = accounts.indexerHolder.address;
  // Default: permanent (uint64 max). Callers can pass an expiry seconds value.
  const body = await c.req.json().catch(() => ({}) as { expiry?: number | string });
  const expiry = body.expiry !== undefined ? BigInt(body.expiry) : (1n << 64n) - 1n;

  const data = encodeFunctionData({
    abi: aclAbi,
    functionName: "delegateForUserDecryption",
    args: [holder, token, expiry],
  });
  return c.json(
    jsonable({
      to: env.ACL_ADDRESS,
      data,
      value: "0x0",
      chainId: env.CHAIN_ID,
      description: `Grants the indexer holder ${holder} decrypt rights over ${token}. The user signs and sends this from their own wallet.`,
    }),
  );
});

// Decrypt backlog + how far behind the indexer is.
app.get("/v1/health", async (c) => {
  const backlogRows = await db
    .select({ state: transfers.decryptionState, n: count() })
    .from(transfers)
    .groupBy(transfers.decryptionState);
  const backlog = Object.fromEntries(backlogRows.map((r) => [r.state, Number(r.n)]));

  // Authoritative synced head comes from Ponder's own /status.
  let chainHead: number | null = null;
  let indexedBlock: number | null = null;
  let secondsBehind: number | null = null;
  try {
    const status = (await fetch(`http://localhost:${env.PORT}/status`).then((r) => r.json())) as Record<
      string,
      { block?: { number?: number; timestamp?: number }; id?: number }
    >;
    const chainStatus = Object.values(status)[0];
    indexedBlock = chainStatus?.block?.number ?? null;
    const ts = chainStatus?.block?.timestamp;
    if (ts) secondsBehind = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  } catch {
    /* status not ready yet */
  }

  const healthy = secondsBehind === null || secondsBehind <= env.MAX_LAG_SECONDS;
  return c.json(
    {
      status: healthy ? "ok" : "degraded",
      indexedBlock,
      chainHead,
      secondsBehind,
      maxLagSeconds: env.MAX_LAG_SECONDS,
      decryptBacklog: {
        pendingRights: backlog.pending_rights ?? 0,
        pendingPropagation: backlog.pending_propagation ?? 0,
        failed: backlog.failed ?? 0,
        decrypted: backlog.decrypted ?? 0,
      },
    },
    healthy ? 200 : 503,
  );
});

function encodeCursor(block: bigint, logIndex: number): string {
  return Buffer.from(`${block}:${logIndex}`).toString("base64url");
}
function decodeCursor(cursor: string | undefined): { block: bigint; logIndex: number } | undefined {
  if (!cursor) return undefined;
  const [block, logIndex] = Buffer.from(cursor, "base64url").toString().split(":");
  return { block: BigInt(block!), logIndex: Number(logIndex) };
}

export default app;
