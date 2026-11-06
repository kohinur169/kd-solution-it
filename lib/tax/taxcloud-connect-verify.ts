// path: lib/tax/taxcloud-connect-verify.ts

/**
 * The gate for the merchant TaxCloud connect flow.
 *
 * Run directly, because the TaxCloud block owns `lib/tax/` and not `package.json`:
 *
 *   node lib/tax/taxcloud-connect-verify.ts
 *
 * Twelve sections: the constants against the migration that owns the table, the permission, the two
 * scopes, the row's invariants, the insert values, the store, connecting, the ping request, the ping
 * outcomes, disconnecting, the views, and the transport with the source.
 *
 * The seal is the real cipher from `lib/auth/secrets.ts` with a fixture master key, so a round trip
 * here exercises the code the deployment runs. Nothing reaches the network: the transport is a
 * function the gate supplies, and the one real transport is only called with URLs it must refuse.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../errors/app-error.ts";
import { createInMemoryAuditTrail } from "../auth/audit.ts";
import type { AuditEntry, InMemoryAuditTrail } from "../auth/audit.ts";
import { openSecret, sealSecret } from "../auth/secrets.ts";
import type { RequestActor } from "../auth/types.ts";
import { maskTaxCloudApiKey, TAXCLOUD_API_BASE } from "./taxcloud.ts";
import {
  InMemoryTaxCloudConnectionStore,
  TAXCLOUD_ANSWER_MAXIMUM_BYTES,
  TAXCLOUD_CLIENT_ALLOWED_HEADERS,
  TAXCLOUD_CLIENT_ALLOWED_METHODS,
  TAXCLOUD_CLIENT_TIMEOUT_MS,
  TAXCLOUD_CONNECT_AUDIT_ACTIONS,
  TAXCLOUD_CONNECT_ROLES,
  TAXCLOUD_CONNECTION_TABLE,
  TAXCLOUD_ENCRYPTION_KEY_VERSION,
  TAXCLOUD_INSERT_COLUMNS,
  TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH,
  TAXCLOUD_LAST_FOUR_PATTERN,
  TAXCLOUD_SEALED_MAXIMUM_LENGTH,
  TAXCLOUD_SEALED_MINIMUM_LENGTH,
  TAXCLOUD_STORED_STATUSES,
  TAXCLOUD_VERIFY_STATUSES,
  canManageTaxCloudConnection,
  connectTaxCloudAccount,
  createTaxCloudRestStore,
  disconnectTaxCloudConnection,
  isTaxCloudCompanyId,
  isTaxCloudSealedValue,
  isTaxCloudStoredStatus,
  requireTaxCloudConnectActor,
  taxCloudApiKeyScope,
  taxCloudConnectProblemOf,
  taxCloudConnectionIdScope,
  taxCloudConnectionViewOf,
  taxCloudErrorSentenceOf,
  taxCloudEpochOf,
  taxCloudFetchTransport,
  taxCloudHintOf,
  taxCloudInsertValuesOf,
  taxCloudMaskProblemOf,
  taxCloudRowOfRecord,
  taxCloudRowProblemOf,
  taxCloudSettingsViewOf,
  taxCloudStatusMessageOf,
  verifyTaxCloudConnection,
} from "./taxcloud-connect.ts";
import type {
  TaxCloudConnectOptions,
  TaxCloudConnectionRow,
  TaxCloudConnectionStore,
  TaxCloudSecretSealer,
  TaxCloudTransport,
  TaxCloudTransportAnswer,
  TaxCloudTransportCall,
} from "./taxcloud-connect.ts";

/* ---- the checking harness, the shape STEPs 170 to 176 used ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorCodeOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

async function errorCodeOfAsync(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

async function errorMessageOfAsync(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "no_error";
  } catch (error) {
    return error instanceof Error ? error.message : "not_an_error";
  }
}

function errorFieldOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    if (error instanceof AppError) return error.details[0]?.field ?? "no_detail";
    return "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const NOW = 1_780_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY = "company_kd_tax_connect_gate";
const OTHER_COMPANY = "company_kd_tax_connect_other";
const OWNER_ID = "user_owner_tax_0001";
const SESSION_ID = "session_tax_0001";

/** The connection ID a merchant pastes from Developer > Integrations. */
const CONNECTION_ID = "3f2b6c1e-9a41-4d7b-8e55-0b7c1d2e4a6f";
/** A 36 character key that ends in four letters and digits, which is what the table can mask. */
const API_KEY = "eyJhbGciOiJIUzI1NiJ9.taxcloud.gate.7bd1c2d";

const MASTER_KEY = Buffer.alloc(32, 11).toString("base64");

const sealer: TaxCloudSecretSealer = {
  seal: (plaintext: string, context: string) => sealSecret(MASTER_KEY, plaintext, context),
  open: (box, context: string) => openSecret(MASTER_KEY, box, context),
};

/** A transport that records what it was sent and answers one scripted status. */
interface ScriptedTransport {
  readonly transport: TaxCloudTransport;
  readonly calls: TaxCloudTransportCall[];
}

function transportAnswering(answer: TaxCloudTransportAnswer | Error): ScriptedTransport {
  const calls: TaxCloudTransportCall[] = [];

  return {
    calls,
    transport: async (call: TaxCloudTransportCall): Promise<TaxCloudTransportAnswer> => {
      calls.push(call);

      if (answer instanceof Error) throw answer;

      return answer;
    },
  };
}

function ownerActor(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: OWNER_ID,
    companyId: COMPANY,
    roles: ["owner"],
    sessionId: SESSION_ID,
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: NOW - DAY_MS,
    expiresAtEpochMs: NOW + DAY_MS,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    deviceProofKeyId: null,
    sessionFamilyId: null,
    mfaVerifiedAtEpochMs: NOW - DAY_MS,
    reauthenticatedAtEpochMs: NOW - DAY_MS,
    ...overrides,
  };
}

interface Fixture {
  readonly store: InMemoryTaxCloudConnectionStore;
  readonly audit: InMemoryAuditTrail;
  readonly options: (transport: TaxCloudTransport) => TaxCloudConnectOptions;
  readonly lastError: () => string | null;
}

function fixtureOf(now: () => number = (): number => NOW): Fixture {
  const store = new InMemoryTaxCloudConnectionStore({ now });
  const audit = createInMemoryAuditTrail();

  return {
    store,
    audit,
    lastError: (): string | null => {
      const last = audit.entries.at(-1);
      return last === undefined ? null : String(last.action);
    },
    options: (transport: TaxCloudTransport): TaxCloudConnectOptions => ({ store, sealer, audit, transport, now }),
  };
}

async function connectedFixture(
  answer: TaxCloudTransportAnswer | Error = { status: 200, body: JSON.stringify({ message: "ok" }) },
): Promise<{ readonly fixture: Fixture; readonly script: ScriptedTransport; readonly rowId: string }> {
  const fixture = fixtureOf();
  const script = transportAnswering(answer);
  const connected = await connectTaxCloudAccount(
    { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: API_KEY },
    fixture.options(script.transport),
  );

  if (connected.status !== "connected") throw new Error(`the fixture could not connect: ${connected.reason}`);

  return { fixture, script, rowId: connected.connection.id };
}

function mustRow(store: TaxCloudConnectionStore, id: string): Promise<TaxCloudConnectionRow> {
  return store.findById(id).then((row) => {
    if (row === null) throw new Error(`the fixture lost the row ${id}`);

    return row;
  });
}

/** The table's own SQL, read rather than restated, so a column renamed there fails here. */
const MIGRATION = readFileSync(new URL("../../migrations/0036_taxcloud_connections.sql", import.meta.url), "utf8");
const POLICIES = readFileSync(new URL("../../migrations/0073_office_and_secret_policies.sql", import.meta.url), "utf8");

/* ---- section 1: the constants against the migration ---- */

