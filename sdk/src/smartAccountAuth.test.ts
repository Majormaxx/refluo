import { test } from "node:test";
import assert from "node:assert/strict";
import { Address, xdr, scValToNative } from "@stellar/stellar-sdk";
import {
  delegatedSignerScVal,
  buildAuthPayloadScVal,
  countInvocationNodes,
} from "./smartAccountAuth.js";

const ADDR_A = "GDFTLDNIHOMZGS4YFNQSHVKPML5FNTPXV3ENTDHB6G546ADBEWKQFMHO";
const ADDR_B = "GD6UPDHPBC3WFAHZO27CGXFQMIGUMHK72LTTUR4UDWJLNLQQJDPDWH3Q";
const ADDR_C = "GAANTB7H664NC2YUDJHR7TUINQ3LXFETAGQVORANRW4FLUBVYS3JFXF7";

test("delegatedSignerScVal encodes Signer::Delegated(Address) as Vec[Symbol, Address]", () => {
  const scVal = delegatedSignerScVal(ADDR_A);
  const native = scValToNative(scVal);
  assert.deepEqual(native, ["Delegated", ADDR_A]);
});

test("buildAuthPayloadScVal orders struct fields alphabetically: context_rule_ids before signers", () => {
  const contextRuleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]);
  const payload = buildAuthPayloadScVal(contextRuleIds, [ADDR_A]);
  const mapEntries = payload.map();
  assert.ok(mapEntries);
  const keys = mapEntries!.map((e) => scValToNative(e.key()));
  assert.deepEqual(keys, ["context_rule_ids", "signers"]);
});

test("buildAuthPayloadScVal round-trips a single signer with empty signature bytes", () => {
  const contextRuleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]);
  const payload = buildAuthPayloadScVal(contextRuleIds, [ADDR_A]);
  const native = scValToNative(payload);
  assert.deepEqual(native.context_rule_ids, [0]);
  // scValToNative decodes a Vec-keyed Map to a plain object with
  // comma-joined array keys, not a JS Map.
  assert.equal(Object.keys(native.signers).length, 1);
  assert.equal(native.signers[`Delegated,${ADDR_A}`].length, 0);
});

test("buildAuthPayloadScVal includes every co-signer, one map entry each", () => {
  const contextRuleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]);
  const payload = buildAuthPayloadScVal(contextRuleIds, [ADDR_A, ADDR_B, ADDR_C]);
  const mapEntries = payload.map();
  const signersEntry = mapEntries!.find(
    (e) => scValToNative(e.key()) === "signers",
  )!;
  const signersMap = signersEntry.val().map()!;
  assert.equal(signersMap.length, 3);
});

test("buildAuthPayloadScVal map key order is deterministic regardless of input order", () => {
  const contextRuleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]);
  const forward = buildAuthPayloadScVal(contextRuleIds, [ADDR_A, ADDR_B, ADDR_C]);
  const reversed = buildAuthPayloadScVal(contextRuleIds, [ADDR_C, ADDR_B, ADDR_A]);
  assert.equal(forward.toXDR("base64"), reversed.toXDR("base64"));
});

test("buildAuthPayloadScVal map keys are strictly ordered by raw ScVal bytes, not insertion order", () => {
  const contextRuleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]);
  const payload = buildAuthPayloadScVal(contextRuleIds, [ADDR_A, ADDR_B, ADDR_C]);
  const mapEntries = payload.map();
  const signersEntry = mapEntries!.find(
    (e) => scValToNative(e.key()) === "signers",
  )!;
  const signersMap = signersEntry.val().map()!;
  const keyBytes = signersMap.map((e) => e.key().toXDR());
  for (let i = 1; i < keyBytes.length; i++) {
    assert.ok(
      Buffer.compare(keyBytes[i - 1], keyBytes[i]) < 0,
      "map keys must be in strictly increasing byte order",
    );
  }
});

function invocation(
  functionName: string,
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(ADDR_A).toScAddress(),
        functionName,
        args: [],
      }),
    ),
    subInvocations,
  });
}

test("countInvocationNodes counts just the root when there are no sub-invocations", () => {
  assert.equal(countInvocationNodes(invocation("update_context_rule_name")), 1);
});

test("countInvocationNodes counts the root plus one sub-invocation (the real Soroswap router shape)", () => {
  const tree = invocation("swap_exact_tokens_for_tokens", [invocation("transfer")]);
  assert.equal(countInvocationNodes(tree), 2);
});

test("countInvocationNodes counts nested sub-invocations recursively, not just direct children", () => {
  const tree = invocation("outer", [invocation("middle", [invocation("inner")])]);
  assert.equal(countInvocationNodes(tree), 3);
});

test("countInvocationNodes counts multiple sibling sub-invocations", () => {
  const tree = invocation("outer", [invocation("a"), invocation("b"), invocation("c")]);
  assert.equal(countInvocationNodes(tree), 4);
});

test("buildAuthPayloadScVal signature bytes are always empty (ignored for Delegated signers)", () => {
  const contextRuleIds = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]);
  const payload = buildAuthPayloadScVal(contextRuleIds, [ADDR_A, ADDR_B]);
  const mapEntries = payload.map();
  const signersEntry = mapEntries!.find(
    (e) => scValToNative(e.key()) === "signers",
  )!;
  const signersMap = signersEntry.val().map()!;
  for (const entry of signersMap) {
    assert.equal(entry.val().bytes().length, 0);
  }
});
