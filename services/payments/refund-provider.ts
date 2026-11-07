// path: services/payments/refund-provider.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { PROVIDER_KEYS, type ProviderKey } from "../../lib/payments/registry.ts";

/**
 * The port a provider implements to give money back, and the registry of the ones this build has.
 *
 * ## Why the port is a function and not an adapter class
 *
 * Every provider STEP in this repository ends at the same seam: a port the core defines, an adapter that
 * implements it, and a runtime that wires the one to the other. `lib/payments/payout-execution.ts` states the
 * shape for a payout - `ProviderPayoutFn`, a store, and a service that records what happened - and this STEP
 * is the refund's version of exactly that. A class would let an adapter hold state that survives one call and
 * leaks into the next; a function cannot.
 *
 * ## What "the originating provider" means here
 *
 * `0037` records the route each payment took: `provider_id` (a row of `payment_providers`),
 * `provider_key_id` (the exact key that signed the call) and `mode` (`test` or `live`). A refund is not
 * routed - it goes back the way the money came - so this module receives that route as data and never asks
 * the routing engine anything. The `RefundProviderTarget` below is the whole of it: what came in, from whom,
 * for how much, and under which mode.
 *
 * ## Why the registry is a partial record rather than a list of five
 *
 * The gateways registry names five providers, and `payment_providers` seeds the same five. Only one of them
 * has a refund path in this build (NMI's `type=refund` transaction, `lib/payments/adapters/nmi-api.ts`), so
 * `REFUNDING_PROVIDER_KEYS` is one long and the other four are a stated gap: a refund of a Stripe, Airwallex,
 * Rainforest or Payoneer payment is refused with `refund_provider_unsupported` **before** any status moves,
 * which leaves the refund `approved` and the merchant's money untouched. Adding the next provider is one
 * factory and one entry in the record; nothing else in this STEP changes.
 */

/** The modes `0037` and `0029` share: a test payment is refunded in the test mode it was taken in. */
export type RefundProviderMode = "test" | "live";

/**
 * What a provider is asked to refund.
 *
 * Every field is a fact from the payment or the refund row; none of them is derived here. `providerAmount` is
 * the amount in the provider's own minor unit (hundredths), already converted and already refused when it
 * could not be expressed - so an adapter never formats money.
 */
export interface RefundProviderTarget {
  readonly refundId: string;
  readonly paymentId: string;
  readonly companyId: string;
  readonly providerKey: ProviderKey;
  /** The `payment_providers` row the payment points at: the registry's own identifier for the provider. */
  readonly providerId: string;
  readonly mode: RefundProviderMode;
  /** The provider's identifier for the original payment: the thing a refund names. */
  readonly providerReference: string;
  /** The refund, in the platform's minor unit (ten-thousandths). */
  readonly amountMinor: bigint;
  /** The same amount in the provider's minor unit (hundredths), as the networks write it. */
  readonly providerAmount: string;
  readonly currency: string;
  /** The key row that signed the original call, when `0037` recorded one. */
  readonly providerKeyId: string | null;
}

/**
 * What a provider answers.
 *
 * The five shapes are the five answers a network can really give, and `refund-execution-fields.ts` explains
 * which status each one leaves the row in. None of them is an exception: a refusal from a provider is data,
 * and only a defect in this code may throw.
 */
export type RefundProviderOutcome =
  | { readonly kind: "succeeded"; readonly providerRefundId: string }
  | { readonly kind: "declined"; readonly detail: string }
  | { readonly kind: "pending"; readonly providerRefundId: string | null }
  | { readonly kind: "unanswered"; readonly detail: string }
  | { readonly kind: "not_sent"; readonly rule: string; readonly detail: string };

/** The port: one call, one answer, no exceptions. */
export type RefundProviderPort = (target: RefundProviderTarget) => Promise<RefundProviderOutcome>;

/** The providers this build can refund through, as a frozen list the gate can compare with the seed. */
export const REFUNDING_PROVIDER_KEYS: readonly ProviderKey[] = deepFreeze(["nmi"]);

/** The ports, by provider. A provider that is absent cannot execute a refund here. */
export type RefundProviderPorts = Readonly<Partial<Record<ProviderKey, RefundProviderPort>>>;

/**
 * The port for one provider, or null when this build has none.
 *
 * Null is the answer that becomes `refund_provider_unsupported`: a payment taken through a provider this build
 * cannot refund through is a refund the desk must handle outside the platform, and saying so is better than
 * pretending a row moved.
 */
export function refundPortOf(
  ports: RefundProviderPorts,
  providerKey: string,
): RefundProviderPort | null {
  if (!(PROVIDER_KEYS as readonly string[]).includes(providerKey)) {
    return null;
  }

  return ports[providerKey as ProviderKey] ?? null;
}

/** True when a value is one of the providers this build can refund through. */
export function isRefundingProvider(providerKey: string): boolean {
  return (REFUNDING_PROVIDER_KEYS as readonly string[]).includes(providerKey);
}
