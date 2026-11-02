// path: lib/countries/verify.ts
import { readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isSensitivePath } from "../auth/request-proof.ts";
import { STEP_UP_WINDOW_MS } from "../auth/step-up.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import {
  APPROVAL_ACTION_TYPES,
  PENDING_APPROVAL_STATUSES,
  requesterRolesOf,
  subjectTypeOf,
} from "../approvals/registry.ts";
import { formatMessage, getMessage, type MessagePath } from "../i18n/messages.ts";
import { en } from "../i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import {
  COUNTRY_AUDIT_ACTIONS,
  COUNTRY_DISABLED_AUDIT_ACTION,
  COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH,
  COUNTRY_DISABLE_REASON_MINIMUM_LENGTH,
  COUNTRY_ENABLE_ACTION,
  COUNTRY_ENABLED_AUDIT_ACTION,
  COUNTRY_SWITCH_LIMIT,
  COUNTRY_SWITCH_ROLES,
  countryStateLabelKey,
  countrySwitchStateOf,
  disableProblemOf,
  enableProblemOf,
  requestProblemOf,
  type CountrySwitchState,
} from "./registry.ts";
import {
  disableCountry,
  enableCountry,
  listCountrySwitches,
  requestCountryEnable,
  type CountryDependencies,
  type CountryStore,
  type CountrySwitchSnapshot,
} from "./service.ts";

/**
 * The country switch gate: run with `node lib/countries/verify.ts`.
 *
 * Section 3 is four sentences, and three of them are properties no screen can show:
 *
 *   1. **The switch is the two controllers' alone.** Every entry point refuses every other role, and
 *      refuses a stale second factor with the one rule STEP 053 names.
 *   2. **A sanctioned country never opens.** The service refuses it before it writes, the list never
 *      offers it, and `0076`'s check constraint refuses it again in the database.
 *   3. **An opening spends a decision.** A country can only open with an approved request behind it,
 *      one decision opens one market once, and a decision whose switch did not move is given back
 *      rather than burned.
 *
 * The service is driven over an in-memory PostgREST with the four methods `RestClient` exposes, so
 * what passes here is the code the route runs. The screens and the SQL are read as source, because a
 * `.tsx` file cannot be imported by plain Node and a migration is a document until it is applied.
 *
 * ## What it cannot prove
 *
 * That PostgREST is reachable, that `0098` was applied to a particular project, and that a person can
 * press the two buttons - those are deployment and browser facts, and the handoff lists the checks a
 * person runs against a real project.
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

/** The instant every scenario runs at, so an expiry assertion is exact. */
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const LATER_ISO = new Date(NOW + 3 * 24 * 60 * 60 * 1_000).toISOString();
const LAPSED_ISO = new Date(NOW - 60_000).toISOString();

const SUPER_ADMIN_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const CEO_ID = "018f2b8a-1111-4c2d-9c3e-000000000002";

