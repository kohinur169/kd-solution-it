// path: lib/security/velocity.ts
import { createHash } from "node:crypto";
import { AppError } from "../errors/app-error.ts";
import { deepFreeze } from "../utils/freeze.ts";
import type { FraudSignalLookups, FraudVelocityReading, FraudVelocitySubject } from "./fraud.ts";
import { canonicalRateLimitAddress } from "./rate-limit.ts";

/**
 * How often one card and one address may attempt a payment, counted in the database.
 *
 * ## What it counts
 *
 * FEATURE_LIST section 18: "Card and IP velocity limits exist with defaults in config", and section
 * 5 holds unusually large transactions for review. A velocity limit is a count inside a window -
 * five attempts on one card in an hour, twenty from one address - and the count has to survive a
 * deploy, be shared by every instance, and rise atomically under the burst it exists to stop. So it
 * lives in `public.velocity_counters` of `0056` and it moves through `public.consume_velocity` of
 * `0093`, one statement per hit.
 *
 * ## The subject is a hash, and the address is one spelling
 *
 * A card counter's subject is the 64 hex fingerprint `0055` already uses: the SHA-256 of the opaque
 * string the processor hands back, which is a token and never a number. A string that looks like a
 * card number is refused rather than hashed - the platform does not read card data, so it must not
 * be able to fingerprint it either, even by accident. An address is canonicalised by STEP 062's
 * `canonicalRateLimitAddress`, because `2001:0db8:0000::1` and `2001:db8::1` are one machine and two
 * counters for one attacker is not a limit.
 *
 * ## The window is the database's
 *
 * `0093` aligns the window to the epoch and answers the count, the limit that applied, the window,
 * whether the count reached the limit, and whether *this* hit is the one that did. This module never
 * computes a window itself except to check the answer: if the row says a different window than the
 * one asked for, the answer is not this function's and the hit is refused as a dependency failure.
 * A timestamp crosses that boundary as the ISO string a REST client answers, which is the same
 * convention `audit.ts` reads its rows with; a driver's `Date` object is not this module's input.
 *
 * ## The limit is frozen in the row
 *
 * `0056` freezes `limit_value` on a counter, so an operator who lowers a limit does not rewrite a
 * window that already happened: the windows already opened keep the limit they were opened with, and
 * the next window uses the new one. This module therefore reports the limit the *row* applied, not
 * the one the policy has now, and that is the number a fraud decision is made on.
 *
 * ## Why a hit and a read are one call
 *
 * A payment attempt is a hit. Reading a count and then writing it back would lose increments under
 * exactly the burst a velocity limit exists for, and reading without writing would let an attacker
 * retry for free - so `consumeVelocity` is the only way in, and `createVelocityReader` is the shape
 * STEP 066's fraud service consumes: one hit, one `{ hits, limit }`.
 *
 * ## The audit entry is written once per window
 *
 * The hit that reaches the limit writes `security.velocity_limited`; the hits after it do not,
 * because an attack would otherwise turn the audit chain into a copy of itself. That is the same
 * rule STEP 062 applies to a refusal, for the same reason.
 */

/** The function of `0093`, and the table of `0056`, as constants so the two cannot drift. */
export const VELOCITY_CONSUME_FUNCTION = "consume_velocity";
export const VELOCITY_TABLE = "velocity_counters";

/** The rule a screen or a log line can name. */
export const VELOCITY_RULE = "velocity";

/** The audit action of the hit that reached a limit. */
export const VELOCITY_AUDIT_ACTION = "security.velocity_limited";

/** The two subjects a counter may have, the pair `velocity_counters_subject_check` allows. */
export const VELOCITY_SUBJECTS = deepFreeze(["card", "ip"] as const);

export type VelocitySubjectKind = (typeof VELOCITY_SUBJECTS)[number];

/** `velocity_counters_fingerprint_check`: the hex SHA-256 of the processor's token. */
export const VELOCITY_CARD_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

