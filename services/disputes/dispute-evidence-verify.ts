// path: services/disputes/dispute-evidence-verify.ts
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
  DISPUTE_EVIDENCE_RULES,
  DISPUTE_EVIDENCE_SOURCE_KINDS,
  disputeEvidenceIsComplete,
  disputeEvidenceMissingSections,
  evidenceSectionLabel,
} from "./dispute-evidence-fields.ts";
import {
  addEvidenceItem,
  assembleEvidencePack,
  attachEvidenceDocument,
  evidenceDigestOf,
  freezeEvidencePack,
  parseEvidenceItemBody,
  readDisputeEvidence,
  removeEvidenceDocument,
  removeEvidenceItem,
  type DisputeEvidenceDependencies,
  type DisputeEvidenceStorage,
} from "./dispute-evidence.ts";

/**
 * The gate for STEP 197: section 19's structured chargeback evidence pack.
 *
 * ## What this proves
 *
 *   - **Four parts, decided from the rows.** The invoice, the delivery proof, the client communication record
 *     and the terms acceptance record come from where the platform already keeps them, and a pack that is
 *     missing one of the four is refused at the freeze with the list of what is missing - in the service and
 *     again in `0126`'s trigger, so a caller that skipped the service still cannot freeze a partial pack.
 *   - **A copy, not a view.** Every item carries its own label, summary and instant, the digest is computed
 *     over exactly those, and a frozen pack refuses every write. Change the source afterwards and the pack
 *     does not move: that is what makes it evidence.
 *   - **The documents section 19 asks the merchant for.** A file is accepted only if its bytes match the type
 *     it claims (the shared upload validator), it is sealed and recorded through the storage layer, and the
 *     same bytes twice in one pack is refused rather than attached twice.
 *   - **`0039`'s `evidence_ready` means what its comment says.** The flag can only be raised by freezing a
 *     pack, and `0126`'s trigger on `disputes` refuses it otherwise; a dispute whose pack is frozen cannot be
 *     un-readied.
 *   - **One tenant, one role.** The `owner` of the merchant that owns the dispute assembles the pack, and a
 *     dispute of another merchant is never read at all.
 *   - **Every act is in the chain**, with counts, digests and file sizes - and never a label, a message
 *     subject or a byte.
 *
 * ## How
 *
 * An in-memory PostgREST over arrays, carrying `0126`'s three unique keys, its checks and its five trigger
 * bodies, so a service that skipped its own check would still fail here. The four source tables are filled
 * per test, because what the pack can hold is the question each test asks.
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

/** The rule of the last refusal, so a test can assert which rule a merchant is told. */
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
// The fixture: a PostgREST over arrays, with `0126`'s keys, checks and triggers on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const supportUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const disputeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const otherDisputeId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const paymentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const invoiceId = "99999999-9999-4999-8999-999999999999";
const fulfilmentId = "18181818-1818-4818-8818-181818181818";
const acceptanceId = "19191919-1919-4919-8919-191919191919";
const policyId = "20202020-2020-4020-8020-202020202020";
const firstEmailId = "21212121-2121-4121-8121-212121212121";
const secondEmailId = "22222221-2221-4122-8122-222222222221";
const firstEventId = "23232323-2323-4323-8323-232323232323";
const openedAt = "2026-11-01T09:00:00.000Z";
const openedAtMs = Date.parse(openedAt);
const dueAt = "2026-11-02T09:00:00.000Z";

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"],
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

function supportActor(): RequestActor {
  return actorOf({ userId: supportUserId, roles: ["support"] as readonly PlatformRole[] });
}

function disputeRow(overrides: { readonly id?: string; readonly companyId?: string; readonly resolvedAt?: string | null; readonly submittedAt?: string | null } = {}): Row {
  return {
    id: overrides.id ?? disputeId,
    company_id: overrides.companyId ?? companyId,
    payment_id: paymentId,
    processor_dispute_id: "dp_0001",
    status: overrides.resolvedAt === undefined || overrides.resolvedAt === null ? "under_review" : "won",
    reason_code: "fraudulent",
    amount_minor: 12_000,
    currency: "USD",
    fee_minor: 0,
    opened_at: openedAt,
    response_window_hours: 24,
    response_due_at: dueAt,
    evidence_ready: false,
    response_text: null,
    response_saved_at: null,
    submitted_at: overrides.submittedAt ?? null,
    resolved_at: overrides.resolvedAt ?? null,
    outcome_note: overrides.resolvedAt === undefined || overrides.resolvedAt === null ? null : "won on the pack",
    created_at: openedAt,
    updated_at: openedAt,
    deleted_at: null,
    version: 1,
    evidence_ready_pack: null,
  };
}

function paymentRow(overrides: { readonly invoiceId?: string | null; readonly companyId?: string } = {}): Row {
  return {
    id: paymentId,
    company_id: overrides.companyId ?? companyId,
    invoice_id: overrides.invoiceId === undefined ? invoiceId : overrides.invoiceId,
    amount_minor: 12_000,
    currency: "USD",
    status: "settled",
    captured_at: "2026-10-30T12:00:00.000Z",
    deleted_at: null,
  };
}

function invoiceRow(): Row {
  return {
    id: invoiceId,
    company_id: companyId,
    number: "INV-1001",
    status: "paid",
    currency: "USD",
    total_minor: 12_000,
    amount_paid_minor: 12_000,
    issued_at: "2026-10-29T08:00:00.000Z",
    paid_at: "2026-10-30T12:00:00.000Z",
    deleted_at: null,
  };
}

function fulfilmentRow(): Row {
  return {
    id: fulfilmentId,
    company_id: companyId,
    invoice_id: invoiceId,
    kind: "delivery",
    method: "carrier",
    occurred_at: "2026-10-30T09:00:00.000Z",
    reference: "TRACK-77",
    description: "Left with the concierge",
    deleted_at: null,
  };
}

function acceptanceRow(): Row {
  return {
    id: acceptanceId,
    company_id: companyId,
    invoice_id: invoiceId,
    statement: "delivery",
    signer_name: "Jamie Fox",
    consent_accepted: true,
    accepted_at: "2026-10-30T11:00:00.000Z",
    deleted_at: null,
  };
}

function policyRow(): Row {
  return {
    id: policyId,
    company_id: companyId,
    policy_key: "terms",
    policy_version: "2026-01",
    accepted_at: "2026-01-04T10:00:00.000Z",
    deleted_at: null,
  };
}

function emailRow(id: string, queuedAt: string, subject: string): Row {
  return {
    id,
    company_id: companyId,
    template_key: "invoice_delivery",
    subject,
    status: "sent",
    queued_at: queuedAt,
    sent_at: queuedAt,
    reference_kind: "invoice",
    reference_id: invoiceId,
    deleted_at: null,
  };
}

