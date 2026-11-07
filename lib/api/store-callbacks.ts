// path: lib/api/store-callbacks.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { packSecretBox, unpackSecretBox, type SecretBox } from "../auth/secrets.ts";
import { AppError, type ErrorDetail } from "../errors/app-error.ts";
import { requireHttpUrl } from "../security/url.ts";
import type { ApiPrincipal } from "./public-fields.ts";
import {
  STORE_CALLBACK_AUDIT,
  STORE_CALLBACK_BEARER_PREFIX,
  STORE_CALLBACK_CONTENT_TYPE,
  STORE_CALLBACK_ENTITY,
  STORE_CALLBACK_ID_HEADER,
  STORE_CALLBACK_ID_PREFIX,
  STORE_CALLBACK_MAXIMUM_BODY_BYTES,
  STORE_CALLBACK_OBJECT,
  STORE_CALLBACK_RULES,
  STORE_CALLBACK_TIMEOUT_MS,
  STORE_CALLBACK_TYPE_HEADER,
  STORE_CALLBACK_USER_AGENT,
  storeCallbackTypeOf,
  storeCallbackUrlOf,
  type StoreCallbackEnvelope,
  type StoreCallbackOutcome,
  type StoreCallbackType,
} from "./store-callback-fields.ts";
import {
  STORE_CONNECTION_COLUMNS,
  STORE_CONNECTION_PLATFORM,
  STORE_CONNECTION_TABLE,
  storeConnectionSecretContext,
} from "./store-connection-fields.ts";
import { parsePaymentId, readStorePaymentStatus } from "./store-payment-status.ts";
import {
  STORE_WEBHOOK_RULES,
  storeWebhookRuleForStatus,
  type StoreWebhookRule,
} from "./store-webhook-fields.ts";
import {
  StoreWebhookTransportError,
  type StoreWebhookTransport,
} from "./store-webhooks.ts";

/**
 * Section 20's callback: the platform telling a connected WooCommerce shop what a payment is now.
 *
 * ## The order of the five questions
 *
 * **Is the payment mine, is there a shop, may it be called, will its token open, and what does the shop answer.**
 *
 * The first is STEP 204's own read - the same columns, the same tenant and mode fences, the same `404` for every cause -
 * reused rather than re-implemented, so a callback can never be built from a payment the caller could not have read.
 * The second is one query over `store_connections`, narrowed by tenant and platform. The third is the **URL validator**
 * over the address derived from the stored domain, which is where a connection to a private host is refused before
 * anything leaves the platform. The fourth opens the box STEP 208 sealed, under the same associated data - company,
 * platform **and domain** - so a token copied into another row does not open. Only then does a byte travel.
 *
 * ## What a caller cannot choose
 *
 * The URL, the token, the body, the id and the status. A caller names a payment and nothing else: the address comes
 * from `0035`'s row, the credential from the box, the state from the row STEP 204 read, and the id from a hash of the
 * three. That is what makes this safe to expose as a merchant-facing call: a merchant who asks the platform to call
 * their shop cannot make it call somebody else's.
 *
 * ## One connection, or none
 *
 * `0035` allows a merchant several shops - the unique index is on `(company, platform, domain)`, not on the company -
 * and STEP 203's payment row names no store. So a tenant with two active connections is refused
 * (`connection_ambiguous`) rather than called at a guess: sending shop A a notification about shop B's payment would be
 * worse than a refusal a merchant can act on. A single connection is the ordinary case, and it is the one this STEP
 * delivers.
 *
 * ## Report, do not raise
 *
 * A shop that answers `500`, a shop that redirects, a shop that never answers: those are **outcomes**, answered `200`
 * with STEP 205's own rule word, exactly as STEP 207 reports a probe. Only a platform condition - a box that will not
 * open, a body past its ceiling - is an error, because it is not something the merchant's server did.
 */

/** What a callback needs from the outside world, injected so the gate can drive it without a database or a socket. */
export interface StoreCallbackDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
  /** Opens the sealed store token under its associated data. The key lives in the runtime, not here. */
  readonly openSecret: (box: SecretBox, context: string) => string;
  /** STEP 205's transport: one POST, no redirects, no retries, the body never read. */
  readonly send: StoreWebhookTransport;
}

/** One call: the payment in the path, the caller the pipeline proved, and where it came from. */
export interface StoreCallbackInput {
  readonly paymentId: string;
  readonly principal: ApiPrincipal;
  readonly clientAddress: string | null;
}

const connectionSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  platform: z.enum(["shopify", "woocommerce"]),
  store_domain: z.string(),
  status: z.enum(["pending", "active", "revoked", "error"]),
  external_store_id: z.string().nullable(),
  access_token_ciphertext: z.string(),
  access_token_iv: z.string(),
  access_token_tag: z.string(),
});

type ConnectionRow = z.infer<typeof connectionSchema>;

/**
 * The id of a callback: stable for one `(company, payment, status)` and different for every other.
 *
 * Deterministic for STEP 205's reason - a shop that dedupes on the id must see a redelivery of the same state as the
 * same callback - and a refund after a capture is a different status, so it is a different id.
 */
