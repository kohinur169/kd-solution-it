// path: app/api/clients/import/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  importClients,
  type ClientImportReport,
} from "@/services/clients/client-import";
import { MAXIMUM_CSV_CHARACTERS, MAXIMUM_CSV_ROWS } from "@/services/clients/csv";

export const dynamic = "force-dynamic";

/**
 * A CSV of a thousand client rows with twelve columns each is well under a megabyte; this is the
 * parser's own ceiling in bytes, with room for a multi-byte name, and it is checked before the body is
 * read so an oversized upload is refused without being held in memory.
 */
const maximumBodyBytes = MAXIMUM_CSV_CHARACTERS * 3;

/** The content types a browser sends for a `.csv` a merchant picked. */
const ACCEPTED_CONTENT_TYPES = ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"] as const;

interface ImportAnswer {
  readonly status: "imported" | "refused";
  /** Present when at least the file was read: the per-row report. */
  readonly report: ClientImportReport | null;
  /** Present when the file as a whole was refused, naming which defect and where. */
  readonly problem: string | null;
  readonly line: number | null;
}

/**
 * Section 15's client CSV import, over HTTP.
 *
 * ## Why the body is text and not multipart
 *
 * The file is CSV, which is text by definition, and the merchant's browser already has it as text. A
 * multipart upload would bring a boundary parser and a temporary file into a path whose whole job is
 * to read lines, so the route takes the file's bytes as the body with `text/csv` and reads them with
 * `request.text()`. That also keeps the size bound honest: `content-length` is the file's length.
 *
 * ## The order of the checks
 *
 * CSRF first, then the declared length, then the media type, then the session, then the import. The
 * session comes after the cheap refusals for the same reason every other write of this block does it
 * that way: a request that is not even shaped like an import should not cost a directory lookup, and a
 * refusal must never depend on who asked.
 *
 * ## Why a refused file is `200` with a body, and a refused request is not
 *
 * A file with one bad row is a successful import of the other rows, so it answers `200` with the
 * report - and a file whose *shape* is wrong (no name column, an unreadable quote) also answers `200`
 * with `status: "refused"` and the problem named, because it is the file the merchant chose rather
 * than the request that is malformed, and the screen needs the reason to show them. Only a request the
 * server will not process at all - no token, too large, wrong media type, no session - is an error
 * status, and those are the ones the error envelope already words.
 *
 * ## Why the answer is never cached
 *
 * The report names clients that were just created, and the refusal names the line an email failed on.
 * Both are about one merchant's data, so the answer is `no-store`.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<ImportAnswer>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

    if (!(ACCEPTED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
      // `UNSUPPORTED_MEDIA_TYPE`'s shared sentence reads "this endpoint accepts JSON request bodies
      // only", which is false for a route whose whole purpose is to accept CSV. The refusal is
      // therefore the validation code with a field and a rule, which the screen already words for
      // itself ("that file is not a CSV") and which cannot mislead a merchant reading the answer.
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "file", rule: "invalid_type" }] });
    }

    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const outcome = await importClients(
      { actor, text: bodyText },
      { rest: runtime.rest, audit: runtime.audit },
    );

    if (!outcome.ok) {
      logger.info("client import refused", {
        userId: actor.userId,
        companyId: actor.companyId,
        problem: outcome.problem,
        line: outcome.line,
      });

      return NextResponse.json(
        { status: "refused", report: null, problem: outcome.problem, line: outcome.line },
        { status: 200, headers: { "cache-control": "no-store" } },
      );
    }

    logger.info("client import finished", {
      userId: actor.userId,
      companyId: actor.companyId,
      created: outcome.report.created,
      refused: outcome.report.refused,
      maximumRows: MAXIMUM_CSV_ROWS,
    });

    return NextResponse.json(
      { status: "imported", report: outcome.report, problem: null, line: null },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
