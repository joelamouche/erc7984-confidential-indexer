/**
 * Map a Zama SDK decryption error onto our per-amount state. See the error→state
 * table in docs/SDK-NOTES.md. The distinction is what makes the backfill correct:
 * "no rights yet, retry after a grant" vs "gateway not synced, retry soon" vs
 * "transient failure, back off".
 */
import {
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationNotPropagatedError,
  NoCiphertextError,
} from "@zama-fhe/sdk";

export type DecryptState =
  | "decrypted"
  | "pending_decrypt" // initial: queued, the backfill hasn't attempted it yet
  | "pending_rights"
  | "pending_propagation"
  | "failed";

/** Map a thrown SDK error instance to the per-amount decryption state. */
export function errorToState(err: unknown): DecryptState {
  // Holder lacks a usable handle for this account → awaiting a (further) grant.
  if (err instanceof NoCiphertextError) return "pending_rights";
  // SDK pre-flight: no/expired delegation on record.
  if (err instanceof DelegationNotFoundError || err instanceof DelegationExpiredError) {
    return "pending_rights";
  }
  // Grant exists on-chain but the gateway hasn't synced it yet (~4s measured).
  if (err instanceof DelegationNotPropagatedError) return "pending_propagation";
  // RelayerRequestFailed / DecryptionFailed / unknown → transient, back off.
  return "failed";
}

/**
 * Same mapping by error class NAME — used when decryption runs out-of-process
 * (the SDK can't run inside Ponder's Vite SSR runtime; see docs/INDEXER.md §5),
 * so error instances don't survive the process boundary.
 */
export function errorNameToState(name: string | undefined): DecryptState {
  switch (name) {
    case "NoCiphertextError":
    case "DelegationNotFoundError":
    case "DelegationExpiredError":
      return "pending_rights";
    case "DelegationNotPropagatedError":
      return "pending_propagation";
    default:
      return "failed";
  }
}
