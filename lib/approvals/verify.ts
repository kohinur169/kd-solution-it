// path: lib/approvals/verify.ts
import { readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isSensitivePath } from "../auth/request-proof.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import { formatMessage, getMessage, type MessagePath } from "../i18n/messages.ts";
import {
  APPROVAL_ACTION_TYPES,
  APPROVAL_AMOUNT_MAXIMUM_MINOR,
  APPROVAL_CEO_ROLES,
  APPROVAL_DECISIONS,
  APPROVAL_EXPIRY_MS,
  APPROVAL_FINAL_ROLES,
  APPROVAL_HISTORY_LIMIT,
  APPROVAL_LABEL_MAXIMUM_LENGTH,
  APPROVAL_NOTE_MAXIMUM_LENGTH,
  APPROVAL_NOTE_MINIMUM_LENGTH,
  APPROVAL_QUEUE_ROLES,
  APPROVAL_STATUSES,
  CLOSED_APPROVAL_STATUSES,
  amountProblemOf,
  approvalActionLabelKey,
  canRequestApproval,
  decisionAuditAction,
  decisionRolesOf,
  isApprovalActionType,
  isApprovalDecision,
  isApprovalStatus,
  requestableActionsOf,
  requesterRolesOf,
  signatureProblemOf,
  stageOf,
  statusAfterDecision,
  subjectTypeOf,
} from "./registry.ts";
import {
  decideApproval,
  expireLapsedApprovals,
  listApprovalQueue,
  normalizeCurrency,
  readPlatformDecisions,
  requestApproval,
  requesterRoleFor,
  type ApprovalDependencies,
  type ApprovalStore,
} from "./service.ts";

/**
 * The approval gate: run with `node lib/approvals/verify.ts`.
 *
 * Section 2's chain is four sentences and each of them is a property a screen cannot show: the
 * requester never signs their own request, the queue is the two signers' alone, a request expires, and
 * the same subject cannot be queued twice. This file drives the real service over an in-memory
 * PostgREST, so what passes here is the code a request runs, and it compares the registry to the
 * migration that closes the same vocabulary in SQL.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that the policies of `0095` are the ones a deployment has, and that a
 * person can press the form - those are deployment and browser facts, and the handoff lists the checks
 * a person runs against a real project.
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
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

/** An actor record of `lib/auth`, complete so a scenario cannot pass by leaving a field out. */
function actorOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: "018f2b8a-1111-4c2d-9c3e-0123456789ab",
    companyId: null,
    roles,
    sessionId: "018f2b8a-2222-4c2d-9c3e-0123456789ab",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: 1_800_000_000_000,
    expiresAtEpochMs: 1_800_000_900_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: 1_800_000_000_000,
    reauthenticatedAtEpochMs: 1_800_000_000_000,
    ...overrides,
  };
}

/** The instant every scenario runs at, so an expiry assertion is exact. */
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const EXPIRES_ISO = new Date(NOW + APPROVAL_EXPIRY_MS).toISOString();

interface RecordedAudit extends AuditTrail {
  readonly entries: AuditEntry[];
}

function createAudit(): RecordedAudit {
  const entries: AuditEntry[] = [];

  return {
    entries,
    append(entry: AuditEntry): Promise<void> {
      entries.push(entry);

      return Promise.resolve();
    },
  };
}

type Row = Record<string, unknown>;

interface Filter {
  readonly column: string;
  readonly operator: "eq" | "in" | "isNull";
  readonly values: readonly string[];
}

/** The operators the approval service uses: `eq`, `in` and `is.null`, and nothing else. */
function parseFilters(query: string): { readonly filters: readonly Filter[]; readonly limit: number } {
  const filters: Filter[] = [];
  let limit = 1_000;

  for (const part of query.split("&")) {
    if (part.length === 0 || part.startsWith("select=") || part.startsWith("order=")) {
      continue;
    }

    if (part.startsWith("limit=")) {
      const parsed = Number.parseInt(part.slice("limit=".length), 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed;
      }

      continue;
    }

    const separator = part.indexOf("=");
    const column = decodeURIComponent(part.slice(0, separator));
    const expression = part.slice(separator + 1);

    if (expression === "is.null") {
      filters.push({ column, operator: "isNull", values: [] });
      continue;
    }

    if (expression.startsWith("eq.")) {
      filters.push({ column, operator: "eq", values: [decodeURIComponent(expression.slice(3))] });
      continue;
    }

    if (expression.startsWith("in.(") && expression.endsWith(")")) {
      const list = expression.slice(4, -1);
      const values = list.split(",").map((value) => decodeURIComponent(value.trim()));

      filters.push({ column, operator: "in", values });
      continue;
    }

    throw new Error(`the gate's store does not speak this operator: ${part}`);
  }

  return { filters, limit };
}

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.column];

    if (filter.operator === "isNull") {
      return value === null || value === undefined;
    }

    if (filter.operator === "eq") {
      return String(value ?? "") === filter.values[0];
    }

    return filter.values.some((candidate) => String(value ?? "") === candidate);
  });
}

interface FakeDatabase {
  readonly tables: Record<string, Row[]>;
  readonly queries: string[];
  readonly writes: string[];
  readonly audits: RecordedAudit;
  nextId: number;
}

function createDatabase(): FakeDatabase {
  return {
    tables: {
      approval_requests: [],
      users: [],
      countries: [],
      kyc_submissions: [],
    },
    queries: [],
    writes: [],
    audits: createAudit(),
    nextId: 1,
  };
}

/** The store: PostgREST's four methods, and the identity column a serial row would get. */
function createStore(database: FakeDatabase): ApprovalStore {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      const rows = database.tables[table] ?? [];
      const { filters, limit } = parseFilters(query);

      return Promise.resolve(
        rows.filter((row) => matches(row, filters)).slice(0, limit).map((row) => schema.parse(row)),
      );
    },
    insert(table: string, rows: readonly Row[]): Promise<void> {
      database.writes.push(`insert ${table} ${rows.length}`);

      for (const row of rows) {
        database.tables[table]?.push(stampInserted(database, row));
      }

      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Row[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      database.writes.push(`insertReturning ${table} ${rows.length}`);

      const inserted = rows.map((row) => stampInserted(database, row));

      database.tables[table]?.push(...inserted);

      return Promise.resolve(inserted.map((row) => schema.parse(row)));
    },
    update(table: string, query: string, values: Row): Promise<void> {
      database.writes.push(`update ${table}?${query}`);

      const rows = database.tables[table] ?? [];
      const { filters } = parseFilters(query);

      for (const row of rows) {
        if (!matches(row, filters)) {
          continue;
        }

        for (const [column, value] of Object.entries(values)) {
          row[column] = value;
        }

        row["version"] = Number(row["version"] ?? 1) + 1;
        row["updated_at"] = NOW_ISO;
      }

      return Promise.resolve();
    },
  };
}

function stampInserted(database: FakeDatabase, row: Row): Row {
  const id = `018f2b8a-3333-4c2d-9c3e-${String(database.nextId).padStart(12, "0")}`;

  database.nextId += 1;

  return {
    company_id: null,
    ceo_decided_by: null,
    ceo_decided_at: null,
    ceo_note: null,
    super_admin_confirmed_by: null,
    super_admin_confirmed_at: null,
    super_admin_note: null,
    deleted_at: null,
    version: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...row,
    id,
  };
}

