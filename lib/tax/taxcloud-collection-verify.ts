// path: lib/tax/taxcloud-collection-verify.ts

/**
 * The gate for the per-merchant sales tax collection switch.
 *
 * Run directly, because the TaxCloud block owns `lib/tax/` and not `package.json`:
 *
 *   node lib/tax/taxcloud-collection-verify.ts
 *
 * Twelve sections: the constants, the permission, the country scope, the readiness, the sentences, the
 * panel, turning it on, refusing to turn it on, the writes that change nothing, turning it off, the
 * tenancy and the race, the decision STEP 179 must use, and the source.
 *
 * The rows are built through STEP 177's own store with the real cipher and a fixture master key, so a
 * fixture cannot describe a row the database would refuse: an `active` row here has a verification
 * instant because the store's invariant demands one, and a switched-on row is `active` because the
 * table's check demands that.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../errors/app-error.ts";
import { createInMemoryAuditTrail } from "../auth/audit.ts";
import type { AuditEntry, InMemoryAuditTrail } from "../auth/audit.ts";
import { openSecret, sealSecret } from "../auth/secrets.ts";
import type { SecretBox } from "../auth/secrets.ts";
import type { RequestActor } from "../auth/types.ts";
import { COUNTRY_CODE_PATTERN } from "../countries/registry.ts";
import { maskTaxCloudApiKey, TAXCLOUD_PROVIDER_KEY } from "./taxcloud.ts";
import {
  InMemoryTaxCloudConnectionStore,
  TAXCLOUD_CONNECT_ROLES,
  taxCloudApiKeyScope,
  taxCloudConnectionIdScope,
} from "./taxcloud-connect.ts";
import type {
  TaxCloudConnectionRow,
  TaxCloudConnectionStore,
  TaxCloudSecretSealer,
} from "./taxcloud-connect.ts";
import {
  TAXCLOUD_COLLECTION_AUDIT_ACTIONS,
  TAXCLOUD_COLLECTION_COUNTRIES,
  TAXCLOUD_COLLECTION_DECISIONS,
  TAXCLOUD_COLLECTION_READINESS,
  TAXCLOUD_COLLECTION_STATUSES,
  isTaxCloudCollectableCountry,
  setSalesTaxCollection,
  taxCloudCollectionDecisionMessageOf,
  taxCloudCollectionGateOf,
  taxCloudCollectionMessageOf,
  taxCloudCollectionReadinessOf,
  taxCloudCollectionStateOf,
  taxCloudUsableRowOf,
} from "./taxcloud-collection.ts";
import type {
  TaxCloudCollectionOptions,
  TaxCloudCollectionState,
} from "./taxcloud-collection.ts";

/* ---- the checking harness, the shape STEPs 170 to 177 used ---- */

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

async function errorCodeOfAsync(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const NOW = 1_781_000_000_000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COMPANY = "company_kd_tax_collection_gate";
const OTHER_COMPANY = "company_kd_tax_collection_other";
const OWNER_ID = "user_owner_tax_col_0001";
const SESSION_ID = "session_tax_col_0001";

const CONNECTION_ID = "6d1e4a2c-3b5f-4c8a-9d07-1e2f3a4b5c6d";
const OTHER_CONNECTION_ID = "7e2f5b3d-4c60-4d9b-8e18-2f3a4b5c6d7e";
const API_KEY = "eyJhbGciOiJIUzI1NiJ9.taxcloud.collect.gate.4df3a2b";

const MASTER_KEY = Buffer.alloc(32, 13).toString("base64");

const sealer: TaxCloudSecretSealer = {
  seal: (plaintext: string, context: string) => sealSecret(MASTER_KEY, plaintext, context),
  open: (box: SecretBox, context: string) => openSecret(MASTER_KEY, box, context),
};

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
  readonly options: () => TaxCloudCollectionOptions;
}

function fixtureOf(): Fixture {
  const store = new InMemoryTaxCloudConnectionStore({ now: () => NOW });
  const audit = createInMemoryAuditTrail();

  return { store, audit, options: (): TaxCloudCollectionOptions => ({ store, audit, now: () => NOW }) };
}

function newRowOf(companyId: string, connectionId: string): Parameters<TaxCloudConnectionStore["insert"]>[0] {
  return {
    companyId,
    connectionIdLastFour: connectionId.slice(-4),
    connectionIdBox: sealer.seal(connectionId, taxCloudConnectionIdScope(companyId)),
    apiKeyLastFour: API_KEY.slice(-4),
    apiKeyBox: sealer.seal(API_KEY, taxCloudApiKeyScope(companyId)),
    encryptionKeyVersion: 1,
    status: "pending",
    collectionEnabled: false,
    verifiedAtEpochMs: null,
    lastError: null,
  };
}

