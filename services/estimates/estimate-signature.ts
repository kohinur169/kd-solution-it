// path: services/estimates/estimate-signature.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { AUDIT_MAXIMUM_USER_AGENT_LENGTH } from "../../lib/security/audit.ts";
import { canonicalRateLimitAddress } from "../../lib/security/rate-limit.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { quantityToThousandths } from "../invoices/invoice-totals.ts";
import { INVOICE_LINE_FIELDS, orderDocumentDetails } from "../invoices/invoices.ts";
import { ESTIMATE_COLUMNS, ESTIMATE_TABLE } from "./estimate-fields.ts";
import {
  ESTIMATE_DOCUMENT_HASH_LENGTH,
  ESTIMATE_DOCUMENT_HASH_PATTERN,
  ESTIMATE_SIGNATURES_TABLE,
  ESTIMATE_SIGNATURE_AUDIT_ENTITY,
  ESTIMATE_SIGNATURE_DECISIONS,
  ESTIMATE_SIGNATURE_EMAIL_PATTERN,
  ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN,
  ESTIMATE_SIGNATURE_LIMITS,
  ESTIMATE_SIGNATURE_OPEN_STATUSES,
  ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION,
  isEstimateSignatureDecision,
  type EstimateSignatureDecision,
} from "./estimate-signature-fields.ts";
import {
  ESTIMATE_MANAGE_ROLES,
  estimateRowSchema,
  estimateSnapshotOf,
  readEstimateLines,
  type EstimateLineSnapshot,
  type EstimateSnapshot,
} from "./estimates.ts";

/**
 * The document hash of `0027_estimate_signatures`: the digest of the offer a client decided.
 *
 * ## What is hashed, and the rule that decides
 *
 * **Every stored fact about the offer, in one canonical representation, excluding the document's lifecycle
 * and excluding any second spelling of a fact already present.** So the client snapshot, the currency, the
 * expiry, the memo, every line in its order and the six amounts are in; the status, the number, the issued
 * and accepted and voided instants, the conversion, the versions and the timestamps are out; and where an
 * amount exists both as minor units and as printed text, only the minor units are in.
 *
 * Each of those three choices is a decision, not a default:
 *
 * - **The number is excluded**, which makes the digest computable on a draft and *stable across issuing*.
 *   A number is an identifier the merchant's series assigns, not a term the client agreed to, and excluding
 *   it means one digest can be taken before a quote is sent and compared after: if it matches, the terms did
 *   not move when the document was issued. That is evidence a merchant can use. Including it would have made
 *   the digest change on every issue for a document whose offer never changed.
 * - **Printed forms are excluded.** `priceFromMinor` and `thousandthsToQuantity` are presentation rules. A
 *   digest that contained them would change the day someone decided to print four decimals instead of two,
 *   and the evidence would claim the offer had changed when only its spelling had. So every amount is
 *   re-expressed here in the unit the column stores: money as minor units, a quantity as thousandths. This
 *   is why the snapshot's `quantity` - which arrives normalised for printing, `2.500` as `2.5` - is put back
 *   through `quantityToThousandths` before it is hashed.
 * - **A line's id is excluded but the quote's id is included.** The quote's id says *which document* this is;
 *   a line's id says *which row* it was stored in, and no client ever saw one. A quote whose lines were
 *   removed and re-added with identical terms in an identical order is the same offer, and hashing row
 *   identity would have said otherwise.
 *
 * ## What this digest is not
 *
 * `0027`'s column comment says the hash exists "so a later PDF can be proven to be the one that was
 * signed". This is the hash of the **offer**, not of a rendered file, and the difference is deliberate: no
 * estimate PDF exists in this build - STEP 117's writer draws invoices, and no STEP has asked it to draw a
 * quote - so a byte-level digest of a document nobody can render yet would be a digest of nothing. What a
 * signature actually attests to is the terms, and the terms are what this covers. If byte-level provenance
 * is wanted later it needs the estimate PDF first, and it must be a second digest with its own meaning
 * rather than a quiet change to this one, because every row already stored under this rule was computed
 * over the terms.
 *
 * ## Why the encoding is length-prefixed
 *
 * A digest is only as good as the injectivity of the string it is taken over. Joining values with a
 * separator is not injective: a description containing that separator can be split differently and produce
 * a neighbour's document. So every field is written as `name:tag:byteLength:value`, which is self-delimiting
 * - a reader consumes the digits, then exactly that many bytes, and cannot be misled by the value's content.
 * The tag separates a null from an empty string, and an integer from a string of digits, so `null` and `""`
 * can never meet. The encoding's own version is the first field, so a future change to the field selection
 * produces a different digest instead of silently agreeing with rows already stored.
 *
 * ## What the capture does, and the four things it refuses to do
 *
 * **The hash is computed here and never accepted.** The input schema is `.strict()`, so a caller that sends
 * a `document_hash` of its own is refused with `unknown_field`. Evidence a signer or a client could supply
 * would be evidence about nothing: the point of the column is that the platform says what the document was.
 *
 * **Evidence is refused, not repaired.** A merchant's memo is truncated when it is too long, because a memo
 * is the merchant's own convenience. A signer's name, address and the consent wording are not: they are
 * trimmed of surrounding space, which changes no meaning, and anything longer, shorter or holding a control
 * character is refused with a sentence. A record that quietly differs from what the signer gave is not a
 * record. The one exception is the request's user agent, which is normalised rather than refused, because
 * it is a fact about the request and not part of what anyone attested to.
 *
 * **There is no actor, and that is not an oversight.** The signer is a client, and rule 14 says clients use
 * tokenized links only: there is no session and no role to check. The caller has to have proved already that
 * it holds a live token for this quote at this merchant, which this service cannot check because no token
 * exists in this build - the send workflow that would issue one is nobody's STEP yet. So the company travels
 * beside the quote id and every read and write is scoped by both, and a caller that names a pair which does
 * not belong together finds nothing rather than someone else's document.
 *
 * **It requires an open quote and never makes one.** `0027`'s trigger refuses an insert unless the quote is
 * `sent` or `viewed`; this service checks the same list first so the refusal arrives as a sentence with a
 * field and a rule rather than as a database exception, and it writes no status anywhere. A status invented
 * here would turn the evidence into a record of a decision nobody was ever offered.
 *
 * ## Why no float and no `JSON.stringify`
 *
 * Rule 2 forbids a float on the money path, and `JSON.stringify` would put the digest at the mercy of key
 * insertion order and of a number's shortest-round-trip spelling. Both are avoided: the field order is fixed
 * here, and every value arrives as text or is converted to text from a `bigint`.
 */

