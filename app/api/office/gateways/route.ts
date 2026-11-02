// path: app/api/office/gateways/route.ts
import { NextResponse } from "next/server";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { readClientAddress, readUserAgent } from "@/lib/auth/client-address";
import { readRequestActor } from "@/lib/auth/request-actor";
import { requireTrustedDevice, verifySensitiveRequest } from "@/lib/auth/request-proof";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { getGatewayRuntime } from "@/lib/gateways/runtime";
import {
  addGatewayKey,
  setGatewayEnabled,
  testGatewayKey,
  type GatewayMutationOutcome,
} from "@/lib/gateways/service";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";

export const dynamic = "force-dynamic";

/**
 * Section 6's four gateway actions, on one route.
 *
 * ## Why one route and not four
 *
 * Adding a key, testing a key, enabling a provider and disabling one are four transitions of one
 * state machine over two tables, and section 6 lists them as one capability. Four endpoints would
 * have meant four copies of the same five checks - CSRF, body bound, session, device proof, role and
 * freshness - and the copy that drifts is the one that forgets the proof. The action name selects
 * the transition, the service decides whether the account may take it, and there is nothing here to
 * keep in step with anything else.
 *
 * ## The order of the checks, and why
 *
 * CSRF first, because it costs one string comparison and refuses a cross site form before the body
 * is read. Then the declared length, so an oversized body is refused rather than buffered. Then the
 * session, because a proof is only meaningful for somebody who is signed in. Then the device proof,
 * which covers the exact bytes read as text - the parse comes last, so an altered body fails as a
 * signature rather than as a schema. The role and the step-up are inside the service, next to the
 * writes they guard.
 *
 * ## What never leaves this route
 *
 * The secret travels one way only: in the request body of `add_key`. It is not logged, not echoed in
 * a response and not put in an error. The response says what changed - the provider, its state, the
 * key's state and the test verdict - which is what the screen needs to say something true.
 */

/** One action, one label, one secret and one identifier: 4 KiB is generous and bounded. */
const maximumBodyBytes = 4_096;

const actions = ["add_key", "test_key", "enable", "disable"] as const;

type GatewayAction = (typeof actions)[number];

function isAction(value: unknown): value is GatewayAction {
  return typeof value === "string" && actions.some((action) => action === value);
}

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

export const POST = withErrorResponse(
  async (request: Request): Promise<NextResponse<GatewayMutationOutcome>> => {
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

    // A proof before a parse: the signature covers these bytes, so an altered body fails here.
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

    if (!isAction(action)) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "action", rule: "invalid_format" }],
      });
    }

    const gateways = getGatewayRuntime();

    const outcome =
      action === "add_key"
        ? await addGatewayKey(
            {
              actor,
              providerKey: readText(body, "providerKey"),
              mode: readText(body, "mode"),
              label: readText(body, "label"),
              secret: readText(body, "secret"),
            },
            gateways,
          )
        : action === "test_key"
          ? await testGatewayKey({ actor, keyId: readText(body, "keyId") }, gateways)
          : await setGatewayEnabled(
              {
                actor,
                providerKey: readText(body, "providerKey"),
                enabled: action === "enable",
              },
              gateways,
            );

    logger.info("gateway action applied", {
      action: outcome.action,
      providerKey: outcome.providerKey,
      providerStatus: outcome.providerStatus,
      keyStatus: outcome.keyStatus,
      actorUserId: actor.userId,
      clientAddress: readClientAddress(request.headers),
      userAgent: readUserAgent(request.headers),
    });

    return NextResponse.json(outcome, { status: 200, headers: { "cache-control": "no-store" } });
  },
);
