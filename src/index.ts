/**
 * Ponder indexing handlers.
 *
 * Pass 1 (this commit): record events into the schema with explicit decryption
 * state — no amounts dropped. Decryption via @zama-fhe/sdk is layered on top in
 * the next step (the `decryptionState` starts at `pending_rights` and the backfill
 * worker / ACL events promote it). `AmountDisclosed` and `UnwrapFinalized` already
 * give us cleartext straight from the chain with no SDK round-trip.
 */
import { ponder } from "ponder:registry";
import { transfers, delegations } from "ponder:schema";
import { getAddress, zeroAddress } from "viem";

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

ponder.on("ConfidentialToken:ConfidentialTransfer", async ({ event, context }) => {
  const { from, to, amount } = event.args;
  await context.db
    .insert(transfers)
    .values({
      id: transferId(event.transaction.hash, event.log.logIndex),
      token: getAddress(event.log.address),
      kind: classifyKind(from, to),
      from: getAddress(from),
      to: getAddress(to),
      amountHandle: amount, // ciphertext handle — always recorded
      amount: null, // cleartext filled by decryption / disclosure
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
});

// Public cleartext reveal: any transfer carrying this exact handle can be filled
// in regardless of holder rights.
ponder.on("ConfidentialToken:AmountDisclosed", async ({ event, context }) => {
  const { encryptedAmount, amount } = event.args;
  await context.db.sql
    .update(transfers)
    .set({ amount, decryptionState: "decrypted", decryptedVia: "amount_disclosed" })
    .where(eqHandle(transfers.amountHandle, encryptedAmount));
});

// Unshield step 2 carries the cleartext unwrap amount on-chain.
ponder.on("ConfidentialToken:UnwrapFinalized", async ({ event, context }) => {
  const { encryptedAmount, cleartextAmount } = event.args;
  await context.db.sql
    .update(transfers)
    .set({ amount: cleartextAmount, decryptionState: "decrypted", decryptedVia: "unwrap_finalized" })
    .where(eqHandle(transfers.amountHandle, encryptedAmount));
});

// ACL rights discovery — only events naming our holder as delegate reach here
// (filtered in ponder.config.ts).
ponder.on("Acl:DelegatedForUserDecryption", async ({ event, context }) => {
  const { delegator, delegate, contractAddress, delegationCounter, newExpirationDate } = event.args;
  const id = `${getAddress(contractAddress)}-${getAddress(delegator)}`;
  const row = {
    id,
    delegator: getAddress(delegator),
    delegate: getAddress(delegate),
    contractAddress: getAddress(contractAddress),
    active: true,
    expiry: newExpirationDate,
    delegationCounter,
    observedAtBlock: event.block.number,
  };
  await context.db.insert(delegations).values(row).onConflictDoUpdate(row);
});

ponder.on("Acl:RevokedDelegationForUserDecryption", async ({ event, context }) => {
  const { delegator, contractAddress, delegationCounter } = event.args;
  const id = `${getAddress(contractAddress)}-${getAddress(delegator)}`;
  await context.db
    .update(delegations, { id })
    .set({ active: false, delegationCounter });
});

// drizzle eq helper imported lazily to keep the handler file focused.
import { eq } from "drizzle-orm";
function eqHandle<T>(column: T, value: `0x${string}`) {
  return eq(column as never, value);
}