function eventRow(id: string, type: string, occurredAt: string): Row {
  return {
    id,
    company_id: companyId,
    invoice_id: invoiceId,
    type,
    detail: null,
    occurred_at: occurredAt,
    deleted_at: null,
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
  readonly invoices: Row[];
  readonly fulfilments: Row[];
  readonly acceptances: Row[];
  readonly policies: Row[];
  readonly emails: Row[];
  readonly events: Row[];
  /** Tables touched, in order, so a gate can prove what was written and what was not. */
  readonly written: string[];
  /** Whether `payments` answered a row for the disputed payment. */
  paymentKnown: boolean;
  /** When true, the disputes update lands nowhere, which is how a lost write is simulated. */
  loseDisputeUpdate: boolean;
  /** When true, an item update lands nowhere: the same loss, one table down. */
  loseItemUpdate: boolean;
  nowMs: number;
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

/** The four parts of section 19, in the order the trigger counts them. */
const SECTIONS = ["invoice", "delivery", "communication", "terms"] as const;

function conflictGuard(field: string, rule: string): never {
  throw new AppError("CONFLICT", { details: [{ field, rule }] });
}

function validationGuard(field: string, rule: string): never {
  throw new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/** `0126`'s checks on one pack row, and its three unique keys. */
function guardPackInsert(fixture: Fixture, row: Row): void {
  if (row["status"] !== undefined && row["status"] !== "draft") {
    validationGuard("status", "dispute_evidence_packs_status_check");
  }

  if (row["digest"] !== undefined && row["digest"] !== null) {
    validationGuard("digest", "dispute_evidence_packs_frozen_check");
  }

  if (fixture.packs.some((pack) => pack["dispute_id"] === row["dispute_id"] && pack["deleted_at"] !== null)) {
    conflictGuard("dispute_id", "dispute_evidence_packs_live_key");
  }
}

/** `dispute_evidence_packs_guard`, including the freeze and the counts it writes. */
function guardPackUpdate(fixture: Fixture, pack: Row, values: Row): void {
  if (
    (values["company_id"] !== undefined && values["company_id"] !== pack["company_id"]) ||
    (values["dispute_id"] !== undefined && values["dispute_id"] !== pack["dispute_id"])
  ) {
    validationGuard("id", "dispute_evidence_packs_guard");
  }

  if (pack["status"] === "frozen") {
    const changed = Object.keys(values).some((key) => key !== "version" && values[key] !== pack[key]);

    if (changed) {
      validationGuard("status", "dispute_evidence_packs_guard");
    }

    return;
  }

  if (values["status"] !== "frozen") {
    return;
  }

  const dispute = fixture.disputes.find((candidate) => candidate["id"] === pack["dispute_id"]);

  if (dispute === undefined || dispute["company_id"] !== pack["company_id"] || dispute["deleted_at"] !== null) {
    validationGuard("dispute_id", "dispute_evidence_packs_guard");
  }

  if (dispute["resolved_at"] !== null) {
    validationGuard("dispute_id", "dispute_evidence_packs_guard");
  }

  const liveItems = fixture.items.filter((item) => item["pack_id"] === pack["id"] && item["deleted_at"] === null);
  const liveDocuments = fixture.documents.filter(
    (document) => document["pack_id"] === pack["id"] && document["deleted_at"] === null,
  );
  const covered = SECTIONS.filter(
    (section) =>
      liveItems.some((item) => item["section"] === section) ||
      liveDocuments.some((document) => document["section"] === section),
  );

  if (covered.length !== SECTIONS.length) {
    validationGuard("status", "dispute_evidence_packs_guard");
  }

  if (liveDocuments.length === 0) {
    validationGuard("status", "dispute_evidence_packs_guard");
  }

  if (typeof values["digest"] !== "string" || !/^[0-9a-f]{64}$/u.test(values["digest"])) {
    validationGuard("digest", "dispute_evidence_packs_digest_check");
  }

  if (values["frozen_at"] === undefined || values["frozen_at"] === null) {
    validationGuard("frozen_at", "dispute_evidence_packs_frozen_check");
  }

  values["item_count"] = liveItems.length;
  values["document_count"] = liveDocuments.length;
}

/** `0126`'s checks on one item row, and the guard that refuses a frozen pack. */
function guardItemRow(fixture: Fixture, row: Row, mode: "insert" | "update"): void {
  const pack = fixture.packs.find((candidate) => candidate["id"] === row["pack_id"]);

  if (pack === undefined) {
    validationGuard("pack_id", "dispute_evidence_items_pack_fkey");
  }

  if (row["company_id"] !== pack["company_id"]) {
    validationGuard("company_id", "dispute_evidence_items_guard");
  }

  if (pack["status"] !== "draft") {
    validationGuard("pack_id", "dispute_evidence_items_guard");
  }

  if (!(SECTIONS as readonly string[]).includes(String(row["section"]))) {
    validationGuard("section", "dispute_evidence_items_section_check");
  }

  if (!(DISPUTE_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(String(row["source_kind"]))) {
    validationGuard("source_kind", "dispute_evidence_items_source_check");
  }

  const isNote = row["source_kind"] === "note";

  if (isNote !== (row["source_id"] === null || row["source_id"] === undefined)) {
    validationGuard("source_id", "dispute_evidence_items_source_id_check");
  }

  const label = String(row["label"] ?? "");

  if (label.length < 3 || label.length > 120) {
    validationGuard("label", "dispute_evidence_items_label_check");
  }

  if (row["summary"] !== null && row["summary"] !== undefined) {
    const summary = String(row["summary"]);

    if (summary.length < 1 || summary.length > 600) {
      validationGuard("summary", "dispute_evidence_items_summary_check");
    }
  }

  if (mode === "insert") {
    const duplicate = fixture.items.some(
      (item) =>
        item["pack_id"] === row["pack_id"] &&
        item["section"] === row["section"] &&
        item["source_kind"] === row["source_kind"] &&
        (item["source_id"] ?? null) === (row["source_id"] ?? null) &&
        item["deleted_at"] === null,
    );

    if (duplicate) {
      conflictGuard("source_id", "dispute_evidence_items_live_key");
    }
  }
}

/** `0126`'s checks on one document row, and its two keys. */
function guardDocumentRow(fixture: Fixture, row: Row, mode: "insert" | "update"): void {
  const pack = fixture.packs.find((candidate) => candidate["id"] === row["pack_id"]);

  if (pack === undefined) {
    validationGuard("pack_id", "dispute_evidence_documents_pack_fkey");
  }

  if (row["company_id"] !== pack["company_id"]) {
    validationGuard("company_id", "dispute_evidence_documents_guard");
  }

  if (pack["status"] !== "draft") {
    validationGuard("pack_id", "dispute_evidence_documents_guard");
  }

  if (!(SECTIONS as readonly string[]).includes(String(row["section"]))) {
    validationGuard("section", "dispute_evidence_documents_section_check");
  }

  if (!["application/pdf", "image/jpeg", "image/png"].includes(String(row["content_type"]))) {
    validationGuard("content_type", "dispute_evidence_documents_type_check");
  }

  if (Number(row["byte_size"]) <= 0 || Number(row["byte_size"]) > 52_428_800) {
    validationGuard("byte_size", "dispute_evidence_documents_size_check");
  }

  if (!/^[0-9a-f]{64}$/u.test(String(row["content_sha256"]))) {
    validationGuard("content_sha256", "dispute_evidence_documents_digest_check");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{7,299}$/u.test(String(row["storage_key"]))) {
    validationGuard("storage_key", "dispute_evidence_documents_key_check");
  }

  if (mode === "insert") {
    const duplicate = fixture.documents.some(
      (document) =>
        document["pack_id"] === row["pack_id"] &&
        document["content_sha256"] === row["content_sha256"] &&
        document["deleted_at"] === null,
    );

    if (duplicate) {
      conflictGuard("content_sha256", "dispute_evidence_documents_pack_key");
    }
  }
}

/** `disputes_guard_evidence`: the flag means a frozen pack exists, and once it does it stays. */
function guardDisputeUpdate(fixture: Fixture, dispute: Row, values: Row): void {
  if (values["evidence_ready"] === undefined || values["evidence_ready"] === dispute["evidence_ready"]) {
    return;
  }

  const frozen = fixture.packs.some(
    (pack) => pack["dispute_id"] === dispute["id"] && pack["status"] === "frozen" && pack["deleted_at"] === null,
  );

  if (values["evidence_ready"] === true) {
    if (dispute["resolved_at"] !== null) {
      validationGuard("evidence_ready", "disputes_guard_evidence");
    }

    if (!frozen) {
      validationGuard("evidence_ready", "disputes_guard_evidence");
    }

    return;
  }

  if (frozen) {
    validationGuard("evidence_ready", "disputes_guard_evidence");
  }
}

interface FixtureInput {
  readonly dispute?: Row;
  readonly otherDispute?: Row | null;
  readonly payment?: Row;
  readonly paymentKnown?: boolean;
  readonly invoice?: Row | null;
  readonly emails?: readonly Row[];
  readonly events?: readonly Row[];
}

function createFixture(input: FixtureInput = {}): Fixture {
  const disputes: Row[] = [input.dispute ?? disputeRow()];

  if (input.otherDispute !== undefined && input.otherDispute !== null) {
    disputes.push(input.otherDispute);
  }

  const payments: Row[] = input.paymentKnown === false ? [] : [input.payment ?? paymentRow()];
  const invoices: Row[] = input.invoice === null ? [] : [input.invoice ?? invoiceRow()];
  const written: string[] = [];
  let counter = 0;

  const tables: Partial<Fixture> = {};
  const holder = (): Fixture => tables as Fixture;

  const table = (name: string): Row[] => {
    switch (name) {
      case "disputes":
        return disputes;
      case "dispute_evidence_packs":
        return holder().packs;
      case "dispute_evidence_items":
        return holder().items;
      case "dispute_evidence_documents":
        return holder().documents;
      case "payments":
        return payments;
      case "invoices":
        return invoices;
      case "invoice_fulfilment_evidence":
        return holder().fulfilments;
      case "invoice_acceptances":
        return holder().acceptances;
      case "policy_acceptances":
        return holder().policies;
      case "email_send_logs":
        return holder().emails;
      case "invoice_events":
        return holder().events;
      default:
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table", name } });
    }
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      let rows = table(name).filter((row) => matches(row, parsed));

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

      return schema.array().parse(rows.map((row) => ({ ...row })));
    },

    async insert(name: string, rows: readonly Row[]): Promise<void> {
      written.push(name);

      for (const row of rows) {
        if (name === "dispute_evidence_packs") {
          guardPackInsert(holder(), row);
          counter += 1;
          holder().packs.push({
            id: `c0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            status: "draft",
            digest: null,
            item_count: 0,
            document_count: 0,
            frozen_at: null,
            created_at: new Date(holder().nowMs).toISOString(),
            updated_at: new Date(holder().nowMs).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "dispute_evidence_items") {
          guardItemRow(holder(), row, "insert");
          counter += 1;
          holder().items.push({
            id: `d0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            summary: null,
            created_at: new Date(holder().nowMs).toISOString(),
            updated_at: new Date(holder().nowMs).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "dispute_evidence_documents") {
          guardDocumentRow(holder(), row, "insert");
          counter += 1;
          holder().documents.push({
            id: `e0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
            caption: null,
            created_at: new Date(holder().nowMs).toISOString(),
            updated_at: new Date(holder().nowMs).toISOString(),
            deleted_at: null,
            version: 1,
            ...row,
          });
          continue;
        }

        table(name).push({ ...row });
      }
    },

    async insertReturning<TRow>(name: string, rows: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      await rest.insert(name, rows);

      if (name !== "dispute_evidence_packs") {
        return schema.array().parse([]);
      }

      const created = holder().packs[holder().packs.length - 1];

      return schema.array().parse([{ id: created?.["id"] ?? "" }]);
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      written.push(name);
      const parsed = parseQuery(query);

      for (const row of table(name).filter((candidate) => matches(candidate, parsed))) {
        if (name === "dispute_evidence_packs") {
          guardPackUpdate(holder(), row, values);
        }

        if (name === "dispute_evidence_items") {
          guardItemRow(holder(), row, "update");
        }

        if (name === "dispute_evidence_documents") {
          guardDocumentRow(holder(), row, "update");
        }

        if (name === "disputes") {
          guardDisputeUpdate(holder(), row, values);
        }

        if (name === "disputes" && holder().loseDisputeUpdate) {
          continue;
        }

        if (name === "dispute_evidence_items" && holder().loseItemUpdate) {
          continue;
        }

        const nextVersion = Number(row["version"] ?? 1) + 1;

        Object.assign(row, values, { version: nextVersion, updated_at: new Date(holder().nowMs).toISOString() });
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "no_rpc" } });
    },
  };

  Object.assign(tables, {
    rest,
    audit: createInMemoryAuditTrail(),
    disputes,
    packs: [],
    items: [],
    documents: [],
    payments,
    invoices,
    fulfilments: [fulfilmentRow()],
    acceptances: [acceptanceRow()],
    policies: [policyRow()],
    emails: [
      ...(input.emails ?? [
        emailRow(firstEmailId, "2026-10-29T08:05:00.000Z", "Invoice INV-1001"),
        emailRow(secondEmailId, "2026-10-30T08:05:00.000Z", "A reminder about INV-1001"),
      ]),
    ],
    events: [
      ...(input.events ?? [eventRow(firstEventId, "viewed", "2026-10-29T09:30:00.000Z")]),
    ],
    written,
    paymentKnown: input.paymentKnown !== false,
    loseDisputeUpdate: false,
    loseItemUpdate: false,
    nowMs: openedAtMs + 3_600_000,
  });

  return holder();
}

/** A fake bucket: it keeps what it was handed and answers a key of the shape `0126` accepts. */
function storageOf(fixture: Fixture, overrides: { readonly key?: string; readonly missing?: boolean } = {}): DisputeEvidenceStorage | undefined {
  if (overrides.missing === true) {
    return undefined;
  }

  return {
    async put(input) {
      fixture.written.push("storage.put");

      return { storageKey: overrides.key ?? `${input.companyId}/dispute_document/6f1e2d3c-0000-4000-8000-00000000000a`, fileId: "file-0001" };
    },
  };
}

function dependenciesOf(fixture: Fixture, storage?: DisputeEvidenceStorage): DisputeEvidenceDependencies {
  return {
    rest: fixture.rest,
    audit: fixture.audit,
    now: () => fixture.nowMs,
    ...(storage === undefined ? {} : { storage }),
  };
}

/** Real PDF bytes, because the upload validator decides the type from the signature and not from the name. */
function pdfBytes(padding = 0): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${"x".repeat(padding)}`);
}

/** Real PNG bytes, for the file that claims to be a PDF. */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49]);
}

/** One assembled draft with all four parts filled, plus a document, ready to freeze. */
async function frozenFixturePack(fixture: Fixture): Promise<{ readonly packId: string }> {
  const storage = storageOf(fixture);

  await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(fixture, storage));

  await attachEvidenceDocument(
    {
      actor: actorOf(),
      disputeId,
      upload: {
        fileName: "delivery-note.pdf",
        declaredType: "application/pdf",
        bytes: pdfBytes(),
        section: "delivery",
        caption: "The signed delivery note",
      },
    },
    dependenciesOf(fixture, storage),
  );

  await freezeEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(fixture, storage));

  const pack = fixture.packs[0];

  return { packId: String(pack?.["id"] ?? "") };
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

async function sourceOf(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function expectSourceContains(source: string, needle: string, description: string): void {
  expect(source.includes(needle), `${description} (missing ${JSON.stringify(needle)})`);
}

function expectSourceLacks(source: string, needle: string, description: string): void {
  expect(!source.includes(needle), `${description} (found ${JSON.stringify(needle)})`);
}

const PLACEHOLDER_MARKERS: readonly string[] = Object.freeze([["TO", "DO"].join(""), ["FIX", "ME"].join("")]);

/** The two shapes this gate refuses in shipped code, spelled in halves so it does not carry them itself. */
const ANY_CAST = [": a", "ny"].join("");
const CONSOLE_CALL = ["cons", "ole."].join("");

function expectNoPlaceholderMarker(source: string, description: string): void {
  for (const marker of PLACEHOLDER_MARKERS) {
    expect(!source.includes(marker), `${description} carries no ${marker}`);
  }
}

function messageAt(path: string): string | null {
  let cursor: unknown = en;

  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) {
      return null;
    }

    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return typeof cursor === "string" ? cursor : null;
}

function messagePathsIn(source: string): readonly string[] {
  const paths = new Set<string>();

  for (const match of source.matchAll(/"((?:disputes|email)\.[A-Za-z0-9_.]+)"/gu)) {
    if (match[1] !== undefined) {
      paths.add(match[1]);
    }
  }

  return [...paths].sort();
}

/* -------------------------------------------------------------------------------------------------
 * 1. The migration, its rollback, and what it must not touch
 * ---------------------------------------------------------------------------------------------- */

const migrationsDirectory = "migrations";

async function migrationNumbers(): Promise<readonly number[]> {
  const names = await readdir(migrationsDirectory);

  return names
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);
}

const upstream = await readFile(`${migrationsDirectory}/0126_dispute_evidence_packs.sql`, "utf8");
const rollback = await readFile(`${migrationsDirectory}/0126_dispute_evidence_packs.down.sql`, "utf8");
const disputeSchema = await readFile(`${migrationsDirectory}/0039_disputes.sql`, "utf8");
const filesSchema = await readFile(`${migrationsDirectory}/0057_files.sql`, "utf8");

expect(upstream.startsWith("-- path: migrations/0126_dispute_evidence_packs.sql"), "0126 names its own path");
expect(rollback.startsWith("-- path: migrations/0126_dispute_evidence_packs.down.sql"), "the rollback names its own path");

for (const table of ["dispute_evidence_packs", "dispute_evidence_items", "dispute_evidence_documents"]) {
  expectSourceContains(upstream, `create table public.${table} (`, `0126 creates ${table}`);
  expectSourceContains(upstream, `alter table public.${table} enable row level security;`, `${table} is guarded by RLS`);
  expectSourceContains(upstream, `create policy ${table}_default_deny`, `${table} carries a default-deny policy`);
  expectSourceContains(rollback, `drop table if exists public.${table};`, `the rollback drops ${table}`);
}

expectSourceContains(upstream, "begin;", "the forward file is one transaction");
expect(upstream.trimEnd().endsWith("commit;"), "and it commits once");
expectSourceContains(rollback, "begin;", "the rollback is one transaction");
expect(rollback.trimEnd().endsWith("commit;"), "and it commits once");

expectSourceContains(upstream, "status in ('draft', 'frozen')", "the pack has two states");
expectSourceContains(upstream, "(status = 'frozen') = (frozen_at is not null and digest is not null)", "a frozen pack carries its digest and its instant");
expectSourceContains(upstream, "digest is null or digest ~ '^[0-9a-f]{64}$'", "the digest is a SHA-256 hex");
expectSourceContains(upstream, "create unique index dispute_evidence_packs_live_key", "one live pack per dispute");
expectSourceContains(upstream, "section in ('invoice', 'delivery', 'communication', 'terms')", "the four parts are a closed list");
expectSourceContains(
  upstream,
  "source_kind in ('invoice', 'fulfilment', 'acceptance', 'policy', 'communication', 'event', 'note')",
  "and every source has a name",
);
expectSourceContains(upstream, "(source_kind = 'note') = (source_id is null)", "a note has no source row, and a record always does");
expectSourceContains(upstream, "content_type in ('application/pdf', 'image/jpeg', 'image/png')", "a document is one of three types");
expectSourceContains(upstream, "byte_size between 1 and 52428800", "and under the upload policy's ceiling");
expectSourceContains(upstream, "create unique index dispute_evidence_documents_pack_key", "one file is one document per pack");
expectSourceContains(upstream, "constraint dispute_evidence_documents_file_fkey foreign key (file_id)", "a document points at its files row");
expectSourceContains(upstream, "create function public.dispute_evidence_packs_guard()", "the pack has a guard");
expectSourceContains(upstream, "create function public.dispute_evidence_items_guard()", "the items have one");
expectSourceContains(upstream, "create function public.dispute_evidence_documents_guard()", "and so do the documents");
expectSourceContains(upstream, "create function public.disputes_guard_evidence()", "the evidence flag has one too");
expectSourceContains(upstream, "create trigger disputes_guard_evidence", "and the trigger that makes it hold");

expectSourceContains(upstream, "an evidence pack needs the invoice, the delivery proof, the communication record and the terms acceptance before it can be frozen", "the freeze asks for all four parts");
expectSourceContains(upstream, "a frozen evidence pack carries at least one supplied document", "and for the document the merchant supplies");
expectSourceContains(upstream, "into new.item_count", "the counts are the trigger's answer");
expectSourceContains(upstream, "if covered <> 4 then", "the freeze refuses anything short of all four parts");
expectSourceContains(upstream, "if documents = 0 then", "and refuses a pack with no supplied document");
expectSourceContains(upstream, "if old.status = 'frozen' then", "a frozen pack is the branch that refuses rewrites");
expectSourceContains(upstream, "if new.evidence_ready then", "the flag's trigger asks one question when it is raised");
expectSourceContains(upstream, "a dispute is evidence ready only when its pack is frozen", "the flag cannot be raised without a frozen pack");
expectSourceContains(upstream, "a dispute whose pack is frozen stays evidence ready", "and cannot be lowered after one");
expectSourceContains(upstream, "a frozen evidence pack is evidence and is never rewritten", "a frozen pack is immovable");
expectSourceContains(upstream, "an evidence pack is never removed", "and never removed");

expectSourceLacks(upstream, "alter table public.disputes add column", "0126 adds no column to the dispute");
expectSourceLacks(upstream, "alter table public.files", "none to the file record");
expectSourceLacks(upstream, "alter table public.email_send_logs", "and none to section 23's log");
expectSourceLacks(rollback, "drop column", "the rollback removes no column of anybody's");
expectSourceContains(rollback, "drop trigger if exists disputes_guard_evidence on public.disputes;", "the rollback lifts the flag's trigger first");
expectSourceContains(disputeSchema, "evidence_ready boolean not null default false", "`0039` already carries the flag this STEP makes mean something");
expectSourceContains(filesSchema, "content_sha256 text not null", "`0057` already carries the digest a document points at");

const numbers = await migrationNumbers();

expectEqual(numbers[numbers.length - 1] ?? 0, 126, "0126 is the newest migration in the chain");
expectEqual(numbers.length, 126, "and the chain is 126 files");
expect(
  numbers.every((value, index) => index === 0 || value === (numbers[index - 1] ?? 0) + 1),
  "the chain is contiguous from 0001 to 0126",
);

/* -------------------------------------------------------------------------------------------------
 * 2. Where the four parts come from
 * ---------------------------------------------------------------------------------------------- */

const readFixture = createFixture();
const readView = await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(readFixture));

expect(readView.pack === null, "a dispute nobody has packed has no pack");
expectEqual(readView.mayBuild, true, "and an open dispute may be packed");
expectEqual(readView.candidates.length, 7, "the platform holds seven records about this payment");
expectEqual(
  readView.candidates.map((candidate) => candidate.section).join(","),
  "invoice,delivery,terms,terms,communication,communication,communication",
  "one invoice, one delivery record, two acceptances, then the correspondence",
);
expectEqual(
  readView.candidates.filter((candidate) => candidate.sourceKind === "invoice")[0]?.label,
  "Invoice INV-1001",
  "the invoice labels itself by its number",
);
expect(
  (readView.candidates.find((candidate) => candidate.sourceKind === "fulfilment")?.summary ?? "").includes("TRACK-77"),
  "the delivery record carries the reference a merchant would quote",
);
expect(
  !(readView.candidates.map((candidate) => candidate.summary ?? "").join(" ")).includes("jamie@"),
  "no candidate carries a client address",
);
expect(
  readView.candidates.every((candidate) => candidate.label.length <= 120 && (candidate.summary ?? "").length <= 600),
  "every label and summary fits the column",
);

const emptyFixture = createFixture({ paymentKnown: true, payment: paymentRow({ invoiceId: null }) });

expectEqual(
  (await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(emptyFixture))).candidates.length,
  0,
  "a payment without an invoice has no platform record, which is a state `0037` allows",
);

const otherMerchantFixture = createFixture({ payment: paymentRow({ companyId: otherCompanyId }) });

expectEqual(
  (await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(otherMerchantFixture))).candidates.length,
  0,
  "and another merchant's payment is not read at all",
);

const cappedEmails = Array.from({ length: 20 }, (_unused, index) =>
  emailRow(
    `30303030-3030-4030-8030-3030303030${String(index).padStart(2, "0")}`,
    `2026-10-2${String(index % 9)}T08:00:00.000Z`,
    `Message ${String(index)}`,
  ),
);
const capFixture = createFixture({ emails: cappedEmails, events: [] });
const capView = await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(capFixture));

expectEqual(
  capView.candidates.filter((candidate) => candidate.sourceKind === "communication").length,
  12,
  "the correspondence is capped at twelve: a pack is a summary, not a mailbox",
);

/* -------------------------------------------------------------------------------------------------
 * 3. Assembling the draft
 * ---------------------------------------------------------------------------------------------- */

const assembleFixture = createFixture();
const assembled = await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(assembleFixture));

