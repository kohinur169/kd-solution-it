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

/**
 * The issue dates a utility bill may carry at `nowMs`, as date-only strings (YYYY-MM-DD is
 * order-preserving, so the parser and the form compare them lexically): `latest` is today UTC,
 * because `0049` refuses an issue date after the row's creation, and `earliest` is today minus
 * `UTILITY_BILL_MAX_AGE_MONTHS` calendar months.
 */
/** The return of {@link utilityBillIssueWindow}: the inclusive date bounds, as YYYY-MM-DD strings. */
export interface UtilityBillIssueWindow {
  readonly earliest: string;
  readonly latest: string;
}

export function utilityBillIssueWindow(nowMs: number): UtilityBillIssueWindow {
  const latest = new Date(nowMs);
  const earliest = new Date(nowMs);

  earliest.setUTCMonth(earliest.getUTCMonth() - UTILITY_BILL_MAX_AGE_MONTHS);

  return {
    earliest: earliest.toISOString().slice(0, 10),
    latest: latest.toISOString().slice(0, 10),
  };
}
