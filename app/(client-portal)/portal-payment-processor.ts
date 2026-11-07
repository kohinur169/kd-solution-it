// path: app/(client-portal)/portal-payment-processor.ts
import { randomUUID } from "node:crypto";
import { processNmiPayment, type NmiHttpTransport } from "../../lib/payments/adapters/nmi-payment.ts";
import type { NmiKeyStore } from "../../lib/payments/adapters/nmi-client.ts";
import { DEFAULT_ROUTING_RULES, routePayment, type RoutingRule } from "../../lib/payments/routing.ts";
import {
  PORTAL_PAYMENT_CAPABILITY,
  PORTAL_PAYMENT_METHOD,
  PORTAL_PAYMENT_PROVIDER,
} from "./portal-payment-fields.ts";
import {
  PORTAL_FRAUD_FAILURE_CODE,
  PORTAL_FRAUD_RULES,
  portalFraudDecisionOf,
  portalProviderFraudSignalOf,
} from "./portal-fraud-fields.ts";
import { PORTAL_BLACKLIST_SETTLED_CODE } from "./portal-blacklist-fields.ts";
import type { PortalBlacklistCheck } from "./portal-blacklist.ts";
import type { PortalVelocityCheck } from "./portal-velocity.ts";
import type {
  PortalChargeOutcome,
  PortalChargeRequest,
  PortalPaymentProcessor,
} from "./portal-payment.ts";

/**
 * The composition this page charges through: routing to a provider, a durable record, and the provider's
 * own execution.
 *
 * ## The three parts, and whose they are
 *
 *   1. **Routing** is STEP 129's `routePayment`, a pure function: it answers which provider a charge goes to,
 *      or that no rule matches it. A page that chose a provider itself would be a second routing engine.
 *   2. **The record** is the recorder below - the port this page needs and the one piece the platform does
 *      not yet have a durable implementation of. It writes the payment the charge produces, and it is the
 *      thing that makes a repeated attempt one payment instead of two.
 *   3. **The execution** is STEP 151's `processNmiPayment`: it exchanges the Collect.js token for a sale
 *      through NMI's Classic API, exactly as the provider's documentation describes, and it is the only
 *      code in the platform that talks to the gateway about a card.
 *
 * ## Why the record comes before the charge
 *
 * A payment that is charged and not recorded is money the platform cannot account for. So the record is
 * opened first and settled afterwards, and a process that dies between the two leaves a record that says
 * "opened, outcome unknown" - which is the truth, and which the reconciliation STEP reads. The reverse
 * order - charge, then hope a write lands - has no honest answer when the write fails.
 *
 * ## What this file never holds
 *
 * A card number, an expiry, a CVV or a keystroke. It holds a token, an amount, a key and the provider's
 * answer, which is the whole of what section 18 allows a platform to see.
 */

/** A payment record this page can open and settle. The durable implementation is the platform's, not this file's. */
export interface PortalPaymentRecorder {
  /**
   * True when a record this recorder writes survives the request.
   *
   * The in-memory recorder a gate uses is `false`; a database-backed one is `true`. The page refuses to
   * charge through a recorder that answers `false`, because a charge it cannot account for is worse than a
   * payment it did not take.
   */
  readonly durable: boolean;
  /** Open a record for one attempt, or answer the one the key already produced. */
  open(input: {
    readonly companyId: string;
    readonly invoiceId: string;
    readonly amountMinor: string;
    readonly chargeAmount: string;
    readonly idempotencyKey: string;
    readonly occurredAtEpochMs: number;
  }): PortalRecorderOpen;
  /** Settle an opened record with the outcome the provider gave. */
  settle(input: {
    readonly paymentId: string;
    /**
     * What happened to the payment. `failed` and `under_review` are STEP 186's additions: a payment the gateway
     * called fraudulent is a failed payment carrying `risk_rejected`, and one it asked the merchant to stop on
     * is held for review. Neither is a decline, and settling one as a decline would hide a risk decision behind
     * an ordinary refusal.
     */
    readonly outcome: "captured" | "declined" | "unknown" | "failed" | "under_review";
    readonly transactionId: string | null;
    readonly code: string | null;
    readonly occurredAtEpochMs: number;
  }): void;
}

/** What opening a record answered. */
export type PortalRecorderOpen =
  /** A fresh record: the charge may be sent. */
  | { readonly status: "opened"; readonly paymentId: string }
  /** The key already produced this record; nothing is charged again. */
  | {
      readonly status: "duplicate";
      readonly paymentId: string;
      readonly settled: "captured" | "declined" | "unknown" | "failed" | "under_review" | null;
      readonly transactionId: string | null;
      readonly code: string | null;
    }
  /** The recorder could not open a record, so nothing may be charged. */
  | { readonly status: "refused"; readonly reason: string };

