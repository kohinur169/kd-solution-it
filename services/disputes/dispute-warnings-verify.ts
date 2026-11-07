// path: services/disputes/dispute-warnings-verify.ts
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
import {
  DISPUTE_AUDIT,
  DISPUTE_WARNING_BATCH_LIMIT,
  DISPUTE_WARNING_MAX_ATTEMPTS,
  DISPUTE_WARNING_REFERENCE_KIND,
  DISPUTE_WARNING_ROLES,
  DISPUTE_WARNING_STAGES,
  DISPUTE_WARNING_TEMPLATE_KEY,
} from "./dispute-fields.ts";
import { disputeMidpointOf, disputeWarningStagesOf } from "./dispute-deadline.ts";
import {
  listDisputeWarnings,
  runDisputeWarningSweep,
  runDisputeWarningsNow,
  type DisputeWarningDependencies,
  type DisputeWarningSweepResult,
} from "./dispute-warnings.ts";
import {
  DISPUTE_WARNING_JOB_NAME,
  createDefaultDisputeWarningJob,
  disputeWarningJobPayloadSchema,
  registerDisputeWarningJob,
  runDisputeWarningJob,
} from "./dispute-warnings-job.ts";

/**
 * The gate for STEP 196: section 19's two warnings, at the start of the deadline window and in its middle.
 *
 * ## What this proves
 *
 *   - **Two stages, decided from the row.** The start is the opening and the midpoint is half the window -
 *     twelve hours into a twenty-four hour one, twenty-four into a forty-eight hour one - and a stage is due
 *     only while the deadline has not passed. An answered dispute, a sent pack and a decided dispute owe
 *     nothing, and a sweep that missed a stage does not send it late.
 *   - **Exactly once, under two sweeps.** `0125`'s three unique keys are re-implemented in the fixture, so a
 *     second sweep sends nothing, a losing sweep drops the email row it wrote with a reason, and one email can
 *     never be the evidence of two warnings.
 *   - **The email system is section 23's, not this STEP's.** The sweep writes `email_send_logs` rows in the
 *     shape `0061` defines - an existing template key, `reference_kind = 'dispute'`, the merchant's own owner
 *     as the recipient - and writes nothing at all when the office has configured no sending method or the
 *     merchant has no owner to tell.
 *   - **Every warning is in the chain**, with the stage, the window and the instants, and never the address.
 *   - **One role set, one second factor, one signed device.** The office's "run it now" asks the same three
 *     questions the compliance calendar's does, and a finance officer, a support agent or a merchant's own
 *     owner cannot mail the platform's customers.
 *   - **The job and the button are the same sweep**, so the clock and the officer can never disagree about when
 *     the middle of a window is.
 *   - **0061 is untouched.** `0125` adds no template key, no column to `email_send_logs` and no column to
 *     `disputes`; the gate asserts all three.
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

// ---------------------------------------------------------------------------------------------
// The fixture: a PostgREST over arrays, with `0125`'s keys, checks and triggers on it.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const ownerUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const officeUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const disputeId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const secondDisputeId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const openedAtMs = Date.parse("2026-11-07T09:00:00.000Z");
const dueAtMs = openedAtMs + 24 * 3_600_000;
const ownerEmail = "owner@merchant.example.com";

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: ownerUserId,
    companyId,
    roles: ["owner"],
    sessionId: "session-0001",
    assuranceLevel: "aal2",
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

interface DisputeOverrides {
  readonly id?: string;
  readonly companyId?: string;
  readonly openedAtMs?: number;
  readonly windowHours?: number;
  readonly dueAtMs?: number;
  readonly responseSavedAt?: string | null;
  readonly submittedAt?: string | null;
  readonly resolvedAt?: string | null;
}

function disputeRow(overrides: DisputeOverrides = {}): Row {
  const opened = overrides.openedAtMs ?? openedAtMs;
  const window = overrides.windowHours ?? 24;

  return {
    id: overrides.id ?? disputeId,
    company_id: overrides.companyId ?? companyId,
    opened_at: new Date(opened).toISOString(),
    response_window_hours: window,
    response_due_at: new Date(overrides.dueAtMs ?? opened + window * 3_600_000).toISOString(),
    response_saved_at: overrides.responseSavedAt ?? null,
    submitted_at: overrides.submittedAt ?? null,
    resolved_at: overrides.resolvedAt ?? null,
    deleted_at: null,
  };
}

interface Fixture {
  readonly rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly disputes: Row[];
  readonly sends: Row[];
  readonly warnings: Row[];
  readonly settings: Row[];
  readonly assignments: Row[];
  readonly users: Row[];
  /** Tables written, in order, so a gate can prove what was touched and what was not. */
  readonly written: string[];
  nowMs: number;
  /** Something that lands between a caller's read and its claim: another sweep, or an extension. */
  beforeClaim: (() => void) | null;
}

interface Query {
  readonly equals: Map<string, string>;
  readonly nulls: Set<string>;
  readonly inLists: Map<string, readonly string[]>;
  readonly upperBounds: Map<string, string>;
  readonly lowerBounds: Map<string, string>;
  readonly order: { readonly column: string; readonly direction: "asc" | "desc" } | null;
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const nulls = new Set<string>();
  const inLists = new Map<string, readonly string[]>();
  const upperBounds = new Map<string, string>();
  const lowerBounds = new Map<string, string>();
  let order: Query["order"] = null;
  let limit: number | null = null;

  for (const part of query.split("&")) {
    const separator = part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);

    if (key === "select") {
      continue;
    }

    if (key === "order") {
      const [column = "", direction = "asc"] = value.split(".");

      order = { column, direction: direction === "desc" ? "desc" : "asc" };
      continue;
    }

    if (key === "limit") {
      limit = Number.parseInt(value, 10);
      continue;
    }

    if (value === "is.null") {
      nulls.add(key);
      continue;
    }

    if (value.startsWith("in.(") && value.endsWith(")")) {
      inLists.set(
        key,
        value
          .slice(4, -1)
          .split(",")
          .map((entry) => decodeURIComponent(entry)),
      );
      continue;
    }

