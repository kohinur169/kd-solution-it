// path: lib/security/upload.ts
import { createHash } from "node:crypto";
import { AppError } from "../errors/app-error.ts";
import { sanitizeFileName } from "./text.ts";

/**
 * What a file must be before this platform will store it.
 *
 * ## The three questions, and why the second one is the one that matters
 *
 *   1. **How big is it?** A limit per purpose, all of them at or under the 50 MB row check of migration
 *      0057. A size is the only property of a file a server can know without reading it, and a server
 *      that trusts it has been told a number by the client.
 *   2. **What is it, really?** The `Content-Type` a browser sends is a claim, not a fact: a POST can say
 *      `image/png` and send HTML, and every handler that stores the claim and serves it back is an
 *      open redirect to a stored XSS. The only evidence is the bytes, so the first 32 of them are read
 *      and compared with the signatures of the four types this platform accepts.
 *   3. **Do the claim and the evidence agree?** They must. A PNG declared as a PDF is the classic
 *      polyglot, and the platform's answer is quarantine rather than refusal: the object is recorded,
 *      never served, and a person can see why (`files.quarantined_reason`).
 *
 * ## Why quarantine is a separate outcome from rejection
 *
 * They are different facts and the database already models the difference (`magic_byte_verified`,
 * `verified_at`, `status`, `quarantined_reason` in `0057_files.sql`). A rejected upload never became a
 * row: it was too large, or a type this purpose does not accept, or empty - the caller gets
 * `422 VALIDATION_FAILED` and fixes the form. A quarantined upload *is* a row, with the bytes hashed and
 * the reason recorded, because "this merchant sent us a file that lied about its type" is evidence
 * somebody needs and a refusal discards.
 *
 * ## What is deliberately not accepted
 *
 * `image/svg+xml` is refused for every purpose. An SVG is a document that may carry `<script>`, an
 * external reference or a font, and this platform has no SVG sanitiser (the rich text allowlist of
 * `html.ts` is for a different job). A logo is a PNG, a JPEG or a WebP.
 *
 * `application/zip`, `application/msword` and the OOXML formats are refused for the same reason at one
 * remove: they are containers, and a container needs an extractor with its own zip-bomb, path traversal
 * and macro rules. Nothing in the five purposes of section 21 needs one.
 *
 * ## What this module does not do, and the STEP that must
 *
 * It does not encrypt (section 21: AES-256-GCM before upload, owned by the storage STEPs 100-105, with
 * the quartet `0057` already has columns for), it does not store, and it does not sign a download URL.
 * It reads bytes that a route already has. The rule it leaves behind: **whatever serves a stored file
 * must send `content-disposition: attachment` and keep `nosniff`** - a quarantined PDF rendered inline
 * by a browser is the one thing this validator cannot prevent on its own.
 */

/** The five upload purposes of migration 0057, in the order the purpose check lists them. */
export const UPLOAD_PURPOSES = [
  "kyc_document",
  "company_logo",
  "invoice_pdf",
  "dispute_document",
  "support_attachment",
] as const;

export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** The largest row the `files_size_check` of migration 0057 accepts. No policy may exceed it. */
export const UPLOAD_DATABASE_MAXIMUM_BYTES = 52_428_800;

/** The longest quarantine reason `files_quarantine_reason_check` accepts. */
export const UPLOAD_MAXIMUM_REASON_LENGTH = 280;

/** How many bytes are read to decide a type. A signature is at most eight bytes at offset eight. */
export const UPLOAD_SNIFF_BYTES = 32;

/** The field a rejected upload is reported under, and the rule names a form shows. */
export const UPLOAD_FIELD = "file";
export const UPLOAD_RULE = "file_not_acceptable";

/** Why an upload was refused outright. Each one is a form error, not a quarantine. */
export type UploadRejectionReason =
  | "empty_file"
  | "too_large"
  | "type_missing"
  | "type_not_allowed";

/** What a route does with an accepted upload. */
export type UploadVerdictKind = "verified" | "quarantined";

/** The quarantine reasons, in the words an operator reads in the file record. */
export const UPLOAD_QUARANTINE_REASONS = Object.freeze({
  unknownSignature: "the first bytes of the file match no type this platform accepts",
  typeMismatch: "the declared type and the bytes disagree",
  activeContent: "the file begins with markup or script, which is never a document it claims to be",
} as const);

