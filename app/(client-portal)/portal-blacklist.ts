// path: app/(client-portal)/portal-blacklist.ts
import { createHash } from "node:crypto";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import type { FraudSignalLookups } from "../../lib/security/fraud.ts";
import {
  PORTAL_BLACKLIST_AUDIT_ENTITY,
  PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION,
  PORTAL_BLACKLIST_FINGERPRINT_PATTERN,
  PORTAL_BLACKLIST_RELEASE_SELECT,
  PORTAL_BLACKLIST_RELEASED_AUDIT_ACTION,
  PORTAL_BLACKLIST_RULES,
  PORTAL_BLACKLIST_SELECT,
  PORTAL_BLACKLIST_TABLE,
  portalBlacklistBlockInputSchema,
  portalBlacklistReleaseInputSchema,
  portalBlacklistReleaseRowSchema,
  portalBlacklistRowSchema,
  type PortalBlacklistBlockInput,
  type PortalBlacklistReason,
  type PortalBlacklistReleaseInput,
  type PortalBlacklistReleaseRow,
  type PortalBlacklistRow,
  type PortalBlacklistSource,
} from "./portal-blacklist-fields.ts";

/**
 * The card blacklist of section 18, read and written through the one table that holds it.
 *
 * ## What this module is, and what it refuses to be
 *
 * STEP 186 rejects a payment when the gateway names the card, and STEP 187 is the list that makes the knowledge
 * outlive the request. Two directions, both here:
 *
 *   - **The check**, which the payment page runs before the gateway is asked. A fingerprinted card that is on
 *     the list ends the attempt: nothing is sent, nothing is captured, and the refusal names the rule.
 *   - **The entry**, which a person writes. `card_blacklist.blacklisted_by` references `public.users` and the
 *     table's trigger freezes it, so a block is somebody's decision; this module takes that person as an
 *     argument and never invents one. The fraud-signal referral of STEP 186 therefore proposes a block when no
 *     officer is named, and writes one when one is.
 *
 * ## Why a token's hash is not a card's hash
 *
 * `0055` allows two identifiers, and the difference matters:
 *
 *   - `provider_fingerprint` is the gateway's own stable identifier for a card. Two payments on the same card
 *     produce the same one, so a block made from it stops the card.
 *   - `card_token` is what this platform holds - a Collect.js token - and the gateway's tokens are single use,
 *     so its hash identifies *that token* and not the card behind it. A block made from a token therefore
 *     stops a replay of that token and nothing more.
 *
 * Both are supported because both are in the schema and either may be the only thing an adapter returns. Which
 * one an entry was made from is stored and reported, so nobody reads a token block as a card block. The missing
 * half - a stable provider fingerprint from the NMI adapter, whose customer vault this platform does not use -
 * is named in the handoff rather than faked with a hash of something that is not the card.
 *
 * ## Fail closed
 *
 * A list that cannot be read is not a list that said no. `readPortalCardBlock` answers `unavailable` and the
 * payment page refuses; STEP 066's `FraudSignalLookups.isCardBlocked` - which this module also satisfies -
 * throws `DEPENDENCY_FAILED` for the same reason, because "we could not check" and "we checked and it was fine"
 * are opposite facts and only one of them is safe to act on.
 */

/** What reading the list needs. */
export interface PortalBlacklistDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** Why a reading could not be taken. */
export type PortalBlacklistFailure = "read_failed" | "malformed_row";

/** A block that is on the list now: what a refusal prints and a reviewer reads. */
export interface PortalCardBlockSummary {
  readonly fingerprint: string;
  readonly source: PortalBlacklistSource;
  readonly reason: PortalBlacklistReason;
  readonly blacklistedAt: string;
  readonly expiresAt: string | null;
}

/** What a check found. `clear` is the absence of a block, not an assurance about the card. */
export type PortalCardBlockReading =
  | {
      readonly status: "clear";
      /** The fingerprints the list was asked about, so a chain entry can say what was checked. */
      readonly checked: readonly string[];
    }
  | { readonly status: "blocked"; readonly block: PortalCardBlockSummary }
  | { readonly status: "unavailable"; readonly reason: PortalBlacklistFailure };

/** The check the payment operation asks before it sends anything to the gateway. */
export interface PortalBlacklistCheck {
  check(input: { readonly token: string }): Promise<PortalCardBlockReading>;
}

/** What writing a block answered. */
export type PortalCardBlocked =
  | { readonly status: "blocked"; readonly block: PortalCardBlockSummary; readonly blockId: string }
  | { readonly status: "already_blocked"; readonly block: PortalCardBlockSummary; readonly blockId: string };

