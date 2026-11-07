// path: services/disputes/chargeback-rate-verify.ts
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import type { z } from "zod";
import { createInMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { InMemoryAuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import { AppError, isAppError } from "../../lib/errors/app-error.ts";
import { en } from "../../lib/i18n/strings/en.ts";
import { JobRegistry } from "../../lib/jobs/registry.ts";
import { CSRF_PROTECTED_PATHS } from "../../lib/security/csrf.ts";
import {
  CHARGEBACK_ACTIONS_TABLE,
  CHARGEBACK_AUDIT,
  CHARGEBACK_KINDS,
  CHARGEBACK_POLICY_DEFAULTS,
  CHARGEBACK_RULES,
  CHARGEBACK_TEMPLATE_KEY,
  CHARGEBACK_THRESHOLD_KEYS,
  CHARGEBACK_THRESHOLDS,
  chargebackRank,
  isChargebackKind,
  isClearableKind,
} from "./chargeback-fields.ts";
import {
  applyChargebackStep,
  clearChargebackAction,
  countRows,
  decideChargebackStep,
  detailOf,
  measurementOf,
  parseApplyBody,
  parseClearBody,
  parseSweepBody,
  rateBpsOf,
  readChargebackScreen,
  readWindowCounts,
  runChargebackSweep,
  windowOf,
  type ChargebackMeasurement,
} from "./chargeback-rate.ts";
import {
  CHARGEBACK_MONITOR_JOB_NAME,
  createDefaultChargebackMonitorJob,
  registerChargebackMonitorJob,
  runChargebackMonitorJob,
} from "./chargeback-rate-job.ts";
import {
  parsePolicyBody,
  policyDigestOf,
  ratePercentText,
  readChargebackPolicy,
  saveChargebackPolicy,
} from "./chargeback-policy.ts";

/**
 * The gate for STEP 199: section 18's chargeback programme.
 *
 * ## What this proves
 *
 *   - **Two numbers, not one.** Every decision is taken on a pair: the transactions inside the window and the
 *     chargebacks inside it. A rate under the minimum count earns nothing, whatever it reads, and the gate proves
 *     that both directions - a huge rate on three transactions and a small rate on three hundred - earn nothing and
 *     a warning respectively.
 *   - **The ladder is the table's, not the service's.** `0128` re-derives the step from the row's own numbers and
 *     refuses a row that only clears a lower bar, so a service that mislabels a suspension cannot record it.
 *   - **A suspension is a person's.** A warning and an extra reserve are `automatic` with no actor; a suspension is
 *     `manual` with a named officer and an `0111` event whose reason is `chargeback_program`, which is the state the
 *     account lifecycle already knows how to return from.
 *   - **The effects exist.** A reserve step names the `0044` agreement it started - pausing the merchant's old one
 *     first, because one merchant has one active reserve - and a warning queues a `0061` notice or records that
 *     there was nobody to queue it for.
 *   - **The thresholds are settings.** Seven `chargeback.*` rows in `0080`'s registry, bounded, ordered, written by
 *     a super administrator with a second factor, and digested so a decision can name the policy it used.
 *   - **A measurement that cannot see is a measurement that does not act.** A window past the page ceiling is
 *     reported and refused rather than computed on a capped denominator.
 *
 * ## How
 *
 * An in-memory PostgREST over arrays carrying `0128`'s trigger body and its checks, plus the four rules of
 * `platform_settings`, `reserves` and `merchant_account_events` this STEP writes into - so a service that skipped its
 * own guard would still fail here.
 */

let checkCount = 0;
const failures: string[] = [];

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

async function refusalRuleOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();

    return null;
  } catch (error) {
    if (!isAppError(error)) {
      return "not-an-app-error";
    }

    return error.details[0]?.rule ?? null;
  }
}

// ---------------------------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

const companyId = "11111111-1111-4111-8111-111111111111";
const quietCompanyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const adminUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deskUserId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const day = 24 * 60 * 60 * 1000;
const nowMs = Date.parse("2026-11-07T09:00:00.000Z");
const nowIso = new Date(nowMs).toISOString();

function actorOf(overrides: Partial<RequestActor> = {}): RequestActor {
  return {
    userId: adminUserId,
    companyId: null,
    roles: ["super_admin"] as readonly PlatformRole[],
    sessionId: "session-0001",
    assuranceLevel: "aal2",
    authenticatedAtEpochMs: nowMs - 60_000,
    expiresAtEpochMs: nowMs + 86_400_000,
    emailVerified: true,
    twoFactorSatisfied: true,
    twoFactorEnrolmentRequired: false,
    ...overrides,
  } as RequestActor;
}

function deskActor(): RequestActor {
  return actorOf({ userId: deskUserId, roles: ["compliance_kyc"] as readonly PlatformRole[] });
}

interface Fixture {
  readonly rest: RestClient;
  readonly audit: InMemoryAuditTrail;
  readonly companies: Row[];
  readonly payments: Row[];
  readonly disputes: Row[];
  readonly actions: Row[];
  readonly settings: Row[];
  readonly reserves: Row[];
  readonly events: Row[];
  readonly emails: Row[];
  readonly roleAssignments: Row[];
  readonly users: Row[];
  readonly emailSettings: Row[];
  readonly written: string[];
  /** When true, an update lands nowhere: the lost-write simulation every gate in this STEP family uses. */
  loseUpdates: boolean;
  nowMs: number;
}

interface OrderTerm {
  readonly column: string;
  readonly direction: "asc" | "desc";
}

interface Query {
  readonly equals: Map<string, string>;
  readonly lists: Map<string, readonly string[]>;
  readonly nulls: Set<string>;
  readonly notNulls: Set<string>;
  readonly atLeast: Map<string, string>;
  readonly lessThan: Map<string, string>;
  readonly greaterThan: Map<string, string>;
  readonly order: readonly OrderTerm[];
  readonly limit: number | null;
}

function parseQuery(query: string): Query {
  const equals = new Map<string, string>();
  const lists = new Map<string, readonly string[]>();
  const nulls = new Set<string>();
  const notNulls = new Set<string>();
  const atLeast = new Map<string, string>();
  const lessThan = new Map<string, string>();
  const greaterThan = new Map<string, string>();
  const order: OrderTerm[] = [];
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
      for (const term of value.split(",")) {
        const [column = "", direction = "asc"] = term.split(".");

        order.push({ column, direction: direction === "desc" ? "desc" : "asc" });
      }

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

    if (value === "not.is.null") {
      notNulls.add(key);
      continue;
    }

    if (value.startsWith("in.(") && value.endsWith(")")) {
      lists.set(
        key,
        value
          .slice(4, -1)
          .split(",")
          .map((item) => decodeURIComponent(item)),
      );
      continue;
    }

    for (const [prefix, target] of [
      ["gte.", atLeast],
      ["gt.", greaterThan],
      ["lt.", lessThan],
    ] as readonly [string, Map<string, string>][]) {
      if (value.startsWith(prefix)) {
        target.set(key, decodeURIComponent(value.slice(prefix.length)));
      }
    }

    if (value.startsWith("eq.")) {
      equals.set(key, decodeURIComponent(value.slice(3)));
    }
  }

  return { equals, lists, nulls, notNulls, atLeast, lessThan, greaterThan, order, limit };
}

function matches(row: Row, query: Query): boolean {
  for (const [column, value] of query.equals) {
    if (String(row[column]) !== value) {
      return false;
    }
  }

  for (const [column, values] of query.lists) {
    if (!values.includes(String(row[column]))) {
      return false;
    }
  }

  for (const column of query.nulls) {
    if (row[column] !== null && row[column] !== undefined) {
      return false;
    }
  }

  for (const column of query.notNulls) {
    if (row[column] === null || row[column] === undefined) {
      return false;
    }
  }

  for (const [column, value] of query.atLeast) {
    if (String(row[column] ?? "") < value) {
      return false;
    }
  }

  for (const [column, value] of query.lessThan) {
    if (String(row[column] ?? "") >= value) {
      return false;
    }
  }

  for (const [column, value] of query.greaterThan) {
    if (String(row[column] ?? "") <= value) {
      return false;
    }
  }

  return true;
}

function sortRows(rows: readonly Row[], order: readonly OrderTerm[]): Row[] {
  if (order.length === 0) {
    return [...rows];
  }

  return [...rows].sort((left, right) => {
    for (const term of order) {
      const comparison = String(left[term.column] ?? "").localeCompare(String(right[term.column] ?? ""));

      if (comparison !== 0) {
        return term.direction === "desc" ? -comparison : comparison;
      }
    }

    return 0;
  });
}

function conflictGuard(field: string, rule: string): never {
  throw new AppError("CONFLICT", { details: [{ field, rule }] });
}

