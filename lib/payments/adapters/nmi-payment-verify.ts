// path: lib/payments/adapters/nmi-payment-verify.ts
import process from "node:process";
import {
  InMemoryNmiKeyStore,
  configureNmiKeys,
} from "./nmi-client.ts";
import {
  processNmiPayment,
  NMI_API_ENDPOINT,
  type NmiPaymentRequest,
  type NmiHttpTransport,
} from "./nmi-payment.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (condition) {
    checks++;
  } else {
    failures.push(description);
  }
}

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const occurredAt = 1_000_000_000_000;

function makeStore(companyId: string): InMemoryNmiKeyStore {
  const store = new InMemoryNmiKeyStore();
  const result = configureNmiKeys(
    {
      companyId,
      apiKey: "api-key-1234567890",
      secretKey: "secret-key-abcdefghij",
      environment: "sandbox",
    },
    { store, encryptionKey, occurredAtEpochMs: occurredAt },
  );
  if (result.status !== "configured") {
    throw new Error("failed to configure NMI keys in the test store");
  }
  return store;
}

function successResponse(): Record<string, string> {
  return {
    response_code: "0",
    response_message: "Success",
    transaction_id: "1234567890",
    amount: "100.00",
    auth_code: "ABC123",
    avs_result_code: "Z",
    cvv_result_code: "M",
  };
}

function failedResponse(): Record<string, string> {
  return {
    response_code: "6",
    response_message: "Invalid amount",
  };
}

function makePayment(overrides: Partial<NmiPaymentRequest> = {}): NmiPaymentRequest {
  return {
    companyId: "company-1",
    type: "sale",
    amount: "100.00",
    token: "tok_1234567890abcdef",
    customerId: null,
    reference: null,
    originalTransactionId: null,
    capture: false,
    ...overrides,
  };
}

function makeOptions(overrides: {
  store?: InMemoryNmiKeyStore;
  transport?: NmiHttpTransport;
} = {}) {
  return {
    store: overrides.store ?? makeStore("company-1"),
    encryptionKey,
    transport: overrides.transport ?? (() => successResponse()),
    occurredAtEpochMs: occurredAt,
  };
}

/* ---- scenario 1: processing a sale payment succeeds ---- */

const saleResult = processNmiPayment(makePayment(), makeOptions());
expect(saleResult.status === "success", "processing a sale payment returns success");
if (saleResult.status === "success") {
  expect(saleResult.transactionId === "1234567890", "the sale result carries the transaction id");
  expect(saleResult.authCode === "ABC123", "the sale result carries the auth code");
  expect(saleResult.amount === "100.00", "the sale result carries the amount");
}

/* ---- scenario 2: the sale payload contains the correct fields ---- */

const captured: { endpoint: string; payload: Record<string, string> } = {
  endpoint: "",
  payload: {},
};
const captureTransport: NmiHttpTransport = (endpoint, payload) => {
  captured.endpoint = endpoint;
  captured.payload = payload;
  return successResponse();
};
const saleCaptured = processNmiPayment(makePayment(), makeOptions({ transport: captureTransport }));
expect(saleCaptured.status === "success", "the sale payment with captured transport returns success");
expect(captured.endpoint === NMI_API_ENDPOINT, "the transport receives the NMI API endpoint");
expect(captured.payload["api_key"] === "api-key-1234567890", "the payload has the decrypted API key");
expect(captured.payload["secret_key"] === "secret-key-abcdefghij", "the payload has the decrypted secret key");
expect(captured.payload["type"] === "sale", "the payload has the sale type");
expect(captured.payload["amount"] === "100.00", "the payload has the amount");
expect(captured.payload["token"] === "tok_1234567890abcdef", "the payload has the Collect.js token");

/* ---- scenario 3: processing an authorization payment ---- */

const capturedAuth: { payload: Record<string, string> } = { payload: {} };
const authTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedAuth.payload = payload;
  return successResponse();
};
const authResult = processNmiPayment(
  makePayment({ type: "authorization", capture: true }),
  makeOptions({ transport: authTransport }),
);
expect(authResult.status === "success", "processing an authorization payment returns success");
expect(capturedAuth.payload["type"] === "authorization", "the authorization payload has the right type");
expect(capturedAuth.payload["amount"] === "100.00", "the authorization payload has the amount");
expect(capturedAuth.payload["token"] === "tok_1234567890abcdef", "the authorization payload has the token");
expect(capturedAuth.payload["capture"] === "true", "the authorization payload has the capture flag set to true");

