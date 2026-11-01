// path: lib/permissions/verify.ts
import { readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isSensitivePath } from "../auth/request-proof.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import { formatMessage, getMessage, type MessagePath } from "../i18n/messages.ts";
import {
  DELEGABLE_PERMISSION_KEYS,
  GRANT_DURATIONS,
  PERMISSION_DELEGATION_ROLES,
  PERMISSION_EXPIRING_SOON_MS,
  PERMISSION_GROUPS,
  PERMISSION_HISTORY_LIMIT,
  PERMISSION_KEY_MAXIMUM_LENGTH,
  PERMISSION_KEY_PATTERN,
  PERMISSION_MAXIMUM_DAYS,
  PERMISSION_REASON_MAXIMUM_LENGTH,
  PERMISSIONS,
  PERMISSION_KEYS,
  RESERVED_PERMISSION_KEYS,
  charterRolesOf,
  delegablePermissionKeysInGroup,
  expiryInstantOf,
  isDelegablePermission,
  isGrantDurationDays,
  isPermissionKey,
  normalizeEmail,
  permissionDefinitionOf,
  permissionGroupDescriptionKey,
  permissionGroupLabelKey,
  permissionGroupOf,
  permissionKeysInGroup,
  permissionLabelKey,
} from "./registry.ts";
import {
  effectivePermissionsOf,
  grantPermission,
  listDelegations,
  revokePermission,
  type DelegationView,
  type PermissionDependencies,
  type PermissionStore,
} from "./service.ts";

/**
 * The delegation gate: run with `node lib/permissions/verify.ts`.
 *
 * Section 2 gives the super administrator one lever over the office, and that lever is where a platform
 * usually loses its four eyes: a permission that can be handed to anybody, for ever, to yourself, or
 * handed out by whoever happens to hold the screen. This file drives the real service over an in-memory
 * PostgREST, so what passes here is the code a grant runs, and it holds the catalog against the column
 * checks it must satisfy.
 *
 * ## What it cannot prove
 *
 * That PostgreSQL accepts the migration, that a browser holds a device proof, and that a person can
 * press the form - those are deployment and browser facts, and the handoff lists the checks a person
 * runs against a real project.
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

/** The instant every scenario runs at, so an expiry assertion is exact. */
const NOW = 1_800_000_000_000;
const NOW_ISO = new Date(NOW).toISOString();
const DAY_MS = 24 * 60 * 60 * 1_000;

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
  readonly operator: "eq" | "in" | "isNull" | "notNull";
  readonly values: readonly string[];
}

/** The operators the permission service uses: `eq`, `in`, `is.null` and `not.is.null`. */
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

    if (expression === "not.is.null") {
      filters.push({ column, operator: "notNull", values: [] });
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

    if (filter.operator === "notNull") {
      return value !== null && value !== undefined;
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
      office_permissions: [],
      users: [],
      role_assignments: [],
    },
    queries: [],
    writes: [],
    audits: createAudit(),
    nextId: 1,
  };
}

/** The store: PostgREST's four methods, and the identity column a serial row would get. */
function createStore(database: FakeDatabase): PermissionStore {
  return {
    select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      const rows = database.tables[table] ?? [];
      const { filters, limit } = parseFilters(query);

      return Promise.resolve(
        rows.filter((row) => matches(row, filters)).slice(0, limit).map((row) => schema.parse(row)),
      );
    },
    insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
      database.writes.push(`insert ${table} ${rows.length}`);

      for (const row of rows) {
        database.tables[table]?.push(stampInserted(database, row));
      }

      return Promise.resolve();
    },
    insertReturning<TRow>(
      table: string,
      rows: readonly Readonly<Record<string, unknown>>[],
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      database.writes.push(`insertReturning ${table} ${rows.length}`);

      const existing = database.tables[table] ?? [];
      const prepared = rows.map((row) => stampInserted(database, row));

      // `office_permissions_live_key`: one live row per account and permission. The unique violation a
      // real deployment raises is what the service turns into `CONFLICT duplicate`.
      for (const row of prepared) {
        const clash = existing.some(
          (candidate) =>
            candidate["user_id"] === row["user_id"] &&
            candidate["permission"] === row["permission"] &&
            (candidate["revoked_at"] === null || candidate["revoked_at"] === undefined) &&
            (candidate["deleted_at"] === null || candidate["deleted_at"] === undefined),
        );

        if (clash) {
          const error = new Error("duplicate key value violates unique constraint");
          (error as Error & { code?: string }).code = "CONFLICT";

          throw error;
        }
      }

      existing.push(...prepared);

      return Promise.resolve(prepared.map((row) => schema.parse(row)));
    },
    update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
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

        row["updated_at"] = NOW_ISO;
      }

      return Promise.resolve();
    },
  };
}

function stampInserted(database: FakeDatabase, row: Readonly<Record<string, unknown>>): Row {
  const id = `018f2b8a-5555-4c2d-9c3e-${String(database.nextId).padStart(12, "0")}`;

  database.nextId += 1;

  return {
    granted_by: null,
    expires_at: null,
    revoked_at: null,
    revoked_by: null,
    reason: null,
    deleted_at: null,
    version: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...row,
    id,
  };
}

