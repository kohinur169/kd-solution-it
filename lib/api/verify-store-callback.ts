// path: lib/api/verify-store-callback.ts
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
import { openSecret as openSecretForFixture, sealSecret, type SecretBox } from "../auth/secrets.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { PUBLIC_API_VERSION, PUBLIC_API_VERSION_HEADER } from "./public-fields.ts";
import { handlePublicApiCall } from "./public-api.ts";
import { API_PAYMENTS_PATH } from "./payment-fields.ts";
import {
  API_PAYMENT_ID_PATTERN,
  API_STORE_PAYMENT_STATUSES,
  paymentStatusPathOf,
} from "./store-payment-status.ts";
import {
  API_STORE_CALLBACK_PATH,
  API_STORE_CALLBACK_ROUTE,
  STORE_CALLBACK_AUDIT,
  STORE_CALLBACK_AUTHORIZATION_HEADER,
  STORE_CALLBACK_BEARER_PREFIX,
  STORE_CALLBACK_CONTENT_TYPE,
  STORE_CALLBACK_ENTITY,
  STORE_CALLBACK_ID_HEADER,
  STORE_CALLBACK_ID_PATTERN,
  STORE_CALLBACK_ID_PREFIX,
  STORE_CALLBACK_MAXIMUM_BODY_BYTES,
  STORE_CALLBACK_OBJECT,
  STORE_CALLBACK_RULES,
  STORE_CALLBACK_TIMEOUT_MS,
  STORE_CALLBACK_TYPE_HEADER,
  STORE_CALLBACK_USER_AGENT,
  STORE_CALLBACK_WC_API_QUERY,
  STORE_CALLBACK_WC_API_VALUE,
  storeCallbackPathOf,
  storeCallbackTypeOf,
  storeCallbackUrlOf,
} from "./store-callback-fields.ts";
import { deliverStoreCallback, storeCallbackIdOf } from "./store-callbacks.ts";
import {
  STORE_CONNECTION_PLATFORM,
  STORE_CONNECTION_SECRET_CONTEXT_PREFIX,
  STORE_CONNECTION_TABLE,
  storeConnectionSecretContext,
} from "./store-connection-fields.ts";
import {
  STORE_WEBHOOK_RULES,
  storeWebhookRuleForStatus,
  type StoreWebhookRule,
} from "./store-webhook-fields.ts";
import {
  StoreWebhookTransportError,
  createStoreWebhookTransport,
  type StoreWebhookTransportRequest,
} from "./store-webhooks.ts";

/**
 * The gate for STEP 209: the WooCommerce plugin's payment and callback handling.
 *
 * ## What this proves
 *
 *   - **No migration.** The payment is STEP 203's row, read through STEP 204's own function; the connection is
 *     STEP 208's row; the token is the box STEP 208 sealed. This STEP adds a **call**, not a table.
 *   - **The address is derived, never supplied.** `https://{domain}/?wc-api=kd_payments_callback` comes from `0035`'s
 *     stored domain through STEP 205's URL fence, so a caller cannot aim the platform's POST anywhere - a private host,
 *     a port, a scheme other than https are all refused before a byte leaves.
 *   - **The shop is called with its own token.** Opened under the same associated data STEP 208 sealed it with - company,
 *     platform **and domain** - and carried as a bearer credential. A box sealed for another shop does not open, and a
 *     platform that cannot open it answers `500` rather than blaming the merchant's server.
 *   - **One connection, or none.** A tenant with two shops is refused (`connection_ambiguous`) rather than called at a
 *     guess, because a payment row names no store.
 *   - **The outcome is reported, not raised**, with STEP 205's own rule words and the shop's own status.
 *   - **The plugin is reviewed as source**, both halves of it: the gateway that creates the payment, and the endpoint
 *     that verifies the store token, refuses to trust the body's status, and never moves an order twice.
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
const presentedKey = `kd_live_store_callback_${"2".repeat(64)}`;
const masterKey = Buffer.alloc(32, 9).toString("base64");
const startedAt = Date.parse("2026-11-07T15:30:00.000Z");
const instantIso = new Date(startedAt).toISOString();
const storeToken = "b1c2d3e4f5061728394a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90";
const paymentId = "0192f0a1-7c3d-7000-8000-0000000000aa";
const otherPaymentId = "0192f0a1-7c3d-7000-8000-0000000000bb";
const storeDomain = "shop.example.com";
const secondDomain = "second.example.com";
const revokedDomain = "closed.example.com";
const pendingDomain = "pending.example.com";
const shopifyDomain = "shopify.example.com";

function uuidOf(suffix: number): string {
  return `0192f0a1-7c3d-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boxOf(domain: string, tenant: string = companyId): SecretBox {
  return sealSecret(
    masterKey,
    storeToken,
    storeConnectionSecretContext({ companyId: tenant, platform: "woocommerce", storeDomain: domain }),
  );
}

function connectionRow(domain: string, overrides: Row = {}): Row {
  const box = boxOf(domain, String(overrides["company_id"] ?? companyId));

  return {
    id: uuidOf(1),
    company_id: companyId,
    platform: "woocommerce",
    store_domain: domain,
    external_store_id: `sc_${hashOf(`${companyId}|woocommerce|${domain}`).slice(0, 32)}`,
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

function paymentRow(overrides: Row = {}): Row {
  return {
    id: paymentId,
    company_id: companyId,
    status: "captured",
    amount_minor: 1_999,
    refunded_minor: 0,
    currency: "USD",
    mode: "live",
    payment_method: "card",
    failure_code: null,
    invoice_id: null,
    deleted_at: null,
    created_at: instantIso,
    updated_at: instantIso,
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

    if (key === "select" || key === "order") {
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

type SendRecord = StoreWebhookTransportRequest;

interface Fixture {
  rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: { credentials: Row[]; companies: Row[]; payments: Row[]; connections: Row[] };
  readonly queries: string[];
  readonly sent: SendRecord[];
  readonly opened: { context: string }[];
  readonly counters: { scope: string; limit: number }[];
  replyStatus: number;
  replyError: "none" | "timeout" | "unreachable";
  tokenBroken: boolean;
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    credentials: [
      {
        id: credentialId,
        company_id: companyId,
        label: "Store key",
        mode: "live",
        status: "active",
        key_prefix: "kd_live_store_callback_2",
        key_hash: hashOf(presentedKey),
        key_last_four: "2222",
        last_used_at: null,
        version: 1,
        deleted_at: null,
      },
    ],
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: otherCompanyId, name: "Second Store", deleted_at: null },
    ],
    payments: [
      paymentRow(),
      paymentRow({ id: otherPaymentId, status: "refunded", refunded_minor: 1_999 }),
      paymentRow({ id: uuidOf(90), company_id: otherCompanyId }),
      paymentRow({ id: uuidOf(91), invoice_id: uuidOf(92) }),
      paymentRow({ id: uuidOf(93), status: "pending", mode: "test" }),
      paymentRow({ id: uuidOf(94), deleted_at: instantIso }),
    ],
    // One active shop, which is the ordinary case. Every test that needs another state or a second shop replaces this
    // array, so a fixture that grew a second connection could never quietly turn the happy path into an ambiguity.
    connections: [connectionRow(storeDomain)],
  };
  const queries: string[] = [];
  const sent: SendRecord[] = [];
  const opened: { context: string }[] = [];
  const counters: { scope: string; limit: number }[] = [];
  const audit = createInMemoryAuditTrail();
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    state,
    queries,
    sent,
    opened,
    counters,
    replyStatus: 204,
    replyError: "none",
    tokenBroken: false,
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

      if (table === STORE_CONNECTION_TABLE) {
        const parsed = parseQuery(query);
        const rows = state.connections.filter((row) => matchesRow(row, parsed));

        return schema.array().parse(
          rows
            .map((row) => ({ ...row }))
            .sort((left, right) => String(right["connected_at"]).localeCompare(String(left["connected_at"])))
            .slice(0, parsed.limit ?? rows.length),
        );
      }

      if (table === "payments") {
        const parsed = parseQuery(query);
        const rows = state.payments.filter((row) => matchesRow(row, parsed));

        return schema.array().parse(
          (parsed.limit === null ? rows : rows.slice(0, parsed.limit)).map((row) => ({ ...row })),
        );
      }

      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_inserts_nothing" } });
    },

    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_inserts_nothing" } });
    },

    async update(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_updates_nothing" } });
    },

    async rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> {
      if (functionName !== "consume_rate_limit") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_function" } });
      }

      counters.push({ scope: String(arguments_["p_scope"]), limit: Number(arguments_["p_limit"]) });

      return [
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
  openSecret: (box: SecretBox, context: string) => string;
  send: (request: StoreWebhookTransportRequest) => Promise<{ status: number }>;
} {
  return {
    rest: fixture.rest,
    audit: fixture.audit,
    now: (): number => startedAt,
    openSecret: (box: SecretBox, context: string): string => {
      fixture.opened.push({ context });

      if (fixture.tokenBroken) {
        throw new Error("the box will not open");
      }

      // The fixture opens the box by reusing the platform's own primitive through `openSecret`, imported lazily so a
      // broken box is a thrown error rather than a returned string.
      return openFixtureSecret(box, context);
    },
    send: async (request: StoreWebhookTransportRequest): Promise<{ status: number }> => {
      fixture.sent.push(request);

      if (fixture.replyError === "timeout") {
        throw new StoreWebhookTransportError("timeout");
      }

      if (fixture.replyError === "unreachable") {
        throw new StoreWebhookTransportError("unreachable");
      }

      return { status: fixture.replyStatus };
    },
  };
}

function openFixtureSecret(box: SecretBox, context: string): string {
  // One import, used by the fixture and by every context assertion below.
  const opened = openSecretForFixture(masterKey, box, context);

  return opened;
}

/** The path the pipeline fixture calls: the template with a concrete id and the callback segment. */
function requestOf(options: { readonly paymentId?: string; readonly headers?: Record<string, string> } = {}): Request {
  const id = options.paymentId ?? paymentId;

  return new Request(`https://api.kdsolution.example${storeCallbackPathOf(id)}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.9",
      authorization: `Bearer ${presentedKey}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body: "",
  });
}

