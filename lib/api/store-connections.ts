// path: lib/api/store-connections.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isConflictError, type RestClient } from "../auth/rest.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { AppError, type ErrorDetail } from "../errors/app-error.ts";
import type { ApiPrincipal } from "./public-fields.ts";
import {
  STORE_CONNECTION_AUDIT,
  STORE_CONNECTION_BODY_FIELD,
  STORE_CONNECTION_BODY_MAXIMUM_BYTES,
  STORE_CONNECTION_COLUMNS,
  STORE_CONNECTION_DOMAIN_FIELD,
  STORE_CONNECTION_ENTITY,
  STORE_CONNECTION_OBJECT,
  STORE_CONNECTION_PLATFORM,
  STORE_CONNECTION_RULES,
  STORE_CONNECTION_STATUSES,
  STORE_CONNECTION_TABLE,
  STORE_CONNECTION_TOKEN_FIELD,
  STORE_DOMAIN_MAXIMUM_LENGTH,
  STORE_DOMAIN_MINIMUM_LENGTH,
  STORE_DOMAIN_PATTERN,
  STORE_EXTERNAL_ID_PREFIX,
  STORE_TOKEN_MAXIMUM_LENGTH,
  STORE_TOKEN_MINIMUM_LENGTH,
  STORE_TOKEN_PATTERN,
  STORE_TOKEN_TAIL_LENGTH,
  storeConnectionSecretContext,
  type StoreConnectionConnectView,
  type StoreConnectionOutcome,
  type StoreConnectionRequest,
  type StoreConnectionStatus,
  type StoreConnectionView,
} from "./store-connection-fields.ts";

/**
 * Section 20's WooCommerce handshake: what the platform does when the plugin logs in.
 *
 * ## The five steps, in the order that makes them cheap
 *
 * **Body, domain, token, row, answer.** The body is bounded and parsed before a query, because a stranger's body costs
 * nothing to refuse. The domain is normalised and then validated against `0035`'s own pattern, because a domain is the
 * one value that decides *which* store a token will authenticate to. The token is checked against the shape the plugin
 * documents before it is sealed. Only then is a row read - and the row decides whether this call creates, reuses or
 * refuses.
 *
 * ## Three states a row can be in when the plugin calls again
 *
 *   - **no row** - insert `active`, with `connected_at` and the identifier the platform gives the store. This is the
 *     install: *"the connection becomes active automatically"*.
 *   - **an active row** - answer it unchanged and say `reused`. A second install on the same domain is the same
 *     connection, not a second one, and `0035`'s guard forbids rewriting a sealed token under the same key version, so
 *     the honest answer is the connection that already stands.
 *   - **a revoked row** - `409 connection_revoked`. `0035` freezes a revoked connection *"so a merchant that revokes
 *     access must install again rather than be reactivated by a later writer"*, and the unique index on the domain
 *     means installing again on the same domain is a support action rather than something this endpoint may invent.
 *
 * A `pending` or `error` row that this platform did not write (a Shopify handshake, an operator's failed import) is
 * activated in place: status and `connected_at` only, because its token is already sealed and may not be resealed.
 *
 * ## What never comes back out
 *
 * The token is sealed under `storeConnectionSecretContext` - company, platform **and domain** - and the only part of it
 * the platform will ever repeat is its last four characters. No query of this module reads the ciphertext back, so
 * there is nothing in memory to leak after the write.
 */

/** What a connection call needs from the outside world, injected so the gate can drive it without a database. */
export interface StoreConnectionDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
  /** Seals a plaintext under its associated data. The key lives in the runtime, not here. */
  readonly seal: (plaintext: string, context: string) => SecretBox;
}

/** One call from the plugin: the merchant the key proved, the body it sent, and where it came from. */
export interface StoreConnectionInput {
  readonly principal: ApiPrincipal;
  readonly clientAddress: string | null;
  readonly request: StoreConnectionRequest;
}

/** A status check: the merchant, its domain and its address. */
export interface StoreConnectionReadInput {
  readonly principal: ApiPrincipal;
  readonly storeDomain: string;
  readonly clientAddress: string | null;
}

const rowSchema = z.object({
  id: z.string().uuid(),
  platform: z.enum(["shopify", "woocommerce"]),
  store_domain: z.string(),
  status: z.enum(STORE_CONNECTION_STATUSES),
  connected_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  external_store_id: z.string().nullable(),
  access_token_last_four: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int().positive(),
});

type ConnectionRow = z.infer<typeof rowSchema>;