    if (value.startsWith("lte.")) {
      upperBounds.set(key, decodeURIComponent(value.slice(4)));
      continue;
    }

    if (value.startsWith("gt.")) {
      lowerBounds.set(key, decodeURIComponent(value.slice(3)));
      continue;
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, nulls, inLists, upperBounds, lowerBounds, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const column of query.nulls) {
    if (row[column] !== null && row[column] !== undefined) {
      return false;
    }
  }

  for (const [column, values] of query.inLists) {
    if (!values.includes(String(row[column]))) {
      return false;
    }
  }

  for (const [column, bound] of query.upperBounds) {
    if (!(String(row[column]) <= bound)) {
      return false;
    }
  }

  for (const [column, bound] of query.lowerBounds) {
    if (!(String(row[column]) > bound)) {
      return false;
    }
  }

  return true;
}

/** `0125`'s two checks on the instants, and its stage vocabulary. */
function guardWarningRow(fixture: Fixture, row: Row): void {
  const fail = (field: string): never => {
    throw new AppError("CONFLICT", { details: [{ field, rule: "dispute_deadline_warnings_guard" }] });
  };

  const stage = String(row["stage"]);
  const windowHours = Number(row["window_hours"]);
  const opened = String(row["opened_at"]);
  const warnAt = String(row["warn_at"]);
  const dueAt = String(row["due_at"]);

  if (!(DISPUTE_WARNING_STAGES as readonly string[]).includes(stage)) fail("stage");
  if (windowHours !== 24 && windowHours !== 48) fail("window_hours");

  const openedMs = Date.parse(opened);

  if (dueAt !== new Date(openedMs + windowHours * 3_600_000).toISOString()) fail("due_at");

  if (stage === "start" && warnAt !== opened) fail("warn_at");
  if (stage === "midpoint" && warnAt !== new Date(openedMs + Math.trunc(windowHours / 2) * 3_600_000).toISOString()) {
    fail("warn_at");
  }

  if (!(Date.parse(warnAt) >= openedMs && Date.parse(warnAt) < Date.parse(dueAt))) fail("warn_at");
  if (!(Date.parse(String(row["queued_at"])) >= Date.parse(warnAt))) fail("queued_at");

  // `dispute_deadline_warnings_guard_window`: the warning describes the dispute that is there now.
  const dispute = fixture.disputes.find((candidate) => candidate["id"] === row["dispute_id"]);

  if (
    dispute === undefined ||
    dispute["company_id"] !== row["company_id"] ||
    dispute["opened_at"] !== opened ||
    Number(dispute["response_window_hours"]) !== windowHours ||
    dispute["response_due_at"] !== dueAt
  ) {
    fail("dispute_id");
  }

  for (const other of fixture.warnings) {
    if (
      other["dispute_id"] === row["dispute_id"] &&
      other["stage"] === stage &&
      Number(other["window_hours"]) === windowHours
    ) {
      throw new AppError("CONFLICT", { details: [{ field: "stage", rule: "dispute_deadline_warnings_stage_key" }] });
    }

    if (stage === "start" && other["dispute_id"] === row["dispute_id"] && other["stage"] === "start") {
      throw new AppError("CONFLICT", { details: [{ field: "stage", rule: "dispute_deadline_warnings_start_key" }] });
    }

    if (other["send_id"] === row["send_id"]) {
      throw new AppError("CONFLICT", { details: [{ field: "send_id", rule: "dispute_deadline_warnings_send_key" }] });
    }
  }
}

function createFixture(input: {
  readonly disputes: readonly Row[];
  readonly method?: "smtp" | "api" | null;
  readonly owner?: boolean;
}): Fixture {
  const disputes = input.disputes.map((row) => ({ ...row }));
  const sends: Row[] = [];
  const warnings: Row[] = [];
  const settings: Row[] =
    input.method === null || input.method === undefined
      ? []
      : [{ id: "settings-1", method: input.method, status: "active", deleted_at: null }];
  const assignments: Row[] =
    input.owner === false
      ? []
      : [
          {
            id: "assignment-1",
            company_id: companyId,
            user_id: ownerUserId,
            role: "owner",
            granted_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
            deleted_at: null,
          },
        ];
  const users: Row[] = [{ id: ownerUserId, email: ownerEmail, deleted_at: null }];
  const written: string[] = [];
  let ids = 0;

  const table = (name: string): Row[] => {
    switch (name) {
      case "disputes":
        return disputes;
      case "email_send_logs":
        return sends;
      case "dispute_deadline_warnings":
        return warnings;
      case "email_settings":
        return settings;
      case "role_assignments":
        return assignments;
      case "users":
        return users;
      default:
        throw new AppError("DEPENDENCY_FAILED");
    }
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      let rows = table(name).filter((row) => matches(row, parsed));

      if (parsed.order !== null) {
        const { column, direction } = parsed.order;

        rows = [...rows].sort((left, right) => {
          const a = String(left[column] ?? "");
          const b = String(right[column] ?? "");

          return direction === "asc" ? a.localeCompare(b) : b.localeCompare(a);
        });
      }

      if (parsed.limit !== null) {
        rows = rows.slice(0, parsed.limit);
      }

      return schema.array().parse(rows);
    },

    async insert(name: string, rows: readonly Row[]): Promise<void> {
      written.push(name);

      for (const row of rows) {
        if (name === "dispute_deadline_warnings") {
          const interference = fixture.beforeClaim;

          fixture.beforeClaim = null;
          interference?.();
          guardWarningRow(fixture, row);
          warnings.push({ ...row });
          continue;
        }

        table(name).push({ ...row });
      }
    },

    async insertReturning<TRow>(name: string, rows: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      written.push(name);
      const returned: Row[] = [];

      for (const row of rows) {
        if (name === "email_send_logs") {
          if (row["template_key"] !== DISPUTE_WARNING_TEMPLATE_KEY) {
            throw new AppError("VALIDATION_FAILED", { details: [{ field: "template_key", rule: "check" }] });
          }

          if (String(row["subject"] ?? "").length > 160) {
            throw new AppError("VALIDATION_FAILED", { details: [{ field: "subject", rule: "check" }] });
          }

          if (row["provider"] !== "smtp" && row["provider"] !== "api") {
            throw new AppError("VALIDATION_FAILED", { details: [{ field: "provider", rule: "check" }] });
          }

          if ((row["reference_kind"] === undefined) !== (row["reference_id"] === undefined)) {
            throw new AppError("VALIDATION_FAILED", { details: [{ field: "reference_kind", rule: "check" }] });
          }
        }

        ids += 1;
        const complete: Row = {
          id: `send-${String(ids).padStart(4, "0")}`,
          status: "queued",
          attempts: 0,
          sent_at: null,
          failure_reason: null,
          ...row,
        };

        sends.push(complete);
        returned.push(complete);
      }

      return schema.array().parse(returned);
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      written.push(name);

      if (name === "dispute_deadline_warnings") {
        // `dispute_deadline_warnings_guard_append_only`: every update is refused.
        throw new AppError("CONFLICT", { details: [{ field: "id", rule: "dispute_deadline_warnings_guard_append_only" }] });
      }

      const parsed = parseQuery(query);

      for (const row of table(name).filter((candidate) => matches(candidate, parsed))) {
        Object.assign(row, values);
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED");
    },
  };

  const fixture: Fixture = {
    rest,
    audit: createInMemoryAuditTrail(),
    disputes,
    sends,
    warnings,
    settings,
    assignments,
    users,
    written,
    nowMs: openedAtMs + 60_000,
    beforeClaim: null,
  };

  return fixture;
}

