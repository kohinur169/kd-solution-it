// path: app/(dashboard)/onboarding/owner-actor.ts
import { headers } from "next/headers";
import { cache } from "react";
import { readRequestActor } from "../../../lib/auth/request-actor.ts";
import { getAuthRuntime } from "../../../lib/auth/runtime.ts";
import type { RequestActor } from "../../../lib/auth/types.ts";
import { AppError } from "../../../lib/errors/app-error.ts";

/**
 * The account behind one merchant request, read once per request.
 *
 * ## Why the merchant area gets its own reader
 *
 * The office has one (`app/(admin)/office-actor.ts`) because its layout and its pages must share one
 * answer. The merchant area starts here, with the first page that belongs to it, so the same
 * discipline starts here: one cookie read, one directory read, one session read, and every later
 * merchant screen imports this instead of repeating it.
 *
 * ## The three states, and why an outage is not anonymous
 *
 * `readRequestActor` answers with an actor or throws `AUTHENTICATION_REQUIRED`; a directory or a
 * session read that fails answers with another code. Sending both to the sign in form would tell a
 * merchant with a valid session that they are not signed in, and would hide an outage behind the one
 * screen that looks normal. A refusal is therefore `anonymous`, any other `AppError` is
 * `unavailable`, and a defect that is not an `AppError` is not swallowed.
 *
 * ## What this file does not decide
 *
 * Whether the actor is a merchant at all. `owner` is a role the service behind the screen asks
 * (`requireOnboardingCompany` in `services/kyc/onboarding-progress.ts`), so a page cannot be a weaker
 * path to the same row than the service that owns it.
 */

export type OwnerActorState =
  | { readonly kind: "actor"; readonly actor: RequestActor }
  | { readonly kind: "anonymous" }
  | { readonly kind: "unavailable" };

export const readOwnerActor = cache(async (): Promise<OwnerActorState> => {
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
