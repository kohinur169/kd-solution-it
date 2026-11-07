// path: app/(client-portal)/portal-payment-link.ts
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../../lib/auth/audit.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  mintPortalToken,
  openPortalToken,
  portalTokenDigest,
  type PortalTokenClaim,
  type PortalTokenKeys,
} from "../../lib/security/portal-token.ts";
import { priceToMinor } from "../../services/products/price.ts";
import { portalMoneyTextOf } from "./portal-invoice-money.ts";
import { portalPaymentChargeAmountOf } from "./portal-payment-fields.ts";
import {
  PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
  PORTAL_PAYMENT_LINK_CAPABILITY,
  PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_CURRENCY,
  PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS,
  PORTAL_PAYMENT_LINK_DESCRIPTION_MAXIMUM_LENGTH,
  PORTAL_PAYMENT_LINK_DESCRIPTION_MINIMUM_LENGTH,
  PORTAL_PAYMENT_LINK_MAXIMUM_LIFETIME_SECONDS,
  PORTAL_PAYMENT_LINK_MAXIMUM_MINOR,
  PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS,
  PORTAL_PAYMENT_LINK_MINIMUM_MINOR,
  PORTAL_PAYMENT_LINK_PAGE_LIMIT,
  PORTAL_PAYMENT_LINK_PATH,
  PORTAL_PAYMENT_LINK_PROVIDER_MINOR_PER_UNIT,
  PORTAL_PAYMENT_LINK_REFERENCE_MAXIMUM_LENGTH,
  PORTAL_PAYMENT_LINK_REISSUED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_REVOKED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_RULES,
  PORTAL_PAYMENT_LINK_SERVICE_KEY,
  PORTAL_PAYMENT_LINK_TOKEN_KIND,
  PORTAL_PAYMENT_LINK_CREATE_FIELD_ORDER,
  type PortalPaymentLinkState,
} from "./portal-payment-link-fields.ts";
import type { PortalPaymentLinkRecord, PortalPaymentLinkStore } from "./portal-payment-link-store.ts";

/**
 * A general payment link: creation, reading, and the two merchant controls.
 *
 * ## What a link is
 *
 * Section 16's last line. A merchant who is on a plan that includes `payment_links` asks for a link for an
 * amount, writes one sentence about what it is for, and gets a URL they can paste anywhere. Whoever opens it
 * sees that amount and that sentence and pays by card on the hosted checkout. The link carries **one payment**:
 * a request for money, not a shop, so the first captured payment closes it and a second payer is told it has
 * already been paid.
 *
 * ## The four states, and who can move between them
 *
 * | state | who puts it there | what the checkout does |
 * | --- | --- | --- |
 * | `active` | creation, and a reissue | takes a card |
 * | `paid` | the payment that landed | refuses, and says the link is already paid |
 * | `revoked` | the merchant, through the revoke control | refuses |
 * | `expired` | the clock, at `expiresAt` | refuses |
 *
 * `paid`, `revoked` and `expired` are folded from the row's own `status` and clock, never stored as a fourth
 * status: an expiry is a comparison, and writing it as a status would need a job to be true.
 *
 * ## Why the row is the revocation, and not a list of ids
 *
 * STEP 058's token module takes an `isRevoked(tokenId)` predicate. That predicate is synchronous; this store is
 * not, and more importantly a boolean is a worse answer than a row: the row says *which* of paid, revoked and
 * expired happened, and a payer who followed a dead link deserves the difference. So the checkout reads the row
 * the token's id names and compares the token id it finds there with the one the claim carries. A revoked link
 * has had its token retired, and a reissued one carries a **new** id, so an old URL matches no row and is
 * refused as not found - the same answer a forged token gets, which is what keeps the surface from being a
 * probe.
 *
 * ## The order of the checks in a creation
 *
 * who the merchant is, whether they are on a plan that includes this, whether the platform can keep the link,
 * and only then the fields they typed. A merchant who is not entitled is told that rather than being asked to
 * fix an amount that would have been refused anyway.
 */

/** The roles that may create, revoke and reissue a link: the merchant's owner, as every merchant write is. */
export const PORTAL_PAYMENT_LINK_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze(["owner"] as const);

