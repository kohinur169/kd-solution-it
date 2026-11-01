// path: lib/auth/request-actor.ts
import type { ActorDirectory } from "./directory.ts";
import type { AuthCookiePolicy } from "./cookies.ts";
import { readSession, requireActor } from "./session.ts";
import type { RequestActor } from "./types.ts";

/**
 * The actor of one request, for a route that is only available to a signed in person.
 *
 * Three lines that would otherwise be copied into every handler, and the copy is where the mistake
 * lives: one handler reading the cookie with a different policy, one handler answering 403 where
 * 401 belongs, one handler trusting the cookie without asking the directory. `readSession` does the
 * work - signature, expiry, the row that decides whether the account is still open - and
 * `requireActor` turns a rejection into the catalogue's `AUTHENTICATION_REQUIRED`.
 *
 * The two factor routes of STEP 041 are the first callers. Every authenticated route of a later
 * STEP calls this rather than decoding a token itself.
 */

export interface RequestActorOptions {
  readonly directory: ActorDirectory;
  readonly cookiePolicy: AuthCookiePolicy;
  /** Fixed instant, for a gate that must not depend on the wall clock. */
  readonly nowEpochMs?: number;
}

export async function readRequestActor(
  cookieHeader: string | null,
  options: RequestActorOptions,
): Promise<RequestActor> {
  const state = await readSession(cookieHeader, {
    directory: options.directory,
    cookiePolicy: options.cookiePolicy,
    ...(options.nowEpochMs === undefined ? {} : { nowEpochMs: options.nowEpochMs }),
  });

  return requireActor(state);
}