/**
 * The encoding's own identity, hashed as the first field.
 *
 * Changing the field selection without changing this would make new rows agree with old ones over different
 * documents, which is the one failure an evidence digest must never have.
 */
export const ESTIMATE_DOCUMENT_HASH_ENCODING = "kd-estimate-document-hash/1";

/**
 * What kind of value a field carries, so that no two different values can encode identically.
 *
 * `N` is a null, `S` is text, `I` is a non-negative integer in decimal digits with no sign and no point.
 */
type FieldTag = "N" | "S" | "I";

function byteLengthOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One self-delimiting field of the encoding. */
function field(name: string, tag: FieldTag, value: string | null): string {
  const text = value === null ? "" : value;

  return `${name}:${tag}:${byteLengthOf(text).toString()}:${text}`;
}

/** A text field, refusing a value that should have been text and was not. */
function textField(name: string, value: string | null): string {
  return field(name, "S", value);
}

/**
 * An integer field.
 *
 * The check is not decoration: a value that is not digits would otherwise be hashed as if it were a number,
 * and a digest that quietly accepted `"2500"` and `2500n` as the same field would be a digest whose meaning
 * depended on the caller's types.
 */
function integerField(name: string, value: string): string {
  if (!/^\d+$/u.test(value)) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: name, rule: "invalid_format" }] });
  }

  return field(name, "I", value);
}

/**
 * The lines in the order the document prints them.
 *
 * Sorting rather than trusting the array's order makes the digest a function of the document and not of how
 * it happened to be read. Positions are still hashed, so reordering a quote still changes its digest - which
 * is right, because the order of an offer is part of what a client reads.
 */
function orderedLines(lines: readonly EstimateLineSnapshot[]): readonly EstimateLineSnapshot[] {
  return [...lines].sort((left, right) => left.position - right.position);
}

/**
 * The canonical encoding of one quote's offer, as the string the digest is taken over.
 *
 * Exported because the encoding is the part worth proving: its injectivity, its field selection and its
 * independence from key order are all asserted against this string rather than against a digest, which
 * would hide every one of them behind 64 hex characters.
 */