/** What a creation needs: the store, the chain, the key ring and the clock. */
export interface PortalPaymentLinkDependencies {
  readonly store: PortalPaymentLinkStore;
  readonly audit: AuditTrail;
  readonly tokenKeys: PortalTokenKeys;
  readonly now?: () => number;
  /**
   * Does this merchant's plan include payment links?
   *
   * Absent means the platform cannot tell, and a creation refuses: section 16 makes the feature a plan
   * entitlement, and a link minted for a merchant whose plan does not include one is a service given away.
   */
  readonly entitled?: (companyId: string) => Promise<boolean>;
  /** The origin a shared URL is printed under. Absent prints a relative path, which a page still renders. */
  readonly appUrl?: string;
}

/** What the checkout page prints about one link. */
export interface PortalPaymentLinkView {
  readonly linkId: string;
  readonly companyId: string;
  readonly tokenId: string;
  /** The amount in the platform's minor units, as decimal text. */
  readonly amountMinor: string;
  /** The same amount printed for a person. */
  readonly amountText: string;
  /** The amount in the provider's own spelling, which is what the charge will send. */
  readonly chargeAmount: string;
  readonly currency: string;
  readonly description: string;
  readonly reference: string | null;
  readonly state: PortalPaymentLinkState;
  readonly expiresAtEpochMs: number;
  readonly paidAtEpochMs: number | null;
}

/** What a creation answers. The token is the link's secret and is answered exactly once. */
export interface CreatedPortalPaymentLink {
  readonly linkId: string;
  readonly companyId: string;
  readonly token: string;
  readonly tokenId: string;
  readonly url: string;
  readonly amountMinor: string;
  readonly amountText: string;
  readonly description: string;
  readonly reference: string | null;
  readonly expiresAtEpochMs: number;
}

/** What a reissue answers: the same link, a new credential. */
export interface ReissuedPortalPaymentLink {
  readonly linkId: string;
  readonly companyId: string;
  readonly token: string;
  readonly tokenId: string;
  readonly url: string;
  readonly previousTokenId: string;
  readonly expiresAtEpochMs: number;
  readonly reissueCount: number;
}

/** The fields a creation accepts, validated strictly: an unknown key is a field this platform does not take. */
const createBodySchema = z
  .object({
    amount: z.string(),
    description: z.string(),
    reference: z.string().nullish(),
    expires_in_seconds: z.number().int().nullish(),
  })
  .strict();

/** One refusal: a field, a rule, and never the value that produced it. */
function refused(field: string, rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/** A state refusal: the link exists, and it will not take money for this reason. */
function stateRefused(rule: string): AppError {
  return new AppError("CONFLICT", { details: [{ field: "link", rule }] });
}

/** A link this caller may not see at all. */
function linkNotFound(): AppError {
  return new AppError("RESOURCE_NOT_FOUND", {
    details: [{ field: "link", rule: PORTAL_PAYMENT_LINK_RULES.linkNotFound }],
  });
}

/** The URL a link is shared under. */
export function portalPaymentLinkUrlOf(token: string, appUrl?: string): string {
  return `${appUrl ?? ""}${PORTAL_PAYMENT_LINK_PATH}/${encodeURIComponent(token)}`;
}

/**
 * The amount a merchant asked for, in the platform's minor units.
 *
 * The text is a price typed by a person, so it goes through the same parser a catalogue price does; then the
 * two bounds this feature names; then the provider's cents, because an amount the gateway cannot write is a
 * link that would fail at the worst moment for the payer rather than for the merchant.
 */
export function portalPaymentLinkAmountOf(text: string): bigint {
  const trimmed = text.trim();
  const minor = trimmed.length === 0 ? null : priceToMinor(trimmed);

  if (minor === null) {
    throw refused("amount", PORTAL_PAYMENT_LINK_RULES.amountInvalid);
  }

  if (minor < PORTAL_PAYMENT_LINK_MINIMUM_MINOR) {
    throw refused("amount", PORTAL_PAYMENT_LINK_RULES.amountTooSmall);
  }

  if (minor > PORTAL_PAYMENT_LINK_MAXIMUM_MINOR) {
    throw refused("amount", PORTAL_PAYMENT_LINK_RULES.amountTooLarge);
  }

  if (minor % PORTAL_PAYMENT_LINK_PROVIDER_MINOR_PER_UNIT !== 0n) {
    throw refused("amount", PORTAL_PAYMENT_LINK_RULES.amountUnrepresentable);
  }

  return minor;
}

/** The folded state of a row, given the clock. */
export function portalPaymentLinkStateOf(
  record: PortalPaymentLinkRecord,
  nowMs: number,
): PortalPaymentLinkState {
  if (record.status === "paid") {
    return "paid";
  }

  if (record.status === "revoked") {
    return "revoked";
  }

  return nowMs >= record.expiresAtEpochMs ? "expired" : "active";
}

/** One audit entry, written or not: a chain that is down never fails the fact it records. */
async function appendTolerated(audit: AuditTrail, entry: AuditEntry): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // Deliberate: the row is the fact, and an audit sink that cannot be reached must not turn a merchant's
    // link into a page that never finished.
  }
}

