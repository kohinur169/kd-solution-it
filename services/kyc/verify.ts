// path: services/kyc/verify.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { UNIQUE_VIOLATION } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { en } from "../../lib/i18n/strings/en.ts";
import {
  readOnboardingProgress,
  saveOnboardingStep,
  type OnboardingProgress,
  type OnboardingProgressDependencies,
} from "./onboarding-progress.ts";
import {
  parseBusinessProfileInput,
  readBusinessProfile,
  saveBusinessProfile,
  BUSINESS_PROFILE_TABLE,
  BUSINESS_PROFILE_AUDIT_ACTION,
  BUSINESS_PROFILE_AUDIT_ENTITY,
  BUSINESS_FIELD_LIMITS,
} from "./business-profile.ts";
import {
  BUSINESS_PROFILE_FIELDS,
  OPTIONAL_BUSINESS_FIELDS,
  PROCESSOR_REQUIREMENT_LIST,
  PROCESSOR_REQUIREMENTS,
  REQUIRED_BUSINESS_FIELDS,
  type BusinessProfileField,
} from "./processor-fields.ts";
import {
  parseMerchantCategoryInput,
  readMerchantCategory,
  saveMerchantCategory,
  MCC_CODES_TABLE,
  MCC_CODE_PATTERN,
  MERCHANT_CATEGORY_AUDIT_ACTION,
  MERCHANT_CATEGORY_AUDIT_ENTITY,
  MERCHANT_CATEGORY_FIELD,
  MERCHANT_CATEGORY_ONBOARDING_STEP,
  type MerchantCategorySnapshot,
} from "./merchant-category.ts";
import { PLATFORM_PROVIDERS } from "../../lib/gateways/registry.ts";
import {
  ONBOARDING_AUDIT_ACTION,
  ONBOARDING_OWNER_ROLES,
  ONBOARDING_PROGRESS_TABLE,
  ONBOARDING_START_STEP,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_COUNT,
  isOnboardingStep,
  nextOnboardingStep,
  onboardingStepIndex,
} from "./onboarding-steps.ts";

/**
 * The onboarding shell gate: run with `node services/kyc/verify.ts`.
 *
 * STEP 079's deliverable is a row, a service, one route and one screen, and each part makes a
 * promise no other part can keep:
 *
 *   1. **The vocabulary is one list.** Six step names, in section 5's order, imported by the service,
 *      the page, the client component and the migration's own rule - so a seventh step cannot appear
 *      in a screen without appearing in the table.
 *   2. **The tenant is the session's.** `owner` and `requireCompanyId(actor)`, asked before the first
 *      query, so a merchant reads and moves their own position and nobody else's - and an office
 *      account is refused rather than filtered to an empty wizard.
 *   3. **A save is a position.** An unknown step is a validation failure with no write; an unchanged
 *      save writes nothing and audits nothing; a real move updates one row and appends exactly one
 *      `onboarding.step_saved` entry naming the merchant, the step and the step before it.
 *   4. **The write is guarded in the order the platform states.** The route checks the CSRF token
 *      before it reads the session, reads the session before it parses the body, reads only `step`
 *      from that body, and bounds the bytes it will read.
 *
 * The service runs over an in-memory PostgREST with the five methods `RestClient` exposes, so what
 * passes here is the code the route runs. The route, the page, the client component and the
 * migration are read as source, because a `.tsx` file cannot be imported by plain Node.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that `0102` was applied to a particular project, and that a person can
 * press the button at two widths - those are deployment and browser facts, and the handoff lists the
 * checks a person runs against a real project.
 */

const repositoryRoot = new URL("../../", import.meta.url);
const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(
      `${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`,
    );
  }
}

function expectDeepEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;

  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);

  if (left !== right) {
    failures.push(`${description} (expected ${right}, received ${left})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

/** The instant every save runs at. */
const NOW = Date.parse("2026-11-02T11:00:00.000Z");

const OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const OTHER_OWNER_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const OFFICE_ID = "018f2b8a-1111-4c2d-9c3e-000000000003";

const COMPANY_A = "018f2b8a-4444-4c2d-9c3e-000000000001";
const COMPANY_B = "018f2b8a-4444-4c2d-9c3e-000000000002";

function actorOf(
  roles: readonly PlatformRole[],
  companyId: string | null,
  overrides: Partial<RequestActor> = {},
): RequestActor {
  return {
    userId: OWNER_ID,
    companyId,
    roles,
    sessionId: "018f2b8a-2222-4c2d-9c3e-000000000001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW,
    expiresAtEpochMs: NOW + 900_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: NOW,
    reauthenticatedAtEpochMs: NOW,
    ...overrides,
  };
}

const owner = actorOf(["owner"], COMPANY_A);
const otherOwner = actorOf(["owner"], COMPANY_B, { userId: OTHER_OWNER_ID });

/** The actors the wizard must refuse before it reads a row. */
const refusedActors: readonly (readonly [string, RequestActor])[] = [
  ["super_admin", actorOf(["super_admin"], null, { userId: OFFICE_ID })],
  ["ceo", actorOf(["ceo"], null, { userId: OFFICE_ID })],
  ["compliance_kyc", actorOf(["compliance_kyc"], null, { userId: OFFICE_ID })],
  ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })],
  ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
  ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
  ["an owner with no company on the session", actorOf(["owner"], null)],
  ["nobody", actorOf([], null)],
];

interface ProgressRowShape {
  company_id: string;
  current_step: string;
  completed_steps: unknown;
  started_at: string;
  updated_at: string;
}

interface FakeDatabase {
  readonly rows: ProgressRowShape[];
  readonly queries: string[];
  readonly inserts: Readonly<Record<string, unknown>>[];
  readonly updates: { readonly query: string; readonly values: Readonly<Record<string, unknown>> }[];
  /** When set, the next insert fails with the unique violation a racing tab would cause. */
  conflictOnInsert: boolean;
}

function progressRow(overrides: Partial<ProgressRowShape> = {}): ProgressRowShape {
  return {
    company_id: COMPANY_A,
    current_step: "business",
    completed_steps: [],
    started_at: "2026-11-01T09:00:00.000Z",
    updated_at: "2026-11-01T09:30:00.000Z",
    ...overrides,
  };
}

function createDatabase(rows: readonly ProgressRowShape[] = []): FakeDatabase {
  return { rows: [...rows], queries: [], inserts: [], updates: [], conflictOnInsert: false };
}

function createStore(database: FakeDatabase): RestClient {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      if (table !== ONBOARDING_PROGRESS_TABLE) {
        return Promise.reject(new Error(`the wizard reads no table but its own: ${table}`));
      }

      const parts = query.split("&");
      const company = parts.find((part) => part.startsWith("company_id=eq."));
      const limit = parts.find((part) => part.startsWith("limit="));
      const liveOnly = parts.includes("deleted_at=is.null");

      if (company === undefined || limit === undefined || !liveOnly) {
        return Promise.reject(new Error(`the wizard's read is not scoped to one live company: ${query}`));
      }

      const wanted = decodeURIComponent(company.slice("company_id=eq.".length));
      const matched = database.rows.filter((row) => row.company_id === wanted);

      return Promise.resolve(
        matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10)).map((row) => schema.parse(row)),
      );
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      if (table !== ONBOARDING_PROGRESS_TABLE) {
        return Promise.reject(new Error(`the wizard inserts into no other table: ${table}`));
      }

      if (database.conflictOnInsert) {
        database.conflictOnInsert = false;

        return Promise.reject(new AppError("CONFLICT", { cause: { code: UNIQUE_VIOLATION } }));
      }

      for (const row of rows) {
        database.inserts.push({ ...row });
        database.rows.push({
          company_id: String(row["company_id"] ?? ""),
          current_step: String(row["current_step"] ?? ""),
          completed_steps: row["completed_steps"] ?? [],
          started_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
        });
      }

      return Promise.resolve();
    },
    insertReturning(): Promise<never> {
      return Promise.reject(new Error("the wizard inserts without reading the row back"));
    },
    update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      if (table !== ONBOARDING_PROGRESS_TABLE) {
        return Promise.reject(new Error(`the wizard updates no other table: ${table}`));
      }

      database.updates.push({ query, values });

      const parts = query.split("&");
      const company = parts.find((part) => part.startsWith("company_id=eq."));

      if (company === undefined) {
        return Promise.reject(new Error(`the wizard's write is not scoped to a company: ${query}`));
      }

      const wanted = decodeURIComponent(company.slice("company_id=eq.".length));

      for (const row of database.rows) {
        if (row.company_id === wanted) {
          row.current_step = String(values["current_step"] ?? row.current_step);
        }
      }

      return Promise.resolve();
    },
    rpc(name: string): Promise<never> {
      return Promise.reject(new Error(`the wizard calls no function: ${name}`));
    },
  };
}

interface Harness {
  readonly database: FakeDatabase;
  readonly audit: InMemoryAuditTrail;
  readonly dependencies: OnboardingProgressDependencies;
}

function harnessOf(rows: readonly ProgressRowShape[] = []): Harness {
  const database = createDatabase(rows);
  const audit = createInMemoryAuditTrail();

  return {
    database,
    audit,
    dependencies: { rest: createStore(database), audit, now: (): number => NOW },
  };
}

async function failureOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;

    return typeof code === "string" ? code : `defect: ${String(error)}`;
  }
}

async function detailOf(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const details = (error as { readonly details?: unknown }).details;

    return details ?? "no-details";
  }
}

function save(actor: RequestActor, step: string, harness: Harness): Promise<OnboardingProgress> {
  return saveOnboardingStep(
    { actor, step, ipAddress: "198.51.100.9", userAgent: "gate" },
    harness.dependencies,
  );
}