function checkConstants(): void {
  expectEqual(TAXCLOUD_CONNECTION_TABLE, "taxcloud_connections", "the table is the one STEP 023 created");
  expectEqual(TAXCLOUD_STORED_STATUSES.join(","), "pending,active,disabled", "the three statuses are the table's words");
  expectEqual(
    MIGRATION.includes("status in ('pending', 'active', 'disabled')"),
    true,
    "the migration allows exactly those three",
  );
  expectEqual(TAXCLOUD_CONNECT_ROLES.join(","), "owner", "the merchant's owner connects the account");
  expectEqual(TAXCLOUD_ENCRYPTION_KEY_VERSION, 1, "this build seals under the first key version");
  expectEqual(MIGRATION.includes("encryption_key_version between 1 and 999"), true, "the table allows 1 to 999");
  expectEqual(MIGRATION.includes("api_id_last_four ~ '^[A-Za-z0-9]{4}$'"), true, "the mask is four letters or digits");
  expectEqual(TAXCLOUD_LAST_FOUR_PATTERN.source, "^[A-Za-z0-9]{4}$", "the pattern here is the one the column checks");
  expectEqual(
    MIGRATION.includes(`char_length(last_error) between 1 and ${TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH}`),
    true,
    "the error column bound is the one this file uses",
  );
  expectEqual(
    MIGRATION.includes(`char_length(api_key_ciphertext) between ${TAXCLOUD_SEALED_MINIMUM_LENGTH} and ${TAXCLOUD_SEALED_MAXIMUM_LENGTH}`),
    true,
    "the sealed bounds are the column's own",
  );
  expectEqual(TAXCLOUD_CLIENT_TIMEOUT_MS, 15_000, "the transport waits fifteen seconds");
  expectEqual(TAXCLOUD_ANSWER_MAXIMUM_BYTES, 65_536, "the transport reads at most 64 KiB");
  expectEqual(TAXCLOUD_CLIENT_ALLOWED_HEADERS.includes("X-API-KEY"), true, "the key header is allowed");
  expectEqual(TAXCLOUD_CLIENT_ALLOWED_HEADERS.includes("Authorization"), false, "the refused header is not allowed");
  expectEqual(TAXCLOUD_CLIENT_ALLOWED_METHODS.join(","), "GET,POST,PATCH,DELETE", "the documented methods are the allowed ones");
  expectEqual(TAXCLOUD_VERIFY_STATUSES.join(","), "verified,rejected,unanswered,refused,failed", "five outcomes answer a verify");
  expectEqual(TAXCLOUD_CONNECT_AUDIT_ACTIONS.length, 5, "five actions are recorded");

  // The insert writes exactly the columns the table needs, and never the ones its defaults own.
  const sqlColumns = [
    "company_id",
    "api_id_last_four",
    "api_id_ciphertext",
    "api_id_iv",
    "api_id_tag",
    "api_key_last_four",
    "api_key_ciphertext",
    "api_key_iv",
    "api_key_tag",
    "encryption_key_version",
    "status",
    "collection_enabled",
    "verified_at",
    "last_error",
  ];

  expectEqual(TAXCLOUD_INSERT_COLUMNS.join(","), sqlColumns.join(","), "the insert columns are the table's");

  for (const column of sqlColumns) {
    expectEqual(MIGRATION.includes(`  ${column} `), true, `the migration declares ${column}`);
  }

  for (const owned of ["id", "version", "created_at", "updated_at", "deleted_at"]) {
    expectEqual(TAXCLOUD_INSERT_COLUMNS.includes(owned), false, `the insert leaves ${owned} to the table`);
  }

  // The transaction vocabulary this module writes a row into is a CHECK on the table, not a convention.
  expectEqual(MIGRATION.includes("(status = 'active') = (verified_at is not null)"), true, "verified_at tracks active");
  expectEqual(MIGRATION.includes("collection_enabled = false or status = 'active'"), true, "collection needs active");
  expectEqual(
    MIGRATION.includes("where deleted_at is null and status <> 'disabled'"),
    true,
    "the usable row index is the one the store skips",
  );
  expectEqual(MIGRATION.includes("taxcloud_connections_guard_credentials"), true, "the credential guard trigger exists");
  expectEqual(MIGRATION.includes("taxcloud_connections_default_deny"), true, "the table is default deny");

  // STEP 0073's policies are why every write in this file is the server's.
  expectEqual(POLICIES.includes("taxcloud_connections_merchant_insert"), true, "the merchant may insert");
  expectEqual(POLICIES.includes("verified_at is null"), true, "the merchant may not write a verification");
  expectEqual(POLICIES.includes("create policy taxcloud_connections_super_admin_all"), true, "the office policy exists");
}

/* ---- section 2: the permission ---- */

function checkPermission(): void {
  expectEqual(requireTaxCloudConnectActor(ownerActor()).userId, OWNER_ID, "an owner with a second factor is allowed");
  expectEqual(canManageTaxCloudConnection(ownerActor()), true, "the screen enables the form for the same actor");
  expectEqual(
    errorCodeOf(() => requireTaxCloudConnectActor(ownerActor({ twoFactorSatisfied: false }))),
    "PERMISSION_DENIED",
    "an aal1 session is refused",
  );
  expectEqual(
    canManageTaxCloudConnection(ownerActor({ twoFactorSatisfied: false })),
    false,
    "the screen disables the form for the same actor",
  );
  expectEqual(
    errorCodeOf(() => requireTaxCloudConnectActor(ownerActor({ twoFactorEnrolmentRequired: true }))),
    "PERMISSION_DENIED",
    "an actor that still owes a factor is refused",
  );

  for (const role of ["super_admin", "ceo", "compliance_kyc", "finance_ops", "support", "blogger"] as const) {
    expectEqual(
      errorCodeOf(() => requireTaxCloudConnectActor(ownerActor({ roles: [role] }))),
      "PERMISSION_DENIED",
      `a ${role} does not enter a merchant's tax credential`,
    );
  }

  expectEqual(
    errorFieldOf(() => requireTaxCloudConnectActor(ownerActor({ twoFactorSatisfied: false }))),
    "actor.twoFactorSatisfied",
    "the refusal names the factor",
  );
}

/* ---- section 3: the two scopes ---- */

function checkScopes(): void {
  expectEqual(
    taxCloudConnectionIdScope(COMPANY),
    `taxcloud:connection-id:${COMPANY}`,
    "the connection id box has its own scope",
  );
  expectEqual(taxCloudApiKeyScope(COMPANY), `taxcloud:api-key:${COMPANY}`, "the key box has its own scope");
  expect(taxCloudConnectionIdScope(COMPANY) !== taxCloudApiKeyScope(COMPANY), "the two scopes differ");
  expect(taxCloudConnectionIdScope(COMPANY) !== taxCloudConnectionIdScope(OTHER_COMPANY), "a scope names the company");

  const box = sealer.seal(API_KEY, taxCloudApiKeyScope(COMPANY));

  expectEqual(sealer.open(box, taxCloudApiKeyScope(COMPANY)), API_KEY, "a box opens under its own scope");
  expectEqual(
    errorCodeOf(() => sealer.open(box, taxCloudConnectionIdScope(COMPANY))),
    "INTERNAL_ERROR",
    "a box does not open under the other scope",
  );
  expectEqual(
    errorCodeOf(() => sealer.open(box, taxCloudApiKeyScope(OTHER_COMPANY))),
    "INTERNAL_ERROR",
    "a box does not open for another company",
  );
  expect(box.ciphertext.includes(API_KEY) === false, "the ciphertext holds no part of the plaintext");
  expect(isTaxCloudSealedValue(box), "a sealed value is the shape the columns hold");

  for (const companyId of [COMPANY, OTHER_COMPANY, "0f0e0d0c-0b0a-4908-8706-050403020100"]) {
    expectEqual(isTaxCloudCompanyId(companyId), true, `the company shape accepts ${companyId}`);
  }

  for (const companyId of ["", " ", "a b", "company with space", "x".repeat(65), "company|pipe"]) {
    expectEqual(isTaxCloudCompanyId(companyId), false, `the company shape refuses ${JSON.stringify(companyId)}`);
  }
}