/** One policy: what a purpose accepts and how large it may be. */
export interface UploadPolicy {
  readonly purpose: UploadPurpose;
  readonly allowedTypes: readonly string[];
  readonly maximumBytes: number;
}

/**
 * The per-purpose rules.
 *
 * The sizes are not uniform because the files are not: a logo is an icon rendered at 96 pixels, a KYC
 * scan is a photograph of a utility bill taken on a phone, and the rest sit between them. Every limit is
 * at or under `UPLOAD_DATABASE_MAXIMUM_BYTES`, which the gate proves rather than trusts.
 */
export const UPLOAD_POLICIES: Readonly<Record<UploadPurpose, UploadPolicy>> = Object.freeze({
  kyc_document: Object.freeze({
    purpose: "kyc_document",
    allowedTypes: Object.freeze(["application/pdf", "image/jpeg", "image/png"]),
    maximumBytes: 52_428_800,
  }),
  company_logo: Object.freeze({
    purpose: "company_logo",
    allowedTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"]),
    maximumBytes: 2_097_152,
  }),
  invoice_pdf: Object.freeze({
    purpose: "invoice_pdf",
    allowedTypes: Object.freeze(["application/pdf"]),
    maximumBytes: 26_214_400,
  }),
  dispute_document: Object.freeze({
    purpose: "dispute_document",
    allowedTypes: Object.freeze(["application/pdf", "image/jpeg", "image/png"]),
    maximumBytes: 52_428_800,
  }),
  support_attachment: Object.freeze({
    purpose: "support_attachment",
    allowedTypes: Object.freeze(["application/pdf", "image/jpeg", "image/png"]),
    maximumBytes: 10_485_760,
  }),
});

/** A type this platform recognises, and the bytes that identify it at the start of the file. */
interface MagicSignature {
  readonly contentType: string;
  /** Every part must match at its offset. A WebP needs two: `RIFF` at 0 and `WEBP` at 8. */
  readonly parts: readonly { readonly offset: number; readonly bytes: readonly number[] }[];
}

