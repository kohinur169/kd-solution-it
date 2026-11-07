// path: lib/api/sandbox-webhook.ts
import { z } from "zod";
import type { AuditEntry } from "../auth/audit.ts";
import { AppError, isAppError, type ErrorDetail } from "../errors/app-error.ts";
import type { ApiPrincipal } from "./public-fields.ts";
import { assertTestCredential } from "./sandbox-payment.ts";
import {
  API_SANDBOX_WEBHOOK_AUDIT,
  API_SANDBOX_WEBHOOK_BODY_FIELD,
  API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES,
  API_SANDBOX_WEBHOOK_ENDPOINT_FIELD,
  API_SANDBOX_WEBHOOK_ENTITY,
  API_SANDBOX_WEBHOOK_OBJECT,
  API_SANDBOX_WEBHOOK_PAYMENT_COLUMNS,
  API_SANDBOX_WEBHOOK_REPORTED_RULES,
  API_SANDBOX_WEBHOOK_RULES,
  API_SANDBOX_WEBHOOK_TIMEOUT_MS,
  type ApiSandboxWebhookRequest,
  type ApiSandboxWebhookView,
} from "./sandbox-webhook-fields.ts";
import {
  API_PAYMENT_STATUS_RULES,
  API_STORE_PAYMENT_STATUSES,
  parsePaymentId,
} from "./store-payment-status.ts";
import {
  STORE_WEBHOOK_RULES,
  storeWebhookEventOf,
  type StoreWebhookPayment,
  type StoreWebhookRule,
} from "./store-webhook-fields.ts";
import {
  deliverStoreWebhook,
  requireStoreWebhookEndpoint,
  storeWebhookEventIdOf,
  type StoreWebhookDeliveryDependencies,
  type StoreWebhookTransport,
} from "./store-webhooks.ts";

/**
 * Section 8's simulated webhook: the platform's real delivery, on demand.
 *
 * ## Why this is orchestration rather than a second implementation
 *
 * Every part of a delivery that a merchant's verifier can notice already lives in STEP 205 and is reused here
 * unchanged: the envelope and its field order, the serialised bytes and their ceiling, the HMAC scheme and its
 * timestamp, the four headers, the endpoint validation, the transport's `redirect: "manual"` and `cache: "no-store"`,
 * the status classification, and the credential read that opens the signing secret under the tenant's associated
 * data. A simulation that built its own envelope would be a test a store could pass while production failed.
 *
 * What is **not** reused is STEP 205's control flow, and that is the one deliberate difference. A queued delivery
 * throws on a transient failure so the queue can retry it; this call has no queue, no retry and no job, and a store
 * whose endpoint timed out is a **result to report**, not an exception to raise. So the attempt is made with an
 * attempt ceiling of one and the transient throw is read back into a rule.
 *
 * ## What the merchant learns
 *
 * Whether the endpoint accepted the event, the store's own HTTP status, and STEP 205's rule for it - the same words a
 * production delivery produces in the chain, so what a store reads here is what it will read later. The answer names
 * the endpoint by **host** only: a merchant's webhook path may be a secret of its own.
 */

/** The dependencies a simulated delivery needs: STEP 205's delivery port, unchanged. */
export type SandboxWebhookDependencies = StoreWebhookDeliveryDependencies;

/** One simulated delivery: the id from the path, the caller the pipeline proved, and where to send. */
export interface SandboxWebhookInput {
  readonly paymentId: string;
  readonly principal: ApiPrincipal;
  readonly clientAddress: string | null;
  readonly request: ApiSandboxWebhookRequest;
}

/** What a simulated delivery answers. */
export interface SandboxWebhookOutcome {
  readonly status: 200;
  readonly body: ApiSandboxWebhookView;
}

const paymentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(API_STORE_PAYMENT_STATUSES),
  amount_minor: z.number().int(),
  refunded_minor: z.number().int(),
  currency: z.string(),
  mode: z.enum(["test", "live"]),
  payment_method: z.enum(["card", "bank_transfer", "e_wallet"]),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type PaymentRow = z.infer<typeof paymentSchema>;

