// path: lib/gateways/verify.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isSensitivePath } from "../auth/request-proof.ts";
import type { SecretBox } from "../auth/secrets.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import { formatMessage, getMessage, type MessagePath } from "../i18n/messages.ts";
import {
  ADAPTER_CONNECTION_TESTS,
  GATEWAY_KEY_MODES,
  GATEWAY_LABEL_MAXIMUM_LENGTH,
  GATEWAY_MANAGEMENT_ROLES,
  GATEWAY_SECRET_MAXIMUM_LENGTH,
  GATEWAY_SECRET_MINIMUM_LENGTH,
  GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH,
  NO_ADAPTER_TEST_DETAIL,
  OFFICE_DASHBOARD_ROLES,
  PLATFORM_PROVIDERS,
  PROVIDER_KEYS,
  connectionTesterFor,
  hasConnectionTest,
  isGatewayKeyMode,
  isProviderKey,
  providerDefinitionOf,
  type ConnectionTester,
} from "./registry.ts";
import {
  addGatewayKey,
  keyProblemOf,
  listGateways,
  normalizeTestDetail,
  setGatewayEnabled,
  testGatewayKey,
  type GatewayDependencies,
  type GatewaySecretSealer,
  type GatewayStore,
} from "./service.ts";

/**
 * The gateway gate: run with `node lib/gateways/verify.ts`.
 *
 * Section 6 is one short list of sentences and every one of them is a property that a screen cannot
 * show and a review cannot see: the key is encrypted, the plaintext never returns, a provider cannot
 * be enabled without a passing test, a provider with no adapter cannot be enabled at all, and the
 * page is the super administrator's alone. This file drives those properties through the real service
 * over an in-memory PostgREST, so what passes here is the code a request runs.
 *
 * ## Why the fake speaks PostgREST and not a friendly interface
 *
 * The service builds its own query strings, and the interesting mistakes in this area are exactly
 * the ones a friendly fake would hide: a `select` that names the ciphertext, a filter that forgets
 * `deleted_at`, an update that forgets the version. So the store below parses the operators the
 * service actually uses (`eq`, `neq`, `is.null`) and applies the same trigger the database applies
 * (`version` up by one, `updated_at` to the write instant). A query that names a column the row does
 * not have still returns nothing, which is the same silence the database gives.
 *
 * ## What it cannot prove
 *
 * It cannot prove that PostgREST is reachable, that the master key is present, or that a provider's
 * own servers answer - those are deployment facts, and the handoff lists them as the checks a person
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
    userId: "018f2b8a-7777-4c2d-9c3e-0123456789ab",
    companyId: null,
    roles,
    sessionId: "018f2b8a-8888-4c2d-9c3e-0123456789ab",
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

/** The instant every scenario runs at. Fixed, so a timestamp assertion is exact. */
const NOW = 1_800_000_000_000;

const NOW_ISO = new Date(NOW).toISOString();

/** The audit trail of a scenario: in memory, and complete enough to assert on. */
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

/**
 * AES-256-GCM in production; here a reversible box that records the context it was given.
 *
 * The plaintext is base64url encoded into the ciphertext slot so `open` can answer with the same
 * string, which is what the service needs to hand a tester. The recorded contexts are asserted, so a
 * box that lost its provider, mode or fingerprint binding would fail this gate.
 */
interface RecordingSealer extends GatewaySecretSealer {
  readonly sealContexts: string[];
  readonly openContexts: string[];
}

function createSealer(): RecordingSealer {
  const sealContexts: string[] = [];
  const openContexts: string[] = [];
  const plaintexts = new Map<string, string>();

  return {
    sealContexts,
    openContexts,
    seal(plaintext: string, context: string): SecretBox {
      sealContexts.push(context);
      const ciphertext = Buffer.from(plaintext, "utf8").toString("base64url");

      plaintexts.set(ciphertext, plaintext);

      return { iv: "a".repeat(16), tag: "b".repeat(22), ciphertext };
    },
    open(box: SecretBox, context: string): string {
      openContexts.push(context);

      const plaintext = plaintexts.get(box.ciphertext);

      if (plaintext === undefined) {
        throw new Error("the gate asked to open a box it did not seal");
      }

      return plaintext;
    },
  };
}

type Row = Record<string, unknown>;

/** The operators the service uses, and no others: a query outside this vocabulary fails loudly. */
interface Filter {
  readonly column: string;
  readonly operator: "eq" | "neq" | "isNull";
  readonly value: string;
}

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

    const [column = "", expression = ""] = part.split("=", 2);

    if (expression === "is.null") {
      filters.push({ column: decodeURIComponent(column), operator: "isNull", value: "" });
      continue;
    }

    if (expression.startsWith("eq.")) {
      filters.push({
        column: decodeURIComponent(column),
        operator: "eq",
        value: decodeURIComponent(expression.slice("eq.".length)),
      });
      continue;
    }

    if (expression.startsWith("neq.")) {
      filters.push({
        column: decodeURIComponent(column),
        operator: "neq",
        value: decodeURIComponent(expression.slice("neq.".length)),
      });
      continue;
    }

    throw new Error(`the gate's store does not speak this operator: ${part}`);
  }

  return { filters, limit };
}