/** The parsed creation, in the shape the service writes. */
interface ParsedPaymentLinkCreate {
  readonly amountMinor: bigint;
  readonly description: string;
  readonly reference: string | null;
  readonly lifetimeSeconds: number;
}

/** Parse a creation body. Bounded, trimmed and strict, and every refusal names the field it is about. */
export function parsePortalPaymentLinkCreateBody(body: unknown): ParsedPaymentLinkCreate {
  const parsed = createBodySchema.safeParse(body);

  if (!parsed.success) {
    const key = parsed.error.issues[0]?.code === "unrecognized_keys" ? parsed.error.issues[0].keys[0] : null;
    const field =
      key ?? String(parsed.error.issues[0]?.path[0] ?? PORTAL_PAYMENT_LINK_CREATE_FIELD_ORDER[0]);

    throw refused(field, PORTAL_PAYMENT_LINK_RULES.amountInvalid);
  }

  const amountMinor = portalPaymentLinkAmountOf(parsed.data.amount);
  const description = parsed.data.description.trim();

  if (
    description.length < PORTAL_PAYMENT_LINK_DESCRIPTION_MINIMUM_LENGTH ||
    description.length > PORTAL_PAYMENT_LINK_DESCRIPTION_MAXIMUM_LENGTH
  ) {
    throw refused("description", PORTAL_PAYMENT_LINK_RULES.descriptionInvalid);
  }

  const referenceGiven = parsed.data.reference ?? null;
  const reference = referenceGiven === null ? null : referenceGiven.trim();

  if (reference !== null && reference.length > PORTAL_PAYMENT_LINK_REFERENCE_MAXIMUM_LENGTH) {
    throw refused("reference", PORTAL_PAYMENT_LINK_RULES.referenceInvalid);
  }

  const lifetime = parsed.data.expires_in_seconds ?? PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS;

  if (
    lifetime < PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS ||
    lifetime > PORTAL_PAYMENT_LINK_MAXIMUM_LIFETIME_SECONDS
  ) {
    throw refused("expires_in_seconds", PORTAL_PAYMENT_LINK_RULES.lifetimeInvalid);
  }

  return {
    amountMinor,
    description,
    reference: reference === null || reference.length === 0 ? null : reference,
    lifetimeSeconds: lifetime,
  };
}

/** A token id: sixteen random bytes, canonical base64url, which is what STEP 058's mint accepts. */
function newTokenId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Create a general payment link.
 *
 * The row is written **after** the token is minted and **before** it is answered: a link whose row never landed
 * would be a URL that resolves to nothing, while a row whose token was never handed over holds a credential
 * nobody has, which a merchant can revoke and which expires on its own. The first is a bug; the second is a
 * harmless row.
 */
