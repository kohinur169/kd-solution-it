// path: lib/auth/device-enrolment.ts
import { createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuditTrail } from "./audit.ts";
import { readDeviceContext } from "./device-context.ts";
import {
  DEFAULT_PROOF_KEY_ALGORITHM,
  isPublicKeyShape,
  PROOF_KEY_ALGORITHMS,
  PROOF_KEY_LABEL_MAXIMUM_LENGTH,
  proofKeyFingerprint,
  proofKeyLabel,
  type ProofKeyAlgorithm,
} from "./proof-key.ts";
import { isConflictError, type RestClient } from "./rest.ts";

/**
 * Enrolment of one device proof key.
 *
 * Section 22 wants a proof key per device, `0009` stores one row per enrolled device, and STEP 049's
 * browser half generates the pair. This file is the server half: it decides whether the public key a
 * browser sent is a key at all, computes the one value the platform will ever compare, and writes the
 * row that a session will later be bound to.
 *
 * ## The server never trusts the client's fingerprint
 *
 * The browser computes the fingerprint too, because it has to store something stable. The server
 * recomputes it from the key it parsed and uses *its* answer: a client that sends a fingerprint for
 * a key it did not send would otherwise be writing its own identifier into a unique index. What the
 * client sent is not even accepted as an input field - `deviceEnrolmentSchema` has two fields, and a
 * third is refused, which is the cheapest way to make that impossible rather than merely ignored.
 *
 * ## A key is parsed, not pattern matched
 *
 * `inspectProofKey` decodes the base64url, refuses a string that is not its own canonical encoding,
 * parses the DER with `createPublicKey` and then checks the curve against the declared algorithm. A
 * base64url blob of the right length is not a key; the platform would be storing 91 bytes of
 * confident nonsense, and STEP 050 would be verifying signatures with it.
 *
 * ## Trust is STEP 052's
 *
 * A row is inserted with `trusted_at` null. Section 22 wants a new device confirmed by email and a
 * second factor before it is trusted, and STEP 052 owns that confirmation; this STEP only makes the
 * key exist, keeps it out of the way of a merchant's session, and records who enrolled what.
 */

/** The largest number of live devices one account may keep. Past it the answer is a conflict. */
const DEFAULT_MAXIMUM_DEVICES = 10;

/** The longest a public key may be, from `0009`'s own check. */
const maximumPublicKeyCharacters = 512;

/** The request the enrolment endpoint accepts. A third field is refused rather than ignored. */
export const deviceEnrolmentSchema = z
  .object({
    publicKey: z
      .string()
      .min(32)
      .max(maximumPublicKeyCharacters)
      .regex(/^[A-Za-z0-9_-]+$/u),
    algorithm: z.enum(PROOF_KEY_ALGORITHMS).default(DEFAULT_PROOF_KEY_ALGORITHM),
  })
  .strict();

export type DeviceEnrolmentRequest = z.infer<typeof deviceEnrolmentSchema>;

export interface DeviceEnrolmentInput {
  readonly request: unknown;
  readonly userAgent: string | null;
  readonly remoteIp: string | null;
}

/** The account enrolling the device. A key belongs to exactly one account, so this is the whole scope. */
export interface DeviceEnrolmentActor {
  readonly userId: string;
  readonly companyId: string | null;
  readonly sessionId: string | null;
}

export interface DeviceEnrolmentDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
  /** Ten by default; a deployment may lower it, and the gate uses a small number. */
  readonly maximumDevices?: number;
}

/** One enrolled device, as the route may report it. Never carries the private half, which is unknown here. */
export interface EnrolledDevice {
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly algorithm: ProofKeyAlgorithm;
  readonly label: string;
  /** False on every row this STEP writes; STEP 052 stamps the confirmation. */
  readonly trusted: boolean;
  readonly firstSeenAt: string;
}

export interface DeviceEnrolmentResult {
  /** `enrolled` wrote a row; `already_enrolled` found the same key already live. */
  readonly status: "enrolled" | "already_enrolled";
  readonly device: EnrolledDevice;
}

/** What a parsed public key turned out to be. */
export interface ProofKeyInspection {
  /** The canonical base64url the server will store, whatever encoding it received. */
  readonly canonicalBase64Url: string;
  readonly fingerprint: string;
  readonly algorithm: ProofKeyAlgorithm;
}