export function canonicalEstimateDocumentEncoding(estimate: EstimateSnapshot): string {
  const parts: string[] = [textField("encoding", ESTIMATE_DOCUMENT_HASH_ENCODING)];

  // Which document, whose document, and for which client. The client's id is hashed beside the snapshot of
  // the client, because a quote re-pointed at a different client is a different offer even where the two
  // names and addresses read the same.
  parts.push(textField("estimate_id", estimate.id));
  parts.push(textField("company_id", estimate.companyId));
  parts.push(textField("client_id", estimate.clientId));
  parts.push(textField("currency", estimate.currency));

  // The client as the quote recorded them, which is what a document prints.
  parts.push(textField("client_name", estimate.client.name));
  parts.push(textField("client_email", estimate.client.email));
  parts.push(textField("client_address", estimate.client.address));

  // Two terms of the offer: how long it stands, and what else the merchant wrote on it.
  parts.push(textField("expires_at", estimate.expiresAt));
  parts.push(textField("memo", estimate.memo));

  // The lines, count first so the boundary between one line and the next is stated rather than implied.
  parts.push(integerField("line_count", String(estimate.lines.length)));

  for (const line of orderedLines(estimate.lines)) {
    const thousandths = quantityToThousandths(line.quantity);

    if (thousandths === null) {
      // A snapshot carries a quantity the service itself printed, so this is not a merchant's mistake and
      // not something to refuse with a validation sentence: it means the snapshot is not a snapshot.
      throw new AppError("INTERNAL_ERROR", {
        details: [{ field: `lines[${String(line.position)}].quantity`, rule: "invalid_format" }],
      });
    }

    parts.push(integerField("line_position", String(line.position)));
    parts.push(textField("line_description", line.description));
    parts.push(textField("line_unit", line.unit));
    parts.push(integerField("line_quantity_thousandths", thousandths.toString()));
    parts.push(integerField("line_unit_price_minor", line.unitPriceMinor));
    parts.push(integerField("line_discount_minor", line.discountMinor));
    parts.push(integerField("line_total_minor", line.lineTotalMinor));
    parts.push(textField("line_product_id", line.productId));
    parts.push(textField("line_service_id", line.serviceId));
  }

  // The six amounts as stored: the four money columns, and the discount instruction that produced one of
  // them. The printed forms are left out because each is a spelling of a value already here.
  parts.push(integerField("subtotal_minor", estimate.totals.subtotalMinor));
  parts.push(textField("discount_basis", estimate.totals.discountBasis));
  parts.push(integerField("discount_percent_bp", String(estimate.totals.discountPercentBasisPoints)));
  parts.push(integerField("discount_minor", estimate.totals.discountMinor));
  parts.push(integerField("tax_minor", estimate.totals.taxMinor));
  parts.push(integerField("total_minor", estimate.totals.totalMinor));

  return parts.join("");
}

/**
 * The document hash to store in `estimate_signatures.document_hash`.
 *
 * SHA-256 over the canonical encoding, as 64 lower case hex characters, which is exactly what
 * `estimate_signatures_hash_check` admits. The result is checked against that pattern before it is
 * returned rather than assumed, so a change to the digest - a different algorithm, a base64 encoding, an
 * upper case hex - fails here with a sentence instead of at the column.
 */
export function hashEstimateDocument(estimate: EstimateSnapshot): string {
  const digest = createHash("sha256").update(canonicalEstimateDocumentEncoding(estimate), "utf8").digest("hex");

  if (digest.length !== ESTIMATE_DOCUMENT_HASH_LENGTH || !ESTIMATE_DOCUMENT_HASH_PATTERN.test(digest)) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "document_hash", rule: "invalid_format" }] });
  }

  return digest;
}


/* ---- the evidence row ---- */

/**
 * The columns a read of the evidence asks for, in the family's own shape: a `select=` list, never every
 * column. All of `0027`'s are asked for but one, because all of them are the record; `deleted_at` is the
 * exception, and it is filtered to null by every read rather than read.
 */
export const ESTIMATE_SIGNATURE_COLUMNS = `select=${[
  "id",
  "company_id",
  "estimate_id",
  "decision",
  "signer_name",
  "signer_email",
  "consent_text",
  "consent_accepted",
  "signed_at",
  "ip",
  "geo_location",
  "device_fingerprint",
  "document_hash",
  "signature_path",
  "created_at",
  "updated_at",
  "version",
].join(",")}`;