function principalOf(mode: "test" | "live" = "live"): {
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
    companyId,
    companyName: "Northwind Studio",
    mode,
    label: "Store key",
    keyPrefix: "kd_live_store_callback_2",
    keyLastFour: "2222",
    lastUsedRefreshed: false,
  };
}

function inputOf(
  options: {
    readonly paymentId?: string;
    readonly mode?: "test" | "live";
    readonly companyId?: string;
  } = {},
): {
  principal: ReturnType<typeof principalOf>;
  paymentId: string;
  clientAddress: string | null;
} {
  const principal = principalOf(options.mode ?? "live");

  return {
    principal: options.companyId === undefined ? principal : { ...principal, companyId: options.companyId },
    paymentId: options.paymentId ?? paymentId,
    clientAddress: "203.0.113.9",
  };
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the two rows this STEP reads
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
  "STEP 209 adds no migration: the payment is 203's row and the shop is 0035's",
);

const connectionMigration = await readFile(
  new URL("../../migrations/0035_store_connections.sql", import.meta.url),
  "utf8",
);

expect(
  connectionMigration.includes("-- the access token the platform will call the store with, and the state of the handshake."),
  "0035 already names this column the token the platform calls the store with, which is what a callback is",
);
expect(
  connectionMigration.includes("comment on column public.store_connections.access_token_ciphertext is"),
  "the token is a sealed column, not a plain one",
);

// ---------------------------------------------------------------------------------------------
// 2. The vocabulary: the resource, the address, the rules
// ---------------------------------------------------------------------------------------------

