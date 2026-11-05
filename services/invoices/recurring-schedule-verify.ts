// path: services/invoices/recurring-schedule-verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import {
  RECURRING_SCHEDULE_COUNT_LIMITS,
  RECURRING_SCHEDULE_CREATED_STATUS,
  RECURRING_SCHEDULE_DATE_PATTERN,
  RECURRING_SCHEDULE_DAY_MS,
  RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS,
  RECURRING_SCHEDULE_DEFAULT_UNIT,
  RECURRING_SCHEDULE_INTERVAL_UNITS,
  RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS,
  RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS,
  RECURRING_SCHEDULE_RULES,
  RECURRING_SCHEDULE_STATUSES,
  RECURRING_SCHEDULE_TERMS_LIMITS,
  isRecurringScheduleIntervalUnit,
  isRecurringScheduleStatus,
  type RecurringScheduleIntervalUnit,
} from "./recurring-schedule-fields.ts";
import {
  daysBetweenRecurringDates,
  dueDateOfRun,
  hasRecurringScheduleEnded,
  isRecurringScheduleDate,
  isRecurringScheduleDue,
  gridPointOf,
  nextRunOf,
  reminderOfInvoice,
  shiftRecurringDateByDays,
  shiftRecurringDateByInterval,
  type RecurringDateInput,
} from "./recurring-schedule-engine.ts";

/**
 * The gate for STEP 122 part 1: the schedule's vocabulary and its date arithmetic.
 *
 * ## What this part proves, and what it deliberately does not
 *
 * Part 1 is the two files a schedule's correctness depends on before any row exists: the words `0028` allows
 * and the arithmetic that decides when a run happens. There is no service, no route and no screen yet, so there
 * is nothing to drive through a fixture - which is precisely why the arithmetic is a pure function. The gate
 * therefore drives it directly, over a table of dates chosen for the cases that break recurring billing:
 * the 31st of a month, a leap day, a year of clamped Februarys, an expiry that falls on the due date, and a
 * worker that was down for a week.
 *
 * ## The bounds are read from `0028`, not restated
 *
 * Every limit in `recurring-schedule-fields.ts` exists a second time in `0028_recurring_schedules.sql` as a
 * named constraint. That duplication is the risk this gate is built around: a bound that drifted between the
 * SQL and the TypeScript would be invisible until a merchant typed the one value that sits in the gap. So the
 * migration text is parsed and each constant is compared against the number the constraint actually declares.
 * The same method `services/estimates/verify.ts` uses for `0025`.
 */

/* ---- the harness ---- */

const repositoryRoot = new URL("../../", import.meta.url);
const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

/**
 * Run one group so a throw inside it is a recorded failure rather than the end of the gate.
 *
 * An engine that throws where it should answer would otherwise take the process down, and every failure
 * recorded before the throw would be lost - the report would be a Node stack trace, which reads like a broken
 * gate rather than a broken engine.
 */
