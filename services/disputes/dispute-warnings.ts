// path: services/disputes/dispute-warnings.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { appendTolerated } from "../payments/refund.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_AUDIT_ENTITY,
  DISPUTE_WARNING_BATCH_LIMIT,
  DISPUTE_WARNING_DUPLICATE_REASON,
  DISPUTE_WARNING_MAX_ATTEMPTS,
  DISPUTE_WARNING_REFERENCE_KIND,
  DISPUTE_WARNING_ROLES,
  DISPUTE_WARNING_STAGES,
  DISPUTE_WARNING_TEMPLATE_KEY,
  type DisputeWarningStage,
} from "./dispute-fields.ts";
import { disputeMidpointOf, disputeWarningStagesOf } from "./dispute-deadline.ts";

/**
 * Section 19's two warnings: "The merchant receives email warnings at the start and in the middle of the
 * deadline window."
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the half of the sentence that belongs to disputes: deciding *that* a merchant is owed a warning,
 * which of the two it is, and handing it to the email system of section 23 in the shape that system already
 * defined. It is not an SMTP client, it composes no body, and it sends nothing: the sending method is
 * configured by the office in `email_settings` (`0059`), the wording is a template in `email_templates`
 * (`0060`), and the queue, its retries and its sweep are `email_send_logs` (`0061`) and STEP 227. A platform
 * whose office has not configured a sender is a platform with no warning emails, not a platform with a made
 * up transport - which is exactly the bargain `lib/auth/lock-alert.ts` strikes, and this module follows it.
 *
 * ## Two warnings, one sweep, and why the stages are not timers
 *
 * Both stages are decided from the row the moment the sweep looks at it (`disputeWarningStagesOf`), so there
 * is no queue row per dispute to keep in step with an extension, no timer to cancel when a super administrator
 * moves the deadline from 24 hours to 48, and no second writer of `disputes`. A sweep that runs every five
 * minutes and finds nothing does nothing; a sweep that runs for the first time in a week sends each stage
 * that is still worth sending and skips the ones whose window closed.
 *
 * The cost of that design is stated rather than hidden: a stage is sent on the first tick after it becomes
 * due, not at the instant itself. A deployment with a scheduler gets the start warning within one interval of
 * the report; a deployment without one gets it when an officer presses the button on the queue screen.
 *
 * ## Exactly once, and what happens when two sweeps meet
 *
 * The warning row is the claim, and `0125` refuses a second one: one row per stage per window, one start row
 * per dispute for its whole life, one email per warning. The order is deliberate - the email row first, the
 * claim second - because the claim is the only write that can lose. A sweep that loses it marks its own send
 * row `dropped` with a reason (a state `0061` already understands) and reports the stage as already sent, so
 * the merchant receives one email and the log still tells the truth about both attempts.
 *
 * ## Why the warnings are keyed by window, and the start is not
 *
 * Section 19 lets a super administrator widen the window to 48 hours, which moves the *middle* from hour 12
 * to hour 24. So the midpoint is keyed by the window it was about, and a merchant whose window was extended
 * may be warned again at the new middle - which is the only useful thing to do with a deadline that moved.
 * The start announces a window that has already begun, so it happens once in a dispute's life whatever the
 * window becomes.
 */

/** The dependencies: the platform's REST client, the chain, and a clock the gate can pin. */
export interface DisputeWarningDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** Why a stage that was due was not queued. */
export type DisputeWarningSkipReason =
  | "already_sent"
  | "superseded"
  | "sender_not_configured"
  | "no_owner"
  | "failed";

/** What one sweep did, in numbers a screen or a log line can print. */
export interface DisputeWarningSweepResult {
  /** How many of the merchant's open disputes the sweep looked at. */
  readonly considered: number;
  /** How many stage warnings were due across those disputes. */
  readonly due: number;
  /** How many were handed to the email system. */
  readonly sent: number;
  /** How many were due and were not queued, by reason. */
  readonly skipped: Readonly<Record<DisputeWarningSkipReason, number>>;
}

