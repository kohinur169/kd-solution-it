// path: app/(dashboard)/estimates/estimate-form.tsx
"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  ESTIMATE_CURRENCIES,
  ESTIMATE_EXPIRY_MAXIMUM_DAYS,
} from "@/services/estimates/estimate-fields";
import type { EstimateSnapshot } from "@/services/estimates/estimates";
import {
  INVOICE_DEFAULT_UNIT,
  INVOICE_MAXIMUM_LINES,
  INVOICE_UNITS,
  type InvoiceUnit,
} from "@/services/invoices/invoice-fields";
import { grossLineMinor, quantityToThousandths } from "@/services/invoices/invoice-totals";
import {
  percentDiscountMinor,
  percentToBasisPoints,
  type DiscountBasis,
} from "@/services/invoices/invoice-discount";
import type {
  InvoiceCatalogueOption,
  InvoiceClientOption,
} from "@/services/invoices/invoices";
import { priceFromMinor, priceToMinor } from "@/services/products/price";

/**
 * Section 16's estimate create form.
 *
 * ## Why the totals are computed here as well as on the server
 *
 * `0026` computes every line total in the database, and the server's answer is what gets stored. But a
 * merchant editing a quantity needs to see the amount change as they type: a form that waited for a round
 * trip before showing a total is a form nobody trusts. The arithmetic is not reimplemented here in a second
 * dialect - `invoice-totals.ts` and `invoice-discount.ts` are imported, the same modules the service and the
 * gate use - and the panel says in words that the server recalculates on save.
 *
 * ## Why the money is text
 *
 * Money is stored in minor units and never in a float (rule 2), and a number input in a browser is a float.
 * So every amount is a text box with `inputMode="decimal"`, the conversion is decimal string arithmetic, and
 * an amount that is not one shows an em dash rather than a guessed number. Nothing here rounds;
 * `grossLineMinor` is the database's own rule.
 *
 * ## Why the expiry box has a floor and a ceiling
 *
 * `0025` requires `expires_at` and this service requires it to be strictly ahead of now and at most
 * `ESTIMATE_EXPIRY_MAXIMUM_DAYS` away. A date box with no bounds lets a merchant pick yesterday and meet a
 * refusal they could not have predicted, so the box itself carries the two dates - computed on the server,
 * because a phone with a wrong clock still has to be offered the day the server believes. The offer is
 * therefore always for at least a whole day, which is the shortest lifetime a quote can usefully have.
 *
 * ## Why every refusal is read field by field
 *
 * The service names a broken field as `lines[2].unit_price`, so the form marks the right box on the right
 * row instead of one "line items" error above a list of twenty. A rule this build does not know still
 * produces a sentence rather than an empty line under the box.
 *
 * ## The width
 *
 * One column, capped by the screen that holds it. A line's quantity and price sit side by side only from
 * `sm` up, because at 360px two columns of money are two columns of clipped text.
 */

/** One row of the editor, as text. A blank field is blank: nothing here invents a zero. */
interface LineDraft {
  /** A stable key, so reordering or removing a row never reuses another row's state. */
  readonly key: number;
  description: string;
  unit: InvoiceUnit;
  quantity: string;
  unitPrice: string;
  discount: string;
  productId: string;
  serviceId: string;
}

const RULE_KEYS: Readonly<Record<string, MessagePath>> = Object.freeze({
  required: "estimates.ruleRequired",
  too_short: "estimates.ruleTooShort",
  too_long: "estimates.ruleTooLong",
  invalid_format: "estimates.ruleInvalidFormat",
  too_large: "estimates.ruleTooLarge",
  too_small: "estimates.ruleTooSmall",
  unknown_field: "estimates.ruleUnknownField",
  not_found: "estimates.ruleNotFound",
  too_many: "estimates.ruleTooMany",
  empty: "estimates.ruleEmpty",
  already_changed: "estimates.ruleAlreadyChanged",
  expired_before_issue: "estimates.ruleExpiredBeforeIssue",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("estimates.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("estimates.fieldInvalid") : getMessage(key);
}

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

function refusalDetails(payload: unknown): readonly RefusalDetail[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return [];
  }

  const details = (error as { readonly details?: unknown }).details;

  return Array.isArray(details) ? details.filter((detail) => typeof detail === "object") : [];
}

/** The input classes every box shares, so the form has one look rather than five. */
const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary";
const labelClasses = "text-sm font-medium";
const hintClasses = "text-xs text-muted-foreground";
const errorClasses = "text-xs text-destructive";
const sectionClasses = "flex flex-col gap-3 rounded-lg border border-border p-4";

/**
 * A `yyyy-mm-dd` date box value as the instant the service stores: midnight UTC of that day.
 *
 * The `Z` is the point. A value with no zone is read by `Date.parse` in the *server's* zone, so the same
 * box would store a different instant in two deployments; naming the zone makes the stored instant depend
 * only on the day the merchant picked.
 */
function expiryDateToInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }

  const parsed = Date.parse(`${value}T00:00:00.000Z`);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * One line's amount, or null when its two numbers are not both numbers yet.
 *
 * The discount is subtracted only when it parses, so half-typed input shows a running amount instead of a
 * dash. A discount larger than the line leaves the amount negative on the screen, which is the visible
 * proof that the server will refuse it.
 */
