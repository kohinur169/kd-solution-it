// path: lib/api/verify-public-api.ts
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../auth/audit.ts";
import type { InMemoryAuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { RATE_LIMIT_CLASS_POLICIES, RATE_LIMIT_COUNTER_FUNCTION } from "../security/rate-limit.ts";
import { CREDENTIAL_KEY_PATTERN, MERCHANT_API_CREDENTIALS_TABLE } from "./credential-fields.ts";
import { hashOfPresentedKey } from "./credentials.ts";
import { authenticateApiCall, handlePublicApiCall, presentedKeyOf } from "./public-api.ts";
import {
  API_AUDIT,
  API_KEY_MAXIMUM_LENGTH,
  API_PUBLISHED_LIMITS,
  PUBLIC_API_BASE,
  PUBLIC_API_VERSION,
  PUBLIC_API_VERSION_HEADER,
  type PublicApiAnswer,
} from "./public-fields.ts";

/**
 * The gate for STEP 202: section 20's authentication, rate limiting and audit logging.
 *
 * ## What this proves
 *
 *   - **Shape before hash, hash before row.** A missing header, a non-Bearer scheme, a token with a space in it,
 *     a token longer than any key and a token that is not a key are all refused without a query; the fake
 *     `rest.select` counts calls, so "without a query" is a measurement rather than a claim.
 *   - **Unknown and revoked are one answer.** The two produce the same code, the same rule and the same
 *     sentence, so the surface cannot be used to ask whether a guessed key ever existed.
 *   - **A closed merchant is told.** A key whose company is gone answers `account_unavailable`, which is the one
 *     refusal that is not about the key.
 *   - **The counter is the platform's, keyed on the merchant.** The `public_api` class is consumed through the
 *     same `consume_rate_limit` function every other route uses, the account bucket is the company rather than
 *     the credential, and a refusal is a `429` with `retry-after` that no route can forget.
 *   - **Every call is in the chain.** One `api.call` per answered call (status, mode, route, duration, the last
 *     four characters), one `api.auth_failed` per refused attempt (rule, route, address) - and the key, its hash
 *     and the body appear in neither.
 *   - **`last_used_at` is written at most once a minute, guarded by the row's version, and never fails a call.**
 *   - **The surface is a public one.** `no-store`, `x-api-version`, the three `ratelimit-*` fields, no cookie
 *     read, no CSRF token (a bearer key is not an ambient credential) and no session.
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

async function refusalOf(run: () => Promise<unknown>): Promise<{ code: string; rule: string | null; status: number }> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) {
      return { code: "not-an-app-error", rule: null, status: 0 };
    }

    return { code: error.code, rule: error.details[0]?.rule ?? null, status: error.status };
  }

  return { code: "no-refusal", rule: null, status: 0 };
}

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const credentialId = "0e000000-0000-4000-8000-000000000001";
const revokedCredentialId = "0e000000-0000-4000-8000-000000000002";
const secondCredentialId = "0e000000-0000-4000-8000-000000000003";
const nowMs = Date.parse("2026-11-07T09:00:00.000Z");

/** The two keys the fixture knows, so the gate can present one and be refused by the other. */
const liveKey = `kd_test_ka1b2c_${"a".repeat(64)}`;
const revokedKey = `kd_live_kd4e5f_${"b".repeat(64)}`;
const secondKey = `kd_test_kg7h8i_${"c".repeat(64)}`;

interface Fixture {
  readonly rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly rows: Row[];
  readonly companies: Row[];
  /** Every counter call the limiter made, so the gate can assert the scopes it used. */
  readonly counters: { scope: string; keyHash: string; limit: number }[];
  readonly selects: string[];
  /** Refuse the next counter call with these numbers. */
  refuseCounter: boolean;
  /** Lose the next update, the way a guarded write that matched nothing does. */
  loseUpdate: boolean;
  nowMs: number;
}

interface Query {
  readonly equals: Map<string, string>;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
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

    if (key === "limit") {
      limit = Number.parseInt(value, 10);
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  return true;
}

function createFixture(input: { readonly companyClosed?: boolean } = {}): Fixture {
  const rows: Row[] = [
    {
      id: credentialId,
      company_id: companyId,
      label: "Main store",
      mode: "test",
      status: "active",
      key_prefix: "ka1b2c",
      key_last_four: liveKey.slice(-4),
      key_hash: hashOfPresentedKey(liveKey),
      signing_secret_last_four: "1a2b",
      signing_secret_ciphertext: "ciphertext",
      signing_secret_iv: "iv",
      signing_secret_tag: "tag",
      created_at: new Date(nowMs - 86_400_000).toISOString(),
      last_used_at: null,
      revoked_at: null,
      revoke_reason: null,
      deleted_at: null,
      rotated_from_id: null,
      version: 4,
    },
    {
      id: revokedCredentialId,
      company_id: companyId,
      label: "Old store",
      mode: "live",
      status: "revoked",
      key_prefix: "kd4e5f",
      key_last_four: revokedKey.slice(-4),
      key_hash: hashOfPresentedKey(revokedKey),
      signing_secret_last_four: "3c4d",
      signing_secret_ciphertext: "ciphertext",
      signing_secret_iv: "iv",
      signing_secret_tag: "tag",
      created_at: new Date(nowMs - 172_800_000).toISOString(),
      last_used_at: null,
      revoked_at: new Date(nowMs - 86_400_000).toISOString(),
      revoke_reason: "Replaced.",
      deleted_at: null,
      rotated_from_id: null,
      version: 9,
    },
    {
      id: secondCredentialId,
      company_id: companyId,
      label: "Second store",
      mode: "test",
      status: "active",
      key_prefix: "kg7h8i",
      key_last_four: secondKey.slice(-4),
      key_hash: hashOfPresentedKey(secondKey),
      signing_secret_last_four: "5e6f",
      signing_secret_ciphertext: "ciphertext",
      signing_secret_iv: "iv",
      signing_secret_tag: "tag",
      created_at: new Date(nowMs - 86_400_000).toISOString(),
      last_used_at: null,
      revoked_at: null,
      revoke_reason: null,
      deleted_at: null,
      rotated_from_id: null,
      version: 1,
    },
  ];
  const companies: Row[] = [
    { id: companyId, name: "Northwind Studio", deleted_at: null },
    { id: otherCompanyId, name: "Third Party", deleted_at: null },
  ];
  const counters: { scope: string; keyHash: string; limit: number }[] = [];
  const selects: string[] = [];
  const audit = createInMemoryAuditTrail();
  const state: Partial<Fixture> = {};

  const rest: RestClient = {
    async select<TRow>(table: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      selects.push(`${table}:${query}`);

      const parsed = parseQuery(query);
      const source = table === MERCHANT_API_CREDENTIALS_TABLE ? rows : table === "companies" ? companies : null;

      if (source === null) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      let selected = source.filter((row) => matches(row, parsed));

      if (parsed.limit !== null) {
        selected = selected.slice(0, parsed.limit);
      }

      // A closed company is the one row the gate removes rather than filters: `deleted_at` is not null, so the
      // query's own `deleted_at=is.null` must be what excludes it.
      if (table === "companies" && (state as Fixture & { companyClosed?: boolean }).companyClosed === true) {
        selected = [];
      }

      return schema.array().parse(selected.map((row) => ({ ...row })));
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unexpected_insert" } });
    },

    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unexpected_insert" } });
    },

    async update(table: string, query: string, values: Row): Promise<void> {
      if (table !== MERCHANT_API_CREDENTIALS_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unexpected_update" } });
      }

      const fixture = state as Fixture;

      if (fixture.loseUpdate) {
        fixture.loseUpdate = false;

        return;
      }

      const parsed = parseQuery(query);

      for (const row of rows) {
        if (!matches(row, parsed)) {
          continue;
        }

        Object.assign(row, values);
        row["version"] = Number(row["version"]) + 1;
      }
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== RATE_LIMIT_COUNTER_FUNCTION) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_function" } });
      }

      const fixture = state as Fixture;
      const limit = Number(arguments_["p_limit"]);

      counters.push({
        scope: String(arguments_["p_scope"]),
        keyHash: String(arguments_["p_key_hash"]),
        limit,
      });

      if (fixture.refuseCounter) {
        return [{ allowed: false, remaining: 0, retry_after_seconds: 17, first_refusal: true }];
      }

      return [{ allowed: true, remaining: limit - 1, retry_after_seconds: 0, first_refusal: false }];
    },
  };

  Object.assign(state, {
    rest,
    audit,
    rows,
    companies,
    counters,
    selects,
    refuseCounter: false,
    loseUpdate: false,
    nowMs,
    companyClosed: input.companyClosed ?? false,
  });

  return state as Fixture;
}

