// path: lib/tax/taxcloud.ts

/**
 * The TaxCloud record: what TaxCloud's own pages say, what this platform will do with it, and what they leave open.
 *
 * STEP 176 records and designs; STEPs 177-180 build the connection flow, the per-merchant switch, the invoice
 * calculation and the stored tax lines. Everything below traces to a page read in this session, listed in
 * `TAXCLOUD_DOCUMENTATION_SOURCES` with the URL and the sentence it settled.
 *
 * ## The five facts that change how this integration must be written
 *
 * 1. **There is no sandbox host.** "TaxCloud does not use a separate sandbox environment. Instead, your integration
 *    will use the same base URLs and endpoints throughout development, testing, and production", and "the
 *    `connectionID` in your request determines which environment you are working in". So the environment is a
 *    property of the *connection*, never of the URL: this platform records a mode on the connection, refuses to
 *    infer it from a host, and refuses to call a test connection live.
 * 2. **Authentication moved into a header and the connection moved into the path.** The v1 API put `apiLoginID` and
 *    `apiKey` in every request body; v3 sends `X-API-KEY` as a header and the connection's UUID as a path segment.
 *    A key in a URL would be a key in every log line, so the only URL this module can build has no key in it.
 * 3. **A price is a JSON number of decimal dollars.** TaxCloud's own error guide lists "`price` as a string instead
 *    of a number" as a documented `400` cause, so prices are sent as numbers, quantities are decimal (the reference
 *    examples include `1.5`), and this platform's ten-thousandths are converted exactly or refused.
 * 4. **Zero tax is an answer, not a failure.** "If a merchant does not have nexus in a given state, the TaxCloud API
 *    will return a tax rate of 0% ... and still record the order data to track toward the state's economic nexus
 *    thresholds." A zero must therefore never be read as "the call failed", and an order is still sent.
 * 5. **Completion is what creates the liability.** "Orders that have no `completedDate` are not included in tax
 *    filings", a `completedDate` in the future is rejected with `422`, and refunds are created against an order
 *    with prices TaxCloud calculates itself. An invoice is not a tax liability until the money is actually taken.
 *
 * ## The error model is RFC 9457-ish problem JSON, and its statuses mean different things
 *
 * `400` is a malformed body (a missing field, a string where a number belongs), `422` is a well-formed body whose
 * contents cannot be processed (an incomplete address, an exempt order with no exemption), `401` is a wrong key,
 * `404` a wrong connection or id, `429` too many requests, `500` "a temporary issue on TaxCloud's end" for which the
 * page itself recommends exponential backoff. `TAXCLOUD_FAILURE_RULES` records each of those with this platform's
 * own error code, and the TIC search page adds `503` with a documented `Retry-After`.
 *
 * ## What this file deliberately does not do
 *
 * It performs no HTTP call, holds no credential in clear, seals nothing (STEP 177 does, with STEP 064's keyring),
 * writes no invoice and no tax line (STEPs 179-180), owns no route, screen or migration, and invents no webhook:
 * the pages read here document no callback or push mechanism, so an order's fate is read back with
 * `GET /tax/connections/{connectionId}/orders/{orderId}` and never pushed at us.
 */

import { deepFreeze } from "../utils/freeze.ts";
import { AppError } from "../errors/app-error.ts";
import type { ErrorCode } from "../errors/codes.ts";
import { MAXIMUM_MINOR, MINOR_PER_UNIT } from "../payments/money.ts";

/* -------------------------------------------------------------------------------------------------
 * Identity
 * ---------------------------------------------------------------------------------------------- */

/** The key this provider registers under. */
export const TAXCLOUD_PROVIDER_KEY = "taxcloud" as const;

/** The name a screen shows. */
export const TAXCLOUD_PROVIDER_NAME = "TaxCloud";

/** The API generation these pages document, and the one this platform speaks. */
export const TAXCLOUD_API_VERSION = "v3" as const;

/** The only API base the pages name. There is no second, sandbox, host. */
export const TAXCLOUD_API_BASE = "https://api.v3.taxcloud.com";

/** The dashboard, named so a refusal can point the merchant at the right place and never at the API. */
export const TAXCLOUD_DASHBOARD_URL = "https://app.taxcloud.com";

/** The host the documentation lives on. */
export const TAXCLOUD_DOCUMENTATION_HOST = "docs.taxcloud.com";

/**
 * The day these pages were read.
 *
 * Recorded because the rule is "read them in the session that writes the adapter": a later STEP that wants to
 * rely on a fact here can see how old the reading is without re-deriving it.
 */
export const TAXCLOUD_DOCUMENTATION_READ_ON = "2026-11-07";

/**
 * The sandbox base, which is `null` because TaxCloud documents none.
 *
 * The constant exists so the absence is a decision a type system enforces: a caller that wants "the sandbox base"
 * has nothing to pass, and a test connection is a second connection on the same host.
 */
export const TAXCLOUD_SANDBOX_BASE: null = null;

/**
 * Hosts that look like a TaxCloud API and are not this platform's.
 *
 * `api.taxcloud.net` and `api.taxcloud.com` serve the v1 API (a different protocol, a body-borne key, and endpoints
 * this platform does not speak), `app.taxcloud.com` is the dashboard and takes no API key, and `docs.taxcloud.com`
 * is documentation. All of them are refused as a base by name.
 */
export const TAXCLOUD_REFUSED_HOSTS: readonly string[] = deepFreeze([
  "api.taxcloud.net",
  "api.taxcloud.com",
  "app.taxcloud.com",
  "docs.taxcloud.com",
  "taxcloud.net",
  "www.taxcloud.net",
  "www.taxcloud.com",
]);

/** True when a value is the one documented API base, ignoring a trailing slash. */
export function isTaxCloudApiBase(base: string): boolean {
  return base.trim().replace(/\/+$/u, "") === TAXCLOUD_API_BASE;
}