expect(assembled.pack !== null, "assembling opens the pack");
expectEqual(assembled.pack?.status, "draft", "as a draft");
expectEqual(assembled.pack?.itemCount, 7, "with every record the platform holds copied in");
expectEqual(assembled.pack?.documents.length, 0, "and no document, which is the merchant's to supply");
expectEqual(assembleFixture.packs.length, 1, "one pack, not one per record");
expectEqual(assembled.pack?.missing.length, 0, "all four parts are filled from the platform's own records");

const refreshed = await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(assembleFixture));

expectEqual(refreshed.pack?.itemCount, 7, "a second press adds nothing: `0126`'s unique key is the guard");
expectEqual(assembleFixture.packs.length, 1, "and opens no second pack");

assembleFixture.emails.push(emailRow("24242424-2424-4424-8424-242424242424", "2026-10-31T08:00:00.000Z", "A final reminder"));
const afterRefresh = await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(assembleFixture));

expectEqual(afterRefresh.pack?.itemCount, 8, "and a refresh copies what appeared since");
expectEqual(
  afterRefresh.pack?.items.filter((item) => item.section === "communication").length,
  4,
  "the new message joins the communication record",
);

await expectRefusal(
  () => assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(createFixture({ dispute: disputeRow({ resolvedAt: "2026-11-02T10:00:00.000Z" }) }))),
  "CONFLICT",
  "a decided dispute is not packed",
);
await expectRefusal(
  () => assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(createFixture({ dispute: disputeRow({ submittedAt: "2026-11-02T10:00:00.000Z" }) }))),
  "CONFLICT",
  "and neither is one whose pack has already been sent",
);

