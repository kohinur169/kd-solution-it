// path: lib/api/verify-store-webhooks.ts
import { createDecipheriv } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import process from "node:process";
import type { ZodType } from "zod";
import { createInMemoryAuditTrail, type InMemoryAuditTrail } from "../auth/audit.ts";
import { sealSecret, type SecretBox } from "../auth/secrets.ts";
import type { RestClient } from "../auth/rest.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { createInMemoryJobQueue, retryDelayMs, type JobQueue } from "../jobs/queue.ts";
import { JobRegistry } from "../jobs/registry.ts";
import { JobWorker } from "../jobs/worker.ts";
import type { Logger } from "../logger/logger.ts";
import { credentialSecretContext } from "./credential-fields.ts";
import { API_STORE_PAYMENT_STATUSES, type ApiStorePaymentStatusView } from "./store-payment-status.ts";
import {
  STORE_WEBHOOK_ATTEMPT_HEADER,
  STORE_WEBHOOK_AUDIT,
  STORE_WEBHOOK_CONTENT_TYPE,
  STORE_WEBHOOK_ENDPOINT_FIELD,
  STORE_WEBHOOK_ENTITY,
  STORE_WEBHOOK_EVENT_ID_HEADER,
  STORE_WEBHOOK_EVENT_ID_PATTERN,
  STORE_WEBHOOK_EVENT_TYPES,
  STORE_WEBHOOK_EVENT_TYPE_HEADER,
  STORE_WEBHOOK_JOB_NAME,
  STORE_WEBHOOK_MAXIMUM_ATTEMPTS,
  STORE_WEBHOOK_MAXIMUM_BODY_BYTES,
  STORE_WEBHOOK_OBJECT,
  STORE_WEBHOOK_RULES,
  STORE_WEBHOOK_SIGNATURE_HEADER,
  STORE_WEBHOOK_TIMEOUT_MS,
  STORE_WEBHOOK_USER_AGENT,
  isFinalWebhookRule,
  storeWebhookEventOf,
  storeWebhookRuleForStatus,
  type StoreWebhookEnvelope,
  type StoreWebhookJobPayload,
} from "./store-webhook-fields.ts";
import {
  createStoreWebhookTransport,
  deliverStoreWebhook,
  registerStoreWebhookJob,
  requireStoreWebhookEndpoint,
  scheduleStorePaymentWebhook,
  serializeStoreWebhookEnvelope,
  signStoreWebhook,
  storeWebhookEnvelopeOf,
  storeWebhookEventIdOf,
  verifyStoreWebhookSignature,
  type StoreWebhookDeliveryDependencies,
  type StoreWebhookTransport,
  type StoreWebhookTransportRequest,
} from "./store-webhooks.ts";

