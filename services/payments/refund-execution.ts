// path: services/payments/refund-execution.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { REFUND_AUDIT_ENTITY, REFUND_DECISION_ROLES } from "./refund-fields.ts";
import {
  REFUND_EXECUTION_RULES,
  REFUND_EXECUTABLE_STATUS,
  REFUND_EXECUTION_REFUSED_AUDIT_ACTION,
  REFUND_FAILED_AUDIT_ACTION,
  REFUND_PROCESSING_AUDIT_ACTION,
  REFUND_PROVIDER_PENDING_AUDIT_ACTION,
  REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION,
  REFUND_SUCCEEDED_AUDIT_ACTION,
  failureDetailOf,
  providerAmountOf,
  refundExecutionNotFound,
  refundExecutionRefused,
  type RefundProviderOutcomeKind,
} from "./refund-execution-fields.ts";
import {
  appendTolerated,
  findRefund,
  moveRefund,
  viewOf,
  type RefundRow,
  type RefundView,
} from "./refund.ts";
import {
  refundPortOf,
  type RefundProviderOutcome,
  type RefundProviderPorts,
  type RefundProviderTarget,
} from "./refund-provider.ts";

/**
 * STEP 192: taking an approved refund to the provider that took the money, and recording what it said.
 *
 * ## The one act
 *
 * A refund is `approved` when a person on the finance desk decided it. This module performs the only step left:
 * ask the originating provider - the provider recorded on the payment, in the mode the payment was taken in,
 * against the provider's own transaction identifier - to send the money back, and then move the row to exactly
 * one of the statuses `0038` allows next.
 *
 * ## Why the row moves in two writes
 *
 * The provider is called between them, and a call takes time. Writing `processing` *before* the call is what
 * makes the attempt visible: a desk that refreshes the queue while an operator waits sees the refund as work in
 * progress rather than as an approved refund somebody may approve again, and a process that dies mid-call leaves
 * a `processing` row rather than an `approved` one that a second operator can re-send. The second write records
 * the answer, guarded on `processing` and on the version the caller read, so a row that moved underneath this
 * call is refused rather than overwritten.
 *
 * `refunds_processed_check` ties `processed_at` to `succeeded`/`failed`, so `processing` carries no instant of
 * its own; `refunds_provider_required_check` makes the provider's identifier mandatory for `succeeded`; and
 * `refunds_failure_check` allows a detail only on `failed`. This module writes exactly what those three allow.
 *
 * ## What this module does not do
 *
 * It does not decide a refund (STEP 191 owns the decision), does not compute a fee (STEP 193 owns the platform
 * fee rule), and does not write `payments.refunded_minor` - `refunds_sync_payment` does that the instant a refund
 * becomes `succeeded`, and `payments_guard_refund_state` refuses any other writer. It also does not retry: a
 * provider that did not answer leaves the refund `processing`, which is where a reconciliation STEP can find it.
 */

/** What the execution needs: the database, the signed chain, and one port per provider. */
export interface RefundExecutionDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly providers: RefundProviderPorts;
  readonly now?: () => number;
}

/** What one execution did, for the route, the log line and the screen. */
export interface RefundExecutionView {
  /** The refund as it stands after the call. */
  readonly refund: RefundView;
  /** Which of the five provider answers came back, or `not_sent` when no provider was asked. */
  readonly outcome: RefundProviderOutcomeKind;
  /** The provider this refund went back through, when this build has one for the payment. */
  readonly providerKey: string | null;
  /** Why it failed or was not sent, in the provider's own words, cut to what the column allows. */
  readonly detail: string | null;
}

/** The columns this STEP needs from a payment: the route it took and what it can be refunded against. */
const REFUND_PAYMENT_COLUMNS =
  "select=id,company_id,provider_id,provider_key_id,mode,provider_transaction_id,amount_minor,currency,status";

const refundPaymentSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  provider_id: z.string().min(1).max(64),
  provider_key_id: z.string().min(1).max(64).nullable(),
  mode: z.enum(["test", "live"]),
  provider_transaction_id: z.string().min(1).max(120).nullable(),
  amount_minor: z.union([z.string(), z.number()]).transform((value) => BigInt(String(value))),
  currency: z.string(),
  status: z.string(),
});

type RefundPaymentRow = z.infer<typeof refundPaymentSchema>;

/** The provider row `0037`'s `provider_id` points at: its key, and whether the platform has it on. */
const providerRowSchema = z.object({
  id: z.string().min(1).max(64),
  provider_key: z.string().min(1).max(40),
  status: z.enum(["disabled", "enabled"]),
});

