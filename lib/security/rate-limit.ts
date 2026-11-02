// path: lib/security/rate-limit.ts
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { AppError, rateLimited } from "../errors/app-error.ts";

/**
 * The platform wide rate limiter: one request, three buckets, one decision.
 *
 * ## What the three buckets are
 *
 * `lib/auth/rate-limit.ts` counts one address on one authentication endpoint, which is what section
 * 22 line 242 asks for. Every other endpoint of the platform needs a limit too - section 20 line 220
 * says so for the public API - and an address alone is not enough once accounts exist: an attacker
 * with a thousand addresses is invisible to an address bucket, and a shared office is punished by
 * one. So a request is counted three times, and refused if any bucket is full:
 *
 *   - **ip**: the address across the whole class. Catches one machine walking every route.
 *   - **user**: the signed-in account across the whole class. Catches one account spread over many
 *     addresses, and leaves a shared office alone because the office is many accounts.
 *   - **route**: the address on one route. Catches one route being hammered, which is the request a
 *     per-class limit is too coarse to see.
 *
 * ## One counter, not two
 *
 * `public.rate_limit_windows` from migration `0092` holds a row per `(scope, key_hash)`, and
 * `public.consume_rate_limit` moves it in one statement. That table already stores a *scope* and an
 * opaque key hash, so a second dimension costs nothing: the scope names the bucket
 * (`ip_office_write`, `user_public_api`, `route_export`) and the key names the subject. This module
 * therefore adds no table, no function and no migration - it calls the same function the
 * authentication limiter calls, with a scope it derived. Two counters for one platform would be two
 * answers to "how many requests has this address made", and the smaller one would be the one an
 * attacker works under.
 *
 * ## The window is fixed and the database decides
 *
 * `consume_rate_limit` aligns the window to the epoch, rewrites a lapsed row in place, and answers
 * `allowed`, `remaining`, `retry_after_seconds` and `first_refusal` from one statement. The read,
 * the decision and the write are the database's, because a service that read the counter and wrote
 * it back would lose increments under exactly the burst the limit exists for.
 *
 * ## What this module will not do
 *
 * It does not read a request. It is given the route, the method, the address and the account, so
 * there is no second forwarding-header parser here that could disagree with
 * `lib/auth/client-address.ts` about which hop is trusted - the one trust rule stays in one file,
 * and this module only hashes the value it was handed. It does not decide shape for the same reason:
 * `net.isIP` is the platform's idea of an address, and anything that is not an address cannot be
 * counted, which is a refusal rather than a free pass.
 *
 * It does not guess when the database cannot answer. `DEPENDENCY_FAILED` from the client becomes
 * `DEPENDENCY_FAILED` to the caller, because "the counter was unavailable, so the request was
 * allowed" is the one behaviour that turns an outage into permission.
 *
 * ## What a caller sees
 *
 * A refusal is `429 RATE_LIMITED` with `retry-after`, which `respond.ts` already writes, and the
 * sentence is the catalog's `errors.rateLimited` (the screens have their own `rateLimit.*` wording
 * for the wait). The audit entry `security.rate_limited` names the route, the class, the buckets that
 * refused and the delay, and it is written once per window per bucket rather than once per request:
 * an address under attack would otherwise turn the audit chain into a copy of the attack.
 */

/** The scope, limit and window rules of `0092`, as constants so the two cannot drift. */
export const RATE_LIMIT_COUNTER_FUNCTION = "consume_rate_limit";

/** The widest scope the `rate_limit_windows_scope_check` of `0092` accepts. */
export const RATE_LIMIT_MAXIMUM_SCOPE_LENGTH = 40;

/** The narrowest and widest window `rate_limit_windows_window_seconds_check` accepts. */
export const RATE_LIMIT_MINIMUM_WINDOW_SECONDS = 1;
export const RATE_LIMIT_MAXIMUM_WINDOW_SECONDS = 86_400;

/** `rate_limit_windows_scope_check`: lower snake case, two to forty characters. */
export const RATE_LIMIT_SCOPE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/u;

/** `rate_limit_windows_key_hash_check`: the hex SHA-256 of the subject. */
export const RATE_LIMIT_KEY_HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** The audit action written when a bucket refuses a request for the first time in its window. */
export const RATE_LIMIT_AUDIT_ACTION = "security.rate_limited";

