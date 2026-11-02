// path: app/api/office/compliance-calendar/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  addComplianceItem,
  archiveComplianceItem,
  renewComplianceItem,
  runComplianceCalendarCheck,
  type ComplianceCalendarSnapshot,
  type ComplianceCheckResult,
} from "@/lib/settings/service";
import { COMPLIANCE_DEFAULT_ALERT_DAYS } from "@/lib/settings/registry";
import { getSettingsRuntime } from "@/lib/settings/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Section 3's compliance calendar, over HTTP.
 *
 * ## Four actions, one book
 *
 * `add` files a certificate or an attestation, `renew` files the next period and closes the old row,
 * `archive` takes an item off the calendar without deleting it, and `check` runs what section 27
 * schedules: expire what has lapsed and record a warning for everything inside its window. The first
 * three answer the whole calendar; `check` answers what the run did, because a screen that shows only
 * the calendar cannot say whether anything happened.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes, then
 * the parse, then the service - which applies the compliance desk's roles and the freshness of the
 * second factor beside the write they guard. The two dates, the alert window and every string's length
 * are checked against the same constants `0068`'s checks use.
 */

/** One action and one item's fields. 4 KiB covers a five hundred character note twice over. */
const maximumBodyBytes = 4_096;

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

function readText(body: unknown, key: string): string {
  const value = readField(body, key);

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "invalid_format" }] });
  }

  return value;
}

/** An optional string: absent and null are both "not given". */
function readOptionalText(body: unknown, key: string): string | null {
  const value = readField(body, key);

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "invalid_format" }] });
  }

  return value;
}

/** The warning window, defaulted to the platform's thirty days when the form omits it. */
function readAlertDays(body: unknown): number {
  const value = readField(body, "alertDays");

  if (value === undefined || value === null) {
    return COMPLIANCE_DEFAULT_ALERT_DAYS;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "alertDays", rule: "invalid_format" }],
    });
  }

  return value;
}

export const POST = withErrorResponse(
  async (
    request: Request,
  ): Promise<NextResponse<ComplianceCalendarSnapshot | ComplianceCheckResult>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // A proof before a parse: the signature covers these bytes, and an altered body fails here rather
    // than as a schema problem the operator would have to read.
    requireTrustedDevice(
      await verifySensitiveRequest(
        { request, bodyText, actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "action", rule: "invalid_format" }],
      });
    }

    const action = readField(body, "action");
    const settings = getSettingsRuntime();

    if (action === "add") {
      const snapshot = await addComplianceItem(
        {
          actor,
          kind: readText(body, "kind"),
          title: readText(body, "title"),
          issuer: readText(body, "issuer"),
          reference: readOptionalText(body, "reference"),
          note: readOptionalText(body, "note"),
          issuedOn: readText(body, "issuedOn"),
          expiresOn: readText(body, "expiresOn"),
          alertDays: readAlertDays(body),
        },
        settings,
      );

      logger.info("compliance item filed", {
        kind: readText(body, "kind"),
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 201, headers: { "cache-control": "no-store" } });
    }

    if (action === "renew") {
      const snapshot = await renewComplianceItem(
        {
          actor,
          itemId: readText(body, "itemId"),
          issuedOn: readOptionalText(body, "issuedOn"),
          expiresOn: readText(body, "expiresOn"),
          reference: readOptionalText(body, "reference"),
          note: readOptionalText(body, "note"),
        },
        settings,
      );

      logger.info("compliance item renewed", {
        itemId: readText(body, "itemId"),
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (action === "archive") {
      const snapshot = await archiveComplianceItem(
        { actor, itemId: readText(body, "itemId") },
        settings,
      );

      logger.info("compliance item archived", {
        itemId: readText(body, "itemId"),
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (action === "check") {
      const result = await runComplianceCalendarCheck({ actor }, settings);

      logger.info("compliance calendar checked", {
        examined: result.examined,
        expired: result.expired,
        alerted: result.alerted,
        actorUserId: actor.userId,
      });

      return NextResponse.json(result, { status: 200, headers: { "cache-control": "no-store" } });
    }

    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "action", rule: "invalid_format" }],
    });
  },
);
