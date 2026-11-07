// path: app/(client-portal)/portal-payment-link-verify.ts
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import { mintPortalToken, openPortalToken, portalTokenDigest, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { portalPaymentRuleTextOf } from "../../components/payments/portal-payment-refusal.ts";
import {
  PORTAL_PAYMENT_LINK_AUDIT_ENTITY,
  PORTAL_PAYMENT_LINK_CAPABILITY,
  PORTAL_PAYMENT_LINK_CAPTURED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_CREATE_FIELD_ORDER,
  PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_CURRENCY,
  PORTAL_PAYMENT_LINK_DECLINED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS,
  PORTAL_PAYMENT_LINK_DESCRIPTION_MAXIMUM_LENGTH,
  PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES,
  PORTAL_PAYMENT_LINK_MAXIMUM_LIFETIME_SECONDS,
  PORTAL_PAYMENT_LINK_MAXIMUM_MINOR,
  PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS,
  PORTAL_PAYMENT_LINK_MINIMUM_MINOR,
  PORTAL_PAYMENT_LINK_PAGE_LIMIT,
  PORTAL_PAYMENT_LINK_PATH,
  PORTAL_PAYMENT_LINK_PROVIDER_MINOR_PER_UNIT,
  PORTAL_PAYMENT_LINK_RATE_LIMIT,
  PORTAL_PAYMENT_LINK_REFERENCE_MAXIMUM_LENGTH,
  PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_REISSUED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_REVOKED_AUDIT_ACTION,
  PORTAL_PAYMENT_LINK_RULES,
  PORTAL_PAYMENT_LINK_SERVICE_KEY,
  PORTAL_PAYMENT_LINK_TOKEN_KIND,
  PORTAL_PAYMENT_LINK_STATUSES,
  PORTAL_PAYMENT_LINK_STATES,
} from "./portal-payment-link-fields.ts";
import {
  createInMemoryPortalPaymentLinkStore,
  type PortalPaymentLinkStore,
} from "./portal-payment-link-store.ts";
import {
  createPortalPaymentLink,
  listPortalPaymentLinks,
  openPortalPaymentLink,
  portalPaymentLinkAmountOf,
  portalPaymentLinkStateOf,
  portalPaymentLinkUrlOf,
  reissuePortalPaymentLink,
  reissuePortalPaymentLinkById,
  revokePortalPaymentLink,
  revokePortalPaymentLinkById,
} from "./portal-payment-link.ts";
import {
  chargePortalPaymentLink,
  preparePortalPaymentLinkCheckout,
  type PortalPaymentLinkCheckoutDependencies,
} from "./portal-payment-link-checkout.ts";
import type { PortalChargeOutcome, PortalChargeRequest } from "./portal-payment.ts";

/**
 * The gate for STEP 190: a general payment link, the hosted checkout it opens, and the merchant's two controls.
 *
 * ## What this proves
 *
 *   - **A link is a plan entitlement.** A merchant whose plan does not carry `payment_links` is refused, and a
 *     platform that cannot answer the question at all refuses too - the feature is never given away by a
 *     missing dependency.
 *   - **The token is the only credential.** The row stores the digest and the token id, never the token; the
 *     token carries the link's own id, the `payment_link` kind and the `pay` capability; a revoked one is gone,
 *     and a reissued one leaves the old URL resolving to nothing.
 *   - **A link takes one payment and no invoice.** The charge goes through STEP 183's processor with
 *     `invoiceId: null`, the row moves to `paid` on capture and to nothing on a decline, and a second capture on
 *     the same link is reported as a duplicate rather than hidden.
 *   - **The merchant's controls are guarded.** `owner` only, the merchant's own tenant only, revoke only from
 *     `active`, reissue only from `revoked` or `expired`, and every one of them leaves a chain entry.
 *   - **No migration is needed.** Nothing in `migrations/` names this table, because the row is a port; the gate
 *     asserts the highest migration is still 122 and that the store's header still carries the column list the
 *     STEP that writes the table must satisfy.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(Object.is(actual, expected), `${description} (expected ${String(expected)}, got ${String(actual)})`);
}

/** Run a call that must refuse, and check the code and the first rule it names. */
async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  rule: string,
  description: string,
): Promise<void> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
  } catch (error) {
    if (!isAppError(error)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return;
    }

    expectEqual(error.code, code, description);
    expectEqual(error.details[0]?.rule ?? "", rule, `${description}: the rule it names`);
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture: a clock, a store, a chain and a processor a gate can steer.
// ---------------------------------------------------------------------------------------------

const keys: PortalTokenKeys = { primary: Buffer.alloc(32, 11).toString("base64") };
const startedAtMs = Date.parse("2026-11-07T10:00:00.000Z");
const companyId = "3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f601";
const otherCompanyId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f2a3b4c5d";
const ownerUserId = "0b1c2d3e-4f50-4a61-b7c8-d9e0f1a2b3c4";

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"],
    sessionId: "session-0001",
    assuranceLevel: "aal1",
    authenticatedAtEpochMs: startedAtMs - 60_000,
    expiresAtEpochMs: startedAtMs + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

interface Harness {
  readonly store: PortalPaymentLinkStore;
  readonly audit: InMemoryAuditTrail;
  readonly dependencies: PortalPaymentLinkCheckoutDependencies;
  readonly requests: PortalChargeRequest[];
  setOutcome(outcome: PortalChargeOutcome | null): void;
  advance(seconds: number): void;
}

/**
 * A durable-looking store over the in-memory one.
 *
 * The in-memory store says `durable: false` about itself, and every service refuses to mint a credential on it.
 * The gate wraps it with `durable: true` for the same reason STEP 183's gate builds its own recorder: the flows
 * below are the flows production runs, and a gate that could only exercise the refusals would prove nothing
 * about the code that works.
 */
function storeOf(durable: boolean): PortalPaymentLinkStore {
  return { ...createInMemoryPortalPaymentLinkStore(), durable };
}

function harnessOf(
  options: {
    readonly durable?: boolean;
    readonly entitled?: boolean;
    readonly withoutEntitlement?: boolean;
    readonly withoutProcessor?: boolean;
  } = {},
): Harness {
  const store = storeOf(options.durable ?? true);
  const audit = createInMemoryAuditTrail();
  const requests: PortalChargeRequest[] = [];
  let outcome: PortalChargeOutcome | null = null;
  let nowMs = startedAtMs;

  const dependencies: PortalPaymentLinkCheckoutDependencies = {
    store,
    audit,
    tokenKeys: keys,
    appUrl: "https://app.kd.example",
    now: () => nowMs,
    ...(options.withoutEntitlement === true
      ? {}
      : { entitled: async () => options.entitled ?? true }),
    tokenizationKeyFor: () => ({ apiKey: "public-tokenization-key-1234", environment: "sandbox" }),
    processor:
      options.withoutProcessor === true
        ? null
        : {
            durable: true,
            async charge(request: PortalChargeRequest): Promise<PortalChargeOutcome> {
              requests.push(request);

              return (
                outcome ?? {
                  status: "captured",
                  paymentId: request.idempotencyKey,
                  transactionId: `txn-${request.idempotencyKey.slice(0, 8)}`,
                }
              );
            },
          },
  };

  return {
    store,
    audit,
    dependencies,
    requests,
    setOutcome(next: PortalChargeOutcome | null): void {
      outcome = next;
    },
    advance(seconds: number): void {
      nowMs += seconds * 1_000;
    },
  };
}

const validBody = {
  amount: "125.00",
  description: "Design retainer, March",
  reference: "PO-1042",
};

/** The actions one chain holds, in the order they were written. */
function actionsOf(audit: InMemoryAuditTrail): readonly string[] {
  return audit.entries.map((entry) => entry.action);
}

/** The payload of the one entry for an action. */
function payloadOf(audit: InMemoryAuditTrail, action: string): Readonly<Record<string, unknown>> | null {
  const entry = audit.entries.find((candidate) => candidate.action === action);

  return entry?.payload ?? null;
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  // -------------------------------------------------------------------------------------------
  // 1. The vocabulary
  // -------------------------------------------------------------------------------------------
  expectEqual(PORTAL_PAYMENT_LINK_PATH, "/p", "a link is shared under `/p`, the page the STEP names");
  expectEqual(PORTAL_PAYMENT_LINK_TOKEN_KIND, "payment_link", "the claim's kind, so a link is not an invoice");
  expectEqual(PORTAL_PAYMENT_LINK_CAPABILITY, "pay", "and its capability, which is the only thing a link does");
  expectEqual(PORTAL_PAYMENT_LINK_SERVICE_KEY, "payment_links", "the plan entitlement's service key");
  expectEqual(PORTAL_PAYMENT_LINK_AUDIT_ENTITY, "payment_link", "and the entity every entry is written under");
  expectEqual(PORTAL_PAYMENT_LINK_CURRENCY, "USD", "the platform's one currency");
  expectEqual(PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES, 2_048, "a creation's body ceiling");
  expectEqual(PORTAL_PAYMENT_LINK_PAGE_LIMIT, 50, "a listing's page size");
  expectEqual(PORTAL_PAYMENT_LINK_RATE_LIMIT.scope, "portal_payment_link", "the checkout's own counter");
  expectEqual(PORTAL_PAYMENT_LINK_RATE_LIMIT.limit, 5, "five attempts");
  expectEqual(PORTAL_PAYMENT_LINK_RATE_LIMIT.windowSeconds, 600, "in ten minutes");
  expectEqual(PORTAL_PAYMENT_LINK_PROVIDER_MINOR_PER_UNIT, 100n, "the provider writes cents");
  expectEqual(PORTAL_PAYMENT_LINK_MINIMUM_MINOR, 10_000n, "a link takes at least a dollar");
  expectEqual(PORTAL_PAYMENT_LINK_MAXIMUM_MINOR, 1_000_000_000n, "and at most a hundred thousand");
  expectEqual(
    PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS,
    604_800,
    "a link lives a week unless it is told otherwise",
  );
  expect(PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS >= 3_600, "at least an hour");
  expect(
    PORTAL_PAYMENT_LINK_MAXIMUM_LIFETIME_SECONDS >= PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS,
    "and no longer than STEP 058's token maximum",
  );
  expectEqual(PORTAL_PAYMENT_LINK_DESCRIPTION_MAXIMUM_LENGTH, 200, "a description is a sentence");
  expectEqual(PORTAL_PAYMENT_LINK_REFERENCE_MAXIMUM_LENGTH, 64, "a reference is a short code");
  expectEqual(PORTAL_PAYMENT_LINK_CREATE_FIELD_ORDER.length, 4, "four fields, in the order errors are ordered");
  expect(
    PORTAL_PAYMENT_LINK_STATES.includes("expired"),
    "and `expired` is a state a page shows, though no row is ever stored with it",
  );
  expect(
    !(PORTAL_PAYMENT_LINK_STATUSES as readonly string[]).includes("expired"),
    "because expiry is the clock's answer, not a write",
  );
  expectEqual(Object.keys(PORTAL_PAYMENT_LINK_RULES).length, 15, "fifteen refusals, one per cause");
  expect(
    Object.values(PORTAL_PAYMENT_LINK_RULES).every((rule) => /^[a-z][a-z0-9_]{2,48}$/u.test(rule)),
    "each a rule name in the vocabulary's own alphabet",
  );
  expectEqual(
    new Set(Object.values(PORTAL_PAYMENT_LINK_RULES)).size,
    15,
    "and no two causes share a rule",
  );

  // -------------------------------------------------------------------------------------------
  // 2. The amount: a price, its two bounds, and the provider's cents
  // -------------------------------------------------------------------------------------------
  expectEqual(portalPaymentLinkAmountOf("125.00"), 1_250_000n, "a typed price becomes platform minor units");
  expectEqual(portalPaymentLinkAmountOf("1.00"), 10_000n, "and a dollar is the smallest amount a link takes");
  expectEqual(portalPaymentLinkAmountOf(" 1000 "), 10_000_000n, "surrounding space is not part of the price");

  for (const [text, rule] of [
    ["", PORTAL_PAYMENT_LINK_RULES.amountInvalid],
    ["abc", PORTAL_PAYMENT_LINK_RULES.amountInvalid],
    ["1.2.3", PORTAL_PAYMENT_LINK_RULES.amountInvalid],
    ["0", PORTAL_PAYMENT_LINK_RULES.amountTooSmall],
    ["0.50", PORTAL_PAYMENT_LINK_RULES.amountTooSmall],
    ["10000000.00", PORTAL_PAYMENT_LINK_RULES.amountTooLarge],
  ] as const) {
    try {
      portalPaymentLinkAmountOf(text);
      expect(false, `"${text}" is refused`);
    } catch (error) {
      expect(isAppError(error) && error.details[0]?.rule === rule, `"${text}" is refused with ${rule}`);
    }
  }

  expectEqual(
    portalPaymentLinkUrlOf("abc", "https://app.kd.example"),
    "https://app.kd.example/p/abc",
    "the shared URL is the origin plus the path plus the token",
  );
  expectEqual(portalPaymentLinkUrlOf("a b"), "/p/a%20b", "and a relative one is a path a page can still open");

  // -------------------------------------------------------------------------------------------
  // 3. Creation: role, entitlement, store, body, token
  // -------------------------------------------------------------------------------------------
  const createHarness = harnessOf();

  await expectRefusal(
    () =>
      createPortalPaymentLink(
        { actor: actorOf({ roles: ["support"] }), body: validBody },
        createHarness.dependencies,
      ),
    "PERMISSION_DENIED",
    "",
    "a member of staff cannot make a link",
  );

  await expectRefusal(
    () =>
      createPortalPaymentLink({ actor: actorOf({ companyId: null }), body: validBody }, createHarness.dependencies),
    "PERMISSION_DENIED",
    "",
    "and an actor with no company has no tenant to make one for",
  );

  await expectRefusal(
    () => createPortalPaymentLink({ actor: actorOf(), body: validBody }, harnessOf({ withoutEntitlement: true }).dependencies),
    "SERVICE_UNAVAILABLE",
    PORTAL_PAYMENT_LINK_RULES.notEntitled,
    "a platform that cannot answer the plan question refuses rather than giving the feature away",
  );

  await expectRefusal(
    () => createPortalPaymentLink({ actor: actorOf(), body: validBody }, harnessOf({ entitled: false }).dependencies),
    "PERMISSION_DENIED",
    PORTAL_PAYMENT_LINK_RULES.notEntitled,
    "a plan without payment_links is refused",
  );

  await expectRefusal(
    () => createPortalPaymentLink({ actor: actorOf(), body: validBody }, harnessOf({ durable: false }).dependencies),
    "SERVICE_UNAVAILABLE",
    PORTAL_PAYMENT_LINK_RULES.storeUnavailable,
    "and a store that cannot survive a deploy mints nothing",
  );

  for (const [body, field, rule] of [
    [{ ...validBody, amount: "0.50" }, "amount", PORTAL_PAYMENT_LINK_RULES.amountTooSmall],
    [{ ...validBody, amount: "20000000.00" }, "amount", PORTAL_PAYMENT_LINK_RULES.amountTooLarge],
    [{ ...validBody, amount: "abc" }, "amount", PORTAL_PAYMENT_LINK_RULES.amountInvalid],
    [{ ...validBody, description: "   " }, "description", PORTAL_PAYMENT_LINK_RULES.descriptionInvalid],
    [
      { ...validBody, description: "x".repeat(PORTAL_PAYMENT_LINK_DESCRIPTION_MAXIMUM_LENGTH + 1) },
      "description",
      PORTAL_PAYMENT_LINK_RULES.descriptionInvalid,
    ],
    [
      { ...validBody, reference: "r".repeat(PORTAL_PAYMENT_LINK_REFERENCE_MAXIMUM_LENGTH + 1) },
      "reference",
      PORTAL_PAYMENT_LINK_RULES.referenceInvalid,
    ],
    [
      { ...validBody, expires_in_seconds: PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS - 1 },
      "expires_in_seconds",
      PORTAL_PAYMENT_LINK_RULES.lifetimeInvalid,
    ],
    [
      { ...validBody, expires_in_seconds: PORTAL_PAYMENT_LINK_MAXIMUM_LIFETIME_SECONDS + 1 },
      "expires_in_seconds",
      PORTAL_PAYMENT_LINK_RULES.lifetimeInvalid,
    ],
  ] as const) {
    await expectRefusal(
      () => createPortalPaymentLink({ actor: actorOf(), body }, createHarness.dependencies),
      "VALIDATION_FAILED",
      rule,
      `a creation with a bad ${field} is refused with ${rule}`,
    );
  }

  await expectRefusal(
    () => createPortalPaymentLink({ actor: actorOf(), body: { ...validBody, cvc: "123" } }, createHarness.dependencies),
    "VALIDATION_FAILED",
    PORTAL_PAYMENT_LINK_RULES.amountInvalid,
    "an unknown field is a field this platform does not take",
  );

  const created = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, createHarness.dependencies);

  expectEqual(created.companyId, companyId, "a creation answers the merchant's own company");
  expectEqual(created.amountMinor, "1250000", "and the amount in platform minor units");
  expectEqual(created.amountText, "125.0000 USD", "printed for a person, in the platform's own money format");
  expectEqual(created.description, "Design retainer, March", "with the description it was given");
  expectEqual(created.reference, "PO-1042", "and the reference");
  expectEqual(created.url, `https://app.kd.example/p/${encodeURIComponent(created.token)}`, "and the URL to share");
  expectEqual(
    created.expiresAtEpochMs,
    startedAtMs + PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS * 1_000,
    "which closes a week later by default",
  );

  const claim = openPortalToken(created.token, {
    keys,
    now: Math.floor(startedAtMs / 1_000) + 1,
    expect: { kind: PORTAL_PAYMENT_LINK_TOKEN_KIND, capability: PORTAL_PAYMENT_LINK_CAPABILITY },
  });

  expectEqual(claim.kind, PORTAL_PAYMENT_LINK_TOKEN_KIND, "the token's kind is a payment link");
  expectEqual(claim.capability, PORTAL_PAYMENT_LINK_CAPABILITY, "its capability is paying");
  expectEqual(claim.resourceId, created.linkId, "and it names the link's own row, not an invoice");
  expectEqual(claim.companyId, companyId, "under the merchant's company");
  expectEqual(claim.tokenId, created.tokenId, "and the id the row keeps");

  const stored = await createHarness.store.findByTokenId(created.tokenId);
  expect(stored !== null, "the row is in the store under the token id");
  expectEqual(stored?.tokenDigest, portalTokenDigest(created.token), "and holds the digest of the token");
  expect(stored?.tokenDigest !== created.token, "never the token itself");
  expectEqual(stored?.status, "active", "a new link is live");
  expectEqual(stored?.reissueCount, 0, "and has been issued once");

  expectEqual(
    actionsOf(createHarness.audit)[0],
    PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION,
    "a creation leaves one entry",
  );
  expectEqual(
    payloadOf(createHarness.audit, PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION)?.["token_id"],
    created.tokenId,
    "which names the token id",
  );
  expect(
    payloadOf(createHarness.audit, PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION)?.["token"] === undefined,
    "and never the token",
  );
  expectEqual(
    payloadOf(createHarness.audit, PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION)?.["plan_service"],
    PORTAL_PAYMENT_LINK_SERVICE_KEY,
    "and the entitlement it was granted under",
  );

  // -------------------------------------------------------------------------------------------
  // 4. Opening: the live link, and the four ways it is not
  // -------------------------------------------------------------------------------------------
  const openView = await openPortalPaymentLink({ token: created.token }, createHarness.dependencies);

  expectEqual(openView.linkId, created.linkId, "opening answers the link");
  expectEqual(openView.amountMinor, "1250000", "with its amount");
  expectEqual(openView.chargeAmount, "125.00", "and the provider's own spelling of it");
  expectEqual(openView.state, "active", "in its live state");
  expectEqual(openView.paidAtEpochMs, null, "with no payment");

  await expectRefusal(
    () => openPortalPaymentLink({ token: "not-a-token" }, createHarness.dependencies),
    "RESOURCE_NOT_FOUND",
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    "a token that does not verify is not found",
  );

  await expectRefusal(
    () =>
      openPortalPaymentLink(
        {
          token: mintPortalToken(
            {
              kind: "invoice" as typeof PORTAL_PAYMENT_LINK_TOKEN_KIND,
              companyId,
              resourceId: created.linkId,
              capability: PORTAL_PAYMENT_LINK_CAPABILITY,
              lifetimeSeconds: 3_600,
            },
            { keys, now: Math.floor(startedAtMs / 1_000), tokenId: randomBytes(16).toString("base64url") },
          ),
        },
        createHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    "an invoice token does not open a payment link",
  );

  const expiring = await createPortalPaymentLink(
    { actor: actorOf(), body: { ...validBody, expires_in_seconds: PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS } },
    createHarness.dependencies,
  );

  createHarness.advance(PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS + 1);

  await expectRefusal(
    () => openPortalPaymentLink({ token: expiring.token }, createHarness.dependencies),
    "RESOURCE_NOT_FOUND",
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    "a link past its lifetime cannot be opened, because its token expired with it",
  );

  expectEqual(
    (await createHarness.store.findById(expiring.linkId, companyId))?.status,
    "active",
    "and the row is still stored as active, because expiry is the clock's answer rather than a write",
  );

  const expiringRecord = await createHarness.store.findByTokenId(expiring.tokenId);

  expect(expiringRecord !== null, "the expiring link's row is still there");

  expectEqual(
    expiringRecord === null
      ? "missing"
      : portalPaymentLinkStateOf(
          expiringRecord,
          startedAtMs + (PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS + 1) * 1_000,
        ),
    "expired",
    "and the state function is what says so",
  );

  // -------------------------------------------------------------------------------------------
  // 5. Revoking: from a token and from the console's row, both guarded
  // -------------------------------------------------------------------------------------------
  const revokeHarness = harnessOf();
  const toRevoke = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, revokeHarness.dependencies);

  await expectRefusal(
    () =>
      revokePortalPaymentLink(
        { actor: actorOf({ roles: ["support"] }), token: toRevoke.token },
        revokeHarness.dependencies,
      ),
    "PERMISSION_DENIED",
    "",
    "a member of staff cannot revoke a link",
  );

  await expectRefusal(
    () =>
      revokePortalPaymentLink(
        { actor: actorOf({ companyId: otherCompanyId }), token: toRevoke.token },
        revokeHarness.dependencies,
      ),
    "PERMISSION_DENIED",
    "",
    "and another merchant holding the token is refused",
  );

  await expectRefusal(
    () =>
      revokePortalPaymentLinkById(
        { actor: actorOf({ companyId: otherCompanyId }), linkId: toRevoke.linkId },
        revokeHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    "another merchant's link id is not found rather than refused, so the console cannot probe",
  );

  const revoked = await revokePortalPaymentLink(
    { actor: actorOf(), token: toRevoke.token },
    revokeHarness.dependencies,
  );

  expectEqual(revoked.linkId, toRevoke.linkId, "a revoke answers the link it revoked");
  expectEqual(revoked.companyId, companyId, "and the merchant's company");
  expectEqual(
    (await revokeHarness.store.findByTokenId(toRevoke.tokenId))?.status,
    "revoked",
    "the row moves to revoked",
  );
  expectEqual(
    (await revokeHarness.store.findByTokenId(toRevoke.tokenId))?.tokenDigest,
    null,
    "and the digest is dropped, because no token is in circulation",
  );

  await expectRefusal(
    () => openPortalPaymentLink({ token: toRevoke.token }, revokeHarness.dependencies),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.linkRevoked,
    "and a revoked link tells the payer it was cancelled",
  );

  await expectRefusal(
    () => revokePortalPaymentLink({ actor: actorOf(), token: toRevoke.token }, revokeHarness.dependencies),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.linkNotActive,
    "revoking a link that is already revoked is a conflict",
  );

  const revokePayload = payloadOf(revokeHarness.audit, PORTAL_PAYMENT_LINK_REVOKED_AUDIT_ACTION);
  expectEqual(revokePayload?.["token_id"], toRevoke.tokenId, "the revoke entry names the token id it retired");
  expectEqual(revokePayload?.["amount_minor"], "1250000", "and the amount the link can no longer take");
  expect(
    revokeHarness.audit.entries.some(
      (entry) => entry.action === PORTAL_PAYMENT_LINK_REVOKED_AUDIT_ACTION && entry.actorUserId === ownerUserId,
    ),
    "and who did it",
  );

  // The console's own control: a revoke by row id, by the merchant that owns the row.
  const byIdHarness = harnessOf();
  const byIdLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, byIdHarness.dependencies);
  const byIdRevoked = await revokePortalPaymentLinkById(
    { actor: actorOf(), linkId: byIdLink.linkId },
    byIdHarness.dependencies,
  );

  expectEqual(byIdRevoked.linkId, byIdLink.linkId, "the console revokes the row it is looking at");
  expectEqual(
    (await byIdHarness.store.findById(byIdLink.linkId, companyId))?.status,
    "revoked",
    "and the row moves to revoked",
  );

  // -------------------------------------------------------------------------------------------
  // 6. Reissuing: a dead link, a new credential, the old URL gone
  // -------------------------------------------------------------------------------------------
  const reissueHarness = harnessOf();
  const live = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, reissueHarness.dependencies);

  await expectRefusal(
    () => reissuePortalPaymentLink({ actor: actorOf(), token: live.token }, reissueHarness.dependencies),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.linkNotActive,
    "a live link cannot be reissued, because its URL may already be shared",
  );

  await expectRefusal(
    () => reissuePortalPaymentLink({ actor: actorOf(), token: live.token }, harnessOf({ durable: false }).dependencies),
    "SERVICE_UNAVAILABLE",
    PORTAL_PAYMENT_LINK_RULES.storeUnavailable,
    "and no credential is minted over a store that cannot keep one",
  );

  await revokePortalPaymentLink({ actor: actorOf(), token: live.token }, reissueHarness.dependencies);
  reissueHarness.advance(120);

  const reissued = await reissuePortalPaymentLink(
    { actor: actorOf(), token: live.token },
    reissueHarness.dependencies,
  );

  expectEqual(reissued.linkId, live.linkId, "a reissue answers the same link");
  expect(reissued.tokenId !== live.tokenId, "with a new token id");
  expect(reissued.token !== live.token, "and a new token");
  expectEqual(reissued.previousTokenId, live.tokenId, "naming the one it replaced");
  expectEqual(reissued.reissueCount, 1, "and counting the reissue");
  expect(reissued.expiresAtEpochMs > live.expiresAtEpochMs, "with a fresh lifetime");

  await expectRefusal(
    () => openPortalPaymentLink({ token: live.token }, reissueHarness.dependencies),
    "RESOURCE_NOT_FOUND",
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    "the URL the merchant already shared resolves to nothing at all",
  );

  expectEqual(
    (await openPortalPaymentLink({ token: reissued.token }, reissueHarness.dependencies)).state,
    "active",
    "while the new one is live",
  );

  const reissuePayload = payloadOf(reissueHarness.audit, PORTAL_PAYMENT_LINK_REISSUED_AUDIT_ACTION);
  expectEqual(reissuePayload?.["previous_token_id"], live.tokenId, "the entry names the retired token id");
  expectEqual(reissuePayload?.["token_id"], reissued.tokenId, "and the new one");
  expectEqual(reissuePayload?.["previous_state"], "revoked", "with the state the link was in");
  expectEqual(reissuePayload?.["reissue_count"], 1, "and how many times it has been reissued");

  // A paid link is never reissuable: the money moved, and a second credential would be a second charge.
  const paidHarness = harnessOf();
  const paidLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, paidHarness.dependencies);

  await chargePortalPaymentLink(
    {
      token: paidLink.token,
      body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
      clientAddress: "203.0.113.10",
      userAgent: "gate",
      actorCompanyId: null,
    },
    paidHarness.dependencies,
  );

  await expectRefusal(
    () => reissuePortalPaymentLink({ actor: actorOf(), token: paidLink.token }, paidHarness.dependencies),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.linkPaid,
    "a paid link cannot be reissued",
  );

  await expectRefusal(
    () =>
      reissuePortalPaymentLinkById(
        { actor: actorOf({ companyId: otherCompanyId }), linkId: paidLink.linkId },
        paidHarness.dependencies,
      ),
    "RESOURCE_NOT_FOUND",
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    "and another merchant cannot reissue it by its row id either",
  );

  // -------------------------------------------------------------------------------------------
  // 7. The list: one tenant, newest first, bounded
  // -------------------------------------------------------------------------------------------
  const listHarness = harnessOf();
  const first = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, listHarness.dependencies);
  listHarness.advance(60);
  const second = await createPortalPaymentLink(
    { actor: actorOf(), body: { ...validBody, description: "Second link" } },
    listHarness.dependencies,
  );
  await createPortalPaymentLink(
    { actor: actorOf({ companyId: otherCompanyId }), body: validBody },
    { ...listHarness.dependencies, entitled: async () => true },
  );

  const listed = await listPortalPaymentLinks({ actor: actorOf(), limit: PORTAL_PAYMENT_LINK_PAGE_LIMIT }, listHarness.dependencies);

  expectEqual(listed.length, 2, "a merchant sees only their own links");
  expectEqual(listed[0]?.linkId, second.linkId, "newest first");
  expectEqual(listed[1]?.linkId, first.linkId, "then the older one");
  expectEqual(listed[0]?.state, "active", "each with its state");

  const bounded = await listPortalPaymentLinks({ actor: actorOf(), limit: 10_000 }, listHarness.dependencies);
  expectEqual(bounded.length, 2, "a caller cannot ask for more than the ceiling allows");

  await expectRefusal(
    () =>
      listPortalPaymentLinks(
        { actor: actorOf({ roles: ["support"] }), limit: 10 },
        listHarness.dependencies,
      ),
    "PERMISSION_DENIED",
    "",
    "and a member of staff cannot read the merchant's links",
  );

  // -------------------------------------------------------------------------------------------
  // 8. The checkout: one payment, no invoice, and the refusals STEP 183-188 already name
  // -------------------------------------------------------------------------------------------
  const chargeHarness = harnessOf();
  const chargeable = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, chargeHarness.dependencies);
  const idempotencyKey = randomUUID();

  const paid = await chargePortalPaymentLink(
    {
      token: chargeable.token,
      body: { collectjs_token: "1234567890abcdef-token", idempotency_key: idempotencyKey },
      clientAddress: "203.0.113.10",
      userAgent: "gate",
      actorCompanyId: null,
    },
    chargeHarness.dependencies,
  );

  expectEqual(paid.status, "captured", "a card on a link is captured");
  expectEqual(paid.linkId, chargeable.linkId, "and names the link");
  expectEqual(paid.amountMinor, "1250000", "the amount the link was made for");
  expectEqual(paid.chargeAmount, "125.00", "in the provider's spelling");
  expectEqual(paid.idempotencyKey, idempotencyKey, "with the key the form sent");
  expectEqual(paid.duplicate, false, "and it is not a duplicate");

  const request = chargeHarness.requests[0];
  expect(request !== undefined, "the processor was asked once");
  expectEqual(request?.invoiceId, null, "with no invoice, because a general link has none");
  expectEqual(request?.number, null, "and no document number");
  expectEqual(request?.companyId, companyId, "for the merchant that made the link");
  expectEqual(request?.amountMinor, "1250000", "for the link's amount");
  expectEqual(request?.clientAddress, "203.0.113.10", "and the address STEP 188 counts");

  expectEqual(
    (await chargeHarness.store.findById(chargeable.linkId, companyId))?.status,
    "paid",
    "the row moves to paid on capture",
  );
  expectEqual(
    (await chargeHarness.store.findById(chargeable.linkId, companyId))?.paymentId,
    paid.paymentId,
    "naming the payment it took",
  );

  const capturedPayload = payloadOf(chargeHarness.audit, PORTAL_PAYMENT_LINK_CAPTURED_AUDIT_ACTION);
  expectEqual(capturedPayload?.["payment_id"], paid.paymentId, "the capture entry names the payment");
  expectEqual(capturedPayload?.["transaction_id"], paid.transactionId, "and the provider's transaction");
  expect(
    typeof capturedPayload?.["idempotency_key_hash"] === "string" &&
      String(capturedPayload["idempotency_key_hash"]).length === 64,
    "and a hash of the key rather than the key",
  );
  expectEqual(capturedPayload?.["duplicate_link_payment"], false, "and says it was the link's first payment");

  // The link is spent: a second payer is told it is paid, and nothing reaches the processor.
  const requestsBefore = chargeHarness.requests.length;

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: chargeable.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.11",
          userAgent: "gate",
          actorCompanyId: null,
        },
        chargeHarness.dependencies,
      ),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.linkPaid,
    "a paid link refuses a second payer",
  );
  expectEqual(chargeHarness.requests.length, requestsBefore, "and the gateway is never asked again");

  // The merchant's own session cannot pay its own link.
  const selfHarness = harnessOf();
  const ownLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, selfHarness.dependencies);

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: ownLink.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: companyId,
        },
        selfHarness.dependencies,
      ),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.selfPayment,
    "a merchant cannot pay their own link",
  );
  expectEqual(selfHarness.requests.length, 0, "and nothing was sent to the gateway");
  expectEqual(
    payloadOf(selfHarness.audit, PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION)?.["rule"],
    PORTAL_PAYMENT_LINK_RULES.selfPayment,
    "while the refusal is in the chain",
  );

  // A dead link is refused before the provider, and its rule says which death.
  const deadHarness = harnessOf();
  const deadLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, deadHarness.dependencies);
  await revokePortalPaymentLink({ actor: actorOf(), token: deadLink.token }, deadHarness.dependencies);

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: deadLink.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: null,
        },
        deadHarness.dependencies,
      ),
    "CONFLICT",
    PORTAL_PAYMENT_LINK_RULES.linkRevoked,
    "a revoked link refuses the card",
  );
  expectEqual(deadHarness.requests.length, 0, "with no request to the provider");

  // A card number in the body is refused and audited, exactly as on the invoice page.
  const cardDataHarness = harnessOf();
  const cardDataLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, cardDataHarness.dependencies);

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: cardDataLink.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID(), card_number: "4111111111111111" },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: null,
        },
        cardDataHarness.dependencies,
      ),
    "VALIDATION_FAILED",
    "card_data_refused",
    "a body carrying a card number is refused",
  );
  expectEqual(cardDataHarness.requests.length, 0, "and never reaches the gateway");
  expectEqual(
    payloadOf(cardDataHarness.audit, PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION)?.["rule"],
    "card_data_refused",
    "and the refusal is in the chain",
  );

  // A deployment with no payment operation cannot take a card.
  const noProcessorHarness = harnessOf({ withoutProcessor: true });
  const noProcessorLink = await createPortalPaymentLink(
    { actor: actorOf(), body: validBody },
    noProcessorHarness.dependencies,
  );

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: noProcessorLink.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: null,
        },
        noProcessorHarness.dependencies,
      ),
    "SERVICE_UNAVAILABLE",
    "provider_unavailable",
    "a platform with no processor says so rather than taking the card",
  );
  expectEqual(
    (await noProcessorHarness.store.findById(noProcessorLink.linkId, companyId))?.status,
    "active",
    "and the link stays live",
  );

  // A decline is a declined card, and the link stays live for the payer to try another one.
  const declineHarness = harnessOf();
  const declineLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, declineHarness.dependencies);
  declineHarness.setOutcome({ status: "declined", paymentId: null, code: "200" });

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: declineLink.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: null,
        },
        declineHarness.dependencies,
      ),
    "VALIDATION_FAILED",
    "card_declined",
    "a declined card is a declined card",
  );
  expectEqual(
    payloadOf(declineHarness.audit, PORTAL_PAYMENT_LINK_DECLINED_AUDIT_ACTION)?.["decline_code"],
    "200",
    "the decline is in the chain with the provider's code",
  );
  expectEqual(
    (await declineHarness.store.findById(declineLink.linkId, companyId))?.status,
    "active",
    "and the link is still live",
  );

  // STEP 186's fraud signal, STEP 187's blacklist and STEP 188's counters arrive unchanged.
  for (const [outcome, code, rule, description] of [
    [
      { status: "refused_by_risk", paymentId: null, decision: "reject", signal: "fraud", code: "300", replayed: false },
      "VALIDATION_FAILED",
      "risk_rejected",
      "a fraud signal rejects the payment",
    ],
    [
      { status: "refused_by_risk", paymentId: null, decision: "review", signal: "suspicious", code: "301", replayed: false },
      "CONFLICT",
      "risk_suspicious",
      "and a suspicious one holds it",
    ],
    [
      { status: "refused_by_blacklist", paymentId: null, replayed: false, block: null },
      "VALIDATION_FAILED",
      "card_blacklisted",
      "a blacklisted card is refused",
    ],
    [
      { status: "unknown", paymentId: null, reason: "timeout" },
      "CONFLICT",
      "outcome_unknown",
      "an outcome the provider never answered is a conflict to reconcile",
    ],
  ] as const) {
    const harness = harnessOf();
    const link = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, harness.dependencies);
    harness.setOutcome(outcome as PortalChargeOutcome);

    await expectRefusal(
      () =>
        chargePortalPaymentLink(
          {
            token: link.token,
            body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
            clientAddress: "203.0.113.10",
            userAgent: "gate",
            actorCompanyId: null,
          },
          harness.dependencies,
        ),
      code,
      rule,
      description,
    );
    expectEqual(
      (await harness.store.findById(link.linkId, companyId))?.status,
      "active",
      `${description}: and the link stays live`,
    );
  }

  // A velocity refusal keeps its own field and its own wait, as STEP 188 wrote them.
  const velocityHarness = harnessOf();
  const velocityLink = await createPortalPaymentLink(
    { actor: actorOf(), body: validBody },
    velocityHarness.dependencies,
  );
  velocityHarness.setOutcome({
    status: "refused_by_velocity",
    limited: {
      subject: "card",
      hits: 6,
      limit: 5,
      windowSeconds: 600,
      retryAfterSeconds: 540,
      card: { subject: "card", hits: 6, limit: 5, windowSeconds: 600, retryAfterSeconds: 540 },
      ip: { subject: "ip", hits: 1, limit: 20, windowSeconds: 600, retryAfterSeconds: 0 },
    },
  });

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: velocityLink.token,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: null,
        },
        velocityHarness.dependencies,
      ),
    "RATE_LIMITED",
    "velocity_card_limited",
    "a card over its limit is told to wait",
  );

  // An amount the provider cannot write is refused before a payment record exists.
  //
  // No creation can make one - the amount parser refuses a price with more precision than the provider's cents -
  // so the row is written by hand, which is also the shape of a row a future migration could hold if a currency
  // with three decimals were ever admitted.
  const oddHarness = harnessOf();
  const oddId = "6f0a1b2c-3d4e-4f50-9a61-b2c3d4e5f607";
  const oddTokenId = randomBytes(16).toString("base64url");
  const oddToken = mintPortalToken(
    {
      kind: PORTAL_PAYMENT_LINK_TOKEN_KIND,
      companyId,
      resourceId: oddId,
      capability: PORTAL_PAYMENT_LINK_CAPABILITY,
      lifetimeSeconds: PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS,
    },
    { keys, now: Math.floor(startedAtMs / 1_000), tokenId: oddTokenId },
  );

  await oddHarness.store.insert({
    id: oddId,
    companyId,
    amountMinor: "10001",
    currency: PORTAL_PAYMENT_LINK_CURRENCY,
    description: "An amount the gateway cannot write",
    reference: null,
    status: "active",
    tokenId: oddTokenId,
    tokenDigest: portalTokenDigest(oddToken),
    reissueCount: 0,
    expiresAtEpochMs: startedAtMs + PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS * 1_000,
    revokedAtEpochMs: null,
    revokedByUserId: null,
    paidAtEpochMs: null,
    paymentId: null,
    createdByUserId: ownerUserId,
    createdAtEpochMs: startedAtMs,
    updatedAtEpochMs: startedAtMs,
  });

  await expectRefusal(
    () =>
      chargePortalPaymentLink(
        {
          token: oddToken,
          body: { collectjs_token: "1234567890abcdef-token", idempotency_key: randomUUID() },
          clientAddress: "203.0.113.10",
          userAgent: "gate",
          actorCompanyId: null,
        },
        oddHarness.dependencies,
      ),
    "CONFLICT",
    "amount_unrepresentable",
    "an amount the provider cannot express in cents is refused",
  );
  expectEqual(oddHarness.requests.length, 0, "before the gateway is asked");

  // -------------------------------------------------------------------------------------------
  // 9. The page: what it renders, and the sentence each refusal becomes
  // -------------------------------------------------------------------------------------------
  const pageHarness = harnessOf();
  const pageLink = await createPortalPaymentLink({ actor: actorOf(), body: validBody }, pageHarness.dependencies);
  const pageView = await preparePortalPaymentLinkCheckout({ token: pageLink.token }, pageHarness.dependencies);

  expectEqual(pageView.link.linkId, pageLink.linkId, "the page renders the link the token names");
  expect(pageView.secureFields !== null, "with the merchant's tokenization key");
  expectEqual(pageView.secureFields?.environment, "sandbox", "and the environment it belongs to");
  expectEqual(pageView.unavailable, null, "nothing is unavailable");
  expectEqual(pageView.partPayment.allowPartial, false, "a link takes the whole amount, never a part");
  expectEqual(pageView.partPayment.remainingMinor, "1250000", "and its ceiling is the amount");
  expect(pageView.idempotencyKey.length === 36, "and a fresh idempotency key per render");

  const noKeyView = await preparePortalPaymentLinkCheckout(
    { token: pageLink.token },
    { ...pageHarness.dependencies, tokenizationKeyFor: () => null },
  );
  expectEqual(noKeyView.unavailable, "provider", "a business with no gateway renders the provider panel");

  const noRecorderView = await preparePortalPaymentLinkCheckout(
    { token: pageLink.token },
    {
      ...pageHarness.dependencies,
      processor: { durable: false, async charge() { return { status: "unknown", paymentId: null, reason: "gate" }; } },
    },
  );
  expectEqual(noRecorderView.unavailable, "recorder", "and a platform that cannot record renders the recorder one");

  const sentenceCount = [
    PORTAL_PAYMENT_LINK_RULES.linkNotFound,
    PORTAL_PAYMENT_LINK_RULES.linkExpired,
    PORTAL_PAYMENT_LINK_RULES.linkRevoked,
    PORTAL_PAYMENT_LINK_RULES.linkPaid,
    PORTAL_PAYMENT_LINK_RULES.linkNotActive,
    PORTAL_PAYMENT_LINK_RULES.storeUnavailable,
    PORTAL_PAYMENT_LINK_RULES.notEntitled,
    PORTAL_PAYMENT_LINK_RULES.amountTooSmall,
    PORTAL_PAYMENT_LINK_RULES.amountTooLarge,
    PORTAL_PAYMENT_LINK_RULES.descriptionInvalid,
    PORTAL_PAYMENT_LINK_RULES.referenceInvalid,
    PORTAL_PAYMENT_LINK_RULES.lifetimeInvalid,
  ].filter((rule) => (portalPaymentRuleTextOf(rule) ?? "").length > 20).length;

  expectEqual(sentenceCount, 12, "every rule this STEP adds is a sentence a person can read");

  // -------------------------------------------------------------------------------------------
  // 10. The files, and the migration this STEP does not need
  // -------------------------------------------------------------------------------------------
  const portalRoot = new URL("./", import.meta.url);
  const fieldsSource = await readFile(new URL("portal-payment-link-fields.ts", portalRoot), "utf8");
  const storeSource = await readFile(new URL("portal-payment-link-store.ts", portalRoot), "utf8");
  const checkoutSource = await readFile(new URL("portal-payment-link-checkout.ts", portalRoot), "utf8");
  const pageSource = await readFile(new URL("p/[token]/page.tsx", portalRoot), "utf8");
  const chargeRouteSource = await readFile(new URL("p/[token]/charge/route.ts", portalRoot), "utf8");
  const consoleSource = await readFile(new URL("../(dashboard)/payments/links/payment-links-console.tsx", portalRoot), "utf8");
  const createRouteSource = await readFile(new URL("../../app/api/payment-links/route.ts", portalRoot), "utf8");
  const revokeRouteSource = await readFile(new URL("../../app/api/payment-links/[id]/revoke/route.ts", portalRoot), "utf8");
  const reissueRouteSource = await readFile(new URL("../../app/api/payment-links/[id]/reissue/route.ts", portalRoot), "utf8");
  const catalogSource = await readFile(new URL("../../lib/i18n/strings/en.ts", portalRoot), "utf8");
  const readmeSource = await readFile(new URL("README.md", portalRoot), "utf8");
  const store = storeSource;

  expect(
    store.includes("portal_payment_links (") && store.includes("token_digest text not null"),
    "the store's header still carries the table the STEP that writes it must satisfy",
  );
  expect(
    store.includes("durable: false"),
    "and the in-memory store still says it cannot survive a deploy",
  );
  expect(
    !fieldsSource.includes("invoice_id") && !storeSource.includes("invoice_id"),
    "nothing in a link's row names an invoice",
  );
  expect(
    checkoutSource.includes("invoiceId: null"),
    "and the checkout tells the processor there is no invoice",
  );

  for (const [name, source] of [
    ["the creation route", createRouteSource],
    ["the revoke route", revokeRouteSource],
    ["the reissue route", reissueRouteSource],
    ["the charge route", chargeRouteSource],
  ] as const) {
    expect(source.includes("requireCsrfToken("), `${name} checks the CSRF token`);
    expect(source.includes("\"cache-control\": \"no-store\""), `${name} answers no-store`);
    expect(source.includes("readRequestActor"), `${name} reads the actor rather than trusting a body`);
  }

  expect(chargeRouteSource.includes("enforcePortalRateLimit("), "the checkout spends a rate limit");
  expect(chargeRouteSource.includes("PORTAL_PAYMENT_LINK_RATE_LIMIT"), "the link's own counter");
  expect(chargeRouteSource.includes("PORTAL_THREE_DS_RULES.unavailable"), "and refuses a card it cannot authenticate");
  expect(
    pageSource.includes("CardPaymentForm") && pageSource.includes("/charge`"),
    "the hosted page renders the one card form and posts to the link's charge",
  );
  expect(pageSource.includes("force-dynamic"), "and is never cached");
  expect(
    !pageSource.includes("type=\"text\"") || !pageSource.includes("card"),
    "the page has no card input of its own",
  );
  expect(
    consoleSource.includes("/revoke") && consoleSource.includes("/reissue"),
    "the console has both controls",
  );
  expect(
    consoleSource.includes("navigator.clipboard"),
    "and offers the URL it can no longer read from the list",
  );
  expect(
    !consoleSource.includes("token") || consoleSource.includes("// "),
    "the console holds no token of its own",
  );

  for (const key of [
    "linkPageEyebrow",
    "linkPaidTitle",
    "linkRevokedTitle",
    "linkExpiredTitle",
    "ruleLinkNotFound",
    "ruleLinkPaid",
  ]) {
    expect(catalogSource.includes(`${key}:`), `the catalog words the payer's page: ${key}`);
  }

  for (const key of ["createTitle", "statePaid", "stateRevoked", "stateExpired", "reissue", "copy"]) {
    expect(catalogSource.includes(`${key}:`), `and the console: ${key}`);
  }

  expect(
    catalogSource.includes("paymentLinks: {"),
    "the console's vocabulary is one group, not keys scattered through the portal's",
  );
  expect(
    readmeSource.includes("STEP 190"),
    "and the portal's README says what this STEP built",
  );

  const migrations = (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);
  const highest = migrations[migrations.length - 1] ?? 0;

  expectEqual(highest, 122, "this STEP adds no migration, exactly as its own written proof says");
  expect(migrations.filter((number) => number === 0).length === 0, "and every migration is numbered");

  for (const name of await readdir(new URL("../../migrations/", import.meta.url))) {
    if (!name.endsWith(".sql")) {
      continue;
    }

    const source = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

    if (source.includes("portal_payment_links")) {
      expect(false, `${name} already holds a payment link table, so the store's port is redundant`);
    }
  }

  expect(true, "no migration names portal_payment_links, so the port is the only home of a link's row");

  if (failures.length > 0) {
    process.stdout.write(`portal payment link gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `portal payment link gate passed: ${String(checkCount)} checks, a link is a plan entitlement, its token carries ${PORTAL_PAYMENT_LINK_TOKEN_KIND}/${PORTAL_PAYMENT_LINK_CAPABILITY} and only its digest is stored, one payment per link with no invoice, revoke and reissue guarded for the owner, no migration needed\n`,
  );
}

await main();