/** The widest opaque string a processor hands back that this platform will hash. */
export const VELOCITY_MAXIMUM_CARD_TOKEN_LENGTH = 200;

/** `velocity_counters_window_check`: one second to thirty days. */
export const VELOCITY_MINIMUM_WINDOW_SECONDS = 1;
export const VELOCITY_MAXIMUM_WINDOW_SECONDS = 2_592_000;

/** A limit is an integer the row stores; a million attempts in a window is already absurd. */
export const VELOCITY_MAXIMUM_LIMIT = 1_000_000;

/** How long a window is kept before the sweep may remove it: the widest window there can be. */
export const VELOCITY_RETENTION_SECONDS = 2_592_000;

/**
 * The defaults, until an operator's setting replaces them.
 *
 * Section 18 says the defaults live in config. They are here as the one place a payment service can
 * read them before a settings screen exists, and the value an operator sets travels in the policy
 * argument - which is why the policy is a parameter and not a module constant.
 */
export const VELOCITY_DEFAULT_POLICY = deepFreeze({
  card: { limit: 5, windowSeconds: 3_600 },
  ip: { limit: 20, windowSeconds: 3_600 },
});

/** Why a hit could not be counted. Machine reasons, never a sentence a client reads. */
export const VELOCITY_PROBLEMS = deepFreeze([
  "subject_invalid",
  "policy_invalid",
  "clock_invalid",
  "response_invalid",
  "retention_invalid",
] as const);

export type VelocityProblem = (typeof VELOCITY_PROBLEMS)[number];

/** One subject's ceiling and window. */
export interface VelocityRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** The two rules a payment is counted under. */
export interface VelocityPolicy {
  readonly card: VelocityRule;
  readonly ip: VelocityRule;
}

/** One subject to count: the processor's card token, or the payer's address. */
export interface VelocityCounterSubject {
  readonly kind: VelocitySubjectKind;
  /** The card token for a card counter, the address for an address counter. */
  readonly value: string;
}

/** The state of one counter after one hit. */
export interface VelocityReading {
  readonly kind: VelocitySubjectKind;
  /** The canonical subject: the fingerprint for a card, the one spelling for an address. */
  readonly value: string;
  readonly hits: number;
  /** The limit the row applied, which is frozen at the first hit of the window. */
  readonly limit: number;
  /** Epoch seconds of the first instant of the window. */
  readonly windowStart: number;
  readonly windowSeconds: number;
  readonly exceeded: boolean;
  /** Seconds until the window rolls over: the wait a caller may tell a payer about. */
  readonly retryAfterSeconds: number;
  /** True on the one hit that reached the limit, which is when the audit entry is written. */
  readonly firstBreach: boolean;
}

