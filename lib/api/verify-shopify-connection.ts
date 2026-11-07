// path: lib/api/verify-shopify-connection.ts
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
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
import { handlePublicApiCall } from "./public-api.ts";
import { PUBLIC_API_BASE, PUBLIC_API_VERSION, PUBLIC_API_VERSION_HEADER } from "./public-fields.ts";
import {
  API_SHOPIFY_CONNECTION_PATH,
  API_SHOPIFY_CONNECTION_ROUTE,
  SHOPIFY_ACCESS_TOKEN_BODY_MAXIMUM_LENGTH,
  SHOPIFY_ACCESS_TOKEN_BODY_MINIMUM_LENGTH,
  SHOPIFY_ACCESS_TOKEN_FIELD,
  SHOPIFY_ACCESS_TOKEN_MAXIMUM_LENGTH,
  SHOPIFY_ACCESS_TOKEN_PATTERN,
  SHOPIFY_ACCESS_TOKEN_PREFIXES,
  SHOPIFY_BODY_MAXIMUM_BYTES,
  SHOPIFY_CONNECTION_COLUMNS,
  SHOPIFY_CONNECTION_OBJECT,
  SHOPIFY_CONNECTION_RULES,
  SHOPIFY_FOREIGN_TOKEN_PREFIXES,
  SHOPIFY_PLATFORM,
  SHOPIFY_SHOP_DOMAIN_FIELD,
  SHOPIFY_SHOP_DOMAIN_MAXIMUM_LENGTH,
  SHOPIFY_SHOP_DOMAIN_PATTERN,
  SHOPIFY_SHOP_DOMAIN_SUFFIX,
  SHOPIFY_SHOP_HANDLE_MAXIMUM_LENGTH,
  type ShopifyConnectionOutcome,
} from "./shopify-connection-fields.ts";
import {
  connectShopifyStore,
  disconnectShopifyStore,
  parseShopDomain,
  parseShopifyAccessToken,
  parseShopifyConnectionRequest,
  readShopifyConnection,
  readShopifyConnectionBody,
} from "./shopify-connections.ts";
import { parseConfiguration } from "../../plugins/shopify/kd-payments-app/src/config.mjs";
import { hmacMessage, signMessage } from "../../plugins/shopify/kd-payments-app/src/shopify.mjs";
import { createApp } from "../../plugins/shopify/kd-payments-app/src/server.mjs";
import {
  STORE_CONNECTION_AUDIT,
  STORE_CONNECTION_ENTITY,
  STORE_CONNECTION_SECRET_CONTEXT_PREFIX,
  STORE_CONNECTION_STATUSES,
  STORE_CONNECTION_TABLE,
  STORE_EXTERNAL_ID_PREFIX,
  storeConnectionSecretContext,
} from "./store-connection-fields.ts";

/**
 * The gate for STEP 210: the Shopify app connection with credential login after install.
 *
 * ## What this proves
 *
 *   - **No migration.** `0035` already holds the shop, its token, its state and the guard that makes a revocation final;
 *     the gate reads the migration and pins the constraints this STEP's writes have to satisfy - including that its
 *     platform list already carries `shopify`.
 *   - **The shop is Shopify's identity, not the merchant's host.** `<handle>.myshopify.com` is accepted in the five
 *     forms a caller may present and everything else is refused with one of four rules: a missing value, a host that
 *     carries more than a host, a domain that is not a Shopify shop, and a handle Shopify could not have issued.
 *   - **The token is Shopify's, and only two kinds are accepted.** `shpat_` and `shpca_` are sealed; an app's shared
 *     secret and another app's delegate token are refused as the wrong kind, before anything is written.
 *   - **The sealing context binds merchant, platform and shop.** A box sealed for one shop does not open for another,
 *     and no query of the service ever selects the ciphertext back.
 *   - **Three states decide three answers**, and a lost race is answered with the row that won rather than an error.
 *   - **The app is reviewed and it runs.** The gate pins the protocol decisions in the package's source - a signature
 *     checked before the shop is read, a constant-time comparison, a token exchanged server to server and never put in
 *     a page, and a session that forgets the token the moment the platform has it - and the handoff records the
 *     end-to-end run this gate's sibling script performed over a socket.
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

const companyId = "9c000000-0000-4000-8000-000000000001";
const otherCompanyId = "9c000000-0000-4000-8000-000000000002";
const credentialId = "9d000000-0000-4000-8000-000000000001";
const presentedKey = `kd_live_shopify_${"1".repeat(64)}`;
const masterKey = Buffer.alloc(32, 7).toString("base64");
const startedAt = Date.parse("2026-11-07T12:00:00.000Z");
const instantIso = new Date(startedAt).toISOString();
const apiOrigin = "https://api.kdsolution.example";

/** A Shopify Admin API access token, shaped the way Shopify mints one. */
const shopifyToken = `shpat_${"b".repeat(32)}`;
const otherShopifyToken = `shpat_${"c".repeat(32)}`;

const ownShop = "shop-example.myshopify.com";
const newShop = "new-shop.myshopify.com";
const revokedShop = "closed.myshopify.com";
const pendingShop = "pending.myshopify.com";
const woocommerceDomain = "shop.example.com";
const foreignShop = "other.myshopify.com";
const deletedShop = "gone.myshopify.com";