interface RowSpec {
  readonly companyId?: string;
  readonly connectionId?: string;
  readonly status?: "pending" | "active" | "disabled";
  readonly collectionEnabled?: boolean;
  readonly lastError?: string | null;
  readonly deleted?: boolean;
}

/**
 * One row in one of the states the table allows.
 *
 * Built by walking the store's own transitions rather than by hand, so a fixture that claims to be
 * `active` carries an instant and a fixture that claims to collect is `active` first.
 */
async function rowOf(fixture: Fixture, spec: RowSpec = {}): Promise<TaxCloudConnectionRow> {
  const companyId = spec.companyId ?? COMPANY;
  const connectionId = spec.connectionId ?? CONNECTION_ID;
  const inserted = await fixture.store.insert(newRowOf(companyId, connectionId));
  const wanted = spec.status ?? "active";
  let current = inserted;

  if (wanted !== "pending") {
    current = await move(fixture, current, {
      status: wanted,
      verifiedAtEpochMs: wanted === "active" ? NOW - MINUTE_MS : null,
      ...(spec.lastError === undefined ? {} : { lastError: spec.lastError }),
    });
  } else if (spec.lastError !== undefined) {
    current = await move(fixture, current, { lastError: spec.lastError });
  }

  if (spec.collectionEnabled === true) {
    current = await move(fixture, current, { collectionEnabled: true });
  }

  if (spec.deleted === true) {
    current = await move(fixture, current, { deletedAtEpochMs: NOW });
  }

  return current;
}

async function move(
  fixture: Fixture,
  row: TaxCloudConnectionRow,
  patch: Partial<TaxCloudConnectionRow>,
): Promise<TaxCloudConnectionRow> {
  const next: TaxCloudConnectionRow = { ...row, ...patch, updatedAtEpochMs: NOW, version: row.version + 1 };
  const saved = await fixture.store.save(next, row.version);

  if (saved === false) throw new Error(`the fixture could not move the row to ${String(patch.status ?? "patched")}`);

  return next;
}

function stateOf(rows: readonly TaxCloudConnectionRow[]): TaxCloudCollectionState {
  return taxCloudCollectionStateOf(rows);
}

/* ---- section 1: the constants ---- */

function checkConstants(): void {
  expectEqual(TAXCLOUD_COLLECTION_COUNTRIES.join(","), "US", "collection covers the United States and nothing else");
  expectEqual(TAXCLOUD_COLLECTION_READINESS.join(","), "ready,not_connected,unverified,disconnected", "four readiness states");
  expectEqual(TAXCLOUD_COLLECTION_STATUSES.join(","), "enabled,disabled,unchanged,refused", "four answers to a switch request");
  expectEqual(TAXCLOUD_COLLECTION_DECISIONS.length, 6, "six reasons an invoice may or may not carry tax");
  expectEqual(TAXCLOUD_COLLECTION_AUDIT_ACTIONS.join(","), "taxcloud.collection_enabled,taxcloud.collection_disabled", "two actions are recorded");
  expectEqual(TAXCLOUD_CONNECT_ROLES.join(","), "owner", "the merchant's owner is the actor");
  expectEqual(COUNTRY_CODE_PATTERN.source, "^[A-Z]{2}$", "the country pattern is the platform's own");

  // The audit action names follow the platform's dotted vocabulary.
  for (const action of TAXCLOUD_COLLECTION_AUDIT_ACTIONS) {
    expect(/^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(action), `the action ${action} is dotted lower case`);
  }

  for (const readiness of TAXCLOUD_COLLECTION_READINESS) {
    expect(taxCloudCollectionMessageOf(readiness, true).length > 20, `the ${readiness} sentence is a sentence`);
  }
}

/* ---- section 2: the permission ---- */