/** The row shape of `0027`, validated on every read the way the quote's own row is. */
export const estimateSignatureRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  estimate_id: z.string().uuid(),
  decision: z.string().min(1),
  signer_name: z.string().min(1),
  signer_email: z.string().min(3),
  consent_text: z.string().min(1),
  consent_accepted: z.boolean(),
  signed_at: z.string().min(1),
  ip: z.string().min(1),
  geo_location: z.string().nullable(),
  device_fingerprint: z.string().nullable(),
  document_hash: z.string().regex(ESTIMATE_DOCUMENT_HASH_PATTERN),
  signature_path: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  version: z.number().int().positive(),
});

export type EstimateSignatureRow = z.infer<typeof estimateSignatureRowSchema>;

/**
 * The evidence as a reader prints it.
 *
 * There is no `version` here, and that is deliberate: an append-only row has no optimistic lock to offer,
 * and printing a version beside a record that can never be updated invites an edit that `0027`'s trigger
 * refuses. A quote's lines carry their versions because they are editable; its signature does not, because
 * it is not.
 */
export interface EstimateSignatureSnapshot {
  readonly id: string;
  readonly estimateId: string;
  readonly companyId: string;
  readonly decision: EstimateSignatureDecision;
  readonly signerName: string;
  readonly signerEmail: string;
  /** The wording that was shown beside the checkbox, as it was shown. */
  readonly consentText: string;
  readonly consentAccepted: boolean;
  readonly signedAt: string;
  readonly ip: string;
  readonly geoLocation: string | null;
  readonly deviceFingerprint: string | null;
  /** The offer the signer decided, as SHA-256: see `hashEstimateDocument`. */
  readonly documentHash: string;
  readonly signaturePath: string | null;
  readonly signedAtEpochMs: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export function estimateSignatureSnapshotOf(row: EstimateSignatureRow): EstimateSignatureSnapshot {
  if (!isEstimateSignatureDecision(row.decision)) {
    // Neither decision is a safe fallback: one would claim a client agreed, the other that they refused.
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "decision", rule: "invalid_format" }] });
  }

  return {
    id: row.id,
    estimateId: row.estimate_id,
    companyId: row.company_id,
    decision: row.decision,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    consentText: row.consent_text,
    consentAccepted: row.consent_accepted,
    signedAt: row.signed_at,
    signedAtEpochMs: Date.parse(row.signed_at),
    ip: row.ip,
    geoLocation: row.geo_location,
    deviceFingerprint: row.device_fingerprint,
    documentHash: row.document_hash,
    signaturePath: row.signature_path,
    createdAtEpochMs: Date.parse(row.created_at),
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

export interface EstimateSignatureDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  /** The clock, injected so a gate can ask what a signature recorded at a known instant. */
  readonly now?: () => number;
}

/** The order refusals are listed in, which is the order a signer meets the boxes. */
const SIGNATURE_FIELD_ORDER = Object.freeze([
  "estimate_signature",
  "estimate_id",
  "company_id",
  "decision",
  "signer_name",
  "signer_email",
  "consent_accepted",
  "consent_text",
  "ip_address",
  "geo_location",
  "device_fingerprint",
  "signature_path",
]);

/**
 * What a caller may send.
 *
 * `.strict()` is the point: there is no `document_hash` key, so a caller that offers one is refused rather
 * than believed, and no amount is offered either, because a signature attests to a document and not to a
 * total.
 */
export const estimateSignatureCaptureSchema = z
  .object({
    estimate_id: z.string().uuid(),
    company_id: z.string().uuid(),
    decision: z.enum(ESTIMATE_SIGNATURE_DECISIONS),
    signer_name: z.string(),
    signer_email: z.string(),
    consent_text: z.string(),
    consent_accepted: z.boolean(),
    ip_address: z.string(),
    geo_location: z.string().nullable().optional(),
    device_fingerprint: z.string().nullable().optional(),
    signature_path: z.string().nullable().optional(),
    user_agent: z.string().nullable().optional(),
  })
  .strict();

/** The evidence, checked and canonical, ready to be written exactly as it will be stored. */
export interface ParsedEvidence {
  readonly estimateId: string;
  readonly companyId: string;
  readonly decision: EstimateSignatureDecision;
  readonly signerName: string;
  readonly signerEmail: string;
  readonly consentText: string;
  readonly ip: string;
  readonly geoLocation: string | null;
  readonly deviceFingerprint: string | null;
  readonly signaturePath: string | null;
  readonly userAgent: string | null;
}