const MAGIC_SIGNATURES: readonly MagicSignature[] = Object.freeze([
  {
    contentType: "application/pdf",
    // `%PDF-`. The hyphen is part of it: `%PDF` alone is not a header, and a text file may start with it.
    parts: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
  },
  {
    contentType: "image/jpeg",
    // SOI followed by the first marker byte: every JPEG the platform will ever see starts with FFD8FF.
    parts: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  },
  {
    contentType: "image/png",
    // The eight byte signature, which includes the `\r\n\x1a\n` that catches a broken upload or a
    // text-mode transfer that rewrote the line endings.
    parts: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  {
    contentType: "image/webp",
    parts: [
      { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
]);

/** The prefixes that mean "this is markup or script", whatever the upload claims to be. */
const ACTIVE_CONTENT_PREFIXES: readonly string[] = Object.freeze([
  "<script",
  "<!doctype",
  "<html",
  "<?xml",
  "<svg",
  "<%",
]);

/** The type a signature set identifies, or null when the bytes match none of them. */
export function detectContentType(head: Uint8Array): string | null {
  for (const signature of MAGIC_SIGNATURES) {
    const matched = signature.parts.every((part) => {
      if (head.length < part.offset + part.bytes.length) {
        return false;
      }

      return part.bytes.every((byte, index) => head[part.offset + index] === byte);
    });

    if (matched) {
      return signature.contentType;
    }
  }

  return null;
}

/** The first `UPLOAD_SNIFF_BYTES` of a buffer, which is all a type decision needs. */
export function sniffHead(bytes: Uint8Array): Uint8Array {
  return bytes.subarray(0, UPLOAD_SNIFF_BYTES);
}

/** SHA-256 of the plaintext, in the lower case hex `files_hash_check` accepts. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** What a route knows about an upload before it has read all of it. */
export interface UploadCandidate {
  /** The name the browser sent. Display only: the storage key is generated by the platform. */
  readonly fileName: string;
  /** The `Content-Type` the client declared. A claim until the bytes agree with it. */
  readonly declaredType: string;
  /** The length the client declared, which is a claim too, so the caller passes what it counted. */
  readonly byteSize: number;
  /** The first bytes of the file. At least `UPLOAD_SNIFF_BYTES` for a type decision. */
  readonly head: Uint8Array;
}

/** What the database needs to know about an upload that was accepted. */
export interface UploadVerdict {
  readonly decision: UploadVerdictKind;
  readonly fileName: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** Set only when `decision` is `quarantined`; the words that go in `files.quarantined_reason`. */
  readonly quarantineReason: string | null;
}

export type UploadDecision =
  | { readonly ok: true; readonly verdict: UploadVerdict }
  | { readonly ok: false; readonly reason: UploadRejectionReason };

function hasActiveContentPrefix(head: Uint8Array): boolean {
  const window = String.fromCharCode(...head).toLowerCase();

  return ACTIVE_CONTENT_PREFIXES.some((prefix) => window.includes(prefix));
}

/**
 * The decision.
 *
 * Rejections come first, in the order a form cares about: a missing type is a client bug, an empty file
 * is a mistake, a size is a limit, and a type the purpose does not accept is a rule. Only then are the
 * bytes read - and a file that passes every earlier question can still be quarantined, which is why the
 * two outcomes are not the same shape.
 */
export function validateUpload(candidate: UploadCandidate, purpose: UploadPurpose): UploadDecision {
  const policy = UPLOAD_POLICIES[purpose];
  const declared = candidate.declaredType.trim().toLowerCase();

  if (declared.length === 0) {
    return { ok: false, reason: "type_missing" };
  }

  if (candidate.byteSize <= 0) {
    return { ok: false, reason: "empty_file" };
  }

  if (candidate.byteSize > policy.maximumBytes) {
    return { ok: false, reason: "too_large" };
  }

  if (!policy.allowedTypes.includes(declared)) {
    return { ok: false, reason: "type_not_allowed" };
  }

  const fileName = sanitizeFileName(candidate.fileName);
  const head = sniffHead(candidate.head);
  const detected = detectContentType(head);

  if (detected === null) {
    return {
      ok: true,
      verdict: {
        decision: "quarantined",
        fileName,
        contentType: declared,
        byteSize: candidate.byteSize,
        quarantineReason: hasActiveContentPrefix(head)
          ? UPLOAD_QUARANTINE_REASONS.activeContent
          : UPLOAD_QUARANTINE_REASONS.unknownSignature,
      },
    };
  }

  if (detected !== declared) {
    return {
      ok: true,
      verdict: {
        decision: "quarantined",
        fileName,
        contentType: detected,
        byteSize: candidate.byteSize,
        quarantineReason: UPLOAD_QUARANTINE_REASONS.typeMismatch,
      },
    };
  }

  if (!policy.allowedTypes.includes(detected)) {
    // Unreachable while `declared` is checked above, and kept because the two lists could drift: a
    // purpose that allowed a type without a signature would land here rather than store it.
    return { ok: false, reason: "type_not_allowed" };
  }

  return {
    ok: true,
    verdict: {
      decision: "verified",
      fileName,
      contentType: detected,
      byteSize: candidate.byteSize,
      quarantineReason: null,
    },
  };
}

/** The `AppError` a refused upload answers with: one code, one field, one rule. */
export function uploadRejection(reason: UploadRejectionReason, field: string = UPLOAD_FIELD): AppError {
  return new AppError("VALIDATION_FAILED", {
    details: [{ field, rule: UPLOAD_RULE }],
    // Which limit was broken is evidence for the log; the form learns one sentence.
    cause: { rule: UPLOAD_RULE, reason },
  });
}

/**
 * The call a route makes.
 *
 * A rejection throws; a quarantine returns, because the caller has a row to write and a person to tell.
 * The two are deliberately different in shape: a caller cannot forget to handle a quarantine, because
 * the verdict carries the decision, and cannot accidentally store a rejected file, because it never
 * receives one.
 */
export function requireValidUpload(
  candidate: UploadCandidate,
  purpose: UploadPurpose,
  field: string = UPLOAD_FIELD,
): UploadVerdict {
  const decision = validateUpload(candidate, purpose);

  if (!decision.ok) {
    throw uploadRejection(decision.reason, field);
  }

  return decision.verdict;
}