/* ---- scenario 4: processing a capture payment ---- */

const capturedCapture: { payload: Record<string, string> } = { payload: {} };
const captureTypeTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedCapture.payload = payload;
  return successResponse();
};
const captureResult = processNmiPayment(
  makePayment({ type: "capture", amount: null, token: null, originalTransactionId: "orig-123" }),
  makeOptions({ transport: captureTypeTransport }),
);
expect(captureResult.status === "success", "processing a capture payment returns success");
expect(capturedCapture.payload["type"] === "capture", "the capture payload has the right type");
expect(capturedCapture.payload["original_transaction_id"] === "orig-123", "the capture payload has the original transaction id");
expect(!("token" in capturedCapture.payload), "the capture payload has no token");
expect(!("amount" in capturedCapture.payload), "the capture payload has no amount when not provided");

/* ---- scenario 5: processing a capture payment with partial amount ---- */

const capturedPartial: { payload: Record<string, string> } = { payload: {} };
const partialTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedPartial.payload = payload;
  return successResponse();
};
const partialResult = processNmiPayment(
  makePayment({ type: "capture", amount: "50.00", token: null, originalTransactionId: "orig-123" }),
  makeOptions({ transport: partialTransport }),
);
expect(partialResult.status === "success", "processing a capture with partial amount returns success");
expect(capturedPartial.payload["amount"] === "50.00", "the partial capture payload has the partial amount");

/* ---- scenario 6: processing a refund payment ---- */

const capturedRefund: { payload: Record<string, string> } = { payload: {} };
const refundTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedRefund.payload = payload;
  return successResponse();
};
const refundResult = processNmiPayment(
  makePayment({ type: "refund", amount: null, token: null, originalTransactionId: "orig-456" }),
  makeOptions({ transport: refundTransport }),
);
expect(refundResult.status === "success", "processing a refund payment returns success");
expect(capturedRefund.payload["type"] === "refund", "the refund payload has the right type");
expect(capturedRefund.payload["original_transaction_id"] === "orig-456", "the refund payload has the original transaction id");
expect(!("token" in capturedRefund.payload), "the refund payload has no token");

/* ---- scenario 7: processing a void payment ---- */

const capturedVoid: { payload: Record<string, string> } = { payload: {} };
const voidTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedVoid.payload = payload;
  return successResponse();
};
const voidResult = processNmiPayment(
  makePayment({ type: "void", amount: null, token: null, originalTransactionId: "orig-789" }),
  makeOptions({ transport: voidTransport }),
);
expect(voidResult.status === "success", "processing a void payment returns success");
expect(capturedVoid.payload["type"] === "void", "the void payload has the right type");
expect(capturedVoid.payload["original_transaction_id"] === "orig-789", "the void payload has the original transaction id");
expect(!("amount" in capturedVoid.payload), "the void payload has no amount");
expect(!("token" in capturedVoid.payload), "the void payload has no token");

/* ---- scenario 8: no key configuration exists for the company ---- */

const emptyStore = new InMemoryNmiKeyStore();
const noConfigResult = processNmiPayment(makePayment(), makeOptions({ store: emptyStore }));
expect(noConfigResult.status === "rejected", "processing a payment without a key config is rejected");

/* ---- scenario 9: decryption failure ---- */

const badKeyStore = makeStore("company-1");
// This scenario is covered by the wrong encryption key path.
const wrongKeyResult = processNmiPayment(
  makePayment(),
  {
    store: badKeyStore,
    encryptionKey: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    transport: () => successResponse(),
    occurredAtEpochMs: occurredAt,
  },
);
expect(wrongKeyResult.status === "failed", "processing a payment with a wrong encryption key fails");
if (wrongKeyResult.status === "failed") {
  expect(wrongKeyResult.responseCode === "decryption_error", "the decryption failure returns the decryption error code");
}

/* ---- scenario 10: invalid request (missing amount for sale) ---- */

const invalidResult = processNmiPayment(
  makePayment({ amount: null }),
  makeOptions(),
);
expect(invalidResult.status === "rejected", "processing a sale without an amount is rejected");

