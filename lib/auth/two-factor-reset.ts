// path: lib/auth/two-factor-reset.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../security/text.ts";
import type { AuditTrail } from "./audit.ts";
import type { RestClient } from "./rest.ts";
import { requireAnyRole } from "./session.ts";
import type { PlatformRole, RequestActor } from "./types.ts";

/**
 * The reset a merchant asks for when the authenticator app and the backup codes are both gone.
 *
 * Section 22 gives the process in one sentence and in four parts, and every part is an act by a
 * different party: the merchant contacts the platform by email, supplies documents, the office
 * resets the second factor, and the merchant enrols again after signing in. This module is the
 * three steps the platform can verify, and it deliberately refuses to be the fourth - the enrolment
 * stays STEP 041's, reached by signing in normally once the factor is gone.
 *
 * ## Why the request is anonymous and the decision is not
 *
 * The person asking cannot sign in: that is the premise of the request, so requiring a session would
 * make the feature unreachable exactly when it is needed. The request therefore takes an address and
 * a reason and nothing else, and it answers the same sentence whether or not that address has an
 * account - the rule of section 22 that "error messages never reveal whether an account exists"
 * applies to a form that is, in effect, an account oracle.
 *
 * The decision is the opposite: it clears a second factor, which is the difference between an
 * account with two locks and an account with one. It requires a session, an office role, and a
 * `contacted` request - an approval cannot skip the record of the contact and the documents, because
 * the audit trail is the only place that says a human verified the person.
 *
 * ## What the reset does, and does not, do
 *
 * It clears `totp_secret_ciphertext`, `totp_confirmed_at` and `backup_code_hashes`, together, in one
 * update: a confirmed account with no secret would fail `users_totp_confirmation_check`, and a
 * cleared confirmation with the old codes left behind would be a set of ten working codes nobody
 * knows about. It does not touch the password, the session table, or the account status - this is a
 * second factor reset, not a suspension.
 *
 * The documents themselves are not handled here. The encrypted file pipeline is STEP 100's, so the
 * office records a *reference* to what it verified - a sentence naming the proof supplied by email -
 * which is what the audit needs and what a later storage STEP can turn into a link.
 */

/** The roles that may look at a reset request and decide it. */
export const TWO_FACTOR_RESET_OFFICE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
  "support",
] as const satisfies readonly PlatformRole[]);

/** The sentence every request answers, whatever the platform found. */
export const RESET_REQUEST_ACCEPTED = true;

export interface ResetDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The merchant's form. An address and what happened, bounded and trimmed. */
export const resetRequestInputSchema = z
  .object({
    email: z.string().trim().toLowerCase().min(3).max(254),
    reason: z
      .string()
      .trim()
      .min(10)
      .max(1_000)
      .transform((value) => sanitizeMultilineText(value, 1_000)),
  })
  .strict();

export interface RequestResetInput {
  readonly request: unknown;
  readonly remoteIp: string | null;
  readonly userAgent: string | null;
}

export interface RequestedReset {
  /**
   * Always true. The form has one answer because the platform must not say whether the address has
   * an account with a second factor.
   */
  readonly accepted: true;
}

export interface ResetDecisionInput {
  readonly actor: RequestActor;
  readonly requestId: string;
  readonly action: "contacted" | "approve" | "reject";
  /** What the office verified. Required when the contact is recorded. */
  readonly documentReference: string | null;
  /** Why the decision was taken. Required when a request is rejected. */
  readonly note: string | null;
}

export interface ResetDecision {
  readonly status: "contacted" | "approved" | "rejected";
  readonly userId: string;
}

const accountRowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  deleted_at: z.string().nullable(),
  totp_confirmed_at: z.string().nullable(),
});

const requestRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.string().min(1).max(16),
  document_reference: z.string().nullable(),
});

const identifierSchema = z.string().uuid();

/**
 * Ask the office to reset the second factor of the account behind an address.
 *
 * Nothing here tells the caller what the platform found. An address with no account, a closed
 * account, an account that never enrolled and an account that did all produce the same answer, and
 * the only difference is that one of them writes a row and an audit entry.
 */
