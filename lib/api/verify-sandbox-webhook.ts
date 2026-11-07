// path: lib/api/verify-sandbox-webhook.ts
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import {
  createInMemoryAuditTrail,
  type AuditEntry,
  type AuditTrail,
  type InMemoryAuditTrail,
} from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { openSecret, sealSecret, type SecretBox } from "../auth/secrets.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { credentialSecretContext } from "./credential-fields.ts";
import { PUBLIC_API_BASE, PUBLIC_API_VERSION, PUBLIC_API_VERSION_HEADER } from "./public-fields.ts";
import { handlePublicApiCall } from "./public-api.ts";
import {
  API_PAYMENT_ID_MAXIMUM_LENGTH,
  API_PAYMENT_STATUS_COLUMNS,
  API_PAYMENT_STATUS_FIELD,
  API_PAYMENT_STATUS_RULES,
  API_STORE_PAYMENT_STATUSES,
  paymentStatusPathOf,
} from "./store-payment-status.ts";
import {
  STORE_WEBHOOK_ATTEMPT_HEADER,
  STORE_WEBHOOK_AUDIT,
  STORE_WEBHOOK_CONTENT_TYPE,
  STORE_WEBHOOK_ENDPOINT_FIELD,
  STORE_WEBHOOK_ENDPOINT_MAXIMUM_LENGTH,
  STORE_WEBHOOK_EVENT_ID_HEADER,
  STORE_WEBHOOK_EVENT_TYPE_HEADER,
  STORE_WEBHOOK_EVENT_TYPES,
  STORE_WEBHOOK_OBJECT,
  STORE_WEBHOOK_RULES,
  STORE_WEBHOOK_SIGNATURE_HEADER,
  STORE_WEBHOOK_TIMEOUT_MS,
  STORE_WEBHOOK_USER_AGENT,
  storeWebhookEventOf,
  storeWebhookRuleForStatus,
} from "./store-webhook-fields.ts";
import {
  createStoreWebhookTransport,
  requireStoreWebhookEndpoint,
  storeWebhookEnvelopeOf,
  storeWebhookEventIdOf,
  verifyStoreWebhookSignature,
  type StoreWebhookDeliveryDependencies,
  type StoreWebhookTransport,
  type StoreWebhookTransportRequest,
} from "./store-webhooks.ts";
import {
  API_SANDBOX_WEBHOOK_AUDIT,
  API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES,
  API_SANDBOX_WEBHOOK_ENDPOINT_FIELD,
  API_SANDBOX_WEBHOOK_OBJECT,
  API_SANDBOX_WEBHOOK_PATH_SEGMENT,
  API_SANDBOX_WEBHOOK_PAYMENT_COLUMNS,
  API_SANDBOX_WEBHOOK_REPORTED_RULES,
  API_SANDBOX_WEBHOOK_ROUTE,
  API_SANDBOX_WEBHOOK_RULES,
  API_SANDBOX_WEBHOOK_TIMEOUT_MS,
  sandboxWebhookPathOf,
} from "./sandbox-webhook-fields.ts";
import { API_SANDBOX_RULES as PAYMENT_SANDBOX_RULES } from "./sandbox-fields.ts";
import {
  guardSimulatedCredential,
  parseSandboxWebhookRequest,
  readSandboxWebhookBody,
  sendSimulatedWebhook,
} from "./sandbox-webhook.ts";

