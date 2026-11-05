// path: services/invoices/invoice-status.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { isConflictError } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { INVOICE_AUDIT_ENTITY, INVOICE_MANAGE_ROLES } from "./invoices.ts";
import { INVOICE_STATUSES, type InvoiceStatus } from "./invoice-fields.ts";
import { takeInvoiceNumber } from "./invoice-numbering.ts";

/**
 * The status workflow of section 16: which state may become which, and the one engine that performs
 * the move.
 *
 * ## What was missing, exactly
 *
 * `0022` carries the whole workflow in constraints - the seven statuses, `invoices_status_money_check`
 * tying each one to its money, `invoices_issue_check` tying the number to the issue instant,
 * `invoices_paid_instant_check` and `invoices_voided_instant_check` tying the instants to the states,
 * and `invoices_guard_paid` freezing a paid row. `0024` carries the timeline, with `sent` and `voided`
 * already in its event vocabulary. **Nothing in the application performed a move.** A draft could not be
 * sent, a document could not be voided, and an attempt to change a paid one would die inside the
 * trigger as a `check_violation` and surface as a 500.
 *
 * This module is the application half. It owns the transition graph, the two moves a merchant makes
 * (send, void), the paid lock as a sentence rather than an exception, and the two entries every move
 * leaves behind: the row in `invoice_events` and the entry in `audit_logs`.
 *
 * ## Why one engine, not one function per move
 *
 * STEP 123's sweep will move an invoice to `overdue`, STEP 124's payment will move it to
 * `partially_paid` and `paid`, and the client's tokenized view will move it to `viewed`. If each of
 * those wrote its own update, its own re-read and its own event, four copies of the rule would exist,
 * and a copy is the one thing that drifts. The engine performs one move - graph check, guarded write,
 * re-read, event, audit - and each caller supplies the columns its move writes and the facts its move
 * records. A caller that cannot name a legal move cannot perform it, whatever it calls itself.
 *
 * ## Why the write is guarded and then re-read
 *
 * The update's predicate carries the status the engine just read (`status=eq.<from>`), so two moves on
 * the same invoice cannot both succeed: the second misses its row. PostgREST reports a zero-row update
 * as success, so the engine reads the row back and answers `CONFLICT` when the status it expected is
 * not the one that is there. The guard makes the race a miss, and the re-read makes the miss a refusal.
 */

/** The audit action of a send, the moment a draft becomes a numbered, issued document. */
export const INVOICE_SENT_AUDIT_ACTION = "invoice.sent";

/** The audit action of a void. */
export const INVOICE_VOIDED_AUDIT_ACTION = "invoice.voided";

/** The words this module writes to the `0024` timeline. */
const INVOICE_EVENT_SENT = "sent";
const INVOICE_EVENT_VOIDED = "voided";

/** The actor word of `0024` this module acts under: the move is made by the merchant who owns it. */
const INVOICE_EVENT_ACTOR = "merchant";

/** The status the lock belongs to, named once rather than spelled in every refusal. */
export const INVOICE_PAID_STATUS: InvoiceStatus = "paid";

/** The rule the paid lock answers with, so a screen can print "locked" rather than "something changed". */
export const INVOICE_PAID_LOCKED_RULE = "paid_locked";

/** The rule an illegal move answers with. */
export const INVOICE_ILLEGAL_TRANSITION_RULE = "illegal_transition";

/** A reason for a void, kept short: it prints on the timeline, not in a document. */
export const INVOICE_VOID_REASON_LIMITS = deepFreeze({ min: 1, max: 200 });

