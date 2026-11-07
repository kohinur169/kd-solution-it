// path: lib/api/store-payments.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isConflictError, type RestClient } from "../auth/rest.ts";
import { AppError, type ErrorDetail } from "../errors/app-error.ts";
import { isProviderKey, PROVIDER_KEYS, type ProviderKey } from "../payments/registry.ts";
import { routePayment, type RoutingRule } from "../payments/routing.ts";
import {
  API_IDEMPOTENCY_FIELD,
  API_IDEMPOTENCY_HEADER,
  API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH,
  API_IDEMPOTENCY_KEY_MINIMUM_LENGTH,
  API_IDEMPOTENCY_KEY_PATTERN,
  API_IDEMPOTENCY_TTL_SECONDS,
  API_PAYMENT_AUDIT,
  API_PAYMENT_BODY_MAXIMUM_BYTES,
  API_PAYMENT_CAPABILITY,
  API_PAYMENT_CURRENCY,
  API_PAYMENT_DEFAULT_METHOD,
  API_PAYMENT_ENTITY,
  API_PAYMENT_FIELD,
  API_PAYMENT_MAXIMUM_AMOUNT_MINOR,
  API_PAYMENT_METHODS,
  API_PAYMENT_MINIMUM_AMOUNT_MINOR,
  API_PAYMENT_OBJECT,
  API_PAYMENT_RULES,
  API_PAYMENT_SCOPE,
  API_PAYMENT_STATUS,
  API_PAYMENT_TABLES,
  type ApiPaymentMethod,
  type ApiStorePaymentRequest,
  type ApiStorePaymentView,
} from "./payment-fields.ts";
import type { ApiPrincipal } from "./public-fields.ts";

/**
 * Section 20's store payment creation: one authenticated call from an online store, one payment, one answer.
 *
 * ## The order, and why it is that order
 *
 * **Key, body, key row, route, payment, answer, replay.** The idempotency header is read first, because a call
 * without one cannot be made safely at all - a store that retries would be charged twice and the platform would
 * have no way to know. The body is parsed before a single query, so a malformed request costs nothing. The key
 * row is written *before* the payment, because the row is what makes the second delivery of the same request
 * find the first: a payment written before its key is a payment a retry can duplicate.
 *
 * ## What the idempotency row actually guarantees
 *
 * `0033` makes `(company_id, scope, key_hash)` unique. The service hashes the caller's key with SHA-256 and
 * never stores the key itself, so the database holds what it needs to *refuse* a replay and not what would
 * *use* one. `request_hash` is the same idea for the body: a key reused with a different amount is not a retry,
 * it is a mistake, and `IDEMPOTENCY_CONFLICT` is the answer the error vocabulary already holds.
 *
 * The row has three states and each has one meaning here:
 *
 *   - `in_flight` - the first attempt has not finished; a second caller is told to retry rather than start a
 *     second payment, which is what `CONFLICT` with `idempotency_in_flight` says;
 *   - `completed` - the answer is stored verbatim, so a replay of the same request receives the same bytes and
 *     the same `201`;
 *   - `failed` - the attempt is spent. `0033`'s own guard refuses a decided key that returns to flight, so the
 *     service says so (`idempotency_failed`) instead of pretending the key can be reused.
 *
 * ## Routing, and what happens when no rule answers
 *
 * The merchant's rules for this mode and the platform's rules are read, the providers behind them are read in
 * one query, and `routePayment` decides - highest priority first, provider must be able to accept. No match is
 * not a 500 and not a silent default: section 6 says a payment with no matching rule is rejected, so the key is
 * marked `failed` with `route_unavailable` and the store is told `422`. A refusal that spends the key is
 * deliberate: the caller must retry with a new key, which keeps the contract "one key, one decision".
 *
 * ## What the platform never sees
 *
 * No card, no customer, no address, no store name. The body is an amount, a currency and a method; the card
 * arrives later, in the provider's own hosted fields, on a surface this STEP does not serve. That is why a
 * created payment is `pending` with `provider_key_id` null: nothing has been sent to a gateway yet.
 */

/** What this service needs from the outside world, injected so the gate can drive it without a database. */
export interface StorePaymentDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
}

/** One authenticated store payment request, after the header and the body have been read. */
export interface StorePaymentInput {
  readonly principal: ApiPrincipal;
  readonly idempotencyKey: string;
  readonly request: ApiStorePaymentRequest;
}