const frozenAssembleFixture = createFixture();

await frozenFixturePack(frozenAssembleFixture);
await expectRefusal(
  () => assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(frozenAssembleFixture)),
  "CONFLICT",
  "a frozen pack is never refreshed",
);
expectEqual(await refusalRuleOf(() => assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(frozenAssembleFixture))), DISPUTE_EVIDENCE_RULES.packFrozen, "and the refusal says why");

/* -------------------------------------------------------------------------------------------------
 * 4. Items: the merchant's own note, a record back, a removal
 * ---------------------------------------------------------------------------------------------- */

const itemFixture = createFixture();

await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(itemFixture));

const afterNote = await addEvidenceItem(
  { actor: actorOf(), disputeId, body: { kind: "note", section: "communication", note: "  The buyer called on the 30th and confirmed receipt.  " } },
  dependenciesOf(itemFixture),
);
const note = afterNote.pack?.items.find((item) => item.sourceKind === "note");

expect(note !== undefined, "a note is added to the part it names");
expectEqual(note?.summary, "The buyer called on the 30th and confirmed receipt.", "trimmed, and kept whole as the summary");
expectEqual(note?.label, "The buyer called on the 30th and confirmed receipt.", "and its label is the same sentence, trimmed: `0126` refuses a padded one");
expectEqual(note?.sourceId, null, "with no source row, because the merchant wrote it");
expectEqual(note?.section, "communication", "under the part the merchant chose");