/**
 * The gate for STEP 205: signed store webhooks with retries.
 *
 * ## What this proves
 *
 *   - **No migration, and the two tables that already decided the design.** `0034` stores the signing secret as an
 *     AES-256-GCM box because it "must be used later to sign an outbound delivery"; `0002` holds the attempt counter,
 *     the ceiling, the availability instant and the idempotency key this STEP's retries run on. Both are read from
 *     the migration files, so a later edit that drops one fails here.
 *   - **The endpoint is a URL the platform would be willing to call.** Thirteen refusals - plain `http`, a loopback
 *     literal, the cloud metadata address, a private range, `localhost`, credentials in the URL, a non-default port,
 *     a `javascript:` scheme, a backslash, markup, the length ceiling, an empty string - and two accepted URLs
 *     canonicalised. The same check runs again at attempt time, on the payload that decides where the request goes.
 *   - **The event is stable and the body is fixed.** Eight events, one per deliverable state, `pending` refused; the
 *     id derives from company, payment and state, so it is the same on every attempt and different for a later
 *     state; the envelope's key order is the platform's; the payment inside is STEP 204's ten fields and nothing
 *     else; the bytes are under the ceiling and a payment that would exceed it is refused before it is sent.
 *   - **The signature is a contract with a verifier.** `t=...,v1=<hex>` over `"<t>.<body>"`; verification accepts the
 *     platform's own header, refuses a changed body, a replayed timestamp outside the window, another secret, a
 *     malformed header and a truncated HMAC - and the secret never appears in a header, a body or the chain.
 *   - **One attempt is one POST.** Through the production transport: `POST`, the four headers, the exact signed
 *     bytes, `redirect: "manual"`, `cache: "no-store"`, an abort signal, and no read of the response body. A
 *     timeout and an unreachable host are told apart.
 *   - **The classification is the retry policy.** `2xx` delivered; `3xx` final; `408`/`425`/`429` transient;
 *     other `4xx` final; `5xx`, timeout and network transient; a revoked credential, a missing one, a mode mismatch,
 *     an invalid endpoint and an undeliverable status are final and never touch the network.
 *   - **The retries are the queue's, not a loop in a handler.** Through the real registry, queue and worker: a `500`
 *     on the first attempt leaves the job retrying with the foundation's own backoff, the second attempt delivers,
 *     the store received byte-identical bodies with different signature timestamps and attempt headers 1 and 2, and
 *     the job completes. A store that always answers `500` exhausts the ceiling and the job ends `failed`. A store
 *     that answers `404` completes after one attempt. Scheduling the same event twice enqueues one job.
 *   - **The chain says what happened.** One `api.webhook_scheduled` per new event, one entry per attempt outcome with
 *     the event, the attempt, the status code or the rule and whether another attempt follows - on the payment's
 *     entity and the merchant's chain, with the endpoint's host and never its path, and never the secret or the body.
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

const companyId = "6a000000-0000-4000-8000-000000000001";
const credentialId = "6b000000-0000-4000-8000-000000000001";
const paymentId = "0192f0a1-7c3d-7000-8000-0000000000aa";
const signingSecret = "b".repeat(64);
const masterKey = Buffer.alloc(32, 7).toString("base64");
const startedAt = Date.parse("2026-11-07T14:00:00.000Z");

function sealedSigningSecret(): SecretBox {
  return sealSecret(masterKey, signingSecret, credentialSecretContext(companyId));
}

function openWithMasterKey(box: SecretBox, context: string): string {
  const [iv, tag, ciphertext] = [box.iv, box.tag, box.ciphertext].map((part) =>
    Buffer.from(part, "base64url"),
  );

  if (iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new AppError("INTERNAL_ERROR");
  }

  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(masterKey, "base64"), iv, {
    authTagLength: 16,
  });

  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function paymentView(overrides: Partial<ApiStorePaymentStatusView> = {}): ApiStorePaymentStatusView {
  return {
    id: paymentId,
    object: "payment",
    status: "captured",
    amount_minor: 12_50,
    refunded_minor: 0,
    currency: "USD",
    mode: "test",
    payment_method: "card",
    failure_code: null,
    created_at: new Date(startedAt).toISOString(),
    updated_at: new Date(startedAt + 30_000).toISOString(),
    ...overrides,
  };
}

interface Recorded {
  readonly request: StoreWebhookTransportRequest;
}

interface Fixture {
  rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly sent: Recorded[];
  state: { credentials: Row[] };
  nowMs: number;
  nextStatus: number;
  nextError: "timeout" | "unreachable" | null;
}

function createFixture(): Fixture {
  const box = sealedSigningSecret();
  const audit = createInMemoryAuditTrail();
  const sent: Recorded[] = [];
  const fixture: Fixture = {
    rest: undefined as unknown as RestClient,
    audit,
    sent,
    state: {
      credentials: [
        {
          id: credentialId,
          company_id: companyId,
          mode: "test",
          status: "active",
          signing_secret_ciphertext: box.ciphertext,
          signing_secret_iv: box.iv,
          signing_secret_tag: box.tag,
          encryption_key_version: 1,
          deleted_at: null,
        },
      ],
    },
    nowMs: startedAt,
    nextStatus: 200,
    nextError: null,
  };

  fixture.rest = {
    async select<TRow>(table: string, query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
      if (table !== "merchant_api_credentials") {
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table" } });
      }

      const wantsCompany = query.match(/company_id=eq\.([0-9a-f-]{36})/u)?.[1];
      const wantsId = query.match(/id=eq\.([0-9a-f-]{36})/u)?.[1];

      return schema.array().parse(
        fixture.state.credentials
          .filter((row) => row["company_id"] === wantsCompany && row["id"] === wantsId)
          .map((row) => ({
            id: row["id"],
            company_id: row["company_id"],
            mode: row["mode"],
            status: row["status"],
            signing_secret_ciphertext: row["signing_secret_ciphertext"],
            signing_secret_iv: row["signing_secret_iv"],
            signing_secret_tag: row["signing_secret_tag"],
            encryption_key_version: row["encryption_key_version"],
          })),
      );
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },

    async insertReturning(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },

    async update(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },

    async rpc(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "no_function_here" } });
    },
  };

  return fixture;
}

function transportOf(fixture: Fixture): StoreWebhookTransport {
  return async (request) => {
    fixture.sent.push({ request });

    if (fixture.nextError !== null) {
      const { StoreWebhookTransportError } = await import("./store-webhooks.ts");

      throw new StoreWebhookTransportError(fixture.nextError);
    }

    return { status: fixture.nextStatus };
  };
}

function deliveryDependenciesOf(fixture: Fixture): StoreWebhookDeliveryDependencies {
  return {
    rest: fixture.rest,
    audit: fixture.audit,
    now: (): number => fixture.nowMs,
    openSecret: openWithMasterKey,
    send: transportOf(fixture),
  };
}

function payloadOf(overrides: Partial<StoreWebhookJobPayload> = {}): StoreWebhookJobPayload {
  const payment = paymentView();

  return {
    companyId,
    credentialId,
    mode: "test",
    endpointUrl: "https://store.example.com/webhooks/kd",
    eventId: storeWebhookEventIdOf({
      companyId,
      paymentId: payment.id,
      eventType: "payment.captured",
    }),
    eventType: "payment.captured",
    created: Math.floor(startedAt / 1_000),
    payment: {
      id: payment.id,
      object: "payment",
      status: payment.status,
      amount_minor: payment.amount_minor,
      refunded_minor: payment.refunded_minor,
      currency: payment.currency,
      mode: payment.mode,
      payment_method: payment.payment_method,
      failure_code: payment.failure_code,
      created_at: payment.created_at,
      updated_at: payment.updated_at,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// 1. No migration, and the two tables that decided the design
// ---------------------------------------------------------------------------------------------

const migrationFiles = (await readdir(new URL("../../migrations", import.meta.url).pathname)).filter((name) =>
  name.endsWith(".sql"),
);
const numbers = [
  ...new Set(migrationFiles.map((name) => Number.parseInt(name.slice(0, 4), 10)).filter(Number.isFinite)),
].sort((left, right) => left - right);

expectEqual(
  numbers[numbers.length - 1] ?? 0,
  128,
  "STEP 205 adds no migration: 0034 holds the signing secret and 0002 holds the retry state",
);

const credentialsMigration = await readFile(
  new URL("../../migrations/0034_merchant_api_credentials.sql", import.meta.url),
  "utf8",
);
const queueMigration = await readFile(new URL("../../migrations/0002_job_queue.sql", import.meta.url), "utf8");

expect(
  credentialsMigration.includes("must be used later to sign an outbound delivery"),
  "0034's own comment names this STEP: the secret exists so an outbound delivery can be signed",
);
expect(credentialsMigration.includes("signing_secret_ciphertext text not null"), "the secret is stored as ciphertext");
expect(credentialsMigration.includes("signing_secret_iv text not null"), "with its own vector");
expect(credentialsMigration.includes("signing_secret_tag text not null"), "and its own authentication tag");
expect(
  credentialsMigration.includes("encryption_key_version") || credentialsMigration.includes("encryption_key"),
  "and the key version that re-encrypts it",
);
expect(
  queuesHaveRetries(queueMigration),
  "0002 holds the attempt counter, the ceiling, the availability instant and the idempotency key",
);
expect(
  queueMigration.includes("constraint job_queue_max_attempts_check check (max_attempts between 1 and 20)"),
  "the queue's own attempt ceiling bounds the one this STEP asks for",
);
expect(
  queueMigration.includes("constraint job_queue_name_format_check check ("),
  "and a job name has a shape, which the delivery job's name must fit",
);

function queuesHaveRetries(sql: string): boolean {
  return (
    sql.includes("attempt integer not null default 0") &&
    sql.includes("max_attempts integer not null default 5") &&
    sql.includes("available_at timestamptz not null default now()") &&
    sql.includes("idempotency_key text") &&
    sql.includes("status in ('pending', 'running', 'retrying', 'completed', 'failed')")
  );
}

const jobNamePattern = /^[a-z][a-z0-9]*(\.[a-z0-9]+)*$/u;

expect(jobNamePattern.test(STORE_WEBHOOK_JOB_NAME), "the delivery job's name fits the queue's name check");
expect(STORE_WEBHOOK_MAXIMUM_ATTEMPTS >= 1 && STORE_WEBHOOK_MAXIMUM_ATTEMPTS <= 20, "its attempt ceiling fits too");
expectEqual(STORE_WEBHOOK_MAXIMUM_ATTEMPTS, 5, "five attempts, the queue's own default");
expectEqual(STORE_WEBHOOK_MAXIMUM_BODY_BYTES, 16_384, "the body ceiling is sixteen kilobytes");
expectEqual(STORE_WEBHOOK_TIMEOUT_MS, 10_000, "and one attempt may hold its connection for ten seconds");

// ---------------------------------------------------------------------------------------------
// 2. The endpoint the platform will call
// ---------------------------------------------------------------------------------------------

for (const [url, description] of [
  ["", "an empty endpoint"],
  ["http://store.example.com/hook", "a plain http endpoint"],
  ["https://127.0.0.1/hook", "a loopback literal"],
  ["https://169.254.169.254/latest/meta-data/", "the cloud metadata address"],
  ["https://10.0.0.5/hook", "a private range"],
  ["https://192.168.1.10/hook", "a private range in the other block"],
  ["https://localhost/hook", "localhost by name"],
  ["https://user:secret@store.example.com/hook", "credentials in the URL"],
  ["https://store.example.com:8443/hook", "a port nobody approved"],
  ["javascript:alert(1)", "a script URL"],
  ["https://store.example.com\\hook", "a backslash"],
  ["https://store.example.com/<hook>", "markup in the URL"],
  [`https://store.example.com/${"a".repeat(2_100)}`, "a URL past the length ceiling"],
] as readonly [string, string][]) {
  const refusal = await refusalOf(async () => requireStoreWebhookEndpoint(url));

  expectEqual(refusal.code, "VALIDATION_FAILED", `${description} is refused`);
  expectEqual(refusal.field, STORE_WEBHOOK_ENDPOINT_FIELD, `and ${description} names the endpoint field`);
  expectEqual(refusal.status, 422, "with a 422");
}

expectEqual(
  requireStoreWebhookEndpoint("https://store.example.com/webhooks/kd"),
  "https://store.example.com/webhooks/kd",
  "an https endpoint on a public host is accepted unchanged",
);
expectEqual(
  requireStoreWebhookEndpoint("HTTPS://Store.Example.COM:443/webhooks/kd"),
  "https://store.example.com/webhooks/kd",
  "and two spellings of one endpoint are one value",
);

// ---------------------------------------------------------------------------------------------
// 3. The event vocabulary
// ---------------------------------------------------------------------------------------------

expectEqual(STORE_WEBHOOK_EVENT_TYPES.length, 8, "eight events, one per deliverable state");
expect(
  !(STORE_WEBHOOK_EVENT_TYPES as readonly string[]).includes("payment.pending"),
  "and no event for the state STEP 203's 201 already answered with",
);
expectEqual(
  STORE_WEBHOOK_EVENT_TYPES.length,
  API_STORE_PAYMENT_STATUSES.length - 1,
  "the events are the states less pending",
);
expect(
  (STORE_WEBHOOK_EVENT_TYPES as readonly string[]).every((event) => /^payment\.[a-z][a-z0-9_]+$/u.test(event)),
  "every event name is a machine word under the payment prefix",
);

for (const status of API_STORE_PAYMENT_STATUSES) {
  const eventType = storeWebhookEventOf(status);

  if (status === "pending") {
    expectEqual(eventType, null, "a pending payment has no event to deliver");
    continue;
  }

  expectEqual(eventType, `payment.${status}`, `${status} maps to its own event`);
}

expectEqual(STORE_WEBHOOK_RULES.statusNotDeliverable, "status_not_deliverable", "the refusal is a machine word");
expectEqual(STORE_WEBHOOK_OBJECT, "event", "the envelope's object name");
expectEqual(STORE_WEBHOOK_ENTITY, "payment", "and the entity its chain entries name");

// ---------------------------------------------------------------------------------------------
// 4. The event id
// ---------------------------------------------------------------------------------------------

const firstId = storeWebhookEventIdOf({ companyId, paymentId, eventType: "payment.captured" });

expect(STORE_WEBHOOK_EVENT_ID_PATTERN.test(firstId), "the event id matches the tight pattern");
expectEqual(
  storeWebhookEventIdOf({ companyId, paymentId, eventType: "payment.captured" }),
  firstId,
  "the same event has the same id every time it is derived",
);
expect(
  storeWebhookEventIdOf({ companyId, paymentId, eventType: "payment.refunded" }) !== firstId,
  "a later state of the same payment is a different event",
);
expect(
  storeWebhookEventIdOf({
    companyId: "6a000000-0000-4000-8000-000000000002",
    paymentId,
    eventType: "payment.captured",
  }) !== firstId,
  "and the same payment id in another tenant is a different event",
);
expectEqual(firstId.length, 36, "thirty six characters: the prefix and thirty two hex digits");

// ---------------------------------------------------------------------------------------------
// 5. The envelope and its bytes
// ---------------------------------------------------------------------------------------------

const envelope = storeWebhookEnvelopeOf(payloadOf());

expectEqual(Object.keys(envelope).join(","), "id,object,type,created,data", "the envelope's key order is the platform's");
expectEqual(envelope.object, "event", "it names its object");
expectEqual(envelope.type, "payment.captured", "and its event");
expectEqual(envelope.id, firstId, "and its id");
expectEqual(envelope.created, Math.floor(startedAt / 1_000), "with whole seconds since the epoch");
expectEqual(
  Object.keys(envelope.data.payment).sort().join(","),
  "amount_minor,created_at,currency,failure_code,id,mode,object,payment_method,refunded_minor,status,updated_at",
  "the payment inside carries STEP 204's ten fields and its object name",
);
expectEqual(envelope.data.payment.status, "captured", "the state the event is about");
expect(!JSON.stringify(envelope).includes("company_id"), "no company id travels to the store");
expect(!JSON.stringify(envelope).includes(companyId), "not even as a value");
expect(!/card_(?:brand|last_four|number)/u.test(JSON.stringify(envelope)), "and no card field");
expect(!JSON.stringify(envelope).includes(signingSecret), "the signing secret is not in the body");

const body = serializeStoreWebhookEnvelope(envelope);

expect(Buffer.byteLength(body, "utf8") <= STORE_WEBHOOK_MAXIMUM_BODY_BYTES, "the body is under the ceiling");
expectEqual(
  JSON.stringify(JSON.parse(body) as StoreWebhookEnvelope),
  JSON.stringify(envelope),
  "and parses back to the envelope it was made from",
);
expectEqual(serializeStoreWebhookEnvelope(envelope), body, "the same envelope is the same bytes every time");

const hugePayment = payloadOf();

const tooLarge = await refusalOf(async () =>
  serializeStoreWebhookEnvelope(
    storeWebhookEnvelopeOf({
      ...hugePayment,
      payment: { ...hugePayment.payment, currency: "X".repeat(1_048_576) },
    }),
  ),
);

expectEqual(tooLarge.rule, STORE_WEBHOOK_RULES.bodyTooLarge, "a body past the ceiling is refused before it is sent");
expectEqual(tooLarge.status, 422, "as a validation failure");

// ---------------------------------------------------------------------------------------------
// 6. The signature
// ---------------------------------------------------------------------------------------------

const timestamp = Math.floor(startedAt / 1_000);
const header = signStoreWebhook({ body, secret: signingSecret, timestampSeconds: timestamp });

expect(/^t=\d+,v1=[0-9a-f]{64}$/u.test(header), "the signature header is a timestamp and a lower case hex HMAC");
expectEqual(
  signStoreWebhook({ body, secret: signingSecret, timestampSeconds: timestamp }),
  header,
  "signing the same bytes at the same instant is the same header",
);
expect(
  signStoreWebhook({ body, secret: signingSecret, timestampSeconds: timestamp + 1 }) !== header,
  "a later instant is a different signature",
);
expect(
  signStoreWebhook({ body: `${body} `, secret: signingSecret, timestampSeconds: timestamp }) !== header,
  "and so is a changed body",
);
expect(
  signStoreWebhook({ body, secret: "c".repeat(64), timestampSeconds: timestamp }) !== header,
  "and another secret",
);

expect(
  verifyStoreWebhookSignature({
    header,
    body,
    secret: signingSecret,
    nowSeconds: timestamp + 30,
  }),
  "the platform's own header verifies inside the tolerance window",
);
expect(
  !verifyStoreWebhookSignature({ header, body: `${body} `, secret: signingSecret, nowSeconds: timestamp }),
  "a changed body does not verify",
);
expect(
  !verifyStoreWebhookSignature({
    header,
    body,
    secret: signingSecret,
    nowSeconds: timestamp + 3_600,
  }),
  "a replayed timestamp outside the window does not verify",
);
expect(
  !verifyStoreWebhookSignature({ header, body, secret: "c".repeat(64), nowSeconds: timestamp }),
  "another secret does not verify",
);
expect(
  !verifyStoreWebhookSignature({ header: "t=abc,v1=00", body, secret: signingSecret, nowSeconds: timestamp }),
  "a malformed header does not verify",
);
expect(
  !verifyStoreWebhookSignature({
    header: header.replace(/v1=([0-9a-f]{4})[0-9a-f]{60}/u, "v1=$10000"),
    body,
    secret: signingSecret,
    nowSeconds: timestamp,
  }),
  "a truncated HMAC does not verify",
);
expect(
  !verifyStoreWebhookSignature({ header: header.replace("v1=", "v2="), body, secret: signingSecret, nowSeconds: timestamp }),
  "an unknown version does not verify",
);
expect(!header.includes(signingSecret.slice(0, 8)), "and the header carries no part of the secret");

// ---------------------------------------------------------------------------------------------
// 7. The transport
// ---------------------------------------------------------------------------------------------

interface Captured {
  readonly url: string;
  readonly options: RequestInit;
}

const captured: Captured[] = [];

const fakeFetch = (async (url: string | URL | Request, options?: RequestInit) => {
  captured.push({ url: String(url), options: options ?? {} });

  return {
    status: 204,
    text: (): never => {
      throw new Error("the response body must never be read");
    },
    json: (): never => {
      throw new Error("the response body must never be read");
    },
  } as unknown as Response;
}) as unknown as typeof fetch;

const transport = createStoreWebhookTransport(fakeFetch);
const transportAnswer = await transport({
  url: "https://store.example.com/webhooks/kd",
  headers: { "content-type": STORE_WEBHOOK_CONTENT_TYPE, [STORE_WEBHOOK_SIGNATURE_HEADER]: header },
  body,
  timeoutMs: STORE_WEBHOOK_TIMEOUT_MS,
});

expectEqual(transportAnswer.status, 204, "the transport answers the store's status");
expectEqual(captured.length, 1, "one attempt is exactly one request");
expectEqual(captured[0]?.url, "https://store.example.com/webhooks/kd", "to the endpoint");
expectEqual(captured[0]?.options.method, "POST", "as a POST");
expectEqual(captured[0]?.options.body, body, "carrying the exact bytes that were signed");
expectEqual(captured[0]?.options.redirect, "manual", "never following a redirect");
expectEqual(captured[0]?.options.cache, "no-store", "never cached");
expect(captured[0]?.options.signal instanceof AbortSignal, "with an abort signal bounding it");
expectEqual(
  (captured[0]?.options.headers as Record<string, string>)["content-type"],
  STORE_WEBHOOK_CONTENT_TYPE,
  "and the JSON content type",
);

// `require` keeps the timeout path honest without a real timer: the transport maps the reason, and the gate reads it.
const { StoreWebhookTransportError } = await import("./store-webhooks.ts");

const timeoutTransport = createStoreWebhookTransport((async () => {
  throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
}) as unknown as typeof fetch);
const timeoutError = await refusalOf(async () =>
  timeoutTransport({ url: "https://store.example.com/kd", headers: {}, body, timeoutMs: 10 }),
);

expectEqual(timeoutError.code, "not-an-app-error", "a timeout leaves the transport as its own error");
expect(
  (await (async () => {
    try {
      await timeoutTransport({ url: "https://store.example.com/kd", headers: {}, body, timeoutMs: 10 });

      return null;
    } catch (error) {
      return error instanceof StoreWebhookTransportError ? error.reason : "wrong";
    }
  })()) === "timeout",
  "and the reason is a timeout rather than a refused connection",
);

const unreachableTransport = createStoreWebhookTransport((async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch);

expect(
  (await (async () => {
    try {
      await unreachableTransport({ url: "https://store.example.com/kd", headers: {}, body, timeoutMs: 10 });

      return null;
    } catch (error) {
      return error instanceof StoreWebhookTransportError ? error.reason : "wrong";
    }
  })()) === "unreachable",
  "a refused connection is told apart from a timeout",
);

// ---------------------------------------------------------------------------------------------
// 8. The classification
// ---------------------------------------------------------------------------------------------

for (const [status, rule, final] of [
  [302, STORE_WEBHOOK_RULES.endpointRedirected, true],
  [400, STORE_WEBHOOK_RULES.endpointRejected, true],
  [401, STORE_WEBHOOK_RULES.endpointRejected, true],
  [403, STORE_WEBHOOK_RULES.endpointRejected, true],
  [404, STORE_WEBHOOK_RULES.endpointRejected, true],
  [422, STORE_WEBHOOK_RULES.endpointRejected, true],
  [408, STORE_WEBHOOK_RULES.endpointBusy, false],
  [425, STORE_WEBHOOK_RULES.endpointBusy, false],
  [429, STORE_WEBHOOK_RULES.endpointBusy, false],
  [500, STORE_WEBHOOK_RULES.endpointError, false],
  [502, STORE_WEBHOOK_RULES.endpointError, false],
  [503, STORE_WEBHOOK_RULES.endpointError, false],
] as readonly [number, string, boolean][]) {
  expectEqual(storeWebhookRuleForStatus(status), rule, `a ${String(status)} is ${rule}`);
  expectEqual(isFinalWebhookRule(rule as never), final, `and ${rule} is ${final ? "final" : "worth retrying"}`);
}

for (const [status, description] of [
  [200, "a delivered event"],
  [201, "a created answer"],
  [204, "an empty acknowledgement"],
] as readonly [number, string][]) {
  const fixture = createFixture();

  fixture.nextStatus = status;
  const outcome = await deliverStoreWebhook(payloadOf(), { attempt: 1, maxAttempts: 5 }, deliveryDependenciesOf(fixture));

  expectEqual(outcome.delivered, true, `${description} is a delivery`);
  expectEqual(outcome.willRetry, false, "and nothing follows it");
  expectEqual(
    fixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.delivered).length,
    1,
    "which is one delivered entry",
  );
}

for (const [status, rule] of [
  [404, STORE_WEBHOOK_RULES.endpointRejected],
  [302, STORE_WEBHOOK_RULES.endpointRedirected],
] as readonly [number, string][]) {
  const fixture = createFixture();

  fixture.nextStatus = status;
  const outcome = await deliverStoreWebhook(payloadOf(), { attempt: 1, maxAttempts: 5 }, deliveryDependenciesOf(fixture));

  expectEqual(outcome.delivered, false, `a ${String(status)} is not a delivery`);
  expectEqual(outcome.rule, rule, "and names the rule");
  expectEqual(outcome.willRetry, false, "with no attempt after it");
  expectEqual(
    fixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.failed).length,
    1,
    "one failed entry",
  );
}

for (const [status, rule] of [
  [500, STORE_WEBHOOK_RULES.endpointError],
  [429, STORE_WEBHOOK_RULES.endpointBusy],
] as readonly [number, string][]) {
  const fixture = createFixture();

  fixture.nextStatus = status;
  const refusal = await refusalOf(async () =>
    deliverStoreWebhook(payloadOf(), { attempt: 1, maxAttempts: 5 }, deliveryDependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "DEPENDENCY_FAILED", `a ${String(status)} is thrown so the queue retries`);
  expect(fixture.audit.entries.some((entry) => entry.payload["rule"] === rule), `and the entry names ${rule}`);
  expect(
    fixture.audit.entries.find((entry) => entry.action === STORE_WEBHOOK_AUDIT.failed)?.payload["will_retry"] === true,
    "with another attempt to come",
  );
}

const transientFixture = createFixture();

transientFixture.nextStatus = 503;

const lastAttempt = await refusalOf(async () =>
  deliverStoreWebhook(payloadOf(), { attempt: 5, maxAttempts: 5 }, deliveryDependenciesOf(transientFixture)),
);

expectEqual(lastAttempt.code, "DEPENDENCY_FAILED", "the last attempt still throws, so the job ends failed rather than completed");
expectEqual(
  transientFixture.audit.entries.find((entry) => entry.action === STORE_WEBHOOK_AUDIT.failed)?.payload["will_retry"],
  false,
  "and its entry says no attempt follows",
);

for (const [error, rule] of [
  ["timeout", STORE_WEBHOOK_RULES.endpointTimeout],
  ["unreachable", STORE_WEBHOOK_RULES.endpointUnreachable],
] as readonly ["timeout" | "unreachable", string][]) {
  const fixture = createFixture();

  fixture.nextError = error;
  const refusal = await refusalOf(async () =>
    deliverStoreWebhook(payloadOf(), { attempt: 1, maxAttempts: 5 }, deliveryDependenciesOf(fixture)),
  );

  expectEqual(refusal.code, "DEPENDENCY_FAILED", `a ${error} is transient`);
  expect(fixture.audit.entries.some((entry) => entry.payload["rule"] === rule), `and the chain says ${rule}`);
  expectEqual(fixture.sent.length, 1, "and the attempt did reach the transport");
}

// ---------------------------------------------------------------------------------------------
// 9. The final refusals that never touch the network
// ---------------------------------------------------------------------------------------------

const revokeCases: readonly [string, (fixture: Fixture) => void, string][] = [
  [
    "a removed credential",
    (fixture) => {
      fixture.state.credentials = [];
    },
    STORE_WEBHOOK_RULES.credentialUnavailable,
  ],
  [
    "a revoked credential",
    (fixture) => {
      fixture.state.credentials[0] = { ...fixture.state.credentials[0], status: "revoked" };
    },
    STORE_WEBHOOK_RULES.credentialRevoked,
  ],
  [
    "a credential of the other mode",
    (fixture) => {
      fixture.state.credentials[0] = { ...fixture.state.credentials[0], mode: "live" };
    },
    STORE_WEBHOOK_RULES.credentialModeMismatch,
  ],
  [
    "a box that will not unpack",
    (fixture) => {
      fixture.state.credentials[0] = { ...fixture.state.credentials[0], signing_secret_iv: "not-a-vector" };
    },
    STORE_WEBHOOK_RULES.credentialUnavailable,
  ],
];

for (const [description, mutate, rule] of revokeCases) {
  const fixture = createFixture();

  mutate(fixture);
  const outcome = await deliverStoreWebhook(payloadOf(), { attempt: 1, maxAttempts: 5 }, deliveryDependenciesOf(fixture));

  expectEqual(outcome.delivered, false, `${description} is not a delivery`);
  expectEqual(outcome.rule, rule, `and ${description} is ${rule}`);
  expectEqual(outcome.willRetry, false, "with no attempt after it");
  expectEqual(fixture.sent.length, 0, "and nothing is sent to the store");
}

const invalidEndpointFixture = createFixture();
const invalidEndpoint = await deliverStoreWebhook(
  payloadOf({ endpointUrl: "https://169.254.169.254/latest/meta-data/" }),
  { attempt: 1, maxAttempts: 5 },
  deliveryDependenciesOf(invalidEndpointFixture),
);

expectEqual(invalidEndpoint.rule, STORE_WEBHOOK_RULES.endpointInvalid, "a payload pointing at a private address is refused at attempt time");
expectEqual(invalidEndpointFixture.sent.length, 0, "without a request being made");
expectEqual(
  invalidEndpointFixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.delivered).length,
  0,
  "and nothing recorded as delivered",
);

const foreignBoxFixture = createFixture();
const foreignBox = sealSecret(masterKey, signingSecret, credentialSecretContext("6a000000-0000-4000-8000-000000000002"));

foreignBoxFixture.state.credentials[0] = {
  ...foreignBoxFixture.state.credentials[0],
  signing_secret_iv: foreignBox.iv,
  signing_secret_tag: foreignBox.tag,
  signing_secret_ciphertext: foreignBox.ciphertext,
};

const foreignBoxOutcome = await deliverStoreWebhook(
  payloadOf(),
  { attempt: 1, maxAttempts: 5 },
  deliveryDependenciesOf(foreignBoxFixture),
);

expectEqual(
  foreignBoxOutcome.rule,
  STORE_WEBHOOK_RULES.credentialUnavailable,
  "a box sealed under another tenant's context does not open, and is not worth another attempt",
);
expectEqual(foreignBoxOutcome.willRetry, false, "with no attempt after it");
expectEqual(foreignBoxFixture.sent.length, 0, "and nothing sent");

const pendingFixture = createFixture();
const notDeliverable = await deliverStoreWebhook(
  payloadOf({ eventType: "payment.failed" }),
  { attempt: 1, maxAttempts: 5 },
  deliveryDependenciesOf(pendingFixture),
);

expectEqual(
  notDeliverable.rule,
  STORE_WEBHOOK_RULES.statusNotDeliverable,
  "a payload whose event does not match its payment's state is refused rather than delivered",
);
expectEqual(pendingFixture.sent.length, 0, "and nothing is sent");

// ---------------------------------------------------------------------------------------------
// 10. The retries, through the real registry, queue and worker
// ---------------------------------------------------------------------------------------------

interface RunFixture {
  readonly queue: JobQueue;
  readonly registry: JobRegistry;
  readonly worker: JobWorker;
  readonly audit: InMemoryAuditTrail;
  readonly deliveries: Recorded[];
  readonly clock: { nowMs: number };
  nextStatus: number;
}

/** The credential read the delivery makes, answered with one live box, and nothing else writable. */
function credentialRestStub(): RestClient {
  const box = sealedSigningSecret();

  return {
    async select<TRow>(_table: string, _query: string, schema: ZodType<TRow>): Promise<readonly TRow[]> {
      return schema.array().parse([
        {
          id: credentialId,
          company_id: companyId,
          mode: "test",
          status: "active",
          signing_secret_ciphertext: box.ciphertext,
          signing_secret_iv: box.iv,
          signing_secret_tag: box.tag,
          encryption_key_version: 1,
        },
      ]);
    },
    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },
    async insertReturning(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },
    async update(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },
    async rpc(): Promise<never> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "read_only_gate" } });
    },
  };
}