/** Read the payment a refund belongs to, scoped to the refund's merchant. */
async function findRefundPayment(
  dependencies: RefundExecutionDependencies,
  paymentId: string,
  companyId: string,
): Promise<RefundPaymentRow | null> {
  const rows = await dependencies.rest.select(
    "payments",
    `${REFUND_PAYMENT_COLUMNS}&id=eq.${paymentId}&company_id=eq.${companyId}&deleted_at=is.null&limit=1`,
    refundPaymentSchema,
  );

  return rows[0] ?? null;
}

/** Read the registry row behind `payments.provider_id`, in the same statement shape the gateways panel uses. */
async function findProvider(
  dependencies: RefundExecutionDependencies,
  providerId: string,
): Promise<z.infer<typeof providerRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "payment_providers",
    `select=id,provider_key,status&id=eq.${providerId}&company_id=is.null&deleted_at=is.null&limit=1`,
    providerRowSchema,
  );

  return rows[0] ?? null;
}

/** One audit entry for one step of one execution, written or not: a chain that is down never blocks money. */
async function note(
  dependencies: RefundExecutionDependencies,
  action: string,
  row: RefundRow,
  actor: RequestActor,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  await appendTolerated(dependencies.audit, {
    action,
    actorUserId: actor.userId,
    entityType: REFUND_AUDIT_ENTITY,
    entityId: row.id,
    companyId: row.company_id,
    sessionId: actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
    payload: {
      payment_id: row.payment_id,
      amount_minor: row.amount_minor.toString(),
      currency: row.currency,
      status: row.status,
      ...detail,
    },
  });
}

/**
 * Execute one approved refund through the provider that took the payment.
 *
 * The order is the order a person can act on, and every refusal happens **before** the row moves:
 *
 *   1. the desk role (`finance_ops` or `super_admin`, the two that decided it);
 *   2. the refund, by id, platform-scoped - a desk executes for every merchant;
 *   3. `approved`, and nothing else: a `requested` refund has no decision, a `processing` one is already being
 *      executed, and a `succeeded`/`failed`/`cancelled` one is history;
 *   4. the payment, in the refund's own company, which is where the provider route lives;
 *   5. the registry row behind `provider_id`, so the provider key is the database's word rather than a guess;
 *   6. a port for that provider - four of the five are a stated gap and refuse here, with the refund left
 *      approved;
 *   7. the provider's own transaction identifier, without which there is nothing to refund;
 *   8. the amount as the networks write it, refused when it is not a whole number of cents.
 *
 * Only then does the row move to `processing`, the port run, and the answer be recorded.
 */
