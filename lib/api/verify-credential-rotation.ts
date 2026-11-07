// path: lib/api/verify-credential-rotation.ts
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../auth/audit.ts";
import type { InMemoryAuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { sealSecret } from "../auth/secrets.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { en } from "../i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import {
  CREDENTIAL_AUDIT,
  CREDENTIAL_LABEL_MAXIMUM_LENGTH,
  CREDENTIAL_REASON_MAXIMUM_LENGTH,
  CREDENTIAL_ROTATED_REASON,
  CREDENTIAL_RULES,
  MERCHANT_API_CREDENTIALS_TABLE,
  supersededLabelOf,
} from "./credential-fields.ts";
import {
  createMerchantCredential,
  parseRevokeBody,
  readMerchantCredentials,
  regenerateCredential,
  revokeCredential,
  type CredentialDependencies,
} from "./credentials.ts";

/**
 * The gate for STEP 201: section 20's revocation and regeneration.
 *
 * ## What this proves
 *
 *   - **Revocation is one-way and provable.** `active` becomes `revoked` with a sentence and an instant, the key
 *     material is untouched, the update is guarded by the version that was read, and the proof of the write is a
 *     read-back - so a lost update answers `credential_write_not_applied` instead of telling a merchant their key
 *     is dead while it still works.
 *   - **Rotation is three writes in the safe order.** The predecessor is renamed (frees the label), the successor
 *     is inserted under the original name, the predecessor is revoked - and the gate walks the two failure modes:
 *     an insert that fails puts the name back and leaves one live credential, a retirement that fails leaves two
 *     live keys and says `rotation_incomplete` rather than pretending.
 *   - **A rotated credential is a new credential.** Different key, different hash, different seal - and the
 *     predecessor's four frozen columns are exactly what they were, so a rotation cannot silently re-key history.
 *   - **No key anywhere, again.** The gate supplies the randomness, so it knows both keys and searches two views,
 *     every column and two audit payloads for them.
 *   - **Only an owner, only its own company.** Another merchant's id is a plain not-found, not a 403 that confirms
 *     the row exists.
 *
 * ## How
 *
 * An in-memory PostgREST carrying `0034`'s checks, its guard and its three unique indexes, with two switches the
 * failure paths need: `failUpdatesFrom` loses an update the way a PostgREST update that matches no row does, and
 * `failInsert` refuses the successor.
 */

let checkCount = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(Object.is(actual, expected), `${description} (expected ${String(expected)}, got ${String(actual)})`);
}

async function expectRefusal(run: () => Promise<unknown>, code: string, description: string): Promise<void> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
  } catch (error) {
    if (!isAppError(error)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return;
    }

    expectEqual(error.code, code, description);
  }
}

async function refusalRuleOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    if (!isAppError(error)) {
      return "not-an-app-error";
    }

    return error.details[0]?.rule ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const nowMs = Date.parse("2026-11-07T09:00:00.000Z");
const masterKey = Buffer.alloc(32, 9).toString("base64");

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"] as readonly PlatformRole[],
    sessionId: "session-0001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: nowMs - 60_000,
    expiresAtEpochMs: nowMs + 86_400_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

interface Fixture {
  readonly rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly rows: Row[];
  readonly issued: string[];
  /** Let this many updates land, then lose every later one - a guarded update that matched no row. */
  failUpdatesFrom: number | null;
  /** Refuse the next insert, which is how the successor's failure path is walked. */
  failInsert: boolean;
  /** Move every row's version on before the next update, the way a concurrent writer would. */
  interfereOnce: boolean;
  updates: number;
  nowMs: number;
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly notNulls: Set<string>;
  readonly order: readonly { readonly column: string; readonly direction: "asc" | "desc" }[];
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  const notNulls = new Set<string>();
  const order: { column: string; direction: "asc" | "desc" }[] = [];
  let limit: number | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select") {
      continue;
    }

    if (key === "order") {
      for (const term of value.split(",")) {
        const [column = "", direction = "asc"] = term.split(".");

        order.push({ column, direction: direction === "desc" ? "desc" : "asc" });
      }

      continue;
    }

    if (key === "limit") {
      limit = Number.parseInt(value, 10);
      continue;
    }

    if (value === "is.null") {
      nulls.add(key);
      continue;
    }

    if (value === "not.is.null") {
      notNulls.add(key);
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls, notNulls, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const column of query.nulls) {
    if (row[column] !== null && row[column] !== undefined) {
      return false;
    }
  }

  for (const column of query.notNulls) {
    if (row[column] === null || row[column] === undefined) {
      return false;
    }
  }

  return true;
}

