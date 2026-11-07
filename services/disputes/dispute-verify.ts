// path: services/disputes/dispute-verify.ts
import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { stripeSignedPayload } from "../../lib/payments/adapters/stripe.ts";
import {
  disputeViewOf,
  dueStateOf,
  listCompanyDisputes,
  listDisputeQueue,
  type DisputeDependencies,
} from "./dispute.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_AUDIT_ENTITY,
  DISPUTE_DEFAULT_WINDOW_HOURS,
  DISPUTE_LIST_LIMIT,
  DISPUTE_OFFICE_ROLES,
  DISPUTE_OUTCOME_NOTE_MAXIMUM_LENGTH,
  DISPUTE_PROVIDER_STATUSES,
  DISPUTE_QUEUE_LIMIT,
  DISPUTE_REASON_MAXIMUM_LENGTH,
  DISPUTE_REQUEST_ROLES,
  DISPUTE_RESOLVED_STATUSES,
  DISPUTE_RULES,
  DISPUTE_STATUSES,
  DISPUTE_STATUS_RANK,
  DISPUTE_WINDOW_HOURS,
  disputeDueAt,
  disputeMinorFromProviderHundredths,
  disputeStatusMayMove,
  disputeStatusRank,
  isProviderWritableDisputeStatus,
  isResolvedDisputeStatus,
} from "./dispute-fields.ts";
import {
  DISPUTE_EVENT_SOURCES,
  STRIPE_CONNECT_PROVIDER_KEY,
  STRIPE_DISPUTE_EVENT_PATTERN,
  STRIPE_DISPUTE_SECRET_SETTING,
  STRIPE_DISPUTE_WEBHOOK_PATH,
  STRIPE_SIGNATURE_HEADER,
  disputeEventSourceOf,
  readStripeDisputeEvent,
  stripeDisputeStatusOf,
} from "./dispute-events.ts";
import {
  disputePayloadHash,
  receiveDisputeWebhook,
  verifyProviderWebhookSignature,
  type DisputeWebhookDependencies,
} from "./dispute-webhook.ts";

/**
 * The gate for STEP 194: section 19's dispute list and the status a provider's webhook moves.
 *
 * ## What this proves
 *
 *   - **A dispute is opened by a verified delivery and by nothing else.** The signature is checked before
 *     a field of the body is read; a body that does not verify, an unknown provider, a missing secret and a
 *     body that is not the documented envelope each answer their own status and write no row at all.
 *   - **One dispute, one row.** `0039`'s `disputes_processor_key` is the idempotency claim, so the second
 *     delivery of the same event is a `200` and a `duplicate`, and the second delivery of a *different*
 *     event for the same dispute finds the row the first one wrote.
 *   - **The status only moves forward.** `open` -> `under_review` -> `won`/`lost`/`closed`, never back, never
 *     between two terminal statuses, and never into `evidence_submitted`, which is the compliance desk's
 *     state and requires an evidence pack. A stale or replayed delivery is `200` and `ignored`, and the row
 *     is untouched.
 *   - **A decided dispute stays decided.** `0039`'s `disputes_guard_deadline` refuses to reopen it, and the
 *     service refuses before the database has to.
 *   - **The delivery is recorded before its effect, and settled after it.** A crash between the two leaves a
 *     `processing` row a redelivery can finish; a payment this database does not have yet is a `500` so the
 *     processor retries, and the retry re-runs the effect rather than answering `duplicate`.
 *   - **The read side is the merchant's own rows and the office's deadline queue**, with the role each one
 *     requires, and the fee column untouched: section 18's chargeback fee is a later STEP's number.
 *   - **No migration is needed.** `0039` already carries the table, the deadline arithmetic, the evidence
 *     rule, the resolution pair, the unique processor key and the triggers. The gate reads that file and
 *     asserts each of them, and asserts the highest migration is still 123.
 *   - **Nothing here writes money.** No `payments` write, no ledger call, no chargeback fee.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(Object.is(actual, expected), `${description} (expected ${String(expected)}, got ${String(actual)})`);
}

/** Run a call that must refuse with a code, and check that it is an `AppError`. */
async function expectRefusal(
  run: () => Promise<unknown>,
  code: string,
  description: string,
): Promise<void> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
  } catch (error) {
    if (!isAppError(error)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return;
    }

    expectEqual(error.code, code, description);
  }
}

// ---------------------------------------------------------------------------------------------
// A PostgREST over arrays, with `0039`'s and `0032`'s triggers on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherOwnerUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const officeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const startedAtMs = Date.parse("2026-11-07T09:00:00.000Z");
const secret = "whsec_dispute_gate_secret_value";

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"],
    sessionId: "session-0001",
    assuranceLevel: "aal1",
    authenticatedAtEpochMs: startedAtMs - 60_000,
    expiresAtEpochMs: startedAtMs + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

function officeActor(role: "ceo" | "compliance_kyc" | "finance_ops" | "super_admin"): RequestActor {
  return actorOf({ userId: officeUserId, companyId: null, roles: [role] });
}

interface Fixture {
  readonly rest: RestClient;
  readonly disputes: Row[];
  readonly events: Row[];
  readonly payments: Row[];
  readonly providers: Row[];
  nowMs: number;
  /** Something that lands between a caller's read and its write: another delivery of the same dispute. */
  beforeUpdate: ((table: string) => void) | null;
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly order: { readonly column: string; readonly direction: "asc" | "desc" } | null;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  let order: Query["order"] = null;
  let limit: number | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select") {
      continue;
    }

    if (key === "order") {
      const [column = "", direction = "asc"] = value.split(".");

      order = { column, direction: direction === "desc" ? "desc" : "asc" };
      continue;
    }

    if (key === "limit") {
      limit = Number.parseInt(value, 10);
      continue;
    }

    if (value === "is.null") {
      nulls.add(key);
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const column of query.nulls) {
    if (row[column] !== null && row[column] !== undefined) {
      return false;
    }
  }

  return true;
}

/** `disputes_processor_key`: one row per processor dispute inside a merchant. */
function guardProcessorKey(disputes: readonly Row[], row: Row, exceptId: string | null): void {
  if (row["processor_dispute_id"] === null || row["processor_dispute_id"] === undefined) {
    return;
  }

  for (const other of disputes) {
    if (
      other["id"] !== exceptId &&
      other["company_id"] === row["company_id"] &&
      other["processor_dispute_id"] === row["processor_dispute_id"]
    ) {
      throw new AppError("CONFLICT", { details: [{ field: "processor_dispute_id", rule: "disputes_processor_key" }] });
    }
  }
}

