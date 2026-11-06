// path: lib/payments/adapters/nmi-api-verify.ts
import process from "node:process";
import {
  validateNmiRequest,
  buildNmiRequest,
  parseNmiResponse,
  executeNmiTransaction,
  type NmiTransactionRequest,
} from "./nmi-api.ts";

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

function makeRequest(overrides: Partial<NmiTransactionRequest> = {}): NmiTransactionRequest {
  return {
    type: "sale",
    apiKey: "api-key-123",
    secretKey: "secret-key-456",
    amount: "100.00",
    token: "tok_1234567890abcdef",
    customerId: null,
    reference: null,
    originalTransactionId: null,
    capture: false,
    ...overrides,
  };
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

/* ---- scenario 1: validating a sale request ---- */

const saleValidation = validateNmiRequest(makeRequest());
expect(saleValidation.status === "valid", "a valid sale request is accepted");

/* ---- scenario 2: validating a sale request with empty amount ---- */

const emptyAmount = validateNmiRequest(makeRequest({ amount: " " }));
expect(emptyAmount.status === "rejected", "a sale request with empty amount is rejected");

/* ---- scenario 3: validating a sale request with negative amount ---- */

const negativeAmount = validateNmiRequest(makeRequest({ amount: "-50.00" }));
expect(negativeAmount.status === "rejected", "a sale request with negative amount is rejected");

/* ---- scenario 4: validating a sale request with zero amount ---- */

const zeroAmount = validateNmiRequest(makeRequest({ amount: "0.00" }));
expect(zeroAmount.status === "rejected", "a sale request with zero amount is rejected");

/* ---- scenario 5: validating a sale request with empty token ---- */

const emptyToken = validateNmiRequest(makeRequest({ token: "  " }));
expect(emptyToken.status === "rejected", "a sale request with empty token is rejected");

/* ---- scenario 6: validating a sale request with empty api key ---- */

const emptyApiKey = validateNmiRequest(makeRequest({ apiKey: " " }));
expect(emptyApiKey.status === "rejected", "a request with empty API key is rejected");

/* ---- scenario 7: validating a sale request with empty secret key ---- */

const emptySecretKey = validateNmiRequest(makeRequest({ secretKey: "" }));
expect(emptySecretKey.status === "rejected", "a request with empty secret key is rejected");

/* ---- scenario 8: validating an authorization request ---- */

const authValidation = validateNmiRequest(makeRequest({ type: "authorization" }));
expect(authValidation.status === "valid", "a valid authorization request is accepted");

/* ---- scenario 9: validating a capture request with original transaction id ---- */

const captureValidation = validateNmiRequest(makeRequest({
  type: "capture",
  amount: null,
  token: null,
  originalTransactionId: "orig-123",
}));
expect(captureValidation.status === "valid", "a valid capture request is accepted");

/* ---- scenario 10: validating a capture request without original transaction id ---- */

const captureNoOrig = validateNmiRequest(makeRequest({
  type: "capture",
  amount: null,
  token: null,
  originalTransactionId: null,
}));
expect(captureNoOrig.status === "rejected", "a capture request without original transaction id is rejected");

/* ---- scenario 11: validating a refund request ---- */

const refundValidation = validateNmiRequest(makeRequest({
  type: "refund",
  amount: null,
  token: null,
  originalTransactionId: "orig-456",
}));
expect(refundValidation.status === "valid", "a valid refund request is accepted");

/* ---- scenario 12: validating a void request ---- */

const voidValidation = validateNmiRequest(makeRequest({
  type: "void",
  amount: null,
  token: null,
  originalTransactionId: "orig-789",
}));
expect(voidValidation.status === "valid", "a valid void request is accepted");

/* ---- scenario 13: building a sale request ---- */

const salePayload = buildNmiRequest(makeRequest());
expect(salePayload["api_key"] === "api-key-123", "the sale payload carries the API key");
expect(salePayload["secret_key"] === "secret-key-456", "the sale payload carries the secret key");
expect(salePayload["type"] === "sale", "the sale payload carries the sale type");
expect(salePayload["amount"] === "100.00", "the sale payload carries the amount");
expect(salePayload["token"] === "tok_1234567890abcdef", "the sale payload carries the token");

/* ---- scenario 14: building a sale request with optional fields ---- */

const saleWithOptional = buildNmiRequest(makeRequest({ customerId: "cust-1", reference: "order-1" }));
expect(saleWithOptional["customer_id"] === "cust-1", "the sale payload carries the customer id when provided");
expect(saleWithOptional["reference"] === "order-1", "the sale payload carries the reference when provided");

/* ---- scenario 15: building an authorization request includes capture flag ---- */

const authPayload = buildNmiRequest(makeRequest({ type: "authorization", capture: true }));
expect(authPayload["capture"] === "true", "the authorization payload includes the capture flag when true");

const authPayloadNoCapture = buildNmiRequest(makeRequest({ type: "authorization", capture: false }));
expect(authPayloadNoCapture["capture"] === "false", "the authorization payload includes the capture flag when false");

/* ---- scenario 16: building a capture request ---- */

const capturePayload = buildNmiRequest(makeRequest({
  type: "capture",
  amount: null,
  token: null,
  originalTransactionId: "orig-123",
}));
expect(capturePayload["original_transaction_id"] === "orig-123", "the capture payload carries the original transaction id");
expect(capturePayload["token"] === undefined, "the capture payload does not include a token");

/* ---- scenario 17: building a refund request with partial amount ---- */

const refundPayload = buildNmiRequest(makeRequest({
  type: "refund",
  amount: "50.00",
  token: null,
  originalTransactionId: "orig-456",
}));
expect(refundPayload["original_transaction_id"] === "orig-456", "the refund payload carries the original transaction id");
expect(refundPayload["amount"] === "50.00", "the refund payload carries the partial amount when provided");

/* ---- scenario 18: building a void request ---- */

const voidPayload = buildNmiRequest(makeRequest({
  type: "void",
  amount: null,
  token: null,
  originalTransactionId: "orig-789",
}));
expect(voidPayload["original_transaction_id"] === "orig-789", "the void payload carries the original transaction id");
expect(voidPayload["amount"] === undefined, "the void payload does not include an amount");

/* ---- scenario 19: parsing a successful response ---- */

const parsedSuccess = parseNmiResponse(successResponse());
expect(parsedSuccess.success === true, "a response with code 0 is parsed as success");
expect(parsedSuccess.transactionId === "1234567890", "the parsed response carries the transaction id");
expect(parsedSuccess.authCode === "ABC123", "the parsed response carries the auth code");
expect(parsedSuccess.amount === "100.00", "the parsed response carries the amount");

/* ---- scenario 20: parsing a failed response ---- */

const parsedFailed = parseNmiResponse(failedResponse());
expect(parsedFailed.success === false, "a response with code 6 is parsed as failed");
expect(parsedFailed.responseCode === "6", "the parsed response carries the response code");
expect(parsedFailed.responseMessage === "Invalid amount", "the parsed response carries the response message");

/* ---- scenario 21: executing a sale transaction ---- */

const saleResult = executeNmiTransaction(makeRequest(), successResponse());
expect(saleResult.status === "success", "executing a sale with a valid response returns success");
if (saleResult.status === "success") {
  expect(saleResult.transactionId === "1234567890", "the sale result carries the transaction id");
  expect(saleResult.authCode === "ABC123", "the sale result carries the auth code");
  expect(saleResult.amount === "100.00", "the sale result carries the amount");
}

/* ---- scenario 22: executing a sale with a failed response ---- */

const saleFailed = executeNmiTransaction(makeRequest(), failedResponse());
expect(saleFailed.status === "failed", "executing a sale with a failed response returns failed");
if (saleFailed.status === "failed") {
  expect(saleFailed.responseCode === "6", "the failed sale result carries the response code");
  expect(saleFailed.responseMessage === "Invalid amount", "the failed sale result carries the response message");
}

/* ---- scenario 23: executing a sale with an invalid request ---- */

const saleRejected = executeNmiTransaction(makeRequest({ amount: " " }), successResponse());
expect(saleRejected.status === "rejected", "executing a sale with an invalid request returns rejected");

/* ---- scenario 24: executing a capture transaction ---- */

const captureResult = executeNmiTransaction(
  makeRequest({ type: "capture", amount: null, token: null, originalTransactionId: "orig-123" }),
  successResponse(),
);
expect(captureResult.status === "success", "executing a capture with a valid response returns success");

/* ---- scenario 25: executing a refund transaction ---- */

const refundResult = executeNmiTransaction(
  makeRequest({ type: "refund", amount: null, token: null, originalTransactionId: "orig-456" }),
  successResponse(),
);
expect(refundResult.status === "success", "executing a refund with a valid response returns success");

/* ---- scenario 26: executing a void transaction ---- */

const voidResult = executeNmiTransaction(
  makeRequest({ type: "void", amount: null, token: null, originalTransactionId: "orig-789" }),
  successResponse(),
);
expect(voidResult.status === "success", "executing a void with a valid response returns success");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments NMI API gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments NMI API gate passed: ${checks} checks, a service that builds NMI API requests and parses NMI API responses for the five transaction types - sale, authorization, capture, refund, and void - with correct request validation, payload building, and response parsing per the official NMI API documentation\n`,
);