/**
 * The gate for STEP 207: the simulated webhook sender.
 *
 * ## What this proves
 *
 *   - **No migration, and no second webhook implementation.** The envelope, the serialised bytes, the HMAC scheme,
 *     the four headers, the endpoint validation, the transport and the status classifier are STEP 205's, imported -
 *     so a store that verifies a simulated delivery has verified its production path.
 *   - **The event is the payment's own.** It is derived from the state of a row this service read in test mode, and
 *     `payment.pending` is refused, because a payment that has not moved has no event.
 *   - **The endpoint fence is the delivery's own function, and it is applied before a socket exists.** Thirteen
 *     refusals, two canonicalisations, and zero sends for any of them.
 *   - **What the store did is reported, not raised.** A `302`, a `404`, a `429`, a `500`, a timeout and an
 *     unreachable host all answer `200` with `delivered: false`, the store's status and STEP 205's rule; only a
 *     platform condition - a credential that will not open - is an error.
 *   - **The deadline is the short one.** The transport is called with five seconds, not the ten a worker may spend,
 *     because a merchant's request cannot hold a connection that long.
 *   - **The chain tells the truth twice.** STEP 205's own `api.webhook_delivered`/`api.webhook_failed` entries are
 *     still written by the delivery, and `api.sandbox_webhook_simulated` marks the event as a simulation - so an
 *     operator counting real failures can tell a test probe from a merchant's production traffic.
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

const companyId = "8a000000-0000-4000-8000-000000000001";
const otherCompanyId = "8a000000-0000-4000-8000-000000000002";
const credentialId = "8b000000-0000-4000-8000-000000000001";
const liveCredentialId = "8b000000-0000-4000-8000-000000000002";
const revokedCredentialId = "8b000000-0000-4000-8000-000000000003";
const testKey = `kd_test_webhook_${"1".repeat(64)}`;
const liveKey = `kd_live_webhook_${"2".repeat(64)}`;
const signingSecret = "d".repeat(64);
const masterKey = Buffer.alloc(32, 9).toString("base64");
const startedAt = Date.parse("2026-11-07T12:00:00.000Z");
const instantIso = new Date(startedAt).toISOString();
const endpoint = "https://store.example.com/webhooks/kd";

function uuidOf(suffix: number): string {
  return `0192f0a1-7c3d-7000-8000-${String(suffix).padStart(12, "0")}`;
}

function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const capturedId = uuidOf(1);
const pendingId = uuidOf(2);
const refundedId = uuidOf(3);
const livePaymentId = uuidOf(4);
const invoicePaymentId = uuidOf(5);
const deletedPaymentId = uuidOf(6);
const foreignPaymentId = uuidOf(7);
const failedId = uuidOf(8);
const reviewId = uuidOf(9);

function credentialRow(id: string, mode: "test" | "live", status: "active" | "revoked"): Row {
  const box: SecretBox = sealSecret(masterKey, signingSecret, credentialSecretContext(companyId));

  return {
    id,
    company_id: companyId,
    mode,
    status,
    signing_secret_ciphertext: box.ciphertext,
    signing_secret_iv: box.iv,
    signing_secret_tag: box.tag,
    encryption_key_version: 1,
    deleted_at: null,
  };
}

function paymentRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    company_id: companyId,
    invoice_id: null,
    status: "captured",
    amount_minor: 12_50,
    refunded_minor: 0,
    currency: "USD",
    mode: "test",
    payment_method: "card",
    failure_code: null,
    created_at: instantIso,
    updated_at: instantIso,
    deleted_at: null,
    ...overrides,
  };
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly limit: number | null;
  readonly select: string | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  let limit: number | null = null;
  let select: string | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select") {
      select = value;
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

  return { equals, nulls, limit, select };
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

type SendBehaviour =
  | { readonly status: number }
  | { readonly throws: "timeout" | "unreachable" | "unknown" };

interface Fixture {
  rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly state: { credentials: Row[]; companies: Row[]; payments: Row[] };
  readonly queries: string[];
  readonly sends: StoreWebhookTransportRequest[];
  readonly counters: { scope: string; limit: number }[];
  send: StoreWebhookTransport;
  behaviour: SendBehaviour;
  nowMs: number;
  refuseCounter: boolean;
  failAudit: boolean;
  failOpenSecret: boolean;
}

function createFixture(): Fixture {
  const state: Fixture["state"] = {
    credentials: [
      credentialRow(credentialId, "test", "active"),
      credentialRow(liveCredentialId, "live", "active"),
      credentialRow(revokedCredentialId, "test", "revoked"),
    ].map((row, index) => ({
      ...row,
      // The pipeline reads two more columns than the delivery does, so every row carries them.
      key_hash: hashOf(index === 0 ? testKey : liveKey),
      key_last_four: index === 0 ? "1111" : "2222",
      key_prefix: index === 0 ? "kd_test_webhook_1" : "kd_live_webhook_2",
      label: index === 0 ? "Sandbox key" : "Live key",
      last_used_at: null,
      version: 1,
    })),
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: otherCompanyId, name: "Second Store", deleted_at: null },
    ],
    payments: [
      paymentRow(capturedId),
      paymentRow(pendingId, { status: "pending" }),
      paymentRow(refundedId, { status: "refunded", refunded_minor: 12_50 }),
      paymentRow(livePaymentId, { mode: "live" }),
      paymentRow(invoicePaymentId, { invoice_id: uuidOf(901) }),
      paymentRow(deletedPaymentId, { deleted_at: instantIso }),
      paymentRow(foreignPaymentId, { company_id: otherCompanyId }),
      paymentRow(failedId, { status: "failed", failure_code: "card_declined" }),
      paymentRow(reviewId, { status: "under_review" }),
    ],
  };
  const queries: string[] = [];
  const sends: StoreWebhookTransportRequest[] = [];
  const counters: { scope: string; limit: number }[] = [];
  const audit = createInMemoryAuditTrail();
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    state,
    queries,
    sends,
    counters,
    send: undefined as unknown as StoreWebhookTransport,
    behaviour: { status: 200 },
    nowMs: startedAt,
    refuseCounter: false,
    failAudit: false,
    failOpenSecret: false,
  };

  fixture.send = async (request) => {
    sends.push(request);

    if ("throws" in fixture.behaviour) {
      const { StoreWebhookTransportError } = await import("./store-webhooks.ts");

      if (fixture.behaviour.throws === "unknown") {
        throw new Error("something else entirely");
      }

      throw new StoreWebhookTransportError(fixture.behaviour.throws);
    }

    return { status: fixture.behaviour.status };
  };

  fixture.rest = {
    async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
      queries.push(`${table}:${query}`);

      if (table === "merchant_api_credentials") {
        const hash = query.match(/key_hash=eq\.([0-9a-f]{64})/u)?.[1];
        const id = query.match(/id=eq\.([0-9a-f-]{36})/u)?.[1];
        const selected = state.credentials.filter((row) =>
          hash === undefined ? row["id"] === id : row["key_hash"] === hash,
        );

        return schema.array().parse(selected.map((row) => ({ ...row })));
      }

      if (table === "companies") {
        return schema.array().parse(state.companies.map((row) => ({ ...row })));
      }

      if (table !== "payments") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const parsed = parseQuery(query);
      const selected = state.payments.filter((row) => matchesRow(row, parsed));

      return schema.array().parse(
        (parsed.limit === null ? selected : selected.slice(0, parsed.limit)).map((row) => ({ ...row })),
      );
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "simulation_inserts_nothing" } });
    },

    async insertReturning(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "simulation_inserts_nothing" } });
    },

    async update(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "simulation_writes_nothing" } });
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

function dependenciesOf(fixture: Fixture): StoreWebhookDeliveryDependencies {
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
    openSecret: (box: SecretBox, context: string): string => {
      if (fixture.failOpenSecret) {
        throw new AppError("INTERNAL_ERROR");
      }

      return openSecret(masterKey, box, context);
    },
    send: (request) => fixture.send(request),
  };
}

function principalOf(overrides: Partial<{ mode: "test" | "live"; companyId: string }> = {}): {
  credentialId: string;
  companyId: string;
  companyName: string;
  mode: "test" | "live";
  label: string;
  keyPrefix: string;
  keyLastFour: string;
  lastUsedRefreshed: boolean;
} {
  const mode = overrides.mode ?? "test";

  return {
    credentialId: mode === "test" ? credentialId : liveCredentialId,
    companyId: overrides.companyId ?? companyId,
    companyName: "Northwind Studio",
    mode,
    label: mode === "test" ? "Sandbox key" : "Live key",
    keyPrefix: mode === "test" ? "kd_test_webhook_1" : "kd_live_webhook_2",
    keyLastFour: mode === "test" ? "1111" : "2222",
    lastUsedRefreshed: false,
  };
}

function inputOf(
  paymentId: string,
  endpointUrl: string = endpoint,
  overrides: Partial<{ mode: "test" | "live"; companyId: string }> = {},
): {
  paymentId: string;
  principal: ReturnType<typeof principalOf>;
  clientAddress: string | null;
  request: { endpointUrl: string };
} {
  return {
    paymentId,
    principal: principalOf(overrides),
    clientAddress: "203.0.113.7",
    request: { endpointUrl },
  };
}

function requestOf(options: { readonly key?: string; readonly body?: string } = {}): Request {
  return new Request(`https://api.example.test${sandboxWebhookPathOf(capturedId)}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.7",
      authorization: `Bearer ${options.key ?? testKey}`,
      "content-type": "application/json",
    },
    body: options.body ?? JSON.stringify({ endpoint_url: endpoint }),
  });
}

/** The audit entries of one action. */
function entriesOf(fixture: Fixture, action: string): readonly AuditEntry[] {
  return fixture.audit.entries.filter((entry) => entry.action === action);
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the delivery is STEP 205's, not a second one
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
  "STEP 207 adds no migration: a simulated delivery reads the same two tables a real one does",
);

