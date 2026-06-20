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

// How a user grants the indexer holder decrypt rights. Delegation is the user's
// own authorization, so the user must sign — that part is irreducible. We return
// (a) the inputs for the SDK's `delegateDecryption` (preferred: the partner calls
// it in the user's wallet context, staying inside the SDK), and (b) a raw unsigned
// tx as a no-SDK fallback. The indexer never holds a user key. See DECISIONS §5.
app.post("/v1/tokens/:token/delegations/quote", async (c) => {
  const token = requireToken(c.req.param("token"));
  const holder = accounts.indexerHolder.address;
  // Default: permanent (uint64 max). Callers can pass an expiry (unix seconds).
  const body = await c.req.json().catch(() => ({}) as { expiry?: number | string });
  const expiry = body.expiry !== undefined ? BigInt(body.expiry) : (1n << 64n) - 1n;

  const data = encodeFunctionData({
    abi: aclAbi,
    functionName: "delegateForUserDecryption",
    args: [holder, token, expiry],
  });
  return c.json(
    jsonable({
      delegateAddress: holder,
      token,
      // Preferred: `sdk.delegations.delegateDecryption(sdkDelegateInput)` from the
      // user's wallet. Omit expirationDate for permanent; else pass a JS Date.
      sdkDelegateInput: { contractAddress: token, delegateAddress: holder },
      // Fallback if not using the SDK: user's wallet signs+sends this.
      unsignedTx: { to: env.ACL_ADDRESS, data, value: "0x0", chainId: env.CHAIN_ID },
      note:
        "Delegation is the user's authorization to grant the indexer decrypt rights, so the user must sign. " +
        "The SDK abstracts building/sending the tx (call delegateDecryption with sdkDelegateInput in the user's " +
        "wallet context), not the signature itself. unsignedTx is a no-SDK fallback. The indexer never holds a user key.",
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

  // Split the entitled-but-undecrypted backlog into two buckets:
  //   inFlight = still being worked (pending_rights / pending_propagation)
  //   failed   = exhausted the retry grace (escalateState) — a genuine problem.
  // Decryption health keys on `failed`, NOT on block-age: a legitimate history
  // backfill (a user delegating for old transfers) transiently has very old block
  // ages while draining in seconds, so age would false-positive. `failed` only
  // appears after MAX_PROPAGATION_ATTEMPTS of real failure, so it's the honest
  // "decryption is stuck" signal. `oldestAgeSeconds` stays as consumer-facing
  // staleness info, not a health trigger.
  const IN_FLIGHT: ("pending_rights" | "pending_propagation")[] = ["pending_rights", "pending_propagation"];
  let inFlight = 0;
  let failed = 0;
  let oldestBlock: number | null = null;
  if (delegators.length > 0) {
    const entitledTransfer = or(inArray(transfers.from, delegators), inArray(transfers.to, delegators));
    const entitledBalance = inArray(balances.account, delegators);

    const [tFlight] = await db
      .select({ n: count(), oldest: min(transfers.blockNumber) })
      .from(transfers)
      .where(and(isNull(transfers.amount), inArray(transfers.decryptionState, IN_FLIGHT), entitledTransfer));
    const [bFlight] = await db
      .select({ n: count(), oldest: min(balances.updatedAtBlock) })
      .from(balances)
      .where(and(isNull(balances.balance), inArray(balances.decryptionState, IN_FLIGHT), entitledBalance));
    const [tFailed] = await db
      .select({ n: count() })
      .from(transfers)
      .where(and(isNull(transfers.amount), eq(transfers.decryptionState, "failed"), entitledTransfer));
    const [bFailed] = await db
      .select({ n: count() })
      .from(balances)
      .where(and(isNull(balances.balance), eq(balances.decryptionState, "failed"), entitledBalance));

    inFlight = Number(tFlight?.n ?? 0) + Number(bFlight?.n ?? 0);
    failed = Number(tFailed?.n ?? 0) + Number(bFailed?.n ?? 0);
    const oldest = [tFlight?.oldest, bFlight?.oldest].filter((x): x is bigint => x != null).map(Number);
    oldestBlock = oldest.length ? Math.min(...oldest) : null;
  }

  // Age of the oldest in-flight entitled row (consumer-facing staleness).
  let oldestAgeSeconds: number | null = null;
  if (oldestBlock != null) {
    try {
      const blk = await publicClients.sepolia.getBlock({ blockNumber: BigInt(oldestBlock) });
      oldestAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(blk.timestamp));
    } catch {
      /* RPC unavailable */
    }
  }

  // Two independent health axes; overall status is the worse of the two.
  const indexingHealthy = secondsBehind === null || secondsBehind <= env.MAX_LAG_SECONDS;
  const decryptionHealthy = failed === 0;
  const status = indexingHealthy && decryptionHealthy ? "ok" : "degraded";
  return c.json(
    {
      status,
      indexing: {
        healthy: indexingHealthy,
        indexedBlock,
        chainHead,
        blocksBehind,
        secondsBehind,
        maxLagSeconds: env.MAX_LAG_SECONDS,
      },
      decryptable: { healthy: decryptionHealthy, inFlight, failed, oldestBlock, oldestAgeSeconds },
    },
    status === "ok" ? 200 : 503,
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