async function checkPermission(): Promise<void> {
  const fixture = fixtureOf();

  await rowOf(fixture, {});

  expectEqual(
    (await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, fixture.options())).status,
    "enabled",
    "an owner with a second factor may switch collection on",
  );

  const aal1 = fixtureOf();

  await rowOf(aal1, {});

  expectEqual(
    await errorCodeOfAsync(async () =>
      setSalesTaxCollection({ actor: ownerActor({ twoFactorSatisfied: false }), enabled: true }, aal1.options()),
    ),
    "PERMISSION_DENIED",
    "an aal1 session may not switch collection on",
  );
  expectEqual(aal1.audit.entries.length, 0, "a refused caller writes no audit entry");
  expectEqual((await aal1.store.listByCompany(COMPANY))[0]?.collectionEnabled, false, "a refused caller writes no row");

  for (const role of ["super_admin", "ceo", "compliance_kyc", "finance_ops", "support", "blogger"] as const) {
    const fixtureRole = fixtureOf();

    await rowOf(fixtureRole, {});

    expectEqual(
      await errorCodeOfAsync(async () =>
        setSalesTaxCollection({ actor: ownerActor({ roles: [role] }), enabled: true }, fixtureRole.options()),
      ),
      "PERMISSION_DENIED",
      `a ${role} may not switch a merchant's collection on`,
    );
  }

  const noCompany = fixtureOf();

  expectEqual(
    await errorCodeOfAsync(async () =>
      setSalesTaxCollection({ actor: ownerActor({ companyId: null }), enabled: false }, noCompany.options()),
    ),
    "PERMISSION_DENIED",
    "a platform account with no company has no switch",
  );
  expectEqual(taxCloudCollectionStateOf([]).readiness, "not_connected", "a platform account reads an empty panel");

  // The refusal is STEP 177's, so the permission has one implementation.
  const refused = fixtureOf();
  const caught = await setSalesTaxCollection(
    { actor: ownerActor({ twoFactorSatisfied: false }), enabled: true },
    refused.options(),
  ).catch((error: unknown) => error);

  expectEqual(
    caught instanceof AppError ? caught.details[0]?.field : "no_field",
    "actor.twoFactorSatisfied",
    "the refusal names the second factor",
  );
}

/* ---- section 3: the country scope ---- */

function checkCountries(): void {
  for (const accepted of ["US", "us", "Us", " US ", "\tUS\n"]) {
    expectEqual(isTaxCloudCollectableCountry(accepted), true, `the country ${JSON.stringify(accepted)} is covered`);
  }

  for (const refused of ["USA", "CA", "GB", "BD", "U1", "U", "", "  ", "U$", "United States", "U S"]) {
    expectEqual(isTaxCloudCollectableCountry(refused), false, `the country ${JSON.stringify(refused)} is not covered`);
  }

  expectEqual(TAXCLOUD_COLLECTION_COUNTRIES.includes("CA"), false, "Canada is outside the scope");
  expectEqual(isTaxCloudCollectableCountry(42 as unknown as string), false, "a number is not a country");
}

/* ---- section 4: the readiness ---- */

async function checkReadiness(): Promise<void> {
  expectEqual(taxCloudCollectionReadinessOf([]), "not_connected", "no rows means nothing is connected");
  expectEqual(
    taxCloudCollectionReadinessOf([await rowOf(fixtureOf(), { status: "pending" })]),
    "unverified",
    "a pending row waits for a ping",
  );
  expectEqual(taxCloudCollectionReadinessOf([await rowOf(fixtureOf(), {})]), "ready", "an active row is ready");
  expectEqual(
    taxCloudCollectionReadinessOf([await rowOf(fixtureOf(), { status: "disabled" })]),
    "disconnected",
    "only history means the last connection was disconnected",
  );
  expectEqual(
    taxCloudCollectionReadinessOf([await rowOf(fixtureOf(), { deleted: true })]),
    "not_connected",
    "a deleted row is not a connection",
  );
  expectEqual(
    taxCloudCollectionReadinessOf([await rowOf(fixtureOf(), { status: "disabled", deleted: true })]),
    "not_connected",
    "a deleted history row is not history the panel shows",
  );

  const both = fixtureOf();
  // History first: a pending row holds the usable slot, so it goes in after the disabled one frees it.
  const disabled = await rowOf(both, { status: "disabled", connectionId: OTHER_CONNECTION_ID });
  const pending = await rowOf(both, { status: "pending" });

  expectEqual(taxCloudUsableRowOf([disabled, pending])?.id, pending.id, "the usable row is the one that is not disabled");
  expectEqual(taxCloudCollectionReadinessOf([disabled, pending]), "unverified", "a pending connection beside history is unverified");
  expectEqual(taxCloudUsableRowOf([disabled])?.id, undefined, "history alone has no usable row");
  expectEqual(taxCloudUsableRowOf([{ ...pending, deletedAtEpochMs: NOW }])?.id, undefined, "a deleted row is not usable");
}

/* ---- section 5: the sentences ---- */

