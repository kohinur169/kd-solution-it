// path: services/billing/entitlements.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import type { MessagePath } from "../../lib/i18n/messages.ts";
import {
  BILLING_PLAN_ENTITLEMENT_TABLE,
  BILLING_PLAN_SERVICE_KEYS,
  isBillingPlanServiceKey,
  planServiceLabelKey,
  type BillingPlanServiceKey,
} from "./plans-registry.ts";

/**
 * Section 9's second and third sentences, as one authority.
 *
 * > "Sub-merchants use the services included in their plan, such as invoicing, payment links, recurring
 * > invoices, public API and store connections, and test mode. Services outside the plan are not usable by
 * > that merchant."
 *
 * ## Where the answer comes from
 *
 * Three tables that already exist, in the order the question is asked:
 *
 *   1. `subscriptions` (0017) says which plan a company is on, and until when. One live row per merchant,
 *      by the partial unique index on `company_id`.
 *   2. `plans` (0014) says whether that plan is still live at all - a draft or retired plan grants nothing.
 *   3. `plan_entitlements` (0015) says which of the six services the plan includes, one row each.
 *
 * STEP 212 built the third; STEP 214 will build the first. This module is the read that both of them feed,
 * and it is written to be correct both before and after subscriptions can be written at all.
 *
 * ## Fail closed, and why that is the only defensible default
 *
 * Four things can be true of a merchant, and only one of them grants a service:
 *
 *   - `granted` - a live subscription to an active plan that includes the service.
 *   - `unassigned` - no live subscription. A merchant on no plan includes no service, so nothing is usable.
 *   - `not_live` - a subscription that is `pending`, `stopped` or `cancelled`, or one whose paid period has
 *     ended. Section 12's "services stop when both fail" is this state.
 *   - `unreadable` - a read that failed. A check that cannot be made must not hand out the feature, so this
 *     is a refusal too, and it is named differently because the merchant is not on a smaller plan; the
 *     platform is unable to answer.
 *
 * **The consequence is stated rather than hidden:** until STEP 214 can assign a plan, every merchant is
 * `unassigned` and every gated feature refuses. That is the correct reading of section 9 and the safe
 * failure, and the handoff names it as the deployment prerequisite rather than letting a "temporary" grant
 * become permanent.
 *
 * ## One request, one read
 *
 * A single page can ask six times - an invoice with a recurring job, a public API call, a test-mode toggle.
 * `createEntitlementReader` caches one merchant's answer for the life of one request, so six checks cost
 * three queries rather than eighteen, and it caches the refusal as well as the grant: an unreadable answer
 * is not retried until the next request.
 *
 * ## What this module does not do
 *
 * It does not call itself from any feature. The six features belong to other STEPs, so this STEP ships the
 * authority and the exact seam each of them must adopt; the handoff lists every call site by path. A guard
 * that is wired to nothing is the honest shape of a check that a later STEP connects, and pretending
 * otherwise would mean editing files this STEP does not own.
 */

/** The subscription table 0017 created. */
export const ENTITLEMENT_SUBSCRIPTION_TABLE = "subscriptions";

/**
 * The statuses whose plan still grants its services.
 *
 * `active` is obvious. `past_due` is deliberate: section 12 says warnings start seven days before the due
 * date and services stop only when both the balance and the card fail, so a merchant who owes money still
 * has a working platform until the platform decides otherwise. `pending` never started, `stopped` has been
 * stopped, and `cancelled` is history.
 */
export const ENTITLED_SUBSCRIPTION_STATUSES = Object.freeze(["active", "past_due"] as const);

export type EntitledSubscriptionStatus = (typeof ENTITLED_SUBSCRIPTION_STATUSES)[number];

/**
 * The four states a merchant's entitlements can be in.
 *
 * Named as facts rather than as booleans, because "no plan" and "a plan without this service" are different
 * sentences to a merchant and different rows in the chain.
 */
export const ENTITLEMENT_KINDS = Object.freeze([
  "granted",
  "unassigned",
  "not_live",
  "unreadable",
] as const);

export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

/** The five answers one service can get. `granted` is the only one that hands the feature over. */
export const ENTITLEMENT_VERDICTS = Object.freeze([
  "granted",
  "plan_unassigned",
  "plan_not_live",
  "plan_missing_service",
  "plan_unreadable",
] as const);

export type EntitlementVerdict = (typeof ENTITLEMENT_VERDICTS)[number];

