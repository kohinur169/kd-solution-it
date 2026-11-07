// path: services/billing/plans.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import {
  BILLING_PLAN_AUDIT,
  BILLING_PLAN_CATALOGUE_LIMIT,
  BILLING_PLAN_CODE_MAXIMUM_LENGTH,
  BILLING_PLAN_CODE_MINIMUM_LENGTH,
  BILLING_PLAN_CODE_PATTERN,
  BILLING_PLAN_COLUMNS,
  BILLING_PLAN_CURRENCY_PATTERN,
  BILLING_PLAN_DEFAULT_CURRENCY,
  BILLING_PLAN_ENTITLEMENT_COLUMNS,
  BILLING_PLAN_ENTITLEMENT_TABLE,
  BILLING_PLAN_ENTITY,
  BILLING_PLAN_NAME_MAXIMUM_LENGTH,
  BILLING_PLAN_NAME_MINIMUM_LENGTH,
  BILLING_PLAN_PERIODS,
  BILLING_PLAN_PRICE_MAXIMUM_MINOR,
  BILLING_PLAN_ROLES,
  BILLING_PLAN_RULES,
  BILLING_PLAN_SERVICE_KEYS,
  BILLING_PLAN_SORT_ORDER_MAXIMUM,
  BILLING_PLAN_STATUSES,
  BILLING_PLAN_TABLE,
  isBillingPlanPeriod,
  isBillingPlanServiceKey,
  isBillingPlanStatus,
  monthlyEquivalentMinor,
  planStatusLabelKey,
  type BillingPlanPeriod,
  type BillingPlanServiceKey,
  type BillingPlanStatus,
} from "./plans-registry.ts";

/**
 * Section 9's first sentence: a super administrator creates a plan.
 *
 * > "super_admin creates plans: name, price, period and which services each plan includes."
 *
 * ## What a plan is, and what this file decides
 *
 * `0014_plans.sql` already says what a plan *is* - a code, a name, a price in minor units, a
 * currency, a period, a state, a sort order and a publication instant - and `0015` says what it
 * includes: one row per service, unique while the row is live. This file decides three things the
 * schema cannot:
 *
 *   1. **Who may write one.** `super_admin`, and nobody else. The role is checked here rather than in
 *      the route, so a second entry point cannot reach a weaker path than the screen.
 *   2. **What a good plan looks like.** A code that is a slug and not already reserved, a name that
 *      is not blank, a price that is a whole number of minor units inside a stated ceiling, a
 *      currency of three upper case letters, one of the two periods, at least one of the six services
 *      and no service twice. Every one of those is a **rule word** rather than a database error, so
 *      the screen can say what to fix.
 *   3. **That a plan is never half written.** A plan and its services are two inserts; if the second
 *      fails, the first is withdrawn rather than left as a plan that includes nothing. A plan with no
 *      services would be a plan a merchant could buy and use nothing of, which is exactly the state
 *      section 9's second sentence forbids.
 *
 * ## Why creation is a read-back, and why the answer is the whole catalogue
 *
 * The row's identifier defaults to `uuid_generate_v7()` in the database, so the insert returns the
 * representation and the service re-reads what it wrote. The answer to the caller is not that row
 * alone but the catalogue as it now stands: a screen that creates a plan has to show the list it
 * belongs to, and asking again would be a second round trip for a picture this call already holds.
 *
 * ## What this file does not do
 *
 * It does not publish, retire, edit or delete a plan, and it does not check an entitlement: section
 * 9's remaining sentences are STEP 213's, `0014`'s `published_at` is written once at creation here,
 * and a catalogue that can be created but not yet corrected is the smaller, safer half of the story.
 */

/** What the catalogue read needs, injected so the gate can drive it without a database. */
export interface PlanDependencies {
  readonly store: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
}

/** One plan as a screen shows it: its own four facts, its services, and its monthly comparison figure. */
export interface PlanView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly period: BillingPlanPeriod;
  readonly status: BillingPlanStatus;
  readonly statusLabelKey: string;
  readonly publishedAt: string | null;
  readonly sortOrder: number;
  readonly services: readonly BillingPlanServiceKey[];
  /** A comparison aid, floored, never a charge. See `monthlyEquivalentMinor`. */
  readonly monthlyEquivalentMinor: number;
  readonly createdAt: string;
}

/** The catalogue, and the vocabulary a creation form needs beside it. */
export interface PlanCatalogue {
  readonly plans: readonly PlanView[];
  readonly services: readonly BillingPlanServiceKey[];
  readonly periods: readonly BillingPlanPeriod[];
  readonly statuses: readonly BillingPlanStatus[];
  readonly defaultCurrency: string;
  readonly maximumPriceMinor: number;
  readonly maximumSortOrder: number;
  readonly readAtEpochMs: number;
  readonly canCreate: boolean;
}

