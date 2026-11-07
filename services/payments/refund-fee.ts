// path: services/payments/refund-fee.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole } from "../../lib/auth/session.ts";
import { requireFreshReauthentication } from "../../lib/auth/step-up.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { postLedgerEntries, type LedgerEntryStore } from "../../lib/payments/ledger-posting.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { priceColumnSchema } from "../products/price.ts";
import { REFUND_AUDIT_ENTITY, REFUND_DECISION_ROLES } from "./refund-fields.ts";
import {
  REFUND_FEE_BACKLOG_LIMIT,
  REFUND_FEE_RETAINED_AUDIT_ACTION,
  REFUND_FEE_RETURNED_AUDIT_ACTION,
  REFUND_FEE_RULE_DEFAULT,
  REFUND_FEE_RULE_KEY,
  REFUND_FEE_RULE_UPDATED_AUDIT_ACTION,
  REFUND_FEE_RULES,
  REFUND_FEE_SETTLED_STATUS,
  REFUND_FEE_SWEEP_LIMIT,
  feeReturnGroupIdOf,
  feeReturnPlanOf,
  type FeeReturnPlan,
} from "./refund-fee-fields.ts";
import {
  REFUND_ROW_COLUMNS,
  appendTolerated,
  moveRefund,
  refundRowSchema,
  viewOf,
  type RefundRow,
  type RefundView,
} from "./refund.ts";

/**
 * STEP 193: the platform fee on a refund, applied from the super administrator's setting.
 *
 * ## The two acts
 *
 * One person answers the question once - `saveRefundFeeRule` writes the section 18 switch - and every refund
 * that afterwards sends money back has that answer applied to it. The application is `applyRefundFeeReturn`
 * for one refund and `sweepRefundFeeReturns` for the backlog: the same function, once and then in a loop, so
 * the single case a route performs inline is literally the case the sweep performs later. A second copy of
 * "how much comes back" would be how the two disagree.
 *
 * ## Why the pass exists at all
 *
 * The rule could have been applied inside the execution that sends the refund (STEP 192), and the desk would
 * never see a window. It is a separate pass for three reasons, and the product keeps the immediacy anyway:
 *
 *   - STEP 192's execution writes no fee column, on purpose, and its gate holds it to that. A pass keeps the
 *     two STEPs' contracts intact rather than reopening one file to satisfy the other.
 *   - The fee rule can be answered long after a refund succeeded - a deployment that opens the switch today
 *     has months of refunds, and each of them needs an answer recorded once.
 *   - A pass is retryable. A provider call is not: it can be declined, unanswered, or accepted twice.
 *
 * The execution route calls `applyRefundFeeReturn` for the refund it just settled, tolerantly: a fee problem
 * never fails a refund that already went back. Whatever the call misses - a ledger that refused, a process that
 * died, a rule opened after the fact - the sweep finds, because its queue is "succeeded and not yet answered".
 *
 * ## The order of the writes, and why it is that order
 *
 * The ledger group is posted first, then the refund row records the answer, then the answer is audited. The
 * ledger is the money; the row is the record. A crash between the two leaves a posted group and an unrecorded
 * refund, and the next pass derives the same group id (see `feeReturnGroupIdOf`), finds the group instead of
 * posting a second one, reads the amount that was actually posted, and writes that. The other order would
 * leave a row claiming money came back with no pair behind it, which no later pass could detect.
 *
 * A deployment with no ledger store (this build has none yet: STEP 132 built the posting service and no
 * production store) still records the answer on the refund and in the chain, and the result says
 * `ledger: "absent"` rather than pretending a pair exists. The handoff names it as a gap.
 */

