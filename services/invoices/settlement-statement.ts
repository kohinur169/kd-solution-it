// path: services/invoices/settlement-statement.ts
import { z } from "zod";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { priceFromMinor } from "../products/price.ts";
import {
  MAXIMUM_STATEMENT_ROWS,
  SETTLEMENT_STATEMENT_ROLES,
  SETTLEMENT_STATEMENT_RULES,
  STATEMENT_SOURCE_TYPES,
  STATEMENT_TYPE_LABELS,
  statementCsvOf,
  statementDaySchema,
  statementFilenameOf,
  statementPeriodSchema,
  statementWindowOf,
  type StatementLine,
  type StatementPeriod,
} from "./settlement-statement-fields.ts";

/**
 * Section 17's settlement statement as CSV: the merchant's settlement balance, one line per movement,
 * for the period the merchant picks.
 *
 * The service reads, and reads only, two tables. `ledger_accounts`, to find the merchant's own
 * `merchant_payable` account - every entry it lists must post to one of them, because that account's
 * balance is what the statement reports. And `ledger_entries`, for the entries on it, in the eight
 * section 17 movements, inside the period, newest first - the order of `0041`'s
 * `ledger_entries_statement_idx`, which exists for this statement and no other.
 *
 * ## Why the write side is nowhere in this file
 *
 * A statement is a reading of a history, and the history it reads is append only by `0041`'s own
 * guard. There is nothing for this service to lock, guard or re-read, and no audit entry to write:
 * the rule that sends one to the audit log is "every mutation", and a read is not a mutation.
 *
 * ## Why the account is looked up and not trusted
 *
 * The account id never comes from the caller. The merchant's `merchant_payable` is found by the
 * merchant id from the session and the account's frozen code, the way `0040` says a chart row keeps
 * its code and its owner. A caller that sent an account id of its own choosing would be choosing the
 * balance to be reported, and a report whose subject its reader picked is not a report.
 */

export interface SettlementStatementDependencies {
  readonly rest: RestClient;
}

export interface SettlementStatementInput {
  readonly actor: RequestActor;
  /** The first day of the period, `YYYY-MM-DD`, or the form's refusal of what it sent instead. */
  readonly from: unknown;
  /** The last day of the period, `YYYY-MM-DD`. */
  readonly to: unknown;
}

export interface SettlementStatementResult {
  /** The file, header and records, ready to send. */
  readonly csv: string;
  /** The movements the file carries, the header not counted. */
  readonly rowCount: number;
  /** The period the file covers, in the days the caller picked. */
  readonly period: StatementPeriod;
  /** The file's own name, with the period on it. */
  readonly filename: string;
}

/** The raw statement: the movements, the period, and the count, before any renderer turns them into a file. */
export interface SettlementStatementLines {
  /** One line per movement, newest first, each signed and labelled. */
  readonly lines: StatementLine[];
  /** The period the statement covers. */
  readonly period: StatementPeriod;
  /** The movements the statement carries, the header not counted. */
  readonly rowCount: number;
}

/** The columns the ledger read takes, one by one (rule 17, never a `*`). */
const ENTRY_COLUMNS =
  "select=id,company_id,account_id,occurred_at,entry_side,amount_minor,currency,source_type,description";

const entryRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  account_id: z.string().uuid(),
  occurred_at: z.string(),
  entry_side: z.enum(["debit", "credit"]),
  amount_minor: z.union([z.string(), z.number()]),
  currency: z.string().length(3),
  source_type: z.enum(STATEMENT_SOURCE_TYPES as readonly [string, ...string[]]),
  description: z.string().nullable(),
});

/** The columns the account read takes: the id the entry query needs, and the facts it is scoped by. */
const ACCOUNT_COLUMNS = "select=id,company_id,account_code,is_active";

const accountRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  account_code: z.literal("merchant_payable"),
  is_active: z.boolean(),
});

/**
 * One day of the period, judged the way the schema judges it, with the field the answer names.
 */
function dayOf(value: unknown, field: "from" | "to"): string {
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field, rule: SETTLEMENT_STATEMENT_RULES.required }],
    });
  }

  const parsed = statementDaySchema.safeParse(value);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field, rule: SETTLEMENT_STATEMENT_RULES.invalid_format }],
    });
  }

  return parsed.data;
}