/* ---- section 4: the row's invariants ---- */

function goodRow(): TaxCloudConnectionRow {
  return {
    id: "0b6f0d0e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    companyId: COMPANY,
    connectionIdLastFour: "4a6f",
    connectionIdBox: sealer.seal(CONNECTION_ID, taxCloudConnectionIdScope(COMPANY)),
    apiKeyLastFour: "1c2d",
    apiKeyBox: sealer.seal(API_KEY, taxCloudApiKeyScope(COMPANY)),
    encryptionKeyVersion: 1,
    status: "pending",
    collectionEnabled: false,
    verifiedAtEpochMs: null,
    lastError: null,
    version: 1,
    createdAtEpochMs: NOW - DAY_MS,
    updatedAtEpochMs: NOW - DAY_MS,
    deletedAtEpochMs: null,
  };
}

function checkRow(): void {
  expectEqual(taxCloudRowProblemOf(goodRow()), null, "a pending row is well-formed");
  expectEqual(
    taxCloudRowProblemOf({ ...goodRow(), status: "active", verifiedAtEpochMs: NOW }),
    null,
    "an active row with an instant is well-formed",
  );
  expectEqual(
    taxCloudRowProblemOf({ ...goodRow(), status: "disabled", lastError: null }),
    null,
    "a disabled row is well-formed",
  );

  const refusals: readonly (readonly [string, TaxCloudConnectionRow])[] = [
    ["an empty row id", { ...goodRow(), id: " " }],
    ["a missing company", { ...goodRow(), companyId: "" }],
    ["a three character mask", { ...goodRow(), connectionIdLastFour: "4a6" }],
    ["a mask with a symbol", { ...goodRow(), apiKeyLastFour: "1c2-" }],
    ["an unsealed connection id", { ...goodRow(), connectionIdBox: { iv: "x", tag: "y", ciphertext: "z" } }],
    ["an unsealed key", { ...goodRow(), apiKeyBox: { iv: "x", tag: "y", ciphertext: "z" } }],
    ["a key version of zero", { ...goodRow(), encryptionKeyVersion: 0 }],
    ["a key version past the column", { ...goodRow(), encryptionKeyVersion: 1_000 }],
    ["an unknown status", { ...goodRow(), status: "failed" as never }],
    ["an active row with no instant", { ...goodRow(), status: "active" }],
    ["a pending row with an instant", { ...goodRow(), verifiedAtEpochMs: NOW }],
    ["collection on a pending row", { ...goodRow(), collectionEnabled: true }],
    ["an empty error", { ...goodRow(), lastError: "" }],
    ["an error past the column", { ...goodRow(), lastError: "x".repeat(TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH + 1) }],
    ["an untrimmed error", { ...goodRow(), lastError: " failed " }],
    ["a version of zero", { ...goodRow(), version: 0 }],
    ["an update before the insert", { ...goodRow(), updatedAtEpochMs: NOW - 2 * DAY_MS }],
    ["a delete before the insert", { ...goodRow(), deletedAtEpochMs: NOW - 2 * DAY_MS }],
    ["a verification instant of zero", { ...goodRow(), status: "active", verifiedAtEpochMs: 0 }],
  ];

  for (const [name, row] of refusals) {
    expect(taxCloudRowProblemOf(row) !== null, `the row check refuses ${name}`);
  }

  expectEqual(isTaxCloudStoredStatus("active"), true, "the status reader accepts an active row");
  expectEqual(isTaxCloudStoredStatus("failed"), false, "the status reader refuses the word the table lacks");
}

/* ---- section 5: the insert values ---- */

function checkInsertValues(): void {
  const row = goodRow();
  const values = taxCloudInsertValuesOf(row);

  expectEqual(Object.keys(values).join(","), TAXCLOUD_INSERT_COLUMNS.join(","), "the values are exactly those columns");
  expectEqual(values["status"], "pending", "a new row is written pending");
  expectEqual(values["collection_enabled"], false, "a new row collects nothing");
  expectEqual(values["verified_at"], null, "a new row claims no verification");
  expectEqual(values["encryption_key_version"], 1, "a new row names the key version");
  expectEqual(values["api_key_last_four"], "1c2d", "the key's four characters are stored");
  expectEqual(values["api_id_last_four"], "4a6f", "the connection id's four characters are stored");
  expectEqual(JSON.stringify(values).includes(API_KEY), false, "no plaintext key is written");
  expectEqual(JSON.stringify(values).includes(CONNECTION_ID), false, "no plaintext connection id is written");
  expectEqual(values["company_id"], COMPANY, "the row belongs to the company");

  const verified = taxCloudInsertValuesOf({ ...row, status: "active", verifiedAtEpochMs: NOW });
  expectEqual(verified["verified_at"], new Date(NOW).toISOString(), "an instant is written as a timestamp");

  // The REST mapping is the inverse, and it refuses a row it cannot believe.
  const record = {
    id: row.id,
    company_id: row.companyId,
    api_id_last_four: row.connectionIdLastFour,
    api_id_ciphertext: row.connectionIdBox.ciphertext,
    api_id_iv: row.connectionIdBox.iv,
    api_id_tag: row.connectionIdBox.tag,
    api_key_last_four: row.apiKeyLastFour,
    api_key_ciphertext: row.apiKeyBox.ciphertext,
    api_key_iv: row.apiKeyBox.iv,
    api_key_tag: row.apiKeyBox.tag,
    encryption_key_version: 1,
    status: "active",
    collection_enabled: true,
    verified_at: new Date(NOW).toISOString(),
    last_error: null,
    created_at: new Date(NOW - DAY_MS).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    deleted_at: null,
    version: 2,
  };
  const mapped = taxCloudRowOfRecord(record);

  expectEqual(mapped.status, "active", "a stored active row reads as active");
  expectEqual(mapped.verifiedAtEpochMs, NOW, "a stored instant reads as milliseconds");
  expectEqual(mapped.deletedAtEpochMs, null, "a stored null reads as null");
  expectEqual(mapped.version, 2, "the version is carried");
  expectEqual(
    errorCodeOf(() => taxCloudRowOfRecord({ ...record, status: "failed" })),
    "INTERNAL_ERROR",
    "a stored status outside the three is a defect",
  );
  expectEqual(
    errorCodeOf(() => taxCloudRowOfRecord({ ...record, created_at: "not a date" })),
    "INTERNAL_ERROR",
    "a stored timestamp that is not one is a defect",
  );
  expectEqual(
    errorCodeOf(() => taxCloudRowOfRecord({ ...record, collection_enabled: false, status: "pending", verified_at: null })),
    "no_error",
    "a pending row with the switch off is believed",
  );
  expectEqual(taxCloudEpochOf(new Date(NOW).toISOString()), NOW, "a stored instant reads as milliseconds");
  expectEqual(
    errorCodeOf(() => taxCloudEpochOf("1970-01-01T00:00:00.000Z")),
    "INTERNAL_ERROR",
    "an instant before the epoch is not a timestamp",
  );
}

/* ---- section 6: the store ---- */

