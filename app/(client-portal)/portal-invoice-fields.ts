// path: app/(client-portal)/portal-invoice-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * The vocabulary of the tokenized invoice page, in one place.
 *
 * STEP 181 owns the page under `i/[token]` and the payment components in `components/payments/`. This
 * file holds the words, the counts and the closed lists that the page, its two writes, its gate and the
 * database agree on, so no sentence has to be spelled twice and no limit has to be remembered.
 *
 * ## Why it imports nothing but `deepFreeze`
 *
 * The same module is read by a server side service, by a client component and by the gate, which runs on
 * plain Node with no Next.js runtime. A helper that reached for `zod`, for `node:crypto` or for the
 * catalog would make one of those three readers need the others' environment, and a client bundle that
 * pulled in a Node builtin is the defect `lib/security/README.md` records as a rule. The schemas live in
 * the service that parses with them; the words live here.
 *
 * ## What this page is not allowed to say
 *
 * No amount, no state and no rule is composed from user input: every sentence the page prints comes from
 * `lib/i18n/strings/en.ts` and every number in it is formatted by the module that owns that number. The
 * constants below are the *names* of things - the audit action, the rule a refusal carries, the table a
 * row lives in - never a sentence a buyer reads.
 */

/** The tables this STEP reads, named once so a query string cannot drift from the migration. */
export const PORTAL_INVOICE_TABLE = "invoices";
export const PORTAL_INVOICE_ITEM_TABLE = "invoice_items";
export const PORTAL_PAYMENT_TABLE = "payments";
export const PORTAL_FULFILMENT_EVIDENCE_TABLE = "invoice_fulfilment_evidence";
export const PORTAL_ACCEPTANCE_TABLE = "invoice_acceptances";

/** The kind of portal link this page opens, and the capability it must carry. */
export const PORTAL_INVOICE_TOKEN_KIND = "invoice";
export const PORTAL_INVOICE_TOKEN_CAPABILITY = "pay";

/**
 * The path prefix every invoice link starts with.
 *
 * `/i/` rather than `/invoice/` because the token is the only path segment a buyer ever sees, and a
 * short prefix keeps the pasted link inside one line of a chat window. The same prefix is minted by
 * `services/estimates/estimate-conversion.ts` when a quote is turned into an invoice, so the two cannot
 * disagree about where a link points.
 */
export const PORTAL_INVOICE_PATH_PREFIX = "/i/";

/**
 * The five states a client facing invoice can be in, which are not `0022`'s seven.
 *
 * A merchant's workflow distinguishes a draft from a sent document from a viewed one, because those are
 * steps in their own day: did I send it, did the client open it. A buyer meets three facts instead - the
 * document exists or it does not, it is owed or it is settled, and it was cancelled - so `draft` becomes
 * `not_issued`, and `sent`, `viewed` and `overdue` all become `open` with a due date that may have passed.
 * The mapping is total: every one of `0022`'s seven statuses becomes exactly one of these five.
 */
export const PORTAL_INVOICE_STATES = deepFreeze([
  "not_issued",
  "open",
  "partially_paid",
  "paid",
  "void",
] as const);

export type PortalInvoiceState = (typeof PORTAL_INVOICE_STATES)[number];

/**
 * The states in which the link still accepts money.
 *
 * The page shows what a payment would be, and the payment page of STEP 183 will take it; both read this
 * list rather than comparing statuses themselves, because "paid" and "void" are the two states where a
 * link must stop, and a second copy of that rule is a second chance to forget one.
 */
export const PORTAL_PAYABLE_STATES = deepFreeze(["open", "partially_paid"] as const);

export type PortalPayableState = (typeof PORTAL_PAYABLE_STATES)[number];

/**
 * The payment statuses a receipt prints.
 *
 * These four are exactly the statuses `ledger_entries_sync_invoice` counts as money received in `0041`,
 * and that is why the list is closed: a receipt that printed a fifth status would show an amount the
 * invoice's own `amount_paid_minor` does not hold, and a buyer comparing the two would be reading two
 * documents that disagree with each other.
 */