/** Why a base is not usable, or null when it is. */
export function taxCloudBaseProblemOf(base: string): string | null {
  const trimmed = base.trim();
  if (trimmed.length === 0) return "a TaxCloud connection needs an API base";
  if (isTaxCloudApiBase(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "that is not a URL";
  }
  if (parsed.protocol !== "https:") return "TaxCloud is only spoken to over https";
  if (TAXCLOUD_REFUSED_HOSTS.includes(parsed.hostname.toLowerCase())) {
    return `${parsed.hostname} is not the v3 API host; the API lives at ${TAXCLOUD_API_BASE}`;
  }
  return `only ${TAXCLOUD_API_BASE} is the documented API base`;
}

/* -------------------------------------------------------------------------------------------------
 * Documentation sources
 * ---------------------------------------------------------------------------------------------- */

/** One page read for this record. */
export interface TaxCloudDocumentationSource {
  readonly topic: string;
  readonly url: string;
  readonly host: string;
  readonly status: "reviewed";
  /** What the page settled, in the words this platform acts on. */
  readonly recorded: string;
}

const taxCloudSource = (topic: string, url: string, recorded: string): TaxCloudDocumentationSource => ({
  topic,
  url,
  host: new URL(url).hostname,
  status: "reviewed",
  recorded,
});

/** The pages read in the STEP 176 session, each with what it settled. */
export const TAXCLOUD_DOCUMENTATION_SOURCES: readonly TaxCloudDocumentationSource[] = deepFreeze([
  taxCloudSource(
    "Setup and authentication",
    "https://docs.taxcloud.com/guides/getting-started/setup-and-authentication",
    "Generate a key in Developer > API and send it in X-API-KEY; v3 also accepts a JWT in Authorization: Bearer but the guide says use X-API-KEY; connectionID is a UUID in the URL path and has replaced API Login ID; a Ping answers 401 for a wrong key and 404 for a mistyped connection; there is no separate sandbox host and two connections are the recommended way to keep test and live apart.",
  ),
  taxCloudSource(
    "Testing and going live",
    "https://docs.taxcloud.com/guides/getting-started/testing-and-going-live",
    "TaxCloud does not use a separate sandbox environment: base URLs and endpoints are the same in development, testing and production, credentials and connection ID work in both modes, the connection ID decides which environment a request lands in, and once a connection is live every order, exemption and completion is treated as real and included in reporting.",
  ),
  taxCloudSource(
    "How TaxCloud works (four-step lifecycle)",
    "https://docs.taxcloud.com/guides/getting-started/how-tax-cloud-works",
    "The minimum integration is VerifyAddress, Lookup, order completion and returns, in that order; the Lookup family returns tax amounts and not jurisdiction detail, and jurisdiction data lives in TaxCloud's own reports.",
  ),
  taxCloudSource(
    "Migrating from API v1 to v3",
    "https://docs.taxcloud.com/guides/getting-started/migrating-from-api-v-1-to-v-3",
    "v1 was SOAP/XML or JSON over api.taxcloud.net/1.0/TaxCloud/{method} with apiLoginID and apiKey in the body and PascalCase fields; v3 is REST/JSON over api.v3.taxcloud.com/tax/connections/{connectionId}/... with X-API-KEY and camelCase fields; Lookup became POST /carts, Authorized/Captured/AuthorizedWithCapture became POST /carts/orders, Returned became POST /orders/refunds/{orderId}, ResponseType became HTTP status codes, and v3 returns the tax rate beside the amount.",
  ),
  taxCloudSource(
    "Calculate sales tax for one or more carts",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/cart/create-cart",
    "POST /tax/connections/{connectionId}/carts takes items[].{customerId,currency,origin,destination,lineItems}, upserts on cartId (a second call with the same cartId overwrites the previous items), and answers per line item tax.{amount,rate}; documented errors are 400, 401, 403, 404, 422, 429 and 500 with a problem JSON body carrying title, detail, status and an errors list of location, message and value.",
  ),
  taxCloudSource(
    "Components of tax calculation",
    "https://docs.taxcloud.com/guides/core-concepts/components-of-tax-calculation",
    "Tax depends on the seller's origin, the buyer's destination, nexus and jurisdictions, the product's TIC and any exemption; without nexus in a state the API returns a 0% rate and still records the order so economic nexus thresholds keep counting, so zero tax is a real answer and no-tax orders must still be sent.",
  ),
  taxCloudSource(
    "Taxability Information Codes and TIC search",
    "https://docs.taxcloud.com/guides/core-concepts/tic-search",
    "Every product needs a TIC and a wrong TIC is wrong tax; POST /tax/tic/search takes query (non-empty), limit (1-100, default 10) and cursor, and answers ranked results with ticId, label, description and a 0-1 score; documented errors are INVALID_QUERY and INVALID_LIMIT (400), RATE_LIMIT_EXCEEDED (429), INTERNAL_ERROR (500) and 503 for a temporarily unavailable search service with a Retry-After header to honour.",
  ),
  taxCloudSource(
    "Managing tax exemptions",
    "https://docs.taxcloud.com/guides/core-concepts/managing-tax-exemptions",
    "Exemption certificates are customer-level and belong to one connection; POST /tax/connections/{connectionId}/exemption-certificates takes customerId, customerName, address, customerBusinessType, reason, reasonDescription and the states covered; a certificate can be attached directly by exemptionId (recommended) or matched automatically by customerId plus destination state, and auto-match without a certificate leaves a filing gap; disabling a certificate never deletes it and existing orders keep their exemption.",
  ),
  taxCloudSource(
    "Convert carts to orders",
    "https://docs.taxcloud.com/guides/workflows/real-time-api/convert-carts-to-orders",
    "POST /tax/connections/{connectionId}/carts/orders takes orderId, cartId and completed (201 on success); orderId must be unique per connection; completed: true finalises the order into the tax liability, completed: false stores it uncompleted, a completedDate in the body or a later PATCH /orders/{orderId} completes it, and a future completedDate is rejected with 422.",
  ),
  taxCloudSource(
    "Create an order",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/orders/create-order",
    "POST /tax/connections/{connectionId}/orders uploads an order that never had a cart: transactionDate, completedDate, customerId, currency, origin, destination and lineItems are required, kind is order or credit, excludeFromFiling omits it from the filed return, exemption carries isExempt and exemptionId, and addressAutocomplete can be none, origin, destination or all.",
  ),
  taxCloudSource(
    "Refund an order",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/refunds/refund-order",
    "POST /tax/connections/{connectionId}/orders/refunds/{orderId} creates a refund, several refunds are allowed while the refunded quantity never exceeds the ordered one, prices and tax are calculated by TaxCloud from the order and must not be sent, an optional idempotencyKey makes a retry return the original refund with 200, and omitting the key answers with an X-TaxCloud-Warning header recommending one.",
  ),
  taxCloudSource(
    "Error handling when creating orders",
    "https://docs.taxcloud.com/guides/workflows/handling-errors",
    "400 is a body that does not match the schema (a missing customerId, transactionDate or destination, a price sent as a string, unsupported fields), 422 is a well-formed body with unusable contents (incomplete address, exemption fields missing), 500 is a temporary TaxCloud fault for which the page recommends a retry with exponential backoff, and the page asks for every response to be logged.",
  ),
  taxCloudSource(
    "Ping, the connection test",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/utilities/ping",
    "GET /tax/connections/{connectionId}/ping verifies authentication for that connection and answers 200 with a message field; 401 means the X-API-KEY header is wrong and 404 means the connection ID is mistyped or belongs to another account.",
  ),
  taxCloudSource(
    "Health, the service check",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/health",
    "GET /tax/health answers 200 with an overall status and a list of components with their own status and type; it takes no connection ID and proves nothing about a merchant's credentials.",
  ),
  taxCloudSource(
    "Verify address",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/utilities/verify-address",
    "POST /tax/verify-address takes line1, city, state and zip with countryCode defaulting to US (the only accepted value), truncates lines longer than 50 characters, and answers the corrected address; it is called before a cart or an order when an address is doubtful.",
  ),
  taxCloudSource(
    "Get a cart and get an order",
    "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/cart/get-cart",
    "GET /tax/connections/{connectionId}/carts/{cartId} answers the stored cart with its line items and tax, and GET /tax/connections/{connectionId}/orders/{orderId} answers the stored order, expanding refunds with expand=refunds; both are how state is read back because TaxCloud documents no webhook.",
  ),
]);

/** True when a URL is an https page on the documentation host and nowhere else. */
export function isTaxCloudDocumentationUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === TAXCLOUD_DOCUMENTATION_HOST;
}

