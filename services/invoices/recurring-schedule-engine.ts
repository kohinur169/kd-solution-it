// path: services/invoices/recurring-schedule-engine.ts
import {
  RECURRING_SCHEDULE_DATE_PATTERN,
  RECURRING_SCHEDULE_DAY_MS,
  type RecurringScheduleIntervalUnit,
} from "./recurring-schedule-fields.ts";

/**
 * The date arithmetic of a recurring schedule, with no clock and no database.
 *
 * ## Why this is a separate module from the service
 *
 * "When does this run next" is the one question of section 16 that has a wrong answer nobody notices for a
 * month. If the arithmetic lives inside the service, the only way to test it is to stand up a fixture and
 * drive a create - and then the interesting cases, the ones that only appear on the 31st, on a leap day, or
 * after a year of monthly runs, are exactly the cases a fixture is least likely to be given. So the arithmetic
 * is a pure function of `(schedule, today)` here, and the gate drives it directly over a table of dates.
 *
 * There is no clock in this file. Every function that needs "today" takes it as an argument, the same
 * discipline `lib/security/portal-token.ts` applies to its tokens and for the same reason: a module that reads
 * `Date.now()` cannot be tested against the 31st of January without the test lying to the process.
 *
 * ## Why the arithmetic is done on calendar dates, in UTC
 *
 * A `date` column is a calendar date, not an instant. Every date in this file is converted to a UTC midnight
 * and back, so adding a month to `2026-01-31` is a question about January and February and not about the
 * machine's timezone. `Date.UTC` is used rather than `Date.parse("2026-01-31")` because the latter is defined
 * to parse a bare date as UTC but reads like a local-time call, and this file has no reason to be subtle.
 */

/** A parsed calendar date: the UTC midnight of the day the text names. */
interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** The parts a fractional day count needs: whole days, and the month a date was clamped to. */
export interface RecurringDateShift {
  readonly date: string;
  /** True when a month or year step was clamped, so a caller can say so rather than show a moved date silently. */
  readonly clamped: boolean;
}

const MONTHS_PER_YEAR = 12;

/** Whether a string is a real calendar date: the pattern, and a day that exists in that month. */
export function isRecurringScheduleDate(value: unknown): value is string {
  if (typeof value !== "string" || !RECURRING_SCHEDULE_DATE_PATTERN.test(value)) {
    return false;
  }

  const day = parseDay(value);

  // `2026-02-30` matches the pattern and is not a date. The test is whether the month of that year has that
  // many days, which is the only definition that gets a leap February right.
  return day !== null && day.day <= daysInMonth(day.year, day.month);
}

/** The UTC midnights of two dates, as integers, so a difference is a subtraction and not a guess. */
function epochOf(value: string): number {
  const day = parseDay(value);

  if (day === null) {
    throw new Error(`recurring schedule: not a calendar date: ${value}`);
  }

  return Date.UTC(day.year, day.month - 1, day.day);
}

function parseDay(value: string): CalendarDay | null {
  if (!RECURRING_SCHEDULE_DATE_PATTERN.test(value)) {
    return null;
  }

  const [yearText = "", monthText = "", dayText = ""] = value.split("-");
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }

  if (month < 1 || month > MONTHS_PER_YEAR || day < 1 || day > 31) {
    return null;
  }

  return { year, month, day };
}

function formatDay(day: CalendarDay): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

/** How many days the month of a given year has, February included. */
function daysInMonth(year: number, month: number): number {
  // The zeroth day of the next month is the last day of this one, which is how the clock counts.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * One date moved by a whole number of days.
 *
 * Days are exact: there is no clamp, because every day count lands on a day that exists. This is the function
 * the due offset uses, so `terms_days` cannot produce a date the calendar does not have.
 */
export function shiftRecurringDateByDays(date: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new Error("recurring schedule: a day shift must be a whole number of days");
  }

  const moved = new Date(epochOf(date) + days * RECURRING_SCHEDULE_DAY_MS);

  return formatDay({ year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() });
}

