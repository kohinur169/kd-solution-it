// path: services/disputes/dispute-deadline.ts
import {
  DISPUTE_DEFAULT_WINDOW_HOURS,
  DISPUTE_DUE_SOON_HOURS,
  DISPUTE_WARNING_STAGES,
  DISPUTE_WINDOW_HOURS,
  disputeDueAt,
  type DisputeWarningStage,
} from "./dispute-fields.ts";

/**
 * Section 19's deadline, in the merchant's own time zone.
 *
 * ## What "24 hours in the merchant own time zone" can mean, and which one this is
 *
 * A window can be counted two ways. *Absolute*: twenty-four hours after the instant the processor reported
 * the dispute, whatever the wall clock then says. *Local*: the same reading of the clock on the next day,
 * which is twenty-three or twenty-five real hours when the clocks change. The two agree except on the two
 * days a year a zone shifts.
 *
 * This platform counts **absolute** hours, and `0039_disputes.sql` is why it has to: `disputes_due_check`
 * refuses a deadline later than `opened_at + response_window_hours`, so a 24-hour window that a spring-forward
 * day stretched to twenty-five absolute hours could not be stored at all. Absolute hours are also the rule
 * that favours the merchant: a window that shrinks to twenty-three hours would be a deadline moved earlier
 * without anybody deciding to move it.
 *
 * So the zone is not a way of counting. It is a way of *saying* - and a way of being honest when the clock
 * moves underneath the window. {@link localDeadlineOf} prints the deadline in a named zone, and
 * {@link localOffsetShiftOf} answers whether that zone changed its offset between the opening and the
 * deadline, which is what a screen needs to warn about rather than silently show a shorter-looking day.
 *
 * ## Why this module imports nothing but its own fields
 *
 * It runs in two places: the merchant's browser, where the zone is the device's own (the truest answer to
 * "the merchant's own time zone" there is, because nobody had to guess or store it), and the server, where
 * the same functions are used by the gate to prove the arithmetic against fixed zones. So it imports no
 * REST client, no audit trail and no React - only the window constants that are already the schema's.
 *
 * ## The one thing that is not decoration
 *
 * {@link disputeRemainingOf} is what both the screen and the service reason with: `overdue` is the only
 * state in which a save is refused, and it is decided from two instants, never from a rendered string. A
 * form that trusted the clock it printed would accept a response a minute after the deadline because the
 * tab had been open for an hour.
 */

/** A named IANA zone, with the fallback the platform uses when it has none. */
export const DISPUTE_FALLBACK_TIME_ZONE = "UTC";

/** The longest zone name this platform accepts, so a hostile string cannot be formatted. */
const timeZonePattern = /^[A-Za-z][A-Za-z0-9_+-]{0,39}(\/[A-Za-z0-9_+-]{1,40}){0,2}$/u;

/**
 * True when a string is a zone `Intl` can actually format with.
 *
 * The pattern narrows the input before `Intl` sees it - a formatter constructed with an enormous or
 * malformed zone is a slow path on some runtimes - and the formatter is then the authority: a name that
 * looks right and is not a zone (`Mars/Olympus`) is refused here rather than thrown later inside a render.
 */
export function isDisputeTimeZone(candidate: string): boolean {
  if (!timeZonePattern.test(candidate)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });

    return true;
  } catch {
    return false;
  }
}

/** The zone a screen should print in: the one it was given when it is real, and UTC otherwise. */
export function readDisputeTimeZone(candidate: string | null | undefined): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    return DISPUTE_FALLBACK_TIME_ZONE;
  }

  return isDisputeTimeZone(candidate) ? candidate : DISPUTE_FALLBACK_TIME_ZONE;
}

/** One deadline: the instant, the window it came from, and the zone it will be printed in. */
export interface DisputeDeadline {
  readonly openedAtEpochMs: number;
  readonly windowHours: number;
  readonly dueAtEpochMs: number;
  readonly zone: string;
}

/**
 * The deadline of a dispute opened at one instant, in one zone.
 *
 * The arithmetic is `disputeDueAt` - the same function the webhook used when it wrote `response_due_at` - so a
 * screen and the row cannot disagree about when the window closes.
 */
export function disputeDeadlineOf(
  openedAtEpochMs: number,
  windowHours: number,
  zone: string | null | undefined,
): DisputeDeadline {
  const hours = (DISPUTE_WINDOW_HOURS as readonly number[]).includes(windowHours)
    ? windowHours
    : DISPUTE_DEFAULT_WINDOW_HOURS;

  return {
    openedAtEpochMs,
    windowHours: hours,
    dueAtEpochMs: disputeDueAt(openedAtEpochMs, hours),
    zone: readDisputeTimeZone(zone),
  };
}

