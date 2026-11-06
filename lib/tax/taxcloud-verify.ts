// path: lib/tax/taxcloud-verify.ts

/**
 * The gate for the TaxCloud documentation record and connection design.
 *
 * Run directly, because the ownership rule keeps `package.json` out of these STEPs' hands:
 *
 *   node lib/tax/taxcloud-verify.ts
 *
 * Twelve sections: the one host, the pages read, the rules those pages produced, the endpoints and their paths, the
 * headers and the request, the failure table, the connection test, the draft, the stored connection, the collection
 * gate, masking and amounts, and the source itself.
 *
 * Nothing here reaches the network. The request builder is the only thing that looks like a client, and it builds
 * strings a test can read.
 */

import { readFileSync } from "node:fs";
import { AppError } from "../errors/app-error.ts";
import {
  TAXCLOUD_API_BASE,
  TAXCLOUD_API_KEY_MAXIMUM_LENGTH,
  TAXCLOUD_API_KEY_MINIMUM_LENGTH,
  TAXCLOUD_API_VERSION,
  TAXCLOUD_AMOUNT_UNIT,
  TAXCLOUD_AUTH_HEADER,
  TAXCLOUD_CONNECTION_MODES,
  TAXCLOUD_CONNECTION_STATUSES,
  TAXCLOUD_CONTENT_TYPE,
  TAXCLOUD_DASHBOARD_URL,
  TAXCLOUD_DOCUMENTATION_READ_ON,
  TAXCLOUD_DOCUMENTATION_SOURCES,
  TAXCLOUD_ENDPOINTS,
  TAXCLOUD_FAILURE_OUTCOMES,
  TAXCLOUD_FAILURE_RULES,
  TAXCLOUD_OPEN_QUESTIONS,
  TAXCLOUD_PING_OUTCOMES,
  TAXCLOUD_PROBLEM_STATUSES,
  TAXCLOUD_PROVIDER_KEY,
  TAXCLOUD_PROVIDER_NAME,
  TAXCLOUD_RECORDED_RULES,
  TAXCLOUD_REFUSED_AUTH_HEADER,
  TAXCLOUD_REFUSED_HOSTS,
  TAXCLOUD_SANDBOX_BASE,
  isTaxCloudApiBase,
  isTaxCloudCollectionEnabled,
  isTaxCloudConnectionId,
  isTaxCloudConnectionMode,
  isTaxCloudDocumentationUrl,
  maskTaxCloudApiKey,
  requireTaxCloudConnectionId,
  taxCloudApiKeyProblemOf,
  taxCloudBaseProblemOf,
  taxCloudCollectionProblemOf,
  taxCloudConnectionDraftProblemOf,
  taxCloudConnectionProblemOf,
  taxCloudConnectionViewOf,
  taxCloudFailureOf,
  taxCloudHeadersOf,
  taxCloudMinorOfAmount,
  taxCloudPathOf,
  taxCloudPingMessageOf,
  taxCloudPingOutcomeOf,
  taxCloudPriceOf,
  taxCloudProblemOf,
  taxCloudRequestOf,
  taxCloudUrlOf,
} from "./taxcloud.ts";
import type {
  TaxCloudConnection,
  TaxCloudConnectionDraft,
  TaxCloudEndpointName,
  TaxCloudPingOutcome,
} from "./taxcloud.ts";

/* ---- the checking harness, the same shape STEPs 170 to 175 used ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, name: string): void {
  checks += 1;
  if (condition !== true) failures.push(name);
}

function expectEqual(actual: unknown, expected: unknown, name: string): void {
  checks += 1;
  if (actual !== expected) failures.push(`${name} (read ${asText(actual)}, wanted ${asText(expected)})`);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || value === null) return String(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function errorCodeOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    return error instanceof AppError ? error.code : "not_an_app_error";
  }
}

function errorRuleOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    if (error instanceof AppError) return error.details[0]?.rule ?? "no_rule";
    return "not_an_app_error";
  }
}

function errorFieldOf(action: () => void): string {
  try {
    action();
    return "no_error";
  } catch (error) {
    if (error instanceof AppError) return error.details[0]?.field ?? "no_detail";
    return "not_an_app_error";
  }
}

/* ---- fixtures ---- */

const CONNECTION_ID = "25eb9b97-5acb-492d-b720-c03e79cf715a";
const OTHER_CONNECTION_ID = "2f9a1d0e-ab12-4bcd-8f09-456789e0cdef";
const COMPANY = "company_kd_taxcloud_gate";
const NOW = 1_779_000_000_000;
const API_KEY = "9f7c1e2a-4b6d-4f80-9a1c-3d5e7f9b1c2d";

function draftOf(overrides: Partial<TaxCloudConnectionDraft> = {}): TaxCloudConnectionDraft {
  return { companyId: COMPANY, mode: "live", connectionId: CONNECTION_ID, apiKey: API_KEY, ...overrides };
}

function connectionOf(overrides: Partial<TaxCloudConnection> = {}): TaxCloudConnection {
  return {
    id: "row_taxcloud_0001",
    companyId: COMPANY,
    mode: "live",
    connectionId: CONNECTION_ID,
    apiKeySealed: "kd1.k1.aXY.dGFn.Y2lwaGVydGV4dA",
    status: "verified",
    verifiedAtEpochMs: NOW - 60_000,
    lastPingAtEpochMs: NOW - 60_000,
    lastPingOutcome: "verified",
    version: 3,
    createdAtEpochMs: NOW - 600_000,
    updatedAtEpochMs: NOW - 60_000,
    ...overrides,
  };
}

/* ---- section 1: the one host ---- */

