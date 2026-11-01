// path: lib/auth/request-proof.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import {
  isProofKeyAlgorithm,
  REQUEST_PROOF_DEVICE_KEY_PATTERN,
  REQUEST_PROOF_HEADERS,
  REQUEST_PROOF_NONCE_PATTERN,
  REQUEST_PROOF_SIGNATURE_MAXIMUM_LENGTH,
  REQUEST_PROOF_TIMESTAMP_PATTERN,
  REQUEST_PROOF_WINDOW_MS,
  requestBodyDigest,
  requestProofMessage,
  verifyProofMessage,
  type ProofKeyAlgorithm,
} from "./proof-key.ts";
import { isConflictError, type RestClient } from "./rest.ts";
import type { RequestActor } from "./types.ts";

/**
 * The signature check on the endpoints where a cookie is not enough.
 *
 * Section 22 says the session cookie "works only inside its own session" and asks for a per-device
 * proof key. STEP 049 made the key exist; this module makes a session prove it holds the key before
 * one of the platform's dangerous actions happens - minting backup codes, approving a second factor
 * reset, unlocking an account.
 *
 * ## What is being defended against
 *
 * A cookie is a bearer token: whoever copies it is the merchant as far as every endpoint is
 * concerned. The proof key is not. Its private half cannot be exported from the browser that
 * generated it (STEP 049), so a copied cookie on another machine has no way to produce a signature,
 * and the sensitive endpoints refuse it. That is the whole value of the feature: the cookie proves
 * *which account*, the signature proves *which device*.
 *
 * ## Replay, in the two layers it needs
 *
 * A signature is valid for the bytes it signed, for ever. Two things bound that:
 *
 *   - the **clock**: the signed timestamp must be within `REQUEST_PROOF_WINDOW_MS` of the server's,
 *     so an old capture stops working by itself;
 *   - the **nonce**: `0088_request_proof_nonces.sql` has a unique index on `(device, nonce)`, so a
 *     capture replayed inside those two minutes collides on the insert and is refused.
 *
 * Neither alone is enough: the clock cannot tell two requests in the same second apart, and a nonce
 * table with no window grows for ever and would accept a signature from last year.
 *
 * ## Why one sentence for every refusal
 *
 * Missing headers, a stale timestamp, a device that belongs to somebody else, a signature over a
 * different body and a replayed nonce all answer `401 AUTHENTICATION_REQUIRED` with no details. The
 * office routes are not anonymous, so this is not about hiding an account: it is about not telling an
 * attacker which part of the proof to fix. The difference lives in the audit entry, which only the
 * platform reads.
 *
 * ## Trust is reported here and enforced by the caller
 *
 * `trusted_at` is read with the key and reported as `trusted`, because the two questions are
 * different: the proof answers *which device*, and `device_proof_keys.trusted_at` answers *has the
 * owner confirmed that device* (STEP 052). The verification itself does not refuse an unconfirmed
 * key - every key the platform creates starts that way, and the sign in that enrols one has to be
 * able to reach the screen that confirms it - so the decision belongs to the route that knows what
 * the action costs. `requireTrustedDevice` is that decision, in one place: the three endpoints of
 * the list all hand out a way in, and a device nobody has confirmed does not get one.
 */

/** The code every refusal answers. */
const refusalCode = "AUTHENTICATION_REQUIRED";

/** The longest path a proof may name, matching `0088`'s `path` check. */
const maximumPathLength = 200;

/** One endpoint this platform will not act on without a proof. */
export interface SensitiveEndpoint {
  /** The method that is signed. Proofs are only accepted on methods that mutate. */
  readonly method: "POST";
  /** The pathname, without a query string. */
  readonly path: string;
  /** Why this endpoint is on the list, in one sentence a reader can weigh. */
  readonly note: string;
}

/**
 * The sensitive endpoints, in one place.
 *
 * The list is data so the gate can compare it with the routes that exist: an endpoint that starts
 * requiring a proof cannot quietly stop, and a route that is added to this list without a browser
 * that signs is a route the gate names. The three below are the ones section 22 or the platform's
 * own shape makes dangerous - ten new backup codes are ten ways in, an approved reset removes a
 * second factor, and an unlock closes the lock that was stopping a password guess.
 */
