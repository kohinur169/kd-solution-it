// path: services/disputes/dispute-submission-verify.ts
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { en } from "../../lib/i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../../lib/security/csrf.ts";
import {
  SUBMITTING_PROVIDER_KEYS,
  submissionPortFor,
  type DisputeSubmissionOutcome,
  type DisputeSubmissionPort,
} from "./dispute-submission-provider.ts";
import {
  DISPUTE_SUBMISSION_FIELD,
  DISPUTE_SUBMISSION_RULES,
  DISPUTE_SUBMISSION_TEMPLATE_KEY,
  isDisputeReviewDecision,
  isDisputeSubmissionChannel,
} from "./dispute-submission-fields.ts";
import {
  listReviewQueue,
  parseReviewBody,
  parseSubmissionBody,
  readDisputeReview,
  reviewDisputePack,
  submitDisputePack,
  type DisputeSubmissionDependencies,
} from "./dispute-submission.ts";

/**
 * The gate for STEP 198: the compliance review, and the evidence pack on its way to the processor.
 *
 * ## What this proves
 *
 *   - **A review is a decision, not an edit.** One named officer, one of two words, a reason, the digest of the
 *     evidence reviewed - and `0127` refuses every rewrite and every delete, so a declined pack stays declined on
 *     the record while a later approval is a second row rather than a change of mind about the first.
 *   - **Nothing is sent without an approval.** The service checks the latest decision and `0127`'s submission
 *     guard reads the reviews table itself, so a caller that skipped the service cannot send unreviewed evidence.
 *   - **One attempt, claimed before the call.** The row is inserted first, which is what makes two officers
 *     pressing at once a refusal rather than two submissions; a failed attempt frees the pack, because a
 *     processor outage is not a reason to leave a merchant unanswered.
 *   - **`evidence_submitted` means what section 19 says.** The status is only reachable through a *sent*
 *     submission row carrying a frozen pack, and it never goes back to waiting.
 *   - **The two channels are one record.** The provider channel (the platform calling the processor) and the
 *     recorded channel (the desk sending from the processor's portal) write the same row, move the same status and
 *     leave the same audit trail; this build has no documented dispute API, so the registry is empty and the
 *     provider channel refuses with a rule the screen prints.
 *   - **One desk, one tenant.** `compliance_kyc` and `super_admin` review and send, with a satisfied second factor;
 *     the finance desk, support, the merchant and an anonymous session do not.
 *
 * ## How
 *
 * An in-memory PostgREST over arrays, carrying `0127`'s three trigger bodies, its four checks and its two partial
 * unique indexes - so a service that skipped its own guard would still fail here. The provider channel is proven
 * against an injected port, which is the same function an adapter would be.
 */

let checkCount = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(Object.is(actual, expected), `${description} (expected ${String(expected)}, got ${String(actual)})`);
}