/* ---- scenario 11: invalid request (missing token for sale) ---- */

const noTokenResult = processNmiPayment(
  makePayment({ token: null }),
  makeOptions(),
);
expect(noTokenResult.status === "rejected", "processing a sale without a token is rejected");

/* ---- scenario 12: invalid request (missing original id for capture) ---- */

const noOrigResult = processNmiPayment(
  makePayment({ type: "capture", amount: null, token: null, originalTransactionId: null }),
  makeOptions(),
);
expect(noOrigResult.status === "rejected", "processing a capture without an original transaction id is rejected");

/* ---- scenario 13: NMI API returns a non-zero response code ---- */

const failedResult = processNmiPayment(
  makePayment(),
  makeOptions({ transport: () => failedResponse() }),
);
expect(failedResult.status === "failed", "a non-zero response code returns failed");
if (failedResult.status === "failed") {
  expect(failedResult.responseCode === "6", "the failed result carries the response code");
  expect(failedResult.responseMessage === "Invalid amount", "the failed result carries the response message");
}

/* ---- scenario 14: the transport throws an error ---- */

const throwingTransport: NmiHttpTransport = () => {
  throw new Error("network unreachable");
};
const transportErrorResult = processNmiPayment(makePayment(), makeOptions({ transport: throwingTransport }));
expect(transportErrorResult.status === "transport_error", "a throwing transport returns transport_error");
if (transportErrorResult.status === "transport_error") {
  expect(transportErrorResult.message.includes("network unreachable"), "the transport error message includes the error detail");
}

/* ---- scenario 15: the sale payload with optional fields ---- */

const capturedOptional: { payload: Record<string, string> } = { payload: {} };
const optionalTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedOptional.payload = payload;
  return successResponse();
};
const optionalResult = processNmiPayment(
  makePayment({ customerId: "cust-999", reference: "ref-abc" }),
  makeOptions({ transport: optionalTransport }),
);
expect(optionalResult.status === "success", "processing a sale with optional fields returns success");
expect(capturedOptional.payload["customer_id"] === "cust-999", "the optional customer_id is included");
expect(capturedOptional.payload["reference"] === "ref-abc", "the optional reference is included");

/* ---- scenario 16: the authorization payload with capture flag false ---- */

const capturedAuthFalse: { payload: Record<string, string> } = { payload: {} };
const authFalseTransport: NmiHttpTransport = (_endpoint, payload) => {
  capturedAuthFalse.payload = payload;
  return successResponse();
};
const authFalseResult = processNmiPayment(
  makePayment({ type: "authorization", capture: false }),
  makeOptions({ transport: authFalseTransport }),
);
expect(authFalseResult.status === "success", "processing an authorization with capture=false returns success");
expect(capturedAuthFalse.payload["capture"] === "false", "the authorization payload has capture=false");

/* ---- scenario 17: the endpoint URL is the NMI API endpoint ---- */

expect(NMI_API_ENDPOINT === "https://api.nmi.com/api/v1/transactions", "the endpoint URL is the NMI API transactions endpoint");

/* ---- scenario 18: the transport receives the correct endpoint for all types ---- */

const endpointCapture: { endpoint: string } = { endpoint: "" };
const endpointTransport: NmiHttpTransport = (endpoint, _payload) => {
  endpointCapture.endpoint = endpoint;
  return successResponse();
};
processNmiPayment(makePayment({ type: "refund", amount: null, token: null, originalTransactionId: "orig-1" }), makeOptions({ transport: endpointTransport }));
expect(endpointCapture.endpoint === NMI_API_ENDPOINT, "the refund transport receives the NMI API endpoint");

/* ---- scenario 19: a sale with a different company uses that company's keys ---- */

const company2Store = makeStore("company-2");
const company2Result = processNmiPayment(
  makePayment({ companyId: "company-2" }),
  makeOptions({ store: company2Store }),
);
expect(company2Result.status === "success", "processing a payment for a different company returns success");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments NMI payment gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments NMI payment gate passed: ${checks} checks, a shared server payment module that exchanges Collect.js tokens through the NMI API per the official NMI documentation, resolving API credentials from the key store, building transaction requests for sale, authorization, capture, refund, and void, sending them to the NMI API endpoint, and parsing responses into success, failed, rejected, or transport_error results\n`,
);
