// path: app/api/clients/[id]/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { getClient, updateClient, type ClientSnapshot } from "@/services/clients/clients";

export const dynamic = "force-dynamic";

/** Twelve short fields; 16 KiB is generous for that and still bounded. */
const maximumBodyBytes = 16_384;

interface ClientBody {
  readonly status: "ok" | "updated";
  readonly client: ClientSnapshot;
}

/**
 * One client of the signed in merchant, over HTTP: `GET` reads it for the edit form, `POST` edits it.
 *
 * ## The order of the checks on the write
 *
 * CSRF first, then the declared length, then the session, then the parse, then the service - which
 * applies the `owner` role, the company scope and the Zod schema, and re-checks the address rule on
 * the merged row, because clearing the street line while a city is still stored is refused exactly
 * like setting a city with no street line.
 *
 * ## Why the id comes from the path, not the body
 *
 * The body names only the fields it changes; the row it changes is the path's. A request that posts
 * an id in the body cannot make the service update a different row than the URL names.
 */
function clientIdOf(params: Promise<{ readonly id: string }>): Promise<string> {
  return params.then((resolved) => decodeURIComponent(resolved.id));
}

export const GET = withErrorResponse(
  async (request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse<ClientBody>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const client = await getClient(
      { actor, clientId: await clientIdOf(context.params) },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json(
      { status: "ok", client },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);

export const POST = withErrorResponse(
  async (request: Request, context: { readonly params: Promise<{ readonly id: string }> }): Promise<NextResponse<ClientBody>> => {
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

    const client = await updateClient(
      { actor, clientId: await clientIdOf(context.params), body },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("client updated", {
      userId: actor.userId,
      companyId: client.companyId,
      clientId: client.id,
    });

    return NextResponse.json(
      { status: "updated", client },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