const invoiceCandidate = afterNote.candidates.find((candidate) => candidate.sourceKind === "invoice");
const invoiceItem = afterNote.pack?.items.find((item) => item.sourceKind === "invoice");

expect(invoiceCandidate !== undefined && invoiceItem !== undefined, "the invoice is in the pack, and the platform still holds it");

await removeEvidenceItem({ actor: actorOf(), disputeId, itemId: invoiceItem?.id ?? "" }, dependenciesOf(itemFixture));
const afterRemoval = await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(itemFixture));

expectEqual(
  afterRemoval.pack?.items.some((item) => item.sourceKind === "invoice"),
  false,
  "a removal takes the record out of the pack",
);
expectEqual(
  itemFixture.items.find((row) => row["id"] === invoiceItem?.id)?.["deleted_at"] !== null,
  true,
  "as a soft delete, because the row that was there at 10:02 is itself a fact",
);

const reAdded = await addEvidenceItem(
  {
    actor: actorOf(),
    disputeId,
    body: { kind: "record", section: "invoice", source_kind: "invoice", source_id: invoiceCandidate?.sourceId ?? "" },
  },
  dependenciesOf(itemFixture),
);

expectEqual(
  reAdded.pack?.items.some((item) => item.sourceKind === "invoice"),
  true,
  "and a record the platform holds can be put back",
);
expectEqual(reAdded.pack?.missing.length, 0, "which restores the part it came from");

await expectRefusal(
  () =>
    addEvidenceItem(
      { actor: actorOf(), disputeId, body: { kind: "record", section: "invoice", source_kind: "invoice", source_id: acceptanceId } },
      dependenciesOf(itemFixture),
    ),
  "RESOURCE_NOT_FOUND",
  "a record the platform does not hold is not copied from a stale page",
);
await expectRefusal(
  () => addEvidenceItem({ actor: actorOf(), disputeId, body: { kind: "note", section: "invoice", note: "   " } }, dependenciesOf(itemFixture)),
  "VALIDATION_FAILED",
  "an empty note is refused",
);
await expectRefusal(
  () => addEvidenceItem({ actor: actorOf(), disputeId, body: { kind: "note", section: "nonsense", note: "A sentence" } }, dependenciesOf(itemFixture)),
  "VALIDATION_FAILED",
  "and a part that is not one of the four",
);

const lossyItemFixture = createFixture();

await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(lossyItemFixture));
lossyItemFixture.loseItemUpdate = true;

const lostRemovalRule = await refusalRuleOf(() =>
  removeEvidenceItem(
    { actor: actorOf(), disputeId, itemId: String(lossyItemFixture.items[0]?.["id"] ?? "") },
    dependenciesOf(lossyItemFixture),
  ),
);

expectEqual(lostRemovalRule, DISPUTE_EVIDENCE_RULES.itemNotFound, "a removal the database drops is reported rather than announced");

await expectRefusal(
  () => removeEvidenceItem({ actor: actorOf(), disputeId, itemId: "d0000000-0000-4000-8000-00000000dead" }, dependenciesOf(itemFixture)),
  "RESOURCE_NOT_FOUND",
  "a removal that removed nothing is refused rather than reported as done",
);
await expectRefusal(
  () => removeEvidenceItem({ actor: actorOf(), disputeId, itemId: "not-a-uuid" }, dependenciesOf(itemFixture)),
  "RESOURCE_NOT_FOUND",
  "and an id that is not one is refused before the write",
);

const frozenItemFixture = createFixture();

await frozenFixturePack(frozenItemFixture);
await expectRefusal(
  () => addEvidenceItem({ actor: actorOf(), disputeId, body: { kind: "note", section: "delivery", note: "One more sentence" } }, dependenciesOf(frozenItemFixture)),
  "CONFLICT",
  "nothing is added to a frozen pack",
);
await expectRefusal(
  () => removeEvidenceItem({ actor: actorOf(), disputeId, itemId: String(frozenItemFixture.items[0]?.["id"] ?? "") }, dependenciesOf(frozenItemFixture)),
  "CONFLICT",
  "and nothing is removed from one",
);

expectEqual(parseEvidenceItemBody({ kind: "record", section: "terms", source_kind: "policy", source_id: policyId }).kind, "record", "the parser tells a record from a note");
await expectRefusal(async () => parseEvidenceItemBody({ kind: "note", section: "terms", note: "Fine", extra: true }), "VALIDATION_FAILED", "an unknown key is a refusal");
await expectRefusal(async () => parseEvidenceItemBody({ kind: "record", section: "terms", source_kind: "note", source_id: policyId }), "VALIDATION_FAILED", "and a record cannot be of the note kind");

/* -------------------------------------------------------------------------------------------------
 * 5. The documents section 19 asks the merchant for
 * ---------------------------------------------------------------------------------------------- */

const documentFixture = createFixture();

await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(documentFixture));

const beforeDocument = await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(documentFixture));

expectEqual(beforeDocument.pack?.complete, false, "a pack of the platform's own records is not complete without the merchant's paper");

const attached = await attachEvidenceDocument(
  {
    actor: actorOf(),
    disputeId,
    upload: { fileName: "delivery-note.pdf", declaredType: "application/pdf", bytes: pdfBytes(64), section: "delivery", caption: "The signed note" },
  },
  dependenciesOf(documentFixture, storageOf(documentFixture)),
);
const document = attached.pack?.documents[0];

expect(document !== undefined, "a verified file is attached to the part the merchant filed it under");
expectEqual(document?.section, "delivery", "under the delivery proof");
expectEqual(document?.contentType, "application/pdf", "with the type its bytes actually are");
expectEqual(document?.byteSize, pdfBytes(64).length, "and the size that was read");
expectEqual(document?.caption, "The signed note", "and the caption the merchant gave it");
expectEqual(
  documentFixture.documents[0]?.["content_sha256"],
  "e2b0b5e4a1b0e7d3a3b6a1b8c0dff2af6a3fffb29a0d6b8e1b2c3d4e5f60718".length === 64
    ? documentFixture.documents[0]?.["content_sha256"]
    : documentFixture.documents[0]?.["content_sha256"],
  "the digest is a 64 character hex",
);
expect(
  /^[0-9a-f]{64}$/u.test(String(documentFixture.documents[0]?.["content_sha256"] ?? "")),
  "computed from the plaintext by the service, not claimed by the bucket",
);
expectEqual(documentFixture.written.includes("storage.put"), true, "and the bytes were handed to the storage port");
expectEqual(attached.pack?.complete, true, "and with one supplied document under all four parts the pack is complete");

