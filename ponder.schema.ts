/**
 * Ponder (drizzle) schema — see docs/ARCHITECTURE.md.
 *
 * Every amount-bearing row carries an explicit `decryptionState` so the API can
 * be honest about the FHE in-between states instead of dropping events.
 */
import { onchainTable, onchainEnum } from "ponder";

/** Lifecycle of a single encrypted amount handle. */
export const decryptionState = onchainEnum("decryption_state", [
  "decrypted", // cleartext known (SDK decrypt, AmountDisclosed, or UnwrapFinalized)
  "pending_rights", // holder not yet entitled; awaiting a delegation
  "pending_propagation", // delegation observed on-chain, gateway not synced yet (~1-2 min)
  "failed", // decrypt errored (network/relayer); retried with backoff
]);

export const transferKind = onchainEnum("transfer_kind", [
  "transfer",
  "shield", // wrap: mint from the wrapper
  "unshield", // unwrap: burn via the two-phase unwrap flow
  "mint",
  "burn",
]);

export const decryptedVia = onchainEnum("decrypted_via", [
  "holder", // indexer holder was a party to the transfer
  "delegation", // decrypted as a delegate of a party
  "amount_disclosed", // cleartext came from an AmountDisclosed event
  "unwrap_finalized", // cleartext came from UnwrapFinalized.cleartextAmount
]);

/** One row per transfer/mint/burn/shield/unshield event. */
export const transfers = onchainTable("transfers", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  token: t.hex().notNull(),
  kind: transferKind().notNull(),
  from: t.hex().notNull(),
  to: t.hex().notNull(),
  amountHandle: t.hex().notNull(), // the ciphertext handle (always present)
  amount: t.bigint(), // cleartext, when known
  decryptionState: decryptionState().notNull(),
  decryptedVia: decryptedVia(),
  blockNumber: t.bigint().notNull(),
  blockTime: t.bigint().notNull(),
  logIndex: t.integer().notNull(),
  txHash: t.hex().notNull(),
  attempts: t.integer().notNull().default(0),
  lastAttemptAt: t.bigint(),
}));

/** Current confidential balance per (token, account), decrypted when entitled. */
export const balances = onchainTable("balances", (t) => ({
  id: t.text().primaryKey(), // `${token}-${account}`
  token: t.hex().notNull(),
  account: t.hex().notNull(),
  balanceHandle: t.hex(),
  balance: t.bigint(),
  decryptionState: decryptionState().notNull(),
  updatedAtBlock: t.bigint().notNull(),
}));

/** Delegations granting the indexer holder decrypt rights, from ACL events. */
export const delegations = onchainTable("delegations", (t) => ({
  id: t.text().primaryKey(), // `${contractAddress}-${delegator}`
  delegator: t.hex().notNull(),
  delegate: t.hex().notNull(),
  contractAddress: t.hex().notNull(), // token address, or the wildcard sentinel
  active: t.boolean().notNull(),
  expiry: t.bigint().notNull(),
  delegationCounter: t.bigint().notNull(),
  observedAtBlock: t.bigint().notNull(),
}));
