// path: lib/auth/client.ts
import { z } from "zod";
import {
  AUTH_PASSWORD_GRANT,
  AUTH_REFRESH_GRANT,
  authTokenUrl,
  type AuthConfig,
} from "./config.ts";
import { classifyAuthAnswer } from "./failures.ts";
import { createAuthHttpForConfig, type AuthHttp } from "./http.ts";
import type { AuthFailure, AuthOutcome, AuthSession, AuthUser } from "./types.ts";

/**
 * The Supabase Auth client of the server.
 *
 * Six operations and one rule. The operations are the ones FEATURE_LIST section 22 needs before
 * any route exists - create an account, exchange a password for a session, exchange an email
 * token for a session, resend a verification mail, start a password reset, refresh a session,
 * read the user of a token and end a session. The rule is that no method ever returns an
 * upstream sentence, and none of them answers differently for an unknown account than for a
 * wrong password.
 *
 * ## What this client is not
 *
 * It is not a browser SDK. Every call is made from the server with the anonymous key, and the
 * resulting tokens are written into the HttpOnly cookie of `cookies.ts`. The browser therefore
 * never sees an access token, never holds a refresh token where a script could read it, and has
 * no way to call the project directly.
 *
 * ## The two anonymous endpoints that must not disclose
 *
 * `POST /recover` and `POST /resend` are the two calls a stranger can make with someone else's
 * email address. Their purpose is to send a mail, and any difference in the answer - a status, a
 * body, an elapsed time - would let that stranger learn whether the address has an account. The
 * client treats a rejection of those two calls as an accepted call: the request is dropped, the
 * answer says nothing, and the rate limiter (STEP 045) is what stops the abuse.
 *
 * ## Why `fetch` and not `@supabase/supabase-js`
 *
 * The dependency is not installed, `package.json` belongs to the integrator, and the SDK adds a
 * browser oriented session store this platform deliberately replaces with its own cookie. The
 * REST surface those methods wrap is what this file calls, and an injected transport is what
 * lets the gate prove every branch without a project.
 */

const accessTokenMaximumLength = 4_096;
const refreshTokenMaximumLength = 2_048;

const userSchema = z.object({
  id: z.string().min(1).max(64),
  email: z.string().min(3).max(254).nullable().optional(),
  email_confirmed_at: z.string().max(40).nullable().optional(),
  confirmed_at: z.string().max(40).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  last_sign_in_at: z.string().max(40).nullable().optional(),
  // The identities of the person. A provider that refuses to say "this address is taken" answers
  // the existing user with an empty list instead, which is the only duplicate signal it offers.
  identities: z.array(z.unknown()).max(16).optional(),
  user_metadata: z
    .looseObject({ full_name: z.string().min(1).max(120).optional() })
    .nullable()
    .optional(),
});

const sessionBodySchema = z.object({
  access_token: z.string().min(1).max(accessTokenMaximumLength),
  refresh_token: z.string().min(1).max(refreshTokenMaximumLength),
  expires_in: z.number().int().positive().max(86_400).optional(),
  expires_at: z.number().int().positive().optional(),
  token_type: z.string().max(32).optional(),
  user: userSchema,
});

const signUpBodySchema = z.object({
  id: z.string().min(1).max(64).optional(),
  user: userSchema.optional(),
  access_token: z.string().min(1).max(accessTokenMaximumLength).optional(),
  refresh_token: z.string().min(1).max(refreshTokenMaximumLength).optional(),
  expires_in: z.number().int().positive().max(86_400).optional(),
  expires_at: z.number().int().positive().optional(),
});

/** The email token types this platform accepts. A recovery link is a session, so it is one. */
export const EMAIL_TOKEN_TYPES = ["signup", "email", "recovery", "email_change"] as const;

export type EmailTokenType = (typeof EMAIL_TOKEN_TYPES)[number];

export interface PasswordSignInInput {
  readonly email: string;
  readonly password: string;
}

export interface SignUpInput {
  readonly email: string;
  readonly password: string;
  readonly fullName: string;
  /** Where a confirmation link returns the merchant. Must be on the platform's own origin. */
  readonly redirectTo?: string;
}

export interface VerifyEmailTokenInput {
  readonly tokenHash: string;
  readonly type: EmailTokenType;
}

/**
 * What the provider's answer says about the person behind an address.
 *
 * The three values exist because the provider has three answers and only one of them is safe to
 * act on destructively:
 *
 *   - `new` - an identity was created for this address. The identifier is ours to clean up;
 *   - `existing` - the address is already registered, and the provider hid that fact by answering
 *     the *existing* person with an empty identity list. The identifier belongs to someone else;
 *   - `unknown` - the provider answered a person but listed no identities at all, which a version
 *     that does not obfuscate can do. Nothing may be concluded, so nothing may be deleted.
 *
 * STEP 048 owns the consequences; this module only reports the fact without inventing one.
 */
