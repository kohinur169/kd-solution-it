// path: lib/payments/adapters/nmi-payment.ts

/**
 * The NMI adapter's shared server payment module: the service that exchanges a Collect.js token for a
 * payment through the NMI API.
 *
 * ## What the payment module does
 *
 * When the frontend has collected card data through Collect.js (STEP 149) and received a payment
 * token, the server sends that token to NMI's API to charge the card. This module is the server-side
 * piece that:
 *
 * 1. Resolves the company's NMI API credentials from the key store (STEP 148).
 * 2. Builds the NMI API request (STEP 150's buildNmiRequest).
 * 3. Sends the request to NMI's API endpoint (HTTP transport).
 * 4. Parses the response (STEP 150's parseNmiResponse).
 * 5. Returns the result.
 *
 * ## What the NMI API expects
 *
 * The NMI API documentation says transactions are submitted to the v1 transactions endpoint as a
 * POST with `application/x-www-form-urlencoded` content type. The request includes the API key,
 * secret key, transaction type, amount, and token. The response is JSON with a response code where
 * "0" means success.
 *
 * ## What this file is not
 *
 * It is not the NMI API transaction types (STEP 150 owns that — this file uses it). It is not the
 * Collect.js token generation (STEP 149 owns that — this file receives the token). It is not the key
 * configuration (STEP 148 owns that — this file reads from the key store). This file is the shared
 * server payment module: the glue between the key store, the transaction types, and the HTTP transport.
 */

import {
  buildNmiRequest,
  parseNmiResponse,
  validateNmiRequest,
  type NmiTransactionRequest,
  type NmiTransactionType,
} from "./nmi-api.ts";
import { decryptKey, type NmiKeyStore } from "./nmi-client.ts";

/** The NMI API endpoint for submitting transactions (v1 API, per the official NMI documentation). */
export const NMI_API_ENDPOINT = "https://api.nmi.com/api/v1/transactions";

/** A payment request to the NMI shared server payment module. */
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

/** The HTTP transport function: sends the NMI API request and returns the raw response as a field map. */
export type NmiHttpTransport = (
  endpoint: string,
  payload: Record<string, string>,
) => Record<string, string>;

/** The result of processing a NMI payment. */
export type ProcessNmiPaymentResult =
  | { status: "success"; transactionId: string; authCode: string | null; amount: string }
  | { status: "failed"; responseCode: string; responseMessage: string }
  | { status: "rejected"; reason: string }
  | { status: "transport_error"; message: string };

/** The options for processing a NMI payment. */
export interface ProcessNmiPaymentOptions {
  readonly store: NmiKeyStore;
  readonly encryptionKey: string;
  readonly transport: NmiHttpTransport;
  readonly occurredAtEpochMs: number;
}

/**
 * Process a NMI payment: resolve the company's NMI API credentials from the key store, build the
 * NMI API request, send it to NMI's API endpoint, parse the response, and return the result.
 *
 * The flow is:
 * 1. Find the active key configuration for the company (rejected if not found).
 * 2. Decrypt the API keys (failed if decryption fails).
 * 3. Build the NmiTransactionRequest from the payment request and decrypted keys.
 * 4. Validate the request (rejected if invalid).
 * 5. Build the NMI API payload.
 * 6. Send the request via the HTTP transport (transport_error if the transport throws).
 * 7. Parse the response (success or failed based on the response code).
 */
export function processNmiPayment(
  input: NmiPaymentRequest,
  options: ProcessNmiPaymentOptions,
): ProcessNmiPaymentResult {
  // 1. Find the active key configuration for the company.
  const config = options.store.findActiveByCompany(input.companyId);
  if (config === null) {
    return { status: "rejected", reason: "no NMI key configuration exists for this company" };
  }

  // 2. Decrypt the API keys.
  let apiKey: string;
  let secretKey: string;
  try {
    apiKey = decryptKey(config.apiKeyEncrypted, options.encryptionKey);
    secretKey = decryptKey(config.secretKeyEncrypted, options.encryptionKey);
  } catch {
    return {
      status: "failed",
      responseCode: "decryption_error",
      responseMessage: "failed to decrypt the stored NMI keys",
    };
  }

  // 3. Build the NMI transaction request from the payment request and decrypted keys.
  const transactionRequest: NmiTransactionRequest = {
    type: input.type,
    apiKey,
    secretKey,
    amount: input.amount,
    token: input.token,
    customerId: input.customerId,
    reference: input.reference,
    originalTransactionId: input.originalTransactionId,
    capture: input.capture,
  };

  // 4. Validate the request before sending it.
  const validation = validateNmiRequest(transactionRequest);
  if (validation.status === "rejected") {
    return { status: "rejected", reason: validation.reason };
  }

  // 5. Build the NMI API payload.
  const payload = buildNmiRequest(transactionRequest);

  // 6. Send the request via the HTTP transport.
  let rawResponse: Record<string, string>;
  try {
    rawResponse = options.transport(NMI_API_ENDPOINT, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "transport_error", message: `failed to send the request to NMI's API: ${message}` };
  }

  // 7. Parse the response.
  const response = parseNmiResponse(rawResponse);

  // 8. Return the result based on the response code.
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