/** Every check in `0039_disputes.sql`, in the fixture. */
function guardDispute(fixture: Fixture, row: Row, previous: Row | null): void {
  const fail = (field: string): never => {
    throw new AppError("CONFLICT", { details: [{ field, rule: "dispute_guard" }] });
  };

  const status = String(row["status"]);

  if (!(DISPUTE_STATUSES as readonly string[]).includes(status)) fail("status");

  const reason = String(row["reason_code"]);

  if (reason.length < 1 || reason.length > DISPUTE_REASON_MAXIMUM_LENGTH || reason !== reason.trim()) fail("reason_code");
  if (Number(row["amount_minor"]) <= 0) fail("amount_minor");
  if (!/^[A-Z]{3}$/u.test(String(row["currency"]))) fail("currency");
  if (Number(row["fee_minor"]) < 0) fail("fee_minor");
  if (!(DISPUTE_WINDOW_HOURS as readonly number[]).includes(Number(row["response_window_hours"]))) fail("response_window_hours");

  const openedAt = Date.parse(String(row["opened_at"]));
  const dueAt = Date.parse(String(row["response_due_at"]));
  const windowMs = Number(row["response_window_hours"]) * 3_600_000;

  if (!(dueAt > openedAt && dueAt <= openedAt + windowMs)) fail("response_due_at");

  const submittedAt = row["submitted_at"] === null || row["submitted_at"] === undefined ? null : Date.parse(String(row["submitted_at"]));

  if (submittedAt !== null && row["evidence_ready"] !== true) fail("submitted_at");
  if (status === "evidence_submitted" && submittedAt === null) fail("status");
  if (submittedAt !== null && submittedAt < openedAt) fail("submitted_at");

  const resolvedAt = row["resolved_at"] === null || row["resolved_at"] === undefined ? null : String(row["resolved_at"]);
  const terminal = (DISPUTE_RESOLVED_STATUSES as readonly string[]).includes(status);

  if (terminal !== (resolvedAt !== null)) fail("resolved_at");

  const note = row["outcome_note"] === null || row["outcome_note"] === undefined ? null : String(row["outcome_note"]);

  if (note !== null && (note.length < 1 || note.length > DISPUTE_OUTCOME_NOTE_MAXIMUM_LENGTH || note !== note.trim())) {
    fail("outcome_note");
  }

  if (resolvedAt !== null && note === null) fail("outcome_note");

  if (previous === null) {
    const payment = fixture.payments.find((candidate) => candidate["id"] === row["payment_id"]);

    if (payment === undefined) fail("payment_id");
    if (payment?.["company_id"] !== row["company_id"]) fail("company_id");

    guardProcessorKey(fixture.disputes, row, null);

    return;
  }

  // `disputes_guard_deadline`, one clause at a time.
  if (previous["company_id"] !== row["company_id"] || previous["payment_id"] !== row["payment_id"] || previous["opened_at"] !== row["opened_at"]) {
    fail("payment_id");
  }

  if (previous["response_window_hours"] !== row["response_window_hours"] && previous["submitted_at"] !== null) {
    fail("response_window_hours");
  }

  if (previous["resolved_at"] !== null && (previous["status"] !== row["status"] || previous["resolved_at"] !== row["resolved_at"])) {
    fail("status");
  }
}

/** Every check in `0032_webhook_events.sql`, in the fixture. */
function guardEvent(fixture: Fixture, row: Row, previous: Row | null): void {
  const fail = (field: string): never => {
    throw new AppError("CONFLICT", { details: [{ field, rule: "webhook_event_guard" }] });
  };

  const status = String(row["status"]);
  const signatureOk = row["signature_ok"] === true;

  if (!["pending", "processing", "processed", "failed", "ignored", "rejected"].includes(status)) fail("status");
  if (!signatureOk && !["pending", "failed", "ignored", "rejected"].includes(status)) fail("signature_ok");
  if (status === "rejected" && signatureOk) fail("status");
  if (!/^[0-9a-f]{64}$/u.test(String(row["payload_hash"]))) fail("payload_hash");
  if ((status === "processed") !== (row["processed_at"] !== null)) fail("processed_at");

  const detail = row["failure_detail"] === null || row["failure_detail"] === undefined ? null : String(row["failure_detail"]);

  if (status === "failed" && (detail === null || detail.length < 1 || detail.length > 280 || detail !== detail.trim())) {
    fail("failure_detail");
  }

  if (status !== "failed" && detail !== null) fail("failure_detail");

  if (previous === null) {
    for (const other of fixture.events) {
      if (
        other["provider_id"] === row["provider_id"] &&
        other["mode"] === row["mode"] &&
        other["external_event_id"] === row["external_event_id"]
      ) {
        throw new AppError("CONFLICT", { details: [{ field: "external_event_id", rule: "webhook_events_provider_key" }] });
      }
    }

    return;
  }

  for (const column of ["provider_id", "mode", "external_event_id", "event_type", "payload_hash", "received_at", "signature_ok"]) {
    if (previous[column] !== row[column]) fail(column);
  }

  if (previous["company_id"] !== null && previous["company_id"] !== row["company_id"]) fail("company_id");
  if (["processed", "rejected", "ignored"].includes(String(previous["status"])) && previous["status"] !== row["status"]) fail("status");
  if (previous["status"] !== "pending" && row["status"] === "pending") fail("status");
}

function createFixture(payments: readonly Row[]): Fixture {
  const disputes: Row[] = [];
  const events: Row[] = [];
  const providers: Row[] = [
    {
      id: randomUUID(),
      company_id: null,
      provider_key: STRIPE_CONNECT_PROVIDER_KEY,
      display_name: "Stripe Connect",
      status: "disabled",
      deleted_at: null,
    },
  ];
  let writeCount = 0;
  const table: Record<string, Row[]> = { disputes, webhook_events: events, payments: [...payments], payment_providers: providers };

  const rowsOf = (name: string): Row[] => {
    const rows = table[name];

    if (rows === undefined) {
      throw new AppError("DEPENDENCY_FAILED");
    }

    return rows;
  };

  const stamp = (): string => {
    writeCount += 1;

    return new Date(startedAtMs + writeCount * 1_000).toISOString();
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      let rows = rowsOf(name).filter((row) => matches(row, parsed));

      if (parsed.order !== null) {
        const { column, direction } = parsed.order;
        rows = [...rows].sort((left, right) => {
          const a = String(left[column] ?? "");
          const b = String(right[column] ?? "");

          return direction === "asc" ? a.localeCompare(b) : b.localeCompare(a);
        });
      }

      if (parsed.limit !== null) {
        rows = rows.slice(0, parsed.limit);
      }

      return schema.array().parse(rows);
    },

    async insert(name: string, rows: readonly Row[]): Promise<void> {
      for (const row of rows) {
        rowsOf(name).push({ ...row });
      }
    },

    async insertReturning<TRow>(name: string, rows: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const written: Row[] = [];

      for (const row of rows) {
        const at = stamp();
        const complete: Row =
          name === "disputes"
            ? {
                id: randomUUID(),
                currency: "USD",
                fee_minor: "0",
                evidence_ready: false,
                response_text: null,
                submitted_at: null,
                resolved_at: null,
                outcome_note: null,
                created_at: at,
                updated_at: at,
                deleted_at: null,
                version: 1,
                ...row,
              }
            : {
                id: randomUUID(),
                company_id: null,
                signature_ok: false,
                received_at: at,
                processed_at: null,
                failure_detail: null,
                created_at: at,
                updated_at: at,
                deleted_at: null,
                version: 1,
                status: "pending",
                ...row,
              };

        if (name === "disputes") {
          guardDispute(fixture, complete, null);
        } else if (name === "webhook_events") {
          guardEvent(fixture, complete, null);
        }

        rowsOf(name).push(complete);
        written.push(complete);
      }

      return schema.array().parse(written);
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      const interference = fixture.beforeUpdate;

      fixture.beforeUpdate = null;
      interference?.(name);

      const parsed = parseQuery(query);

      for (const row of rowsOf(name).filter((candidate) => matches(candidate, parsed))) {
        const next: Row = { ...row, ...values };

        if (name === "disputes") {
          guardDispute(fixture, next, row);
        } else if (name === "webhook_events") {
          guardEvent(fixture, next, row);
        }

        next["version"] = Number(row["version"]) + 1;
        next["updated_at"] = stamp();
        Object.assign(row, next);
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED");
    },
  };

  const fixture: Fixture = {
    rest,
    disputes: table["disputes"] as Row[],
    events: table["webhook_events"] as Row[],
    payments: table["payments"] as Row[],
    providers,
    nowMs: startedAtMs,
    beforeUpdate: null,
  };

  return fixture;
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    company_id: companyId,
    provider_id: null,
    mode: "live",
    provider_transaction_id: "ch_dispute_0001",
    amount_minor: "100000000",
    currency: "USD",
    status: "captured",
    deleted_at: null,
    ...overrides,
  };
}