/** The part of the REST client this service needs: one function, called by name. */
export interface VelocityCounterClient {
  rpc(functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown>;
}

/**
 * The part of a client that can remove rows.
 *
 * The sweep is a physical delete on purpose - `0056` says a window is retired by the sweep and never
 * soft deleted, because a hidden counter would free its key for a fresh count of zero - so it cannot
 * be an update and it is not a function in a migration: a forward migration never deletes rows.
 */
export interface VelocitySweepClient {
  deleteBefore(table: string, column: string, before: string): Promise<number>;
}

export interface VelocityCounterOptions {
  readonly rest: VelocityCounterClient;
  readonly policy?: VelocityPolicy;
  /** Milliseconds. Passed in so a test stands on a window boundary without waiting. */
  readonly now?: () => number;
}

/** Structurally the entry STEP 063 accepts. */
export interface VelocityAuditEntry {
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

export interface VelocityAuditTrail {
  append(entry: VelocityAuditEntry): Promise<void>;
}

export interface VelocityAuditContext {
  readonly actorUserId?: string | null;
  readonly sessionId?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface VelocityReaderOptions extends VelocityCounterOptions {
  readonly audit?: VelocityAuditTrail;
  readonly auditContext?: VelocityAuditContext;
}

export interface VelocitySweepOptions {
  readonly client: VelocitySweepClient;
  readonly policy?: VelocityPolicy;
  readonly now?: () => number;
  readonly retentionSeconds?: number;
}

const subjectSet: ReadonlySet<string> = new Set<string>(VELOCITY_SUBJECTS);

const cardTokenPattern = /^[\x21-\x7e]+$/u;

/** A string of twelve to nineteen digits is a card number, and no card number is hashed here. */
const cardNumberPattern = /^[0-9]{12,19}$/u;

/** True when a value names a subject this platform counts. */
export function isVelocitySubject(value: unknown): value is VelocitySubjectKind {
  return typeof value === "string" && subjectSet.has(value);
}

function velocityFailure(code: "INTERNAL_ERROR" | "DEPENDENCY_FAILED", reason: VelocityProblem): AppError {
  return new AppError(code, { cause: { rule: VELOCITY_RULE, reason } });
}

function subjectFailure(): AppError {
  return velocityFailure("INTERNAL_ERROR", "subject_invalid");
}

/**
 * The fingerprint of the processor's card token.
 *
 * The string is the adapter's, never the payer's: a token, or the provider's own card fingerprint.
 * It is hashed so the counter names a card without holding one - and a value that is a card number
 * is refused before it is hashed, because a hash of a number is still a way to recognise the number.
 */
export function velocityCardFingerprint(cardToken: string): string {
  if (
    typeof cardToken !== "string" ||
    cardToken.length > VELOCITY_MAXIMUM_CARD_TOKEN_LENGTH ||
    !cardTokenPattern.test(cardToken) ||
    cardNumberPattern.test(cardToken)
  ) {
    throw subjectFailure();
  }

  return createHash("sha256").update(cardToken, "utf8").digest("hex");
}

/** The one spelling of an address, or the refusal. */
export function canonicalVelocityAddress(address: string): string {
  const canonical = typeof address === "string" ? canonicalRateLimitAddress(address) : null;

  if (canonical === null) {
    throw subjectFailure();
  }

  return canonical;
}

/**
 * The subject in the form the counter stores: a fingerprint or a canonical address.
 *
 * A value that is already a 64 hex fingerprint is accepted as it is, because a caller that has
 * already hashed the token - the payment page does, to match the blacklist of `0055` - must count
 * the same card as the caller that hands over the token.
 */
export function canonicalVelocitySubject(subject: VelocityCounterSubject): VelocityCounterSubject {
  if (!isVelocitySubject(subject.kind)) {
    throw subjectFailure();
  }

  if (subject.kind === "card") {
    return {
      kind: "card",
      value: VELOCITY_CARD_FINGERPRINT_PATTERN.test(subject.value)
        ? subject.value
        : velocityCardFingerprint(subject.value),
    };
  }

  return { kind: "ip", value: canonicalVelocityAddress(subject.value) };
}

/** The rule of one subject, validated against the bounds `0056` states. */
function requireRule(rule: VelocityRule | undefined): VelocityRule {
  if (rule === undefined) {
    throw velocityFailure("INTERNAL_ERROR", "policy_invalid");
  }

  if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > VELOCITY_MAXIMUM_LIMIT) {
    throw velocityFailure("INTERNAL_ERROR", "policy_invalid");
  }

  if (
    !Number.isInteger(rule.windowSeconds) ||
    rule.windowSeconds < VELOCITY_MINIMUM_WINDOW_SECONDS ||
    rule.windowSeconds > VELOCITY_MAXIMUM_WINDOW_SECONDS
  ) {
    throw velocityFailure("INTERNAL_ERROR", "policy_invalid");
  }