function createDependencies(database: FakeDatabase): PermissionDependencies {
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

const SUPER_ADMIN = actorOf(["super_admin"]);
const COMPLIANCE_ID = "018f2b8a-6666-4c2d-9c3e-000000000001";
const SUPPORT_ID = "018f2b8a-6666-4c2d-9c3e-000000000002";
const MERCHANT_ID = "018f2b8a-6666-4c2d-9c3e-000000000003";
const SUSPENDED_ID = "018f2b8a-6666-4c2d-9c3e-000000000004";

/** Three accounts and their roles: an officer, a support agent, a merchant, and one suspension. */
function seedAccounts(database: FakeDatabase): void {
  database.tables["users"] = [
    {
      id: COMPLIANCE_ID,
      email: "reviewer@example.com",
      full_name: "Reviewer One",
      status: "active",
      deleted_at: null,
    },
    {
      id: SUPPORT_ID,
      email: "agent@example.com",
      full_name: "Agent Two",
      status: "active",
      deleted_at: null,
    },
    {
      id: MERCHANT_ID,
      email: "owner@example.com",
      full_name: "Owner Three",
      status: "active",
      deleted_at: null,
    },
    {
      id: SUSPENDED_ID,
      email: "gone@example.com",
      full_name: "Suspended Four",
      status: "suspended",
      deleted_at: null,
    },
  ];

  database.tables["role_assignments"] = [
    { id: "role-1", user_id: COMPLIANCE_ID, role: "compliance_kyc", revoked_at: null, deleted_at: null },
    { id: "role-2", user_id: SUPPORT_ID, role: "support", revoked_at: null, deleted_at: null },
    { id: "role-3", user_id: MERCHANT_ID, role: "owner", revoked_at: null, deleted_at: null },
    { id: "role-4", user_id: SUSPENDED_ID, role: "support", revoked_at: null, deleted_at: null },
  ];
}

/** ---- The catalog: sixteen keys, thirteen of them delegable, and three the platform keeps. */
function checkRegistry(): void {
  expectEqual(PERMISSIONS.length, 16, "the catalog names sixteen permissions");
  expect(Object.isFrozen(PERMISSIONS), "the catalog is frozen");
  expectEqual(new Set<string>(PERMISSION_KEYS).size, PERMISSIONS.length, "each key appears once");
  expectEqual(PERMISSION_KEYS.length, PERMISSIONS.length, "and PERMISSION_KEYS is the same list");

  for (const definition of PERMISSIONS) {
    expect(
      PERMISSION_KEY_PATTERN.test(definition.key),
      `${definition.key} satisfies the column check ^[a-z][a-z0-9]*(.[a-z0-9_]+)+$`,
    );
    expect(
      definition.key.length <= PERMISSION_KEY_MAXIMUM_LENGTH,
      `${definition.key} fits the column's 64 characters`,
    );
    expect(
      PERMISSION_GROUPS.includes(definition.group),
      `${definition.key} belongs to one of the five desks`,
    );
    expect(
      getMessage(definition.labelKey).length > 0,
      `${definition.key} has a sentence in the catalog`,
    );

    for (const role of definition.charterRoles) {
      expect(role !== "owner", `${definition.key} is chartered to office staff, never to a merchant`);
    }
  }

  expectEqual(DELEGABLE_PERMISSION_KEYS.length, 13, "thirteen permissions may be delegated");
  expectEqual(RESERVED_PERMISSION_KEYS.join(","), "gateway.keys,platform.settings,delegation.grant", "and three stay with the platform");
  expectEqual(
    DELEGABLE_PERMISSION_KEYS.filter((key) => RESERVED_PERMISSION_KEYS.includes(key)).length,
    0,
    "no key is both delegable and reserved",
  );

  expectEqual(isPermissionKey("kyc.review"), true, "a catalogued key is known");
  expectEqual(isPermissionKey("kyc.reveiw"), false, "a typo is not");
  expectEqual(isPermissionKey("kyc"), false, "a bare group is not a key");
  expectEqual(isPermissionKey(null), false, "nor is null");
  expectEqual(isDelegablePermission("kyc.review"), true, "a delegable key is delegable");
  expectEqual(isDelegablePermission("gateway.keys"), false, "a reserved key is not");
  expectEqual(isDelegablePermission("nope.nope"), false, "and an unknown key is not either");

  // Section 2 keeps the CEO's final signature with the CEO: that authority moves through
  // `delegations` (0006), not through a super administrator's grant.
  expectEqual(isPermissionKey("kyc.final_approval"), false, "the CEO's final signature is not in this catalog");
  expectEqual(
    PERMISSION_KEYS.filter((key) => key.includes("final")).length,
    0,
    "and no key here grants a final approval",
  );

  expectEqual(permissionKeysInGroup("kyc").length, 6, "six compliance permissions");
  expectEqual(permissionKeysInGroup("money").length, 4, "four money permissions");
  expectEqual(permissionKeysInGroup("support").length, 2, "two support permissions");
  expectEqual(permissionKeysInGroup("content").length, 1, "one content permission");
  expectEqual(permissionKeysInGroup("platform").length, 3, "and the three the platform keeps");
  expectEqual(
    permissionKeysInGroup("platform").join(","),
    RESERVED_PERMISSION_KEYS.join(","),
    "the platform desk is exactly the reserved three",
  );
  expectEqual(
    delegablePermissionKeysInGroup("platform").length,
    0,
    "nothing on the platform desk is offered by the form",
  );
  expectEqual(permissionGroupOf("payout.release"), "money", "a key knows its desk");
  expectEqual(permissionGroupOf("payout.relaese"), null, "and an unknown key has none");

  const labels = new Set<string>();
  const groupLabels = new Set<string>();
  const groupDescriptions = new Set<string>();

  for (const key of PERMISSION_KEYS) {
    expectEqual(
      permissionDefinitionOf(key)?.key,
      key,
      `${key} is found in the catalog by its key`,
    );
    expectEqual(permissionLabelKey(key), permissionDefinitionOf(key)?.labelKey, `${key} keeps its label key`);
    labels.add(getMessage(permissionLabelKey(key)));
    expectEqual(charterRolesOf(key).length > 0, true, `${key} names the desk that holds it by charter`);
  }

  for (const group of PERMISSION_GROUPS) {
    groupLabels.add(getMessage(permissionGroupLabelKey(group)));
    groupDescriptions.add(getMessage(permissionGroupDescriptionKey(group)));
    expect(getMessage(permissionGroupDescriptionKey(group)).length > 0, `${group} is described`);
    expectEqual(permissionKeysInGroup(group).length > 0, true, `${group} holds at least one permission`);
  }

  expectEqual(labels.size, PERMISSIONS.length, "sixteen permissions, sixteen distinct sentences");
  expectEqual(groupLabels.size, PERMISSION_GROUPS.length, "five desks, five names");
  expectEqual(groupDescriptions.size, PERMISSION_GROUPS.length, "and five descriptions");

  expectEqual(PERMISSION_DELEGATION_ROLES.join(","), "super_admin", "one role holds the lever");
  expect(Object.isFrozen(PERMISSION_DELEGATION_ROLES), "and the list is frozen");

  expectEqual(GRANT_DURATIONS.length, 4, "the form offers four windows");
  expectEqual(
    GRANT_DURATIONS.map((duration) => duration.days).join(","),
    "7,30,90,180",
    "in ascending order",
  );
  expectEqual(
    GRANT_DURATIONS[GRANT_DURATIONS.length - 1]?.days,
    PERMISSION_MAXIMUM_DAYS,
    "the longest is the ceiling the service enforces",
  );
  expectEqual(
    new Set<string>(GRANT_DURATIONS.map((duration) => getMessage(duration.labelKey))).size,
    GRANT_DURATIONS.length,
    "each window has its own name",
  );

  expectEqual(isGrantDurationDays(30), true, "thirty days is a window");
  expectEqual(isGrantDurationDays(1), true, "so is a day");
  expectEqual(isGrantDurationDays(180), true, "and the ceiling itself");
  expectEqual(isGrantDurationDays(0), false, "but not zero");
  expectEqual(isGrantDurationDays(181), false, "nor past the ceiling");
  expectEqual(isGrantDurationDays(1.5), false, "nor a fraction of a day");
  expectEqual(isGrantDurationDays("30"), false, "nor a string that looks like one");

  expectEqual(expiryInstantOf(NOW, 7), NOW + 7 * DAY_MS, "a window becomes an instant");
  expectEqual(expiryInstantOf(NOW, 0), NOW, "and a zero window ends where it starts");

  expectEqual(normalizeEmail("  Reviewer@Example.COM "), "reviewer@example.com", "an address is trimmed and lowercased");
  expectEqual(normalizeEmail("not-an-email"), null, "a word is not an address");
  expectEqual(normalizeEmail("a@b"), null, "and neither is a shape too short to be one");
  expectEqual(normalizeEmail("nobody@example.com"), "nobody@example.com", "a plain address passes");

  expectEqual(PERMISSION_EXPIRING_SOON_MS, 7 * DAY_MS, "the warning window is a week");
  expectEqual(PERMISSION_HISTORY_LIMIT > 0, true, "the history has a bound");
}

/** ---- The migration: the column the screen reads, and the index the warning read needs. */
async function checkMigration(): Promise<void> {
  const forward = await readRepositoryFile("migrations/0096_office_permission_revoked_by.sql");
  const down = await readRepositoryFile("migrations/0096_office_permission_revoked_by.down.sql");
  const previous = await readRepositoryFile("migrations/0095_approval_requests.sql");

  expect(previous.length > 0, "0095 is still the migration before this one");
  expect(forward.includes("add column revoked_by uuid"), "0096 adds the column the screen names a withdrawal by");
  expect(
    forward.includes("office_permissions_revoked_by_fkey"),
    "with a foreign key to the account that ended the grant",
  );
  expect(
    forward.includes("revoked_by is null or revoked_at is not null"),
    "and a check that an account is only named on a revoked grant",
  );
  expect(
    forward.includes("create index office_permissions_expiry_idx"),
    "the expiring read gets its own index",
  );
  expect(
    forward.includes("where revoked_at is null and deleted_at is null and expires_at is not null"),
    "a partial index over the rows a liveness check reads",
  );
  expect(forward.includes("begin;"), "the forward file is transactional");
  expectEqual(forward.trimEnd().endsWith("commit;"), true, "and commits");

  expect(down.includes("drop index if exists public.office_permissions_expiry_idx"), "the rollback drops the index");
  expect(down.includes("drop constraint if exists office_permissions_revoked_by_check"), "and the check");
  expect(down.includes("drop constraint if exists office_permissions_revoked_by_fkey"), "and the foreign key");
  expect(down.includes("drop column if exists revoked_by"), "and the column itself");
  expectEqual(
    down.includes("drop table"),
    false,
    "while leaving every grant and every withdrawal in place",
  );

  // The table this STEP writes was 014's; its live key is what makes a duplicate impossible.
  const base = await readRepositoryFile("migrations/0005_office_permissions.sql");

  expect(base.includes("create unique index office_permissions_live_key"), "0005 still owns the live key");
  expect(
    base.includes("where revoked_at is null and deleted_at is null"),
    "which is per account and permission while the grant is live",
  );
}

/** ---- Granting: who may, to whom, for what, and for how long. */
async function checkGrant(): Promise<void> {
  const database = createDatabase();

  seedAccounts(database);

  const dependencies = createDependencies(database);

  const granted = await grantPermission(
    {
      actor: SUPER_ADMIN,
      permission: "kyc.review",
      email: "Reviewer@Example.com",
      days: 7,
      reason: "Cover while the reviewer is away for a week.",
    },
    dependencies,
  );

  expectEqual(granted.permission, "kyc.review", "the grant names the permission");
  expectEqual(granted.holderId, COMPLIANCE_ID, "and the account the address resolved to");
  expectEqual(granted.holderName, "Reviewer One", "with the name the screen prints");
  expectEqual(granted.expiresAtEpochMs, NOW + 7 * DAY_MS, "ending after the chosen window");
  expectEqual(granted.expired, false, "which is not yet over");
  expectEqual(granted.expiringSoon, true, "and inside the warning window");
  expectEqual(granted.version, 1, "a new row starts at version one");
  expectEqual(database.writes.filter((write) => write.startsWith("insertReturning office_permissions")).length, 1, "one row is written");
  expectEqual(database.audits.entries.length, 1, "and one audit entry follows it");
  expectEqual(database.audits.entries[0]?.action, "permission.granted", "named permission.granted");
  expectEqual(database.audits.entries[0]?.actorUserId, SUPER_ADMIN.userId, "with the delegating account");
  expectEqual(
    (database.audits.entries[0]?.payload["holder_roles"] as readonly string[] | undefined)?.join(","),
    "compliance_kyc",
    "the roles the holder had at the time",
  );
  expectEqual(
    database.audits.entries[0]?.payload["reason_length"],
    "Cover while the reviewer is away for a week.".length,
    "the reason travels as its length",
  );
  expectEqual(
    JSON.stringify(database.audits.entries[0]?.payload).includes("Cover while"),
    false,
    "and the sentence itself stays out of the trail",
  );

  const cases: readonly (readonly [string, () => Promise<unknown>, string])[] = [
    [
      "a support agent cannot delegate",
      () =>
        grantPermission(
          {
            actor: actorOf(["support"]),
            permission: "kyc.review",
            email: "reviewer@example.com",
            days: 7,
            reason: "A support agent may not hand out compliance work.",
          },
          dependencies,
        ),
      "PERMISSION_DENIED|",
    ],
    [
      "the CEO cannot delegate from this screen",
      () =>
        grantPermission(
          {
            actor: actorOf(["ceo"]),
            permission: "kyc.review",
            email: "reviewer@example.com",
            days: 7,
            reason: "Section 2 keeps the delegation lever with the super administrator.",
          },
          dependencies,
        ),
      "PERMISSION_DENIED|",
    ],
    [
      "a stale second factor cannot delegate",
      () =>
        grantPermission(
          {
            actor: actorOf(["super_admin"], {
              mfaVerifiedAtEpochMs: NOW - 30 * 60_000,
              reauthenticatedAtEpochMs: NOW - 30 * 60_000,
            }),
            permission: "kyc.review",
            email: "reviewer@example.com",
            days: 7,
            reason: "Twenty minutes ago is longer than the proof lasts.",
          },
          dependencies,
        ),
      "PERMISSION_DENIED|reauth_required",
    ],
    [
      "an unknown key is refused",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "kyc.reveiw",
            email: "reviewer@example.com",
            days: 7,
            reason: "A typo must not become a stored permission.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|unknown_permission",
    ],
    [
      "a reserved key is refused",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "gateway.keys",
            email: "agent@example.com",
            days: 7,
            reason: "Section 6 keeps the gateway keys in one pair of hands.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|not_delegable",
    ],
    [
      "the lever itself is refused",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "delegation.grant",
            email: "agent@example.com",
            days: 7,
            reason: "A delegation that delegates itself cannot be tracked.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|not_delegable",
    ],
    [
      "a word is not an address",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "payout.release",
            email: "reviewer",
            days: 7,
            reason: "The address is how the account is found.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|invalid_format",
    ],
    [
      "an address nobody uses is not found",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "payout.release",
            email: "nobody@example.com",
            days: 7,
            reason: "There is no account behind that address.",
          },
          dependencies,
        ),
      "RESOURCE_NOT_FOUND|",
    ],
    [
      "an account cannot delegate to itself",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "payout.release",
            email: "owner@example.com",
            days: 7,
            reason: "The merchant address is not the caller, but it has no desk.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|not_office_staff",
    ],
    [
      "a suspended account is refused",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "support.ticket",
            email: "gone@example.com",
            days: 7,
            reason: "A suspended account is not given new authority.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|account_inactive",
    ],
    [
      "a short reason is refused",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "payout.release",
            email: "agent@example.com",
            days: 7,
            reason: "cover",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|invalid_length",
    ],
    [
      "a window outside the four is refused",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "payout.release",
            email: "agent@example.com",
            days: 200,
            reason: "Two hundred days is longer than this screen grants.",
          },
          dependencies,
        ),
      "VALIDATION_FAILED|invalid_range",
    ],
    [
      "the same key twice is a conflict",
      () =>
        grantPermission(
          {
            actor: SUPER_ADMIN,
            permission: "kyc.review",
            email: "reviewer@example.com",
            days: 7,
            reason: "The same authority is already live on this account.",
          },
          dependencies,
        ),
      "CONFLICT|duplicate",
    ],
  ];

  for (const [description, call, expected] of cases) {
    expectEqual(await failureOf(call), expected, description);
  }

  // The self check itself, with an actor whose own address is in the table.
  const selfDatabase = createDatabase();

  seedAccounts(selfDatabase);
  selfDatabase.tables["users"]?.push({
    id: SUPER_ADMIN.userId,
    email: "chief@example.com",
    full_name: "Chief Five",
    status: "active",
    deleted_at: null,
  });
  selfDatabase.tables["role_assignments"]?.push({
    id: "role-5",
    user_id: SUPER_ADMIN.userId,
    role: "super_admin",
    revoked_at: null,
    deleted_at: null,
  });

  expectEqual(
    await failureOf(() =>
      grantPermission(
        {
          actor: SUPER_ADMIN,
          permission: "kyc.review",
          email: "chief@example.com",
          days: 7,
          reason: "An account cannot hand itself an authority.",
        },
        createDependencies(selfDatabase),
      ),
    ),
    "VALIDATION_FAILED|self",
    "an account cannot delegate to itself",
  );

  // A lapsed row still holds `office_permissions_live_key`, so it blocks a new grant until withdrawn.
  const lapsedDatabase = createDatabase();

  seedAccounts(lapsedDatabase);
  lapsedDatabase.tables["office_permissions"]?.push({
    id: "018f2b8a-7777-4c2d-9c3e-000000000001",
    user_id: COMPLIANCE_ID,
    permission: "kyc.review",
    granted_by: SUPER_ADMIN.userId,
    granted_at: new Date(NOW - 30 * DAY_MS).toISOString(),
    expires_at: new Date(NOW - 1 * DAY_MS).toISOString(),
    revoked_at: null,
    revoked_by: null,
    reason: "A window that has already run out.",
    deleted_at: null,
    version: 1,
  });

  expectEqual(
    await failureOf(() =>
      grantPermission(
        {
          actor: SUPER_ADMIN,
          permission: "kyc.review",
          email: "reviewer@example.com",
          days: 7,
          reason: "A lapsed row still occupies the live key.",
        },
        createDependencies(lapsedDatabase),
      ),
    ),
    "CONFLICT|duplicate",
    "a lapsed grant blocks a new one until somebody withdraws it",
  );
}

