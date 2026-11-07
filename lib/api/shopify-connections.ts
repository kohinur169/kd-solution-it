// path: lib/api/shopify-connections.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { isConflictError, type RestClient } from "../auth/rest.ts";
import type { SecretBox } from "../auth/secrets.ts";
import { AppError, type ErrorDetail } from "../errors/app-error.ts";
import type { ApiPrincipal } from "./public-fields.ts";
import {
  SHOPIFY_ACCESS_TOKEN_FIELD,
  SHOPIFY_ACCESS_TOKEN_MAXIMUM_LENGTH,
  SHOPIFY_ACCESS_TOKEN_PATTERN,
  SHOPIFY_ACCESS_TOKEN_PREFIXES,
  SHOPIFY_BODY_FIELD,
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
  SHOPIFY_TOKEN_TAIL_LENGTH,
  type ShopifyConnectionConnectView,
  type ShopifyConnectionOutcome,
  type ShopifyConnectionRequest,
  type ShopifyConnectionView,
} from "./shopify-connection-fields.ts";
import {
  STORE_CONNECTION_AUDIT,
  STORE_CONNECTION_ENTITY,
  STORE_CONNECTION_STATUSES,
  STORE_CONNECTION_TABLE,
  storeConnectionSecretContext,
  type StoreConnectionStatus,
} from "./store-connection-fields.ts";
import { storeExternalIdOf } from "./store-connections.ts";

/**
 * Section 20's Shopify app handshake: what the platform does when the installed app logs the merchant in.
 *
 * ## The order, and why it is this order
 *
 * **Body, shop, token, row, answer.** The body is bounded and parsed before anything is read, because a stranger's
 * body costs nothing to refuse. The shop is normalised and then checked against Shopify's own permanent identity,
 * because that value decides which shop a sealed token will later be presented to. The token is checked against the
 * shapes Shopify mints **before** it is sealed, so a shared secret or another app's delegate token is refused while it
 * is still a string and never becomes a ciphertext in the wrong column. Only then is a row read, and the row decides
 * whether this call creates, reuses or refuses.
 *
 * ## Three states, as STEP 208 found them
 *
 *   - **no row** - insert `active`, with `connected_at`, the identifier the platform derives and the sealed token. This
 *     is the login after the install, and it is what *"the connection becomes active automatically"* means in code.
 *   - **an active row** - answer it unchanged and say `reused`, because `0035` refuses to reseal a token under the same
 *     key version and a second install on the same shop is the same shop.
 *   - **a revoked row** - `409 connection_revoked`, because `0035` freezes a revocation and the unique index means
 *     reinstalling on the same shop is a support action rather than something this endpoint may invent.
 *
 * A `pending` or `error` row is activated in place - status, instant and cleared error only - because its token is
 * already sealed and the migration forbids touching it.
 *
 * ## What the Shopify token is, and is not
 *
 * The app obtains this string from Shopify's own token endpoint after the merchant approved the install; it is not
 * minted here and it is not compared with anything the platform can compute. It is therefore sealed the moment it
 * arrives, never selected back by a query of this module, and compared on a reinstall only by its last four
 * characters - the same rule `0035` states for the column and the same rule STEP 208 applies to a store's own token.
 */

/** What a Shopify connection call needs from the outside world, injected so the gate can drive it without a database. */
export interface ShopifyConnectionDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
  /** Seals a plaintext under its associated data. The key lives in the runtime, not here. */
  readonly seal: (plaintext: string, context: string) => SecretBox;
}

/** One call from the app: the merchant the key proved, the body it sent, and where it came from. */
export interface ShopifyConnectionInput {
  readonly principal: ApiPrincipal;
  readonly clientAddress: string | null;
  readonly request: ShopifyConnectionRequest;
}

/** A status check or a disconnect: the merchant, its shop and its address. */
export interface ShopifyConnectionReadInput {
  readonly principal: ApiPrincipal;
  readonly shopDomain: string;
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
  shop_domain: z.string(),
  access_token: z.string(),
});