async function checkStore(): Promise<void> {
  const store = new InMemoryTaxCloudConnectionStore({ now: () => NOW });
  const row = await store.insert(newRow());

  expectEqual(row.version, 1, "a new row starts at version one");
  expectEqual(row.createdAtEpochMs, NOW, "the store stamps the creation");
  expectEqual(row.status, "pending", "a new row is pending");
  expectEqual(taxCloudRowProblemOf(row), null, "the stored row is well-formed");
  expectEqual((await store.listByCompany(COMPANY)).length, 1, "the company has one row");
  expectEqual((await store.listByCompany(OTHER_COMPANY)).length, 0, "another company has none");
  expectEqual((await store.findById(row.id))?.id, row.id, "the row is reachable by id");
  expectEqual(await store.findById("0b6f0d0e-1a2b-4c3d-8e4f-5a6b7c8d9e00"), null, "an unknown id reads null");

  expectEqual(
    await errorCodeOfAsync(async () => store.insert(newRow())),
    "CONFLICT",
    "a second usable row for one company is a conflict",
  );

  const claimed: TaxCloudConnectionRow = { ...row, status: "active", version: 2, updatedAtEpochMs: NOW };
  expectEqual(await store.save(claimed, 1), false, "an active row with no verification instant is refused");
  expectEqual(await store.save({ ...row, version: 3 }, 1), false, "a version that jumps is refused");
  expectEqual(await store.save({ ...row, version: 2 }, 2), false, "a stale expected version is refused");
  expectEqual(
    await store.save({ ...row, apiKeyBox: sealer.seal(`${API_KEY}9`, taxCloudApiKeyScope(COMPANY)), version: 2 }, 1),
    false,
    "a credential is never swapped in place",
  );
  expectEqual(
    await store.save(
      { ...row, connectionIdBox: sealer.seal("3f2b6c1e-9a41-4d7b-8e55-0b7c1d2e4a70", taxCloudConnectionIdScope(COMPANY)), version: 2 },
      1,
    ),
    false,
    "the connection id box is guarded on its own",
  );
  expectEqual(
    await store.save({ ...row, companyId: OTHER_COMPANY, version: 2 }, 1),
    false,
    "a row keeps its merchant",
  );
  expectEqual(
    await store.save({ ...row, status: "active", verifiedAtEpochMs: NOW, version: 2, updatedAtEpochMs: NOW }, 1),
    true,
    "a verified write is accepted",
  );
  expectEqual(await store.save({ ...row, status: "disabled", version: 2 }, 1), false, "a write on a moved row is refused");

  const disabled = (await store.findById(row.id)) as TaxCloudConnectionRow;
  const done = await store.save(
    { ...disabled, status: "disabled", verifiedAtEpochMs: null, collectionEnabled: false, version: 3, updatedAtEpochMs: NOW },
    disabled.version,
  );

  expectEqual(done, true, "an active row may be disabled");
  expectEqual(
    await store.save({ ...disabled, status: "active", verifiedAtEpochMs: NOW, version: 3 }, disabled.version),
    false,
    "a disabled row is not revived in place",
  );

  const second = await store.insert(newRow());
  expectEqual(second.status, "pending", "a merchant with only history may connect again");
  expectEqual((await store.listByCompany(COMPANY)).length, 2, "history and the new row coexist");
  expectEqual((await store.listByCompany(COMPANY))[0]?.id, second.id, "the newest row is listed first");
}

function newRow(): Parameters<TaxCloudConnectionStore["insert"]>[0] {
  return {
    companyId: COMPANY,
    connectionIdLastFour: "4a6f",
    connectionIdBox: sealer.seal(CONNECTION_ID, taxCloudConnectionIdScope(COMPANY)),
    apiKeyLastFour: "1c2d",
    apiKeyBox: sealer.seal(API_KEY, taxCloudApiKeyScope(COMPANY)),
    encryptionKeyVersion: 1,
    status: "pending",
    collectionEnabled: false,
    verifiedAtEpochMs: null,
    lastError: null,
  };
}

/* ---- section 7: connecting ---- */

async function checkConnect(): Promise<void> {
  expectEqual(
    taxCloudConnectProblemOf({ connectionId: "not-a-uuid", apiKey: API_KEY }),
    "the connection ID is the UUID-shaped value the TaxCloud dashboard shows under Integrations",
    "a bad connection id is refused",
  );
  expectEqual(taxCloudConnectProblemOf({ connectionId: CONNECTION_ID, apiKey: "short" }), "that key is shorter than any value TaxCloud issues", "a short key is refused");
  expectEqual(taxCloudConnectProblemOf({ connectionId: CONNECTION_ID, apiKey: API_KEY }), null, "a good pair passes");
  expectEqual(taxCloudMaskProblemOf(API_KEY), null, "the fixture key can be masked");
  expect(
    (taxCloudMaskProblemOf("a".repeat(20) + "-") ?? "").includes("symbol") === true,
    "a key ending in a symbol cannot be masked and says so",
  );

  const fixture = fixtureOf();
  const script = transportAnswering({ status: 200, body: "{}" });

  expectEqual(
    await errorCodeOfAsync(async () =>
      connectTaxCloudAccount(
        { actor: ownerActor({ roles: ["super_admin"] }), connectionId: CONNECTION_ID, apiKey: API_KEY },
        fixture.options(script.transport),
      ),
    ),
    "PERMISSION_DENIED",
    "a super administrator cannot enter a merchant's credential",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      connectTaxCloudAccount(
        { actor: ownerActor({ twoFactorSatisfied: false }), connectionId: CONNECTION_ID, apiKey: API_KEY },
        fixture.options(script.transport),
      ),
    ),
    "PERMISSION_DENIED",
    "an aal1 session cannot enter a credential",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      connectTaxCloudAccount(
        { actor: ownerActor({ companyId: null }), connectionId: CONNECTION_ID, apiKey: API_KEY },
        fixture.options(script.transport),
      ),
    ),
    "PERMISSION_DENIED",
    "a platform account with no company cannot connect",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      connectTaxCloudAccount(
        { actor: ownerActor(), connectionId: "nope", apiKey: API_KEY },
        fixture.options(script.transport),
      ),
    ),
    "VALIDATION_FAILED",
    "a malformed connection id is a validation failure",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      connectTaxCloudAccount(
        { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: "   " },
        fixture.options(script.transport),
      ),
    ),
    "VALIDATION_FAILED",
    "a blank key is a validation failure",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      connectTaxCloudAccount(
        { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: `${"k".repeat(20)}-` },
        fixture.options(script.transport),
      ),
    ),
    "VALIDATION_FAILED",
    "a key the table cannot mask is refused before anything is sealed",
  );
  expectEqual(fixture.audit.entries.length, 0, "a refused connect writes no row and no audit entry");
  expectEqual((await fixture.store.listByCompany(COMPANY)).length, 0, "a refused connect stores nothing");

  const connected = await connectTaxCloudAccount(
    { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: API_KEY },
    fixture.options(script.transport),
  );

  if (connected.status !== "connected") throw new Error("the control connect was refused");

  const row = await mustRow(fixture.store, connected.connection.id);

  expectEqual(row.status, "pending", "a connect leaves the row pending");
  expectEqual(row.verifiedAtEpochMs, null, "a connect claims no verification");
  expectEqual(row.collectionEnabled, false, "a connect turns no switch on");
  expectEqual(row.encryptionKeyVersion, 1, "a connect records the key version");
  expectEqual(row.connectionIdLastFour, "4a6f", "the connection id mask is stored");
  expectEqual(row.apiKeyLastFour, "1c2d", "the key mask is stored");
  expectEqual(JSON.stringify(row).includes(API_KEY), false, "the stored row holds no plaintext key");
  expectEqual(JSON.stringify(row).includes(CONNECTION_ID), false, "the stored row holds no plaintext connection id");
  expectEqual(sealer.open(row.apiKeyBox, taxCloudApiKeyScope(COMPANY)), API_KEY, "the key opens under its scope");
  expectEqual(sealer.open(row.connectionIdBox, taxCloudConnectionIdScope(COMPANY)), CONNECTION_ID, "the id opens under its scope");
  expectEqual(script.calls.length, 0, "a connect makes no call: verification is a separate act");
  expectEqual(connected.connection.status, "pending", "the view says pending");
  expectEqual(connected.connection.connectionIdHint, taxCloudHintOf("4a6f"), "the view shows four characters of the id");
  expectEqual(connected.connection.apiKeyHint, taxCloudHintOf("1c2d"), "the view shows four characters of the key");
  expectEqual(connected.connection.statusMessage, taxCloudStatusMessageOf("pending"), "the view carries the sentence");
  expectEqual(JSON.stringify(connected.connection).includes(API_KEY), false, "the view holds no key");
  expectEqual(JSON.stringify(connected.connection).includes(API_KEY.slice(-8)), false, "the view holds no run of eight key characters");

  expectEqual(fixture.audit.entries.length, 1, "a connect writes one audit entry");
  const entry = fixture.audit.entries[0] as AuditEntry;

  expectEqual(entry.action, "taxcloud.connection_connected", "the entry names the action");
  expectEqual(entry.entityType, "tax_connection", "the entry names the entity type");
  expectEqual(entry.entityId, row.id, "the entry names the row");
  expectEqual(entry.companyId, COMPANY, "the entry belongs to the company");
  expectEqual(entry.actorUserId, OWNER_ID, "the entry names the actor");
  expectEqual(JSON.stringify(entry.payload).includes(API_KEY), false, "the entry holds no key");
  expectEqual(JSON.stringify(entry.payload).includes(CONNECTION_ID), false, "the entry holds no connection id");
  expectEqual(entry.payload["api_key_last_four"], "1c2d", "the entry holds the mask");
  expectEqual(entry.payload["status_after"], "pending", "the entry holds the status");

  const again = await connectTaxCloudAccount(
    { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: API_KEY },
    fixture.options(script.transport),
  );

  expectEqual(again.status, "refused", "a second connect is refused while one is usable");
  expectEqual(
    again.status === "refused" ? again.reason : "",
    "this merchant already has a TaxCloud connection; disconnect it before connecting another",
    "the refusal says what to do",
  );
  expectEqual((await fixture.store.listByCompany(COMPANY)).length, 1, "the second connect stored nothing");
  expectEqual(fixture.audit.entries.length, 1, "the refusal wrote no audit entry");

  // A keyring that cannot seal means nothing is written, and the merchant is told why.
  const brokenSeal = fixtureOf();
  const refusingSeal = await connectTaxCloudAccount(
    { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: API_KEY },
    {
      ...brokenSeal.options(script.transport),
      sealer: {
        seal: (): never => {
          throw new Error("no key");
        },
        open: (): never => {
          throw new Error("no key");
        },
      },
    },
  );

  expectEqual(refusingSeal.status, "refused", "a sealer failure is a refusal");
  expectEqual(
    refusingSeal.status === "refused" ? refusingSeal.reason : "",
    "the encryption keyring cannot seal a credential, so nothing was stored",
    "the refusal says what failed",
  );
  expectEqual((await brokenSeal.store.listByCompany(COMPANY)).length, 0, "a sealer failure stores nothing");
  expectEqual(brokenSeal.audit.entries.length, 0, "a sealer failure audits nothing");

  const otherCompany = await connectTaxCloudAccount(
    { actor: ownerActor({ companyId: OTHER_COMPANY, userId: "user_owner_tax_0002", sessionId: "session_tax_0002" }), connectionId: CONNECTION_ID, apiKey: API_KEY },
    fixture.options(script.transport),
  );

  expectEqual(otherCompany.status, "connected", "a second merchant may connect the same TaxCloud account");
  expectEqual((await fixture.store.listByCompany(OTHER_COMPANY)).length, 1, "the second merchant has its own row");
}