export const SENSITIVE_ENDPOINTS: readonly SensitiveEndpoint[] = [
  {
    method: "POST",
    path: "/api/auth/2fa/backup-codes",
    note: "Minting a new set of backup codes replaces every code the account held.",
  },
  {
    method: "POST",
    path: "/api/office/2fa-reset-requests/decision",
    note: "An approval clears the second factor of the account it names.",
  },
  {
    method: "POST",
    path: "/api/auth/session/reauth",
    note: "Section 22's step-up: a stale session buys ten more minutes of freshness here, so the request that buys it is signed like the actions it unlocks.",
  },
  {
    method: "POST",
    path: "/api/office/account-locks/unlock",
    note: "Section 22: an unlock ends the lock that stopped a password guess.",
  },
  {
    method: "POST",
    path: "/api/auth/sessions/revoke",
    note: "Section 22's instant revocation (STEP 054): the owner ends a session of their own account, so the request that ends a door is signed by the browser holding the key.",
  },
  {
    method: "POST",
    path: "/api/office/sessions/revoke",
    note: "Section 22's instant revocation (STEP 054) for an office role: the request that signs a merchant out is signed, so a copied office cookie cannot spend it.",
  },
  {
    method: "POST",
    path: "/api/office/approvals",
    note: "Section 2's approval chain (STEP 070): a request into the queue says that money may move, so the browser that raises it is the one that signs.",
  },
  {
    method: "POST",
    path: "/api/office/gateways",
    note: "Section 6's gateway page (STEP 069): storing a provider key or changing a provider's state is the request that decides where money is routed, so it is signed by the browser holding the key.",
  },
];

/** True when this path is one this platform requires a proof for. */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_ENDPOINTS.some((endpoint) => endpoint.path === path);
}

/** The device row a proof names, as the check reads it. */
const deviceRowSchema = z.object({
  id: z.string().min(1).max(64),
  public_key: z.string().min(32).max(512),
  algorithm: z.string().min(1).max(16),
  trusted_at: z.string().min(20).max(40).nullable(),
});

/** Why a proof was refused. Internal: it reaches the audit payload and the log, never a response. */
export type ProofRejectionReason =
  | "missing-header"
  | "malformed-header"
  | "query-not-signed"
  | "path-not-sensitive"
  | "method-mismatch"
  | "stale-timestamp"
  | "unknown-device"
  | "session-device-mismatch"
  | "signature"
  | "replayed";

/** What a verified request proved, so the route may record it. */
export interface RequestProofOutcome {
  readonly deviceKeyId: string;
  readonly algorithm: ProofKeyAlgorithm;
  /** False until STEP 052 confirms the device. Reported, not enforced, by design. */
  readonly trusted: boolean;
  readonly signedAtEpochMs: number;
  readonly nonce: string;
}

export interface RequestProofInput {
  /** The request as the route received it. Its body must not have been read yet. */
  readonly request: Request;
  /** The body read once, as text: the signature covers these exact bytes. */
  readonly bodyText: string;
  /** The actor the cookie named. A proof is always checked for somebody already signed in. */
  readonly actor: RequestActor;
}

export interface RequestProofDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** A refusal, with the reason kept for the log and the audit entry. */
class ProofRefusal extends Error {
  readonly reason: ProofRejectionReason;

  constructor(reason: ProofRejectionReason) {
    super(reason);
    this.name = "ProofRefusal";
    this.reason = reason;
  }
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name);

  return value === null || value.length === 0 ? null : value;
}

/** True when the value is one of the algorithms `0009` allows. */
function algorithmOf(value: string): ProofKeyAlgorithm | null {
  return isProofKeyAlgorithm(value) ? value : null;
}

/**
 * Verify the proof of one sensitive request, or refuse it.
 *
 * The order is the cheapest refusal first, and every branch that touches the network comes after a
 * shape it can be sure of: headers, then the URL, then the clock, then the device row, then the
 * signature, and only last the nonce insert that costs a round trip and a row.
 *
 * Throws `AUTHENTICATION_REQUIRED` on refusal, after appending one `user.request_proof_rejected`
 * audit entry naming the reason. A verified proof writes no audit entry of its own: the action the
 * route performs is already audited by the service behind it, and the entry would name nothing that
 * entry does not.
 */
export async function verifySensitiveRequest(
  input: RequestProofInput,
  dependencies: RequestProofDependencies,
): Promise<RequestProofOutcome> {
  const now = dependencies.now ?? ((): number => Date.now());

  try {
    const outcome = await verify(input, dependencies, now());

    return outcome;
  } catch (error) {
    const reason: ProofRejectionReason = error instanceof ProofRefusal ? error.reason : "malformed-header";

    if (!(error instanceof ProofRefusal) && !(error instanceof AppError)) {
      throw new AppError(refusalCode);
    }

    await dependencies.audit
      .append({
        action: "user.request_proof_rejected",
        actorUserId: input.actor.userId,
        entityType: "user",
        entityId: input.actor.userId,
        companyId: input.actor.companyId,
        ...(input.actor.sessionId === null ? {} : { sessionId: input.actor.sessionId }),
        payload: { reason, method: input.request.method },
      })
      .catch(() => undefined);

    throw new AppError(refusalCode);
  }
}

/**
 * Refuse an action whose proof came from a device the owner has not confirmed.
 *
 * STEP 052 is the step that makes the flag mean something. Until a session's device is confirmed -
 * which needs the owner's authenticator code, not another email - the platform's dangerous actions
 * stay closed: ten fresh backup codes and an approved reset are the two ways a stolen session turns
 * into a stolen account, and neither is worth waiting for a genuine machine.
 *
 * `PERMISSION_DENIED` and not `AUTHENTICATION_REQUIRED`: the caller proved an account and a device,
 * and is not allowed to do this until the device is confirmed. That is a difference the screen can
 * act on - it sends the merchant to the confirmation - and a 401 would read as "sign in again",
 * which is exactly what would not help.
 *
 * STEP 053 added the step-up endpoint to the list for the same reason: it is the request that makes
 * a stale session fresh, so it is signed like the actions it unlocks.
 */
