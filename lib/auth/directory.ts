// path: lib/auth/directory.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuthConfig } from "./config.ts";
import { classifyAuthAnswer, toAuthAppError } from "./failures.ts";
import type { AuthHttp } from "./http.ts";
import {
  isPlatformRole,
  isUserAccountStatus,
  type ActorRecord,
  type PlatformRole,
} from "./types.ts";

/**
 * The bridge from an identity provider subject to a platform actor.
 *
 * A claim says which Supabase user is calling. It says nothing about whether that person may
 * move money: that answer lives in `public.users` (status, verification, the confirmed TOTP
 * instant) and in the live rows of `public.role_assignments`. This file reads those two tables
 * and produces the `ActorRecord` every permission check uses.
 *
 * ## One request, read by primary key
 *
 * PostgREST can embed the role rows of the user in the same answer, so the lookup is a single
 * request filtered on the primary key with `limit=1`. There is no query in a loop, no "select all
 * and filter in JavaScript" and no second round trip whose failure could leave an actor with a
 * half read role list.
 *
 * ## Why the service role key
 *
 * Row level security on `users` and `role_assignments` is tenant scoped, and at this instant
 * there is no tenant claim yet: the actor is being established, which is what the lookup is for.
 * The request therefore runs as the service role, server side only, and returns a fixed list of
 * columns that contains no secret - no password hash, no TOTP ciphertext, no personal document.
 * The key never leaves this process and is never the key presented for a user facing call.
 *
 * ## What is filtered here
 *
 * A grant is live when it has not been revoked and not been deleted, and its role is one of the
 * seven of FEATURE_LIST section 2. A role row that names anything else is ignored rather than
 * trusted, because a value the platform does not know cannot be a permission the platform grants.
 */

const identifierMaximumLength = 64;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** True when a value is shaped like the uuid a `public.users.id` and a claim subject both are. */
export function isUuidShaped(value: string): boolean {
  return value.length === 36 && uuidPattern.test(value);
}

const roleRowSchema = z.object({
  role: z.string().min(1).max(32),
  revoked_at: z.string().nullable().optional(),
  deleted_at: z.string().nullable().optional(),
});

const actorRowSchema = z.object({
  id: z.string().min(1).max(identifierMaximumLength),
  company_id: z.string().max(identifierMaximumLength).nullable(),
  status: z.string().min(1).max(32),
  email_verified_at: z.string().nullable(),
  totp_confirmed_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  role_assignments: z.array(roleRowSchema).nullable().optional(),
});

const actorRowsSchema = z.array(actorRowSchema);

/**
 * The columns the directory reads.
 *
 * Written out rather than `select=*` so the shape of the answer is the same shape as the type,
 * and so a column added to `public.users` later - a password hash, a document reference - cannot
 * start travelling to the authentication layer by accident.
 */
const actorSelectColumns = [
  "id",
  "company_id",
  "status",
  "email_verified_at",
  "totp_confirmed_at",
  "deleted_at",
  "role_assignments(role,revoked_at,deleted_at)",
].join(",");

/** The port. A later STEP can back it with a pooled database client without touching the reader. */
export interface ActorDirectory {
  findActor(userId: string): Promise<ActorRecord | null>;
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Date.parse(value);

  if (Number.isNaN(parsed)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return parsed;
}

/** Live grants only, deduplicated, in one stable order. */
export function liveRoles(rows: readonly { readonly role: string }[]): readonly PlatformRole[] {
  const roles = new Set<PlatformRole>();

  for (const row of rows) {
    if (isPlatformRole(row.role)) {
      roles.add(row.role);
    }
  }

  return [...roles].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Build the URL of one primary key lookup, exported so the gate can assert its shape. */
export function actorLookupUrl(config: AuthConfig, userId: string): string {
  return (
    `${config.endpoints.usersTable}?select=${actorSelectColumns}` +
    `&id=eq.${encodeURIComponent(userId)}&limit=1`
  );
}

/**
 * The Supabase backed directory.
 *
 * A transport failure and a malformed answer both end as a platform failure, never as "this
 * person has no roles": an identity that could not be read is not an identity with no
 * permissions, and answering a 403 for a database outage would hide an incident.
 */
export function createSupabaseActorDirectory(
  config: AuthConfig,
  http: AuthHttp,
): ActorDirectory {
  return {
    async findActor(userId: string): Promise<ActorRecord | null> {
      // A subject that is not a uuid cannot be a `public.users.id`, so no query is sent.
      if (!isUuidShaped(userId)) {
        return null;
      }

      const answer = await http.send({
        method: "GET",
        url: actorLookupUrl(config, userId),
        apiKey: config.serviceRoleKey,
        bearerToken: config.serviceRoleKey,
      });

      if (!answer.ok) {
        throw toAuthAppError(answer.failure, "session");
      }

      const failure = classifyAuthAnswer(answer.value);

      if (failure !== null) {
        // The directory is an internal read: a rejected key means this deployment is
        // misconfigured, which is a platform problem and not a merchant problem.
        throw new AppError("DEPENDENCY_FAILED");
      }

      const parsed = actorRowsSchema.safeParse(answer.value.body);

      if (!parsed.success || parsed.data.length > 1) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      const row = parsed.data[0];

      if (row === undefined) {
        return null;
      }

      if (!isUserAccountStatus(row.status)) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      const liveRoleRows = (row.role_assignments ?? []).filter(
        (grant) =>
          (grant.revoked_at === null || grant.revoked_at === undefined) &&
          (grant.deleted_at === null || grant.deleted_at === undefined),
      );

      return {
        userId: row.id,
        companyId: row.company_id,
        status: row.status,
        roles: liveRoles(liveRoleRows),
        emailVerifiedAtEpochMs: parseTimestamp(row.email_verified_at),
        totpConfirmedAtEpochMs: parseTimestamp(row.totp_confirmed_at),
        deletedAtEpochMs: parseTimestamp(row.deleted_at),
      };
    },
  };
}

/**
 * A directory in memory.
 *
 * Used by the gate, and by a deployment that has not configured a database yet. It is a port
 * implementation like any other, so it cannot make the session reader behave differently.
 */
export function createInMemoryActorDirectory(
  records: readonly ActorRecord[],
): ActorDirectory {
  const byUserId = new Map<string, ActorRecord>();

  for (const record of records) {
    byUserId.set(record.userId, record);
  }

  return {
    findActor(userId: string): Promise<ActorRecord | null> {
      return Promise.resolve(byUserId.get(userId) ?? null);
    },
  };
}
