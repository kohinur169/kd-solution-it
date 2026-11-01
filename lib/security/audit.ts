// path: lib/security/audit.ts
import { AppError } from "../errors/app-error.ts";
import { canonicalRateLimitAddress } from "./rate-limit.ts";

/**
 * The audit log writer, and the proof that the log has not been edited.
 *
 * ## What exists, and what this file adds
 *
 * `lib/auth/audit.ts` (STEP 045) is the writer of the *authentication* flows, and `migrations/0013`
 * and `0075` are the storage: `audit_logs` is append-only and gapless, `public.audit_next_link`
 * returns the head a row must extend, `public.audit_hash_v1` computes the canonical hash of a row,
 * and `purge`-style updates are refused by a trigger. This file adds what those three do not have:
 *
 *   - a writer that belongs to no feature, so a service outside `lib/auth/` can write an entry
 *     without importing the auth configuration, the auth HTTP client or the auth types;
 *   - the **policy** an entry must satisfy before it is hashed: the action catalog rules, the
 *     entity pairing, the uuid columns, the payload ceiling, and a redaction pass so a secret never
 *     becomes immortal (`0013`: "never a secret");
 *   - the **integrity** half - `public.audit_verify_chain` and `public.audit_merkle_root` were
 *     written in `0075` and had no caller in the codebase; section 31 line 323 wants integrity roots
 *     exported on schedule so tampering can be detected, and this is the service that produces them.
 *
 * It is not a second writer of the same rows: the write path is the same three calls in the same
 * order with the same arguments, and the gate reads both modules and asserts that parity. When the
 * auth flows move onto this writer, `lib/auth/audit.ts` loses its orchestration and keeps only its
 * key handling - there will never be two ways to append to a chain.
 *
 * ## Why the hash is not computed here
 *
 * `0075` owns the canonical form: the v1 string, its field order, the microsecond timestamp and the
 * canonical JSON of the payload are one statement in SQL, and every row already in the table was
 * hashed by it. A TypeScript implementation of the same string would be a second answer that drifts
 * at the first timestamp format or key-order difference, and the drift would show up as a chain that
 * fails to verify months later. So this module *asks* the database for the hash, exactly as the auth
 * writer does, and the gate asserts the module contains no hash implementation at all.
 *
 * ## Why the signature comes in from outside
 *
 * The Ed25519 signature needs `AUDIT_SIGNING_KEY`, and a secret is read in one place - the auth
 * configuration - not in every module that needs it. The writer takes a `signHash` function instead,
 * so the key never enters `lib/security`, and `signAuditHash` from `lib/auth/audit.ts` satisfies the
 * parameter as it stands.
 *
 * ## What a failure means
 *
 * An entry that cannot exist is `INTERNAL_ERROR` with the reason in `cause`: it is a programming
 * mistake, the sentence a client would read is meaningless, and the reason must not be serialised.
 * A chain this service cannot read - a broken link table, an unparsable answer, a chain that fails
 * verification - is `DEPENDENCY_FAILED`: the entry was not written, and the caller must not treat
 * the mutation as recorded.
 */

/** The chain of the platform itself. A row with no company extends this one. */
export const AUDIT_PLATFORM_CHAIN_ID = "00000000-0000-0000-0000-000000000000";

/** The `prev_hash` of the first row of every chain: sixty-four zeros, as `audit_genesis_hash` says. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** The table, and the four functions of `0075` that this service calls. */
export const AUDIT_TABLE = "audit_logs";
export const AUDIT_NEXT_LINK_FUNCTION = "audit_next_link";
export const AUDIT_HASH_FUNCTION = "audit_hash_v1";
export const AUDIT_VERIFY_FUNCTION = "audit_verify_chain";
export const AUDIT_MERKLE_FUNCTION = "audit_merkle_root";

/** Dotted action name, as `audit_logs_action_check` states it. */
export const AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u;
export const AUDIT_MAXIMUM_ACTION_LENGTH = 64;