function dependenciesOf(fixture: Fixture): DisputeWarningDependencies {
  return { rest: fixture.rest, audit: fixture.audit, now: () => fixture.nowMs };
}

function actionsOf(fixture: Fixture): readonly string[] {
  return fixture.audit.entries.map((entry) => entry.action);
}

function sweepOf(result: DisputeWarningSweepResult): string {
  return `${String(result.due)}/${String(result.sent)}/${String(result.skipped.already_sent)}/${String(
    result.skipped.sender_not_configured,
  )}/${String(result.skipped.no_owner)}/${String(result.skipped.failed)}/${String(result.skipped.superseded)}`;
}

// ---------------------------------------------------------------------------------------------
// Sources
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

const PLACEHOLDER_MARKERS: readonly string[] = Object.freeze([["TO", "DO"].join(""), ["FIX", "ME"].join("")]);

/** The two shapes this gate refuses in shipped code, spelled in halves so it does not carry them itself. */
const ANY_CAST = [": a", "ny"].join("");
const CONSOLE_CALL = ["cons", "ole."].join("");

function expectNoPlaceholderMarker(source: string, description: string): void {
  for (const marker of PLACEHOLDER_MARKERS) {
    expect(!source.includes(marker), `${description} carries no ${marker}`);
  }
}

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
 * 1. The migration, its rollback, and what it must not touch
 * ---------------------------------------------------------------------------------------------- */

const migrationsDirectory = "migrations";

async function migrationNumbers(): Promise<readonly number[]> {
  const names = await readdir(migrationsDirectory);

  return names
    .filter((name) => /^\d{4}_.*\.sql$/u.test(name) && !name.endsWith(".down.sql"))
    .map((name) => Number.parseInt(name.slice(0, 4), 10))
    .sort((left, right) => left - right);
}

const upstream = await readFile(`${migrationsDirectory}/0125_dispute_deadline_warnings.sql`, "utf8");
const rollback = await readFile(`${migrationsDirectory}/0125_dispute_deadline_warnings.down.sql`, "utf8");
const sendLogSchema = await readFile(`${migrationsDirectory}/0061_email_send_logs.sql`, "utf8");
const disputeSchema = await readFile(`${migrationsDirectory}/0039_disputes.sql`, "utf8");

expect(upstream.startsWith("-- path: migrations/0125_dispute_deadline_warnings.sql"), "0125 names its own path");
expectSourceContains(upstream, "create table public.dispute_deadline_warnings", "0125 creates the warning record");
expectSourceContains(
  upstream,
  "create unique index dispute_deadline_warnings_stage_key",
  "one warning per stage per window",
);
expectSourceContains(
  upstream,
  "where stage = 'start'",
  "and one start warning per dispute for its whole life, whatever the window became",
);
expectSourceContains(upstream, "create unique index dispute_deadline_warnings_send_key", "one email cannot claim two warnings");
expectSourceContains(upstream, "make_interval(hours => (window_hours / 2))", "the midpoint is half the window, in SQL");
expectSourceContains(upstream, "make_interval(hours => window_hours)", "and the deadline is the whole window");
expectSourceContains(upstream, "queued_at >= warn_at", "a warning is never queued before it is due");
expectSourceContains(upstream, "dispute_deadline_warnings_guard_window", "the window a warning describes is verified");
expectSourceContains(
  upstream,
  "dispute_deadline_warnings_guard_append_only",
  "and the row is history that cannot be rewritten",
);
expectSourceContains(upstream, "enable row level security", "the table is closed by default");
expectSourceContains(upstream, "using (false)", "and its policy refuses every reader without the service role");

expect(
  !upstream.includes("alter table public.email_send_logs"),
  "0125 does not alter the section 23 send log: its twenty template keys are STEP 032's",
);
expect(
  !upstream.includes("alter table public.disputes"),
  "and does not alter the dispute: warning is not a state of one",
);
expect(
  sendLogSchema.includes(`'${DISPUTE_WARNING_TEMPLATE_KEY}'`),
  "the template key a warning uses is one `0061` already accepts",
);
expect(
  sendLogSchema.includes(`'${DISPUTE_WARNING_REFERENCE_KIND}'`),
  "and so is the reference kind it points the email at",
);
expect(disputeSchema.includes("response_due_at timestamptz not null"), "the deadline a warning is about is `0039`'s column");