function checkHosts(): void {
  expectEqual(TAXCLOUD_PROVIDER_KEY, "taxcloud", "the provider key is taxcloud");
  expectEqual(TAXCLOUD_PROVIDER_NAME, "TaxCloud", "the provider name is TaxCloud");
  expectEqual(TAXCLOUD_API_VERSION, "v3", "the recorded API generation is v3");
  expectEqual(TAXCLOUD_API_BASE, "https://api.v3.taxcloud.com", "the recorded base is the documented one");
  expectEqual(TAXCLOUD_SANDBOX_BASE, null, "TaxCloud documents no sandbox base");
  expectEqual(TAXCLOUD_DASHBOARD_URL, "https://app.taxcloud.com", "the dashboard is named for refusals only");

  expectEqual(isTaxCloudApiBase(TAXCLOUD_API_BASE), true, "the documented base is accepted");
  expectEqual(isTaxCloudApiBase(`${TAXCLOUD_API_BASE}/`), true, "a trailing slash is the same base");
  expectEqual(isTaxCloudApiBase(` ${TAXCLOUD_API_BASE}  `), true, "surrounding space is the same base");
  expectEqual(isTaxCloudApiBase(`${TAXCLOUD_API_BASE}${TAXCLOUD_API_BASE}`), false, "two bases glued together are not a base");
  expectEqual(taxCloudBaseProblemOf(TAXCLOUD_API_BASE), null, "the documented base has no problem");

  // The v1 hosts and the dashboard are refused by name, and the refusal says where the API actually is.
  for (const host of ["api.taxcloud.net", "api.taxcloud.com", "app.taxcloud.com", "docs.taxcloud.com", "taxcloud.net", "www.taxcloud.net", "www.taxcloud.com"]) {
    expectEqual(TAXCLOUD_REFUSED_HOSTS.includes(host), true, `${host} is on the refused list`);
    expectEqual(isTaxCloudApiBase(`https://${host}`), false, `${host} is not the base`);
    const problem = taxCloudBaseProblemOf(`https://${host}`);
    expect(problem !== null && problem.includes("api.v3.taxcloud.com"), `${host} is refused with the real host named`);
  }
  expectEqual(taxCloudBaseProblemOf("http://api.v3.taxcloud.com"), "TaxCloud is only spoken to over https", "plain http is refused");
  expectEqual(taxCloudBaseProblemOf("https://api.v3.taxcloud.com.evil.example"), "only https://api.v3.taxcloud.com is the documented API base", "a lookalike host is refused");
  expectEqual(taxCloudBaseProblemOf("not a url"), "that is not a URL", "a non-URL is refused");
  expectEqual(taxCloudBaseProblemOf(""), "a TaxCloud connection needs an API base", "an empty base is refused");
  expectEqual(taxCloudBaseProblemOf("https://api.v3.taxcloud.com/tax"), "only https://api.v3.taxcloud.com is the documented API base", "a base with a path is refused");

  // Every documented endpoint lives on the one base.
  for (const name of Object.keys(TAXCLOUD_ENDPOINTS) as TaxCloudEndpointName[]) {
    const endpoint = TAXCLOUD_ENDPOINTS[name];
    expectEqual(endpoint.path.startsWith("/tax/"), true, `the path of ${name} is under /tax/`);
    const url = endpoint.scope === "connection" ? taxCloudUrlOf(name, { connectionId: CONNECTION_ID, cartId: "cart-1", orderId: "order-1" }) : taxCloudUrlOf(name);
    expectEqual(url.startsWith(TAXCLOUD_API_BASE), true, `the URL of ${name} is on the documented base`);
    expectEqual(url.includes("api.taxcloud.net"), false, `the URL of ${name} is not the v1 host`);
    expectEqual(url.includes("api.taxcloud.com"), false, `the URL of ${name} is not the v1 path host`);
  }
}

/* ---- section 2: the pages read ---- */

function checkSources(): void {
  expectEqual(TAXCLOUD_DOCUMENTATION_READ_ON, "2026-11-07", "the session date is recorded");
  expect(TAXCLOUD_DOCUMENTATION_SOURCES.length >= 15, "at least fifteen pages are recorded");
  const topics = new Set<string>();
  for (const source of TAXCLOUD_DOCUMENTATION_SOURCES) {
    expectEqual(source.status, "reviewed", `the page on ${source.topic} is recorded as reviewed`);
    expectEqual(source.host, "docs.taxcloud.com", `the page on ${source.topic} lives on the documentation host`);
    expectEqual(source.url.startsWith("https://docs.taxcloud.com/"), true, `the page on ${source.topic} is https`);
    expectEqual(isTaxCloudDocumentationUrl(source.url), true, `the URL of ${source.topic} is a documentation URL`);
    expect(source.recorded.length >= 60, `the page on ${source.topic} records what it settled`);
    expect(topics.has(source.topic) === false, `the topic ${source.topic} is recorded once`);
    topics.add(source.topic);
  }
  const urls = TAXCLOUD_DOCUMENTATION_SOURCES.map((source) => source.url).join(" ");
  for (const required of [
    "setup-and-authentication",
    "testing-and-going-live",
    "migrating-from-api-v-1-to-v-3",
    "cart/create-cart",
    "utilities/ping",
    "health",
    "refunds/refund-order",
    "managing-tax-exemptions",
    "handling-errors",
    "convert-carts-to-orders",
  ]) {
    expectEqual(urls.includes(required), true, `the page ${required} is among the sources`);
  }
  expectEqual(isTaxCloudDocumentationUrl("https://docs.taxcloud.net/guides"), false, "the .net documentation lookalike is refused");
  expectEqual(isTaxCloudDocumentationUrl("http://docs.taxcloud.com/guides"), false, "plain http documentation is refused");
  expectEqual(isTaxCloudDocumentationUrl("https://taxcloud.com/blog"), false, "the marketing site is not documentation");
  expectEqual(isTaxCloudDocumentationUrl("https://docs.taxcloud.com.evil.example/x"), false, "a lookalike documentation host is refused");
  expectEqual(isTaxCloudDocumentationUrl("not a url"), false, "a non-URL is not documentation");
}

/* ---- section 3: the rules ---- */