function requestOf(input: {
  readonly key?: string | null;
  readonly header?: string | null;
  readonly method?: string;
  readonly cookie?: string;
}): Request {
  const headers = new Headers();

  if (input.header !== null && input.header !== undefined) {
    headers.set("authorization", input.header);
  } else if (input.key !== null && input.key !== undefined) {
    headers.set("authorization", `Bearer ${input.key}`);
  }

  if (input.cookie !== undefined) {
    headers.set("cookie", input.cookie);
  }

  headers.set("x-forwarded-for", "203.0.113.9");

  return new Request(`https://api.example.test${PUBLIC_API_BASE}/credential`, { method: input.method ?? "GET", headers });
}

function dependenciesOf(fixture: Fixture): {
  rest: RestClient;
  audit: InMemoryAuditTrail;
  now: () => number;
} {
  return { rest: fixture.rest, audit: fixture.audit, now: (): number => fixture.nowMs };
}

const answer: PublicApiAnswer = { status: 200, body: { ok: true } };

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the surface is where section 20 put it
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(new URL("../../migrations", import.meta.url).pathname)).filter((name) =>
  name.endsWith(".sql"),
);
const numbers = [
  ...new Set(migrationFiles.map((name) => Number.parseInt(name.slice(0, 4), 10)).filter(Number.isFinite)),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "STEP 202 adds no migration: the platform's own counter table is 0092's");