/** The roles that may read the switch and run a pass: the desk that decides and executes refunds. */
export const REFUND_FEE_SCREEN_ROLES: readonly PlatformRole[] = deepFreeze([
  "finance_ops",
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** The one role that may answer the question: section 18 gives it to the super administrator. */
export const REFUND_FEE_RULE_ROLES: readonly PlatformRole[] = deepFreeze([
  "super_admin",
] as const satisfies readonly PlatformRole[]);

/** What the service needs: the database, the signed chain, an optional ledger, and a clock. */
export interface RefundFeeDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** The ledger store, or null when the deployment has none. A store is the only way a pair is posted. */
  readonly ledger: LedgerEntryStore | null;
  readonly now?: () => number;
}

/** The switch as the screen prints it. */
export interface RefundFeeRuleView {
  /** True when the platform returns its share of the fee on each refund. */
  readonly returned: boolean;
  /** True when a row exists; false means the screen is showing the seeded default. */
  readonly isSet: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
  /** True when this account may answer the question. */
  readonly canEdit: boolean;
}

/** Why the rule produced no money, or why it was not applied to this refund. */
export type RefundFeeOutcomeKind = "returned" | "retained" | "skipped" | "unavailable";

/** What applying the rule to one refund did. */
export interface RefundFeeResult {
  readonly kind: RefundFeeOutcomeKind;
  /** The rule code when the answer was "nothing", or a reason when the row was skipped. */
  readonly rule: string | null;
  /** How much came back, in minor units, as decimal text. */
  readonly returnedMinor: string;
  /** The fee the payment carried, as decimal text. */
  readonly feeMinor: string;
  /** What earlier refunds of the same payment had already returned, as decimal text. */
  readonly alreadyReturnedMinor: string;
  /** True when this refund completed the payment, so the remainder of the fee went back. */
  readonly completes: boolean;
  /** Whether a balanced ledger group carries this return. */
  readonly ledger: "posted" | "existing" | "absent";
  /** The refund as it stands after the pass. */
  readonly refund: RefundView;
}

/** What one pass over the backlog did. */
export interface RefundFeeSweepView {
  /** How many refunds the pass looked at. */
  readonly examined: number;
  readonly returned: number;
  readonly retained: number;
  readonly skipped: number;
  readonly unavailable: number;
  /** Everything this pass gave back, in minor units, as decimal text. */
  readonly returnedMinor: string;
  /** The switch the pass applied. */
  readonly ruleReturned: boolean;
  readonly ranAtEpochMs: number;
}

const settingRowSchema = z.object({
  id: z.string().min(1).max(64),
  value: z.unknown(),
  updated_at: z.string().min(1).max(40),
  updated_by: z.string().min(1).max(64).nullable(),
  version: z.number().int().positive(),
});

const versionRowSchema = z.object({ version: z.number().int().positive() });

/**
 * A refund row plus the instant the rule was applied.
 *
 * `0123` added `platform_fee_settled_at` to `0038`'s table, and `refund.ts`'s projection predates it, so this
 * module extends that schema rather than editing another STEP's column list: the row type stays compatible
 * with `moveRefund`, which is the guarded write both modules use.
 */
const feeRefundRowSchema = refundRowSchema.extend({
  platform_fee_settled_at: z.string().nullable(),
});

type FeeRefundRow = z.infer<typeof feeRefundRowSchema>;

const FEE_REFUND_ROW_COLUMNS = `${REFUND_ROW_COLUMNS},platform_fee_settled_at`;

const feePaymentSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  amount_minor: priceColumnSchema,
  refunded_minor: priceColumnSchema,
  platform_fee_minor: priceColumnSchema,
  currency: z.string(),
  status: z.string(),
});

type FeePaymentRow = z.infer<typeof feePaymentSchema>;

const returnedRowSchema = z.object({
  platform_fee_returned_minor: priceColumnSchema,
});

const idRowSchema = z.object({ id: z.string().uuid() });

const pendingIdRowSchema = z.object({ id: z.string().uuid() });

