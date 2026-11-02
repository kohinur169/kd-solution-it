// path: lib/audit-log/service.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import { PLATFORM_CHAIN_ID } from "../auth/audit.ts";
import type { RestClient } from "../auth/rest.ts";
import { requireAnyRole } from "../auth/session.ts";
import type { RequestActor } from "../auth/types.ts";
import {
  AUDIT_LOG_HASH_PREVIEW_LENGTH,
  AUDIT_LOG_MAXIMUM_OFFSET,
  AUDIT_LOG_PAGE_SIZE,
  AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM,
  AUDIT_LOG_READ_ROLES,
  AUDIT_LOG_USER_AGENT_PREVIEW_MAXIMUM,
  auditDayOf,
  endOfDayExclusiveEpochMs,
  isUuid,
  startOfDayEpochMs,
  type AuditFilterProblem,
  type AuditFilters,
  type ParsedAuditQuery,
} from "./registry.ts";

/**
 * The audit log viewer: one page of the platform's history, and the check that the chain behind it
 * still holds.
 *
 * ## Two reads, one guard
 *
 * `listAuditEntries` asks PostgREST for one page of `audit_logs` under the filters the person typed,
 * ordered newest first. `verifyAuditChain` calls `public.audit_verify_chain` - the function
 * `0075_audit_chain_functions.sql` wrote - for one chain and returns what it found. Both refuse every
 * role outside `AUDIT_LOG_READ_ROLES` before their first request, so the screen and `0074`'s
 * `audit_logs_office_select` agree about who may look.
 *
 * ## Why the log is read and never written here
 *
 * `0013`'s `audit_logs_append_only` trigger refuses every update and every removal whatever role
 * asks, and no policy grants an insert. A viewer that could write would be a second author of the
 * evidence it shows, so this module has no writer at all - not even a convenient one.
 *
 * ## Why the page is a window and not a snapshot
 *
 * The log only grows at its head, so an offset shifts under a reader as new events arrive between two
 * requests. That is the honest behaviour for an append-only log: a viewer that pretended otherwise
 * would need a read transaction per page. The cap on the offset keeps one page from turning into a
 * scan of a year of history.
 *
 * ## Why a payload is printed as text and cut
 *
 * `payload` is a jsonb object of at most 8 KiB, written by the service that recorded the event and
 * never holding a secret. The viewer prints it as text - never as markup - and stops after two
 * thousand characters with the fact of the cut printed in words, because a page of eighty rows each
 * carrying eight kilobytes is not a page anybody reads.
 */

export interface AuditLogDependencies {
  /** The full client: the viewer reads rows and calls the verification function. */
  readonly store: RestClient;
  readonly now?: () => number;
}

/** One row of the log, as the screen renders it. */
export interface AuditEntryView {
  readonly id: string;
  readonly sequence: number;
  readonly chainId: string;
  readonly companyId: string | null;
  readonly action: string;
  /** The first dotted segment of the action, such as `session`. What the family filter types. */
  readonly actionFamily: string;
  readonly actorUserId: string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly sessionId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly createdAtEpochMs: number;
  readonly createdAtIso: string;
  /** The payload as text, cut at the module's ceiling. Never markup. */
  readonly payloadPreview: string;
  /** True when the payload was longer than the ceiling, so the screen can say so. */
  readonly payloadTruncated: boolean;
  readonly hashPreview: string;
  readonly prevHashPreview: string;
  readonly signingKeyId: string;
}

/** One chain the page's rows belong to, so the verifier can offer it. */
export interface AuditChainOption {
  readonly chainId: string;
  /** Null for the platform's own chain, which is the zero uuid. */
  readonly companyId: string | null;
}

/** Everything one page of the viewer renders. */
export interface AuditLogPage {
  readonly entries: readonly AuditEntryView[];
  readonly offset: number;
  readonly pageSize: number;
  readonly nextOffset: number | null;
  readonly previousOffset: number | null;
  readonly chains: readonly AuditChainOption[];
  readonly filters: AuditFilters;
  readonly problems: readonly AuditFilterProblem[];
  readonly readAtEpochMs: number;
  readonly platformChainId: string;
}

/** What one verification of one chain answered. */
export interface AuditChainVerification {
  readonly chainId: string;
  readonly checkedRows: number;
  readonly isValid: boolean;
  readonly firstBrokenSequence: number | null;
  readonly brokenReason: string | null;
  readonly headSequence: number | null;
  readonly headHash: string | null;
  readonly checkedAtEpochMs: number;
}