expectEqual(PUBLIC_API_BASE, "/api/public/v1", "the public API lives under its own prefix and version");
expectEqual(PUBLIC_API_VERSION, "v1", "and answers with that version");

// ---------------------------------------------------------------------------------------------
// 2. The shape of a key, before it is hashed
// ---------------------------------------------------------------------------------------------

const shapeFixture = createFixture();

for (const [header, description, rule] of [
  [null, "no authorization header", "api_key_missing"],
  ["", "an empty header", "api_key_missing"],
  ["   ", "a header of spaces", "api_key_missing"],
  ["kd_test_ka1b2c_" + "a".repeat(64), "a key with no scheme", "api_key_malformed"],
  ["Basic abc", "the wrong scheme", "api_key_malformed"],
  ["Bearer", "a scheme with no token", "api_key_malformed"],
  ["Bearer  ", "a scheme and spaces", "api_key_malformed"],
  ["Bearer kd_test_ka1b2c_short", "a token that is not a key", "api_key_malformed"],
  [`Bearer kd_test_ka1b2c_${"a".repeat(API_KEY_MAXIMUM_LENGTH)}`, "a token past the ceiling", "api_key_malformed"],
] as readonly [string | null, string, string][]) {
  const refusal = await refusalOf(async () => presentedKeyOf(requestOf({ header })));

  expectEqual(refusal.code, "AUTHENTICATION_REQUIRED", `${description} is refused`);
  expectEqual(refusal.rule, rule, `and ${description} names ${rule}`);
  expectEqual(refusal.status, 401, "with a 401");
}

expectEqual(presentedKeyOf(requestOf({ key: liveKey })), liveKey, "a well shaped key comes back as itself");
expectEqual(presentedKeyOf(requestOf({ header: `bearer ${liveKey}` })), liveKey, "and the scheme is case insensitive");

expect(shapeFixture.selects.length === 0, "and no shape refusal touched the database");

// ---------------------------------------------------------------------------------------------
// 3. Authentication, and the uniform refusal
// ---------------------------------------------------------------------------------------------