function matches(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    if (filter.operator === "isNull") {
      return row[filter.column] === null || row[filter.column] === undefined;
    }

    if (filter.operator === "eq") {
      return String(row[filter.column] ?? "") === filter.value;
    }

    return String(row[filter.column] ?? "") !== filter.value;
  });
}

interface FakeDatabase {
  readonly tables: Record<string, Row[]>;
  readonly queries: string[];
  readonly writes: string[];
  readonly audits: RecordedAudit;
  readonly sealer: RecordingSealer;
  /** Rows the gate advances behind the service's back, to prove the version filter. */
  readonly trips: Set<string>;
  nextId: number;
}

function createDatabase(): FakeDatabase {
  return {
    tables: { payment_providers: [], provider_keys: [] },
    queries: [],
    writes: [],
    audits: createAudit(),
    sealer: createSealer(),
    trips: new Set<string>(),
    nextId: 1,
  };
}

/**
 * The store: PostgREST's four methods, with the database's trigger written in.
 *
 * `provider_keys_guard_secret` and `set_row_metadata` are what make a version stale, so the fake
 * applies the same increment on every update. The `trips` set is the gate's own hand: it advances a
 * row twice, which is a second operator saving between the read and the write.
 */
function createStore(database: FakeDatabase): GatewayStore {
  return {
    select<TRow>(
      table: string,
      query: string,
      schema: z.ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      database.queries.push(`${table}?${query}`);

      const rows = database.tables[table] ?? [];
      const { filters, limit } = parseFilters(query);
      const selected = rows.filter((row) => matches(row, filters)).slice(0, limit);

      return Promise.resolve(selected.map((row) => schema.parse(row)));
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

        const tripKey = `${table}:${String(row["id"] ?? "")}`;

        // A second writer that got there first: its write lands, and the version has already moved
        // twice by the time this update's read-back looks.
        if (database.trips.has(tripKey)) {
          database.trips.delete(tripKey);
          row["version"] = Number(row["version"] ?? 1) + 2;
          row["updated_at"] = NOW_ISO;
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
  const id = `018f2b8a-9999-4c2d-9c3e-${String(database.nextId).padStart(12, "0")}`;

  database.nextId += 1;

  return {
    company_id: null,
    activated_at: null,
    disabled_at: null,
    last_tested_at: null,
    last_test_ok: null,
    last_test_detail: null,
    last_used_at: null,
    rotated_from_id: null,
    deleted_at: null,
    version: 1,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    ...row,
    id,
  };
}

/** One seeded provider row, exactly as `0094` writes it plus the columns the service reads. */
function providerRow(
  key: string,
  displayName: string,
  capabilities: readonly [boolean, boolean, boolean],
  displayOrder: number,
  overrides: Row = {},
): Row {
  return {
    id: `018f2b8a-0000-4c2d-9c3e-0000000000${String(displayOrder).padStart(2, "0")}`,
    company_id: null,
    provider_key: key,
    display_name: displayName,
    supports_acceptance: capabilities[0],
    supports_payouts: capabilities[1],
    supports_submerchant: capabilities[2],
    status: "disabled",
    display_order: displayOrder,
    enabled_at: null,
    last_tested_at: null,
    last_test_ok: null,
    last_test_detail: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

/** The five seeded rows of `0094`, in the registry's order. */
function seededProviders(): Row[] {
  return [
    providerRow("nmi", "NMI", [true, false, true], 1),
    providerRow("payoneer", "Payoneer", [false, true, false], 2),
    providerRow("rainforest", "Rainforest", [true, false, true], 3),
    providerRow("stripe_connect", "Stripe Connect", [true, true, true], 4),
    providerRow("airwallex", "Airwallex", [true, true, true], 5),
  ];
}

function createDependencies(
  database: FakeDatabase,
  tester: ConnectionTester | null = null,
): GatewayDependencies {
  return {
    store: createStore(database),
    audit: database.audits,
    secrets: database.sealer,
    testerFor: (): ConnectionTester | null => tester,
    now: (): number => NOW,
  };
}

/** The failure code a call answered with, or `no-throw` when it returned. */
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

const SAMPLE_SECRET = "sk-live-0123456789abcdef";

/** ---- The registry: five providers, one capability matrix, section 6's sentence. */
function checkRegistry(): void {
  expectEqual(PLATFORM_PROVIDERS.length, 5, "section 6 has five providers");
  expect(Object.isFrozen(PLATFORM_PROVIDERS), "the registry is frozen");
  expectEqual(PROVIDER_KEYS.join(","), "nmi,payoneer,rainforest,stripe_connect,airwallex", "in the order 0029 lists them");
  expectEqual(new Set<string>(PROVIDER_KEYS).size, 5, "each provider once");
  expectEqual(
    PLATFORM_PROVIDERS.map((provider) => provider.displayOrder).join(","),
    "1,2,3,4,5",
    "the panel order is the migration's",
  );

  for (const provider of PLATFORM_PROVIDERS) {
    expect(isProviderKey(provider.key), `${provider.key} is a provider key`);
    expect(provider.displayName.length > 0 && provider.displayName === provider.displayName.trim(), `${provider.key} has a display name`);
    expect(
      provider.capabilities.acceptance || provider.capabilities.payouts || provider.capabilities.submerchant,
      `${provider.key} supports at least one thing, as 0029 requires`,
    );
    expectEqual(providerDefinitionOf(provider.key)?.key, provider.key, `${provider.key} is found by key`);
    expectEqual(hasConnectionTest(provider.key), false, `this build has no adapter for ${provider.key}`);
  }

  // The capability matrix is section 6 read line by line.
  expectEqual(
    PLATFORM_PROVIDERS.map((provider) => {
      const { acceptance, payouts, submerchant } = provider.capabilities;

      return `${provider.key}:${acceptance ? "A" : "-"}${payouts ? "P" : "-"}${submerchant ? "S" : "-"}`;
    }).join(" "),
    "nmi:A-S payoneer:-P- rainforest:A-S stripe_connect:APS airwallex:APS",
    "the matrix matches section 6: NMI accepts and creates sub merchants, Payoneer pays out, and three do everything",
  );

  expectEqual(isProviderKey("paypal"), false, "a provider outside the vocabulary is nobody");
  expectEqual(isProviderKey(null), false, "nor is null");
  expectEqual(providerDefinitionOf("paypal"), null, "and it has no registry entry");
  expect(Object.isFrozen(ADAPTER_CONNECTION_TESTS), "the adapter seam is frozen");
  expectEqual(connectionTesterFor("nmi"), null, "no adapter is installed today");
  expectEqual(hasConnectionTest("nmi"), false, "so nothing is testable yet");
  expectEqual(GATEWAY_KEY_MODES.join(","), "test,live", "two modes, as provider_keys_mode_check says");
  expect(isGatewayKeyMode("test") && isGatewayKeyMode("live"), "both are modes");
  expectEqual(isGatewayKeyMode("sandbox"), false, "and nothing else is");
  expectEqual(GATEWAY_MANAGEMENT_ROLES.join(","), "super_admin", "section 6 keeps the page to the super administrator");
  expectEqual(OFFICE_DASHBOARD_ROLES.join(","), "super_admin", "and the home that summarises it to the same role");
  expectEqual(GATEWAY_LABEL_MAXIMUM_LENGTH, 80, "the label ceiling is the column's");
  expectEqual(GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH, 280, "so is the detail ceiling");
  expect(GATEWAY_SECRET_MINIMUM_LENGTH >= 12, "a secret shorter than twelve bytes could not produce a storable ciphertext");
  expect(GATEWAY_SECRET_MAXIMUM_LENGTH >= GATEWAY_SECRET_MINIMUM_LENGTH, "and the ceiling is above the floor");
}

/** ---- The seed: every registry key, every capability, in the migration that ships it. */
async function checkSeed(): Promise<void> {
  const forward = await readRepositoryFile("migrations/0094_seed_payment_providers.sql");
  const down = await readRepositoryFile("migrations/0094_seed_payment_providers.down.sql");

  expectEqual(forward.split("\n")[0], "-- path: migrations/0094_seed_payment_providers.sql", "the seed states its own path");
  expectEqual(down.split("\n")[0], "-- path: migrations/0094_seed_payment_providers.down.sql", "so does its rollback");
  expect(forward.includes("begin;") && forward.includes("commit;"), "the seed is one transaction");
  expectEqual(/drop\s+table|truncate|delete\s+from/iu.test(forward), false, "a forward migration of this platform removes nothing");

  for (const provider of PLATFORM_PROVIDERS) {
    const { acceptance, payouts, submerchant } = provider.capabilities;
    const values = `('${provider.key}', '${provider.displayName}', ${String(acceptance)}, ${String(payouts)}, ${String(submerchant)}, ${provider.displayOrder})`;

    expect(forward.includes(values), `0094 seeds ${provider.key} with the registry's matrix: ${values}`);
  }

  expect(forward.includes("where not exists"), "the insert is idempotent without an on conflict target the partial index cannot give");
  expect(down.includes("provider_key in ("), "the rollback names the five keys");
  expect(down.includes("not exists"), "and refuses to remove a provider that holds a key");
}

/** ---- Reading the panel. */
async function checkListing(): Promise<void> {
  const database = createDatabase();

  database.tables["payment_providers"] = seededProviders();

  const actor = actorOf(["super_admin"]);
  const dependencies = createDependencies(database);
  const snapshot = await listGateways({ actor }, dependencies);

  expectEqual(snapshot.gateways.length, 5, "the panel lists five providers");
  expectEqual(snapshot.gateways.map((gateway) => gateway.providerKey).join(","), PROVIDER_KEYS.join(","), "in display order");
  expectEqual(snapshot.enabledCount, 0, "none is enabled before a test");
  expectEqual(snapshot.untestedCount, 5, "none has been tested");
  expectEqual(snapshot.adapterlessCount, 5, "and this build has no adapter for any of them");
  expectEqual(snapshot.gateways[0]?.registered, true, "the first is a registry provider");
  expectEqual(snapshot.gateways[0]?.capabilities.acceptance, true, "with its capability matrix");
  expectEqual(snapshot.readAtEpochMs, NOW, "and the instant the runtime gave");

  for (const query of database.queries) {
    expectEqual(/ciphertext|key_iv|key_tag|key_fingerprint/iu.test(query), false, `the read selects no sealed column: ${query.slice(0, 40)}`);
  }

  expectEqual(
    database.queries.every((query) => query.includes("deleted_at=is.null")),
    true,
    "every read is of live rows",
  );

  const refused = await failureOf(() => listGateways({ actor: actorOf(["ceo"]) }, dependencies));

  expectEqual(refused, "PERMISSION_DENIED|", "another office role may not read the panel");
  expectEqual(await failureOf(() => listGateways({ actor: actorOf(["owner"]) }, dependencies)), "PERMISSION_DENIED|", "nor may a merchant");
}

/** ---- Storing a key. */
async function checkAddKey(): Promise<void> {
  const database = createDatabase();

  database.tables["payment_providers"] = seededProviders();

  const actor = actorOf(["super_admin"]);
  const dependencies = createDependencies(database);
  const outcome = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET },
    dependencies,
  );

  expectEqual(outcome.action, "add_key", "the outcome names the action");
  expectEqual(outcome.keyStatus, "disabled", "a new key is stored disabled, because an active one must already have passed a test");
  expectEqual(outcome.providerStatus, "disabled", "and storing a key does not put the provider on");

  const stored = database.tables["provider_keys"]?.[0];

  expect(stored !== undefined, "one row was written");

  const fingerprint = createHash("sha256").update(SAMPLE_SECRET, "utf8").digest("hex");

  expectEqual(stored?.["key_fingerprint"], fingerprint, "the fingerprint is the SHA-256 of the secret, as the column requires");
  expectEqual(stored?.["key_last_four"], "cdef", "the last four characters are what the screen shows");
  expectEqual(stored?.["mode"], "live", "the mode is stored");
  expectEqual(stored?.["status"], "disabled", "the row is disabled");
  expectEqual(stored?.["encryption_key_version"], 1, "and sealed under the first key version");
  expectEqual(String(stored?.["key_ciphertext"] ?? "").includes(SAMPLE_SECRET), false, "the plaintext is not in the row");

  expectEqual(
    database.sealer.sealContexts[0],
    `provider_keys:nmi:live:${fingerprint}`,
    "the box is bound to the provider, the mode and the fingerprint",
  );
  expectEqual(database.audits.entries.length, 1, "one audit entry was written");
  expectEqual(database.audits.entries[0]?.action, "gateway.key_added", "and it names the action");
  expectEqual(
    JSON.stringify(database.audits.entries[0]?.payload ?? {}).includes(SAMPLE_SECRET),
    false,
    "the audit payload never carries the secret",
  );
  expectEqual(database.audits.entries[0]?.entityType, "provider_key", "the entry names the key as its entity");

  const duplicate = await failureOf(() =>
    addGatewayKey({ actor, providerKey: "nmi", mode: "live", label: "Again", secret: SAMPLE_SECRET }, dependencies),
  );

  expectEqual(duplicate, "CONFLICT|duplicate", "the same key twice is a conflict");

  expectEqual(
    await failureOf(() =>
      addGatewayKey({ actor, providerKey: "paypal", mode: "live", label: "Other", secret: SAMPLE_SECRET }, dependencies),
    ),
    "VALIDATION_FAILED|unknown_provider",
    "a provider outside the registry cannot be added",
  );
  expectEqual(
    await failureOf(() => addGatewayKey({ actor, providerKey: "nmi", mode: "sandbox", label: "x", secret: SAMPLE_SECRET }, dependencies)),
    "VALIDATION_FAILED|invalid_format",
    "a mode outside the vocabulary is refused",
  );
  expectEqual(
    await failureOf(() => addGatewayKey({ actor, providerKey: "nmi", mode: "live", label: "x", secret: "short1" }, dependencies)),
    "VALIDATION_FAILED|invalid_length",
    "a secret below the floor is refused",
  );
  expectEqual(
    await failureOf(() =>
      addGatewayKey({ actor, providerKey: "nmi", mode: "live", label: "x", secret: "sk live 0123456789" }, dependencies),
    ),
    "VALIDATION_FAILED|invalid_format",
    "a secret with a space is refused",
  );
  expectEqual(
    await failureOf(() =>
      addGatewayKey({ actor, providerKey: "nmi", mode: "live", label: "x", secret: "sk-live-0123456789abc!" }, dependencies),
    ),
    "VALIDATION_FAILED|invalid_tail",
    "a secret whose last four are not letters or digits is refused with a sentence",
  );
  expectEqual(
    keyProblemOf({ providerKey: "nmi", mode: "live", label: "a".repeat(81), secret: SAMPLE_SECRET })?.field,
    "label",
    "an over long label is refused",
  );
  expectEqual(
    keyProblemOf({ providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET }),
    null,
    "and a well formed key has no problem",
  );

  // The freshness of the proof, which section 6 requires of every mutation here.
  expectEqual(
    await failureOf(() =>
      addGatewayKey(
        { actor: actorOf(["super_admin"], { reauthenticatedAtEpochMs: null, mfaVerifiedAtEpochMs: NOW - 3_600_000 }), providerKey: "nmi", mode: "live", label: "Late", secret: SAMPLE_SECRET },
        dependencies,
      ),
    ),
    "PERMISSION_DENIED|reauth_required",
    "a stale second factor cannot store a key",
  );
  expectEqual(
    await failureOf(() =>
      addGatewayKey({ actor: actorOf(["support"]), providerKey: "nmi", mode: "live", label: "No", secret: SAMPLE_SECRET }, dependencies),
    ),
    "PERMISSION_DENIED|",
    "and no other role can either",
  );
}

/** ---- Testing a key, and what the result does to the key and the provider. */
async function checkTestKey(): Promise<void> {
  const passing: ConnectionTester = () => Promise.resolve({ ok: true });
  const failing: ConnectionTester = () =>
    Promise.resolve({ ok: false, detail: "  the   gateway answered\u0007 401  " });

  const database = createDatabase();

  database.tables["payment_providers"] = seededProviders();

  const actor = actorOf(["super_admin"]);
  const added = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET },
    createDependencies(database, failing),
  );

  const tested = await testGatewayKey(
    { actor, keyId: added.keyId ?? "" },
    createDependencies(database, passing),
  );

  expectEqual(tested.testOk, true, "a passing tester records a pass");
  expectEqual(tested.keyStatus, "active", "and activates the key");
  expectEqual(tested.providerStatus, "disabled", "while the provider stays off until it is enabled");

  const keyRow = database.tables["provider_keys"]?.[0];
  const provider = database.tables["payment_providers"]?.[0];

  expectEqual(keyRow?.["status"], "active", "the row is active");
  expectEqual(keyRow?.["activated_at"], NOW_ISO, "with the instant it passed");
  expectEqual(keyRow?.["disabled_at"], null, "and no disabling instant");
  expectEqual(keyRow?.["last_test_ok"], true, "the key records the pass");
  expectEqual(provider?.["last_test_ok"], true, "and so does the provider");
  expectEqual(provider?.["status"], "disabled", "which is still off");

  expectEqual(database.audits.entries.at(-1)?.action, "gateway.key_tested", "the test is audited");
  expectEqual(database.audits.entries.at(-1)?.payload["activated"], true, "naming the activation");

  // A second key in the same mode replaces the first, because the index allows one active key.
  const second = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Rotation", secret: "sk-live-fedcba9876543210" },
    createDependencies(database, passing),
  );

  await testGatewayKey({ actor, keyId: second.keyId ?? "" }, createDependencies(database, passing));

  const rows = database.tables["provider_keys"] ?? [];

  expectEqual(rows.filter((row) => row["status"] === "active").length, 1, "one active key per provider and mode");
  expectEqual(rows[0]?.["status"], "disabled", "the key it replaced is off");

  // A failing test of a key that is not the active one leaves the provider alone.
  const before = { ...(database.tables["payment_providers"]?.[0] ?? {}) };
  const candidate = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "test", label: "Sandbox", secret: "sk-test-0123456789abcd" },
    createDependencies(database, failing),
  );

  const failed = await testGatewayKey({ actor, keyId: candidate.keyId ?? "" }, createDependencies(database, failing));

  expectEqual(failed.testOk, false, "a failing tester records a failure");
  expectEqual(failed.keyStatus, "disabled", "and the key stays off");
  expectEqual(
    failed.testDetail,
    "the gateway answered 401",
    "the detail is normalized: control characters dropped and runs of space collapsed",
  );
  expectEqual(
    database.tables["payment_providers"]?.[0]?.["version"],
    before["version"],
    "a candidate that fails does not touch the live provider row",
  );

  // No adapter in this build: the one answer the registry can give today.
  const databaseWithoutAdapter = createDatabase();

  databaseWithoutAdapter.tables["payment_providers"] = seededProviders();

  const orphan = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET },
    createDependencies(databaseWithoutAdapter),
  );
  const adapterless = await testGatewayKey(
    { actor, keyId: orphan.keyId ?? "" },
    createDependencies(databaseWithoutAdapter),
  );

  expectEqual(adapterless.testOk, false, "without an adapter the test cannot pass");
  expectEqual(adapterless.testDetail, NO_ADAPTER_TEST_DETAIL, "and it says exactly why");
  expectEqual(
    databaseWithoutAdapter.audits.entries.at(-1)?.payload["provider_disabled"],
    false,
    "a provider that was never on is not reported as disabled",
  );

  expectEqual(
    await failureOf(() => testGatewayKey({ actor, keyId: "not-a-key" }, createDependencies(database))),
    "RESOURCE_NOT_FOUND|",
    "a key that does not exist is a not found",
  );
  expectEqual(
    await failureOf(() =>
      testGatewayKey(
        {
          actor: actorOf(["super_admin"], {
            reauthenticatedAtEpochMs: NOW - 3_600_000,
            mfaVerifiedAtEpochMs: NOW - 3_600_000,
          }),
          keyId: second.keyId ?? "",
        },
        createDependencies(database, passing),
      ),
    ),
    "PERMISSION_DENIED|reauth_required",
    "and a stale proof cannot run a test",
  );
  expectEqual(normalizeTestDetail("   "), "The connection test failed without a reason.", "an empty reason becomes a sentence");
  expect(normalizeTestDetail("x".repeat(400)).length <= GATEWAY_TEST_DETAIL_MAXIMUM_LENGTH, "a long reason is cut to the column");
}