async function expectRefusal(run: () => Promise<unknown>, code: string, description: string): Promise<void> {
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

/** The rule of the last refusal, so a test can assert which sentence an officer is told. */
async function refusalRuleOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    if (!isAppError(error)) {
      return "not-an-app-error";
    }

    return error.details[0]?.rule ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture: a PostgREST over arrays, with `0127`'s guards on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const reviewerUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const financeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const disputeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherDisputeId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const paymentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const providerId = "17171717-1717-4717-8717-171717171717";
const packId = "c0000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const openedAt = "2026-11-01T09:00:00.000Z";
const openedAtMs = Date.parse(openedAt);
const dueAt = "2026-11-02T09:00:00.000Z";
const frozenAt = "2026-11-01T15:00:00.000Z";

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: reviewerUserId,
    companyId: null,
    roles: ["compliance_kyc"] as readonly PlatformRole[],
    sessionId: "session-0001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: openedAtMs - 60_000,
    expiresAtEpochMs: openedAtMs + 86_400_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

function financeActor(): RequestActor {
  return actorOf({ userId: financeUserId, roles: ["finance_ops"] as readonly PlatformRole[] });
}

function disputeRow(overrides: {
  readonly id?: string;
  readonly companyId?: string;
  readonly status?: string;
  readonly resolvedAt?: string | null;
  readonly submittedAt?: string | null;
  readonly dueAtValue?: string;
  readonly version?: number;
} = {}): Row {
  const resolved = overrides.resolvedAt ?? null;

  return {
    id: overrides.id ?? disputeId,
    company_id: overrides.companyId ?? companyId,
    payment_id: paymentId,
    processor_dispute_id: "dp_0001",
    status: overrides.status ?? (resolved === null ? "under_review" : "won"),
    reason_code: "fraudulent",
    amount_minor: 12_000,
    currency: "USD",
    fee_minor: 0,
    opened_at: openedAt,
    response_window_hours: 24,
    response_due_at: overrides.dueAtValue ?? dueAt,
    evidence_ready: true,
    response_text: "The buyer signed for it.",
    response_saved_at: openedAt,
    submitted_at: overrides.submittedAt ?? null,
    resolved_at: resolved,
    outcome_note: resolved === null ? null : "won on the pack",
    created_at: openedAt,
    updated_at: openedAt,
    deleted_at: null,
    version: overrides.version ?? 2,
  };
}

function packRow(overrides: { readonly status?: string; readonly dispute?: string; readonly company?: string } = {}): Row {
  const status = overrides.status ?? "frozen";

  return {
    id: packId,
    company_id: overrides.company ?? companyId,
    dispute_id: overrides.dispute ?? disputeId,
    status,
    digest: status === "frozen" ? digest : null,
    item_count: 4,
    document_count: 1,
    frozen_at: status === "frozen" ? frozenAt : null,
    built_by_user_id: ownerUserId,
    created_at: openedAt,
    updated_at: frozenAt,
    deleted_at: null,
    version: status === "frozen" ? 2 : 1,
  };
}

function itemRow(id: string, section: string): Row {
  return {
    id,
    company_id: companyId,
    pack_id: packId,
    section,
    source_kind: "note",
    source_id: null,
    label: `A ${section} record`,
    summary: null,
    captured_at: openedAt,
    created_at: openedAt,
    updated_at: openedAt,
    deleted_at: null,
    version: 1,
  };
}

function documentRow(id: string, section: string): Row {
  return {
    id,
    company_id: companyId,
    pack_id: packId,
    section,
    file_name: "invoice.pdf",
    content_type: "application/pdf",
    byte_size: 4096,
    caption: null,
    content_sha256: "b".repeat(64),
    storage_key: "evidence/invoice.pdf",
    file_id: "18181818-1818-4818-8818-181818181818",
    added_by_user_id: ownerUserId,
    added_at: openedAt,
    created_at: openedAt,
    updated_at: openedAt,
    deleted_at: null,
    version: 1,
  };
}

interface Fixture {
  readonly rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly disputes: Row[];
  readonly packs: Row[];
  readonly items: Row[];
  readonly documents: Row[];
  readonly payments: Row[];
  readonly providers: Row[];
  readonly reviews: Row[];
  readonly submissions: Row[];
  readonly sends: Row[];
  readonly emailSettings: Row[];
  readonly roleAssignments: Row[];
  readonly users: Row[];
  readonly companies: Row[];
  readonly written: string[];
  /** When true, the disputes update lands nowhere: the same lost write STEP 197's gate simulates. */
  loseDisputeUpdate: boolean;
  /** The port this fixture answers the provider channel with, if any. */
  port?: DisputeSubmissionPort;
  nowMs: number;
}

interface OrderTerm {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

interface Query {
  readonly equals: Map<string, string>;
  readonly lists: Map<string, readonly string[]>;
  readonly nulls: Set<string>;
  readonly notNulls: Set<string>;
  readonly order: readonly OrderTerm[];
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const lists = new Map<string, readonly string[]>();
  const nulls = new Set<string>();
  const notNulls = new Set<string>();
  const order: OrderTerm[] = [];
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
      for (const term of value.split(",")) {
        const [column = "", direction = "asc"] = term.split(".");

        order.push({ column, direction: direction === "desc" ? "desc" : "asc" });
      }

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

    if (value === "not.is.null") {
      notNulls.add(key);
      continue;
    }

    if (value.startsWith("in.(") && value.endsWith(")")) {
      lists.set(
        key,
        value
          .slice(4, -1)
          .split(",")
          .map((item) => decodeURIComponent(item)),
      );
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, lists, nulls, notNulls, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const [column, values] of query.lists) {
    if (!values.includes(String(row[column]))) {
      return false;
    }
  }

  for (const column of query.nulls) {
    if (row[column] !== null && row[column] !== undefined) {
      return false;
    }
  }

  for (const column of query.notNulls) {
    if (row[column] === null || row[column] === undefined) {
      return false;
    }
  }

  return true;
}

function sortRows(rows: readonly Row[], order: readonly OrderTerm[]): Row[] {
  if (order.length === 0) {
    return [...rows];
  }

  return [...rows].sort((left, right) => {
    for (const term of order) {
      const a = String(left[term.column] ?? "");
      const b = String(right[term.column] ?? "");
      const comparison = a.localeCompare(b);

      if (comparison !== 0) {
        return term.direction === "desc" ? -comparison : comparison;
      }
    }

    return 0;
  });
}

function conflictGuard(field: string, rule: string): never {
  throw new AppError("CONFLICT", { details: [{ field, rule }] });
}

function validationGuard(field: string, rule: string): never {
  throw new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/** `0127`'s `dispute_reviews_guard`, including the append-only rule it states first. */
function guardReviewInsert(fixture: Fixture, row: Row): void {
  const pack = fixture.packs.find((candidate) => candidate["id"] === row["pack_id"] && candidate["deleted_at"] === null);

  if (pack === undefined) {
    validationGuard("pack_id", "dispute_reviews_pack_fkey");
  }

  if (pack["status"] !== "frozen") {
    validationGuard("pack_id", "dispute_reviews_guard");
  }

  if (pack["dispute_id"] !== row["dispute_id"] || pack["company_id"] !== row["company_id"]) {
    validationGuard("dispute_id", "dispute_reviews_guard");
  }

  if (pack["digest"] === null || pack["digest"] !== row["pack_digest"]) {
    validationGuard("pack_digest", "dispute_reviews_guard");
  }

  const dispute = fixture.disputes.find((candidate) => candidate["id"] === row["dispute_id"]);

  if (dispute === undefined || dispute["company_id"] !== row["company_id"]) {
    validationGuard("dispute_id", "dispute_reviews_guard");
  }

  if (dispute["resolved_at"] !== null) {
    validationGuard("dispute_id", "dispute_reviews_guard");
  }

  if (liveSubmissionOf(fixture, String(row["pack_id"])) !== null) {
    conflictGuard("pack_id", "dispute_reviews_guard");
  }

  if (!isDisputeReviewDecision(row["decision"])) {
    validationGuard("decision", "dispute_reviews_decision_check");
  }

  const note = String(row["note"] ?? "");

  if (note.length === 0 || note.length > 500 || note !== note.trim()) {
    validationGuard("note", "dispute_reviews_note_check");
  }

  if (typeof row["pack_digest"] !== "string" || !/^[0-9a-f]{64}$/u.test(row["pack_digest"])) {
    validationGuard("pack_digest", "dispute_reviews_digest_check");
  }
}

/** The live attempt for one pack, as the partial unique index sees it. */
function liveSubmissionOf(fixture: Fixture, pack: string): Row | null {
  return (
    fixture.submissions.find(
      (row) => row["pack_id"] === pack && row["deleted_at"] === null && (row["status"] === "sending" || row["status"] === "sent"),
    ) ?? null
  );
}

/** The latest decision on one pack, which is the one `0127`'s submission guard reads. */
function latestDecisionOf(fixture: Fixture, pack: string): string | null {
  // `0127`'s guard orders `decided_at desc, id desc`, so two decisions in one millisecond still have a latest.
  const reviews = fixture.reviews.filter((row) => row["pack_id"] === pack).sort((left, right) => {
    const byInstant = String(right["decided_at"]).localeCompare(String(left["decided_at"]));

    return byInstant === 0 ? String(right["id"]).localeCompare(String(left["id"])) : byInstant;
  });

  return reviews[0]?.["decision"] === undefined ? null : String(reviews[0]["decision"]);
}

/** `0127`'s `dispute_submissions_guard`, on the claim and on the one transition a row has. */
function guardSubmissionInsert(fixture: Fixture, row: Row): void {
  const pack = fixture.packs.find((candidate) => candidate["id"] === row["pack_id"] && candidate["deleted_at"] === null);

  if (pack === undefined) {
    validationGuard("pack_id", "dispute_submissions_pack_fkey");
  }

  if (pack["status"] !== "frozen") {
    validationGuard("pack_id", "dispute_submissions_guard");
  }

  if (pack["dispute_id"] !== row["dispute_id"] || pack["company_id"] !== row["company_id"]) {
    validationGuard("dispute_id", "dispute_submissions_guard");
  }

  if (pack["digest"] !== row["pack_digest"]) {
    validationGuard("pack_digest", "dispute_submissions_guard");
  }

  if (pack["item_count"] !== row["item_count"] || pack["document_count"] !== row["document_count"]) {
    validationGuard("item_count", "dispute_submissions_guard");
  }

  const dispute = fixture.disputes.find((candidate) => candidate["id"] === row["dispute_id"]);

  if (dispute === undefined || dispute["company_id"] !== row["company_id"]) {
    validationGuard("dispute_id", "dispute_submissions_guard");
  }

  if (dispute["resolved_at"] !== null) {
    validationGuard("dispute_id", "dispute_submissions_guard");
  }

  if (dispute["status"] !== "open" && dispute["status"] !== "under_review") {
    validationGuard("status", "dispute_submissions_guard");
  }

  if (latestDecisionOf(fixture, String(row["pack_id"])) !== "approved") {
    validationGuard("pack_id", "dispute_submissions_guard");
  }

  if (!isDisputeSubmissionChannel(row["channel"])) {
    validationGuard("channel", "dispute_submissions_channel_check");
  }

  if (liveSubmissionOf(fixture, String(row["pack_id"])) !== null) {
    conflictGuard("pack_id", "dispute_submissions_pack_key");
  }

  const sameDispute = fixture.submissions.find(
    (candidate) =>
      candidate["dispute_id"] === row["dispute_id"] &&
      candidate["deleted_at"] === null &&
      (candidate["status"] === "sending" || candidate["status"] === "sent"),
  );

  if (sameDispute !== undefined) {
    conflictGuard("dispute_id", "dispute_submissions_dispute_key");
  }

  if (row["status"] !== "sending") {
    validationGuard("status", "dispute_submissions_sent_check");
  }
}

function guardSubmissionUpdate(fixture: Fixture, row: Row, values: Row): void {
  const pack = fixture.packs.find((candidate) => candidate["id"] === row["pack_id"]);

  if (pack === undefined || pack["status"] !== "frozen" || pack["digest"] !== row["pack_digest"]) {
    validationGuard("pack_id", "dispute_submissions_guard");
  }

  if (row["status"] !== "sending") {
    validationGuard("status", "dispute_submissions_guard");
  }

  if (values["status"] === "sending") {
    validationGuard("status", "dispute_submissions_guard");
  }

  for (const column of ["pack_id", "dispute_id", "company_id", "channel", "provider_key", "mode", "pack_digest"]) {
    if (values[column] !== undefined && values[column] !== row[column]) {
      validationGuard(column, "dispute_submissions_guard");
    }
  }

  if (values["status"] === "sent" && (values["sent_at"] === undefined || values["processor_reference"] === undefined)) {
    validationGuard("status", "dispute_submissions_sent_check");
  }

  if (values["status"] === "failed" && values["failure_rule"] === undefined) {
    validationGuard("status", "dispute_submissions_failed_check");
  }
}

/** `0127`'s `disputes_guard_submission`, on the row `0039` already owns. */
function guardDisputeUpdate(fixture: Fixture, row: Row, values: Row): void {
  const nextStatus = values["status"] === undefined ? row["status"] : values["status"];
  const nextSubmitted = values["submitted_at"] === undefined ? row["submitted_at"] : values["submitted_at"];

  if (row["status"] === "evidence_submitted" && (nextStatus === "open" || nextStatus === "under_review")) {
    validationGuard("status", "disputes_guard_submission");
  }

  if (nextStatus !== "evidence_submitted" && nextSubmitted === null) {
    return;
  }

  if (nextSubmitted === null) {
    validationGuard("submitted_at", "disputes_guard_submission");
  }

  const sent = fixture.submissions.some(
    (candidate) =>
      candidate["dispute_id"] === row["id"] &&
      candidate["company_id"] === row["company_id"] &&
      candidate["status"] === "sent" &&
      candidate["deleted_at"] === null,
  );

  if (!sent) {
    validationGuard("status", "disputes_guard_submission");
  }
}

function createFixture(
  input: {
    readonly packStatus?: string;
    readonly dispute?: Partial<Parameters<typeof disputeRow>[0]>;
    readonly noPack?: boolean;
    readonly providerKey?: string | null;
    readonly withItems?: boolean;
    readonly port?: DisputeSubmissionOutcome;
  } = {},
): Fixture {
  const tables: Partial<Fixture> = {};
  const holder = (): Fixture => tables as Fixture;
  let counter = 0;

  const table = (name: string): Row[] => {
    switch (name) {
      case "disputes":
        return holder().disputes;
      case "dispute_evidence_packs":
        return holder().packs;
      case "dispute_evidence_items":
        return holder().items;
      case "dispute_evidence_documents":
        return holder().documents;
      case "payments":
        return holder().payments;
      case "payment_providers":
        return holder().providers;
      case "dispute_reviews":
        return holder().reviews;
      case "dispute_submissions":
        return holder().submissions;
      case "email_send_logs":
        return holder().sends;
      case "email_settings":
        return holder().emailSettings;
      case "role_assignments":
        return holder().roleAssignments;
      case "users":
        return holder().users;
      case "companies":
        return holder().companies;
      default:
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table", name } });
    }
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      let rows = table(name).filter((row) => matches(row, parsed));

      rows = sortRows(rows, parsed.order);

      if (parsed.limit !== null) {
        rows = rows.slice(0, parsed.limit);
      }

      return schema.array().parse(rows.map((row) => ({ ...row })));
    },

    async insert(name: string, rows: readonly Row[]): Promise<void> {
      holder().written.push(name);

      for (const row of rows) {
        counter += 1;

        if (name === "dispute_reviews") {
          guardReviewInsert(holder(), row);
          holder().reviews.push({
            id: `f0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            created_at: new Date(holder().nowMs).toISOString(),
            updated_at: new Date(holder().nowMs).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "dispute_submissions") {
          guardSubmissionInsert(holder(), row);
          holder().submissions.push({
            id: `e0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            processor_reference: null,
            failure_rule: null,
            note: null,
            sent_at: null,
            created_at: new Date(holder().nowMs).toISOString(),
            updated_at: new Date(holder().nowMs).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "email_send_logs") {
          holder().sends.push({
            id: `d0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            status: "queued",
            ...row,
          });
          continue;
        }

        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_insert", name } });
      }
    },

    async insertReturning<TRow>(name: string, rows: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      await this.insert(name, rows);

      return schema.array().parse(table(name).slice(-rows.length).map((row) => ({ ...row })));
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      holder().written.push(name);

      const parsed = parseQuery(query);

      for (const row of table(name)) {
        if (!matches(row, parsed)) {
          continue;
        }

        if (name === "dispute_submissions") {
          guardSubmissionUpdate(holder(), row, values);
        }

        if (name === "disputes") {
          guardDisputeUpdate(holder(), row, values);

          if (holder().loseDisputeUpdate) {
            continue;
          }
        }

        Object.assign(row, values);

        if (typeof row["version"] === "number") {
          row["version"] += 1;
        }

        row["updated_at"] = new Date(holder().nowMs).toISOString();
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "no_rpc" } });
    },
  };

  Object.assign(tables, {
    rest,
    audit: createInMemoryAuditTrail(),
    disputes: [disputeRow(input.dispute ?? {})],
    packs: input.noPack === true ? [] : [packRow({ status: input.packStatus ?? "frozen" })],
    items:
      input.withItems === false
        ? []
        : [
            itemRow("11111111-1111-4111-8111-111111110001", "invoice"),
            itemRow("11111111-1111-4111-8111-111111110002", "delivery"),
            itemRow("11111111-1111-4111-8111-111111110003", "communication"),
            itemRow("11111111-1111-4111-8111-111111110004", "terms"),
          ],
    documents: input.withItems === false ? [] : [documentRow("11111111-1111-4111-8111-111111110005", "invoice")],
    payments: [
      {
        id: paymentId,
        company_id: companyId,
        provider_id: providerId,
        mode: "test",
        provider_transaction_id: "tx_0001",
        amount_minor: 12_000,
        currency: "USD",
        status: "settled",
        deleted_at: null,
      },
    ],
    providers: [
      {
        id: providerId,
        provider_key: input.providerKey === undefined ? "stripe_connect" : (input.providerKey ?? "stripe_connect"),
        status: "active",
      },
    ],
    reviews: [],
    submissions: [],
    sends: [],
    emailSettings: [{ id: "22222222-2222-4222-8222-222222220001", method: "smtp", status: "active", deleted_at: null }],
    roleAssignments: [
      { id: "33333333-3333-4333-8333-333333330001", company_id: companyId, user_id: ownerUserId, role: "owner", granted_at: openedAt, revoked_at: null, deleted_at: null },
    ],
    users: [{ id: ownerUserId, email: "owner@example.com", deleted_at: null }],
    companies: [{ id: companyId, name: "Northwind Studio" }],
    written: [],
    loseDisputeUpdate: false,
    port: input.port === undefined ? undefined : portOf(input.port),
    nowMs: Date.parse("2026-11-01T16:00:00.000Z"),
  });

  return holder();
}

/** A port that always answers the same way: the function an adapter would be. */
function portOf(outcome: DisputeSubmissionOutcome): DisputeSubmissionPort {
  return async (): Promise<DisputeSubmissionOutcome> => outcome;
}

/** The dependencies a test passes: the fixture, plus whatever port it wants the registry to hold. */
function dependenciesOf(fixture: Fixture, port?: DisputeSubmissionPort): DisputeSubmissionDependencies {
  const chosen = port ?? fixture.port;

  return {
    rest: fixture.rest,
    audit: fixture.audit,
    ports: chosen === undefined ? {} : { stripe_connect: chosen },
    now: (): number => fixture.nowMs,
  };
}

/** A fixture with one approved review, which is the state a submission starts from. */
async function approvedFixture(outcome?: DisputeSubmissionOutcome): Promise<Fixture> {
  const fixture = outcome === undefined ? createFixture() : createFixture({ port: outcome });

  await reviewDisputePack(
    { actor: actorOf(), disputeId, body: { decision: "approved", note: "Invoice, tracking and the acceptance all match." } },
    dependenciesOf(fixture),
  );

  return fixture;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

const root = new URL("../../", import.meta.url).pathname;
const migrationsDirectory = `${root}migrations`;

async function sourceOf(path: string): Promise<string> {
  return readFile(`${root}${path}`, "utf8");
}

function expectSourceContains(source: string, needle: string, description: string): void {
  expect(source.includes(needle), `${description} (missing ${JSON.stringify(needle.slice(0, 80))})`);
}

function expectSourceLacks(source: string, needle: string, description: string): void {
  expect(!source.includes(needle), `${description} (found ${JSON.stringify(needle.slice(0, 80))})`);
}

// ---------------------------------------------------------------------------------------------
// 1. The migration and its rollback
// ---------------------------------------------------------------------------------------------

const upstream = await readFile(`${migrationsDirectory}/0127_dispute_reviews_and_submissions.sql`, "utf8");
const rollback = await readFile(`${migrationsDirectory}/0127_dispute_reviews_and_submissions.down.sql`, "utf8");

expect(upstream.startsWith("-- path: migrations/0127_dispute_reviews_and_submissions.sql"), "0127 names its own path");
expect(rollback.startsWith("-- path: migrations/0127_dispute_reviews_and_submissions.down.sql"), "the rollback names its own path");
expect(upstream.trimStart().startsWith("-- path:"), "and so does the forward file before anything else");
expectSourceContains(upstream, "begin;", "the forward file is one transaction");
expectSourceContains(upstream, "commit;", "and commits once");
expectSourceContains(rollback, "begin;", "the rollback is one transaction");
expectSourceContains(rollback, "commit;", "and commits once");

for (const table of ["dispute_reviews", "dispute_submissions"]) {
  expectSourceContains(upstream, `create table public.${table} (`, `${table} is created`);
  expectSourceContains(upstream, `alter table public.${table} enable row level security;`, `${table} has row level security`);
  expectSourceContains(upstream, `${table}_default_deny`, `${table} is default deny`);
  expectSourceContains(upstream, `comment on table public.${table} is`, `${table} carries a comment`);
  expectSourceContains(upstream, `create index ${table}`, `${table} has its lookup index`);
  expectSourceContains(rollback, `drop table if exists public.${table};`, `and the rollback drops ${table}`);
}

expectSourceContains(upstream, "constraint dispute_reviews_decision_check check (decision in ('approved', 'declined'))", "a decision is one of two words");
expectSourceContains(upstream, "constraint dispute_reviews_note_check check (", "a reason is bounded");
expectSourceContains(upstream, "char_length(note) between 1 and 500", "and between one and five hundred characters");
expectSourceContains(upstream, "constraint dispute_reviews_digest_check check (pack_digest ~ '^[0-9a-f]{64}$')", "a review names the digest it reviewed");
expectSourceContains(upstream, "constraint dispute_submissions_channel_check check (channel in ('provider', 'recorded'))", "a channel is one of two");
expectSourceContains(upstream, "constraint dispute_submissions_status_check check (status in ('sending', 'sent', 'failed'))", "an attempt is one of three states");
expectSourceContains(upstream, "(status = 'sent') = (sent_at is not null and processor_reference is not null)", "a sent row has an instant and a reference");
expectSourceContains(upstream, "(status = 'failed') = (failure_rule is not null)", "a failed row names its rule");
expectSourceContains(upstream, "create unique index dispute_submissions_pack_key", "one live attempt per pack");
expectSourceContains(upstream, "where deleted_at is null and status in ('sending', 'sent');", "and a failed attempt frees the pack");
expectSourceContains(upstream, "create unique index dispute_submissions_dispute_key", "one live attempt per dispute as well");

expectSourceContains(upstream, "create function public.dispute_reviews_guard()", "the review has a guard");
expectSourceContains(upstream, "raise exception 'a compliance decision is append only'", "and it refuses every later write");
expectSourceContains(upstream, "raise exception 'a pack that has been sent to the processor cannot be reviewed again'", "a sent pack is not reviewed again");
expectSourceContains(upstream, "create function public.dispute_submissions_guard()", "the submission has a guard");
expectSourceContains(upstream, "raise exception 'the compliance desk approves the evidence pack before it is sent'", "which requires the approval itself");
expectSourceContains(upstream, "if latest_decision is distinct from 'approved' then", "and refuses on the *latest* decision, not on any approval ever given");
expectSourceContains(
  upstream,
  "from public.dispute_reviews as reviews\n   where reviews.pack_id = new.pack_id\n   order by reviews.decided_at desc, reviews.id desc",
  "reading the reviews table itself, newest first, which is what makes a later decline block the send",
);
expectSourceContains(
  upstream,
  "where submissions.dispute_id = new.id\n       and submissions.company_id = new.company_id\n       and submissions.status = 'sent'",
  "and the status is true only while a sent submission of that merchant's dispute exists",
);
expectSourceContains(upstream, "raise exception 'only a frozen evidence pack can be submitted'", "and frozen evidence only");
expectSourceContains(upstream, "raise exception 'a submission attempt keeps the facts it was claimed with'", "and keeps what it was claimed with");
expectSourceContains(upstream, "create function public.disputes_guard_submission()", "the status has a guard");
expectSourceContains(upstream, "raise exception 'a dispute is evidence submitted only when a sent submission carries its pack'", "which is what makes the status true");
expectSourceContains(upstream, "raise exception 'a dispute whose evidence has been sent does not go back to waiting'", "and never moves back");
expectSourceContains(upstream, "create trigger dispute_reviews_guard", "the review guard is a trigger");
expectSourceContains(upstream, "create trigger dispute_submissions_guard", "the submission guard is a trigger");
expectSourceContains(upstream, "create trigger disputes_guard_submission", "the status guard is a trigger");

expectSourceContains(rollback, "drop trigger if exists disputes_guard_submission on public.disputes;", "the rollback drops the status trigger first");
expectSourceContains(rollback, "drop function if exists public.dispute_reviews_guard();", "and the functions last");
expect(
  rollback.indexOf("drop trigger if exists disputes_guard_submission") < rollback.indexOf("drop table if exists public.dispute_submissions;"),
  "triggers before tables, so nothing references a dropped table",
);

const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
const numbers = [
  ...new Set(
    migrationFiles
      .map((name) => Number.parseInt(name.slice(0, 4), 10))
      .filter((number) => Number.isFinite(number)),
  ),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "0128 is the newest migration in the chain");
expectEqual(numbers.length, 128, "and the chain is 128 files");

// `0059`-`0061` are the email STEPs' and gain nothing here.
for (const file of ["0059_email_settings.sql", "0060_email_templates.sql", "0061_email_send_logs.sql"]) {
  const source = await readFile(`${migrationsDirectory}/${file}`, "utf8");

  expectSourceLacks(source, "dispute_review", `${file} knows nothing about a review`);
  expectSourceLacks(source, "dispute_submission", `${file} knows nothing about a submission`);
}

// ---------------------------------------------------------------------------------------------
// 2. The bodies, without a database
// ---------------------------------------------------------------------------------------------

const parsedReview = parseReviewBody({ decision: "approved", note: "  Checked.  " });

expectEqual(parsedReview.decision, "approved", "the review parses its decision");
expectEqual(parsedReview.note, "Checked.", "and trims its reason");

for (const [body, description] of [
  [{ decision: "approved" }, "a review with no reason"],
  [{ decision: "maybe", note: "x" }, "a decision that is not one of the two"],
  [{ decision: "approved", note: "   " }, "a reason of spaces"],
  [{ decision: "approved", note: "x", extra: true }, "a review with an unknown key"],
  [{ decision: "approved", note: "x".repeat(501) }, "a reason over five hundred characters"],
  [null, "a review that is not an object"],
] as readonly [unknown, string][]) {
  expectEqual(await refusalRuleOf(async () => parseReviewBody(body)), "invalid_format", `${description} is refused`);
}

const recorded = parseSubmissionBody({
  channel: "recorded",
  processor_reference: "  C-9931  ",
  note: " Sent from the portal. ",
  version: 2,
});

expectEqual(recorded.channel, "recorded", "a recorded submission parses its channel");
expectEqual(recorded.processorReference, "C-9931", "and trims the processor's case number");
expectEqual(recorded.note, "Sent from the portal.", "and the officer's note");

const provider = parseSubmissionBody({ channel: "provider", version: 2 });

expectEqual(provider.channel, "provider", "a provider submission needs no reference");
expectEqual(provider.processorReference, null, "because the processor will supply it");

for (const [body, description] of [
  [{ channel: "recorded", version: 2 }, "a recorded submission with no case number"],
  [{ channel: "recorded", processor_reference: "   ", version: 2 }, "a case number of spaces"],
  [{ channel: "recorded", processor_reference: "x".repeat(121), version: 2 }, "a case number over a hundred and twenty characters"],
  [{ channel: "provider", processor_reference: "C-1", version: 2 }, "a reference typed into the provider channel"],
  [{ channel: "recorded", processor_reference: "C-1" }, "a submission with no version"],
  [{ channel: "recorded", processor_reference: "C-1", version: 0 }, "a version that is not positive"],
  [{ channel: "recorded", processor_reference: "C-1", version: 2, extra: 1 }, "a submission with an unknown key"],
] as readonly [unknown, string][]) {
  expectEqual(await refusalRuleOf(async () => parseSubmissionBody(body)), "invalid_format", `${description} is refused`);
}

// ---------------------------------------------------------------------------------------------
// 3. Who may review, and who may not
// ---------------------------------------------------------------------------------------------

const roleFixture = createFixture();

for (const [actor, description] of [
  [actorOf({ roles: ["finance_ops"] as readonly PlatformRole[], userId: financeUserId }), "the finance desk"],
  [actorOf({ roles: ["support"] as readonly PlatformRole[], userId: ownerUserId }), "support"],
  [actorOf({ roles: ["ceo"] as readonly PlatformRole[], userId: ownerUserId }), "the chief executive"],
  [actorOf({ roles: ["owner"] as readonly PlatformRole[], userId: ownerUserId, companyId }), "the merchant"],
] as readonly [RequestActor, string][]) {
  await expectRefusal(
    () => readDisputeReview({ actor, disputeId }, dependenciesOf(roleFixture)),
    "PERMISSION_DENIED",
    `${description} cannot read the review screen`,
  );
  await expectRefusal(
    () => reviewDisputePack({ actor, disputeId, body: { decision: "approved", note: "Fine." } }, dependenciesOf(roleFixture)),
    "PERMISSION_DENIED",
    `${description} cannot decide a pack`,
  );
}

const noSecondFactor = actorOf({ twoFactorSatisfied: false, assuranceLevel: "aal1" });

await expectRefusal(
  () => reviewDisputePack({ actor: noSecondFactor, disputeId, body: { decision: "approved", note: "Fine." } }, dependenciesOf(roleFixture)),
  "PERMISSION_DENIED",
  "a session that has not proved its second factor cannot decide",
);
await expectRefusal(
  () =>
    submitDisputePack(
      { actor: noSecondFactor, disputeId, body: { channel: "recorded", processor_reference: "C-1", version: 2 } },
      dependenciesOf(roleFixture),
    ),
  "PERMISSION_DENIED",
  "and cannot send",
);

const superAdmin = actorOf({ roles: ["super_admin"] as readonly PlatformRole[] });
const superView = await readDisputeReview({ actor: superAdmin, disputeId }, dependenciesOf(createFixture()));

expectEqual(superView.pack?.digest, digest, "a super administrator reads the pack like the desk does");
expectEqual(superView.mayReview, true, "and may review it");

// ---------------------------------------------------------------------------------------------
// 4. The screen's answer
// ---------------------------------------------------------------------------------------------

const reviewFixture = createFixture();
const beforeReview = await readDisputeReview({ actor: actorOf(), disputeId }, dependenciesOf(reviewFixture));

expectEqual(beforeReview.pack?.digest, digest, "the screen reads the frozen pack's digest");
expectEqual(beforeReview.pack?.frozenAt, frozenAt, "and when it was frozen");
expectEqual(beforeReview.pack?.itemCount, 4, "and how many records it holds");
expectEqual(beforeReview.pack?.documentCount, 1, "and how many documents");
expectEqual(beforeReview.pack?.items.length, 4, "and the records themselves");
expectEqual(beforeReview.pack?.documents.length, 1, "and the documents");
expectEqual(beforeReview.pack?.sections.length, 4, "and the four parts it covers");
expectEqual(beforeReview.reviews.length, 0, "with no decision yet");
expectEqual(beforeReview.mayReview, true, "so the desk may decide");
expectEqual(beforeReview.maySubmit, false, "but may not send before deciding");
expectEqual(beforeReview.providerKey, "stripe_connect", "the disputed payment's provider is named");
expectEqual(beforeReview.providerChannel, false, "and this build has no port for it");
expectEqual(beforeReview.submission, null, "nothing has been sent");

const draftScreen = await readDisputeReview({ actor: actorOf(), disputeId }, dependenciesOf(createFixture({ packStatus: "draft" })));

expectEqual(draftScreen.pack, null, "a draft is not evidence and is not shown to the desk");
expectEqual(draftScreen.mayReview, false, "so there is nothing to decide");

const noPackScreen = await readDisputeReview({ actor: actorOf(), disputeId }, dependenciesOf(createFixture({ noPack: true })));

expectEqual(noPackScreen.pack, null, "a dispute with no pack answers with none");
expectEqual(noPackScreen.maySubmit, false, "and nothing to send");

const resolvedScreen = await readDisputeReview(
  { actor: actorOf(), disputeId },
  dependenciesOf(createFixture({ dispute: { resolvedAt: "2026-11-02T10:00:00.000Z" } })),
);

expectEqual(resolvedScreen.mayReview, false, "a decided dispute is not reviewed");

await expectRefusal(
  () => readDisputeReview({ actor: actorOf(), disputeId: "not-a-uuid" }, dependenciesOf(reviewFixture)),
  "RESOURCE_NOT_FOUND",
  "a dispute id that is not one is a not-found",
);
await expectRefusal(
  () => readDisputeReview({ actor: actorOf(), disputeId: otherDisputeId }, dependenciesOf(reviewFixture)),
  "RESOURCE_NOT_FOUND",
  "and so is a dispute this platform does not hold",
);

// ---------------------------------------------------------------------------------------------
// 5. The review itself
// ---------------------------------------------------------------------------------------------

const decided = await reviewDisputePack(
  { actor: actorOf(), disputeId, body: { decision: "declined", note: "The delivery proof names the wrong address." } },
  dependenciesOf(reviewFixture),
);

expectEqual(reviewFixture.reviews.length, 1, "reviewing writes one row");
expectEqual(reviewFixture.reviews[0]?.["decision"], "declined", "with the decision on it");
expectEqual(reviewFixture.reviews[0]?.["pack_digest"], digest, "and the digest of the evidence reviewed");
expectEqual(reviewFixture.reviews[0]?.["reviewer_user_id"], reviewerUserId, "and the officer who decided");
expectEqual(decided.reviews.length, 1, "and the screen prints it");
expectEqual(decided.maySubmit, false, "a declined pack may not be sent");
expectEqual(decided.mayReview, true, "but it may be looked at again");

const auditActions = reviewFixture.audit.entries.map((entry) => entry.action);

expect(auditActions.includes("dispute.review_decided"), "the review is in the chain");
const reviewEntry = reviewFixture.audit.entries.find((entry) => entry.action === "dispute.review_decided");

expectEqual(reviewEntry?.entityId, disputeId, "against the dispute");
expectEqual(reviewEntry?.payload["decision"], "declined", "with the decision");
expectEqual(reviewEntry?.payload["pack_digest"], digest, "and the digest");
expectEqual(reviewEntry?.payload["note_length"], 43, "and the length of the reason, never the reason");
expectEqual("note" in (reviewEntry?.payload ?? {}), false, "the reason itself is not in the chain");
expectEqual(reviewEntry?.actorUserId, reviewerUserId, "and the officer");

const reDecided = await reviewDisputePack(
  { actor: actorOf(), disputeId, body: { decision: "approved", note: "Spoke to the merchant: the address is a depot." } },
  dependenciesOf(reviewFixture),
);

expectEqual(reviewFixture.reviews.length, 2, "a second decision is a second row");
expectEqual(reDecided.reviews[0]?.["decision"], "approved", "and the latest one is the one the screen leads with");
expectEqual(reDecided.maySubmit, true, "so the pack may now be sent");

await expectRefusal(
  () =>
    reviewDisputePack(
      { actor: actorOf(), disputeId, body: { decision: "approved", note: "Fine." } },
      dependenciesOf(createFixture({ packStatus: "draft" })),
    ),
  "CONFLICT",
  "a draft pack cannot be reviewed",
);
expectEqual(
  await refusalRuleOf(() =>
    reviewDisputePack(
      { actor: actorOf(), disputeId, body: { decision: "approved", note: "Fine." } },
      dependenciesOf(createFixture({ packStatus: "draft" })),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.packMissing,
  "and the officer is told there is no pack",
);
expectEqual(
  await refusalRuleOf(() =>
    reviewDisputePack(
      { actor: actorOf(), disputeId, body: { decision: "approved", note: "Fine." } },
      dependenciesOf(createFixture({ dispute: { resolvedAt: "2026-11-02T10:00:00.000Z" } })),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.disputeResolved,
  "a decided dispute is not reviewed, and says so",
);

// The database's own guard, entered directly: a review of somebody else's pack, and a review of a wrong digest.
const directFixture = createFixture();

await expectRefusal(
  () =>
    directFixture.rest.insert("dispute_reviews", [
      {
        company_id: otherCompanyId,
        dispute_id: disputeId,
        pack_id: packId,
        decision: "approved",
        note: "Not mine.",
        pack_digest: digest,
        reviewer_user_id: reviewerUserId,
        decided_at: frozenAt,
      },
    ]),
  "VALIDATION_FAILED",
  "a review cannot claim another merchant's pack",
);
await expectRefusal(
  () =>
    directFixture.rest.insert("dispute_reviews", [
      {
        company_id: companyId,
        dispute_id: disputeId,
        pack_id: packId,
        decision: "approved",
        note: "Wrong digest.",
        pack_digest: "b".repeat(64),
        reviewer_user_id: reviewerUserId,
        decided_at: frozenAt,
      },
    ]),
  "VALIDATION_FAILED",
  "and cannot name a digest the pack does not have",
);

// ---------------------------------------------------------------------------------------------
// 6. Sending: refusals before anything is claimed
// ---------------------------------------------------------------------------------------------

const guardedFixture = createFixture();

expectEqual(
  await refusalRuleOf(() =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "C-1", version: 2 } },
      dependenciesOf(guardedFixture),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.reviewRequired,
  "a pack is not sent before the desk approves it",
);
expectEqual(guardedFixture.submissions.length, 0, "and nothing is claimed");
expectEqual(guardedFixture.disputes[0]?.["status"], "under_review", "and the dispute has not moved");

expectEqual(
  await refusalRuleOf(() =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "C-1", version: 2 } },
      dependenciesOf(createFixture({ packStatus: "draft" })),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.packMissing,
  "a draft pack is not sent",
);

const unsupportedFixture = await approvedFixture();

expectEqual(
  await refusalRuleOf(() =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "provider", version: 2 } },
      dependenciesOf(unsupportedFixture),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.submissionUnsupported,
  "the provider channel is refused when this build has no documented API for that provider",
);
expectEqual(unsupportedFixture.submissions.length, 0, "and the refusal comes before anything is claimed");
expectEqual(unsupportedFixture.written.includes("dispute_submissions"), false, "so no attempt row exists");

const unknownProviderFixture = await approvedFixture();
const unknownProvider = createFixture({ providerKey: null });

await expectRefusal(
  () =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "C-1", version: 2 } },
      { ...dependenciesOf(unknownProviderFixture), rest: unknownProvider.rest },
    ),
  "CONFLICT",
  "a dispute whose payment names no provider cannot be sent",
);

// ---------------------------------------------------------------------------------------------
// 7. The recorded channel: the desk sent it, and the platform records what it sent
// ---------------------------------------------------------------------------------------------

const recordedFixture = await approvedFixture();
const recordedResult = await submitDisputePack(
  {
    actor: actorOf(),
    disputeId,
    body: { channel: "recorded", processor_reference: "CASE-88121", note: "Sent from the portal.", version: 2 },
  },
  dependenciesOf(recordedFixture),
);

expectEqual(recordedResult.outcome, "sent", "a recorded submission is sent");
expectEqual(recordedResult.processorReference, "CASE-88121", "with the case number the officer typed");
expectEqual(recordedFixture.submissions.length, 1, "one attempt row is written");
expectEqual(recordedFixture.submissions[0]?.["status"], "sent", "as sent");
expectEqual(recordedFixture.submissions[0]?.["channel"], "recorded", "on the recorded channel");
expectEqual(recordedFixture.submissions[0]?.["provider_key"], "stripe_connect", "naming the payment's provider");
expectEqual(recordedFixture.submissions[0]?.["mode"], "test", "and the mode the payment was taken in");
expectEqual(recordedFixture.submissions[0]?.["pack_digest"], digest, "with the digest of what was sent");
expectEqual(recordedFixture.submissions[0]?.["item_count"], 4, "and the pack's counts");
expectEqual(recordedFixture.submissions[0]?.["document_count"], 1, "on both of them");
expectEqual(recordedFixture.submissions[0]?.["submitted_by_user_id"], reviewerUserId, "and the officer's name");
expectEqual(recordedFixture.disputes[0]?.["status"], "evidence_submitted", "the dispute moves to evidence submitted");
expect(recordedFixture.disputes[0]?.["submitted_at"] !== null, "with the instant it was sent");
expectEqual(recordedResult.view.dispute.responseSubmittedAt !== null, true, "which the screen prints");
expectEqual(recordedResult.view.submission?.processorReference, "CASE-88121", "and the reference");

const recordedAudit = recordedFixture.audit.entries.map((entry) => entry.action);

expect(recordedAudit.includes("dispute.submission_claimed"), "the claim is in the chain");
expect(recordedAudit.includes("dispute.evidence_submitted"), "and the send is");
const sentEntry = recordedFixture.audit.entries.find((entry) => entry.action === "dispute.evidence_submitted");

expectEqual(sentEntry?.entityId, disputeId, "the send is recorded against the dispute");
expectEqual(sentEntry?.payload["pack_digest"], digest, "with the digest");
expectEqual(sentEntry?.payload["processor_reference"], "CASE-88121", "and the processor's reference");
expectEqual(sentEntry?.payload["channel"], "recorded", "and the channel");
expectEqual(sentEntry?.payload["item_count"], 4, "and the counts");
expectEqual(sentEntry?.payload["document_count"], 1, "on both");
expectEqual("note" in (sentEntry?.payload ?? {}), false, "and never the officer's sentence");

expectEqual(recordedFixture.sends.length, 1, "the merchant is queued one email");
expectEqual(recordedFixture.sends[0]?.["template_key"], DISPUTE_SUBMISSION_TEMPLATE_KEY, "as a dispute update");
expectEqual(recordedFixture.sends[0]?.["reference_id"], disputeId, "naming the dispute");
expectEqual(recordedFixture.sends[0]?.["recipient_user_id"], ownerUserId, "to the merchant's own owner");
expectEqual(recordedFixture.sends[0]?.["provider"], "smtp", "through the sending method the office made active");

const secondPress = await submitDisputePack(
  {
    actor: actorOf(),
    disputeId,
    body: { channel: "recorded", processor_reference: "CASE-88121", version: 3 },
  },
  dependenciesOf(recordedFixture),
);

expectEqual(secondPress.outcome, "already_sent", "a second press is a confirmation, not a second send");
expectEqual(recordedFixture.submissions.length, 1, "and writes no second attempt");

// A merchant with no owner, and an office with no sender: the send still lands, and the email does not.
const noOwnerFixture = await approvedFixture();

noOwnerFixture.roleAssignments.length = 0;

const noOwnerResult = await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "CASE-2", version: 2 } },
  dependenciesOf(noOwnerFixture),
);

expectEqual(noOwnerResult.outcome, "sent", "a merchant with no owner address still has their evidence sent");
expectEqual(noOwnerFixture.sends.length, 0, "and no email is queued to nobody");
expectEqual(noOwnerFixture.disputes[0]?.["status"], "evidence_submitted", "the status moves anyway");

const noSenderFixture = await approvedFixture();

noSenderFixture.emailSettings.length = 0;

await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "CASE-3", version: 2 } },
  dependenciesOf(noSenderFixture),
);

expectEqual(noSenderFixture.sends.length, 0, "an office with no active sender queues nothing rather than inventing a method");
expectEqual(noSenderFixture.disputes[0]?.["status"], "evidence_submitted", "and the evidence is still sent");

// ---------------------------------------------------------------------------------------------
// 8. The provider channel, against an injected port
// ---------------------------------------------------------------------------------------------

const portSentFixture = await approvedFixture({ kind: "sent", processorReference: "ch_9" });
const portSent = await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "provider", version: 2 } },
  dependenciesOf(portSentFixture),
);

expectEqual(portSent.outcome, "sent", "a port that accepts the pack sends it");
expectEqual(portSent.processorReference, "ch_9", "with the reference the processor returned");
expectEqual(portSentFixture.submissions[0]?.["channel"], "provider", "on the provider channel");
expectEqual(portSentFixture.submissions[0]?.["processor_reference"], "ch_9", "and the reference on the row");
expectEqual(portSentFixture.disputes[0]?.["status"], "evidence_submitted", "and the dispute moves");

const declinedFixture = await approvedFixture({ kind: "declined", detail: "The evidence window closed." });

expectEqual(
  await refusalRuleOf(() =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "provider", version: 2 } },
      dependenciesOf(declinedFixture),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.submissionDeclined,
  "a processor that refuses the evidence is a refusal the officer reads",
);
expectEqual(declinedFixture.submissions.length, 1, "the attempt is still recorded");
expectEqual(declinedFixture.submissions[0]?.["status"], "failed", "as a failed attempt");
expectEqual(declinedFixture.submissions[0]?.["failure_rule"], DISPUTE_SUBMISSION_RULES.submissionDeclined, "with the rule");
expectEqual(declinedFixture.disputes[0]?.["status"], "under_review", "and the dispute has not moved");
expect(
  declinedFixture.audit.entries.some((entry) => entry.action === "dispute.submission_failed"),
  "the failed attempt is in the chain",
);

const unansweredFixture = await approvedFixture({ kind: "unanswered", detail: "No answer." });

expectEqual(
  await refusalRuleOf(() =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "provider", version: 2 } },
      dependenciesOf(unansweredFixture),
    ),
  ),
  DISPUTE_SUBMISSION_RULES.submissionUnanswered,
  "a call that never answered is not called a decline",
);
expectEqual(unansweredFixture.submissions[0]?.["status"], "failed", "and the attempt fails");

const notSentFixture = await approvedFixture({ kind: "not_sent", rule: "provider_key_missing", detail: "No key." });

expectEqual(
  await refusalRuleOf(() =>
    submitDisputePack(
      { actor: actorOf(), disputeId, body: { channel: "provider", version: 2 } },
      dependenciesOf(notSentFixture),
    ),
  ),
  "provider_key_missing",
  "a port that declines to make the call names its own rule",
);

// A failed attempt frees the pack: the same evidence is sent on the next press, on the other channel.
const retried = await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "CASE-99", version: 2 } },
  dependenciesOf(declinedFixture),
);

expectEqual(retried.outcome, "sent", "a failed attempt does not stop the evidence being sent afterwards");
expectEqual(declinedFixture.submissions.length, 2, "the retry is its own row");
expectEqual(declinedFixture.submissions[1]?.["status"], "sent", "and it is the one that landed");
expectEqual(declinedFixture.disputes[0]?.["status"], "evidence_submitted", "and the dispute moves now");

// ---------------------------------------------------------------------------------------------
// 9. The database's own rules, entered directly
// ---------------------------------------------------------------------------------------------

// The unique index, on its own: an approved pack whose dispute has not moved, with one live claim already in.
const claimFixture = await approvedFixture();
const claim = (overrides: Row = {}): Row => ({
  company_id: companyId,
  dispute_id: disputeId,
  pack_id: packId,
  channel: "recorded",
  status: "sending",
  provider_key: "stripe_connect",
  mode: "test",
  pack_digest: digest,
  item_count: 4,
  document_count: 1,
  submitted_by_user_id: reviewerUserId,
  claimed_at: frozenAt,
  ...overrides,
});

await claimFixture.rest.insert("dispute_submissions", [claim()]);
expectEqual(claimFixture.submissions.length, 1, "the first claim lands");

await expectRefusal(
  () => claimFixture.rest.insert("dispute_submissions", [claim()]),
  "CONFLICT",
  "a second live attempt for one pack is refused by the unique index",
);
await expectRefusal(
  () => claimFixture.rest.insert("dispute_submissions", [claim({ pack_id: packId, channel: "provider", provider_key: "stripe_connect" })]),
  "CONFLICT",
  "and a second attempt for one dispute is refused as well",
);

const guardFixture = await approvedFixture();

await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "CASE-5", version: 2 } },
  dependenciesOf(guardFixture),
);

// A review after the pack has been sent is refused.
await expectRefusal(
  () =>
    guardFixture.rest.insert("dispute_reviews", [
      {
        company_id: companyId,
        dispute_id: disputeId,
        pack_id: packId,
        decision: "approved",
        note: "Too late.",
        pack_digest: digest,
        reviewer_user_id: reviewerUserId,
        decided_at: frozenAt,
      },
    ]),
  "CONFLICT",
  "a pack already with the processor is not reviewed again",
);

// The status cannot move without a sent submission behind it.
const bareFixture = createFixture();

await expectRefusal(
  () =>
    bareFixture.rest.update("disputes", `id=eq.${disputeId}&version=eq.2`, {
      status: "evidence_submitted",
      submitted_at: frozenAt,
    }),
  "VALIDATION_FAILED",
  "a dispute cannot be marked evidence submitted without a sent submission",
);

// And it never goes back to waiting.
const sentFixture = await approvedFixture();

await sendForTest(sentFixture);

await expectRefusal(
  () => sentFixture.rest.update("disputes", `id=eq.${disputeId}`, { status: "under_review" }),
  "VALIDATION_FAILED",
  "a dispute whose evidence was sent does not go back to under review",
);

async function sendForTest(fixture: Fixture): Promise<void> {
  await submitDisputePack(
    { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "CASE-6", version: 2 } },
    dependenciesOf(fixture),
  );
}

// ---------------------------------------------------------------------------------------------
// 10. The queue
// ---------------------------------------------------------------------------------------------

const queueFixture = createFixture();

queueFixture.disputes.push(disputeRow({ id: otherDisputeId, dueAtValue: "2026-11-01T20:00:00.000Z", version: 2 }));

const queueBefore = await listReviewQueue({ actor: actorOf() }, dependenciesOf(queueFixture));

expectEqual(queueBefore.length, 1, "the queue lists the frozen pack nobody has sent");
expectEqual(queueBefore[0]?.packId, packId, "with its pack id");
expectEqual(queueBefore[0]?.digest, digest, "and its digest");
expectEqual(queueBefore[0]?.companyName, "Northwind Studio", "and the merchant's name");
expectEqual(queueBefore[0]?.decision, null, "and no decision yet");
expectEqual(queueBefore[0]?.itemCount, 4, "and the counts");

await reviewDisputePack(
  { actor: actorOf(), disputeId, body: { decision: "declined", note: "The invoice number does not match." } },
  dependenciesOf(queueFixture),
);

const queueDeclined = await listReviewQueue({ actor: actorOf() }, dependenciesOf(queueFixture));

expectEqual(queueDeclined[0]?.decision, "declined", "a declined pack stays in the queue, with its decision");

await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "recorded", processor_reference: "CASE-7", version: 2 } },
  dependenciesOf(await approveThenSubmit(queueFixture)),
);

const queueAfterSend = await listReviewQueue({ actor: actorOf() }, dependenciesOf(queueFixture));

expectEqual(queueAfterSend.length, 0, "a pack that has been sent leaves the queue");

/** Approves whatever the queue fixture holds, then submits it: the state a sent pack leaves behind. */
async function approveThenSubmit(fixture: Fixture): Promise<Fixture> {
  await reviewDisputePack(
    { actor: actorOf(), disputeId, body: { decision: "approved", note: "Spoke to the merchant; it matches." } },
    dependenciesOf(fixture),
  );

  return fixture;
}

await expectRefusal(
  () => listReviewQueue({ actor: financeActor() }, dependenciesOf(createFixture())),
  "PERMISSION_DENIED",
  "the finance desk reads the deadline queue but not the review queue",
);

// ---------------------------------------------------------------------------------------------
// 11. The port, the registry and what a target carries
// ---------------------------------------------------------------------------------------------

expectEqual(SUBMITTING_PROVIDER_KEYS.length, 0, "this build has no documented dispute API for any provider");
expectEqual(submissionPortFor({}, "stripe_connect"), null, "so the registry answers null for a provider");
expectEqual(
  submissionPortFor({ stripe_connect: async (): Promise<DisputeSubmissionOutcome> => ({ kind: "sent", processorReference: "x" }) }, "stripe_connect") !== null,
  true,
  "and answers a port for a provider that has one",
);

const targetFixture = await approvedFixture({ kind: "sent", processorReference: "ch_1" });
let capturedTarget: Record<string, unknown> | null = null;
const capturePort = async (target: unknown): Promise<DisputeSubmissionOutcome> => {
  capturedTarget = target as Record<string, unknown>;

  return { kind: "sent", processorReference: "ch_1" };
};

await submitDisputePack(
  { actor: actorOf(), disputeId, body: { channel: "provider", version: 2 } },
  { rest: targetFixture.rest, audit: targetFixture.audit, ports: { stripe_connect: capturePort }, now: () => targetFixture.nowMs },
);

expect(capturedTarget !== null, "the port is called with a target");
const target = capturedTarget as unknown as Record<string, unknown>;

expectEqual(target["packDigest"], digest, "the target carries the digest of what is sent");
expectEqual(target["itemCount"], 4, "and the counts");
expectEqual(target["documentCount"], 1, "on both");
expectEqual(target["providerKey"], "stripe_connect", "and the provider");
expectEqual(target["mode"], "test", "and the mode the payment was taken in");
expectEqual(Array.isArray(target["items"]), true, "and the records themselves");
expectEqual((target["items"] as readonly unknown[]).length, 4, "all four of them");
expectEqual((target["documents"] as readonly unknown[]).length, 1, "and the documents");
expectEqual("storageKey" in ((target["documents"] as readonly Record<string, unknown>[])[0] ?? {}), false, "and never a storage key");
expectEqual("bytes" in ((target["documents"] as readonly Record<string, unknown>[])[0] ?? {}), false, "and never a byte");

const submissionSource = await sourceOf("services/disputes/dispute-submission.ts");
const runtimeSource = await sourceOf("services/disputes/dispute-runtime.ts");

expectSourceContains(runtimeSource, "SUBMITTING_PROVIDER_KEYS.length !== 0", "the runtime refuses to boot claiming a provider it cannot call");
expectSourceContains(runtimeSource, "submission_port_missing", "and names the defect");
expectSourceLacks(submissionSource, "storage_key", "the service never asks for a storage key");
expectSourceLacks(submissionSource, "console.", "the service prints nothing");
expectSourceLacks(submissionSource, ": any", "and types nothing as any");
expectSourceLacks(submissionSource, "parseFloat", "and does no money arithmetic of its own");

// ---------------------------------------------------------------------------------------------
// 12. The two routes
// ---------------------------------------------------------------------------------------------

const reviewRoute = await sourceOf("app/api/office/disputes/[id]/review/route.ts");
const submitRoute = await sourceOf("app/api/office/disputes/[id]/submit/route.ts");

for (const [source, name] of [
  [reviewRoute, "the review route"],
  [submitRoute, "the submission route"],
] as readonly [string, string][]) {
  expectSourceContains(source, "requireCsrfToken(request", `${name} checks the token first`);
  expectSourceContains(source, "readRequestActor(request.headers.get(\"cookie\")", `${name} reads the session itself`);
  expectSourceContains(source, "requireTrustedDevice(", `${name} demands the device proof`);
  expectSourceContains(source, "DISPUTE_SUBMISSION_MAXIMUM_BODY_BYTES", `${name} has a body ceiling`);
  expectSourceContains(source, 'throw new AppError("PAYLOAD_TOO_LARGE")', `${name} refuses a large body`);
  expectSourceContains(source, "withErrorResponse(", `${name} answers in the platform's envelope`);
  expectSourceContains(source, "getDisputeSubmissionRuntime()", `${name} calls the service with the runtime`);
  expectSourceContains(source, "logger.info(", `${name} logs its act`);
  expectSourceLacks(source, "console.", `${name} does not print`);
}

expectSourceContains(reviewRoute, "reviewDisputePack(", "the review route reviews");
expectSourceContains(reviewRoute, "parseReviewBody(", "after proving the body is a decision");
expectSourceContains(submitRoute, "submitDisputePack(", "the submission route sends");
expectSourceContains(submitRoute, "parseSubmissionBody(", "after proving the body is a submission");
expectSourceLacks(reviewRoute, "processor_reference", "the review route never touches a case number");
expectSourceContains(submitRoute, "referenceLength", "the submission route logs the length of a reference and not the reference");
expectSourceContains(reviewRoute, "noteLength", "the review route logs the length of the reason");
expectSourceLacks(reviewRoute, "note: parsed.note", "and never the reason");
expectSourceLacks(submitRoute, "note: parsed.note", "and the submission route never the officer's sentence");

for (const path of ["/api/office/disputes/[id]/review", "/api/office/disputes/[id]/submit"]) {
  expect(CSRF_PROTECTED_PATHS.includes(path), `${path} is on the CSRF list`);
}

// ---------------------------------------------------------------------------------------------
// 13. The screen
// ---------------------------------------------------------------------------------------------

const reviewPage = await sourceOf("app/(admin)/office/disputes/[id]/page.tsx");
const panelSource = await sourceOf("app/(admin)/office/disputes/[id]/review-panel.tsx");
const queuePage = await sourceOf("app/(admin)/office/disputes/page.tsx");

expectSourceContains(panelSource, '"use client"', "the panel is a browser component");
expectSourceContains(reviewPage, "DisputeReviewPanel", "and the page renders it");
expectSourceContains(reviewPage, "readDisputeReview(", "the page reads the review's own answer");
expectSourceContains(queuePage, "listReviewQueue(", "the queue screen lists the packs waiting for the desk");
expectSourceContains(queuePage, "/office/disputes/${encodeURIComponent(row.dispute.id)}", "and links each one to its review");

const panelCalls =
  panelSource.split('method: "POST"').length - 1 + (panelSource.split('method: "DELETE"').length - 1);
const panelSpreads = panelSource.split("...(await csrfHeaders())").length - 1;

expectEqual(panelCalls, 2, "the panel sends two mutations: a decision and a submission");
expectEqual(panelSpreads, 2, "each carrying its own token");
expectSourceContains(panelSource, "deviceProofHeaders(", "and both signed with the enrolled device");
expectSourceContains(panelSource, 'role={isError ? "alert" : "status"}', "a refusal is announced rather than printed quietly");
expectSourceContains(panelSource, "router.refresh()", "and the page is re-read after every act");
expectSourceContains(panelSource, "disabled={busy || !maySubmit || submissionSent", "the send button is disabled until the pack is approved");
expectSourceContains(panelSource, "disabled={!providerChannel}", "and the provider channel is not offered without a port");
expectSourceContains(panelSource, "DISPUTE_REVIEW_NOTE_MAXIMUM_LENGTH", "the reason is bounded in the browser too");
expectSourceContains(panelSource, "DISPUTE_SUBMISSION_REFERENCE_MAXIMUM_LENGTH", "and the case number");
expectSourceLacks(panelSource, "console.", "the panel prints nothing");
expectSourceLacks(panelSource, "JSON.parse", "the panel parses nothing it did not send");
expectSourceContains(reviewPage, "state.view.pack === null ? null : (", "the page offers no panel before there is a pack");

// ---------------------------------------------------------------------------------------------
// 14. Every message exists
// ---------------------------------------------------------------------------------------------

const messages = new Map<string, string>();

function collect(node: unknown, prefix: string): void {
  if (typeof node === "string") {
    messages.set(prefix, node);

    return;
  }

  if (typeof node !== "object" || node === null) {
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collect(value, prefix.length === 0 ? key : `${prefix}.${key}`);
  }
}

collect(en, "");

function messagePathsIn(source: string): readonly string[] {
  const found: string[] = [];

  for (const match of source.matchAll(/(?:getMessage|formatMessage)\("([a-z][A-Za-z0-9_.]*)"\)?/gu)) {
    found.push(match[1] ?? "");
  }

  return found;
}

const used = [
  ...new Set([
    ...messagePathsIn(panelSource),
    ...messagePathsIn(reviewPage),
    ...messagePathsIn(queuePage),
    ...messagePathsIn(submissionSource),
  ]),
].sort();

for (const path of used) {
  expect(messages.has(path), `the message ${path} exists`);
}

const emailSubject = messages.get("email.disputeSubmission.subject");

expect(emailSubject !== undefined, "the submission email has a subject");
expect((emailSubject ?? "").length <= 160, "and `0061`'s ceiling holds it");

expectEqual(messages.get("disputes.reviewDecisionApproved"), "Approved", "the approval reads as one word");
expectEqual(messages.get("disputes.reviewDecisionDeclined"), "Declined", "and so does the decline");

// ---------------------------------------------------------------------------------------------
// 15. The words themselves
// ---------------------------------------------------------------------------------------------

expectEqual(DISPUTE_SUBMISSION_FIELD, "submission", "every refusal of this STEP names one field");
expectEqual(DISPUTE_SUBMISSION_TEMPLATE_KEY, "dispute_update", "the email is a dispute update, which is `0061`'s word");
expect(
  (await readFile(`${migrationsDirectory}/0061_email_send_logs.sql`, "utf8")).includes(`'${DISPUTE_SUBMISSION_TEMPLATE_KEY}'`),
  "and that word is on `0061`'s closed list of twenty templates",
);
expectEqual(Object.keys(DISPUTE_SUBMISSION_RULES).length, 11, "and there are eleven rules to read");
expect(
  Object.values(DISPUTE_SUBMISSION_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "each rule is a machine word, not a sentence",
);

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`dispute submission gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `dispute submission gate passed: ${String(checkCount)} checks, section 19's compliance desk reading the frozen ` +
      "pack, naming itself on a decision that can never be edited, sending the evidence on exactly one approved " +
      "attempt, and the dispute reaching evidence submitted only because that attempt says it was sent\n",
  );
}
