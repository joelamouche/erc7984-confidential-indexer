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

export type DecryptState = "decrypted" | "pending_rights" | "pending_propagation" | "failed";

export function errorToState(err: unknown): DecryptState {
  // Holder lacks a usable handle for this account → awaiting a (further) grant.
  if (err instanceof NoCiphertextError) return "pending_rights";
  // SDK pre-flight: no/expired delegation on record.
  if (err instanceof DelegationNotFoundError || err instanceof DelegationExpiredError) {
    return "pending_rights";
  }
  // Grant exists on-chain but the gateway hasn't synced it yet (~1–2 min).
  if (err instanceof DelegationNotPropagatedError) return "pending_propagation";
  // RelayerRequestFailed / DecryptionFailed / unknown → transient, back off.
  return "failed";
}
