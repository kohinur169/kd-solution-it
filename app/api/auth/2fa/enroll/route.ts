// path: app/api/auth/2fa/enroll/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { getMessage } from "@/lib/i18n/messages";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { enforceRateLimit } from "@/lib/auth/rate-limit";
import { startTotpEnrolment } from "@/lib/auth/two-factor";
import { logger } from "@/lib/logger/logger";

export const dynamic = "force-dynamic";

interface EnrolResponseBody {
  readonly secret: string;
  readonly secretForEntry: string;
  readonly accountUri: string;
  /** The drawing of the symbol, or null when the URI did not fit this encoder. */
  readonly symbol: { readonly extent: number; readonly data: string } | null;
}

/**
 * Start TOTP enrolment for the signed in account.
 *
 * A POST because it mutates: the account receives a fresh sealed secret and an instant at which the
 * enrolment began. It answers with the secret, the same secret in the four character groups a person
 * types, the `otpauth://` URI and the symbol. The secret is returned exactly once per start, which
 * is why there is no GET: a page that could read the secret of an enrolment in progress would make
 * the second factor readable by anyone who can reach the account with the first one.
 *
 * The response carries `Cache-Control: no-store`, because a proxy that keeps the secret would
 * defeat the sealing that protects it at rest.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<EnrolResponseBody>> => {
    // STEP 055: section 22 line 242. Counted first, so a burst costs one statement and
    // never reaches the body, the session or the work behind them.
    await enforceRateLimit({ request, scope: "two_factor_enroll" }, getAuthRuntime());

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > 1_024) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const result = await startTotpEnrolment(
      { userId: actor.userId },
      {
        rest: runtime.rest,
        audit: runtime.audit,
        masterKey: runtime.masterKey,
        issuer: getMessage("brand.name"),
      },
    );

    logger.info("totp enrolment started", {
      userId: actor.userId,
      symbolVersion: result.qr === null ? null : result.qr.version,
    });

    const body: EnrolResponseBody = {
      secret: result.secret,
      secretForEntry: result.secretForEntry,
      accountUri: result.uri,
      symbol: result.symbol,
    };

    return NextResponse.json(body, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  },
);
