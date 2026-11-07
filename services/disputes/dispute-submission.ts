// path: services/disputes/dispute-submission.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { hasSatisfiedTwoFactor, requireAnyRole } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { getMessage } from "../../lib/i18n/messages.ts";
import { PROVIDER_KEYS, isProviderKey, type ProviderKey } from "../../lib/payments/registry.ts";
import { appendTolerated } from "../payments/refund.ts";
import {
  DISPUTE_PAYMENT_COLUMNS,
  disputePaymentRowSchema,
  disputeRowSchema,
  disputeViewOf,
  type DisputeView,
} from "./dispute.ts";
import { DISPUTE_AUDIT, DISPUTE_AUDIT_ENTITY } from "./dispute-fields.ts";
import {
  DISPUTE_REVIEW_DECISIONS,
  DISPUTE_REVIEW_HISTORY_LIMIT,
  DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH,
  DISPUTE_REVIEW_NOTE_MINIMUM_LENGTH,
  DISPUTE_REVIEW_QUEUE_LIMIT,
  DISPUTE_REVIEW_ROLES,
  DISPUTE_SUBMISSION_FIELD,
  DISPUTE_SUBMISSION_MAX_ATTEMPTS,
  DISPUTE_SUBMISSION_REFERENCE_KIND,
  DISPUTE_SUBMISSION_REFERENCE_MAXIMUM_LENGTH,
  DISPUTE_SUBMISSION_REFERENCE_MINIMUM_LENGTH,
  DISPUTE_SUBMISSION_RULES,
  DISPUTE_SUBMISSION_TEMPLATE_KEY,
  isDisputeSubmissionChannel,
  isDisputeSubmissionStatus,
  type DisputeReviewDecision,
  type DisputeSubmissionChannel,
  type DisputeSubmissionStatus,
} from "./dispute-submission-fields.ts";
import {
  submissionPortFor,
  type DisputeSubmissionDocument,
  type DisputeSubmissionItem,
  type DisputeSubmissionOutcome,
  type DisputeSubmissionPorts,
  type DisputeSubmissionTarget,
} from "./dispute-submission-provider.ts";

/**
 * Section 19's last disputes sentence: "compliance_kyc reviews the evidence pack and sends it to the processor."
 *
 * ## What this module is
 *
 * The two acts of that sentence and the reads around them. A compliance officer reads a merchant's frozen pack -
 * its four parts, its documents, its digest - and decides: approved, or declined with a reason. An approved pack
 * is then sent, through the processor's API when this build has a documented one for that provider and through
 * the desk's own hands when it does not, and `0039`'s `evidence_submitted` status moves because a *sent*
 * submission row exists rather than because a caller said so.
 *
 * ## Why the review is a row and not a column
 *
 * A decision is a judgement with a name, a reason and an instant on it, and one pack can be looked at more than
 * once: a desk that declined a pack in the morning may approve it after speaking to the merchant, and both
 * decisions are true statements about different moments. An append-only log keeps both, the latest one is the
 * one that counts (`0127`'s submission guard reads exactly that), and no screen has to guess which of two
 * officers was right.
 *
 * ## Why the claim comes before the call
 *
 * The processor's answer can take a second and the officer can press twice; two calls would send the same
 * evidence twice. So the attempt is claimed first - one live row per pack, which `0127`'s unique index enforces -
 * and then the processor is called. A claim that loses answers `dispute_submission_exists` without calling
 * anybody. A call that fails moves the claim to `failed`, which frees the pack for the next attempt, because a
 * processor outage is not a reason to leave a merchant's dispute unanswered.
 *
 * ## What the merchant is told
 *
 * One `dispute_update` email is queued when the pack lands, through `0061`'s queue and not through an SMTP client
 * of this module's own - the same bargain STEP 196's warnings struck. A mail system that is down does not stop
 * the status move: the evidence has been sent, and the merchant can see it on their screen either way.
 */

/** What the service needs: the database, the signed chain, the ports, and a clock. */
export interface DisputeSubmissionDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly ports: DisputeSubmissionPorts;
  readonly now?: () => number;
}

/** One decision, as a screen prints it. */
export interface DisputeReviewView {
  readonly id: string;
  readonly decision: DisputeReviewDecision;
  readonly note: string;
  readonly packDigest: string;
  readonly reviewerUserId: string;
  readonly decidedAt: string;
}

/** One attempt to send a pack, as a screen prints it. */
export interface DisputeSubmissionView {
  readonly id: string;
  readonly channel: DisputeSubmissionChannel;
  readonly status: DisputeSubmissionStatus;
  readonly providerKey: string;
  readonly mode: string;
  readonly processorReference: string | null;
  readonly failureRule: string | null;
  readonly note: string | null;
  readonly packDigest: string;
  readonly itemCount: number;
  readonly documentCount: number;
  readonly submittedByUserId: string;
  readonly claimedAt: string;
  readonly sentAt: string | null;
}