/** What releasing a block answered. */
export type PortalCardReleased =
  | { readonly status: "released"; readonly blockId: string }
  | { readonly status: "already_released"; readonly blockId: string }
  | { readonly status: "stale"; readonly blockId: string }
  | { readonly status: "not_found" };

/**
 * The fingerprint of one card-side identifier: SHA-256, lowercase hex, exactly what `0055` stores.
 *
 * One function for both sources, because the two must hash identically for the comparison to mean anything.
 * What the hash was made *from* travels beside it and is stored beside it.
 */
export function portalCardFingerprintOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Every fingerprint an attempt can be asked about, token first.
 *
 * The token is always there - it is what the hosted fields hand back - and a provider fingerprint is added
 * when an adapter supplies one. A reading asks about all of them in one query, so a card is never let through
 * because the second identifier was not checked.
 */
export function portalCardFingerprintsOf(input: {
  readonly token: string;
  readonly providerFingerprint?: string | null;
}): readonly { readonly fingerprint: string; readonly source: PortalBlacklistSource }[] {
  const token = input.token.trim();
  const fingerprints: { readonly fingerprint: string; readonly source: PortalBlacklistSource }[] = [];

  if (token.length > 0) {
    fingerprints.push({ fingerprint: portalCardFingerprintOf(token), source: "card_token" });
  }

  const provider = input.providerFingerprint?.trim() ?? "";

  if (provider.length > 0) {
    fingerprints.push({ fingerprint: portalCardFingerprintOf(provider), source: "provider_fingerprint" });
  }

  return fingerprints;
}

/** The row as the summary a caller reads, with the two irrelevant columns dropped. */
function summaryOf(row: PortalBlacklistRow): PortalCardBlockSummary {
  return {
    fingerprint: row.card_fingerprint,
    source: row.fingerprint_source,
    reason: row.reason,
    blacklistedAt: row.blacklisted_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Whether a block is in force at one instant.
 *
 * A temporary block ends by itself, and nothing sweeps the column on a schedule, so the check reads the clock
 * rather than trusting a status. A row whose expiry has passed is history that has not been released.
 */
export function portalCardBlockInForce(row: PortalBlacklistRow, nowMs: number): boolean {
  if (row.status !== "active") {
    return false;
  }

  if (row.expires_at === null) {
    return true;
  }

  const expiry = Date.parse(row.expires_at);

  return Number.isFinite(expiry) && expiry > nowMs;
}

/**
 * Read the list for one or more fingerprints: one tenant-free query, one answer.
 *
 * `card_blacklist.company_id` is always null - the list is the platform's - so the query selects the platform's
 * rows explicitly rather than pretending a tenant scope the table does not have. The unique partial index
 * `card_blacklist_active_key` means at most one active row exists per fingerprint, which is why the read asks
 * for the newest and decides on it.
 */
export async function readPortalCardBlock(
  input: {
    readonly fingerprints: readonly string[];
    readonly nowMs: number;
  },
  dependencies: PortalBlacklistDependencies,
): Promise<PortalCardBlockReading> {
  const wanted = input.fingerprints.filter(
    (fingerprint) => PORTAL_BLACKLIST_FINGERPRINT_PATTERN.test(fingerprint),
  );

  if (wanted.length === 0) {
    // Nothing to ask about is not a failure: a caller with no identifier has nothing to block.
    return { status: "clear", checked: [] };
  }

  const query = `${PORTAL_BLACKLIST_SELECT}&company_id=is.null&status=eq.active&deleted_at=is.null&card_fingerprint=in.(${wanted.join(",")})&order=blacklisted_at.desc&limit=${String(wanted.length)}`;

  let rows: readonly PortalBlacklistRow[];

  try {
    rows = await dependencies.rest.select(PORTAL_BLACKLIST_TABLE, query, portalBlacklistRowSchema);
  } catch {
    // A list that cannot be read must not clear the card it was asked about.
    return { status: "unavailable", reason: "read_failed" };
  }

  const inForce = rows.filter((row) => portalCardBlockInForce(row, input.nowMs));

  if (inForce.length === 0) {
    return { status: "clear", checked: wanted };
  }

  const blocked = inForce[0];

  if (blocked === undefined) {
    return { status: "clear", checked: wanted };
  }

  return { status: "blocked", block: summaryOf(blocked) };
}

/** The check the payment page runs before the gateway is asked, for a token and an optional fingerprint. */
export async function checkPortalCardBlacklist(
  input: {
    readonly token: string;
    readonly providerFingerprint?: string | null;
    readonly nowMs: number;
  },
  dependencies: PortalBlacklistDependencies,
): Promise<{ readonly reading: PortalCardBlockReading; readonly fingerprints: readonly string[] }> {
  const fingerprints = portalCardFingerprintsOf(input).map((entry) => entry.fingerprint);

  return {
    fingerprints,
    reading: await readPortalCardBlock({ fingerprints, nowMs: input.nowMs }, dependencies),
  };
}

/** The zod issues of a refused input, as the error envelope's details, one per field. */
function detailsOf(issues: readonly { readonly path: readonly PropertyKey[] }[]): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of issues) {
    const field = String(issue.path[0] ?? "block");

    if (!details.some((detail) => detail.field === field)) {
      details.push({ field, rule: ruleOfField(field) });
    }
  }

  return details.length === 0 ? [{ field: "block", rule: "invalid_format" }] : details;
}