/** The rule a screen or a log line can name when it explains the wait. */
export const RATE_LIMIT_RULE = "rate_limited";

/** The bucket a request is counted in. The name is also the scope prefix it is stored under. */
export const RATE_LIMIT_BUCKET_DIMENSIONS = ["ip", "user", "route"] as const;

export type RateLimitBucketDimension = (typeof RATE_LIMIT_BUCKET_DIMENSIONS)[number];

/** One class of endpoint. A class is one row of limits, not one route. */
export const RATE_LIMIT_CLASSES = [
  "public_api",
  "webhook",
  "office_read",
  "office_write",
  "export",
  "authenticated",
] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/** A ceiling and the window it applies to. */
export interface RateLimitBucketPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * The three buckets of one class.
 *
 * A class without a user bucket is a class that runs before an account is known - a provider webhook
 * arrives with a signature, not a session - and a null there is the honest statement that the bucket
 * does not exist rather than a limit of zero that would refuse every request.
 */
export interface RateLimitClassPolicy {
  readonly ip: RateLimitBucketPolicy;
  readonly user: RateLimitBucketPolicy | null;
  readonly route: RateLimitBucketPolicy;
}

/** One frozen bucket limit, so a class cannot be widened at runtime. */
function bucketPolicy(limit: number, windowSeconds: number): RateLimitBucketPolicy {
  return Object.freeze({ limit, windowSeconds });
}

/** One frozen class, so neither the class nor its buckets can be edited after import. */
function classPolicy(
  ip: RateLimitBucketPolicy,
  user: RateLimitBucketPolicy | null,
  route: RateLimitBucketPolicy,
): RateLimitClassPolicy {
  return Object.freeze({ ip, user, route });
}

/**
 * The limits.
 *
 * The numbers answer two questions per class. How much does one address do across the class, and how
 * much does it do on a single route of it? The route limit is always the smaller of the two, because
 * a route is a fraction of a class and the route bucket is the one that should trip first on a
 * hammered endpoint. The address limit is loose enough for an office behind one NAT and the account
 * limit is looser still, because one account may legitimately run several devices and one office
 * must not be punished for being shared.
 *
 * `export` is the tightest class in the platform: a data export is a scan of a tenant's rows, not a
 * page render, and no screen needs eleven of them in five minutes.
 */
export const RATE_LIMIT_CLASS_POLICIES: Readonly<Record<RateLimitClass, RateLimitClassPolicy>> =
  Object.freeze({
    public_api: classPolicy(bucketPolicy(300, 60), bucketPolicy(1_000, 60), bucketPolicy(60, 60)),
    webhook: classPolicy(bucketPolicy(1_200, 60), null, bucketPolicy(600, 60)),
    office_read: classPolicy(bucketPolicy(240, 60), bucketPolicy(300, 60), bucketPolicy(120, 60)),
    office_write: classPolicy(bucketPolicy(60, 60), bucketPolicy(90, 60), bucketPolicy(30, 60)),
    export: classPolicy(bucketPolicy(10, 300), bucketPolicy(10, 300), bucketPolicy(5, 300)),
    authenticated: classPolicy(bucketPolicy(600, 60), bucketPolicy(600, 60), bucketPolicy(240, 60)),
  });

/**
 * The routes a limiter must never refuse.
 *
 * A liveness probe answered with `429` reports the platform as down, and the monitor that reads it
 * would be right: it asked whether the platform answers in time and the platform said "later". Both
 * routes are `GET` handlers over a constant, they touch no table and no tenant, and a flood of them
 * cannot be told apart from the monitor. The list is a constant of two exact paths rather than a
 * prefix, so a future route cannot inherit the exemption by sitting under `/api/health/`.
 */
export const RATE_LIMIT_EXEMPT_ROUTES = ["/api/health", "/api/jobs/health"] as const;