/* ---- section 8: the ping request ---- */

async function checkVerifyRequest(): Promise<void> {
  const { fixture, script, rowId } = await connectedFixture();
  const answered = await verifyTaxCloudConnection({ actor: ownerActor(), connectionRowId: rowId }, fixture.options(script.transport));

  expectEqual(answered.status, "verified", "a 200 verifies the connection");
  expectEqual(script.calls.length, 1, "one ping is one call");

  const call = script.calls[0] as TaxCloudTransportCall;

  expectEqual(call.method, "GET", "the ping is a GET");
  expectEqual(call.url, `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/ping`, "the URL is the documented ping");
  expectEqual(call.body, null, "the ping carries no body");
  expectEqual(call.headers["X-API-KEY"], API_KEY, "the key travels in the one header TaxCloud documents");
  expectEqual(call.headers["Accept"], "application/json", "the call accepts JSON");
  expectEqual(call.headers["Content-Type"], undefined, "a bodyless call sends no content type");
  expectEqual(Object.keys(call.headers).includes("Authorization"), false, "no Authorization header is built");
  expectEqual(call.url.includes(API_KEY), false, "the key is not in the URL");

  // The values come from the sealed row, not from the caller: a row whose key box holds another value pings with that value.
  const other = fixtureOf();
  const script2 = transportAnswering({ status: 200, body: "{}" });
  const connected = await connectTaxCloudAccount(
    { actor: ownerActor(), connectionId: CONNECTION_ID, apiKey: "eyJhbGciOiJIUzI1NiJ9.second.key.9z8y7x6" },
    other.options(script2.transport),
  );

  if (connected.status !== "connected") throw new Error("the second fixture was refused");

  await verifyTaxCloudConnection({ actor: ownerActor(), connectionRowId: connected.connection.id }, other.options(script2.transport));
  expectEqual((script2.calls[0] as TaxCloudTransportCall).headers["X-API-KEY"], "eyJhbGciOiJIUzI1NiJ9.second.key.9z8y7x6", "the ping uses the stored key");
}

/* ---- section 9: the ping outcomes ---- */