/** One record of the pack, as the reviewer reads it. */
export interface ReviewItemView {
  readonly id: string;
  readonly section: string;
  readonly sourceKind: string;
  readonly label: string;
  readonly summary: string | null;
  readonly capturedAt: string;
}

/** One supplied document, as the reviewer reads it. */
export interface ReviewDocumentView {
  readonly id: string;
  readonly section: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly caption: string | null;
  readonly contentSha256: string;
  readonly addedAt: string;
}

/** The frozen pack the desk is looking at. Null until the merchant freezes one. */
export interface ReviewPackView {
  readonly id: string;
  readonly digest: string;
  readonly itemCount: number;
  readonly documentCount: number;
  readonly frozenAt: string;
  readonly version: number;
  readonly items: readonly ReviewItemView[];
  readonly documents: readonly ReviewDocumentView[];
  /** The four parts the pack covers, by name, in section 19's order. */
  readonly sections: readonly string[];
}

/** The whole answer one review screen renders. */
export interface DisputeReviewPageView {
  readonly dispute: DisputeView;
  readonly pack: ReviewPackView | null;
  /** The provider the disputed payment was taken through, as `payment_providers` names it. */
  readonly providerKey: string | null;
  readonly mode: string | null;
  readonly reviews: readonly DisputeReviewView[];
  readonly submission: DisputeSubmissionView | null;
  /** True when this officer may record a decision on this pack right now. */
  readonly mayReview: boolean;
  /** True when the latest decision is an approval, so a submission may be attempted. */
  readonly maySubmit: boolean;
  /** True when this build has a port for that provider, so the API channel can be chosen at all. */
  readonly providerChannel: boolean;
}

/** One row of the desk's queue: a frozen pack nobody has sent yet. */
export interface DisputeReviewQueueRow {
  readonly dispute: DisputeView;
  readonly companyName: string;
  readonly packId: string;
  readonly digest: string;
  readonly itemCount: number;
  readonly documentCount: number;
  readonly frozenAt: string;
  /** The latest decision, or null when the pack has not been looked at. */
  readonly decision: DisputeReviewDecision | null;
}

/** What one submission did. */
export interface DisputeSubmissionResult {
  readonly view: DisputeReviewPageView;
  /** `sent` when this call sent it, `already_sent` when a previous call already had. */
  readonly outcome: "sent" | "already_sent";
  /** The processor's own reference, when there is one. */
  readonly processorReference: string | null;
}

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The clock of one call, defaulting to the wall clock. */
function nowOf(dependencies: DisputeSubmissionDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

/** A refusal carrying the STEP's field and one of its rules. */
function refused(
  code: "VALIDATION_FAILED" | "CONFLICT" | "RESOURCE_NOT_FOUND" | "PERMISSION_DENIED",
  rule: string,
): AppError {
  return new AppError(code, { details: [{ field: DISPUTE_SUBMISSION_FIELD, rule }] });
}

/* -------------------------------------------------------------------------------------------------
 * Rows
 * ---------------------------------------------------------------------------------------------- */

const reviewRowSchema = z.object({
  id: z.string().uuid(),
  pack_id: z.string().uuid(),
  decision: z.string(),
  note: z.string(),
  pack_digest: z.string(),
  reviewer_user_id: z.string().uuid(),
  decided_at: z.string(),
});

const submissionRowSchema = z.object({
  id: z.string().uuid(),
  pack_id: z.string().uuid(),
  channel: z.string(),
  status: z.string(),
  provider_key: z.string(),
  mode: z.string(),
  processor_reference: z.string().nullable(),
  failure_rule: z.string().nullable(),
  note: z.string().nullable(),
  pack_digest: z.string(),
  item_count: z.number(),
  document_count: z.number(),
  submitted_by_user_id: z.string().uuid(),
  claimed_at: z.string(),
  sent_at: z.string().nullable(),
});

const packRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  dispute_id: z.string().uuid(),
  status: z.string(),
  digest: z.string().nullable(),
  item_count: z.number(),
  document_count: z.number(),
  frozen_at: z.string().nullable(),
  version: z.number(),
});

const itemRowSchema = z.object({
  id: z.string().uuid(),
  section: z.string(),
  source_kind: z.string(),
  label: z.string(),
  summary: z.string().nullable(),
  captured_at: z.string(),
});

const documentRowSchema = z.object({
  id: z.string().uuid(),
  section: z.string(),
  file_name: z.string(),
  content_type: z.string(),
  byte_size: z.number(),
  caption: z.string().nullable(),
  content_sha256: z.string(),
  added_at: z.string(),
});

const providerRowSchema = z.object({
  id: z.string().uuid(),
  provider_key: z.string(),
});

const idSchema = z.object({ id: z.string().uuid() });

const ownerSchema = z.object({ user_id: z.string().uuid() });

const addressSchema = z.object({ email: z.string() });

const methodSchema = z.object({ method: z.enum(["smtp", "api"]) });

/* -------------------------------------------------------------------------------------------------
 * Reads
 * ---------------------------------------------------------------------------------------------- */