export const PORTAL_RECEIPT_PAYMENT_STATUSES = deepFreeze([
  "captured",
  "settled",
  "partially_refunded",
  "refunded",
] as const);

export type PortalReceiptPaymentStatus = (typeof PORTAL_RECEIPT_PAYMENT_STATUSES)[number];

/**
 * What a merchant may record as having happened.
 *
 * Two kinds, because an invoice charges for one of two things and the buyer's sentence has to match:
 * goods were delivered, or work was performed. `delivery` covers everything that physically moved and
 * `service` covers work with no parcel, which is the split section 16's confirmation wording already
 * implies.
 */
export const PORTAL_FULFILMENT_KINDS = deepFreeze(["delivery", "service"] as const);

export type PortalFulfilmentKind = (typeof PORTAL_FULFILMENT_KINDS)[number];

/**
 * How a fulfilment happened, from a closed list a screen can offer as a select.
 *
 * Six methods, each of which changes nothing about the evidence: a merchant answer a buyer reads back,
 * and a vocabulary a report can group. `carrier` is the parcel case, `hand_delivery` and `pickup` are the
 * two ways goods move without one, `digital` is a download or a licence, `in_person` is work done on
 * site, and `remote` is work done over a call.
 */
export const PORTAL_FULFILMENT_METHODS = deepFreeze([
  "carrier",
  "hand_delivery",
  "pickup",
  "digital",
  "in_person",
  "remote",
] as const);

export type PortalFulfilmentMethod = (typeof PORTAL_FULFILMENT_METHODS)[number];

/** Which methods belong to which kind, so a screen offers only the sensible ones. */
export const PORTAL_FULFILMENT_METHOD_KIND: Readonly<Record<PortalFulfilmentMethod, PortalFulfilmentKind>> =
  deepFreeze({
    carrier: "delivery",
    hand_delivery: "delivery",
    pickup: "delivery",
    digital: "delivery",
    in_person: "service",
    remote: "service",
  });

/** The kind a method implies. Total, so a method cannot arrive without one. */
export function portalFulfilmentKindOf(method: PortalFulfilmentMethod): PortalFulfilmentKind {
  return PORTAL_FULFILMENT_METHOD_KIND[method];
}

/** True when a value names a kind a merchant may record. */
export function isPortalFulfilmentKind(value: unknown): value is PortalFulfilmentKind {
  return typeof value === "string" && (PORTAL_FULFILMENT_KINDS as readonly string[]).includes(value);
}

/** True when a value names a method a merchant may record. */
export function isPortalFulfilmentMethod(value: unknown): value is PortalFulfilmentMethod {
  return typeof value === "string" && (PORTAL_FULFILMENT_METHODS as readonly string[]).includes(value);
}

/**
 * The sentence a buyer ticks, matched to the evidence it confirms.
 *
 * The buyer never chooses the statement: the page prints the one the recorded evidence implies, and the
 * service refuses a body that names the other. That is what stops a delivery confirmation being stored
 * against a service record, which the database also refuses in
 * `invoice_acceptances_guard_evidence`.
 */
export const PORTAL_ACCEPTANCE_STATEMENTS = deepFreeze([
  "delivery_received",
  "service_accepted",
] as const);

export type PortalAcceptanceStatement = (typeof PORTAL_ACCEPTANCE_STATEMENTS)[number];

export const PORTAL_ACCEPTANCE_STATEMENT_EVIDENCE_KIND: Readonly<
  Record<PortalAcceptanceStatement, PortalFulfilmentKind>
> = deepFreeze({
  delivery_received: "delivery",
  service_accepted: "service",
});

/** The statement a kind of evidence asks a buyer to confirm. Total, so no kind is unconfirmable. */
export function portalAcceptanceStatementFor(kind: PortalFulfilmentKind): PortalAcceptanceStatement {
  return kind === "delivery" ? "delivery_received" : "service_accepted";
}