expectSourceContains(rollback, "drop table if exists public.dispute_deadline_warnings", "the rollback drops the table");
expect(
  rollback.indexOf("drop trigger if exists dispute_deadline_warnings_guard_append_only") <
    rollback.indexOf("drop table if exists public.dispute_deadline_warnings"),
  "after the triggers that point at it",
);
expect(
  rollback.indexOf("drop table if exists public.dispute_deadline_warnings") <
    rollback.indexOf("drop function if exists public.dispute_deadline_warnings_guard_window()"),
  "and before the functions it calls",
);
expect(!rollback.includes("drop table if exists public.email_send_logs"), "the rollback leaves the send log alone");
expect(!rollback.includes("drop table if exists public.disputes"), "and the dispute with it");

const numbers = await migrationNumbers();

expectEqual(numbers[numbers.length - 1] ?? 0, 125, "0125 is the newest migration in the chain");
expectEqual(numbers.length, 125, "and the chain is 125 files");
expectEqual(
  numbers.every((value, index) => value === index + 1),
  true,
  "the chain is contiguous from 0001 to 0125",
);
expectEqual(new Set(numbers).size, numbers.length, "no migration number is used twice");

/* -------------------------------------------------------------------------------------------------
 * 2. The stage rule, without a database
 * ---------------------------------------------------------------------------------------------- */

expectEqual(disputeMidpointOf(openedAtMs, 24), openedAtMs + 12 * 3_600_000, "a 24 hour window's middle is hour 12");
expectEqual(disputeMidpointOf(openedAtMs, 48), openedAtMs + 24 * 3_600_000, "a 48 hour window's middle is hour 24");
expectEqual(disputeMidpointOf(openedAtMs, 12), openedAtMs + 12 * 3_600_000, "a window the schema refuses falls back to 24 hours");

const facts24 = { openedAtEpochMs: openedAtMs, dueAtEpochMs: dueAtMs, windowHours: 24, resolved: false, submitted: false, answered: false };

expectEqual(disputeWarningStagesOf(facts24, openedAtMs - 1).length, 0, "before the window opens, nothing is due");
expectEqual(disputeWarningStagesOf(facts24, openedAtMs).join(","), "start", "at the opening, the start warning is due");
expectEqual(
  disputeWarningStagesOf(facts24, openedAtMs + 12 * 3_600_000 - 1).join(","),
  "start",
  "a minute before the middle, still only the start",
);
expectEqual(
  disputeWarningStagesOf(facts24, openedAtMs + 12 * 3_600_000).join(","),
  "start,midpoint",
  "at the middle, both are due - and a sweep that missed the start sends both",
);
expectEqual(disputeWarningStagesOf(facts24, dueAtMs).length, 0, "at the deadline the window is closed and nothing is due");
expectEqual(disputeWarningStagesOf(facts24, dueAtMs + 3_600_000).length, 0, "a stage that was missed is not sent late");
expectEqual(
  disputeWarningStagesOf({ ...facts24, answered: true }, openedAtMs + 13 * 3_600_000).length,
  0,
  "a merchant who has already answered is not nudged",
);
expectEqual(
  disputeWarningStagesOf({ ...facts24, submitted: true }, openedAtMs).length,
  0,
  "a sent pack needs no warning: the response is evidence now",
);
expectEqual(
  disputeWarningStagesOf({ ...facts24, resolved: false, dueAtEpochMs: openedAtMs + 48 * 3_600_000, windowHours: 48 }, openedAtMs + 12 * 3_600_000).join(","),
  "start",
  "on an extended window, hour 12 is not the middle any more",
);
expectEqual(
  disputeWarningStagesOf({ ...facts24, dueAtEpochMs: openedAtMs + 48 * 3_600_000, windowHours: 48 }, openedAtMs + 24 * 3_600_000).join(","),
  "start,midpoint",
  "hour 24 is",
);
expectEqual(DISPUTE_WARNING_STAGES.join(","), "start,midpoint", "there are exactly two warnings");

