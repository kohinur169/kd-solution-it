// path: lib/api/verify-credentials.ts
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../auth/audit.ts";
import type { InMemoryAuditTrail } from "../auth/audit.ts";
import type { PlatformRole, RequestActor } from "../auth/types.ts";
import type { RestClient } from "../auth/rest.ts";
import { openSecret, sealSecret, type SecretBox } from "../auth/secrets.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { en } from "../i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../security/csrf.ts";
import {
  CREDENTIAL_ACTIVE_LIMIT,
  CREDENTIAL_AUDIT,
  CREDENTIAL_HASH_PATTERN,
  CREDENTIAL_HANDLE_PATTERN,
  CREDENTIAL_KEY_PATTERN,
  CREDENTIAL_LABEL_MAXIMUM_LENGTH,
  CREDENTIAL_MASK,
  CREDENTIAL_MODES,
  CREDENTIAL_RULES,
  CREDENTIAL_TAIL_PATTERN,
  MERCHANT_API_CREDENTIALS_TABLE,
  credentialSecretContext,
  isCredentialMode,
  maskedKeyOf,
  maskedSigningSecretOf,
} from "./credential-fields.ts";
import {
  createMerchantCredential,
  hashOfPresentedKey,
  isWellFormedHash,
  parseCreateCredentialBody,
  readMerchantCredentials,
  type CredentialDependencies,
} from "./credentials.ts";

/**
 * The gate for STEP 200: section 20's API credentials.
 *
 * ## What this proves
 *
 *   - **A key exists and is never seen.** The gate hands the service its randomness, so it knows the exact key
 *     that was issued and can look for it everywhere: in the row the database kept, in every column of it, in
 *     the view the screen gets, in the audit payload and in the route's log line. It is present in none of
 *     them, and the row kept is a SHA-256 that the gate recomputes itself from the key it chose.
 *   - **The signing secret is sealed to its merchant.** The box opens under the company's associated data and
 *     fails to open under another company's, which is what makes a ciphertext copied into a neighbour's row
 *     useless.
 *   - **The display is a mask.** `maskedKeyOf` is built from the handle and the last four characters, and the
 *     gate refuses any mask that contains a run long enough to be a secret.
 *   - **Only an owner, only its own company.** No role, then `owner`; the company comes from the session, so a
 *     crafted body has nothing to name.
 *   - **The schema is `0034`'s.** This STEP writes no migration: the table, its twelve checks, its guard and
 *     its three unique indexes already exist, and the chain still ends at 128. The fixture carries those rules
 *     so a service that skipped one would fail here.
 *   - **The surface is section 20's.** One mutating route on the CSRF list with the ceiling, the session and a
 *     log line that names no key material; one merchant page and one browser form with no reveal control.
 *
 * ## How
 *
 * An in-memory PostgREST over arrays implementing `0034`'s checks and unique indexes, and a real AES-256-GCM
 * seal through `lib/auth/secrets.ts` with a fixed 32 byte master key - so the round trip is the platform's own
 * crypto and not a stub of it.
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
const nowIso = new Date(nowMs).toISOString();

/** A fixed 32 byte master key, so the seal is the platform's own AES-256-GCM rather than a stub of it. */
const masterKey = Buffer.alloc(32, 7).toString("base64");

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
  /** Every hex string the service asked for, in order, so the gate knows the key and the secret. */
  readonly issued: string[];
  nowMs: number;
}

interface Query {
  readonly equals: Map<string, string>;
  readonly lists: Map<string, readonly string[]>;
  readonly nulls: Set<string>;
  readonly notNulls: Set<string>;
  readonly lessThan: Map<string, string>;
  readonly order: readonly { readonly column: string; readonly direction: "asc" | "desc" }[];
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const lists = new Map<string, readonly string[]>();
  const nulls = new Set<string>();
  const notNulls = new Set<string>();
  const lessThan = new Map<string, string>();
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

    if (value.startsWith("lt.")) {
      lessThan.set(key, decodeURIComponent(value.slice(3)));
      continue;
    }

