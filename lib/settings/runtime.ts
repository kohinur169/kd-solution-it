// path: lib/settings/runtime.ts
import { getAuthRuntime } from "../auth/runtime.ts";
import type { SettingsDependencies } from "./service.ts";

/**
 * The production wiring of the platform settings and the compliance calendar: the PostgREST client,
 * the signed audit trail and the clock.
 *
 * ## Why this is its own module
 *
 * The settings screen, the two routes and the calendar check all need the same three dependencies, and
 * a second copy of them is how one of the four ends up writing without an audit entry. The
 * authentication block already validates the environment and builds the service role client and the
 * Ed25519 signing trail, so this module is a projection of it rather than a second factory.
 *
 * ## What is deliberately absent
 *
 * No sealer and no mailer. This module reads and writes plain settings - a name, a path, an address, a
 * date - and a compliance row. A secret setting is `lib/auth/settings.ts`'s to read, and delivery of
 * the expiry warning is the job runtime's, which has no database store yet; the handoff records that.
 */

/** The dependencies the screen and the routes use. */
export type SettingsRuntime = SettingsDependencies & { readonly now: () => number };

/** The dependencies the screen and the routes use. */
export function getSettingsRuntime(): SettingsRuntime {
  const runtime = getAuthRuntime();

  return {
    store: runtime.rest,
    audit: runtime.audit,
    now: (): number => Date.now(),
  };
}
