// path: services/disputes/dispute-response-verify.ts
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { en } from "../../lib/i18n/strings/en.ts";
import { CSRF_PROTECTED_PATHS } from "../../lib/security/csrf.ts";
import { disputeRowSchema, disputeViewOf, type DisputeDependencies } from "./dispute.ts";
import {
  DISPUTE_AUDIT,
  DISPUTE_DEFAULT_WINDOW_HOURS,
  DISPUTE_DEADLINE_ROLES,
  DISPUTE_EXTENDED_WINDOW_HOURS,
  DISPUTE_REQUEST_ROLES,
  DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES,
  DISPUTE_RESPONSE_MAXIMUM_LENGTH,
  DISPUTE_RULES,
  DISPUTE_STATUSES,
  DISPUTE_WINDOW_HOURS,
  disputeDueAt,
  disputeExtensionTarget,
} from "./dispute-fields.ts";
import {
  DISPUTE_FALLBACK_TIME_ZONE,
  disputeDeadlineOf,
  disputeRemainingOf,
  isDisputeTimeZone,
  localDeadlineOf,
  localOffsetMinutesOf,
  localOffsetShiftOf,
  offsetTextOf,
  readDisputeTimeZone,
} from "./dispute-deadline.ts";
import { disputeResponseTextOf, parseDisputeDeadlineBody, parseDisputeResponseBody } from "./dispute-response-fields.ts";
import { extendDisputeDeadline, readCompanyDispute, saveDisputeResponse } from "./dispute-response.ts";

/**
 * The gate for STEP 195: section 19's merchant response and the 24-hour, timezone-aware deadline.
 *
 * ## What this proves
 *
 *   - **The window is absolute hours, and the zone is how it is said.** `0124` adds no clock arithmetic: the
 *     deadline is `opened_at + response_window_hours`, exactly what `0039`'s `disputes_due_check` bounds, and
 *     the gate proves the same instant comes out in Dhaka, in New York, in Kolkata and in UTC. The zone then
 *     prints that one instant, names its offset, and reports when the zone moved its own clock inside the
 *     window - which is the only thing a zone can honestly add.
 *   - **A response is written inside the window and nowhere else.** Decided, sent and closed are three separate
 *     refusals; the write is version-guarded and read back, so two tabs cannot both be told they won; and the
 *     `0124` trigger and check are re-implemented in the fixture so a save the database would refuse is a
 *     failure here too.
 *   - **The extension goes one way, for one role, with a second factor.** 24 to 48 moves the window *and* the
 *     deadline together; 48 to 24, 48 to 48 and 12 are refusals; a closed window is never reopened; and an
 *     officer without `super_admin` or without a satisfied second factor is refused before the row is read.
 *   - **The words are not the audit.** Every act writes one entry naming the length, the instants and the
 *     window, and never the merchant's text.
 *   - **The route is a boundary and nothing else.** CSRF, the ceiling, the session, the parse, one service call,
 *     `no-store` - and the office route carries the device proof the merchant route deliberately does not.
 *   - **The two screens exist at both widths**, print the deadline on both clocks, and every message they ask
 *     for is in the catalogue.
 *   - **Nothing here writes money.** No `payments` write, no ledger, no inserted row of any kind.
 */

const failures: string[] = [];
let checkCount = 0;

function expect(condition: boolean, description: string): void {
  checkCount += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<TValue>(actual: TValue, expected: TValue, description: string): void {
  expect(Object.is(actual, expected), `${description} (expected ${String(expected)}, got ${String(actual)})`);
}

/** Run a call that must refuse with a code, and check that it is an `AppError`. */
async function expectRefusal(run: () => Promise<unknown>, code: string, description: string): Promise<void> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
  } catch (error) {
    if (!isAppError(error)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return;
    }

    expectEqual(error.code, code, description);
  }
}