/** A trimmed single-line value, judged against the column's own floor and ceiling. */
function singleLineProblem(value: string, limits: { readonly min: number; readonly max: number }): string | null {
  if (value.length < limits.min) {
    return "too_short";
  }

  if (value.length > limits.max) {
    return "too_long";
  }

  // The column also requires the value to equal its own trim, and the platform's single-line sanitiser
  // strips what a signature must not hold. Comparing instead of assigning is what makes this a refusal
  // rather than a quiet repair: the evidence is stored as it was given or not at all.
  return sanitizeSingleLineText(value, limits.max) === value ? null : "invalid_format";
}

/**
 * The evidence a caller sent, checked element by element.
 *
 * Every refusal names the element it is about, in the order a signer meets them, so a page can put the
 * sentence beside the right box. The rules are the quote's own - see `ESTIMATE_SIGNATURE_RULES`.
 */
export function parseEstimateSignatureCapture(body: unknown): ParsedEvidence {
  const attempt = estimateSignatureCaptureSchema.safeParse(body);

  if (!attempt.success) {
    const problems: ErrorDetail[] = [];

    for (const issue of attempt.error.issues) {
      // A key nobody recognises is named as one, the way the client book and the catalogue name it. This
      // is the refusal a caller meets for offering a `document_hash` of its own, so it has to say which
      // key was not wanted rather than merely that the body was wrong.
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          if (!problems.some((problem) => problem.field === key)) {
            problems.push({ field: key, rule: "unknown_field" });
          }
        }

        continue;
      }

      // A missing key and a wrongly shaped one are the same answer: this box cannot hold what arrived. An
      // issue on a body that is not an object at all has no path, so the document is named instead - a
      // refusal with an empty field is a sentence nobody can act on.
      const field = String(issue.path[0] ?? "estimate_signature");

      if (!problems.some((problem) => problem.field === field)) {
        problems.push({ field, rule: "invalid_format" });
      }
    }

    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problems, SIGNATURE_FIELD_ORDER, INVOICE_LINE_FIELDS),
    });
  }

  const data = attempt.data;
  const problems: ErrorDetail[] = [];

  function reject(field: string, rule: string): void {
    if (!problems.some((problem) => problem.field === field)) {
      problems.push({ field, rule });
    }
  }

  const signerName = data.signer_name.trim();
  const nameProblem = singleLineProblem(signerName, ESTIMATE_SIGNATURE_LIMITS.signerName);

  if (nameProblem !== null) {
    reject("signer_name", nameProblem);
  }

  const signerEmail = data.signer_email.trim();
  const emailLimits = ESTIMATE_SIGNATURE_LIMITS.signerEmail;

  if (signerEmail.length < emailLimits.min) {
    reject("signer_email", "too_short");
  } else if (signerEmail.length > emailLimits.max) {
    reject("signer_email", "too_long");
  } else if (!ESTIMATE_SIGNATURE_EMAIL_PATTERN.test(signerEmail)) {
    reject("signer_email", "invalid_format");
  }

  // An unticked box is not consent, and `0027` will not store one: the refusal is `required`, because that
  // is what a checkbox nobody ticked is, rather than a rule invented for it.
  if (!data.consent_accepted) {
    reject("consent_accepted", "required");
  }

  const consentText = data.consent_text;

  if (consentText.trim().length < ESTIMATE_SIGNATURE_LIMITS.consentText.min) {
    reject("consent_text", "required");
  } else if (consentText.length > ESTIMATE_SIGNATURE_LIMITS.consentText.max) {
    reject("consent_text", "too_long");
  } else if (sanitizeMultilineText(consentText, ESTIMATE_SIGNATURE_LIMITS.consentText.max) !== consentText) {
    reject("consent_text", "invalid_format");
  }

  // The address is canonicalised with the platform's one canonicaliser, which is the same function the
  // audit chain uses, so the evidence row and the audit entry spell one address one way. An address that
  // does not canonicalise is refused rather than stored for the `inet` column to reject.
  const ip = canonicalRateLimitAddress(data.ip_address);

  if (ip === null) {
    reject("ip_address", "invalid_format");
  }

  const geoLocation = data.geo_location ?? null;

  if (geoLocation !== null) {
    const geoProblem = singleLineProblem(geoLocation.trim(), ESTIMATE_SIGNATURE_LIMITS.geoLocation);

    if (geoProblem !== null) {
      reject("geo_location", geoProblem);
    }
  }

  const deviceFingerprint = data.device_fingerprint ?? null;

  if (deviceFingerprint !== null) {
    const fingerprintLimits = ESTIMATE_SIGNATURE_LIMITS.deviceFingerprint;

    if (deviceFingerprint.length < fingerprintLimits.min) {
      reject("device_fingerprint", "too_short");
    } else if (deviceFingerprint.length > fingerprintLimits.max) {
      reject("device_fingerprint", "too_long");
    } else if (!ESTIMATE_SIGNATURE_FINGERPRINT_PATTERN.test(deviceFingerprint)) {
      reject("device_fingerprint", "invalid_format");
    }
  }

  const signaturePath = data.signature_path ?? null;

  if (signaturePath !== null) {
    const pathProblem = singleLineProblem(signaturePath.trim(), ESTIMATE_SIGNATURE_LIMITS.signaturePath);

    if (pathProblem !== null) {
      reject("signature_path", pathProblem);
    }
  }

  if (problems.length > 0 || ip === null) {
    throw new AppError("VALIDATION_FAILED", {
      details: orderDocumentDetails(problems, SIGNATURE_FIELD_ORDER, INVOICE_LINE_FIELDS),
    });
  }

  // The agent is not one of section 16's eight elements, so it never reaches the evidence row: `0027` has
  // no column for it and `audit_logs` does. It is bounded by the audit chain's own ceiling rather than by a
  // number of this module's, because an entry the chain would refuse is an entry the capture would silently
  // lose - `appendTolerated` swallows a refusal, and a signature with no chain link is a weaker record.
  const agent = data.user_agent ?? null;
  const userAgent = agent === null ? null : sanitizeSingleLineText(agent, AUDIT_MAXIMUM_USER_AGENT_LENGTH);

  return {
    estimateId: data.estimate_id,
    companyId: data.company_id,
    decision: data.decision,
    signerName,
    signerEmail,
    consentText,
    ip,
    geoLocation: geoLocation === null ? null : geoLocation.trim(),
    deviceFingerprint,
    signaturePath: signaturePath === null ? null : signaturePath.trim(),
    // Normalised rather than refused: an agent is a fact about the request, not something attested to.
    // An agent that was only ever whitespace becomes null, which is what both the column and the chain
    // accept, rather than an empty string that neither does.
    userAgent: userAgent === null || userAgent.length === 0 ? null : userAgent,
  };
}