function createDependencies(database: FakeDatabase): ApprovalDependencies {
  return {
    store: createStore(database),
    audit: database.audits,
    now: (): number => NOW,
  };
}

/** The failure a call answered with, as `CODE|rule`, or `no-throw`. */
async function failureOf(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();

    return "no-throw";
  } catch (error) {
    const code = (error as { readonly code?: unknown }).code;
    const details = (error as { readonly details?: unknown }).details;
    const rule =
      Array.isArray(details) && details.length > 0
        ? (details[0] as { readonly rule?: unknown }).rule
        : undefined;

    return `${typeof code === "string" ? code : "unknown"}|${typeof rule === "string" ? rule : ""}`;
  }
}

const SUBJECT_ID = "018f2b8a-4444-4c2d-9c3e-0123456789ab";

const REQUEST = {
  actionType: "platform_fee_change",
  subjectId: SUBJECT_ID,
  subjectLabel: "Platform fee 2.9 percent plus 30 cents",
  amountMinor: null,
  currency: null,
  note: "Quarterly pricing review, approved by the CEO in the meeting of the fourteenth.",
} as const;

/** ---- The registry: four actions, one matrix, and the requester side of the chain. */
function checkRegistry(): void {
  expectEqual(APPROVAL_ACTION_TYPES.length, 4, "section 2 and 36 name four actions that need the chain");
  expect(Object.isFrozen(APPROVAL_ACTION_TYPES), "the vocabulary is frozen");
  expectEqual(
    APPROVAL_ACTION_TYPES.join(","),
    "payout_release,reserve_release,platform_fee_change,country_enable",
    "in the order the migration lists them",
  );
  expectEqual(APPROVAL_STATUSES.length, 6, "six statuses, as the column allows");
  expectEqual(
    APPROVAL_STATUSES.join(","),
    "pending_ceo,pending_super_admin,approved,rejected,cancelled,expired",
    "and they are the migration's",
  );

  for (const action of APPROVAL_ACTION_TYPES) {
    expect(isApprovalActionType(action), `${action} is an action`);
    expect(getMessage(approvalActionLabelKey(action)).length > 0, `${action} has a name in the catalog`);
    expect(requesterRolesOf(action).length > 0, `${action} can be raised by somebody`);
    expect(
      !requesterRolesOf(action).includes("ceo"),
      `${action} cannot be raised by the CEO, who signs it`,
    );
    expect(subjectTypeOf(action).length > 0, `${action} names a subject type`);
  }

  expectEqual(subjectTypeOf("payout_release"), "payout", "a payout release points at a payout");
  expectEqual(subjectTypeOf("reserve_release"), "reserve", "a reserve release at a reserve");
  expectEqual(subjectTypeOf("platform_fee_change"), "plan", "a fee change at a plan");
  expectEqual(subjectTypeOf("country_enable"), "country", "and a country switch at a country");

  expectEqual(isApprovalActionType("refund"), false, "a fifth action is not in this build");
  expectEqual(isApprovalActionType(null), false, "nor is null");
  expectEqual(isApprovalStatus("pending_ceo"), true, "the first stage is a status");
  expectEqual(isApprovalStatus("closed"), false, "and a made up one is not");

  expectEqual(stageOf("pending_ceo"), "ceo", "the first stage is the CEO's desk");
  expectEqual(stageOf("pending_super_admin"), "super_admin", "the second is the super administrator's");
  expectEqual(stageOf("approved"), "closed", "and anything decided is closed");
  expectEqual(stageOf("expired"), "closed", "including an expiry");

  expectEqual(APPROVAL_QUEUE_ROLES.join(","), "ceo,super_admin", "the queue is for the two signers");
  expectEqual(canRequestApproval(["finance_ops"], "payout_release"), true, "finance operations raise payouts");
  expectEqual(canRequestApproval(["finance_ops"], "reserve_release"), true, "and reserves");
  expectEqual(canRequestApproval(["finance_ops"], "platform_fee_change"), false, "but not the platform fee");
  expectEqual(canRequestApproval(["super_admin"], "platform_fee_change"), true, "which the super administrator raises");
  expectEqual(canRequestApproval(["super_admin"], "country_enable"), true, "with the country switch");
  expectEqual(canRequestApproval(["ceo"], "payout_release"), false, "and the CEO raises nothing at all");
  expectEqual(canRequestApproval(["support"], "payout_release"), false, "no other office role raises anything");
  expectEqual(requestableActionsOf(["finance_ops"]).join(","), "payout_release,reserve_release", "the matrix of finance operations");
  expectEqual(requestableActionsOf(["super_admin"]).length, 4, "the super administrator raises all four");
  expectEqual(requestableActionsOf(["ceo"]).length, 0, "and the CEO raises none");

  expectEqual(APPROVAL_LABEL_MAXIMUM_LENGTH, 160, "the label ceiling is the column's");
  expectEqual(APPROVAL_NOTE_MINIMUM_LENGTH, 10, "the note floor is the column's");
  expectEqual(APPROVAL_NOTE_MAXIMUM_LENGTH, 1_000, "and so is its ceiling");
  expectEqual(APPROVAL_EXPIRY_MS, 3 * 24 * 60 * 60 * 1_000, "a request waits three days");

  expectEqual(amountProblemOf({ amountMinor: null, currency: null }), null, "no money is no problem");
  expectEqual(amountProblemOf({ amountMinor: 100, currency: null }), "amount_currency_pair", "an amount without a currency is");
  expectEqual(amountProblemOf({ amountMinor: null, currency: "USD" }), "amount_currency_pair", "and so is a currency without an amount");
  expectEqual(amountProblemOf({ amountMinor: 0, currency: "USD" }), "amount_invalid", "zero is not money");
  expectEqual(amountProblemOf({ amountMinor: -5, currency: "USD" }), "amount_invalid", "nor is a negative");
  expectEqual(amountProblemOf({ amountMinor: 12.5, currency: "USD" }), "amount_invalid", "nor a fraction of a minor unit");
  expectEqual(
    amountProblemOf({ amountMinor: APPROVAL_AMOUNT_MAXIMUM_MINOR + 1, currency: "USD" }),
    "amount_too_large",
    "and an amount past the ceiling is a typo",
  );
  expectEqual(amountProblemOf({ amountMinor: 100, currency: "usd" }), "currency_invalid", "a lower case code is refused here");
  expectEqual(amountProblemOf({ amountMinor: 100, currency: "USD" }), null, "a correct pair is accepted");
  expectEqual(normalizeCurrency(" usd "), "USD", "the form's lower case is fixed in one place");
  expectEqual(normalizeCurrency("dollars"), null, "and a word is not a currency");
}