function checkRules(): void {
  expect(TAXCLOUD_RECORDED_RULES.length >= 12, "at least twelve rules are recorded");
  const ids = new Set<string>();
  for (const rule of TAXCLOUD_RECORDED_RULES) {
    expect(rule.id.length > 0, "a rule has an id");
    expect(rule.rule.length >= 30, `the rule ${rule.id} states the rule`);
    expect(rule.reason.length >= 40, `the rule ${rule.id} states why`);
    expectEqual(isTaxCloudDocumentationUrl(rule.source), true, `the rule ${rule.id} cites a documentation page`);
    expect(ids.has(rule.id) === false, `the rule id ${rule.id} is unique`);
    ids.add(rule.id);
  }
  for (const id of [
    "one_host_no_sandbox",
    "key_in_header",
    "connection_in_path",
    "price_is_a_number",
    "amount_is_authoritative",
    "zero_tax_is_an_answer",
    "tic_on_every_line",
    "cart_is_an_upsert",
    "order_id_unique_per_connection",
    "completion_creates_liability",
    "refund_prices_are_taxclouds",
    "no_webhook",
    "retry_by_status",
  ]) {
    expectEqual(ids.has(id), true, `the rule ${id} is recorded`);
  }
  const sandboxRule = TAXCLOUD_RECORDED_RULES.find((rule) => rule.id === "one_host_no_sandbox");
  expect(sandboxRule !== undefined && sandboxRule.rule.includes("https://api.v3.taxcloud.com"), "the sandbox rule names the one host");
  const keyRule = TAXCLOUD_RECORDED_RULES.find((rule) => rule.id === "key_in_header");
  expect(keyRule !== undefined && keyRule.rule.includes("X-API-KEY"), "the key rule names the header");
  expect(keyRule !== undefined && keyRule.rule.includes("never in a URL"), "the key rule forbids the key in a URL");
  expect(TAXCLOUD_OPEN_QUESTIONS.length >= 6, "at least six open questions are recorded");
  for (const question of TAXCLOUD_OPEN_QUESTIONS) {
    expect(question.id.length > 0 && question.question.length >= 20 && question.why.length >= 40, `the open question ${question.id} says what and why`);
  }
  expectEqual(new Set(TAXCLOUD_OPEN_QUESTIONS.map((question) => question.id)).size, TAXCLOUD_OPEN_QUESTIONS.length, "open question ids are unique");
  expectEqual(
    TAXCLOUD_OPEN_QUESTIONS.some((question) => question.id === "test_and_live_data_separation"),
    true,
    "the test and live separation question is recorded",
  );
}

/* ---- section 4: endpoints and paths ---- */

function checkEndpoints(): void {
  const documented: readonly (readonly [TaxCloudEndpointName, string, string])[] = [
    ["health", "GET", "/tax/health"],
    ["ping", "GET", "/tax/connections/{connectionId}/ping"],
    ["carts", "POST", "/tax/connections/{connectionId}/carts"],
    ["cart", "GET", "/tax/connections/{connectionId}/carts/{cartId}"],
    ["cartOrders", "POST", "/tax/connections/{connectionId}/carts/orders"],
    ["orders", "POST", "/tax/connections/{connectionId}/orders"],
    ["order", "GET", "/tax/connections/{connectionId}/orders/{orderId}"],
    ["orderUpdate", "PATCH", "/tax/connections/{connectionId}/orders/{orderId}"],
    ["refunds", "POST", "/tax/connections/{connectionId}/orders/refunds/{orderId}"],
    ["exemptionCertificates", "POST", "/tax/connections/{connectionId}/exemption-certificates"],
    ["verifyAddress", "POST", "/tax/verify-address"],
    ["ticSearch", "POST", "/tax/tic/search"],
  ];
  for (const [name, method, path] of documented) {
    expectEqual(TAXCLOUD_ENDPOINTS[name].method, method, `the method of ${name} is ${method}`);
    expectEqual(TAXCLOUD_ENDPOINTS[name].path, path, `the path of ${name} is the documented one`);
  }
  expectEqual(TAXCLOUD_ENDPOINTS.health.scope, "global", "health is not scoped to a connection");
  expectEqual(TAXCLOUD_ENDPOINTS.verifyAddress.scope, "global", "address verification is not scoped to a connection");
  expectEqual(TAXCLOUD_ENDPOINTS.ping.scope, "connection", "ping is scoped to a connection");

  expectEqual(taxCloudPathOf("ping", { connectionId: CONNECTION_ID }), `/tax/connections/${CONNECTION_ID}/ping`, "ping's path is built from the connection");
  expectEqual(
    taxCloudPathOf("refunds", { connectionId: CONNECTION_ID, orderId: "order-2021" }),
    `/tax/connections/${CONNECTION_ID}/orders/refunds/order-2021`,
    "the refund path keeps its documented segment order",
  );
  expectEqual(taxCloudUrlOf("health"), `${TAXCLOUD_API_BASE}/tax/health`, "health's URL is the base and the path");
  expectEqual(taxCloudPathOf("verifyAddress"), "/tax/verify-address", "a global path needs no connection");

  expectEqual(isTaxCloudConnectionId(CONNECTION_ID), true, "a UUID connection id is accepted");
  expectEqual(isTaxCloudConnectionId(CONNECTION_ID.toUpperCase()), true, "a UUID in capitals is accepted");
  expectEqual(isTaxCloudConnectionId("25eb9b97-5acb-492d-b720-c03e79cf715"), false, "a short UUID is refused");
  expectEqual(isTaxCloudConnectionId("not-a-uuid"), false, "a name is not a connection id");
  expectEqual(isTaxCloudConnectionId(""), false, "an empty string is not a connection id");
  expectEqual(requireTaxCloudConnectionId(` ${CONNECTION_ID.toUpperCase()} `), CONNECTION_ID, "the required id is trimmed and lowered");

  expectEqual(errorCodeOf(() => taxCloudPathOf("ping")), "VALIDATION_FAILED", "a connection endpoint with no connection id is refused");
  expectEqual(errorFieldOf(() => taxCloudPathOf("ping")), "connectionId", "the refusal names the connection id");
  expectEqual(errorCodeOf(() => taxCloudPathOf("ping", { connectionId: "nope" })), "VALIDATION_FAILED", "a non-UUID connection id is refused");
  expectEqual(errorCodeOf(() => taxCloudPathOf("cart", { connectionId: CONNECTION_ID })), "VALIDATION_FAILED", "a cart path with no cart id is refused");
  expectEqual(errorFieldOf(() => taxCloudPathOf("order", { connectionId: CONNECTION_ID })), "orderId", "the refusal names the order id");

  // Path injection is refused rather than encoded: a caller's value must not choose the endpoint.
  for (const value of ["../orders", "cart/../x", "cart?x=1", "cart#f", "a b", "cart\n", "x".repeat(201), "", "  "]) {
    expectEqual(errorCodeOf(() => taxCloudPathOf("cart", { connectionId: CONNECTION_ID, cartId: value })), "VALIDATION_FAILED", `the cart id ${JSON.stringify(value)} is refused`);
  }
  for (const value of ["order-1", "ORDER_1", "order.1", "a~b", "0"]) {
    expectEqual(errorCodeOf(() => taxCloudPathOf("order", { connectionId: CONNECTION_ID, orderId: value })), "no_error", `the order id ${value} is accepted`);
  }
  expectEqual(taxCloudPathOf("order", { connectionId: CONNECTION_ID, orderId: "order-1" }).includes("order-1"), true, "an accepted id appears in the path");

  // No endpoint carries the key, a query string or a v1 method name.
  for (const name of Object.keys(TAXCLOUD_ENDPOINTS) as TaxCloudEndpointName[]) {
    const path = TAXCLOUD_ENDPOINTS[name].path;
    expectEqual(path.includes("?"), false, `the path of ${name} carries no query string`);
    expectEqual(path.includes("apiKey"), false, `the path of ${name} carries no key`);
    expectEqual(/Lookup|Authorized|Captured|Returned/u.test(path), false, `the path of ${name} is not a v1 method name`);
  }
}