/* -------------------------------------------------------------------------------------------------
 * Recorded rules
 * ---------------------------------------------------------------------------------------------- */

/** One rule this platform applies because a page says so. */
export interface TaxCloudRecordedRule {
  readonly id: string;
  readonly rule: string;
  readonly reason: string;
  readonly source: string;
}

/** The rules STEPs 177-180 must follow, each with the page that produced it. */
export const TAXCLOUD_RECORDED_RULES: readonly TaxCloudRecordedRule[] = deepFreeze([
  {
    id: "one_host_no_sandbox",
    rule: "The API base is https://api.v3.taxcloud.com and nothing else; test and live are two connections on that one host.",
    reason:
      "TaxCloud documents no sandbox host, and the connection ID is what decides which environment a request lands in, so a mode inferred from a URL would be a guess and a mode stored on the connection is a fact.",
    source: "https://docs.taxcloud.com/guides/getting-started/testing-and-going-live",
  },
  {
    id: "key_in_header",
    rule: "The API key travels in the X-API-KEY header and never in a URL, a body or a log line.",
    reason: "The v3 authentication page names the header; a key in a URL would be recorded by every proxy and log on the way.",
    source: "https://docs.taxcloud.com/guides/getting-started/setup-and-authentication",
  },
  {
    id: "connection_in_path",
    rule: "Every connection-scoped call carries the connection's UUID as a path segment, and this platform sends no apiLoginID or apiKey body fields.",
    reason:
      "v3 replaced API Login ID with connectionID in the path; sending the v1 body fields would be a v1 request to a v3 endpoint.",
    source: "https://docs.taxcloud.com/guides/getting-started/migrating-from-api-v-1-to-v-3",
  },
  {
    id: "price_is_a_number",
    rule: "A price is a JSON number of decimal dollars and a sub-cent price is refused rather than rounded by this platform.",
    reason:
      "The error guide lists a price sent as a string as a documented 400 cause, and the page's own rounding belongs to TaxCloud: this platform stores ten-thousandths, so it converts exactly or refuses.",
    source: "https://docs.taxcloud.com/guides/workflows/handling-errors",
  },
  {
    id: "amount_is_authoritative",
    rule: "The tax this platform stores is the amount TaxCloud returns, not a rate multiplied by this platform's own arithmetic.",
    reason:
      "v3 returns tax.{amount,rate} per line item; the rate is informational and the amount already carries TaxCloud's rounding, caps and thresholds.",
    source: "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/cart/create-cart",
  },
  {
    id: "zero_tax_is_an_answer",
    rule: "A zero tax amount is recorded as a legitimate answer and never as a failure, and an order with no tax is still sent.",
    reason:
      "Without nexus the API returns a 0% rate and still records the order so economic nexus thresholds keep counting; retrying or suppressing that answer would lose the threshold data.",
    source: "https://docs.taxcloud.com/guides/core-concepts/components-of-tax-calculation",
  },
  {
    id: "tic_on_every_line",
    rule: "Every line item carries a TIC, and a line with no known TIC uses the documented general code 0 rather than a guess.",
    reason: "Every product needs a TIC and a wrong TIC is wrong tax; the TIC search page states that plainly and offers a ranked search to find the right one.",
    source: "https://docs.taxcloud.com/guides/core-concepts/tic-search",
  },
  {
    id: "cart_is_an_upsert",
    rule: "A retried calculation reuses the same cartId, because a second POST with that cartId overwrites the cart rather than creating another.",
    reason: "The cart endpoint documents UPSERT semantics on cartId, which is what makes a retry safe for a tax calculation.",
    source: "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/cart/create-cart",
  },
  {
    id: "order_id_unique_per_connection",
    rule: "An order id is unique per connection and is this platform's own invoice or payment identifier, so a report can be matched back.",
    reason:
      "The conversion page says orderId must be unique for the connection, that a cart from another connection cannot be used, and advises storing the order id to match TaxCloud reports later.",
    source: "https://docs.taxcloud.com/guides/workflows/real-time-api/convert-carts-to-orders",
  },
  {
    id: "completion_creates_liability",
    rule: "An order is completed only when the money has been taken, and a completed date is never sent in the future.",
    reason:
      "Orders without a completedDate are not included in filings, a future completedDate is rejected with 422, and completion is what turns a calculation into a liability.",
    source: "https://docs.taxcloud.com/guides/workflows/real-time-api/convert-carts-to-orders",
  },
  {
    id: "refund_prices_are_taxclouds",
    rule: "A refund sends item ids and quantities only, with an idempotency key, and echoes no price or tax.",
    reason:
      "The refund page says prices and tax are calculated from the order and must not be sent, that a second request with the same idempotencykey returns the original refund, and that omitting the key earns an X-TaxCloud-Warning header.",
    source: "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/refunds/refund-order",
  },
  {
    id: "exemption_needs_a_certificate",
    rule: "An exempt transaction names a certificate id, and auto-match is never relied on in production.",
    reason:
      "A transaction marked exempt without a matched certificate is still recorded as exempt but leaves a filing gap the merchant must resolve; the page recommends direct attachment.",
    source: "https://docs.taxcloud.com/guides/core-concepts/managing-tax-exemptions",
  },
  {
    id: "no_webhook",
    rule: "Order state is read back with a GET and never awaited as a push.",
    reason:
      "No page read here documents a callback, a signature or a delivery schedule, so an integration that waited for one would wait forever; the pages offer GET /carts/{cartId} and GET /orders/{orderId} instead.",
    source: "https://docs.taxcloud.com/api-reference/api-reference/sales-tax-api/orders/get-order",
  },
  {
    id: "retry_by_status",
    rule: "400, 401, 403, 404 and 422 are permanent, 429 and 500 and 503 are retried with backoff, and Retry-After is honoured when present.",
    reason:
      "The error guide calls 500 a temporary TaxCloud fault and prescribes exponential backoff, and the TIC search page documents 503 with a Retry-After header; a retried 400 or 422 would repeat a defect forever.",
    source: "https://docs.taxcloud.com/guides/workflows/handling-errors",
  },
]);