export async function requestTwoFactorReset(
  input: RequestResetInput,
  dependencies: ResetDependencies,
): Promise<RequestedReset> {
  const parsed = resetRequestInputSchema.safeParse(input.request);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: parsed.error.issues.slice(0, 2).map((issue) => ({
        field: typeof issue.path[0] === "string" ? issue.path[0] : "request",
        rule: "invalid_format",
      })),
    });
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const rows = await dependencies.rest.select(
    "users",
    `select=id,company_id,status,deleted_at,totp_confirmed_at&email=eq.${encodeURIComponent(parsed.data.email)}&limit=1`,
    accountRowSchema,
  );
  const account = rows[0];

  // Only an open account with a confirmed factor has anything to reset. Everything else is answered
  // and forgotten, which is also what keeps this form from becoming an account directory.
  if (
    account === undefined ||
    account.deleted_at !== null ||
    account.status !== "active" ||
    account.totp_confirmed_at === null
  ) {
    return { accepted: RESET_REQUEST_ACCEPTED };
  }

  try {
    await dependencies.rest.insert("two_factor_reset_requests", [
      {
        company_id: account.company_id,
        user_id: account.id,
        status: "pending",
        reason: parsed.data.reason,
        requested_ip: input.remoteIp,
        requested_user_agent: input.userAgent,
      },
    ]);
  } catch (error) {
    // A second live request for one account is `two_factor_reset_requests_live_key` doing its job.
    // The merchant asked twice; the office already has the request, and the answer is the same.
    if (!(error instanceof AppError) || error.code !== "CONFLICT") {
      throw error;
    }

    return { accepted: RESET_REQUEST_ACCEPTED };
  }

  await dependencies.audit.append({
    action: "user.two_factor_reset_requested",
    actorUserId: null,
    entityType: "user",
    entityId: account.id,
    companyId: account.company_id,
    payload: {
      requested_at: new Date(now()).toISOString(),
      reason_length: parsed.data.reason.length,
    },
    ipAddress: input.remoteIp,
    userAgent: input.userAgent,
  });

  return { accepted: RESET_REQUEST_ACCEPTED };
}

/** One row of the office queue, in the names the screen uses. */
export interface TwoFactorResetRequestView {
  readonly id: string;
  readonly userId: string;
  readonly companyId: string | null;
  readonly status: "pending" | "contacted";
  readonly reason: string;
  readonly documentReference: string | null;
  readonly requestedAt: string;
  readonly contactedAt: string | null;
}

export interface ListResetRequestsInput {
  readonly actor: RequestActor;
  /** The roles the caller's route allows; passed in so the check stays in this module. */
  readonly roles: readonly PlatformRole[];
  readonly limit: number;
}

const queueRowSchema = z.object({
  id: z.string().min(1).max(64),
  user_id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  status: z.enum(["pending", "contacted"]),
  reason: z.string().min(1).max(1_000),
  document_reference: z.string().max(200).nullable(),
  created_at: z.string().min(1).max(40),
  contacted_at: z.string().min(1).max(40).nullable(),
});

/**
 * The queue: every request that is still waiting for a decision, oldest first.
 *
 * Only the two live statuses are read, so a settled request leaves the screen by being settled
 * rather than by a filter the screen has to remember. The address is not selected - the office acts
 * on `user_id`, and a queue is the kind of screen that gets left open.
 */
export async function listTwoFactorResetRequests(
  input: ListResetRequestsInput,
  dependencies: Pick<ResetDependencies, "rest">,
): Promise<readonly TwoFactorResetRequestView[]> {
  requireAnyRole(input.actor, input.roles);

  const limit = Number.isFinite(input.limit) ? Math.min(Math.max(Math.trunc(input.limit), 1), 200) : 50;

  const rows = await dependencies.rest.select(
    "two_factor_reset_requests",
    `select=id,user_id,company_id,status,reason,document_reference,created_at,contacted_at&status=in.(pending,contacted)&deleted_at=is.null&order=created_at.asc&limit=${limit}`,
    queueRowSchema,
  );

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    companyId: row.company_id,
    status: row.status,
    reason: row.reason,
    documentReference: row.document_reference,
    requestedAt: row.created_at,
    contactedAt: row.contacted_at,
  }));
}

const documentReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .transform((value) => sanitizeSingleLineText(value, 200));
const noteSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .transform((value) => sanitizeMultilineText(value, 1_000));