/** A logger that writes nowhere: a gate's output is the gate's verdict, not the worker's progress. */
function silentLogger(): Logger {
  const quiet: Logger = {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    child: (): Logger => quiet,
  };

  return quiet;
}

function createRunFixture(): RunFixture {
  const audit = createInMemoryAuditTrail();
  const deliveries: Recorded[] = [];
  const clock = { nowMs: startedAt };
  const queue = createInMemoryJobQueue();
  const registry = new JobRegistry();
  const fixture: RunFixture = {
    queue,
    registry,
    worker: undefined as unknown as JobWorker,
    audit,
    deliveries,
    clock,
    nextStatus: 500,
  };
  const rest = credentialRestStub();

  registerStoreWebhookJob(registry, {
    rest,
    audit,
    now: (): number => clock.nowMs,
    openSecret: openWithMasterKey,
    send: async (request) => {
      deliveries.push({ request });

      return { status: fixture.nextStatus };
    },
  });

  const built = new JobWorker({
    queue,
    registry,
    logger: silentLogger(),
    now: (): number => clock.nowMs,
    leaseDurationMs: 60_000,
  });

  (fixture as { worker: JobWorker }).worker = built;

  return fixture;
}

const scheduleFixture = createRunFixture();
const firstSchedule = await scheduleStorePaymentWebhook(
  {
    companyId,
    credentialId,
    endpointUrl: "https://store.example.com/webhooks/kd",
    payment: paymentView(),
  },
  { queue: scheduleFixture.queue, audit: scheduleFixture.audit, now: (): number => scheduleFixture.clock.nowMs },
);