/** An actor record of `lib/auth`, complete so a scenario cannot pass by leaving a field out. */
function actorOf(roles: readonly PlatformRole[], overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: SUPER_ADMIN_ID,
    companyId: null,
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

const superAdmin = actorOf(["super_admin"]);
const ceo = actorOf(["ceo"], { userId: CEO_ID });
const staleSuperAdmin = actorOf(["super_admin"], {
  mfaVerifiedAtEpochMs: NOW - STEP_UP_WINDOW_MS - 1,
  reauthenticatedAtEpochMs: NOW - STEP_UP_WINDOW_MS - 1,
});

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

/** The operators the country service uses: `eq`, `in` and `is.null`, and nothing else. */
function parseFilters(query: string): { readonly filters: readonly Filter[]; readonly limit: number } {
  const filters: Filter[] = [];
  let limit = 1_000;

  for (const part of query.split("&")) {
    if (
      part.length === 0 ||
      part.startsWith("select=") ||
      part.startsWith("order=") ||
      part.startsWith("offset=")
    ) {
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
  /** Called before every update, so a scenario can stage a write that lands in between two of ours. */
  beforeUpdate?: (table: string, query: string) => void;
}

function createDatabase(): FakeDatabase {
  return {
    tables: { countries: [], approval_requests: [] },
    queries: [],
    writes: [],
    audits: createAudit(),
    nextId: 1,
  };
}

/** The store: PostgREST's four methods, `set_row_metadata`'s version bump, and no other behaviour. */
function createStore(database: FakeDatabase): CountryStore {
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
      database.writes.push(`insert ${table} ${String(rows.length)}`);

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
      database.writes.push(`insertReturning ${table} ${String(rows.length)}`);

      const inserted = rows.map((row) => stampInserted(database, row));

      database.tables[table]?.push(...inserted);

      return Promise.resolve(inserted.map((row) => schema.parse(row)));
    },
    update(table: string, query: string, values: Row): Promise<void> {
      database.writes.push(`update ${table}?${query}`);
      database.beforeUpdate?.(table, query);

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
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    deleted_at: null,
    version: 1,
    ceo_decided_by: null,
    ceo_decided_at: null,
    ceo_note: null,
    super_admin_confirmed_by: null,
    super_admin_confirmed_at: null,
    super_admin_note: null,
    consumed_at: null,
    consumed_by: null,
    ...row,
    id: typeof row["id"] === "string" ? row["id"] : id,
  };
}

function createDependencies(database: FakeDatabase): CountryDependencies {
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

/** The country rows the scenarios use. Every one is off unless the scenario says otherwise. */
const COUNTRY_OPEN = "018f2b8a-7777-4c2d-9c3e-000000000001";
const COUNTRY_CLOSED = "018f2b8a-7777-4c2d-9c3e-000000000002";
const COUNTRY_SANCTIONED = "018f2b8a-7777-4c2d-9c3e-000000000003";
const COUNTRY_PENDING = "018f2b8a-7777-4c2d-9c3e-000000000004";
const APPROVAL_ONE = "018f2b8a-8888-4c2d-9c3e-000000000001";
const APPROVAL_TWO = "018f2b8a-8888-4c2d-9c3e-000000000002";
const APPROVAL_THREE = "018f2b8a-8888-4c2d-9c3e-000000000003";

const SANCTION_NOTE = "Comprehensive United States embargo administered by OFAC.";
const CLOSE_REASON = "Closed while the processor reviews the chargeback wave of March.";

function countryRow(overrides: Row = {}): Row {
  return {
    company_id: null,
    code: "BD",
    alpha3: "BGD",
    name: "Bangladesh",
    is_enabled: false,
    is_sanctioned: false,
    sanction_note: null,
    disabled_reason: null,
    deleted_at: null,
    version: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

function approvalRow(overrides: Row = {}): Row {
  return {
    company_id: null,
    action_type: COUNTRY_ENABLE_ACTION,
    subject_type: "country",
    subject_id: COUNTRY_CLOSED,
    subject_label: "Bangladesh (BD)",
    amount_minor: null,
    currency: null,
    request_note: "Open Bangladesh for merchant onboarding this quarter.",
    requested_by: SUPER_ADMIN_ID,
    requested_by_role: "super_admin",
    requested_at: NOW_ISO,
    expires_at: LATER_ISO,
    status: "approved",
    ceo_decided_by: CEO_ID,
    ceo_decided_at: NOW_ISO,
    ceo_note: null,
    super_admin_confirmed_by: "018f2b8a-1111-4c2d-9c3e-000000000003",
    super_admin_confirmed_at: NOW_ISO,
    super_admin_note: null,
    consumed_at: null,
    consumed_by: null,
    deleted_at: null,
    version: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...overrides,
  };
}

/** The world the read scenarios share: one open, one closed with a decision, one sanctioned, one waiting. */
function seedWorld(database: FakeDatabase): void {
  database.tables["countries"] = [
    countryRow({ id: COUNTRY_OPEN, code: "BD", alpha3: "BGD", name: "Bangladesh", is_enabled: true }),
    countryRow({ id: COUNTRY_CLOSED, code: "NP", alpha3: "NPL", name: "Nepal" }),
    countryRow({
      id: COUNTRY_SANCTIONED,
      code: "IR",
      alpha3: "IRN",
      name: "Islamic Republic of Iran",
      is_sanctioned: true,
      sanction_note: SANCTION_NOTE,
    }),
    countryRow({ id: COUNTRY_PENDING, code: "PK", alpha3: "PAK", name: "Pakistan" }),
  ];
  database.tables["approval_requests"] = [
    approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_CLOSED }),
    approvalRow({
      id: APPROVAL_TWO,
      subject_id: COUNTRY_PENDING,
      status: "pending_ceo",
      ceo_decided_by: null,
      ceo_decided_at: null,
      super_admin_confirmed_by: null,
      super_admin_confirmed_at: null,
    }),
  ];
}

function rowOf(database: FakeDatabase, table: string, id: string): Row | undefined {
  return (database.tables[table] ?? []).find((row) => row["id"] === id);
}

function viewOf(snapshot: CountrySwitchSnapshot, countryId: string): CountrySwitchSnapshot["countries"][number] | undefined {
  return snapshot.countries.find((country) => country.id === countryId);
}

const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/u;

/** ---- The registry: three states, three refusals, and the two controllers. */
function checkRegistry(): void {
  expect(Object.isFrozen(COUNTRY_SWITCH_ROLES), "the controller list is frozen");
  expectEqual(
    COUNTRY_SWITCH_ROLES.slice().sort().join(","),
    "ceo,super_admin",
    "section 3 gives the switch to the super administrator and the chief executive",
  );
  expectEqual(COUNTRY_SWITCH_ROLES.length, 2, "and to nobody else");

  for (const role of COUNTRY_SWITCH_ROLES) {
    expect(
      ["super_admin", "ceo", "compliance_kyc", "finance_ops", "support", "blogger"].includes(role),
      `${role} is an office role`,
    );
  }

  expectEqual(COUNTRY_ENABLE_ACTION, "country_enable", "an opening spends the chain's country action");
  expect(
    APPROVAL_ACTION_TYPES.includes(COUNTRY_ENABLE_ACTION),
    "which is one of the four actions section 2 and 36 name",
  );
  expectEqual(subjectTypeOf(COUNTRY_ENABLE_ACTION), "country", "and its subject is a country row");
  expectEqual(
    requesterRolesOf(COUNTRY_ENABLE_ACTION).join(","),
    "super_admin",
    "only the super administrator may raise it, because the CEO signs it",
  );

  expectEqual(
    countrySwitchStateOf({ isEnabled: true, isSanctioned: false }),
    "enabled",
    "an open country is enabled",
  );
  expectEqual(
    countrySwitchStateOf({ isEnabled: false, isSanctioned: false }),
    "disabled",
    "a closed one is disabled",
  );
  expectEqual(
    countrySwitchStateOf({ isEnabled: false, isSanctioned: true }),
    "sanctioned",
    "and a sanctioned one is its own state, even though it is off",
  );

  const states: readonly CountrySwitchState[] = ["enabled", "disabled", "sanctioned"];
  const labelKeys = new Set<string>();

  for (const state of states) {
    const key = countryStateLabelKey(state);

    expect(getMessage(key).length > 0, `${state} has a badge in the catalog`);
    labelKeys.add(key);
  }

  expectEqual(labelKeys.size, 3, "each state has its own badge");

  // The three refusals, in the order an operator meets them.
  expectEqual(
    enableProblemOf({ state: "sanctioned", hasApproval: true }),
    "sanctioned",
    "a sanctioned country cannot open, even with a decision behind it",
  );
  expectEqual(enableProblemOf({ state: "enabled", hasApproval: false }), "already_on", "an open country cannot open");
  expectEqual(
    enableProblemOf({ state: "disabled", hasApproval: false }),
    "approval_required",
    "and a closed one without a decision cannot either",
  );
  expectEqual(enableProblemOf({ state: "disabled", hasApproval: true }), null, "one with a decision can");
  expectEqual(disableProblemOf({ state: "sanctioned" }), "sanctioned", "a sanctioned country cannot be closed again");
  expectEqual(disableProblemOf({ state: "disabled" }), "already_off", "nor can a closed one");
  expectEqual(disableProblemOf({ state: "enabled" }), null, "an open one can");
  expectEqual(
    requestProblemOf({ state: "sanctioned", hasLiveRequest: false }),
    "sanctioned",
    "nobody asks for a sanctioned country",
  );
  expectEqual(requestProblemOf({ state: "enabled", hasLiveRequest: false }), "already_on", "nor for an open one");
  expectEqual(
    requestProblemOf({ state: "disabled", hasLiveRequest: true }),
    "already_pending",
    "nor twice for the same closed one",
  );
  expectEqual(requestProblemOf({ state: "disabled", hasLiveRequest: false }), null, "and otherwise they may");

  expectEqual(
    COUNTRY_DISABLE_REASON_MINIMUM_LENGTH,
    10,
    "the reason's lower bound is the one 0098's check uses",
  );
  expectEqual(
    COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH,
    280,
    "and so is its upper bound",
  );
  expect(COUNTRY_SWITCH_LIMIT >= 250, "one read returns the whole ISO 3166-1 list");

  for (const action of COUNTRY_AUDIT_ACTIONS) {
    expect(AUDIT_ACTION_PATTERN.test(action), `${action} follows the platform's audit name rule`);
    expect(action.length <= 64, `${action} fits the audit name column`);
  }

  expectEqual(COUNTRY_ENABLED_AUDIT_ACTION, "country.enabled", "an opening has its own name");
  expectEqual(COUNTRY_DISABLED_AUDIT_ACTION, "country.disabled", "and so does a closing");
  expectEqual(new Set<string>(COUNTRY_AUDIT_ACTIONS).size, 2, "which are two names, not one");
  expectEqual(PENDING_APPROVAL_STATUSES.join(","), "pending_ceo,pending_super_admin", "the chain's live statuses are read, not guessed");
}

/** ---- The read: two roles, the counts, and the decision behind each row. */
async function checkRead(): Promise<void> {
  const database = createDatabase();

  seedWorld(database);

  const dependencies = createDependencies(database);

  for (const roles of [[], ["owner"], ["compliance_kyc"], ["finance_ops"], ["support"], ["blogger"]] as const) {
    expectEqual(
      await failureOf(() => listCountrySwitches({ actor: actorOf(roles) }, dependencies)),
      "PERMISSION_DENIED|",
      `${roles.join(",") || "no role"} cannot read the switch`,
    );
  }

  const staleRead = await listCountrySwitches({ actor: staleSuperAdmin }, dependencies);

  expectEqual(
    staleRead.countries.length,
    4,
    "a stale second factor may still read the list, because reading is not a turn",
  );
  expectEqual(database.writes.length, 0, "and a read writes nothing at all");

  const snapshot = await listCountrySwitches({ actor: superAdmin }, dependencies);

  expectEqual(snapshot.countries.length, 4, "every seeded country is listed");
  expectEqual(snapshot.enabledCount, 1, "one is open");
  expectEqual(snapshot.disabledCount, 2, "two are closed");
  expectEqual(snapshot.sanctionedCount, 1, "one is sanctioned");
  expectEqual(snapshot.awaitingDecisionCount, 1, "one decision is waiting");
  expectEqual(snapshot.readyToOpenCount, 1, "and one country has an approved decision to spend");
  expectEqual(snapshot.canRaise, true, "the super administrator may raise an opening");
  expectEqual(snapshot.readAtEpochMs, NOW, "the read stamps the instant it ran at");

  const open = viewOf(snapshot, COUNTRY_OPEN);
  const closed = viewOf(snapshot, COUNTRY_CLOSED);
  const sanctioned = viewOf(snapshot, COUNTRY_SANCTIONED);
  const pending = viewOf(snapshot, COUNTRY_PENDING);

  expectEqual(open?.canDisable, true, "an open country can be closed");
  expectEqual(open?.canEnable, false, "and is not offered an opening");
  expectEqual(closed?.canEnable, true, "a closed country with a decision can be opened");
  expectEqual(closed?.opening?.approvalId, APPROVAL_ONE, "naming the decision that stands behind it");
  expectEqual(closed?.opening?.confirmedAtEpochMs, NOW, "and when it was confirmed");
  expectEqual(sanctioned?.canEnable, false, "a sanctioned country is never offered an opening");
  expectEqual(sanctioned?.canDisable, false, "nor a closing");
  expectEqual(sanctioned?.sanctionNote, SANCTION_NOTE, "its sentence is shown instead");
  expectEqual(pending?.pending?.stage, "ceo", "a waiting decision names the desk it is on");
  expectEqual(pending?.pending?.expired, false, "and is not lapsed");
  expectEqual(pending?.canRequest, false, "so the same country is not asked for twice");
  expectEqual(pending?.canEnable, false, "and it cannot open without an approval");

  const ceoView = await listCountrySwitches({ actor: ceo }, dependencies);

  expectEqual(ceoView.canRaise, false, "the chief executive signs the decision rather than raising it");
  expectEqual(ceoView.countries.length, 4, "and reads the same list");

  // A decision already spent is not an authority again, and one whose country moved on is not its own.
  const spent = createDatabase();

  spent.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];
  spent.tables["approval_requests"] = [
    approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_CLOSED, consumed_at: NOW_ISO, consumed_by: SUPER_ADMIN_ID }),
  ];

  const spentSnapshot = await listCountrySwitches({ actor: superAdmin }, createDependencies(spent));

  expectEqual(spentSnapshot.readyToOpenCount, 0, "a spent decision opens nothing");
  expectEqual(viewOf(spentSnapshot, COUNTRY_CLOSED)?.canEnable, false, "so the country waits for a new one");
}

