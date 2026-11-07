// path: lib/api/store-connection-fields.ts
import { deepFreeze } from "../utils/freeze.ts";
import { PUBLIC_API_BASE } from "./public-fields.ts";

/**
 * Section 20's store connection, in the vocabulary the plugin and the platform share.
 *
 * ## The sentence this STEP owns
 *
 * *"WooCommerce: the platform has its own plugin. A merchant logs in with credentials in the plugin and the connection
 * becomes active automatically."* Four words decide the design:
 *
 *   - **plugin** - the merchant installs this platform's own package in their WordPress site, so the code that talks to
 *     the platform runs on somebody else's server and every value it sends is a stranger's value.
 *   - **logs in with credentials** - the credential is the merchant's **public API key** from the section 20 screen,
 *     not a password: it is scoped to one merchant, it can be revoked without touching the merchant's account, and STEP
 *     202 already knows how to authenticate it, count it and record it.
 *   - **the connection** - one row of `0035`'s `store_connections`: the merchant, the platform, the store's own
 *     domain, and the token the platform will call the store with.
 *   - **active automatically** - no approval queue and no operator in the loop. The platform's own check is that the
 *     credential authenticates and the domain is one a store can have, and both are decided before a row is written.
 *
 * ## Why the store mints its own token
 *
 * `0035` stores `access_token_ciphertext` as *"the access token the platform will call the store with"*. The plugin
 * generates that token on the store's own server and keeps it; the platform seals what arrived and uses it later. So
 * the single secret that makes the two sides trust each other is never transmitted back, never displayed, and never
 * has to be shown once to be useful - a token the store already holds.
 *
 * ## What the plugin cannot choose
 *
 * The platform decides the row's state, its `connected_at`, its identifier, and the fact that a revoked connection
 * stays revoked. The plugin sends a domain and a token; everything a caller could lie about in its own favour is
 * computed here.
 */

/** The table `0035` created, named once so a query string cannot drift from the migration. */
export const STORE_CONNECTION_TABLE = "store_connections";

/** The platform this STEP connects. STEP 210 owns the other one. */
export const STORE_CONNECTION_PLATFORM = "woocommerce";

/** Both platforms `0035` accepts, read from its own check so the gate can prove they agree. */
export const STORE_CONNECTION_PLATFORMS = deepFreeze(["shopify", "woocommerce"] as const);

export type StoreConnectionPlatform = (typeof STORE_CONNECTION_PLATFORMS)[number];

/** The four states `0035` allows, in its order. */
export const STORE_CONNECTION_STATUSES = deepFreeze(["pending", "active", "revoked", "error"] as const);

export type StoreConnectionStatus = (typeof STORE_CONNECTION_STATUSES)[number];

/** The audit entity name of one connection. */
export const STORE_CONNECTION_ENTITY = "store_connection";

/** The object name in every answer, so a plugin can tell one resource from another. */
export const STORE_CONNECTION_OBJECT = "store_connection";

/** Where the plugin connects, reads and disconnects: one resource, three verbs. */
export const API_WOOCOMMERCE_CONNECTION_PATH = `${PUBLIC_API_BASE}/stores/woocommerce/connection`;

/**
 * The route a call is counted and recorded under.
 *
 * This endpoint has no path parameter, so the template and the concrete path are the same string - and it is still
 * written once, as a constant, so a limiter bucket and a chain entry cannot disagree.
 */
export const API_WOOCOMMERCE_CONNECTION_ROUTE = API_WOOCOMMERCE_CONNECTION_PATH;

/** The largest body the connect call reads: one domain and one token. */
export const STORE_CONNECTION_BODY_MAXIMUM_BYTES = 2_048;

/** The fields a body may carry, and the one a query may carry. */
export const STORE_CONNECTION_DOMAIN_FIELD = "store_domain";
export const STORE_CONNECTION_TOKEN_FIELD = "store_token";
export const STORE_CONNECTION_BODY_FIELD = "body";

/**
 * The domain's bounds and shape, which are `0035`'s own `store_connections_domain_check`.
 *
 * Repeated here rather than trusted: the database refuses a bad domain with a constraint violation the plugin could
 * not read, and a refusal that names `store_domain` and a rule is what a merchant's settings screen can show.
 */
export const STORE_DOMAIN_MINIMUM_LENGTH = 3;
export const STORE_DOMAIN_MAXIMUM_LENGTH = 253;
export const STORE_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;

/**
 * The token's bounds and shape.
 *
 * The plugin mints it with `random_bytes` and base64url-encodes it, so a token is at least thirty-two characters of
 * alphabet this platform accepts and at most a hundred and twenty-eight. A shorter one is refused because a short
 * shared secret is not a secret.
 */
