// path: lib/api/verify-shopify-payment.ts
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import type { ZodType } from "zod";
import { createInMemoryAuditTrail, type AuditTrail, type InMemoryAuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { openSecret, sealSecret, type SecretBox } from "../auth/secrets.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { API_STORE_PAYMENT_STATUSES } from "./store-payment-status.ts";
import {
  STORE_CALLBACK_AUDIT,
  STORE_CALLBACK_AUTHORIZATION_HEADER,
  STORE_CALLBACK_BEARER_PREFIX,
  STORE_CALLBACK_ID_PATTERN,
  STORE_CALLBACK_ID_PREFIX,
  STORE_CALLBACK_OBJECT,
  STORE_CALLBACK_RULES,
  STORE_CALLBACK_SHOPIFY_PATH,
  STORE_CALLBACK_SHOPIFY_PROXY_PREFIX,
  storeCallbackUrlOf,
} from "./store-callback-fields.ts";
import { deliverStoreCallback } from "./store-callbacks.ts";
import {
  STORE_CONNECTION_TABLE,
  storeConnectionSecretContext,
} from "./store-connection-fields.ts";
import type { StoreWebhookTransportRequest } from "./store-webhooks.ts";
import {
  CALLBACK_BODY_MAXIMUM_BYTES,
  CALLBACK_ENVELOPE_KEYS,
  CALLBACK_ID_PATTERN,
  CALLBACK_PATH,
  CALLBACK_PAYMENT_STATUSES,
  CALLBACK_RULES,
  CALLBACK_SIGNATURE_MAXIMUM_AGE_SECONDS,
  proxySignatureOf,
} from "../../plugins/shopify/kd-payments-app/src/callback.mjs";
import {
  MAXIMUM_SESSION_PAYMENTS,
  PAYMENT_IDEMPOTENCY_KEY_PATTERN,
  PAYMENT_IDEMPOTENCY_KEY_PREFIX,
  PAYMENT_MAXIMUM_AMOUNT_MINOR,
  PAYMENT_MINIMUM_AMOUNT_MINOR,
  parseAmountMinor,
  parseOrderReference,
  paymentIdempotencyKeyOf,
} from "../../plugins/shopify/kd-payments-app/src/payments.mjs";
import { parseConfiguration } from "../../plugins/shopify/kd-payments-app/src/config.mjs";
import { hmacMessage, signMessage } from "../../plugins/shopify/kd-payments-app/src/shopify.mjs";
import { createApp } from "../../plugins/shopify/kd-payments-app/src/server.mjs";

/**
 * The gate for STEP 211: the Shopify app's payment and callback handling, and the platform's half of it.
 *
 * ## What this proves
 *
 *   - **No migration.** The payment is STEP 203's row, the connection is STEP 210's, and the callback is STEP 209's
 *     mechanism addressed by a second platform. This STEP adds an **address** and a **caller**, not a table.
 *   - **Two platforms, addressed by their own rows.** A WooCommerce shop is called at `?wc-api=...`; a Shopify shop is
 *     called at the App Proxy path its own platform gives it. Both are derived from `0035`'s stored domain, so a caller
 *     still cannot aim the platform's POST.
 *   - **The token opens under the row's platform.** STEP 208 sealed `woocommerce`, STEP 210 sealed `shopify`, and a box
 *     opened with the other platform's associated data does not open. STEP 209's service opened every box as
 *     `woocommerce`, which would have made a Shopify row a platform fault.
 *   - **The platform's own app agrees with the platform about the contract** - the path, the callback's id shape, the
 *     nine statuses and the envelope's six keys - and it is proved by comparing the two, not by reading either twice.
 *   - **The app is run**, over a real socket: install, login, payment creation with a derived idempotency key, the
 *     callback through a simulated App Proxy signature, its refusals, and the page that shows the outcome.
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

async function sourceOf(path: string): Promise<string> {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

const shopifyDomain = "kd-shop.myshopify.com";
const woocommerceDomain = "shop.example.com";
const otherCompanyId = "0192f0a1-7c3d-7000-8000-000000000099";
const companyId = "0192f0a1-7c3d-7000-8000-000000000001";
const credentialId = "0192f0a1-7c3d-7000-8000-000000000002";
const paymentId = "0192f0a1-7c3d-7000-8000-000000000021";
const masterKey = Buffer.alloc(32, 9).toString("base64");
const shopifyToken = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const startedAt = Date.UTC(2026, 10, 7, 10, 0, 0);

interface Fixture {
  readonly rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: { payments: Row[]; connections: Row[] };
  readonly queries: string[];
  readonly sent: StoreWebhookTransportRequest[];
  readonly opened: string[];
  replyStatus: number;
  brokenBox: boolean;
}

type Row = Record<string, unknown>;

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boxOf(domain: string, tenant: string, platform: "shopify" | "woocommerce"): SecretBox {
  return sealSecret(
    masterKey,
    shopifyToken,
    storeConnectionSecretContext({ companyId: tenant, platform, storeDomain: domain }),
  );
}

function connectionRow(
  domain: string,
  platform: "shopify" | "woocommerce",
  overrides: Row = {},
): Row {
  const tenant = typeof overrides["company_id"] === "string" ? overrides["company_id"] : companyId;
  const box = boxOf(domain, tenant, platform);

  return {
    id: "0192f0a1-7c3d-7000-8000-000000000011",
    company_id: tenant,
    platform,
    store_domain: domain,
    status: "active",
    external_store_id: `sc_${hashOf(`${tenant}|${platform}|${domain}`).slice(0, 32)}`,
    access_token_last_four: shopifyToken.slice(-4),
    access_token_ciphertext: box.ciphertext,
    access_token_iv: box.iv,
    access_token_tag: box.tag,
    encryption_key_version: 1,
    connected_at: new Date(startedAt).toISOString(),
    revoked_at: null,
    last_error: null,
    deleted_at: null,
    version: 1,
    ...overrides,
  };
}

const paymentRow: Row = {
  id: paymentId,
  company_id: companyId,
  invoice_id: null,
  deleted_at: null,
  status: "captured",
  amount_minor: 1999,
  refunded_minor: 0,
  currency: "USD",
  mode: "test",
  payment_method: "card",
  failure_code: null,
  created_at: new Date(startedAt).toISOString(),
  updated_at: new Date(startedAt).toISOString(),
};

/** A query string's `eq.` and `is.null` filters, which is all either read uses. */
function matchesRow(row: Row, query: string): boolean {
  for (const part of query.split("&")) {
    const index = part.indexOf("=");

    if (index < 0) {
      continue;
    }

    const key = part.slice(0, index);
    const value = part.slice(index + 1);

    if (key === "select" || key === "order" || key === "limit") {
      continue;
    }

    if (key === "platform" && value.startsWith("in.(")) {
      const allowed = value.slice(4, -1).split(",");

      if (!allowed.includes(String(row["platform"]))) {
        return false;
      }

      continue;
    }

    if (value === "is.null") {
      if (row[key] !== null && row[key] !== undefined) {
        return false;
      }

      continue;
    }

    if (value.startsWith("eq.") && String(row[key]) !== decodeURIComponent(value.slice(3))) {
      return false;
    }
  }

  return true;
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    payments: [paymentRow],
    connections: [connectionRow(shopifyDomain, "shopify")],
  };
  const queries: string[] = [];
  const sent: StoreWebhookTransportRequest[] = [];
  const opened: string[] = [];
  const audit = createInMemoryAuditTrail();

  const fixture: Fixture = {
    state,
    queries,
    sent,
    opened,
    audit,
    brokenBox: false,
    replyStatus: 200,
    rest: {
      async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
        queries.push(`${table}?${query}`);

        if (table !== STORE_CONNECTION_TABLE && table !== "payments") {
          throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
        }

        const rows = table === STORE_CONNECTION_TABLE ? state.connections : state.payments;
        const limit = Number.parseInt(/limit=([0-9]+)/u.exec(query)?.[1] ?? "50", 10);

        return rows
          .filter((row) => matchesRow(row, query))
          .slice(0, Number.isFinite(limit) ? limit : 50)
          .map((row) => schema.parse(row));
      },

      insert: async (): Promise<void> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_inserts_nothing" } });
      },

      insertReturning: async <TRow>(): Promise<readonly TRow[]> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_inserts_nothing" } });
      },

      update: async (): Promise<void> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_updates_nothing" } });
      },

      rpc: async (): Promise<unknown> => {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "this_step_calls_nothing" } });
      },
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
      fixture.opened.push(context);

      if (fixture.brokenBox) {
        throw new Error("the box will not open");
      }

      return openSecret(masterKey, box, context);
    },
    send: async (request: StoreWebhookTransportRequest): Promise<{ status: number }> => {
      fixture.sent.push(request);

      return { status: fixture.replyStatus };
    },
  };
}

