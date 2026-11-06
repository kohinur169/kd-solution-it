// path: services/estimates/estimate-conversion.ts
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { mintPortalToken, openPortalToken, type PortalTokenKeys } from "../../lib/security/portal-token.ts";
import { basisPointsToPercent } from "../invoices/invoice-discount.ts";
import { INVOICE_CREATED_STATUS, INVOICE_TABLE } from "../invoices/invoice-fields.ts";
import { ESTIMATE_TABLE } from "./estimate-fields.ts";
import { takeInvoiceNumber } from "../invoices/invoice-numbering.ts";
import { createInvoice, getInvoice, INVOICE_ABANDONED_AUDIT_ACTION, type InvoiceSnapshot } from "../invoices/invoices.ts";
import { INVOICE_VOID_STATUS } from "./estimate-conversion-fields.ts";
import { priceFromMinor } from "../products/price.ts";
import {
  ESTIMATE_CONVERSION_INVOICE_STATUS,
  ESTIMATE_CONVERSION_MINIMUM_TERM_DAYS,
  ESTIMATE_CONVERSION_SOURCE_STATUS,
  ESTIMATE_PAYMENT_LINK_CAPABILITY,
  ESTIMATE_PAYMENT_LINK_ID_BYTES,
  ESTIMATE_PAYMENT_LINK_KIND,
  ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS,
  ESTIMATE_PAYMENT_LINK_PATH_PREFIX,
  INVOICE_CONVERSION_AUDIT_ENTITY,
  INVOICE_CONVERTED_AUDIT_ACTION,
} from "./estimate-conversion-fields.ts";
import { ESTIMATE_MANAGE_ROLES, getEstimate, type EstimateSnapshot } from "./estimates.ts";

/**
 * Section 16's conversion: an accepted estimate becomes an issued invoice, and the invoice is shared as a
 * payment link.
 *
 * ## The order of the four writes, and why it is this order
 *
 * A conversion is four facts and they cannot be written at once: a number is taken, an invoice is created,
 * the invoice is issued, and the quote records which invoice it became. Each later step compensates the
 * earlier one, so a failure halfway leaves nothing a reader could mistake for a conversion.
 *
 * 1. **The number is taken first.** `take_invoice_number` is the only source of a number and it advances a
 *    merchant's series; if the rest of the work fails, the number is spent and never printed, which is the
 *    safe direction. Taking it last would mean an invoice row exists for a moment with no number it could be
 *    issued under.
 * 2. **The invoice is created as a draft**, through `createInvoice`, because that is the one function that
 *    knows what an invoice row needs: the client from the book rather than the body, the sanitised name, the
 *    due date, and the lines in one insert. It also writes its own compensating removal on a later failure,
 *    so a create that fails needs nothing from this module.
 * 3. **The invoice is issued in one statement.** `0022`'s `invoices_issue_check` allows a number and an
 *    issue instant only on a status that is not `draft`, so the status travels with the two facts that make
 *    the invoice payable. Writing the number first and the status afterwards would be refused by the check,
 *    because the row would be a draft carrying a number for as long as the two statements are apart.
 * 4. **The quote records the invoice last.** `estimates_conversion_check` needs the quote to be accepted
 *    before the column may hold an invoice, and `0118` lets that one write through the terminal guard. It is
 *    last because it is the fact that makes the conversion real: an invoice that is voided (step 3 failing,
 *    or this step failing) must never be pointed at by an accepted offer.
 *
 * The payment link is minted after all four, because it names the invoice and a link to an invoice that does
 * not exist would be a link that cannot be honoured. It is a signature rather than a row, so it needs no
 * compensation: nothing is stored, and a failure to mint only means the caller is told so.
 *
 * ## What this module does not do
 *
 * It does not send a quote, accept one, or move an invoice to `paid`. Acceptance is the client's decision and
 * arrives from the tokenized estimate page (STEP 181/182); settlement is STEP 124/127. Nothing in production
 * can therefore set `estimates.status = 'accepted'` today, which is why this service is reached by the
 * merchant's own request rather than by an automatic hook: the hook belongs to the STEP that can observe the
 * acceptance, and it is expected to call this function unchanged.
 */

