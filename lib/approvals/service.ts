// path: lib/approvals/service.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { requireAnyRole } from "../auth/session.ts";
import { requireFreshReauthentication } from "../auth/step-up.ts";
import { isPlatformRole, type PlatformRole, type RequestActor } from "../auth/types.ts";
import {
  APPROVAL_CURRENCY_PATTERN,
  APPROVAL_EXPIRY_MS,
  APPROVAL_LABEL_MAXIMUM_LENGTH,
  APPROVAL_NOTE_MAXIMUM_LENGTH,
  APPROVAL_NOTE_MINIMUM_LENGTH,
  APPROVAL_QUEUE_LIMIT,
  APPROVAL_QUEUE_ROLES,
  amountProblemOf,
  canRequestApproval,
  isApprovalActionType,
  isApprovalStatus,
  requesterRolesOf,
  requestableActionsOf,
  stageOf,
  subjectTypeOf,
  type ApprovalActionType,
  type ApprovalStatus,
  type ApprovalSubjectType,
} from "./registry.ts";

/**
 * The CEO's queue: raising a large action, and reading what is waiting for a decision.
 *
 * ## What this STEP builds and what it deliberately does not
 *
 * Section 2 gives the CEO a dashboard, approvals and a final signature. This module builds the queue
 * and the act of raising a request; the decisions themselves - the CEO's approve or reject and the
 * super administrator's confirmation - are STEP 072's, which will write the two decision column pairs
 * `0095` already constrains. That split is why the table carries the whole state machine today: the
 * queue has to be able to say whose desk a row is on before anybody can act on it.
 *
 * ## The permission model
 *
 * Two rules, both in this file so a second caller cannot reach a weaker path:
 *
 *   - raising a request needs a role from `requestableActionsOf`, which is narrower than the office
 *     charters: finance operations raise payout and reserve releases, the super administrator raises
 *     the platform fee and the country switch, and the CEO raises nothing because the CEO signs;
 *   - reading the queue is the CEO's and the super administrator's, both stages, because a signer
 *     should know what is behind the desk in front of them.
 *
 * A mutation also needs a fresh second factor (STEP 053). A request says "this money may move", and a
 * session that has not proved itself in the last ten minutes is not allowed to say it.
 *
 * ## Why the read is not audited and every write is
 *
 * A signer refreshing their own queue is not an event. Every request raised here appends
 * `approval.requested` with the action, the subject, the amount and the note length, so the trail
 * answers "who asked for what, and when" without storing the note twice.
 */

/** The four tables this module needs: the queue, the accounts behind it, and the two summaries. */
export type ApprovalStore = Omit<RestClient, "rpc">;

export interface ApprovalDependencies {
  readonly store: ApprovalStore;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** One row of the queue, as the screen reads it. */
export interface ApprovalRequestView {
  readonly id: string;
  readonly actionType: ApprovalActionType;
  readonly subjectType: ApprovalSubjectType;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly note: string;
  readonly requesterId: string;
  /** The requester's name, when the accounts table answered. The queue still reads without it. */
  readonly requesterName: string | null;
  readonly requesterRole: PlatformRole;
  readonly requestedAtEpochMs: number;
  readonly expiresAtEpochMs: number;
  /** True when the window has passed. The status becomes `expired` when STEP 072 sweeps it. */
  readonly expired: boolean;
  readonly status: ApprovalStatus;
  /** Whose desk the row is on. `closed` for anything no longer waiting. */
  readonly stage: "ceo" | "super_admin" | "closed";
  readonly version: number;
}

/** What the CEO home reads: the two desks, and the actions this account may raise. */
export interface ApprovalQueueSnapshot {
  readonly awaitingCeo: readonly ApprovalRequestView[];
  readonly awaitingSuperAdmin: readonly ApprovalRequestView[];
  readonly requestable: readonly ApprovalActionType[];
  readonly readAtEpochMs: number;
}

/** The two platform summaries the home shows beside the queue. */
export interface PlatformDecisionSummary {
  readonly countriesEnabled: number;
  readonly countriesDisabled: number;
  readonly countriesSanctioned: number;
  readonly kycAwaitingFinalDecision: number;
}

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/u);