/** One dispute by id, with the columns every screen prints. `null` when it is not this desk's to read. */
async function readDispute(dependencies: DisputeSubmissionDependencies, disputeId: string) {
  const rows = await dependencies.rest.select(
    "disputes",
    "select=id,company_id,payment_id,processor_dispute_id,status,reason_code,amount_minor,currency,fee_minor" +
      ",opened_at,response_window_hours,response_due_at,evidence_ready,response_text,response_saved_at" +
      `,submitted_at,resolved_at,outcome_note,created_at,updated_at,version&id=eq.${encodeURIComponent(disputeId)}` +
      "&deleted_at=is.null&limit=1",
    disputeRowSchema,
  );

  return rows[0] ?? null;
}

/** The dispute the review is about, or the refusal a caller who may not see it reads. */
async function requireDisputed(
  dependencies: DisputeSubmissionDependencies,
  disputeId: string,
): Promise<ReturnType<typeof disputeViewOf>> {
  const row = identifierPattern.test(disputeId) ? await readDispute(dependencies, disputeId) : null;

  if (row === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_SUBMISSION_RULES.disputeNotFound);
  }

  return disputeViewOf(row, nowOf(dependencies));
}

/** The frozen pack of one dispute, with its rows. A draft is not evidence and is not shown to the desk. */
async function readFrozenPack(
  dependencies: DisputeSubmissionDependencies,
  dispute: DisputeView,
): Promise<ReviewPackView | null> {
  const packs = await dependencies.rest.select(
    "dispute_evidence_packs",
    "select=id,company_id,dispute_id,status,digest,item_count,document_count,frozen_at,version" +
      `&dispute_id=eq.${encodeURIComponent(dispute.id)}&company_id=eq.${encodeURIComponent(dispute.companyId)}` +
      "&deleted_at=is.null&limit=1",
    packRowSchema,
  );
  const pack = packs[0];

  if (pack === undefined || pack.status !== "frozen" || pack.digest === null || pack.frozen_at === null) {
    return null;
  }

  const [items, documents] = await Promise.all([
    dependencies.rest.select(
      "dispute_evidence_items",
      "select=id,section,source_kind,label,summary,captured_at" +
        `&pack_id=eq.${encodeURIComponent(pack.id)}&deleted_at=is.null` +
        "&order=section.asc,captured_at.asc&limit=200",
      itemRowSchema,
    ),
    dependencies.rest.select(
      "dispute_evidence_documents",
      "select=id,section,file_name,content_type,byte_size,caption,content_sha256,added_at" +
        `&pack_id=eq.${encodeURIComponent(pack.id)}&deleted_at=is.null` +
        "&order=section.asc,added_at.asc&limit=50",
      documentRowSchema,
    ),
  ]);

  return {
    id: pack.id,
    digest: pack.digest,
    itemCount: pack.item_count,
    documentCount: pack.document_count,
    frozenAt: pack.frozen_at,
    version: pack.version,
    items: items.map((row) => ({
      id: row.id,
      section: row.section,
      sourceKind: row.source_kind,
      label: row.label,
      summary: row.summary,
      capturedAt: row.captured_at,
    })),
    documents: documents.map((row) => ({
      id: row.id,
      section: row.section,
      fileName: row.file_name,
      contentType: row.content_type,
      byteSize: row.byte_size,
      caption: row.caption,
      contentSha256: row.content_sha256,
      addedAt: row.added_at,
    })),
    sections: [...new Set([...items.map((row) => row.section), ...documents.map((row) => row.section)])].sort(),
  };
}

/** The decisions on one pack, latest first. Ten is more than a disputed pack ever collects. */
async function readReviews(
  dependencies: DisputeSubmissionDependencies,
  packId: string,
): Promise<readonly DisputeReviewView[]> {
  const rows = await dependencies.rest.select(
    "dispute_reviews",
    `select=id,pack_id,decision,note,pack_digest,reviewer_user_id,decided_at&pack_id=eq.${encodeURIComponent(packId)}` +
      `&deleted_at=is.null&order=decided_at.desc,id.desc&limit=${String(DISPUTE_REVIEW_HISTORY_LIMIT)}`,
    reviewRowSchema,
  );

  return rows
    .filter((row) => (DISPUTE_REVIEW_DECISIONS as readonly string[]).includes(row.decision))
    .map((row) => ({
      id: row.id,
      decision: row.decision as DisputeReviewDecision,
      note: row.note,
      packDigest: row.pack_digest,
      reviewerUserId: row.reviewer_user_id,
      decidedAt: row.decided_at,
    }));
}

