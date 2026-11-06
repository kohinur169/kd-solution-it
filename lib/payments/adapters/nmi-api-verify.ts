// path: lib/payments/adapters/nmi-api-verify.ts
import assert from "node:assert/strict";
import { buildNmiRequest, parseNmiResponse, validateNmiRequest, executeNmiTransaction, type NmiTransactionRequest } from "./nmi-api.ts";

const base: NmiTransactionRequest = { type: "sale", apiKey: "public", secretKey: "private", amount: "10.00", token: "00000000-000000-000000-000000000000", customerId: null, reference: null, originalTransactionId: null, capture: false };
assert.deepEqual(buildNmiRequest(base), { security_key: "private", type: "sale", amount: "10.00", payment_token: base.token });
assert.equal(buildNmiRequest({ ...base, type: "authorization" })["type"], "auth");
for (const type of ["capture", "refund", "void"] as const) {
  const payload = buildNmiRequest({ ...base, type, token: null, amount: null, originalTransactionId: "11223344" });
  assert.equal(payload["type"], type);
  assert.equal(payload["transactionid"], "11223344");
  assert.equal(payload["payment_token"], undefined);
}
assert.equal(buildNmiRequest({ ...base, type: "capture", token: null, originalTransactionId: "123", amount: "1.00" })["amount"], "1.00");
for (const amount of ["0.00", "-1.00", "1e2", "1.001", " 1.00", "NaN"]) {
  assert.equal(validateNmiRequest({ ...base, amount }).status, "rejected");
  assert.equal(validateNmiRequest({ ...base, type: "refund", token: null, originalTransactionId: "123", amount }).status, "rejected");
}
assert.equal(validateNmiRequest({ ...base, token: null }).status, "rejected");
assert.equal(validateNmiRequest({ ...base, type: "capture", token: null, amount: null, originalTransactionId: null }).status, "rejected");
assert.equal(validateNmiRequest({ ...base, type: "void", token: null, originalTransactionId: "123" }).status, "rejected");
assert.equal(validateNmiRequest({ ...base, capture: true }).status, "rejected");
assert.equal(validateNmiRequest({ ...base, customerId: "local-customer" }).status, "rejected");
assert.equal(validateNmiRequest({ ...base, secretKey: "" }).status, "rejected");
const approved = { response: "1", responsetext: "Approved", response_code: "100", transactionid: "11223344", authcode: "ABC", avsresponse: "Y", cvvresponse: "M" };
assert.equal(parseNmiResponse(approved).success, true);
assert.equal(parseNmiResponse({ ...approved, response: "2" }).success, false);
assert.equal(parseNmiResponse({ response_code: "0" }).success, false);
assert.equal(parseNmiResponse({ response: "1" }).success, false);
assert.equal(executeNmiTransaction(base, approved).status, "success");
assert.equal(executeNmiTransaction(base, { response: "2", response_code: "200" }).status, "failed");
process.stdout.write("payments NMI API gate passed: documented Classic API fields, validation and response mapping\n");