/* ---- section 5: headers and the request ---- */

function checkRequest(): void {
  expectEqual(TAXCLOUD_AUTH_HEADER, "X-API-KEY", "the documented header is used");
  expectEqual(TAXCLOUD_CONTENT_TYPE, "application/json", "the documented content type is used");
  expectEqual(TAXCLOUD_REFUSED_AUTH_HEADER, "Authorization", "the refused alternative is named");

  expectEqual(taxCloudApiKeyProblemOf(API_KEY), null, "a well-formed key has no problem");
  expectEqual(taxCloudApiKeyProblemOf(""), "a TaxCloud connection needs an API key", "an empty key is refused");
  expectEqual(taxCloudApiKeyProblemOf("   "), "a TaxCloud connection needs an API key", "a blank key is refused");
  expectEqual(taxCloudApiKeyProblemOf("short"), "that key is shorter than any value TaxCloud issues", "a short key is refused");
  expectEqual(taxCloudApiKeyProblemOf("a".repeat(TAXCLOUD_API_KEY_MAXIMUM_LENGTH + 1)), "that key is longer than this platform stores", "an over-long key is refused");
  expectEqual(taxCloudApiKeyProblemOf(`${API_KEY} ${API_KEY}`), "an API key contains no whitespace", "a key with a space is refused");
  expectEqual(taxCloudApiKeyProblemOf("a".repeat(TAXCLOUD_API_KEY_MINIMUM_LENGTH)), null, "the shortest key is accepted");
  expectEqual(taxCloudApiKeyProblemOf("a".repeat(TAXCLOUD_API_KEY_MAXIMUM_LENGTH)), null, "the longest key is accepted");

  const getHeaders = taxCloudHeadersOf(API_KEY);
  expectEqual(getHeaders[TAXCLOUD_AUTH_HEADER], API_KEY, "the key is in the X-API-KEY header");
  expectEqual(getHeaders["Accept"], "application/json", "the accept header is JSON");
  expectEqual(getHeaders["Content-Type"], undefined, "a bodyless call sends no content type");
  expectEqual(Object.keys(getHeaders).includes("Authorization"), false, "no Authorization header is sent");
  expectEqual(Object.keys(getHeaders).includes("authorization"), false, "no lowercase authorization header is sent");
  expectEqual(Object.isFrozen(getHeaders), true, "the headers are frozen");
  const postHeaders = taxCloudHeadersOf(API_KEY, { hasBody: true });
  expectEqual(postHeaders["Content-Type"], "application/json", "a call with a body sends the JSON content type");
  expectEqual(errorCodeOf(() => taxCloudHeadersOf("")), "VALIDATION_FAILED", "a header with no key is refused");
  expectEqual(errorFieldOf(() => taxCloudHeadersOf("")), "apiKey", "the refusal names the key");

  const ping = taxCloudRequestOf({ endpoint: "ping", params: { connectionId: CONNECTION_ID }, apiKey: API_KEY });
  expectEqual(ping.method, "GET", "a ping is a GET");
  expectEqual(ping.body, null, "a ping has no body");
  expectEqual(ping.url, `${TAXCLOUD_API_BASE}/tax/connections/${CONNECTION_ID}/ping`, "the ping URL is the documented one");
  expectEqual(ping.url.includes(API_KEY), false, "the key is not in the URL");
  expectEqual(ping.headers[TAXCLOUD_AUTH_HEADER], API_KEY, "the ping carries the key in its header");
  expectEqual(Object.keys(ping.headers).includes("Content-Type"), false, "the ping carries no content type");

  const cart = taxCloudRequestOf({
    endpoint: "carts",
    params: { connectionId: CONNECTION_ID },
    apiKey: API_KEY,
    body: { items: [{ customerId: "customer-453", cartId: "cart-1" }] },
  });
  expectEqual(cart.method, "POST", "a cart calculation is a POST");
  expect(cart.body !== null && cart.body.includes("customer-453"), "the body is serialised as JSON text");
  expect(cart.body !== null && cart.body.includes(API_KEY) === false, "the key is not in the body");
  expectEqual(cart.headers["Content-Type"], "application/json", "the POST carries the content type");
  expectEqual(errorCodeOf(() => taxCloudRequestOf({ endpoint: "ping", params: { connectionId: CONNECTION_ID }, apiKey: API_KEY, body: {} })), "VALIDATION_FAILED", "a GET with a body is refused");
  expectEqual(errorFieldOf(() => taxCloudRequestOf({ endpoint: "ping", params: { connectionId: CONNECTION_ID }, apiKey: API_KEY, body: {} })), "body", "the refusal names the body");

  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  expectEqual(errorCodeOf(() => taxCloudRequestOf({ endpoint: "carts", params: { connectionId: CONNECTION_ID }, apiKey: API_KEY, body: circular })), "VALIDATION_FAILED", "a body that cannot be serialised is refused");
  expectEqual(errorCodeOf(() => taxCloudRequestOf({ endpoint: "ping", params: { connectionId: CONNECTION_ID }, apiKey: "short" })), "VALIDATION_FAILED", "a request with a bad key is refused before it is built");
  expectEqual(errorCodeOf(() => taxCloudRequestOf({ endpoint: "ping", apiKey: API_KEY })), "VALIDATION_FAILED", "a request with no connection id is refused");
  expectEqual(taxCloudRequestOf({ endpoint: "health", apiKey: API_KEY }).url, `${TAXCLOUD_API_BASE}/tax/health`, "a global request needs no connection");
}

