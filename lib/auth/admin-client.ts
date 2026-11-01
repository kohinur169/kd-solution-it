// path: lib/auth/admin-client.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { authAdminUserUrl, type AuthConfig } from "./config.ts";
import { classifyAuthAnswer } from "./failures.ts";
import { createAuthHttpForConfig, type AuthHttp } from "./http.ts";
import type { AuthFailure, AuthOutcome } from "./types.ts";

/**
 * The service role client: the operations that act on an account from the platform side.
 *
 * Section 22 asks for things a person cannot do for themselves - the office resets 2FA after
 * documents are verified, an unlock is recorded, a session is revoked instantly when a device is
 * lost - and every one of them needs an identity provider call made with a key no browser holds.
 * That key is `SUPABASE_SERVICE_ROLE_KEY`: it bypasses row level security, so it is presented
 * only here, only from the server, and only for a request this module built.
 *
 * The functions in this file never decide whether an office user may do something. They are the
 * mechanism; the permission check and the audit row belong to the STEP that calls them (046
 * unlock, 054 session revocation). This keeps one place where "may this person do that" is
 * answered, and one place where "tell Supabase" happens.
 *
 * ## What is deliberately absent
 *
 * No list-all-users call: a method that can page through every account is a data protection
 * incident waiting for a missing authorisation check. A caller who needs an account names it by
 * identifier. No password read: the provider cannot return one. No email send: the platform's
 * own mail pipeline (section 23) owns that, so calling the provider's mailer would double send.
 */

const identifierMaximumLength = 64;

const adminUserSchema = z.object({
  id: z.string().min(1).max(identifierMaximumLength),
  email: z.string().min(3).max(254).nullable().optional(),
});

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface AdminCreateUserInput {
  readonly email: string;
  /** The operator's initial password. STEP 040 enforces the policy before this is reached. */
  readonly password: string;
  readonly fullName: string;
  /**
   * The identifier of the account. Supplied so `public.users.id` and the provider's user id are
   * the same value from the first instant, which is what makes a claim subject usable as the key
   * of the platform row.
   */
  readonly userId: string;
  /** True when the platform has already proved the address, as the bootstrap runbook has. */
  readonly emailConfirmed: boolean;
}

export interface AdminUpdateUserInput {
  readonly email?: string;
  readonly password?: string;
  readonly fullName?: string;
  readonly emailConfirmed?: boolean;
}

export interface AdminUser {
  readonly userId: string;
  readonly email: string | null;
}

export interface AdminAuthClient {
  createUser(input: AdminCreateUserInput): Promise<AuthOutcome<AdminUser>>;
  updateUser(userId: string, input: AdminUpdateUserInput): Promise<AuthOutcome<AdminUser>>;
  deleteUser(userId: string): Promise<AuthOutcome<void>>;
  /** Revoke every live session of one account, everywhere. Used on a lost device and on a reset. */
  revokeUserSessions(userId: string): Promise<AuthOutcome<void>>;
  getUser(userId: string): Promise<AuthOutcome<AdminUser>>;
}

function failureOf(kind: AuthFailure["kind"]): AuthFailure {
  return { kind, status: null, code: null, retryAfterSeconds: null };
}

function requireIdentifier(userId: string): string {
  if (userId.length > identifierMaximumLength || !uuidPattern.test(userId)) {
    // An identifier that is not a uuid is a bug in the caller, not input from a browser.
    throw new AppError("INTERNAL_ERROR");
  }

  return userId;
}

function requireSomeChange(input: AdminUpdateUserInput): void {
  if (
    input.email === undefined &&
    input.password === undefined &&
    input.fullName === undefined &&
    input.emailConfirmed === undefined
  ) {
    throw new AppError("VALIDATION_FAILED");
  }
}

function toAdminUser(body: unknown): AdminUser | null {
  const parsed = adminUserSchema.safeParse(body);

  if (!parsed.success) {
    return null;
  }

  return { userId: parsed.data.id, email: parsed.data.email ?? null };
}

