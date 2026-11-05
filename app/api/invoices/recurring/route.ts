// path: app/api/invoices/recurring/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  createRecurringSchedule,
  listRecurringSchedules,
  RECURRING_SCHEDULE_LIST_LIMIT,
  type RecurringScheduleSnapshot,
} from "@/services/invoices/recurring-schedule";

export const dynamic = "force-dynamic";

/**
 * The body ceiling.
 *
 * A schedule is eight short fields and no document: a template id, a unit, a count, two dates and three
 * integers. Four kilobytes holds the longest legal body many times over, and a larger one is not a schedule
 * that was typed, it is a request to make the server read.
 */
const maximumBodyBytes = 4_096;

interface ScheduleListBody {
  readonly schedules: readonly RecurringScheduleSnapshot[];
  readonly truncated: boolean;
  readonly limit: number;
}

interface CreateScheduleBody {
  readonly status: "created";
  readonly schedule: RecurringScheduleSnapshot;
}

/**
 * Section 16's recurring invoice schedules, over HTTP.
 *
 * ## Why the list is bounded and says so
 *
 * A merchant with three hundred schedules needs a page, not a response. `RECURRING_SCHEDULE_LIST_LIMIT` is
 * fifty and the answer carries `truncated`, so a screen can say "the newest fifty" instead of pretending the
 * list is complete - the same shape `listInvoiceClientOptions` uses for the client book.
 *
 * ## Why the GET carries no CSRF token
 *
 * It changes nothing. The session and the company come from the cookie, and `no-store` keeps a merchant's
 * billing configuration out of any shared cache.
 *
 * ## The order of the checks on the POST
 *
 * CSRF first, then the declared length, then the session, then the JSON parse, then the service, which applies
 * the `owner` role, reads the company from the session rather than the body, and validates every field with the
 * Zod schema before anything is written.
 */
export const GET = withErrorResponse(async (request: Request): Promise<NextResponse<ScheduleListBody>> => {
  const runtime = getAuthRuntime();
  const actor = await readRequestActor(request.headers.get("cookie"), {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  });
  const listed = await listRecurringSchedules({ actor }, { rest: runtime.rest });

  return NextResponse.json(
    { schedules: listed.schedules, truncated: listed.truncated, limit: RECURRING_SCHEDULE_LIST_LIMIT },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
});

export const POST = withErrorResponse(async (request: Request): Promise<NextResponse<CreateScheduleBody>> => {
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
    // A chunked body declares no length, so the bound is enforced a second time on what arrived.
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
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "template_invoice_id", rule: "invalid_format" }] });
  }

  const schedule = await createRecurringSchedule({ actor, body }, { rest: runtime.rest, audit: runtime.audit });

  // Identifiers and the policy's shape, never the client's name and never an amount.
  logger.info("recurring schedule created", {
    userId: actor.userId,
    scheduleId: schedule.id,
    intervalUnit: schedule.intervalUnit,
    intervalCount: schedule.intervalCount,
  });

  return NextResponse.json(
    { status: "created", schedule },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