const requestSchema = z.strictObject({
  store_domain: z.string(),
  store_token: z.string(),
});

/** The SHA-256 of a string, as the lower case hex the platform uses everywhere. */
function hashOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The identifier the platform gives one store.
 *
 * Deterministic over the merchant, the platform and the domain, so a reinstall is told the same identifier and a store
 * can recognise itself without the platform keeping a second table.
 */
export function storeExternalIdOf(input: {
  readonly companyId: string;
  readonly platform: "shopify" | "woocommerce";
  readonly storeDomain: string;
}): string {
  return `${STORE_EXTERNAL_ID_PREFIX}${hashOf(
    `${input.companyId}|${input.platform}|${input.storeDomain}`,
  ).slice(0, 32)}`;
}

/**
 * The domain as `0035` stores it, or a refusal.
 *
 * **Normalise, then validate.** A plugin that sends `https://Shop.Example.com/` is describing a store this platform can
 * reach; a plugin that sends a path, a port, a query or credentials is describing something else, and that is refused
 * rather than silently reduced to a host, because a value the store believes it sent being quietly changed is how a
 * merchant ends up connected to a domain they did not mean.
 */
export function parseStoreDomain(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainMissing }],
    });
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainMissing }],
    });
  }

  if (trimmed.length > STORE_DOMAIN_MAXIMUM_LENGTH + 16) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainInvalid }],
    });
  }

  const lowered = trimmed.toLowerCase();
  const withoutScheme = lowered.replace(/^https?:\/\//u, "");
  const withoutSlash = withoutScheme.endsWith("/") ? withoutScheme.slice(0, -1) : withoutScheme;

  // Anything left that a bare host cannot contain: a path, a query, a fragment, a port, credentials, a space.
  if (/[/?#@: ]/u.test(withoutSlash)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainNotBare }],
    });
  }

  if (
    withoutSlash.length < STORE_DOMAIN_MINIMUM_LENGTH ||
    withoutSlash.length > STORE_DOMAIN_MAXIMUM_LENGTH ||
    !STORE_DOMAIN_PATTERN.test(withoutSlash)
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainInvalid }],
    });
  }

  return withoutSlash;
}

/** The token the plugin minted, or a refusal that says why a short or strange one will not do. */
export function parseStoreToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_TOKEN_FIELD, rule: STORE_CONNECTION_RULES.tokenMissing }],
    });
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_TOKEN_FIELD, rule: STORE_CONNECTION_RULES.tokenMissing }],
    });
  }

  if (
    trimmed.length < STORE_TOKEN_MINIMUM_LENGTH ||
    trimmed.length > STORE_TOKEN_MAXIMUM_LENGTH ||
    !STORE_TOKEN_PATTERN.test(trimmed)
  ) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_TOKEN_FIELD, rule: STORE_CONNECTION_RULES.tokenInvalid }],
    });
  }

  return trimmed;
}

/**
 * The body, read once, bounded twice - the shape every public write in this folder reads a body with.
 */
export async function readConnectionBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number.parseInt(declared, 10) > STORE_CONNECTION_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: STORE_CONNECTION_BODY_FIELD, rule: STORE_CONNECTION_RULES.bodyTooLarge }],
    });
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > STORE_CONNECTION_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: STORE_CONNECTION_BODY_FIELD, rule: STORE_CONNECTION_RULES.bodyTooLarge }],
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_BODY_FIELD, rule: STORE_CONNECTION_RULES.bodyMalformed }],
    });
  }
}

/**
 * The connect body as a typed value, or a refusal naming one field and one rule.
 *
 * Strict, because a plugin that sends `status`, `company_id` or `external_store_id` believes it sets them - and on this
 * endpoint every one of those is computed by the platform.
 */
export function parseConnectionRequest(value: unknown): StoreConnectionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_BODY_FIELD, rule: STORE_CONNECTION_RULES.bodyMalformed }],
    });
  }

  if (!("store_domain" in value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.domainMissing }],
    });
  }

  if (!("store_token" in value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: STORE_CONNECTION_TOKEN_FIELD, rule: STORE_CONNECTION_RULES.tokenMissing }],
    });
  }

  const parsed = requestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error) });
  }

  return {
    storeDomain: parseStoreDomain(parsed.data.store_domain),
    storeToken: parseStoreToken(parsed.data.store_token),
  };
}