/** The body of a create or an update. Only the fields the caller supplied are sent. */
interface AdminUserBody {
  email?: string;
  password?: string;
  user_metadata?: { full_name: string };
  email_confirm?: boolean;
}

function buildUserBody(
  email: string | undefined,
  password: string | undefined,
  fullName: string | undefined,
  emailConfirmed: boolean | undefined,
): AdminUserBody {
  const body: AdminUserBody = {};

  if (email !== undefined) {
    body.email = email;
  }

  if (password !== undefined) {
    body.password = password;
  }

  if (fullName !== undefined) {
    body.user_metadata = { full_name: fullName };
  }

  if (emailConfirmed !== undefined) {
    body.email_confirm = emailConfirmed;
  }

  return body;
}

export function createAuthAdminClient(
  config: AuthConfig,
  http: AuthHttp = createAuthHttpForConfig(config),
): AdminAuthClient {
  async function sendUser(
    method: "POST" | "PUT" | "DELETE" | "GET",
    url: string,
    body: unknown,
  ): Promise<AuthOutcome<unknown>> {
    const answer = await http.send({
      method,
      url,
      apiKey: config.serviceRoleKey,
      bearerToken: config.serviceRoleKey,
      ...(body === undefined ? {} : { body }),
    });

    if (!answer.ok) {
      return { ok: false, failure: answer.failure };
    }

    const failure = classifyAuthAnswer(answer.value);

    return failure === null
      ? { ok: true, value: answer.value.body }
      : { ok: false, failure };
  }

  return {
    async createUser(input: AdminCreateUserInput): Promise<AuthOutcome<AdminUser>> {
      const userId = requireIdentifier(input.userId);
      const body = {
        ...buildUserBody(input.email, input.password, input.fullName, input.emailConfirmed),
        id: userId,
      };
      const answer = await sendUser("POST", config.endpoints.adminUsers, body);

      if (!answer.ok) {
        return answer;
      }

      const user = toAdminUser(answer.value);

      return user === null
        ? { ok: false, failure: failureOf("malformed-response") }
        : { ok: true, value: user };
    },

    async updateUser(
      userId: string,
      input: AdminUpdateUserInput,
    ): Promise<AuthOutcome<AdminUser>> {
      const identifier = requireIdentifier(userId);
      requireSomeChange(input);

      const body = buildUserBody(
        input.email,
        input.password,
        input.fullName,
        input.emailConfirmed,
      );
      const answer = await sendUser("PUT", authAdminUserUrl(config, identifier), body);

      if (!answer.ok) {
        return answer;
      }

      const user = toAdminUser(answer.value);

      return user === null
        ? { ok: false, failure: failureOf("malformed-response") }
        : { ok: true, value: user };
    },

    async deleteUser(userId: string): Promise<AuthOutcome<void>> {
      const identifier = requireIdentifier(userId);
      const answer = await sendUser("DELETE", authAdminUserUrl(config, identifier), undefined);

      return answer.ok ? { ok: true, value: undefined } : answer;
    },

    async revokeUserSessions(userId: string): Promise<AuthOutcome<void>> {
      const identifier = requireIdentifier(userId);
      // Global scope ends every session of the account, not only the one of the current token:
      // a lost laptop and a stolen backup code both need the wider answer.
      const answer = await sendUser(
        "POST",
        `${authAdminUserUrl(config, identifier)}/logout?scope=global`,
        {},
      );

      return answer.ok ? { ok: true, value: undefined } : answer;
    },

    async getUser(userId: string): Promise<AuthOutcome<AdminUser>> {
      const identifier = requireIdentifier(userId);
      const answer = await sendUser(
        "GET",
        authAdminUserUrl(config, identifier),
        undefined,
      );

      if (!answer.ok) {
        return answer;
      }

      const user = toAdminUser(answer.value);

      return user === null
        ? { ok: false, failure: failureOf("malformed-response") }
        : { ok: true, value: user };
    },
  };
}
