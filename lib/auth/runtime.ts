// path: lib/auth/runtime.ts
import { getServerConfig } from "../../config/server.ts";
import { serverEnv } from "../env/server.ts";
import { createAuthAdminClient, type AdminAuthClient } from "./admin-client.ts";
import {
  BREACH_RANGE_MAXIMUM_BYTES,
  createBreachCheck,
  type BreachCheck,
} from "./breach-check.ts";
import { createRestAuditTrail, type AuditTrail } from "./audit.ts";
import { createAuthClient, type AuthClient } from "./client.ts";
import { createAuthCookiePolicy, type AuthCookiePolicy } from "./cookies.ts";
import { getAuthConfig, type AuthConfig } from "./config.ts";
import {
  createRestLoginAttemptRecorder,
  type LoginAttemptRecorder,
} from "./login-attempts.ts";
import { createAuthHttpForConfig, type AuthHttp } from "./http.ts";
import { createRestPolicyCatalog, type PolicyCatalog } from "./policies.ts";
import { createSupabaseActorDirectory, type ActorDirectory } from "./directory.ts";
import { createRestClient, type RestClient } from "./rest.ts";
import { createRestSettings, type PlatformSettings } from "./settings.ts";
import { createTurnstileGuard, type TurnstileGuard } from "./turnstile.ts";

/**
 * The real implementations, assembled once per process.
 *
 * A route handler asks for this object and calls the service, and nothing in the handler builds a
 * client, reads an environment variable or decides which key to use. The gate replaces the whole
 * object with in memory doubles, which is what makes the same service provable without a project,
 * a database or a network.
 *
 * Nothing is built at import time. `getAuthConfig()` reads the validated environment, so building
 * this object during a page data collection pass would make a build machine need runtime secrets;
 * the first call inside a request builds it, and every later call reuses it.
 */

/**
 * The lifetime of a session cookie.
 *
 * The provider issues a short lived access token and a refresh token that outlives it; the cookie
 * carries both, so its lifetime is the refresh window. A later STEP that rotates the token (051)
 * shortens the window and rewrites this constant through the same policy.
 */
export const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface AuthRuntime {
  readonly config: AuthConfig;
  readonly http: AuthHttp;
  readonly rest: RestClient;
  readonly settings: PlatformSettings;
  readonly client: AuthClient;
  readonly admin: AdminAuthClient;
  readonly turnstile: TurnstileGuard;
  readonly breachCheck: BreachCheck;
  readonly policies: PolicyCatalog;
  readonly audit: AuditTrail;
  readonly attempts: LoginAttemptRecorder;
  readonly cookiePolicy: AuthCookiePolicy;
  /** Reads an actor for a cookie: the session of STEP 039 and of every authenticated route. */
  readonly directory: ActorDirectory;
  /**
   * The key that seals a secret at rest, read lazily from the environment.
   *
   * Exposed as a function rather than a value for the reason the whole object is built lazily: a
   * module that captured the key at import time would make a build machine need a runtime secret.
   */
  readonly masterKey: () => string;
}

let runtime: AuthRuntime | undefined;

export function getAuthRuntime(): AuthRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  const config = getAuthConfig();
  const http = createAuthHttpForConfig(config);
  const server = getServerConfig();
  const settings = createRestSettings(config, http, () => serverEnv().ENCRYPTION_MASTER_KEY);
  // A breached password range is plain text of a few hundred kilobytes, so this endpoint needs its
  // own ceiling; every other call keeps the 64 KiB identity provider bound.
  const rangeHttp = createAuthHttpForConfig(config, {
    maximumResponseBytes: BREACH_RANGE_MAXIMUM_BYTES,
  });

  runtime = {
    config,
    http,
    rest: createRestClient(config, http),
    settings,
    client: createAuthClient(config, http),
    admin: createAuthAdminClient(config, http),
    turnstile: createTurnstileGuard({
      settings,
      http,
      isProduction: server.isProduction,
    }),
    breachCheck: createBreachCheck({
      settings,
      http: rangeHttp,
      isProduction: server.isProduction,
    }),
    policies: createRestPolicyCatalog(config, http),
    audit: createRestAuditTrail({
      config,
      http,
      signingKey: () => serverEnv().AUDIT_SIGNING_KEY,
    }),
    attempts: createRestLoginAttemptRecorder(createRestClient(config, http)),
    cookiePolicy: createAuthCookiePolicy(config, AUTH_SESSION_MAX_AGE_SECONDS),
    directory: createSupabaseActorDirectory(config, http),
    masterKey: () => serverEnv().ENCRYPTION_MASTER_KEY,
  };

  return runtime;
}