/** One warning already recorded for a dispute. */
export interface DisputeWarningRecord {
  readonly stage: DisputeWarningStage;
  readonly windowHours: number;
  readonly warnedAt: string;
  readonly dueAt: string;
}

const warningDisputeSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  opened_at: z.string(),
  response_window_hours: z.number(),
  response_due_at: z.string(),
  response_saved_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
});

type WarningDisputeRow = z.infer<typeof warningDisputeSchema>;

const warningRowSchema = z.object({
  stage: z.string(),
  window_hours: z.number(),
  warn_at: z.string(),
  due_at: z.string(),
});

const idSchema = z.object({ id: z.string().min(1).max(64) });

const methodSchema = z.object({ method: z.enum(["smtp", "api"]) });

const ownerSchema = z.object({ user_id: z.string().min(1).max(64) });

const addressSchema = z.object({ email: z.string().min(3).max(320) });

/** One stage the sweep decided to send, with everything the write needs. */
interface PlannedWarning {
  readonly dispute: WarningDisputeRow;
  readonly stage: DisputeWarningStage;
  readonly warnAtEpochMs: number;
  readonly dueAtEpochMs: number;
}

function emptySkipped(): Record<DisputeWarningSkipReason, number> {
  return {
    already_sent: 0,
    superseded: 0,
    sender_not_configured: 0,
    no_owner: 0,
    failed: 0,
  };
}

function isWarningStage(value: string): value is DisputeWarningStage {
  return (DISPUTE_WARNING_STAGES as readonly string[]).includes(value);
}