/** ---- The opening: a decision is spent, the switch moves, and the trail names both. */
async function checkEnable(): Promise<void> {
  const database = createDatabase();

  database.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];
  database.tables["approval_requests"] = [approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_CLOSED })];

  const dependencies = createDependencies(database);
  const snapshot = await enableCountry({ actor: superAdmin, countryId: COUNTRY_CLOSED }, dependencies);
  const country = rowOf(database, "countries", COUNTRY_CLOSED);
  const approval = rowOf(database, "approval_requests", APPROVAL_ONE);

  expectEqual(country?.["is_enabled"], true, "the country is open");
  expectEqual(country?.["version"], 2, "and the row's version moved by one, which the trigger owns");
  expectEqual(approval?.["consumed_by"], SUPER_ADMIN_ID, "the decision records who spent it");
  expectEqual(approval?.["consumed_at"], NOW_ISO, "and when");
  expectEqual(viewOf(snapshot, COUNTRY_CLOSED)?.state, "enabled", "the answer is the switch as it now stands");
  expectEqual(snapshot.enabledCount, 1, "with the counts moved with it");
  expectEqual(snapshot.readyToOpenCount, 0, "and nothing left to spend");

  const entry = database.audits.entries[0];

  expectEqual(entry?.action, "country.enabled", "the trail records the opening");
  expectEqual(entry?.actorUserId, SUPER_ADMIN_ID, "against the account that took it");
  expectEqual(entry?.entityType, "country", "on the country entity");
  expectEqual(entry?.entityId, COUNTRY_CLOSED, "which is the row that moved");
  expectEqual(entry?.companyId, null, "on the platform chain, because a country is not a tenant's");
  expectEqual(entry?.payload["approval_request_id"], APPROVAL_ONE, "and names the decision it spent");
  expectEqual(entry?.payload["code"], "BD", "with the country's code");
  expectEqual(database.audits.entries.length, 1, "one entry per opening");

  // The chief executive may spend a decision too: section 3 gives the switch to both.
  const second = createDatabase();

  second.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];
  second.tables["approval_requests"] = [approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_CLOSED })];

  await enableCountry({ actor: ceo, countryId: COUNTRY_CLOSED }, createDependencies(second));
  expectEqual(rowOf(second, "countries", COUNTRY_CLOSED)?.["is_enabled"], true, "the CEO may open a market as well");
  expectEqual(
    rowOf(second, "approval_requests", APPROVAL_ONE)?.["consumed_by"],
    CEO_ID,
    "and the decision records the CEO as the spender",
  );

  // ---- the refusals
  const sanctionedWorld = createDatabase();

  sanctionedWorld.tables["countries"] = [
    countryRow({ id: COUNTRY_SANCTIONED, code: "IR", is_sanctioned: true, sanction_note: SANCTION_NOTE }),
  ];
  sanctionedWorld.tables["approval_requests"] = [
    approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_SANCTIONED }),
  ];

  expectEqual(
    await failureOf(() => enableCountry({ actor: superAdmin, countryId: COUNTRY_SANCTIONED }, createDependencies(sanctionedWorld))),
    "CONFLICT|sanctioned",
    "a sanctioned country is refused by name, even with a decision behind it",
  );
  expectEqual(sanctionedWorld.writes.length, 0, "and nothing is written");
  expectEqual(
    rowOf(sanctionedWorld, "approval_requests", APPROVAL_ONE)?.["consumed_at"],
    null,
    "nor is the decision spent",
  );
  expectEqual(sanctionedWorld.audits.entries.length, 0, "nor is anything audited");

  const openWorld = createDatabase();

  openWorld.tables["countries"] = [countryRow({ id: COUNTRY_OPEN, is_enabled: true })];

  expectEqual(
    await failureOf(() => enableCountry({ actor: superAdmin, countryId: COUNTRY_OPEN }, createDependencies(openWorld))),
    "CONFLICT|already_on",
    "an open country cannot be opened",
  );

  const noDecision = createDatabase();

  noDecision.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];

  expectEqual(
    await failureOf(() => enableCountry({ actor: superAdmin, countryId: COUNTRY_CLOSED }, createDependencies(noDecision))),
    "CONFLICT|approval_required",
    "and a country no decision stands behind cannot be opened",
  );
  expectEqual(noDecision.writes.length, 0, "so nothing is written there either");

  const spentWorld = createDatabase();

  spentWorld.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];
  spentWorld.tables["approval_requests"] = [
    approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_CLOSED, consumed_at: NOW_ISO, consumed_by: CEO_ID }),
  ];

  expectEqual(
    await failureOf(() => enableCountry({ actor: superAdmin, countryId: COUNTRY_CLOSED }, createDependencies(spentWorld))),
    "CONFLICT|approval_required",
    "a decision somebody already spent is not an authority again",
  );

  const raceWorld = createDatabase();

  raceWorld.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];
  raceWorld.tables["approval_requests"] = [approvalRow({ id: APPROVAL_ONE, subject_id: COUNTRY_CLOSED })];
  raceWorld.beforeUpdate = (table, query): void => {
    if (table === "approval_requests" && query.includes("consumed_at=is.null")) {
      const row = rowOf(raceWorld, "countries", COUNTRY_CLOSED);

      if (row !== undefined) {
        // Two writes landed in between: the other operator's flip, and the trigger's own bump.
        row["version"] = Number(row["version"] ?? 1) + 2;
      }
    }
  };

  expectEqual(
    await failureOf(() => enableCountry({ actor: superAdmin, countryId: COUNTRY_CLOSED }, createDependencies(raceWorld))),
    "CONFLICT|stale",
    "a switch somebody turned in between is a conflict, not a silent overwrite",
  );
  expectEqual(rowOf(raceWorld, "countries", COUNTRY_CLOSED)?.["is_enabled"], false, "the country did not move");
  expectEqual(
    rowOf(raceWorld, "approval_requests", APPROVAL_ONE)?.["consumed_at"],
    null,
    "and the decision was given back rather than burned",
  );
  expectEqual(rowOf(raceWorld, "approval_requests", APPROVAL_ONE)?.["consumed_by"], null, "with its spender cleared");

  // ---- who may turn it, and how fresh the second factor is
  expectEqual(
    await failureOf(() => enableCountry({ actor: actorOf(["compliance_kyc"]), countryId: COUNTRY_CLOSED }, dependencies)),
    "PERMISSION_DENIED|",
    "compliance cannot open a market",
  );
  expectEqual(
    await failureOf(() => enableCountry({ actor: actorOf(["owner"]), countryId: COUNTRY_CLOSED }, dependencies)),
    "PERMISSION_DENIED|",
    "and neither can a merchant",
  );
  expectEqual(
    await failureOf(() => enableCountry({ actor: staleSuperAdmin, countryId: COUNTRY_CLOSED }, dependencies)),
    "PERMISSION_DENIED|reauth_required",
    "a stale second factor is asked to prove itself again",
  );
  expectEqual(
    await failureOf(() => enableCountry({ actor: superAdmin, countryId: "not-a-country" }, dependencies)),
    "RESOURCE_NOT_FOUND|",
    "a country that cannot exist is not found",
  );
  expectEqual(
    await failureOf(() =>
      enableCountry({ actor: superAdmin, countryId: "018f2b8a-9999-4c2d-9c3e-000000000009" }, dependencies),
    ),
    "RESOURCE_NOT_FOUND|",
    "and neither is one that is not there",
  );
}