/** What a created payment answers: the view, and whether this body is a first answer replayed. */
export interface StorePaymentOutcome {
  readonly status: 201;
  readonly body: ApiStorePaymentView;
  readonly replayed: boolean;
}

const SHA_256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/** The SHA-256 of a string, as the lower case hex `0033` stores. */
function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function refusal(field: string, rule: string, code: "VALIDATION_FAILED" | "IDEMPOTENCY_CONFLICT" | "CONFLICT" = "VALIDATION_FAILED"): AppError {
  return new AppError(code, { details: [{ field, rule }] });
}

/**
 * The idempotency key a request carries, or a refusal.
 *
 * Read before anything else, and refused in two parts so a client can tell "you forgot" from "that value is not
 * a key". Neither message quotes the value: a key is a caller's secret, and a refusal that echoes it puts it in
 * a log.
 */
export function readIdempotencyKey(request: Request): string {
  const header = request.headers.get(API_IDEMPOTENCY_HEADER);

  if (header === null || header.trim().length === 0) {
    throw refusal(API_IDEMPOTENCY_FIELD, API_PAYMENT_RULES.idempotencyKeyMissing);
  }

  const key = header.trim();

  if (
    key.length < API_IDEMPOTENCY_KEY_MINIMUM_LENGTH ||
    key.length > API_IDEMPOTENCY_KEY_MAXIMUM_LENGTH ||
    !API_IDEMPOTENCY_KEY_PATTERN.test(key)
  ) {
    throw refusal(API_IDEMPOTENCY_FIELD, API_PAYMENT_RULES.idempotencyKeyMalformed);
  }

  return key;
}

/**
 * The body, read once, bounded twice.
 *
 * A declared `Content-Length` past the ceiling is refused without reading the stream at all; a body without one
 * (a chunked upload) is counted as it is read, so the ceiling holds either way. JSON that does not parse is a
 * `body_malformed` refusal rather than the framework's error page.
 */
export async function readPaymentBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number.parseInt(declared, 10) > API_PAYMENT_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: "body", rule: API_PAYMENT_RULES.bodyTooLarge }],
    });
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > API_PAYMENT_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: "body", rule: API_PAYMENT_RULES.bodyTooLarge }],
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw refusal("body", API_PAYMENT_RULES.bodyMalformed);
  }
}

const requestSchema = z.strictObject({
  amount_minor: z.number(),
  currency: z.string().optional(),
  payment_method: z.string().optional(),
});

/**
 * The request as a typed value, or a refusal that names one field and one rule.
 *
 * The schema is strict, so a body carrying `company_id`, `mode`, `status` or anything else is refused rather
 * than ignored: the company comes from the key that authenticated the call and nowhere else, and a field the
 * platform silently drops is a field a client believes it set.
 */
export function parseStorePaymentRequest(value: unknown): ApiStorePaymentRequest {
  // The one absence worth its own word: a store that forgot the amount is told to add it, rather than that
  // something about the body's shape was wrong.
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("amount_minor" in value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "amount_minor", rule: API_PAYMENT_RULES.amountMissing }],
    });
  }

  const parsed = requestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error) });
  }

  const details: ErrorDetail[] = [];
  const amount = parsed.data.amount_minor;

  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    details.push({ field: "amount_minor", rule: API_PAYMENT_RULES.amountNotWhole });
  } else if (amount < API_PAYMENT_MINIMUM_AMOUNT_MINOR) {
    details.push({ field: "amount_minor", rule: API_PAYMENT_RULES.amountTooSmall });
  } else if (amount > API_PAYMENT_MAXIMUM_AMOUNT_MINOR) {
    details.push({ field: "amount_minor", rule: API_PAYMENT_RULES.amountTooLarge });
  }

  if (parsed.data.currency !== undefined && parsed.data.currency !== API_PAYMENT_CURRENCY) {
    details.push({ field: "currency", rule: API_PAYMENT_RULES.currencyUnsupported });
  }

  const method = parsed.data.payment_method ?? API_PAYMENT_DEFAULT_METHOD;

  if (!(API_PAYMENT_METHODS as readonly string[]).includes(method)) {
    details.push({ field: "payment_method", rule: API_PAYMENT_RULES.methodUnsupported });
  }

  if (details.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details });
  }

  return {
    amountMinor: amount,
    currency: API_PAYMENT_CURRENCY,
    method: method as ApiPaymentMethod,
  };
}

