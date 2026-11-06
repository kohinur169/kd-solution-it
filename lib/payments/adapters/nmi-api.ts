// path: lib/payments/adapters/nmi-api.ts
/** NMI Classic Payment API (form-encoded requests and query-string responses).
 * https://docs.nmi.com/reference/transactions-processing
 * https://docs.nmi.com/docs/payment-code-examples
 * Sandbox: https://sandbox.nmi.com/api/transact.php
 */
import { validateCollectJsToken } from "./nmi-collectjs.ts";

export type NmiTransactionType = "sale" | "authorization" | "capture" | "refund" | "void";
export interface NmiTransactionRequest {
  readonly type: NmiTransactionType;
  /** Public tokenization key; never sent as a private API credential. */
  readonly apiKey: string;
  /** Private NMI API security key. */
  readonly secretKey: string;
  readonly amount: string | null;
  readonly token: string | null;
  readonly customerId: string | null;
  readonly reference: string | null;
  readonly originalTransactionId: string | null;
  readonly capture: boolean;
}
export type ValidateNmiRequestResult = { status: "valid" } | { status: "rejected"; reason: string };

export function validateNmiRequest(input: NmiTransactionRequest): ValidateNmiRequestResult {
  if (!input.secretKey.trim()) return { status: "rejected", reason: "the API security key must not be empty" };
  if (!["sale", "authorization", "capture", "refund", "void"].includes(input.type)) {
    return { status: "rejected", reason: "unknown transaction type" };
  }
  if (input.capture) return { status: "rejected", reason: "use a sale for immediate capture" };
  // A platform customer ID is not necessarily an NMI vault ID. Never substitute it for a token.
  if (input.customerId !== null) return { status: "rejected", reason: "customer vault transactions are not supported" };
  if (input.amount !== null && (!/^(?:0|[1-9]\d*)\.\d{2}$/.test(input.amount) || !/[1-9]/.test(input.amount))) {
    return { status: "rejected", reason: "amount must be positive and formatted as dollars and cents" };
  }
  if (input.type === "sale" || input.type === "authorization") {
    if (input.amount === null) return { status: "rejected", reason: "amount is required" };
    if (input.token === null || validateCollectJsToken(input.token, "card").status !== "valid") {
      return { status: "rejected", reason: "a valid payment token is required" };
    }
    if (input.originalTransactionId !== null) return { status: "rejected", reason: "original transaction id is not allowed" };
  } else {
    if (!input.originalTransactionId?.trim()) return { status: "rejected", reason: "original transaction id is required" };
    if (input.token !== null) return { status: "rejected", reason: "payment token is not allowed for this transaction" };
    if (input.type === "void" && input.amount !== null) return { status: "rejected", reason: "amount is not allowed for void" };
  }
  return { status: "valid" };
}

export function buildNmiRequest(input: NmiTransactionRequest): Record<string, string> {
  const validation = validateNmiRequest(input);
  if (validation.status === "rejected") throw new Error(validation.reason);
  const payload: Record<string, string> = {
    security_key: input.secretKey,
    type: input.type === "authorization" ? "auth" : input.type,
  };
  if (input.amount !== null) payload["amount"] = input.amount;
  if (input.token !== null) payload["payment_token"] = input.token;
  if (input.originalTransactionId !== null) payload["transactionid"] = input.originalTransactionId;
  if (input.reference !== null) payload["orderid"] = input.reference;
  return payload;
}

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
export function parseNmiResponse(raw: Record<string, string>): NmiApiResponse {
  return {
    success: raw["response"] === "1" && !!raw["transactionid"]?.trim(),
    responseCode: raw["response_code"] ?? "",
    responseMessage: raw["responsetext"] ?? "",
    transactionId: raw["transactionid"] ?? "",
    amount: raw["amount"] ?? "",
    authCode: raw["authcode"] || null,
    avsResultCode: raw["avsresponse"] || null,
    cvvResultCode: raw["cvvresponse"] || null,
  };
}
export type NmiTransactionResult =
  | { status: "success"; transactionId: string; authCode: string | null; amount: string }
  | { status: "failed"; responseCode: string; responseMessage: string }
  | { status: "rejected"; reason: string };
export function executeNmiTransaction(input: NmiTransactionRequest, rawResponse: Record<string, string>): NmiTransactionResult {
  const validation = validateNmiRequest(input);
  if (validation.status === "rejected") return validation;
  const response = parseNmiResponse(rawResponse);
  if (!response.success) return { status: "failed", responseCode: response.responseCode, responseMessage: response.responseMessage };
  return { status: "success", transactionId: response.transactionId, authCode: response.authCode, amount: response.amount };
}