const inputOf = (
  overrides: Record<string, unknown> = {},
): Parameters<typeof deliverStoreCallback>[0] => ({
  paymentId,
  principal: {
    credentialId,
    companyId,
    companyName: "Example",
    mode: "test",
    label: "Test key",
    keyPrefix: "shopify",
    keyLastFour: "abcd",
    lastUsedRefreshed: true,
  },
  clientAddress: "203.0.113.5",
  ...overrides,
});

// ---------------------------------------------------------------- 1. no migration

const migrationFiles = (await readdir(new URL("../../migrations/", import.meta.url))).filter(
  (name) => name.endsWith(".sql") && !name.endsWith(".down.sql"),
);

expectEqual(migrationFiles.length, 128, "no migration: the next free number is still 129");
expectEqual(
  migrationFiles.filter((name) => name.includes("shopify") || name.includes("callback")).length,
  0,
  "and none of the 128 is a Shopify or callback migration",
);

const connectionMigration = await sourceOf("migrations/0035_store_connections.sql");

expect(
  connectionMigration.includes("store the platform will call") ||
    connectionMigration.includes("the platform will call the store with"),
  "0035 still says what the sealed column is for, which is the call this STEP makes",
);
expect(
  connectionMigration.includes("shopify") && connectionMigration.includes("woocommerce"),
  "and it already names both platforms, so neither needed a migration",
);

const tableCount = (
  await Promise.all(
    migrationFiles.map(async (name) => {
      const text = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

      return (text.match(/create table/gu) ?? []).length;
    }),
  )
).reduce((total, count) => total + count, 0);

expectEqual(tableCount, 99, "and the tree still creates ninety-nine tables");

// ---------------------------------------------------------------- 2. the address, for both platforms

