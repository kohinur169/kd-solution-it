// path: lib/payments/adapters/nmi-payment.ts
/** NMI Classic Payment API, using Collect.js tokens. Do not retry ambiguous outcomes blindly.
 * https://docs.nmi.com/reference/transactions-processing
 * https://docs.nmi.com/docs/payment-code-examples
 * Sandbox: https://sandbox.nmi.com/api/transact.php
 */
import { buildNmiRequest, parseNmiResponse, validateNmiRequest, type NmiTransactionRequest, type NmiTransactionType } from "./nmi-api.ts";
import { decryptKey, type NmiKeyStore } from "./nmi-client.ts";

export const NMI_API_ENDPOINT = "https://secure.nmi.com/api/transact.php";
export const NMI_SANDBOX_API_ENDPOINT = "https://sandbox.nmi.com/api/transact.php";
export interface NmiPaymentRequest {
  readonly companyId: string;
  readonly type: NmiTransactionType;
  readonly amount: string | null;
  readonly token: string | null;
  readonly customerId: string | null;
  readonly reference: string | null;
  readonly originalTransactionId: string | null;
  readonly capture: boolean;
}
export type NmiHttpTransport = (endpoint: string, payload: Record<string, string>) => Promise<Record<string, string>>;
export type ProcessNmiPaymentResult =
  | { status: "success"; transactionId: string; authCode: string | null; amount: string }
  | { status: "failed"; responseCode: string; responseMessage: string }
  | { status: "rejected"; reason: string }
  | { status: "transport_error"; message: string };
export interface ProcessNmiPaymentOptions {
  readonly store: NmiKeyStore;
  readonly encryptionKey: string;
  readonly transport?: NmiHttpTransport;
  readonly occurredAtEpochMs: number;
}

/** Posts URL encoded data; a non-2xx response or malformed/duplicate fields is ambiguous. */
export const nmiFetchTransport: NmiHttpTransport = async (endpoint, payload) => {
  if (endpoint !== NMI_API_ENDPOINT && endpoint !== NMI_SANDBOX_API_ENDPOINT) throw new Error("invalid endpoint");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(payload).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("NMI HTTP error");
  const text = await response.text();
  if (!text || text.length > 65_536) throw new Error("invalid response");
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URLSearchParams(text)) {
    if (Object.hasOwn(result, key)) throw new Error("duplicate response field");
    result[key] = value;
  }
  return result;
};

export async function processNmiPayment(input: NmiPaymentRequest, options: ProcessNmiPaymentOptions): Promise<ProcessNmiPaymentResult> {
  const config = options.store.findActiveByCompany(input.companyId);
  if (config === null) return { status: "rejected", reason: "no NMI key configuration exists for this company" };
  let apiKey: string;
  let secretKey: string;
  try {
    apiKey = decryptKey(config.apiKeyEncrypted, options.encryptionKey);
    secretKey = decryptKey(config.secretKeyEncrypted, options.encryptionKey);
  } catch {
    return { status: "failed", responseCode: "decryption_error", responseMessage: "failed to decrypt the stored NMI keys" };
  }
  const transactionRequest: NmiTransactionRequest = { ...input, apiKey, secretKey };
  const validation = validateNmiRequest(transactionRequest);
  if (validation.status === "rejected") return validation;
  let raw: Record<string, string>;
  try {
    raw = await (options.transport ?? nmiFetchTransport)(
      config.environment === "sandbox" ? NMI_SANDBOX_API_ENDPOINT : NMI_API_ENDPOINT,
      buildNmiRequest(transactionRequest),
    );
  } catch {
    // A timeout or lost response may follow a successful charge. Never reveal transport errors or credentials.
    return { status: "transport_error", message: "NMI outcome unknown; reconcile before retrying" };
  }
  if (!(["1", "2", "3"].includes(raw["response"] ?? "")) || (raw["response"] === "1" && !raw["transactionid"]?.trim())) {
    return { status: "transport_error", message: "NMI outcome unknown; reconcile before retrying" };
  }
  const response = parseNmiResponse(raw);
  if (!response.success) return { status: "failed", responseCode: response.responseCode, responseMessage: response.responseMessage };
  return { status: "success", transactionId: response.transactionId, authCode: response.authCode, amount: response.amount };
}
