// path: app/api/developers/api-credentials/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { createMerchantCredential, type CredentialDependencies } from "@/lib/api/credentials";
import { getCredentialRuntime } from "@/lib/api/credential-runtime";
import { CREDENTIAL_MAXIMUM_BODY_BYTES, type CredentialView } from "@/lib/api/credential-fields";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

interface CreateCredentialResponse {
  readonly status: "created";
  readonly credential: CredentialView;
}

/**
 * Section 20's credential create, over HTTP.
 *
 * ## The answer carries no key
 *
 * The response is the `CredentialView` and nothing else: a label, a mode, a handle, the last four characters
 * and the mask built from them. Section 20 says a full key is never displayed, so the key this route causes
 * to exist is hashed and dropped inside the service and cannot travel out of here - and the log line below
 * names the credential by id, mode and label *length*, never by any part of the key.
 *
 * ## The order of the checks
 *
 * CSRF first, then the declared length, then the decoded length, then the session, then the JSON parse, then
 * the service - which applies the `owner` role, takes the company from the session rather than the body, and
 * validates the label and mode. The gate asserts this order.
 *
 * ## Why the answer is `no-store`
 *
 * A credential list is a security surface: the mask, the handle and the tail are what an attacker would use
 * to phish a merchant into pasting a key somewhere. No cache between the merchant and the server may keep a
 * copy of that, even a masked one.
 */
export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<CreateCredentialResponse>> => {
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

    const dependencies: CredentialDependencies = getCredentialRuntime();
    const credential = await createMerchantCredential({ actor, body }, dependencies);

    logger.info("api credential created", {
      userId: actor.userId,
      companyId: actor.companyId,
      credentialId: credential.id,
      mode: credential.mode,
      labelLength: credential.label.length,
    });

    return NextResponse.json(
      { status: "created", credential },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  },
);