/** The clock of one call, defaulting to the wall clock. */
function nowOf(dependencies: DisputeWarningDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

/**
 * One merchant's open disputes, which is the only query the sweep runs against `disputes`.
 *
 * `resolved_at=is.null`, `submitted_at=is.null` and a deadline in the future are in the query rather than in a
 * filter afterwards: a decided dispute, a sent pack and a closed window can never owe a warning, so they are
 * never read.
 */
async function readOpenDisputes(
  dependencies: DisputeWarningDependencies,
  input: { readonly companyId: string | null; readonly nowMs: number },
): Promise<readonly WarningDisputeRow[]> {
  const company = input.companyId === null ? "" : `&company_id=eq.${encodeURIComponent(input.companyId)}`;

  return dependencies.rest.select(
    "disputes",
    "select=id,company_id,opened_at,response_window_hours,response_due_at,response_saved_at,submitted_at" +
      ",resolved_at" +
      `&deleted_at=is.null&resolved_at=is.null&submitted_at=is.null&opened_at=lte.${encodeURIComponent(
        new Date(input.nowMs).toISOString(),
      )}&response_due_at=gt.${encodeURIComponent(new Date(input.nowMs).toISOString())}${company}` +
      `&order=response_due_at.asc&limit=${String(DISPUTE_WARNING_BATCH_LIMIT)}`,
    warningDisputeSchema,
  );
}

/** The stages already recorded for one dispute, so a stage is never planned twice. */
async function readRecordedStages(
  dependencies: DisputeWarningDependencies,
  disputeId: string,
): Promise<readonly DisputeWarningStage[]> {
  const rows = await dependencies.rest.select(
    "dispute_deadline_warnings",
    `select=stage,window_hours,warn_at,due_at&dispute_id=eq.${encodeURIComponent(disputeId)}` +
      "&deleted_at=is.null&order=warn_at.asc",
    warningRowSchema,
  );

  return rows.map((row) => row.stage).filter(isWarningStage);
}

/** The sending method the office made active, or null when section 23 has none configured yet. */
async function readSendingMethod(dependencies: DisputeWarningDependencies): Promise<"smtp" | "api" | null> {
  const rows = await dependencies.rest.select(
    "email_settings",
    "select=method&status=eq.active&deleted_at=is.null&limit=1",
    methodSchema,
  );

  return rows[0]?.method ?? null;
}

/**
 * The address a warning goes to: the merchant's own owner.
 *
 * An owner is a live `role_assignments` row with `role = 'owner'`, which `0004` scopes to exactly one company.
 * A company whose owner was revoked and never replaced answers null - a state the office has to fix rather
 * than a reason to email somebody else - and the sweep records it as `no_owner` instead of guessing.
 */
async function readOwner(
  dependencies: DisputeWarningDependencies,
  companyId: string,
): Promise<{ readonly userId: string; readonly email: string } | null> {
  const owners = await dependencies.rest.select(
    "role_assignments",
    `select=user_id&company_id=eq.${encodeURIComponent(companyId)}&role=eq.owner` +
      "&revoked_at=is.null&deleted_at=is.null&order=granted_at.asc&limit=1",
    ownerSchema,
  );
  const ownerUserId = owners[0]?.user_id;

  if (ownerUserId === undefined) {
    return null;
  }

  const addresses = await dependencies.rest.select(
    "users",
    `select=email&id=eq.${encodeURIComponent(ownerUserId)}&deleted_at=is.null&limit=1`,
    addressSchema,
  );
  const email = addresses[0]?.email;

  return email === undefined ? null : { userId: ownerUserId, email };
}

/** Mark the send row this call wrote as dropped, so a losing race sends one email and no more. */
async function dropDuplicate(
  dependencies: DisputeWarningDependencies,
  sendId: string,
  reason: string,
): Promise<void> {
  await dependencies.rest
    .update("email_send_logs", `id=eq.${encodeURIComponent(sendId)}&status=eq.queued`, {
      status: "dropped",
      failure_reason: reason,
    })
    .catch(() => undefined);
}

/** The subject of one stage, from the catalogue: the same words a renderer would use. */
function subjectOf(stage: DisputeWarningStage): string {
  return stage === "start"
    ? getMessage("email.disputeWarning.startSubject")
    : getMessage("email.disputeWarning.midpointSubject");
}

/** One audit entry per warning, written or not: a chain outage never stops a merchant being told. */
async function noteSent(
  dependencies: DisputeWarningDependencies,
  planned: PlannedWarning,
  detail: { readonly sendId: string; readonly recipientUserId: string; readonly windowHours: number },
): Promise<void> {
  const entry: AuditEntry = {
    action: DISPUTE_AUDIT.warningSent,
    actorUserId: null,
    entityType: DISPUTE_AUDIT_ENTITY,
    entityId: planned.dispute.id,
    payload: {
      stage: planned.stage,
      window_hours: detail.windowHours,
      warn_at: new Date(planned.warnAtEpochMs).toISOString(),
      due_at: new Date(planned.dueAtEpochMs).toISOString(),
      send_id: detail.sendId,
      recipient_user_id: detail.recipientUserId,
    },
    companyId: planned.dispute.company_id,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  };

  await appendTolerated(dependencies.audit, entry);
}

/** What one planned stage did. */
type SendOutcome = { readonly kind: "sent"; readonly sendId: string } | { readonly kind: DisputeWarningSkipReason };

/**
 * Hand one planned stage to the email system, then claim it.
 *
 * The order is the lock-alert order and for the same reason: the send row goes in first because it is the
 * only thing that can be given back, and the claim goes second because it is the only thing that can lose. A
 * claim that loses (another sweep got there first, or the window moved under this read) drops the send row
 * with a reason and reports the stage honestly.
 */
async function queueWarning(
  dependencies: DisputeWarningDependencies,
  planned: PlannedWarning,
  recipient: { readonly userId: string; readonly email: string },
  method: "smtp" | "api",
): Promise<SendOutcome> {
  const queuedAt = new Date(nowOf(dependencies)).toISOString();
  let sendId: string;

  try {
    const rows = await dependencies.rest.insertReturning(
      "email_send_logs",
      [
        {
          company_id: planned.dispute.company_id,
          template_key: DISPUTE_WARNING_TEMPLATE_KEY,
          recipient_email: recipient.email,
          recipient_user_id: recipient.userId,
          subject: subjectOf(planned.stage),
          provider: method,
          max_attempts: DISPUTE_WARNING_MAX_ATTEMPTS,
          reference_kind: DISPUTE_WARNING_REFERENCE_KIND,
          reference_id: planned.dispute.id,
          queued_at: queuedAt,
        },
      ],
      idSchema,
    );
    const written = rows[0]?.id;

    if (written === undefined) {
      return { kind: "failed" };
    }

    sendId = written;
  } catch {
    // The mail system is down or refused the row. The merchant is not told, and the next tick tries again:
    // nothing was claimed, so nothing was lost.
    return { kind: "failed" };
  }

  try {
    await dependencies.rest.insert("dispute_deadline_warnings", [
      {
        company_id: planned.dispute.company_id,
        dispute_id: planned.dispute.id,
        stage: planned.stage,
        window_hours: planned.dispute.response_window_hours,
        opened_at: planned.dispute.opened_at,
        warn_at: new Date(planned.warnAtEpochMs).toISOString(),
        due_at: new Date(planned.dueAtEpochMs).toISOString(),
        send_id: sendId,
        queued_at: queuedAt,
      },
    ]);
  } catch (error) {
    if (!isConflictError(error)) {
      await dropDuplicate(dependencies, sendId, "The deadline warning could not be recorded.");

      return { kind: "failed" };
    }

    // Either another sweep claimed this stage first, or the super administrator moved the window between this
    // call's read and its claim - `0125`'s guard refuses a warning about a window the dispute no longer has,
    // and both of them mean this send row has no warning to be the evidence of.
    const current = await dependencies.rest
      .select(
        "disputes",
        `select=id,company_id,opened_at,response_window_hours,response_due_at,response_saved_at,submitted_at` +
          `,resolved_at&id=eq.${encodeURIComponent(planned.dispute.id)}&limit=1`,
        warningDisputeSchema,
      )
      .catch(() => []);
    const now = current[0];
    const superseded =
      now === undefined ||
      now.opened_at !== planned.dispute.opened_at ||
      now.response_window_hours !== planned.dispute.response_window_hours ||
      now.response_due_at !== planned.dispute.response_due_at;

    await dropDuplicate(
      dependencies,
      sendId,
      superseded ? "The dispute's window changed before the warning was recorded." : DISPUTE_WARNING_DUPLICATE_REASON,
    );

    return { kind: superseded ? "superseded" : "already_sent" };
  }

  await noteSent(dependencies, planned, {
    sendId,
    recipientUserId: recipient.userId,
    windowHours: planned.dispute.response_window_hours,
  });

  return { kind: "sent", sendId };
}

/**
 * Send the warnings that are due, for one merchant or for every merchant.
 *
 * `companyId: null` is the platform-wide sweep - the deployment's clock - and a company id is one merchant's,
 * which is what the job's payload carries. Both are the same code path, because the only difference is the
 * filter on one query: a second implementation for "all merchants" is how two of them end up disagreeing
 * about whether the midpoint is half the window.
 *
 * Nothing throws. A sweep that fails on one dispute carries on with the next, and the result says what
 * happened, because a job that dies on the first bad row leaves every merchant after it unwarned.
 */
export async function runDisputeWarningSweep(
  input: { readonly companyId: string | null },
  dependencies: DisputeWarningDependencies,
): Promise<DisputeWarningSweepResult> {
  const nowMs = nowOf(dependencies);
  const disputes = await readOpenDisputes(dependencies, { companyId: input.companyId, nowMs });
  const skipped = emptySkipped();
  let due = 0;
  let sent = 0;
  let method: "smtp" | "api" | null = null;
  let methodRead = false;
  const owners = new Map<string, { readonly userId: string; readonly email: string } | null>();

  for (const dispute of disputes) {
    const stages = disputeWarningStagesOf(
      {
        openedAtEpochMs: Date.parse(dispute.opened_at),
        dueAtEpochMs: Date.parse(dispute.response_due_at),
        windowHours: dispute.response_window_hours,
        resolved: dispute.resolved_at !== null,
        submitted: dispute.submitted_at !== null,
        answered: dispute.response_saved_at !== null,
      },
      nowMs,
    );

    if (stages.length === 0) {
      continue;
    }

    const recorded = await readRecordedStages(dependencies, dispute.id);
    const dueAtEpochMs = Date.parse(dispute.response_due_at);
    const openedAtEpochMs = Date.parse(dispute.opened_at);

    for (const stage of stages) {
      due += 1;

      if (recorded.includes(stage)) {
        skipped.already_sent += 1;
        continue;
      }

      if (!methodRead) {
        method = await readSendingMethod(dependencies);
        methodRead = true;
      }

      if (method === null) {
        // No sender is configured, so nothing is written: a warning not yet sent is not a warning refused,
        // and the tick after the office configures one will send it.
        skipped.sender_not_configured += 1;
        continue;
      }

      if (!owners.has(dispute.company_id)) {
        owners.set(dispute.company_id, await readOwner(dependencies, dispute.company_id));
      }

      const recipient = owners.get(dispute.company_id) ?? null;

      if (recipient === null) {
        skipped.no_owner += 1;
        continue;
      }

      const plan: PlannedWarning = {
        dispute,
        stage,
        warnAtEpochMs:
          stage === "start" ? openedAtEpochMs : disputeMidpointOf(openedAtEpochMs, dispute.response_window_hours),
        dueAtEpochMs,
      };
      const outcome = await queueWarning(dependencies, plan, recipient, method);

      if (outcome.kind === "sent") {
        sent += 1;
        continue;
      }

      skipped[outcome.kind] += 1;
    }
  }

  return { due, sent, considered: disputes.length, skipped };
}

/**
 * The office's "run it now", which is what a deployment without a scheduler needs.
 *
 * Two guards before the sweep: a role that answers for merchant correspondence (`ceo`, the compliance desk,
 * `super_admin`) and a satisfied second factor, because this act sends email to every merchant at once and a
 * stolen session must not be able to mail the platform's customers. `0125` then refuses any duplicate, so the
 * button is safe to press twice.
 */
export async function runDisputeWarningsNow(
  input: { readonly actor: RequestActor; readonly companyId?: string | null },
  dependencies: DisputeWarningDependencies,
): Promise<DisputeWarningSweepResult> {
  requireAnyRole(input.actor, DISPUTE_WARNING_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  return runDisputeWarningSweep({ companyId: input.companyId ?? null }, dependencies);
}

/**
 * The warnings already recorded for a set of disputes, for the office queue's own line.
 *
 * One query for the page rather than one per row, and only the four facts a row prints. A dispute id the
 * caller does not hold data for is simply absent from the map; the queue's tenant is the platform.
 */
export async function listDisputeWarnings(
  input: { readonly disputeIds: readonly string[] },
  dependencies: DisputeWarningDependencies,
): Promise<ReadonlyMap<string, readonly DisputeWarningRecord[]>> {
  const wanted = [...new Set(input.disputeIds)].slice(0, DISPUTE_WARNING_BATCH_LIMIT);

  if (wanted.length === 0) {
    return new Map();
  }

  const schema = warningRowSchema.extend({ dispute_id: z.string().uuid() });
  const rows = await dependencies.rest.select(
    "dispute_deadline_warnings",
    "select=dispute_id,stage,window_hours,warn_at,due_at" +
      `&dispute_id=in.(${wanted.map((id) => encodeURIComponent(id)).join(",")})` +
      "&deleted_at=is.null&order=warn_at.asc",
    schema,
  );
  const byDispute = new Map<string, DisputeWarningRecord[]>();

  for (const row of rows) {
    if (!isWarningStage(row.stage)) {
      continue;
    }

    const records = byDispute.get(row.dispute_id) ?? [];

    records.push({
      stage: row.stage,
      windowHours: row.window_hours,
      // The row's own due instant is the deadline the merchant was told about.
      warnedAt: row.warn_at,
      dueAt: row.due_at,
    });
    byDispute.set(row.dispute_id, records);
  }

  return byDispute;
}