async function checkVerifyOutcomes(): Promise<void> {
  const ok = await connectedFixture({ status: 200, body: JSON.stringify({ message: "TaxCloud API is working" }) });
  const verified = await verifyTaxCloudConnection({ actor: ownerActor(), connectionRowId: ok.rowId }, ok.fixture.options(ok.script.transport));
  const verifiedRow = await mustRow(ok.fixture.store, ok.rowId);

  expectEqual(verified.status, "verified", "a 200 verifies");
  expectEqual(verifiedRow.status, "active", "a verified row is active");
  expectEqual(verifiedRow.verifiedAtEpochMs, NOW, "the instant of the ping is recorded");
  expectEqual(verifiedRow.lastError, null, "a verified row clears the error");
  expectEqual(verifiedRow.version, 2, "the write moves the version");
  expectEqual(ok.fixture.audit.entries.at(-1)?.action, "taxcloud.connection_verified", "the verification is audited");
  expectEqual(ok.fixture.audit.entries.at(-1)?.payload["status_before"], "pending", "the entry records what it was");
  expectEqual(verified.status === "verified" ? verified.message : "", taxCloudPingMessageOfForGate("verified"), "the message is the documented one");

  // A second successful ping refreshes the instant rather than keeping the first one.
  const refreshed = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: ok.rowId },
    { ...ok.fixture.options(ok.script.transport), now: (): number => NOW + 5_000 },
  );
  const refreshedRow = await mustRow(ok.fixture.store, ok.rowId);

  expectEqual(refreshed.status, "verified", "a repeated ping verifies again");
  expectEqual(refreshedRow.verifiedAtEpochMs, NOW + 5_000, "the instant is the latest ping, not the first");
  expectEqual(refreshedRow.version, 3, "the second write moves the version again");
  expectEqual(refreshedRow.collectionEnabled, false, "a verification never turns the switch on by itself");

  // A temporary failure decides nothing about a working connection.
  const outage = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: ok.rowId },
    ok.fixture.options(transportAnswering({ status: 503, body: "{}" }).transport),
  );
  const afterOutage = await mustRow(ok.fixture.store, ok.rowId);

  expectEqual(outage.status, "unanswered", "a 503 is not a verdict");
  expectEqual(afterOutage.status, "active", "an outage leaves an active connection active");
  expectEqual(afterOutage.verifiedAtEpochMs, NOW + 5_000, "an outage keeps the verification instant");
  expect(afterOutage.lastError !== null && afterOutage.lastError.includes("could not be reached"), "the outage is recorded as unreached");
  expectEqual(ok.fixture.audit.entries.at(-1)?.action, "taxcloud.connection_unanswered", "the outage is audited");

  for (const status of [429, 500, 503]) {
    const scripted = await connectedFixture({ status, body: "{}" });
    const answer = await verifyTaxCloudConnection(
      { actor: ownerActor(), connectionRowId: scripted.rowId },
      scripted.fixture.options(scripted.script.transport),
    );
    const row = await mustRow(scripted.fixture.store, scripted.rowId);

    expectEqual(answer.status, "unanswered", `a ${status} decides nothing`);
    expectEqual(row.status, "pending", `a ${status} leaves a pending row pending`);
    expectEqual(row.verifiedAtEpochMs, null, `a ${status} records no verification`);
  }

  // A thrown transport is the same answer as an unreachable server.
  const thrown = await connectedFixture(new Error("socket hang up"));
  const thrownAnswer = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: thrown.rowId },
    thrown.fixture.options(thrown.script.transport),
  );

  expectEqual(thrownAnswer.status, "unanswered", "a thrown transport is unanswered");
  expectEqual(
    thrownAnswer.status === "unanswered" ? thrownAnswer.outcome : "",
    "unreachable",
    "a thrown transport reads as unreachable",
  );

  // An undocumented status is not a verdict either.
  const odd = await connectedFixture({ status: 418, body: "{}" });
  const oddAnswer = await verifyTaxCloudConnection({ actor: ownerActor(), connectionRowId: odd.rowId }, odd.fixture.options(odd.script.transport));

  expectEqual(oddAnswer.status, "unanswered", "an undocumented status is unanswered");
  expectEqual(oddAnswer.status === "unanswered" ? oddAnswer.outcome : "", "unexpected", "an undocumented status reads as unexpected");

  // A wrong key: rejected, pending, and the sentence names the header.
  const wrongKey = await connectedFixture({ status: 401, body: JSON.stringify({ title: "Unauthorized", detail: "Invalid API key" }) });
  const rejected = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: wrongKey.rowId },
    wrongKey.fixture.options(wrongKey.script.transport),
  );
  const rejectedRow = await mustRow(wrongKey.fixture.store, wrongKey.rowId);

  expectEqual(rejected.status, "rejected", "a 401 is a rejection");
  expectEqual(rejectedRow.status, "pending", "a rejected row stays pending");
  expectEqual(rejectedRow.verifiedAtEpochMs, null, "a rejected row records no verification");
  expect(rejectedRow.lastError !== null && rejectedRow.lastError.includes("X-API-KEY"), "the sentence names the header");
  expect(rejectedRow.lastError !== null && rejectedRow.lastError.includes("Invalid API key"), "TaxCloud's own detail is kept");
  expectEqual(wrongKey.fixture.audit.entries.at(-1)?.action, "taxcloud.connection_rejected", "the rejection is audited");

  // A mistyped connection: rejected, and the sentence names the connection ID.
  const missing = await connectedFixture({ status: 404, body: "{}" });
  const notFound = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: missing.rowId },
    missing.fixture.options(missing.script.transport),
  );
  const notFoundRow = await mustRow(missing.fixture.store, missing.rowId);

  expectEqual(notFound.status, "rejected", "a 404 is a rejection");
  expect(notFoundRow.lastError !== null && notFoundRow.lastError.includes("connection ID") === true, "the sentence names the connection id");
  expect(
    (notFoundRow.lastError ?? "") !== (rejectedRow.lastError ?? ""),
    "the two rejections are two different sentences",
  );

  // A key that stopped working demotes an active connection and turns its switch off.
  const revoked = await connectedFixture({ status: 200, body: "{}" });
  const revokedScripts = transportAnswering({ status: 200, body: "{}" });

  await verifyTaxCloudConnection({ actor: ownerActor(), connectionRowId: revoked.rowId }, revoked.fixture.options(revokedScripts.transport));
  const active = await mustRow(revoked.fixture.store, revoked.rowId);

  expectEqual(active.status, "active", "the connection was verified first");

  const collectionOn = await revoked.fixture.store.save(
    { ...active, collectionEnabled: true, version: active.version + 1, updatedAtEpochMs: NOW },
    active.version,
  );

  expectEqual(collectionOn, true, "the switch can be on for an active connection");

  const refusedKey = transportAnswering({ status: 401, body: "{}" });
  const demoted = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: revoked.rowId },
    revoked.fixture.options(refusedKey.transport),
  );
  const demotedRow = await mustRow(revoked.fixture.store, revoked.rowId);

  expectEqual(demoted.status, "rejected", "a refused key is a rejection");
  expectEqual(demotedRow.status, "pending", "a refused key demotes an active connection");
  expectEqual(demotedRow.verifiedAtEpochMs, null, "the verification instant clears");
  expectEqual(demotedRow.collectionEnabled, false, "the switch turns off with the proof");
  expectEqual(revoked.fixture.audit.entries.at(-1)?.payload["status_before"], "active", "the entry records the demotion");

  // A lost version race is a conflict, not a silent overwrite.
  const race = await connectedFixture({ status: 200, body: "{}" });
  const raced = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: race.rowId },
    {
      ...race.fixture.options(race.script.transport),
      store: {
        listByCompany: (companyId: string) => race.fixture.store.listByCompany(companyId),
        insert: (row: Parameters<TaxCloudConnectionStore["insert"]>[0]) => race.fixture.store.insert(row),
        save: (next: TaxCloudConnectionRow, expectedVersion: number) => race.fixture.store.save(next, expectedVersion),
        findById: async (id: string) => {
          const row = await race.fixture.store.findById(id);

          return row === null ? null : { ...row, version: 9 };
        },
      },
    },
  ).catch((error: unknown) => error);

  expectEqual(raced instanceof AppError ? raced.code : "no_error", "CONFLICT", "a lost race is a conflict");

  // A connection of another merchant is not found, and the answer does not say whose it is.
  const mine = await connectedFixture();
  expectEqual(
    await errorCodeOfAsync(async () =>
      verifyTaxCloudConnection(
        { actor: ownerActor({ companyId: OTHER_COMPANY }), connectionRowId: mine.rowId },
        mine.fixture.options(mine.script.transport),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "another merchant's row is not found",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      verifyTaxCloudConnection(
        { actor: ownerActor(), connectionRowId: "0b6f0d0e-1a2b-4c3d-8e4f-5a6b7c8d9e00" },
        mine.fixture.options(mine.script.transport),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "an unknown row is not found",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      verifyTaxCloudConnection(
        { actor: ownerActor({ twoFactorSatisfied: false }), connectionRowId: mine.rowId },
        mine.fixture.options(mine.script.transport),
      ),
    ),
    "PERMISSION_DENIED",
    "an aal1 session cannot verify",
  );

  // A disconnected connection cannot be verified.
  const closed = await connectedFixture();
  const closedVerify = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: closed.rowId },
    closed.fixture.options(closed.script.transport),
  );

  expectEqual(closedVerify.status, "verified", "the fixture verified first");
  await disconnectTaxCloudConnection({ actor: ownerActor(), connectionRowId: closed.rowId }, closed.fixture.options(closed.script.transport));

  const afterClose = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: closed.rowId },
    closed.fixture.options(closed.script.transport),
  );

  expectEqual(afterClose.status, "refused", "a disconnected connection cannot be verified");
  expectEqual(
    afterClose.status === "refused" ? afterClose.reason : "",
    "this connection was disconnected; connect the account again before verifying it",
    "the refusal says what to do instead",
  );
  expectEqual(closed.script.calls.length, 1, "the refused verify made no further call");

  // An unopenable box is a failure with a sentence, not a crash.
  const broken = fixtureOf();
  const brokenScript = transportAnswering({ status: 200, body: "{}" });
  const brokenRow = await broken.store.insert({
    ...newRow(),
    apiKeyBox: sealer.seal(API_KEY, taxCloudApiKeyScope(OTHER_COMPANY)),
  });
  const brokenAnswer = await verifyTaxCloudConnection(
    { actor: ownerActor(), connectionRowId: brokenRow.id },
    broken.options(brokenScript.transport),
  );

  expectEqual(taxCloudErrorSentenceOf(401, "{}").includes("X-API-KEY"), true, "the sentence builder names the header");
  expectEqual(taxCloudErrorSentenceOf(404, "").includes("connection ID"), true, "the sentence builder names the connection id");
  expectEqual(taxCloudErrorSentenceOf(503, "not json").includes("could not be reached"), true, "a garbage body still reads as unreached");
  expectEqual(
    taxCloudErrorSentenceOf(500, JSON.stringify({ detail: "x".repeat(400) })).length <= TAXCLOUD_LAST_ERROR_MAXIMUM_LENGTH,
    true,
    "a long detail is cut to the column",
  );
  expectEqual(
    /[\u0000-\u001f]/u.test(taxCloudErrorSentenceOf(500, JSON.stringify({ detail: "a\nb\tc" }))) ,
    false,
    "a control character never reaches the column",
  );

  expectEqual(brokenAnswer.status, "failed", "a box sealed for another company cannot be opened");
  expectEqual(brokenScript.calls.length, 0, "an unopenable box makes no call");
}

