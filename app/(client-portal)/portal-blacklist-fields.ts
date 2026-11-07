// path: app/(client-portal)/portal-blacklist-fields.ts
import { z } from "zod";
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { FRAUD_CARD_FINGERPRINT_PATTERN } from "../../lib/security/fraud.ts";
import { PORTAL_PAYMENT_AUDIT_ENTITY } from "./portal-payment-fields.ts";

/**
 * The vocabulary of section 18's blacklist sentence: "card blacklist entries use card token or provider card
 * fingerprint."
 *
 * ## The table is already there, and it is the platform's
 *
 * `migrations/0055_card_blacklist.sql` (STEP 030) is the list. It has one place for this page to write and one
 * shape for this page to read, and it fixes four things this file must not invent again:
 *
 *   - `card_fingerprint` is `^[0-9a-f]{64}$` - the SHA-256 of *whichever of the two* the adapter handed back,
 *     with `fingerprint_source` recording which. There is no column for a card number, an expiry, a CVV or a
 *     clear token, and this module never produces one.
 *   - `fingerprint_source` is `card_token` or `provider_fingerprint`, so a block made from one is not silently
 *     compared with the other.
 *   - `reason` is a closed list of six, and `other` carries a note, because a block that says only "other" is a
 *     block nobody can act on later.
 *   - `company_id` is always null: the block is the platform's, and a card used to test cards across three
 *     merchants is one block.
 *
 * The gate reads that migration and asserts each of these against the constants below, so the two cannot drift.
 *
 * ## Why the fingerprint is a hash and not the token
 *
 * A clear token is a bearer instrument: whoever holds it can charge the card. Section 18 allows exactly two
 * card-side identifiers in this platform, and both are hashes - so a row in this table cannot be used to charge
 * anything, and a dump of it is not a list of live tokens.
 */

/** The table the list lives in. One reader, one writer, both in this block. */
export const PORTAL_BLACKLIST_TABLE = "card_blacklist";

/** Which of the two allowed identifiers an entry was made from. */
export const PORTAL_BLACKLIST_SOURCES = deepFreeze(["card_token", "provider_fingerprint"] as const);

export type PortalBlacklistSource = (typeof PORTAL_BLACKLIST_SOURCES)[number];

/** The reasons `card_blacklist_reason_check` accepts, in its order. */
export const PORTAL_BLACKLIST_REASONS = deepFreeze([
  "fraud",
  "card_testing",
  "chargeback",
  "stolen_card",
  "compliance",
  "other",
] as const);

export type PortalBlacklistReason = (typeof PORTAL_BLACKLIST_REASONS)[number];

/** The two states a block has: it is on the list, or it is history. */
export const PORTAL_BLACKLIST_STATUSES = deepFreeze(["active", "released"] as const);

/** The one reason that cannot stand without a note, because "other" alone says nothing. */
export const PORTAL_BLACKLIST_NOTE_REQUIRED_REASON: PortalBlacklistReason = "other";

/** The fingerprint alphabet, imported from STEP 066 rather than spelled twice. */
export const PORTAL_BLACKLIST_FINGERPRINT_PATTERN = FRAUD_CARD_FINGERPRINT_PATTERN;

/** The note bounds `card_blacklist_note_check` and `card_blacklist_release_note_check` state. */
export const PORTAL_BLACKLIST_NOTE_MINIMUM_LENGTH = 1;
export const PORTAL_BLACKLIST_NOTE_MAXIMUM_LENGTH = 500;

/** The columns a check reads: what a decision needs, and nothing else. */
export const PORTAL_BLACKLIST_SELECT =
  "select=id,card_fingerprint,fingerprint_source,reason,status,blacklisted_at,expires_at";

/** The columns a release reads back, which are what proves the release happened. */
export const PORTAL_BLACKLIST_RELEASE_SELECT =
  "select=id,card_fingerprint,fingerprint_source,reason,status,blacklisted_at,released_at,released_by,release_note,expires_at,version";

/**
 * The rules this module refuses with.
 *
 * `blocked` and `unavailable` are the payment page's: a listed card is refused, and a list that cannot be read
 * refuses too rather than clearing a card it never checked. The rest belong to the writing service, which is
 * called by a person.
 */
export const PORTAL_BLACKLIST_RULES = deepFreeze({
  blocked: "card_blacklisted",
  unavailable: "card_blacklist_unavailable",
  alreadyBlocked: "card_already_blocked",
  alreadyReleased: "card_block_released",
  stale: "stale_version",
  notFound: "not_found",
  noteRequired: "note_required",
  invalidFingerprint: "invalid_fingerprint",
  invalidSource: "invalid_source",
  invalidReason: "invalid_reason",
  invalidExpiry: "invalid_expiry",
});