const serviceSource = await readFile(new URL("./sandbox-webhook.ts", import.meta.url), "utf8");
const fieldsSource = await readFile(new URL("./sandbox-webhook-fields.ts", import.meta.url), "utf8");
const routeSource = await readFile(
  new URL("../../app/api/public/v1/payments/[id]/webhook-test/route.ts", import.meta.url),
  "utf8",
);
const deliverySource = await readFile(new URL("./store-webhooks.ts", import.meta.url), "utf8");

expect(
  serviceSource.includes("deliverStoreWebhook"),
  "the delivery is STEP 205's own function, imported rather than reimplemented",
);
expect(
  !serviceSource.includes("JSON.stringify"),
  "so this module builds no envelope and serialises nothing itself",
);
expect(
  serviceSource.includes("signStoreWebhook") === false,
  "so this module signs nothing itself: the signature comes from the delivery it calls",
);
expect(
  serviceSource.includes("createStoreWebhookTransport") === false,
  "and builds no transport of its own",
);
expect(
  deliverySource.includes("redirect: \"manual\"") && deliverySource.includes("no-store"),
  "the transport still refuses to follow a redirect and still refuses to be cached",
);
expect(deliverySource.includes("timingSafeEqual"), "and the verifier a store copies still compares in constant time");
expect(serviceSource.includes("requireStoreWebhookEndpoint"), "the endpoint fence is STEP 205's function");
expect(
  fieldsSource.includes("STORE_WEBHOOK_ENDPOINT_FIELD"),
  "the body field is named STEP 205's name for it, so a merchant configures one word",
);

// ---------------------------------------------------------------------------------------------
// 2. The route: one verb, one template, the fence before the body
// ---------------------------------------------------------------------------------------------

expect(routeSource.includes("export const POST"), "the route exports POST");
for (const verb of ["GET", "PUT", "PATCH", "DELETE"]) {
  expect(!routeSource.includes(`export const ${verb}`), `and no ${verb}, because this path is an action`);
}
expect(routeSource.includes("force-dynamic"), "the route is dynamic");
expect(routeSource.includes("await context.params"), "it awaits the params");
expect(routeSource.includes("handlePublicApiCall"), "and goes through the pipeline that authenticates and counts");
expect(routeSource.includes("        route,"), "passing the template constant rather than the arriving path");
expect(
  routeSource.includes("const webhooks = getStoreWebhookRuntime();"),
  "and taking the delivery's runtime, with its transport and its ability to open the signing secret",
);
expect(
  routeSource.includes("await guardSimulatedCredential(call.principal"),
  "fencing the credential inside the handler",
);
expect(
  routeSource.indexOf("await guardSimulatedCredential(call.principal") <
    routeSource.indexOf("await readSandboxWebhookBody("),
  "before the body is read",
);
expect(
  routeSource.includes("clientAddress: readClientAddress(call.request.headers)"),
  "and handing the caller's address to the service",
);
expect(!routeSource.includes("cookie"), "no cookie, because a key is not a session");
expect(!routeSource.includes("csrf"), "no CSRF token");
expect(!routeSource.includes("readIdempotencyKey"), "and no idempotency key");
expect(!routeSource.includes("console."), "printing nothing");

// ---------------------------------------------------------------------------------------------
// 3. The test fence
// ---------------------------------------------------------------------------------------------

const liveFixture = createFixture();
const liveRefusal = await refusalOf(async () =>
  sendSimulatedWebhook(inputOf(capturedId, endpoint, { mode: "live" }), dependenciesOf(liveFixture)),
);

expectEqual(liveRefusal.code, "PERMISSION_DENIED", "a live credential cannot simulate a webhook");
expectEqual(liveRefusal.status, 403, "with 403");
expectEqual(liveRefusal.field, "authorization", "naming the credential");
expectEqual(liveRefusal.rule, API_SANDBOX_WEBHOOK_RULES.liveCredential, "with the sandbox's own rule");
expectEqual(API_SANDBOX_WEBHOOK_RULES.liveCredential, "live_credential_not_simulable", "spelled once");
expectEqual(
  liveFixture.queries.filter((query) => query.startsWith("payments:")).length,
  0,
  "and before any payment is read",
);
expectEqual(liveFixture.sends.length, 0, "and nothing sent");
expectEqual(entriesOf(liveFixture, API_SANDBOX_WEBHOOK_AUDIT.refused).length, 1, "the refusal is in the chain");
expectEqual(
  entriesOf(liveFixture, API_SANDBOX_WEBHOOK_AUDIT.refused)[0]?.payload["mode"],
  "live",
  "with the mode that was refused",
);

const guardFixture = createFixture();
const guardPass = await refusalOf(async () =>
  guardSimulatedCredential(principalOf(), {
    audit: guardFixture.audit,
    clientAddress: "203.0.113.7",
  }),
);

expectEqual(guardPass.code, "no-refusal", "the guarding fence lets a test credential through");
expectEqual(guardFixture.audit.entries.length, 0, "and writes nothing, because nothing was refused");

const guardLiveFixture = createFixture();
const guardLive = await refusalOf(async () =>
  guardSimulatedCredential(principalOf({ mode: "live" }), {
    audit: guardLiveFixture.audit,
    clientAddress: "203.0.113.7",
  }),
);

expectEqual(guardLive.code, "PERMISSION_DENIED", "and refuses a live one");
expectEqual(guardLiveFixture.audit.entries.length, 1, "recording it once");

// ---------------------------------------------------------------------------------------------
// 4. The payment read
// ---------------------------------------------------------------------------------------------

const happyFixture = createFixture();
const happyOutcome = await sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(happyFixture));
const paymentQuery = happyFixture.queries.find((query) => query.startsWith("payments:")) ?? "";

expectEqual(happyOutcome.status, 200, "a delivered simulation answers 200");
expect(
  paymentQuery.includes(`select=${API_PAYMENT_STATUS_COLUMNS}`),
  "the payment read selects STEP 204's ten columns, which are exactly the ten an envelope carries",
);
expect(!paymentQuery.includes("select=*"), "never a star");
expect(!paymentQuery.includes("card_"), "and never a card column");
expect(paymentQuery.includes("mode=eq.test"), "the read narrows on the literal test mode");
expect(paymentQuery.includes(`company_id=eq.${companyId}`), "and on the caller's company");
expect(paymentQuery.includes("invoice_id=is.null"), "and on the schema's definition of a store payment");
expect(paymentQuery.includes("deleted_at=is.null"), "and on a living row");
expect(paymentQuery.includes(`id=eq.${capturedId}`), "for the id the path named");
expect(paymentQuery.includes("limit=1"), "one row at most");
expectEqual(
  API_SANDBOX_WEBHOOK_PAYMENT_COLUMNS,
  API_PAYMENT_STATUS_COLUMNS,
  "and the column constant is STEP 204's own",
);

