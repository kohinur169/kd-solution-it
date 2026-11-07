// path: lib/api/shopify-connection-fields.ts
import { deepFreeze } from "../utils/freeze.ts";
import {
  STORE_CONNECTION_COLUMNS,
  STORE_CONNECTION_ENTITY,
  type StoreConnectionConnectView,
  type StoreConnectionOutcome,
  type StoreConnectionPlatform,
  type StoreConnectionStatus,
  type StoreConnectionView,
} from "./store-connection-fields.ts";
import { PUBLIC_API_BASE } from "./public-fields.ts";

/**
 * Section 20's Shopify app connection, in the vocabulary the app and the platform share.
 *
 * ## The sentence this STEP owns
 *
 * *"Shopify: the platform has its own Shopify app with approval. A merchant installs the app and logs in with
 * credentials, and the connection becomes active and fully functional automatically."* STEP 208 connected a
 * WooCommerce store with a token the store minted for itself. This STEP connects a Shopify shop, and three words of
 * that sentence change the design:
 *
 *   - **app** - the merchant installs a package that is ours but runs *after* Shopify's own OAuth consent, so the
 *     token the platform ends up holding is minted by **Shopify**, not by the store. The platform never invents it,
 *     never sees the consent screen and never talks to Shopify during the handshake: the app does that, and hands the
 *     result over.
 *   - **after install** - the handshake therefore happens *after* the shop has already granted access. The credential
 *     login is what sorts a shop that has an app from a shop that has a **merchant**: Shopify knows the shop, and only
 *     the merchant's own public API key says which company on this platform it belongs to.
 *   - **active automatically** - no approval queue and no operator, exactly as STEP 208 argues. The platform's check
 *     is the credential, the permanent shop identity and the shape of the token, and all three are decided before a
 *     row is written.
 *
 * ## The shop's identity is Shopify's, not the merchant's
 *
 * `0035` stores a bare domain and makes it unique per merchant and platform. For WooCommerce any host is a store,
 * because WordPress can run anywhere. For Shopify it is not: a shop's permanent identity is
 * `<handle>.myshopify.com`, and a custom domain is a pointer a merchant can repoint at will. Sealing an access token
 * to a domain that can be moved elsewhere is how a store token leaves the shop it was minted for, so this surface
 * accepts **only** the `myshopify.com` identity and refuses a custom domain with a rule a merchant can read. The
 * check also makes the unique index do real work: the same shop cannot be connected twice through two hostnames.
 *
 * ## Why the platform accepts only two token prefixes
 *
 * Shopify documents several prefixed strings and only some of them are what this column is for. `shpat_` is an OAuth
 * access token and `shpca_` is the one token exchange returns - both are Admin API credentials the platform can
 * present. `shppa_` is a delegate token minted for *another* app, and `shpss_` is an app's shared secret, which must
 * never be stored in a column described as an access token. The two that are not addressed to this platform are
 * refused with their own rule instead of being sealed and discovered later on a real API call.
 *
 * ## What the app cannot choose
 *
 * The row's state, its `connected_at`, its identifier and the finality of a revocation are all the platform's. The app
 * sends a shop domain and a token; every value a caller could lie about in its own favour is computed here, and the
 * sealing context binds merchant, platform **and** domain so a ciphertext cannot be moved between rows.
 */

/** The platform this STEP connects, from `0035`'s own two rows. */
export const SHOPIFY_PLATFORM = "shopify" satisfies StoreConnectionPlatform;

/** The object name in every answer, so a client can tell one resource from another. */
export const SHOPIFY_CONNECTION_OBJECT = "store_connection";

/** Where the Shopify app connects, reads and disconnects: one resource, three verbs. */
export const API_SHOPIFY_CONNECTION_PATH = `${PUBLIC_API_BASE}/stores/shopify/connection`;

/** The route a call is counted and recorded under: one resource with no path parameter. */
export const API_SHOPIFY_CONNECTION_ROUTE = API_SHOPIFY_CONNECTION_PATH;

/** The fields a body may carry, and the one a query may carry. */
export const SHOPIFY_SHOP_DOMAIN_FIELD = "shop_domain";
export const SHOPIFY_ACCESS_TOKEN_FIELD = "access_token";
export const SHOPIFY_BODY_FIELD = "body";

/**
 * The largest body this surface reads.
 *
 * One shop domain (at most 74 characters) and one access token (at most 102): a kilobyte is far more than what the
 * largest legal body needs and small enough that a stranger's body is refused before it is parsed.
 */
export const SHOPIFY_BODY_MAXIMUM_BYTES = 1_024;

/**
 * The permanent identity of a shop: `<handle>.myshopify.com`.
 *
 * The handle's bounds are Shopify's own naming rules as the app's install check also applies them, and the suffix is
 * the one string that makes this a Shopify shop rather than any host a merchant typed.
 */
export const SHOPIFY_SHOP_DOMAIN_SUFFIX = ".myshopify.com";
export const SHOPIFY_SHOP_HANDLE_MINIMUM_LENGTH = 3;
export const SHOPIFY_SHOP_HANDLE_MAXIMUM_LENGTH = 60;
export const SHOPIFY_SHOP_DOMAIN_MAXIMUM_LENGTH =
  SHOPIFY_SHOP_HANDLE_MAXIMUM_LENGTH + SHOPIFY_SHOP_DOMAIN_SUFFIX.length;