/** ---- Withdrawing: now, once, and never a grant that ended by itself. */
async function checkRevoke(): Promise<void> {
  const database = createDatabase();

  seedAccounts(database);

  const dependencies = createDependencies(database);
  const granted = await grantPermission(
    {
      actor: SUPER_ADMIN,
      permission: "payout.release",
      email: "agent@example.com",
      days: 30,
      reason: "Cover for the finance desk over the month end.",
    },
    dependencies,
  );

  expectEqual(
    await failureOf(() =>
      revokePermission({ actor: actorOf(["support"]), delegationId: granted.id }, dependencies),
    ),
    "PERMISSION_DENIED|",
    "a support agent cannot withdraw a grant",
  );
  expectEqual(
    await failureOf(() =>
      revokePermission({ actor: SUPER_ADMIN, delegationId: "not-a-row" }, dependencies),
    ),
    "RESOURCE_NOT_FOUND|",
    "an id the table does not hold is not found",
  );

  const revoked = await revokePermission({ actor: SUPER_ADMIN, delegationId: granted.id }, dependencies);

  expectEqual(revoked.revokedAtEpochMs, NOW, "the withdrawal is stamped with the instant it happened");
  expectEqual(revoked.revokedByName, null, "and the account is named when the table can answer");
  expectEqual(database.audits.entries.at(-1)?.action, "permission.revoked", "the trail names permission.revoked");
  expectEqual(
    database.audits.entries.at(-1)?.payload["permission"],
    "payout.release",
    "with the permission that was withdrawn",
  );
  expectEqual(
    await failureOf(() => revokePermission({ actor: SUPER_ADMIN, delegationId: granted.id }, dependencies)),
    "RESOURCE_NOT_FOUND|",
    "a grant already withdrawn is no longer live, so it is not found twice",
  );

  // A window that ran out is refused: the clock ended it, and there is nothing to withdraw.
  const lapsedDatabase = createDatabase();

  seedAccounts(lapsedDatabase);
  lapsedDatabase.tables["office_permissions"]?.push({
    id: "018f2b8a-7777-4c2d-9c3e-000000000002",
    user_id: SUPPORT_ID,
    permission: "support.ticket",
    granted_by: SUPER_ADMIN.userId,
    granted_at: new Date(NOW - 40 * DAY_MS).toISOString(),
    expires_at: new Date(NOW - 9 * DAY_MS).toISOString(),
    revoked_at: null,
    revoked_by: null,
    reason: "A window that ended nine days ago.",
    deleted_at: null,
    version: 1,
  });

  expectEqual(
    await failureOf(() =>
      revokePermission(
        { actor: SUPER_ADMIN, delegationId: "018f2b8a-7777-4c2d-9c3e-000000000002" },
        createDependencies(lapsedDatabase),
      ),
    ),
    "CONFLICT|expired",
    "a grant that ran out cannot be withdrawn",
  );

  // A version that moved between the read and the write is a conflict, not a success.
  const racedDatabase = createDatabase();

  seedAccounts(racedDatabase);
  racedDatabase.tables["office_permissions"]?.push({
    id: "018f2b8a-7777-4c2d-9c3e-000000000003",
    user_id: SUPPORT_ID,
    permission: "support.ticket",
    granted_by: SUPER_ADMIN.userId,
    granted_at: NOW_ISO,
    expires_at: new Date(NOW + 5 * DAY_MS).toISOString(),
    revoked_at: null,
    revoked_by: null,
    reason: "A live grant another officer is withdrawing at the same moment.",
    deleted_at: null,
    version: 1,
  });

  const racedDependencies = createDependencies(racedDatabase);
  const racedStore = racedDependencies.store;

  const raced: PermissionDependencies = {
    audit: racedDependencies.audit,
    now: (): number => NOW,
    store: {
      ...racedStore,
      update(_table: string, query: string, values: Readonly<Record<string, unknown>>) {
        // The row moved on between the read and the write - a second editor, a sweep, a retry - so the
        // conditional update matches nothing and the row is still live when it is read back.
        const rows = racedDatabase.tables["office_permissions"] ?? [];

        for (const row of rows) {
          row["version"] = 2;
          row["updated_at"] = NOW_ISO;
        }

        return racedStore.update(_table, query, values);
      },
    },
  };

  expectEqual(
    await failureOf(() =>
      revokePermission(
        { actor: SUPER_ADMIN, delegationId: "018f2b8a-7777-4c2d-9c3e-000000000003" },
        raced,
      ),
    ),
    "CONFLICT|changed",
    "a withdrawal whose update matched no row answers conflict rather than success",
  );
}