/* -------------------------------------------------------------------------------------------------
 * 3. The sweep: the two stages, once each
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });
  const result = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(result.considered, 1, "the sweep considered the one open dispute");
  expectEqual(result.due, 1, "and found one stage due");
  expectEqual(result.sent, 1, "which it sent");
  expectEqual(fixture.sends.length, 1, "one email was queued");
  expectEqual(fixture.warnings.length, 1, "and one warning recorded");
  expectEqual(fixture.warnings[0]?.["stage"], "start", "the start warning");
  expectEqual(fixture.warnings[0]?.["warn_at"], new Date(openedAtMs).toISOString(), "due at the opening itself");
  expectEqual(fixture.warnings[0]?.["due_at"], new Date(dueAtMs).toISOString(), "about the deadline the row holds");
  expectEqual(fixture.warnings[0]?.["window_hours"], 24, "about the 24 hour window");
  expectEqual(fixture.warnings[0]?.["company_id"], companyId, "under the merchant's own company");
  expectEqual(fixture.sends[0]?.["template_key"], DISPUTE_WARNING_TEMPLATE_KEY, "as a `dispute_update` email");
  expectEqual(fixture.sends[0]?.["reference_kind"], DISPUTE_WARNING_REFERENCE_KIND, "that points at the dispute");
  expectEqual(fixture.sends[0]?.["reference_id"], disputeId, "which is the row it is about");
  expectEqual(fixture.sends[0]?.["recipient_email"], ownerEmail, "to the merchant's own owner");
  expectEqual(fixture.sends[0]?.["recipient_user_id"], ownerUserId, "who is a person, not an address");
  expectEqual(fixture.sends[0]?.["provider"], "smtp", "through the sending method the office made active");
  expectEqual(fixture.sends[0]?.["max_attempts"], DISPUTE_WARNING_MAX_ATTEMPTS, "with the platform's retry ceiling");
  expectEqual(fixture.sends[0]?.["status"], "queued", "and nothing more: this STEP does not send email");
  expectEqual(fixture.sends[0]?.["subject"], messageAt("email.disputeWarning.startSubject"), "the subject is the catalogue's");
  expectEqual(actionsOf(fixture).join(","), DISPUTE_AUDIT.warningSent, "one chain entry, for the one warning");
  expectEqual(fixture.written.includes("disputes"), false, "the sweep wrote no dispute");

  const payload = (fixture.audit.entries[0] as unknown as { payload: Record<string, unknown> }).payload;

  expectEqual(
    Object.keys(payload).sort().join(","),
    "due_at,recipient_user_id,send_id,stage,warn_at,window_hours",
    "the entry carries six facts and nothing else",
  );
  expectEqual(payload["stage"], "start", "the entry names the stage");
  expectEqual(payload["window_hours"], 24, "and the window");
  expectEqual(payload["due_at"], new Date(dueAtMs).toISOString(), "and the deadline the merchant was told about");
  expectEqual(payload["recipient_user_id"], ownerUserId, "and who it went to");
  expectEqual(JSON.stringify(payload).includes(ownerEmail), false, "but never the address");
}

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "api" });
  const first = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(sweepOf(first), "1/1/0/0/0/0/0", "the first sweep sends the start");
  expectEqual(fixture.sends[0]?.["provider"], "api", "through the api method when that is the active one");

  const second = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(sweepOf(second), "1/0/1/0/0/0/0", "the second sweep finds the stage due and already sent");
  expectEqual(fixture.sends.length, 1, "and sends no second email");
  expectEqual(fixture.warnings.length, 1, "and records no second warning");
  expectEqual(actionsOf(fixture).length, 1, "and logs nothing twice");
}

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

  await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));
  fixture.nowMs = openedAtMs + 12 * 3_600_000;

  const second = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(sweepOf(second), "2/1/1/0/0/0/0", "at the middle the midpoint is the one new stage");
  expectEqual(fixture.warnings.length, 2, "the dispute now carries both warnings");
  expectEqual(fixture.warnings[1]?.["stage"], "midpoint", "the second is the middle");
  expectEqual(fixture.warnings[1]?.["warn_at"], new Date(openedAtMs + 12 * 3_600_000).toISOString(), "due at hour twelve");
  expectEqual(fixture.sends[1]?.["subject"], messageAt("email.disputeWarning.midpointSubject"), "with its own subject");
  expectEqual(actionsOf(fixture).length, 2, "and its own chain entry");
}

{
  // An extended window: the start already went out at hour 0 of the 24 hour window, and the middle moves.
  const extended = disputeRow({ windowHours: 48 });
  const fixture = createFixture({ disputes: [extended], method: "smtp" });

  // The dispute is read at hour 12 with its 48 hour deadline, which is the state after an extension.
  fixture.nowMs = openedAtMs + 12 * 3_600_000;

  const first = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(first.sent, 1, "hour twelve of a 48 hour window sends only the start");
  expectEqual(fixture.warnings[0]?.["stage"], "start", "and it is the start");

  fixture.nowMs = openedAtMs + 24 * 3_600_000;

  const second = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(second.sent, 1, "hour twenty-four sends the middle");
  expectEqual(fixture.warnings[1]?.["warn_at"], new Date(openedAtMs + 24 * 3_600_000).toISOString(), "due at the new middle");
  expectEqual(fixture.warnings[1]?.["window_hours"], 48, "about the 48 hour window");
}

/* -------------------------------------------------------------------------------------------------
 * 4. Who is written to, and who is never read
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture({ disputes: [disputeRow()], method: null });
  const result = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(sweepOf(result), "1/0/0/1/0/0/0", "no active sending method means the warning is not queued");
  expectEqual(fixture.sends.length, 0, "no email row is written for a platform that cannot send");
  expectEqual(fixture.warnings.length, 0, "and nothing is claimed, so the tick after the office configures one still sends it");
  expectEqual(actionsOf(fixture).length, 0, "and nothing is logged as if it had been sent");
}

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp", owner: false });
  const result = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(sweepOf(result), "1/0/0/0/1/0/0", "a merchant with no live owner is not guessed at");
  expectEqual(fixture.sends.length, 0, "no email is addressed to somebody who is not the owner");
  expectEqual(fixture.warnings.length, 0, "and nothing is claimed");
}

{
  const fixture = createFixture({
    disputes: [
      disputeRow(),
      disputeRow({ id: secondDisputeId, responseSavedAt: new Date(openedAtMs + 3_600_000).toISOString() }),
      disputeRow({
        id: "99999999-9999-4999-8999-999999999999",
        submittedAt: new Date(openedAtMs + 3_600_000).toISOString(),
      }),
      disputeRow({
        id: "88888888-8888-4888-8888-888888888888",
        resolvedAt: new Date(openedAtMs + 3_600_000).toISOString(),
      }),
      disputeRow({ openedAtMs: openedAtMs - 48 * 3_600_000, id: "77777777-7777-4777-8777-777777777777" }),
      disputeRow({ id: "66666666-6666-4666-8666-666666666666", companyId: otherCompanyId }),
    ],
    method: "smtp",
  });
  fixture.nowMs = openedAtMs + 13 * 3_600_000;

  const result = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  // The sent, decided and closed rows are excluded by the query; the answered one is read and owes nothing.
  expectEqual(result.considered, 3, "only windows that are still open are read, across both merchants");
  expectEqual(result.sent, 2, "and the one merchant with an owner was owed both stages at hour thirteen");
  expectEqual(
    [...new Set(fixture.warnings.map((row) => row["dispute_id"]))].join(","),
    disputeId,
    "the answered dispute was not nudged, and a warning is not sent to a merchant with no owner",
  );
}

{
  const fixture = createFixture({
    disputes: [disputeRow(), disputeRow({ id: secondDisputeId, companyId: otherCompanyId })],
    method: "smtp",
  });
  // The other merchant has its own owner and address.
  fixture.assignments.push({
    id: "assignment-2",
    company_id: otherCompanyId,
    user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role: "owner",
    granted_at: "2026-01-01T00:00:00.000Z",
    revoked_at: null,
    deleted_at: null,
  });
  fixture.users.push({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "other@merchant.example.com",
    deleted_at: null,
  });

  const one = await runDisputeWarningSweep({ companyId: otherCompanyId }, dependenciesOf(fixture));

  expectEqual(one.considered, 1, "a company sweep reads one merchant");
  expectEqual(fixture.sends[0]?.["recipient_email"], "other@merchant.example.com", "and writes to that merchant's owner");
  expectEqual(fixture.warnings[0]?.["company_id"], otherCompanyId, "under that merchant's company");

  const all = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(all.considered, 2, "the platform sweep reads both");
  expectEqual(fixture.sends.length, 2, "and sends the other merchant's warning once, not twice");
}

/* -------------------------------------------------------------------------------------------------
 * 5. The race, and the window that moved
 * ---------------------------------------------------------------------------------------------- */

