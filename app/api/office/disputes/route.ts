// path: app/api/office/disputes/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { listDisputeQueue, type DisputeView } from "@/services/disputes/dispute";
import { DISPUTE_QUEUE_LIMIT } from "@/services/disputes/dispute-fields";
import { getDisputeRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

interface QueueResponseBody {
  readonly disputes: readonly DisputeView[];
}

/**
 * The platform's dispute queue, nearest deadline first.
 *
 * Every merchant at once, because the office answers for every merchant; with the tenant on each row,
 * because an act on a dispute has to be traceable to the company it was about. `listDisputeQueue` is the
 * role check (`ceo`, the compliance desk, the finance desk, `super_admin`), so a session without one of them
 * reads `PERMISSION_DENIED` here exactly as it does on the screen.
 *
 * Read only, like the merchant's route: the two acts of section 19 - assembling the evidence pack and
 * sending it - are later STEPs, and a queue that could write would be a queue that could decide.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<QueueResponseBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });

  const requested = new URL(request.url).searchParams.get("limit");
  const parsed = requested === null ? Number.NaN : Number.parseInt(requested, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), DISPUTE_QUEUE_LIMIT) : DISPUTE_QUEUE_LIMIT;
  const disputes = await listDisputeQueue({ actor, limit }, getDisputeRuntime());

  return NextResponse.json(
    { disputes } satisfies QueueResponseBody,
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});