expectEqual(STORE_CALLBACK_SHOPIFY_PROXY_PREFIX, "/apps/kd-payments", "the app's proxy prefix, pinned");
expectEqual(
  STORE_CALLBACK_SHOPIFY_PATH,
  "/apps/kd-payments/callbacks/payment",
  "the callback's path behind the proxy, pinned",
);
expectEqual(
  storeCallbackUrlOf("shopify", shopifyDomain),
  "https://kd-shop.myshopify.com/apps/kd-payments/callbacks/payment",
  "a Shopify shop is called at its own domain and its own platform's path",
);
expectEqual(
  storeCallbackUrlOf("woocommerce", woocommerceDomain),
  "https://shop.example.com/?wc-api=kd_payments_callback",
  "and a WooCommerce shop is still called where STEP 209 put it",
);
expect(
  storeCallbackUrlOf("shopify", shopifyDomain).startsWith("https://") &&
    storeCallbackUrlOf("woocommerce", woocommerceDomain).startsWith("https://"),
  "both are https, and neither is http",
);
expect(
  !storeCallbackUrlOf("shopify", shopifyDomain).includes("wc-api"),
  "and the two platforms do not borrow each other's route",
);

const callbackFieldsSource = await sourceOf("lib/api/store-callback-fields.ts");
const callbackServiceSource = await sourceOf("lib/api/store-callbacks.ts");

expect(
  callbackFieldsSource.includes("export function storeCallbackUrlOf(platform: StoreConnectionPlatform"),
  "the address is a function of the platform and the domain, and of nothing a caller sent",
);
expect(
  callbackServiceSource.includes('`&platform=in.(${STORE_CONNECTION_PLATFORMS.join(",")})&deleted_at=is.null`'),
  "the connection read asks for both platforms in one query",
);
expect(
  callbackServiceSource.includes("storeCallbackUrlOf(connection.platform, connection.store_domain)"),
  "and the address comes from the row's own platform",
);
expect(
  !callbackServiceSource.includes("storeCallbackUrlOf(connection.store_domain)"),
  "never from the domain alone",
);
expect(
  callbackServiceSource.includes("platform: connection.platform"),
  "the token is opened under the row's own platform",
);
expect(
  !callbackServiceSource.includes("platform: STORE_CONNECTION_PLATFORM"),
  "and not under STEP 209's constant, which would refuse every Shopify row",
);

expectEqual(STORE_CALLBACK_RULES.connectionAmbiguous, "connection_ambiguous", "the rules are unchanged, pinned");
expectEqual(`${STORE_CALLBACK_ID_PREFIX}${"0".repeat(32)}`.length, 36, "the callback id is the prefix and thirty-two hex");
expect(CALLBACK_ID_PATTERN.source === STORE_CALLBACK_ID_PATTERN.source, "and the app's pattern is the platform's pattern");

// ---------------------------------------------------------------- 3. the platform, delivering to each

const shopifyFixture = createFixture();
const shopifyDelivered = await deliverStoreCallback(
  inputOf(),
  dependenciesOf(shopifyFixture),
);

expectEqual(shopifyDelivered.delivered, true, "a Shopify connection is called");
expectEqual(shopifyFixture.sent.length, 1, "exactly once");
expectEqual(
  shopifyFixture.sent[0]?.url,
  `https://${shopifyDomain}/apps/kd-payments/callbacks/payment`,
  "at the App Proxy path on the shop's own host",
);
expectEqual(
  shopifyFixture.sent[0]?.headers[STORE_CALLBACK_AUTHORIZATION_HEADER],
  `${STORE_CALLBACK_BEARER_PREFIX}${shopifyToken}`,
  "carrying the shop's own sealed token, opened under `shopify`",
);
expectEqual(
  shopifyFixture.opened[0],
  storeConnectionSecretContext({ companyId, platform: "shopify", storeDomain: shopifyDomain }),
  "and the associated data names the row's platform, pinned",
);
expectEqual(shopifyDelivered.endpoint_host, shopifyDomain, "the outcome names the shop's host");
expectEqual(shopifyDelivered.type, "payment.captured", "the type is the payment's own state");
expectEqual(
  shopifyDelivered.id,
  `${STORE_CALLBACK_ID_PREFIX}${hashOf(`${companyId}|${paymentId}|payment.captured`).slice(0, 32)}`,
  "and the id is a hash the gate recomputes itself",
);

const shopifyBody = JSON.parse(String(shopifyFixture.sent[0]?.body)) as Record<string, unknown>;

expectEqual(Object.keys(shopifyBody).join(","), "id,object,type,created,payment,store", "the envelope's six keys, in order");
expectEqual(shopifyBody["object"], STORE_CALLBACK_OBJECT, "and the object name");
expectEqual(
  (shopifyBody["store"] as Record<string, unknown>)["domain"],
  shopifyDomain,
  "the store block names the shop that was called",
);
expect(!JSON.stringify(shopifyBody).includes(shopifyToken), "and no token is in the body");

const shopifyAudit = shopifyFixture.audit.entries ?? [];
const shopifyEntry = shopifyAudit[shopifyAudit.length - 1];