// ---------------------------------------------------------------------------------------------
// 5. The event: the payment's own state, and nothing a caller chooses
// ---------------------------------------------------------------------------------------------

const deliverableStatuses = API_STORE_PAYMENT_STATUSES.filter(
  (status) => storeWebhookEventOf(status) !== null,
);
const silentStatuses = API_STORE_PAYMENT_STATUSES.filter((status) => storeWebhookEventOf(status) === null);

expectEqual(deliverableStatuses.length, 8, "eight states have an event");
expectEqual(silentStatuses.length, 1, "and exactly one has none");
expectEqual(silentStatuses[0], "pending", "which is the state a payment waits in");
expectEqual(
  (STORE_WEBHOOK_EVENT_TYPES as readonly string[]).includes("webhook.test"),
  false,
  "and there is no synthetic test event type: a simulation carries the payment's own event",
);
expectEqual(STORE_WEBHOOK_EVENT_TYPES.length, deliverableStatuses.length, "the event list is the states' own list");

for (const status of deliverableStatuses) {
  const eventType = storeWebhookEventOf(status);

  expectEqual(eventType, `payment.${status}`, `${status} announces payment.${status}`);
}

const pendingFixture = createFixture();
const pendingRefusal = await refusalOf(async () =>
  sendSimulatedWebhook(inputOf(pendingId), dependenciesOf(pendingFixture)),
);

expectEqual(pendingRefusal.code, "VALIDATION_FAILED", "a pending payment has no event to send");
expectEqual(pendingRefusal.status, 422, "with 422");
expectEqual(pendingRefusal.field, "payment.status", "naming the status");
expectEqual(pendingRefusal.rule, "status_not_deliverable", "with STEP 205's own rule word");
expectEqual(pendingFixture.sends.length, 0, "and nothing sent");
expectEqual(
  entriesOf(pendingFixture, API_SANDBOX_WEBHOOK_AUDIT.refused)[0]?.payload["rule"],
  "status_not_deliverable",
  "the chain says which state was refused",
);

const failedEventFixture = createFixture();
const failedEvent = await sendSimulatedWebhook(inputOf(failedId), dependenciesOf(failedEventFixture));

expectEqual(failedEvent.body.type, "payment.failed", "a declined payment announces its failure");
expectEqual(failedEvent.body.id, storeWebhookEventIdOf({
  companyId,
  paymentId: failedId,
  eventType: "payment.failed",
}), "with the id STEP 205 derives for the same event, so a store's dedupe sees one event");

const refundedEventFixture = createFixture();
const refundedEvent = await sendSimulatedWebhook(inputOf(refundedId), dependenciesOf(refundedEventFixture));

expectEqual(refundedEvent.body.type, "payment.refunded", "and a refunded payment announces its refund");
expect(
  refundedEvent.body.id !== failedEvent.body.id,
  "the two ids differ, because they are two events",
);
expect(
  /^evt_[0-9a-f]{32}$/u.test(refundedEvent.body.id),
  "and the id has the shape a store already parses",
);

const reviewEventFixture = createFixture();
const reviewEvent = await sendSimulatedWebhook(inputOf(reviewId), dependenciesOf(reviewEventFixture));

expectEqual(reviewEvent.body.type, "payment.under_review", "the waiting state announces its own event");

// ---------------------------------------------------------------------------------------------
// 6. The endpoint fence
// ---------------------------------------------------------------------------------------------