/** True when a statement matches a kind of evidence. */
export function portalStatementMatchesKind(
  statement: PortalAcceptanceStatement,
  kind: PortalFulfilmentKind,
): boolean {
  return PORTAL_ACCEPTANCE_STATEMENT_EVIDENCE_KIND[statement] === kind;
}

/**
 * The lengths every field of the two writes is held to.
 *
 * The same numbers as `0122`'s check constraints, on both sides, which is what makes a refusal a sentence
 * the buyer can act on rather than a database error surfaced as "something went wrong": the service
 * measures first, and the database refuses whatever a caller that skipped the service might send.
 */
export const PORTAL_EVIDENCE_LIMITS = deepFreeze({
  reference: { min: 3, max: 120 },
  description: { min: 1, max: 500 },
  signerName: { min: 1, max: 160 },
  signerEmail: { min: 3, max: 254 },
  geoLocation: { min: 1, max: 200 },
  deviceFingerprint: { min: 8, max: 128 },
  userAgent: { min: 1, max: 400 },
});

/**
 * How far in the past a fulfilment may be dated.
 *
 * Ten years, because a merchant reconciling an old job is still telling the truth about it, and because
 * `0022` already allows a due date three thousand six hundred and fifty days out. A future date is
 * refused for the reason the column documents: a delivery that has not happened yet is a promise, not
 * evidence.
 */
export const PORTAL_FULFILMENT_MAXIMUM_PAST_DAYS = 3_650;

/** The consent wording, as a catalog key: read on both sides so the stored sentence is the shown one. */
export const PORTAL_ACCEPTANCE_CONSENT_KEY = "portal.acceptanceConsent";

/** The encoding line a document digest is computed over, so a hash from this page is identifiable. */
export const PORTAL_DOCUMENT_HASH_ENCODING = "kd-invoice-portal-document/1";

/** A document digest: SHA-256, lower case hex, the shape `0122` requires. */
export const PORTAL_DOCUMENT_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** A device fingerprint: printable ASCII only, 8 to 128 characters, never a sentence. */
export const PORTAL_DEVICE_FINGERPRINT_PATTERN = /^[!-~]{8,128}$/u;

/** An email address, the same expression `0022` and `0027` use for their own columns. */
export const PORTAL_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/u;

/** A portal token id: 22 characters of base64url, which is the 16 bytes `lib/security/portal-token.ts` mints. */
export const PORTAL_TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;

/** True when a value has the shape of a token id. */
export function isPortalTokenId(value: unknown): value is string {
  return typeof value === "string" && PORTAL_TOKEN_ID_PATTERN.test(value);
}

/**
 * The refusal rules this STEP adds, in the vocabulary both the body and the screen use.
 *
 * They are the `rule` of an `AppError` detail, so a client can map one word to one sentence; they are not
 * error codes, because each of them is a `VALIDATION_FAILED` or a `CONFLICT` the code already names.
 */
export const PORTAL_INVOICE_RULES = deepFreeze({
  /** The link's invoice is a draft, so there is nothing to show or confirm. */
  notIssued: "not_issued",
  /** The link's invoice was cancelled. */
  invoiceVoid: "invoice_void",
  /** The invoice holds no money, so nothing has been delivered against a payment. */
  notPaidYet: "not_paid_yet",
  /** The merchant has recorded no fulfilment, so the confirmation has nothing to point at. */
  evidenceMissing: "evidence_missing",
  /** The named evidence is not the live record of this invoice any more. */
  evidenceChanged: "evidence_changed",
  /** The statement offered does not match the kind of evidence recorded. */
  statementMismatch: "statement_mismatch",
  /** This invoice has already been confirmed, and once is enough. */
  acceptanceExists: "acceptance_exists",
  /** The merchant recorded a fulfilment, and a buyer has confirmed it: it is a fact now. */
  evidenceConfirmed: "evidence_confirmed",
  /** The record moved while the form was open. */
  staleVersion: "stale_version",
  /** The confirmation arrived after the invoice's money changed. */
  documentChanged: "document_changed",
  /** A session belonging to the invoice's own company tried to confirm it. */
  selfConfirmation: "self_confirmation",
});

