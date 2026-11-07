// path: lib/api/public-fields.ts
import type { CredentialMode } from "./credential-fields.ts";

/**
 * Section 20's public API vocabulary: the version, the header a key travels in, the refusals and the two
 * audit actions every call writes.
 *
 * Section 20's sentence for this STEP is short and absolute: *"Every API call requires authentication and is
 * rate limited and audit logged."* Three things follow, and this module names them so the middleware, the
 * route, the gate and the handoff cannot spell them differently.
 */

/** Where the public API lives. `rate_limit.ts` already gives everything under this prefix its own class. */
export const PUBLIC_API_PREFIX = "/api/public";

/** The first and only version. A path carries it, so a second version is a second folder rather than a flag. */
export const PUBLIC_API_VERSION = "v1";

/** The path of this version's root, which is what a route joins to. */
export const PUBLIC_API_BASE = `${PUBLIC_API_PREFIX}/${PUBLIC_API_VERSION}`;

/** The response header that says which version answered. */
export const PUBLIC_API_VERSION_HEADER = "x-api-version";

/** The header a key travels in. `Authorization: Bearer kd_test_...`. */
export const API_KEY_HEADER = "authorization";

/** The scheme, in the case the header is compared in. */
export const API_KEY_SCHEME = "bearer";

/** The longest header this platform will hash. Anything longer is refused before a byte reaches the database. */
export const API_KEY_MAXIMUM_LENGTH = 128;

/**
 * The four ways a call fails to authenticate.
 *
 * `invalid` covers three states on purpose - a key that never existed, a key that was revoked and a key whose
 * hash matches a row of another shape - because telling them apart is telling a stranger which of their guesses
 * was close. The two shape refusals are separate because they cost no query, and `account_unavailable` is
 * separate because a merchant whose company is closed should be told why nothing works.
 */
export const API_AUTH_RULES = Object.freeze({
  missing: "api_key_missing",
  malformed: "api_key_malformed",
  invalid: "api_key_invalid",
  accountUnavailable: "account_unavailable",
} as const);

/** The field name every refusal of this surface names, so a client can branch without parsing sentences. */
export const API_AUTH_FIELD = "authorization";

/** The two chain entries a call can write: one per call, and one per failed attempt. */
export const API_AUDIT = Object.freeze({
  call: "api.call",
  authFailed: "api.auth_failed",
} as const);

/** The entity the chain names for both. */
export const API_CALL_ENTITY = "api_call";

/**
 * How often a credential's `last_used_at` may be written.
 *
 * A write per call would double the cost of every request the platform serves and turn a busy integration into
 * a write amplification problem; a write per minute is enough for a merchant to see that a key is in use, which
 * is the only question the column answers. The throttle is read from the row that authentication already read,
 * so it costs nothing.
 */
export const API_LAST_USED_THROTTLE_SECONDS = 60;

/** The limits this surface publishes to a caller, taken from the `public_api` class of the platform's limiter. */
export const API_PUBLISHED_LIMITS = Object.freeze({
  requestsPerMinute: 60,
  accountRequestsPerMinute: 1_000,
  addressRequestsPerMinute: 300,
} as const);

/** One authenticated caller: what the platform knows about the key that arrived, and nothing about the key. */
export interface ApiPrincipal {
  readonly credentialId: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly mode: CredentialMode;
  readonly label: string;
  /** The handle inside the key, which is what a merchant recognises in a list. */
  readonly keyPrefix: string;
  /** The last four characters, and the only four the platform ever keeps in the clear. */
  readonly keyLastFour: string;
  /** True when this call was the one that refreshed `last_used_at`. */
  readonly lastUsedRefreshed: boolean;
}

/** What a route hands back to the pipeline: a status, a JSON body and any headers of its own. */
export interface PublicApiAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The identity a route is given once the call has been authenticated and counted. */
export interface PublicApiContext {
  readonly request: Request;
  readonly principal: ApiPrincipal;
  readonly method: string;
  readonly route: string;
}