/** ---- Reading: three lists, one page, and the check every other module will call. */
async function checkReads(): Promise<void> {
  const database = createDatabase();

  seedAccounts(database);
  database.tables["office_permissions"] = [
    {
      id: "018f2b8a-8888-4c2d-9c3e-000000000001",
      user_id: SUPPORT_ID,
      permission: "support.ticket",
      granted_by: SUPER_ADMIN.userId,
      granted_at: new Date(NOW - 2 * DAY_MS).toISOString(),
      expires_at: new Date(NOW + 3 * DAY_MS).toISOString(),
      revoked_at: null,
      revoked_by: null,
      reason: "A week of cover for the support desk.",
      deleted_at: null,
      version: 1,
    },
    {
      id: "018f2b8a-8888-4c2d-9c3e-000000000002",
      user_id: COMPLIANCE_ID,
      permission: "kyc.review",
      granted_by: SUPER_ADMIN.userId,
      granted_at: new Date(NOW - 40 * DAY_MS).toISOString(),
      expires_at: new Date(NOW - 10 * DAY_MS).toISOString(),
      revoked_at: null,
      revoked_by: null,
      reason: "A window that ran out ten days ago.",
      deleted_at: null,
      version: 1,
    },
    {
      id: "018f2b8a-8888-4c2d-9c3e-000000000003",
      user_id: COMPLIANCE_ID,
      permission: "payout.release",
      granted_by: SUPER_ADMIN.userId,
      granted_at: new Date(NOW - 20 * DAY_MS).toISOString(),
      expires_at: new Date(NOW - 5 * DAY_MS).toISOString(),
      revoked_at: new Date(NOW - 6 * DAY_MS).toISOString(),
      revoked_by: SUPER_ADMIN.userId,
      reason: "Withdrawn when the reviewer came back.",
      deleted_at: null,
      version: 2,
    },
  ];

  const dependencies = createDependencies(database);
  const snapshot = await listDelegations({ actor: SUPER_ADMIN }, dependencies);

  expectEqual(snapshot.active.length, 1, "one delegation is live");
  expectEqual(snapshot.lapsed.length, 1, "one has run out");
  expectEqual(snapshot.ended.length, 1, "and one was withdrawn");
  expectEqual(snapshot.active[0]?.permission, "support.ticket", "the live one is the support ticket");
  expectEqual(snapshot.active[0]?.holderEmail, "agent@example.com", "with the address of the holder");
  expectEqual(snapshot.active[0]?.expiringSoon, true, "and flagged as ending inside the week");
  expectEqual(snapshot.lapsed[0]?.expired, true, "the lapsed row is marked over");
  expectEqual(snapshot.lapsed[0]?.expiringSoon, false, "and is not also expiring soon");
  expectEqual(snapshot.ended[0]?.revokedAtEpochMs, NOW - 6 * DAY_MS, "the withdrawn row keeps its instant");
  expectEqual(snapshot.delegable.length, 13, "the form is offered thirteen permissions");
  expectEqual(snapshot.reserved.join(","), "gateway.keys,platform.settings,delegation.grant", "and names the three it keeps");
  expectEqual(snapshot.readAtEpochMs, NOW, "the snapshot says when it was read");
  expectEqual(
    database.queries.filter((query) => query.startsWith("users?")).length,
    1,
    "the accounts of every list are read in one query",
  );

  expectEqual(
    await failureOf(() => listDelegations({ actor: actorOf(["ceo"]) }, dependencies)),
    "PERMISSION_DENIED|",
    "the CEO cannot read the delegation table",
  );
  expectEqual(
    await failureOf(() => listDelegations({ actor: actorOf(["owner"]) }, dependencies)),
    "PERMISSION_DENIED|",
    "and neither can a merchant",
  );

  const effective = await effectivePermissionsOf(SUPPORT_ID, dependencies);

  expectEqual(effective.join(","), "support.ticket", "the live grant is the account's permission");
  expectEqual(
    (await effectivePermissionsOf(COMPLIANCE_ID, dependencies)).join(","),
    "",
    "a lapsed grant and a withdrawn one answer no check",
  );

  // A row that names a key the platform does not know cannot be a permission it grants.
  database.tables["office_permissions"]?.push({
    id: "018f2b8a-8888-4c2d-9c3e-000000000004",
    user_id: SUPPORT_ID,
    permission: "made.up",
    granted_by: SUPER_ADMIN.userId,
    granted_at: NOW_ISO,
    expires_at: new Date(NOW + 2 * DAY_MS).toISOString(),
    revoked_at: null,
    revoked_by: null,
    reason: "A key that is not in the catalog.",
    deleted_at: null,
    version: 1,
  });

  expectEqual(
    (await effectivePermissionsOf(SUPPORT_ID, dependencies)).join(","),
    "support.ticket",
    "and an unknown key is dropped rather than returned",
  );

  const forThePage: readonly DelegationView[] = snapshot.active;

  expectEqual(forThePage.length, 1, "the page renders what the read returned");
}