/** One request to create a plan, already parsed and normalised by `parsePlanDraft`. */
export interface PlanDraft {
  readonly code: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly period: BillingPlanPeriod;
  readonly services: readonly BillingPlanServiceKey[];
  readonly sortOrder: number;
  readonly publish: boolean;
}

const planRowSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  price_minor: z.number().int(),
  currency: z.string(),
  period: z.string(),
  status: z.string(),
  published_at: z.string().nullable(),
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

type PlanRow = z.infer<typeof planRowSchema>;

const entitlementRowSchema = z.object({
  id: z.string().uuid(),
  plan_id: z.string().uuid(),
  service: z.string(),
  created_at: z.string(),
});

type EntitlementRow = z.infer<typeof entitlementRowSchema>;

/** A refusal that names the field and the rule, and never the value that failed. */
function refusal(code: "VALIDATION_FAILED" | "CONFLICT" | "INTERNAL_ERROR", field: string, rule: string): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

function textOf(body: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(body, key) ? body[key] : undefined;
}

/**
 * The services a request names: the six legal keys, at least one, none twice.
 *
 * A wrong key is refused by name and not by position, because an operator who typed `payments` needs
 * to be told that `payment_links` is the word the catalogue uses.
 */
function servicesOf(value: unknown): readonly BillingPlanServiceKey[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refusal("VALIDATION_FAILED", "services", BILLING_PLAN_RULES.servicesEmpty);
  }

  if (value.length > BILLING_PLAN_SERVICE_KEYS.length) {
    throw refusal("VALIDATION_FAILED", "services", BILLING_PLAN_RULES.servicesTooMany);
  }

  const chosen: BillingPlanServiceKey[] = [];

  for (const entry of value) {
    if (!isBillingPlanServiceKey(entry)) {
      throw refusal("VALIDATION_FAILED", "services", BILLING_PLAN_RULES.serviceUnknown);
    }

    if (chosen.includes(entry)) {
      throw refusal("VALIDATION_FAILED", "services", BILLING_PLAN_RULES.serviceDuplicated);
    }

    chosen.push(entry);
  }

  // The catalogue's own order rather than the order they were clicked: two plans with the same
  // services must read the same way.
  return BILLING_PLAN_SERVICE_KEYS.filter((service) => chosen.includes(service));
}

/**
 * One request body as a plan, or the rule that stops it.
 *
 * Every value is read by name and bounded before it is used, and the price is an **integer number of
 * minor units**: a decimal string belongs to the form that types it, and a service that accepted
 * `"19.99"` here would be a second place that decides what a price means.
 */
export function parsePlanDraft(body: unknown): PlanDraft {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw refusal("VALIDATION_FAILED", "plan", BILLING_PLAN_RULES.nameEmpty);
  }

  const fields = body as Readonly<Record<string, unknown>>;
  const rawCode = textOf(fields, "code");
  const code = typeof rawCode === "string" ? rawCode.trim() : "";

  if (
    code.length < BILLING_PLAN_CODE_MINIMUM_LENGTH ||
    code.length > BILLING_PLAN_CODE_MAXIMUM_LENGTH ||
    !BILLING_PLAN_CODE_PATTERN.test(code)
  ) {
    throw refusal("VALIDATION_FAILED", "code", BILLING_PLAN_RULES.codeMalformed);
  }

  const rawName = textOf(fields, "name");
  const name = typeof rawName === "string" ? rawName.trim() : "";

  if (name.length < BILLING_PLAN_NAME_MINIMUM_LENGTH) {
    throw refusal("VALIDATION_FAILED", "name", BILLING_PLAN_RULES.nameEmpty);
  }

  if (name.length > BILLING_PLAN_NAME_MAXIMUM_LENGTH) {
    throw refusal("VALIDATION_FAILED", "name", BILLING_PLAN_RULES.nameTooLong);
  }

  const rawPrice = textOf(fields, "priceMinor");

  if (rawPrice === undefined || rawPrice === null) {
    throw refusal("VALIDATION_FAILED", "priceMinor", BILLING_PLAN_RULES.priceMissing);
  }

  if (typeof rawPrice !== "number" || !Number.isFinite(rawPrice)) {
    throw refusal("VALIDATION_FAILED", "priceMinor", BILLING_PLAN_RULES.priceNotWhole);
  }

  if (!Number.isInteger(rawPrice)) {
    throw refusal("VALIDATION_FAILED", "priceMinor", BILLING_PLAN_RULES.priceNotWhole);
  }

  if (rawPrice < 0) {
    throw refusal("VALIDATION_FAILED", "priceMinor", BILLING_PLAN_RULES.priceNegative);
  }

  if (rawPrice > BILLING_PLAN_PRICE_MAXIMUM_MINOR) {
    throw refusal("VALIDATION_FAILED", "priceMinor", BILLING_PLAN_RULES.priceTooLarge);
  }

  const rawCurrency = textOf(fields, "currency");
  const currency =
    rawCurrency === undefined || rawCurrency === null
      ? BILLING_PLAN_DEFAULT_CURRENCY
      : typeof rawCurrency === "string"
        ? rawCurrency.trim().toUpperCase()
        : "";

  if (!BILLING_PLAN_CURRENCY_PATTERN.test(currency)) {
    throw refusal("VALIDATION_FAILED", "currency", BILLING_PLAN_RULES.currencyMalformed);
  }

  const rawPeriod = textOf(fields, "period");

  if (!isBillingPlanPeriod(rawPeriod)) {
    throw refusal("VALIDATION_FAILED", "period", BILLING_PLAN_RULES.periodUnsupported);
  }

  const rawSortOrder = textOf(fields, "sortOrder");
  const sortOrder = rawSortOrder === undefined || rawSortOrder === null ? 0 : rawSortOrder;

  if (
    typeof sortOrder !== "number" ||
    !Number.isInteger(sortOrder) ||
    sortOrder < 0 ||
    sortOrder > BILLING_PLAN_SORT_ORDER_MAXIMUM
  ) {
    throw refusal("VALIDATION_FAILED", "sortOrder", BILLING_PLAN_RULES.sortOrderInvalid);
  }

  const rawPublish = textOf(fields, "publish");
  const publish = rawPublish === undefined ? false : rawPublish;

  if (typeof publish !== "boolean") {
    throw refusal("VALIDATION_FAILED", "publish", BILLING_PLAN_RULES.publishInvalid);
  }

  return {
    code,
    name,
    priceMinor: rawPrice,
    currency,
    period: rawPeriod,
    services: servicesOf(textOf(fields, "services")),
    sortOrder,
    publish,
  };
}

