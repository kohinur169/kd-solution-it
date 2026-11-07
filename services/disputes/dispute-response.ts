// path: services/disputes/dispute-response.ts
import type { AuditEntry } from "../../lib/auth/audit.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { hasSatisfiedTwoFactor, requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { appendTolerated } from "../payments/refund.ts";
import {
  disputeRowSchema,
  disputeViewOf,
  findDispute,
  type DisputeDependencies,
  type DisputeRow,
  type DisputeView,
} from "./dispute.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_AUDIT_ENTITY,
  DISPUTE_DEADLINE_ROLES,
  DISPUTE_REQUEST_ROLES,
  DISPUTE_RULES,
  disputeDueAt,
  disputeExtensionTarget,
} from "./dispute-fields.ts";
import { parseDisputeDeadlineBody, parseDisputeResponseBody } from "./dispute-response-fields.ts";

/**
 * Section 19's dispute response: the merchant writes their side inside the window, and the one office act
 * that can move the window.
 *
 * ## The act, and the three clocks it is decided against
 *
 * A merchant opens a dispute against their own payment and writes what happened: the order, the delivery, the
 * conversation. Three instants decide whether that save is accepted, and this module asks all three from the
 * row rather than from anything the caller sent:
 *
 *   - `resolved_at` - a decided dispute is history, and the words on it are the words it was decided on;
 *   - `submitted_at` - once the compliance desk has sent the pack to the processor (STEP 198), the merchant's
 *     words are in that pack and an edit would make the row disagree with the evidence. `0124`'s
 *     `disputes_guard_response` refuses it at the database as well, so this is not a service convention;
 *   - `response_due_at` - the deadline, an absolute instant section 19 fixes at twenty-four hours from the
 *     report, or forty-eight after an extension. A save after it is refused with `dispute_deadline_passed` and
 *     nothing is written.
 *
 * The *zone* the merchant reads that deadline in is not one of the three. It cannot be: `0039`'s
 * `disputes_due_check` bounds the instant by the window in absolute hours, so the zone is how the deadline is
 * said and not how it is counted (`dispute-deadline.ts` argues this at length).
 *
 * ## Why the merchant's words are not in the audit payload
 *
 * The chain records that a response exists, how long it is, and when it was saved. The words live on the row,
 * where the pack and the office read them, and a chain entry that copied them would put a merchant's account of
 * a fraud investigation into a structure that is signed, exported and kept far longer than the dispute. That is
 * the same bargain STEP 191 makes with a refund's reason.
 *
 * ## The extension
 *
 * Section 19's second sentence about the deadline - "super_admin can set the deadline to 48 hours when needed" -
 * is one act, in one direction, by one role, with a second factor behind it. It moves the window and the
 * deadline together, because a window column that said 48 while the deadline still said 24 would be a screen
 * promising time the database had already taken away. It is refused once the window has closed: a passed
 * deadline is the processor's answer, and reopening it from here would let the platform accept a response the
 * network never waited for.
 */

/** The field every refusal of a response names, so a form has one thing to point at. */
export const DISPUTE_RESPONSE_FIELD = "response_text";

/** The field every refusal of an extension names. */
export const DISPUTE_WINDOW_FIELD = "response_window_hours";

/** The columns the two acts read: the whole view, so the answer is the row the screen will render. */
const DISPUTE_COLUMNS =
  "select=id,company_id,payment_id,processor_dispute_id,status,reason_code,amount_minor,currency,fee_minor" +
  ",opened_at,response_window_hours,response_due_at,evidence_ready,response_text,response_saved_at" +
  ",submitted_at,resolved_at,outcome_note,created_at,updated_at,version";

const disputeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The clock of one call, defaulting to the wall clock. */
function nowOf(dependencies: DisputeDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

/** A state refusal: the row exists and will not take this act. */
function stateRefused(field: string, rule: string): AppError {
  return new AppError("CONFLICT", { details: [{ field, rule }] });
}

/** A dispute this caller may not see at all. */
function disputeNotFound(): AppError {
  return new AppError("RESOURCE_NOT_FOUND", {
    details: [{ field: "dispute", rule: DISPUTE_RULES.disputeNotFound }],
  });
}

/**
 * One dispute inside one merchant, or null.
 *
 * The tenant is in the query rather than in a comparison after it: a dispute of another merchant is not read
 * and then hidden, it is never read.
 */
async function readDisputeOfCompany(
  dependencies: DisputeDependencies,
  input: { readonly disputeId: string; readonly companyId: string },
): Promise<DisputeRow | null> {
  const rows = await dependencies.rest.select(
    "disputes",
    `${DISPUTE_COLUMNS}&id=eq.${encodeURIComponent(input.disputeId)}` +
      `&company_id=eq.${input.companyId}&deleted_at=is.null&limit=1`,
    disputeRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * One dispute of the signed in merchant, for the screen that renders the form.
 *
 * Two guards, in this order: the `owner` role, then the actor's own company. The row is then read inside that
 * company, so the page and the save path cannot disagree about what this account may see.
 */
export async function readCompanyDispute(
  input: { readonly actor: RequestActor; readonly disputeId: string },
  dependencies: DisputeDependencies,
): Promise<DisputeView> {
  requireAnyRole(input.actor, DISPUTE_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);

  if (!disputeIdPattern.test(input.disputeId)) {
    throw disputeNotFound();
  }

  const row = await readDisputeOfCompany(dependencies, { disputeId: input.disputeId, companyId });

  if (row === null) {
    throw disputeNotFound();
  }

  return disputeViewOf(row, nowOf(dependencies));
}

/**
 * Write the merchant's side of a dispute, if the window is still open.
 *
 * The order of the refusals is the order of their strength: a decided dispute first (the question is over), a
 * sent pack second (the words are evidence), the closed window third (time is up), and only then the write -
 * guarded by the version the row was read at and read back afterwards, so two tabs saving at once cannot both
 * be told they won.
 */
export async function saveDisputeResponse(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly body: unknown },
  dependencies: DisputeDependencies,
): Promise<DisputeView> {
  requireAnyRole(input.actor, DISPUTE_REQUEST_ROLES);
  const companyId = requireCompanyId(input.actor);

  if (!disputeIdPattern.test(input.disputeId)) {
    throw disputeNotFound();
  }

  const parsed = parseDisputeResponseBody(input.body);
  const row = await readDisputeOfCompany(dependencies, { disputeId: input.disputeId, companyId });

  if (row === null) {
    throw disputeNotFound();
  }

  if (row.resolved_at !== null) {
    throw stateRefused(DISPUTE_RESPONSE_FIELD, DISPUTE_RULES.resolved);
  }

  if (row.submitted_at !== null) {
    throw stateRefused(DISPUTE_RESPONSE_FIELD, DISPUTE_RULES.submitted);
  }

  const nowMs = nowOf(dependencies);
  const dueAtMs = Date.parse(row.response_due_at);

  if (Number.isFinite(dueAtMs) && nowMs > dueAtMs) {
    throw stateRefused(DISPUTE_RESPONSE_FIELD, DISPUTE_RULES.deadlinePassed);
  }

  const savedAt = new Date(nowMs).toISOString();

  await dependencies.rest.update(
    "disputes",
    `id=eq.${row.id}&version=eq.${row.version}&deleted_at=is.null`,
    { response_text: parsed.responseText, response_saved_at: savedAt },
  );

  const saved = await findDispute(dependencies, row.id);

  if (saved === null || saved.version !== row.version + 1 || saved.response_text !== parsed.responseText) {
    // Another save landed between this read and this write, or the database refused one of `0124`'s checks.
    throw stateRefused(DISPUTE_RESPONSE_FIELD, DISPUTE_RULES.disputeMoved);
  }

  await note(dependencies, DISPUTE_AUDIT.responseSaved, saved, input.actor, {
    response_length: parsed.responseText.length,
    response_saved_at: saved.response_saved_at,
    response_due_at: saved.response_due_at,
    response_window_hours: saved.response_window_hours,
  });

  return disputeViewOf(saved, nowMs);
}

/**
 * Extend a dispute's window to section 19's 48 hours.
 *
 * One role (`super_admin`) with its second factor satisfied, one direction (24 to 48), one row that is still
 * undecided and unsent, and a window that has not already closed. The change moves `response_window_hours` *and*
 * `response_due_at` together, so the deadline the merchant reads and the deadline the form enforces stay the
 * same instant - and `0039`'s `disputes_due_check` accepts it, because the new instant is exactly the bound.
 */
export async function extendDisputeDeadline(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly body: unknown },
  dependencies: DisputeDependencies,
): Promise<DisputeView> {
  requireAnyRole(input.actor, DISPUTE_DEADLINE_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    // The same two guards the office's other high-privilege acts ask: the role from the session, then the
    // second factor - the merchant's window is their only protection against a dispute decided by silence.
    throw new AppError("PERMISSION_DENIED");
  }

  const parsed = parseDisputeDeadlineBody(input.body);

  if (!disputeIdPattern.test(input.disputeId)) {
    throw disputeNotFound();
  }

  const row = await findDispute(dependencies, input.disputeId);

  if (row === null) {
    throw disputeNotFound();
  }

  if (row.resolved_at !== null) {
    throw stateRefused(DISPUTE_WINDOW_FIELD, DISPUTE_RULES.deadlineNotExtendable);
  }

  if (row.submitted_at !== null) {
    throw stateRefused(DISPUTE_WINDOW_FIELD, DISPUTE_RULES.submitted);
  }

  const nowMs = nowOf(dependencies);
  const dueAtMs = Date.parse(row.response_due_at);

  if (Number.isFinite(dueAtMs) && nowMs > dueAtMs) {
    // A passed deadline is the processor's answer. Extending it from here would let the platform accept a
    // response the network never waited for, which is a worse answer than a refusal.
    throw stateRefused(DISPUTE_WINDOW_FIELD, DISPUTE_RULES.deadlinePassed);
  }

  const target = disputeExtensionTarget(row.response_window_hours, parsed.windowHours);

  if (target === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: DISPUTE_WINDOW_FIELD, rule: DISPUTE_RULES.windowInvalid }],
    });
  }

  const openedAtMs = Date.parse(row.opened_at);
  const nextDueAt = new Date(disputeDueAt(openedAtMs, target)).toISOString();

  await dependencies.rest.update(
    "disputes",
    `id=eq.${row.id}&version=eq.${row.version}&deleted_at=is.null`,
    { response_window_hours: target, response_due_at: nextDueAt },
  );

  const extended = await findDispute(dependencies, row.id);

  if (
    extended === null ||
    extended.version !== row.version + 1 ||
    extended.response_window_hours !== target ||
    extended.response_due_at !== nextDueAt
  ) {
    throw stateRefused(DISPUTE_WINDOW_FIELD, DISPUTE_RULES.disputeMoved);
  }

  await note(dependencies, DISPUTE_AUDIT.deadlineExtended, extended, input.actor, {
    from_window_hours: row.response_window_hours,
    to_window_hours: target,
    from_due_at: row.response_due_at,
    to_due_at: extended.response_due_at,
    response_saved: extended.response_saved_at !== null,
  });

  return disputeViewOf(extended, nowMs);
}

/** One audit entry per act, written or not: a chain that is down never fails a merchant's own words. */
async function note(
  dependencies: DisputeDependencies,
  action: string,
  row: DisputeRow,
  actor: RequestActor,
  detail: Readonly<Record<string, unknown>>,
): Promise<void> {
  const entry: AuditEntry = {
    action,
    actorUserId: actor.userId,
    entityType: DISPUTE_AUDIT_ENTITY,
    entityId: row.id,
    payload: {
      payment_id: row.payment_id,
      status: row.status,
      ...detail,
    },
    companyId: row.company_id,
    sessionId: actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  };

  await appendTolerated(dependencies.audit, entry);
}
