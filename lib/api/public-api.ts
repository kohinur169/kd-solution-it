// path: lib/api/public-api.ts
import { z } from "zod";
import type { AuditEntry, AuditTrail } from "../auth/audit.ts";
import { readClientAddress } from "../auth/client-address.ts";
import { AppError, isAppError } from "../errors/app-error.ts";
import { enforceRouteRateLimit, rateLimitHeaders, type RateLimitOutcome } from "../security/rate-limit.ts";
import type { RestClient } from "../auth/rest.ts";
import { CREDENTIAL_KEY_PATTERN, CREDENTIAL_MODES, MERCHANT_API_CREDENTIALS_TABLE } from "./credential-fields.ts";
import { hashOfPresentedKey } from "./credentials.ts";
import {
  API_AUDIT,
  API_AUTH_FIELD,
  API_AUTH_RULES,
  API_CALL_ENTITY,
  API_KEY_HEADER,
  API_KEY_MAXIMUM_LENGTH,
  API_KEY_SCHEME,
  API_LAST_USED_THROTTLE_SECONDS,
  PUBLIC_API_VERSION,
  PUBLIC_API_VERSION_HEADER,
  type ApiPrincipal,
  type PublicApiAnswer,
  type PublicApiContext,
} from "./public-fields.ts";

/**
 * Section 20's public API: authenticate the key, count the call, answer, and write both to the chain.
 *
 * ## The order, and why it is that order
 *
 * **Shape, then hash, then row, then tenant, then counter, then the route.** A header that is missing or not
 * `Bearer kd_test_...` is refused before anything is hashed, because a malformed request should cost the
 * platform one string comparison rather than a SHA-256 and a round trip. A key that is well shaped but unknown
 * is refused with the same rule a revoked key gets, because telling a stranger which of their guesses was close
 * is the enumeration the uniform refusal exists to prevent. The tenant is checked before the counter because a
 * closed merchant should not be able to spend the platform's budget, and the counter runs before the route
 * because a route that is refused must cost nothing but a counter increment.
 *
 * ## What is written, and what is not
 *
 * Every call writes one `api.call` entry - method, route, status, mode, credential, duration - and every failed
 * authentication writes one `api.auth_failed` entry naming the rule and the address. Neither carries the key,
 * the hash of the key, the query string, the body or any header other than the address. A merchant reading
 * their own chain sees that their key was used and when; a stranger reading it learns nothing that would help
 * them guess.
 *
 * ## What this module does not do
 *
 * It does not read a body: a handler that needs one parses it, because the ceiling of a payment is a payment's
 * business and not authentication's. It does not import the framework either: this module answers with a status,
 * a body and a header map, and the route one folder up turns that into a `Response`. That is what lets the gate
 * in this folder drive the whole surface without a server. It does not decide about cookies, sessions or CSRF - a public API call
 * carries a bearer key and no ambient credential, which is precisely why a token from another origin cannot be
 * replayed here. And it does not page or shape its own answers: the route does that, and this module only
 * wraps what the route returns.
 */

/** The dependencies one call needs, injected so the gate can drive it without a database. */
export interface PublicApiDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now: () => number;
}

const credentialSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  label: z.string(),
  mode: z.enum(CREDENTIAL_MODES),
  status: z.enum(["active", "revoked"]),
  key_prefix: z.string(),
  key_last_four: z.string(),
  last_used_at: z.string().nullable(),
  version: z.number().int().positive(),
});

const companySchema = z.object({ id: z.string().uuid(), name: z.string() });

/** A 401 that names a rule and never a reason the caller could use to narrow a guess. */
function refuse(rule: string, field: string = API_AUTH_FIELD): never {
  throw new AppError("AUTHENTICATION_REQUIRED", { details: [{ field, rule }] });
}

/**
 * The key a request presents, or a refusal that says only what shape was wrong.
 *
 * The header is required to be `Bearer` and one token: the scheme is compared case insensitively because
 * HTTP says so, and the token is bounded before it is hashed because a megabyte of `Authorization` should
 * never reach a SHA-256.
 */
