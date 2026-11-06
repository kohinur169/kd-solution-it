// path: services/submerchant/provisioning-queue.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS,
  PROVISIONING_ALERT_ACKNOWLEDGED_AUDIT_ACTION,
  PROVISIONING_ALERT_AUDIT_ENTITY,
  PROVISIONING_ALERT_OFFICE_ROLES,
  PROVISIONING_BLOCKED_AFTER_MS,
  PROVISIONING_COMPANIES_TABLE,
  PROVISIONING_COMPANY_LIMIT,
  PROVISIONING_ACKNOWLEDGEMENT_READ_LIMIT,
  PROVISIONING_QUEUE_LIMIT,
  PROVISIONING_QUEUE_STATUS,
  PROVISIONING_QUEUE_TABLE,
  provisioningWaitReasonOf,
  type ProvisioningProviderKey,
  type ProvisioningWaitReason,
} from "./provisioning-queue-fields.ts";

/**
 * The office end of `0054`'s provisioning queue: the read the alert screen works from, and the one
 * acknowledgement an officer can make.
 *
 * ## What was missing, exactly
 *
 * `0054` declares `submerchant_provisions_queue_idx` with the comment *"The queue the office alert reads:
 * queued and retrying rows, oldest attempt first"*. STEP 095 wrote the rows. **Nothing read them.** A
 * merchant whose final approval produced a queued row because no master platform account was connected
 * was, from the platform's point of view, indistinguishable from a merchant with no provisioning work at
 * all: no screen, no count, no record that a human was needed.
 *
 * FEATURE_LIST line 70 is explicit - *"provisioning stays queued and the office is alerted"* - and the
 * second half of that sentence had no implementation. This module is that half.
 *
 * ## The distinction the read turns on
 *
 * A queued row is `status = 'pending'`. Two very different situations live behind that word, and `0054`
 * already encodes the difference: `master_account_ref` is null when no master platform account is
 * connected for the provider, and non-null when there is one and an attempt is scheduled. The first kind
 * will never progress on its own; the second is ordinary work in flight. `provisioningWaitReasonOf` names
 * the difference rather than leaving it in a comment, and the screen groups by it, because an alert that
 * fires for every provisioning in flight is an alert nobody reads.
 *
 * ## Why the read is not scoped to one company
 *
 * Every other read in this service family carries `company_id` from a session. This one cannot: the
 * office question is "which merchants are stuck across the platform", so the tenant is what the rows
 * carry rather than what the query filters by. That is exactly why the role check comes first, why the
 * result is capped, and why the SQL is read through the office's own actor rather than a background
 * credential. There is no merchant-facing path to this function.
 */

/** What one queued row tells the office. No client name beyond the company it belongs to, and no money. */
export interface ProvisioningQueueItem {
  readonly provisionId: string;
  readonly companyId: string;
  readonly companyName: string | null;
  readonly kycSubmissionId: string;
  readonly providerKey: ProvisioningProviderKey;
  readonly mode: string;
  readonly reason: ProvisioningWaitReason;
  readonly attemptCount: number;
  readonly requestedAt: string;
  /** Seconds since the row was requested, so the screen can sort by how long somebody has waited. */
  readonly waitingSeconds: number;
  /** True when the row is the platform's fault and has waited longer than the threshold. */
  readonly overdue: boolean;
  readonly acknowledgedAt: string | null;
}

/** The two lists the screen renders, plus the counts a header can state without recomputing them. */
export interface ProvisioningQueue {
  readonly blocked: readonly ProvisioningQueueItem[];
  readonly inFlight: readonly ProvisioningQueueItem[];
  readonly blockedCount: number;
  readonly overdueCount: number;
  readonly inFlightCount: number;
  /** True when the read hit its limit, so the screen can say "and more" rather than implying completeness. */
  readonly truncated: boolean;
  readonly limit: number;
}

export interface ProvisioningQueueDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * The columns a read selects, listed one by one: rule 17, never a `*`.
 *
 * `provider_submerchant_id`, `action_required_detail` and `rejection_reason` are deliberately absent. They
 * are provider-side facts about a merchant's account, and a queue whose purpose is "somebody is stuck"
 * does not need them to be useful. A column that is not selected cannot leak.
 */
const QUEUE_COLUMNS =
  "select=id,company_id,kyc_submission_id,provider_key,mode,status,master_account_ref,attempt_count" +
  ",next_attempt_at,requested_at,deleted_at,version";

const queueRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  kyc_submission_id: z.string().uuid(),
  provider_key: z.string(),
  mode: z.string(),
  status: z.string(),
  master_account_ref: z.string().nullable(),
  attempt_count: z.coerce.number().int(),
  next_attempt_at: z.string().nullable(),
  requested_at: z.string(),
  deleted_at: z.string().nullable(),
  version: z.coerce.number().int(),
});

const companyRowSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

/**
 * The queue one office account may read.
 *
 * The two guards, in this order, are the same two the unlock screen asks before it shows a single lock:
 * the role from the session (never from the body, never from a claim), then the second factor - because a
 * support account that has not proved its second factor may not enumerate which merchants are stuck.
 */
export async function listProvisioningQueue(
  input: { readonly actor: RequestActor },
  dependencies: ProvisioningQueueDependencies,
): Promise<ProvisioningQueue> {
  requireAnyRole(input.actor, PROVISIONING_ALERT_OFFICE_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const instantMs = dependencies.now?.() ?? Date.now();

  const rows = await dependencies.rest.select(
    PROVISIONING_QUEUE_TABLE,
    `${QUEUE_COLUMNS}&status=eq.${PROVISIONING_QUEUE_STATUS}&deleted_at=is.null` +
      `&order=requested_at.asc&limit=${String(PROVISIONING_QUEUE_LIMIT)}`,
    queueRowSchema,
  );

  const companyIds = [...new Set(rows.map((row) => row.company_id))];
  let names: ReadonlyMap<string, string> = new Map();

  if (companyIds.length > 0) {
    const companies = await dependencies.rest.select(
      PROVISIONING_COMPANIES_TABLE,
      `select=id,name&id=in.(${companyIds
        .slice(0, PROVISIONING_COMPANY_LIMIT)
        .map((id) => encodeURIComponent(id))
        .join(",")})&deleted_at=is.null&limit=${String(PROVISIONING_COMPANY_LIMIT)}`,
      companyRowSchema,
    );

    names = new Map(companies.map((company) => [company.id, company.name]));
  }

  const acknowledged = await readAcknowledgements(rows.map((row) => row.id), dependencies);

  const items: ProvisioningQueueItem[] = rows.map((row) => {
    const reason = provisioningWaitReasonOf(row);
    const requestedMs = Date.parse(row.requested_at);
    const waitingMs = Number.isNaN(requestedMs) ? 0 : Math.max(0, instantMs - requestedMs);

    return {
      provisionId: row.id,
      companyId: row.company_id,
      companyName: names.get(row.company_id) ?? null,
      kycSubmissionId: row.kyc_submission_id,
      providerKey: row.provider_key as ProvisioningProviderKey,
      mode: row.mode,
      reason,
      attemptCount: row.attempt_count,
      requestedAt: row.requested_at,
      waitingSeconds: Math.floor(waitingMs / 1000),
      // Only the platform's own fault is "overdue". A row waiting on the provider is not late, it is in
      // progress, and calling it overdue would train the office to ignore the column.
      overdue: reason !== "awaiting_provider" && waitingMs >= PROVISIONING_BLOCKED_AFTER_MS,
      acknowledgedAt: acknowledged.get(row.id) ?? null,
    };
  });

  const blocked = items.filter((item) => item.reason === "no_master_account");

  return {
    blocked,
    inFlight: items.filter((item) => item.reason !== "no_master_account"),
    blockedCount: blocked.length,
    overdueCount: blocked.filter((item) => item.overdue).length,
    inFlightCount: items.filter((item) => item.reason !== "no_master_account").length,
    truncated: rows.length >= PROVISIONING_QUEUE_LIMIT,
    limit: PROVISIONING_QUEUE_LIMIT,
  };
}

/**
 * Record that an officer has seen a blocked row.
 *
 * ## Why this is an audit entry and no column at all
 *
 * The alert is only useful if the office can make it stop claiming attention; without a record, "I have
 * looked at this" lives in somebody's memory and the screen is read again every morning. But the
 * acknowledgement is not a state of the provision. `0054`'s vocabulary is `pending, action_required,
 * verified, restricted, rejected` and `submerchant_provisions_guard_state` decides which moves are legal;
 * the row is still `pending` afterwards because the merchant is still stuck.
 *
 * So this module writes **nothing to the provision row**. It appends one entry to `audit_logs`, which is
 * the platform's existing append-only record of who did what, when, and why - and which carries the actor,
 * the instant and the note already. Adding a column to `0054` would mean this STEP editing a table STEP 095
 * owns and a schema that has no gap; using the trail means no migration, no new invariant, and one place
 * where "a human looked at this" is written.
 *
 * The read above resolves the acknowledgements the same way: one bounded query over the same action.
 */
export async function acknowledgeProvisioningAlert(
  input: {
    readonly actor: RequestActor;
    readonly provisionId: unknown;
    readonly note: unknown;
  },
  dependencies: ProvisioningQueueDependencies,
): Promise<{ readonly provisionId: string; readonly acknowledgedAt: string }> {
  requireAnyRole(input.actor, PROVISIONING_ALERT_OFFICE_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const provisionId = parseProvisionId(input.provisionId);
  const note = parseNote(input.note);
  const instantMs = dependencies.now?.() ?? Date.now();
  const acknowledgedAt = new Date(instantMs).toISOString();

  // The row is read before it is acknowledged, so an acknowledgement cannot name a provision that does not
  // exist. The read is by id because the office is not scoped to one company - the role check above and the
  // second factor are what make that safe.
  const [row] = await dependencies.rest.select(
    PROVISIONING_QUEUE_TABLE,
    `select=id,company_id,status,master_account_ref&id=eq.${encodeURIComponent(provisionId)}` +
      `&deleted_at=is.null&limit=1`,
    z.object({
      id: z.string().uuid(),
      company_id: z.string().uuid(),
      status: z.string(),
      master_account_ref: z.string().nullable(),
    }),
  );

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (row.status !== PROVISIONING_QUEUE_STATUS) {
    // A row that has moved on is not a queue row any more: acknowledging it would write a record about a
    // question nobody is asking.
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "not_queued" }] });
  }

  // Two officers clicking at once produce two entries rather than a lie. The trail is append-only and a
  // duplicate acknowledgement is harmless - it says two people looked - so this needs no uniqueness guard,
  // and inventing one would mean a column on a table this STEP does not own.
  try {
    await dependencies.audit.append({
      action: PROVISIONING_ALERT_ACKNOWLEDGED_AUDIT_ACTION,
      actorUserId: input.actor.userId,
      entityType: PROVISIONING_ALERT_AUDIT_ENTITY,
      entityId: row.id,
      companyId: row.company_id,
      sessionId: input.actor.sessionId ?? null,
      payload: {
        note,
        provider_reason: row.master_account_ref === null ? "no_master_account" : "provider",
        // The acknowledgement is a "seen" fact, not a resolution: the row is still queued, and the trail
        // says so that nobody later reads the entry as "fixed".
        resolved: false,
      },
    });
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError("CONFLICT");
    }

    throw error;
  }

  return { provisionId: row.id, acknowledgedAt };
}