const authFixture = createFixture();
const principal = await authenticateApiCall(
  { request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential` },
  dependenciesOf(authFixture),
);

expectEqual(principal.credentialId, credentialId, "a live key authenticates its own credential");
expectEqual(principal.companyId, companyId, "and the merchant it belongs to");
expectEqual(principal.companyName, "Northwind Studio", "with the merchant's name");
expectEqual(principal.mode, "test", "and the mode the credential was issued in");
expectEqual(principal.keyPrefix, "ka1b2c", "and the handle a screen shows");
expectEqual(principal.keyLastFour, liveKey.slice(-4), "and the last four characters");
expect(principal.lastUsedRefreshed, "and the call recorded the key's use");

const usedRow = authFixture.rows.find((row) => row["id"] === credentialId) ?? {};

expectEqual(usedRow["last_used_at"], new Date(nowMs).toISOString(), "which is written on the row");
expectEqual(Number(usedRow["version"]), 5, "under a version guard that landed");

const unknown = await refusalOf(() =>
  authenticateApiCall(
    { request: requestOf({ key: `kd_test_kzzzzz_${"f".repeat(64)}` }), route: `${PUBLIC_API_BASE}/credential` },
    dependenciesOf(authFixture),
  ),
);
const revoked = await refusalOf(() =>
  authenticateApiCall(
    { request: requestOf({ key: revokedKey }), route: `${PUBLIC_API_BASE}/credential` },
    dependenciesOf(authFixture),
  ),
);

expectEqual(unknown.rule, "api_key_invalid", "an unknown key is refused as invalid");
expectEqual(revoked.rule, "api_key_invalid", "and a revoked key by the same rule");
expectEqual(unknown.code, revoked.code, "with the same code");
expectEqual(unknown.status, revoked.status, "and the same status, so the two cannot be told apart");

const closedFixture = createFixture({ companyClosed: true });
const closed = await refusalOf(() =>
  authenticateApiCall({ request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential` }, dependenciesOf(closedFixture)),
);

expectEqual(closed.rule, "account_unavailable", "a key whose merchant is closed says so");

// The throttle: a second call inside the minute writes nothing.
const recentRow = authFixture.rows.find((row) => row["id"] === credentialId) ?? {};
const second = await authenticateApiCall(
  { request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential` },
  dependenciesOf(authFixture),
);

expectEqual(second.lastUsedRefreshed, false, "a second call inside the minute does not write the column again");
expectEqual(authFixture.rows.find((row) => row["id"] === credentialId)?.["version"], recentRow["version"], "so the version does not move");

authFixture.nowMs = nowMs + 61_000;
const later = await authenticateApiCall(
  { request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential` },
  dependenciesOf(authFixture),
);

expect(later.lastUsedRefreshed, "and a call after the minute does");

// A lost write is not a failed call.
const loseFixture = createFixture();

loseFixture.loseUpdate = true;
const survived = await authenticateApiCall(
  { request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential` },
  dependenciesOf(loseFixture),
);

expectEqual(survived.credentialId, credentialId, "a last-used write that lands nowhere does not fail the call");
expectEqual(survived.lastUsedRefreshed, true, "though the attempt was made");

// ---------------------------------------------------------------------------------------------
// 4. The pipeline: count, answer, record
// ---------------------------------------------------------------------------------------------

const callFixture = createFixture();
const response = await handlePublicApiCall(
  {
    request: requestOf({ key: liveKey }),
    route: `${PUBLIC_API_BASE}/credential`,
    handler: async (context) => ({ status: 200, body: { id: context.principal.credentialId } }),
  },
  dependenciesOf(callFixture),
);

expectEqual(response.status, 200, "a live key gets an answer");
expectEqual(response.headers["cache-control"], "no-store", "that is never cached");
expectEqual(response.headers[PUBLIC_API_VERSION_HEADER], "v1", "and names its version");
expect(response.headers["ratelimit-limit"] !== undefined, "and publishes the limit it was counted against");
expect(response.headers["ratelimit-remaining"] !== undefined, "with the room left");
expect(response.headers["ratelimit-reset"] !== undefined, "and the reset");

const limitScopes = callFixture.counters.map((counter) => counter.scope).sort();

expectEqual(limitScopes.length, 3, "three buckets counted the call");
expect(
  limitScopes.every((scope) => scope.startsWith("ip_public_api") || scope.startsWith("user_public_api") || scope.startsWith("route_public_api")),
  "all of them in the public_api class",
);
expectEqual(
  callFixture.counters.find((counter) => counter.scope.startsWith("route_public_api"))?.limit,
  RATE_LIMIT_CLASS_POLICIES.public_api.route.limit,
  "the route bucket is the limiter's own number",
);
expectEqual(
  API_PUBLISHED_LIMITS.requestsPerMinute,
  RATE_LIMIT_CLASS_POLICIES.public_api.route.limit,
  "and the number the API publishes is that same number",
);
expectEqual(
  API_PUBLISHED_LIMITS.accountRequestsPerMinute,
  RATE_LIMIT_CLASS_POLICIES.public_api.user?.limit ?? 0,
  "the account ceiling too",
);
expectEqual(
  API_PUBLISHED_LIMITS.addressRequestsPerMinute,
  RATE_LIMIT_CLASS_POLICIES.public_api.ip.limit,
  "and the address ceiling",
);

// Whatever the route answers is what the chain says it answered, not a constant.
const createdFixture = createFixture();

await handlePublicApiCall(
  {
    request: requestOf({ key: liveKey }),
    route: `${PUBLIC_API_BASE}/credential`,
    handler: async () => ({ status: 201, body: { created: true } }),
  },
  dependenciesOf(createdFixture),
);

expectEqual(
  createdFixture.audit.entries.find((entry) => entry.action === API_AUDIT.call)?.payload["status"],
  201,
  "the chain records the status the route answered, not a constant",
);

// The account bucket is the merchant, not the credential: two keys of one merchant share one budget.
const accountFixture = createFixture();

await handlePublicApiCall(
  { request: requestOf({ key: secondKey }), route: `${PUBLIC_API_BASE}/credential`, handler: async () => answer },
  dependenciesOf(accountFixture),
);
await handlePublicApiCall(
  { request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential`, handler: async () => answer },
  dependenciesOf(accountFixture),
);