function nowOf(dependencies: RefundFeeDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/** Read the switch. A missing row, a row that is not a boolean, or a secret row all read as the default. */
async function findFeeRuleRow(
  dependencies: RefundFeeDependencies,
): Promise<z.infer<typeof settingRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "platform_settings",
    "select=id,value,updated_at,updated_by,version" +
      `&setting_key=eq.${encoded(REFUND_FEE_RULE_KEY)}&is_secret=eq.false&deleted_at=is.null&limit=1`,
    settingRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * The section 18 switch, as the screen reads it.
 *
 * A value that is not a boolean is treated as unset rather than coerced: `"true"` and `1` are rows somebody
 * else wrote, and a switch that reads them as on would return money because of a typo.
 */
export async function readRefundFeeRule(
  input: { readonly actor: RequestActor },
  dependencies: RefundFeeDependencies,
): Promise<RefundFeeRuleView> {
  // The switch decides what happens to money on every refund, so reading it is the refund desk's and nobody
  // else's: a screen that showed it to a merchant would be publishing the platform's own margin.
  requireAnyRole(input.actor, REFUND_FEE_SCREEN_ROLES);

  const row = await findFeeRuleRow(dependencies);
  const isSet = row !== undefined && row !== null && typeof row.value === "boolean";
  const returned = isSet ? row.value === true : REFUND_FEE_RULE_DEFAULT;

  return {
    returned,
    isSet,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
    canEdit: REFUND_FEE_RULE_ROLES.some((role) => input.actor.roles.includes(role)),
  };
}

/**
 * Answer the question: does the platform return its fee on a refund?
 *
 * The super administrator answers, and a change is written with the version it was read at, so two officers
 * who both flip the switch cannot both win. A save that changes nothing writes nothing and audits nothing: the
 * chain records answers, not button presses.
 */
export async function saveRefundFeeRule(
  input: {
    readonly actor: RequestActor;
    readonly returned: boolean;
    readonly expectedUpdatedAt: string | null;
  },
  dependencies: RefundFeeDependencies,
): Promise<RefundFeeRuleView> {
  requireAnyRole(input.actor, REFUND_FEE_RULE_ROLES);
  requireFreshReauthentication(input.actor, nowOf(dependencies));

  const row = await findFeeRuleRow(dependencies);
  const currentIsSet = row !== null && typeof row.value === "boolean";
  const current = currentIsSet ? row.value === true : REFUND_FEE_RULE_DEFAULT;

  if (currentIsSet && current === input.returned) {
    return readRefundFeeRule({ actor: input.actor }, dependencies);
  }

  if (!currentIsSet && input.returned === REFUND_FEE_RULE_DEFAULT) {
    // The screen is showing the default and the officer asked for the default: nothing to write.
    return readRefundFeeRule({ actor: input.actor }, dependencies);
  }

  if (row === null) {
    await dependencies.rest.insert("platform_settings", [
      {
        setting_key: REFUND_FEE_RULE_KEY,
        value: input.returned,
        is_secret: false,
        updated_by: input.actor.userId,
      },
    ]);
  } else {
    // A stale screen is a conflict rather than an overwrite: the second officer reads the first one's answer.
    if (input.expectedUpdatedAt !== null && input.expectedUpdatedAt !== row.updated_at) {
      throw new AppError("CONFLICT", { details: [{ field: "savedAt", rule: "stale" }] });
    }

    await dependencies.rest.update(
      "platform_settings",
      `id=eq.${encoded(row.id)}&version=eq.${String(row.version)}`,
      { value: input.returned, updated_by: input.actor.userId },
    );

    const after = await dependencies.rest.select(
      "platform_settings",
      `select=version&id=eq.${encoded(row.id)}&limit=1`,
      versionRowSchema,
    );

    if (after[0]?.version !== row.version + 1) {
      throw new AppError("CONFLICT", { details: [{ field: "savedAt", rule: "stale" }] });
    }
  }

  await appendTolerated(dependencies.audit, {
    action: REFUND_FEE_RULE_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: "platform_settings",
    entityId: row?.id ?? null,
    companyId: null,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
    payload: {
      setting: REFUND_FEE_RULE_KEY,
      returned: input.returned,
      previous: currentIsSet ? current : null,
    },
  });

  return readRefundFeeRule({ actor: input.actor }, dependencies);
}

/** Read one refund by id, platform-scoped: the desk settles for every merchant. */
async function findFeeRefund(
  dependencies: RefundFeeDependencies,
  refundId: string,
): Promise<FeeRefundRow | null> {
  const rows = await dependencies.rest.select(
    "refunds",
    `${FEE_REFUND_ROW_COLUMNS}&id=eq.${encoded(refundId)}&deleted_at=is.null&limit=1`,
    feeRefundRowSchema,
  );

  return rows[0] ?? null;
}

/** Read the payment of a refund, in the refund's own company. */
async function findFeePayment(
  dependencies: RefundFeeDependencies,
  paymentId: string,
  companyId: string,
): Promise<FeePaymentRow | null> {
  const rows = await dependencies.rest.select(
    "payments",
    "select=id,company_id,amount_minor,refunded_minor,platform_fee_minor,currency,status" +
      `&id=eq.${encoded(paymentId)}&company_id=eq.${encoded(companyId)}&deleted_at=is.null&limit=1`,
    feePaymentSchema,
  );

  return rows[0] ?? null;
}

/** What the other succeeded refunds of a payment have already given back. */
async function alreadyReturnedFor(
  dependencies: RefundFeeDependencies,
  paymentId: string,
  refundId: string,
): Promise<bigint> {
  const rows = await dependencies.rest.select(
    "refunds",
    "select=platform_fee_returned_minor" +
      `&payment_id=eq.${encoded(paymentId)}&id=neq.${encoded(refundId)}` +
      `&status=eq.${REFUND_FEE_SETTLED_STATUS}&deleted_at=is.null&limit=200`,
    returnedRowSchema,
  );

  return rows.reduce((total, row) => total + row.platform_fee_returned_minor, 0n);
}

/** The two ledger entries of a fee return, in the order the posting service wants them. */
function ledgerGroupOf(input: {
  readonly refund: FeeRefundRow;
  readonly minor: bigint;
  readonly groupId: string;
}): Parameters<typeof postLedgerEntries>[0] {
  return {
    companyId: input.refund.company_id,
    entryGroupId: input.groupId,
    // `0041` pairs a refund source with a refund id *and refuses a payment id*, so the payment is absent here.
    sourceType: "refund",
    sourceId: input.refund.id,
    paymentId: null,
    refundId: input.refund.id,
    disputeId: null,
    description: null,
    postings: [
      // The fee income the platform booked when the payment was captured is debited back...
      { accountId: "platform_fee_income", entrySide: "debit", amountMinor: input.minor },
      // ...and the merchant's payable is credited by the same amount, so the pair balances.
      { accountId: "merchant_payable", entrySide: "credit", amountMinor: input.minor },
    ],
  };
}

/**
 * Post the return, or find the one already posted.
 *
 * The group id is derived from the refund, so a retry finds the group instead of posting a second one, and the
 * amount that was actually posted wins over a recomputed one: the ledger is the money, and a later pass must
 * record what it says rather than what the row would have said on a different day.
 */
function postReturn(input: {
  readonly ledger: LedgerEntryStore | null;
  readonly refund: FeeRefundRow;
  readonly minor: bigint;
}): { readonly kind: "posted" | "existing" | "absent" } | { readonly kind: "refused"; readonly reason: string } | { readonly kind: "reused"; readonly minor: bigint } {
  const groupId = feeReturnGroupIdOf(input.refund.id);

  if (input.ledger === null) {
    return { kind: "absent" };
  }

  const existing = input.ledger.findByGroup(groupId);

  if (existing.length > 0) {
    const posted = existing
      .filter((entry) => entry.entrySide === "credit")
      .reduce((total, entry) => total + entry.amountMinor, 0n);

    return { kind: "reused", minor: posted };
  }

  const result = postLedgerEntries(
    ledgerGroupOf({ refund: input.refund, minor: input.minor, groupId }),
    { store: input.ledger },
  );

  if (result.status === "posted") {
    return { kind: "posted" };
  }

  // The posting service reports a group that exists and a store that refused in the same shape, so this treats
  // every refusal as a refusal: the refund stays unanswered, and a pass that lost a race finds the group on its
  // next run through `findByGroup` above rather than recording an amount it did not post.
  return { kind: "refused", reason: result.reason };
}

/** Write the answer on the refund, guarded on the status and the version this caller read. */
async function recordAnswer(
  dependencies: RefundFeeDependencies,
  refund: FeeRefundRow,
  values: Readonly<Record<string, unknown>>,
): Promise<RefundRow> {
  return moveRefund(dependencies, refund, { status: REFUND_FEE_SETTLED_STATUS, ...values });
}

/**
 * Apply the section 18 rule to one succeeded refund.
 *
 * The answers, in the order they are decided:
 *
 *   1. the desk role, and the refund itself - platform-scoped, because the desk settles for every merchant;
 *   2. `succeeded`, or nothing: the rule is about money that went back, and `0123` constrains the instant to
 *      exactly that status;
 *   3. not already answered (`platform_fee_settled_at` is null), which is what makes the pass idempotent;
 *   4. the payment, in the refund's own company, because the fee and the refunded total are its columns;
 *   5. the switch: closed means the platform keeps its fee, and the answer is recorded as retained;
 *   6. the plan: this part's proportion of the fee, or the remainder when this refund completes the payment,
 *      capped by what is left of the fee after the payment's other refunds;
 *   7. the ledger group, which is the money;
 *   8. the refund row, which is the record;
 *   9. one chain entry, which says which of the two happened and why.
 */
export async function applyRefundFeeReturn(
  input: { readonly actor: RequestActor; readonly refundId: string },
  dependencies: RefundFeeDependencies,
): Promise<RefundFeeResult> {
  requireAnyRole(input.actor, REFUND_DECISION_ROLES);

  const refund = await findFeeRefund(dependencies, input.refundId);

  if (refund === null) {
    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: "refund", rule: REFUND_FEE_RULES.refundNotFound }],
    });
  }

  const standing = (kind: RefundFeeOutcomeKind, rule: string | null): RefundFeeResult => ({
    kind,
    rule,
    returnedMinor: "0",
    feeMinor: "0",
    alreadyReturnedMinor: "0",
    completes: false,
    ledger: "absent",
    refund: viewOf(refund),
  });

  if (refund.status !== REFUND_FEE_SETTLED_STATUS) {
    return standing("skipped", REFUND_FEE_RULES.refundNotSettled);
  }

  if (refund.platform_fee_settled_at !== null || refund.platform_fee_returned) {
    return standing("skipped", REFUND_FEE_RULES.alreadySettled);
  }

  const payment = await findFeePayment(dependencies, refund.payment_id, refund.company_id);

  if (payment === null) {
    return standing("unavailable", REFUND_FEE_RULES.paymentNotFound);
  }

  const rule = await readRefundFeeRule({ actor: input.actor }, dependencies);
  const instant = new Date(nowOf(dependencies)).toISOString();

  // The switch is closed, so the answer is "the platform keeps its fee" - recorded once, and audited once.
  if (!rule.returned) {
    const retained = await recordAnswer(dependencies, refund, {
      platform_fee_settled_at: instant,
      platform_fee_returned: false,
      platform_fee_returned_minor: "0",
    });

    await appendTolerated(dependencies.audit, {
      action: REFUND_FEE_RETAINED_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: REFUND_AUDIT_ENTITY,
      entityId: retained.id,
      companyId: retained.company_id,
      sessionId: input.actor.sessionId ?? null,
      ipAddress: null,
      userAgent: null,
      payload: {
        payment_id: retained.payment_id,
        rule: REFUND_FEE_RULES.ruleClosed,
        fee_minor: payment.platform_fee_minor.toString(),
        amount_minor: retained.amount_minor.toString(),
        currency: retained.currency,
      },
    });

    return {
      kind: "retained",
      rule: REFUND_FEE_RULES.ruleClosed,
      returnedMinor: "0",
      feeMinor: payment.platform_fee_minor.toString(),
      alreadyReturnedMinor: "0",
      completes: false,
      ledger: "absent",
      refund: viewOf(retained),
    };
  }

  const alreadyReturned = await alreadyReturnedFor(dependencies, refund.payment_id, refund.id);
  const plan: FeeReturnPlan = feeReturnPlanOf({
    feeMinor: payment.platform_fee_minor,
    paymentMinor: payment.amount_minor,
    refundedMinor: payment.refunded_minor,
    refundMinor: refund.amount_minor,
    alreadyReturnedMinor: alreadyReturned,
  });

  // Nothing to return: the fee was zero, or this part's share rounds to zero, or the fee is already back. The
  // answer is still the rule's, so it is still recorded - once.
  if (plan.rule !== null || plan.returnMinor === 0n) {
    const retained = await recordAnswer(dependencies, refund, {
      platform_fee_settled_at: instant,
      platform_fee_returned: false,
      platform_fee_returned_minor: "0",
    });

    await appendTolerated(dependencies.audit, {
      action: REFUND_FEE_RETAINED_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: REFUND_AUDIT_ENTITY,
      entityId: retained.id,
      companyId: retained.company_id,
      sessionId: input.actor.sessionId ?? null,
      ipAddress: null,
      userAgent: null,
      payload: {
        payment_id: retained.payment_id,
        rule: plan.rule ?? REFUND_FEE_RULES.shareZero,
        fee_minor: plan.feeMinor.toString(),
        amount_minor: retained.amount_minor.toString(),
        already_returned_minor: plan.alreadyReturnedMinor.toString(),
        currency: retained.currency,
      },
    });

    return {
      kind: "retained",
      rule: plan.rule ?? REFUND_FEE_RULES.shareZero,
      returnedMinor: "0",
      feeMinor: plan.feeMinor.toString(),
      alreadyReturnedMinor: plan.alreadyReturnedMinor.toString(),
      completes: plan.completes,
      ledger: "absent",
      refund: viewOf(retained),
    };
  }

  const posted = postReturn({ ledger: dependencies.ledger, refund, minor: plan.returnMinor });

  if (posted.kind === "refused") {
    // The ledger refused and nothing was written: the refund stays unanswered, and the next pass tries again.
    return {
      kind: "unavailable",
      rule: REFUND_FEE_RULES.ledgerRefused,
      returnedMinor: "0",
      feeMinor: plan.feeMinor.toString(),
      alreadyReturnedMinor: plan.alreadyReturnedMinor.toString(),
      completes: plan.completes,
      ledger: "absent",
      refund: viewOf(refund),
    };
  }

  const ledgerKind = posted.kind === "reused" ? "existing" : posted.kind;
  const returnedMinor =
    posted.kind === "reused" && posted.minor > 0n ? posted.minor : plan.returnMinor;

  const answered = await recordAnswer(dependencies, refund, {
    platform_fee_settled_at: instant,
    platform_fee_returned: true,
    platform_fee_returned_minor: returnedMinor.toString(),
  });

  await appendTolerated(dependencies.audit, {
    action: REFUND_FEE_RETURNED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: REFUND_AUDIT_ENTITY,
    entityId: answered.id,
    companyId: answered.company_id,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
    payload: {
      payment_id: answered.payment_id,
      amount_minor: answered.amount_minor.toString(),
      currency: answered.currency,
      fee_minor: plan.feeMinor.toString(),
      returned_minor: returnedMinor.toString(),
      already_returned_minor: plan.alreadyReturnedMinor.toString(),
      completes: plan.completes,
      ledger: ledgerKind,
      entry_group_id: feeReturnGroupIdOf(answered.id),
    },
  });

  return {
    kind: "returned",
    rule: null,
    returnedMinor: returnedMinor.toString(),
    feeMinor: plan.feeMinor.toString(),
    alreadyReturnedMinor: plan.alreadyReturnedMinor.toString(),
    completes: plan.completes,
    ledger: ledgerKind,
    refund: viewOf(answered),
  };
}

