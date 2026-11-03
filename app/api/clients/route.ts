// path: app/api/clients/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { createClient, type ClientSnapshot } from "@/services/clients/clients";

export const dynamic = "force-dynamic";

/** Twelve short fields; 16 KiB is generous for that and still bounded. */
const maximumBodyBytes = 16_384;

interface CreateClientBody {
  readonly status: "created";
  readonly client: ClientSnapshot;
}

/**
 * Section 15's client create, over HTTP.
 *
 * ## The order of the checks
 *
 * CSRF first - a form post from another origin cannot read the token this compares - then the
 * declared length, then the session, then the parse, then the service, which applies the `owner`
 * role, reads the company from the session (never from the body, so a crafted request cannot write
 * another merchant's row) and validates every field with the Zod schema before the insert.
 *
 * ## What the answer carries
 *
 * The created snapshot, so the form can navigate to the edit screen with the row it just made. The
 * answer is `no-store`: a client list is personal data, and no cache between the browser and the
 * server may keep a copy.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<CreateClientBody>> => {
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

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "client", rule: "invalid_format" }],
      });
    }

    const client = await createClient(
      {
        actor,
        body,
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("client created", {
      userId: actor.userId,
      companyId: client.companyId,
      clientId: client.id,
    });

    return NextResponse.json(
      { status: "created", client },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