expectEqual(shopifyEntry?.action, STORE_CALLBACK_AUDIT.delivered, "the chain records the delivery");
expectEqual(shopifyEntry?.payload["store_domain"], shopifyDomain, "with the shop");
expectEqual(shopifyEntry?.payload["endpoint_host"], shopifyDomain, "and the host the platform called");
expect(!JSON.stringify(shopifyEntry ?? {}).includes(shopifyToken), "and never the token");

const woocommerceFixture = createFixture();

woocommerceFixture.state.connections = [connectionRow(woocommerceDomain, "woocommerce")];

const woocommerceDelivered = await deliverStoreCallback(
  inputOf(),
  dependenciesOf(woocommerceFixture),
);

expectEqual(woocommerceDelivered.delivered, true, "a WooCommerce connection is still called");
expectEqual(
  woocommerceFixture.sent[0]?.url,
  "https://shop.example.com/?wc-api=kd_payments_callback",
  "at the address STEP 209 gave it",
);

const wrongPlatformFixture = createFixture();

// The token is sealed under the other platform's associated data: the row says shopify, the box says woocommerce.
const woocommerceBox = boxOf(shopifyDomain, companyId, "woocommerce");

wrongPlatformFixture.state.connections = [
  connectionRow(shopifyDomain, "shopify", {
    access_token_ciphertext: woocommerceBox.ciphertext,
    access_token_iv: woocommerceBox.iv,
    access_token_tag: woocommerceBox.tag,
  }),
];

const wrongPlatform = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(wrongPlatformFixture)),
);

expectEqual(
  wrongPlatform.rule,
  STORE_CALLBACK_RULES.connectionTokenUnavailable,
  "a box sealed under the other platform does not open",
);
expectEqual(wrongPlatformFixture.sent.length, 0, "and nothing is sent rather than a token that was never opened");

const mixedFixture = createFixture();

mixedFixture.state.connections = [
  connectionRow(shopifyDomain, "shopify"),
  connectionRow(woocommerceDomain, "woocommerce"),
];

const mixed = await refusalOf(async () => deliverStoreCallback(inputOf(), dependenciesOf(mixedFixture)));

expectEqual(mixed.rule, STORE_CALLBACK_RULES.connectionAmbiguous, "two active shops across two platforms are ambiguous");
expectEqual(mixedFixture.sent.length, 0, "and neither is called at a guess");

const revokedShopifyFixture = createFixture();

revokedShopifyFixture.state.connections = [
  connectionRow(shopifyDomain, "shopify", { status: "revoked", revoked_at: new Date(startedAt).toISOString() }),
];

const revokedShopify = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(revokedShopifyFixture)),
);

expectEqual(revokedShopify.rule, STORE_CALLBACK_RULES.connectionRevoked, "a revoked Shopify shop says so");

const foreignShopFixture = createFixture();

foreignShopFixture.state.connections = [
  connectionRow(shopifyDomain, "shopify", { company_id: otherCompanyId }),
];

const foreignShop = await refusalOf(async () =>
  deliverStoreCallback(inputOf(), dependenciesOf(foreignShopFixture)),
);

expectEqual(foreignShop.rule, STORE_CALLBACK_RULES.connectionMissing, "and another merchant's Shopify shop is not yours");

const refundedFixture = createFixture();

refundedFixture.state.payments = [{ ...paymentRow, status: "refunded" }];

const refunded = await deliverStoreCallback(inputOf(), dependenciesOf(refundedFixture));

expectEqual(refunded.type, "payment.refunded", "a refund gets its own type");
expect(refunded.id !== shopifyDelivered.id, "and its own callback id, so a shop does not dedupe it away");

const unreachableShopifyFixture = createFixture();

unreachableShopifyFixture.replyStatus = 503;

const unreachable = await deliverStoreCallback(inputOf(), dependenciesOf(unreachableShopifyFixture));

expectEqual(unreachable.delivered, false, "a shop that answers 503 is not delivered");
expectEqual(unreachable.status_code, 503, "and its own status is reported as the outcome");

const shopQuery = shopifyFixture.queries.find((query) => query.startsWith(`${STORE_CONNECTION_TABLE}?`)) ?? "";

expect(shopQuery.includes("platform=in.(shopify,woocommerce)"), "the read names both platforms");
expect(shopQuery.includes("&deleted_at=is.null"), "and refuses a soft-deleted row");
expect(!shopQuery.includes("access_token_ciphertext=eq."), "and never filters on the ciphertext");

// ---------------------------------------------------------------- 4. the app's files

const appDirectory = new URL("../../plugins/shopify/kd-payments-app/src/", import.meta.url);
const appFiles = (await readdir(appDirectory)).filter((name) => name.endsWith(".mjs")).sort();

expectEqual(
  appFiles.join(","),
  "callback.mjs,config.mjs,copy.mjs,payments.mjs,platform.mjs,screen.mjs,server.mjs,session.mjs,shopify.mjs",
  "the app is nine modules, and there is no tenth",
);

const appSources = new Map<string, string>();

for (const file of appFiles) {
  appSources.set(file, await readFile(new URL(file, appDirectory), "utf8"));
}