export async function createPortalPaymentLink(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: PortalPaymentLinkDependencies,
): Promise<CreatedPortalPaymentLink> {
  requireAnyRole(input.actor, PORTAL_PAYMENT_LINK_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);

  if (dependencies.entitled === undefined) {
    throw new AppError("SERVICE_UNAVAILABLE", {
      details: [{ field: "plan", rule: PORTAL_PAYMENT_LINK_RULES.notEntitled }],
    });
  }

  if (!(await dependencies.entitled(companyId))) {
    throw new AppError("PERMISSION_DENIED", {
      details: [{ field: "plan", rule: PORTAL_PAYMENT_LINK_RULES.notEntitled }],
    });
  }

  if (!dependencies.store.durable) {
    // Memory is not a place to mint credentials: a link that stops existing at the next deploy is a link the
    // merchant shared and the payer cannot pay.
    throw new AppError("SERVICE_UNAVAILABLE", {
      details: [{ field: "link", rule: PORTAL_PAYMENT_LINK_RULES.storeUnavailable }],
    });
  }

  const parsed = parsePortalPaymentLinkCreateBody(input.body);
  const nowMs = dependencies.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1_000);
  const linkId = randomUUID();
  const tokenId = newTokenId();
  const token = mintPortalToken(
    {
      kind: PORTAL_PAYMENT_LINK_TOKEN_KIND,
      companyId,
      resourceId: linkId,
      capability: PORTAL_PAYMENT_LINK_CAPABILITY,
      lifetimeSeconds: parsed.lifetimeSeconds,
    },
    { keys: dependencies.tokenKeys, now: nowSeconds, tokenId },
  );
  const expiresAtEpochMs = (nowSeconds + parsed.lifetimeSeconds) * 1_000;

  const inserted = await dependencies.store.insert({
    id: linkId,
    companyId,
    amountMinor: parsed.amountMinor.toString(),
    currency: PORTAL_PAYMENT_LINK_CURRENCY,
    description: parsed.description,
    reference: parsed.reference,
    status: "active",
    tokenId,
    tokenDigest: portalTokenDigest(token),
    reissueCount: 0,
    expiresAtEpochMs,
    revokedAtEpochMs: null,
    revokedByUserId: null,
    paidAtEpochMs: null,
    paymentId: null,
    createdByUserId: input.actor.userId,
    createdAtEpochMs: nowMs,
    updatedAtEpochMs: nowMs,
  });

  if (inserted !== "changed") {
    throw new AppError("CONFLICT", { cause: { rule: "payment_link_insert" } });
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
    entityId: linkId,
    payload: {
      amount_minor: parsed.amountMinor.toString(),
      currency: PORTAL_PAYMENT_LINK_CURRENCY,
      description: parsed.description,
      reference: parsed.reference,
      // The id, never the token: the chain keeps what names a link, not what opens it.
      token_id: tokenId,
      expires_at: new Date(expiresAtEpochMs).toISOString(),
      plan_service: PORTAL_PAYMENT_LINK_SERVICE_KEY,
    },
    companyId,
    sessionId: input.actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return {
    linkId,
    companyId,
    token,
    tokenId,
    url: portalPaymentLinkUrlOf(token, dependencies.appUrl),
    amountMinor: parsed.amountMinor.toString(),
    amountText: portalMoneyTextOf(PORTAL_PAYMENT_LINK_CURRENCY, parsed.amountMinor.toString()),
    description: parsed.description,
    reference: parsed.reference,
    expiresAtEpochMs,
  };
}

/** The claim a token must carry to be this platform's payment link, or a not found. */
function claimOf(token: string, dependencies: PortalPaymentLinkDependencies, nowSeconds: number): PortalTokenClaim {
  try {
    return openPortalToken(token, {
      keys: dependencies.tokenKeys,
      now: nowSeconds,
      expect: { kind: PORTAL_PAYMENT_LINK_TOKEN_KIND, capability: PORTAL_PAYMENT_LINK_CAPABILITY },
    });
  } catch {
    // Every token failure is the same answer: a visitor who can tell a forged link from an expired one has a
    // probe for which links exist. STEP 058 already made that choice; this surface inherits it.
    throw linkNotFound();
  }
}