/** A refusal that names one field and one rule, in the shape every public write of this folder refuses with. */
function refuse(field: string, rule: string): never {
  throw new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/**
 * The shop as `0035` stores it, or a refusal that says which kind of wrong value arrived.
 *
 * **Normalise, then check what it is, then validate the handle.** The three steps are separate because they answer
 * three different questions a merchant's screen shows differently: *is this a host at all*, *is this a Shopify shop*,
 * and *is this handle one Shopify could have issued*. A custom domain is refused with its own rule rather than
 * reduced to a `myshopify.com` guess, because guessing here would seal an access token to a shop the merchant did not
 * name.
 */
export function parseShopDomain(value: unknown): string {
  if (typeof value !== "string") {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainMissing);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainMissing);
  }

  if (trimmed.length > SHOPIFY_SHOP_DOMAIN_MAXIMUM_LENGTH + 16) {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainInvalid);
  }

  const lowered = trimmed.toLowerCase();
  const withoutScheme = lowered.replace(/^https?:\/\//u, "");
  const withoutSlash = withoutScheme.endsWith("/") ? withoutScheme.slice(0, -1) : withoutScheme;

  // Anything left that a bare host cannot contain: a path, a query, a fragment, a port, credentials, a space.
  if (/[/?#@: ]/u.test(withoutSlash)) {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainNotBare);
  }

  if (!withoutSlash.endsWith(SHOPIFY_SHOP_DOMAIN_SUFFIX)) {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainNotMyshopify);
  }

  if (
    withoutSlash.length > SHOPIFY_SHOP_DOMAIN_MAXIMUM_LENGTH ||
    !SHOPIFY_SHOP_DOMAIN_PATTERN.test(withoutSlash)
  ) {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainInvalid);
  }

  return withoutSlash;
}

/**
 * The access token Shopify minted, or a refusal that separates a malformed string from the wrong kind of secret.
 *
 * The kind check comes first and names the two prefixed strings Shopify documents that are **not** an Admin API token
 * for this platform: a delegate token minted for another app, and an app's shared secret. Both are refused as
 * `access_token_wrong_kind` - the app's screen can say *copy the access token, not the secret*, which is the mistake a
 * developer actually makes - while anything else that is not shaped like a token is `access_token_invalid`.
 */
export function parseShopifyAccessToken(value: unknown): string {
  if (typeof value !== "string") {
    refuse(SHOPIFY_ACCESS_TOKEN_FIELD, SHOPIFY_CONNECTION_RULES.accessTokenMissing);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    refuse(SHOPIFY_ACCESS_TOKEN_FIELD, SHOPIFY_CONNECTION_RULES.accessTokenMissing);
  }

  if (SHOPIFY_FOREIGN_TOKEN_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    refuse(SHOPIFY_ACCESS_TOKEN_FIELD, SHOPIFY_CONNECTION_RULES.accessTokenWrongKind);
  }

  if (
    trimmed.length > SHOPIFY_ACCESS_TOKEN_MAXIMUM_LENGTH ||
    !SHOPIFY_ACCESS_TOKEN_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) ||
    !SHOPIFY_ACCESS_TOKEN_PATTERN.test(trimmed)
  ) {
    refuse(SHOPIFY_ACCESS_TOKEN_FIELD, SHOPIFY_CONNECTION_RULES.accessTokenInvalid);
  }

  return trimmed;
}

/** The body, read once, bounded twice - the shape every public write in this folder reads a body with. */
export async function readShopifyConnectionBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");

  if (declared !== null && Number.parseInt(declared, 10) > SHOPIFY_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: SHOPIFY_BODY_FIELD, rule: SHOPIFY_CONNECTION_RULES.bodyTooLarge }],
    });
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > SHOPIFY_BODY_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", {
      details: [{ field: SHOPIFY_BODY_FIELD, rule: SHOPIFY_CONNECTION_RULES.bodyTooLarge }],
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    refuse(SHOPIFY_BODY_FIELD, SHOPIFY_CONNECTION_RULES.bodyMalformed);
  }
}

/**
 * The connect body as a typed value, or a refusal naming one field and one rule.
 *
 * Strict, because an app that sends `status`, `platform`, `store_domain` or `external_store_id` believes it sets them,
 * and on this endpoint every one of those is computed by the platform from the credential and the two values that
 * arrived.
 */
export function parseShopifyConnectionRequest(value: unknown): ShopifyConnectionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(SHOPIFY_BODY_FIELD, SHOPIFY_CONNECTION_RULES.bodyMalformed);
  }

  if (!(SHOPIFY_SHOP_DOMAIN_FIELD in value)) {
    refuse(SHOPIFY_SHOP_DOMAIN_FIELD, SHOPIFY_CONNECTION_RULES.shopDomainMissing);
  }

  if (!(SHOPIFY_ACCESS_TOKEN_FIELD in value)) {
    refuse(SHOPIFY_ACCESS_TOKEN_FIELD, SHOPIFY_CONNECTION_RULES.accessTokenMissing);
  }

  const parsed = requestSchema.safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", { details: detailsOf(parsed.error) });
  }

  return {
    shopDomain: parseShopDomain(parsed.data.shop_domain),
    accessToken: parseShopifyAccessToken(parsed.data.access_token),
  };
}