/**
 * The evidence of one decision, written once.
 *
 * Two reads, one insert and one audit entry, in that order: the quote (scoped by id and company, so a pair
 * that does not belong together finds nothing), whether it is open for signing, and whether it has already
 * been decided. The insert is the only write, and the unique index on `estimate_id` is the backstop for two
 * clients deciding at the same instant.
 */
export async function captureEstimateSignature(
  body: unknown,
  dependencies: EstimateSignatureDependencies,
): Promise<EstimateSignatureSnapshot> {
  const evidence = parseEstimateSignatureCapture(body);
  const quotes = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `${ESTIMATE_COLUMNS}&id=eq.${evidence.estimateId}&company_id=eq.${evidence.companyId}&deleted_at=is.null`,
    estimateRowSchema,
  );
  const quote = quotes[0];

  if (quote === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  if (!(ESTIMATE_SIGNATURE_OPEN_STATUSES as readonly string[]).includes(quote.status)) {
    // The same sentence a line edit meets on a quote that has moved on: the document is not in the state
    // this write needs. The database would refuse it too, and a refusal with a field beats an exception.
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "already_changed" }] });
  }

  const decided = await dependencies.rest.select(
    ESTIMATE_SIGNATURES_TABLE,
    `${ESTIMATE_SIGNATURE_COLUMNS}&estimate_id=eq.${evidence.estimateId}&company_id=eq.${evidence.companyId}&deleted_at=is.null`,
    estimateSignatureRowSchema,
  );

  if (decided.length > 0) {
    throw new AppError("CONFLICT", { details: [{ field: "estimate_id", rule: "already_used" }] });
  }

  // The digest of the offer as the signer is seeing it, computed here rather than believed from a caller.
  const lines = await readEstimateLines(dependencies.rest, evidence.companyId, quote.id);
  const documentHash = hashEstimateDocument(estimateSnapshotOf(quote, lines));
  const now = dependencies.now?.() ?? Date.now();

  let written: readonly EstimateSignatureRow[];

  try {
    written = await dependencies.rest.insertReturning(
      ESTIMATE_SIGNATURES_TABLE,
      [
        {
          company_id: evidence.companyId,
          estimate_id: quote.id,
          decision: evidence.decision,
          signer_name: evidence.signerName,
          signer_email: evidence.signerEmail,
          consent_text: evidence.consentText,
          // Always true: an unticked box was refused above, so the only row this writes is a consent.
          consent_accepted: true,
          signed_at: new Date(now).toISOString(),
          ip: evidence.ip,
          geo_location: evidence.geoLocation,
          device_fingerprint: evidence.deviceFingerprint,
          document_hash: documentHash,
          signature_path: evidence.signaturePath,
        },
      ],
      estimateSignatureRowSchema,
    );
  } catch (error) {
    // The unique index is what two clients deciding at once arrive as. Naming the quote rather than the
    // signer is the honest field: it is the reference that is already taken.
    throw error instanceof AppError && error.code === "CONFLICT"
      ? new AppError("CONFLICT", { details: [{ field: "estimate_id", rule: "already_used" }] })
      : error;
  }

  const row = written[0];

  if (row === undefined) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "estimate_signature", rule: "not_found" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: ESTIMATE_SIGNATURE_RECORDED_AUDIT_ACTION,
    // No actor: the signer is a client, and clients hold no account on this platform. The entry still
    // belongs to the merchant's chain, and it still carries the address and the agent the decision
    // arrived with, which is what makes it corroborate the evidence row rather than merely mention it.
    actorUserId: null,
    entityType: ESTIMATE_SIGNATURE_AUDIT_ENTITY,
    entityId: row.id,
    // Field facts and the digest, never the signer's name or address: the audit chain is a second store
    // with its own readers, and personal data belongs in the one table section 16 built for it.
    payload: Object.freeze({
      decision: row.decision,
      document_hash: row.document_hash,
      consent_accepted: row.consent_accepted,
      has_geo_location: row.geo_location !== null,
      has_device_fingerprint: row.device_fingerprint !== null,
      has_signature_path: row.signature_path !== null,
    }),
    companyId: evidence.companyId,
    ipAddress: row.ip,
    userAgent: evidence.userAgent,
  });

  return estimateSignatureSnapshotOf(row);
}