/** ---- The migration: the same vocabulary, closed in SQL. */
async function checkMigration(): Promise<void> {
  const forward = await readRepositoryFile("migrations/0095_approval_requests.sql");
  const down = await readRepositoryFile("migrations/0095_approval_requests.down.sql");

  expectEqual(forward.split("\n")[0], "-- path: migrations/0095_approval_requests.sql", "the migration states its own path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0095_approval_requests.down.sql", "so does its rollback");
  expect(forward.includes("begin;") && forward.includes("commit;"), "the migration is one transaction");
  expectEqual(/drop\s+table|truncate|delete\s+from/iu.test(forward), false, "a forward migration of this platform removes nothing");
  expect(forward.includes("create table public.approval_requests"), "it creates the queue table");

  for (const action of APPROVAL_ACTION_TYPES) {
    expect(forward.includes(`'${action}'`), `0095 names ${action}`);
  }

  for (const status of APPROVAL_STATUSES) {
    expect(forward.includes(`'${status}'`), `0095 names the status ${status}`);
  }

  expect(forward.includes("(action_type = 'payout_release' and subject_type = 'payout')"), "the subject pairing is a constraint");
  expect(forward.includes("approval_requests_live_key"), "one live request per subject is an index");
  expect(forward.includes("status in ('pending_ceo', 'pending_super_admin')"), "and it covers both waiting statuses");
  expect(forward.includes("enable row level security"), "the table is protected");
  expect(forward.includes("approval_requests_default_deny"), "by an explicit default deny, as 0001 established");
  expect(forward.includes("set_row_metadata"), "and it takes the platform's version trigger");
  expectEqual(forward.includes("create policy approval_requests_office_select"), false, "no browser role reads it: the service is the only door");

  expect(down.includes("drop table if exists public.approval_requests"), "the rollback drops the table");
  expect(down.includes("drop policy if exists approval_requests_default_deny"), "after its policy");
  expect(down.includes("drop trigger if exists approval_requests_set_row_metadata"), "and its trigger");
}

/** ---- Raising a request. */
async function checkRequest(): Promise<void> {
  const database = createDatabase();
  const dependencies = createDependencies(database);
  const actor = actorOf(["super_admin"]);

  const view = await requestApproval({ actor, ...REQUEST }, dependencies);

  expectEqual(view.status, "pending_ceo", "a new request starts at the first desk");
  expectEqual(view.stage, "ceo", "which the view says too");
  expectEqual(view.subjectType, "plan", "the subject type comes from the action, not from the caller");
  expectEqual(view.requesterRole, "super_admin", "and the requester's role is recorded");
  expectEqual(view.expiresAtEpochMs, NOW + APPROVAL_EXPIRY_MS, "it expires three days later");

  const stored = database.tables["approval_requests"]?.[0];

  expectEqual(stored?.["status"], "pending_ceo", "the row says pending at the CEO");
  expectEqual(stored?.["subject_type"], "plan", "the row carries the subject type");
  expectEqual(stored?.["expires_at"], EXPIRES_ISO, "and the expiry the column holds");
  expectEqual(stored?.["requested_at"], NOW_ISO, "with the instant it was raised");
  expectEqual(stored?.["amount_minor"], null, "no money, no amount");
  expectEqual(stored?.["ceo_decided_at"], null, "and no decision yet");

  expectEqual(database.audits.entries.length, 1, "one audit entry was written");
  expectEqual(database.audits.entries[0]?.action, "approval.requested", "it names the action");
  expectEqual(database.audits.entries[0]?.entityType, "approval_request", "and the entity");
  expectEqual(
    JSON.stringify(database.audits.entries[0]?.payload ?? {}).includes(REQUEST.note),
    false,
    "the note itself is not copied into the trail",
  );
  expectEqual(database.audits.entries[0]?.payload["note_length"], REQUEST.note.length, "its length is");

  // Finance operations raise a payout release with money on it, and never see the queue.
  const payout = await requestApproval(
    {
      actor: actorOf(["finance_ops"], { userId: "018f2b8a-5555-4c2d-9c3e-0123456789ab" }),
      actionType: "payout_release",
      subjectId: "018f2b8a-6666-4c2d-9c3e-0123456789ab",
      subjectLabel: "Payout week 44",
      amountMinor: 250_000,
      currency: "USD",
      note: "The batch was reconciled against the processor bill on the fourteenth.",
    },
    dependencies,
  );

  expectEqual(payout.actionType, "payout_release", "a payout release is raised");
  expectEqual(payout.requesterRole, "finance_ops", "by finance operations");
  expectEqual(payout.amountMinor, 250_000, "with the amount the row stores");
  expectEqual(payout.subjectType, "payout", "and the payout subject");

  expectEqual(
    requesterRoleFor(["support", "finance_ops"], "payout_release"),
    "finance_ops",
    "the role a request is recorded under is the one that authorises it",
  );

  // The chain's rules.
  expectEqual(
    await failureOf(() => requestApproval({ actor: actorOf(["ceo"]), ...REQUEST }, dependencies)),
    "PERMISSION_DENIED|",
    "the CEO signs and never raises",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval({ actor: actorOf(["finance_ops"]), ...REQUEST }, dependencies),
    ),
    "PERMISSION_DENIED|",
    "finance operations may not raise the platform fee",
  );
  expectEqual(
    await failureOf(() => requestApproval({ actor: actorOf(["support"]), ...REQUEST }, dependencies)),
    "PERMISSION_DENIED|",
    "and support raises nothing",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval(
        {
          actor: actorOf(["super_admin"], {
            reauthenticatedAtEpochMs: NOW - 3_600_000,
            mfaVerifiedAtEpochMs: NOW - 3_600_000,
          }),
          ...REQUEST,
        },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|reauth_required",
    "a stale second factor cannot raise a request",
  );
  expectEqual(
    await failureOf(() => requestApproval({ actor, ...REQUEST }, dependencies)),
    "CONFLICT|duplicate",
    "the same subject cannot be queued twice",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval({ actor, ...REQUEST, actionType: "refund" }, dependencies),
    ),
    "VALIDATION_FAILED|invalid_format",
    "an action outside the four is refused",
  );
  expectEqual(
    await failureOf(() => requestApproval({ actor, ...REQUEST, subjectId: "not a uuid!" }, dependencies)),
    "VALIDATION_FAILED|invalid_format",
    "a subject id that is not one is refused",
  );
  expectEqual(
    await failureOf(() => requestApproval({ actor, ...REQUEST, note: "too short" }, dependencies)),
    "VALIDATION_FAILED|invalid_length",
    "a nine character note is refused",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval({ actor, ...REQUEST, subjectLabel: "a".repeat(APPROVAL_LABEL_MAXIMUM_LENGTH + 1) }, dependencies),
    ),
    "VALIDATION_FAILED|invalid_length",
    "and so is a label past its column",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval({ actor, ...REQUEST, amountMinor: 500, currency: null }, dependencies),
    ),
    "VALIDATION_FAILED|amount_currency_pair",
    "an amount without a currency is refused",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval({ actor, ...REQUEST, amountMinor: 0, currency: "USD" }, dependencies),
    ),
    "VALIDATION_FAILED|amount_invalid",
    "and zero is not an amount",
  );
  expectEqual(
    await failureOf(() =>
      requestApproval({ actor, ...REQUEST, amountMinor: 100, currency: "usd" }, dependencies),
    ),
    "VALIDATION_FAILED|currency_invalid",
    "the service does not accept a lower case code",
  );
  expectEqual(database.audits.entries.length, 2, "only the two accepted requests were audited");
}