/** The rule a refusal named, so a gate can prove *which* refusal answered and not only that one did. */
async function expectRule(run: () => Promise<unknown>, rule: string, description: string): Promise<void> {
  try {
    await run();
    expect(false, `${description} (nothing was thrown)`);
  } catch (error) {
    if (!(error instanceof AppError)) {
      expect(false, `${description} (threw something that is not an AppError)`);
      return;
    }

    const details = error.details;

    expectEqual(details[0]?.rule ?? null, rule, description);
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture: a PostgREST over arrays with `0039`'s deadline check and `0124`'s response guard on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const officeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const disputeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const paymentId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const openedAtMs = Date.parse("2026-11-07T09:00:00.000Z");
const dueAtMs = openedAtMs + 24 * 3_600_000;

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"],
    sessionId: "session-0001",
    assuranceLevel: "aal1",
    authenticatedAtEpochMs: openedAtMs - 60_000,
    expiresAtEpochMs: openedAtMs + 3_600_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

function officeActor(role: PlatformRole, satisfiedTwoFactor = true): RequestActor {
  return actorOf({ userId: officeUserId, companyId: null, roles: [role], twoFactorSatisfied: satisfiedTwoFactor });
}

function disputeRow(overrides: Row = {}): Row {
  return {
    id: disputeId,
    company_id: companyId,
    payment_id: paymentId,
    processor_dispute_id: "dp_0001",
    status: "under_review",
    reason_code: "fraudulent",
    amount_minor: "250000",
    currency: "USD",
    fee_minor: "0",
    opened_at: new Date(openedAtMs).toISOString(),
    response_window_hours: DISPUTE_DEFAULT_WINDOW_HOURS,
    response_due_at: new Date(dueAtMs).toISOString(),
    evidence_ready: false,
    response_text: null,
    response_saved_at: null,
    submitted_at: null,
    resolved_at: null,
    outcome_note: null,
    created_at: new Date(openedAtMs).toISOString(),
    updated_at: new Date(openedAtMs).toISOString(),
    version: 1,
    ...overrides,
  };
}

interface Fixture {
  readonly rest: RestClient;
  readonly disputes: Row[];
  readonly audit: InMemoryAuditTrail;
  readonly written: string[];
  nowMs: number;
  /** Something that lands between a caller's read and its write: another tab, another officer. */
  beforeUpdate: ((table: string) => void) | null;
}

/**
 * `0124`'s two rules and `0039`'s deadline rule, as the fixture enforces them.
 *
 * Written as SQL would: the trigger is a refusal of a *change*, the check is a property of the *row*, and both
 * fire on every write. A service that skipped the deadline, or moved the window without the deadline, fails
 * here rather than passing and failing in production.
 */
function guardResponse(next: Row, previous: Row | null): void {
  const text = next["response_text"] === null || next["response_text"] === undefined ? null : String(next["response_text"]);
  const savedAt =
    next["response_saved_at"] === null || next["response_saved_at"] === undefined ? null : String(next["response_saved_at"]);

  if ((text === null) !== (savedAt === null)) {
    throw new AppError("CONFLICT", { details: [{ field: "response_saved_at", rule: "disputes_response_saved_check" }] });
  }

  if (text !== null) {
    if (text.length < 1 || text.length > DISPUTE_RESPONSE_MAXIMUM_LENGTH) {
      throw new AppError("CONFLICT", { details: [{ field: "response_text", rule: "disputes_response_check" }] });
    }

    if (text !== text.trim()) {
      throw new AppError("CONFLICT", { details: [{ field: "response_text", rule: "disputes_response_check" }] });
    }
  }

  if (savedAt !== null) {
    const saved = Date.parse(savedAt);
    const opened = Date.parse(String(next["opened_at"]));
    const due = Date.parse(String(next["response_due_at"]));

    if (!(saved >= opened && saved <= due)) {
      throw new AppError("CONFLICT", { details: [{ field: "response_saved_at", rule: "disputes_response_saved_check" }] });
    }
  }

  if (previous !== null && (next["submitted_at"] !== null || next["resolved_at"] !== null)) {
    if (previous["response_text"] !== next["response_text"] || previous["response_saved_at"] !== next["response_saved_at"]) {
      throw new AppError("CONFLICT", { details: [{ field: "response_text", rule: "disputes_guard_response" }] });
    }
  }

  // `disputes_due_check` and `disputes_window_check`, which the extension has to satisfy as much as the webhook.
  if (!(DISPUTE_WINDOW_HOURS as readonly number[]).includes(Number(next["response_window_hours"]))) {
    throw new AppError("CONFLICT", { details: [{ field: "response_window_hours", rule: "disputes_window_check" }] });
  }

  const opened = Date.parse(String(next["opened_at"]));
  const due = Date.parse(String(next["response_due_at"]));

  if (!(due > opened && due <= opened + Number(next["response_window_hours"]) * 3_600_000)) {
    throw new AppError("CONFLICT", { details: [{ field: "response_due_at", rule: "disputes_due_check" }] });
  }

  if (previous !== null && previous["submitted_at"] !== null && previous["response_window_hours"] !== next["response_window_hours"]) {
    throw new AppError("CONFLICT", { details: [{ field: "response_window_hours", rule: "disputes_guard_deadline" }] });
  }

  if (previous !== null && previous["resolved_at"] !== null && previous["status"] !== next["status"]) {
    throw new AppError("CONFLICT", { details: [{ field: "status", rule: "disputes_guard_state" }] });
  }
}

function parseQuery(query: string): { readonly equals: Map<string, string>; readonly nulls: Set<string> } {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select" || key === "limit" || key === "order") {
      continue;
    }

    if (value === "is.null") {
      nulls.add(key);
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls };
}

function createFixture(rows: readonly Row[]): Fixture {
  const disputes: Row[] = rows.map((row) => ({ ...row }));
  const written: string[] = [];
  let clock = 0;

  const rowsOf = (name: string): Row[] => {
    if (name !== "disputes") {
      throw new AppError("DEPENDENCY_FAILED");
    }

    return disputes;
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      const matched = rowsOf(name).filter((row) => {
        for (const [column, value] of parsed.equals) {
          if (String(row[column]) !== value) {
            return false;
          }
        }

        for (const column of parsed.nulls) {
          if (row[column] !== null && row[column] !== undefined) {
            return false;
          }
        }

        return true;
      });

      return schema.array().parse(matched.slice(0, 1));
    },

    async insert(): Promise<void> {
      throw new AppError("DEPENDENCY_FAILED");
    },

    async insertReturning<TRow>(): Promise<readonly TRow[]> {
      throw new AppError("DEPENDENCY_FAILED");
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      written.push(name);

      const interference = fixture.beforeUpdate;

      fixture.beforeUpdate = null;
      interference?.(name);

      const parsed = parseQuery(query);

      for (const row of rowsOf(name)) {
        let matches = true;

        for (const [column, value] of parsed.equals) {
          if (String(row[column]) !== value) {
            matches = false;
          }
        }

        for (const column of parsed.nulls) {
          if (row[column] !== null && row[column] !== undefined) {
            matches = false;
          }
        }

        if (!matches) {
          continue;
        }

        const next: Row = { ...row, ...values };

        guardResponse(next, row);
        clock += 1;
        next["version"] = Number(row["version"]) + 1;
        next["updated_at"] = new Date(openedAtMs + clock * 1_000).toISOString();
        Object.assign(row, next);
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED");
    },
  };

  const fixture: Fixture = {
    rest,
    disputes,
    audit: createInMemoryAuditTrail(),
    written,
    nowMs: dueAtMs - 6 * 3_600_000,
    beforeUpdate: null,
  };

  return fixture;
}

function dependenciesOf(fixture: Fixture): DisputeDependencies {
  return { rest: fixture.rest, audit: fixture.audit, now: () => fixture.nowMs };
}

function actionsOf(fixture: Fixture): readonly string[] {
  return fixture.audit.entries.map((entry) => entry.action);
}

function lastEntry(fixture: Fixture): Record<string, unknown> | null {
  const entry = fixture.audit.entries[fixture.audit.entries.length - 1];

  return entry === undefined ? null : (entry as unknown as Record<string, unknown>);
}

// ---------------------------------------------------------------------------------------------
// The source of a file, for the parts a runtime cannot reach
// ---------------------------------------------------------------------------------------------

async function sourceOf(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function expectSourceContains(source: string, needle: string, description: string): void {
  expect(source.includes(needle), `${description} (missing ${JSON.stringify(needle)})`);
}

function expectSourceLacks(source: string, needle: string, description: string): void {
  expect(!source.includes(needle), `${description} (found ${JSON.stringify(needle)})`);
}

/**
 * The two leftover markers a shipped file may not carry, spelled in halves so that this file does not carry
 * them either - the structure gate refuses the marker anywhere in the tree, this gate included.
 */
const PLACEHOLDER_MARKERS: readonly string[] = Object.freeze([["TO", "DO"].join(""), ["FIX", "ME"].join("")]);

function expectNoPlaceholderMarker(source: string, description: string): void {
  for (const marker of PLACEHOLDER_MARKERS) {
    expect(!source.includes(marker), `${description} carries no ${marker}`);
  }
}

/** The catalogue, as a dotted lookup: `disputes.title` -> the sentence. */
function messageAt(path: string): string | null {
  let cursor: unknown = en;

  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) {
      return null;
    }

    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return typeof cursor === "string" ? cursor : null;
}

/** Every `getMessage("disputes.x")` / `formatMessage("disputes.x", ...)` a file asks for. */
function messagePathsIn(source: string): readonly string[] {
  const paths = new Set<string>();

  for (const match of source.matchAll(/"(disputes\.[A-Za-z0-9_]+)"/gu)) {
    if (match[1] !== undefined) {
      paths.add(match[1]);
    }
  }

  return [...paths].sort();
}

/* -------------------------------------------------------------------------------------------------
 * 1. The migration and its rollback
 * ---------------------------------------------------------------------------------------------- */

const migrationsDirectory = "migrations";

async function migrationFiles(): Promise<readonly string[]> {
  const names = await readdir(migrationsDirectory);

  return names.filter((name) => /^\d{4}_.*\.sql$/u.test(name) && !name.endsWith(".down.sql")).sort();
}

const upstream = await readFile(`${migrationsDirectory}/0124_dispute_response.sql`, "utf8");
const rollback = await readFile(`${migrationsDirectory}/0124_dispute_response.down.sql`, "utf8");
const disputeSchema = await readFile(`${migrationsDirectory}/0039_disputes.sql`, "utf8");

expect(
  upstream.includes("alter table public.disputes"),
  "0124 alters the table 0039 already created rather than minting a second one",
);
expectSourceContains(upstream, "add column response_saved_at timestamptz", "0124 adds the instant a response was saved");
expectSourceContains(
  upstream,
  "constraint disputes_response_saved_check",
  "0124 names the check that ties the words to the instant",
);
expect(
  upstream.includes("(response_text is null) = (response_saved_at is null)"),
  "review caught the pair drifting apart: a body without an instant, or an instant without a body",
);
expect(
  upstream.includes("response_saved_at >= opened_at") && upstream.includes("response_saved_at <= response_due_at"),
  "review caught the instant that `0039`'s window bounds",
);
expectSourceContains(upstream, "create function public.disputes_guard_response()", "0124 owns a guard function");
expectSourceContains(upstream, "raise exception", "the guard refuses rather than correcting");
expect(
  upstream.includes("submitted_at is not null") && upstream.includes("resolved_at is not null"),
  "the guard freezes the response once it is evidence or history",
);
expectSourceContains(
  upstream,
  "create trigger disputes_guard_response",
  "the guard is a trigger and not a convention the service could forget",
);
expectSourceContains(upstream, "before update", "the guard runs on the write itself");
expectSourceContains(
  upstream,
  "create index disputes_response_idx",
  "the partial index serves the reads that filter on a saved response",
);
expect(
  upstream.includes("where response_saved_at is not null and deleted_at is null"),
  "the index is partial: it holds only the rows a screen asks for",
);
expect(
  !upstream.includes("timezone") && !upstream.includes("time_zone"),
  "0124 adds no zone column: the deadline is an instant, and the zone is how it is printed",
);

expectSourceContains(rollback, "drop index if exists public.disputes_response_idx", "the rollback drops the index");
expect(
  rollback.indexOf("drop trigger if exists disputes_guard_response") <
    rollback.indexOf("drop function if exists public.disputes_guard_response()"),
  "the rollback drops the trigger before the function it calls",
);
expectSourceContains(rollback, "drop column if exists response_saved_at", "the rollback drops the column last");
expect(!rollback.includes("drop column if exists response_text"), "the rollback keeps the words: `0039`'s column is not 0124's");
expect(rollback.trim().startsWith("-- path: migrations/0124_dispute_response.down.sql"), "the rollback names its own path");

const files = await migrationFiles();
const numbers = files.map((name) => Number.parseInt(name.slice(0, 4), 10));

// 0124 is this STEP's own; 0125 was STEP 196's and 0126 is STEP 197's, which now heads the chain.
expectEqual(numbers[numbers.length - 1] ?? 0, 126, "0124 is still in the chain; STEP 197's 0126 is the newest");
expectEqual(files.length, 126, "the chain is 126 files");
expectEqual(
  numbers.every((value, index) => value === index + 1),
  true,
  "the chain is contiguous from 0001 to 0124 with no gap",
);
expectEqual(new Set(numbers).size, numbers.length, "no migration number is used twice");

expect(
  (DISPUTE_WINDOW_HOURS as readonly number[]).includes(DISPUTE_DEFAULT_WINDOW_HOURS) &&
    (DISPUTE_WINDOW_HOURS as readonly number[]).includes(DISPUTE_EXTENDED_WINDOW_HOURS),
  "the two windows the form offers are the two the schema allows",
);
expectSourceContains(disputeSchema, "response_window_hours in (24, 48)", "`0039` allows exactly 24 and 48");
expectSourceContains(disputeSchema, "disputes_due_check", "`0039` bounds the deadline by the window");
expectSourceContains(disputeSchema, "disputes_guard_deadline", "`0039` already refuses to reopen a decided dispute");

/* -------------------------------------------------------------------------------------------------
 * 2. The extension only ever widens, once
 * ---------------------------------------------------------------------------------------------- */

expectEqual(disputeExtensionTarget(24, 48), 48, "a 24-hour window may be extended to 48");
expectEqual(disputeExtensionTarget(24, 24), null, "a 24-hour window may not be 'extended' to itself");
expectEqual(disputeExtensionTarget(48, 24), null, "a 48-hour window may not be narrowed: that takes time back");
expectEqual(disputeExtensionTarget(48, 48), null, "a 48-hour window is already the bound");
expectEqual(disputeExtensionTarget(24, 12), null, "a window the schema does not allow is not a target");
expectEqual(disputeExtensionTarget(24, 72), null, "no window wider than section 19's 48 exists");
expectEqual(DISPUTE_DEADLINE_ROLES.length, 1, "one role extends a deadline");
expectEqual(DISPUTE_DEADLINE_ROLES[0], "super_admin", "and it is the one section 19 names");
expect(
  !(DISPUTE_REQUEST_ROLES as readonly PlatformRole[]).includes("super_admin"),
  "the merchant's own role list still holds no office role",
);
expectEqual(DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES, 32_768, "the body ceiling leaves room for escaping inside 20,000 characters");

/* -------------------------------------------------------------------------------------------------
 * 3. The deadline: absolute hours, printed in a zone
 * ---------------------------------------------------------------------------------------------- */

const dhakaDeadline = disputeDeadlineOf(openedAtMs, DISPUTE_DEFAULT_WINDOW_HOURS, "Asia/Dhaka");
const newYorkDeadline = disputeDeadlineOf(openedAtMs, DISPUTE_DEFAULT_WINDOW_HOURS, "America/New_York");
const utcDeadline = disputeDeadlineOf(openedAtMs, DISPUTE_DEFAULT_WINDOW_HOURS, DISPUTE_FALLBACK_TIME_ZONE);
const extendedDeadline = disputeDeadlineOf(openedAtMs, DISPUTE_EXTENDED_WINDOW_HOURS, "Asia/Dhaka");

expectEqual(dhakaDeadline.dueAtEpochMs, dueAtMs, "the deadline is the opening plus the window, in Dhaka");
expectEqual(newYorkDeadline.dueAtEpochMs, dueAtMs, "the same instant in New York: a zone does not move a deadline");
expectEqual(utcDeadline.dueAtEpochMs, dueAtMs, "and the same instant in UTC");
expectEqual(extendedDeadline.dueAtEpochMs, openedAtMs + 48 * 3_600_000, "the extension is forty-eight absolute hours");
expectEqual(
  disputeDeadlineOf(openedAtMs, 12, "Asia/Dhaka").windowHours,
  DISPUTE_DEFAULT_WINDOW_HOURS,
  "a window the schema would refuse falls back to the default rather than computing something unstoreable",
);
expectEqual(disputeDeadlineOf(openedAtMs, 24, "Mars/Olympus").zone, DISPUTE_FALLBACK_TIME_ZONE, "an unknown zone prints as UTC");
expectEqual(disputeDueAt(openedAtMs, DISPUTE_DEFAULT_WINDOW_HOURS), dhakaDeadline.dueAtEpochMs, "one arithmetic, used by both sides");

const dhakaLocal = localDeadlineOf(dueAtMs, "Asia/Dhaka");
const utcLocal = localDeadlineOf(dueAtMs, "UTC");
const kolkataLocal = localDeadlineOf(dueAtMs, "Asia/Kolkata");

expectEqual(dhakaLocal.dateText, "8 Nov 2026", "the deadline is the day after the report in Dhaka");
expectEqual(dhakaLocal.timeText.startsWith("15:00"), true, "and 15:00 on that merchant's dial, six hours ahead of the instant");
expectEqual(dhakaLocal.offsetMinutes, 360, "Dhaka is UTC+06:00");
expectEqual(dhakaLocal.offsetText, "UTC+06:00", "and says so in the one format the platform prints offsets in");
expectEqual(dhakaLocal.zone, "Asia/Dhaka", "the zone is named, because a time without one is the ambiguity section 19 is about");
expect(dhakaLocal.zoneName.length > 0, "the runtime's own abbreviation is preferred when it has one");
expect(dhakaLocal.text.includes("8 Nov 2026") && dhakaLocal.text.includes("15:00"), "the single string carries both");
expectEqual(utcLocal.timeText.startsWith("09:00"), true, "in UTC the same deadline reads 09:00");
expectEqual(utcLocal.offsetMinutes, 0, "UTC's offset is nothing");
expectEqual(utcLocal.offsetText, "UTC", "and it is printed as UTC rather than UTC+00:00");
expectEqual(kolkataLocal.offsetMinutes, 330, "a half-hour zone is a real zone");
expectEqual(kolkataLocal.offsetText, "UTC+05:30", "and its offset is printed to the minute");
expectEqual(kolkataLocal.timeText.startsWith("14:30"), true, "with a deadline the dial shows at half past");
expectEqual(localDeadlineOf(dueAtMs, "America/New_York").offsetText, "UTC-05:00", "a negative offset keeps its sign");
expectEqual(localDeadlineOf(dueAtMs, "not a zone").zone, DISPUTE_FALLBACK_TIME_ZONE, "a zone the runtime refuses prints as UTC");

expectEqual(localOffsetMinutesOf("Asia/Dhaka", openedAtMs), 360, "the offset is read from the instant, not assumed");
expectEqual(localOffsetMinutesOf("America/New_York", Date.parse("2026-07-01T12:00:00.000Z")), -240, "and it changes with daylight saving");
expectEqual(localOffsetMinutesOf("America/New_York", Date.parse("2026-12-01T12:00:00.000Z")), -300, "in both directions");
expectEqual(offsetTextOf(0), "UTC", "no offset is UTC");
expectEqual(offsetTextOf(-210), "UTC-03:30", "and a negative half-hour offset is printed whole");

const springOpenedAt = Date.parse("2027-03-14T02:00:00.000Z");
const fallOpenedAt = Date.parse("2027-11-06T20:00:00.000Z");
const springWindow = localOffsetShiftOf(springOpenedAt, disputeDueAt(springOpenedAt, 24), "America/New_York");
const fallWindow = localOffsetShiftOf(fallOpenedAt, disputeDueAt(fallOpenedAt, 24), "America/New_York");
const quietWindow = localOffsetShiftOf(openedAtMs, dueAtMs, "America/New_York");
const dhakaWindow = localOffsetShiftOf(openedAtMs, dueAtMs, "Asia/Dhaka");

expectEqual(springWindow.shifted, true, "a window that crosses a spring-forward is reported as shifted");
expectEqual(springWindow.localHours, 25, "the dial reads twenty-five hours across it, and the window is still twenty-four");
expectEqual(springWindow.openedOffsetMinutes, -300, "the window opened in standard time");
expectEqual(springWindow.dueOffsetMinutes, -240, "and closed in daylight saving time");
expectEqual(fallWindow.shifted, true, "a window that crosses a fall-back is reported as shifted");
expectEqual(fallWindow.localHours, 23, "the dial reads twenty-three hours across it");
expectEqual(quietWindow.shifted, false, "a window inside one offset is not shifted");
expectEqual(quietWindow.localHours, 24, "and reads the window's own twenty-four hours");
expectEqual(dhakaWindow.shifted, false, "a zone with no daylight saving never shifts");
expectEqual(disputeDueAt(springOpenedAt, 24) - springOpenedAt, 24 * 3_600_000, "and the instant is twenty-four real hours in every zone");

const openRemaining = disputeRemainingOf(dueAtMs, dueAtMs - 5 * 3_600_000);
const soonRemaining = disputeRemainingOf(dueAtMs, dueAtMs - 3.5 * 3_600_000);
const lateRemaining = disputeRemainingOf(dueAtMs, dueAtMs + 60_000);

expectEqual(openRemaining.state, "open", "five hours out is open");
expectEqual(openRemaining.hours, 5, "with the hours left counted");
expectEqual(soonRemaining.state, "due_soon", "three and a half hours out is due soon");
expectEqual(soonRemaining.hours, 3, "with the hours and");
expectEqual(soonRemaining.minutes, 30, "the minutes counted");
expectEqual(lateRemaining.state, "overdue", "a minute late is overdue");
expectEqual(disputeRemainingOf(dueAtMs, dueAtMs).state, "overdue", "and neither is the instant itself");
expectEqual(disputeRemainingOf(dueAtMs, dueAtMs - 24 * 3_600_000).state, "open", "the whole window is open at its start");

expectEqual(isDisputeTimeZone("Europe/London"), true, "a real zone is accepted");
expectEqual(isDisputeTimeZone("UTC"), true, "the fallback is a zone too");
expectEqual(isDisputeTimeZone("America/Argentina/Buenos_Aires"), true, "a three segment zone is a zone");
expectEqual(isDisputeTimeZone("Mars/Olympus"), false, "a plausible looking name that is not a zone is refused");
expectEqual(isDisputeTimeZone("x".repeat(80)), false, "an over-long name is never handed to the formatter");
expectEqual(isDisputeTimeZone(""), false, "and neither is nothing");
expectEqual(readDisputeTimeZone(null), DISPUTE_FALLBACK_TIME_ZONE, "a missing zone reads as UTC");
expectEqual(readDisputeTimeZone("  "), DISPUTE_FALLBACK_TIME_ZONE, "and so does a blank one");

/* -------------------------------------------------------------------------------------------------
 * 4. The two bodies
 * ---------------------------------------------------------------------------------------------- */

expectEqual(disputeResponseTextOf("  The order shipped on time.  "), "The order shipped on time.", "a response is trimmed");
expectEqual(disputeResponseTextOf("line one\r\nline two"), "line one\nline two", "a Windows paste is folded into newlines");
expectEqual(disputeResponseTextOf("a\rb"), "a\nb", "and so is a bare carriage return");
expectEqual(disputeResponseTextOf("step one\n\tstep two"), "step one\n\tstep two", "a newline and a tab stay: they are how a person writes");
expectEqual(disputeResponseTextOf("<b>bold</b> still text"), "<b>bold</b> still text", "markup is stored as text, not refused and not stripped");
expectEqual(disputeResponseTextOf("a".repeat(20_000)).length, 20_000, "twenty thousand characters is inside the column's bound");

function refusedRefusal(run: () => unknown): boolean {
  try {
    run();

    return false;
  } catch (error) {
    return isAppError(error) && error.code === "VALIDATION_FAILED";
  }
}

expect(refusedRefusal(() => disputeResponseTextOf("   ")), "an empty response is refused");
expect(refusedRefusal(() => disputeResponseTextOf("")), "and so is a response of nothing at all");
expect(refusedRefusal(() => disputeResponseTextOf("x".repeat(20_001))), "twenty thousand and one characters is refused");
expect(refusedRefusal(() => disputeResponseTextOf("before\u0000after")), "a NUL byte is refused");
expectEqual(
  disputeResponseTextOf("\u0645\u0631\u062d\u0628\u0627 \u202bworld\u202c").length,
  13,
  "a merchant writing in a right-to-left script keeps the marks their text needs, counted once each",
);

expectEqual(parseDisputeResponseBody({ response_text: "  My side.  " }).responseText, "My side.", "the body parser normalises");
expect(
  refusedRefusal(() => parseDisputeResponseBody({ response_text: "My side.", extra: 1 })),
  "an unknown field is refused rather than ignored",
);
expect(refusedRefusal(() => parseDisputeResponseBody({ response_text: 7 })), "a response that is not a string is refused");
expect(refusedRefusal(() => parseDisputeResponseBody({})), "a body without a response is refused");
expect(refusedRefusal(() => parseDisputeResponseBody(null)), "and a body that is not an object");

expectEqual(parseDisputeDeadlineBody({ response_window_hours: 48 }).windowHours, 48, "the extension body is read");
expectEqual(parseDisputeDeadlineBody({ response_window_hours: 24 }).windowHours, 24, "and so is the shorter window");
expect(refusedRefusal(() => parseDisputeDeadlineBody({ response_window_hours: 12 })), "a window the schema refuses is refused here");
expect(refusedRefusal(() => parseDisputeDeadlineBody({ response_window_hours: 48.5 })), "a fractional window is refused, not truncated");
expect(refusedRefusal(() => parseDisputeDeadlineBody({ response_window_hours: "48" })), "a window as a string is refused");
expect(
  refusedRefusal(() => parseDisputeDeadlineBody({ response_window_hours: 48, force: true })),
  "an unknown field on the extension is refused",
);

/* -------------------------------------------------------------------------------------------------
 * 5. Reading one of the merchant's own disputes
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture([disputeRow()]);
  const view = await readCompanyDispute({ actor: actorOf(), disputeId }, dependenciesOf(fixture));

  expectEqual(view.id, disputeId, "the owner reads their own dispute");
  expectEqual(view.responseText, null, "with no response yet");
  expectEqual(view.responseDueAt, new Date(dueAtMs).toISOString(), "and the deadline the row holds");
  expectEqual(view.dueState, "open", "six hours out, it is open");
  expectEqual(view.amountText.length > 0, true, "the amount is printed by the view, not by the page");
}

{
  const fixture = createFixture([disputeRow()]);

  await expectRefusal(
    () => readCompanyDispute({ actor: actorOf({ roles: ["support"] }), disputeId }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "an office role reads no merchant dispute through the merchant's door",
  );
  await expectRule(
    () =>
      readCompanyDispute(
        { actor: actorOf({ companyId: otherCompanyId }), disputeId },
        dependenciesOf(fixture),
      ),
    DISPUTE_RULES.disputeNotFound,
    "another merchant's dispute reads as not found, not as forbidden",
  );
  await expectRefusal(
    () => readCompanyDispute({ actor: actorOf({ companyId: null }), disputeId }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "a session without a company reads nothing",
  );
  await expectRule(
    () => readCompanyDispute({ actor: actorOf(), disputeId: "not-a-uuid" }, dependenciesOf(fixture)),
    DISPUTE_RULES.disputeNotFound,
    "an id that is not an id never reaches the database",
  );
}

/* -------------------------------------------------------------------------------------------------
 * 6. Writing the response
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture([disputeRow()]);
  const saved = await saveDisputeResponse(
    { actor: actorOf(), disputeId, body: { response_text: "  The order shipped on 3 November.  " } },
    dependenciesOf(fixture),
  );

  expectEqual(saved.responseText, "The order shipped on 3 November.", "the response is written trimmed");
  expectEqual(saved.responseSavedAt, new Date(fixture.nowMs).toISOString(), "and stamped with the clock the platform read");
  expectEqual(fixture.disputes[0]?.["version"], 2, "the version moved, so a second tab's write can be told apart");
  expectEqual(fixture.written.length, 1, "one write, on one table");
  expectEqual(fixture.written[0], "disputes", "and it is the dispute itself: no payment, no ledger, no event");
  expectEqual(actionsOf(fixture).length, 1, "one audit entry");
  expectEqual(actionsOf(fixture)[0], DISPUTE_AUDIT.responseSaved, "named for the act");

  const payload = (lastEntry(fixture)?.["payload"] ?? {}) as Record<string, unknown>;

  expectEqual(payload["response_length"], 32, "the chain records how much was written");
  expectEqual(JSON.stringify(payload).includes("shipped"), false, "and never what was written");
  expectEqual(payload["response_due_at"], new Date(dueAtMs).toISOString(), "the deadline the save was judged against is on the entry");
  expectEqual(lastEntry(fixture)?.["entityId"], disputeId, "the entry names the dispute");
  expectEqual(lastEntry(fixture)?.["companyId"], companyId, "and the merchant it belongs to");
  expectEqual(lastEntry(fixture)?.["actorUserId"], ownerUserId, "and the person who wrote it");

  const second = await saveDisputeResponse(
    { actor: actorOf(), disputeId, body: { response_text: "An edit before the deadline." } },
    dependenciesOf(fixture),
  );

  expectEqual(second.responseText, "An edit before the deadline.", "a merchant may edit until the window closes");
  expectEqual(fixture.disputes[0]?.["version"], 3, "each save moves the version");
  expectEqual(actionsOf(fixture).length, 2, "and each one is its own entry");
}

{
  const fixture = createFixture([disputeRow({ response_due_at: new Date(dueAtMs).toISOString() })]);
  fixture.nowMs = dueAtMs + 1;

  await expectRefusal(
    () => saveDisputeResponse({ actor: actorOf(), disputeId, body: { response_text: "One minute late." } }, dependenciesOf(fixture)),
    "CONFLICT",
    "a save after the deadline is refused",
  );
  await expectRule(
    () => saveDisputeResponse({ actor: actorOf(), disputeId, body: { response_text: "One minute late." } }, dependenciesOf(fixture)),
    DISPUTE_RULES.deadlinePassed,
    "and it is the closed window that refused it",
  );
  expectEqual(fixture.disputes[0]?.["response_text"], null, "nothing was written");
  expectEqual(actionsOf(fixture).length, 0, "and nothing was logged as if it had been");
}

{
  const submittedAt = new Date(openedAtMs + 3_600_000).toISOString();
  const fixture = createFixture([disputeRow({ submitted_at: submittedAt, evidence_ready: true })]);

  await expectRule(
    () => saveDisputeResponse({ actor: actorOf(), disputeId, body: { response_text: "A later thought." } }, dependenciesOf(fixture)),
    DISPUTE_RULES.submitted,
    "a response is frozen once the pack has been sent",
  );
  expectEqual(fixture.disputes[0]?.["response_text"], null, "and the row is untouched");
}

{
  const resolvedAt = new Date(openedAtMs + 2 * 3_600_000).toISOString();
  const fixture = createFixture([disputeRow({ status: "lost", resolved_at: resolvedAt, outcome_note: "Cardholder evidence." })]);

  await expectRule(
    () => saveDisputeResponse({ actor: actorOf(), disputeId, body: { response_text: "A late appeal." } }, dependenciesOf(fixture)),
    DISPUTE_RULES.resolved,
    "a decided dispute takes no more words",
  );
}

{
  const fixture = createFixture([disputeRow()]);

  await expectRule(
    () => saveDisputeResponse({ actor: actorOf(), disputeId, body: { response_text: "   " } }, dependenciesOf(fixture)),
    DISPUTE_RULES.responseInvalid,
    "an empty response is refused before the row is read",
  );
  await expectRefusal(
    () => saveDisputeResponse({ actor: actorOf({ companyId: otherCompanyId }), disputeId, body: { response_text: "Mine now." } }, dependenciesOf(fixture)),
    "RESOURCE_NOT_FOUND",
    "another merchant writes nothing",
  );
  await expectRefusal(
    () => saveDisputeResponse({ actor: actorOf({ roles: ["finance_ops"] }), disputeId, body: { response_text: "Desk note." } }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "and no office role writes a merchant's response for them",
  );
  expectEqual(fixture.disputes[0]?.["response_text"], null, "none of the three wrote anything");
}

{
  // Two tabs: the first save lands between the second tab's read and its write.
  const fixture = createFixture([disputeRow()]);

  fixture.beforeUpdate = (table: string): void => {
    fixture.nowMs += 1_000;
    expectEqual(table, "disputes", "the interference is on the dispute");
    const row = fixture.disputes[0];

    if (row !== undefined) {
      row["response_text"] = "The other tab wrote first.";
      row["response_saved_at"] = new Date(fixture.nowMs).toISOString();
      row["version"] = Number(row["version"]) + 1;
    }
  };

  await expectRule(
    () => saveDisputeResponse({ actor: actorOf(), disputeId, body: { response_text: "This tab." } }, dependenciesOf(fixture)),
    DISPUTE_RULES.disputeMoved,
    "a save that another tab beat is refused, and the merchant is told to look",
  );
  expectEqual(actionsOf(fixture).length, 0, "a refused save logs nothing");
}

/* -------------------------------------------------------------------------------------------------
 * 7. Extending the deadline
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture([disputeRow()]);
  const extended = await extendDisputeDeadline(
    { actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 48 } },
    dependenciesOf(fixture),
  );

  expectEqual(extended.responseWindowHours, 48, "the window is now 48 hours");
  expectEqual(extended.responseDueAt, new Date(openedAtMs + 48 * 3_600_000).toISOString(), "and the deadline moved with it");
  expectEqual(fixture.disputes[0]?.["version"], 2, "the write is version guarded like any other");
  expectEqual(actionsOf(fixture)[0], DISPUTE_AUDIT.deadlineExtended, "the extension is on the chain");

  const payload = (lastEntry(fixture)?.["payload"] ?? {}) as Record<string, unknown>;

  expectEqual(payload["from_window_hours"], 24, "the entry says what the window was");
  expectEqual(payload["to_window_hours"], 48, "and what it became");
  expectEqual(payload["to_due_at"], new Date(openedAtMs + 48 * 3_600_000).toISOString(), "and the instant it moved to");
  expectEqual(lastEntry(fixture)?.["actorUserId"], officeUserId, "with the officer who moved it");
}

{
  const fixture = createFixture([disputeRow()]);

  await expectRefusal(
    () => extendDisputeDeadline({ actor: officeActor("finance_ops"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "a finance officer cannot move a merchant's deadline",
  );
  await expectRefusal(
    () => extendDisputeDeadline({ actor: officeActor("ceo"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "and neither can the chief executive",
  );
  // `compliance_kyc` and `super_admin` are in the read list; only `super_admin` may write here.
  await expectRefusal(
    () => extendDisputeDeadline({ actor: officeActor("compliance_kyc"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "the compliance desk reads disputes but does not move their deadlines",
  );
  await expectRefusal(
    () => extendDisputeDeadline({ actor: officeActor("super_admin", false), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "and a super administrator without a satisfied second factor is refused",
  );
  expectEqual(fixture.disputes[0]?.["response_window_hours"], 24, "no refusal moved the window");
  expectEqual(actionsOf(fixture).length, 0, "and none of them logged a change");
}

{
  const alreadyExtended = createFixture([
    disputeRow({
      response_window_hours: 48,
      response_due_at: new Date(openedAtMs + 48 * 3_600_000).toISOString(),
    }),
  ]);

  await expectRule(
    () => extendDisputeDeadline({ actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(alreadyExtended)),
    DISPUTE_RULES.windowInvalid,
    "a 48-hour window is not extended again",
  );

  const narrow = createFixture([
    disputeRow({ response_window_hours: 48, response_due_at: new Date(openedAtMs + 48 * 3_600_000).toISOString() }),
  ]);
  await expectRule(
    () => extendDisputeDeadline({ actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 24 } }, dependenciesOf(narrow)),
    DISPUTE_RULES.windowInvalid,
    "and a window may not be narrowed to make time up",
  );
}

{
  const late = createFixture([disputeRow()]);
  late.nowMs = dueAtMs + 1;
  await expectRule(
    () => extendDisputeDeadline({ actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(late)),
    DISPUTE_RULES.deadlinePassed,
    "a closed window is never reopened from the office",
  );

  const sent = createFixture([disputeRow({ submitted_at: new Date(dueAtMs - 3_600_000).toISOString(), evidence_ready: true })]);
  await expectRule(
    () => extendDisputeDeadline({ actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(sent)),
    DISPUTE_RULES.submitted,
    "a sent pack's deadline is already evidence",
  );

  const decided = createFixture([
    disputeRow({
      status: "won",
      submitted_at: new Date(dueAtMs - 3_600_000).toISOString(),
      evidence_ready: true,
      resolved_at: new Date(dueAtMs + 60_000).toISOString(),
      outcome_note: "Evidence covered the delivery.",
    }),
  ]);
  await expectRule(
    () => extendDisputeDeadline({ actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(decided)),
    DISPUTE_RULES.deadlineNotExtendable,
    "a decided dispute has no deadline left to move",
  );

  const unknown = createFixture([disputeRow()]);
  await expectRefusal(
    () =>
      extendDisputeDeadline(
        { actor: officeActor("super_admin"), disputeId: "ffffffff-ffff-4fff-8fff-ffffffffffff", body: { response_window_hours: 48 } },
        dependenciesOf(unknown),
      ),
    "RESOURCE_NOT_FOUND",
    "a dispute that does not exist is not found",
  );
}

{
  // The version guard, on the office side: an officer's extension loses to a save that landed first.
  const fixture = createFixture([disputeRow()]);

  fixture.beforeUpdate = (): void => {
    const row = fixture.disputes[0];

    if (row !== undefined) {
      row["response_text"] = "The merchant answered meanwhile.";
      row["response_saved_at"] = new Date(fixture.nowMs).toISOString();
      row["version"] = Number(row["version"]) + 1;
    }
  };

  await expectRule(
    () => extendDisputeDeadline({ actor: officeActor("super_admin"), disputeId, body: { response_window_hours: 48 } }, dependenciesOf(fixture)),
    DISPUTE_RULES.disputeMoved,
    "an extension that lost a race is refused rather than overwriting the merchant's answer",
  );
}

/* -------------------------------------------------------------------------------------------------
 * 8. The vocabulary
 * ---------------------------------------------------------------------------------------------- */

expectEqual(DISPUTE_RULES.responseInvalid, "dispute_response_invalid", "the refusal a bad body names");
expectEqual(DISPUTE_RULES.deadlinePassed, "dispute_deadline_passed", "the refusal a late save names");
expectEqual(DISPUTE_RULES.submitted, "dispute_submitted", "the refusal a frozen response names");
expectEqual(DISPUTE_RULES.windowInvalid, "dispute_window_invalid", "the refusal a bad extension names");
expectEqual(DISPUTE_RULES.deadlineNotExtendable, "dispute_deadline_not_extendable", "the refusal a decided dispute names");
expectEqual(DISPUTE_AUDIT.responseSaved, "dispute.response_saved", "the action a save is logged as");
expectEqual(DISPUTE_AUDIT.deadlineExtended, "dispute.deadline_extended", "the action an extension is logged as");
expectEqual(
  new Set([DISPUTE_AUDIT.responseSaved, DISPUTE_AUDIT.deadlineExtended]).size,
  2,
  "the two acts are two actions, not one word for both",
);
expect(
  new Set(Object.values(DISPUTE_RULES)).size === Object.values(DISPUTE_RULES).length,
  "every rule is its own word, so a screen can map one to one sentence",
);
expectEqual(
  (DISPUTE_STATUSES as readonly string[]).includes("evidence_submitted"),
  true,
  "and the state a sent pack leaves the row in is still `evidence_submitted`, which this STEP does not set",
);
expectEqual(disputeViewOf(disputeRowSchema.parse(disputeRow()), openedAtMs).responseSavedAt, null, "the view reads the pair from the row");

/* -------------------------------------------------------------------------------------------------
 * 9. The routes
 * ---------------------------------------------------------------------------------------------- */

const merchantRoutePath = "app/api/payments/disputes/[id]/response/route.ts";
const officeRoutePath = "app/api/office/disputes/[id]/deadline/route.ts";
const merchantRoute = await sourceOf(merchantRoutePath);
const officeRoute = await sourceOf(officeRoutePath);

expect(merchantRoute.startsWith("// path: app/api/payments/disputes/[id]/response/route.ts"), "the merchant route names its path");
expect(officeRoute.startsWith("// path: app/api/office/disputes/[id]/deadline/route.ts"), "the office route names its path");

expect(CSRF_PROTECTED_PATHS.includes("/api/payments/disputes/[id]/response"), "the merchant's save is on the CSRF list");
expect(CSRF_PROTECTED_PATHS.includes("/api/office/disputes/[id]/deadline"), "and so is the office's extension");

const merchantCsrfIndex = merchantRoute.indexOf("requireCsrfToken(");
const merchantSessionIndex = merchantRoute.indexOf("readRequestActor(");
const merchantServiceIndex = merchantRoute.indexOf("saveDisputeResponse(");

expect(merchantCsrfIndex > 0, "the merchant route asks for a token");
expect(merchantCsrfIndex < merchantSessionIndex, "before it reads the session");
expect(merchantSessionIndex < merchantServiceIndex, "and long before it writes");
expectSourceContains(merchantRoute, "DISPUTE_RESPONSE_MAXIMUM_BODY_BYTES", "the merchant route enforces the ceiling");
expectSourceContains(merchantRoute, "PAYLOAD_TOO_LARGE", "and refuses a body past it rather than buffering it");
expectSourceContains(merchantRoute, "\"cache-control\": \"no-store\"", "the answer is never cached");
expectSourceContains(merchantRoute, "export const dynamic = \"force-dynamic\"", "and the route is never static");
expectSourceLacks(merchantRoute, "verifySensitiveRequest(", "the merchant's own words need no device proof: they spend nobody else's time");
expectSourceContains(merchantRoute, "responseLength", "the log line carries the length");
expectSourceLacks(merchantRoute, "responseText:", "and never the words themselves");
expectSourceLacks(merchantRoute, "console.", "nothing is printed from a route");
expectSourceContains(officeRoute, "requireCsrfToken(", "the office route asks for a token");
expectSourceContains(officeRoute, "verifySensitiveRequest(", "and the device signs these exact bytes");
expectSourceContains(officeRoute, "requireTrustedDevice(", "which the route refuses without");
expect(
  officeRoute.indexOf("requireTrustedDevice(") < officeRoute.indexOf("JSON.parse("),
  "the proof is checked before the body is parsed, so a doctored body is a proof failure",
);
expectSourceContains(officeRoute, "extendDisputeDeadline(", "the office route calls the one service act");
expectSourceContains(officeRoute, "\"cache-control\": \"no-store\"", "the office answer is never cached");
expectEqual(
  officeRoute.includes("512"),
  true,
  "the extension body has a ceiling of its own rather than the response's",
);
expect(
  !merchantRoute.includes("service_role") && !officeRoute.includes("service_role"),
  "neither route reaches for a privileged key: the service does the reading",
);

/* -------------------------------------------------------------------------------------------------
 * 10. The two screens
 * ---------------------------------------------------------------------------------------------- */

const clockPath = "app/(dashboard)/payments/disputes/[id]/dispute-deadline-clock.tsx";
const formPath = "app/(dashboard)/payments/disputes/[id]/dispute-response-form.tsx";
const answerPath = "app/(dashboard)/payments/disputes/[id]/page.tsx";
const listPath = "app/(dashboard)/payments/disputes/page.tsx";
const officePagePath = "app/(admin)/office/disputes/page.tsx";
const officeFormPath = "app/(admin)/office/disputes/deadline-extension-form.tsx";

const clockSource = await sourceOf(clockPath);
const formSource = await sourceOf(formPath);
const answerSource = await sourceOf(answerPath);
const listSource = await sourceOf(listPath);
const officePageSource = await sourceOf(officePagePath);
const officeFormSource = await sourceOf(officeFormPath);

for (const [path, source] of [
  [clockPath, clockSource],
  [formPath, formSource],
  [answerPath, answerSource],
  [officeFormPath, officeFormSource],
] as const) {
  expect(source.startsWith(`// path: ${path}`), `${path} names its own path on its first line`);
  expectNoPlaceholderMarker(source, path);
  expectSourceLacks(source, "console.", `${path} prints nothing`);
}

expect(clockSource.startsWith("// path: app/(dashboard)/payments/disputes/[id]/dispute-deadline-clock.tsx\n\"use client\";"), "the clock is a client component: only the browser knows the merchant's zone");
expectSourceContains(clockSource, "localDeadlineOf(", "the clock prints the deadline in the merchant's zone");
expectSourceContains(clockSource, "localOffsetShiftOf(", "and reports a zone that moved under the window");
expectSourceContains(clockSource, "disputeRemainingOf(", "with the time left");
expectSourceContains(clockSource, "Intl.DateTimeFormat().resolvedOptions().timeZone", "taken from the browser rather than guessed from the country");
expectSourceContains(clockSource, "utcTextOf(", "and the same instant in UTC beside it, which the server could print");
expectSourceContains(clockSource, "setInterval(", "the countdown ticks");
expectSourceContains(clockSource, "clearInterval(", "and stops when the page goes away");
expectSourceContains(clockSource, "aria-labelledby=", "the panel has a heading and says so");
expectSourceContains(clockSource, "sm:grid-cols-", "the panel is one column on a phone and two on a desk");

expect(
  formSource.startsWith("// path: app/(dashboard)/payments/disputes/[id]/dispute-response-form.tsx\n\"use client\";"),
  "the form is a client component, because saving is a click",
);
expectSourceContains(formSource, "csrfHeaders()", "the form carries a token");
expectSourceContains(formSource, "credentials: \"same-origin\"", "and the session's cookie");
expectSourceContains(formSource, "cache: \"no-store\"", "and asks for a fresh answer");
expectSourceContains(formSource, "/api/payments/disputes/", "it posts to the merchant route");
expectSourceContains(formSource, "router.refresh()", "and re-reads the row after a save, because the deadline may have moved");
expectSourceContains(formSource, "maxLength={DISPUTE_RESPONSE_MAXIMUM_LENGTH}", "the textarea's bound is the column's bound, imported");
expectSourceContains(formSource, "disabled={!editable}", "a frozen dispute cannot be edited by the browser either");
expectSourceContains(formSource, "role=\"status\"", "the outcome of a save is announced");
expectSourceLacks(formSource, "verifySensitiveRequest", "the form carries no proof it cannot produce");
expectSourceLacks(formSource, "response_text: text,", "the body is built once, from the field the service reads");

// STEP 197 moved the page's one read to `readDisputeEvidence`, which asks this STEP's `readCompanyDispute` for
// the row itself and then reads the pack beside it. The rule this assertion exists for - the page reads through
// a service and never through the table - is what both calls serve.
expectSourceContains(
  answerSource,
  "readDisputeEvidence(",
  "the answer page reads through the service and not through the table",
);
expectSourceContains(answerSource, "readOwnerActor(", "using the session the dashboard already has");
expectSourceContains(answerSource, "RESOURCE_NOT_FOUND", "and maps another merchant's dispute to a sentence rather than an empty form");
expectSourceContains(answerSource, "DisputeDeadlineClock", "the page carries the clock");
expectSourceContains(answerSource, "DisputeResponseForm", "and the form");
expectSourceContains(answerSource, "editable={editable}", "in the state the row is in");
expectSourceLacks(answerSource, "process.env", "a page reads no environment of its own");

expectSourceContains(listSource, "/payments/disputes/", "the list links to the answer page");
expectSourceContains(listSource, "responseSavedBadge", "and marks a row whose response is already saved");
expectSourceContains(officePageSource, "DisputeDeadlineExtensionForm", "the office queue carries the extension");
expectSourceContains(
  officePageSource,
  "dispute.responseWindowHours === DISPUTE_DEFAULT_WINDOW_HOURS",
  "the extension is offered only while the window is still 24 hours",
);
expectSourceContains(
  officePageSource,
  "dispute.dueState === \"overdue\" ? (",
  "and never on a row whose window has already closed",
);
expectSourceLacks(officePageSource, "responseText", "the queue prints no merchant's words: that belongs to the pack, not the queue");
expectSourceContains(officeFormSource, "deviceProofHeaders(", "the office form signs the body with the enrolled device");
expectSourceContains(officeFormSource, "deviceProofHeaders(\"POST\", path, payload)", "over the exact bytes it sends");
expectSourceContains(officeFormSource, "csrfHeaders()", "with a token as well");
expectSourceContains(officeFormSource, "/api/office/disputes/", "posting to the office route");
expectSourceContains(officeFormSource, "router.refresh()", "and re-reading the queue after an extension");
expectSourceLacks(officeFormSource, "response_window_hours: 24", "the form never asks to shorten a window");

/* -------------------------------------------------------------------------------------------------
 * 11. Every message the screens ask for exists
 * ---------------------------------------------------------------------------------------------- */

const messagePaths = [
  ...messagePathsIn(clockSource),
  ...messagePathsIn(formSource),
  ...messagePathsIn(answerSource),
  ...messagePathsIn(listSource),
  ...messagePathsIn(officePageSource),
  ...messagePathsIn(officeFormSource),
];

expect(messagePaths.length > 0, "the scan found the messages the screens ask for");

for (const path of [...new Set(messagePaths)].sort()) {
  expectEqual(typeof messageAt(path) === "string", true, `${path} is in the catalogue`);
}

for (const path of [
  "disputes.deadlineLocalLabel",
  "disputes.deadlineUtcLabel",
  "disputes.deadlineShiftedNote",
  "disputes.deadlineClosedNote",
  "disputes.responseSave",
  "disputes.responseSavedDone",
  "disputes.responseDeadlineError",
  "disputes.responseMovedError",
  "disputes.documentsNote",
  "disputes.deadlineExtensionButton",
  "disputes.deadlineExtensionDone",
  "disputes.deadlineExtensionRoleNote",
] as const) {
  const message = messageAt(path);

  expectEqual(typeof message === "string" && message.length > 0, true, `this STEP added ${path}`);
}

expect((messageAt("disputes.deadlineShiftedNote") ?? "").includes("{localHours}"), "the shifted-day sentence takes the hours the dial reads");
expect((messageAt("disputes.deadlineShiftedNote") ?? "").includes("{absoluteHours}"), "and the hours the window is");
expect((messageAt("disputes.responseSavedAt") ?? "").includes("{instant}"), "the saved sentence takes the instant");
expect((messageAt("disputes.windowHoursText") ?? "").includes("{hours}"), "the window sentence takes its hours");
expect(
  (messageAt("disputes.deadlineRemainingDueSoon") ?? "").includes("{hours}") &&
    (messageAt("disputes.deadlineRemainingDueSoon") ?? "").includes("{minutes}"),
  "the countdown takes hours and minutes",
);

/* -------------------------------------------------------------------------------------------------
 * 12. The handoff this STEP must be able to leave behind
 * ---------------------------------------------------------------------------------------------- */

const serviceSuffix = await sourceOf("services/disputes/dispute-response.ts");
const deadlineSuffix = await sourceOf("services/disputes/dispute-deadline.ts");

for (const [path, source] of [
  ["services/disputes/dispute-response.ts", serviceSuffix],
  ["services/disputes/dispute-deadline.ts", deadlineSuffix],
  ["services/disputes/dispute-response-fields.ts", await sourceOf("services/disputes/dispute-response-fields.ts")],
] as const) {
  expect(source.startsWith(`// path: ${path}`), `${path} names its own path`);
  expectNoPlaceholderMarker(source, path);
  expectSourceLacks(source, ": any", `${path} has no any`);
  expectSourceLacks(source, "as any", `${path} casts nothing away`);
  expectSourceLacks(source, "console.", `${path} prints nothing`);
}

expectSourceLacks(serviceSuffix, "payments\",", "the response service writes no payment row");
expectSourceLacks(serviceSuffix, "ledger", "and no ledger: a dispute's response moves no money");
expectSourceLacks(serviceSuffix, "insert(", "a response is an update, never an insert");
expectSourceContains(serviceSuffix, "version=eq.${row.version}", "every write is guarded by the version it read");
expectSourceContains(serviceSuffix, "company_id=eq.", "and every merchant read is scoped to the merchant in the query");
expectSourceContains(serviceSuffix, "hasSatisfiedTwoFactor(", "the extension asks for the second factor");
expectSourceContains(serviceSuffix, "disputeExtensionTarget(", "and for a one-way extension");
expectSourceLacks(deadlineSuffix, "fetch(", "the deadline module reaches no network");
expectSourceLacks(deadlineSuffix, "process.env", "and reads no environment");
expect(
  !deadlineSuffix.includes("new Date()."),
  "every instant it prints is given to it, so a gate can pin the clock",
);

/* -------------------------------------------------------------------------------------------------
 * The verdict
 * ---------------------------------------------------------------------------------------------- */

if (failures.length > 0) {
  process.stderr.write(`dispute response gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `dispute response gate passed: ${String(checkCount)} checks, a response written only inside the 24 hour window, ` +
      "the same deadline in every time zone and a dial that says when it moved, one role that may widen it to 48, " +
      "a frozen response once the pack is sent, a chain that records the length and never the words, and no money moved\n",
  );
}
