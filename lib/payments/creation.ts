// path: lib/payments/creation.ts

/**
 * The payment creation service: the one place a payment is made, and the idempotency key that makes it
 * one payment no matter how many times the request arrives.
 *
 * ## What creation is
 *
 * A payment asks for an amount, a capability and an idempotency key. The service routes it (STEP 129
 * decides which provider), creates the payment record, and stores it. The record is the fact the ledger
 * (STEP 131+), the settlement and the reconciliation read; this service is where the fact is made.
 *
 * ## Why the idempotency key is the heart of it
 *
 * Section 1 of the feature list says "idempotency key on every payment", and the master prompt says the
 * same. A payment request can arrive twice - a double-submitted form, a retried webhook, a client that
 * did not read the answer - and the platform must answer with the payment it already made, not make it
 * again. The key is the answer: the service looks the key up first, and when the key is one it has seen,
 * it returns the payment that key produced. When the key is one it has seen *with different details*, it
 * refuses: the same key carrying a different amount is not a retry, it is a mistake, and the refusal is
 * the `IDEMPOTENCY_CONFLICT` the error vocabulary already holds.
 *
 * ## The flow
 *
 * 1. Look the key up. A key this company has used returns the payment it produced; a new key returns
 *    null and the service goes on.
 * 2. Route the payment. The routing engine answers the provider, and a payment with no matching rule is
 *    rejected here - the same rejection STEP 129 made, reached through this service.
 * 3. Create the payment and store it. The store is the caller's: this service owns the decision, the
 *    caller owns the database.
 *
 * ## What this file is not
 *
 * It is not the ledger. It creates a payment record; it does not post the debit and credit that move the
 * money. That is STEP 131's business, and the record this service makes is what that STEP reads. It is
 * also not the API route: the route validates the request, reads the store and calls this function. This
 * file is the decision and the idempotency, not the request handling.
 */

import { randomUUID } from "node:crypto";
import { routePayment, type RoutingRule } from "./routing.ts";
import type { ProviderCapability, ProviderKey } from "./registry.ts";

/** What a payment asks for: the amount, the capability, and the idempotency key that makes it one. */
export interface PaymentRequest {
  /** The company the payment belongs to. The idempotency key is scoped to the company. */
  readonly companyId: string;
  /** The amount in minor units, at the platform's four-decimal scale. Must be positive. */
  readonly amountMinor: bigint;
  /** The capability the payment needs: a charge, a payout, or a connected account. */
  readonly capability: ProviderCapability;
  /** The payment method, when the routing rules narrow on one. */
  readonly method?: string;
  /** The country, when the routing rules narrow on one. */
  readonly country?: string;
  /** The idempotency key. The same key from the same company returns the same payment. */
  readonly idempotencyKey: string;
}

/** A payment the platform has created: the record the ledger, the settlement and the reconciliation read. */
export interface Payment {
  /** The payment's own identifier. */
  readonly id: string;
  /** The company the payment belongs to. */
  readonly companyId: string;
  /** The exact amount in minor units. */
  readonly amountMinor: bigint;
  /** The capability the payment asked for. */
  readonly capability: ProviderCapability;
  /** The provider the routing engine routed the payment to. */
  readonly providerKey: ProviderKey;
  /** The idempotency key that produced this payment. */
  readonly idempotencyKey: string;
  /** The payment's status. A payment this service creates is `created`. */
  readonly status: "created";
}

/**
 * What the service reads and writes: the payments it has created.
 *
 * The store is the caller's - the database implementation, or the in-memory store below. This service
 * owns the decision (deduplicate, refuse, or create); the store owns the storage.
 */
export interface PaymentStore {
  /** The payment a company's idempotency key already produced, or null when the key is new. */
  findByIdempotencyKey(companyId: string, idempotencyKey: string): Payment | null;
  /** Store the payment a key produced. */
  insert(payment: Payment): void;
}

/** The result of a payment creation attempt: a new payment, the payment a key already produced, or a refusal. */
export type PaymentCreationResult =
  | { readonly status: "created"; readonly payment: Payment }
  | { readonly status: "deduplicated"; readonly payment: Payment }
  | { readonly status: "rejected"; readonly reason: string };

/**
 * An in-memory payment store, for the gate and for a service before the database exists.
 *
 * The idempotency key is scoped to the company, so the store keys on the company and the key together:
 * the same key from two companies is two different keys, which is what the database's
 * `idempotency_keys (company_id, scope, key_hash)` index says too.
 */
export class InMemoryPaymentStore implements PaymentStore {
  private readonly payments = new Map<string, Payment>();
  private readonly keys = new Map<string, string>();

  findByIdempotencyKey(companyId: string, idempotencyKey: string): Payment | null {
    const id = this.keys.get(this.compoundKey(companyId, idempotencyKey));

    return id === undefined ? null : (this.payments.get(id) ?? null);
  }

  insert(payment: Payment): void {
    this.payments.set(payment.id, payment);
    this.keys.set(this.compoundKey(payment.companyId, payment.idempotencyKey), payment.id);
  }

  private compoundKey(companyId: string, idempotencyKey: string): string {
    return `${companyId}:${idempotencyKey}`;
  }
}

/**
 * Create a payment, idempotently.
 *
 * The key is looked up first: a key this company has used returns the payment it produced, when the
 * request matches it, and refuses when the request does not. A new key routes the payment, creates it
 * and stores it. A payment whose routing rules say nothing about it is rejected, the same rejection
 * STEP 129 made.
 */
export function createPayment(
  request: PaymentRequest,
  options: {
    readonly routingRules: readonly RoutingRule[];
    readonly store: PaymentStore;
  },
): PaymentCreationResult {
  if (request.amountMinor <= 0n) {
    return { status: "rejected", reason: "the payment amount must be positive" };
  }

  // 1. The idempotency key. A key this company has used answers with the payment it produced.
  const existing = options.store.findByIdempotencyKey(request.companyId, request.idempotencyKey);

  if (existing !== null) {
    if (existing.amountMinor === request.amountMinor && existing.capability === request.capability) {
      return { status: "deduplicated", payment: existing };
    }

    return { status: "rejected", reason: "the idempotency key was already used with different details" };
  }

  // 2. The routing. A payment with no matching rule is rejected here, not sent anywhere.
  const decision = routePayment(
    {
      capability: request.capability,
      ...(request.method !== undefined ? { method: request.method } : {}),
      ...(request.country !== undefined ? { country: request.country } : {}),
    },
    options.routingRules,
  );

  if (!decision.matched) {
    return { status: "rejected", reason: decision.reason };
  }

  // 3. The payment. The record is what the ledger, the settlement and the reconciliation read.
  const payment: Payment = {
    id: randomUUID(),
    companyId: request.companyId,
    amountMinor: request.amountMinor,
    capability: request.capability,
    providerKey: decision.providerKey,
    idempotencyKey: request.idempotencyKey,
    status: "created",
  };

  options.store.insert(payment);

  return { status: "created", payment };
}