interface Harness {
  readonly fixture: Fixture;
  readonly audit: InMemoryAuditTrail;
  readonly dependencies: DisputeDependencies;
  readonly webhook: DisputeWebhookDependencies;
  readonly paymentId: string;
  readonly providerId: string;
}

function harnessOf(paymentOverrides: Row = {}, secrets: Readonly<Record<string, string | null>> = { [STRIPE_DISPUTE_SECRET_SETTING]: secret }): Harness {
  const fixture = createFixture([]);
  const providerId = String(fixture.providers[0]?.["id"] ?? "");
  const payment = paymentRow({ provider_id: providerId, ...paymentOverrides });

  fixture.payments.push(payment);
  fixture.providers[0] = { ...fixture.providers[0], id: providerId };

  const audit = createInMemoryAuditTrail();
  const dependencies: DisputeDependencies = {
    rest: fixture.rest,
    audit,
    now: () => fixture.nowMs,
  };

  return {
    fixture,
    audit,
    dependencies,
    paymentId: String(payment["id"]),
    providerId,
    webhook: {
      rest: fixture.rest,
      audit,
      now: () => fixture.nowMs,
      settings: {
        readSecret: (key: string): Promise<string | null> => Promise.resolve(secrets[key] ?? null),
      },
    },
  };
}

/* ---- Stripe bodies ------------------------------------------------------------------------- */

interface StripeDisputeOverrides {
  readonly id?: string;
  readonly type?: string;
  readonly eventId?: string;
  readonly livemode?: boolean;
  readonly objectId?: string;
  readonly charge?: string | null;
  readonly paymentIntent?: string | null;
  readonly amount?: number;
  readonly currency?: string;
  readonly reason?: string | null;
  readonly status?: string;
  readonly created?: number;
}

function stripeBody(overrides: StripeDisputeOverrides = {}): string {
  return JSON.stringify({
    id: overrides.eventId ?? "evt_disputegate0001",
    object: "event",
    type: overrides.type ?? "charge.dispute.created",
    livemode: overrides.livemode ?? true,
    created: 1_791_000_000,
    data: {
      object: {
        id: overrides.objectId ?? "dp_dispute_0001",
        object: "dispute",
        charge: overrides.charge === undefined ? "ch_dispute_0001" : overrides.charge,
        payment_intent: overrides.paymentIntent === undefined ? "pi_dispute_0001" : overrides.paymentIntent,
        amount: overrides.amount ?? 2_000,
        currency: overrides.currency ?? "usd",
        reason: overrides.reason === undefined ? "fraudulent" : overrides.reason,
        status: overrides.status ?? "needs_response",
        created: overrides.created ?? Math.floor(startedAtMs / 1_000) - 3_600,
        evidence_details: { due_by: 1_791_600_000 },
      },
    },
  });
}

function signatureOf(rawBody: string, atSeconds: number): string {
  const signature = createHmac("sha256", secret).update(stripeSignedPayload(atSeconds, rawBody), "utf8").digest("hex");

  return `t=${String(atSeconds)},v1=${signature}`;
}

function headersOf(rawBody: string, atSeconds: number): ReadonlyMap<string, string> {
  return new Map([[STRIPE_SIGNATURE_HEADER, signatureOf(rawBody, atSeconds)]]);
}

function nowSeconds(fixture: Fixture): number {
  return Math.floor(fixture.nowMs / 1_000);
}

async function deliver(
  harness: Harness,
  rawBody: string,
  options: { readonly signed?: boolean; readonly providerKey?: string } = {},
): Promise<Awaited<ReturnType<typeof receiveDisputeWebhook>>> {
  return receiveDisputeWebhook(
    {
      providerKey: options.providerKey ?? STRIPE_CONNECT_PROVIDER_KEY,
      rawBody,
      headers:
        options.signed === false
          ? new Map([[STRIPE_SIGNATURE_HEADER, "t=1,v1=deadbeef"]])
          : headersOf(rawBody, nowSeconds(harness.fixture)),
    },
    harness.webhook,
  );
}

function actionsOf(audit: InMemoryAuditTrail): readonly string[] {
  return audit.entries.map((entry) => entry.action);
}