/* ---- section 6: failures ---- */

function checkFailures(): void {
  expectEqual(TAXCLOUD_PROBLEM_STATUSES.join(","), "400,401,403,404,422,429,500,503", "the documented statuses are recorded");
  expectEqual(TAXCLOUD_FAILURE_OUTCOMES.length, 9, "nine failure outcomes are recorded");
  expectEqual(TAXCLOUD_FAILURE_RULES.length, TAXCLOUD_PROBLEM_STATUSES.length, "every documented status has a rule");
  const retryable: number[] = [];
  const permanent: number[] = [];
  for (const rule of TAXCLOUD_FAILURE_RULES) {
    expect(TAXCLOUD_FAILURE_OUTCOMES.includes(rule.outcome), `the outcome of ${rule.status} is a recorded one`);
    expect(rule.officeMessage.length >= 30, `the rule for ${rule.status} has an office sentence`);
    expectEqual(TAXCLOUD_PROBLEM_STATUSES.includes(rule.status as (typeof TAXCLOUD_PROBLEM_STATUSES)[number]), true, `the rule status ${rule.status} is documented`);
    if (rule.retryable) retryable.push(rule.status);
    else permanent.push(rule.status);
  }
  expectEqual(retryable.join(","), "429,500,503", "only the temporary statuses are retried");
  expectEqual(permanent.join(","), "400,401,403,404,422", "the permanent statuses are not retried");

  const codes = new Map<number, string>();
  for (const rule of TAXCLOUD_FAILURE_RULES) codes.set(rule.status, rule.code);
  expectEqual(codes.get(400), "VALIDATION_FAILED", "a malformed body is a validation failure");
  expectEqual(codes.get(401), "DEPENDENCY_FAILED", "a wrong key is a dependency failure");
  expectEqual(codes.get(404), "RESOURCE_NOT_FOUND", "a wrong connection is not found");
  expectEqual(codes.get(422), "VALIDATION_FAILED", "an unprocessable body is a validation failure");
  expectEqual(codes.get(429), "RATE_LIMITED", "too many requests is rate limited");
  expectEqual(codes.get(500), "SERVICE_UNAVAILABLE", "a provider fault is unavailable");
  expectEqual(codes.get(503), "SERVICE_UNAVAILABLE", "a temporarily unavailable service is unavailable");

  const unauthorized = taxCloudFailureOf(401, { title: "Unauthorized", detail: "bad key", status: 401 });
  expectEqual(unauthorized.outcome, "unauthorized", "401 is read as unauthorized");
  expectEqual(unauthorized.retryable, false, "401 is not retried");
  expectEqual(unauthorized.detail, "bad key", "the documented detail is carried");
  expectEqual(unauthorized.code, "DEPENDENCY_FAILED", "401 maps to a dependency failure");

  const unprocessable = taxCloudFailureOf(422, {
    title: "Unprocessable Entity",
    status: 422,
    detail: "destination address is incomplete",
    errors: [
      { location: "body.items[0].destination.zip", message: "is required" },
      { location: "body.items[0].exemption", message: "is required" },
    ],
  });
  expectEqual(unprocessable.outcome, "unprocessable", "422 is read as unprocessable");
  expectEqual(unprocessable.problems.length, 2, "both documented error details are carried");
  expectEqual(unprocessable.problems[0]?.location, "body.items[0].destination.zip", "the first location is carried");
  expectEqual(unprocessable.problems[1]?.message, "is required", "the second message is carried");

  const providerError = taxCloudFailureOf(500, { title: "Internal Server Error" });
  expectEqual(providerError.retryable, true, "500 is retried");
  expectEqual(providerError.outcome, "provider_error", "500 is a provider error");
  const rateLimited = taxCloudFailureOf(429, null);
  expectEqual(rateLimited.retryable, true, "429 is retried");
  expectEqual(rateLimited.detail, null, "a missing body leaves no detail");
  const unavailable = taxCloudFailureOf(503, { detail: "search service down" });
  expectEqual(unavailable.outcome, "unavailable", "503 is read as unavailable");
  expectEqual(unavailable.retryable, true, "503 is retried");

  const unexpectedStatus = taxCloudFailureOf(418, { title: "I am a teapot" });
  expectEqual(unexpectedStatus.outcome, "unexpected", "an undocumented status is unexpected");
  expectEqual(unexpectedStatus.retryable, false, "an undocumented status is not retried");
  expectEqual(unexpectedStatus.code, "DEPENDENCY_FAILED", "an undocumented status is a dependency failure");
  expectEqual(taxCloudFailureOf(200).outcome, "unexpected", "a success status is not a failure the table knows");

  // The problem body is read defensively.
  expectEqual(taxCloudProblemOf(null).title, null, "a null body has no title");
  expectEqual(taxCloudProblemOf("a string").detail, null, "a string body has no detail");
  expectEqual(taxCloudProblemOf([1, 2, 3]).errors.length, 0, "an array body has no errors");
  expectEqual(taxCloudProblemOf({ status: "401" }).status, null, "a string status is not a status");
  expectEqual(taxCloudProblemOf({ status: 401.5 }).status, null, "a fractional status is not a status");
  expectEqual(taxCloudProblemOf({ status: 401 }).status, 401, "an integer status is carried");
  expectEqual(taxCloudProblemOf({ errors: "nope" }).errors.length, 0, "a non-list errors field is ignored");
  expectEqual(taxCloudProblemOf({ errors: [null, 1, { location: 5, message: "x" }] }).errors.length, 1, "only object errors are kept");
  expectEqual(taxCloudProblemOf({ errors: [null, 1, { location: 5, message: "x" }] }).errors[0]?.location, null, "a non-string location is null");
  expectEqual(taxCloudProblemOf({ errors: [{ message: "kept" }] }).errors[0]?.message, "kept", "a string message is carried");
  expectEqual(taxCloudProblemOf({}).errors.length, 0, "an empty object has no errors");
}

/* ---- section 7: the connection test ---- */

