// path: app/(dashboard)/invoices/invoice-form.tsx
"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  INVOICE_CURRENCIES,
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
  InvoiceSnapshot,
} from "@/services/invoices/invoices";
import { priceFromMinor, priceToMinor } from "@/services/products/price";

/**
 * Section 16's invoice create form.
 *
 * ## Why the totals are computed here as well as on the server
 *
 * `0023` computes every line total in the database, and the server's answer is what gets stored. But a
 * merchant editing a quantity needs to see the amount change as they type: a form that waited for a
 * round trip before showing a total is a form nobody trusts. The arithmetic is not reimplemented here
 * in a second dialect - `invoice-totals.ts` is imported, the same module the service and the gate use,
 * and the panel says in words that the server recalculates on save.
 *
 * ## Why the money is text
 *
 * Money is stored in minor units and never in a float (rule 2), and a number input in a browser is a
 * float. So every amount is a text box with `inputMode="decimal"`, the conversion is decimal string
 * arithmetic, and an amount that is not one shows an em dash rather than a guessed number. Nothing here
 * rounds; `grossLineMinor` is the database's own rule.
 *
 * ## Why every refusal is read field by field
 *
 * The service names a broken field as `lines[2].unit_price`, so the form marks the right box on the
 * right row instead of one "line items" error above a list of twenty. A rule this build does not know
 * still produces a sentence rather than an empty line under the box.
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
  required: "invoices.ruleRequired",
  too_short: "invoices.ruleTooShort",
  too_long: "invoices.ruleTooLong",
  invalid_format: "invoices.ruleInvalidFormat",
  too_large: "invoices.ruleTooLarge",
  too_small: "invoices.ruleTooSmall",
  unknown_field: "invoices.ruleUnknownField",
  not_found: "invoices.ruleNotFound",
  too_many: "invoices.ruleTooMany",
  empty: "invoices.ruleEmpty",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("invoices.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("invoices.fieldInvalid") : getMessage(key);
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

/** A `yyyy-mm-dd` date box value as the instant the service stores: midnight UTC of that day. */
function dueDateToInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }

  const parsed = Date.parse(`${value}T00:00:00.000Z`);

  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * One line's amount, or null when its two numbers are not both numbers yet.
 *
 * The discount is subtracted only when it parses, so half-typed input shows a running amount instead of
 * a dash. A discount larger than the line leaves the amount negative on the screen, which is the visible
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

export interface InvoiceFormProps {
  /** The clients the selector may offer, read on the server with the session's own scope. */
  readonly clients: readonly InvoiceClientOption[];
  readonly clientsTruncated: boolean;
  /** The due date the form opens with, as a `yyyy-mm-dd` box value, decided on the server. */
  readonly defaultDueDate: string;
}