const rowSchema = z.object({
  id: z.string().min(1).max(64),
  company_id: z.string().min(1).max(64).nullable(),
  chain_id: z.string().min(1).max(64),
  sequence: z.number().int().positive(),
  actor_user_id: z.string().min(1).max(64).nullable(),
  action: z.string().min(1).max(64),
  entity_type: z.string().min(1).max(48).nullable(),
  entity_id: z.string().min(1).max(64).nullable(),
  payload: z.record(z.string(), z.unknown()),
  session_id: z.string().min(1).max(64).nullable(),
  ip_address: z.string().min(1).max(64).nullable(),
  user_agent: z.string().min(1).max(512).nullable(),
  prev_hash: z.string().length(64),
  hash: z.string().length(64),
  signature: z.string().min(1).max(128),
  signing_key_id: z.string().min(1).max(48),
  created_at: z.string().min(1).max(40),
});

/** The columns the viewer prints, and nothing else: `signature` is checked, not shown. */
const columns =
  "select=id,company_id,chain_id,sequence,actor_user_id,action,entity_type,entity_id,payload," +
  "session_id,ip_address,user_agent,prev_hash,hash,signature,signing_key_id,created_at";

/** A count that PostgREST may answer as a number or as a string, because it is a bigint. */
const countSchema = z.union([z.number(), z.string()]);

const verificationSchema = z.array(
  z.object({
    chain_id: z.string().min(1).max(64),
    checked_rows: countSchema,
    is_valid: z.boolean(),
    first_broken_sequence: countSchema.nullable(),
    broken_reason: z.string().max(512).nullable(),
    head_sequence: countSchema.nullable(),
    head_hash: z.string().max(64).nullable(),
  }),
);

function nowOf(dependencies: AuditLogDependencies): number {
  return dependencies.now?.() ?? Date.now();
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) ? parsed : null;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The PostgREST query one page makes.
 *
 * Every filter is a column `0013` indexes, or a `created_at` range `0100` indexes, and the ordering is
 * the same in every case: newest first, and by sequence within one created_at, so two rows written in
 * the same microsecond still come back in one stable order.
 */
export function auditQueryOf(query: ParsedAuditQuery, limit: number): string {
  const { filters } = query;
  const parts: string[] = [
    columns,
    "deleted_at=is.null",
    "order=created_at.desc,sequence.desc",
    `limit=${String(limit)}`,
    `offset=${String(query.offset)}`,
  ];

  if (filters.action !== null) {
    // A prefix under `text_pattern_ops`, which is why `0100` added that index: `*` is PostgREST's
    // spelling of a SQL `%` wildcard.
    parts.push(`action=like.${encoded(filters.action)}*`);
  }

  if (filters.actorUserId !== null) {
    parts.push(`actor_user_id=eq.${encoded(filters.actorUserId)}`);
  }

  if (filters.entityType !== null) {
    parts.push(`entity_type=eq.${encoded(filters.entityType)}`);
  }

  if (filters.entityId !== null) {
    parts.push(`entity_id=eq.${encoded(filters.entityId)}`);
  }

  if (filters.companyId !== null) {
    parts.push(`company_id=eq.${encoded(filters.companyId)}`);
  } else if (filters.platformOnly) {
    parts.push("company_id=is.null");
  }

  if (filters.fromDay !== null) {
    const from = startOfDayEpochMs(filters.fromDay);

    if (from !== null) {
      // A day becomes an instant here, so the value is this module's own and needs no escaping:
      // PostgREST reads a plain ISO stamp, and an encoded one would be a second spelling of it.
      parts.push(`created_at=gte.${new Date(from).toISOString()}`);
    }
  }

  if (filters.toDay !== null) {
    const to = endOfDayExclusiveEpochMs(filters.toDay);

    if (to !== null) {
      parts.push(`created_at=lt.${new Date(to).toISOString()}`);
    }
  }

  return parts.join("&");
}

function payloadPreviewOf(payload: Readonly<Record<string, unknown>>): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const json = JSON.stringify(payload, null, 2) ?? "{}";

  return json.length <= AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM
    ? { text: json, truncated: false }
    : { text: json.slice(0, AUDIT_LOG_PAYLOAD_PREVIEW_MAXIMUM), truncated: true };
}

function viewOf(row: z.infer<typeof rowSchema>): AuditEntryView {
  const createdAtEpochMs = Date.parse(row.created_at);

  if (!Number.isFinite(createdAtEpochMs)) {
    throw new AppError("INTERNAL_ERROR");
  }

  const payload = payloadPreviewOf(row.payload);
  const dot = row.action.indexOf(".");

  return {
    id: row.id,
    sequence: row.sequence,
    chainId: row.chain_id,
    companyId: row.company_id,
    action: row.action,
    actionFamily: dot === -1 ? row.action : row.action.slice(0, dot),
    actorUserId: row.actor_user_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sessionId: row.session_id,
    ipAddress: row.ip_address,
    userAgent:
      row.user_agent === null
        ? null
        : row.user_agent.slice(0, AUDIT_LOG_USER_AGENT_PREVIEW_MAXIMUM),
    createdAtEpochMs,
    createdAtIso: row.created_at,
    payloadPreview: payload.text,
    payloadTruncated: payload.truncated,
    hashPreview: row.hash.slice(0, AUDIT_LOG_HASH_PREVIEW_LENGTH),
    prevHashPreview: row.prev_hash.slice(0, AUDIT_LOG_HASH_PREVIEW_LENGTH),
    signingKeyId: row.signing_key_id,
  };
}