function taxCloudPingMessageOfForGate(outcome: "verified"): string {
  return outcome === "verified" ? "TaxCloud accepted the API key for this connection." : "";
}

/* ---- section 10: disconnecting ---- */

async function checkDisconnect(): Promise<void> {
  const { fixture, script, rowId } = await connectedFixture();

  await verifyTaxCloudConnection({ actor: ownerActor(), connectionRowId: rowId }, fixture.options(script.transport));

  const before = await mustRow(fixture.store, rowId);
  const switchedOn = await fixture.store.save(
    { ...before, collectionEnabled: true, version: before.version + 1, updatedAtEpochMs: NOW },
    before.version,
  );

  expectEqual(switchedOn, true, "the fixture could turn the switch on");
  expectEqual(taxCloudSettingsViewOf(await fixture.store.listByCompany(COMPANY)).canCollect, true, "the panel says it can collect");

  const closed = await disconnectTaxCloudConnection({ actor: ownerActor(), connectionRowId: rowId }, fixture.options(script.transport));
  const row = await mustRow(fixture.store, rowId);

  expectEqual(closed.status, "disconnected", "a disconnect answers disconnected");
  expectEqual(row.status, "disabled", "the row is disabled");
  expectEqual(row.verifiedAtEpochMs, null, "the verification instant clears, as the table's check requires");
  expectEqual(row.collectionEnabled, false, "the switch turns off with the row");
  expectEqual(row.lastError, null, "a deliberate disconnect is not an error");
  expectEqual(row.version, 4, "the write moved the version once");
  expectEqual(fixture.audit.entries.at(-1)?.action, "taxcloud.connection_disconnected", "the disconnect is audited");
  expectEqual(fixture.audit.entries.at(-1)?.payload["status_after"], "disabled", "the entry records the new status");

  const auditCount = fixture.audit.entries.length;
  const again = await disconnectTaxCloudConnection({ actor: ownerActor(), connectionRowId: rowId }, fixture.options(script.transport));

  expectEqual(again.status, "unchanged", "a second disconnect changes nothing");
  expectEqual(fixture.audit.entries.length, auditCount, "a repeated disconnect writes no second entry");
  expectEqual((await mustRow(fixture.store, rowId)).version, row.version, "a repeated disconnect writes no version");

  expectEqual(
    await errorCodeOfAsync(async () =>
      disconnectTaxCloudConnection(
        { actor: ownerActor({ companyId: OTHER_COMPANY }), connectionRowId: rowId },
        fixture.options(script.transport),
      ),
    ),
    "RESOURCE_NOT_FOUND",
    "another merchant's row cannot be disconnected",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      disconnectTaxCloudConnection(
        { actor: ownerActor({ twoFactorSatisfied: false }), connectionRowId: rowId },
        fixture.options(script.transport),
      ),
    ),
    "PERMISSION_DENIED",
    "an aal1 session cannot disconnect",
  );

  // A merchant whose only row is history may connect again, and the panel shows both.
  const replacement = await connectTaxCloudAccount(
    { actor: ownerActor(), connectionId: "3f2b6c1e-9a41-4d7b-8e55-0b7c1d2e4a60", apiKey: "eyJhbGciOiJIUzI1NiJ9.taxcloud.gate.5ae2d3f" },
    fixture.options(script.transport),
  );

  expectEqual(replacement.status, "connected", "a disconnected merchant may connect another account");

  const panel = taxCloudSettingsViewOf(await fixture.store.listByCompany(COMPANY));

  expectEqual(panel.connection?.status, "pending", "the panel shows the new connection");
  expectEqual(panel.history.length, 1, "the panel keeps one row of history");
  expectEqual(panel.history[0]?.status, "disabled", "the history row is the disabled one");
  expectEqual(panel.canCollect, false, "a pending connection collects nothing");
}

/* ---- section 11: the views ---- */

function checkViews(): void {
  const row = goodRow();
  const view = taxCloudConnectionViewOf(row);

  expectEqual(view.connectionIdHint.length, 16, "a hint is twelve stars and four characters");
  expectEqual(view.connectionIdHint.endsWith("4a6f"), true, "a hint keeps the last four characters");
  expectEqual(view.apiKeyHint, maskTaxCloudApiKey(`${"*".repeat(8)}${API_KEY}`), "a hint is the mask STEP 176 defined");
  expectEqual(taxCloudHintOf(""), "", "no mask for no value");
  expectEqual(view.statusMessage, taxCloudStatusMessageOf("pending"), "the sentence follows the status");

  for (const status of TAXCLOUD_STORED_STATUSES) {
    expect(taxCloudStatusMessageOf(status).length > 20, `the ${status} sentence is a sentence`);
  }

  expect(
    taxCloudStatusMessageOf("active") !== taxCloudStatusMessageOf("disabled"),
    "the three sentences differ",
  );
  expectEqual(JSON.stringify(view).includes(API_KEY), false, "the view holds no key");
  expectEqual(JSON.stringify(view).includes(CONNECTION_ID), false, "the view holds no connection id");
  expectEqual(JSON.stringify(view).includes(row.apiKeyBox.ciphertext), false, "the view holds no sealed value");
  expectEqual(JSON.stringify(view).includes(row.connectionIdBox.ciphertext), false, "the view holds no sealed id");

  const pending = taxCloudSettingsViewOf([row]);
  const active = taxCloudSettingsViewOf([{ ...row, status: "active", verifiedAtEpochMs: NOW }]);
  const disabled = taxCloudSettingsViewOf([{ ...row, status: "disabled" }]);
  const empty = taxCloudSettingsViewOf([]);

  expectEqual(pending.canCollect, false, "a pending connection cannot collect");
  expectEqual(pending.connection?.status, "pending", "the panel shows the pending row");
  expectEqual(active.canCollect, true, "an active connection can collect");
  expect(active.collectionMessage !== pending.collectionMessage, "the panel explains the difference");
  expectEqual(disabled.connection, null, "a disabled row is not the usable connection");
  expectEqual(disabled.history.length, 1, "a disabled row is history");
  expectEqual(disabled.canCollect, false, "history collects nothing");
  expectEqual(empty.connection, null, "a merchant with no row has no connection");
  expectEqual(empty.history.length, 0, "a merchant with no row has no history");
}