function sortRows(rows: readonly Row[], order: Query["order"]): Row[] {
  if (order.length === 0) {
    return [...rows];
  }

  return [...rows].sort((left, right) => {
    for (const term of order) {
      const comparison = String(left[term.column] ?? "").localeCompare(String(right[term.column] ?? ""));

      if (comparison !== 0) {
        return term.direction === "desc" ? -comparison : comparison;
      }
    }

    return 0;
  });
}

function validation(field: string, rule: string): never {
  throw new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

function conflict(field: string, rule: string): never {
  throw new AppError("CONFLICT", { details: [{ field, rule }] });
}

/** `0034`'s checks, its guard and its three unique indexes, entered row by row. */
function guardRow(fixture: Fixture, row: Row, mode: "insert" | "update", previous: Row | null): void {
  const label = String(row["label"] ?? "");

  if (label.length < 1 || label.length > 80 || label !== label.trim()) {
    validation("label", "merchant_api_credentials_label_check");
  }

  if (!/^[a-z][a-z0-9_]{1,15}$/u.test(String(row["key_prefix"] ?? ""))) {
    validation("key_prefix", "merchant_api_credentials_prefix_check");
  }

  if (!/^[A-Za-z0-9]{4}$/u.test(String(row["key_last_four"] ?? ""))) {
    validation("key_last_four", "merchant_api_credentials_last_four_check");
  }

  if (!/^[0-9a-f]{64}$/u.test(String(row["key_hash"] ?? ""))) {
    validation("key_hash", "merchant_api_credentials_hash_check");
  }

  if (!/^[A-Za-z0-9]{4}$/u.test(String(row["signing_secret_last_four"] ?? ""))) {
    validation("signing_secret_last_four", "merchant_api_credentials_secret_last_four_check");
  }

  if (!["active", "revoked"].includes(String(row["status"]))) {
    validation("status", "merchant_api_credentials_status_check");
  }

  if ((row["status"] === "revoked") !== (row["revoked_at"] !== null && row["revoked_at"] !== undefined)) {
    validation("revoked_at", "merchant_api_credentials_revoked_check");
  }

  if (row["status"] === "revoked") {
    const reason = String(row["revoke_reason"] ?? "");

    if (reason.length < 1 || reason.length > CREDENTIAL_REASON_MAXIMUM_LENGTH || reason !== reason.trim()) {
      validation("revoke_reason", "merchant_api_credentials_reason_check");
    }
  } else if (row["revoke_reason"] !== null && row["revoke_reason"] !== undefined) {
    validation("revoke_reason", "merchant_api_credentials_reason_check");
  }

  if (mode === "update" && previous !== null) {
    for (const column of ["company_id", "mode", "key_prefix", "key_last_four", "key_hash", "signing_secret_last_four"]) {
      if (row[column] !== previous[column]) {
        validation(column, "merchant_api_credentials_guard_secret");
      }
    }

    if (previous["status"] === "revoked" && row["status"] !== "revoked") {
      validation("status", "merchant_api_credentials_guard_secret");
    }
  }

  const duplicateHash = fixture.rows.some(
    (candidate) => candidate["key_hash"] === row["key_hash"] && candidate["id"] !== row["id"],
  );

  if (duplicateHash) {
    conflict("key_hash", "merchant_api_credentials_hash_key");
  }

  const duplicateLabel = fixture.rows.some(
    (candidate) =>
      candidate["id"] !== row["id"] &&
      candidate["company_id"] === row["company_id"] &&
      String(candidate["label"]).toLowerCase() === label.toLowerCase() &&
      candidate["deleted_at"] === null,
  );

  if (duplicateLabel) {
    conflict("label", "merchant_api_credentials_label_key");
  }

  if (row["rotated_from_id"] !== null && row["rotated_from_id"] !== undefined) {
    const duplicateRotation = fixture.rows.some(
      (candidate) => candidate["id"] !== row["id"] && candidate["rotated_from_id"] === row["rotated_from_id"],
    );

    if (duplicateRotation) {
      conflict("rotated_from_id", "merchant_api_credentials_rotation_key");
    }
  }
}

function createFixture(): Fixture {
  const rows: Row[] = [];
  const issued: string[] = [];
  const audit = createInMemoryAuditTrail();
  let counter = 0;
  const state: Partial<Fixture> = {};

  /**
   * `0034` has no `set_row_metadata` trigger on insert, but it does on update: every landed update bumps the
   * version and the timestamp, which is what makes the guard in `updateCredential` meaningful.
   */
  const bump = (row: Row): void => {
    row["version"] = Number(row["version"] ?? 1) + 1;
    row["updated_at"] = new Date(nowMs).toISOString();
  };

  const rest: RestClient = {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      if (table !== MERCHANT_API_CREDENTIALS_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const parsed = parseQuery(query);
      let selected = rows.filter((row) => matches(row, parsed));

      selected = sortRows(selected, parsed.order);

      if (parsed.limit !== null) {
        selected = selected.slice(0, parsed.limit);
      }

      return schema.array().parse(selected.map((row) => ({ ...row })));
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "insert_without_representation" } });
    },

    async insertReturning<TRow>(table: string, inserted: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      if (table !== MERCHANT_API_CREDENTIALS_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      if ((state as Fixture).failInsert) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "insert_refused" } });
      }

      const written: Row[] = [];

      for (const row of inserted) {
        counter += 1;
        const next: Row = {
          id: `e0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
          created_at: new Date(nowMs + counter * 1_000).toISOString(),
          updated_at: new Date(nowMs + counter * 1_000).toISOString(),
          deleted_at: null,
          version: 1,
          ...row,
        };

        guardRow(state as Fixture, next, "insert", null);
        rows.push(next);
        written.push(next);
      }

      return schema.array().parse(written.map((row) => ({ ...row })));
    },

    async update(table: string, query: string, values: Row): Promise<void> {
      if (table !== MERCHANT_API_CREDENTIALS_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const fixture = state as Fixture;
      const parsed = parseQuery(query);

      fixture.updates += 1;

      if (fixture.interfereOnce) {
        // Somebody else wrote the row between the read and this update, so a query carrying the old version
        // matches nothing at all - and an update that matches nothing answers success, which is the whole
        // reason the service reads the row back afterwards.
        fixture.interfereOnce = false;

        for (const row of rows) {
          row["version"] = Number(row["version"] ?? 1) + 1;
        }
      }

      // A PostgREST update that matched no row answers success. The guard is what makes it impossible to tell
      // from the response, and the read-back in the service is what makes it visible.
      if (fixture.failUpdatesFrom !== null && fixture.updates >= fixture.failUpdatesFrom) {
        return;
      }

      for (const row of rows) {
        if (!matches(row, parsed)) {
          continue;
        }

        const previous = { ...row };
        const next = { ...row, ...values };

        guardRow(fixture, next, "update", previous);
        Object.assign(row, values);
        bump(row);
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "no_rpc" } });
    },
  };

  Object.assign(state, {
    rest,
    audit,
    rows,
    issued,
    failUpdatesFrom: null,
    failInsert: false,
    interfereOnce: false,
    updates: 0,
    nowMs,
  });

  return state as Fixture;
}

function dependenciesOf(fixture: Fixture): CredentialDependencies {
  let drawn = 0;

  return {
    rest: fixture.rest,
    audit: fixture.audit,
    now: (): number => fixture.nowMs,
    seal: (plaintext: string, context: string) => sealSecret(masterKey, plaintext, context),
    randomHex: (): string => {
      drawn += 1;

      const value = createHash("sha256").update(`rotation-fixture:${String(drawn)}`, "utf8").digest("hex");

      fixture.issued.push(value);

      return value;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

const root = new URL("../../", import.meta.url).pathname;

async function sourceOf(path: string): Promise<string> {
  return readFile(`${root}${path}`, "utf8");
}

function expectSourceContains(source: string, needle: string, description: string): void {
  expect(source.includes(needle), `${description} (missing ${JSON.stringify(needle.slice(0, 80))})`);
}

function expectSourceLacks(source: string, needle: string, description: string): void {
  expect(!source.includes(needle), `${description} (found ${JSON.stringify(needle.slice(0, 80))})`);
}

// ---------------------------------------------------------------------------------------------
// 1. The schema is still `0034`'s, and it already models both acts
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(`${root}migrations`)).filter((name) => name.endsWith(".sql"));
const numbers = [
  ...new Set(
    migrationFiles
      .map((name) => Number.parseInt(name.slice(0, 4), 10))
      .filter((number) => Number.isFinite(number)),
  ),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "STEP 201 adds no migration: the chain still ends at 0128");

const schema = await readFile(`${root}migrations/0034_merchant_api_credentials.sql`, "utf8");

expectSourceContains(schema, "revoked_at timestamptz,", "0034 has the revocation instant");
expectSourceContains(schema, "revoke_reason text,", "and the merchant's sentence");
expectSourceContains(schema, "rotated_from_id uuid,", "and the rotation link");
expectSourceContains(schema, "create unique index merchant_api_credentials_rotation_key", "with one successor per credential");
expectSourceContains(
  schema,
  "constraint merchant_api_credentials_reason_check check (",
  "and a check that couples the status to the sentence",
);
expectSourceContains(schema, "if old.status = 'revoked' and new.status is distinct from old.status then", "the guard that makes a revocation final");

// The guard freezes the key material; the label is deliberately not in that list, which is what lets a rotation
// hand the merchant's name to the successor.
const guardBody = schema.slice(schema.indexOf("create function public.merchant_api_credentials_guard_secret()"));

expect(!/new\.label is distinct from old\.label/u.test(guardBody), "the guard does not freeze the label, so a rotation can move a name");
expectSourceContains(guardBody, "new.key_hash is distinct from old.key_hash", "while the hash is frozen");

// ---------------------------------------------------------------------------------------------
// 2. The body of a revocation
// ---------------------------------------------------------------------------------------------

expectEqual(parseRevokeBody({ reason: "  Rotated by hand  " }).reason, "Rotated by hand", "a reason is trimmed");

for (const [body, description] of [
  [{ reason: "" }, "an empty reason"],
  [{ reason: "   " }, "a reason of spaces"],
  [{ reason: "x".repeat(281) }, "a reason over 280 characters"],
  [{ reason: "Fine.", extra: 1 }, "a body with an unknown key"],
  [{}, "a body with no reason"],
  [null, "a body that is not an object"],
] as readonly [unknown, string][]) {
  expectEqual(
    await refusalRuleOf(async () => parseRevokeBody(body)),
    CREDENTIAL_RULES.reasonInvalid,
    `${description} is refused`,
  );
}

expectEqual(CREDENTIAL_REASON_MAXIMUM_LENGTH, 280, "and the ceiling is the table's own");

// ---------------------------------------------------------------------------------------------
// 3. Revocation
// ---------------------------------------------------------------------------------------------

const revokeFixture = createFixture();
const revokeDependencies = dependenciesOf(revokeFixture);
const target = await createMerchantCredential({ actor: actorOf(), body: { label: "Main store", mode: "live" } }, revokeDependencies);
const before = { ...(revokeFixture.rows[0] ?? {}) };

const revoked = await revokeCredential(
  { actor: actorOf(), credentialId: target.id, body: { reason: "The checkout was replaced." } },
  revokeDependencies,
);

expectEqual(revoked.status, "revoked", "the credential is revoked");
expectEqual(revoked.revokeReason, "The checkout was replaced.", "with the merchant's own sentence");
expect(revoked.revokedAt !== null, "and the instant it happened");
expectEqual(revokeFixture.rows[0]?.["status"], "revoked", "the row says the same");
expectEqual(revokeFixture.rows[0]?.["key_hash"], before["key_hash"], "the key's verifier is untouched");
expectEqual(revokeFixture.rows[0]?.["key_last_four"], before["key_last_four"], "and its tail");
expectEqual(revokeFixture.rows[0]?.["signing_secret_ciphertext"], before["signing_secret_ciphertext"], "and the sealed secret");
expectEqual(Number(revokeFixture.rows[0]?.["version"]), Number(before["version"]) + 1, "and one guarded write landed");

const revokedAudit = revokeFixture.audit.entries.find((entry) => entry.action === CREDENTIAL_AUDIT.revoked);

expectEqual(revokedAudit?.action, CREDENTIAL_AUDIT.revoked, "the revocation is in the chain");
expectEqual(revokedAudit?.payload["revoked_by"], "merchant", "as the merchant's own act");
expectEqual(revokedAudit?.entityId, target.id, "against the credential");
expect(
  !JSON.stringify(revokedAudit?.payload ?? {}).includes("checkout was replaced"),
  "and never the merchant's sentence",
);

const afterRevokePanel = await readMerchantCredentials(actorOf(), revokeDependencies);

expectEqual(afterRevokePanel.credentials[0]?.status, "revoked", "the list still shows it");
expectEqual(afterRevokePanel.counts.live, 0, "and stops counting toward the limit");

await expectRefusal(
  () => revokeCredential({ actor: actorOf(), credentialId: target.id, body: { reason: "Again." } }, revokeDependencies),
  "CONFLICT",
  "a second revocation is refused",
);
expectEqual(
  await refusalRuleOf(() =>
    revokeCredential({ actor: actorOf(), credentialId: target.id, body: { reason: "Again." } }, revokeDependencies),
  ),
  CREDENTIAL_RULES.alreadyRevoked,
  "with the rule the screen knows",
);

// Who may revoke, and whose credential it must be.
const roleRevokeFixture = createFixture();
const roleRevokeDependencies = dependenciesOf(roleRevokeFixture);
const roleTarget = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Shop", mode: "test" } },
  roleRevokeDependencies,
);

for (const [actor, description] of [
  [actorOf({ roles: ["support"] as readonly PlatformRole[] }), "support"],
  [actorOf({ roles: ["finance_ops"] as readonly PlatformRole[] }), "the finance desk"],
  [actorOf({ roles: ["owner"] as readonly PlatformRole[], companyId: otherCompanyId }), "another merchant"],
] as readonly [RequestActor, string][]) {
  await expectRefusal(
    () =>
      revokeCredential(
        { actor, credentialId: roleTarget.id, body: { reason: "Not mine." } },
        roleRevokeDependencies,
      ),
    description === "another merchant" ? "RESOURCE_NOT_FOUND" : "PERMISSION_DENIED",
    `${description} cannot revoke it`,
  );
}

expectEqual(roleRevokeFixture.rows[0]?.["status"], "active", "and none of those refusals revoked anything");
await expectRefusal(
  () => revokeCredential({ actor: actorOf(), credentialId: "not-a-uuid", body: { reason: "Fine." } }, roleRevokeDependencies),
  "RESOURCE_NOT_FOUND",
  "an id that is not one is a not-found",
);
await expectRefusal(
  () =>
    revokeCredential(
      { actor: actorOf(), credentialId: "99999999-9999-4999-8999-999999999999", body: { reason: "Fine." } },
      roleRevokeDependencies,
    ),
  "RESOURCE_NOT_FOUND",
  "and so is an id nobody holds",
);

// A write that does not land is a refusal, not a screen that lies.
const lostFixture = createFixture();
const lostDependencies = dependenciesOf(lostFixture);
const lostTarget = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Lost", mode: "test" } },
  lostDependencies,
);

lostFixture.interfereOnce = true;
expectEqual(
  await refusalRuleOf(() =>
    revokeCredential({ actor: actorOf(), credentialId: lostTarget.id, body: { reason: "Gone." } }, lostDependencies),
  ),
  CREDENTIAL_RULES.writeNotApplied,
  "a revocation that matched no row is reported as not applied",
);
expectEqual(lostFixture.rows[0]?.["status"], "active", "and the credential is still live, as the database says");

// ---------------------------------------------------------------------------------------------
// 4. Regeneration
// ---------------------------------------------------------------------------------------------

const rotateFixture = createFixture();
const rotateDependencies = dependenciesOf(rotateFixture);
const original = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Main store", mode: "test" } },
  rotateDependencies,
);
const originalRow = { ...(rotateFixture.rows[0] ?? {}) };

const rotated = await regenerateCredential({ actor: actorOf(), credentialId: original.id }, rotateDependencies);
const successorRow = rotateFixture.rows.find((row) => row["id"] === rotated.credential.id) ?? {};
const predecessorRow = rotateFixture.rows.find((row) => row["id"] === original.id) ?? {};

expectEqual(rotated.credential.label, "Main store", "the successor takes the name the merchant knows");
expectEqual(rotated.credential.status, "active", "and is live");
expectEqual(rotated.previous.id, original.id, "the predecessor is the same row");
expectEqual(rotated.previous.status, "revoked", "and is revoked");
expectEqual(rotated.previous.revokeReason, CREDENTIAL_ROTATED_REASON, "with the platform's reason");
expect(rotated.previous.label.includes("superseded"), "and a name that says what happened");
expectEqual(successorRow["rotated_from_id"], original.id, "the successor names its predecessor");
expectEqual(predecessorRow["key_hash"], originalRow["key_hash"], "the predecessor keeps its verifier");
expect(successorRow["key_hash"] !== predecessorRow["key_hash"], "the successor has its own");
expect(successorRow["key_prefix"] !== predecessorRow["key_prefix"], "a new handle");
expect(successorRow["signing_secret_ciphertext"] !== predecessorRow["signing_secret_ciphertext"], "and a new sealed secret");
expectEqual(successorRow["mode"], "test", "in the same mode");

const panelAfterRotation = await readMerchantCredentials(actorOf(), rotateDependencies);

expectEqual(panelAfterRotation.credentials.filter((credential) => credential.status === "active").length, 1, "exactly one credential is live");
expectEqual(panelAfterRotation.credentials.length, 2, "and both are readable");
expectEqual(panelAfterRotation.counts.test, 1, "with one counted toward the limit");

const rotationEntries = rotateFixture.audit.entries;

expect(rotationEntries.some((entry) => entry.action === CREDENTIAL_AUDIT.regenerated), "the rotation is in the chain");
expect(rotationEntries.some((entry) => entry.action === CREDENTIAL_AUDIT.revoked && entry.payload["revoked_by"] === "rotated"), "and the retirement it caused");
const regeneratedEntry = rotationEntries.find((entry) => entry.action === CREDENTIAL_AUDIT.regenerated);

expectEqual(regeneratedEntry?.entityId, rotated.credential.id, "the rotation names the successor");
expectEqual(regeneratedEntry?.payload["rotated_from_id"], original.id, "and its predecessor");

// The two keys of the rotation are nowhere either.
const firstKey = rotateFixture.issued[0] ?? "";
const secondKey = rotateFixture.issued[2] ?? "";
const rotationText = JSON.stringify([...rotateFixture.rows, ...rotationEntries, rotated]);

expect(!rotationText.includes(firstKey), "the first key is not in any row, entry or view");
expect(!rotationText.includes(secondKey), "and neither is the second");
expect(!("key" in rotated.credential), "the successor's view has no key property");

// A predecessor is rotated once.
await expectRefusal(
  () => regenerateCredential({ actor: actorOf(), credentialId: original.id }, rotateDependencies),
  "CONFLICT",
  "a second rotation of the same predecessor is refused",
);
expectEqual(
  await refusalRuleOf(() => regenerateCredential({ actor: actorOf(), credentialId: original.id }, rotateDependencies)),
  CREDENTIAL_RULES.notActive,
  "and it is refused because that credential is no longer active, before the rotation link is asked",
);
expectEqual(
  await refusalRuleOf(() => regenerateCredential({ actor: actorOf(), credentialId: rotated.credential.id }, rotateDependencies)),
  null,
  "while the successor itself may be rotated onward",
);

const chained = rotateFixture.rows.filter((row) => row["rotated_from_id"] !== null).length;

expectEqual(chained, 2, "so a chain of three credentials exists, each naming the one before it");
expectEqual(
  await refusalRuleOf(() => regenerateCredential({ actor: actorOf(), credentialId: original.id }, rotateDependencies)),
  CREDENTIAL_RULES.notActive,
  "and the first link stays retired",
);

// Who may rotate.
const roleRotateFixture = createFixture();
const roleRotateDependencies = dependenciesOf(roleRotateFixture);
const roleRotateTarget = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Shop", mode: "test" } },
  roleRotateDependencies,
);

await expectRefusal(
  () =>
    regenerateCredential(
      { actor: actorOf({ roles: ["support"] as readonly PlatformRole[] }), credentialId: roleRotateTarget.id },
      roleRotateDependencies,
    ),
  "PERMISSION_DENIED",
  "support cannot rotate a credential",
);
await expectRefusal(
  () =>
    regenerateCredential(
      { actor: actorOf({ companyId: otherCompanyId }), credentialId: roleRotateTarget.id },
      roleRotateDependencies,
    ),
  "RESOURCE_NOT_FOUND",
  "and another merchant cannot rotate one it does not hold",
);
expectEqual(roleRotateFixture.rows.length, 1, "which wrote no successor");
expectEqual(roleRotateFixture.rows[0]?.["label"], "Shop", "and renamed nothing");

// ---------------------------------------------------------------------------------------------
// 5. The two failure modes of a rotation
// ---------------------------------------------------------------------------------------------

const insertFailFixture = createFixture();
const insertFailDependencies = dependenciesOf(insertFailFixture);
const keeper = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Main store", mode: "test" } },
  insertFailDependencies,
);

insertFailFixture.failInsert = true;
await expectRefusal(
  () => regenerateCredential({ actor: actorOf(), credentialId: keeper.id }, insertFailDependencies),
  "DEPENDENCY_FAILED",
  "a successor that cannot be written fails the rotation",
);
insertFailFixture.failInsert = false;

const compensated = insertFailFixture.rows[0] ?? {};

expectEqual(compensated["label"], "Main store", "the predecessor takes its name back");
expectEqual(compensated["status"], "active", "and is still live, so the merchant lost nothing");
expectEqual(insertFailFixture.rows.length, 1, "and no successor was written");

const retireFailFixture = createFixture();
const retireFailDependencies = dependenciesOf(retireFailFixture);
const retiring = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Main store", mode: "test" } },
  retireFailDependencies,
);

// The rename is update one, the retirement is update two: losing the second is the half-rotation.
retireFailFixture.failUpdatesFrom = 2;
expectEqual(
  await refusalRuleOf(() =>
    regenerateCredential({ actor: actorOf(), credentialId: retiring.id }, retireFailDependencies),
  ),
  CREDENTIAL_RULES.rotationIncomplete,
  "a retirement that does not land is reported rather than hidden",
);
retireFailFixture.failUpdatesFrom = null;

const halfRotated = await readMerchantCredentials(actorOf(), retireFailDependencies);

expectEqual(halfRotated.credentials.length, 2, "the merchant holds two credentials");
expectEqual(halfRotated.credentials.filter((credential) => credential.status === "active").length, 2, "and both are live");
expect(
  halfRotated.credentials.every((credential) => credential.status === "active"),
  "which is the failure mode chosen over losing both keys",
);

// And in that state the predecessor already has a successor, so pressing regenerate again is refused by the
// rotation link rather than writing a second successor - which is the only path that reaches that rule.
expectEqual(
  await refusalRuleOf(() =>
    regenerateCredential({ actor: actorOf(), credentialId: retiring.id }, retireFailDependencies),
  ),
  CREDENTIAL_RULES.alreadyRotated,
  "a half-rotated credential is not rotated again",
);

// ---------------------------------------------------------------------------------------------
// 6. The name a predecessor keeps
// ---------------------------------------------------------------------------------------------

const labelFixture = createFixture();
const labelDependencies = dependenciesOf(labelFixture);
const labelled = await createMerchantCredential(
  { actor: actorOf(), body: { label: "x".repeat(CREDENTIAL_LABEL_MAXIMUM_LENGTH), mode: "test" } },
  labelDependencies,
);

await regenerateCredential({ actor: actorOf(), credentialId: labelled.id }, labelDependencies);

const superseded = labelFixture.rows.find((row) => row["status"] === "revoked") ?? {};

expect(String(superseded["label"]).length <= CREDENTIAL_LABEL_MAXIMUM_LENGTH, "a superseded name fits the column");
expect(String(superseded["label"]).endsWith(")"), "and its suffix is closed");
expect(String(superseded["label"]).includes("superseded"), "and says what it is");
expectEqual(
  supersededLabelOf("Main store", "e0000000-0000-4000-8000-00000000000b").slice(-6),
  " 000b)",
  "the suffix carries four characters of the row's own id",
);
expect(
  supersededLabelOf("Main store", "e0000000-0000-4000-8000-00000000000b") !==
    supersededLabelOf("Main store", "e0000000-0000-4000-8000-00000000000c"),
  "so two predecessors of one name cannot collide",
);
expectEqual(supersededLabelOf("  ", "e0000000-0000-4000-8000-00000000000b").startsWith("superseded"), true, "and an empty name still yields a name");

// ---------------------------------------------------------------------------------------------
// 7. The two routes
// ---------------------------------------------------------------------------------------------

const revokeRoute = await sourceOf("app/api/developers/api-credentials/[id]/revoke/route.ts");
const regenerateRoute = await sourceOf("app/api/developers/api-credentials/[id]/regenerate/route.ts");

for (const [source, name] of [
  [revokeRoute, "the revoke route"],
  [regenerateRoute, "the regenerate route"],
] as readonly [string, string][]) {
  expectSourceContains(source, "requireCsrfToken(request", `${name} checks the token first`);
  expectSourceContains(source, "CREDENTIAL_MAXIMUM_BODY_BYTES", `${name} bounds the body`);
  expectSourceContains(source, 'readRequestActor(request.headers.get("cookie")', `${name} reads the session itself`);
  expectSourceContains(source, "getCredentialRuntime()", `${name} calls the service with the runtime`);
  expectSourceContains(source, "withErrorResponse(", `${name} answers in the platform's envelope`);
  expectSourceContains(source, '"cache-control": "no-store"', `${name} is never cached`);
  expectSourceLacks(source, "console.", `${name} does not print`);
  expect(
    source.indexOf("requireCsrfToken(") < source.indexOf("readRequestActor("),
    `${name} checks the token before the session`,
  );
}

expectSourceContains(revokeRoute, "revokeCredential(", "the revoke route revokes");
expectSourceContains(revokeRoute, "reasonLength", "and logs the length of the sentence, never the sentence");
expectSourceContains(regenerateRoute, "regenerateCredential(", "the regenerate route rotates");
expectSourceContains(regenerateRoute, "Object.keys(body).length > 0", "and refuses a body that carries anything");
expectSourceContains(regenerateRoute, "previous: rotated.previous", "answering with both views");

for (const path of [
  "/api/developers/api-credentials/[id]/revoke",
  "/api/developers/api-credentials/[id]/regenerate",
]) {
  expect(CSRF_PROTECTED_PATHS.includes(path), `${path} is on the CSRF list`);
}

// ---------------------------------------------------------------------------------------------
// 8. The screen
// ---------------------------------------------------------------------------------------------

const panelSource = await sourceOf("app/(dashboard)/developers/api-credentials/credential-panel.tsx");

expectSourceContains(panelSource, "CREDENTIAL_REASON_MAXIMUM_LENGTH", "the reason is bounded in the browser");
expectSourceContains(panelSource, "revokingId", "one card's reason field is open at a time");
expectSourceContains(panelSource, "disabled={busy || reason.trim().length === 0}", "a revocation needs a sentence before it is offered");
expectSourceContains(panelSource, 'credential.status === "active" ? (', "only a live credential may be revoked or rotated");
expectSourceContains(panelSource, "`/api/developers/api-credentials/${encodeURIComponent(credentialId)}/revoke`", "the revoke path is built from the id");
expectSourceContains(panelSource, "`/api/developers/api-credentials/${encodeURIComponent(credentialId)}/regenerate`", "and the regenerate path");
expectEqual(panelSource.split('method: "POST"').length - 1, 3, "the panel sends three mutations");
expectEqual(panelSource.split("...(await csrfHeaders())").length - 1, 3, "each with its own token");
expectSourceContains(panelSource, 'role={isError ? "alert" : "status"}', "a refusal is announced");
for (const forbidden of ["revealKey", "showKey", "copyKey", "navigator.clipboard"]) {
  expectSourceLacks(panelSource, forbidden, `the panel still has no ${forbidden}`);
}

// ---------------------------------------------------------------------------------------------
// 9. Every message the panel names exists
// ---------------------------------------------------------------------------------------------

const messages = new Map<string, string>();

function collect(node: unknown, prefix: string): void {
  if (typeof node === "string") {
    messages.set(prefix, node);

    return;
  }

  if (typeof node !== "object" || node === null) {
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collect(value, prefix.length === 0 ? key : `${prefix}.${key}`);
  }
}

collect(en, "");

function messagePathsIn(source: string): readonly string[] {
  const found: string[] = [];

  for (const match of source.matchAll(/(?:getMessage|formatMessage)\("([a-z][A-Za-z0-9_.]*)"\)/gu)) {
    found.push(match[1] ?? "");
  }

  return found;
}

const used = [...new Set(messagePathsIn(panelSource))].sort();

for (const path of used) {
  expect(messages.has(path), `the message ${path} exists`);
}

for (const key of [
  "api.revoke",
  "api.revokeConfirm",
  "api.revokeReasonPrompt",
  "api.revokeReasonLabel",
  "api.revoked",
  "api.regenerate",
  "api.regenerated",
  "api.ruleAlreadyRevoked",
  "api.ruleNotActive",
  "api.ruleRotationIncomplete",
  "api.ruleNotFound",
  "api.ruleReasonInvalid",
]) {
  expect(messages.has(key), `the sentence ${key} is in the catalog`);
}

// ---------------------------------------------------------------------------------------------
// 10. The words
// ---------------------------------------------------------------------------------------------

expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(CREDENTIAL_AUDIT.revoked),
  "the revocation's action fits the chain's own pattern",
);
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(CREDENTIAL_AUDIT.regenerated),
  "and the rotation's",
);
expect(
  Object.values(CREDENTIAL_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "every rule stays a machine word",
);
expectEqual(
  (CREDENTIAL_ROTATED_REASON as string).length <= CREDENTIAL_REASON_MAXIMUM_LENGTH,
  true,
  "the platform's own reason fits the column it goes in",
);

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`credential rotation gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `credential rotation gate passed: ${String(checkCount)} checks, section 20's revocation as one guarded write ` +
      "whose landing is read back, a rotation written rename-then-insert-then-retire so the worst case leaves two " +
      "live keys rather than none, a chain of successors that no credential enters twice, and no key in any row, " +
      "view or chain entry\n",
  );
}