for (const [file, source] of appSources) {
  expect(source.startsWith(`// path: plugins/shopify/kd-payments-app/src/${file}`), `${file}: starts with its path`);
  expect(!/\bconsole\./u.test(source), `${file}: and writes no console line`);
  expect(!source.includes("process.env"), `${file}: reads no environment variable`);
  const evalPattern = new RegExp("\\b" + "ev" + "al\\(", "u");

  expect(!evalPattern.test(source), `${file}: and evaluates no string`);
  for (const marker of ["TO" + "DO", "FIX" + "ME"]) {
    const pattern = new RegExp(`\\b${marker}\\b`, "u");

    expect(!pattern.test(source), `${file}: and carries no ${marker.toLowerCase()} placeholder`);
  }
}

const paymentsSource = appSources.get("payments.mjs") ?? "";
const callbackSource = appSources.get("callback.mjs") ?? "";
const serverSource = appSources.get("server.mjs") ?? "";
const screenSource = appSources.get("screen.mjs") ?? "";
const copySource = appSources.get("copy.mjs") ?? "";
const platformSource = appSources.get("platform.mjs") ?? "";

expect(paymentsSource.includes('export const PAYMENT_PATH = "/api/public/v1/payments"'), "the payment resource, spelled once");
expect(platformSource.includes('import { PAYMENT_PATH } from "./payments.mjs"'), "and the client imports it rather than repeating it");
expectEqual(PAYMENT_IDEMPOTENCY_KEY_PREFIX, "kd-shopify-", "the key says where the payment came from");
expect(PAYMENT_IDEMPOTENCY_KEY_PATTERN.test(paymentIdempotencyKeyOf({
  shop: shopifyDomain,
  orderId: "1001",
  amountMinor: 1999,
})), "and a derived key satisfies the platform's pattern");
expect(!paymentsSource.includes("Math.round"), "money is never rounded, because it is never a float");
expect(!paymentsSource.includes("parseFloat"), "and never parsed as one");
expectEqual(PAYMENT_MINIMUM_AMOUNT_MINOR, 50, "the platform's floor, mirrored");
expectEqual(PAYMENT_MAXIMUM_AMOUNT_MINOR, 10_000_000, "and its ceiling");
expectEqual(MAXIMUM_SESSION_PAYMENTS, 5, "and a session keeps five payments");
expect(platformSource.includes('const IDEMPOTENCY_HEADER = "idempotency-key"'), "the key travels in its own header");
expect(platformSource.includes('body: { amount_minor: amountMinor, currency: "USD", payment_method: "card" }'), "and the body is the platform's three fields");

expectEqual(parseAmountMinor("19.99"), 1999, "an amount is read from its decimal string, exactly");
expectEqual(parseAmountMinor("1"), 100, "a whole unit is a hundred, not one");
expectEqual(parseAmountMinor("0.5"), 50, "and a half is fifty, not five");
expectEqual(parseOrderReference("1001").orderGid, "gid://shopify/Order/1001", "an order id becomes its global id");
expectEqual(
  parseOrderReference("gid://shopify/Order/1001").orderId,
  "1001",
  "and a global id is read back to the number a merchant recognises",
);

expectEqual(CALLBACK_PATH, "/callbacks/payment", "the app's callback path, pinned");
expectEqual(
  STORE_CALLBACK_SHOPIFY_PATH,
  `${STORE_CALLBACK_SHOPIFY_PROXY_PREFIX}${CALLBACK_PATH}`,
  "and the platform's path is the proxy prefix plus exactly this path",
);
expectEqual(CALLBACK_BODY_MAXIMUM_BYTES, 16_384, "the callback's body ceiling matches the platform's envelope budget");
expectEqual(CALLBACK_SIGNATURE_MAXIMUM_AGE_SECONDS, 300, "and a proxy signature is five minutes old at most");
expectEqual(
  CALLBACK_PAYMENT_STATUSES.join(","),
  API_STORE_PAYMENT_STATUSES.join(","),
  "the app's nine payment states are the platform's nine, in its order",
);
expectEqual(
  CALLBACK_ENVELOPE_KEYS.join(","),
  "created,id,object,payment,store,type",
  "the envelope's six keys, sorted, pinned",
);
expect(
  callbackSource.includes('Object.keys(document).sort().join(",") !== CALLBACK_ENVELOPE_KEYS.join(",")'),
  "and compared whole rather than by membership",
);
expect(
  callbackSource.includes("!sameSignature(presented.toLowerCase(), proxySignatureOf(query, secret))"),
  "the proxy signature is compared in constant time, and a mismatch is a refusal",
);
expect(
  callbackSource.includes('entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));'),
  "the signature's message is sorted by name, ascending, pinned as the comparator itself",
);
expect(
  callbackSource.includes('const message = entries.map(([key, value]) => `${key}=${value}`).join("&");'),
  "and joined as the query pairs Shopify documents, not as the install HMAC",
);
expect(!callbackSource.includes("authorization"), "the callback needs no bearer token: Shopify's proxy signature is the proof");
expect(callbackSource.includes('applied: false'), "and nothing in this app claims to have moved an order");