/** ---- The sources: the route guards, the page's shape, and the two lists that must name it. */
async function checkSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/office/delegations/route.ts");
  const page = await readRepositoryFile("app/(admin)/delegations/page.tsx");
  const console_ = await readRepositoryFile("app/(admin)/delegations/delegation-console.tsx");
  const navigation = await readRepositoryFile("components/office/navigation.ts");

  expect(route.includes("withErrorResponse"), "the route answers every failure through the one envelope");
  expect(route.includes("requireCsrfToken"), "and refuses a body without the CSRF token");
  expect(route.includes("maximumBodyBytes = 4_096"), "with a bounded body");
  expect(route.includes("readRequestActor"), "resolving the session through STEP 051's reader");
  expect(route.includes("verifySensitiveRequest"), "over the device proof");
  expect(route.includes("requireTrustedDevice"), "and the trusted device it must come from");
  expect(
    route.indexOf("requireTrustedDevice") < route.indexOf("JSON.parse"),
    "the proof is verified before the body is parsed",
  );
  expect(route.includes('action === "grant"'), "one action hands a permission out");
  expect(route.includes('action === "revoke"'), "and one takes it back");
  expectEqual(route.includes("export const GET"), false, "the route reads nothing");
  expectEqual(route.includes('"use client"'), false, "and it is not a browser module");

  expectEqual(page.includes("<main"), false, "the page renders no landmark: the shell owns it");
  expectEqual(page.includes('"use client"'), false, "the page is a server component");
  expectEqual(page.includes("super_admin"), false, "and names no role: the service decides");
  expect(page.includes("listDelegations"), "it reads through the permission service");
  expect(page.includes("getPermissionRuntime"), "with the shared runtime");
  expect(page.includes("DelegationConsole"), "and hands the two forms to the client boundary");
  expect(page.includes('id="delegations-live"'), "each section is named by its heading");
  expect(page.includes('id="delegations-grant"'), "including the form");
  expect(page.includes('id="delegations-ended"'), "and the history");
  expect(page.includes("formatInstant"), "instants are printed in one format");

  expect(console_.includes("deviceProofHeaders"), "the browser signs the delegation body");
  expect(console_.includes("csrfHeaders"), "and sends the CSRF token");
  expect(console_.includes('"/api/office/delegations"'), "to the one endpoint");
  expect(console_.includes("min-h-24"), "the reason field has room to write a reason");
  expectEqual(console_.includes("super_admin"), false, "the form names no role");
  expectEqual(console_.includes("router.refresh()"), true, "and refreshes the read after a write");

  expect(navigation.includes("key: \"delegations\""), "the navigation offers the screen");
  expect(navigation.includes("PERMISSION_DELEGATION_ROLES"), "with the service's own role list");
  expectEqual(
    navigation.includes("roles: PERMISSION_DELEGATION_ROLES,"),
    true,
    "and never a copy of it",
  );

  expect(
    isSensitivePath("/api/office/delegations"),
    "the delegation route requires a device proof",
  );
  expect(
    CSRF_PROTECTED_PATHS.includes("/api/office/delegations"),
    "and a CSRF token",
  );
}