function checkSentences(): void {
  const sentences = new Set<string>();

  for (const readiness of TAXCLOUD_COLLECTION_READINESS) {
    sentences.add(taxCloudCollectionMessageOf(readiness, false));
    sentences.add(taxCloudCollectionMessageOf(readiness, true));
  }

  expectEqual(sentences.size, 5, "the panel has five sentences: one per readiness and the ready pair");
  expect(
    taxCloudCollectionMessageOf("ready", true) !== taxCloudCollectionMessageOf("ready", false),
    "a verified connection reads differently switched on and off",
  );

  const decisions = new Set<string>();

  for (const reason of TAXCLOUD_COLLECTION_DECISIONS) {
    decisions.add(taxCloudCollectionDecisionMessageOf(reason));
  }

  expectEqual(decisions.size, TAXCLOUD_COLLECTION_DECISIONS.length, "each decision has its own sentence");
  expect(
    taxCloudCollectionDecisionMessageOf("outside_united_states").includes("United States"),
    "the scope sentence names the scope",
  );
  expect(
    taxCloudCollectionDecisionMessageOf("unverified").includes("verification ping"),
    "the unverified sentence names the missing proof",
  );
}

/* ---- section 6: the panel ---- */

async function checkPanel(): Promise<void> {
  const empty = stateOf([]);

  expectEqual(empty.enabled, false, "a merchant with no connection collects nothing");
  expectEqual(empty.connection, null, "a merchant with no connection has no panel row");
  expectEqual(empty.connectionRowId, null, "there is no row to name");
  expectEqual(empty.canEnable, false, "there is nothing to enable");
  expectEqual(empty.canDisable, false, "there is nothing to disable");
  expectEqual(empty.countries.join(","), "US", "the panel names the scope");

  const pending = stateOf([await rowOf(fixtureOf(), { status: "pending", lastError: "TaxCloud answered 401." })]);

  expectEqual(pending.readiness, "unverified", "a pending connection is unverified");
  expectEqual(pending.enabled, false, "a pending connection collects nothing");
  expectEqual(pending.canEnable, false, "a pending connection cannot be switched on");
  expectEqual(pending.warning, null, "a connection that is not collecting has no switch warning");
  expectEqual(pending.connection?.status, "pending", "the panel shows the masked connection");

  const ready = stateOf([await rowOf(fixtureOf(), {})]);

  expectEqual(ready.readiness, "ready", "an active connection is ready");
  expectEqual(ready.enabled, false, "an active connection starts switched off");
  expectEqual(ready.canEnable, true, "an active connection can be switched on");
  expectEqual(ready.canDisable, false, "a switched-off connection cannot be switched off again");

  const on = stateOf([await rowOf(fixtureOf(), { collectionEnabled: true, lastError: "TaxCloud could not be reached, so nothing is known about the credentials yet." })]);

  expectEqual(on.enabled, true, "a switched-on active connection reads enabled");
  expectEqual(on.canEnable, false, "an enabled connection cannot be enabled again");
  expectEqual(on.canDisable, true, "an enabled connection can be switched off");
  expect(on.warning !== null && on.warning.includes("could not be reached"), "an outage is shown beside the switch");

  expectEqual(JSON.stringify(on).includes(API_KEY), false, "the panel holds no key");
  expectEqual(JSON.stringify(on).includes(CONNECTION_ID), false, "the panel holds no connection id");
  expectEqual(on.connection?.apiKeyHint, maskTaxCloudApiKey(`${"*".repeat(8)}${API_KEY}`), "the panel shows STEP 177's mask");

  const deletedOn = await rowOf(fixtureOf(), { collectionEnabled: true, deleted: true });

  expectEqual(stateOf([deletedOn]).enabled, false, "a deleted row collects nothing even if its column was left on");
  expectEqual(taxCloudCollectionGateOf([deletedOn], "US").collect, false, "a deleted row is not a decision to collect");
  expectEqual(taxCloudCollectionGateOf([deletedOn], "US").reason, "not_connected", "a deleted row is not a connection");

  const disconnected = stateOf([await rowOf(fixtureOf(), { status: "disabled" })]);

  expectEqual(disconnected.readiness, "disconnected", "history reads disconnected");
  expectEqual(disconnected.enabled, false, "history collects nothing");
  expectEqual(disconnected.connection, null, "history is not a connection the panel shows");
}

/* ---- section 7: turning it on ---- */

