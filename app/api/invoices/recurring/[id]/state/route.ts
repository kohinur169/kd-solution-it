// path: app/api/invoices/recurring/[id]/state/route.ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  setRecurringScheduleState,
  type RecurringScheduleSnapshot,
} from "@/services/invoices/recurring-schedule";

export const dynamic = "force-dynamic";

/** An action and a version; 1 KiB is already generous. */
const maximumBodyBytes = 1_024;

const bodySchema = z
  .object({
    action: z.enum(["pause", "resume", "end"]),
    version: z.union([z.string(), z.number()]),
  })
  .strict();

interface StateBody {
  readonly status: "saved";
  readonly schedule: RecurringScheduleSnapshot;
}

/**
 * Pause, resume or end one schedule.
 *
 * ## Why this is its own path rather than a field on the edit
 *
 * A state change is not an edit of the policy: it carries no interval, it is one of three verbs, and it is the
 * only thing a merchant does to a schedule they are not currently changing. Keeping it separate means the edit
 * route can refuse a paused row without a special case, and it means the three actions get three audit actions
 * rather than one entry that has to be read closely to see what happened.
 *
 * ## Why the version travels with it
 *
 * Pausing a schedule somebody else is editing is exactly the race `0028`'s `version` column exists for. The
 * answer names `version` and `already_changed`, so a screen can re-read and try again rather than overwrite.
 */
export const POST = withErrorResponse(
  async (request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse<StateBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

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
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "action", rule: "invalid_format" }] });
    }

    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "action", rule: "invalid_format" }] });
    }

    const version =
      typeof parsed.data.version === "number"
        ? parsed.data.version
        : /^\d{1,6}$/u.test(parsed.data.version.trim())
          ? Number.parseInt(parsed.data.version.trim(), 10)
          : Number.NaN;

    const { id } = await context.params;
    const schedule = await setRecurringScheduleState(
      { actor, scheduleId: id, action: parsed.data.action, version },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("recurring schedule state changed", {
      userId: actor.userId,
      scheduleId: schedule.id,
      action: parsed.data.action,
      status: schedule.status,
    });

    return NextResponse.json({ status: "saved", schedule }, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