/** ---- Enabling and disabling a provider. */
async function checkSwitches(): Promise<void> {
  const passing: ConnectionTester = () => Promise.resolve({ ok: true });

  const database = createDatabase();

  database.tables["payment_providers"] = seededProviders();

  const actor = actorOf(["super_admin"]);

  expectEqual(
    await failureOf(() => setGatewayEnabled({ actor, providerKey: "nmi", enabled: true }, createDependencies(database))),
    "CONFLICT|adapter_missing",
    "with no adapter reachable the enable is refused before anything else is asked",
  );

  // An adapter is registered by the seam; the gate injects one through the dependency.
  const added = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET },
    createDependencies(database, passing),
  );

  await testGatewayKey({ actor, keyId: added.keyId ?? "" }, createDependencies(database, passing));

  const enabled = await setGatewayEnabled({ actor, providerKey: "nmi", enabled: true }, createDependencies(database, passing));

  expectEqual(enabled.providerStatus, "enabled", "a provider with a passing test and an active key is enabled");
  expectEqual(database.tables["payment_providers"]?.[0]?.["status"], "enabled", "the row says so");
  expectEqual(database.tables["payment_providers"]?.[0]?.["enabled_at"], NOW_ISO, "with the instant");
  expectEqual(database.audits.entries.at(-1)?.action, "gateway.provider_enabled", "and the enable is audited");

  const disabled = await setGatewayEnabled({ actor, providerKey: "nmi", enabled: false }, createDependencies(database, passing));

  expectEqual(disabled.providerStatus, "disabled", "a disable always works");
  expectEqual(database.tables["payment_providers"]?.[0]?.["enabled_at"], null, "and clears the instant");
  expectEqual(database.tables["provider_keys"]?.[0]?.["status"], "disabled", "the active key is off with the provider");
  expectEqual(database.audits.entries.at(-1)?.action, "gateway.provider_disabled", "and it is audited");
  expectEqual(database.audits.entries.at(-1)?.payload["disabled_keys"], 1, "naming how many keys it took with it");

  // Enabling a provider that never passed a test is refused with its own rule.
  const untested = createDatabase();

  untested.tables["payment_providers"] = seededProviders();

  expectEqual(
    await failureOf(() => setGatewayEnabled({ actor, providerKey: "payoneer", enabled: true }, createDependencies(untested, passing))),
    "CONFLICT|test_required",
    "a provider that never passed a test cannot be enabled, whatever adapter it has",
  );

  // A provider with a recorded pass but no active key: the third rule.
  const passingButKeyless = createDatabase();

  passingButKeyless.tables["payment_providers"] = [providerRow("nmi", "NMI", [true, false, true], 1, { last_test_ok: true, last_tested_at: NOW_ISO })];

  expectEqual(
    await failureOf(() => setGatewayEnabled({ actor, providerKey: "nmi", enabled: true }, createDependencies(passingButKeyless, passing))),
    "CONFLICT|key_required",
    "a passing test with no active key is not enough",
  );

  // A disabled provider with an active key but no pass: the second rule.
  const keylessPass = createDatabase();

  keylessPass.tables["payment_providers"] = [providerRow("nmi", "NMI", [true, false, true], 1)];

  const orphan = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET },
    createDependencies(keylessPass, passing),
  );

  keylessPass.tables["provider_keys"] = (keylessPass.tables["provider_keys"] ?? []).map((row) => ({
    ...row,
    status: "active",
    activated_at: NOW_ISO,
    disabled_at: null,
  }));

  expectEqual(
    await failureOf(() => setGatewayEnabled({ actor, providerKey: "nmi", enabled: true }, createDependencies(keylessPass, passing))),
    "CONFLICT|test_required",
    "an active key without a passing test is not enough either",
  );
  expect(orphan.keyStatus === "disabled", "and the key this gate added is the disabled one it wrote");

  expectEqual(
    await failureOf(() =>
      setGatewayEnabled({ actor: actorOf(["ceo"]), providerKey: "nmi", enabled: true }, createDependencies(keylessPass, passing)),
    ),
    "PERMISSION_DENIED|",
    "and the switch is the super administrator's alone",
  );
}