/** Lower snake entity type, as `audit_logs_entity_type_check` states it. */
export const AUDIT_ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/u;
export const AUDIT_MAXIMUM_ENTITY_TYPE_LENGTH = 48;

/** The three shapes `0013` checks with a regular expression. */
export const AUDIT_HASH_PATTERN = /^[0-9a-f]{64}$/u;
export const AUDIT_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
export const AUDIT_SIGNING_KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/u;

/** The payload ceiling of `audit_logs_payload_check`. */
export const AUDIT_MAXIMUM_PAYLOAD_BYTES = 8_192;

/** How deep a payload may nest before it is a mistake rather than a value. */
export const AUDIT_MAXIMUM_PAYLOAD_DEPTH = 6;

/** The `user_agent` ceiling of `audit_logs_user_agent_check`. */
export const AUDIT_MAXIMUM_USER_AGENT_LENGTH = 512;

/** The first position of every chain. */
export const AUDIT_SEQUENCE_START = 1;

/** What a redacted value becomes. A marker rather than a removal, so the shape of a payload survives. */
export const AUDIT_REDACTED = "[redacted]";

/** The arguments of `audit_hash_v1`, in the order the function declares them. */
export const AUDIT_HASH_ARGUMENTS = Object.freeze([
  "chain",
  "sequence",
  "created_at",
  "actor_user_id",
  "action",
  "entity_type",
  "entity_id",
  "payload",
  "prev_hash",
] as const);

/** The columns the insert writes, in the order `0013` lists them. */
export const AUDIT_ROW_FIELDS = Object.freeze([
  "company_id",
  "sequence",
  "actor_user_id",
  "action",
  "entity_type",
  "entity_id",
  "payload",
  "session_id",
  "ip_address",
  "user_agent",
  "prev_hash",
  "hash",
  "signature",
  "signing_key_id",
  "created_at",
  "updated_at",
] as const);

/**
 * The key fragments that make a payload value a secret.
 *
 * The comparison is on the key, not the value: a value cannot be recognised as a secret by looking
 * at it, and a key called `password`, `api_key` or `totp_seed` is stating it. Keys are normalised
 * before matching, so `apiKey`, `api-key` and `API_KEY` are one key, and the fragments are the
 * credential vocabulary of this platform - a token, a secret, an authorisation header, a cookie, a
 * CSRF token, a proof key, a one time code, a backup code, a card number, a seed.
 */