/** The rule a refused field stands for, so a form marks the field rather than printing a sentence. */
function ruleOfField(field: string): string {
  switch (field) {
    case "fingerprint":
      return PORTAL_BLACKLIST_RULES.invalidFingerprint;
    case "source":
      return PORTAL_BLACKLIST_RULES.invalidSource;
    case "reason":
      return PORTAL_BLACKLIST_RULES.invalidReason;
    case "expiresAtEpochMs":
      return PORTAL_BLACKLIST_RULES.invalidExpiry;
    case "note":
      return PORTAL_BLACKLIST_RULES.noteRequired;
    case "blockId":
      return PORTAL_BLACKLIST_RULES.notFound;
    default:
      return "invalid_format";
  }
}

/** The row body a block writes: the two allowed identifiers, the reason, the person and the life. */
function blockRowOf(input: PortalBlacklistBlockInput): Record<string, unknown> {
  return {
    // The platform's list, said out loud: `card_blacklist_platform_check` refuses any other value.
    company_id: null,
    card_fingerprint: input.fingerprint,
    fingerprint_source: input.source,
    provider_id: input.providerId,
    reason: input.reason,
    note: input.note,
    source_payment_id: input.sourcePaymentId,
    blacklisted_by: input.blacklistedBy,
    blacklisted_at: new Date(input.blacklistedAtEpochMs).toISOString(),
    expires_at: input.expiresAtEpochMs === null ? null : new Date(input.expiresAtEpochMs).toISOString(),
  };
}

/**
 * Put a card on the list.
 *
 * The insert is one statement and the unique partial index is the guard: if somebody else blocked the same
 * fingerprint between this module's read and its write, the database refuses the duplicate and the caller is
 * told the card is already blocked rather than handed an error. Either way the card ends up on the list once,
 * which is what the caller asked for.
 */
export async function blockPortalCard(
  input: PortalBlacklistBlockInput,
  dependencies: PortalBlacklistDependencies,
): Promise<PortalCardBlocked> {
  const parsed = portalBlacklistBlockInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  let inserted: PortalBlacklistRow;

  try {
    const rows = await dependencies.rest.insertReturning(
      PORTAL_BLACKLIST_TABLE,
      [blockRowOf(parsed.data)],
      portalBlacklistRowSchema,
    );
    const row = rows[0];

    if (row === undefined) {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "card_blacklist_insert" } });
    }

    inserted = row;
  } catch (error) {
    if (!isAppError(error) || error.code !== "CONFLICT") {
      throw error;
    }

    // The card is already on the list: read the row that holds it, and answer the same thing. The read is by
    // fingerprint and not by the clock, because a block that lapsed is still the row the index refused.
    const found = await dependencies.rest.select(
      PORTAL_BLACKLIST_TABLE,
      `${PORTAL_BLACKLIST_SELECT}&company_id=is.null&card_fingerprint=eq.${parsed.data.fingerprint}&status=eq.active&limit=1`,
      portalBlacklistRowSchema,
    );
    const row = found[0];

    if (row !== undefined) {
      return { status: "already_blocked", block: summaryOf(row), blockId: row.id };
    }

    // A conflict the list could not explain is still a refusal to write twice, and never a second block.
    throw new AppError("CONFLICT", { cause: { rule: PORTAL_BLACKLIST_RULES.alreadyBlocked } });
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_BLACKLIST_BLOCKED_AUDIT_ACTION,
    actorUserId: parsed.data.blacklistedBy,
    entityType: PORTAL_BLACKLIST_AUDIT_ENTITY,
    entityId: inserted.id,
    payload: {
      block_id: inserted.id,
      card_fingerprint: inserted.card_fingerprint,
      fingerprint_source: inserted.fingerprint_source,
      reason: inserted.reason,
      note: parsed.data.note,
      source_payment_id: parsed.data.sourcePaymentId,
      blacklisted_by: parsed.data.blacklistedBy,
      blacklisted_at: inserted.blacklisted_at,
      expires_at: inserted.expires_at,
      status: inserted.status,
    },
    companyId: null,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  });

  return { status: "blocked", block: summaryOf(inserted), blockId: inserted.id };
}

