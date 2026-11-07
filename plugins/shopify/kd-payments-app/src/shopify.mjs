// path: plugins/shopify/kd-payments-app/src/shopify.mjs
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Everything this app knows about Shopify's side of the install, in one module with no framework in it.
 *
 * ## The four facts the whole app rests on
 *
 *   1. **An install request is signed.** Shopify calls the app's URL with `shop`, `host`, `timestamp` and `hmac`, where
 *      the HMAC is SHA-256 over the query string's own parameters keyed with the app's client secret. Nothing else in
 *      the request proves it came from Shopify, so nothing else is trusted: the shop is read only after the signature
 *      verifies, and a missing, stale or repeated parameter refuses the whole request.
 *   2. **The authorization code is exchanged server to server.** The browser carries a code, never a token. The token
 *      is fetched with the client secret in a form body over https, from the shop's own `myshopify.com` host, and it
 *      never appears in a URL, a page or a log line.
 *   3. **A shop's identity is `<handle>.myshopify.com`.** A custom domain is a pointer the merchant can repoint, so it
 *      is not an identity and this app will not send one to the platform.
 *   4. **Only an Admin API access token is useful to the platform.** Shopify's `shpat_` and `shpca_` prefixes are the
 *      two an Admin API credential carries; a shared secret (`shpss_`) or a delegate token minted for another app
 *      (`shppa_`) is refused here, before it reaches the platform, with a message that says which mistake was made.
 *
 * ## Why the signature is compared this way
 *
 * Shopify's documented message is the query's parameters - everything except `hmac` and `signature` - sorted by key,
 * with `%` and `&` escaped in keys and values and `=` escaped in keys, joined with `&`. The comparison is
 * `timingSafeEqual`, because a signature compared with `===` tells an attacker how many leading characters were right.
 * The timestamp is bounded on both sides: an old signature is a replay and a signature from the future is a clock this
 * app has no reason to trust.
 */

/** The suffix that makes a host a Shopify shop. */
export const SHOP_DOMAIN_SUFFIX = ".myshopify.com";