/**
 * The failure code a payment refused by the list carries.
 *
 * `payments_failure_code_check` accepts any trimmed code up to 64 characters, and the risk decision that goes
 * with it is `reject`, which `payments_risk_reject_check` allows only on a `failed` payment. It is deliberately
 * not STEP 066's `risk_rejected`: that one says the gateway called the card fraudulent, and this one says the
 * platform already knew.
 */
export const PORTAL_BLACKLIST_SETTLED_CODE = "card_blacklisted";

/** The audit entity of a block: the list itself, because a block outlives the payment that caused it. */
export const PORTAL_BLACKLIST_AUDIT_ENTITY = "card_blacklist";

/** The audit entity of a refused payment: still a payment, read by the same subject. */
export const PORTAL_BLACKLIST_PAYMENT_ENTITY = PORTAL_PAYMENT_AUDIT_ENTITY;

/** The audit actions of this STEP. */
export const PORTAL_BLACKLIST_REFUSED_AUDIT_ACTION = "portal.card_blacklisted_refused";
export const PORTAL_BLACKLIST_UNAVAILABLE_AUDIT_ACTION = "portal.card_blacklist_unavailable";
export const PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION = "portal.card_blocked";
export const PORTAL_BLACKLIST_RELEASED_AUDIT_ACTION = "portal.card_block_released";
export const PORTAL_BLACKLIST_REQUESTED_AUDIT_ACTION = "portal.card_block_requested";

/** The uuid shape `public.users.id` and every `*_id` column here take. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** One row of the list, as a check reads it. Parsed, so a malformed row is a failure rather than a guess. */
export const portalBlacklistRowSchema = z.object({
  id: z.string().regex(uuidPattern),
  card_fingerprint: z.string().regex(PORTAL_BLACKLIST_FINGERPRINT_PATTERN),
  fingerprint_source: z.enum(PORTAL_BLACKLIST_SOURCES),
  reason: z.enum(PORTAL_BLACKLIST_REASONS),
  status: z.enum(PORTAL_BLACKLIST_STATUSES),
  blacklisted_at: z.string().min(1),
  expires_at: z.string().min(1).nullable(),
});

export type PortalBlacklistRow = z.infer<typeof portalBlacklistRowSchema>;

/** One row of the list, as a release reads it back. */
export const portalBlacklistReleaseRowSchema = portalBlacklistRowSchema.extend({
  released_at: z.string().min(1).nullable(),
  released_by: z.string().regex(uuidPattern).nullable(),
  release_note: z.string().nullable(),
  version: z.number().int().positive(),
});

export type PortalBlacklistReleaseRow = z.infer<typeof portalBlacklistReleaseRowSchema>;

/** The note shape both constraints state: trimmed, and between one and five hundred characters. */
const noteSchema = z
  .string()
  .refine(
    (note) =>
      note === note.trim() &&
      note.length >= PORTAL_BLACKLIST_NOTE_MINIMUM_LENGTH &&
      note.length <= PORTAL_BLACKLIST_NOTE_MAXIMUM_LENGTH,
    { message: "a note is trimmed and between one and five hundred characters" },
  );

/**
 * What blocking a card requires.
 *
 * The person is required and is a real user id, because `card_blacklist.blacklisted_by` references
 * `public.users` and the table's own trigger freezes it forever. There is deliberately no "system" actor: a
 * block is a person's decision on an immutable list.
 */
export const portalBlacklistBlockInputSchema = z
  .object({
    fingerprint: z.string().regex(PORTAL_BLACKLIST_FINGERPRINT_PATTERN),
    source: z.enum(PORTAL_BLACKLIST_SOURCES),
    reason: z.enum(PORTAL_BLACKLIST_REASONS),
    note: noteSchema.nullable(),
    blacklistedBy: z.string().regex(uuidPattern),
    blacklistedAtEpochMs: z.number().int().positive(),
    expiresAtEpochMs: z.number().int().positive().nullable(),
    providerId: z.string().regex(uuidPattern).nullable(),
    sourcePaymentId: z.string().regex(uuidPattern).nullable(),
  })
  .strict()
  .refine(
    (input) => input.reason !== PORTAL_BLACKLIST_NOTE_REQUIRED_REASON || input.note !== null,
    { message: "the reason `other` needs a note", path: ["note"] },
  )
  .refine(
    (input) => input.expiresAtEpochMs === null || input.expiresAtEpochMs > input.blacklistedAtEpochMs,
    { message: "a temporary block ends after it starts", path: ["expiresAtEpochMs"] },
  );

export type PortalBlacklistBlockInput = z.infer<typeof portalBlacklistBlockInputSchema>;

/** What releasing a card requires. The version is the optimistic lock `0055` keeps on every row. */
export const portalBlacklistReleaseInputSchema = z
  .object({
    blockId: z.string().regex(uuidPattern),
    releasedBy: z.string().regex(uuidPattern),
    note: noteSchema,
    releasedAtEpochMs: z.number().int().positive(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export type PortalBlacklistReleaseInput = z.infer<typeof portalBlacklistReleaseInputSchema>;