/** The row a claim names, read by the token id the claim carries. */
async function recordOf(
  claim: PortalTokenClaim,
  dependencies: PortalPaymentLinkDependencies,
): Promise<PortalPaymentLinkRecord> {
  const record = await dependencies.store.findByTokenId(claim.tokenId);

  if (record === null || record.id !== claim.resourceId || record.companyId !== claim.companyId) {
    // A token that names no live row is a revoked link, a reissued one's old credential, or a forgery - and
    // they are one answer here for the reason above.
    throw linkNotFound();
  }

  return record;
}

/** Read the row a token names, whatever its state, for the merchant controls. */
async function recordOfToken(
  token: string,
  dependencies: PortalPaymentLinkDependencies,
  nowSeconds: number,
): Promise<PortalPaymentLinkRecord> {
  return recordOf(claimOf(token, dependencies, nowSeconds), dependencies);
}

/**
 * Open a link, and refuse it when it will not take money.
 *
 * The refusals are the three dead states, in the order a payer meets them: paid, revoked, expired. A link that
 * is `active` by its row but past its clock is **expired**, not active with a note, so no caller has to
 * remember to compare the clock.
 */
export async function openPortalPaymentLink(
  input: { readonly token: string },
  dependencies: PortalPaymentLinkDependencies,
): Promise<PortalPaymentLinkView> {
  const nowMs = dependencies.now?.() ?? Date.now();
  const claim = claimOf(input.token, dependencies, Math.floor(nowMs / 1_000));
  const record = await recordOf(claim, dependencies);
  const state = portalPaymentLinkStateOf(record, nowMs);

  if (state === "paid") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkPaid);
  }

  if (state === "revoked") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkRevoked);
  }

  if (state === "expired") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkExpired);
  }

  return {
    linkId: record.id,
    companyId: record.companyId,
    tokenId: record.tokenId,
    amountMinor: record.amountMinor,
    amountText: portalMoneyTextOf(record.currency, record.amountMinor),
    chargeAmount: portalPaymentChargeAmountOf(record.amountMinor) ?? record.amountMinor,
    currency: record.currency,
    description: record.description,
    reference: record.reference,
    state,
    expiresAtEpochMs: record.expiresAtEpochMs,
    paidAtEpochMs: record.paidAtEpochMs,
  };
}

/**
 * Revoke the token in circulation.
 *
 * Only a live link can be revoked: a paid link's money has already moved and a revoked one has nothing left to
 * retire, so both answer `link_not_active` rather than pretending to have done something. The row keeps the id
 * of the token that was retired and the person who retired it, because the chain is not the only place a
 * dispute asks "who killed this link".
 */
export async function revokePortalPaymentLink(
  input: { readonly actor: RequestActor; readonly token: string },
  dependencies: PortalPaymentLinkDependencies,
): Promise<{ readonly linkId: string; readonly companyId: string; readonly revokedAtEpochMs: number }> {
  requireAnyRole(input.actor, PORTAL_PAYMENT_LINK_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  const nowMs = dependencies.now?.() ?? Date.now();
  const record = await recordOfToken(input.token, dependencies, Math.floor(nowMs / 1_000));

  return revokeRecord(input.actor, companyId, record, nowMs, dependencies);
}

/**
 * Revoke a link the merchant is looking at in the console.
 *
 * The console lists links by id and never holds a token - the token is answered once, at creation, and the row
 * keeps only its digest - so this entry point names the row instead. Everything after the read is the same
 * function the token form calls: one state check, one guarded write, one audit entry, so the two ways to revoke
 * a link cannot drift into two different rules.
 */
export async function revokePortalPaymentLinkById(
  input: { readonly actor: RequestActor; readonly linkId: string },
  dependencies: PortalPaymentLinkDependencies,
): Promise<{ readonly linkId: string; readonly companyId: string; readonly revokedAtEpochMs: number }> {
  requireAnyRole(input.actor, PORTAL_PAYMENT_LINK_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  const nowMs = dependencies.now?.() ?? Date.now();
  const record = await dependencies.store.findById(input.linkId, companyId);

  if (record === null) {
    // Another merchant's link and a link that does not exist are one answer, which is the rule every
    // tenant-scoped read in this platform keeps.
    throw linkNotFound();
  }

  return revokeRecord(input.actor, companyId, record, nowMs, dependencies);
}

/** The revoke itself, once the row is in hand and the caller owns it. */
async function revokeRecord(
  actor: RequestActor,
  companyId: string,
  record: PortalPaymentLinkRecord,
  nowMs: number,
  dependencies: PortalPaymentLinkDependencies,
): Promise<{ readonly linkId: string; readonly companyId: string; readonly revokedAtEpochMs: number }> {
  if (record.companyId !== companyId) {
    // A merchant holding another merchant's link is told the link is not theirs, by the rule every cross-tenant
    // read in this platform uses. The by-id entry point cannot reach this line - its read is company scoped -
    // so this is the token path's check, kept where both paths share the rest.
    throw new AppError("PERMISSION_DENIED");
  }

  if (portalPaymentLinkStateOf(record, nowMs) !== "active") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkNotActive);
  }

  const changed = await dependencies.store.revoke({
    id: record.id,
    companyId,
    tokenId: record.tokenId,
    revokedAtEpochMs: nowMs,
    revokedByUserId: actor.userId,
  });

  if (changed !== "changed") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkNotActive);
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_PAYMENT_LINK_REVOKED_AUDIT_ACTION,
    actorUserId: actor.userId,
    entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
    entityId: record.id,
    payload: {
      amount_minor: record.amountMinor,
      token_id: record.tokenId,
      revoked_at: new Date(nowMs).toISOString(),
    },
    companyId,
    sessionId: actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return { linkId: record.id, companyId, revokedAtEpochMs: nowMs };
}