function validationGuard(field: string, rule: string): never {
  throw new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/** One payment, captured inside or outside the window. */
function paymentRow(id: string, company: string, capturedAt: string): Row {
  return { id, company_id: company, captured_at: capturedAt, status: "settled", deleted_at: null };
}

/** One dispute, opened inside or outside the window. */
function disputeRow(id: string, company: string, openedAt: string): Row {
  return { id, company_id: company, opened_at: openedAt, status: "under_review", deleted_at: null };
}

function iso(offsetMs: number): string {
  return new Date(nowMs + offsetMs).toISOString();
}

/** `0128`'s step arithmetic: the row decides what step it was, not the service that wrote it. */
function guardActionRow(fixture: Fixture, row: Row, mode: "insert" | "update", previous: Row | null): void {
  if (!isChargebackKind(row["kind"])) {
    validationGuard("kind", "chargeback_actions_kind_check");
  }

  const kind = row["kind"] as string;
  const rate = Number(row["rate_bps"]);
  const payments = Number(row["payments_count"]);
  const chargebacks = Number(row["chargebacks_count"]);
  const minimum = Number(row["minimum_transactions"]);
  const bar =
    kind === "warning"
      ? Number(row["warning_rate_bps"])
      : kind === "reserve"
        ? Number(row["reserve_rate_bps"])
        : Number(row["suspension_rate_bps"]);

  if (payments < 0 || chargebacks < 0 || rate < 0 || rate > 10_000) {
    validationGuard("rate_bps", "chargeback_actions_rate_check");
  }

  if (
    !(payments === 0 && rate === 0 && chargebacks === 0) &&
    Math.abs(rate * payments - chargebacks * 10_000) > payments
  ) {
    validationGuard("rate_bps", "chargeback_actions_rate_check");
  }

  if (
    Number(row["warning_rate_bps"]) > Number(row["reserve_rate_bps"]) ||
    Number(row["reserve_rate_bps"]) > Number(row["suspension_rate_bps"])
  ) {
    validationGuard("warning_rate_bps", "chargeback_actions_thresholds_check");
  }

  if (payments < minimum) {
    validationGuard("payments_count", "chargeback_actions_step_check");
  }

  if (rate < bar) {
    validationGuard("rate_bps", "chargeback_actions_step_check");
  }

  if ((kind === "reserve") !== (row["reserve_id"] !== null && row["reserve_id"] !== undefined)) {
    validationGuard("reserve_id", "chargeback_actions_effect_check");
  }

  if ((kind === "suspension") !== (row["account_event_id"] !== null && row["account_event_id"] !== undefined)) {
    validationGuard("account_event_id", "chargeback_actions_effect_check");
  }

  if (kind === "suspension" && row["mode"] !== "manual") {
    validationGuard("mode", "chargeback_actions_effect_check");
  }

  if ((row["mode"] === "manual") !== (row["actor_user_id"] !== null && row["actor_user_id"] !== undefined)) {
    validationGuard("actor_user_id", "chargeback_actions_actor_check");
  }

  const detail = String(row["detail"] ?? "");

  if (detail.length < 1 || detail.length > 280 || detail !== detail.trim()) {
    validationGuard("detail", "chargeback_actions_detail_check");
  }

  if (mode === "insert") {
    const duplicate = fixture.actions.some(
      (action) =>
        action["company_id"] === row["company_id"] && action["kind"] === row["kind"] && action["deleted_at"] === null,
    );

    if (duplicate) {
      conflictGuard("kind", "chargeback_actions_live_key");
    }

    const suspended = fixture.actions.some(
      (action) =>
        action["company_id"] === row["company_id"] &&
        action["kind"] === "suspension" &&
        action["deleted_at"] === null &&
        action["cleared_at"] === null,
    );

    if (kind !== "suspension" && suspended) {
      validationGuard("kind", "chargeback_actions_guard");
    }

    const highest = fixture.actions
      .filter((action) => action["company_id"] === row["company_id"] && action["deleted_at"] === null && action["cleared_at"] === null)
      .reduce((rank, action) => Math.max(rank, chargebackRank(action["kind"] as never)), 0);

    if (highest > 0 && chargebackRank(kind as never) < highest) {
      validationGuard("kind", "chargeback_actions_guard");
    }

    if (row["reserve_id"] !== null && row["reserve_id"] !== undefined) {
      const reserve = fixture.reserves.find((candidate) => candidate["id"] === row["reserve_id"]);

      if (reserve === undefined || reserve["company_id"] !== row["company_id"] || reserve["status"] !== "active") {
        validationGuard("reserve_id", "chargeback_actions_guard");
      }
    }

    if (row["account_event_id"] !== null && row["account_event_id"] !== undefined) {
      const event = fixture.events.find((candidate) => candidate["id"] === row["account_event_id"]);

      if (
        event === undefined ||
        event["company_id"] !== row["company_id"] ||
        event["event"] !== "suspended" ||
        event["reason"] !== "chargeback_program"
      ) {
        validationGuard("account_event_id", "chargeback_actions_guard");
      }
    }

    if (row["email_send_id"] !== null && row["email_send_id"] !== undefined) {
      const email = fixture.emails.find((candidate) => candidate["id"] === row["email_send_id"]);

      if (email === undefined || email["company_id"] !== row["company_id"]) {
        validationGuard("email_send_id", "chargeback_actions_guard");
      }
    }

    return;
  }

  if (previous === null) {
    return;
  }

  const frozen = ["company_id", "kind", "mode", "window_days", "payments_count", "chargebacks_count", "rate_bps", "detail"];

  for (const column of frozen) {
    if (row[column] !== previous[column]) {
      validationGuard(column, "chargeback_actions_guard");
    }
  }

  if (previous["cleared_at"] !== null) {
    validationGuard("cleared_at", "chargeback_actions_guard");
  }

  if (kind === "suspension") {
    validationGuard("kind", "chargeback_actions_guard");
  }
}

/** `0080`'s rules on a setting row: the key's shape, the value's shape, and one live row per key. */
function guardSettingRow(fixture: Fixture, row: Row, mode: "insert" | "update"): void {
  const key = String(row["setting_key"] ?? "");

  if (!/^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$/u.test(key) || key.length < 3 || key.length > 64) {
    validationGuard("setting_key", "platform_settings_key_check");
  }

  if (row["value"] === null || row["value"] === undefined) {
    validationGuard("value", "platform_settings_shape_check");
  }

  if (mode === "insert") {
    const duplicate = fixture.settings.some(
      (setting) => setting["setting_key"] === key && setting["deleted_at"] === null,
    );

    if (duplicate) {
      conflictGuard("setting_key", "platform_settings_key_key");
    }
  }
}

/** `0044`'s two rules this STEP leans on: one active reserve, and terms that never move. */
function guardReserveRow(fixture: Fixture, row: Row, mode: "insert" | "update", previous: Row | null): void {
  if (Number(row["percent_bps"]) < 0 || Number(row["percent_bps"]) > 10_000) {
    validationGuard("percent_bps", "reserves_percent_check");
  }

  if (mode === "insert") {
    if (row["status"] === "active") {
      const live = fixture.reserves.some(
        (reserve) => reserve["company_id"] === row["company_id"] && reserve["status"] === "active" && reserve["deleted_at"] === null,
      );

      if (live) {
        conflictGuard("company_id", "reserves_active_key");
      }
    }

    return;
  }

  if (previous === null) {
    return;
  }

  for (const column of ["company_id", "percent_bps", "release_days", "currency", "started_at"]) {
    if (row[column] !== previous[column]) {
      validationGuard(column, "reserves_guard_state");
    }
  }
}

/** `0111`'s rules on the one event this STEP writes. */
function guardEventRow(row: Row): void {
  if (row["event"] === "suspended" && (row["reason"] === null || row["reason"] === undefined)) {
    validationGuard("reason", "merchant_account_events_reason_check");
  }

  if (row["event"] === "suspended" && row["required_documents"] === null) {
    validationGuard("required_documents", "merchant_account_events_documents_check");
  }

  if (row["reason"] !== null && row["reason"] !== undefined && row["reason"] !== "chargeback_program") {
    if (!["risk", "billing", "manual"].includes(String(row["reason"]))) {
      validationGuard("reason", "merchant_account_events_reason_check");
    }
  }
}

function createFixture(input: { readonly payments?: number; readonly chargebacks?: number } = {}): Fixture {
  const tables: Partial<Fixture> = {};
  const holder = (): Fixture => tables as Fixture;
  let counter = 0;

  const table = (name: string): Row[] => {
    switch (name) {
      case "companies":
        return holder().companies;
      case "payments":
        return holder().payments;
      case "disputes":
        return holder().disputes;
      case CHARGEBACK_ACTIONS_TABLE:
        return holder().actions;
      case "platform_settings":
        return holder().settings;
      case "reserves":
        return holder().reserves;
      case "merchant_account_events":
        return holder().events;
      case "email_send_logs":
        return holder().emails;
      case "role_assignments":
        return holder().roleAssignments;
      case "users":
        return holder().users;
      case "email_settings":
        return holder().emailSettings;
      default:
        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_table", name } });
    }
  };

  const rest: RestClient = {
    async select<TRow>(name: string, query: string, schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      const parsed = parseQuery(query);
      let rows = table(name).filter((row) => matches(row, parsed));

      rows = sortRows(rows, parsed.order);

      if (parsed.limit !== null) {
        rows = rows.slice(0, parsed.limit);
      }

      return schema.array().parse(rows.map((row) => ({ ...row })));
    },

    async insert(name: string, rows: readonly Row[]): Promise<void> {
      holder().written.push(name);

      for (const row of rows) {
        counter += 1;
        const id = `e0000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;

        if (name === CHARGEBACK_ACTIONS_TABLE) {
          guardActionRow(holder(), { ...row }, "insert", null);
          holder().actions.push({
            id,
            cleared_at: null,
            cleared_by_user_id: null,
            clear_note: null,
            deleted_at: null,
            created_at: nowIso,
            updated_at: nowIso,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "platform_settings") {
          guardSettingRow(holder(), { ...row }, "insert");
          holder().settings.push({
            id,
            company_id: null,
            is_secret: false,
            deleted_at: null,
            created_at: nowIso,
            updated_at: nowIso,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "reserves") {
          guardReserveRow(holder(), { ...row }, "insert", null);
          holder().reserves.push({
            id,
            held_minor: 0,
            released_minor: 0,
            deleted_at: null,
            created_at: nowIso,
            updated_at: nowIso,
            version: 1,
            ...row,
          });
          continue;
        }

        if (name === "merchant_account_events") {
          guardEventRow({ ...row });
          holder().events.push({ id, deleted_at: null, version: 1, ...row });
          continue;
        }

        if (name === "email_send_logs") {
          holder().emails.push({ id, status: "queued", ...row });
          continue;
        }

        throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "unknown_insert", name } });
      }
    },

    async insertReturning<TRow>(name: string, rows: readonly Row[], schema: z.ZodType<TRow>): Promise<readonly TRow[]> {
      await this.insert(name, rows);

      return schema.array().parse(table(name).slice(-rows.length).map((row) => ({ ...row })));
    },

    async update(name: string, query: string, values: Row): Promise<void> {
      holder().written.push(name);

      const parsed = parseQuery(query);

      for (const row of table(name)) {
        if (!matches(row, parsed)) {
          continue;
        }

        const previous = { ...row };
        const next = { ...row, ...values };

        if (name === CHARGEBACK_ACTIONS_TABLE) {
          guardActionRow(holder(), next, "update", previous);
        }

        if (name === "platform_settings") {
          guardSettingRow(holder(), next, "update");
        }

        if (name === "reserves") {
          guardReserveRow(holder(), next, "update", previous);
        }

        if (holder().loseUpdates) {
          continue;
        }

        Object.assign(row, values);

        if (typeof row["version"] === "number") {
          row["version"] += 1;
        }

        row["updated_at"] = new Date(holder().nowMs).toISOString();
      }
    },

    async rpc(): Promise<unknown> {
      throw new AppError("DEPENDENCY_FAILED", { cause: { rule: "no_rpc" } });
    },
  };

  const payments = input.payments ?? 0;
  const chargebacks = input.chargebacks ?? 0;
  const paymentRows: Row[] = [];
  const disputeRows: Row[] = [];

  for (let index = 0; index < payments; index += 1) {
    paymentRows.push(paymentRow(`p${String(index).padStart(6, "0")}-0000-4000-8000-000000000000`, companyId, iso(-day)));
  }

  for (let index = 0; index < chargebacks; index += 1) {
    disputeRows.push(disputeRow(`d${String(index).padStart(6, "0")}-0000-4000-8000-000000000000`, companyId, iso(-day)));
  }

  // One payment and one dispute outside the window, so a count that ignored the filter would read one too high.
  paymentRows.push(paymentRow("p999999-0000-4000-8000-000000000000", companyId, iso(-90 * day)));
  disputeRows.push(disputeRow("d999999-0000-4000-8000-000000000000", companyId, iso(-90 * day)));

  Object.assign(tables, {
    rest,
    audit: createInMemoryAuditTrail(),
    companies: [
      { id: companyId, name: "Northwind Studio", deleted_at: null },
      { id: quietCompanyId, name: "Quiet Co", deleted_at: null },
      { id: otherCompanyId, name: "Third Party", deleted_at: null },
    ],
    payments: paymentRows,
    disputes: disputeRows,
    actions: [],
    settings: [],
    reserves: [],
    events: [],
    emails: [],
    roleAssignments: [
      {
        id: "f0000000-0000-4000-8000-000000000001",
        company_id: companyId,
        user_id: ownerUserId,
        role: "owner",
        granted_at: iso(-400 * day),
        revoked_at: null,
        deleted_at: null,
      },
    ],
    users: [{ id: ownerUserId, email: "owner@example.com", deleted_at: null }],
    emailSettings: [{ id: "f0000000-0000-4000-8000-000000000002", method: "smtp", status: "active", deleted_at: null }],
    written: [],
    loseUpdates: false,
    nowMs,
  });

  return holder();
}

function dependenciesOf(fixture: Fixture): { rest: RestClient; audit: InMemoryAuditTrail; now: () => number } {
  return { rest: fixture.rest, audit: fixture.audit, now: (): number => fixture.nowMs };
}

/** A fixture with the seven thresholds written, so a measurement reads a policy rather than the defaults. */
async function policyFixture(input: { readonly payments?: number; readonly chargebacks?: number } = {}): Promise<Fixture> {
  const fixture = createFixture(input);

  await saveChargebackPolicy(
    {
      actor: actorOf(),
      body: {
        windowDays: 30,
        minimumTransactions: 100,
        warningRateBps: 100,
        reserveRateBps: 150,
        suspensionRateBps: 250,
        reservePercentBps: 1_000,
        reserveDays: 30,
      },
    },
    dependenciesOf(fixture),
  );

  return fixture;
}

// ---------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------

const root = new URL("../../", import.meta.url).pathname;
const migrationsDirectory = `${root}migrations`;

async function sourceOf(path: string): Promise<string> {
  return readFile(`${root}${path}`, "utf8");
}

function expectSourceContains(source: string, needle: string, description: string): void {
  expect(source.includes(needle), `${description} (missing ${JSON.stringify(needle.slice(0, 80))})`);
}

function expectSourceLacks(source: string, needle: string, description: string): void {
  expect(!source.includes(needle), `${description} (found ${JSON.stringify(needle.slice(0, 80))})`);
}

// ---------------------------------------------------------------------------------------------
// 1. The migration and its rollback
// ---------------------------------------------------------------------------------------------

const upstream = await readFile(`${migrationsDirectory}/0128_chargeback_actions.sql`, "utf8");
const rollback = await readFile(`${migrationsDirectory}/0128_chargeback_actions.down.sql`, "utf8");

expect(upstream.startsWith("-- path: migrations/0128_chargeback_actions.sql"), "0128 names its own path");
expect(rollback.startsWith("-- path: migrations/0128_chargeback_actions.down.sql"), "the rollback names its own path");
expectSourceContains(upstream, "begin;", "the forward file is one transaction");
expectSourceContains(upstream, "commit;", "and commits once");
expectSourceContains(rollback, "begin;", "the rollback is one transaction");
expectSourceContains(rollback, "drop table if exists public.chargeback_actions;", "and drops the table last");

for (const needle of [
  "create table public.chargeback_actions (",
  "alter table public.chargeback_actions enable row level security;",
  "create policy chargeback_actions_default_deny",
  "create unique index chargeback_actions_live_key",
  "create index chargeback_actions_company_idx",
  "create index chargeback_actions_open_idx",
  "create function public.chargeback_actions_guard()",
  "create trigger chargeback_actions_guard",
  "create trigger chargeback_actions_set_row_metadata",
]) {
  expectSourceContains(upstream, needle, `0128 states ${JSON.stringify(needle.slice(0, 44))}`);
}

expectSourceContains(
  upstream,
  "constraint chargeback_actions_step_check check (",
  "the step is arithmetic on the row's own numbers",
);
expectSourceContains(upstream, "payments_count >= minimum_transactions", "the minimum count is asked first");
expectSourceContains(upstream, "when 'warning' then rate_bps >= warning_rate_bps", "a warning clears the warning bar");
expectSourceContains(upstream, "when 'reserve' then rate_bps >= reserve_rate_bps", "a reserve clears the reserve bar");
expectSourceContains(upstream, "else rate_bps >= suspension_rate_bps", "and a suspension the highest one");
expectSourceContains(upstream, "and warning_rate_bps <= reserve_rate_bps", "the bars are ordered");
expectSourceContains(upstream, "and reserve_rate_bps <= suspension_rate_bps", "both of them");
expectSourceContains(upstream, "constraint chargeback_actions_effect_check check (", "an effect must exist");
expectSourceContains(upstream, "and (kind = 'suspension') = (mode = 'manual')", "a suspension is a person's");
expectSourceContains(upstream, "constraint chargeback_actions_actor_check check ((mode = 'manual') = (actor_user_id is not null))", "and a manual step carries one");
expectSourceContains(upstream, "raise exception 'a chargeback action is never removed'", "an action is never removed");
expectSourceContains(upstream, "raise exception 'a chargeback action keeps the measurement it was taken on'", "and never re-measured");
expectSourceContains(upstream, "raise exception 'the ladder only moves up'", "the ladder only moves up");
expectSourceContains(upstream, "raise exception 'a suspended merchant is not warned or reserved'", "a suspended merchant is finished");
expectSourceContains(upstream, "raise exception 'a suspension is lifted by the account lifecycle, not by this table'", "and only the lifecycle lifts it");
expectSourceContains(upstream, "raise exception 'the extra reserve belongs to the merchant it was started for'", "the reserve belongs to the merchant");
expectSourceContains(upstream, "raise exception 'a suspension step records a chargeback programme suspension'", "and the suspension is a chargeback one");
expectSourceContains(rollback, "drop function if exists public.chargeback_actions_guard();", "the rollback drops the guard");
expect(
  rollback.indexOf("drop trigger if exists chargeback_actions_guard") < rollback.indexOf("drop table if exists public.chargeback_actions;"),
  "triggers before the table",
);

const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql"));
const numbers = [
  ...new Set(
    migrationFiles
      .map((name) => Number.parseInt(name.slice(0, 4), 10))
      .filter((number) => Number.isFinite(number)),
  ),
].sort((left, right) => left - right);

expectEqual(numbers[numbers.length - 1] ?? 0, 128, "0128 is the newest migration in the chain");
expectEqual(numbers.length, 128, "and the chain is 128 files");

// ---------------------------------------------------------------------------------------------
// 2. The seven numbers, as settings
// ---------------------------------------------------------------------------------------------

const emptyPolicy = await readChargebackPolicy(dependenciesOf(createFixture()));

expectEqual(emptyPolicy.values.windowDays, CHARGEBACK_POLICY_DEFAULTS.windowDays, "an unconfigured platform reads the default window");
expectEqual(emptyPolicy.values.minimumTransactions, 100, "and the default minimum");
expectEqual(emptyPolicy.values.warningRateBps, 100, "and the default warning bar");
expectEqual(emptyPolicy.values.reserveRateBps, 150, "and the reserve bar");
expectEqual(emptyPolicy.values.suspensionRateBps, 250, "and the suspension bar");
expectEqual(emptyPolicy.values.reservePercentBps, 1_000, "and the extra reserve's percent");
expectEqual(emptyPolicy.values.reserveDays, 30, "and its days");
expectEqual(emptyPolicy.updatedAtEpochMs, null, "with nothing written");
expectEqual(emptyPolicy.digest.length, 64, "and a digest of the seven numbers");

const digestAgain = policyDigestOf({ ...CHARGEBACK_POLICY_DEFAULTS });
expectEqual(emptyPolicy.digest, digestAgain, "the digest is stable for the same policy");
expect(
  policyDigestOf({ ...CHARGEBACK_POLICY_DEFAULTS, warningRateBps: 101 }) !== emptyPolicy.digest,
  "and moves when a number moves",
);

for (const key of Object.values(CHARGEBACK_THRESHOLD_KEYS)) {
  expect(/^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$/u.test(key) && key.length <= 64, `${key} is a key 0080 accepts`);
  expect(key.startsWith("chargeback."), "and it is in the chargeback family");
}

expectEqual(ratePercentText(241), "2.41", "241 basis points read 2.41 percent");
expectEqual(ratePercentText(100), "1.00", "and 100 reads 1.00");
expectEqual(ratePercentText(5), "0.05", "and 5 reads 0.05");

const saved = await policyFixture();
const readBack = await readChargebackPolicy(dependenciesOf(saved));

expectEqual(saved.settings.length, 7, "saving writes the seven rows");
expectEqual(readBack.values.suspensionRateBps, 250, "and reading sees the suspension bar");
expect(readBack.updatedAtEpochMs !== null, "with the instant they were written");
expect(
  saved.audit.entries.some((entry) => entry.action === CHARGEBACK_AUDIT.policySaved),
  "the save is in the chain",
);
const policyEntry = saved.audit.entries.find((entry) => entry.action === CHARGEBACK_AUDIT.policySaved);
const policySource = await sourceOf("services/disputes/chargeback-policy.ts");

expectSourceContains(policySource, "requireAnyRole(input.actor, CHARGEBACK_POLICY_ROLES)", "the save asks for the super administrator role");
expectSourceContains(policySource, "if (!hasSatisfiedTwoFactor(input.actor))", "and a second factor after it");

expectEqual((policyEntry?.payload["changed_keys"] as readonly string[]).length, 7, "with all seven keys named");
expectEqual(policyEntry?.payload["policy_digest"], readBack.digest, "and the digest the screen prints");
expectEqual(policyEntry?.companyId, null, "on the platform chain");

const unchanged = await saveChargebackPolicy(
  {
    actor: actorOf(),
    body: {
      windowDays: 30,
      minimumTransactions: 100,
      warningRateBps: 100,
      reserveRateBps: 150,
      suspensionRateBps: 250,
      reservePercentBps: 1_000,
      reserveDays: 30,
    },
  },
  dependenciesOf(saved),
);

expectEqual(unchanged.digest, readBack.digest, "saving the same numbers changes nothing");
expectEqual(saved.audit.entries.filter((entry) => entry.action === CHARGEBACK_AUDIT.policySaved).length, 1, "and writes no second entry");

const widened = await saveChargebackPolicy(
  {
    actor: actorOf(),
    body: {
      windowDays: 45,
      minimumTransactions: 120,
      warningRateBps: 120,
      reserveRateBps: 180,
      suspensionRateBps: 300,
      reservePercentBps: 1_500,
      reserveDays: 45,
    },
  },
  dependenciesOf(saved),
);

expectEqual(widened.values.windowDays, 45, "a changed window is saved");
expectEqual(widened.values.reservePercentBps, 1_500, "and a changed reserve percent");
expectEqual(saved.audit.entries.filter((entry) => entry.action === CHARGEBACK_AUDIT.policySaved).length, 2, "and the second save is a second entry");

// The registry's own rules, entered directly.
const registryFixture = createFixture();

expectEqual(
  await refusalRuleOf(() =>
    registryFixture.rest.insert("platform_settings", [
      { setting_key: "chargeback.bad key", value: 1, is_secret: false },
    ]),
  ),
  "platform_settings_key_check",
  "a key outside 0080's pattern is refused",
);
await expectRefusal(
  () =>
    registryFixture.rest.insert("platform_settings", [
      { setting_key: "chargeback.window_days", value: null, is_secret: false },
    ]),
  "VALIDATION_FAILED",
  "and a setting with no value",
);

await registryFixture.rest.insert("platform_settings", [{ setting_key: "chargeback.window_days", value: 30, is_secret: false }]);
await expectRefusal(
  () => registryFixture.rest.insert("platform_settings", [{ setting_key: "chargeback.window_days", value: 60, is_secret: false }]),
  "CONFLICT",
  "and a second live row for one key",
);

// ---------------------------------------------------------------------------------------------
// 3. The body of a policy
// ---------------------------------------------------------------------------------------------

const goodPolicy = {
  windowDays: 30,
  minimumTransactions: 100,
  warningRateBps: 100,
  reserveRateBps: 150,
  suspensionRateBps: 250,
  reservePercentBps: 1_000,
  reserveDays: 30,
};

expectEqual(parsePolicyBody(goodPolicy).windowDays, 30, "a policy parses its window");

for (const [body, description] of [
  [{ ...goodPolicy, extra: 1 }, "a policy with an unknown key"],
  [{ ...goodPolicy, windowDays: 0 }, "a window of zero days"],
  [{ ...goodPolicy, windowDays: 366 }, "a window longer than a year"],
  [{ ...goodPolicy, minimumTransactions: -1 }, "a negative minimum"],
  [{ ...goodPolicy, warningRateBps: 0 }, "a warning bar of zero"],
  [{ ...goodPolicy, warningRateBps: 10_001 }, "a warning bar above a hundred percent"],
  [{ ...goodPolicy, warningRateBps: 200, reserveRateBps: 150 }, "a reserve bar under the warning bar"],
  [{ ...goodPolicy, reserveRateBps: 400, suspensionRateBps: 300 }, "a suspension bar under the reserve bar"],
  [{ ...goodPolicy, windowDays: 30.5 }, "a window that is not a whole day"],
  [{ ...goodPolicy, reserveDays: 0 }, "a reserve held for no days"],
  [null, "a policy that is not an object"],
] as readonly [unknown, string][]) {
  expectEqual(await refusalRuleOf(async () => parsePolicyBody(body)), CHARGEBACK_RULES.policyInvalid, `${description} is refused`);
}

const storedFixture = createFixture();
await storedFixture.rest.insert("platform_settings", [{ setting_key: "chargeback.warning_rate_bps", value: 0, is_secret: false }]);
await expectRefusal(
  () => readChargebackPolicy(dependenciesOf(storedFixture)),
  "DEPENDENCY_FAILED",
  "a stored bar outside its bounds is a loud failure rather than a quiet default",
);

// ---------------------------------------------------------------------------------------------
// 4. Who may set the thresholds
// ---------------------------------------------------------------------------------------------

const roleFixture = createFixture();

for (const [actor, description] of [
  [deskActor(), "the compliance desk"],
  [actorOf({ roles: ["ceo"] as readonly PlatformRole[] }), "the chief executive"],
  [actorOf({ roles: ["finance_ops"] as readonly PlatformRole[] }), "the finance desk"],
  [actorOf({ roles: ["support"] as readonly PlatformRole[] }), "support"],
] as readonly [RequestActor, string][]) {
  await expectRefusal(
    () => saveChargebackPolicy({ actor, body: goodPolicy }, dependenciesOf(roleFixture)),
    "PERMISSION_DENIED",
    `${description} cannot set the thresholds`,
  );
}

await expectRefusal(
  () => saveChargebackPolicy({ actor: actorOf({ twoFactorSatisfied: false, assuranceLevel: "aal1" }), body: goodPolicy }, dependenciesOf(roleFixture)),
  "PERMISSION_DENIED",
  "and neither can a session that has not proved its second factor",
);

// ---------------------------------------------------------------------------------------------
// 5. The arithmetic of a measurement
// ---------------------------------------------------------------------------------------------

expectEqual(rateBpsOf(0, 0), 0, "no transactions is a rate of zero");
expectEqual(rateBpsOf(0, 3), 0, "and stays zero when chargebacks exist but transactions do not");
expectEqual(rateBpsOf(100, 1), 100, "one in a hundred is a hundred basis points");
expectEqual(rateBpsOf(1_000, 24), 240, "twenty four in a thousand is 2.40 percent");
expectEqual(rateBpsOf(350, 12), 343, "and the division rounds once: 3.43 percent");

const window = windowOf(CHARGEBACK_POLICY_DEFAULTS, nowMs);
expectEqual(window.to, nowIso, "the window ends now");
expectEqual(
  Date.parse(window.from),
  nowMs - CHARGEBACK_POLICY_DEFAULTS.windowDays * day,
  "and starts one policy window earlier",
);

const measurement = (paymentsCount: number, chargebacksCount: number, truncated = false): ChargebackMeasurement =>
  measurementOf({
    companyId,
    window,
    paymentsCount,
    chargebacksCount,
    windowDays: 30,
    truncated,
  });

expectEqual(decideChargebackStep(measurement(50, 10), CHARGEBACK_POLICY_DEFAULTS).rule, CHARGEBACK_RULES.minimumNotReached, "a huge rate below the minimum count earns nothing");
expectEqual(decideChargebackStep(measurement(50, 10), CHARGEBACK_POLICY_DEFAULTS).kind, null, "and no step");
expectEqual(decideChargebackStep(measurement(400, 10), CHARGEBACK_POLICY_DEFAULTS).kind, "suspension", "2.50 percent on four hundred earns a suspension");
expectEqual(decideChargebackStep(measurement(400, 8), CHARGEBACK_POLICY_DEFAULTS).kind, "reserve", "2.00 percent earns a reserve");
expectEqual(decideChargebackStep(measurement(400, 4), CHARGEBACK_POLICY_DEFAULTS).kind, "warning", "1.00 percent earns a warning");
expectEqual(decideChargebackStep(measurement(400, 3), CHARGEBACK_POLICY_DEFAULTS).kind, null, "0.75 percent earns nothing");
expectEqual(decideChargebackStep(measurement(400, 3), CHARGEBACK_POLICY_DEFAULTS).rule, CHARGEBACK_RULES.belowThreshold, "and says which bar it missed");
expectEqual(decideChargebackStep(measurement(400, 10, true), CHARGEBACK_POLICY_DEFAULTS).rule, CHARGEBACK_RULES.measurementTruncated, "a truncated read earns nothing either");

expectEqual(chargebackRank("warning"), 1, "the warning is the first rung");
expectEqual(chargebackRank("reserve"), 2, "the reserve the second");
expectEqual(chargebackRank("suspension"), 3, "and the suspension the third");
expectEqual(isClearableKind("warning") && isClearableKind("reserve"), true, "the two the platform takes may be cleared");
expectEqual(isClearableKind("suspension"), false, "and the one a person takes may not");

const detail = detailOf(measurement(400, 10), "suspension", CHARGEBACK_POLICY_DEFAULTS);

expect(detail.includes("2.50 percent"), "the sentence names the rate");
expect(detail.includes("400 transactions"), "and the count it was taken on");
expect(detail.length <= 280, "and fits the column");

// ---------------------------------------------------------------------------------------------
// 6. Counting, and paging
// ---------------------------------------------------------------------------------------------

const countFixture = createFixture({ payments: 12, chargebacks: 3 });
const counted = await countRows(countFixture.rest, "payments", "company_id=eq." + encodeURIComponent(companyId) + "&deleted_at=is.null");

expectEqual(counted.count, 13, "every payment of the merchant is counted, inside the window or not");
expectEqual(counted.truncated, false, "and a short read is not truncated");

const paged = await countRows(
  countFixture.rest,
  "payments",
  `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
  { pageSize: 5 },
);

expectEqual(paged.count, 13, "paging reads every row exactly once");
expectEqual(paged.truncated, false, "and finishes before its ceiling");

const capped = await countRows(
  countFixture.rest,
  "payments",
  `company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null`,
  { pageSize: 5, maximumPages: 2 },
);

expectEqual(capped.count, 10, "a walk that runs out of pages stops at the ceiling");
expectEqual(capped.truncated, true, "and says so");

const windowCounts = await readWindowCounts(countFixture.rest, windowOf(CHARGEBACK_POLICY_DEFAULTS, nowMs));

expectEqual(windowCounts.payments.get(companyId), 12, "the window counts the twelve payments inside it");
expectEqual(windowCounts.chargebacks.get(companyId), 3, "and the three disputes inside it");
expectEqual(windowCounts.payments.get(quietCompanyId), undefined, "a merchant with no payments has no entry");
expectEqual(windowCounts.truncated, false, "and the read is complete");

// A measurement that counted rows outside the window would read a different step entirely, so the window is
// proved by arithmetic rather than by the filter being spelled the same way twice.
const windowFixture = await policyFixture({ payments: 400, chargebacks: 12 });

for (let index = 0; index < 200; index += 1) {
  windowFixture.payments.push(
    paymentRow(`p8${String(index).padStart(5, "0")}-0000-4000-8000-000000000000`, companyId, iso(-200 * day)),
  );
}

const windowStep = await applyChargebackStep({ actor: actorOf(), body: { companyId, reason: "Twelve." } }, dependenciesOf(windowFixture));

expectEqual(windowStep.kind, "suspension", "two hundred old payments do not dilute a rate taken inside the window");
expectEqual(windowFixture.actions[0]?.["payments_count"], 400, "the row records the window's count, not the table's");

const lateChargebackFixture = await policyFixture({ payments: 400, chargebacks: 4 });

for (let index = 0; index < 200; index += 1) {
  lateChargebackFixture.disputes.push(
    disputeRow(`d8${String(index).padStart(5, "0")}-0000-4000-8000-000000000000`, companyId, iso(-200 * day)),
  );
}

const lateStep = await applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(lateChargebackFixture));

expectEqual(lateStep.kind, "warning", "and two hundred old chargebacks do not raise it");

// ---------------------------------------------------------------------------------------------
// 7. The screen
// ---------------------------------------------------------------------------------------------

const screenFixture = await policyFixture({ payments: 400, chargebacks: 10 });

for (const [actor, description] of [
  [actorOf({ roles: ["finance_ops"] as readonly PlatformRole[] }), "the finance desk"],
  [actorOf({ roles: ["support"] as readonly PlatformRole[] }), "support"],
  [actorOf({ roles: ["owner"] as readonly PlatformRole[], companyId }), "the merchant"],
  [deskActor(), "the compliance desk"],
] as readonly [RequestActor, string][]) {
  if (description === "the compliance desk") {
    const allowed = await readChargebackScreen(actor, dependenciesOf(screenFixture));

    expectEqual(allowed.rows.length, 3, "the compliance desk reads every merchant");
    continue;
  }

  await expectRefusal(
    () => readChargebackScreen(actor, dependenciesOf(screenFixture)),
    "PERMISSION_DENIED",
    `${description} cannot read the programme`,
  );
}

const screen = await readChargebackScreen(actorOf(), dependenciesOf(screenFixture));
const row = screen.rows.find((candidate) => candidate.companyId === companyId);
const quiet = screen.rows.find((candidate) => candidate.companyId === quietCompanyId);

expectEqual(screen.rows.length, 3, "every merchant is a row");
expectEqual(row?.paymentsCount, 400, "the row counts the payments inside the window");
expectEqual(row?.chargebacksCount, 10, "and the chargebacks inside it");
expectEqual(row?.rateBps, 250, "and prints the rate they give");
expectEqual(row?.rateText, "2.50", "as a percent with two places");
expectEqual(row?.dueKind, "suspension", "and the step that rate earns");
expectEqual(row?.liveKind, null, "with nothing standing yet");
expectEqual(row?.blockedRule, null, "so the row may be actioned");
expectEqual(quiet?.paymentsCount, 0, "a merchant with no transactions is still a row");
expectEqual(quiet?.dueKind, null, "and earns nothing");
expectEqual(quiet?.blockedRule, CHARGEBACK_RULES.minimumNotReached, "because the minimum count comes first");
expectEqual(screen.canApply, true, "a super administrator may take a step");
expectEqual(screen.canSuspend, true, "and may suspend");
expectEqual(screen.totalCompanies, 3, "the screen knows how many merchants it printed");

const deskScreen = await readChargebackScreen(deskActor(), dependenciesOf(screenFixture));

expectEqual(deskScreen.canApply, true, "the compliance desk may take the automatic steps");
expectEqual(deskScreen.canSuspend, false, "and may not suspend");

const ceoScreen = await readChargebackScreen(actorOf({ roles: ["ceo"] as readonly PlatformRole[] }), dependenciesOf(screenFixture));

expectEqual(ceoScreen.rows.length, 3, "the chief executive reads the programme");
expectEqual(ceoScreen.canApply, false, "and takes no step");

// ---------------------------------------------------------------------------------------------
// 8. Taking a step
// ---------------------------------------------------------------------------------------------

const warningFixture = await policyFixture({ payments: 400, chargebacks: 4 });
const warningStep = await applyChargebackStep(
  { actor: actorOf(), body: { companyId } },
  dependenciesOf(warningFixture),
);

expectEqual(warningStep.kind, "warning", "four in four hundred earns a warning");
expectEqual(warningStep.mode, "automatic", "and it is the platform's own act");
expectEqual(warningStep.actorUserId, null, "with no officer's name on it");
expectEqual(warningFixture.actions.length, 1, "one action row is written");
expectEqual(warningFixture.actions[0]?.["rate_bps"], 100, "carrying the rate it was taken on");
expectEqual(warningFixture.actions[0]?.["minimum_transactions"], 100, "and the minimum it cleared");
expectEqual(warningFixture.actions[0]?.["warning_rate_bps"], 100, "and the bar it cleared");
expectEqual(warningFixture.emails.length, 1, "the warning queues one notice");
expectEqual(warningFixture.emails[0]?.["template_key"], CHARGEBACK_TEMPLATE_KEY, "as a dispute update");
expectEqual(warningFixture.emails[0]?.["recipient_user_id"], ownerUserId, "to the merchant's own owner");
expect(warningFixture.audit.entries.some((entry) => entry.action === CHARGEBACK_AUDIT.actionApplied), "and the step is in the chain");
const appliedEntry = warningFixture.audit.entries.find((entry) => entry.action === CHARGEBACK_AUDIT.actionApplied);

expectEqual(appliedEntry?.companyId, companyId, "against the merchant");
expectEqual(appliedEntry?.actorUserId, null, "with no actor on an automatic step");
expectEqual(appliedEntry?.payload["rate_bps"], 100, "and the rate");
expectEqual("detail" in (appliedEntry?.payload ?? {}), false, "and never the sentence itself");

const afterWarning = await readChargebackScreen(actorOf(), dependenciesOf(warningFixture));
const warnedRow = afterWarning.rows.find((candidate) => candidate.companyId === companyId);

expectEqual(warnedRow?.liveKind, "warning", "the watchlist shows the warning standing");
expectEqual(warnedRow?.blockedRule, CHARGEBACK_RULES.stepTaken, "and refuses the same step twice");

expectEqual(
  await refusalRuleOf(() => applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(warningFixture))),
  CHARGEBACK_RULES.stepTaken,
  "pressing again is a refusal rather than a second warning",
);
expectEqual(warningFixture.actions.length, 1, "and writes nothing");
expectEqual(warningFixture.emails.length, 1, "and sends nothing");

await expectRefusal(
  async () => applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(await policyFixture({ payments: 50, chargebacks: 10 }))),
  "CONFLICT",
  "a merchant under the minimum count cannot be actioned",
);
expectEqual(
  await refusalRuleOf(async () => applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(await policyFixture({ payments: 400, chargebacks: 3 })))),
  CHARGEBACK_RULES.belowThreshold,
  "and neither can one under the warning bar",
);
expectEqual(
  await refusalRuleOf(() => applyChargebackStep({ actor: actorOf(), body: { companyId: otherCompanyId } }, dependenciesOf(screenFixture))),
  CHARGEBACK_RULES.minimumNotReached,
  "a merchant with no transactions earns nothing",
);
await expectRefusal(
  () => applyChargebackStep({ actor: actorOf(), body: { companyId: "99999999-9999-4999-8999-999999999999" } }, dependenciesOf(screenFixture)),
  "RESOURCE_NOT_FOUND",
  "and a company that does not exist is a not-found",
);

