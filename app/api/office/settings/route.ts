// path: app/api/office/settings/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  savePlatformInformation,
  type PlatformInformationSnapshot,
} from "@/lib/settings/service";
import { PLATFORM_SETTING_KEYS } from "@/lib/settings/registry";
import { getSettingsRuntime } from "@/lib/settings/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Section 24's platform information, over HTTP.
 *
 * ## One action, one form
 *
 * The screen has one save button, so the route has one action and no verb table: a body of
 * `{ action: "save", values, savedAtEpochMs }` is the whole wire. The values are a map of the ten keys
 * `lib/settings/registry.ts` owns; a key outside that map is a validation failure rather than an extra
 * row, so a stale form from an older build cannot write a setting this build does not read.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes, then
 * the parse, then the service - which applies section 24's one role and the freshness of the second
 * factor beside the write they guard. A refusal names a field and a rule.
 */

/** Ten bounded values and an instant. 8 KiB is generous for that and still bounded. */
const maximumBodyBytes = 8_192;

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

/** The submitted values, as a map of key to string. Anything else is a refusal. */
function readValues(body: unknown): Readonly<Record<string, string>> {
  const value = readField(body, "values");

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "values", rule: "invalid_format" }] });
  }

  const values: Record<string, string> = {};

  for (const [key, raw] of Object.entries(value as Readonly<Record<string, unknown>>)) {
    if (typeof raw !== "string") {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "invalid_format" }] });
    }

    if (!PLATFORM_SETTING_KEYS.includes(key)) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "unknown_key" }] });
    }

    values[key] = raw;
  }

  return values;
}

/** The instant the form was rendered at, so a stale save is a conflict rather than an overwrite. */
function readSavedAt(body: unknown): number | null {
  const value = readField(body, "savedAtEpochMs");

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "savedAtEpochMs", rule: "invalid_format" }],
    });
  }

  return value;
}

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<PlatformInformationSnapshot>> => {
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

    if (action !== "save") {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "action", rule: "invalid_format" }],
      });
    }

    const snapshot = await savePlatformInformation(
      { actor, values: readValues(body), expectedSavedAtEpochMs: readSavedAt(body) },
      getSettingsRuntime(),
    );

    logger.info("platform settings saved", {
      storedFields: snapshot.fields.filter((field) => field.isSet).length,
      actorUserId: actor.userId,
    });

    return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