/** Zod's issues as the platform's `{field, rule}` details, one per unknown field, first issue wins. */
function detailsOf(error: z.ZodError): readonly ErrorDetail[] {
  const details: ErrorDetail[] = [];

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        if (!details.some((detail) => detail.field === key)) {
          details.push({ field: key, rule: SHOPIFY_CONNECTION_RULES.unknownField });
        }
      }
    }
  }

  if (details.length === 0) {
    details.push({ field: SHOPIFY_BODY_FIELD, rule: SHOPIFY_CONNECTION_RULES.bodyMalformed });
  }

  return details;
}

/** The row as an app reads it. */
function viewOf(row: ConnectionRow): ShopifyConnectionView {
  return {
    id: row.id,
    object: SHOPIFY_CONNECTION_OBJECT,
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
): ShopifyConnectionConnectView {
  return { ...viewOf(row), reused, mode };
}

/** The tenant fence every query of this surface shares: one merchant, the Shopify platform, one living row. */
function scopeOf(companyId: string, shopDomain: string | null): string {
  return (
    `company_id=eq.${encodeURIComponent(companyId)}` +
    `&platform=eq.${SHOPIFY_PLATFORM}` +
    (shopDomain === null ? "" : `&store_domain=eq.${encodeURIComponent(shopDomain)}`) +
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
  dependencies: ShopifyConnectionDependencies,
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
      platform: SHOPIFY_PLATFORM,
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
  dependencies: ShopifyConnectionDependencies,
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

/** One living Shopify connection of one merchant, or undefined. */
async function findConnection(
  dependencies: ShopifyConnectionDependencies,
  companyId: string,
  shopDomain: string,
): Promise<ConnectionRow | undefined> {
  const rows = await dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${SHOPIFY_CONNECTION_COLUMNS}&${scopeOf(companyId, shopDomain)}&limit=1`,
    rowSchema,
  );

  return rows[0];
}

/**
 * Change one connection, guarded by its own version, and prove the change landed.
 *
 * The same compare-and-set STEP 201, 206 and 208 use: a PostgREST update that matches no row reports success, so the
 * guard is in the filter and the proof is a read-back rather than the absence of an error.
 */
async function writeConnection(
  dependencies: ShopifyConnectionDependencies,
  companyId: string,
  row: ConnectionRow,
  values: Readonly<Record<string, unknown>>,
  status: StoreConnectionStatus,
): Promise<ConnectionRow> {
  await dependencies.rest.update(
    STORE_CONNECTION_TABLE,
    `id=eq.${encodeURIComponent(row.id)}&version=eq.${String(row.version)}` +
      `&company_id=eq.${encodeURIComponent(companyId)}` +
      `&platform=eq.${SHOPIFY_PLATFORM}&deleted_at=is.null`,
    values,
  );

  const after = await dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${SHOPIFY_CONNECTION_COLUMNS}&id=eq.${encodeURIComponent(row.id)}&deleted_at=is.null&limit=1`,
    rowSchema,
  );
  const written = after[0];

  if (written === undefined || written.version !== row.version + 1 || written.status !== status) {
    throw new AppError("CONFLICT", {
      details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.writeNotApplied }],
    });
  }

  return written;
}