expectEqual(firstSchedule.eventId, firstId, "scheduling derives the same event id the envelope carries");
expect(STORE_WEBHOOK_EVENT_ID_PATTERN.test(firstSchedule.eventId), "in the tight shape");
expectEqual(firstSchedule.deduplicated, false, "the first schedule is not a duplicate");
expectEqual(
  scheduleFixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.scheduled).length,
  1,
  "and writes one scheduled entry",
);

const scheduledEntry = scheduleFixture.audit.entries.find(
  (entry) => entry.action === STORE_WEBHOOK_AUDIT.scheduled,
);

expectEqual(scheduledEntry?.companyId, companyId, "the scheduled entry is on the merchant's chain");
expectEqual(scheduledEntry?.entityType, STORE_WEBHOOK_ENTITY, "against the payment entity");
expectEqual(scheduledEntry?.entityId, paymentId, "and the payment itself");
expectEqual(scheduledEntry?.payload["event_type"], "payment.captured", "naming the event");
expectEqual(scheduledEntry?.payload["endpoint_host"], "store.example.com", "and the endpoint's host");
expect(!JSON.stringify(scheduledEntry).includes("/webhooks/kd"), "and not its path, which a merchant may have made secret");
expect(!JSON.stringify(scheduledEntry).includes(signingSecret), "and never the signing secret");

