// path: app/(dashboard)/estimates/estimate-line-editor.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import type { MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { INVOICE_MAXIMUM_LINES, INVOICE_UNITS, type InvoiceUnit } from "@/services/invoices/invoice-fields";
import { grossLineMinor, quantityToThousandths } from "@/services/invoices/invoice-totals";
import { percentDiscountMinor, type DiscountBasis } from "@/services/invoices/invoice-discount";
import type { EstimateLineSnapshot, EstimateSnapshot } from "@/services/estimates/estimates";
import { priceFromMinor, priceToMinor } from "@/services/products/price";

/**
 * Section 16's quote lines after the quote exists: add, edit, remove and order them, and change the two
 * amounts above the total.
 *
 * ## Why one row is open at a time
 *
 * A draft is edited on a phone as often as on a desktop, and twenty open rows of seven boxes is a page
 * nobody can find their place in. The list shows every line as it will print, with its amount; tapping one
 * opens that row's boxes. The create form does the opposite - every row open - and that is right there,
 * because the merchant is writing the whole document. Here they are correcting one line of a document that
 * already exists.
 *
 * ## Why every save is its own request
 *
 * Adding, editing, removing and moving are four different facts about one line, and a request that did two
 * of them would have to answer "which half failed". So each has its own endpoint and its own sentence when
 * it fails, and the list is re-read from what the server answers - never patched locally, because the
 * positions after a removal are the server's decision and a screen that guessed them would print an order
 * the document does not have.
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
 *
 * ## Why a quote that is not a draft still renders
 *
 * Everything here is disabled rather than absent when `draftLocked`, and the reason is printed: a client
 * who was asked to accept an offer has to be able to see it, and a merchant who reaches a sent quote is
 * told why the boxes will not take input instead of being shown a page with no controls and no explanation.
 * `0026`'s trigger is the authority on the lock; this screen is the sentence that explains it.
 */

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
const sectionClasses = "flex flex-col gap-3 rounded-lg border border-border p-4";

/** One line's boxes, as text. A blank field stays blank; nothing invents a zero. */
interface LineDraft {
  description: string;
  unit: InvoiceUnit;
  quantity: string;
  unitPrice: string;
  discount: string;
}

function draftOf(line: EstimateLineSnapshot): LineDraft {
  return {
    description: line.description,
    unit: line.unit,
    quantity: line.quantity,
    unitPrice: formatMinorAsInput(line.unitPrice),
    discount: line.discountMinor === "0" ? "" : formatMinorAsInput(line.discount),
  };
}

/** One row's amount while it is being typed, or null until both of its numbers are numbers. */
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

/**
 * A printed amount as a box value: `50.8100` becomes `50.81`.
 *
 * `priceFromMinor` always prints the column's four decimal places, so the trailing zeros are padding a
 * merchant never typed and a box that showed them would be a box they had to clear before editing.
 */
function formatMinorAsInput(printed: string): string {
  return printed.replace(/[.]?0+$/u, "") || "0";
}

/** A minor unit amount as the money text the screen prints, or an em dash when it is not known. */
function moneyText(minor: bigint | null): string {
  return minor === null ? "\u2014" : priceFromMinor(minor);
}

export interface EstimateLineEditorProps {
  /** The quote as the server read it, whose lines carry their own versions. */
  readonly estimate: EstimateSnapshot;
}

