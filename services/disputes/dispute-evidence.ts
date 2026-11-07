// path: services/disputes/dispute-evidence.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { requireValidUpload, sha256Hex } from "../../lib/security/upload.ts";
import { appendTolerated } from "../payments/refund.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_AUDIT_ENTITY,
  DISPUTE_REQUEST_ROLES,
} from "./dispute-fields.ts";
import { readCompanyDispute } from "./dispute-response.ts";
import type { DisputeView } from "./dispute.ts";
import {
  DISPUTE_EVIDENCE_CAPTION_MAXIMUM_LENGTH,
  DISPUTE_EVIDENCE_CAPTION_MINIMUM_LENGTH,
  DISPUTE_EVIDENCE_CONTENT_TYPES,
  DISPUTE_EVIDENCE_FILE_NAME_MAXIMUM_LENGTH,
  DISPUTE_EVIDENCE_FILE_NAME_MINIMUM_LENGTH,
  DISPUTE_EVIDENCE_LABEL_MAXIMUM_LENGTH,
  DISPUTE_EVIDENCE_RULES,
  DISPUTE_EVIDENCE_SECTIONS,
  DISPUTE_EVIDENCE_SECTION_OF,
  DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH,
  disputeEvidenceIsComplete,
  disputeEvidenceMissingSections,
  isDisputeEvidenceSection,
  isDisputeEvidenceSourceKind,
  isDisputeEvidenceStatus,
  type DisputeEvidenceRecordKind,
  type DisputeEvidenceSection,
  type DisputeEvidenceSourceKind,
  type DisputeEvidenceStatus,
} from "./dispute-evidence-fields.ts";
import { readEvidenceCandidates, type DisputeEvidenceCandidate } from "./dispute-evidence-sources.ts";

/**
 * Section 19's structured chargeback evidence pack, as the merchant builds it.
 *
 * ## The four acts and the one transition
 *
 * A pack starts as a draft the platform fills from its own records (`assembleEvidencePack`), the merchant
 * corrects it by removing what does not belong and adding notes of their own, supplies the documents
 * (`attachEvidenceDocument`), and finally freezes it (`freezeEvidencePack`). Freezing is the only one-way
 * act: after it the pack is the evidence the compliance desk reviews and sends (STEP 198), and `0126`'s
 * triggers refuse every write to it.
 *
 * ## Why the freeze decides completeness twice
 *
 * The sentence section 19 writes is a list of four parts, so "complete" is "all four are filled". This
 * module refuses an incomplete freeze with the list of what is missing, because a screen can say that before
 * a merchant presses anything, and `0126`'s trigger refuses it again against the rows themselves, because a
 * service is not the last line of defence for the sentence a processor reads. The two agree by construction:
 * both ask `disputeEvidenceMissingSections`'s question, one in TypeScript and one in SQL.
 *
 * ## Why the pack is copied rather than joined
 *
 * Every item carries its own label, summary and instant. A corrected invoice, a re-recorded delivery or a
 * deleted support ticket therefore changes the source and not the pack. That is what makes a pack evidence:
 * it is what the merchant stood behind at the moment they froze it, and the SHA-256 the freeze records is the
 * fingerprint of exactly that.
 *
 * ## What is never in an audit entry
 *
 * The digest, the counts, the section, the kind, the file size and the storage key. Never a client's name,
 * never a message subject, never a byte of a document: the chain is signed, exported and kept longer than
 * the dispute, and a chargeback pack is the last place a platform should duplicate a payer's correspondence.
 */

/** The port a document's bytes are handed to. The storage binding itself is STEPs 100-105's. */
export interface DisputeEvidenceStorage {
  /**
   * Store one file and answer the object key it was stored under.
   *
   * The key must match `0126`'s `storage_key` pattern. The digest, the size and the type are this module's
   * own answers, computed from the bytes before they were handed over - a storage port that also claimed a
   * digest would be a second, unverified source for the one number a pack's integrity rests on.
   */
  put(input: {
    readonly companyId: string;
    readonly disputeId: string;
    readonly actorUserId: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }): Promise<{ readonly storageKey: string; readonly fileId: string }>;
}

/** What one call needs. `storage` is absent in a deployment with no bucket bound. */
export interface DisputeEvidenceDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
  readonly storage?: DisputeEvidenceStorage;
}

/** One record in the pack, as a screen prints it. */
export interface EvidenceItemView {
  readonly id: string;
  readonly section: DisputeEvidenceSection;
  readonly sourceKind: DisputeEvidenceSourceKind;
  /** The row it was copied from, or null for the merchant's own note. */
  readonly sourceId: string | null;
  readonly label: string;
  readonly summary: string | null;
  readonly capturedAt: string;
}