/** The four characters of a token this platform will repeat, and the only ones it compares. */
function tailOf(accessToken: string): string {
  return accessToken.slice(-SHOPIFY_TOKEN_TAIL_LENGTH);
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
 * Connect one Shopify shop, or answer the connection that already stands.
 *
 * This is the call the app makes when the merchant logs in after the install: the merchant's public API key
 * authenticates it, the shop domain says which shop Shopify consented to, and the access token is what the platform
 * will present to Shopify later. Nothing is queued and no operator is asked, because section 20 says the connection
 * becomes active automatically.
 */
export async function connectShopifyStore(
  input: ShopifyConnectionInput,
  dependencies: ShopifyConnectionDependencies,
): Promise<ShopifyConnectionOutcome> {
  const existing = await findConnection(
    dependencies,
    input.principal.companyId,
    input.request.shopDomain,
  );

  if (existing !== undefined && existing.status === "revoked") {
    await noteRefused(dependencies, input, existing.id, SHOPIFY_CONNECTION_RULES.connectionRevoked);

    // `0035`'s own sentence: a revoked connection stays revoked. Reinstalling on the same shop is not this endpoint's
    // decision, and the unique index means a new row for the same shop is not one this code can write.
    throw new AppError("CONFLICT", {
      details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.connectionRevoked }],
    });
  }

  if (existing !== undefined && existing.status === "active") {
    // The same install twice is the same connection. The token is not rewritten - `0035` seals it once and refuses a
    // re-encryption that does not raise the key version - so the tail is compared instead: a shop holding a token
    // whose last four characters differ from the sealed one is holding a token this platform does not have, and
    // answering "connected" would leave a merchant with a screen that says yes and API calls that Shopify refuses.
    if (existing.access_token_last_four !== tailOf(input.request.accessToken)) {
      await noteRefused(
        dependencies,
        input,
        existing.id,
        SHOPIFY_CONNECTION_RULES.connectionTokenMismatch,
      );

      throw new AppError("CONFLICT", {
        details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.connectionTokenMismatch }],
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
    input.request.accessToken,
    storeConnectionSecretContext({
      companyId: input.principal.companyId,
      platform: SHOPIFY_PLATFORM,
      storeDomain: input.request.shopDomain,
    }),
  );
  const identity = {
    companyId: input.principal.companyId,
    platform: SHOPIFY_PLATFORM,
    storeDomain: input.request.shopDomain,
  } as const;

  const inserted: readonly ConnectionRow[] | ConcurrentInstall = await dependencies.rest
    .insertReturning(
      STORE_CONNECTION_TABLE,
      [
        {
          company_id: input.principal.companyId,
          platform: SHOPIFY_PLATFORM,
          store_domain: input.request.shopDomain,
          external_store_id: storeExternalIdOf(identity),
          access_token_last_four: tailOf(input.request.accessToken),
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

      // Another install of the same shop landed between the read and the write, and `0035`'s unique index is what
      // noticed. The row that won is the connection, so it is read back and answered rather than reported as a failure.
      const concurrent = await findConnection(
        dependencies,
        input.principal.companyId,
        input.request.shopDomain,
      );

      if (concurrent !== undefined && concurrent.status === "revoked") {
        throw new AppError("CONFLICT", {
          details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.connectionRevoked }],
        });
      }

      if (concurrent !== undefined && concurrent.status === "active") {
        if (concurrent.access_token_last_four !== tailOf(input.request.accessToken)) {
          throw new AppError("CONFLICT", {
            details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.connectionTokenMismatch }],
          });
        }

        return { concurrent: concurrent };
      }

      throw new AppError("CONFLICT", {
        details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.writeNotApplied }],
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
      details: [{ field: "connection", rule: SHOPIFY_CONNECTION_RULES.unreadable }],
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
 * The Shopify connection one shop has with this platform, or a not-found.
 *
 * Read by the shop's own domain rather than "the merchant's newest", because a merchant may run two shops and an app
 * that asks about its own shop must be answered about that shop.
 */
export async function readShopifyConnection(
  input: ShopifyConnectionReadInput,
  dependencies: ShopifyConnectionDependencies,
): Promise<ShopifyConnectionView> {
  const shopDomain = parseShopDomain(input.shopDomain);
  const rows = await dependencies.rest.select(
    STORE_CONNECTION_TABLE,
    `select=${SHOPIFY_CONNECTION_COLUMNS}&${scopeOf(input.principal.companyId, shopDomain)}&limit=1`,
    rowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    await noteRefused(dependencies, input, null, SHOPIFY_CONNECTION_RULES.notConnected);

    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: SHOPIFY_SHOP_DOMAIN_FIELD, rule: SHOPIFY_CONNECTION_RULES.notConnected }],
    });
  }

  return viewOf(row);
}

/**
 * Revoke one shop's connection.
 *
 * The app's **Disconnect**: the platform keeps the row (the orders it carried outlive the connection), sets
 * `revoked_at`, and from then on `0035`'s guard refuses to bring it back. A second disconnect is answered with the
 * revoked row rather than an error, because a screen that presses the button twice has not done anything wrong.
 */
export async function disconnectShopifyStore(
  input: ShopifyConnectionReadInput,
  dependencies: ShopifyConnectionDependencies,
): Promise<ShopifyConnectionView> {
  const shopDomain = parseShopDomain(input.shopDomain);
  const existing = await findConnection(dependencies, input.principal.companyId, shopDomain);

  if (existing === undefined) {
    await noteRefused(dependencies, input, null, SHOPIFY_CONNECTION_RULES.notConnected);

    throw new AppError("RESOURCE_NOT_FOUND", {
      details: [{ field: SHOPIFY_SHOP_DOMAIN_FIELD, rule: SHOPIFY_CONNECTION_RULES.notConnected }],
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