export type SignUpIdentity = "new" | "existing" | "unknown";

/**
 * The result of a registration.
 *
 * `userId` is the invariant STEP 038 relies on: the platform row in `public.users` is created
 * with this identifier, so a later claim subject is a `public.users.id` with no translation.
 * `identity` is how much that identifier can be trusted, and it is the field a caller must read
 * before treating a failed write as something to undo.
 */
export interface SignUpResult {
  readonly userId: string;
  readonly session: AuthSession | null;
  readonly identity: SignUpIdentity;
}

export interface AuthClient {
  signInWithPassword(input: PasswordSignInInput): Promise<AuthOutcome<AuthSession>>;
  signUpWithPassword(input: SignUpInput): Promise<AuthOutcome<SignUpResult>>;
  verifyEmailToken(input: VerifyEmailTokenInput): Promise<AuthOutcome<AuthSession>>;
  resendVerificationEmail(email: string): Promise<AuthOutcome<void>>;
  requestPasswordReset(email: string, redirectTo?: string): Promise<AuthOutcome<void>>;
  refreshSession(refreshToken: string): Promise<AuthOutcome<AuthSession>>;
  signOut(accessToken: string): Promise<AuthOutcome<void>>;
  getUser(accessToken: string): Promise<AuthOutcome<AuthUser>>;
}

function failureOf(kind: AuthFailure["kind"]): AuthFailure {
  return { kind, status: null, code: null, retryAfterSeconds: null };
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : parsed;
}

function toAuthUser(user: z.infer<typeof userSchema>): AuthUser | null {
  // A platform account is an email account: section 22 verifies an address and sends every
  // notification to it. An answer without an address is not an account this platform created.
  if (user.email === null || user.email === undefined) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    emailConfirmedAtEpochMs: parseTimestamp(
      user.email_confirmed_at ?? user.confirmed_at ?? null,
    ),
    phone: user.phone ?? null,
    lastSignInAtEpochMs: parseTimestamp(user.last_sign_in_at ?? null),
    fullName: user.user_metadata?.full_name ?? null,
  };
}

function toSession(body: unknown, nowEpochMs: number): AuthSession | null {
  const parsed = sessionBodySchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  const value = parsed.data;
  const user = toAuthUser(value.user);

  if (user === null) {
    return null;
  }

  const expiresAtEpochMs =
    value.expires_at === undefined ? nowEpochMs + (value.expires_in ?? 3_600) * 1000 : value.expires_at * 1000;

  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    expiresAtEpochMs,
    expiresInSeconds: value.expires_in ?? Math.max(0, Math.round((expiresAtEpochMs - nowEpochMs) / 1000)),
    user,
  };
}

function withRedirect(url: string, redirectTo: string | undefined): string {
  if (redirectTo === undefined) {
    return url;
  }

  return `${url}?redirect_to=${encodeURIComponent(redirectTo)}`;
}

