// path: app/api/products/[id]/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  deleteCatalogueEntry,
  getCatalogueEntry,
  updateCatalogueEntry,
  type CatalogueSnapshot,
} from "@/services/products/catalogue";
import type { CatalogueKind } from "@/services/products/catalogue-fields";

export const dynamic = "force-dynamic";

/** Six short fields; 16 KiB is generous for that and still bounded. */
const maximumBodyBytes = 16_384;

const KIND: CatalogueKind = "product";

interface CatalogueBody {
  readonly status: "ok" | "updated" | "deleted";
  readonly entry: CatalogueSnapshot;
}

function entryIdOf(params: Promise<{ readonly id: string }>): Promise<string> {
  return params.then((resolved) => decodeURIComponent(resolved.id));
}

/**
 * One row of a catalogue over HTTP: `GET` reads it, `POST` edits it, `DELETE` removes it.
 *
 * ## Why the id comes from the path, not the body
 *
 * The body names only the fields it changes; the row it changes is the path's. A request that posts an
 * id in the body cannot make the service update a different row than the URL names.
 *
 * ## The order of the checks on the write
 *
 * CSRF first, then the declared length, then the session, then the parse, then the service - which
 * applies the `owner` role and the company scope, merges the sent fields onto the stored row so one
 * broken field is reported even in a partial edit, and re-reads afterwards so a row removed under the
 * writer is a 404 and not a silent success.
 *
 * Exported as a factory for the same reason the create route is: the second catalogue is this request
 * with a different table name.
 */
export function createCatalogueEntryRoute(kind: CatalogueKind) {
  const POST = withErrorResponse(
    async (
      request: Request,
      context: { readonly params: Promise<{ readonly id: string }> },
    ): Promise<NextResponse<CatalogueBody>> => {
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

      const entry = await updateCatalogueEntry(
        { actor, kind, entryId: await entryIdOf(context.params), body },
        { rest: runtime.rest, audit: runtime.audit },
      );

      logger.info(`${kind} updated`, {
        userId: actor.userId,
        companyId: entry.companyId,
        entryId: entry.id,
      });

      return NextResponse.json(
        { status: "updated", entry },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    },
  );

  const GET = withErrorResponse(
    async (
      request: Request,
      context: { readonly params: Promise<{ readonly id: string }> },
    ): Promise<NextResponse<CatalogueBody>> => {
      const runtime = getAuthRuntime();
      const actor = await readRequestActor(request.headers.get("cookie"), {
        directory: runtime.directory,
        cookiePolicy: runtime.cookiePolicy,
        sessions: runtime.sessions,
        audit: runtime.audit,
      });

      const entry = await getCatalogueEntry(
        { actor, kind, entryId: await entryIdOf(context.params) },
        { rest: runtime.rest, audit: runtime.audit },
      );

      return NextResponse.json(
        { status: "ok", entry },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    },
  );

  /**
   * Remove one entry, keeping the row.
   *
   * A removal is a mutation, so it carries the CSRF token like every other write of this block and the
   * check comes first. There is no body: the path names the row. The service marks it (`0020`/`0021`
   * carry `deleted_at` because an invoice line will point at this entry), so the answer says the entry
   * left the catalogue rather than that it was erased.
   */
  const DELETE = withErrorResponse(
    async (
      request: Request,
      context: { readonly params: Promise<{ readonly id: string }> },
    ): Promise<NextResponse<CatalogueBody>> => {
      requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

      const runtime = getAuthRuntime();
      const actor = await readRequestActor(request.headers.get("cookie"), {
        directory: runtime.directory,
        cookiePolicy: runtime.cookiePolicy,
        sessions: runtime.sessions,
        audit: runtime.audit,
      });

      const entry = await deleteCatalogueEntry(
        { actor, kind, entryId: await entryIdOf(context.params) },
        { rest: runtime.rest, audit: runtime.audit },
      );

      logger.info(`${kind} deleted`, {
        userId: actor.userId,
        companyId: entry.companyId,
        entryId: entry.id,
      });

      return NextResponse.json(
        { status: "deleted", entry },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    },
  );

  return { GET, POST, DELETE };
}

const handlers = createCatalogueEntryRoute(KIND);

export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