export const AUDIT_SECRET_KEY_FRAGMENTS = Object.freeze([
  "password",
  "passphrase",
  "secret",
  "token",
  "apikey",
  "privatekey",
  "authorization",
  "cookie",
  "csrf",
  "proofkey",
  "otp",
  "backupcode",
  "cardnumber",
  "cvv",
  "seed",
] as const);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** One entry, in the shape `lib/auth/audit.ts` already accepts and `audit_logs` already stores. */
export interface AuditEntry {
  readonly action: string;
  readonly actorUserId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly companyId: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

/** Why an entry cannot be written. Machine reasons, never a sentence a client sees. */
export const AUDIT_ENTRY_PROBLEMS = Object.freeze([
  "action_invalid",
  "action_too_long",
  "entity_type_invalid",
  "entity_type_too_long",
  "entity_pair_invalid",
  "entity_id_invalid",
  "actor_invalid",
  "company_invalid",
  "session_invalid",
  "payload_not_object",
  "payload_too_large",
  "payload_too_deep",
  "address_invalid",
  "user_agent_invalid",
] as const);

export type AuditEntryProblem = (typeof AUDIT_ENTRY_PROBLEMS)[number];

/** The row the writer appends, and the link it extended. */
export interface AuditRecord {
  readonly chainId: string;
  readonly sequence: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly signature: string;
  readonly signingKeyId: string;
  readonly createdAt: string;
}

/** The part of the REST client the writer needs, so this module depends on no auth type. */
export interface AuditRpcClient {
  rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/** The client with an insert, which is what writing a row needs. */
export interface AuditStoreClient extends AuditRpcClient {
  insert(table: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<void>;
}

/** The writer a service uses: one call, one link in one chain. */
export interface AuditWriter {
  append(entry: AuditEntry): Promise<AuditRecord>;
}

export interface AuditWriterOptions {
  readonly store: AuditStoreClient;
  /** Signs the 32 bytes of a hash, and answers base64url. The key stays outside this module. */
  readonly signHash: (hashHex: string) => string;
  /** Which key signed, so a rotation does not invalidate older rows. */
  readonly signingKeyId: string;
  readonly now?: () => number;
}

/** A range of one chain. `toSequence` of null means "to the head". */
export interface AuditChainRange {
  readonly chainId: string;
  readonly fromSequence?: number;
  readonly toSequence?: number | null;
}

export interface AuditChainVerification {
  readonly chainId: string;
  readonly checkedRows: number;
  readonly valid: boolean;
  readonly firstBrokenSequence: number | null;
  readonly brokenReason: string | null;
  readonly headSequence: number | null;
  readonly headHash: string | null;
}

/** What an export records: the range, the verdict and the root of the range. */
export interface AuditIntegrityReport extends AuditChainVerification {
  readonly fromSequence: number;
  readonly toSequence: number | null;
  readonly root: string;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= AUDIT_SEQUENCE_START;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function auditFailure(reason: AuditEntryProblem): AppError {
  return new AppError("INTERNAL_ERROR", { cause: { rule: "audit_entry", reason } });
}

/** A writer that was configured with something it cannot use. Never a caller's fault. */
function writerFailure(reason: string): AppError {
  return new AppError("INTERNAL_ERROR", { cause: { rule: "audit_writer", reason } });
}

/** A range that cannot exist: a chain that is not an id, a position that is not a position. */
function rangeFailure(reason: string): AppError {
  return new AppError("INTERNAL_ERROR", { cause: { rule: "audit_range", reason } });
}

/** True when a key states that its value is a credential. */
export function isAuditSecretKey(key: string): boolean {
  const normalised = key.toLowerCase().replaceAll(/[_\-. ]/gu, "");

  return AUDIT_SECRET_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > AUDIT_MAXIMUM_PAYLOAD_DEPTH) {
    throw auditFailure("payload_too_deep");
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => redactValue(item, depth + 1)));
  }

  if (isPlainObject(value)) {
    return redactRecord(value, depth + 1);
  }

  return value;
}

function redactRecord(
  record: Readonly<Record<string, unknown>>,
  depth: number,
): Readonly<Record<string, unknown>> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    redacted[key] = isAuditSecretKey(key) ? AUDIT_REDACTED : redactValue(value, depth);
  }

  return Object.freeze(redacted);
}

/**
 * The payload as it may enter the chain: same keys, same shape, every credential replaced.
 *
 * A chain is append-only and permanent, so a token that reaches it can never be removed - not by a
 * job, not by a database owner, not by a rollback. Redaction at the door is the only moment the
 * mistake is still cheap, and it happens before the size is measured and before the hash is asked
 * for, so the hash covers what was stored rather than what was offered.
 */
export function redactAuditPayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return redactRecord(payload, 0);
}

/** The size `audit_logs_payload_check` measures: the octet length of the JSON text. */
export function auditPayloadBytes(payload: Readonly<Record<string, unknown>>): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/**
 * Why an entry cannot be written, or null.
 *
 * The checks are the constraints of `0013`, in the order a caller is likely to trip them, plus the
 * two the column types enforce and a regular expression cannot state: the uuid columns and the
 * address family. An entity type without an entity id (or the other way round) is the mistake the
 * database would report as a failed insert with no useful message, so it is named here instead.
 */