/** One supplied document, as a screen prints it. */
export interface EvidenceDocumentView {
  readonly id: string;
  readonly section: DisputeEvidenceSection;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly caption: string | null;
  readonly addedAt: string;
}

/** One of the four parts, with what it holds and whether it is filled. */
export interface EvidenceSectionView {
  readonly section: DisputeEvidenceSection;
  readonly items: readonly EvidenceItemView[];
  readonly documents: readonly EvidenceDocumentView[];
  readonly covered: boolean;
}

/** The pack, as a screen prints it. */
export interface EvidencePackView {
  readonly id: string;
  readonly disputeId: string;
  readonly status: DisputeEvidenceStatus;
  readonly digest: string | null;
  readonly frozenAt: string | null;
  readonly itemCount: number;
  readonly documentCount: number;
  readonly version: number;
  readonly items: readonly EvidenceItemView[];
  readonly documents: readonly EvidenceDocumentView[];
  readonly sections: readonly EvidenceSectionView[];
  readonly missing: readonly DisputeEvidenceSection[];
  /** True when freezing would be accepted: all four parts filled and at least one document. */
  readonly complete: boolean;
}

/** The page's whole answer: the dispute, its pack when one exists, and what the platform could add to it. */
export interface DisputeEvidenceView {
  readonly dispute: DisputeView;
  readonly pack: EvidencePackView | null;
  readonly candidates: readonly DisputeEvidenceCandidate[];
  /** False when the dispute is decided or its pack has been sent, which is when the pack is history. */
  readonly mayBuild: boolean;
}

/** The field every refusal of this STEP names, so one form has one place to print it. */
export const DISPUTE_EVIDENCE_FIELD = "evidence";

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
  source_id: z.string().nullable(),
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
  created_at: z.string(),
});

/** The six columns the pack's own row needs. */
const PACK_COLUMNS =
  "select=id,company_id,dispute_id,status,digest,item_count,document_count,frozen_at,version";

const ITEM_COLUMNS = "select=id,section,source_kind,source_id,label,summary,captured_at";

const DOCUMENT_COLUMNS = "select=id,section,file_name,content_type,byte_size,caption,created_at";

const identifierPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const storageKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{7,299}$/u;

/** The clock of one call, defaulting to the wall clock. */
function nowOf(dependencies: DisputeEvidenceDependencies): number {
  return dependencies.now === undefined ? Date.now() : dependencies.now();
}

/** A refusal that names its field and its rule, which is what a form maps to a sentence. */
function refused(code: "VALIDATION_FAILED" | "CONFLICT" | "RESOURCE_NOT_FOUND", rule: string): AppError {
  return new AppError(code, { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule }] });
}

/**
 * The dispute this caller may pack, or a refusal.
 *
 * The read is `readCompanyDispute`, so the `owner` role and the session's own company decide whether the
 * row is visible at all - a dispute of another merchant is never read, and the pack's own queries carry the
 * same `company_id` afterwards, so no later read can widen what this one allowed.
 */
