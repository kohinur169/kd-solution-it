// path: app/(dashboard)/settlements/settlement-statement-panel.tsx
"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";

const labelClasses = "text-xs font-medium text-muted-foreground";
const inputClasses =
  "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-primary";
const hintClasses = "mt-1 text-xs text-muted-foreground";
const errorClasses = "mt-1 text-xs font-medium text-danger";
const primaryClasses =
  "rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const panelClasses = "space-y-4 rounded-lg border border-border bg-card p-4";

/** The day a statement takes, `YYYY-MM-DD`, the two inputs and the query all read the same way. */
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** The day a statement takes, in the form the input hands it back. */
function dayOf(value: string): boolean {
  return DAY.test(value);
}

/** The first day of this month and today, the period the picker opens on. */
function defaultPeriod(): { readonly from: string; readonly to: string } {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return { from: `${year}-${month}-01`, to: `${year}-${month}-${day}` };
}

/**
 * Section 17's statement download: pick a first day and a last day, and the merchant's settlement
 * balance comes back as a CSV file, one line per movement, newest first.
 *
 * ## Why the download is a link the page answers, not a form
 *
 * A statement is a file, and a file the browser saves is a file the merchant opens in a spreadsheet.
 * The page asks the read endpoint for the days it picked and follows the attachment it is handed. The
 * read answers the file with an attachment name the browser keeps, so the saved file says the period
 * it covers without the merchant having to remember it.
 *
 * ## Why the days are judged before the request goes
 *
 * The endpoint refuses a first day after the last day and a day not in the form, and the page says
 * the same two things before a request it knows the endpoint will refuse is sent at all. A request
 * the page already knows is a refusal is a round trip the merchant pays for nothing.
 *
 * ## The widths
 *
 * One column on a phone and two from `sm` up, the days sharing a row because they are one period.
 * The button and the message sit below, full width, so the message is never a truncated line at 360px.
 */
export function SettlementStatementPanel(): ReactNode {
  const defaults = defaultPeriod();
  const [from, setFrom] = useState<string>(defaults.from);
  const [to, setTo] = useState<string>(defaults.to);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  const reversed = dayOf(from) && dayOf(to) && from > to;

  async function download(): Promise<void> {
    if (!dayOf(from) || !dayOf(to) || reversed) {
      setError(getMessage(reversed ? "settlements.periodReversed" : "settlements.periodInvalid"));

      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/settlements/statements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );

      if (response.ok) {
        const file = await response.blob();
        const url = URL.createObjectURL(file);
        const anchor = document.createElement("a");

        anchor.href = url;
        anchor.download = `settlement-statement_${from}_${to}.csv`;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);

        return;
      }

      setError(await refusalSentence(response));
    } catch {
      setError(getMessage("settlements.failed"));
    } finally {
      setSaving(false);
    }
  }

  /** The refusal the endpoint sent, in the words the merchant reads on this page. */
  async function refusalSentence(response: Response): Promise<string> {
    if (response.status === 401) {
      return getMessage("settlements.signedOut");
    }

    if (response.status === 403) {
      return getMessage("settlements.forbidden");
    }

    if (response.status === 422) {
      let rule: string | null = null;

      try {
        const parsed: unknown = JSON.parse(await response.text());

        if (typeof parsed === "object" && parsed !== null) {
          const details = (parsed as { readonly details?: unknown }).details;

          if (Array.isArray(details) && details.length > 0) {
            const first = details[0] as { readonly rule?: unknown };

            if (typeof first?.rule === "string") {
              rule = first.rule;
            }
          }
        }
      } catch {
        rule = null;
      }

      if (rule === "period_reversed") {
        return getMessage("settlements.periodReversed");
      }

      if (rule === "statement_too_long") {
        return getMessage("settlements.statementTooLong");
      }

      return getMessage("settlements.periodInvalid");
    }

    return getMessage("settlements.failed");
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void download();
  }

  return (
    <div className={panelClasses}>
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{getMessage("settlements.panelTitle")}</h2>
        <p className="text-xs text-muted-foreground">{getMessage("settlements.lead")}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClasses} htmlFor="statement-from">
              {getMessage("settlements.fromLabel")}
            </label>
            <input
              id="statement-from"
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClasses}
              aria-invalid={reversed || !dayOf(from)}
              required
            />
            <p className={hintClasses}>{getMessage("settlements.fromHint")}</p>
          </div>
          <div>
            <label className={labelClasses} htmlFor="statement-to">
              {getMessage("settlements.toLabel")}
            </label>
            <input
              id="statement-to"
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={inputClasses}
              aria-invalid={reversed || !dayOf(to)}
              required
            />
            <p className={hintClasses}>{getMessage("settlements.toHint")}</p>
          </div>
        </div>

        {error !== null ? (
          <p role="alert" className={errorClasses}>
            {error}
          </p>
        ) : null}

        <div>
          <button type="submit" disabled={saving} className={primaryClasses}>
            {saving ? getMessage("settlements.preparing") : getMessage("settlements.download")}
          </button>
        </div>
      </form>
    </div>
  );
}
