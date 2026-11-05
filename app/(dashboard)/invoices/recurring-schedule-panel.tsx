// path: app/(dashboard)/invoices/recurring-schedule-panel.tsx
"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  RECURRING_SCHEDULE_COUNT_LIMITS,
  RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS,
  RECURRING_SCHEDULE_INTERVAL_UNITS,
  RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS,
  RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS,
  RECURRING_SCHEDULE_TERMS_LIMITS,
  RECURRING_SCHEDULE_DEFAULT_UNIT,
  type RecurringScheduleIntervalUnit,
} from "@/services/invoices/recurring-schedule-fields";

/**
 * The recurring invoice schedule panel of section 16.
 *
 * ## Why the form is one screen and not a wizard
 *
 * Everything a schedule is - the template, an interval, two dates and a reminder policy - fits in eight boxes
 * and none of them needs an answer the next one depends on. A wizard would add three clicks and take away the
 * one thing a merchant wants while configuring billing: seeing the whole policy at once and changing one part
 * of it.
 *
 * ## Why the next run is shown, and why it is the server's
 *
 * "Next run" is the only line that tells a merchant whether they configured what they meant, and it is the one
 * value this form must not compute. The interval arithmetic clamps a date to the end of a short month, counts
 * from the schedule's own anchor and treats a leap day as a date that may not exist next year; a second
 * implementation in a browser would disagree with the job that actually bills. So after a save the panel reads
 * the schedule back and shows the `nextRunOn` the server computed.
 *
 * ## The widths
 *
 * One column on a phone and two from `sm` up, with the reminder pair sharing a row because they are one
 * decision. The buttons wrap rather than shrink, so "End schedule" is never a truncated tap target at 360px.
 * Ending asks once, inline, because it is the one action here that cannot be undone.
 */

const labelClasses = "text-xs font-medium text-muted-foreground";
const inputClasses =
  "mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-primary";
const hintClasses = "mt-1 text-xs text-muted-foreground";
const errorClasses = "mt-1 text-xs font-medium text-danger";
const buttonClasses =
  "rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const primaryClasses =
  "rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const dangerClasses =
  "rounded-md border border-danger px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";

/** A draft invoice a schedule may copy: the template picker's one row. */
export interface RecurringTemplateOption {
  readonly id: string;
  readonly label: string;
}

/** One schedule, as the server answered. Mirrors the service's snapshot without importing it. */
export interface RecurringScheduleView {
  readonly id: string;
  readonly status: string;
  readonly intervalUnit: string;
  readonly intervalCount: number;
  readonly startOn: string;
  readonly nextRunOn: string;
  readonly endOn: string | null;
  readonly termsDays: number;
  readonly reminderIntervalDays: number;
  readonly reminderLimit: number;
  readonly lastRunOn: string | null;
  readonly templateTotalMinor: string;
  readonly version: number;
}

interface FieldErrors {
  readonly [field: string]: string | undefined;
}

const RULE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  required: "invoices.recurringRuleRequired",
  invalid_format: "invoices.recurringRuleInvalidFormat",
  too_small: "invoices.recurringRuleTooSmall",
  too_large: "invoices.recurringRuleTooLarge",
  unknown_field: "invoices.recurringRuleUnknownField",
  not_found: "invoices.recurringRuleNotFound",
  already_used: "invoices.recurringRuleAlreadyUsed",
  not_draft: "invoices.recurringRuleNotDraft",
  client_mismatch: "invoices.recurringRuleClientMismatch",
  already_started: "invoices.recurringRuleAlreadyStarted",
  already_ended: "invoices.recurringRuleAlreadyEnded",
  absent: "invoices.recurringRuleAbsent",
});

/** A key chosen at run time is still a catalogue key, so it is narrowed once here rather than cast at each use. */
function messageOf(key: string): string {
  return getMessage(key as Parameters<typeof getMessage>[0]);
}

function ruleSentence(rule: string | null): string {
  if (rule === null) {
    return getMessage("invoices.recurringFieldInvalid");
  }

  const key = RULE_KEYS[rule];

  return key === undefined ? getMessage("invoices.recurringFieldInvalid") : messageOf(key);
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

  return Array.isArray(details) ? (details as readonly RefusalDetail[]) : [];
}