{
  // Another sweep claims the same stage between this call's read and its claim.
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

  fixture.beforeClaim = (): void => {
    fixture.warnings.push({
      id: "warning-other",
      company_id: companyId,
      dispute_id: disputeId,
      stage: "start",
      window_hours: 24,
      opened_at: new Date(openedAtMs).toISOString(),
      warn_at: new Date(openedAtMs).toISOString(),
      due_at: new Date(dueAtMs).toISOString(),
      send_id: "send-other",
      queued_at: new Date(openedAtMs + 1_000).toISOString(),
    });
  };

  const result = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(sweepOf(result), "1/0/1/0/0/0/0", "a lost claim is reported as already sent rather than retried");
  expectEqual(fixture.sends.length, 1, "the losing sweep wrote one email row");
  expectEqual(fixture.sends[0]?.["status"], "dropped", "and dropped it");
  expectEqual(fixture.sends[0]?.["failure_reason"] !== null, true, "with a reason `0061` accepts");
  expectEqual(String(fixture.sends[0]?.["failure_reason"]).length <= 280, true, "inside the column's bound");
  expectEqual(fixture.warnings.length, 1, "and the merchant has one warning, not two");
  expectEqual(actionsOf(fixture).length, 0, "and nothing was logged as sent");
}

{
  // The super administrator extends the window between the sweep's read and its claim.
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

  fixture.nowMs = openedAtMs + 12 * 3_600_000;
  fixture.beforeClaim = (): void => {
    const dispute = fixture.disputes[0];

    if (dispute !== undefined) {
      dispute["response_window_hours"] = 48;
      dispute["response_due_at"] = new Date(openedAtMs + 48 * 3_600_000).toISOString();
    }
  };

  const result = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(result.skipped.superseded, 2, "both stages were due, and both are refused by `0125` as about a window that moved");
  expectEqual(result.sent, 0, "and nothing is claimed");
  expectEqual(fixture.sends[0]?.["status"], "dropped", "the email rows it wrote are dropped");
  expectEqual(fixture.sends[1]?.["status"], "dropped", "every one of them");
  expectEqual(
    fixture.sends[0]?.["failure_reason"],
    "The dispute's window changed before the warning was recorded.",
    "with the reason the operator needs",
  );

  // The next tick reads the 48 hour window and plans the start against it.
  const again = await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  expectEqual(again.sent, 1, "and the next tick sends the start for the window that exists");
  expectEqual(fixture.warnings[0]?.["window_hours"], 48, "about the 48 hour window");
}

/* -------------------------------------------------------------------------------------------------
 * 6. The rules the database enforces, proven through the fixture
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

  await expectRefusal(
    async () =>
      fixture.rest.insert("dispute_deadline_warnings", [
        {
          company_id: otherCompanyId,
          dispute_id: disputeId,
          stage: "start",
          window_hours: 24,
          opened_at: new Date(openedAtMs).toISOString(),
          warn_at: new Date(openedAtMs).toISOString(),
          due_at: new Date(dueAtMs).toISOString(),
          send_id: "send-x",
          queued_at: new Date(openedAtMs).toISOString(),
        },
      ]),
    "CONFLICT",
    "a warning under the wrong merchant is refused",
  );

  await expectRefusal(
    async () =>
      fixture.rest.insert("dispute_deadline_warnings", [
        {
          company_id: companyId,
          dispute_id: disputeId,
          stage: "midpoint",
          window_hours: 24,
          opened_at: new Date(openedAtMs).toISOString(),
          warn_at: new Date(openedAtMs + 6 * 3_600_000).toISOString(),
          due_at: new Date(dueAtMs).toISOString(),
          send_id: "send-y",
          queued_at: new Date(openedAtMs + 6 * 3_600_000).toISOString(),
        },
      ]),
    "CONFLICT",
    "a midpoint that is not half the window is refused",
  );

  await expectRefusal(
    async () =>
      fixture.rest.insert("dispute_deadline_warnings", [
        {
          company_id: companyId,
          dispute_id: disputeId,
          stage: "start",
          window_hours: 24,
          opened_at: new Date(openedAtMs).toISOString(),
          warn_at: new Date(openedAtMs).toISOString(),
          due_at: new Date(dueAtMs + 3_600_000).toISOString(),
          send_id: "send-z",
          queued_at: new Date(openedAtMs).toISOString(),
        },
      ]),
    "CONFLICT",
    "a deadline that is not the opening plus the window is refused",
  );

  await expectRefusal(
    async () =>
      fixture.rest.update("dispute_deadline_warnings", "id=eq.warning-1", { stage: "midpoint" }),
    "CONFLICT",
    "a warning is never rewritten",
  );
}

/* -------------------------------------------------------------------------------------------------
 * 7. The office's "run it now"
 * ---------------------------------------------------------------------------------------------- */

{
  for (const role of ["ceo", "compliance_kyc", "super_admin"] as const) {
    const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });
    const result = await runDisputeWarningsNow({ actor: officeActor(role) }, dependenciesOf(fixture));

    expectEqual(result.sent, 1, `${role} may send the warnings that are due`);
  }

  for (const role of ["finance_ops", "support", "owner"] as const) {
    const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

    await expectRefusal(
      () => runDisputeWarningsNow({ actor: officeActor(role) }, dependenciesOf(fixture)),
      "PERMISSION_DENIED",
      `${role} may not mail the platform's merchants`,
    );
    expectEqual(fixture.sends.length, 0, `and ${role} sent nothing`);
  }

  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

  await expectRefusal(
    () => runDisputeWarningsNow({ actor: officeActor("ceo", false) }, dependenciesOf(fixture)),
    "PERMISSION_DENIED",
    "a chief executive without a satisfied second factor is refused",
  );

  const scoped = createFixture({ disputes: [disputeRow()], method: "smtp" });
  const one = await runDisputeWarningsNow({ actor: officeActor("super_admin"), companyId }, dependenciesOf(scoped));

  expectEqual(one.considered, 1, "the office may sweep one merchant");
  expectEqual(DISPUTE_WARNING_ROLES.length, 3, "three roles answer for merchant correspondence");
}