/** What a conversion needs beyond the estimate's own dependencies. */
export interface EstimateConversionDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
  /** The keys `lib/security/portal-token.ts` signs with. Derived from the master key by the caller. */
  readonly portalTokenKeys: PortalTokenKeys;
  /** `APP_URL`: the canonical base of a tokenized link. */
  readonly appUrl: string;
}

/** The link a conversion produced, as the merchant's screen needs it. */
export interface EstimatePaymentLink {
  /** The signed token. This is the link's secret and it is never written to the audit trail. */
  readonly token: string;
  /** The link's name, for a revocation store. Safe to log. */
  readonly tokenId: string;
  /** `<APP_URL>/i/<token>`, the address the client opens. */
  readonly url: string;
  /** When the link stops working, as epoch milliseconds. */
  readonly expiresAtEpochMs: number;
}

/** What a conversion answers with: both documents and the link between them and the client. */
export interface EstimateConversionSnapshot {
  /** The quote as it now reads, with `convertedInvoiceId` filled. */
  readonly estimate: EstimateSnapshot;
  /** The invoice the quote became, issued and payable. */
  readonly invoice: InvoiceSnapshot;
  readonly paymentLink: EstimatePaymentLink;
}

/**
 * Convert one accepted estimate into an issued invoice with a payment link.
 *
 * The caller is the merchant's owner, which is the role that may write both documents; a quote belongs to its
 * merchant exactly as an invoice does. Refusals name the field they are about so a screen marks one box
 * rather than printing a sentence nobody can act on.
 */