async function checkEnable(): Promise<void> {
  const fixture = fixtureOf();
  const row = await rowOf(fixture, {});
  const answered = await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, fixture.options());

  expectEqual(answered.status, "enabled", "a verified connection switches on");
  expectEqual(answered.state.enabled, true, "the panel reads enabled");
  expectEqual(answered.state.connectionRowId, row.id, "the panel names the row the bit belongs to");
  expectEqual(answered.state.readiness, "ready", "the readiness is unchanged by the switch");

  const stored = (await fixture.store.listByCompany(COMPANY))[0] as TaxCloudConnectionRow;

  expectEqual(stored.collectionEnabled, true, "the column is on");
  expectEqual(stored.version, row.version + 1, "the write moved the version once");
  expectEqual(stored.status, "active", "the switch does not change the status");
  expect(stored.verifiedAtEpochMs !== null, "the switch keeps the verification instant");

  expectEqual(fixture.audit.entries.length, 1, "switching on writes one audit entry");
  const entry = fixture.audit.entries[0] as AuditEntry;

  expectEqual(entry.action, "taxcloud.collection_enabled", "the entry names the action");
  expectEqual(entry.entityType, "tax_connection", "the entry names the entity type");
  expectEqual(entry.entityId, row.id, "the entry names the row");
  expectEqual(entry.companyId, COMPANY, "the entry belongs to the company");
  expectEqual(entry.actorUserId, OWNER_ID, "the entry names the actor");
  expectEqual(entry.payload["provider_key"], TAXCLOUD_PROVIDER_KEY, "the entry names the provider");
  expectEqual(entry.payload["connection_id_last_four"], CONNECTION_ID.slice(-4), "the entry holds the id mask and nothing else");
  expectEqual(entry.payload["api_key_last_four"], API_KEY.slice(-4), "the entry holds the key mask and nothing else");
  expectEqual(entry.payload["collection_enabled"], true, "the entry records the bit");
  expectEqual(entry.payload["status_before"], "active", "the entry records the status it found");
  expectEqual(entry.payload["status_after"], "active", "the switch changes no status");
  expectEqual(stored.updatedAtEpochMs, NOW, "the write is stamped by the clock the caller owns");
  expectEqual(stored.lastError, null, "the switch writes no error sentence");

  // Everything the switch does not own is byte for byte what it was.
  const untouched = Object.keys(stored).filter((key) => ["collectionEnabled", "version", "updatedAtEpochMs"].includes(key) === false);

  for (const key of untouched) {
    expectEqual(
      JSON.stringify(stored[key as keyof TaxCloudConnectionRow]) === JSON.stringify(row[key as keyof TaxCloudConnectionRow]),
      true,
      `the switch leaves ${key} alone`,
    );
  }

  // A connection that is verified but whose last ping failed still switches on: an outage is not a verdict.
  const outage = fixtureOf();

  await rowOf(outage, { lastError: "TaxCloud could not be reached, so nothing is known about the credentials yet." });

  const afterOutage = await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, outage.options());

  expectEqual(afterOutage.status, "enabled", "a stale outage sentence does not block a verified connection");
  expectEqual(typeof afterOutage.state.warning, "string", "the panel carries the outage as a sentence");
  expect(afterOutage.state.warning !== null, "the outage is shown while the connection collects");
  expectEqual(JSON.stringify(entry.payload).includes(API_KEY), false, "the entry holds no key");
  expectEqual(JSON.stringify(entry.payload).includes(CONNECTION_ID), false, "the entry holds no connection id");
}

/* ---- section 8: refusing to turn it on ---- */

async function checkEnableRefusals(): Promise<void> {
  const none = fixtureOf();
  const noConnection = await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, none.options());

  expectEqual(noConnection.status, "refused", "no connection is a refusal");
  expectEqual(
    noConnection.status === "refused" ? noConnection.reason : "",
    "no TaxCloud account is connected for this merchant, so there is nothing to collect through",
    "the refusal says what is missing",
  );
  expectEqual(none.audit.entries.length, 0, "a refusal audits nothing");

  const pendingFixture = fixtureOf();

  await rowOf(pendingFixture, { status: "pending" });

  const pending = await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, pendingFixture.options());

  expectEqual(pending.status, "refused", "an unverified connection is a refusal");
  expectEqual(
    pending.status === "refused" ? pending.reason : "",
    "the connection has not answered a verification ping, so collection cannot be turned on",
    "the refusal names the missing ping",
  );
  expectEqual((await pendingFixture.store.listByCompany(COMPANY))[0]?.collectionEnabled, false, "nothing was switched on");
  expectEqual(pendingFixture.audit.entries.length, 0, "the unverified refusal audits nothing");

  const historyFixture = fixtureOf();

  await rowOf(historyFixture, { status: "disabled" });

  const history = await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, historyFixture.options());

  expectEqual(history.status, "refused", "history is a refusal");
  expectEqual(
    history.status === "refused" ? history.reason : "",
    "no TaxCloud account is connected for this merchant, so there is nothing to collect through",
    "a disconnected merchant is told there is no account",
  );
}