/** ---- Reading the queue. */
async function checkQueue(): Promise<void> {
  const database = createDatabase();

  database.tables["users"] = [
    { id: "018f2b8a-1111-4c2d-9c3e-0123456789ab", full_name: "Ayesha Rahman" },
    { id: "018f2b8a-5555-4c2d-9c3e-0123456789ab", full_name: "Tanvir Ahmed" },
  ];
  database.tables["countries"] = [
    { id: "c1", company_id: null, is_enabled: true, is_sanctioned: false, deleted_at: null },
    { id: "c2", company_id: null, is_enabled: true, is_sanctioned: false, deleted_at: null },
    { id: "c3", company_id: null, is_enabled: false, is_sanctioned: true, deleted_at: null },
    { id: "c4", company_id: null, is_enabled: false, is_sanctioned: false, deleted_at: null },
  ];
  database.tables["kyc_submissions"] = [
    { id: "k1", status: "in_review", deleted_at: null },
    { id: "k2", status: "approved", deleted_at: null },
    { id: "k3", status: "in_review", deleted_at: null },
  ];

  const dependencies = createDependencies(database);

  await requestApproval({ actor: actorOf(["super_admin"]), ...REQUEST }, dependencies);
  await requestApproval(
    {
      actor: actorOf(["finance_ops"], { userId: "018f2b8a-5555-4c2d-9c3e-0123456789ab" }),
      actionType: "payout_release",
      subjectId: "018f2b8a-6666-4c2d-9c3e-0123456789ab",
      subjectLabel: "Payout week 44",
      amountMinor: 250_000,
      currency: "USD",
      note: "The batch was reconciled against the processor bill on the fourteenth.",
    },
    dependencies,
  );
  await requestApproval(
    {
      actor: actorOf(["super_admin"]),
      actionType: "country_enable",
      subjectId: "018f2b8a-7777-4c2d-9c3e-0123456789ab",
      subjectLabel: "Enable Bangladesh",
      amountMinor: null,
      currency: null,
      note: "The sanctions screening of the region came back clear this morning.",
    },
    dependencies,
  );

  // One row moves to the second desk, as STEP 072 will move it.
  const second = database.tables["approval_requests"]?.[1];

  if (second !== undefined) {
    second["status"] = "pending_super_admin";
    second["ceo_decided_by"] = "018f2b8a-1111-4c2d-9c3e-0123456789ab";
    second["ceo_decided_at"] = NOW_ISO;
  }

  const ceoQueue = await listApprovalQueue({ actor: actorOf(["ceo"]) }, dependencies);

  expectEqual(ceoQueue.awaitingCeo.length, 2, "two requests wait at the CEO's desk");
  expectEqual(ceoQueue.awaitingSuperAdmin.length, 1, "and one is behind it");
  expectEqual(
    ceoQueue.awaitingSuperAdmin[0]?.stage,
    "super_admin",
    "the second desk row says whose it is",
  );
  expectEqual(ceoQueue.awaitingCeo[0]?.requesterName, "Ayesha Rahman", "the queue resolves the requester's name");
  expectEqual(
    ceoQueue.awaitingCeo[0]?.requestedAtEpochMs,
    NOW,
    "and orders by the instant it was raised",
  );
  expectEqual(ceoQueue.requestable.length, 0, "the CEO is offered no form, because the CEO signs");
  expectEqual(ceoQueue.readAtEpochMs, NOW, "the queue is read at the runtime's instant");

  const adminQueue = await listApprovalQueue({ actor: actorOf(["super_admin"]) }, dependencies);

  expectEqual(adminQueue.requestable.length, 4, "the super administrator may raise all four");
  expectEqual(adminQueue.awaitingCeo.length, 2, "and sees the same first desk");

  expectEqual(
    await failureOf(() => listApprovalQueue({ actor: actorOf(["finance_ops"]) }, dependencies)),
    "PERMISSION_DENIED|",
    "finance operations never read the queue they raise into",
  );
  expectEqual(
    await failureOf(() => listApprovalQueue({ actor: actorOf(["owner"]) }, dependencies)),
    "PERMISSION_DENIED|",
    "and neither does a merchant",
  );

  // Expiry is derived at read time.
  const late = createDatabase();

  late.tables["approval_requests"] = [
    {
      id: "018f2b8a-8888-4c2d-9c3e-0123456789ab",
      action_type: "country_enable",
      subject_type: "country",
      subject_id: SUBJECT_ID,
      subject_label: "Enable Nepal",
      amount_minor: null,
      currency: null,
      request_note: "The sanctions screening of the region came back clear this morning.",
      requested_by: "018f2b8a-1111-4c2d-9c3e-0123456789ab",
      requested_by_role: "super_admin",
      requested_at: "2027-01-01T00:00:00.000Z",
      expires_at: "2027-01-04T00:00:00.000Z",
      status: "pending_ceo",
      deleted_at: null,
      version: 1,
    },
  ];

  const expiredQueue = await listApprovalQueue({ actor: actorOf(["ceo"]) }, createDependencies(late));

  expectEqual(expiredQueue.awaitingCeo[0]?.expired, true, "a request past its window reads as expired");
  expectEqual(expiredQueue.awaitingCeo[0]?.requesterName, null, "and a missing account leaves the name empty");
}

/** The three accounts a signature test needs, with three different ids. */
const CEO_ACTOR = actorOf(["ceo"], {
  userId: "018f2b8a-aaaa-4c2d-9c3e-000000000001",
});
const ADMIN_ACTOR = actorOf(["super_admin"], {
  userId: "018f2b8a-bbbb-4c2d-9c3e-000000000002",
});
const FINANCE_ACTOR = actorOf(["finance_ops"], {
  userId: "018f2b8a-cccc-4c2d-9c3e-000000000003",
});

const REQUEST_ROW_ID = "018f2b8a-9999-4c2d-9c3e-000000000001";

/** A database with the three signers' names, and the queue empty. */
function createSignatureDatabase(): FakeDatabase {
  const database = createDatabase();

  database.tables["users"] = [
    { id: CEO_ACTOR.userId, full_name: "Chief Executive" },
    { id: ADMIN_ACTOR.userId, full_name: "Platform Owner" },
    { id: FINANCE_ACTOR.userId, full_name: "Finance Officer" },
  ];

  return database;
}

/** One pending request in the queue, at the desk the caller names. */
function seedRequest(database: FakeDatabase, overrides: Row = {}): Row {
  const row: Row = {
    id: REQUEST_ROW_ID,
    action_type: "payout_release",
    subject_type: "payout",
    subject_id: SUBJECT_ID,
    subject_label: "Payout week 44",
    amount_minor: 250_000,
    currency: "USD",
    request_note: "The batch was reconciled against the processor bill on the fourteenth.",
    requested_by: FINANCE_ACTOR.userId,
    requested_by_role: "finance_ops",
    requested_at: NOW_ISO,
    expires_at: new Date(NOW + APPROVAL_EXPIRY_MS).toISOString(),
    status: "pending_ceo",
    ceo_decided_by: null,
    ceo_decided_at: null,
    ceo_note: null,
    super_admin_confirmed_by: null,
    super_admin_confirmed_at: null,
    super_admin_note: null,
    deleted_at: null,
    version: 1,
    ...overrides,
  };

  database.tables["approval_requests"]?.push(row);

  return row;
}