/** ---- The vocabulary: six names, in section 5's order, shared by every layer. */
function checkVocabulary(): void {
  expectEqual(
    ONBOARDING_STEPS.join(","),
    "business,address,category,website,documents,review",
    "the six steps are section 5's, in its order",
  );
  expectEqual(ONBOARDING_STEP_COUNT, 6, "the wizard has six steps");
  expectEqual(ONBOARDING_START_STEP, "business", "and opens on the business information form");
  expectEqual(ONBOARDING_OWNER_ROLES.join(","), "owner", "only a merchant owner has an onboarding");
  expectEqual(ONBOARDING_AUDIT_ACTION, "onboarding.step_saved", "a save is audited under one name");
  expectEqual(Object.isFrozen(ONBOARDING_OWNER_ROLES), true, "the role list cannot be edited at runtime");
  expectEqual(new Set<string>(ONBOARDING_STEPS).size, ONBOARDING_STEP_COUNT, "no step is named twice");

  for (const step of ONBOARDING_STEPS) {
    expect(isOnboardingStep(step), `${step} is a step`);
    expect(onboardingStepIndex(step) >= 0, `${step} has a position`);
  }

  expectEqual(onboardingStepIndex("review"), 5, "review is the last step");
  expectEqual(nextOnboardingStep("business"), "address", "the step after business is the address");
  expectEqual(nextOnboardingStep("address"), "category", "then the category");
  expectEqual(nextOnboardingStep("category"), "website", "then the website");
  expectEqual(nextOnboardingStep("website"), "documents", "then the documents");
  expectEqual(nextOnboardingStep("documents"), "review", "then the review");
  expectEqual(nextOnboardingStep("review"), null, "and the review is the end of the wizard");

  for (const value of ["", "Business", "billing", " business", "business ", "review ", "6", "0"]) {
    expectEqual(isOnboardingStep(value), false, `"${value}" is not a step`);
  }

  for (const value of [null, 6, true, [], {}]) {
    expectEqual(isOnboardingStep(value), false, `${JSON.stringify(value)} is not a step`);
  }
}

/** ---- The refusals: no query, no audit entry, so a tenant cannot be probed. */
async function checkRefusals(): Promise<void> {
  for (const [label, actor] of refusedActors) {
    const readHarness = harnessOf();

    expectEqual(
      await failureOf(() => readOnboardingProgress({ actor }, readHarness.dependencies)),
      "PERMISSION_DENIED",
      `${label} may not read an onboarding`,
    );
    expectEqual(readHarness.database.queries.length, 0, `and ${label} is refused before the first query`);

    const saveHarness = harnessOf();

    expectEqual(
      await failureOf(() => save(actor, "address", saveHarness)),
      "PERMISSION_DENIED",
      `${label} may not move an onboarding`,
    );
    expectEqual(saveHarness.database.queries.length, 0, `and ${label} writes nothing`);
    expectEqual(saveHarness.database.updates.length + saveHarness.database.inserts.length, 0, `not one row`);
    expectEqual(saveHarness.audit.entries.length, 0, `and ${label} leaves no audit entry`);
  }
}

/** ---- The read: the caller's own company, one live row, or an honest "nothing saved yet". */
async function checkRead(): Promise<void> {
  const empty = harnessOf();
  const unsaved = readOnboardingProgress({ actor: owner }, empty.dependencies);
  const first = await unsaved;

  expectEqual(first.saved, false, "a company with no row has nothing saved");
  expectEqual(first.companyId, COMPANY_A, "the company is the actor's");
  expectEqual(first.currentStep, ONBOARDING_START_STEP, "and the wizard opens on the first step");
  expectDeepEqual(first.completedSteps, [], "with no step finished");
  expectEqual(first.startedAtEpochMs, null, "and no start instant");
  expectEqual(first.updatedAtEpochMs, null, "and no save instant");
  expectEqual(first.completedCount, 0, "no step is counted as finished");
  expectEqual(first.remainingCount, ONBOARDING_STEP_COUNT, "and all six are ahead");
  expectEqual(empty.audit.entries.length, 0, "reading is not an act, so nothing is audited");
  expectEqual(
    empty.database.queries.length,
    1,
    "one read answers the whole screen",
  );

  const readQuery = decodeURIComponent(empty.database.queries[0] ?? "");
  expect(readQuery.includes(`company_id=eq.${COMPANY_A}`), "scoped to the actor's own company");
  expect(readQuery.includes("deleted_at=is.null"), "over live rows only");
  expect(readQuery.includes("limit=1"), "and at most one row");
  expect(readQuery.includes("users_email_key") === false, "no other index is involved");

  const started = harnessOf([
    progressRow({ current_step: "category", completed_steps: ["business", "address"] }),
  ]);
  const saved = await readOnboardingProgress({ actor: owner }, started.dependencies);

  expectEqual(saved.saved, true, "a company with a row has a position");
  expectEqual(saved.currentStep, "category", "the step the row names");
  expectEqual(saved.completedSteps.join(","), "business,address", "and the steps it marks finished");
  expectEqual(saved.completedCount, 2, "two steps are finished");
  expectEqual(saved.remainingCount, ONBOARDING_STEP_COUNT - 2, "and four are ahead");
  expectEqual(saved.startedAtEpochMs, Date.parse("2026-11-01T09:00:00.000Z"), "the start instant is the row's");
  expectEqual(saved.updatedAtEpochMs, Date.parse("2026-11-01T09:30:00.000Z"), "and so is the save instant");

  // The same database, read by the owner of another company: the row of A is not B's to see.
  const otherTenant = harnessOf([progressRow()]);
  const refusedRow = await readOnboardingProgress({ actor: otherOwner }, otherTenant.dependencies);

  expectEqual(refusedRow.saved, false, "another merchant's row is not this merchant's progress");
  expectEqual(refusedRow.companyId, COMPANY_B, "the other owner reads their own company");
  expect(
    (otherTenant.database.queries[0] ?? "").includes(encodeURIComponent(COMPANY_B)),
    "and the query names their company, never the row's",
  );

  // A row this build cannot read is a defect, not an empty wizard.
  const broken = harnessOf([progressRow({ current_step: "billing" })]);

  expectEqual(
    await failureOf(() => readOnboardingProgress({ actor: owner }, broken.dependencies)),
    "INTERNAL_ERROR",
    "a step name this build does not know is a defect rather than an empty state",
  );

  const brokenList = harnessOf([progressRow({ completed_steps: ["business", "billing"] })]);

  expectEqual(
    await failureOf(() => readOnboardingProgress({ actor: owner }, brokenList.dependencies)),
    "INTERNAL_ERROR",
    "and so is an unknown name inside the finished list",
  );
}

/** ---- The save: a position, validated, audited, and idempotent. */
async function checkSaveValidation(): Promise<void> {
  for (const step of ["", "billing", "Business", "business ", " business", "six"]) {
    const harness = harnessOf();

    expectEqual(
      await failureOf(() => save(owner, step, harness)),
      "VALIDATION_FAILED",
      `"${step}" is refused`,
    );
    expectDeepEqual(
      await detailOf(() => save(owner, step, harnessOf())),
      [{ field: "step", rule: "unknown_step" }],
      `and "${step}" names the field and the rule`,
    );
    expectEqual(harness.database.queries.length, 0, "a refused step reads nothing");
    expectEqual(harness.database.inserts.length, 0, "and writes nothing");
    expectEqual(harness.audit.entries.length, 0, "and leaves no audit entry");
  }
}

async function checkSaveCreates(): Promise<void> {
  const harness = harnessOf();
  const result = await save(owner, "address", harness);

  expectEqual(harness.database.inserts.length, 1, "the first save inserts one row");
  expectDeepEqual(
    harness.database.inserts[0],
    { company_id: COMPANY_A, updated_by: OWNER_ID, current_step: "address" },
    "for the actor's company, naming the actor, on the step they chose",
  );
  expectEqual(harness.database.updates.length, 0, "and updates nothing");
  expectEqual(result.saved, true, "the answer says the position is saved");
  expectEqual(result.currentStep, "address", "on the step that was chosen");
  expectEqual(result.startedAtEpochMs, NOW, "the start instant is the first save");
  expectEqual(result.updatedAtEpochMs, NOW, "and so is the save instant");
  expectEqual(harness.audit.entries.length, 1, "one save is one audit entry");
  expectEqual(harness.audit.entries[0]?.action, ONBOARDING_AUDIT_ACTION, "under the onboarding action");
  expectEqual(harness.audit.entries[0]?.actorUserId, OWNER_ID, "naming the merchant who saved");
  expectEqual(harness.audit.entries[0]?.entityId, COMPANY_A, "against the merchant company");
  expectEqual(harness.audit.entries[0]?.companyId, COMPANY_A, "on that company's chain");
  expectEqual(harness.audit.entries[0]?.ipAddress, "198.51.100.9", "with the address it came from");
  expectEqual(harness.audit.entries[0]?.userAgent, "gate", "and the client it came from");
  expectDeepEqual(
    harness.audit.entries[0]?.payload,
    { step: "address", previous_step: null, created: true, saved_at: new Date(NOW).toISOString() },
    "and says which step, from where, and when",
  );
}

async function checkSaveUpdates(): Promise<void> {
  const harness = harnessOf([
    progressRow({ current_step: "business", completed_steps: ["business"] }),
  ]);
  const result = await save(owner, "documents", harness);

  expectEqual(harness.database.inserts.length, 0, "a second save inserts nothing");
  expectEqual(harness.database.updates.length, 1, "it updates the one row");
  const update = harness.database.updates[0];

  expectEqual(
    decodeURIComponent(update?.query ?? ""),
    `company_id=eq.${COMPANY_A}&deleted_at=is.null`,
    "scoped to the actor's company and to the live row",
  );
  expectDeepEqual(
    update?.values,
    { current_step: "documents", updated_by: OWNER_ID },
    "moving the position and naming who moved it",
  );
  expectEqual(result.currentStep, "documents", "the answer is the new position");
  expectEqual(result.completedSteps.join(","), "business", "the finished steps are the row's, untouched");
  expectEqual(result.completedCount, 1, "and so is the count");
  expectEqual(result.updatedAtEpochMs, NOW, "with the new save instant");
  expectEqual(harness.audit.entries.length, 1, "one entry for one move");
  expectDeepEqual(
    harness.audit.entries[0]?.payload,
    { step: "documents", previous_step: "business", created: false, saved_at: new Date(NOW).toISOString() },
    "and it says which step it moved from",
  );
}

async function checkSaveIsIdempotent(): Promise<void> {
  const harness = harnessOf([progressRow({ current_step: "category" })]);
  const result = await save(owner, "category", harness);

  expectEqual(harness.database.updates.length, 0, "saving the step it is already on writes nothing");
  expectEqual(harness.database.inserts.length, 0, "and inserts nothing");
  expectEqual(harness.audit.entries.length, 0, "and audits nothing, because nothing happened");
  expectEqual(result.currentStep, "category", "while the answer is still the position");

  const twice = harnessOf();
  const first = await save(owner, "website", twice);
  const second = await save(owner, "website", twice);

  expectEqual(twice.database.updates.length, 0, "a repeated first save does not update after the insert");
  expectEqual(twice.audit.entries.length, 1, "and the pair of presses leaves one entry");
  expectDeepEqual(second, first, "the second press answers exactly what the first did");
}