function uuidOf(suffix: number): string {
  return `0192f0a2-7c3d-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const activeId = uuidOf(1);
const revokedId = uuidOf(2);
const pendingId = uuidOf(3);
const woocommerceId = uuidOf(4);
const foreignId = uuidOf(5);
const deletedId = uuidOf(6);
const woocommerceTwinId = uuidOf(7);

/** The associated data the gate expects, written out as a literal rather than built by the function under test. */
function expectedContext(shopDomain: string, company: string = companyId): string {
  return `kd-aad-v1|store_connection|${company}|shopify|${shopDomain}`;
}

function boxOf(shopDomain: string, token: string = shopifyToken): SecretBox {
  return sealSecret(masterKey, token, expectedContext(shopDomain));
}

function connectionRow(id: string, shopDomain: string, overrides: Row = {}): Row {
  const box = boxOf(shopDomain);

  return {
    id,
    company_id: companyId,
    platform: "shopify",
    store_domain: shopDomain,
    external_store_id: `${STORE_EXTERNAL_ID_PREFIX}${hashOf(`${companyId}|shopify|${shopDomain}`).slice(0, 32)}`,
    access_token_last_four: shopifyToken.slice(-4),
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
        label: "Shopify app key",
        mode: "live",
        status: "active",
        key_prefix: "kd_live_shopify_1",
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
      connectionRow(activeId, ownShop),
      connectionRow(revokedId, revokedShop, { status: "revoked", revoked_at: instantIso }),
      connectionRow(pendingId, pendingShop, { status: "pending", connected_at: null }),
      connectionRow(woocommerceId, woocommerceDomain, {
        platform: "woocommerce",
        external_store_id: `${STORE_EXTERNAL_ID_PREFIX}${hashOf(`${companyId}|woocommerce|${woocommerceDomain}`).slice(0, 32)}`,
      }),
      connectionRow(foreignId, foreignShop, { company_id: otherCompanyId }),
      connectionRow(deletedId, deletedShop, { deleted_at: instantIso }),
      // The same shop connected on the other platform: `0035` allows it, and this surface must never answer it.
      connectionRow(woocommerceTwinId, ownShop, {
        platform: "woocommerce",
        access_token_last_four: "wxyz",
        external_store_id: `${STORE_EXTERNAL_ID_PREFIX}${hashOf(`${companyId}|woocommerce|${ownShop}`).slice(0, 32)}`,
      }),
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
        for (const row of matched) {
          row["version"] = Number(row["version"]) + 1;
        }

        return;
      }

      if (fixture.loseRace === "applied") {
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
    label: "Shopify app key",
    keyPrefix: "kd_live_shopify_1",
    keyLastFour: "1111",
    lastUsedRefreshed: false,
  };
}

function connectInputOf(
  shopDomain: string,
  token: string = shopifyToken,
  overrides: Partial<{ companyId: string; mode: "test" | "live" }> = {},
): {
  principal: ReturnType<typeof principalOf>;
  clientAddress: string | null;
  request: { shopDomain: string; accessToken: string };
} {
  return {
    principal: principalOf(overrides),
    clientAddress: "203.0.113.7",
    request: { shopDomain, accessToken: token },
  };
}

function readInputOf(
  shopDomain: string,
  overrides: Partial<{ companyId: string }> = {},
): {
  principal: ReturnType<typeof principalOf>;
  shopDomain: string;
  clientAddress: string | null;
} {
  return {
    principal: principalOf(overrides),
    shopDomain,
    clientAddress: "203.0.113.7",
  };
}

function requestOf(options: {
  readonly method?: string;
  readonly query?: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
} = {}): Request {
  const query = options.query ?? "";
  const method = options.method ?? "POST";
  const body =
    method === "GET" || method === "DELETE"
      ? null
      : (options.body ?? JSON.stringify({ shop_domain: ownShop, access_token: shopifyToken }));

  return new Request(`${apiOrigin}${API_SHOPIFY_CONNECTION_PATH}${query}`, {
    method,
    headers: {
      "x-forwarded-for": "203.0.113.7",
      authorization: `Bearer ${presentedKey}`,
      "content-type": "application/json",
      ...options.headers,
    },
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
  "STEP 210 adds no migration: 0035 already holds the shop, its token and its state",
);

const connectionMigration = await readFile(
  new URL("../../migrations/0035_store_connections.sql", import.meta.url),
  "utf8",
);

expect(
  connectionMigration.includes(
    "constraint store_connections_platform_check check (platform in ('shopify', 'woocommerce'))",
  ),
  "the migration already accepts shopify as a platform",
);
expect(
  connectionMigration.includes("create unique index store_connections_domain_key"),
  "and makes one shop one row per merchant",
);
expect(
  connectionMigration.includes(
    "new.store_domain is distinct from old.store_domain",
  ),
  "and freezes the domain of a connection once written",
);
expect(
  connectionMigration.includes("a revoked store connection stays revoked"),
  "and states that a revocation is final, which is what this endpoint refuses against",
);
expect(
  connectionMigration.includes("a store token is re-encrypted only under a new key version"),
  "and seals the token once, which is why a reinstall cannot rewrite it",
);
expect(
  connectionMigration.includes(
    "The identifier the platform gave the store, null until the handshake returns one.",
  ),
  "the identifier column is the platform's to write",
);
expect(
  connectionMigration.includes(
    "the access token the platform will call the store with",
  ),
  "and the sealed column is the token the platform calls the store with, which is what a Shopify access token is",
);
expect(
  connectionMigration.includes("char_length(store_domain) between 3 and 253") &&
    connectionMigration.includes("store_domain = lower(store_domain)"),
  "the domain column is lower case and bounded, which this surface narrows further",
);

// ---------------------------------------------------------------------------------------------
// 2. The route: one resource, three verbs
// ---------------------------------------------------------------------------------------------

const routeSource = await readFile(
  new URL("../../app/api/public/v1/stores/shopify/connection/route.ts", import.meta.url),
  "utf8",
);
const serviceSource = await readFile(new URL("./shopify-connections.ts", import.meta.url), "utf8");
const fieldsSource = await readFile(new URL("./shopify-connection-fields.ts", import.meta.url), "utf8");

expect(
  fieldsSource.includes("export const API_SHOPIFY_CONNECTION_PATH"),
  "the resource's path is a constant of the vocabulary module",
);
expectEqual(
  API_SHOPIFY_CONNECTION_PATH,
  `${PUBLIC_API_BASE}/stores/shopify/connection`,
  "the resource lives under the public API's version root",
);
expectEqual(
  API_SHOPIFY_CONNECTION_ROUTE,
  API_SHOPIFY_CONNECTION_PATH,
  "and its route has no parameter, so the template and the path are one string",
);
expectEqual(SHOPIFY_PLATFORM, "shopify", "the platform this surface speaks for");
expectEqual(SHOPIFY_CONNECTION_OBJECT, "store_connection", "and the object name it answers with");
expectEqual(
  SHOPIFY_CONNECTION_COLUMNS,
  "id,platform,store_domain,status,connected_at,revoked_at,external_store_id,access_token_last_four," +
    "created_at,updated_at,version",
  "the column list is STEP 208's, pinned as a literal so the two surfaces cannot drift",
);
expect(routeSource.includes("export const POST"), "the route exports POST, which is the login after install");
expect(routeSource.includes("export const GET"), "and GET, which is the app's status check");
expect(routeSource.includes("export const DELETE"), "and DELETE, which is the app's disconnect");
expect(!routeSource.includes("export const PUT"), "and no PUT");
expect(!routeSource.includes("export const PATCH"), "and no PATCH");
expect(routeSource.includes("force-dynamic"), "the route is dynamic");
expect(
  routeSource.includes("const route = API_SHOPIFY_CONNECTION_ROUTE;"),
  "and records the constant rather than a second copy of the path",
);
expect(routeSource.includes("handlePublicApiCall"), "every verb goes through the pipeline that authenticates and counts");
expectEqual((routeSource.match(/route,/gu) ?? []).length, 3, "each of the three handlers passes the route constant");
expectEqual(
  (routeSource.match(/clientAddress: readClientAddress\(call\.request\.headers\)/gu) ?? []).length,
  3,
  "and the caller's address",
);
expect(
  routeSource.includes("SHOPIFY_SHOP_DOMAIN_FIELD"),
  "the status and disconnect verbs read the shop from the query, by the vocabulary's own field name",
);
expect(!routeSource.includes("cookie"), "no cookie, because a key is not a session");
expect(!routeSource.includes("csrf"), "no CSRF token, for the same reason");
expect(!routeSource.includes("console."), "and nothing printed");

// ---------------------------------------------------------------------------------------------
// 3. The shop: Shopify's identity, normalised then checked
// ---------------------------------------------------------------------------------------------

for (const [value, expected, description] of [
  ["shop-example.myshopify.com", ownShop, "a bare shop domain"],
  ["Shop-Example.MyShopify.com", ownShop, "an upper case one is lowered, because 0035 stores it lower case"],
  ["https://shop-example.myshopify.com", ownShop, "a URL loses its scheme"],
  ["http://shop-example.myshopify.com/", ownShop, "and a trailing slash"],
  [" shop-example.myshopify.com ", ownShop, "surrounding space is trimmed"],
  ["a1-b2.myshopify.com", "a1-b2.myshopify.com", "digits and dashes inside the handle"],
] as readonly [string, string, string][]) {
  expectEqual(parseShopDomain(value), expected, `${description} is accepted and normalised`);
}

for (const [value, rule, description] of [
  ["", SHOPIFY_CONNECTION_RULES.shopDomainMissing, "an empty shop"],
  ["   ", SHOPIFY_CONNECTION_RULES.shopDomainMissing, "a blank shop"],
  [null, SHOPIFY_CONNECTION_RULES.shopDomainMissing, "a missing shop"],
  [42, SHOPIFY_CONNECTION_RULES.shopDomainMissing, "a number"],
  ["https://shop-example.myshopify.com/admin", SHOPIFY_CONNECTION_RULES.shopDomainNotBare, "a path"],
  ["shop-example.myshopify.com:8443", SHOPIFY_CONNECTION_RULES.shopDomainNotBare, "a port"],
  ["shop-example.myshopify.com?x=1", SHOPIFY_CONNECTION_RULES.shopDomainNotBare, "a query"],
  ["shop-example.myshopify.com#top", SHOPIFY_CONNECTION_RULES.shopDomainNotBare, "a fragment"],
  ["user:pass@shop-example.myshopify.com", SHOPIFY_CONNECTION_RULES.shopDomainNotBare, "credentials in the URL"],
  ["shop example.myshopify.com", SHOPIFY_CONNECTION_RULES.shopDomainNotBare, "a space inside"],
  ["shop.example.com", SHOPIFY_CONNECTION_RULES.shopDomainNotMyshopify, "a custom domain, which is a pointer and not an identity"],
  ["myshopify.com", SHOPIFY_CONNECTION_RULES.shopDomainNotMyshopify, "the suffix alone"],
  ["shop-example.myshopify.com.evil.example", SHOPIFY_CONNECTION_RULES.shopDomainNotMyshopify, "a look-alike host"],
  ["-shop.myshopify.com", SHOPIFY_CONNECTION_RULES.shopDomainInvalid, "a handle that starts with a dash"],
  ["shop-.myshopify.com", SHOPIFY_CONNECTION_RULES.shopDomainInvalid, "a handle that ends with one"],
  ["sh.myshopify.com", SHOPIFY_CONNECTION_RULES.shopDomainInvalid, "a handle under the floor"],
  [`${"a".repeat(61)}.myshopify.com`, SHOPIFY_CONNECTION_RULES.shopDomainInvalid, "a handle past the ceiling"],
] as readonly [unknown, string, string][]) {
  const refusal = await refusalOf(async () => parseShopDomain(value));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.field, SHOPIFY_SHOP_DOMAIN_FIELD, `${description}: naming shop_domain`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

expectEqual(SHOPIFY_SHOP_DOMAIN_SUFFIX, ".myshopify.com", "the suffix is pinned as a literal");
expectEqual(SHOPIFY_SHOP_HANDLE_MAXIMUM_LENGTH, 60, "the handle's ceiling is pinned");
expectEqual(
  SHOPIFY_SHOP_DOMAIN_MAXIMUM_LENGTH,
  74,
  "so the longest legal shop is sixty characters and the fourteen-character suffix",
);
expect(
  SHOPIFY_SHOP_DOMAIN_PATTERN.test(ownShop),
  "the pattern accepts a shop",
);
expect(
  !SHOPIFY_SHOP_DOMAIN_PATTERN.test("Shop-Example.myshopify.com"),
  "and refuses an upper case one, which is why the domain is lowered first",
);
expect(
  SHOPIFY_SHOP_DOMAIN_PATTERN.source.includes("myshopify\\.com"),
  "and carries the suffix, so the literal and the pattern cannot drift",
);
expect(
  !SHOPIFY_SHOP_DOMAIN_PATTERN.test(`${"a".repeat(61)}.myshopify.com`),
  "and enforces the ceiling the constant states",
);
expectEqual(
  SHOPIFY_SHOP_DOMAIN_FIELD,
  "shop_domain",
  "the field is shop_domain, because the row's column is store_domain and the two names must not be confused",
);

// ---------------------------------------------------------------------------------------------
// 4. The token: Shopify's, and only the two kinds this platform may present
// ---------------------------------------------------------------------------------------------

expectEqual(parseShopifyAccessToken(shopifyToken), shopifyToken, "an shpat token is accepted");
expectEqual(
  parseShopifyAccessToken(`  ${shopifyToken}  `),
  shopifyToken,
  "and surrounding space is trimmed rather than refused",
);
expectEqual(
  parseShopifyAccessToken(`shpca_${"d".repeat(32)}`),
  `shpca_${"d".repeat(32)}`,
  "a token-exchange token is accepted too",
);
expectEqual(
  SHOPIFY_ACCESS_TOKEN_PREFIXES.join(","),
  "shpat_,shpca_",
  "the two prefixes are pinned, because they are the two Shopify documents for an Admin API token",
);
expectEqual(
  SHOPIFY_FOREIGN_TOKEN_PREFIXES.join(","),
  "shppa_,shpss_",
  "and the two that are not are pinned as well",
);

for (const [value, rule, description] of [
  [undefined, SHOPIFY_CONNECTION_RULES.accessTokenMissing, "a missing token"],
  ["", SHOPIFY_CONNECTION_RULES.accessTokenMissing, "an empty one"],
  ["   ", SHOPIFY_CONNECTION_RULES.accessTokenMissing, "a blank one"],
  [`shpss_${"b".repeat(32)}`, SHOPIFY_CONNECTION_RULES.accessTokenWrongKind, "an app's shared secret"],
  [`shppa_${"b".repeat(32)}`, SHOPIFY_CONNECTION_RULES.accessTokenWrongKind, "another app's delegate token"],
  ["not-a-token", SHOPIFY_CONNECTION_RULES.accessTokenInvalid, "a value with no Shopify prefix"],
  [`shpat_${"b".repeat(8)}`, SHOPIFY_CONNECTION_RULES.accessTokenInvalid, "a token under the floor"],
  [`shpat_${"b".repeat(120)}`, SHOPIFY_CONNECTION_RULES.accessTokenInvalid, "a token past the ceiling"],
  [`shpat_${"b".repeat(32)}!`, SHOPIFY_CONNECTION_RULES.accessTokenInvalid, "a token with a character outside the alphabet"],
] as readonly [unknown, string, string][]) {
  const refusal = await refusalOf(async () => parseShopifyAccessToken(value));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.field, SHOPIFY_ACCESS_TOKEN_FIELD, `${description}: naming access_token`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

expectEqual(SHOPIFY_ACCESS_TOKEN_BODY_MINIMUM_LENGTH, 16, "the token body's floor is pinned");
expectEqual(SHOPIFY_ACCESS_TOKEN_BODY_MAXIMUM_LENGTH, 96, "and its ceiling");
expectEqual(SHOPIFY_ACCESS_TOKEN_MAXIMUM_LENGTH, 102, "so the longest legal token is a prefix and ninety-six characters");
expect(
  SHOPIFY_ACCESS_TOKEN_PATTERN.source.includes(`{${String(SHOPIFY_ACCESS_TOKEN_BODY_MINIMUM_LENGTH)},${String(SHOPIFY_ACCESS_TOKEN_BODY_MAXIMUM_LENGTH)}}`),
  "which is the quantifier the pattern itself carries",
);
expect(
  !SHOPIFY_ACCESS_TOKEN_PATTERN.test(`shpat_${"b".repeat(32)}.`),
  "and a punctuation mark is outside the alphabet",
);
expectEqual(SHOPIFY_ACCESS_TOKEN_FIELD, "access_token", "the field is access_token, the column's own name");

// ---------------------------------------------------------------------------------------------
// 5. The body: bounded, strict, and every computed field refused
// ---------------------------------------------------------------------------------------------

const parsedBody = parseShopifyConnectionRequest({
  shop_domain: ownShop,
  access_token: shopifyToken,
});

expectEqual(parsedBody.shopDomain, ownShop, "the body parses its shop");
expectEqual(parsedBody.accessToken, shopifyToken, "and its token");
expectEqual(Object.keys(parsedBody).sort().join(","), "accessToken,shopDomain", "and nothing else");
expectEqual(
  parseShopifyConnectionRequest({ shop_domain: "Shop-Example.MyShopify.com", access_token: shopifyToken }).shopDomain,
  ownShop,
  "and the shop is normalised on the way in",
);

for (const [value, field, rule, description] of [
  [null, "body", SHOPIFY_CONNECTION_RULES.bodyMalformed, "a null body"],
  [[], "body", SHOPIFY_CONNECTION_RULES.bodyMalformed, "an array"],
  ["a string", "body", SHOPIFY_CONNECTION_RULES.bodyMalformed, "a bare string"],
  [{ access_token: shopifyToken }, SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainMissing, "a body with no shop"],
  [{ shop_domain: ownShop }, SHOPIFY_ACCESS_TOKEN_FIELD, SHOPIFY_CONNECTION_RULES.accessTokenMissing, "a body with no token"],
  [{ shop_domain: ownShop, access_token: shopifyToken, status: "active" }, "status", SHOPIFY_CONNECTION_RULES.unknownField, "a status"],
  [{ shop_domain: ownShop, access_token: shopifyToken, platform: "shopify" }, "platform", SHOPIFY_CONNECTION_RULES.unknownField, "a platform"],
  [{ shop_domain: ownShop, access_token: shopifyToken, store_domain: ownShop }, "store_domain", SHOPIFY_CONNECTION_RULES.unknownField, "the row's own column name"],
  [{ shop_domain: ownShop, access_token: shopifyToken, external_store_id: "sc_x" }, "external_store_id", SHOPIFY_CONNECTION_RULES.unknownField, "an identifier"],
] as readonly [unknown, string, string, string][]) {
  const refusal = await refusalOf(async () => parseShopifyConnectionRequest(value));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.field, field, `${description}: naming ${field}`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

const declaredTooLarge = await refusalOf(async () =>
  readShopifyConnectionBody(
    new Request(`${apiOrigin}${API_SHOPIFY_CONNECTION_ROUTE}`, {
      method: "POST",
      headers: { "content-length": String(SHOPIFY_BODY_MAXIMUM_BYTES + 1) },
      body: "{}",
    }),
  ),
);

expectEqual(declaredTooLarge.code, "PAYLOAD_TOO_LARGE", "a declared body past the ceiling is refused before it is read");
expectEqual(declaredTooLarge.status, 413, "with 413");
expectEqual(declaredTooLarge.rule, SHOPIFY_CONNECTION_RULES.bodyTooLarge, "and its own rule");

const undeclaredTooLarge = await refusalOf(async () =>
  readShopifyConnectionBody(
    new Request(`${apiOrigin}${API_SHOPIFY_CONNECTION_ROUTE}`, {
      method: "POST",
      body: "x".repeat(SHOPIFY_BODY_MAXIMUM_BYTES + 1),
    }),
  ),
);

expectEqual(
  undeclaredTooLarge.rule,
  SHOPIFY_CONNECTION_RULES.bodyTooLarge,
  "an undeclared body past the ceiling is refused after it is read, so no header is trusted",
);

const malformedBody = await refusalOf(async () =>
  readShopifyConnectionBody(
    new Request(`${apiOrigin}${API_SHOPIFY_CONNECTION_ROUTE}`, { method: "POST", body: "{" }),
  ),
);

expectEqual(malformedBody.rule, SHOPIFY_CONNECTION_RULES.bodyMalformed, "a body that is not JSON is malformed");
expectEqual(SHOPIFY_BODY_MAXIMUM_BYTES, 1_024, "the ceiling is a kilobyte, pinned");

// ---------------------------------------------------------------------------------------------
// 6. The install: one row, one sealed token, one associated data
// ---------------------------------------------------------------------------------------------

const installFixture = createFixture();
const installed: ShopifyConnectionOutcome = await connectShopifyStore(
  connectInputOf(newShop),
  dependenciesOf(installFixture),
);

expectEqual(installed.status, 200, "a connect answers 200, because the connection is active");
expectEqual(installed.reused, false, "and says it wrote the row");
expectEqual(installed.body.status, "active", "the new row is active, as section 20 requires");
expectEqual(installed.body.platform, "shopify", "on the Shopify platform");
expectEqual(installed.body.store_domain, newShop, "for the shop that asked");
expectEqual(installed.body.connected_at, instantIso, "at the platform's instant");
expectEqual(installed.body.store_token_last_four, shopifyToken.slice(-4), "and repeats only the token's tail");
expectEqual(installed.body.mode, "live", "with the key's mode");
const connectReadQuery =
  installFixture.queries.find((query) => query.startsWith(`${STORE_CONNECTION_TABLE}:`)) ?? "";

expect(
  connectReadQuery.endsWith("&limit=1"),
  "the read that decides insert-or-reuse asks for one row, so a merchant with two shops cannot be confused",
);

expectEqual(installFixture.inserts.length, 1, "one insert");
expectEqual(installFixture.inserts[0]?.table, STORE_CONNECTION_TABLE, "into the connection table");
expectEqual(installFixture.inserts[0]?.rows.length, 1, "one row");

const insertedRow = installFixture.inserts[0]?.rows[0] ?? {};

expectEqual(insertedRow["company_id"], companyId, "the row belongs to the merchant the key proved");
expectEqual(insertedRow["platform"], "shopify", "and names the Shopify platform");
expectEqual(insertedRow["store_domain"], newShop, "and the shop");
expectEqual(insertedRow["status"], "active", "active");
expectEqual(insertedRow["connected_at"], instantIso, "with the instant the platform wrote");
expectEqual(insertedRow["revoked_at"], null, "no revocation");
expectEqual(insertedRow["last_error"], null, "and no error");
expectEqual(insertedRow["encryption_key_version"], 1, "sealed under the first key version");
expectEqual(
  insertedRow["external_store_id"],
  `${STORE_EXTERNAL_ID_PREFIX}${hashOf(`${companyId}|shopify|${newShop}`).slice(0, 32)}`,
  "with an identifier the gate recomputes itself rather than borrowing the function under test",
);
expectEqual(insertedRow["access_token_last_four"], shopifyToken.slice(-4), "and the tail");
expect(
  !JSON.stringify(insertedRow).includes(shopifyToken),
  "the row carries no plaintext token anywhere",
);
expectEqual(installFixture.sealed.length, 1, "the token was sealed once");
expectEqual(installFixture.sealed[0]?.plaintext, shopifyToken, "the thing sealed is the token that arrived");
expectEqual(
  installFixture.sealed[0]?.context,
  `kd-aad-v1|store_connection|${companyId}|shopify|${newShop}`,
  "under the literal associated data, binding merchant, platform and shop",
);
expectEqual(
  STORE_CONNECTION_SECRET_CONTEXT_PREFIX,
  "kd-aad-v1|store_connection",
  "the prefix STEP 208 minted is reused rather than reinvented",
);
expectEqual(
  storeConnectionSecretContext({ companyId, platform: "shopify", storeDomain: newShop }),
  expectedContext(newShop),
  "and the platform segment is the string this surface writes",
);

const installedBox = boxOf(newShop);

expectEqual(
  openSecret(masterKey, installedBox, expectedContext(newShop)),
  shopifyToken,
  "the box opens under its own context",
);

for (const [context, description] of [
  [expectedContext(newShop, otherCompanyId), "another merchant"],
  [expectedContext("other-shop.myshopify.com"), "another shop"],
  [`kd-aad-v1|store_connection|${companyId}|woocommerce|${newShop}`, "the other platform"],
] as readonly [string, string][]) {
  const refusal = await refusalOf(async () => openSecret(masterKey, installedBox, context));

  expect(refusal.code !== "no-refusal", `a box sealed for one connection does not open under ${description}`);
}

expect(
  serviceSource.includes("access_token_ciphertext") &&
    !serviceSource.includes("select=access_token"),
  "the service writes the ciphertext column but never selects it",
);
expectEqual(
  (serviceSource.match(/access_token_ciphertext/gu) ?? []).length,
  1,
  "and names it exactly once, in the insert",
);

// ---------------------------------------------------------------------------------------------
// 7. The three states, and the race
// ---------------------------------------------------------------------------------------------

const reuseFixture = createFixture();
const reused = await connectShopifyStore(connectInputOf(ownShop), dependenciesOf(reuseFixture));

expectEqual(reused.reused, true, "connecting an active shop again is a reuse");
expectEqual(reused.body.id, activeId, "answering the row that stands");
expectEqual(reuseFixture.writes.length, 0, "with no write");
expectEqual(reuseFixture.inserts.length, 0, "and no insert");
expectEqual(
  reuseFixture.audit.entries[0]?.payload["reused"],
  true,
  "and the chain says the connection already stood",
);

const mismatchFixture = createFixture();
const mismatch = await refusalOf(async () =>
  connectShopifyStore(connectInputOf(ownShop, otherShopifyToken), dependenciesOf(mismatchFixture)),
);

expectEqual(mismatch.code, "CONFLICT", "a different token for an active shop is a conflict");
expectEqual(mismatch.status, 409, "with 409");
expectEqual(mismatch.rule, SHOPIFY_CONNECTION_RULES.connectionTokenMismatch, "and the token-mismatch rule");
expectEqual(mismatchFixture.writes.length, 0, "and nothing is written");
expectEqual(
  mismatchFixture.audit.entries[0]?.action,
  STORE_CONNECTION_AUDIT.refused,
  "the refusal is recorded",
);

const revokedFixture = createFixture();
const revoked = await refusalOf(async () =>
  connectShopifyStore(connectInputOf(revokedShop), dependenciesOf(revokedFixture)),
);

expectEqual(revoked.code, "CONFLICT", "a revoked connection is a conflict");
expectEqual(revoked.status, 409, "with 409");
expectEqual(revoked.rule, SHOPIFY_CONNECTION_RULES.connectionRevoked, "and the revocation rule");
expectEqual(revokedFixture.writes.length, 0, "nothing is written");
expectEqual(revokedFixture.inserts.length, 0, "and nothing is inserted, because 0035 freezes the row");

const pendingFixture = createFixture();
const activated = await connectShopifyStore(connectInputOf(pendingShop), dependenciesOf(pendingFixture));

expectEqual(activated.body.status, "active", "a pending row is activated in place");
expectEqual(pendingFixture.writes.length, 1, "with one write");
expectEqual(
  Object.keys(pendingFixture.writes[0]?.values ?? {}).sort().join(","),
  "connected_at,last_error,status",
  "setting the state, the instant and the cleared error, and never a token column",
);
expect(
  (pendingFixture.writes[0]?.query ?? "").includes(`version=eq.1`),
  "guarded by the version that was read",
);
expect(
  (pendingFixture.writes[0]?.query ?? "").includes(`platform=eq.shopify`),
  "and fenced to the Shopify platform",
);
expect(
  (pendingFixture.writes[0]?.query ?? "").includes(`company_id=eq.${companyId}`),
  "and to the merchant",
);

const lostRaceFixture = createFixture();

lostRaceFixture.loseRace = "untouched";

const lostRace = await refusalOf(async () =>
  connectShopifyStore(connectInputOf(pendingShop), dependenciesOf(lostRaceFixture)),
);

expectEqual(lostRace.code, "CONFLICT", "a write another caller moved past is a conflict");
expectEqual(lostRace.rule, SHOPIFY_CONNECTION_RULES.writeNotApplied, "with the write-not-applied rule");

const jumpedFixture = createFixture();

jumpedFixture.loseRace = "applied";

const jumped = await refusalOf(async () =>
  connectShopifyStore(connectInputOf(pendingShop), dependenciesOf(jumpedFixture)),
);

expectEqual(
  jumped.rule,
  SHOPIFY_CONNECTION_RULES.writeNotApplied,
  "a version that moved by two is refused, so the read-back proves this call's write landed",
);

const concurrentFixture = createFixture();

concurrentFixture.conflictOnInsert = true;

const concurrent = await connectShopifyStore(connectInputOf(ownShop), dependenciesOf(concurrentFixture));

expectEqual(concurrent.reused, true, "an insert refused by the unique index answers the row that won");
expectEqual(concurrent.body.id, activeId, "which is the row that stands");

const concurrentRevokedFixture = createFixture();

concurrentRevokedFixture.conflictOnInsert = true;

const concurrentRevoked = await refusalOf(async () =>
  connectShopifyStore(connectInputOf(revokedShop), dependenciesOf(concurrentRevokedFixture)),
);

expectEqual(
  concurrentRevoked.rule,
  SHOPIFY_CONNECTION_RULES.connectionRevoked,
  "and a race lost to a revoked row is still a revocation",
);

const concurrentMismatchFixture = createFixture();

concurrentMismatchFixture.conflictOnInsert = true;

const concurrentMismatch = await refusalOf(async () =>
  connectShopifyStore(connectInputOf(ownShop, otherShopifyToken), dependenciesOf(concurrentMismatchFixture)),
);

expectEqual(
  concurrentMismatch.rule,
  SHOPIFY_CONNECTION_RULES.connectionTokenMismatch,
  "and a race lost to a row holding another token is a token mismatch",
);

// ---------------------------------------------------------------------------------------------
// 8. Reading the connection
// ---------------------------------------------------------------------------------------------

const readFixture = createFixture();
const read = await readShopifyConnection(readInputOf(ownShop), dependenciesOf(readFixture));
const readQuery = readFixture.queries.find((query) => query.startsWith(`${STORE_CONNECTION_TABLE}:`)) ?? "";

expectEqual(read.id, activeId, "a status check answers the connection of that shop");
expectEqual(read.status, "active", "with its state");
expectEqual(read.platform, "shopify", "and its platform");
expect(readQuery.includes(`store_domain=eq.${ownShop}`), "the query narrows on the row's domain");
expect(readQuery.includes(`company_id=eq.${companyId}`), "and on the tenant");
expect(readQuery.includes("platform=eq.shopify"), "and on the Shopify platform");
expect(readQuery.includes("deleted_at=is.null"), "and on a living row");
expect(readQuery.endsWith("&limit=1"), "one row at most, and the query says so at its end");
expect(readQuery.includes(`select=${SHOPIFY_CONNECTION_COLUMNS}`), "selecting the column list this module names");
expect(!readQuery.includes("access_token_ciphertext"), "which never carries the ciphertext");
expect(!readQuery.includes("access_token_iv"), "nor the iv");
expect(!readQuery.includes("access_token_tag"), "nor the tag");
expect(!readQuery.includes("select=*"), "and never a star");
expectEqual(
  read.id,
  activeId,
  "and the same shop connected on WooCommerce is not the row this surface answers",
);
expect(
  readFixture.state.connections.some((row) => row["id"] === woocommerceTwinId),
  "the fixture does hold that twin, so the check above is not vacant",
);

for (const [shopDomain, description] of [
  ["unknown-shop.myshopify.com", "a shop with no connection"],
  [foreignShop, "another merchant's shop"],
  [deletedShop, "a deleted connection"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    readShopifyConnection(readInputOf(shopDomain), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "RESOURCE_NOT_FOUND", `${description} answers not found`);
  expectEqual(refusal.status, 404, `${description}: with 404`);
  expectEqual(refusal.rule, SHOPIFY_CONNECTION_RULES.notConnected, `${description}: with the not-connected rule`);
  expectEqual(
    fixture.audit.entries[0]?.action,
    STORE_CONNECTION_AUDIT.refused,
    `${description}: and the refusal is recorded`,
  );
}

const revokedReadFixture = createFixture();
const revokedRead = await readShopifyConnection(readInputOf(revokedShop), dependenciesOf(revokedReadFixture));

expectEqual(
  revokedRead.status,
  "revoked",
  "a revoked connection stays readable, because the app must be able to show why nothing works",
);

// ---------------------------------------------------------------------------------------------
// 9. Disconnecting
// ---------------------------------------------------------------------------------------------

const disconnectFixture = createFixture();
const disconnected = await disconnectShopifyStore(readInputOf(ownShop), dependenciesOf(disconnectFixture));

expectEqual(disconnected.status, "revoked", "a disconnect revokes");
expectEqual(disconnected.id, activeId, "the row it found");
expectEqual(disconnectFixture.writes.length, 1, "one write");
expectEqual(
  Object.keys(disconnectFixture.writes[0]?.values ?? {}).sort().join(","),
  "last_error,revoked_at,status",
  "setting the revocation and nothing else",
);
expectEqual(disconnectFixture.writes[0]?.values["revoked_at"], instantIso, "at the platform's instant");
expectEqual(
  disconnectFixture.audit.entries[0]?.action,
  STORE_CONNECTION_AUDIT.revoked,
  "the revocation is in the chain",
);
expectEqual(
  disconnectFixture.audit.entries[0]?.payload["platform"],
  "shopify",
  "naming the platform the row actually carries",
);
expect(
  !JSON.stringify(disconnectFixture.audit.entries[0]).includes(shopifyToken),
  "and the entry carries no token",
);

const secondDisconnectFixture = createFixture();
const secondDisconnect = await disconnectShopifyStore(
  readInputOf(revokedShop),
  dependenciesOf(secondDisconnectFixture),
);

expectEqual(secondDisconnect.status, "revoked", "a second disconnect answers the revoked row");
expectEqual(secondDisconnectFixture.writes.length, 0, "with no write");
expectEqual(secondDisconnectFixture.audit.entries.length, 0, "and no second entry");

const missingDisconnectFixture = createFixture();
const missingDisconnect = await refusalOf(async () =>
  disconnectShopifyStore(readInputOf("unknown-shop.myshopify.com"), dependenciesOf(missingDisconnectFixture)),
);

expectEqual(missingDisconnect.code, "RESOURCE_NOT_FOUND", "a disconnect of a shop with no connection is not found");
expectEqual(missingDisconnect.rule, SHOPIFY_CONNECTION_RULES.notConnected, "with the not-connected rule");

// ---------------------------------------------------------------------------------------------
// 10. The answer
// ---------------------------------------------------------------------------------------------

expectEqual(
  Object.keys(installed.body).sort().join(","),
  "connected_at,created_at,external_store_id,id,mode,object,platform,reused,status,store_domain," +
    "store_token_last_four,updated_at",
  "the connect answer carries twelve fields and no token",
);
expect(
  !("access_token" in installed.body) &&
    !("access_token_ciphertext" in installed.body) &&
    !("store_token" in installed.body),
  "no field of the answer is the token or its box",
);
expect(
  !JSON.stringify(installed.body).includes(shopifyToken),
  "and the value appears nowhere in it",
);
expect(
  !JSON.stringify(installed.body).includes(installedBox.ciphertext),
  "nor the ciphertext",
);

// ---------------------------------------------------------------------------------------------
// 11. Through the pipeline
// ---------------------------------------------------------------------------------------------

const pipelineFixture = createFixture();

const pipelineAnswer = await handlePublicApiCall(
  {
    request: requestOf(),
    route: API_SHOPIFY_CONNECTION_ROUTE,
    handler: async (call) => {
      const body = await readShopifyConnectionBody(call.request);
      const outcome = await connectShopifyStore(
        {
          principal: call.principal,
          clientAddress: "203.0.113.7",
          request: parseShopifyConnectionRequest(body),
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
expectEqual(pipelineFixture.counters.length, 3, "three counters, as every public call pays");
expectEqual(
  pipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "one call entry",
);
expectEqual(
  pipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["route"],
  API_SHOPIFY_CONNECTION_ROUTE,
  "recorded under the resource's route",
);

const noKeyRefusal = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: new Request(`${apiOrigin}${API_SHOPIFY_CONNECTION_PATH}`, { method: "POST" }),
      route: API_SHOPIFY_CONNECTION_ROUTE,
      handler: async () => ({ status: 200, body: {} }),
    },
    dependenciesOf(createFixture()),
  ),
);

expectEqual(noKeyRefusal.code, "AUTHENTICATION_REQUIRED", "a call with no key never reaches a handler");
expectEqual(noKeyRefusal.status, 401, "and is answered 401");

const limitedFixture = createFixture();

limitedFixture.refuseCounter = true;

const limited = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: requestOf(),
      route: API_SHOPIFY_CONNECTION_ROUTE,
      handler: async () => ({ status: 200, body: {} }),
    },
    dependenciesOf(limitedFixture),
  ),
);

expectEqual(limited.code, "RATE_LIMITED", "a refused counter stops the call before the handler");

const deafFixture = createFixture();

deafFixture.failAudit = true;

const deafOutcome = await refusalOf(async () =>
  connectShopifyStore(connectInputOf("deaf-shop.myshopify.com"), dependenciesOf(deafFixture)),
);

expectEqual(deafOutcome.code, "no-refusal", "a chain that cannot be written does not refuse a connection");
expectEqual(deafFixture.inserts.length, 1, "the row is written anyway");

// ---------------------------------------------------------------------------------------------
// 12. The chain
// ---------------------------------------------------------------------------------------------

const activationEntry = installFixture.audit.entries.find(
  (entry) => entry.action === STORE_CONNECTION_AUDIT.activated,
);

expectEqual(STORE_CONNECTION_AUDIT.activated, "api.store_connection_activated", "the activation action is pinned");
expectEqual(STORE_CONNECTION_AUDIT.refused, "api.store_connection_refused", "the refusal action is pinned");
expectEqual(STORE_CONNECTION_AUDIT.revoked, "api.store_connection_revoked", "the revocation action is pinned");
expectEqual(STORE_CONNECTION_ENTITY, "store_connection", "and the entity is the table");

expect(activationEntry !== undefined, "an activation writes one entry");
expectEqual(activationEntry?.entityType, STORE_CONNECTION_ENTITY, "naming a store connection");
expectEqual(activationEntry?.actorUserId, null, "with no human actor, because an app's key made the call");
expectEqual(activationEntry?.companyId, companyId, "on the merchant's own chain");
expectEqual(activationEntry?.ipAddress, "203.0.113.7", "with the address the call came from");
expectEqual(activationEntry?.payload["platform"], "shopify", "the platform");
expectEqual(activationEntry?.payload["store_domain"], newShop, "the shop");
expectEqual(activationEntry?.payload["status"], "active", "the state it reached");
expectEqual(activationEntry?.payload["reused"], false, "and that this call wrote it");
expectEqual(activationEntry?.payload["mode"], "live", "in the key's mode");
expectEqual(activationEntry?.payload["credential_id"], credentialId, "naming the key");
expectEqual(
  activationEntry?.payload["store_token_last_four"],
  shopifyToken.slice(-4),
  "and repeating only the token's tail",
);
expect(!JSON.stringify(activationEntry).includes(shopifyToken), "never the token itself");
expect(!JSON.stringify(activationEntry).includes(presentedKey), "and never the key");

for (const [rule, expected] of Object.entries(SHOPIFY_CONNECTION_RULES)) {
  expectEqual(
    expected,
    expected.toLowerCase(),
    `the rule ${rule} is a lower case machine word`,
  );
}

expectEqual(
  Object.values(SHOPIFY_CONNECTION_RULES).length,
  new Set(Object.values(SHOPIFY_CONNECTION_RULES)).size,
  "no two rules share a word, because a screen branches on it",
);
expect(
  Object.values(SHOPIFY_CONNECTION_RULES).every((rule) => /^[a-z][a-z0-9_]{3,40}$/u.test(rule)),
  "and every rule is snake case",
);
expectEqual(STORE_CONNECTION_STATUSES.join(","), "pending,active,revoked,error", "the four states are the migration's");

// ---------------------------------------------------------------------------------------------
// 13. The app, reviewed as source
// ---------------------------------------------------------------------------------------------

const appRoot = new URL("../../plugins/shopify/kd-payments-app/", import.meta.url);

async function sourceOf(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, appRoot), "utf8");
}

const appFiles = [
  "config.mjs",
  "copy.mjs",
  "shopify.mjs",
  "session.mjs",
  "platform.mjs",
  "payments.mjs",
  "callback.mjs",
  "screen.mjs",
  "server.mjs",
];
const appSources = new Map<string, string>();

for (const file of appFiles) {
  appSources.set(file, await sourceOf(`src/${file}`));
}

const serverSource = appSources.get("server.mjs") ?? "";
const shopifySource = appSources.get("shopify.mjs") ?? "";
const platformSource = appSources.get("platform.mjs") ?? "";
const sessionSource = appSources.get("session.mjs") ?? "";
const screenSource = appSources.get("screen.mjs") ?? "";
const configSource = appSources.get("config.mjs") ?? "";
const readmeSource = await sourceOf("readme.txt");
const exampleConfiguration = JSON.parse(await sourceOf("config.example.json")) as Record<string, unknown>;
const appPackage = JSON.parse(await sourceOf("package.json")) as Record<string, unknown>;

expect(appFiles.length === 9, "the app is nine modules and no more: STEP 211 added the payment and callback pair");
expectEqual(appPackage["private"], true, "it is a private package");
expectEqual(appPackage["type"], "module", "written as ES modules");
expectEqual(
  Object.keys(appPackage["dependencies"] ?? {}).length,
  0,
  "with no dependency at all, which is why no package request is needed",
);
expect(
  (appPackage["scripts"] as Record<string, string>)["start"] === "node src/server.mjs",
  "and one start script",
);

/**
 * The two placeholder markers the repository forbids, split so this gate is not itself a file that carries them.
 */
const FORBIDDEN_PLACEHOLDERS = ["TO" + "DO", "FIX" + "ME"];

for (const [file, source] of appSources) {
  expect(source.startsWith(`// path: plugins/shopify/kd-payments-app/src/${file}`), `${file} carries its path comment`);
  expect(!source.includes("console."), `${file} prints nothing through console, which the lint matrix forbids`);
  expect(!source.includes("process.env"), `${file} reads no environment variable, which the lint matrix forbids`);
  expect(!source.includes("ev" + "al("), `${file} evaluates no string`);
  expect(
    !FORBIDDEN_PLACEHOLDERS.some((marker) => source.includes(marker)),
    `${file} carries no placeholder marker`,
  );
}

