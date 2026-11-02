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

  expectEqual(numbers.includes("0102"), true, "this STEP's migration is in the set");
  expectEqual(numbers.includes("0103"), false, "and nothing beyond it");
  expectEqual(Math.max(...numbers.map((number) => Number.parseInt(number, 10))), 102, "the set ends at 0102");
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
      `${ONBOARDING_OWNER_ROLES.length} role, ${ONBOARDING_PROGRESS_TABLE} table\n`,
  );
}

await main();
