// path: lib/api/verify-woocommerce-connection.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import {
  createInMemoryAuditTrail,
  type AuditTrail,
  type InMemoryAuditTrail,
} from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { openSecret, sealSecret, type SecretBox } from "../auth/secrets.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { PUBLIC_API_BASE, PUBLIC_API_VERSION, PUBLIC_API_VERSION_HEADER } from "./public-fields.ts";
import { handlePublicApiCall } from "./public-api.ts";
import {
  API_WOOCOMMERCE_CONNECTION_PATH,
  API_WOOCOMMERCE_CONNECTION_ROUTE,
  STORE_CONNECTION_AUDIT,
  STORE_CONNECTION_BODY_MAXIMUM_BYTES,
  STORE_CONNECTION_COLUMNS,
  STORE_CONNECTION_DOMAIN_FIELD,
  STORE_CONNECTION_ENTITY,
  STORE_CONNECTION_OBJECT,
  STORE_CONNECTION_PLATFORM,
  STORE_CONNECTION_PLATFORMS,
  STORE_CONNECTION_RULES,
  STORE_CONNECTION_SECRET_CONTEXT_PREFIX,
  STORE_CONNECTION_STATUSES,
  STORE_CONNECTION_TABLE,
  STORE_CONNECTION_TOKEN_FIELD,
  STORE_DOMAIN_MAXIMUM_LENGTH,
  STORE_DOMAIN_PATTERN,
  STORE_EXTERNAL_ID_PREFIX,
  STORE_TOKEN_MAXIMUM_LENGTH,
  STORE_TOKEN_MINIMUM_LENGTH,
  STORE_TOKEN_PATTERN,
  storeConnectionSecretContext,
  type StoreConnectionOutcome,
} from "./store-connection-fields.ts";
import {
  connectWooCommerceStore,
  disconnectWooCommerceStore,
  parseConnectionRequest,
  parseStoreDomain,
  parseStoreToken,
  readConnectionBody,
  readWooCommerceConnection,
  storeExternalIdOf,
} from "./store-connections.ts";

/**
 * The gate for STEP 208: the WooCommerce plugin connection with credential login.
 *
 * ## What this proves
 *
 *   - **No migration.** `0035` already holds the store, its token, its state and the guard that makes a revocation final;
 *     the gate reads the migration and pins every constraint this STEP's writes have to satisfy.
 *   - **The domain is normalised and then validated.** A URL becomes its bare host; a path, a port, a query, a
 *     credential or a space is refused rather than silently reduced, because a merchant must be connected to the shop
 *     they named.
 *   - **The store's token is sealed, never read and never echoed.** The insert carries the ciphertext and its last four
 *     characters, the context binds company, platform and domain, a box sealed for another domain does not open, and no
 *     query of the service ever selects the ciphertext back.
 *   - **The three states a row can be in decide three different answers.** No row inserts and activates; an active row
 *     is answered `reused` without a write (`0035` forbids resealing a token under the same key version); a revoked row
 *     is a `409` that says installing again is not this endpoint's decision.
 *   - **Reads and disconnects are scoped and idempotent.** A status check names the domain and finds nothing of another
 *     merchant's; a disconnect revokes once and then answers the revoked row rather than an error.
 *   - **The plugin is reviewed as source.** Every PHP file refuses direct access, every handler checks the capability
 *     before the nonce, every printed value is escaped, the transport verifies TLS and follows no redirect, the token is
 *     minted with `random_bytes`, and the two secrets are stored unautoloaded and never logged.
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
  expect(
    Object.is(actual, expected),
    `${description} (expected ${String(expected)}, got ${String(actual)})`,
  );
}

interface Refusal {
  readonly code: string;
  readonly status: number;
  readonly field: string | null;
  readonly rule: string | null;
}

async function refusalOf(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) {
      return {
        code: error.code,
        status: error.status,
        field: error.details[0]?.field ?? null,
        rule: error.details[0]?.rule ?? null,
      };
    }

    return { code: "not-an-app-error", status: 0, field: null, rule: null };
  }

  return { code: "no-refusal", status: 0, field: null, rule: null };
}

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "9a000000-0000-4000-8000-000000000001";
const otherCompanyId = "9a000000-0000-4000-8000-000000000002";
const credentialId = "9b000000-0000-4000-8000-000000000001";
const presentedKey = `kd_live_woocommerce_${"1".repeat(64)}`;
const masterKey = Buffer.alloc(32, 4).toString("base64");
const startedAt = Date.parse("2026-11-07T12:00:00.000Z");
/** The host a `Request` needs; the route constant is a path, as the surface publishes it. */
const apiOrigin = "https://api.kdsolution.example";

function urlOf(pathAndQuery: string): string {
  return `${apiOrigin}${pathAndQuery}`;
}
const instantIso = new Date(startedAt).toISOString();
const storeToken = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

const ownDomain = "shop.example.com";
const revokedDomain = "closed.example.com";
const pendingDomain = "pending.example.com";
const shopifyDomain = "shopify.example.com";
const foreignDomain = "other.example.com";
const deletedDomain = "gone.example.com";