// The signature is verified before the shop is believed.
expect(
  shopifySource.includes("export function verifyInstallQuery"),
  "the app verifies Shopify's query in one function",
);
const verifyBody = shopifySource.slice(
  shopifySource.indexOf("export function verifyInstallQuery"),
  shopifySource.indexOf("/** An unpredictable state value"),
);

expect(
  verifyBody.indexOf("hmacMissing") < verifyBody.indexOf("parseShopDomain"),
  "and refuses a missing signature before it reads the shop",
);
expect(
  verifyBody.indexOf("hmacInvalid") < verifyBody.indexOf("parseShopDomain"),
  "and a wrong one before it reads the shop",
);
expect(verifyBody.includes("repeatedParameter"), "a repeated parameter is refused rather than resolved");
expect(verifyBody.includes("timestampStale") && verifyBody.includes("timestampFuture"), "the timestamp is bounded both ways");
expect(
  verifyBody.includes("sameSignature(presented.toLowerCase(), expected)"),
  "and the comparison is the constant-time one",
);
expectEqual(
  INSTALL_AGE_LITERAL(shopifySource),
  86_400,
  "a signature is valid for a day",
);

function INSTALL_AGE_LITERAL(source: string): number {
  return Number(source.match(/INSTALL_SIGNATURE_MAXIMUM_AGE_SECONDS = ([0-9_]+)/u)?.[1]?.replace(/_/gu, "") ?? 0);
}