/** The live attempt for one pack - the claim or the answer - if there is one. */
async function readSubmission(
  dependencies: DisputeSubmissionDependencies,
  packId: string,
): Promise<DisputeSubmissionView | null> {
  const rows = await dependencies.rest.select(
    "dispute_submissions",
    "select=id,pack_id,channel,status,provider_key,mode,processor_reference,failure_rule,note,pack_digest,item_count" +
      ",document_count,submitted_by_user_id,claimed_at,sent_at" +
      `&pack_id=eq.${encodeURIComponent(packId)}&deleted_at=is.null&status=in.(sending,sent)` +
      "&order=claimed_at.desc&limit=1",
    submissionRowSchema,
  );
  const row = rows[0];

  if (row === undefined || !isDisputeSubmissionChannel(row.channel) || !isDisputeSubmissionStatus(row.status)) {
    return null;
  }

  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    providerKey: row.provider_key,
    mode: row.mode,
    processorReference: row.processor_reference,
    failureRule: row.failure_rule,
    note: row.note,
    packDigest: row.pack_digest,
    itemCount: row.item_count,
    documentCount: row.document_count,
    submittedByUserId: row.submitted_by_user_id,
    claimedAt: row.claimed_at,
    sentAt: row.sent_at,
  };
}

/** The provider and mode the disputed payment was taken in, which decides whether an API call is possible. */
async function readPaymentRoute(
  dependencies: DisputeSubmissionDependencies,
  dispute: DisputeView,
): Promise<{ readonly providerKey: ProviderKey; readonly providerId: string; readonly mode: string } | null> {
  const payments = await dependencies.rest.select(
    "payments",
    `${DISPUTE_PAYMENT_COLUMNS}&id=eq.${encodeURIComponent(dispute.paymentId)}&deleted_at=is.null&limit=1`,
    disputePaymentRowSchema,
  );
  const payment = payments[0];

  if (payment === undefined) {
    return null;
  }

  const providers = await dependencies.rest.select(
    "payment_providers",
    `select=id,provider_key&id=eq.${encodeURIComponent(payment.provider_id)}&limit=1`,
    providerRowSchema,
  );
  const provider = providers[0];

  if (provider === undefined || !isProviderKey(provider.provider_key)) {
    return null;
  }

  return { providerKey: provider.provider_key, providerId: provider.id, mode: payment.mode };
}

/** One page of the desk's answer, from the pieces above. */
async function pageViewOf(
  input: { readonly actor: RequestActor; readonly disputeId: string },
  dependencies: DisputeSubmissionDependencies,
): Promise<DisputeReviewPageView> {
  const dispute = await requireDisputed(dependencies, input.disputeId);
  const pack = await readFrozenPack(dependencies, dispute);
  const [route, reviews, submission] = await Promise.all([
    readPaymentRoute(dependencies, dispute),
    pack === null ? Promise.resolve<readonly DisputeReviewView[]>([]) : readReviews(dependencies, pack.id),
    pack === null ? Promise.resolve<DisputeSubmissionView | null>(null) : readSubmission(dependencies, pack.id),
  ]);
  const latest = reviews[0] ?? null;
  const decided = dispute.resolvedAt !== null;
  const mayAct = !decided && pack !== null && submission === null;

  return {
    dispute,
    pack,
    providerKey: route?.providerKey ?? null,
    mode: route?.mode ?? null,
    reviews,
    submission,
    mayReview: mayAct,
    maySubmit: mayAct && latest?.decision === "approved",
    providerChannel: route !== null && submissionPortFor(dependencies.ports, route.providerKey) !== null,
  };
}

/**
 * The desk's screen for one dispute: the pack, the decisions on it, and what may be done next.
 *
 * The role is checked here rather than in the page, because a screen that renders an empty pack for an account
 * with no role is a screen that reads like "nothing to do" - and on a queue of deadlines that is the expensive
 * mistake. A dispute of another merchant is not readable at all: there is no merchant scope on this list,
 * because the list *is* the platform's.
 */
export async function readDisputeReview(
  input: { readonly actor: RequestActor; readonly disputeId: string },
  dependencies: DisputeSubmissionDependencies,
): Promise<DisputeReviewPageView> {
  requireAnyRole(input.actor, DISPUTE_REVIEW_ROLES);

  return pageViewOf(input, dependencies);
}

/**
 * The packs waiting for the desk: frozen, not yet sent, nearest deadline first.
 *
 * One query for the packs, one for the disputes they belong to, one for the companies, one for the decisions -
 * four reads per page, never a read per row. A pack that has a live submission is not in the queue, because
 * there is nothing left to decide about it.
 */
