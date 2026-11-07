// path: app/api/office/disputes/chargeback/policy/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import type { ChargebackPolicyView } from "@/services/disputes/chargeback-policy";
import { parsePolicyBody, saveChargebackPolicy } from "@/services/disputes/chargeback-policy";
import { CHARGEBACK_POLICY_MAXIMUM_BODY_BYTES } from "@/services/disputes/chargeback-fields";
import { getChargebackRuntime } from "@/services/disputes/dispute-runtime";

export const dynamic = "force-dynamic";

/**
 * Set section 18's seven thresholds, at `/api/office/disputes/chargeback/policy`.
 *
 * Section 18's last sentence: "every threshold value is configurable by super_admin." This route is that
 * sentence: one `POST`, seven integers, and the audit entry that names what changed. The values live in
 * `platform_settings` under the `chargeback.*` keys, which is the registry `0080` built for exactly this shape -
 * so no migration is needed to make a threshold configurable, and a future number is a key rather than a column.
 *
 * ## The three guards, and why all three
 *
 * The CSRF token first, then the session, then the device proof over these exact bytes. A threshold is a policy
 * about every merchant on the platform at once: a compromised cookie that could widen the suspension bar would
 * silently disarm the programme, which is why the person making the change has to be at an enrolled device and
 * why the service asks for the role and the second factor again after the route has.
 *
 * The body is the seven numbers and nothing else:
 * `{ "windowDays", "minimumTransactions", "warningRateBps", "reserveRateBps", "suspensionRateBps",
 * "reservePercentBps", "reserveDays" }`. An unknown key is a refusal, a bar outside its bounds is a refusal, and
 * bars out of order are a refusal - a reserve bar under the warning bar would make the middle step unreachable.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ChargebackPolicyView>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declared = request.headers.get("content-length");

    if (declared !== null) {
      const parsed = Number.parseInt(declared, 10);

      if (Number.isFinite(parsed) && parsed > CHARGEBACK_POLICY_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > CHARGEBACK_POLICY_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    requireTrustedDevice(
      await verifySensitiveRequest({ request, bodyText, actor }, { rest: runtime.rest, audit: runtime.audit }),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "chargeback", rule: "invalid_format" }],
      });
    }

    // Parsed here as well as in the service so the log line carries numbers that have already been proved to be
    // numbers, rather than whatever the caller sent.
    const parsed = parsePolicyBody(body);
    const view = await saveChargebackPolicy({ actor, body }, getChargebackRuntime());

    logger.info("chargeback thresholds saved", {
      policyDigest: view.digest,
      windowDays: parsed.windowDays,
      minimumTransactions: parsed.minimumTransactions,
      warningRateBps: parsed.warningRateBps,
      reserveRateBps: parsed.reserveRateBps,
      suspensionRateBps: parsed.suspensionRateBps,
      reservePercentBps: parsed.reservePercentBps,
      reserveDays: parsed.reserveDays,
      actorUserId: actor.userId,
    });

    return NextResponse.json(view);
  },
);