/**
 * The legal moves, the whole workflow in one place.
 *
 * Read against `0022`'s constraints, which they never contradict:
 *
 *   - `draft` has no number and no issue instant, so its only way out of the editor is `sent` (which
 *     takes both together) or `void` (which `invoices_issue_check` allows with or without a number).
 *   - The open states `sent`, `viewed`, `partially_paid` and `overdue` accept the same exits in
 *     principle: the money moves, the clock move and `void` from any of them, because
 *     `invoices_status_money_check` puts no money condition on a void. The two view moves are the
 *     exception: `sent` goes to `viewed` because first viewing opens the document, and `overdue` goes
 *     to `viewed` because a client can open a past-due document; `viewed` does not leave, because
 *     `first_viewed_at` keeps the view fact and only the money or the clock moves the state after it.
 *   - `overdue` does not go back to `sent`: an unpaid document past its due date stays overdue until
 *     the money or a void ends it.
 *   - `paid` and `void` are terminal. The first is frozen by `invoices_guard_paid` in the database;
 *     the second by the same reasoning - a cancelled document is not one that comes back.
 */
export const INVOICE_STATUS_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> =
  deepFreeze({
    draft: ["sent", "void"],
    sent: ["viewed", "partially_paid", "paid", "overdue", "void"],
    viewed: ["partially_paid", "paid", "overdue", "void"],
    partially_paid: ["paid", "overdue", "void"],
    overdue: ["viewed", "partially_paid", "paid", "void"],
    paid: [],
    void: [],
  });

/** True when the workflow allows the move. The screen and the gate read the same table. */
export function isLegalInvoiceTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return INVOICE_STATUS_TRANSITIONS[from].includes(to);
}

/** The answer a move gives: the document, the move and the instant it happened. */
export interface InvoiceStatusResult {
  readonly invoiceId: string;
  readonly companyId: string;
  readonly from: InvoiceStatus;
  readonly to: InvoiceStatus;
  /** The issued number after a send, the number the row already carried otherwise, null for a draft. */
  readonly number: string | null;
  /** The issue instant after a send, the void instant after a void, the move instant otherwise. */
  readonly at: string;
}

export interface InvoiceStatusDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * The columns the engine reads: the workflow's own, one by one (rule 17, never a `*`).
 *
 * `client_name`, `client_email`, `client_address`, the memo and the line totals are deliberately
 * absent. A status move is a move, and a function whose only purpose is to move a status does not need
 * the document's printed fields to do it.
 */
const STATUS_ROW_COLUMNS =
  "select=id,company_id,number,status,currency,total_minor,amount_paid_minor" +
  ",issued_at,due_at,first_viewed_at,paid_at,voided_at,deleted_at,version";

const statusRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  number: z.string().nullable(),
  status: z.enum(INVOICE_STATUSES),
  currency: z.string().length(3),
  total_minor: z.string(),
  amount_paid_minor: z.string(),
  issued_at: z.string().nullable(),
  due_at: z.string(),
  first_viewed_at: z.string().nullable(),
  paid_at: z.string().nullable(),
  voided_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

type StatusRow = z.infer<typeof statusRowSchema>;

/**
 * One move of the workflow, performed the same way whatever the move is.
 *
 * The caller has already read the row (it needs the facts only its move knows), and the engine trusts
 * that read for nothing it can check itself: the graph is checked here, the write is guarded on the
 * status the read saw, and the re-read after the write is the authority on what actually happened.
 * `extra` carries the columns the move writes beside the status - the number and the issue instant for
 * a send, the void instant for a void - in the same statement, because `0022`'s checks tie those
 * columns to the status and a row checked between them would be refused in the middle of a legal
 * change.
 */