/** How many succeeded refunds are still waiting for an answer, and whether the count hit its ceiling. */
export async function readRefundFeeBacklog(
  dependencies: RefundFeeDependencies,
): Promise<{ readonly pending: number; readonly capped: boolean }> {
  const rows = await dependencies.rest.select(
    "refunds",
    "select=id" +
      `&status=eq.${REFUND_FEE_SETTLED_STATUS}&platform_fee_settled_at=is.null&deleted_at=is.null` +
      `&limit=${String(REFUND_FEE_BACKLOG_LIMIT + 1)}`,
    pendingIdRowSchema,
  );

  return {
    pending: Math.min(rows.length, REFUND_FEE_BACKLOG_LIMIT),
    capped: rows.length > REFUND_FEE_BACKLOG_LIMIT,
  };
}

/**
 * Apply the rule to the backlog: the pass a scheduler would run, and the button the desk has today.
 *
 * The queue is `0123`'s partial index - succeeded, unanswered, not removed - oldest processed first, so the
 * refund that has waited longest is settled first and one pass is bounded work. A row that moved under the
 * pass is counted as skipped rather than failing the pass: the sweep's job is to leave no row unanswered, not
 * to stop because one was answered by somebody else.
 */
export async function sweepRefundFeeReturns(
  input: { readonly actor: RequestActor; readonly limit?: number },
  dependencies: RefundFeeDependencies,
): Promise<RefundFeeSweepView> {
  requireAnyRole(input.actor, REFUND_FEE_SCREEN_ROLES);
  requireFreshReauthentication(input.actor, nowOf(dependencies));

  const limit = Math.min(Math.max(input.limit ?? REFUND_FEE_SWEEP_LIMIT, 1), REFUND_FEE_SWEEP_LIMIT);
  const rule = await readRefundFeeRule({ actor: input.actor }, dependencies);
  const rows = await dependencies.rest.select(
    "refunds",
    "select=id" +
      `&status=eq.${REFUND_FEE_SETTLED_STATUS}&platform_fee_settled_at=is.null&deleted_at=is.null` +
      `&order=processed_at.asc&limit=${String(limit)}`,
    idRowSchema,
  );

  let returned = 0;
  let retained = 0;
  let skipped = 0;
  let unavailable = 0;
  let returnedMinor = 0n;

  for (const row of rows) {
    try {
      const result = await applyRefundFeeReturn(
        { actor: input.actor, refundId: row.id },
        dependencies,
      );

      if (result.kind === "returned") {
        returned += 1;
        returnedMinor += BigInt(result.returnedMinor);
      } else if (result.kind === "retained") {
        retained += 1;
      } else if (result.kind === "unavailable") {
        unavailable += 1;
      } else {
        skipped += 1;
      }
    } catch {
      // A row that moved, or a database that refused this one row: counted, and the pass continues. The row is
      // still unanswered, so the next pass finds it again.
      skipped += 1;
    }
  }

  return {
    examined: rows.length,
    returned,
    retained,
    skipped,
    unavailable,
    returnedMinor: returnedMinor.toString(),
    ruleReturned: rule.returned,
    ranAtEpochMs: nowOf(dependencies),
  };
}