const fieldsSource = await readFile(new URL("./store-callback-fields.ts", import.meta.url), "utf8");
const serviceSource = await readFile(new URL("./store-callbacks.ts", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("./store-callback-runtime.ts", import.meta.url), "utf8");
const routeSource = await readFile(
  new URL("../../app/api/public/v1/payments/[id]/callback/route.ts", import.meta.url),
  "utf8",
);

expectEqual(
  API_STORE_CALLBACK_PATH,
  `${API_PAYMENTS_PATH}/{id}/callback`,
  "the callback hangs off STEP 203's payment resource",
);
expectEqual(
  API_STORE_CALLBACK_ROUTE,
  "/api/public/v1/payments/{id}/callback",
  "and its route is the template, pinned",
);
expectEqual(
  storeCallbackPathOf(paymentId),
  `${API_PAYMENTS_PATH}/${paymentId}/callback`,
  "the concrete path names the one payment",
);
expectEqual(
  storeCallbackPathOf("a b"),
  `${API_PAYMENTS_PATH}/a%20b/callback`,
  "and encodes what a caller put in the path",
);
expectEqual(STORE_CALLBACK_OBJECT, "payment_callback", "the object name, pinned");
expect(
  fieldsSource.includes("export function storeCallbackUrlOf"),
  "the address is built in the vocabulary module, where a test can call it",
);
expect(
  fieldsSource.includes("export const STORE_CALLBACK_RULES = Object.freeze({"),
  "and the rules are a frozen vocabulary rather than strings at their call sites",
);
expectEqual(
  paymentStatusPathOf(paymentId),
  `${API_PAYMENTS_PATH}/${paymentId}`,
  "the plugin's status call lands on STEP 204's own resource",
);
expect(
  API_PAYMENT_ID_PATTERN.source === "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "a payment id's shape is STEP 204's pattern, pinned",
);
expectEqual(STORE_CALLBACK_ENTITY, "payment", "the chain entity is the payment a callback is about");
expectEqual(STORE_CALLBACK_ID_PREFIX, "cbt_", "the callback id's prefix, pinned");
expect(STORE_CALLBACK_ID_PATTERN.test("cbt_" + "0".repeat(32)), "a callback id is the prefix and thirty-two hex");
expect(!STORE_CALLBACK_ID_PATTERN.test("evt_" + "0".repeat(32)), "and is not STEP 205's event id");
expectEqual(STORE_CALLBACK_ID_HEADER, "x-kd-callback-id", "the id repeats as a header, pinned");
expectEqual(STORE_CALLBACK_TYPE_HEADER, "x-kd-callback-type", "and so does the type");
expectEqual(STORE_CALLBACK_AUTHORIZATION_HEADER, "authorization", "the token travels in the standard header");
expectEqual(STORE_CALLBACK_BEARER_PREFIX, "Bearer ", "with the bearer prefix the plugin strips");
expectEqual(STORE_CALLBACK_WC_API_QUERY, "wc-api", "WooCommerce's own route parameter");
expectEqual(STORE_CALLBACK_WC_API_VALUE, "kd_payments_callback", "and the route name the plugin registers");
expectEqual(STORE_CALLBACK_CONTENT_TYPE, "application/json", "the body is JSON");
expectEqual(STORE_CALLBACK_TIMEOUT_MS, 10_000, "a callback waits ten seconds, as a webhook does");
expectEqual(STORE_CALLBACK_MAXIMUM_BODY_BYTES, 16_384, "and its body has the same ceiling as an event");
expectEqual(
  storeCallbackUrlOf(storeDomain),
  "https://shop.example.com/?wc-api=kd_payments_callback",
  "the address is derived from the stored domain, pinned",
);
expect(!storeCallbackUrlOf(storeDomain).includes("http:"), "and is always https");

expectEqual(STORE_CALLBACK_RULES.connectionMissing, "connection_missing", "the missing-connection rule, pinned");
expectEqual(STORE_CALLBACK_RULES.connectionNotActive, "connection_not_active", "the not-active rule");
expectEqual(STORE_CALLBACK_RULES.connectionRevoked, "connection_revoked", "the revoked rule");
expectEqual(
  STORE_CALLBACK_RULES.connectionTokenUnavailable,
  "connection_token_unavailable",
  "and the rule a box that will not open reports",
);
expectEqual(STORE_CALLBACK_RULES.storeEndpointInvalid, "store_endpoint_invalid", "the endpoint rule");
expectEqual(STORE_CALLBACK_RULES.bodyTooLarge, "body_too_large", "and the ceiling's rule");
expectEqual(
  STORE_CALLBACK_AUDIT.delivered,
  "api.store_callback_delivered",
  "the delivered action, pinned",
);
expectEqual(STORE_CALLBACK_AUDIT.failed, "api.store_callback_failed", "the failed action");
expectEqual(STORE_CALLBACK_AUDIT.refused, "api.store_callback_refused", "the refused action");

for (const action of Object.values(STORE_CALLBACK_AUDIT)) {
  expect(/^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(action), `${action} fits the chain's dotted action pattern`);
}

for (const status of API_STORE_PAYMENT_STATUSES) {
  expectEqual(storeCallbackTypeOf(status), `payment.${status}`, `a ${status} payment's callback type`);
}

// ---------------------------------------------------------------------------------------------
// 3. The address cannot be aimed anywhere else
// ---------------------------------------------------------------------------------------------

for (const [domain, description] of [
  ["127.0.0.1", "a loopback address"],
  ["localhost", "the name of one"],
  ["10.0.0.5", "a private range"],
  ["192.168.1.10", "a home network"],
  ["169.254.169.254", "a metadata service"],
  ["shop.example.com:8443", "a host with a port"],
  ["[::1]", "an IPv6 loopback"],
] as readonly [string, string][]) {
  const refusal = await refusalOf(async () => {
    const fixture = createFixture();

    fixture.state.connections = [connectionRow(domain)];

    return deliverStoreCallback(inputOf(), dependenciesOf(fixture));
  });

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} in the connection is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.rule, STORE_CALLBACK_RULES.storeEndpointInvalid, `${description}: as an invalid endpoint`);
}

// ---------------------------------------------------------------------------------------------
// 4. The connection: none, not active, revoked, or two
// ---------------------------------------------------------------------------------------------

for (const [connections, rule, description] of [
  [[], STORE_CALLBACK_RULES.connectionMissing, "no connection at all"],
  [
    [connectionRow(pendingDomain, { id: uuidOf(3), status: "pending", connected_at: null })],
    STORE_CALLBACK_RULES.connectionNotActive,
    "a pending connection",
  ],
  [
    [connectionRow(revokedDomain, { id: uuidOf(2), status: "revoked", revoked_at: instantIso })],
    STORE_CALLBACK_RULES.connectionRevoked,
    "a revoked connection",
  ],
  [
    [connectionRow(storeDomain, { id: uuidOf(1) }), connectionRow(secondDomain, { id: uuidOf(6) })],
    "connection_ambiguous",
    "two active shops on one tenant",
  ],
] as readonly [readonly Row[], string, string][]) {
  const fixture = createFixture();

  fixture.state.connections = [...connections];
  const refusal = await refusalOf(async () => deliverStoreCallback(inputOf(), dependenciesOf(fixture)));

  expectEqual(refusal.code, "CONFLICT", `${description} is a conflict`);
  expectEqual(refusal.status, 409, `${description}: with 409`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
  expectEqual(fixture.sent.length, 0, `${description}: and nothing is sent`);
  expectEqual(
    fixture.audit.entries.filter((entry) => entry.action === STORE_CALLBACK_AUDIT.refused).length,
    1,
    `${description}: and the refusal is in the chain`,
  );
}

const revokedBesideActiveFixture = createFixture();

revokedBesideActiveFixture.state.connections = [
  connectionRow(storeDomain),
  connectionRow(revokedDomain, { id: uuidOf(2), status: "revoked", revoked_at: instantIso }),
];

const revokedBesideActive = await deliverStoreCallback(
  inputOf(),
  dependenciesOf(revokedBesideActiveFixture),
);

expectEqual(
  revokedBesideActive.delivered,
  true,
  "a revoked shop beside a live one is one usable shop, because a revoked row is never deleted and must not block the live one",
);
expectEqual(
  revokedBesideActive.endpoint_host,
  storeDomain,
  "and the callback goes to the shop that is still connected",
);
expectEqual(
  revokedBesideActiveFixture.sent.length,
  1,
  "so every merchant who ever moved shops can still be called",
);

const pendingBesideActiveFixture = createFixture();

pendingBesideActiveFixture.state.connections = [
  connectionRow(storeDomain),
  connectionRow(pendingDomain, { id: uuidOf(3), status: "pending", connected_at: null }),
];

const pendingBesideActive = await deliverStoreCallback(
  inputOf(),
  dependenciesOf(pendingBesideActiveFixture),
);

expectEqual(
  pendingBesideActive.delivered,
  true,
  "a half-finished install beside a live one does not make the tenant ambiguous either",
);

const twoActiveFixture = createFixture();

twoActiveFixture.state.connections = [
  connectionRow(storeDomain, { id: uuidOf(1) }),
  connectionRow(secondDomain, { id: uuidOf(6) }),
];

const twoActiveRefusal = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(twoActiveFixture)),
);

expectEqual(
  twoActiveRefusal.rule,
  STORE_CALLBACK_RULES.connectionAmbiguous,
  "only two active shops are ambiguous",
);
expectEqual(STORE_CALLBACK_RULES.connectionAmbiguous, "connection_ambiguous", "and the rule is a word, pinned");

const shopifyFixture = createFixture();