/* -------------------------------------------------------------------------------------------------
 * Endpoints
 * ---------------------------------------------------------------------------------------------- */

/** What one endpoint is: its method and its documented path template. */
export interface TaxCloudEndpoint {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
  /** Null when the endpoint is not scoped to a connection. */
  readonly scope: "connection" | "global";
}

/** The endpoints this platform speaks, each with the path exactly as the reference page writes it. */
export const TAXCLOUD_ENDPOINTS = deepFreeze({
  health: { method: "GET", path: "/tax/health", scope: "global" },
  ping: { method: "GET", path: "/tax/connections/{connectionId}/ping", scope: "connection" },
  carts: { method: "POST", path: "/tax/connections/{connectionId}/carts", scope: "connection" },
  cart: { method: "GET", path: "/tax/connections/{connectionId}/carts/{cartId}", scope: "connection" },
  cartOrders: { method: "POST", path: "/tax/connections/{connectionId}/carts/orders", scope: "connection" },
  orders: { method: "POST", path: "/tax/connections/{connectionId}/orders", scope: "connection" },
  order: { method: "GET", path: "/tax/connections/{connectionId}/orders/{orderId}", scope: "connection" },
  orderUpdate: { method: "PATCH", path: "/tax/connections/{connectionId}/orders/{orderId}", scope: "connection" },
  refunds: { method: "POST", path: "/tax/connections/{connectionId}/orders/refunds/{orderId}", scope: "connection" },
  exemptionCertificates: { method: "POST", path: "/tax/connections/{connectionId}/exemption-certificates", scope: "connection" },
  verifyAddress: { method: "POST", path: "/tax/verify-address", scope: "global" },
  ticSearch: { method: "POST", path: "/tax/tic/search", scope: "global" },
} as const satisfies Readonly<Record<string, TaxCloudEndpoint>>);

/** One documented endpoint name. */
export type TaxCloudEndpointName = keyof typeof TAXCLOUD_ENDPOINTS;

/** The values a path template can need. */
export interface TaxCloudPathParams {
  readonly connectionId?: string;
  readonly cartId?: string;
  readonly orderId?: string;
}

const TAXCLOUD_SEGMENT_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/u;
const TAXCLOUD_CONNECTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function requireTaxCloudSegment(value: string, field: string): string {
  // No trimming: a value with a newline or a space in it is refused rather than quietly repaired, because the
  // caller that produced it is the bug, and a silently trimmed id hides that bug until the wrong record is fetched.
  if (TAXCLOUD_SEGMENT_PATTERN.test(value) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field, rule: "a path segment is 1 to 200 letters, digits, dots, underscores, tildes or hyphens" }],
    });
  }
  return value;
}

/** True when a value is the UUID shape every documented connection ID has. */
export function isTaxCloudConnectionId(value: string): boolean {
  return TAXCLOUD_CONNECTION_ID_PATTERN.test(value.trim().toLowerCase());
}

/** The connection ID, or `VALIDATION_FAILED`. */
export function requireTaxCloudConnectionId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (isTaxCloudConnectionId(trimmed) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "connectionId", rule: "a connection ID is the UUID-shaped value the TaxCloud dashboard shows" }],
    });
  }
  return trimmed;
}

/**
 * The path of one endpoint, with every placeholder filled from the caller's own values.
 *
 * A placeholder left unfilled is a `VALIDATION_FAILED` rather than a path with `{orderId}` in it, and every value is
 * checked against one segment pattern so a value containing `/`, `?`, `#` or a newline cannot change which endpoint
 * a request reaches.
 */
export function taxCloudPathOf(name: TaxCloudEndpointName, params: TaxCloudPathParams = {}): string {
  const endpoint: TaxCloudEndpoint = TAXCLOUD_ENDPOINTS[name];
  let path: string = endpoint.path;
  const fills: readonly (readonly [string, string | undefined])[] = [
    ["{connectionId}", params.connectionId === undefined ? undefined : requireTaxCloudConnectionId(params.connectionId)],
    ["{cartId}", params.cartId === undefined ? undefined : requireTaxCloudSegment(params.cartId, "cartId")],
    ["{orderId}", params.orderId === undefined ? undefined : requireTaxCloudSegment(params.orderId, "orderId")],
  ];
  for (const [placeholder, value] of fills) {
    if (path.includes(placeholder) === false) continue;
    if (value === undefined) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: placeholder.slice(1, -1), rule: "this endpoint needs this value" }] });
    }
    path = path.split(placeholder).join(value);
  }
  if (path.includes("{") === true) {
    throw new AppError("INTERNAL_ERROR", { details: [{ field: "path", rule: "this endpoint has a placeholder the builder does not fill" }] });
  }
  return path;
}

/** The full URL of one endpoint. The only base this can produce is the documented one. */
export function taxCloudUrlOf(name: TaxCloudEndpointName, params: TaxCloudPathParams = {}): string {
  return `${TAXCLOUD_API_BASE}${taxCloudPathOf(name, params)}`;
}