/** The known service keys of one plan, in the catalogue's order, filtered from the rows it has. */
function servicesOfRows(rows: readonly EntitlementRow[]): readonly BillingPlanServiceKey[] {
  const present = rows.map((row) => row.service);

  return BILLING_PLAN_SERVICE_KEYS.filter(
    (service) => present.includes(service) && isBillingPlanServiceKey(service),
  );
}

/** One row and its services as a screen shows it, or null for a row this platform does not describe. */
function viewOf(row: PlanRow, services: readonly BillingPlanServiceKey[]): PlanView | null {
  if (!isBillingPlanStatus(row.status) || !isBillingPlanPeriod(row.period)) {
    return null;
  }

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    priceMinor: row.price_minor,
    currency: row.currency,
    period: row.period,
    status: row.status,
    statusLabelKey: planStatusLabelKey(row.status),
    publishedAt: row.published_at,
    sortOrder: row.sort_order,
    services,
    monthlyEquivalentMinor: monthlyEquivalentMinor(row.price_minor, row.period),
    createdAt: row.created_at,
  };
}

/**
 * The catalogue this account may see: every plan, in display order, with the services each includes.
 *
 * Two reads rather than a join, because PostgREST's embedded resources would put a second shape in
 * the answer; the services of up to two hundred plans are one `in.(...)` query, which is what an
 * office list is worth. A row whose stored status or period is outside `0014`'s vocabulary is
 * skipped rather than shown as an unknown word: the platform's own rows cannot be, and a row that is
 * is a fact about the database rather than a plan.
 */
async function catalogueOf(
  actor: RequestActor,
  dependencies: PlanDependencies,
): Promise<PlanCatalogue> {
  const rows = await dependencies.store.select(
    BILLING_PLAN_TABLE,
    `select=${BILLING_PLAN_COLUMNS}&deleted_at=is.null` +
      `&order=sort_order.asc,code.asc&limit=${String(BILLING_PLAN_CATALOGUE_LIMIT)}`,
    planRowSchema,
  );
  const ids = rows.map((row) => row.id);
  const entitlements =
    ids.length === 0
      ? []
      : await dependencies.store.select(
          BILLING_PLAN_ENTITLEMENT_TABLE,
          `select=${BILLING_PLAN_ENTITLEMENT_COLUMNS}` +
            `&plan_id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})` +
            "&deleted_at=is.null&order=service.asc&limit=1000",
          entitlementRowSchema,
        );
  const plans: PlanView[] = [];

  for (const row of rows) {
    const own = entitlements.filter((entitlement) => entitlement.plan_id === row.id);
    const view = viewOf(row, servicesOfRows(own));

    if (view !== null) {
      plans.push(view);
    }
  }

  return {
    plans,
    services: BILLING_PLAN_SERVICE_KEYS,
    periods: BILLING_PLAN_PERIODS,
    statuses: BILLING_PLAN_STATUSES,
    defaultCurrency: BILLING_PLAN_DEFAULT_CURRENCY,
    maximumPriceMinor: BILLING_PLAN_PRICE_MAXIMUM_MINOR,
    maximumSortOrder: BILLING_PLAN_SORT_ORDER_MAXIMUM,
    readAtEpochMs: dependencies.now(),
    canCreate: BILLING_PLAN_ROLES.some((role) => actor.roles.includes(role)),
  };
}

