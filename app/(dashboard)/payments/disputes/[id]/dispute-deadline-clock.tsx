// path: app/(dashboard)/payments/disputes/[id]/dispute-deadline-clock.tsx
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getMessage, formatMessage } from "@/lib/i18n/messages";
import {
  localDeadlineOf,
  localOffsetShiftOf,
  disputeRemainingOf,
  readDisputeTimeZone,
  type DisputeRemaining,
} from "@/services/disputes/dispute-deadline";

/**
 * The dispute deadline, printed twice: once in the merchant's own time zone and once in UTC.
 *
 * ## Why this is the one client component on the page
 *
 * Only the browser knows which zone the merchant is sitting in. The server can say the instant - it is a
 * `timestamptz` and it is the same instant for everybody - but "the merchant's own time zone" in section 19 is
 * a fact about the person, not about the row, and no column holds it. So the page renders the UTC line on the
 * server (deterministic, no hydration risk) and this component adds the local line, the zone's name, the
 * offset and the countdown once it is running in the browser.
 *
 * ## What it deliberately does not do
 *
 * It does not decide whether a save is allowed. A countdown that reached zero in a tab opened an hour ago is
 * still a countdown that reached zero, and a page that trusted its own clock would refuse a merchant whose
 * machine is slow. The form sends the words and the service decides, against `response_due_at` and the
 * database's clock; this component's verdict is advisory and says so in the wording ("the window has closed"),
 * while the refusal that matters arrives from the save.
 *
 * ## Why the local line can read shorter or longer than the window
 *
 * On the two days a year a zone changes its offset, twenty-four absolute hours are twenty-three or twenty-five
 * wall-clock hours. The platform keeps the absolute window - `0039`'s `disputes_due_check` requires it and a
 * shrinking window would take back time nobody chose to take back - so the note explains the difference
 * instead of leaving a merchant to notice it. That note only appears when the offsets actually differ.
 */

const cardClasses = "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card";

const headingClasses = "text-sm font-semibold uppercase tracking-wide text-muted-foreground";

const gridClasses = "grid grid-cols-1 gap-2 sm:grid-cols-[11rem_1fr]";

const termClasses = "text-sm text-muted-foreground";

const definitionClasses = "text-sm font-medium tabular-nums text-foreground";

const noteClasses = "text-xs text-muted-foreground";

const alertClasses = "text-sm font-medium text-destructive";

const soonClasses = "text-sm font-medium text-foreground";

/** One instant, UTC, minute precision: the same shape every other screen prints. */
function utcTextOf(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The countdown as one sentence. */
function remainingTextOf(remaining: DisputeRemaining): string {
  if (remaining.state === "overdue") {
    return getMessage("disputes.deadlineRemainingOverdue");
  }

  if (remaining.hours === 0) {
    return formatMessage("disputes.deadlineRemainingDue", { minutes: String(remaining.minutes) });
  }

  const path = remaining.state === "due_soon" ? "disputes.deadlineRemainingDueSoon" : "disputes.deadlineRemainingOpen";

  return formatMessage(path, { hours: String(remaining.hours), minutes: String(remaining.minutes) });
}

export function DisputeDeadlineClock({
  openedAt,
  dueAt,
  windowHours,
}: {
  readonly openedAt: string;
  readonly dueAt: string;
  readonly windowHours: number;
}): ReactNode {
  const openedAtMs = Date.parse(openedAt);
  const dueAtMs = Date.parse(dueAt);
  const readable = Number.isFinite(openedAtMs) && Number.isFinite(dueAtMs);
  const [zone, setZone] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number | null>(null);

  useEffect(() => {
    const frame = window.setTimeout(() => {
      setZone(readDisputeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone));
      setNowMs(Date.now());
    }, 0);
    const tick = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearTimeout(frame);
      window.clearInterval(tick);
    };
  }, []);

  if (!readable) {
    return (
      <section aria-labelledby="dispute-deadline-heading" className={cardClasses}>
        <h2 className={headingClasses} id="dispute-deadline-heading">
          {getMessage("disputes.deadlineCardTitle")}
        </h2>
        <p className={alertClasses}>{getMessage("disputes.failed")}</p>
      </section>
    );
  }

  const local = zone === null ? null : localDeadlineOf(dueAtMs, zone);
  const shift = zone === null ? null : localOffsetShiftOf(openedAtMs, dueAtMs, zone);
  const remaining = nowMs === null ? null : disputeRemainingOf(dueAtMs, nowMs);
  const absoluteHours = Math.round((dueAtMs - openedAtMs) / 3_600_000);

  return (
    <section aria-labelledby="dispute-deadline-heading" className={cardClasses}>
      <h2 className={headingClasses} id="dispute-deadline-heading">
        {getMessage("disputes.deadlineCardTitle")}
      </h2>

      <dl className={gridClasses}>
        <dt className={termClasses}>{getMessage("disputes.deadlineLocalLabel")}</dt>
        <dd className={definitionClasses}>
          {local === null ? getMessage("disputes.deadlineNoZoneNote") : local.text}
        </dd>

        <dt className={termClasses}>{getMessage("disputes.deadlineUtcLabel")}</dt>
        <dd className={definitionClasses}>{utcTextOf(dueAtMs)}</dd>

        <dt className={termClasses}>{getMessage("disputes.deadlineZoneLabel")}</dt>
        <dd className={definitionClasses}>
          {local === null ? "UTC" : `${local.zone} (${local.offsetText})`}
        </dd>

        <dt className={termClasses}>{getMessage("disputes.windowLabel")}</dt>
        <dd className={definitionClasses}>
          {formatMessage("disputes.windowHoursText", { hours: String(windowHours) })}
        </dd>
      </dl>

      {remaining === null ? null : (
        <p className={remaining.state === "overdue" ? alertClasses : soonClasses} role="status">
          {remainingTextOf(remaining)}
        </p>
      )}

      <p className={noteClasses}>{getMessage("disputes.deadlineHelpBoth")}</p>

      {shift !== null && shift.shifted ? (
        <p className={noteClasses}>
          {formatMessage("disputes.deadlineShiftedNote", {
            localHours: String(shift.localHours),
            absoluteHours: String(absoluteHours),
          })}
        </p>
      ) : null}
    </section>
  );
}