/* -------------------------------------------------------------------------------------------------
 * Headers and the request
 * ---------------------------------------------------------------------------------------------- */

/** The one header a TaxCloud key travels in. */
export const TAXCLOUD_AUTH_HEADER = "X-API-KEY";

/** The JSON content type the API expects. */
export const TAXCLOUD_CONTENT_TYPE = "application/json";

/** The header the reference and guide pages list as the alternative, which this platform does not use. */
export const TAXCLOUD_REFUSED_AUTH_HEADER = "Authorization";

/** The smallest and largest key this platform stores. */
export const TAXCLOUD_API_KEY_MINIMUM_LENGTH = 16;
export const TAXCLOUD_API_KEY_MAXIMUM_LENGTH = 200;

/** Why an API key is unusable, or null when it is usable. */
export function taxCloudApiKeyProblemOf(apiKey: string): string | null {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return "a TaxCloud connection needs an API key";
  if (trimmed.length < TAXCLOUD_API_KEY_MINIMUM_LENGTH) return "that key is shorter than any value TaxCloud issues";
  if (trimmed.length > TAXCLOUD_API_KEY_MAXIMUM_LENGTH) return "that key is longer than this platform stores";
  if (/\s/u.test(trimmed)) return "an API key contains no whitespace";
  if (/[\u0000-\u001f\u007f]/u.test(trimmed)) return "an API key contains no control character";
  return null;
}

/**
 * The headers of one call.
 *
 * `X-API-KEY` and `Accept` always, `Content-Type` when there is a body, and never an `Authorization` header: the v3
 * reference lists a bearer JWT as an alternative, but this platform issues no TaxCloud JWT, so it uses the one
 * method its own documentation recommends.
 */
export function taxCloudHeadersOf(apiKey: string, options: { readonly hasBody?: boolean } = {}): Readonly<Record<string, string>> {
  const problem = taxCloudApiKeyProblemOf(apiKey);
  if (problem !== null) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "apiKey", rule: problem }] });
  }
  const headers: Record<string, string> = { [TAXCLOUD_AUTH_HEADER]: apiKey.trim(), Accept: TAXCLOUD_CONTENT_TYPE };
  if (options.hasBody === true) headers["Content-Type"] = TAXCLOUD_CONTENT_TYPE;
  return deepFreeze(headers);
}

/** A request this platform would make: the method, the URL, the headers and the body already serialised. */
export interface TaxCloudRequest {
  readonly method: TaxCloudEndpoint["method"];
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The JSON text, or null for a call with no body. */
  readonly body: string | null;
}

export interface TaxCloudRequestInput {
  readonly endpoint: TaxCloudEndpointName;
  readonly params?: TaxCloudPathParams;
  readonly apiKey: string;
  readonly body?: unknown;
}

/**
 * Build the request a STEP 177-180 caller would send, without sending it.
 *
 * The point of building it here is that it can be inspected: the key is in exactly one header, the URL is the one
 * documented base plus a path of checked segments, and a body that cannot be serialised is refused rather than sent
 * as `[object Object]`.
 */
export function taxCloudRequestOf(input: TaxCloudRequestInput): TaxCloudRequest {
  const endpoint: TaxCloudEndpoint = TAXCLOUD_ENDPOINTS[input.endpoint];
  const hasBody = input.body !== undefined;
  let serialised: string | null = null;
  if (hasBody) {
    try {
      serialised = JSON.stringify(input.body);
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "body", rule: "the body cannot be serialised as JSON" }] });
    }
    if (serialised === undefined) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "body", rule: "the body cannot be serialised as JSON" }] });
    }
  }
  if (endpoint.method === "GET" && hasBody) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "body", rule: "this endpoint takes no body" }] });
  }
  return {
    method: endpoint.method,
    url: taxCloudUrlOf(input.endpoint, input.params ?? {}),
    headers: taxCloudHeadersOf(input.apiKey, { hasBody }),
    body: serialised,
  };
}

/* -------------------------------------------------------------------------------------------------
 * Failures
 * ---------------------------------------------------------------------------------------------- */

/** The statuses the reference pages document, plus the one the TIC search page adds. */
export const TAXCLOUD_PROBLEM_STATUSES = deepFreeze([400, 401, 403, 404, 422, 429, 500, 503] as const);

/** What a failure means to this platform. */
export const TAXCLOUD_FAILURE_OUTCOMES = deepFreeze([
  "invalid_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "unprocessable",
  "rate_limited",
  "provider_error",
  "unavailable",
  "unexpected",
] as const);

export type TaxCloudFailureOutcome = (typeof TAXCLOUD_FAILURE_OUTCOMES)[number];

/** One documented status and how this platform answers it. */
export interface TaxCloudFailureRule {
  readonly status: number;
  readonly outcome: TaxCloudFailureOutcome;
  /** True only for the statuses the pages call temporary. */
  readonly retryable: boolean;
  readonly code: ErrorCode;
  readonly officeMessage: string;
}

/**
 * The status table.
 *
 * The split is the pages' own: a `400` is a body this platform built wrongly and a `422` a body TaxCloud could not
 * process, both permanent until somebody changes the request; `401`, `403` and `404` are the merchant's credentials
 * or connection id and are permanent until the merchant fixes them; `429`, `500` and `503` are the temporary ones
 * the error guide says to retry with backoff.
 */