export function storeCallbackIdOf(input: {
  readonly companyId: string;
  readonly paymentId: string;
  readonly type: StoreCallbackType;
}): string {
  const digest = createHash("sha256")
    .update(`${input.companyId}|${input.paymentId}|${input.type}`, "utf8")
    .digest("hex");

  return `${STORE_CALLBACK_ID_PREFIX}${digest.slice(0, 32)}`;
}

/** The host a merchant's dashboard may show: the address a callback lands on, never its path or its query. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

/** A chain entry, best effort: a delivered callback is not undone by a chain that cannot be written. */
async function note(dependencies: { readonly audit: AuditTrail }, entry: AuditEntry): Promise<void> {
  try {
    await dependencies.audit.append(entry);
  } catch {
    // The delivery is the fact. A chain outage must not turn a shop's `200` into the platform's failure.
  }
}

/** A refusal the merchant can act on, recorded before it is thrown. */
async function refuse(
  dependencies: StoreCallbackDependencies,
  input: StoreCallbackInput,
  rule: string,
  error: AppError,
): Promise<never> {
  await note(dependencies, {
    action: STORE_CALLBACK_AUDIT.refused,
    actorUserId: null,
    entityType: STORE_CALLBACK_ENTITY,
    entityId: input.paymentId,
    payload: {
      rule,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  });

  throw error;
}

/** Every living connection of one merchant on this platform, newest first, at most two read. */
async function readConnections(
  dependencies: StoreCallbackDependencies,
  companyId: string,
): Promise<readonly ConnectionRow[]> {
  return dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${STORE_CONNECTION_COLUMNS},company_id,access_token_ciphertext,access_token_iv,access_token_tag` +
      `&company_id=eq.${encodeURIComponent(companyId)}` +
      `&platform=eq.${STORE_CONNECTION_PLATFORM}&deleted_at=is.null` +
      "&order=connected_at.desc&limit=2",
    connectionSchema,
  );
}

/**
 * The one connection a callback may use, or the refusal that says why it cannot.
 *
 * Read here rather than by a shared helper because the *uniqueness* is this surface's requirement: a settings screen
 * that lists connections (STEP 208's status read) is happy with any of them, while a callback that guesses is a
 * callback that lies to one shop about another shop's money.
 */
async function connectionOf(
  dependencies: StoreCallbackDependencies,
  input: StoreCallbackInput,
): Promise<ConnectionRow> {
  const connections = await readConnections(dependencies, input.principal.companyId);

  if (connections.length === 0) {
    await refuse(
      dependencies,
      input,
      STORE_CALLBACK_RULES.connectionMissing,
      new AppError("CONFLICT", {
        details: [{ field: "connection", rule: STORE_CALLBACK_RULES.connectionMissing }],
      }),
    );
  }

  if (connections.length > 1) {
    await refuse(
      dependencies,
      input,
      "connection_ambiguous",
      new AppError("CONFLICT", { details: [{ field: "connection", rule: "connection_ambiguous" }] }),
    );
  }

  const connection = connections[0];

  if (connection === undefined) {
    // Unreachable: a non-empty array's first element exists. Kept so the type is a row rather than a maybe.
    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "connection_unreadable" } });
  }

  if (connection.status === "revoked") {
    await refuse(
      dependencies,
      input,
      STORE_CALLBACK_RULES.connectionRevoked,
      new AppError("CONFLICT", {
        details: [{ field: "connection", rule: STORE_CALLBACK_RULES.connectionRevoked }],
      }),
    );
  }

  if (connection.status !== "active") {
    await refuse(
      dependencies,
      input,
      STORE_CALLBACK_RULES.connectionNotActive,
      new AppError("CONFLICT", {
        details: [{ field: "connection", rule: STORE_CALLBACK_RULES.connectionNotActive }],
      }),
    );
  }

  return connection;
}

/** The address a callback lands on, validated before anything is sent. */
function callbackUrlOf(
  connection: ConnectionRow,
): { readonly url: string } | { readonly refusal: ErrorDetail } {
  const derived = storeCallbackUrlOf(connection.store_domain);

  try {
    return { url: requireHttpUrl(derived, "connection.store_domain", { allowedProtocols: ["https:"] }) };
  } catch {
    return {
      refusal: { field: "connection.store_domain", rule: STORE_CALLBACK_RULES.storeEndpointInvalid },
    };
  }
}

/** The shop's own token, opened under the exact associated data STEP 208 sealed it with. */
function tokenOf(
  connection: ConnectionRow,
  dependencies: StoreCallbackDependencies,
): { readonly token: string } | { readonly failure: true } {
  const box = unpackSecretBox(
    packSecretBox({
      iv: connection.access_token_iv,
      tag: connection.access_token_tag,
      ciphertext: connection.access_token_ciphertext,
    }),
  );

  if (box === null) {
    return { failure: true };
  }

  try {
    const context = storeConnectionSecretContext({
      companyId: connection.company_id,
      platform: STORE_CONNECTION_PLATFORM,
      storeDomain: connection.store_domain,
    });
    const token = dependencies.openSecret(box, context);

    return token.length === 0 ? { failure: true } : { token };
  } catch {
    // A box that will not open under this tenant's own context is a platform fault: no shop can fix it and no retry
    // can succeed, which is why it is an error rather than a reported rule.
    return { failure: true };
  }
}

/** The envelope, in the field order the platform writes. */
function envelopeOf(input: {
  readonly callbackId: string;
  readonly type: StoreCallbackType;
  readonly created: number;
  readonly payment: StoreCallbackEnvelope["payment"];
  readonly storeDomain: string;
  readonly externalStoreId: string | null;
}): StoreCallbackEnvelope {
  return {
    id: input.callbackId,
    object: STORE_CALLBACK_OBJECT,
    type: input.type,
    created: input.created,
    payment: input.payment,
    store: { domain: input.storeDomain, external_store_id: input.externalStoreId },
  };
}

/**
 * Call the merchant's shop about one payment, and report what the shop did.
 *
 * Called by `POST /api/public/v1/payments/{id}/callback`, which is the trigger this range owns: STEP 205's queue
 * delivers to stored endpoints, and a connection has a domain rather than an endpoint, so the store's own request is
 * what starts a callback. A merchant pressing it again is safe - the id is derived, so the shop sees the same callback
 * it has already seen and STEP 209's plugin treats that as a duplicate.
 */
export async function deliverStoreCallback(
  input: StoreCallbackInput,
  dependencies: StoreCallbackDependencies,
): Promise<StoreCallbackOutcome> {
  const paymentId = parsePaymentId(input.paymentId);
  const payment = await readStorePaymentStatus(
    { paymentId, principal: input.principal, clientAddress: input.clientAddress },
    { rest: dependencies.rest, audit: dependencies.audit, now: dependencies.now },
  );
  const connection = await connectionOf(dependencies, input);
  const target = callbackUrlOf(connection);

  if ("refusal" in target) {
    throw await refuse(
      dependencies,
      input,
      STORE_CALLBACK_RULES.storeEndpointInvalid,
      new AppError("VALIDATION_FAILED", { details: [target.refusal] }),
    );
  }

  const url = target.url;
  const opened = tokenOf(connection, dependencies);

  if ("failure" in opened) {
    throw await refuse(
      dependencies,
      input,
      STORE_CALLBACK_RULES.connectionTokenUnavailable,
      new AppError("INTERNAL_ERROR", {
        details: [
          { field: "connection", rule: STORE_CALLBACK_RULES.connectionTokenUnavailable },
        ],
      }),
    );
  }

  const type = storeCallbackTypeOf(payment.status);
  const callbackId = storeCallbackIdOf({
    companyId: input.principal.companyId,
    paymentId: payment.id,
    type,
  });
  const created = Math.floor(dependencies.now() / 1_000);
  const envelope = envelopeOf({
    callbackId,
    type,
    created,
    payment,
    storeDomain: connection.store_domain,
    externalStoreId: connection.external_store_id,
  });
  const body = JSON.stringify(envelope);

  if (new TextEncoder().encode(body).length > STORE_CALLBACK_MAXIMUM_BODY_BYTES) {
    throw await refuse(
      dependencies,
      input,
      STORE_CALLBACK_RULES.bodyTooLarge,
      new AppError("INTERNAL_ERROR", {
        details: [{ field: "callback", rule: STORE_CALLBACK_RULES.bodyTooLarge }],
      }),
    );
  }

  const headers: Readonly<Record<string, string>> = {
    "content-type": STORE_CALLBACK_CONTENT_TYPE,
    "user-agent": STORE_CALLBACK_USER_AGENT,
    authorization: `${STORE_CALLBACK_BEARER_PREFIX}${opened.token}`,
    [STORE_CALLBACK_ID_HEADER]: callbackId,
    [STORE_CALLBACK_TYPE_HEADER]: type,
  };

  let statusCode: number | null = null;
  let rule: StoreWebhookRule | null = null;

  try {
    const response = await dependencies.send({
      url,
      headers,
      body,
      timeoutMs: STORE_CALLBACK_TIMEOUT_MS,
    });

    statusCode = response.status;
    rule = statusCode >= 200 && statusCode < 300 ? null : storeWebhookRuleForStatus(statusCode);
  } catch (error) {
    rule =
      error instanceof StoreWebhookTransportError && error.reason === "timeout"
        ? STORE_WEBHOOK_RULES.endpointTimeout
        : STORE_WEBHOOK_RULES.endpointUnreachable;
  }

  const delivered = rule === null;

  await note(dependencies, {
    action: delivered ? STORE_CALLBACK_AUDIT.delivered : STORE_CALLBACK_AUDIT.failed,
    actorUserId: null,
    entityType: STORE_CALLBACK_ENTITY,
    entityId: payment.id,
    payload: {
      callback_id: callbackId,
      type,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
      store_domain: connection.store_domain,
      external_store_id: connection.external_store_id,
      endpoint_host: hostOf(url),
      status_code: statusCode,
      rule,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  });

  return {
    id: callbackId,
    object: STORE_CALLBACK_OBJECT,
    type,
    created,
    endpoint_host: hostOf(url),
    delivered,
    rule,
    status_code: statusCode,
  };
}