/**
 * The evidence on one of this merchant's quotes, or null when nobody has decided it yet.
 *
 * Null rather than a 404, because an unsigned quote is the normal state of a quote and not a missing
 * resource - and a screen that had to distinguish "no signature" from "no quote" would otherwise have to
 * read two refusals. The quote is read first, so a quote that is not there, or belongs to another merchant,
 * is a 404 about the quote and never a null that looks like an unsigned one.
 *
 * A read is not a mutation, so it earns no audit entry: rule 9 is about writes, and the merchant reading
 * their own client's decision is not a fact worth a chain link.
 */
export async function readEstimateSignature(
  input: { readonly actor: RequestActor; readonly estimateId: string },
  dependencies: EstimateSignatureDependencies,
): Promise<EstimateSignatureSnapshot | null> {
  const companyId = requireEstimateActor(input.actor);
  const quotes = await dependencies.rest.select(
    ESTIMATE_TABLE,
    `${ESTIMATE_COLUMNS}&id=eq.${input.estimateId}&company_id=eq.${companyId}&deleted_at=is.null`,
    estimateRowSchema,
  );

  if (quotes[0] === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "estimate", reason: "not_found" } });
  }

  const found = await dependencies.rest.select(
    ESTIMATE_SIGNATURES_TABLE,
    `${ESTIMATE_SIGNATURE_COLUMNS}&estimate_id=eq.${input.estimateId}&company_id=eq.${companyId}&deleted_at=is.null`,
    estimateSignatureRowSchema,
  );
  const row = found[0];

  return row === undefined ? null : estimateSignatureSnapshotOf(row);
}

/** The role and the company, read from the session and never from a body - as the quote's own readers do. */
function requireEstimateActor(actor: RequestActor): string {
  requireAnyRole(actor, ESTIMATE_MANAGE_ROLES);

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}