function uuidOf(suffix: number): string {
  return `0192f0a1-7c3d-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const activeId = uuidOf(1);
const revokedId = uuidOf(2);
const pendingId = uuidOf(3);
const shopifyId = uuidOf(4);
const foreignId = uuidOf(5);
const deletedId = uuidOf(6);

function boxOf(domain: string): SecretBox {
  return sealSecret(
    masterKey,
    storeToken,
    storeConnectionSecretContext({ companyId, platform: "woocommerce", storeDomain: domain }),
  );
}

function connectionRow(
  id: string,
  domain: string,
  overrides: Row = {},
): Row {
  const box = boxOf(domain);

  return {
    id,
    company_id: companyId,
    platform: "woocommerce",
    store_domain: domain,
    external_store_id: storeExternalIdOf({ companyId, platform: "woocommerce", storeDomain: domain }),
    access_token_last_four: storeToken.slice(-4),
    access_token_ciphertext: box.ciphertext,
    access_token_iv: box.iv,
    access_token_tag: box.tag,
    encryption_key_version: 1,
    status: "active",
    connected_at: instantIso,
    revoked_at: null,
    last_error: null,
    last_synced_at: null,
    created_at: instantIso,
    updated_at: instantIso,
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
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

    if (value === "is.null") {
      nulls.add(key);
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls, limit };
}

function matchesRow(row: Row, query: Query): boolean {
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

  return true;
}

interface Fixture {
  rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: { credentials: Row[]; companies: Row[]; connections: Row[] };
  readonly queries: string[];
  readonly inserts: { table: string; rows: readonly Row[] }[];
  readonly writes: { table: string; query: string; values: Row }[];
  readonly sealed: { plaintext: string; context: string }[];
  readonly counters: { scope: string; limit: number }[];
  nowMs: number;
  refuseCounter: boolean;
  failAudit: boolean;
  loseRace: "none" | "untouched" | "applied";
  conflictOnInsert: boolean;
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    credentials: [
      {
        id: credentialId,
        company_id: companyId,
        label: "Plugin key",
        mode: "live",
        status: "active",
        key_prefix: "kd_live_woocommerce_1",
        key_hash: hashOf(presentedKey),
        key_last_four: "1111",
        last_used_at: null,
        version: 1,
        deleted_at: null,
      },
    ],
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: otherCompanyId, name: "Second Store", deleted_at: null },
    ],
    connections: [
      connectionRow(activeId, ownDomain),
      connectionRow(revokedId, revokedDomain, { status: "revoked", revoked_at: instantIso }),
      connectionRow(pendingId, pendingDomain, { status: "pending", connected_at: null }),
      connectionRow(shopifyId, shopifyDomain, { platform: "shopify" }),
      connectionRow(foreignId, foreignDomain, { company_id: otherCompanyId }),
      connectionRow(deletedId, deletedDomain, { deleted_at: instantIso }),
    ],
  };
  const queries: string[] = [];
  const inserts: { table: string; rows: readonly Row[] }[] = [];
  const writes: { table: string; query: string; values: Row }[] = [];
  const sealed: { plaintext: string; context: string }[] = [];
  const counters: { scope: string; limit: number }[] = [];
  const audit = createInMemoryAuditTrail();
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    state,
    queries,
    inserts,
    writes,
    sealed,
    counters,
    nowMs: startedAt,
    refuseCounter: false,
    failAudit: false,
    loseRace: "none",
    conflictOnInsert: false,
  };

  fixture.rest = {
    async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
      queries.push(`${table}:${query}`);

      if (table === "merchant_api_credentials") {
        return schema.array().parse(
          state.credentials
            .filter((row) => row["key_hash"] === query.match(/key_hash=eq\.([0-9a-f]{64})/u)?.[1])
            .map((row) => ({ ...row })),
        );
      }

      if (table === "companies") {
        return schema.array().parse(state.companies.map((row) => ({ ...row })));
      }

      if (table !== STORE_CONNECTION_TABLE) {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const parsed = parseQuery(query);
      const selected = state.connections.filter((row) => matchesRow(row, parsed));

      return schema.array().parse(
        (parsed.limit === null ? selected : selected.slice(0, parsed.limit)).map((row) => ({ ...row })),
      );
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_inserts_returning" } });
    },

    async insertReturning<TRow>(
      table: string,
      rows: readonly Row[],
      schema: ZodType<TRow>,
    ): Promise<readonly TRow[]> {
      if (fixture.conflictOnInsert) {
        // `0035`'s unique index refusing the insert because another writer got there first.
        throw new AppError("CONFLICT");
      }

      inserts.push({ table, rows });

      const written = rows.map((row, index) => ({
        ...connectionRow(uuidOf(800 + index), String(row["store_domain"]), {
          status: String(row["status"]),
          connected_at: row["connected_at"] ?? null,
          version: 1,
        }),
        ...row,
        id: uuidOf(800 + index),
      }));

      state.connections.push(...written);

      return schema.array().parse(written.map((row) => ({ ...row })));
    },

    async update(table: string, query: string, values: Readonly<Record<string, unknown>>): Promise<void> {
      writes.push({ table, query, values: { ...values } });

      const parsed = parseQuery(query);
      const matched = state.connections.filter((row) => matchesRow(row, parsed));

      if (fixture.loseRace === "untouched") {
        // Another writer touched the row and this call's values were not applied, but the row moved on anyway.
        for (const row of matched) {
          row["version"] = Number(row["version"]) + 1;
        }

        return;
      }

      if (fixture.loseRace === "applied") {
        // The values landed, but a second writer got there too: the version is now two past the one that was read, so
        // the instant and the status alone cannot tell a landed write from a lost one.
        for (const row of matched) {
          Object.assign(row, values);
          row["version"] = Number(row["version"]) + 2;
        }

        return;
      }

      for (const row of matched) {
        Object.assign(row, values);
        row["version"] = Number(row["version"]) + 1;
      }
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_function" } });
      }

      counters.push({ scope: String(arguments_["p_scope"]), limit: Number(arguments_["p_limit"]) });

      return fixture.refuseCounter
        ? [{ allowed: false, remaining: 0, retry_after_seconds: 7, first_refusal: true }]
        : [
            {
              allowed: true,
              remaining: Number(arguments_["p_limit"]) - 1,
              retry_after_seconds: 0,
              first_refusal: false,
            },
          ];
    },
  };

  return fixture;
}

function dependenciesOf(fixture: Fixture): {
  rest: RestClient;
  audit: AuditTrail;
  now: () => number;
  seal: (plaintext: string, context: string) => SecretBox;
} {
  const audit: AuditTrail = fixture.failAudit
    ? {
        async append(): Promise<void> {
          throw new AppError("DEPENDENCY_FAILED");
        },
      }
    : fixture.audit;

  return {
    rest: fixture.rest,
    audit,
    now: (): number => fixture.nowMs,
    seal: (plaintext: string, context: string): SecretBox => {
      fixture.sealed.push({ plaintext, context });

      return sealSecret(masterKey, plaintext, context);
    },
  };
}

function principalOf(overrides: Partial<{ companyId: string; mode: "test" | "live" }> = {}): {
  credentialId: string;
  companyId: string;
  companyName: string;
  mode: "test" | "live";
  label: string;
  keyPrefix: string;
  keyLastFour: string;
  lastUsedRefreshed: boolean;
} {
  return {
    credentialId,
    companyId: overrides.companyId ?? companyId,
    companyName: "Northwind Studio",
    mode: overrides.mode ?? "live",
    label: "Plugin key",
    keyPrefix: "kd_live_woocommerce_1",
    keyLastFour: "1111",
    lastUsedRefreshed: false,
  };
}

function connectInputOf(
  domain: string,
  token: string = storeToken,
  overrides: Partial<{ companyId: string; mode: "test" | "live" }> = {},
): {
  principal: ReturnType<typeof principalOf>;
  clientAddress: string | null;
  request: { storeDomain: string; storeToken: string };
} {
  return {
    principal: principalOf(overrides),
    clientAddress: "203.0.113.7",
    request: { storeDomain: domain, storeToken: token },
  };
}

function readInputOf(
  domain: string,
  overrides: Partial<{ companyId: string }> = {},
): {
  principal: ReturnType<typeof principalOf>;
  storeDomain: string;
  clientAddress: string | null;
} {
  return {
    principal: principalOf(overrides),
    storeDomain: domain,
    clientAddress: "203.0.113.7",
  };
}

function requestOf(options: {
  readonly method?: string;
  readonly query?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
} = {}): Request {
  const query = options.query === undefined ? "" : options.query;

  const init: RequestInit = {
    method: options.method ?? "POST",
    headers: {
      "x-forwarded-for": "203.0.113.7",
      authorization: `Bearer ${presentedKey}`,
      "content-type": "application/json",
      ...options.headers,
    },
  };
  const body =
    options.method === "GET" || options.method === "DELETE"
      ? null
      : (options.body ?? JSON.stringify({ store_domain: ownDomain, store_token: storeToken }));

  return new Request(urlOf(`${API_WOOCOMMERCE_CONNECTION_PATH}${query}`), {
    ...init,
    ...(body === null ? {} : { body }),
  });
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the schema this STEP writes into
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(new URL("../../migrations", import.meta.url).pathname)).filter((name) =>
  name.endsWith(".sql"),
);
const migrationNumbers = [
  ...new Set(migrationFiles.map((name) => Number.parseInt(name.slice(0, 4), 10)).filter(Number.isFinite)),
].sort((left, right) => left - right);

expectEqual(
  migrationNumbers[migrationNumbers.length - 1] ?? 0,
  128,
  "STEP 208 adds no migration: 0035 already holds the store, its token and its state",
);

const connectionMigration = await readFile(
  new URL("../../migrations/0035_store_connections.sql", import.meta.url),
  "utf8",
);

expect(
  connectionMigration.includes("constraint store_connections_platform_check check (platform in ('shopify', 'woocommerce'))"),
  "0035's platform list is the two section 20 integrations",
);
expectEqual(
  STORE_CONNECTION_PLATFORMS.join(","),
  "shopify,woocommerce",
  "and this module's copy of it agrees",
);
expect(
  connectionMigration.includes("status in ('pending', 'active', 'revoked', 'error')"),
  "0035's four states are the four this surface reads",
);
expectEqual(STORE_CONNECTION_STATUSES.join(","), "pending,active,revoked,error", "in the schema's own order");
expect(
  connectionMigration.includes("char_length(store_domain) between 3 and 253"),
  "a store domain is between three and two hundred and fifty-three characters",
);
expect(
  connectionMigration.includes(
    "and store_domain = lower(store_domain)",
  ),
  "and is stored lower case",
);
expect(
  connectionMigration.includes(
    "and store_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'",
  ),
  "with the pattern this STEP's validator repeats",
);
expect(
  connectionMigration.includes("constraint store_connections_active_check check (\n    status <> 'active' or connected_at is not null"),
  "an active row requires the instant the store answered",
);
expect(
  connectionMigration.includes("constraint store_connections_pending_check check (\n    status <> 'pending' or connected_at is null"),
  "and a pending one forbids it",
);
expect(
  connectionMigration.includes("constraint store_connections_revoked_check check (\n    (status = 'revoked') = (revoked_at is not null)"),
  "a revoked row carries its instant exactly",
);
expect(
  connectionMigration.includes("if old.status = 'revoked' and new.status is distinct from old.status then"),
  "the guard refuses a revoked connection that comes back, which is why this endpoint answers 409",
);
expect(
  connectionMigration.includes(
    "if (new.access_token_ciphertext is distinct from old.access_token_ciphertext",
  ),
  "and refuses a token resealed under the same key version, which is why an active row is never rewritten",
);
expect(
  connectionMigration.includes(
    "and new.encryption_key_version <= old.encryption_key_version then\n" +
      "    raise exception 'a store token is re-encrypted only under a new key version'",
  ),
  "the reseal guard is the key version's, in the migration's own words",
);
expect(
  connectionMigration.includes("raise exception 'a store connection keeps its store'"),
  "and a row cannot be moved to another store",
);
expect(
  connectionMigration.includes("create unique index store_connections_domain_key"),
  "one live row per merchant, platform and domain",
);
expect(
  connectionMigration.includes("'The only characters of the store token a screen may show.'"),
  "and the tail is the only part of the token a screen may show, in the migration's own words",
);

// ---------------------------------------------------------------------------------------------
// 2. The route: one resource, three verbs
// ---------------------------------------------------------------------------------------------

const routeSource = await readFile(
  new URL("../../app/api/public/v1/stores/woocommerce/connection/route.ts", import.meta.url),
  "utf8",
);
const serviceSource = await readFile(new URL("./store-connections.ts", import.meta.url), "utf8");
const fieldsSource = await readFile(new URL("./store-connection-fields.ts", import.meta.url), "utf8");

expect(
  fieldsSource.includes("export const API_WOOCOMMERCE_CONNECTION_PATH"),
  "the resource's path is a constant of the vocabulary module",
);

expectEqual(
  API_WOOCOMMERCE_CONNECTION_PATH,
  `${PUBLIC_API_BASE}/stores/woocommerce/connection`,
  "the resource lives under the public API's version root",
);
expectEqual(
  API_WOOCOMMERCE_CONNECTION_ROUTE,
  API_WOOCOMMERCE_CONNECTION_PATH,
  "and its route has no parameter, so the template and the path are the same string",
);
expect(routeSource.includes("export const POST"), "the route exports POST");
expect(routeSource.includes("export const GET"), "and GET");
expect(routeSource.includes("export const DELETE"), "and DELETE, which is the plugin's disconnect");
expect(!routeSource.includes("export const PUT"), "and no PUT");
expect(!routeSource.includes("export const PATCH"), "and no PATCH");
expect(routeSource.includes("force-dynamic"), "the route is dynamic");
expect(
  routeSource.includes("const route = API_WOOCOMMERCE_CONNECTION_ROUTE;"),
  "and it records the constant rather than a second copy of the path",
);
expect(routeSource.includes("handlePublicApiCall"), "every verb goes through the pipeline that authenticates and counts");
expectEqual(
  (routeSource.match(/route,/gu) ?? []).length,
  3,
  "each of the three handlers passes the route constant",
);
expect(
  (routeSource.match(/clientAddress: readClientAddress\(call\.request\.headers\)/gu) ?? []).length === 3,
  "and the caller's address",
);
expect(routeSource.includes("store_domain"), "the status and disconnect verbs read the domain from the query");
expect(!routeSource.includes("cookie"), "no cookie, because a key is not a session");
expect(!routeSource.includes("csrf"), "no CSRF token, for the same reason");
expect(!routeSource.includes("console."), "and nothing printed");

// ---------------------------------------------------------------------------------------------
// 3. The domain: normalised, then validated
// ---------------------------------------------------------------------------------------------

for (const [value, expected, description] of [
  ["shop.example.com", "shop.example.com", "a bare domain"],
  ["Shop.Example.COM", "shop.example.com", "an upper case one is lowered, because 0035 stores it lower case"],
  ["https://shop.example.com", "shop.example.com", "a URL loses its scheme"],
  ["http://shop.example.com/", "shop.example.com", "and a trailing slash"],
  [" shop.example.com ", "shop.example.com", "surrounding space is trimmed"],
  ["shop-with-dashes.example.co.uk", "shop-with-dashes.example.co.uk", "dashes and several labels"],
  ["a1.example.com", "a1.example.com", "digits"],
] as readonly [string, string, string][]) {
  expectEqual(parseStoreDomain(value), expected, `${description} is accepted and normalised`);
}

for (const [value, rule, description] of [
  ["", STORE_CONNECTION_RULES.domainMissing, "an empty domain"],
  ["   ", STORE_CONNECTION_RULES.domainMissing, "a blank domain"],
  [null, STORE_CONNECTION_RULES.domainMissing, "a missing domain"],
  [7, STORE_CONNECTION_RULES.domainMissing, "a number"],
  ["https://shop.example.com/store", STORE_CONNECTION_RULES.domainNotBare, "a path"],
  ["shop.example.com:8080", STORE_CONNECTION_RULES.domainNotBare, "a port"],
  ["shop.example.com?x=1", STORE_CONNECTION_RULES.domainNotBare, "a query"],
  ["shop.example.com#top", STORE_CONNECTION_RULES.domainNotBare, "a fragment"],
  ["user:pass@shop.example.com", STORE_CONNECTION_RULES.domainNotBare, "credentials in the URL"],
  ["shop example.com", STORE_CONNECTION_RULES.domainNotBare, "a space inside"],
  ["localhost", STORE_CONNECTION_RULES.domainInvalid, "one label with no dot"],
  ["-shop.example.com", STORE_CONNECTION_RULES.domainInvalid, "a label that starts with a dash"],
  ["shop..example.com", STORE_CONNECTION_RULES.domainInvalid, "an empty label"],
  [`${"a".repeat(STORE_DOMAIN_MAXIMUM_LENGTH + 1)}.com`, STORE_CONNECTION_RULES.domainInvalid, "a domain past the ceiling"],
] as readonly [unknown, string, string][]) {
  const refusal = await refusalOf(async () => parseStoreDomain(value));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.field, STORE_CONNECTION_DOMAIN_FIELD, `${description}: naming store_domain`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

expect(STORE_DOMAIN_PATTERN.test(ownDomain), "the pattern accepts a store domain");
expect(!STORE_DOMAIN_PATTERN.test("Shop.example.com"), "and refuses an upper case one, which is why the domain is lowered first");

// ---------------------------------------------------------------------------------------------
// 4. The token
// ---------------------------------------------------------------------------------------------

expectEqual(parseStoreToken(storeToken), storeToken, "a sixty-four character hex token is accepted");
expectEqual(
  parseStoreToken(`  ${storeToken}  `),
  storeToken,
  "and surrounding space is trimmed rather than refused",
);
expect(
  !STORE_TOKEN_PATTERN.test(`${"a".repeat(43)}=`),
  "base64 padding is outside the alphabet, so the plugin's own unpadded encoding is what the pattern describes",
);
expect(
  STORE_TOKEN_PATTERN.test("A".repeat(32)) && STORE_TOKEN_PATTERN.test(`${"a-b_".repeat(8)}`),
  "the pattern accepts both alphabets a plugin may mint",
);
expectEqual(STORE_TOKEN_MINIMUM_LENGTH, 32, "thirty-two characters is the floor, pinned");
expectEqual(STORE_TOKEN_MAXIMUM_LENGTH, 128, "and a hundred and twenty-eight the ceiling");
expect(
  STORE_TOKEN_PATTERN.source.includes(`{${String(STORE_TOKEN_MINIMUM_LENGTH)},${String(STORE_TOKEN_MAXIMUM_LENGTH)}}`),
  "which is the quantifier the pattern itself carries, so the two cannot drift",
);

for (const [value, rule, description] of [
  ["", STORE_CONNECTION_RULES.tokenMissing, "an empty token"],
  ["  ", STORE_CONNECTION_RULES.tokenMissing, "a blank token"],
  [null, STORE_CONNECTION_RULES.tokenMissing, "a missing token"],
  ["a".repeat(31), STORE_CONNECTION_RULES.tokenInvalid, "a token one character short"],
  ["a".repeat(STORE_TOKEN_MAXIMUM_LENGTH + 1), STORE_CONNECTION_RULES.tokenInvalid, "a token past the ceiling"],
  [`${"a".repeat(32)}!`, STORE_CONNECTION_RULES.tokenInvalid, "a token with a character outside the alphabet"],
  [`${"a".repeat(20)} ${"b".repeat(20)}`, STORE_CONNECTION_RULES.tokenInvalid, "a token with a space"],
] as readonly [unknown, string, string][]) {
  const refusal = await refusalOf(async () => parseStoreToken(value));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.field, STORE_CONNECTION_TOKEN_FIELD, `${description}: naming store_token`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

// ---------------------------------------------------------------------------------------------
// 5. The body
// ---------------------------------------------------------------------------------------------

const parsedRequest = parseConnectionRequest({ store_domain: `https://${ownDomain}/`, store_token: storeToken });

expectEqual(parsedRequest.storeDomain, ownDomain, "the body's domain is normalised like any other");
expectEqual(parsedRequest.storeToken, storeToken, "and its token is kept exactly");

for (const [body, rule, field, description] of [
  [{}, STORE_CONNECTION_RULES.domainMissing, STORE_CONNECTION_DOMAIN_FIELD, "an empty object"],
  [{ store_token: storeToken }, STORE_CONNECTION_RULES.domainMissing, STORE_CONNECTION_DOMAIN_FIELD, "a body with no domain"],
  [{ store_domain: ownDomain }, STORE_CONNECTION_RULES.tokenMissing, STORE_CONNECTION_TOKEN_FIELD, "a body with no token"],
  [[ownDomain, storeToken], STORE_CONNECTION_RULES.bodyMalformed, "body", "an array"],
  [null, STORE_CONNECTION_RULES.bodyMalformed, "body", "null"],
  ["a string", STORE_CONNECTION_RULES.bodyMalformed, "body", "a bare string"],
  [
    { store_domain: ownDomain, store_token: storeToken, status: "active" },
    STORE_CONNECTION_RULES.unknownField,
    "status",
    "a body that tries to set the status",
  ],
  [
    { store_domain: ownDomain, store_token: storeToken, external_store_id: "sc_x" },
    STORE_CONNECTION_RULES.unknownField,
    "external_store_id",
    "a body that tries to choose the store's identifier",
  ],
] as readonly [unknown, string, string, string][]) {
  const refusal = await refusalOf(async () => parseConnectionRequest(body));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.field, field, `${description}: naming the field`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

const malformedBody = await refusalOf(async () =>
  readConnectionBody(
    new Request(urlOf(API_WOOCOMMERCE_CONNECTION_PATH), { method: "POST", body: "{not json" }),
  ),
);

expectEqual(malformedBody.code, "VALIDATION_FAILED", "a body that is not JSON is refused");
expectEqual(malformedBody.rule, STORE_CONNECTION_RULES.bodyMalformed, "as malformed");

const declaredTooLarge = await refusalOf(async () =>
  readConnectionBody(
    new Request(urlOf(API_WOOCOMMERCE_CONNECTION_PATH), {
      method: "POST",
      headers: { "content-length": String(STORE_CONNECTION_BODY_MAXIMUM_BYTES + 1) },
      body: "{}",
    }),
  ),
);

expectEqual(declaredTooLarge.code, "PAYLOAD_TOO_LARGE", "a declared length past the ceiling is refused");
expectEqual(declaredTooLarge.status, 413, "with 413");
expectEqual(declaredTooLarge.rule, STORE_CONNECTION_RULES.bodyTooLarge, "as too large");

const actualTooLarge = await refusalOf(async () =>
  readConnectionBody(
    new Request(urlOf(API_WOOCOMMERCE_CONNECTION_PATH), {
      method: "POST",
      body: `{"store_domain":"${"a".repeat(STORE_CONNECTION_BODY_MAXIMUM_BYTES)}"}`,
    }),
  ),
);

expectEqual(actualTooLarge.code, "PAYLOAD_TOO_LARGE", "an undeclared body is counted as it is read");
expectEqual(STORE_CONNECTION_BODY_MAXIMUM_BYTES, 2_048, "and the ceiling is two kilobytes");

// ---------------------------------------------------------------------------------------------
// 6. The install: one row, sealed, active
// ---------------------------------------------------------------------------------------------

const installFixture = createFixture();
const installed: StoreConnectionOutcome = await connectWooCommerceStore(
  connectInputOf("new-shop.example.com"),
  dependenciesOf(installFixture),
);

expectEqual(installed.status, 200, "a first connect answers 200");
expectEqual(installed.reused, false, "and is not a reuse");
expectEqual(installed.mode, "live", "the key's mode travels with the answer");
expectEqual(installed.body.status, "active", "the connection is active, as section 20 says it becomes automatically");
expectEqual(installed.body.platform, "woocommerce", "on this platform");
expectEqual(installed.body.store_domain, "new-shop.example.com", "for the domain that asked");
expectEqual(installed.body.connected_at, instantIso, "connected at the platform's own instant");
expectEqual(installed.body.object, "store_connection", "and named as a store connection, pinned against its literal");
expectEqual(STORE_CONNECTION_OBJECT, STORE_CONNECTION_ENTITY, "the object and the chain entity are the same name");
expectEqual(installed.body.store_token_last_four, storeToken.slice(-4), "with the token's last four characters");
expectEqual(
  installed.body.external_store_id,
  `sc_${createHash("sha256")
    .update(`${companyId}|woocommerce|new-shop.example.com`, "utf8")
    .digest("hex")
    .slice(0, 32)}`,
  "and the identifier the platform gave the store, which is the first thirty-two hex characters of the identity's SHA-256",
);
expect(
  new RegExp(`^${STORE_EXTERNAL_ID_PREFIX}[0-9a-f]{32}$`, "u").test(String(installed.body.external_store_id)),
  "which has the shape a plugin can display",
);
expectEqual(STORE_EXTERNAL_ID_PREFIX, "sc_", "prefixed as the store connection it names");

expectEqual(installFixture.inserts.length, 1, "one insert, and only one");
expectEqual(installFixture.inserts[0]?.table, STORE_CONNECTION_TABLE, "into the connection table");
expectEqual(installFixture.inserts[0]?.rows.length, 1, "one row");

const insertedRow = installFixture.inserts[0]?.rows[0] ?? {};

expectEqual(insertedRow["company_id"], companyId, "the row belongs to the company the key proved");
expectEqual(insertedRow["platform"], STORE_CONNECTION_PLATFORM, "the platform is this STEP's");
expectEqual(insertedRow["store_domain"], "new-shop.example.com", "the domain is the normalised one");
expectEqual(insertedRow["status"], "active", "the row is active");
expectEqual(insertedRow["connected_at"], instantIso, "with its instant");
expectEqual(insertedRow["revoked_at"], null, "and no revocation");
expectEqual(insertedRow["last_error"], null, "and no error");
expectEqual(insertedRow["encryption_key_version"], 1, "sealed under the current key version");
expectEqual(
  insertedRow["access_token_last_four"],
  storeToken.slice(-4),
  "the tail is the token's last four characters",
);
expect(
  typeof insertedRow["access_token_ciphertext"] === "string" &&
    String(insertedRow["access_token_ciphertext"]).length >= 16,
  "the ciphertext is a box",
);
expect(
  !JSON.stringify(insertedRow).includes(storeToken),
  "and the plaintext token is nowhere in the row that is written",
);
expect(
  installFixture.sealed.length === 1 && installFixture.sealed[0]?.plaintext === storeToken,
  "the token was sealed once, by the runtime's sealer",
);
expectEqual(
  installFixture.sealed[0]?.context,
  storeConnectionSecretContext({
    companyId,
    platform: "woocommerce",
    storeDomain: "new-shop.example.com",
  }),
  "under an associated data that names the merchant, the platform and the domain",
);
expect(
  STORE_CONNECTION_SECRET_CONTEXT_PREFIX.startsWith("kd-aad-v1|"),
  "the context carries the platform's associated-data version, so a future one is a different fence",
);
expectEqual(
  storeConnectionSecretContext({
    companyId,
    platform: "woocommerce",
    storeDomain: "new-shop.example.com",
  }),
  `kd-aad-v1|store_connection|${companyId}|woocommerce|new-shop.example.com`,
  "and its three facts are spliced in that order, pinned against a literal rather than against itself",
);

const sealedBox = sealSecret(
  masterKey,
  storeToken,
  storeConnectionSecretContext({
    companyId,
    platform: "woocommerce",
    storeDomain: "new-shop.example.com",
  }),
);

expectEqual(
  openSecret(
    masterKey,
    sealedBox,
    storeConnectionSecretContext({
      companyId,
      platform: "woocommerce",
      storeDomain: "new-shop.example.com",
    }),
  ),
  storeToken,
  "the box opens under its own context",
);
expect(
  await refusalOf(async () =>
    openSecret(
      masterKey,
      sealedBox,
      storeConnectionSecretContext({
        companyId,
        platform: "woocommerce",
        storeDomain: "another-shop.example.com",
      }),
    ),
  ).then((refusal) => refusal.code !== "no-refusal"),
  "and does not open under another store's context, which is what the domain in the context buys",
);

expectEqual(installFixture.writes.length, 0, "an install writes nothing but the insert");

// ---------------------------------------------------------------------------------------------
// 7. The three states a row can already be in
// ---------------------------------------------------------------------------------------------

const reuseFixture = createFixture();
const reused = await connectWooCommerceStore(connectInputOf(ownDomain), dependenciesOf(reuseFixture));

expectEqual(reused.status, 200, "connecting an active store again answers 200");
expectEqual(reused.reused, true, "and says the connection already stood");
expectEqual(reused.body.id, activeId, "answering the row that exists");
expectEqual(reuseFixture.writes.length, 0, "without writing anything");
expectEqual(reuseFixture.inserts.length, 0, "and without a second row");
expectEqual(
  reuseFixture.audit.entries.filter((entry) => entry.action === STORE_CONNECTION_AUDIT.activated).length,
  1,
  "the call is still recorded",
);
expectEqual(
  reuseFixture.audit.entries.find((entry) => entry.action === STORE_CONNECTION_AUDIT.activated)?.payload["reused"],
  true,
  "with the reuse it answered",
);

const revokedFixture = createFixture();
const revokedRefusal = await refusalOf(async () =>
  connectWooCommerceStore(connectInputOf(revokedDomain), dependenciesOf(revokedFixture)),
);

expectEqual(revokedRefusal.code, "CONFLICT", "a revoked connection is a conflict, not a validation error");
expectEqual(revokedRefusal.status, 409, "with 409");
expectEqual(revokedRefusal.field, "connection", "naming the connection");
expectEqual(revokedRefusal.rule, STORE_CONNECTION_RULES.connectionRevoked, "with the rule the plugin translates");
expectEqual(revokedFixture.writes.length, 0, "and nothing written");
expectEqual(revokedFixture.inserts.length, 0, "and no new row attempted");
expectEqual(
  revokedFixture.audit.entries[0]?.action,
  STORE_CONNECTION_AUDIT.refused,
  "the refusal is in the chain",
);
expectEqual(
  revokedFixture.audit.entries[0]?.ipAddress,
  "203.0.113.7",
  "with the address the call came from",
);

const pendingFixture = createFixture();
const activated = await connectWooCommerceStore(
  connectInputOf(pendingDomain),
  dependenciesOf(pendingFixture),
);

expectEqual(activated.status, 200, "a pending row is activated in place");
expectEqual(activated.body.id, pendingId, "the same row");
expectEqual(activated.body.status, "active", "now active");
expectEqual(activated.body.connected_at, instantIso, "with the instant the platform set");
expectEqual(pendingFixture.inserts.length, 0, "and no second row");
expectEqual(pendingFixture.writes.length, 1, "one write");
expectEqual(
  Object.keys(pendingFixture.writes[0]?.values ?? {}).sort().join(","),
  "connected_at,last_error,status",
  "which sets the state and clears any error, and never touches the sealed token",
);
expect(
  pendingFixture.writes[0]?.query.includes("version=eq.1") ?? false,
  "guarded by the version that was read",
);
expect(
  pendingFixture.writes[0]?.query.includes(`company_id=eq.${companyId}`) ?? false,
  "and by the tenant",
);
expect(
  pendingFixture.writes[0]?.query.includes("platform=eq.woocommerce") ?? false,
  "and by the platform",
);

const raceFixture = createFixture();

raceFixture.loseRace = "untouched";

const raceRefusal = await refusalOf(async () =>
  connectWooCommerceStore(connectInputOf(pendingDomain), dependenciesOf(raceFixture)),
);

expectEqual(raceRefusal.code, "CONFLICT", "a write that lost the compare-and-set is a conflict");
expectEqual(raceRefusal.rule, STORE_CONNECTION_RULES.writeNotApplied, "with the rule for a write that did not land");

const mismatchFixture = createFixture();
const mismatchRefusal = await refusalOf(async () =>
  connectWooCommerceStore(
    connectInputOf(ownDomain, "f".repeat(60) + "abcd"),
    dependenciesOf(mismatchFixture),
  ),
);

expectEqual(mismatchRefusal.code, "CONFLICT", "a store presenting a different token to an active connection is a conflict");
expectEqual(mismatchRefusal.status, 409, "with 409");
expectEqual(
  mismatchRefusal.rule,
  STORE_CONNECTION_RULES.connectionTokenMismatch,
  "and the rule that says the store's own token is not the sealed one",
);
expectEqual(mismatchFixture.writes.length, 0, "nothing is written");
expectEqual(
  mismatchFixture.audit.entries[0]?.payload["rule"],
  STORE_CONNECTION_RULES.connectionTokenMismatch,
  "and the refusal names that rule in the chain",
);

const sameTailFixture = createFixture();
const sameTail = await connectWooCommerceStore(
  connectInputOf(ownDomain, "b".repeat(60) + storeToken.slice(-4)),
  dependenciesOf(sameTailFixture),
);

expectEqual(
  sameTail.reused,
  true,
  "a token that agrees on its tail is the connection that stands, because the tail is the only part a read answers",
);

const raceInstallFixture = createFixture();

raceInstallFixture.conflictOnInsert = true;

const concurrent = await connectWooCommerceStore(
  connectInputOf(ownDomain, storeToken, {}),
  dependenciesOf(raceInstallFixture),
);

expectEqual(concurrent.status, 200, "an insert refused by the unique index answers 200");
expectEqual(concurrent.reused, true, "because the row that won is the connection");
expectEqual(concurrent.body.id, activeId, "answering the row that won");
expectEqual(
  raceInstallFixture.audit.entries[0]?.payload["reused"],
  true,
  "and the chain says the call found it rather than wrote it",
);

const concurrentRevokedFixture = createFixture();

concurrentRevokedFixture.conflictOnInsert = true;

const concurrentRevoked = await refusalOf(async () =>
  connectWooCommerceStore(connectInputOf(revokedDomain), dependenciesOf(concurrentRevokedFixture)),
);

expectEqual(concurrentRevoked.code, "CONFLICT", "a race lost to a revoked row is still a conflict");
expectEqual(
  concurrentRevoked.rule,
  STORE_CONNECTION_RULES.connectionRevoked,
  "with the revocation rule rather than a generic write failure",
);

const concurrentMismatchFixture = createFixture();

concurrentMismatchFixture.conflictOnInsert = true;

const concurrentMismatch = await refusalOf(async () =>
  connectWooCommerceStore(
    connectInputOf(ownDomain, "c".repeat(60) + "wxyz"),
    dependenciesOf(concurrentMismatchFixture),
  ),
);

expectEqual(
  concurrentMismatch.rule,
  STORE_CONNECTION_RULES.connectionTokenMismatch,
  "and a race lost to a row holding another token is a token mismatch",
);

const doubleWriteFixture = createFixture();

doubleWriteFixture.loseRace = "applied";

const doubleWriteRefusal = await refusalOf(async () =>
  connectWooCommerceStore(connectInputOf(pendingDomain), dependenciesOf(doubleWriteFixture)),
);

expectEqual(
  doubleWriteRefusal.rule,
  STORE_CONNECTION_RULES.writeNotApplied,
  "a write whose version moved by more than one is refused, so the read-back proves this call's write landed",
);

// ---------------------------------------------------------------------------------------------
// 8. Reading the connection
// ---------------------------------------------------------------------------------------------

const readFixture = createFixture();
const read = await readWooCommerceConnection(readInputOf(ownDomain), dependenciesOf(readFixture));
const readQuery = readFixture.queries.find((query) => query.startsWith(`${STORE_CONNECTION_TABLE}:`)) ?? "";

expectEqual(read.id, activeId, "a status check answers the connection of that domain");
expectEqual(read.status, "active", "with its state");
expect(
  readQuery.includes(`${STORE_CONNECTION_DOMAIN_FIELD}=eq.${ownDomain}`),
  "the query narrows on the domain",
);
expect(readQuery.includes(`company_id=eq.${companyId}`), "and on the tenant");
expect(readQuery.includes("platform=eq.woocommerce"), "and on the platform");
expect(readQuery.includes("deleted_at=is.null"), "and on a living row");
expect(readQuery.endsWith("&limit=1"), "one row at most, and the query says so at its end");
expect(
  readQuery.includes(`select=${STORE_CONNECTION_COLUMNS}`),
  "selecting the column list this module names",
);
expect(!readQuery.includes("access_token_ciphertext"), "which never carries the ciphertext");
expect(!readQuery.includes("access_token_iv"), "nor the iv");
expect(!readQuery.includes("access_token_tag"), "nor the tag");
expect(!readQuery.includes("select=*"), "and never a star");

for (const [domain, description] of [
  ["unknown.example.com", "a domain with no connection"],
  [foreignDomain, "another merchant's domain"],
  [shopifyDomain, "a Shopify connection, which this endpoint does not answer for"],
  [deletedDomain, "a deleted connection"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    readWooCommerceConnection(readInputOf(domain), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "RESOURCE_NOT_FOUND", `${description} answers not found`);
  expectEqual(refusal.status, 404, `${description}: with 404`);
  expectEqual(refusal.rule, STORE_CONNECTION_RULES.notConnected, `${description}: with the not-connected rule`);
  expectEqual(
    fixture.audit.entries[0]?.action,
    STORE_CONNECTION_AUDIT.refused,
    `${description}: and the refusal is recorded`,
  );
}

const revokedReadFixture = createFixture();
const revokedRead = await readWooCommerceConnection(
  readInputOf(revokedDomain),
  dependenciesOf(revokedReadFixture),
);

expectEqual(
  revokedRead.status,
  "revoked",
  "a revoked connection is still readable, because a plugin must be able to see why nothing works",
);

// ---------------------------------------------------------------------------------------------
// 9. Disconnecting
// ---------------------------------------------------------------------------------------------

const disconnectFixture = createFixture();
const disconnected = await disconnectWooCommerceStore(
  readInputOf(ownDomain),
  dependenciesOf(disconnectFixture),
);

expectEqual(disconnected.status, "revoked", "a disconnect revokes");
expectEqual(disconnected.id, activeId, "the row it found");
expectEqual(disconnectFixture.writes.length, 1, "one write");
expectEqual(
  Object.keys(disconnectFixture.writes[0]?.values ?? {}).sort().join(","),
  "last_error,revoked_at,status",
  "setting the revocation and nothing else",
);
expectEqual(
  disconnectFixture.writes[0]?.values["revoked_at"],
  instantIso,
  "at the platform's instant",
);
expectEqual(
  disconnectFixture.audit.entries[0]?.action,
  STORE_CONNECTION_AUDIT.revoked,
  "the revocation is in the chain",
);
expectEqual(
  disconnectFixture.audit.entries[0]?.entityId,
  activeId,
  "naming the connection",
);
expect(
  !JSON.stringify(disconnectFixture.audit.entries).includes(storeToken),
  "and never the token",
);

const twiceFixture = createFixture();
const twice = await disconnectWooCommerceStore(readInputOf(revokedDomain), dependenciesOf(twiceFixture));

expectEqual(twice.status, "revoked", "disconnecting twice answers the revoked row");
expectEqual(twiceFixture.writes.length, 0, "without a second write");
expectEqual(twiceFixture.audit.entries.length, 0, "and without a second chain entry");

const nothingFixture = createFixture();
const nothingRefusal = await refusalOf(async () =>
  disconnectWooCommerceStore(readInputOf("unknown.example.com"), dependenciesOf(nothingFixture)),
);

expectEqual(nothingRefusal.code, "RESOURCE_NOT_FOUND", "disconnecting a store that is not connected is a 404");
expectEqual(nothingRefusal.rule, STORE_CONNECTION_RULES.notConnected, "with the not-connected rule");

// ---------------------------------------------------------------------------------------------
// 10. The answer never carries the secret
// ---------------------------------------------------------------------------------------------

const viewKeys = Object.keys(installed.body).sort();

expectEqual(
  viewKeys.join(","),
  [
    "connected_at",
    "created_at",
    "external_store_id",
    "id",
    "mode",
    "object",
    "platform",
    "reused",
    "status",
    "store_domain",
    "store_token_last_four",
    "updated_at",
  ].join(","),
  "the connect answer carries twelve fields",
);
expectEqual(
  Object.keys(read).sort().join(","),
  viewKeys.filter((key) => key !== "mode" && key !== "reused").join(","),
  "and the status answer the same ten, without the two a handshake alone has",
);
expect(
  !JSON.stringify(installed.body).includes(storeToken),
  "no answer carries the token",
);
expect(
  !JSON.stringify(installed.body).includes("ciphertext"),
  "nor any part of the box",
);
expect(
  !JSON.stringify(installed.body).includes(String(insertedRow["access_token_ciphertext"])),
  "nor its ciphertext value",
);

// ---------------------------------------------------------------------------------------------
// 11. Through the pipeline
// ---------------------------------------------------------------------------------------------

const pipelineFixture = createFixture();

const pipelineAnswer = await handlePublicApiCall(
  {
    request: requestOf(),
    route: API_WOOCOMMERCE_CONNECTION_ROUTE,
    handler: async (call) => {
      const body = await readConnectionBody(call.request);
      const outcome = await connectWooCommerceStore(
        {
          principal: call.principal,
          clientAddress: "203.0.113.7",
          request: parseConnectionRequest(body),
        },
        dependenciesOf(pipelineFixture),
      );

      return { status: outcome.status, body: outcome.body };
    },
  },
  dependenciesOf(pipelineFixture),
);

expectEqual(pipelineAnswer.status, 200, "through the pipeline a connect answers 200");
expectEqual(
  pipelineAnswer.headers[PUBLIC_API_VERSION_HEADER],
  PUBLIC_API_VERSION,
  "with the version the surface publishes",
);
expectEqual(pipelineAnswer.headers["cache-control"], "no-store", "and no cache");
expectEqual(pipelineFixture.counters.length, 3, "three counters");
expectEqual(
  pipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "one call entry",
);
expectEqual(
  pipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["route"],
  API_WOOCOMMERCE_CONNECTION_ROUTE,
  "recorded under the resource's route",
);

const noKeyRefusal = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: new Request(urlOf(API_WOOCOMMERCE_CONNECTION_PATH), { method: "POST" }),
      route: API_WOOCOMMERCE_CONNECTION_ROUTE,
      handler: async () => ({ status: 200, body: {} }),
    },
    dependenciesOf(createFixture()),
  ),
);

expectEqual(noKeyRefusal.code, "AUTHENTICATION_REQUIRED", "a call with no key never reaches a handler");
expectEqual(noKeyRefusal.status, 401, "and is answered 401");

const deafFixture = createFixture();

deafFixture.failAudit = true;

const deafOutcome = await refusalOf(async () =>
  connectWooCommerceStore(connectInputOf("deaf.example.com"), dependenciesOf(deafFixture)),
);

expectEqual(deafOutcome.code, "no-refusal", "a chain that cannot be written does not refuse a connection");
expectEqual(deafFixture.inserts.length, 1, "the row is written anyway");

// ---------------------------------------------------------------------------------------------
// 12. The chain
// ---------------------------------------------------------------------------------------------

const activationEntry = installFixture.audit.entries.find(
  (entry) => entry.action === STORE_CONNECTION_AUDIT.activated,
);

expect(
  activationEntry !== undefined,
  "an activation writes one entry",
);
expectEqual(activationEntry?.entityType, STORE_CONNECTION_ENTITY, "naming a store connection");
expectEqual(activationEntry?.actorUserId, null, "with no human actor, because a plugin's key made the call");
expectEqual(activationEntry?.companyId, companyId, "on the merchant's own chain");
expectEqual(activationEntry?.ipAddress, "203.0.113.7", "with the address the call came from");
expectEqual(activationEntry?.payload["platform"], "woocommerce", "the platform");
expectEqual(activationEntry?.payload["store_domain"], "new-shop.example.com", "the store");
expectEqual(activationEntry?.payload["status"], "active", "the state it reached");
expectEqual(activationEntry?.payload["reused"], false, "and that this call was the one that wrote it");
expectEqual(activationEntry?.payload["mode"], "live", "in the key's mode");
expectEqual(activationEntry?.payload["credential_id"], credentialId, "naming the key");
expectEqual(
  activationEntry?.payload["store_token_last_four"],
  storeToken.slice(-4),
  "and repeating only the token's tail",
);
expect(
  !JSON.stringify(activationEntry).includes(storeToken),
  "never the token itself",
);
expect(
  !JSON.stringify(activationEntry).includes(presentedKey),
  "nor the API key that authenticated the call",
);

for (const action of Object.values(STORE_CONNECTION_AUDIT)) {
  expect(
    /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(action),
    `${action} fits the chain's dotted action pattern`,
  );
}

for (const rule of Object.values(STORE_CONNECTION_RULES)) {
  expect(/^[a-z][a-z0-9_]*$/u.test(rule), `${rule} is a machine word`);
}

expectEqual(
  STORE_CONNECTION_AUDIT.activated,
  "api.store_connection_activated",
  "the activation action, pinned",
);
expectEqual(STORE_CONNECTION_AUDIT.revoked, "api.store_connection_revoked", "the revocation action, pinned");
expectEqual(STORE_CONNECTION_AUDIT.refused, "api.store_connection_refused", "and the refusal action");
expectEqual(STORE_CONNECTION_RULES.connectionRevoked, "connection_revoked", "the revoked rule, pinned");
expectEqual(STORE_CONNECTION_RULES.notConnected, "not_connected", "the not-connected rule, pinned");
expectEqual(STORE_CONNECTION_RULES.domainNotBare, "store_domain_not_bare", "the not-bare rule, pinned");
expectEqual(STORE_CONNECTION_RULES.tokenInvalid, "store_token_invalid", "and the token rule, pinned");
expectEqual(STORE_CONNECTION_PLATFORM, "woocommerce", "the platform constant");
expectEqual(STORE_CONNECTION_ENTITY, "store_connection", "the entity, which the table's name already states");
expectEqual(
  (serviceSource.match(/access_token_ciphertext/gu) ?? []).length,
  1,
  "the service names the ciphertext column exactly once, in the insert, and never in a read",
);
expect(
  !serviceSource.includes("access_token_iv&") && !serviceSource.includes("access_token_tag&"),
  "and no query of it appends the box's iv or tag",
);

// ---------------------------------------------------------------------------------------------
// 13. The plugin: every file, every rule
// ---------------------------------------------------------------------------------------------

const pluginRoot = new URL("../../plugins/woocommerce/kd-payments/", import.meta.url);
const ownFiles = [
  "kd-payments.php",
  "includes/class-kd-api-client.php",
  "includes/class-kd-connection.php",
  "includes/class-kd-settings.php",
];
/**
 * Every PHP file in the package, listed rather than typed out.
 *
 * The four files below are the ones this STEP wrote, and they are asserted to exist. The safety loop that follows,
 * however, runs over **everything in the directory**: a later STEP adds files to this package (STEP 209 added two), and
 * a gate that only checked a hardcoded list would quietly stop covering the plugin the moment somebody else touched it.
 */
const pluginFiles = await listPluginFiles(pluginRoot);
const pluginSources = new Map<string, string>();

for (const file of pluginFiles) {
  pluginSources.set(file, await readFile(new URL(file, pluginRoot), "utf8"));
}

for (const file of ownFiles) {
  expect(pluginFiles.includes(file), `${file} is one of the four files this STEP wrote`);
}

expect(pluginFiles.length >= ownFiles.length, "and the package holds at least them");
expect(
  pluginFiles.every((file) => file.endsWith(".php")),
  "the listing is PHP only, so the safety loop below checks exactly the executable surface",
);
expect(pluginFiles.includes("readme.txt") === false, "and does not try to parse the readme as code");

const readme = await readFile(new URL("readme.txt", pluginRoot), "utf8");

expect(readme.includes("KD Payments for WooCommerce"), "the readme names the plugin");
expect(readme.includes("Requires PHP: 8.1"), "and the PHP it needs");
expect(readme.includes("WC requires at least: 7.0"), "and the WooCommerce it needs");
expect(readme.includes("kd_payments_api_key"), "documenting where the key is stored");
expect(readme.includes("random_bytes"), "and where the token comes from");

for (const [file, source] of pluginSources) {
  expect(source.includes("defined( 'ABSPATH' ) || exit;"), `${file} refuses direct access`);
  expect(!/eval\s*\(/u.test(source), `${file} evaluates no string`);
  expect(!/\bextract\s*\(/u.test(source), `${file} extracts no array into scope`);
  expect(!/create_function\s*\(/u.test(source), `${file} builds no function from a string`);
  expect(!/unserialize\s*\(/u.test(source), `${file} unserialises nothing`);
  expect(!/error_log\s*\(/u.test(source), `${file} logs nothing`);
  expect(!/var_dump\s*\(/u.test(source), `${file} dumps nothing`);
  expect(!/print_r\s*\(/u.test(source), `${file} prints no structure`);
  expect(!/\$_(?:GET|REQUEST)\b/u.test(source), `${file} reads no request variable it did not need`);
  expect(!/echo\s+\$/u.test(source), `${file} echoes no bare variable`);
  expect(!/\$wpdb\b/u.test(source), `${file} writes no SQL of its own`);

  const depth = delimiterDepth(source);

  expect(depth === 0, `${file}'s braces, brackets and parentheses balance outside strings and comments`);
}

const mainFile = pluginSources.get("kd-payments.php") ?? "";

expect(mainFile.includes("Plugin Name:"), "the main file declares a plugin header");
expect(mainFile.includes("Text Domain:       kd-payments"), "with its text domain");
expect(mainFile.includes("Requires PHP:      8.1"), "and its PHP requirement");
expect(mainFile.includes("WC requires at least: 7.0"), "and its WooCommerce requirement");
expect(mainFile.includes("register_activation_hook"), "activation is hooked");
expect(mainFile.includes("register_deactivation_hook"), "and deactivation");
expect(mainFile.includes("bin2hex( random_bytes( 32 ) )"), "the store's token is thirty-two random bytes");
expect(
  mainFile.includes("add_option( 'kd_payments_store_token', bin2hex( random_bytes( 32 ) ), '', 'no' );"),
  "the store token is stored unautoloaded, pinned",
);
expect(
  mainFile.includes("add_option( 'kd_payments_api_key', '', '', 'no' );"),
  "and so is the merchant's key, pinned",
);
expect(
  mainFile.includes("add_option( 'kd_payments_connection', array(), '', 'no' );"),
  "and the last answer",
);
expect(mainFile.includes("kd_payments_api_base"), "the API base is a function");
expect(mainFile.includes("'https://app.kdsolution.example.com'"), "defaulting to https");
expect(mainFile.includes("apply_filters"), "and filterable for a staging platform");
expect(mainFile.includes("current_user_can( 'activate_plugins' )"), "the missing-woocommerce notice is capability checked");

const clientFile = pluginSources.get("includes/class-kd-api-client.php") ?? "";

expect(clientFile.includes("wp_remote_request"), "the client makes its request through WordPress's HTTP API");
expect(clientFile.includes("'timeout'     => self::TIMEOUT_SECONDS"), "with a timeout");
expect(clientFile.includes("'sslverify'   => true"), "verifying TLS, because a key travels on every call");
expect(clientFile.includes("'redirection' => 0"), "and following no redirect");
expect(clientFile.includes("'Authorization' => 'Bearer ' . $this->api_key"), "with the merchant's key as a bearer token");
expect(clientFile.includes("wp_json_encode"), "encoding its body with WordPress's JSON encoder");
expect(clientFile.includes("is_wp_error( $response )"), "and refusing a transport error rather than reading it");
expect(clientFile.includes("wp_remote_retrieve_response_code"), "reading the status it got");
expect(
  clientFile.indexOf("'Authorization'") > clientFile.indexOf("$args = array("),
  "the authorization header is set inside the request's own argument array",
);
expect(!clientFile.includes("file_get_contents"), "and never uses a raw stream");
expect(!clientFile.includes("curl_"), "nor a raw curl handle");

const connectionFile = pluginSources.get("includes/class-kd-connection.php") ?? "";

expect(
  connectionFile.includes("wp_parse_url( home_url(), PHP_URL_HOST )"),
  "the store's domain is read from the site rather than typed by the merchant",
);
expect(connectionFile.includes("update_option( self::API_KEY_OPTION, $clean, false )"), "the key is saved unautoloaded");
expect(connectionFile.includes("sanitize_text_field"), "after being sanitised");
expect(connectionFile.includes("random_bytes( 32 )"), "the token is minted here too, for a site that skipped activation");
expect(
  !/echo\s/u.test(connectionFile.replace(/\* .*echoed.*\n/gu, "")),
  "this class prints nothing",
);

const settingsFile = pluginSources.get("includes/class-kd-settings.php") ?? "";

expect(settingsFile.includes("const CAPABILITY = 'manage_woocommerce'"), "the screen is for store managers");
expect(settingsFile.includes("check_admin_referer( self::NONCE_ACTION, self::NONCE_FIELD )"), "the nonce is checked");
expect(settingsFile.includes("wp_nonce_field( self::NONCE_ACTION, self::NONCE_FIELD )"), "and printed in every form");
const formCount = (settingsFile.match(/<form /gu) ?? []).length;
const nonceFieldCount = (settingsFile.match(/wp_nonce_field\(/gu) ?? []).length;

expect(
  formCount >= 4,
  "the screen has at least the four forms this STEP wrote: key, connect, refresh, disconnect",
);
expectEqual(
  nonceFieldCount,
  formCount,
  "and every form that posts a state change prints its own nonce - an equality, so a later STEP adding a form cannot " +
    "add one without its nonce",
);
expectEqual(
  (settingsFile.match(/check_admin_referer\(/gu) ?? []).length,
  1,
  "checked in one place, which every handler calls",
);
for (const handler of ["handle_save_key", "handle_connect", "handle_refresh", "handle_disconnect"]) {
  expect(settingsFile.includes(`function ${handler}()`), `${handler} is a handler`);
}

const handlerCount = (settingsFile.match(/public function handle_[a-z_]+\(\): void \{/gu) ?? []).length;
const authoriseCount = (settingsFile.match(/\$this->authorise\(\);/gu) ?? []).length;

expect(handlerCount >= 4, "the screen has at least the four handlers this STEP wrote");
expectEqual(
  authoriseCount,
  handlerCount,
  "and every handler authorises before it acts - an equality, so a handler added later must authorise too",
);
expect(
  settingsFile.indexOf("if ( ! current_user_can( self::CAPABILITY ) )") <
    settingsFile.indexOf("check_admin_referer( self::NONCE_ACTION, self::NONCE_FIELD )"),
  "the capability is checked before the nonce, because a nonce proves intent and not permission",
);
expect(
  settingsFile.slice(
    settingsFile.indexOf("private function authorise()"),
    settingsFile.indexOf("private function finish("),
  ).includes("current_user_can( self::CAPABILITY )"),
  "the capability check lives inside the one function every handler calls, not only in the screen",
);
expect(settingsFile.includes("esc_html("), "printed text is escaped");
expect(settingsFile.includes("esc_attr("), "attributes are escaped");
expect(settingsFile.includes("esc_url("), "and URLs");
expect(settingsFile.includes("esc_html__("), "and translated strings are escaped too");
expectEqual(
  (settingsFile.match(/wp_die\( esc_html__\(/gu) ?? []).length,
  2,
  "both refusal pages are escaped",
);
expect(!/wp_die\( '/u.test(settingsFile), "and neither passes a bare string to the die");
expect(settingsFile.includes("wp_safe_redirect("), "the handler redirects safely");
expect(settingsFile.includes("type=\"password\""), "the key is typed into a password field");
expect(settingsFile.includes("autocomplete=\"off\""), "which asks the browser not to remember it");
expect(!settingsFile.includes("value=\"<?php echo esc_attr( KD_Connection::api_key()"), "and is never printed back");
expect(settingsFile.includes("sanitize_text_field( wp_unslash( $_POST['kd_payments_api_key'] ) )"), "the key is unslashed and sanitised");
expect(settingsFile.includes("set_transient("), "the notice is one-shot");
expect(settingsFile.includes("get_current_user_id()"), "and per user");
expect(settingsFile.includes("delete_transient("), "and cleared once shown");

// ---------------------------------------------------------------------------------------------

/**
 * Every `.php` file under a plugin directory, relative to it and sorted.
 *
 * Written as a walk rather than a list because a plugin's files are its surface: the moment a file is added and the walk
 * does not find it, the safety checks below stop applying to it silently.
 */
async function listPluginFiles(root: URL): Promise<readonly string[]> {
  const files: string[] = [];

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const nested of await listPluginFiles(new URL(`${entry.name}/`, root))) {
        files.push(`${entry.name}/${nested}`);
      }
    } else if (entry.name.endsWith(".php")) {
      files.push(entry.name);
    }
  }

  return files.sort();
}

/**
 * The depth of every bracket, brace and parenthesis in a PHP file, ignoring strings and comments.
 *
 * Not a parser: it cannot prove a file compiles, and it is not asked to. It catches the one class of mistake a machine
 * without PHP on it can catch - a missing or doubled delimiter - and the handoff says plainly that the plugin was not
 * executed in this environment.
 */
function delimiterDepth(source: string): number {
  let depth = 0;
  let index = 0;
  let quote: string | null = null;

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (quote !== null) {
      if (character === "\\") {
        index += 2;
        continue;
      }

      if (character === quote) {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      index += 1;
      continue;
    }

    if (character === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (character === "#" && next !== "[") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    if (character === "{" || character === "(" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === ")" || character === "]") {
      depth -= 1;
    }

    index += 1;
  }

  return depth;
}

if (failures.length > 0) {
  process.stderr.write(`woocommerce connection gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `woocommerce connection gate passed: ${String(checkCount)} checks, a plugin login that activates one ` +
      "store connection per domain, a token sealed under its own tenant and store, an install that is idempotent " +
      "and a revocation that is final, and a plugin reviewed file by file for the nonce, the capability, the " +
      "escaping and the transport it uses\n",
  );
}