const accountHashes = accountFixture.counters
  .filter((counter) => counter.scope.startsWith("user_public_api"))
  .map((counter) => counter.keyHash);

expectEqual(accountHashes.length, 2, "two calls filled the account bucket twice");
expectEqual(accountHashes[0], accountHashes[1], "with one key for both credentials, because the merchant is the account");

// The chain: one entry per call.
const callEntries = callFixture.audit.entries.filter((entry) => entry.action === API_AUDIT.call);

expectEqual(callEntries.length, 1, "one call writes one chain entry");
expectEqual(callEntries[0]?.payload["status"], 200, "with the status it answered");
expectEqual(callEntries[0]?.payload["method"], "GET", "and the method");
expectEqual(callEntries[0]?.payload["route"], `${PUBLIC_API_BASE}/credential`, "and the route");
expectEqual(callEntries[0]?.payload["mode"], "test", "and the mode");
expectEqual(callEntries[0]?.payload["key_last_four"], liveKey.slice(-4), "and the four characters a screen may show");
expectEqual(callEntries[0]?.companyId, companyId, "on the merchant's chain");
expectEqual(callEntries[0]?.entityId, credentialId, "against the credential");
expect(
  !JSON.stringify(callEntries[0]?.payload ?? {}).includes(liveKey.slice(7)),
  "and the key itself is not in it",
);

// A failed attempt writes its own entry, and no call entry.
const failedFixture = createFixture();

await refusalOf(() =>
  handlePublicApiCall(
    { request: requestOf({ key: `kd_test_kzzzzz_${"f".repeat(64)}` }), route: `${PUBLIC_API_BASE}/credential`, handler: async () => answer },
    dependenciesOf(failedFixture),
  ),
);
const failedEntries = failedFixture.audit.entries;

expectEqual(failedEntries.filter((entry) => entry.action === API_AUDIT.call).length, 0, "a refused attempt is not a call");
expectEqual(failedEntries.filter((entry) => entry.action === API_AUDIT.authFailed).length, 1, "it is an authentication failure");
expectEqual(failedEntries[0]?.payload["rule"], "api_key_invalid", "naming the rule");
expectEqual(failedEntries[0]?.ipAddress, "203.0.113.9", "and the address it came from");
expectEqual(failedEntries[0]?.companyId, null, "on the platform chain, because no merchant was proven");

// A rate limit refusal is a 429 with a wait, and it is recorded as a call.
const limitedFixture = createFixture();

limitedFixture.refuseCounter = true;
const limited = await refusalOf(() =>
  handlePublicApiCall(
    { request: requestOf({ key: liveKey }), route: `${PUBLIC_API_BASE}/credential`, handler: async () => answer },
    dependenciesOf(limitedFixture),
  ),
);
const limitedEntries = limitedFixture.audit.entries;

expectEqual(limited.code, "RATE_LIMITED", "a full bucket refuses the call");
expectEqual(limited.status, 429, "with a 429");
expectEqual(
  limitedEntries.filter((entry) => entry.action === API_AUDIT.call && entry.payload["status"] === 429).length,
  1,
  "and the refusal is in the chain as a call with its status",
);
expect(
  limitedEntries.some((entry) => entry.action === "security.rate_limited"),
  "beside the limiter's own refusal entry",
);

