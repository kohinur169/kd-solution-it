// path: app/api/health/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface HealthPayload {
  readonly status: "ok";
  readonly service: string;
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
}

const serviceName = "kd-solution-it";
const bootedAtEpochMs = Date.now();

function buildHealthPayload(checkedAtEpochMs: number): HealthPayload {
  return {
    status: "ok",
    service: serviceName,
    uptimeSeconds: Math.max(
      0,
      Math.floor((checkedAtEpochMs - bootedAtEpochMs) / 1000),
    ),
    checkedAt: new Date(checkedAtEpochMs).toISOString(),
  };
}

export function GET(): NextResponse<HealthPayload> {
  return NextResponse.json(buildHealthPayload(Date.now()), {
    headers: {
      "cache-control": "no-store, max-age=0",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