shopifyFixture.state.connections = [connectionRow(shopifyDomain, { platform: "shopify" })];

const shopifyRefusal = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(shopifyFixture)),
);

expectEqual(
  shopifyRefusal.rule,
  STORE_CALLBACK_RULES.connectionMissing,
  "a Shopify connection is not one this callback can use",
);

const deletedFixture = createFixture();

deletedFixture.state.connections = [connectionRow(storeDomain, { deleted_at: instantIso })];

const deletedRefusal = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(deletedFixture)),
);

expectEqual(deletedRefusal.rule, STORE_CALLBACK_RULES.connectionMissing, "nor is a soft-deleted one");

const foreignConnectionFixture = createFixture();

foreignConnectionFixture.state.connections = [
  connectionRow(secondDomain, { company_id: otherCompanyId }),
];

const foreignConnectionRefusal = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(foreignConnectionFixture)),
);

expectEqual(
  foreignConnectionRefusal.rule,
  STORE_CALLBACK_RULES.connectionMissing,
  "and another merchant's connection is not this tenant's",
);

// ---------------------------------------------------------------------------------------------
// 5. The payment is STEP 204's read, not a second one
// ---------------------------------------------------------------------------------------------

for (const [id, code, status, rule, description] of [
  ["not-a-uuid", "VALIDATION_FAILED", 422, "payment_id_malformed", "a malformed payment id"],
  [uuidOf(90), "RESOURCE_NOT_FOUND", 404, "payment_not_found", "another merchant's payment"],
  [uuidOf(91), "RESOURCE_NOT_FOUND", 404, "payment_not_found", "an invoice payment"],
  [uuidOf(94), "RESOURCE_NOT_FOUND", 404, "payment_not_found", "a deleted payment"],
] as readonly [string, string, number, string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    deliverStoreCallback(inputOf({ paymentId: id }), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, code, `${description} is refused`);
  expectEqual(refusal.status, status, `${description}: with the same status STEP 204 gives`);
  expectEqual(refusal.rule, rule, `${description}: and the same rule`);
  expectEqual(fixture.sent.length, 0, `${description}: with nothing sent`);
}

const testModeFixture = createFixture();

testModeFixture.state.payments = [paymentRow({ status: "pending", mode: "test" })];

const testMode = await deliverStoreCallback(inputOf({ mode: "test" }), dependenciesOf(testModeFixture));

expectEqual(testMode.delivered, true, "a test key reads its own test payment");
expectEqual(testMode.type, "payment.pending", "and a pending payment has a type of its own");

const wrongModeFixture = createFixture();

wrongModeFixture.state.payments = [paymentRow({ status: "pending", mode: "test" })];

const wrongModeRefusal = await refusalOf(async () =>
  deliverStoreCallback(inputOf({ mode: "live" }), dependenciesOf(wrongModeFixture)),
);

expectEqual(
  wrongModeRefusal.rule,
  "payment_not_found",
  "while a live key cannot see a test payment, which is STEP 204's mode fence",
);

// ---------------------------------------------------------------------------------------------
// 6. The token: sealed by 208, opened under the same associated data
// ---------------------------------------------------------------------------------------------

const happyFixture = createFixture();
const delivered = await deliverStoreCallback(inputOf(), dependenciesOf(happyFixture));

expectEqual(delivered.delivered, true, "a shop that answers 204 is a delivery");
expectEqual(delivered.rule, null, "with no rule");
expectEqual(delivered.status_code, 204, "and the status it answered");
expectEqual(happyFixture.sent.length, 1, "one request");
expectEqual(happyFixture.opened.length, 1, "one box opened");
expectEqual(
  happyFixture.opened[0]?.context,
  storeConnectionSecretContext({ companyId, platform: "woocommerce", storeDomain }),
  "under the associated data STEP 208 sealed it with",
);
expect(
  happyFixture.opened[0]?.context === `kd-aad-v1|store_connection|${companyId}|woocommerce|shop.example.com`,
  "which is the literal STEP 208's prefix produces, pinned",
);
expect(STORE_CONNECTION_SECRET_CONTEXT_PREFIX.startsWith("kd-aad-v1|"), "the association version is still the first one");
expectEqual(STORE_CONNECTION_PLATFORM, "woocommerce", "and the platform is this STEP's");

const brokenTokenFixture = createFixture();

brokenTokenFixture.tokenBroken = true;

const brokenToken = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(brokenTokenFixture)),
);

expectEqual(brokenToken.code, "INTERNAL_ERROR", "a box that will not open is a platform fault");
expectEqual(brokenToken.status, 500, "answered 500");
expectEqual(
  brokenToken.rule,
  STORE_CALLBACK_RULES.connectionTokenUnavailable,
  "with the rule that says the token is unavailable",
);
expectEqual(brokenTokenFixture.sent.length, 0, "and nothing is sent");

const otherDomainBoxFixture = createFixture();

otherDomainBoxFixture.state.connections = [
  connectionRow(storeDomain, {
    access_token_ciphertext: boxOf(secondDomain).ciphertext,
    access_token_iv: boxOf(secondDomain).iv,
    access_token_tag: boxOf(secondDomain).tag,
  }),
];

const otherDomainBox = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(otherDomainBoxFixture)),
);

expectEqual(
  otherDomainBox.code,
  "INTERNAL_ERROR",
  "a box sealed for another shop does not open here, which is what the domain in the associated data buys",
);
expectEqual(otherDomainBoxFixture.sent.length, 0, "and the platform sends nothing rather than a token it could not open");

// ---------------------------------------------------------------------------------------------
// 7. The envelope and the request
// ---------------------------------------------------------------------------------------------

expectEqual(
  Object.keys(JSON.parse(String(happyFixture.sent[0]?.body))).join(","),
  "id,object,type,created,payment,store",
  "the envelope's six keys, in the order the platform writes them",
);

const sentBody = JSON.parse(String(happyFixture.sent[0]?.body)) as Record<string, unknown>;

expectEqual(sentBody["object"], "payment_callback", "the object name");
expectEqual(sentBody["type"], "payment.captured", "the type is the payment's own state");
expectEqual(sentBody["created"], Math.floor(startedAt / 1_000), "the instant is unix seconds");
expectEqual(
  sentBody["id"],
  `cbt_${createHash("sha256")
    .update(`${companyId}|${paymentId}|payment.captured`, "utf8")
    .digest("hex")
    .slice(0, 32)}`,
  "and the id is the first thirty-two hex characters of the SHA-256 of the three facts, pinned against a literal",
);
expectEqual(
  storeCallbackIdOf({ companyId, paymentId, type: "payment.captured" }),
  String(sentBody["id"]),
  "which is what the service's own derivation produces",
);
expect(
  storeCallbackIdOf({ companyId, paymentId, type: "payment.refunded" }) !==
    storeCallbackIdOf({ companyId, paymentId, type: "payment.captured" }),
  "a refund is a different callback id from the capture before it",
);
expect(
  storeCallbackIdOf({ companyId: otherCompanyId, paymentId, type: "payment.captured" }) !==
    storeCallbackIdOf({ companyId, paymentId, type: "payment.captured" }),
  "and one merchant's callback id is never another's, even for the same payment id",
);
expect(
  STORE_CALLBACK_ID_PATTERN.test(String(sentBody["id"])),
  "which has the shape the plugin validates",
);
expect(
  (sentBody["payment"] as Record<string, unknown>)["id"] === paymentId,
  "the payment block names the payment",
);
expectEqual(
  (sentBody["payment"] as Record<string, unknown>)["status"],
  "captured",
  "with the status STEP 204 read, not one a caller supplied",
);
expectEqual(
  (sentBody["store"] as Record<string, unknown>)["domain"],
  storeDomain,
  "and the shop's own domain",
);
expect(
  (sentBody["store"] as Record<string, unknown>)["external_store_id"] ===
    happyFixture.state.connections[0]?.["external_store_id"],
  "with the identifier the platform gave it",
);
expect(
  !JSON.stringify(sentBody).includes(storeToken),
  "the envelope never carries the token",
);
expect(
  !JSON.stringify(sentBody).includes(presentedKey),
  "nor the merchant's API key",
);
expect(
  !JSON.stringify(sentBody).includes("ciphertext"),
  "nor any part of the box",
);