// The reserve step.
const reserveFixture = await policyFixture({ payments: 400, chargebacks: 8 });
const reserveStep = await applyChargebackStep({ actor: deskActor(), body: { companyId } }, dependenciesOf(reserveFixture));

expectEqual(reserveStep.kind, "reserve", "2.00 percent earns the extra reserve");
expectEqual(reserveStep.reservePercentText, "10.00", "at the policy's percent");
expectEqual(reserveFixture.reserves.length, 1, "one reserve is opened");
expectEqual(reserveFixture.reserves[0]?.["percent_bps"], 1_000, "at ten percent");
expectEqual(reserveFixture.reserves[0]?.["release_days"], 30, "held for the policy's days");
expectEqual(reserveFixture.reserves[0]?.["status"], "active", "and active");
expectEqual(reserveFixture.actions[0]?.["reserve_id"], reserveFixture.reserves[0]?.["id"], "the step names it");
expectEqual(reserveFixture.emails.length, 0, "and a reserve step queues no notice");

// A merchant already withholding less than the policy's percent gets a new agreement, not a moved number.
const existingReserveFixture = await policyFixture({ payments: 400, chargebacks: 8 });

await existingReserveFixture.rest.insert("reserves", [
  {
    company_id: companyId,
    percent_bps: 500,
    release_days: 30,
    currency: "USD",
    status: "active",
    started_at: iso(-200 * day),
    next_release_on: iso(-170 * day),
    note: null,
  },
]);

