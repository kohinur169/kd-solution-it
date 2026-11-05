// path: services/invoices/recurring-generation-fields.ts
/**
 * The vocabulary of section 27's recurring generation and the reminders that follow it.
 *
 * This module holds names, numbers and one string builder, and it imports nothing at runtime - the same shape
 * as `recurring-schedule-fields.ts`, for the same reason: the gate imports this file, the service imports this
 * file, and the job handler imports this file, so anything heavier here would be pulled into all three.
 */

/**
 * The status a generated invoice is written with.
 *
 * `draft`, and this is the honest state rather than a cautious one. A recurring invoice is generated from a
 * template the merchant wrote; nothing in this repository can issue an invoice yet - `0022` has no `issued`
 * status, and the numbering service is only ever called from a workflow STEP 116 owns - so a generator that
 * wrote `sent` would have to invent a number and an `issued_at` for a document no merchant ever approved.
 *
 * A draft therefore means what it says: the document exists, and it is not yet a bill. The reminder rules below
 * refuse drafts for exactly that reason, and the handoff records that reminders stay dormant until the issue
 * action exists.
 */
export const RECURRING_GENERATED_STATUS = "draft";

/** The timeline table of `0024`, and the event type of an overdue reminder. */
export const RECURRING_TIMELINE_TABLE = "invoice_events";
export const RECURRING_REMINDER_EVENT_TYPE = "overdue_reminder";

/**
 * Who writes a reminder event: `system`, with no user id.
 *
 * `invoice_events_actor_user_check` refuses a `system` row that carries a user, and that constraint is right:
 * a scheduled job has no person behind it, and naming one would blame a merchant for the platform's timetable.
 */
export const RECURRING_EVENT_ACTOR = "system";

/**
 * The invoice statuses a reminder may act on, and it is the list `invoices_due_reminder_idx` was built for.
 *
 * `0022` writes "the overdue sweep of section 27 reads the open invoices that are due" above an index whose
 * predicate is `status in ('sent', 'viewed', 'partially_paid') and deleted_at is null`. That index serves the
 * sweep that *finds* due documents, so its predicate stops at `partially_paid`: an `overdue` document is not
 * found, it simply is. `0120` adds the index this constant is written for, whose predicate is the same four
 * statuses - because a document that has become overdue is exactly the one whose reminders must go on, and a
 * reminder sweep that stopped at the moment an invoice became overdue would stop where the work matters most.
 *
 * As with its predecessor, the constant is the predicate written once, so the query below and the index cannot
 * drift: if the list here were wider than the index, PostgreSQL would still answer correctly and stop using
 * the index, and nobody would notice until a merchant had enough invoices to feel it.
 *
 * `draft` is absent on purpose: an unissued document is not late, because it was never sent to anyone.
 */
export const RECURRING_REMINDER_STATUSES = Object.freeze([
  "sent",
  "viewed",
  "partially_paid",
  "overdue",
] as const);

export type RecurringReminderStatus = (typeof RECURRING_REMINDER_STATUSES)[number];

/** True when a status is one the reminder sweep may act on. */
export function isRecurringReminderStatus(value: unknown): value is RecurringReminderStatus {
  return typeof value === "string" && (RECURRING_REMINDER_STATUSES as readonly string[]).includes(value);
}

/** The two audit actions this STEP writes. `0013` bounds an action to lower case, dots and 64 characters. */
export const RECURRING_GENERATED_AUDIT_ACTION = "recurring_schedule.generated";
export const RECURRING_REMINDER_QUEUED_AUDIT_ACTION = "recurring_reminder.queued";
export const RECURRING_GENERATION_AUDIT_ENTITY = "recurring_schedule";

/**
 * The dedupe key of one reminder occurrence.
 *
 * `0119` puts a unique partial index on `(company_id, dedupe_key)`, so this string is the database's whole
 * answer to "was this occcurrence already recorded". It must be stable across retries of the same occurrence
 * and different for every other one, which is why it names the schedule, the occurrence date the invoice bills,
 * the invoice and the reminder ordinal - and nothing about when the job ran:
 *
 *   rec:<schedule uuid>:<run_on>:<invoice uuid>:<ordinal>
 *
 * Ninety-one characters for real uuids, inside `invoice_events_dedupe_key_check`'s 8 to 200. Deliberately not
 * `occurred_at`: two runs a microsecond apart would carry two keys for one reminder, which is the duplicate
 * this key exists to prevent.
 */
export function recurringReminderDedupeKey(input: {
  readonly scheduleId: string;
  readonly runOn: string;
  readonly invoiceId: string;
  readonly ordinal: number;
}): string {
  return `rec:${input.scheduleId}:${input.runOn}:${input.invoiceId}:${input.ordinal}`;
}

/** The longest detail an `invoice_events` row may carry, restated so a message is trimmed before the insert. */
export const RECURRING_EVENT_DETAIL_MAX = 500;

/** How many due invoices one sweep reads. A ceiling keeps one run bounded when a merchant has a backlog. */
export const RECURRING_SWEEP_INVOICE_LIMIT = 200;

/** How many companies one reminder sweep visits. Stated rather than unbounded for the same reason. */
export const RECURRING_SWEEP_COMPANY_LIMIT = 200;
