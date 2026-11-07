// path: services/billing/entitlements-verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { ZodType } from "zod";
import { createInMemoryAuditTrail, type AuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { getMessage, type MessagePath } from "../../lib/i18n/messages.ts";
import {
  ENTITLEMENT_ENTITY_TYPE,
  ENTITLEMENT_KINDS,
  ENTITLEMENT_READ_ROLES,
  ENTITLEMENT_REFUSED_AUDIT_ACTION,
  ENTITLEMENT_SUBSCRIPTION_TABLE,
  ENTITLEMENT_VERDICTS,
  ENTITLED_SUBSCRIPTION_STATUSES,
  MERCHANT_FEATURES,
  createEntitlementReader,
  describeEntitlements,
  entitlementVerdictOf,
  featureVerdictOf,
  merchantFeatureOf,
  readMerchantEntitlements,
  readOfficeEntitlements,
  requireMerchantFeature,
  type EntitlementGuardDependencies,
  type MerchantEntitlements,
  type MerchantFeature,
} from "./entitlements.ts";
import {
  BILLING_PLAN_ENTITLEMENT_TABLE,
  BILLING_PLAN_SERVICE_KEYS,
  BILLING_PLAN_TABLE,
  planServiceLabelKey,
} from "./plans-registry.ts";

/**
 * The gate for STEP 213: section 9's entitlement checks.
 *
 * ## What this proves
 *
 *   - **The six features are section 9's six services**, in its order, with no seventh and no duplicate.
 *   - **Four states, one grant.** No plan, a plan that is not live, a read that failed and a plan without the
 *     service are four different answers and four different sentences - and only a live plan carrying the
 *     service grants anything.
 *   - **Fail closed**, including the read that throws: the feature is refused, never granted.
 *   - **The merchant with no subscription is refused**, which is the decision this STEP records rather than
 *     hides: until STEP 214 assigns a plan, everything gated is refused.
 *   - **Every refusal is on the merchant's chain**, with the service, the feature, the verdict and no value of
 *     the merchant's business; a grant writes nothing.
 *   - **One request, three queries**: the cached reader proves it, and a cached refusal is not retried.
 *   - **Only `super_admin` reads a merchant's entitlements**, at the service, before any query.
 *   - **The route and the screen do not decide anything**: the route is a `GET` with no body to forge, the
 *     screen prints the verdicts the service produced.
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

const nowMs = Date.UTC(2026, 10, 7, 9, 30, 0);
const laterIso = new Date(nowMs + 86_400_000 * 20).toISOString();
const earlierIso = new Date(nowMs - 86_400_000).toISOString();
const companyId = "0192f0a1-7c3d-7000-8000-0000000000a1";
const otherCompanyId = "0192f0a1-7c3d-7000-8000-0000000000a2";
const planId = "0192f0a1-7c3d-7000-8000-0000000000b1";
const subscriptionId = "0192f0a1-7c3d-7000-8000-0000000000c1";
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
    reauthenticatedAtEpochMs: nowMs,
    sessionStartedAtEpochMs: nowMs,
    permissions: [],
  } as unknown as RequestActor;
}

const superAdmin = actorOf(["super_admin"]);
const owner = actorOf(["owner"]);

// ------------------------------------------------------------------ 1. the vocabulary is section 9's

expectEqual(MERCHANT_FEATURES.length, 6, "section 9 names six services and six features");
expectEqual(
  MERCHANT_FEATURES.map((feature) => feature.key).join(","),
  BILLING_PLAN_SERVICE_KEYS.join(","),
  "the features are the plan catalogue's six keys, in its order",
);
expectEqual(
  MERCHANT_FEATURES.every((feature) => feature.services.length === 1 && feature.services[0] === feature.key),
  true,
  "each feature needs exactly its own service today",
);
expectEqual(
  new Set(MERCHANT_FEATURES.map((feature) => getMessage(feature.labelKey))).size,
  6,
  "and each of the six reads with its own sentence",
);
expectEqual(
  MERCHANT_FEATURES.every((feature) => feature.labelKey === planServiceLabelKey(feature.key)),
  true,
  "the label is the plan catalogue's own, so the two screens cannot drift",
);
expectEqual(merchantFeatureOf("public_api")?.key, "public_api", "a feature is found by name");
expectEqual(merchantFeatureOf("payments"), null, "and an unknown word finds nothing");
expectEqual(merchantFeatureOf("PAYMENT_LINKS"), null, "case is not forgiven");

expectEqual(ENTITLED_SUBSCRIPTION_STATUSES.join(","), "active,past_due", "a live subscription is active or past due");
expectEqual(ENTITLEMENT_KINDS.join(","), "granted,unassigned,not_live,unreadable", "four states, pinned");
expectEqual(
  ENTITLEMENT_VERDICTS.join(","),
  "granted,plan_unassigned,plan_not_live,plan_missing_service,plan_unreadable",
  "five verdicts, pinned as the words a refusal carries",
);
expectEqual(ENTITLEMENT_REFUSED_AUDIT_ACTION, "billing.service_refused", "the chain action, pinned");
expectEqual(ENTITLEMENT_ENTITY_TYPE, "entitlement", "and the entity it names");
expectEqual(ENTITLEMENT_READ_ROLES.join(","), "super_admin", "only a super administrator reads a merchant's plan");
expectEqual(ENTITLEMENT_SUBSCRIPTION_TABLE, "subscriptions", "the subscription table is 0017's");

const migrationFiles = (await readdir(new URL("../../migrations/", import.meta.url))).filter(
  (name) => name.endsWith(".sql") && !name.endsWith(".down.sql"),
);

expectEqual(migrationFiles.length, 128, "this STEP adds no migration: the next free number is still 129");

const subscriptionsSql = await sourceOf("migrations/0017_subscriptions.sql");
const plansSql = await sourceOf("migrations/0014_plans.sql");

expect(
  subscriptionsSql.includes("status in ('pending', 'active', 'past_due', 'stopped', 'cancelled')"),
  "0017's five statuses are the five the platform distinguishes",
);
expect(
  ENTITLED_SUBSCRIPTION_STATUSES.every((status) => subscriptionsSql.includes(`'${status}'`)),
  "and the two this module entitles are among them",
);
expect(
  !subscriptionsSql.includes("status in ('pending', 'active', 'past_due', 'stopped', 'cancelled')") === false,
  "pinned above",
);
expect(
  plansSql.includes("status in ('draft', 'active', 'retired')"),
  "0014's plan states are the three the liveness check reads",
);
expect(subscriptionsSql.includes("subscriptions_live_key"), "one live subscription per merchant");
expect(
  (await sourceOf("migrations/0015_plan_entitlements.sql")).includes("plan_entitlements_live_key"),
  "and one live row per plan and service",
);

// ------------------------------------------------------------------ 2. the verdict matrix

function snapshotOf(
  kind: MerchantEntitlements["kind"],
  services: readonly (typeof BILLING_PLAN_SERVICE_KEYS)[number][],
): MerchantEntitlements {
  return {
    companyId,
    kind,
    subscription: null,
    plan: kind === "granted" ? { id: planId, code: "growth", name: "Growth", status: "active" } : null,
    services,
    readAtEpochMs: nowMs,
  };
}

const allSix = snapshotOf("granted", BILLING_PLAN_SERVICE_KEYS);
const onlyInvoicing = snapshotOf("granted", ["invoicing"]);

expectEqual(entitlementVerdictOf(allSix, "test_mode"), "granted", "a plan carrying the service grants it");
expectEqual(entitlementVerdictOf(onlyInvoicing, "test_mode"), "plan_missing_service", "a plan without it does not");
expectEqual(entitlementVerdictOf(snapshotOf("unassigned", []), "invoicing"), "plan_unassigned", "no plan grants nothing");
expectEqual(entitlementVerdictOf(snapshotOf("not_live", []), "invoicing"), "plan_not_live", "a stopped plan grants nothing");
expectEqual(
  entitlementVerdictOf(snapshotOf("not_live", [...BILLING_PLAN_SERVICE_KEYS]), "invoicing"),
  "plan_not_live",
  "even when the stopped plan's services are known",
);
expectEqual(
  entitlementVerdictOf(snapshotOf("unreadable", [...BILLING_PLAN_SERVICE_KEYS]), "invoicing"),
  "plan_unreadable",
  "a failed read refuses even when the caller holds services from elsewhere",
);

const twoServiceFeature: MerchantFeature = {
  key: "invoicing",
  services: ["invoicing", "recurring_invoices"],
  labelKey: planServiceLabelKey("invoicing"),
};

expectEqual(featureVerdictOf(onlyInvoicing, twoServiceFeature), "plan_missing_service", "a feature needing two services needs both");
expectEqual(
  featureVerdictOf(snapshotOf("granted", ["invoicing", "recurring_invoices"]), twoServiceFeature),
  "granted",
  "and is granted when both are carried",
);
expectEqual(describeEntitlements(allSix).length, 6, "a snapshot describes six features");
expectEqual(
  describeEntitlements(allSix).every((check) => check.verdict === "granted"),
  true,
  "all six granted on a plan carrying all six",
);
expectEqual(
  describeEntitlements(onlyInvoicing).filter((check) => check.verdict === "granted").length,
  1,
  "one granted on a plan carrying one",
);

// ------------------------------------------------------------------ 3. reading a merchant, over a fixture

type Row = Record<string, unknown>;

interface Fixture {
  readonly store: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly queries: string[];
  failOn: "none" | "subscriptions" | "plans" | "entitlements";
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

function createFixture(
  options: {
    subscriptions?: readonly Row[];
    plans?: readonly Row[];
    entitlements?: readonly Row[];
  } = {},
): Fixture {
  const tables: Readonly<Record<string, readonly Row[]>> = {
    [ENTITLEMENT_SUBSCRIPTION_TABLE]: options.subscriptions ?? [],
    [BILLING_PLAN_TABLE]: options.plans ?? [
      { id: planId, code: "growth", name: "Growth", status: "active" },
    ],
    [BILLING_PLAN_ENTITLEMENT_TABLE]:
      options.entitlements ??
      BILLING_PLAN_SERVICE_KEYS.map((service) => ({ plan_id: planId, service })),
  };
  const queries: string[] = [];
  const fixture: Fixture = {
    queries,
    audit: createInMemoryAuditTrail(),
    failOn: "none",
    store: {
      async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
        queries.push(`${table}?${query}`);

        const failingTable =
          fixture.failOn === "subscriptions"
            ? ENTITLEMENT_SUBSCRIPTION_TABLE
            : fixture.failOn === "plans"
              ? BILLING_PLAN_TABLE
              : fixture.failOn === "entitlements"
                ? BILLING_PLAN_ENTITLEMENT_TABLE
                : null;

        if (failingTable === table) {
          throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unreachable" } });
        }

        const rows = tables[table];

        if (rows === undefined) {
          throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
        }

        const limit = Number.parseInt(/limit=([0-9]+)/u.exec(query)?.[1] ?? "50", 10);

        return rows
          .filter((row) => matches(row, query))
          .slice(0, Number.isFinite(limit) ? limit : 50)
          .map((row) => schema.parse(row));
      },

      insert: async (): Promise<void> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_writes_nothing" } });
      },

      insertReturning: async (): Promise<readonly never[]> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_writes_nothing" } });
      },

      update: async (): Promise<void> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_writes_nothing" } });
      },

      rpc: async (): Promise<unknown> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_writes_nothing" } });
      },
    },
  };

  return fixture;
}

function readDependencies(fixture: Fixture): { store: RestClient; now: () => number } {
  return { store: fixture.store, now: (): number => nowMs };
}

function guardDependencies(fixture: Fixture): EntitlementGuardDependencies {
  return { store: fixture.store, now: (): number => nowMs, audit: fixture.audit };
}

const liveSubscription: Row = {
  id: subscriptionId,
  company_id: companyId,
  plan_id: planId,
  status: "active",
  current_period_end: laterIso,
};

const noSubscription = await readMerchantEntitlements({ companyId }, readDependencies(createFixture()));

expectEqual(noSubscription.kind, "unassigned", "a merchant with no subscription is on no plan");
expectEqual(noSubscription.services.length, 0, "and includes no service");
expectEqual(noSubscription.plan, null, "with no plan to name");
expectEqual(noSubscription.readAtEpochMs, nowMs, "read at the injected instant");

const emptyFixture = createFixture();

await readMerchantEntitlements({ companyId }, readDependencies(emptyFixture));

expectEqual(emptyFixture.queries.length, 1, "no subscription costs one query");
expectEqual(
  emptyFixture.queries[0],
  `${ENTITLEMENT_SUBSCRIPTION_TABLE}?select=id,plan_id,status,current_period_end&company_id=eq.${companyId}` +
    "&deleted_at=is.null&order=created_at.desc&limit=1",
  "and that query names its columns, its tenant, the live filter, the order and the limit",
);

const liveFixture = createFixture({ subscriptions: [liveSubscription] });
const live = await readMerchantEntitlements({ companyId }, readDependencies(liveFixture));

expectEqual(live.kind, "granted", "a live subscription on an active plan grants the plan");
expectEqual(live.plan?.code, "growth", "the plan is named");
expectEqual(live.subscription?.status, "active", "and the subscription is carried");
expectEqual(live.services.join(","), BILLING_PLAN_SERVICE_KEYS.join(","), "with the six services");
expectEqual(liveFixture.queries.length, 3, "a grant costs three queries");
expectEqual(
  liveFixture.queries[1],
  `${BILLING_PLAN_TABLE}?select=id,code,name,status&id=eq.${planId}&deleted_at=is.null&limit=1`,
  "the plan read names its columns and its id",
);
expectEqual(
  liveFixture.queries[2],
  `${BILLING_PLAN_ENTITLEMENT_TABLE}?select=service&plan_id=eq.${planId}&deleted_at=is.null&limit=50`,
  "and the services read is one query for the plan, live only",
);

const pastDueFixture = createFixture({ subscriptions: [{ ...liveSubscription, status: "past_due" }] });

expectEqual(
  (await readMerchantEntitlements({ companyId }, readDependencies(pastDueFixture))).kind,
  "granted",
  "a merchant who owes money keeps working until the platform says otherwise",
);

for (const status of ["pending", "stopped", "cancelled"] as const) {
  const fixture = createFixture({ subscriptions: [{ ...liveSubscription, status }] });
  const answer = await readMerchantEntitlements({ companyId }, readDependencies(fixture));

  expectEqual(answer.kind, "not_live", `a ${status} subscription grants nothing`);
  expectEqual(answer.subscription?.status, status, `and is reported as ${status}`);
  expectEqual(fixture.queries.length, 1, `a ${status} subscription needs no plan read`);
}

const expiredFixture = createFixture({
  subscriptions: [{ ...liveSubscription, current_period_end: earlierIso }],
});

expectEqual(
  (await readMerchantEntitlements({ companyId }, readDependencies(expiredFixture))).kind,
  "not_live",
  "a paid period that ended without a renewal stops the services",
);
expectEqual(expiredFixture.queries.length, 1, "and is answered before the plan is read");

const draftPlanFixture = createFixture({
  subscriptions: [liveSubscription],
  plans: [{ id: planId, code: "growth", name: "Growth", status: "draft" }],
});
const draftPlan = await readMerchantEntitlements({ companyId }, readDependencies(draftPlanFixture));

expectEqual(draftPlan.kind, "not_live", "a draft plan grants nothing");
expectEqual(draftPlan.plan?.status, "draft", "and is named so the office can see why");
expectEqual(draftPlanFixture.queries.length, 2, "with no services read");

const retiredPlanFixture = createFixture({
  subscriptions: [liveSubscription],
  plans: [{ id: planId, code: "growth", name: "Growth", status: "retired" }],
});

expectEqual(
  (await readMerchantEntitlements({ companyId }, readDependencies(retiredPlanFixture))).kind,
  "not_live",
  "a retired plan stops granting what it used to sell",
);

const missingPlanFixture = createFixture({ subscriptions: [liveSubscription], plans: [] });
const missingPlan = await readMerchantEntitlements({ companyId }, readDependencies(missingPlanFixture));

expectEqual(missingPlan.kind, "not_live", "a plan that is gone grants nothing");
expectEqual(missingPlan.plan, null, "and there is no plan to name");

const strayServiceFixture = createFixture({
  subscriptions: [liveSubscription],
  entitlements: [
    { plan_id: planId, service: "teleportation" },
    { plan_id: planId, service: "test_mode" },
    { plan_id: planId, service: "invoicing" },
  ],
});
const strayService = await readMerchantEntitlements({ companyId }, readDependencies(strayServiceFixture));

expectEqual(strayService.services.join(","), "invoicing,test_mode", "a service outside the six is not granted, and order is the catalogue's");

for (const malformed of ["", "not-a-uuid", "0192f0a1", "'; drop table plans; --"]) {
  const refused = await refusalOf(async () =>
    readMerchantEntitlements({ companyId: malformed }, readDependencies(createFixture())),
  );

  expectEqual(refused.code, "VALIDATION_FAILED", `a company id of "${malformed}" is refused`);
  expectEqual(refused.field, "companyId", "naming the field");
  expectEqual(refused.rule, "malformed", "and the rule");
}

const malformedFixture = createFixture();

await refusalOf(async () => readMerchantEntitlements({ companyId: "nope" }, readDependencies(malformedFixture)));
expectEqual(malformedFixture.queries.length, 0, "a malformed id never reaches a query");

for (const failOn of ["subscriptions", "plans", "entitlements"] as const) {
  const fixture = createFixture({ subscriptions: [liveSubscription] });
  fixture.failOn = failOn;

  const answer = await readMerchantEntitlements({ companyId }, readDependencies(fixture));

  expectEqual(answer.kind, "unreadable", `a failing ${failOn} read is unreadable, not a grant`);
  expectEqual(answer.services.length, 0, `and carries no service when ${failOn} cannot be read`);
}

// ------------------------------------------------------------------ 4. the guard, and its chain entries

const grantedFixture = createFixture({ subscriptions: [liveSubscription] });
const granted = await requireMerchantFeature({ companyId, feature: "invoicing" }, guardDependencies(grantedFixture));

expectEqual(granted.kind, "granted", "a granted feature returns the merchant's answer");
expectEqual(grantedFixture.audit.entries.length, 0, "and writes nothing to the chain");

const oneServiceFixture = createFixture({
  subscriptions: [liveSubscription],
  entitlements: [{ plan_id: planId, service: "invoicing" }],
});

for (const feature of ["payment_links", "recurring_invoices", "public_api", "store_connections", "test_mode"] as const) {
  const refused = await refusalOf(async () =>
    requireMerchantFeature({ companyId, feature }, guardDependencies(oneServiceFixture)),
  );

  expectEqual(refused.code, "PERMISSION_DENIED", `a plan without ${feature} refuses it`);
  expectEqual(refused.status, 403, `and ${feature}'s refusal is a 403`);
  expectEqual(refused.field, "service", `naming the service for ${feature}`);
  expectEqual(refused.rule, "plan_missing_service", `with the rule for ${feature}`);
}

expectEqual(oneServiceFixture.audit.entries.length, 5, "five refusals, five chain entries");
expectEqual(
  oneServiceFixture.audit.entries.every((entry) => entry.action === ENTITLEMENT_REFUSED_AUDIT_ACTION),
  true,
  "every one carrying the refusal action",
);
expectEqual(
  oneServiceFixture.audit.entries.map((entry) => String(entry.payload["feature"])).join(","),
  "payment_links,recurring_invoices,public_api,store_connections,test_mode",
  "and naming the feature that was refused",
);
expectEqual(
  oneServiceFixture.audit.entries.every((entry) => entry.payload["verdict"] === "plan_missing_service"),
  true,
  "with the verdict",
);
expectEqual(
  oneServiceFixture.audit.entries.every((entry) => entry.companyId === companyId && entry.entityId === companyId),
  true,
  "on the merchant's own chain, against the merchant's own id",
);
expectEqual(
  oneServiceFixture.audit.entries.every((entry) => entry.entityType === ENTITLEMENT_ENTITY_TYPE),
  true,
  "naming an entitlement rather than a plan",
);
expectEqual(
  oneServiceFixture.audit.entries.every((entry) => entry.payload["plan_code"] === "growth"),
  true,
  "and carrying the plan's code so the refusal can be explained",
);
expectEqual(
  oneServiceFixture.audit.entries.some((entry) => Object.hasOwn(entry.payload, "amount")),
  false,
  "with no amount, client or content of the merchant's business",
);

const unassignedFixture = createFixture();
const unassignedRefused = await refusalOf(async () =>
  requireMerchantFeature({ companyId, feature: "invoicing" }, guardDependencies(unassignedFixture)),
);

expectEqual(unassignedRefused.rule, "plan_unassigned", "a merchant on no plan is refused as unassigned");
expectEqual(unassignedFixture.audit.entries[0]?.payload["plan_id"], null, "with no plan id");
expectEqual(unassignedFixture.audit.entries[0]?.payload["subscription_status"], null, "and no subscription status");

const stoppedFixture = createFixture({ subscriptions: [{ ...liveSubscription, status: "stopped" }] });
const stoppedRefused = await refusalOf(async () =>
  requireMerchantFeature({ companyId, feature: "invoicing" }, guardDependencies(stoppedFixture)),
);

expectEqual(stoppedRefused.rule, "plan_not_live", "a stopped subscription is refused as not live");
expectEqual(stoppedFixture.audit.entries[0]?.payload["subscription_status"], "stopped", "and the chain says why");

const deafFixture = createFixture({ subscriptions: [liveSubscription] });
deafFixture.failOn = "plans";

const deafRefused = await refusalOf(async () =>
  requireMerchantFeature({ companyId, feature: "invoicing" }, guardDependencies(deafFixture)),
);

expectEqual(deafRefused.rule, "plan_unreadable", "a read that fails refuses the feature");
expectEqual(deafRefused.code, "PERMISSION_DENIED", "as a refusal, not as a platform error");

const unknownFixture = createFixture({ subscriptions: [liveSubscription] });
const unknownRefused = await refusalOf(async () =>
  requireMerchantFeature({ companyId, feature: "payments" }, guardDependencies(unknownFixture)),
);

expectEqual(unknownRefused.code, "VALIDATION_FAILED", "a feature outside the six is a validation problem");
expectEqual(unknownRefused.field, "feature", "naming the feature");
expectEqual(unknownRefused.rule, "unknown", "and the rule");
expectEqual(unknownFixture.queries.length, 0, "and it is refused before a query");
expectEqual(unknownFixture.audit.entries.length, 0, "and before the chain");

const trailDownFixture = createFixture({
  subscriptions: [liveSubscription],
  entitlements: [{ plan_id: planId, service: "invoicing" }],
});

const trailDown: EntitlementGuardDependencies = {
  store: trailDownFixture.store,
  now: (): number => nowMs,
  audit: {
    append: async (): Promise<void> => {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "chain_unreachable" } });
    },
  } satisfies AuditTrail,
};

const trailDownRefused = await refusalOf(async () =>
  requireMerchantFeature({ companyId, feature: "test_mode" }, trailDown),
);

expectEqual(trailDownRefused.code, "PERMISSION_DENIED", "a chain that cannot be written still refuses the feature");
expectEqual(trailDownRefused.rule, "plan_missing_service", "with the verdict it reached");

// ------------------------------------------------------------------ 5. one request, one read

const cachedFixture = createFixture({ subscriptions: [liveSubscription] });
const reader = createEntitlementReader(guardDependencies(cachedFixture));

for (const feature of BILLING_PLAN_SERVICE_KEYS) {
  await reader.require({ companyId, feature });
}

expectEqual(cachedFixture.queries.length, 3, "six checks in one request cost three queries");
expectEqual(cachedFixture.audit.entries.length, 0, "and none of them was a refusal");

const mixedFixture = createFixture({
  subscriptions: [liveSubscription],
  entitlements: [{ plan_id: planId, service: "invoicing" }],
});
const mixedReader = createEntitlementReader(guardDependencies(mixedFixture));

await mixedReader.require({ companyId, feature: "invoicing" });
await refusalOf(async () => mixedReader.require({ companyId, feature: "public_api" }));
await refusalOf(async () => mixedReader.require({ companyId, feature: "test_mode" }));

expectEqual(mixedFixture.queries.length, 3, "a refused request still costs three queries, not nine");
expectEqual(mixedFixture.audit.entries.length, 2, "while each refusal is recorded");

const secondMerchant = createFixture({
  subscriptions: [liveSubscription, { ...liveSubscription, id: "0192f0a1-7c3d-7000-8000-0000000000c2", company_id: otherCompanyId }],
});
const twoMerchants = createEntitlementReader(guardDependencies(secondMerchant));

await twoMerchants.read(companyId);
await twoMerchants.read(otherCompanyId);

expectEqual(secondMerchant.queries.length, 6, "two merchants cost two full reads, three queries each");
expectEqual(
  secondMerchant.queries.filter((query) => query.startsWith(`${ENTITLEMENT_SUBSCRIPTION_TABLE}?`)).length,
  2,
  "one subscription read per merchant, and the cache is per merchant rather than per process",
);

const unreadableFixture = createFixture({ subscriptions: [liveSubscription] });
unreadableFixture.failOn = "subscriptions";

const unreadableReader = createEntitlementReader(guardDependencies(unreadableFixture));

await refusalOf(async () => unreadableReader.require({ companyId, feature: "invoicing" }));
await refusalOf(async () => unreadableReader.require({ companyId, feature: "invoicing" }));

expectEqual(unreadableFixture.queries.length, 1, "an unreadable answer is cached too, not retried six times");
expectEqual(unreadableFixture.audit.entries.length, 2, "and each refusal is still recorded");

// ------------------------------------------------------------------ 6. the office's read

const officeFixture = createFixture({ subscriptions: [liveSubscription] });
const office = await readOfficeEntitlements({ actor: superAdmin, companyId }, readDependencies(officeFixture));

expectEqual(office.checks.length, 6, "the office reads six verdicts");
expectEqual(
  office.checks.map((check) => check.feature).join(","),
  BILLING_PLAN_SERVICE_KEYS.join(","),
  "in the catalogue's order",
);
expectEqual(office.entitlements.kind, "granted", "with the merchant's state");
expectEqual(officeFixture.audit.entries.length, 0, "and no chain entry, because a read is not a refusal");

const officeDeniedFixture = createFixture({ subscriptions: [liveSubscription] });
const officeDenied = await refusalOf(async () =>
  readOfficeEntitlements({ actor: owner, companyId }, readDependencies(officeDeniedFixture)),
);

expectEqual(officeDenied.code, "PERMISSION_DENIED", "a merchant owner cannot read another merchant's plan");
expectEqual(officeDeniedFixture.queries.length, 0, "and is refused before a query");

const officeMalformed = await refusalOf(async () =>
  readOfficeEntitlements({ actor: superAdmin, companyId: "nope" }, readDependencies(createFixture())),
);

expectEqual(officeMalformed.code, "VALIDATION_FAILED", "a malformed id is refused to the office too");

// ------------------------------------------------------------------ 7. the route, the screen and the words

const routeSource = await sourceOf("app/api/office/entitlements/route.ts");
const pageSource = await sourceOf("app/(admin)/entitlements/page.tsx");
const consoleSource = await sourceOf("app/(admin)/entitlements/entitlements-console.tsx");
const navigationSource = await sourceOf("components/office/navigation.ts");
const seoSource = await sourceOf("components/public/seo.ts");

expect(routeSource.includes("export const GET"), "the route reads");
expect(!routeSource.includes("export const POST"), "and offers no write, because this STEP grants nothing");
expect(!routeSource.includes("requireCsrfToken"), "so there is no body to forge");
expect(routeSource.includes("readOfficeEntitlements({ actor, companyId }"), "the role and the read live in the service");
expect(routeSource.includes('headers: { "cache-control": "no-store" }'), "and the answer is never cached by a browser");
expect(
  routeSource.includes('new URL(request.url).searchParams.get("companyId")'),
  "the one caller-controlled value is read as a parameter and validated by the service",
);

expect(pageSource.includes("ENTITLEMENT_READ_ROLES.some((role) => actor.roles.includes(role))"), "the page asks the role itself");
expect(pageSource.includes("<EntitlementsConsole"), "and renders the console for the account that may read");
expect(pageSource.includes('getMessage("officeEntitlements.forbidden")'), "with a sentence for the account that may not");

expect(
  consoleSource.includes('`/api/office/entitlements?companyId=${encodeURIComponent(companyId)}`'),
  "the console encodes the id it sends",
);
expect(consoleSource.includes('method: "GET"'), "and only reads");
expect(!consoleSource.includes("deviceProofHeaders"), "with no device proof, because nothing is written");
expect(
  (consoleSource.match(/<label/gu) ?? []).length >= (consoleSource.match(/<input/gu) ?? []).length,
  "every field the console draws has a label",
);
expect(consoleSource.includes("sm:flex-row"), "a verdict row becomes a row from the small breakpoint up");
expect(!/w-\[\d{3,}px\]/u.test(consoleSource), "with no fixed pixel width a phone would clip");

expect(
  navigationSource.includes('href: "/entitlements"') && navigationSource.includes("roles: ENTITLEMENT_READ_ROLES"),
  "the office shell offers the screen to the one role that may use it",
);
expect(seoSource.includes('"/entitlements"'), "and the new top-level segment is private to crawlers");

const verdictPaths: Readonly<Record<string, string>> = {
  granted: "officeEntitlements.verdictGranted",
  plan_unassigned: "officeEntitlements.verdictPlanUnassigned",
  plan_not_live: "officeEntitlements.verdictPlanNotLive",
  plan_missing_service: "officeEntitlements.verdictPlanMissingService",
  plan_unreadable: "officeEntitlements.verdictPlanUnreadable",
};

const kindPaths: Readonly<Record<string, string>> = {
  granted: "officeEntitlements.kindGranted",
  unassigned: "officeEntitlements.kindUnassigned",
  not_live: "officeEntitlements.kindNotLive",
  unreadable: "officeEntitlements.kindUnreadable",
};

expectEqual(Object.keys(verdictPaths).join(","), ENTITLEMENT_VERDICTS.join(","), "every verdict has a sentence path, and no extra");
expectEqual(Object.keys(kindPaths).join(","), ENTITLEMENT_KINDS.join(","), "every state has one, and no extra");

const verdictSentences: string[] = [];

for (const verdict of ENTITLEMENT_VERDICTS) {
  const sentence = getMessage(verdictPaths[verdict] as MessagePath);

  verdictSentences.push(sentence);
  expect(sentence.length > 0, `the ${verdict} verdict has a sentence`);
  expect(
    consoleSource.includes(`"${verdictPaths[verdict] ?? ""}"`),
    `and the console prints it for ${verdict}`,
  );
}

for (const kind of ENTITLEMENT_KINDS) {
  expect(getMessage(kindPaths[kind] as MessagePath).length > 0, `the ${kind} state has a sentence`);
}

expectEqual(new Set(verdictSentences).size, 5, "the five verdicts read differently from one another");

// ------------------------------------------------------------------ the verdict

if (failures.length > 0) {
  process.stderr.write(`billing entitlements gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `billing entitlements gate passed: ${String(checkCount)} checks, section 9's six services gated by the plan a ` +
      "merchant's live subscription names, four states and five verdicts with only one of them a grant, a failed read " +
      "refused rather than granted, every refusal on the merchant's own chain with the service and never the business's " +
      "content, one request answered from three queries, and a merchant on no plan refused every service - which is the " +
      "prerequisite STEP 214 carries\n",
  );
}