function lineAmountOf(line: LineDraft): bigint | null {
  const quantity = quantityToThousandths(line.quantity);
  const price = priceToMinor(line.unitPrice);

  if (quantity === null || price === null) {
    return null;
  }

  const discount = line.discount.trim().length === 0 ? 0n : priceToMinor(line.discount);

  if (discount === null) {
    return null;
  }

  return grossLineMinor({ quantityThousandths: quantity, unitPriceMinor: price }) - discount;
}

/** A minor unit amount as the money text the screen prints, or an em dash when it is not known. */
function moneyText(minor: bigint | null): string {
  return minor === null ? "\u2014" : priceFromMinor(minor);
}

export interface EstimateFormProps {
  /** The clients the selector may offer, read on the server with the session's own scope. */
  readonly clients: readonly InvoiceClientOption[];
  readonly clientsTruncated: boolean;
  /** The expiry the form opens with, as a `yyyy-mm-dd` box value, decided on the server. */
  readonly defaultExpiryDate: string;
  /** Tomorrow, as a box value: the shortest lifetime an offer can have. */
  readonly minimumExpiryDate: string;
  /** A year from today, as a box value: `ESTIMATE_EXPIRY_MAXIMUM_DAYS`. */
  readonly maximumExpiryDate: string;
}

export function EstimateForm({
  clients,
  clientsTruncated,
  defaultExpiryDate,
  minimumExpiryDate,
  maximumExpiryDate,
}: EstimateFormProps): ReactNode {
  const [clientId, setClientId] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>(defaultExpiryDate);
  const [memo, setMemo] = useState<string>("");
  const [discount, setDiscount] = useState<string>("");
  // `amount` reads the discount box as money, `percent` reads it as a share of the subtotal. The box keeps
  // one value and the basis gives it its meaning, which is how the body is shaped too.
  const [discountBasis, setDiscountBasis] = useState<DiscountBasis>("amount");
  const [tax, setTax] = useState<string>("");
  const [lines, setLines] = useState<readonly LineDraft[]>([blankLine(1)]);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [saved, setSaved] = useState<EstimateSnapshot | null>(null);
  const [catalogue, setCatalogue] = useState<readonly InvoiceCatalogueOption[]>([]);
  const currency = ESTIMATE_CURRENCIES[0];

  // The catalogue is read once when the form opens, for the "fill from your catalogue" selector. A read
  // that fails leaves the selector empty rather than failing the form: every line can be typed by hand.
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [products, services] = await Promise.all([
          fetch("/api/estimates/catalogue?kind=product", { credentials: "same-origin", cache: "no-store" }),
          fetch("/api/estimates/catalogue?kind=service", { credentials: "same-origin", cache: "no-store" }),
        ]);

        if (cancelled || !products.ok || !services.ok) {
          return;
        }

        const productBody = (await products.json()) as { readonly entries?: readonly InvoiceCatalogueOption[] };
        const serviceBody = (await services.json()) as { readonly entries?: readonly InvoiceCatalogueOption[] };

        if (!cancelled) {
          setCatalogue([...(productBody.entries ?? []), ...(serviceBody.entries ?? [])]);
        }
      } catch {
        // A catalogue that cannot be read leaves the selector empty; the lines are still typable.
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  function clearError(field: string): void {
    setErrors((current) => {
      if (current[field] === undefined) {
        return current;
      }

      const next = { ...current };
      delete next[field];

      return next;
    });
  }

  function updateLine(index: number, patch: Partial<LineDraft>): void {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );

    for (const field of Object.keys(patch)) {
      clearError(`lines[${String(index)}].${field}`);
    }
  }

  /** A catalogue entry fills the description, the unit and the price, and keeps the link. */
  function fillFromCatalogue(index: number, entryId: string): void {
    const entry = catalogue.find((candidate) => candidate.id === entryId);

    if (entry === undefined) {
      return;
    }

    updateLine(index, {
      description: entry.name,
      unit: (INVOICE_UNITS as readonly string[]).includes(entry.unit)
        ? (entry.unit as InvoiceUnit)
        : INVOICE_DEFAULT_UNIT,
      unitPrice: entry.unitPrice,
      productId: entry.kind === "product" ? entry.id : "",
      serviceId: entry.kind === "service" ? entry.id : "",
    });
  }

  const lineAmounts = lines.map((line) => lineAmountOf(line));
  const subtotalMinor = lineAmounts.every((amount): amount is bigint => amount !== null)
    ? lineAmounts.reduce((total, amount) => total + amount, 0n)
    : null;
  // The discount box means one of two things, and the running total has to resolve it either way. A
  // percentage is resolved against the subtotal **on the screen**, with the same function the server uses,
  // so the merchant never reads one total before saving and another after.
  const discountBasisPoints = discountBasis === "percent" ? percentToBasisPoints(discount) : null;
  const estimateDiscountMinor =
    discountBasis === "percent"
      ? subtotalMinor === null || discountBasisPoints === null
        ? null
        : percentDiscountMinor({ subtotalMinor, basisPoints: discountBasisPoints })
      : discount.trim().length === 0
        ? 0n
        : priceToMinor(discount);
  const taxMinor = tax.trim().length === 0 ? 0n : priceToMinor(tax);
  const totalMinor =
    subtotalMinor !== null && estimateDiscountMinor !== null && taxMinor !== null
      ? subtotalMinor - estimateDiscountMinor + taxMinor
      : null;

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFailed(false);

    const expiresAt = expiryDateToInstant(expiryDate);
    const body = {
      client_id: clientId,
      currency,
      expires_at: expiresAt ?? expiryDate,
      memo,
      discount,
      discount_basis: discountBasis,
      tax,
      lines: lines.map((line) => ({
        description: line.description,
        unit: line.unit,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        discount: line.discount,
        ...(line.productId.length === 0 ? {} : { product_id: line.productId }),
        ...(line.serviceId.length === 0 ? {} : { service_id: line.serviceId }),
      })),
    };

    try {
      const response = await fetch("/api/estimates", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(body),
        credentials: "same-origin",
        cache: "no-store",
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const next: Record<string, string> = {};

        for (const detail of refusalDetails(payload)) {
          const field = typeof detail.field === "string" ? detail.field : null;

          if (field !== null && next[field] === undefined) {
            next[field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
          }
        }

        setErrors(next);
        setFailed(true);
        setMessage(getMessage("estimates.saveFailed"));

        return;
      }

      const estimate = (payload as { readonly estimate?: EstimateSnapshot }).estimate;

      if (estimate === undefined) {
        setFailed(true);
        setMessage(getMessage("estimates.saveFailed"));

        return;
      }

      setErrors({});
      setSaved(estimate);
      setMessage(getMessage("estimates.createdMessage"));
    } catch {
      setFailed(true);
      setMessage(getMessage("estimates.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  function errorLine(field: string): ReactNode {
    const error = errors[field];

    return error === undefined ? null : (
      <p className={errorClasses} role="alert">
        {error}
      </p>
    );
  }

  if (saved !== null) {
    return (
      <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <p className="text-sm font-medium">{getMessage("estimates.createdMessage")}</p>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("estimates.clientLabel")}</dt>
            <dd>{saved.client.name}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("estimates.total")}</dt>
            <dd>{saved.totals.total}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("estimates.linesSection")}</dt>
            <dd>{String(saved.lines.length)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("estimates.expiryDateLabel")}</dt>
            <dd>{saved.expiresAt.slice(0, 10)}</dd>
          </div>
        </dl>
        {/* A draft's lines are editable one at a time as well as all at once here, so the merchant is sent
            to the editor: that is where a single line is corrected without retyping the document. */}
        <Link
          className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary"
          href={`/estimates/${saved.id}`}
        >
          {getMessage("estimates.viewEstimate")}
        </Link>
      </section>
    );
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <section className={sectionClasses}>
        <div className="flex flex-col gap-1">
          <label className={labelClasses} htmlFor="estimate-client">
            {getMessage("estimates.clientLabel")}
          </label>
          {clients.length === 0 ? (
            <p className={errorClasses} role="alert">
              {getMessage("estimates.clientNone")}
            </p>
          ) : (
            <select
              aria-describedby={errors["client_id"] === undefined ? "estimate-client-hint" : undefined}
              aria-invalid={errors["client_id"] !== undefined}
              className={inputClasses}
              id="estimate-client"
              onChange={(event) => {
                setClientId(event.target.value);
                clearError("client_id");
              }}
              value={clientId}
            >
              <option value="">{getMessage("estimates.clientPlaceholder")}</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.city === null ? client.name : `${client.name} (${client.city})`}
                </option>
              ))}
            </select>
          )}
          {errors["client_id"] === undefined ? (
            <p className={hintClasses} id="estimate-client-hint">
              {clientsTruncated
                ? formatMessage("estimates.clientTruncated", { shown: clients.length })
                : getMessage("estimates.clientHint")}
            </p>
          ) : (
            errorLine("client_id")
          )}
        </div>
      </section>

      <section className={sectionClasses}>
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{getMessage("estimates.linesSection")}</h2>
          <p className={hintClasses}>{getMessage("estimates.linesDescription")}</p>
        </div>

        <div className="flex flex-col gap-4">
          {lines.map((line, index) => (
            <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3" key={line.key}>
              <legend className="px-1 text-xs font-medium text-muted-foreground">
                {formatMessage("estimates.lineNumber", { position: index + 1 })}
              </legend>

              {catalogue.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-catalogue-${String(line.key)}`}>
                    {getMessage("estimates.lineCatalogue")}
                  </label>
                  <select
                    className={inputClasses}
                    id={`line-catalogue-${String(line.key)}`}
                    onChange={(event) => {
                      fillFromCatalogue(index, event.target.value);
                    }}
                    value={line.productId.length > 0 ? line.productId : line.serviceId}
                  >
                    <option value="">{getMessage("estimates.lineCatalogueNone")}</option>
                    {catalogue.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.kind === "product"
                          ? `${getMessage("estimates.linePickProduct")}: ${entry.name}`
                          : `${getMessage("estimates.linePickService")}: ${entry.name}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className={labelClasses} htmlFor={`line-description-${String(line.key)}`}>
                  {getMessage("estimates.lineDescription")}
                </label>
                <input
                  aria-invalid={errors[`lines[${String(index)}].description`] !== undefined}
                  className={inputClasses}
                  id={`line-description-${String(line.key)}`}
                  onChange={(event) => {
                    updateLine(index, { description: event.target.value });
                  }}
                  type="text"
                  value={line.description}
                />
                {errorLine(`lines[${String(index)}].description`)}
              </div>

              {/* Two columns from `sm` up, one on a phone: a quantity and a price side by side need the
                  room, and a 320px screen does not have it. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-quantity-${String(line.key)}`}>
                    {getMessage("estimates.lineQuantity")}
                  </label>
                  <input
                    aria-describedby={
                      errors[`lines[${String(index)}].quantity`] === undefined
                        ? `line-quantity-hint-${String(line.key)}`
                        : undefined
                    }
                    aria-invalid={errors[`lines[${String(index)}].quantity`] !== undefined}
                    className={inputClasses}
                    id={`line-quantity-${String(line.key)}`}
                    inputMode="decimal"
                    onChange={(event) => {
                      updateLine(index, { quantity: event.target.value });
                    }}
                    type="text"
                    value={line.quantity}
                  />
                  {errors[`lines[${String(index)}].quantity`] === undefined ? (
                    <p className={hintClasses} id={`line-quantity-hint-${String(line.key)}`}>
                      {getMessage("estimates.lineQuantityHint")}
                    </p>
                  ) : (
                    errorLine(`lines[${String(index)}].quantity`)
                  )}
                </div>

                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-price-${String(line.key)}`}>
                    {getMessage("estimates.lineUnitPrice")}
                  </label>
                  <input
                    aria-invalid={errors[`lines[${String(index)}].unit_price`] !== undefined}
                    className={inputClasses}
                    id={`line-price-${String(line.key)}`}
                    inputMode="decimal"
                    onChange={(event) => {
                      updateLine(index, { unitPrice: event.target.value });
                    }}
                    type="text"
                    value={line.unitPrice}
                  />
                  {errorLine(`lines[${String(index)}].unit_price`)}
                </div>

                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-unit-${String(line.key)}`}>
                    {getMessage("estimates.lineUnit")}
                  </label>
                  <select
                    aria-invalid={errors[`lines[${String(index)}].unit`] !== undefined}
                    className={inputClasses}
                    id={`line-unit-${String(line.key)}`}
                    onChange={(event) => {
                      updateLine(index, { unit: event.target.value as InvoiceUnit });
                    }}
                    value={line.unit}
                  >
                    {INVOICE_UNITS.map((unit) => (
                      <option key={unit} value={unit}>
                        {unit}
                      </option>
                    ))}
                  </select>
                  {errorLine(`lines[${String(index)}].unit`)}
                </div>

                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-discount-${String(line.key)}`}>
                    {getMessage("estimates.lineDiscount")}
                  </label>
                  <input
                    aria-describedby={
                      errors[`lines[${String(index)}].discount`] === undefined
                        ? `line-discount-hint-${String(line.key)}`
                        : undefined
                    }
                    aria-invalid={errors[`lines[${String(index)}].discount`] !== undefined}
                    className={inputClasses}
                    id={`line-discount-${String(line.key)}`}
                    inputMode="decimal"
                    onChange={(event) => {
                      updateLine(index, { discount: event.target.value });
                    }}
                    type="text"
                    value={line.discount}
                  />
                  {errors[`lines[${String(index)}].discount`] === undefined ? (
                    <p className={hintClasses} id={`line-discount-hint-${String(line.key)}`}>
                      {getMessage("estimates.lineDiscountHint")}
                    </p>
                  ) : (
                    errorLine(`lines[${String(index)}].discount`)
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                <p className="text-sm">
                  {getMessage("estimates.lineTotal")}:{" "}
                  <span className="font-medium">{moneyText(lineAmounts[index] ?? null)}</span>
                </p>
                {lines.length === 1 ? null : (
                  <button
                    className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => {
                      setLines((current) => current.filter((_, position) => position !== index));
                    }}
                    type="button"
                  >
                    {formatMessage("estimates.lineRemove", { position: index + 1 })}
                  </button>
                )}
              </div>
            </fieldset>
          ))}
        </div>

        {errors["lines"] === undefined ? null : (
          <p className={errorClasses} role="alert">
            {errors["lines"]}
          </p>
        )}

        <button
          className="w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
          disabled={lines.length >= INVOICE_MAXIMUM_LINES}
          onClick={() => {
            setLines((current) => [...current, blankLine(current.length + 1)]);
          }}
          type="button"
        >
          {getMessage("estimates.lineAdd")}
        </button>
        {lines.length >= INVOICE_MAXIMUM_LINES ? (
          <p className={hintClasses}>
            {formatMessage("estimates.linesTooMany", { maximum: INVOICE_MAXIMUM_LINES })}
          </p>
        ) : null}
      </section>

      <section className={sectionClasses}>
        <h2 className="text-sm font-semibold">{getMessage("estimates.estimateSection")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="estimate-currency">
              {getMessage("estimates.currencyLabel")}
            </label>
            <select className={inputClasses} disabled id="estimate-currency" value={currency}>
              {ESTIMATE_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <p className={hintClasses}>{getMessage("estimates.currencyHint")}</p>
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="estimate-expiry">
              {getMessage("estimates.expiryDateLabel")}
            </label>
            {/* The bounds are the service's, handed to the box so a refusal cannot be reached by picking a
                day the offer could never have stood on. */}
            <input
              aria-describedby={errors["expires_at"] === undefined ? "estimate-expiry-hint" : undefined}
              aria-invalid={errors["expires_at"] !== undefined}
              className={inputClasses}
              id="estimate-expiry"
              max={maximumExpiryDate}
              min={minimumExpiryDate}
              onChange={(event) => {
                setExpiryDate(event.target.value);
                clearError("expires_at");
              }}
              type="date"
              value={expiryDate}
            />
            {errors["expires_at"] === undefined ? (
              <p className={hintClasses} id="estimate-expiry-hint">
                {formatMessage("estimates.expiryDateHint", { maximum: ESTIMATE_EXPIRY_MAXIMUM_DAYS })}
              </p>
            ) : (
              errorLine("expires_at")
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="estimate-discount-basis">
              {getMessage("estimates.discountBasisLabel")}
            </label>
            {/*
              Two radios rather than a select: there are two options, both are short, and the choice changes
              the meaning of the box below it. A select hides that behind a tap on a phone.
            */}
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm" htmlFor="estimate-discount-amount">
                <input
                  checked={discountBasis === "amount"}
                  id="estimate-discount-amount"
                  name="estimate-discount-basis"
                  onChange={() => {
                    setDiscountBasis("amount");
                    clearError("discount");
                  }}
                  type="radio"
                />
                {getMessage("estimates.discountBasisAmount")}
              </label>
              <label className="flex items-center gap-2 text-sm" htmlFor="estimate-discount-percent">
                <input
                  checked={discountBasis === "percent"}
                  id="estimate-discount-percent"
                  name="estimate-discount-basis"
                  onChange={() => {
                    setDiscountBasis("percent");
                    clearError("discount");
                  }}
                  type="radio"
                />
                {getMessage("estimates.discountBasisPercent")}
              </label>
            </div>
            <label className={labelClasses} htmlFor="estimate-discount">
              {getMessage(
                discountBasis === "percent" ? "estimates.discountPercentLabel" : "estimates.discountAmountLabel",
              )}
            </label>
            <input
              aria-invalid={errors["discount"] !== undefined}
              className={inputClasses}
              id="estimate-discount"
              inputMode="decimal"
              onChange={(event) => {
                setDiscount(event.target.value);
                clearError("discount");
              }}
              type="text"
              value={discount}
            />
            {errors["discount"] === undefined ? (
              <p className={hintClasses}>
                {getMessage(
                  discountBasis === "percent"
                    ? "estimates.discountPercentHint"
                    : "estimates.estimateDiscountHint",
                )}
              </p>
            ) : (
              errorLine("discount")
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="estimate-tax">
              {getMessage("estimates.taxLabel")}
            </label>
            <input
              aria-invalid={errors["tax"] !== undefined}
              className={inputClasses}
              id="estimate-tax"
              inputMode="decimal"
              onChange={(event) => {
                setTax(event.target.value);
                clearError("tax");
              }}
              type="text"
              value={tax}
            />
            {errors["tax"] === undefined ? (
              <p className={hintClasses}>{getMessage("estimates.taxHint")}</p>
            ) : (
              errorLine("tax")
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className={labelClasses} htmlFor="estimate-memo">
            {getMessage("estimates.memoLabel")}
          </label>
          <textarea
            aria-invalid={errors["memo"] !== undefined}
            className={inputClasses}
            id="estimate-memo"
            onChange={(event) => {
              setMemo(event.target.value);
              clearError("memo");
            }}
            rows={3}
            value={memo}
          />
          {errors["memo"] === undefined ? (
            <p className={hintClasses}>{getMessage("estimates.memoHint")}</p>
          ) : (
            errorLine("memo")
          )}
        </div>
      </section>

      <section className={sectionClasses}>
        <h2 className="text-sm font-semibold">{getMessage("estimates.totalsSection")}</h2>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("estimates.subtotal")}</dt>
            <dd>{moneyText(subtotalMinor)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("estimates.discountTotal")}</dt>
            <dd>{moneyText(estimateDiscountMinor)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("estimates.taxTotal")}</dt>
            <dd>{moneyText(taxMinor)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-1 font-medium">
            <dt>{getMessage("estimates.total")}</dt>
            <dd>{moneyText(totalMinor)}</dd>
          </div>
        </dl>
        {discountBasis === "percent" && discountBasisPoints !== null ? (
          <p className={hintClasses}>
            {formatMessage("estimates.discountPercentOf", { percent: discount.trim() })}
          </p>
        ) : null}
        {/* An em dash above means one of the three boxes is not an amount yet. Saying so is the
            difference between a total that has not been worked out and one that is missing. */}
        {subtotalMinor === null || estimateDiscountMinor === null || taxMinor === null ? (
          <p className={hintClasses}>{getMessage("estimates.amountInvalid")}</p>
        ) : null}
        <p className={hintClasses}>{getMessage("estimates.totalsNote")}</p>
      </section>

      {message === null ? null : (
        <p className={failed ? errorClasses : hintClasses} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}

      <button
        className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        disabled={busy || clients.length === 0}
        type="submit"
      >
        {getMessage(busy ? "estimates.submitting" : "estimates.submit")}
      </button>
    </form>
  );
}

/** A new empty line. The unit takes the catalogue's default; every amount stays blank. */
function blankLine(key: number): LineDraft {
  return {
    key,
    description: "",
    unit: INVOICE_DEFAULT_UNIT,
    quantity: "1",
    unitPrice: "",
    discount: "",
    productId: "",
    serviceId: "",
  };
}