/** The minor-unit text a template total prints as, without a float anywhere on the way. */
function moneyOf(minorText: string): string {
  const minor = BigInt(minorText.length === 0 ? "0" : minorText);
  const whole = minor / 10_000n;
  const fraction = (minor % 10_000n).toString().padStart(4, "0");

  return `$${whole.toString()}.${fraction.slice(0, 2)}`;
}

/** The catalogue key for an interval unit the server sent. */
function unitKeyOf(unit: string): string {
  return unit === "day"
    ? "invoices.recurringUnitDay"
    : unit === "week"
      ? "invoices.recurringUnitWeek"
      : unit === "month"
        ? "invoices.recurringUnitMonth"
        : "invoices.recurringUnitYear";
}

export interface RecurringSchedulePanelProps {
  readonly templates: readonly RecurringTemplateOption[];
  readonly schedules: readonly RecurringScheduleView[];
  readonly truncated: boolean;
}

/**
 * The panel: the form, and the schedules a merchant already has.
 *
 * The schedules list is rendered from the server's props and updated locally after an action, so a pause shows
 * immediately without a second round trip - and a refusal replaces the row rather than leaving the screen
 * showing a status the database did not store.
 */
export function RecurringSchedulePanel({ templates, schedules, truncated }: RecurringSchedulePanelProps): ReactNode {
  const [rows, setRows] = useState<readonly RecurringScheduleView[]>(schedules);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingEnd, setPendingEnd] = useState<string | null>(null);

  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [unit, setUnit] = useState<RecurringScheduleIntervalUnit>(RECURRING_SCHEDULE_DEFAULT_UNIT);
  const [count, setCount] = useState("1");
  const [startOn, setStartOn] = useState("");
  const [endOn, setEndOn] = useState("");
  const [termsDays, setTermsDays] = useState(String(RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS));
  const [reminderInterval, setReminderInterval] = useState("0");
  const [reminderLimit, setReminderLimit] = useState("0");

  function applyRefusal(payload: unknown): void {
    const details = refusalDetails(payload);
    const next: Record<string, string> = {};

    for (const detail of details) {
      if (typeof detail.field === "string" && next[detail.field] === undefined) {
        next[detail.field] = ruleSentence(typeof detail.rule === "string" ? detail.rule : null);
      }
    }

    setErrors(next);

    if (details.length === 0) {
      setFailure(getMessage("invoices.recurringSaveFailed"));
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setErrors({});
    setFailure(null);
    setMessage(null);

    try {
      const response = await fetch("/api/invoices/recurring", {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({
          template_invoice_id: templateId,
          interval_unit: unit,
          interval_count: count,
          start_on: startOn,
          end_on: endOn.length === 0 ? null : endOn,
          terms_days: termsDays,
          reminder_interval_days: reminderInterval,
          reminder_limit: reminderLimit,
        }),
      });

      if (!response.ok) {
        applyRefusal(await response.json());
        return;
      }

      const payload = (await response.json()) as { readonly schedule: RecurringScheduleView };
      setRows((current) => [payload.schedule, ...current]);
      setMessage(getMessage("invoices.recurringCreatedMessage"));
    } catch {
      setFailure(getMessage("invoices.recurringSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function changeState(row: RecurringScheduleView, action: "pause" | "resume" | "end"): Promise<void> {
    setBusy(true);
    setFailure(null);
    setMessage(null);
    setPendingEnd(null);

    try {
      const response = await fetch(`/api/invoices/recurring/${row.id}/state`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(await csrfHeaders()) },
        body: JSON.stringify({ action, version: row.version }),
      });

      if (!response.ok) {
        const details = refusalDetails(await response.json());
        const stale = details.some((detail) => detail.rule === "already_changed");

        setFailure(getMessage(stale ? "invoices.recurringStale" : "invoices.recurringSaveFailed"));
        return;
      }

      const payload = (await response.json()) as { readonly schedule: RecurringScheduleView };
      setRows((current) => current.map((candidate) => (candidate.id === row.id ? payload.schedule : candidate)));
    } catch {
      setFailure(getMessage("invoices.recurringSaveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const statusKey = (status: string): string =>
    status === "paused"
      ? "invoices.recurringStatusPaused"
      : status === "ended"
        ? "invoices.recurringStatusEnded"
        : "invoices.recurringStatusActive";

  return (
    <div className="space-y-8">
      <section aria-labelledby="recurring-new" className="rounded-lg border border-border p-4 sm:p-6">
        <h2 id="recurring-new" className="text-sm font-semibold text-foreground">
          {getMessage("invoices.recurringNewTitle")}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{getMessage("invoices.recurringDescription")}</p>

        {templates.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{getMessage("invoices.recurringNoDrafts")}</p>
        ) : (
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div>
              <label className={labelClasses} htmlFor="recurring-template">
                {getMessage("invoices.recurringTemplateLabel")}
              </label>
              <select
                id="recurring-template"
                className={inputClasses}
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                {templates.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className={errorClasses}>{errors["template_invoice_id"]}</p>
              <p className={hintClasses}>{getMessage("invoices.recurringTemplateHint")}</p>
            </div>

            <fieldset>
              <legend className={labelClasses}>{getMessage("invoices.recurringIntervalSection")}</legend>
              <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClasses} htmlFor="recurring-unit">
                    {getMessage("invoices.recurringIntervalUnitLabel")}
                  </label>
                  <select
                    id="recurring-unit"
                    className={inputClasses}
                    value={unit}
                    onChange={(event) => setUnit(event.target.value as RecurringScheduleIntervalUnit)}
                  >
                    {RECURRING_SCHEDULE_INTERVAL_UNITS.map((value) => (
                      <option key={value} value={value}>
                        {messageOf(unitKeyOf(value))}
                      </option>
                    ))}
                  </select>
                  <p className={errorClasses}>{errors["interval_unit"]}</p>
                </div>
                <div>
                  <label className={labelClasses} htmlFor="recurring-count">
                    {getMessage("invoices.recurringIntervalCountLabel")}
                  </label>
                  <input
                    id="recurring-count"
                    className={inputClasses}
                    inputMode="numeric"
                    min={RECURRING_SCHEDULE_COUNT_LIMITS.min}
                    max={RECURRING_SCHEDULE_COUNT_LIMITS.max}
                    value={count}
                    onChange={(event) => setCount(event.target.value)}
                  />
                  <p className={errorClasses}>{errors["interval_count"]}</p>
                </div>
              </div>
            </fieldset>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClasses} htmlFor="recurring-start">
                  {getMessage("invoices.recurringStartLabel")}
                </label>
                <input
                  id="recurring-start"
                  type="date"
                  className={inputClasses}
                  value={startOn}
                  onChange={(event) => setStartOn(event.target.value)}
                />
                <p className={errorClasses}>{errors["start_on"]}</p>
                <p className={hintClasses}>{getMessage("invoices.recurringStartHint")}</p>
              </div>
              <div>
                <label className={labelClasses} htmlFor="recurring-end">
                  {getMessage("invoices.recurringEndLabel")}
                </label>
                <input
                  id="recurring-end"
                  type="date"
                  className={inputClasses}
                  value={endOn}
                  onChange={(event) => setEndOn(event.target.value)}
                />
                <p className={errorClasses}>{errors["end_on"]}</p>
                <p className={hintClasses}>{getMessage("invoices.recurringEndHint")}</p>
              </div>
            </div>

            <div>
              <label className={labelClasses} htmlFor="recurring-terms">
                {getMessage("invoices.recurringTermsLabel")}
              </label>
              <input
                id="recurring-terms"
                className={inputClasses}
                inputMode="numeric"
                min={RECURRING_SCHEDULE_TERMS_LIMITS.min}
                max={RECURRING_SCHEDULE_TERMS_LIMITS.max}
                value={termsDays}
                onChange={(event) => setTermsDays(event.target.value)}
              />
              <p className={errorClasses}>{errors["terms_days"]}</p>
              <p className={hintClasses}>{getMessage("invoices.recurringTermsHint")}</p>
            </div>

            <fieldset>
              <legend className={labelClasses}>{getMessage("invoices.recurringReminderSection")}</legend>
              <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClasses} htmlFor="recurring-reminder-interval">
                    {getMessage("invoices.recurringReminderIntervalLabel")}
                  </label>
                  <input
                    id="recurring-reminder-interval"
                    className={inputClasses}
                    inputMode="numeric"
                    min={RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS.min}
                    max={RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS.max}
                    value={reminderInterval}
                    onChange={(event) => setReminderInterval(event.target.value)}
                  />
                  <p className={errorClasses}>{errors["reminder_interval_days"]}</p>
                </div>
                <div>
                  <label className={labelClasses} htmlFor="recurring-reminder-limit">
                    {getMessage("invoices.recurringReminderLimitLabel")}
                  </label>
                  <input
                    id="recurring-reminder-limit"
                    className={inputClasses}
                    inputMode="numeric"
                    min={RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS.min}
                    max={RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS.max}
                    value={reminderLimit}
                    onChange={(event) => setReminderLimit(event.target.value)}
                  />
                  <p className={errorClasses}>{errors["reminder_limit"]}</p>
                </div>
              </div>
              <p className={hintClasses}>{getMessage("invoices.recurringReminderHint")}</p>
            </fieldset>

            {failure !== null ? <p className={errorClasses}>{failure}</p> : null}
            {message !== null ? <p className="text-xs font-medium text-success">{message}</p> : null}

            <div className="flex flex-wrap items-center gap-2">
              <button type="submit" className={primaryClasses} disabled={busy}>
                {getMessage(busy ? "invoices.recurringSubmitting" : "invoices.recurringSubmit")}
              </button>
              <Link className={buttonClasses} href="/invoices">
                {getMessage("invoices.recurringCancelled")}
              </Link>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby="recurring-list" className="space-y-3">
        <h2 id="recurring-list" className="text-sm font-semibold text-foreground">
          {getMessage("invoices.recurringTitle")}
        </h2>

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{getMessage("invoices.recurringEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.id} className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {row.intervalCount === 1
                      ? formatMessage("invoices.recurringEveryOne", { unit: messageOf(unitKeyOf(row.intervalUnit)) })
                      : formatMessage("invoices.recurringEveryValue", {
                          count: String(row.intervalCount),
                          unit: messageOf(unitKeyOf(row.intervalUnit)),
                        })}
                  </span>
                  <span className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
                    {messageOf(statusKey(row.status))}
                  </span>
                </div>

                <dl className="mt-3 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className={labelClasses}>{getMessage("invoices.recurringNextRun")}</dt>
                    <dd className="text-foreground">{row.nextRunOn}</dd>
                  </div>
                  <div>
                    <dt className={labelClasses}>{getMessage("invoices.recurringLastRun")}</dt>
                    <dd className="text-foreground">
                      {row.lastRunOn ?? getMessage("invoices.recurringNeverRun")}
                    </dd>
                  </div>
                  <div>
                    <dt className={labelClasses}>{getMessage("invoices.recurringTemplateFace")}</dt>
                    <dd className="text-foreground">{moneyOf(row.templateTotalMinor)}</dd>
                  </div>
                </dl>

                {row.status === "ended" ? null : pendingEnd === row.id ? (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-muted-foreground">{getMessage("invoices.recurringEndConfirm")}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className={dangerClasses}
                        disabled={busy}
                        onClick={() => void changeState(row, "end")}
                      >
                        {getMessage("invoices.recurringEnd")}
                      </button>
                      <button type="button" className={buttonClasses} onClick={() => setPendingEnd(null)}>
                        {getMessage("invoices.cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {row.status === "paused" ? (
                      <button
                        type="button"
                        className={buttonClasses}
                        disabled={busy}
                        onClick={() => void changeState(row, "resume")}
                      >
                        {getMessage("invoices.recurringResume")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={buttonClasses}
                        disabled={busy}
                        onClick={() => void changeState(row, "pause")}
                      >
                        {getMessage("invoices.recurringPause")}
                      </button>
                    )}
                    <button type="button" className={dangerClasses} onClick={() => setPendingEnd(row.id)}>
                      {getMessage("invoices.recurringEnd")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {truncated ? <p className="text-xs text-muted-foreground">{getMessage("invoices.recurringTruncated")}</p> : null}
      </section>
    </div>
  );
}
