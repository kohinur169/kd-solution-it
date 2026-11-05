// path: app/api/office/provisioning/acknowledge/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { acknowledgeProvisioningAlert } from "@/services/submerchant/provisioning-queue";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireFreshReauthentication } from "@/lib/auth/step-up";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/** A provision id and a note of at most 280 characters. */
const maximumBodyBytes = 4_096;

interface AcknowledgeResponseBody {
  readonly status: "acknowledged";
  readonly provisionId: string;
  readonly acknowledgedAt: string;
}

function readField(body: unknown, key: string): unknown {
  if (typeof body !== "object" || body === null || !(key in body)) {
    return undefined;
  }

  return (body as Readonly<Record<string, unknown>>)[key];
}

/**
 * The office acknowledgement of a queued provisioning.
 *
 * The route is a boundary and nothing more: a body ceiling, a JSON parse, the shape of two fields, the
 * actor from the session cookie and one call into the service. Every decision that matters - the role,
 * the second factor, the freshness of the reauthentication, the trust of the device, that the row exists
 * and is still queued, and the audit entry itself - is inside `acknowledgeProvisioningAlert`, so a second
 * caller cannot get a weaker version of this endpoint by calling the service directly.
 *
 * The answer is deliberately small: the provision that was acknowledged and the instant it happened. It
 * carries no company name and no note, so the response of an office action never becomes a way to read a
 * merchant's record.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<AcknowledgeResponseBody>> => {
    // STEP 057: the first thing a mutation checks, because it costs one string comparison.
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    // Read once as text, so the signature and the parser see the same bytes.
    const bodyText = await request.text();
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    // Acknowledging an alert is an office decision about a merchant, so the cookie is not enough on its
    // own: the proof says which device, and a device nobody has confirmed gets no way in.
    requireTrustedDevice(
      await verifySensitiveRequest(
        { request, bodyText, actor },
        { rest: runtime.rest, audit: runtime.audit },
      ),
    );

    // An alert acknowledged this afternoon must have been seen by someone holding the authenticator this
    // afternoon. The refusal is `403` with `reauth_required`, which the office screen turns into a link to
    // the reauthentication, and it is asked after the proof and the device trust so a session that is not
    // allowed here at all never learns how fresh it is.
    requireFreshReauthentication(actor);

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "provisionId", rule: "invalid_format" }],
      });
    }

    const provisionId = readField(body, "provisionId");
    const note = readField(body, "note");

    if (typeof provisionId !== "string" || typeof note !== "string") {
      throw new AppError("VALIDATION_FAILED", {
        details: [
          ...(typeof provisionId === "string" ? [] : [{ field: "provisionId", rule: "invalid_format" }]),
          ...(typeof note === "string" ? [] : [{ field: "note", rule: "invalid_format" }]),
        ],
      });
    }

    const acknowledgement = await acknowledgeProvisioningAlert(
      { actor, provisionId, note },
      { rest: runtime.rest, audit: runtime.audit },
    );

    // The note is deliberately not logged: it can name a merchant's situation, and the audit entry already
    // carries it where the trail is meant to be read.
    logger.info("provisioning alert acknowledged by the office", {
      provisionId: acknowledgement.provisionId,
      actorUserId: actor.userId,
    });

    return NextResponse.json(
      {
        status: "acknowledged",
        provisionId: acknowledgement.provisionId,
        acknowledgedAt: acknowledgement.acknowledgedAt,
      } satisfies AcknowledgeResponseBody,
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