const instantSchema = z.string().min(1).max(40);

/** `bigint` reaches JSON as a number, and as a string when it is larger than a double can hold. */
const amountSchema = z
  .union([z.number(), z.string().regex(/^[0-9]+$/u)])
  .nullable();

const requestRowSchema = z.object({
  id: z.string().min(1).max(64),
  action_type: z.string().min(1).max(40),
  subject_type: z.string().min(1).max(20),
  subject_id: z.string().min(1).max(64),
  subject_label: z.string().min(1).max(APPROVAL_LABEL_MAXIMUM_LENGTH),
  amount_minor: amountSchema,
  currency: z.string().length(3).nullable(),
  request_note: z.string().min(APPROVAL_NOTE_MINIMUM_LENGTH).max(APPROVAL_NOTE_MAXIMUM_LENGTH),
  requested_by: z.string().min(1).max(64),
  requested_by_role: z.string().min(1).max(20),
  requested_at: instantSchema,
  expires_at: instantSchema,
  status: z.string().min(1).max(20),
  version: z.number().int().positive(),
});

const insertedRequestSchema = z.object({ id: z.string().min(1).max(64) });

const accountRowSchema = z.object({
  id: z.string().min(1).max(64),
  full_name: z.string().max(120),
});

const countRowSchema = z.object({ id: z.string().min(1).max(64) });

const queueSelect =
  "select=id,action_type,subject_type,subject_id,subject_label,amount_minor,currency," +
  "request_note,requested_by,requested_by_role,requested_at,expires_at,status,version" +
  "&deleted_at=is.null&order=requested_at.asc&limit=" +
  String(APPROVAL_QUEUE_LIMIT);