const secondSchedule = await scheduleStorePaymentWebhook(
  {
    companyId,
    credentialId,
    endpointUrl: "https://store.example.com/webhooks/kd",
    payment: paymentView(),
  },
  { queue: scheduleFixture.queue, audit: scheduleFixture.audit, now: (): number => scheduleFixture.clock.nowMs },
);

expectEqual(secondSchedule.deduplicated, true, "scheduling the same event twice is one job");
expectEqual(secondSchedule.jobId, firstSchedule.jobId, "the caller is answered with the job that exists");
expectEqual(
  scheduleFixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.scheduled).length,
  1,
  "and no second scheduled entry",
);

const pendingSchedule = await refusalOf(async () =>
  scheduleStorePaymentWebhook(
    {
      companyId,
      credentialId,
      endpointUrl: "https://store.example.com/webhooks/kd",
      payment: paymentView({ status: "pending" }),
    },
    { queue: scheduleFixture.queue, audit: scheduleFixture.audit, now: (): number => scheduleFixture.clock.nowMs },
  ),
);

expectEqual(pendingSchedule.rule, STORE_WEBHOOK_RULES.statusNotDeliverable, "a pending payment is refused at schedule time");
expectEqual(pendingSchedule.status, 422, "as a validation failure");

const badEndpointSchedule = await refusalOf(async () =>
  scheduleStorePaymentWebhook(
    {
      companyId,
      credentialId,
      endpointUrl: "http://store.example.com/kd",
      payment: paymentView(),
    },
    { queue: scheduleFixture.queue, audit: scheduleFixture.audit, now: (): number => scheduleFixture.clock.nowMs },
  ),
);