export function auditEntryProblem(entry: AuditEntry): AuditEntryProblem | null {
  if (!AUDIT_ACTION_PATTERN.test(entry.action)) {
    return "action_invalid";
  }

  if (entry.action.length > AUDIT_MAXIMUM_ACTION_LENGTH) {
    return "action_too_long";
  }

  if (entry.entityType !== null && !AUDIT_ENTITY_TYPE_PATTERN.test(entry.entityType)) {
    return "entity_type_invalid";
  }

  if (entry.entityType !== null && entry.entityType.length > AUDIT_MAXIMUM_ENTITY_TYPE_LENGTH) {
    return "entity_type_too_long";
  }

  if ((entry.entityType === null) !== (entry.entityId === null)) {
    return "entity_pair_invalid";
  }

  if (entry.entityId !== null && !isUuid(entry.entityId)) {
    return "entity_id_invalid";
  }

  if (entry.actorUserId !== null && !isUuid(entry.actorUserId)) {
    return "actor_invalid";
  }

  if (entry.companyId !== null && !isUuid(entry.companyId)) {
    return "company_invalid";
  }

  if (entry.sessionId !== undefined && entry.sessionId !== null && !isUuid(entry.sessionId)) {
    return "session_invalid";
  }

  if (entry.ipAddress !== undefined && entry.ipAddress !== null) {
    if (canonicalRateLimitAddress(entry.ipAddress) === null) {
      return "address_invalid";
    }
  }

  if (entry.userAgent !== undefined && entry.userAgent !== null) {
    if (entry.userAgent.length < 1 || entry.userAgent.length > AUDIT_MAXIMUM_USER_AGENT_LENGTH) {
      return "user_agent_invalid";
    }
  }

  if (!isPlainObject(entry.payload)) {
    return "payload_not_object";
  }

  if (auditPayloadBytes(entry.payload) > AUDIT_MAXIMUM_PAYLOAD_BYTES) {
    return "payload_too_large";
  }

  return null;
}

/** The entry, or the refusal. A caller that has built its own entry validates with this. */
export function requireAuditEntry(entry: AuditEntry): AuditEntry {
  const problem = auditEntryProblem(entry);

  if (problem !== null) {
    throw auditFailure(problem);
  }

  return entry;
}

/**
 * The entry a writer may store: trimmed, redacted, normalised and frozen.
 *
 * Every path into the chain goes through this, including the one that already built an entry, so a
 * payload that reached a module unredacted is still redacted here. The address is the canonical
 * spelling of STEP 062's rule rather than a second parser, and an address that is not one is a
 * refusal rather than a row the `inet` column would reject.
 */
export function buildAuditEntry(entry: AuditEntry): AuditEntry {
  // An address that canonicalises to nothing keeps its original value, so the validation below
  // reports `address_invalid` rather than quietly storing a missing address.
  const ipAddress =
    entry.ipAddress === undefined || entry.ipAddress === null
      ? null
      : (canonicalRateLimitAddress(entry.ipAddress) ?? entry.ipAddress);
  const built: AuditEntry = Object.freeze({
    action: entry.action.trim(),
    actorUserId: entry.actorUserId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    payload: redactAuditPayload(entry.payload),
    companyId: entry.companyId,
    sessionId: entry.sessionId ?? null,
    ipAddress,
    userAgent: entry.userAgent === undefined || entry.userAgent === null ? null : entry.userAgent.trim(),
  });

  return requireAuditEntry(built);
}

/** The next link of a chain, as `public.audit_next_link` answers it. */
interface AuditNextLink {
  readonly sequence: number;
  readonly prevHash: string;
}