/** The handle's bounds and shape, which Shopify's own naming rules satisfy. */
export const SHOP_HANDLE_MINIMUM_LENGTH = 3;
export const SHOP_HANDLE_MAXIMUM_LENGTH = 60;
export const SHOP_DOMAIN_MAXIMUM_LENGTH = SHOP_HANDLE_MAXIMUM_LENGTH + SHOP_DOMAIN_SUFFIX.length;
const SHOP_HANDLE_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9-]{${String(SHOP_HANDLE_MINIMUM_LENGTH - 2)},` +
    `${String(SHOP_HANDLE_MAXIMUM_LENGTH - 2)}}[a-z0-9]$`,
  "u",
);

/** The two prefixes Shopify documents for an Admin API access token this platform may present. */
export const ACCESS_TOKEN_PREFIXES = Object.freeze(["shpat_", "shpca_"]);

/** The prefixed strings Shopify documents that are not an Admin API access token for the platform. */
export const FOREIGN_TOKEN_PREFIXES = Object.freeze(["shppa_", "shpss_"]);

/** The token body's bounds, as `lib/api/shopify-connection-fields.ts` applies them on the platform. */
export const ACCESS_TOKEN_BODY_MINIMUM_LENGTH = 16;
export const ACCESS_TOKEN_BODY_MAXIMUM_LENGTH = 96;
export const ACCESS_TOKEN_MAXIMUM_LENGTH =
  ACCESS_TOKEN_PREFIXES[0].length + ACCESS_TOKEN_BODY_MAXIMUM_LENGTH;
const ACCESS_TOKEN_PATTERN = new RegExp(
  `^(?:${ACCESS_TOKEN_PREFIXES.join("|")})` +
    `[A-Za-z0-9_-]{${String(ACCESS_TOKEN_BODY_MINIMUM_LENGTH)},` +
    `${String(ACCESS_TOKEN_BODY_MAXIMUM_LENGTH)}}$`,
  "u",
);

/** How long an install signature may be older than the request that carries it. */
export const INSTALL_SIGNATURE_MAXIMUM_AGE_SECONDS = 86_400;

/** How far in the future a signature's timestamp may be before it is treated as a clock this app does not trust. */
export const INSTALL_SIGNATURE_FUTURE_TOLERANCE_SECONDS = 300;

export const SHOPIFY_RULES = Object.freeze({
  hmacMissing: "hmac_missing",
  hmacInvalid: "hmac_invalid",
  repeatedParameter: "repeated_parameter",
  timestampMissing: "timestamp_missing",
  timestampStale: "timestamp_stale",
  timestampFuture: "timestamp_future",
  shopInvalid: "shop_invalid",
  stateMissing: "state_missing",
  stateMismatch: "state_mismatch",
  codeMissing: "code_missing",
  tokenExchangeFailed: "token_exchange_failed",
  tokenMissing: "token_missing",
  tokenInvalid: "token_invalid",
  tokenWrongKind: "token_wrong_kind",
  tokenNotOffline: "token_not_offline",
});

/** A refusal of Shopify's own protocol, naming the rule and never the value. */
export class ShopifyError extends Error {
  constructor(rule) {
    super(rule);

    this.name = "ShopifyError";
    this.rule = rule;
  }
}

/**
 * The shop domain as Shopify names it, or a refusal.
 *
 * Lower case, one label and the permanent suffix: `Shop-Example.myshopify.com` becomes `shop-example.myshopify.com`
 * because a host is case insensitive; `shop.example.com` is refused because it is a domain, not an identity.
 */
export function parseShopDomain(value) {
  if (typeof value !== "string") {
    throw new ShopifyError(SHOPIFY_RULES.shopInvalid);
  }

  const lowered = value.trim().toLowerCase();
  const withoutScheme = lowered.replace(/^https?:\/\//u, "");
  const trimmed = withoutScheme.endsWith("/") ? withoutScheme.slice(0, -1) : withoutScheme;

  if (/[/?#@: ]/u.test(trimmed)) {
    throw new ShopifyError(SHOPIFY_RULES.shopInvalid);
  }

  if (!trimmed.endsWith(SHOP_DOMAIN_SUFFIX) || trimmed.length > SHOP_DOMAIN_MAXIMUM_LENGTH) {
    throw new ShopifyError(SHOPIFY_RULES.shopInvalid);
  }

  const handle = trimmed.slice(0, -SHOP_DOMAIN_SUFFIX.length);

  if (!SHOP_HANDLE_PATTERN.test(handle)) {
    throw new ShopifyError(SHOPIFY_RULES.shopInvalid);
  }

  return `${handle}${SHOP_DOMAIN_SUFFIX}`;
}

/**
 * The message Shopify signs, built exactly as Shopify documents it.
 *
 * The escapes are not decoration: without them a value carrying `&` would sign the same as two separate parameters, and
 * a request that verified one message while Shopify's own server read another is a forged request that passes.
 */
export function hmacMessage(entries) {
  const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return sorted
    .map(([key, value]) => {
      const escapedKey = key
        .split("%").join("%25")
        .split("&").join("%26")
        .split("=").join("%3D");
      const escapedValue = String(value).split("%").join("%25").split("&").join("%26");

      return `${escapedKey}=${escapedValue}`;
    })
    .join("&");
}

/** The hexadecimal HMAC-SHA256 of a message under the app's client secret. */
export function signMessage(message, secret) {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

/** A constant-time comparison of two hex digests, and a false for a pair that cannot be compared. */
export function sameSignature(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) {
    return false;
  }

  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Verify one Shopify query and answer the three values the rest of the app uses.
 *
 * Every rule is checked before the shop is read, because the shop is what the caller wants this app to believe. A
 * repeated parameter is refused rather than resolved: `shop=a&shop=b` verifies under one reading and means another.
 */
export function verifyInstallQuery({
  query,
  secret,
  nowMs,
  maximumAgeSeconds = INSTALL_SIGNATURE_MAXIMUM_AGE_SECONDS,
}) {
  const entries = [];
  const seen = new Set();

  for (const [key, value] of query) {
    if (seen.has(key)) {
      throw new ShopifyError(SHOPIFY_RULES.repeatedParameter);
    }

    seen.add(key);
    entries.push([key, value]);
  }

  const presented = query.get("hmac");

  if (presented === null || presented.length === 0) {
    throw new ShopifyError(SHOPIFY_RULES.hmacMissing);
  }

  const timestamp = query.get("timestamp");

  if (timestamp === null || !/^[0-9]{1,12}$/u.test(timestamp)) {
    throw new ShopifyError(SHOPIFY_RULES.timestampMissing);
  }

  const signedEntries = entries.filter(([key]) => key !== "hmac" && key !== "signature");
  const expected = signMessage(hmacMessage(signedEntries), secret);

  if (!sameSignature(presented.toLowerCase(), expected)) {
    throw new ShopifyError(SHOPIFY_RULES.hmacInvalid);
  }

  const seconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(nowMs / 1_000);

  if (nowSeconds - seconds > maximumAgeSeconds) {
    throw new ShopifyError(SHOPIFY_RULES.timestampStale);
  }

  if (seconds - nowSeconds > INSTALL_SIGNATURE_FUTURE_TOLERANCE_SECONDS) {
    throw new ShopifyError(SHOPIFY_RULES.timestampFuture);
  }

  return {
    shop: parseShopDomain(query.get("shop")),
    host: query.get("host") ?? "",
    timestampSeconds: seconds,
  };
}

/** An unpredictable state value: thirty-two bytes, base64url, which is what the callback is matched against. */
export function createState() {
  return randomBytes(32).toString("base64url");
}

/** The authorization URL a merchant's browser is sent to, with the state this app minted and will check. */
export function authorizeUrl({ shop, apiKey, scopes, redirectUri, state }) {
  const url = new URL(`https://${parseShopDomain(shop)}/admin/oauth/authorize`);

  url.searchParams.set("client_id", apiKey);
  url.searchParams.set("scope", scopes.join(","));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);

  return url.toString();
}