async function requireDispute(
  input: { readonly actor: RequestActor; readonly disputeId: string },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeView> {
  requireAnyRole(input.actor, DISPUTE_REQUEST_ROLES);
  requireCompanyId(input.actor);

  return readCompanyDispute({ actor: input.actor, disputeId: input.disputeId }, dependencies);
}

/** One pack row, or null when this dispute has no live pack. */
async function findPack(
  dependencies: DisputeEvidenceDependencies,
  input: { readonly disputeId: string; readonly companyId: string },
): Promise<z.infer<typeof packRowSchema> | null> {
  const rows = await dependencies.rest.select(
    "dispute_evidence_packs",
    `${PACK_COLUMNS}&dispute_id=eq.${encodeURIComponent(input.disputeId)}` +
      `&company_id=eq.${input.companyId}&deleted_at=is.null&limit=1`,
    packRowSchema,
  );

  return rows[0] ?? null;
}

/** The live items of one pack, newest first inside each part. */
async function readItems(
  dependencies: DisputeEvidenceDependencies,
  packId: string,
): Promise<readonly EvidenceItemView[]> {
  const rows = await dependencies.rest.select(
    "dispute_evidence_items",
    `${ITEM_COLUMNS}&pack_id=eq.${encodeURIComponent(packId)}&deleted_at=is.null` +
      "&order=captured_at.desc",
    itemRowSchema,
  );

  return rows.flatMap((row) =>
    isDisputeEvidenceSection(row.section) && isDisputeEvidenceSourceKind(row.source_kind)
      ? [
          {
            id: row.id,
            section: row.section,
            sourceKind: row.source_kind,
            sourceId: row.source_id,
            label: row.label,
            summary: row.summary,
            capturedAt: row.captured_at,
          },
        ]
      : [],
  );
}

/** The live documents of one pack. */
async function readDocuments(
  dependencies: DisputeEvidenceDependencies,
  packId: string,
): Promise<readonly EvidenceDocumentView[]> {
  const rows = await dependencies.rest.select(
    "dispute_evidence_documents",
    `${DOCUMENT_COLUMNS}&pack_id=eq.${encodeURIComponent(packId)}&deleted_at=is.null` +
      "&order=created_at.desc",
    documentRowSchema,
  );

  return rows.flatMap((row) =>
    isDisputeEvidenceSection(row.section)
      ? [
          {
            id: row.id,
            section: row.section,
            fileName: row.file_name,
            contentType: row.content_type,
            byteSize: row.byte_size,
            caption: row.caption,
            addedAt: row.created_at,
          },
        ]
      : [],
  );
}

/** The four parts of a pack, each with what it holds, in section 19's order. */
function sectionsOf(
  items: readonly EvidenceItemView[],
  documents: readonly EvidenceDocumentView[],
): readonly EvidenceSectionView[] {
  return DISPUTE_EVIDENCE_SECTIONS.map((section) => {
    const sectionItems = items.filter((item) => item.section === section);
    const sectionDocuments = documents.filter((document) => document.section === section);

    return {
      section,
      items: sectionItems,
      documents: sectionDocuments,
      covered: sectionItems.length > 0 || sectionDocuments.length > 0,
    };
  });
}

/** One pack row and its rows, as the page prints it. */
function packViewOf(
  row: z.infer<typeof packRowSchema>,
  items: readonly EvidenceItemView[],
  documents: readonly EvidenceDocumentView[],
): EvidencePackView {
  const missing = disputeEvidenceMissingSections({ items, documents });

  return {
    id: row.id,
    disputeId: row.dispute_id,
    status: isDisputeEvidenceStatus(row.status) ? row.status : "draft",
    digest: row.digest,
    frozenAt: row.frozen_at,
    // A draft counts its live rows; a frozen pack reports the numbers the trigger wrote at the freeze, which is
    // the snapshot a reviewer was given. Nothing on this screen adds up two different answers.
    itemCount: row.status === "frozen" ? row.item_count : items.length,
    documentCount: row.status === "frozen" ? row.document_count : documents.length,
    version: row.version,
    items,
    documents,
    sections: sectionsOf(items, documents),
    missing,
    complete: disputeEvidenceIsComplete({ items, documents }),
  };
}

/**
 * The pack of one dispute, read whole.
 *
 * Two queries for the pack and one each for the items and the documents: four instead of one join, because
 * a join would need the pack's id first anyway and the two child tables have different columns. The
 * candidates are read beside them so the screen can offer a record the merchant removed earlier without a
 * second round trip.
 */
async function readPackView(
  dependencies: DisputeEvidenceDependencies,
  input: { readonly dispute: DisputeView },
): Promise<EvidencePackView | null> {
  const row = await findPack(dependencies, {
    disputeId: input.dispute.id,
    companyId: input.dispute.companyId,
  });

  if (row === null) {
    return null;
  }

  const [items, documents] = await Promise.all([readItems(dependencies, row.id), readDocuments(dependencies, row.id)]);

  return packViewOf(row, items, documents);
}

/**
 * The page's whole answer.
 *
 * The candidate read is the same one the builder uses, so the screen can say "the platform holds two
 * delivery records" without a second implementation of where those come from.
 */
export async function readDisputeEvidence(
  input: { readonly actor: RequestActor; readonly disputeId: string },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);
  const [pack, candidates] = await Promise.all([
    readPackView(dependencies, { dispute }),
    readEvidenceCandidates({ companyId: dispute.companyId, paymentId: dispute.paymentId }, dependencies),
  ]);

  return {
    dispute,
    pack,
    candidates,
    mayBuild: dispute.resolvedAt === null && dispute.responseSubmittedAt === null,
  };
}