/* -------------------------------------------------------------------------------------------------
 * 8. The read the queue prints
 * ---------------------------------------------------------------------------------------------- */

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });

  await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));
  fixture.nowMs = openedAtMs + 12 * 3_600_000;
  await runDisputeWarningSweep({ companyId: null }, dependenciesOf(fixture));

  const warnings = await listDisputeWarnings({ disputeIds: [disputeId, secondDisputeId] }, dependenciesOf(fixture));
  const records = warnings.get(disputeId) ?? [];

  expectEqual(records.length, 2, "the queue reads both warnings of a dispute");
  expectEqual(records[0]?.stage, "start", "in the order they were due");
  expectEqual(records[1]?.stage, "midpoint", "start first, then the middle");
  expectEqual(records[1]?.dueAt, new Date(dueAtMs).toISOString(), "each carrying the deadline it was about");
  expectEqual(warnings.has(secondDisputeId), false, "a dispute with no warnings is absent rather than empty");
  expectEqual((await listDisputeWarnings({ disputeIds: [] }, dependenciesOf(fixture))).size, 0, "no ids means no query");
}

/* -------------------------------------------------------------------------------------------------
 * 9. The job: one sweep, two payloads
 * ---------------------------------------------------------------------------------------------- */

expectEqual(DISPUTE_WARNING_JOB_NAME, "dispute.deadline_warnings", "the job has the name the schedule will use");
expectEqual(disputeWarningJobPayloadSchema.safeParse({}).success, true, "the platform tick carries nothing");
expectEqual(disputeWarningJobPayloadSchema.safeParse({ company_id: companyId }).success, true, "a company tick names one merchant");
expectEqual(disputeWarningJobPayloadSchema.safeParse({ company_id: "not-a-uuid" }).success, false, "a malformed id is refused");
expectEqual(disputeWarningJobPayloadSchema.safeParse({ stage: "start" }).success, false, "and a payload that would argue about the stage");
expectEqual(DISPUTE_WARNING_BATCH_LIMIT > 0, true, "one tick reads a bounded page of disputes");

{
  const platform = createFixture({ disputes: [disputeRow()], method: "smtp" });
  const result = await runDisputeWarningJob({}, dependenciesOf(platform));

  expectEqual(result.sent, 1, "the platform payload sweeps every merchant");

  const scoped = createFixture({ disputes: [disputeRow({ companyId: otherCompanyId })], method: "smtp" });
  const none = await runDisputeWarningJob({ company_id: companyId }, dependenciesOf(scoped));

  expectEqual(none.considered, 0, "a company payload sweeps only that merchant");
  expectEqual(scoped.sends.length, 0, "so another merchant's dispute is not mailed from it");
}

{
  const fixture = createFixture({ disputes: [disputeRow()], method: "smtp" });
  const definition = createDefaultDisputeWarningJob();

  expectEqual(definition.name, DISPUTE_WARNING_JOB_NAME, "the default instance registers the same name");
  expectEqual(typeof definition.handler, "function", "and carries a handler");

  const registry = new (await import("../../lib/jobs/registry.ts")).JobRegistry();

  registerDisputeWarningJob(registry, () => dependenciesOf(fixture));
  registerDisputeWarningJob(registry, () => dependenciesOf(fixture));

  expectEqual(registry.size, 1, "registering twice registers one job");
  expectEqual(registry.has(DISPUTE_WARNING_JOB_NAME), true, "and it is the warning sweep");
  expectEqual(
    definition.payloadSchema.safeParse({ company_id: companyId, extra: true }).success,
    false,
    "the registered schema is strict",
  );
}

/* -------------------------------------------------------------------------------------------------
 * 10. The route
 * ---------------------------------------------------------------------------------------------- */

const routePath = "app/api/office/disputes/warnings/route.ts";
const routeSource = await sourceOf(routePath);

expect(routeSource.startsWith("// path: app/api/office/disputes/warnings/route.ts"), "the route names its path");
expect(CSRF_PROTECTED_PATHS.includes("/api/office/disputes/warnings"), "the route is on the CSRF list");
expect(routeSource.indexOf("requireCsrfToken(") > 0, "and it asks for a token");
expect(
  routeSource.indexOf("requireCsrfToken(") < routeSource.indexOf("readRequestActor("),
  "before it reads the session",
);
expectSourceContains(routeSource, "verifySensitiveRequest(", "the browser signs these exact bytes");
expectSourceContains(routeSource, "requireTrustedDevice(", "which the route refuses without");
expect(
  routeSource.indexOf("requireTrustedDevice(") < routeSource.indexOf("JSON.parse("),
  "and checks before it parses, so an altered body is a proof failure",
);
expectSourceContains(routeSource, "runDisputeWarningsNow(", "the route calls the one sweep");
expectSourceContains(routeSource, "DISPUTE_WARNINGS_MAXIMUM_BODY_BYTES", "with a ceiling of its own");
expectSourceContains(routeSource, "512", "of half a kilobyte");
expectSourceContains(routeSource, "\"cache-control\": \"no-store\"", "and an answer that is never cached");
expectSourceContains(routeSource, "export const dynamic = \"force-dynamic\"", "on a route that is never static");
expectSourceLacks(routeSource, CONSOLE_CALL, "nothing is printed from a route");
expectSourceContains(routeSource, "sent: result.sent", "the log line carries the counts");
expectSourceLacks(routeSource, "recipient_email", "and never an address");

/* -------------------------------------------------------------------------------------------------
 * 11. The two screens
 * ---------------------------------------------------------------------------------------------- */