/**
 * One date moved by one interval step of a schedule.
 *
 * ## The clamp, and why it is the only defensible answer
 *
 * A monthly schedule anchored on the 31st has no 31st to run on in February. There are three things a system
 * can do, and only one of them is honest:
 *
 *   - **skip the month** - the client is invoiced eleven times a year and nobody is told;
 *   - **roll forward into March** - February's invoice arrives on the 3rd of March, and after one year the
 *     anchor has walked from the 31st to the 3rd, because each run would anchor off the previous run;
 *   - **clamp to the last day of the month** - the 31st becomes the 28th in February and returns to the 31st
 *     in March.
 *
 * The third is what this function does, and the reason it does not drift is that a run always steps from the
 * schedule's own anchor date and not from the previous result. `nextRunOf` below is written that way, so a
 * year of clamped Februarys has no effect on March.
 *
 * The clamp is reported rather than hidden: a caller that shows the merchant the next date can say the month
 * is short, instead of presenting a date the merchant never chose as if they had.
 */
export function shiftRecurringDateByInterval(
  date: string,
  unit: RecurringScheduleIntervalUnit,
  count: number,
): RecurringDateShift {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("recurring schedule: an interval count is a whole number of at least one");
  }

  if (unit === "day") {
    return { date: shiftRecurringDateByDays(date, count), clamped: false };
  }

  if (unit === "week") {
    return { date: shiftRecurringDateByDays(date, count * 7), clamped: false };
  }

  const from = parseDay(date);

  if (from === null) {
    throw new Error(`recurring schedule: not a calendar date: ${date}`);
  }

  const months = unit === "month" ? count : count * MONTHS_PER_YEAR;
  const absolute = from.month - 1 + months;
  const year = from.year + Math.floor(absolute / MONTHS_PER_YEAR);
  const month = (absolute % MONTHS_PER_YEAR) + 1;
  const lastDay = daysInMonth(year, month);
  const day = Math.min(from.day, lastDay);

  return { date: formatDay({ year, month, day }), clamped: day !== from.day };
}

/** The whole days between two dates, signed: how far `to` is after `from`. */
export function daysBetweenRecurringDates(from: string, to: string): number {
  return Math.round((epochOf(to) - epochOf(from)) / RECURRING_SCHEDULE_DAY_MS);
}

/** One schedule's dates, as the engine needs them. A `date` column is text to this module. */
export interface RecurringDateInput {
  readonly startOn: string;
  readonly nextRunOn: string;
  readonly endOn: string | null;
  readonly lastRunOn: string | null;
  readonly intervalUnit: RecurringScheduleIntervalUnit;
  readonly intervalCount: number;
}

/**
 * The date of one grid point: the start date plus `steps` whole intervals.
 *
 * Every date a schedule will ever run on is `gridPoint(schedule, n)` for some n, which is what makes the anchor
 * rule expressible: a run happened, so find the n it happened on, and the next run is n plus one.
 */
export function gridPointOf(schedule: RecurringDateInput, steps: number): string {
  return shiftRecurringDateByInterval(schedule.startOn, schedule.intervalUnit, steps * schedule.intervalCount).date;
}

/**
 * The date a schedule runs next, given the date it last ran.
 *
 * This is the anchor rule. Every date is a whole number of intervals from `startOn`, and `lastRunOn` only says
 * which of them has already happened. Stepping from the previous *result* would accumulate a clamp - a year of
 * February 28ths would leave a monthly schedule permanently on the 28th - so the count of completed steps is
 * found first and the next date is computed from the anchor.
 *
 * When the schedule has never run, the next date is the one `0028` stores in `next_run_on`, which is the
 * merchant's own choice of first run. A schedule created today with a first run next month is a schedule that
 * starts next month, and the engine does not second-guess it.
 */
export function nextRunOf(schedule: RecurringDateInput): string {
  if (schedule.lastRunOn === null) {
    return schedule.nextRunOn;
  }

  const completed = completedStepsOf(schedule, schedule.lastRunOn);

  return gridPointOf(schedule, completed + 1);
}

/**
 * How many whole grid points the schedule has already run on.
 *
 * The answer is the largest n whose grid point is not after the last run. Days and weeks divide exactly, so
 * that is a division. Months and years do not, because a month is 28 to 31 days and a clamp moves a grid point
 * to a date that is not the same day number as the anchor - which is exactly why this cannot be a division:
 * February 28th is the *first* grid point of a monthly schedule anchored on January 31st, and a day-number
 * comparison would call it the zeroth. So the grid is walked, bounded by the ceiling below.
 */