/** ---- The decision vocabulary: two verbs, four outcomes, three people rules. */
function checkDecisionRules(): void {
  expectEqual(APPROVAL_DECISIONS.join(","), "approve,reject", "two decisions exist");
  expect(Object.isFrozen(APPROVAL_DECISIONS), "and the list is frozen");
  expectEqual(isApprovalDecision("approve"), true, "approve is one of them");
  expectEqual(isApprovalDecision("reject"), true, "and reject is the other");
  expectEqual(isApprovalDecision("confirm"), false, "confirm is a word, not a decision");
  expectEqual(isApprovalDecision(""), false, "nor is the empty string");
  expectEqual(isApprovalDecision(null), false, "nor is null");

  expectEqual(decisionRolesOf("ceo").join(","), APPROVAL_CEO_ROLES.join(","), "the first desk is the CEO's");
  expectEqual(decisionRolesOf("super_admin").join(","), APPROVAL_FINAL_ROLES.join(","), "the last desk is the super administrator's");
  expectEqual(decisionRolesOf("ceo").includes("super_admin"), false, "the two desks are disjoint");

  expectEqual(statusAfterDecision("ceo", "approve"), "pending_super_admin", "approval at the first desk hands the row on");
  expectEqual(statusAfterDecision("ceo", "reject"), "rejected", "a rejection at the first desk closes it");
  expectEqual(statusAfterDecision("super_admin", "approve"), "approved", "approval last makes the action allowed");
  expectEqual(statusAfterDecision("super_admin", "reject"), "rejected", "and a rejection last closes it too");

  expectEqual(CLOSED_APPROVAL_STATUSES.join(","), "approved,rejected,cancelled,expired", "four statuses are closed");
  expectEqual(CLOSED_APPROVAL_STATUSES.some((status) => status.startsWith("pending")), false, "none of them is waiting");
  expectEqual(APPROVAL_HISTORY_LIMIT, 10, "the history shows the last ten");

  const auditNames = [
    decisionAuditAction("ceo", "approve"),
    decisionAuditAction("ceo", "reject"),
    decisionAuditAction("super_admin", "approve"),
    decisionAuditAction("super_admin", "reject"),
    "approval.requested",
    "approval.expired",
  ];

  expectEqual(new Set<string>(auditNames).size, auditNames.length, "every audit name is its own");
  expectEqual(auditNames.join(","), "approval.ceo_approved,approval.ceo_rejected,approval.confirmed,approval.final_rejected,approval.requested,approval.expired", "and the six are the four signatures, the request and the lapse");

  for (const name of auditNames) {
    expect(/^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u.test(name), `${name} matches the audit name rule`);
    expect(name.length <= 64, `${name} fits the 64 character ceiling`);
  }

  // The three people rules, one at a time.
  const base = {
    stage: "ceo" as const,
    requesterId: FINANCE_ACTOR.userId,
    ceoDeciderId: null,
  };

  expectEqual(
    signatureProblemOf({ ...base, roles: ["ceo"], actorId: CEO_ACTOR.userId }),
    null,
    "the CEO may sign a request a colleague raised",
  );
  expectEqual(
    signatureProblemOf({ ...base, roles: ["super_admin"], actorId: ADMIN_ACTOR.userId }),
    "role",
    "the super administrator may not pre-empt the first signature",
  );
  expectEqual(
    signatureProblemOf({ ...base, roles: ["ceo"], actorId: FINANCE_ACTOR.userId }),
    "requester_signature",
    "and the requester never signs their own request",
  );
  expectEqual(
    signatureProblemOf({
      roles: ["super_admin"],
      stage: "super_admin",
      actorId: ADMIN_ACTOR.userId,
      requesterId: FINANCE_ACTOR.userId,
      ceoDeciderId: CEO_ACTOR.userId,
    }),
    null,
    "the super administrator takes the last signature",
  );
  expectEqual(
    signatureProblemOf({
      roles: ["super_admin"],
      stage: "super_admin",
      actorId: CEO_ACTOR.userId,
      requesterId: FINANCE_ACTOR.userId,
      ceoDeciderId: CEO_ACTOR.userId,
    }),
    "signer_signature",
    "but the account that approved as the CEO cannot confirm its own approval",
  );
  expectEqual(
    signatureProblemOf({
      roles: ["super_admin", "ceo"],
      stage: "super_admin",
      actorId: ADMIN_ACTOR.userId,
      requesterId: ADMIN_ACTOR.userId,
      ceoDeciderId: CEO_ACTOR.userId,
    }),
    null,
    "a requester may take the last signature once somebody else approved",
  );
  expectEqual(
    signatureProblemOf({ ...base, roles: ["finance_ops"], actorId: "018f2b8a-dddd-4c2d-9c3e-000000000004" }),
    "role",
    "an unrelated office role signs nothing",
  );
}

/** ---- The indexes: what the sweep and the history read by. */
async function checkDecisionIndexes(): Promise<void> {
  const forward = await readRepositoryFile("migrations/0097_approval_decision_indexes.sql");
  const down = await readRepositoryFile("migrations/0097_approval_decision_indexes.down.sql");

  expect(
    forward.includes("create index approval_requests_expiry_idx"),
    "0097 indexes the deadline the sweep reads",
  );
  expect(
    forward.includes("where deleted_at is null and status in ('pending_ceo', 'pending_super_admin')"),
    "over the two pending statuses only",
  );
  expect(
    forward.includes("create index approval_requests_decided_idx"),
    "and the instant the history reads",
  );
  expect(
    forward.includes("where deleted_at is null and status in ('approved', 'rejected', 'expired', 'cancelled')"),
    "over the closed statuses only",
  );
  expect(forward.includes("begin;"), "the forward file is transactional");
  expectEqual(forward.trimEnd().endsWith("commit;"), true, "and commits");
  expectEqual(forward.includes("create table"), false, "it creates no table: 0095 owns the row");
  expect(down.includes("drop index if exists public.approval_requests_decided_idx"), "the rollback drops the history index");
  expect(down.includes("drop index if exists public.approval_requests_expiry_idx"), "and the sweep index");
  expectEqual(down.includes("drop table"), false, "while every decision stays in place");

  // The status vocabulary the two indexes name is the registry's, not a second list.
  const source = await readRepositoryFile("migrations/0095_approval_requests.sql");

  for (const status of CLOSED_APPROVAL_STATUSES) {
    expect(source.includes(`'${status}'`), `0095 knows the ${status} status the history reads`);
  }
}

