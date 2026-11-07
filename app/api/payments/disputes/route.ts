// path: app/api/payments/disputes/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { listCompanyDisputes, type DisputeView } from "@/services/disputes/dispute";
import { DISPUTE_LIST_LIMIT } from "@/services/disputes/dispute-fields";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

interface ListedResponseBody {
  readonly disputes: readonly DisputeView[];
}

/**
 * The merchant's own disputes, newest first.
 *
 * A read and nothing else: STEP 194 lists a dispute and tracks the status a processor gives it, and the
 * merchant's own answer to a dispute is STEP 195's form. There is no `POST` here on purpose - the only
 * writer of a dispute status in this build is a verified provider delivery, and a merchant route that could
 * write one would be a second author of the processor's answer.
 *
 * `listCompanyDisputes` requires the `owner` role and the actor's own company, so this route is the
 * boundary (session, limit) and the service is the decision. The answer is never cached: a deadline is
 * money moving in minutes, and one cached list is one merchant reading another's.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<ListedResponseBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  const requested = new URL(request.url).searchParams.get("limit");
  const parsed = requested === null ? Number.NaN : Number.parseInt(requested, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), DISPUTE_LIST_LIMIT) : DISPUTE_LIST_LIMIT;
  const disputes = await listCompanyDisputes({ actor, limit }, getDisputeRuntime());

  return NextResponse.json(
    { disputes } satisfies ListedResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
