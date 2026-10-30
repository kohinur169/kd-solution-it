// path: app/api/health/route.ts
import { NextResponse } from "next/server";
import { PLATFORM_SERVICE_SLUG } from "@/lib/constants/platform";
import { runWithRequestContext, type RequestContextInput } from "@/lib/logger/context";
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
 * The request context for this handler.
 *
 * An inbound `x-request-id` is passed through only after the logger validates it against a
 * safe alphabet; anything else is replaced by a generated id. The response does not change,
 * so a probe that has been watching this endpoint since STEP 001 sees exactly what it saw.
 */
function buildRequestContext(request: Request): RequestContextInput {
  const requestId = request.headers.get("x-request-id");
  const base = { method: "GET", route: "/api/health" } as const;

  return requestId === null ? base : { ...base, requestId };
}

export function GET(request: Request): NextResponse<HealthPayload> {
  return runWithRequestContext(buildRequestContext(request), () => {
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
}