const extraReserve = await applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(existingReserveFixture));
const paused = existingReserveFixture.reserves.find((candidate) => candidate["percent_bps"] === 500);
const opened = existingReserveFixture.reserves.find((candidate) => candidate["percent_bps"] === 1_000);

expectEqual(extraReserve.kind, "reserve", "the step is still a reserve");
expectEqual(paused?.["status"], "paused", "the old agreement is paused rather than rewritten");
expect(opened !== undefined && opened["status"] === "active", "and the new one is active");
expectEqual(existingReserveFixture.actions[0]?.["reserve_id"], opened?.["id"], "the step names the new agreement");

// The suspension.
const suspendFixture = await policyFixture({ payments: 400, chargebacks: 12 });

await expectRefusal(
  () => applyChargebackStep({ actor: deskActor(), body: { companyId, reason: "Twelve chargebacks." } }, dependenciesOf(suspendFixture)),
  "PERMISSION_DENIED",
  "because only a super administrator suspends",
);
await expectRefusal(
  () => applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(suspendFixture)),
  "VALIDATION_FAILED",
  "a suspension with no sentence is refused",
);
expectEqual(
  await refusalRuleOf(() => applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(suspendFixture))),
  CHARGEBACK_RULES.suspensionReasonRequired,
  "and says why",
);
expectEqual(suspendFixture.events.length, 0, "nothing is suspended by the refusals");

