// path: app/api/invoices/recurring/[id]/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  getRecurringSchedule,
  updateRecurringSchedule,
  type RecurringScheduleSnapshot,
} from "@/services/invoices/recurring-schedule";

export const dynamic = "force-dynamic";

/** Eight short fields and a version; 4 KiB holds the longest legal edit. */
const maximumBodyBytes = 4_096;

interface ScheduleBody {
  readonly status: "saved";
  readonly schedule: RecurringScheduleSnapshot;
}

/**
 * One schedule.
 *
 * ## Why a read and a write share a path
 *
 * They address the same object and the write answers with what the read would: the saved schedule, including
 * the `next_run_on` the engine computed from the new interval and the new `version` the next edit must carry.
 * A screen that re-read after saving would show the old next run for a frame, and the next run is the whole
 * point of the screen.
 *
 * ## What cannot be edited
 *
 * The template is not in the body. A schedule's document is what the merchant configured, and re-pointing it
 * would silently change what a client is billed on the next run. `next_run_on` is not in the body either: it is
 * the engine's answer, and a merchant who wants a different next run changes the start date or the interval,
 * which is the statement they actually mean.
 */
export const GET = withErrorResponse(async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse<RecurringScheduleSnapshot>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });
  const { id } = await context.params;
  const schedule = await getRecurringSchedule({ actor, scheduleId: id }, { rest: runtime.rest, audit: runtime.audit });

  return NextResponse.json(schedule, { status: 200, headers: { "cache-control": "no-store" } });
});

export const PATCH = withErrorResponse(
  async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse<ScheduleBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > maximumBodyBytes) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "version", rule: "invalid_format" }] });
    }

    const { id } = await context.params;
    const schedule = await updateRecurringSchedule(
      { actor, scheduleId: id, body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("recurring schedule updated", {
      userId: actor.userId,
      scheduleId: schedule.id,
      nextRunOn: schedule.nextRunOn,
      version: schedule.version,
    });

    return NextResponse.json({ status: "saved", schedule }, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
