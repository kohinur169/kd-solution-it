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
  APPROVAL_EXPIRY_MS,
  APPROVAL_LABEL_MAXIMUM_LENGTH,
  APPROVAL_NOTE_MAXIMUM_LENGTH,
  APPROVAL_NOTE_MINIMUM_LENGTH,
  APPROVAL_QUEUE_ROLES,
  APPROVAL_STATUSES,
  amountProblemOf,
  approvalActionLabelKey,
  canRequestApproval,
  isApprovalActionType,
  isApprovalStatus,
  requestableActionsOf,
  requesterRolesOf,
  stageOf,
  subjectTypeOf,
} from "./registry.ts";
import {
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

  for (const [path, source] of [
    ["app/(admin)/ceo/page.tsx", page],
    ["app/(admin)/ceo/approval-request-form.tsx", form],
  ] as const) {
    const body = source.split("\n").slice(1).join("\n");

    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path`);
    expectEqual(body.includes("console."), false, `${path} logs nothing`);
    expectEqual(/:\s*any\b/u.test(body), false, `${path} writes no any`);
  }

  expect(page.includes("listApprovalQueue("), "the page reads through the service");
  expect(page.includes("readPlatformDecisions("), "and its two summaries through the same module");
  expectEqual(page.includes("<main"), false, "the page renders no landmark: the shell owns it");
  expect(form.includes("deviceProofHeaders("), "the form signs its post");
  expect(form.includes('"/api/office/approvals"'), "to the one approval route");
  expect(form.includes("csrfHeaders("), "with the CSRF header");
  expectEqual(form.includes("note"), true, "and a note, which the CEO reads");
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
  await checkMigration();
  await checkRequest();
  await checkQueue();
  await checkDecisions();
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
