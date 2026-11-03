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
import {
  parseBusinessAddressInput,
  readBusinessAddress,
  saveBusinessAddress,
  BUSINESS_ADDRESS_AUDIT_ACTION,
  BUSINESS_ADDRESS_AUDIT_ENTITY,
  BUSINESS_ADDRESS_FIELDS,
  BUSINESS_ADDRESS_ONBOARDING_STEP,
  COUNTRIES_TABLE,
  OPTIONAL_ADDRESS_FIELDS,
  REQUIRED_ADDRESS_FIELDS,
  ADDRESS_FIELD_LIMITS,
  COUNTRY_CODE_PATTERN,
  EMAIL_PATTERN,
  PHONE_PATTERN,
  POSTAL_CODE_PATTERN,
  type BusinessAddressSnapshot,
} from "./business-address.ts";
import { PLATFORM_PROVIDERS } from "../../lib/gateways/registry.ts";
import { UPLOAD_DATABASE_MAXIMUM_BYTES } from "../../lib/security/upload.ts";
import {
  KYC_AUDIT_ENTITY,
  KYC_DOCUMENTS_ONBOARDING_STEP,
  KYC_DOCUMENTS_TABLE,
  KYC_DOCUMENT_AUDIT_ACTION,
  KYC_DOCUMENT_MAXIMUM_BYTES,
  KYC_DOCUMENT_TYPES,
  KYC_SCREENING_AUDIT_ACTION,
  KYC_SUBMIT_AUDIT_ACTION,
  KYC_SUBMISSIONS_TABLE,
  KYC_UPLOAD_PURPOSE,
  parseKycDocumentInput,
  parseUboInput,
  readKycPack,
  readKycSummary,
  submitKyc,
  runKycScreening,
  saveKycDocument,
  saveUbo,
  BANK_STATEMENT_DEFAULT_PERIOD_MONTHS,
  BANK_STATEMENT_MAX_AGE_MONTHS,
  dateStringMinusMonths,
  monthsBetweenDates,
  SIGNIFICANT_OWNER_BPS,
  UTILITY_BILL_MAX_AGE_MONTHS,
  utilityBillIssueWindow,
  SANCTIONS_SCREENINGS_TABLE,
  UBO_AUDIT_ACTION,
  UBO_RECORDS_TABLE,
  COMPANIES_TABLE,
  createDocumentRequest,
  createDocumentRequestJobHandler,
  documentRequestIdempotencyKey,
  enqueueDocumentRequest,
  KYC_DOCUMENT_REQUESTS_TABLE,
  KYC_DOCUMENT_REQUEST_CREATED_AUDIT_ACTION,
  KYC_DOCUMENT_REQUEST_ENTITY,
  KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION,
  KYC_DOCUMENT_REQUEST_JOB,
  registerKycDocumentRequestJob,
} from "./kyc-capture.ts";
import {
  checkDuplicateIdentity,
  checkSignupIdentity,
  collectIdentitySignals,
  DUPLICATE_CASES_TABLE,
  DUPLICATE_CASE_ENTITY,
  DUPLICATE_CASE_OPENED_AUDIT_ACTION,
  DUPLICATE_IDENTITY_RULE,
  DUPLICATE_STAGES,
  IDENTITY_SIGNALS,
} from "./duplicate-check.ts";
import {
  ACCOUNT_MANAGE_ROLES,
  CHARGEBACK_HOLD_DAYS_DEFAULT,
  CHARGEBACK_HOLD_DAYS_SETTING,
  CLOSURE_PAYOUT_JOB,
  CLOSURE_PAYOUT_REQUESTED_AUDIT_ACTION,
  closeAccountBodySchema,
  closurePayoutJobPayloadSchema,
  closeMerchantAccount,
  decideReactivation,
  HOLDS_TABLE,
  LEDGER_ACCOUNTS_TABLE,
  LEDGER_ENTRIES_TABLE,
  MERCHANT_ACCOUNT_EVENTS_TABLE,
  MERCHANT_PAYABLE_ACCOUNT_CODE,
  PAYOUTS_TABLE,
  PLATFORM_SETTINGS_TABLE,
  readAccountReviewQueue,
  readMerchantAccountState,
  requestAccountClosure,
  requestReactivation,
  runClosurePayout,
  suspendAccountBodySchema,
  suspendMerchant,
} from "./account-lifecycle.ts";
import {
  CARD_TOKENS_DELETED_EVENT,
  deleteCardTokensJobIdempotencyKey,
  deleteCardTokensJobPayloadSchema,
  runCardTokenDeletion,
  SUBMERCHANT_CARD_TOKENS_DELETED_AUDIT_ACTION,
  SUBMERCHANT_DELETE_CARD_TOKENS_JOB,
} from "../submerchant/card-tokens.ts";
import {
  decideKycSubmission,
  fourEyeProblems,
  KYC_DECISION_AUDIT_ACTION,
  KYC_DOCUMENT_REVIEW_AUDIT_ACTION,
  KYC_FINAL_APPROVAL_ROLES,
  KYC_RISK_MARK_AUDIT_ACTION,
  KYC_REVIEW_AUDIT_ACTION,
  KYC_REVIEW_OFFICE_ROLES,
  KYC_REVIEW_OPEN_AUDIT_ACTION,
  markKycSubmissionRisk,
  openKycReview,
  readKycReviewDetail,
  readKycReviewQueue,
  reviewKycDocument,
} from "./kyc-review.ts";
import {
  MCC_CODE_ENTITY,
  readMerchantUnderwritingSummary,
  readUnderwritingMccOverview,
  readUnderwritingSettings,
  setMccRiskTier,
  UNDERWRITING_CRITERIA_AUDIT_ACTION,
  UNDERWRITING_CRITERIA_TABLE,
  UNDERWRITING_MANAGE_ROLES,
  UNDERWRITING_MCC_TIER_AUDIT_ACTION,
  UNDERWRITING_READ_AUDIT_ACTION,
  UNDERWRITING_READ_ROLES,
  UNDERWRITING_RISK_TIERS_TABLE,
  UNDERWRITING_RISK_TIER_AUDIT_ACTION,
  UNDERWRITING_RISK_TIER_ENTITY,
  updateUnderwritingCriteria,
  updateUnderwritingRiskTier,
} from "./underwriting.ts";
import {
  checkTransactionAgainstLimit,
  MERCHANT_LIMITS_TABLE,
  MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION,
  MERCHANT_LIMIT_ENTITY,
  MERCHANT_LIMIT_UPDATED_AUDIT_ACTION,
  MERCHANT_LIMIT_USAGE_AUDIT_ACTION,
  monthKeyOf,
  readMerchantLimit,
  recordTransactionUsage,
  updateMerchantLimit,
} from "./merchant-limit.ts";
import {
  decidePaymentHold,
  holdLargeTransaction,
  PAYMENT_HOLDS_TABLE,
  PAYMENT_HOLD_CREATED_AUDIT_ACTION,
  PAYMENT_HOLD_DECIDED_AUDIT_ACTION,
  PAYMENT_HOLD_ENTITY,
  PAYMENT_HOLD_READ_AUDIT_ACTION,
  readMerchantPaymentHolds,
  readPaymentHoldQueue,
} from "./payment-hold.ts";
import { createInMemoryJobQueue } from "../../lib/jobs/queue.ts";
import { JobRegistry } from "../../lib/jobs/registry.ts";
import {
  createProvisionJobHandler,
  enqueueProvisioningAfterApproval,
  PAYMENT_PROVIDERS_TABLE,
  PROVIDER_KEYS_TABLE,
  provisionJobIdempotencyKey,
  registerSubmerchantProvisionJob,
  runSubmerchantProvisioning,
  SUBMERCHANT_PROVISION_JOB,
  SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION,
  SUBMERCHANT_PROVISION_ENTITY,
  SUBMERCHANT_PROVISIONS_TABLE,
} from "../submerchant/provision.ts";
import {
  createSyncJobHandler,
  enqueueProvisionSync,
  PROVISION_SYNC_EVENT_TYPES,
  registerSubmerchantJobs,
  SUBMERCHANT_SYNC_JOB,
  SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION,
  syncJobIdempotencyKey,
  syncProvisionFromWebhook,
  WEBHOOK_EVENTS_TABLE,
} from "../submerchant/provision-sync.ts";
import {
  assertProvisionable,
  PROCESSOR_PROFILE_AUDIT_ACTION,
  PROCESSOR_PROFILE_AUDIT_ENTITY,
  PROCESSOR_PROFILE_OFFICE_ROLES,
  PROCESSOR_PROFILE_READER_ROLES,
  processorPayloadFor,
  readProcessorProfile,
} from "../submerchant/processor-profile.ts";
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
const desk = actorOf(["compliance_kyc"], null, { userId: OFFICE_ID });
const ceoDesk = actorOf(["ceo"], null, { userId: OFFICE_ID });

// Actors the review queue must refuse: every role that is not one of KYC_REVIEW_OFFICE_ROLES.
const reviewRefused: readonly (readonly [string, RequestActor])[] = [
  ["an owner", owner],
  ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })],
  ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
  ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
  ["nobody", actorOf([], null)],
];

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
  expectEqual(numbers.includes("0105"), true, "STEP 082's is too");
  expectEqual(numbers.includes("0106"), true, "STEP 090's is too");
  expectEqual(numbers.includes("0107"), true, "STEP 091's is too");
  expectEqual(numbers.includes("0108"), true, "STEP 092's is too");
  expectEqual(numbers.includes("0109"), true, "STEP 097's is too");
  expectEqual(numbers.includes("0110"), true, "STEP 098's is too");
  expectEqual(numbers.includes("0111"), true, "STEP 099's is too");
  expectEqual(Math.max(...numbers.map((number) => Number.parseInt(number, 10))), 111, "the set ends at 0111");
}

/* -------------------------------------------------------------------------------------------------
 * STEP 080: the business information form, its matrix and its save.
 * ---------------------------------------------------------------------------------------------- */

interface BusinessRowShape {
  id?: string;
  company_id: string;
  legal_name: string | null;
  trading_name: string | null;
  business_type: string | null;
  registration_number: string | null;
  tax_id: string | null;
  website: string | null;
  business_description: string | null;
  mcc_code: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address_completed_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

/** One row of the `0077` vocabulary, as the fake store holds it. `deleted_at` is always null. */
interface MccRowShape {
  id: string;
  code: string;
  title: string;
  risk_tier: string;
  is_active: boolean;
  version: number;
}

/** The vocabulary the category gate works against: three active codes and one retired one. */
function defaultMccRows(): MccRowShape[] {
  return [
    { id: "018f2b8a-0000-4c2d-9c3e-0000000000c1", code: "0742", title: "Veterinary Services", risk_tier: "unassigned", is_active: true, version: 1 },
    { id: "018f2b8a-0000-4c2d-9c3e-0000000000c2", code: "5411", title: "Grocery Stores, Supermarkets", risk_tier: "low", is_active: true, version: 1 },
    { id: "018f2b8a-0000-4c2d-9c3e-0000000000c3", code: "5812", title: "Eating places and Restaurants", risk_tier: "unassigned", is_active: true, version: 1 },
    { id: "018f2b8a-0000-4c2d-9c3e-0000000000c4", code: "0001", title: "Retired Example Code", risk_tier: "unassigned", is_active: false, version: 1 },
  ];
}

/** The one `0106` criteria row, as the fake store holds it: the seed of the migration. */
interface CriteriaRowShape {
  id: string;
  starting_monthly_limit: string;
  bank_statement_months: number;
  large_transaction_hold_enabled: boolean;
  large_transaction_hold_threshold: string;
  updated_by: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

/** One `0106` risk tier row, as the fake store holds it. */
interface TierRowShape {
  id: string;
  tier: string;
  extra_reserve_percent: string;
  hold_days: number;
  updated_by: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

function defaultCriteriaRow(): CriteriaRowShape {
  return {
    id: "018f2b8a-0000-4c2d-9c3e-0000000000d1",
    starting_monthly_limit: "1000.0000",
    bank_statement_months: 3,
    large_transaction_hold_enabled: true,
    large_transaction_hold_threshold: "10000.0000",
    updated_by: null,
    version: 1,
    updated_at: "2026-11-01T09:00:00.000Z",
    created_at: "2026-11-01T09:00:00.000Z",
  };
}

function defaultTierRows(): TierRowShape[] {
  return ["low", "medium", "high"].map((tier, index) => ({
    id: `018f2b8a-0000-4c2d-9c3e-0000000000e${index + 1}`,
    tier,
    extra_reserve_percent: "0.00",
    hold_days: 0,
    updated_by: null,
    version: 1,
    updated_at: "2026-11-01T09:00:00.000Z",
    created_at: "2026-11-01T09:00:00.000Z",
  }));
}

/** One `0107` merchant limit row, as the fake store holds it. */
interface LimitRowShape {
  id: string;
  company_id: string;
  month_key: string;
  monthly_limit: string;
  used_amount: string;
  updated_by: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

/** One `0108` payment hold row, as the fake store holds it. */
interface PaymentHoldRowShape {
  id: string;
  company_id: string;
  reference: string | null;
  amount: string;
  status: string;
  held_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  decision_reason: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

/** One `0029` platform provider row, as the fake store holds it. Platform level: company_id null. */
interface ProviderRowShape {
  id: string;
  company_id: string | null;
  provider_key: string;
  status: string;
  supports_submerchant: boolean;
  display_order: number;
}

/** One `0030` provider key row. Platform level: company_id null. */
interface ProviderKeyRowShape {
  id: string;
  company_id: string | null;
  provider_id: string;
  label: string;
  mode: string;
  status: string;
}

/** One `0054` sub-merchant provision row, as the fake store holds it. */
interface ProvisionRowShape {
  id: string;
  company_id: string;
  kyc_submission_id: string;
  provider_id: string;
  provider_key: string;
  mode: string;
  master_account_ref: string | null;
  provider_submerchant_id: string | null;
  status: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  requested_at: string;
  next_attempt_at: string | null;
  last_webhook_event_id?: string | null;
  last_synced_at?: string | null;
  verified_at?: string | null;
  restricted_at?: string | null;
  rejected_at?: string | null;
  action_required_detail?: string | null;
  rejection_reason?: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

/** One `0032` webhook event row, as the fake store holds it. */
interface WebhookEventRowShape {
  id: string;
  company_id: string | null;
  provider_id: string;
  mode: string;
  external_event_id: string;
  event_type: string;
  payload_hash: string;
  signature_ok: boolean;
  received_at: string;
  status: string;
  processed_at: string | null;
  failure_detail: string | null;
  version: number;
  updated_at: string;
  created_at: string;
}

/** The platform catalogue of the gate: two enabled sub-merchant providers, one without the capability, one disabled. */
function defaultProviderRows(): ProviderRowShape[] {
  return [
    { id: "018f2b8a-0000-4c2d-9c3e-000000000011", company_id: null, provider_key: "nmi", status: "enabled", supports_submerchant: true, display_order: 1 },
    { id: "018f2b8a-0000-4c2d-9c3e-000000000012", company_id: null, provider_key: "stripe_connect", status: "enabled", supports_submerchant: true, display_order: 2 },
    { id: "018f2b8a-0000-4c2d-9c3e-000000000013", company_id: null, provider_key: "payoneer", status: "enabled", supports_submerchant: false, display_order: 3 },
    { id: "018f2b8a-0000-4c2d-9c3e-000000000014", company_id: null, provider_key: "airwallex", status: "disabled", supports_submerchant: true, display_order: 4 },
  ];
}

/** One connected master account: an active platform key for nmi in test mode. stripe_connect has none. */
function defaultProviderKeyRows(): ProviderKeyRowShape[] {
  return [
    {
      id: "018f2b8a-0000-4c2d-9c3e-000000000021",
      company_id: null,
      provider_id: "018f2b8a-0000-4c2d-9c3e-000000000011",
      label: "NMI master",
      mode: "test",
      status: "active",
    },
  ];
}

/** One row of `0048`, as the fake store holds it. */
interface SubmissionRowShape {
  id: string;
  company_id: string;
  status: string;
  verification_method: string;
  submitted_at?: string | null;
  submitted_by?: string | null;
  first_reviewer_id?: string | null;
  second_reviewer_id?: string | null;
  reviewed_at?: string | null;
  decided_at?: string | null;
  decision_reason?: string | null;
  provider_reference?: string | null;
  high_risk?: boolean;
  four_eye_required?: boolean;
  version?: number;
  updated_at?: string;
  created_at: string;
}

/** One row of `0049`. */
interface DocumentRowShape {
  id: string;
  company_id: string;
  submission_id: string;
  document_type: string;
  storage_key: string;
  content_sha256: string;
  content_type: string;
  byte_size: number;
  issued_at: string | null;
  expires_at: string | null;
  status: string;
  created_at: string;
  rejection_reason?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  version?: number;
  updated_at?: string;
}

/** One row of the `0001` tenant root. */
interface CompanyRowShape {
  id: string;
  company_id: string;
}

/** One row of `0109`. */
interface DocumentRequestRowShape {
  id: string;
  company_id: string;
  submission_id: string;
  provider_id: string;
  document_label: string;
  note: string | null;
  status: string;
  fulfilled_by?: string | null;
  fulfilled_at?: string | null;
  cancelled_at?: string | null;
  version?: number;
  updated_at?: string;
  created_at: string;
}

/** One row of `0003`. */
interface UserRowShape {
  id: string;
  company_id: string | null;
  email: string;
  phone: string | null;
  full_name: string;
  status?: string;
  version?: number;
  created_at: string;
}

/** One row of `0046`. */
interface BankAccountRowShape {
  id: string;
  company_id: string;
  account_fingerprint: string;
  status?: string;
  bank_name?: string;
  account_last_four?: string;
  country?: string;
  version?: number;
  created_at: string;
}

/** One row of `0110`. */
interface DuplicateCaseRowShape {
  id: string;
  company_id: string;
  stage: string;
  signal: string;
  matched_company_id?: string | null;
  matched_user_id?: string | null;
  status: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  resolution?: string | null;
  version?: number;
  updated_at?: string;
  created_at: string;
}

/** One row of `0111`, as the fake store holds it. */
interface AccountEventRowShape {
  id: string;
  company_id: string;
  event: string;
  reason?: string | null;
  detail?: string | null;
  required_documents?: readonly string[] | null;
  actor_user_id?: string | null;
  kyc_submission_id?: string | null;
  payout_bank_account_id?: string | null;
  hold_release_at?: string | null;
  chargeback_hold_release_at?: string | null;
  version?: number;
  updated_at?: string;
  created_at: string;
}

/** One row of `0043` holds, as the fake store holds it. */
interface FundHoldRowShape {
  id: string;
  company_id: string;
  payment_id: string | null;
  settlement_id: string | null;
  amount_minor: string;
  currency: string;
  reason: string;
  status: string;
  placed_at: string;
  release_due_at: string;
  version?: number;
  updated_at?: string;
  created_at: string;
}

/** One row of `0045` payouts, as the fake store holds it. */
interface PayoutRowShape {
  id: string;
  company_id: string;
  settlement_id: string | null;
  amount_minor: string;
  currency: string;
  platform_fee_minor: number;
  status: string;
  requested_by: string;
  destination_bank_name: string | null;
  destination_last_four: string | null;
  destination_country: string | null;
  is_remainder: boolean;
  note: string | null;
  version?: number;
  updated_at?: string;
  created_at: string;
}

/** One row of `0040` ledger accounts. */
interface LedgerAccountRowShape {
  id: string;
  company_id: string | null;
  account_code: string;
  created_at: string;
}

/** One row of `0041` ledger entries. */
interface LedgerEntryRowShape {
  id: string;
  company_id: string;
  account_id: string;
  entry_side: string;
  amount_minor: number;
  created_at: string;
}

/** One row of `0080` platform settings. */
interface SettingRowShape {
  setting_key: string;
  value: unknown;
  created_at: string;
}

/** One row of `0050`. */
interface UboRowShape {
  id: string;
  company_id: string;
  submission_id: string;
  full_name: string;
  date_of_birth: string;
  country: string;
  ownership_bps: number;
  is_significant: boolean;
  id_document_sha256: string;
  is_pep: boolean;
  screened_at: string | null;
  created_at: string;
}

/** One row of `0051`. */
interface ScreeningRowShape {
  id: string;
  company_id: string;
  subject_kind: string;
  subject_id: string;
  ofac_checked: boolean;
  un_checked: boolean;
  eu_checked: boolean;
  us_checked: boolean;
  result: string;
  provider: string;
  screened_at: string;
  note: string | null;
  sar_case: boolean;
  created_at: string;
}

interface BusinessDatabase {
  readonly profileRows: BusinessRowShape[];
  readonly submissionRows: SubmissionRowShape[];
  readonly documentRows: DocumentRowShape[];
  readonly uboRows: UboRowShape[];
  readonly screeningRows: ScreeningRowShape[];
  readonly onboardingRows: ProgressRowShape[];
  readonly mccRows: MccRowShape[];
  readonly countryRows: CountryRowShape[];
  readonly criteriaRow: CriteriaRowShape | null;
  readonly tierRows: TierRowShape[];
  readonly limitRows: LimitRowShape[];
  readonly holdRows: PaymentHoldRowShape[];
  readonly providerRows: ProviderRowShape[];
  readonly providerKeyRows: ProviderKeyRowShape[];
  readonly provisionRows: ProvisionRowShape[];
  readonly webhookRows: WebhookEventRowShape[];
  readonly companyRows: CompanyRowShape[];
  readonly requestRows: DocumentRequestRowShape[];
  readonly userRows: UserRowShape[];
  readonly bankRows: BankAccountRowShape[];
  readonly caseRows: DuplicateCaseRowShape[];
  readonly eventRows: AccountEventRowShape[];
  readonly fundHoldRows: FundHoldRowShape[];
  readonly payoutRows: PayoutRowShape[];
  readonly ledgerAccountRows: LedgerAccountRowShape[];
  readonly ledgerEntryRows: LedgerEntryRowShape[];
  readonly settingRows: SettingRowShape[];
  readonly queries: string[];
  readonly inserts: { readonly table: string; readonly row: Readonly<Record<string, unknown>> }[];
  readonly updates: {
    readonly table: string;
    readonly query: string;
    readonly values: Readonly<Record<string, unknown>>;
  }[];
  conflictOnInsert: boolean;
  /** When true, the criteria update branch simulates a lost race: the row moves on, the write does not land. */
  criteriaRace: boolean;
  /** When true, the limit update branch simulates a lost race the same way. */
  limitRace: boolean;
  /** When true, the hold update branch simulates a lost race the same way. */
  holdRace: boolean;
  /** When true, the submission update branch simulates a lost race the same way. */
  submissionRace: boolean;
  /** When true, the provision update branch simulates a lost race the same way. */
  provisionRace: boolean;
  /** When true, the request update branch simulates a lost race the same way. */
  requestRace: boolean;
  /** When true, the request insert branch answers a unique conflict with the winner's row present. */
  requestInsertConflict: boolean;
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
    address_line1: null,
    address_line2: null,
    city: null,
    state_province: null,
    postal_code: null,
    country_code: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    address_completed_at: null,
    completed_at: null,
    updated_at: "2026-11-01T09:30:00.000Z",
    ...overrides,
  };
}

function createBusinessDatabase(
  profileRows: readonly BusinessRowShape[] = [],
  onboardingRows: readonly ProgressRowShape[] = [],
  mccRows: readonly MccRowShape[] = defaultMccRows(),
  countryRows: readonly CountryRowShape[] = defaultCountryRows(),
  submissionRows: readonly SubmissionRowShape[] = [],
  documentRows: readonly DocumentRowShape[] = [],
  uboRows: readonly UboRowShape[] = [],
  screeningRows: readonly ScreeningRowShape[] = [],
  criteriaRow: CriteriaRowShape | null = defaultCriteriaRow(),
  tierRows: readonly TierRowShape[] = defaultTierRows(),
  limitRows: readonly LimitRowShape[] = [],
  holdRows: readonly PaymentHoldRowShape[] = [],
  providerRows: readonly ProviderRowShape[] = defaultProviderRows(),
  providerKeyRows: readonly ProviderKeyRowShape[] = defaultProviderKeyRows(),
  provisionRows: readonly ProvisionRowShape[] = [],
  webhookRows: readonly WebhookEventRowShape[] = [],
  companyRows: readonly CompanyRowShape[] = defaultCompanyRows(),
  requestRows: readonly DocumentRequestRowShape[] = [],
  userRows: readonly UserRowShape[] = defaultUserRows(),
  bankRows: readonly BankAccountRowShape[] = [],
  caseRows: readonly DuplicateCaseRowShape[] = [],
  eventRows: readonly AccountEventRowShape[] = [],
  fundHoldRows: readonly FundHoldRowShape[] = [],
  payoutRows: readonly PayoutRowShape[] = [],
  ledgerAccountRows: readonly LedgerAccountRowShape[] = [],
  ledgerEntryRows: readonly LedgerEntryRowShape[] = [],
  settingRows: readonly SettingRowShape[] = defaultSettingRows(),
): BusinessDatabase {
  return {
    profileRows: [...profileRows],
    submissionRows: [...submissionRows],
    documentRows: [...documentRows],
    uboRows: [...uboRows],
    screeningRows: [...screeningRows],
    onboardingRows: [...onboardingRows],
    mccRows: [...mccRows],
    countryRows: [...countryRows],
    criteriaRow: criteriaRow === null ? null : { ...criteriaRow },
    tierRows: [...tierRows].map((row) => ({ ...row })),
    limitRows: [...limitRows].map((row) => ({ ...row })),
    holdRows: [...holdRows].map((row) => ({ ...row })),
    providerRows: [...providerRows].map((row) => ({ ...row })),
    providerKeyRows: [...providerKeyRows].map((row) => ({ ...row })),
    provisionRows: [...provisionRows].map((row) => ({ ...row })),
    webhookRows: [...webhookRows].map((row) => ({ ...row })),
    companyRows: [...companyRows].map((row) => ({ ...row })),
    requestRows: [...requestRows].map((row) => ({ ...row })),
    userRows: [...userRows].map((row) => ({ ...row })),
    bankRows: [...bankRows].map((row) => ({ ...row })),
    caseRows: [...caseRows].map((row) => ({ ...row })),
    eventRows: [...eventRows].map((row) => ({ ...row })),
    fundHoldRows: [...fundHoldRows].map((row) => ({ ...row })),
    payoutRows: [...payoutRows].map((row) => ({ ...row })),
    ledgerAccountRows: [...ledgerAccountRows].map((row) => ({ ...row })),
    ledgerEntryRows: [...ledgerEntryRows].map((row) => ({ ...row })),
    settingRows: [...settingRows].map((row) => ({ ...row })),
    queries: [],
    inserts: [],
    updates: [],
    conflictOnInsert: false,
    criteriaRace: false,
    limitRace: false,
    holdRace: false,
    submissionRace: false,
    provisionRace: false,
    requestRace: false,
    requestInsertConflict: false,
  };
}

/** The tenant root rows the gate works against: the two seeded companies. */
function defaultCompanyRows(): CompanyRowShape[] {
  return [
    { id: COMPANY_A, company_id: COMPANY_A },
    { id: COMPANY_B, company_id: COMPANY_B },
  ];
}

/** The `0003` users the gate works against: the owner account of the first company. */
function defaultUserRows(): UserRowShape[] {
  return [
    {
      id: OWNER_ID,
      company_id: COMPANY_A,
      email: "owner@example.test",
      phone: "+8801000000001",
      full_name: "Owner One",
      status: "active",
      version: 1,
      created_at: "2026-11-01T08:00:00.000Z",
    },
  ];
}

/** The `0080` settings the gate works against: the `0111` chargeback period seed. */
function defaultSettingRows(): SettingRowShape[] {
  return [
    {
      setting_key: CHARGEBACK_HOLD_DAYS_SETTING,
      value: CHARGEBACK_HOLD_DAYS_DEFAULT,
      created_at: "2026-11-01T08:00:00.000Z",
    },
  ];
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

/** The address and contact columns of `0105`, which the address service patches. */
const ADDRESS_PROFILE_COLUMNS = [
  "address_line1",
  "address_line2",
  "city",
  "state_province",
  "postal_code",
  "country_code",
  "contact_name",
  "contact_email",
  "contact_phone",
] as const;

/** One row of the `0076` country list, as the fake store holds it. `deleted_at` is always null. */
interface CountryRowShape {
  code: string;
  name: string;
  is_enabled: boolean;
  is_sanctioned: boolean;
}

/** The country list the address gate works against: two enabled and one switched off. */
function defaultCountryRows(): CountryRowShape[] {
  return [
    { code: "BD", name: "Bangladesh", is_enabled: true, is_sanctioned: false },
    { code: "US", name: "United States", is_enabled: true, is_sanctioned: false },
    { code: "AQ", name: "Antarctica", is_enabled: false, is_sanctioned: true },
  ];
}

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

  for (const column of ADDRESS_PROFILE_COLUMNS) {
    if (!(column in values)) {
      continue;
    }

    const value = values[column];
    stored[column] = typeof value === "string" ? value : null;
  }

  if ("address_completed_at" in values) {
    const completed = values["address_completed_at"];
    stored.address_completed_at = typeof completed === "string" ? completed : null;
  }

  return stored;
}

/** The store the form writes through: two tables, and nothing else answers. */
function createBusinessStore(database: BusinessDatabase): RestClient {
  // Null when the query carries no company: the office review queue of STEP 088 reads across
  // companies on purpose; every merchant flow still passes a company and the gate asserts it.
  const scopedCompany = (query: string): string | null => {
    const parts = query.split("&");
    const company = parts.find((part) => part.startsWith("company_id=eq."));

    if (!parts.includes("deleted_at=is.null")) {
      throw new Error(`a read is not over live rows: ${query}`);
    }

    return company === undefined ? null : decodeURIComponent(company.slice("company_id=eq.".length));
  };

  // STEP 098: the duplicate check matches signal columns across companies with plain eq filters.
  const eqFilter = (
    rows: readonly Record<string, unknown>[],
    parts: readonly string[],
  ): Record<string, unknown>[] => {
    let matched = [...rows];

    for (const part of parts) {
      const eq = /^([a-z_]+)=eq\.(.+)$/u.exec(part);

      if (eq !== null) {
        const column = eq[1] ?? "";
        const value = decodeURIComponent(eq[2] ?? "");
        matched = matched.filter((row) => String(row[column]) === value);
      }
    }

    return matched;
  };

  const limitOf = (parts: readonly string[]): number | null => {
    const limit = parts.find((part) => part.startsWith("limit="));

    return limit === undefined ? null : Number.parseInt(limit.slice("limit=".length), 10);
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

      // The country list of `0076` is a platform table, scoped by its own filters like the codes.
      if (table === COUNTRIES_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the country read is not over live rows: ${query}`));
        }

        const codeFilter = parts.find((part) => part.startsWith("code=eq."));
        const enabledOnly = parts.includes("is_enabled=is.true");
        const limit = parts.find((part) => part.startsWith("limit="));
        const ordered = parts.includes("order=code.asc");

        let matched = database.countryRows.filter((row) => (enabledOnly ? row.is_enabled : true));

        if (codeFilter !== undefined) {
          const wantedCode = decodeURIComponent(codeFilter.slice("code=eq.".length));
          matched = matched.filter((row) => row.code === wantedCode);
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

      // The `0106` platform tables: scoped by their own filters like the vocabulary, never by a company.
      if (table === UNDERWRITING_CRITERIA_TABLE) {
        if (!query.split("&").includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the criteria read is not over live rows: ${query}`));
        }

        return Promise.resolve(
          database.criteriaRow === null ? [] : [schema.parse(database.criteriaRow)],
        );
      }

      if (table === UNDERWRITING_RISK_TIERS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the tier read is not over live rows: ${query}`));
        }

        const tierFilter = parts.find((part) => part.startsWith("tier=eq."));
        let matched = [...database.tierRows];

        if (tierFilter !== undefined) {
          const wantedTier = decodeURIComponent(tierFilter.slice("tier=eq.".length));
          matched = matched.filter((row) => row.tier === wantedTier);
        }

        if (parts.includes("order=tier.asc")) {
          matched = [...matched].sort((left, right) => left.tier.localeCompare(right.tier));
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        return Promise.resolve(capped.map((row) => schema.parse(row)));
      }

      // The `0108` hold table: the office queue read is deliberately unscoped (cross-company), so
      // this branch applies the company filter only when the query itself carries one.
      if (table === PAYMENT_HOLDS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the hold read is not over live rows: ${query}`));
        }

        let matched = [...database.holdRows];

        const companyPart = parts.find((part) => part.startsWith("company_id=eq."));

        if (companyPart !== undefined) {
          const wantedCompany = decodeURIComponent(companyPart.slice("company_id=eq.".length));
          matched = matched.filter((row) => row.company_id === wantedCompany);
        }

        for (const column of ["id", "status", "reference"] as const) {
          const eqPart = parts.find((part) => part.startsWith(`${column}=eq.`));

          if (eqPart !== undefined) {
            const value = decodeURIComponent(eqPart.slice(column.length + 4));
            matched = matched.filter((row) => row[column] === value);
          }

          if (parts.includes(`${column}=is.null`)) {
            matched = matched.filter((row) => row[column] === null);
          }
        }

        const ordered = parts.find((part) => part.startsWith("order="));

        if (ordered === "order=held_at.asc") {
          matched = [...matched].sort((left, right) => left.held_at.localeCompare(right.held_at));
        }

        if (ordered === "order=held_at.desc") {
          matched = [...matched].sort((left, right) => right.held_at.localeCompare(left.held_at));
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        return Promise.resolve(capped.map((row) => schema.parse(row)));
      }

      // The `0029` platform providers and the `0030` platform keys: platform tables, never
      // company-scoped, filtered by their own flags like the vocabulary.
      if (table === PAYMENT_PROVIDERS_TABLE || table === PROVIDER_KEYS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the platform read is not over live rows: ${query}`));
        }

        const allRows = (
          table === PAYMENT_PROVIDERS_TABLE ? database.providerRows : database.providerKeyRows
        ) as unknown as readonly Record<string, unknown>[];

        let matched = [...allRows];

        if (parts.includes("company_id=is.null")) {
          matched = matched.filter((row) => row["company_id"] === null);
        }

        const statusPart = parts.find((part) => part.startsWith("status=eq."));

        if (statusPart !== undefined) {
          const wantedStatus = decodeURIComponent(statusPart.slice("status=eq.".length));
          matched = matched.filter((row) => row["status"] === wantedStatus);
        }

        if (parts.includes("supports_submerchant=is.true")) {
          matched = matched.filter((row) => row["supports_submerchant"] === true);
        }

        const ordered = parts.find((part) => part.startsWith("order="));

        if (ordered === "order=display_order.asc") {
          matched = [...matched].sort((left, right) => Number(left["display_order"]) - Number(right["display_order"]));
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        return Promise.resolve(capped.map((row) => schema.parse(row)));
      }

      // The `0054` provision rows: company-scoped like the KYC tables, with their own eq filters.
      if (table === SUBMERCHANT_PROVISIONS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the provision read is not over live rows: ${query}`));
        }

        const wantedCompany = scopedCompany(query);
        let matched = [...database.provisionRows];

        if (wantedCompany !== null) {
          matched = matched.filter((row) => row.company_id === wantedCompany);
        }

        for (const column of ["id", "provider_id", "status"] as const) {
          const eqPart = parts.find((part) => part.startsWith(`${column}=eq.`));

          if (eqPart !== undefined) {
            const value = decodeURIComponent(eqPart.slice(column.length + 4));
            matched = matched.filter((row) => row[column] === value);
          }
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        // Rows seeded before the sync columns existed still answer with the migration's defaults.
        const withDefaults = capped.map((row) => ({
          last_webhook_event_id: null,
          last_synced_at: null,
          ...row,
        }));

        return Promise.resolve(withDefaults.map((row) => schema.parse(row)));
      }

      // The `0001` tenant root: the request service proves the asked merchant exists.
      if (table === COMPANIES_TABLE) {
        const wantedCompany = scopedCompany(query);
        const matched = database.companyRows.filter((row) => row.company_id === wantedCompany);

        return Promise.resolve(matched.map((row) => schema.parse({ id: row.id })));
      }

      // The `0032` webhook events: read by id, never company-scoped - the event names its own
      // merchant once it has resolved it.
      if (table === WEBHOOK_EVENTS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the webhook read is not over live rows: ${query}`));
        }

        let matched = [...database.webhookRows];
        const idPart = parts.find((part) => part.startsWith("id=eq."));

        if (idPart !== undefined) {
          const wantedId = decodeURIComponent(idPart.slice("id=eq.".length));
          matched = matched.filter((row) => row.id === wantedId);
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        return Promise.resolve(capped.map((row) => schema.parse(row)));
      }

      // The `0109` document requests: company-scoped, any eq filter, ordered and limited.
      if (table === KYC_DOCUMENT_REQUESTS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the request read is not over live rows: ${query}`));
        }

        const wantedRequestCompany = scopedCompany(query);
        let matched = [...database.requestRows];

        if (wantedRequestCompany !== null) {
          matched = matched.filter((row) => row.company_id === wantedRequestCompany);
        }

        for (const part of parts) {
          const eq = /^([a-z_]+)=eq\.(.+)$/u.exec(part);

          if (eq !== null) {
            const column = eq[1] ?? "";
            const value = decodeURIComponent(eq[2] ?? "");
            matched = matched.filter(
              (row) => String((row as unknown as Record<string, unknown>)[column]) === value,
            );
          }
        }

        const ordered = parts.find((part) => part.startsWith("order="));

        if (ordered === "order=created_at.asc") {
          matched = [...matched].sort((left, right) => left.created_at.localeCompare(right.created_at));
        }

        if (ordered === "order=created_at.desc") {
          matched = [...matched].sort((left, right) => right.created_at.localeCompare(left.created_at));
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        // Rows seeded before a column existed still answer with the migration's default.
        const withDefaults = capped.map((row) => ({
          fulfilled_by: null,
          fulfilled_at: null,
          cancelled_at: null,
          version: 1,
          updated_at: row.created_at,
          ...row,
        }));

        return Promise.resolve(withDefaults.map((row) => schema.parse(row)));
      }

      // The `0003` users, the `0046` payout bank accounts and the `0110` duplicate cases: the
      // duplicate check reads them with plain eq filters, across companies where it matches.
      if (table === "users" || table === "payout_bank_accounts" || table === DUPLICATE_CASES_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the ${table} read is not over live rows: ${query}`));
        }

        const allRows = (
          table === "users"
            ? database.userRows
            : table === "payout_bank_accounts"
              ? database.bankRows
              : database.caseRows
        ) as unknown as readonly Record<string, unknown>[];
        const matched = eqFilter(allRows, parts);
        const limit = limitOf(parts);
        const capped = limit === null ? matched : matched.slice(0, limit);
        const withDefaults = capped.map((row) => ({
          ...(table === "users" ? { phone: null, status: "active", version: 1 } : {}),
          ...(table === DUPLICATE_CASES_TABLE
            ? {
                matched_company_id: null,
                matched_user_id: null,
                status: "open",
                reviewed_by: null,
                reviewed_at: null,
                resolution: null,
                version: 1,
                updated_at: row["created_at"],
              }
            : {}),
          ...row,
        }));

        return Promise.resolve(withDefaults.map((row) => schema.parse(row)));
      }

      // STEP 099: the `0111` lifecycle events, the `0045` payouts, the `0040`/`0041` ledger and the
      // `0080` settings - read with plain eq filters, across companies where the office queue does.
      if (
        table === MERCHANT_ACCOUNT_EVENTS_TABLE ||
        table === PAYOUTS_TABLE ||
        table === LEDGER_ACCOUNTS_TABLE ||
        table === LEDGER_ENTRIES_TABLE ||
        table === PLATFORM_SETTINGS_TABLE
      ) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the ${table} read is not over live rows: ${query}`));
        }

        const allRows = (
          table === MERCHANT_ACCOUNT_EVENTS_TABLE
            ? database.eventRows
            : table === PAYOUTS_TABLE
              ? database.payoutRows
              : table === LEDGER_ACCOUNTS_TABLE
                ? database.ledgerAccountRows
                : table === LEDGER_ENTRIES_TABLE
                  ? database.ledgerEntryRows
                  : database.settingRows
        ) as unknown as readonly Record<string, unknown>[];
        let matched = eqFilter(allRows, parts);

        const ordered = parts.find((part) => part.startsWith("order="));

        if (ordered === "order=created_at.asc" || ordered === "order=created_at.desc") {
          // Ties on created_at (the fake clock is fixed) break by insertion order, newest last for
          // asc and newest first for desc, the way a real sequence would behave.
          const indexed = matched.map((row, index) => ({ row, index }));
          const descending = ordered === "order=created_at.desc";

          indexed.sort((left, right) => {
            const byTime = String(left.row["created_at"]).localeCompare(String(right.row["created_at"]));

            if (byTime !== 0) {
              return descending ? -byTime : byTime;
            }

            return descending ? right.index - left.index : left.index - right.index;
          });
          matched = indexed.map((entry) => entry.row);
        }

        const limit = limitOf(parts);
        const capped = limit === null ? matched : matched.slice(0, limit);
        const withDefaults = capped.map((row) => ({
          ...(table === MERCHANT_ACCOUNT_EVENTS_TABLE
            ? {
                reason: null,
                detail: null,
                required_documents: null,
                actor_user_id: null,
                kyc_submission_id: null,
                payout_bank_account_id: null,
                hold_release_at: null,
                chargeback_hold_release_at: null,
                version: 1,
                updated_at: row["created_at"],
              }
            : {}),
          ...(table === PAYOUTS_TABLE
            ? { version: 1, updated_at: row["created_at"], settlement_id: null, platform_fee_minor: 0, requested_by: "", destination_bank_name: null, destination_last_four: null, destination_country: null, is_remainder: false, note: null }
            : {}),
          ...(table === PLATFORM_SETTINGS_TABLE ? {} : {}),
          ...row,
        }));

        return Promise.resolve(withDefaults.map((row) => schema.parse(row)));
      }

      const wanted = scopedCompany(query);

      // The KYC tables of 0048-0051: company-scoped like the profile, with their own eq filters.
      if (
        table === KYC_SUBMISSIONS_TABLE ||
        table === KYC_DOCUMENTS_TABLE ||
        table === UBO_RECORDS_TABLE ||
        table === SANCTIONS_SCREENINGS_TABLE ||
        table === MERCHANT_LIMITS_TABLE
      ) {
        const parts = query.split("&");
        const allRows = (
          table === KYC_SUBMISSIONS_TABLE
            ? database.submissionRows
            : table === KYC_DOCUMENTS_TABLE
              ? database.documentRows
              : table === UBO_RECORDS_TABLE
                ? database.uboRows
                : table === SANCTIONS_SCREENINGS_TABLE
                  ? database.screeningRows
                  : database.limitRows
        ) as unknown as readonly Record<string, unknown>[];

        let matched = wanted === null ? [...allRows] : allRows.filter((row) => row["company_id"] === wanted);

        for (const part of parts) {
          const eq = /^([a-z_]+)=eq\.(.+)$/u.exec(part);

          if (eq !== null) {
            const column = eq[1] ?? "";
            const value = decodeURIComponent(eq[2] ?? "");
            matched = matched.filter((row) => String(row[column]) === value);
          }

          if (part.startsWith("status=in.(")) {
            const values = decodeURIComponent(part.slice("status=in.(".length).replace(/\)$/u, "")).split(",");
            matched = matched.filter((row) => values.includes(String(row["status"])));
          }
        }

        const ordered = parts.find((part) => part.startsWith("order="));

        if (ordered === "order=created_at.asc") {
          matched = [...matched].sort((left, right) =>
            String(left["created_at"]).localeCompare(String(right["created_at"])),
          );
        }

        if (ordered === "order=created_at.desc") {
          matched = [...matched].sort((left, right) =>
            String(right["created_at"]).localeCompare(String(left["created_at"])),
          );
        }

        if (ordered === "order=submitted_at.asc") {
          matched = [...matched].sort((left, right) =>
            String(left["submitted_at"] ?? "").localeCompare(String(right["submitted_at"] ?? "")),
          );
        }

        const limit = parts.find((part) => part.startsWith("limit="));
        const capped =
          limit === undefined
            ? matched
            : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

        // Rows seeded before a column existed still answer with the migration's default.
        const withDefaults = capped.map((row) => ({
          ...(table === KYC_SUBMISSIONS_TABLE
            ? {
                submitted_at: null,
                submitted_by: null,
                first_reviewer_id: null,
                decided_at: null,
                decision_reason: null,
                provider_reference: null,
                high_risk: false,
                four_eye_required: false,
                version: 1,
                updated_at: row["created_at"],
              }
            : {}),
          ...(table === KYC_DOCUMENTS_TABLE
            ? { rejection_reason: null, reviewed_at: null, reviewed_by: null, version: 1, updated_at: row["created_at"] }
            : {}),
          ...row,
        }));

        return Promise.resolve(withDefaults.map((row) => schema.parse(row)));
      }

      if (table === BUSINESS_PROFILE_TABLE) {
        if (wanted === null) {
          // STEP 098: the duplicate check matches contact_phone and tax_id across companies.
          const signalEq = /^select=id,company_id&(contact_phone|tax_id)=eq\./u.exec(query);

          if (signalEq !== null) {
            const column = signalEq[1] ?? "";
            const value = decodeURIComponent(query.split(`${column}=eq.`)[1]?.split("&")[0] ?? "");
            const matched = database.profileRows.filter((row) => String((row as unknown as Record<string, unknown>)[column]) === value);
            const limit = limitOf(query.split("&"));
            const capped = limit === null ? matched : matched.slice(0, limit);

            return Promise.resolve(
              capped.map((row) => schema.parse({ id: row.id ?? row.company_id, company_id: row.company_id })),
            );
          }

          // The one deliberate cross-company profile read: the underwriting MCC overview of
          // STEP 090, which counts profiles by the code they carry and selects nothing else.
          if (query.includes("mcc_code=not.is.null")) {
            const limit = query.split("&").find((part) => part.startsWith("limit="));
            const matched = database.profileRows.filter((row) => row.mcc_code !== null);
            const capped =
              limit === undefined
                ? matched
                : matched.slice(0, Number.parseInt(limit.slice("limit=".length), 10));

            return Promise.resolve(capped.map((row) => schema.parse({ mcc_code: row.mcc_code })));
          }

          throw new Error(`the profile read is not scoped to one live company: ${query}`);
        }

        const limit = query.split("&").find((part) => part.startsWith("limit="));

        if (limit === undefined) {
          return Promise.reject(new Error(`the profile read is unbounded: ${query}`));
        }

        const matched = database.profileRows.filter((row) => row.company_id === wanted);

        return Promise.resolve(matched.slice(0, 1).map((row) => schema.parse(row)));
      }

      if (table === ONBOARDING_PROGRESS_TABLE) {
        if (wanted === null) {
          throw new Error(`the progress read is not scoped to one live company: ${query}`);
        }

        const matched = database.onboardingRows.filter((row) => row.company_id === wanted);

        return Promise.resolve(matched.slice(0, 1).map((row) => schema.parse(row)));
      }

      return Promise.reject(new Error(`the form reads no other table: ${table}`));
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      // The KYC tables of 0048-0051: recorded, and materialised with the defaults the migration gives.
      if (
        table === KYC_SUBMISSIONS_TABLE ||
        table === KYC_DOCUMENTS_TABLE ||
        table === UBO_RECORDS_TABLE ||
        table === SANCTIONS_SCREENINGS_TABLE
      ) {
        if (table === KYC_SUBMISSIONS_TABLE && database.conflictOnInsert) {
          database.conflictOnInsert = false;

          return Promise.reject(new AppError("CONFLICT", { cause: { code: UNIQUE_VIOLATION } }));
        }

        for (const row of rows) {
          database.inserts.push({ table, row: { ...row } });

          // Real rows get a uuid v7 from the database default; the fake keeps the same shape.
          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.inserts.length).padStart(12, "0")}`;
          const created = new Date(NOW).toISOString();
          const text = (key: string): string => String(row[key] ?? "");
          const nullable = (key: string): string | null => {
            const value = row[key];

            return typeof value === "string" ? value : null;
          };

          if (table === KYC_SUBMISSIONS_TABLE) {
            database.submissionRows.push({
              id,
              company_id: text("company_id"),
              status: text("status") || "draft",
              verification_method: text("verification_method") || "manual",
              submitted_at: nullable("submitted_at"),
              submitted_by: nullable("submitted_by"),
              first_reviewer_id: nullable("first_reviewer_id"),
              decided_at: nullable("decided_at"),
              decision_reason: nullable("decision_reason"),
              provider_reference: nullable("provider_reference"),
              high_risk: Boolean(row["high_risk"]),
              four_eye_required: Boolean(row["four_eye_required"]),
              version: Number(row["version"] ?? 1),
              updated_at: created,
              created_at: created,
            });
          }

          if (table === KYC_DOCUMENTS_TABLE) {
            database.documentRows.push({
              id,
              company_id: text("company_id"),
              submission_id: text("submission_id"),
              document_type: text("document_type"),
              storage_key: text("storage_key"),
              content_sha256: text("content_sha256"),
              content_type: text("content_type"),
              byte_size: Number(row["byte_size"] ?? 0),
              issued_at: nullable("issued_at"),
              expires_at: nullable("expires_at"),
              status: text("status") || "uploaded",
              rejection_reason: nullable("rejection_reason"),
              reviewed_at: nullable("reviewed_at"),
              reviewed_by: nullable("reviewed_by"),
              version: Number(row["version"] ?? 1),
              updated_at: created,
              created_at: created,
            });
          }

          if (table === UBO_RECORDS_TABLE) {
            database.uboRows.push({
              id,
              company_id: text("company_id"),
              submission_id: text("submission_id"),
              full_name: text("full_name"),
              date_of_birth: text("date_of_birth"),
              country: text("country"),
              ownership_bps: Number(row["ownership_bps"] ?? 0),
              is_significant: Boolean(row["is_significant"]),
              id_document_sha256: text("id_document_sha256"),
              is_pep: false,
              screened_at: nullable("screened_at"),
              created_at: created,
            });
          }

          if (table === SANCTIONS_SCREENINGS_TABLE) {
            database.screeningRows.push({
              id,
              company_id: text("company_id"),
              subject_kind: text("subject_kind"),
              subject_id: text("subject_id"),
              ofac_checked: Boolean(row["ofac_checked"]),
              un_checked: Boolean(row["un_checked"]),
              eu_checked: Boolean(row["eu_checked"]),
              us_checked: Boolean(row["us_checked"]),
              result: text("result"),
              provider: text("provider") || "manual",
              screened_at: text("screened_at") || created,
              note: nullable("note"),
              sar_case: Boolean(row["sar_case"]),
              created_at: created,
            });
          }
        }

        return Promise.resolve();
      }

      if (table === MERCHANT_LIMITS_TABLE) {
        if (database.conflictOnInsert) {
          database.conflictOnInsert = false;

          return Promise.reject(new AppError("CONFLICT", { cause: { code: UNIQUE_VIOLATION } }));
        }

        for (const row of rows) {
          database.inserts.push({ table, row: { ...row } });

          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.inserts.length).padStart(12, "0")}`;
          const created = new Date(NOW).toISOString();

          database.limitRows.push({
            id,
            company_id: String(row["company_id"] ?? ""),
            month_key: String(row["month_key"] ?? ""),
            monthly_limit: String(row["monthly_limit"] ?? "0.0000"),
            used_amount: String(row["used_amount"] ?? "0.0000"),
            updated_by: typeof row["updated_by"] === "string" ? row["updated_by"] : null,
            version: Number(row["version"] ?? 1),
            updated_at: created,
            created_at: created,
          });
        }

        return Promise.resolve();
      }

      if (table === KYC_DOCUMENT_REQUESTS_TABLE) {
        for (const row of rows) {
          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.requestRows.length + 1).padStart(12, "0")}`;
          const created = new Date(NOW).toISOString();
          const materialised: DocumentRequestRowShape = {
            id,
            company_id: String(row["company_id"] ?? ""),
            submission_id: String(row["submission_id"] ?? ""),
            provider_id: String(row["provider_id"] ?? ""),
            document_label: String(row["document_label"] ?? ""),
            note: typeof row["note"] === "string" ? row["note"] : null,
            status: String(row["status"] ?? "open"),
            fulfilled_by: null,
            fulfilled_at: null,
            cancelled_at: null,
            version: 1,
            updated_at: created,
            created_at: created,
          };

          database.inserts.push({ table, row: { ...row } });

          if (database.requestInsertConflict) {
            // The winner's row exists; our insert loses the unique race.
            database.requestInsertConflict = false;
            database.requestRows.push(materialised);

            return Promise.reject(new AppError("CONFLICT", { cause: { code: UNIQUE_VIOLATION } }));
          }

          database.requestRows.push(materialised);
        }

        return Promise.resolve();
      }

      if (table === DUPLICATE_CASES_TABLE) {
        for (const row of rows) {
          database.inserts.push({ table, row: { ...row } });

          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.caseRows.length + 1).padStart(12, "0")}`;
          const created = new Date(NOW).toISOString();

          database.caseRows.push({
            id,
            company_id: String(row["company_id"] ?? ""),
            stage: String(row["stage"] ?? ""),
            signal: String(row["signal"] ?? ""),
            matched_company_id: typeof row["matched_company_id"] === "string" ? row["matched_company_id"] : null,
            matched_user_id: typeof row["matched_user_id"] === "string" ? row["matched_user_id"] : null,
            status: String(row["status"] ?? "open"),
            reviewed_by: null,
            reviewed_at: null,
            resolution: null,
            version: 1,
            updated_at: created,
            created_at: created,
          });
        }

        return Promise.resolve();
      }

      // STEP 099: the `0111` lifecycle events, the `0043` closure hold and the `0045` closure payout.
      if (table === MERCHANT_ACCOUNT_EVENTS_TABLE || table === HOLDS_TABLE || table === PAYOUTS_TABLE) {
        for (const row of rows) {
          database.inserts.push({ table, row: { ...row } });

          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.inserts.length).padStart(12, "0")}`;
          const created = row["created_at"] ?? new Date(NOW).toISOString();
          const createdText = typeof created === "string" ? created : new Date(NOW).toISOString();

          if (table === MERCHANT_ACCOUNT_EVENTS_TABLE) {
            database.eventRows.push({
              id,
              company_id: String(row["company_id"] ?? ""),
              event: String(row["event"] ?? ""),
              reason: typeof row["reason"] === "string" ? row["reason"] : null,
              detail: typeof row["detail"] === "string" ? row["detail"] : null,
              required_documents: Array.isArray(row["required_documents"])
                ? (row["required_documents"] as readonly string[])
                : null,
              actor_user_id: typeof row["actor_user_id"] === "string" ? row["actor_user_id"] : null,
              kyc_submission_id: typeof row["kyc_submission_id"] === "string" ? row["kyc_submission_id"] : null,
              payout_bank_account_id:
                typeof row["payout_bank_account_id"] === "string" ? row["payout_bank_account_id"] : null,
              hold_release_at: typeof row["hold_release_at"] === "string" ? row["hold_release_at"] : null,
              chargeback_hold_release_at:
                typeof row["chargeback_hold_release_at"] === "string" ? row["chargeback_hold_release_at"] : null,
              version: 1,
              updated_at: createdText,
              created_at: createdText,
            });
          }

          if (table === HOLDS_TABLE) {
            database.fundHoldRows.push({
              id,
              company_id: String(row["company_id"] ?? ""),
              payment_id: typeof row["payment_id"] === "string" ? row["payment_id"] : null,
              settlement_id: typeof row["settlement_id"] === "string" ? row["settlement_id"] : null,
              amount_minor: String(row["amount_minor"] ?? "0"),
              currency: String(row["currency"] ?? "USD"),
              reason: String(row["reason"] ?? ""),
              status: String(row["status"] ?? "active"),
              placed_at: String(row["placed_at"] ?? createdText),
              release_due_at: String(row["release_due_at"] ?? createdText),
              version: 1,
              updated_at: createdText,
              created_at: createdText,
            });
          }

          if (table === PAYOUTS_TABLE) {
            database.payoutRows.push({
              id,
              company_id: String(row["company_id"] ?? ""),
              settlement_id: typeof row["settlement_id"] === "string" ? row["settlement_id"] : null,
              amount_minor: String(row["amount_minor"] ?? "0"),
              currency: String(row["currency"] ?? "USD"),
              platform_fee_minor: Number(row["platform_fee_minor"] ?? 0),
              status: String(row["status"] ?? "requested"),
              requested_by: String(row["requested_by"] ?? ""),
              destination_bank_name: typeof row["destination_bank_name"] === "string" ? row["destination_bank_name"] : null,
              destination_last_four:
                typeof row["destination_last_four"] === "string" ? row["destination_last_four"] : null,
              destination_country: typeof row["destination_country"] === "string" ? row["destination_country"] : null,
              is_remainder: Boolean(row["is_remainder"] ?? false),
              note: typeof row["note"] === "string" ? row["note"] : null,
              version: 1,
              updated_at: createdText,
              created_at: createdText,
            });
          }
        }

        return Promise.resolve();
      }

      if (table === PAYMENT_HOLDS_TABLE) {
        for (const row of rows) {
          database.inserts.push({ table, row: { ...row } });

          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.holdRows.length + 1).padStart(12, "0")}`;
          const created = new Date(NOW).toISOString();

          database.holdRows.push({
            id,
            company_id: String(row["company_id"] ?? ""),
            reference: typeof row["reference"] === "string" ? row["reference"] : null,
            amount: String(row["amount"] ?? "0.0000"),
            status: String(row["status"] ?? "held"),
            held_at: String(row["held_at"] ?? created),
            reviewed_by: null,
            reviewed_at: null,
            decision_reason: null,
            version: Number(row["version"] ?? 1),
            updated_at: created,
            created_at: created,
          });
        }

        return Promise.resolve();
      }

      if (table === SUBMERCHANT_PROVISIONS_TABLE) {
        if (database.conflictOnInsert) {
          database.conflictOnInsert = false;

          return Promise.reject(new AppError("CONFLICT", { cause: { code: UNIQUE_VIOLATION } }));
        }

        for (const row of rows) {
          database.inserts.push({ table, row: { ...row } });

          const id = `018f2b8a-0000-4c2d-9c3e-${String(database.provisionRows.length + 1).padStart(12, "0")}`;
          const created = new Date(NOW).toISOString();

          database.provisionRows.push({
            id,
            company_id: String(row["company_id"] ?? ""),
            kyc_submission_id: String(row["kyc_submission_id"] ?? ""),
            provider_id: String(row["provider_id"] ?? ""),
            provider_key: String(row["provider_key"] ?? ""),
            mode: String(row["mode"] ?? "test"),
            master_account_ref: typeof row["master_account_ref"] === "string" ? row["master_account_ref"] : null,
            provider_submerchant_id: null,
            status: String(row["status"] ?? "pending"),
            charges_enabled: Boolean(row["charges_enabled"] ?? false),
            payouts_enabled: Boolean(row["payouts_enabled"] ?? false),
            requested_at: String(row["requested_at"] ?? created),
            next_attempt_at: typeof row["next_attempt_at"] === "string" ? row["next_attempt_at"] : null,
            last_webhook_event_id: null,
            last_synced_at: null,
            version: Number(row["version"] ?? 1),
            updated_at: created,
            created_at: created,
          });
        }

        return Promise.resolve();
      }

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

            for (const column of ADDRESS_PROFILE_COLUMNS) {
              if (!(column in values)) {
                continue;
              }

              const value = values[column];
              row[column] = typeof value === "string" ? value : null;
            }

            if ("address_completed_at" in values) {
              const completed = values["address_completed_at"];
              row.address_completed_at = typeof completed === "string" ? completed : null;
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

      if (table === KYC_SUBMISSIONS_TABLE) {
        const parts = query.split("&");
        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const statusPart = parts.find((part) => part.startsWith("status=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedStatus = statusPart === undefined ? null : decodeURIComponent(statusPart.slice("status=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.submissionRows) {
          // Rows seeded before a column existed still answer with the migration's default.
          const currentVersion = row.version ?? 1;

          if (
            row.company_id === wanted &&
            (wantedId === null || row.id === wantedId) &&
            (wantedStatus === null || row.status === wantedStatus) &&
            (wantedVersion === null || currentVersion === wantedVersion)
          ) {
            if (database.submissionRace && wantedVersion !== null) {
              row.version = currentVersion + 5;

              continue;
            }

            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      // STEP 099: the `0003` users status the lifecycle writes - conditional on id, company, current
      // status and version; a row that moved on simply does not match, as PostgREST answers it.
      if (table === "users") {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the users update is not over live rows: ${query}`));
        }

        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const statusPart = parts.find((part) => part.startsWith("status=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedStatus = statusPart === undefined ? null : decodeURIComponent(statusPart.slice("status=eq.".length));
        const wantedVersion = versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.userRows) {
          if (
            row.company_id === wanted &&
            (wantedId === null || row.id === wantedId) &&
            (wantedStatus === null || (row.status ?? "active") === wantedStatus) &&
            (wantedVersion === null || (row.version ?? 1) === wantedVersion)
          ) {
            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      if (table === SUBMERCHANT_PROVISIONS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the provision update is not over live rows: ${query}`));
        }

        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const statusPart = parts.find((part) => part.startsWith("status=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedStatus = statusPart === undefined ? null : decodeURIComponent(statusPart.slice("status=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.provisionRows) {
          if (
            row.company_id === wanted &&
            (wantedId === null || row.id === wantedId) &&
            (wantedStatus === null || row.status === wantedStatus) &&
            (wantedVersion === null || (row.version ?? 1) === wantedVersion)
          ) {
            if (database.provisionRace && wantedVersion !== null) {
              row.version = (row.version ?? 1) + 5;

              continue;
            }

            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      if (table === KYC_DOCUMENTS_TABLE) {
        const parts = query.split("&");
        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const statusPart = parts.find((part) => part.startsWith("status=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedStatus = statusPart === undefined ? null : decodeURIComponent(statusPart.slice("status=eq.".length));

        for (const row of database.documentRows) {
          if (
            row.company_id === wanted &&
            (wantedId === null || row.id === wantedId) &&
            (wantedStatus === null || row.status === wantedStatus)
          ) {
            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      if (table === KYC_DOCUMENT_REQUESTS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the request update is not over live rows: ${query}`));
        }

        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const statusPart = parts.find((part) => part.startsWith("status=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedStatus = statusPart === undefined ? null : decodeURIComponent(statusPart.slice("status=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.requestRows) {
          // Rows seeded before a column existed still answer with the migration's default.
          const currentVersion = row.version ?? 1;

          if (
            row.company_id === wanted &&
            (wantedId === null || row.id === wantedId) &&
            (wantedStatus === null || row.status === wantedStatus) &&
            (wantedVersion === null || currentVersion === wantedVersion)
          ) {
            if (database.requestRace && wantedVersion !== null) {
              row.version = currentVersion + 5;

              continue;
            }

            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      if (table === UBO_RECORDS_TABLE) {
        const idPart = query.split("&").find((part) => part.startsWith("id=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));

        for (const row of database.uboRows) {
          if (row.company_id === wanted && (wantedId === null || row.id === wantedId)) {
            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      // The `0106` criteria row: conditional on id and current version; a race moves the row on
      // and lets the service's re-read see the mismatch.
      if (table === UNDERWRITING_CRITERIA_TABLE) {
        const parts = query.split("&");
        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));
        const row = database.criteriaRow;

        if (row !== null && database.criteriaRace) {
          row.version += 5;
        } else if (
          row !== null &&
          (wantedId === null || row.id === wantedId) &&
          (wantedVersion === null || row.version === wantedVersion)
        ) {
          for (const [key, value] of Object.entries(values)) {
            (row as unknown as Record<string, unknown>)[key] = value;
          }
        }

        return Promise.resolve();
      }

      if (table === UNDERWRITING_RISK_TIERS_TABLE) {
        const parts = query.split("&");
        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.tierRows) {
          if (
            (wantedId === null || row.id === wantedId) &&
            (wantedVersion === null || row.version === wantedVersion)
          ) {
            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      if (table === MCC_CODES_TABLE) {
        const parts = query.split("&");
        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.mccRows) {
          if (
            (wantedId === null || row.id === wantedId) &&
            (wantedVersion === null || row.version === wantedVersion)
          ) {
            for (const [key, value] of Object.entries(values)) {
              (row as unknown as Record<string, unknown>)[key] = value;
            }
          }
        }

        return Promise.resolve();
      }

      if (table === MERCHANT_LIMITS_TABLE) {
        const parts = query.split("&");
        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const monthPart = parts.find((part) => part.startsWith("month_key=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));
        const wantedMonth =
          monthPart === undefined ? null : decodeURIComponent(monthPart.slice("month_key=eq.".length));

        for (const row of database.limitRows) {
          if (row.company_id !== wanted) {
            continue;
          }

          if (wantedId !== null && row.id !== wantedId) {
            continue;
          }

          if (wantedVersion !== null && row.version !== wantedVersion) {
            continue;
          }

          if (wantedMonth !== null && row.month_key !== wantedMonth) {
            continue;
          }

          if (database.limitRace) {
            row.version += 5;

            continue;
          }

          for (const [key, value] of Object.entries(values)) {
            (row as unknown as Record<string, unknown>)[key] = value;
          }
        }

        return Promise.resolve();
      }

      if (table === PAYMENT_HOLDS_TABLE) {
        const parts = query.split("&");

        if (!parts.includes("deleted_at=is.null")) {
          return Promise.reject(new Error(`the hold update is not over live rows: ${query}`));
        }

        const idPart = parts.find((part) => part.startsWith("id=eq."));
        const statusPart = parts.find((part) => part.startsWith("status=eq."));
        const versionPart = parts.find((part) => part.startsWith("version=eq."));
        const wantedId = idPart === undefined ? null : decodeURIComponent(idPart.slice("id=eq.".length));
        const wantedStatus =
          statusPart === undefined ? null : decodeURIComponent(statusPart.slice("status=eq.".length));
        const wantedVersion =
          versionPart === undefined ? null : Number(versionPart.slice("version=eq.".length));

        for (const row of database.holdRows) {
          if (wantedId !== null && row.id !== wantedId) {
            continue;
          }

          if (wantedStatus !== null && row.status !== wantedStatus) {
            continue;
          }

          if (wantedVersion !== null && row.version !== wantedVersion) {
            continue;
          }

          if (database.holdRace) {
            row.version += 5;

            continue;
          }

          for (const [key, value] of Object.entries(values)) {
            (row as unknown as Record<string, unknown>)[key] = value;
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


/* -------------------------------------------------------------------------------------------------
 * STEP 082: the address and contact section on the business profile, its country list and its save.
 * ---------------------------------------------------------------------------------------------- */

const COMPLETE_ADDRESS: Readonly<Record<string, string>> = Object.freeze({
  address_line1: "12 Main Street",
  city: "Dhaka",
  postal_code: "1207",
  country_code: "BD",
  contact_name: "Karim Rahman",
  contact_email: "Owner@Acme.COM",
  contact_phone: "+880 1712-345678",
});

function saveAddress(
  actor: RequestActor,
  input: unknown,
  database: BusinessDatabase,
  audit: InMemoryAuditTrail,
  nowOverride?: () => number,
): Promise<BusinessAddressSnapshot> {
  const dependencies = nowOverride === undefined
    ? dependenciesOf(database, audit)
    : { rest: createBusinessStore(database), audit, now: nowOverride };

  return saveBusinessAddress(
    { actor, input, ipAddress: "203.0.113.9", userAgent: "gate" },
    dependencies,
  );
}

/** ---- The vocabulary: nine fields, seven required, the patterns, and the address step. */
function checkAddressVocabulary(): void {
  expectEqual(COUNTRIES_TABLE, "countries", "the country list is the table of 0076");
  expectDeepEqual(
    [...BUSINESS_ADDRESS_FIELDS],
    [
      "address_line1",
      "address_line2",
      "city",
      "state_province",
      "postal_code",
      "country_code",
      "contact_name",
      "contact_email",
      "contact_phone",
    ],
    "the section stores the nine address and contact fields, in the form's order",
  );
  expectDeepEqual(
    [...REQUIRED_ADDRESS_FIELDS],
    [
      "address_line1",
      "city",
      "postal_code",
      "country_code",
      "contact_name",
      "contact_email",
      "contact_phone",
    ],
    "seven of them are required for the step to finish",
  );
  expectDeepEqual(
    [...OPTIONAL_ADDRESS_FIELDS],
    ["address_line2", "state_province"],
    "the second line and the state or province are optional",
  );
  expectEqual(BUSINESS_ADDRESS_AUDIT_ACTION, "business_address.saved", "a save is audited under one name");
  expectEqual(BUSINESS_ADDRESS_AUDIT_ENTITY, "business_address", "against its own entity");
  expectEqual(BUSINESS_ADDRESS_ONBOARDING_STEP, "address", "and it finishes the address step");

  for (const code of ["SW1A 1AA", "10001", "1207", "DHAKA-1207"]) {
    expect(POSTAL_CODE_PATTERN.test(code), `"${code}" is a postal code`);
  }

  for (const code of ["", "AB", "A", "1 2 3 4 5 6 7 8 9 0 1", "12!34"]) {
    expectEqual(POSTAL_CODE_PATTERN.test(code), false, `"${code}" is not a postal code`);
  }

  expect(COUNTRY_CODE_PATTERN.test("BD"), "an upper case alpha-2 code is a country code");
  expectEqual(COUNTRY_CODE_PATTERN.test("bd"), false, "lower case is normalised before the check");
  expectEqual(COUNTRY_CODE_PATTERN.test("B1"), false, "a digit is not a country code");

  expect(EMAIL_PATTERN.test("owner@acme.com"), "a plain address is an email");
  expectEqual(EMAIL_PATTERN.test("Owner@Acme.COM"), false, "the parser lower cases first");
  expectEqual(EMAIL_PATTERN.test("a@b"), false, "a bare host is not an email");

  expect(PHONE_PATTERN.test("+880 1712-345678"), "a spaced international number is a phone");
  expectEqual(PHONE_PATTERN.test("01712"), false, "too short to be a phone");
  expectEqual(PHONE_PATTERN.test("call me"), false, "letters are not a phone");

  expectEqual(ADDRESS_FIELD_LIMITS.contact_email, 254, "the email ceiling matches the signup's");
  expectEqual(ADDRESS_FIELD_LIMITS.postal_code, 12, "and the postal ceiling matches 0105's check");
}

/** ---- The parse: nine fields, their rules, and a key nobody knows refused rather than dropped. */
function checkAddressParse(): void {
  const clean = parseBusinessAddressInput({ ...COMPLETE_ADDRESS });

  expectEqual(clean.problems.length, 0, "a complete body parses");
  expectEqual(Object.keys(clean.values).length, 7, "with the seven values it sent");
  expectEqual(clean.values.country_code, "BD", "the country is upper cased");
  expectEqual(clean.values.contact_email, "owner@acme.com", "and the email is lower cased");

  const padded = parseBusinessAddressInput({ address_line1: "  12   Main Street  " });

  expectEqual(padded.values.address_line1, "12 Main Street", "whitespace is collapsed and trimmed");

  const cleared = parseBusinessAddressInput({ city: "" });

  expectEqual(cleared.problems.length, 0, "an empty string is a deliberate clear");
  expectEqual(cleared.values.city, null, "and answers null");

  const unknown = parseBusinessAddressInput({ city: "Dhaka", turnover: "1000" });

  expectDeepEqual(
    unknown.problems,
    [{ field: "turnover", rule: "unknown_key" }],
    "a key outside the nine is named as unknown",
  );

  const notAnObject = parseBusinessAddressInput(["city"]);

  expectDeepEqual(
    notAnObject.problems,
    [{ field: "address", rule: "invalid_format" }],
    "a body that is not an object is refused whole",
  );

  const wrongType = parseBusinessAddressInput({ postal_code: 1207 });

  expectDeepEqual(
    wrongType.problems,
    [{ field: "postal_code", rule: "invalid_format" }],
    "a number where text belongs is a format problem",
  );

  const tooShort = parseBusinessAddressInput({ address_line1: "A" });

  expectDeepEqual(
    tooShort.problems,
    [{ field: "address_line1", rule: "too_short" }],
    "a one character street line is too short",
  );

  const tooLong = parseBusinessAddressInput({ city: "C".repeat(ADDRESS_FIELD_LIMITS.city + 1) });

  expectDeepEqual(
    tooLong.problems,
    [{ field: "city", rule: "too_long" }],
    "an over-long city is refused rather than shortened",
  );

  for (const [field, bad] of [
    ["postal_code", "AB"],
    ["country_code", "B1"],
    ["contact_email", "not-an-email"],
    ["contact_phone", "call me"],
  ] as const) {
    const parsed = parseBusinessAddressInput({ [field]: bad });

    expectDeepEqual(
      parsed.problems,
      [{ field, rule: "invalid_format" }],
      `${JSON.stringify(bad)} is refused on ${field}`,
    );
  }

  const several = parseBusinessAddressInput({ city: "D", contact_email: "nope", contact_phone: 5 });

  expectEqual(several.problems.length, 3, "three bad fields are collected in one parse");
}

/** ---- The read: the caller's own company, the enabled countries, and an honest draft. */
async function checkAddressRead(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase([businessRow({ address_line1: "12 Main Street" })]);
    const refusal = await rejectionOf(() =>
      readBusinessAddress({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the address refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads no row for ${description}`);
  }

  const empty = await readBusinessAddress(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(empty.saved, false, "a merchant with no row is answered, not refused");
  expectEqual(empty.complete, false, "with an empty section");
  expectEqual(empty.missing.length, 7, "and all seven required fields missing");
  expectDeepEqual(
    empty.countries.map((country) => country.code),
    ["BD", "US"],
    "the dropdown is the enabled countries of 0076, in code order",
  );
  expect(
    empty.countries.every((country) => country.name.length > 0),
    "and every option carries its name",
  );
  expectEqual(
    empty.values.address_line1,
    null,
    "and every value is null",
  );

  const stored = await readBusinessAddress(
    { actor: owner },
    dependenciesOf(
      createBusinessDatabase([
        businessRow({
          address_line1: "12 Main Street",
          city: "Dhaka",
          postal_code: "1207",
          country_code: "BD",
          contact_name: "Karim Rahman",
          contact_email: "owner@acme.com",
          contact_phone: "+880 1712-345678",
          address_completed_at: "2026-11-01T09:00:00.000Z",
        }),
      ]),
      createInMemoryAuditTrail(),
    ),
  );

  expectEqual(stored.saved, true, "a stored address is read back");
  expectEqual(stored.complete, true, "complete when every required field is present");
  expectEqual(stored.missing.length, 0, "with nothing missing");
  expectEqual(stored.values.country_code, "BD", "the country is the stored code");
  expectEqual(
    stored.completedAtEpochMs,
    Date.parse("2026-11-01T09:00:00.000Z"),
    "the completion instant is the row's",
  );
  expectEqual(
    stored.savedAtEpochMs,
    Date.parse("2026-11-01T09:30:00.000Z"),
    "and the save instant is the row's",
  );

  const partial = await readBusinessAddress(
    { actor: owner },
    dependenciesOf(
      createBusinessDatabase([businessRow({ address_line1: "12 Main Street", city: "Dhaka" })]),
      createInMemoryAuditTrail(),
    ),
  );

  expectEqual(partial.complete, false, "two fields are not a complete address");
  expectDeepEqual(
    [...partial.missing],
    ["postal_code", "country_code", "contact_name", "contact_email", "contact_phone"],
    "the missing list names the five still empty required fields, in form order",
  );

  // The same database, read by the owner of another company: the row of A is not B's to see.
  const otherTenant = createBusinessDatabase([businessRow({ address_line1: "12 Main Street" })]);
  const refusedRow = await readBusinessAddress(
    { actor: otherOwner },
    dependenciesOf(otherTenant, createInMemoryAuditTrail()),
  );

  expectEqual(refusedRow.saved, false, "another merchant's row is not this merchant's address");
  expectEqual(refusedRow.companyId, COMPANY_B, "the other owner reads their own company");
  expect(
    (otherTenant.queries[0] ?? "").includes(encodeURIComponent(COMPANY_B)),
    "and the query names their company, never the row's",
  );

  const brokenRow = createBusinessDatabase([businessRow({ updated_at: "not a date" })]);

  expectEqual(
    await failureOf(() =>
      readBusinessAddress({ actor: owner }, dependenciesOf(brokenRow, createInMemoryAuditTrail())),
    ),
    "INTERNAL_ERROR",
    "a row with an unreadable instant is a defect, not an empty form",
  );
}

/** ---- The save: a patch, the country checked, the completion stamped, the wizard in step. */
async function checkAddressSave(): Promise<void> {
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const first = await saveAddress(owner, { ...COMPLETE_ADDRESS }, database, audit);

  expectEqual(first.companyId, COMPANY_A, "the row is written for the actor's own company");
  expectEqual(database.inserts.length, 2, "the first save inserts the profile row and the wizard row");
  expectEqual(database.inserts[0]?.table, BUSINESS_PROFILE_TABLE, "into the business profile table");
  expectEqual(database.inserts[0]?.row["company_id"], COMPANY_A, "with the company from the session");
  expectEqual(database.inserts[0]?.row["address_line1"], "12 Main Street", "and the field that was sent");
  expectEqual(database.inserts[0]?.row["contact_email"], "owner@acme.com", "the email lower cased");
  expectEqual(database.inserts[0]?.row["address_line2"], null, "the optional field nobody sent stays null");
  expectEqual(
    database.inserts[0]?.row["address_completed_at"],
    new Date(NOW).toISOString(),
    "and the completion instant is stamped, because all seven required fields are present",
  );
  expectEqual(
    "mcc_code" in (database.inserts[0]?.row ?? {}),
    false,
    "and no column another section owns is written by this save",
  );
  expectEqual(first.complete, true, "the answer says the section is complete");
  expectEqual(first.missing.length, 0, "with nothing missing");
  expectEqual(first.completedAtEpochMs, NOW, "on the save's own clock");
  expectEqual(first.countries.length, 2, "and the country dropdown comes back with the answer");
  expectEqual(database.inserts[1]?.table, ONBOARDING_PROGRESS_TABLE, "the wizard gets a row it never had");
  expectEqual(
    database.inserts[1]?.row["current_step"],
    "category",
    "opening on the step after address",
  );
  expectDeepEqual(
    database.inserts[1]?.row["completed_steps"],
    ["address"],
    "with the address step finished",
  );

  expectEqual(audit.entries.length, 1, "the save appends exactly one audit entry");
  expectEqual(audit.entries[0]?.action, BUSINESS_ADDRESS_AUDIT_ACTION, "named business_address.saved");
  expectEqual(audit.entries[0]?.entityType, BUSINESS_ADDRESS_AUDIT_ENTITY, "on its own entity");
  expectEqual(audit.entries[0]?.entityId, COMPANY_A, "naming the company");
  expectEqual(audit.entries[0]?.ipAddress, "203.0.113.9", "with the address it came from");
  expectDeepEqual(
    audit.entries[0]?.payload?.["fields"],
    [
      "address_line1",
      "city",
      "contact_email",
      "contact_name",
      "contact_phone",
      "country_code",
      "postal_code",
    ],
    "listing the fields the save named, sorted",
  );
  expectEqual(audit.entries[0]?.payload?.["completed_now"], true, "recorded as a first completion");
  expectDeepEqual(audit.entries[0]?.payload?.["missing"], [], "with nothing missing");

  const later = NOW + 60_000;
  const second = await saveAddress(
    owner,
    { address_line2: "Floor 3" },
    database,
    audit,
    () => later,
  );

  expectEqual(database.inserts.length, 2, "a second save inserts nothing");
  expectEqual(database.updates.length, 1, "it updates the one row");
  expectDeepEqual(
    Object.keys(database.updates[0]?.values ?? {}).sort(),
    ["address_completed_at", "address_line2"],
    "the patch carries the one field this save named and the derived instant, and nothing else",
  );
  expectEqual(
    database.updates[0]?.values["address_completed_at"],
    new Date(NOW).toISOString(),
    "and a completion that already exists is not re-stamped",
  );
  expectEqual(database.profileRows[0]?.address_line1, "12 Main Street", "the field another tab may have changed is never put back");
  expectEqual(second.values.address_line2, "Floor 3", "the optional field is stored");
  expectEqual(second.complete, true, "and the section is still complete");
  expectEqual(second.savedAtEpochMs, later, "on the second save's clock");
  expectEqual(
    database.updates.filter((update) => update.table === ONBOARDING_PROGRESS_TABLE).length,
    0,
    "the wizard row is already finished, so it is not written again",
  );
  expectEqual(audit.entries.length, 2, "and a second audit entry is appended");
  expectEqual(audit.entries[1]?.payload?.["completed_now"], false, "not recorded as a completion");

  const cleared = await saveAddress(owner, { contact_phone: "" }, database, audit);

  expectEqual(cleared.complete, false, "clearing a required field uncompletes the section");
  expectEqual(
    database.updates[1]?.values["address_completed_at"],
    null,
    "and removes the completion stamp",
  );
  expectDeepEqual(
    database.updates[1]?.values["contact_phone"],
    null,
    "and stores the clear",
  );
  const wizardUpdate = database.updates.find((update) => update.table === ONBOARDING_PROGRESS_TABLE);

  expectDeepEqual(
    wizardUpdate?.values["completed_steps"],
    [],
    "and the wizard's finished list drops the address step",
  );
  expectDeepEqual(
    audit.entries[2]?.payload?.["missing"],
    ["contact_phone"],
    "the audit entry names the field that went",
  );
}

/** ---- The save's refusals: the country list, the shape, the roles, and the two racing tabs. */
async function checkAddressSaveRefusals(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase();
    const audit = createInMemoryAuditTrail();
    const refusal = await rejectionOf(() =>
      saveAddress(actor, { ...COMPLETE_ADDRESS }, database, audit),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the save refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
    expectEqual(database.inserts.length + database.updates.length, 0, `and writes nothing for ${description}`);
    expectEqual(audit.entries.length, 0, `and audits nothing for ${description}`);
  }

  const shape = createBusinessDatabase();

  for (const [label, body, field, rule] of [
    ["an empty body", {}, "address", "required"],
    ["a short postal code", { postal_code: "AB" }, "postal_code", "invalid_format"],
    ["a bad email", { contact_email: "nope" }, "contact_email", "invalid_format"],
    ["an unknown key", { city: "Dhaka", turnover: "1" }, "turnover", "unknown_key"],
  ] as const) {
    const refusal = await rejectionOf(() => saveAddress(owner, body, shape, createInMemoryAuditTrail()));

    expectEqual(refusal?.code, "VALIDATION_FAILED", `${label} is a validation failure`);
    expectDeepEqual(refusal?.details, [{ field, rule }], `naming ${field} and ${rule}`);
  }

  expectEqual(shape.queries.length, 0, "a shape refusal happens before any query");
  expectEqual(shape.inserts.length + shape.updates.length, 0, "and writes nothing");

  const unknownCountry = createBusinessDatabase();
  const unknown = await rejectionOf(() =>
    saveAddress(owner, { country_code: "ZZ" }, unknownCountry, createInMemoryAuditTrail()),
  );

  expectDeepEqual(
    unknown?.details,
    [{ field: "country_code", rule: "unknown_country" }],
    "a code the country list does not carry is unknown_country",
  );
  expectEqual(unknownCountry.inserts.length + unknownCountry.updates.length, 0, "with nothing written");

  const disabledCountry = createBusinessDatabase();
  const disabled = await rejectionOf(() =>
    saveAddress(owner, { country_code: "AQ" }, disabledCountry, createInMemoryAuditTrail()),
  );

  expectDeepEqual(
    disabled?.details,
    [{ field: "country_code", rule: "disabled_country" }],
    "a switched off or sanctioned country is disabled_country, not unknown",
  );
  expectEqual(disabledCountry.inserts.length + disabledCountry.updates.length, 0, "with nothing written");

  const racing = createBusinessDatabase();
  racing.conflictOnInsert = true;
  const accounted = createInMemoryAuditTrail();
  const rescued = await saveAddress(owner, { address_line1: "12 Main Street" }, racing, accounted);

  expectEqual(rescued.saved, true, "a save that loses the insert race still saves");
  expectEqual(
    racing.updates.filter((update) => update.table === BUSINESS_PROFILE_TABLE).length,
    1,
    "by becoming the update it would have been",
  );
  expectEqual(accounted.entries.length, 1, "and is audited once");

  const throwingAudit = {
    append(): Promise<void> {
      return Promise.reject(new Error("the audit sink is down"));
    },
  };
  const stored = await saveBusinessAddress(
    { actor: owner, input: { address_line1: "12 Main Street" }, ipAddress: null, userAgent: null },
    { rest: createBusinessStore(createBusinessDatabase()), audit: throwingAudit, now: () => NOW },
  );

  expectEqual(stored.saved, true, "a save whose audit sink fails is still stored");
}

/** ---- The sources: the route, the screen, the form and the migration say what this STEP promised. */
async function checkAddressSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/onboarding/business-address/route.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/address/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/address/address-form.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const up = await readRepositoryFile("migrations/0105_business_address.sql");
  const down = await readRepositoryFile("migrations/0105_business_address.down.sql");

  for (const [path, source] of [
    ["app/api/onboarding/business-address/route.ts", route],
    ["app/(dashboard)/onboarding/address/page.tsx", page],
    ["app/(dashboard)/onboarding/address/address-form.tsx", form],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  expectEqual(up.split("\n")[0], "-- path: migrations/0105_business_address.sql", "the migration states its path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0105_business_address.down.sql", "and so does its rollback");

  // ---- the route: token, session, body, service, in that order
  expect(route.includes("requireCsrfToken(request"), "the route checks the token first");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it looks the session up",
  );
  expect(route.indexOf("readRequestActor(") < route.indexOf("JSON.parse("), "which is before the body is parsed");
  expect(route.indexOf("JSON.parse(") < route.indexOf("saveBusinessAddress("), "and the service runs last");
  expect(route.includes("maximumBodyBytes = 8_192"), "the body is bounded");
  expect(route.includes("saveBusinessAddress("), "and saves through the service");
  expectEqual(route.includes("export const GET"), false, "the route answers POST only");
  expectEqual(route.includes('"cache-control": "no-store"'), true, "the answer is not cached");
  expectEqual(route.includes("company_id"), false, "and never takes a company from the caller");

  // ---- the screen and the form
  expect(page.includes("readOwnerActor()"), "the page reads the account through the cached reader");
  expect(page.includes("readBusinessAddress("), "and the address through the service");
  expect(page.includes("<SessionKeeper"), "and keeps the session rotating while it is read");
  expect(page.includes("AddressForm"), "and renders the form");
  expectEqual(/(super_admin|compliance_kyc|finance_ops)/u.test(page), false, "the page names no office role");

  expectEqual(form.includes('"use client"'), true, "the form is a client component");
  expect(form.includes("BUSINESS_ADDRESS_FIELDS"), "and draws its fields from the one list");
  expect(form.includes('SAVE_PATH = "/api/onboarding/business-address"'), "posting to one path");
  expectEqual((form.match(/fetch\(/gu) ?? []).length, 1, "with one fetch site");
  expectEqual((form.match(/fetch\(SAVE_PATH/gu) ?? []).length, 1, "to that path");
  expect(form.includes("csrfHeaders("), "carrying the CSRF token");
  expect(form.includes("JSON.stringify(values)"), "sending only the values it was given");
  expectEqual(form.includes("companyId:"), false, "and no company in the body");
  expectEqual(form.includes("process.env"), false, "reading no environment");

  // ---- the registry and the map
  expect(csrf.includes('"/api/onboarding/business-address",'), "the save route is on the CSRF-protected list");
  expect(copy.includes('address: "/onboarding/address"'), "the address step links to its form");

  // ---- the migration pair
  expect(up.includes("add column address_line1 text"), "0105 adds the address columns to the profile");
  expect(up.includes("add column address_completed_at timestamptz"), "and the completion instant");
  expect(up.includes("countries_code_unique unique (code)"), "with the unique constraint a foreign key can reference");
  expect(up.includes("references public.countries (code)"), "the country pointed at the 0076 list");
  expect(up.includes("business_profiles_address_completed_check"), "and the completion rule a row cannot claim without the facts");
  expect(up.includes("create index business_profiles_country_idx"), "and the country index");
  expect(down.includes("drop column if exists address_line1"), "the rollback removes the columns");
  expect(down.includes("drop constraint if exists countries_code_unique"), "and the constraint it added to the list");
  expectEqual(down.includes("create table"), false, "and creates nothing");
  expectEqual(down.includes("drop table"), false, "and removes no table another STEP owns");

  // ---- the files exist where the ownership rules put them
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/address/", repositoryRoot))).includes("page.tsx"),
    "the screen lives in the merchant dashboard area",
  );
  expect(
    (await readdir(new URL("app/api/onboarding/business-address/", repositoryRoot))).includes("route.ts"),
    "and its handler is a route handler of its own",
  );
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("business-address.ts"),
    "the service lives in services/kyc",
  );
}

/** ---- The catalog: every sentence of the form is used, and every key it names exists. */
async function checkAddressCatalog(): Promise<void> {
  const block = en.onboardingAddress as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/address/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/address/address-form.tsx");
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

  walk(block, "onboardingAddress");

  expect(flat.length > 40, "the address form has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingAddress\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const field of BUSINESS_ADDRESS_FIELDS) {
    expect(flat.includes(`onboardingAddress.${camelOf(field)}`), `the ${field} field has a label`);
    expect(flat.includes(`onboardingAddress.${camelOf(field)}Hint`), `and a hint`);
  }

  expectEqual(
    sources.includes('getMessage("onboardingAddress.missingLine")'),
    false,
    "the templated missing line is never rendered without its values",
  );
  expect(
    sources.includes('formatMessage("onboardingAddress.missingLine"'),
    "and is rendered through formatMessage",
  );
  expect(
    sources.includes('formatMessage("onboardingAddress.savedLine"'),
    "and so is the saved line",
  );
}


/* -------------------------------------------------------------------------------------------------
 * STEP 083: the one-time profile assembled for every processor, and its read.
 * ---------------------------------------------------------------------------------------------- */

const FULL_PROFILE = businessRow({
  legal_name: "Acme Trading Ltd",
  trading_name: "Acme",
  business_type: "company",
  registration_number: "C-123456",
  tax_id: "TIN-9988",
  website: "https://acme.example",
  business_description: "Sells tools",
  mcc_code: "5411",
  address_line1: "12 Main Street",
  address_line2: "Floor 3",
  city: "Dhaka",
  postal_code: "1207",
  country_code: "BD",
  contact_name: "Karim Rahman",
  contact_email: "owner@acme.com",
  contact_phone: "+880 1712-345678",
  address_completed_at: "2026-11-01T09:00:00.000Z",
  completed_at: "2026-11-01T08:00:00.000Z",
});

/** ---- The vocabulary: the reader roles, the reused table, the audit name. */
function checkProfileVocabulary(): void {
  expectDeepEqual(
    [...PROCESSOR_PROFILE_READER_ROLES],
    ["super_admin", "ceo", "compliance_kyc", "owner"],
    "the owner reads their own profile; the three office roles may read any one merchant's",
  );
  expectDeepEqual(
    [...PROCESSOR_PROFILE_OFFICE_ROLES],
    ["super_admin", "ceo", "compliance_kyc"],
    "and the office half is exactly the roles that approve or underwrite",
  );
  expectEqual(PROCESSOR_PROFILE_AUDIT_ACTION, "processor_profile.read_by_office", "an office read is audited under one name");
  expectEqual(PROCESSOR_PROFILE_AUDIT_ENTITY, "business_profile", "against the profile it read");
  expectEqual(BUSINESS_PROFILE_TABLE, "business_profiles", "the payload reads the one row of 0103, nothing new is stored");
}

/** ---- The read: roles, the company scope, the two reference names, and the audit of an office read. */
async function checkProfileRead(): Promise<void> {
  for (const [description, actor] of [
    ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
    ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
    ["an owner with no company on the session", actorOf(["owner"], null)],
    ["nobody", actorOf([], null)],
  ] as const) {
    const database = createBusinessDatabase([FULL_PROFILE]);
    const refusal = await rejectionOf(() =>
      readProcessorProfile({ actor, companyId: COMPANY_A }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the profile read refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
  }

  const database = createBusinessDatabase([FULL_PROFILE]);
  const audit = createInMemoryAuditTrail();
  const snapshot = await readProcessorProfile({ actor: owner }, dependenciesOf(database, audit));

  expectEqual(snapshot.companyId, COMPANY_A, "the owner reads their own company's profile");
  expectEqual(database.queries.length, 3, "one row read, plus the code title and the country name");
  expect((database.queries[0] ?? "").startsWith("business_profiles?"), "the first query is the profile row");
  expect(
    (database.queries[0] ?? "").includes(encodeURIComponent(COMPANY_A)),
    "scoped to the session's company",
  );
  expect((database.queries[1] ?? "").includes("code=eq.5411"), "the second resolves the code's title from 0077");
  expect((database.queries[2] ?? "").includes("code=eq.BD"), "the third resolves the country's name from 0076");
  expectEqual(snapshot.saved, true, "a stored profile is saved");
  expectEqual(snapshot.ready, true, "and complete: every processor's fields, the code and the address are present");
  expectEqual(snapshot.blocking.length, 0, "with nothing blocking");
  expectEqual(snapshot.business.legal_name, "Acme Trading Ltd", "the business values are the row's");
  expectEqual(snapshot.business.tax_id, "TIN-9988", "including the optional ones");
  expectDeepEqual(snapshot.category, { code: "5411", title: "Grocery Stores, Supermarkets" }, "the category carries the published title");
  expectEqual(snapshot.address.contact_email, "owner@acme.com", "the address block is the row's");
  expectEqual(snapshot.countryName, "Bangladesh", "and the country shows its name beside the code");
  expectEqual(snapshot.coverage.length, PLATFORM_PROVIDERS.length, "one coverage line per processor, in registry order");
  expect(
    snapshot.coverage.every((entry) => entry.missing.length === 0),
    "and none of them is waiting for anything",
  );
  expectEqual(snapshot.coverage.map((entry) => entry.provider).join(","), PLATFORM_PROVIDERS.map((provider) => provider.key).join(","), "in the registry's own order");
  expectEqual(snapshot.savedAtEpochMs, Date.parse("2026-11-01T09:30:00.000Z"), "the save instant is the row's");
  expectEqual(snapshot.completedAtEpochMs, Date.parse("2026-11-01T08:00:00.000Z"), "0103's business completion is reported beside it");
  expectEqual(snapshot.addressCompletedAtEpochMs, Date.parse("2026-11-01T09:00:00.000Z"), "and so is 0105's address completion");
  expectEqual(audit.entries.length, 0, "an owner read of their own profile is not audit logged");

  const otherTenant = createBusinessDatabase([businessRow({ company_id: COMPANY_B, legal_name: "Other Ltd" })]);
  const own = await readProcessorProfile({ actor: otherOwner }, dependenciesOf(otherTenant, createInMemoryAuditTrail()));

  expectEqual(own.companyId, COMPANY_B, "another owner reads their own company, not the row's");
  expect((otherTenant.queries[0] ?? "").includes(encodeURIComponent(COMPANY_B)), "and the query names their company");
  expectEqual(own.business.legal_name, "Other Ltd", "with their own values");

  const foreignParam = createBusinessDatabase([FULL_PROFILE]);
  const refusedParam = await rejectionOf(() =>
    readProcessorProfile({ actor: owner, companyId: COMPANY_B }, dependenciesOf(foreignParam, createInMemoryAuditTrail())),
  );

  expectEqual(refusedParam?.code, "PERMISSION_DENIED", "an owner naming another company in the parameter is refused");
  expectEqual(foreignParam.queries.length, 0, "before any query");

  const officeActor = actorOf(["super_admin"], null, { userId: OFFICE_ID });
  const officeDatabase = createBusinessDatabase([FULL_PROFILE]);
  const officeAudit = createInMemoryAuditTrail();
  const officeSnapshot = await readProcessorProfile(
    { actor: officeActor, companyId: COMPANY_A },
    dependenciesOf(officeDatabase, officeAudit),
  );

  expectEqual(officeSnapshot.companyId, COMPANY_A, "an office role reads the company they named");
  expectEqual(officeSnapshot.ready, true, "with the same assembled answer");
  expect((officeDatabase.queries[0] ?? "").includes(encodeURIComponent(COMPANY_A)), "scoped to the named company");
  expectEqual(officeAudit.entries.length, 1, "and the office read appends exactly one audit entry");
  expectEqual(officeAudit.entries[0]?.action, PROCESSOR_PROFILE_AUDIT_ACTION, "under the profile read action");
  expectEqual(officeAudit.entries[0]?.entityType, PROCESSOR_PROFILE_AUDIT_ENTITY, "on the business profile entity");
  expectEqual(officeAudit.entries[0]?.entityId, COMPANY_A, "naming the merchant read");
  expectEqual(officeAudit.entries[0]?.actorUserId, OFFICE_ID, "and the officer who read it");
  expectEqual(officeAudit.entries[0]?.companyId, COMPANY_A, "in the tenant chain of the merchant read");
  expectEqual(officeAudit.entries[0]?.payload?.["ready"], true, "recording the readiness it saw");

  for (const [label, companyId] of [
    ["a missing parameter", undefined],
    ["a parameter that is not a UUID", "not-a-uuid"],
  ] as const) {
    const noParam = createBusinessDatabase([FULL_PROFILE]);
    const noParamAudit = createInMemoryAuditTrail();
    const refusal = await rejectionOf(() =>
      readProcessorProfile({ actor: officeActor, companyId }, dependenciesOf(noParam, noParamAudit)),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `an office read with ${label} is a validation failure`);
    expectDeepEqual(refusal?.details, [{ field: "company_id", rule: "invalid_format" }], "naming the parameter");
    expectEqual(noParam.queries.length, 0, "before any query");
    expectEqual(noParamAudit.entries.length, 0, "and audits nothing");
  }

  const empty = await readProcessorProfile(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(empty.saved, false, "a merchant with no row gets an empty profile, not a refusal");
  expectEqual(empty.ready, false, "that is not ready");
  expectEqual(empty.businessMissing.length, BUSINESS_PROFILE_FIELDS.length, "with every business field missing");
  expectEqual(empty.addressMissing.length, 7, "the seven required address fields missing");
  expectEqual(
    empty.blocking.length,
    BUSINESS_PROFILE_FIELDS.length + 1 + 7,
    "blocking names all of them: business, the code and the address",
  );
  expectEqual(empty.blocking.includes("category.mcc_code"), true, "the category is named");
  expectEqual(empty.blocking[0], "business.legal_name", "in the form's order, business first");
  expect(empty.coverage.every((entry) => entry.missing.length === entry.required.length), "every processor is waiting for everything it requires");

  const partialDatabase = createBusinessDatabase([businessRow({ legal_name: "Acme Trading Ltd" })]);
  const partial = await readProcessorProfile({ actor: owner }, dependenciesOf(partialDatabase, createInMemoryAuditTrail()));

  expectEqual(partial.ready, false, "a lone legal name is not a profile the processors can be sent");
  expectDeepEqual(
    [...partial.businessMissing].sort(),
    ["business_description", "business_type", "registration_number", "tax_id", "trading_name", "website"],
    "the six other business fields are named missing",
  );
  const payoneer = partial.coverage.find((entry) => entry.provider === "payoneer");

  expectDeepEqual([...(payoneer?.missing ?? [])].sort(), ["business_type", "tax_id"], "payoneer waits for exactly the entity type and the tax id beyond the name");
  expectEqual(partial.blocking.length, 6 + 1 + 7, "six business facts, the code, seven address facts");
  expectEqual(partial.category, null, "no code stored");
  expectEqual(partial.countryName, null, "and no country name resolved");
  expectEqual(partialDatabase.queries.length, 1, "a row with no code and no country reads no reference rows");

  const retired = await readProcessorProfile(
    { actor: owner },
    dependenciesOf(createBusinessDatabase([businessRow({ mcc_code: "0001", country_code: "AQ" })]), createInMemoryAuditTrail()),
  );

  expectDeepEqual(retired.category, { code: "0001", title: "Retired Example Code" }, "a stored retired code still resolves its title, like the category form");
  expectEqual(retired.countryName, "Antarctica", "and a stored disabled country still resolves its name: the write side refuses those, the read names what is stored");

  const throwingAudit = { append(): Promise<void> { return Promise.reject(new Error("down")); } };
  const officeBrokenAudit = await readProcessorProfile(
    { actor: officeActor, companyId: COMPANY_A },
    { rest: createBusinessStore(createBusinessDatabase([FULL_PROFILE])), audit: throwingAudit, now: () => NOW },
  );

  expectEqual(officeBrokenAudit.ready, true, "an audit sink that is down does not fail an office read");

  const brokenRow = createBusinessDatabase([businessRow({ updated_at: "not a date" })]);

  expectEqual(
    await failureOf(() => readProcessorProfile({ actor: owner }, dependenciesOf(brokenRow, createInMemoryAuditTrail()))),
    "INTERNAL_ERROR",
    "a row with an unreadable instant is a defect, not an empty profile",
  );
}

/** ---- The payload: per processor, computed from the snapshot, and the provisioning refusal. */
async function checkProfilePayload(): Promise<void> {
  const full = await readProcessorProfile(
    { actor: owner },
    dependenciesOf(createBusinessDatabase([FULL_PROFILE]), createInMemoryAuditTrail()),
  );

  for (const provider of PLATFORM_PROVIDERS) {
    const payload = processorPayloadFor(full, provider.key);

    expectEqual(payload.provider, provider.key, `${provider.key} answers under its own key`);
    expectEqual(payload.displayName, provider.displayName, "with the panel's display name");
    expectEqual(payload.ready, true, "a complete profile is ready for every processor");
    expectEqual(payload.missing.length, 0, "with nothing missing");
    expectDeepEqual(
      Object.keys(payload.address).sort(),
      [...BUSINESS_ADDRESS_FIELDS].sort(),
      `${provider.key} is sent all nine address and contact fields`,
    );
    expectDeepEqual(payload.category, { code: "5411", title: "Grocery Stores, Supermarkets" }, "and the category with its title");
    expectEqual(payload.countryName, "Bangladesh", "and the country's name");
  }

  const nmi = processorPayloadFor(full, "nmi");

  expectDeepEqual(
    Object.keys(nmi.business).sort(),
    ["business_description", "business_type", "legal_name", "trading_name", "website"],
    "nmi is sent its four required fields plus the optional trading name, and not the tax id it does not ask for",
  );
  const airwallex = processorPayloadFor(full, "airwallex");

  expectEqual("tax_id" in airwallex.business, true, "airwallex takes the tax id as an optional field when it is present");
  expectEqual("business_description" in airwallex.business, true, "and the description");

  const partial = await readProcessorProfile(
    { actor: owner },
    dependenciesOf(createBusinessDatabase([businessRow({ legal_name: "Acme Trading Ltd" })]), createInMemoryAuditTrail()),
  );
  const partialPayload = processorPayloadFor(partial, "payoneer");

  expectEqual(partialPayload.ready, false, "a partial profile is not ready for any processor");
  expectDeepEqual(
    [...partialPayload.missing].sort(),
    [
      "address.address_line1",
      "address.city",
      "address.contact_email",
      "address.contact_name",
      "address.contact_phone",
      "address.country_code",
      "address.postal_code",
      "business.business_type",
      "business.tax_id",
      "category.mcc_code",
    ],
    "payoneer's payload names exactly what it still needs: its two business fields, the code and the seven address fields",
  );
  expectDeepEqual(Object.keys(partialPayload.business), ["legal_name"], "and carries only the one fact that exists");

  expectEqual(
    await failureOf(() => Promise.resolve(assertProvisionable(full))),
    "no-throw",
    "a complete profile passes the provisioning check",
  );

  const blocked = await rejectionOf(() => Promise.resolve(assertProvisionable(partial)));

  expectEqual(blocked?.code, "VALIDATION_FAILED", "a partial profile is refused for provisioning");
  expectEqual(blocked?.details?.length, 14, "naming all fourteen missing facts");
  expectDeepEqual(blocked?.details?.[0], { field: "business.trading_name", rule: "missing_required" }, "each as a field and the rule");

  const empty = await readProcessorProfile(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(
    await failureOf(() => Promise.resolve(assertProvisionable(empty))),
    "RESOURCE_NOT_FOUND",
    "a merchant with no row at all is not found, not a validation failure",
  );
}

/** ---- The sources: the GET route, the review page, the wizard map and the CSRF list say what this STEP promised. */
async function checkProfileSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/onboarding/processor-profile/route.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/review/page.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");

  for (const [path, source] of [
    ["app/api/onboarding/processor-profile/route.ts", route],
    ["app/(dashboard)/onboarding/review/page.tsx", page],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  expect(route.includes("export const GET"), "the route answers GET");
  expectEqual(route.includes("export const POST"), false, "and never POST: a read has no body to protect");
  expect(route.includes("readRequestActor("), "the session is read from the cookie");
  expect(route.indexOf("readRequestActor(") < route.indexOf("readProcessorProfile("), "before the service runs");
  expect(route.includes('searchParams.get("companyId")'), "the office names the company in the query string");
  expectEqual(route.includes("requireCsrfToken"), false, "a GET carries no CSRF check");
  expect(route.includes('"cache-control": "no-store"'), "and the answer is not cached");
  expect(route.includes("readProcessorProfile("), "through the one service");
  expectEqual(csrf.includes("processor-profile"), false, "so the path is not on the CSRF-protected POST list");

  expectEqual(page.includes('"use client"'), false, "the review page is a server component: it renders values, it has no inputs");
  expect(page.includes("readOwnerActor()"), "the page reads the account through the cached reader");
  expect(page.includes("readProcessorProfile("), "and the assembled profile through the service");
  expect(page.includes("<SessionKeeper"), "and keeps the session rotating while it is read");
  for (const state of ["signed-out", "forbidden", "unavailable", "ready"]) {
    expect(page.includes(`"${state}"`), `the page keeps the ${state} answer apart`);
  }
  expect(page.includes("processorPayloadFor") || page.includes("coverage"), "the page draws the per-processor lines from the snapshot");
  expectEqual(/[^\t\n\r\x20-\x7E]/u.test(page), false, "the page is ASCII only");

  expect(copy.includes('review: "/onboarding/review"'), "the review step links to its page");

  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/review/", repositoryRoot))).includes("page.tsx"),
    "the review page lives in the merchant dashboard area",
  );
  expect(
    (await readdir(new URL("app/api/onboarding/processor-profile/", repositoryRoot))).includes("route.ts"),
    "and its handler is a route handler of its own",
  );
  expect(
    (await readdir(new URL("services/submerchant/", repositoryRoot))).includes("processor-profile.ts"),
    "the payload service lives in services/submerchant",
  );
}

/** ---- The catalog: every sentence of the review page is used, and every key it names exists. */
async function checkProfileCatalog(): Promise<void> {
  const block = en.onboardingReview as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/review/page.tsx");

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

  walk(block, "onboardingReview");

  expect(flat.length >= 15, "the review page has its own block of copy");

  for (const path of flat) {
    expect(page.includes(`"${path}"`), `the copy key ${path} is used by the page`);
  }

  const referenced = [...page.matchAll(/"(onboardingReview\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the page names no missing key (${String(path)})`);
  }

  expectEqual(page.includes('getMessage("onboardingReview.missingLine")'), false, "the templated missing line is never rendered without its values");
  expect(page.includes('formatMessage("onboardingReview.missingLine"'), "and is rendered through formatMessage");
  expect(page.includes('formatMessage("onboardingReview.countryValue"'), "and so is the country line");
  expect(page.includes('formatMessage("onboardingReview.savedLine"'), "and the saved line");
}


/* -------------------------------------------------------------------------------------------------
 * STEP 084: the KYC pack - document upload, UBO capture, screening execution and result record.
 * ---------------------------------------------------------------------------------------------- */

const PNG_BYTES: Uint8Array = (() => {
  const bytes = new Uint8Array(8 + 64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  for (let index = 8; index < bytes.length; index += 1) {
    bytes[index] = 0x61;
  }

  return bytes;
})();

const PDF_BYTES: Uint8Array = Uint8Array.from([...Buffer.from("%PDF-1.7\n", "latin1"), 1, 2, 3, 4]);

const VALID_UBO = {
  full_name: "Karim Rahman",
  date_of_birth: "1985-04-12",
  country: "bd",
  ownership_bps: 4000,
  id_document_sha256: "a".repeat(64),
};

function pngDocumentInput(overrides: Record<string, unknown> = {}) {
  return {
    document_type: "identity_document",
    file_name: "passport.png",
    declared_content_type: "image/png",
    bytes: PNG_BYTES,
    ...overrides,
  };
}

/** ---- The vocabulary: the four tables, the six document types, the audit names. */
function checkKycVocabulary(): void {
  expectEqual(KYC_SUBMISSIONS_TABLE, "kyc_submissions", "the submission table of 0048");
  expectEqual(KYC_DOCUMENTS_TABLE, "kyc_documents", "the document table of 0049");
  expectEqual(UBO_RECORDS_TABLE, "ubo_records", "the owner table of 0050");
  expectEqual(SANCTIONS_SCREENINGS_TABLE, "sanctions_screenings", "the screening table of 0051");
  expectDeepEqual(
    [...KYC_DOCUMENT_TYPES],
    [
      "identity_document",
      "business_registration",
      "utility_bill",
      "bank_statement",
      "source_of_funds",
      "processor_request",
    ],
    "the six document types of 0049's check, in its order",
  );
  expectEqual(KYC_DOCUMENTS_ONBOARDING_STEP, "documents", "the pack completes the documents step");
  expectEqual(KYC_DOCUMENT_AUDIT_ACTION, "kyc_document.uploaded", "an upload is audited");
  expectEqual(UBO_AUDIT_ACTION, "ubo.captured", "a captured owner is audited");
  expectEqual(KYC_SCREENING_AUDIT_ACTION, "kyc_screening.ran", "a screening run is audited");
  expectEqual(KYC_AUDIT_ENTITY, "kyc_submission", "all three against the submission");
  expectEqual(KYC_UPLOAD_PURPOSE, "kyc_document", "the upload purpose of 0058");
  expectEqual(KYC_DOCUMENT_MAXIMUM_BYTES, UPLOAD_DATABASE_MAXIMUM_BYTES, "the ceiling is the row ceiling of 0057");
  expectEqual(SIGNIFICANT_OWNER_BPS, 2_500, "25 percent in basis points, as 0050's check ties it");
}

/** ---- The parses: the upload's rules and the UBO's, collected before any query. */
function checkKycParse(): void {
  const ok = parseKycDocumentInput(pngDocumentInput());

  expectEqual(ok.problems.length, 0, "a real PNG declared as image/png parses");
  expectEqual(ok.record?.contentType, "image/png", "the detected type wins");
  expectEqual(ok.record?.byteSize, PNG_BYTES.length, "the counted size is stored");
  expect(/^[0-9a-f]{64}$/u.test(ok.record?.contentSha256 ?? ""), "the hash is 64 lower case hex");

  const lying = parseKycDocumentInput(pngDocumentInput({ declared_content_type: "application/pdf" }));

  expectDeepEqual(
    lying.problems,
    [{ field: "file", rule: "file_not_acceptable" }],
    "bytes that disagree with the declared type are refused (a quarantine belongs to the storage STEP)",
  );

  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ bytes: new Uint8Array(0), declared_content_type: "image/png" })).problems,
    [{ field: "file", rule: "file_not_acceptable" }],
    "an empty file is refused",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ declared_content_type: "text/html" })).problems,
    [{ field: "file", rule: "file_not_acceptable" }],
    "a type the purpose does not accept is refused",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "diploma" })).problems,
    [{ field: "document_type", rule: "invalid_format" }],
    "a type outside the six is refused",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "utility_bill" })).problems,
    [{ field: "issued_at", rule: "required" }],
    "a utility bill without its issue date is refused, as 0049's check would",
  );
  expectDeepEqual(
    parseKycDocumentInput(
      pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-10-01", expires_at: "2026-09-01" }),
      { now: NOW },
    ).problems,
    [{ field: "expires_at", rule: "invalid_format" }],
    "an expiry before the issue date is refused",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-13-99" }), { now: NOW })
      .problems,
    [{ field: "issued_at", rule: "invalid_format" }],
    "a date that does not exist is refused once, never as required as well",
  );

  // STEP 085: the three month issue rule on the utility bill.
  expectEqual(UTILITY_BILL_MAX_AGE_MONTHS, 3, "the rule is three months, as section 5 writes it");
  expectDeepEqual(
    utilityBillIssueWindow(NOW),
    { earliest: "2026-08-02", latest: "2026-11-02" },
    "the window at 2026-11-02 runs from 2026-08-02 to today",
  );
  expectDeepEqual(
    utilityBillIssueWindow(Date.parse("2026-01-15T09:00:00.000Z")),
    { earliest: "2025-10-15", latest: "2026-01-15" },
    "and it crosses the year boundary by calendar months",
  );
  expectEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-08-02" }), { now: NOW })
      .problems.length,
    0,
    "a bill issued exactly three months ago to the day is accepted",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-08-01" }), { now: NOW })
      .problems,
    [{ field: "issued_at", rule: "invalid_range" }],
    "a bill one day older than three months is refused as out of range",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-11-03" }), { now: NOW })
      .problems,
    [{ field: "issued_at", rule: "invalid_date" }],
    "a bill dated in the future is refused, as 0049's issued_at check would",
  );
  expectEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "source_of_funds", issued_at: "2020-01-01" }), { now: NOW })
      .problems.length,
    0,
    "the date rules bind the utility bill and the bank statement only; an old source of funds date parses",
  );

  // STEP 086: the bank statement is its covered period.
  expectEqual(BANK_STATEMENT_DEFAULT_PERIOD_MONTHS, 3, "the default required period is three months");
  expectEqual(BANK_STATEMENT_MAX_AGE_MONTHS, 1, "and a statement period must end within the last month");
  expectEqual(dateStringMinusMonths("2026-11-02", 1), "2026-10-02", "the recency cutoff at NOW is 2026-10-02");
  expectEqual(monthsBetweenDates("2026-08-01", "2026-11-01"), 3, "a period from the first to the first is whole months");
  expectEqual(monthsBetweenDates("2026-08-02", "2026-11-01"), 2, "a day short of three months is two");
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "bank_statement" }), { now: NOW }).problems,
    [
      { field: "issued_at", rule: "required" },
      { field: "expires_at", rule: "required" },
    ],
    "a bank statement without its period is refused on both dates",
  );
  expectEqual(
    parseKycDocumentInput(
      pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-08-01", expires_at: "2026-11-01" }),
      { now: NOW },
    ).problems.length,
    0,
    "a statement covering exactly the last three months, ending this month, is accepted",
  );
  expectDeepEqual(
    parseKycDocumentInput(
      pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-08-01", expires_at: "2026-10-31" }),
      { now: NOW },
    ).problems,
    [{ field: "expires_at", rule: "invalid_range" }],
    "a statement covering only two months is refused as short, even though it ends recently",
  );
  expectDeepEqual(
    parseKycDocumentInput(
      pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-07-01", expires_at: "2026-10-01" }),
      { now: NOW },
    ).problems,
    [{ field: "expires_at", rule: "invalid_range" }],
    "a statement covering three months but ending more than a month ago is refused as stale",
  );
  expectDeepEqual(
    parseKycDocumentInput(
      pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-08-01", expires_at: "2026-11-01" }),
      { now: NOW, bankStatementPeriodMonths: 6 },
    ).problems,
    [{ field: "expires_at", rule: "invalid_range" }],
    "the required period arrives as a parameter: six months required refuses a three month statement",
  );
  expectEqual(
    parseKycDocumentInput(
      pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-05-01", expires_at: "2026-11-01" }),
      { now: NOW, bankStatementPeriodMonths: 6 },
    ).problems.length,
    0,
    "and accepts a six month statement when six are required",
  );
  expectDeepEqual(
    parseKycDocumentInput(pngDocumentInput({ document_type: "identity_document", issued_at: "2026-11-03" }), { now: NOW })
      .problems,
    [{ field: "issued_at", rule: "invalid_date" }],
    "but a future issue date is refused for every type, as 0049's check requires",
  );

  const ubo = parseUboInput(VALID_UBO);

  expectEqual(ubo.problems.length, 0, "a complete owner parses");
  expectEqual(ubo.values?.country, "BD", "the country is upper cased");
  expectEqual(ubo.values?.isSignificant, true, "4000 bps is significant, derived not posted");
  expectEqual(parseUboInput({ ...VALID_UBO, ownership_bps: 2499 }).values?.isSignificant, false, "2499 bps is not");

  for (const [label, input, field, rule] of [
    ["a one character name", { ...VALID_UBO, full_name: "A" }, "full_name", "too_short"],
    ["a birth before 1900", { ...VALID_UBO, date_of_birth: "1899-12-31" }, "date_of_birth", "invalid_format"],
    ["a birth in the future", { ...VALID_UBO, date_of_birth: "2999-01-01" }, "date_of_birth", "invalid_format"],
    ["a one letter country", { ...VALID_UBO, country: "B" }, "country", "invalid_format"],
    ["a zero share", { ...VALID_UBO, ownership_bps: 0 }, "ownership_bps", "invalid_format"],
    ["a share above 100 percent", { ...VALID_UBO, ownership_bps: 10_001 }, "ownership_bps", "invalid_format"],
    ["a short hash", { ...VALID_UBO, id_document_sha256: "abc" }, "id_document_sha256", "invalid_format"],
    ["a malformed id", { ...VALID_UBO, ubo_id: "nope" }, "ubo_id", "invalid_format"],
  ] as const) {
    const parsed = parseUboInput(input);

    expectDeepEqual(parsed.problems, [{ field, rule }], `${label} is refused on ${field}`);
  }
}

/** ---- The read: roles, scope, and a pack that never carries a screening result. */
async function checkKycRead(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      readKycPack({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the pack refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
  }

  const empty = await readKycPack(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(empty.submissionId, null, "a merchant with no draft gets an empty pack, not a refusal");
  expectEqual(empty.documents.length, 0, "no documents");
  expectEqual(empty.ubos.length, 0, "no owners");
  expectEqual(empty.screenedCount, 0, "nothing screened");
  expectEqual(empty.documentsComplete, false, "and the documents step is open");
  expectEqual(empty.countries.length, 3, "the UBO country list is every live country, enabled or not");
  expect(empty.countries.some((country) => country.code === "AQ"), "including a switched off one: a nationality can be any country");

  const seeded = createBusinessDatabase(
    [FULL_PROFILE],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [
      {
        id: "sub-1",
        company_id: COMPANY_A,
        status: "draft",
        verification_method: "manual",
        created_at: "2026-11-01T08:00:00.000Z",
      },
    ],
    [
      {
        id: "doc-1",
        company_id: COMPANY_A,
        submission_id: "sub-1",
        document_type: "identity_document",
        storage_key: `${COMPANY_A}/kyc/doc-1`,
        content_sha256: "b".repeat(64),
        content_type: "image/png",
        byte_size: 72,
        issued_at: null,
        expires_at: null,
        status: "uploaded",
        created_at: "2026-11-01T08:05:00.000Z",
      },
    ],
    [
      {
        id: "ubo-1",
        company_id: COMPANY_A,
        submission_id: "sub-1",
        full_name: "Karim Rahman",
        date_of_birth: "1985-04-12",
        country: "BD",
        ownership_bps: 4000,
        is_significant: true,
        id_document_sha256: "a".repeat(64),
        is_pep: false,
        screened_at: null,
        created_at: "2026-11-01T08:10:00.000Z",
      },
    ],
    [
      {
        id: "scr-1",
        company_id: COMPANY_A,
        subject_kind: "company",
        subject_id: COMPANY_A,
        ofac_checked: true,
        un_checked: true,
        eu_checked: true,
        us_checked: true,
        result: "clear",
        provider: "manual",
        screened_at: "2026-11-01T08:20:00.000Z",
        note: null,
        sar_case: false,
        created_at: "2026-11-01T08:20:00.000Z",
      },
    ],
  );
  const pack = await readKycPack({ actor: owner }, dependenciesOf(seeded, createInMemoryAuditTrail()));

  expectEqual(pack.submissionId, "sub-1", "the draft submission is found");
  expectEqual(pack.status, "draft", "with its status");
  expectEqual("method" in pack, false, "the pack never carries the verification method: 0048 says the merchant only reads status");
  expectEqual(pack.documents.length, 1, "the document is listed");
  expectEqual(pack.documents[0]?.documentType, "identity_document", "with its type");
  expectEqual(pack.documents[0]?.byteSize, 72, "its size");
  expectEqual(pack.documentsComplete, true, "one document finishes the documents step");
  expectEqual(pack.ubos.length, 1, "the owner is listed");
  expectEqual(pack.ubos[0]?.isSignificant, true, "with the significant flag");
  expectEqual(pack.screenedCount, 1, "the screening count is the only screening fact the pack carries");
  expectEqual(
    JSON.stringify(pack).includes("clear"),
    false,
    "no result, provider or note of any screening appears in the merchant's answer",
  );
  expect(
    seeded.queries.every(
      (query) => query.includes(encodeURIComponent(COMPANY_A)) || query.startsWith("countries?"),
    ),
    "every query is either scoped to the session's company or a platform-table read (the country list)",
  );

  const otherTenant = createBusinessDatabase();
  const own = await readKycPack({ actor: otherOwner }, dependenciesOf(otherTenant, createInMemoryAuditTrail()));

  expectEqual(own.companyId, COMPANY_B, "another owner reads their own company's empty pack");
  expect(
    otherTenant.queries.every(
      (query) => query.includes(encodeURIComponent(COMPANY_B)) || query.startsWith("countries?"),
    ),
    "scoped to their own company, never the row's",
  );
}

/** ---- The upload: validated bytes, one record, the audit, the wizard step. */
async function checkKycDocumentSave(): Promise<void> {
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const pack = await saveKycDocument(
    { actor: owner, input: pngDocumentInput() },
    dependenciesOf(database, audit),
  );

  const submissionInsert = database.inserts.find((insert) => insert.table === KYC_SUBMISSIONS_TABLE);
  const documentInsert = database.inserts.find((insert) => insert.table === KYC_DOCUMENTS_TABLE);

  expectEqual(submissionInsert?.row["status"], "draft", "the first save creates the draft submission");
  expectEqual(submissionInsert?.row["verification_method"], "manual", "in manual mode, no provider being connected");
  expectEqual(documentInsert?.row["company_id"], COMPANY_A, "the document belongs to the session's company");
  expectEqual(documentInsert?.row["submission_id"], submissionInsert && database.submissionRows[0]?.id, "and to that submission");
  expectEqual(documentInsert?.row["document_type"], "identity_document", "with the type the form sent");
  expect(
    typeof documentInsert?.row["storage_key"] === "string" &&
      (documentInsert.row["storage_key"] as string).startsWith(`${COMPANY_A}/kyc/`),
    "the storage key sits under the company's own tenant path",
  );
  expect(/^[0-9a-f]{64}$/u.test(String(documentInsert?.row["content_sha256"])), "the hash is recorded");
  expectEqual(documentInsert?.row["content_type"], "image/png", "the detected type, not the claim");
  expectEqual(documentInsert?.row["byte_size"], PNG_BYTES.length, "and the counted size");
  expectEqual(database.documentRows[0]?.status, "uploaded", "the row waits as uploaded");
  expectEqual(pack.documents.length, 1, "the answer lists it");
  expectEqual(pack.documentsComplete, true, "and the documents step is finished");
  expectEqual(pack.submissionId, database.submissionRows[0]?.id, "the answer names the submission");

  const progressInsert = database.inserts.find((insert) => insert.table === ONBOARDING_PROGRESS_TABLE);

  expectEqual(progressInsert?.row["current_step"], "review", "the wizard opens on the step after documents");
  expectDeepEqual(progressInsert?.row["completed_steps"], ["documents"], "with documents finished");

  expectEqual(audit.entries.length, 1, "one audit entry for the upload");
  expectEqual(audit.entries[0]?.action, KYC_DOCUMENT_AUDIT_ACTION, "under kyc_document.uploaded");
  expectEqual(audit.entries[0]?.entityType, KYC_AUDIT_ENTITY, "on the submission entity");
  expectEqual(audit.entries[0]?.entityId, database.submissionRows[0]?.id, "naming the submission");
  expectEqual(audit.entries[0]?.payload?.["document_type"], "identity_document", "recording the type, never the bytes");

  const second = await saveKycDocument(
    {
      actor: owner,
      input: pngDocumentInput({
        document_type: "bank_statement",
        declared_content_type: "application/pdf",
        bytes: PDF_BYTES,
        file_name: "statement.pdf",
        issued_at: "2026-08-01",
        expires_at: "2026-11-01",
      }),
    },
    dependenciesOf(database, audit),
  );

  expectEqual(
    database.inserts.filter((insert) => insert.table === KYC_SUBMISSIONS_TABLE).length,
    1,
    "the second save reuses the draft, it does not create another",
  );
  expectEqual(second.documents.length, 2, "both documents are listed");
  expectEqual(
    database.updates.filter((update) => update.table === ONBOARDING_PROGRESS_TABLE).length,
    0,
    "and the wizard row is already finished, so it is not written again",
  );
  expectEqual(database.documentRows[1]?.content_type, "application/pdf", "a real PDF is recorded as pdf");

  const third = await saveKycDocument(
    {
      actor: owner,
      input: pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-08-02", file_name: "bill.png" }),
    },
    dependenciesOf(database, audit),
  );

  expectEqual(third.documents.length, 3, "the boundary utility bill is the third document");
  expectEqual(
    database.documentRows[2]?.issued_at,
    "2026-08-02",
    "a bill issued exactly three months before NOW is recorded with its issue date",
  );

  const fourth = await saveKycDocument(
    {
      actor: owner,
      input: pngDocumentInput({
        document_type: "bank_statement",
        issued_at: "2026-08-01",
        expires_at: "2026-11-01",
        file_name: "statement.png",
      }),
    },
    dependenciesOf(database, audit),
  );

  expectEqual(fourth.documents.length, 4, "a statement covering the last three months is the fourth document");
  expectEqual(database.documentRows[3]?.issued_at, "2026-08-01", "with its period start recorded");
  expectEqual(database.documentRows[3]?.expires_at, "2026-11-01", "and its period end");

  const refusals = createBusinessDatabase();
  const refusalAudit = createInMemoryAuditTrail();

  for (const [label, input, details] of [
    ["a utility bill without its issue date", pngDocumentInput({ document_type: "utility_bill" }), [{ field: "issued_at", rule: "required" }]],
    ["a utility bill older than three months", pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-08-01" }), [{ field: "issued_at", rule: "invalid_range" }]],
    ["a utility bill dated in the future", pngDocumentInput({ document_type: "utility_bill", issued_at: "2026-11-03" }), [{ field: "issued_at", rule: "invalid_date" }]],
    ["a bank statement without its period", pngDocumentInput({ document_type: "bank_statement" }), [{ field: "issued_at", rule: "required" }, { field: "expires_at", rule: "required" }]],
    ["a bank statement covering only two months", pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-08-01", expires_at: "2026-10-31" }), [{ field: "expires_at", rule: "invalid_range" }]],
    ["a bank statement whose period ended over a month ago", pngDocumentInput({ document_type: "bank_statement", issued_at: "2026-07-01", expires_at: "2026-10-01" }), [{ field: "expires_at", rule: "invalid_range" }]],
    ["bytes that lie about their type", pngDocumentInput({ declared_content_type: "application/pdf" }), [{ field: "file", rule: "file_not_acceptable" }]],
    ["an empty file", pngDocumentInput({ bytes: new Uint8Array(0) }), [{ field: "file", rule: "file_not_acceptable" }]],
    ["a type outside the six", pngDocumentInput({ document_type: "diploma" }), [{ field: "document_type", rule: "invalid_format" }]],
  ] as const) {
    const refusal = await rejectionOf(() =>
      saveKycDocument({ actor: owner, input }, dependenciesOf(refusals, refusalAudit)),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `${label} is a validation failure`);
    expectDeepEqual(refusal?.details, details, `naming ${JSON.stringify(details)}`);
  }

  expectEqual(refusals.inserts.length, 0, "a refused upload writes nothing");
  expectEqual(refusals.queries.length, 0, "and queries nothing: the parse runs before any read");
  expectEqual(refusalAudit.entries.length, 0, "and audits nothing");

  const tooLarge = new Uint8Array(UPLOAD_DATABASE_MAXIMUM_BYTES + 1);
  const bigRefusal = await rejectionOf(() =>
    saveKycDocument(
      { actor: owner, input: pngDocumentInput({ bytes: tooLarge }) },
      dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectDeepEqual(
    bigRefusal?.details,
    [{ field: "file", rule: "file_not_acceptable" }],
    "a file above the 0057 row ceiling is refused",
  );

  // The lost race on the draft submission: the insert collides, the re-read finds the other tab's row.
  const racing = createBusinessDatabase(
    [],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [{ id: "sub-race", company_id: COMPANY_A, status: "draft", verification_method: "manual", created_at: "2026-11-01T07:00:00.000Z" }],
  );
  racing.conflictOnInsert = true;
  const rescued = await saveKycDocument({ actor: owner, input: pngDocumentInput() }, dependenciesOf(racing, createInMemoryAuditTrail()));

  expectEqual(rescued.submissionId, "sub-race", "a save that loses the draft-insert race still records against the existing draft");
  expectEqual(racing.documentRows[0]?.submission_id, "sub-race", "the document points at the row that won");
}

/** ---- The UBO capture: derived significance, the 100 percent ceiling, update by id. */
async function checkKycUboSave(): Promise<void> {
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const pack = await saveUbo({ actor: owner, input: VALID_UBO }, dependenciesOf(database, audit));

  expectEqual(database.uboRows.length, 1, "the owner is recorded");
  expectEqual(database.uboRows[0]?.is_significant, true, "significance is derived from the share");
  expectEqual(database.uboRows[0]?.country, "BD", "the country is upper cased");
  expectEqual(database.uboRows[0]?.submission_id, database.submissionRows[0]?.id, "against the draft submission");
  expectEqual(pack.ubos.length, 1, "and listed in the answer");
  expectEqual(audit.entries[0]?.action, UBO_AUDIT_ACTION, "audited as ubo.captured");
  expectEqual(audit.entries[0]?.payload?.["ownership_bps"], 4000, "the share in the audit, not the name or the hash");

  const small = await saveUbo(
    { actor: owner, input: { ...VALID_UBO, full_name: "Other Person", ownership_bps: 2499 } },
    dependenciesOf(database, audit),
  );

  expectEqual(small.ubos.length, 2, "a second owner is added");
  expectEqual(database.uboRows[1]?.is_significant, false, "2499 bps is stored as not significant");

  const over = await rejectionOf(() =>
    saveUbo(
      { actor: owner, input: { ...VALID_UBO, full_name: "Third Person", ownership_bps: 10_000 - 4000 - 2499 + 1 } },
      dependenciesOf(database, createInMemoryAuditTrail()),
    ),
  );

  expectDeepEqual(
    over?.details,
    [{ field: "ownership_bps", rule: "ownership_total_exceeded" }],
    "a share that would take the total above 100 percent is refused before the 0050 guard has to",
  );
  expectEqual(database.uboRows.length, 2, "and nothing was written");

  const updated = await saveUbo(
    { actor: owner, input: { ...VALID_UBO, ubo_id: database.uboRows[0]?.id, ownership_bps: 3000 } },
    dependenciesOf(database, audit),
  );

  expectEqual(database.uboRows.length, 2, "an update by id inserts nothing new");
  expectEqual(database.uboRows[0]?.ownership_bps, 3000, "the share is corrected");
  expectEqual(database.uboRows[0]?.is_significant, true, "and significance follows the new share");
  expectEqual(updated.ubos[0]?.ownershipBps, 3000, "the answer shows the correction");
  expect(
    database.updates.some((update) => update.table === UBO_RECORDS_TABLE && update.values["ownership_bps"] === 3000),
    "the update carried the share",
  );

  const unknown = await rejectionOf(() =>
    saveUbo(
      { actor: owner, input: { ...VALID_UBO, ubo_id: "018f2b8a-9999-4c2d-9c3e-000000000009" } },
      dependenciesOf(database, createInMemoryAuditTrail()),
    ),
  );

  expectDeepEqual(unknown?.details, [{ field: "ubo_id", rule: "not_found" }], "an id not on this submission is not found");

  const invalid = createBusinessDatabase();
  const invalidRefusal = await rejectionOf(() =>
    saveUbo({ actor: owner, input: { ...VALID_UBO, full_name: "A", ownership_bps: 0 } }, dependenciesOf(invalid, createInMemoryAuditTrail())),
  );

  expectEqual(invalidRefusal?.details?.length, 2, "both bad fields are collected in one parse");
  expectEqual(invalid.queries.length, 0, "a bad body queries nothing");
}

/** ---- The screening: one row per subject, the local signal, the audit, and no result to the merchant. */
async function checkKycScreening(): Promise<void> {
  const database = createBusinessDatabase(
    [businessRow({ country_code: "BD" })],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [{ id: "sub-1", company_id: COMPANY_A, status: "draft", verification_method: "manual", created_at: "2026-11-01T08:00:00.000Z" }],
    [],
    [
      {
        id: "ubo-1",
        company_id: COMPANY_A,
        submission_id: "sub-1",
        full_name: "Karim Rahman",
        date_of_birth: "1985-04-12",
        country: "AQ",
        ownership_bps: 4000,
        is_significant: true,
        id_document_sha256: "a".repeat(64),
        is_pep: false,
        screened_at: null,
        created_at: "2026-11-01T08:10:00.000Z",
      },
    ],
  );
  const audit = createInMemoryAuditTrail();
  const pack = await runKycScreening({ actor: owner }, dependenciesOf(database, audit));

  expectEqual(database.screeningRows.length, 2, "one row for the company and one for the UBO");
  const companyRow = database.screeningRows.find((row) => row.subject_kind === "company");
  const uboRow = database.screeningRows.find((row) => row.subject_kind === "ubo");

  expectEqual(companyRow?.subject_id, COMPANY_A, "the company subject is the merchant itself, as 0051's check requires");
  expectEqual(companyRow?.result, "clear", "BD is not sanctioned, so the company screens clear");
  expectEqual(uboRow?.result, "possible_match", "a UBO whose country of record is sanctioned is a possible match");
  expect((uboRow?.note ?? "").length > 0, "with the reason in the note");
  expectEqual(uboRow?.provider, "manual", "the provider says manual: no adapter is connected");
  expect(
    [uboRow?.ofac_checked, uboRow?.un_checked, uboRow?.eu_checked, uboRow?.us_checked].every(Boolean),
    "all four lists are recorded as covered",
  );
  expectEqual(uboRow?.sar_case ?? false, false, "this service never raises a SAR flag; only the office can");
  expectEqual(database.uboRows[0]?.screened_at, new Date(NOW).toISOString(), "the UBO's screened_at is stamped");
  expect(
    database.updates.some((update) => update.table === UBO_RECORDS_TABLE && "screened_at" in update.values),
    "by an update to the owner row",
  );
  expectEqual(pack.screenedCount, 2, "the answer carries the count");
  expectEqual(JSON.stringify(pack).includes("possible_match"), false, "and never a result");
  expectEqual(audit.entries[0]?.action, KYC_SCREENING_AUDIT_ACTION, "the run is audited");
  expectDeepEqual(
    audit.entries[0]?.payload && { subjects: audit.entries[0].payload["subjects"], clear: audit.entries[0].payload["clear"], possible_match: audit.entries[0].payload["possible_match"] },
    { subjects: 2, clear: 1, possible_match: 1 },
    "the audit records how many of each",
  );

  const rerun = await runKycScreening({ actor: owner }, dependenciesOf(database, audit));

  expectEqual(database.screeningRows.length, 2, "a rerun does not screen the same subjects twice");
  expectEqual(rerun.screenedCount, 2, "the count is unchanged");

  const empty = createBusinessDatabase();
  const emptyPack = await runKycScreening({ actor: owner }, dependenciesOf(empty, createInMemoryAuditTrail()));

  expectEqual(empty.screeningRows.length, 1, "with no UBO captured, only the company is screened");
  expectEqual(empty.screeningRows[0]?.result, "clear", "no country on the profile, no local signal, clear");
  expectEqual(emptyPack.submissionId !== null, true, "and the run creates the draft submission it screened against");
}

/** ---- The sources: three POST routes, the page, the form, the wizard map and the CSRF list. */
/** ---- STEP 087: the merchant's summary and status, and the submit that moves draft -> submitted. */
async function checkKycSummary(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      readKycSummary({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the summary refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
  }

  const empty = await readKycSummary(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(empty.submissionId, null, "a merchant with no submission gets an empty summary, not a refusal");
  expectEqual(empty.status, null, "no status yet");
  expectEqual(empty.documentCount, 0, "no documents");
  expectEqual(empty.ownerCount, 0, "no owners");
  expectEqual(empty.screenedCount, 0, "nothing screened");
  expectDeepEqual(empty.missing, ["documents", "screening"], "and both block a submit");
  expectEqual(empty.canSubmit, false, "so it cannot submit");

  // Build a real state: a document, a UBO, a screening run.
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const deps = dependenciesOf(database, audit);

  await saveKycDocument({ actor: owner, input: pngDocumentInput() }, deps);
  await saveUbo({ actor: owner, input: VALID_UBO }, deps);
  await runKycScreening({ actor: owner }, deps);

  const summary = await readKycSummary({ actor: owner }, deps);

  expectEqual(summary.status, "draft", "the open submission is the draft");
  expectEqual(summary.documentCount, 1, "one document is counted");
  expectEqual(summary.documents[0]?.documentType, "identity_document", "listed with its type");
  expectEqual(summary.ownerCount, 1, "one owner");
  expectEqual(summary.significantOwnerCount, 1, "and it is significant at 4000 bps");
  expectEqual(summary.screenedCount, 2, "the company and the UBO were screened");
  expectDeepEqual(summary.missing, [], "nothing blocks a submit");
  expectEqual(summary.canSubmit, true, "so a draft with documents and screening can submit");

  const serialized = JSON.stringify(summary);

  expectEqual(serialized.includes("manual"), false, "the summary never names the verification method");
  expectEqual(serialized.includes("provider_reference"), false, "never a provider reference");
  expectEqual(serialized.includes("storage_key"), false, "never a storage key");
  expectEqual(serialized.includes(database.documentRows[0]?.content_sha256 ?? "\u0000"), false, "never a hash");
  expect(
    database.queries.every(
      (query) => query.includes(encodeURIComponent(COMPANY_A)) || query.startsWith("countries?"),
    ),
    "every query is scoped to the session's company or is the platform country list",
  );

  // A decided submission is shown with its reason, and cannot be submitted again.
  const decided = createBusinessDatabase(
    [],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [
      {
        id: "sub-decided",
        company_id: COMPANY_A,
        status: "rejected",
        verification_method: "manual",
        decision_reason: "the utility bill was older than three months",
        decided_at: "2026-11-02T09:00:00.000Z",
        created_at: "2026-11-01T08:00:00.000Z",
      },
    ],
  );
  const decidedSummary = await readKycSummary({ actor: owner }, dependenciesOf(decided, createInMemoryAuditTrail()));

  expectEqual(decidedSummary.status, "rejected", "a decided submission keeps its status");
  expectEqual(decidedSummary.decisionReason, "the utility bill was older than three months", "the merchant reads the rejection reason");
  expectEqual(decidedSummary.decidedAt, "2026-11-02T09:00:00.000Z", "and the decided instant");
  expectEqual(decidedSummary.canSubmit, false, "a decided submission cannot be submitted again");
}

async function checkKycSubmit(): Promise<void> {
  for (const [description, actor] of refusedActors) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      submitKyc({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the submit refuses ${description}`);
    expectEqual(database.updates.length, 0, `and writes nothing for ${description}`);
  }

  // Nothing recorded at all: the submit is a validation failure, nothing written.
  const empty = createBusinessDatabase();
  const emptyAudit = createInMemoryAuditTrail();
  const emptyRefusal = await rejectionOf(() => submitKyc({ actor: owner }, dependenciesOf(empty, emptyAudit)));

  expectEqual(emptyRefusal?.code, "VALIDATION_FAILED", "submitting with no submission at all is a validation failure");
  expectDeepEqual(emptyRefusal?.details, [{ field: "documents", rule: "required" }], "naming the missing documents");
  expectEqual(empty.updates.length, 0, "and nothing is written");

  // A draft with a document but no screening run: refused, named, nothing written.
  const unscreened = createBusinessDatabase();
  const unscreenedAudit = createInMemoryAuditTrail();

  await saveKycDocument({ actor: owner, input: pngDocumentInput() }, dependenciesOf(unscreened, unscreenedAudit));

  const unscreenedRefusal = await rejectionOf(() =>
    submitKyc({ actor: owner }, dependenciesOf(unscreened, unscreenedAudit)),
  );

  expectEqual(unscreenedRefusal?.code, "VALIDATION_FAILED", "a draft without a screening run cannot be submitted");
  expectDeepEqual(unscreenedRefusal?.details, [{ field: "screening", rule: "required" }], "naming the missing screening");
  expectEqual(unscreened.updates.filter((update) => update.table === KYC_SUBMISSIONS_TABLE).length, 0, "and the submission row is untouched");

  // The happy path: document + screening -> draft becomes submitted, audited, version bumped.
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const deps = dependenciesOf(database, audit);

  await saveKycDocument({ actor: owner, input: pngDocumentInput() }, deps);
  await runKycScreening({ actor: owner }, deps);

  const summary = await submitKyc({ actor: owner }, deps);
  const row = database.submissionRows[0];

  expectEqual(summary.status, "submitted", "the answer says submitted");
  expectEqual(summary.canSubmit, false, "and cannot be submitted again");
  expectEqual(row?.status, "submitted", "the row moved from draft to submitted");
  expectEqual(row?.submitted_at, new Date(NOW).toISOString(), "with the submit instant 0048 requires");
  expectEqual(row?.submitted_by, OWNER_ID, "and the submitter");
  expectEqual(row?.version, 2, "the version moved, optimistic locking intact");

  const update = database.updates.find((entry) => entry.table === KYC_SUBMISSIONS_TABLE);

  expect(
    update !== undefined &&
      update.query.includes(`id=eq.${row?.id}`) &&
      update.query.includes("status=eq.draft") &&
      update.query.includes(`company_id=eq.${encodeURIComponent(COMPANY_A)}`),
    "the update is conditional on the row still being this company's draft",
  );
  expectEqual(audit.entries.length, 3, "upload, screening and submit each audited");
  expectEqual(audit.entries[2]?.action, KYC_SUBMIT_AUDIT_ACTION, "the submit under kyc_submission.submitted");
  expectEqual(audit.entries[2]?.entityId, row?.id, "against the submission");
  expectEqual(audit.entries[2]?.payload?.["status"], "submitted", "recording the new status");

  // A second submit conflicts instead of rewriting.
  const again = await rejectionOf(() => submitKyc({ actor: owner }, deps));

  expectEqual(again?.code, "CONFLICT", "submitting a submitted row is a conflict");
  expectDeepEqual(again?.details, [{ field: "status", rule: "already_submitted" }], "named as already submitted");
  expectEqual(
    database.updates.filter((entry) => entry.table === KYC_SUBMISSIONS_TABLE).length,
    1,
    "and the row is not written twice",
  );

  // Another company's draft is invisible: the submit reads nothing of it.
  const foreign = createBusinessDatabase(
    [],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [{ id: "sub-b", company_id: COMPANY_B, status: "draft", verification_method: "manual", created_at: "2026-11-01T08:00:00.000Z" }],
  );
  const foreignRefusal = await rejectionOf(() =>
    submitKyc({ actor: owner }, dependenciesOf(foreign, createInMemoryAuditTrail())),
  );

  expectEqual(foreignRefusal?.code, "VALIDATION_FAILED", "the owner of company A cannot submit company B's draft");
  expect(
    foreign.queries.every((query) => query.includes(encodeURIComponent(COMPANY_A))),
    "and every query stayed on company A",
  );
}

/** ---- STEP 088: the compliance review queue, the detail viewer, and the two writes. */

/** A seeded store with one draft, one submitted and one in-review submission across two companies. */
function reviewSeededDatabase(): BusinessDatabase {
  return createBusinessDatabase(
    [FULL_PROFILE],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [
      { id: "018f2b8a-0000-4c2d-9c3e-0000000000a1", company_id: COMPANY_A, status: "draft", verification_method: "manual", created_at: "2026-11-01T08:00:00.000Z" },
      {
        id: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
        company_id: COMPANY_B,
        status: "submitted",
        verification_method: "manual",
        submitted_at: "2026-11-01T09:00:00.000Z",
        submitted_by: OTHER_OWNER_ID,
        created_at: "2026-11-01T08:30:00.000Z",
      },
      {
        id: "018f2b8a-0000-4c2d-9c3e-0000000000c3",
        company_id: COMPANY_A,
        status: "in_review",
        verification_method: "manual",
        submitted_at: "2026-11-01T10:00:00.000Z",
        submitted_by: OWNER_ID,
        first_reviewer_id: OFFICE_ID,
        high_risk: true,
        four_eye_required: true,
        created_at: "2026-11-01T08:45:00.000Z",
      },
      {
        id: "018f2b8a-0000-4c2d-9c3e-0000000000a7",
        company_id: COMPANY_A,
        status: "rejected",
        verification_method: "manual",
        submitted_at: "2026-11-01T07:00:00.000Z",
        submitted_by: OWNER_ID,
        first_reviewer_id: OFFICE_ID,
        decided_at: "2026-11-01T07:30:00.000Z",
        decision_reason: "documents did not match",
        created_at: "2026-11-01T06:30:00.000Z",
      },
    ],
    [
      {
        id: "018f2b8a-0000-4c2d-9c3e-0000000000d4",
        company_id: COMPANY_B,
        submission_id: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
        document_type: "utility_bill",
        storage_key: `${COMPANY_B}/kyc/doc-open`,
        content_sha256: "a".repeat(64),
        content_type: "image/png",
        byte_size: 128,
        issued_at: "2026-10-01",
        expires_at: null,
        status: "uploaded",
        created_at: "2026-11-01T09:05:00.000Z",
      },
    ],
    [
      {
        id: "018f2b8a-0000-4c2d-9c3e-0000000000e5",
        company_id: COMPANY_B,
        submission_id: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
        full_name: "Other Owner",
        date_of_birth: "1985-04-04",
        country: "BD",
        ownership_bps: 4000,
        is_significant: true,
        id_document_sha256: "b".repeat(64),
        is_pep: false,
        screened_at: "2026-11-01T09:10:00.000Z",
        created_at: "2026-11-01T09:04:00.000Z",
      },
    ],
    [
      {
        id: "018f2b8a-0000-4c2d-9c3e-0000000000f6",
        company_id: COMPANY_B,
        subject_kind: "company",
        subject_id: COMPANY_B,
        ofac_checked: true,
        un_checked: true,
        eu_checked: true,
        us_checked: true,
        result: "clear",
        provider: "manual",
        screened_at: "2026-11-01T09:10:00.000Z",
        note: null,
        sar_case: false,
        created_at: "2026-11-01T09:10:00.000Z",
      },
    ],
  );
}

async function checkKycReviewQueue(): Promise<void> {
  for (const [description, actor] of reviewRefused) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      readKycReviewQueue({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the queue refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
  }

  expectDeepEqual([...KYC_REVIEW_OFFICE_ROLES], ["super_admin", "ceo", "compliance_kyc"], "the queue's roles are the three office roles of section 5's review");

  const database = reviewSeededDatabase();
  const queue = await readKycReviewQueue({ actor: desk }, dependenciesOf(database, createInMemoryAuditTrail()));

  expectEqual(queue.rows.length, 2, "the draft is not queued, the submitted and in-review ones are");
  expectEqual(queue.rows[0]?.submissionId, "018f2b8a-0000-4c2d-9c3e-0000000000b2", "ordered by submitted_at ascending");
  expectEqual(queue.rows[1]?.submissionId, "018f2b8a-0000-4c2d-9c3e-0000000000c3", "then the one already in review");
  expectEqual(queue.rows[1]?.fourEyeRequired, true, "the four-eye flag is queued beside the row");
  expectEqual(queue.rows[1]?.highRisk, true, "and the high-risk flag with it");
  expectEqual(queue.rows[0]?.fourEyeRequired, false, "the other row needs no second reviewer");
  expectEqual(queue.rows[0]?.documentCount, 1, "with the document counted against its submission");
  expectEqual(queue.rows[0]?.ownerCount, 1, "the owner against its submission");
  expectEqual(queue.rows[0]?.screenedCount, 1, "the screening counted against its company, 0051 having no submission column");
  expectEqual(queue.rows[1]?.screenedCount, 0, "company A has no screening rows");
  expect(
    database.queries.every((query) => !query.includes("company_id=eq.")),
    "the queue reads across companies on purpose: no company filter on any queue query",
  );
  expect(
    database.queries.every((query) => query.includes("deleted_at=is.null")),
    "and every queue query is over live rows",
  );

  const ceoQueue = await readKycReviewQueue({ actor: ceoDesk }, dependenciesOf(reviewSeededDatabase(), createInMemoryAuditTrail()));

  expectEqual(ceoQueue.rows.length, 2, "ceo and super_admin see the same queue as compliance_kyc");
}

async function checkKycReviewDetail(): Promise<void> {
  for (const [description, actor] of reviewRefused) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      readKycReviewDetail({ actor, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2" }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the detail refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);
  }

  const badId = createBusinessDatabase();
  const badRefusal = await rejectionOf(() =>
    readKycReviewDetail({ actor: desk, submissionId: "not-a-uuid" }, dependenciesOf(badId, createInMemoryAuditTrail())),
  );

  expectEqual(badRefusal?.code, "VALIDATION_FAILED", "a non-uuid id is a validation failure");
  expectDeepEqual(badRefusal?.details, [{ field: "submission_id", rule: "invalid_format" }], "naming the parameter");
  expectEqual(badId.queries.length, 0, "before any query runs");

  const missing = createBusinessDatabase();
  const missingRefusal = await rejectionOf(() =>
    readKycReviewDetail(
      { actor: desk, submissionId: "018f2b8a-9999-4c2d-9c3e-999999999999" },
      dependenciesOf(missing, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(missingRefusal?.code, "RESOURCE_NOT_FOUND", "an unknown id is not found");

  const database = reviewSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const detail = await readKycReviewDetail({ actor: desk, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2" }, dependenciesOf(database, audit));

  expectEqual(detail.submissionId, "018f2b8a-0000-4c2d-9c3e-0000000000b2", "the submission is found by id");
  expectEqual(detail.companyId, COMPANY_B, "and the company comes from the row, never from the request");
  expectEqual(detail.status, "submitted", "its status");
  expectEqual(detail.method, "manual", "the office sees the verification method, unlike the merchant");
  expectEqual(detail.providerReference, null, "manual mode carries no provider reference");
  expectEqual(detail.documents.length, 1, "one document");
  expectEqual(detail.documents[0]?.storageKey, `${COMPANY_B}/kyc/doc-open`, "the viewer sees the storage key");
  expectEqual(detail.documents[0]?.contentSha256, "a".repeat(64), "and the hash that binds row to bytes");
  expectEqual(detail.documents[0]?.status, "uploaded", "waiting for a decision");
  expectEqual(detail.ubos.length, 1, "one owner");
  expectEqual(detail.screenings.length, 1, "one screening row");
  expectEqual(detail.screenings[0]?.result, "clear", "the office sees the result, unlike the merchant");
  expectDeepEqual(detail.screenings[0]?.listsCovered, ["ofac", "un", "eu", "us"], "and the four lists covered");

  expectEqual(audit.entries.length, 1, "the office read is audited once");
  expectEqual(audit.entries[0]?.action, KYC_REVIEW_AUDIT_ACTION, "under kyc_review.read_by_office");
  expectEqual(audit.entries[0]?.entityId, "018f2b8a-0000-4c2d-9c3e-0000000000b2", "against the submission");
  expectEqual(audit.entries[0]?.companyId, COMPANY_B, "the merchant read, not the office's own company");

  const lookup = database.queries[0] ?? "";

  expect(lookup.includes("id=eq.018f2b8a-0000-4c2d-9c3e-0000000000b2") && lookup.includes("deleted_at=is.null"), "the lookup is by id over live rows");
  expect(
    database.queries.slice(1).every((query) => query.includes(`company_id=eq.${encodeURIComponent(COMPANY_B)}`)),
    "and every query after the lookup is scoped to the submission's own company",
  );

  const ownDetail = await readKycReviewDetail({ actor: desk, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000c3" }, dependenciesOf(database, audit));

  expectEqual(ownDetail.legalName, FULL_PROFILE.legal_name, "the merchant's legal name is read beside its submission");
  expectEqual(ownDetail.firstReviewerId, OFFICE_ID, "the in-review row names its first reviewer");
}

async function checkKycReviewOpen(): Promise<void> {
  for (const [description, actor] of reviewRefused) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      openKycReview({ actor, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2" }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the open refuses ${description}`);
    expectEqual(database.updates.length, 0, `and writes nothing for ${description}`);
  }

  const database = reviewSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const detail = await openKycReview({ actor: desk, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2" }, dependenciesOf(database, audit));
  const row = database.submissionRows.find((entry) => entry.id === "018f2b8a-0000-4c2d-9c3e-0000000000b2");

  expectEqual(detail.status, "in_review", "the returned detail says in review");
  expectEqual(row?.status, "in_review", "the row moved from submitted to in_review");
  expectEqual(row?.first_reviewer_id, OFFICE_ID, "with the first reviewer named");
  expectEqual(row?.version, 2, "the version moved");

  const update = database.updates.find((entry) => entry.table === KYC_SUBMISSIONS_TABLE);

  expect(
    update !== undefined &&
      update.query.includes("id=eq.018f2b8a-0000-4c2d-9c3e-0000000000b2") &&
      update.query.includes("status=eq.submitted") &&
      update.query.includes(`company_id=eq.${encodeURIComponent(COMPANY_B)}`),
    "the update is conditional on the row still being submitted",
  );
  expectEqual(audit.entries.filter((entry) => entry.action === KYC_REVIEW_OPEN_AUDIT_ACTION).length, 1, "the open is audited");
  expectEqual(
    audit.entries.filter((entry) => entry.action === KYC_REVIEW_OPEN_AUDIT_ACTION)[0]?.payload?.["first_reviewer_id"],
    OFFICE_ID,
    "recording the reviewer",
  );

  const again = await openKycReview({ actor: desk, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2" }, dependenciesOf(database, audit));

  expectEqual(again.status, "in_review", "opening one's own in-review submission is the same answer");
  expectEqual(
    database.updates.filter((entry) => entry.table === KYC_SUBMISSIONS_TABLE).length,
    1,
    "and writes nothing the second time",
  );

  const draftDb = reviewSeededDatabase();
  const draftRefusal = await rejectionOf(() =>
    openKycReview({ actor: desk, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000a1" }, dependenciesOf(draftDb, createInMemoryAuditTrail())),
  );

  expectEqual(draftRefusal?.code, "CONFLICT", "a draft cannot be opened for review");
  expectDeepEqual(draftRefusal?.details, [{ field: "status", rule: "not_submitted" }], "named as not submitted");
  expectEqual(draftDb.updates.length, 0, "and nothing is written");
}

async function checkKycReviewDocument(): Promise<void> {
  for (const [description, actor] of reviewRefused) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      reviewKycDocument({ actor, body: { document_id: "018f2b8a-0000-4c2d-9c3e-0000000000d4", decision: "accept" } }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the document decision refuses ${description}`);
    expectEqual(database.updates.length, 0, `and writes nothing for ${description}`);
  }

  const badBody = createBusinessDatabase();
  const badRefusal = await rejectionOf(() =>
    reviewKycDocument({ actor: desk, body: { document_id: "nope", decision: "accept" } }, dependenciesOf(badBody, createInMemoryAuditTrail())),
  );

  expectEqual(badRefusal?.code, "VALIDATION_FAILED", "a malformed body is a validation failure");
  expectEqual(badBody.queries.length, 0, "before any query runs");

  const rejectNoReason = reviewSeededDatabase();
  const noReason = await rejectionOf(() =>
    reviewKycDocument(
      { actor: desk, body: { document_id: "018f2b8a-0000-4c2d-9c3e-0000000000d4", decision: "reject" } },
      dependenciesOf(rejectNoReason, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(noReason?.code, "VALIDATION_FAILED", "a rejection without a reason is refused, as 0049's check demands");
  expectDeepEqual(noReason?.details, [{ field: "reason", rule: "required" }], "naming the reason");
  expectEqual(rejectNoReason.updates.length, 0, "and nothing is written");

  const database = reviewSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const accepted = await reviewKycDocument(
    { actor: desk, body: { document_id: "018f2b8a-0000-4c2d-9c3e-0000000000d4", decision: "accept" } },
    dependenciesOf(database, audit),
  );
  const row = database.documentRows[0];

  expectEqual(accepted.status, "accepted", "the answer is the updated document");
  expectEqual(row?.status, "accepted", "the row moved from uploaded to accepted");
  expectEqual(row?.reviewed_at, new Date(NOW).toISOString(), "with the reviewed instant 0049 ties to the decision");
  expectEqual(row?.reviewed_by, OFFICE_ID, "and the reviewer");
  expectEqual(row?.rejection_reason, null, "no reason on an acceptance");
  expectEqual(row?.version, 2, "version moved");

  const update = database.updates.find((entry) => entry.table === KYC_DOCUMENTS_TABLE);

  expect(
    update !== undefined && update.query.includes("id=eq.018f2b8a-0000-4c2d-9c3e-0000000000d4") && update.query.includes("status=eq.uploaded"),
    "the update is conditional on the document still being uploaded",
  );
  expectEqual(audit.entries.filter((entry) => entry.action === KYC_DOCUMENT_REVIEW_AUDIT_ACTION).length, 1, "the decision is audited");
  expectEqual(
    audit.entries.filter((entry) => entry.action === KYC_DOCUMENT_REVIEW_AUDIT_ACTION)[0]?.entityId,
    "018f2b8a-0000-4c2d-9c3e-0000000000d4",
    "against the document",
  );

  const again = await rejectionOf(() =>
    reviewKycDocument(
      { actor: desk, body: { document_id: "018f2b8a-0000-4c2d-9c3e-0000000000d4", decision: "reject", reason: "illegible" } },
      dependenciesOf(database, audit),
    ),
  );

  expectEqual(again?.code, "CONFLICT", "an already-decided document conflicts");
  expectDeepEqual(again?.details, [{ field: "status", rule: "already_reviewed" }], "named as already reviewed");
  expectEqual(database.updates.filter((entry) => entry.table === KYC_DOCUMENTS_TABLE).length, 1, "and is not written twice");

  const rejectDb = reviewSeededDatabase();
  const rejected = await reviewKycDocument(
    { actor: desk, body: { document_id: "018f2b8a-0000-4c2d-9c3e-0000000000d4", decision: "reject", reason: "  illegible scan  " } },
    dependenciesOf(rejectDb, createInMemoryAuditTrail()),
  );

  expectEqual(rejected.status, "rejected", "a rejection with a reason lands");
  expectEqual(rejected.rejectionReason, "illegible scan", "trimmed, as 0049's check requires");
  expectEqual(rejectDb.documentRows[0]?.rejection_reason, "illegible scan", "recorded on the row");
}

/** ---- STEP 089: the four-eye flow - the risk mark and the guard the decision flow will call. */
async function checkKycReviewRisk(): Promise<void> {
  // The guard STEP 093 will call before writing approved/rejected.
  expectDeepEqual(
    fourEyeProblems({ fourEyeRequired: true, firstReviewerId: OFFICE_ID }, null),
    [{ field: "second_reviewer_id", rule: "required" }],
    "a four-eye decision without a second reviewer is refused as required",
  );
  expectDeepEqual(
    fourEyeProblems({ fourEyeRequired: true, firstReviewerId: OFFICE_ID }, OFFICE_ID),
    [{ field: "second_reviewer_id", rule: "same_reviewer" }],
    "and the first reviewer cannot be the second, as 0048's two-people check demands",
  );
  expectDeepEqual(
    fourEyeProblems({ fourEyeRequired: true, firstReviewerId: OFFICE_ID }, OTHER_OWNER_ID),
    [],
    "a distinct second reviewer satisfies the guard",
  );
  expectDeepEqual(
    fourEyeProblems({ fourEyeRequired: false, firstReviewerId: OFFICE_ID }, null),
    [],
    "and a submission that needs no four eyes passes with no second reviewer",
  );

  for (const [description, actor] of reviewRefused) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      markKycSubmissionRisk(
        { actor, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2", body: { high_risk: true } },
        dependenciesOf(database, createInMemoryAuditTrail()),
      ),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the risk mark refuses ${description}`);
    expectEqual(database.updates.length, 0, `and writes nothing for ${description}`);
  }

  const badId = createBusinessDatabase();
  const badRefusal = await rejectionOf(() =>
    markKycSubmissionRisk(
      { actor: desk, submissionId: "nope", body: { high_risk: true } },
      dependenciesOf(badId, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(badRefusal?.code, "VALIDATION_FAILED", "a non-uuid id is refused before any query");
  expectEqual(badId.queries.length, 0, "with zero queries");

  const decided = reviewSeededDatabase();
  const decidedRefusal = await rejectionOf(() =>
    markKycSubmissionRisk(
      { actor: desk, submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000a7", body: { high_risk: true } },
      dependenciesOf(decided, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(decidedRefusal?.code, "CONFLICT", "a decided submission is locked, as 0048's guard says");
  expectDeepEqual(decidedRefusal?.details, [{ field: "status", rule: "already_decided" }], "named as already decided");
  expectEqual(decided.updates.length, 0, "and nothing is written");

  // Mark high risk: four-eye follows automatically, even if the request said false.
  const database = reviewSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const detail = await markKycSubmissionRisk(
    {
      actor: desk,
      submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
      body: { high_risk: true, four_eye_required: false },
    },
    dependenciesOf(database, audit),
  );
  const row = database.submissionRows.find((entry) => entry.id === "018f2b8a-0000-4c2d-9c3e-0000000000b2");

  expectEqual(detail.highRisk, true, "the answer says high risk");
  expectEqual(detail.fourEyeRequired, true, "and four-eye, forced by the high-risk flag");
  expectEqual(row?.high_risk, true, "the row carries high_risk");
  expectEqual(row?.four_eye_required, true, "and four_eye_required");
  expectEqual(row?.version, 2, "version moved");

  const update = database.updates.find((entry) => entry.table === KYC_SUBMISSIONS_TABLE);

  expect(
    update !== undefined &&
      update.query.includes("status=eq.submitted") &&
      update.query.includes("id=eq.018f2b8a-0000-4c2d-9c3e-0000000000b2"),
    "the update is conditional on the row's current status",
  );
  expectEqual(
    audit.entries.filter((entry) => entry.action === KYC_RISK_MARK_AUDIT_ACTION).length,
    1,
    "the mark is audited under kyc_review.risk_marked",
  );
  expectEqual(
    audit.entries.filter((entry) => entry.action === KYC_RISK_MARK_AUDIT_ACTION)[0]?.payload?.["four_eye_required"],
    true,
    "recording the derived four-eye flag",
  );

  // A large merchant can be four-eye without being high risk.
  const large = await markKycSubmissionRisk(
    {
      actor: desk,
      submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
      body: { high_risk: false, four_eye_required: true },
    },
    dependenciesOf(database, audit),
  );

  expectEqual(large.highRisk, false, "cleared");
  expectEqual(large.fourEyeRequired, true, "but still four-eye, as a large merchant is");

  // Clearing both.
  const cleared = await markKycSubmissionRisk(
    {
      actor: desk,
      submissionId: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
      body: { high_risk: false },
    },
    dependenciesOf(database, audit),
  );

  expectEqual(cleared.highRisk, false, "and the flags are cleared");
  expectEqual(cleared.fourEyeRequired, false, "with no four-eye left");
}

async function checkKycSources(): Promise<void> {
  const documentRoute = await readRepositoryFile("app/api/onboarding/kyc-document/route.ts");
  const uboRoute = await readRepositoryFile("app/api/onboarding/kyc-ubo/route.ts");
  const screeningRoute = await readRepositoryFile("app/api/onboarding/kyc-screening/route.ts");
  const submitRoute = await readRepositoryFile("app/api/onboarding/kyc-submit/route.ts");
  const statusPage = await readRepositoryFile("app/(dashboard)/onboarding/status/page.tsx");
  const statusForm = await readRepositoryFile("app/(dashboard)/onboarding/status/status-form.tsx");
  const queueRoute = await readRepositoryFile("app/api/onboarding/kyc-review/route.ts");
  const detailRoute = await readRepositoryFile("app/api/onboarding/kyc-review-submission/route.ts");
  const openRoute = await readRepositoryFile("app/api/onboarding/kyc-review-open/route.ts");
  const decideRoute = await readRepositoryFile("app/api/onboarding/kyc-document-review/route.ts");
  const riskRoute = await readRepositoryFile("app/api/onboarding/kyc-risk-mark/route.ts");
  const reviewPage = await readRepositoryFile("app/(dashboard)/onboarding/kyc-review/page.tsx");
  const reviewPanel = await readRepositoryFile("app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx");
  const review = await readRepositoryFile("services/kyc/kyc-review.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/documents/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/documents/documents-form.tsx");
  const copy = await readRepositoryFile("app/(dashboard)/onboarding/step-copy.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const types = await readRepositoryFile("services/kyc/kyc-document-types.ts");
  const capture = await readRepositoryFile("services/kyc/kyc-capture.ts");

  for (const [path, source] of [
    ["app/api/onboarding/kyc-document/route.ts", documentRoute],
    ["app/api/onboarding/kyc-ubo/route.ts", uboRoute],
    ["app/api/onboarding/kyc-screening/route.ts", screeningRoute],
    ["app/api/onboarding/kyc-submit/route.ts", submitRoute],
    ["app/(dashboard)/onboarding/documents/page.tsx", page],
    ["app/(dashboard)/onboarding/documents/documents-form.tsx", form],
    ["app/(dashboard)/onboarding/status/page.tsx", statusPage],
    ["app/(dashboard)/onboarding/status/status-form.tsx", statusForm],
    ["app/api/onboarding/kyc-risk-mark/route.ts", riskRoute],
    ["app/api/onboarding/kyc-review/route.ts", queueRoute],
    ["app/api/onboarding/kyc-review-submission/route.ts", detailRoute],
    ["app/api/onboarding/kyc-review-open/route.ts", openRoute],
    ["app/api/onboarding/kyc-document-review/route.ts", decideRoute],
    ["app/(dashboard)/onboarding/kyc-review/page.tsx", reviewPage],
    ["app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx", reviewPanel],
    ["services/kyc/kyc-review.ts", review],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  for (const [path, route] of [
    ["app/api/onboarding/kyc-document/route.ts", documentRoute],
    ["app/api/onboarding/kyc-ubo/route.ts", uboRoute],
    ["app/api/onboarding/kyc-screening/route.ts", screeningRoute],
    ["app/api/onboarding/kyc-submit/route.ts", submitRoute],
    ["app/api/onboarding/kyc-review-open/route.ts", openRoute],
    ["app/api/onboarding/kyc-document-review/route.ts", decideRoute],
    ["app/api/onboarding/kyc-risk-mark/route.ts", riskRoute],
  ] as const) {
    expect(route.includes("export const POST"), `${path} answers POST`);
    expectEqual(route.includes("export const GET"), false, `${path} answers no GET`);
    expect(route.includes("requireCsrfToken("), "the token is checked first");
    expect(route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("), "before the session is read");
    expect(route.includes("maximumBodyBytes"), "the body is bounded");
    expect(route.includes('"cache-control": "no-store"'), "the answer is not cached");
    expect(
      csrf.includes(`"${path.replace("app/api", "/api").replace("/route.ts", "")}",`),
      `and the path is on the CSRF-protected list`,
    );
  }

  expect(documentRoute.includes("request.formData()"), "the document route reads multipart");
  expect(documentRoute.includes("instanceof File"), "and requires a real file");
  expect(documentRoute.includes("arrayBuffer()"), "reads the bytes once");
  expect(documentRoute.includes("saveKycDocument("), "and hands them to the service");
  expect(documentRoute.includes("KYC_DOCUMENT_MAXIMUM_BYTES"), "with the 0057 row ceiling plus form overhead as the declared limit");
  expect(uboRoute.includes("saveUbo("), "the UBO route saves through the service");
  expect(screeningRoute.includes("runKycScreening("), "the screening route runs through the service");
  expect(submitRoute.includes("submitKyc("), "the submit route submits through the service");
  expect(queueRoute.includes("export const GET"), "the queue route is a GET");
  expectEqual(queueRoute.includes("export const POST"), false, "and answers no POST");
  expect(queueRoute.includes("readKycReviewQueue("), "reading the queue through the service");
  expectEqual(queueRoute.includes("searchParams"), false, "the queue takes no parameter at all: it is every open submission");
  expect(detailRoute.includes("export const GET"), "the detail route is a GET");
  expect(detailRoute.includes('searchParams.get("id")'), "reading the submission id, never a company, from the query string");
  expectEqual(detailRoute.includes('"company_id"'), false, "and no company field anywhere");
  expect(detailRoute.includes("readKycReviewDetail("), "reading the detail through the service");
  expect(openRoute.includes("openKycReview("), "the open route opens through the service");
  expect(decideRoute.includes("reviewKycDocument("), "the document decision route decides through the service");
  expect(riskRoute.includes("markKycSubmissionRisk("), "the risk mark route goes through the service");
  expect(csrf.includes('"/api/onboarding/kyc-risk-mark",'), "and the path is on the CSRF-protected list");
  expect(review.includes("markKycSubmissionRisk"), "the service owns the risk mark");
  expect(review.includes("fourEyeProblems"), "and exports the four-eye guard the decision flow of STEP 093 will call");
  expect(review.includes("already_decided"), "refusing to mark a decided row, which 0048 locks");
  expect(reviewPanel.includes("/api/onboarding/kyc-risk-mark"), "the panel posts the mark to its route");
  expect(reviewPanel.includes("riskMarkButton"), "and offers the mark and the clear");
  expect(reviewPage.includes("queueFourEye"), "the queue badges a four-eye row");
  expect(review.includes("KYC_REVIEW_OFFICE_ROLES"), "the service owns the office role list");
  expect(review.includes("read_by_office"), "and audits each office read of one submission");
  expect(review.includes("status=eq.submitted"), "the open is conditional on the row still being submitted");
  expect(review.includes("status=eq.uploaded"), "the document decision is conditional on the row still being uploaded");
  expect(review.includes('"approved"'), "and now writes approved: the decision flow is STEP 093");
  expect(review.includes("decideKycSubmission"), "the service owns the submission decision");
  expect(review.includes("KYC_DECISION_AUDIT_ACTION"), "audited under kyc_review.decided");
  expect(review.includes("KYC_FINAL_APPROVAL_ROLES"), "with the final-approval roles of section 2");
  expect(review.includes("fourEyeProblems("), "calling the four-eye guard before the decision write");
  expect(review.includes("status=eq.in_review"), "the decision is conditional on the row being in review");
  expect(review.includes("version=eq."), "and on its current version");
  expect(reviewPage.includes("readKycReviewQueue("), "the queue page reads the queue through the service");
  expect(reviewPage.includes("<SessionKeeper"), "and keeps the session rotating");
  expect(reviewPage.includes("KycReviewQueuePanel"), "and hands the rows to the panel");
  for (const state of ["signed-out", "forbidden", "unavailable", "ready"]) {
    expect(reviewPage.includes(`"${state}"`), `the queue page keeps the ${state} answer apart`);
  }
  expectEqual(reviewPanel.includes('"use client"'), true, "the panel is a client component");
  expectEqual((reviewPanel.match(/method: "POST"/gu) ?? []).length, 1, "its two actions share one POST site");
  expectEqual((reviewPanel.match(/\.\.\.\(await csrfHeaders\(\)\)/gu) ?? []).length, 1, "with one awaited CSRF spread");
  expect(reviewPanel.includes("/api/onboarding/kyc-review-open"), "opening posts to the open route");
  expect(reviewPanel.includes("/api/onboarding/kyc-document-review"), "deciding posts to the document route");
  expect(reviewPanel.includes("/api/onboarding/kyc-review-submission"), "and the detail is one GET by id");
  expectEqual(reviewPanel.includes("company_id"), false, "and no company field is ever sent in a body");
  for (const route of [uboRoute, screeningRoute]) {
    expectEqual(route.includes("searchParams"), false, "no route takes a company from the query string");
    expectEqual(route.includes('"company_id"'), false, "and none reads a company field from the body");
  }

  expect(page.includes("readOwnerActor()"), "the page reads the account through the cached reader");
  expect(page.includes("readKycPack("), "and the pack through the service");
  expect(page.includes("<SessionKeeper"), "and keeps the session rotating");
  expect(page.includes("DocumentsForm"), "and renders the form");
  for (const state of ["signed-out", "forbidden", "unavailable", "ready"]) {
    expect(page.includes(`"${state}"`), `the page keeps the ${state} answer apart`);
  }

  expectEqual(form.includes('"use client"'), true, "the form is a client component");
  expectEqual((form.match(/method: "POST"/gu) ?? []).length, 2, "it posts through two fetch sites, one shared by two actions");
  expectEqual((form.match(/\.\.\.\(await csrfHeaders\(\)\)/gu) ?? []).length, 2, "each fetch site spreads the awaited token once");
  for (const pathConst of ["UPLOAD_PATH", "UBO_PATH", "SCREENING_PATH"]) {
    expect(form.includes(pathConst), `the form posts to ${pathConst}`);
  }
  expect(form.includes('fetch(UPLOAD_PATH'), "the upload posts multipart");
  expect(form.includes("new FormData()"), "the upload body is a FormData, so the browser sets the boundary");
  expect(form.includes('fetch(UBO_PATH') || form.includes("postJson(UBO_PATH"), "the UBO save posts JSON");
  expect(form.includes("postJson(SCREENING_PATH"), "the screening run posts an empty body");
  expect(form.includes("KYC_DOCUMENT_TYPES"), "the type select is drawn from the shared list");
  expect(form.includes("@/services/kyc/kyc-document-types"), "imported from the client-safe module, not the service");
  expectEqual(form.includes("process.env"), false, "the form reads no environment");
  expectEqual(form.includes("companyId"), false, "and sends no company in any body");

  expect(types.includes("KYC_DOCUMENT_TYPES"), "the type list lives in its own client-safe module");
  expectEqual(/^import .*node:/mu.test(types), false, "with no server imports, so no node builtin reaches the browser bundle");
  expect(types.includes("UTILITY_BILL_MAX_AGE_MONTHS = 3"), "the three month rule lives in the client-safe module too");
  expect(types.includes("function utilityBillIssueWindow"), "with the window helper the form and the service share");
  expect(capture.includes("utilityBillIssueWindow"), "the service re-exports and uses the same window");
  expect(capture.includes('rule: "invalid_range"'), "a stale bill is refused as out of range on the server");
  expect(capture.includes('rule: "invalid_date"'), "a future issue date is refused on the server for every type");
  expect(capture.includes("now: nowOf(dependencies)"), "the save pins the parser's clock to the request's now");
  expect(capture.includes("bankStatementPeriodMonths: dependencies.bankStatementPeriodMonths"), "and hands the compliance-set statement period to the parser");
  expect(form.includes("issueWindow.earliest"), "the form pre-checks the issue date against the window it is given");
  expect(page.includes("utilityBillIssueWindow(Date.now())"), "the page computes the window once, server side");
  expect(form.includes("utilityBillRuleLine"), "and tells the merchant the rule in words");
  expect(form.includes("invalid_range"), "mapping the out-of-range rule to its sentence");
  expect(form.includes("max={issueWindow.latest}"), "and capping the date picker at today");
  expect(capture.includes("readKycSummary"), "the service reads the merchant-safe summary");
  expect(capture.includes("submitKyc"), "and submits the draft through the service");
  expect(capture.includes("KYC_SUBMIT_AUDIT_ACTION"), "with its own audit action");
  expectEqual(capture.includes("provider_reference"), false, "the service never even selects the provider reference for a merchant read");
  expectEqual(
    capture.includes("method: submission?.verification_method"),
    false,
    "and the pack no longer answers the verification method: the merchant only reads status",
  );
  expect(statusPage.includes("readOwnerActor()"), "the status page reads the account through the cached reader");
  expect(statusPage.includes("readKycSummary("), "and the summary through the service");
  expect(statusPage.includes("<SessionKeeper"), "and keeps the session rotating");
  expect(statusPage.includes("StatusForm"), "and renders the submit form");
  for (const state of ["signed-out", "forbidden", "unavailable", "ready"]) {
    expect(statusPage.includes(`"${state}"`), `the status page keeps the ${state} answer apart`);
  }
  expect(statusPage.includes('"/onboarding/status"') || statusPage.includes("href="), "and links onward");
  expectEqual(statusForm.includes('"use client"'), true, "the submit form is a client component");
  expectEqual((statusForm.match(/method: "POST"/gu) ?? []).length, 1, "it sends exactly one POST");
  expectEqual((statusForm.match(/\.\.\.\(await csrfHeaders\(\)\)/gu) ?? []).length, 1, "spreading the awaited token once");
  expect(statusForm.includes("/api/onboarding/kyc-submit"), "to the submit route");
  expectEqual(statusForm.includes("companyId"), false, "and sends no company in any body");
  expect(types.includes("BANK_STATEMENT_DEFAULT_PERIOD_MONTHS = 3"), "the default statement period lives in the client-safe module");
  expect(types.includes("function monthsBetweenDates"), "with the period-length helper the form and the service share");
  expect(capture.includes("bankStatementPeriodMonths"), "the service takes the required period as a parameter, the compliance criterion of section 5");
  expect(capture.includes("monthsBetweenDates(issuedAt, expiresAt)"), "the server checks the covered period length, not just the dates");
  expect(capture.includes("dateStringMinusMonths(window.latest, BANK_STATEMENT_MAX_AGE_MONTHS)"), "and the period's recency cutoff");
  expect(form.includes("bankStatementRuleLine"), "the form tells the merchant the statement rule in words");
  expect(form.includes("statementFromLabel"), "and labels the two dates as the covered period");
  expect(form.includes("docPeriodLine"), "and lists a recorded statement with its period");
  expect(copy.includes('documents: "/onboarding/documents"'), "the documents step links to its page");

  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/documents/", repositoryRoot))).includes("page.tsx"),
    "the screen lives in the merchant dashboard area",
  );
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/documents/", repositoryRoot))).includes("documents-form.tsx"),
    "with its form beside it",
  );
  for (const folder of ["kyc-document", "kyc-ubo", "kyc-screening", "kyc-submit", "kyc-review", "kyc-review-submission", "kyc-review-open", "kyc-document-review", "kyc-risk-mark"]) {
    expect(
      (await readdir(new URL(`app/api/onboarding/${folder}/`, repositoryRoot))).includes("route.ts"),
      `${folder} is a route handler of its own`,
    );
  }
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("kyc-capture.ts"),
    "the capture service lives in services/kyc",
  );
}

/** ---- The catalog: every sentence of the documents step is used, and every key it names exists. */
async function checkKycCatalog(): Promise<void> {
  const block = en.onboardingDocuments as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/documents/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/documents/documents-form.tsx");
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

  walk(block, "onboardingDocuments");

  expect(flat.length >= 50, "the documents step has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingDocuments\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["docSizeLine", "uboShareLine", "uboScreenedLine", "screeningDone"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingDocuments.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingDocuments.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
}

/** ---- STEP 087 catalog: every sentence of the status screen is used, and every key it names exists. */
async function checkStatusCatalog(): Promise<void> {
  const block = en.onboardingStatus as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/status/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/status/status-form.tsx");
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

  walk(block, "onboardingStatus");

  expect(flat.length >= 20, "the status screen has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingStatus\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["submittedAtLine", "decidedAtLine", "docCountLine", "ownerCountLine", "screenedLine"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingStatus.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingStatus.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
}

/** ---- STEP 088 catalog: every sentence of the review queue screen is used, and every key it names exists. */
async function checkReviewCatalog(): Promise<void> {
  const block = en.onboardingKycReview as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/kyc-review/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx");
  const sources = `${page}\n${panel}`;

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

  walk(block, "onboardingKycReview");

  expect(flat.length >= 40, "the review queue has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingKycReview\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["submittedAtLine", "countsLine", "companyLine", "methodLine", "providerLine", "decidedAtLine", "decidedDone", "docMetaLine", "docKeyLine", "docHashLine", "docIssuedLine", "docPeriodLine", "docRejectedLine", "reviewDone", "uboLine", "uboScreenedLine", "screeningLine", "screeningNoteLine"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingKycReview.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingKycReview.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
}

/** ---- STEP 090: the underwriting criteria the compliance team sets. */
const underwritingReadRefused: readonly (readonly [string, RequestActor])[] = [
  ["an owner", owner],
  ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
  ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
  ["nobody", actorOf([], null)],
];

const underwritingManageRefused: readonly (readonly [string, RequestActor])[] = [
  ["an owner", owner],
  ["ceo", ceoDesk],
  ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })],
  ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
  ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
  ["nobody", actorOf([], null)],
];

const VALID_CRITERIA_BODY = {
  starting_monthly_limit: "2500.00",
  bank_statement_months: 6,
  large_transaction_hold_enabled: false,
  large_transaction_hold_threshold: "50000",
};

async function checkUnderwriting(): Promise<void> {
  expectDeepEqual(
    [...UNDERWRITING_MANAGE_ROLES],
    ["super_admin", "compliance_kyc"],
    "the manage roles are super_admin and compliance_kyc, section 5's compliance team",
  );
  expectDeepEqual(
    [...UNDERWRITING_READ_ROLES],
    ["ceo", "compliance_kyc", "finance_ops", "super_admin"],
    "the read roles add the ceo and finance_ops oversight",
  );

  for (const [description, actor] of underwritingReadRefused) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      readUnderwritingSettings({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the settings read refuses ${description}`);
    expectEqual(database.queries.length, 0, `and reads nothing for ${description}`);

    const overviewDatabase = createBusinessDatabase();
    const overviewRefusal = await rejectionOf(() =>
      readUnderwritingMccOverview({ actor }, dependenciesOf(overviewDatabase, createInMemoryAuditTrail())),
    );

    expectEqual(overviewRefusal?.code, "PERMISSION_DENIED", `the mcc overview refuses ${description}`);
    expectEqual(overviewDatabase.queries.length, 0, `and reads nothing for ${description}`);
  }

  for (const [description, actor] of underwritingManageRefused) {
    const saves: readonly (readonly [string, (deps: ReturnType<typeof dependenciesOf>) => Promise<unknown>])[] = [
      ["the criteria save", (deps) => updateUnderwritingCriteria({ actor, body: VALID_CRITERIA_BODY }, deps)],
      ["the tier save", (deps) => updateUnderwritingRiskTier({ actor, body: { tier: "high", extra_reserve_percent: "10", hold_days: 7 } }, deps)],
      ["the code tier save", (deps) => setMccRiskTier({ actor, body: { code: "5812", tier: "high" } }, deps)],
    ];

    for (const [label, save] of saves) {
      const database = createBusinessDatabase();
      const refusal = await rejectionOf(() => save(dependenciesOf(database, createInMemoryAuditTrail())));

      expectEqual(refusal?.code, "PERMISSION_DENIED", `${label} refuses ${description}`);
      expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
      expectEqual(database.updates.length, 0, `and writes nothing for ${description}`);
    }
  }

  // The happy read: the seeded row, the three tier rows, one audited office read, no company filter.
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const settings = await readUnderwritingSettings({ actor: desk }, dependenciesOf(database, audit));

  expectEqual(settings.criteria.startingMonthlyLimit, "1000.0000", "the seeded starting limit");
  expectEqual(settings.criteria.bankStatementMonths, 3, "the seeded statement period");
  expectEqual(settings.criteria.largeHoldEnabled, true, "the seeded hold switch");
  expectEqual(settings.criteria.largeHoldThreshold, "10000.0000", "the seeded hold threshold");
  expectEqual(settings.tiers.length, 3, "three tier rows");
  expectEqual(settings.tiers.map((tier) => tier.tier).join(","), "high,low,medium", "ordered by tier name");
  expectEqual(
    audit.entries.filter((entry) => entry.action === UNDERWRITING_READ_AUDIT_ACTION).length,
    1,
    "the office read is audited under underwriting.criteria_read_by_office",
  );
  expect(
    database.queries.every((query) => !query.includes("company_id=eq.")),
    "the settings reads are platform scoped: no company filter on any query",
  );

  // The merchant-safe summary: owner only, and only the statement period.
  const summary = await readMerchantUnderwritingSummary(
    { actor: owner },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(summary.bankStatementPeriodMonths, 3, "the merchant summary answers the statement period");
  expectDeepEqual(Object.keys(summary), ["bankStatementPeriodMonths"], "and nothing else");

  const officeSummary = await rejectionOf(() =>
    readMerchantUnderwritingSummary({ actor: desk }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail())),
  );

  expectEqual(officeSummary?.code, "PERMISSION_DENIED", "the summary is owner-only, not an office read");

  const companyless = await rejectionOf(() =>
    readMerchantUnderwritingSummary(
      { actor: actorOf(["owner"], null) },
      dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(companyless?.code, "PERMISSION_DENIED", "an owner without a company gets no summary");

  // The criteria save: conditional update, version bump, updater, one audit entry.
  const saveDatabase = createBusinessDatabase();
  const saveAudit = createInMemoryAuditTrail();
  const updated = await updateUnderwritingCriteria(
    { actor: desk, body: VALID_CRITERIA_BODY },
    dependenciesOf(saveDatabase, saveAudit),
  );

  expectEqual(updated.criteria.startingMonthlyLimit, "2500.00", "the new starting limit");
  expectEqual(updated.criteria.bankStatementMonths, 6, "the new statement period");
  expectEqual(updated.criteria.largeHoldEnabled, false, "the hold switch off");
  expectEqual(updated.criteria.largeHoldThreshold, "50000", "the new threshold");
  expectEqual(updated.criteria.version, 2, "version bumped");

  const update = saveDatabase.updates.find((entry) => entry.table === UNDERWRITING_CRITERIA_TABLE);

  expect(
    update !== undefined &&
      update.query.includes("id=eq.") &&
      update.query.includes("version=eq.1") &&
      update.query.includes("deleted_at=is.null"),
    "the update is conditional on id and current version over live rows",
  );
  expectEqual(update?.values["updated_by"], OFFICE_ID, "the updater is recorded on the row");
  expectEqual(
    saveAudit.entries.filter((entry) => entry.action === UNDERWRITING_CRITERIA_AUDIT_ACTION).length,
    1,
    "one criteria audit entry",
  );

  const criteriaAudit = saveAudit.entries.find((entry) => entry.action === UNDERWRITING_CRITERIA_AUDIT_ACTION);

  expectEqual(criteriaAudit?.payload?.["bank_statement_months"], 6, "with the new period in the payload");
  expectEqual(criteriaAudit?.companyId, null, "on the platform chain");

  // Validation refusals: every one writes nothing.
  const badBodies: readonly (readonly [string, unknown])[] = [
    ["a non-numeric limit", { ...VALID_CRITERIA_BODY, starting_monthly_limit: "abc" }],
    ["a zero limit", { ...VALID_CRITERIA_BODY, starting_monthly_limit: "0" }],
    ["a limit over the ceiling", { ...VALID_CRITERIA_BODY, starting_monthly_limit: "100000001" }],
    ["zero months", { ...VALID_CRITERIA_BODY, bank_statement_months: 0 }],
    ["months over 36", { ...VALID_CRITERIA_BODY, bank_statement_months: 37 }],
    ["a missing field", { starting_monthly_limit: "100" }],
    ["a threshold over the ceiling", { ...VALID_CRITERIA_BODY, large_transaction_hold_threshold: "1000000001" }],
    ["a boolean as a string", { ...VALID_CRITERIA_BODY, large_transaction_hold_enabled: "yes" }],
  ];

  for (const [description, body] of badBodies) {
    const badDatabase = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      updateUnderwritingCriteria({ actor: desk, body }, dependenciesOf(badDatabase, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the criteria save refuses ${description}`);
    expectEqual(badDatabase.updates.length, 0, `and writes nothing for ${description}`);
  }

  const rangeDatabase = createBusinessDatabase();
  const rangeRefusal = await rejectionOf(() =>
    updateUnderwritingCriteria(
      { actor: desk, body: { ...VALID_CRITERIA_BODY, starting_monthly_limit: "0" } },
      dependenciesOf(rangeDatabase, createInMemoryAuditTrail()),
    ),
  );

  expect(
    (rangeRefusal?.details ?? []).some((detail) => detail.rule === "out_of_range"),
    "a range refusal names the out_of_range rule",
  );

  // A lost race: the row moves on between the read and the write, so the re-read conflicts.
  const raceDatabase = createBusinessDatabase();
  raceDatabase.criteriaRace = true;
  const raceRefusal = await rejectionOf(() =>
    updateUnderwritingCriteria({ actor: desk, body: VALID_CRITERIA_BODY }, dependenciesOf(raceDatabase, createInMemoryAuditTrail())),
  );

  expectEqual(raceRefusal?.code, "CONFLICT", "a lost race conflicts");
  expectDeepEqual(raceRefusal?.details, [{ field: "version", rule: "stale" }], "named stale");

  // The tier save: conditional update, audit, and idempotency when nothing changes.
  const tierDatabase = createBusinessDatabase();
  const tierAudit = createInMemoryAuditTrail();
  const tiered = await updateUnderwritingRiskTier(
    { actor: desk, body: { tier: "high", extra_reserve_percent: "10.00", hold_days: 7 } },
    dependenciesOf(tierDatabase, tierAudit),
  );
  const highTier = tiered.tiers.find((tier) => tier.tier === "high");

  expectEqual(highTier?.extraReservePercent, "10.00", "the tier's reserve saved");
  expectEqual(highTier?.holdDays, 7, "and its hold days");
  expectEqual(highTier?.version, 2, "version bumped");

  const tierUpdate = tierDatabase.updates.find((entry) => entry.table === UNDERWRITING_RISK_TIERS_TABLE);

  expect(
    tierUpdate !== undefined && tierUpdate.query.includes("version=eq.1"),
    "the tier update is conditional on the current version",
  );
  expectEqual(
    tierAudit.entries.filter((entry) => entry.action === UNDERWRITING_RISK_TIER_AUDIT_ACTION).length,
    1,
    "one tier audit entry",
  );
  expectEqual(
    tierAudit.entries.find((entry) => entry.action === UNDERWRITING_RISK_TIER_AUDIT_ACTION)?.entityType,
    UNDERWRITING_RISK_TIER_ENTITY,
    "on the tier entity",
  );

  const again = await updateUnderwritingRiskTier(
    { actor: desk, body: { tier: "high", extra_reserve_percent: "10.00", hold_days: 7 } },
    dependenciesOf(tierDatabase, tierAudit),
  );

  expectEqual(again.tiers.find((tier) => tier.tier === "high")?.version, 2, "re-saving the same values changes nothing");
  expectEqual(
    tierDatabase.updates.filter((entry) => entry.table === UNDERWRITING_RISK_TIERS_TABLE).length,
    1,
    "the idempotent save writes no second update",
  );
  expectEqual(
    tierAudit.entries.filter((entry) => entry.action === UNDERWRITING_RISK_TIER_AUDIT_ACTION).length,
    1,
    "and audits nothing",
  );

  for (const [description, body] of [
    ["an unknown tier", { tier: "critical", extra_reserve_percent: "1", hold_days: 1 }],
    ["a reserve over 100", { tier: "low", extra_reserve_percent: "101", hold_days: 1 }],
    ["hold days over 90", { tier: "low", extra_reserve_percent: "1", hold_days: 91 }],
    ["negative days", { tier: "low", extra_reserve_percent: "1", hold_days: -1 }],
  ] as const) {
    const badTierDatabase = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      updateUnderwritingRiskTier({ actor: desk, body }, dependenciesOf(badTierDatabase, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the tier save refuses ${description}`);
    expectEqual(badTierDatabase.updates.length, 0, `and writes nothing for ${description}`);
  }

  // The code tier: set, idempotent re-set, retired conflict, unknown code, bad format.
  const mccDatabase = createBusinessDatabase();
  const mccAudit = createInMemoryAuditTrail();
  const overview = await setMccRiskTier(
    { actor: desk, body: { code: "5812", tier: "high" } },
    dependenciesOf(mccDatabase, mccAudit),
  );
  const restaurants = overview.rows.find((row) => row.code === "5812");

  expectEqual(restaurants?.tier, "high", "the code's tier is set in the overview");
  expectEqual(
    mccDatabase.mccRows.find((row) => row.code === "5812")?.version,
    2,
    "version bumped on the code row",
  );

  const mccUpdate = mccDatabase.updates.find((entry) => entry.table === MCC_CODES_TABLE);

  expect(
    mccUpdate !== undefined && mccUpdate.query.includes("id=eq.") && mccUpdate.query.includes("version=eq.1"),
    "the code update is conditional on id and current version",
  );

  const mccAuditEntry = mccAudit.entries.find((entry) => entry.action === UNDERWRITING_MCC_TIER_AUDIT_ACTION);

  expectEqual(mccAuditEntry?.entityType, MCC_CODE_ENTITY, "the tier change is audited on the code entity");
  expectDeepEqual(mccAuditEntry?.payload, { code: "5812", tier: "high" }, "with the code and the tier");
  expectEqual(mccAuditEntry?.companyId, null, "on the platform chain");

  await setMccRiskTier({ actor: desk, body: { code: "5812", tier: "high" } }, dependenciesOf(mccDatabase, mccAudit));

  expectEqual(
    mccDatabase.updates.filter((entry) => entry.table === MCC_CODES_TABLE).length,
    1,
    "re-setting the same tier writes nothing",
  );

  const retiredRefusal = await rejectionOf(() =>
    setMccRiskTier(
      { actor: desk, body: { code: "0001", tier: "high" } },
      dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(retiredRefusal?.code, "CONFLICT", "a retired code conflicts");
  expectDeepEqual(retiredRefusal?.details, [{ field: "code", rule: "retired_code" }], "named retired_code");

  const unknownCode = await rejectionOf(() =>
    setMccRiskTier(
      { actor: desk, body: { code: "9999", tier: "high" } },
      dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknownCode?.code, "RESOURCE_NOT_FOUND", "an unknown code is not found");

  const badCodeDatabase = createBusinessDatabase();
  const badCode = await rejectionOf(() =>
    setMccRiskTier({ actor: desk, body: { code: "12", tier: "high" } }, dependenciesOf(badCodeDatabase, createInMemoryAuditTrail())),
  );

  expectEqual(badCode?.code, "VALIDATION_FAILED", "a two digit code is refused");
  expectEqual(badCodeDatabase.queries.length, 0, "before any query");

  const cleared = await setMccRiskTier(
    { actor: desk, body: { code: "5411", tier: "unassigned" } },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(
    cleared.rows.find((row) => row.code === "5411")?.tier,
    "unassigned",
    "a tier can be cleared back to unassigned",
  );

  // The overview: active codes only, counts across companies, ordered by count then code.
  const overviewDatabase = createBusinessDatabase([
    businessRow({ company_id: COMPANY_A, mcc_code: "5812" }),
    businessRow({ company_id: COMPANY_B, mcc_code: "5812" }),
    businessRow({ company_id: COMPANY_A, mcc_code: "0742" }),
    businessRow({ company_id: COMPANY_A }),
  ]);
  const overviewAudit = createInMemoryAuditTrail();
  const list = await readUnderwritingMccOverview({ actor: ceoDesk }, dependenciesOf(overviewDatabase, overviewAudit));

  expectEqual(list.rows.length, 3, "the retired code is not listed");
  expectEqual(list.rows[0]?.code, "5812", "the most used code first");
  expectEqual(list.rows[0]?.profileCount, 2, "counted across companies");
  expectEqual(list.rows[1]?.code, "0742", "then the next by count");
  expectEqual(list.rows[1]?.profileCount, 1, "one merchant on the veterinary code");
  expectEqual(list.rows[2]?.code, "5411", "then the unused code");
  expectEqual(list.rows[2]?.profileCount, 0, "with zero merchants");
  expect(
    overviewDatabase.queries.some(
      (query) => query.startsWith(`${BUSINESS_PROFILE_TABLE}?`) && query.includes("mcc_code=not.is.null") && !query.includes("company_id=eq."),
    ),
    "the overview's profile read is the one deliberate cross-company read, selecting only the code",
  );
  expect(
    overviewDatabase.queries
      .filter((query) => query.startsWith(`${MCC_CODES_TABLE}?`))
      .every((query) => query.includes("is_active=is.true")),
    "and the code read asks for active rows only",
  );
  expectEqual(
    overviewAudit.entries.filter((entry) => entry.action === UNDERWRITING_READ_AUDIT_ACTION).length,
    1,
    "the overview read is audited",
  );
}

/** ---- STEP 090 sources: the routes, the screen, the service, the migration, the merchant wiring. */
async function checkUnderwritingSources(): Promise<void> {
  const criteriaRoute = await readRepositoryFile("app/api/onboarding/underwriting-criteria/route.ts");
  const tierRoute = await readRepositoryFile("app/api/onboarding/underwriting-risk-tier/route.ts");
  const mccTierRoute = await readRepositoryFile("app/api/onboarding/underwriting-mcc-tier/route.ts");
  const mccRoute = await readRepositoryFile("app/api/onboarding/underwriting-mcc/route.ts");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/underwriting/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/onboarding/underwriting/underwriting-panel.tsx");
  const service = await readRepositoryFile("services/kyc/underwriting.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const migration = await readRepositoryFile("migrations/0106_underwriting_criteria.sql");
  const rollback = await readRepositoryFile("migrations/0106_underwriting_criteria.down.sql");
  const documentRoute = await readRepositoryFile("app/api/onboarding/kyc-document/route.ts");
  const documentsPage = await readRepositoryFile("app/(dashboard)/onboarding/documents/page.tsx");
  const documentsForm = await readRepositoryFile("app/(dashboard)/onboarding/documents/documents-form.tsx");

  for (const [path, source] of [
    ["app/api/onboarding/underwriting-criteria/route.ts", criteriaRoute],
    ["app/api/onboarding/underwriting-risk-tier/route.ts", tierRoute],
    ["app/api/onboarding/underwriting-mcc-tier/route.ts", mccTierRoute],
    ["app/api/onboarding/underwriting-mcc/route.ts", mccRoute],
    ["app/(dashboard)/onboarding/underwriting/page.tsx", page],
    ["app/(dashboard)/onboarding/underwriting/underwriting-panel.tsx", panel],
    ["services/kyc/underwriting.ts", service],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  expectEqual(criteriaRoute.includes("export const GET"), false, "the criteria route answers no GET: the screen reads server-side");
  expect(criteriaRoute.includes("export const POST"), "and answers POST");
  expect(criteriaRoute.includes("updateUnderwritingCriteria("), "the POST saves through the service");
  expect(mccRoute.includes("export const GET"), "the mcc route answers GET");
  expectEqual(mccRoute.includes("export const POST"), false, "and answers no POST");
  expect(mccRoute.includes("readUnderwritingMccOverview("), "reading the overview through the service");
  expectEqual(mccRoute.includes("searchParams"), false, "and takes no parameter: the list is platform scoped");

  for (const [path, route, serviceCall] of [
    ["app/api/onboarding/underwriting-criteria/route.ts", criteriaRoute, "updateUnderwritingCriteria("],
    ["app/api/onboarding/underwriting-risk-tier/route.ts", tierRoute, "updateUnderwritingRiskTier("],
    ["app/api/onboarding/underwriting-mcc-tier/route.ts", mccTierRoute, "setMccRiskTier("],
  ] as const) {
    expect(route.includes("export const POST"), `${path} answers POST`);
    expect(route.includes("requireCsrfToken("), "the token is checked first");
    expect(route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("), "before the session is read");
    expect(route.indexOf("requireCsrfToken(") < route.indexOf("request.text()"), "and before the body is read");
    expect(route.includes("maximumBodyBytes"), "the body is bounded");
    expect(route.includes('"cache-control": "no-store"'), "the answer is not cached");
    expect(route.includes(serviceCall), `and the service call is ${serviceCall}`);
    expect(
      csrf.includes(`"${path.replace("app/api", "/api").replace("/route.ts", "")}",`),
      `and the path is on the CSRF-protected list`,
    );
  }

  expect(service.includes("UNDERWRITING_CRITERIA_TABLE = \"underwriting_criteria\""), "the service names the criteria table");
  expect(service.includes("UNDERWRITING_RISK_TIERS_TABLE = \"underwriting_risk_tiers\""), "and the tiers table");
  expect(service.includes("version=eq."), "every write is conditional on the current version");
  expect(service.includes("deleted_at=is.null"), "and over live rows only");
  expect(service.includes("retired_code"), "a retired code's tier conflicts");
  expect(service.includes("mcc_code=not.is.null"), "the overview counts profiles by code across companies");
  expect(service.includes(UNDERWRITING_CRITERIA_AUDIT_ACTION), "the criteria save is audited");
  expect(service.includes(UNDERWRITING_RISK_TIER_AUDIT_ACTION), "the tier save is audited");
  expect(service.includes(UNDERWRITING_MCC_TIER_AUDIT_ACTION), "the code tier save is audited");
  expect(service.includes("export async function readMerchantUnderwritingSummary"), "and the merchant-safe summary exists");
  expect(
    service.includes("return { bankStatementPeriodMonths: row.bank_statement_months };"),
    "the summary answers the statement period only",
  );

  expect(page.includes("readOwnerActor()"), "the page reads the account through the cached reader");
  expect(page.includes("readUnderwritingSettings("), "and the settings through the service");
  expect(page.includes("readUnderwritingMccOverview("), "and the overview through the service");
  expect(page.includes("<SessionKeeper"), "and keeps the session rotating");
  expect(page.includes("UnderwritingPanel"), "and hands both reads to the panel");
  for (const state of ["signed-out", "forbidden", "unavailable", "ready"]) {
    expect(page.includes(`"${state}"`), `the page keeps the ${state} answer apart`);
  }

  expectEqual(panel.includes('"use client"'), true, "the panel is a client component");
  expectEqual((panel.match(/method: "POST"/gu) ?? []).length, 1, "its three saves share one POST site");
  expectEqual((panel.match(/\.\.\.\(await csrfHeaders\(\)\)/gu) ?? []).length, 1, "with one awaited CSRF spread");
  for (const pathConst of ["CRITERIA_PATH", "TIER_PATH", "MCC_TIER_PATH"]) {
    expect(panel.includes(pathConst), `the panel posts to ${pathConst}`);
  }
  expect(panel.includes('"/api/onboarding/underwriting-criteria"'), "the criteria path");
  expect(panel.includes('"/api/onboarding/underwriting-risk-tier"'), "the tier path");
  expect(panel.includes('"/api/onboarding/underwriting-mcc-tier"'), "the code tier path");
  expectEqual(panel.includes("company_id"), false, "and no company field is ever sent in a body");

  expect(migration.includes("create table public.underwriting_criteria"), "the migration creates the criteria table");
  expect(migration.includes("create table public.underwriting_risk_tiers"), "and the tiers table");
  expect(migration.includes("business_profiles_underwriting_read"), "and the office read policy on the profiles");
  expect(migration.includes("underwriting_criteria_manage_all"), "and the manage policy");
  expect(migration.includes("underwriting_criteria_owner_read"), "and the owner read policy for the statement period");
  expect(migration.includes("1000.0000"), "seeding the default starting limit");
  expect(rollback.includes("drop table if exists public.underwriting_criteria;"), "the rollback drops the criteria table");
  expect(rollback.includes("drop table if exists public.underwriting_risk_tiers;"), "and the tiers table");
  expect(rollback.includes("drop policy if exists business_profiles_underwriting_read"), "and the added policy");

  // The merchant wiring: the documents route enforces the stored period, the page shows it.
  expect(documentRoute.includes("readMerchantUnderwritingSummary("), "the document route reads the compliance-set period");
  expect(
    documentRoute.includes("bankStatementPeriodMonths: summary.bankStatementPeriodMonths"),
    "and hands it to the capture service",
  );
  expect(documentsPage.includes("readMerchantUnderwritingSummary("), "the documents page reads the summary");
  expect(documentsPage.includes("statementPeriodMonths"), "and passes the period to the form");
  expect(documentsForm.includes("statementPeriodMonths"), "the form checks against the passed period");
  expectEqual(
    documentsForm.includes("BANK_STATEMENT_DEFAULT_PERIOD_MONTHS"),
    false,
    "and no longer hardcodes the default: the compliance-set period is the rule",
  );

  for (const folder of ["underwriting-criteria", "underwriting-risk-tier", "underwriting-mcc-tier", "underwriting-mcc"]) {
    expect(
      (await readdir(new URL(`app/api/onboarding/${folder}/`, repositoryRoot))).includes("route.ts"),
      `${folder} is a route handler of its own`,
    );
  }
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/underwriting/", repositoryRoot))).includes("page.tsx"),
    "the underwriting screen lives in the onboarding area",
  );
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/underwriting/", repositoryRoot))).includes("underwriting-panel.tsx"),
    "with its panel beside it",
  );
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("underwriting.ts"),
    "the underwriting service lives in services/kyc",
  );
}

/** ---- STEP 090 catalog: every sentence of the underwriting screen is used, and every key it names exists. */
async function checkUnderwritingCatalog(): Promise<void> {
  const block = en.onboardingUnderwriting as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/underwriting/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/onboarding/underwriting/underwriting-panel.tsx");
  const sources = `${page}\n${panel}`;

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

  walk(block, "onboardingUnderwriting");

  expect(flat.length >= 30, "the underwriting screen has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingUnderwriting\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["showingLine", "versionLine"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingUnderwriting.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingUnderwriting.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
}

/** ---- STEP 091: the starting transaction limit enforcement for new merchants. */
const limitOwnerRefused: readonly (readonly [string, RequestActor])[] = [
  ["super_admin", actorOf(["super_admin"], null, { userId: OFFICE_ID })],
  ["ceo", ceoDesk],
  ["compliance_kyc", desk],
  ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })],
  ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
  ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
  ["nobody", actorOf([], null)],
];

/** A database with the given limit rows and everything else at its default. */
function limitDatabaseOf(limitRows: readonly LimitRowShape[]): BusinessDatabase {
  return createBusinessDatabase(
    [],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [],
    [],
    [],
    [],
    defaultCriteriaRow(),
    defaultTierRows(),
    limitRows,
  );
}

function limitRow(overrides: Partial<LimitRowShape> = {}): LimitRowShape {
  return {
    id: "018f2b8a-0000-4c2d-9c3e-0000000000f1",
    company_id: COMPANY_A,
    month_key: "2026-11",
    monthly_limit: "1000.0000",
    used_amount: "0.0000",
    updated_by: null,
    version: 1,
    updated_at: "2026-11-01T10:00:00.000Z",
    created_at: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

async function checkMerchantLimit(): Promise<void> {
  expectEqual(monthKeyOf(NOW), "2026-11", "the gate's clock sits in November 2026 UTC");

  // Owner-only functions refuse every non-owner before a query.
  for (const [description, actor] of limitOwnerRefused) {
    for (const [label, call] of [
      ["the limit read", () => readMerchantLimit({ actor }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()))],
      ["the limit check", () => checkTransactionAgainstLimit({ actor, amount: "10" }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()))],
      ["the usage record", () => recordTransactionUsage({ actor, amount: "10" }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()))],
    ] as const) {
      const database = createBusinessDatabase();
      const deps = dependenciesOf(database, createInMemoryAuditTrail());
      const refusal = await rejectionOf(() =>
        label === "the limit read"
          ? readMerchantLimit({ actor }, deps)
          : label === "the limit check"
            ? checkTransactionAgainstLimit({ actor, amount: "10" }, deps)
            : recordTransactionUsage({ actor, amount: "10" }, deps),
      );

      expectEqual(refusal?.code, "PERMISSION_DENIED", `${label} refuses ${description}`);
      expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
      void call;
    }
  }

  // An owner without a company is refused too.
  const companyless = await rejectionOf(() =>
    readMerchantLimit({ actor: actorOf(["owner"], null) }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail())),
  );

  expectEqual(companyless?.code, "PERMISSION_DENIED", "an owner without a company gets no limit");

  // The first read creates the row from the 0106 criteria, audited as assigned.
  const database = createBusinessDatabase();
  const audit = createInMemoryAuditTrail();
  const first = await readMerchantLimit({ actor: owner }, dependenciesOf(database, audit));

  expectEqual(first.monthlyLimit, "1000.0000", "the new merchant starts at the criteria's starting limit");
  expectEqual(first.monthKey, "2026-11", "in the current UTC month");
  expectEqual(first.usedAmount, "0.0000", "with nothing used");
  expectEqual(first.remainingAmount, "1000.0000", "so the whole limit is left");
  expectEqual(first.companyId, COMPANY_A, "scoped to the session's company");

  const assigned = database.inserts.filter((entry) => entry.table === MERCHANT_LIMITS_TABLE);

  expectEqual(assigned.length, 1, "exactly one limit row is inserted");
  expectEqual(
    audit.entries.filter((entry) => entry.action === MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION).length,
    1,
    "the assignment is audited under merchant_limit.assigned",
  );
  expectEqual(
    audit.entries.find((entry) => entry.action === MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION)?.payload?.["source"],
    "underwriting_criteria",
    "recording where the limit came from",
  );

  // The second read is idempotent: no second insert.
  const again = await readMerchantLimit({ actor: owner }, dependenciesOf(database, audit));

  expectEqual(again.monthlyLimit, "1000.0000", "the same limit");
  expectEqual(
    database.inserts.filter((entry) => entry.table === MERCHANT_LIMITS_TABLE).length,
    1,
    "no second row is created",
  );
  expectEqual(
    audit.entries.filter((entry) => entry.action === MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION).length,
    1,
    "and no second assignment is audited",
  );

  // A lost insert race converges on the winner's row instead of failing.
  const raceDatabase = limitDatabaseOf([limitRow()]);
  raceDatabase.conflictOnInsert = true;
  const raced = await readMerchantLimit({ actor: owner }, dependenciesOf(raceDatabase, createInMemoryAuditTrail()));

  expectEqual(raced.monthlyLimit, "1000.0000", "a lost insert race re-reads the existing row");

  // The check: inside the limit passes, over the limit conflicts before any write.
  const checkDatabase = limitDatabaseOf([limitRow({ used_amount: "400.5000" })]);
  const allowed = await checkTransactionAgainstLimit({ actor: owner, amount: "500.25" }, dependenciesOf(checkDatabase, createInMemoryAuditTrail()));

  expectEqual(allowed.remainingAmount, "599.5000", "400.50 used of 1000 leaves 599.50, and 500.25 fits");
  expectEqual(checkDatabase.updates.length, 0, "the check writes nothing");

  const overDatabase = limitDatabaseOf([limitRow({ used_amount: "400.5000" })]);
  const over = await rejectionOf(() =>
    checkTransactionAgainstLimit({ actor: owner, amount: "600" }, dependenciesOf(overDatabase, createInMemoryAuditTrail())),
  );

  expectEqual(over?.code, "CONFLICT", "an amount past what is left conflicts");
  expectDeepEqual(over?.details, [{ field: "amount", rule: "monthly_limit_exceeded" }], "named monthly_limit_exceeded");
  expectEqual(overDatabase.updates.length, 0, "and writes nothing");

  for (const [description, amount] of [
    ["a non-numeric amount", "abc"],
    ["a zero amount", "0"],
    ["a negative amount", "-5"],
    ["five decimals", "1.00001"],
  ] as const) {
    const badDatabase = limitDatabaseOf([limitRow()]);
    const refusal = await rejectionOf(() =>
      checkTransactionAgainstLimit({ actor: owner, amount }, dependenciesOf(badDatabase, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the check refuses ${description}`);
    expectEqual(badDatabase.updates.length, 0, `and writes nothing for ${description}`);
  }

  // Recording usage: conditional update, version bump, audit; over the limit refused before the write.
  const recordDatabase = limitDatabaseOf([limitRow()]);
  const recordAudit = createInMemoryAuditTrail();
  const recorded = await recordTransactionUsage({ actor: owner, amount: "400.50" }, dependenciesOf(recordDatabase, recordAudit));

  expectEqual(recorded.usedAmount, "400.5000", "the usage is recorded to four decimals");
  expectEqual(recorded.remainingAmount, "599.5000", "and the remainder is exact");
  expectEqual(recorded.version, 2, "version bumped");

  const usageUpdate = recordDatabase.updates.find((entry) => entry.table === MERCHANT_LIMITS_TABLE);

  expect(
    usageUpdate !== undefined &&
      usageUpdate.query.includes("id=eq.") &&
      usageUpdate.query.includes("company_id=eq.") &&
      usageUpdate.query.includes("version=eq.1") &&
      usageUpdate.query.includes("month_key=eq.2026-11"),
    "the usage update is conditional on id, company, version and month",
  );
  expectEqual(
    recordAudit.entries.filter((entry) => entry.action === MERCHANT_LIMIT_USAGE_AUDIT_ACTION).length,
    1,
    "one usage_recorded audit entry",
  );
  expectEqual(
    recordAudit.entries.find((entry) => entry.action === MERCHANT_LIMIT_USAGE_AUDIT_ACTION)?.payload?.["amount"],
    "400.5000",
    "with the amount in the payload",
  );

  const overRecord = await rejectionOf(() =>
    recordTransactionUsage({ actor: owner, amount: "600.0001" }, dependenciesOf(recordDatabase, createInMemoryAuditTrail())),
  );

  expectEqual(overRecord?.code, "CONFLICT", "recording past the limit conflicts");
  expectDeepEqual(overRecord?.details, [{ field: "amount", rule: "monthly_limit_exceeded" }], "named monthly_limit_exceeded");
  expectEqual(
    recordDatabase.updates.filter((entry) => entry.table === MERCHANT_LIMITS_TABLE).length,
    1,
    "and the refused record writes nothing",
  );

  // Exactly at the limit is allowed; one cent more is not.
  const exact = await recordTransactionUsage({ actor: owner, amount: "599.50" }, dependenciesOf(recordDatabase, createInMemoryAuditTrail()));

  expectEqual(exact.usedAmount, "1000.0000", "the limit can be used up exactly");
  expectEqual(exact.remainingAmount, "0.0000", "with nothing left");

  const centOver = await rejectionOf(() =>
    recordTransactionUsage({ actor: owner, amount: "0.01" }, dependenciesOf(recordDatabase, createInMemoryAuditTrail())),
  );

  expectEqual(centOver?.code, "CONFLICT", "one cent over a used-up limit conflicts");

  // A month rollover resets the usage in the same conditional write.
  const staleMonth = limitDatabaseOf([limitRow({ month_key: "2026-10", used_amount: "900.0000", version: 3 })]);
  const rollAudit = createInMemoryAuditTrail();
  const rolled = await checkTransactionAgainstLimit({ actor: owner, amount: "999" }, dependenciesOf(staleMonth, rollAudit));

  expectEqual(rolled.monthKey, "2026-11", "the row rolled into the current month");
  expectEqual(rolled.usedAmount, "0.0000", "usage reset to zero");
  expectEqual(rolled.version, 4, "version bumped by the rollover");
  expectEqual(rolled.remainingAmount, "1000.0000", "the full limit is available again in the new month");

  const rollUpdate = staleMonth.updates.find((entry) => entry.table === MERCHANT_LIMITS_TABLE);

  expect(
    rollUpdate !== undefined && rollUpdate.query.includes("month_key=eq.2026-10") && rollUpdate.query.includes("version=eq.3"),
    "the rollover is conditional on the old month key and version",
  );
  expectEqual(
    rollAudit.entries.filter((entry) => entry.action === MERCHANT_LIMIT_USAGE_AUDIT_ACTION).length,
    1,
    "the rollover is audited as usage",
  );
  expectEqual(
    rollAudit.entries.find((entry) => entry.action === MERCHANT_LIMIT_USAGE_AUDIT_ACTION)?.payload?.["month_rollover"],
    true,
    "flagged as a rollover",
  );

  // A lost race on the usage write conflicts as stale.
  const raceDb = limitDatabaseOf([limitRow()]);
  raceDb.limitRace = true;
  const stale = await rejectionOf(() =>
    recordTransactionUsage({ actor: owner, amount: "10" }, dependenciesOf(raceDb, createInMemoryAuditTrail())),
  );

  expectEqual(stale?.code, "CONFLICT", "a lost usage race conflicts");
  expectDeepEqual(stale?.details, [{ field: "version", rule: "stale" }], "named stale");

  // The office write: manage roles only, conditional update, audit.
  for (const [description, actor] of [["an owner", owner], ["ceo", ceoDesk], ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })], ["nobody", actorOf([], null)]] as const) {
    const db = limitDatabaseOf([limitRow()]);
    const refusal = await rejectionOf(() =>
      updateMerchantLimit({ actor, body: { company_id: COMPANY_A, monthly_limit: "5000" } }, dependenciesOf(db, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `the limit change refuses ${description}`);
    expectEqual(db.updates.length, 0, `and writes nothing for ${description}`);
  }

  const setDatabase = limitDatabaseOf([limitRow()]);
  const setAudit = createInMemoryAuditTrail();
  const set = await updateMerchantLimit(
    { actor: desk, body: { company_id: COMPANY_A, monthly_limit: "5000.00" } },
    dependenciesOf(setDatabase, setAudit),
  );

  expectEqual(set.monthlyLimit, "5000.0000", "the office-set limit is stored to four decimals");
  expectEqual(set.version, 2, "version bumped");

  const setUpdate = setDatabase.updates.find((entry) => entry.table === MERCHANT_LIMITS_TABLE);

  expect(
    setUpdate !== undefined && setUpdate.query.includes("version=eq.1") && setUpdate.query.includes("company_id=eq."),
    "the office update is conditional on company and version",
  );
  expectEqual(setUpdate?.values["updated_by"], OFFICE_ID, "the updater is recorded");
  expectEqual(
    setAudit.entries.filter((entry) => entry.action === MERCHANT_LIMIT_UPDATED_AUDIT_ACTION).length,
    1,
    "audited under merchant_limit.updated",
  );
  expectEqual(
    setAudit.entries.find((entry) => entry.action === MERCHANT_LIMIT_UPDATED_AUDIT_ACTION)?.entityType,
    MERCHANT_LIMIT_ENTITY,
    "on the limit entity",
  );

  for (const [description, body] of [
    ["a non-uuid company", { company_id: "nope", monthly_limit: "5000" }],
    ["a non-numeric limit", { company_id: COMPANY_A, monthly_limit: "abc" }],
    ["a zero limit", { company_id: COMPANY_A, monthly_limit: "0" }],
    ["a limit over the ceiling", { company_id: COMPANY_A, monthly_limit: "100000001" }],
    ["a missing field", { company_id: COMPANY_A }],
  ] as const) {
    const badDb = limitDatabaseOf([limitRow()]);
    const refusal = await rejectionOf(() =>
      updateMerchantLimit({ actor: desk, body }, dependenciesOf(badDb, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the limit change refuses ${description}`);
    expectEqual(badDb.updates.length, 0, `and writes nothing for ${description}`);
  }

  const unknownCompany = await rejectionOf(() =>
    updateMerchantLimit(
      { actor: desk, body: { company_id: COMPANY_B, monthly_limit: "5000" } },
      dependenciesOf(limitDatabaseOf([limitRow()]), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknownCompany?.code, "RESOURCE_NOT_FOUND", "a merchant with no limit row is not found");

  const staleSetDb = limitDatabaseOf([limitRow()]);
  staleSetDb.limitRace = true;
  const staleSet = await rejectionOf(() =>
    updateMerchantLimit(
      { actor: desk, body: { company_id: COMPANY_A, monthly_limit: "5000" } },
      dependenciesOf(staleSetDb, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(staleSet?.code, "CONFLICT", "a lost race on the office write conflicts");
  expectDeepEqual(staleSet?.details, [{ field: "version", rule: "stale" }], "named stale");

  // The office read of another merchant's row is allowed by company, the owner's is not cross-company:
  // readMerchantLimit is owner-only, and the limit row read is company-scoped by the session.
  const crossDb = limitDatabaseOf([limitRow({ company_id: COMPANY_B, id: "018f2b8a-0000-4c2d-9c3e-0000000000f2" })]);
  const ownRead = await readMerchantLimit({ actor: otherOwner }, dependenciesOf(crossDb, createInMemoryAuditTrail()));

  expectEqual(ownRead.companyId, COMPANY_B, "the other owner reads their own company's row");
  expect(
    crossDb.queries.every((query) => query.includes("company_id=eq.") || query.startsWith(`${UNDERWRITING_CRITERIA_TABLE}?`)),
    "every limit query is company-scoped except the criteria read that seeds the row",
  );
}

/** ---- STEP 091 sources: the routes, the service, the migration, the merchant wiring. */
async function checkMerchantLimitSources(): Promise<void> {
  const limitRoute = await readRepositoryFile("app/api/onboarding/merchant-limit/route.ts");
  const setRoute = await readRepositoryFile("app/api/onboarding/merchant-limit-set/route.ts");
  const service = await readRepositoryFile("services/kyc/merchant-limit.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const migration = await readRepositoryFile("migrations/0107_merchant_transaction_limits.sql");
  const rollback = await readRepositoryFile("migrations/0107_merchant_transaction_limits.down.sql");
  const statusPage = await readRepositoryFile("app/(dashboard)/onboarding/status/page.tsx");
  const underwriting = await readRepositoryFile("services/kyc/underwriting.ts");

  for (const [path, source] of [
    ["app/api/onboarding/merchant-limit/route.ts", limitRoute],
    ["app/api/onboarding/merchant-limit-set/route.ts", setRoute],
    ["services/kyc/merchant-limit.ts", service],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  expect(limitRoute.includes("export const GET"), "the limit route answers GET");
  expectEqual(limitRoute.includes("export const POST"), false, "and answers no POST");
  expect(limitRoute.includes("readMerchantLimit("), "reading through the service");
  expectEqual(limitRoute.includes("searchParams"), false, "and no company comes from the query string");

  expect(setRoute.includes("export const POST"), "the limit-set route answers POST");
  expectEqual(setRoute.includes("export const GET"), false, "and answers no GET");
  expect(setRoute.includes("requireCsrfToken("), "the token is checked first");
  expect(setRoute.indexOf("requireCsrfToken(") < setRoute.indexOf("readRequestActor("), "before the session is read");
  expect(setRoute.indexOf("requireCsrfToken(") < setRoute.indexOf("request.text()"), "and before the body is read");
  expect(setRoute.includes("maximumBodyBytes"), "the body is bounded");
  expect(setRoute.includes('"cache-control": "no-store"'), "the answer is not cached");
  expect(setRoute.includes("updateMerchantLimit("), "the save goes through the service");
  expect(csrf.includes('"/api/onboarding/merchant-limit-set",'), "and the path is on the CSRF-protected list");

  expect(service.includes('MERCHANT_LIMITS_TABLE = "merchant_transaction_limits"'), "the service names the 0107 table");
  expect(service.includes("monthly_limit_exceeded"), "over-limit amounts conflict with a named rule");
  expect(service.includes("version=eq."), "every write is conditional on the current version");
  expect(service.includes("month_key=eq."), "the rollover and the usage write pin the month key");
  expect(service.includes("BigInt"), "money math is integer minor units, no float");
  expectEqual(service.includes("Math."), false, "no float math anywhere in the service");
  expect(service.includes(MERCHANT_LIMIT_ASSIGNED_AUDIT_ACTION), "the assignment is audited");
  expect(service.includes(MERCHANT_LIMIT_UPDATED_AUDIT_ACTION), "the office change is audited");
  expect(service.includes(MERCHANT_LIMIT_USAGE_AUDIT_ACTION), "the usage is audited");
  expect(service.includes("readStartingMonthlyLimit"), "the row is born from the 0106 criteria");
  expect(underwriting.includes("export async function readStartingMonthlyLimit"), "the criteria export exists");

  expect(migration.includes("create table public.merchant_transaction_limits"), "the migration creates the table");
  expect(migration.includes("used_amount >= 0 and used_amount <= monthly_limit"), "the database enforces the ceiling itself");
  expect(migration.includes("merchant_transaction_limits_company_key"), "one live row per merchant");
  expect(migration.includes("merchant_transaction_limits_owner_read"), "the owner reads their own row");
  expect(migration.includes("merchant_transaction_limits_manage_all"), "only compliance and super_admin write");
  expect(rollback.includes("drop table if exists public.merchant_transaction_limits;"), "the rollback drops the table");

  expect(statusPage.includes("readMerchantLimit("), "the status screen reads the merchant's limit");
  expect(statusPage.includes('"onboardingStatus.limitHeading"'), "and shows its heading");
  expect(statusPage.includes('formatMessage("onboardingStatus.limitLine"'), "and the templated line with its values");

  for (const folder of ["merchant-limit", "merchant-limit-set"]) {
    expect(
      (await readdir(new URL(`app/api/onboarding/${folder}/`, repositoryRoot))).includes("route.ts"),
      `${folder} is a route handler of its own`,
    );
  }
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("merchant-limit.ts"),
    "the limit service lives in services/kyc",
  );
}

/** ---- STEP 092: the unusual large transaction hold and its review. */

/** A database with the given hold rows and everything else at its default. */
function holdDatabaseOf(
  holdRows: readonly PaymentHoldRowShape[],
  criteriaRow: CriteriaRowShape | null = defaultCriteriaRow(),
): BusinessDatabase {
  return createBusinessDatabase(
    [],
    [],
    defaultMccRows(),
    defaultCountryRows(),
    [],
    [],
    [],
    [],
    criteriaRow,
    defaultTierRows(),
    [],
    holdRows,
  );
}

function holdRow(overrides: Partial<PaymentHoldRowShape> = {}): PaymentHoldRowShape {
  return {
    id: "018f2b8a-0000-4c2d-9c3e-0000000000a1",
    company_id: COMPANY_A,
    reference: "pay_001",
    amount: "10000.0000",
    status: "held",
    held_at: "2026-11-01T09:00:00.000Z",
    reviewed_by: null,
    reviewed_at: null,
    decision_reason: null,
    version: 1,
    updated_at: "2026-11-01T09:00:00.000Z",
    created_at: "2026-11-01T09:00:00.000Z",
    ...overrides,
  };
}

async function checkPaymentHolds(): Promise<void> {
  const financeDesk = actorOf(["finance_ops"], null, { userId: OFFICE_ID });
  const superDesk = actorOf(["super_admin"], null, { userId: OFFICE_ID });

  // The trigger and the merchant list are owner-only; the queue is the office read roles; the
  // decision is the manage roles. Every refusal happens before a single query.
  for (const [description, actor] of [
    ["super_admin", superDesk],
    ["ceo", ceoDesk],
    ["compliance_kyc", desk],
    ["finance_ops", financeDesk],
    ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
    ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
    ["nobody", actorOf([], null)],
  ] as const) {
    for (const [label, call] of [
      ["the trigger", () => holdLargeTransaction({ actor, amount: "20000" }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()))],
      ["the merchant list", () => readMerchantPaymentHolds({ actor }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()))],
    ] as const) {
      const database = createBusinessDatabase();
      const refusal = await rejectionOf(() =>
        label === "the trigger"
          ? holdLargeTransaction({ actor, amount: "20000" }, dependenciesOf(database, createInMemoryAuditTrail()))
          : readMerchantPaymentHolds({ actor }, dependenciesOf(database, createInMemoryAuditTrail())),
      );

      expectEqual(refusal?.code, "PERMISSION_DENIED", `${label} refuses ${description}`);
      expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
      void call;
    }
  }

  for (const [description, actor] of [
    ["an owner", owner],
    ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
    ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
    ["nobody", actorOf([], null)],
  ] as const) {
    const queueDatabase = createBusinessDatabase();
    const queueRefusal = await rejectionOf(() =>
      readPaymentHoldQueue({ actor }, dependenciesOf(queueDatabase, createInMemoryAuditTrail())),
    );

    expectEqual(queueRefusal?.code, "PERMISSION_DENIED", `the queue refuses ${description}`);
    expectEqual(queueDatabase.queries.length, 0, `and queries nothing for the queue read by ${description}`);

    const decideDatabase = createBusinessDatabase();
    const decideRefusal = await rejectionOf(() =>
      decidePaymentHold(
        { actor, holdId: "018f2b8a-0000-4c2d-9c3e-0000000000a1", body: { decision: "release" } },
        dependenciesOf(decideDatabase, createInMemoryAuditTrail()),
      ),
    );

    expectEqual(decideRefusal?.code, "PERMISSION_DENIED", `the decision refuses ${description}`);
    expectEqual(decideDatabase.queries.length, 0, `and queries nothing for the decision by ${description}`);
  }

  // finance_ops and ceo may read the queue; only the manage roles may decide.
  for (const [description, actor] of [
    ["compliance_kyc", desk],
    ["super_admin", superDesk],
    ["ceo", ceoDesk],
    ["finance_ops", financeDesk],
  ] as const) {
    const queue = await readPaymentHoldQueue({ actor }, dependenciesOf(holdDatabaseOf([holdRow()]), createInMemoryAuditTrail()));

    expectEqual(queue.rows.length, 1, `the queue answers ${description}`);
  }

  // An owner without a company is refused too.
  const companyless = await rejectionOf(() =>
    holdLargeTransaction(
      { actor: actorOf(["owner"], null), amount: "20000" },
      dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(companyless?.code, "PERMISSION_DENIED", "an owner without a company triggers no hold");

  // Bad amounts are refused before the criteria read: no query, no write.
  for (const [description, amount, rule] of [
    ["a non-numeric amount", "abc", "invalid_format"],
    ["a negative amount", "-5", "invalid_format"],
    ["fifteen digits", "100000000000001", "invalid_format"],
    ["five decimals", "1.00001", "invalid_format"],
    ["a zero amount", "0", "out_of_range"],
    ["a zero fraction", "0.0000", "out_of_range"],
  ] as const) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      holdLargeTransaction({ actor: owner, amount }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the trigger refuses ${description}`);
    expectDeepEqual(refusal?.details, [{ field: "amount", rule }], `naming ${rule}`);
    expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
    expectEqual(database.inserts.length, 0, `and writes nothing for ${description}`);
  }

  // Below the threshold, and with the switch off: answered { held: false }, nothing written.
  const belowDatabase = createBusinessDatabase();
  const below = await holdLargeTransaction(
    { actor: owner, amount: "9999.9999", reference: "pay_small" },
    dependenciesOf(belowDatabase, createInMemoryAuditTrail()),
  );

  expectEqual(below.held, false, "an amount below the 10000 threshold is not held");
  expectEqual(below.threshold, "10000.0000", "the criteria threshold is reported");
  expectEqual(below.hold, null, "with no hold");
  expectEqual(belowDatabase.inserts.length, 0, "and nothing is written");

  const disabledDatabase = holdDatabaseOf([], { ...defaultCriteriaRow(), large_transaction_hold_enabled: false });
  const disabled = await holdLargeTransaction(
    { actor: owner, amount: "50000" },
    dependenciesOf(disabledDatabase, createInMemoryAuditTrail()),
  );

  expectEqual(disabled.held, false, "a disabled hold criterion holds nothing");
  expectEqual(disabledDatabase.inserts.length, 0, "and writes nothing");

  const noCriteria = await rejectionOf(() =>
    holdLargeTransaction({ actor: owner, amount: "20000" }, dependenciesOf(holdDatabaseOf([], null), createInMemoryAuditTrail())),
  );

  expectEqual(noCriteria?.code, "RESOURCE_NOT_FOUND", "a missing criteria row is not found");

  // At and above the threshold the transaction is held: one insert, one re-read, one audit entry.
  const heldDatabase = createBusinessDatabase();
  const heldAudit = createInMemoryAuditTrail();
  const held = await holdLargeTransaction(
    { actor: owner, amount: "25000.5", reference: "pay_100" },
    dependenciesOf(heldDatabase, heldAudit),
  );

  expectEqual(held.held, true, "an amount at the threshold is held");
  expectEqual(held.amount, "25000.5000", "normalised to four decimals");
  expectEqual(held.hold?.status, "held", "the hold is waiting");
  expectEqual(held.hold?.companyId, COMPANY_A, "scoped to the session's company");
  expectEqual(held.hold?.reference, "pay_100", "carrying the payment reference");
  expectEqual(held.hold?.version, 1, "born at version 1");

  const holdInserts = heldDatabase.inserts.filter((entry) => entry.table === PAYMENT_HOLDS_TABLE);

  expectEqual(holdInserts.length, 1, "exactly one hold row is inserted");
  expectEqual(holdInserts[0]?.row["status"], "held", "inserted in status held");
  expectEqual(holdInserts[0]?.row["company_id"], COMPANY_A, "for the session's company");
  expectEqual(
    heldAudit.entries.filter((entry) => entry.action === PAYMENT_HOLD_CREATED_AUDIT_ACTION).length,
    1,
    "the hold is audited under payment_hold.created",
  );
  expectEqual(
    heldAudit.entries.find((entry) => entry.action === PAYMENT_HOLD_CREATED_AUDIT_ACTION)?.entityType,
    PAYMENT_HOLD_ENTITY,
    "on the payment_hold entity",
  );
  expectEqual(
    heldAudit.entries.find((entry) => entry.action === PAYMENT_HOLD_CREATED_AUDIT_ACTION)?.payload?.["amount"],
    "25000.5000",
    "with the held amount in the payload",
  );

  const atThreshold = await holdLargeTransaction(
    { actor: owner, amount: "10000" },
    dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()),
  );

  expectEqual(atThreshold.held, true, "exactly at the threshold is held too");

  // A down audit sink never fails the write it records.
  const throwingAudit = {
    append(): Promise<void> {
      return Promise.reject(new Error("the audit sink is down"));
    },
  };
  const deafHeld = await holdLargeTransaction(
    { actor: owner, amount: "20000" },
    { rest: createBusinessStore(createBusinessDatabase()), audit: throwingAudit, now: () => NOW },
  );

  expectEqual(deafHeld.held, true, "a hold whose audit sink fails is still held");

  // Idempotent per reference: the repeated trigger answers with the existing hold, no second row.
  const seeded = holdDatabaseOf([holdRow({ reference: "pay_100" })]);
  const seededAudit = createInMemoryAuditTrail();
  const repeated = await holdLargeTransaction(
    { actor: owner, amount: "20000", reference: "pay_100" },
    dependenciesOf(seeded, seededAudit),
  );

  expectEqual(repeated.held, true, "the repeated reference is still held");
  expectEqual(repeated.hold?.id, "018f2b8a-0000-4c2d-9c3e-0000000000a1", "answering with the existing hold");
  expectEqual(seeded.inserts.length, 0, "no second row is inserted");
  expectEqual(
    seededAudit.entries.filter((entry) => entry.action === PAYMENT_HOLD_CREATED_AUDIT_ACTION).length,
    0,
    "and no second creation is audited",
  );
  expect(
    seeded.queries.some((query) => query.startsWith(`${PAYMENT_HOLDS_TABLE}?`) && query.includes("reference=eq.pay_100")),
    "the idempotency lookup pins the reference",
  );

  // The office queue: cross-company on purpose, oldest first, one read audit per call.
  const queueDatabase = holdDatabaseOf([
    holdRow({ id: "018f2b8a-0000-4c2d-9c3e-0000000000a1", company_id: COMPANY_A, held_at: "2026-11-01T09:00:00.000Z" }),
    holdRow({ id: "018f2b8a-0000-4c2d-9c3e-0000000000a2", company_id: COMPANY_B, reference: "pay_002", held_at: "2026-11-02T10:00:00.000Z" }),
  ]);
  const queueAudit = createInMemoryAuditTrail();
  const queue = await readPaymentHoldQueue({ actor: desk }, dependenciesOf(queueDatabase, queueAudit));

  expectEqual(queue.rows.length, 2, "the queue sees every merchant's held transactions");
  expectEqual(queue.rows[0]?.companyId, COMPANY_A, "oldest first");
  expectEqual(queue.rows[1]?.companyId, COMPANY_B, "across companies on purpose");
  expect(
    queueDatabase.queries.every(
      (query) => !query.startsWith(`${PAYMENT_HOLDS_TABLE}?`) || !query.includes("company_id=eq."),
    ),
    "the queue query is never company-scoped",
  );
  expect(
    queueDatabase.queries.some((query) => query.includes("order=held_at.asc") && query.includes("limit=200")),
    "the queue is ordered oldest first with its cap",
  );
  expectEqual(
    queueAudit.entries.filter((entry) => entry.action === PAYMENT_HOLD_READ_AUDIT_ACTION).length,
    1,
    "one office read is audited under payment_hold.read_by_office",
  );
  expectEqual(
    queueAudit.entries.find((entry) => entry.action === PAYMENT_HOLD_READ_AUDIT_ACTION)?.payload?.["waiting"],
    2,
    "with the waiting count in the payload",
  );

  // The merchant list: own company only, newest first.
  const ownDatabase = holdDatabaseOf([
    holdRow({ id: "018f2b8a-0000-4c2d-9c3e-0000000000a1", company_id: COMPANY_A, held_at: "2026-11-01T09:00:00.000Z" }),
    holdRow({ id: "018f2b8a-0000-4c2d-9c3e-0000000000a2", company_id: COMPANY_A, reference: "pay_002", held_at: "2026-11-02T10:00:00.000Z" }),
    holdRow({ id: "018f2b8a-0000-4c2d-9c3e-0000000000a3", company_id: COMPANY_B, reference: "pay_003", held_at: "2026-11-02T11:00:00.000Z" }),
  ]);
  const own = await readMerchantPaymentHolds({ actor: owner }, dependenciesOf(ownDatabase, createInMemoryAuditTrail()));

  expectEqual(own.rows.length, 2, "the merchant sees only their own company's holds");
  expect(own.rows.every((row) => row.companyId === COMPANY_A), "every row is the session's company");
  expectEqual(own.rows[0]?.reference, "pay_002", "newest first");
  expect(
    ownDatabase.queries.every((query) => query.includes(`company_id=eq.${COMPANY_A}`) && query.includes("order=held_at.desc")),
    "the merchant list is company-scoped, newest first",
  );

  // The decision: uuid validated before any query, body next, then the held row.
  const badIdDatabase = createBusinessDatabase();
  const badId = await rejectionOf(() =>
    decidePaymentHold({ actor: desk, holdId: "nope", body: { decision: "release" } }, dependenciesOf(badIdDatabase, createInMemoryAuditTrail())),
  );

  expectEqual(badId?.code, "VALIDATION_FAILED", "a non-uuid hold id is refused");
  expectDeepEqual(badId?.details, [{ field: "hold_id", rule: "invalid_format" }], "named hold_id invalid_format");
  expectEqual(badIdDatabase.queries.length, 0, "before any query");

  for (const [description, body, rule] of [
    ["an unknown decision", { decision: "hold" }, "invalid_format"],
    ["a missing decision", {}, "invalid_format"],
    ["a rejection without a reason", { decision: "reject" }, "out_of_range"],
    ["a blank rejection reason", { decision: "reject", reason: "   " }, "out_of_range"],
  ] as const) {
    const bodyDatabase = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      decidePaymentHold(
        { actor: desk, holdId: "018f2b8a-0000-4c2d-9c3e-0000000000a1", body },
        dependenciesOf(bodyDatabase, createInMemoryAuditTrail()),
      ),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the decision refuses ${description}`);
    expect(refusal?.details?.some((detail) => detail.rule === rule) === true, `naming ${rule}`);
    expectEqual(bodyDatabase.queries.length, 0, `and queries nothing for ${description}`);
  }

  const unknown = await rejectionOf(() =>
    decidePaymentHold(
      { actor: desk, holdId: "018f2b8a-0000-4c2d-9c3e-00000000ffff", body: { decision: "release" } },
      dependenciesOf(holdDatabaseOf([]), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknown?.code, "RESOURCE_NOT_FOUND", "an unknown hold id is not found");

  const decidedDb = holdDatabaseOf([
    holdRow({ status: "released", version: 2, reviewed_by: OFFICE_ID, reviewed_at: "2026-11-02T10:30:00.000Z" }),
  ]);
  const already = await rejectionOf(() =>
    decidePaymentHold(
      { actor: desk, holdId: "018f2b8a-0000-4c2d-9c3e-0000000000a1", body: { decision: "reject", reason: "again" } },
      dependenciesOf(decidedDb, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(already?.code, "CONFLICT", "a decided hold conflicts");
  expectDeepEqual(already?.details, [{ field: "status", rule: "already_decided" }], "named already_decided");
  expectEqual(decidedDb.updates.length, 0, "and writes nothing");

  // Release: one conditional update, the reviewer named, version bumped, audited, fresh row answered.
  const releaseDatabase = holdDatabaseOf([holdRow()]);
  const releaseAudit = createInMemoryAuditTrail();
  const released = await decidePaymentHold(
    { actor: desk, holdId: "018f2b8a-0000-4c2d-9c3e-0000000000a1", body: { decision: "release" } },
    dependenciesOf(releaseDatabase, releaseAudit),
  );

  expectEqual(released.status, "released", "the hold is released");
  expectEqual(released.reviewedBy, OFFICE_ID, "the reviewer is recorded");
  expectEqual(released.reviewedAt, new Date(NOW).toISOString(), "at the decision instant");
  expectEqual(released.decisionReason, null, "a release carries no reason");
  expectEqual(released.version, 2, "version bumped");

  const holdUpdate = releaseDatabase.updates.find((entry) => entry.table === PAYMENT_HOLDS_TABLE);

  expect(
    holdUpdate !== undefined &&
      holdUpdate.query.includes("id=eq.018f2b8a-0000-4c2d-9c3e-0000000000a1") &&
      holdUpdate.query.includes("status=eq.held") &&
      holdUpdate.query.includes("version=eq.1") &&
      holdUpdate.query.includes("deleted_at=is.null"),
    "the decision update is conditional on id, status held, version and live rows",
  );
  expectEqual(holdUpdate?.values["version"], 2, "the write bumps the version");
  expectEqual(holdUpdate?.values["reviewed_by"], OFFICE_ID, "and names the reviewer");
  expectEqual(
    releaseAudit.entries.filter((entry) => entry.action === PAYMENT_HOLD_DECIDED_AUDIT_ACTION).length,
    1,
    "audited under payment_hold.decided",
  );
  expectEqual(
    releaseAudit.entries.find((entry) => entry.action === PAYMENT_HOLD_DECIDED_AUDIT_ACTION)?.entityType,
    PAYMENT_HOLD_ENTITY,
    "on the payment_hold entity",
  );
  expectEqual(
    releaseAudit.entries.find((entry) => entry.action === PAYMENT_HOLD_DECIDED_AUDIT_ACTION)?.payload?.["decision"],
    "release",
    "with the decision in the payload",
  );

  // Reject: the reason is required and stored trimmed.
  const rejectDatabase = holdDatabaseOf([holdRow()]);
  const rejected = await decidePaymentHold(
    { actor: desk, holdId: "018f2b8a-0000-4c2d-9c3e-0000000000a1", body: { decision: "reject", reason: "  too big for the profile  " } },
    dependenciesOf(rejectDatabase, createInMemoryAuditTrail()),
  );

  expectEqual(rejected.status, "rejected", "the hold is rejected");
  expectEqual(rejected.decisionReason, "too big for the profile", "the reason is stored trimmed");

  // A lost race on the decision write conflicts as stale.
  const raceDb = holdDatabaseOf([holdRow()]);
  raceDb.holdRace = true;
  const stale = await rejectionOf(() =>
    decidePaymentHold(
      { actor: desk, holdId: "018f2b8a-0000-4c2d-9c3e-0000000000a1", body: { decision: "release" } },
      dependenciesOf(raceDb, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(stale?.code, "CONFLICT", "a lost decision race conflicts");
  expectDeepEqual(stale?.details, [{ field: "version", rule: "stale" }], "named stale");
}

/** ---- STEP 092 sources: the routes, the service, the migration, the screen wiring. */
async function checkPaymentHoldSources(): Promise<void> {
  const queueRoute = await readRepositoryFile("app/api/onboarding/payment-holds/route.ts");
  const decideRoute = await readRepositoryFile("app/api/onboarding/payment-hold-decide/route.ts");
  const merchantRoute = await readRepositoryFile("app/api/onboarding/merchant-holds/route.ts");
  const service = await readRepositoryFile("services/kyc/payment-hold.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const migration = await readRepositoryFile("migrations/0108_payment_holds.sql");
  const rollback = await readRepositoryFile("migrations/0108_payment_holds.down.sql");
  const page = await readRepositoryFile("app/(dashboard)/onboarding/payment-holds/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/onboarding/payment-holds/payment-holds-panel.tsx");

  for (const [path, source] of [
    ["app/api/onboarding/payment-holds/route.ts", queueRoute],
    ["app/api/onboarding/payment-hold-decide/route.ts", decideRoute],
    ["app/api/onboarding/merchant-holds/route.ts", merchantRoute],
    ["services/kyc/payment-hold.ts", service],
    ["app/(dashboard)/onboarding/payment-holds/page.tsx", page],
    ["app/(dashboard)/onboarding/payment-holds/payment-holds-panel.tsx", panel],
  ] as const) {
    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path on its first line`);
    expectEqual(/[^\t\n\r\x20-\x7E]/u.test(source), false, `${path} is ASCII only`);
  }

  expect(queueRoute.includes("export const GET"), "the queue route answers GET");
  expectEqual(queueRoute.includes("export const POST"), false, "and answers no POST");
  expect(queueRoute.includes("readPaymentHoldQueue("), "the queue reads through the service");
  expectEqual(queueRoute.includes("searchParams"), false, "and no company comes from the query string");
  expect(queueRoute.includes('"cache-control": "no-store"'), "the queue answer is not cached");

  expect(decideRoute.includes("export const POST"), "the decide route answers POST");
  expectEqual(decideRoute.includes("export const GET"), false, "and answers no GET");
  expect(decideRoute.includes("requireCsrfToken("), "the token is checked first");
  expect(decideRoute.indexOf("requireCsrfToken(") < decideRoute.indexOf("readRequestActor("), "before the session is read");
  expect(decideRoute.indexOf("requireCsrfToken(") < decideRoute.indexOf("request.text()"), "and before the body is read");
  expect(decideRoute.includes("maximumBodyBytes"), "the body is bounded");
  expect(decideRoute.includes('"cache-control": "no-store"'), "the answer is not cached");
  expect(decideRoute.includes("decidePaymentHold("), "the decision goes through the service");
  expect(decideRoute.includes("logger.info("), "and is logged");
  expect(csrf.includes('"/api/onboarding/payment-hold-decide",'), "and the path is on the CSRF-protected list");

  expect(merchantRoute.includes("export const GET"), "the merchant route answers GET");
  expectEqual(merchantRoute.includes("export const POST"), false, "and answers no POST");
  expect(merchantRoute.includes("readMerchantPaymentHolds("), "the merchant list reads through the service");
  expectEqual(merchantRoute.includes("searchParams"), false, "and no company comes from the query string");
  expect(merchantRoute.includes('"cache-control": "no-store"'), "the list answer is not cached");

  expect(service.includes('PAYMENT_HOLDS_TABLE = "payment_holds"'), "the service names the 0108 table");
  expect(service.includes("BigInt"), "money math is integer minor units, no float");
  expectEqual(service.includes("Math."), false, "no float math anywhere in the service");
  expect(service.includes("already_decided"), "a decided hold conflicts with a named rule");
  expect(service.includes('"stale"'), "a lost race conflicts as stale");
  expect(service.includes("version=eq."), "the decision write is conditional on the current version");
  expect(service.includes("status=eq.held"), "and on the hold still waiting");
  expect(service.includes("reference=eq."), "the trigger is idempotent per reference");
  expect(service.includes("order=held_at.asc"), "the queue is oldest first");
  expect(service.includes("order=held_at.desc"), "the merchant list is newest first");
  expect(service.includes(PAYMENT_HOLD_CREATED_AUDIT_ACTION), "the creation is audited");
  expect(service.includes(PAYMENT_HOLD_DECIDED_AUDIT_ACTION), "the decision is audited");
  expect(service.includes(PAYMENT_HOLD_READ_AUDIT_ACTION), "the office read is audited");
  expect(service.includes("readLargeTransactionHold"), "the threshold comes from the 0106 criteria");

  expect(migration.includes("create table public.payment_holds"), "the migration creates the table");
  expect(migration.includes("payment_holds_status_check"), "the status vocabulary is enforced");
  expect(migration.includes("payment_holds_amount_check"), "the amount ceiling is enforced");
  expect(migration.includes("payment_holds_reason_check"), "the rejection reason rule is enforced");
  expect(migration.includes("enable row level security"), "RLS is on");
  expect(migration.includes("payment_holds_default_deny"), "with a default deny");
  expect(migration.includes("payment_holds_owner_read"), "the owner reads their own holds");
  expect(migration.includes("payment_holds_office_read"), "the office roles read the queue");
  expect(migration.includes("payment_holds_manage_all"), "only compliance and super_admin write");
  expect(rollback.includes("drop table if exists public.payment_holds;"), "the rollback drops the table");

  expect(page.includes("readOwnerActor("), "the queue screen reads the session actor");
  expect(page.includes("<SessionKeeper"), "and keeps the session alive");
  expect(page.includes("readPaymentHoldQueue("), "and reads the queue through the service");
  expect(page.includes("PaymentHoldsPanel"), "and renders the panel");
  expectEqual(
    panel.split('"/api/onboarding/payment-hold-decide"').length - 1,
    1,
    "the panel posts to exactly one decide literal",
  );
  expect(panel.includes("csrfHeaders"), "with the CSRF headers on the post");
  expect(panel.includes("postJson("), "through its single post helper");

  for (const folder of ["payment-holds", "payment-hold-decide", "merchant-holds"]) {
    expect(
      (await readdir(new URL(`app/api/onboarding/${folder}/`, repositoryRoot))).includes("route.ts"),
      `${folder} is a route handler of its own`,
    );
  }
  expect(
    (await readdir(new URL("app/(dashboard)/onboarding/payment-holds/", repositoryRoot))).includes("payment-holds-panel.tsx"),
    "the queue screen lives under the owned onboarding path",
  );
  expect(
    (await readdir(new URL("services/kyc/", repositoryRoot))).includes("payment-hold.ts"),
    "the hold service lives in services/kyc",
  );
}

async function checkPaymentHoldCatalog(): Promise<void> {
  const block = en.onboardingPaymentHolds as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/payment-holds/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/onboarding/payment-holds/payment-holds-panel.tsx");
  const sources = `${page}\n${panel}`;

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

  walk(block, "onboardingPaymentHolds");

  expect(flat.length >= 30, "the hold queue screen has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingPaymentHolds\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["companyLine", "amountLine", "referenceLine", "heldAtLine", "decidedLine", "reasonShownLine"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingPaymentHolds.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingPaymentHolds.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
}

/** ---- STEP 093: the KYC decision flow - approve or reject the whole submission, with reasons. */
async function checkKycDecision(): Promise<void> {
  const secondDesk = actorOf(["ceo"], null, { userId: "018f2b8a-1111-4c2d-9c3e-000000000009" });
  const superDesk2 = actorOf(["super_admin"], null, { userId: "018f2b8a-1111-4c2d-9c3e-00000000000a" });
  const IN_REVIEW_ID = "018f2b8a-0000-4c2d-9c3e-0000000000c3";
  const SUBMITTED_ID = "018f2b8a-0000-4c2d-9c3e-0000000000b2";
  const DECIDED_ID = "018f2b8a-0000-4c2d-9c3e-0000000000a7";

  expectDeepEqual(
    [...KYC_FINAL_APPROVAL_ROLES],
    ["ceo", "super_admin"],
    "the final approval belongs to ceo and super_admin, per section 2 and section 5",
  );

  // Approval refuses every role that is not ceo/super_admin; rejection refuses every non-office
  // role. Both refuse before a single query.
  for (const [description, actor] of [
    ["compliance_kyc", desk],
    ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })],
    ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
    ["blogger", actorOf(["blogger"], null, { userId: OFFICE_ID })],
    ["an owner", owner],
    ["nobody", actorOf([], null)],
  ] as const) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      decideKycSubmission(
        { actor, body: { submission_id: IN_REVIEW_ID, decision: "approve" } },
        dependenciesOf(database, createInMemoryAuditTrail()),
      ),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `approval refuses ${description}`);
    expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
  }

  for (const [description, actor] of [
    ["finance_ops", actorOf(["finance_ops"], null, { userId: OFFICE_ID })],
    ["support", actorOf(["support"], null, { userId: OFFICE_ID })],
    ["an owner", owner],
    ["nobody", actorOf([], null)],
  ] as const) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      decideKycSubmission(
        { actor, body: { submission_id: IN_REVIEW_ID, decision: "reject", reason: "no" } },
        dependenciesOf(database, createInMemoryAuditTrail()),
      ),
    );

    expectEqual(refusal?.code, "PERMISSION_DENIED", `rejection refuses ${description}`);
    expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
  }

  // Bad bodies are refused before any query: the id, the decision, the reason rules.
  for (const [description, body, field, rule] of [
    ["a non-uuid submission id", { submission_id: "nope", decision: "approve" }, "submission_id", "invalid_format"],
    ["a missing submission id", { decision: "approve" }, "submission_id", "invalid_format"],
    ["an unknown decision", { submission_id: IN_REVIEW_ID, decision: "hold" }, "decision", "invalid_format"],
    ["a rejection without a reason", { submission_id: IN_REVIEW_ID, decision: "reject" }, "reason", "required"],
    ["a blank rejection reason", { submission_id: IN_REVIEW_ID, decision: "reject", reason: "   " }, "reason", "invalid_format"],
    ["a reason over 280", { submission_id: IN_REVIEW_ID, decision: "reject", reason: "x".repeat(281) }, "reason", "invalid_format"],
  ] as const) {
    const database = createBusinessDatabase();
    const refusal = await rejectionOf(() =>
      decideKycSubmission({ actor: ceoDesk, body }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "VALIDATION_FAILED", `the decision refuses ${description}`);
    expect(
      refusal?.details?.some((detail) => detail.field === field && detail.rule === rule) === true,
      `naming ${field} ${rule} for ${description}`,
    );
    expectEqual(database.queries.length, 0, `and queries nothing for ${description}`);
  }

  const unknown = await rejectionOf(() =>
    decideKycSubmission(
      { actor: ceoDesk, body: { submission_id: "018f2b8a-9999-4c2d-9c3e-999999999999", decision: "approve" } },
      dependenciesOf(reviewSeededDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknown?.code, "RESOURCE_NOT_FOUND", "an unknown submission is not found");

  // A decided row is locked by 0048's guard: the service conflicts before writing.
  const decidedDb = reviewSeededDatabase();
  const decided = await rejectionOf(() =>
    decideKycSubmission(
      { actor: ceoDesk, body: { submission_id: DECIDED_ID, decision: "approve" } },
      dependenciesOf(decidedDb, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(decided?.code, "CONFLICT", "a decided submission conflicts");
  expectDeepEqual(decided?.details, [{ field: "status", rule: "already_decided" }], "named already_decided");
  expectEqual(decidedDb.updates.length, 0, "and writes nothing");

  // A submission that was not opened for review conflicts as not_in_review.
  const submittedDb = reviewSeededDatabase();
  const notOpen = await rejectionOf(() =>
    decideKycSubmission(
      { actor: ceoDesk, body: { submission_id: SUBMITTED_ID, decision: "approve" } },
      dependenciesOf(submittedDb, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(notOpen?.code, "CONFLICT", "a submitted-but-not-open row conflicts");
  expectDeepEqual(notOpen?.details, [{ field: "status", rule: "not_in_review" }], "named not_in_review");
  expectEqual(submittedDb.updates.length, 0, "and writes nothing");

  // Four eyes: the first reviewer cannot decide alone.
  const firstReviewerDb = reviewSeededDatabase();
  const selfSecond = await rejectionOf(() =>
    decideKycSubmission(
      { actor: desk, body: { submission_id: IN_REVIEW_ID, decision: "approve" } },
      dependenciesOf(firstReviewerDb, createInMemoryAuditTrail()),
    ),
  );

  // desk is compliance_kyc, which may not approve at all - so use the ceo who IS the first reviewer.
  expectEqual(selfSecond?.code, "PERMISSION_DENIED", "compliance_kyc cannot give the final approval");

  const samePersonDb = reviewSeededDatabase();
  const samePerson = await rejectionOf(() =>
    decideKycSubmission(
      { actor: ceoDesk, body: { submission_id: IN_REVIEW_ID, decision: "approve" } },
      dependenciesOf(samePersonDb, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(samePerson?.code, "VALIDATION_FAILED", "the first reviewer deciding a four-eye row is refused");
  expectDeepEqual(samePerson?.details, [{ field: "second_reviewer_id", rule: "same_reviewer" }], "named same_reviewer");
  expectEqual(samePersonDb.updates.length, 0, "and writes nothing");

  // The second reviewer approves a four-eye submission: conditional update, second reviewer named,
  // one kyc_review.decided audit, the detail as the answer.
  const approveDb = reviewSeededDatabase();
  const approveAudit = createInMemoryAuditTrail();
  const approved = await decideKycSubmission(
    { actor: secondDesk, body: { submission_id: IN_REVIEW_ID, decision: "approve" } },
    dependenciesOf(approveDb, approveAudit),
  );
  const approvedRow = approveDb.submissionRows.find((entry) => entry.id === IN_REVIEW_ID);

  expectEqual(approved.status, "approved", "the returned detail says approved");
  expectEqual(approvedRow?.status, "approved", "the row is approved");
  expectEqual(approvedRow?.version, 2, "version bumped");
  expectEqual(approvedRow?.["second_reviewer_id"], "018f2b8a-1111-4c2d-9c3e-000000000009", "the decider is the second reviewer");
  expectEqual(approvedRow?.["decided_at"], new Date(NOW).toISOString(), "decided at the request's instant");
  expectEqual(approvedRow?.["decision_reason"], null, "an approval carries no reason unless given");

  const approveUpdate = approveDb.updates.find((entry) => entry.table === KYC_SUBMISSIONS_TABLE);

  expect(
    approveUpdate !== undefined &&
      approveUpdate.query.includes(`id=eq.${IN_REVIEW_ID}`) &&
      approveUpdate.query.includes("status=eq.in_review") &&
      approveUpdate.query.includes("version=eq.1") &&
      approveUpdate.query.includes("deleted_at=is.null"),
    "the decision update is conditional on id, status in_review, version and live rows",
  );
  expectEqual(approveUpdate?.values["version"], 2, "the write bumps the version");
  expectEqual(
    approveAudit.entries.filter((entry) => entry.action === KYC_DECISION_AUDIT_ACTION).length,
    1,
    "every KYC decision is audited under kyc_review.decided",
  );
  expectEqual(
    approveAudit.entries.find((entry) => entry.action === KYC_DECISION_AUDIT_ACTION)?.payload?.["decision"],
    "approved",
    "with the decision in the payload",
  );
  expectEqual(
    approveAudit.entries.find((entry) => entry.action === KYC_DECISION_AUDIT_ACTION)?.payload?.["second_reviewer_id"],
    "018f2b8a-1111-4c2d-9c3e-000000000009",
    "recording the second reviewer",
  );

  // Rejection by the review office: open first, then reject with the trimmed reason.
  const rejectDb = reviewSeededDatabase();
  const rejectAudit = createInMemoryAuditTrail();
  await openKycReview({ actor: desk, submissionId: SUBMITTED_ID }, dependenciesOf(rejectDb, rejectAudit));
  const rejected = await decideKycSubmission(
    {
      actor: desk,
      body: { submission_id: SUBMITTED_ID, decision: "reject", reason: "  documents did not match  " },
    },
    dependenciesOf(rejectDb, rejectAudit),
  );
  const rejectedRow = rejectDb.submissionRows.find((entry) => entry.id === SUBMITTED_ID);

  expectEqual(rejected.status, "rejected", "the submission is rejected");
  expectEqual(rejected.decisionReason, "documents did not match", "the reason is stored trimmed, the merchant reads it");
  expectEqual(rejectedRow?.["second_reviewer_id"], null, "no second reviewer when four eyes are not required");
  expectEqual(rejectedRow?.version, 3, "open then decide bumped the version twice");

  const rejectUpdate = rejectDb.updates.filter((entry) => entry.table === KYC_SUBMISSIONS_TABLE)[1];

  expect(
    rejectUpdate !== undefined && rejectUpdate.query.includes("status=eq.in_review") && rejectUpdate.query.includes("version=eq.2"),
    "the rejection is conditional on the opened row's status and version",
  );
  expectEqual(
    rejectAudit.entries.filter((entry) => entry.action === KYC_DECISION_AUDIT_ACTION).length,
    1,
    "the rejection is audited too",
  );
  expectEqual(
    rejectAudit.entries.find((entry) => entry.action === KYC_DECISION_AUDIT_ACTION)?.payload?.["reason"],
    "documents did not match",
    "with the trimmed reason in the payload",
  );

  // super_admin may approve as well.
  const superDb = reviewSeededDatabase();
  const superApproved = await decideKycSubmission(
    { actor: superDesk2, body: { submission_id: IN_REVIEW_ID, decision: "approve", reason: "all clear" } },
    dependenciesOf(superDb, createInMemoryAuditTrail()),
  );

  expectEqual(superApproved.status, "approved", "super_admin approves too");
  expectEqual(superDb.submissionRows.find((entry) => entry.id === IN_REVIEW_ID)?.["decision_reason"], "all clear", "an approval may carry a note");

  // A lost race on the decision write conflicts as stale, without an audit entry.
  const raceDb = reviewSeededDatabase();
  raceDb.submissionRace = true;
  const raceAudit = createInMemoryAuditTrail();
  const stale = await rejectionOf(() =>
    decideKycSubmission(
      { actor: secondDesk, body: { submission_id: IN_REVIEW_ID, decision: "approve" } },
      dependenciesOf(raceDb, raceAudit),
    ),
  );

  expectEqual(stale?.code, "CONFLICT", "a lost decision race conflicts");
  expectDeepEqual(stale?.details, [{ field: "version", rule: "stale" }], "named stale");
  expectEqual(
    raceAudit.entries.filter((entry) => entry.action === KYC_DECISION_AUDIT_ACTION).length,
    0,
    "and a lost race is not audited as decided",
  );

  // A down audit sink never fails the decision it records.
  const throwingAudit = {
    append(): Promise<void> {
      return Promise.reject(new Error("the audit sink is down"));
    },
  };
  const deafDb = reviewSeededDatabase();
  const deafApproved = await decideKycSubmission(
    { actor: secondDesk, body: { submission_id: IN_REVIEW_ID, decision: "approve" } },
    { rest: createBusinessStore(deafDb), audit: throwingAudit, now: () => NOW },
  );

  expectEqual(deafApproved.status, "approved", "a decision whose audit sink fails is still recorded");
}

/** ---- STEP 093 sources: the decide route, the CSRF list, the panel's new action. */
async function checkKycDecisionSources(): Promise<void> {
  const decideRoute = await readRepositoryFile("app/api/onboarding/kyc-decide/route.ts");
  const review = await readRepositoryFile("services/kyc/kyc-review.ts");
  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  const reviewPanel = await readRepositoryFile("app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx");

  expectEqual(decideRoute.split("\n")[0], "// path: app/api/onboarding/kyc-decide/route.ts", "the decide route states its own path on its first line");
  expectEqual(/[^\t\n\r\x20-\x7E]/u.test(decideRoute), false, "the decide route is ASCII only");
  expect(decideRoute.includes("export const POST"), "the decide route answers POST");
  expectEqual(decideRoute.includes("export const GET"), false, "and answers no GET");
  expect(decideRoute.includes("requireCsrfToken("), "the token is checked first");
  expect(decideRoute.indexOf("requireCsrfToken(") < decideRoute.indexOf("readRequestActor("), "before the session is read");
  expect(decideRoute.indexOf("requireCsrfToken(") < decideRoute.indexOf("request.text()"), "and before the body is read");
  expect(decideRoute.includes("maximumBodyBytes"), "the body is bounded");
  expect(decideRoute.includes('"cache-control": "no-store"'), "the answer is not cached");
  expect(decideRoute.includes("decideKycSubmission("), "the decision goes through the service");
  expect(decideRoute.includes("logger.info("), "and is logged");
  expect(csrf.includes('"/api/onboarding/kyc-decide",'), "and the path is on the CSRF-protected list");

  expect(review.includes("KYC_DECISION_AUDIT_ACTION = \"kyc_review.decided\""), "the service names the decision audit action");
  expect(review.includes("already_decided"), "a decided submission conflicts with a named rule");
  expect(review.includes("not_in_review"), "an unopened one conflicts as not_in_review");
  expect(review.includes("same_reviewer"), "and a one-eyed four-eye decision as same_reviewer");
  expect(review.includes("decideKycSubmissionBodySchema"), "the body schema is exported");
  expect(review.includes("second_reviewer_id"), "the four-eye decision names its second reviewer");

  expect(
    (await readdir(new URL("app/api/onboarding/kyc-decide/", repositoryRoot))).includes("route.ts"),
    "kyc-decide is a route handler of its own",
  );
  expectEqual(
    reviewPanel.split('"/api/onboarding/kyc-decide"').length - 1,
    1,
    "the panel posts the decision to exactly one decide literal",
  );
  expect(reviewPanel.includes("decideSubmission("), "the panel owns the approve/reject action");
  expectEqual((reviewPanel.match(/method: "POST"/gu) ?? []).length, 1, "still sharing one POST site");
  expectEqual((reviewPanel.match(/\.\.\.\(await csrfHeaders\(\)\)/gu) ?? []).length, 1, "with one awaited CSRF spread");
  for (const key of ["decisionHeading", "approveButton", "rejectSubmissionButton", "decideBusy", "decidedDone", "ruleNotInReview", "statusApproved", "statusRejected"]) {
    expect(reviewPanel.includes(`onboardingKycReview.${key}`), `the panel uses the copy key ${key}`);
  }
  expectEqual(reviewPanel.includes("company_id"), false, "and no company field is ever sent in a body");
}

/** ---- STEP 094: the automatic sub-merchant provisioning job after a KYC approval. */
const APPROVED_SUBMISSION_ID = "018f2b8a-0000-4c2d-9c3e-0000000000e5";
const NMI_PROVIDER_ID = "018f2b8a-0000-4c2d-9c3e-000000000011";
const STRIPE_PROVIDER_ID = "018f2b8a-0000-4c2d-9c3e-000000000012";
const NMI_MASTER_KEY_ID = "018f2b8a-0000-4c2d-9c3e-000000000021";

/** A review-seeded database with one approved submission on top. */
function provisionSeededDatabase(): BusinessDatabase {
  const database = reviewSeededDatabase();

  database.submissionRows.push({
    id: APPROVED_SUBMISSION_ID,
    company_id: COMPANY_A,
    status: "approved",
    verification_method: "manual",
    submitted_at: "2026-11-01T10:00:00.000Z",
    submitted_by: OWNER_ID,
    first_reviewer_id: OFFICE_ID,
    decided_at: "2026-11-02T09:00:00.000Z",
    decision_reason: null,
    created_at: "2026-11-01T08:45:00.000Z",
  });

  return database;
}

async function checkSubmerchantProvision(): Promise<void> {
  // A malformed payload is refused before any query.
  const badPayload = provisionSeededDatabase();
  const badRefusal = await rejectionOf(() =>
    runSubmerchantProvisioning(
      { company_id: "nope", kyc_submission_id: APPROVED_SUBMISSION_ID },
      dependenciesOf(badPayload, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(badRefusal?.code, "VALIDATION_FAILED", "a non-uuid company is refused");
  expectEqual(badPayload.queries.length, 0, "with zero queries");

  const unknown = await rejectionOf(() =>
    runSubmerchantProvisioning(
      { company_id: COMPANY_A, kyc_submission_id: "018f2b8a-9999-4c2d-9c3e-999999999999" },
      dependenciesOf(provisionSeededDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknown?.code, "RESOURCE_NOT_FOUND", "an unknown submission is not found");

  // Only an approved submission provisions - 0054's source guard enforces the same at the DB.
  const notApproved = provisionSeededDatabase();
  const refused = await rejectionOf(() =>
    runSubmerchantProvisioning(
      { company_id: COMPANY_B, kyc_submission_id: "018f2b8a-0000-4c2d-9c3e-0000000000b2" },
      dependenciesOf(notApproved, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(refused?.code, "CONFLICT", "a submitted-but-not-approved submission conflicts");
  expectDeepEqual(refused?.details, [{ field: "status", rule: "not_approved" }], "named not_approved");
  expectEqual(
    notApproved.inserts.filter((entry) => entry.table === SUBMERCHANT_PROVISIONS_TABLE).length,
    0,
    "and nothing is provisioned",
  );

  // The run: one pending row per connected sub-merchant provider - nmi with its master account,
  // stripe_connect queued without one. payoneer lacks the capability, airwallex is disabled.
  const database = provisionSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const summary = await runSubmerchantProvisioning(
    { company_id: COMPANY_A, kyc_submission_id: APPROVED_SUBMISSION_ID },
    dependenciesOf(database, audit),
  );

  expectEqual(summary.created, 2, "two providers provision: nmi and stripe_connect");
  expectEqual(summary.skipped, 0, "nothing existed yet");
  expectEqual(summary.queuedWithoutMasterAccount, 1, "stripe_connect has no master account connected, so it stays queued");

  const inserts = database.inserts.filter((entry) => entry.table === SUBMERCHANT_PROVISIONS_TABLE);

  expectEqual(inserts.length, 2, "two provision rows are inserted");
  expect(inserts.every((entry) => entry.row["status"] === "pending"), "both start pending");
  expect(inserts.every((entry) => entry.row["charges_enabled"] === false && entry.row["payouts_enabled"] === false), "charges and payouts stay disabled until verification completes");
  expect(inserts.every((entry) => entry.row["kyc_submission_id"] === APPROVED_SUBMISSION_ID), "each row names the approval");

  const nmiInsert = inserts.find((entry) => entry.row["provider_id"] === NMI_PROVIDER_ID);
  const stripeInsert = inserts.find((entry) => entry.row["provider_id"] === STRIPE_PROVIDER_ID);

  expectEqual(nmiInsert?.row["master_account_ref"], `nmi:${NMI_MASTER_KEY_ID}`, "nmi records the connected master account");
  expectEqual(nmiInsert?.row["next_attempt_at"], new Date(NOW).toISOString(), "and schedules its first attempt");
  expectEqual(nmiInsert?.row["mode"], "test", "in the master key's mode");
  expectEqual(stripeInsert?.row["master_account_ref"], null, "stripe_connect stays queued without a master account");
  expectEqual(stripeInsert?.row["next_attempt_at"], null, "with no attempt scheduled");

  expect(
    database.queries.some((query) => query.startsWith(`${PAYMENT_PROVIDERS_TABLE}?`) && query.includes("company_id=is.null") && query.includes("supports_submerchant=is.true") && query.includes("status=eq.enabled")),
    "the provider read is platform level, sub-merchant capable and enabled",
  );
  expect(
    database.queries.some((query) => query.startsWith(`${PROVIDER_KEYS_TABLE}?`) && query.includes("company_id=is.null") && query.includes("status=eq.active")),
    "the master account read is platform level and active",
  );
  expect(
    database.queries
      .filter((query) => query.startsWith(`${SUBMERCHANT_PROVISIONS_TABLE}?`))
      .every((query) => query.includes(`company_id=eq.${encodeURIComponent(COMPANY_A)}`)),
    "every provision query is scoped to the merchant",
  );

  const queuedAudits = audit.entries.filter((entry) => entry.action === SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION);

  expectEqual(queuedAudits.length, 2, "every created row is audited under submerchant_provision.queued");
  expect(queuedAudits.every((entry) => entry.entityType === SUBMERCHANT_PROVISION_ENTITY), "on the provision entity");
  expect(queuedAudits.every((entry) => entry.entityId !== null), "naming the row");
  expectEqual(
    queuedAudits.find((entry) => entry.payload?.["provider_id"] === STRIPE_PROVIDER_ID)?.payload?.["queued_without_master_account"],
    true,
    "the queued-without-master case is recorded for the office alert",
  );

  // A second run is idempotent: everything exists, nothing new is written or audited.
  const again = await runSubmerchantProvisioning(
    { company_id: COMPANY_A, kyc_submission_id: APPROVED_SUBMISSION_ID },
    dependenciesOf(database, audit),
  );

  expectEqual(again.created, 0, "the second run creates nothing");
  expectEqual(again.skipped, 2, "both rows already exist");
  expectEqual(
    database.inserts.filter((entry) => entry.table === SUBMERCHANT_PROVISIONS_TABLE).length,
    2,
    "no third row is inserted",
  );
  expectEqual(
    audit.entries.filter((entry) => entry.action === SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION).length,
    2,
    "and no second queue audit is appended",
  );

  // A lost insert race with a winner converges on the winner instead of failing.
  const raced = provisionSeededDatabase();
  raced.provisionRows.push({
    id: "018f2b8a-0000-4c2d-9c3e-0000000000f1",
    company_id: COMPANY_A,
    kyc_submission_id: APPROVED_SUBMISSION_ID,
    provider_id: NMI_PROVIDER_ID,
    provider_key: "nmi",
    mode: "test",
    master_account_ref: `nmi:${NMI_MASTER_KEY_ID}`,
    provider_submerchant_id: null,
    status: "pending",
    charges_enabled: false,
    payouts_enabled: false,
    requested_at: "2026-11-02T09:05:00.000Z",
    next_attempt_at: "2026-11-02T09:05:00.000Z",
    version: 1,
    updated_at: "2026-11-02T09:05:00.000Z",
    created_at: "2026-11-02T09:05:00.000Z",
  });
  raced.provisionRows.push({
    id: "018f2b8a-0000-4c2d-9c3e-0000000000f2",
    company_id: COMPANY_A,
    kyc_submission_id: APPROVED_SUBMISSION_ID,
    provider_id: STRIPE_PROVIDER_ID,
    provider_key: "stripe_connect",
    mode: "test",
    master_account_ref: null,
    provider_submerchant_id: null,
    status: "pending",
    charges_enabled: false,
    payouts_enabled: false,
    requested_at: "2026-11-02T09:05:00.000Z",
    next_attempt_at: null,
    version: 1,
    updated_at: "2026-11-02T09:05:00.000Z",
    created_at: "2026-11-02T09:05:00.000Z",
  });
  const racedSummary = await runSubmerchantProvisioning(
    { company_id: COMPANY_A, kyc_submission_id: APPROVED_SUBMISSION_ID },
    dependenciesOf(raced, createInMemoryAuditTrail()),
  );

  expectEqual(racedSummary.created, 0, "a run over existing rows creates nothing");
  expectEqual(racedSummary.skipped, 2, "both rows are the winners");

  // The job machinery: registration once, idempotent enqueue, and the handler creates the rows.
  const registry = new JobRegistry();
  const queue = createInMemoryJobQueue();

  registerSubmerchantProvisionJob(registry);

  expectEqual(registry.has(SUBMERCHANT_PROVISION_JOB), true, "the provision job is registered");
  expectEqual(registry.size, 1, "one job");
  registerSubmerchantProvisionJob(registry);
  expectEqual(registry.size, 1, "registering twice is a no-op");

  const first = await enqueueProvisioningAfterApproval(
    { registry, queue },
    { companyId: COMPANY_A, kycSubmissionId: APPROVED_SUBMISSION_ID },
  );

  expectEqual(first.job.name, SUBMERCHANT_PROVISION_JOB, "the enqueued job is the provision job");
  expectEqual(first.job.status, "pending", "it waits in the queue");
  expectEqual(first.deduplicated, false, "the first enqueue is not a duplicate");
  expectEqual(
    first.job.idempotencyKey,
    provisionJobIdempotencyKey(COMPANY_A, APPROVED_SUBMISSION_ID),
    "keyed by merchant and submission",
  );

  const second = await enqueueProvisioningAfterApproval(
    { registry, queue },
    { companyId: COMPANY_A, kycSubmissionId: APPROVED_SUBMISSION_ID },
  );

  expectEqual(second.deduplicated, true, "a retried enqueue returns the first job");
  expectEqual(second.job.id, first.job.id, "the same job");

  const badEnqueue = await rejectionOf(() =>
    enqueueProvisioningAfterApproval({ registry, queue }, { companyId: "nope", kycSubmissionId: APPROVED_SUBMISSION_ID }),
  );

  expectEqual(badEnqueue?.code, "VALIDATION_FAILED", "a malformed enqueue payload is refused at the call site");

  let boundaryThrew = false;

  try {
    registry.get(SUBMERCHANT_PROVISION_JOB).parsePayload({ company_id: "nope" });
  } catch {
    boundaryThrew = true;
  }

  expectEqual(boundaryThrew, true, "the registry validates the payload again before the handler runs");

  // The handler itself, driven against the fake store through the injectable definition.
  const jobDatabase = provisionSeededDatabase();
  const jobAudit = createInMemoryAuditTrail();
  const definition = createProvisionJobHandler(() => ({
    rest: createBusinessStore(jobDatabase),
    audit: jobAudit,
    now: () => NOW,
  }));

  await definition.handler({
    jobId: "018f2b8a-0000-4c2d-9c3e-00000000job1",
    name: SUBMERCHANT_PROVISION_JOB,
    attempt: 1,
    maxAttempts: 5,
    traceId: "trace-1",
    payload: { company_id: COMPANY_A, kyc_submission_id: APPROVED_SUBMISSION_ID },
    signal: new AbortController().signal,
  });

  expectEqual(jobDatabase.provisionRows.length, 2, "the job handler created the two provision rows");
  expectEqual(
    jobAudit.entries.filter((entry) => entry.action === SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION).length,
    2,
    "and audited both",
  );
}

/** ---- STEP 094 sources: the provision service, the enqueue hook in the decide route. */
async function checkSubmerchantProvisionSources(): Promise<void> {
  const provision = await readRepositoryFile("services/submerchant/provision.ts");
  const decideRoute = await readRepositoryFile("app/api/onboarding/kyc-decide/route.ts");

  expectEqual(provision.split("\n")[0], "// path: services/submerchant/provision.ts", "the provision service states its own path on its first line");
  expectEqual(/[^\t\n\r\x20-\x7E]/u.test(provision), false, "the provision service is ASCII only");

  expect(provision.includes('SUBMERCHANT_PROVISIONS_TABLE = "submerchant_provisions"'), "the service names the 0054 table");
  expect(provision.includes('PAYMENT_PROVIDERS_TABLE = "payment_providers"'), "and the 0029 catalogue");
  expect(provision.includes('PROVIDER_KEYS_TABLE = "provider_keys"'), "and the 0030 keys");
  expect(provision.includes('SUBMERCHANT_PROVISION_JOB = "submerchant.provision"'), "and the job name");
  expect(provision.includes('SUBMERCHANT_PROVISION_QUEUED_AUDIT_ACTION = "submerchant_provision.queued"'), "and the queue audit action");
  expect(provision.includes("company_id=is.null"), "the master accounts are the platform level rows");
  expect(provision.includes("supports_submerchant=is.true"), "only sub-merchant capable providers provision");
  expect(provision.includes("status=eq.active"), "an active key means a connected master account");
  expect(provision.includes("not_approved"), "only an approved submission provisions");
  expect(provision.includes("charges_enabled: false"), "charges stay disabled");
  expect(provision.includes("payouts_enabled: false"), "and payouts too, until verification completes");
  expect(provision.includes("idempotencyKey"), "the enqueue is idempotent per merchant and submission");
  expect(provision.includes('error.code === "CONFLICT"'), "a lost insert race converges on the winner's row");

  expect(decideRoute.includes("enqueueProvisioningAfterApproval("), "the decide route enqueues provisioning");
  expect(decideRoute.includes("getJobRuntime("), "through the process-wide job runtime");
  expect(decideRoute.includes('detail.status === "approved"'), "only an approval triggers it");
  expect(decideRoute.includes("logger.error("), "and an enqueue failure is logged, never fatal to the decision");

  expect(
    (await readdir(new URL("services/submerchant/", repositoryRoot))).includes("provision.ts"),
    "the provision service lives in services/submerchant",
  );
}

/** ---- STEP 095: the verified-webhook sync of the provision rows. */
const PROV_ID = "018f2b8a-0000-4c2d-9c3e-000000000031";
const EVENT_VERIFIED = "018f2b8a-0000-4c2d-9c3e-000000000041";
const EVENT_PENDING = "018f2b8a-0000-4c2d-9c3e-000000000042";
const EVENT_UNSIGNED = "018f2b8a-0000-4c2d-9c3e-000000000043";
const EVENT_UNRESOLVED = "018f2b8a-0000-4c2d-9c3e-000000000044";
const EVENT_OTHER_TYPE = "018f2b8a-0000-4c2d-9c3e-000000000045";
const EVENT_ACTION = "018f2b8a-0000-4c2d-9c3e-000000000046";
const EVENT_REJECTED = "018f2b8a-0000-4c2d-9c3e-000000000047";
const EVENT_RESTRICTED = "018f2b8a-0000-4c2d-9c3e-000000000048";

/** A provision-seeded database with one pending nmi provision row on top. */
function syncSeededDatabase(provisionStatus = "pending"): BusinessDatabase {
  const database = provisionSeededDatabase();

  database.provisionRows.push({
    id: PROV_ID,
    company_id: COMPANY_A,
    kyc_submission_id: APPROVED_SUBMISSION_ID,
    provider_id: NMI_PROVIDER_ID,
    provider_key: "nmi",
    mode: "test",
    master_account_ref: `nmi:${NMI_MASTER_KEY_ID}`,
    provider_submerchant_id: null,
    status: provisionStatus,
    charges_enabled: provisionStatus === "verified",
    payouts_enabled: provisionStatus === "verified",
    requested_at: "2026-11-02T09:05:00.000Z",
    next_attempt_at: "2026-11-02T09:05:00.000Z",
    verified_at: provisionStatus === "verified" || provisionStatus === "restricted" ? "2026-11-02T10:00:00.000Z" : null,
    version: 1,
    updated_at: "2026-11-02T09:05:00.000Z",
    created_at: "2026-11-02T09:05:00.000Z",
  });

  return database;
}

function webhookEventOf(
  database: BusinessDatabase,
  overrides: Partial<WebhookEventRowShape>,
): void {
  database.webhookRows.push({
    id: EVENT_VERIFIED,
    company_id: COMPANY_A,
    provider_id: NMI_PROVIDER_ID,
    mode: "test",
    external_event_id: "evt_1",
    event_type: "submerchant.verified",
    payload_hash: "a".repeat(64),
    signature_ok: true,
    received_at: "2026-11-02T10:30:00.000Z",
    status: "processed",
    processed_at: "2026-11-02T10:30:05.000Z",
    failure_detail: null,
    version: 1,
    updated_at: "2026-11-02T10:30:05.000Z",
    created_at: "2026-11-02T10:30:00.000Z",
    ...overrides,
  });
}

async function checkSubmerchantSync(): Promise<void> {
  expectDeepEqual(
    { ...PROVISION_SYNC_EVENT_TYPES },
    {
      "submerchant.verified": "verified",
      "submerchant.action_required": "action_required",
      "submerchant.rejected": "rejected",
      "submerchant.restricted": "restricted",
    },
    "the provider event types map to the provision statuses of 0054",
  );

  // A malformed payload is refused before any query.
  const badPayload = syncSeededDatabase();
  const badRefusal = await rejectionOf(() =>
    syncProvisionFromWebhook({ webhook_event_id: "nope" }, dependenciesOf(badPayload, createInMemoryAuditTrail())),
  );

  expectEqual(badRefusal?.code, "VALIDATION_FAILED", "a non-uuid event id is refused");
  expectEqual(badPayload.queries.length, 0, "with zero queries");

  const unknown = await rejectionOf(() =>
    syncProvisionFromWebhook(
      { webhook_event_id: "018f2b8a-9999-4c2d-9c3e-999999999999" },
      dependenciesOf(syncSeededDatabase(), createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknown?.code, "RESOURCE_NOT_FOUND", "an unknown event is not found");

  // Only a processed event syncs; an unverified one never does; an unresolved merchant cannot.
  for (const [description, eventId, rule] of [
    ["a pending event", EVENT_PENDING, "not_processed"],
    ["an unsigned event", EVENT_UNSIGNED, "signature_unverified"],
    ["an event whose merchant never resolved", EVENT_UNRESOLVED, "merchant_unresolved"],
  ] as const) {
    const database = syncSeededDatabase();

    webhookEventOf(database, {
      id: eventId,
      status: eventId === EVENT_PENDING ? "pending" : "processed",
      processed_at: eventId === EVENT_PENDING ? null : "2026-11-02T10:30:05.000Z",
      signature_ok: eventId !== EVENT_UNSIGNED,
      company_id: eventId === EVENT_UNRESOLVED ? null : COMPANY_A,
    });

    const refusal = await rejectionOf(() =>
      syncProvisionFromWebhook({ webhook_event_id: eventId }, dependenciesOf(database, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "CONFLICT", `${description} conflicts`);
    expectDeepEqual(refusal?.details, [{ field: eventId === EVENT_UNRESOLVED ? "company_id" : eventId === EVENT_UNSIGNED ? "signature" : "status", rule }], `named ${rule}`);
    expectEqual(database.updates.length, 0, `and writes nothing for ${description}`);
  }

  // No provision row at the event's provider and merchant.
  const noRow = syncSeededDatabase();
  noRow.provisionRows.length = 0;
  webhookEventOf(noRow, { id: EVENT_VERIFIED });
  const missing = await rejectionOf(() =>
    syncProvisionFromWebhook({ webhook_event_id: EVENT_VERIFIED }, dependenciesOf(noRow, createInMemoryAuditTrail())),
  );

  expectEqual(missing?.code, "RESOURCE_NOT_FOUND", "an event with no provision row is not found");

  // The verified event on a pending row: the walk lands, charges and payouts enable, the sync is
  // recorded and audited.
  const database = syncSeededDatabase();
  const audit = createInMemoryAuditTrail();

  webhookEventOf(database, { id: EVENT_VERIFIED });

  const synced = await syncProvisionFromWebhook(
    { webhook_event_id: EVENT_VERIFIED },
    dependenciesOf(database, audit),
  );
  const row = database.provisionRows.find((entry) => entry.id === PROV_ID);

  expectEqual(synced.applied, true, "the sync is applied");
  expectEqual(synced.fromStatus, "pending", "from pending");
  expectEqual(synced.toStatus, "verified", "to verified");
  expectEqual(synced.version, 2, "version bumped");
  expectEqual(row?.status, "verified", "the row is verified");
  expectEqual(row?.charges_enabled, true, "charges enable once verification completes");
  expectEqual(row?.payouts_enabled, true, "and payouts too");
  expectEqual(row?.["verified_at"], new Date(NOW).toISOString(), "verified at the sync instant");
  expectEqual(row?.["last_webhook_event_id"], EVENT_VERIFIED, "the row names the event that synced it");
  expectEqual(row?.["last_synced_at"], new Date(NOW).toISOString(), "and when");

  const update = database.updates.find((entry) => entry.table === SUBMERCHANT_PROVISIONS_TABLE);

  expect(
    update !== undefined &&
      update.query.includes(`id=eq.${PROV_ID}`) &&
      update.query.includes(`company_id=eq.${encodeURIComponent(COMPANY_A)}`) &&
      update.query.includes("version=eq.1") &&
      update.query.includes("deleted_at=is.null"),
    "the sync update is conditional on id, company, version and live rows",
  );
  expectEqual(update?.values["last_webhook_event_id"], EVENT_VERIFIED, "recording the evidence event");
  expectEqual(update?.values["version"], 2, "with the version bumped");
  expectEqual(
    audit.entries.filter((entry) => entry.action === SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION).length,
    1,
    "the sync is audited under submerchant_provision.synced",
  );
  expectEqual(
    audit.entries.find((entry) => entry.action === SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION)?.payload?.["to_status"],
    "verified",
    "with the walked status in the payload",
  );
  expectEqual(
    audit.entries.find((entry) => entry.action === SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION)?.entityId,
    PROV_ID,
    "against the provision row",
  );

  // Re-delivery of the same event changes nothing.
  const again = await syncProvisionFromWebhook(
    { webhook_event_id: EVENT_VERIFIED },
    dependenciesOf(database, audit),
  );

  expectEqual(again.applied, false, "a re-delivered event is answered as already synced");
  expectEqual(
    database.updates.filter((entry) => entry.table === SUBMERCHANT_PROVISIONS_TABLE).length,
    1,
    "with no second write",
  );

  // An event type outside the provision vocabulary only records the sync, status unchanged.
  const otherDb = syncSeededDatabase();
  webhookEventOf(otherDb, { id: EVENT_OTHER_TYPE, event_type: "payment.succeeded", external_event_id: "evt_9" });
  const other = await syncProvisionFromWebhook(
    { webhook_event_id: EVENT_OTHER_TYPE },
    dependenciesOf(otherDb, createInMemoryAuditTrail()),
  );

  expectEqual(other.applied, true, "the sync is still recorded");
  expectEqual(other.toStatus, "pending", "but the status does not move");
  expectEqual(
    otherDb.provisionRows.find((entry) => entry.id === PROV_ID)?.["last_webhook_event_id"],
    EVENT_OTHER_TYPE,
    "the row names the event",
  );

  // The rest of the walk: action_required carries its detail, rejected its reason and instant.
  const actionDb = syncSeededDatabase();
  webhookEventOf(actionDb, { id: EVENT_ACTION, event_type: "submerchant.action_required", external_event_id: "evt_2" });
  const action = await syncProvisionFromWebhook(
    { webhook_event_id: EVENT_ACTION },
    dependenciesOf(actionDb, createInMemoryAuditTrail()),
  );

  expectEqual(action.toStatus, "action_required", "pending walks to action_required");
  expectEqual(
    actionDb.provisionRows.find((entry) => entry.id === PROV_ID)?.["action_required_detail"],
    "provider event submerchant.action_required evt_2",
    "with the provider event as the detail",
  );

  const rejectDb = syncSeededDatabase("action_required");
  webhookEventOf(rejectDb, { id: EVENT_REJECTED, event_type: "submerchant.rejected", external_event_id: "evt_3" });
  const rejected = await syncProvisionFromWebhook(
    { webhook_event_id: EVENT_REJECTED },
    dependenciesOf(rejectDb, createInMemoryAuditTrail()),
  );

  expectEqual(rejected.toStatus, "rejected", "action_required walks to rejected");
  expectEqual(
    rejectDb.provisionRows.find((entry) => entry.id === PROV_ID)?.["rejection_reason"],
    "provider event submerchant.rejected evt_3",
    "with the reason 0054 demands on a rejection",
  );
  expectEqual(
    rejectDb.provisionRows.find((entry) => entry.id === PROV_ID)?.["rejected_at"],
    new Date(NOW).toISOString(),
    "and the rejection instant",
  );

  // Verified walks to restricted, which takes the money flags back off.
  const restrictDb = syncSeededDatabase("verified");
  webhookEventOf(restrictDb, { id: EVENT_RESTRICTED, event_type: "submerchant.restricted", external_event_id: "evt_4" });
  const restricted = await syncProvisionFromWebhook(
    { webhook_event_id: EVENT_RESTRICTED },
    dependenciesOf(restrictDb, createInMemoryAuditTrail()),
  );
  const restrictedRow = restrictDb.provisionRows.find((entry) => entry.id === PROV_ID);

  expectEqual(restricted.toStatus, "restricted", "verified walks to restricted");
  expectEqual(restrictedRow?.charges_enabled, false, "a restricted sub-merchant takes no charges");
  expectEqual(restrictedRow?.payouts_enabled, false, "and pays out nothing");
  expectEqual(restrictedRow?.["restricted_at"], new Date(NOW).toISOString(), "with the restriction instant");
  expectEqual(restrictedRow?.["verified_at"], "2026-11-02T10:00:00.000Z", "keeping its verification instant");

  // The impossible walks conflict before any write, exactly as 0054's state guard demands.
  for (const [description, fromStatus, eventId, eventType, rule] of [
    ["restricted from pending", "pending", EVENT_RESTRICTED, "submerchant.restricted", "invalid_transition"],
    ["verified on a rejected row", "rejected", EVENT_VERIFIED, "submerchant.verified", "locked"],
  ] as const) {
    const walkDb = syncSeededDatabase(fromStatus);

    webhookEventOf(walkDb, { id: eventId, event_type: eventType });

    const refusal = await rejectionOf(() =>
      syncProvisionFromWebhook({ webhook_event_id: eventId }, dependenciesOf(walkDb, createInMemoryAuditTrail())),
    );

    expectEqual(refusal?.code, "CONFLICT", `${description} conflicts`);
    expectDeepEqual(refusal?.details, [{ field: "status", rule }], `named ${rule}`);
    expectEqual(walkDb.updates.length, 0, `and writes nothing for ${description}`);
  }

  // A lost race on the sync write conflicts as stale, without an audit entry.
  const raceDb = syncSeededDatabase();
  raceDb.provisionRace = true;
  webhookEventOf(raceDb, { id: EVENT_VERIFIED });
  const raceAudit = createInMemoryAuditTrail();
  const stale = await rejectionOf(() =>
    syncProvisionFromWebhook({ webhook_event_id: EVENT_VERIFIED }, dependenciesOf(raceDb, raceAudit)),
  );

  expectEqual(stale?.code, "CONFLICT", "a lost sync race conflicts");
  expectDeepEqual(stale?.details, [{ field: "version", rule: "stale" }], "named stale");
  expectEqual(
    raceAudit.entries.filter((entry) => entry.action === SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION).length,
    0,
    "and a lost race is not audited as synced",
  );

  // The job machinery: both sub-merchant jobs register once, the enqueue is idempotent per event,
  // and the handler applies the sync against the fake store.
  const registry = new JobRegistry();
  const queue = createInMemoryJobQueue();

  registerSubmerchantJobs(registry);

  expectEqual(registry.size, 3, "provision, sync and token deletion are registered");
  expectEqual(registry.has(SUBMERCHANT_PROVISION_JOB), true, "the provision job of STEP 094");
  expectEqual(registry.has(SUBMERCHANT_SYNC_JOB), true, "the sync job of this STEP");
  registerSubmerchantJobs(registry);
  expectEqual(registry.size, 3, "registering twice is a no-op");

  const jobDatabase = syncSeededDatabase();
  webhookEventOf(jobDatabase, { id: EVENT_VERIFIED });

  const first = await enqueueProvisionSync({ registry, queue }, { webhookEventId: EVENT_VERIFIED });

  expectEqual(first.job.name, SUBMERCHANT_SYNC_JOB, "the enqueued job is the sync job");
  expectEqual(first.deduplicated, false, "the first enqueue is not a duplicate");
  expectEqual(first.job.idempotencyKey, syncJobIdempotencyKey(EVENT_VERIFIED), "keyed by the event");

  const second = await enqueueProvisionSync({ registry, queue }, { webhookEventId: EVENT_VERIFIED });

  expectEqual(second.deduplicated, true, "a re-delivery returns the first job");
  expectEqual(second.job.id, first.job.id, "the same job");

  const badEnqueue = await rejectionOf(() =>
    enqueueProvisionSync({ registry, queue }, { webhookEventId: "nope" }),
  );

  expectEqual(badEnqueue?.code, "VALIDATION_FAILED", "a malformed event id is refused at the call site");

  const definition = createSyncJobHandler(() => ({
    rest: createBusinessStore(jobDatabase),
    audit: createInMemoryAuditTrail(),
    now: () => NOW,
  }));

  await definition.handler({
    jobId: "018f2b8a-0000-4c2d-9c3e-00000000job2",
    name: SUBMERCHANT_SYNC_JOB,
    attempt: 1,
    maxAttempts: 5,
    traceId: "trace-2",
    payload: { webhook_event_id: EVENT_VERIFIED },
    signal: new AbortController().signal,
  });

  expectEqual(
    jobDatabase.provisionRows.find((entry) => entry.id === PROV_ID)?.status,
    "verified",
    "the job handler applied the verified event",
  );
}

/** ---- STEP 095 sources: the sync service and its job. */
async function checkSubmerchantSyncSources(): Promise<void> {
  const sync = await readRepositoryFile("services/submerchant/provision-sync.ts");

  expectEqual(sync.split("\n")[0], "// path: services/submerchant/provision-sync.ts", "the sync service states its own path on its first line");
  expectEqual(/[^\t\n\r\x20-\x7E]/u.test(sync), false, "the sync service is ASCII only");

  expect(sync.includes('WEBHOOK_EVENTS_TABLE = "webhook_events"'), "the service names the 0032 table");
  expect(sync.includes('SUBMERCHANT_SYNC_JOB = "submerchant.sync"'), "and the sync job name");
  expect(sync.includes('SUBMERCHANT_PROVISION_SYNCED_AUDIT_ACTION = "submerchant_provision.synced"'), "and the sync audit action");
  expect(sync.includes("not_processed"), "an unprocessed event never syncs");
  expect(sync.includes("signature_unverified"), "and an unverified one never does either");
  expect(sync.includes("merchant_unresolved"), "an event without its merchant conflicts");
  expect(sync.includes("invalid_transition"), "the status walk is enforced before the write");
  expect(sync.includes('"locked"'), "a closed row is history");
  expect(sync.includes("last_webhook_event_id"), "the row records the evidence event");
  expect(sync.includes('values["charges_enabled"] = true'), "verification enables charges");
  expect(sync.includes('values["payouts_enabled"] = true'), "and payouts");
  expect(sync.includes('values["charges_enabled"] = false'), "a restriction disables them again");
  expect(sync.includes("version=eq."), "the sync write is conditional on the current version");
  expect(sync.includes("idempotencyKey"), "the enqueue is idempotent per event");
  expect(sync.includes("registerSubmerchantJobs"), "both sub-merchant jobs register through one call");

  expect(
    (await readdir(new URL("services/submerchant/", repositoryRoot))).includes("provision-sync.ts"),
    "the sync service lives in services/submerchant beside the provision service",
  );
}

/** ---- STEP 097: the extra document a processor asks for. */
const DRAFT_SUBMISSION_ID = "018f2b8a-0000-4c2d-9c3e-0000000000d1";
const OTHER_SUBMISSION_ID = "018f2b8a-0000-4c2d-9c3e-0000000000d2";
const REQUEST_ID = "018f2b8a-0000-4c2d-9c3e-000000000051";
const UNKNOWN_COMPANY_ID = "018f2b8a-4444-4c2d-9c3e-000000000099";

function requestSeededDatabase(overrides: Partial<DocumentRequestRowShape> = {}): BusinessDatabase {
  const database = createBusinessDatabase();

  database.submissionRows.push({
    id: DRAFT_SUBMISSION_ID,
    company_id: COMPANY_A,
    status: "draft",
    verification_method: "manual",
    created_at: "2026-11-02T09:00:00.000Z",
  });

  database.requestRows.push({
    id: REQUEST_ID,
    company_id: COMPANY_A,
    submission_id: DRAFT_SUBMISSION_ID,
    provider_id: "nmi",
    document_label: "Signed merchant agreement",
    note: "The countersigned copy, please.",
    status: "open",
    version: 1,
    created_at: "2026-11-02T09:10:00.000Z",
    ...overrides,
  });

  return database;
}

async function checkDocumentRequests(): Promise<void> {
  expectEqual(KYC_DOCUMENT_REQUESTS_TABLE, "kyc_document_requests", "the request table of 0109");
  expectEqual(KYC_DOCUMENT_REQUEST_JOB, "kyc.document_request", "the request job name");
  expectEqual(KYC_DOCUMENT_REQUEST_ENTITY, "kyc_document_request", "the request audit entity");

  const database = requestSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const dependencies = dependenciesOf(database, audit);

  const queriesBefore = database.queries.length;

  const badCompany = await rejectionOf(() =>
    createDocumentRequest({ company_id: "not-a-uuid", provider_id: "nmi", document_label: "x" }, dependencies),
  );

  expectEqual(badCompany?.code, "VALIDATION_FAILED", "a malformed company id is refused at the call site");
  expectEqual(database.queries.length, queriesBefore, "before any query runs");

  const badProvider = await rejectionOf(() =>
    createDocumentRequest({ company_id: COMPANY_A, provider_id: "not-a-provider", document_label: "x" }, dependencies),
  );

  expectEqual(badProvider?.code, "VALIDATION_FAILED", "a provider outside the registry vocabulary is refused");

  const badLabel = await rejectionOf(() =>
    createDocumentRequest(
      { company_id: COMPANY_A, provider_id: "nmi", document_label: `${"y".repeat(121)}` },
      dependencies,
    ),
  );

  expectEqual(badLabel?.code, "VALIDATION_FAILED", "a label over 120 characters is refused");

  const unknownCompany = await rejectionOf(() =>
    createDocumentRequest(
      { company_id: UNKNOWN_COMPANY_ID, provider_id: "nmi", document_label: "Bank statement addendum" },
      dependencies,
    ),
  );

  expectEqual(unknownCompany?.code, "RESOURCE_NOT_FOUND", "an ask for a company that does not exist is 404");
  expectEqual(
    database.inserts.filter((insert) => insert.table === KYC_DOCUMENT_REQUESTS_TABLE).length,
    0,
    "and writes nothing",
  );

  const created = await createDocumentRequest(
    { company_id: COMPANY_A, provider_id: "nmi", document_label: "Bank statement addendum", note: "Last three months, please." },
    dependencies,
  );

  expectEqual(created.created, true, "the first ask for a label creates the row");
  expectEqual(created.request.status, "open", "the ask starts open");
  expectEqual(created.request.documentLabel, "Bank statement addendum", "carrying the provider's own words");
  expectEqual(created.request.note, "Last three months, please.", "and its note");
  expectEqual(created.request.providerId, "nmi", "and the asking provider");
  expectEqual(created.request.submissionId, DRAFT_SUBMISSION_ID, "the ask hangs off the draft submission");

  const insert = database.inserts.find((entry) => entry.table === KYC_DOCUMENT_REQUESTS_TABLE);

  expectEqual(insert?.row["status"], "open", "the insert writes it open");
  expectEqual(insert?.row["submission_id"], DRAFT_SUBMISSION_ID, "on the seeded draft submission");
  expectEqual(database.submissionRows.length, 1, "the draft is reused, not recreated");
  expectEqual(audit.entries.length, 1, "one audit entry for the ask");
  expectEqual(audit.entries[0]?.action, KYC_DOCUMENT_REQUEST_CREATED_AUDIT_ACTION, "under kyc_document_request.created");
  expectEqual(audit.entries[0]?.actorUserId, null, "a provider ask carries no session actor");
  expectEqual(audit.entries[0]?.entityType, KYC_DOCUMENT_REQUEST_ENTITY, "on the request entity");
  expectEqual(audit.entries[0]?.entityId, created.request.id, "naming the row");

  const again = await createDocumentRequest(
    { company_id: COMPANY_A, provider_id: "nmi", document_label: "Bank statement addendum" },
    dependencies,
  );

  expectEqual(again.created, false, "the same ask delivered again answers with the existing row");
  expectEqual(again.request.id, created.request.id, "the same row");
  expectEqual(
    database.inserts.filter((entry) => entry.table === KYC_DOCUMENT_REQUESTS_TABLE).length,
    1,
    "no second insert",
  );
  expectEqual(audit.entries.length, 1, "and no second audit");

  const raceDatabase = requestSeededDatabase();
  const raceAudit = createInMemoryAuditTrail();

  raceDatabase.requestInsertConflict = true;

  const raced = await createDocumentRequest(
    { company_id: COMPANY_A, provider_id: "nmi", document_label: "Bank statement addendum" },
    dependenciesOf(raceDatabase, raceAudit),
  );

  expectEqual(raced.created, false, "a lost insert race converges on the winner's row");
  expectEqual(raced.request.documentLabel, "Bank statement addendum", "the winner's label");
  expectEqual(raceAudit.entries.length, 0, "and is not audited as a new ask");

  const packDatabase = requestSeededDatabase();
  const pack = await readKycPack({ actor: owner }, dependenciesOf(packDatabase, createInMemoryAuditTrail()));

  expectEqual(pack.openRequests.length, 1, "the pack lists the open ask");
  expectEqual(pack.openRequests[0]?.id, REQUEST_ID, "by id");
  expectEqual(pack.openRequests[0]?.documentLabel, "Signed merchant agreement", "with its label");
  expectEqual(pack.openRequests[0]?.note, "The countersigned copy, please.", "and its note");
  expect(
    packDatabase.queries.some(
      (query) => query.startsWith(`${KYC_DOCUMENT_REQUESTS_TABLE}?`) && query.includes("status=eq.open"),
    ),
    "the pack reads only open requests over live rows",
  );

  const uploadDatabase = requestSeededDatabase();
  const uploadAudit = createInMemoryAuditTrail();
  const saved = await saveKycDocument(
    {
      actor: owner,
      input: pngDocumentInput({
        document_type: "processor_request",
        request_id: REQUEST_ID,
        file_name: "agreement.pdf",
        declared_content_type: "application/pdf",
        bytes: PDF_BYTES,
      }),
    },
    dependenciesOf(uploadDatabase, uploadAudit),
  );
  const requestRow = uploadDatabase.requestRows.find((row) => row.id === REQUEST_ID);

  expectEqual(uploadDatabase.documentRows[0]?.document_type, "processor_request", "the answer is a processor_request document");
  expectEqual(requestRow?.status, "fulfilled", "the ask is fulfilled by the upload");
  expectEqual(requestRow?.fulfilled_by, uploadDatabase.documentRows[0]?.id, "naming the document row");
  expectEqual(requestRow?.fulfilled_at !== null && requestRow?.fulfilled_at !== undefined, true, "with its instant");
  expectEqual(requestRow?.version, 2, "and the version bumped");

  const requestUpdate = uploadDatabase.updates.find((entry) => entry.table === KYC_DOCUMENT_REQUESTS_TABLE);

  expect(
    requestUpdate !== undefined &&
      requestUpdate.query.includes("status=eq.open") &&
      requestUpdate.query.includes("version=eq.1") &&
      requestUpdate.query.includes("deleted_at=is.null"),
    "the fulfill write is conditional on open, the current version and a live row",
  );
  expectEqual(saved.openRequests.length, 0, "and the pack no longer lists the ask");
  expectEqual(saved.documents.length, 1, "the document itself is listed");
  expectEqual(uploadAudit.entries.length, 2, "the upload and the fulfill are both audited");
  expectEqual(uploadAudit.entries[0]?.action, KYC_DOCUMENT_AUDIT_ACTION, "the upload first");
  expectEqual(uploadAudit.entries[0]?.payload?.["request_id"], REQUEST_ID, "naming the request it answered");
  expectEqual(uploadAudit.entries[1]?.action, KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION, "then the fulfill");
  expectEqual(uploadAudit.entries[1]?.entityId, REQUEST_ID, "on the request entity");
  expectEqual(uploadAudit.entries[1]?.payload?.["document_id"], uploadDatabase.documentRows[0]?.id, "naming the document");

  const wrongTypeDatabase = requestSeededDatabase();
  const wrongType = await rejectionOf(() =>
    saveKycDocument(
      { actor: owner, input: pngDocumentInput({ document_type: "identity_document", request_id: REQUEST_ID }) },
      dependenciesOf(wrongTypeDatabase, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(wrongType?.code, "VALIDATION_FAILED", "another document type cannot answer a request");
  expectDeepEqual(
    wrongType?.details,
    [{ field: "document_type", rule: "request_document_type" }],
    "named request_document_type",
  );
  expectEqual(wrongTypeDatabase.documentRows.length, 0, "and no document is written");

  const badIdDatabase = requestSeededDatabase();
  const badId = await rejectionOf(() =>
    saveKycDocument(
      { actor: owner, input: pngDocumentInput({ document_type: "processor_request", request_id: "nope" }) },
      dependenciesOf(badIdDatabase, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(badId?.code, "VALIDATION_FAILED", "a malformed request id is refused");
  expectDeepEqual(badId?.details, [{ field: "request_id", rule: "invalid_format" }], "named invalid_format");

  const unknownRequestDatabase = requestSeededDatabase();
  const unknownRequest = await rejectionOf(() =>
    saveKycDocument(
      {
        actor: owner,
        input: pngDocumentInput({
          document_type: "processor_request",
          request_id: "018f2b8a-0000-4c2d-9c3e-000000000099",
        }),
      },
      dependenciesOf(unknownRequestDatabase, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(unknownRequest?.code, "RESOURCE_NOT_FOUND", "an unknown request id is 404");
  expectEqual(unknownRequestDatabase.documentRows.length, 0, "and no document is written");

  const closedDatabase = requestSeededDatabase({
    status: "fulfilled",
    fulfilled_by: "018f2b8a-0000-4c2d-9c3e-000000000050",
    fulfilled_at: "2026-11-02T10:00:00.000Z",
    version: 2,
  });
  const closed = await rejectionOf(() =>
    saveKycDocument(
      { actor: owner, input: pngDocumentInput({ document_type: "processor_request", request_id: REQUEST_ID }) },
      dependenciesOf(closedDatabase, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(closed?.code, "CONFLICT", "an already answered ask conflicts");
  expectDeepEqual(closed?.details, [{ field: "request_id", rule: "not_open" }], "with not_open");
  expectEqual(closedDatabase.documentRows.length, 0, "and nothing is written");

  const mismatchDatabase = requestSeededDatabase({ submission_id: OTHER_SUBMISSION_ID });
  const mismatch = await rejectionOf(() =>
    saveKycDocument(
      { actor: owner, input: pngDocumentInput({ document_type: "processor_request", request_id: REQUEST_ID }) },
      dependenciesOf(mismatchDatabase, createInMemoryAuditTrail()),
    ),
  );

  expectEqual(mismatch?.code, "CONFLICT", "an ask of another submission conflicts");
  expectDeepEqual(mismatch?.details, [{ field: "request_id", rule: "submission_mismatch" }], "with submission_mismatch");

  const staleDatabase = requestSeededDatabase();
  const staleAudit = createInMemoryAuditTrail();

  staleDatabase.requestRace = true;

  const stale = await rejectionOf(() =>
    saveKycDocument(
      { actor: owner, input: pngDocumentInput({ document_type: "processor_request", request_id: REQUEST_ID }) },
      dependenciesOf(staleDatabase, staleAudit),
    ),
  );

  expectEqual(stale?.code, "CONFLICT", "a lost race on the fulfill write conflicts");
  expectDeepEqual(stale?.details, [{ field: "version", rule: "stale" }], "with stale");
  expectEqual(staleDatabase.requestRows[0]?.status, "open", "the ask stays open");
  expectEqual(
    staleAudit.entries.filter((entry) => entry.action === KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION).length,
    0,
    "and is not audited as fulfilled",
  );

  const registry = new JobRegistry();

  registerKycDocumentRequestJob(registry);
  expectEqual(registry.size, 1, "the request job registers once");
  registerKycDocumentRequestJob(registry);
  expectEqual(registry.size, 1, "and a second register is a no-op");

  const queue = createInMemoryJobQueue();
  const first = await enqueueDocumentRequest(
    { registry, queue },
    { company_id: COMPANY_A, provider_id: "nmi", document_label: "Bank statement addendum" },
  );

  expectEqual(first.job.name, KYC_DOCUMENT_REQUEST_JOB, "the enqueued job is the request job");
  expectEqual(first.deduplicated, false, "the first enqueue is not a duplicate");
  expectEqual(
    first.job.idempotencyKey,
    documentRequestIdempotencyKey(COMPANY_A, "nmi", "Bank statement addendum"),
    "keyed by merchant, provider and label",
  );

  const second = await enqueueDocumentRequest(
    { registry, queue },
    { company_id: COMPANY_A, provider_id: "nmi", document_label: "Bank statement addendum" },
  );

  expectEqual(second.deduplicated, true, "a repeated delivery returns the first job");
  expectEqual(second.job.id, first.job.id, "the same job");

  const badEnqueue = await rejectionOf(() =>
    enqueueDocumentRequest({ registry, queue }, { company_id: COMPANY_A, provider_id: "nope", document_label: "x" }),
  );

  expectEqual(badEnqueue?.code, "VALIDATION_FAILED", "a malformed ask is refused at the call site");

  const jobDatabase = requestSeededDatabase();
  const definition = createDocumentRequestJobHandler(() => dependenciesOf(jobDatabase, createInMemoryAuditTrail()));

  await definition.handler({
    jobId: "018f2b8a-0000-4c2d-9c3e-00000000job3",
    name: KYC_DOCUMENT_REQUEST_JOB,
    attempt: 1,
    maxAttempts: 5,
    traceId: "trace-3",
    payload: { company_id: COMPANY_A, provider_id: "stripe_connect", document_label: "Payout schedule" },
    signal: new AbortController().signal,
  });

  expectEqual(jobDatabase.requestRows.length, 2, "the job handler recorded the ask");
  expectEqual(jobDatabase.requestRows[1]?.status, "open", "as an open row");
  expectEqual(jobDatabase.requestRows[1]?.provider_id, "stripe_connect", "for the asking provider");
  expectEqual(jobDatabase.requestRows[1]?.submission_id, DRAFT_SUBMISSION_ID, "on the draft submission");
}

/** ---- STEP 097 sources: the capture service, the route, the form and the migration. */
async function checkDocumentRequestsSources(): Promise<void> {
  const capture = await readRepositoryFile("services/kyc/kyc-capture.ts");
  const route = await readRepositoryFile("app/api/onboarding/kyc-document/route.ts");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/documents/documents-form.tsx");

  expect(capture.includes('KYC_DOCUMENT_REQUESTS_TABLE = "kyc_document_requests"'), "the capture service names the 0109 table");
  expect(capture.includes('KYC_DOCUMENT_REQUEST_JOB = "kyc.document_request"'), "and the request job name");
  expect(capture.includes('KYC_DOCUMENT_REQUEST_CREATED_AUDIT_ACTION = "kyc_document_request.created"'), "and the created audit action");
  expect(capture.includes('KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION = "kyc_document_request.fulfilled"'), "and the fulfilled audit action");
  expect(capture.includes("status=eq.open"), "the fulfill write is conditional on the open status");
  expect(capture.includes("version=eq."), "and on the current version");
  expect(capture.includes("fulfilled_by"), "the row names the answering document");
  expect(capture.includes('"not_open"'), "an answered ask conflicts");
  expect(capture.includes('"submission_mismatch"'), "a foreign submission conflicts");
  expect(capture.includes('"request_document_type"'), "only a processor_request document answers a request");
  expect(capture.includes('"stale"'), "a lost race conflicts");
  expect(capture.includes("idempotencyKey"), "the enqueue is idempotent per ask");
  expect(route.includes('request_id: formText(form, "request_id")'), "the upload route passes the request id through");
  expect(form.includes('form.append("request_id", requestId)'), "the form sends it");
  expect(form.includes("pack.openRequests"), "and renders the open asks");

  const migrationFiles = await readdir(new URL("migrations/", repositoryRoot));

  expect(migrationFiles.includes("0109_kyc_document_requests.sql"), "the 0109 forward file exists");
  expect(migrationFiles.includes("0109_kyc_document_requests.down.sql"), "and its rollback");

  const forward = await readRepositoryFile("migrations/0109_kyc_document_requests.sql");

  expect(forward.includes("kyc_document_requests_open_unique"), "one open ask per submission, provider and label");
  expect(forward.includes("enable row level security"), "the table enables RLS");
  expect(forward.includes("kyc_document_requests_default_deny"), "and carries the default-deny policy");
}

/** ---- STEP 098: the duplicate identity check of section 4. */
const OTHER_USER_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";
const DUPLICATE_TAX_ID = "TAX-998877";
const DUPLICATE_PHONE = "+8801000000002";
const DUPLICATE_HASH = "a".repeat(64);
const DUPLICATE_FINGERPRINT = "b".repeat(64);

/** A database whose COMPANY_A applicant carries every signal, matched by COMPANY_B rows. */
function duplicateSeededDatabase(): BusinessDatabase {
  const database = createBusinessDatabase();

  database.profileRows.push(
    businessRow({
      id: "018f2b8a-0000-4c2d-9c3e-0000000000a1",
      company_id: COMPANY_A,
      legal_name: "Acme One Ltd",
      tax_id: DUPLICATE_TAX_ID,
      contact_phone: DUPLICATE_PHONE,
    }),
    businessRow({
      id: "018f2b8a-0000-4c2d-9c3e-0000000000a2",
      company_id: COMPANY_B,
      legal_name: "Acme Two Ltd",
      tax_id: DUPLICATE_TAX_ID,
      contact_phone: DUPLICATE_PHONE,
    }),
  );

  database.userRows.push({
    id: OTHER_USER_ID,
    company_id: COMPANY_B,
    email: "other@example.test",
    phone: DUPLICATE_PHONE,
    full_name: "Owner Two",
    status: "active",
    version: 1,
    created_at: "2026-11-01T08:05:00.000Z",
  });

  // The applicant's own phone matches COMPANY_B's user phone; its email is its own.
  database.userRows[0] = {
    ...database.userRows[0] as UserRowShape,
    phone: DUPLICATE_PHONE,
  };

  database.uboRows.push(
    {
      id: "018f2b8a-0000-4c2d-9c3e-0000000000b1",
      company_id: COMPANY_A,
      submission_id: DRAFT_SUBMISSION_ID,
      full_name: "Owner One",
      date_of_birth: "1990-01-01",
      country: "BD",
      ownership_bps: 10_000,
      is_significant: true,
      id_document_sha256: DUPLICATE_HASH,
      is_pep: false,
      screened_at: null,
      created_at: "2026-11-02T09:20:00.000Z",
    },
    {
      id: "018f2b8a-0000-4c2d-9c3e-0000000000b2",
      company_id: COMPANY_B,
      submission_id: OTHER_SUBMISSION_ID,
      full_name: "Owner One",
      date_of_birth: "1990-01-01",
      country: "BD",
      ownership_bps: 10_000,
      is_significant: true,
      id_document_sha256: DUPLICATE_HASH,
      is_pep: false,
      screened_at: null,
      created_at: "2026-11-02T09:25:00.000Z",
    },
  );

  database.bankRows.push(
    {
      id: "018f2b8a-0000-4c2d-9c3e-0000000000c1",
      company_id: COMPANY_A,
      account_fingerprint: DUPLICATE_FINGERPRINT,
      created_at: "2026-11-02T09:30:00.000Z",
    },
    {
      id: "018f2b8a-0000-4c2d-9c3e-0000000000c2",
      company_id: COMPANY_B,
      account_fingerprint: DUPLICATE_FINGERPRINT,
      created_at: "2026-11-02T09:31:00.000Z",
    },
  );

  return database;
}

async function checkDuplicateIdentityGate(): Promise<void> {
  expectEqual(DUPLICATE_CASES_TABLE, "duplicate_cases", "the case table of 0110");
  expectEqual(DUPLICATE_IDENTITY_RULE, "duplicate_identity", "the applicant-facing rule of a block");
  expectEqual(DUPLICATE_CASE_ENTITY, "duplicate_case", "the case audit entity");
  expectDeepEqual(
    [...IDENTITY_SIGNALS],
    ["email", "phone", "identity_document_hash", "tax_id", "bank_account_fingerprint", "legal_name_with_dob"],
    "the six signals of section 4, in its order",
  );
  expectDeepEqual([...DUPLICATE_STAGES], ["signup", "kyc_submission", "provisioning"], "the three stages of the title");

  // Signal collection: one bounded read per source table, every signal of the applicant.
  const collectDatabase = duplicateSeededDatabase();
  const signals = await collectIdentitySignals(COMPANY_A, createBusinessStore(collectDatabase));
  const bySignal = new Map<string, number>();

  for (const entry of signals) {
    bySignal.set(entry.signal, (bySignal.get(entry.signal) ?? 0) + 1);
  }

  expectEqual(bySignal.get("email"), 1, "the account email is a signal");
  expectEqual(bySignal.get("phone"), 2, "the account phone and the contact phone are phone signals");
  expectEqual(bySignal.get("tax_id"), 1, "the profile tax id is a signal");
  expectEqual(bySignal.get("identity_document_hash"), 1, "the owner document hash is a signal");
  expectEqual(bySignal.get("legal_name_with_dob"), 1, "the owner name with date of birth is a signal");
  expectEqual(bySignal.get("bank_account_fingerprint"), 1, "the bank account fingerprint is a signal");

  // No match anywhere: not blocked, nothing recorded.
  const cleanDatabase = createBusinessDatabase();
  const cleanAudit = createInMemoryAuditTrail();
  const clean = await checkDuplicateIdentity(
    { companyId: COMPANY_A, stage: "kyc_submission" },
    dependenciesOf(cleanDatabase, cleanAudit),
  );

  expectEqual(clean.blocked, false, "an applicant with no foreign match is not blocked");
  expectEqual(clean.matches.length, 0, "with no matches");
  expectEqual(cleanDatabase.caseRows.length, 0, "and no case is recorded");
  expectEqual(cleanAudit.entries.length, 0, "and nothing is audited");

  // Every signal matched by COMPANY_B: blocked, one open case per signal, one audit each.
  const database = duplicateSeededDatabase();
  const audit = createInMemoryAuditTrail();
  const result = await checkDuplicateIdentity(
    { companyId: COMPANY_A, stage: "kyc_submission", actor: owner },
    dependenciesOf(database, audit),
  );

  expectEqual(result.blocked, true, "a foreign match on any signal blocks");
  expect(
    result.matches.every((match) => match.matchedCompanyId === COMPANY_B),
    "every match names the other company",
  );
  expectEqual(database.caseRows.length, 5, "one open case per matched signal (the email is unique, so it cannot match)");
  expect(
    database.caseRows.every((row) => row.status === "open" && row.stage === "kyc_submission" && row.company_id === COMPANY_A),
    "each case is open, at the kyc stage, filed under the applicant",
  );
  expectDeepEqual(
    [...database.caseRows.map((row) => row.signal)].sort(),
    ["bank_account_fingerprint", "identity_document_hash", "legal_name_with_dob", "phone", "tax_id"],
    "covering every signal that can match across accounts",
  );
  expect(
    database.caseRows.every((row) => row.matched_company_id === COMPANY_B),
    "each case names the matched company",
  );
  expectEqual(
    database.caseRows.find((row) => row.signal === "phone")?.matched_user_id,
    OTHER_USER_ID,
    "a match on the account phone names the matched user",
  );
  expectEqual(audit.entries.length, 5, "one audit per case");
  expect(
    audit.entries.every((entry) => entry.action === DUPLICATE_CASE_OPENED_AUDIT_ACTION && entry.entityType === DUPLICATE_CASE_ENTITY),
    "each under duplicate_case.opened on the case entity",
  );
  expectEqual(audit.entries[0]?.actorUserId, OWNER_ID, "with the applicant as the actor");

  // A repeated check at the same stage converges on the open cases instead of piling up.
  const again = await checkDuplicateIdentity(
    { companyId: COMPANY_A, stage: "kyc_submission", actor: owner },
    dependenciesOf(database, audit),
  );

  expectEqual(again.blocked, true, "still blocked");
  expectEqual(database.caseRows.length, 5, "but no second case per signal");
  expectEqual(audit.entries.length, 5, "and no second audit");

  // The signup stage: the email is the only signal present, and the case is filed under the matched
  // tenant because a blocked applicant has no company of its own yet.
  const signupAudit = createInMemoryAuditTrail();
  const signupDatabase = duplicateSeededDatabase();
  const signup = await checkSignupIdentity(
    { email: "other@example.test" },
    dependenciesOf(signupDatabase, signupAudit),
  );

  expectEqual(signup.blocked, true, "a registered email blocks the signup");
  expectEqual(signup.matches[0]?.matchedUserId, OTHER_USER_ID, "naming the matched account");
  expectEqual(signupDatabase.caseRows.length, 1, "one case recorded");
  expectEqual(signupDatabase.caseRows[0]?.stage, "signup", "at the signup stage");
  expectEqual(signupDatabase.caseRows[0]?.signal, "email", "on the email signal");
  expectEqual(signupDatabase.caseRows[0]?.company_id, COMPANY_B, "filed under the matched tenant");
  expectEqual(signupDatabase.caseRows[0]?.matched_user_id, OTHER_USER_ID, "naming the matched user");
  expectEqual(signupAudit.entries[0]?.actorUserId, null, "a signup case has no session actor");

  const freshAudit = createInMemoryAuditTrail();
  const fresh = await checkSignupIdentity({ email: "fresh@example.test" }, dependenciesOf(duplicateSeededDatabase(), freshAudit));

  expectEqual(fresh.blocked, false, "an unregistered email is not blocked");
  expectEqual(freshAudit.entries.length, 0, "and records nothing");

  const badSignup = await rejectionOf(() =>
    checkSignupIdentity({ email: "not-an-email" }, dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail())),
  );

  expectEqual(badSignup?.code, "VALIDATION_FAILED", "a malformed email is refused at the call site");

  // The KYC submission refuses a blocked applicant before the status moves, and the case is there.
  const kycDatabase = duplicateSeededDatabase();
  const kycAudit = createInMemoryAuditTrail();
  const kycDeps = dependenciesOf(kycDatabase, kycAudit);

  kycDatabase.submissionRows.push({
    id: DRAFT_SUBMISSION_ID,
    company_id: COMPANY_A,
    status: "draft",
    verification_method: "manual",
    created_at: "2026-11-02T09:00:00.000Z",
  });
  await saveKycDocument({ actor: owner, input: pngDocumentInput() }, kycDeps);
  await runKycScreening({ actor: owner }, kycDeps);

  const blockedSubmit = await rejectionOf(() => submitKyc({ actor: owner }, kycDeps));

  expectEqual(blockedSubmit?.code, "CONFLICT", "a duplicate at the KYC submission conflicts");
  expectDeepEqual(
    blockedSubmit?.details,
    [{ field: "identity", rule: "duplicate_identity" }],
    "with the generic rule - never the signal that matched",
  );
  expectEqual(
    kycDatabase.submissionRows[0]?.status,
    "draft",
    "the submission stays a draft, nothing moved",
  );
  expectEqual(
    kycDatabase.caseRows.filter((row) => row.stage === "kyc_submission").length,
    5,
    "and the cases are in the compliance queue",
  );

  // Provisioning refuses a blocked merchant before any provision row exists.
  const provisionDatabase = provisionSeededDatabase();
  const provisionAudit = createInMemoryAuditTrail();

  // The seeded FULL_PROFILE is the applicant's own profile (read with limit=1), so the shared tax id
  // goes on it; the other company carries the same tax id in its own profile row.
  provisionDatabase.profileRows[0] = {
    ...(provisionDatabase.profileRows[0] as BusinessRowShape),
    tax_id: DUPLICATE_TAX_ID,
  };
  provisionDatabase.profileRows.push(
    businessRow({ id: "018f2b8a-0000-4c2d-9c3e-0000000000a2", company_id: COMPANY_B, tax_id: DUPLICATE_TAX_ID }),
  );

  const blockedRun = await runSubmerchantProvisioning(
    { company_id: COMPANY_A, kyc_submission_id: APPROVED_SUBMISSION_ID },
    dependenciesOf(provisionDatabase, provisionAudit),
  );

  expectEqual(blockedRun.blocked, true, "the duplicate blocks the provisioning run");
  expectEqual(blockedRun.created, 0, "and no provision row is created");
  expectEqual(
    provisionDatabase.inserts.filter((insert) => insert.table === SUBMERCHANT_PROVISIONS_TABLE).length,
    0,
    "nothing is inserted",
  );
  expectEqual(
    provisionDatabase.caseRows.filter((row) => row.stage === "provisioning" && row.signal === "tax_id").length,
    1,
    "the match is a provisioning-stage case",
  );

  // The unblocked run still provisions and answers blocked: false.
  const freeDatabase = provisionSeededDatabase();
  const freeRun = await runSubmerchantProvisioning(
    { company_id: COMPANY_A, kyc_submission_id: APPROVED_SUBMISSION_ID },
    dependenciesOf(freeDatabase, createInMemoryAuditTrail()),
  );

  expectEqual(freeRun.blocked, false, "no foreign match, not blocked");
  expectEqual(freeRun.created, 2, "and the rows are created as before");
}

/** ---- STEP 098 sources: the checker service, both wirings and the migration. */
async function checkDuplicateIdentitySources(): Promise<void> {
  const checker = await readRepositoryFile("services/kyc/duplicate-check.ts");
  const capture = await readRepositoryFile("services/kyc/kyc-capture.ts");
  const provision = await readRepositoryFile("services/submerchant/provision.ts");

  expectEqual(checker.split("\n")[0], "// path: services/kyc/duplicate-check.ts", "the checker states its own path on its first line");
  expect(/[^\t\n\r\x20-\x7E]/u.test(checker) === false, "the checker is ASCII only");
  expect(checker.includes('DUPLICATE_CASES_TABLE = "duplicate_cases"'), "the checker names the 0110 table");
  expect(checker.includes('DUPLICATE_CASE_OPENED_AUDIT_ACTION = "duplicate_case.opened"'), "and the opened audit action");
  expect(checker.includes('"signup"') && checker.includes('"kyc_submission"') && checker.includes('"provisioning"'), "the three stages");
  expect(checker.includes('"legal_name_with_dob"'), "the composite name-with-dob signal");
  expect(checker.includes("status=eq.open"), "a repeated check converges on the open case");
  expect(checker.includes("matched_company_id"), "the case names the matched account");
  expect(capture.includes('stage: "kyc_submission"'), "the KYC submission runs the check");
  expect(capture.includes("DUPLICATE_IDENTITY_RULE"), "and answers with the generic rule");
  expect(provision.includes('stage: "provisioning"'), "the provisioning job runs the check before any row");
  expect(provision.includes("blocked: true"), "and a match blocks the run");

  const migrationFiles = await readdir(new URL("migrations/", repositoryRoot));

  expect(migrationFiles.includes("0110_duplicate_cases.sql"), "the 0110 forward file exists");
  expect(migrationFiles.includes("0110_duplicate_cases.down.sql"), "and its rollback");

  const forward = await readRepositoryFile("migrations/0110_duplicate_cases.sql");

  expect(forward.includes("duplicate_cases_open_unique"), "one open case per tenant, stage and signal");
  expect(forward.includes("duplicate_cases_signal_check"), "the signal vocabulary is closed");
  expect(forward.includes("enable row level security"), "the table enables RLS");
  expect(forward.includes("duplicate_cases_default_deny"), "and carries the default-deny policy");
}

/* -------------------------------------------------------------------------------------------------
 * STEP 099: the merchant account lifecycle of section 13 - suspension, reactivation, closure with
 * the saved card token deletion and the chargeback period fund hold.
 */

const ACCOUNT_EVENTS_TABLE = MERCHANT_ACCOUNT_EVENTS_TABLE;

const BANK_ACCOUNT_ID = "018f2b8a-5555-4c2d-9c3e-000000000001";
const LEDGER_ACCOUNT_ID = "018f2b8a-6666-4c2d-9c3e-000000000001";
const PROVISION_ID_A = "018f2b8a-7777-4c2d-9c3e-000000000001";
const REACTIVATION_SUBMISSION_ID = "018f2b8a-8888-4c2d-9c3e-000000000001";
const MS_PER_DAY_99 = 86_400_000;

/** A database whose COMPANY_A is fully set up: profile with a high-risk MCC, a verified bank, a
 *  `merchant_payable` account with 80 USD in it, one approved submission with an accepted document,
 * and one verified sub-merchant provision. */
function lifecycleSeededDatabase(): BusinessDatabase {
  const database = createBusinessDatabase(
    [businessRow({ company_id: COMPANY_A, mcc_code: "5999", tax_id: "TIN-LIFE-1" })],
    [],
    [
      { id: "018f2b8a-0000-4c2d-9c3e-0000000000f1", code: "5999", title: "Misc Food", risk_tier: "high", is_active: true, version: 1 },
      ...defaultMccRows(),
    ],
    defaultCountryRows(),
    [
      {
        id: REACTIVATION_SUBMISSION_ID,
        company_id: COMPANY_A,
        status: "approved",
        verification_method: "manual",
        submitted_at: "2026-11-01T10:00:00.000Z",
        submitted_by: OWNER_ID,
        decided_at: "2026-11-01T10:30:00.000Z",
        decision_reason: null,
        version: 3,
        created_at: "2026-11-01T09:00:00.000Z",
      },
    ],
    [
      {
        id: "018f2b8a-9999-4c2d-9c3e-000000000001",
        company_id: COMPANY_A,
        submission_id: REACTIVATION_SUBMISSION_ID,
        document_type: "bank_statement",
        storage_key: "kyc/018f2b8a-4444-4c2d-9c3e-000000000001/bank.pdf",
        content_sha256: "c".repeat(64),
        content_type: "application/pdf",
        byte_size: 1024,
        issued_at: null,
        expires_at: null,
        status: "accepted",
        created_at: "2026-11-01T09:30:00.000Z",
      },
    ],
    [],
    [],
    defaultCriteriaRow(),
    [
      { id: "018f2b8a-0000-4c2d-9c3e-0000000000e3", tier: "high", extra_reserve_percent: "10", hold_days: 30, updated_by: null, version: 1, updated_at: "2026-11-01T09:00:00.000Z", created_at: "2026-11-01T09:00:00.000Z" },
      ...defaultTierRows().filter((row) => row.tier !== "high"),
    ],
  );

  database.bankRows.push({
    id: BANK_ACCOUNT_ID,
    company_id: COMPANY_A,
    account_fingerprint: "d".repeat(64),
    status: "verified",
    bank_name: "Test Bank",
    account_last_four: "4321",
    country: "BD",
    version: 1,
    created_at: "2026-11-01T08:10:00.000Z",
  });

  database.ledgerAccountRows.push({
    id: LEDGER_ACCOUNT_ID,
    company_id: COMPANY_A,
    account_code: MERCHANT_PAYABLE_ACCOUNT_CODE,
    created_at: "2026-11-01T08:00:00.000Z",
  });

  database.ledgerEntryRows.push(
    { id: "018f2b8a-aaaa-4c2d-9c3e-000000000001", company_id: COMPANY_A, account_id: LEDGER_ACCOUNT_ID, entry_side: "credit", amount_minor: 1_000_000, created_at: "2026-11-01T12:00:00.000Z" },
    { id: "018f2b8a-aaaa-4c2d-9c3e-000000000002", company_id: COMPANY_A, account_id: LEDGER_ACCOUNT_ID, entry_side: "debit", amount_minor: 200_000, created_at: "2026-11-01T12:05:00.000Z" },
  );

  database.provisionRows.push({
    id: PROVISION_ID_A,
    company_id: COMPANY_A,
    kyc_submission_id: REACTIVATION_SUBMISSION_ID,
    provider_id: "018f2b8a-0000-4c2d-9c3e-0000000000aa",
    provider_key: "nmi",
    mode: "test",
    master_account_ref: "master-1",
    provider_submerchant_id: "sub-1",
    status: "verified",
    charges_enabled: true,
    payouts_enabled: true,
    requested_at: "2026-11-01T11:00:00.000Z",
    next_attempt_at: null,
    version: 2,
    updated_at: "2026-11-01T11:00:00.000Z",
    created_at: "2026-11-01T11:00:00.000Z",
  });

  return database;
}

/** A job runtime whose two STEP 099 jobs are registered against a memory queue. */
function lifecycleJobs(): { readonly registry: JobRegistry; readonly queue: ReturnType<typeof createInMemoryJobQueue> } {
  const registry = new JobRegistry();

  registry.register({
    name: CLOSURE_PAYOUT_JOB,
    payloadSchema: closurePayoutJobPayloadSchema,
    handler: async () => {},
  });
  registry.register({
    name: SUBMERCHANT_DELETE_CARD_TOKENS_JOB,
    payloadSchema: deleteCardTokensJobPayloadSchema,
    handler: async () => {},
  });

  return { registry, queue: createInMemoryJobQueue() };
}

async function checkAccountLifecycleGate(): Promise<void> {
  // ---- the vocabulary and the roles
  expectEqual(ACCOUNT_EVENTS_TABLE, "merchant_account_events", "the service names the 0111 table");
  expectEqual(HOLDS_TABLE, "holds", "the 0043 hold table is named");
  expectEqual(PAYOUTS_TABLE, "payouts", "the 0045 payout table is named");
  expectEqual(LEDGER_ACCOUNTS_TABLE, "ledger_accounts", "the 0040 account table is named");
  expectEqual(LEDGER_ENTRIES_TABLE, "ledger_entries", "the 0041 entry table is named");
  expectEqual(PLATFORM_SETTINGS_TABLE, "platform_settings", "the 0080 settings table is named");
  expectEqual(CHARGEBACK_HOLD_DAYS_SETTING, "chargeback.hold_days", "the chargeback period setting is named");
  expectEqual(CHARGEBACK_HOLD_DAYS_DEFAULT, 180, "the seeded chargeback period is 180 days");
  expect(ACCOUNT_MANAGE_ROLES.includes("compliance_kyc") && ACCOUNT_MANAGE_ROLES.includes("finance_ops"), "the office roles include compliance_kyc and finance_ops");
  expectEqual(CLOSURE_PAYOUT_JOB, "merchant_account.closure_payout", "the delayed payout job is named");
  expectEqual(SUBMERCHANT_DELETE_CARD_TOKENS_JOB, "submerchant.delete_card_tokens", "the token deletion job is named");
  expect(suspendAccountBodySchema.safeParse({ company_id: COMPANY_A, reason: "risk" }).success, "the suspend body accepts a reason without documents");
  expect(!suspendAccountBodySchema.safeParse({ company_id: COMPANY_A, reason: "nope" }).success, "an unknown reason is refused");
  expect(!suspendAccountBodySchema.safeParse({ company_id: "not-a-uuid", reason: "risk" }).success, "a non-uuid company is refused");
  expect(closeAccountBodySchema.safeParse({ company_id: COMPANY_A }).success, "the close body works without a bank account id");

  // ---- a fresh company reads as active, and the roles are enforced
  const freshAudit = createInMemoryAuditTrail();
  const fresh = createBusinessDatabase();
  const freshDeps = { ...dependenciesOf(fresh, freshAudit) };

  const freshState = await readMerchantAccountState({ actor: owner }, freshDeps);
  expectEqual(freshState.state, "active", "a company with no events is active");
  expectEqual(freshState.reactivationReady, false, "and has no submission in review yet");

  expect(
    (await rejectionOf(() => readAccountReviewQueue({ actor: owner }, freshDeps)))?.code === "PERMISSION_DENIED",
    "an owner cannot read the office queue",
  );
  expect(
    (await rejectionOf(() => suspendMerchant({ actor: owner, body: { company_id: COMPANY_A, reason: "risk" } }, freshDeps)))?.code === "PERMISSION_DENIED",
    "an owner cannot suspend",
  );
  expect(
    (await rejectionOf(() => suspendMerchant({ actor: desk, body: { company_id: "nope", reason: "risk" } }, freshDeps)))?.code === "VALIDATION_FAILED",
    "a malformed company id is a validation failure",
  );

  // ---- suspension
  const audit = createInMemoryAuditTrail();
  const database = lifecycleSeededDatabase();
  const deps = { ...dependenciesOf(database, audit) };
  const jobs = lifecycleJobs();

  const suspended = await suspendMerchant(
    { actor: desk, body: { company_id: COMPANY_A, reason: "risk", required_documents: ["utility bill", "bank statement"] } },
    deps,
  );
  expectEqual(suspended.state, "suspended", "the suspension answers suspended");
  expectEqual(suspended.usersSuspended, 1, "and moved the owner user");
  expectEqual(database.userRows[0]?.status, "suspended", "the 0003 status is suspended, which is what locks the session");
  expectEqual(database.eventRows.length, 1, "one event row is written");
  expectEqual(database.eventRows[0]?.event, "suspended", "as a suspension");
  expectEqual(database.eventRows[0]?.reason, "risk", "with the reason");
  expectDeepEqual(database.eventRows[0]?.required_documents, ["utility bill", "bank statement"], "and the required documents");
  expect(
    audit.entries.some((entry) => entry.action === "merchant_account.suspended" && entry.companyId === COMPANY_A),
    "the suspension is audited",
  );

  expect(
    (await rejectionOf(() => suspendMerchant({ actor: desk, body: { company_id: COMPANY_A, reason: "risk" } }, deps)))?.code === "CONFLICT",
    "a second suspension conflicts",
  );

  const suspendedState = await readMerchantAccountState({ actor: owner }, deps);
  expectEqual(suspendedState.state, "suspended", "the merchant reads suspended");
  expectEqual(suspendedState.reason, "risk", "with the reason");
  expectDeepEqual(suspendedState.requiredDocuments, ["utility bill", "bank statement"], "and the required documents");
  expectEqual(suspendedState.reactivationReady, true, "an approved submission is in the pipeline, so reactivation can be requested");

  const queue = await readAccountReviewQueue({ actor: desk }, deps);
  expectEqual(queue.rows.length, 1, "the office queue lists the suspended account");
  expectEqual(queue.rows[0]?.state, "suspended", "as suspended");
  expectEqual(queue.rows[0]?.companyId, COMPANY_A, "for the right merchant");
  expect(
    audit.entries.some((entry) => entry.action === "merchant_account.read_by_office"),
    "the office read is audited",
  );

  // ---- reactivation request and decision
  expect(
    (await rejectionOf(() => requestReactivation({ actor: otherOwner }, { ...dependenciesOf(createBusinessDatabase(), createInMemoryAuditTrail()) })))?.code === "CONFLICT",
    "an active account cannot request reactivation",
  );

  const requested = await requestReactivation({ actor: owner }, deps);
  expectEqual(requested.state, "reactivation_requested", "the request answers that state");
  expectEqual(requested.kycSubmissionId, REACTIVATION_SUBMISSION_ID, "naming the submission in review");
  expectEqual(database.eventRows[database.eventRows.length - 1]?.event, "reactivation_requested", "the event is recorded");
  expect(
    (await rejectionOf(() => requestReactivation({ actor: owner }, deps)))?.code === "CONFLICT",
    "a repeated request conflicts",
  );

  const queueAfterRequest = await readAccountReviewQueue({ actor: desk }, deps);
  expectEqual(queueAfterRequest.rows[0]?.state, "reactivation_requested", "the queue shows the pending request");

  // A submission that is not approved cannot reactivate.
  const notApproved = lifecycleSeededDatabase();
  notApproved.submissionRows[0] = { ...notApproved.submissionRows[0] as SubmissionRowShape, status: "submitted" };
  await suspendMerchant({ actor: desk, body: { company_id: COMPANY_A, reason: "manual" } }, { ...dependenciesOf(notApproved, createInMemoryAuditTrail()) });
  await requestReactivation({ actor: owner }, { ...dependenciesOf(notApproved, createInMemoryAuditTrail()) });
  expect(
    (await rejectionOf(() => decideReactivation({ actor: desk, body: { company_id: COMPANY_A } }, { ...dependenciesOf(notApproved, createInMemoryAuditTrail()) })))?.code === "CONFLICT",
    "a submission that is not approved conflicts",
  );

  // A submission with a rejected document cannot reactivate either.
  const rejectedDoc = lifecycleSeededDatabase();
  rejectedDoc.documentRows[0] = { ...rejectedDoc.documentRows[0] as DocumentRowShape, status: "rejected", rejection_reason: "illegible" };
  const rejectedDeps = { ...dependenciesOf(rejectedDoc, createInMemoryAuditTrail()) };
  await suspendMerchant({ actor: desk, body: { company_id: COMPANY_A, reason: "manual" } }, rejectedDeps);
  await requestReactivation({ actor: owner }, rejectedDeps);
  expect(
    (await rejectionOf(() => decideReactivation({ actor: desk, body: { company_id: COMPANY_A } }, rejectedDeps)))?.code === "CONFLICT",
    "a rejected document on the submission conflicts",
  );

  const reactivated = await decideReactivation({ actor: desk, body: { company_id: COMPANY_A } }, deps);
  expectEqual(reactivated.state, "active", "the decision answers active");
  expectEqual(reactivated.usersReactivated, 1, "and moved the owner user back");
  expectEqual(database.userRows[0]?.status, "active", "the 0003 status is active again");
  expectEqual(database.eventRows[database.eventRows.length - 1]?.event, "reactivated", "the event is recorded");
  expect(
    (await rejectionOf(() => decideReactivation({ actor: desk, body: { company_id: COMPANY_A } }, deps)))?.code === "CONFLICT",
    "deciding again conflicts as already active",
  );

  // ---- closure request and closure
  const closureRequested = await requestAccountClosure({ actor: owner, body: { note: "Leaving the platform" } }, deps);
  expectEqual(closureRequested.state, "closure_requested", "the closure request answers that state");
  expectEqual(database.eventRows[database.eventRows.length - 1]?.detail, "Leaving the platform", "with the note");
  expect(
    (await rejectionOf(() => closeMerchantAccount({ actor: desk, body: { company_id: COMPANY_B } }, deps)))?.code === "CONFLICT",
    "closing an active account without a request conflicts",
  );
  expect(
    (await rejectionOf(() => closeMerchantAccount({ actor: desk, body: { company_id: COMPANY_A, payout_bank_account_id: "018f2b8a-5555-4c2d-9c3e-000000000099" } }, deps)))?.code === "VALIDATION_FAILED",
    "an unknown bank account is a validation failure",
  );

  const financeDesk = actorOf(["finance_ops"], null, { userId: OFFICE_ID });
  const closeDeps = { ...deps, jobs };
  const closed = await closeMerchantAccount({ actor: financeDesk, body: { company_id: COMPANY_A } }, closeDeps);
  expectEqual(closed.state, "closed", "the closure answers closed");
  expectEqual(closed.payoutBankAccountId, BANK_ACCOUNT_ID, "using the company's verified bank account");

  // The schedule: hold period from the risk tier (30 days), chargeback period from the setting (180 days).
  const holdRelease = Date.parse(closed.holdReleaseAt);
  const chargebackRelease = Date.parse(closed.chargebackHoldReleaseAt);
  expectEqual(holdRelease - NOW, 30 * MS_PER_DAY_99, "the payout goes out after the merchant's 30 day hold period");
  expectEqual(chargebackRelease - NOW, 180 * MS_PER_DAY_99, "the chargeback funds stay held for the 180 day chargeback period");
  expect(chargebackRelease > holdRelease, "the chargeback instant is after the payout instant");

  // The balance is 80 USD (1_000_000 - 200_000 minor); the high tier reserves 10%, so 8 USD stays
  // held and 72 USD is scheduled for the bank.
  expectEqual(closed.reserveHeldMinor, "80000", "the reserve is 10 percent of the 80 USD balance");
  expectEqual(closed.payoutMinor, "720000", "the rest is scheduled for the payout");
  expectEqual(closed.usersClosed, 1, "and the owner user is closed");
  expectEqual(database.userRows[0]?.status, "closed", "the 0003 status is closed");
  expectEqual(closed.provisionsRestricted, 1, "the verified provision is restricted");
  expectEqual(database.provisionRows[0]?.status, "restricted", "in the store");
  expectEqual(database.provisionRows[0]?.charges_enabled, false, "with charges off");
  expectEqual(database.provisionRows[0]?.payouts_enabled, false, "and payouts off");
  expectEqual(closed.tokenDeletionsQueued, 1, "and the token deletion is queued");

  const closedEvent = database.eventRows.find((row) => row.event === "closed");
  expect(closedEvent !== undefined, "the closed event is recorded");
  expectEqual(closedEvent?.payout_bank_account_id, BANK_ACCOUNT_ID, "naming the payout bank account");
  expectEqual(closedEvent?.hold_release_at, closed.holdReleaseAt, "and the hold release instant");
  expectEqual(closedEvent?.chargeback_hold_release_at, closed.chargebackHoldReleaseAt, "and the chargeback hold instant");

  expectEqual(database.fundHoldRows.length, 1, "one 0043 hold is placed");
  expectEqual(database.fundHoldRows[0]?.reason, "closure", "as a closure hold");
  expectEqual(database.fundHoldRows[0]?.status, "active", "still active");
  expectEqual(database.fundHoldRows[0]?.amount_minor, "80000", "holding the chargeback liability part");
  expectEqual(database.fundHoldRows[0]?.release_due_at, closed.chargebackHoldReleaseAt, "until the chargeback period ends");

  expect(
    audit.entries.some((entry) => entry.action === "merchant_account.closed" && entry.companyId === COMPANY_A),
    "the closure is audited",
  );

  // The two jobs: the delayed payout and the immediate token deletion.
  const farFuture = NOW + 400 * MS_PER_DAY_99;
  const first = await jobs.queue.reserve({ leaseDurationMs: 60_000, now: farFuture });
  const second = await jobs.queue.reserve({ leaseDurationMs: 60_000, now: farFuture });
  expectEqual(first?.name, SUBMERCHANT_DELETE_CARD_TOKENS_JOB, "the token deletion is queued at once");
  expectEqual(first?.availableAtEpochMs, NOW, "with no delay");
  expectEqual((first?.payload as { provision_id?: string })?.provision_id, PROVISION_ID_A, "for the restricted provision");
  expectEqual(first?.idempotencyKey, deleteCardTokensJobIdempotencyKey(PROVISION_ID_A), "under its idempotency key");
  expectEqual(second?.name, CLOSURE_PAYOUT_JOB, "the payout job is queued");
  expectEqual(second?.availableAtEpochMs, holdRelease, "delayed to the end of the hold period");
  const payoutPayload = second?.payload as { amount_minor?: string; closure_event_id?: string; payout_bank_account_id?: string };
  expectEqual(payoutPayload?.amount_minor, "720000", "carrying the remainder amount");
  expectEqual(payoutPayload?.closure_event_id, closed.eventId, "and the closure event");
  expectEqual(payoutPayload?.payout_bank_account_id, BANK_ACCOUNT_ID, "and the bank account");

  // A repeated close conflicts; the merchant screen reads the closed state with the schedule.
  expect(
    (await rejectionOf(() => closeMerchantAccount({ actor: desk, body: { company_id: COMPANY_A } }, closeDeps)))?.code === "CONFLICT",
    "closing twice conflicts",
  );
  const closedState = await readMerchantAccountState({ actor: owner }, deps);
  expectEqual(closedState.state, "closed", "the merchant reads closed");
  expectEqual(closedState.holdReleaseAt, closed.holdReleaseAt, "with the payout instant");
  expectEqual(closedState.chargebackHoldReleaseAt, closed.chargebackHoldReleaseAt, "and the chargeback hold instant");

  // ---- the delayed payout job writes the 0045 row, idempotently
  const payoutRun = await runClosurePayout(
    { company_id: COMPANY_A, closure_event_id: closed.eventId, payout_bank_account_id: BANK_ACCOUNT_ID, amount_minor: "720000" },
    deps,
  );
  expectEqual(payoutRun.alreadyRequested, false, "the first payout run writes the row");
  expectEqual(database.payoutRows.length, 1, "the payout job writes one 0045 row");
  expectEqual(database.payoutRows[0]?.status, "requested", "as requested");
  expectEqual(database.payoutRows[0]?.amount_minor, "720000", "for the remainder");
  expectEqual(database.payoutRows[0]?.requested_by, OFFICE_ID, "by the closing actor");
  expectEqual(database.payoutRows[0]?.destination_bank_name, "Test Bank", "to the verified bank");
  expectEqual(database.payoutRows[0]?.destination_last_four, "4321", "last four");
  expectEqual(database.payoutRows[0]?.is_remainder, false, "above the 100 USD floor, so not a remainder");
  expect(
    audit.entries.some((entry) => entry.action === CLOSURE_PAYOUT_REQUESTED_AUDIT_ACTION),
    "the payout request is audited",
  );
  const payoutAgain = await runClosurePayout(
    { company_id: COMPANY_A, closure_event_id: closed.eventId, payout_bank_account_id: BANK_ACCOUNT_ID, amount_minor: "720000" },
    deps,
  );
  expectEqual(payoutAgain.alreadyRequested, true, "a repeated run converges");
  expectEqual(database.payoutRows.length, 1, "without a second row");
  expect(
    (await rejectionOf(() => runClosurePayout(
      { company_id: COMPANY_A, closure_event_id: "018f2b8a-0000-4c2d-9c3e-000000000fff", payout_bank_account_id: BANK_ACCOUNT_ID, amount_minor: "1" },
      deps,
    )))?.code === "CONFLICT",
    "a payload naming a non-closed event conflicts",
  );

  // ---- the token deletion job records the 0111 event, idempotently
  const deletion = await runCardTokenDeletion({ company_id: COMPANY_A, provision_id: PROVISION_ID_A }, deps);
  expectEqual(deletion.alreadyRecorded, false, "the first run records it");
  const tokenEvent = database.eventRows.find((row) => row.event === CARD_TOKENS_DELETED_EVENT);
  expect(tokenEvent !== undefined, "as a card_tokens_deleted event");
  expectEqual(tokenEvent?.actor_user_id, null, "with a null actor, it is a system event");
  expect(
    audit.entries.some((entry) => entry.action === SUBMERCHANT_CARD_TOKENS_DELETED_AUDIT_ACTION && entry.entityId === PROVISION_ID_A),
    "audited against the provision row",
  );
  const deletionAgain = await runCardTokenDeletion({ company_id: COMPANY_A, provision_id: PROVISION_ID_A }, deps);
  expectEqual(deletionAgain.alreadyRecorded, true, "a redelivered job converges");
  expect(
    (await rejectionOf(() => runCardTokenDeletion({ company_id: COMPANY_A, provision_id: "018f2b8a-7777-4c2d-9c3e-000000000099" }, deps)))?.code === "CONFLICT",
    "a provision that is not restricted conflicts",
  );

  // A pending provision is refused: only closure restricts it first.
  const pending = lifecycleSeededDatabase();
  pending.provisionRows[0] = { ...pending.provisionRows[0] as ProvisionRowShape, status: "pending" };
  expect(
    (await rejectionOf(() => runCardTokenDeletion({ company_id: COMPANY_A, provision_id: PROVISION_ID_A }, { ...dependenciesOf(pending, createInMemoryAuditTrail()) })))?.code === "CONFLICT",
    "a pending provision's tokens are not deleted",
  );
}

/** ---- STEP 099 sources: the files exist, are ASCII, and the wirings are where the gate reads them. */
async function checkAccountLifecycleSources(): Promise<void> {
  const paths = [
    "services/kyc/account-lifecycle.ts",
    "services/submerchant/card-tokens.ts",
    "app/api/onboarding/account-suspend/route.ts",
    "app/api/onboarding/account-reactivate-request/route.ts",
    "app/api/onboarding/account-reactivate-decide/route.ts",
    "app/api/onboarding/account-close-request/route.ts",
    "app/api/onboarding/account-close/route.ts",
    "app/(dashboard)/onboarding/account/page.tsx",
    "app/(dashboard)/onboarding/account/account-form.tsx",
    "app/(dashboard)/onboarding/account-review/page.tsx",
    "app/(dashboard)/onboarding/account-review/account-review-queue.tsx",
    "migrations/0111_merchant_account_events.sql",
    "migrations/0111_merchant_account_events.down.sql",
  ];

  for (const path of paths) {
    const source = await readRepositoryFile(path);
    expect(source.length > 0, `${path} exists`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source), `${path} is ASCII only`);
    const pathComment = path.endsWith(".sql") ? `-- path: ${path}` : `// path: ${path}`;
    expect(source.startsWith(pathComment), `${path} starts with its path comment`);
  }

  const service = await readRepositoryFile("services/kyc/account-lifecycle.ts");
  expect(service.includes('MERCHANT_ACCOUNT_EVENTS_TABLE = "merchant_account_events"'), "the service names the 0111 table");
  expect(service.includes("ACCOUNT_MANAGE_ROLES"), "the office roles are declared");
  expect(service.includes('CLOSURE_PAYOUT_JOB = "merchant_account.closure_payout"'), "the payout job is declared");
  expect(service.includes("enqueueCardTokenDeletion"), "the closure queues the token deletion");
  expect(service.includes('reason: "closure"'), "the closure hold uses the 0043 closure reason");
  expect(service.includes("merchant_payable"), "the balance is read from the merchant_payable account");

  const tokens = await readRepositoryFile("services/submerchant/card-tokens.ts");
  expect(tokens.includes('SUBMERCHANT_DELETE_CARD_TOKENS_JOB = "submerchant.delete_card_tokens"'), "the token job is named");
  expect(tokens.includes('CARD_TOKENS_DELETED_EVENT = "card_tokens_deleted"'), "the event it writes is named");

  const sync = await readRepositoryFile("services/submerchant/provision-sync.ts");
  expect(sync.includes("registerDeleteCardTokensJob(registry)"), "the token job is registered with the other sub-merchant jobs");

  const csrf = await readRepositoryFile("lib/security/csrf.ts");
  for (const path of [
    "/api/onboarding/account-suspend",
    "/api/onboarding/account-reactivate-request",
    "/api/onboarding/account-reactivate-decide",
    "/api/onboarding/account-close-request",
    "/api/onboarding/account-close",
  ]) {
    expect(csrf.includes(`"${path}"`), `${path} is on the CSRF protected list`);
    const route = await readRepositoryFile(`app/api/onboarding${path.slice("/api/onboarding".length)}/route.ts`);
    expectEqual(route.split("requireCsrfToken(").length - 1, 1, `${path} checks the token exactly once`);
    expect(
      route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
      `${path} checks the token before it looks the session up`,
    );
  }

  const migrationFiles = (await readdir(new URL("migrations/", repositoryRoot))).map((name) => name);
  expect(migrationFiles.includes("0111_merchant_account_events.sql"), "the 0111 forward file exists");
  expect(migrationFiles.includes("0111_merchant_account_events.down.sql"), "and its rollback");

  const forward = await readRepositoryFile("migrations/0111_merchant_account_events.sql");
  expect(forward.includes("create table public.merchant_account_events"), "the forward creates the table");
  expect(forward.includes("merchant_account_events_default_deny"), "with its default-deny policy");
  expect(forward.includes("merchant_account_events_guard_state"), "and its guard");
  expect(forward.includes("'card_tokens_deleted'"), "the token deletion event is in the vocabulary");
  expect(forward.includes("'chargeback.hold_days'"), "the chargeback period seed is in the file");
  expect(forward.includes("chargeback_hold_release_at > hold_release_at"), "the chargeback instant is checked after the payout instant");

  const down = await readRepositoryFile("migrations/0111_merchant_account_events.down.sql");
  expect(down.includes("drop table if exists public.merchant_account_events"), "the rollback drops the table");
  expect(down.includes("chargeback.hold_days"), "and removes the seeded setting");

  const statusPage = await readRepositoryFile("app/(dashboard)/onboarding/status/page.tsx");
  expect(statusPage.includes('href="/onboarding/account"'), "the status screen links to the account screen");
}

/** ---- STEP 099 catalog: every sentence of the merchant account screen is used, and every key it names exists. */
async function checkAccountCatalog(): Promise<void> {
  const block = en.onboardingAccount as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/account/page.tsx");
  const form = await readRepositoryFile("app/(dashboard)/onboarding/account/account-form.tsx");
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

  walk(block, "onboardingAccount");

  expect(flat.length >= 25, "the account screen has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingAccount\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["sinceLine", "payoutAtLine", "chargebackHoldLine"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingAccount.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingAccount.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
}

/** ---- STEP 099 catalog: the office account review screen's copy block. */
async function checkAccountReviewCatalog(): Promise<void> {
  const block = en.onboardingAccountReview as unknown as Record<string, unknown>;
  const page = await readRepositoryFile("app/(dashboard)/onboarding/account-review/page.tsx");
  const panel = await readRepositoryFile("app/(dashboard)/onboarding/account-review/account-review-queue.tsx");
  const sources = `${page}\n${panel}`;

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

  walk(block, "onboardingAccountReview");

  expect(flat.length >= 25, "the account review screen has its own block of copy");

  for (const path of flat) {
    expect(sources.includes(`"${path}"`), `the copy key ${path} is used by the screen`);
  }

  const referenced = [...sources.matchAll(/"(onboardingAccountReview\.[A-Za-z.]+)"/gu)].map((match) => match[1]);

  for (const path of new Set(referenced)) {
    expect(path !== undefined && flat.includes(path), `the screen names no missing key (${String(path)})`);
  }

  for (const templated of ["companyLine", "atLine", "requiredDocsLine"]) {
    expectEqual(
      sources.includes(`getMessage("onboardingAccountReview.${templated}")`),
      false,
      `${templated} is never rendered without its values`,
    );
    expect(
      sources.includes(`formatMessage("onboardingAccountReview.${templated}"`),
      `and is rendered through formatMessage`,
    );
  }
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
  checkAddressVocabulary();
  checkAddressParse();
  await checkAddressRead();
  await checkAddressSave();
  await checkAddressSaveRefusals();
  await checkAddressSources();
  await checkAddressCatalog();
  checkProfileVocabulary();
  await checkProfileRead();
  await checkProfilePayload();
  await checkProfileSources();
  await checkProfileCatalog();
  checkKycVocabulary();
  checkKycParse();
  await checkKycRead();
  await checkKycDocumentSave();
  await checkKycUboSave();
  await checkKycScreening();
  await checkKycSummary();
  await checkKycSubmit();
  await checkKycReviewQueue();
  await checkKycReviewDetail();
  await checkKycReviewOpen();
  await checkKycReviewDocument();
  await checkKycReviewRisk();
  await checkKycSources();
  await checkKycDecision();
  await checkKycDecisionSources();
  await checkSubmerchantProvision();
  await checkSubmerchantProvisionSources();
  await checkSubmerchantSync();
  await checkSubmerchantSyncSources();
  await checkDocumentRequests();
  await checkDocumentRequestsSources();
  await checkDuplicateIdentityGate();
  await checkDuplicateIdentitySources();
  await checkAccountLifecycleGate();
  await checkAccountLifecycleSources();
  await checkAccountCatalog();
  await checkAccountReviewCatalog();
  await checkKycCatalog();
  await checkStatusCatalog();
  await checkReviewCatalog();
  await checkUnderwriting();
  await checkUnderwritingSources();
  await checkUnderwritingCatalog();
  await checkMerchantLimit();
  await checkMerchantLimitSources();
  await checkPaymentHolds();
  await checkPaymentHoldSources();
  await checkPaymentHoldCatalog();

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
      `${MCC_CODES_TABLE} vocabulary, ${COUNTRIES_TABLE} list, submerchant profile, kyc pack, underwriting criteria, merchant limits, payment holds, submerchant provisioning, webhook sync, document requests, duplicate checks, account lifecycle\n`,
  );
}

await main();
