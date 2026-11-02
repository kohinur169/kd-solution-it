// path: services/kyc/kyc-document-types.ts

/**
 * The document types of `0049`'s check, in its own module so the client form can import the list
 * without pulling the capture service's server-only imports (`node:crypto`) into the browser
 * bundle - the same split `business-address-fields.ts` makes for the address form. The service
 * re-exports the list, so server code has one import path.
 */

/** The document types `0049`'s check allows, in the order the form lists them. */
export const KYC_DOCUMENT_TYPES = [
  "identity_document",
  "business_registration",
  "utility_bill",
  "bank_statement",
  "source_of_funds",
  "processor_request",
] as const;

/** One document type of `0049`. */
export type KycDocumentType = (typeof KYC_DOCUMENT_TYPES)[number];

/**
 * Section 5's address verification rule: a utility bill must be issued within the last three
 * months. Kept here, next to the type list, so the client form can pre-check the date picker
 * without importing the capture service's server-only modules; the service re-exports both.
 */
export const UTILITY_BILL_MAX_AGE_MONTHS = 3;

/** Today at `nowMs` as a date-only string, YYYY-MM-DD. Such strings compare lexically. */
export function dateStringOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** A date-only string minus `months` calendar months, as a date-only string (UTC arithmetic). */
export function dateStringMinusMonths(dateIso: string, months: number): string {
  const shifted = new Date(`${dateIso}T00:00:00.000Z`);

  shifted.setUTCMonth(shifted.getUTCMonth() - months);

  return shifted.toISOString().slice(0, 10);
}

/** The return of {@link utilityBillIssueWindow}: the inclusive date bounds, as YYYY-MM-DD strings. */
export interface UtilityBillIssueWindow {
  readonly earliest: string;
  readonly latest: string;
}

/**
 * The issue dates a utility bill may carry at `nowMs`, as date-only strings (YYYY-MM-DD is
 * order-preserving, so the parser and the form compare them lexically): `latest` is today UTC,
 * because `0049` refuses an issue date after the row's creation, and `earliest` is today minus
 * `UTILITY_BILL_MAX_AGE_MONTHS` calendar months.
 */
export function utilityBillIssueWindow(nowMs: number): UtilityBillIssueWindow {
  const latest = dateStringOf(nowMs);

  return {
    earliest: dateStringMinusMonths(latest, UTILITY_BILL_MAX_AGE_MONTHS),
    latest,
  };
}

/**
 * Section 5's underwriting criteria include the required bank statement period, and the
 * compliance team sets it - so the service takes it as a parameter and this is only the
 * platform's default until the office settings STEP lands. A bank statement covers a period:
 * `issued_at` is where the period starts and `expires_at` where it ends.
 */
export const BANK_STATEMENT_DEFAULT_PERIOD_MONTHS = 3;

/** A statement period must end within the last month: an older period is not current evidence. */
export const BANK_STATEMENT_MAX_AGE_MONTHS = 1;

/** Full calendar months from `startIso` to `endIso`; negative when the end is before the start. */
export function monthsBetweenDates(startIso: string, endIso: string): number {
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const end = new Date(`${endIso}T00:00:00.000Z`);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());

  if (end.getUTCDate() < start.getUTCDate()) {
    months -= 1;
  }

  return months;
}