export function InvoiceForm({ clients, clientsTruncated, defaultDueDate }: InvoiceFormProps): ReactNode {
  const [clientId, setClientId] = useState<string>("");
  const [dueDate, setDueDate] = useState<string>(defaultDueDate);
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
  const [saved, setSaved] = useState<InvoiceSnapshot | null>(null);
  const [catalogue, setCatalogue] = useState<readonly InvoiceCatalogueOption[]>([]);
  const currency = INVOICE_CURRENCIES[0];

  // The catalogue is read once when the form opens, for the "fill from your catalogue" selector. A read
  // that fails leaves the selector empty rather than failing the form: every line can be typed by hand.
  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const [products, services] = await Promise.all([
          fetch("/api/invoices/catalogue?kind=product", { credentials: "same-origin", cache: "no-store" }),
          fetch("/api/invoices/catalogue?kind=service", { credentials: "same-origin", cache: "no-store" }),
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
  // percentage is resolved against the subtotal **on the screen**, with the same function the server uses, so
  // the merchant never reads one total before saving and another after.
  const discountBasisPoints =
    discountBasis === "percent" ? percentToBasisPoints(discount) : null;
  const invoiceDiscountMinor =
    discountBasis === "percent"
      ? subtotalMinor === null || discountBasisPoints === null
        ? null
        : percentDiscountMinor({ subtotalMinor, basisPoints: discountBasisPoints })
      : discount.trim().length === 0
        ? 0n
        : priceToMinor(discount);
  const taxMinor = tax.trim().length === 0 ? 0n : priceToMinor(tax);
  const totalMinor =
    subtotalMinor !== null && invoiceDiscountMinor !== null && taxMinor !== null
      ? subtotalMinor - invoiceDiscountMinor + taxMinor
      : null;

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setFailed(false);

    const dueAt = dueDateToInstant(dueDate);
    const body = {
      client_id: clientId,
      currency,
      due_at: dueAt ?? dueDate,
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
      const response = await fetch("/api/invoices", {
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
        setMessage(getMessage("invoices.saveFailed"));

        return;
      }

      const invoice = (payload as { readonly invoice?: InvoiceSnapshot }).invoice;

      if (invoice === undefined) {
        setFailed(true);
        setMessage(getMessage("invoices.saveFailed"));

        return;
      }

      setErrors({});
      setSaved(invoice);
      setMessage(getMessage("invoices.createdMessage"));
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.saveFailed"));
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
        <p className="text-sm font-medium">{getMessage("invoices.createdMessage")}</p>
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("invoices.clientLabel")}</dt>
            <dd>{saved.client.name}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("invoices.total")}</dt>
            <dd>{saved.totals.total}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("invoices.linesSection")}</dt>
            <dd>{String(saved.lines.length)}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className={hintClasses}>{getMessage("invoices.dueDateLabel")}</dt>
            <dd>{saved.dueAt.slice(0, 10)}</dd>
          </div>
        </dl>
        {/* A draft is written in two passes: the document here, then the lines one at a time. Sending the
            merchant straight to the editor is what makes that second pass reachable at all. */}
        <Link
          className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary"
          href={`/invoices/${saved.id}`}
        >
          {getMessage("invoices.viewInvoice")}
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
          <label className={labelClasses} htmlFor="invoice-client">
            {getMessage("invoices.clientLabel")}
          </label>
          {clients.length === 0 ? (
            <p className={errorClasses} role="alert">
              {getMessage("invoices.clientNone")}
            </p>
          ) : (
            <select
              aria-describedby={errors["client_id"] === undefined ? "invoice-client-hint" : undefined}
              aria-invalid={errors["client_id"] !== undefined}
              className={inputClasses}
              id="invoice-client"
              onChange={(event) => {
                setClientId(event.target.value);
                clearError("client_id");
              }}
              value={clientId}
            >
              <option value="">{getMessage("invoices.clientPlaceholder")}</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.city === null ? client.name : `${client.name} (${client.city})`}
                </option>
              ))}
            </select>
          )}
          {errors["client_id"] === undefined ? (
            <p className={hintClasses} id="invoice-client-hint">
              {clientsTruncated
                ? formatMessage("invoices.clientTruncated", { shown: clients.length })
                : getMessage("invoices.clientHint")}
            </p>
          ) : (
            errorLine("client_id")
          )}
        </div>
      </section>

      <section className={sectionClasses}>
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-semibold">{getMessage("invoices.linesSection")}</h2>
          <p className={hintClasses}>{getMessage("invoices.linesDescription")}</p>
        </div>

        <div className="flex flex-col gap-4">
          {lines.map((line, index) => (
            <fieldset className="flex flex-col gap-3 rounded-md border border-border p-3" key={line.key}>
              <legend className="px-1 text-xs font-medium text-muted-foreground">
                {formatMessage("invoices.lineNumber", { position: index + 1 })}
              </legend>

              {catalogue.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-catalogue-${String(line.key)}`}>
                    {getMessage("invoices.lineCatalogue")}
                  </label>
                  <select
                    className={inputClasses}
                    id={`line-catalogue-${String(line.key)}`}
                    onChange={(event) => {
                      fillFromCatalogue(index, event.target.value);
                    }}
                    value={line.productId.length > 0 ? line.productId : line.serviceId}
                  >
                    <option value="">{getMessage("invoices.lineCatalogueNone")}</option>
                    {catalogue.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.kind === "product"
                          ? `${getMessage("invoices.linePickProduct")}: ${entry.name}`
                          : `${getMessage("invoices.linePickService")}: ${entry.name}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label className={labelClasses} htmlFor={`line-description-${String(line.key)}`}>
                  {getMessage("invoices.lineDescription")}
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
                    {getMessage("invoices.lineQuantity")}
                  </label>
                  <input
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
                  {errorLine(`lines[${String(index)}].quantity`)}
                </div>

                <div className="flex flex-col gap-1">
                  <label className={labelClasses} htmlFor={`line-price-${String(line.key)}`}>
                    {getMessage("invoices.lineUnitPrice")}
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
                    {getMessage("invoices.lineUnit")}
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
                    {getMessage("invoices.lineDiscount")}
                  </label>
                  <input
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
                  {errorLine(`lines[${String(index)}].discount`)}
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                <p className="text-sm">
                  {getMessage("invoices.lineTotal")}: <span className="font-medium">{moneyText(lineAmounts[index] ?? null)}</span>
                </p>
                {lines.length === 1 ? null : (
                  <button
                    className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                    onClick={() => {
                      setLines((current) => current.filter((_, position) => position !== index));
                    }}
                    type="button"
                  >
                    {formatMessage("invoices.lineRemove", { position: index + 1 })}
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
          {getMessage("invoices.lineAdd")}
        </button>
        {lines.length >= INVOICE_MAXIMUM_LINES ? (
          <p className={hintClasses}>
            {formatMessage("invoices.linesTooMany", { maximum: INVOICE_MAXIMUM_LINES })}
          </p>
        ) : null}
      </section>

      <section className={sectionClasses}>
        <h2 className="text-sm font-semibold">{getMessage("invoices.invoiceSection")}</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="invoice-currency">
              {getMessage("invoices.currencyLabel")}
            </label>
            <select className={inputClasses} disabled id="invoice-currency" value={currency}>
              {INVOICE_CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
            <p className={hintClasses}>{getMessage("invoices.currencyHint")}</p>
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="invoice-due">
              {getMessage("invoices.dueDateLabel")}
            </label>
            <input
              aria-describedby={errors["due_at"] === undefined ? "invoice-due-hint" : undefined}
              aria-invalid={errors["due_at"] !== undefined}
              className={inputClasses}
              id="invoice-due"
              onChange={(event) => {
                setDueDate(event.target.value);
                clearError("due_at");
              }}
              type="date"
              value={dueDate}
            />
            {errors["due_at"] === undefined ? (
              <p className={hintClasses} id="invoice-due-hint">
                {getMessage("invoices.dueDateHint")}
              </p>
            ) : (
              errorLine("due_at")
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="invoice-discount-basis">
              {getMessage("invoices.discountBasisLabel")}
            </label>
            {/*
              Two radios rather than a select: there are two options, both are short, and the choice changes
              the meaning of the box below it. A select hides that behind a tap on a phone.
            */}
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm" htmlFor="invoice-discount-amount">
                <input
                  checked={discountBasis === "amount"}
                  id="invoice-discount-amount"
                  name="discount-basis"
                  onChange={() => {
                    setDiscountBasis("amount");
                    clearError("discount");
                  }}
                  type="radio"
                />
                {getMessage("invoices.discountBasisAmount")}
              </label>
              <label className="flex items-center gap-2 text-sm" htmlFor="invoice-discount-percent">
                <input
                  checked={discountBasis === "percent"}
                  id="invoice-discount-percent"
                  name="discount-basis"
                  onChange={() => {
                    setDiscountBasis("percent");
                    clearError("discount");
                  }}
                  type="radio"
                />
                {getMessage("invoices.discountBasisPercent")}
              </label>
            </div>
            <label className={labelClasses} htmlFor="invoice-discount">
              {getMessage(
                discountBasis === "percent" ? "invoices.discountPercentLabel" : "invoices.discountAmountLabel",
              )}
            </label>
            <input
              aria-invalid={errors["discount"] !== undefined}
              className={inputClasses}
              id="invoice-discount"
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
                    ? "invoices.discountPercentHint"
                    : "invoices.invoiceDiscountHint",
                )}
              </p>
            ) : (
              errorLine("discount")
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor="invoice-tax">
              {getMessage("invoices.taxLabel")}
            </label>
            <input
              aria-invalid={errors["tax"] !== undefined}
              className={inputClasses}
              id="invoice-tax"
              inputMode="decimal"
              onChange={(event) => {
                setTax(event.target.value);
                clearError("tax");
              }}
              type="text"
              value={tax}
            />
            {errors["tax"] === undefined ? (
              <p className={hintClasses}>{getMessage("invoices.taxHint")}</p>
            ) : (
              errorLine("tax")
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className={labelClasses} htmlFor="invoice-memo">
            {getMessage("invoices.memoLabel")}
          </label>
          <textarea
            aria-invalid={errors["memo"] !== undefined}
            className={inputClasses}
            id="invoice-memo"
            onChange={(event) => {
              setMemo(event.target.value);
              clearError("memo");
            }}
            rows={3}
            value={memo}
          />
          {errors["memo"] === undefined ? (
            <p className={hintClasses}>{getMessage("invoices.memoHint")}</p>
          ) : (
            errorLine("memo")
          )}
        </div>
      </section>

      <section className={sectionClasses}>
        <h2 className="text-sm font-semibold">{getMessage("invoices.totalsSection")}</h2>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("invoices.subtotal")}</dt>
            <dd>{moneyText(subtotalMinor)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("invoices.discountTotal")}</dt>
            <dd>{moneyText(invoiceDiscountMinor)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("invoices.taxTotal")}</dt>
            <dd>{moneyText(taxMinor)}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-1 font-medium">
            <dt>{getMessage("invoices.total")}</dt>
            <dd>{moneyText(totalMinor)}</dd>
          </div>
        </dl>
        <p className={hintClasses}>{getMessage("invoices.totalsNote")}</p>
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
        {getMessage(busy ? "invoices.submitting" : "invoices.submit")}
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