export function presentedKeyOf(request: Request): string {
  const header = request.headers.get(API_KEY_HEADER);

  if (header === null || header.trim().length === 0) {
    refuse(API_AUTH_RULES.missing);
  }

  const trimmed = header.trim();
  const separator = trimmed.indexOf(" ");

  if (separator < 0) {
    refuse(API_AUTH_RULES.malformed);
  }

  const scheme = trimmed.slice(0, separator).toLowerCase();
  const token = trimmed.slice(separator + 1).trim();

  if (scheme !== API_KEY_SCHEME || token.length === 0 || token.includes(" ")) {
    refuse(API_AUTH_RULES.malformed);
  }

  if (token.length > API_KEY_MAXIMUM_LENGTH || !CREDENTIAL_KEY_PATTERN.test(token)) {
    refuse(API_AUTH_RULES.malformed);
  }

  return token;
}

/** The chain entry of a failed attempt: the rule, the route and the address, and never the key. */
async function noteAuthFailure(
  dependencies: PublicApiDependencies,
  input: { readonly request: Request; readonly route: string; readonly rule: string },
): Promise<void> {
  const entry: AuditEntry = {
    action: API_AUDIT.authFailed,
    actorUserId: null,
    entityType: API_CALL_ENTITY,
    entityId: null,
    payload: {
      method: input.request.method.toUpperCase(),
      route: input.route,
      rule: input.rule,
    },
    companyId: null,
    sessionId: null,
    ipAddress: readClientAddress(input.request.headers),
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // A refused call is refused whether or not the chain can be written; the refusal is the security answer.
  }
}

/** The chain entry of one call: what it was, what it answered and how long it took. */
async function noteCall(
  dependencies: PublicApiDependencies,
  input: {
    readonly principal: ApiPrincipal;
    readonly request: Request;
    readonly route: string;
    readonly status: number;
    readonly durationMs: number;
  },
): Promise<void> {
  const entry: AuditEntry = {
    action: API_AUDIT.call,
    actorUserId: null,
    entityType: API_CALL_ENTITY,
    entityId: input.principal.credentialId,
    payload: {
      method: input.request.method.toUpperCase(),
      route: input.route,
      status: input.status,
      mode: input.principal.mode,
      duration_ms: input.durationMs,
      key_last_four: input.principal.keyLastFour,
    },
    companyId: input.principal.companyId,
    sessionId: null,
    ipAddress: readClientAddress(input.request.headers),
    userAgent: null,
  };

  try {
    await dependencies.audit.append(entry);
  } catch {
    // An answer already given is not withdrawn because the chain could not record it.
  }
}

/**
 * Refresh `last_used_at`, at most once per throttle window, without ever failing the call.
 *
 * The row's version guards the write, which means two concurrent calls share one update rather than fighting
 * over it: the loser writes nothing and the call proceeds. A merchant's question - "is this key in use?" - is
 * answered by the minute, not by the call.
 */
async function refreshLastUsed(
  dependencies: PublicApiDependencies,
  row: { readonly id: string; readonly version: number; readonly last_used_at: string | null },
): Promise<boolean> {
  const nowMs = dependencies.now();
  const lastUsedMs = row.last_used_at === null ? null : Date.parse(row.last_used_at);

  if (lastUsedMs !== null && Number.isFinite(lastUsedMs) && nowMs - lastUsedMs < API_LAST_USED_THROTTLE_SECONDS * 1_000) {
    return false;
  }

  try {
    await dependencies.rest.update(
      MERCHANT_API_CREDENTIALS_TABLE,
      `id=eq.${encodeURIComponent(row.id)}&status=eq.active&version=eq.${String(row.version)}`,
      { last_used_at: new Date(nowMs).toISOString() },
    );

    return true;
  } catch {
    return false;
  }
}

/**
 * Authenticate one call.
 *
 * The four refusals are the whole of section 20's authentication: a key that is absent, one that is not shaped
 * like a key, one that matches no live row (unknown and revoked are the same answer), and one whose merchant
 * is closed. The last of those is the only refusal that names a state rather than a shape, because a merchant
 * with a closed company needs to know that their key is not the problem.
 */