for (const [value, description] of [
  ["http://store.example.com/hooks", "plain http"],
  ["https://127.0.0.1/hooks", "a loopback host"],
  ["https://localhost/hooks", "a named loopback"],
  ["https://169.254.169.254/latest", "the metadata address"],
  ["https://store.example.internal/hooks", "an internal host"],
  ["https://user:pass@store.example.com/hooks", "credentials in the URL"],
  ["https://store.example.com:8443/hooks", "a non default port"],
  ["javascript:alert(1)", "a script URL"],
  ["https://store.example.com\\hooks", "a backslash"],
  ["https://store.example.com/<hooks>", "markup characters"],
  ["", "an empty value"],
  [" ", "a blank value"],
  [`https://store.example.com/${"a".repeat(STORE_WEBHOOK_ENDPOINT_MAXIMUM_LENGTH)}`, "a value past the ceiling"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    sendSimulatedWebhook(inputOf(capturedId, value), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.field, STORE_WEBHOOK_ENDPOINT_FIELD, `${description}: naming endpoint_url`);
  expectEqual(fixture.sends.length, 0, `${description}: and nothing sent`);
}

const canonicalFixture = createFixture();
const canonicalOutcome = await sendSimulatedWebhook(
  inputOf(capturedId, "https://STORE.example.com:443/webhooks/kd"),
  dependenciesOf(canonicalFixture),
);

expectEqual(
  canonicalOutcome.body.endpoint_host,
  "store.example.com",
  "a default port is dropped and the host is canonicalised, so the answer names one host",
);
expectEqual(
  canonicalFixture.sends[0]?.url,
  "https://store.example.com/webhooks/kd",
  "and the request goes to the canonical form",
);
expect(
  !JSON.stringify(canonicalOutcome.body).includes("/webhooks/kd"),
  "while the answer never carries the path, which a merchant may have made secret",
);
expect(
  !JSON.stringify(canonicalOutcome.body).includes("https://"),
  "nor the scheme, because the host is the whole of what it says",
);

// ---------------------------------------------------------------------------------------------
// 7. The delivery: STEP 205's bytes, headers and signature
// ---------------------------------------------------------------------------------------------

const request = happyFixture.sends[0];

expectEqual(happyFixture.sends.length, 1, "one delivery per call");
expectEqual(request?.url, endpoint, "to the endpoint that was validated");
expectEqual(request?.timeoutMs, API_SANDBOX_WEBHOOK_TIMEOUT_MS, "with the short deadline, not the worker's");
expectEqual(API_SANDBOX_WEBHOOK_TIMEOUT_MS, 5_000, "which is five seconds");
expectEqual(STORE_WEBHOOK_TIMEOUT_MS, 10_000, "half of the ten a queued delivery may spend");
expectEqual(
  API_SANDBOX_WEBHOOK_TIMEOUT_MS,
  Math.floor(STORE_WEBHOOK_TIMEOUT_MS / 2),
  "and derived from that number rather than written beside it",
);
expectEqual(
  request?.headers["content-type"],
  STORE_WEBHOOK_CONTENT_TYPE,
  "the delivery's content type",
);
expectEqual(request?.headers["user-agent"], STORE_WEBHOOK_USER_AGENT, "and the platform's user agent");
expectEqual(request?.headers[STORE_WEBHOOK_ATTEMPT_HEADER], "1", "the first and only attempt");
expectEqual(request?.headers[STORE_WEBHOOK_EVENT_ID_HEADER], happyOutcome.body.id, "the event's id");
expectEqual(request?.headers[STORE_WEBHOOK_EVENT_TYPE_HEADER], "payment.captured", "and its type");
expect(
  (request?.headers[STORE_WEBHOOK_SIGNATURE_HEADER] ?? "").startsWith("t="),
  "the signature header carries its timestamp",
);
expectEqual(
  verifyStoreWebhookSignature({
    header: request?.headers[STORE_WEBHOOK_SIGNATURE_HEADER] ?? "",
    body: request?.body ?? "",
    secret: signingSecret,
    nowSeconds: Math.floor(startedAt / 1_000),
  }),
  true,
  "and verifies with the credential's own signing secret - the store's production verifier accepts it",
);
expectEqual(
  verifyStoreWebhookSignature({
    header: request?.headers[STORE_WEBHOOK_SIGNATURE_HEADER] ?? "",
    body: request?.body ?? "",
    secret: "e".repeat(64),
    nowSeconds: Math.floor(startedAt / 1_000),
  }),
  false,
  "and refuses another secret, so the key really is the merchant's",
);

const parsedBody = JSON.parse(request?.body ?? "{}") as {
  id: string;
  object: string;
  type: string;
  created: number;
  data: { payment: Row };
};

expectEqual(parsedBody.id, happyOutcome.body.id, "the envelope's id is the answer's id");
expectEqual(parsedBody.object, STORE_WEBHOOK_OBJECT, "its object is STEP 205's");
expectEqual(parsedBody.type, "payment.captured", "and its type is the payment's own");
expectEqual(parsedBody.created, Math.floor(startedAt / 1_000), "created at the instant the platform decided");
expectEqual(
  Object.keys(parsedBody.data).join(","),
  "payment",
  "the body carries a payment and nothing else",
);
expectEqual(
  Object.keys(parsedBody.data.payment).sort().join(","),
  "amount_minor,created_at,currency,failure_code,id,mode,object,payment_method,refunded_minor,status,updated_at",
  "with STEP 204's ten fields and the object name",
);
expectEqual(parsedBody.data.payment["id"], capturedId, "the payment the path named");
expectEqual(parsedBody.data.payment["mode"], "test", "in test mode, which the store can see");
expectEqual(parsedBody.data.payment["status"], "captured", "and the state that produced the event");
expect(
  !request?.body.includes(signingSecret),
  "and the body never carries the signing secret",
);
expect(
  !request?.body.includes(companyId),
  "nor the merchant's company id",
);

/** The bytes STEP 205 would have built for the same event, which the delivery must have sent instead. */
const expectedEnvelope = JSON.stringify(
  storeWebhookEnvelopeOf({
    companyId,
    credentialId,
    mode: "test",
    endpointUrl: endpoint,
    eventId: happyOutcome.body.id,
    eventType: "payment.captured",
    created: Math.floor(startedAt / 1_000),
    payment: {
      id: capturedId,
      object: "payment",
      status: "captured",
      amount_minor: 12_50,
      refunded_minor: 0,
      currency: "USD",
      mode: "test",
      payment_method: "card",
      failure_code: null,
      created_at: instantIso,
      updated_at: instantIso,
    },
  }),
);

expectEqual(request?.body, expectedEnvelope, "the bytes are byte for byte STEP 205's envelope");

// The transport itself, driven through a real `fetch` double: one POST, no redirects, no cache, an abort signal.
const fetchCalls: { url: string; init: RequestInit }[] = [];
const realTransport = createStoreWebhookTransport(async (url, init) => {
  fetchCalls.push({ url: String(url), init: init as RequestInit });

  return new Response(null, { status: 200 });
});

const transportFixture = createFixture();

transportFixture.send = realTransport;

const transportOutcome = await sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(transportFixture));

expectEqual(fetchCalls.length, 1, "the production transport makes exactly one request");
expectEqual(fetchCalls[0]?.init.method, "POST", "a POST");
expectEqual(fetchCalls[0]?.init.redirect, "manual", "that never follows a redirect");
expectEqual(fetchCalls[0]?.init.cache, "no-store", "and is never cached");
expect(fetchCalls[0]?.init.signal instanceof AbortSignal, "with an abort signal carrying the deadline");
expectEqual(transportOutcome.body.delivered, true, "and a 200 from the store is a delivered event");

// ---------------------------------------------------------------------------------------------
// 8. The verdict: what the store did is reported, not raised
// ---------------------------------------------------------------------------------------------

for (const [status, rule, description] of [
  [200, null, "a 200"],
  [204, null, "a 204"],
  [302, STORE_WEBHOOK_RULES.endpointRedirected, "a redirect, which is never followed"],
  [400, STORE_WEBHOOK_RULES.endpointRejected, "a 400"],
  [401, STORE_WEBHOOK_RULES.endpointRejected, "a 401"],
  [404, STORE_WEBHOOK_RULES.endpointRejected, "a 404"],
  [422, STORE_WEBHOOK_RULES.endpointRejected, "a 422"],
  [408, STORE_WEBHOOK_RULES.endpointBusy, "a 408"],
  [429, STORE_WEBHOOK_RULES.endpointBusy, "a 429"],
  [500, STORE_WEBHOOK_RULES.endpointError, "a 500"],
  [503, STORE_WEBHOOK_RULES.endpointError, "a 503"],
] as readonly [number, string | null, string][]) {
  const fixture = createFixture();

  fixture.behaviour = { status };

  const outcome = await sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(fixture));

  expectEqual(outcome.status, 200, `${description} from the store still answers the caller 200`);
  expectEqual(outcome.body.delivered, status < 300, `${description}: delivered is ${String(status < 300)}`);
  expectEqual(outcome.body.rule, rule, `${description}: with STEP 205's rule`);
  expectEqual(outcome.body.status_code, status, `${description}: and the store's own status`);
  if (status >= 300) {
    expectEqual(
      storeWebhookRuleForStatus(status),
      rule,
      `${description}: whose rule is STEP 205's classifier's own answer`,
    );
  }
}

