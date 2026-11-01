// path: lib/auth/rate-limit.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, rateLimited } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { readClientAddress } from "./client-address.ts";
import type { RestClient } from "./rest.ts";

/**
 * IP based rate limiting for the authentication endpoints, as section 22 line 242 requires.
 *
 * ## Why this is a table and not a map
 *
 * Line 238 says the counters are stored in the database and survive server restarts, and the same
 * reason applies here: an in-memory limiter is per instance, so a platform behind two instances
 * allows twice the limit, and a deploy empties it exactly when an attack is in progress. The counter
 * is `public.rate_limit_windows`, one row per (scope, address hash), and `public.consume_rate_limit`
 * moves it with a single statement.
 *
 * ## Fixed windows, reset in place
 *
 * A window is aligned to the epoch: `floor(now / window) * window`. When a request arrives after the
 * window it was counting has lapsed, the same row is rewritten to `hits = 1` and the new start, so
 * the table holds one row per address per endpoint rather than one per window, and a limit can never
 * be spent by a window that has ended.
 *
 * ## Why the policy is code and not configuration
 *
 * The limits live here, beside `STEP_UP_WINDOW_MS` in `step-up.ts` and the lock thresholds in
 * `login-attempts.ts`, because they are security constants that a change must be reviewed with code:
 * a configuration value can be edited on a running platform, and a rate limit that can be raised
 * without a review is not a control.
 *
 * ## What a caller sees
 *
 * A refused request is `429 RATE_LIMITED` with `retry-after` in seconds - the code is in the catalog
 * as `retryable`, `respond.ts` already writes the header, and every anonymous surface already lists
 * the code, so no disclosure decision changes here. The sentence a person reads is the screen's, and
 * it is told how long the wait is rather than "try again later".
 */

/** One counter per endpoint, named after the endpoint so an operator can read a row. */
export const RATE_LIMIT_SCOPES = [
  "signin",
  "signup",
  "verify",
  "two_factor_reset",
  "two_factor_enroll",
  "two_factor_confirm",
  "two_factor_verify",
  "backup_codes",
  "device_enroll",
  "device_confirm",
  "session_rotate",
  "session_reauth",
  "session_list",
  "session_revoke",
] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

/** A ceiling and the window it applies to. */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * The limits.
 *
 * Two rules decide every number. A limit has to be loose enough that a shared office address is not
 * punished for being shared - NAT is common, and an office of thirty people signing in at nine in
 * the morning is not an attack - and tight enough that a single address cannot walk the whole
 * platform. Session rotation is the loosest because every open tab rotates, and the second factor
 * reset is the tightest because each request is a message to the office.
 */
export const RATE_LIMIT_POLICIES: Readonly<Record<RateLimitScope, RateLimitPolicy>> = Object.freeze({
  signin: { limit: 30, windowSeconds: 300 },
  signup: { limit: 10, windowSeconds: 3_600 },
  verify: { limit: 30, windowSeconds: 600 },
  two_factor_reset: { limit: 5, windowSeconds: 3_600 },
  two_factor_enroll: { limit: 10, windowSeconds: 600 },
  two_factor_confirm: { limit: 30, windowSeconds: 600 },
  two_factor_verify: { limit: 30, windowSeconds: 300 },
  backup_codes: { limit: 10, windowSeconds: 600 },
  device_enroll: { limit: 20, windowSeconds: 600 },
  device_confirm: { limit: 30, windowSeconds: 600 },
  session_rotate: { limit: 120, windowSeconds: 300 },
  session_reauth: { limit: 30, windowSeconds: 300 },
  session_list: { limit: 120, windowSeconds: 300 },
  session_revoke: { limit: 30, windowSeconds: 300 },
} as const satisfies Record<RateLimitScope, RateLimitPolicy>);

/** The endpoint a route limits, or null for a route that is not an authentication endpoint. */
export const RATE_LIMITED_PATHS: Readonly<Record<string, RateLimitScope>> = Object.freeze({
  "/api/auth/signin": "signin",
  "/api/auth/signup": "signup",
  "/api/auth/verify": "verify",
  "/api/auth/2fa/reset": "two_factor_reset",
  "/api/auth/2fa/enroll": "two_factor_enroll",
  "/api/auth/2fa/confirm": "two_factor_confirm",
  "/api/auth/2fa/verify": "two_factor_verify",
  "/api/auth/2fa/backup-codes": "backup_codes",
  "/api/auth/devices": "device_enroll",
  "/api/auth/devices/confirm": "device_confirm",
  "/api/auth/session/rotate": "session_rotate",
  "/api/auth/session/reauth": "session_reauth",
  "/api/auth/sessions": "session_list",
  "/api/auth/sessions/revoke": "session_revoke",
} as const satisfies Record<string, RateLimitScope>);

/** The audit action written when an address is refused for the first time in a window. */
export const RATE_LIMIT_AUDIT_ACTION = "auth.rate_limited";

/** The rule a screen can name when it explains the wait. */
export const RATE_LIMIT_RULE = "rate_limited";