/** Zod's issues as the platform's `{field, rule}` details, one per field, first issue wins. */
function detailsOf(error: z.ZodError): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (!details.some((detail) => detail.field === key)) {
          details.push({ field: key, rule: STORE_CONNECTION_RULES.unknownField });
        }
      }
    }
  }

  if (details.length === 0) {
    details.push({ field: STORE_CONNECTION_BODY_FIELD, rule: STORE_CONNECTION_RULES.bodyMalformed });
  }

  return details;
}

/** The row as a plugin reads it. */
function viewOf(row: ConnectionRow): StoreConnectionView {
  return {
    id: row.id,
    object: STORE_CONNECTION_OBJECT,
    platform: row.platform,
    store_domain: row.store_domain,
    status: row.status,
    connected_at: row.connected_at,
    external_store_id: row.external_store_id,
    store_token_last_four: row.access_token_last_four,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The connect answer: the connection, plus whether it already stood and which mode asked. */
function connectViewOf(
  row: ConnectionRow,
  reused: boolean,
  mode: "test" | "live",
): StoreConnectionConnectView {
  return { ...viewOf(row), reused, mode };
}

/** The tenant fence every query of this surface shares: one merchant, one platform, one living row. */
function scopeOf(companyId: string, storeDomain: string | null): string {
  return (
    `company_id=eq.${encodeURIComponent(companyId)}` +
    `&platform=eq.${STORE_CONNECTION_PLATFORM}` +
    (storeDomain === null ? "" : `&store_domain=eq.${encodeURIComponent(storeDomain)}`) +
    "&deleted_at=is.null"
  );
}

/** One chain entry, best effort: a connection that stands is not undone by a chain that cannot be written. */
async function note(dependencies: { readonly audit: AuditTrail }, entry: AuditEntry): Promise<void> {
  try {
    await dependencies.audit.append(entry);
  } catch {
    // The row is the record. A chain outage must not refuse a connection the merchant just installed.
  }
}

/** The chain entry of a call the platform did not serve. */
async function noteRefused(
  dependencies: StoreConnectionDependencies,
  input: { readonly principal: ApiPrincipal; readonly clientAddress: string | null },
  entityId: string | null,
  rule: string,
): Promise<void> {
  await note(dependencies, {
    action: STORE_CONNECTION_AUDIT.refused,
    actorUserId: null,
    entityType: STORE_CONNECTION_ENTITY,
    entityId,
    payload: {
      rule,
      platform: STORE_CONNECTION_PLATFORM,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  });
}

/** The chain entry of a connection that stands, whether this call wrote it or found it. */
async function noteActivated(
  dependencies: StoreConnectionDependencies,
  input: { readonly principal: ApiPrincipal; readonly clientAddress: string | null },
  row: ConnectionRow,
  reused: boolean,
): Promise<void> {
  await note(dependencies, {
    action: STORE_CONNECTION_AUDIT.activated,
    actorUserId: null,
    entityType: STORE_CONNECTION_ENTITY,
    entityId: row.id,
    payload: {
      platform: row.platform,
      store_domain: row.store_domain,
      external_store_id: row.external_store_id,
      store_token_last_four: row.access_token_last_four,
      status: row.status,
      reused,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  });
}

/** One living connection of one merchant, or undefined. */
async function findConnection(
  dependencies: StoreConnectionDependencies,
  companyId: string,
  storeDomain: string,
): Promise<ConnectionRow | undefined> {
  const rows = await dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${STORE_CONNECTION_COLUMNS}&${scopeOf(companyId, storeDomain)}&limit=1`,
    rowSchema,
  );

  return rows[0];
}

/**
 * Change one connection, guarded by its own version, and prove the change landed.
 *
 * The same compare-and-set STEP 201 and 206 use: a PostgREST update that matches no row reports success, so the guard
 * is in the filter and the proof is a read-back rather than the absence of an error.
 */
async function writeConnection(
  dependencies: StoreConnectionDependencies,
  companyId: string,
  row: ConnectionRow,
  values: Readonly<Record<string, unknown>>,
  status: StoreConnectionStatus,
): Promise<ConnectionRow> {
  await dependencies.rest.update(
    STORE_CONNECTION_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${String(row.version)}` +
      `&company_id=eq.${encodeURIComponent(companyId)}` +
      `&platform=eq.${STORE_CONNECTION_PLATFORM}&deleted_at=is.null`,
    values,
  );

  const after = await dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${STORE_CONNECTION_COLUMNS}&id=eq.${encodeURIComponent(row.id)}&deleted_at=is.null&limit=1`,
    rowSchema,
  );
  const written = after[0];

  if (written === undefined || written.version !== row.version + 1 || written.status !== status) {
    throw new AppError("CONFLICT", {
      details: [{ field: "connection", rule: STORE_CONNECTION_RULES.writeNotApplied }],
    });
  }

  return written;
}

/** The four characters of a token this platform will repeat, and the only ones it compares. */
function tailOf(storeToken: string): string {
  return storeToken.slice(-STORE_TOKEN_TAIL_LENGTH);
}

/**
 * The row another writer inserted while this call was reading.
 *
 * Returned from the insert's failure path rather than thrown, because the answer to it is a normal `200` with
 * `reused: true`: a duplicate install is not an error, it is the connection that already exists.
 */
interface ConcurrentInstall {
  readonly concurrent: ConnectionRow;
}

/** Whether the insert's result is the row another writer inserted rather than the rows this call wrote. */
function isConcurrent(value: readonly ConnectionRow[] | ConcurrentInstall): value is ConcurrentInstall {
  return !Array.isArray(value);
}

/**
 * Connect one WooCommerce store, or answer the connection that already stands.
 *
 * This is the call the plugin makes when the merchant presses **Connect**: the merchant's API key authenticates it, the
 * domain says which store, and the token is what the platform will present to that store later. Nothing is queued and
 * no operator is asked, because section 20 says the connection becomes active automatically.
 */
export async function connectWooCommerceStore(
  input: StoreConnectionInput,
  dependencies: StoreConnectionDependencies,
): Promise<StoreConnectionOutcome> {
  const existing = await findConnection(
    dependencies,
    input.principal.companyId,
    input.request.storeDomain,
  );

  if (existing !== undefined && existing.status === "revoked") {
    await noteRefused(dependencies, input, existing.id, STORE_CONNECTION_RULES.connectionRevoked);

    // `0035`'s own sentence: a revoked connection stays revoked. Installing again is not this endpoint's decision.
    throw new AppError("CONFLICT", {
      details: [{ field: "connection", rule: STORE_CONNECTION_RULES.connectionRevoked }],
    });
  }

  if (existing !== undefined && existing.status === "active") {
    // The same install twice is the same connection. The token is not rewritten - `0035` seals it once and refuses a
    // re-encryption that does not raise the key version - so the tail is compared instead: a store that presents a
    // token whose last four characters differ from the sealed one is holding a token this platform does not have, and
    // answering "connected" would leave a merchant with a screen that says yes and calls that the store will refuse.
    if (existing.access_token_last_four !== tailOf(input.request.storeToken)) {
      await noteRefused(dependencies, input, existing.id, STORE_CONNECTION_RULES.connectionTokenMismatch);

      throw new AppError("CONFLICT", {
        details: [{ field: "connection", rule: STORE_CONNECTION_RULES.connectionTokenMismatch }],
      });
    }

    await noteActivated(dependencies, input, existing, true);

    return {
      status: 200,
      body: connectViewOf(existing, true, input.principal.mode),
      reused: true,
      mode: input.principal.mode,
    };
  }

  if (existing !== undefined) {
    const written = await writeConnection(
      dependencies,
      input.principal.companyId,
      existing,
      { status: "active", connected_at: new Date(dependencies.now()).toISOString(), last_error: null },
      "active",
    );

    await noteActivated(dependencies, input, written, false);

    return {
      status: 200,
      body: connectViewOf(written, false, input.principal.mode),
      reused: false,
      mode: input.principal.mode,
    };
  }

  const sealed = dependencies.seal(
    input.request.storeToken,
    storeConnectionSecretContext({
      companyId: input.principal.companyId,
      platform: STORE_CONNECTION_PLATFORM,
      storeDomain: input.request.storeDomain,
    }),
  );
  const identity = {
    companyId: input.principal.companyId,
    platform: STORE_CONNECTION_PLATFORM,
    storeDomain: input.request.storeDomain,
  } as const;

  const inserted: readonly ConnectionRow[] | ConcurrentInstall = await dependencies.rest
    .insertReturning(
      STORE_CONNECTION_TABLE,
      [
        {
          company_id: input.principal.companyId,
          platform: STORE_CONNECTION_PLATFORM,
          store_domain: input.request.storeDomain,
          external_store_id: storeExternalIdOf(identity),
          access_token_last_four: tailOf(input.request.storeToken),
          access_token_ciphertext: sealed.ciphertext,
          access_token_iv: sealed.iv,
          access_token_tag: sealed.tag,
          encryption_key_version: 1,
          status: "active",
          connected_at: new Date(dependencies.now()).toISOString(),
          revoked_at: null,
          last_error: null,
        },
      ],
      rowSchema,
    )
    .catch(async (error: unknown): Promise<never | ConcurrentInstall> => {
      if (!isConflictError(error)) {
        throw error;
      }

      // Another install of the same store landed between the read and the write, and `0035`'s unique index is what
      // noticed. The row that won is the connection, so it is read back and answered rather than reported as a failure.
      const concurrent = await findConnection(
        dependencies,
        input.principal.companyId,
        input.request.storeDomain,
      );

      if (concurrent !== undefined && concurrent.status === "revoked") {
        throw new AppError("CONFLICT", {
          details: [{ field: "connection", rule: STORE_CONNECTION_RULES.connectionRevoked }],
        });
      }

      if (concurrent !== undefined && concurrent.status === "active") {
        if (concurrent.access_token_last_four !== tailOf(input.request.storeToken)) {
          throw new AppError("CONFLICT", {
            details: [{ field: "connection", rule: STORE_CONNECTION_RULES.connectionTokenMismatch }],
          });
        }

        return { concurrent: concurrent };
      }

      throw new AppError("CONFLICT", {
        details: [{ field: "connection", rule: STORE_CONNECTION_RULES.writeNotApplied }],
      });
    });

  if (isConcurrent(inserted)) {
    // The row that won the race is this call's connection: the same 200, the same answer, `reused` true.
    await noteActivated(dependencies, input, inserted.concurrent, true);

    return {
      status: 200,
      body: connectViewOf(inserted.concurrent, true, input.principal.mode),
      reused: true,
      mode: input.principal.mode,
    };
  }

  const row = inserted[0];

  if (row === undefined) {
    throw new AppError("DEPENDENCY_FAILED", {
      details: [{ field: "connection", rule: STORE_CONNECTION_RULES.unreadable }],
    });
  }

  await noteActivated(dependencies, input, row, false);

  return {
    status: 200,
    body: connectViewOf(row, false, input.principal.mode),
    reused: false,
    mode: input.principal.mode,
  };
}

/**
 * The connection one store has with this platform, or a not-found.
 *
 * Read by domain rather than "the merchant's newest", because a merchant may run two shops and a plugin that asks
 * about its own store must be answered about that store.
 */
export async function readWooCommerceConnection(
  input: StoreConnectionReadInput,
  dependencies: StoreConnectionDependencies,
): Promise<StoreConnectionView> {
  const storeDomain = parseStoreDomain(input.storeDomain);
  const rows = await dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${STORE_CONNECTION_COLUMNS}&${scopeOf(input.principal.companyId, storeDomain)}&limit=1`,
    rowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    await noteRefused(dependencies, input, null, STORE_CONNECTION_RULES.notConnected);

    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.notConnected }],
    });
  }

  return viewOf(row);
}