for (const [reason, rule, description] of [
  ["timeout", STORE_WEBHOOK_RULES.endpointTimeout, "a timeout"],
  ["unreachable", STORE_WEBHOOK_RULES.endpointUnreachable, "an unreachable host"],
] as readonly ["timeout" | "unreachable", string, string][]) {
  const fixture = createFixture();

  fixture.behaviour = { throws: reason };

  const outcome = await sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(fixture));

  expectEqual(outcome.status, 200, `${description} still answers the caller 200`);
  expectEqual(outcome.body.delivered, false, `${description}: not delivered`);
  expectEqual(outcome.body.rule, rule, `${description}: with its own rule`);
  expectEqual(outcome.body.status_code, null, `${description}: and no status, because there was none`);
}

expectEqual(
  (API_SANDBOX_WEBHOOK_REPORTED_RULES as readonly string[]).length,
  6,
  "six rules describe the store's endpoint",
);
expectEqual(
  (API_SANDBOX_WEBHOOK_REPORTED_RULES as readonly string[]).join(","),
  [
    STORE_WEBHOOK_RULES.endpointTimeout,
    STORE_WEBHOOK_RULES.endpointUnreachable,
    STORE_WEBHOOK_RULES.endpointRedirected,
    STORE_WEBHOOK_RULES.endpointRejected,
    STORE_WEBHOOK_RULES.endpointBusy,
    STORE_WEBHOOK_RULES.endpointError,
  ].join(","),
  "and they are exactly STEP 205's endpoint rules, in its order",
);

// ---------------------------------------------------------------------------------------------
// 9. The platform's failures, which are not the store's
// ---------------------------------------------------------------------------------------------

const brokenBoxFixture = createFixture();

brokenBoxFixture.failOpenSecret = true;

const brokenBoxRefusal = await refusalOf(async () =>
  sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(brokenBoxFixture)),
);

expectEqual(
  brokenBoxRefusal.code,
  "INTERNAL_ERROR",
  "a signing secret that will not open is the platform's failure, not a report about the store",
);
expectEqual(brokenBoxFixture.sends.length, 0, "and nothing is sent");

const unknownErrorFixture = createFixture();

unknownErrorFixture.behaviour = { throws: "unknown" };

const unknownErrorOutcome = await sendSimulatedWebhook(
  inputOf(capturedId),
  dependenciesOf(unknownErrorFixture),
);

expectEqual(
  unknownErrorOutcome.body.rule,
  STORE_WEBHOOK_RULES.endpointUnreachable,
  "a failure that is not the transport's own is classified the way a production delivery classifies it",
);
expectEqual(unknownErrorOutcome.body.status_code, null, "with no status, because no status was observed");

const revokedFixture = createFixture();
const revokedInput = {
  ...inputOf(capturedId),
  principal: { ...principalOf(), credentialId: revokedCredentialId },
};
const revokedRefusal = await refusalOf(async () =>
  sendSimulatedWebhook(revokedInput, dependenciesOf(revokedFixture)),
);

expectEqual(
  revokedRefusal.code,
  "INTERNAL_ERROR",
  "a credential STEP 202 would not have authenticated is a platform condition, not the store's answer",
);
expectEqual(revokedFixture.sends.length, 0, "and nothing is sent");

// ---------------------------------------------------------------------------------------------
// 10. The chain, twice over
// ---------------------------------------------------------------------------------------------

const simulatedEntries = entriesOf(happyFixture, API_SANDBOX_WEBHOOK_AUDIT.simulated);

expectEqual(simulatedEntries.length, 1, "one simulation entry per call");
expectEqual(simulatedEntries[0]?.entityType, "payment", "naming a payment");
expectEqual(simulatedEntries[0]?.entityId, capturedId, "and which one");
expectEqual(simulatedEntries[0]?.actorUserId, null, "with no human actor");
expectEqual(simulatedEntries[0]?.companyId, companyId, "on the merchant's own chain");
expectEqual(simulatedEntries[0]?.ipAddress, "203.0.113.7", "with the caller's address");
expectEqual(simulatedEntries[0]?.payload["event_id"], happyOutcome.body.id, "the event's id");
expectEqual(simulatedEntries[0]?.payload["event_type"], "payment.captured", "its type");
expectEqual(simulatedEntries[0]?.payload["delivered"], true, "that it was delivered");
expectEqual(simulatedEntries[0]?.payload["rule"], null, "with no rule, because nothing was wrong");
expectEqual(simulatedEntries[0]?.payload["status_code"], 200, "and the store's status");
expectEqual(simulatedEntries[0]?.payload["endpoint_host"], "store.example.com", "and the host, never the path");
expectEqual(simulatedEntries[0]?.payload["mode"], "test", "in test mode");
expectEqual(simulatedEntries[0]?.payload["credential_id"], credentialId, "naming the credential");
expect(
  !JSON.stringify(simulatedEntries[0]).includes(signingSecret),
  "and never the signing secret",
);
expect(!JSON.stringify(simulatedEntries[0]).includes(testKey), "nor the presented key");
expect(
  !JSON.stringify(simulatedEntries[0]).includes("/webhooks/kd"),
  "nor the endpoint's path",
);

expectEqual(
  entriesOf(happyFixture, STORE_WEBHOOK_AUDIT.delivered).length,
  1,
  "STEP 205's own delivered entry is still written, so the delivery's record is the production one",
);
expectEqual(
  entriesOf(happyFixture, STORE_WEBHOOK_AUDIT.delivered)[0]?.payload["mode"],
  "test",
  "and it says test, which is how an operator separates a probe from a merchant's traffic",
);
expectEqual(
  entriesOf(happyFixture, STORE_WEBHOOK_AUDIT.delivered)[0]?.payload["attempt"],
  1,
  "with the one attempt this call makes",
);

const busyFixture = createFixture();

busyFixture.behaviour = { status: 503 };

await sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(busyFixture));

expectEqual(
  entriesOf(busyFixture, STORE_WEBHOOK_AUDIT.failed).length,
  1,
  "a refused delivery still writes STEP 205's failed entry",
);
expectEqual(
  entriesOf(busyFixture, STORE_WEBHOOK_AUDIT.failed)[0]?.payload["will_retry"],
  false,
  "with no retry promised, because this call has no queue",
);
expectEqual(
  entriesOf(busyFixture, API_SANDBOX_WEBHOOK_AUDIT.simulated)[0]?.payload["delivered"],
  false,
  "and the simulation's own entry says it was not delivered",
);
expectEqual(
  entriesOf(busyFixture, API_SANDBOX_WEBHOOK_AUDIT.simulated)[0]?.payload["rule"],
  STORE_WEBHOOK_RULES.endpointError,
  "with the rule the endpoint produced",
);
expectEqual(
  entriesOf(busyFixture, API_SANDBOX_WEBHOOK_AUDIT.simulated)[0]?.payload["status_code"],
  503,
  "and the status it answered, observed rather than guessed",
);

