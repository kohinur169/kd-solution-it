// path: app/api/invoices/[id]/discount/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import type { ErrorDetail } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import { priceProblemOf, priceToMinor } from "@/services/products/price";
import { updateInvoiceTotals } from "@/services/invoices/invoice-lines";
import {
  DISCOUNT_DEFAULT_BASIS,
  isDiscountBasis,
  percentToBasisPoints,
  type DiscountBasis,
} from "@/services/invoices/invoice-discount";
import type { InvoiceTotals } from "@/services/invoices/invoice-totals";

export const dynamic = "force-dynamic";

/** Four short fields; 2 KiB is generous for a percentage, an amount and a tax. */
const maximumBodyBytes = 2_048;

interface DiscountBody {
  readonly status: "updated";
  /** The amounts the row holds after the write, plus the instruction that produced them. */
  readonly totals: InvoiceTotals & { readonly basis: DiscountBasis; readonly basisPoints: number };
}

/**
 * Change the invoice-level discount and the tax line of a draft.
 *
 * ## Why one route for two amounts
 *
 * The merchant reads "discount" and "tax" as the two lines above the total, and a screen that had to save
 * them in two requests would show a total that was wrong between them. They also have to be written
 * together for a different reason: `invoices_total_check` is an identity over all three, and a row that
 * is checked after each statement would be refused in the middle of a legal change.
 *
 * ## Why the basis is part of the body
 *
 * `percent` means `discount` is a percentage of the subtotal and the service resolves the money; anything
 * else means it is the money itself. The route does not compute the money for the percentage case - the
 * service reads the subtotal back and resolves against it - because a caller that computed its own
 * subtotal would be a second opinion the row does not share.
 *
 * ## The order of the checks
 *
 * CSRF first, then the declared length, then the session, then the body's shape, then the service, which
 * applies the `owner` role, refuses a document that has left `draft`, and answers with the totals it read
 * back rather than the ones it computed.
 */
export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<DiscountBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const declaredLength = request.headers.get("content-length");

    if (declaredLength !== null) {
      const parsed = Number.parseInt(declaredLength, 10);

      if (Number.isFinite(parsed) && parsed > maximumBodyBytes) {
        throw new AppError("PAYLOAD_TOO_LARGE");
      }
    }

    const bodyText = await request.text();

    if (new TextEncoder().encode(bodyText).length > maximumBodyBytes) {
      throw new AppError("PAYLOAD_TOO_LARGE");
    }

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });

    let body: unknown;

    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "discount", rule: "invalid_format" }] });
    }

    const problems: ErrorDetail[] = [];
    const raw = (body ?? {}) as {
      readonly discount?: unknown;
      readonly discount_basis?: unknown;
      readonly tax?: unknown;
    };

    const basisText = typeof raw.discount_basis === "string" ? raw.discount_basis.trim() : "";
    const basis: DiscountBasis =
      basisText.length === 0 ? DISCOUNT_DEFAULT_BASIS : isDiscountBasis(basisText) ? basisText : DISCOUNT_DEFAULT_BASIS;

    if (basisText.length > 0 && !isDiscountBasis(basisText)) {
      problems.push({ field: "discount_basis", rule: "invalid_format" });
    }

    if ((raw.discount !== undefined && typeof raw.discount !== "string") || (raw.tax !== undefined && typeof raw.tax !== "string")) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "discount", rule: "invalid_format" }] });
    }

    const discountText = typeof raw.discount === "string" ? raw.discount.trim() : "";
    const taxText = typeof raw.tax === "string" ? raw.tax.trim() : "";

    // The percentage and the amount are parsed by different rules, and the basis is what chooses which.
    // A percentage is in basis points; a flat amount is money. Either way a blank field means zero, which
    // is how a merchant removes a discount they had added.
    const discountValue =
      discountText.length === 0
        ? 0n
        : basis === "percent"
          ? percentToBasisPoints(discountText)
          : priceToMinor(discountText);

    if (discountValue === null) {
      problems.push({
        field: "discount",
        rule:
          basis === "percent"
            ? "invalid_format"
            : priceProblemOf(discountText) === "too_large"
              ? "too_large"
              : "invalid_format",
      });
    }

    const taxMinor = taxText.length === 0 ? 0n : priceToMinor(taxText);

    if (taxMinor === null) {
      problems.push({
        field: "tax",
        rule: priceProblemOf(taxText) === "too_large" ? "too_large" : "invalid_format",
      });
    }

    if (problems.length > 0 || discountValue === null || taxMinor === null) {
      throw new AppError("VALIDATION_FAILED", { details: problems });
    }

    const params = await context.params;
    const invoiceId = decodeURIComponent(params.id);
    const totals = await updateInvoiceTotals(
      {
        actor,
        invoiceId,
        totals: {
          basis,
          basisPoints: basis === "percent" ? discountValue : 0n,
          amountMinor: basis === "percent" ? 0n : discountValue,
          taxMinor,
        },
      },
      { rest: runtime.rest, audit: runtime.audit },
    );

    logger.info("invoice totals changed", {
      userId: actor.userId,
      invoiceId,
      basis,
      totalMinor: totals.totalMinor.toString(),
    });

    return NextResponse.json(
      { status: "updated", totals },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  },
);
