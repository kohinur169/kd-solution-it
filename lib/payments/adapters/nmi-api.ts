// path: lib/payments/adapters/nmi-api.ts

/**
 * The NMI adapter's API transaction types: the service that builds NMI API requests and parses NMI API
 * responses for the five transaction types — sale, authorization, capture, refund, and void.
 *
 * ## What the transaction types are
 *
 * The NMI API supports five transaction types, each with its own request shape:
 *
 * - **sale**: Charge a card. Authorization and capture in one step. Requires amount and token.
 * - **authorization**: Authorize a card without capturing. Requires amount and token. The `capture` flag
 *   controls whether the authorization is captured immediately.
 * - **capture**: Capture a previously authorized transaction. Requires the original transaction id.
 * - **refund**: Refund a previously captured transaction. Requires the original transaction id.
 * - **void**: Void a previously authorized transaction. Requires the original transaction id.
 *
 * ## What this file is not
 *
 * It is not the HTTP transport that sends the request to NMI's API (STEP 151 owns that). It is not the
 * Collect.js token integration (STEP 149 owns that — this file receives the token). It is not the key
 * configuration (STEP 148 owns that). This file is the core service: the request building, the response
 * parsing, and the request validation.
 */

/** The five NMI API transaction types. */
export type NmiTransactionType = "sale" | "authorization" | "capture" | "refund" | "void";

/** The transaction types that require a card token (sale and authorization). */
const TOKEN_REQUIRED_TYPES: Set<NmiTransactionType> = new Set(["sale", "authorization"]);

/** The transaction types that require an original transaction id (capture, refund, void). */
const ORIGINAL_ID_REQUIRED_TYPES: Set<NmiTransactionType> = new Set(["capture", "refund", "void"]);

/** A NMI API transaction request. */
export interface NmiTransactionRequest {
  readonly type: NmiTransactionType;
  readonly apiKey: string;
  readonly secretKey: string;
  readonly amount: string | null;
  readonly token: string | null;
  readonly customerId: string | null;
  readonly reference: string | null;
  readonly originalTransactionId: string | null;
  readonly capture: boolean;
}

/** The result of validating a NMI transaction request. */
export type ValidateNmiRequestResult =
  | { status: "valid" }
  | { status: "rejected"; reason: string };

/** Validate a NMI transaction request: check required fields for the transaction type. */
export function validateNmiRequest(input: NmiTransactionRequest): ValidateNmiRequestResult {
  // 1. API key and secret key are always required.
  if (input.apiKey.trim().length === 0) {
    return { status: "rejected", reason: "the API key must not be empty" };
  }
  if (input.secretKey.trim().length === 0) {
    return { status: "rejected", reason: "the secret key must not be empty" };
  }

  // 2. Sale and authorization require an amount and a token.
  if (TOKEN_REQUIRED_TYPES.has(input.type)) {
    if (input.amount === null || input.amount.trim().length === 0) {
      return { status: "rejected", reason: `a ${input.type} transaction requires an amount` };
    }
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { status: "rejected", reason: "the amount must be a positive number" };
    }
    if (input.token === null || input.token.trim().length === 0) {
      return { status: "rejected", reason: `a ${input.type} transaction requires a token` };
    }
  }

  // 3. Capture, refund, and void require an original transaction id.
  if (ORIGINAL_ID_REQUIRED_TYPES.has(input.type)) {
    if (input.originalTransactionId === null || input.originalTransactionId.trim().length === 0) {
      return { status: "rejected", reason: `a ${input.type} transaction requires an original transaction id` };
    }
  }

  return { status: "valid" };
}

/** Build a NMI API request payload: the form-encoded fields the NMI API expects. */
export function buildNmiRequest(input: NmiTransactionRequest): Record<string, string> {
  const payload: Record<string, string> = {
    api_key: input.apiKey,
    secret_key: input.secretKey,
    type: input.type,
  };

  // Amount and token for sale and authorization.
  if (TOKEN_REQUIRED_TYPES.has(input.type)) {
    payload["amount"] = input.amount ?? "";
    payload["token"] = input.token ?? "";
  }

  // Amount is optional for capture and refund (defaults to full amount on the NMI side).
  if (input.type === "capture" || input.type === "refund") {
    if (input.amount !== null && input.amount.trim().length > 0) {
      payload["amount"] = input.amount;
    }
  }

  // Original transaction id for capture, refund, and void.
  if (input.originalTransactionId !== null) {
    payload["original_transaction_id"] = input.originalTransactionId;
  }

  // Optional fields.
  if (input.customerId !== null) {
    payload["customer_id"] = input.customerId;
  }
  if (input.reference !== null) {
    payload["reference"] = input.reference;
  }

  // Capture flag for authorization.
  if (input.type === "authorization") {
    payload["capture"] = input.capture ? "true" : "false";
  }

  return payload;
}

/** A parsed NMI API response. */
export interface NmiApiResponse {
  readonly success: boolean;
  readonly responseCode: string;
  readonly responseMessage: string;
  readonly transactionId: string;
  readonly amount: string;
  readonly authCode: string | null;
  readonly avsResultCode: string | null;
  readonly cvvResultCode: string | null;
}

/** Parse a raw NMI API response (form-encoded or JSON object) into a structured response. */
export function parseNmiResponse(raw: Record<string, string>): NmiApiResponse {
  return {
    success: raw["response_code"] === "0",
    responseCode: raw["response_code"] ?? "",
    responseMessage: raw["response_message"] ?? "",
    transactionId: raw["transaction_id"] ?? "",
    amount: raw["amount"] ?? "",
    authCode: raw["auth_code"] ?? null,
    avsResultCode: raw["avs_result_code"] ?? null,
    cvvResultCode: raw["cvv_result_code"] ?? null,
  };
}

/** The result of executing a NMI transaction (validated request + parsed response). */
export type NmiTransactionResult =
  | { status: "success"; transactionId: string; authCode: string | null; amount: string }
  | { status: "failed"; responseCode: string; responseMessage: string }
  | { status: "rejected"; reason: string };

/** Execute a NMI transaction: validate the request, build the payload, parse the response. */
export function executeNmiTransaction(
  input: NmiTransactionRequest,
  rawResponse: Record<string, string>,
): NmiTransactionResult {
  // 1. Validate the request.
  const validation = validateNmiRequest(input);
  if (validation.status === "rejected") {
    return { status: "rejected", reason: validation.reason };
  }

  // 2. Build the request payload.
  buildNmiRequest(input);

  // 3. Parse the response.
  const response = parseNmiResponse(rawResponse);

  if (!response.success) {
    return {
      status: "failed",
      responseCode: response.responseCode,
      responseMessage: response.responseMessage,
    };
  }

  return {
    status: "success",
    transactionId: response.transactionId,
    authCode: response.authCode,
    amount: response.amount,
  };
}
