// path: services/invoices/invoice-pdf-state.ts

/**
 * The vocabulary of one invoice's rendered PDF: the states it can be in and the shape a screen reads.
 *
 * ## Why this is its own module
 *
 * The panel that shows a merchant the state of their document is a client component, and the service
 * that produces that state is server only - it renders through `node:zlib`, seals through the file
 * encryption and stores through the adapter registry. A browser file that imported the state's name from
 * the service would pull all of that into the bundle it ships, so the words live here instead: no import
 * in this file, nothing to bundle but a type and four strings.
 *
 * ## Why `none` is not a status
 *
 * `0115` has four statuses and a row is only written when a merchant asks for a render, so "nothing has
 * been asked for yet" is not a row with a status - it is the absence of one. A screen still has to word
 * it, and the word belongs beside the four the database knows rather than being invented in a component,
 * where a second screen would invent a second one.
 */

/** The lifecycle of one render, as `0115`'s status check lists it. */
export const INVOICE_DOCUMENT_STATUSES = ["queued", "rendering", "ready", "failed"] as const;

export type InvoiceDocumentStatus = (typeof INVOICE_DOCUMENT_STATUSES)[number];

/** The state a screen sees before any render was ever asked for. Not a row: the absence of one. */
export const INVOICE_PDF_NO_DOCUMENT = "none";

export type InvoicePdfStateStatus = typeof INVOICE_PDF_NO_DOCUMENT | InvoiceDocumentStatus;

/** Every state a screen can be told, so a switch over them is exhaustive. */
export const INVOICE_PDF_STATE_STATUSES: readonly InvoicePdfStateStatus[] = [
  INVOICE_PDF_NO_DOCUMENT,
  ...INVOICE_DOCUMENT_STATUSES,
];

/**
 * What a screen knows about one invoice's PDF.
 *
 * Carried as JSON from the state endpoint, so every field is a string, a number, a boolean or null: no
 * bigint, which JSON cannot carry, and no bytes, which belong to the download.
 */
export interface InvoicePdfState {
  readonly invoiceId: string;
  /** `none` until a render was asked for; one of the four `0115` statuses after that. */
  readonly status: InvoicePdfStateStatus;
  readonly documentId: string | null;
  /** Completed renders. Zero until the first one lands. */
  readonly generation: number;
  readonly attempts: number;
  readonly byteSize: number | null;
  readonly renderedAt: string | null;
  readonly queuedAt: string | null;
  /** A code from the STEP 008 catalog, which is all a merchant is told about a failure. */
  readonly lastErrorCode: string | null;
  /** True when there are bytes to download, which is the only fact a download link depends on. */
  readonly ready: boolean;
  readonly version: number | null;
}