expect(serverSource.includes('paymentCallback: CALLBACK_PATH'), "the server routes the callback path from the module's constant");
expect(
  serverSource.indexOf("url.pathname === PATHS.paymentCallback") <
    serverSource.indexOf("url.pathname === PATHS.install"),
  "and answers it before anything session-bound",
);
expect(
  serverSource.includes("secret: config.shopifyApiSecret") &&
    serverSource.includes("outcomes,") &&
    serverSource.includes("now,"),
  "with the app's own secret, the outcome store and the clock, injected",
);
expect(
  serverSource.includes("paymentIdempotencyKeyOf({ shop, orderId: order.orderId, amountMinor })"),
  "a payment's key is derived from the shop, the order and the amount",
);
expect(
  serverSource.includes("const amountMinor = parseAmountMinor(form.get(\"amount\") ?? \"\")") &&
    serverSource.includes("const order = parseOrderReference(form.get(\"order\") ?? \"\")"),
  "and both values are parsed before the platform is called",
);
expect(
  serverSource.includes("outcomes.forStore(shop)"),
  "the page shows only the shop's own outcomes",
);
expect(
  screenSource.includes("paymentForm") && screenSource.includes("outcomeList"),
  "the screen renders the payment form and the outcomes",
);
expect(
  (screenSource.match(/<label for=/gu) ?? []).length === (screenSource.match(/<input id=/gu) ?? []).length,
  "every field the payment and connection forms draw has a label bound to it",
);
expect(
  copySource.includes("paymentCreated:") && copySource.includes("paymentRefused:"),
  "and every sentence it says is a catalog entry",
);
expect(
  copySource.includes('title: "The platform created the payment"') &&
    copySource.includes('"Callbacks the platform has sent"'),
  "with the two sentences this STEP adds, pinned where they live",
);
expect(
  !screenSource.includes("That payment was not created") && !serverSource.includes("That payment was not created"),
  "which is written nowhere but the catalog",
);

// ---------------------------------------------------------------- 5. the contract, both ways

const envelopeInterface =
  /export interface StoreCallbackEnvelope \{([\s\S]*?)\n\}/u.exec(callbackFieldsSource)?.[1] ?? "";
const platformEnvelopeKeys = [...envelopeInterface.matchAll(/^ {2}readonly (\w+):/gmu)].map((match) => match[1]).sort();

expectEqual(
  platformEnvelopeKeys.join(","),
  CALLBACK_ENVELOPE_KEYS.join(","),
  "the platform's envelope type and the app's key list name the same six fields",
);
expect(
  callbackFieldsSource.includes("export const STORE_CALLBACK_ID_PREFIX = \"cbt_\"") &&
    CALLBACK_ID_PATTERN.source === STORE_CALLBACK_ID_PATTERN.source,
  "and the callback id's shape is one pattern, held by both",
);

// ---------------------------------------------------------------- 6. the app, over a socket

const appSecret = "client-secret-for-the-gate-run-0123456789";
const appSessionSecret = "session-seed-for-the-gate-run-0123456789abcdef";
const apiKey = `kd_test_gate_${"a".repeat(64)}`;
const createdPaymentId = "0192f0a1-7c3d-7000-8000-000000000021";
const oversizedBody = 20_000;
const calls: { url: string; method: string; headers: Record<string, string>; body: string | undefined }[] = [];
const nowMs = Date.now();

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = init?.body === undefined ? undefined : String(init.body);
  const headers = (init?.headers ?? {}) as Record<string, string>;

  calls.push({ url, method: init?.method ?? "GET", headers, body });

  const json = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

  if (url.endsWith("/admin/oauth/access_token")) {
    return json(200, { access_token: `shpat_${"b".repeat(32)}`, scope: "write_payments" });
  }

  if (url === "https://platform.invalid/api/public/v1/stores/shopify/connection") {
    return json(201, {
      store_domain: shopifyDomain,
      status: "active",
      store_token_last_four: "f90",
      reused: false,
    });
  }

  if (url === "https://platform.invalid/api/public/v1/payments") {
    return json(201, {
      id: createdPaymentId,
      object: "payment",
      status: "pending",
      amount_minor: 1999,
      currency: "USD",
      mode: "test",
      payment_method: "card",
      created_at: new Date(nowMs).toISOString(),
    });
  }

  if (url.endsWith(`/payments/${createdPaymentId}`)) {
    return json(200, { ...paymentRow, status: "captured", refunded_minor: 0, failure_code: null });
  }

  return json(404, { error: "not_found" });
};

const appConfig = parseConfiguration({
  platformBaseUrl: "https://platform.invalid",
  appUrl: "https://app.invalid",
  shopifyApiKey: "client-id-for-the-gate-run-0123456789",
  shopifyApiSecret: appSecret,
  sessionSecret: appSessionSecret,
  scopes: ["write_payments"],
  sessionTtlSeconds: 600,
  port: 1,
});

const app = createApp({ config: appConfig, fetchImpl: fakeFetch, now: (): number => nowMs });
const server = createServer((request, response) => {
  void app(request, response);
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
const baseUrl = `http://127.0.0.1:${String(typeof address === "object" && address !== null ? address.port : 0)}`;

interface Answer {
  readonly status: number;
  readonly text: string;
  readonly cookie: string;
  readonly headers: Headers;
}

async function call(
  path: string,
  options: {
    method?: string;
    form?: Record<string, string>;
    cookie?: string;
    body?: string;
    contentType?: string;
  } = {},
): Promise<Answer> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.form === undefined
        ? {}
        : { "content-type": "application/x-www-form-urlencoded" }),
      ...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    ...(options.form === undefined ? {} : { body: new URLSearchParams(options.form).toString() }),
    ...(options.body === undefined ? {} : { body: options.body }),
    redirect: "manual",
  });

  const text = await response.text();

  return {
    status: response.status,
    text,
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    headers: response.headers,
  };
}

