// path: lib/payments/adapters/nmi-payment-verify.ts
import assert from "node:assert/strict";
import { configureNmiKeys, InMemoryNmiKeyStore } from "./nmi-client.ts";
import { processNmiPayment, nmiFetchTransport, NMI_API_ENDPOINT, NMI_SANDBOX_API_ENDPOINT, type NmiPaymentRequest } from "./nmi-payment.ts";
const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const store = new InMemoryNmiKeyStore();
const config = configureNmiKeys({ companyId: "company", apiKey: "public-key-12345", secretKey: "private-key-12345", environment: "sandbox" }, { store, encryptionKey, occurredAtEpochMs: 1 });
assert.equal(config.status, "configured");
const request: NmiPaymentRequest = { companyId: "company", type: "sale", amount: "10.00", token: "00000000-000000-000000-000000000000", customerId: null, reference: null, originalTransactionId: null, capture: false };
const options = { store, encryptionKey, occurredAtEpochMs: 1 };
const approved = { response: "1", response_code: "100", responsetext: "Approved", transactionid: "11223344", authcode: "123" };
let called = false;
const success = await processNmiPayment(request, { ...options, transport: async (endpoint, payload) => {
  called = true;
  assert.equal(endpoint, NMI_SANDBOX_API_ENDPOINT);
  assert.deepEqual(payload, { security_key: "private-key-12345", type: "sale", amount: "10.00", payment_token: request.token });
  return approved;
} });
assert.equal(called, true);
for (const type of ["authorization", "capture", "refund", "void"] as const) {
  const followUp: NmiPaymentRequest = type === "authorization"
    ? { ...request, type }
    : { ...request, type, token: null, amount: type === "void" ? null : "5.00", originalTransactionId: "11223344" };
  const result = await processNmiPayment(followUp, { ...options, transport: async (_endpoint, payload) => {
    assert.equal(payload["type"], type === "authorization" ? "auth" : type);
    if (type !== "authorization") assert.equal(payload["transactionid"], "11223344");
    return approved;
  } });
  assert.equal(result.status, "success");
}

assert.equal(success.status, "success");
assert.equal((await processNmiPayment({ ...request, companyId: "other" }, options)).status, "rejected");
assert.equal((await processNmiPayment({ ...request, amount: "-1.00" }, options)).status, "rejected");
assert.equal((await processNmiPayment(request, { ...options, encryptionKey: "f".repeat(64) })).status, "failed");
assert.equal((await processNmiPayment(request, { ...options, transport: async () => ({ response: "2", response_code: "200", responsetext: "Declined" }) })).status, "failed");
for (const raw of [{ response_code: "0" }, { response: "1" }, { response: "4" }]) {
  assert.equal((await processNmiPayment(request, { ...options, transport: async () => raw })).status, "transport_error");
}
const failed = await processNmiPayment(request, { ...options, transport: async () => { throw new Error("private-key-12345"); } });
assert.equal(failed.status, "transport_error");
assert.equal(JSON.stringify(failed).includes("private-key-12345"), false);
assert.equal(NMI_API_ENDPOINT, "https://secure.nmi.com/api/transact.php");
const productionStore = new InMemoryNmiKeyStore();
configureNmiKeys({ companyId: "production", apiKey: "public-key-12345", secretKey: "private-key-12345", environment: "production" }, { store: productionStore, encryptionKey, occurredAtEpochMs: 1 });
const production = await processNmiPayment({ ...request, companyId: "production" }, { ...options, store: productionStore, transport: async (endpoint) => { assert.equal(endpoint, NMI_API_ENDPOINT); return approved; } });
assert.equal(production.status, "success");

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, NMI_SANDBOX_API_ENDPOINT);
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "security_key=private%26value&type=sale");
    assert.equal(init?.redirect, "error");
    return new Response("response=1&responsetext=Approved&transactionid=11223344&response_code=100", { status: 200 });
  };
  const response = await nmiFetchTransport(NMI_SANDBOX_API_ENDPOINT, { security_key: "private&value", type: "sale" });
  assert.equal(response["transactionid"], "11223344");
  globalThis.fetch = async () => new Response("response=1&response=2", { status: 200 });
  await assert.rejects(() => nmiFetchTransport(NMI_SANDBOX_API_ENDPOINT, {}));
  globalThis.fetch = async () => new Response("error", { status: 500 });
  await assert.rejects(() => nmiFetchTransport(NMI_SANDBOX_API_ENDPOINT, {}));
  await assert.rejects(() => nmiFetchTransport("https://example.com", {}));
} finally { globalThis.fetch = originalFetch; }
process.stdout.write("payments NMI payment gate passed: credential isolation, Classic API transport and ambiguous outcomes\n");
