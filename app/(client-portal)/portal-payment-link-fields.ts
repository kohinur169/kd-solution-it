// path: app/(client-portal)/portal-payment-link-fields.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import { appConfig } from "../../config/app.ts";
import { PORTAL_TOKEN_KINDS, PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS } from "../../lib/security/portal-token.ts";

/**
 * The vocabulary of a general payment link and its hosted checkout.
 *
 * FEATURE_LIST section 16, last line: "payment links and hosted checkout: a merchant can create a general
 * payment link and share it anywhere, when the service is in the merchant plan." Three things follow, and this
 * module holds the names they need:
 *
 *   1. **a link** - an amount, a description and a lifetime, minted as a portal token of kind `payment_link`
 *      (`lib/security/portal-token.ts` already carries the kind and the `view`/`pay` capabilities);
 *   2. **a hosted checkout** - a page anybody holding the link may open, which takes a card through the same
 *      hosted fields every payment page in this repository uses;
 *   3. **two merchant controls** - revoke the token in circulation, and reissue a fresh one for the same link.
 *
 * ## Why the amount lives in the link, not in the token
 *
 * A portal token is signed, not encrypted, and its claim shape is STEP 058's: kind, company, resource, token id,
 * clock. Nothing in it could carry an amount without widening a security STEP's schema - and a token is handed
 * to strangers, so the amount belongs to a row the platform owns and the token only names it. The row is the
 * `PortalPaymentLinkRecord` of `portal-payment-link-store.ts`.
 *
 * ## Why this module is browser safe
 *
 * The merchant console and the checkout page both print these numbers, and one of them is a client component.
 * So the vocabulary imports no REST client, no audit trail and no Node builtin: only the freeze helper, the
 * configuration and the token module's two constants.
 */

/** The path segment a general payment link lives under, after the origin. `p/[token]`. */
export const PORTAL_PAYMENT_LINK_PATH = "/p";

/** The token kind a general link is minted as, borrowed from STEP 058's own list. */
export const PORTAL_PAYMENT_LINK_TOKEN_KIND = "payment_link" as const;

/** True when STEP 058's token module knows the kind this module mints. */
export const PORTAL_PAYMENT_LINK_KIND_KNOWN = (PORTAL_TOKEN_KINDS as readonly string[]).includes("payment_link");

/** The capability the checkout needs: a link is paid, so it carries `pay`. */
export const PORTAL_PAYMENT_LINK_CAPABILITY = "pay" as const;

/**
 * The plan service a merchant must have, in the spelling `0015` stores.
 *
 * Section 16's last line makes a general payment link a **plan** feature, so creating one is refused when the
 * plan does not include it. `plan_entitlements.service` is a lower snake key and this is the key the catalogue
 * names.
 */
export const PORTAL_PAYMENT_LINK_SERVICE_KEY = "payment_links";

/** The tables a creation reads: the merchant's plan, the plan's services, and the company's name. */
export const PORTAL_SUBSCRIPTIONS_TABLE = "subscriptions";
export const PORTAL_PLAN_ENTITLEMENTS_TABLE = "plan_entitlements";
export const PORTAL_COMPANIES_TABLE = "companies";

/** The body fields a creation and a reissue accept, in the order a refusal lists them. */
export const PORTAL_PAYMENT_LINK_CREATE_FIELD_ORDER = deepFreeze([
  "amount",
  "description",
  "reference",
  "expires_in_seconds",
] as const);

/** The longest description a link may carry: a sentence, not a document. */
export const PORTAL_PAYMENT_LINK_DESCRIPTION_MINIMUM_LENGTH = 1;
export const PORTAL_PAYMENT_LINK_DESCRIPTION_MAXIMUM_LENGTH = 200;

/** The longest reference, which is the merchant's own word for the payment. */
export const PORTAL_PAYMENT_LINK_REFERENCE_MAXIMUM_LENGTH = 64;

/**
 * What a link may be for, in minor units.
 *
 * At least one dollar: the provider takes cents, and a link for less than a unit is a mistake typed into a
 * form rather than a payment anybody means to collect. At most a hundred thousand dollars: a link is a
 * hand-shared request, and one larger than that belongs on an invoice where it has line items and a due date.
 */
export const PORTAL_PAYMENT_LINK_MINIMUM_MINOR = 10_000n;
export const PORTAL_PAYMENT_LINK_MAXIMUM_MINOR = 1_000_000_000n;

/** The body ceiling of a creation, in bytes: four short fields and their JSON punctuation. */
export const PORTAL_PAYMENT_LINK_MAXIMUM_BODY_BYTES = 2_048;

/**
 * How many links one listing answers with.
 *
 * A merchant's live links are a handful, and a list is read to find one: fifty is the page size the console
 * asks for and the ceiling every caller is held to, so a query parameter cannot make one read unbounded.
 */
export const PORTAL_PAYMENT_LINK_PAGE_LIMIT = 50;

/**
 * How long a link lives.
 *
 * One week by default, at least one hour, at most the thirty days STEP 058's token module allows - a link is
 * shared in a chat or a mail and a link somebody forgot about should stop working on its own.
 */