export async function convertEstimateToInvoice(
  input: { readonly actor: RequestActor; readonly estimateId: string },
  dependencies: EstimateConversionDependencies,
): Promise<EstimateConversionSnapshot> {
  requireAnyRole(input.actor, ESTIMATE_MANAGE_ROLES);
  const companyId = requireCompanyId(input.actor);
  const now = dependencies.now?.() ?? Date.now();

  if (!z.string().uuid().safeParse(input.estimateId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
  }

  // The quote is read through the module that owns it, so "which quote, whose, and is it live" has one
  // answer in this codebase rather than a second query that could disagree.
  const estimate = await getEstimate(
    { actor: input.actor, estimateId: input.estimateId },
    dependencies,
  );

  // `0025`: only an accepted quote converts. A draft was never agreed, a void one was withdrawn, and a sent
  // or viewed one is still an open offer - converting any of them would invoice a client for something they
  // did not accept, which is the one mistake this check exists to make impossible.
  if (estimate.status !== ESTIMATE_CONVERSION_SOURCE_STATUS) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "status", rule: "not_accepted" }] });
  }

  // `estimates_invoice_key` is the database's guarantee of one invoice per quote; this is the readable
  // version of it for the ordinary case, where the quote already says which invoice it became.
  if (estimate.convertedInvoiceId !== null) {
    throw new AppError("CONFLICT", {
      details: [{ field: "converted_invoice_id", rule: "already_used" }],
      cause: { rule: "estimate_conversion", reason: "already_converted" },
    });
  }

  if (estimate.lines.length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "lines", rule: "empty" }] });
  }

  // The quote must hold a name and a printable address for the invoice it becomes. `createInvoice` reads the
  // client from the book rather than from the quote, so this refusal is about the book: a client whose name
  // was cleared after the quote was issued cannot be invoiced, and saying so here names the client rather
  // than letting the create answer with a field the merchant cannot find.
  if (estimate.client.name.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "client_id", rule: "invalid_format" }] });
  }

  const issuedAtEpochMs = now;
  const dueAtEpochMs = dueInstantOf(estimate, issuedAtEpochMs);

  const invoiceBody = bodyOf(estimate, new Date(dueAtEpochMs).toISOString());

  // Step 1: the number. A refusal here is the merchant's numbering settings, so it is a conflict the settings
  // screen can fix rather than a broken platform.
  const taken = await takeInvoiceNumber(
    { actor: input.actor, companyId },
    { rest: dependencies.rest, audit: dependencies.audit, now: () => now },
  );

  // Step 2: the draft, through the one function that knows what an invoice row needs.
  const draft = await createInvoice(
    { actor: input.actor, body: invoiceBody },
    { rest: dependencies.rest, audit: dependencies.audit, now: () => now },
  );

  // Step 3: issue it. The status, the number and the instant travel together because `invoices_issue_check`
  // reads all three: a row that carried a number while still a draft would be refused by the database.
  const issuedAt = new Date(issuedAtEpochMs).toISOString();

  try {
    await dependencies.rest.update(
      INVOICE_TABLE,
      `id=eq.${draft.id}&company_id=eq.${companyId}&status=eq.${INVOICE_CREATED_STATUS}`,
      { status: ESTIMATE_CONVERSION_INVOICE_STATUS, number: taken.number, issued_at: issuedAt },
    );
  } catch (error) {
    await voidInvoice(dependencies, {
      companyId,
      actor: input.actor,
      invoiceId: draft.id,
      fromStatus: INVOICE_CREATED_STATUS,
      reason: "issue_failed",
    });

    throw error;
  }

  const invoice = await getInvoice({ actor: input.actor, invoiceId: draft.id }, dependencies);

  // A PostgREST update that matched nothing still reports success, so the re-read is what proves the row is
  // issued. An invoice left holding its draft status would be one the client cannot pay.
  if (invoice.status !== ESTIMATE_CONVERSION_INVOICE_STATUS) {
    await voidInvoice(dependencies, {
      companyId,
      actor: input.actor,
      invoiceId: invoice.id,
      fromStatus: INVOICE_CREATED_STATUS,
      reason: "not_issued",
    });

    throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "estimate_conversion", reason: "not_issued" } });
  }

  // Step 4: the quote records the invoice. Scoped to an accepted quote that has not been converted, so two
  // requests racing cannot both succeed here even without the unique index behind them.
  try {
    await dependencies.rest.update(
      ESTIMATE_TABLE,
      `id=eq.${estimate.id}&company_id=eq.${companyId}&status=eq.${ESTIMATE_CONVERSION_SOURCE_STATUS}&converted_invoice_id=is.null`,
      { converted_invoice_id: invoice.id },
    );
  } catch (error) {
    // The invoice exists but nothing points at it, which is the state that would let a retry create a second
    // one. Voiding it is what keeps the quote and the invoice in step.
    await voidInvoice(dependencies, {
      companyId,
      actor: input.actor,
      invoiceId: invoice.id,
      // The invoice was issued before the quote could record it, so the compensation names the status it is
      // actually in. `0022` permits a void row to keep its number and its issue instant, which is what makes
      // an issued invoice voidable at all.
      fromStatus: ESTIMATE_CONVERSION_INVOICE_STATUS,
      reason: isAppError(error) ? error.code.toLowerCase() : "conversion_not_recorded",
    });

    if (isAppError(error) && error.code === "CONFLICT") {
      throw new AppError("CONFLICT", {
        details: [{ field: "converted_invoice_id", rule: "already_used" }],
        cause: { rule: "estimate_conversion", reason: "already_converted" },
      });
    }

    throw error;
  }

  const converted = await getEstimate({ actor: input.actor, estimateId: estimate.id }, dependencies);

  // The unique index refuses a second conversion with `23505`, which arrives as a bare conflict. Reading the
  // quote back is what turns "something conflicted" into "this quote already became an invoice" - and it
  // also proves the write landed on the row this request read.
  if (converted.convertedInvoiceId !== invoice.id) {
    throw new AppError("CONFLICT", {
      details: [{ field: "converted_invoice_id", rule: "already_used" }],
      cause: { rule: "estimate_conversion", reason: "already_converted" },
    });
  }

  const paymentLink = mintPaymentLink(converted, invoice, dependencies, now);

  await appendTolerated(dependencies.audit, {
    action: INVOICE_CONVERTED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_CONVERSION_AUDIT_ENTITY,
    entityId: invoice.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: {
      // Counts, identifiers and the shape of the documents - never the token, never the client's name and
      // never a line's description. The link's own name travels as `link_id`, and deliberately not under a
      // key containing "token": `lib/security/audit.ts` redacts by key name, so a key of that shape would
      // either be blanked or, worse, tempt a caller to put the secret itself there.
      estimate_id: converted.id,
      estimate_number: converted.number,
      line_count: invoice.lines.length,
      total_minor: invoice.totals.totalMinor,
      currency: invoice.currency,
      due_at: invoice.dueAt,
      link_id: paymentLink.tokenId,
      link_expires_at_epoch_ms: paymentLink.expiresAtEpochMs,
    },
  });

  return { estimate: converted, invoice, paymentLink };
}