async function applyTransition(
  dependencies: InvoiceStatusDependencies,
  input: {
    readonly actor: RequestActor;
    readonly row: StatusRow;
    readonly to: InvoiceStatus;
    /** The columns the move writes beside the status, in the same statement. */
    readonly extra: Readonly<Record<string, unknown>>;
    readonly event: {
      readonly type: string;
      readonly detail: string | null;
    };
    readonly audit: {
      readonly action: string;
      readonly payload: Readonly<Record<string, unknown>>;
    };
  },
): Promise<InvoiceStatusResult> {
  // The paid lock is checked before the graph, because it deserves its own sentence: a move the
  // workflow merely does not offer is "not offered", and a move the platform refuses because the money
  // has settled is "locked". The trigger stays the authority - this check turns its exception into a
  // refusal the screen can print.
  if (input.row.status === "paid") {
    throw new AppError("CONFLICT", {
      details: [{ field: "status", rule: INVOICE_PAID_LOCKED_RULE }],
    });
  }

  if (!isLegalInvoiceTransition(input.row.status, input.to)) {
    throw new AppError("CONFLICT", {
      details: [{ field: "status", rule: INVOICE_ILLEGAL_TRANSITION_RULE }],
      cause: { rule: "invoice_status", reason: `${input.row.status}_to_${input.to}` },
    });
  }

  const at = new Date(dependencies.now?.() ?? Date.now()).toISOString();

  try {
    await dependencies.rest.update(
      "invoices",
      `id=eq.${input.row.id}&company_id=eq.${input.row.company_id}&status=eq.${input.row.status}`,
      { status: input.to, ...input.extra },
    );
  } catch (error) {
    if (isConflictError(error)) {
      // A constraint the database raised on the way out: the move the engine thought was legal met a row
      // that no longer agrees. That is a conflict, not an outage.
      throw new AppError("CONFLICT", {
        details: [{ field: "status", rule: INVOICE_ILLEGAL_TRANSITION_RULE }],
        cause: { rule: "invoice_status", reason: "constraint" },
      });
    }

    throw error;
  }

  // The zero-row problem: an update that matches nothing is a success to PostgREST. Read the row back
  // and take the status the row says, not the one the engine hoped for.
  const rows = await dependencies.rest.select(
    "invoices",
    `select=id,status,number,issued_at,voided_at` +
      `&id=eq.${input.row.id}&company_id=eq.${input.row.company_id}&limit=1`,
    z.object({
      id: z.string().uuid(),
      status: z.enum(INVOICE_STATUSES),
      number: z.string().nullable(),
      issued_at: z.string().nullable(),
      voided_at: z.string().nullable(),
    }),
  );
  const after = rows[0];

  if (after === undefined || after.status !== input.to) {
    throw new AppError("CONFLICT", {
      details: [{ field: "status", rule: "already_changed" }],
      cause: { rule: "invoice_status", reason: "moved_while_in_flight" },
    });
  }

  await dependencies.rest.insert(
    "invoice_events",
    [
      {
        company_id: input.row.company_id,
        invoice_id: input.row.id,
        type: input.event.type,
        actor: INVOICE_EVENT_ACTOR,
        actor_user_id: input.actor.userId,
        detail: input.event.detail,
        occurred_at: at,
      },
    ],
  );

  await dependencies.audit.append({
    action: input.audit.action,
    actorUserId: input.actor.userId,
    entityType: INVOICE_AUDIT_ENTITY,
    entityId: input.row.id,
    companyId: input.row.company_id,
    sessionId: input.actor.sessionId ?? null,
    payload: { from: input.row.status, to: input.to, ...input.audit.payload },
  });

  return {
    invoiceId: input.row.id,
    companyId: input.row.company_id,
    from: input.row.status,
    to: input.to,
    number: after.number,
    at: after.issued_at ?? after.voided_at ?? at,
  };
}

/** Read one live invoice of the actor's own company, in the columns a move needs. */
async function readStatusRow(
  dependencies: InvoiceStatusDependencies,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<StatusRow> {
  if (!z.string().uuid().safeParse(input.invoiceId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    "invoices",
    `${STATUS_ROW_COLUMNS}&id=eq.${input.invoiceId}&company_id=eq.${input.companyId}&deleted_at=is.null&limit=1`,
    statusRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "invoice", reason: "not_found" } });
  }

  return row;
}