expect(
  serviceSource.includes("new TextEncoder().encode(body).length > STORE_CALLBACK_MAXIMUM_BODY_BYTES"),
  "the serialised envelope is bounded before it is sent, not after",
);
expect(
  serviceSource.includes("STORE_CALLBACK_RULES.bodyTooLarge") &&
    serviceSource.includes('new AppError("INTERNAL_ERROR"'),
  "and a body past the ceiling is a platform fault with its own rule, never a message to the shop",
);
expect(
  happyFixture.sent.every(
    (request) => new TextEncoder().encode(request.body).length <= STORE_CALLBACK_MAXIMUM_BODY_BYTES,
  ),
  "which every envelope this gate builds satisfies with room to spare",
);

const sentRequest = happyFixture.sent[0];

expectEqual(sentRequest?.url, "https://shop.example.com/?wc-api=kd_payments_callback", "the request goes to the derived URL");
expectEqual(sentRequest?.timeoutMs, 10_000, "with the ten-second ceiling");
expectEqual(
  sentRequest?.headers[STORE_CALLBACK_AUTHORIZATION_HEADER],
  `${STORE_CALLBACK_BEARER_PREFIX}${storeToken}`,
  "and the shop's own token as a bearer credential",
);
expectEqual(
  sentRequest?.headers[STORE_CALLBACK_ID_HEADER],
  String(sentBody["id"]),
  "the id header matches the body's id",
);
expectEqual(sentRequest?.headers[STORE_CALLBACK_TYPE_HEADER], "payment.captured", "and the type header matches");
expectEqual(sentRequest?.headers["content-type"], "application/json", "the content type is JSON");
expectEqual(sentRequest?.headers["user-agent"], STORE_CALLBACK_USER_AGENT, "and the user agent names this surface");
expect(
  sentRequest?.headers[STORE_CALLBACK_AUTHORIZATION_HEADER] !== undefined &&
    !Object.keys(sentRequest.headers).some((name) => name === "x-kd-signature"),
  "no signature header, because an HMAC here would be one the shop cannot verify",
);
expect(
  (sentRequest?.body ?? "").length > 0 && !(sentRequest?.body ?? "").includes("\n"),
  "the body is one line of JSON, so its bytes are its bytes",
);

// ---------------------------------------------------------------------------------------------
// 8. What the shop did: every outcome is reported, none is raised
// ---------------------------------------------------------------------------------------------

for (const [status, rule, description] of [
  [200, null, "a 200"],
  [201, null, "a 201"],
  [204, null, "a 204"],
  [301, STORE_WEBHOOK_RULES.endpointRedirected, "a redirect"],
  [302, STORE_WEBHOOK_RULES.endpointRedirected, "a temporary redirect"],
  [400, STORE_WEBHOOK_RULES.endpointRejected, "a 400"],
  [401, STORE_WEBHOOK_RULES.endpointRejected, "a 401, which is a shop that does not trust the token"],
  [404, STORE_WEBHOOK_RULES.endpointRejected, "a 404"],
  [409, STORE_WEBHOOK_RULES.endpointRejected, "a 409"],
  [408, STORE_WEBHOOK_RULES.endpointBusy, "a 408"],
  [429, STORE_WEBHOOK_RULES.endpointBusy, "a 429"],
  [500, STORE_WEBHOOK_RULES.endpointError, "a 500"],
  [503, STORE_WEBHOOK_RULES.endpointError, "a 503"],
] as readonly [number, StoreWebhookRule | null, string][]) {
  const fixture = createFixture();

  fixture.replyStatus = status;
  const outcome = await deliverStoreCallback(inputOf(), dependenciesOf(fixture));

  expectEqual(outcome.status_code, status, `${description} is reported as the status the shop answered`);
  expectEqual(outcome.delivered, rule === null, `${description}: delivered only when it is a success`);
  expectEqual(outcome.rule, rule, `${description}: with STEP 205's own rule`);
  expectEqual(
    fixture.audit.entries.some(
      (entry) =>
        entry.action === (rule === null ? STORE_CALLBACK_AUDIT.delivered : STORE_CALLBACK_AUDIT.failed),
    ),
    true,
    `${description}: recorded under the matching chain action`,
  );
  expectEqual(fixture.sent.length, 1, `${description}: one request, never a retry`);
}

for (const [reason, rule] of [
  ["timeout", STORE_WEBHOOK_RULES.endpointTimeout],
  ["unreachable", STORE_WEBHOOK_RULES.endpointUnreachable],
] as readonly [Fixture["replyError"], StoreWebhookRule][]) {
  const fixture = createFixture();

  fixture.replyError = reason;
  const outcome = await deliverStoreCallback(inputOf(), dependenciesOf(fixture));

  expectEqual(outcome.delivered, false, `a ${reason} is not a delivery`);
  expectEqual(outcome.rule, rule, `and is reported as ${rule}`);
  expectEqual(outcome.status_code, null, "with no status, because the shop gave none");
}

expectEqual(
  storeWebhookRuleForStatus(500),
  STORE_WEBHOOK_RULES.endpointError,
  "the classifier is STEP 205's own function, not a copy",
);

// ---------------------------------------------------------------------------------------------
// 9. The chain
// ---------------------------------------------------------------------------------------------

const deliveredEntry = happyFixture.audit.entries.find(
  (entry) => entry.action === STORE_CALLBACK_AUDIT.delivered,
);

expect(deliveredEntry !== undefined, "a delivery writes one entry");
expectEqual(deliveredEntry?.entityType, "payment", "naming a payment");
expectEqual(deliveredEntry?.entityId, paymentId, "the payment it is about");
expectEqual(deliveredEntry?.actorUserId, null, "with no human actor, because an API key made the call");
expectEqual(deliveredEntry?.companyId, companyId, "on the merchant's own chain");
expectEqual(deliveredEntry?.ipAddress, "203.0.113.9", "with the address the call came from");
expectEqual(deliveredEntry?.payload["callback_id"], sentBody["id"], "the callback's id");
expectEqual(deliveredEntry?.payload["type"], "payment.captured", "its type");
expectEqual(deliveredEntry?.payload["mode"], "live", "the key's mode");
expectEqual(deliveredEntry?.payload["credential_id"], credentialId, "the key that made the call");
expectEqual(deliveredEntry?.payload["store_domain"], storeDomain, "the shop");
expectEqual(deliveredEntry?.payload["endpoint_host"], "shop.example.com", "its host");
expectEqual(deliveredEntry?.payload["status_code"], 204, "and the status it answered");
expectEqual(deliveredEntry?.payload["rule"], null, "with no rule on a delivery");
expect(
  !JSON.stringify(deliveredEntry).includes(storeToken),
  "and never the token",
);
expect(
  !JSON.stringify(deliveredEntry).includes(presentedKey),
  "nor the key",
);

