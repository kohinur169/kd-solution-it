// path: app/(client-portal)/portal-rate-limit.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { AppError, rateLimited } from "../../lib/errors/app-error.ts";
import {
  canonicalRateLimitAddress,
  RATE_LIMIT_AUDIT_ACTION,
  RATE_LIMIT_COUNTER_FUNCTION,
  RATE_LIMIT_RULE,
} from "../../lib/security/rate-limit.ts";

/**
 * The counter every portal write spends, on the platform's own table.
 *
 * ## Why a portal write needs one of its own
 *
 * Every other surface that writes a row is reached by a signed-in account, and
 * `enforceRouteRateLimit` counts it by address and by user. A portal visitor has no user: the link is the
 * credential, and a holder of a link can post it as often as they like. So the count is by the only stable
 * subject a caller has - the address the request came from - and it is kept in
 * `public.rate_limit_windows` through `public.consume_rate_limit`, because a counter in process memory is
 * one counter per instance and no counter at all after a deploy.
 *
 * ## Why each surface brings its own scope
 *
 * `lib/auth/rate-limit.ts` and `lib/security/rate-limit.ts` both hold closed lists of scopes, owned by
 * other STEPs; adding a scope to either would be a change to a completed file. The counter table accepts
 * any lower case name the row's check allows, so the portal block spends its own: an invoice confirmation
 * and a quote signature are counted apart, because they are different decisions with different evidence
 * and one exhausted window must not close the other.
 *
 * ## Why the key is a hash
 *
 * `rate_limit_windows` stores `key_hash` and never the subject, which is `0092`'s whole design. The hash is
 * `sha256(scope + "\n" + canonical address)`: the scope is mixed into the digest as well as stored as a
 * column, so a surface that reused a name would still not share a counter, and the address itself never
 * reaches the table.
 *
 * ## What a caller sees
 *
 * A refusal is `429 RATE_LIMITED` with `retry-after`, which `lib/errors/respond.ts` already writes. The
 * first refusal of a window is audited once, so an operator reading the chain sees an attack rather than a
 * copy of it. A counter that cannot answer is `DEPENDENCY_FAILED`, never a pass: a limiter that opens when
 * the database is down is not a limiter.
 */

/** One surface's ceiling and the window it applies to. The scope is the row's `scope`. */
export interface PortalRateLimitPolicy {
  readonly scope: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The part of the rest client this module needs, so it does not depend on the whole auth client. */
export interface PortalRateLimitClient {
  rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface PortalRateLimitDependencies {
  readonly rest: PortalRateLimitClient;
  readonly audit?: AuditTrail;
  readonly now?: () => number;
}

/** The one row `public.consume_rate_limit` answers with, checked rather than trusted. */
const counterSchema = z
  .array(
    z.object({
      allowed: z.boolean(),
      remaining: z.number().int().min(0),
      retry_after_seconds: z.number().int().min(0),
      first_refusal: z.boolean(),
    }),
  )
  .length(1);

/** What the counter decided. */
export interface PortalRateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
  readonly firstRefusal: boolean;
}

/**
 * The hash one address is counted under.
 *
 * Lower case hex, sixty four characters, which is the shape `rate_limit_windows_key_hash_check` requires.
 * A value that is not an address has no spelling, so it is refused rather than hashed: hashing an
 * arbitrary string would turn a proxy's mistake into a counter of its own.
 */
export function portalRateLimitKeyHash(scope: string, address: string): string {
  const canonical = canonicalRateLimitAddress(address);

  if (canonical === null) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  return createHash("sha256").update(`${scope}\n${canonical}`, "utf8").digest("hex");
}

/** Count one attempt against one policy, and refuse it when the address has spent its window. */
export async function enforcePortalRateLimit(
  policy: PortalRateLimitPolicy,
  input: {
    readonly clientAddress: string;
    readonly userAgent?: string | null;
    readonly companyId?: string | null;
    /** The path the refusal is recorded under, so the chain names the surface that was attacked. */
    readonly route: string;
  },
  dependencies: PortalRateLimitDependencies,
): Promise<PortalRateLimitDecision> {
  const canonical = canonicalRateLimitAddress(input.clientAddress);

  if (canonical === null) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  const keyHash = portalRateLimitKeyHash(policy.scope, canonical);
  const nowMs = dependencies.now?.() ?? Date.now();

  const body = await dependencies.rest.rpc(RATE_LIMIT_COUNTER_FUNCTION, {
    p_scope: policy.scope,
    p_key_hash: keyHash,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
    p_now: new Date(nowMs).toISOString(),
  });

  const parsed = counterSchema.safeParse(body);
  const answer = parsed.success ? parsed.data[0] : undefined;

  if (answer === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  const decision: PortalRateLimitDecision = {
    allowed: answer.allowed,
    remaining: answer.remaining,
    retryAfterSeconds: answer.retry_after_seconds,
    firstRefusal: answer.first_refusal,
  };

  if (decision.firstRefusal && dependencies.audit !== undefined) {
    await dependencies.audit
      .append({
        action: RATE_LIMIT_AUDIT_ACTION,
        actorUserId: null,
        entityType: "rate_limit_window",
        entityId: null,
        payload: {
          route: input.route,
          method: "POST",
          class: null,
          rule: RATE_LIMIT_RULE,
          limit: policy.limit,
          window_seconds: policy.windowSeconds,
          retry_after_seconds: decision.retryAfterSeconds,
          // The hash and the address are the split `0092` makes: the counter is keyed by a digest and the
          // audit trail, which only an operator reads, records what the digest was of.
          key_hash: keyHash,
          scopes: [policy.scope],
          buckets: ["ip"],
        },
        companyId: input.companyId ?? null,
        ipAddress: canonical,
        userAgent: input.userAgent ?? null,
      })
      .catch(() => undefined);
  }

  if (!decision.allowed) {
    throw rateLimited(decision.retryAfterSeconds);
  }

  return decision;
}

/** The headers a route can copy onto its own answer, so a caller can see its own budget. */
export function portalRateLimitHeaders(
  policy: PortalRateLimitPolicy,
  decision: PortalRateLimitDecision,
): Readonly<Record<string, string>> {
  return {
    "ratelimit-limit": String(policy.limit),
    "ratelimit-remaining": String(decision.remaining),
    "cache-control": "no-store",
  };
}
