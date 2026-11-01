// path: app/(admin)/office-actor.ts
import { headers } from "next/headers";
import { cache } from "react";
import type { OfficeActorState } from "@/components/office/navigation";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";

/**
 * The account behind one office request, read once per request.
 *
 * ## Why this is its own module
 *
 * The layout decides who may enter the office, and the page inside it renders what that account may
 * do. Both need the same account, and reading it twice would mean two directory reads, two cookie
 * parses and - worse - two answers if the second read landed after a revocation. `cache()` from
 * React memoises the read for the lifetime of the request, so the layout and the page share one
 * answer by construction rather than by discipline.
 *
 * ## The three states, and why an outage is not anonymous
 *
 * `readRequestActor` answers with an actor or throws `AUTHENTICATION_REQUIRED`; a directory or
 * session read that fails answers with another code. Sending both to the sign in form would tell an
 * officer with a valid session that she is not signed in, and would hide an outage behind the one
 * screen that looks normal. So a refusal is `anonymous`, anything else that is an `AppError` is
 * `unavailable`, and a failure that is not an `AppError` is a defect this module does not swallow.
 *
 * ## Where the cookie is read
 *
 * Here, from the request headers, the same way every existing signed in screen reads it. No page
 * below this one touches a cookie, and no role decision is made from a claim: the claims are
 * evidence, and `lib/auth` already resolved them into the actor record that carries the roles.
 */

export const readOfficeActor = cache(async (): Promise<OfficeActorState> => {
  const cookieHeader = (await headers()).get("cookie");
  const runtime = getAuthRuntime();

  try {
    const actor = await readRequestActor(cookieHeader, {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    return { kind: "actor", actor };
  } catch (error) {
    if (error instanceof AppError) {
      return error.code === "AUTHENTICATION_REQUIRED" ? { kind: "anonymous" } : { kind: "unavailable" };
    }

    throw error;
  }
});