async function group(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    checks += 1;
    failures.push(
      `${name} threw instead of recording a failure: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/* ---- `0028`, read as text ---- */

/** The number inside a named constraint's `between A and B`, or null when the constraint is not written that way. */
function betweenOf(migration: string, constraint: string): { readonly min: number; readonly max: number } | null {
  const pattern = new RegExp(
    `${constraint}\\s+check\\s*\\(\\s*([a-z_]+)\\s+between\\s+(\\d+)\\s+and\\s+(\\d+)\\s*\\)`,
    "u",
  );
  const match = pattern.exec(migration);

  if (match === null) {
    return null;
  }

  return { min: Number.parseInt(match[2] ?? "", 10), max: Number.parseInt(match[3] ?? "", 10) };
}

async function checkMigrationBounds(): Promise<void> {
  const migration = await readRepositoryFile("migrations/0028_recurring_schedules.sql");

  expectEqual(betweenOf(migration, "recurring_schedules_count_check")?.min, RECURRING_SCHEDULE_COUNT_LIMITS.min,
    "`0028`'s interval count minimum is the one this module refuses below");
  expectEqual(betweenOf(migration, "recurring_schedules_count_check")?.max, RECURRING_SCHEDULE_COUNT_LIMITS.max,
    "and so is its maximum");
  expectEqual(betweenOf(migration, "recurring_schedules_terms_check")?.min, RECURRING_SCHEDULE_TERMS_LIMITS.min,
    "the due offset minimum is the same number in both places");
  expectEqual(betweenOf(migration, "recurring_schedules_terms_check")?.max, RECURRING_SCHEDULE_TERMS_LIMITS.max,
    "and so is its maximum");
  expectEqual(
    betweenOf(migration, "recurring_schedules_reminder_interval_check")?.min,
    RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS.min,
    "the reminder interval minimum is the same number in both places",
  );
  expectEqual(
    betweenOf(migration, "recurring_schedules_reminder_interval_check")?.max,
    RECURRING_SCHEDULE_REMINDER_INTERVAL_LIMITS.max,
    "and so is its maximum",
  );
  expectEqual(
    betweenOf(migration, "recurring_schedules_reminder_limit_check")?.min,
    RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS.min,
    "the reminder limit minimum is the same number in both places",
  );
  expectEqual(
    betweenOf(migration, "recurring_schedules_reminder_limit_check")?.max,
    RECURRING_SCHEDULE_REMINDER_LIMIT_LIMITS.max,
    "and so is its maximum",
  );

  // The vocabularies, read out of the SQL rather than assumed.
  expect(
    migration.includes("status in ('active', 'paused', 'ended')"),
    "`0028` states the three statuses this module names",
  );
  expect(
    migration.includes("interval_unit in ('day', 'week', 'month', 'year')"),
    "and the four interval units",
  );
  expectEqual(RECURRING_SCHEDULE_STATUSES.length, 3, "three statuses, as the check lists them");
  expectEqual(RECURRING_SCHEDULE_INTERVAL_UNITS.length, 4, "four interval units, as the check lists them");

  // The defaults this module adopts have to be the ones the column actually declares, or a create would write
  // a value the SQL then overwrites - two answers to one question.
  expect(/interval_unit text not null default 'month'/u.test(migration), "`0028` defaults the unit to a month");
  expectEqual(RECURRING_SCHEDULE_DEFAULT_UNIT, "month", "and this module adopts that default rather than inventing one");
  expect(/terms_days integer not null default 30/u.test(migration), "`0028` defaults the due offset to 30 days");
  expectEqual(RECURRING_SCHEDULE_DEFAULT_TERMS_DAYS, 30, "and this module adopts that number");
  expect(/status text not null default 'active'/u.test(migration), "`0028` defaults a new schedule to active");
  expectEqual(RECURRING_SCHEDULE_CREATED_STATUS, "active", "which is the status a create writes");

  // The reminder pair: zero days means no reminders, and one off-switch rather than two.
  expect(
    migration.includes("(reminder_interval_days = 0) = (reminder_limit = 0)"),
    "`0028` couples the reminder policy's two columns, which is why the engine reads one off-switch",
  );

  // The arithmetic this part cannot change: the column types and the checks that constrain the dates.
  expect(migration.includes("start_on date not null"), "`start_on` is a calendar date, not an instant");
  expect(migration.includes("next_run_on date not null"), "and so is `next_run_on`");
  expect(migration.includes("end_on date"), "and so is the optional end");
  expect(migration.includes("last_run_on date"), "and the last run");
  expect(
    migration.includes("recurring_schedules_next_run_check check (next_run_on >= start_on)"),
    "`0028` forbids a next run before the start, which the engine never produces",
  );
  expect(
    migration.includes("recurring_schedules_end_check check (end_on is null or end_on >= start_on)"),
    "and an end before the start",
  );
  expect(
    migration.includes("recurring_schedules_last_reminder_check check (\n    last_reminder_on is null or (last_run_on is not null and last_reminder_on >= last_run_on)\n  )"),
    "and a reminder that predates the run it belongs to",
  );

  // The unique index that makes one template one schedule, which part 2's create will lean on.
  expect(
    migration.includes("create unique index recurring_schedules_template_key"),
    "one live schedule per template, enforced by the database rather than by a read",
  );
  expect(
    migration.includes("where deleted_at is null"),
    "as a partial index, so a deleted schedule does not block a replacement",
  );
  expect(
    migration.includes("create index recurring_schedules_run_idx") &&
      migration.includes("where status = 'active' and deleted_at is null"),
    "and the job's own index covers exactly the rows a run considers",
  );
}

/* ---- the vocabulary ---- */

async function checkVocabulary(): Promise<void> {
  const fields = await readRepositoryFile("services/invoices/recurring-schedule-fields.ts");
  const code = fields.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expect(
    fields.startsWith("// path: services/invoices/recurring-schedule-fields.ts\n"),
    "the vocabulary starts with its path",
  );

  // A browser file may import this module, so it carries no behaviour and no client.
  expect(!/^import /mu.test(code), "the vocabulary imports nothing, so a browser file may use it");
  expect(!/\basync\b/u.test(code) && !/\bawait\b/u.test(code), "and holds nothing asynchronous");
  expect(!/\bthrow\b/u.test(code), "and throws nothing");
  expect(!/RestClient|AuditTrail|Date\.now/u.test(code), "and names no database client and reads no clock");

  // Rule 2 has nothing to bite on here (no money), but a float would still be a defect in a bound.
  expect(!/parseFloat/u.test(code), "no bound is parsed as a float");

  const rules = [...RECURRING_SCHEDULE_RULES];
  expectEqual(new Set(rules).size, rules.length, "no schedule rule is listed twice");
  expect(
    rules.every((rule) => /^[a-z][a-z0-9_]*$/u.test(rule)),
    "every rule is a lower snake word a catalogue key can be built from",
  );

  expect(isRecurringScheduleStatus("active"), "a real status is recognised");
  expect(!isRecurringScheduleStatus("Active"), "and the wrong case is not");
  expect(isRecurringScheduleIntervalUnit("month"), "a real unit is recognised");
  expect(!isRecurringScheduleIntervalUnit("quarter"), "and a unit `0028` does not allow is not");

  // The date pattern is anchored and ASCII, so `2026-1-5` and a trailing newline are both refused.
  expect(RECURRING_SCHEDULE_DATE_PATTERN.test("2026-11-05"), "a padded date matches the pattern");
  expect(!RECURRING_SCHEDULE_DATE_PATTERN.test("2026-1-5"), "an unpadded one does not");
  expect(!RECURRING_SCHEDULE_DATE_PATTERN.test("2026-11-05\n"), "and neither does one with a trailing newline");
  expectEqual(RECURRING_SCHEDULE_DAY_MS, 86_400_000, "a day is a fixed number of milliseconds, because the dates are calendar dates");
}

/* ---- the engine's sources ---- */

async function checkEngineSource(): Promise<void> {
  const engine = await readRepositoryFile("services/invoices/recurring-schedule-engine.ts");
  const code = engine.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/.*/gu, "");

  expect(engine.startsWith("// path: services/invoices/recurring-schedule-engine.ts\n"), "the engine starts with its path");

  // The one discipline that makes the engine testable: it has no clock of its own.
  expect(!/Date\.now\(\)/u.test(code), "the engine never reads the clock, so a date can be tested without lying to the process");
  expect(!/new Date\(\)/u.test(code), "and never constructs one from now");
  expect(!/\basync\b/u.test(code) && !/\bawait\b/u.test(code), "and does nothing asynchronous");
  expect(!/RestClient|fetch\(/u.test(code), "and touches no network or database");

  // A date is parsed as UTC midnight, never with `Date.parse`, whose bare-date behaviour is a trap.
  expect(code.includes("Date.UTC("), "dates are built as UTC midnights");
  expect(!/Date\.parse/u.test(code), "and never through `Date.parse`, whose bare-date reading depends on the caller's expectations");

  // The anchor rule: `nextRunOf` steps from the start date, not from the previous run.
  const nextRun = code.slice(code.indexOf("export function nextRunOf"), code.indexOf("function completedStepsOf"));
  expect(
    nextRun.includes("gridPointOf(schedule, completed + 1)"),
    "the next run is the next grid point from the schedule's own start date, not a step from the previous result",
  );
  expect(
    gridPointOf(scheduleOf(), 1) === shiftRecurringDateByInterval("2026-01-31", "month", 1).date,
    "and a grid point is the anchor moved by whole intervals, which is what makes a clamp forgettable",
  );

  // No float reaches a date: the day arithmetic is integer milliseconds.
  expect(!/Math\.round\(.*\/\s*1000/u.test(code), "the day arithmetic stays in whole days");
}

/* ---- the calendar table ---- */

/** One expectation about a shift, kept as data so the table reads as the rule it proves. */
interface ShiftCase {
  readonly from: string;
  readonly unit: RecurringScheduleIntervalUnit;
  readonly count: number;
  readonly to: string;
  readonly clamped: boolean;
  readonly why: string;
}

/**
 * The cases that break recurring billing.
 *
 * Each is a date a merchant will actually have, not a synthetic edge: month ends, leap days and February are
 * what a real calendar hands a monthly retainer several times a year.
 */
const SHIFT_CASES: readonly ShiftCase[] = Object.freeze([
  { from: "2026-01-15", unit: "month", count: 1, to: "2026-02-15", clamped: false, why: "an ordinary monthly step" },
  { from: "2026-01-31", unit: "month", count: 1, to: "2026-02-28", clamped: true, why: "January's 31st has no February" },
  { from: "2026-02-28", unit: "month", count: 1, to: "2026-03-28", clamped: false, why: "and February steps back to the 28th" },
  { from: "2026-01-31", unit: "month", count: 2, to: "2026-03-31", clamped: false, why: "two steps reach a month that has a 31st" },
  { from: "2024-01-31", unit: "month", count: 1, to: "2024-02-29", clamped: true, why: "a leap year February has a 29th" },
  { from: "2024-02-29", unit: "year", count: 1, to: "2025-02-28", clamped: true, why: "a leap day has no anniversary in a common year" },
  { from: "2024-02-29", unit: "year", count: 4, to: "2028-02-29", clamped: false, why: "and four years later it does again" },
  { from: "2026-11-05", unit: "day", count: 1, to: "2026-11-06", clamped: false, why: "a daily step" },
  { from: "2026-11-05", unit: "week", count: 2, to: "2026-11-19", clamped: false, why: "two weeks" },
  { from: "2026-12-31", unit: "month", count: 1, to: "2027-01-31", clamped: false, why: "December into the next year keeps the day" },
  { from: "2026-01-15", unit: "year", count: 1, to: "2027-01-15", clamped: false, why: "an annual step" },
]);

async function checkCalendar(): Promise<void> {
  for (const item of SHIFT_CASES) {
    const shifted = shiftRecurringDateByInterval(item.from, item.unit, item.count);

    expectEqual(shifted.date, item.to, `${item.why}: ${item.from} + ${String(item.count)} ${item.unit}`);
    expectEqual(shifted.clamped, item.clamped, `and the clamp is reported for ${item.from} + ${String(item.count)} ${item.unit}`);
  }

  // A real date, and a string that only looks like one.
  for (const value of ["2026-11-05", "2024-02-29", "2026-12-31"] as const) {
    expect(isRecurringScheduleDate(value), `${value} is a calendar date`);
  }

  for (const value of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-1-5", "not-a-date", "2026-11-05T00:00:00Z"] as const) {
    expect(!isRecurringScheduleDate(value), `${value} is not a calendar date`);
  }

  // Days are exact in both directions, and a negative shift is a date before the one given.
  expectEqual(shiftRecurringDateByDays("2026-03-01", -1), "2026-02-28", "a day back from March crosses February");
  expectEqual(shiftRecurringDateByDays("2024-03-01", -1), "2024-02-29", "and a day back from March in a leap year crosses the 29th");
  expectEqual(shiftRecurringDateByDays("2026-12-31", 1), "2027-01-01", "and a day forward from the year ends it");
  expectEqual(shiftRecurringDateByDays("2026-11-05", 30), "2026-12-05", "thirty days is a month in November");

  // The difference of two dates is a signed count of whole days.
  expectEqual(daysBetweenRecurringDates("2026-11-05", "2026-11-06"), 1, "one day apart is one day");
  expectEqual(daysBetweenRecurringDates("2026-11-06", "2026-11-05"), -1, "and the other way is minus one");
  expectEqual(daysBetweenRecurringDates("2026-11-05", "2026-11-05"), 0, "the same day is no days");
  expectEqual(daysBetweenRecurringDates("2024-02-28", "2024-03-01"), 2, "a leap February has 29 days");

  // The due offset: measured from the run, and exact.
  expectEqual(dueDateOfRun("2026-11-05", 30), "2026-12-05", "net-30 from a run date");
  expectEqual(dueDateOfRun("2026-11-05", 0), "2026-11-05", "and a zero-term invoice is due on the day it runs");
  expectEqual(dueDateOfRun("2027-01-31", 30), "2027-03-02", "thirty days is exact even when it crosses a short month");
}

/* ---- the anchor rule ---- */

function scheduleOf(overrides: Partial<RecurringDateInput> = {}): RecurringDateInput {
  return {
    startOn: "2026-01-31",
    nextRunOn: "2026-01-31",
    endOn: null,
    lastRunOn: null,
    intervalUnit: "month",
    intervalCount: 1,
    ...overrides,
  };
}

async function checkAnchor(): Promise<void> {
  // A schedule that has never run runs on the date it was configured with.
  expectEqual(nextRunOf(scheduleOf()), "2026-01-31", "a schedule that has never run keeps its first run date");

  // **The case this whole module exists for.** A monthly schedule anchored on the 31st runs on the 28th of
  // February, and the month after that is the 31st of March - not the 28th. Stepping from the previous result
  // would leave the schedule permanently on the 28th, which is a different contract from the one the merchant
  // signed, and no screen would ever show it changing.
  const afterJanuary = nextRunOf(scheduleOf({ lastRunOn: "2026-01-31" }));
  expectEqual(afterJanuary, "2026-02-28", "the 31st of January runs on the 28th of February");

  const afterFebruary = nextRunOf(scheduleOf({ lastRunOn: "2026-02-28" }));
  expectEqual(afterFebruary, "2026-03-31", "and the month after that returns to the 31st, because the anchor never moved");

  // The same rule a year later: a year of clamped Februaries leaves no trace.
  const afterAYear = nextRunOf(scheduleOf({ lastRunOn: "2027-01-31" }));
  expectEqual(afterAYear, "2027-02-28", "a year of monthly runs still clamps February and no more");

  // A leap day anchored schedule runs on the 28th and then on the 29th again four years later.
  const leapStart = scheduleOf({ startOn: "2024-02-29", nextRunOn: "2024-02-29", intervalUnit: "year" });
  expectEqual(nextRunOf(leapStart), "2024-02-29", "an annual schedule starting on a leap day runs that day");
  expectEqual(
    nextRunOf({ ...leapStart, lastRunOn: "2024-02-29" }),
    "2025-02-28",
    "the next year has no 29th, so it clamps",
  );
  expectEqual(
    nextRunOf({ ...leapStart, lastRunOn: "2028-02-29" }),
    "2029-02-28",
    "and after a leap year it clamps again rather than drifting",
  );

  // A weekly schedule is exact, so there is nothing to clamp.
  const weekly = scheduleOf({ startOn: "2026-01-05", nextRunOn: "2026-01-05", intervalUnit: "week", intervalCount: 2 });
  expectEqual(nextRunOf({ ...weekly, lastRunOn: "2026-01-05" }), "2026-01-19", "every two weeks from the 5th");
  expectEqual(nextRunOf({ ...weekly, lastRunOn: "2026-01-19" }), "2026-02-02", "and the step after that");

  // A daily schedule with a count is a number of days, not a number of runs.
  const everyTenDays = scheduleOf({
    startOn: "2026-11-05",
    nextRunOn: "2026-11-05",
    intervalUnit: "day",
    intervalCount: 10,
  });
  expectEqual(nextRunOf({ ...everyTenDays, lastRunOn: "2026-11-05" }), "2026-11-15", "every ten days");

  // A count greater than one multiplies the step rather than repeating it.
  const quarterly = scheduleOf({ startOn: "2026-01-31", nextRunOn: "2026-01-31", intervalUnit: "month", intervalCount: 3 });
  expectEqual(nextRunOf({ ...quarterly, lastRunOn: "2026-01-31" }), "2026-04-30", "a quarter from the 31st of January clamps April");

  // Two runs later is still on the anchor's grid, not a chain of clamped steps.
  expectEqual(nextRunOf({ ...quarterly, lastRunOn: "2026-04-30" }), "2026-07-31", "and the quarter after returns to the 31st");
}

/* ---- due, ended, and reminders ---- */

async function checkDueAndEnded(): Promise<void> {
  const monthly = scheduleOf({ nextRunOn: "2026-11-05" });

  expect(isRecurringScheduleDue(monthly, "2026-11-05"), "a schedule is due on its run date");
  expect(isRecurringScheduleDue(monthly, "2026-11-06"), "and on every day after it, because a job that missed a day still owes an invoice");
  expect(isRecurringScheduleDue(monthly, "2027-01-01"), "however late it is");
  expect(!isRecurringScheduleDue(monthly, "2026-11-04"), "but not the day before");

  // The end date is inclusive: a schedule that ends on the 31st may still run on the 31st.
  const ending = scheduleOf({ endOn: "2026-12-31" });
  expect(!hasRecurringScheduleEnded(ending, "2026-12-31"), "a run on the end date still happens");
  expect(hasRecurringScheduleEnded(ending, "2027-01-01"), "and one after it does not");
  expect(!hasRecurringScheduleEnded(scheduleOf(), "2099-01-01"), "a schedule with no end date never runs out");

  // Reminders: the first is the day after the due date, not on it.
  const reminder = { dueOn: "2026-11-05", sentCount: 0, reminderIntervalDays: 7, reminderLimit: 3 };

  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-05" }), null, "an invoice is not late on the day it is due");
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-06" }), 1, "the first reminder is the day after");
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-12" }), 1, "and it does not repeat inside its interval");
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-13" }), 2, "the second falls seven days later");
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-20" }), 3, "and the third after the limit's last interval");

  // The limit is respected, and a reminder already sent is not sent twice.
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-27" }), null, "a fourth reminder is never sent");
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-13", sentCount: 2 }), null, "and one already sent is not repeated");

  // Zero days means the schedule sends none, which is `0028`'s own off-switch.
  expectEqual(
    reminderOfInvoice({ ...reminder, reminderIntervalDays: 0, reminderLimit: 0, today: "2026-12-01" }),
    null,
    "a schedule with reminders off sends none, however overdue the invoice is",
  );

  // The cadence is counted from the due date, so a job that ran twice in one day cannot send twice.
  expectEqual(
    reminderOfInvoice({ ...reminder, today: "2026-11-06", sentCount: 1 }),
    null,
    "the same day's second execution finds the reminder already counted",
  );

  // A reminder date that is not on the interval's grid still reports the interval it falls in, so a job that
  // was down for two days sends one reminder rather than none.
  expectEqual(reminderOfInvoice({ ...reminder, today: "2026-11-15" }), 2, "a late job sends the interval it is in");
}

/* ---- the run ---- */

async function run(): Promise<void> {
  await group("migration bounds", checkMigrationBounds);
  await group("vocabulary", checkVocabulary);
  await group("engine source", checkEngineSource);
  await group("calendar", checkCalendar);
  await group("anchor", checkAnchor);
  await group("due, ended and reminders", checkDueAndEnded);

  if (failures.length > 0) {
    process.stderr.write(`recurring schedule gate failed with ${String(failures.length)} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `recurring schedule gate passed: ${String(checks)} checks, 0028's bounds read from the SQL, ` +
      `${String(SHIFT_CASES.length)} calendar cases including leap days and the 31st, the anchor rule across ` +
      "a year of clamped months, due and end dates, and the reminder cadence with its off-switch\n",
  );
}

await run();
