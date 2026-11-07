// path: services/payments/refund-nmi.ts
import {
  buildNmiRequest,
  executeNmiTransaction,
  type NmiTransactionRequest,
} from "../../lib/payments/adapters/nmi-api.ts";
import {
  NMI_API_ENDPOINT,
  NMI_SANDBOX_API_ENDPOINT,
  nmiFetchTransport,
  type NmiHttpTransport,
} from "../../lib/payments/adapters/nmi-payment.ts";
import { REFUND_EXECUTION_RULES, failureDetailOf } from "./refund-execution-fields.ts";
import type {
  RefundProviderOutcome,
  RefundProviderPort,
  RefundProviderTarget,
} from "./refund-provider.ts";

/**
 * NMI's refund path: the one provider whose adapter already speaks a refund transaction.
 *
 * ## What is reused, and what is not
 *
 * `lib/payments/adapters/nmi-api.ts` owns NMI's request shape and its answer: `buildNmiRequest` writes the
 * form fields, `executeNmiTransaction` reads the query-string answer and answers success/failed/rejected, and
 * `type=refund` is one of the five transaction types it validates. `nmi-payment.ts` owns the transport and the
 * two endpoints. This module adds **no** NMI knowledge of its own - it composes those four pieces into the
 * refund port - which is why a change to NMI's request shape reaches this call without an edit here.
 *
 * ## Why a refund names the original transaction and nothing else
 *
 * NMI refunds the transaction it is given: `transactionid` is the id the sale returned, and the amount is
 * optional (absent means the whole of it). So the target's `providerReference` - `payments.provider_transaction_id`
 * - is the whole of the addressing, and the amount travels as dollars and cents. A token is refused for a
 * refund by `validateNmiRequest`, and a `void` is not a refund: it only works before settlement, which is a
 * different act with a different meaning in a merchant's books.
 *
 * ## What the five answers become
 *
 *   - the network accepted it and gave an id -> `succeeded` with that id. `refunds_provider_required_check`
 *     makes an id mandatory for a `succeeded` refund, so an acceptance without one is treated as `unanswered`
 *     rather than as a success the database would refuse anyway;
 *   - the network declined it -> `declined` with NMI's own code and message, cut to the 280 characters
 *     `refunds_failure_check` allows;
 *   - the request could not be built (a validation refusal from NMI's own validator) -> `not_sent` with the
 *     reason, because nothing was asked and nothing moved;
 *   - the transport failed, timed out or answered something this build cannot read -> `unanswered`, because a
 *     call that did not come back may still have moved money and calling it failed would be a lie;
 *   - no usable key -> `not_sent` with `refund_provider_key_missing`, which is a configuration the desk can
 *     fix and retry.
 *
 * ## Why a `pending` cannot come from here
 *
 * NMI's classic transaction API answers the outcome of the refund in the same response; it has no "we will
 * tell you later" for a refund. The port therefore never answers `pending`, and the type keeps the shape
 * because the next provider this build adds may.
 */

/** The secret a refund call needs: NMI's private security key for the mode the payment was taken in. */
export interface NmiRefundSecret {
  readonly secretKey: string;
}

/**
 * Where the secret comes from.
 *
 * `null` is "no usable key for this provider and mode", which is a refusal with a rule rather than an
 * exception: the runtime reads `provider_keys` and opens the sealed box, and the gate replaces it with a
 * literal so the port can be proved without a database or a cipher.
 */
export type NmiRefundSecretPort = (
  target: RefundProviderTarget,
) => Promise<NmiRefundSecret | null>;

export interface NmiRefundPortOptions {
  readonly secret: NmiRefundSecretPort;
  /** The request transport. Defaults to the adapter's real one; the gate passes a recording fake. */
  readonly transport?: NmiHttpTransport;
  /** The endpoint for a mode. Defaults to NMI's live endpoint for `live` and its sandbox for `test`. */
  readonly endpointFor?: (mode: "test" | "live") => string;
}

/** The endpoint pair, as `nmi-payment.ts` declares it: sandbox for test, live for live. */
function defaultEndpointFor(mode: "test" | "live"): string {
  return mode === "live" ? NMI_API_ENDPOINT : NMI_SANDBOX_API_ENDPOINT;
}

/**
 * Build the NMI refund port.
 *
 * The order of the checks is the order that costs least: the secret (no network), the request (no network -
 * `buildNmiRequest` throws when NMI's own validator refuses it, and this turns that into `not_sent`), then the
 * call. The transport is wrapped so that **any** failure becomes `unanswered`: an exception thrown out of here
 * would be an `INTERNAL_ERROR` on the desk's screen and, worse, would leave the row `processing` with no
 * explanation in the chain.
 */
export function createNmiRefundPort(options: NmiRefundPortOptions): RefundProviderPort {
  const transport = options.transport ?? nmiFetchTransport;
  const endpointFor = options.endpointFor ?? defaultEndpointFor;

  return async (target: RefundProviderTarget): Promise<RefundProviderOutcome> => {
    const secret = await options.secret(target);

    if (secret === null || secret.secretKey.trim().length === 0) {
      return {
        kind: "not_sent",
        rule: REFUND_EXECUTION_RULES.credentialMissing,
        detail: "No active NMI security key for the mode this payment was taken in.",
      };
    }

    const request: NmiTransactionRequest = {
      type: "refund",
      // A public tokenization key is never sent with a refund: `buildNmiRequest` writes the security key and
      // the original transaction, and `validateNmiRequest` refuses a token on anything but a sale or an auth.
      apiKey: "",
      secretKey: secret.secretKey,
      amount: target.providerAmount,
      token: null,
      customerId: null,
      reference: target.refundId,
      originalTransactionId: target.providerReference,
      capture: false,
    };

    let payload: Record<string, string>;

    try {
      payload = buildNmiRequest(request);
    } catch (error) {
      return {
        kind: "not_sent",
        rule: REFUND_EXECUTION_RULES.providerRefused,
        detail: failureDetailOf(
          error instanceof Error ? error.message : "",
          "NMI refused the refund request before it was sent.",
        ),
      };
    }

    let raw: Record<string, string>;

    try {
      raw = await transport(endpointFor(target.mode), payload);
    } catch (error) {
      return {
        kind: "unanswered",
        detail: failureDetailOf(
          error instanceof Error ? error.message : "",
          "The provider did not answer the refund request.",
        ),
      };
    }

    const result = executeNmiTransaction(request, raw);

    if (result.status === "success") {
      return result.transactionId.trim().length === 0
        ? {
            kind: "unanswered",
            detail: "The provider accepted the refund without an identifier for it.",
          }
        : { kind: "succeeded", providerRefundId: result.transactionId.trim() };
    }

    if (result.status === "failed") {
      return {
        kind: "declined",
        detail: failureDetailOf(
          `${result.responseCode} ${result.responseMessage}`.trim(),
          "The provider declined the refund.",
        ),
      };
    }

    return {
      kind: "not_sent",
      rule: REFUND_EXECUTION_RULES.providerRefused,
      detail: failureDetailOf(result.reason, "The provider refused the refund request."),
    };
  };
}