const deviceRowSchema = z.object({
  id: z.string().min(1).max(64),
  fingerprint: z.string().min(43).max(128),
  algorithm: z.enum(PROOF_KEY_ALGORITHMS),
  label: z.string().min(1).max(PROOF_KEY_LABEL_MAXIMUM_LENGTH).nullable(),
  first_seen_at: z.string().min(20).max(40),
  trusted_at: z.string().min(20).max(40).nullable(),
});

const insertedDeviceSchema = z.object({ id: z.string().min(1).max(64) });

type DeviceRow = z.infer<typeof deviceRowSchema>;

/**
 * The curve or key type each declared algorithm must actually be.
 *
 * `createPublicKey` reports P-256 as `prime256v1` because that is OpenSSL's name for it; the mapping
 * is written out rather than derived so a reader can see the three cases the column allows.
 */
const expectedKeyShape: Readonly<
  Record<ProofKeyAlgorithm, { readonly type: string; readonly curve: string | null }>
> = {
  ES256: { type: "ec", curve: "prime256v1" },
  ES384: { type: "ec", curve: "secp384r1" },
  EdDSA: { type: "ed25519", curve: null },
};

/**
 * Parse a public key and compute the values the platform will store, or answer null.
 *
 * Null is the only failure this function reports: the caller turns it into one `VALIDATION_FAILED`
 * with one detail, because a reason a client could read would be a description of the key handling
 * for anyone probing it.
 */
export async function inspectProofKey(
  publicKey: unknown,
  algorithm: unknown,
): Promise<ProofKeyInspection | null> {
  if (!isPublicKeyShape(publicKey) || typeof algorithm !== "string" || !(algorithm in expectedKeyShape)) {
    return null;
  }

  const declared = algorithm as ProofKeyAlgorithm;
  const decoded = Buffer.from(publicKey, "base64url");

  // The string must be its own canonical encoding: `Buffer` decodes `+`, `/` and padding happily, and
  // a browser that sent them was not sending what this module thinks it sent.
  if (decoded.length === 0 || decoded.toString("base64url") !== publicKey) {
    return null;
  }

  let key: KeyObject;

  try {
    key = createPublicKey({ key: decoded, format: "der", type: "spki" });
  } catch {
    return null;
  }

  const expected = expectedKeyShape[declared];
  const curve = key.asymmetricKeyDetails?.namedCurve ?? null;

  if (key.asymmetricKeyType !== expected.type || curve !== expected.curve) {
    return null;
  }

  // The parsed key is re-exported, so the bytes hashed below are the canonical encoding of the key
  // rather than the bytes the client happened to send.
  const canonical = key.export({ format: "der", type: "spki" });
  const canonicalBase64Url = Buffer.from(canonical).toString("base64url");

  return {
    canonicalBase64Url,
    fingerprint: await proofKeyFingerprint(new Uint8Array(canonical)),
    algorithm: declared,
  };
}

/** A validation failure that names the field and never the value. */
function keyRefused(): AppError {
  return new AppError("VALIDATION_FAILED", {
    details: [{ field: "publicKey", rule: "invalid_key" }],
  });
}

/** The live keys of one account, newest first, capped one past the limit so a caller can see it is over. */
async function readLiveDevices(
  rest: RestClient,
  userId: string,
  maximumDevices: number,
): Promise<readonly DeviceRow[]> {
  return rest.select(
    "device_proof_keys",
    `select=id,fingerprint,algorithm,label,first_seen_at,trusted_at&user_id=eq.${encodeURIComponent(userId)}` +
      `&revoked_at=is.null&deleted_at=is.null&limit=${String(maximumDevices + 1)}`,
    deviceRowSchema,
  );
}

function deviceOf(row: DeviceRow): EnrolledDevice {
  return {
    deviceId: row.id,
    fingerprint: row.fingerprint,
    algorithm: row.algorithm,
    label: row.label ?? "",
    trusted: row.trusted_at !== null,
    firstSeenAt: row.first_seen_at,
  };
}