export async function listReviewQueue(
  input: { readonly actor: RequestActor },
  dependencies: DisputeSubmissionDependencies,
): Promise<readonly DisputeReviewQueueRow[]> {
  requireAnyRole(input.actor, DISPUTE_REVIEW_ROLES);

  const packs = await dependencies.rest.select(
    "dispute_evidence_packs",
    "select=id,company_id,dispute_id,status,digest,item_count,document_count,frozen_at,version" +
      "&status=eq.frozen&deleted_at=is.null&order=frozen_at.asc" +
      `&limit=${String(DISPUTE_REVIEW_QUEUE_LIMIT)}`,
    packRowSchema,
  );
  const open = packs.filter((pack) => pack.digest !== null && pack.frozen_at !== null);

  if (open.length === 0) {
    return [];
  }

  const disputeIds = [...new Set(open.map((pack) => pack.dispute_id))];
  const packIds = open.map((pack) => pack.id);
  const inList = (ids: readonly string[]): string => `in.(${ids.map((id) => encodeURIComponent(id)).join(",")})`;
  const [disputes, companies, submissions, reviews] = await Promise.all([
    dependencies.rest.select(
      "disputes",
      "select=id,company_id,payment_id,processor_dispute_id,status,reason_code,amount_minor,currency,fee_minor" +
        ",opened_at,response_window_hours,response_due_at,evidence_ready,response_text,response_saved_at" +
        `,submitted_at,resolved_at,outcome_note,created_at,updated_at,version&id=${inList(disputeIds)}` +
        "&deleted_at=is.null",
      disputeRowSchema,
    ),
    dependencies.rest.select(
      "companies",
      `select=id,name&id=${inList([...new Set(open.map((pack) => pack.company_id))])}`,
      z.object({ id: z.string().uuid(), name: z.string() }),
    ),
    dependencies.rest.select(
      "dispute_submissions",
      `select=id,pack_id,channel,status,provider_key,mode,processor_reference,failure_rule,note,pack_digest,item_count` +
        `,document_count,submitted_by_user_id,claimed_at,sent_at&pack_id=${inList(packIds)}` +
        "&deleted_at=is.null&status=in.(sending,sent)",
      submissionRowSchema,
    ),
    dependencies.rest.select(
      "dispute_reviews",
      `select=id,pack_id,decision,note,pack_digest,reviewer_user_id,decided_at&pack_id=${inList(packIds)}` +
        `&deleted_at=is.null&order=decided_at.desc,id.desc&limit=${String(DISPUTE_REVIEW_QUEUE_LIMIT * 4)}`,
      reviewRowSchema,
    ),
  ]);

  const nowMs = nowOf(dependencies);
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const alreadySent = new Set(submissions.map((row) => row.pack_id));
  const latest = new Map<string, DisputeReviewDecision>();

  for (const review of reviews) {
    if (!latest.has(review.pack_id) && (DISPUTE_REVIEW_DECISIONS as readonly string[]).includes(review.decision)) {
      latest.set(review.pack_id, review.decision as DisputeReviewDecision);
    }
  }

  const disputeById = new Map(disputes.map((row) => [row.id, row]));
  const decided: DisputeReviewQueueRow[] = [];

  for (const pack of open) {
    if (alreadySent.has(pack.id) || pack.digest === null || pack.frozen_at === null) {
      continue;
    }

    const row = disputeById.get(pack.dispute_id);

    if (row === undefined || row.resolved_at !== null) {
      continue;
    }

    decided.push({
      dispute: disputeViewOf(row, nowMs),
      companyName: companyNames.get(pack.company_id) ?? "",
      packId: pack.id,
      digest: pack.digest,
      itemCount: pack.item_count,
      documentCount: pack.document_count,
      frozenAt: pack.frozen_at,
      decision: latest.get(pack.id) ?? null,
    });
  }

  return decided.sort((left, right) => left.dispute.responseDueAt.localeCompare(right.dispute.responseDueAt));
}

/* -------------------------------------------------------------------------------------------------
 * The two acts
 * ---------------------------------------------------------------------------------------------- */

/** A body with one decision and one reason, and nothing else. */
export interface DisputeReviewBody {
  readonly decision: DisputeReviewDecision;
  readonly note: string;
}