async function checkRaceOnInsert(): Promise<void> {
  const harness = harnessOf();

  harness.database.conflictOnInsert = true;

  const result = await save(owner, "business", harness);

  expectEqual(harness.database.inserts.length, 0, "the losing insert writes no row");
  expectEqual(harness.database.updates.length, 1, "the second tab becomes the update it would have been");
  expectEqual(result.currentStep, "business", "and the position is the one it asked for");
  expectEqual(harness.database.rows.length, 0, "the store is left with the single row the winner wrote");
  expectEqual(harness.audit.entries.length, 1, "and one entry, not two");
  expectEqual(harness.audit.entries[0]?.payload["created"], false, "recorded as a move rather than a start");
}

async function checkBrokenRowOnSave(): Promise<void> {
  const harness = harnessOf([progressRow({ current_step: "billing" })]);

  expectEqual(
    await failureOf(() => save(owner, "address", harness)),
    "INTERNAL_ERROR",
    "a row this build cannot read stops the save",
  );
  expectEqual(harness.database.updates.length, 0, "before anything is written");
  expectEqual(harness.audit.entries.length, 0, "and before anything is audited");
}

/** ---- The sources: the migration, the service order, the route, the page and the client. */
async function checkSources(): Promise<void> {
  const migration = await readRepositoryFile("migrations/0102_onboarding_progress.sql");
  const rollback = await readRepositoryFile("migrations/0102_onboarding_progress.down.sql");
  const stepNames = await readRepositoryFile("services/kyc/onboarding-steps.ts");
  const progress = await readRepositoryFile("services/kyc/onboarding-progress.ts");
  const route = await readRepositoryFile("app/api/onboarding/progress/route.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/page.tsx");
  const wizard = await readRepositoryFile("app/(dashboard)/onboarding/onboarding-wizard.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const actor = await readRepositoryFile("app/(dashboard)/onboarding/owner-actor.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  // SQL states its path with the SQL comment marker, every other file with the TypeScript one.
  expectEqual(
    migration.split("\n")[0],
    "-- path: migrations/0102_onboarding_progress.sql",
    "the migration states its own path on its first line",
  );
  expectEqual(
    rollback.split("\n")[0],
    "-- path: migrations/0102_onboarding_progress.down.sql",
    "and so does its rollback",
  );

  for (const [path, source] of [
    ["services/kyc/onboarding-steps.ts", stepNames],
    ["services/kyc/onboarding-progress.ts", progress],
    ["app/api/onboarding/progress/route.ts", route],
    ["app/(dashboard)/onboarding/page.tsx", page],
    ["app/(dashboard)/onboarding/onboarding-wizard.tsx", wizard],
    ["app/(dashboard)/onboarding/step-copy.ts", copy],
    ["app/(dashboard)/onboarding/owner-actor.ts", actor],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  // ---- the migration: the table, the rule, and the six names in one place
  expect(migration.includes("create table public.onboarding_progress"), "the migration creates the table");
  expect(migration.includes("onboarding_progress_company_key"), "with one live row per company");
  expect(
    migration.includes("where deleted_at is null"),
    "the unique index is partial, so a deleted row frees the company",
  );
  expect(
    migration.includes("public.onboarding_completed_steps_valid(completed_steps)"),
    "and the finished list is checked by the function",
  );
  expect(
    migration.includes("alter table public.onboarding_progress enable row level security;"),
    "the table enables row level security",
  );
  expect(
    migration.includes("create policy onboarding_progress_default_deny"),
    "and refuses every browser role",
  );

  for (const step of ONBOARDING_STEPS) {
    expect(migration.includes(`'${step}'`), `the migration knows the ${step} step`);
  }

  expectEqual(
    (migration.match(/create table/gu) ?? []).length,
    1,
    "this migration creates one table",
  );
  expect(rollback.includes("drop table if exists public.onboarding_progress;"), "the rollback drops the table");
  expect(
    rollback.includes("drop function if exists public.onboarding_completed_steps_valid(jsonb);"),
    "and the rule it created",
  );
  expectEqual(rollback.includes("drop table if exists public.companies"), false, "and nothing another file owns");

  // ---- the vocabulary is imported, never restated
  for (const [path, source] of [
    ["the service", progress],
    ["the page", page],
    ["the client component", wizard],
  ] as const) {
    expect(source.includes("onboarding-steps"), `${path} imports the step vocabulary`);
  }

  expectEqual(progress.includes('"business",'), false, "the service keeps no copy of the step names");
  expectEqual(wizard.includes('"documents",'), false, "and neither does the client component");

  // ---- the service: the tenant first, then the read
  expect(progress.includes("requireAnyRole(actor, ONBOARDING_OWNER_ROLES)"), "the service asks the owner role");
  expect(progress.includes("requireCompanyId(actor)"), "and takes the company from the session");
  expect(
    progress.indexOf("requireOnboardingCompany(input.actor)") <
      progress.indexOf("await readProgressRow(companyId"),
    "before the first query",
  );
  expectEqual(progress.includes("input.companyId"), false, "the service never reads a company from its input");
  expectEqual(progress.includes("company_id=eq."), true, "it filters by the actor's company in the query");
  expect(progress.includes("deleted_at=is.null"), "and reads live rows only");

  // ---- the route: token, session, body, service
  expect(route.includes('requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure })'), "the route checks the CSRF token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it looks the session up",
  );
  expect(route.indexOf("readRequestActor(") < route.indexOf("JSON.parse("), "which is before the body is parsed");
  expect(route.indexOf("JSON.parse(") < route.indexOf("saveOnboardingStep("), "and the service runs last");
  expect(route.includes('readField(body, "step")'), "the body is read for one field");
  expectEqual(route.includes('readField(body, "companyId")'), false, "and never for a company");
  expect(route.includes("maximumBodyBytes = 1_024"), "the body is bounded");
  expect(route.includes('"cache-control": "no-store"'), "the answer is not cached");
  expectEqual(
    route.includes("verifySensitiveRequest("),
    false,
    "the route asks for no device proof: a merchant who just signed up has no confirmed device",
  );

  // ---- the screen: one reader, no role literal, one endpoint
  expect(page.includes("readOwnerActor()"), "the page reads the account through the cached reader");
  expect(page.includes("readOnboardingProgress("), "and the position through the service");
  expect(page.includes("<SessionKeeper"), "and keeps the session rotating while it is read");
  expectEqual(/(super_admin|compliance_kyc|finance_ops)/u.test(page), false, "the page names no office role");
  expectEqual(wizard.includes("<SessionKeeper"), false, "the client component does not mount a second keeper");
  expectEqual(
    (wizard.match(/PROGRESS_PATH = "\/api\/onboarding\/progress"/u) ?? []).length,
    1,
    "the client posts to one path",
  );
  expectEqual((wizard.match(/fetch\(/gu) ?? []).length, 1, "with one fetch site");
  expectEqual((wizard.match(/fetch\(PROGRESS_PATH/gu) ?? []).length, 1, "to that path");
  expect(wizard.includes("csrfHeaders()"), "carrying the CSRF token");
  expect(wizard.includes("router.refresh()"), "and re-reading the position from the server afterwards");
  expectEqual(wizard.includes("localStorage"), false, "the position is never kept in the browser");
  expectEqual(wizard.includes("process.env"), false, "and no environment is read in the client");
  expect(copy.includes("onboarding.step."), "the step copy is named by catalog key");
  expectEqual(copy.includes("import { ONBOARDING_STEPS"), false, "the copy map holds no order of its own");

  // ---- the registry: the new mutation is on the platform's list
  expect(csrf.includes('"/api/onboarding/progress",'), "the save route is on the CSRF-protected list");

  // ---- the files exist where the ownership rules put them
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/", repositoryRoot))).includes("page.tsx"),
    "the screen lives in the merchant dashboard area",
  );
  expect(
    (await readdir(new URL("app/api/onboarding/progress/", repositoryRoot))).includes("route.ts"),
    "and its handler is a route handler of its own",
  );
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("onboarding-progress.ts"),
    "the service lives in services/kyc",
  );
}

/** ---- The catalog: every key used, every used key present, and no half substituted sentence. */
async function checkCatalog(): Promise<void> {
  const block = en.onboarding as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/page.tsx");
  const wizard = await readRepositoryFile("app/(dashboard)/onboarding/onboarding-wizard.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const sources = `${page}\n${wizard}\n${copy}`;

  expect(Object.keys(block).length > 20, "the wizard has its own block of copy");

  const flat: string[] = [];

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}.${key}`;

      if (typeof value === "string") {
        flat.push(path);
      } else if (typeof value === "object" && value !== null) {
        walk(value as Record<string, unknown>, path);
      }
    }
  };

  walk(block, "onboarding");

  expect(flat.length > 30, "and more than thirty sentences");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by a screen`);
  }

  const referenced = [...sources.matchAll(/"(onboarding\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screens name no missing key (${String(path)})`);
  }

  for (const step of ONBOARDING_STEPS) {
    expect(flat.includes(`onboarding.step.${step}.label`), `the ${step} step has a label`);
    expect(flat.includes(`onboarding.step.${step}.description`), `and a description`);
  }

  expectEqual(
    sources.includes('getMessage("onboarding.progressLine")'),
    false,
    "the templated progress line is never rendered without its values",
  );
  expect(
    sources.includes('formatMessage("onboarding.progressLine"'),
    "and is rendered through formatMessage",
  );
}

/** ---- The migration set: this STEP adds one file pair and nothing else. */
async function checkMigrationSet(): Promise<void> {
  const files = await readdir(new URL("migrations/", repositoryRoot));
  const numbers = files
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .map((name) => name.slice(0, 4));

  expectEqual(numbers.includes("0102"), true, "STEP 079's migration is in the set");
  expectEqual(numbers.includes("0103"), true, "STEP 080's is too");
  expectEqual(numbers.includes("0104"), true, "STEP 081's is too");
  expectEqual(numbers.includes("0105"), false, "and nothing beyond them");
  expectEqual(Math.max(...numbers.map((number) => Number.parseInt(number, 10))), 104, "the set ends at 0104");
}

/* -------------------------------------------------------------------------------------------------
 * STEP 080: the business information form, its matrix and its save.
 * ---------------------------------------------------------------------------------------------- */

interface BusinessRowShape {
  company_id: string;
  legal_name: string | null;
  trading_name: string | null;
  business_type: string | null;
  registration_number: string | null;
  tax_id: string | null;
  website: string | null;
  business_description: string | null;
  mcc_code: string | null;
  completed_at: string | null;
  updated_at: string;
}

/** One row of the `0077` vocabulary, as the fake store holds it. `deleted_at` is always null. */
interface MccRowShape {
  code: string;
  title: string;
  is_active: boolean;
}

/** The vocabulary the category gate works against: three active codes and one retired one. */
function defaultMccRows(): MccRowShape[] {
  return [
    { code: "0742", title: "Veterinary Services", is_active: true },
    { code: "5411", title: "Grocery Stores, Supermarkets", is_active: true },
    { code: "5812", title: "Eating places and Restaurants", is_active: true },
    { code: "0001", title: "Retired Example Code", is_active: false },
  ];
}

interface BusinessDatabase {
  readonly profileRows: BusinessRowShape[];
  readonly onboardingRows: ProgressRowShape[];
  readonly mccRows: MccRowShape[];
  readonly queries: string[];
  readonly inserts: { readonly table: string; readonly row: Readonly<Record<string, unknown>> }[];
  readonly updates: {
    readonly table: string;
    readonly query: string;
    readonly values: Readonly<Record<string, unknown>>;
  }[];
  conflictOnInsert: boolean;
}

function businessRow(overrides: Partial<BusinessRowShape> = {}): BusinessRowShape {
  return {
    company_id: COMPANY_A,
    legal_name: null,
    trading_name: null,
    business_type: null,
    registration_number: null,
    tax_id: null,
    website: null,
    business_description: null,
    mcc_code: null,
    completed_at: null,
    updated_at: "2026-11-01T09:30:00.000Z",
    ...overrides,
  };
}

function createBusinessDatabase(
  profileRows: readonly BusinessRowShape[] = [],
  onboardingRows: readonly ProgressRowShape[] = [],
  mccRows: readonly MccRowShape[] = defaultMccRows(),
): BusinessDatabase {
  return {
    profileRows: [...profileRows],
    onboardingRows: [...onboardingRows],
    mccRows: [...mccRows],
    queries: [],
    inserts: [],
    updates: [],
    conflictOnInsert: false,
  };
}

const EMPTY_PROFILE_COLUMNS = [
  "legal_name",
  "trading_name",
  "business_type",
  "registration_number",
  "tax_id",
  "website",
  "business_description",
] as const;

function profileRowFrom(companyId: string, values: Readonly<Record<string, unknown>>): BusinessRowShape {
  const stored = businessRow({ company_id: companyId, updated_at: new Date(NOW).toISOString() });

  for (const column of EMPTY_PROFILE_COLUMNS) {
    const value = values[column];
    stored[column] = typeof value === "string" ? value : null;
  }

  const completed = values["completed_at"];
  stored.completed_at = typeof completed === "string" ? completed : null;

  const mcc = values["mcc_code"];
  stored.mcc_code = typeof mcc === "string" ? mcc : null;

  return stored;
}

/** The store the form writes through: two tables, and nothing else answers. */
function createBusinessStore(database: BusinessDatabase): RestClient {
  const scopedCompany = (query: string): string => {
    const company = query
      .split("&")
      .find((part) => part.startsWith("company_id=eq."));

    if (company === undefined || !query.split("&").includes("deleted_at=is.null")) {
      throw new Error(`the form's query is not scoped to one live company: ${query}`);
    }

    return decodeURIComponent(company.slice("company_id=eq.".length));
  };

  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      // The vocabulary of `0077` is a platform table: company_id is always null there, so it is
      // scoped by its own filters instead of by a company.
      if (table === MCC_CODES_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the vocabulary read is not over live rows: ${query}`));
        }

        const codeFilter = parts.find((part) => part.startsWith("code=eq."));
        const activeOnly = parts.includes("is_active=is.true");
        const limit = parts.find((part) => part.startsWith("limit="));
        const ordered = parts.includes("order=code.asc");

        let matched = database.mccRows.filter((row) => (activeOnly ? row.is_active : true));

        if (codeFilter !== undefined) {
          const wanted = decodeURIComponent(codeFilter.slice("code=eq.".length));
          matched = matched.filter((row) => row.code === wanted);
        }

        if (ordered) {
          matched = [...matched].sort((left, right) => left.code.localeCompare(right.code));
        }

        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        return Promise.resolve(capped.map((row) => schema.parse(row)));
      }

      const wanted = scopedCompany(query);

      if (table === BUSINESS_PROFILE_TABLE) {
        const limit = query.split("&").find((part) => part.startsWith("limit="));

        if (limit === undefined) {
          return Promise.reject(new Error(`the profile read is unbounded: ${query}`));
        }

        const matched = database.profileRows.filter((row) => row.company_id === wanted);

        return Promise.resolve(matched.slice(0, 1).map((row) => schema.parse(row)));
      }

      if (table === ONBOARDING_PROGRESS_TABLE) {
        const matched = database.onboardingRows.filter((row) => row.company_id === wanted);

        return Promise.resolve(matched.slice(0, 1).map((row) => schema.parse(row)));
      }

      return Promise.reject(new Error(`the form reads no other table: ${table}`));
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      for (const row of rows) {
        if (table === BUSINESS_PROFILE_TABLE) {
          if (database.conflictOnInsert) {
            database.conflictOnInsert = false;

            return Promise.reject(new AppError("CONFLICT", { cause: { code: UNIQUE_VIOLATION } }));
          }

          database.inserts.push({ table, row: { ...row } });
          database.profileRows.push(profileRowFrom(String(row["company_id"] ?? ""), row));

          continue;
        }

        if (table === ONBOARDING_PROGRESS_TABLE) {
          database.inserts.push({ table, row: { ...row } });
          database.onboardingRows.push({
            company_id: String(row["company_id"] ?? ""),
            current_step: String(row["current_step"] ?? ""),
            completed_steps: row["completed_steps"] ?? [],
            started_at: new Date(NOW).toISOString(),
            updated_at: new Date(NOW).toISOString(),
          });

          continue;
        }

        return Promise.reject(new Error(`the form inserts into no other table: ${table}`));
      }

      return Promise.resolve();
    },
    insertReturning(): Promise<never> {
      return Promise.reject(new Error("the form inserts without reading the row back"));
    },
    update(
      table: string,
      query: string,
      values: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      database.updates.push({ table, query, values });

      const wanted = scopedCompany(query);

      if (table === BUSINESS_PROFILE_TABLE) {
        for (const row of database.profileRows) {
          if (row.company_id === wanted) {
            // A patch touches the columns it names, and only those: the rest keep what they held.
            for (const column of EMPTY_PROFILE_COLUMNS) {
              if (!(column in values)) {
                continue;
              }

              const value = values[column];
              row[column] = typeof value === "string" ? value : null;
            }

            if ("completed_at" in values) {
              const completed = values["completed_at"];
              row.completed_at = typeof completed === "string" ? completed : null;
            }

            if ("mcc_code" in values) {
              const mcc = values["mcc_code"];
              row.mcc_code = typeof mcc === "string" ? mcc : null;
            }

            row.updated_at = new Date(NOW).toISOString();
          }
        }

        return Promise.resolve();
      }

      if (table === ONBOARDING_PROGRESS_TABLE) {
        for (const row of database.onboardingRows) {
          if (row.company_id === wanted) {
            row.completed_steps = values["completed_steps"] ?? row.completed_steps;
            row.current_step = String(values["current_step"] ?? row.current_step);
          }
        }

        return Promise.resolve();
      }

      return Promise.reject(new Error(`the form updates no other table: ${table}`));
    },
    rpc(name: string): Promise<never> {
      return Promise.reject(new Error(`the form calls no function: ${name}`));
    },
  };
}

const COMPLETE_FORM: Readonly<Record<BusinessProfileField, string>> = Object.freeze({
  legal_name: "Acme Trading Ltd",
  trading_name: "Acme",
  business_type: "company",
  registration_number: "C-1234567",
  tax_id: "TIN-7654321",
  website: "https://acme-kitchen.com/",
  business_description: "Sells imported kitchen equipment to restaurants in Dhaka.",
});

function dependenciesOf(
  database: BusinessDatabase,
  audit: InMemoryAuditTrail,
): { readonly rest: RestClient; readonly audit: InMemoryAuditTrail; readonly now: () => number } {
  return { rest: createBusinessStore(database), audit, now: () => NOW };
}

async function rejectionOf(
  action: () => Promise<unknown>,
): Promise<AppError | null> {
  try {
    await action();
  } catch (error) {
    return error instanceof AppError ? error : null;
  }

  return null;
}

/** ---- The matrix: seven fields, five processors, and the union the form marks required. */
function checkBusinessMatrix(): void {
  expectDeepEqual(
    [...BUSINESS_PROFILE_FIELDS],
    [
      "legal_name",
      "trading_name",
      "business_type",
      "registration_number",
      "tax_id",
      "website",
      "business_description",
    ],
    "the form asks for the seven business facts, in this order",
  );

  expectEqual(PROCESSOR_REQUIREMENT_LIST.length, PLATFORM_PROVIDERS.length, "one row per processor on the platform");
  expectDeepEqual(
    PROCESSOR_REQUIREMENT_LIST.map((requirement) => requirement.provider),
    PLATFORM_PROVIDERS.map((provider) => provider.key),
    "in the registry's own order",
  );

  for (const provider of PLATFORM_PROVIDERS) {
    const requirement = PROCESSOR_REQUIREMENTS[provider.key];

    expectEqual(requirement.provider, provider.key, `${provider.key} answers under its own key`);
    expect(requirement.displayName.length > 0, `${provider.key} carries the panel's display name`);
    expect(requirement.required.length > 0, `${provider.key} insists on something`);
    expect(
      requirement.required.every((field) => BUSINESS_PROFILE_FIELDS.includes(field)),
      `${provider.key} requires only fields the form collects`,
    );
    expect(
      requirement.optional.every((field) => BUSINESS_PROFILE_FIELDS.includes(field)),
      `${provider.key} accepts only fields the form collects`,
    );
    expect(
      requirement.required.every((field) => !requirement.optional.includes(field)),
      `${provider.key} does not call one field both required and optional`,
    );
    expectEqual(
      new Set(requirement.required).size,
      requirement.required.length,
      `${provider.key} names no required field twice`,
    );
  }

  expectDeepEqual(
    PROCESSOR_REQUIREMENTS.nmi.required,
    ["legal_name", "business_type", "website", "business_description"],
    "NMI asks for the gateway sub-merchant facts",
  );
  expectDeepEqual(
    PROCESSOR_REQUIREMENTS.payoneer.required,
    ["legal_name", "business_type", "tax_id"],
    "Payoneer asks for the payee facts and no website",
  );
  expectDeepEqual(
    PROCESSOR_REQUIREMENTS.rainforest.required,
    ["legal_name", "business_type", "registration_number", "tax_id", "website"],
    "Rainforest asks for the registration number and the tax id",
  );
  expectDeepEqual(
    PROCESSOR_REQUIREMENTS.stripe_connect.required,
    ["legal_name", "business_type", "tax_id", "website"],
    "Stripe Connect asks for the tax id and the website",
  );
  expectDeepEqual(
    PROCESSOR_REQUIREMENTS.airwallex.required,
    [
      "legal_name",
      "trading_name",
      "business_type",
      "registration_number",
      "website",
    ],
    "Airwallex is the one processor that insists on a trading name",
  );

  const tradingName = PROCESSOR_REQUIREMENT_LIST.filter((requirement) =>
    requirement.required.includes("trading_name"),
  );

  expectEqual(tradingName.length, 1, "only one processor requires the trading name");
  expectEqual(OPTIONAL_BUSINESS_FIELDS.length, 0, "and every field is therefore required by someone");
  expectDeepEqual(
    [...REQUIRED_BUSINESS_FIELDS],
    [...BUSINESS_PROFILE_FIELDS],
    "so the form marks all seven as required",
  );
  expectEqual(
    BUSINESS_PROFILE_FIELDS.every((field) =>
      PROCESSOR_REQUIREMENT_LIST.some(
        (requirement) =>
          requirement.required.includes(field) || requirement.optional.includes(field),
      ),
    ),
    true,
    "and every field reaches at least one processor",
  );
}

/** ---- The parse: one field, one rule, and a key nobody knows refused rather than dropped. */
function checkBusinessParse(): void {
  const clean = parseBusinessProfileInput({ ...COMPLETE_FORM });

  expectEqual(clean.problems.length, 0, "a complete body parses");
  expectEqual(Object.keys(clean.values).length, 7, "with all seven values");
  expectDeepEqual(clean.values, { ...COMPLETE_FORM }, "unchanged where they were already clean");

  const padded = parseBusinessProfileInput({ legal_name: "   Acme   Trading   Ltd  " });

  expectEqual(
    padded.values.legal_name,
    "Acme Trading Ltd",
    "and whitespace is collapsed before the value is stored",
  );

  const unknown = parseBusinessProfileInput({ legal_name: "Acme", turnover: "1000" });

  expectEqual(unknown.problems.length, 1, "a key outside the seven is a problem");
  expectDeepEqual(
    unknown.problems[0],
    { field: "turnover", rule: "unknown_key" },
    "named as an unknown key",
  );
  expectEqual("turnover" in unknown.values, false, "and nothing of it is stored");

  const notAnObject = parseBusinessProfileInput(["legal_name"]);

  expectDeepEqual(
    notAnObject.problems,
    [{ field: "profile", rule: "invalid_format" }],
    "a body that is not an object is refused whole",
  );

  const wrongType = parseBusinessProfileInput({ tax_id: 12345 });

  expectDeepEqual(
    wrongType.problems,
    [{ field: "tax_id", rule: "invalid_format" }],
    "a number where text belongs is a format problem",
  );

  const cleared = parseBusinessProfileInput({ tax_id: "" });

  expectEqual(cleared.problems.length, 0, "an empty string is a deliberate clear");
  expectEqual(cleared.values.tax_id, null, "and answers null");

  const insecure = parseBusinessProfileInput({ website: "http://acme-kitchen.com" });

  expectEqual(insecure.problems.length, 1, "a plain-http website is refused");
  expectEqual(insecure.problems[0]?.field, "website", "on the website field");
  expectEqual(insecure.problems[0]?.rule, "unsupported_scheme", "because only https is reviewed");

  const longName = parseBusinessProfileInput({ legal_name: "A".repeat(BUSINESS_FIELD_LIMITS.legal_name + 1) });

  expectDeepEqual(
    longName.problems,
    [{ field: "legal_name", rule: "too_long" }],
    "an over-long name is refused rather than quietly shortened",
  );

  const shortDescription = parseBusinessProfileInput({ business_description: "Too short" });

  expectDeepEqual(
    shortDescription.problems,
    [{ field: "business_description", rule: "too_short" }],
    "a description under ten characters is refused",
  );

  const unknownType = parseBusinessProfileInput({ business_type: "partnership" });

  expectDeepEqual(
    unknownType.problems,
    [{ field: "business_type", rule: "unknown_value" }],
    "a business type the platform does not store is refused",
  );

  const typed = parseBusinessProfileInput({ business_type: "  Company " });

  expectEqual(typed.values.business_type, "company", "and the accepted one is normalised");
}

/** ---- The read: the caller's own company, or nothing at all. */
async function checkBusinessRead(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase([businessRow()]);
    const refusal = await rejectionOf(() =>
      readBusinessProfile({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the profile refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads no row for ${description}`);
  }

  const empty = await readBusinessProfile(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(empty.saved, false, "a merchant with no row is answered, not refused");
  expectEqual(empty.complete, false, "with an empty profile");
  expectEqual(empty.savedAtEpochMs, null, "that has never been saved");
  expectEqual(empty.missing.length, 7, "and every field missing");

  const stored = await readBusinessProfile(
    { actor: owner },
    dependenciesOf(
      createBusinessDatabase([
        businessRow({
          legal_name: "Acme Trading Ltd",
          trading_name: "Acme",
          business_type: "company",
          registration_number: "C-1234567",
          tax_id: "TIN-7654321",
          website: "https://acme-kitchen.com/",
          business_description: "Sells imported kitchen equipment to restaurants in Dhaka.",
          completed_at: "2026-11-01T09:00:00.000Z",
        }),
      ]),
      createInMemoryAuditTrail(),
    ),
  );

  expectEqual(stored.saved, true, "a stored profile is read back");
  expectEqual(stored.complete, true, "complete when every fact is present");
  expectEqual(stored.missing.length, 0, "with nothing missing");
  expectEqual(stored.coverage.length, PLATFORM_PROVIDERS.length, "and one coverage row per processor");
  expectEqual(
    stored.coverage.every((row) => row.missing.length === 0),
    true,
    "where no processor is short of anything",
  );
}

/** ---- The save: a patch, one audit entry, and the wizard's position kept in step. */
async function checkBusinessSave(): Promise<void> {
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const first = await saveBusinessProfile(
    { actor: owner, input: { legal_name: "Acme Trading Ltd" }, ipAddress: "203.0.113.9", userAgent: "gate" },
    dependenciesOf(database, audit),
  );

  expectEqual(first.companyId, COMPANY_A, "the row is written for the actor's own company");
  expectEqual(database.inserts.length, 1, "the first save inserts one row");
  expectEqual(database.inserts[0]?.table, BUSINESS_PROFILE_TABLE, "into the business profile table");
  expectEqual(
    database.inserts[0]?.row["company_id"],
    COMPANY_A,
    "with the company taken from the session",
  );
  expectEqual(database.inserts[0]?.row["legal_name"], "Acme Trading Ltd", "and the field that was sent");
  expectEqual(database.inserts[0]?.row["completed_at"], null, "with no completion stamp yet");
  expectEqual(
    "updated_by" in (database.inserts[0]?.row ?? {}),
    false,
    "and no column the table does not own",
  );
  expectEqual(first.complete, false, "an incomplete profile is not complete");
  expectEqual(first.saved, true, "but it is saved");
  expectEqual(database.onboardingRows.length, 0, "and no wizard row is created for a draft");

  expectEqual(audit.entries.length, 1, "the save appends exactly one audit entry");
  expectEqual(
    audit.entries[0]?.action,
    BUSINESS_PROFILE_AUDIT_ACTION,
    "named business_profile.saved",
  );
  expectEqual(audit.entries[0]?.entityType, BUSINESS_PROFILE_AUDIT_ENTITY, "on its own entity");
  expectEqual(audit.entries[0]?.entityId, COMPANY_A, "naming the company");
  expectEqual(audit.entries[0]?.companyId, COMPANY_A, "scoped to the company");
  expectEqual(audit.entries[0]?.ipAddress, "203.0.113.9", "with the address it came from");
  expectDeepEqual(
    audit.entries[0]?.payload?.["fields"],
    ["legal_name"],
    "listing the fields the save named",
  );
  expectEqual(audit.entries[0]?.payload?.["complete"], false, "and that it is not complete");

  const second = await saveBusinessProfile(
    { actor: owner, input: { tax_id: "TIN-7654321" }, ipAddress: null, userAgent: null },
    dependenciesOf(database, audit),
  );

  expectEqual(database.inserts.length, 1, "a second save updates the row it found");
  expectEqual(database.updates.length, 1, "with one update");
  expectEqual(
    "legal_name" in (database.updates[0]?.values ?? {}),
    false,
    "naming only the columns the save carried",
  );
  expectEqual(database.updates[0]?.values["tax_id"], "TIN-7654321", "and storing the new one");
  expectEqual(
    database.profileRows[0]?.legal_name,
    "Acme Trading Ltd",
    "so the field another tab may have changed is never put back",
  );
  expectEqual(second.values.legal_name, "Acme Trading Ltd", "the answer still holds the earlier field");
  expectEqual(second.values.trading_name, null, "and a field nobody sent stays as it was");
  expectEqual(audit.entries.length, 2, "and a second audit entry is appended");

  const completed = await saveBusinessProfile(
    {
      actor: owner,
      input: {
        trading_name: "Acme",
        business_type: "company",
        registration_number: "C-1234567",
        website: "https://acme-kitchen.com/",
        business_description: "Sells imported kitchen equipment to restaurants in Dhaka.",
      },
      ipAddress: null,
      userAgent: null,
    },
    dependenciesOf(database, audit),
  );

  expectEqual(completed.complete, true, "the last required field completes the profile");
  expectEqual(
    database.updates[1]?.values["completed_at"],
    new Date(NOW).toISOString(),
    "and stamps the completion instant",
  );
  expectDeepEqual(
    Object.keys(database.updates[1]?.values ?? {}).sort(),
    [
      "business_description",
      "business_type",
      "completed_at",
      "registration_number",
      "trading_name",
      "website",
    ],
    "the patch carries the five fields this save named and the derived instant, and nothing else",
  );
  expectEqual(completed.completedAtEpochMs, NOW, "which is the save's own clock");
  expectEqual(audit.entries[2]?.payload?.["completed_now"], true, "recorded as a first completion");
  expectEqual(database.onboardingRows.length, 1, "and the wizard gets a row it never had");
  expectEqual(
    database.inserts[1]?.row["current_step"],
    "address",
    "opening on the step after business",
  );
  expectDeepEqual(
    database.inserts[1]?.row["completed_steps"],
    ["business"],
    "with the business step finished",
  );
  expectEqual(
    database.inserts[1]?.row["updated_by"],
    OWNER_ID,
    "and the merchant recorded as the writer",
  );

  const cleared = await saveBusinessProfile(
    { actor: owner, input: { tax_id: "" }, ipAddress: null, userAgent: null },
    dependenciesOf(database, audit),
  );

  expectEqual(cleared.complete, false, "clearing a required field uncompletes the profile");
  expectEqual(database.updates[2]?.values["completed_at"], null, "and removes the completion stamp");
  expectEqual(database.updates[3]?.table, ONBOARDING_PROGRESS_TABLE, "and steps the wizard back");
  expectDeepEqual(
    database.updates[3]?.values["completed_steps"],
    [],
    "removing the finished step",
  );
  expectEqual(
    audit.entries[3]?.payload?.["completed_now"],
    false,
    "which is not recorded as a completion",
  );
}

/** ---- The save's refusals, and the two racing tabs. */
async function checkBusinessSaveRefusals(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase();
    const audit = createInMemoryAuditTrail();
    const refusal = await rejectionOf(() =>
      saveBusinessProfile(
        { actor, input: { ...COMPLETE_FORM }, ipAddress: null, userAgent: null },
        dependenciesOf(database, audit),
      ),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the save refuses ${description}`);
    expectEqual(database.inserts.length + database.updates.length, 0, `and writes nothing for ${description}`);
    expectEqual(audit.entries.length, 0, `and audits nothing for ${description}`);
  }

  const database = createBusinessDatabase();
  const emptyBody = await rejectionOf(() =>
    saveBusinessProfile(
      { actor: owner, input: {}, ipAddress: null, userAgent: null },
      dependenciesOf(database, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(emptyBody?.code, "VALIDATION_FAILED", "an empty body is a validation failure");
  expectDeepEqual(
    emptyBody?.details,
    [{ field: "profile", rule: "required" }],
    "naming the whole profile as required",
  );
  expectEqual(database.inserts.length, 0, "with nothing written");

  const unknown = await rejectionOf(() =>
    saveBusinessProfile(
      { actor: owner, input: { legal_name: "Acme", turnover: "1000" }, ipAddress: null, userAgent: null },
      dependenciesOf(database, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknown?.code, "VALIDATION_FAILED", "an unknown key is a validation failure");
  expectEqual(unknown?.details?.length, 1, "naming exactly one problem");
  expectEqual(unknown?.details?.[0]?.rule, "unknown_key", "which is the unknown key");

  const several = await rejectionOf(() =>
    saveBusinessProfile(
      {
        actor: owner,
        input: { website: "javascript:alert(1)", business_type: "partnership", tax_id: 7 },
        ipAddress: null,
        userAgent: null,
      },
      dependenciesOf(database, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(several?.code, "VALIDATION_FAILED", "three bad fields fail one save");
  expectEqual(several?.details?.length, 3, "with every one of them named");

  const racing = createBusinessDatabase();
  racing.conflictOnInsert = true;
  const accounted = createInMemoryAuditTrail();

  const rescued = await saveBusinessProfile(
    { actor: owner, input: { legal_name: "Acme Trading Ltd" }, ipAddress: null, userAgent: null },
    dependenciesOf(racing, accounted),
  );

  expectEqual(rescued.saved, true, "a save that loses the insert race still saves");
  expectEqual(racing.updates.length, 1, "by becoming the update it would have been");
  expectEqual(accounted.entries.length, 1, "and is audited once");

  const throwingAudit = {
    append(): Promise<void> {
      return Promise.reject(new Error("the audit sink is down"));
    },
  };

  const stored = await saveBusinessProfile(
    { actor: owner, input: { legal_name: "Acme Trading Ltd" }, ipAddress: null, userAgent: null },
    { rest: createBusinessStore(createBusinessDatabase()), audit: throwingAudit, now: () => NOW },
  );

  expectEqual(stored.saved, true, "a save whose audit sink fails is still stored");

  const brokenRow = createBusinessDatabase([businessRow({ updated_at: "not a date" })]);
  const broken = await rejectionOf(() =>
    readBusinessProfile({ actor: owner }, dependenciesOf(brokenRow, createInMemoryAuditTrail())),
  );

  expectEqual(broken?.code, "INTERNAL_ERROR", "a row with an unreadable instant is a defect, not an empty profile");
}

/** ---- The source: the route, the screen and the migration say what this STEP promised. */
async function checkBusinessSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/onboarding/business-profile/route.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/business/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/business/business-form.tsx");
  const wizard = await readRepositoryFile("app/(dashboard)/onboarding/onboarding-wizard.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  expectEqual(form.includes('"use client"'), true, "the form is a client component");
  expectEqual(form.includes("BUSINESS_PROFILE_FIELDS"), true, "and draws its fields from the one list");
  expectEqual(form.includes("process.env"), false, "reading no environment");
  expect(form.includes('method: "POST"'), "and posting its save");
  expect(form.includes("csrfHeaders("), "with the CSRF token");
  expect(form.includes("JSON.stringify(values)"), "sending only the values it was given");
  expectEqual(form.includes("companyId:"), false, "and no company in the body");

  expectEqual(page.includes("readBusinessProfile("), true, "the page reads through the service");
  expectEqual(page.includes("SessionKeeper"), true, "and rotates the session while it is open");
  expectEqual(page.includes("BusinessForm"), true, "and renders the form");

  expectEqual(
    route.includes("requireCsrfToken(request"),
    true,
    "the route checks the token first",
  );
  expectEqual(
    route.indexOf("requireCsrfToken(request") < route.indexOf("readRequestActor("),
    true,
    "before it reads the session",
  );
  expect(route.includes("saveBusinessProfile("), "and saves through the service");
  expectEqual(route.includes("companyId ="), false, "taking no company from the caller");
  expectEqual(route.includes("maximumBodyBytes"), true, "and bounding the body it will read");

  expect(csrf.includes('"/api/onboarding/business-profile",'), "the save route is on the CSRF-protected list");

  expect(wizard.includes("onboardingStepFormHref("), "the wizard links for steps that have a form");
  expect(copy.includes('business: "/onboarding/business"'), "and the business step is the one that has one");

  const up = await readRepositoryFile("migrations/0103_business_profiles.sql");
  const down = await readRepositoryFile("migrations/0103_business_profiles.down.sql");

  expect(up.includes("create table public.business_profiles"), "0103 creates the table");
  for (const column of [...BUSINESS_PROFILE_FIELDS, "completed_at", "company_id"]) {
    expect(up.includes(`${column} `), `and carries the ${column} column`);
  }

  expect(up.includes("business_profiles_company_key"), "with one live row per company");
  expect(up.includes("enable row level security"), "and row level security on");
  expect(up.includes("business_profiles_completed_check"), "and a constraint that a complete profile has its facts");
  expect(down.includes("drop table if exists public.business_profiles"), "the rollback drops the table");
  expectEqual(down.includes("create table"), false, "and creates nothing");
}

/** ---- The catalog: every sentence of the form is used, and every key it names exists. */
async function checkBusinessCatalog(): Promise<void> {
  const block = en.onboardingBusiness as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/business/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/business/business-form.tsx");
  const sources = `${page}\n${form}`;

  const flat: string[] = [];

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}.${key}`;

      if (typeof value === "string") {
        flat.push(path);
      } else if (typeof value === "object" && value !== null) {
        walk(value as Record<string, unknown>, path);
      }
    }
  };

  walk(block, "onboardingBusiness");

  expect(flat.length > 30, "the form has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the form`);
  }

  const referenced = [...sources.matchAll(/"(onboardingBusiness\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the form names no missing key (${String(path)})`);
  }

  for (const field of BUSINESS_PROFILE_FIELDS) {
    expect(flat.includes(`onboardingBusiness.${camelOf(field)}`), `the ${field} field has a label`);
    expect(flat.includes(`onboardingBusiness.${camelOf(field)}Hint`), `and a hint`);
  }

  expectEqual(
    form.includes('getMessage("onboardingBusiness.missingLine")'),
    false,
    "the templated missing line is never rendered without its values",
  );
  expect(
    form.includes('formatMessage("onboardingBusiness.missingLine"'),
    "and is rendered through formatMessage",
  );
}

/** `legal_name` as the catalog spells it: `legalName`. */
function camelOf(field: string): string {
  return field.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

/* -------------------------------------------------------------------------------------------------
 * STEP 081: the merchant category code on the business profile, its vocabulary and its save.
 * ---------------------------------------------------------------------------------------------- */

function saveCategory(
  actor: RequestActor,
  input: unknown,
  database: BusinessDatabase,
  audit: InMemoryAuditTrail,
): Promise<MerchantCategorySnapshot> {
  return saveMerchantCategory(
    { actor, input, ipAddress: "203.0.113.9", userAgent: "gate" },
    dependenciesOf(database, audit),
  );
}

/** ---- The vocabulary: one field, one pattern, one audit action, and the category step. */
function checkCategoryVocabulary(): void {
  expectEqual(MCC_CODES_TABLE, "mcc_codes", "the code list is the table of 0077");
  expectEqual(MERCHANT_CATEGORY_FIELD, "mcc_code", "the save carries one field");
  expectEqual(MERCHANT_CATEGORY_AUDIT_ACTION, "merchant_category.saved", "a save is audited under one name");
  expectEqual(MERCHANT_CATEGORY_AUDIT_ENTITY, "merchant_category", "against its own entity");
  expectEqual(MERCHANT_CATEGORY_ONBOARDING_STEP, "category", "and it finishes the category step");

  for (const code of ["0742", "5411", "5812", "9999", "0000"]) {
    expect(MCC_CODE_PATTERN.test(code), `"${code}" is a four digit code, leading zeros kept`);
  }

  for (const code of ["", "742", "54111", "54a1", " 5411", "5411 ", "5 11", "abcd"]) {
    expectEqual(MCC_CODE_PATTERN.test(code), false, `"${code}" is not a code`);
  }
}

/** ---- The parse: one field, its rules, and a key nobody knows refused rather than dropped. */
function checkCategoryParse(): void {
  const clean = parseMerchantCategoryInput({ mcc_code: "5411" });

  expectEqual(clean.problems.length, 0, "a code parses");
  expectEqual(clean.value, "5411", "unchanged");

  const padded = parseMerchantCategoryInput({ mcc_code: "  5411  " });

  expectEqual(padded.value, "5411", "whitespace is removed before the pattern is applied");

  for (const clearing of [{ mcc_code: "" }, { mcc_code: "   " }, { mcc_code: null }]) {
    const parsed = parseMerchantCategoryInput(clearing);

    expectEqual(parsed.problems.length, 0, `${JSON.stringify(clearing)} is a deliberate clear`);
    expectEqual(parsed.value, null, "and answers null");
  }

  const missing = parseMerchantCategoryInput({});

  expectDeepEqual(
    missing.problems,
    [{ field: "mcc_code", rule: "required" }],
    "a body without the field names it as required",
  );
  expectEqual(missing.value, undefined, "and carries no value");

  for (const bad of ["541", "54111", "54a1", 5411, true, ["5411"]]) {
    const parsed = parseMerchantCategoryInput({ mcc_code: bad });

    expectDeepEqual(
      parsed.problems,
      [{ field: "mcc_code", rule: "invalid_format" }],
      `${JSON.stringify(bad)} is a format problem`,
    );
  }

  const notAnObject = parseMerchantCategoryInput("5411");

  expectDeepEqual(
    notAnObject.problems,
    [{ field: "mcc_code", rule: "invalid_format" }],
    "a body that is not an object is refused whole",
  );

  const unknown = parseMerchantCategoryInput({ mcc_code: "5411", turnover: "1000" });

  expectDeepEqual(
    unknown.problems,
    [{ field: "turnover", rule: "unknown_key" }],
    "a key beside the one field is named as unknown",
  );
}

/** ---- The read: the caller's own company, the active vocabulary, and a retired choice still named. */
async function checkCategoryRead(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase([businessRow({ mcc_code: "5411" })]);
    const refusal = await rejectionOf(() =>
      readMerchantCategory({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the category refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads no row for ${description}`);
  }

  const empty = await readMerchantCategory(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(empty.saved, false, "a merchant with no row is answered, not refused");
  expectEqual(empty.mccCode, null, "with no code chosen");
  expectEqual(empty.mccTitle, null, "and no title");
  expectEqual(empty.complete, false, "and the category step is not finished");
  expectEqual(empty.savedAtEpochMs, null, "and nothing was ever saved");
  expectDeepEqual(
    empty.options.map((option) => option.code),
    ["0742", "5411", "5812"],
    "the dropdown is the active codes of the vocabulary, in code order",
  );
  expect(
    empty.options.every((option) => option.title.length > 0),
    "and every option carries its published title",
  );

  const stored = await readMerchantCategory(
    { actor: owner },
    dependenciesOf(createBusinessDatabase([businessRow({ mcc_code: "5411" })]), createInMemoryAuditTrail()),
  );

  expectEqual(stored.saved, true, "a stored code is read back");
  expectEqual(stored.mccCode, "5411", "the code itself");
  expectEqual(stored.mccTitle, "Grocery Stores, Supermarkets", "with its published title");
  expectEqual(stored.complete, true, "and the category step is finished");
  expectEqual(
    stored.savedAtEpochMs,
    Date.parse("2026-11-01T09:30:00.000Z"),
    "with the row's save instant",
  );

  // A code that was retired after the merchant chose it still names itself, and leaves the dropdown.
  const retired = await readMerchantCategory(
    { actor: owner },
    dependenciesOf(createBusinessDatabase([businessRow({ mcc_code: "0001" })]), createInMemoryAuditTrail()),
  );

  expectEqual(retired.mccCode, "0001", "the retired choice is still the stored code");
  expectEqual(retired.mccTitle, "Retired Example Code", "resolved even though it is not offered");
  expectEqual(
    retired.options.some((option) => option.code === "0001"),
    false,
    "and it is not in the dropdown",
  );
  expectEqual(retired.complete, true, "the step stays finished: the stored code is valid history");

  // The same database, read by the owner of another company: the row of A is not B's to see.
  const otherTenant = createBusinessDatabase([businessRow({ mcc_code: "5411" })]);
  const refusedRow = await readMerchantCategory(
    { actor: otherOwner },
    dependenciesOf(otherTenant, createInMemoryAuditTrail()),
  );

  expectEqual(refusedRow.saved, false, "another merchant's code is not this merchant's category");
  expectEqual(refusedRow.companyId, COMPANY_B, "the other owner reads their own company");
  expect(
    (otherTenant.queries[0] ?? "").includes(encodeURIComponent(COMPANY_B)),
    "and the query names their company, never the row's",
  );

  const brokenRow = createBusinessDatabase([businessRow({ mcc_code: "5411", updated_at: "not a date" })]);

  expectEqual(
    await failureOf(() =>
      readMerchantCategory({ actor: owner }, dependenciesOf(brokenRow, createInMemoryAuditTrail())),
    ),
    "INTERNAL_ERROR",
    "a row with an unreadable instant is a defect, not an empty category",
  );
}

/** ---- The save: a patch of one column, the vocabulary checked first, the wizard kept in step. */
async function checkCategorySave(): Promise<void> {
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const first = await saveCategory(owner, { mcc_code: "5411" }, database, audit);

  expectEqual(first.companyId, COMPANY_A, "the row is written for the actor's own company");
  expectEqual(database.inserts.length, 2, "the first save inserts the profile row and the wizard row");
  expectEqual(database.inserts[0]?.table, BUSINESS_PROFILE_TABLE, "into the business profile table");
  expectDeepEqual(
    database.inserts[0]?.row,
    { company_id: COMPANY_A, mcc_code: "5411" },
    "carrying the company from the session and the one field, and nothing else",
  );
  expectEqual(database.updates.length, 0, "and updating nothing yet");
  expectEqual(first.mccCode, "5411", "the answer carries the code");
  expectEqual(first.mccTitle, "Grocery Stores, Supermarkets", "and its title");
  expectEqual(first.complete, true, "a chosen code finishes the category step");
  expectEqual(first.saved, true, "and is saved");
  expectEqual(first.savedAtEpochMs, NOW, "on the save's own clock");
  expectEqual(first.options.length, 3, "and the dropdown comes back with the answer");
  expectEqual(database.inserts[1]?.table, ONBOARDING_PROGRESS_TABLE, "the wizard gets a row it never had");
  expectEqual(
    database.inserts[1]?.row["current_step"],
    "website",
    "opening on the step after category",
  );
  expectDeepEqual(
    database.inserts[1]?.row["completed_steps"],
    ["category"],
    "with the category step finished",
  );

  expectEqual(audit.entries.length, 1, "the save appends exactly one audit entry");
  expectEqual(audit.entries[0]?.action, MERCHANT_CATEGORY_AUDIT_ACTION, "named merchant_category.saved");
  expectEqual(audit.entries[0]?.entityType, MERCHANT_CATEGORY_AUDIT_ENTITY, "on its own entity");
  expectEqual(audit.entries[0]?.entityId, COMPANY_A, "naming the company");
  expectEqual(audit.entries[0]?.companyId, COMPANY_A, "scoped to the company");
  expectEqual(audit.entries[0]?.ipAddress, "203.0.113.9", "with the address it came from");
  expectDeepEqual(
    audit.entries[0]?.payload,
    { code: "5411", cleared: false, complete: true, saved_at: new Date(NOW).toISOString() },
    "naming the code, that it was not a clear, the completion and the instant",
  );

  const second = await saveCategory(owner, { mcc_code: "5812" }, database, audit);

  expectEqual(database.inserts.length, 2, "a second save inserts nothing");
  expectEqual(database.updates.length, 1, "it updates the one row");
  expectEqual(database.updates[0]?.table, BUSINESS_PROFILE_TABLE, "the profile table");
  expectDeepEqual(
    database.updates[0]?.values,
    { mcc_code: "5812" },
    "the patch carries the one column and nothing beside it",
  );
  expectEqual(database.profileRows[0]?.mcc_code, "5812", "stored");
  expectEqual(second.mccCode, "5812", "and answered");
  expectEqual(second.mccTitle, "Eating places and Restaurants", "with the new title");
  expectEqual(
    database.updates.filter((update) => update.table === ONBOARDING_PROGRESS_TABLE).length,
    0,
    "the wizard row is already finished, so it is not written again",
  );
  expectEqual(audit.entries.length, 2, "and a second audit entry is appended");

  const cleared = await saveCategory(owner, { mcc_code: "" }, database, audit);

  expectDeepEqual(
    database.updates[1]?.values,
    { mcc_code: null },
    "clearing sends null for the one column",
  );
  expectEqual(cleared.mccCode, null, "the answer has no code");
  expectEqual(cleared.mccTitle, null, "and no title");
  expectEqual(cleared.complete, false, "and the category step is no longer finished");
  const wizardUpdate = database.updates.find((update) => update.table === ONBOARDING_PROGRESS_TABLE);

  expectDeepEqual(
    wizardUpdate?.values["completed_steps"],
    [],
    "and the wizard's finished list drops the category step",
  );
  expectDeepEqual(
    audit.entries[2]?.payload,
    { code: null, cleared: true, complete: false, saved_at: new Date(NOW).toISOString() },
    "the audit entry records the clear",
  );
}

/** ---- The save's refusals: the vocabulary, the shape, the roles, and the two racing tabs. */
async function checkCategorySaveRefusals(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase();
    const audit = createInMemoryAuditTrail();
    const refusal = await rejectionOf(() => saveCategory(actor, { mcc_code: "5411" }, database, audit));

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the save refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
    expectEqual(database.inserts.length + database.updates.length, 0, `and writes nothing for ${description}`);
    expectEqual(audit.entries.length, 0, `and audits nothing for ${description}`);
  }

  const shape = createBusinessDatabase();

  for (const [label, body, rule] of [
    ["a short code", { mcc_code: "541" }, "invalid_format"],
    ["a non digit code", { mcc_code: "54a1" }, "invalid_format"],
    ["a number", { mcc_code: 5411 }, "invalid_format"],
    ["an empty body", {}, "required"],
    ["an unknown key", { mcc_code: "5411", turnover: "1" }, "unknown_key"],
  ] as const) {
    const refusal = await rejectionOf(() => saveCategory(owner, body, shape, createInMemoryAuditTrail()));

    expectEqual(refusal?.code, "VALIDATION_FAILED", `${label} is a validation failure`);
    expectEqual(refusal?.details?.[0]?.rule, rule, `with the rule ${rule}`);
    expectEqual(refusal?.details?.[0]?.field, rule === "unknown_key" ? "turnover" : "mcc_code", "naming the field");
  }

  expectEqual(shape.queries.length, 0, "a shape refusal happens before any query");
  expectEqual(shape.inserts.length + shape.updates.length, 0, "and writes nothing");

  const unknown = createBusinessDatabase();
  const unknownRefusal = await rejectionOf(() => saveCategory(owner, { mcc_code: "9999" }, unknown, createInMemoryAuditTrail()));

  expectEqual(unknownRefusal?.code, "VALIDATION_FAILED", "a code the list does not carry is refused");
  expectDeepEqual(
    unknownRefusal?.details,
    [{ field: "mcc_code", rule: "unknown_code" }],
    "as unknown_code",
  );
  expectEqual(unknown.inserts.length + unknown.updates.length, 0, "with nothing written");
  expectEqual(unknown.mccRows.length, 4, "and the vocabulary untouched");

  const retired = createBusinessDatabase();
  const retiredRefusal = await rejectionOf(() => saveCategory(owner, { mcc_code: "0001" }, retired, createInMemoryAuditTrail()));

  expectDeepEqual(
    retiredRefusal?.details,
    [{ field: "mcc_code", rule: "retired_code" }],
    "a retired code is refused as retired_code, not as unknown",
  );
  expectEqual(retired.inserts.length + retired.updates.length, 0, "with nothing written");

  const racing = createBusinessDatabase();
  racing.conflictOnInsert = true;
  const accounted = createInMemoryAuditTrail();
  const rescued = await saveCategory(owner, { mcc_code: "5411" }, racing, accounted);

  expectEqual(rescued.saved, true, "a save that loses the insert race still saves");
  expectEqual(
    racing.updates.filter((update) => update.table === BUSINESS_PROFILE_TABLE).length,
    1,
    "by becoming the update it would have been",
  );
  expectDeepEqual(
    racing.updates.find((update) => update.table === BUSINESS_PROFILE_TABLE)?.values,
    { mcc_code: "5411" },
    "carrying the one column",
  );
  expectEqual(accounted.entries.length, 1, "and is audited once");

  const throwingAudit = {
    append(): Promise<void> {
      return Promise.reject(new Error("the audit sink is down"));
    },
  };
  const stored = await saveMerchantCategory(
    { actor: owner, input: { mcc_code: "5411" }, ipAddress: null, userAgent: null },
    { rest: createBusinessStore(createBusinessDatabase()), audit: throwingAudit, now: () => NOW },
  );

  expectEqual(stored.saved, true, "a save whose audit sink fails is still stored");
}

/** ---- The sources: the route, the screen, the form and the migration say what this STEP promised. */
async function checkCategorySources(): Promise<void> {
  const route = await readRepositoryFile("app/api/onboarding/merchant-category/route.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/category/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/category/category-form.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const up = await readRepositoryFile("migrations/0104_merchant_category_code.sql");
  const down = await readRepositoryFile("migrations/0104_merchant_category_code.down.sql");

  for (const [path, source] of [
    ["app/api/onboarding/merchant-category/route.ts", route],
    ["app/(dashboard)/onboarding/category/page.tsx", page],
    ["app/(dashboard)/onboarding/category/category-form.tsx", form],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  expectEqual(up.split("\n")[0], "-- path: migrations/0104_merchant_category_code.sql", "the migration states its path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0104_merchant_category_code.down.sql", "and so does its rollback");

  // ---- the route: token, session, body, service, in that order
  expect(route.includes("requireCsrfToken(request"), "the route checks the token first");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it looks the session up",
  );
  expect(route.indexOf("readRequestActor(") < route.indexOf("JSON.parse("), "which is before the body is parsed");
  expect(route.indexOf("JSON.parse(") < route.indexOf("saveMerchantCategory("), "and the service runs last");
  expect(route.includes("maximumBodyBytes = 1_024"), "the body is bounded");
  expect(route.includes("saveMerchantCategory("), "and saves through the service");
  expectEqual(route.includes("export const GET"), false, "the route answers POST only");
  expectEqual(route.includes('"cache-control": "no-store"'), true, "the answer is not cached");
  expectEqual(route.includes("company_id"), false, "and never takes a company from the caller");

  // ---- the screen and the form
  expect(page.includes("readOwnerActor()"), "the page reads the account through the cached reader");
  expect(page.includes("readMerchantCategory("), "and the category through the service");
  expect(page.includes("<SessionKeeper"), "and keeps the session rotating while it is read");
  expect(page.includes("CategoryForm"), "and renders the form");
  expectEqual(/(super_admin|compliance_kyc|finance_ops)/u.test(page), false, "the page names no office role");

  expectEqual(form.includes('"use client"'), true, "the form is a client component");
  expect(form.includes('SAVE_PATH = "/api/onboarding/merchant-category"'), "posting to one path");
  expectEqual((form.match(/fetch\(/gu) ?? []).length, 1, "with one fetch site");
  expectEqual((form.match(/fetch\(SAVE_PATH/gu) ?? []).length, 1, "to that path");
  expect(form.includes("csrfHeaders("), "carrying the CSRF token");
  expect(form.includes("JSON.stringify({ mcc_code: selected })"), "sending the one field");
  expectEqual(form.includes("companyId"), false, "and no company in the body");
  expectEqual(form.includes("process.env"), false, "reading no environment");
  expect(form.includes("initial.options"), "drawing the dropdown from the service's list");

  // ---- the registry and the map
  expect(csrf.includes('"/api/onboarding/merchant-category",'), "the save route is on the CSRF-protected list");
  expect(copy.includes('category: "/onboarding/category"'), "the category step links to its form");

  // ---- the migration pair
  expect(up.includes("add column mcc_code text"), "0104 adds the column to the profile");
  expect(up.includes("references public.mcc_codes (code)"), "pointed at the vocabulary through its code");
  expect(up.includes("mcc_codes_code_unique unique (code)"), "with the unique constraint a foreign key can reference");
  expect(up.includes("business_profiles_mcc_code_check"), "and the four digit check");
  expect(up.includes("create index business_profiles_mcc_idx"), "and the underwriting index");
  expect(down.includes("drop column if exists mcc_code"), "the rollback removes the column");
  expect(down.includes("drop constraint if exists mcc_codes_code_unique"), "and the constraint it added to the list");
  expectEqual(down.includes("create table"), false, "and creates nothing");
  expectEqual(down.includes("drop table"), false, "and removes no table another STEP owns");

  // ---- the files exist where the ownership rules put them
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/category/", repositoryRoot))).includes("page.tsx"),
    "the screen lives in the merchant dashboard area",
  );
  expect(
    (await readdir(new URL("app/api/onboarding/merchant-category/", repositoryRoot))).includes("route.ts"),
    "and its handler is a route handler of its own",
  );
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("merchant-category.ts"),
    "the service lives in services/kyc",
  );
}

/** ---- The catalog: every sentence of the form is used, and every key it names exists. */
async function checkCategoryCatalog(): Promise<void> {
  const block = en.onboardingCategory as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/category/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/category/category-form.tsx");
  const sources = `${page}\n${form}`;

  const flat: string[] = [];

  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      const path = `${prefix}.${key}`;

      if (typeof value === "string") {
        flat.push(path);
      } else if (typeof value === "object" && value !== null) {
        walk(value as Record<string, unknown>, path);
      }
    }
  };

  walk(block, "onboardingCategory");

  expect(flat.length > 20, "the category form has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingCategory\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  expectEqual(
    sources.includes('getMessage("onboardingCategory.selectedLine")'),
    false,
    "the templated chosen line is never rendered without its values",
  );
  expect(
    sources.includes('formatMessage("onboardingCategory.selectedLine"'),
    "and is rendered through formatMessage",
  );
  expect(
    sources.includes('formatMessage("onboardingCategory.savedLine"'),
    "and so is the saved line",
  );
}

async function main(): Promise<void> {
  checkVocabulary();
  await checkRefusals();
  await checkRead();
  await checkSaveValidation();
  await checkSaveCreates();
  await checkSaveUpdates();
  await checkSaveIsIdempotent();
  await checkRaceOnInsert();
  await checkBrokenRowOnSave();
  await checkSources();
  await checkCatalog();
  await checkMigrationSet();
  checkBusinessMatrix();
  checkBusinessParse();
  await checkBusinessRead();
  await checkBusinessSave();
  await checkBusinessSaveRefusals();
  await checkBusinessSources();
  await checkBusinessCatalog();
  checkCategoryVocabulary();
  checkCategoryParse();
  await checkCategoryRead();
  await checkCategorySave();
  await checkCategorySaveRefusals();
  await checkCategorySources();
  await checkCategoryCatalog();

  if (failures.length > 0) {
    process.stderr.write(`onboarding gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `onboarding gate passed: ${checks} checks, ${ONBOARDING_STEPS.length} steps, ` +
      `${ONBOARDING_OWNER_ROLES.length} role, ${BUSINESS_PROFILE_FIELDS.length} business fields, ` +
      `${PROCESSOR_REQUIREMENT_LIST.length} processors, ${BUSINESS_PROFILE_TABLE} table, ` +
      `${MCC_CODES_TABLE} vocabulary\n`,
  );
}

await main();