/** The catalogue, for the office screen and for the first read of a route. */
export async function listPlans(
  input: { readonly actor: RequestActor },
  dependencies: PlanDependencies,
): Promise<PlanCatalogue> {
  requireAnyRole(input.actor, BILLING_PLAN_ROLES);

  return catalogueOf(input.actor, dependencies);
}

/**
 * Create one plan, with its services, and answer the catalogue it now belongs to.
 *
 * The order is: who, what, taken, written, included, read back, recorded.
 *
 *   - **taken** is a read before the insert because `plans_code_key` is unique for ever: a code that
 *     once belonged to a deleted plan still answers `code_taken`, which is what "unique for ever"
 *     means. The insert's own `23505` is caught too, because two operators can pass the read at once.
 *   - **included** is the second insert. A failure there withdraws the plan rather than leaving a
 *     plan that includes nothing - the compensation is one soft delete, and the error is rethrown so
 *     the operator sees what happened.
 *   - **read back** is not ceremony: the identifier and the timestamps are the database's, and a
 *     screen that showed values the caller guessed would be a screen that could disagree with the row.
 */
export async function createPlan(
  input: { readonly actor: RequestActor; readonly body: unknown; readonly clientAddress: string | null },
  dependencies: PlanDependencies,
): Promise<PlanCatalogue> {
  requireAnyRole(input.actor, BILLING_PLAN_ROLES);

  const draft = parsePlanDraft(input.body);
  const existing = await dependencies.store.select(
    BILLING_PLAN_TABLE,
    `select=id,code&code=eq.${encodeURIComponent(draft.code)}&limit=1`,
    z.object({ id: z.string().uuid(), code: z.string() }),
  );

  if (existing.length > 0) {
    throw refusal("CONFLICT", "code", BILLING_PLAN_RULES.codeTaken);
  }

  const instant = new Date(dependencies.now()).toISOString();
  let plan: PlanRow;

  try {
    const inserted = await dependencies.store.insertReturning(
      BILLING_PLAN_TABLE,
      [
        {
          company_id: null,
          code: draft.code,
          name: draft.name,
          price_minor: draft.priceMinor,
          currency: draft.currency,
          period: draft.period,
          status: draft.publish ? "active" : "draft",
          published_at: draft.publish ? instant : null,
          sort_order: draft.sortOrder,
        },
      ],
      planRowSchema,
    );

    const row = inserted[0];

    if (row === undefined) {
      throw refusal("INTERNAL_ERROR", "plan", BILLING_PLAN_RULES.notWritten);
    }

    plan = row;
  } catch (error) {
    // Two operators, one code, one winner: the loser is told the code is taken rather than that the
    // platform broke. Every other failure keeps its own meaning.
    if (error instanceof AppError && error.code === "CONFLICT") {
      throw refusal("CONFLICT", "code", BILLING_PLAN_RULES.codeTaken);
    }

    throw error;
  }

  try {
    await dependencies.store.insert(
      BILLING_PLAN_ENTITLEMENT_TABLE,
      draft.services.map((service) => ({
        company_id: null,
        plan_id: plan.id,
        service,
      })),
    );
  } catch (error) {
    // A plan that includes nothing must not exist. The withdrawal is best effort: if it fails too,
    // the operator is told the plan was not written, and the chain entry below never happens.
    try {
      await dependencies.store.update(
        BILLING_PLAN_TABLE,
        `id=eq.${encodeURIComponent(plan.id)}&deleted_at=is.null`,
        { deleted_at: instant },
      );
    } catch {
      // The refusal below is the answer either way; a compensation that failed is logged by the
      // dependency's own failure, not swallowed into a success.
    }

    throw error;
  }

  await dependencies.audit.append({
    action: BILLING_PLAN_AUDIT.created,
    actorUserId: input.actor.userId,
    entityType: BILLING_PLAN_ENTITY,
    entityId: plan.id,
    companyId: null,
    sessionId: input.actor.sessionId,
    ipAddress: input.clientAddress,
    payload: {
      code: plan.code,
      name: plan.name,
      price_minor: plan.price_minor,
      currency: plan.currency,
      period: plan.period,
      status: plan.status,
      published_at: plan.published_at,
      sort_order: plan.sort_order,
      services: draft.services,
    },
  });

  return catalogueOf(input.actor, dependencies);
}