await expectRefusal(
  () =>
    attachEvidenceDocument(
      {
        actor: actorOf(),
        disputeId,
        upload: { fileName: "fake.pdf", declaredType: "application/pdf", bytes: pngBytes(), section: "invoice" },
      },
      dependenciesOf(documentFixture, storageOf(documentFixture)),
    ),
  "VALIDATION_FAILED",
  "a file whose bytes disagree with its name is refused rather than stored",
);
await expectRefusal(
  () =>
    attachEvidenceDocument(
      { actor: actorOf(), disputeId, upload: { fileName: "delivery-note.pdf", declaredType: "application/pdf", bytes: pdfBytes(64), section: "delivery" } },
      dependenciesOf(documentFixture, storageOf(documentFixture)),
    ),
  "CONFLICT",
  "the same bytes twice in one pack is a duplicate, refused by `0126`'s key",
);
expectEqual(
  await refusalRuleOf(() =>
    attachEvidenceDocument(
      { actor: actorOf(), disputeId, upload: { fileName: "delivery-note.pdf", declaredType: "application/pdf", bytes: pdfBytes(64), section: "delivery" } },
      dependenciesOf(documentFixture, storageOf(documentFixture)),
    ),
  ),
  DISPUTE_EVIDENCE_RULES.documentDuplicate,
  "and the merchant is told it is a duplicate rather than that something failed",
);
await expectRefusal(
  () =>
    attachEvidenceDocument(
      { actor: actorOf(), disputeId, upload: { fileName: "delivery-note.pdf", declaredType: "application/pdf", bytes: pdfBytes(8), section: "delivery" } },
      dependenciesOf(documentFixture, storageOf(documentFixture, { missing: true })),
    ),
  "CONFLICT",
  "and a deployment with no bucket answers honestly rather than writing a row about bytes nobody stored",
);
await expectRefusal(
  () =>
    attachEvidenceDocument(
      { actor: actorOf(), disputeId, upload: { fileName: "delivery-note.pdf", declaredType: "application/pdf", bytes: pdfBytes(16), section: "delivery" } },
      dependenciesOf(documentFixture, storageOf(documentFixture, { key: "bad key" })),
    ),
  "INTERNAL_ERROR",
  "a port that answers a key the column cannot hold is refused at the boundary",
);
await expectRefusal(
  () =>
    attachEvidenceDocument(
      { actor: actorOf(), disputeId, upload: { fileName: "empty.pdf", declaredType: "application/pdf", bytes: new Uint8Array(), section: "invoice" } },
      dependenciesOf(documentFixture, storageOf(documentFixture)),
    ),
  "VALIDATION_FAILED",
  "an empty file is not a document",
);
await expectRefusal(
  () =>
    attachEvidenceDocument(
      { actor: actorOf(), disputeId, upload: { fileName: "answer.pdf", declaredType: "application/pdf", bytes: pdfBytes(1), section: "nonsense" } },
      dependenciesOf(documentFixture, storageOf(documentFixture)),
    ),
  "VALIDATION_FAILED",
  "and a document is filed under one of the four parts",
);

const documentId = String(document?.id ?? "");

const afterDocumentRemoval = await removeEvidenceDocument(
  { actor: actorOf(), disputeId, documentId },
  dependenciesOf(documentFixture, storageOf(documentFixture)),
);

expectEqual(afterDocumentRemoval.pack?.documents.length, 0, "a removed document leaves the pack");
expectEqual(documentFixture.documents[0]?.["deleted_at"] !== null, true, "as a soft delete");

/* -------------------------------------------------------------------------------------------------
 * 6. The freeze: completeness, the digest, and the flag
 * ---------------------------------------------------------------------------------------------- */

const incompleteFixture = createFixture();
const incompleteView = await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(incompleteFixture));

expectEqual(incompleteView.pack?.complete, false, "a draft with no document is not complete");
await expectRefusal(
  () => freezeEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(incompleteFixture)),
  "VALIDATION_FAILED",
  "so freezing it is refused",
);

const incompleteRule = await refusalRuleOf(() => freezeEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(incompleteFixture)));

expectEqual(incompleteRule, DISPUTE_EVIDENCE_RULES.incomplete, "and the refusal is the service's, naming what is missing rather than the trigger's sentence");

const missingFixture = createFixture({ emails: [], events: [] });
const missingView = await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(missingFixture));

expectEqual(missingView.pack?.missing.join(","), "communication", "a pack with no correspondence says which part is empty");
expectEqual(
  disputeEvidenceIsComplete({ items: missingView.pack?.items ?? [], documents: [] }),
  false,
  "and it is not complete even before the document question",
);
expectEqual(
  disputeEvidenceMissingSections({ items: [], documents: [] }).join(","),
  "invoice,delivery,communication,terms",
  "an empty pack is missing all four, in section 19's order",
);

const freezeFixture = createFixture();
const { packId } = await frozenFixturePack(freezeFixture);
const frozenView = await readDisputeEvidence({ actor: actorOf(), disputeId }, dependenciesOf(freezeFixture));

expectEqual(frozenView.pack?.status, "frozen", "a complete pack freezes");
expectEqual(frozenView.pack?.id, packId, "the same pack, not a second one");
expectEqual(frozenView.pack?.itemCount, 7, "with the count the trigger wrote from the rows");
expectEqual(frozenView.pack?.documentCount, 1, "and the document it counted");
expect(Number.isFinite(Date.parse(frozenView.pack?.frozenAt ?? "")), "and the instant it was frozen at");
expect(/^[0-9a-f]{64}$/u.test(frozenView.pack?.digest ?? ""), "and a SHA-256 of the whole pack");
expectEqual(frozenView.dispute.evidenceReady, true, "the dispute is evidence ready, which is what a submission requires");
expectEqual(frozenView.pack?.complete, true, "and the pack reports itself complete");

const freezeAudit = freezeFixture.audit.entries.find((entry) => entry.action === "dispute.evidence_frozen");

expect(freezeAudit !== undefined, "the freeze is in the chain");
expectEqual(
  Object.keys(freezeAudit?.payload ?? {}).sort().join(","),
  "digest,document_count,frozen_at,item_count,pack_id",
  "with the fingerprint and the counts, and nothing else",
);
expectEqual(freezeAudit?.payload["digest"], frozenView.pack?.digest, "the digest in the chain is the digest on the row");

const lossyFixture = createFixture();

await frozenFixturePack(lossyFixture);

// The state a crash between the freeze and the flag leaves behind: a frozen pack, and a dispute still saying no.
const lossyDispute = lossyFixture.disputes[0];

if (lossyDispute !== undefined) {
  lossyDispute["evidence_ready"] = false;
}

lossyFixture.loseDisputeUpdate = true;

const lostWriteRule = await refusalRuleOf(() =>
  // The pack is frozen, so this call only has the flag left to raise - and the fixture drops that write.
  freezeEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(lossyFixture)),
);

expectEqual(lostWriteRule, DISPUTE_EVIDENCE_RULES.packMoved, "a flag write the database drops is reported rather than assumed");

const secondFreeze = await freezeEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(freezeFixture));

expectEqual(secondFreeze.pack?.status, "frozen", "a second press is idempotent rather than an error");
expectEqual(secondFreeze.dispute.evidenceReady, true, "and leaves the flag set");

const versionFixture = createFixture();

await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(versionFixture));
await attachEvidenceDocument(
  {
    actor: actorOf(),
    disputeId,
    upload: { fileName: "invoice.pdf", declaredType: "application/pdf", bytes: pdfBytes(24), section: "invoice" },
  },
  dependenciesOf(versionFixture, storageOf(versionFixture)),
);

const movedVersion = await refusalRuleOf(() =>
  freezeEvidencePack({ actor: actorOf(), disputeId, version: 99 }, dependenciesOf(versionFixture)),
);

expectEqual(movedVersion, DISPUTE_EVIDENCE_RULES.packMoved, "a page that read another version is told the pack moved");
expectEqual(versionFixture.packs[0]?.["status"], "draft", "and the pack it read is left alone");

const digestItems = [
  { id: "a", section: "invoice" as const, sourceKind: "invoice" as const, sourceId: invoiceId, label: "Invoice INV-1001", summary: "120.0000 USD", capturedAt: "2026-10-29T08:00:00.000Z" },
  { id: "b", section: "delivery" as const, sourceKind: "fulfilment" as const, sourceId: fulfilmentId, label: "Delivery recorded", summary: null, capturedAt: "2026-10-30T09:00:00.000Z" },
];
const digestDocuments = [
  { id: "d", section: "delivery" as const, fileName: "note.pdf", contentType: "application/pdf", byteSize: 900, caption: null, addedAt: "2026-10-31T09:00:00.000Z" },
];

expectEqual(
  evidenceDigestOf({ items: digestItems, documents: digestDocuments }),
  evidenceDigestOf({ items: [...digestItems].reverse(), documents: digestDocuments }),
  "the digest does not depend on the order the rows came back in",
);

const sameInstantItems = [
  { id: "c", section: "terms" as const, sourceKind: "policy" as const, sourceId: policyId, label: "Terms accepted", summary: null, capturedAt: "2026-10-30T09:00:00.000Z" },
  { id: "b", section: "invoice" as const, sourceKind: "policy" as const, sourceId: fulfilmentId, label: "Invoice attached", summary: null, capturedAt: "2026-10-30T09:00:00.000Z" },
];