const keyHashPattern = /^[a-f0-9]{64}$/u;

const counterSchema = z.object({
  allowed: z.boolean(),
  remaining: z.number().int().min(0),
  retry_after_seconds: z.number().int().min(0),
  first_refusal: z.boolean(),
});

/** What the counter answered. */
export interface RateLimitDecision {
  readonly scope: RateLimitScope;
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until a refused address may try again; zero when the request was allowed. */
  readonly retryAfterSeconds: number;
  /** True when this refusal is the first of its window, which is when the audit entry is written. */
  readonly firstRefusal: boolean;
}

export interface RateLimitDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * One address, one spelling.
 *
 * An IPv6 address has many legal spellings, and each one would otherwise be a fresh counter for the
 * same machine. The URL parser is the shortest reliable canonicaliser available without a dependency:
 * it lower cases, drops leading zeros and compresses the longest run of zero groups, which is the
 * form a second request from the same host produces.
 */
export function canonicalClientAddress(address: string): string {
  const bracketed = address.includes(":") ? `[${address}]` : address;
  const { hostname } = new URL(`http://${bracketed}/`);

  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** The key a counter stores: the hex SHA-256 of the canonical address, never the address. */
export function rateLimitKeyHash(address: string): string {
  return createHash("sha256").update(canonicalClientAddress(address), "utf8").digest("hex");
}

/** The scope one route limits, or null when the route is not an authentication endpoint. */
export function rateLimitScopeForPath(path: string): RateLimitScope | null {
  const scope = RATE_LIMITED_PATHS[path];

  return scope ?? null;
}

/**
 * Count one attempt against one window.
 *
 * The decision is the database's: `public.consume_rate_limit` increments and answers in one
 * statement, so two requests in the same millisecond cannot both see the last slot. Reading the
 * counter here first and writing it back would be the one implementation that loses increments under
 * the burst the limit exists for.
 *
 * A database that cannot answer is not guessed at: the failure is `DEPENDENCY_FAILED` from the REST
 * client, which is the honest answer for "the platform cannot count right now". Letting the request
 * through instead would make an outage the way past the limit.
 */
export async function consumeRateLimit(
  input: { readonly scope: RateLimitScope; readonly address: string },
  dependencies: RateLimitDependencies,
): Promise<RateLimitDecision> {
  const policy = RATE_LIMIT_POLICIES[input.scope];
  const keyHash = rateLimitKeyHash(input.address);
  const now = dependencies.now ?? ((): number => Date.now());
  const body = await dependencies.rest.rpc("consume_rate_limit", {
    p_scope: input.scope,
    p_key_hash: keyHash,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
    p_now: new Date(now()).toISOString(),
  });
  const parsed = z.array(counterSchema).length(1).safeParse(body);
  const answer = parsed.success ? parsed.data[0] : undefined;

  if (answer === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return {
    scope: input.scope,
    allowed: answer.allowed,
    remaining: answer.remaining,
    retryAfterSeconds: answer.retry_after_seconds,
    firstRefusal: answer.first_refusal,
  };
}

/**
 * The one call a route makes.
 *
 * It reads the address from the request itself, so no route can pass an address a caller chose. A
 * request that carries no address is refused with `SERVICE_UNAVAILABLE` rather than let through
 * unlimited: section 22 makes the counter per address, an address-less request cannot be counted, and
 * "the limiter could not count, so it allowed everything" is the failure mode a limiter must not have.
 * Every limited endpoint needs the database anyway, so failing closed costs nothing that was working.
 *
 * The refusal is audited once per window, not once per request: an address under attack would
 * otherwise turn the audit chain into a copy of the attack. The counter itself is exact, because
 * `hits` is only moved by an allowed request.
 */
export async function enforceRateLimit(
  input: { readonly request: Request; readonly scope: RateLimitScope },
  dependencies: RateLimitDependencies,
): Promise<RateLimitDecision> {
  const address = readClientAddress(input.request.headers);

  if (address === null) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  const decision = await consumeRateLimit({ scope: input.scope, address }, dependencies);

  if (decision.firstRefusal) {
    const policy = RATE_LIMIT_POLICIES[input.scope];

    await dependencies.audit
      .append({
        action: RATE_LIMIT_AUDIT_ACTION,
        actorUserId: null,
        entityType: null,
        entityId: null,
        companyId: null,
        payload: {
          scope: input.scope,
          limit: policy.limit,
          window_seconds: policy.windowSeconds,
          retry_after_seconds: decision.retryAfterSeconds,
          key_hash: rateLimitKeyHash(address),
        },
        ipAddress: address,
        userAgent: null,
      })
      .catch(() => undefined);
  }

  if (!decision.allowed) {
    throw rateLimited(decision.retryAfterSeconds);
  }

  return decision;
}

/** True when the value is the shape of a counter key, so a caller can be told rather than guessed at. */
export function isRateLimitKeyHash(value: string): boolean {
  return keyHashPattern.test(value);
}