/** ---- The version filter: a second writer between the read and the write. */
async function checkStaleWrite(): Promise<void> {
  const passing: ConnectionTester = () => Promise.resolve({ ok: true });
  const database = createDatabase();

  database.tables["payment_providers"] = seededProviders();

  const actor = actorOf(["super_admin"]);
  const added = await addGatewayKey(
    { actor, providerKey: "nmi", mode: "live", label: "Primary", secret: SAMPLE_SECRET },
    createDependencies(database, passing),
  );
  const provider = database.tables["payment_providers"]?.[0];

  database.trips.add(`payment_providers:${String(provider?.["id"] ?? "")}`);

  const outcome = await failureOf(() =>
    testGatewayKey({ actor, keyId: added.keyId ?? "" }, createDependencies(database, passing)),
  );

  expectEqual(outcome, "CONFLICT|stale", "a row that changed under the reader ends as a conflict, not as a silent overwrite");
}

/** ---- The route, the screens and the vocabulary. */
async function checkSources(): Promise<void> {
  const route = await readRepositoryFile("app/api/office/gateways/route.ts");
  const page = await readRepositoryFile("app/(admin)/gateways/page.tsx");
  const console_ = await readRepositoryFile("app/(admin)/gateways/gateway-console.tsx");
  const dashboard = await readRepositoryFile("app/(admin)/dashboard/page.tsx");

  expectEqual(route.split("\n")[0], "// path: app/api/office/gateways/route.ts", "the route states its own path");
  expect(route.includes("requireCsrfToken("), "the route checks the CSRF token first");
  expect(route.includes('get(\"content-length\")'), "and bounds the body before reading it");
  expect(route.includes("request.text()"), "and reads the body once, as the text the proof covers");
  expect(route.includes("verifySensitiveRequest("), "and verifies the device proof");
  expect(route.includes("requireTrustedDevice("), "and refuses an unconfirmed device");
  expect(
    route.indexOf("verifySensitiveRequest(") < route.indexOf("JSON.parse("),
    "before it parses the body",
  );
  expect(route.includes("getGatewayRuntime()"), "and reaches the service through the one runtime");
  expectEqual(route.includes("console."), false, "the route logs nothing through the console");
  expectEqual(/\bas any\b/u.test(route), false, "and writes no any");
  expectEqual(route.includes("SAMPLE_SECRET"), false, "and names no fixture");

  expect(isSensitivePath("/api/office/gateways"), "the route is on the device proof list, which is what makes the proof enforceable");

  for (const [path, source] of [
    ["app/(admin)/gateways/page.tsx", page],
    ["app/(admin)/gateways/gateway-console.tsx", console_],
    ["app/(admin)/dashboard/page.tsx", dashboard],
  ] as const) {
    // The first line is the file's own path, and one of these files is named after a browser console,
    // so the source checks below read the body only: a path comment is not a statement.
    const body = source.split("\n").slice(1).join("\n");

    expectEqual(source.split("\n")[0], `// path: ${path}`, `${path} states its own path`);
    expectEqual(body.includes("console."), false, `${path} logs nothing`);
    expectEqual(/:\s*any\b/u.test(body), false, `${path} writes no any`);
  }

  expect(page.includes("listGateways("), "the page reads through the service");
  expect(console_.includes("deviceProofHeaders("), "the console signs its posts");
  expect(console_.includes('"/api/office/gateways"'), "and posts to the one gateway route");
  expect(console_.includes("csrfHeaders("), "with the CSRF header");
  expectEqual(console_.includes("key_ciphertext"), false, "and never mentions a column of the sealed row");
  expect(dashboard.includes("listGateways("), "the home summarises the same read");
  expectEqual(dashboard.includes("Date.now"), false, "and takes its instant from the runtime, not from the clock");
}