/**
 * The middle of a window: half its hours after the opening.
 *
 * Twelve hours into a twenty-four hour window, twenty-four into a forty-eight hour one, and it matters that
 * this is *absolute* for the same reason the deadline is: `0125`'s check compares the midpoint against
 * `opened_at + make_interval(hours => window_hours / 2)`, so a zone can never move it either. Half of the only
 * two windows the schema allows are whole hours, so there is no rounding question to answer.
 */
export function disputeMidpointOf(openedAtEpochMs: number, windowHours: number): number {
  const hours = (DISPUTE_WINDOW_HOURS as readonly number[]).includes(windowHours)
    ? windowHours
    : DISPUTE_DEFAULT_WINDOW_HOURS;

  return openedAtEpochMs + Math.trunc(hours / 2) * 3_600_000;
}

/** What a screen and a sweep both need to know about one dispute before they can name a stage. */
export interface DisputeWarningFacts {
  readonly openedAtEpochMs: number;
  readonly dueAtEpochMs: number;
  readonly windowHours: number;
  readonly resolved: boolean;
  readonly submitted: boolean;
  /** The merchant has already written their side, so a nudge would be a nudge about nothing. */
  readonly answered: boolean;
}

/**
 * Which of section 19's warnings are due at one instant, and why the others are not.
 *
 * ## The rule, in one sentence
 *
 * A stage is due when its instant has arrived and the deadline has not passed - `warnAt <= now < dueAt` - and
 * it is not due at all once the merchant has answered, the pack has been sent, or the dispute has been
 * decided, because a warning exists to produce an answer that is not there yet.
 *
 * ## Why the empty array is the interesting answer
 *
 * The sweep runs on a clock, so most disputes most of the time are between two stages and owe nothing. The
 * function therefore returns the stages that are due and never throws, and the caller counts the ones it did
 * not send instead of inventing a reason for each.
 *
 * ## Why a missed stage is not sent late
 *
 * A tick that runs after the deadline closes a window with nothing to say: "you had until yesterday" is not a
 * warning, it is a reproach, and the merchant can no longer act on it. So the deadline is an upper bound on
 * both stages, and a sweep that was down for a day resumes at the next dispute rather than apologising to
 * every merchant it missed.
 */
export function disputeWarningStagesOf(facts: DisputeWarningFacts, nowMs: number): readonly DisputeWarningStage[] {
  if (facts.resolved || facts.submitted || facts.answered) {
    return [];
  }

  if (!(nowMs >= facts.openedAtEpochMs && nowMs < facts.dueAtEpochMs)) {
    return [];
  }

  const due: DisputeWarningStage[] = [];

  for (const stage of DISPUTE_WARNING_STAGES) {
    const warnAt = stage === "start" ? facts.openedAtEpochMs : disputeMidpointOf(facts.openedAtEpochMs, facts.windowHours);

    if (nowMs >= warnAt) {
      due.push(stage);
    }
  }

  return due;
}

/**
 * The offset of a zone at one instant, in minutes east of UTC.
 *
 * `Intl` will not answer this directly, so the parts of the instant in that zone are read, reassembled as if
 * they were UTC, and subtracted. The difference is the offset, including a half-hour zone and including a
 * day on which the offset changed.
 */
export function localOffsetMinutesOf(zone: string, epochMs: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: readDisputeTimeZone(zone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);

    return part === undefined ? 0 : Number(part.value);
  };
  const asIfUtc = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"));

  return Math.round((asIfUtc - epochMs) / 60_000);
}

/** An offset in minutes as `UTC`, `UTC+06:00` or `UTC-03:30`. */
export function offsetTextOf(minutes: number): string {
  if (minutes === 0) {
    return "UTC";
  }

  const sign = minutes > 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = String(Math.trunc(absolute / 60)).padStart(2, "0");
  const rest = String(absolute % 60).padStart(2, "0");

  return `UTC${sign}${hours}:${rest}`;
}

/** The deadline printed in one zone: the words a screen shows, and the numbers behind them. */
export interface LocalDeadline {
  /** `8 Nov 2026, 21:30 GMT+6` — the whole answer in one string, in the zone the merchant reads in. */
  readonly text: string;
  /** The calendar day alone, `8 Nov 2026`. */
  readonly dateText: string;
  /** The clock alone, `21:30`. */
  readonly timeText: string;
  /** The zone abbreviation the runtime prints (`GMT+6`, `EST`), or the zone name when it prints none. */
  readonly zoneName: string;
  readonly zone: string;
  /** Minutes east of UTC at the deadline instant. */
  readonly offsetMinutes: number;
  /** `UTC+06:00`. */
  readonly offsetText: string;
}