/**
 * Reissue a live credential for a dead link.
 *
 * Only a link that is **not** in circulation can be reissued - revoked or expired - because reissuing a live
 * link would silently kill a URL the merchant may already have shared. A paid link is not reissuable at all:
 * the money has moved and a second token for the same request would be a second charge for one debt.
 *
 * The new token names the same row under a **new** id, so the old URL matches no row and is refused as not
 * found, and the row's `reissueCount` records how many credentials this request has had.
 */
export async function reissuePortalPaymentLink(
  input: { readonly actor: RequestActor; readonly token: string },
  dependencies: PortalPaymentLinkDependencies,
): Promise<ReissuedPortalPaymentLink> {
  requireAnyRole(input.actor, PORTAL_PAYMENT_LINK_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  requireDurableStore(dependencies);

  const nowMs = dependencies.now?.() ?? Date.now();
  const record = await recordOfToken(input.token, dependencies, Math.floor(nowMs / 1_000));

  return reissueRecord(input.actor, companyId, record, nowMs, dependencies);
}

/**
 * Reissue the credential of a link the merchant is looking at in the console.
 *
 * The same reason the revoke has a by-id form: the console never holds a token. The row is read company
 * scoped, so another merchant's link is not found rather than refused, and every rule after the read - only a
 * dead link is reissuable, a paid one never is, a lost race is a conflict - is the shared function's.
 */
export async function reissuePortalPaymentLinkById(
  input: { readonly actor: RequestActor; readonly linkId: string },
  dependencies: PortalPaymentLinkDependencies,
): Promise<ReissuedPortalPaymentLink> {
  requireAnyRole(input.actor, PORTAL_PAYMENT_LINK_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  requireDurableStore(dependencies);

  const nowMs = dependencies.now?.() ?? Date.now();
  const record = await dependencies.store.findById(input.linkId, companyId);

  if (record === null) {
    throw linkNotFound();
  }

  return reissueRecord(input.actor, companyId, record, nowMs, dependencies);
}

/** The store a credential can be minted over: memory is not a place to keep one. */
function requireDurableStore(dependencies: PortalPaymentLinkDependencies): void {
  if (!dependencies.store.durable) {
    throw new AppError("SERVICE_UNAVAILABLE", {
      details: [{ field: "link", rule: PORTAL_PAYMENT_LINK_RULES.storeUnavailable }],
    });
  }
}

/** The reissue itself, once the row is in hand. */
async function reissueRecord(
  actor: RequestActor,
  companyId: string,
  record: PortalPaymentLinkRecord,
  nowMs: number,
  dependencies: PortalPaymentLinkDependencies,
): Promise<ReissuedPortalPaymentLink> {
  if (record.companyId !== companyId) {
    throw new AppError("PERMISSION_DENIED");
  }

  const nowSeconds = Math.floor(nowMs / 1_000);
  const state = portalPaymentLinkStateOf(record, nowMs);

  if (state === "paid") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkPaid);
  }

  if (state === "active") {
    throw stateRefused(PORTAL_PAYMENT_LINK_RULES.linkNotActive);
  }

  const tokenId = newTokenId();
  const token = mintPortalToken(
    {
      kind: PORTAL_PAYMENT_LINK_TOKEN_KIND,
      companyId,
      resourceId: record.id,
      capability: PORTAL_PAYMENT_LINK_CAPABILITY,
      lifetimeSeconds: PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS,
    },
    { keys: dependencies.tokenKeys, now: nowSeconds, tokenId },
  );
  const expiresAtEpochMs = (nowSeconds + PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS) * 1_000;
  const changed = await dependencies.store.reissue({
    id: record.id,
    companyId,
    tokenId,
    tokenDigest: portalTokenDigest(token),
    expiresAtEpochMs,
    expectedTokenId: record.tokenId,
    updatedAtEpochMs: nowMs,
  });

  if (changed !== "changed") {
    // Someone reissued or revoked between the read and the write: the merchant has two tabs open, and the
    // honest answer is that the link moved rather than a second live credential.
    throw new AppError("CONFLICT", { details: [{ field: "link", rule: PORTAL_PAYMENT_LINK_RULES.linkNotActive }] });
  }

  await appendTolerated(dependencies.audit, {
    action: PORTAL_PAYMENT_LINK_REISSUED_AUDIT_ACTION,
    actorUserId: actor.userId,
    entityType: PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
    entityId: record.id,
    payload: {
      amount_minor: record.amountMinor,
      previous_token_id: record.tokenId,
      token_id: tokenId,
      previous_state: state,
      expires_at: new Date(expiresAtEpochMs).toISOString(),
      reissue_count: record.reissueCount + 1,
    },
    companyId,
    sessionId: actor.sessionId ?? null,
    ipAddress: null,
    userAgent: null,
  });

  return {
    linkId: record.id,
    companyId,
    token,
    tokenId,
    url: portalPaymentLinkUrlOf(token, dependencies.appUrl),
    previousTokenId: record.tokenId,
    expiresAtEpochMs,
    reissueCount: record.reissueCount + 1,
  };
}

