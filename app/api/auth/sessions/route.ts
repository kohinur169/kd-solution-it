// path: app/api/auth/sessions/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { listOwnSessions, type SessionView } from "@/lib/auth/session-list";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

interface SessionsResponseBody {
  readonly sessions: readonly SessionView[];
}

/**
 * The caller's own live sessions.
 *
 * A read of the caller's own account, which is why it is a `GET` and why it carries no proof: there
 * is nothing here that a session cookie does not already prove, and the body is filtered by the
 * actor's `userId` rather than by anything the request says. The one session it marks as `current`
 * is the one making the request.
 *
 * `401` without a session is the only refusal the service can produce, so the answer set is
 * deliberately two.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<SessionsResponseBody>> => {
    // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
    // never reaches the body, the session or the work behind them.
    await enforceRateLimit({ request, scope: "session_list" }, getAuthRuntime());

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const sessions = await listOwnSessions(actor, {
      rest: runtime.rest,
      audit: runtime.audit,
      sessions: runtime.sessions,
    });

    return NextResponse.json(
      { sessions } satisfies SessionsResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