/** ---- The two signatures, and every way they are refused. */
async function checkSignatures(): Promise<void> {
  const database = createSignatureDatabase();

  seedRequest(database);

  const dependencies = createDependencies(database);

  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: FINANCE_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "finance operations cannot sign the desk they raised the request into",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: ADMIN_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "and the super administrator cannot sign first",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: "018f2b8a-9999-4c2d-9c3e-0000000000ff", decision: "approve", note: null },
        dependencies,
      ),
    ),
    "RESOURCE_NOT_FOUND|",
    "an id the table does not hold is not found",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "confirm", note: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_format",
    "a third verb is refused",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        {
          actor: actorOf(["ceo"], {
            userId: CEO_ACTOR.userId,
            mfaVerifiedAtEpochMs: NOW - 30 * 60_000,
            reauthenticatedAtEpochMs: NOW - 30 * 60_000,
          }),
          approvalId: REQUEST_ROW_ID,
          decision: "approve",
          note: null,
        },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|reauth_required",
    "a stale second factor cannot sign",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "reject", note: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_length",
    "a rejection without a reason is refused",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "reject", note: "no" },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|invalid_length",
    "and so is one too short to read",
  );
  expectEqual(
    database.writes.filter((write) => write.startsWith("update approval_requests")).length,
    0,
    "none of those refusals wrote a row",
  );

  // The first signature, with a note an approval does not have to carry.
  const approved = await decideApproval(
    { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
    dependencies,
  );

  expectEqual(approved.status, "pending_super_admin", "the CEO's approval moves the row to the last desk");
  expectEqual(approved.stage, "super_admin", "which is where the queue shows it now");
  expectEqual(approved.ceoDecidedById, CEO_ACTOR.userId, "and records who signed");
  expectEqual(approved.ceoDecidedByName, "Chief Executive", "with the name the history prints");
  expectEqual(approved.ceoNote, null, "an approval may carry no note");
  expectEqual(approved.version, 2, "the row moved on a version");
  expectEqual(database.audits.entries.at(-1)?.action, "approval.ceo_approved", "the trail names the first signature");
  expectEqual(database.audits.entries.at(-1)?.payload["status_after"], "pending_super_admin", "and the status it left");
  expectEqual(database.audits.entries.at(-1)?.payload["stage"], "ceo", "taken at the first desk");

  // The desk rule first: the CEO's role signs the first desk and not the last.
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "the CEO's role does not sign at the last desk",
  );

  // The identity rule next: an account that holds both roles still takes one signature per request.
  const bothRoles = actorOf(["ceo", "super_admin"], { userId: CEO_ACTOR.userId });

  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: bothRoles, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|signer_signature",
    "an account that approved as the CEO cannot take the last signature on the same request",
  );
  expectEqual(
    await failureOf(() =>
      decideApproval(
        {
          actor: bothRoles,
          approvalId: REQUEST_ROW_ID,
          decision: "reject",
          note: "Changed my mind after the review.",
        },
        dependencies,
      ),
    ),
    "VALIDATION_FAILED|signer_signature",
    "and cannot withdraw its own signature by rejecting at the last desk",
  );

  const confirmed = await decideApproval(
    { actor: ADMIN_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: "Released after the bill was matched." },
    dependencies,
  );

  expectEqual(confirmed.status, "approved", "the last signature approves the action");
  expectEqual(confirmed.stage, "closed", "and closes the row");
  expectEqual(confirmed.superAdminConfirmedById, ADMIN_ACTOR.userId, "recording the account that signed");
  expectEqual(confirmed.superAdminNote, "Released after the bill was matched.", "and the note it left");
  expectEqual(database.audits.entries.at(-1)?.action, "approval.confirmed", "the trail names the confirmation");
  expectEqual(database.audits.entries.at(-1)?.payload["status_before"], "pending_super_admin", "with the status before it");
  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: ADMIN_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        dependencies,
      ),
    ),
    "CONFLICT|not_pending",
    "a decided request is not decided twice",
  );

  const queue = await listApprovalQueue({ actor: CEO_ACTOR }, dependencies);

  expectEqual(queue.awaitingCeo.length, 0, "nothing waits at the first desk any more");
  expectEqual(queue.awaitingSuperAdmin.length, 0, "nor at the last");
  expectEqual(queue.recent.length, 1, "and the decided row is in the history");
  expectEqual(queue.recent[0]?.status, "approved", "as an approved request");
  expectEqual(queue.recent[0]?.superAdminConfirmedByName, "Platform Owner", "with the signer named");

  // A rejection at the first desk closes the request for good.
  const rejectedDatabase = createSignatureDatabase();

  seedRequest(rejectedDatabase);

  const rejectedDependencies = createDependencies(rejectedDatabase);
  const rejected = await decideApproval(
    {
      actor: CEO_ACTOR,
      approvalId: REQUEST_ROW_ID,
      decision: "reject",
      note: "The processor bill for this batch is still unmatched.",
    },
    rejectedDependencies,
  );

  expectEqual(rejected.status, "rejected", "a rejection closes the row at the first desk");
  expectEqual(rejected.ceoNote, "The processor bill for this batch is still unmatched.", "keeping the reason");
  expectEqual(rejectedDatabase.audits.entries.at(-1)?.action, "approval.ceo_rejected", "and the trail says who closed it");
  expectEqual(
    rejectedDatabase.audits.entries.at(-1)?.payload["note_length"],
    "The processor bill for this batch is still unmatched.".length,
    "with the note's length rather than its text",
  );
  expectEqual(
    JSON.stringify(rejectedDatabase.audits.entries.at(-1)?.payload).includes("processor bill"),
    false,
    "so the sentence stays out of the trail",
  );

  // A rejection at the last desk, and a lapsed request, both end the chain.
  const finalRejectDatabase = createSignatureDatabase();

  seedRequest(finalRejectDatabase, {
    status: "pending_super_admin",
    ceo_decided_by: CEO_ACTOR.userId,
    ceo_decided_at: NOW_ISO,
  });

  const finalRejectDependencies = createDependencies(finalRejectDatabase);

  expectEqual(
    await failureOf(() =>
      decideApproval(
        {
          actor: actorOf(["ceo", "super_admin"], { userId: CEO_ACTOR.userId }),
          approvalId: REQUEST_ROW_ID,
          decision: "reject",
          note: "Closing this at the last desk.",
        },
        finalRejectDependencies,
      ),
    ),
    "VALIDATION_FAILED|signer_signature",
    "the first signer cannot close the request at the last desk either",
  );

  const finalRejected = await decideApproval(
    { actor: ADMIN_ACTOR, approvalId: REQUEST_ROW_ID, decision: "reject", note: "The reserve is not funded for this release." },
    finalRejectDependencies,
  );

  expectEqual(finalRejected.status, "rejected", "the super administrator may reject last");
  expectEqual(finalRejectDatabase.audits.entries.at(-1)?.action, "approval.final_rejected", "and the trail names that rejection");

  const lapsedDatabase = createSignatureDatabase();

  seedRequest(lapsedDatabase, { expires_at: new Date(NOW - 1_000).toISOString() });

  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        createDependencies(lapsedDatabase),
      ),
    ),
    "CONFLICT|expired",
    "a request past its window is not revived by a late signature",
  );

  // A row that moved between the read and the write answers conflict, not success.
  const racedDatabase = createSignatureDatabase();

  seedRequest(racedDatabase);

  const racedDependencies = createDependencies(racedDatabase);
  const raced: ApprovalDependencies = {
    audit: racedDependencies.audit,
    now: (): number => NOW,
    store: {
      ...racedDependencies.store,
      update(_table: string, query: string, values: Readonly<Record<string, unknown>>) {
        const rows = racedDatabase.tables["approval_requests"] ?? [];

        for (const row of rows) {
          row["version"] = 7;
        }

        return racedDependencies.store.update(_table, query, values);
      },
    },
  };

  expectEqual(
    await failureOf(() =>
      decideApproval(
        { actor: CEO_ACTOR, approvalId: REQUEST_ROW_ID, decision: "approve", note: null },
        raced,
      ),
    ),
    "CONFLICT|changed",
    "a signature whose update matched no row is a conflict rather than a success",
  );
}