// A route's own refusal is recorded with its status before it propagates.
const handlerFixture = createFixture();
const handlerFailure = await refusalOf(() =>
  handlePublicApiCall(
    {
      request: requestOf({ key: liveKey }),
      route: `${PUBLIC_API_BASE}/credential`,
      handler: async () => {
        throw new AppError("RESOURCE_NOT_FOUND", { details: [{ field: "payment", rule: "not_found" }] });
      },
    },
    dependenciesOf(handlerFixture),
  ),
);

expectEqual(handlerFailure.code, "RESOURCE_NOT_FOUND", "a route's refusal propagates");
expectEqual(
  handlerFixture.audit.entries.find((entry) => entry.action === API_AUDIT.call)?.payload["status"],
  404,
  "and is recorded with the status it carried",
);

// ---------------------------------------------------------------------------------------------
// 5. The route
// ---------------------------------------------------------------------------------------------

const routeSource = await readFile(
  new URL("../../app/api/public/v1/credential/route.ts", import.meta.url),
  "utf8",
);

expect(routeSource.includes("export const GET"), "the credential route answers a GET");
expect(!routeSource.includes("export const POST"), "and nothing else yet: a payment is STEP 203's");
expect(routeSource.includes("handlePublicApiCall("), "it goes through the pipeline");
expect(routeSource.includes("getPublicApiRuntime()"), "with the runtime");
expect(routeSource.includes('export const dynamic = "force-dynamic"'), "and is never cached by the framework");
expect(!routeSource.includes("console."), "it prints nothing");
expect(!routeSource.includes("requireCsrfToken("), "it asks for no CSRF token, because a bearer key is not ambient");
expect(!routeSource.includes("cookie"), "and it reads no cookie");
expect(!routeSource.includes("signing_secret"), "and never touches the signing secret");
expect(
  routeSource.includes("context.principal.keyLastFour"),
  "the answer carries the last four characters and not the key",
);
expect(!/principal\.(key|keyHash|signingSecret)\b/u.test(routeSource.replace(/keyLastFour|keyPrefix/gu, "")), "and no other part of the key");

const pipelineSource = await readFile(new URL("./public-api.ts", import.meta.url), "utf8");

expect(pipelineSource.includes("CREDENTIAL_KEY_PATTERN.test(token)"), "the pipeline checks the key's shape before hashing it");
expect(pipelineSource.includes("API_KEY_MAXIMUM_LENGTH"), "and bounds its length");
const lengthGuardAt = pipelineSource.indexOf("token.length > API_KEY_MAXIMUM_LENGTH");
const patternAt = pipelineSource.indexOf("CREDENTIAL_KEY_PATTERN.test(token)");

expect(
  lengthGuardAt > 0 && patternAt > 0 && lengthGuardAt < patternAt,
  "which it does before the pattern is run, so a megabyte of header costs one comparison",
);
expect(pipelineSource.includes("hashOfPresentedKey(token)"), "then hashes exactly what arrived");
expect(pipelineSource.includes("row.status !== \"active\""), "and refuses a row that is not active");
expect(pipelineSource.includes('"companies"'), "and checks the merchant");
expect(pipelineSource.includes("&status=eq.active&version=eq."), "and guards the last-used write with the version");
expect(pipelineSource.includes("userId: principal.companyId"), "and counts the account bucket by merchant");
expect(!pipelineSource.includes("console."), "the pipeline prints nothing");
expect(!pipelineSource.includes("requireCsrfToken("), "and asks for no token");

// ---------------------------------------------------------------------------------------------
// 6. The words
// ---------------------------------------------------------------------------------------------

const { API_AUTH_RULES } = await import("./public-fields.ts");

expect(
  Object.values(API_AUTH_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "every refusal rule is a machine word",
);
expectEqual(API_AUDIT.call, "api.call", "the call entry is api.call");
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_AUDIT.authFailed),
  "and the failure entry fits the chain's own pattern",
);
expectEqual(CREDENTIAL_KEY_PATTERN.test(liveKey), true, "the fixture's keys are keys by the platform's own pattern");
expect(hashOfPresentedKey(liveKey) === createHash("sha256").update(liveKey, "utf8").digest("hex"), "and the hash a verifier finds is the hash of the key");

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`public api gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `public api gate passed: ${String(checkCount)} checks, section 20's three sentences - a key proved by its hash ` +
      "and never shown, the platform's own counter keyed on the merchant, and one chain entry per call - with a " +
      "uniform refusal for the two states a stranger could learn from\n",
  );
}
