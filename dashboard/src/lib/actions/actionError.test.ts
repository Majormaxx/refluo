import { test } from "node:test";
import assert from "node:assert/strict";
import { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { describeActionError, describeFreighterApiError } from "./actionError.js";

test("describeActionError recognizes a real UserRejected error as a cancelled signing, not a failure", () => {
  const err = new AssembledTransaction.Errors.UserRejected("user said no");
  const { title } = describeActionError(err);
  assert.equal(title, "Signing cancelled");
});

test("describeActionError surfaces the real message for an InternalWalletError", () => {
  const err = new AssembledTransaction.Errors.InternalWalletError("boom");
  const { title, description } = describeActionError(err);
  assert.equal(title, "Wallet error");
  assert.match(description, /boom/);
});

test("describeActionError treats ExternalServiceError as a transient wallet-network issue", () => {
  const err = new AssembledTransaction.Errors.ExternalServiceError("timeout");
  const { title } = describeActionError(err);
  assert.equal(title, "Wallet network error");
});

test("describeActionError falls back to the raw message for a real on-chain rejection", () => {
  const err = new Error("transaction failed on-chain: InsufficientBalance");
  const { title, description } = describeActionError(err);
  assert.equal(title, "Transaction failed");
  assert.equal(description, "transaction failed on-chain: InsufficientBalance");
});

test("describeActionError handles a non-Error thrown value", () => {
  const { description } = describeActionError("a plain string throw");
  assert.equal(description, "a plain string throw");
});

test("describeFreighterApiError maps code -4 to a cancelled signing", () => {
  const { title } = describeFreighterApiError({ code: -4, message: "declined" });
  assert.equal(title, "Signing cancelled");
});

test("describeFreighterApiError maps code -1 to a wallet error with the real message", () => {
  const { title, description } = describeFreighterApiError({ code: -1, message: "internal boom" });
  assert.equal(title, "Wallet error");
  assert.match(description, /internal boom/);
});

test("describeFreighterApiError includes ext details in the message when present", () => {
  const { description } = describeFreighterApiError({
    code: -1,
    message: "internal boom",
    ext: ["detail-a", "detail-b"],
  });
  assert.match(description, /detail-a, detail-b/);
});

test("describeFreighterApiError maps code -2 to a transient wallet-network error", () => {
  const { title } = describeFreighterApiError({ code: -2, message: "service down" });
  assert.equal(title, "Wallet network error");
});

test("describeFreighterApiError maps an unrecognized code to a generic wallet error", () => {
  const { title, description } = describeFreighterApiError({ code: 999, message: "mystery" });
  assert.equal(title, "Wallet error");
  assert.match(description, /mystery/);
});
