// path: app/api/developers/api-credentials/[id]/regenerate/route.ts
import { NextResponse } from "next/server";
import { getCredentialRuntime } from "@/lib/api/credential-runtime";
import { CREDENTIAL_MAXIMUM_BODY_BYTES, type CredentialView } from "@/lib/api/credential-fields";
import { regenerateCredential } from "@/lib/api/credentials";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

interface RegenerateResponse {
  readonly status: "regenerated";
  /** The successor, under the name the merchant knows. */
  readonly credential: CredentialView;
  /** The predecessor, renamed and revoked, still readable. */
  readonly previous: CredentialView;
}

/** The id in the path, decoded, and handed to the service which decides whether it is one. */
function credentialIdOf(params: Promise<{ readonly id: string }>): Promise<string> {
  return params.then((resolved) => decodeURIComponent(resolved.id));
}

/**
 * Section 20's regeneration: a new key for a credential that is still in use.
 *
 * ## Why this is not "revoke, then create"
 *
 * Because the merchant would then have to retype the name, and because the two acts are not the same decision:
 * a rotation keeps the integration's identity - same label, same mode, same place in the list - and replaces the
 * secret. `0034` already models that with `rotated_from_id`, whose unique index says a credential replaces at
 * most one predecessor, and the service writes the three steps in the order that fails safest: rename the
 * predecessor, insert the successor, then revoke the predecessor.
 *
 * ## The answer carries two views and no key
 *
 * The successor's mask and the predecessor's, so the screen can say what happened to both. Section 20's
 * "never displayed" holds here exactly as it does at creation.
 *
 * ## The order of the checks
 *
 * The same five as every mutating route in this codebase: CSRF, declared length, decoded length, session, parse -
 * and the body of a rotation is an empty object, so the parse is a refusal for anything a client tries to smuggle
 * in.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<RegenerateResponse>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > CREDENTIAL_MAXIMUM_BODY_BYTES) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > CREDENTIAL_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    if (bodyText.trim().length > 0) {
      let body: unknown;

      try {
        body = JSON.parse(bodyText) as unknown;
      } catch {
        throw new AppError("VALIDATION_FAILED", {
          details: [{ field: "credential", rule: "invalid_format" }],
        });
      }

      if (typeof body !== "object" || body === null || Object.keys(body).length > 0) {
        throw new AppError("VALIDATION_FAILED", {
          details: [{ field: "credential", rule: "invalid_format" }],
        });
      }
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    const rotated = await regenerateCredential(
      { actor, credentialId: await credentialIdOf(context.params) },
      getCredentialRuntime(),
    );

    logger.info("api credential regenerated", {
      userId: actor.userId,
      companyId: actor.companyId,
      credentialId: rotated.credential.id,
      previousCredentialId: rotated.previous.id,
      mode: rotated.credential.mode,
    });

    return NextResponse.json(
      { status: "regenerated", credential: rotated.credential, previous: rotated.previous },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
