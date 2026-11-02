// path: app/api/office/announcements/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import {
  dismissAnnouncement,
  publishAnnouncement,
  saveAnnouncement,
  withdrawAnnouncement,
  type AnnouncementAdminSnapshot,
  type DismissalResult,
} from "@/lib/announcements/service";
import { getAnnouncementsRuntime } from "@/lib/announcements/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Section 24's announcements, over HTTP: the composer's three writes and the one every person makes.
 *
 * ## Four actions, two guards
 *
 * `save`, `publish` and `withdraw` are the composer's, and the service refuses them to every role but
 * the super administrator, with a second factor proved recently. `dismiss` is the person's, and any
 * role may make it - which is why the service checks the acting role per action rather than this
 * route checking one list for all four. The route checks what all four share: CSRF, the session, the
 * device proof over the exact bytes, the body's size and its JSON.
 *
 * ## Why the dismiss lives here rather than on a public route
 *
 * The popup is mounted by the office shell, so this is the address its button has. The STEP after the
 * merchant shell exists adds the address a merchant's popup posts to; the service call behind both is
 * already the one this route makes, and it needs no role but the person's own.
 */

/** A headline, a body of at most five thousand characters and a day. 16 KiB bounds all four bodies. */
const maximumBodyBytes = 16_384;

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

/** The expiry day, or null when the form left it empty. */
function readOptionalText(body: unknown, key: string): string | null {
  const value = readField(body, key);

  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: key, rule: "invalid_format" }] });
  }

  return value;
}

export const POST = withErrorResponse(
  async (
    request: Request,
  ): Promise<NextResponse<AnnouncementAdminSnapshot | DismissalResult>> => {
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
    const announcements = getAnnouncementsRuntime();

    if (action === "save") {
      const snapshot = await saveAnnouncement(
        {
          actor,
          announcementId: readOptionalText(body, "announcementId"),
          title: readText(body, "title"),
          body: readText(body, "body"),
          level: readText(body, "level"),
          audience: readText(body, "audience"),
          expiresOn: readOptionalText(body, "expiresOn"),
        },
        announcements,
      );

      logger.info("announcement draft saved", {
        created: readOptionalText(body, "announcementId") === null,
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (action === "publish" || action === "withdraw") {
      const announcementId = readText(body, "announcementId");
      const snapshot =
        action === "publish"
          ? await publishAnnouncement({ actor, announcementId }, announcements)
          : await withdrawAnnouncement({ actor, announcementId }, announcements);

      logger.info(action === "publish" ? "announcement published" : "announcement withdrawn", {
        announcementId,
        actorUserId: actor.userId,
      });

      return NextResponse.json(snapshot, { status: 200, headers: { "cache-control": "no-store" } });
    }

    if (action === "dismiss") {
      const result = await dismissAnnouncement(
        { actor, announcementId: readText(body, "announcementId") },
        announcements,
      );

      logger.info("announcement dismissed", {
        announcementId: result.announcementId,
        recorded: result.recorded,
        actorUserId: actor.userId,
      });

      return NextResponse.json(result, { status: 200, headers: { "cache-control": "no-store" } });
    }

    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "action", rule: "invalid_format" }],
    });
  },
);