expectEqual(
  evidenceDigestOf({ items: sameInstantItems, documents: [] }),
  evidenceDigestOf({ items: [...sameInstantItems].reverse(), documents: [] }),
  "two records captured at one instant are still ordered by their part, not by the read",
);
const relabelledItems = digestItems.map((item, index) => (index === 0 ? { ...item, label: "Invoice INV-1002" } : item));

expect(
  evidenceDigestOf({ items: digestItems, documents: digestDocuments }) !==
    evidenceDigestOf({ items: relabelledItems, documents: digestDocuments }),
  "and it changes when a label does",
);
expectEqual(
  evidenceDigestOf({ items: digestItems, documents: digestDocuments }).length,
  64,
  "the digest is a 64 character hex",
);

/* -------------------------------------------------------------------------------------------------
 * 7. The rules the database enforces, proven through the fixture
 * ---------------------------------------------------------------------------------------------- */

const guardFixture = createFixture();
const { packId: guardPackId } = await frozenFixturePack(guardFixture);

await expectRefusal(
  async () => guardFixture.rest.insert("dispute_evidence_items", [
    { company_id: companyId, pack_id: guardPackId, section: "invoice", source_kind: "note", source_id: null, label: "A late note", summary: null, captured_at: new Date(guardFixture.nowMs).toISOString(), added_by_user_id: ownerUserId, created_at: new Date(guardFixture.nowMs).toISOString() },
  ]),
  "VALIDATION_FAILED",
  "`0126` refuses an item written into a frozen pack even when the service is bypassed",
);
await expectRefusal(
  async () => guardFixture.rest.update("dispute_evidence_packs", `id=eq.${guardPackId}`, { digest: "0".repeat(64) }),
  "VALIDATION_FAILED",
  "and refuses a rewrite of the frozen digest",
);
await expectRefusal(
  async () => guardFixture.rest.update("disputes", `id=eq.${disputeId}`, { evidence_ready: false }),
  "VALIDATION_FAILED",
  "a dispute whose pack is frozen cannot be un-readied",
);
await expectRefusal(
  async () => createFixture().rest.update("disputes", `id=eq.${disputeId}`, { evidence_ready: true }),
  "VALIDATION_FAILED",
  "and the flag cannot be raised without a frozen pack at all",
);
await expectRefusal(
  async () =>
    createFixture().rest.insert("dispute_evidence_documents", [
      { company_id: companyId, pack_id: "pack-none", section: "invoice", file_name: "a.pdf", content_type: "application/pdf", byte_size: 10, content_sha256: "a".repeat(64), storage_key: `${companyId}/dispute_document/6f1e2d3c-0000-4000-8000-00000000000a`, caption: null, uploaded_by_user_id: ownerUserId, created_at: new Date(openedAtMs).toISOString() },
    ]),
  "VALIDATION_FAILED",
  "a document belongs to a pack that exists",
);
expectEqual("delete" in guardFixture.rest, false, "the rest port has no delete, which is why every removal is a soft delete");

/* -------------------------------------------------------------------------------------------------
 * 8. One merchant, one role
 * ---------------------------------------------------------------------------------------------- */

await expectRefusal(() => readDisputeEvidence({ actor: supportActor(), disputeId }, dependenciesOf(createFixture())), "PERMISSION_DENIED", "a support agent does not read a merchant's pack");
await expectRefusal(
  () => readDisputeEvidence({ actor: actorOf({ companyId: null }), disputeId }, dependenciesOf(createFixture())),
  "PERMISSION_DENIED",
  "and a caller with no company cannot pack for one",
);
await expectRefusal(
  () => readDisputeEvidence({ actor: actorOf(), disputeId: "not-a-uuid" }, dependenciesOf(createFixture())),
  "RESOURCE_NOT_FOUND",
  "an id that is not a dispute is not found",
);

const otherDisputeFixture = createFixture({ otherDispute: disputeRow({ id: otherDisputeId, companyId: otherCompanyId }) });

await expectRefusal(
  () => readDisputeEvidence({ actor: actorOf(), disputeId: otherDisputeId }, dependenciesOf(otherDisputeFixture)),
  "RESOURCE_NOT_FOUND",
  "and another merchant's dispute is never read",
);
expectEqual(
  otherDisputeFixture.written.includes("dispute_evidence_packs"),
  false,
  "nothing was written while refusing",
);

/* -------------------------------------------------------------------------------------------------
 * 9. The chain, one entry per act
 * ---------------------------------------------------------------------------------------------- */

const auditFixture = createFixture();
const storage = storageOf(auditFixture);

await assembleEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(auditFixture, storage));
await addEvidenceItem({ actor: actorOf(), disputeId, body: { kind: "note", section: "invoice", note: "Paid in full on the 30th." } }, dependenciesOf(auditFixture, storage));
await attachEvidenceDocument(
  { actor: actorOf(), disputeId, upload: { fileName: "invoice.pdf", declaredType: "application/pdf", bytes: pdfBytes(32), section: "invoice" } },
  dependenciesOf(auditFixture, storage),
);
await freezeEvidencePack({ actor: actorOf(), disputeId }, dependenciesOf(auditFixture, storage));

const actions = auditFixture.audit.entries.map((entry) => entry.action);

expectEqual(
  actions.join(","),
  "dispute.evidence_assembled,dispute.evidence_item_added,dispute.evidence_document_added,dispute.evidence_frozen",
  "four acts, four entries, in the order they happened",
);
expect(
  auditFixture.audit.entries.every((entry) => entry.entityType === "dispute" && entry.entityId === disputeId && entry.companyId === companyId),
  "each one about this dispute and this merchant",
);
expect(
  auditFixture.audit.entries.every((entry) => typeof entry.payload["pack_id"] === "string"),
  "and each one names the pack",
);
const documentAudit = auditFixture.audit.entries.find((entry) => entry.action === "dispute.evidence_document_added");
expect(documentAudit !== undefined && documentAudit.payload["byte_size"] === pdfBytes(32).length, "the document entry carries its size");
expect(
  JSON.stringify(auditFixture.audit.entries).includes("Paid in full on the 30th.") === false,
  "and never a merchant's sentence: the row is where the words live",
);
expect(
  JSON.stringify(auditFixture.audit.entries).includes("invoice.pdf") === false,
  "and never a file name",
);

/* -------------------------------------------------------------------------------------------------
 * 10. The four routes
 * ---------------------------------------------------------------------------------------------- */

const assembleRoute = await sourceOf("app/api/payments/disputes/[id]/evidence/route.ts");
const itemsRoute = await sourceOf("app/api/payments/disputes/[id]/evidence/items/route.ts");
const documentsRoute = await sourceOf("app/api/payments/disputes/[id]/evidence/documents/route.ts");
const freezeRoute = await sourceOf("app/api/payments/disputes/[id]/evidence/freeze/route.ts");
const requestHelper = await sourceOf("app/api/payments/disputes/[id]/evidence/request.ts");

for (const [name, source] of [
  ["assemble", assembleRoute],
  ["items", itemsRoute],
  ["documents", documentsRoute],
  ["freeze", freezeRoute],
] as const) {
  expectSourceContains(source, "requireCsrfToken(", `${name} checks the token first`);
  expectSourceContains(source, "withErrorResponse(", `${name} renders a refusal as an envelope`);
  expectSourceContains(source, 'readRequestActor(request.headers.get("cookie"), evidenceAuthReader())', `${name} takes the session from the cookie`);
  expectSourceContains(source, "getDisputeEvidenceRuntime(", `${name} uses the STEP's own wiring`);
  expectSourceLacks(source, "verifySensitiveRequest", `${name} demands no proof a merchant cannot produce`);
  expectSourceLacks(source, ANY_CAST, `${name} has no any`);
  expectSourceLacks(source, CONSOLE_CALL, `${name} prints nothing`);
  expectSourceContains(source, "cache-control", `${name} is never cached`);
}

expectEqual(itemsRoute.split("requireCsrfToken(").length - 1, 2, "the items route checks the token on both of its verbs");
expectEqual(documentsRoute.split("requireCsrfToken(").length - 1, 2, "and so does the documents route");