const suspensionStep = await applyChargebackStep(
  { actor: actorOf(), body: { companyId, reason: "Twelve chargebacks in four hundred transactions." } },
  dependenciesOf(suspendFixture),
);

expectEqual(suspensionStep.kind, "suspension", "the highest step is a suspension");
expectEqual(suspensionStep.mode, "manual", "and it is a person's");
expectEqual(suspensionStep.actorUserId, adminUserId, "with their name on it");
expectEqual(suspendFixture.events.length, 1, "one lifecycle event is written");
expectEqual(suspendFixture.events[0]?.["event"], "suspended", "as a suspension");
expectEqual(suspendFixture.events[0]?.["reason"], "chargeback_program", "for the chargeback programme");
expectEqual(suspendFixture.events[0]?.["actor_user_id"], adminUserId, "by the officer");
expectEqual(suspendFixture.actions[0]?.["account_event_id"], suspendFixture.events[0]?.["id"], "and the step names it");
expectEqual(suspendFixture.emails.length, 0, "and queues no notice");

const afterSuspension = await readChargebackScreen(actorOf(), dependenciesOf(suspendFixture));
const suspendedRow = afterSuspension.rows.find((candidate) => candidate.companyId === companyId);

expectEqual(suspendedRow?.liveKind, "suspension", "the watchlist shows the suspension");
expectEqual(suspendedRow?.blockedRule, CHARGEBACK_RULES.suspended, "and refuses anything else");
expectEqual(
  await refusalRuleOf(() => applyChargebackStep({ actor: actorOf(), body: { companyId, reason: "Again." } }, dependenciesOf(suspendFixture))),
  CHARGEBACK_RULES.suspended,
  "and pressing suspend again is the same refusal",
);