/** The chain action one refusal writes, and the entity it names. */
export const ENTITLEMENT_REFUSED_AUDIT_ACTION = "billing.service_refused";
export const ENTITLEMENT_ENTITY_TYPE = "entitlement";

/** The one role that may read a merchant's entitlements from the office. */
export const ENTITLEMENT_READ_ROLES = Object.freeze(["super_admin"] as const);

/** A merchant's service key and the feature it gates, with the sentence a screen shows for it. */
export interface MerchantFeature {
  readonly key: BillingPlanServiceKey;
  readonly services: readonly BillingPlanServiceKey[];
  readonly labelKey: MessagePath;
}

/**
 * The six features of section 9, each with the services it needs.
 *
 * Today one service each, and that is a fact about section 9 rather than a simplification: it names six
 * services and gates six features with them. The shape is a list because a later feature may need two - a
 * recurring job uses `recurring_invoices` *and* `invoicing` - and a check that could only ever take one key
 * would have to be rewritten to express it.
 */
export const MERCHANT_FEATURES: readonly MerchantFeature[] = Object.freeze(
  BILLING_PLAN_SERVICE_KEYS.map((service) =>
    Object.freeze({ key: service, services: Object.freeze([service]), labelKey: planServiceLabelKey(service) }),
  ),
);

/** The feature with this key, or null. */
export function merchantFeatureOf(key: string): MerchantFeature | null {
  return MERCHANT_FEATURES.find((feature) => feature.key === key) ?? null;
}

/** The plan a merchant is on, as the check needs it. */
export interface EntitlementPlan {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
}

/** The subscription the plan came from. */
export interface EntitlementSubscription {
  readonly id: string;
  readonly status: string;
  readonly currentPeriodEnd: string;
}

/** One merchant's answer: what state they are in, on what plan, and which services that plan includes. */
export interface MerchantEntitlements {
  readonly companyId: string;
  readonly kind: EntitlementKind;
  readonly subscription: EntitlementSubscription | null;
  readonly plan: EntitlementPlan | null;
  readonly services: readonly BillingPlanServiceKey[];
  readonly readAtEpochMs: number;
}

/** One feature's verdict, for a screen or an office answer. */
export interface EntitlementCheck {
  readonly feature: BillingPlanServiceKey;
  readonly services: readonly BillingPlanServiceKey[];
  readonly labelKey: MessagePath;
  readonly verdict: EntitlementVerdict;
}

/** What an office read answers: the merchant's state, and the six verdicts that follow from it. */
export interface MerchantEntitlementAnswer {
  readonly entitlements: MerchantEntitlements;
  readonly checks: readonly EntitlementCheck[];
}

/** What one check needs beyond the merchant: the gateway to the database and a clock. */
export interface EntitlementDependencies {
  readonly store: RestClient;
  readonly now: () => number;
}

/** What a refusal needs beyond that: somewhere to record it. */
export interface EntitlementGuardDependencies extends EntitlementDependencies {
  readonly audit: AuditTrail;
}

const subscriptionRowSchema = z.object({
  id: z.string().uuid(),
  plan_id: z.string().uuid(),
  status: z.string(),
  current_period_end: z.string(),
});

const planRowSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
});

const entitlementRowSchema = z.object({ service: z.string() });

const companyIdSchema = z.string().uuid();

/** One refusal that names a field and a rule, and never a value. */
function refusal(code: "VALIDATION_FAILED" | "PERMISSION_DENIED", field: string, rule: string): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/**
 * The verdict for one service, from a merchant's answer.
 *
 * Pure, and exported, because a screen and a gate both need to ask the same question of a snapshot they
 * already hold - and because a verdict that could only be produced by a database read could not be tested
 * for the four states it distinguishes.
 */
export function entitlementVerdictOf(
  entitlements: MerchantEntitlements,
  service: BillingPlanServiceKey,
): EntitlementVerdict {
  if (entitlements.kind === "unreadable") {
    return "plan_unreadable";
  }

  if (entitlements.kind === "unassigned") {
    return "plan_unassigned";
  }

  if (entitlements.kind === "not_live") {
    return "plan_not_live";
  }

  return entitlements.services.includes(service) ? "granted" : "plan_missing_service";
}

/** The verdict for a feature, which is granted only when every service it needs is. */
export function featureVerdictOf(
  entitlements: MerchantEntitlements,
  feature: MerchantFeature,
): EntitlementVerdict {
  const verdicts = feature.services.map((service) => entitlementVerdictOf(entitlements, service));
  const refused = verdicts.find((verdict) => verdict !== "granted");

  return refused ?? "granted";
}