function nowOf(dependencies: ApprovalDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function epochOf(value: string): number {
  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

/** A stored amount as a number, or null when the row moves no money. */
function amountOf(value: z.infer<typeof amountSchema>): number | null {
  if (value === null) {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function viewOf(
  row: z.infer<typeof requestRowSchema>,
  names: ReadonlyMap<string, string>,
  instant: number,
): ApprovalRequestView {
  if (
    !isApprovalActionType(row.action_type) ||
    !isApprovalStatus(row.status) ||
    !isPlatformRole(row.requested_by_role) ||
    row.subject_type !== subjectTypeOf(row.action_type)
  ) {
    throw new AppError("INTERNAL_ERROR");
  }

  const expiresAtEpochMs = epochOf(row.expires_at);

  return {
    id: row.id,
    actionType: row.action_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    subjectLabel: row.subject_label,
    amountMinor: amountOf(row.amount_minor),
    currency: row.currency,
    note: row.request_note,
    requesterId: row.requested_by,
    requesterName: names.get(row.requested_by) ?? null,
    requesterRole: row.requested_by_role,
    requestedAtEpochMs: epochOf(row.requested_at),
    expiresAtEpochMs,
    expired: expiresAtEpochMs <= instant,
    status: row.status,
    stage: stageOf(row.status),
    version: row.version,
  };
}

/**
 * Raise one request into the chain.
 *
 * The duplicate check is on the partial unique index rather than on a read alone: two people pressing
 * "request" on the same payout at the same moment would pass a read, so the insert is what decides,
 * and a unique violation answers `CONFLICT` with the rule the screen words. The label and the note are
 * trimmed and bounded before they reach the row, and the amount is validated as the pair the column
 * stores.
 */
export async function requestApproval(
  input: {
    readonly actor: RequestActor;
    readonly actionType: string;
    readonly subjectId: string;
    readonly subjectLabel: string;
    readonly amountMinor: number | null;
    readonly currency: string | null;
    readonly note: string;
  },
  dependencies: ApprovalDependencies,
): Promise<ApprovalRequestView> {
  const instant = nowOf(dependencies);

  if (!isApprovalActionType(input.actionType)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "actionType", rule: "invalid_format" }],
    });
  }

  // A signer who is also the requester would be the chain approving itself, so the requester matrix
  // is checked before anything else: it is the rule the screen offers the form by. It is narrower
  // than the queue roles - finance operations raise payouts and reserves without ever seeing the
  // queue - which is why this check names the action rather than the page.
  if (!canRequestApproval(input.actor.roles, input.actionType)) {
    throw new AppError("PERMISSION_DENIED");
  }

  requireFreshReauthentication(input.actor, instant);

  const parsedSubject = identifierSchema.safeParse(input.subjectId);
  const label = input.subjectLabel.trim();
  const note = input.note.trim();
  const amountProblem = amountProblemOf({
    amountMinor: input.amountMinor,
    currency: input.currency,
  });

  if (!parsedSubject.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "subjectId", rule: "invalid_format" }],
    });
  }

  if (label.length < 1 || label.length > APPROVAL_LABEL_MAXIMUM_LENGTH) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "subjectLabel", rule: "invalid_length" }],
    });
  }

  if (note.length < APPROVAL_NOTE_MINIMUM_LENGTH || note.length > APPROVAL_NOTE_MAXIMUM_LENGTH) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "note", rule: "invalid_length" }],
    });
  }

  if (amountProblem !== null) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "amount", rule: amountProblem }],
    });
  }

  const requestedAt = new Date(instant).toISOString();
  const expiresAt = new Date(instant + APPROVAL_EXPIRY_MS).toISOString();
  const actorRole = requesterRoleFor(input.actor.roles, input.actionType);

  // The index is the real guard; this read is what turns the race into a sentence before the insert,
  // because a request for a subject already in the chain is a mistake rather than a conflict.
  const existing = await dependencies.store.select(
    "approval_requests",
    `select=id&action_type=eq.${input.actionType}` +
      `&subject_id=eq.${encodeURIComponent(parsedSubject.data)}` +
      `&status=in.(pending_ceo,pending_super_admin)&deleted_at=is.null&limit=1`,
    countRowSchema,
  );

  if (existing.length > 0) {
    throw new AppError("CONFLICT", { details: [{ field: "subjectId", rule: "duplicate" }] });
  }

  const inserted = await dependencies.store.insertReturning(
    "approval_requests",
    [
      {
        action_type: input.actionType,
        subject_type: subjectTypeOf(input.actionType),
        subject_id: parsedSubject.data,
        subject_label: label,
        amount_minor: input.amountMinor,
        currency: input.currency,
        request_note: note,
        requested_by: input.actor.userId,
        requested_by_role: actorRole,
        requested_at: requestedAt,
        expires_at: expiresAt,
        status: "pending_ceo",
      },
    ],
    insertedRequestSchema,
  );

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  await dependencies.audit.append({
    action: "approval.requested",
    actorUserId: input.actor.userId,
    entityType: "approval_request",
    entityId: row.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    payload: {
      action_type: input.actionType,
      subject_type: subjectTypeOf(input.actionType),
      subject_id: parsedSubject.data,
      subject_label: label,
      ...(input.amountMinor === null ? {} : { amount_minor: input.amountMinor }),
      ...(input.currency === null ? {} : { currency: input.currency }),
      expires_at: expiresAt,
      note_length: note.length,
    },
  });

  return {
    id: row.id,
    actionType: input.actionType,
    subjectType: subjectTypeOf(input.actionType),
    subjectId: parsedSubject.data,
    subjectLabel: label,
    amountMinor: input.amountMinor,
    currency: input.currency,
    note,
    requesterId: input.actor.userId,
    requesterName: null,
    requesterRole: actorRole,
    requestedAtEpochMs: instant,
    expiresAtEpochMs: instant + APPROVAL_EXPIRY_MS,
    expired: false,
    status: "pending_ceo",
    stage: "ceo",
    version: 1,
  };
}

/**
 * Read both desks.
 *
 * Two queries and no loop: the waiting rows, then the names of the accounts that raised them. A row
 * whose account has since been deleted keeps a null name rather than disappearing, because the queue
 * is about the request and not about the requester's account still existing.
 */