/** One chain entry, tolerated: an audit outage never stops a merchant assembling their own evidence. */
async function note(
  dependencies: DisputeEvidenceDependencies,
  action: string,
  input: {
    readonly actor: RequestActor;
    readonly dispute: DisputeView;
    readonly packId: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  const entry: AuditEntry = {
    action,
    actorUserId: input.actor.userId,
    entityType: DISPUTE_AUDIT_ENTITY,
    entityId: input.dispute.id,
    payload: { pack_id: input.packId, ...input.payload },
    companyId: input.dispute.companyId,
    sessionId: input.actor.sessionId,
    ipAddress: null,
    userAgent: null,
  };

  await appendTolerated(dependencies.audit, entry);
}

/**
 * Open the pack, or refresh the draft that is already open.
 *
 * The act section 19 calls "a structured pack is assembled". Every record the platform holds for the
 * disputed payment is copied in, once each: `0126`'s unique key on `(pack, section, kind, source)` makes the
 * insert idempotent, so a second press adds what appeared since and nothing else. A frozen pack is never
 * refreshed - it is evidence, and `0126` refuses the write rather than this module silently skipping it.
 */
export async function assembleEvidencePack(
  input: { readonly actor: RequestActor; readonly disputeId: string },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);

  if (dispute.resolvedAt !== null) {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.disputeDecided);
  }

  if (dispute.responseSubmittedAt !== null) {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packFrozen);
  }

  const existing = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

  if (existing !== null && existing.status !== "draft") {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packFrozen);
  }

  let packId = existing?.id ?? null;

  if (packId === null) {
    const created = await dependencies.rest.insertReturning(
      "dispute_evidence_packs",
      [
        {
          company_id: dispute.companyId,
          dispute_id: dispute.id,
          built_by_user_id: input.actor.userId,
        },
      ],
      z.object({ id: z.string().uuid() }),
    );
    packId = created[0]?.id ?? null;

    if (packId === null) {
      throw new AppError("INTERNAL_ERROR");
    }
  }

  const candidates = await readEvidenceCandidates(
    { companyId: dispute.companyId, paymentId: dispute.paymentId },
    dependencies,
  );
  const nowIso = new Date(nowOf(dependencies)).toISOString();
  const rows = candidates
    .slice(0, DISPUTE_EVIDENCE_SECTIONS.length * 32)
    .map((candidate) => ({
      company_id: dispute.companyId,
      pack_id: packId,
      section: candidate.section,
      source_kind: candidate.sourceKind,
      source_id: candidate.sourceId,
      label: candidate.label.slice(0, DISPUTE_EVIDENCE_LABEL_MAXIMUM_LENGTH),
      summary: candidate.summary,
      captured_at: candidate.capturedAt,
      added_by_user_id: input.actor.userId,
      created_at: nowIso,
    }));

  let added = 0;

  for (const row of rows) {
    try {
      await dependencies.rest.insert("dispute_evidence_items", [row]);
      added += 1;
    } catch (error) {
      // `0126`'s unique key refuses a record the draft already holds. That is the refresh working, not a
      // failure: a second press must not fail because the first one succeeded.
      if (!isConflictError(error)) {
        throw error;
      }
    }
  }

  const pack = await readPackView(dependencies, { dispute });

  if (pack === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.packNotFound);
  }

  await note(dependencies, DISPUTE_AUDIT.evidenceAssembled, {
    actor: input.actor,
    dispute,
    packId: pack.id,
    payload: {
      available: candidates.length,
      added,
      item_count: pack.itemCount,
      document_count: pack.documentCount,
    },
  });

  const [items, documents] = await Promise.all([
    readItems(dependencies, pack.id),
    readDocuments(dependencies, pack.id),
  ]);

  return {
    dispute,
    pack: packViewOf(
      {
        id: pack.id,
        company_id: dispute.companyId,
        dispute_id: pack.disputeId,
        status: pack.status,
        digest: pack.digest,
        item_count: pack.itemCount,
        document_count: pack.documentCount,
        frozen_at: pack.frozenAt,
        version: pack.version,
      },
      items,
      documents,
    ),
    candidates,
    mayBuild: true,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Bodies
 * ---------------------------------------------------------------------------------------------- */

/** The two record shapes: a note of the merchant's own, and one row the platform holds. */
const noteBodySchema = z
  .object({
    kind: z.literal("note"),
    section: z.string(),
    note: z.string().min(1).max(DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH),
  })
  .strict();

const recordBodySchema = z
  .object({
    kind: z.literal("record"),
    section: z.string(),
    source_kind: z.string(),
    source_id: z.string().uuid(),
  })
  .strict();

export type EvidenceItemBody =
  | { readonly kind: "note"; readonly section: DisputeEvidenceSection; readonly note: string }
  | {
      readonly kind: "record";
      readonly section: DisputeEvidenceSection;
      readonly sourceKind: DisputeEvidenceRecordKind;
      readonly sourceId: string;
    };

/**
 * Parse one item body.
 *
 * A note is trimmed and must still say something; a record must name a kind that has a source row (not
 * `note`, which has none) and a uuid. Both must name one of the four parts, and a note filed under the
 * invoice part is a different thing from a delivery record and both are allowed: the merchant's sentence is
 * evidence too, as long as it is attributed to them.
 */
export function parseEvidenceItemBody(body: unknown): EvidenceItemBody {
  if (typeof body === "object" && body !== null && (body as { readonly kind?: unknown }).kind === "note") {
    const parsed = noteBodySchema.safeParse(body);
    const section = (body as { readonly section?: unknown }).section;
    const note = (body as { readonly note?: unknown }).note;

    if (!parsed.success || !isDisputeEvidenceSection(section) || typeof note !== "string") {
      throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.noteInvalid);
    }

    const trimmed = note.trim();

    if (trimmed.length === 0 || trimmed.length > DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH) {
      throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.noteInvalid);
    }

    return { kind: "note", section, note: trimmed };
  }

  const parsed = recordBodySchema.safeParse(body);

  if (!parsed.success || !isDisputeEvidenceSection(parsed.data.section) || !isDisputeEvidenceSourceKind(parsed.data.source_kind)) {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.sectionUnknown);
  }

  if (parsed.data.source_kind === "note") {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.noteInvalid);
  }

  return {
    kind: "record",
    section: parsed.data.section,
    sourceKind: parsed.data.source_kind,
    sourceId: parsed.data.source_id,
  };
}

