/**
 * Ponder indexing handlers.
 *
 * Indexing stays deterministic and fast: record every event with an explicit
 * `decryptionState`, never drop an amount. Decryption is decoupled onto the
 * `Backfill` block interval (src/backfill.ts) so gateway latency never blocks the
 * indexing loop. `AmountDisclosed`/`UnwrapFinalized` give cleartext from chain with
 * no SDK round-trip. See docs/INDEXER.md §5.
 */
import { ponder, type Context } from "ponder:registry";
import { transfers, balances, delegations } from "ponder:schema";
import { and, eq, or } from "drizzle-orm";
import { getAddress, zeroAddress } from "viem";
import { confidentialTokenAbi } from "./abis/confidentialToken";
import { runBackfill } from "./backfill";

function transferId(txHash: string, logIndex: number) {
  return `${txHash}-${logIndex}`;
}

function classifyKind(from: string, to: string): "transfer" | "shield" | "unshield" {
  // The indexed token IS the wrapper, so mint (from=0) is a shield and burn
  // (to=0) is an unshield. Plain holder-to-holder is a transfer.
  if (from === zeroAddress) return "shield";
  if (to === zeroAddress) return "unshield";
  return "transfer";
}

// Record/refresh an account's confidential balance handle (cleartext filled by
// the backfill). The handle changes on every transfer, so re-read and reset state.
async function upsertBalanceHandle(
  context: Pick<Context, "client" | "db">,
  token: `0x${string}`,
  account: `0x${string}`,
  blockNumber: bigint,
) {
  if (account === zeroAddress) return;
  const handle = await context.client.readContract({
    address: token,
    abi: confidentialTokenAbi,
    functionName: "confidentialBalanceOf",
    args: [account],
  });
  const row = {
    id: `${token}-${account}`,
    token,
    account,
    balanceHandle: handle,
    balance: null,
    decryptionState: "pending_rights" as const,
    updatedAtBlock: blockNumber,
    attempts: 0,
    lastAttemptAt: null,
  };
  await context.db.insert(balances).values(row).onConflictDoUpdate(row);
}

ponder.on("ConfidentialToken:ConfidentialTransfer", async ({ event, context }) => {
  const from = getAddress(event.args.from);
  const to = getAddress(event.args.to);
  const token = getAddress(event.log.address);

  await context.db
    .insert(transfers)
    .values({
      id: transferId(event.transaction.hash, event.log.logIndex),
      token,
      kind: classifyKind(from, to),
      from,
      to,
      amountHandle: event.args.amount,
      amount: null,
      decryptionState: "pending_rights",
      decryptedVia: null,
      blockNumber: event.block.number,
      blockTime: event.block.timestamp,
      logIndex: event.log.logIndex,
      txHash: event.transaction.hash,
      attempts: 0,
      lastAttemptAt: null,
    })
    .onConflictDoNothing();

  // Track the confidential balance handle for each party.
  await upsertBalanceHandle(context, token, from, event.block.number);
  await upsertBalanceHandle(context, token, to, event.block.number);
});

// Public cleartext reveal — fills any row carrying this exact handle, no rights needed.
ponder.on("ConfidentialToken:AmountDisclosed", async ({ event, context }) => {
  await context.db.sql
    .update(transfers)
    .set({ amount: event.args.amount, decryptionState: "decrypted", decryptedVia: "amount_disclosed" })
    .where(eq(transfers.amountHandle, event.args.encryptedAmount));
});

// Unshield step 2 carries the cleartext unwrap amount on-chain.
ponder.on("ConfidentialToken:UnwrapFinalized", async ({ event, context }) => {
  await context.db.sql
    .update(transfers)
    .set({ amount: event.args.cleartextAmount, decryptionState: "decrypted", decryptedVia: "unwrap_finalized" })
    .where(eq(transfers.amountHandle, event.args.encryptedAmount));
});

// ACL rights discovery — only events naming our holder as delegate reach here.
ponder.on("Acl:DelegatedForUserDecryption", async ({ event, context }) => {
  const delegator = getAddress(event.args.delegator);
  const delegate = getAddress(event.args.delegate);
  const contractAddress = getAddress(event.args.contractAddress);
  const id = `${contractAddress}-${delegator}`;
  const row = {
    id,
    delegator,
    delegate,
    contractAddress,
    active: true,
    expiry: event.args.newExpirationDate,
    delegationCounter: event.args.delegationCounter,
    observedAtBlock: event.block.number,
  };
  await context.db.insert(delegations).values(row).onConflictDoUpdate(row);

  // Event-driven promotion: this delegator's pending amounts/balances are now
  // eligible — move them to pending_propagation and clear the backoff so the next
  // backfill tick retries immediately (decrypt succeeds once the gateway syncs).
  await context.db.sql
    .update(transfers)
    .set({ decryptionState: "pending_propagation", lastAttemptAt: null })
    .where(and(eq(transfers.decryptionState, "pending_rights"), or(eq(transfers.from, delegator), eq(transfers.to, delegator))));
  await context.db.sql
    .update(balances)
    .set({ decryptionState: "pending_propagation", lastAttemptAt: null })
    .where(and(eq(balances.decryptionState, "pending_rights"), eq(balances.account, delegator)));
});

ponder.on("Acl:RevokedDelegationForUserDecryption", async ({ event, context }) => {
  const id = `${getAddress(event.args.contractAddress)}-${getAddress(event.args.delegator)}`;
  await context.db.update(delegations, { id }).set({ active: false, delegationCounter: event.args.delegationCounter });
});

// Decryption backfill, decoupled from per-transfer events (docs/INDEXER.md §5).
ponder.on("Backfill:block", async ({ event, context }) => {
  await runBackfill(context.db, event.block.timestamp);
});