export async function listApprovalQueue(
  input: { readonly actor: RequestActor },
  dependencies: ApprovalDependencies,
): Promise<ApprovalQueueSnapshot> {
  requireAnyRole(input.actor, APPROVAL_QUEUE_ROLES);

  const instant = nowOf(dependencies);
  const rows = await dependencies.store.select(
    "approval_requests",
    `${queueSelect}&status=in.(pending_ceo,pending_super_admin)`,
    requestRowSchema,
  );

  const requesterIds = [...new Set(rows.map((row) => row.requested_by))];
  const names = new Map<string, string>();

  if (requesterIds.length > 0) {
    const accounts = await dependencies.store.select(
      "users",
      `select=id,full_name&id=in.(${requesterIds.map((id) => encodeURIComponent(id)).join(",")})` +
        `&limit=${String(APPROVAL_QUEUE_LIMIT)}`,
      accountRowSchema,
    );

    for (const account of accounts) {
      names.set(account.id, account.full_name);
    }
  }

  const views = rows.map((row) => viewOf(row, names, instant));

  return {
    awaitingCeo: views.filter((view) => view.stage === "ceo"),
    awaitingSuperAdmin: views.filter((view) => view.stage === "super_admin"),
    requestable: requestableActionsOf(input.actor.roles),
    readAtEpochMs: instant,
  };
}

/**
 * The two platform summaries the CEO home shows beside the queue.
 *
 * Both are counts over tables whose screens arrive later, so they are read here rather than through a
 * service that does not exist yet - and they are counts, not rows: a home page says how much is
 * waiting, and the screen that acts on it reads the rows it needs. `in_review` is the KYC state the
 * CEO signs off: compliance has reviewed, and the final decision is section 2's.
 */
export async function readPlatformDecisions(
  input: { readonly actor: RequestActor },
  dependencies: ApprovalDependencies,
): Promise<PlatformDecisionSummary> {
  requireAnyRole(input.actor, APPROVAL_QUEUE_ROLES);

  const countries = await dependencies.store.select(
    "countries",
    "select=id,is_enabled,is_sanctioned&company_id=is.null&deleted_at=is.null&limit=500",
    z.object({
      id: z.string().min(1).max(64),
      is_enabled: z.boolean(),
      is_sanctioned: z.boolean(),
    }),
  );

  const kyc = await dependencies.store.select(
    "kyc_submissions",
    "select=id&status=eq.in_review&deleted_at=is.null&limit=500",
    countRowSchema,
  );

  return {
    countriesEnabled: countries.filter((country) => country.is_enabled).length,
    countriesDisabled: countries.filter((country) => !country.is_enabled).length,
    countriesSanctioned: countries.filter((country) => country.is_sanctioned).length,
    kycAwaitingFinalDecision: kyc.length,
  };
}

/**
 * The role a request is recorded under: the first role the actor holds that the action's matrix
 * allows.
 *
 * The column exists because a role can be revoked later, and the queue should still say what authority
 * the request was raised under. `canRequestApproval` has already been checked by the time this runs,
 * so the answer is never empty in practice; the fallback keeps the type honest without inventing a
 * permission that was not there.
 */
export function requesterRoleFor(
  roles: readonly PlatformRole[],
  action: ApprovalActionType,
): PlatformRole {
  const allowed = requesterRolesOf(action);
  const role = roles.find((candidate) => allowed.includes(candidate));

  if (role === undefined) {
    throw new AppError("PERMISSION_DENIED");
  }

  return role;
}

/** True when at least one of these roles may raise at least one action. */
export function mayRequestAnything(roles: readonly PlatformRole[]): boolean {
  return requestableActionsOf(roles).length > 0;
}

/** ISO 4217 codes are stored upper case; a form may send lower case, and this is the one place it is fixed. */
export function normalizeCurrency(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim().toUpperCase();

  return APPROVAL_CURRENCY_PATTERN.test(trimmed) ? trimmed : null;
}
