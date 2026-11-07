// path: app/api/developers/api-credentials/[id]/revoke/route.ts
import { NextResponse } from "next/server";
import { getCredentialRuntime } from "@/lib/api/credential-runtime";
import { CREDENTIAL_MAXIMUM_BODY_BYTES, type CredentialView } from "@/lib/api/credential-fields";
import { revokeCredential } from "@/lib/api/credentials";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

interface RevokeResponse {
  readonly status: "revoked";
  readonly credential: CredentialView;
}

/** The id in the path, decoded, and handed to the service which decides whether it is one. */
function credentialIdOf(params: Promise<{ readonly id: string }>): Promise<string> {
  return params.then((resolved) => decodeURIComponent(resolved.id));
}

/**
 * Section 20's revocation: *"Merchants create, revoke and regenerate API credentials."*
 *
 * ## What a revocation is
 *
 * A one-way change of state on one row: `active` becomes `revoked`, with the merchant's sentence and an instant.
 * `0034` refuses any later status change, so a revocation cannot be undone by this route, by a later STEP or by a
 * mistake - a merchant that wants the credential back makes a new one, which is what "revoke" has to mean for a
 * key that has been in a script somewhere.
 *
 * ## The order of the checks
 *
 * CSRF, then the declared length, then the decoded length, then the session, then the JSON parse, then the
 * service, which applies the `owner` role, takes the company from the session, refuses a credential another
 * merchant owns as a plain not-found, and guards the update with the version it read.
 *
 * ## Why the log line names the length of the reason
 *
 * A revocation reason is the merchant's prose and may name a place, a person or a system. The row keeps it; the
 * log keeps its existence. Nothing about the key appears in either.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<RevokeResponse>> => {
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
      // A chunked body declares no length, so the ceiling is enforced a second time on what arrived.
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

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
        details: [{ field: "credential", rule: "invalid_format" }],
      });
    }

    const credential = await revokeCredential(
      { actor, credentialId: await credentialIdOf(context.params), body },
      getCredentialRuntime(),
    );

    logger.info("api credential revoked", {
      userId: actor.userId,
      companyId: actor.companyId,
      credentialId: credential.id,
      keyLastFour: credential.keyLastFour,
      reasonLength: credential.revokeReason?.length ?? 0,
    });

    return NextResponse.json(
      { status: "revoked", credential },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