/** Parse the review body: an unknown key, a missing decision or an empty reason is a refusal. */
export function parseReviewBody(body: unknown): DisputeReviewBody {
  const schema = z
    .object({
      decision: z.enum(DISPUTE_REVIEW_DECISIONS),
      note: z.string(),
    })
    .strict();
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  const note = parsed.data.note.trim();

  if (note.length < DISPUTE_REVIEW_NOTE_MINIMUM_LENGTH || note.length > DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  return { decision: parsed.data.decision, note };
}

/** A body with one channel, the reference a recorded submission carries, and the row's version. */
export interface DisputeSubmissionBody {
  readonly channel: DisputeSubmissionChannel;
  readonly processorReference: string | null;
  readonly note: string | null;
  readonly version: number;
}

/** Parse the submission body. The reference is required exactly when the desk made the call by hand. */
export function parseSubmissionBody(body: unknown): DisputeSubmissionBody {
  const schema = z
    .object({
      channel: z.enum(["provider", "recorded"]),
      processor_reference: z.string().optional(),
      note: z.string().optional(),
      version: z.number().int().positive(),
    })
    .strict();
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  if (parsed.data.channel === "provider") {
    if (parsed.data.processor_reference !== undefined || parsed.data.note !== undefined) {
      // The platform will be told the reference by the processor. A reference typed into the API channel would
      // be a claim about a call this build did not make.
      throw refused("VALIDATION_FAILED", "invalid_format");
    }

    return { channel: "provider", processorReference: null, note: null, version: parsed.data.version };
  }

  const reference = parsed.data.processor_reference?.trim() ?? "";
  const note = parsed.data.note?.trim() ?? "";

  if (
    reference.length < DISPUTE_SUBMISSION_REFERENCE_MINIMUM_LENGTH ||
    reference.length > DISPUTE_SUBMISSION_REFERENCE_MAXIMUM_LENGTH
  ) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  if (note.length > DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH) {
    throw refused("VALIDATION_FAILED", "invalid_format");
  }

  return {
    channel: "recorded",
    processorReference: reference,
    note: note.length === 0 ? null : note,
    version: parsed.data.version,
  };
}

/** One chain entry, tolerated: an audit outage never stops a decision being recorded. */
async function note(
  dependencies: DisputeSubmissionDependencies,
  action: string,
  input: {
    readonly actor: RequestActor;
    readonly dispute: DisputeView;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const entry: AuditEntry = {
    action,
    actorUserId: input.actor.userId,
    entityType: DISPUTE_AUDIT_ENTITY,
    entityId: input.dispute.id,
    payload: input.payload,
    companyId: input.dispute.companyId,
    sessionId: input.actor.sessionId,
    ipAddress: null,
    userAgent: null,
  };

  await appendTolerated(dependencies.audit, entry);
}

/**
 * Record one decision on one frozen pack.
 *
 * Three guards before the write: the role and its second factor, a frozen pack (nothing else is reviewable), and
 * a dispute that is still open. The write itself is one row - `0127`'s trigger re-checks the digest, the tenant
 * and the absence of a live submission, so a service that skipped one of those still cannot record a decision
 * about different evidence.
 */
export async function reviewDisputePack(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly body: unknown },
  dependencies: DisputeSubmissionDependencies,
): Promise<DisputeReviewPageView> {
  requireAnyRole(input.actor, DISPUTE_REVIEW_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const parsed = parseReviewBody(input.body);
  const page = await pageViewOf(input, dependencies);

  if (page.dispute.resolvedAt !== null) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.disputeResolved);
  }

  if (page.pack === null) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.packMissing);
  }

  if (!page.mayReview) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.submissionExists);
  }

  const decidedAt = new Date(nowOf(dependencies)).toISOString();

  try {
    await dependencies.rest.insert("dispute_reviews", [
      {
        company_id: page.dispute.companyId,
        dispute_id: page.dispute.id,
        pack_id: page.pack.id,
        decision: parsed.decision,
        note: parsed.note,
        pack_digest: page.pack.digest,
        reviewer_user_id: input.actor.userId,
        decided_at: decidedAt,
      },
    ]);
  } catch (error) {
    if (isConflictError(error)) {
      throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.reviewRequired);
    }

    throw error;
  }

  await note(dependencies, DISPUTE_AUDIT.reviewDecided, {
    actor: input.actor,
    dispute: page.dispute,
    payload: {
      pack_id: page.pack.id,
      decision: parsed.decision,
      pack_digest: page.pack.digest,
      note_length: parsed.note.length,
    },
  });

  return pageViewOf(input, dependencies);
}

/** The processor's answer, mapped to what this service does with it. */
function failureRuleOf(outcome: Exclude<DisputeSubmissionOutcome, { readonly kind: "sent" }>): string {
  switch (outcome.kind) {
    case "declined":
      return DISPUTE_SUBMISSION_RULES.submissionDeclined;
    case "unanswered":
      return DISPUTE_SUBMISSION_RULES.submissionUnanswered;
    case "not_sent":
      return outcome.rule.length === 0 ? DISPUTE_SUBMISSION_RULES.submissionUnsupported : outcome.rule;
  }
}