export function EstimateLineEditor({ estimate }: EstimateLineEditorProps): ReactNode {
  // The snapshot's lines are already the shape this editor holds, versions and timestamps included, so
  // nothing is fabricated to fill a gap: a row the merchant edits is the row the server printed.
  const [lines, setLines] = useState<readonly EstimateLineSnapshot[]>(estimate.lines);
  const [totals, setTotals] = useState(estimate.totals);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LineDraft | null>(null);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [totalsErrors, setTotalsErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState<boolean>(false);
  // The discount and tax editor is seeded from the document as it was read, and its box holds whatever the
  // merchant typed: an amount or a percentage, according to the basis the quote recorded.
  const [discountBasis, setDiscountBasis] = useState<DiscountBasis>(estimate.totals.discountBasis);
  const [discountInput, setDiscountInput] = useState<string>(
    estimate.totals.discountBasis === "percent"
      ? estimate.totals.discountPercent
      : estimate.totals.discountMinor === "0"
        ? ""
        : formatMinorAsInput(estimate.totals.discount),
  );
  const [taxInput, setTaxInput] = useState<string>(
    estimate.totals.taxMinor === "0" ? "" : formatMinorAsInput(estimate.totals.tax),
  );
  const [adding, setAdding] = useState<LineDraft>({
    description: "",
    unit: "item",
    quantity: "1",
    unitPrice: "",
    discount: "",
  });
  const [addErrors, setAddErrors] = useState<Readonly<Record<string, string>>>({});
  const draftLocked = estimate.status !== "draft";

  /** Recompute the printed totals from the lines the server answered with. */
  function adoptLines(next: readonly EstimateLineSnapshot[]): void {
    setLines(next);

    const subtotal = next.reduce((total, line) => total + BigInt(line.lineTotalMinor), 0n);

    setTotals((current) => {
      // A percentage is a share of whatever the lines now add up to, so the panel resolves it again rather
      // than keeping the money it was worth a moment ago. The engine is the service's own, so what the
      // screen shows while the server catches up is the value the server will store: `0117`'s trigger
      // resolves the same product the same way. A flat amount is untouched, because it does not depend on
      // the lines - and if it has grown larger than they are, the refusal names `discount` and says so.
      const discountMinor =
        current.discountBasis === "percent"
          ? percentDiscountMinor({
              subtotalMinor: subtotal,
              basisPoints: BigInt(current.discountPercentBasisPoints),
            })
          : BigInt(current.discountMinor);
      const taxMinor = BigInt(current.taxMinor);
      const totalMinor = subtotal - discountMinor + taxMinor;

      return {
        ...current,
        subtotal: priceFromMinor(subtotal),
        subtotalMinor: subtotal.toString(),
        discount: priceFromMinor(discountMinor),
        discountMinor: discountMinor.toString(),
        total: priceFromMinor(totalMinor),
        totalMinor: totalMinor.toString(),
      };
    });
  }

  function open(line: EstimateLineSnapshot): void {
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

  /** The field-by-field half of a refusal, which is the same for every operation and differs only in where
   * the sentences are stored. */
  function fieldsOf(payload: unknown): Record<string, string> {
    const next: Record<string, string> = {};

    for (const detail of refusalDetails(payload)) {
      const field = typeof detail.field === "string" ? detail.field : null;

      if (field !== null && next[field] === undefined) {
        next[field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
      }
    }

    return next;
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
      const response = await fetch(`/api/estimates/${estimate.id}/lines/${lineId}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(bodyOf(draft)),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setErrors(fieldsOf(payload));
        setFailed(true);
        setMessage(failureSentence(payload, "estimates.editorSaveFailed"));

        return;
      }

      const saved = (payload as { readonly line?: EstimateLineSnapshot }).line;

      if (saved === undefined) {
        setFailed(true);
        setMessage(getMessage("estimates.editorSaveFailed"));

        return;
      }

      adoptLines(lines.map((entry) => (entry.id === saved.id ? saved : entry)));
      setMessage(getMessage("estimates.editorSaved"));
      closed();
    } catch {
      setFailed(true);
      setMessage(getMessage("estimates.editorSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(lineId: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/estimates/${estimate.id}/lines/${lineId}`, {
        method: "DELETE",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setFailed(true);
        setMessage(failureSentence(payload, "estimates.editorRemoveFailed"));

        return;
      }

      const remaining = (payload as { readonly lines?: readonly EstimateLineSnapshot[] }).lines;

      if (remaining === undefined) {
        setFailed(true);
        setMessage(getMessage("estimates.editorRemoveFailed"));

        return;
      }

      // The positions after a removal are the server's decision, so the list is taken from the answer.
      adoptLines(remaining);

      if (openId === lineId) {
        closed();
      }
    } catch {
      setFailed(true);
      setMessage(getMessage("estimates.editorRemoveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function move(lineId: string, direction: "up" | "down"): Promise<void> {
    setBusy(true);
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/estimates/${estimate.id}/lines/${lineId}/move`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ direction }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setFailed(true);
        setMessage(failureSentence(payload, "estimates.editorMoveFailed"));

        return;
      }

      const reordered = (payload as { readonly lines?: readonly EstimateLineSnapshot[] }).lines;

      if (reordered === undefined) {
        setFailed(true);
        setMessage(getMessage("estimates.editorMoveFailed"));

        return;
      }

      adoptLines(reordered);
    } catch {
      setFailed(true);
      setMessage(getMessage("estimates.editorMoveFailed"));
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
      const response = await fetch(`/api/estimates/${estimate.id}/lines`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify(bodyOf(adding)),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setAddErrors(fieldsOf(payload));
        setFailed(true);
        setMessage(failureSentence(payload, "estimates.editorAddFailed"));

        return;
      }

      const added = (payload as { readonly line?: EstimateLineSnapshot }).line;

      if (added === undefined) {
        setFailed(true);
        setMessage(getMessage("estimates.editorAddFailed"));

        return;
      }

      adoptLines([...lines, added]);
      setAdding({ description: "", unit: "item", quantity: "1", unitPrice: "", discount: "" });
      setMessage(getMessage("estimates.editorSaved"));
    } catch {
      setFailed(true);
      setMessage(getMessage("estimates.editorAddFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveTotals(): Promise<void> {
    setBusy(true);
    setTotalsErrors({});
    setMessage(null);
    setFailed(false);

    try {
      const response = await fetch(`/api/estimates/${estimate.id}/discount`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          discount: discountInput,
          discount_basis: discountBasis,
          tax: taxInput,
        }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setTotalsErrors(fieldsOf(payload));
        setFailed(true);
        setMessage(failureSentence(payload, "estimates.totalsEditorFailed"));

        return;
      }

      const stored = (payload as { readonly totals?: EstimateSnapshot["totals"] }).totals;

      if (stored === undefined) {
        setFailed(true);
        setMessage(getMessage("estimates.totalsEditorFailed"));

        return;
      }

      // The four amounts are the row's, re-read after the write: the total is `estimates_derive_total`'s
      // and the resolved percentage is `0117`'s, and neither is this screen's arithmetic.
      setTotals(stored);
      setDiscountBasis(stored.discountBasis);
      setMessage(getMessage("estimates.totalsEditorSaved"));
    } catch {
      setFailed(true);
      setMessage(getMessage("estimates.totalsEditorFailed"));
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

  /**
   * The five boxes one line has, shared by the open row and the add form.
   *
   * One renderer for both, deliberately: a line is the same five values whichever of the two it is being
   * typed into, and two copies of the markup would be two places for the field names to drift apart from
   * the ones the service refuses with.
   */
  function lineFields(
    values: LineDraft,
    onChange: (patch: Partial<LineDraft>) => void,
    source: Readonly<Record<string, string>>,
    idPrefix: string,
  ): ReactNode {
    return (
      <>
        <div className="flex flex-col gap-1">
          <label className={labelClasses} htmlFor={`${idPrefix}-description`}>
            {getMessage("estimates.lineDescription")}
          </label>
          <input
            aria-invalid={source["description"] !== undefined}
            className={inputClasses}
            id={`${idPrefix}-description`}
            onChange={(event) => {
              onChange({ description: event.target.value });
            }}
            type="text"
            value={values.description}
          />
          {errorLine("description", source)}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor={`${idPrefix}-quantity`}>
              {getMessage("estimates.lineQuantity")}
            </label>
            <input
              aria-describedby={source["quantity"] === undefined ? `${idPrefix}-quantity-hint` : undefined}
              aria-invalid={source["quantity"] !== undefined}
              className={inputClasses}
              id={`${idPrefix}-quantity`}
              inputMode="decimal"
              onChange={(event) => {
                onChange({ quantity: event.target.value });
              }}
              type="text"
              value={values.quantity}
            />
            {source["quantity"] === undefined ? (
              <p className={hintClasses} id={`${idPrefix}-quantity-hint`}>
                {getMessage("estimates.lineQuantityHint")}
              </p>
            ) : (
              errorLine("quantity", source)
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label className={labelClasses} htmlFor={`${idPrefix}-unit-price`}>
              {getMessage("estimates.lineUnitPrice")}
            </label>
            <input
              aria-invalid={source["unit_price"] !== undefined}
              className={inputClasses}
              id={`${idPrefix}-unit-price`}
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
            <label className={labelClasses} htmlFor={`${idPrefix}-unit`}>
              {getMessage("estimates.lineUnit")}
            </label>
            <select
              aria-invalid={source["unit"] !== undefined}
              className={inputClasses}
              id={`${idPrefix}-unit`}
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
            <label className={labelClasses} htmlFor={`${idPrefix}-discount`}>
              {getMessage("estimates.lineDiscount")}
            </label>
            <input
              aria-describedby={source["discount"] === undefined ? `${idPrefix}-discount-hint` : undefined}
              aria-invalid={source["discount"] !== undefined}
              className={inputClasses}
              id={`${idPrefix}-discount`}
              inputMode="decimal"
              onChange={(event) => {
                onChange({ discount: event.target.value });
              }}
              type="text"
              value={values.discount}
            />
            {source["discount"] === undefined ? (
              <p className={hintClasses} id={`${idPrefix}-discount-hint`}>
                {getMessage("estimates.lineDiscountHint")}
              </p>
            ) : (
              errorLine("discount", source)
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={sectionClasses}>
        <h2 className="text-sm font-semibold">{getMessage("estimates.editorLinesTitle")}</h2>

        {draftLocked ? (
          <p className="text-sm text-destructive" role="alert">
            {getMessage("estimates.editorDraftOnly")}
          </p>
        ) : null}

        {lines.length === 0 ? (
          <p className={hintClasses}>{getMessage("estimates.editorNoLines")}</p>
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
                        {getMessage("estimates.lineTotal")}:{" "}
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
                        {getMessage(busy ? "estimates.editorSaving" : "estimates.editorSave")}
                      </button>
                      <button
                        className={buttonBase}
                        disabled={busy}
                        onClick={() => {
                          closed();
                        }}
                        type="button"
                      >
                        {getMessage("estimates.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-xs text-muted-foreground">
                        {formatMessage("estimates.editorLine", { position: line.position })}
                      </p>
                      <p className="truncate text-sm font-medium">{line.description}</p>
                      <p className={hintClasses}>
                        {line.quantity} {"\u00d7"} {formatMinorAsInput(line.unitPrice)} {line.unit}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{priceFromMinor(BigInt(line.lineTotalMinor))}</p>
                      <button
                        aria-label={formatMessage("estimates.editorMoveUp", { position: line.position })}
                        className={buttonBase}
                        disabled={busy || draftLocked || index === 0}
                        onClick={() => {
                          void move(line.id, "up");
                        }}
                        type="button"
                      >
                        {getMessage("estimates.moveUp")}
                      </button>
                      <button
                        aria-label={formatMessage("estimates.editorMoveDown", { position: line.position })}
                        className={buttonBase}
                        disabled={busy || draftLocked || index === lines.length - 1}
                        onClick={() => {
                          void move(line.id, "down");
                        }}
                        type="button"
                      >
                        {getMessage("estimates.moveDown")}
                      </button>
                      <button
                        className={buttonBase}
                        disabled={busy || draftLocked}
                        onClick={() => {
                          open(line);
                        }}
                        type="button"
                      >
                        {getMessage("estimates.editLine")}
                      </button>
                      {/* The last line has no remove button, because a quote with no lines is not a
                          document: the server refuses it, and a button that cannot work is worse than no
                          button. */}
                      {lines.length === 1 ? null : (
                        <button
                          aria-label={formatMessage("estimates.editorRemove", { position: line.position })}
                          className={buttonBase}
                          disabled={busy || draftLocked}
                          onClick={() => {
                            void remove(line.id);
                          }}
                          type="button"
                        >
                          {getMessage("estimates.removeLine")}
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
        <section className={sectionClasses}>
          <h2 className="text-sm font-semibold">{getMessage("estimates.editorAddLine")}</h2>
          <p className={hintClasses}>{getMessage("estimates.editorAddHint")}</p>
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
              "adding",
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
              <p className="text-sm">
                {getMessage("estimates.lineTotal")}: <span className="font-medium">{moneyText(amountOf(adding))}</span>
              </p>
              <button
                className={`${buttonBase} bg-foreground text-background`}
                disabled={busy || lines.length >= INVOICE_MAXIMUM_LINES}
                type="submit"
              >
                {getMessage(busy ? "estimates.editorAdding" : "estimates.editorAddSubmit")}
              </button>
            </div>
            {lines.length >= INVOICE_MAXIMUM_LINES ? (
              <p className={hintClasses}>
                {formatMessage("estimates.linesTooMany", { maximum: INVOICE_MAXIMUM_LINES })}
              </p>
            ) : null}
            {errorLine("lines", addErrors)}
          </form>
        </section>
      )}

      <section className={sectionClasses}>
        <h2 className="text-sm font-semibold">{getMessage("estimates.editorTotalsTitle")}</h2>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("estimates.subtotal")}</dt>
            <dd>{totals.subtotal}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("estimates.discountTotal")}</dt>
            <dd>{totals.discount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className={hintClasses}>{getMessage("estimates.taxTotal")}</dt>
            <dd>{totals.tax}</dd>
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-1 font-medium">
            <dt>{getMessage("estimates.total")}</dt>
            <dd>{totals.total}</dd>
          </div>
        </dl>

        {draftLocked ? (
          <p className={hintClasses}>{getMessage("estimates.totalsEditorDiscountFrozen")}</p>
        ) : (
          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <h3 className="text-sm font-semibold">{getMessage("estimates.totalsEditorTitle")}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <span className={labelClasses} id="totals-discount-basis">
                  {getMessage("estimates.discountBasisLabel")}
                </span>
                <div aria-labelledby="totals-discount-basis" className="flex flex-wrap items-center gap-4" role="group">
                  <label className="flex items-center gap-2 text-sm" htmlFor="totals-discount-amount">
                    <input
                      checked={discountBasis === "amount"}
                      id="totals-discount-amount"
                      name="totals-discount-basis"
                      onChange={() => {
                        setDiscountBasis("amount");
                        setTotalsErrors({});
                      }}
                      type="radio"
                    />
                    {getMessage("estimates.discountBasisAmount")}
                  </label>
                  <label className="flex items-center gap-2 text-sm" htmlFor="totals-discount-percent">
                    <input
                      checked={discountBasis === "percent"}
                      id="totals-discount-percent"
                      name="totals-discount-basis"
                      onChange={() => {
                        setDiscountBasis("percent");
                        setTotalsErrors({});
                      }}
                      type="radio"
                    />
                    {getMessage("estimates.discountBasisPercent")}
                  </label>
                </div>
                {errorLine("discount_basis", totalsErrors)}
              </div>

              <div className="flex flex-col gap-1">
                <label className={labelClasses} htmlFor="totals-discount">
                  {getMessage(
                    discountBasis === "percent"
                      ? "estimates.discountPercentLabel"
                      : "estimates.discountAmountLabel",
                  )}
                </label>
                <input
                  aria-describedby={totalsErrors["discount"] === undefined ? "totals-discount-hint" : undefined}
                  aria-invalid={totalsErrors["discount"] !== undefined}
                  className={inputClasses}
                  id="totals-discount"
                  inputMode="decimal"
                  onChange={(event) => {
                    setDiscountInput(event.target.value);
                    setTotalsErrors({});
                  }}
                  type="text"
                  value={discountInput}
                />
                {totalsErrors["discount"] === undefined ? (
                  <p className={hintClasses} id="totals-discount-hint">
                    {getMessage(
                      discountBasis === "percent"
                        ? "estimates.discountPercentHint"
                        : "estimates.estimateDiscountHint",
                    )}
                  </p>
                ) : (
                  errorLine("discount", totalsErrors)
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className={labelClasses} htmlFor="totals-tax">
                  {getMessage("estimates.taxLabel")}
                </label>
                <input
                  aria-invalid={totalsErrors["tax"] !== undefined}
                  className={inputClasses}
                  id="totals-tax"
                  inputMode="decimal"
                  onChange={(event) => {
                    setTaxInput(event.target.value);
                    setTotalsErrors({});
                  }}
                  type="text"
                  value={taxInput}
                />
                {totalsErrors["tax"] === undefined ? (
                  <p className={hintClasses}>{getMessage("estimates.taxHint")}</p>
                ) : (
                  errorLine("tax", totalsErrors)
                )}
              </div>
            </div>

            <button
              className={`${buttonBase} w-fit bg-foreground px-4 py-2 text-sm text-background`}
              disabled={busy}
              onClick={() => {
                void saveTotals();
              }}
              type="button"
            >
              {getMessage(busy ? "estimates.totalsEditorSaving" : "estimates.totalsEditorSave")}
            </button>
          </div>
        )}
      </section>

      {message === null ? null : (
        <p className={failed ? errorClasses : hintClasses} role={failed ? "alert" : "status"}>
          {message}
        </p>
      )}
    </div>
  );
}
