// path: app/api/office/sessions/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { listAccountSessions, type SessionView } from "@/lib/auth/session-list";
import { withErrorResponse } from "@/lib/errors/respond";

export const dynamic = "force-dynamic";

interface OfficeSessionsResponseBody {
  readonly userId: string;
  readonly sessions: readonly SessionView[];
}

/**
 * One account's live sessions, for an office role.
 *
 * The role gate and the audit entry live in `listAccountSessions`, so this route cannot be the weak
 * version of the endpoint: an officer without one of the four roles gets `403` from the service, and
 * an officer with one leaves a `session.list_read_by_office` entry naming the account they read.
 *
 * The account is a query parameter because this is a `GET`; the officer themselves comes from the
 * cookie and never from the request.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<OfficeSessionsResponseBody>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const userId = new URL(request.url).searchParams.get("userId") ?? "";
    const sessions = await listAccountSessions(
      { actor, userId },
      { rest: runtime.rest, audit: runtime.audit, sessions: runtime.sessions },
    );

    return NextResponse.json(
      { userId, sessions } satisfies OfficeSessionsResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