/** What the composition needs to exist at all. */
export interface PortalPaymentProcessorOptions {
  readonly recorder: PortalPaymentRecorder;
  /** The provider's encrypted keys, by company: STEP 149/151's own store interface. */
  readonly keyStore: NmiKeyStore;
  /** The master key in the hex form `decryptKey` takes. */
  readonly encryptionKeyHex: string;
  /** The transport, when a caller overrides it. The provider's own `fetch` transport is the default. */
  readonly transport?: NmiHttpTransport;
  /**
   * STEP 187's list, asked before the gateway is: a card the platform already knows is refused without a
   * request leaving the server.
   *
   * Optional, because a page can be built without a list. Absent is not "clear" in production - the runtime
   * always wires the real one - but a gate that is about something else can leave it out.
   */
  readonly blacklist?: PortalBlacklistCheck | null;
  /**
   * STEP 188's counters, asked after the list and before a record is opened: an attempt that breaches a card or
   * address limit is traffic the page turns away, not a payment that failed.
   */
  readonly velocity?: PortalVelocityCheck | null;
  /** The routing rules a charge is decided by. The platform's starting set unless a caller says otherwise. */
  readonly routingRules?: readonly RoutingRule[];
}

/**
 * Build the payment operation this page charges through.
 *
 * The durable flag is the recorder's: an operation built on a recorder that cannot keep its records reports
 * itself as not durable, and `chargePortalPayment` refuses instead of charging.
 */
export function createPortalPaymentProcessor(
  options: PortalPaymentProcessorOptions,
): PortalPaymentProcessor {
  const routingRules = options.routingRules ?? DEFAULT_ROUTING_RULES;

  return {
    durable: options.recorder.durable,
    async charge(request: PortalChargeRequest): Promise<PortalChargeOutcome> {
      // STEP 187, before a record is opened or a request is built: the list is asked what it knows about this
      // card, and a list that cannot answer is a refusal rather than a pass.
      const blacklist = options.blacklist ?? null;
      const blocked = blacklist === null ? null : await blacklist.check({ token: request.token });

      if (blocked !== null && blocked.status === "unavailable") {
        return { status: "unavailable", reason: "blacklist" };
      }

      // STEP 188, second: one attempt is one hit on the card and one on the address, and a breach ends the
      // attempt here - before a payment record exists, because a limit is about traffic and not about money.
      const velocity = options.velocity ?? null;
      const counted =
        velocity === null
          ? null
          : await velocity.check({
              token: request.token,
              clientAddress: request.clientAddress,
              userAgent: request.userAgent,
            });

      if (counted !== null && counted.status === "unavailable") {
        return { status: "unavailable", reason: "velocity" };
      }

      if (counted !== null && counted.status === "limited") {
        return { status: "refused_by_velocity", limited: counted.limited };
      }

      const opened = options.recorder.open({
        companyId: request.companyId,
        invoiceId: request.invoiceId,
        amountMinor: request.amountMinor,
        chargeAmount: request.chargeAmount,
        idempotencyKey: request.idempotencyKey,
        occurredAtEpochMs: request.occurredAtEpochMs,
      });

      if (opened.status === "refused") {
        return { status: "unavailable", reason: "recorder" };
      }

      if (opened.status === "duplicate") {
        if (opened.settled === "captured" && opened.transactionId !== null) {
          // The answer the first attempt was given, given again: a reload is not a second charge.
          return { status: "captured", paymentId: opened.paymentId, transactionId: opened.transactionId };
        }

        if (opened.settled === "declined") {
          return { status: "declined", paymentId: opened.paymentId, code: opened.code ?? "declined" };
        }

        if (opened.settled === "failed" && opened.code === PORTAL_BLACKLIST_SETTLED_CODE) {
          // STEP 187: the first attempt was refused by the list, so the replay is refused by the same rule.
          // The block itself is not carried: the record keeps the code, and re-reading the list to decorate a
          // refusal would be a second query for nothing.
          return { status: "refused_by_blacklist", paymentId: opened.paymentId, replayed: true, block: null };
        }

        if (opened.settled === "failed" || opened.settled === "under_review") {
          // STEP 186: the risk answer the first attempt was given, given again. `replayed` is what keeps the
          // page from writing a second chain entry and a second referral for one flag: the first attempt
          // already recorded both.
          return {
            status: "refused_by_risk",
            paymentId: opened.paymentId,
            decision: opened.settled === "failed" ? "reject" : "review",
            signal: opened.settled === "failed" ? "fraud" : "suspicious",
            code: opened.code,
            replayed: true,
          };
        }

        // Opened and never settled: the previous attempt's answer was lost. Charging again could take the
        // money twice, so the honest answer is that the outcome is unknown and must be reconciled.
        return { status: "unknown", paymentId: opened.paymentId, reason: "duplicate_unsettled" };
      }

      if (blocked !== null && blocked.status === "blocked") {
        // Nothing is routed and nothing is sent: a card on the list is refused here, and the record says so
        // with `failed` and the list's own code, which `payments_risk_reject_check` puts with `risk_decision`
        // `reject`.
        options.recorder.settle({
          paymentId: opened.paymentId,
          outcome: "failed",
          transactionId: null,
          code: PORTAL_BLACKLIST_SETTLED_CODE,
          occurredAtEpochMs: request.occurredAtEpochMs,
        });

        return {
          status: "refused_by_blacklist",
          paymentId: opened.paymentId,
          replayed: false,
          block: blocked.block,
        };
      }

      const routing = routePayment(
        { capability: PORTAL_PAYMENT_CAPABILITY, method: PORTAL_PAYMENT_METHOD },
        routingRules,
      );

      if (!routing.matched || routing.providerKey !== PORTAL_PAYMENT_PROVIDER) {
        // No rule, or a rule pointing at a provider without hosted fields: this page has no way to charge.
        options.recorder.settle({
          paymentId: opened.paymentId,
          outcome: "unknown",
          transactionId: null,
          code: "no_provider",
          occurredAtEpochMs: request.occurredAtEpochMs,
        });

        return { status: "unavailable", reason: "provider" };
      }

      const executed = await processNmiPayment(
        {
          companyId: request.companyId,
          type: "sale",
          amount: request.chargeAmount,
          token: request.token,
          customerId: null,
          reference: request.number ?? request.invoiceId,
          originalTransactionId: null,
          capture: false,
        },
        {
          store: options.keyStore,
          encryptionKey: options.encryptionKeyHex,
          ...(options.transport === undefined ? {} : { transport: options.transport }),
          occurredAtEpochMs: request.occurredAtEpochMs,
        },
      );

      if (executed.status === "success") {
        options.recorder.settle({
          paymentId: opened.paymentId,
          outcome: "captured",
          transactionId: executed.transactionId,
          code: null,
          occurredAtEpochMs: request.occurredAtEpochMs,
        });

        return { status: "captured", paymentId: opened.paymentId, transactionId: executed.transactionId };
      }

      if (executed.status === "failed") {
        // STEP 186, before the decline is written: the documented codes that name the card itself as the
        // problem are section 18's fraud signal, and a payment they answer is not an ordinary decline.
        const signal = portalProviderFraudSignalOf({ responseCode: executed.responseCode });
        const decision = portalFraudDecisionOf(signal);

        if (decision !== null) {
          options.recorder.settle({
            paymentId: opened.paymentId,
            outcome: decision === "reject" ? "failed" : "under_review",
            transactionId: null,
            code: decision === "reject" ? PORTAL_FRAUD_FAILURE_CODE : PORTAL_FRAUD_RULES.suspicious,
            occurredAtEpochMs: request.occurredAtEpochMs,
          });

          return {
            status: "refused_by_risk",
            paymentId: opened.paymentId,
            decision,
            signal,
            code: executed.responseCode,
            replayed: false,
          };
        }

        options.recorder.settle({
          paymentId: opened.paymentId,
          outcome: "declined",
          transactionId: null,
          code: executed.responseCode,
          occurredAtEpochMs: request.occurredAtEpochMs,
        });

        return { status: "declined", paymentId: opened.paymentId, code: executed.responseCode };
      }

      if (executed.status === "rejected") {
        // Refused before it reached the gateway: no key configured, or a request the adapter will not build.
        // Nothing was charged, so the record is settled as unknown rather than as a decline - a decline would
        // tell the payer their card was refused.
        options.recorder.settle({
          paymentId: opened.paymentId,
          outcome: "unknown",
          transactionId: null,
          code: "rejected",
          occurredAtEpochMs: request.occurredAtEpochMs,
        });

        return { status: "unavailable", reason: "provider" };
      }

      // A transport that lost its answer may have taken the money. This is not a failure to retry; it is a
      // fact to reconcile, and the record says so.
      options.recorder.settle({
        paymentId: opened.paymentId,
        outcome: "unknown",
        transactionId: null,
        code: "transport_error",
        occurredAtEpochMs: request.occurredAtEpochMs,
      });

      return { status: "unknown", paymentId: opened.paymentId, reason: executed.message };
    },
  };
}