/**
 * Enrol the device that generated a proof key.
 *
 * The order is the one that cannot leave a half state: validate the key, look at what the account
 * already has, decide idempotence and the cap, then write one row and audit it.
 *
 * `already_enrolled` is not a refusal. The same browser asking twice - two tabs, a retry after a
 * lost answer, a person who cleared site data on a device that is already known - is a normal
 * outcome, and the answer it gets is the row that already exists with `last_seen_at` moved forward.
 * Only a *newer* key for the same account counts as a new device.
 */
export async function enrolDeviceProofKey(
  input: DeviceEnrolmentInput,
  actor: DeviceEnrolmentActor,
  dependencies: DeviceEnrolmentDependencies,
): Promise<DeviceEnrolmentResult> {
  const parsed = deviceEnrolmentSchema.safeParse(input.request);

  if (!parsed.success) {
    throw keyRefused();
  }

  const inspection = await inspectProofKey(parsed.data.publicKey, parsed.data.algorithm);

  if (inspection === null) {
    throw keyRefused();
  }

  const now = dependencies.now ?? ((): number => Date.now());
  const instant = new Date(now()).toISOString();
  const maximumDevices = dependencies.maximumDevices ?? DEFAULT_MAXIMUM_DEVICES;
  const live = await readLiveDevices(dependencies.rest, actor.userId, maximumDevices);
  const existing = live.find((row) => row.fingerprint === inspection.fingerprint) ?? null;

  if (existing !== null) {
    await dependencies.rest.update(
      "device_proof_keys",
      `id=eq.${encodeURIComponent(existing.id)}&revoked_at=is.null&deleted_at=is.null`,
      { last_seen_at: instant },
    );

    await dependencies.audit.append({
      action: "user.device_proof_refreshed",
      actorUserId: actor.userId,
      entityType: "device_proof_key",
      entityId: existing.id,
      companyId: actor.companyId,
      ...(actor.sessionId === null ? {} : { sessionId: actor.sessionId }),
      payload: { algorithm: existing.algorithm, last_seen_at: instant },
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    return { status: "already_enrolled", device: deviceOf({ ...existing }) };
  }

  if (live.length >= maximumDevices) {
    // Section 22 has no notion of an unlimited device list, and a list without a ceiling is a table
    // a person with a script can fill. The refusal names a conflict, not a form problem: the form was
    // right and the account is full.
    throw new AppError("CONFLICT");
  }

  const label = proofKeyLabel(readDeviceContext(input.userAgent).label);

  try {
    const rows = await dependencies.rest.insertReturning(
      "device_proof_keys",
      [
        {
          user_id: actor.userId,
          company_id: actor.companyId,
          fingerprint: inspection.fingerprint,
          public_key: inspection.canonicalBase64Url,
          algorithm: inspection.algorithm,
          label,
          first_seen_at: instant,
          last_seen_at: instant,
          trusted_at: null,
        },
      ],
      insertedDeviceSchema,
    );
    const row = rows[0];

    if (row === undefined) {
      throw new AppError("DEPENDENCY_FAILED");
    }

    await dependencies.audit.append({
      action: "user.device_enrolled",
      actorUserId: actor.userId,
      entityType: "device_proof_key",
      entityId: row.id,
      companyId: actor.companyId,
      ...(actor.sessionId === null ? {} : { sessionId: actor.sessionId }),
      payload: {
        algorithm: inspection.algorithm,
        device: label,
        trusted: false,
        fingerprint_length: inspection.fingerprint.length,
      },
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });

    return {
      status: "enrolled",
      device: {
        deviceId: row.id,
        fingerprint: inspection.fingerprint,
        algorithm: inspection.algorithm,
        label,
        trusted: false,
        firstSeenAt: instant,
      },
    };
  } catch (error) {
    if (!isConflictError(error)) {
      throw error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
    }

    // `device_proof_keys_live_key` refused the row, so a key with this fingerprint became live
    // between the read above and this insert. The loser of that race answers like the winner's
    // second call rather than like a failure.
    const raced = await readLiveDevices(dependencies.rest, actor.userId, maximumDevices);
    const winner = raced.find((row) => row.fingerprint === inspection.fingerprint) ?? null;

    if (winner === null) {
      throw new AppError("CONFLICT");
    }

    return { status: "already_enrolled", device: deviceOf({ ...winner }) };
  }
}