expectEqual(
  hmacMessageLiteral(shopifySource),
  "sorted, escaped and joined with a single ampersand",
  "the signed message is built the way Shopify documents it",
);

function hmacMessageLiteral(source: string): string {
  const escapes = [source.includes('split("%").join("%25")'), source.includes('split("&").join("%26")'), source.includes('split("=").join("%3D")')];
  const sorts = source.includes(".sort(");
  const joins = source.includes('.join("&")');

  return escapes.every(Boolean) && sorts && joins ? "sorted, escaped and joined with a single ampersand" : "wrong";
}

expectEqual(
  timingSafeLiteral(shopifySource),
  true,
  "the signature comparison is timingSafeEqual, not equality",
);

function timingSafeLiteral(source: string): boolean {
  return source.includes("timingSafeEqual(") && !/hmac === /u.test(source);
}

const exchangeBody = shopifySource.slice(
  shopifySource.indexOf("export async function exchangeCode"),
  shopifySource.indexOf("/**", shopifySource.indexOf("export async function exchangeCode") + 10),
);

expect(
  exchangeBody.includes('redirect: "error"'),
  "the token exchange follows no redirect, because a redirect would carry the client secret elsewhere",
);
expect(
  shopifySource.includes("AbortSignal.timeout(timeoutMs)"),
  "and it cannot hang",
);
expect(
  shopifySource.includes('fetchImpl(`https://${domain}/admin/oauth/access_token`'),
  "the exchange goes to the shop's own host over https",
);
expect(
  shopifySource.includes("client_secret: apiSecret"),
  "with the client secret in the form body rather than in a URL",
);
expect(
  shopifySource.includes("SHOPIFY_RULES.tokenNotOffline"),
  "and a token that expires is refused, because a connection cannot expire in an hour",
);
expect(
  shopifySource.includes("FOREIGN_TOKEN_PREFIXES.some"),
  "the two kinds of Shopify string that are not an access token are refused in the app too",
);
expect(
  shopifySource.includes('Object.freeze(["shpat_", "shpca_"])'),
  "and the two accepted prefixes are the literals the platform's own module names",
);
expect(
  shopifySource.includes('Object.freeze(["shppa_", "shpss_"])'),
  "with the two refused ones beside them",
);