function checkPing(): void {
  expectEqual(TAXCLOUD_PING_OUTCOMES.join(","), "verified,unauthorized,connection_not_found,unreachable,unexpected", "the five ping outcomes are recorded");
  const cases: readonly (readonly [number, TaxCloudPingOutcome])[] = [
    [200, "verified"],
    [401, "unauthorized"],
    [404, "connection_not_found"],
    [429, "unreachable"],
    [500, "unreachable"],
    [503, "unreachable"],
    [403, "unexpected"],
    [418, "unexpected"],
    [201, "unexpected"],
  ];
  for (const [status, outcome] of cases) {
    expectEqual(taxCloudPingOutcomeOf(status), outcome, `a ping answering ${status} is ${outcome}`);
  }
  const messages = new Set<string>();
  for (const outcome of TAXCLOUD_PING_OUTCOMES) {
    const message = taxCloudPingMessageOf(outcome);
    expect(message.length >= 30, `the ${outcome} ping has an office sentence`);
    expect(messages.has(message) === false, `the ${outcome} sentence is not another outcome's`);
    messages.add(message);
  }
  expect(taxCloudPingMessageOf("unauthorized").includes("401"), "the unauthorized sentence names the documented status");
  expect(taxCloudPingMessageOf("unauthorized").includes("X-API-KEY"), "the unauthorized sentence names the header");
  expect(taxCloudPingMessageOf("connection_not_found").includes("404"), "the not-found sentence names the documented status");
  expect(taxCloudPingMessageOf("connection_not_found").includes("connection ID"), "the not-found sentence names the connection");
  expect(taxCloudPingMessageOf("unreachable").includes("nothing is known"), "the unreachable sentence decides nothing about credentials");
  expect(taxCloudPingMessageOf("verified").includes("accepted"), "the verified sentence says the key was accepted");
}

/* ---- section 8: the draft ---- */

function checkDraft(): void {
  expectEqual(TAXCLOUD_CONNECTION_MODES.join(","), "test,live", "the two modes are test and live");
  expectEqual(isTaxCloudConnectionMode("live"), true, "live is a mode");
  expectEqual(isTaxCloudConnectionMode("test"), true, "test is a mode");
  expectEqual(isTaxCloudConnectionMode("sandbox"), false, "sandbox is not a mode");
  expectEqual(isTaxCloudConnectionMode(""), false, "an empty string is not a mode");
  expectEqual(isTaxCloudConnectionMode("LIVE"), false, "modes are lower case");

  expectEqual(taxCloudConnectionDraftProblemOf(draftOf()), null, "a well-formed draft has no problem");
  expectEqual(taxCloudConnectionDraftProblemOf(draftOf({ mode: "test" })), null, "a test draft is accepted");
  expectEqual(taxCloudConnectionDraftProblemOf(draftOf({ companyId: "  " })), "a connection belongs to a company", "a blank company is refused");
  const sandbox = taxCloudConnectionDraftProblemOf(draftOf({ mode: "sandbox" as TaxCloudConnectionDraft["mode"] }));
  expect(sandbox !== null && sandbox.includes("no sandbox host"), "the sandbox refusal explains there is no sandbox");
  expect(sandbox !== null && sandbox.includes("separate connection"), "the sandbox refusal explains what to do instead");
  expectEqual(taxCloudConnectionDraftProblemOf(draftOf({ connectionId: "nope" })), "the connection ID is the UUID-shaped value the TaxCloud dashboard shows under Integrations", "a bad connection id is refused");
  expectEqual(taxCloudConnectionDraftProblemOf(draftOf({ connectionId: OTHER_CONNECTION_ID })), null, "another UUID is accepted");
  expectEqual(taxCloudConnectionDraftProblemOf(draftOf({ apiKey: "short" })), "that key is shorter than any value TaxCloud issues", "a short key is refused");
  expectEqual(taxCloudConnectionDraftProblemOf(draftOf({ apiKey: "" })), "a TaxCloud connection needs an API key", "an empty key is refused");
  const tabbedKey = taxCloudConnectionDraftProblemOf(draftOf({ apiKey: `${API_KEY}\t` }));
  expect(tabbedKey === null || tabbedKey.includes("key is shorter") === false, "a key with a tab is not accepted as a short key");
}

/* ---- section 9: the stored connection ---- */

function checkConnection(): void {
  expectEqual(TAXCLOUD_CONNECTION_STATUSES.join(","), "unverified,verified,failed,revoked", "the four statuses are recorded");
  expectEqual(taxCloudConnectionProblemOf(connectionOf()), null, "a verified live connection is well-formed");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ mode: "test" })), null, "a verified test connection is well-formed");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ id: "" })), "a connection needs a row id", "a blank row id is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ companyId: "" })), "a connection belongs to a company", "a blank company is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ mode: "sandbox" as TaxCloudConnection["mode"] })), "a connection is either test or live", "a stored row with a third mode is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ connectionId: "nope" })), "the connection ID is the UUID-shaped value TaxCloud shows", "a stored row with a bad connection id is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ apiKeySealed: " " })), "a connection needs a sealed API key", "a stored row with no sealed key is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ status: "active" as TaxCloudConnection["status"] })), "a connection status is unverified, verified, failed or revoked", "a status outside the four is refused");
  expectEqual(
    taxCloudConnectionProblemOf(connectionOf({ verifiedAtEpochMs: null })),
    "a verified connection records when the ping verified it",
    "a verified row with no instant is refused",
  );
  expectEqual(
    taxCloudConnectionProblemOf(connectionOf({ lastPingOutcome: "unexpected" })),
    "a verified connection was verified by a ping, not by a typed status",
    "a verified row whose last ping was not a success is refused",
  );
  expectEqual(
    taxCloudConnectionProblemOf(connectionOf({ lastPingOutcome: "teapot" as TaxCloudConnection["lastPingOutcome"] })),
    "a ping outcome is one of the five this platform records",
    "an unrecorded ping outcome is refused",
  );
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ lastPingAtEpochMs: -1 })), "a ping instant is a positive whole number of milliseconds", "a negative ping instant is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ version: 0 })), "a connection has a whole version of at least one", "version zero is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ version: 1.5 })), "a connection has a whole version of at least one", "a fractional version is refused");
  expectEqual(taxCloudConnectionProblemOf(connectionOf({ createdAtEpochMs: 0 })), "a connection records when it was created", "a missing creation instant is refused");
  expectEqual(
    taxCloudConnectionProblemOf(connectionOf({ createdAtEpochMs: NOW, updatedAtEpochMs: NOW - 1 })),
    "a connection cannot be updated before it was created",
    "an update before creation is refused",
  );
  expectEqual(
    taxCloudConnectionProblemOf(connectionOf({ status: "revoked", lastPingOutcome: "verified", verifiedAtEpochMs: NOW - 60_000 })),
    null,
    "a revoked connection keeps its history and is well-formed",
  );
  expectEqual(
    taxCloudConnectionProblemOf(connectionOf({ status: "failed", lastPingOutcome: "unauthorized", verifiedAtEpochMs: null })),
    null,
    "a failed connection that was never verified is well-formed",
  );
}

