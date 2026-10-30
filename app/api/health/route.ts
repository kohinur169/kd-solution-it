// path: app/api/health/route.ts
import { NextResponse } from "next/server";
import { PLATFORM_SERVICE_SLUG } from "@/lib/constants/platform";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

interface HealthPayload {
  readonly status: "ok";
  readonly service: string;
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
}

const bootedAtEpochMs = Date.now();

function buildHealthPayload(checkedAtEpochMs: number): HealthPayload {
  return {
    status: "ok",
    service: PLATFORM_SERVICE_SLUG,
    uptimeSeconds: Math.max(
      0,
      Math.floor((checkedAtEpochMs - bootedAtEpochMs) / 1000),
    ),
    checkedAt: new Date(checkedAtEpochMs).toISOString(),
  };
}

/**
 * Liveness endpoint.
 *
 * Wrapped in `withErrorResponse`, so an unexpected failure here answers with the platform
 * error envelope instead of a Next.js error page, and the request context (including a
 * validated inbound `x-request-id`) is opened by the wrapper rather than by this file. The
 * success body and headers are unchanged since STEP 001.
 */
export const GET = withErrorResponse((): NextResponse<HealthPayload> => {
  const startedAtEpochMs = Date.now();
  const payload = buildHealthPayload(startedAtEpochMs);

  logger.info("health check served", {
    status: 200,
    durationMs: Date.now() - startedAtEpochMs,
    uptimeSeconds: payload.uptimeSeconds,
  });

  return NextResponse.json(payload, {
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
});