/* ---- section 9: the writes that change nothing ---- */

async function checkNoOp(): Promise<void> {
  const on = fixtureOf();
  const row = await rowOf(on, {});

  await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, on.options());

  const versionAfterFirst = ((await on.store.listByCompany(COMPANY))[0] as TaxCloudConnectionRow).version;
  const repeat = await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, on.options());

  expectEqual(repeat.status, "unchanged", "enabling an enabled switch changes nothing");
  expectEqual((await on.store.listByCompany(COMPANY))[0]?.version, versionAfterFirst, "a repeated click writes no version");
  expectEqual(on.audit.entries.length, 1, "a repeated click writes no second entry");
  expectEqual(repeat.state.connectionRowId, row.id, "the panel still names the row");

  const off = fixtureOf();

  await rowOf(off, {});
  const alreadyOff = await setSalesTaxCollection({ actor: ownerActor(), enabled: false }, off.options());

  expectEqual(alreadyOff.status, "unchanged", "disabling a switched-off switch changes nothing");
  expectEqual(off.audit.entries.length, 0, "a switch that was already off writes no entry");

  const emptyOff = fixtureOf();
  const nothingToDo = await setSalesTaxCollection({ actor: ownerActor(), enabled: false }, emptyOff.options());

  expectEqual(nothingToDo.status, "unchanged", "a merchant with no connection has nothing to switch off");
  expectEqual(nothingToDo.state.enabled, false, "and the panel says so");
}

/* ---- section 10: turning it off ---- */

async function checkDisable(): Promise<void> {
  const fixture = fixtureOf();
  const row = await rowOf(fixture, { collectionEnabled: true });
  const answered = await setSalesTaxCollection({ actor: ownerActor(), enabled: false }, fixture.options());

  expectEqual(answered.status, "disabled", "a switched-on connection switches off");
  expectEqual(answered.state.enabled, false, "the panel reads disabled");
  expectEqual(answered.state.readiness, "ready", "switching off does not unverify the connection");
  expectEqual(answered.state.canEnable, true, "a verified connection can be switched back on");

  const stored = (await fixture.store.listByCompany(COMPANY))[0] as TaxCloudConnectionRow;

  expectEqual(stored.collectionEnabled, false, "the column is off");
  expectEqual(stored.version, row.version + 1, "the write moved the version once");
  expectEqual(stored.status, "active", "the connection stays verified");
  expect(fixture.audit.entries.at(-1)?.action === "taxcloud.collection_disabled", "the switch off is audited");
  expectEqual(fixture.audit.entries.at(-1)?.payload["collection_enabled"], false, "the entry records the bit");
  expectEqual(fixture.audit.entries.at(-1)?.payload["status_before"], "active", "the entry records the status");
  expectEqual(fixture.audit.entries.at(-1)?.payload["connection_id_last_four"], CONNECTION_ID.slice(-4), "the off entry holds the id mask");
  expectEqual(fixture.audit.entries.at(-1)?.payload["status_after"], "active", "switching off changes no status");
  expectEqual(answered.state.warning, null, "a switched-off connection shows no switch warning");
  expectEqual(stored.lastError, null, "a switch does not write an error sentence");

  // A merchant whose connection is unverified can still switch off: the bit cannot be on, so the answer is unchanged.
  const unverified = fixtureOf();

  await rowOf(unverified, { status: "pending" });

  expectEqual(
    (await setSalesTaxCollection({ actor: ownerActor(), enabled: false }, unverified.options())).status,
    "unchanged",
    "an unverified connection has nothing to switch off",
  );
}

/* ---- section 11: tenancy, the race, and the table's own rule ---- */