/**
 * Lift a block.
 *
 * `0055` makes a release the only way a block ends: not a delete, and not a second status. The update carries
 * the version it read, so two officers releasing one block do not both claim it, and the row is read back
 * afterwards - the read back is what turns a lost race into a refusal rather than a report of a release that
 * never happened.
 */
export async function releasePortalCard(
  input: PortalBlacklistReleaseInput,
  dependencies: PortalBlacklistDependencies,
): Promise<PortalCardReleased> {
  const parsed = portalBlacklistReleaseInputSchema.safeParse(input);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error.issues) });
  }

  const release: Record<string, unknown> = {
    status: "released",
    released_by: parsed.data.releasedBy,
    released_at: new Date(parsed.data.releasedAtEpochMs).toISOString(),
    release_note: parsed.data.note,
  };

  try {
    await dependencies.rest.update(
      PORTAL_BLACKLIST_TABLE,
      `id=eq.${parsed.data.blockId}&company_id=is.null&status=eq.active&version=eq.${String(parsed.data.expectedVersion)}`,
      release,
    );
  } catch {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "card_blacklist_release" } });
  }

  let rows: readonly PortalBlacklistReleaseRow[];

  try {
    rows = await dependencies.rest.select(
      PORTAL_BLACKLIST_TABLE,
      `${PORTAL_BLACKLIST_RELEASE_SELECT}&company_id=is.null&id=eq.${parsed.data.blockId}&limit=1`,
      portalBlacklistReleaseRowSchema,
    );
  } catch {
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "card_blacklist_release_read" } });
  }

  const row = rows[0];

  if (row === undefined) {
    return { status: "not_found" };
  }

  if (row.status === "active") {
    // The version moved under this release, so the row this officer read is not the row that exists now.
    return { status: "stale", blockId: row.id };
  }

  if (row.released_by !== parsed.data.releasedBy || row.release_note !== parsed.data.note) {
    return { status: "already_released", blockId: row.id };
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_BLACKLIST_RELEASED_AUDIT_ACTION,
    actorUserId: parsed.data.releasedBy,
    entityType: PORTAL_BLACKLIST_AUDIT_ENTITY,
    entityId: row.id,
    payload: {
      block_id: row.id,
      card_fingerprint: row.card_fingerprint,
      fingerprint_source: row.fingerprint_source,
      reason: row.reason,
      release_note: row.release_note,
      released_by: row.released_by,
      released_at: row.released_at,
      blacklisted_at: row.blacklisted_at,
      version: row.version,
    },
    companyId: null,
    sessionId: null,
    ipAddress: null,
    userAgent: null,
  });

  return { status: "released", blockId: row.id };
}

/**
 * The same list, in the shape STEP 066's fraud evaluation asks for.
 *
 * `FraudSignalLookups.isCardBlocked` takes a fingerprint and answers whether it is blocked - and it must
 * *throw* when it cannot tell, which is why a reading that failed becomes `DEPENDENCY_FAILED` here rather than
 * `false`. The payment operation of STEP 130/132 passes this straight into `fraudDecide`.
 */
export function createPortalCardBlockLookup(
  dependencies: PortalBlacklistDependencies,
): Pick<FraudSignalLookups, "isCardBlocked"> {
  return {
    async isCardBlocked(cardFingerprint: string): Promise<boolean> {
      const reading = await readPortalCardBlock(
        { fingerprints: [cardFingerprint], nowMs: dependencies.now?.() ?? Date.now() },
        dependencies,
      );

      if (reading.status === "unavailable") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: reading.reason } });
      }

      return reading.status === "blocked";
    },
  };
}

/** A chain link that is written if it can be, and never fails the decision it records. */
async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate. The block is the fact; a chain that cannot be reached must not undo a decision a person made.
  }
}
