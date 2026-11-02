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