async function checkTenancyAndRace(): Promise<void> {
  const shared = fixtureOf();
  const mine = await rowOf(shared, {});
  const theirs = await rowOf(shared, { companyId: OTHER_COMPANY, connectionId: OTHER_CONNECTION_ID, status: "pending" });

  await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, shared.options());

  const afterMine = await shared.store.listByCompany(COMPANY);
  const afterTheirs = await shared.store.listByCompany(OTHER_COMPANY);

  expectEqual(afterMine[0]?.collectionEnabled, true, "my switch is on");
  expectEqual(afterTheirs[0]?.collectionEnabled, false, "the other merchant's switch is untouched");
  expectEqual(afterTheirs[0]?.version, theirs.version, "the other merchant's row was not written");
  expect(afterMine[0]?.id !== afterTheirs[0]?.id, "the two merchants hold different rows");

  // An owner of another company acting on their own company sees only their own rows.
  const otherOwner = ownerActor({ companyId: OTHER_COMPANY, userId: "user_owner_tax_col_0002" });
  const theirsRefused = await setSalesTaxCollection({ actor: otherOwner, enabled: true }, shared.options());

  expectEqual(theirsRefused.status, "refused", "the other merchant has an unverified connection and cannot switch on");
  expectEqual((await shared.store.listByCompany(OTHER_COMPANY))[0]?.collectionEnabled, false, "their row is still off");
  expectEqual((await shared.store.listByCompany(COMPANY))[0]?.id, mine.id, "my row is still mine");

  // Two merchants can each collect: the switch is per merchant, not per platform.
  const bothFixture = fixtureOf();

  await rowOf(bothFixture, {});
  await rowOf(bothFixture, { companyId: OTHER_COMPANY, connectionId: OTHER_CONNECTION_ID });

  await setSalesTaxCollection({ actor: ownerActor(), enabled: true }, bothFixture.options());
  await setSalesTaxCollection(
    { actor: ownerActor({ companyId: OTHER_COMPANY, userId: "user_owner_tax_col_0002" }), enabled: true },
    bothFixture.options(),
  );

  expectEqual((await bothFixture.store.listByCompany(COMPANY))[0]?.collectionEnabled, true, "the first merchant collects");
  expectEqual((await bothFixture.store.listByCompany(OTHER_COMPANY))[0]?.collectionEnabled, true, "the second merchant collects");
  expectEqual(bothFixture.audit.entries.length, 2, "two merchants write two entries");

  // A lost version race is a conflict rather than a silent overwrite.
  const race = fixtureOf();

  await rowOf(race, {});

  const racing: TaxCloudConnectionStore = {
    listByCompany: async (companyId: string) => {
      const rows = await race.store.listByCompany(companyId);

      return rows.map((row) => ({ ...row, version: row.version + 4 }));
    },
    findById: (id: string) => race.store.findById(id),
    insert: (row: Parameters<TaxCloudConnectionStore["insert"]>[0]) => race.store.insert(row),
    save: (next: TaxCloudConnectionRow, expectedVersion: number) => race.store.save(next, expectedVersion),
  };

  expectEqual(
    await errorCodeOfAsync(async () =>
      setSalesTaxCollection({ actor: ownerActor(), enabled: true }, { store: racing, audit: race.audit, now: () => NOW }),
    ),
    "CONFLICT",
    "a stale read is a conflict, not an overwrite",
  );
  expectEqual(race.audit.entries.length, 0, "a conflict audits nothing");

  // The table's own rule: a pending row cannot collect, whatever a caller asks the store to write.
  const invariant = fixtureOf();
  const pendingRow = await rowOf(invariant, { status: "pending" });

  expectEqual(
    await invariant.store.save({ ...pendingRow, collectionEnabled: true, version: pendingRow.version + 1 }, pendingRow.version),
    false,
    "the store refuses a switch on an unverified connection",
  );
  let accepted = true;

  try {
    await invariant.store.insert({ ...newRowOf(COMPANY, CONNECTION_ID), collectionEnabled: true });
  } catch {
    accepted = false;
  }

  expectEqual(accepted, false, "an insert cannot store a switched-on row that was never verified");
}

/* ---- section 12: the decision STEP 179 must use ---- */