const csrfOf = (html: string): string => /name="csrf" value="([^"]+)"/u.exec(html)?.[1] ?? "";
const seconds = Math.floor(nowMs / 1_000);

try {
  const installQuery = new URLSearchParams({
    shop: shopifyDomain,
    host: "gate",
    timestamp: String(seconds),
  });

  installQuery.set("hmac", signMessage(hmacMessage([...installQuery.entries()]), appSecret));

  const install = await call(`/auth/install?${installQuery.toString()}`);
  const authorizeLocation = install.headers.get("location") ?? "";
  const state = new URL(authorizeLocation).searchParams.get("state") ?? "";

  expectEqual(install.status, 302, "the app starts Shopify's install");
  expect(state.length > 0, "with a state it minted");

  const callbackQuery = new URLSearchParams({
    code: "gate-code",
    shop: shopifyDomain,
    state,
    timestamp: String(seconds),
  });

  callbackQuery.set("hmac", signMessage(hmacMessage([...callbackQuery.entries()]), appSecret));

  const completed = await call(`/auth/callback?${callbackQuery.toString()}`, { cookie: install.cookie });

  expectEqual(completed.status, 302, "the callback is accepted");
  expect(completed.cookie !== install.cookie, "and the session identifier is rotated");

  const loginPage = await call("/", { cookie: completed.cookie });

  expectEqual(loginPage.status, 200, "the login page is served");
  expect(loginPage.text.includes("Log in with your platform credentials"), "and asks for the key");

  const login = await call("/login", {
    method: "POST",
    cookie: completed.cookie,
    form: { csrf: csrfOf(loginPage.text), api_key: apiKey, shop: shopifyDomain },
  });

  expectEqual(login.status, 200, "the login connects the shop");
  expect(login.text.includes("Connected"), "and the page says so");
  expect(!login.text.includes(`shpat_${"b".repeat(32)}`), "with no Shopify token anywhere on it");

  const connectedPage = await call("/", { cookie: login.cookie });
  const csrf = csrfOf(connectedPage.text);

  expect(connectedPage.text.includes("Create a payment for a Shopify order"), "the payment form is offered after login");

  const created = await call("/payments", {
    method: "POST",
    cookie: login.cookie,
    form: { csrf, shop: shopifyDomain, order: "1001", amount: "19.99", api_key: apiKey },
  });

  const createCall = calls.find((entry) => entry.url.endsWith("/api/public/v1/payments"));
  const createBody = JSON.parse(createCall?.body ?? "{}") as Record<string, unknown>;

  expectEqual(created.status, 200, "a payment is created");
  expect(created.text.includes("1001"), "and the order it was for is on the page");
  expectEqual(createCall?.method, "POST", "with a POST to the platform's payment resource");
  expectEqual(createCall?.headers["authorization"], `Bearer ${apiKey}`, "the merchant's key as a bearer header");
  expectEqual(createCall?.headers["idempotency-key"], paymentIdempotencyKeyOf({
    shop: shopifyDomain,
    orderId: "1001",
    amountMinor: 1999,
  }), "and the derived idempotency key");
  expectEqual(Object.keys(createBody).sort().join(","), "amount_minor,currency,payment_method", "the body is three fields");
  expectEqual(createBody["amount_minor"], 1999, "1999 minor units, exactly");
  expectEqual(createBody["currency"], "USD", "in the one currency the platform charges");
  expectEqual(createBody["payment_method"], "card", "by card");

  const replay = await call("/payments", {
    method: "POST",
    cookie: login.cookie,
    form: { csrf, shop: shopifyDomain, order: "1001", amount: "19.99", api_key: apiKey },
  });
  const replayCall = calls.filter((entry) => entry.url.endsWith("/api/public/v1/payments"))[1];

  expectEqual(replay.status, 200, "the same order and amount can be submitted twice");
  expectEqual(
    replayCall?.headers["idempotency-key"],
    createCall?.headers["idempotency-key"],
    "and the second attempt carries the first attempt's key, so the platform replays instead of charging",
  );

  const badAmount = await call("/payments", {
    method: "POST",
    cookie: login.cookie,
    form: { csrf, shop: shopifyDomain, order: "1001", amount: "19.999", api_key: apiKey },
  });

  expectEqual(badAmount.status, 400, "three decimal places are refused");
  expect(badAmount.text.includes("amount_malformed"), "by the rule that names the mistake");
  expectEqual(
    calls.filter((entry) => entry.url.endsWith("/api/public/v1/payments")).length,
    2,
    "and nothing reached the platform for it",
  );

  const badOrder = await call("/payments", {
    method: "POST",
    cookie: login.cookie,
    form: { csrf, shop: shopifyDomain, order: "../../etc/passwd", amount: "1.00", api_key: apiKey },
  });

  expectEqual(badOrder.status, 400, "an order that is not an id is refused");
  expect(badOrder.text.includes("order_malformed"), "with its own rule");

  const refresh = await call("/payments/refresh", {
    method: "POST",
    cookie: login.cookie,
    form: { csrf, shop: shopifyDomain, api_key: apiKey },
  });

  expectEqual(refresh.status, 200, "the statuses can be refreshed");
  expect(refresh.text.includes("captured"), "and the platform's fresh status is shown");
  expectEqual(
    calls.filter((entry) => entry.url.includes(`/payments/${createdPaymentId}`)).length,
    1,
    "one read per payment this session created",
  );

  const envelope = {
    id: `cbt_${"c".repeat(32)}`,
    object: "payment_callback",
    type: "payment.captured",
    created: seconds,
    payment: { ...paymentRow, failure_code: null },
    store: { domain: shopifyDomain, external_store_id: null },
  };

  const proxyQuery = (signature?: string): string => {
    const query = new URLSearchParams({
      shop: shopifyDomain,
      path_prefix: STORE_CALLBACK_SHOPIFY_PROXY_PREFIX,
      timestamp: String(seconds),
    });

    query.set("signature", signature ?? proxySignatureOf(query, appSecret));

    return query.toString();
  };

  const callback = async (
    payload: unknown,
    query: string = proxyQuery(),
  ): Promise<Answer> =>
    call(`${CALLBACK_PATH}?${query}`, {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(payload),
    });

  const delivered = await callback(envelope);

  expectEqual(delivered.status, 200, "the platform's callback is accepted through a signed proxy query");
  expect(delivered.text.includes('"duplicate":false'), "and it is new");
  expect(delivered.text.includes('"applied":false'), "and nothing claims to have moved an order");

  const duplicate = await callback(envelope);

  expectEqual(duplicate.status, 200, "a redelivery is accepted too");
  expect(duplicate.text.includes('"duplicate":true'), "and recognised as the same callback");

  expectEqual((await callback(envelope, proxyQuery("0".repeat(64)))).status, 401, "a forged signature is refused");

  const staleQuery = new URLSearchParams({
    shop: shopifyDomain,
    path_prefix: STORE_CALLBACK_SHOPIFY_PROXY_PREFIX,
    timestamp: String(seconds - CALLBACK_SIGNATURE_MAXIMUM_AGE_SECONDS - 60),
  });

  staleQuery.set("signature", proxySignatureOf(staleQuery, appSecret));

  expectEqual((await callback(envelope, staleQuery.toString())).status, 401, "and a stale one is a replay, refused");

  const unsignedQuery = new URLSearchParams({ shop: shopifyDomain, timestamp: String(seconds) });

  expectEqual((await callback(envelope, unsignedQuery.toString())).status, 401, "and an unsigned one has no signature");

  const otherShop = await callback({
    ...envelope,
    id: `cbt_${"d".repeat(32)}`,
    store: { domain: "another-shop.myshopify.com", external_store_id: null },
  });

  expectEqual(otherShop.status, 400, "a body naming another shop is refused");
  expect(otherShop.text.includes(CALLBACK_RULES.shopMismatch), "by the rule that says so");

  const extraKey = await callback({ ...envelope, id: `cbt_${"e".repeat(32)}`, extra: true });

  expectEqual(extraKey.status, 400, "a seventh key is refused");
  expect(extraKey.text.includes(CALLBACK_RULES.envelopeMalformed), "as a malformed envelope");

  const wrongObject = await callback({ ...envelope, id: `cbt_${"f".repeat(32)}`, object: "event" });

  expectEqual(wrongObject.status, 400, "and so is another object's envelope");

  const mismatchedStatus = await callback({
    ...envelope,
    id: `cbt_${"1".repeat(32)}`,
    payment: { ...paymentRow, status: "refunded", failure_code: null },
  });

  expectEqual(mismatchedStatus.status, 400, "a payment whose status disagrees with the type is refused");

  const swallowedBody = await call(`${CALLBACK_PATH}?${proxyQuery()}`, {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ ...envelope, id: `cbt_${"2".repeat(32)}`, pad: "x".repeat(oversizedBody) }),
  });

  expectEqual(swallowedBody.status, 413, "a body past the ceiling is refused before it is parsed");

  expectEqual((await call(`${CALLBACK_PATH}?${proxyQuery()}`)).status, 405, "and only POST reaches it");
  expectEqual((await call(`${CALLBACK_PATH}?${proxyQuery()}`, {
    method: "POST",
    contentType: "application/json",
    body: "",
  })).status, 400, "an empty body is not an envelope");

  const after = await call("/", { cookie: login.cookie });

  expect(after.text.includes("cbt_"), "the page lists the callback that arrived");
  expect(after.text.includes("captured"), "with the status the platform reported");
  expect(!after.text.includes(`shpat_${"b".repeat(32)}`), "and no token, still");
  expect(!after.text.includes("another-shop.myshopify.com"), "and no other shop's callback");

  const unknownPath = await call("/nope");

  expectEqual(unknownPath.status, 404, "an unknown path is a 404");
} finally {
  server.close();
}

// ---------------------------------------------------------------- the verdict

if (failures.length > 0) {
  process.stderr.write(`shopify payment gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `shopify payment gate passed: ${String(checkCount)} checks, a callback addressed by the platform it was made on, ` +
      "a Shopify token opened only under a Shopify row, a WooCommerce shop still called where STEP 209 put it, an app " +
      "that derives its idempotency key from the order rather than the clock, reads money as a string, verifies " +
      "Shopify's proxy signature in constant time and never claims to have moved an order, and one contract - path, " +
      "id shape, nine states and six keys - that the platform and its app are proved to share\n",
  );
}
