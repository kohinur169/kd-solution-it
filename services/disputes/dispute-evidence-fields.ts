// path: services/disputes/dispute-evidence-fields.ts
import { formatMessage, getMessage, type MessagePath } from "../../lib/i18n/messages.ts";

/**
 * Section 19's evidence pack, in the words the schema uses.
 *
 * The sentence this STEP builds is one: "A structured chargeback evidence pack is assembled: invoice,
 * delivery proof, client communication record and terms acceptance record." The four parts are the four
 * section words below, and they are the only ones `0126`'s checks accept - a pack that invented a fifth
 * part would pass the platform's own code and fail the database, which is the wrong order to find out.
 *
 * Nothing here reads a row or writes one. The vocabulary, the bounds and the sentences one refusal maps to
 * live together because four modules (the sources, the builder, the routes and the gate) have to agree about
 * them, and the cheapest way to make them agree is to let them share one frozen object.
 */

/** The four parts of the pack, in the order section 19 names them. */
export const DISPUTE_EVIDENCE_SECTIONS = Object.freeze([
  "invoice",
  "delivery",
  "communication",
  "terms",
] as const);

export type DisputeEvidenceSection = (typeof DISPUTE_EVIDENCE_SECTIONS)[number];

/** Where one record came from. `note` is the merchant's own sentence and has no source row. */
export const DISPUTE_EVIDENCE_SOURCE_KINDS = Object.freeze([
  "invoice",
  "fulfilment",
  "acceptance",
  "policy",
  "communication",
  "event",
  "note",
] as const);

export type DisputeEvidenceSourceKind = (typeof DISPUTE_EVIDENCE_SOURCE_KINDS)[number];

/** A source kind that names a row the platform already holds. */
export type DisputeEvidenceRecordKind = Exclude<DisputeEvidenceSourceKind, "note">;

/** The two states of a pack. `0126` allows exactly these two and exactly one transition between them. */
export const DISPUTE_EVIDENCE_STATUSES = Object.freeze(["draft", "frozen"] as const);

export type DisputeEvidenceStatus = (typeof DISPUTE_EVIDENCE_STATUSES)[number];