/** ---- The sweep: what lapsed is closed, what was decided is not touched. */
async function checkExpirySweep(): Promise<void> {
  const database = createSignatureDatabase();

  seedRequest(database, { id: "018f2b8a-9999-4c2d-9c3e-00000000000a", expires_at: new Date(NOW - 3_600_000).toISOString() });
  seedRequest(database, {
    id: "018f2b8a-9999-4c2d-9c3e-00000000000b",
    status: "pending_super_admin",
    ceo_decided_by: CEO_ACTOR.userId,
    ceo_decided_at: NOW_ISO,
    expires_at: new Date(NOW - 60_000).toISOString(),
  });
  seedRequest(database, { id: "018f2b8a-9999-4c2d-9c3e-00000000000c" });

  const dependencies = createDependencies(database);
  const sweep = await expireLapsedApprovals({}, dependencies);

  expectEqual(sweep.examined, 3, "the sweep looks at the pending rows");
  expectEqual(sweep.expired, 2, "and closes the two whose window has passed");
  expectEqual(sweep.skipped, 0, "with nothing moved under it");
  expectEqual(sweep.sweptAtEpochMs, NOW, "at the instant the runtime gave it");
  expectEqual(
    database.audits.entries.filter((entry) => entry.action === "approval.expired").length,
    2,
    "each lapse is on the trail",
  );
  expectEqual(
    database.tables["approval_requests"]?.find((row) => row["id"] === "018f2b8a-9999-4c2d-9c3e-00000000000c")?.["status"],
    "pending_ceo",
    "and a request inside its window is untouched",
  );
  expectEqual(
    database.tables["approval_requests"]?.find((row) => row["id"] === "018f2b8a-9999-4c2d-9c3e-00000000000a")?.["ceo_decided_by"],
    null,
    "a lapsed row keeps no decision it never had",
  );

  const again = await expireLapsedApprovals({}, dependencies);

  expectEqual(again.expired, 0, "a second sweep finds nothing to close");
  expectEqual(
    database.audits.entries.filter((entry) => entry.action === "approval.expired").length,
    2,
    "and writes no second entry for the same lapse",
  );

  // A sweep racing a signer never overwrites a signature with a lapse.
  const racedDatabase = createSignatureDatabase();

  seedRequest(racedDatabase, { expires_at: new Date(NOW - 3_600_000).toISOString() });

  const racedDependencies = createDependencies(racedDatabase);
  const raced: ApprovalDependencies = {
    audit: racedDependencies.audit,
    now: (): number => NOW,
    store: {
      ...racedDependencies.store,
      update(_table: string, query: string, values: Readonly<Record<string, unknown>>) {
        const rows = racedDatabase.tables["approval_requests"] ?? [];

        for (const row of rows) {
          row["status"] = "pending_super_admin";
          row["version"] = 4;
        }

        return racedDependencies.store.update(_table, query, values);
      },
    },
  };

  const racedSweep = await expireLapsedApprovals({}, raced);

  expectEqual(racedSweep.expired, 0, "a row that moved under the sweep is not closed");
  expectEqual(racedSweep.skipped, 1, "it is counted as a skip");

  // The bound is honoured.
  const bounded = createSignatureDatabase();

  seedRequest(bounded, { id: "018f2b8a-9999-4c2d-9c3e-00000000001a", expires_at: new Date(NOW - 3_600_000).toISOString() });
  seedRequest(bounded, { id: "018f2b8a-9999-4c2d-9c3e-00000000001b", expires_at: new Date(NOW - 3_600_000).toISOString() });

  const boundedSweep = await expireLapsedApprovals({ limit: 1 }, createDependencies(bounded));

  expectEqual(boundedSweep.examined, 1, "a limit bounds one sweep");
  expectEqual(boundedSweep.expired, 1, "which closes what it examined");
}

/** ---- The two platform summaries. */
async function checkDecisions(): Promise<void> {
  const database = createDatabase();

  database.tables["countries"] = [
    { id: "c1", company_id: null, is_enabled: true, is_sanctioned: false, deleted_at: null },
    { id: "c2", company_id: null, is_enabled: false, is_sanctioned: false, deleted_at: null },
    { id: "c3", company_id: null, is_enabled: false, is_sanctioned: true, deleted_at: null },
  ];
  database.tables["kyc_submissions"] = [
    { id: "k1", status: "in_review", deleted_at: null },
    { id: "k2", status: "submitted", deleted_at: null },
  ];

  const dependencies = createDependencies(database);
  const summary = await readPlatformDecisions({ actor: actorOf(["ceo"]) }, dependencies);

  expectEqual(summary.countriesEnabled, 1, "one country is on");
  expectEqual(summary.countriesDisabled, 2, "two are off");
  expectEqual(summary.countriesSanctioned, 1, "one of them permanently");
  expectEqual(summary.kycAwaitingFinalDecision, 1, "and one KYC submission waits for the final decision");

  expectEqual(
    await failureOf(() => readPlatformDecisions({ actor: actorOf(["finance_ops"]) }, dependencies)),
    "PERMISSION_DENIED|",
    "the summaries are the signers' too",
  );
}