/* ---- section 10: the collection gate ---- */

function checkCollection(): void {
  const live = connectionOf();
  expectEqual(isTaxCloudCollectionEnabled(live), true, "a verified live connection may collect");
  expectEqual(taxCloudCollectionProblemOf(live), null, "a verified live connection has no problem to report");

  const test = connectionOf({ mode: "test" });
  expectEqual(isTaxCloudCollectionEnabled(test), false, "a test connection may never collect");
  expectEqual(taxCloudCollectionProblemOf(test), "a test connection never collects tax on a real invoice", "the test refusal says why");

  const unverified = connectionOf({ status: "unverified", verifiedAtEpochMs: null, lastPingOutcome: null, lastPingAtEpochMs: null });
  expectEqual(isTaxCloudCollectionEnabled(unverified), false, "an unverified connection may not collect");
  expectEqual(taxCloudCollectionProblemOf(unverified), "this connection has not been verified by a ping yet", "the unverified refusal says why");

  const failed = connectionOf({ status: "failed", verifiedAtEpochMs: null, lastPingOutcome: "unauthorized" });
  expectEqual(isTaxCloudCollectionEnabled(failed), false, "a failed connection may not collect");
  expectEqual(taxCloudCollectionProblemOf(failed), "the last ping failed, so the credentials are not known to work", "the failed refusal says why");

  const revoked = connectionOf({ status: "revoked" });
  expectEqual(isTaxCloudCollectionEnabled(revoked), false, "a revoked connection may not collect");
  expectEqual(taxCloudCollectionProblemOf(revoked), "this connection was revoked", "the revoked refusal says why");

  const stale = connectionOf({ status: "verified", lastPingOutcome: "unreachable" });
  expectEqual(isTaxCloudCollectionEnabled(stale), false, "a connection whose last ping was unreachable may not collect");
  expectEqual(taxCloudCollectionProblemOf(stale), "the last ping did not verify this connection's credentials", "a row whose last ping failed is refused by that fact");

  for (const connection of [live, test, unverified, failed, revoked]) {
    const enabled = isTaxCloudCollectionEnabled(connection);
    const problem = taxCloudCollectionProblemOf(connection);
    expectEqual(enabled === (problem === null), true, `the gate and its explanation agree for ${connection.status}/${connection.mode}`);
  }
}

/* ---- section 11: masking, views and amounts ---- */

function checkMaskingAndAmounts(): void {
  expectEqual(maskTaxCloudApiKey(API_KEY), `${"*".repeat(12)}1c2d`, "a key is shown by its last four characters only");
  expectEqual(maskTaxCloudApiKey(API_KEY).includes(API_KEY.slice(0, 8)), false, "the beginning of the key is never shown");
  expectEqual(maskTaxCloudApiKey("12345678"), "********", "an eight-character value is hidden whole");
  expectEqual(maskTaxCloudApiKey("abc"), "***", "a three-character value is hidden whole");
  expectEqual(maskTaxCloudApiKey(""), "", "an empty value stays empty");
  expectEqual(maskTaxCloudApiKey(` ${API_KEY} `), maskTaxCloudApiKey(API_KEY), "surrounding space does not change the mask");

  const connection = connectionOf();
  const view = taxCloudConnectionViewOf(connection, API_KEY);
  expectEqual(view.apiKeyMasked, maskTaxCloudApiKey(API_KEY), "the view carries the masked key");
  expectEqual(view.connectionId, CONNECTION_ID, "the view carries the connection id");
  expectEqual(view.mode, "live", "the view carries the mode");
  expectEqual(view.status, "verified", "the view carries the status");
  expectEqual(Object.keys(view).includes("apiKeySealed"), false, "the view has no sealed column");
  expect(JSON.stringify(view).includes(API_KEY) === false, "the serialised view holds no key");
  expect(JSON.stringify(view).includes(connection.apiKeySealed) === false, "the serialised view holds no sealed value");

  expectEqual(TAXCLOUD_AMOUNT_UNIT, "usd_decimal_dollars", "the recorded unit is decimal dollars");
  expectEqual(taxCloudMinorOfAmount("10.75"), 107_500n, "ten dollars and seventy-five cents is 107500 ten-thousandths");
  expectEqual(taxCloudMinorOfAmount(10.75), 107_500n, "a JSON number parses the same way");
  expectEqual(taxCloudMinorOfAmount("1.31"), 13_100n, "the documented tax amount parses exactly");
  expectEqual(taxCloudMinorOfAmount("0.07"), 700n, "seven cents parses exactly");
  expectEqual(taxCloudMinorOfAmount("0"), 0n, "zero parses to zero");
  expectEqual(taxCloudMinorOfAmount("1.5"), 15_000n, "the documented fractional quantity parses as an amount");
  expectEqual(taxCloudMinorOfAmount("10.7500"), 107_500n, "four decimal places parse exactly");
  expectEqual(taxCloudMinorOfAmount("1.0001"), 10_001n, "a ten-thousandth parses exactly");
  for (const bad of ["1.23456", "-1.00", "+1.00", "1e3", "", "  ", ".5", "5.", "1,00", "1234567890123456"]) {
    expectEqual(errorCodeOf(() => taxCloudMinorOfAmount(bad)), "VALIDATION_FAILED", `the amount ${JSON.stringify(bad)} is refused`);
  }
  expectEqual(errorCodeOf(() => taxCloudMinorOfAmount(Number.NaN)), "VALIDATION_FAILED", "NaN is refused");
  expectEqual(errorCodeOf(() => taxCloudMinorOfAmount(Number.POSITIVE_INFINITY)), "VALIDATION_FAILED", "Infinity is refused");
  expectEqual(errorFieldOf(() => taxCloudMinorOfAmount("1e3")), "amount", "the amount refusal names the field");

  expectEqual(taxCloudPriceOf(107_500n), 10.75, "107500 ten-thousandths is sent as 10.75");
  expectEqual(taxCloudPriceOf(100_000n), 10, "ten dollars is sent as 10");
  expectEqual(taxCloudPriceOf(0n), 0, "zero is sent as 0");
  expectEqual(taxCloudPriceOf(700n), 0.07, "seven cents is sent as 0.07");
  expectEqual(typeof taxCloudPriceOf(107_500n), "number", "a price is a JSON number and not a string");
  for (const minor of [100n, 1_000_000n, 12_345_600n, 99_999_900n]) {
    expectEqual(taxCloudMinorOfAmount(taxCloudPriceOf(minor)), minor, `the price ${minor} round-trips exactly`);
  }
  expectEqual(errorCodeOf(() => taxCloudPriceOf(107_550n)), "VALIDATION_FAILED", "a sub-cent price is refused");
  expectEqual(errorFieldOf(() => taxCloudPriceOf(107_550n)), "price", "the sub-cent refusal names the price");
  expectEqual(errorRuleOf(() => taxCloudPriceOf(107_550n)).includes("sub-cent"), true, "the sub-cent refusal is the rounding sentence, not a coincidence");
  expectEqual(errorRuleOf(() => taxCloudPriceOf(-1n)).includes("negative"), true, "the negative refusal says a price cannot be negative");
  expectEqual(errorRuleOf(() => taxCloudPriceOf(1_000_000_000_000_000_000n)).includes("ceiling"), true, "the ceiling refusal names the ceiling");
  expectEqual(errorRuleOf(() => taxCloudPriceOf(900_719_925_474_099_900n)).includes("exact JSON number"), true, "the inexact refusal says the number cannot be sent exactly");
  expectEqual(errorCodeOf(() => taxCloudPriceOf(-100n)), "VALIDATION_FAILED", "a negative price is refused");
  expectEqual(errorCodeOf(() => taxCloudPriceOf(1_000_000_000_000_000_000n)), "VALIDATION_FAILED", "a price past the money ceiling is refused");
  expectEqual(errorCodeOf(() => taxCloudPriceOf(900_719_925_474_099_900n)), "VALIDATION_FAILED", "a price that no double can hold is refused");
  expectEqual(taxCloudMinorOfAmount(taxCloudPriceOf(123_456_700n)), 123_456_700n, "a large whole-cent price round-trips");
}