// ---------------------------------------------------------------------------------------------
async function main(): Promise<void> {
  const migration = await readFile(new URL("../../migrations/0039_disputes.sql", import.meta.url), "utf8");
  const eventsMigration = await readFile(new URL("../../migrations/0032_webhook_events.sql", import.meta.url), "utf8");

  // -------------------------------------------------------------------------------------------
  // 1. The vocabulary, against `0039`
  // -------------------------------------------------------------------------------------------
  expectEqual(DISPUTE_STATUSES.length, 6, "`0039` allows six statuses");
  expectEqual(DISPUTE_STATUSES.join(","), "open,under_review,evidence_submitted,won,lost,closed", "in the migration's order");
  expect(
    migration.includes(`status in ('open', 'under_review', 'evidence_submitted', 'won', 'lost', 'closed')`),
    "and the migration's own check names the same six, in the same order",
  );
  expectEqual(DISPUTE_AUDIT_ENTITY, "dispute", "the audit entity");
  expectEqual(DISPUTE_REQUEST_ROLES.join(","), "owner", "a merchant's disputes are read by its owner");
  expectEqual(DISPUTE_OFFICE_ROLES.join(","), "ceo,compliance_kyc,finance_ops,super_admin", "and the queue by the four desks");
  expect(
    DISPUTE_REQUEST_ROLES.every((role) => !(DISPUTE_OFFICE_ROLES as readonly string[]).includes(role)),
    "the two lists are disjoint, so no merchant role reads every merchant's queue",
  );
  expectEqual(DISPUTE_DEFAULT_WINDOW_HOURS, 24, "section 19's window is 24 hours");
  expectEqual(DISPUTE_WINDOW_HOURS.join(","), "24,48", "and 48 is the extension the same section allows");
  expect(migration.includes("response_window_hours in (24, 48)"), "which is what the migration's check allows");
  expectEqual(DISPUTE_REASON_MAXIMUM_LENGTH, 64, "the reason code is bounded at 64");
  expect(migration.includes("char_length(reason_code) between 1 and 64"), "as `disputes_reason_check` says");
  expectEqual(DISPUTE_OUTCOME_NOTE_MAXIMUM_LENGTH, 500, "the outcome note at 500");
  expect(migration.includes("char_length(outcome_note) between 1 and 500"), "as `disputes_outcome_check` says");
  expectEqual(DISPUTE_LIST_LIMIT, 50, "a merchant's list is bounded");
  expectEqual(DISPUTE_QUEUE_LIMIT, 100, "and the office queue");
  expectEqual(new Set(Object.values(DISPUTE_RULES)).size, Object.values(DISPUTE_RULES).length, "no two causes share a rule");
  expectEqual(
    new Set(Object.values(DISPUTE_AUDIT)).size,
    Object.values(DISPUTE_AUDIT).length,
    "and no two audit actions share a name",
  );
  expect(
    migration.includes("create unique index disputes_processor_key"),
    "`0039` carries the index the whole idempotency story rests on",
  );
  expect(migration.includes("on public.disputes (company_id, processor_dispute_id)"), "on the merchant and the processor's id");
  expect(migration.includes("disputes_guard_deadline"), "and the trigger that freezes a decided row");
  expect(migration.includes("a resolved dispute stays resolved"), "which refuses to reopen one");
  expect(
    migration.includes("response_due_at > opened_at") && migration.includes("make_interval(hours => response_window_hours)"),
    "and the deadline arithmetic section 19 states",
  );
  expect(
    migration.includes("submitted_at is null or evidence_ready"),
    "the evidence rule the provider statuses must not skip",
  );
  expect(
    eventsMigration.includes("(provider_id, mode, external_event_id)") ||
      eventsMigration.includes("webhook_events_provider_key"),
    "`0032` keys a delivery by the provider's own id",
  );
  expect(eventsMigration.includes("signature_ok or status in ('pending', 'failed', 'ignored', 'rejected')"), "and ties a claimed success to a verified signature");

  // -------------------------------------------------------------------------------------------
  // 2. The status machine
  // -------------------------------------------------------------------------------------------
  expectEqual(disputeStatusRank("open"), 0, "`open` is the start");
  expectEqual(disputeStatusRank("under_review"), 1, "`under_review` is ahead of it");
  expectEqual(disputeStatusRank("evidence_submitted"), 2, "the submission is ahead of the review");
  expectEqual(disputeStatusRank("won"), 3, "and the three outcomes are last");
  expectEqual(disputeStatusRank("lost"), 3, "all at the same rank");
  expectEqual(disputeStatusRank("closed"), 3, "so none of them may follow another");
  expectEqual(disputeStatusRank("nonsense"), -1, "a word the platform does not know ranks nowhere");
  expect(disputeStatusMayMove("open", "under_review"), "a review follows an opening");
  expect(disputeStatusMayMove("open", "lost"), "and an outcome may follow an opening directly");
  expect(!disputeStatusMayMove("under_review", "open"), "a delivery cannot take a row backwards");
  expect(!disputeStatusMayMove("lost", "won"), "and never between two decisions");
  expect(!disputeStatusMayMove("won", "closed"), "not even to the other terminal word");
  expect(!disputeStatusMayMove("open", "evidence_submitted"), "the provider may not claim the evidence was sent");
  expect(!isProviderWritableDisputeStatus("evidence_submitted"), "which is why that status is absent from the list");
  expectEqual(DISPUTE_PROVIDER_STATUSES.join(","), "open,under_review,won,lost,closed", "four statuses and the submission left out");
  expect(isResolvedDisputeStatus("closed") && !isResolvedDisputeStatus("under_review"), "`closed` is history and a review is not");
  expectEqual(DISPUTE_STATUS_RANK["evidence_submitted"], 2, "the rank table is the machine, in one place");
  expectEqual(disputeMinorFromProviderHundredths(2_000), 200_000n, "a dispute of 20.00 arrives as 2000 and is stored as four decimals");
  expectEqual(disputeMinorFromProviderHundredths(1), 100n, "one cent is a hundred minor units");
  const openedAtMs = Date.parse("2026-11-07T09:00:00.000Z");
  expectEqual(
    new Date(disputeDueAt(openedAtMs, 24)).toISOString(),
    "2026-11-08T09:00:00.000Z",
    "the deadline is the opening instant plus the window",
  );
  expectEqual(dueStateOf(null, "2026-11-08T09:00:00.000Z", openedAtMs), "open", "a fresh dispute is in time");
  expectEqual(dueStateOf(null, "2026-11-07T09:30:00.000Z", openedAtMs), "due_soon", "inside the last four hours it is due soon");
  expectEqual(dueStateOf(null, "2026-11-07T08:00:00.000Z", openedAtMs), "overdue", "past the instant it is overdue");
  expectEqual(dueStateOf("2026-11-07T10:00:00.000Z", "2026-11-07T08:00:00.000Z", openedAtMs), "resolved", "and a decided row is history");

  // -------------------------------------------------------------------------------------------
  // 3. Reading a Stripe delivery
  // -------------------------------------------------------------------------------------------
  const opened = readStripeDisputeEvent(stripeBody(), startedAtMs);

  expect(opened.ok, "a documented `charge.dispute.created` body reads");
  expect(opened.ok && opened.event.kind === "opened", "as an opening");
  expect(opened.ok && opened.event.status === "open", "which asks for `open`");
  expect(opened.ok && opened.event.processorDisputeId === "dp_dispute_0001", "naming the processor's dispute");
  expect(opened.ok && opened.event.paymentReference === "ch_dispute_0001", "and the charge it disputes");
  expect(opened.ok && opened.event.amountMinor === 200_000n, "with the amount in the platform's minor units");
  expect(opened.ok && opened.event.currency === "USD", "and the currency upper cased");
  expect(opened.ok && opened.event.reasonCode === "fraudulent", "and the processor's reason code");
  expect(opened.ok && opened.event.mode === "live", "and the mode from the provider's own flag");
  expect(opened.ok && opened.event.openedAtEpochMs === startedAtMs - 3_600_000, "and the processor's opening instant");
  expect(opened.ok && opened.event.eventType === "charge.dispute.created", "the provider's type is kept, not interpreted");
  expectEqual(STRIPE_DISPUTE_EVENT_PATTERN.test("evt_disputegate0001"), true, "the event id shape is the one that deduplicates");
  expectEqual(STRIPE_DISPUTE_EVENT_PATTERN.test("ev"), false, "a short id is not");

  const updated = readStripeDisputeEvent(stripeBody({ type: "charge.dispute.updated" }), startedAtMs);
  expect(updated.ok && updated.event.status === "under_review", "an update moves the row to `under_review`");
  expect(updated.ok && updated.event.outcomeNote === null, "and carries no outcome");

  const lostBody = readStripeDisputeEvent(stripeBody({ type: "charge.dispute.closed", status: "lost" }), startedAtMs);
  expect(lostBody.ok && lostBody.event.status === "lost", "a closed-`lost` dispute asks for `lost`");
  expect(
    lostBody.ok && lostBody.event.outcomeNote !== null && lostBody.event.outcomeNote.includes("lost"),
    "and names the outcome in a sentence the platform wrote",
  );
  expectEqual(stripeDisputeStatusOf("won"), "won", "`won` stays `won`");
  expectEqual(stripeDisputeStatusOf("warning_closed"), "closed", "and a warning close is a `closed`, not a loss");
  const warningBody = readStripeDisputeEvent(stripeBody({ type: "charge.dispute.closed", status: "warning_closed" }), startedAtMs);
  expect(warningBody.ok && warningBody.event.status === "closed", "which the reader applies");

  const withdrawn = readStripeDisputeEvent(stripeBody({ type: "charge.dispute.funds_withdrawn" }), startedAtMs);
  expect(withdrawn.ok && withdrawn.event.kind === "funds_withdrawn", "a withdrawal is recorded");
  expect(withdrawn.ok && withdrawn.event.status === null, "and asks for no status: the money is a ledger STEP's");

  const otherEvent = readStripeDisputeEvent(
    JSON.stringify({ id: "evt_payment0001", type: "payment_intent.succeeded", livemode: true, data: { object: {} } }),
    startedAtMs,
  );
  expect(otherEvent.ok && otherEvent.event.kind === "ignored", "a verified event of another type is `ignored`, not refused");
  expect(otherEvent.ok && otherEvent.event.processorDisputeId === null, "and names no dispute");

  const notJson = readStripeDisputeEvent("not json at all", startedAtMs);
  expect(!notJson.ok && notJson.rule === DISPUTE_RULES.bodyInvalid, "a body that is not JSON is refused");

  const noMode = readStripeDisputeEvent(
    JSON.stringify({ id: "evt_dispute0002", type: "charge.dispute.created", data: { object: {} } }),
    startedAtMs,
  );
  expect(!noMode.ok && noMode.rule === DISPUTE_RULES.bodyInvalid, "a body without the provider's mode flag is refused");

  const badId = readStripeDisputeEvent(stripeBody({ eventId: "not-an-event" }), startedAtMs);
  expect(!badId.ok && badId.rule === DISPUTE_RULES.eventIdInvalid, "an event id the platform cannot deduplicate on is refused");

  const brokenDispute = readStripeDisputeEvent(
    JSON.stringify({ id: "evt_dispute0003", type: "charge.dispute.created", livemode: true, data: { object: { id: "dp" } } }),
    startedAtMs,
  );
  expect(!brokenDispute.ok && brokenDispute.rule === DISPUTE_RULES.bodyInvalid, "a dispute object missing its amount is refused");

  const testMode = readStripeDisputeEvent(stripeBody({ livemode: false }), startedAtMs);
  expect(testMode.ok && testMode.event.mode === "test", "a sandbox delivery is `test`, from the provider's flag alone");

  // -------------------------------------------------------------------------------------------
  // 4. The signature, before anything is read
  // -------------------------------------------------------------------------------------------
  const harness = harnessOf();
  const body = stripeBody();
  const verified = await verifyProviderWebhookSignature(
    disputeEventSourceOf(STRIPE_CONNECT_PROVIDER_KEY) as NonNullable<ReturnType<typeof disputeEventSourceOf>>,
    { rawBody: body, headers: headersOf(body, nowSeconds(harness.fixture)) },
    harness.webhook,
  );
  expect(verified.ok, "a body signed with the endpoint's secret verifies");
  expect(!("secret" in verified), "and the secret is not handed back to the caller");

  const staleSignature = await verifyProviderWebhookSignature(
    disputeEventSourceOf(STRIPE_CONNECT_PROVIDER_KEY) as NonNullable<ReturnType<typeof disputeEventSourceOf>>,
    { rawBody: body, headers: headersOf(body, nowSeconds(harness.fixture) - 3_600) },
    harness.webhook,
  );
  expect(!staleSignature.ok && staleSignature.result.status === 401, "a signature an hour old is outside the tolerance");
  expect(
    !staleSignature.ok && staleSignature.result.body.rule === DISPUTE_RULES.signatureInvalid,
    "and is refused with the signature rule",
  );

  const emptySecret = harnessOf({}, { [STRIPE_DISPUTE_SECRET_SETTING]: null });
  const noSecret = await verifyProviderWebhookSignature(
    disputeEventSourceOf(STRIPE_CONNECT_PROVIDER_KEY) as NonNullable<ReturnType<typeof disputeEventSourceOf>>,
    { rawBody: body, headers: headersOf(body, nowSeconds(emptySecret.fixture)) },
    emptySecret.webhook,
  );
  expect(!noSecret.ok && noSecret.result.status === 503, "an endpoint with no secret answers `503` rather than trusting the body");
  expect(
    !noSecret.ok && noSecret.result.body.rule === DISPUTE_RULES.secretMissing,
    "with the rule that names the missing secret",
  );
  // The order of the receiver's steps, read off the source rather than trusted: the signature is checked
  // before the provider row is read, and the provider row is read before the event is recorded.
  const receiverSource = await readFile(new URL("./dispute-webhook.ts", import.meta.url), "utf8");
  const verifyAt = receiverSource.indexOf("await verifyProviderWebhookSignature(source, delivery, dependencies)");
  const providerAt = receiverSource.indexOf("await findDisputeProvider(dependencies, source.providerKey)");
  const recordAt = receiverSource.indexOf("await recordWebhookEvent(dependencies, providerId, event, rawBody)");
  expect(verifyAt > 0, "the receiver has one verification call");
  expect(verifyAt < providerAt, "and it runs before the database is read at all");
  expect(providerAt < recordAt, "so nothing is recorded before the provider row is known");
  expectEqual(disputePayloadHash("body").length, 64, "the payload hash is a SHA-256 hex digest");
  expectEqual(disputePayloadHash("body"), disputePayloadHash("body"), "of the bytes, so a retry of the same body matches");
  expect(disputePayloadHash("body") !== disputePayloadHash("bodY"), "and an edit does not");

  // -------------------------------------------------------------------------------------------
  // 5. One delivery, end to end
  // -------------------------------------------------------------------------------------------
  const first = await deliver(harness, stripeBody());
  expectEqual(first.status, 200, "a verified opening answers `200`");
  expect(first.status === 200 && first.body.outcome === "opened", "and says it opened a dispute");
  expectEqual(harness.fixture.disputes.length, 1, "one row was written");
  expectEqual(harness.fixture.events.length, 1, "and one event row");
  const openedRow = harness.fixture.disputes[0] as Row;
  expectEqual(openedRow["status"], "open", "the row is `open`");
  expectEqual(openedRow["company_id"], companyId, "under the payment's merchant");
  expectEqual(openedRow["amount_minor"], "200000", "for the disputed amount, in minor units");
  expectEqual(openedRow["fee_minor"], "0", "with the chargeback fee left to the STEP that owns it");
  expectEqual(openedRow["evidence_ready"], false, "with no evidence claimed");
  expectEqual(
    openedRow["opened_at"],
    new Date(startedAtMs - 3_600_000).toISOString(),
    "dated by the instant the processor opened it, not by the delivery's clock",
  );
  expectEqual(openedRow["response_window_hours"], 24, "in section 19's 24-hour window");
  expectEqual(
    Date.parse(String(openedRow["response_due_at"])) - Date.parse(String(openedRow["opened_at"])),
    24 * 3_600_000,
    "whose deadline is exactly one window after the opening",
  );
  expectEqual(openedRow["resolved_at"], null, "and no outcome");
  expectEqual(openedRow["version"], 1, "at version one");
  const firstEvent = harness.fixture.events[0] as Row;
  expectEqual(firstEvent["status"], "processed", "the event row is `processed`");
  expect(firstEvent["processed_at"] !== null, "with the instant it was");
  expectEqual(firstEvent["company_id"], companyId, "and the merchant it named once it knew it");
  expectEqual(firstEvent["mode"], "live", "the mode from the delivery");
  expectEqual(firstEvent["signature_ok"], true, "and the signature recorded as verified");
  expectEqual(firstEvent["external_event_id"], "evt_disputegate0001", "under the provider's own event id");
  expect(!JSON.stringify(firstEvent).includes("fraudulent"), "the body itself is never stored");
  expect(actionsOf(harness.audit).includes(DISPUTE_AUDIT.opened), "the chain records the opening");

  const duplicate = await deliver(harness, stripeBody());
  expectEqual(duplicate.status, 200, "the same delivery again answers `200`");
  expect(duplicate.status === 200 && duplicate.body.outcome === "duplicate", "as a duplicate");
  expectEqual(harness.fixture.disputes.length, 1, "and writes no second dispute");
  expectEqual(harness.fixture.events.length, 1, "nor a second event row");
  expect(actionsOf(harness.audit).includes(DISPUTE_AUDIT.ignored), "the chain records that it was dropped");

  harness.fixture.nowMs = startedAtMs + 60_000;
  const second = await deliver(harness, stripeBody({ eventId: "evt_disputegate0002", type: "charge.dispute.updated" }));
  expect(second.status === 200 && second.body.outcome === "moved", "a later delivery moves the row");
  expectEqual(harness.fixture.disputes.length, 1, "the same row, not a second one");
  expectEqual((harness.fixture.disputes[0] as Row)["status"], "under_review", "to `under_review`");
  expectEqual((harness.fixture.disputes[0] as Row)["version"], 2, "at the next version");
  expect(actionsOf(harness.audit).includes(DISPUTE_AUDIT.moved), "and the chain records the move");
  const movedPayload = harness.audit.entries.find((entry) => entry.action === DISPUTE_AUDIT.moved)?.payload ?? {};
  expectEqual(movedPayload["from"], "open", "the chain says what it moved from");
  expectEqual(movedPayload["to"], "under_review", "and what it moved to");

  const repeated = await deliver(harness, stripeBody({ eventId: "evt_disputegate0007", type: "charge.dispute.updated" }));
  expect(
    repeated.status === 200 && repeated.body.outcome === "ignored",
    "a second delivery of the status the row already has changes nothing",
  );
  expect(repeated.status === 200 && repeated.body.rule === DISPUTE_RULES.statusStale, "and says so");
  expectEqual((harness.fixture.disputes[0] as Row)["version"], 2, "so the version does not move");

  const replay = await deliver(harness, stripeBody({ eventId: "evt_disputegate0003" }));
  expect(replay.status === 200 && replay.body.outcome === "ignored", "a replayed opening is ignored rather than applied");
  expect(replay.status === 200 && replay.body.rule === DISPUTE_RULES.statusStale, "with the stale rule");
  expectEqual((harness.fixture.disputes[0] as Row)["status"], "under_review", "and the row does not go backwards");
  expectEqual((harness.fixture.disputes[0] as Row)["version"], 2, "at the version it had");

  const closed = await deliver(
    harness,
    stripeBody({ eventId: "evt_disputegate0004", type: "charge.dispute.closed", status: "lost" }),
  );
  expect(closed.status === 200 && closed.body.outcome === "moved", "the decision moves the row");
  expectEqual((harness.fixture.disputes[0] as Row)["status"], "lost", "to `lost`");
  expect((harness.fixture.disputes[0] as Row)["resolved_at"] !== null, "and stamps the instant it was decided");
  expect(
    typeof (harness.fixture.disputes[0] as Row)["outcome_note"] === "string" &&
      String((harness.fixture.disputes[0] as Row)["outcome_note"]).length > 0,
    "with an outcome note, which `0039` requires once resolved",
  );
  expectEqual(closed.status === 200 ? closed.body.disputeStatus : null, "lost", "and the answer names the decision");

  const afterDecision = await deliver(harness, stripeBody({ eventId: "evt_disputegate0005", type: "charge.dispute.updated" }));
  expect(
    afterDecision.status === 200 && afterDecision.body.outcome === "ignored",
    "a delivery after the decision is ignored",
  );
  expect(
    afterDecision.status === 200 && afterDecision.body.rule === DISPUTE_RULES.resolved,
    "with the rule that says the row is decided",
  );
  expectEqual((harness.fixture.disputes[0] as Row)["status"], "lost", "and the decision stands");

  // A delivery that does not verify writes nothing at all, not even an event row.
  const eventsBeforeForgery = harness.fixture.events.length;
  const unsigned = await deliver(harness, stripeBody({ eventId: "evt_disputegate0006" }), { signed: false });
  expectEqual(unsigned.status, 401, "a delivery that does not verify answers `401`");
  expectEqual(harness.fixture.events.length, eventsBeforeForgery, "and leaves no event row");
  expectEqual(harness.fixture.disputes.length, 1, "and no dispute");

  const unknownProvider = await deliver(harness, stripeBody(), { providerKey: "nmi" });
  expectEqual(unknownProvider.status, 404, "a provider this build receives no disputes from answers `404`");
  expect(
    unknownProvider.status === 404 && unknownProvider.body.rule === DISPUTE_RULES.providerUnsupported,
    "with the unsupported-provider rule",
  );

  const tooLarge = await deliver(harness, "x".repeat(1_048_577));
  expectEqual(tooLarge.status, 413, "a body past the ceiling is refused before anything parses it");

  const noSecrets = await deliver(emptySecret, stripeBody());
  expectEqual(noSecrets.status, 503, "a deployment with no secret refuses the delivery");

  // -------------------------------------------------------------------------------------------
  // 6. A payment the database does not have yet
  // -------------------------------------------------------------------------------------------
  const missingPayment = harnessOf();
  const unknownCharge = await deliver(
    missingPayment,
    stripeBody({ charge: "ch_never_recorded", eventId: "evt_disputegate0101" }),
  );
  expectEqual(unknownCharge.status, 500, "a verified dispute for an unknown payment answers `500`, so the processor retries");
  expectEqual(missingPayment.fixture.disputes.length, 0, "and writes no dispute");
  expectEqual((missingPayment.fixture.events[0] as Row)["status"], "failed", "the event row records the failure");
  expectEqual(
    (missingPayment.fixture.events[0] as Row)["failure_detail"],
    DISPUTE_RULES.paymentNotFound,
    "with the rule that names it",
  );

  // The capture lands, and the processor retries the same event: a `failed` row is reprocessed, not deduplicated.
  missingPayment.fixture.payments.push(
    paymentRow({ provider_id: missingPayment.providerId, provider_transaction_id: "ch_never_recorded" }),
  );
  const retried = await deliver(missingPayment, stripeBody({ charge: "ch_never_recorded", eventId: "evt_disputegate0101" }));
  expect(retried.status === 200 && retried.body.outcome === "opened", "the retry after the payment lands opens the dispute");
  expectEqual(missingPayment.fixture.disputes.length, 1, "which is now a row");
  expectEqual((missingPayment.fixture.events[0] as Row)["status"], "processed", "and the event row is settled `processed`");
  expectEqual(missingPayment.fixture.events.length, 1, "without a second event row");

  // -------------------------------------------------------------------------------------------
  // 7. Deliveries that are recorded and change nothing
  // -------------------------------------------------------------------------------------------
  const currencyMismatch = harnessOf({ currency: "EUR" });
  const mismatched = await deliver(currencyMismatch, stripeBody({ currency: "usd" }));
  expectEqual(mismatched.status, 200, "a delivery in another currency is acknowledged");
  expect(mismatched.status === 200 && mismatched.body.outcome === "unmatched", "as unmatched");
  expect(
    mismatched.status === 200 && mismatched.body.rule === DISPUTE_RULES.currencyMismatch,
    "with the currency rule",
  );
  expectEqual(currencyMismatch.fixture.disputes.length, 0, "and writes no dispute");

  const withdrawal = harnessOf();
  const withdrawnDelivery = await deliver(withdrawal, stripeBody({ type: "charge.dispute.funds_withdrawn" }));
  expect(withdrawnDelivery.status === 200 && withdrawnDelivery.body.outcome === "ignored", "a withdrawal is recorded as ignored");
  expectEqual(withdrawal.fixture.disputes.length, 0, "it opens no dispute");
  expectEqual((withdrawal.fixture.events[0] as Row)["status"], "ignored", "and the event row is `ignored`");
  expectEqual(withdrawal.audit.entries.at(-1)?.action, DISPUTE_AUDIT.ignored, "the chain says why");

  const foreignEvent = harnessOf();
  const otherType = await deliver(
    foreignEvent,
    JSON.stringify({ id: "evt_payment0009", type: "payment_intent.succeeded", livemode: true, data: { object: {} } }),
  );
  expect(otherType.status === 200 && otherType.body.outcome === "ignored", "an event of another type is acknowledged and ignored");
  expectEqual(foreignEvent.fixture.events.length, 1, "but still recorded");

  const noReference = harnessOf();
  const withoutCharge = await deliver(noReference, stripeBody({ charge: null, paymentIntent: null }));
  expect(withoutCharge.status === 200 && withoutCharge.body.outcome === "unmatched", "a dispute naming no payment is acknowledged");
  expectEqual(noReference.fixture.disputes.length, 0, "and writes nothing");

  // -------------------------------------------------------------------------------------------
  // 8. The read side
  // -------------------------------------------------------------------------------------------
  const reader = harnessOf();
  await deliver(reader, stripeBody());
  await deliver(reader, stripeBody({ eventId: "evt_disputegate0201", objectId: "dp_dispute_0002", charge: "ch_dispute_0001" }));

  const ownRows = await listCompanyDisputes({ actor: actorOf() }, reader.dependencies);
  expectEqual(ownRows.length, 2, "a merchant reads both of its disputes");
  expectEqual(ownRows[0]?.amountText, "20.0000 USD", "with the amount printed for a person");
  expect(ownRows[0]?.dueState === "open" || ownRows[0]?.dueState === "due_soon", "and the deadline state it is in");
  expectEqual(
    ownRows[0]?.openedAt.localeCompare(String(ownRows[1]?.openedAt)) ?? 1,
    0,
    "newest first, so the two openings of one instant keep one order",
  );
  await expectRefusal(
    () => listCompanyDisputes({ actor: officeActor("finance_ops") }, reader.dependencies),
    "PERMISSION_DENIED",
    "the office does not read a merchant's list through the merchant's route",
  );
  await expectRefusal(
    () => listCompanyDisputes({ actor: actorOf({ companyId: null, roles: ["owner"] }) }, reader.dependencies),
    "PERMISSION_DENIED",
    "and a role holding account without a company reads nothing",
  );

  const otherMerchantRows = await listCompanyDisputes(
    { actor: actorOf({ userId: otherOwnerUserId, companyId: otherCompanyId }) },
    reader.dependencies,
  );
  expectEqual(otherMerchantRows.length, 0, "another merchant reads none of them");

  const queue = await listDisputeQueue({ actor: officeActor("compliance_kyc") }, reader.dependencies);
  expectEqual(queue.length, 2, "the office queue lists every open dispute of every merchant");
  expect(queue.every((row) => row.resolvedAt === null), "and none that are decided");
  expect((queue[0]?.responseDueAt.localeCompare(String(queue[1]?.responseDueAt)) ?? 1) <= 0, "nearest deadline first");
  const officeRoles = ["ceo", "compliance_kyc", "finance_ops", "super_admin"] as const;

  expectEqual(officeRoles.join(","), DISPUTE_OFFICE_ROLES.join(","), "the four desks the service accepts are the four this gate tries");

  for (const role of officeRoles) {
    const rows = await listDisputeQueue({ actor: officeActor(role) }, reader.dependencies);
    expectEqual(rows.length, 2, `${role} reads the queue`);
  }
  await expectRefusal(
    () => listDisputeQueue({ actor: actorOf() }, reader.dependencies),
    "PERMISSION_DENIED",
    "the merchant role does not read the platform's queue",
  );

  await deliver(
    reader,
    stripeBody({ eventId: "evt_disputegate0202", type: "charge.dispute.closed", status: "won", objectId: "dp_dispute_0002" }),
  );
  const decidedQueue = await listDisputeQueue({ actor: officeActor("super_admin") }, reader.dependencies);
  expectEqual(decidedQueue.length, 1, "a decided dispute leaves the deadline queue");
  const decidedList = await listCompanyDisputes({ actor: actorOf() }, reader.dependencies);
  expectEqual(decidedList.length, 2, "but stays in the merchant's own list, as history");
  expectEqual(decidedList.filter((row) => row.dueState === "resolved").length, 1, "printed as decided");

  const view = disputeViewOf(
    {
      id: "018f2b8a-0000-7000-8000-000000000001",
      company_id: companyId,
      payment_id: reader.paymentId,
      processor_dispute_id: "dp_dispute_0001",
      status: "open",
      reason_code: "fraudulent",
      amount_minor: 200_000n,
      currency: "USD",
      fee_minor: 0n,
      opened_at: "2026-11-07T09:00:00.000Z",
      response_window_hours: 24,
      response_due_at: "2026-11-08T09:00:00.000Z",
      evidence_ready: false,
      submitted_at: null,
      resolved_at: null,
      outcome_note: null,
      created_at: "2026-11-07T09:00:00.000Z",
      updated_at: "2026-11-07T09:00:00.000Z",
      version: 1,
    },
    startedAtMs,
  );
  expectEqual(view.amountMinor, "200000", "the view prints the minor units as decimal text");
  expectEqual(view.dueState, "open", "and the deadline state");

  // -------------------------------------------------------------------------------------------
  // 9. What the chain holds
  // -------------------------------------------------------------------------------------------
  const merchantChain = await (async (): Promise<readonly (typeof reader.audit.entries)[number][]> => reader.audit.entries)();
  expect(
    merchantChain.every((entry) => entry.entityType === DISPUTE_AUDIT_ENTITY || entry.entityType === "webhook_event"),
    "every entry is under the dispute entity or the delivery that produced it",
  );
  expect(merchantChain.every((entry) => entry.actorUserId === null), "a delivery has no person behind it");
  expect(
    merchantChain.filter((entry) => entry.action === DISPUTE_AUDIT.opened).every((entry) => entry.companyId === companyId),
    "an opening is recorded on the merchant's own chain",
  );
  expect(
    merchantChain.filter((entry) => entry.action === DISPUTE_AUDIT.opened || entry.action === DISPUTE_AUDIT.moved).every((entry) => typeof entry.payload["webhook_event_id"] === "string"),
    "and names the delivery that caused it",
  );
  expect(
    merchantChain.every((entry) => {
      const serialized = JSON.stringify(entry.payload);

      return !serialized.includes("needs_response") && !serialized.includes("evidence_details") && !serialized.includes("signature");
    }),
    "no chain entry copies the provider's body, its status word, its evidence or the signature",
  );
  expect(merchantChain.every((entry) => entry.sessionId === null), "and none claims a session");

  // -------------------------------------------------------------------------------------------
  // 10. The wiring: two reads, one callback, and no migration
  // -------------------------------------------------------------------------------------------
  expectEqual(DISPUTE_EVENT_SOURCES.length, 1, "this build receives dispute deliveries from one provider");
  expectEqual(DISPUTE_EVENT_SOURCES[0]?.providerKey, STRIPE_CONNECT_PROVIDER_KEY, "and names it by its `payment_providers` key");
  expectEqual(DISPUTE_EVENT_SOURCES[0]?.webhookPath, "/api/webhooks/stripe/disputes", "at the documented path");
  expectEqual(DISPUTE_EVENT_SOURCES[0]?.secretSettingKey, "gateway.stripe_connect.webhook_secret", "with the platform's secret");
  expectEqual(disputeEventSourceOf("nmi"), null, "and knows no source for a provider whose disputes it cannot read");
  expectEqual(STRIPE_DISPUTE_WEBHOOK_PATH, "/api/webhooks/stripe/disputes", "the path is one string, used twice");
  expectEqual(STRIPE_SIGNATURE_HEADER, "stripe-signature", "the header the signature arrives in");

  const webhookRoute = await readFile(
    new URL("../../app/api/webhooks/stripe/disputes/route.ts", import.meta.url),
    "utf8",
  );
  const merchantRoute = await readFile(new URL("../../app/api/payments/disputes/route.ts", import.meta.url), "utf8");
  const officeRoute = await readFile(new URL("../../app/api/office/disputes/route.ts", import.meta.url), "utf8");
  expect(webhookRoute.includes("receiveDisputeWebhook"), "the callback route hands the delivery to the receiver");
  expect(!webhookRoute.includes("requireCsrfToken("), "and asks for no token a provider cannot hold");
  expect(webhookRoute.includes("request.text()"), "reading the raw body, because the signature is over the bytes");
  expect(!/=\s*await\s+request\.json\(/u.test(webhookRoute), "and never the parsed one");
  expect(merchantRoute.includes("listCompanyDisputes"), "the merchant route reads the merchant's list");
  expect(officeRoute.includes("listDisputeQueue"), "and the office route the queue");
  expect(!merchantRoute.includes("export const POST"), "neither read route writes");
  expect(!officeRoute.includes("export const POST"), "on any verb");

  const disputeSource = await readFile(new URL("./dispute.ts", import.meta.url), "utf8");
  expect(!/rest\.(insert|insertReturning|update)\("payments"/u.test(disputeSource), "the service never writes a payment");
  expect(!/(?:rest\.rpc\(|postLedgerEntry|ledgerEntries|ledgerEntry)/u.test(disputeSource), "and posts nothing to the ledger");
  expect(!disputeSource.includes("fee_minor: ") || disputeSource.includes('fee_minor: "0"'), "the chargeback fee is written only as the column's default");

  const merchantPage = await readFile(new URL("../../app/(dashboard)/payments/disputes/page.tsx", import.meta.url), "utf8");
  const officePage = await readFile(new URL("../../app/(admin)/office/disputes/page.tsx", import.meta.url), "utf8");
  expect(merchantPage.includes("listCompanyDisputes"), "the merchant screen reads through the service");
  expect(officePage.includes("listDisputeQueue"), "and the office screen through the same one");
  expect(!merchantPage.includes('"use client"'), "the list screen has nothing to do, so it has no client component");
  expect(officePage.includes("officeRoleRefusedBody"), "and a refusal is a sentence, not an empty table");

  // The layout contract of the two screens: one column at 360 and a two-column definition list at 1440,
  // a header that wraps rather than overflows, and long processor identifiers that break instead of pushing
  // the page sideways - the three ways a card like this one breaks on a phone.
  for (const [name, source] of [
    ["the merchant screen", merchantPage],
    ["the office screen", officePage],
  ] as const) {
    expect(source.includes("flex flex-col gap-8"), `${name} stacks its sections in one column on a phone`);
    expect(source.includes("grid-cols-1 gap-1 text-sm sm:grid-cols-[12rem_1fr]"), `${name} is a list of terms on a phone and two columns from the small breakpoint`);
    expect(source.includes("flex flex-wrap items-center gap-x-3 gap-y-1"), `${name} lets its badges wrap rather than overflow`);
    expect(source.includes('className="break-words text-xs tabular-nums sm:text-sm"'), `${name} breaks a long identifier instead of widening the page`);
    expect(!/className="[^"]*\bw-\[/u.test(source), `${name} sizes nothing in pixels`);
  }

  const english = await readFile(new URL("../../lib/i18n/strings/en.ts", import.meta.url), "utf8");
  const usedKeys = new Set<string>();

  for (const source of [merchantPage, officePage]) {
    for (const match of source.matchAll(/getMessage\("(disputes\.[a-zA-Z]+)"\)/gu)) {
      if (typeof match[1] === "string") {
        usedKeys.add(match[1]);
      }
    }
  }

  expect(usedKeys.size >= 20, "the two screens use the dispute vocabulary rather than hard-coded prose");

  for (const key of usedKeys) {
    const leaf = key.slice("disputes.".length);

    expect(new RegExp(`\\n\\s{4}${leaf}:`, "u").test(english), `the catalog carries ${key}`);
  }

  expect(english.includes("\n  disputes: {"), "and carries the group itself");

  const migrations = (await readdir(new URL("../../migrations/", import.meta.url)))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);

  expectEqual(
    migrations[migrations.length - 1] ?? 0,
    123,
    "this STEP adds no migration: `0039` already carries the dispute and `0032` the delivery",
  );
  expectEqual(harness.fixture.disputes.length, 1, "and the fixture closed with one row, as the deliveries said");

  if (failures.length > 0) {
    process.stdout.write(`dispute gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stdout.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `dispute gate passed: ${String(checkCount)} checks, a dispute opened by a verified delivery and by nothing else, one row per processor dispute, a status that only moves forward, a decided dispute that stays decided, a failed delivery a redelivery can finish, the merchant's own list and the office deadline queue, every act in the chain, no payment write and no migration needed\n`,
  );
}

await main();
