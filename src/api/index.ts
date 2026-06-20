/**
 * Read API (Ponder's built-in Hono server).
 *
 * ERC-20-style cleartext views over the confidential token. Every amount-bearing
 * row carries its `decryptionState` so partners see the truth, not a clean lie.
 * Ponder also mounts /health, /ready, /status itself; ours add the domain views.
 */
import { db, publicClients } from "ponder:api";
import { transfers, balances, delegations } from "ponder:schema";
import { Hono } from "hono";
import { and, count, desc, eq, gt, inArray, isNull, min, or, sql } from "drizzle-orm";
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
        unwrapStatus: t.unwrapStatus, // unshield rows: requested | finalized (else null)
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

// "How far behind" on two axes: indexing lag, and the *actionable* decryption
// backlog — only rows we are ENTITLED to decrypt (a party delegated) but haven't
// yet. Rows with no delegation aren't our work; decrypted rows are done; neither
// belongs in a health signal.
app.get("/v1/health", async (c) => {
  // --- Indexing lag ---
  let indexedBlock: number | null = null;
  let secondsBehind: number | null = null;
  let chainHead: number | null = null;
  let blocksBehind: number | null = null;
  try {
    // Ponder's own /status: the authoritative synced head per chain.
    const status = (await fetch(`http://localhost:${env.PORT}/status`).then((r) => r.json())) as Record<
      string,
      { block?: { number?: number; timestamp?: number } }
    >;
    const chainStatus = Object.values(status)[0];
    indexedBlock = chainStatus?.block?.number ?? null;
    const ts = chainStatus?.block?.timestamp;
    if (ts) secondsBehind = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  } catch {
    /* status not ready yet */
  }
  try {
    chainHead = Number(await publicClients.sepolia.getBlockNumber());
    if (indexedBlock != null) blocksBehind = Math.max(0, chainHead - indexedBlock);
  } catch {
    /* RPC unavailable */
  }

  // --- Decryption backlog (size + age) ---
  // Addresses we currently hold usable decrypt rights for.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const dels = await db
    .select({ delegator: delegations.delegator })
    .from(delegations)
    .where(and(eq(delegations.active, true), gt(delegations.expiry, nowSec)));
  const delegators = dels.map((d) => d.delegator);

  const NOT_DECRYPTED: ("pending_rights" | "pending_propagation" | "failed")[] = [
    "pending_rights",
    "pending_propagation",
    "failed",
  ];
  let pending = 0;
  let oldestBlock: number | null = null;
  if (delegators.length > 0) {
    // Pending transfers where a party (from/to) is an active delegator.
    const [tAgg] = await db
      .select({ n: count(), oldest: min(transfers.blockNumber) })
      .from(transfers)
      .where(
        and(
          isNull(transfers.amount),
          inArray(transfers.decryptionState, NOT_DECRYPTED),
          or(inArray(transfers.from, delegators), inArray(transfers.to, delegators)),
        ),
      );
    // Pending balances for an active delegator.
    const [bAgg] = await db
      .select({ n: count(), oldest: min(balances.updatedAtBlock) })
      .from(balances)
      .where(
        and(
          isNull(balances.balance),
          inArray(balances.decryptionState, NOT_DECRYPTED),
          inArray(balances.account, delegators),
        ),
      );
    pending = Number(tAgg?.n ?? 0) + Number(bAgg?.n ?? 0);
    const oldest = [tAgg?.oldest, bAgg?.oldest].filter((x): x is bigint => x != null).map(Number);
    oldestBlock = oldest.length ? Math.min(...oldest) : null;
  }

  // Age of the backlog: wall-clock since the oldest still-pending entitled row.
  let oldestAgeSeconds: number | null = null;
  if (oldestBlock != null) {
    try {
      const blk = await publicClients.sepolia.getBlock({ blockNumber: BigInt(oldestBlock) });
      oldestAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(blk.timestamp));
    } catch {
      /* RPC unavailable */
    }
  }

  const healthy = secondsBehind === null || secondsBehind <= env.MAX_LAG_SECONDS;
  return c.json(
    {
      status: healthy ? "ok" : "degraded",
      indexing: { indexedBlock, chainHead, blocksBehind, secondsBehind, maxLagSeconds: env.MAX_LAG_SECONDS },
      decryptable: { pending, oldestBlock, oldestAgeSeconds },
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