  return rule;
}

/** The clock, in milliseconds, or the refusal. */
function requireClock(now: () => number): number {
  let value: number;

  try {
    value = now();
  } catch {
    throw velocityFailure("INTERNAL_ERROR", "clock_invalid");
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw velocityFailure("INTERNAL_ERROR", "clock_invalid");
  }

  return value;
}

/**
 * The first instant of the window an attempt falls in, in epoch seconds.
 *
 * This is the arithmetic `0093` performs, repeated here only to *check* the answer the database
 * gives: a row whose window is not the window this module asked about is not this function's row.
 */
export function velocityWindowStart(nowMs: number, windowSeconds: number): number {
  const seconds = Math.floor(nowMs / 1_000);

  return seconds - (seconds % windowSeconds);
}

/** Seconds until the window rolls over. Never zero, so a caller always has a wait to report. */
export function velocityRetryAfter(nowMs: number, windowStart: number, windowSeconds: number): number {
  const seconds = Math.floor(nowMs / 1_000);
  const remaining = windowStart + windowSeconds - seconds;

  return Math.max(1, remaining);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/**
 * The answer of the counter function, or a dependency failure.
 *
 * The body is one row. A missing field read as zero would be a limit that never bites, so every
 * field is checked, the window is checked against the window that was asked about, and the two
 * verdicts are checked against the count they claim to describe: `exceeded` is `hits >= limit`, and
 * `first_breach` is `hits = limit`. A counter whose verdicts disagree with its own numbers is not a
 * counter this service will report a payment on.
 */
function readCounterAnswer(
  body: unknown,
  subject: VelocityCounterSubject,
  rule: VelocityRule,
  nowMs: number,
): VelocityReading {
  const row = Array.isArray(body) && body.length === 1 ? body[0] : undefined;

  if (!isPlainObject(row)) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  const hits = row["counter_hits"];
  const limit = row["counter_limit"];
  const windowStartIso = row["counter_window_start"];
  const windowSeconds = row["counter_window_seconds"];
  const exceeded = row["counter_exceeded"];
  const firstBreach = row["counter_first_breach"];

  if (!isIntegerBetween(hits, 1, Number.MAX_SAFE_INTEGER) || !isIntegerBetween(limit, 1, VELOCITY_MAXIMUM_LIMIT)) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  if (!isIntegerBetween(windowSeconds, VELOCITY_MINIMUM_WINDOW_SECONDS, VELOCITY_MAXIMUM_WINDOW_SECONDS)) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  if (windowSeconds !== rule.windowSeconds) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  if (typeof windowStartIso !== "string") {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  const windowStart = Math.floor(Date.parse(windowStartIso) / 1_000);

  if (!Number.isSafeInteger(windowStart) || windowStart !== velocityWindowStart(nowMs, windowSeconds)) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  if (typeof exceeded !== "boolean" || typeof firstBreach !== "boolean") {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  if (exceeded !== (hits >= limit) || firstBreach !== (hits === limit)) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  return {
    kind: subject.kind,
    value: subject.value,
    hits,
    limit,
    windowStart,
    windowSeconds,
    exceeded,
    retryAfterSeconds: velocityRetryAfter(nowMs, windowStart, windowSeconds),
    firstBreach,
  };
}

/**
 * Count one hit and answer the state of the counter after it.
 *
 * The subject is canonicalised first, so the row is keyed on a fingerprint or on one spelling of an
 * address; the policy is validated against the bounds of `0056`; the clock is read once; and the
 * function is called with the six arguments `0093` declares. A failed call is `DEPENDENCY_FAILED`:
 * a payment that cannot be counted must not be treated as the first attempt of the window.
 */
export async function consumeVelocity(
  subject: VelocityCounterSubject,
  options: VelocityCounterOptions,
): Promise<VelocityReading> {
  const canonical = canonicalVelocitySubject(subject);
  const policy = options.policy ?? VELOCITY_DEFAULT_POLICY;
  const rule = requireRule(policy[canonical.kind]);
  const nowMs = requireClock(options.now ?? ((): number => Date.now()));

  let body: unknown;

  try {
    body = await options.rest.rpc(VELOCITY_CONSUME_FUNCTION, {
      p_subject: canonical.kind,
      p_card_fingerprint: canonical.kind === "card" ? canonical.value : null,
      p_ip_address: canonical.kind === "ip" ? canonical.value : null,
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
      p_now: new Date(nowMs).toISOString(),
    });
  } catch {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  return readCounterAnswer(body, canonical, rule, nowMs);
}

/**
 * The reader STEP 066's fraud service consumes.
 *
 * One call is one hit: the payment attempt is what the limit counts, so a reader that did not write
 * would let an attacker retry for free. The hit that reaches the limit appends the audit entry when
 * a trail is given, and a failure to append never fails the payment - the counter already moved, and
 * the audit writer has its own retry.
 */
export function createVelocityReader(options: VelocityReaderOptions): FraudSignalLookups["readVelocity"] {
  return async (subject: FraudVelocitySubject): Promise<FraudVelocityReading> => {
    const reading = await consumeVelocity({ kind: subject.kind, value: subject.value }, options);
    const entry = options.audit === undefined ? null : velocityAuditEntry(reading, options.auditContext ?? {});

    if (entry !== null && options.audit !== undefined) {
      await options.audit.append(entry).catch(() => undefined);
    }

    return { hits: reading.hits, limit: reading.limit };
  };
}

/**
 * The audit entry of the hit that reached a limit, or null for every other hit.
 *
 * The counter is the platform's - `0056` forces `company_id` to null - so the entry is on the
 * platform's chain as well, and it names the subject by kind. A card is named by its fingerprint,
 * which is a hash `0055` already stores; an address is not repeated in the payload, because the
 * entry's own address field is where an operator reads it.
 */
export function velocityAuditEntry(
  reading: VelocityReading,
  context: VelocityAuditContext = {},
): VelocityAuditEntry | null {
  if (!reading.firstBreach) {
    return null;
  }

  const address = context.ipAddress ?? (reading.kind === "ip" ? reading.value : null);

  return {
    action: VELOCITY_AUDIT_ACTION,
    actorUserId: context.actorUserId ?? null,
    entityType: null,
    entityId: null,
    payload: {
      rule: VELOCITY_RULE,
      subject: reading.kind,
      card_fingerprint: reading.kind === "card" ? reading.value : null,
      hits: reading.hits,
      limit: reading.limit,
      window_start: new Date(reading.windowStart * 1_000).toISOString(),
      window_seconds: reading.windowSeconds,
      retry_after_seconds: reading.retryAfterSeconds,
    },
    companyId: null,
    sessionId: context.sessionId ?? null,
    ipAddress: address,
    userAgent: context.userAgent ?? null,
  };
}

/**
 * The sweep that retires old windows, physically.
 *
 * `0056` keeps a counter forever, and its comment says the retention sweep of this STEP removes old
 * windows by deleting the row - not by a soft delete, which would free the window key for a fresh
 * count of zero. The cutoff may never be inside a window the policy could still be counting, so the
 * retention has to be at least the widest window in force: deleting a live counter would be the
 * limit bypassed, and it would be silent.
 */
export async function sweepVelocityWindows(options: VelocitySweepOptions): Promise<number> {
  const policy = options.policy ?? VELOCITY_DEFAULT_POLICY;
  const widest = Math.max(
    requireRule(policy.card).windowSeconds,
    requireRule(policy.ip).windowSeconds,
  );
  const retentionSeconds = options.retentionSeconds ?? VELOCITY_RETENTION_SECONDS;

  if (!Number.isInteger(retentionSeconds) || retentionSeconds < widest) {
    throw velocityFailure("INTERNAL_ERROR", "retention_invalid");
  }

  const nowMs = requireClock(options.now ?? ((): number => Date.now()));
  const cutoff = new Date(nowMs - retentionSeconds * 1_000).toISOString();

  let removed: number;

  try {
    removed = await options.client.deleteBefore(VELOCITY_TABLE, "window_start", cutoff);
  } catch {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  if (!Number.isSafeInteger(removed) || removed < 0) {
    throw velocityFailure("DEPENDENCY_FAILED", "response_invalid");
  }

  return removed;
}