/**
 * Add one item to a draft.
 *
 * A record is re-read from its source before it is copied, so a source the platform no longer holds cannot
 * be added from a page that was open when it did; a note is copied from the request. Both are added only
 * while the pack is a draft, and `0126`'s trigger refuses the write even if this check were skipped.
 */
export async function addEvidenceItem(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly body: unknown },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);
  const body = parseEvidenceItemBody(input.body);
  const pack = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

  if (pack === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.packNotFound);
  }

  if (pack.status !== "draft" || dispute.resolvedAt !== null || dispute.responseSubmittedAt !== null) {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packFrozen);
  }

  const nowIso = new Date(nowOf(dependencies)).toISOString();
  const base = {
    company_id: dispute.companyId,
    pack_id: pack.id,
    section: body.section,
    added_by_user_id: input.actor.userId,
    created_at: nowIso,
  };

  if (body.kind === "note") {
    await dependencies.rest.insert("dispute_evidence_items", [
      {
        ...base,
        source_kind: "note",
        source_id: null,
        label: body.note.slice(0, DISPUTE_EVIDENCE_LABEL_MAXIMUM_LENGTH),
        summary: body.note.slice(0, DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH),
        captured_at: nowIso,
      },
    ]);

    await note(dependencies, DISPUTE_AUDIT.evidenceItemAdded, {
      actor: input.actor,
      dispute,
      packId: pack.id,
      payload: { section: body.section, source_kind: "note" },
    });
  } else {
    const candidates = await readEvidenceCandidates(
      { companyId: dispute.companyId, paymentId: dispute.paymentId },
      dependencies,
    );
    const candidate = candidates.find(
      (entry) => entry.sourceKind === body.sourceKind && entry.sourceId === body.sourceId,
    );

    if (candidate === undefined) {
      throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.itemNotFound);
    }

    await insertCandidate(
      dependencies,
      { ...base, section: DISPUTE_EVIDENCE_SECTION_OF[body.sourceKind] },
      candidate,
      pack.id,
      nowIso,
    );

    await note(dependencies, DISPUTE_AUDIT.evidenceItemAdded, {
      actor: input.actor,
      dispute,
      packId: pack.id,
      payload: { section: body.section, source_kind: body.sourceKind },
    });
  }

  return readDisputeEvidence({ actor: input.actor, disputeId: dispute.id }, dependencies);
}

/** One candidate row, with the section the kind belongs to rather than the one the caller sent. */
async function insertCandidate(
  dependencies: DisputeEvidenceDependencies,
  base: Readonly<Record<string, unknown>>,
  candidate: DisputeEvidenceCandidate,
  packId: string,
  nowIso: string,
): Promise<void> {
  try {
    await dependencies.rest.insert("dispute_evidence_items", [
      {
        ...base,
        pack_id: packId,
        source_kind: candidate.sourceKind,
        source_id: candidate.sourceId,
        label: candidate.label.slice(0, DISPUTE_EVIDENCE_LABEL_MAXIMUM_LENGTH),
        summary: candidate.summary,
        captured_at: candidate.capturedAt,
        created_at: nowIso,
      },
    ]);
  } catch (error) {
    if (isConflictError(error)) {
      throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.documentDuplicate);
    }

    throw error;
  }
}