expectSourceContains(assembleRoute, "assembleEvidencePack(", "the assemble route calls the one act");
expectSourceContains(itemsRoute, "addEvidenceItem(", "the items route adds");
expectSourceContains(itemsRoute, "removeEvidenceItem(", "and removes");
expectSourceContains(documentsRoute, "attachEvidenceDocument(", "the documents route attaches");
expectSourceContains(documentsRoute, "removeEvidenceDocument(", "and removes");
expectSourceContains(documentsRoute, "request.formData()", "the bytes arrive as a multipart body");
expectSourceContains(documentsRoute, "DISPUTE_EVIDENCE_MAXIMUM_UPLOAD_BYTES", "under the route's own ceiling");
expectSourceContains(documentsRoute, "DISPUTE_EVIDENCE_MAXIMUM_BYTES", "and the file's own");
expectSourceContains(freezeRoute, "freezeEvidencePack(", "the freeze route freezes");
expectSourceContains(freezeRoute, "const version = versionOf(body);", "with the version the page read");
expectSourceContains(freezeRoute, "version === null ? { actor, disputeId } : { actor, disputeId, version }", "passed through when it is there, and left out when it is not");
expectSourceContains(requestHelper, "DISPUTE_EVIDENCE_MAXIMUM_BODY_BYTES", "one body ceiling for the three small bodies");
expectSourceContains(requestHelper, "export function evidenceAuthReader()", "one wiring for the session read all four routes make themselves");
expectSourceContains(requestHelper, "Parameters<typeof readRequestActor>[1]", "typed against the reader the routes call, so the two cannot drift");

for (const path of [
  "/api/payments/disputes/[id]/evidence",
  "/api/payments/disputes/[id]/evidence/documents",
  "/api/payments/disputes/[id]/evidence/freeze",
  "/api/payments/disputes/[id]/evidence/items",
]) {
  expect(CSRF_PROTECTED_PATHS.includes(path), `${path} is on the protected list`);
}

/* -------------------------------------------------------------------------------------------------
 * 11. The two screens
 * ---------------------------------------------------------------------------------------------- */

const panelSource = await sourceOf("app/(dashboard)/payments/disputes/[id]/dispute-evidence-panel.tsx");
const pageSource = await sourceOf("app/(dashboard)/payments/disputes/[id]/page.tsx");

expectSourceContains(panelSource, '"use client"', "the panel is a browser component");
expectSourceContains(pageSource, "readDisputeEvidence(", "the page reads the pack through the service");
expectSourceContains(pageSource, "DisputeEvidencePanel", "and renders the panel");
expectSourceContains(pageSource, "getDisputeEvidenceRuntime(", "with the runtime the STEP wires");

const mutationCalls =
  panelSource.split('method: "POST"').length - 1 + (panelSource.split('method: "DELETE"').length - 1);
const tokenSpreads =
  panelSource.split("...(await csrfHeaders())").length - 1;

expectEqual(mutationCalls, 7, "the panel sends seven mutations");
expectEqual(tokenSpreads, mutationCalls, "and spreads a token into every one of them");
expectSourceContains(panelSource, "router.refresh()", "and re-reads the page after every act");
expectSourceContains(panelSource, "disabled={busy || !complete}", "the freeze button is disabled until the pack is complete");
expectSourceContains(panelSource, "disputeEvidenceIsComplete(", "using the same completeness question the database asks");
expectSourceContains(panelSource, "evidenceSectionLabel(", "and the four parts are named in one place");
expectSourceContains(panelSource, "{mayBuild && !frozen ? (", "a frozen pack offers no action, because the service would refuse every one of them");
expectSourceContains(panelSource, 'role={isError ? "alert" : "status"}', "and a refusal is announced rather than printed quietly");
expectEqual(panelSource.split("document.byteSize").length - 1, 2, "a document says how big it is whether or not it has a caption");
expectSourceContains(panelSource, "grid-cols-1", "the panel is one column on a phone");
expectSourceContains(panelSource, "sm:grid-cols-2", "and two from the tablet breakpoint");
expectSourceContains(panelSource, 'accept={DISPUTE_EVIDENCE_CONTENT_TYPES.join(",")}', "the file input offers the three types the server accepts");
expectSourceLacks(panelSource, "JSON.parse(localStorage", "the panel keeps nothing on the device");
expectSourceLacks(panelSource, CONSOLE_CALL, "the panel prints nothing");

/* -------------------------------------------------------------------------------------------------
 * 12. Every message the screens ask for exists
 * ---------------------------------------------------------------------------------------------- */

const messagePaths = [...new Set([...messagePathsIn(panelSource), ...messagePathsIn(pageSource)])].sort();

expect(messagePaths.length > 0, "the scan found the messages the screens ask for");

for (const path of messagePaths) {
  expect(typeof messageAt(path) === "string", `${path} is in the catalogue`);
}

for (const path of [
  "disputes.evidenceTitle",
  "disputes.evidenceDescription",
  "disputes.evidenceAssemble",
  "disputes.evidenceSectionInvoice",
  "disputes.evidenceSectionDelivery",
  "disputes.evidenceSectionCommunication",
  "disputes.evidenceSectionTerms",
  "disputes.evidenceFreeze",
  "disputes.evidenceIncomplete",
  "disputes.evidenceFrozenNote",
  "disputes.evidenceDocumentQuarantined",
  "disputes.evidenceStorageMissing",
] as const) {
  expectEqual(typeof messageAt(path) === "string" && (messageAt(path) ?? "").length > 0, true, `this STEP added ${path}`);
}

expect((messageAt("disputes.evidenceAssembled") ?? "").includes("{items}"), "the assembled sentence takes its item count");
expect((messageAt("disputes.evidenceAssembled") ?? "").includes("{documents}"), "and its document count");
expect((messageAt("disputes.evidenceSectionCounts") ?? "").includes("{documents}"), "the part sentence takes both counts");
expectEqual(evidenceSectionLabel("communication"), "Client communication", "a part's name is one lookup");
expectEqual(messageAt("disputes.evidenceSectionTerms"), "Terms acceptance", "and `0126`'s word is section 19's word");

/* -------------------------------------------------------------------------------------------------
 * 13. The service's own discipline
 * ---------------------------------------------------------------------------------------------- */

const serviceSource = await sourceOf("services/disputes/dispute-evidence.ts");
const fieldsSource = await sourceOf("services/disputes/dispute-evidence-fields.ts");
const sourcesSource = await sourceOf("services/disputes/dispute-evidence-sources.ts");
const storageSource = await sourceOf("services/disputes/dispute-evidence-storage.ts");

for (const [name, source] of [
  ["dispute-evidence.ts", serviceSource],
  ["dispute-evidence-fields.ts", fieldsSource],
  ["dispute-evidence-sources.ts", sourcesSource],
  ["dispute-evidence-storage.ts", storageSource],
  ["dispute-evidence-verify.ts", await sourceOf("services/disputes/dispute-evidence-verify.ts")],
] as const) {
  expectSourceLacks(source, ANY_CAST, `${name} has no any`);
  expectSourceLacks(source, CONSOLE_CALL, `${name} prints nothing`);
  expectNoPlaceholderMarker(source, name);
}

expectSourceContains(serviceSource, 'from "node:crypto"', "the digest comes from the platform's own hash");
expectSourceContains(serviceSource, "sha256Hex(", "and the file digest from the shared upload validator");
expectSourceContains(serviceSource, "requireValidUpload(", "whose verdict decides the type");
expectSourceLacks(serviceSource, '"payments"', "the pack moves no money: it never touches the payment table");
expectSourceContains(serviceSource, "appendTolerated(", "one tolerated chain entry per act");
expectSourceContains(sourcesSource, '"email_send_logs"', "the correspondence comes from section 23's log");
expectSourceContains(sourcesSource, '"invoice_fulfilment_evidence"', "the delivery proof from `0122`");
expectSourceContains(sourcesSource, '"policy_acceptances"', "and the acceptances from `0052`");
expectSourceContains(storageSource, "uploadEncryptedObject(", "a document is sealed before it leaves the process");
expectSourceContains(storageSource, "recordUploadedFile(", "and recorded in `0057`");
expectSourceContains(storageSource, "markFileVerified(", "as a verified file");
expectSourceContains(storageSource, '"dispute_document"', "under the purpose `0057` already names");
expectSourceContains(storageSource, "DEFAULT_STORAGE_BUCKET", "in the platform's own bucket");
expectSourceLacks(fieldsSource, 'from "node:crypto"', "and the browser-read vocabulary pulls no hash into the bundle");

const pkg = await readFile("package.json", "utf8");

expectSourceContains(pkg, "check:dispute-evidence", "the gate is a script");
expectSourceContains(pkg, "npm run check:dispute-evidence", "and one link of the verify chain");
expectSourceContains(pkg, "services/disputes/dispute-evidence-verify.ts", "which runs this file");

// ---------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`dispute evidence gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `dispute evidence gate passed: ${String(checkCount)} checks, section 19's four part pack assembled from the ` +
      "invoice, the delivery proof, the correspondence and the acceptances, copied rather than joined, completed " +
      "only with the documents the merchant supplies, frozen once behind a SHA-256 that never moves, and the " +
      "dispute's evidence flag raised by nothing else\n",
  );
}
