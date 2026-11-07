// path: services/billing/plans-verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { ZodType } from "zod";
import { createInMemoryAuditTrail, type AuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { getMessage, type MessagePath } from "../../lib/i18n/messages.ts";
import {
  BILLING_PLAN_AUDIT,
  BILLING_PLAN_CATALOGUE_LIMIT,
  BILLING_PLAN_CODE_MAXIMUM_LENGTH,
  BILLING_PLAN_CODE_PATTERN,
  BILLING_PLAN_CURRENCY_PATTERN,
  BILLING_PLAN_DEFAULT_CURRENCY,
  BILLING_PLAN_ENTITY,
  BILLING_PLAN_NAME_MAXIMUM_LENGTH,
  BILLING_PLAN_PERIODS,
  BILLING_PLAN_PRICE_MAXIMUM_MINOR,
  BILLING_PLAN_ROLES,
  BILLING_PLAN_RULES,
  BILLING_PLAN_SERVICE_KEYS,
  BILLING_PLAN_SORT_ORDER_MAXIMUM,
  BILLING_PLAN_STATUSES,
  BILLING_PLAN_TABLE,
  BILLING_PLAN_ENTITLEMENT_TABLE,
  monthlyEquivalentMinor,
  planCodeFrom,
  planPeriodLabelKey,
  planServiceLabelKey,
  planStatusLabelKey,
} from "./plans-registry.ts";
import { createPlan, listPlans, parsePlanDraft, type PlanCatalogue } from "./plans.ts";

/**
 * The gate for STEP 212: section 9's plan creation.
 *
 * ## What this proves
 *
 *   - **No migration.** `0014_plans.sql` and `0015_plan_entitlements.sql` already say what a plan is
 *     and what it includes; this STEP writes rows, not tables, and the next free number is still 129.
 *   - **The vocabulary is the schema's.** The code pattern, the two periods, the three states, the
 *     name's ceiling and the currency's shape are compared against `0014`'s own check constraints
 *     rather than asserted into the void, so a migration that changed one without the other fails
 *     here.
 *   - **A refusal names a field and a rule.** Sixteen of them, each proved by value.
 *   - **Only `super_admin` creates a plan**, at the service (which is where the route's only check
 *     lives) and on the screen.
 *   - **A plan is never half written.** An entitlement insert that fails withdraws the plan, the
 *     error is rethrown, and no chain entry claims otherwise.
 *   - **The screen's rule vocabulary covers the service's**, and every label it prints exists in the
 *     string catalog.
 */

let checkCount = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(
    Object.is(actual, expected),
    `${description} (expected ${String(expected)}, got ${String(actual)})`,
  );
}

interface Refusal {
  readonly code: string;
  readonly status: number;
  readonly field: string | null;
  readonly rule: string | null;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) {
      return {
        code: error.code,
        status: error.status,
        field: error.details[0]?.field ?? null,
        rule: error.details[0]?.rule ?? null,
      };
    }

    return { code: "not-an-app-error", status: 0, field: null, rule: null };
  }

  return { code: "no-refusal", status: 0, field: null, rule: null };
}

