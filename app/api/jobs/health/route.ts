// path: app/api/jobs/health/route.ts
import { NextResponse } from "next/server";
import { withErrorResponse } from "@/lib/errors/respond";
import {
  buildJobHealthSnapshot,
  healthStatus,
  type JobHealthSnapshot,
} from "@/lib/jobs/health";
import { getJobRuntime } from "@/lib/jobs/runtime";

export const dynamic = "force-dynamic";

/**
 * Background work readiness endpoint.
 *
 * `/api/health` says the process answers; this says the queue is moving. A probe treats `503` as
 * "page someone", which is why the degraded rules live in `lib/jobs/health.ts` rather than in this
 * file: the route only turns a snapshot into a status code.
 *
 * Wrapped in `withErrorResponse`, so a store failure answers with the platform error envelope
 * rather than a Next.js error page, and the response carries the same no-store headers as the
 * liveness endpoint.
 */
export const GET = withErrorResponse(async (): Promise<NextResponse<JobHealthSnapshot>> => {
  const runtime = getJobRuntime();
  const snapshot = await buildJobHealthSnapshot({
    queue: runtime.queue,
    scheduler: runtime.scheduler,
    worker: runtime.worker,
  });

  return NextResponse.json(snapshot, {
    status: healthStatus(snapshot),
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
});