/**
 * The instant the converted invoice is due.
 *
 * The quote promised a date, and the invoice keeps it: a client who accepted an offer valid until the
 * fourteenth is not asked to pay later because the merchant converted it on the twenty-first. `0022` requires
 * `due_at >= issued_at` and `due_at` is not null, so a quote that expired before the conversion would
 * otherwise produce an invoice dated in the past - the term is therefore floored at the minimum one day that
 * gives the client a window to pay in.
 *
 * The floor is measured from the issue instant, not from the clock, because the two are the same instant here
 * and a reader should not have to prove it.
 */
function dueInstantOf(estimate: EstimateSnapshot, issuedAtEpochMs: number): number {
  const expiry = Date.parse(estimate.expiresAt);
  const floor = issuedAtEpochMs + ESTIMATE_CONVERSION_MINIMUM_TERM_DAYS * 86_400_000;

  // A quote whose `expires_at` the database cannot represent would have failed `0025`'s own check on write, so
  // an unreadable instant falls back to the floor rather than producing an invoice with `due_at` of `NaN`.
  if (!Number.isFinite(expiry)) {
    return floor;
  }

  return Math.max(expiry, floor);
}

/**
 * The create body a converted invoice is written from.
 *
 * Every amount is the quote's, printed back into the text the create form would have typed - `priceFromMinor`
 * for money and `basisPointsToPercent` for a percentage - so the invoice is built by the same parser every
 * other invoice is, rather than by a second path that could disagree about a rounding rule. `0026` mirrors
 * `0023` column for column, which is what makes that a faithful translation and not an approximation: the
 * quote's lines and the invoice's lines carry the same seven fields under the same checks.
 */
function bodyOf(estimate: EstimateSnapshot, dueAt: string): Record<string, unknown> {
  const discount =
    estimate.totals.discountBasis === "percent"
      ? basisPointsToPercent(BigInt(estimate.totals.discountPercentBasisPoints))
      : priceFromMinor(BigInt(estimate.totals.discountMinor));

  return {
    client_id: estimate.clientId,
    currency: estimate.currency,
    due_at: dueAt,
    memo: estimate.memo,
    discount,
    discount_basis: estimate.totals.discountBasis,
    tax: priceFromMinor(BigInt(estimate.totals.taxMinor)),
    lines: estimate.lines.map((line) => ({
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount: line.discount,
      product_id: line.productId,
      service_id: line.serviceId,
    })),
  };
}

