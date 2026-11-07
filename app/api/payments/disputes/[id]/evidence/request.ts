// path: app/api/payments/disputes/[id]/evidence/request.ts
import type { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { DISPUTE_EVIDENCE_FIELD } from "@/services/disputes/dispute-evidence";
import { DISPUTE_EVIDENCE_MAXIMUM_BODY_BYTES } from "@/services/disputes/dispute-evidence-fields";

/**
 * The three things all four evidence routes do the same way.
 *
 * A route in this folder is a boundary and nothing else: the ceiling, the session, the parse, one service
 * call. The three steps are here rather than copied four times because four copies of a body ceiling is how
 * one of them ends up reading a megabyte into memory, and because the refusal a caller sees must not depend
 * on which of the four endpoints they reached.
 */

/** The dispute id of the URL, decoded, or a not-found answer for an id that cannot be decoded. */
export async function evidenceDisputeId(context: {
  readonly params: Promise<{ readonly id: string }>;
}): Promise<string> {
  const parameters = await context.params;

  try {
    return decodeURIComponent(parameters.id);
  } catch {
    throw new AppError("RESOURCE_NOT_FOUND");
  }
}

/**
 * One JSON body, under a ceiling.
 *
 * The declared length is checked before the body is held and the text is measured again after it is read,
 * because `content-length` is a claim: a chunked request can declare nothing and send ten megabytes.
 */
export async function evidenceJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");

  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);

    if (Number.isFinite(parsed) && parsed > DISPUTE_EVIDENCE_MAXIMUM_BODY_BYTES) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }
  }

  const text = await request.text();

  if (new TextEncoder().encode(text).length > DISPUTE_EVIDENCE_MAXIMUM_BODY_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE");
  }

  if (text.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: DISPUTE_EVIDENCE_FIELD, rule: "invalid_format" }] });
  }
}

/**
 * The cookie reader's wiring, as a value.
 *
 * Each route calls `readRequestActor` with this, rather than calling a helper that hides the call: the session
 * reading stays in the file a reviewer opens, and the wiring stays in one place. No device proof is asked for,
 * because a pack is the merchant's own paperwork, not a decision about money.
 */
export function evidenceAuthReader(): Parameters<typeof readRequestActor>[1] {
  const runtime = getAuthRuntime();

  return {
    directory: runtime.directory,
    cookiePolicy: runtime.cookiePolicy,
    sessions: runtime.sessions,
    audit: runtime.audit,
  };
}