async function sourceOf(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

const startedAt = Date.UTC(2026, 10, 7, 9, 30, 0);
const superAdminId = "0192f0a1-7c3d-7000-8000-000000000001";
const ownerId = "0192f0a1-7c3d-7000-8000-000000000002";

function actorOf(roles: RequestActor["roles"]): RequestActor {
  return {
    userId: roles.includes("super_admin") ? superAdminId : ownerId,
    sessionId: "0192f0a1-7c3d-7000-8000-000000000003",
    companyId: null,
    email: "operator@example.com",
    displayName: "Operator",
    roles,
    accountStatus: "active",
    twoFactorSatisfied: true,
    reauthenticatedAtEpochMs: startedAt,
    sessionStartedAtEpochMs: startedAt,
    permissions: [],
  } as unknown as RequestActor;
}

const superAdmin = actorOf(["super_admin"]);
const owner = actorOf(["owner"]);

// ------------------------------------------------------------------ 1. no migration, and the schema agrees

const migrationFiles = (await readdir(new URL("../../migrations/", import.meta.url))).filter(
  (name) => name.endsWith(".sql") && !name.endsWith(".down.sql"),
);

expectEqual(migrationFiles.length, 128, "no migration: the next free number is still 129");
expectEqual(
  migrationFiles.filter((name) => name.includes("plan") || name.includes("billing")).length,
  2,
  "and the only two plan migrations are the schema block's own",
);

const plansSql = await sourceOf("migrations/0014_plans.sql");
const entitlementsSql = await sourceOf("migrations/0015_plan_entitlements.sql");

expect(plansSql.includes("create table public.plans"), "0014 still creates the plan table");
expect(
  entitlementsSql.includes("create table public.plan_entitlements"),
  "and 0015 still creates the table a plan's services live in",
);
expect(
  plansSql.includes("code ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(code) between 2 and 39"),
  "the code's pattern and bounds are the schema's, pinned in its own words",
);
expectEqual(`${BILLING_PLAN_CODE_PATTERN.source}`, "^[a-z][a-z0-9]*(-[a-z0-9]+)*$", "and the registry repeats it exactly");
expectEqual(BILLING_PLAN_CODE_MAXIMUM_LENGTH, 39, "with the same ceiling");
expect(
  plansSql.includes("char_length(name) between 1 and 80"),
  "the name's bounds are the schema's",
);
expectEqual(BILLING_PLAN_NAME_MAXIMUM_LENGTH, 80, "and the registry's name ceiling matches");
expect(plansSql.includes("price_minor >= 0"), "the price is never negative, as the schema requires");
expect(plansSql.includes("currency ~ '^[A-Z]{3}$'"), "the currency is three upper case letters");
expectEqual(BILLING_PLAN_CURRENCY_PATTERN.source, "^[A-Z]{3}$", "and the registry repeats that pattern");
expect(plansSql.includes("period in ('monthly', 'yearly')"), "the two periods are the schema's");
expectEqual(BILLING_PLAN_PERIODS.join(","), "monthly,yearly", "and the registry names the same two, in order");
expect(plansSql.includes("status in ('draft', 'active', 'retired')"), "the three states are the schema's");
expectEqual(BILLING_PLAN_STATUSES.join(","), "draft,active,retired", "and the registry names the same three");
expect(
  entitlementsSql.includes("service ~ '^[a-z][a-z0-9_]*$'"),
  "a service key is a lower snake word, and the registry's six are",
);
expect(
  BILLING_PLAN_SERVICE_KEYS.every((service) => /^[a-z][a-z0-9_]*$/u.test(service)),
  "each of the six services satisfies the schema's own pattern",
);
const entitlementsComment = entitlementsSql
  .split("\n")
  .filter((line) => line.trimStart().startsWith("--"))
  .map((line) => line.replace(/^\s*--\s?/u, ""))
  .join(" ")
  .replace(/\s+/gu, " ");

expect(
  entitlementsComment.includes(
    "invoicing, payment_links, recurring_invoices, public_api, store_connections and test_mode",
  ),
  "and 0015 names the same six keys section 9 does",
);
expectEqual(BILLING_PLAN_TABLE, "plans", "the table is spelled once");
expectEqual(BILLING_PLAN_ENTITLEMENT_TABLE, "plan_entitlements", "and so is the second");

// ------------------------------------------------------------------ 2. the registry's own decisions

expectEqual(BILLING_PLAN_ROLES.join(","), "super_admin", "section 9 gives plan creation to super_admin alone");
expectEqual(BILLING_PLAN_AUDIT.created, "billing.plan_created", "the chain action, pinned");
expectEqual(BILLING_PLAN_ENTITY, "plan", "and the entity the entry names");
expectEqual(
  Object.values(BILLING_PLAN_RULES).join(","),
  "code_malformed,code_taken,name_empty,name_too_long,price_missing,price_not_whole,price_negative," +
    "price_too_large,currency_malformed,period_unsupported,services_empty,services_too_many,service_unknown," +
    "service_duplicated,sort_order_invalid,publish_invalid,not_written",
  "the rule words are the wire vocabulary the screen answers, pinned as words rather than as constants",
);
expectEqual(BILLING_PLAN_DEFAULT_CURRENCY, "USD", "the default currency is the platform's own");
expectEqual(BILLING_PLAN_PRICE_MAXIMUM_MINOR, 100_000_000, "the price ceiling is a decision, pinned");
expectEqual(BILLING_PLAN_SORT_ORDER_MAXIMUM, 9_999, "and so is the display order's");
expectEqual(BILLING_PLAN_CATALOGUE_LIMIT, 200, "and the catalogue's bound");

expectEqual(planCodeFrom("Growth Yearly"), "growth-yearly", "a name becomes a slug");
expectEqual(planCodeFrom("  Starter  "), "starter", "trimmed");
expectEqual(planCodeFrom("Pro"), "pro", "and a short name is still a code");
expectEqual(planCodeFrom("!!!"), null, "a name with no usable character proposes nothing");
expectEqual(planCodeFrom("a"), null, "and a one letter name is below the schema's floor");
expectEqual(monthlyEquivalentMinor(1999, "monthly"), 1999, "a monthly plan's monthly figure is its price");
expectEqual(monthlyEquivalentMinor(12000, "yearly"), 1000, "a yearly plan is divided by twelve");
expectEqual(monthlyEquivalentMinor(10007, "yearly"), 833, "and floored rather than rounded up");
expectEqual(monthlyEquivalentMinor(24000, "yearly"), 2000, "an exact division is unchanged");

// ------------------------------------------------------------------ 3. what a good plan looks like

const validBody = {
  code: "growth-yearly",
  name: "Growth, yearly",
  priceMinor: 19900,
  currency: "eur",
  period: "yearly",
  services: ["public_api", "invoicing"],
  sortOrder: 2,
  publish: true,
};

const draft = parsePlanDraft(validBody);

expectEqual(draft.code, "growth-yearly", "a valid draft keeps its code");
expectEqual(draft.currency, "EUR", "its currency is upper cased");
expectEqual(draft.priceMinor, 19900, "its price is minor units, unchanged");
expectEqual(draft.period, "yearly", "its period is one of the two");
expectEqual(draft.services.join(","), "invoicing,public_api", "and its services are in the catalogue's order, not the form's");
expectEqual(draft.publish, true, "publishing is carried");

const minimal = parsePlanDraft({ code: "pro", name: "Pro", priceMinor: 0, period: "monthly", services: ["test_mode"] });

expectEqual(minimal.currency, "USD", "a missing currency is the platform's");
expectEqual(minimal.sortOrder, 0, "a missing sort order is zero");
expectEqual(minimal.publish, false, "and a plan is a draft unless it says otherwise");

interface Case {
  readonly description: string;
  readonly body: unknown;
  readonly field: string;
  readonly rule: string;
}

const cases: readonly Case[] = [
  { description: "a body that is not an object", body: [], field: "plan", rule: BILLING_PLAN_RULES.nameEmpty },
  { description: "a code in capitals", body: { ...validBody, code: "Growth" }, field: "code", rule: BILLING_PLAN_RULES.codeMalformed },
  { description: "a code with an underscore", body: { ...validBody, code: "growth_yearly" }, field: "code", rule: BILLING_PLAN_RULES.codeMalformed },
  { description: "a one letter code", body: { ...validBody, code: "g" }, field: "code", rule: BILLING_PLAN_RULES.codeMalformed },
  { description: "a code past thirty-nine characters", body: { ...validBody, code: `g${"a".repeat(39)}` }, field: "code", rule: BILLING_PLAN_RULES.codeMalformed },
  { description: "a blank name", body: { ...validBody, name: "   " }, field: "name", rule: BILLING_PLAN_RULES.nameEmpty },
  { description: "a name past eighty characters", body: { ...validBody, name: "a".repeat(81) }, field: "name", rule: BILLING_PLAN_RULES.nameTooLong },
  { description: "a missing price", body: { ...validBody, priceMinor: undefined }, field: "priceMinor", rule: BILLING_PLAN_RULES.priceMissing },
  { description: "a price as a string", body: { ...validBody, priceMinor: "1999" }, field: "priceMinor", rule: BILLING_PLAN_RULES.priceNotWhole },
  { description: "a price with a fraction of a minor unit", body: { ...validBody, priceMinor: 19.99 }, field: "priceMinor", rule: BILLING_PLAN_RULES.priceNotWhole },
  { description: "a negative price", body: { ...validBody, priceMinor: -1 }, field: "priceMinor", rule: BILLING_PLAN_RULES.priceNegative },
  { description: "a price past the ceiling", body: { ...validBody, priceMinor: 100_000_001 }, field: "priceMinor", rule: BILLING_PLAN_RULES.priceTooLarge },
  { description: "a currency of two letters", body: { ...validBody, currency: "EU" }, field: "currency", rule: BILLING_PLAN_RULES.currencyMalformed },
  { description: "a period outside the two", body: { ...validBody, period: "weekly" }, field: "period", rule: BILLING_PLAN_RULES.periodUnsupported },
  { description: "no services", body: { ...validBody, services: [] }, field: "services", rule: BILLING_PLAN_RULES.servicesEmpty },
  { description: "a service outside the six", body: { ...validBody, services: ["payments"] }, field: "services", rule: BILLING_PLAN_RULES.serviceUnknown },
  { description: "a service twice", body: { ...validBody, services: ["invoicing", "invoicing"] }, field: "services", rule: BILLING_PLAN_RULES.serviceDuplicated },
  { description: "a negative sort order", body: { ...validBody, sortOrder: -1 }, field: "sortOrder", rule: BILLING_PLAN_RULES.sortOrderInvalid },
  { description: "publishing as a string", body: { ...validBody, publish: "yes" }, field: "publish", rule: BILLING_PLAN_RULES.publishInvalid },
];

for (const entry of cases) {
  const refusal = await refusalOf(async () => parsePlanDraft(entry.body));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${entry.description}: refused as validation`);
  expectEqual(refusal.field, entry.field, `${entry.description}: naming its field`);
  expectEqual(refusal.rule, entry.rule, `${entry.description}: and its rule`);
}

// ------------------------------------------------------------------ 4. the catalogue, over a fixture

type Row = Record<string, unknown>;

interface Fixture {
  readonly store: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: { plans: Row[]; entitlements: Row[] };
  readonly queries: string[];
  readonly inserted: { table: string; rows: readonly Row[] }[];
  readonly updated: { table: string; query: string; values: Row }[];
  readonly opened: string[];
  failOn: "none" | "conflict" | "entitlement" | "empty" | "audit";
}

function matches(row: Row, query: string): boolean {
  for (const part of query.split("&")) {
    const index = part.indexOf("=");

    if (index < 0) {
      continue;
    }

    const key = part.slice(0, index);
    const value = part.slice(index + 1);

    if (key === "select" || key === "order" || key === "limit") {
      continue;
    }

    if (value.startsWith("in.(")) {
      const allowed = value.slice(4, -1).split(",").map((entry) => decodeURIComponent(entry));

      if (!allowed.includes(String(row[key]))) {
        return false;
      }

      continue;
    }

    if (value === "is.null") {
      if (row[key] !== null && row[key] !== undefined) {
        return false;
      }

      continue;
    }

    if (value.startsWith("eq.") && String(row[key]) !== decodeURIComponent(value.slice(3))) {
      return false;
    }
  }

  return true;
}

const planRow: Row = {
  id: "0192f0a1-7c3d-7000-8000-000000000011",
  code: "starter",
  name: "Starter",
  price_minor: 999,
  currency: "USD",
  period: "monthly",
  status: "active",
  published_at: new Date(startedAt).toISOString(),
  sort_order: 1,
  created_at: new Date(startedAt).toISOString(),
  updated_at: new Date(startedAt).toISOString(),
};

function createFixture(options: { plans?: readonly Row[]; entitlements?: readonly Row[] } = {}): Fixture {
  const state: Fixture["state"] = {
    plans: [...(options.plans ?? [planRow])],
    entitlements: [
      ...(options.entitlements ?? [
        {
          id: "0192f0a1-7c3d-7000-8000-000000000012",
          plan_id: planRow["id"],
          service: "invoicing",
          created_at: new Date(startedAt).toISOString(),
        },
      ]),
    ],
  };
  const queries: string[] = [];
  const inserted: { table: string; rows: readonly Row[] }[] = [];
  const updated: { table: string; query: string; values: Row }[] = [];
  const opened: string[] = [];
  const audit = createInMemoryAuditTrail();

  const fixture: Fixture = {
    state,
    queries,
    inserted,
    updated,
    opened,
    audit,
    failOn: "none",
    store: {
      async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
        queries.push(`${table}?${query}`);

        const rows = table === BILLING_PLAN_TABLE ? state.plans : table === BILLING_PLAN_ENTITLEMENT_TABLE ? state.entitlements : null;

        if (rows === null) {
          throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
        }

        const limit = Number.parseInt(/limit=([0-9]+)/u.exec(query)?.[1] ?? "50", 10);

        return rows
          .filter((row) => matches(row, query))
          .slice(0, Number.isFinite(limit) ? limit : 50)
          .map((row) => schema.parse(row));
      },

      async insert(table: string, rows: readonly Row[]): Promise<void> {
        inserted.push({ table, rows });

        if (table === BILLING_PLAN_ENTITLEMENT_TABLE && fixture.failOn === "entitlement") {
          throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "write_failed" } });
        }

        if (table === BILLING_PLAN_ENTITLEMENT_TABLE) {
          state.entitlements.push(
            ...rows.map((row, index) => ({
              ...row,
              id: `0192f0a1-7c3d-7000-8000-${String(100 + index).padStart(12, "0")}`,
              created_at: new Date(startedAt).toISOString(),
            })),
          );
        }
      },

      async insertReturning<TRow>(
        table: string,
        rows: readonly Row[],
        schema: ZodType<TRow>,
      ): Promise<readonly TRow[]> {
        inserted.push({ table, rows });

        if (fixture.failOn === "conflict") {
          throw new AppError("CONFLICT");
        }

        if (fixture.failOn === "empty") {
          return [];
        }

        const written = {
          ...rows[0],
          id: "0192f0a1-7c3d-7000-8000-000000000021",
          created_at: new Date(startedAt).toISOString(),
          updated_at: new Date(startedAt).toISOString(),
        };

        state.plans.push(written);

        return [schema.parse(written)];
      },

      async update(table: string, query: string, values: Row): Promise<void> {
        updated.push({ table, query, values });

        for (const row of state.plans) {
          if (table === BILLING_PLAN_TABLE && matches(row, query)) {
            Object.assign(row, values);
          }
        }
      },

      rpc: async (): Promise<unknown> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_calls_no_function" } });
      },
    },
  };

  return fixture;
}

function dependenciesOf(fixture: Fixture): { store: RestClient; audit: AuditTrail; now: () => number } {
  return {
    store: fixture.store,
    now: (): number => startedAt,
    audit:
      fixture.failOn === "audit"
        ? {
            append: async (): Promise<void> => {
              throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "chain_unreachable" } });
            },
          }
        : fixture.audit,
  };
}

const forbidden = await refusalOf(async () =>
  listPlans({ actor: owner }, dependenciesOf(createFixture())),
);

expectEqual(forbidden.code, "PERMISSION_DENIED", "a merchant owner cannot read the plan catalogue");
expectEqual(forbidden.status, 403, "which is a 403");

const forbiddenCreate = await refusalOf(async () =>
  createPlan({ actor: owner, body: validBody, clientAddress: null }, dependenciesOf(createFixture())),
);

expectEqual(forbiddenCreate.code, "PERMISSION_DENIED", "and cannot create one either");

const readable = await listPlans({ actor: superAdmin }, dependenciesOf(createFixture()));

expectEqual(readable.plans.length, 1, "a super administrator reads the catalogue");
expectEqual(readable.plans[0]?.code, "starter", "with the plan's code");
expectEqual(readable.plans[0]?.services.join(","), "invoicing", "and its services");
expectEqual(readable.plans[0]?.monthlyEquivalentMinor, 999, "with its monthly figure");
expectEqual(readable.services.join(","), BILLING_PLAN_SERVICE_KEYS.join(","), "and the six services a form chooses from");
expectEqual(readable.periods.join(","), "monthly,yearly", "the two periods");
expectEqual(readable.canCreate, true, "and this account may create");
expectEqual(readable.readAtEpochMs, startedAt, "read at the injected instant");

const readableFixture = createFixture();
const planQuery = (await listPlans({ actor: superAdmin }, dependenciesOf(readableFixture))).plans.length === 1
  ? readableFixture.queries[0] ?? ""
  : "";

expect(planQuery.includes("select=id,code,name,price_minor,currency,period,status,published_at,sort_order,created_at,updated_at"), "the columns are named, never starred");
expect(planQuery.includes("&deleted_at=is.null"), "a withdrawn plan is not in the catalogue");
expect(planQuery.includes("&order=sort_order.asc,code.asc"), "and the order is display order then code");
expectEqual(
  readableFixture.queries[1]?.includes(`plan_id=in.(${String(planRow["id"])})`),
  true,
  "the services are one query for the whole page",
);

const emptyFixture = createFixture({ plans: [] });
const empty = await listPlans({ actor: superAdmin }, dependenciesOf(emptyFixture));

expectEqual(empty.plans.length, 0, "an empty catalogue is an empty list");
expectEqual(emptyFixture.queries.length, 1, "and costs one query rather than two");

const unknownStatusFixture = createFixture({ plans: [{ ...planRow, status: "grandfathered" }] });

expectEqual(
  (await listPlans({ actor: superAdmin }, dependenciesOf(unknownStatusFixture))).plans.length,
  0,
  "a row outside the schema's three states is skipped rather than shown as an unknown word",
);

const strayServiceFixture = createFixture({
  entitlements: [
    {
      id: "0192f0a1-7c3d-7000-8000-000000000013",
      plan_id: planRow["id"],
      service: "teleportation",
      created_at: new Date(startedAt).toISOString(),
    },
  ],
});

expectEqual(
  (await listPlans({ actor: superAdmin }, dependenciesOf(strayServiceFixture))).plans[0]?.services.length,
  0,
  "a service outside the six is not in the catalogue a plan's page shows",
);

// ------------------------------------------------------------------ 5. creation

const createdFixture = createFixture({ plans: [] });
const created = await createPlan(
  { actor: superAdmin, body: validBody, clientAddress: "203.0.113.9" },
  dependenciesOf(createdFixture),
);

const planInsert = createdFixture.inserted.find((entry) => entry.table === BILLING_PLAN_TABLE);
const planValues = planInsert?.rows[0] ?? {};

expectEqual(created.plans.length, 1, "a plan is created and answered in the catalogue");
expectEqual(planValues["code"], "growth-yearly", "the row carries the code");
expectEqual(planValues["name"], "Growth, yearly", "and the name");
expectEqual(planValues["price_minor"], 19900, "and the price in minor units");
expectEqual(planValues["currency"], "EUR", "and the currency, upper cased");
expectEqual(planValues["period"], "yearly", "and the period");
expectEqual(planValues["status"], "active", "a published plan is active at once");
expectEqual(planValues["published_at"], new Date(startedAt).toISOString(), "at the injected instant");
expectEqual(planValues["sort_order"], 2, "with its display order");
expectEqual(planValues["company_id"], null, "and no tenant, because a plan is the platform's");

const entitlementInsert = createdFixture.inserted.find((entry) => entry.table === BILLING_PLAN_ENTITLEMENT_TABLE);

expectEqual(entitlementInsert?.rows.length, 2, "one row per service");
expectEqual(
  entitlementInsert?.rows.map((row) => String(row["service"])).join(","),
  "invoicing,public_api",
  "in the catalogue's order",
);
expectEqual(entitlementInsert?.rows[0]?.["plan_id"], "0192f0a1-7c3d-7000-8000-000000000021", "each naming the plan");

expectEqual(created.plans[0]?.services.join(","), "invoicing,public_api", "and the answer reads them back");
expectEqual(created.plans[0]?.status, "active", "with the status the row holds");

const draftFixture = createFixture({ plans: [] });

await createPlan(
  { actor: superAdmin, body: { ...validBody, publish: false }, clientAddress: null },
  dependenciesOf(draftFixture),
);

const draftValues = draftFixture.inserted[0]?.rows[0] ?? {};

expectEqual(draftValues["status"], "draft", "an unpublished plan is a draft");
expectEqual(draftValues["published_at"], null, "with no publication instant");

const chain = createdFixture.audit.entries[0] ?? null;

expectEqual(chain?.action, BILLING_PLAN_AUDIT.created, "the creation is in the chain");
expectEqual(chain?.actorUserId, superAdminId, "against the account that wrote it");
expectEqual(chain?.entityType, BILLING_PLAN_ENTITY, "naming a plan");
expectEqual(chain?.companyId, null, "on the platform chain");
expectEqual(chain?.payload["code"], "growth-yearly", "with the code");
expectEqual(chain?.payload["price_minor"], 19900, "and the price");
expectEqual((chain?.payload["services"] as readonly string[]).join(","), "invoicing,public_api", "and the services");
expectEqual(createdFixture.audit.entries.length, 1, "one entry, not two");

const takenFixture = createFixture();
const taken = await refusalOf(async () =>
  createPlan({ actor: superAdmin, body: { ...validBody, code: "starter" }, clientAddress: null }, dependenciesOf(takenFixture)),
);

expectEqual(taken.code, "CONFLICT", "a code that already exists is a conflict");
expectEqual(taken.rule, BILLING_PLAN_RULES.codeTaken, "named as taken");
expectEqual(takenFixture.inserted.length, 0, "and nothing is inserted");

const racedFixture = createFixture({ plans: [] });

racedFixture.failOn = "conflict";

const raced = await refusalOf(async () =>
  createPlan({ actor: superAdmin, body: validBody, clientAddress: null }, dependenciesOf(racedFixture)),
);

expectEqual(raced.code, "CONFLICT", "two operators passing the read at once");
expectEqual(raced.rule, BILLING_PLAN_RULES.codeTaken, "are told the code is taken, not that the platform broke");

const halfWrittenFixture = createFixture({ plans: [] });

halfWrittenFixture.failOn = "entitlement";

const halfWritten = await refusalOf(async () =>
  createPlan({ actor: superAdmin, body: validBody, clientAddress: null }, dependenciesOf(halfWrittenFixture)),
);

expectEqual(halfWritten.code, "DEPENDENCY_FAILED", "a plan whose services cannot be written is refused");
expectEqual(halfWrittenFixture.updated.length, 1, "and the plan is withdrawn rather than left empty");
expectEqual(halfWrittenFixture.updated[0]?.values["deleted_at"], new Date(startedAt).toISOString(), "at the injected instant");
expectEqual(halfWrittenFixture.audit.entries.length, 0, "with no chain entry claiming it exists");

const notWrittenFixture = createFixture({ plans: [] });

notWrittenFixture.failOn = "empty";

const notWritten = await refusalOf(async () =>
  createPlan({ actor: superAdmin, body: validBody, clientAddress: null }, dependenciesOf(notWrittenFixture)),
);

expectEqual(notWritten.code, "INTERNAL_ERROR", "an insert that answers no row is a platform fault");
expectEqual(notWritten.rule, BILLING_PLAN_RULES.notWritten, "named as not written");

const deafChainFixture = createFixture({ plans: [] });

deafChainFixture.failOn = "audit";

const deafChain = await refusalOf(async () =>
  createPlan({ actor: superAdmin, body: validBody, clientAddress: null }, dependenciesOf(deafChainFixture)),
);

expectEqual(deafChain.code, "DEPENDENCY_FAILED", "a chain that cannot be written is an outage the operator sees");
expectEqual(deafChainFixture.state.plans.length, 1, "even though the row exists, which is the honest pair of facts");

// ------------------------------------------------------------------ 6. the screen, the route, and the words

const routeSource = await sourceOf("app/api/office/plans/route.ts");
const pageSource = await sourceOf("app/(admin)/plans/page.tsx");
const consoleSource = await sourceOf("app/(admin)/plans/plans-console.tsx");
const navigationSource = await sourceOf("components/office/navigation.ts");

expect(routeSource.includes("requireCsrfToken(request"), "the write requires a CSRF token");
expect(routeSource.includes("maximumBodyBytes = 8_192"), "and bounds the body at eight kilobytes");
expect(routeSource.includes("verifySensitiveRequest({ request, bodyText, actor }"), "and proves the device over the exact bytes");
expect(routeSource.includes("await createPlan("), "then calls the service");
expect(!routeSource.includes("BILLING_PLAN_ROLES[0] === \"super_admin\" ?"), "and decides nothing about the role itself");
expect(
  routeSource.includes("const catalogue = await listPlans({ actor }, getPlanRuntime());"),
  "the read goes through the service too",
);
expect(pageSource.includes("BILLING_PLAN_ROLES.some((role) => actor.roles.includes(role))"), "the page asks the role itself");
expect(pageSource.includes("<PlansConsole catalogue={state.catalogue} />"), "and renders the catalogue it read");
expect(pageSource.includes("getMessage(\"officePlans.forbidden\")"), "with a sentence for the account that may not see it");

expect(consoleSource.includes("whole * 100 + Number.parseInt(fraction"), "the price is converted from its digits, never a float");
expect(!consoleSource.includes("Math.round"), "and never rounded");
expect(consoleSource.includes("planCodeFrom(name)"), "the code is proposed from the name");
expect(consoleSource.includes("deviceProofHeaders(\"POST\", path, body)"), "the write is proved by the device");
expect(consoleSource.includes("await csrfHeaders()"), "and carries the CSRF header");
expect(
  (consoleSource.match(/<label/gu) ?? []).length >= (consoleSource.match(/<input/gu) ?? []).length - 3,
  "every field the form draws has a label",
);
expect(
  navigationSource.includes('href: "/plans"') && navigationSource.includes("roles: BILLING_PLAN_ROLES"),
  "the office shell offers the screen to the one role that may use it",
);

expect(
  consoleSource.includes("grid gap-4 sm:grid-cols-2"),
  "the form is one column on a phone and two from the small breakpoint up",
);
expect(consoleSource.includes("flex flex-wrap items-center"), "and a plan's header wraps rather than overflowing");
expect(!/w-\[\d{3,}px\]/u.test(consoleSource), "with no fixed pixel width a narrow screen would clip");
expect(consoleSource.includes("inputMode=\"decimal\""), "and a phone offers a decimal keyboard for the price");

const ruleNames = Object.keys(BILLING_PLAN_RULES);
const screenMappings = [
  ...consoleSource.matchAll(/\[BILLING_PLAN_RULES\.([a-zA-Z]+)\]:\s*"([^"]+)"/gu),
].map((match) => ({ name: match[1] ?? "", path: match[2] ?? "" }));

expectEqual(ruleNames.length, 17, "the service names seventeen rules, each a different mistake");
expectEqual(
  screenMappings.length,
  17,
  "and the screen maps every one of them to a sentence rather than printing the word",
);

for (const name of ruleNames) {
  expect(
    screenMappings.some((mapping) => mapping.name === name),
    `the screen answers the ${name} rule`,
  );
}

for (const mapping of screenMappings) {
  expect(getMessage(mapping.path as MessagePath).length > 0, `and its sentence ${mapping.path} exists`);
}

expectEqual(
  Object.values(BILLING_PLAN_RULES).length,
  new Set(Object.values(BILLING_PLAN_RULES)).size,
  "no two rules share a word",
);

for (const status of BILLING_PLAN_STATUSES) {
  expect(getMessage(planStatusLabelKey(status)).length > 0, `the ${status} state has a sentence`);
}

for (const period of BILLING_PLAN_PERIODS) {
  expect(getMessage(planPeriodLabelKey(period)).length > 0, `the ${period} period has a sentence`);
}

for (const service of BILLING_PLAN_SERVICE_KEYS) {
  expect(getMessage(planServiceLabelKey(service)).length > 0, `the ${service} service has a sentence`);
}

const statusLabels = BILLING_PLAN_STATUSES.map((status) => getMessage(planStatusLabelKey(status)));
const periodLabels = BILLING_PLAN_PERIODS.map((period) => getMessage(planPeriodLabelKey(period)));
const serviceLabels = BILLING_PLAN_SERVICE_KEYS.map((service) => getMessage(planServiceLabelKey(service)));

expectEqual(new Set(statusLabels).size, 3, "the three states read differently from one another");
expectEqual(new Set(periodLabels).size, 2, "and so do the two periods");
expectEqual(new Set(serviceLabels).size, 6, "and the six services, so a checkbox never names two of them alike");

const catalogue: PlanCatalogue = readable;

expectEqual(catalogue.statuses.join(","), BILLING_PLAN_STATUSES.join(","), "the catalogue carries the three states");

// ------------------------------------------------------------------ the verdict

if (failures.length > 0) {
  process.stderr.write(`billing plans gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `billing plans gate passed: ${String(checkCount)} checks, a plan created by super_admin alone, a price in whole ` +
      "minor units under a stated ceiling, a code reserved for ever, the six services written as rows rather than " +
      "columns, a plan withdrawn rather than left without services, and a schema that already supported every one " +
      "of those sentences before this STEP was written\n",
  );
}