export const STORE_TOKEN_MINIMUM_LENGTH = 32;
export const STORE_TOKEN_MAXIMUM_LENGTH = 128;
export const STORE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

/** The tail a screen may show: the last four characters of the token, which `0035` also checks. */
export const STORE_TOKEN_TAIL_LENGTH = 4;

/**
 * The associated data a store token is sealed under.
 *
 * The company alone would let a box copied from one merchant's row into another's open in the wrong tenant - which
 * `0034`'s credentials already refuse - and a store token needs one fence more: the **domain** is in the context, so a
 * token sealed for `shop-a.example.com` cannot be moved to a row that claims `shop-b.example.com`. A copied ciphertext
 * therefore opens only if the attacker also copies the row it belongs to, which is the row's own identity.
 */
export const STORE_CONNECTION_SECRET_CONTEXT_PREFIX = "kd-aad-v1|store_connection";

/** The associated data of one store connection. */
export function storeConnectionSecretContext(input: {
  readonly companyId: string;
  readonly platform: StoreConnectionPlatform;
  readonly storeDomain: string;
}): string {
  return `${STORE_CONNECTION_SECRET_CONTEXT_PREFIX}|${input.companyId}|${input.platform}|${input.storeDomain}`;
}

/**
 * The prefix of the identifier the platform gives a store.
 *
 * The identifier itself is derived in `store-connections.ts`, where the hashing lives: a module a browser bundle may
 * import must not reach for `node:crypto`, which is why every other derivation in this folder - the webhook event id,
 * the credential handle - is built on the server side of the boundary too.
 */
export const STORE_EXTERNAL_ID_PREFIX = "sc_";

/**
 * The reasons a connection call is refused.
 *
 * Machine words, and every one of them is something the plugin's screen can act on: `domain_missing` and
 * `domain_invalid` are the store telling the platform who it is wrongly; `token_missing` and `token_invalid` are a
 * plugin that minted a weak secret; `connection_revoked` is a merchant who disconnected and must reinstall;
 * `not_connected` is a status check with nothing behind it.
 */
export const STORE_CONNECTION_RULES = deepFreeze({
  domainMissing: "store_domain_missing",
  domainInvalid: "store_domain_invalid",
  domainNotBare: "store_domain_not_bare",
  tokenMissing: "store_token_missing",
  tokenInvalid: "store_token_invalid",
  bodyMalformed: "body_malformed",
  bodyTooLarge: "body_too_large",
  unknownField: "unknown_field",
  connectionRevoked: "connection_revoked",
  connectionTokenMismatch: "connection_token_mismatch",
  notConnected: "not_connected",
  writeNotApplied: "connection_write_not_applied",
  unreadable: "connection_unreadable",
} as const);

/** The three chain entries a connection surface writes. */
export const STORE_CONNECTION_AUDIT = Object.freeze({
  activated: "api.store_connection_activated",
  revoked: "api.store_connection_revoked",
  refused: "api.store_connection_refused",
} as const);

/**
 * The columns every query of this surface reads.
 *
 * Selected rather than starred: the token's ciphertext, its iv and its tag are deliberately absent, because a read
 * that never carries them is a read that cannot leak them into a log, a view or an error message. The tail is here
 * because `0035` calls it *"the only characters of the store token a screen may show"*.
 */
export const STORE_CONNECTION_COLUMNS =
  "id,platform,store_domain,status,connected_at,revoked_at,external_store_id,access_token_last_four," +
  "created_at,updated_at,version";

/** What the plugin sends when it connects: its own domain and the token it minted. */
export interface StoreConnectionRequest {
  readonly storeDomain: string;
  readonly storeToken: string;
}

/** What the platform answers about one connection. */
export interface StoreConnectionView {
  readonly id: string;
  readonly object: typeof STORE_CONNECTION_OBJECT;
  readonly platform: StoreConnectionPlatform;
  readonly store_domain: string;
  readonly status: StoreConnectionStatus;
  /** Set exactly when the store answered the handshake, and null on a row that never did. */
  readonly connected_at: string | null;
  /** The identifier the platform gave the store. */
  readonly external_store_id: string | null;
  /** The only four characters of the store's token this platform will ever say out loud. */
  readonly store_token_last_four: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * What a connect answers: the view, whether this call found the connection standing, and the mode of the key.
 *
 * `reused` is part of the contract because *"the connection becomes active automatically"* must also be true when a
 * plugin calls twice - the second call is not an error, it is the same connection.
 */
export interface StoreConnectionOutcome {
  readonly status: 200;
  readonly body: StoreConnectionConnectView;
  readonly reused: boolean;
  readonly mode: "test" | "live";
}

/** The connect answer's body: the connection, plus the two facts only a handshake has. */
export type StoreConnectionConnectView = StoreConnectionView & {
  readonly reused: boolean;
  readonly mode: "test" | "live";
};