expectEqual(badEndpointSchedule.field, STORE_WEBHOOK_ENDPOINT_FIELD, "a plain http endpoint is refused before a row is written");

const retryFixture = createRunFixture();

retryFixture.nextStatus = 500;

await scheduleStorePaymentWebhook(
  { companyId, credentialId, endpointUrl: "https://store.example.com/webhooks/kd", payment: paymentView() },
  { queue: retryFixture.queue, audit: retryFixture.audit, now: (): number => retryFixture.clock.nowMs },
);

const firstRun = await retryFixture.worker.runOnce();

expectEqual(firstRun.status, "retrying", "a 500 leaves the job retrying rather than dead");
expectEqual(retryFixture.deliveries.length, 1, "after exactly one attempt");
expectEqual(retryFixture.deliveries[0]?.request.headers[STORE_WEBHOOK_ATTEMPT_HEADER], "1", "numbered from one");

const retryAt = retryDelayMs(1);

expect(retryAt >= 1_000, "the foundation's backoff waits before the next attempt");

retryFixture.clock.nowMs = startedAt + retryAt;
retryFixture.nextStatus = 200;

const secondRun = await retryFixture.worker.runOnce();

expectEqual(secondRun.status, "completed", "the second attempt delivers and the job completes");
expectEqual(secondRun.jobId, firstRun.jobId, "as the same job");
expectEqual(retryFixture.deliveries.length, 2, "the store was called twice");
expectEqual(retryFixture.deliveries[1]?.request.headers[STORE_WEBHOOK_ATTEMPT_HEADER], "2", "with attempt two");