/**
 * Remove one item from a draft.
 *
 * A soft delete, because `lib`'s REST port has no delete and because the row that a merchant removed at
 * 10:02 is itself a fact worth keeping. The service refuses a frozen pack first, so the refusal names the
 * freeze rather than the missing row.
 */
export async function removeEvidenceItem(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly itemId: string },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);
  const pack = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

  if (pack === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.packNotFound);
  }

  if (pack.status !== "draft") {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packFrozen);
  }

  if (!identifierPattern.test(input.itemId)) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.itemNotFound);
  }

  const before = await readItems(dependencies, pack.id);

  if (!before.some((item) => item.id === input.itemId)) {
    // Nothing to remove: a page that was open when the item was already gone is told so, rather than being
    // told the removal worked.
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.itemNotFound);
  }

  await dependencies.rest.update(
    "dispute_evidence_items",
    `id=eq.${encodeURIComponent(input.itemId)}&pack_id=eq.${pack.id}&deleted_at=is.null`,
    { deleted_at: new Date(nowOf(dependencies)).toISOString() },
  );

  const remaining = await readItems(dependencies, pack.id);
  const removed = !remaining.some((item) => item.id === input.itemId);

  if (!removed) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.itemNotFound);
  }

  await note(dependencies, DISPUTE_AUDIT.evidenceItemRemoved, {
    actor: input.actor,
    dispute,
    packId: pack.id,
    payload: { item_id: input.itemId },
  });

  return readDisputeEvidence({ actor: input.actor, disputeId: dispute.id }, dependencies);
}

/* -------------------------------------------------------------------------------------------------
 * Documents
 * ---------------------------------------------------------------------------------------------- */

/** What a route hands over: the declared metadata and the bytes it read. */
export interface EvidenceUpload {
  readonly fileName: string;
  readonly declaredType: string;
  readonly bytes: Uint8Array;
  readonly caption?: string;
  readonly section: string;
}

/** A caption that the column will accept, or null when none was given. */
function parseCaption(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length < DISPUTE_EVIDENCE_CAPTION_MINIMUM_LENGTH || trimmed.length > DISPUTE_EVIDENCE_CAPTION_MAXIMUM_LENGTH) {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.noteInvalid);
  }

  return trimmed;
}

/**
 * Validate the bytes as a `dispute_document`, refuse a quarantine, and hand them to the storage port.
 *
 * The order matters. The type is decided from the signature and not from the header the browser sent
 * (`requireValidUpload`), a file whose bytes disagree with its name is refused rather than stored, and the
 * digest is computed here from the plaintext - so the row records the file that was accepted, not the file
 * that was claimed.
 */
async function storeDocument(
  dependencies: DisputeEvidenceDependencies,
  input: {
    readonly companyId: string;
    readonly disputeId: string;
    readonly actorUserId: string;
    readonly upload: EvidenceUpload;
  },
): Promise<{
  readonly storageKey: string;
  readonly fileId: string;
  readonly contentSha256: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly fileName: string;
}> {
  const storage = dependencies.storage;

  if (storage === undefined) {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.storageMissing);
  }

  const verdict = requireValidUpload(
    {
      fileName: input.upload.fileName,
      declaredType: input.upload.declaredType,
      byteSize: input.upload.bytes.length,
      head: input.upload.bytes,
    },
    "dispute_document",
    DISPUTE_EVIDENCE_FIELD,
  );

  if (verdict.decision !== "verified") {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.documentRejected);
  }

  if (
    verdict.fileName.length < DISPUTE_EVIDENCE_FILE_NAME_MINIMUM_LENGTH ||
    verdict.fileName.length > DISPUTE_EVIDENCE_FILE_NAME_MAXIMUM_LENGTH
  ) {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.documentRejected);
  }

  if (!(DISPUTE_EVIDENCE_CONTENT_TYPES as readonly string[]).includes(verdict.contentType)) {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.documentRejected);
  }

  const stored = await storage.put({
    companyId: input.companyId,
    disputeId: input.disputeId,
    actorUserId: input.actorUserId,
    fileName: verdict.fileName,
    contentType: verdict.contentType,
    bytes: input.upload.bytes,
  });

  if (!storageKeyPattern.test(stored.storageKey)) {
    // A port that answers a key the column cannot hold would turn a storage bug into a database error two
    // layers down. Refusing here names the reason.
    throw new AppError("INTERNAL_ERROR");
  }

  return {
    storageKey: stored.storageKey,
    fileId: stored.fileId,
    contentSha256: sha256Hex(input.upload.bytes),
    contentType: verdict.contentType,
    byteSize: verdict.byteSize,
    fileName: verdict.fileName,
  };
}