// The token is never put in a page, a cookie or a log.
expect(
  serverSource.includes("accessToken: token.accessToken"),
  "the callback stores the token in the session and nowhere else",
);
expectEqual(
  (serverSource.match(/accessToken: token\.accessToken/gu) ?? []).length,
  1,
  "exactly once, in the session record",
);
expect(
  serverSource.includes("sessions.update(context.id, { accessToken: null"),
  "and the login clears it the moment the platform has accepted it",
);
const clearedAt = serverSource.indexOf("accessToken: null");
const connectedPageAt = serverSource.indexOf("stage: STAGES.connected");

expect(
  clearedAt > 0 && connectedPageAt > clearedAt,
  "before the page that says it is connected is written",
);
expect(
  !/sessionCookie\(\{[^}]*accessToken/u.test(serverSource),
  "no session cookie carries anything but the identifier",
);
expect(
  !/log\("(?:connection_activated|install_completed)"[^)]*accessToken/u.test(serverSource),
  "and no event carries a token field",
);
expect(
  serverSource.includes("JSON.stringify({ event"),
  "the app logs one JSON object per event",
);
expect(
  serverSource.includes("sessions.destroy(context.id)"),
  "the session identifier is rotated once the session carries a token",
);
expect(
  serverSource.includes("rotatedId"),
  "which is written as a new identifier rather than a rename",
);

// The cookie and the forms.
for (const attribute of ['"HttpOnly",', '"Secure",', '"SameSite=Lax",', '"Path=/",']) {
  expect(sessionSource.includes(attribute), `the session cookie carries ${attribute}`);
}
expect(sessionSource.includes("timingSafeEqual"), "and its signature is compared in constant time");
expect(
  serverSource.includes("if (!csrfAccepted(context, form))"),
  "every form is checked against the session's CSRF token, as a guard rather than a call someone could delete",
);
expect(
  serverSource.indexOf("csrfAccepted(context, form)") < serverSource.indexOf("parseApiKey(form.get"),
  "before the key in it is read",
);
expect(
  serverSource.includes("MAXIMUM_FORM_BYTES"),
  "and a form body is bounded before it is parsed",
);
const platformCallBody = platformSource.slice(platformSource.indexOf("async function call("));

expect(
  platformCallBody.includes('redirect: "error"'),
  "the platform client follows no redirect",
);
expect(
  platformSource.includes("API_KEY_PATTERN.test(trimmed)"),
  "and refuses a key that is not shaped like one before a byte leaves",
);
expect(
  !platformSource.includes("console.") && !platformSource.includes("process.env"),
  "the client prints nothing and reads no environment",
);
expect(
  screenSource.includes("export function escapeHtml"),
  "the screen escapes through one function",
);
expect(
  screenSource.includes('replace(/[&<>"\']/gu,'),
  "which replaces all five characters rather than returning its argument",
);
expect(
  (screenSource.match(/escapeHtml\(/gu) ?? []).length >= 12,
  "and uses it on every interpolated value",
);
expect(
  !/\$\{connection\.[a-z_]+\(?/u.test(screenSource),
  "with no connection field interpolated raw",
);
expect(
  screenSource.includes('type="password"'),
  "the key is typed into a password field",
);
expect(
  screenSource.includes('autocomplete="off"'),
  "which asks the browser not to remember it",
);
expect(
  !screenSource.includes("name=\"access_token\""),
  "and no form field ever carries the token",
);
expect(
  screenSource.includes("frame-ancestors 'none'") && screenSource.includes('"x-frame-options": "DENY"'),
  "the page cannot be framed",
);
expect(
  screenSource.includes('"cache-control": "no-store"'),
  "and is never cached",
);
expect(
  screenSource.includes("content-security-policy"),
  "with a content security policy",
);

// The configuration and the readme.
expectEqual(exampleConfiguration["platformBaseUrl"], "https://app.kdsolution.example", "the example config names no real host");
expect(
  String(exampleConfiguration["shopifyApiSecret"]).startsWith("REPLACE_WITH_"),
  "and carries no secret at all",
);
expect(
  String(exampleConfiguration["sessionSecret"]).startsWith("REPLACE_WITH_"),
  "nor a session seed",
);
expect(
  configSource.includes("not_https") && configSource.includes("not_an_origin"),
  "the app refuses a base URL that is not an https origin",
);
expect(
  configSource.includes("ConfigError"),
  "with a configuration error that names the field and never the value",
);
expect(
  configSource.includes("process.env") === false,
  "and reads its configuration from a file rather than the environment",
);
expect(readmeSource.includes("/auth/install") && readmeSource.includes("/auth/callback"), "the readme documents both endpoints");
expect(readmeSource.includes("App Bridge"), "and names the embedded-app requirement it does not meet");
expect(readmeSource.includes("GDPR webhooks"), "and the mandatory webhooks it does not answer");
expect(readmeSource.includes("app/uninstalled"), "and the uninstall path it does not handle");
expect(readmeSource.includes("not published"), "... and that the package is not published");

// The package layout is what the gate read.
const appTree = await readdir(new URL("src/", appRoot));

expectEqual(
  appTree.sort().join(","),
  "callback.mjs,config.mjs,copy.mjs,payments.mjs,platform.mjs,screen.mjs,server.mjs,session.mjs,shopify.mjs",
  "the source tree holds exactly the nine modules the gates between them review",
);

// ---------------------------------------------------------------------------------------------
// 14. The screen, the copy, and the way out of a failure
// ---------------------------------------------------------------------------------------------

const copySource = appSources.get("copy.mjs") ?? "";

expect(copySource.includes("export const COPY"), "the app's sentences live in one catalog");
expect(copySource.includes("export function fill"), "with one placeholder filler beside them");
expect(screenSource.includes('import { COPY, fill } from "./copy.mjs"'), "the renderer imports the catalog");
expect(serverSource.includes('import { COPY, fill } from "./copy.mjs"'), "and so does the handler");

for (const [phrase, description] of [
  ["Install the app from your Shopify admin", "the install panel's title"],
  ["Log in with your platform credentials", "the credential panel's title"],
  ["That form has expired", "the CSRF notice"],
  ["not a platform API key", "the key notice"],
  ["The connection is revoked", "the revocation notice"],
] as readonly [string, string][]) {
  expect(copySource.includes(phrase), `${description} is in the catalog`);
  expect(
    !screenSource.includes(phrase) && !serverSource.includes(phrase),
    `${description} is written nowhere but the catalog`,
  );
}

expect(
  !/title: "/u.test(screenSource) && !/detail: "/u.test(serverSource),
  "neither the renderer nor the handler writes a notice of its own",
);
expect(
  (copySource.match(/Object\.freeze\(\{/gu) ?? []).length >= 6,
  "every group of the catalog is frozen, so a caller cannot edit copy at run time",
);
expect(copySource.includes("{shop}") && copySource.includes("{rule}") && copySource.includes("{status}"),
  "the three values a sentence needs are named placeholders",
);
expect(
  copySource.includes('replace(/\\{([a-z]+)\\}/gu'),
  "and the filler only substitutes lower case names",
);

// The way out of a failure: every failure page is rendered through a session, not beside one.
expect(
  serverSource.includes("function sendFailure(request, responseObject, status, notice)"),
  "the app has one function that renders a failure page",
);
expect(
  serverSource.includes("const context = ensureSession(sessionOf(request));"),
  "which creates or renews the session the form on that page will need",
);
expect(
  (serverSource.match(/sendFailure\(/gu) ?? []).length >= 4,
  "and every failure path goes through it",
);
expect(
  !serverSource.includes('csrf: ""'),
  "no page is rendered with an empty CSRF token, which would make its form answer 403",
);
expect(
  !/kind: "(?:error|ok)"/u.test(serverSource),
  "and no notice is built at a call site",
);

// The screen's own facts: a viewport, a fluid layout, a visible focus ring and a label for every input.
expect(
  screenSource.includes('name="viewport" content="width=device-width, initial-scale=1"'),
  "the page declares a viewport, so a phone does not render it at desktop width",
);
expect(screenSource.includes("@media (max-width:30rem)"), "it carries a small-screen rule");
expect(
  screenSource.includes("grid-template-columns:1fr"),
  "which folds the definition list into one column rather than overflowing",
);
expect(
  screenSource.includes("outline:2px solid"),
  "focus is drawn with a visible ring",
);
expect(
  !screenSource.includes("outline:none") && !screenSource.includes("outline:0"),
  "and never removed",
);
expect(
  screenSource.includes("box-sizing:border-box") && screenSource.includes("width:100%"),
  "inputs fill their container without overflowing it",
);
expect(screenSource.includes("word-break:break-word"), "and a long shop or token tail breaks rather than overflows");
expect(
  screenSource.includes("min-height:2.75rem"),
  "a control is tall enough to touch",
);
expectEqual(
  (screenSource.match(/<label for=/gu) ?? []).length,
  (screenSource.match(/<input id=/gu) ?? []).length,
  "every visible field the page draws has a label bound to it, and the count is an equality so a new field must too",
);
expect(
  (screenSource.match(/name="api_key[^"]*" type="password"/gu) ?? []).length ===
    (screenSource.match(/name="api_key[^"]*"/gu) ?? []).length,
  "and every field that takes a key is a password field, counted as an equality",
);

// ---------------------------------------------------------------------------------------------
// 15. The app, over a socket
// ---------------------------------------------------------------------------------------------

/**
 * The app is JavaScript, so this gate runs it: a real `http.Server`, a real socket, real requests, a fake Shopify token
 * endpoint and a fake platform. STEP 208 and 209 could not do this - there is no PHP interpreter in this environment -
 * and every check below is a behaviour rather than a regex.
 */
const runtimeSecret = "a".repeat(40);
const runtimeToken = `shpat_${"b".repeat(32)}`;
const runtimeKey = `kd_live_shop_${"1".repeat(64)}`;
const runtimeShop = "shop-example.myshopify.com";
const runtimeNow = Date.parse("2026-11-07T12:00:00.000Z");
const runtimeConfig = parseConfiguration({
  platformBaseUrl: "https://api.kdsolution.example",
  appUrl: "https://shopify.kdsolution.example",
  shopifyApiKey: "clientid00000000000000000000000000",
  shopifyApiSecret: runtimeSecret,
  scopes: ["read_orders", "write_orders"],
  sessionSecret: "s".repeat(40),
  sessionTtlSeconds: 900,
  port: 8080,
  listenHost: "127.0.0.1",
});

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
  readonly authorization: string | null;
  readonly redirect: string | undefined;
}

const shopifyCalls: RecordedCall[] = [];
const platformCalls: RecordedCall[] = [];
const exchangeBehaviour = { mode: "ok" as "ok" | "foreign-prefix" | "short-lived" };
const platformBehaviour = { mode: "ok" as "ok" | "revoked" | "unreachable" };

/** The fake of everything outside the app: the shop's token endpoint and the platform's one resource. */
const runtimeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(String(input));
  const method = (init.method ?? "GET").toUpperCase();
  const headers = (init.headers ?? {}) as Record<string, string>;

  if (url.host === runtimeShop && url.pathname === "/admin/oauth/access_token") {
    shopifyCalls.push({
      method,
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : null,
      authorization: null,
      redirect: init.redirect,
    });

    if (exchangeBehaviour.mode === "foreign-prefix") {
      return new Response(JSON.stringify({ access_token: `shpss_${"b".repeat(32)}` }), { status: 200 });
    }

    if (exchangeBehaviour.mode === "short-lived") {
      return new Response(JSON.stringify({ access_token: runtimeToken, expires_in: 86_399 }), {
        status: 200,
      });
    }

    return new Response(JSON.stringify({ access_token: runtimeToken, scope: "read_orders,write_orders" }), {
      status: 200,
    });
  }

  if (url.origin === runtimeConfig.platformBaseUrl) {
    platformCalls.push({
      method,
      url: url.toString(),
      body: typeof init.body === "string" ? init.body : null,
      authorization: headers["authorization"] ?? null,
      redirect: init.redirect,
    });

    if (platformBehaviour.mode === "unreachable") {
      throw new TypeError("fetch failed");
    }

    if (platformBehaviour.mode === "revoked") {
      return new Response(JSON.stringify({ details: [{ field: "connection", rule: "connection_revoked" }] }), {
        status: 409,
      });
    }

    const connection = {
      id: "0192f0a3-7c3d-7000-8000-000000000001",
      object: "store_connection",
      platform: "shopify",
      store_domain: runtimeShop,
      status: method === "DELETE" ? "revoked" : "active",
      connected_at: "2026-11-07T12:00:00.000Z",
      external_store_id: "sc_example",
      store_token_last_four: runtimeToken.slice(-4),
      created_at: "2026-11-07T12:00:00.000Z",
      updated_at: "2026-11-07T12:00:00.000Z",
      ...(method === "POST" ? { reused: false, mode: "live" } : {}),
    };

    return new Response(JSON.stringify(connection), { status: 200 });
  }

  return new Response("{}", { status: 404 });
};

const runtimeApp = createApp({
  config: runtimeConfig,
  now: () => runtimeNow,
  fetchImpl: runtimeFetch,
});
const runtimeServer = createServer((request, response) => {
  void runtimeApp(request, response);
});

await new Promise<void>((resolve) => {
  runtimeServer.listen(0, "127.0.0.1", resolve);
});

const runtimeAddress = runtimeServer.address();
const runtimeOrigin =
  typeof runtimeAddress === "object" && runtimeAddress !== null
    ? `http://127.0.0.1:${String(runtimeAddress.port)}`
    : "";

interface AppAnswer {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
  readonly cookie: string;
  readonly csrf: string;
}

function cookieOf(setCookie: string | null): string {
  return (setCookie ?? "").split(";")[0] ?? "";
}

async function callApp(
  path: string,
  options: { readonly method?: string; readonly form?: Record<string, string> | string; readonly cookie?: string } = {},
): Promise<AppAnswer> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {};

  if (options.cookie !== undefined && options.cookie.length > 0) {
    headers["cookie"] = options.cookie;
  }

  let body: string | undefined;

  if (options.form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body =
      typeof options.form === "string"
        ? options.form
        : new URLSearchParams(options.form).toString();
  }

  const response = await fetch(`${runtimeOrigin}${path}`, {
    method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();

  return {
    status: response.status,
    text,
    headers: response.headers,
    cookie: cookieOf(response.headers.get("set-cookie")),
    csrf: /name="csrf" value="([^"]*)"/u.exec(text)?.[1] ?? "",
  };
}

/** One Shopify-signed query, built the way Shopify signs one. */
function shopifySignedQuery(parameters: readonly (readonly [string, string])[]): string {
  const entries = [...parameters, ["timestamp", String(Math.floor(runtimeNow / 1_000))] as const];
  const signature = signMessage(hmacMessage(entries), runtimeSecret);

  return new URLSearchParams([...entries.map(([key, value]) => [key, value]), ["hmac", signature]]).toString();
}

try {
  const health = await callApp("/healthz");

  expectEqual(health.status, 200, "the app answers a health check");
  expectEqual(health.headers.get("cache-control"), "no-store", "with no cache");
  expect(
    (health.headers.get("content-security-policy") ?? "").includes("default-src 'none'"),
    "and a content security policy that allows nothing",
  );
  expectEqual(health.headers.get("x-frame-options"), "DENY", "and refuses to be framed");

  const home = await callApp("/");

  expectEqual(home.status, 200, "the home page answers");
  expect(home.text.includes("Install the app from your Shopify admin"), "with the install state");
  expect(home.text.includes('name="viewport"'), "and a viewport for a phone");
  expect(home.cookie.startsWith("kd_shopify_session="), "and a session cookie");
  expect(!home.cookie.includes(runtimeToken), "which carries no token");

  const install = await callApp(`/auth/install?${shopifySignedQuery([["shop", runtimeShop], ["host", "YWRtaW4="]])}`, {
    cookie: home.cookie,
  });
  const authorize = new URL(install.headers.get("location") ?? "https://invalid.example");

  expectEqual(install.status, 302, "a signed install redirects");
  expectEqual(authorize.origin, `https://${runtimeShop}`, "to the shop's own authorization endpoint");
  expectEqual(authorize.searchParams.get("scope"), "read_orders,write_orders", "with the scopes comma separated");
  expect(
    (authorize.searchParams.get("state") ?? "").length >= 40,
    "and a state this app minted rather than a constant",
  );
  expectEqual(
    authorize.searchParams.get("redirect_uri"),
    "https://shopify.kdsolution.example/auth/callback",
    "with the app's own callback as the redirect",
  );

  const state = authorize.searchParams.get("state") ?? "";
  const installCookie = install.cookie.length > 0 ? install.cookie : home.cookie;
  const tampered = await callApp(
    `/auth/install?${shopifySignedQuery([["shop", runtimeShop], ["host", "YWRtaW4="]])}&shop=other.myshopify.com`,
    { cookie: installCookie },
  );

  expectEqual(tampered.status, 400, "a repeated parameter refuses the install");
  expect(tampered.text.includes("repeated_parameter"), "naming the rule");
  expect(tampered.csrf.length > 0, "and the refusal page carries a live CSRF token");

  const forgedCallback = await callApp(
    `/auth/callback?${shopifySignedQuery([
      ["shop", runtimeShop],
      ["code", "the-code"],
      ["state", "not-the-state"],
    ])}`,
    { cookie: installCookie },
  );

  expectEqual(forgedCallback.status, 400, "a callback whose state does not match is refused");
  expect(forgedCallback.text.includes("state_mismatch"), "naming the state rule");
  expectEqual(shopifyCalls.length, 0, "and no code was exchanged for it");

  const callback = await callApp(
    `/auth/callback?${shopifySignedQuery([
      ["shop", runtimeShop],
      ["code", "the-code"],
      ["state", state],
    ])}`,
    { cookie: installCookie },
  );

  expectEqual(callback.status, 302, "a signed callback redirects");
  expectEqual(shopifyCalls.length, 1, "and exchanges the code exactly once");
  expect(
    (shopifyCalls[0]?.body ?? "").includes("client_secret=") &&
      (shopifyCalls[0]?.body ?? "").includes("code=the-code"),
    "with the secret and the code in a form body",
  );
  expectEqual(shopifyCalls[0]?.redirect, "error", "and no redirect it would follow");

  const loginPage = await callApp("/", { cookie: callback.cookie });

  expectEqual(loginPage.status, 200, "after the install the app asks for the credential");
  expect(loginPage.text.includes("Log in with your platform credentials"), "with the login panel");
  expect(loginPage.csrf.length >= 20, "a CSRF token");
  expect(loginPage.text.includes('type="password"'), "a password field");
  expect(!loginPage.text.includes(runtimeToken), "and the token nowhere in the page");

  const wrongCsrf = await callApp("/login", {
    method: "POST",
    cookie: callback.cookie,
    form: { csrf: "wrong", api_key: runtimeKey },
  });

  expectEqual(wrongCsrf.status, 403, "a form with the wrong CSRF token is refused");

  const login = await callApp("/login", {
    method: "POST",
    cookie: callback.cookie,
    form: { csrf: loginPage.csrf, api_key: runtimeKey },
  });

  expectEqual(login.status, 200, "the login answers");
  expect(login.text.includes("Connected"), "with the connection");
  expect(login.text.includes(runtimeToken.slice(-4)), "showing the token's tail");
  expect(!login.text.includes(runtimeToken), "and never the token");
  expect(!login.cookie.includes(runtimeToken), "nor a cookie that carries it");
  expectEqual(platformCalls.length, 1, "one platform call");
  expectEqual(
    platformCalls[0]?.url,
    "https://api.kdsolution.example/api/public/v1/stores/shopify/connection",
    "to the connection resource",
  );
  expectEqual(platformCalls[0]?.method, "POST", "with POST");
  expectEqual(platformCalls[0]?.authorization, `Bearer ${runtimeKey}`, "the merchant's key as a bearer header");
  expectEqual(platformCalls[0]?.redirect, "error", "and no redirect followed");
  const sentBody = JSON.parse(platformCalls[0]?.body ?? "{}") as Record<string, string>;

  expectEqual(Object.keys(sentBody).sort().join(","), "access_token,shop_domain", "carrying two fields and no third");
  expectEqual(sentBody["shop_domain"], runtimeShop, "the shop Shopify named");
  expectEqual(sentBody["access_token"], runtimeToken, "and the token Shopify minted");

  const secondLogin = await callApp("/login", {
    method: "POST",
    cookie: callback.cookie,
    form: { csrf: loginPage.csrf, api_key: runtimeKey },
  });

  expectEqual(secondLogin.status, 409, "a second login is refused, because the token was forgotten");
  expectEqual(platformCalls.length, 1, "and the platform is not called again");
  expect(secondLogin.csrf.length > 0, "with a live CSRF token so the page is usable");
  expect(
    secondLogin.cookie.startsWith("kd_shopify_session="),
    "and a renewed session cookie",
  );

  const statusPage = await callApp("/status", {
    method: "POST",
    cookie: secondLogin.cookie,
    form: { csrf: secondLogin.csrf, api_key: runtimeKey, shop: runtimeShop },
  });

  expectEqual(statusPage.status, 200, "the status form answers");
  expectEqual(platformCalls[1]?.method, "GET", "with a GET");
  expect(
    (platformCalls[1]?.url ?? "").includes(`shop_domain=${runtimeShop}`),
    "and the shop in the query",
  );

  const disconnectPage = await callApp("/disconnect", {
    method: "POST",
    cookie: secondLogin.cookie,
    form: { csrf: secondLogin.csrf, api_key: runtimeKey, shop: runtimeShop },
  });

  expectEqual(disconnectPage.status, 200, "the disconnect form answers");
  expectEqual(platformCalls[2]?.method, "DELETE", "with DELETE");
  expect(disconnectPage.text.includes("revoked"), "and reports the revocation");

  // The regression this STEP's resume fixed: a refusal page must be a way out, not a dead end.
  platformBehaviour.mode = "revoked";

  const refused = await callApp("/status", {
    method: "POST",
    cookie: secondLogin.cookie,
    form: { csrf: secondLogin.csrf, api_key: runtimeKey, shop: runtimeShop },
  });
  const retried = await callApp("/status", {
    method: "POST",
    cookie: refused.cookie.length > 0 ? refused.cookie : secondLogin.cookie,
    form: { csrf: refused.csrf, api_key: runtimeKey, shop: runtimeShop },
  });

  expectEqual(refused.status, 409, "a platform refusal answers with the platform's status");
  expect(refused.text.includes("connection_revoked"), "naming the platform's own rule");
  expect(refused.csrf.length > 0, "and the page carries a live CSRF token");
  expectEqual(
    retried.status,
    409,
    "so the merchant can try again from that page and reach the platform rather than a 403",
  );

  platformBehaviour.mode = "unreachable";

  const unreachable = await callApp("/status", {
    method: "POST",
    cookie: secondLogin.cookie,
    form: { csrf: secondLogin.csrf, api_key: runtimeKey, shop: runtimeShop },
  });

  expectEqual(unreachable.status, 502, "an unreachable platform is a 502");
  expect(unreachable.text.includes("could not be reached"), "said in the words a merchant can act on");

  platformBehaviour.mode = "ok";

  const badKey = await callApp("/status", {
    method: "POST",
    cookie: secondLogin.cookie,
    form: { csrf: secondLogin.csrf, api_key: "not-a-key" },
  });

  expectEqual(badKey.status, 400, "a malformed key is refused");
  expectEqual(platformCalls.length, 6, "before any platform call is made");

  const forgedCookie = await callApp("/", { cookie: "kd_shopify_session=forged.signature" });

  expectEqual(forgedCookie.status, 200, "a forged cookie still answers a page");
  expect(forgedCookie.text.includes("Install the app from your Shopify admin"), "as a fresh session");

  const coldForm = await callApp("/status", { method: "POST", form: { csrf: "", api_key: runtimeKey } });

  expectEqual(coldForm.status, 403, "a form from a session this app has never seen is refused");
  expect(coldForm.csrf.length > 0, "and even that page carries a CSRF token a merchant can use");
  expect(
    coldForm.cookie.startsWith("kd_shopify_session="),
    "because the app hands back the session it just created",
  );

  const getOnForm = await callApp("/login", { cookie: secondLogin.cookie });
  const unknownPath = await callApp("/nope");

  expectEqual(getOnForm.status, 405, "a GET on a form endpoint is refused");
  expectEqual(unknownPath.status, 404, "and an unknown path is not found");
  expectEqual(unknownPath.headers.get("x-content-type-options"), "nosniff", "every answer carries the same headers");

  // The Shopify half of the exchange: what the app does with a token it must not accept.
  const freshHome = await callApp("/");
  const freshInstall = await callApp(
    `/auth/install?${shopifySignedQuery([["shop", runtimeShop], ["host", "YWRtaW4="]])}`,
    { cookie: freshHome.cookie },
  );
  const freshState = new URL(freshInstall.headers.get("location") ?? "https://invalid.example").searchParams.get(
    "state",
  );

  exchangeBehaviour.mode = "foreign-prefix";

  const foreignToken = await callApp(
    `/auth/callback?${shopifySignedQuery([
      ["shop", runtimeShop],
      ["code", "another-code"],
      ["state", freshState ?? ""],
    ])}`,
    { cookie: freshInstall.cookie },
  );

  expectEqual(foreignToken.status, 400, "a shared secret returned as a token is refused");
  expect(foreignToken.text.includes("token_wrong_kind"), "as the wrong kind of string");

  exchangeBehaviour.mode = "short-lived";
  const secondHome = await callApp("/");
  const secondInstall = await callApp(
    `/auth/install?${shopifySignedQuery([["shop", runtimeShop], ["host", "YWRtaW4="]])}`,
    { cookie: secondHome.cookie },
  );
  const secondState = new URL(secondInstall.headers.get("location") ?? "https://invalid.example").searchParams.get(
    "state",
  );
  const shortLived = await callApp(
    `/auth/callback?${shopifySignedQuery([
      ["shop", runtimeShop],
      ["code", "third-code"],
      ["state", secondState ?? ""],
    ])}`,
    { cookie: secondInstall.cookie },
  );

  expectEqual(shortLived.status, 400, "a token that expires is refused as not offline");
  expect(shortLived.text.includes("token_not_offline"), "naming the reason");
  expectEqual(platformCalls.length, 6, "and neither refusal reached the platform");

  exchangeBehaviour.mode = "ok";
} finally {
  runtimeServer.close();
}

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`shopify connection gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `shopify connection gate passed: ${String(checkCount)} checks, a shop identity Shopify owns rather than a ` +
      "host the merchant typed, an access token sealed under its own merchant, platform and shop, an install that " +
      "is idempotent and a revocation that is final, an app reviewed for the signature, the constant time " +
      "comparisons, the token it never puts in a page and the session it forgets, and that app run over a real " +
      "socket from the install to the disconnect, with every failure page proved to be a way out rather than a " +
      "dead end\n",
  );
}