/**
 * The order a refusal lists its fields in, so two refusals of one form read the same way.
 */
export const PORTAL_FULFILMENT_FIELD_ORDER = deepFreeze([
  "kind",
  "method",
  "occurred_at",
  "reference",
  "description",
] as const);

export const PORTAL_ACCEPTANCE_FIELD_ORDER = deepFreeze([
  "statement",
  "fulfilment_evidence_id",
  "signer_name",
  "signer_email",
  "consent_accepted",
  "document_hash",
] as const);

/** The audit actions of this STEP. Dotted, lower case, the shape `audit_logs_action_check` requires. */
export const PORTAL_FULFILMENT_RECORDED_AUDIT_ACTION = "portal.invoice_fulfilment_recorded";
export const PORTAL_FULFILMENT_CORRECTED_AUDIT_ACTION = "portal.invoice_fulfilment_corrected";
export const PORTAL_ACCEPTED_AUDIT_ACTION = "portal.invoice_accepted";

/** The audit entity names, so a chain can be read by subject. */
export const PORTAL_FULFILMENT_AUDIT_ENTITY = "invoice_fulfilment_evidence";
export const PORTAL_ACCEPTANCE_AUDIT_ENTITY = "invoice_acceptance";

/**
 * The reasons a release is not allowed yet, in the order they are checked.
 *
 * The same order as `invoice_release_evidence_ok`'s three `exists` clauses, so the sentence a merchant
 * reads names the first thing that is missing rather than all of them at once. `invoice_void` comes
 * first because a cancelled invoice will never be released, whatever else is true.
 */
export const PORTAL_RELEASE_BLOCKERS = deepFreeze([
  "invoice_void",
  "invoice_not_paid",
  "fulfilment_missing",
  "acceptance_missing",
] as const);

export type PortalReleaseBlocker = (typeof PORTAL_RELEASE_BLOCKERS)[number];

/**
 * The most receipt entries one page prints.
 *
 * A receipt is a summary, not a statement: forty payments against one invoice is already unusual, and a
 * page that printed an unbounded list would let a merchant with ten thousand tiny payments turn a client
 * link into a download. When there are more, the page says how many it left out, which is the same
 * choice `INVOICE_CLIENT_OPTION_LIMIT` makes.
 */
export const PORTAL_RECEIPT_MAXIMUM_ENTRIES = 40;

/**
 * The body ceiling of both portal writes, in bytes.
 *
 * Four kilobytes is three text fields, two of them short: a confirmation is a name, an address and a
 * fingerprint, and a delivery is a reference and a sentence. The ceiling is checked before the body is
 * read at all, so a caller cannot make the process hold a megabyte to find out that it will refuse it.
 */
export const PORTAL_EVIDENCE_MAXIMUM_BODY_BYTES = 4_096;

/**
 * The confirmation's own rate limit, on the platform's own counter.
 *
 * Ten attempts per address per ten minutes. A buyer confirms once; ten chances cover a mistyped name, a
 * reload and a second browser, and stop a script that holds one link from writing evidence in a loop.
 * The scope is a name `rate_limit_windows` accepts, and it is deliberately not one of the buckets
 * `lib/security/rate-limit.ts` classifies, because this surface is reached by somebody with no account.
 */
export const PORTAL_ACCEPTANCE_RATE_LIMIT = deepFreeze({
  scope: "portal_acceptance",
  limit: 10,
  windowSeconds: 600,
});

/**
 * The invoice statuses a client link may show at all.
 *
 * A draft is refused because a draft is a merchant's working copy and its number is still null; the other
 * six are shown, including `void`, which the page renders as a cancellation rather than as an error,
 * because a buyer holding a link to a cancelled invoice deserves to be told what happened to it.
 */
export const PORTAL_READABLE_INVOICE_STATUSES = deepFreeze([
  "sent",
  "viewed",
  "overdue",
  "partially_paid",
  "paid",
  "void",
] as const);
