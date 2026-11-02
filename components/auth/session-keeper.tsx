// path: components/auth/session-keeper.tsx
"use client";

import { useEffect } from "react";
import { bindSession } from "@/lib/auth/device-proof-store";

/**
 * Keep this browser's session rotating, silently.
 *
 * Section 22 asks for a rotating session token. Rotation happens in a route handler, because only a
 * handler can rewrite the cookie, so something on the page has to ask for it. This component is that
 * something: it calls the rotation endpoint when a signed-in page mounts and every few minutes
 * afterwards, and the server decides whether anything is due.
 *
 * It renders nothing and says nothing. The three answers it can get are all quiet:
 *
 *   - `bound` or `rotated` - the cookie in the jar is already the new one, because the browser
 *     applied the `set-cookie` of the answer;
 *   - `current` - the session is younger than the rotation interval, or this request arrived inside
 *     the grace window of a rotation that already happened. Nothing to do;
 *   - a refusal - the session ended. A replay, a sign out from another device or a revocation all
 *     answer the same way, and the next navigation lands on the sign in form anyway. The component
 *     stops asking instead of looping.
 *
 * A browser without a stored key answers `missing-key`, which is not a failure worth acting on: the
 * pages that mount this component are the ones a sign in has already bound.
 */

/** Five minutes: three chances to rotate inside one fifteen minute rotation interval. */
const keepAliveMilliseconds = 5 * 60_000;

export interface SessionKeeperProperties {
  /**
   * Ask on mount.
   *
   * Off where the page is rendered immediately after a navigation that already asked, so a page does
   * not spend a request on an answer the sign in just produced.
   */
  readonly askOnMount?: boolean;
}

export function SessionKeeper({ askOnMount = true }: SessionKeeperProperties): null {
  useEffect(() => {
    let stopped = false;

    async function ask(): Promise<void> {
      const outcome = await bindSession();

      if (!stopped && !outcome.ok && outcome.reason === "refused") {
        stopped = true;
      }
    }

    if (askOnMount) {
      void ask();
    }

    const timer = globalThis.setInterval(() => {
      if (!stopped) {
        void ask();
      }
    }, keepAliveMilliseconds);

    return () => {
      stopped = true;
      globalThis.clearInterval(timer);
    };
  }, [askOnMount]);

  return null;
}
