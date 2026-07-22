"use client";
// Classifies a thrown error from a real signing action (pause, resume,
// cancel) into a friendly title/description. The stellar-sdk's own
// AssembledTransaction.sign() already turns Freighter's real
// {error: {code, message}} result into one of these typed error classes
// (contract/assembled_transaction.js's own handleWalletError: code -4 is
// a real user rejection, -1/-2/-3 are real wallet-side failures) — this
// module only has to recognize them, not reparse Freighter's raw error
// shape itself.
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";

export interface ActionErrorDescription {
  title: string;
  description: string;
}

interface FreighterApiErrorShape {
  code: number;
  message: string;
  ext?: string[];
}

/** Freighter's raw wallet-level calls (signMessage, requestAccess, ...)
 * return `{error}` directly rather than throwing; AssembledTransaction's
 * own signAndSend() path (describeActionError below) already converts
 * the equivalent shape into typed Error subclasses, this mirrors the
 * same real code semantics (confirmed from stellar-sdk's own
 * handleWalletError: -1 internal, -2 external service, -3 invalid
 * request, -4 user rejected) for call sites that get the raw shape
 * instead. */
export function describeFreighterApiError(error: FreighterApiErrorShape): ActionErrorDescription {
  const fullMessage = error.ext?.length ? `${error.message} (${error.ext.join(", ")})` : error.message;
  switch (error.code) {
    case -4:
      return { title: "Signing cancelled", description: "The connected wallet declined this request." };
    case -1:
      return { title: "Wallet error", description: fullMessage };
    case -2:
      return {
        title: "Wallet network error",
        description: "The wallet's own backend service failed. Try again shortly.",
      };
    case -3:
      return { title: "Invalid request", description: fullMessage };
    default:
      return { title: "Wallet error", description: fullMessage };
  }
}

export function describeActionError(err: unknown): ActionErrorDescription {
  const Errors = AssembledTransaction.Errors;

  if (err instanceof Errors.UserRejected) {
    return {
      title: "Signing cancelled",
      description: "The connected wallet declined to sign this transaction.",
    };
  }
  if (err instanceof Errors.InternalWalletError) {
    return {
      title: "Wallet error",
      description: `The wallet reported an internal error: ${err.message}`,
    };
  }
  if (err instanceof Errors.ExternalServiceError) {
    return {
      title: "Wallet network error",
      description: "The wallet's own backend service failed. This is usually transient, try again shortly.",
    };
  }
  if (err instanceof Errors.InvalidClientRequest) {
    return {
      title: "Invalid request",
      description: err.message,
    };
  }
  if (err instanceof Errors.NeedsMoreSignatures) {
    return {
      title: "More signatures required",
      description: err.message,
    };
  }
  if (err instanceof Errors.SimulationFailed) {
    return {
      title: "Simulation failed",
      description: `The transaction was rejected before it was ever sent: ${err.message}`,
    };
  }
  if (err instanceof Errors.RestorationFailure) {
    return {
      title: "Restoration failed",
      description: "The expired ledger entries this call needs could not be restored automatically.",
    };
  }
  if (err instanceof Errors.ExpiredState) {
    return {
      title: "State expired",
      description: "The simulated transaction's ledger state expired before it could be signed. Retry.",
    };
  }

  // Anything else (a real on-chain rejection surfaced from
  // signAndSend's own polling, or a transient RPC failure) — surface the
  // real message rather than a generic string, an operator needs to see
  // exactly what the chain or network actually said.
  const message = err instanceof Error ? err.message : String(err);
  return { title: "Transaction failed", description: message };
}
