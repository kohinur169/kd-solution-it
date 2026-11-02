// path: app/api/office/countries/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  disableCountry,
  enableCountry,
  requestCountryEnable,
  type CountrySwitchSnapshot,
} from "@/lib/countries/service";
import { getCountryRuntime } from "@/lib/countries/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Section 3's country switch, over HTTP.
 *
 * ## Three actions, one authority
 *
 * `request` raises the opening decision into the chain of section 2, `enable` spends an approved one,
 * and `disable` closes a market with a written reason. All three answer the same body - the whole
 * switch, as the account in front of it may see it - so the screen replaces its picture in one step
 * instead of guessing what changed.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes, then
 * the parse, then the service - which applies section 3's two roles and the freshness of the second
 * factor beside the write they guard. A refusal names a field and a rule; the sentence an operator
 * writes about a market is never echoed back.
 */

/** One action, one country and one sentence. 4 KiB is generous and bounded. */
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

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<CountrySwitchSnapshot>> => {
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

    if (action === "request") {
      const snapshot = await requestCountryEnable(
        {
          actor,
          countryId: readText(body, "countryId"),
          note: readText(body, "note"),
        },
        getCountryRuntime(),
      );

      logger.info("country opening requested", {
        countryId: readText(body, "countryId"),
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 201, headers: { "cache-control": "no-store" } });
    }

    if (action === "enable") {
      const snapshot = await enableCountry(
        { actor, countryId: readText(body, "countryId") },
        getCountryRuntime(),
      );

      logger.info("country enabled", { countryId: readText(body, "countryId"), actorUserId: actor.userId });

      return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (action === "disable") {
      const snapshot = await disableCountry(
        {
          actor,
          countryId: readText(body, "countryId"),
          reason: readText(body, "reason"),
        },
        getCountryRuntime(),
      );

      logger.info("country disabled", {
        countryId: readText(body, "countryId"),
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
    }

    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "action", rule: "invalid_format" }],
    });
  },
);