export async function executeRefund(
  input: { readonly actor: RequestActor; readonly refundId: string },
  dependencies: RefundExecutionDependencies,
): Promise<RefundExecutionView> {
  requireAnyRole(input.actor, REFUND_DECISION_ROLES);

  const refund = await findRefund(dependencies, input.refundId, null);

  if (refund === null) {
    throw refundExecutionNotFound();
  }

  if (refund.status !== REFUND_EXECUTABLE_STATUS) {
    throw refundExecutionRefused(REFUND_EXECUTION_RULES.refundNotExecutable, "CONFLICT");
  }

  const payment = await findRefundPayment(dependencies, refund.payment_id, refund.company_id);

  if (payment === null) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: "payment_id", rule: REFUND_EXECUTION_RULES.paymentNotFound }],
    });
  }

  const provider = await findProvider(dependencies, payment.provider_id);

  if (provider === null) {
    throw refundExecutionRefused(REFUND_EXECUTION_RULES.providerNotFound, "SERVICE_UNAVAILABLE");
  }

  const port = refundPortOf(dependencies.providers, provider.provider_key);

  if (port === null) {
    // Nothing is written and nothing is asked: the refund stays approved, which is money promised and not sent.
    throw refundExecutionRefused(REFUND_EXECUTION_RULES.providerUnsupported, "SERVICE_UNAVAILABLE");
  }

  if (payment.provider_transaction_id === null) {
    throw refundExecutionRefused(REFUND_EXECUTION_RULES.referenceMissing, "CONFLICT");
  }

  const providerAmount = providerAmountOf(refund.amount_minor);

  if (providerAmount === null) {
    throw refundExecutionRefused(REFUND_EXECUTION_RULES.amountUnrepresentable, "VALIDATION_FAILED");
  }

  const target: RefundProviderTarget = {
    refundId: refund.id,
    paymentId: payment.id,
    companyId: refund.company_id,
    providerKey: provider.provider_key as RefundProviderTarget["providerKey"],
    providerId: provider.id,
    mode: payment.mode,
    providerReference: payment.provider_transaction_id,
    amountMinor: refund.amount_minor,
    providerAmount,
    currency: refund.currency,
    providerKeyId: payment.provider_key_id,
  };

  // The attempt is visible before the call, because the call takes time.
  const processing = await moveRefund(dependencies, refund, { status: "processing" });

  await note(dependencies, REFUND_PROCESSING_AUDIT_ACTION, processing, input.actor, {
    provider: provider.provider_key,
    mode: payment.mode,
    provider_amount: providerAmount,
  });

  let outcome: RefundProviderOutcome;

  try {
    outcome = await port(target);
  } catch (error) {
    // The port contract says it does not throw. If it does, the row is `processing` and must stay there: a call
    // that threw may still have reached the provider, and this module cannot tell.
    outcome = {
      kind: "unanswered",
      detail: failureDetailOf(
        error instanceof Error ? error.message : "",
        "The provider call failed before it answered.",
      ),
    };
  }

  if (outcome.kind === "succeeded") {
    const succeeded = await moveRefund(dependencies, processing, {
      status: "succeeded",
      provider_refund_id: outcome.providerRefundId,
      processed_at: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
    });

    await note(dependencies, REFUND_SUCCEEDED_AUDIT_ACTION, succeeded, input.actor, {
      provider: provider.provider_key,
      provider_refund_id: outcome.providerRefundId,
      // `refunds_sync_payment` has already written the payment's total by the time this line runs.
      settled: true,
    });

    return {
      refund: viewOf(succeeded),
      outcome: "succeeded",
      providerKey: provider.provider_key,
      detail: null,
    };
  }

  if (outcome.kind === "declined") {
    const detail = failureDetailOf(outcome.detail, "The provider declined the refund.");
    const failed = await moveRefund(dependencies, processing, {
      status: "failed",
      failure_detail: detail,
      processed_at: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
    });

    await note(dependencies, REFUND_FAILED_AUDIT_ACTION, failed, input.actor, {
      provider: provider.provider_key,
      failure_detail: detail,
    });

    return { refund: viewOf(failed), outcome: "declined", providerKey: provider.provider_key, detail };
  }

  if (outcome.kind === "pending") {
    // The provider accepted the refund and will answer again: the row stays `processing`, with its identifier
    // if one came back, so a status sync can find it by the provider's own handle.
    const pending =
      outcome.providerRefundId === null
        ? processing
        : await moveRefund(dependencies, processing, {
            status: "processing",
            provider_refund_id: outcome.providerRefundId,
          });

    await note(dependencies, REFUND_PROVIDER_PENDING_AUDIT_ACTION, pending, input.actor, {
      provider: provider.provider_key,
      provider_refund_id: outcome.providerRefundId,
    });

    return {
      refund: viewOf(pending),
      outcome: "pending",
      providerKey: provider.provider_key,
      detail: null,
    };
  }

  if (outcome.kind === "unanswered") {
    const detail = failureDetailOf(outcome.detail, "The provider did not answer the refund request.");
    const unanswered = processing;

    await note(dependencies, REFUND_PROVIDER_UNANSWERED_AUDIT_ACTION, unanswered, input.actor, {
      provider: provider.provider_key,
      detail,
      // The one fact an operator needs: the money may or may not have moved, so nothing is retried in place.
      retry: "manual",
    });

    return {
      refund: viewOf(unanswered),
      outcome: "unanswered",
      providerKey: provider.provider_key,
      detail,
    };
  }

  // `not_sent`: no provider was asked and no money moved, so the refund goes back to `approved` and the desk can
  // fix the configuration and press again - the same refund, the same chain.
  const restored = await moveRefund(dependencies, processing, { status: "approved" });

  await note(dependencies, REFUND_EXECUTION_REFUSED_AUDIT_ACTION, restored, input.actor, {
    provider: provider.provider_key,
    rule: outcome.rule,
    detail: failureDetailOf(outcome.detail, "The provider was not asked."),
  });

  return {
    refund: viewOf(restored),
    outcome: "not_sent",
    providerKey: provider.provider_key,
    detail: failureDetailOf(outcome.detail, "The provider was not asked."),
  };
}