/** The chains a page of rows belongs to, in the order they first appear. */
function chainsOf(entries: readonly AuditEntryView[]): readonly AuditChainOption[] {
  const seen = new Set<string>();
  const chains: AuditChainOption[] = [];

  for (const entry of entries) {
    if (seen.has(entry.chainId)) {
      continue;
    }

    seen.add(entry.chainId);
    chains.push({ chainId: entry.chainId, companyId: entry.companyId });
  }

  return chains;
}

/**
 * One page of the log, under the filters a person asked for.
 *
 * A page asks for one row more than it shows: that extra row is the only way to know whether there is
 * a next page without a second count query over the same filters. Every entry point refuses a role
 * outside the three that answer for the log.
 */
export async function listAuditEntries(
  input: { readonly actor: RequestActor; readonly query: ParsedAuditQuery },
  dependencies: AuditLogDependencies,
): Promise<AuditLogPage> {
  requireAnyRole(input.actor, AUDIT_LOG_READ_ROLES);

  const instant = nowOf(dependencies);
  const rows = await dependencies.store.select(
    "audit_logs",
    auditQueryOf(input.query, AUDIT_LOG_PAGE_SIZE + 1),
    rowSchema,
  );
  const pageRows = rows.slice(0, AUDIT_LOG_PAGE_SIZE);
  const entries = pageRows.map((row) => viewOf(row));
  const hasMore = rows.length > AUDIT_LOG_PAGE_SIZE;
  const nextOffset = hasMore
    ? Math.min(input.query.offset + AUDIT_LOG_PAGE_SIZE, AUDIT_LOG_MAXIMUM_OFFSET)
    : null;

  return {
    entries,
    offset: input.query.offset,
    pageSize: AUDIT_LOG_PAGE_SIZE,
    nextOffset: nextOffset !== null && nextOffset > input.query.offset ? nextOffset : null,
    previousOffset:
      input.query.offset === 0 ? null : Math.max(0, input.query.offset - AUDIT_LOG_PAGE_SIZE),
    chains: chainsOf(entries),
    filters: input.query.filters,
    problems: input.query.problems,
    readAtEpochMs: instant,
    platformChainId: PLATFORM_CHAIN_ID,
  };
}

/**
 * Walk one chain and report the first break, if there is one.
 *
 * The arithmetic is `0075`'s, not this module's: `audit_verify_chain` recomputes every stored row's
 * hash from its own canonical string, compares each `prev_hash` with its predecessor's hash and
 * refuses a gap in the sequence. Copying that logic here would create a second definition of the
 * hash, which is exactly what `0013`'s header warns against.
 *
 * A chain identifier that is not a uuid is refused as not found rather than sent to the database: the
 * function takes one and would answer an empty set for anything else, which the viewer could not tell
 * apart from a chain with no rows.
 */
export async function verifyAuditChain(
  input: { readonly actor: RequestActor; readonly chainId: string },
  dependencies: AuditLogDependencies,
): Promise<AuditChainVerification> {
  requireAnyRole(input.actor, AUDIT_LOG_READ_ROLES);

  const chainId = input.chainId.trim().toLowerCase();

  if (!isUuid(chainId)) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  const answer = await dependencies.store.rpc("audit_verify_chain", {
    p_chain: chainId,
    p_from_sequence: 1,
  });
  const parsed = verificationSchema.safeParse(answer);
  const row = parsed.success ? parsed.data[0] : undefined;

  if (!parsed.success || row === undefined) {
    throw new AppError("DEPENDENCY_FAILED");
  }

  return {
    chainId: row.chain_id,
    checkedRows: numberOrNull(row.checked_rows) ?? 0,
    isValid: row.is_valid,
    firstBrokenSequence: numberOrNull(row.first_broken_sequence),
    brokenReason: row.broken_reason,
    headSequence: numberOrNull(row.head_sequence),
    headHash: row.head_hash,
    checkedAtEpochMs: nowOf(dependencies),
  };
}

/** The day an instant falls on, so the screen can word a range in the platform's clock. */
export function auditDayLabel(epochMs: number): string {
  return auditDayOf(epochMs);
}
