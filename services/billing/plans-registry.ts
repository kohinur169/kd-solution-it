// path: services/billing/plans-registry.ts
import { deepFreeze } from "../../lib/utils/freeze.ts";
import type { MessagePath } from "../../lib/i18n/messages.ts";

/**
 * The plan catalogue of FEATURE_LIST section 9, in one place.
 *
 * > "super_admin creates plans: name, price, period and which services each plan includes."
 *
 * The tables already exist - `0014_plans.sql` and `0015_plan_entitlements.sql`, written by the schema
 * block as STEP 018 - so this file holds the **vocabulary** rather than a migration: the four columns
 * a plan is, the six service keys section 9 names, the two periods the schema allows, and every rule
 * a refusal can name.
 *
 * ## Why the services are a list and not columns
 *
 * `0015`'s own comment says it: a boolean column per service would mean a migration every time the
 * catalogue gains one, and six columns would let the same service be described twice. So a plan
 * includes a service by carrying a row, and this file is the one place that says which keys are
 * legal - the insert of a key outside this list is refused here, before the database's own pattern
 * check would accept it.
 *
 * ## Why the price is minor units and the period is a word
 *
 * `price_minor` is a `bigint` and `period` is `monthly` or `yearly`; "every 30 days" is a different
 * thing from "monthly", and a float price is a different number from the one a merchant reads. Both
 * facts belong to `0014`, and this file repeats them so a refusal can name the rule instead of
 * surfacing a check constraint.
 *
 * ## What is deliberately absent
 *
 * No entitlement check, no subscription and no proration: section 9's second and third sentences are
 * STEP 213's, and section 12's billing is later still. This STEP creates the catalogue and nothing
 * that depends on it.
 */

/** The two tables `0014` and `0015` created. Named here so no caller spells them itself. */
export const BILLING_PLAN_TABLE = "plans";
export const BILLING_PLAN_ENTITLEMENT_TABLE = "plan_entitlements";

/**
 * The columns a plan is read by.
 *
 * Selected rather than starred: `0014` carries `company_id`, `version` and `deleted_at` for the
 * platform's own reasons, and none of the three is part of what a plan *is* to a reader.
 */
export const BILLING_PLAN_COLUMNS =
  "id,code,name,price_minor,currency,period,status,published_at,sort_order,created_at,updated_at";

/** The columns of one service row, and the two a reader needs beyond them. */
export const BILLING_PLAN_ENTITLEMENT_COLUMNS = "id,plan_id,service,created_at";

/** The three states `0014` allows, in its order. */
export const BILLING_PLAN_STATUSES = deepFreeze(["draft", "active", "retired"] as const);

export type BillingPlanStatus = (typeof BILLING_PLAN_STATUSES)[number];

/**
 * The two periods `0014` allows.
 *
 * Two, not a number of days: a yearly plan renews on its anniversary rather than every 365 days, and
 * a billing STEP that cannot tell the two apart cannot bill either correctly.
 */
export const BILLING_PLAN_PERIODS = deepFreeze(["monthly", "yearly"] as const);

export type BillingPlanPeriod = (typeof BILLING_PLAN_PERIODS)[number];

/**
 * The six services section 9 names, in its order.
 *
 * `invoicing`, `payment_links`, `recurring_invoices`, `public_api`, `store_connections` and
 * `test_mode` are the sentences the feature list gives a plan, and `0015`'s own comment names the same
 * six. This is the catalogue an operator chooses from; a key outside it is refused.
 */
export const BILLING_PLAN_SERVICE_KEYS = deepFreeze([
  "invoicing",
  "payment_links",
  "recurring_invoices",
  "public_api",
  "store_connections",
  "test_mode",
] as const);

export type BillingPlanServiceKey = (typeof BILLING_PLAN_SERVICE_KEYS)[number];

/** The label of one service, and of the two periods and the three states, in the string catalog. */
const serviceLabelKeys: Readonly<Record<BillingPlanServiceKey, MessagePath>> = deepFreeze({
  invoicing: "officePlans.serviceInvoicing",
  payment_links: "officePlans.servicePaymentLinks",
  recurring_invoices: "officePlans.serviceRecurringInvoices",
  public_api: "officePlans.servicePublicApi",
  store_connections: "officePlans.serviceStoreConnections",
  test_mode: "officePlans.serviceTestMode",
});

const periodLabelKeys: Readonly<Record<BillingPlanPeriod, MessagePath>> = deepFreeze({
  monthly: "officePlans.periodMonthly",
  yearly: "officePlans.periodYearly",
});

const statusLabelKeys: Readonly<Record<BillingPlanStatus, MessagePath>> = deepFreeze({
  draft: "officePlans.statusDraft",
  active: "officePlans.statusActive",
  retired: "officePlans.statusRetired",
});

export function planServiceLabelKey(service: BillingPlanServiceKey): MessagePath {
  return serviceLabelKeys[service];
}

export function planPeriodLabelKey(period: BillingPlanPeriod): MessagePath {
  return periodLabelKeys[period];
}

export function planStatusLabelKey(status: BillingPlanStatus): MessagePath {
  return statusLabelKeys[status];
}