/**
 * Attach one document to a draft.
 *
 * The document is filed under one of the four parts, because section 19's pack is organized by what each
 * document proves. The same bytes twice in one pack is refused by `0126`'s unique key and reported as a
 * duplicate rather than as a failure.
 */
export async function attachEvidenceDocument(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly upload: EvidenceUpload },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);
  const pack = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

  if (pack === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.packNotFound);
  }

  if (pack.status !== "draft" || dispute.resolvedAt !== null || dispute.responseSubmittedAt !== null) {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packFrozen);
  }

  if (!isDisputeEvidenceSection(input.upload.section)) {
    throw refused("VALIDATION_FAILED", DISPUTE_EVIDENCE_RULES.sectionUnknown);
  }

  const caption = parseCaption(input.upload.caption);
  const stored = await storeDocument(dependencies, {
    companyId: dispute.companyId,
    disputeId: dispute.id,
    actorUserId: input.actor.userId,
    upload: input.upload,
  });
  const nowIso = new Date(nowOf(dependencies)).toISOString();

  try {
    await dependencies.rest.insert("dispute_evidence_documents", [
      {
        company_id: dispute.companyId,
        pack_id: pack.id,
        section: input.upload.section,
        file_name: stored.fileName,
        content_type: stored.contentType,
        byte_size: stored.byteSize,
        content_sha256: stored.contentSha256,
        storage_key: stored.storageKey,
        file_id: stored.fileId,
        caption,
        uploaded_by_user_id: input.actor.userId,
        created_at: nowIso,
      },
    ]);
  } catch (error) {
    if (isConflictError(error)) {
      throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.documentDuplicate);
    }

    throw error;
  }

  await note(dependencies, DISPUTE_AUDIT.evidenceDocumentAdded, {
    actor: input.actor,
    dispute,
    packId: pack.id,
    payload: {
      section: input.upload.section,
      content_type: stored.contentType,
      byte_size: stored.byteSize,
      content_sha256: stored.contentSha256,
      storage_key: stored.storageKey,
    },
  });

  return readDisputeEvidence({ actor: input.actor, disputeId: dispute.id }, dependencies);
}

/** Remove one document from a draft. The object it points at is the storage layer's to keep or expire. */
export async function removeEvidenceDocument(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly documentId: string },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);
  const pack = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

  if (pack === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.packNotFound);
  }

  if (pack.status !== "draft") {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packFrozen);
  }

  if (!identifierPattern.test(input.documentId)) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.documentNotFound);
  }

  const before = await readDocuments(dependencies, pack.id);

  if (!before.some((document) => document.id === input.documentId)) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.documentNotFound);
  }

  await dependencies.rest.update(
    "dispute_evidence_documents",
    `id=eq.${encodeURIComponent(input.documentId)}&pack_id=eq.${pack.id}&deleted_at=is.null`,
    { deleted_at: new Date(nowOf(dependencies)).toISOString() },
  );

  const remaining = await readDocuments(dependencies, pack.id);

  if (remaining.some((document) => document.id === input.documentId)) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.documentNotFound);
  }

  await note(dependencies, DISPUTE_AUDIT.evidenceDocumentRemoved, {
    actor: input.actor,
    dispute,
    packId: pack.id,
    payload: { document_id: input.documentId },
  });

  return readDisputeEvidence({ actor: input.actor, disputeId: dispute.id }, dependencies);
}

/* -------------------------------------------------------------------------------------------------
 * The freeze
 * ---------------------------------------------------------------------------------------------- */

/**
 * The fingerprint of a pack.
 *
 * Canonical JSON: the four parts in section 19's order, the items inside a part sorted by instant then by
 * kind and id, the documents sorted by digest. Two packs assembled from the same records at the same instants
 * have the same digest whatever order the rows came back in, which is what makes the number worth recording.
 * The documents' storage keys are not in it - a key is where a file lives, and a moved object is the same
 * evidence.
 */