export function createAuthClient(
  config: AuthConfig,
  http: AuthHttp = createAuthHttpForConfig(config),
): AuthClient {
  async function exchange(url: string, body: unknown): Promise<AuthOutcome<AuthSession>> {
    const answer = await http.send({
      method: "POST",
      url,
      apiKey: config.anonymousKey,
      body,
    });

    if (!answer.ok) {
      return { ok: false, failure: answer.failure };
    }

    const failure = classifyAuthAnswer(answer.value);

    if (failure !== null) {
      return { ok: false, failure };
    }

    const session = toSession(answer.value.body, Date.now());

    return session === null ? { ok: false, failure: failureOf("malformed-response") } : { ok: true, value: session };
  }

  async function accepted(
    url: string,
    body: unknown,
    options: { readonly silenceRejection: boolean },
  ): Promise<AuthOutcome<void>> {
    const answer = await http.send({ method: "POST", url, apiKey: config.anonymousKey, body });

    if (!answer.ok) {
      return { ok: false, failure: answer.failure };
    }

    const failure = classifyAuthAnswer(answer.value);

    if (failure === null) {
      return { ok: true, value: undefined };
    }

    if (options.silenceRejection && failure.kind === "rejected") {
      return { ok: true, value: undefined };
    }

    return { ok: false, failure };
  }

  return {
    signInWithPassword(input: PasswordSignInInput): Promise<AuthOutcome<AuthSession>> {
      return exchange(authTokenUrl(config, AUTH_PASSWORD_GRANT), {
        email: input.email,
        password: input.password,
      });
    },

    async signUpWithPassword(input: SignUpInput): Promise<AuthOutcome<SignUpResult>> {
      const answer = await http.send({
        method: "POST",
        url: withRedirect(config.endpoints.signUp, input.redirectTo),
        apiKey: config.anonymousKey,
        body: {
          email: input.email,
          password: input.password,
          data: { full_name: input.fullName },
        },
      });

      if (!answer.ok) {
        return { ok: false, failure: answer.failure };
      }

      const failure = classifyAuthAnswer(answer.value);

      if (failure !== null) {
        return { ok: false, failure };
      }

      const parsed = signUpBodySchema.safeParse(answer.value.body);

      if (!parsed.success) {
        return { ok: false, failure: failureOf("malformed-response") };
      }

      const userId = parsed.data.user?.id ?? parsed.data.id;

      if (userId === undefined) {
        return { ok: false, failure: failureOf("malformed-response") };
      }

      // A project with confirmations disabled answers with a session, and that session is
      // returned as is. A project with confirmations enabled answers with only the user, and the
      // merchant signs in after the link is followed.
      const registeredUser = parsed.data.user;
      // An address the provider already holds is answered with the existing person and an empty
      // identity list, and never with a session. Read before the session branch below, because
      // that branch treats a missing session as "check your mail" - which would be a new account
      // that was never created.
      const identity: SignUpIdentity =
        registeredUser === undefined
          ? "unknown"
          : parsed.data.access_token !== undefined
            ? "new"
            : registeredUser.identities === undefined
              ? "unknown"
              : registeredUser.identities.length === 0
                ? "existing"
                : "new";

      if (
        parsed.data.access_token === undefined ||
        parsed.data.refresh_token === undefined ||
        registeredUser === undefined
      ) {
        return { ok: true, value: { userId, session: null, identity } };
      }

      const session = toSession(
        {
          access_token: parsed.data.access_token,
          refresh_token: parsed.data.refresh_token,
          expires_in: parsed.data.expires_in,
          expires_at: parsed.data.expires_at,
          user: registeredUser,
        },
        Date.now(),
      );

      return { ok: true, value: { userId, session, identity } };
    },

    verifyEmailToken(input: VerifyEmailTokenInput): Promise<AuthOutcome<AuthSession>> {
      return exchange(config.endpoints.verify, {
        token_hash: input.tokenHash,
        type: input.type,
      });
    },

    resendVerificationEmail(email: string): Promise<AuthOutcome<void>> {
      return accepted(
        config.endpoints.resend,
        { type: "signup", email },
        { silenceRejection: true },
      );
    },

    requestPasswordReset(email: string, redirectTo?: string): Promise<AuthOutcome<void>> {
      return accepted(
        withRedirect(config.endpoints.recover, redirectTo),
        { email },
        { silenceRejection: true },
      );
    },

    refreshSession(refreshToken: string): Promise<AuthOutcome<AuthSession>> {
      return exchange(authTokenUrl(config, AUTH_REFRESH_GRANT), { refresh_token: refreshToken });
    },

    async signOut(accessToken: string): Promise<AuthOutcome<void>> {
      const answer = await http.send({
        method: "POST",
        url: config.endpoints.logout,
        apiKey: config.anonymousKey,
        bearerToken: accessToken,
        body: {},
      });

      if (!answer.ok) {
        return { ok: false, failure: answer.failure };
      }

      const failure = classifyAuthAnswer(answer.value);

      // A token that is already gone is a signed out session, which is the outcome asked for.
      if (failure !== null && failure.kind === "rejected") {
        return { ok: true, value: undefined };
      }

      return failure === null ? { ok: true, value: undefined } : { ok: false, failure };
    },

    async getUser(accessToken: string): Promise<AuthOutcome<AuthUser>> {
      const answer = await http.send({
        method: "GET",
        url: config.endpoints.user,
        apiKey: config.anonymousKey,
        bearerToken: accessToken,
      });

      if (!answer.ok) {
        return { ok: false, failure: answer.failure };
      }

      const failure = classifyAuthAnswer(answer.value);

      if (failure !== null) {
        return { ok: false, failure };
      }

      const parsed = userSchema.safeParse(answer.value.body);

      if (!parsed.success) {
        return { ok: false, failure: failureOf("malformed-response") };
      }

      const user = toAuthUser(parsed.data);

      return user === null
        ? { ok: false, failure: failureOf("malformed-response") }
        : { ok: true, value: user };
    },
  };
}
