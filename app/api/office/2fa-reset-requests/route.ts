// path: app/api/office/2fa-reset-requests/route.ts
import { NextResponse } from "next/server";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  listTwoFactorResetRequests,
  TWO_FACTOR_RESET_OFFICE_ROLES,
  type TwoFactorResetRequestView,
} from "@/lib/auth/two-factor-reset";

export const dynamic = "force-dynamic";

interface QueueResponseBody {
  readonly requests: readonly TwoFactorResetRequestView[];
}

function readLimit(request: Request): number {
  const raw = new URL(request.url).searchParams.get("limit");

  if (raw === null) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
}

/**
 * The queue an office worker reads: requests waiting for a decision, oldest first.
 *
 * The permission is the service's, not the route's, and the answer carries the reason and the
 * document reference but never the merchant's address - the office looks the account up by the id
 * the request already names, so a screen left open on a shared desk shows no addresses.
 */
export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<QueueResponseBody>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const requests = await listTwoFactorResetRequests(
      { actor, roles: TWO_FACTOR_RESET_OFFICE_ROLES, limit: readLimit(request) },
      { rest: runtime.rest },
    );

    return NextResponse.json({ requests } satisfies QueueResponseBody, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