/** The merchant's own links, newest first, as the console prints them. */
export async function listPortalPaymentLinks(
  input: { readonly actor: RequestActor; readonly limit: number },
  dependencies: PortalPaymentLinkDependencies,
): Promise<readonly (PortalPaymentLinkView & { readonly createdAtEpochMs: number })[]> {
  requireAnyRole(input.actor, PORTAL_PAYMENT_LINK_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  const nowMs = dependencies.now?.() ?? Date.now();
  // The ceiling, applied here rather than at the route: every caller of this service gets the same page size,
  // so no boundary can ask a store for more than the constant allows.
  const limit = Math.min(Math.max(Number.isFinite(input.limit) ? Math.trunc(input.limit) : 1, 1), PORTAL_PAYMENT_LINK_PAGE_LIMIT);
  const records = await dependencies.store.listByCompany(companyId, limit);

  return records.map((record) => ({
    linkId: record.id,
    companyId: record.companyId,
    tokenId: record.tokenId,
    amountMinor: record.amountMinor,
    amountText: portalMoneyTextOf(record.currency, record.amountMinor),
    chargeAmount: portalPaymentChargeAmountOf(record.amountMinor) ?? record.amountMinor,
    currency: record.currency,
    description: record.description,
    reference: record.reference,
    state: portalPaymentLinkStateOf(record, nowMs),
    expiresAtEpochMs: record.expiresAtEpochMs,
    paidAtEpochMs: record.paidAtEpochMs,
    createdAtEpochMs: record.createdAtEpochMs,
  }));
}