/**
 * The acknowledgements already recorded for these rows, newest first per row.
 *
 * One query for the whole page rather than one per row. The cap is the read limit, not the page size: a
 * limit of the page size would let one provision's newer duplicate acknowledgements push an older provision's
 * single one out of the window, and the screen would show "not yet" for a row that was seen. Newest first,
 * first per row, under a cap generous against human duplication. `audit_logs` is append-only and this read
 * takes only the two columns the screen needs, so a note an officer wrote is never carried into a list view.
 */
async function readAcknowledgements(
  provisionIds: readonly string[],
  dependencies: ProvisioningQueueDependencies,
): Promise<ReadonlyMap<string, string>> {
  if (provisionIds.length === 0) {
    return new Map();
  }

  const rows = await dependencies.rest.select(
    "audit_logs",
    `select=entity_id,occurred_at&action=eq.${PROVISIONING_ALERT_ACKNOWLEDGED_AUDIT_ACTION}` +
      `&entity_type=eq.${PROVISIONING_ALERT_AUDIT_ENTITY}` +
      `&entity_id=in.(${provisionIds.map((id) => encodeURIComponent(id)).join(",")})` +
      `&order=occurred_at.desc&limit=${String(PROVISIONING_ACKNOWLEDGEMENT_READ_LIMIT)}`,
    z.object({ entity_id: z.string(), occurred_at: z.string() }),
  );

  const acknowledged = new Map<string, string>();

  // Newest first, and the first entry per row wins: a second acknowledgement does not move the mark
  // forward, because the question "has anybody looked at this" was already answered.
  for (const row of rows) {
    if (row.entity_id !== null && !acknowledged.has(row.entity_id)) {
      acknowledged.set(row.entity_id, row.occurred_at);
    }
  }

  return acknowledged;
}

function parseProvisionId(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 64) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  return value;
}

/**
 * The note an officer leaves, validated on this side before it is written.
 *
 * `0013` bounds an audit payload by size, not by meaning, so the bound that matters is this one. The text is
 * left as typed - an internal note about an internal queue, read by staff and never rendered to a client -
 * but it is trimmed and its length is checked, so a note cannot be whitespace.
 */
function parseNote(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "note", rule: "required" }] });
  }

  const trimmed = value.trim();

  if (
    trimmed.length < PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS.min ||
    trimmed.length > PROVISIONING_ACKNOWLEDGEMENT_NOTE_LIMITS.max
  ) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "note", rule: "length" }] });
  }

  return trimmed;
}