/* ---- section 12: the source ---- */

function checkSource(): void {
  const source = readFileSync(new URL("./taxcloud.ts", import.meta.url), "utf8");
  expect([...source].every((char) => char.charCodeAt(0) <= 127), "the record's source is ASCII");
  const consoleNeedles = ["log", "error", "warn"].map((name) => ["console", `${name}(`].join("."));
  for (const needle of consoleNeedles) {
    expect(source.includes(needle) === false, "the record's source carries no console call");
  }
  expect(source.includes("process.env") === false, "the record reads no environment variable");
  expect(source.includes("await fetch(") === false, "the record calls no vendor");
  expect(source.includes("node:http") === false, "the record opens no socket");
  expect(source.includes("node:fs") === false, "the record reads no file");
  expect(source.includes("axios") === false, "the record imports no HTTP client");
  expect(source.includes("node:crypto") === false, "the record encrypts and hashes nothing itself");
  expect(source.includes("JSON.parse") === false, "the record parses no body");
  expect(source.includes("openSecret(") === false, "the record opens no sealed value");
  expect(source.includes("sealSecret(") === false, "the record seals nothing");
  expect(source.includes("next/server") === false, "the record imports no route helper");
  expect(source.includes("migrations") === false, "the record knows nothing of the database layout");

  expect(source.includes('"X-API-KEY"') === true, "the header name is written once, in the constant");
  expect(source.includes('"Authorization"') === true, "the refused alternative is named");
  expectEqual(source.split('"Authorization"').length - 1, 1, "the refused header is named once, in its constant");
  expect(source.includes("apiLoginID:") === false, "the v1 body field is never written as a field");
  expect(source.includes("apiKey:") === true, "the key is named as a field of the draft only");
  expect(source.includes("apiKeySealed") === true, "the sealed column is named");
  expect(source.includes("https://api.v3.taxcloud.com") === true, "the documented base is written once");
  expect(source.includes("api.taxcloud.net") === true, "the v1 host is named only inside the refused list");
  expectEqual(source.split('"https://api.v3.taxcloud.com"').length - 1, 1, "the base appears once as a literal");
  expect(source.includes("TAXCLOUD_SANDBOX_BASE: null") === true, "the absent sandbox base is a constant of type null");
  for (const personal of ["firstName", "first_name", "dateOfBirth", "date_of_birth"]) {
    expect(source.includes(personal) === false, `the record never names the ${personal} field`);
  }
  expect(source.includes("sk_live_") === false, "the record carries no live-looking key");
  expect(source.includes("sk_test_") === false, "the record carries no test-looking key");
  const documentedCount = source.split("taxCloudSource(").length - 1;
  expectEqual(documentedCount, TAXCLOUD_DOCUMENTATION_SOURCES.length, "every recorded page comes from one helper call");
}

/* ---- running ---- */

checkHosts();
checkSources();
checkRules();
checkEndpoints();
checkRequest();
checkFailures();
checkPing();
checkDraft();
checkConnection();
checkCollection();
checkMaskingAndAmounts();
checkSource();

if (failures.length > 0) {
  process.stderr.write(
    `taxcloud record gate failed: ${failures.length} of ${checks} checks\n${failures.map((failure) => `  - ${failure}`).join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `taxcloud record gate passed: ${checks} checks (one API base and no sandbox host with the v1 hosts refused by name, the key in the X-API-KEY header and never in a URL or a body, the connection UUID in the path and no v1 body fields, sixteen pages recorded with the rule each settled and fourteen rules with the page that produced them, twelve documented endpoints whose paths cannot be steered by a caller's value, the documented problem statuses split into the permanent ones and the three that are retried, a ping whose 401 and 404 mean different things and whose temporary failures decide nothing about credentials, a draft that refuses the word sandbox and explains the second connection instead, a stored connection that cannot be verified without a verified ping, a collection gate that only a live verified connection passes, a key masked to its last four characters, and decimal dollars converted exactly or refused rather than rounded)\n`,
);