export function requireTrustedDevice(outcome: RequestProofOutcome): void {
  if (!outcome.trusted) {
    throw new AppError("PERMISSION_DENIED");
  }
}

/** The verification itself, throwing a `ProofRefusal` with the reason it stopped at. */
async function verify(
  input: RequestProofInput,
  dependencies: RequestProofDependencies,
  nowEpochMs: number,
): Promise<RequestProofOutcome> {
  const deviceKeyId = header(input.request, REQUEST_PROOF_HEADERS.deviceKey);
  const timestamp = header(input.request, REQUEST_PROOF_HEADERS.timestamp);
  const nonce = header(input.request, REQUEST_PROOF_HEADERS.nonce);
  const signature = header(input.request, REQUEST_PROOF_HEADERS.signature);

  if (deviceKeyId === null || timestamp === null || nonce === null || signature === null) {
    throw new ProofRefusal("missing-header");
  }

  if (
    !REQUEST_PROOF_DEVICE_KEY_PATTERN.test(deviceKeyId) ||
    !REQUEST_PROOF_TIMESTAMP_PATTERN.test(timestamp) ||
    !REQUEST_PROOF_NONCE_PATTERN.test(nonce) ||
    signature.length > REQUEST_PROOF_SIGNATURE_MAXIMUM_LENGTH
  ) {
    throw new ProofRefusal("malformed-header");
  }

  const url = new URL(input.request.url);

  // A query string is not part of the signed message, so a request that carries one has parameters
  // nobody signed. Refusing is the only honest answer; signing a partial request would be worse.
  if (url.search.length > 0) {
    throw new ProofRefusal("query-not-signed");
  }

  const endpoint = SENSITIVE_ENDPOINTS.find((candidate) => candidate.path === url.pathname);

  if (endpoint === undefined || url.pathname.length > maximumPathLength) {
    throw new ProofRefusal("path-not-sensitive");
  }

  if (input.request.method.toUpperCase() !== endpoint.method) {
    throw new ProofRefusal("method-mismatch");
  }

  const signedAtEpochMs = Number.parseInt(timestamp, 10);

  if (Math.abs(nowEpochMs - signedAtEpochMs) > REQUEST_PROOF_WINDOW_MS) {
    throw new ProofRefusal("stale-timestamp");
  }

  const rows = await dependencies.rest.select(
    "device_proof_keys",
    `select=id,public_key,algorithm,trusted_at&id=eq.${encodeURIComponent(deviceKeyId)}` +
      `&user_id=eq.${encodeURIComponent(input.actor.userId)}&revoked_at=is.null&deleted_at=is.null&limit=1`,
    deviceRowSchema,
  );
  const device = rows[0];

  if (device === undefined) {
    throw new ProofRefusal("unknown-device");
  }

  const algorithm = algorithmOf(device.algorithm);

  if (algorithm === null) {
    throw new ProofRefusal("unknown-device");
  }

  // The session names the device it was issued for (STEP 051), so a signature from another device of
  // the same account is not evidence about this session. Refusing here is what makes
  // `sessions.device_proof_key_id` a binding rather than a comment.
  if (input.actor.deviceProofKeyId !== null && input.actor.deviceProofKeyId !== device.id) {
    throw new ProofRefusal("session-device-mismatch");
  }

  const verified = await verifyProofMessage({
    publicKeyBase64Url: device.public_key,
    algorithm,
    message: requestProofMessage({
      method: input.request.method,
      path: url.pathname,
      bodyDigest: await requestBodyDigest(input.bodyText),
      timestamp,
      nonce,
      deviceKeyId: device.id,
    }),
    signatureBase64Url: signature,
  });

  if (!verified) {
    throw new ProofRefusal("signature");
  }

  // The nonce is spent last, because it is the only step that writes: a request with a bad signature
  // must not be able to fill the table, and one with a good signature must not be able to spend its
  // nonce twice.
  try {
    await dependencies.rest.insert("request_proof_nonces", [
      {
        company_id: input.actor.companyId,
        user_id: input.actor.userId,
        device_proof_key_id: device.id,
        nonce,
        method: input.request.method.toUpperCase(),
        path: url.pathname,
        signed_at: new Date(signedAtEpochMs).toISOString(),
        expires_at: new Date(signedAtEpochMs + REQUEST_PROOF_WINDOW_MS).toISOString(),
      },
    ]);
  } catch (error) {
    if (isConflictError(error)) {
      throw new ProofRefusal("replayed");
    }

    throw error instanceof AppError ? error : new AppError(refusalCode);
  }

  return {
    deviceKeyId: device.id,
    algorithm,
    trusted: device.trusted_at !== null,
    signedAtEpochMs,
    nonce,
  };
}