/** True when a value is one of the six service keys. A row is filtered through this before it is shown. */
export function isBillingPlanServiceKey(value: unknown): value is BillingPlanServiceKey {
  return typeof value === "string" && (BILLING_PLAN_SERVICE_KEYS as readonly string[]).includes(value);
}

/** True when a value is one of the two periods. */
export function isBillingPlanPeriod(value: unknown): value is BillingPlanPeriod {
  return typeof value === "string" && (BILLING_PLAN_PERIODS as readonly string[]).includes(value);
}

/** True when a value is one of the three states. */
export function isBillingPlanStatus(value: unknown): value is BillingPlanStatus {
  return typeof value === "string" && (BILLING_PLAN_STATUSES as readonly string[]).includes(value);
}

/**
 * The code's shape, exactly as `plans_code_check` states it.
 *
 * A lower case slug of at least two characters: `starter`, `growth-yearly`, `pro`. It is the plan's
 * identity for ever - a retired plan keeps its code reserved - so it is the one value a creation form
 * must not let an operator invent twice.
 */
export const BILLING_PLAN_CODE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
export const BILLING_PLAN_CODE_MINIMUM_LENGTH = 2;
export const BILLING_PLAN_CODE_MAXIMUM_LENGTH = 39;

/** A name a merchant reads: trimmed, at most eighty characters, as `plans_name_check` requires. */
export const BILLING_PLAN_NAME_MINIMUM_LENGTH = 1;
export const BILLING_PLAN_NAME_MAXIMUM_LENGTH = 80;

/**
 * The price's ceiling, as a decision rather than a schema limit.
 *
 * `0014` only forbids a negative price. A plan is what a merchant pays, so a price past one million
 * major units is a typing mistake far more often than a plan, and refusing it here says so in words
 * an operator can act on rather than letting it into the catalogue.
 */
export const BILLING_PLAN_PRICE_MAXIMUM_MINOR = 100_000_000;

/** The currency's shape, `0014`'s own: three upper case letters. The default is the platform's. */
export const BILLING_PLAN_CURRENCY_PATTERN = /^[A-Z]{3}$/u;
export const BILLING_PLAN_DEFAULT_CURRENCY = "USD";

/** The display order's ceiling: a sortable catalogue, not a second identity. */
export const BILLING_PLAN_SORT_ORDER_MAXIMUM = 9_999;

/** How many plans one catalogue read returns. The office lists them all in one page at this size. */
export const BILLING_PLAN_CATALOGUE_LIMIT = 200;

/** The role section 9 gives plan creation to, and the only one it gives it to. */
export const BILLING_PLAN_ROLES = deepFreeze(["super_admin"] as const);

/** The chain entity and the one action this STEP writes. */
export const BILLING_PLAN_ENTITY = "plan";

export const BILLING_PLAN_AUDIT = deepFreeze({
  created: "billing.plan_created",
} as const);

/**
 * Every rule a refusal can name.
 *
 * One word per mistake, because the screen answers each with its own sentence and an operator who
 * typed a price of `19.999` should not be told the same thing as one who typed a name.
 */
export const BILLING_PLAN_RULES = deepFreeze({
  codeMalformed: "code_malformed",
  codeTaken: "code_taken",
  nameEmpty: "name_empty",
  nameTooLong: "name_too_long",
  priceMissing: "price_missing",
  priceNotWhole: "price_not_whole",
  priceNegative: "price_negative",
  priceTooLarge: "price_too_large",
  currencyMalformed: "currency_malformed",
  periodUnsupported: "period_unsupported",
  servicesEmpty: "services_empty",
  servicesTooMany: "services_too_many",
  serviceUnknown: "service_unknown",
  serviceDuplicated: "service_duplicated",
  sortOrderInvalid: "sort_order_invalid",
  publishInvalid: "publish_invalid",
  notWritten: "not_written",
} as const);

/**
 * A code from a name, or null when the name cannot produce one.
 *
 * The form shows the code it would create, and an operator may override it, because the code is what
 * code and invoices will quote for years: `Growth Yearly` becomes `growth-yearly`, three spaces
 * collapse into one separator, and a name that leaves fewer than two usable characters leaves the
 * field empty rather than inventing something an operator did not choose.
 */
export function planCodeFrom(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, BILLING_PLAN_CODE_MAXIMUM_LENGTH)
    .replace(/-+$/gu, "");

  return BILLING_PLAN_CODE_PATTERN.test(slug) && slug.length >= BILLING_PLAN_CODE_MINIMUM_LENGTH
    ? slug
    : null;
}

/**
 * What a plan costs in a month, as a display figure.
 *
 * A yearly plan is divided by twelve and **floored**, and that is the whole point of it being here
 * rather than in a screen: `Math.round` on money invites a total that does not add up, so this figure
 * is documented as a comparison aid that is never used to charge. `priceMinor` itself is what any
 * billing STEP must read.
 */
export function monthlyEquivalentMinor(priceMinor: number, period: BillingPlanPeriod): number {
  return period === "monthly" ? priceMinor : Math.floor(priceMinor / 12);
}
