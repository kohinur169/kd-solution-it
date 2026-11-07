// path: app/(client-portal)/portal-invoice-rate-limit.ts
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
import { PORTAL_ACCEPTANCE_RATE_LIMIT } from "./portal-invoice-fields.ts";

/**
 * The confirmation's own counter.
 *
 * ## Why this write needs a limit of its own
 *
 * Every other surface that writes a row is reached by a signed-in account, and `enforceRouteRateLimit`
 * counts it by its address and its user. A portal confirmation has no user: the link is the credential.
 * So it is counted by the only stable subject a caller has - the address it arrives from - and it is
 * counted on the platform's own table through `public.consume_rate_limit`, because a limit in process
 * memory is one limit per instance and no limit at all after a deploy.
 *
 * ## Why the scope is this STEP's
 *
 * `lib/auth/rate-limit.ts` and `lib/security/rate-limit.ts` both hold closed lists of scopes, owned by
 * other STEPs, and a scope added to either would be a change to a completed file. The table's own check
 * accepts any lower case name, so this STEP spends its own: `portal_acceptance`, ten attempts per
 * address per ten minutes, which is one confirmation and a generous allowance for the mistakes around
 * it.
 *
 * ## Why the key is a hash
 *
 * `rate_limit_windows` stores `key_hash` and never the subject, which is `0092`'s whole design. The hash
 * here is `sha256("portal_acceptance\n" + canonical address)`: the scope is mixed in as well as stored as
 * a column, so a future surface that reused the name would still not share the counter, and the address
 * itself never reaches the table.
 *
 * ## What a caller sees
 *
 * A refusal is `429 RATE_LIMITED` with `retry-after`, which `lib/errors/respond.ts` already writes. The
 * first refusal of a window is recorded once, so an operator reading the chain sees an attack rather than
 * a copy of it, and the entry carries the key hash and the address - the same split the table makes.
 * A counter that cannot answer is `DEPENDENCY_FAILED`, never a pass: a limiter that opens when the
 * database is down is not a limiter.
 */

/** The part of the rest client this module needs. */
export interface PortalRateLimitClient {
  rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface PortalRateLimitDependencies {
  readonly rest: PortalRateLimitClient;
  readonly audit?: AuditTrail;
  readonly now?: () => number;
}

/** The one row `public.consume_rate_limit` answers with, checked rather than trusted. */
const counterSchema = z.array(
  z.object({
    allowed: z.boolean(),
    remaining: z.number().int().min(0),
    retry_after_seconds: z.number().int().min(0),
    first_refusal: z.boolean(),
  }),
).length(1);

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
 * arbitrary string would silently turn a proxy's mistake into a counter of its own.
 */
export function portalRateLimitKeyHash(address: string): string {
  const canonical = canonicalRateLimitAddress(address);

  if (canonical === null) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  return createHash("sha256")
    .update(`${PORTAL_ACCEPTANCE_RATE_LIMIT.scope}\n${canonical}`, "utf8")
    .digest("hex");
}

/**
 * Count one confirmation attempt, and refuse it when the address has spent its window.
 *
 * The address is the caller's, already read from the request headers by `readClientAddress`, so no
 * caller of this function can choose a subject that is not the one the request came from.
 */
export async function enforcePortalAcceptanceRateLimit(
  input: {
    readonly clientAddress: string;
    readonly userAgent?: string | null;
    readonly companyId?: string | null;
  },
  dependencies: PortalRateLimitDependencies,
): Promise<PortalRateLimitDecision> {
  const canonical = canonicalRateLimitAddress(input.clientAddress);

  if (canonical === null) {
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  const keyHash = portalRateLimitKeyHash(canonical);
  const nowMs = dependencies.now?.() ?? Date.now();

  const body = await dependencies.rest.rpc(RATE_LIMIT_COUNTER_FUNCTION, {
    p_scope: PORTAL_ACCEPTANCE_RATE_LIMIT.scope,
    p_key_hash: keyHash,
    p_limit: PORTAL_ACCEPTANCE_RATE_LIMIT.limit,
    p_window_seconds: PORTAL_ACCEPTANCE_RATE_LIMIT.windowSeconds,
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
          route: "/i/[token]/acceptance",
          method: "POST",
          class: null,
          rule: RATE_LIMIT_RULE,
          limit: PORTAL_ACCEPTANCE_RATE_LIMIT.limit,
          window_seconds: PORTAL_ACCEPTANCE_RATE_LIMIT.windowSeconds,
          retry_after_seconds: decision.retryAfterSeconds,
          // The hash and the address are the split `0092` makes: the counter is keyed by a digest and
          // the audit trail, which only an operator reads, records what the digest was of.
          key_hash: keyHash,
          scopes: [PORTAL_ACCEPTANCE_RATE_LIMIT.scope],
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
  decision: PortalRateLimitDecision,
): Readonly<Record<string, string>> {
  return {
    "ratelimit-limit": String(PORTAL_ACCEPTANCE_RATE_LIMIT.limit),
    "ratelimit-remaining": String(decision.remaining),
    "cache-control": "no-store",
  };
}
