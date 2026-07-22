import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiError, UnauthenticatedError, ForbiddenError, classifyError } from "./apiError.js";

test("classifyError passes an ApiError through unchanged", () => {
  const original = new ApiError("custom", 418, true);
  const classified = classifyError(original);
  assert.equal(classified, original);
});

test("UnauthenticatedError defaults to 401 non-retryable", () => {
  const err = new UnauthenticatedError();
  assert.equal(err.status, 401);
  assert.equal(err.retryable, false);
});

test("ForbiddenError defaults to 403 non-retryable", () => {
  const err = new ForbiddenError();
  assert.equal(err.status, 403);
  assert.equal(err.retryable, false);
});

test("classifyError recognizes a real network timeout message as retryable", () => {
  const classified = classifyError(new Error("connect ETIMEDOUT 1.2.3.4:443"));
  assert.equal(classified.status, 503);
  assert.equal(classified.retryable, true);
});

test("classifyError recognizes the real 'Account not found' RPC error as retryable", () => {
  const classified = classifyError(new Error("Account not found: GABC..."));
  assert.equal(classified.retryable, true);
});

test("classifyError recognizes a real getEvents retention-boundary error as retryable", () => {
  const classified = classifyError(
    new Error("startLedger must be within the ledger range: 100 - 200"),
  );
  assert.equal(classified.retryable, true);
});

test("classifyError defaults an unrecognized error to 500 non-retryable", () => {
  const classified = classifyError(new Error("insufficient balance for withdrawal"));
  assert.equal(classified.status, 500);
  assert.equal(classified.retryable, false);
});

test("classifyError handles a non-Error thrown value", () => {
  const classified = classifyError("a plain string throw");
  assert.equal(classified.message, "a plain string throw");
  assert.equal(classified.retryable, false);
});