async function readRequest(
  dependencies: ResetDependencies,
  requestId: string,
): Promise<z.infer<typeof requestRowSchema>> {
  const rows = await dependencies.rest.select(
    "two_factor_reset_requests",
    `select=id,user_id,company_id,status,document_reference&id=eq.${encodeURIComponent(requestId)}&deleted_at=is.null&limit=1`,
    requestRowSchema,
  );
  const request = rows[0];

  if (request === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  return request;
}

/**
 * Record the contact, or decide the request.
 *
 * One function for the three office actions because they are three transitions of one state machine
 * and share the permission check, the lookup and the audit shape. The transitions are strict:
 *
 *   - `contacted` moves a `pending` request and records what was verified;
 *   - `approve` moves a `contacted` request and clears the account's second factor;
 *   - `reject` moves a `pending` or `contacted` request and records why.
 *
 * Anything else is `CONFLICT`: a request that was already decided cannot be decided again, and an
 * approval that skips the contact has no record of the documents behind it.
 */
export async function decideTwoFactorReset(
  input: ResetDecisionInput,
  dependencies: ResetDependencies,
): Promise<ResetDecision> {
  requireAnyRole(input.actor, TWO_FACTOR_RESET_OFFICE_ROLES);

  const parsedId = identifierSchema.safeParse(input.requestId);

  if (!parsedId.success) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const request = await readRequest(dependencies, parsedId.data);
  const now = dependencies.now ?? ((): number => Date.now());
  const decidedAt = new Date(now()).toISOString();

  if (request.status === "approved" || request.status === "rejected" || request.status === "cancelled") {
    throw new AppError("CONFLICT");
  }

  if (input.action === "contacted") {
    const document = documentReferenceSchema.safeParse(input.documentReference ?? "");

    if (!document.success) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "documentReference", rule: "invalid_format" }],
      });
    }

    if (request.status !== "pending") {
      throw new AppError("CONFLICT");
    }

    await dependencies.rest.update(
      "two_factor_reset_requests",
      `id=eq.${encodeURIComponent(request.id)}`,
      {
        status: "contacted",
        contacted_at: decidedAt,
        document_reference: document.data,
      },
    );

    await dependencies.audit.append({
      action: "user.two_factor_reset_contacted",
      actorUserId: input.actor.userId,
      entityType: "user",
      entityId: request.user_id,
      companyId: request.company_id,
      payload: {
        request_id: request.id,
        document_reference_length: document.data.length,
      },
    });

    return { status: "contacted", userId: request.user_id };
  }

  if (input.action === "reject") {
    const note = noteSchema.safeParse(input.note ?? "");

    if (!note.success) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "note", rule: "invalid_format" }],
      });
    }

    await dependencies.rest.update(
      "two_factor_reset_requests",
      `id=eq.${encodeURIComponent(request.id)}`,
      {
        status: "rejected",
        decided_at: decidedAt,
        decided_by: input.actor.userId,
        decision_note: note.data,
      },
    );

    await dependencies.audit.append({
      action: "user.two_factor_reset_rejected",
      actorUserId: input.actor.userId,
      entityType: "user",
      entityId: request.user_id,
      companyId: request.company_id,
      payload: { request_id: request.id, note_length: note.data.length },
    });

    return { status: "rejected", userId: request.user_id };
  }

  // An approval needs the contact record: the office resets a factor after verifying a person, never
  // because a request was old.
  if (request.status !== "contacted") {
    throw new AppError("CONFLICT");
  }

  await dependencies.rest.update(
    "two_factor_reset_requests",
    `id=eq.${encodeURIComponent(request.id)}`,
    {
      status: "approved",
      decided_at: decidedAt,
      decided_by: input.actor.userId,
      ...(input.note === null ? {} : { decision_note: noteSchema.parse(input.note) }),
    },
  );

  await dependencies.rest.update("users", `id=eq.${encodeURIComponent(request.user_id)}`, {
    totp_secret_ciphertext: null,
    totp_confirmed_at: null,
    backup_code_hashes: [],
  });

  await dependencies.audit.append({
    action: "user.two_factor_reset",
    actorUserId: input.actor.userId,
    entityType: "user",
    entityId: request.user_id,
    companyId: request.company_id,
    payload: {
      request_id: request.id,
      method: "office_reset",
      document_reference_present: request.document_reference !== null,
    },
  });

  return { status: "approved", userId: request.user_id };
}