const failedFixture = createFixture();

failedFixture.replyStatus = 500;

await deliverStoreCallback(inputOf(), dependenciesOf(failedFixture));

const failedEntry = failedFixture.audit.entries.find(
  (entry) => entry.action === STORE_CALLBACK_AUDIT.failed,
);

expect(failedEntry !== undefined, "a failure writes its own entry");
expectEqual(failedEntry?.payload["rule"], STORE_WEBHOOK_RULES.endpointError, "naming the rule");
expectEqual(failedEntry?.payload["status_code"], 500, "and the shop's status");

const deafFixture = createFixture();

const deafDeps = dependenciesOf(deafFixture);

deafDeps.audit = {
  async append(): Promise<void> {
    throw new AppError("DEPENDENCY_FAILED");
  },
};

const deafOutcome = await deliverStoreCallback(inputOf(), deafDeps);

expectEqual(deafOutcome.delivered, true, "a chain that cannot be written does not refuse a delivery");
expectEqual(deafFixture.sent.length, 1, "the request is made anyway");

// ---------------------------------------------------------------------------------------------
// 10. The route
// ---------------------------------------------------------------------------------------------

expect(routeSource.includes("export const POST"), "the route exports POST");
for (const verb of ["GET", "PUT", "PATCH", "DELETE"]) {
  expect(!routeSource.includes(`export const ${verb}`), `and no ${verb}, because a callback sends a request`);
}

expect(routeSource.includes("force-dynamic"), "the route is dynamic");
expect(routeSource.includes("await context.params"), "it awaits the params");
expect(
  routeSource.includes("const route = API_STORE_CALLBACK_ROUTE;"),
  "it records the template rather than the arriving path",
);
expect(
  routeSource.includes("paymentId: id"),
  "it hands the path's id to the service",
);
expect(
  routeSource.includes("deliverStoreCallback"),
  "it calls the service",
);
expect(routeSource.includes("readClientAddress(call.request.headers)"), "and passes the caller's address");
expect(!routeSource.includes("cookie"), "no cookie, because a key is not a session");
expect(!routeSource.includes("csrf"), "and no CSRF token, for the same reason");
expect(!routeSource.includes("console."), "and nothing printed");
expect(
  !routeSource.includes("request.text()") && !routeSource.includes("readConnectionBody"),
  "it reads no body: the resource is the payment and the instruction is the verb",
);

// ---------------------------------------------------------------------------------------------
// 11. Through the pipeline
// ---------------------------------------------------------------------------------------------

const pipelineFixture = createFixture();

const pipelineAnswer = await handlePublicApiCall(
  {
    request: requestOf(),
    route: API_STORE_CALLBACK_ROUTE,
    handler: async (call) => {
      const outcome = await deliverStoreCallback(
        {
          paymentId: paymentId,
          principal: call.principal,
          clientAddress: "203.0.113.9",
        },
        dependenciesOf(pipelineFixture),
      );

      return { status: 200, body: outcome };
    },
  },
  dependenciesOf(pipelineFixture),
);

expectEqual(pipelineAnswer.status, 200, "through the pipeline a callback answers 200");
expectEqual(
  pipelineAnswer.headers[PUBLIC_API_VERSION_HEADER],
  PUBLIC_API_VERSION,
  "with the surface's version",
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
  API_STORE_CALLBACK_ROUTE,
  "recorded under the template, so one endpoint is one bucket",
);

const noKeyRefusal = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: new Request(`https://api.kdsolution.example${storeCallbackPathOf(paymentId)}`, { method: "POST" }),
      route: API_STORE_CALLBACK_ROUTE,
      handler: async () => ({ status: 200, body: {} }),
    },
    dependenciesOf(createFixture()),
  ),
);

expectEqual(noKeyRefusal.code, "AUTHENTICATION_REQUIRED", "a call with no key never reaches the handler");
expectEqual(noKeyRefusal.status, 401, "and is answered 401");

// ---------------------------------------------------------------------------------------------
// 12. The transport is STEP 205's, and still refuses to follow anything
// ---------------------------------------------------------------------------------------------

const seen: { url: string; init: RequestInit }[] = [];

const transport = createStoreWebhookTransport(
  (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(url), init: init ?? {} });

    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch,
);

const transported = await transport({
  url: "https://shop.example.com/?wc-api=kd_payments_callback",
  headers: { authorization: "Bearer token" },
  body: "{}",
  timeoutMs: 1_000,
});

expectEqual(transported.status, 204, "the transport answers with the shop's status");
expectEqual(seen[0]?.init.method, "POST", "one POST");
expectEqual(seen[0]?.init.redirect, "manual", "which never follows a redirect");
expectEqual(seen[0]?.init.cache, "no-store", "and is never cached");
expect(seen[0]?.init.signal instanceof AbortSignal, "with an abort signal for its ceiling");

const timeoutTransport = createStoreWebhookTransport(
  (async (): Promise<Response> => {
    const error = new Error("timed out");

    error.name = "TimeoutError";

    throw error;
  }) as unknown as typeof fetch,
);

const timeoutRefusal = await refusalOf(async () =>
  timeoutTransport({ url: "https://shop.example.com/", headers: {}, body: "{}", timeoutMs: 1_000 }),
);

expectEqual(timeoutRefusal.code, "not-an-app-error", "a timeout is the transport's own error, not the catalogue's");
expect(
  runtimeSource.includes("createStoreWebhookTransport") && runtimeSource.includes("openSecret"),
  "the runtime wires STEP 205's transport and the platform's sealer, and nothing of its own",
);
expect(
  !serviceSource.includes("AbortSignal") && !serviceSource.includes("fetchImplementation"),
  "and the service never touches fetch options it does not own",
);

// ---------------------------------------------------------------------------------------------
// 13. The plugin: the gateway and the callback endpoint
// ---------------------------------------------------------------------------------------------

const pluginRoot = new URL("../../plugins/woocommerce/kd-payments/", import.meta.url);
const phpFiles = [
  "kd-payments.php",
  "includes/class-kd-api-client.php",
  "includes/class-kd-connection.php",
  "includes/class-kd-settings.php",
  "includes/class-kd-payment-gateway.php",
  "includes/class-kd-callback.php",
];
const pluginSources = new Map<string, string>();

for (const file of phpFiles) {
  pluginSources.set(file, await readFile(new URL(file, pluginRoot), "utf8"));
}