/* ---- section 12: the transport and the source ---- */

async function checkTransportAndSource(): Promise<void> {
  const base = { method: "GET", headers: { "X-API-KEY": API_KEY, Accept: "application/json" }, body: null };

  expectEqual(
    await errorCodeOfAsync(async () => taxCloudFetchTransport({ ...base, url: "https://api.taxcloud.net/1.0/TaxCloud/Ping" })),
    "not_an_app_error",
    "the real transport refuses the v1 host",
  );
  expectEqual(
    await errorCodeOfAsync(async () => taxCloudFetchTransport({ ...base, url: `${TAXCLOUD_API_BASE}/ping` })),
    "not_an_app_error",
    "the real transport refuses a path outside /tax/",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      taxCloudFetchTransport({ ...base, method: "TRACE", url: `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/ping` }),
    ),
    "not_an_app_error",
    "the real transport refuses an undocumented method",
  );
  expectEqual(
    await errorMessageOfAsync(async () =>
      taxCloudFetchTransport({
        ...base,
        url: `https://api.taxcloud.com/tax/connections/${CONNECTION_ID}/ping`,
      }),
    ),
    "the tax transport only calls the documented base and a documented path",
    "the real transport refuses a v2 host that copies the documented path",
  );
  expectEqual(
    await errorMessageOfAsync(async () =>
      taxCloudFetchTransport({
        ...base,
        headers: { "X-API-KEY": API_KEY, Authorization: "Bearer token" },
        url: `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/ping`,
      }),
    ),
    "a TaxCloud call never carries an Authorization header",
    "the real transport refuses an Authorization header by name",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      taxCloudFetchTransport({
        ...base,
        headers: { "X-API-KEY": API_KEY, "X-Forwarded-Host": "evil.example" },
        url: `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/ping`,
      }),
    ),
    "not_an_app_error",
    "the real transport refuses a header the builder does not write",
  );
  expectEqual(
    await errorCodeOfAsync(async () =>
      taxCloudFetchTransport({ ...base, headers: { Accept: "application/json" }, url: `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/ping` }),
    ),
    "not_an_app_error",
    "the real transport refuses a call with no key",
  );

  // The REST store is the platform's client, and its query names the columns and the tenant.
  const queries: string[] = [];
  const fakeRest = {
    async select<TRow>(table: string, query: string, schema: { parse: (value: unknown) => TRow }): Promise<readonly TRow[]> {
      queries.push(`${table}?${query}`);
      void schema;

      return [];
    },
    async insert(): Promise<void> {
      queries.push("insert");
    },
    async insertReturning<TRow>(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<readonly TRow[]> {
      queries.push(`${table} insert ${Object.keys(rows[0] ?? {}).join(",")}`);

      return [];
    },
    async update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      queries.push(`${table} update ${query} ${Object.keys(values).join(",")}`);
    },
    async rpc(): Promise<unknown> {
      return null;
    },
  };
  const store = createTaxCloudRestStore(fakeRest);

  await store.listByCompany(COMPANY);

  expectEqual(queries[0]?.startsWith("taxcloud_connections?select=id,company_id"), true, "a list selects the columns it uses");
  expectEqual(queries[0]?.includes(`company_id=eq.${encodeURIComponent(COMPANY)}`), true, "a list is scoped to the company");
  expectEqual(queries[0]?.includes("api_key_ciphertext"), true, "the row is read whole, sealed parts included");
  expectEqual(queries[0]?.includes("order=created_at.desc"), true, "the list is ordered and bounded by the caller");

  expectEqual(
    await errorCodeOfAsync(async () => createTaxCloudRestStore(fakeRest).listByCompany("company with space")),
    "VALIDATION_FAILED",
    "the rest store refuses a company id it cannot put in a query",
  );
  expectEqual(await createTaxCloudRestStore(fakeRest).findById("  "), null, "the rest store reads no row for an empty id");

  const saveStore = createTaxCloudRestStore(fakeRest);
  const savedRow = { ...goodRow(), status: "active" as const, verifiedAtEpochMs: NOW, version: 2, updatedAtEpochMs: NOW };

  queries.length = 0;
  expectEqual(await saveStore.save(savedRow, 1), false, "a save whose read-back does not move the version answers false");
  expectEqual(queries[0]?.includes("update id=eq."), true, "a save is guarded by the row id");
  expectEqual(queries[0]?.includes("version=eq.1"), true, "a save is guarded by the version it read");
  expectEqual(queries[0]?.includes("deleted_at=is.null"), true, "a deleted row is never written");
  expectEqual(queries[0]?.endsWith("status,collection_enabled,verified_at,last_error"), true, "a save writes four columns and no credential");
  expectEqual((queries[0] ?? "").includes("company_id"), false, "a save never moves the row to another merchant");
  expectEqual((queries[0] ?? "").includes("api_key_ciphertext"), false, "a save never rewrites a box");

  // The source: no console, no refused header, no credential, and one audit call per mutation.
  const source = readFileSync(new URL("./taxcloud-connect.ts", import.meta.url), "utf8");

  // The needles are assembled, because a gate that spells the forbidden call out would trip the structure gate itself.
  for (const method of ["log", "error", "warn", "info"]) {
    const needle = ["console", method].join(".");

    expectEqual(source.includes(needle), false, `the source never calls ${needle}`);
  }

  expectEqual(source.split('"Authorization"').length - 1, 0, "the source never writes the refused header as a literal");
  expectEqual(source.includes("TAXCLOUD_REFUSED_AUTH_HEADER"), true, "the refused header is named through its constant");
  expectEqual(source.includes("sk_live_"), false, "no live key shape appears");
  expectEqual(source.includes("sandbox"), false, "the word the documentation refuses appears nowhere");
  expectEqual(source.split("options.audit.append(").length - 1, 5, "each of the five mutations audits once");
  expectEqual(source.split("new AppError(\"CONFLICT\"").length - 1 >= 2, true, "a conflict is raised for both a race and a duplicate");

  for (const action of TAXCLOUD_CONNECT_AUDIT_ACTIONS) {
    expectEqual(source.includes(`action: "${action}"`), true, `the source records ${action}`);
  }

  const runtime = readFileSync(new URL("./taxcloud-connect-runtime.ts", import.meta.url), "utf8");

  expectEqual(runtime.includes(["console", "log"].join(".")), false, "the runtime never logs");
  expect(runtime.includes("getAuthRuntime()"), "the runtime uses the one authentication runtime");
  expect(runtime.includes("ENCRYPTION_MASTER_KEY"), "the key comes from the environment");
  expectEqual(runtime.includes("apiKey"), false, "the runtime names no credential field");
}

/* ---- running ---- */

checkConstants();
checkPermission();
checkScopes();
checkRow();
checkInsertValues();
await checkStore();
await checkConnect();
await checkVerifyRequest();
await checkVerifyOutcomes();
await checkDisconnect();
checkViews();
await checkTransportAndSource();

if (failures.length > 0) {
  process.stderr.write(
    `taxcloud connect gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `taxcloud connect gate passed: ${checks} checks (only a merchant's owner with a second factor may enter a credential, both values are sealed with the platform AES-256-GCM under a scope that names the company and the credential so a box copied between rows fails to open, the row is written pending with no verification claim and the four characters the table allows as its only mask, a second usable connection is refused before the partial unique index has to, a ping sends the stored key in X-API-KEY and nothing else, a 200 alone makes the row active and records the instant, a 401 and a 404 are two different sentences that leave the row pending, a 429 or 500 or 503 or 418 decides nothing about a credential and leaves an active connection active, a key TaxCloud refuses demotes an active connection and turns its switch off in the same write, a disconnect keeps the row as history with no verification claim, every mutation writes exactly one audit entry that holds two masks and no credential, and the transport refuses a foreign host, a foreign path, a foreign method, the refused Authorization header and any header the request builder does not write)\n`,
);