// ---------------------------------------------------------------------------------------------
// 9. Clearing
// ---------------------------------------------------------------------------------------------

const clearFixture = await policyFixture({ payments: 400, chargebacks: 4 });

await applyChargebackStep({ actor: actorOf(), body: { companyId } }, dependenciesOf(clearFixture));

await expectRefusal(
  () => clearChargebackAction({ actor: deskActor(), body: { companyId, kind: "warning", note: "Rate fell." } }, dependenciesOf(clearFixture)),
  "PERMISSION_DENIED",
  "so the compliance desk cannot clear a warning",
);
await expectRefusal(
  () => clearChargebackAction({ actor: actorOf(), body: { companyId, kind: "warning", note: "" } }, dependenciesOf(clearFixture)),
  "VALIDATION_FAILED",
  "a clearing with no sentence is refused",
);

const cleared = await clearChargebackAction(
  { actor: actorOf(), body: { companyId, kind: "warning", note: "The rate came back to 0.40 percent." } },
  dependenciesOf(clearFixture),
);

expect(cleared.clearedAt !== null, "the warning is cleared");
expectEqual(clearFixture.actions[0]?.["clear_note"], "The rate came back to 0.40 percent.", "with the sentence on the row");
expectEqual(clearFixture.actions[0]?.["cleared_by_user_id"], adminUserId, "and the officer who lifted it");
expect(clearFixture.audit.entries.some((entry) => entry.action === CHARGEBACK_AUDIT.actionCleared), "and the clearing is in the chain");
expectEqual(
  await refusalRuleOf(() => clearChargebackAction({ actor: actorOf(), body: { companyId, kind: "warning", note: "Again." } }, dependenciesOf(clearFixture))),
  CHARGEBACK_RULES.alreadyCleared,
  "clearing twice is refused",
);