/** Zod's issues as the platform's `{field, rule}` details, one per field, first issue wins. */
function detailsOf(error: z.ZodError): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (!details.some((detail) => detail.field === key)) {
          details.push({ field: key, rule: API_PAYMENT_RULES.unknownField });
        }
      }

      continue;
    }

    const field = String(issue.path[0] ?? API_PAYMENT_FIELD);

    if (details.some((detail) => detail.field === field)) {
      continue;
    }

    details.push({ field, rule: "invalid_format" });
  }

  return details.length === 0 ? [{ field: API_PAYMENT_FIELD, rule: "invalid_format" }] : details;
}

const idempotencyRowSchema = z.object({
  id: z.string().uuid(),
  state: z.enum(["in_flight", "completed", "failed"]),
  request_hash: z.string(),
  response_status: z.number().int().nullable(),
  response_body: z.string().nullable(),
  version: z.number().int().positive(),
});

type IdempotencyRow = z.infer<typeof idempotencyRowSchema>;

const routingRuleRowSchema = z.object({
  id: z.string().uuid(),
  provider_id: z.string().uuid(),
  payment_method: z.string().nullable(),
  country_code: z.string().nullable(),
  priority: z.number().int(),
});

const providerRowSchema = z.object({
  id: z.string().uuid(),
  provider_key: z.string(),
  supports_acceptance: z.boolean(),
  status: z.string(),
  deleted_at: z.string().nullable(),
});

const paymentRowSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  created_at: z.string(),
});

const KEY_COLUMNS =
  "select=id,state,request_hash,response_status,response_body,version&deleted_at=is.null&limit=1";
const RULE_COLUMNS =
  "select=id,provider_id,payment_method,country_code,priority&status=eq.active&deleted_at=is.null&limit=100";