const [firstBody, secondBody] = retryFixture.deliveries.map((entry) => entry.request.body);

expectEqual(firstBody, secondBody, "the body is byte identical on both attempts");
expectEqual(
  retryFixture.deliveries[0]?.request.headers[STORE_WEBHOOK_EVENT_ID_HEADER],
  retryFixture.deliveries[1]?.request.headers[STORE_WEBHOOK_EVENT_ID_HEADER],
  "and the event id is the same, so a store dedupes the redelivery",
);
expect(
  retryFixture.deliveries[0]?.request.headers[STORE_WEBHOOK_SIGNATURE_HEADER] !==
    retryFixture.deliveries[1]?.request.headers[STORE_WEBHOOK_SIGNATURE_HEADER],
  "while the signature is fresh at each attempt's instant",
);
expectEqual(
  retryFixture.deliveries[0]?.request.headers[STORE_WEBHOOK_EVENT_TYPE_HEADER],
  "payment.captured",
  "and the event type travels in its own header",
);
expectEqual(
  retryFixture.deliveries[0]?.request.headers["user-agent"],
  STORE_WEBHOOK_USER_AGENT,
  "with the platform's user agent",
);

for (const entry of retryFixture.deliveries) {
  const signature = entry.request.headers[STORE_WEBHOOK_SIGNATURE_HEADER] ?? "";

  expect(
    verifyStoreWebhookSignature({
      header: signature,
      body: entry.request.body,
      secret: signingSecret,
      nowSeconds: Math.floor(retryFixture.clock.nowMs / 1_000),
      toleranceSeconds: 3_600,
    }),
    "every delivered attempt verifies against the secret the credential holds",
  );
}

const attemptEntries = retryFixture.audit.entries.filter(
  (entry) => entry.action === STORE_WEBHOOK_AUDIT.failed || entry.action === STORE_WEBHOOK_AUDIT.delivered,
);