/** The six verdicts a merchant's answer implies, in the catalogue's order. */
export function describeEntitlements(entitlements: MerchantEntitlements): readonly EntitlementCheck[] {
  return MERCHANT_FEATURES.map((feature) => ({
    feature: feature.key,
    services: feature.services,
    labelKey: feature.labelKey,
    verdict: featureVerdictOf(entitlements, feature),
  }));
}

/**
 * Read one merchant's entitlements.
 *
 * The three reads are the three questions, and each can end the answer early: no live subscription is
 * `unassigned`, a status outside the two or an ended period is `not_live`, a plan that is not active is
 * `not_live` as well. A read that throws is `unreadable`, which is a refusal and not an error: the caller
 * refuses the feature and the merchant sees the same sentence a smaller plan produces.
 *
 * The plan's own `status` is consulted because `0014` allows a plan to be `draft` or `retired`, and a
 * retired plan must not keep granting what it used to sell. A draft plan grants nothing for the same reason:
 * it was never on sale.
 */
export async function readMerchantEntitlements(
  input: { readonly companyId: string },
  dependencies: EntitlementDependencies,
): Promise<MerchantEntitlements> {
  const companyId = input.companyId.trim();

  if (!companyIdSchema.safeParse(companyId).success) {
    throw refusal("VALIDATION_FAILED", "companyId", "malformed");
  }

  const readAtEpochMs = dependencies.now();
  const base = {
    companyId,
    subscription: null,
    plan: null,
    services: [] as readonly BillingPlanServiceKey[],
    readAtEpochMs,
  };

  try {
    const subscriptions = await dependencies.store.select(
      ENTITLEMENT_SUBSCRIPTION_TABLE,
      `select=id,plan_id,status,current_period_end&company_id=eq.${encodeURIComponent(companyId)}` +
        "&deleted_at=is.null&order=created_at.desc&limit=1",
      subscriptionRowSchema,
    );
    const subscription = subscriptions[0];

    if (subscription === undefined) {
      return { ...base, kind: "unassigned" };
    }

    const carried: EntitlementSubscription = {
      id: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.current_period_end,
    };

    if (!(ENTITLED_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status)) {
      return { ...base, kind: "not_live", subscription: carried };
    }

    // A period that ended without a renewal is a subscription section 12 has stopped: the merchant keeps
    // the history and loses the services until a payment succeeds.
    if (Date.parse(subscription.current_period_end) <= readAtEpochMs) {
      return { ...base, kind: "not_live", subscription: carried };
    }

    const plans = await dependencies.store.select(
      "plans",
      `select=id,code,name,status&id=eq.${encodeURIComponent(subscription.plan_id)}` + "&deleted_at=is.null&limit=1",
      planRowSchema,
    );
    const plan = plans[0];

    if (plan === undefined) {
      return { ...base, kind: "not_live", subscription: carried };
    }

    const described: EntitlementPlan = { id: plan.id, code: plan.code, name: plan.name, status: plan.status };

    if (plan.status !== "active") {
      return { ...base, kind: "not_live", subscription: carried, plan: described };
    }

    const entitlements = await dependencies.store.select(
      BILLING_PLAN_ENTITLEMENT_TABLE,
      `select=service&plan_id=eq.${encodeURIComponent(plan.id)}&deleted_at=is.null&limit=50`,
      entitlementRowSchema,
    );
    const present = entitlements.map((row) => row.service);
    // The catalogue's order, and only keys the catalogue knows: a row written by a later STEP cannot make a
    // feature appear here before this module has been taught its name.
    const services = BILLING_PLAN_SERVICE_KEYS.filter(
      (service) => present.includes(service) && isBillingPlanServiceKey(service),
    );

    return { ...base, kind: "granted", subscription: carried, plan: described, services };
  } catch {
    return { ...base, kind: "unreadable" };
  }
}

/** What one refusal records, on the merchant's own chain. */
function refusalPayload(
  entitlements: MerchantEntitlements,
  feature: MerchantFeature,
  verdict: EntitlementVerdict,
): Readonly<Record<string, unknown>> {
  return {
    feature: feature.key,
    services: feature.services,
    verdict,
    plan_id: entitlements.plan?.id ?? null,
    plan_code: entitlements.plan?.code ?? null,
    plan_status: entitlements.plan?.status ?? null,
    subscription_status: entitlements.subscription?.status ?? null,
    subscription_period_end: entitlements.subscription?.currentPeriodEnd ?? null,
  };
}