export const PORTAL_PAYMENT_LINK_DEFAULT_LIFETIME_SECONDS = 604_800;
export const PORTAL_PAYMENT_LINK_MINIMUM_LIFETIME_SECONDS = 3_600;
export const PORTAL_PAYMENT_LINK_MAXIMUM_LIFETIME_SECONDS = PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS;

/**
 * The counter the checkout spends, per address.
 *
 * Five attempts per ten minutes, the same ceiling STEP 183's payment page uses and for the same reason: a
 * client who mistypes a card is told by the provider's own fields before a request is made, so five covers a
 * retry, a reload and a second browser - and it stops a script that holds a link from testing cards through it.
 */
export const PORTAL_PAYMENT_LINK_RATE_LIMIT = deepFreeze({
  scope: "portal_payment_link",
  limit: 5,
  windowSeconds: 600,
});

/**
 * The four states a link folds into.
 *
 * `active` is the only state that takes money. `paid`, `revoked` and `expired` each have their own sentence,
 * because a payer who follows a link needs to know which of the three happened - and the difference tells them
 * nothing an attacker could use, since the token is already in their hands.
 */
export const PORTAL_PAYMENT_LINK_STATES = deepFreeze(["active", "paid", "revoked", "expired"] as const);

export type PortalPaymentLinkState = (typeof PORTAL_PAYMENT_LINK_STATES)[number];

/** The stored status of a link: the two live states and the two a merchant or the clock ends. */
export const PORTAL_PAYMENT_LINK_STATUSES = deepFreeze(["active", "paid", "revoked"] as const);

export type PortalPaymentLinkStatus = (typeof PORTAL_PAYMENT_LINK_STATUSES)[number];

/**
 * The rules a link and its controls refuse with.
 *
 * A rule is the `rule` of an `AppError` detail, so a screen maps one word to one sentence. The first four are
 * about the fields a merchant typed, the next four about the link's state, and the last about the plan.
 */
export const PORTAL_PAYMENT_LINK_RULES = deepFreeze({
  /** The amount is not a price this platform can read. */
  amountInvalid: "amount_invalid",
  /** Below a dollar. */
  amountTooSmall: "amount_too_small",
  /** Above a hundred thousand dollars. */
  amountTooLarge: "amount_too_large",
  /** A price with more precision than the provider's cents. */
  amountUnrepresentable: "amount_unrepresentable",
  /** An empty description, or one past two hundred characters. */
  descriptionInvalid: "description_invalid",
  /** A reference past sixty four characters. */
  referenceInvalid: "reference_invalid",
  /** A lifetime outside an hour and thirty days. */
  lifetimeInvalid: "lifetime_invalid",
  /** The merchant's plan does not include payment links. */
  notEntitled: "payment_links_not_in_plan",
  /** No such link, or a link this merchant does not own. */
  linkNotFound: "link_not_found",
  /** The link is past its expiry. */
  linkExpired: "link_expired",
  /** The merchant revoked it. */
  linkRevoked: "link_revoked",
  /** It has already been paid, and a general link takes one payment. */
  linkPaid: "link_paid",
  /** Revoking a link that is not live, or reissuing one that is live or paid. */
  linkNotActive: "link_not_active",
  /** The platform cannot keep links durably in this deployment, so it must not mint one. */
  storeUnavailable: "payment_link_store_unavailable",
  /** The merchant's own session tried to pay the link. */
  selfPayment: "self_payment",
} as const);

/** The audit actions of this STEP: two merchant controls, one creation, and the checkout's outcomes. */
export const PORTAL_PAYMENT_LINK_CREATED_AUDIT_ACTION = "portal.payment_link_created";
export const PORTAL_PAYMENT_LINK_REVOKED_AUDIT_ACTION = "portal.payment_link_revoked";
export const PORTAL_PAYMENT_LINK_REISSUED_AUDIT_ACTION = "portal.payment_link_reissued";
export const PORTAL_PAYMENT_LINK_CAPTURED_AUDIT_ACTION = "portal.payment_link_captured";
export const PORTAL_PAYMENT_LINK_DECLINED_AUDIT_ACTION = "portal.payment_link_declined";
export const PORTAL_PAYMENT_LINK_UNKNOWN_AUDIT_ACTION = "portal.payment_link_unknown";
export const PORTAL_PAYMENT_LINK_REFUSED_AUDIT_ACTION = "portal.payment_link_refused";

/** The audit entity: a payment link, read by its own id, whichever surface wrote the entry. */
export const PORTAL_PAYMENT_LINK_AUDIT_ENTITY = "payment_link";

/** The currency a general link is priced in: the platform's own, as section 16 requires. */
export const PORTAL_PAYMENT_LINK_CURRENCY = appConfig.money.currencyCode;

/** The provider's cents, and the platform's four decimals, as the amount check needs them. */
export const PORTAL_PAYMENT_LINK_PROVIDER_MINOR_PER_UNIT = 100n;
export const PORTAL_PAYMENT_LINK_PLATFORM_MINOR_PER_UNIT = 10_000n;
