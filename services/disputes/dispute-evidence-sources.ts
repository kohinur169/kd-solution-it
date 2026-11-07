// path: services/disputes/dispute-evidence-sources.ts
import { z } from "zod";
import type { RestClient } from "../../lib/auth/rest.ts";
import { formatMessage } from "../../lib/i18n/messages.ts";
import { priceFromMinor } from "../products/price.ts";
import {
  DISPUTE_EVIDENCE_CANDIDATE_LIMITS,
  DISPUTE_EVIDENCE_LABEL_PATHS,
  DISPUTE_EVIDENCE_SECTION_OF,
  type DisputeEvidenceRecordKind,
  type DisputeEvidenceSection,
} from "./dispute-evidence-fields.ts";

/**
 * Where the four parts of section 19's pack come from.
 *
 * The sentence is a list: "invoice, delivery proof, client communication record and terms acceptance
 * record". Each of those four already exists somewhere in this platform, and this module is the one place
 * that knows where - the invoice in `0018`, the fulfilment evidence and the buyer's confirmation in `0122`,
 * the correspondence in `0061`'s email log and `0024`'s invoice events, the acceptances in `0025` and
 * `0052`. The builder copies what it finds; nothing here writes.
 *
 * ## Why the reads are per source rather than one join
 *
 * A dispute names a payment, a payment names an invoice, and an invoice names a client. A single join would
 * be one query and five `coalesce` columns, and it would return nothing at all for the case that matters
 * most: a payment created without an invoice (`0037` allows it), where the pack must still be assembled from
 * the documents the merchant supplies. Six small reads answer, per section, "what do we hold", and each one
 * can be absent without taking the others with it.
 *
 * ## Why a candidate is a finished sentence and not a row
 *
 * An item in the pack is a copy: the label, the summary and the instant, frozen at the moment the merchant
 * added it. So the copy is made here, once, and the pack never joins again. A corrected invoice or a
 * re-recorded delivery changes the source and not the evidence that was already assembled from it - which is
 * the whole point of a pack in a chargeback.
 */

/** One record the platform holds, ready to be copied into a pack. */
export interface DisputeEvidenceCandidate {
  readonly section: DisputeEvidenceSection;
  readonly sourceKind: DisputeEvidenceRecordKind;
  readonly sourceId: string;
  /** One line a reviewer reads: at most `DISPUTE_EVIDENCE_LABEL_MAXIMUM_LENGTH` characters. */
  readonly label: string;
  /** Optional sentence under the label, at most `DISPUTE_EVIDENCE_SUMMARY_MAXIMUM_LENGTH` characters. */
  readonly summary: string | null;
  /** The instant of the source fact, which is what the pack's order is built on. */
  readonly capturedAt: string;
}

/** What one read needs: the merchant, the dispute, and the payment under it. */
export interface DisputeEvidenceSourceInput {
  readonly companyId: string;
  readonly paymentId: string;
}

const paymentSchema = z.object({
  id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable(),
  amount_minor: z.number(),
  currency: z.string(),
  status: z.string(),
  captured_at: z.string().nullable(),
});

const invoiceSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  status: z.string(),
  currency: z.string(),
  total_minor: z.number(),
  amount_paid_minor: z.number(),
  issued_at: z.string(),
  paid_at: z.string().nullable(),
});

const fulfilmentSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  method: z.string(),
  occurred_at: z.string(),
  reference: z.string().nullable(),
  description: z.string().nullable(),
});

const acceptanceSchema = z.object({
  id: z.string().uuid(),
  statement: z.string(),
  signer_name: z.string().nullable(),
  consent_accepted: z.boolean(),
  accepted_at: z.string(),
});

const emailSchema = z.object({
  id: z.string().uuid(),
  subject: z.string(),
  status: z.string(),
  queued_at: z.string(),
  sent_at: z.string().nullable(),
});

const eventSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  detail: z.string().nullable(),
  occurred_at: z.string(),
});

const policySchema = z.object({
  id: z.string().uuid(),
  policy_key: z.string(),
  policy_version: z.string(),
  accepted_at: z.string(),
});

/** The instant a label prints: UTC, minute precision, the same reading the dispute page uses. */
function instantText(iso: string): string {
  const parsed = Date.parse(iso);

  return Number.isFinite(parsed) ? `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC` : iso;
}

/** An amount as a person reads it, from the decimal library rather than from a division. */
function amountText(minor: number, currency: string): string {
  return `${priceFromMinor(BigInt(minor))} ${currency}`;
}

/** True when a string can be a label: the length `0126` checks and no leading or trailing space. */
function usableLabel(value: string): string {
  const trimmed = value.trim();

  return trimmed.length === 0 ? "-" : trimmed.slice(0, 120);
}

/** A summary the column will accept, or null when there is nothing to say. */
function usableSummary(parts: readonly (string | null | undefined)[]): string | null {
  const joined = parts
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(" \u00b7 ");

  return joined.length === 0 ? null : joined.slice(0, 600);
}