/**
 * Print one deadline in one zone.
 *
 * `en-GB` is the locale the platform's dates use everywhere else (`8 Nov 2026`), and `timeZoneName: "short"`
 * is what makes the string say which clock it is on - a deadline printed as `21:30` with no zone is the
 * ambiguity section 19 is about.
 */
export function localDeadlineOf(dueAtEpochMs: number, zone: string | null | undefined, locale = "en-GB"): LocalDeadline {
  const resolved = readDisputeTimeZone(zone);
  const date = new Date(dueAtEpochMs);
  const dateText = new Intl.DateTimeFormat(locale, {
    timeZone: resolved,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
  const timeParts = new Intl.DateTimeFormat(locale, {
    timeZone: resolved,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const timeText = timeParts
    .filter((part) => part.type === "hour" || part.type === "minute" || part.type === "literal")
    .map((part) => part.value)
    .join("")
    .trim();
  const zonePart = timeParts.find((part) => part.type === "timeZoneName");
  const zoneName = zonePart?.value ?? resolved;
  const offsetMinutes = localOffsetMinutesOf(resolved, dueAtEpochMs);

  return {
    text: `${dateText}, ${timeText}`,
    dateText,
    timeText,
    zoneName,
    zone: resolved,
    offsetMinutes,
    offsetText: offsetTextOf(offsetMinutes),
  };
}

/** The three states a window can be in, and the one word a screen prints for each. */
export const DISPUTE_REMAINING_STATES = Object.freeze(["open", "due_soon", "overdue"] as const);

export type DisputeRemainingState = (typeof DISPUTE_REMAINING_STATES)[number];

/** How much of the window is left, in the state's own terms. */
export interface DisputeRemaining {
  readonly state: DisputeRemainingState;
  /** Milliseconds to the deadline, negative once it has passed. */
  readonly milliseconds: number;
  readonly hours: number;
  readonly minutes: number;
}

/**
 * How much of the window is left.
 *
 * `due_soon` is the last {@link DISPUTE_DUE_SOON_HOURS} of the window - the same rule the list's badge uses,
 * so the countdown and the badge cannot disagree. None of the three states decides whether a save is
 * accepted: only the closed window does that, and only the service decides it, from the same two instants.
 */
export function disputeRemainingOf(dueAtEpochMs: number, nowMs: number): DisputeRemaining {
  const milliseconds = dueAtEpochMs - nowMs;
  const absolute = Math.abs(milliseconds);
  const hours = Math.trunc(absolute / 3_600_000);
  const minutes = Math.trunc((absolute % 3_600_000) / 60_000);

  if (milliseconds <= 0) {
    return { state: "overdue", milliseconds, hours: 0, minutes: 0 };
  }

  const soonMs = DISPUTE_DUE_SOON_HOURS * 3_600_000;

  return {
    state: milliseconds <= soonMs ? "due_soon" : "open",
    milliseconds,
    hours,
    minutes,
  };
}

/** Whether the clock moved under the window, and by how much the local reading differs from the absolute one. */
export interface LocalOffsetShift {
  /** True when the zone's offset at the deadline differs from its offset at the opening. */
  readonly shifted: boolean;
  readonly openedOffsetMinutes: number;
  readonly dueOffsetMinutes: number;
  /**
   * How many hours the merchant's wall clock *reads* across the window: 25 when the clock jumped forward inside
   * it, 23 when it fell back, 24 when it did not move. It is not the time the merchant has - that is always the
   * absolute window - it is the span the dial shows, which is what makes a deadline printed as "21:30" look an
   * hour early to somebody counting on their fingers.
   */
  readonly localHours: number;
}

/**
 * Whether the merchant's zone changed its offset inside the window.
 *
 * A window that crosses a spring-forward reads twenty-five hours on the dial; one crossing a fall-back reads
 * twenty-three. The platform keeps the absolute twenty-four in both cases - the deadline instant does not move -
 * and this function exists so the screen can say so instead of leaving a merchant to notice that the clock on
 * the deadline does not read the same as the clock on the report.
 */
export function localOffsetShiftOf(
  openedAtEpochMs: number,
  dueAtEpochMs: number,
  zone: string | null | undefined,
): LocalOffsetShift {
  const resolved = readDisputeTimeZone(zone);
  const openedOffsetMinutes = localOffsetMinutesOf(resolved, openedAtEpochMs);
  const dueOffsetMinutes = localOffsetMinutesOf(resolved, dueAtEpochMs);
  const absoluteHours = (dueAtEpochMs - openedAtEpochMs) / 3_600_000;

  return {
    shifted: openedOffsetMinutes !== dueOffsetMinutes,
    openedOffsetMinutes,
    dueOffsetMinutes,
    localHours: Math.round(absoluteHours + (dueOffsetMinutes - openedOffsetMinutes) / 60),
  };
}