    if (value.startsWith("in.(") && value.endsWith(")")) {
      lists.set(
        key,
        value
          .slice(4, -1)
          .split(",")
          .map((item) => decodeURIComponent(item)),
      );
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, lists, nulls, notNulls, lessThan, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const [column, values] of query.lists) {
    if (!values.includes(String(row[column]))) {
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

  for (const [column, value] of query.lessThan) {
    if (String(row[column] ?? "") >= value) {
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

/**
 * `0034`'s twelve checks and its three unique indexes, entered row by row.
 *
 * The service is expected to satisfy these; the fixture enforces them anyway, because a check the service
 * skipped would otherwise be a check nobody ran.
 */
function guardRow(fixture: Fixture, row: Row, mode: "insert" | "update", previous: Row | null): void {
  const label = String(row["label"] ?? "");

  if (label.length < 1 || label.length > 80 || label !== label.trim()) {
    validation("label", "merchant_api_credentials_label_check");
  }

  if (!CREDENTIAL_HANDLE_PATTERN.test(String(row["key_prefix"] ?? ""))) {
    validation("key_prefix", "merchant_api_credentials_prefix_check");
  }

  if (!CREDENTIAL_TAIL_PATTERN.test(String(row["key_last_four"] ?? ""))) {
    validation("key_last_four", "merchant_api_credentials_last_four_check");
  }

  if (!CREDENTIAL_HASH_PATTERN.test(String(row["key_hash"] ?? ""))) {
    validation("key_hash", "merchant_api_credentials_hash_check");
  }

  if (!CREDENTIAL_TAIL_PATTERN.test(String(row["signing_secret_last_four"] ?? ""))) {
    validation("signing_secret_last_four", "merchant_api_credentials_secret_last_four_check");
  }

  const ciphertext = String(row["signing_secret_ciphertext"] ?? "");

  if (ciphertext.length < 16 || ciphertext.length > 8_192) {
    validation("signing_secret_ciphertext", "merchant_api_credentials_ciphertext_check");
  }

  const iv = String(row["signing_secret_iv"] ?? "");

  if (iv.length < 12 || iv.length > 64) {
    validation("signing_secret_iv", "merchant_api_credentials_iv_check");
  }

  const tag = String(row["signing_secret_tag"] ?? "");

  if (tag.length < 16 || tag.length > 64) {
    validation("signing_secret_tag", "merchant_api_credentials_tag_check");
  }

  if (!["test", "live"].includes(String(row["mode"]))) {
    validation("mode", "merchant_api_credentials_mode_check");
  }

  if (!["active", "revoked"].includes(String(row["status"]))) {
    validation("status", "merchant_api_credentials_status_check");
  }

  if ((row["status"] === "revoked") !== (row["revoked_at"] !== null && row["revoked_at"] !== undefined)) {
    validation("revoked_at", "merchant_api_credentials_revoked_check");
  }

  if (row["status"] === "revoked") {
    const reason = String(row["revoke_reason"] ?? "");

    if (reason.length < 1 || reason.length > 280 || reason !== reason.trim()) {
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

    async insert(table: string, inserted: readonly Row[]): Promise<void> {
      await this.insertReturning(table, inserted, schemaOfNothing());
    },

    async insertReturning<TRow>(table: string, inserted: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      if (table !== MERCHANT_API_CREDENTIALS_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const written: Row[] = [];

      for (const row of inserted) {
        counter += 1;
        const next: Row = {
          id: `e0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
          created_at: new Date(nowMs + counter * 1_000).toISOString(),
          updated_at: nowIso,
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

      const parsed = parseQuery(query);

      for (const row of rows) {
        if (!matches(row, parsed)) {
          continue;
        }

        const previous = { ...row };
        const next = { ...row, ...values };

        guardRow(state as Fixture, next, "update", previous);
        Object.assign(row, values);
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "no_rpc" } });
    },
  };

  Object.assign(state, { rest, audit, rows, issued, nowMs });

  return state as Fixture;
}

/** A schema that accepts anything, for the one insert path that reads nothing back. */
function schemaOfNothing(): z.ZodType<Record<string, unknown>> {
  return {
    array(): z.ZodType<readonly Record<string, unknown>[]> {
      return {
        parse(value: unknown): readonly Record<string, unknown>[] {
          return Array.isArray(value) ? (value as readonly Record<string, unknown>[]) : [];
        },
      } as unknown as z.ZodType<readonly Record<string, unknown>[]>;
    },
  } as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * The dependencies a test uses: a real seal, and randomness the gate can predict.
 *
 * The hex strings are drawn from a counter, so each is unique - `0034`'s unique hash index would otherwise
 * refuse the second credential - and every one is recorded, which is how the gate knows the key.
 */
function dependenciesOf(fixture: Fixture): CredentialDependencies {
  let drawn = 0;

  return {
    rest: fixture.rest,
    audit: fixture.audit,
    now: (): number => fixture.nowMs,
    seal: (plaintext: string, context: string): SecretBox =>
      // The platform's own AES-256-GCM, not a stub: `openSecret` in this file proves both directions.
      sealWithMasterKey(plaintext, context),
    randomHex: (bytes: number): string => {
      drawn += 1;
      let text = "";

      for (let index = 0; index < bytes; index += 1) {
        text += (((drawn * 31 + index * 17) % 256) | 0).toString(16).padStart(2, "0");
      }

      const value = createHash("sha256").update(`${String(drawn)}:${text}`, "utf8").digest("hex");
      fixture.issued.push(value);

      return value;
    },
  };
}

/** The platform's own AES-256-GCM seal, with a fixed master key, so the round trip below is real crypto. */
function sealWithMasterKey(plaintext: string, context: string): SecretBox {
  return sealSecret(masterKey, plaintext, context);
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
// 1. The schema is `0034`'s, and this STEP writes no migration
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(`${root}migrations`)).filter((name) => name.endsWith(".sql"));
const numbers = [
  ...new Set(
    migrationFiles
      .map((name) => Number.parseInt(name.slice(0, 4), 10))
      .filter((number) => Number.isFinite(number)),
  ),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "STEP 200 adds no migration: the chain still ends at 0128");
expectEqual(numbers.length, 128, "and holds 128 files");

const schema = await readFile(`${root}migrations/0034_merchant_api_credentials.sql`, "utf8");

for (const needle of [
  "create table public.merchant_api_credentials (",
  "constraint merchant_api_credentials_hash_check check (key_hash ~ '^[0-9a-f]{64}$')",
  "constraint merchant_api_credentials_prefix_check check (",
  "constraint merchant_api_credentials_last_four_check check (key_last_four ~ '^[A-Za-z0-9]{4}$')",
  "constraint merchant_api_credentials_secret_last_four_check check (",
  "constraint merchant_api_credentials_revoked_check check (",
  "create unique index merchant_api_credentials_hash_key",
  "create unique index merchant_api_credentials_label_key",
  "create trigger merchant_api_credentials_guard_secret",
  "create policy merchant_api_credentials_default_deny",
  "raise exception 'a credential keeps its identity; revoke it and issue the next one'",
]) {
  expectSourceContains(schema, needle, `0034 states ${JSON.stringify(needle.slice(0, 52))}`);
}

// The columns the service writes must be the columns the table has: a typo would be a runtime failure, not a
// compile error, because the service builds an untyped row.
const serviceSource = await sourceOf("lib/api/credentials.ts");

for (const column of [
  "key_prefix",
  "key_last_four",
  "key_hash",
  "signing_secret_last_four",
  "signing_secret_ciphertext",
  "signing_secret_iv",
  "signing_secret_tag",
  "encryption_key_version",
]) {
  expectSourceContains(schema, `  ${column} `, `0034 has the ${column} column the service writes`);
  expectSourceContains(serviceSource, `${column}:`, `and the service writes ${column}`);
}

// ---------------------------------------------------------------------------------------------
// 2. The words
// ---------------------------------------------------------------------------------------------

expectEqual(CREDENTIAL_MODES.length, 2, "two modes, as section 8 keeps them");
expectEqual(isCredentialMode("test") && isCredentialMode("live"), true, "both are modes");
expectEqual(isCredentialMode("sandbox"), false, "and a third word is not");
expectEqual(CREDENTIAL_ACTIVE_LIMIT, 10, "ten live credentials per mode");
expectEqual(CREDENTIAL_MASK, "\u2022", "the mask is a bullet");
expect(
  Object.values(CREDENTIAL_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "every rule is a machine word",
);
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(CREDENTIAL_AUDIT.created),
  "the audit action fits the chain's own pattern",
);
expectEqual(CREDENTIAL_LABEL_MAXIMUM_LENGTH, 80, "and a label is bounded the way the table bounds it");

// ---------------------------------------------------------------------------------------------
// 3. A key exists, and nothing keeps it
// ---------------------------------------------------------------------------------------------

const fixture = createFixture();
const dependencies = dependenciesOf(fixture);
const created = await createMerchantCredential({ actor: actorOf(), body: { label: "Main store", mode: "test" } }, dependencies);
const keySecret = fixture.issued[0] ?? "";
const signingSecret = fixture.issued[1] ?? "";
const key = `kd_test_k${keySecret.slice(0, 6)}_${keySecret}`;
const stored = fixture.rows[0] ?? {};

expect(CREDENTIAL_KEY_PATTERN.test(key), "the issued key matches the pattern the columns are cut from");
expectEqual(key.startsWith("kd_test_"), true, "it names its mode");
expectEqual(stored["key_hash"], createHash("sha256").update(key, "utf8").digest("hex"), "the row keeps the SHA-256 of that key");
expectEqual(stored["key_last_four"], key.slice(-4), "and its last four characters");
expectEqual(stored["key_prefix"], key.split("_")[2], "and the handle between them");
expectEqual(hashOfPresentedKey(key), stored["key_hash"], "and hashing a presented key finds the row");
expectEqual(isWellFormedHash(String(stored["key_hash"])), true, "the hash is the shape the table accepts");

expectEqual(
  CREDENTIAL_TAIL_PATTERN.test(String(stored["signing_secret_last_four"])),
  true,
  "the signing secret leaves four characters as well",
);
expectEqual(stored["signing_secret_last_four"], signingSecret.slice(-4), "and they are its last four");

const box: SecretBox = {
  iv: String(stored["signing_secret_iv"]),
  tag: String(stored["signing_secret_tag"]),
  ciphertext: String(stored["signing_secret_ciphertext"]),
};

expectEqual(
  openSecret(masterKey, box, credentialSecretContext(companyId)),
  signingSecret,
  "and the ciphertext opens back to the secret under the merchant's own associated data",
);
expect(
  ((): boolean => {
    try {
      openSecret(masterKey, box, credentialSecretContext(otherCompanyId));

      return false;
    } catch {
      return true;
    }
  })(),
  "and will not open under another merchant's associated data",
);
expect(stored["signing_secret_ciphertext"] !== signingSecret, "the secret is not stored as itself");

// The key is nowhere. Every column, the view, the audit payload and the whole serialised view are searched.
for (const [column, value] of Object.entries(stored)) {
  expect(
    !String(value).includes(key.slice(7)) && !String(value).includes(signingSecret),
    `no part of the key or the secret is kept in ${column}`,
  );
}

const serialised = JSON.stringify(created);

expect(!serialised.includes(key.slice(7)), "the key is not in the view the screen receives");
expect(!serialised.includes(signingSecret), "and neither is the signing secret");
expectEqual("key" in created, false, "the view has no property that could hold a key");
expectEqual("signingSecret" in created, false, "and none that could hold the secret");
expect("keyHash" in created === false, "and no hash either");

const auditEntry = fixture.audit.entries[0];

expectEqual(auditEntry?.action, CREDENTIAL_AUDIT.created, "the creation is in the chain");
expectEqual(auditEntry?.companyId, companyId, "on the merchant's chain");
expectEqual(auditEntry?.actorUserId, ownerUserId, "with the owner's id");
expectEqual(auditEntry?.entityId, created.id, "against the credential's own row");
expectEqual(auditEntry?.payload["mode"], "test", "naming the mode");
expectEqual(auditEntry?.payload["key_last_four"], key.slice(-4), "and the four characters a screen may show");
expect(
  !JSON.stringify(auditEntry?.payload ?? {}).includes(key.slice(7)),
  "and no part of the key",
);

// ---------------------------------------------------------------------------------------------
// 4. The display is a mask
// ---------------------------------------------------------------------------------------------

expectEqual(
  created.maskedKey,
  maskedKeyOf({ mode: "test", keyPrefix: String(stored["key_prefix"]), keyLastFour: key.slice(-4) }),
  "the mask is built from the handle and the last four characters",
);
expect(created.maskedKey.includes(CREDENTIAL_MASK.repeat(8)), "with eight mask characters between them");
expect(
  !/[0-9a-f]{16,}/u.test(created.maskedKey),
  "and no run long enough to be any part of a key",
);
expectEqual(created.maskedSigningSecret, maskedSigningSecretOf(signingSecret.slice(-4)), "the secret's own mask");
expect(!created.maskedSigningSecret.includes(signingSecret.slice(0, 8)), "which carries no part of the secret");
expectEqual(created.status, "active", "a new credential is active");
expectEqual(created.mode, "test", "and keeps the mode it was asked for");
expectEqual(created.label, "Main store", "and the label, trimmed");

// ---------------------------------------------------------------------------------------------
// 5. The body
// ---------------------------------------------------------------------------------------------

expectEqual(parseCreateCredentialBody({ label: "  Shop  ", mode: "live" }).label, "Shop", "a label is trimmed");
expectEqual(parseCreateCredentialBody({ label: "Shop", mode: "live" }).mode, "live", "and a mode travels through");

for (const [body, description] of [
  [{ label: "Shop", mode: "sandbox" }, "a mode that is not one of the two"],
  [{ label: "", mode: "test" }, "an empty label"],
  [{ label: "x".repeat(81), mode: "test" }, "a label of eighty one characters"],
  [{ label: "Shop", mode: "test", companyId: otherCompanyId }, "a body that names a company"],
  [{ label: "Shop" }, "a body with no mode"],
  [{ mode: "test" }, "a body with no label"],
  [null, "a body that is not an object"],
] as readonly [unknown, string][]) {
  expectEqual(
    await refusalRuleOf(async () => parseCreateCredentialBody(body)),
    CREDENTIAL_RULES.invalidFormat,
    `${description} is refused`,
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Who may create, and for whom
// ---------------------------------------------------------------------------------------------

const roleFixture = createFixture();

for (const [actor, description] of [
  [actorOf({ roles: ["support"] as readonly PlatformRole[] }), "support"],
  [actorOf({ roles: ["finance_ops"] as readonly PlatformRole[] }), "the finance desk"],
  [actorOf({ roles: ["super_admin"] as readonly PlatformRole[], companyId: null }), "a platform administrator"],
  [actorOf({ companyId: null }), "an owner with no company"],
] as readonly [RequestActor, string][]) {
  await expectRefusal(
    () => createMerchantCredential({ actor, body: { label: "Shop", mode: "test" } }, dependenciesOf(roleFixture)),
    "PERMISSION_DENIED",
    `${description} cannot make a credential`,
  );
}

expectEqual(roleFixture.rows.length, 0, "and none of those refusals wrote a row");

// A crafted body cannot reach another merchant: the company is the session's, whatever the body says.
const craftFixture = createFixture();

await createMerchantCredential(
  { actor: actorOf(), body: { label: "Shop", mode: "test", company_id: otherCompanyId } },
  dependenciesOf(craftFixture),
).catch(() => null);

expectEqual(craftFixture.rows.length, 0, "a body that names a company is not a body this service accepts");

const trimmedFixture = createFixture();

await createMerchantCredential({ actor: actorOf(), body: { label: "  Shop  ", mode: "test" } }, dependenciesOf(trimmedFixture));
expectEqual(trimmedFixture.rows[0]?.["company_id"], companyId, "and the row that is written belongs to the session's company");

// ---------------------------------------------------------------------------------------------
// 7. The two rules the table has and the service must respect
// ---------------------------------------------------------------------------------------------

const labelFixture = createFixture();
const labelDependencies = dependenciesOf(labelFixture);

await createMerchantCredential({ actor: actorOf(), body: { label: "Main store", mode: "test" } }, labelDependencies);
expectEqual(
  await refusalRuleOf(() =>
    createMerchantCredential({ actor: actorOf(), body: { label: "main STORE", mode: "live" } }, labelDependencies),
  ),
  CREDENTIAL_RULES.labelTaken,
  "a second live credential with the same label, in either mode, is refused",
);
expectEqual(labelFixture.rows.length, 1, "and nothing is written");

const limitFixture = createFixture();
const limitDependencies = dependenciesOf(limitFixture);

for (let index = 0; index < CREDENTIAL_ACTIVE_LIMIT; index += 1) {
  await createMerchantCredential(
    { actor: actorOf(), body: { label: `Shop ${String(index)}`, mode: "test" } },
    limitDependencies,
  );
}

expectEqual(limitFixture.rows.length, CREDENTIAL_ACTIVE_LIMIT, "ten test credentials may stand");
expectEqual(
  await refusalRuleOf(() =>
    createMerchantCredential({ actor: actorOf(), body: { label: "One more", mode: "test" } }, limitDependencies),
  ),
  CREDENTIAL_RULES.limitReached,
  "and the eleventh in the same mode is refused",
);
expectEqual(
  await refusalRuleOf(() =>
    createMerchantCredential({ actor: actorOf(), body: { label: "Live one", mode: "live" } }, limitDependencies),
  ),
  null,
  "while the live mode still has room",
);
expectEqual(limitFixture.rows.length, CREDENTIAL_ACTIVE_LIMIT + 1, "and takes it");

// ---------------------------------------------------------------------------------------------
// 8. The read
// ---------------------------------------------------------------------------------------------

const readFixture = createFixture();
const readDependencies = dependenciesOf(readFixture);

await createMerchantCredential({ actor: actorOf(), body: { label: "First", mode: "test" } }, readDependencies);
await createMerchantCredential({ actor: actorOf(), body: { label: "Second", mode: "live" } }, readDependencies);
await createMerchantCredential({ actor: actorOf({ companyId: otherCompanyId }), body: { label: "Neighbour", mode: "test" } }, readDependencies);

const panel = await readMerchantCredentials(actorOf(), readDependencies);

expectEqual(panel.credentials.length, 2, "a merchant reads its own two credentials and not its neighbour's");
expectEqual(
  panel.credentials.map((credential) => credential.label).join(","),
  "Second,First",
  "newest first",
);
expectEqual(panel.counts.test, 1, "one test credential is counted");
expectEqual(panel.counts.live, 1, "and one live");
expectEqual(panel.limit, CREDENTIAL_ACTIVE_LIMIT, "the limit travels with the view");
expectEqual(panel.canCreate, true, "so there is room to make more");
expectEqual(panel.truncated, false, "and the list is complete");
expect(
  panel.credentials.every((credential) => !JSON.stringify(credential).includes("key_hash")),
  "a credential the screen holds carries no hash",
);

await expectRefusal(
  () => readMerchantCredentials(actorOf({ roles: ["support"] as readonly PlatformRole[] }), readDependencies),
  "PERMISSION_DENIED",
  "and a role that may not read them is refused",
);

// A revoked credential is listed, and does not count toward the limit.
const revokedFixture = createFixture();

await createMerchantCredential({ actor: actorOf(), body: { label: "Old", mode: "test" } }, dependenciesOf(revokedFixture));
await revokedFixture.rest.update(
  MERCHANT_API_CREDENTIALS_TABLE,
  `id=eq.${encodeURIComponent(String(revokedFixture.rows[0]?.["id"]))}`,
  { status: "revoked", revoked_at: nowIso, revoke_reason: "Replaced by the new storefront." },
);
const revokedPanel = await readMerchantCredentials(actorOf(), dependenciesOf(revokedFixture));

expectEqual(revokedPanel.credentials[0]?.status, "revoked", "a revoked credential stays readable");
expectEqual(revokedPanel.credentials[0]?.revokeReason, "Replaced by the new storefront.", "with the reason it was revoked");
expectEqual(revokedPanel.counts.test, 0, "and stops counting toward the limit");

// `0034`'s frozen identity, entered directly: the guard refuses a moved key hash.
const frozenFixture = createFixture();
const frozenView = await createMerchantCredential(
  { actor: actorOf(), body: { label: "Frozen", mode: "test" } },
  dependenciesOf(frozenFixture),
);

await expectRefusal(
  () =>
    frozenFixture.rest.update(MERCHANT_API_CREDENTIALS_TABLE, `id=eq.${encodeURIComponent(frozenView.id)}`, {
      key_hash: "0".repeat(64),
    }),
  "VALIDATION_FAILED",
  "a credential's hash cannot be replaced",
);

// ---------------------------------------------------------------------------------------------
// 9. The route
// ---------------------------------------------------------------------------------------------

const routeSource = await sourceOf("app/api/developers/api-credentials/route.ts");
const pageSource = await sourceOf("app/(dashboard)/developers/api-credentials/page.tsx");
const panelSource = await sourceOf("app/(dashboard)/developers/api-credentials/credential-panel.tsx");

expectSourceContains(routeSource, "requireCsrfToken(request", "the route checks the token first");
expectSourceContains(routeSource, "CREDENTIAL_MAXIMUM_BODY_BYTES", "and bounds the body");
expectSourceContains(routeSource, 'readRequestActor(request.headers.get("cookie")', "reads the session itself");
expectSourceContains(routeSource, "createMerchantCredential(", "and calls the service");
expectSourceContains(routeSource, "getCredentialRuntime()", "with the runtime");
expectSourceContains(routeSource, "withErrorResponse(", "answering in the platform's envelope");
expectSourceContains(routeSource, '"cache-control": "no-store"', "and never cached");
expectSourceContains(routeSource, ": 201", "with a created status");
expectSourceLacks(routeSource, "console.", "the route does not print");
expect(
  routeSource.indexOf("requireCsrfToken(") < routeSource.indexOf("readRequestActor("),
  "the token is checked before the session is read",
);
expect(
  routeSource.indexOf("CREDENTIAL_MAXIMUM_BODY_BYTES") < routeSource.indexOf("readRequestActor("),
  "and the ceiling before the body is read",
);

// The one log line names a length and a mode, and no key material at all.
const logStart = routeSource.indexOf("logger.info(");
const logEnd = routeSource.indexOf(");", logStart);
const logLine = routeSource.slice(logStart, logEnd);

expect(logStart > 0, "the route logs the act");
for (const forbidden of ["key", "secret", "hash", "prefix", "lastFour"]) {
  expect(
    !logLine.toLowerCase().includes(forbidden.toLowerCase()),
    `the log line names no ${forbidden}`,
  );
}

expect(
  logLine.includes("labelLength: credential.label.length"),
  "the log line carries the label's length rather than the label itself",
);

expect(CSRF_PROTECTED_PATHS.includes("/api/developers/api-credentials"), "the path is on the CSRF list");

// ---------------------------------------------------------------------------------------------
// 10. The screen
// ---------------------------------------------------------------------------------------------

expectSourceContains(pageSource, "readOwnerActor(", "the page reads the owner's session");
expectSourceContains(pageSource, "readMerchantCredentials(", "and the merchant's credentials");
expectSourceContains(pageSource, "CredentialPanel", "rendering the panel");
expectSourceContains(pageSource, 'kind: "forbidden"', "with a forbidden state of its own");
expectSourceLacks(pageSource, "console.", "and prints nothing");

expectSourceContains(panelSource, '"use client"', "the panel is a browser component");
expectSourceContains(panelSource, "...(await csrfHeaders())", "it asks for the token");
expectSourceContains(panelSource, "credential.maskedKey", "and prints the mask");
expectSourceContains(panelSource, "credential.maskedSigningSecret", "and the secret's mask");
expectSourceContains(panelSource, 'role={isError ? "alert" : "status"}', "a refusal is announced");
expectSourceContains(panelSource, "disabled={busy", "the button is disabled while it runs");
expectSourceContains(panelSource, "maxLength={CREDENTIAL_LABEL_MAXIMUM_LENGTH}", "the label is bounded in the browser too");
expectSourceContains(panelSource, "router.refresh()", "and the page is re-read after the act");
expectSourceLacks(panelSource, "console.", "the panel prints nothing");
expectSourceContains(panelSource, "gridClasses = \"grid grid-cols-1 gap-3 sm:grid-cols-2\"", "two fields stack on a phone and sit side by side from the tablet breakpoint");

// There is no reveal anywhere: no control, no handler and no state that could hold a whole key.
for (const forbidden of ["revealKey", "showKey", "copyKey", "navigator.clipboard"]) {
  expectSourceLacks(panelSource, forbidden, `the panel has no ${forbidden}`);
}

expectSourceContains(panelSource, "type MutationVerb = \"POST\"", "the panel sends one verb");
expectEqual(panelSource.split('method: "POST"').length - 1, 1, "and sends one mutation");
expectEqual(panelSource.split("...(await csrfHeaders())").length - 1, 1, "with one token spread");

// ---------------------------------------------------------------------------------------------
// 11. Every message the two files name exists
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

const used = [...new Set([...messagePathsIn(pageSource), ...messagePathsIn(panelSource)])].sort();

expect(used.length >= 25, "the screen names its sentences from one catalog");
for (const path of used) {
  expect(messages.has(path), `the message ${path} exists`);
}
expect(
  (messages.get("api.limitLabel") ?? "").includes("%used%") && (messages.get("api.limitLabel") ?? "").includes("%limit%"),
  "the limit's sentence takes both numbers",
);

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`credential gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `api credential gate passed: ${String(checkCount)} checks, section 20's key issued and never seen - a SHA-256 ` +
      "and four characters kept, the signing secret sealed to its own merchant, a mask built from what is left, " +
      "one owner per company, ten credentials per mode, and a screen with no way to reveal one\n",
  );
}