/**
 * Read the statement for the actor's company: the movements, the period, and the count, in the raw
 * form both renderers turn into a file.
 *
 * The order of the work is the order of the refusals: the role, the period, the account, the entries.
 * Each refusal costs nothing the step after it would have spent, and the period is judged before any
 * read at all, because a period that names no window is not a request for a statement.
 *
 * STEP 125 renders this as CSV; STEP 126 renders the same lines as PDF. The gather is the one place
 * the statement's rules live, so a rule changed here is a rule changed for every file the merchant
 * downloads, not for the one a particular renderer happens to produce.
 */
export async function gatherSettlementLines(
  input: SettlementStatementInput,
  dependencies: SettlementStatementDependencies,
): Promise<SettlementStatementLines> {
  requireAnyRole(input.actor, SETTLEMENT_STATEMENT_ROLES);
  const companyId = requireCompanyId(input.actor);

  const from = dayOf(input.from, "from");
  const to = dayOf(input.to, "to");
  const periodParse = statementPeriodSchema.safeParse({ from, to });

  if (!periodParse.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "to", rule: SETTLEMENT_STATEMENT_RULES.period_reversed }],
    });
  }

  const period = periodParse.data;
  const { fromMs, toMs } = statementWindowOf(period);

  // The account first, because the entry query is scoped to it. A merchant the chart has not given a
  // payable to has no settlement balance and no statement but the header: an empty history is a
  // history, and the file says so by having nothing on it.
  const accounts = await dependencies.rest.select(
    "ledger_accounts",
    `${ACCOUNT_COLUMNS}&company_id=eq.${companyId}&account_code=eq.merchant_payable`,
    accountRowSchema,
  );

  const lines: StatementLine[] = [];

  if (accounts.length > 0) {
    // Both payables a merchant has ever been given: a wrong account is closed and a corrected one
    // opened beside it, `0040`'s way, and the entries on the closed one are still the balance's history.
    const entries = await dependencies.rest.select(
      "ledger_entries",
      `${ENTRY_COLUMNS}&company_id=eq.${companyId}` +
        `&account_id=in.(${accounts.map((account) => account.id).join(",")})` +
        `&source_type=in.(${STATEMENT_SOURCE_TYPES.join(",")})` +
        `&occurred_at=gte.${new Date(fromMs).toISOString()}` +
        `&occurred_at=lt.${new Date(toMs).toISOString()}` +
        "&order=occurred_at.desc,id.desc" +
        `&limit=${MAXIMUM_STATEMENT_ROWS + 1}`,
      entryRowSchema,
    );

    if (entries.length > MAXIMUM_STATEMENT_ROWS) {
      // One more than the ceiling is the signal the period is wider than a statement, and the answer
      // is the period named, not the file: a document a person cannot finish reading is not a document.
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "period", rule: SETTLEMENT_STATEMENT_RULES.statement_too_long }],
      });
    }

    for (const entry of entries) {
      // A credit to the payable is money the balance gains; a debit is money it loses. The sign is the
      // side, because `0040` pairs the account's kind with its normal side and the entry with a side.
      const amount = priceFromMinor(BigInt(String(entry.amount_minor)));

      lines.push({
        date: entry.occurred_at,
        label: STATEMENT_TYPE_LABELS[entry.source_type] ?? entry.source_type,
        amount: entry.entry_side === "credit" ? amount : `-${amount}`,
        currency: entry.currency,
        description: entry.description ?? "",
      });
    }
  }

  return { lines, period, rowCount: lines.length };
}

/**
 * Build the statement as CSV for the actor's company.
 *
 * The gather does every rule; this function renders. The file is the header and the records, nothing
 * else: a totals row is a document's job (STEP 126's PDF), not a file a spreadsheet opens.
 */
export async function buildSettlementStatement(
  input: SettlementStatementInput,
  dependencies: SettlementStatementDependencies,
): Promise<SettlementStatementResult> {
  const { lines, period, rowCount } = await gatherSettlementLines(input, dependencies);

  return {
    csv: statementCsvOf(lines),
    rowCount,
    period,
    filename: statementFilenameOf(period),
  };
}