/** The scope prefix of each bucket, so a row in the table names its own dimension. */
const BUCKET_SCOPE_PREFIXES: Readonly<Record<RateLimitBucketDimension, string>> = Object.freeze({
  ip: "ip",
  user: "user",
  route: "route",
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const readMethods: readonly string[] = ["GET", "HEAD", "OPTIONS"];

/** What one route asks the limiter about. No `Request`, no header, no session. */
export interface RateLimitRequest {
  /** The request path. A query string is ignored, because it is not part of the route. */
  readonly route: string;
  readonly method: string;
  /** The address the caller already read, or null when the request carried none. */
  readonly clientAddress: string | null;
  /** The signed-in account, or null on a surface that runs before an account is known. */
  readonly userId?: string | null;
}

/** One counted bucket: everything the counter function needs, and nothing else. */
export interface RateLimitBucket {
  readonly dimension: RateLimitBucketDimension;
  readonly scope: string;
  readonly keyHash: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The answer of one bucket. */
export interface RateLimitBucketDecision extends RateLimitBucket {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  /** True when this refusal is the first of its window, which is when the audit entry is written. */
  readonly firstRefusal: boolean;
}

/** The answer for the request as a whole: refused when any bucket is. */
export interface RateLimitOutcome {
  readonly route: string;
  readonly method: string;
  readonly class: RateLimitClass | null;
  /** True for a health probe, which is answered without a counter. */
  readonly exempt: boolean;
  readonly allowed: boolean;
  /** The tightest limit the request was counted against. */
  readonly limit: number;
  /** The smallest remaining of the buckets, which is the one that runs out first. */
  readonly remaining: number;
  /** The longest wait any refusing bucket asks for; zero when the request was allowed. */
  readonly retryAfterSeconds: number;
  readonly buckets: readonly RateLimitBucketDecision[];
  readonly refusedBuckets: readonly RateLimitBucketDimension[];
  readonly firstRefusalBuckets: readonly RateLimitBucketDimension[];
}

/** The part of the REST client this module needs, so it does not depend on the auth client. */
export interface RateLimitCounterClient {
  rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** The audit entry this module writes. Structurally the entry `lib/auth/audit.ts` already accepts. */
export interface RateLimitAuditEntry {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly companyId: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** The trail a caller passes when it wants the refusal recorded. */
export interface RateLimitAuditTrail {
  append(entry: RateLimitAuditEntry): Promise<void>;
}

export interface RateLimitDependencies {
  readonly rest: RateLimitCounterClient;
  readonly audit?: RateLimitAuditTrail;
  readonly now?: () => number;
}

/**
 * The path a route is counted under.
 *
 * A query string is not part of a route - `?page=2` and `?page=3` are one endpoint - and a trailing
 * slash is not either. The path is otherwise left alone: Next matches it case sensitively, so
 * lower casing it here would merge two routes into one bucket and let a request spend another
 * route's limit.
 */
export function normalizeRateLimitRoute(route: string): string {
  const path = (route.split(/[?#]/u, 1)[0] ?? "").trim();
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const collapsed = absolute.replace(/\/{2,}/gu, "/");

  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

/** True when a route is a liveness probe, which is answered without a counter. */
export function isRateLimitExemptRoute(route: string): boolean {
  const path = normalizeRateLimitRoute(route);

  return RATE_LIMIT_EXEMPT_ROUTES.some((exempt) => exempt === path);
}

/** True for the methods that only read, which is what separates `office_read` from `office_write`. */
export function isRateLimitReadMethod(method: string): boolean {
  return readMethods.includes(method.trim().toUpperCase());
}

/**
 * The class a route belongs to, or null when the limiter does not cover it.
 *
 * Null means one of two things and never a third: the route is an exempt probe, or it is not an API
 * route at all. A page is not counted here - a page render is the framework's own response and the
 * platform's pages are behind a session - while every path under `/api/` falls into a class, so a
 * route added tomorrow is limited the moment it calls the limiter.
 *
 * The order matters twice. `export` is tested before `office` because `/api/office/reports/export`
 * is an export whichever prefix it sits under, and the office methods are split because a write
 * costs a row and a read does not.
 */
export function rateLimitClassForRoute(route: string, method: string): RateLimitClass | null {
  const path = normalizeRateLimitRoute(route);

  if (isRateLimitExemptRoute(path)) {
    return null;
  }

  if (!path.startsWith("/api/")) {
    return null;
  }

  if (path === "/api/public" || path.startsWith("/api/public/")) {
    return "public_api";
  }

  if (path === "/api/webhooks" || path.startsWith("/api/webhooks/")) {
    return "webhook";
  }

  if (path === "/api/exports" || path.startsWith("/api/exports/") || path.endsWith("/export")) {
    return "export";
  }

  if (path.startsWith("/api/office/")) {
    return isRateLimitReadMethod(method) ? "office_read" : "office_write";
  }

  return "authenticated";
}

/** The scope one bucket of one class is stored under; the row names its own dimension. */
export function rateLimitScopeFor(
  dimension: RateLimitBucketDimension,
  limitClass: RateLimitClass,
): string {
  const scope = `${BUCKET_SCOPE_PREFIXES[dimension]}_${limitClass}`;

  if (!RATE_LIMIT_SCOPE_PATTERN.test(scope) || scope.length > RATE_LIMIT_MAXIMUM_SCOPE_LENGTH) {
    throw new AppError("INTERNAL_ERROR");
  }

  return scope;
}

/**
 * The one spelling of an address.
 *
 * `2001:0db8:0000::0001` and `2001:db8::1` are the same machine, and an address with two spellings
 * would be two counters for one attacker. `net.isIP` is the platform's idea of an address - it
 * refuses a port, a host name and a zone index without a pattern of ours to keep right - and the URL
 * parser produces the lower case, zero compressed form. Nothing that is not an address has a
 * spelling, so anything else is null and the caller refuses.
 */
export function canonicalRateLimitAddress(address: string): string | null {
  const value = address.trim();

  if (isIP(value) === 0) {
    return null;
  }

  try {
    const host = new URL(`http://${value.includes(":") ? `[${value}]` : value}/`).hostname;

    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  } catch {
    return null;
  }
}

/** The key a bucket stores: the hex SHA-256 of its subject, never the subject. */
function digestKey(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

/**
 * The buckets one request is counted in, or null when the route is exempt or not an API route.
 *
 * It throws rather than guessing in the two cases where a bucket cannot be built honestly:
 *
 *   - an address that is not an address is `SERVICE_UNAVAILABLE`, because a request that cannot be
 *     counted must not be let through - that is the one failure mode a limiter must not have - and
 *     every limited route needs the database anyway;
 *   - an account id that is not a uuid, or a class that declares a user bucket with no account
 *     behind it, is `INTERNAL_ERROR`, because it is a wiring mistake: `webhook` is the only class
 *     without a user bucket, and the rest are behind a session.
 */
export function rateLimitBucketsFor(request: RateLimitRequest): readonly RateLimitBucket[] | null {
  const route = normalizeRateLimitRoute(request.route);
  const limitClass = rateLimitClassForRoute(route, request.method);

  if (limitClass === null) {
    return null;
  }

  const address = request.clientAddress === null ? null : canonicalRateLimitAddress(request.clientAddress);

  if (address === null) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  const policy = RATE_LIMIT_CLASS_POLICIES[limitClass];
  const buckets: RateLimitBucket[] = [
    {
      dimension: "ip",
      scope: rateLimitScopeFor("ip", limitClass),
      keyHash: digestKey([BUCKET_SCOPE_PREFIXES.ip, address]),
      limit: policy.ip.limit,
      windowSeconds: policy.ip.windowSeconds,
    },
  ];

  if (policy.user !== null) {
    const userId = request.userId ?? null;

    if (userId === null || !uuidPattern.test(userId)) {
      throw new AppError("INTERNAL_ERROR");
    }

    buckets.push({
      dimension: "user",
      scope: rateLimitScopeFor("user", limitClass),
      keyHash: digestKey([BUCKET_SCOPE_PREFIXES.user, userId]),
      limit: policy.user.limit,
      windowSeconds: policy.user.windowSeconds,
    });
  }

  buckets.push({
    dimension: "route",
    scope: rateLimitScopeFor("route", limitClass),
    keyHash: digestKey([BUCKET_SCOPE_PREFIXES.route, address, route]),
    limit: policy.route.limit,
    windowSeconds: policy.route.windowSeconds,
  });

  return buckets;
}

/** One row of the answer of `consume_rate_limit`, checked rather than trusted. */
interface CounterAnswer {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly firstRefusal: boolean;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum;
}

/**
 * The answer of the counter function, or a dependency failure.
 *
 * The body is `[{ allowed, remaining, retry_after_seconds, first_refusal }]`, and a body that does
 * not have that shape is not read hopefully: a missing field read as `0` would be a limit that never
 * refuses. `remaining` is also held to the limit the row was asked about, because a counter that
 * reports more room than the policy has is not this function's answer.
 */
function readCounterAnswer(body: unknown, bucket: RateLimitBucket): CounterAnswer {
  const row = Array.isArray(body) && body.length === 1 ? body[0] : undefined;

  if (!isPlainObject(row)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  const allowed = row["allowed"];
  const remaining = row["remaining"];
  const retryAfterSeconds = row["retry_after_seconds"];
  const firstRefusal = row["first_refusal"];

  if (typeof allowed !== "boolean" || typeof firstRefusal !== "boolean") {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (!isIntegerAtLeast(remaining, 0) || !isIntegerAtLeast(retryAfterSeconds, 0)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (remaining > bucket.limit || retryAfterSeconds > RATE_LIMIT_MAXIMUM_WINDOW_SECONDS) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (allowed && (retryAfterSeconds !== 0 || firstRefusal)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (!allowed && retryAfterSeconds < RATE_LIMIT_MINIMUM_WINDOW_SECONDS) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return { allowed, remaining, retryAfterSeconds, firstRefusal };
}

async function consumeBucket(
  bucket: RateLimitBucket,
  dependencies: RateLimitDependencies,
  nowMs: number,
): Promise<RateLimitBucketDecision> {
  const body = await dependencies.rest.rpc(RATE_LIMIT_COUNTER_FUNCTION, {
    p_scope: bucket.scope,
    p_key_hash: bucket.keyHash,
    p_limit: bucket.limit,
    p_window_seconds: bucket.windowSeconds,
    p_now: new Date(nowMs).toISOString(),
  });
  const answer = readCounterAnswer(body, bucket);

  return { ...bucket, ...answer };
}

/** The outcome of a route that is not counted, because it is exempt or not an API route. */
function exemptOutcome(route: string, method: string): RateLimitOutcome {
  return {
    route,
    method,
    class: null,
    exempt: true,
    allowed: true,
    limit: 0,
    remaining: 0,
    retryAfterSeconds: 0,
    buckets: [],
    refusedBuckets: [],
    firstRefusalBuckets: [],
  };
}

/**
 * Count one request in every bucket it belongs to and answer once.
 *
 * The buckets are consumed together, not until the first refusal: a refused request still spent the
 * other buckets, which is correct - each of them counts attempts, and an attacker who spreads across
 * routes must still fill the address bucket. The answer is the strictest of them: refused when any
 * bucket refused, the smallest remaining, and the longest wait, because the caller must wait for the
 * last bucket to open and not the first.
 */
export async function consumeRateLimitBuckets(
  request: RateLimitRequest,
  dependencies: RateLimitDependencies,
): Promise<RateLimitOutcome> {
  const route = normalizeRateLimitRoute(request.route);
  const method = request.method.trim().toUpperCase();
  const buckets = rateLimitBucketsFor({ ...request, route });

  if (buckets === null) {
    return exemptOutcome(route, method);
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const decisions = await Promise.all(
    buckets.map((bucket) => consumeBucket(bucket, dependencies, now())),
  );
  const refused = decisions.filter((decision) => !decision.allowed);

  return {
    route,
    method,
    class: rateLimitClassForRoute(route, method),
    exempt: false,
    allowed: refused.length === 0,
    limit: Math.min(...decisions.map((decision) => decision.limit)),
    remaining: Math.min(...decisions.map((decision) => decision.remaining)),
    retryAfterSeconds:
      refused.length === 0
        ? 0
        : Math.max(...refused.map((decision) => decision.retryAfterSeconds)),
    buckets: decisions,
    refusedBuckets: refused.map((decision) => decision.dimension),
    firstRefusalBuckets: decisions
      .filter((decision) => !decision.allowed && decision.firstRefusal)
      .map((decision) => decision.dimension),
  };
}

/**
 * The audit entry for a refusal, or null when nothing was refused for the first time.
 *
 * One entry per window per refused bucket, which is what `refused_at` in `0092` makes possible: the
 * payload names the buckets that were first refused, the scopes they were stored under and the
 * delay, so an operator reading the chain sees the attack rather than a copy of it. The key hashes
 * are included and the address is included separately, which is the same split the table makes.
 */
export function rateLimitAuditEntry(
  outcome: RateLimitOutcome,
  context: {
    readonly ipAddress: string | null;
    readonly userAgent?: string | null;
    readonly userId?: string | null;
    readonly companyId?: string | null;
    readonly sessionId?: string | null;
  },
): RateLimitAuditEntry | null {
  if (outcome.exempt || outcome.firstRefusalBuckets.length === 0) {
    return null;
  }

  const refused = outcome.buckets.filter(
    (bucket) => !bucket.allowed && bucket.firstRefusal,
  );

  return {
    action: RATE_LIMIT_AUDIT_ACTION,
    actorUserId: context.userId ?? null,
    entityType: "rate_limit_window",
    entityId: null,
    payload: {
      route: outcome.route,
      method: outcome.method,
      class: outcome.class,
      rule: RATE_LIMIT_RULE,
      limit: outcome.limit,
      retry_after_seconds: outcome.retryAfterSeconds,
      buckets: refused.map((bucket) => bucket.dimension),
      scopes: refused.map((bucket) => bucket.scope),
      key_hashes: refused.map((bucket) => bucket.keyHash),
      window_seconds: refused.map((bucket) => bucket.windowSeconds),
    },
    companyId: context.companyId ?? null,
    sessionId: context.sessionId ?? null,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent ?? null,
  };
}

/**
 * The headers a route can copy onto its own response.
 *
 * `ratelimit-limit`, `ratelimit-remaining` and `ratelimit-reset` are the names of the IETF rate limit
 * fields in the lower case this platform writes every header in, and none of them is one of
 * the security headers of STEP 060 - a route that set `nosniff` from here would be overwriting a
 * rule it did not read. The reset is the seconds until the current window ends, computed from the
 * same epoch alignment `consume_rate_limit` uses.
 */
export function rateLimitHeaders(outcome: RateLimitOutcome, nowMs?: number): Record<string, string> {
  if (outcome.exempt || outcome.buckets.length === 0) {
    return {};
  }

  const now = nowMs ?? Date.now();
  const windowSeconds = Math.min(...outcome.buckets.map((bucket) => bucket.windowSeconds));
  const resetSeconds = Math.max(
    RATE_LIMIT_MINIMUM_WINDOW_SECONDS,
    windowSeconds - (Math.floor(now / 1_000) % windowSeconds),
  );

  return {
    "ratelimit-limit": String(outcome.limit),
    "ratelimit-remaining": String(outcome.remaining),
    "ratelimit-reset": String(resetSeconds),
  };
}

/**
 * The one call a route makes: count, record a first refusal, refuse, or pass.
 *
 * The refusal is thrown rather than returned, so a route cannot forget it: `withErrorResponse`
 * turns `RATE_LIMITED` into `429` with `retry-after`, and the code is already retryable in the
 * catalog. The audit write is best effort - a chain that cannot be written must not turn a refusal
 * into a pass, and it must not turn a 429 into a 500 either - which is the same choice
 * `lib/auth/rate-limit.ts` makes.
 */
export async function enforceRouteRateLimit(
  request: RateLimitRequest,
  dependencies: RateLimitDependencies,
): Promise<RateLimitOutcome> {
  const outcome = await consumeRateLimitBuckets(request, dependencies);

  if (outcome.exempt) {
    return outcome;
  }

  const context = {
    ipAddress:
      request.clientAddress === null ? null : canonicalRateLimitAddress(request.clientAddress),
    userAgent: null,
    userId: request.userId ?? null,
    companyId: null,
    sessionId: null,
  };
  const entry = rateLimitAuditEntry(outcome, context);

  if (entry !== null && dependencies.audit !== undefined) {
    await dependencies.audit.append(entry).catch(() => undefined);
  }

  if (!outcome.allowed) {
    throw rateLimited(outcome.retryAfterSeconds);
  }

  return outcome;
}