/** The queue row for one dispute update, or null when the desk has no sender or the merchant has no owner. */
async function queueMerchantEmail(
  dependencies: DisputeSubmissionDependencies,
  input: { readonly dispute: DisputeView; readonly queuedAt: string; readonly subject: string },
): Promise<string | null> {
  const methods = await dependencies.rest
    .select("email_settings", "select=method&status=eq.active&deleted_at=is.null&limit=1", methodSchema)
    .catch(() => []);
  const method = methods[0]?.method ?? null;

  if (method === null) {
    return null;
  }

  const owners = await dependencies.rest
    .select(
      "role_assignments",
      `select=user_id&company_id=eq.${encodeURIComponent(input.dispute.companyId)}&role=eq.owner` +
        "&revoked_at=is.null&deleted_at=is.null&order=granted_at.asc&limit=1",
      ownerSchema,
    )
    .catch(() => []);
  const ownerUserId = owners[0]?.user_id;

  if (ownerUserId === undefined) {
    return null;
  }

  const addresses = await dependencies.rest
    .select(
      "users",
      `select=email&id=eq.${encodeURIComponent(ownerUserId)}&deleted_at=is.null&limit=1`,
      addressSchema,
    )
    .catch(() => []);
  const email = addresses[0]?.email;

  if (email === undefined) {
    return null;
  }

  try {
    const rows = await dependencies.rest.insertReturning(
      "email_send_logs",
      [
        {
          company_id: input.dispute.companyId,
          template_key: DISPUTE_SUBMISSION_TEMPLATE_KEY,
          recipient_email: email,
          recipient_user_id: ownerUserId,
          subject: input.subject,
          provider: method,
          max_attempts: DISPUTE_SUBMISSION_MAX_ATTEMPTS,
          reference_kind: DISPUTE_SUBMISSION_REFERENCE_KIND,
          reference_id: input.dispute.id,
          queued_at: input.queuedAt,
        },
      ],
      idSchema,
    );

    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Move the dispute to `evidence_submitted`, guarded by the version the caller read.
 *
 * The move is the second write of the act, and it is the one that can lose: another officer may have landed a
 * submission between this call's read and its update, and PostgREST reports a zero-row update as success. So the
 * row is read back, and `submitted_at` - the column `0039` gave this meaning - is the answer: set, and the
 * evidence is sent; unset, and the officer is told the row moved rather than shown a change nobody made.
 */
async function markEvidenceSubmitted(
  dependencies: DisputeSubmissionDependencies,
  input: { readonly dispute: DisputeView; readonly version: number },
): Promise<DisputeView> {
  const submittedAt = new Date(nowOf(dependencies)).toISOString();

  try {
    await dependencies.rest.update(
      "disputes",
      `id=eq.${encodeURIComponent(input.dispute.id)}&version=eq.${String(input.version)}` +
        "&status=in.(open,under_review)&deleted_at=is.null",
      { status: "evidence_submitted", submitted_at: submittedAt },
    );
  } catch {
    // `0127`'s trigger refused the move, which is the database saying no sent submission carries this dispute.
    // A claim row is already written, so the officer can press again; nothing is pretended.
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.disputeMoved);
  }

  const row = await readDispute(dependencies, input.dispute.id);

  if (row === null) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.disputeNotFound);
  }

  const view = disputeViewOf(row, nowOf(dependencies));

  if (view.responseSubmittedAt !== null) {
    return view;
  }

  throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.disputeMoved);
}

/** The target a port receives: the pack as the processor's case file reads it, never bytes, never a key. */
function targetOf(input: {
  readonly submissionId: string;
  readonly dispute: DisputeView;
  readonly pack: ReviewPackView;
  readonly route: { readonly providerKey: ProviderKey; readonly providerId: string; readonly mode: string };
}): DisputeSubmissionTarget {
  const items: readonly DisputeSubmissionItem[] = input.pack.items.map((item) => ({
    section: item.section,
    sourceKind: item.sourceKind,
    label: item.label,
    summary: item.summary,
    capturedAt: item.capturedAt,
  }));
  const documents: readonly DisputeSubmissionDocument[] = input.pack.documents.map((document) => ({
    id: document.id,
    section: document.section,
    fileName: document.fileName,
    contentType: document.contentType,
    byteSize: document.byteSize,
    contentSha256: document.contentSha256,
  }));

  return {
    submissionId: input.submissionId,
    disputeId: input.dispute.id,
    companyId: input.dispute.companyId,
    providerKey: input.route.providerKey,
    providerId: input.route.providerId,
    mode: input.route.mode === "test" ? "test" : "live",
    processorDisputeId: input.dispute.processorDisputeId,
    amountMinor: input.dispute.amountMinor,
    currency: input.dispute.currency,
    packDigest: input.pack.digest,
    itemCount: input.pack.itemCount,
    documentCount: input.pack.documentCount,
    items,
    documents,
  };
}

/**
 * Send one approved pack to the processor.
 *
 * The order is the same in both channels: claim, then send, then answer the claim, then move the dispute. The
 * provider channel claims a `sending` row and asks the port; the recorded channel claims nothing in advance
 * because the sending already happened in a person's browser, so its first write is the answer itself.
 */