/** ---- The closing: a reason is required, kept beside the country, and never echoed. */
async function checkDisable(): Promise<void> {
  const database = createDatabase();

  database.tables["countries"] = [countryRow({ id: COUNTRY_OPEN, is_enabled: true })];

  const dependencies = createDependencies(database);
  const snapshot = await disableCountry(
    { actor: superAdmin, countryId: COUNTRY_OPEN, reason: `  ${CLOSE_REASON}  ` },
    dependencies,
  );
  const country = rowOf(database, "countries", COUNTRY_OPEN);

  expectEqual(country?.["is_enabled"], false, "the country is closed");
  expectEqual(country?.["disabled_reason"], CLOSE_REASON, "with the operator's sentence, trimmed");
  expectEqual(country?.["version"], 2, "and the version moved by one");
  expectEqual(viewOf(snapshot, COUNTRY_OPEN)?.state, "disabled", "the answer says so");
  expectEqual(viewOf(snapshot, COUNTRY_OPEN)?.disabledReason, CLOSE_REASON, "and carries the sentence");
  expectEqual(snapshot.disabledCount, 1, "with the counts moved with it");

  const entry = database.audits.entries[0];

  expectEqual(entry?.action, "country.disabled", "the trail records the closing");
  expectEqual(entry?.payload["reason_length"], CLOSE_REASON.length, "with the length of the reason");
  expectEqual(entry?.payload["code"], "BD", "and the country's code");
  expectEqual(
    JSON.stringify(entry?.payload).includes(CLOSE_REASON),
    false,
    "but never the sentence itself, which stays on the row",
  );

  const tooShort = createDatabase();

  tooShort.tables["countries"] = [countryRow({ id: COUNTRY_OPEN, is_enabled: true })];

  expectEqual(
    await failureOf(() =>
      disableCountry({ actor: superAdmin, countryId: COUNTRY_OPEN, reason: "closed" }, createDependencies(tooShort)),
    ),
    "VALIDATION_FAILED|invalid_length",
    "a reason shorter than ten characters is refused before the write",
  );
  expectEqual(tooShort.writes.length, 0, "and nothing is written");

  expectEqual(
    await failureOf(() =>
      disableCountry(
        { actor: superAdmin, countryId: COUNTRY_OPEN, reason: "x".repeat(COUNTRY_DISABLE_REASON_MAXIMUM_LENGTH + 1) },
        createDependencies(tooShort),
      ),
    ),
    "VALIDATION_FAILED|invalid_length",
    "as is one longer than the column holds",
  );

  const sanctionedWorld = createDatabase();

  sanctionedWorld.tables["countries"] = [
    countryRow({ id: COUNTRY_SANCTIONED, is_sanctioned: true, sanction_note: SANCTION_NOTE }),
  ];

  expectEqual(
    await failureOf(() =>
      disableCountry(
        { actor: superAdmin, countryId: COUNTRY_SANCTIONED, reason: CLOSE_REASON },
        createDependencies(sanctionedWorld),
      ),
    ),
    "CONFLICT|sanctioned",
    "a sanctioned country is already closed and carries its own sentence",
  );

  const closedWorld = createDatabase();

  closedWorld.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];

  expectEqual(
    await failureOf(() =>
      disableCountry(
        { actor: superAdmin, countryId: COUNTRY_CLOSED, reason: CLOSE_REASON },
        createDependencies(closedWorld),
      ),
    ),
    "CONFLICT|already_off",
    "and a closed one cannot be closed twice",
  );

  expectEqual(
    await failureOf(() =>
      disableCountry({ actor: actorOf(["support"]), countryId: COUNTRY_OPEN, reason: CLOSE_REASON }, dependencies),
    ),
    "PERMISSION_DENIED|",
    "support cannot close a market",
  );
  expectEqual(
    await failureOf(() =>
      disableCountry({ actor: staleSuperAdmin, countryId: COUNTRY_OPEN, reason: CLOSE_REASON }, dependencies),
    ),
    "PERMISSION_DENIED|reauth_required",
    "and a stale second factor is asked to prove itself again",
  );
}