async function checkDecision(): Promise<void> {
  const collecting = [await rowOf(fixtureOf(), { collectionEnabled: true })];
  const verifiedOff = [await rowOf(fixtureOf(), {})];
  const pending = [await rowOf(fixtureOf(), { status: "pending" })];
  const history = [await rowOf(fixtureOf(), { status: "disabled" })];

  const collect = taxCloudCollectionGateOf(collecting, "US");

  expectEqual(collect.collect, true, "a switched-on verified connection collects in the United States");
  expectEqual(collect.reason, "collect", "the reason is collect");
  expectEqual(collect.message, taxCloudCollectionDecisionMessageOf("collect"), "the sentence is the panel's");

  expectEqual(taxCloudCollectionGateOf(collecting, "us").collect, true, "a lower case country is the same country");
  expectEqual(taxCloudCollectionGateOf(collecting, "CA").collect, false, "Canada does not collect");
  expectEqual(taxCloudCollectionGateOf(collecting, "CA").reason, "outside_united_states", "the reason names the scope");
  expectEqual(taxCloudCollectionGateOf(collecting, "").reason, "outside_united_states", "an empty country is outside");
  expectEqual(taxCloudCollectionGateOf(collecting, "USA").reason, "outside_united_states", "a three letter code is outside");

  expectEqual(taxCloudCollectionGateOf(verifiedOff, "US").reason, "switched_off", "a verified connection that is off collects nothing");
  expectEqual(taxCloudCollectionGateOf(pending, "US").reason, "unverified", "an unverified connection collects nothing");
  expectEqual(taxCloudCollectionGateOf(pending, "CA").reason, "unverified", "the missing proof is named before the country");
  expectEqual(taxCloudCollectionGateOf(history, "US").reason, "disconnected", "history collects nothing");
  expectEqual(taxCloudCollectionGateOf([], "US").reason, "not_connected", "no connection collects nothing");
  expectEqual(taxCloudCollectionGateOf([], "CA").reason, "not_connected", "no connection is named before the country");

  for (const rows of [collecting, verifiedOff, pending, history, []]) {
    const decision = taxCloudCollectionGateOf(rows, "US");

    expectEqual(decision.collect, decision.reason === "collect", "the boolean and the reason agree");
    expect(decision.message.length > 20, "every decision has a sentence");
  }
}

/* ---- section 13: the source ---- */

function checkSource(): void {
  const source = readFileSync(new URL("./taxcloud-collection.ts", import.meta.url), "utf8");

  // The needles are assembled, because a gate that spells the forbidden call out would trip the structure gate itself.
  for (const method of ["log", "error", "warn", "info"]) {
    expectEqual(source.includes(["console", method].join(".")), false, `the source never calls console.${method}`);
  }

  expectEqual(source.includes("taxCloudFetchTransport"), false, "the switch makes no call of its own");
  expectEqual(source.includes("transport"), false, "the switch has no transport to make a call with");
  expectEqual(source.includes("sealer"), false, "the switch never opens or seals a credential");
  expectEqual(source.includes("sandbox"), false, "the word the documentation refuses appears nowhere");
  expectEqual(source.includes("Authorization"), false, "the switch builds no header");
  expectEqual(source.includes("sk_live_"), false, "no live key shape appears");
  expectEqual(source.split("options.audit.append(").length - 1, 2, "each of the two mutations audits once");
  expectEqual(source.includes('new AppError("CONFLICT"'), true, "a lost race is a conflict");
  expectEqual(source.includes("requireTaxCloudConnectActor("), true, "the permission is STEP 177's, not a second copy");
  expectEqual(source.includes("requireCompanyId(actor)"), true, "the company comes from the session");
  expectEqual(source.includes("taxCloudRowProblemOf("), true, "a write is checked against the table's invariants");

  for (const action of TAXCLOUD_COLLECTION_AUDIT_ACTIONS) {
    expectEqual(source.includes(`action: "${action}"`), true, `the source records ${action}`);
  }

  // STEP 179 must reach the decision through the gate, so the gate is the only exported reader of the three conditions.
  expectEqual(source.includes("export function taxCloudCollectionGateOf"), true, "the decision function is exported");
  expectEqual(source.includes("export function isTaxCloudCollectableCountry"), true, "the country reader is exported");
}

/* ---- running ---- */

checkConstants();
await checkPermission();
checkCountries();
await checkReadiness();
checkSentences();
await checkPanel();
await checkEnable();
await checkEnableRefusals();
await checkNoOp();
await checkDisable();
await checkTenancyAndRace();
await checkDecision();
checkSource();

if (failures.length > 0) {
  process.stderr.write(
    `taxcloud collection gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `taxcloud collection gate passed: ${checks} checks (only a merchant's owner with a second factor may flip the switch, collection can only be turned on for a connection that answered a verification ping while turning it off needs no proof at all, a switch that is already in the state asked for writes nothing and audits nothing, every flip is version guarded and a lost race is a conflict, each flip writes one audit entry that carries two masks and no credential, the switch belongs to one merchant's row and cannot reach another merchant's, the store and the table both refuse a switched-on row that is not active, and the one decision a later STEP may use names the country scope and answers no for a merchant with no connection, an unverified connection, a disconnected connection, a switched-off connection and a transaction outside the United States)\\n`,
);