export async function authenticateApiCall(
  input: { readonly request: Request; readonly route: string },
  dependencies: PublicApiDependencies,
): Promise<ApiPrincipal> {
  let token: string;

  try {
    token = presentedKeyOf(input.request);
  } catch (error) {
    if (isAppError(error)) {
      await noteAuthFailure(dependencies, {
        request: input.request,
        route: input.route,
        rule: error.details[0]?.rule ?? API_AUTH_RULES.malformed,
      });
    }

    throw error;
  }

  const rows = await dependencies.rest.select(
    MERCHANT_API_CREDENTIALS_TABLE,
    "select=id,company_id,label,mode,status,key_prefix,key_last_four,last_used_at,version" +
      `&key_hash=eq.${encodeURIComponent(hashOfPresentedKey(token))}&deleted_at=is.null&limit=1`,
    credentialSchema,
  );
  const row = rows[0];

  if (row === undefined || row.status !== "active") {
    // One rule for both: a revoked key and a key that never existed must read the same from outside.
    await noteAuthFailure(dependencies, {
      request: input.request,
      route: input.route,
      rule: API_AUTH_RULES.invalid,
    });
    refuse(API_AUTH_RULES.invalid);
  }

  const companies = await dependencies.rest.select(
    "companies",
    `select=id,name&id=eq.${encodeURIComponent(row.company_id)}&deleted_at=is.null&limit=1`,
    companySchema,
  );
  const company = companies[0];

  if (company === undefined) {
    await noteAuthFailure(dependencies, {
      request: input.request,
      route: input.route,
      rule: API_AUTH_RULES.accountUnavailable,
    });
    refuse(API_AUTH_RULES.accountUnavailable);
  }

  const lastUsedRefreshed = await refreshLastUsed(dependencies, row);

  return {
    credentialId: row.id,
    companyId: row.company_id,
    companyName: company.name,
    mode: row.mode,
    label: row.label,
    keyPrefix: row.key_prefix,
    keyLastFour: row.key_last_four,
    lastUsedRefreshed,
  };
}

/**
 * One public API call, end to end: authenticate, count, answer, record.
 *
 * The counter is the platform's own (`public_api` class: 300 a minute by address, 1,000 a minute by account,
 * 60 a minute by route), keyed on the **company** rather than the credential, because a merchant with ten keys
 * is one caller and should not be able to multiply their budget by minting more. A refusal is a `429` with
 * `retry-after`, thrown by the limiter so no route can forget it.
 *
 * A route's own refusal is recorded before it is thrown onwards, so the chain has every status this surface
 * answered - including the ones that never reached the handler.
 */
export async function handlePublicApiCall(
  input: {
    readonly request: Request;
    readonly route: string;
    readonly handler: (context: PublicApiContext) => Promise<PublicApiAnswer>;
  },
  dependencies: PublicApiDependencies,
): Promise<Required<PublicApiAnswer>> {
  const startedAt = dependencies.now();
  const method = input.request.method.toUpperCase();
  const clientAddress = readClientAddress(input.request.headers);
  const principal = await authenticateApiCall({ request: input.request, route: input.route }, dependencies);
  let outcome: RateLimitOutcome;

  try {
    outcome = await enforceRouteRateLimit(
      {
        route: input.route,
        method,
        clientAddress,
        // The account bucket is the merchant, not the key: ten credentials are one caller with one budget.
        userId: principal.companyId,
      },
      { rest: dependencies.rest, audit: dependencies.audit, now: dependencies.now },
    );
  } catch (error) {
    if (isAppError(error) && error.code === "RATE_LIMITED") {
      await noteCall(dependencies, {
        principal,
        request: input.request,
        route: input.route,
        status: error.status,
        durationMs: dependencies.now() - startedAt,
      });
    }

    throw error;
  }

  let answer: PublicApiAnswer;

  try {
    answer = await input.handler({ request: input.request, principal, method, route: input.route });
  } catch (error) {
    const status = isAppError(error) ? error.status : 500;

    await noteCall(dependencies, {
      principal,
      request: input.request,
      route: input.route,
      status,
      durationMs: dependencies.now() - startedAt,
    });

    throw error;
  }

  await noteCall(dependencies, {
    principal,
    request: input.request,
    route: input.route,
    status: answer.status,
    durationMs: dependencies.now() - startedAt,
  });

  return {
    status: answer.status,
    body: answer.body,
    headers: {
      ...rateLimitHeaders(outcome, dependencies.now()),
      ...answer.headers,
      // A public API answer is about one merchant's account and must never sit in a cache between them.
      "cache-control": "no-store",
      [PUBLIC_API_VERSION_HEADER]: PUBLIC_API_VERSION,
    },
  };
}