/**
 * The recorder a gate uses: correct about idempotency, honest about persistence.
 *
 * It exists so the whole flow can be proven without a database, and so the production wiring has something
 * that says `durable: false` rather than pretending. It is not a production store: the record lives in this
 * process only, which is exactly why the page refuses to charge through it.
 */
export function createInMemoryPortalPaymentRecorder(): PortalPaymentRecorder {
  interface Record {
    readonly paymentId: string;
    settled: "captured" | "declined" | "unknown" | "failed" | "under_review" | null;
    transactionId: string | null;
    code: string | null;
  }

  const byKey = new Map<string, Record>();
  const byPayment = new Map<string, Record>();

  return {
    durable: false,
    open(input) {
      const existing = byKey.get(input.idempotencyKey);

      if (existing !== undefined) {
        return {
          status: "duplicate",
          paymentId: existing.paymentId,
          settled: existing.settled,
          transactionId: existing.transactionId,
          code: existing.code,
        };
      }

      const record: Record = {
        paymentId: randomUUID(),
        settled: null,
        transactionId: null,
        code: null,
      };

      byKey.set(input.idempotencyKey, record);
      byPayment.set(record.paymentId, record);

      return { status: "opened", paymentId: record.paymentId };
    },
    settle(input) {
      const record = byPayment.get(input.paymentId);

      if (record === undefined) {
        return;
      }

      record.settled = input.outcome;
      record.transactionId = input.transactionId;
      record.code = input.code;
    },
  };
}