/**
 * The pattern `0035`'s domain check has to accept, narrowed to the one form Shopify guarantees.
 *
 * The handle starts and ends with a letter or digit because Shopify's does, and the whole value is lower case because
 * `0035` stores it lower case - which is why the domain is lowered before this pattern is applied rather than after.
 */
export const SHOPIFY_SHOP_DOMAIN_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{${String(SHOPIFY_SHOP_HANDLE_MINIMUM_LENGTH - 2)},` +
    `${String(SHOPIFY_SHOP_HANDLE_MAXIMUM_LENGTH - 2)}}[a-z0-9]` +
    `${SHOPIFY_SHOP_DOMAIN_SUFFIX.split(".").join("\\.")}$`,
  "u",
);

/** The two prefixes Shopify documents for an Admin API access token this platform may present. */
export const SHOPIFY_ACCESS_TOKEN_PREFIXES = deepFreeze(["shpat_", "shpca_"] as const);

/** The prefixed strings Shopify documents that are not an access token for this platform. */
export const SHOPIFY_FOREIGN_TOKEN_PREFIXES = deepFreeze(["shppa_", "shpss_"] as const);

/**
 * The token's bounds, after the prefix.
 *
 * Shopify's own tokens are hexadecimal today and longer in the token-exchange grant, so the alphabet is the wider one
 * a base64url value can carry and the bounds are generous at both ends: sixteen characters is the shortest
 * credential-shaped body this platform will seal, and ninety-six the longest.
 */
export const SHOPIFY_ACCESS_TOKEN_BODY_MINIMUM_LENGTH = 16;
export const SHOPIFY_ACCESS_TOKEN_BODY_MAXIMUM_LENGTH = 96;
export const SHOPIFY_ACCESS_TOKEN_MAXIMUM_LENGTH =
  SHOPIFY_ACCESS_TOKEN_PREFIXES[0].length + SHOPIFY_ACCESS_TOKEN_BODY_MAXIMUM_LENGTH;
export const SHOPIFY_ACCESS_TOKEN_PATTERN = new RegExp(
  `^(?:${SHOPIFY_ACCESS_TOKEN_PREFIXES.join("|")})` +
    `[A-Za-z0-9_-]{${String(SHOPIFY_ACCESS_TOKEN_BODY_MINIMUM_LENGTH)},` +
    `${String(SHOPIFY_ACCESS_TOKEN_BODY_MAXIMUM_LENGTH)}}$`,
  "u",
);

/** The tail a screen may show and the only part of the token the platform ever repeats. */
export const SHOPIFY_TOKEN_TAIL_LENGTH = 4;

/**
 * The reasons a Shopify connection call is refused.
 *
 * Machine words, and each one is something the app's screen can act on: the four `shop_domain` rules separate a
 * missing value, a malformed host, a host that carries more than a host, and a perfectly valid domain that is simply
 * not a Shopify shop. The two `access_token` shape rules separate a token that is not shaped like one from a token
 * Shopify minted for somebody else.
 */
export const SHOPIFY_CONNECTION_RULES = deepFreeze({
  shopDomainMissing: "shop_domain_missing",
  shopDomainInvalid: "shop_domain_invalid",
  shopDomainNotBare: "shop_domain_not_bare",
  shopDomainNotMyshopify: "shop_domain_not_myshopify",
  accessTokenMissing: "access_token_missing",
  accessTokenInvalid: "access_token_invalid",
  accessTokenWrongKind: "access_token_wrong_kind",
  bodyMalformed: "body_malformed",
  bodyTooLarge: "body_too_large",
  unknownField: "unknown_field",
  connectionRevoked: "connection_revoked",
  connectionTokenMismatch: "connection_token_mismatch",
  notConnected: "not_connected",
  writeNotApplied: "connection_write_not_applied",
  unreadable: "connection_unreadable",
} as const);

/** The audit entity of one connection: `0035`'s table, named once. */
export const SHOPIFY_CONNECTION_ENTITY = STORE_CONNECTION_ENTITY;

/**
 * The columns every query of this surface reads, taken from STEP 208 rather than restated.
 *
 * One column list for one table means a Shopify read and a WooCommerce read cannot disagree about which columns are
 * safe to select, and the token's ciphertext, its iv and its tag are absent from both.
 */
export const SHOPIFY_CONNECTION_COLUMNS = STORE_CONNECTION_COLUMNS;

/** What the app sends after install: the shop Shopify named and the token Shopify minted. */
export interface ShopifyConnectionRequest {
  readonly shopDomain: string;
  readonly accessToken: string;
}

/** What the platform answers about one Shopify connection. */
export type ShopifyConnectionView = StoreConnectionView;

/** The connect answer: the connection, whether it already stood, and the mode of the key that asked. */
export type ShopifyConnectionConnectView = StoreConnectionConnectView;

/** What a connect call answers, in STEP 208's own outcome shape. */
export type ShopifyConnectionOutcome = StoreConnectionOutcome;

/** The states `0035` allows, re-exported so this module can name them without importing the migration's order twice. */
export type ShopifyConnectionStatus = StoreConnectionStatus;