export async function submitDisputePack(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly body: unknown },
  dependencies: DisputeSubmissionDependencies,
): Promise<DisputeSubmissionResult> {
  requireAnyRole(input.actor, DISPUTE_REVIEW_ROLES);

  if (!hasSatisfiedTwoFactor(input.actor)) {
    throw new AppError("PERMISSION_DENIED");
  }

  const parsed = parseSubmissionBody(input.body);
  const page = await pageViewOf(input, dependencies);

  if (page.dispute.resolvedAt !== null) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.disputeResolved);
  }

  if (page.pack === null) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.packMissing);
  }

  if (page.submission !== null) {
    if (page.submission.status === "sent") {
      // A second press after the evidence landed is a confirmation, not an error: the officer sees the
      // reference the first press wrote.
      const settled = page.dispute.responseSubmittedAt === null ? await markEvidenceSubmitted(dependencies, {
        dispute: page.dispute,
        version: page.dispute.version,
      }) : page.dispute;

      return {
        view: { ...(await pageViewOf(input, dependencies)), dispute: settled },
        outcome: "already_sent",
        processorReference: page.submission.processorReference,
      };
    }

    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.submissionExists);
  }

  if (!page.maySubmit) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.reviewRequired);
  }

  const route = await readPaymentRoute(dependencies, page.dispute);

  if (route === null) {
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.providerMissing);
  }

  if (parsed.channel === "provider" && submissionPortFor(dependencies.ports, route.providerKey) === null) {
    // No documented dispute API for this provider in this build. The desk is told so before anything is
    // claimed, and the recorded channel is the answer rather than a workaround.
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.submissionUnsupported);
  }

  const claimedAt = new Date(nowOf(dependencies)).toISOString();
  let submissionId: string;

  try {
    const rows = await dependencies.rest.insertReturning(
      "dispute_submissions",
      [
        {
          company_id: page.dispute.companyId,
          dispute_id: page.dispute.id,
          pack_id: page.pack.id,
          channel: parsed.channel,
          status: "sending",
          provider_key: route.providerKey,
          mode: route.mode,
          pack_digest: page.pack.digest,
          item_count: page.pack.itemCount,
          document_count: page.pack.documentCount,
          submitted_by_user_id: input.actor.userId,
          claimed_at: claimedAt,
        },
      ],
      idSchema,
    );
    const written = rows[0]?.id;

    if (written === undefined) {
      throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.disputeMoved);
    }

    submissionId = written;
  } catch (error) {
    if (isConflictError(error)) {
      throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.submissionExists);
    }

    if (error instanceof AppError) {
      throw error;
    }

    // `0127`'s guard refused the claim: no approval, no frozen pack, a moved dispute. All three are the same
    // sentence to the officer - the pack is not ready to send - and none of them is a defect.
    throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.reviewRequired);
  }

  await note(dependencies, DISPUTE_AUDIT.submissionClaimed, {
    actor: input.actor,
    dispute: page.dispute,
    payload: {
      submission_id: submissionId,
      pack_id: page.pack.id,
      channel: parsed.channel,
      provider_key: route.providerKey,
      mode: route.mode,
      pack_digest: page.pack.digest,
    },
  });

  let reference: string | null = parsed.processorReference;

  if (parsed.channel === "provider") {
    const port = submissionPortFor(dependencies.ports, route.providerKey);

    if (port === null) {
      throw refused("CONFLICT", DISPUTE_SUBMISSION_RULES.submissionUnsupported);
    }

    const outcome = await port(
      targetOf({ submissionId, dispute: page.dispute, pack: page.pack, route }),
    ).catch((): DisputeSubmissionOutcome => ({
      kind: "unanswered",
      detail: "The processor call failed before it answered.",
    }));

    if (outcome.kind !== "sent") {
      const rule = failureRuleOf(outcome);

      await dependencies.rest
        .update("dispute_submissions", `id=eq.${encodeURIComponent(submissionId)}&status=eq.sending`, {
          status: "failed",
          failure_rule: rule,
        })
        .catch(() => undefined);

      await note(dependencies, DISPUTE_AUDIT.submissionFailed, {
        actor: input.actor,
        dispute: page.dispute,
        payload: {
          submission_id: submissionId,
          pack_id: page.pack.id,
          channel: "provider",
          provider_key: route.providerKey,
          rule,
        },
      });

      throw refused("CONFLICT", rule);
    }

    reference = outcome.processorReference;
  }

  const sentAt = new Date(nowOf(dependencies)).toISOString();

  await dependencies.rest.update(
    "dispute_submissions",
    `id=eq.${encodeURIComponent(submissionId)}&status=eq.sending`,
    {
      status: "sent",
      processor_reference: reference,
      note: parsed.note,
      sent_at: sentAt,
    },
  );

  const settled = await markEvidenceSubmitted(dependencies, {
    dispute: page.dispute,
    version: parsed.version,
  });

  const sendId = await queueMerchantEmail(dependencies, {
    dispute: page.dispute,
    queuedAt: sentAt,
    subject: getMessage("email.disputeSubmission.subject"),
  });

  await note(dependencies, DISPUTE_AUDIT.submitted, {
    actor: input.actor,
    dispute: page.dispute,
    payload: {
      submission_id: submissionId,
      pack_id: page.pack.id,
      channel: parsed.channel,
      provider_key: route.providerKey,
      mode: route.mode,
      pack_digest: page.pack.digest,
      processor_reference: reference,
      item_count: page.pack.itemCount,
      document_count: page.pack.documentCount,
      send_id: sendId,
    },
  });

  return {
    view: { ...(await pageViewOf(input, dependencies)), dispute: settled },
    outcome: "sent",
    processorReference: reference,
  };
}

/** The provider keys this build can send through and the ones it cannot, for a screen that explains itself. */
export function providerChannelSupport(ports: DisputeSubmissionPorts): readonly ProviderKey[] {
  return PROVIDER_KEYS.filter((key) => submissionPortFor(ports, key) !== null);
}