/**
 * The one invoice the disputed payment carries, if any.
 *
 * `0037` lets a payment be created without an invoice - a payment link is not a bill - so a null
 * `invoice_id` is a normal state and not an error. It does mean the invoice, delivery, communication and
 * terms parts have no platform record, and the merchant's own documents carry the pack instead.
 */
async function readInvoice(
  rest: RestClient,
  input: DisputeEvidenceSourceInput,
): Promise<{ readonly invoiceId: string | null; readonly candidates: DisputeEvidenceCandidate[] }> {
  const payments = await rest.select(
    "payments",
    "select=id,invoice_id,amount_minor,currency,status,captured_at" +
      `&id=eq.${encodeURIComponent(input.paymentId)}&company_id=eq.${input.companyId}` +
      "&deleted_at=is.null&limit=1",
    paymentSchema,
  );
  const invoiceId = payments[0]?.invoice_id ?? null;

  if (invoiceId === null) {
    return { invoiceId: null, candidates: [] };
  }

  const invoices = await rest.select(
    "invoices",
    "select=id,number,status,currency,total_minor,amount_paid_minor,issued_at,paid_at" +
      `&id=eq.${encodeURIComponent(invoiceId)}&company_id=eq.${input.companyId}` +
      "&deleted_at=is.null&limit=1",
    invoiceSchema,
  );
  const invoice = invoices[0];

  if (invoice === undefined) {
    return { invoiceId, candidates: [] };
  }

  return {
    invoiceId,
    candidates: [
      {
        section: DISPUTE_EVIDENCE_SECTION_OF.invoice,
        sourceKind: "invoice",
        sourceId: invoice.id,
        label: formatMessage(DISPUTE_EVIDENCE_LABEL_PATHS.invoice, { number: usableLabel(invoice.number) }),
        summary: usableSummary([
          amountText(invoice.total_minor, invoice.currency),
          `status ${invoice.status}`,
          invoice.paid_at === null ? "not paid" : `paid ${instantText(invoice.paid_at)}`,
        ]),
        capturedAt: invoice.issued_at,
      },
    ],
  };
}

/**
 * The delivery proof: `0122`'s fulfilment record for the invoice.
 *
 * There is at most one live row per invoice, which is `0122`'s own rule, so the read asks for one and the
 * limit is a guard rather than a page.
 */