/**
 * Revoke one store's connection.
 *
 * The plugin's **Disconnect**: the platform keeps the row (the orders it carried outlive the connection), sets
 * `revoked_at`, and from then on `0035`'s guard refuses to bring it back. A second disconnect is answered with the
 * revoked row rather than an error, because a screen that presses the button twice has not done anything wrong.
 */
export async function disconnectWooCommerceStore(
  input: StoreConnectionReadInput,
  dependencies: StoreConnectionDependencies,
): Promise<StoreConnectionView> {
  const storeDomain = parseStoreDomain(input.storeDomain);
  const existing = await findConnection(dependencies, input.principal.companyId, storeDomain);

  if (existing === undefined) {
    await noteRefused(dependencies, input, null, STORE_CONNECTION_RULES.notConnected);

    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: STORE_CONNECTION_DOMAIN_FIELD, rule: STORE_CONNECTION_RULES.notConnected }],
    });
  }

  if (existing.status === "revoked") {
    return viewOf(existing);
  }

  const written = await writeConnection(
    dependencies,
    input.principal.companyId,
    existing,
    { status: "revoked", revoked_at: new Date(dependencies.now()).toISOString(), last_error: null },
    "revoked",
  );

  await note(dependencies, {
    action: STORE_CONNECTION_AUDIT.revoked,
    actorUserId: null,
    entityType: STORE_CONNECTION_ENTITY,
    entityId: written.id,
    payload: {
      platform: written.platform,
      store_domain: written.store_domain,
      external_store_id: written.external_store_id,
      mode: input.principal.mode,
      credential_id: input.principal.credentialId,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: input.clientAddress,
    userAgent: null,
  });

  return viewOf(written);
}