const deafFixture = createFixture();

deafFixture.failAudit = true;

const deafOutcome = await refusalOf(async () =>
  sendSimulatedWebhook(inputOf(capturedId), dependenciesOf(deafFixture)),
);

expectEqual(deafOutcome.code, "no-refusal", "a chain that cannot be written does not fail a delivery");
expectEqual(deafFixture.sends.length, 1, "the event was still sent");

const deafLiveFixture = createFixture();

deafLiveFixture.failAudit = true;

const deafLiveRefusal = await refusalOf(async () =>
  guardSimulatedCredential(principalOf({ mode: "live" }), {
    audit: (dependenciesOf(deafLiveFixture) as { audit: AuditTrail }).audit,
    clientAddress: "203.0.113.7",
  }),
);

expectEqual(deafLiveRefusal.code, "PERMISSION_DENIED", "and a deaf chain does not let a live credential through");

// ---------------------------------------------------------------------------------------------
// 11. Through the pipeline, and the answer's shape
// ---------------------------------------------------------------------------------------------

const pipelineFixture = createFixture();
const bodyReads: string[] = [];

const pipelineAnswer = await handlePublicApiCall(
  {
    request: requestOf(),
    route: API_SANDBOX_WEBHOOK_ROUTE,
    handler: async (call) => {
      await guardSimulatedCredential(call.principal, {
        audit: pipelineFixture.audit,
        clientAddress: "203.0.113.7",
      });

      const body = await readSandboxWebhookBody(call.request);

      bodyReads.push("read");

      const outcome = await sendSimulatedWebhook(
        {
          paymentId: capturedId,
          principal: call.principal,
          clientAddress: "203.0.113.7",
          request: parseSandboxWebhookRequest(body),
        },
        dependenciesOf(pipelineFixture),
      );

      return { status: outcome.status, body: outcome.body };
    },
  },
  dependenciesOf(pipelineFixture),
);

expectEqual(pipelineAnswer.status, 200, "through the pipeline a simulation answers 200");
expectEqual(
  pipelineAnswer.headers[PUBLIC_API_VERSION_HEADER],
  PUBLIC_API_VERSION,
  "with the published version",
);
expectEqual(pipelineAnswer.headers["cache-control"], "no-store", "and no cache");
expectEqual(bodyReads.length, 1, "the body was read once");
expectEqual(pipelineFixture.counters.length, 3, "three counters");
expectEqual(
  pipelineFixture.audit.entries.filter((entry) => entry.action === "api.call").length,
  1,
  "one call entry",
);
expectEqual(
  pipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["route"],
  API_SANDBOX_WEBHOOK_ROUTE,
  "recorded under the template rather than the arriving path",
);

const livePipelineFixture = createFixture();
let liveBodyRead = false;

const livePipelineRefusal = await refusalOf(async () =>
  handlePublicApiCall(
    {
      request: requestOf({ key: liveKey }),
      route: API_SANDBOX_WEBHOOK_ROUTE,
      handler: async (call) => {
        await guardSimulatedCredential(call.principal, {
          audit: livePipelineFixture.audit,
          clientAddress: "203.0.113.7",
        });

        liveBodyRead = true;

        return { status: 200, body: {} };
      },
    },
    dependenciesOf(livePipelineFixture),
  ),
);

expectEqual(livePipelineRefusal.code, "PERMISSION_DENIED", "a live key through the pipeline is refused the surface");
expectEqual(liveBodyRead, false, "before its body is read");
expectEqual(
  livePipelineFixture.audit.entries.find((entry) => entry.action === "api.call")?.payload["status"],
  403,
  "and the call is still recorded, with the status it answered",
);

const answerKeys = Object.keys(happyOutcome.body);

expectEqual(answerKeys.join(","), "id,object,type,created,endpoint_host,delivered,rule,status_code",
  "the answer is eight flat fields");
expectEqual(happyOutcome.body.object, API_SANDBOX_WEBHOOK_OBJECT, "named as a webhook test");
expectEqual(API_SANDBOX_WEBHOOK_OBJECT, "webhook_test", "spelled once");
expectEqual(happyOutcome.body.created, Math.floor(startedAt / 1_000), "with the envelope's instant");
expectEqual(happyOutcome.body.endpoint_host, "store.example.com", "the endpoint's host");
expectEqual(happyOutcome.body.rule, null, "no rule on success");
expectEqual(happyOutcome.body.status_code, 200, "and the store's status");

// ---------------------------------------------------------------------------------------------
// 12. The request, and the vocabulary
// ---------------------------------------------------------------------------------------------

const parsedRequest = parseSandboxWebhookRequest({ endpoint_url: endpoint });

expectEqual(parsedRequest.endpointUrl, endpoint, "one field is the whole request");

for (const [body, rule, field, description] of [
  [{}, API_SANDBOX_WEBHOOK_RULES.endpointMissing, STORE_WEBHOOK_ENDPOINT_FIELD, "an empty body"],
  [{ event_type: "payment.captured" }, API_SANDBOX_WEBHOOK_RULES.endpointMissing, STORE_WEBHOOK_ENDPOINT_FIELD, "a body naming an event type"],
  [[endpoint], API_SANDBOX_WEBHOOK_RULES.endpointMissing, STORE_WEBHOOK_ENDPOINT_FIELD, "an array"],
  [null, API_SANDBOX_WEBHOOK_RULES.endpointMissing, STORE_WEBHOOK_ENDPOINT_FIELD, "null"],
  ["https://store.example.com", API_SANDBOX_WEBHOOK_RULES.endpointMissing, STORE_WEBHOOK_ENDPOINT_FIELD, "a bare string"],
  [{ endpoint_url: endpoint, payment_id: capturedId }, API_SANDBOX_WEBHOOK_RULES.unknownField, "payment_id", "an unknown field"],
  [{ endpoint_url: endpoint, signature: "x" }, API_SANDBOX_WEBHOOK_RULES.unknownField, "signature", "a field it must never accept"],
] as readonly [unknown, string, string, string][]) {
  const refusal = await refusalOf(async () => parseSandboxWebhookRequest(body));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.status, 422, `${description}: with 422`);
  expectEqual(refusal.field, field, `${description}: naming the field`);
  expectEqual(refusal.rule, rule, `${description}: with its own rule`);
}