async function readFulfilment(
  rest: RestClient,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<DisputeEvidenceCandidate[]> {
  const rows = await rest.select(
    "invoice_fulfilment_evidence",
    "select=id,kind,method,occurred_at,reference,description" +
      `&company_id=eq.${input.companyId}&invoice_id=eq.${encodeURIComponent(input.invoiceId)}` +
      "&deleted_at=is.null&order=occurred_at.desc" +
      `&limit=${String(DISPUTE_EVIDENCE_CANDIDATE_LIMITS.fulfilment)}`,
    fulfilmentSchema,
  );

  return rows.map((row) => ({
    section: DISPUTE_EVIDENCE_SECTION_OF.fulfilment,
    sourceKind: "fulfilment" as const,
    sourceId: row.id,
    label: formatMessage(DISPUTE_EVIDENCE_LABEL_PATHS.fulfilment, { instant: instantText(row.occurred_at) }),
    summary: usableSummary([`${row.kind} by ${row.method}`, row.reference, row.description]),
    capturedAt: row.occurred_at,
  }));
}

/**
 * The terms acceptance record, first half: the buyer's own confirmation from `0122`.
 *
 * This is the row section 19 calls a "terms acceptance record" in the sense that matters to a processor:
 * a named person accepted a statement and a consent wording, at an instant, against a digest of the
 * document they read. The digest is on the row; the pack summarizes the fact and does not copy the wording.
 */
async function readAcceptance(
  rest: RestClient,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<DisputeEvidenceCandidate[]> {
  const rows = await rest.select(
    "invoice_acceptances",
    "select=id,statement,signer_name,consent_accepted,accepted_at" +
      `&company_id=eq.${input.companyId}&invoice_id=eq.${encodeURIComponent(input.invoiceId)}` +
      "&deleted_at=is.null&order=accepted_at.desc" +
      `&limit=${String(DISPUTE_EVIDENCE_CANDIDATE_LIMITS.acceptance)}`,
    acceptanceSchema,
  );

  return rows.map((row) => ({
    section: DISPUTE_EVIDENCE_SECTION_OF.acceptance,
    sourceKind: "acceptance" as const,
    sourceId: row.id,
    label: formatMessage(DISPUTE_EVIDENCE_LABEL_PATHS.acceptance, { instant: instantText(row.accepted_at) }),
    summary: usableSummary([
      `${row.statement} confirmed`,
      row.signer_name === null ? null : row.signer_name,
      row.consent_accepted ? "consent accepted" : "consent not accepted",
    ]),
    capturedAt: row.accepted_at,
  }));
}

/**
 * The terms acceptance record, second half: the merchant's acceptance of the platform's own policies.
 *
 * A chargeback about a subscription or a service often turns on what the buyer agreed to, and `0052` holds
 * the merchant's acceptance of the terms the merchant then sold under. Four of them at most: the current
 * versions are what a reviewer reads, and twelve historical revisions would bury them.
 */
async function readPolicies(
  rest: RestClient,
  input: { readonly companyId: string },
): Promise<DisputeEvidenceCandidate[]> {
  const rows = await rest.select(
    "policy_acceptances",
    "select=id,policy_key,policy_version,accepted_at" +
      `&company_id=eq.${input.companyId}&deleted_at=is.null&order=accepted_at.desc` +
      `&limit=${String(DISPUTE_EVIDENCE_CANDIDATE_LIMITS.policy)}`,
    policySchema,
  );

  return rows.map((row) => ({
    section: DISPUTE_EVIDENCE_SECTION_OF.policy,
    sourceKind: "policy" as const,
    sourceId: row.id,
    label: formatMessage(DISPUTE_EVIDENCE_LABEL_PATHS.policy, {
      policy: `${usableLabel(row.policy_key)} ${usableLabel(row.policy_version)}`,
      instant: instantText(row.accepted_at),
    }),
    summary: `Accepted version ${row.policy_version} of ${row.policy_key}.`,
    capturedAt: row.accepted_at,
  }));
}

/**
 * The client communication record, first half: what the platform sent about the invoice.
 *
 * `0061`'s log carries the subject, the state and the two instants, and never the body - which is exactly
 * what a pack should say: the client was told, when, about what, and whether the message left. The address is
 * not copied: it is on the invoice, and a pack is read by more people than the invoice is.
 */
async function readCommunications(
  rest: RestClient,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<DisputeEvidenceCandidate[]> {
  const rows = await rest.select(
    "email_send_logs",
    "select=id,subject,status,queued_at,sent_at" +
      `&company_id=eq.${input.companyId}&reference_kind=eq.invoice` +
      `&reference_id=eq.${encodeURIComponent(input.invoiceId)}&deleted_at=is.null` +
      "&order=queued_at.desc" +
      `&limit=${String(DISPUTE_EVIDENCE_CANDIDATE_LIMITS.communication)}`,
    emailSchema,
  );

  return rows.map((row) => {
    const at = row.sent_at ?? row.queued_at;

    return {
      section: DISPUTE_EVIDENCE_SECTION_OF.communication,
      sourceKind: "communication" as const,
      sourceId: row.id,
      label: formatMessage(DISPUTE_EVIDENCE_LABEL_PATHS.communication, { instant: instantText(at) }),
      summary: usableSummary([row.subject, `status ${row.status}`]),
      capturedAt: at,
    };
  });
}

/**
 * The client communication record, second half: what the client did with the invoice.
 *
 * `0024` records the invoice being sent, opened, paid or voided, and `invoices.first_viewed_at` already
 * proves the client looked at it. Those events are the other side of a conversation - a client who read the
 * invoice twice and then disputed it is a different story from one who never opened it - so they belong in
 * the pack as facts rather than in a sentence somebody writes.
 */
async function readEvents(
  rest: RestClient,
  input: { readonly companyId: string; readonly invoiceId: string },
): Promise<DisputeEvidenceCandidate[]> {
  const rows = await rest.select(
    "invoice_events",
    "select=id,type,detail,occurred_at" +
      `&company_id=eq.${input.companyId}&invoice_id=eq.${encodeURIComponent(input.invoiceId)}` +
      "&deleted_at=is.null&order=occurred_at.desc" +
      `&limit=${String(DISPUTE_EVIDENCE_CANDIDATE_LIMITS.event)}`,
    eventSchema,
  );

  return rows.map((row) => ({
    section: DISPUTE_EVIDENCE_SECTION_OF.event,
    sourceKind: "event" as const,
    sourceId: row.id,
    label: formatMessage(DISPUTE_EVIDENCE_LABEL_PATHS.event, {
      event: usableLabel(row.type),
      instant: instantText(row.occurred_at),
    }),
    summary: usableSummary([row.detail]),
    capturedAt: row.occurred_at,
  }));
}

/**
 * Everything the platform holds about the disputed payment, section by section.
 *
 * The order is the order a person reads a pack: the invoice, then the delivery, then what was said, then
 * what was agreed. Inside a section the newest first, because a reviewer reads the most recent fact first.
 * A read that fails is not fatal to the others: `payments` is the one query that must answer, and a section
 * whose table has nothing for this merchant simply comes back empty.
 */
export async function readEvidenceCandidates(
  input: DisputeEvidenceSourceInput,
  dependencies: { readonly rest: RestClient },
): Promise<readonly DisputeEvidenceCandidate[]> {
  const rest = dependencies.rest;
  const invoice = await readInvoice(rest, input);
  const invoiceId = invoice.invoiceId;

  if (invoiceId === null) {
    return invoice.candidates;
  }

  const [fulfilment, acceptance, policies, communications, events] = await Promise.all([
    readFulfilment(rest, { companyId: input.companyId, invoiceId }),
    readAcceptance(rest, { companyId: input.companyId, invoiceId }),
    readPolicies(rest, { companyId: input.companyId }),
    readCommunications(rest, { companyId: input.companyId, invoiceId }),
    readEvents(rest, { companyId: input.companyId, invoiceId }),
  ]);

  return [...invoice.candidates, ...fulfilment, ...acceptance, ...policies, ...communications, ...events];
}