export const TAXCLOUD_FAILURE_RULES: readonly TaxCloudFailureRule[] = deepFreeze([
  {
    status: 400,
    outcome: "invalid_request",
    retryable: false,
    code: "VALIDATION_FAILED",
    officeMessage: "TaxCloud rejected the request's shape; the fields it names must be fixed before it is sent again.",
  },
  {
    status: 401,
    outcome: "unauthorized",
    retryable: false,
    code: "DEPENDENCY_FAILED",
    officeMessage: "TaxCloud says the X-API-KEY header is wrong; the merchant must generate a new key and connect again.",
  },
  {
    status: 403,
    outcome: "forbidden",
    retryable: false,
    code: "DEPENDENCY_FAILED",
    officeMessage: "The key is real but not allowed to do this; the TaxCloud account's plan or connection is the cause.",
  },
  {
    status: 404,
    outcome: "not_found",
    retryable: false,
    code: "RESOURCE_NOT_FOUND",
    officeMessage: "TaxCloud found no such connection or id; the connection ID is mistyped or belongs to another account.",
  },
  {
    status: 422,
    outcome: "unprocessable",
    retryable: false,
    code: "VALIDATION_FAILED",
    officeMessage: "TaxCloud understood the request but could not process it; an address or an exemption is incomplete.",
  },
  {
    status: 429,
    outcome: "rate_limited",
    retryable: true,
    code: "RATE_LIMITED",
    officeMessage: "TaxCloud asked for fewer requests; the call is retried after a backoff.",
  },
  {
    status: 500,
    outcome: "provider_error",
    retryable: true,
    code: "SERVICE_UNAVAILABLE",
    officeMessage: "TaxCloud had a temporary fault; the call is retried with backoff.",
  },
  {
    status: 503,
    outcome: "unavailable",
    retryable: true,
    code: "SERVICE_UNAVAILABLE",
    officeMessage: "TaxCloud's service is temporarily unavailable; the documented Retry-After header is honoured when present.",
  },
]);

/** The problem body the reference pages document. Every field is optional because a gateway may answer with less. */
export interface TaxCloudProblemBody {
  readonly title: string | null;
  readonly detail: string | null;
  readonly status: number | null;
  readonly errors: readonly { readonly location: string | null; readonly message: string | null }[];
}

function taxCloudRecordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Readonly<Record<string, unknown>>;
}

function taxCloudTextOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Read a problem body without trusting it.
 *
 * A body that is not an object, a body with a number where a string belongs, and a body that is empty all produce
 * the same shape with nulls, because this runs on the failure path where throwing would hide the real status.
 */
export function taxCloudProblemOf(body: unknown): TaxCloudProblemBody {
  const record = taxCloudRecordOf(body);
  if (record === null) return { title: null, detail: null, status: null, errors: [] };
  const rawStatus = record["status"];
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : null;
  const errors: { location: string | null; message: string | null }[] = [];
  const rawErrors = record["errors"];
  if (Array.isArray(rawErrors)) {
    for (const entry of rawErrors) {
      const error = taxCloudRecordOf(entry);
      if (error === null) continue;
      errors.push({ location: taxCloudTextOf(error["location"]), message: taxCloudTextOf(error["message"]) });
    }
  }
  return { title: taxCloudTextOf(record["title"]), detail: taxCloudTextOf(record["detail"]), status, errors };
}

/** One failure, read through the status table. */
export interface TaxCloudFailure {
  readonly status: number;
  readonly outcome: TaxCloudFailureOutcome;
  readonly retryable: boolean;
  readonly code: ErrorCode;
  readonly officeMessage: string;
  /** TaxCloud's own detail sentence when the body carried one. */
  readonly detail: string | null;
  readonly problems: TaxCloudProblemBody["errors"];
}

/**
 * Classify a non-2xx answer.
 *
 * A status outside the documented set is `unexpected` and is not retried: the pages name no meaning for it, and
 * guessing that an unlisted status is temporary is how a loop is built.
 */
export function taxCloudFailureOf(status: number, body?: unknown): TaxCloudFailure {
  const problem = taxCloudProblemOf(body);
  const rule = TAXCLOUD_FAILURE_RULES.find((entry) => entry.status === status);
  if (rule === undefined) {
    return {
      status,
      outcome: "unexpected",
      retryable: false,
      code: "DEPENDENCY_FAILED",
      officeMessage: "TaxCloud answered with a status its pages do not document; the call is not retried automatically.",
      detail: problem.detail,
      problems: problem.errors,
    };
  }
  return {
    status,
    outcome: rule.outcome,
    retryable: rule.retryable,
    code: rule.code,
    officeMessage: rule.officeMessage,
    detail: problem.detail,
    problems: problem.errors,
  };
}

/* -------------------------------------------------------------------------------------------------
 * The connection test
 * ---------------------------------------------------------------------------------------------- */

/** What a ping can prove. */
export const TAXCLOUD_PING_OUTCOMES = deepFreeze([
  "verified",
  "unauthorized",
  "connection_not_found",
  "unreachable",
  "unexpected",
] as const);

export type TaxCloudPingOutcome = (typeof TAXCLOUD_PING_OUTCOMES)[number];

/**
 * Read a ping's status.
 *
 * `200` is the only success, `401` is the documented wrong-key answer and `404` the documented mistyped-or-someone-
 * else's-connection answer; those three are different problems with different fixes, which is why they are not one
 * "failed". A `429`, `500` or `503` says nothing about the credentials, so it is `unreachable` rather than a verdict.
 */
export function taxCloudPingOutcomeOf(status: number): TaxCloudPingOutcome {
  if (status === 200) return "verified";
  if (status === 401) return "unauthorized";
  if (status === 404) return "connection_not_found";
  if (status === 429 || status === 500 || status === 503) return "unreachable";
  return "unexpected";
}

/** The office's sentence for a ping outcome, in the words the setup page uses. */
export function taxCloudPingMessageOf(outcome: TaxCloudPingOutcome): string {
  switch (outcome) {
    case "verified":
      return "TaxCloud accepted the API key for this connection.";
    case "unauthorized":
      return "TaxCloud answered 401, which the setup page attributes to the X-API-KEY header.";
    case "connection_not_found":
      return "TaxCloud answered 404, which the setup page attributes to a mistyped connection ID or one belonging to another account.";
    case "unreachable":
      return "TaxCloud could not be reached, so nothing is known about the credentials yet.";
    case "unexpected":
      return "TaxCloud answered with a status its pages do not document for this call.";
  }
}

/* -------------------------------------------------------------------------------------------------
 * The connection
 * ---------------------------------------------------------------------------------------------- */

/** The two modes a connection can be in. There is no third, and no host encodes either of them. */
export const TAXCLOUD_CONNECTION_MODES = deepFreeze(["test", "live"] as const);

export type TaxCloudConnectionMode = (typeof TAXCLOUD_CONNECTION_MODES)[number];

/** True when a value is one of the two modes. */
export function isTaxCloudConnectionMode(value: string): value is TaxCloudConnectionMode {
  return (TAXCLOUD_CONNECTION_MODES as readonly string[]).includes(value);
}

/** What a stored connection may be. */
export const TAXCLOUD_CONNECTION_STATUSES = deepFreeze(["unverified", "verified", "failed", "revoked"] as const);