export function evidenceDigestOf(input: {
  readonly items: readonly EvidenceItemView[];
  readonly documents: readonly EvidenceDocumentView[];
}): string {
  const items = [...input.items]
    .sort(
      (left, right) =>
        DISPUTE_EVIDENCE_SECTIONS.indexOf(left.section) - DISPUTE_EVIDENCE_SECTIONS.indexOf(right.section) ||
        left.capturedAt.localeCompare(right.capturedAt) ||
        left.sourceKind.localeCompare(right.sourceKind) ||
        left.id.localeCompare(right.id),
    )
    .map((item) => ({
      section: item.section,
      source_kind: item.sourceKind,
      label: item.label,
      summary: item.summary,
      captured_at: item.capturedAt,
    }));
  const documents = [...input.documents]
    .sort(
      (left, right) =>
        DISPUTE_EVIDENCE_SECTIONS.indexOf(left.section) - DISPUTE_EVIDENCE_SECTIONS.indexOf(right.section) ||
        left.contentType.localeCompare(right.contentType) ||
        left.fileName.localeCompare(right.fileName),
    )
    .map((document) => ({
      section: document.section,
      file_name: document.fileName,
      content_type: document.contentType,
      byte_size: document.byteSize,
      caption: document.caption,
    }));

  return createHash("sha256").update(JSON.stringify({ items, documents })).digest("hex");
}

/**
 * Freeze the pack: the one transition, and the moment `0039`'s `evidence_ready` becomes true.
 *
 * The order is the pack first, then the flag, and each of the two is guarded separately. Freezing writes the
 * digest and the instant against the version the page read; `0126` re-counts the rows and refuses a pack
 * missing a part. Only then is the dispute marked ready, because `disputes_guard_evidence` refuses the flag
 * without a frozen pack - so a crash between the two leaves a frozen pack and a false flag, and a second
 * press of the same button finishes the job instead of failing. That is why the frozen branch below exists.
 */
export async function freezeEvidencePack(
  input: { readonly actor: RequestActor; readonly disputeId: string; readonly version?: number },
  dependencies: DisputeEvidenceDependencies,
): Promise<DisputeEvidenceView> {
  const dispute = await requireDispute(input, dependencies);

  if (dispute.resolvedAt !== null) {
    throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.disputeDecided);
  }

  const pack = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

  if (pack === null) {
    throw refused("RESOURCE_NOT_FOUND", DISPUTE_EVIDENCE_RULES.packNotFound);
  }

  const [items, documents] = await Promise.all([
    readItems(dependencies, pack.id),
    readDocuments(dependencies, pack.id),
  ]);

  if (pack.status === "draft") {
    const missing = disputeEvidenceMissingSections({ items, documents });

    if (missing.length > 0 || documents.length === 0) {
      const details = [
        ...missing.map((section) => ({ field: section, rule: DISPUTE_EVIDENCE_RULES.incomplete })),
        ...(documents.length === 0
          ? [{ field: DISPUTE_EVIDENCE_FIELD, rule: DISPUTE_EVIDENCE_RULES.incomplete }]
          : []),
      ];

      throw new AppError("VALIDATION_FAILED", {
        details,
        cause: { rule: DISPUTE_EVIDENCE_RULES.incomplete, missing, documents: documents.length },
      });
    }

    if (input.version !== undefined && input.version !== pack.version) {
      throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packMoved);
    }

    await dependencies.rest.update(
      "dispute_evidence_packs",
      `id=eq.${pack.id}&version=eq.${pack.version}&deleted_at=is.null&status=eq.draft`,
      {
        status: "frozen",
        digest: evidenceDigestOf({ items, documents }),
        frozen_at: new Date(nowOf(dependencies)).toISOString(),
      },
    );

    const frozen = await findPack(dependencies, { disputeId: dispute.id, companyId: dispute.companyId });

    if (frozen === null || frozen.status !== "frozen") {
      throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packMoved);
    }

    await note(dependencies, DISPUTE_AUDIT.evidenceFrozen, {
      actor: input.actor,
      dispute,
      packId: frozen.id,
      payload: {
        digest: frozen.digest,
        item_count: frozen.item_count,
        document_count: frozen.document_count,
        frozen_at: frozen.frozen_at,
      },
    });
  }

  if (!dispute.evidenceReady) {
    await dependencies.rest.update(
      "disputes",
      `id=eq.${dispute.id}&company_id=eq.${dispute.companyId}&version=eq.${dispute.version}&deleted_at=is.null`,
      { evidence_ready: true },
    );

    const marked = await readCompanyDispute({ actor: input.actor, disputeId: dispute.id }, dependencies);

    if (!marked.evidenceReady) {
      throw refused("CONFLICT", DISPUTE_EVIDENCE_RULES.packMoved);
    }
  }

  return readDisputeEvidence({ actor: input.actor, disputeId: dispute.id }, dependencies);
}