const requestSchema = z.strictObject({ endpoint_url: z.string() });

/**
 * The body, read once, bounded twice - STEP 203's and STEP 206's shape.
 *
 * A declared `Content-Length` past the ceiling is refused without reading the stream; a chunked body is counted as it
 * is read; JSON that does not parse is refused rather than answered with the framework's error page.
 */
export async function readSandboxWebhookBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number.parseInt(declared, 10) > API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: API_SANDBOX_WEBHOOK_BODY_FIELD, rule: API_SANDBOX_WEBHOOK_RULES.bodyTooLarge }],
    });
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > API_SANDBOX_WEBHOOK_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: API_SANDBOX_WEBHOOK_BODY_FIELD, rule: API_SANDBOX_WEBHOOK_RULES.bodyTooLarge }],
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: API_SANDBOX_WEBHOOK_BODY_FIELD, rule: API_SANDBOX_WEBHOOK_RULES.bodyMalformed }],
    });
  }
}

/**
 * The request as a typed value, or a refusal that names one field and one rule.
 *
 * Strict, for STEP 203's reason: a body carrying `event_type`, `payment_id` or `signature` is refused rather than
 * ignored. The event is decided by the payment's own state, so a caller cannot ask the platform to announce a refund
 * that never happened.
 */
export function parseSandboxWebhookRequest(value: unknown): ApiSandboxWebhookRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("endpoint_url" in value)
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [
        { field: API_SANDBOX_WEBHOOK_ENDPOINT_FIELD, rule: API_SANDBOX_WEBHOOK_RULES.endpointMissing },
      ],
    });
  }

  const parsed = requestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error) });
  }

  return { endpointUrl: parsed.data.endpoint_url };
}

/** Zod's issues as the platform's `{field, rule}` details, one per field, first issue wins. */
function detailsOf(error: z.ZodError): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (!details.some((detail) => detail.field === key)) {
          details.push({ field: key, rule: API_SANDBOX_WEBHOOK_RULES.unknownField });
        }
      }
    }
  }

  if (details.length === 0) {
    details.push({
      field: API_SANDBOX_WEBHOOK_ENDPOINT_FIELD,
      rule: API_SANDBOX_WEBHOOK_RULES.endpointMissing,
    });
  }

  return details;
}