export type TaxCloudConnectionStatus = (typeof TAXCLOUD_CONNECTION_STATUSES)[number];

/**
 * One merchant's TaxCloud connection.
 *
 * `mode` is declared by the merchant and proved by nothing, which is exactly why it is stored: TaxCloud cannot tell
 * this platform which mode a connection is in beyond which connection ID was used, so the platform records the mode
 * it was told and refuses to treat a test connection as live.
 *
 * `apiKeySealed` is STEP 177's write, sealed with STEP 064's keyring; this file only names the column and masks what
 * is in it.
 */
export interface TaxCloudConnection {
  readonly id: string;
  readonly companyId: string;
  readonly mode: TaxCloudConnectionMode;
  readonly connectionId: string;
  readonly apiKeySealed: string;
  readonly status: TaxCloudConnectionStatus;
  readonly verifiedAtEpochMs: number | null;
  readonly lastPingAtEpochMs: number | null;
  readonly lastPingOutcome: TaxCloudPingOutcome | null;
  readonly version: number;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What a merchant submits to connect. */
export interface TaxCloudConnectionDraft {
  readonly companyId: string;
  readonly mode: TaxCloudConnectionMode;
  readonly connectionId: string;
  readonly apiKey: string;
}

function isTaxCloudEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Why a draft cannot be stored, or null when it can.
 *
 * This runs before anything is sealed, so a bad draft costs no encryption work and leaves no half-written row. A mode
 * outside `test` and `live` is refused with the sentence that explains why, because "sandbox" is the word a merchant
 * will reach for and it is the one word with no meaning here.
 */
export function taxCloudConnectionDraftProblemOf(draft: TaxCloudConnectionDraft): string | null {
  if (draft.companyId.trim().length === 0) return "a connection belongs to a company";
  if (isTaxCloudConnectionMode(draft.mode) === false) {
    return "a connection is either test or live; TaxCloud documents no sandbox host, so a separate connection is how test data stays apart";
  }
  if (isTaxCloudConnectionId(draft.connectionId) === false) {
    return "the connection ID is the UUID-shaped value the TaxCloud dashboard shows under Integrations";
  }
  return taxCloudApiKeyProblemOf(draft.apiKey);
}

/** A key as a screen shows it: never more than its last four characters. */
export function maskTaxCloudApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return "*".repeat(trimmed.length);
  return `${"*".repeat(12)}${trimmed.slice(-4)}`;
}

/** A stored connection as a screen reads it. No method of this type returns a sealed value or a whole key. */
export interface TaxCloudConnectionView {
  readonly id: string;
  readonly companyId: string;
  readonly mode: TaxCloudConnectionMode;
  readonly connectionId: string;
  readonly apiKeyMasked: string;
  readonly status: TaxCloudConnectionStatus;
  readonly verifiedAtEpochMs: number | null;
  readonly lastPingAtEpochMs: number | null;
  readonly lastPingOutcome: TaxCloudPingOutcome | null;
  readonly version: number;
  readonly updatedAtEpochMs: number;
}

/**
 * The masked view. The key is opened by the caller for exactly as long as it takes to mask, and the connection id is
 * shown in full because TaxCloud's own page calls it a value that "can be referenced directly from your TaxCloud
 * integration page".
 */
export function taxCloudConnectionViewOf(connection: TaxCloudConnection, apiKey: string): TaxCloudConnectionView {
  return {
    id: connection.id,
    companyId: connection.companyId,
    mode: connection.mode,
    connectionId: connection.connectionId,
    apiKeyMasked: maskTaxCloudApiKey(apiKey),
    status: connection.status,
    verifiedAtEpochMs: connection.verifiedAtEpochMs,
    lastPingAtEpochMs: connection.lastPingAtEpochMs,
    lastPingOutcome: connection.lastPingOutcome,
    version: connection.version,
    updatedAtEpochMs: connection.updatedAtEpochMs,
  };
}

/**
 * Why a stored connection breaks its own invariants, or null when it does not.
 *
 * The rules a table and a store must hold: a connection belongs to a company, its id is a UUID, its status is one of
 * four, `verified` means a ping said so at some instant, and a `live` verified connection got there through a
 * `verified` ping rather than a status somebody typed.
 */
export function taxCloudConnectionProblemOf(connection: TaxCloudConnection): string | null {
  if (connection.id.trim().length === 0) return "a connection needs a row id";
  if (connection.companyId.trim().length === 0) return "a connection belongs to a company";
  if (isTaxCloudConnectionMode(connection.mode) === false) return "a connection is either test or live";
  if (isTaxCloudConnectionId(connection.connectionId) === false) return "the connection ID is the UUID-shaped value TaxCloud shows";
  if (connection.apiKeySealed.trim().length === 0) return "a connection needs a sealed API key";
  if ((TAXCLOUD_CONNECTION_STATUSES as readonly string[]).includes(connection.status) === false) {
    return "a connection status is unverified, verified, failed or revoked";
  }
  if (connection.lastPingOutcome !== null && (TAXCLOUD_PING_OUTCOMES as readonly string[]).includes(connection.lastPingOutcome) === false) {
    return "a ping outcome is one of the five this platform records";
  }
  if (connection.status === "verified") {
    if (connection.verifiedAtEpochMs === null || isTaxCloudEpochMs(connection.verifiedAtEpochMs) === false) {
      return "a verified connection records when the ping verified it";
    }
    if (connection.lastPingOutcome !== "verified") return "a verified connection was verified by a ping, not by a typed status";
  }
  if (connection.lastPingAtEpochMs !== null && isTaxCloudEpochMs(connection.lastPingAtEpochMs) === false) {
    return "a ping instant is a positive whole number of milliseconds";
  }
  if (connection.version < 1 || Number.isSafeInteger(connection.version) === false) return "a connection has a whole version of at least one";
  if (isTaxCloudEpochMs(connection.createdAtEpochMs) === false) return "a connection records when it was created";
  if (isTaxCloudEpochMs(connection.updatedAtEpochMs) === false) return "a connection records when it was last written";
  if (connection.updatedAtEpochMs < connection.createdAtEpochMs) return "a connection cannot be updated before it was created";
  return null;
}

/**
 * True only for a live connection whose ping verified it.
 *
 * This is the one function a later STEP may use to decide that tax may be collected, and it is deliberately narrow:
 * FEATURE_LIST section 7 gives the merchant a personal TaxCloud account and a switch, and a test connection must
 * never be the thing that puts a real tax line on a real invoice.
 */