expect(pluginSources.size === 6, "the plugin is six PHP files after this STEP");
expect(phpFiles.includes("includes/class-kd-payment-gateway.php"), "the gateway is one of them");
expect(phpFiles.includes("includes/class-kd-callback.php"), "and the callback endpoint");

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
  expect(delimiterDepth(source) === 0, `${file}'s delimiters balance outside strings and comments`);
}

const mainFile = pluginSources.get("kd-payments.php") ?? "";
const connectionFile = pluginSources.get("includes/class-kd-connection.php") ?? "";
const clientFile = pluginSources.get("includes/class-kd-api-client.php") ?? "";
const gatewayFile = pluginSources.get("includes/class-kd-payment-gateway.php") ?? "";
const callbackFile = pluginSources.get("includes/class-kd-callback.php") ?? "";
const readme = await readFile(new URL("readme.txt", pluginRoot), "utf8");

expect(
  mainFile.includes("require_once KD_PAYMENTS_PLUGIN_DIR . 'includes/class-kd-payment-gateway.php'"),
  "the gateway is loaded with the plugin",
);
expect(
  mainFile.includes("require_once KD_PAYMENTS_PLUGIN_DIR . 'includes/class-kd-callback.php'"),
  "and so is the callback endpoint",
);
expect(
  mainFile.includes("add_filter( 'woocommerce_payment_gateways', 'kd_payments_register_gateways' )"),
  "the gateway is registered with WooCommerce",
);
expect(mainFile.includes("$gateways[] = 'KD_Payment_Gateway';"), "under its own class name");
expect(
  mainFile.indexOf("require_once KD_PAYMENTS_PLUGIN_DIR . 'includes/class-kd-payment-gateway.php'") >
    mainFile.indexOf("if ( ! class_exists( 'WooCommerce' ) )"),
  "and only after WooCommerce is known to exist, so the parent class cannot be missing",
);

expect(clientFile.includes("public function create_payment("), "the client creates a payment");
expect(clientFile.includes("public function payment_status( string $payment_id ): array"), "and reads one");
expect(
  clientFile.includes("'" + "idempotency-key' => $idempotency_key"),
  "the creation sends STEP 203's idempotency header",
);
expect(
  clientFile.includes("'amount_minor' => $amount_minor,") &&
    clientFile.includes("'currency'     => $currency,") &&
    clientFile.includes("'method'       => $method,"),
  "with exactly the three fields STEP 203 accepts, and no fourth",
);
expect(
  clientFile.includes("array( 'idempotency-key' => $idempotency_key )"),
  "and the key as a header rather than a body field",
);
expect(
  clientFile.includes("'replayed' => 'true' === wp_remote_retrieve_header( $response, 'idempotency-replayed' )"),
  "and reports a replay rather than hiding it",
);
expect(
  clientFile.includes("$this->payments_url() . '/' . rawurlencode( $payment_id )"),
  "the status read encodes the id it was given",
);

expect(gatewayFile.includes("class KD_Payment_Gateway extends WC_Payment_Gateway"), "the gateway extends WooCommerce's own");
expect(gatewayFile.includes("const CURRENCY = 'USD';"), "it charges in USD, the only currency the API accepts");
expect(
  gatewayFile.includes("if ( ! parent::is_available() ) {"),
  "WooCommerce's own availability rules come first",
);
expect(
  (gatewayFile.match(/'' === KD_Connection::api_key\(\)/gu) ?? []).length === 2,
  "and a missing key is refused in the setting and again in the checkout, because the order-pay screen skips the first",
);
expect(
  gatewayFile.includes("return get_woocommerce_currency() === self::CURRENCY;"),
  "and a shop in another currency does not see it at all",
);
expect(gatewayFile.includes("const MINIMUM_AMOUNT_MINOR = 50;"), "the platform's floor, pinned");
expect(gatewayFile.includes("const MAXIMUM_AMOUNT_MINOR = 10000000;"), "and its ceiling");
expect(
  gatewayFile.includes("$decimal = wc_format_decimal( $order->get_total(), 2 );"),
  "the total is read as a two-place string rather than multiplied as a float",
);
expect(
  gatewayFile.includes("'kd-wc-' . $order->get_id() . '-' . substr( $digest, 0, 16 )"),
  "the idempotency key is derived from the order, so a retried checkout is one payment",
);
expect(
  gatewayFile.includes("hash( 'sha256', $order->get_order_key() . '|' . (string) $amount . '|' . self::CURRENCY )"),
  "over the order key, the amount and the currency",
);
expect(gatewayFile.includes("const PAYMENT_ID_META = '_kd_payment_id';"), "the payment id is stored on the order");
expect(gatewayFile.includes("$order->set_status( 'on-hold',"), "the order waits on hold until the platform confirms");
expect(gatewayFile.includes("wc_reduce_stock_levels( $order_id );"), "with its stock reduced, as a real attempt does");
expect(gatewayFile.includes("$order->get_checkout_order_received_url()"), "and the customer is sent to the receipt");
expect(
  !gatewayFile.includes("card_number") && !gatewayFile.includes("$_POST['card"),
  "no card field is read, because the platform collects the card",
);
expect(
  gatewayFile.includes("if ( is_string( $existing ) && '' !== $existing )"),
  "a second submit of the same order does not create a second payment",
);

