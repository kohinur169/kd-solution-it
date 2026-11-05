// path: services/invoices/settlement-statement-fields.ts
import { z } from "zod";
import type { PlatformRole } from "../../lib/auth/types.ts";
import { deepFreeze } from "../../lib/utils/freeze.ts";

/**
 * Section 17's settlement statement, in the parts the service, the route, the screen and the gate
 * must all read the same way.
 *
 * ## What a statement is
 *
 * A merchant's settlement balance is the balance of one ledger account: `merchant_payable`, the
 * liability account `0040` keeps per merchant, "what the platform owes the merchant". Every money
 * movement that touches the balance posts one entry to it - the other side of the double entry posts
 * to the counterparty's account - so the entries on the payable, in the order the money moved, are
 * the balance's own history. That history, for the period the merchant picks, is the statement:
 * `0041`'s `ledger_entries_statement_idx` is the index the database built for it, "the merchant
 * statement, newest first", and `occurred_at` is the instant the column comment names as "what the
 * statement orders by".
 *
 * ## Why eight of the ten movements
 *
 * Section 17 says a statement "shows payments, fees, holds, reserve, refunds, chargebacks and
 * payouts". Mapped onto `0041`'s closed vocabulary of ten, that is the eight types this file lists:
 * the payment, the two fee words, the hold, the reserve, the refund, the chargeback and the payout.
 * The two that stay out stay out on purpose. `settlement` is the batch the statement is about - its
 * net is the sum of the rows the statement lists, and a row for it would count the period's money
 * twice. `subscription_charge` is the platform billing the merchant for the software, section 12, and
 * is not settlement money at all.
 *
 * ## Why the sign comes from the side
 *
 * `merchant_payable` is a credit account by `0040`'s pairing check, so a credit to it is money the
 * balance gains and a debit is money it loses. The statement says that with one signed amount
 * instead of two columns: the merchant reconciles a plus against a sale and a minus against a fee,
 * the same way a bank statement is read.
 *
 * ## Why the period is two dates
 *
 * A statement covers a stretch of days, the way a processor's monthly statement does. The merchant
 * picks a first day and a last day, and the window is both of them, whole: from the start of the
 * first day to the start of the day after the last, counted in UTC because the platform keeps one
 * clock. The window is half open at the end for the same reason every range in this codebase is: an
 * entry exactly at the closing instant belongs to the next period.
 */

/** The role that reads a statement: the merchant's own, as section 17's "merchants" is written. */
export const SETTLEMENT_STATEMENT_ROLES: readonly PlatformRole[] = Object.freeze(["owner"] as const);

/**
 * The eight section 17 movements, in the order the screen reads them.
 *
 * The two words that stay out of a statement, `settlement` and `subscription_charge`, are absent from
 * this list rather than present and filtered: a list that carries its own exclusions is a list the
 * next reader has to re-read to learn what counts.
 */
export const STATEMENT_SOURCE_TYPES: readonly string[] = Object.freeze([
  "payment",
  "platform_fee",
  "hold",
  "reserve",
  "refund",
  "chargeback",
  "chargeback_fee",
  "payout",
]);

/** The word each movement carries on the statement, closed on the eight. */
export const STATEMENT_TYPE_LABELS: Readonly<Record<string, string>> = deepFreeze({
  payment: "Payment",
  platform_fee: "Platform fee",
  hold: "Hold",
  reserve: "Reserve",
  refund: "Refund",
  chargeback: "Chargeback",
  chargeback_fee: "Chargeback fee",
  payout: "Payout",
});

/**
 * The most movements one statement carries.
 *
 * A statement is one document, and a document is something a person opens. Ten thousand lines is
 * already past any spreadsheet a merchant will reconcile by eye, and the answer to a wider period is
 * a narrower period, not a file that takes a minute to load and a night to check.
 */
export const MAXIMUM_STATEMENT_ROWS = 10_000;

/** The statement's header row, in the column order every row follows. */
export const STATEMENT_CSV_HEADER = "date,type,amount,currency,description";

/** The rule vocabulary the service answers with, for the screen's sentences. */
export const SETTLEMENT_STATEMENT_RULES = {
  /** A date the form did not send at all. */
  required: "required",
  /** A date not in the form the period takes. */
  invalid_format: "invalid_format",
  /** A first day after the last day. */
  period_reversed: "period_reversed",
  /** A period wider than `MAXIMUM_STATEMENT_ROWS` movements. */
  statement_too_long: "statement_too_long",
} as const;

/** One day of the period, `YYYY-MM-DD`, the form the statement takes. */
export const statementDaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, SETTLEMENT_STATEMENT_RULES.invalid_format)
  .refine(
    (value) => {
      const instant = Date.parse(`${value}T00:00:00.000Z`);

      if (!Number.isFinite(instant)) {
        return false;
      }

      // A calendar date and a date string are different things: the second must name a day that
      // exists, which the round trip through the instant is what checks.
      return new Date(instant).toISOString().slice(0, 10) === value;
    },
    SETTLEMENT_STATEMENT_RULES.invalid_format,
  );

/** The period a statement covers: a first day and a last day, the first on or before the last. */
export const statementPeriodSchema = z
  .object({
    from: statementDaySchema,
    to: statementDaySchema,
  })
  .refine(
    (value) => value.from <= value.to,
    { message: SETTLEMENT_STATEMENT_RULES.period_reversed },
  );

export type StatementPeriod = z.infer<typeof statementPeriodSchema>;

/**
 * The window the period names, in the instant the query compares against.
 *
 * Both days whole: from the start of the first to the start of the day after the last, UTC.
 */
export function statementWindowOf(period: StatementPeriod): {
  readonly fromMs: number;
  readonly toMs: number;
} {
  const fromMs = Date.parse(`${period.from}T00:00:00.000Z`);
  const toMs = Date.parse(`${period.to}T00:00:00.000Z`) + 86_400_000;

  return { fromMs, toMs };
}

/** One line of the statement, ready for the file. */
export interface StatementLine {
  /** The instant the money moved, ISO 8601 in UTC, the statement's date column. */
  readonly date: string;
  /** The movement's word, the statement's type column. */
  readonly label: string;
  /** The signed amount in the printed form, a credit positive and a debit negative. */
  readonly amount: string;
  /** The currency the entry posted in. */
  readonly currency: string;
  /** The words `0041` says are "what the merchant reads on the statement", empty when there are none. */
  readonly description: string;
}

/**
 * One CSV field, written the way `0019`'s reader expects it.
 *
 * A field that carries a comma, a quote or a line break is quoted, and a quote inside one is doubled:
 * the four rules of RFC 4180, the same rules the import reader implements, so a statement the
 * platform writes is one its own reader reads back without a shifted column.
 */
export function csvCell(value: string): string {
  if (/[",\r\n]/u.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }

  return value;
}

/** The statement as a file: the header, one record per line, a record break after the last. */
export function statementCsvOf(lines: readonly StatementLine[]): string {
  const records = [STATEMENT_CSV_HEADER];

  for (const line of lines) {
    records.push(
      [line.date, csvCell(line.label), line.amount, line.currency, csvCell(line.description)].join(","),
    );
  }

  return `${records.join("\r\n")}\r\n`;
}

/** The file's own name, with the period it covers. */
export function statementFilenameOf(period: StatementPeriod): string {
  return `settlement-statement_${period.from}_${period.to}.csv`;
}