/**
 * Mint the invoice's payment link, and read it back.
 *
 * The token id is chosen here rather than by the security module because the id is the name a revocation row
 * will be found by, and the route that must later revoke a link has to be able to record that name now. The
 * id is sixteen random bytes in canonical base64url, which is the size and the spelling that module's pattern
 * accepts.
 *
 * The link is opened again immediately with the expectations it was minted under. That is not paranoia: the
 * mint is the only place a wrong kind, a wrong capability pairing or a lifetime outside the allowed band could
 * slip through, and a link that cannot be opened is worse than no link, because the merchant would have sent
 * it.
 */
function mintPaymentLink(
  estimate: EstimateSnapshot,
  invoice: InvoiceSnapshot,
  dependencies: EstimateConversionDependencies,
  now: number,
): EstimatePaymentLink {
  const tokenId = randomBytes(ESTIMATE_PAYMENT_LINK_ID_BYTES).toString("base64url");
  const nowSeconds = Math.floor(now / 1_000);

  const token = mintPortalToken(
    {
      kind: ESTIMATE_PAYMENT_LINK_KIND,
      companyId: estimate.companyId,
      resourceId: invoice.id,
      capability: ESTIMATE_PAYMENT_LINK_CAPABILITY,
      lifetimeSeconds: ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS,
    },
    { keys: dependencies.portalTokenKeys, now: nowSeconds, tokenId },
  );

  const claim = openPortalToken(token, {
    keys: dependencies.portalTokenKeys,
    now: nowSeconds,
    expect: {
      kind: ESTIMATE_PAYMENT_LINK_KIND,
      companyId: estimate.companyId,
      resourceId: invoice.id,
      capability: ESTIMATE_PAYMENT_LINK_CAPABILITY,
    },
  });

  if (claim.tokenId !== tokenId) {
    throw new AppError("INTERNAL_ERROR", { cause: { rule: "estimate_conversion", reason: "link_id_mismatch" } });
  }

  return {
    token,
    tokenId,
    url: `${baseOf(dependencies.appUrl)}${ESTIMATE_PAYMENT_LINK_PATH_PREFIX}${token}`,
    expiresAtEpochMs: claim.expiresAt * 1_000,
  };
}

/** `APP_URL` without a trailing slash, so one configured slash cannot print a doubled one in a link. */
function baseOf(appUrl: string): string {
  return appUrl.endsWith("/") ? appUrl.slice(0, -1) : appUrl;
}

/**
 * Void a draft this request wrote, because the invoice it was becoming could not be issued or recorded.
 *
 * `0022` allows a void row to carry no number and no issue instant, which is exactly the state a draft is in,
 * so voiding is always available and always the honest outcome: the document is kept, marked, and never
 * offered to a client. A soft delete would hide the fact that a number had been spent, and a hard one would
 * remove a row an investigator may need to see.
 *
 * The compensating action failing must not replace the failure the caller needs to see, which is why the
 * update and the audit entry are both tolerated.
 */
async function voidInvoice(
  dependencies: EstimateConversionDependencies,
  input: {
    readonly companyId: string;
    readonly actor: RequestActor;
    readonly invoiceId: string;
    /** The status the row is in now, so the void cannot land on an invoice another request has moved on. */
    readonly fromStatus: string;
    readonly reason: string;
  },
): Promise<void> {
  try {
    await dependencies.rest.update(
      INVOICE_TABLE,
      `id=eq.${input.invoiceId}&company_id=eq.${input.companyId}&status=eq.${input.fromStatus}`,
      { status: INVOICE_VOID_STATUS, voided_at: new Date(dependencies.now?.() ?? Date.now()).toISOString() },
    );
  } catch {
    // The compensating action failing must not replace the original failure the caller needs to see.
  }

  await appendTolerated(dependencies.audit, {
    action: INVOICE_ABANDONED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: INVOICE_CONVERSION_AUDIT_ENTITY,
    entityId: input.invoiceId,
    companyId: input.companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { reason: input.reason, source: "estimate_conversion" },
  });
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}