function completedStepsOf(schedule: RecurringDateInput, lastRunOn: string): number {
  if (schedule.intervalUnit === "day" || schedule.intervalUnit === "week") {
    const elapsed = daysBetweenRecurringDates(schedule.startOn, lastRunOn);
    const perStep = schedule.intervalUnit === "day" ? schedule.intervalCount : schedule.intervalCount * 7;

    return Math.max(0, Math.floor(elapsed / perStep));
  }

  let completed = 0;

  while (completed < MAXIMUM_INTERVAL_STEPS && daysBetweenRecurringDates(gridPointOf(schedule, completed + 1), lastRunOn) >= 0) {
    completed += 1;
  }

  return completed;
}

/** A ceiling on the steps a single row may name, so a malformed row cannot make this module loop forever. */
const MAXIMUM_INTERVAL_STEPS = 4_000;

/**
 * Whether a schedule has run out, because the next run would be past its end date.
 *
 * `end_on` is optional and inclusive: a schedule that ends on the 31st of December may still run on the 31st.
 * A schedule with no end date never runs out, and one whose next run is exactly its end date still runs once
 * more - which is what a merchant writing "last invoice on the 31st" means.
 */
export function hasRecurringScheduleEnded(schedule: RecurringDateInput, nextRunOn: string): boolean {
  if (schedule.endOn === null) {
    return false;
  }

  return daysBetweenRecurringDates(schedule.endOn, nextRunOn) > 0;
}

/**
 * Whether a schedule is due on the given day.
 *
 * A schedule is due on its run date and every day after it until it runs, because a job that was not running
 * on the day - a deploy, an outage, a paused worker - must still invoice when it comes back. A schedule is
 * therefore due when its next run is *not after* today, which is the comparison the section 27 job needs; a
 * date far in the past is due rather than skipped, and `0028`'s absence of a catch-up column says the job
 * catches up by running, not by recording a gap.
 */
export function isRecurringScheduleDue(schedule: RecurringDateInput, today: string): boolean {
  return daysBetweenRecurringDates(schedule.nextRunOn, today) >= 0;
}

/**
 * The due date of one generated invoice: the run date plus the schedule's terms.
 *
 * `terms_days` is measured from the run date and not from the moment the job happened to execute, so an
 * invoice generated late - because the worker was down for two days - is still due on the date the schedule
 * promised. Otherwise a client would be given a different deadline depending on the merchant's infrastructure,
 * which is the kind of difference nobody can explain in a support conversation.
 */
export function dueDateOfRun(runOn: string, termsDays: number): string {
  return shiftRecurringDateByDays(runOn, termsDays);
}

/**
 * Whether one unpaid invoice deserves a reminder today, and which one.
 *
 * The policy is `0028`'s two columns: a reminder goes out every `reminderIntervalDays` after the invoice's due
 * date, up to `reminderLimit` of them. Zero days means the schedule sends none, and `0028`'s
 * `recurring_schedules_reminder_pair_check` makes the limit zero as well in that case, so this function has
 * one off-switch and not two.
 *
 * The interval is counted from the invoice's own due date, not from the last reminder. Counting from the last
 * reminder would let a job that ran twice in one day send two, and it would silently reset the cadence every
 * time a send failed half way. Counting from the due date makes the n-th reminder always fall on the same day
 * for a given invoice, which is what "at set intervals" means to a client.
 */
export function reminderOfInvoice(input: {
  readonly dueOn: string;
  readonly today: string;
  readonly sentCount: number;
  readonly reminderIntervalDays: number;
  readonly reminderLimit: number;
}): number | null {
  if (input.reminderIntervalDays <= 0 || input.reminderLimit <= 0) {
    return null;
  }

  const overdueBy = daysBetweenRecurringDates(input.dueOn, input.today);

  // Before the due date there is nothing to remind about: the invoice is not late, it is simply new. On the
  // due date itself the invoice is still not late, so the first reminder is the day after.
  if (overdueBy < 1) {
    return null;
  }

  const ordinal = Math.ceil(overdueBy / input.reminderIntervalDays);

  if (ordinal > input.reminderLimit || ordinal <= input.sentCount) {
    return null;
  }

  return ordinal;
}