expect(
  callbackFile.includes("add_action( 'woocommerce_api_' . self::ROUTE, array( $this, 'handle' ) )"),
  "the callback is WooCommerce's own route",
);
expect(callbackFile.includes("const ROUTE = 'kd_payments_callback';"), "named what the platform calls, pinned");
expect(
  callbackFile.includes("hash_equals( $own, $header )"),
  "the token is compared in constant time",
);
expect(callbackFile.includes("'Bearer '") && callbackFile.includes("substr( $header, 7 )"), "with the bearer prefix removed");
expect(
  callbackFile.includes("if ( ! $this->is_authorised() ) {") &&
    callbackFile.indexOf("is_authorised()") < callbackFile.indexOf("file_get_contents( 'php://input' )"),
  "and checked before a byte of the body is read",
);
expect(callbackFile.includes("const MAXIMUM_BODY_BYTES = 65536;"), "the body has a ceiling, pinned");
expect(
  callbackFile.indexOf("strlen( $raw ) > self::MAXIMUM_BODY_BYTES") <
    callbackFile.indexOf("json_decode( $raw, true )"),
  "which is checked before the body is parsed",
);
expect(
  callbackFile.includes("array( 'created', 'id', 'object', 'payment', 'store', 'type' )"),
  "the envelope's six keys are the platform's six keys, pinned in the plugin",
);
expect(
  callbackFile.includes(
    "if ( array( 'created', 'id', 'object', 'payment', 'store', 'type' ) !== $this->sorted_keys( $envelope ) ) {",
  ),
  "compared whole and strictly, so a body missing one of them is refused rather than read",
);
expect(callbackFile.includes("'payment_callback' !== $envelope['object']"), "the object is checked");
expect(
  callbackFile.includes("const CALLBACK_ID_PATTERN = '/^cbt_[0-9a-f]{32}$/';"),
  "the callback id's shape is the platform's shape",
);
expect(
  callbackFile.includes("const PAYMENT_ID_PATTERN  = '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/';"),
  "and so is a payment id's",
);
expect(
  callbackFile.includes("$payment_id  = (string) $envelope['payment']['id'];"),
  "the payment id comes from the body's payment block",
);
expect(
  callbackFile.includes("'meta_query' => array(") &&
    callbackFile.includes("'key'     => KD_Payment_Gateway::PAYMENT_ID_META,"),
  "the order is found through the meta the gateway wrote, never through anything the body names",
);
expect(
  callbackFile.includes("'meta_key'     => KD_Payment_Gateway::PAYMENT_ID_META,"),
  "and asked twice, because WooCommerce's two order stores do not answer the same argument",
);
expect(
  callbackFile.includes(
    "if ( $payment_id === (string) $order->get_meta( KD_Payment_Gateway::PAYMENT_ID_META ) ) {",
  ),
  "while every candidate is verified against the payment id before it is used",
);
expect(
  callbackFile.includes("if ( array() !== $candidates ) {"),
  "and the second query is only asked when the first offers nothing",
);
expect(
  !callbackFile.includes("return $orders[0]") && !callbackFile.includes("$orders[0]"),
  "nothing takes the first row a query returned without checking it",
);
expect(
  callbackFile.includes("if ( $callback_id === $order->get_meta( KD_Payment_Gateway::CALLBACK_ID_META ) ) {"),
  "a callback already applied is not applied again",
);
expect(
  callbackFile.includes("$status = $this->confirmed_status_of( $payment_id );"),
  "the status is the platform's answer, asked server to server",
);
expect(
  callbackFile.includes("$client->payment_status( $payment_id )"),
  "with this shop's own key",
);
expect(
  callbackFile.includes("$this->respond( 503, array( 'handled' => false, 'reason' => 'platform_unavailable' ) );"),
  "and a platform that cannot be asked is a 503, so the callback comes back",
);
expect(
  callbackFile.includes("$this->respond( 200, array( 'handled' => false, 'reason' => 'order_not_found' ) );"),
  "an unknown order is answered 200 with handled false, so nothing retries it forever",
);
expect(
  callbackFile.includes("$order->payment_complete( $payment_id );"),
  "a paid payment goes through WooCommerce's own completion path",
);
expect(
  callbackFile.includes("if ( ! $order->is_paid() )"),
  "and an order that is already paid is not paid twice",
);
expect(
  callbackFile.includes("$order->set_status( 'failed'"),
  "a failed payment fails the order",
);
expect(
  callbackFile.includes("$order->update_meta_data( KD_Payment_Gateway::CALLBACK_ID_META, $callback_id );"),
  "the callback id is recorded on the order",
);
expect(
  callbackFile.includes("echo wp_json_encode( $payload );"),
  "the answer is encoded with WordPress's own encoder",
);
expect(callbackFile.includes("status_header( $status );"), "and the status through WordPress's helper");
expect(
  !callbackFile.includes("$envelope['payment']['status']"),
  "the body's status is never read, because the platform's answer is what decides",
);
expect(
  callbackFile.includes("'X-Robots-Tag: noindex'"),
  "the endpoint asks not to be indexed",
);
expect(
  !callbackFile.includes("KD_Connection::api_key() . $header") &&
    !callbackFile.includes("error_log") &&
    !callbackFile.includes("file_put_contents"),
  "and it writes no secret anywhere",
);

// --- the merchant's own test of the whole path -------------------------------------------------

const settingsFile = pluginSources.get("includes/class-kd-settings.php") ?? "";

expect(
  clientFile.includes("public function request_callback( string $payment_id ): array"),
  "the client can ask the platform to call this shop",
);
expect(
  clientFile.includes("return $this->payment_url( $payment_id ) . '/callback';"),
  "on the resource this STEP added, pinned",
);
expect(
  settingsFile.includes("add_action( 'admin_post_kd_payments_test_callback', array( $this, 'handle_test_callback' ) );"),
  "the screen has a handler for it",
);
expect(
  settingsFile.includes("public function handle_test_callback(): void {") &&
    settingsFile.includes("$result = $this->connection->test_callback();"),
  "which asks the connection to run the test",
);
expect(
  settingsFile.includes("<?php submit_button( __( 'Send a test callback', 'kd-payments' ), 'secondary', 'submit', false ); ?>"),
  "and a button a merchant can press",
);
expect(
  (settingsFile.match(/<form /gu) ?? []).length === (settingsFile.match(/wp_nonce_field\(/gu) ?? []).length,
  "every form on the screen, including this one, carries its own nonce",
);
expect(
  connectionFile.includes("public function test_callback(): array {"),
  "the connection owns the test",
);
expect(
  connectionFile.includes("$answer = $client->request_callback( $newest['payment_id'] );"),
  "against the newest payment the shop created",
);
expect(
  connectionFile.includes("'meta_key'   => KD_Payment_Gateway::PAYMENT_ID_META,") === false &&
    connectionFile.includes("$payment_id = (string) $order->get_meta( KD_Payment_Gateway::PAYMENT_ID_META );"),
  "found through the meta the gateway wrote, never guessed",
);
expect(
  connectionFile.includes("$delivered = isset( $answer['body']['delivered'] ) && true === $answer['body']['delivered'];"),
  "and the outcome the platform reports is what the screen shows",
);
expect(
  !connectionFile.includes("payment_complete") && !connectionFile.includes("set_status("),
  "nothing in the test path marks an order paid, because only the callback endpoint may, and only after asking the platform",
);

expect(
  connectionFile.includes("$path = wp_parse_url( home_url(), PHP_URL_PATH );") &&
    connectionFile.includes("$path = is_string( $path ) ? trim( $path, '/' ) : '';"),
  "the shop knows the path it is installed under, from its own address",
);
expect(
  connectionFile.includes("if ( '' !== self::install_path() ) {"),
  "and refuses to connect from a subdirectory",
);
expect(
  connectionFile.indexOf("if ( '' !== self::install_path() ) {") <
    connectionFile.indexOf("$answer = $client->connect( $domain, self::store_token() );"),
  "before it sends the handshake, not after",
);
expect(
  readme.includes("The shop must live at the root of its domain"),
  "which the readme says in the merchant's own words",
);

expect(readme.includes("wc-api=kd_payments_callback"), "the readme documents the callback address");
expect(readme.includes("hash_equals"), "and the constant-time comparison");
expect(readme.includes("USD"), "and the currency the gateway will not convert");

// ---------------------------------------------------------------------------------------------

/**
 * The depth of every bracket, brace and parenthesis in a PHP file, ignoring strings and comments.
 *
 * Not a parser: this environment has no PHP interpreter, so it cannot prove a file compiles. It catches the one class of
 * mistake a machine without PHP can catch - a missing or doubled delimiter - and the handoff says plainly that the
 * plugin was reviewed and not executed.
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
  process.stderr.write(`store callback gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `store callback gate passed: ${String(checkCount)} checks, one derived address per connected shop, the shop's ` +
      "own sealed token as the only credential, an envelope that never carries a secret, an outcome reported rather " +
      "than raised, and a plugin whose gateway creates the payment and whose endpoint verifies the token and asks the " +
      "platform before it touches an order\n",
  );
}