expectEqual(attemptEntries.length, 2, "the chain has one entry per attempt");
expectEqual(attemptEntries[0]?.payload["will_retry"], true, "the first says another attempt follows");
expectEqual(attemptEntries[0]?.payload["status_code"], 500, "and carries the store's status");
expectEqual(attemptEntries[1]?.payload["attempt"], 2, "the second is attempt two");
expect(!JSON.stringify(attemptEntries).includes(signingSecret), "and no entry carries the secret");
expectEqual(
  attemptEntries[1]?.payload["endpoint_host"],
  "store.example.com",
  "each attempt records the endpoint's host",
);
expect(!JSON.stringify(attemptEntries).includes("/webhooks/kd"), "and never its path, which a merchant may have made secret");
expect(
  attemptEntries.every((entry) => !("body" in entry.payload) && !("data" in entry.payload)),
  "and never the body that was sent",
);

const deadFixture = createRunFixture();

deadFixture.nextStatus = 500;

await scheduleStorePaymentWebhook(
  { companyId, credentialId, endpointUrl: "https://store.example.com/webhooks/kd", payment: paymentView() },
  { queue: deadFixture.queue, audit: deadFixture.audit, now: (): number => deadFixture.clock.nowMs },
);

for (let attempt = 1; attempt <= STORE_WEBHOOK_MAXIMUM_ATTEMPTS; attempt += 1) {
  deadFixture.clock.nowMs = startedAt + attempt * retryDelayMs(attempt);
  await deadFixture.worker.runOnce();
}

const deadSnapshot = await deadFixture.queue.snapshot(deadFixture.clock.nowMs);

expectEqual(deadSnapshot.failed, 1, "a store that always fails exhausts the ceiling and the job ends failed");
expectEqual(deadFixture.deliveries.length, STORE_WEBHOOK_MAXIMUM_ATTEMPTS, "after exactly the attempts it is allowed");
expectEqual(
  deadFixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.failed).length,
  STORE_WEBHOOK_MAXIMUM_ATTEMPTS,
  "with one chain entry per attempt",
);
expectEqual(
  deadFixture.audit.entries.filter((entry) => entry.action === STORE_WEBHOOK_AUDIT.failed)[
    STORE_WEBHOOK_MAXIMUM_ATTEMPTS - 1
  ]?.payload["will_retry"],
  false,
  "and the last says no attempt follows",
);

const rejectedFixture = createRunFixture();

rejectedFixture.nextStatus = 404;

await scheduleStorePaymentWebhook(
  { companyId, credentialId, endpointUrl: "https://store.example.com/webhooks/kd", payment: paymentView() },
  { queue: rejectedFixture.queue, audit: rejectedFixture.audit, now: (): number => rejectedFixture.clock.nowMs },
);

const rejectedRun = await rejectedFixture.worker.runOnce();

expectEqual(rejectedRun.status, "completed", "a store that refuses the delivery is not retried");
expectEqual(rejectedFixture.deliveries.length, 1, "and is called once");
expectEqual(
  rejectedFixture.audit.entries.find((entry) => entry.action === STORE_WEBHOOK_AUDIT.failed)?.payload["rule"],
  STORE_WEBHOOK_RULES.endpointRejected,
  "with the reason in the chain",
);

// The registry refuses a second registration, and the helper is the one that makes that a `false` rather than a throw.
const duplicateRegistration = createRunFixture();

expectEqual(duplicateRegistration.registry.has(STORE_WEBHOOK_JOB_NAME), true, "the job is registered under its name");
expectEqual(
  registerStoreWebhookJob(duplicateRegistration.registry, {
    rest: credentialRestStub(),
    audit: duplicateRegistration.audit,
    now: (): number => startedAt,
    openSecret: openWithMasterKey,
    send: async () => ({ status: 200 }),
  }),
  false,
  "and a second registration answers false rather than throwing",
);
expectEqual(duplicateRegistration.registry.names().length, 1, "the registry still holds exactly one job");

// ---------------------------------------------------------------------------------------------
// 11. The sources
// ---------------------------------------------------------------------------------------------

const serviceSource = await readFile(new URL("./store-webhooks.ts", import.meta.url), "utf8");
const fieldsSource = await readFile(new URL("./store-webhook-fields.ts", import.meta.url), "utf8");
const runtimeSource = await readFile(new URL("./store-webhook-runtime.ts", import.meta.url), "utf8");

expect(serviceSource.includes('redirect: "manual"'), "the transport never follows a redirect");
expect(!serviceSource.includes('redirect: "follow"'), "and never asks to");
expect(serviceSource.includes('cache: "no-store"'), "no attempt is cached");
expect(serviceSource.includes("AbortSignal.timeout("), "every attempt is bounded by an abort signal");
expect(!serviceSource.includes("response.text("), "the store's response body is never read");
expect(!serviceSource.includes("response.json("), "and never parsed");
expect(serviceSource.includes("timingSafeEqual("), "the verifier compares without a length-dependent early exit");
expect(serviceSource.includes("requireStoreWebhookEndpoint(payload.endpointUrl)"), "the endpoint is re-validated at attempt time");
expect(!serviceSource.includes("console."), "nothing here prints");
expectEqual(
  serviceSource.match(/signing_secret_ciphertext/gu)?.length,
  3,
  "the secret's ciphertext is only named to read it: the column list, the row schema and the seal",
);
expect(fieldsSource.includes('"x-kd-signature"'), "the signature header is named in the vocabulary");
expect(maximumOf(fieldsSource), "the attempt ceiling is a named constant rather than a literal in the handler");
expect(runtimeSource.includes("openSecret(masterKey, box, context)"), "the runtime opens the secret with the environment key");
expect(serviceSource.includes("credentialSecretContext(credential.company_id)"), "and only under the tenant's own context");
expect(!runtimeSource.includes("console."), "the runtime prints nothing");

function maximumOf(source: string): boolean {
  return source.includes("export const STORE_WEBHOOK_MAXIMUM_ATTEMPTS = 5;");
}

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`store webhook gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `store webhook gate passed: ${String(checkCount)} checks, one signed event per payment state delivered to a ` +
      "validated public endpoint, the store's own status classified into retry or decision, the queue's backoff and " +
      "ceiling carrying the retries, byte-identical bodies with fresh signatures, and a chain that names every " +
      "attempt without the secret or the path\n",
  );
}
