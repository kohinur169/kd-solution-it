// path: plugins/shopify/kd-payments-app/src/platform.mjs

/**
 * The three calls this app makes to the platform, and nothing else.
 *
 * ## What the app sends, and what it never does
 *
 * A call carries the merchant's **public API key** in the `Authorization` header and exactly two values in the body of
 * a connect: the shop's permanent domain and the token Shopify minted. It never sends the key in a URL, never sends the
 * app's client secret anywhere, and never retries a refused call: a `409` is an answer, not a failure, and pressing the
 * button again is the merchant's decision rather than this app's.
 *
 * ## Why the answers are reduced rather than passed on
 *
 * The platform's refusals are `{field, rule}` pairs by design, and those are the only parts a screen needs: passing the
 * raw body through would put a response this app did not write into a page this app did, which is how a reflected
 * string becomes an injection. The reduction also means a transport failure and a `502` look the same to the merchant -
 * "the platform is not answering" - which is what they are.
 */

/** The platform's resource, spelled once. */
export const CONNECTION_PATH = "/api/public/v1/stores/shopify/connection";

/** The platform's published key shape: `kd_<mode>_<prefix>_<64 hex>`. Checked before a byte leaves. */
export const API_KEY_PATTERN = /^kd_(?:test|live)_[a-z][a-z0-9_]{1,15}_[0-9a-f]{64}$/u;

/** The largest answer this client will read: a connection view is a small object. */
const MAXIMUM_RESPONSE_BYTES = 16_384;

/** The rule a screen shows when the platform could not be reached at all. */
export const TRANSPORT_RULE = "platform_unreachable";

/** A commercial decision the merchant can act on, reduced to the three values a screen shows. */
export class PlatformRefusal extends Error {
  constructor({ status, field, rule }) {
    super(`${String(status)} ${field ?? ""} ${rule ?? ""}`.trim());

    this.name = "PlatformRefusal";
    this.status = status;
    this.field = field;
    this.rule = rule;
  }
}

/** The merchant's key, trimmed and shape-checked, or undefined so a screen can ask again. */
export function parseApiKey(value) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return API_KEY_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** The first `{field, rule}` a platform refusal carried, or a pair that says the answer was not shaped like one. */
function refusalOf(status, body) {
  const details = typeof body === "object" && body !== null ? body.details : undefined;

  if (Array.isArray(details) && details.length > 0) {
    const first = details[0];

    if (typeof first === "object" && first !== null) {
      return new PlatformRefusal({
        status,
        field: typeof first.field === "string" ? first.field : null,
        rule: typeof first.rule === "string" ? first.rule : null,
      });
    }
  }

  return new PlatformRefusal({ status, field: null, rule: null });
}

/** The client one app instance holds: the base URL, a fetch, and a timeout that is the platform's contract too. */
export function createPlatformClient({ baseUrl, fetchImpl = fetch, timeoutMs = 10_000 }) {
  async function call({ method, path, apiKey, body }) {
    const headers = {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    };

    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response;

    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // The platform is one known origin. A redirect from it is not an answer this app should follow with a key.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PlatformRefusal({ status: 0, field: null, rule: TRANSPORT_RULE });
    }

    let text;

    try {
      text = await response.text();
    } catch {
      throw new PlatformRefusal({ status: 0, field: null, rule: TRANSPORT_RULE });
    }

    if (new TextEncoder().encode(text).length > MAXIMUM_RESPONSE_BYTES) {
      throw new PlatformRefusal({ status: response.status, field: null, rule: TRANSPORT_RULE });
    }

    let parsed;

    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      throw refusalOf(response.status, parsed);
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new PlatformRefusal({ status: response.status, field: null, rule: "answer_malformed" });
    }

    return parsed;
  }

  return {
    /** Log the merchant in: the shop, the token, and the key that says whose shop it is. */
    async connect({ apiKey, shopDomain, accessToken }) {
      return call({
        method: "POST",
        path: CONNECTION_PATH,
        apiKey,
        body: { shop_domain: shopDomain, access_token: accessToken },
      });
    },

    /** Ask what this shop's connection is. The shop travels in the query because it is not a path segment. */
    async status({ apiKey, shopDomain }) {
      return call({
        method: "GET",
        path: `${CONNECTION_PATH}?shop_domain=${encodeURIComponent(shopDomain)}`,
        apiKey,
      });
    },

    /** Revoke the connection. The platform keeps the row; `0035` makes the revocation final. */
    async disconnect({ apiKey, shopDomain }) {
      return call({
        method: "DELETE",
        path: `${CONNECTION_PATH}?shop_domain=${encodeURIComponent(shopDomain)}`,
        apiKey,
      });
    },
  };
}