/** One line in the chain for a simulated delivery that never left the platform. */
async function noteRefused(
  dependencies: SandboxWebhookDependencies,
  input: SandboxWebhookInput,
  paymentId: string | null,
  rule: string,
): Promise<void> {
  const entry: AuditEntry = {
    action: API_SANDBOX_WEBHOOK_AUDIT.refused,
    actorUserId: null,
    entityType: API_SANDBOX_WEBHOOK_ENTITY,
    entityId: paymentId,
    payload: {
      rule,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The refusal is the answer. A chain that cannot be written does not make a live credential simulable.
  }
}

/**
 * Refuse a live credential, and record that you did.
 *
 * The route calls this **before** it reads a body, so a live key costs nothing beyond the authentication STEP 202
 * already did; the service calls it again before its first query, because a fence that lives only in a route is a
 * fence the next route forgets. A test credential passes through silently.
 */
export async function guardSimulatedCredential(
  principal: ApiPrincipal,
  dependencies: { readonly audit: SandboxWebhookDependencies["audit"]; readonly clientAddress: string | null },
): Promise<void> {
  if (principal.mode === "test") {
    return;
  }

  const entry: AuditEntry = {
    action: API_SANDBOX_WEBHOOK_AUDIT.refused,
    actorUserId: null,
    entityType: API_SANDBOX_WEBHOOK_ENTITY,
    entityId: null,
    payload: {
      rule: API_SANDBOX_WEBHOOK_RULES.liveCredential,
      mode: principal.mode,
      credential_id: principal.credentialId,
    },
    companyId: principal.companyId,
    sessionId: null,
    ipAddress: dependencies.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The refusal is the answer. A chain that cannot be written does not make a live payment simulable.
  }

  assertTestCredential(principal);
}

/** One line in the chain for a simulated delivery that was attempted. */
async function noteSimulation(
  dependencies: SandboxWebhookDependencies,
  input: SandboxWebhookInput,
  body: ApiSandboxWebhookView,
): Promise<void> {
  const entry: AuditEntry = {
    action: API_SANDBOX_WEBHOOK_AUDIT.simulated,
    actorUserId: null,
    entityType: API_SANDBOX_WEBHOOK_ENTITY,
    entityId: input.paymentId,
    payload: {
      event_id: body.id,
      event_type: body.type,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
      delivered: body.delivered,
      rule: body.rule,
      status_code: body.status_code,
      endpoint_host: body.endpoint_host,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The delivery happened. A chain that cannot be written does not change what the store received.
  }
}

/** The host of an already validated endpoint; never the path, which a merchant may have made unguessable. */
function hostOf(endpointUrl: string): string {
  return new URL(endpointUrl).hostname;
}

/** Whether a word is one of STEP 205's rules. */
function isWebhookRule(value: unknown): value is StoreWebhookRule {
  return (
    typeof value === "string" &&
    (Object.values(STORE_WEBHOOK_RULES) as readonly string[]).includes(value)
  );
}

/**
 * The rule a transient failure carried.
 *
 * STEP 205 throws `DEPENDENCY_FAILED` with the rule as its cause so a queue can classify the failure. This call has
 * no queue, so it reads the rule back - the same evidence, used for a report rather than a retry. A failure that
 * carries no readable rule is not this module's to interpret and is rethrown.
 */
function ruleOfThrownDelivery(error: unknown): StoreWebhookRule {
  if (!isAppError(error) || error.code !== "DEPENDENCY_FAILED") {
    throw error;
  }

  const cause = error.cause;

  if (typeof cause !== "object" || cause === null || !("rule" in cause)) {
    throw error;
  }

  const rule = (cause as { rule: unknown }).rule;

  if (!isWebhookRule(rule)) {
    throw error;
  }

  return rule;
}

/** Whether a rule describes what the store's endpoint did, which is the only kind this call reports. */
function isReportedRule(rule: StoreWebhookRule): boolean {
  return (API_SANDBOX_WEBHOOK_REPORTED_RULES as readonly string[]).includes(rule);
}

/** The payment inside the envelope: STEP 205's own shape, built from the row this service read. */
function paymentOf(row: PaymentRow): StoreWebhookPayment {
  return {
    id: row.id,
    object: "payment",
    status: row.status,
    amount_minor: row.amount_minor,
    refunded_minor: row.refunded_minor,
    currency: row.currency,
    mode: row.mode,
    payment_method: row.payment_method,
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * The transport STEP 205 delivers with, capped at the shorter deadline this call can afford - and watched.
 *
 * STEP 205 throws on a transient failure so a queue can retry it, and the throw carries the rule but not the status
 * the store answered with. A report that says "busy" without saying "429" is half an answer, so the wrapper records
 * the status it saw on the way past; the status is the store's own number, observed by this call, not a guess.
 */
function observingDeadline(
  send: StoreWebhookTransport,
  timeoutMs: number,
  observation: { status: number | null },
): StoreWebhookTransport {
  return async (request) => {
    const response = await send({ ...request, timeoutMs });

    observation.status = response.status;

    return response;
  };
}

/**
 * Send one payment's current event to an endpoint the merchant names, and report what the endpoint did.
 *
 * Five steps and no retry: the credential fence, the payment read, the endpoint fence, the delivery, the report. The
 * payment is read in this request rather than taken from a caller's body, so the event describes the row the
 * platform actually holds - and it is read in **test** mode, so a live payment is not reachable through this call
 * even if the fence above it were removed.
 */
export async function sendSimulatedWebhook(
  input: SandboxWebhookInput,
  dependencies: SandboxWebhookDependencies,
): Promise<SandboxWebhookOutcome> {
  // The fence again, before the first query: the route already called it, and a service that trusts its caller is one
  // refactor away from delivering a live payment's event.
  await guardSimulatedCredential(input.principal, {
    audit: dependencies.audit,
    clientAddress: input.clientAddress,
  });

  let paymentId: string;

  try {
    paymentId = parsePaymentId(input.paymentId);
  } catch (error) {
    await noteRefused(dependencies, input, null, API_PAYMENT_STATUS_RULES.malformed);

    throw error;
  }

  const rows = await dependencies.rest.select(
    "payments",
    `select=${API_SANDBOX_WEBHOOK_PAYMENT_COLUMNS}` +
      `&id=eq.${encodeURIComponent(paymentId)}` +
      `&company_id=eq.${encodeURIComponent(input.principal.companyId)}` +
      "&mode=eq.test&invoice_id=is.null&deleted_at=is.null&limit=1",
    paymentSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    await noteRefused(dependencies, input, paymentId, API_PAYMENT_STATUS_RULES.notFound);

    // STEP 204's one answer for five states: unknown, another merchant's, a live-mode payment, an invoice payment, a
    // deleted one.
    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: "id", rule: API_PAYMENT_STATUS_RULES.notFound }],
    });
  }

  const eventType = storeWebhookEventOf(row.status);

  if (eventType === null) {
    await noteRefused(dependencies, input, paymentId, API_SANDBOX_WEBHOOK_RULES.paymentNotDeliverable);

    // A payment that has not moved has no event. Announcing `payment.pending` would teach a store's handler to accept
    // a state the platform never delivers, so the call says what is wrong instead.
    throw new AppError("VALIDATION_FAILED", {
      details: [
        { field: "payment.status", rule: API_SANDBOX_WEBHOOK_RULES.paymentNotDeliverable },
      ],
    });
  }

  // The endpoint fence, STEP 205's own function: https only, a public host, no credentials in the URL, the default
  // port and a length ceiling. A refusal here names `endpoint_url` and the reason, before anything is sent.
  const endpointUrl = requireStoreWebhookEndpoint(input.request.endpointUrl);
  const created = Math.floor(dependencies.now() / 1_000);
  const payload = {
    companyId: input.principal.companyId,
    credentialId: input.principal.credentialId,
    mode: "test" as const,
    endpointUrl,
    eventId: storeWebhookEventIdOf({
      companyId: input.principal.companyId,
      paymentId: row.id,
      eventType,
    }),
    eventType,
    created,
    payment: paymentOf(row),
  };

  let delivered = false;
  let rule: StoreWebhookRule | null = null;
  let statusCode: number | null = null;
  const observation: { status: number | null } = { status: null };

  try {
    const outcome = await deliverStoreWebhook(
      payload,
      { attempt: 1, maxAttempts: 1 },
      {
        ...dependencies,
        send: observingDeadline(dependencies.send, API_SANDBOX_WEBHOOK_TIMEOUT_MS, observation),
      },
    );

    delivered = outcome.delivered;
    rule = outcome.rule;
    statusCode = outcome.statusCode;
  } catch (error) {
    rule = ruleOfThrownDelivery(error);
    statusCode = observation.status;
  }

  if (!delivered && (rule === null || !isReportedRule(rule))) {
    // The platform could not sign or could not build the envelope. That is not the merchant's server's doing, and it
    // is not something a report of "your endpoint refused" should say.
    throw new AppError("INTERNAL_ERROR", { cause: { rule } });
  }

  const body: ApiSandboxWebhookView = {
    id: payload.eventId,
    object: API_SANDBOX_WEBHOOK_OBJECT,
    type: eventType,
    created,
    endpoint_host: hostOf(endpointUrl),
    delivered,
    rule,
    status_code: statusCode,
  };

  await noteSimulation(dependencies, input, body);

  return { status: 200, body };
}