/** ---- The copy: every path exists, and the two parameterised ones render. */
function checkCopy(): void {
  const paths: readonly MessagePath[] = [
    "officeGateways.eyebrow",
    "officeGateways.title",
    "officeGateways.description",
    "officeGateways.addTitle",
    "officeGateways.addDescription",
    "officeGateways.modeLabel",
    "officeGateways.modeTest",
    "officeGateways.modeLive",
    "officeGateways.labelLabel",
    "officeGateways.secretLabel",
    "officeGateways.secretHint",
    "officeGateways.addSubmit",
    "officeGateways.addBusy",
    "officeGateways.storedDone",
    "officeGateways.keysHeading",
    "officeGateways.noKeys",
    "officeGateways.lastFourLabel",
    "officeGateways.keyUpdatedLabel",
    "officeGateways.keyStatusActive",
    "officeGateways.keyStatusDisabled",
    "officeGateways.testSubmit",
    "officeGateways.testBusy",
    "officeGateways.testPassed",
    "officeGateways.testFailed",
    "officeGateways.testDetailLabel",
    "officeGateways.enableSubmit",
    "officeGateways.disableSubmit",
    "officeGateways.enableBusy",
    "officeGateways.enabledDone",
    "officeGateways.disabledDone",
    "officeGateways.enableAdapterMissing",
    "officeGateways.enableTestRequired",
    "officeGateways.enableKeyRequired",
    "officeGateways.providerEnabled",
    "officeGateways.providerDisabled",
    "officeGateways.adapterInstalled",
    "officeGateways.adapterMissing",
    "officeGateways.capabilitiesHeading",
    "officeGateways.capabilityAcceptance",
    "officeGateways.capabilityPayouts",
    "officeGateways.capabilitySubmerchant",
    "officeGateways.noCapability",
    "officeGateways.lastTestHeading",
    "officeGateways.lastTestPassed",
    "officeGateways.lastTestFailed",
    "officeGateways.lastTestNever",
    "officeGateways.enabledAtLabel",
    "officeGateways.duplicateKey",
    "officeGateways.invalidSecret",
    "officeGateways.invalidLabel",
    "officeGateways.unknownProvider",
    "officeGateways.reauthRequired",
    "officeGateways.forbidden",
    "officeGateways.signedOut",
    "officeGateways.unavailable",
    "officeGateways.failed",
    "officeGateways.conflict",
    "officeGateways.home",
    "officeDashboard.eyebrow",
    "officeDashboard.title",
    "officeDashboard.description",
    "officeDashboard.accessHeading",
    "officeDashboard.rolesLabel",
    "officeDashboard.secondFactorLabel",
    "officeDashboard.secondFactorStale",
    "officeDashboard.reauthLink",
    "officeDashboard.gatewaysHeading",
    "officeDashboard.gatewaysUnavailable",
    "officeDashboard.gatewaysLink",
    "officeDashboard.approvalHeading",
    "officeDashboard.screensHeading",
    "officeDashboard.screensDescription",
    "officeDashboard.home",
    "office.sectionDashboard",
    "office.sectionGateways",
  ];

  for (const path of paths) {
    const message = getMessage(path);

    expect(message.length > 0, `${path} is in the catalog`);
    expectEqual(message, message.trim(), `${path} is trimmed`);
    expectEqual(message.includes("{"), false, `${path} has no placeholder this screen would not fill`);
    expectEqual(message.includes(SAMPLE_SECRET), false, `${path} carries no fixture`);
  }

  expect(
    formatMessage("officeDashboard.gatewaysSummary", {
      total: 5,
      enabled: 0,
      untested: 5,
      adapterless: 5,
    }).includes("5 providers"),
    "the summary fills its four counts",
  );
  expect(
    formatMessage("officeDashboard.secondFactorFresh", { at: "2027-01-15 08:00", until: "2027-01-15 08:10" }).includes(
      "2027-01-15 08:10 UTC",
    ),
    "and the freshness sentence fills both instants",
  );
  expectEqual(
    /[^A-Za-z0-9 .,:;'()/&+-]/u.test(getMessage("officeGateways.secretHint")),
    false,
    "the hint is plain English punctuation",
  );
}

async function main(): Promise<void> {
  checkRegistry();
  await checkSeed();
  await checkListing();
  await checkAddKey();
  await checkTestKey();
  await checkSwitches();
  await checkStaleWrite();
  await checkSources();
  checkCopy();

  if (failures.length > 0) {
    process.stderr.write(`gateway gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `gateway gate passed: ${checks} checks, ${PLATFORM_PROVIDERS.length} providers, ` +
      `${GATEWAY_KEY_MODES.length} modes, ${connectionTesterFor("nmi") === null ? 0 : 1} adapter(s) installed\n`,
  );
}

await main();