/** ---- The route, the screens and the copy. */
async function checkSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/office/approvals/route.ts");
  const page = await readRepositoryFile("app/(admin)/ceo/page.tsx");
  const form = await readRepositoryFile("app/(admin)/ceo/approval-request-form.tsx");

  expectEqual(route.split("\n")[0], "// path: app/api/office/approvals/route.ts", "the route states its own path");
  expect(route.includes("requireCsrfToken("), "the route checks the CSRF token first");
  expect(route.includes('get("content-length")'), "and bounds the body before reading it");
  expect(route.includes("request.text()"), "and reads the body once, as the text the proof covers");
  expect(route.includes("verifySensitiveRequest("), "and verifies the device proof");
  expect(route.includes("requireTrustedDevice("), "and refuses an unconfirmed device");
  expect(
    route.indexOf("verifySensitiveRequest(") < route.indexOf("JSON.parse("),
    "before it parses the body",
  );
  expectEqual(route.includes("console."), false, "the route logs nothing through the console");
  expectEqual(/\bas any\b/u.test(route), false, "and writes no any");
  expect(isSensitivePath("/api/office/approvals"), "the route is on the device proof list");
  expect(CSRF_PROTECTED_PATHS.includes("/api/office/approvals"), "and on the CSRF protected list");

  const decisionForm = await readRepositoryFile("app/(admin)/ceo/approval-decision-form.tsx");

  for (const [path, source] of [
    ["app/(admin)/ceo/page.tsx", page],
    ["app/(admin)/ceo/approval-request-form.tsx", form],
    ["app/(admin)/ceo/approval-decision-form.tsx", decisionForm],
  ] as const) {
    const body = source.split("\n").slice(1).join("\n");

    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path`);
    expectEqual(body.includes("console."), false, `${path} logs nothing`);
    expectEqual(/:\s*any\b/u.test(body), false, `${path} writes no any`);
  }

  expect(page.includes("listApprovalQueue("), "the page reads through the service");
  expect(page.includes("readPlatformDecisions("), "and its two summaries through the same module");
  expectEqual(page.includes("<main"), false, "the page renders no landmark: the shell owns it");
  expect(form.includes("deviceProofHeaders("), "the request form signs its post");
  expect(form.includes('"/api/office/approvals"'), "to the one approval route");
  expect(form.includes("csrfHeaders("), "with the CSRF header");
  expectEqual(form.includes("note"), true, "and a note, which the CEO reads");

  // ---- STEP 072: the decision, on the same route and the same row
  expect(route.includes('action === "decide"'), "the route takes the decision action");
  expect(route.includes("decideApproval("), "and hands it to the service");
  expect(route.includes('readText(body, "approvalId")'), "reading the row it settles");
  expect(route.includes('readText(body, "decision")'), "the decision");
  expect(route.includes("readNote(body)"), "and an optional note");
  expectEqual(route.includes("DELETE"), false, "a decision is never a delete");

  expect(page.includes("ApprovalDecisionForm"), "the page renders a form only where a signature may be taken");
  expect(page.includes("signatureProblemOf("), "asking the one rule the service refuses with");
  expect(page.includes('id="ceo-recent"'), "and shows what was decided recently");
  expect(page.includes("statusLabel("), "naming each closed status in words");
  expectEqual(page.includes("super_admin"), false, "the page still writes no role name");

  expect(decisionForm.includes("deviceProofHeaders("), "the decision form signs its post");
  expect(decisionForm.includes('"/api/office/approvals"'), "to the same route as the request");
  expect(decisionForm.includes("csrfHeaders("), "with the CSRF header");
  expect(decisionForm.includes('"decide"'), "naming the decision action");
  expect(decisionForm.includes('sign("approve")'), "offering the approval");
  expect(decisionForm.includes('sign("reject")'), "and the rejection");
  expectEqual(decisionForm.includes("console."), false, "the form logs nothing");
  expectEqual(/:\s*any\b/u.test(decisionForm), false, "and writes no any");
}

/** ---- The copy: every path exists, and the two parameterised ones render. */
function checkCopy(): void {
  const paths: readonly MessagePath[] = [
    "officeApprovals.eyebrow",
    "officeApprovals.title",
    "officeApprovals.description",
    "officeApprovals.queueHeading",
    "officeApprovals.queueDescription",
    "officeApprovals.queueEmpty",
    "officeApprovals.nextHeading",
    "officeApprovals.nextEmpty",
    "officeApprovals.nextDescription",
    "officeApprovals.stageCeo",
    "officeApprovals.stageFinal",
    "officeApprovals.expiredBadge",
    "officeApprovals.actionPayoutRelease",
    "officeApprovals.actionReserveRelease",
    "officeApprovals.actionPlatformFeeChange",
    "officeApprovals.actionCountryEnable",
    "officeApprovals.subjectLabel",
    "officeApprovals.amountLabel",
    "officeApprovals.requesterLabel",
    "officeApprovals.requesterUnknown",
    "officeApprovals.requestedAtLabel",
    "officeApprovals.expiresAtLabel",
    "officeApprovals.noteLabel",
    "officeApprovals.raiseHeading",
    "officeApprovals.raiseDescription",
    "officeApprovals.actionTypeLabel",
    "officeApprovals.subjectIdLabel",
    "officeApprovals.subjectLabelLabel",
    "officeApprovals.amountLabelForm",
    "officeApprovals.currencyLabel",
    "officeApprovals.noteFieldLabel",
    "officeApprovals.noteHint",
    "officeApprovals.raiseSubmit",
    "officeApprovals.raiseBusy",
    "officeApprovals.raisedDone",
    "officeApprovals.cannotRaise",
    "officeApprovals.duplicateRequest",
    "officeApprovals.amountPairProblem",
    "officeApprovals.amountInvalid",
    "officeApprovals.unknownAction",
    "officeApprovals.countriesHeading",
    "officeApprovals.countriesNote",
    "officeApprovals.kycHeading",
    "officeApprovals.kycNote",
    "officeApprovals.recentHeading",
    "officeApprovals.recentDescription",
    "officeApprovals.recentEmpty",
    "officeApprovals.statusApproved",
    "officeApprovals.statusRejected",
    "officeApprovals.statusExpired",
    "officeApprovals.statusCancelled",
    "officeApprovals.ceoDecisionLabel",
    "officeApprovals.ceoNoteLabel",
    "officeApprovals.finalSignatureLabel",
    "officeApprovals.finalNoteLabel",
    "officeApprovals.decidedAtLabel",
    "officeApprovals.decisionNoteLabel",
    "officeApprovals.decisionNoteHint",
    "officeApprovals.approveLabel",
    "officeApprovals.confirmLabel",
    "officeApprovals.rejectLabel",
    "officeApprovals.decisionBusy",
    "officeApprovals.approvedDone",
    "officeApprovals.rejectedDone",
    "officeApprovals.confirmedDone",
    "officeApprovals.rejectNeedsNote",
    "officeApprovals.notPending",
    "officeApprovals.expiredRequest",
    "officeApprovals.requesterSignature",
    "officeApprovals.signerSignature",
    "officeApprovals.roleCannotSign",
    "officeApprovals.reauthRequired",
    "officeApprovals.forbidden",
    "officeApprovals.signedOut",
    "officeApprovals.unavailable",
    "officeApprovals.failed",
    "officeApprovals.conflict",
    "officeApprovals.home",
    "office.sectionCeo",
    "office.sectionCeoDescription",
  ];

  for (const path of paths) {
    const message = getMessage(path);

    expect(message.length > 0, `${path} is in the catalog`);
    expectEqual(message, message.trim(), `${path} is trimmed`);
    expectEqual(message.includes("{"), false, `${path} has no placeholder this screen would not fill`);
  }

  expect(
    formatMessage("officeApprovals.countriesSummary", {
      enabled: 249,
      disabled: 0,
      sanctioned: 12,
    }).includes("249 enabled"),
    "the country summary fills its three counts",
  );
  expect(
    formatMessage("officeApprovals.kycCount", { count: 3 }).startsWith("3 submissions"),
    "and the KYC sentence fills its count",
  );
  expectEqual(
    getMessage("officeApprovals.queueEmpty").endsWith("."),
    true,
    "an empty queue is a sentence, not a blank space",
  );
}

async function main(): Promise<void> {
  checkRegistry();
  checkDecisionRules();
  await checkMigration();
  await checkDecisionIndexes();
  await checkRequest();
  await checkQueue();
  await checkDecisions();
  await checkSignatures();
  await checkExpirySweep();
  await checkSources();
  checkCopy();

  if (failures.length > 0) {
    process.stderr.write(`approval gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `approval gate passed: ${checks} checks, ${APPROVAL_ACTION_TYPES.length} actions, ` +
      `${APPROVAL_STATUSES.length} statuses, ${APPROVAL_QUEUE_ROLES.length} signer roles\n`,
  );
}

await main();