/** ---- The asking: a request into the chain, once, by the role that may raise it. */
async function checkRequest(): Promise<void> {
  const database = createDatabase();

  database.tables["countries"] = [
    countryRow({ id: COUNTRY_CLOSED, code: "NP", alpha3: "NPL", name: "Nepal" }),
  ];
  database.tables["approval_requests"] = [];

  const dependencies = createDependencies(database);
  const snapshot = await requestCountryEnable(
    {
      actor: superAdmin,
      countryId: COUNTRY_CLOSED,
      note: "Open Nepal for merchant onboarding after the local processor signs.",
    },
    dependencies,
  );
  const created = database.tables["approval_requests"]?.[0];

  expectEqual(created?.["action_type"], COUNTRY_ENABLE_ACTION, "the request is the chain's country action");
  expectEqual(created?.["subject_type"], "country", "against a country subject");
  expectEqual(created?.["subject_id"], COUNTRY_CLOSED, "which is the row the switch reads");
  expectEqual(created?.["subject_label"], "Nepal (NP)", "labelled with the name and the code the queue shows");
  expectEqual(created?.["status"], "pending_ceo", "and waiting at the first desk");
  expectEqual(created?.["requested_by"], SUPER_ADMIN_ID, "raised by the account that asked");
  expectEqual(created?.["amount_minor"], null, "with no amount, because a market is not a sum of money");
  expectEqual(created?.["consumed_at"], null, "and unspent, because nobody has opened anything yet");
  expectEqual(
    database.audits.entries[0]?.action,
    "approval.requested",
    "the chain's own audit entry is written by the chain",
  );
  expectEqual(viewOf(snapshot, COUNTRY_CLOSED)?.pending?.stage, "ceo", "and the answer names the desk it went to");

  expectEqual(
    await failureOf(() =>
      requestCountryEnable(
        { actor: superAdmin, countryId: COUNTRY_CLOSED, note: "Open Nepal for merchant onboarding after the local processor signs." },
        dependencies,
      ),
    ),
    "CONFLICT|duplicate",
    "a second ask for the same country is refused while the first waits",
  );

  expectEqual(
    await failureOf(() =>
      requestCountryEnable(
        { actor: ceo, countryId: COUNTRY_CLOSED, note: "Open Nepal for merchant onboarding after the local processor signs." },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|",
    "the chief executive signs the decision rather than raising it",
  );

  const sanctionedWorld = createDatabase();

  sanctionedWorld.tables["countries"] = [
    countryRow({ id: COUNTRY_SANCTIONED, is_sanctioned: true, sanction_note: SANCTION_NOTE }),
  ];
  sanctionedWorld.tables["approval_requests"] = [];

  expectEqual(
    await failureOf(() =>
      requestCountryEnable(
        { actor: superAdmin, countryId: COUNTRY_SANCTIONED, note: "It should open because a merchant asked." },
        createDependencies(sanctionedWorld),
      ),
    ),
    "CONFLICT|sanctioned",
    "nobody asks for a sanctioned country",
  );
  expectEqual(sanctionedWorld.writes.length, 0, "and nothing is written");

  const openWorld = createDatabase();

  openWorld.tables["countries"] = [countryRow({ id: COUNTRY_OPEN, is_enabled: true })];
  openWorld.tables["approval_requests"] = [];

  expectEqual(
    await failureOf(() =>
      requestCountryEnable(
        { actor: superAdmin, countryId: COUNTRY_OPEN, note: "It should open because a merchant asked." },
        createDependencies(openWorld),
      ),
    ),
    "CONFLICT|already_on",
    "and an open country needs no decision",
  );

  expectEqual(
    await failureOf(() =>
      requestCountryEnable(
        { actor: superAdmin, countryId: COUNTRY_CLOSED, note: "open it" },
        createDependencies(createDatabase()),
      ),
    ),
    "RESOURCE_NOT_FOUND|",
    "a missing country is not found before the note is even read",
  );

  // A lapsed request still holds its subject until the sweep closes it, so the ask sweeps once.
  const lapsedWorld = createDatabase();

  lapsedWorld.tables["countries"] = [countryRow({ id: COUNTRY_CLOSED })];
  lapsedWorld.tables["approval_requests"] = [
    approvalRow({
      id: APPROVAL_THREE,
      subject_id: COUNTRY_CLOSED,
      status: "pending_ceo",
      expires_at: LAPSED_ISO,
      ceo_decided_by: null,
      ceo_decided_at: null,
      super_admin_confirmed_by: null,
      super_admin_confirmed_at: null,
    }),
  ];

  const lapsedSnapshot = await requestCountryEnable(
    {
      actor: superAdmin,
      countryId: COUNTRY_CLOSED,
      note: "The first request lapsed, so this one carries the same reason.",
    },
    createDependencies(lapsedWorld),
  );

  expectEqual(rowOf(lapsedWorld, "approval_requests", APPROVAL_THREE)?.["status"], "expired", "the lapsed request is closed");
  expectEqual(lapsedWorld.tables["approval_requests"]?.length, 2, "and a second one is raised");
  expectEqual(
    lapsedWorld.audits.entries.map((entry) => entry.action).join(","),
    "approval.expired,approval.requested",
    "both facts reach the trail",
  );
  expectEqual(viewOf(lapsedSnapshot, COUNTRY_CLOSED)?.pending?.stage, "ceo", "and the country waits at the first desk again");

  expectEqual(
    await failureOf(() =>
      requestCountryEnable(
        { actor: staleSuperAdmin, countryId: COUNTRY_CLOSED, note: "The first request lapsed, so this one carries the same reason." },
        createDependencies(lapsedWorld),
      ),
    ),
    "PERMISSION_DENIED|reauth_required",
    "a stale second factor cannot raise an opening either",
  );
}

/** ---- The SQL: the sentence, the spend, the index, and the rollback that undoes them. */
async function checkMigration(): Promise<void> {
  const forward = await readRepositoryFile("migrations/0098_country_switch_authority.sql");
  const down = await readRepositoryFile("migrations/0098_country_switch_authority.down.sql");

  expect(forward.startsWith("-- path: migrations/0098_country_switch_authority.sql\n"), "the migration names its own path");
  expect(down.startsWith("-- path: migrations/0098_country_switch_authority.down.sql\n"), "and so does its rollback");
  expect(forward.includes("begin;") && forward.includes("commit;"), "the forward file is one transaction");
  expect(down.includes("begin;") && down.includes("commit;"), "and the rollback is another");
  expectEqual(forward.includes("create table"), false, "this STEP adds columns rather than a table");
  expectEqual(/drop table/iu.test(forward), false, "and removes nothing");

  expect(forward.includes("alter table public.countries"), "the switch's own table gains the sentence");
  expect(forward.includes("add column disabled_reason text"), "as a nullable column");
  expect(forward.includes("countries_disabled_reason_check"), "with a check of its own");
  expect(
    forward.includes("not is_enabled") && forward.includes("char_length(disabled_reason) between 10 and 280"),
    "that allows a reason only while the country is off, and only of a length worth reading",
  );

  expect(forward.includes("approval_requests"), "the decision table gains the spend");
  expect(forward.includes("add column consumed_at timestamptz"), "the instant");
  expect(forward.includes("add column consumed_by uuid"), "and the account");
  expect(forward.includes("approval_requests_consumed_by_fkey"), "with a foreign key to the accounts");
  expect(forward.includes("approval_requests_consumed_check"), "and one check over the pair");
  expect(
    forward.includes("(consumed_at is null) = (consumed_by is null)"),
    "so a spend is never half written",
  );
  expect(
    forward.includes("consumed_at is null or status = 'approved'"),
    "and nothing but an approved decision can be spent",
  );

  expect(forward.includes("approval_requests_consumable_idx"), "the switch's one query has an index");
  expect(
    forward.includes("where status = 'approved' and consumed_at is null and deleted_at is null"),
    "over exactly the rows it reads",
  );
  expectEqual(/(^|\n)\s*create index (?!approval_requests_consumable_idx)/u.test(forward), false, "and it is the only index");

  expect(down.includes("drop index if exists public.approval_requests_consumable_idx"), "the rollback drops the index");
  expect(down.includes("drop column if exists consumed_at"), "the spend's instant");
  expect(down.includes("drop column if exists consumed_by"), "and its account");
  expect(down.includes("drop column if exists disabled_reason"), "and the sentence");
  expect(
    down.indexOf("drop index if exists") < down.indexOf("drop column if exists consumed_at"),
    "in that order, because a column an index names cannot go first",
  );
  expectEqual(down.includes("drop table"), false, "and no table is dropped, because none was created");
  expect(
    down.indexOf("drop constraint if exists countries_disabled_reason_check") <
      down.indexOf("drop column if exists disabled_reason"),
    "the constraint goes before the column it names",
  );

  // The reference list itself is 0076's, and this STEP must not reopen the question of what a country is.
  const reference = await readRepositoryFile("migrations/0076_reference_countries.sql");
  const guard = reference.slice(
    reference.indexOf("create function public.countries_guard_state()"),
    reference.indexOf("comment on function public.countries_guard_state()"),
  );

  for (const frozen of ["code", "alpha3", "numeric_code", "name", "is_sanctioned", "sanction_note"]) {
    expect(guard.includes(`new.${frozen} is distinct from old.${frozen}`), `0076 still freezes ${frozen}`);
  }

  expect(
    reference.includes("constraint countries_sanctioned_disabled_check check (not (is_sanctioned and is_enabled))"),
    "and the database still refuses a sanctioned country that is on",
  );
  expect(
    guard.includes("new.deleted_at is not null"),
    "while a country row is still never removed",
  );
  expectEqual(
    forward.includes("countries_guard_state"),
    false,
    "this STEP does not rewrite the guard: the switch stays a boolean and the sentence beside it",
  );
}

/** ---- The route and the screen: one POST, one proof, one signature per mutation. */
async function checkRouteAndScreen(): Promise<void> {
  const route = await readRepositoryFile("app/api/office/countries/route.ts");
  const page = await readRepositoryFile("app/(admin)/countries/page.tsx");
  const console = await readRepositoryFile("app/(admin)/countries/country-switch-console.tsx");

  expect(route.startsWith("// path: app/api/office/countries/route.ts\n"), "the route names its own path");
  expectEqual(route.split("export const POST").length - 1, 1, "the route answers one POST");
  expect(CSRF_PROTECTED_PATHS.includes("/api/office/countries"), "which is on the CSRF list");
  expect(isSensitivePath("/api/office/countries"), "and on the list that needs a device proof");
  expect(route.includes("requireCsrfToken("), "the route checks the token");
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("readRequestActor("),
    "before it reads the session",
  );
  expect(
    route.indexOf("requireCsrfToken(") < route.indexOf("request.text()"),
    "and before it reads the body",
  );
  expect(route.includes("requireTrustedDevice("), "a device nobody confirmed cannot turn the switch");
  expect(route.includes("maximumBodyBytes"), "the body has a ceiling");
  expect(route.includes("PAYLOAD_TOO_LARGE"), "which refuses an oversized one");
  expect(route.includes("getCountryRuntime()"), "and the route uses this STEP's own wiring");

  for (const action of ["request", "enable", "disable"]) {
    expect(route.includes(`action === "${action}"`), `the route answers ${action}`);
  }

  expect(page.startsWith("// path: app/(admin)/countries/page.tsx\n"), "the page names its own path");
  expect(page.includes("listCountrySwitches("), "the page reads through the service");
  expect(page.includes("CountrySwitchConsole"), "and renders the console");
  expectEqual(page.includes("<main"), false, "the page owns no landmark: the shell does");
  expectEqual(page.includes("super_admin"), false, "and names no role");

  expect(console.startsWith("// path: app/(admin)/countries/country-switch-console.tsx\n"), "the console names its own path");
  expectEqual(console.split("\n")[1], '"use client";', "and is the one client boundary on the screen");
  expectEqual(console.split('method: "POST"').length - 1, 1, "it sends exactly one mutation");
  expect(console.includes("csrfHeaders("), "carrying the CSRF token");
  expect(console.includes("deviceProofHeaders("), "and the device proof");
  expect(console.includes("/api/office/countries"), "to this STEP's route");
  expectEqual(
    /(^|[^A-Za-z0-9_-])console\.(log|warn|error|debug|info)\(/u.test(console),
    false,
    "and writes nothing to the console",
  );
  expectEqual(console.includes("super_admin"), false, "the console names no office role");
  expect(console.includes("onClick="), "the actions are buttons rather than forms");
  expect(console.includes("disabled={busy !== null}"), "which refuse a second press while one is in flight");


  const navigation = await readRepositoryFile("components/office/navigation.ts");

  expect(navigation.includes('href: "/countries"'), "the office navigation links the screen");
  expect(navigation.includes("COUNTRY_SWITCH_ROLES"), "with this STEP's own role list rather than a copy");
}

/** One message's raw template, read from the catalog without the placeholder refusal `getMessage` has. */
function catalogMessage(key: string): string | null {
  let node: unknown = en;

  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) {
      return null;
    }

    node = (node as Record<string, unknown>)[segment];
  }

  return typeof node === "string" ? node : null;
}