export function isTaxCloudCollectionEnabled(connection: TaxCloudConnection): boolean {
  return connection.mode === "live" && connection.status === "verified" && connection.lastPingOutcome === "verified";
}

/** Why collection is not enabled, or null when it is. */
export function taxCloudCollectionProblemOf(connection: TaxCloudConnection): string | null {
  if (connection.status === "revoked") return "this connection was revoked";
  if (connection.mode === "test") return "a test connection never collects tax on a real invoice";
  if (connection.status === "failed") return "the last ping failed, so the credentials are not known to work";
  if (connection.status === "unverified") return "this connection has not been verified by a ping yet";
  if (connection.lastPingOutcome !== "verified") return "the last ping did not verify this connection's credentials";
  return isTaxCloudCollectionEnabled(connection) ? null : "this connection is not enabled for collection";
}

/* -------------------------------------------------------------------------------------------------
 * Amounts
 * ---------------------------------------------------------------------------------------------- */

/** The unit TaxCloud's pages are written in: decimal dollars, as JSON numbers. */
export const TAXCLOUD_AMOUNT_UNIT = "usd_decimal_dollars" as const;

const TAXCLOUD_AMOUNT_PATTERN = /^\d{1,15}(\.\d{1,4})?$/u;

/**
 * A decimal-dollar amount as this platform's ten-thousandths.
 *
 * The parser is a string parser on purpose: `Number` arithmetic would turn `1.31` into `13099.999...` and a tax
 * amount that is a ten-thousandth off is a wrong invoice. Five or more decimal places are refused rather than
 * truncated, because the caller is the only place that knows how the value should be rounded.
 */
export function taxCloudMinorOfAmount(value: number | string): bigint {
  const text = typeof value === "number" ? String(value) : value.trim();
  if (typeof value === "number" && Number.isFinite(value) === false) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "amount", rule: "an amount is a finite decimal number" }] });
  }
  if (TAXCLOUD_AMOUNT_PATTERN.test(text) === false) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "amount", rule: "an amount is up to fifteen digits with at most four decimal places and no sign or exponent" }],
    });
  }
  const [whole = "0", fraction = ""] = text.split(".");
  const padded = `${fraction}0000`.slice(0, 4);
  return BigInt(whole) * MINOR_PER_UNIT + BigInt(padded);
}

/**
 * A platform amount as the JSON number TaxCloud expects for `price`.
 *
 * Two rules, both from the pages: the price must be a number rather than a string (its error guide says so), and the
 * number must be the exact value this platform meant. A price that cannot be represented exactly is refused, and a
 * sub-cent price is refused with the sentence that says the rounding belongs to the invoice.
 */
export function taxCloudPriceOf(priceMinor: bigint): number {
  if (priceMinor < 0n) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "price", rule: "a price cannot be negative" }] });
  }
  if (priceMinor > MAXIMUM_MINOR) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "price", rule: "a price past the money ceiling cannot be sent" }] });
  }
  if (priceMinor % 100n !== 0n) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "price", rule: "TaxCloud's price is dollars and cents; a sub-cent price must be rounded before it is sent" }],
    });
  }
  const cents = priceMinor / 100n;
  const text = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  const value = Number(text);
  if (Number.isFinite(value) === false || taxCloudMinorOfAmount(value) !== priceMinor) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "price", rule: "this price cannot be sent as an exact JSON number, so it is refused rather than rounded" }],
    });
  }
  return value;
}

/* -------------------------------------------------------------------------------------------------
 * What the pages leave open
 * ---------------------------------------------------------------------------------------------- */

/** One question the documentation read here does not answer. */
export interface TaxCloudOpenQuestion {
  readonly id: string;
  readonly question: string;
  readonly why: string;
}

/**
 * The questions this record cannot answer, kept where the next STEP will look.
 *
 * Naming them is part of the work: an adapter that quietly guesses at these is the adapter that produces a wrong
 * filing six months later.
 */
export const TAXCLOUD_OPEN_QUESTIONS: readonly TaxCloudOpenQuestion[] = deepFreeze([
  {
    id: "test_and_live_data_separation",
    question: "How do two connections of the same account keep their data apart beyond the connection ID?",
    why:
      "The testing page says the connection ID decides the environment and that certificates and settings do not transfer between connections, but the pages read here never state whether the account's nexus and profile are shared. This platform therefore treats the mode as a recorded label and never as a sandbox.",
  },
  {
    id: "api_key_format",
    question: "Does a TaxCloud API key have a promised format?",
    why:
      "The pages show a UUID-shaped key in an example and say only to copy the value, so this platform checks length and character class rather than a pattern it would be inventing.",
  },
  {
    id: "rounding_with_fractional_quantity",
    question: "How is a line amount rounded when the quantity is fractional?",
    why:
      "The reference examples include quantity 1.5 and a tax of 1.31 on a price of 10.75, but no page read here states a rounding rule, so this platform stores TaxCloud's amount and never recomputes it.",
  },
  {
    id: "rate_limits",
    question: "What are the published request limits and is Retry-After sent on 429?",
    why:
      "429 is documented for every endpoint and 503 with Retry-After only on TIC search, so the client honours Retry-After when it appears and otherwise backs off exponentially.",
  },
  {
    id: "no_push_notification",
    question: "Is there any callback or webhook for order or refund state?",
    why:
      "No page read here documents one, so this platform reads state with GET /carts/{cartId} and GET /orders/{orderId} and never waits for a push.",
  },
  {
    id: "request_timeout",
    question: "What request timeout and retry ceiling does TaxCloud expect?",
    why: "No page states one, so the client applies its own timeout and its own bounded backoff rather than claiming a documented value.",
  },
  {
    id: "filing_reports_in_api",
    question: "Are filing reports and collected-tax totals available through the API?",
    why:
      "The pages describe reports in the TaxCloud dashboard; this platform therefore keeps its own per-merchant and platform totals (STEP 180) and treats TaxCloud's numbers as the authority to reconcile against.",
  },
  {
    id: "exemption_auto_match",
    question: "When auto-match finds no certificate, is the transaction still filed as exempt?",
    why:
      "The exemptions page says the order is marked exempt with no certificate attached and calls that a reporting gap, which means the platform must attach a certificate id rather than rely on the match.",
  },
]);
