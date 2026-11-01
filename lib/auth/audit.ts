// path: lib/auth/audit.ts
import { Buffer } from "node:buffer";
import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuthConfig } from "./config.ts";
import type { AuthHttp } from "./http.ts";
import { createRestClient, type RestClient } from "./rest.ts";

/**
 * The writer of the append-only audit chain.
 *
 * Golden rule 9 of the master prompt says every mutation writes an audit entry, and `0013` makes
 * that entry a link in a hash chain: a gapless `sequence`, the `prev_hash` of the row before it, the
 * canonical `hash` of its own fields, and an Ed25519 `signature` over that hash. The database cannot
 * sign - a migration may not create an extension - so `0075` computes and verifies the hash while
 * the service that holds `AUDIT_SIGNING_KEY` signs. This file is that service side, and the three
 * steps are exactly the order rule 54 prescribes:
 *
 *   1. ask `public.audit_next_link(chain)` for the sequence and the head hash to extend;
 *   2. ask `public.audit_hash_v1(...)` for the canonical hash of the row about to be written;
 *   3. sign those 32 bytes, and insert the row with both values.
 *
 * The insert guard of `0013` refuses a sequence that is not the next one and a `prev_hash` that is
 * not the current head, so a concurrent writer loses cleanly instead of forking the chain. The
 * caller of this module retries nothing: a signup that could not be recorded is a signup that did
 * not happen, and the compensation in `registration.ts` undoes the account.
 *
 * The signature is base64url of the 64 byte Ed25519 signature (86 characters, which the column
 * check enforces) over the raw 32 bytes of the hash. `signing_key_id` names the key without
 * storing it, so a rotation leaves the history verifiable: `audit-v1` is the first identifier.
 */

/** The identifier written to `audit_logs.signing_key_id` for the first signing key. */
export const AUDIT_SIGNING_KEY_ID = "audit-v1";

/** The chain of the platform itself. A row with no company extends this one. */
export const PLATFORM_CHAIN_ID = "00000000-0000-0000-0000-000000000000";

/** The pkcs8 DER prefix of an Ed25519 private key, before the 32 byte seed. */
const ed25519Pkcs8Prefix = "302e020100300506032b657004220420";

const hashPattern = /^[0-9a-f]{64}$/u;
const actionPattern = /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u;
const entityTypePattern = /^[a-z][a-z0-9_]*$/u;

/** The payload ceiling of `audit_logs_payload_check`. */
const maximumPayloadBytes = 8_192;

const nextLinkSchema = z.array(
  z.object({
    next_sequence: z.number().int().positive(),
    prev_hash: z.string().regex(hashPattern),
  }),
);

/** One entry a caller asks to record. */
export interface AuditEntry {
  /** Dotted action name, such as `merchant.signed_up`. Lower case, no spaces. */
  readonly action: string;
  readonly actorUserId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The tenant chain. Null means the platform chain. */
  readonly companyId: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface AuditTrail {
  append(entry: AuditEntry): Promise<void>;
}

/** A trail that keeps its entries in memory, for the gate and for a deployment without a database. */
export interface InMemoryAuditTrail extends AuditTrail {
  readonly entries: readonly AuditEntry[];
}

export function createInMemoryAuditTrail(): InMemoryAuditTrail {
  const entries: AuditEntry[] = [];

  return {
    entries,
    append(entry: AuditEntry): Promise<void> {
      entries.push(entry);

      return Promise.resolve();
    },
  };
}

/**
 * The Ed25519 signature over the raw bytes of a canonical hash.
 *
 * The key is the 32 byte seed of `AUDIT_SIGNING_KEY`; Node wants a pkcs8 document, so the fixed
 * DER prefix that wraps an Ed25519 seed is prepended here rather than stored anywhere.
 */
export function signAuditHash(signingKeyBase64: string, hashHex: string): string {
  if (!hashPattern.test(hashHex)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const seed = Buffer.from(signingKeyBase64, "base64");

  if (seed.byteLength !== 32) {
    throw new AppError("INTERNAL_ERROR");
  }

  try {
    const key = createPrivateKey({
      key: Buffer.concat([Buffer.from(ed25519Pkcs8Prefix, "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });

    return sign(null, Buffer.from(hashHex, "hex"), key).toString("base64url");
  } catch {
    throw new AppError("INTERNAL_ERROR");
  }
}

/** A function returning one text result: PostgREST answers a scalar with a scalar. */
function readTextResult(body: unknown): string | null {
  if (typeof body === "string") {
    return body;
  }

  if (Array.isArray(body) && body.length === 1 && typeof body[0] === "string") {
    return body[0];
  }

  return null;
}

function assertEntryShaped(entry: AuditEntry): void {
  if (!actionPattern.test(entry.action)) {
    throw new AppError("INTERNAL_ERROR");
  }

  if (
    (entry.entityType === null) !== (entry.entityId === null) ||
    (entry.entityType !== null && !entityTypePattern.test(entry.entityType))
  ) {
    throw new AppError("INTERNAL_ERROR");
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify(entry.payload), "utf8");

  if (payloadBytes > maximumPayloadBytes) {
    throw new AppError("INTERNAL_ERROR");
  }
}

export interface RestAuditTrailOptions {
  readonly config: AuthConfig;
  readonly http: AuthHttp;
  /** Read lazily, so the module never touches the environment at import time. */
  readonly signingKey: () => string;
  readonly now?: () => number;
}

export function createRestAuditTrail(options: RestAuditTrailOptions): AuditTrail {
  const rest: RestClient = createRestClient(options.config, options.http);
  const now = options.now ?? ((): number => Date.now());

  return {
    async append(entry: AuditEntry): Promise<void> {
      assertEntryShaped(entry);

      const chainId = entry.companyId ?? PLATFORM_CHAIN_ID;
      const createdAtIso = new Date(now()).toISOString();

      const linkBody = await rest.rpc("audit_next_link", { p_chain: chainId });
      const link = nextLinkSchema.safeParse(linkBody);

      if (!link.success || link.data[0] === undefined) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      const sequence = link.data[0].next_sequence;
      const prevHash = link.data[0].prev_hash;

      const hashBody = await rest.rpc("audit_hash_v1", {
        chain: chainId,
        sequence,
        created_at: createdAtIso,
        actor_user_id: entry.actorUserId,
        action: entry.action,
        entity_type: entry.entityType,
        entity_id: entry.entityId,
        payload: entry.payload,
        prev_hash: prevHash,
      });
      const hash = readTextResult(hashBody);

      if (hash === null || !hashPattern.test(hash)) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      await rest.insert("audit_logs", [
        {
          company_id: entry.companyId,
          sequence,
          actor_user_id: entry.actorUserId,
          action: entry.action,
          entity_type: entry.entityType,
          entity_id: entry.entityId,
          payload: entry.payload,
          session_id: entry.sessionId ?? null,
          ip_address: entry.ipAddress ?? null,
          user_agent: entry.userAgent ?? null,
          prev_hash: prevHash,
          hash,
          signature: signAuditHash(options.signingKey(), hash),
          signing_key_id: AUDIT_SIGNING_KEY_ID,
          created_at: createdAtIso,
          updated_at: createdAtIso,
        },
      ]);
    },
  };
}