function readNextLink(body: unknown): AuditNextLink {
  const row = Array.isArray(body) && body.length === 1 ? body[0] : undefined;

  if (!isPlainObject(row)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  const sequence = row["next_sequence"];
  const prevHash = row["prev_hash"];

  if (!isPositiveInteger(sequence) || typeof prevHash !== "string" || !AUDIT_HASH_PATTERN.test(prevHash)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  // The genesis link belongs to the first row and to no other: a chain that starts at 1 with a real
  // hash, or continues past 1 from zeros, is a chain this service will not write into.
  if (sequence === AUDIT_SEQUENCE_START && prevHash !== AUDIT_GENESIS_HASH) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (sequence > AUDIT_SEQUENCE_START && prevHash === AUDIT_GENESIS_HASH) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return { sequence, prevHash };
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

/**
 * The writer of the platform's audit chain.
 *
 * `append` is the only way to the table: it prepares the entry, asks the chain for its head, asks
 * the database for the hash of the row it is about to insert, signs those 32 bytes and inserts. Any
 * answer that does not have the shape `0075` documents stops the write - an entry that was not
 * recorded is a mutation that must not be reported as done, and a silent retry would fork the chain.
 */
export function createAuditWriter(options: AuditWriterOptions): AuditWriter {
  if (!AUDIT_SIGNING_KEY_ID_PATTERN.test(options.signingKeyId)) {
    throw writerFailure("signing_key_id_invalid");
  }

  const now = options.now ?? ((): number => Date.now());

  return {
    async append(entry: AuditEntry): Promise<AuditRecord> {
      const prepared = buildAuditEntry(entry);
      const chainId = prepared.companyId ?? AUDIT_PLATFORM_CHAIN_ID;
      const createdAt = new Date(now()).toISOString();
      const link = readNextLink(
        await options.store.rpc(AUDIT_NEXT_LINK_FUNCTION, { p_chain: chainId }),
      );
      const hashBody = await options.store.rpc(AUDIT_HASH_FUNCTION, {
        chain: chainId,
        sequence: link.sequence,
        created_at: createdAt,
        actor_user_id: prepared.actorUserId,
        action: prepared.action,
        entity_type: prepared.entityType,
        entity_id: prepared.entityId,
        payload: prepared.payload,
        prev_hash: link.prevHash,
      });
      const hash = readTextResult(hashBody);

      if (hash === null || !AUDIT_HASH_PATTERN.test(hash) || hash === link.prevHash) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      const signature = options.signHash(hash);

      if (!AUDIT_SIGNATURE_PATTERN.test(signature)) {
        throw writerFailure("signature_invalid");
      }

      await options.store.insert(AUDIT_TABLE, [
        {
          company_id: prepared.companyId,
          sequence: link.sequence,
          actor_user_id: prepared.actorUserId,
          action: prepared.action,
          entity_type: prepared.entityType,
          entity_id: prepared.entityId,
          payload: prepared.payload,
          session_id: prepared.sessionId ?? null,
          ip_address: prepared.ipAddress ?? null,
          user_agent: prepared.userAgent ?? null,
          prev_hash: link.prevHash,
          hash,
          signature,
          signing_key_id: options.signingKeyId,
          created_at: createdAt,
          updated_at: createdAt,
        },
      ]);

      return {
        chainId,
        sequence: link.sequence,
        prevHash: link.prevHash,
        hash,
        signature,
        signingKeyId: options.signingKeyId,
        createdAt,
      };
    },
  };
}

/** The chain, the range and the head, as `public.audit_verify_chain` reports them. */
function readRange(range: AuditChainRange): {
  readonly chainId: string;
  readonly fromSequence: number;
  readonly toSequence: number | null;
} {
  const fromSequence = range.fromSequence ?? AUDIT_SEQUENCE_START;
  const toSequence = range.toSequence ?? null;

  if (!isUuid(range.chainId)) {
    throw rangeFailure("chain_invalid");
  }

  if (!isPositiveInteger(fromSequence)) {
    throw rangeFailure("from_sequence_invalid");
  }

  if (toSequence !== null && (!isPositiveInteger(toSequence) || toSequence < fromSequence)) {
    throw rangeFailure("to_sequence_invalid");
  }

  return { chainId: range.chainId, fromSequence, toSequence };
}

function isIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

/**
 * Walk one range of one chain and report the first break, or that there was none.
 *
 * The walk happens in the database because that is where the rows are: `audit_verify_chain`
 * recomputes every row hash from the stored columns and compares the links, so a row edited by
 * somebody with the database owner's rights is found even if every signature still verifies - the
 * signature covers the hash, and the hash covers the columns.
 */
export async function verifyAuditChain(
  range: AuditChainRange,
  dependencies: { readonly rest: AuditRpcClient },
): Promise<AuditChainVerification> {
  const checked = readRange(range);
  const body = await dependencies.rest.rpc(AUDIT_VERIFY_FUNCTION, {
    p_chain: checked.chainId,
    p_from_sequence: checked.fromSequence,
    p_to_sequence: checked.toSequence,
  });
  const row = Array.isArray(body) && body.length === 1 ? body[0] : undefined;

  if (!isPlainObject(row)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  const checkedRows = row["checked_rows"];
  const valid = row["is_valid"];
  const firstBroken = row["first_broken_sequence"] ?? null;
  const brokenReason = row["broken_reason"] ?? null;
  const headSequence = row["head_sequence"] ?? null;
  const headHash = row["head_hash"] ?? null;

  if (typeof checkedRows !== "number" || !Number.isInteger(checkedRows) || checkedRows < 0) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (typeof valid !== "boolean") {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (!isIntegerOrNull(firstBroken) || !isIntegerOrNull(headSequence)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (headHash !== null && (typeof headHash !== "string" || !AUDIT_HASH_PATTERN.test(headHash))) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (brokenReason !== null && (typeof brokenReason !== "string" || brokenReason.length === 0)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  // A verdict has to agree with its own evidence: a break has a position and a reason, and a valid
  // range has neither. A service that answered "invalid" with no position would be a bug here and a
  // tamper alert with no leads in production.
  if (valid && (firstBroken !== null || brokenReason !== null)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  if (!valid && (firstBroken === null || brokenReason === null)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return {
    chainId: checked.chainId,
    checkedRows,
    valid,
    firstBrokenSequence: firstBroken,
    brokenReason,
    headSequence,
    headHash,
  };
}

/**
 * The RFC 6962 root over a range of one chain, or null when the range is empty.
 *
 * The root is computed over the stored row hashes, so it is a commitment to the *content* of the
 * range: publishing it on a schedule (section 31) means a rewrite of any row in that range changes
 * the root of every range that contains it, and an operator comparing today's root with the one
 * exported last month sees the edit without reading a single row.
 */
export async function readAuditMerkleRoot(
  range: AuditChainRange,
  dependencies: { readonly rest: AuditRpcClient },
): Promise<string | null> {
  const checked = readRange(range);
  const body = await dependencies.rest.rpc(AUDIT_MERKLE_FUNCTION, {
    p_chain: checked.chainId,
    p_from_sequence: checked.fromSequence,
    p_to_sequence: checked.toSequence,
  });
  const root = readTextResult(body);

  if (root === null || root === "") {
    return null;
  }

  if (!AUDIT_HASH_PATTERN.test(root)) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return root;
}

/**
 * The report an integrity export records: the range, the verdict and its root.
 *
 * It refuses a chain that does not verify, and refuses an empty range. A root published over a
 * broken chain would certify the tampering instead of exposing it, and a root over nothing certifies
 * nothing - both are worse than a failed job, so both are `DEPENDENCY_FAILED` with the reason in
 * `cause` where an operator's log will find it.
 */
export async function readAuditIntegrityReport(
  range: AuditChainRange,
  dependencies: { readonly rest: AuditRpcClient },
): Promise<AuditIntegrityReport> {
  const checked = readRange(range);
  const verification = await verifyAuditChain(range, dependencies);

  if (!verification.valid) {
    throw new AppError("DEPENDENCY_FAILED", {
      cause: {
        rule: "audit_chain",
        chain: checked.chainId,
        broken_sequence: verification.firstBrokenSequence,
        reason: verification.brokenReason,
      },
    });
  }

  const root = await readAuditMerkleRoot(range, dependencies);

  if (root === null) {
    throw new AppError("DEPENDENCY_FAILED", {
      cause: { rule: "audit_root", chain: checked.chainId, reason: "empty_range" },
    });
  }

  return { ...verification, fromSequence: checked.fromSequence, toSequence: checked.toSequence, root };
}