const panelPath = "app/(admin)/office/disputes/warning-run-panel.tsx";
const pagePath = "app/(admin)/office/disputes/page.tsx";
const panelSource = await sourceOf(panelPath);
const pageSource = await sourceOf(pagePath);

expect(panelSource.startsWith("// path: app/(admin)/office/disputes/warning-run-panel.tsx\n\"use client\";"), "the panel is a client component");
expectSourceContains(panelSource, "deviceProofHeaders(", "the panel signs the request with the enrolled device");
expectSourceContains(panelSource, "csrfHeaders()", "and carries a token");
expectSourceContains(panelSource, "credentials: \"same-origin\"", "and the session's cookie");
expectSourceContains(panelSource, "cache: \"no-store\"", "and asks for a fresh answer");
expectSourceContains(panelSource, "/api/office/disputes/warnings", "posting to the sweep route");
expectSourceContains(panelSource, "router.refresh()", "and re-reading the queue after a sweep");
expectSourceContains(panelSource, "role=\"status\"", "the outcome is announced");
expectNoPlaceholderMarker(panelSource, panelPath);
expectNoPlaceholderMarker(pageSource, pagePath);
expectSourceLacks(panelSource, CONSOLE_CALL, "the panel prints nothing");

expectSourceContains(pageSource, "DisputeWarningRunPanel", "the queue carries the run-it-now panel");
expectSourceContains(pageSource, "listDisputeWarnings(", "and reads the warnings once for the page");
expectSourceContains(pageSource, "DISPUTE_WARNING_ROLES", "offering the panel to the roles that may use it");
expectSourceContains(pageSource, "warningRowLabel", "and printing a line per row");
expectSourceContains(
  pageSource,
  "warningTextOf(state.warnings.get(dispute.id))",
  "which renders the two warnings the read returned, not a placeholder",
);
expectSourceContains(pageSource, "mayWarn", "with the offer decided per officer");
expectSourceLacks(pageSource, "recipient_email", "the queue prints no address");
expectSourceContains(panelSource, "sm:", "the panel holds at a phone width as well as a desk");
expectSourceContains(pageSource, "sm:grid-cols-", "and so does the row it sits beside");

/* -------------------------------------------------------------------------------------------------
 * 12. Every message the screens ask for exists
 * ---------------------------------------------------------------------------------------------- */

const messagePaths = [...new Set([...messagePathsIn(panelSource), ...messagePathsIn(pageSource)])].sort();

expect(messagePaths.length > 0, "the scan found the messages the screens ask for");

for (const path of messagePaths) {
  expectEqual(typeof messageAt(path) === "string", true, `${path} is in the catalogue`);
}

for (const path of [
  "disputes.warningRowLabel",
  "disputes.warningNone",
  "disputes.warningStartSent",
  "disputes.warningMidpointSent",
  "disputes.warningRunTitle",
  "disputes.warningRunButton",
  "disputes.warningRunDone",
  "disputes.warningRunBlocked",
  "disputes.warningRunNothing",
  "disputes.warningRunRoleNote",
  "email.disputeWarning.startSubject",
  "email.disputeWarning.midpointSubject",
] as const) {
  const message = messageAt(path);

  expectEqual(typeof message === "string" && message.length > 0, true, `this STEP added ${path}`);
}

expect((messageAt("email.disputeWarning.startSubject") ?? "").length <= 160, "a subject fits the column `0061` gives it");
expect((messageAt("email.disputeWarning.midpointSubject") ?? "").length <= 160, "both of them");
expect((messageAt("disputes.warningStartSent") ?? "").includes("{instant}"), "the row line takes the instant");
expect(
  (messageAt("disputes.warningRunDone") ?? "").includes("{sent}") &&
    (messageAt("disputes.warningRunDone") ?? "").includes("{blocked}"),
  "the panel's answer takes its two counts",
);

/* -------------------------------------------------------------------------------------------------
 * 13. The service's own discipline
 * ---------------------------------------------------------------------------------------------- */

const serviceSource = await sourceOf("services/disputes/dispute-warnings.ts");
const jobSource = await sourceOf("services/disputes/dispute-warnings-job.ts");

for (const [path, source] of [
  ["services/disputes/dispute-warnings.ts", serviceSource],
  ["services/disputes/dispute-warnings-job.ts", jobSource],
  ["services/disputes/dispute-warnings-verify.ts", await sourceOf("services/disputes/dispute-warnings-verify.ts")],
] as const) {
  expect(source.startsWith(`// path: ${path}`), `${path} names its own path`);
  expectNoPlaceholderMarker(source, path);
  expectSourceLacks(source, ANY_CAST, `${path} has no any`);
  expectSourceLacks(source, CONSOLE_CALL, `${path} prints nothing`);
}

expectSourceContains(serviceSource, "isConflictError(", "a lost claim is recognised rather than thrown at a merchant");
expectSourceContains(serviceSource, "status: \"dropped\"", "and the email row that lost it is dropped, not deleted");
expectSourceContains(serviceSource, "reference_kind: DISPUTE_WARNING_REFERENCE_KIND", "every email points at its dispute");
expectSourceContains(serviceSource, "reference_id: planned.dispute.id", "and at nothing else");
expectSourceLacks(serviceSource, "smtp.send", "this STEP sends no email itself");
expectSourceLacks(serviceSource, "\"payments\"", "and touches no payment table: a warning moves no money");
expectSourceLacks(serviceSource, "disputes\", \"id=eq", "the sweep never writes a dispute");
expectSourceContains(jobSource, "registerDisputeWarningJob", "the job registers itself once");

/* -------------------------------------------------------------------------------------------------
 * The verdict
 * ---------------------------------------------------------------------------------------------- */

if (failures.length > 0) {
  process.stderr.write(`dispute warnings gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `dispute warnings gate passed: ${String(checkCount)} checks, two warnings decided from the row - the opening and ` +
      "half the window - each sent once and never after the deadline, the merchant's own owner as the recipient and " +
      "section 23's queue as the only sender, a lost claim dropped with a reason, one role set with a second factor " +
      "and a signed device behind the button, and no money and no dispute written\n",
  );
}