/**
 * Send a draft: the draft becomes a numbered, issued document.
 *
 * The number comes from `0114`'s counter through `takeInvoiceNumber`, and the sequence is fixed by
 * `invoices_issue_check`, which requires the number and the issue instant to appear with the status:
 * take the number, then write status + number + issued_at in one update. If the update fails after the
 * number was taken, the number stays consumed - a gap in a series is evident, a duplicate is a legal
 * problem, and the counter is not something this service returns numbers to.
 */
export async function sendInvoice(
  input: { readonly actor: RequestActor; readonly invoiceId: unknown },
  dependencies: InvoiceStatusDependencies,
): Promise<InvoiceStatusResult> {
  requireAnyRole(input.actor, INVOICE_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  if (typeof input.invoiceId !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const row = await readStatusRow(dependencies, { companyId, invoiceId: input.invoiceId });

  if (row.status !== "draft") {
    // A document that has left the editor is not sent twice: a number is assigned once, and a second
    // send would ask the counter for a second number for a document that already has one.
    throw new AppError("CONFLICT", {
      details: [{ field: "status", rule: "already_changed" }],
      cause: { rule: "invoice_status", reason: "not_a_draft" },
    });
  }

  const at = new Date(dependencies.now?.() ?? Date.now()).toISOString();
  const taken = await takeInvoiceNumber(
    { actor: input.actor, companyId },
    {
      rest: dependencies.rest,
      audit: dependencies.audit,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    },
  );

  return applyTransition(dependencies, {
    actor: input.actor,
    row,
    to: "sent",
    extra: { number: taken.number, issued_at: at },
    event: { type: INVOICE_EVENT_SENT, detail: null },
    audit: {
      action: INVOICE_SENT_AUDIT_ACTION,
      payload: { number: taken.number, total_minor: row.total_minor, currency: row.currency },
    },
  });
}

/**
 * Void an open document: a draft, or anything issued that is not yet paid, becomes void.
 *
 * The reason is the merchant's own words for the timeline - what the void means - and it is optional,
 * because a void does not need one. It is not written to the document itself: `0022` has no reason
 * column on the invoice, and the timeline row that exists exactly for this keeps it.
 */
export async function voidInvoice(
  input: {
    readonly actor: RequestActor;
    readonly invoiceId: unknown;
    readonly reason?: unknown;
  },
  dependencies: InvoiceStatusDependencies,
): Promise<InvoiceStatusResult> {
  requireAnyRole(input.actor, INVOICE_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  if (typeof input.invoiceId !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  const reason = parseVoidReason(input.reason);
  const row = await readStatusRow(dependencies, { companyId, invoiceId: input.invoiceId });

  if (row.status === "void") {
    throw new AppError("CONFLICT", {
      details: [{ field: "status", rule: "already_changed" }],
      cause: { rule: "invoice_status", reason: "already_void" },
    });
  }

  // The engine raises the paid lock too; it is answered here as well, so the refusal is the same
  // sentence on every path that meets a paid document.
  if (row.status === "paid") {
    throw new AppError("CONFLICT", {
      details: [{ field: "status", rule: INVOICE_PAID_LOCKED_RULE }],
    });
  }

  const at = new Date(dependencies.now?.() ?? Date.now()).toISOString();

  return applyTransition(dependencies, {
    actor: input.actor,
    row,
    to: "void",
    extra: { voided_at: at },
    event: { type: INVOICE_EVENT_VOIDED, detail: reason },
    audit: {
      action: INVOICE_VOIDED_AUDIT_ACTION,
      payload: {
        number: row.number,
        total_minor: row.total_minor,
        currency: row.currency,
        reason_present: reason !== null,
      },
    },
  });
}

/** The reason the merchant gives for a void, trimmed and bounded, or nothing at all. */
function parseVoidReason(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "reason", rule: "invalid_format" }] });
  }

  const trimmed = value.trim();

  if (
    trimmed.length < INVOICE_VOID_REASON_LIMITS.min ||
    trimmed.length > INVOICE_VOID_REASON_LIMITS.max
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "reason", rule: trimmed.length === 0 ? "empty" : "too_long" }],
    });
  }

  return trimmed;
}