/** The three types `0126` and the `dispute_document` upload policy both accept. */
export const DISPUTE_EVIDENCE_CONTENT_TYPES = Object.freeze([
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const);

/** The largest file the `dispute_document` upload policy accepts, and `0126`'s own ceiling. */
export const DISPUTE_EVIDENCE_MAXIMUM_BYTES = 52_428_800;

/**
 * The route's ceiling for a multipart body: the file limit plus a megabyte of boundaries and field names.
 *
 * The bytes are what the policy counts, so a body ceiling smaller than the file plus its envelope would
 * refuse a file the policy allows. One megabyte is far more than `Content-Disposition`, a caption and three
 * field names can hold.
 */
export const DISPUTE_EVIDENCE_MAXIMUM_UPLOAD_BYTES = DISPUTE_EVIDENCE_MAXIMUM_BYTES + 1_048_576;

/** The JSON ceiling of the three small bodies: assemble, note, and the key of one row. */
export const DISPUTE_EVIDENCE_MAXIMUM_BODY_BYTES = 4_096;

/** Bounds, each one the number `0126` states in a check. */
export const DISPUTE_EVIDENCE_LABEL_MAXIMUM_LENGTH = 120;
export const DISPUTE_EVIDENCE_LABEL_MINIMUM_LENGTH = 3;
export const DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH = 600;
export const DISPUTE_EVIDENCE_CAPTION_MAXIMUM_LENGTH = 160;
export const DISPUTE_EVIDENCE_CAPTION_MINIMUM_LENGTH = 3;
export const DISPUTE_EVIDENCE_FILE_NAME_MAXIMUM_LENGTH = 120;
export const DISPUTE_EVIDENCE_FILE_NAME_MINIMUM_LENGTH = 3;

/**
 * How many candidates one section takes from one source.
 *
 * The invoice, the fulfilment record, the buyer's confirmation and each policy are single rows by
 * construction (`0122` keeps one live fulfilment row per invoice), so their limit is a guard against a
 * second row appearing rather than a page. Correspondence and events are unbounded in principle, so they
 * are capped: a pack is a summary a reviewer reads, and forty automated reminder emails in it would bury
 * the two that matter.
 */
export const DISPUTE_EVIDENCE_CANDIDATE_LIMITS: Readonly<Record<DisputeEvidenceRecordKind, number>> =
  Object.freeze({
    invoice: 1,
    fulfilment: 1,
    acceptance: 1,
    policy: 4,
    communication: 12,
    event: 12,
  });

/** The part of the pack each source kind belongs to. */
export const DISPUTE_EVIDENCE_SECTION_OF: Readonly<Record<DisputeEvidenceRecordKind, DisputeEvidenceSection>> =
  Object.freeze({
    invoice: "invoice",
    fulfilment: "delivery",
    acceptance: "terms",
    policy: "terms",
    communication: "communication",
    event: "communication",
  });

/** The label sentence of each source kind. A note is labelled by the merchant, so it has no path here. */
export const DISPUTE_EVIDENCE_LABEL_PATHS: Readonly<Record<DisputeEvidenceRecordKind, MessagePath>> =
  Object.freeze({
    invoice: "disputes.evidenceInvoiceLabel",
    fulfilment: "disputes.evidenceFulfilmentLabel",
    acceptance: "disputes.evidenceAcceptanceLabel",
    policy: "disputes.evidencePolicyLabel",
    communication: "disputes.evidenceEmailLabel",
    event: "disputes.evidenceEventLabel",
  });

/** The name of each part, for the screen that prints it. */
export const DISPUTE_EVIDENCE_SECTION_PATHS: Readonly<Record<DisputeEvidenceSection, MessagePath>> =
  Object.freeze({
    invoice: "disputes.evidenceSectionInvoice",
    delivery: "disputes.evidenceSectionDelivery",
    communication: "disputes.evidenceSectionCommunication",
    terms: "disputes.evidenceSectionTerms",
  });

/**
 * The refusals this STEP adds, each one a rule a form maps to one sentence.
 *
 * They are separate from `DISPUTE_RULES` on purpose: those thirteen are about the dispute's own money and
 * deadline and are named by the webhook and the response form, and a pack refusal is a different question
 * with a different sentence. Sharing the object would make one screen's rule list grow with another
 * screen's work.
 */
export const DISPUTE_EVIDENCE_RULES = Object.freeze({
  /** No such pack, or a pack of another merchant. */
  packNotFound: "dispute_evidence_not_found",
  /** The pack is frozen, so nothing in it may change. */
  packFrozen: "dispute_evidence_frozen",
  /** The part named is not one of the four. */
  sectionUnknown: "dispute_evidence_section_unknown",
  /** The note is empty, too long, or not trimmed. */
  noteInvalid: "dispute_evidence_note_invalid",
  /** The row named is not in this merchant's pack. */
  itemNotFound: "dispute_evidence_item_not_found",
  /** The document named is not in this merchant's pack. */
  documentNotFound: "dispute_evidence_document_not_found",
  /** The bytes are not a type the platform stores, or do not match the type that was declared. */
  documentRejected: "dispute_evidence_document_rejected",
  /** This deployment has no document storage bound, so no file can be attached. */
  storageMissing: "dispute_evidence_storage_missing",
  /** The same bytes are already attached to this pack. */
  documentDuplicate: "dispute_evidence_document_duplicate",
  /** The pack is missing a part, or holds no document, so it cannot be frozen. */
  incomplete: "dispute_evidence_incomplete",
  /** The pack moved between the read and the write. */
  packMoved: "dispute_evidence_moved",
  /** The dispute is decided, so its pack is history. */
  disputeDecided: "dispute_evidence_dispute_decided",
} as const);

/** True when a value is one of the four parts. */
export function isDisputeEvidenceSection(value: unknown): value is DisputeEvidenceSection {
  return typeof value === "string" && (DISPUTE_EVIDENCE_SECTIONS as readonly string[]).includes(value);
}

/** True when a value is one of the source kinds. */
export function isDisputeEvidenceSourceKind(value: unknown): value is DisputeEvidenceSourceKind {
  return typeof value === "string" && (DISPUTE_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value);
}

/** True when a value is one of the two pack states. */
export function isDisputeEvidenceStatus(value: unknown): value is DisputeEvidenceStatus {
  return typeof value === "string" && (DISPUTE_EVIDENCE_STATUSES as readonly string[]).includes(value);
}

/** True when a value is a type the pack stores. */
export function isDisputeEvidenceContentType(value: unknown): value is string {
  return typeof value === "string" && (DISPUTE_EVIDENCE_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Which of the four parts have nothing in them, in section 19's order.
 *
 * The same question `0126`'s freeze trigger asks of the rows, asked here of the view, so the screen can say
 * what is missing before a merchant presses a button that would be refused. Two implementations of one
 * rule is normally a mistake; here the database's answer is the one that decides, and this one exists so
 * nobody has to press the button to find out.
 */
export function disputeEvidenceMissingSections(input: {
  readonly items: readonly { readonly section: DisputeEvidenceSection }[];
  readonly documents: readonly { readonly section: DisputeEvidenceSection }[];
}): readonly DisputeEvidenceSection[] {
  return DISPUTE_EVIDENCE_SECTIONS.filter(
    (section) =>
      !input.items.some((item) => item.section === section) &&
      !input.documents.some((document) => document.section === section),
  );
}

/**
 * Whether a pack holding these rows may be frozen.
 *
 * Two conditions, and the second is the one a summary of section 19 would miss: every part has something
 * in it, and the merchant has actually supplied a document. Four records the platform wrote about itself
 * are not the merchant's evidence; the sentence "the merchant ... supplies the required documents" is.
 */
export function disputeEvidenceIsComplete(input: {
  readonly items: readonly { readonly section: DisputeEvidenceSection }[];
  readonly documents: readonly { readonly section: DisputeEvidenceSection }[];
}): boolean {
  return disputeEvidenceMissingSections(input).length === 0 && input.documents.length > 0;
}

/** The name of one part of the pack, in the words the screen prints. */
export function evidenceSectionLabel(section: DisputeEvidenceSection): string {
  return formatMessage(DISPUTE_EVIDENCE_SECTION_PATHS[section], {});
}

/**
 * The sentence one refusal maps to.
 *
 * It lives here rather than in the service because the browser panel needs it and the service imports
 * `node:crypto`: a client component that reached into the builder for a sentence would pull a hash
 * implementation into the bundle to print a string. One rule, one sentence, one place - and both sides read
 * the same place.
 */
export function evidenceRuleSentence(rule: string | null): string {
  switch (rule) {
    case DISPUTE_EVIDENCE_RULES.packFrozen:
      return getMessage("disputes.evidenceFrozenRefusal");
    case DISPUTE_EVIDENCE_RULES.storageMissing:
      return getMessage("disputes.evidenceStorageMissing");
    case DISPUTE_EVIDENCE_RULES.documentRejected:
      return getMessage("disputes.evidenceDocumentQuarantined");
    case DISPUTE_EVIDENCE_RULES.incomplete:
      return getMessage("disputes.evidenceIncomplete");
    case DISPUTE_EVIDENCE_RULES.packMoved:
      return getMessage("disputes.evidenceMoved");
    case DISPUTE_EVIDENCE_RULES.packNotFound:
      return getMessage("disputes.evidencePackNotFound");
    case DISPUTE_EVIDENCE_RULES.noteInvalid:
      return getMessage("disputes.evidenceNoteRequired");
    case DISPUTE_EVIDENCE_RULES.documentDuplicate:
      return getMessage("disputes.evidenceDuplicateNote");
    default:
      return getMessage("disputes.evidenceFailed");
  }
}

/** The four parts as a screen prints them, each with its name. */
export function evidenceSectionChoices(): readonly {
  readonly section: DisputeEvidenceSection;
  readonly label: string;
}[] {
  return DISPUTE_EVIDENCE_SECTIONS.map((section) => ({ section, label: evidenceSectionLabel(section) }));
}