/** The token as the platform will accept it, or a refusal that says which kind of wrong string arrived. */
export function parseAccessToken(value) {
  if (typeof value !== "string") {
    throw new ShopifyError(SHOPIFY_RULES.tokenMissing);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new ShopifyError(SHOPIFY_RULES.tokenMissing);
  }

  if (FOREIGN_TOKEN_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    throw new ShopifyError(SHOPIFY_RULES.tokenWrongKind);
  }

  if (trimmed.length > ACCESS_TOKEN_MAXIMUM_LENGTH || !ACCESS_TOKEN_PATTERN.test(trimmed)) {
    throw new ShopifyError(SHOPIFY_RULES.tokenInvalid);
  }

  return trimmed;
}

/**
 * Exchange the authorization code for the shop's access token, server to server.
 *
 * The code is worthless without the client secret, which is why the secret is in the body of a POST from this server
 * rather than in anything the browser carries. `redirect: "error"` is deliberate: the token endpoint has no reason to
 * redirect, and following one would send the secret to whatever the Location header named. An `expires_in` field means
 * the grant produced a short-lived token - an online token, or an expiring offline one this app never asks for - and it
 * is refused, because a token that expires in an hour is not a connection.
 */
export async function exchangeCode({
  shop,
  apiKey,
  apiSecret,
  code,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new ShopifyError(SHOPIFY_RULES.codeMissing);
  }

  const domain = parseShopDomain(shop);
  const body = new URLSearchParams({
    client_id: apiKey,
    client_secret: apiSecret,
    code: code.trim(),
  });

  let response;

  try {
    response = await fetchImpl(`https://${domain}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ShopifyError(SHOPIFY_RULES.tokenExchangeFailed);
  }

  if (!response.ok) {
    throw new ShopifyError(SHOPIFY_RULES.tokenExchangeFailed);
  }

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new ShopifyError(SHOPIFY_RULES.tokenExchangeFailed);
  }

  if (typeof payload !== "object" || payload === null) {
    throw new ShopifyError(SHOPIFY_RULES.tokenExchangeFailed);
  }

  if (payload.expires_in !== undefined) {
    throw new ShopifyError(SHOPIFY_RULES.tokenNotOffline);
  }

  return {
    accessToken: parseAccessToken(payload.access_token),
    scope: typeof payload.scope === "string" ? payload.scope : "",
  };
}
