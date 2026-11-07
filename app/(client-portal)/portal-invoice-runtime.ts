// path: app/(client-portal)/portal-invoice-runtime.ts
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { readRequestActor } from "../../lib/auth/request-actor.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { getAuthRuntime } from "../../lib/auth/runtime.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { isAppError } from "../../lib/errors/app-error.ts";
import type { PortalTokenKeys } from "../../lib/security/portal-token.ts";

/**
 * The production wiring of the tokenized invoice page.
 *
 * Three things and nothing else: the platform's one server side rest client, its append only audit chain
 * and the portal token key ring. Nothing is cached, because a page that cached a document would show
 * yesterday's paid state, and nothing is sealed, because an invoice holds no credential of its own.
 *
 * ## The key ring
 *
 * A portal link is signed with a key derived from `ENCRYPTION_MASTER_KEY`, the only long lived secret this
 * platform keeps in its environment. There is one master key today, so the ring has one member and a link
 * minted a minute ago verifies. The ring's `previous` list is where a rotation puts the outgoing key, and
 * it is deliberately absent rather than guessed at: an environment that has never been rotated has
 * nothing to try, and inventing a second key would mean trying a key this deployment never held.
 *
 * ## Why a function and not a module level constant
 *
 * A constant would read the environment at import time, which would make a build machine need a runtime
 * secret and would make a gate that imports this module fail before it checked anything. The runtime is
 * built on the first request and kept, exactly as `getAuthRuntime` does it.
 */

export interface PortalInvoiceRuntime {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly tokenKeys: PortalTokenKeys;
}

let runtime: PortalInvoiceRuntime | undefined;

export function getPortalInvoiceRuntime(): PortalInvoiceRuntime {
  if (runtime !== undefined) {
    return runtime;
  }

  const auth = getAuthRuntime();

  runtime = {
    rest: auth.rest,
    audit: auth.audit,
    tokenKeys: { primary: auth.masterKey() },
  };

  return runtime;
}

/**
 * The signed-in actor of this request when there is one, or null.
 *
 * A page under `i/[token]` is public, so a session is optional: a buyer has none, and a merchant who is
 * signed in is shown one extra panel. The name says "optionally" rather than "merchant" because the
 * caller decides what an actor means: the page asks whether it may render the delivery form, and the
 * confirmation route asks whether the person confirming is the merchant themself.
 *
 * `readRequestActor` answers `AUTHENTICATION_REQUIRED` for a request with no live session, which is the
 * one failure this function swallows - every other failure (a directory that cannot be reached, a
 * replayed token) is a real fault and is thrown, because a surface that quietly hid a broken session
 * would hide the very thing an operator needs to see.
 */
export async function readRequestActorOptionally(
  cookieHeader: string | null,
): Promise<RequestActor | null> {
  const auth = getAuthRuntime();

  try {
    return await readRequestActor(cookieHeader, {
      directory: auth.directory,
      cookiePolicy: auth.cookiePolicy,
      sessions: auth.sessions,
      audit: auth.audit,
    });
  } catch (error) {
    if (isAppError(error) && error.code === "AUTHENTICATION_REQUIRED") {
      return null;
    }

    throw error;
  }
}
