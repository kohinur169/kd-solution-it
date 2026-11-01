// path: lib/auth/runtime.ts
import { getServerConfig } from "../../config/server.ts";
import { serverEnv } from "../env/server.ts";
import { createAuthAdminClient, type AdminAuthClient } from "./admin-client.ts";
import { createRestAuditTrail, type AuditTrail } from "./audit.ts";
import { createAuthClient, type AuthClient } from "./client.ts";
import { createAuthCookiePolicy, type AuthCookiePolicy } from "./cookies.ts";
import { getAuthConfig, type AuthConfig } from "./config.ts";
import { createAuthHttpForConfig, type AuthHttp } from "./http.ts";
import { createRestPolicyCatalog, type PolicyCatalog } from "./policies.ts";
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
  readonly policies: PolicyCatalog;
  readonly audit: AuditTrail;
  readonly cookiePolicy: AuthCookiePolicy;
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
    policies: createRestPolicyCatalog(config, http),
    audit: createRestAuditTrail({
      config,
      http,
      signingKey: () => serverEnv().AUDIT_SIGNING_KEY,
    }),
    cookiePolicy: createAuthCookiePolicy(config, AUTH_SESSION_MAX_AGE_SECONDS),
  };

  return runtime;
}