async function findKeyRow(
  dependencies: StorePaymentDependencies,
  companyId: string,
  keyHash: string,
): Promise<IdempotencyRow | null> {
  const rows = await dependencies.rest.select(
    API_PAYMENT_TABLES.idempotencyKeys,
    `${KEY_COLUMNS}&company_id=eq.${encodeURIComponent(companyId)}` +
      `&scope=eq.${API_PAYMENT_SCOPE}&key_hash=eq.${keyHash}`,
    idempotencyRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * Insert the key row in flight, or answer null when another writer got there first.
 *
 * A unique violation is not an error here: it is the race the table exists to decide, and the caller re-reads
 * the row the winner wrote.
 */
async function claimKey(
  dependencies: StorePaymentDependencies,
  input: { readonly companyId: string; readonly keyHash: string; readonly requestHash: string },
): Promise<IdempotencyRow | null> {
  try {
    const rows = await dependencies.rest.insertReturning(
      API_PAYMENT_TABLES.idempotencyKeys,
      [
        {
          company_id: input.companyId,
          scope: API_PAYMENT_SCOPE,
          key_hash: input.keyHash,
          request_hash: input.requestHash,
          state: "in_flight",
          expires_at: new Date(dependencies.now() + API_IDEMPOTENCY_TTL_SECONDS * 1_000).toISOString(),
        },
      ],
      idempotencyRowSchema,
    );

    return rows[0] ?? null;
  } catch (error) {
    if (isConflictError(error)) {
      return null;
    }

    throw error;
  }
}

/** Record the answer a retry must receive. A lost update is tolerated; the payment exists either way. */
async function completeKey(
  dependencies: StorePaymentDependencies,
  row: IdempotencyRow,
  body: ApiStorePaymentView,
): Promise<void> {
  try {
    await dependencies.rest.update(
      API_PAYMENT_TABLES.idempotencyKeys,
      `id=eq.${encodeURIComponent(row.id)}&state=eq.in_flight&version=eq.${String(row.version)}`,
      {
        state: "completed",
        response_status: 201,
        response_body: JSON.stringify(body),
        completed_at: new Date(dependencies.now()).toISOString(),
      },
    );
  } catch {
    // The payment is made and the answer is sent; the key stays in flight, which a retry reports as such.
  }
}

/** Spend the key on a refusal that must not be retried under the same value. */
async function failKey(
  dependencies: StorePaymentDependencies,
  row: IdempotencyRow,
  rule: string,
): Promise<void> {
  try {
    await dependencies.rest.update(
      API_PAYMENT_TABLES.idempotencyKeys,
      `id=eq.${encodeURIComponent(row.id)}&state=eq.in_flight&version=eq.${String(row.version)}`,
      { state: "failed", error_detail: rule },
    );
  } catch {
    // A key that cannot be marked failed is not a reason to leave the caller without an answer.
  }
}

/** The answer a decided key gives, whatever decided it. */
function outcomeOfExisting(row: IdempotencyRow, requestHash: string): StorePaymentOutcome {
  if (row.request_hash !== requestHash) {
    throw refusal(API_IDEMPOTENCY_FIELD, API_PAYMENT_RULES.idempotencyConflict, "IDEMPOTENCY_CONFLICT");
  }

  if (row.state === "in_flight") {
    throw refusal(API_IDEMPOTENCY_FIELD, API_PAYMENT_RULES.idempotencyInFlight, "CONFLICT");
  }

  if (row.state === "failed") {
    throw refusal(API_IDEMPOTENCY_FIELD, API_PAYMENT_RULES.idempotencyFailed, "CONFLICT");
  }

  if (row.response_body === null || row.response_status !== 201) {
    throw new AppError("INTERNAL_ERROR");
  }

  let body: unknown;

  try {
    body = JSON.parse(row.response_body) as unknown;
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }

  return { status: 201, body: body as ApiStorePaymentView, replayed: true };
}

interface RoutingAnswer {
  readonly providerId: string;
  readonly ruleId: string;
  readonly providerKey: ProviderKey;
}

/**
 * The provider a store payment goes to, or null when the merchant has no rule that accepts it.
 *
 * Three reads and no loop: the merchant's rules for this mode, the platform's rules, and the providers behind
 * both. A rule whose provider is missing, disabled, deleted or unable to accept is dropped before the engine
 * sees it - the engine decides between usable routes, not between rows that cannot work.
 */
async function routingAnswerOf(
  dependencies: StorePaymentDependencies,
  input: { readonly companyId: string; readonly mode: string; readonly method: ApiPaymentMethod },
): Promise<RoutingAnswer | null> {
  const merchantRules = await dependencies.rest.select(
    API_PAYMENT_TABLES.routingRules,
    `${RULE_COLUMNS}&company_id=eq.${encodeURIComponent(input.companyId)}&mode=eq.${encodeURIComponent(input.mode)}`,
    routingRuleRowSchema,
  );
  const platformRules = await dependencies.rest.select(
    API_PAYMENT_TABLES.routingRules,
    `${RULE_COLUMNS}&company_id=is.null&mode=eq.${encodeURIComponent(input.mode)}`,
    routingRuleRowSchema,
  );
  const ruleRows = [...merchantRules, ...platformRules];

  if (ruleRows.length === 0) {
    return null;
  }

  const providerIds = [...new Set(ruleRows.map((row) => row.provider_id))];
  const providers = await dependencies.rest.select(
    API_PAYMENT_TABLES.paymentProviders,
    `select=id,provider_key,supports_acceptance,status,deleted_at&deleted_at=is.null` +
      `&id=in.(${providerIds.map((id) => encodeURIComponent(id)).join(",")})&limit=100`,
    providerRowSchema,
  );
  const usable = new Map<string, ProviderKey>();

  for (const provider of providers) {
    if (provider.supports_acceptance && provider.status === "active" && isProviderKey(provider.provider_key)) {
      usable.set(provider.id, provider.provider_key);
    }
  }

  const rules: RoutingRule[] = [];

  for (const row of ruleRows) {
    const providerKey = usable.get(row.provider_id);

    if (providerKey === undefined) {
      continue;
    }

    rules.push({
      id: row.id,
      capability: API_PAYMENT_CAPABILITY,
      providerKey,
      priority: row.priority,
      ...(row.payment_method === null ? {} : { method: row.payment_method }),
      ...(row.country_code === null ? {} : { country: row.country_code }),
    });
  }

  const decision = routePayment({ capability: API_PAYMENT_CAPABILITY, method: input.method }, rules);

  if (!decision.matched) {
    return null;
  }

  const chosen = ruleRows.find((row) => row.id === decision.ruleId);
  const providerKey = chosen === undefined ? undefined : usable.get(chosen.provider_id);

  return chosen === undefined || providerKey === undefined
    ? null
    : { providerId: chosen.provider_id, ruleId: chosen.id, providerKey };
}

/** The chain entry: what was created, for which merchant, and nothing that identifies the caller's key. */
async function noteCreatedPayment(
  dependencies: StorePaymentDependencies,
  input: {
    readonly principal: ApiPrincipal;
    readonly view: ApiStorePaymentView;
    readonly providerKey: ProviderKey;
    readonly ipAddress: string | null;
  },
): Promise<void> {
  const entry: AuditEntry = {
    action: API_PAYMENT_AUDIT.created,
    actorUserId: null,
    entityType: API_PAYMENT_ENTITY,
    entityId: input.view.id,
    payload: {
      amount_minor: input.view.amount_minor,
      currency: input.view.currency,
      mode: input.view.mode,
      payment_method: input.view.payment_method,
      provider: input.providerKey,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.ipAddress,
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // The payment is made. A chain that cannot be written is the platform's problem, not the store's;
    // STEP 202's call entry records the request either way.
  }
}

/**
 * Create a store payment, once per idempotency key.
 *
 * The flow is the one in the file header: find the key, claim it, route, write the payment, answer, finish the
 * key. Every refusal that spends the key marks it failed first, so a retry of a refused request is told the key
 * is spent rather than repeating a decision the platform already made.
 */
export async function createStorePayment(
  input: StorePaymentInput,
  dependencies: StorePaymentDependencies,
): Promise<StorePaymentOutcome> {
  const companyId = input.principal.companyId;
  const mode = input.principal.mode;
  const keyHash = hashOf(input.idempotencyKey);
  const requestHash = hashOf(
    JSON.stringify([input.request.amountMinor, input.request.currency, input.request.method]),
  );

  if (!SHA_256_HEX_PATTERN.test(keyHash) || !SHA_256_HEX_PATTERN.test(requestHash)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const existing = await findKeyRow(dependencies, companyId, keyHash);

  if (existing !== null) {
    return outcomeOfExisting(existing, requestHash);
  }

  const claimed = await claimKey(dependencies, { companyId, keyHash, requestHash });

  if (claimed === null) {
    const raced = await findKeyRow(dependencies, companyId, keyHash);

    if (raced === null) {
      throw new AppError("DEPENDENCY_FAILED");
    }

    return outcomeOfExisting(raced, requestHash);
  }

  const routing = await routingAnswerOf(dependencies, {
    companyId,
    mode,
    method: input.request.method,
  });

  if (routing === null) {
    await failKey(dependencies, claimed, API_PAYMENT_RULES.routeUnavailable);

    throw refusal(API_PAYMENT_FIELD, API_PAYMENT_RULES.routeUnavailable);
  }

  let row: z.infer<typeof paymentRowSchema>;

  try {
    const inserted = await dependencies.rest.insertReturning(
      API_PAYMENT_TABLES.payments,
      [
        {
          company_id: companyId,
          provider_id: routing.providerId,
          routing_rule_id: routing.ruleId,
          idempotency_key_id: claimed.id,
          mode,
          payment_method: input.request.method,
          amount_minor: input.request.amountMinor,
          currency: input.request.currency,
          status: API_PAYMENT_STATUS,
        },
      ],
      paymentRowSchema,
    );
    const written = inserted[0];

    if (written === undefined) {
      throw new AppError("DEPENDENCY_FAILED");
    }

    row = written;
  } catch (error) {
    await failKey(dependencies, claimed, "payment_not_written");

    throw error;
  }

  const view: ApiStorePaymentView = {
    id: row.id,
    object: API_PAYMENT_OBJECT,
    status: API_PAYMENT_STATUS,
    amount_minor: input.request.amountMinor,
    currency: API_PAYMENT_CURRENCY,
    mode: mode === "live" ? "live" : "test",
    payment_method: input.request.method,
    created_at: row.created_at,
  };

  await completeKey(dependencies, claimed, view);
  await noteCreatedPayment(dependencies, {
    principal: input.principal,
    view,
    providerKey: routing.providerKey,
    ipAddress: null,
  });

  return { status: 201, body: view, replayed: false };
}

/** The provider keys this STEP will route to, exposed so the gate can prove the list is the registry's. */
export const STORE_PAYMENT_PROVIDER_KEYS: readonly ProviderKey[] = PROVIDER_KEYS;
