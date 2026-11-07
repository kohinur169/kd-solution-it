// path: app/api/office/plans/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { BILLING_PLAN_ROLES } from "../../../../services/billing/plans-registry.ts";
import { createPlan, listPlans, type PlanCatalogue } from "../../../../services/billing/plans";
import { getPlanRuntime } from "../../../../services/billing/plans-runtime";

export const dynamic = "force-dynamic";

/**
 * Section 9's plan catalogue, over HTTP: read the plans, and create one.
 *
 * ## Two verbs, one authority
 *
 * `GET` answers the catalogue as the account in front of it may see it, and `POST` creates one plan
 * and answers the same catalogue - so the screen replaces its picture in one step instead of
 * guessing where the new row went. Both go through `plans.ts`, which applies
 * `BILLING_PLAN_ROLES` (`super_admin`) beside the write it guards; the route itself decides nothing
 * about who may create a plan, so a second entry point cannot reach a weaker path than this one.
 *
 * ## The order of the checks on a write
 *
 * CSRF, then the declared length, then the session, then the device proof over the exact bytes, then
 * the parse, then the service. A refusal names a field and a rule; nothing an operator typed is
 * echoed back in a refusal, and the plan's own values are never logged with the address of the
 * person who wrote them.
 */

/** One plan is a name, a code, six services at most and four numbers. Eight kilobytes is generous. */
const maximumBodyBytes = 8_192;

export const GET = withErrorResponse(
  async (request: Request): Promise<NextResponse<PlanCatalogue>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const catalogue = await listPlans({ actor }, getPlanRuntime());

    return NextResponse.json(catalogue, { status: 200, headers: { "cache-control": "no-store" } });
  },
);

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<PlanCatalogue>> => {
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

    // A proof before a parse: the signature covers these bytes, and an altered body fails here rather
    // than as a schema problem the operator would have to read.
    requireTrustedDevice(
      await verifySensitiveRequest({ request, bodyText, actor }, { rest: runtime.rest, audit: runtime.audit }),
    );

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "plan", rule: "invalid_format" }],
      });
    }

    const catalogue = await createPlan(
      { actor, body, clientAddress: request.headers.get("x-forwarded-for") },
      getPlanRuntime(),
    );

    logger.info("billing plan created", {
      actorUserId: actor.userId,
      role: BILLING_PLAN_ROLES[0],
      plans: catalogue.plans.length,
    });

    return NextResponse.json(catalogue, { status: 201, headers: { "cache-control": "no-store" } });
  },
);