/** ---- The copy: every sentence the screen renders is in the catalog. */
async function checkCopy(): Promise<void> {
  const console = await readRepositoryFile("app/(admin)/countries/country-switch-console.tsx");
  const page = await readRepositoryFile("app/(admin)/countries/page.tsx");
  const sources = `${page}\n${console}`;
  const referenced = new Set<string>();

  for (const match of sources.matchAll(/"(officeCountries\.[A-Za-z0-9]+)"/gu)) {
    const key = match[1];

    if (key !== undefined) {
      referenced.add(key);
    }
  }

  expect(referenced.size >= 30, `the screen words itself from the catalog (${String(referenced.size)} keys)`);

  for (const key of referenced) {
    const template = catalogMessage(key);

    expect(template !== null, `${key} is in the catalog`);

    if (template === null) {
      continue;
    }

    expect(template.length > 0, `${key} is not empty`);
    expectEqual(template, template.trim(), `${key} is trimmed`);

    const placeholders = [...template.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)].map(
      (match) => match[1] ?? "",
    );

    if (placeholders.length === 0) {
      expectEqual(getMessage(key as MessagePath), template, `${key} renders without parameters`);

      continue;
    }

    const rendered = formatMessage(
      key as MessagePath,
      Object.fromEntries(placeholders.map((name) => [name, 1])),
    );

    expectEqual(rendered.includes("{"), false, `${key} fills every placeholder it asks for`);
  }

  for (const key of [
    "office.sectionCountries",
    "office.sectionCountriesDescription",
    "officeApprovals.countriesSwitchLink",
  ] as const) {
    expect(getMessage(key).length > 0, `${key} is in the catalog`);
  }

  expectEqual(
    getMessage("officeCountries.title"),
    "Country switch",
    "the screen names itself the way section 3 does",
  );
  expect(
    getMessage("officeCountries.sanctionedExplanation").includes("embargo"),
    "and says why a sanctioned country never opens",
  );
}

async function main(): Promise<void> {
  checkRegistry();
  await checkRead();
  await checkEnable();
  await checkDisable();
  await checkRequest();
  await checkMigration();
  await checkRouteAndScreen();
  await checkCopy();

  if (failures.length > 0) {
    process.stderr.write(`country gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `country gate passed: ${String(checks)} checks, ${String(COUNTRY_SWITCH_ROLES.length)} controller roles, ` +
      `3 states, ${String(COUNTRY_AUDIT_ACTIONS.length)} audit names\n`,
  );
}

await main();
