// path: app/api/products/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { createCatalogueEntry, type CatalogueSnapshot } from "@/services/products/catalogue";
import type { CatalogueKind } from "@/services/products/catalogue-fields";

export const dynamic = "force-dynamic";

/** Six short fields; 16 KiB is generous for that and still bounded. */
const maximumBodyBytes = 16_384;

const KIND: CatalogueKind = "product";

interface CreateCatalogueBody {
  readonly status: "created";
  readonly entry: CatalogueSnapshot;
}

/**
 * The create half of the catalogue routes, written once for both catalogues.
 *
 * ## Why this factory exists
 *
 * `products` and `services` are the same request with a different table name, and four route files
 * that differed only in a constant would be four places to fix one bug. The only thing a route file
 * may not invent is its path: Next reads the method handlers from the segment's own file, so each path
 * gets a thin file that calls this factory with its kind and nothing else.
 *
 * ## The order of the checks
 *
 * CSRF first - a form post from another origin cannot read the token this compares - then the
 * declared length, then the session, then the parse, then the service, which applies the `owner` role,
 * reads the company from the session (never from the body, so a crafted request cannot write another
 * merchant's catalogue) and validates every field with the Zod schema before the insert. The answer is
 * `no-store`: a catalogue is commercial information and no cache between the merchant and the server
 * may keep a copy.
 */
export function createCatalogueRoute(kind: CatalogueKind) {
  return withErrorResponse(
    async (request: Request): Promise<NextResponse<CreateCatalogueBody>> => {
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
          details: [{ field: kind, rule: "invalid_format" }],
        });
      }

      const entry = await createCatalogueEntry(
        { actor, kind, body },
        { rest: runtime.rest, audit: runtime.audit },
      );

      logger.info(`${kind} created`, {
        userId: actor.userId,
        companyId: entry.companyId,
        entryId: entry.id,
      });

      return NextResponse.json(
        { status: "created", entry },
        { status: 201, headers: { "cache-control": "no-store" } },
      );
    },
  );
}

export const POST = createCatalogueRoute(KIND);
