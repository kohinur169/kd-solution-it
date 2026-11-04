// path: app/(dashboard)/invoices/invoice-line-editor.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { INVOICE_MAXIMUM_LINES, INVOICE_UNITS, type InvoiceUnit } from "@/services/invoices/invoice-fields";
import { grossLineMinor, quantityToThousandths } from "@/services/invoices/invoice-totals";
import type { InvoiceLine } from "@/services/invoices/invoice-lines";
import type { InvoiceSnapshot } from "@/services/invoices/invoices";
import { priceFromMinor, priceToMinor } from "@/services/products/price";

/**
 * Section 16's line item editor: add, edit, remove and order the lines of a draft.
 *
 * ## Why one row is open at a time
 *
 * A draft is edited on a phone as often as on a desktop, and twenty open rows of seven boxes is a page
 * nobody can find their place in. The list shows every line as it will print, with its amount; tapping
 * one opens that row's boxes. The alternative - every row always editable - is what the create form does,
 * and it is right there because the merchant is writing the whole document. Here they are correcting one
 * line of a document that already exists.
 *
 * ## Why every save is its own request
 *
 * Adding, editing, removing and moving are four different facts about one line, and a request that did
 * two of them would have to answer "which half failed". So each has its own endpoint and its own
 * sentence when it fails, and the list is re-read from what the server answers - never patched locally,
 * because the positions after a removal are the server's decision.
 *
 * ## Why the amounts are text
 *
 * Money is minor units in the database and a float in no layer (rule 2). Every box is a text field with
 * `inputMode="decimal"`, the conversion is decimal string arithmetic, and the row's amount shown while
 * typing is computed with `grossLineMinor` - the same function the database's generated column restates.
 *
 * ## Why the buttons know the boundaries
 *
 * "Move up" on the first line and "move down" on the last are disabled rather than hidden: a disabled
 * button tells the merchant the control exists and this is the end of the list, while a missing one looks
 * like a bug. The server treats the same request as a no-op, so the two agree.
 */

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
  already_changed: "invoices.ruleAlreadyChanged",
});

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("invoices.fieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("invoices.fieldInvalid") : getMessage(key);
}