/**
 * Ask whether a merchant may use one feature, and refuse with a rule when it may not.
 *
 * ## Why the refusal is recorded before it is thrown
 *
 * A merchant who cannot invoice their client is a fact the platform must be able to explain later: which
 * service, which plan, which subscription state. The entry goes on the **merchant's** chain rather than the
 * platform's, and it carries no amount, no client and no content - only the shape of the refusal.
 *
 * ## Why a failed audit does not change the answer
 *
 * If the chain cannot be written, the answer is still "no". Turning a refusal into a `503` would tell the
 * merchant the platform is broken when it is not, and granting would be worse than both; the failure is
 * logged and the refusal stands.
 */
export async function requireMerchantFeature(
  input: { readonly companyId: string; readonly feature: string },
  dependencies: EntitlementGuardDependencies,
): Promise<MerchantEntitlements> {
  // The feature is checked before anything is read: a caller that named a service this platform does not have
  // has made a programming error, and answering it with three queries would hide that behind a refusal about
  // the merchant's plan.
  const feature = merchantFeatureOf(input.feature);

  if (feature === null) {
    throw refusal("VALIDATION_FAILED", "feature", "unknown");
  }

  const entitlements = await readMerchantEntitlements({ companyId: input.companyId }, dependencies);

  return requireMerchantFeatureFrom(entitlements, feature.key, dependencies);
}

/** One request's view: the same authority, read once per merchant. */
export interface EntitlementReader {
  read(companyId: string): Promise<MerchantEntitlements>;
  require(input: { readonly companyId: string; readonly feature: string }): Promise<MerchantEntitlements>;
}

/**
 * A reader that remembers one answer per merchant for the life of one request.
 *
 * Both outcomes are cached. A grant costs three queries once; a refusal - including an unreadable one - is
 * not retried, because a request that already knows the answer should not ask the database five more times
 * to be told the same thing.
 */
export function createEntitlementReader(dependencies: EntitlementGuardDependencies): EntitlementReader {
  const answers = new Map<string, Promise<MerchantEntitlements>>();

  function read(companyId: string): Promise<MerchantEntitlements> {
    const cached = answers.get(companyId);

    if (cached !== undefined) {
      return cached;
    }

    const pending = readMerchantEntitlements({ companyId }, dependencies);
    answers.set(companyId, pending);

    return pending;
  }

  return {
    read,
    async require(input: { readonly companyId: string; readonly feature: string }): Promise<MerchantEntitlements> {
      const entitlements = await read(input.companyId);

      return requireMerchantFeatureFrom(entitlements, input.feature, dependencies);
    },
  };
}

/**
 * The same refusal, from an answer that was already read.
 *
 * Split out so the cached reader and the uncached guard cannot drift: both end in this function, so a rule
 * added here is a rule both obey.
 */
async function requireMerchantFeatureFrom(
  entitlements: MerchantEntitlements,
  featureKey: string,
  dependencies: EntitlementGuardDependencies,
): Promise<MerchantEntitlements> {
  const feature = merchantFeatureOf(featureKey);

  if (feature === null) {
    throw refusal("VALIDATION_FAILED", "feature", "unknown");
  }

  const verdict = featureVerdictOf(entitlements, feature);

  if (verdict === "granted") {
    return entitlements;
  }

  try {
    await dependencies.audit.append({
      action: ENTITLEMENT_REFUSED_AUDIT_ACTION,
      actorUserId: null,
      entityType: ENTITLEMENT_ENTITY_TYPE,
      entityId: entitlements.companyId,
      companyId: entitlements.companyId,
      payload: refusalPayload(entitlements, feature, verdict),
    });
  } catch {
    // As above: the refusal is the answer whether or not it could be recorded.
  }

  throw refusal("PERMISSION_DENIED", "service", verdict);
}

/**
 * The office's view of one merchant: who may ask, and what the answer is.
 *
 * Separate from `readMerchantEntitlements` because the role belongs to the *caller*, not to the merchant:
 * a feature checking itself has no staff actor, and an office screen has one. Keeping the two apart is what
 * stops a super administrator's role from being mistaken for a merchant's entitlement.
 */
export async function readOfficeEntitlements(
  input: { readonly actor: RequestActor; readonly companyId: string },
  dependencies: EntitlementDependencies,
): Promise<MerchantEntitlementAnswer> {
  requireAnyRole(input.actor, ENTITLEMENT_READ_ROLES);

  const entitlements = await readMerchantEntitlements({ companyId: input.companyId }, dependencies);

  return { entitlements, checks: describeEntitlements(entitlements) };
}