const malformedBody = await refusalOf(async () =>
  readSandboxWebhookBody(
    new Request(`https://api.example.test${sandboxWebhookPathOf(capturedId)}`, {
      method: "POST",
      body: "{not json",
    }),
  ),
);

expectEqual(malformedBody.code, "VALIDATION_FAILED", "a body that is not JSON is refused");
expectEqual(malformedBody.field, "body", "naming the body");
expectEqual(malformedBody.rule, API_SANDBOX_WEBHOOK_RULES.bodyMalformed, "as malformed");

const declaredTooLarge = await refusalOf(async () =>
  readSandboxWebhookBody(
    new Request(`https://api.example.test${sandboxWebhookPathOf(capturedId)}`, {
      method: "POST",
      headers: { "content-length": String(API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES + 1) },
      body: "{}",
    }),
  ),
);

expectEqual(declaredTooLarge.code, "PAYLOAD_TOO_LARGE", "a declared length past the ceiling is refused");
expectEqual(declaredTooLarge.status, 413, "with 413");
expectEqual(declaredTooLarge.rule, API_SANDBOX_WEBHOOK_RULES.bodyTooLarge, "as too large");

const actualTooLarge = await refusalOf(async () =>
  readSandboxWebhookBody(
    new Request(`https://api.example.test${sandboxWebhookPathOf(capturedId)}`, {
      method: "POST",
      body: `{"endpoint_url":"${"a".repeat(API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES)}"}`,
    }),
  ),
);

expectEqual(actualTooLarge.code, "PAYLOAD_TOO_LARGE", "an undeclared body is counted as it is read");
expectEqual(API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES, 4_096, "the ceiling is four kilobytes, twice a URL's own");

for (const [id, description] of [
  ["", "an empty segment"],
  ["abc", "three letters"],
  [capturedId.toUpperCase(), "an upper case id"],
  [`${capturedId}a`, "an id one character long"],
  ["a".repeat(API_PAYMENT_ID_MAXIMUM_LENGTH + 1), "a value past the ceiling"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    sendSimulatedWebhook(inputOf(id), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.field, API_PAYMENT_STATUS_FIELD, `${description}: naming the id field STEP 204 names`);
  expectEqual(refusal.rule, API_PAYMENT_STATUS_RULES.malformed, `${description}: with STEP 204's rule`);
  expect(fixture.sends.length === 0, `${description}: and nothing sent`);
}

for (const [id, description] of [
  [uuidOf(404), "an id that does not exist"],
  [foreignPaymentId, "another merchant's payment"],
  [livePaymentId, "a live-mode payment reached with a test key"],
  [invoicePaymentId, "an invoice payment"],
  [deletedPaymentId, "a deleted payment"],
] as readonly [string, string][]) {
  const fixture = createFixture();
  const refusal = await refusalOf(async () =>
    sendSimulatedWebhook(inputOf(id), dependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "RESOURCE_NOT_FOUND", `${description} answers not found`);
  expectEqual(refusal.status, 404, `${description}: with 404`);
  expectEqual(refusal.rule, API_PAYMENT_STATUS_RULES.notFound, `${description}: with STEP 204's one rule`);
  expect(fixture.sends.length === 0, `${description}: and nothing sent`);
  expectEqual(
    entriesOf(fixture, API_SANDBOX_WEBHOOK_AUDIT.refused)[0]?.entityId,
    id,
    `${description}: with the id in the chain`,
  );
}

expectEqual(API_SANDBOX_WEBHOOK_ROUTE, `${PUBLIC_API_BASE}/payments/{id}/webhook-test`, "the route is a template");
expectEqual(API_SANDBOX_WEBHOOK_PATH_SEGMENT, "webhook-test", "with its own action segment");
expectEqual(
  sandboxWebhookPathOf(capturedId),
  `${PUBLIC_API_BASE}/payments/${capturedId}/webhook-test`,
  "and a payment's own path encodes its id",
);
expect(
  sandboxWebhookPathOf(capturedId) !== paymentStatusPathOf(capturedId),
  "which is not the status path",
);
expectEqual(API_SANDBOX_WEBHOOK_ENDPOINT_FIELD, "endpoint_url", "the body's field is STEP 205's name");
expectEqual(
  API_SANDBOX_WEBHOOK_ENDPOINT_FIELD,
  STORE_WEBHOOK_ENDPOINT_FIELD,
  "and is imported rather than repeated",
);
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_SANDBOX_WEBHOOK_AUDIT.simulated),
  "the simulation action fits the chain's dotted pattern",
);
expect(
  /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(API_SANDBOX_WEBHOOK_AUDIT.refused),
  "and so does the refusal's",
);
expectEqual(API_SANDBOX_WEBHOOK_AUDIT.simulated, "api.sandbox_webhook_simulated", "spelled once");

for (const rule of Object.values(API_SANDBOX_WEBHOOK_RULES)) {
  expect(/^[a-z][a-z0-9_]*$/u.test(rule), `${rule} is a machine word`);
}

expectEqual(API_SANDBOX_WEBHOOK_RULES.endpointMissing, "endpoint_missing", "the missing-endpoint rule, pinned");
expectEqual(API_SANDBOX_WEBHOOK_RULES.bodyMalformed, "body_malformed", "the malformed-body rule");
expectEqual(API_SANDBOX_WEBHOOK_RULES.bodyTooLarge, "body_too_large", "the oversized-body rule");
expectEqual(API_SANDBOX_WEBHOOK_RULES.unknownField, "unknown_field", "the unknown-field rule");
expectEqual(
  API_SANDBOX_WEBHOOK_RULES.paymentNotDeliverable,
  "status_not_deliverable",
  "the not-deliverable rule, which is STEP 205's own word for it",
);
expectEqual(
  API_SANDBOX_WEBHOOK_RULES.liveCredential,
  "live_credential_not_simulable",
  "and the sandbox's fence, spelled as STEP 206 spells it",
);
expectEqual(
  API_SANDBOX_WEBHOOK_RULES.liveCredential,
  PAYMENT_SANDBOX_RULES.liveCredential,
  "which is the same word the payment simulation uses, imported rather than repeated",
);

expectEqual(requireStoreWebhookEndpoint("https://store.example.com:443/hooks"), "https://store.example.com/hooks",
  "the fence is STEP 205's: a default port is canonicalised the same way here");

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`sandbox webhook gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `sandbox webhook gate passed: ${String(checkCount)} checks, one test-only call that delivers the platform's ` +
      "own envelope, signed with the merchant's own secret over a five second deadline, reports what the store's " +
      "endpoint did rather than raising it, keeps a platform failure an error, and writes both the delivery's chain " +
      "entry and the simulation's\n",
  );
}