/** Every `{field, rule}` pair a refusal named, in the order it listed them. */
function refusalDetails(payload: unknown): readonly { readonly field?: unknown; readonly rule?: unknown }[] {
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

/** The sentence a failure earns: the marked fields' first rule, or the operation's own fallback. */
function failureSentence(payload: unknown, fallback: MessagePath): string {
  const detail = refusalDetails(payload)[0];

  if (detail === undefined) {
    return getMessage(fallback);
  }

  return ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
}

const inputClasses =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-primary";
const labelClasses = "text-sm font-medium";
const hintClasses = "text-xs text-muted-foreground";
const errorClasses = "text-xs text-destructive";
const buttonBase =
  "rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";

/** One line's boxes, as text. A blank field stays blank; nothing invents a zero. */
interface LineDraft {
  description: string;
  unit: InvoiceUnit;
  quantity: string;
  unitPrice: string;
  discount: string;
}

function draftOf(line: InvoiceLine): LineDraft {
  return {
    description: line.description,
    unit: line.unit,
    // The stored price prints at four decimals; the box shows it without the trailing zeros so the
    // merchant reads 125, not 125.0000, and the parser accepts either.
    quantity: line.quantity,
    unitPrice: line.unitPrice.replace(/[.]?0+$/u, "") || "0",
    discount: line.discountMinor === "0" ? "" : (line.discount.replace(/[.]?0+$/u, "") || "0"),
  };
}

/** A row's amount while typing, or null when its numbers are not both numbers yet. */
function amountOf(draft: LineDraft): bigint | null {
  const quantity = quantityToThousandths(draft.quantity);
  const price = priceToMinor(draft.unitPrice);

  if (quantity === null || price === null) {
    return null;
  }

  const discount = draft.discount.trim().length === 0 ? 0n : priceToMinor(draft.discount);

  if (discount === null) {
    return null;
  }

  return grossLineMinor({ quantityThousandths: quantity, unitPriceMinor: price }) - discount;
}

function moneyText(minor: bigint | null): string {
  return minor === null ? "\u2014" : priceFromMinor(minor);
}

export interface InvoiceLineEditorProps {
  readonly invoice: InvoiceSnapshot;
}

export function InvoiceLineEditor({ invoice }: InvoiceLineEditorProps): ReactNode {
  const [lines, setLines] = useState<readonly InvoiceLine[]>(
    // The snapshot's lines carry the same field names `InvoiceLine` uses for everything the editor reads.
    invoice.lines.map((line) => ({
      id: line.id,
      invoiceId: invoice.id,
      position: line.position,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      unitPriceMinor: line.unitPriceMinor,
      discount: line.discount,
      discountMinor: line.discountMinor,
      lineTotalMinor: line.lineTotalMinor,
      productId: line.productId,
      serviceId: line.serviceId,
      version: 0,
      createdAtEpochMs: 0,
      updatedAtEpochMs: 0,
    })),
  );
  const [totals, setTotals] = useState(invoice.totals);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LineDraft | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  const [adding, setAdding] = useState<LineDraft>({
    description: "",
    unit: "item",
    quantity: "1",
    unitPrice: "",
    discount: "",
  });
  const [addErrors, setAddErrors] = useState<Readonly<Record<string, string>>>({});
  const draftLocked = invoice.status !== "draft";

  /** Recompute the printed totals from the lines the server answered with. */
  function adoptLines(next: readonly InvoiceLine[]): void {
    setLines(next);

    const subtotal = next.reduce((total, line) => total + BigInt(line.lineTotalMinor), 0n);

    setTotals((current) => ({
      ...current,
      subtotal: priceFromMinor(subtotal),
      subtotalMinor: subtotal.toString(),
      total: priceFromMinor(subtotal - BigInt(current.discountMinor) + BigInt(current.taxMinor)),
      totalMinor: (subtotal - BigInt(current.discountMinor) + BigInt(current.taxMinor)).toString(),
    }));
  }

  function open(line: InvoiceLine): void {
    setOpenId(line.id);
    setDraft(draftOf(line));
    setErrors({});
    setMessage(null);
    setFailed(false);
  }

  function closed(): void {
    setOpenId(null);
    setDraft(null);
    setErrors({});
  }

  /** The body one line's boxes send: every field, because an edit replaces the whole line. */
  function bodyOf(values: LineDraft): Record<string, string> {
    return {
      description: values.description,
      unit: values.unit,
      quantity: values.quantity,
      unit_price: values.unitPrice,
      discount: values.discount,
    };
  }

  async function save(lineId: string): Promise<void> {
    if (draft === null) {
      return;
    }

    setBusy(true);
    setErrors({});
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/lines/${lineId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(bodyOf(draft)),
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
        setMessage(failureSentence(payload, "invoices.editorSaveFailed"));

        return;
      }

      const saved = (payload as { readonly line?: InvoiceLine }).line;

      if (saved === undefined) {
        setFailed(true);
        setMessage(getMessage("invoices.editorSaveFailed"));

        return;
      }

      adoptLines(lines.map((entry) => (entry.id === saved.id ? saved : entry)));
      setMessage(getMessage("invoices.editorSaved"));
      closed();
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.editorSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(lineId: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/lines/${lineId}`, {
        method: "DELETE",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setFailed(true);
        setMessage(failureSentence(payload, "invoices.editorRemoveFailed"));

        return;
      }

      // The positions after a removal are the server's decision, so the list it answers with is adopted
      // whole rather than filtered locally.
      const remaining = (payload as { readonly lines?: readonly InvoiceLine[] }).lines;

      adoptLines(remaining ?? lines.filter((entry) => entry.id !== lineId));
      closed();
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.editorRemoveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function move(lineId: string, direction: "up" | "down"): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/lines/${lineId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ direction }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setFailed(true);
        setMessage(failureSentence(payload, "invoices.editorMoveFailed"));

        return;
      }

      adoptLines((payload as { readonly lines?: readonly InvoiceLine[] }).lines ?? lines);
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.editorMoveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setAddErrors({});
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/invoices/${invoice.id}/lines`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(bodyOf(adding)),
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

        setAddErrors(next);
        setFailed(true);
        setMessage(failureSentence(payload, "invoices.editorAddFailed"));

        return;
      }

      const added = (payload as { readonly line?: InvoiceLine }).line;

      if (added === undefined) {
        setFailed(true);
        setMessage(getMessage("invoices.editorAddFailed"));

        return;
      }

      adoptLines([...lines, added]);
      setAdding({ description: "", unit: "item", quantity: "1", unitPrice: "", discount: "" });
    } catch {
      setFailed(true);
      setMessage(getMessage("invoices.editorAddFailed"));
    } finally {
      setBusy(false);
    }
  }

  function errorLine(field: string, source: Readonly<Record<string, string>> = errors): ReactNode {
    const error = source[field];

    return error === undefined ? null : (
      <p className={errorClasses} role="alert">
        {error}
      </p>
    );
  }

  /** The seven boxes of one line. Shared by the add form and the open row. */
  function lineFields(
    values: LineDraft,
    onChange: (patch: Partial<LineDraft>) => void,
    source: Readonly<Record<string, string>>,
    prefix: string,
  ): ReactNode {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className={labelClasses} htmlFor={`${prefix}-description`}>
            {getMessage("invoices.lineDescription")}
          </label>
          <input
            aria-invalid={source["description"] !== undefined}
            className={inputClasses}
            id={`${prefix}-description`}
            onChange={(event) => {
              onChange({ description: event.target.value });
            }}
            type="text"
            value={values.description}
          />
          {errorLine("description", source)}
        </div>

        {/* Two columns from `sm` up; one on a phone, where two columns of money would clip. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor={`${prefix}-quantity`}>
              {getMessage("invoices.lineQuantity")}
            </label>
            <input
              aria-invalid={source["quantity"] !== undefined}
              className={inputClasses}
              id={`${prefix}-quantity`}
              inputMode="decimal"
              onChange={(event) => {
                onChange({ quantity: event.target.value });
              }}
              type="text"
              value={values.quantity}
            />
            {errorLine("quantity", source)}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor={`${prefix}-price`}>
              {getMessage("invoices.lineUnitPrice")}
            </label>
            <input
              aria-invalid={source["unit_price"] !== undefined}
              className={inputClasses}
              id={`${prefix}-price`}
              inputMode="decimal"
              onChange={(event) => {
                onChange({ unitPrice: event.target.value });
              }}
              type="text"
              value={values.unitPrice}
            />
            {errorLine("unit_price", source)}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor={`${prefix}-unit`}>
              {getMessage("invoices.lineUnit")}
            </label>
            <select
              aria-invalid={source["unit"] !== undefined}
              className={inputClasses}
              id={`${prefix}-unit`}
              onChange={(event) => {
                onChange({ unit: event.target.value as InvoiceUnit });
              }}
              value={values.unit}
            >
              {INVOICE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
            {errorLine("unit", source)}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor={`${prefix}-discount`}>
              {getMessage("invoices.lineDiscount")}
            </label>
            <input
              aria-invalid={source["discount"] !== undefined}
              className={inputClasses}
              id={`${prefix}-discount`}
              inputMode="decimal"
              onChange={(event) => {
                onChange({ discount: event.target.value });
              }}
              type="text"
              value={values.discount}
            />
            {source["discount"] === undefined ? (
              <p className={hintClasses}>{getMessage("invoices.lineDiscountHint")}</p>
            ) : (
              errorLine("discount", source)
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">{getMessage("invoices.editorLinesTitle")}</h2>

        {draftLocked ? (
          <p className="text-sm text-destructive" role="alert">
            {getMessage("invoices.editorDraftOnly")}
          </p>
        ) : null}

        {lines.length === 0 ? (
          <p className={hintClasses}>{getMessage("invoices.editorNoLines")}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {lines.map((line, index) => (
              <li className="flex flex-col gap-2 rounded-md border border-border p-3" key={line.id}>
                {openId === line.id && draft !== null ? (
                  <div className="flex flex-col gap-3">
                    {lineFields(
                      draft,
                      (patch) => {
                        setDraft((current) => (current === null ? current : { ...current, ...patch }));
                        setErrors({});
                      },
                      errors,
                      `line-${line.id}`,
                    )}
                    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                      <p className="text-sm">
                        {getMessage("invoices.lineTotal")}:{" "}
                        <span className="font-medium">{moneyText(amountOf(draft))}</span>
                      </p>
                      <button
                        className={`${buttonBase} bg-foreground text-background`}
                        disabled={busy || draftLocked}
                        onClick={() => {
                          void save(line.id);
                        }}
                        type="button"
                      >
                        {getMessage(busy ? "invoices.editorSaving" : "invoices.editorSave")}
                      </button>
                      <button
                        className={buttonBase}
                        disabled={busy}
                        onClick={() => {
                          closed();
                        }}
                        type="button"
                      >
                        {getMessage("invoices.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-xs text-muted-foreground">
                        {formatMessage("invoices.editorLine", { position: line.position })}
                      </p>
                      <p className="truncate text-sm font-medium">{line.description}</p>
                      <p className={hintClasses}>
                        {line.quantity} {"\u00d7"} {line.unitPrice.replace(/[.]?0+$/u, "") || "0"} {line.unit}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{priceFromMinor(BigInt(line.lineTotalMinor))}</p>
                      <button
                        aria-label={formatMessage("invoices.editorMoveUp", { position: line.position })}
                        className={buttonBase}
                        disabled={busy || draftLocked || index === 0}
                        onClick={() => {
                          void move(line.id, "up");
                        }}
                        type="button"
                      >
                        {getMessage("invoices.moveUp")}
                      </button>
                      <button
                        aria-label={formatMessage("invoices.editorMoveDown", { position: line.position })}
                        className={buttonBase}
                        disabled={busy || draftLocked || index === lines.length - 1}
                        onClick={() => {
                          void move(line.id, "down");
                        }}
                        type="button"
                      >
                        {getMessage("invoices.moveDown")}
                      </button>
                      <button
                        className={buttonBase}
                        disabled={busy || draftLocked}
                        onClick={() => {
                          open(line);
                        }}
                        type="button"
                      >
                        {getMessage("invoices.editLine")}
                      </button>
                      {lines.length === 1 ? null : (
                        <button
                          aria-label={formatMessage("invoices.editorRemove", { position: line.position })}
                          className={buttonBase}
                          disabled={busy || draftLocked}
                          onClick={() => {
                            void remove(line.id);
                          }}
                          type="button"
                        >
                          {getMessage("invoices.removeLine")}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {draftLocked ? null : (
        <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">{getMessage("invoices.editorAddLine")}</h2>
          <p className={hintClasses}>{getMessage("invoices.editorAddHint")}</p>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              void add(event);
            }}
          >
            {lineFields(
              adding,
              (patch) => {
                setAdding((current) => ({ ...current, ...patch }));
                setAddErrors({});
              },
              addErrors,
              "add-line",
            )}
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm">
                {getMessage("invoices.lineTotal")}: <span className="font-medium">{moneyText(amountOf(adding))}</span>
              </p>
              <button
                className="w-fit rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                disabled={busy || lines.length >= INVOICE_MAXIMUM_LINES}
                type="submit"
              >
                {getMessage(busy ? "invoices.editorAdding" : "invoices.editorAddSubmit")}
              </button>
            </div>
          </form>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">{getMessage("invoices.editorTotalsTitle")}</h2>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("invoices.subtotal")}</dt>
            <dd>{totals.subtotal}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("invoices.discountTotal")}</dt>
            <dd>{totals.discount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("invoices.taxTotal")}</dt>
            <dd>{totals.tax}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-1 font-medium">
            <dt>{getMessage("invoices.total")}</dt>
            <dd>{totals.total}</dd>
          </div>
        </dl>
      </section>

      {message === null ? null : (
        <p className={failed ? errorClasses : hintClasses} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}
    </div>
  );
}