const clearedScreen = await readChargebackScreen(actorOf(), dependenciesOf(clearFixture));
const clearedRow = clearedScreen.rows.find((candidate) => candidate.companyId === companyId);

expectEqual(clearedRow?.clearedKind, "warning", "the watchlist remembers what was cleared");
expectEqual(clearedRow?.liveKind, null, "and nothing is standing");

const suspendClearFixture = await policyFixture({ payments: 400, chargebacks: 12 });

await applyChargebackStep({ actor: actorOf(), body: { companyId, reason: "Twelve." } }, dependenciesOf(suspendClearFixture));
expectEqual(
  await refusalRuleOf(() => clearChargebackAction({ actor: actorOf(), body: { companyId, kind: "suspension", note: "Sorry." } }, dependenciesOf(suspendClearFixture))),
  CHARGEBACK_RULES.notClearable,
  "a suspension is not cleared here",
);

// The database's own rules, entered directly.
const guardFixture = await policyFixture({ payments: 400, chargebacks: 4 });
const baseAction: Row = {
  company_id: companyId,
  kind: "warning",
  mode: "automatic",
  window_days: 30,
  payments_count: 400,
  chargebacks_count: 4,
  rate_bps: 100,
  minimum_transactions: 100,
  warning_rate_bps: 100,
  reserve_rate_bps: 150,
  suspension_rate_bps: 250,
  reserve_percent_bps: null,
  detail: "1.00 percent over 30 days.",
  actor_user_id: null,
  reserve_id: null,
  account_event_id: null,
  email_send_id: null,
  applied_at: nowIso,
};

await guardFixture.rest.insert(CHARGEBACK_ACTIONS_TABLE, [baseAction]);

await expectRefusal(
  () => guardFixture.rest.insert(CHARGEBACK_ACTIONS_TABLE, [{ ...baseAction }]),
  "CONFLICT",
  "a second live step of one kind is refused by the unique index",
);
await expectRefusal(
  () => guardFixture.rest.insert(CHARGEBACK_ACTIONS_TABLE, [{ ...baseAction, kind: "suspension", mode: "manual", actor_user_id: adminUserId }]),
  "VALIDATION_FAILED",
  "a suspension whose rate is under the suspension bar is refused by the table",
);
await expectRefusal(
  () => guardFixture.rest.insert(CHARGEBACK_ACTIONS_TABLE, [{ ...baseAction, kind: "reserve" }]),
  "VALIDATION_FAILED",
  "a reserve step with no reserve is refused",
);

const mismatchFixture = await policyFixture({ payments: 400, chargebacks: 4 });

await expectRefusal(
  () => mismatchFixture.rest.insert(CHARGEBACK_ACTIONS_TABLE, [{ ...baseAction, rate_bps: 900 }]),
  "VALIDATION_FAILED",
  "a rate that is not the division it claims is refused",
);

const deleteFixture = await policyFixture({ payments: 400, chargebacks: 4 });

await deleteFixture.rest.insert(CHARGEBACK_ACTIONS_TABLE, [{ ...baseAction }]);
expectSourceContains(
  upstream,
  "raise exception 'a chargeback action is never removed'",
  "and the guard refuses a delete, which the fixture cannot be asked to do through a client with no delete",
);

// ---------------------------------------------------------------------------------------------
// 10. The sweep, and the job behind it
// ---------------------------------------------------------------------------------------------

const sweepFixture = await policyFixture({ payments: 400, chargebacks: 4 });

await sweepFixture.rest.insert("payments", []);
const sweepResult = await runChargebackSweep({ companyId: null }, dependenciesOf(sweepFixture));

expectEqual(sweepResult.measured, 3, "the sweep measures every merchant");
expectEqual(sweepResult.warned, 1, "and warns the one over the bar");
expectEqual(sweepResult.reserved, 0, "with nothing to reserve");
expectEqual(sweepResult.skipped, 2, "and skips the two with nothing owed");
expectEqual(sweepFixture.actions.length, 1, "one step is written");
expect(sweepFixture.audit.entries.some((entry) => entry.action === CHARGEBACK_AUDIT.sweepRun), "and the run is in the chain");

const suspendableSweep = await policyFixture({ payments: 400, chargebacks: 12 });
const suspendableResult = await runChargebackSweep({ companyId: null }, dependenciesOf(suspendableSweep));

expectEqual(suspendableResult.suspensionsDue, 1, "a merchant over the suspension bar is counted");
expectEqual(suspendableResult.warned + suspendableResult.reserved, 0, "and the sweep does not take it");
expectEqual(suspendableSweep.events.length, 0, "no account is suspended by a job");
expectEqual(suspendableSweep.actions.length, 0, "and no step is recorded");

const oneMerchantSweep = await policyFixture({ payments: 400, chargebacks: 4 });
const oneMerchantResult = await runChargebackSweep({ companyId }, dependenciesOf(oneMerchantSweep));

expectEqual(oneMerchantResult.measured, 1, "the sweep may be asked about one merchant");
expectEqual(oneMerchantResult.warned, 1, "and warns that one");

const registry = new JobRegistry();

registerChargebackMonitorJob(registry, () => dependenciesOf(sweepFixture));
registerChargebackMonitorJob(registry, () => dependenciesOf(sweepFixture));

expectEqual(registry.has(CHARGEBACK_MONITOR_JOB_NAME), true, "the chargeback clock registers under its own name");
expectEqual(registry.size, 1, "and registers once");

const jobFixture = await policyFixture({ payments: 400, chargebacks: 8 });
const jobResult = await runChargebackMonitorJob({}, dependenciesOf(jobFixture));

expectEqual(jobResult.reserved + jobResult.warned, 1, "the real handler takes the step the numbers earn");
expectEqual(jobFixture.actions.length, 1, "and writes it");

expectEqual(
  await refusalRuleOf(async () => parseSweepBody({ company_id: "not-a-uuid" })),
  "invalid_format",
  "the job's payload is a uuid or nothing",
);
expectEqual(parseSweepBody({ company_id: companyId }).companyId, companyId, "and a uuid travels through it");
expectEqual(parseSweepBody({}).companyId, null, "with an empty payload meaning every merchant");
expectEqual(await refusalRuleOf(async () => parseSweepBody({ company_id: companyId, extra: 1 })), "invalid_format", "and no other field");

expectEqual(createDefaultChargebackMonitorJob().name, CHARGEBACK_MONITOR_JOB_NAME, "the default definition is the same job");

// ---------------------------------------------------------------------------------------------
// 11. The bodies of the two acts
// ---------------------------------------------------------------------------------------------

expectEqual(parseApplyBody({ companyId }).companyId, companyId, "an apply body names its merchant");
expectEqual(parseApplyBody({ companyId, reason: "  Twelve chargebacks.  " }).reason, "Twelve chargebacks.", "and trims the sentence");