/** ---- The copy: every sentence the screen prints is in the catalog. */
function checkCopy(): void {
  const required: readonly MessagePath[] = [
    "office.sectionDelegations",
    "office.sectionDelegationsDescription",
    "officeDelegations.eyebrow",
    "officeDelegations.title",
    "officeDelegations.description",
    "officeDelegations.liveHeading",
    "officeDelegations.liveDescription",
    "officeDelegations.liveEmpty",
    "officeDelegations.expiringBadge",
    "officeDelegations.lapsedBadge",
    "officeDelegations.permissionLabel",
    "officeDelegations.holderLabel",
    "officeDelegations.grantedAtLabel",
    "officeDelegations.grantedByLabel",
    "officeDelegations.expiresAtLabel",
    "officeDelegations.reasonLabel",
    "officeDelegations.lapsedHeading",
    "officeDelegations.lapsedDescription",
    "officeDelegations.lapsedEmpty",
    "officeDelegations.endedHeading",
    "officeDelegations.endedDescription",
    "officeDelegations.endedEmpty",
    "officeDelegations.endedRevokedAtLabel",
    "officeDelegations.endedRevokedByLabel",
    "officeDelegations.endedUnknown",
    "officeDelegations.grantHeading",
    "officeDelegations.grantDescription",
    "officeDelegations.permissionFieldLabel",
    "officeDelegations.permissionHint",
    "officeDelegations.emailFieldLabel",
    "officeDelegations.emailHint",
    "officeDelegations.durationFieldLabel",
    "officeDelegations.durationHint",
    "officeDelegations.reasonFieldLabel",
    "officeDelegations.reasonHint",
    "officeDelegations.grantSubmit",
    "officeDelegations.grantBusy",
    "officeDelegations.grantedDone",
    "officeDelegations.revokeHeading",
    "officeDelegations.revokeDescription",
    "officeDelegations.revokeFieldLabel",
    "officeDelegations.revokeSubmit",
    "officeDelegations.revokeBusy",
    "officeDelegations.revokedDone",
    "officeDelegations.noLiveToRevoke",
    "officeDelegations.unknownPermission",
    "officeDelegations.notDelegable",
    "officeDelegations.notOfficeStaff",
    "officeDelegations.selfGrant",
    "officeDelegations.duplicateGrant",
    "officeDelegations.unknownAccount",
    "officeDelegations.invalidEmail",
    "officeDelegations.invalidLength",
    "officeDelegations.invalidRange",
    "officeDelegations.expiredGrant",
    "officeDelegations.reauthRequired",
    "officeDelegations.forbidden",
    "officeDelegations.signedOut",
    "officeDelegations.unavailable",
    "officeDelegations.failed",
    "officeDelegations.conflict",
    "officeDelegations.reservedHeading",
    "officeDelegations.home",
  ];

  for (const path of required) {
    const message = getMessage(path);

    expect(message.length > 0, `${path} is in the catalog`);
    expectEqual(message, message.trim(), `${path} is trimmed`);
  }

  expectEqual(
    getMessage("officeDelegations.title"),
    "Permission delegation",
    "the screen names itself in words",
  );
  expectEqual(
    getMessage("officeDelegations.duplicateGrant").includes("already holds"),
    true,
    "the duplicate refusal says what happened",
  );
  expectEqual(
    formatMessage("officeDelegations.liveCount", { count: 3 }),
    "3 permissions are delegated right now.",
    "the live count is a sentence with the number filled in",
  );
  expectEqual(
    formatMessage("officeDelegations.expiringCount", { count: 1 }),
    "1 of them end within seven days.",
    "and so is the warning count",
  );
  expectEqual(
    getMessage("officeDelegations.reasonHint").includes("ten characters"),
    true,
    "the reason hint states the minimum the service enforces",
  );
  expectEqual(
    getMessage("officeDelegations.grantDescription").includes("hundred and eighty"),
    true,
    "and the form states the ceiling",
  );
  expectEqual(
    getMessage("officeDelegations.permissionHint").includes("Gateway keys"),
    true,
    "the hint names what is not offered, so nobody guesses",
  );
  expectEqual(
    PERMISSION_REASON_MAXIMUM_LENGTH,
    280,
    "the reason ceiling is the column's own",
  );
}

async function main(): Promise<void> {
  checkRegistry();
  await checkMigration();
  await checkGrant();
  await checkRevoke();
  await checkReads();
  await checkSources();
  checkCopy();

  if (failures.length > 0) {
    process.stderr.write(`permission gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `permission gate passed: ${checks} checks, ${PERMISSIONS.length} permissions, ` +
      `${DELEGABLE_PERMISSION_KEYS.length} delegable, ${RESERVED_PERMISSION_KEYS.length} reserved\n`,
  );
}

await main();