for (const [body, description] of [
  [{ reason: "Twelve." }, "an apply body with no merchant"],
  [{ companyId: "not-a-uuid" }, "an apply body with a merchant that is not one"],
  [{ companyId, extra: 1 }, "an apply body with an unknown key"],
  [{ companyId, reason: "" }, "an apply body with an empty sentence"],
  [{ companyId, reason: "x".repeat(281) }, "an apply body with a sentence over 280"],
  [null, "an apply body that is not an object"],
] as readonly [unknown, string][]) {
  expectEqual(await refusalRuleOf(async () => parseApplyBody(body)), "invalid_format", `${description} is refused`);
}

expectEqual(parseClearBody({ companyId, kind: "reserve", note: "  Rate fell.  " }).note, "Rate fell.", "a clear body trims its sentence");

for (const [body, description] of [
  [{ companyId, kind: "warning" }, "a clear body with no sentence"],
  [{ companyId, kind: "warning", note: "   " }, "a clear body with a blank sentence"],
  [{ companyId, kind: "warning", note: "x".repeat(281) }, "a clear body over 280"],
  [{ companyId, note: "Fine." }, "a clear body with no kind"],
  [{ companyId, kind: "escalation", note: "Fine." }, "a clear body with a kind that is not one"],
  [{ kind: "warning", note: "Fine." }, "a clear body with no merchant"],
] as readonly [unknown, string][]) {
  expectEqual(await refusalRuleOf(async () => parseClearBody(body)), "invalid_format", `${description} is refused`);
}

// ---------------------------------------------------------------------------------------------
// 12. The three routes
// ---------------------------------------------------------------------------------------------

const policyRoute = await sourceOf("app/api/office/disputes/chargeback/policy/route.ts");
const applyRoute = await sourceOf("app/api/office/disputes/chargeback/apply/route.ts");
const clearRoute = await sourceOf("app/api/office/disputes/chargeback/clear/route.ts");

for (const [source, name] of [
  [policyRoute, "the policy route"],
  [applyRoute, "the apply route"],
  [clearRoute, "the clear route"],
] as readonly [string, string][]) {
  expectSourceContains(source, "requireCsrfToken(request", `${name} checks the token first`);
  expectSourceContains(source, 'readRequestActor(request.headers.get("cookie")', `${name} reads the session itself`);
  expectSourceContains(source, "requireTrustedDevice(", `${name} demands the device proof`);
  expectSourceContains(source, "PAYLOAD_TOO_LARGE", `${name} has a body ceiling`);
  expectSourceContains(source, "withErrorResponse(", `${name} answers in the platform's envelope`);
  expectSourceContains(source, "getChargebackRuntime()", `${name} calls the service with the runtime`);
  expectSourceContains(source, "logger.info(", `${name} logs its act`);
  expectSourceLacks(source, "console.", `${name} does not print`);
}

expectSourceContains(policyRoute, "saveChargebackPolicy(", "the policy route saves");
expectSourceContains(policyRoute, "parsePolicyBody(", "after proving the body is a policy");
expectSourceContains(applyRoute, "applyChargebackStep(", "the apply route takes a step");
expectSourceContains(applyRoute, "parseApplyBody(", "after proving the body names a merchant");
expectSourceContains(clearRoute, "clearChargebackAction(", "the clear route lifts a step");
expectSourceContains(clearRoute, "parseClearBody(", "after proving the body is a clearing");
expectSourceContains(clearRoute, "noteLength", "the clear route logs the length of a sentence and not the sentence");
expectSourceContains(applyRoute, "reasonLength", "and so does the apply route");

for (const path of [
  "/api/office/disputes/chargeback/policy",
  "/api/office/disputes/chargeback/apply",
  "/api/office/disputes/chargeback/clear",
]) {
  expect(CSRF_PROTECTED_PATHS.includes(path), `${path} is on the CSRF list`);
}

// ---------------------------------------------------------------------------------------------
// 13. The screen
// ---------------------------------------------------------------------------------------------

const panelSource = await sourceOf("app/(admin)/office/disputes/chargeback-panel.tsx");
const pageSource = await sourceOf("app/(admin)/office/disputes/page.tsx");

expectSourceContains(panelSource, '"use client"', "the panel is a browser component");
expectSourceContains(pageSource, "ChargebackPanel", "which the office's dispute page renders");
expectSourceContains(pageSource, "readChargebackScreen(", "after reading the programme for the actor");
expectSourceContains(pageSource, "mayWatch(actorState.actor)", "and only for a role section 18 gives it to, decided before the read");
expectSourceContains(pageSource, "CHARGEBACK_READ_ROLES", "which is the same list the service asks");

const panelCalls = panelSource.split('method: "POST"').length - 1;
const panelSpreads = panelSource.split("...(await csrfHeaders())").length - 1;

expectEqual(panelCalls, 3, "the panel sends three mutations: the thresholds, a step and a clearing");
expectEqual(panelSpreads, 3, "each carrying its own token");
expectSourceContains(panelSource, "deviceProofHeaders(", "and each signed with the enrolled device");
expectSourceContains(panelSource, 'role="alert"', "a refusal is announced");
expectSourceContains(panelSource, "router.refresh()", "and the page is re-read after every act");
expectSourceContains(panelSource, "readOnly={!view.policy.canEdit}", "the thresholds are read only for a role that may not set them");
expectSourceContains(panelSource, "disabled={busy}", "and a button is disabled while an act is in flight");
expectSourceContains(panelSource, "CHARGEBACK_NOTE_MAXIMUM_LENGTH", "the sentences are bounded in the browser too");
expectSourceLacks(panelSource, "console.", "the panel prints nothing");
expectSourceContains(panelSource, "view.canSuspend && step.kind !== \"suspension\"", "a suspension is not offered a clearing");
expectSourceContains(pageSource, "state.chargeback === null ? null : (", "the page offers no panel without a reading");

const packageSource = JSON.parse(await sourceOf("package.json")) as {
  readonly scripts: Readonly<Record<string, string>>;
};

expectEqual(packageSource.scripts["check:chargeback-rate"], "node services/disputes/chargeback-rate-verify.ts", "the gate has its own script");
expect(
  (packageSource.scripts["verify"] ?? "").includes("npm run check:chargeback-rate"),
  "and runs inside `npm run verify`",
);

// ---------------------------------------------------------------------------------------------
// 14. Every message exists
// ---------------------------------------------------------------------------------------------

const messages = new Map<string, string>();

function collect(node: unknown, prefix: string): void {
  if (typeof node === "string") {
    messages.set(prefix, node);

    return;
  }

  if (typeof node !== "object" || node === null) {
    return;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collect(value, prefix.length === 0 ? key : `${prefix}.${key}`);
  }
}

collect(en, "");

function messagePathsIn(source: string): readonly string[] {
  const found: string[] = [];

  for (const match of source.matchAll(/(?:getMessage|formatMessage)\("([a-z][A-Za-z0-9_.]*)"\)?/gu)) {
    found.push(match[1] ?? "");
  }

  return found;
}

const rateSource = await sourceOf("services/disputes/chargeback-rate.ts");
const used = [
  ...new Set([
    ...messagePathsIn(panelSource),
    ...messagePathsIn(pageSource),
    ...messagePathsIn(rateSource),
  ]),
].sort();

for (const path of used) {
  expect(messages.has(path), `the message ${path} exists`);
}

const warningSubject = messages.get("email.chargebackWarning.subject");

expect(warningSubject !== undefined, "the warning has a subject");
expect((warningSubject ?? "").length <= 160, "and `0061`'s ceiling holds it");
expectEqual(CHARGEBACK_TEMPLATE_KEY, "dispute_update", "and the notice is one of `0061`'s twenty templates");

// ---------------------------------------------------------------------------------------------
// 15. The words
// ---------------------------------------------------------------------------------------------

expectEqual(CHARGEBACK_KINDS.length, 3, "three steps, as section 18 names them");
expectEqual(Object.keys(CHARGEBACK_RULES).length, 10, "ten rules for a screen to read");
expect(
  Object.values(CHARGEBACK_RULES).every((rule) => /^[a-z][a-z0-9_]+$/u.test(rule)),
  "each rule is a machine word, not a sentence",
);
expectEqual(CHARGEBACK_THRESHOLDS.warningRateBps.maximum, 10_000, "a bar may not exceed a hundred percent");
expectEqual(CHARGEBACK_THRESHOLDS.minimumTransactions.minimum, 0, "and a minimum may be zero transactions");
expect(CHARGEBACK_POLICY_DEFAULTS.warningRateBps <= CHARGEBACK_POLICY_DEFAULTS.reserveRateBps, "the defaults are ordered");

// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(`chargeback rate gate failed with ${String(failures.length)} problem(s):\n`);

  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }

  process.exitCode = 1;
} else {
  process.stdout.write(
    `chargeback rate gate passed: ${String(checkCount)} checks, section 18's rate read as a pair of counts over a ` +
      "window, the step decided from the highest bar the rate clears above the minimum count, a warning and an " +
      "extra reserve taken by the platform and a suspension by a named officer, every effect named on the row, " +
      "and seven thresholds a super administrator owns\n",
  );
}
