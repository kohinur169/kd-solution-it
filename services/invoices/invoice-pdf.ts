// path: services/invoices/invoice-pdf.ts
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { formatMessage, getMessage } from "../../lib/i18n/messages.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { basisPointsToPercent } from "./invoice-discount.ts";
import { INVOICE_STATUSES, type InvoiceStatus } from "./invoice-fields.ts";
import { decodeInvoicePdfImage, type InvoicePdfImage } from "./invoice-pdf-image.ts";
import { thousandthsToQuantity, quantityToThousandths } from "./invoice-totals.ts";

/**
 * The invoice PDF of section 16, rendered here and run as a background job by `invoice-pdf-document.ts`.
 *
 * ## Why this file writes PDF bytes instead of importing a library
 *
 * Rule 17 and section 28 put PDF generation outside the request path, and `package.json` is
 * integrator-owned, so a renderer that needed a new dependency could not ship in this STEP. What an
 * invoice needs from PDF is small and fixed: two of the fourteen standard fonts, text at absolute
 * positions, hairlines, one image, and a page break. That is the subset written here - PDF 1.4, `Helvetica`
 * and `Helvetica-Bold` with `WinAnsiEncoding`, Flate-compressed content streams, a cross reference table
 * with real byte offsets and a deterministic file identifier. No embedded font program, no JavaScript, no
 * annotation and no action: nothing a reader could execute, which is also why the document survives the
 * platform's own magic byte check on the way into storage.
 *
 * ## Deterministic bytes
 *
 * One document renders to the same bytes every time. Nothing inside reads a clock or a random source:
 * the instant it prints is `generatedAt`, supplied by the caller, and the trailer identifier is the
 * SHA-256 of the file's own body. Two renders of the same invoice are therefore byte-identical, so the
 * stored hash is a real fingerprint of the document rather than of the moment it was made, and the gate
 * can compare two renders instead of trusting one.
 *
 * ## The money
 *
 * Every amount arrives as `bigint` minor units - the ten-thousandths of a dollar `0022` stores - and
 * leaves as text produced by integer arithmetic only (rule 2). A document amount prints at the cent
 * with half-away-from-zero rounding, thousands separated; a unit price keeps its own scale, because a
 * price of `0.0125` printed as `0.01` would make the line's arithmetic unreadable. The summary prints
 * the stored columns, never a re-summation of the printed lines: the database is the document of
 * record, and a line carrying a fraction of a cent is the only case where the two can differ by a
 * rounding step.
 *
 * ## The words
 *
 * Rule 1 keeps user-facing copy in the catalog, and a PDF is a document a client reads, so every label
 * on it - the stamp, the column heads, the totals, the footer - is a message read through
 * `invoicePdfLabels()`. The renderer itself holds no English: it places the strings it is given.
 *
 * ## The merchant's own brand
 *
 * Section 16 line 184 - "Merchants can set their own logo and invoice branding" - is what STEP 118 adds to
 * this document, and it changes the header from one column into two: the merchant's own identity on the
 * left (logo, name, tagline, address, contact) and the document's identity on the right (the word INVOICE,
 * the number, the status). That is the layout a client expects, and it is the one place a merchant's brand
 * belongs on a document that leaves the building.
 *
 * The identity is read at render time from `0116` and the merchant's business profile, never copied into
 * the document row, so a merchant who moves office does not have to re-save their branding to fix the next
 * invoice. What `0116` stores is the *choice*: which stored logo prints, which of the profile's facts are
 * shown, the tagline, the note above the footer, and the accent colour of the rule under the letterhead. The accent is applied to lines and never to text, so a merchant cannot make a sentence
 * unreadable with it.
 *
 * The logo is the one image this writer draws, on the first page only, inside a box of
 * `INVOICE_PDF_LOGO_MAXIMUM_WIDTH` by `INVOICE_PDF_LOGO_MAXIMUM_HEIGHT` points and never scaled up: a small
 * logo printed at its own pixel size is sharp, and the same logo stretched to fill the box is not. Reading
 * the bytes into samples is `invoice-pdf-image.ts`; this file only places them.
 *
 * ## Text that has to survive the format
 *
 * A PDF literal string is bytes in `WinAnsiEncoding`, so text is encoded rather than copied: the nine
 * typographic characters the source guard allows, the Latin-1 letters a client name may carry, and the
 * Windows-1252 punctuation all map to their own byte; a parenthesis or a backslash is escaped; a code
 * point `WinAnsi` does not have becomes `?`. Widths come from the faces' own metric tables, which is
 * what lets a column right-align to the point instead of to a guess.
 */

/** The content type the upload policy of `lib/security/upload.ts` allows for this purpose. */
export const INVOICE_PDF_CONTENT_TYPE = "application/pdf";

/** The extension a rendered document is stored and downloaded with. */
export const INVOICE_PDF_EXTENSION = ".pdf";

/** The first bytes of every file this module writes. */
export const INVOICE_PDF_HEADER = "%PDF-1.4";

/** The largest document this module will produce: the `invoice_pdf` policy ceiling, not a guess. */
export const INVOICE_PDF_MAXIMUM_BYTES = 26_214_400;

/** United States Letter, the page section 16's "accepted in the United States and globally" prints on. */
export const INVOICE_PDF_PAGE_WIDTH = 612;
export const INVOICE_PDF_PAGE_HEIGHT = 792;

/** The margin on all four sides: three quarters of an inch. */
export const INVOICE_PDF_MARGIN = 54;

/**
 * The box a logo is fitted into, in points, at the top of the first page.
 *
 * Two inches wide and a little over half an inch high is the space a letterhead gives a mark before the
 * document's own words have to start. It is a box and not a size: the logo keeps its aspect ratio and is
 * never scaled *up*, so a small mark prints sharp at its own pixel size instead of blurred to fill a
 * rectangle it did not ask for.
 */
export const INVOICE_PDF_LOGO_MAXIMUM_WIDTH = 144;
export const INVOICE_PDF_LOGO_MAXIMUM_HEIGHT = 44;

/** The one form of the accent colour `0116` stores, which is also the form its column check enforces. */
export const INVOICE_PDF_ACCENT_PATTERN = /^#[0-9a-f]{6}$/u;

/**
 * The name the logo's XObject is given in a page's resources.
 *
 * One image, one name: a document never draws a second picture, so there is no counter and nothing to
 * allocate. The name is exported because the gate reads it back out of the resource dictionary.
 */
export const INVOICE_PDF_LOGO_NAME = "Im1";

/** The faces used. Two of the fourteen standard fonts, so no font program is embedded. */
export const INVOICE_PDF_FONTS = ["regular", "bold"] as const;

export type InvoicePdfFont = (typeof INVOICE_PDF_FONTS)[number];

/** The default width of a glyph no metric table names: the face's own average, not a guess of zero. */
const DEFAULT_GLYPH_WIDTH = 556;

/** Glyph widths in thousandths of a unit, for the 95 printable ASCII code points, 32 to 126. */
const REGULAR_ASCII_WIDTHS: readonly number[] = Object.freeze([
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]);

const BOLD_ASCII_WIDTHS: readonly number[] = Object.freeze([
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]);

/**
 * Widths for the Latin-1 half of `WinAnsiEncoding`, code points 160 to 255.
 *
 * One table serves both faces on purpose. This document prints non-ASCII only inside a client name, an
 * address, a description or a memo, and all four are set in the regular face; the bold face carries
 * labels and amounts, which the English-only catalog keeps ASCII. A bold accented letter would
 * therefore be measured with the regular width, which moves a space, not a fact.
 */
const LATIN1_WIDTHS: readonly number[] = Object.freeze([
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
]);

/**
 * The Windows-1252 range `WinAnsiEncoding` adds below 160, as `[code point, byte, width]`.
 *
 * These are the characters a copied quote or dash arrives as: the en dash and the em dash, the curly
 * quotes, the ellipsis and the bullet, which are exactly the nine the source guard allows, plus the
 * punctuation a client's own accounting system may have put in an address.
 */
const SPECIAL_CHARACTERS: readonly (readonly [number, number, number])[] = Object.freeze([
  [0x20ac, 0x80, 556],
  [0x201a, 0x82, 222],
  [0x0192, 0x83, 556],
  [0x201e, 0x84, 333],
  [0x2026, 0x85, 1000],
  [0x2020, 0x86, 556],
  [0x2021, 0x87, 556],
  [0x02c6, 0x88, 333],
  [0x2030, 0x89, 1000],
  [0x0160, 0x8a, 667],
  [0x2039, 0x8b, 333],
  [0x0152, 0x8c, 1000],
  [0x017d, 0x8e, 611],
  [0x2018, 0x91, 222],
  [0x2019, 0x92, 222],
  [0x201c, 0x93, 333],
  [0x201d, 0x94, 333],
  [0x2022, 0x95, 350],
  [0x2013, 0x96, 556],
  [0x2014, 0x97, 1000],
  [0x02dc, 0x98, 333],
  [0x2122, 0x99, 1000],
  [0x0161, 0x9a, 500],
  [0x203a, 0x9b, 333],
  [0x0153, 0x9c, 944],
  [0x017e, 0x9e, 500],
  [0x0178, 0x9f, 667],
]);

const SPECIAL_BYTES: ReadonlyMap<number, number> = new Map(
  SPECIAL_CHARACTERS.map(([codePoint, byte]) => [codePoint, byte] as const),
);

const SPECIAL_WIDTHS: ReadonlyMap<number, number> = new Map(
  SPECIAL_CHARACTERS.map(([, byte, width]) => [byte, width] as const),
);

/** The byte a code point `WinAnsiEncoding` does not have prints as, so a width is never invented. */
const UNENCODABLE_SUBSTITUTE = 0x3f;

/** One byte of text, as the encoding the two standard fonts use. */
function encodeByte(codePoint: number): number {
  if (codePoint >= 0x20 && codePoint <= 0x7e) {
    return codePoint;
  }

  if (codePoint >= 0xa0 && codePoint <= 0xff) {
    return codePoint;
  }

  return SPECIAL_BYTES.get(codePoint) ?? UNENCODABLE_SUBSTITUTE;
}

function widthOfByte(byte: number, font: InvoicePdfFont): number {
  if (byte >= 32 && byte <= 126) {
    const table = font === "bold" ? BOLD_ASCII_WIDTHS : REGULAR_ASCII_WIDTHS;

    return table[byte - 32] ?? DEFAULT_GLYPH_WIDTH;
  }

  if (byte >= 160 && byte <= 255) {
    return LATIN1_WIDTHS[byte - 160] ?? DEFAULT_GLYPH_WIDTH;
  }

  return SPECIAL_WIDTHS.get(byte) ?? DEFAULT_GLYPH_WIDTH;
}

/**
 * The text as one byte per character, which is what a PDF literal string holds.
 *
 * Every character of the input is encoded, including the ones `WinAnsi` lacks, so the answer's length
 * is the number of bytes the string will occupy and a width measured from it is the width the reader
 * will draw.
 */
export function invoicePdfEncodedText(text: string): string {
  let encoded = "";

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? UNENCODABLE_SUBSTITUTE;

    encoded += String.fromCharCode(encodeByte(codePoint));
  }

  return encoded;
}

/**
 * A PDF literal string: the encoded bytes with the three characters that would end it escaped.
 *
 * Only those three need escaping, because `invoicePdfEncodedText` has already substituted every byte
 * `WinAnsiEncoding` cannot carry - a control character among them. A control byte therefore reaches the
 * document as a question mark rather than as an octal escape, which is the safer of the two: an escape
 * is a way of smuggling a byte past a reader that would have refused the character.
 */
export function invoicePdfLiteral(text: string): string {
  let literal = "";

  for (const character of invoicePdfEncodedText(text)) {
    const byte = character.charCodeAt(0);

    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      literal += `\\${character}`;
      continue;
    }

    literal += character;
  }

  return literal;
}

/** The width of one line of text in points, from the face's own metrics. */
export function invoicePdfTextWidth(text: string, font: InvoicePdfFont, size: number): number {
  let thousandths = 0;

  for (const character of invoicePdfEncodedText(text)) {
    thousandths += widthOfByte(character.charCodeAt(0), font);
  }

  return (thousandths * size) / 1000;
}

/**
 * Break text into lines that fit a column.
 *
 * Words are kept whole and a word longer than the column is broken at the character that overflows it,
 * because a description of one long token that clipped instead would hide what the merchant billed.
 * Line breaks already in the text - a memo of three lines - are honoured first.
 */
export function invoicePdfWrap(
  text: string,
  font: InvoicePdfFont,
  size: number,
  maxWidth: number,
): readonly string[] {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ").filter((word) => word.length > 0);

    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";

    for (const word of words) {
      const candidate = current.length === 0 ? word : `${current} ${word}`;

      if (invoicePdfTextWidth(candidate, font, size) <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current.length > 0) {
        lines.push(current);
        current = "";
      }

      // A word wider than the column on its own: take the characters that fit and repeat.
      let piece = "";

      for (const character of word) {
        const grown = `${piece}${character}`;

        if (piece.length > 0 && invoicePdfTextWidth(grown, font, size) > maxWidth) {
          lines.push(piece);
          piece = character;
          continue;
        }

        piece = grown;
      }

      current = piece;
    }

    lines.push(current);
  }

  return lines.filter((line, index) => line.length > 0 || index === 0);
}

/** Thousands separators for a string of digits, three from the right. */
function groupDigits(digits: string): string {
  const grouped: string[] = [];

  for (let index = digits.length; index > 0; index -= 3) {
    grouped.unshift(digits.slice(Math.max(0, index - 3), index));
  }

  return grouped.join(",");
}

/** Half away from zero at the cent, in integer arithmetic: the rounding `0023` uses, restated. */
function centsOf(minor: bigint): bigint {
  const magnitude = minor < 0n ? -minor : minor;

  return (minor < 0n ? -1n : 1n) * ((magnitude + 50n) / 100n);
}

function printCents(cents: bigint): string {
  const magnitude = cents < 0n ? -cents : cents;
  const dollars = magnitude / 100n;
  const remainder = magnitude % 100n;
  const body = `${groupDigits(dollars.toString())}.${remainder.toString().padStart(2, "0")}`;

  return cents < 0n ? `-${body}` : body;
}

/**
 * A document amount: dollars and cents, thousands separated, half away from zero.
 *
 * `1250000` minor units is `125.0000` in the database and `125.00` on the document.
 */
export function invoicePdfUsd(minor: bigint): string {
  return printCents(centsOf(minor));
}

/**
 * A unit price, at the scale the price actually has.
 *
 * A whole-cent price prints two decimals like every other amount; a price with a fraction of a cent
 * keeps four, because `0.0125` printed as `0.01` would not multiply into the line's amount and the
 * client reading the document would be right to dispute it.
 */
export function invoicePdfUnitPrice(minor: bigint): string {
  if (minor % 100n === 0n) {
    return invoicePdfUsd(minor);
  }

  const magnitude = minor < 0n ? -minor : minor;
  const dollars = magnitude / 10_000n;
  const fraction = magnitude % 10_000n;
  const body = `${groupDigits(dollars.toString())}.${fraction.toString().padStart(4, "0")}`;

  return minor < 0n ? `-${body}` : body;
}

/** A quantity as the merchant typed it: `2.500` becomes `2.5`, `1.000` becomes `1`. */
export function invoicePdfQuantity(quantity: string): string {
  return thousandthsToQuantity(quantityToThousandths(quantity) ?? 0n);
}

/** The date half of an ISO instant, which is the scale an invoice date is read at. */
function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

/** The instant the footer prints, to the minute: `2026-11-04 09:00`. */
function instantOf(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

/** The PDF date format of the same instant: `D:20261104090000Z`. */
function pdfDateOf(epochMs: number): string {
  return `D:${new Date(epochMs).toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}Z`;
}

/** The seven status words as the document prints them, from the catalog. */
export interface InvoicePdfStatusWords {
  readonly draft: string;
  readonly sent: string;
  readonly viewed: string;
  readonly partiallyPaid: string;
  readonly paid: string;
  readonly overdue: string;
  readonly void: string;
}

/** Every word this document prints that is not data. Rule 1: all of it is catalog copy. */
export interface InvoicePdfLabels {
  readonly title: string;
  readonly draftStamp: string;
  readonly numberLabel: string;
  readonly notIssued: string;
  readonly billedTo: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly status: string;
  readonly statusWords: InvoicePdfStatusWords;
  readonly columnLine: string;
  readonly columnDescription: string;
  readonly columnQuantity: string;
  readonly columnUnit: string;
  readonly columnUnitPrice: string;
  readonly columnDiscount: string;
  readonly columnAmount: string;
  readonly noLines: string;
  readonly subtotal: string;
  readonly discount: string;
  readonly tax: string;
  readonly total: string;
  readonly amountPaid: string;
  readonly balanceDue: string;
  readonly memo: string;
  readonly currencyNote: string;
}

/**
 * The labels of one document.
 *
 * The discount label is resolved here rather than in the renderer, because a percentage discount reads
 * as `Discount (12.5%)` and the percentage is a fact of the document: the renderer places words, it
 * does not compose sentences.
 */
export function invoicePdfLabels(discountPercent: string | null): InvoicePdfLabels {
  return {
    title: getMessage("invoices.pdfTitle"),
    draftStamp: getMessage("invoices.pdfDraftStamp"),
    numberLabel: getMessage("invoices.pdfNumberLabel"),
    notIssued: getMessage("invoices.pdfNotIssued"),
    billedTo: getMessage("invoices.pdfBilledTo"),
    issueDate: getMessage("invoices.pdfIssueDate"),
    dueDate: getMessage("invoices.pdfDueDate"),
    status: getMessage("invoices.pdfStatus"),
    statusWords: {
      draft: getMessage("invoices.pdfStatusDraft"),
      sent: getMessage("invoices.pdfStatusSent"),
      viewed: getMessage("invoices.pdfStatusViewed"),
      partiallyPaid: getMessage("invoices.pdfStatusPartiallyPaid"),
      paid: getMessage("invoices.pdfStatusPaid"),
      overdue: getMessage("invoices.pdfStatusOverdue"),
      void: getMessage("invoices.pdfStatusVoid"),
    },
    columnLine: getMessage("invoices.pdfColumnLine"),
    columnDescription: getMessage("invoices.pdfColumnDescription"),
    columnQuantity: getMessage("invoices.pdfColumnQuantity"),
    columnUnit: getMessage("invoices.pdfColumnUnit"),
    columnUnitPrice: getMessage("invoices.pdfColumnUnitPrice"),
    columnDiscount: getMessage("invoices.pdfColumnDiscount"),
    columnAmount: getMessage("invoices.pdfColumnAmount"),
    noLines: getMessage("invoices.pdfNoLines"),
    subtotal: getMessage("invoices.pdfSubtotal"),
    discount:
      discountPercent === null
        ? getMessage("invoices.pdfDiscount")
        : formatMessage("invoices.pdfDiscountPercent", { percent: discountPercent }),
    tax: getMessage("invoices.pdfTax"),
    total: getMessage("invoices.pdfTotal"),
    amountPaid: getMessage("invoices.pdfAmountPaid"),
    balanceDue: getMessage("invoices.pdfBalanceDue"),
    memo: getMessage("invoices.pdfMemo"),
    currencyNote: getMessage("invoices.pdfCurrencyNote"),
  };
}

/** The status word a document prints, falling back to the draft word for a status the enum grew. */
function statusWordOf(labels: InvoicePdfLabels, status: string): string {
  const known: Readonly<Record<InvoiceStatus, string>> = {
    draft: labels.statusWords.draft,
    sent: labels.statusWords.sent,
    viewed: labels.statusWords.viewed,
    partially_paid: labels.statusWords.partiallyPaid,
    paid: labels.statusWords.paid,
    overdue: labels.statusWords.overdue,
    void: labels.statusWords.void,
  };

  return (INVOICE_STATUSES as readonly string[]).includes(status)
    ? known[status as InvoiceStatus]
    : labels.statusWords.draft;
}

/** One printed line of the document, with every amount already text. */
export interface InvoicePdfLine {
  readonly position: number;
  readonly description: string;
  readonly unit: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discount: string;
  readonly amount: string;
}

/** Where the logo goes, in points, with the samples it is drawn from. */
export interface InvoicePdfLogoPlacement {
  readonly image: InvoicePdfImage;
  readonly width: number;
  readonly height: number;
}

/**
 * The merchant's half of the header, printable: text already sanitised and wrapped by the caller's column,
 * a colour already turned into the three components a PDF stroke operator takes, and a logo already read
 * into samples and fitted to its box.
 */
export interface InvoicePdfBranding {
  readonly name: string | null;
  readonly tagline: string | null;
  /** Multiline text the header wraps to its own column, as `drawParties` wraps the client's address. */
  readonly address: string | null;
  readonly contact: string | null;
  readonly footerNote: string | null;
  /** Red, green and blue as fractions of one, or null for the default grey. */
  readonly accent: readonly [number, number, number] | null;
  readonly logo: InvoicePdfLogoPlacement | null;
}

/** The whole printable document. Data and words, and nothing that reads a clock or a database. */
export interface InvoicePdfDocument {
  readonly invoiceId: string;
  /** Null while the invoice is a draft, which is what the stamp and the watermark are for. */
  readonly number: string | null;
  readonly status: string;
  readonly currency: string;
  readonly issuedAt: string | null;
  readonly dueAt: string;
  readonly client: {
    readonly name: string;
    readonly email: string | null;
    readonly address: string | null;
  };
  readonly lines: readonly InvoicePdfLine[];
  readonly totals: {
    readonly subtotal: string;
    readonly discount: string;
    readonly tax: string;
    readonly total: string;
    readonly amountPaid: string;
    readonly balanceDue: string;
    /** True when a payment has landed, which is when the paid and balance rows print. */
    readonly hasPayment: boolean;
    /** True when the invoice-level discount is not zero, which is when its row prints. */
    readonly hasDiscount: boolean;
    /** True when tax is not zero, which is when the section 7 tax line prints. */
    readonly hasTax: boolean;
  };
  readonly memo: string | null;
  /** The merchant's own identity and logo, which the header's left column prints. */
  readonly branding: InvoicePdfBranding;
  /** The instant this render is dated with, supplied by the caller so the bytes stay deterministic. */
  readonly generatedAt: string;
  /** The same instant in epoch milliseconds, which is what the file's own metadata carries. */
  readonly generatedAtEpochMs: number;
  readonly labels: InvoicePdfLabels;
}

/** The invoice the document is built from, in the columns the renderer prints. */
export interface InvoicePdfSourceInvoice {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly currency: string;
  readonly subtotalMinor: bigint;
  readonly discountMinor: bigint;
  readonly discountPercentBasisPoints: number;
  readonly taxMinor: bigint;
  readonly totalMinor: bigint;
  readonly amountPaidMinor: bigint;
  readonly clientName: string;
  readonly clientEmail: string | null;
  readonly clientAddress: string | null;
  readonly memo: string | null;
  readonly issuedAt: string | null;
  readonly dueAt: string;
}

/** One line of `0023`, in the columns the renderer prints. */
export interface InvoicePdfSourceLine {
  readonly position: number;
  readonly description: string;
  readonly unit: string;
  /** The decimal text of `numeric(12,3)`. */
  readonly quantity: string;
  readonly unitPriceMinor: bigint;
  readonly discountMinor: bigint;
  readonly lineTotalMinor: bigint;
}

/**
 * The merchant's own half of the document, as the facts `0116` and the business profile hold them.
 *
 * Every field is nullable because a merchant who has set nothing still gets a complete invoice: the header
 * simply prints the parts that exist. The bytes are the logo as it came out of storage, still sealed-open
 * and still in whatever format the merchant uploaded; deciding whether they can be drawn is the renderer's
 * job, through `invoice-pdf-image.ts`, and a refusal is a job failure with a code rather than a document
 * with a hole in it.
 */
export interface InvoicePdfSourceBranding {
  /** The name that prints, already chosen between the trading and the legal name by `0116`'s `name_style`. */
  readonly name: string | null;
  readonly tagline: string | null;
  /** The address as one multiline string, which the renderer wraps to the column. */
  readonly address: string | null;
  /** The contact lines as one multiline string: an email, a phone, whichever the merchant chose to show. */
  readonly contact: string | null;
  readonly footerNote: string | null;
  /** `#rrggbb` for the rule under the letterhead, or null for the default grey. */
  readonly accentHex: string | null;
  readonly logo: { readonly bytes: Uint8Array; readonly contentType: string } | null;
}

export interface InvoicePdfSource {
  readonly invoice: InvoicePdfSourceInvoice;
  readonly lines: readonly InvoicePdfSourceLine[];
  readonly branding: InvoicePdfSourceBranding;
  readonly generatedAtEpochMs: number;
}

/**
 * The accent colour as the three fractions of one that a PDF stroke operator takes.
 *
 * A value that does not match `0116`'s own check answers null rather than throwing. The check is enforced by
 * the column and by the service, so a bad value here means a row that predates the check, and failing an
 * invoice over the colour of a rule would be a worse answer than drawing the default grey.
 */
function accentOf(hex: string | null): readonly [number, number, number] | null {
  if (hex === null || !INVOICE_PDF_ACCENT_PATTERN.test(hex)) {
    return null;
  }

  const value = Number.parseInt(hex.slice(1), 16);

  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * Read the merchant's logo into samples and fit it to its box.
 *
 * The decode happens here rather than in the service so the renderer stays the only module that has to know
 * what a PDF can hold: a format `invoice-pdf-image.ts` refuses becomes an `AppError` carrying the reason,
 * which the job records as its failure code and the merchant sees as one sentence. The scale is capped at
 * one, which is the "never scaled up" half of the box's own comment.
 */
function logoPlacementOf(logo: InvoicePdfSourceBranding["logo"]): InvoicePdfLogoPlacement | null {
  if (logo === null) {
    return null;
  }

  const image = decodeInvoicePdfImage(logo.bytes, logo.contentType);
  const scale = Math.min(
    INVOICE_PDF_LOGO_MAXIMUM_WIDTH / image.width,
    INVOICE_PDF_LOGO_MAXIMUM_HEIGHT / image.height,
    1,
  );

  return { image, width: image.width * scale, height: image.height * scale };
}

/**
 * The printable document of one invoice.
 *
 * Every text field passes the sanitiser again on the way in. The values were sanitised when they were
 * stored, and this is a second door rather than a doubt: a PDF is a new surface, a name that reaches it
 * is printed on a document a client keeps, and `sanitizeSingleLineText` is what makes the byte count
 * this module measured the byte count the reader will draw.
 */
export function invoicePdfDocumentOf(source: InvoicePdfSource): InvoicePdfDocument {
  const invoice = source.invoice;
  const discountPercent =
    invoice.discountPercentBasisPoints > 0
      ? basisPointsToPercent(BigInt(invoice.discountPercentBasisPoints))
      : null;
  const labels = invoicePdfLabels(discountPercent);
  const balanceMinor = invoice.totalMinor - invoice.amountPaidMinor;

  return {
    invoiceId: invoice.id,
    number: invoice.number === null ? null : sanitizeSingleLineText(invoice.number, 40),
    status: invoice.status,
    currency: sanitizeSingleLineText(invoice.currency, 3),
    issuedAt: invoice.issuedAt,
    dueAt: invoice.dueAt,
    client: {
      name: sanitizeSingleLineText(invoice.clientName, 160),
      email: invoice.clientEmail === null ? null : sanitizeSingleLineText(invoice.clientEmail, 254),
      address: invoice.clientAddress === null ? null : sanitizeMultilineText(invoice.clientAddress, 600),
    },
    lines: source.lines.map((line) => ({
      position: line.position,
      description: sanitizeMultilineText(line.description, 300),
      unit: sanitizeSingleLineText(line.unit, 12),
      quantity: invoicePdfQuantity(line.quantity),
      unitPrice: invoicePdfUnitPrice(line.unitPriceMinor),
      discount: line.discountMinor === 0n ? "" : invoicePdfUsd(line.discountMinor),
      amount: invoicePdfUsd(line.lineTotalMinor),
    })),
    totals: {
      subtotal: invoicePdfUsd(invoice.subtotalMinor),
      discount: invoicePdfUsd(invoice.discountMinor),
      tax: invoicePdfUsd(invoice.taxMinor),
      total: invoicePdfUsd(invoice.totalMinor),
      amountPaid: invoicePdfUsd(invoice.amountPaidMinor),
      balanceDue: invoicePdfUsd(balanceMinor),
      hasPayment: invoice.amountPaidMinor > 0n,
      hasDiscount: invoice.discountMinor > 0n,
      hasTax: invoice.taxMinor > 0n,
    },
    memo: invoice.memo === null ? null : sanitizeMultilineText(invoice.memo, 2_000),
    // The branding ceilings are `0116`'s own: a name and a tagline of 120, a note of 300. The address and
    // the contact lines are assembled from profile columns whose own checks are tighter, and 400 and 300 are
    // the room the header column has, not a new limit on anybody's data.
    branding: {
      name: source.branding.name === null ? null : sanitizeSingleLineText(source.branding.name, 120),
      tagline: source.branding.tagline === null ? null : sanitizeSingleLineText(source.branding.tagline, 120),
      address: source.branding.address === null ? null : sanitizeMultilineText(source.branding.address, 400),
      contact: source.branding.contact === null ? null : sanitizeMultilineText(source.branding.contact, 300),
      footerNote:
        source.branding.footerNote === null ? null : sanitizeMultilineText(source.branding.footerNote, 300),
      accent: accentOf(source.branding.accentHex),
      logo: logoPlacementOf(source.branding.logo),
    },
    generatedAt: instantOf(source.generatedAtEpochMs),
    generatedAtEpochMs: source.generatedAtEpochMs,
    labels,
  };
}

/* ---- the geometry ---- */

const CONTENT_RIGHT = INVOICE_PDF_PAGE_WIDTH - INVOICE_PDF_MARGIN;
const CONTENT_BOTTOM = 64;
const FOOTER_BASELINE = 36;

/** The six columns of the line table, as left or right edges in points. */
const COLUMN = Object.freeze({
  positionLeft: 54,
  descriptionLeft: 82,
  descriptionWidth: 204,
  quantityRight: 328,
  unitLeft: 334,
  unitPriceRight: 440,
  discountRight: 498,
  amountRight: 558,
});

const SIZE = Object.freeze({
  title: 22,
  number: 15,
  stamp: 15,
  heading: 8,
  client: 11,
  /** The merchant's own name, at the same weight and size as the client's: neither outranks the other. */
  merchant: 11,
  tagline: 8.5,
  /** The address, the contact lines and the note above the footer. */
  identity: 8.5,
  body: 9.5,
  tableHead: 8,
  totalLabel: 10,
  totalValue: 10,
  grandTotal: 12,
  footer: 8,
  watermark: 76,
});

const LEADING = Object.freeze({
  heading: 12,
  body: 13,
  /** The merchant's own block: tighter than the body, because it is a letterhead and not a sentence. */
  identity: 11,
  /** The gap under a logo, so the name does not sit on the mark's own bottom edge. */
  logoGap: 8,
  /** The height of the header's right column - title, number, status - which the left column shares. */
  headerBand: 40,
  tableHead: 16,
  row: 13,
  rowPadding: 7,
  totalRow: 16,
  grandTotalRow: 22,
  block: 20,
});

/** The width the merchant's identity wraps to, which is the width the client block below it wraps to. */
const MERCHANT_WIDTH = 240;

const GREY = Object.freeze({
  rule: 0.78,
  muted: 0.42,
  watermark: 0.9,
});

/** A number printed with at most two decimals, which is the precision a point needs. */
function points(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/** A rule's stroke: either a grey, or the merchant's accent as red, green and blue in fractions of one. */
type RuleStroke = number | readonly [number, number, number];

interface TextPlacement {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly font: InvoicePdfFont;
  readonly size: number;
  readonly align?: "left" | "right";
  readonly grey?: number;
}

/**
 * The page canvas.
 *
 * One instance holds every page's operator list and the cursor of the page being drawn. `reserve` is
 * the only place a page break happens, so the table, the totals and the memo all break the same way and
 * a page is never left with a heading and no content under it.
 */
class InvoicePdfCanvas {
  private readonly pages: string[][] = [[]];
  private cursor = 0;
  private readonly watermark: string | null;

  constructor(watermark: string | null) {
    this.watermark = watermark;
    this.pages[0] = [];
    this.beginPage();
  }

  get pageCount(): number {
    return this.pages.length;
  }

  private get ops(): string[] {
    const current = this.pages[this.pages.length - 1];

    if (current === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "invoice_pdf", reason: "no_page" } });
    }

    return current;
  }

  private beginPage(): void {
    this.cursor = INVOICE_PDF_PAGE_HEIGHT - INVOICE_PDF_MARGIN;

    if (this.watermark === null) {
      return;
    }

    // Rotated 45 degrees about the centre of the page, drawn in a light grey so it is unmistakable and
    // still leaves every line of the document readable.
    const width = invoicePdfTextWidth(this.watermark, "bold", SIZE.watermark);
    const cosine = 0.7071;
    const sine = 0.7071;
    const centreX = INVOICE_PDF_PAGE_WIDTH / 2 - (width / 2) * cosine;
    const centreY = INVOICE_PDF_PAGE_HEIGHT / 2 - (width / 2) * sine;

    this.ops.push(
      `${points(GREY.watermark)} g BT /F2 ${SIZE.watermark} Tf ` +
        `${cosine} ${sine} ${-sine} ${cosine} ${points(centreX)} ${points(centreY)} Tm ` +
        `(${invoicePdfLiteral(this.watermark)}) Tj ET`,
    );
  }

  /** Start a new page when the next block would run into the footer. Answers true when it did. */
  reserve(needed: number): boolean {
    if (this.cursor - needed >= CONTENT_BOTTOM) {
      return false;
    }

    this.pages.push([]);
    this.beginPage();

    return true;
  }

  text(placement: TextPlacement): void {
    const width = invoicePdfTextWidth(placement.text, placement.font, placement.size);
    const x = placement.align === "right" ? placement.x - width : placement.x;
    const face = placement.font === "bold" ? "/F2" : "/F1";
    const grey = placement.grey === undefined ? "" : `${points(placement.grey)} g `;

    this.ops.push(
      `${grey}BT ${face} ${points(placement.size)} Tf 1 0 0 1 ${points(x)} ${points(placement.y)} Tm ` +
        `(${invoicePdfLiteral(placement.text)}) Tj ET`,
    );
  }

  /**
   * A hairline across the content width.
   *
   * The stroke is either a grey - the default, and what every rule inside the table uses - or the merchant's
   * accent as three fractions of one, which is what `0116` stores and what the rule under the letterhead
   * carries. Colour is applied to lines and never to text: a merchant who picks white can make a rule
   * disappear, and cannot make a sentence unreadable.
   */
  rule(y: number, stroke: RuleStroke = GREY.rule): void {
    const colour =
      typeof stroke === "number"
        ? `${points(stroke)} G`
        : `${points(stroke[0])} ${points(stroke[1])} ${points(stroke[2])} RG`;

    this.ops.push(`${colour} 0.7 w ${INVOICE_PDF_MARGIN} ${points(y)} m ${CONTENT_RIGHT} ${points(y)} l S`);
  }

  /**
   * Paint an image XObject into a rectangle, positioned by its bottom left corner.
   *
   * `cm` sets the transform and `Do` paints the named object, and the pair is wrapped in `q`/`Q` so the
   * transform dies with the image instead of moving everything drawn after it - the mistake that would show
   * up as a document whose whole table sits in the corner the logo was in.
   */
  image(name: string, x: number, y: number, width: number, height: number): void {
    this.ops.push(`q ${points(width)} 0 0 ${points(height)} ${points(x)} ${points(y)} cm /${name} Do Q`);
  }

  moveBy(distance: number): void {
    this.cursor -= distance;
  }

  get y(): number {
    return this.cursor;
  }

  /** The footer of every page, written once the page count is known. */
  footers(left: string, pageWord: (page: number, pages: number) => string): void {
    for (const [index, page] of this.pages.entries()) {
      page.push(
        `${points(GREY.muted)} g BT /F1 ${SIZE.footer} Tf 1 0 0 1 ${INVOICE_PDF_MARGIN} ${FOOTER_BASELINE} Tm ` +
          `(${invoicePdfLiteral(left)}) Tj ET`,
      );

      const word = pageWord(index + 1, this.pages.length);
      const width = invoicePdfTextWidth(word, "regular", SIZE.footer);

      page.push(
        `${points(GREY.muted)} g BT /F1 ${SIZE.footer} Tf 1 0 0 1 ${points(CONTENT_RIGHT - width)} ` +
          `${FOOTER_BASELINE} Tm (${invoicePdfLiteral(word)}) Tj ET`,
      );
    }
  }

  /** Every page's operators, in page order. */
  streams(): readonly string[] {
    return this.pages.map((page) => page.join("\n"));
  }
}

/* ---- the writer ---- */

interface PdfObject {
  readonly bytes: Buffer;
}

/**
 * The file assembler: numbered objects, a cross reference table of real byte offsets and a trailer
 * whose identifier is the hash of the body it identifies.
 */
class PdfWriter {
  private readonly objects: PdfObject[] = [];

  add(body: string | Buffer): number {
    this.objects.push({ bytes: typeof body === "string" ? Buffer.from(body, "latin1") : body });

    return this.objects.length;
  }

  bytes(rootObject: number, infoObject: number): Uint8Array {
    const header = Buffer.from(`${INVOICE_PDF_HEADER}\n`, "latin1");
    // The binary marker: four bytes above 127, so a transport that strips the eighth bit cannot
    // mistake this file for text.
    const marker = Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
    const parts: Buffer[] = [header, marker];
    const offsets: number[] = [];
    let offset = header.length + marker.length;

    this.objects.forEach((object, index) => {
      offsets.push(offset);

      const head = Buffer.from(`${index + 1} 0 obj\n`, "latin1");
      const tail = Buffer.from("\nendobj\n", "latin1");

      parts.push(head, object.bytes, tail);
      offset += head.length + object.bytes.length + tail.length;
    });

    const startOfXref = offset;
    const entries: string[] = [`xref\n0 ${this.objects.length + 1}\n`, "0000000000 65535 f \n"];

    for (const entry of offsets) {
      entries.push(`${entry.toString().padStart(10, "0")} 00000 n \n`);
    }

    const body = Buffer.concat([
      ...parts,
      Buffer.from(entries.join(""), "latin1"),
    ]);
    const identifier = createHash("sha256").update(body).digest("hex");
    const trailer = Buffer.from(
      `trailer\n<< /Size ${this.objects.length + 1} /Root ${rootObject} 0 R /Info ${infoObject} 0 R ` +
        `/ID [<${identifier}> <${identifier}>] >>\nstartxref\n${startOfXref}\n%%EOF\n`,
      "latin1",
    );

    return new Uint8Array(Buffer.concat([body, trailer]));
  }
}

/** A dictionary, a `stream` keyword and the bytes between them, which is every stream this file writes. */
function streamBody(dictionary: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${dictionary}\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

function streamObject(content: string): Buffer {
  const data = deflateSync(Buffer.from(content, "latin1"), { level: 9 });

  return streamBody(`<< /Length ${data.length} /Filter /FlateDecode >>`, data);
}

/**
 * The logo's image XObject.
 *
 * A JPEG's samples are the file itself, which is why its filter is `DCTDecode` and why nothing was decoded
 * on the way here; a PNG's are the pixels `invoice-pdf-image.ts` produced, deflated at the same level as
 * every content stream so the document stays byte-deterministic. The soft mask, when the image has one, is
 * named here and written next: PDF's way of saying where a logo is transparent is a second image of the same
 * geometry holding one grey byte per pixel.
 */
function imageStreamObject(image: InvoicePdfImage, maskObject: number | null): Buffer {
  const data =
    image.filter === "DCTDecode"
      ? Buffer.from(image.samples)
      : deflateSync(Buffer.from(image.samples), { level: 9 });
  const space = image.colorSpace === "gray" ? "/DeviceGray" : "/DeviceRGB";
  const mask = maskObject === null ? "" : ` /SMask ${maskObject} 0 R`;

  return streamBody(
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${space} ` +
      `/BitsPerComponent ${image.bitsPerComponent} /Filter /${image.filter}${mask} /Length ${data.length} >>`,
    data,
  );
}

/** The soft mask of a logo that has transparent pixels: one grey byte per pixel, same geometry. */
function maskStreamObject(image: InvoicePdfImage, alpha: Uint8Array): Buffer {
  const data = deflateSync(Buffer.from(alpha), { level: 9 });

  return streamBody(
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>`,
    data,
  );
}

/* ---- the layout ---- */

/**
 * The letterhead: the merchant on the left, the document on the right.
 *
 * Both columns start at the same baseline - the cursor - and the band they occupy is the taller of the two,
 * so a merchant with a logo and six lines of address pushes the rule down and a merchant who has set nothing
 * leaves the header at the height its three right-hand lines need. Computing the band rather than fixing it
 * is what keeps the rest of the document from ever overlapping the branding.
 *
 * The logo is painted from its bottom left corner at the cursor, which puts it inside the content area, and
 * the title's own ascenders stay in the top margin where they have always been.
 *
 * A status line reads `Status: Sent`. It said `Invoice number: Sent` until this STEP rewrote the header,
 * because it was built from the number's label rather than the status's - the number itself is the line
 * above it, so the label belonged to nothing on the page.
 */
function drawHeader(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  const { labels, branding } = document;
  const topY = canvas.y;

  canvas.text({
    x: CONTENT_RIGHT,
    y: topY,
    text: labels.title,
    font: "bold",
    size: SIZE.title,
    align: "right",
  });

  if (document.number === null) {
    canvas.text({
      x: CONTENT_RIGHT,
      y: topY - 20,
      text: labels.draftStamp,
      font: "bold",
      size: SIZE.stamp,
      align: "right",
      grey: GREY.muted,
    });
    canvas.text({
      x: CONTENT_RIGHT,
      y: topY - 33,
      text: labels.notIssued,
      font: "regular",
      size: SIZE.body,
      align: "right",
      grey: GREY.muted,
    });
  } else {
    canvas.text({
      x: CONTENT_RIGHT,
      y: topY - 20,
      text: document.number,
      font: "bold",
      size: SIZE.number,
      align: "right",
    });
    canvas.text({
      x: CONTENT_RIGHT,
      y: topY - 33,
      text: `${labels.status}: ${statusWordOf(labels, document.status)}`,
      font: "regular",
      size: SIZE.body,
      align: "right",
      grey: GREY.muted,
    });
  }

  let y = topY;
  const logo = branding.logo;

  if (logo !== null) {
    canvas.image(INVOICE_PDF_LOGO_NAME, INVOICE_PDF_MARGIN, y - logo.height, logo.width, logo.height);
    y -= logo.height + LEADING.logoGap;
  }

  if (branding.name !== null && branding.name.length > 0) {
    canvas.text({ x: INVOICE_PDF_MARGIN, y, text: branding.name, font: "bold", size: SIZE.merchant });
    y -= LEADING.body;
  }

  if (branding.tagline !== null && branding.tagline.length > 0) {
    for (const line of invoicePdfWrap(branding.tagline, "regular", SIZE.tagline, MERCHANT_WIDTH)) {
      canvas.text({ x: INVOICE_PDF_MARGIN, y, text: line, font: "regular", size: SIZE.tagline, grey: GREY.muted });
      y -= LEADING.identity;
    }
  }

  // The address and the contact lines are stored multiline and wrapped here, exactly as the client's address
  // is in the block below: the column decides the width, and the data keeps its own line breaks.
  for (const block of [branding.address, branding.contact]) {
    if (block === null || block.length === 0) {
      continue;
    }

    for (const line of invoicePdfWrap(block, "regular", SIZE.identity, MERCHANT_WIDTH)) {
      canvas.text({ x: INVOICE_PDF_MARGIN, y, text: line, font: "regular", size: SIZE.identity });
      y -= LEADING.identity;
    }
  }

  canvas.moveBy(Math.max(topY - y, LEADING.headerBand));
  canvas.rule(canvas.y, branding.accent ?? GREY.rule);
  canvas.moveBy(LEADING.block);
}

/** The billed-to block beside the three dates, drawn as one block so they share a baseline. */
function drawParties(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  const { labels } = document;
  const leftWidth = 240;
  const labelX = 340;

  const left: string[] = [labels.billedTo];
  const leftSizes: number[] = [SIZE.heading];
  const leftFonts: InvoicePdfFont[] = ["bold"];

  const nameLines = invoicePdfWrap(document.client.name, "bold", SIZE.client, leftWidth);

  for (const line of nameLines) {
    left.push(line);
    leftSizes.push(SIZE.client);
    leftFonts.push("bold");
  }

  if (document.client.address !== null && document.client.address.length > 0) {
    for (const line of invoicePdfWrap(document.client.address, "regular", SIZE.body, leftWidth)) {
      left.push(line);
      leftSizes.push(SIZE.body);
      leftFonts.push("regular");
    }
  }

  if (document.client.email !== null && document.client.email.length > 0) {
    for (const line of invoicePdfWrap(document.client.email, "regular", SIZE.body, leftWidth)) {
      left.push(line);
      leftSizes.push(SIZE.body);
      leftFonts.push("regular");
    }
  }

  const rows: readonly (readonly [string, string])[] = [
    [labels.issueDate, document.issuedAt === null ? labels.notIssued : dateOf(document.issuedAt)],
    [labels.dueDate, dateOf(document.dueAt)],
    [labels.status, statusWordOf(labels, document.status)],
  ];

  const leftHeight = left.length * LEADING.body;
  const rightHeight = rows.length * LEADING.body;

  canvas.reserve(Math.max(leftHeight, rightHeight) + LEADING.block);

  let y = canvas.y;

  for (const [index, line] of left.entries()) {
    const size = leftSizes[index] ?? SIZE.body;
    const font = leftFonts[index] ?? "regular";

    if (index === 0) {
      canvas.text({
        x: INVOICE_PDF_MARGIN,
        y,
        text: line,
        font,
        size,
        grey: GREY.muted,
      });
    } else {
      canvas.text({ x: INVOICE_PDF_MARGIN, y, text: line, font, size });
    }

    y -= LEADING.body;
  }

  let rightY = canvas.y;

  for (const [label, value] of rows) {
    canvas.text({ x: labelX, y: rightY, text: label, font: "regular", size: SIZE.body, grey: GREY.muted });
    canvas.text({ x: CONTENT_RIGHT, y: rightY, text: value, font: "bold", size: SIZE.body, align: "right" });
    rightY -= LEADING.body;
  }

  canvas.moveBy(Math.max(leftHeight, rightHeight) + LEADING.block);
  canvas.rule(canvas.y);
  canvas.moveBy(LEADING.block);
}

function drawTableHead(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  const { labels } = document;

  canvas.text({
    x: COLUMN.positionLeft,
    y: canvas.y,
    text: labels.columnLine,
    font: "bold",
    size: SIZE.tableHead,
    grey: GREY.muted,
  });
  canvas.text({
    x: COLUMN.descriptionLeft,
    y: canvas.y,
    text: labels.columnDescription,
    font: "bold",
    size: SIZE.tableHead,
    grey: GREY.muted,
  });
  canvas.text({
    x: COLUMN.quantityRight,
    y: canvas.y,
    text: labels.columnQuantity,
    font: "bold",
    size: SIZE.tableHead,
    align: "right",
    grey: GREY.muted,
  });
  canvas.text({
    x: COLUMN.unitLeft,
    y: canvas.y,
    text: labels.columnUnit,
    font: "bold",
    size: SIZE.tableHead,
    grey: GREY.muted,
  });
  canvas.text({
    x: COLUMN.unitPriceRight,
    y: canvas.y,
    text: labels.columnUnitPrice,
    font: "bold",
    size: SIZE.tableHead,
    align: "right",
    grey: GREY.muted,
  });
  canvas.text({
    x: COLUMN.discountRight,
    y: canvas.y,
    text: labels.columnDiscount,
    font: "bold",
    size: SIZE.tableHead,
    align: "right",
    grey: GREY.muted,
  });
  canvas.text({
    x: COLUMN.amountRight,
    y: canvas.y,
    text: labels.columnAmount,
    font: "bold",
    size: SIZE.tableHead,
    align: "right",
    grey: GREY.muted,
  });

  canvas.moveBy(LEADING.tableHead - 4);
  canvas.rule(canvas.y);
  canvas.moveBy(LEADING.row);
}

function drawLines(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  drawTableHead(canvas, document);

  if (document.lines.length === 0) {
    canvas.reserve(LEADING.row * 2);
    canvas.text({
      x: COLUMN.descriptionLeft,
      y: canvas.y,
      text: document.labels.noLines,
      font: "regular",
      size: SIZE.body,
      grey: GREY.muted,
    });
    canvas.moveBy(LEADING.row * 2);
    canvas.rule(canvas.y);
    canvas.moveBy(LEADING.block);

    return;
  }

  for (const line of document.lines) {
    const description = invoicePdfWrap(line.description, "regular", SIZE.body, COLUMN.descriptionWidth);
    const height = description.length * LEADING.row + LEADING.rowPadding;

    if (canvas.reserve(height)) {
      drawTableHead(canvas, document);
    }

    const firstBaseline = canvas.y;

    canvas.text({
      x: COLUMN.positionLeft,
      y: firstBaseline,
      text: line.position.toString(),
      font: "regular",
      size: SIZE.body,
      grey: GREY.muted,
    });

    for (const [index, piece] of description.entries()) {
      canvas.text({
        x: COLUMN.descriptionLeft,
        y: firstBaseline - index * LEADING.row,
        text: piece,
        font: "regular",
        size: SIZE.body,
      });
    }

    canvas.text({
      x: COLUMN.quantityRight,
      y: firstBaseline,
      text: line.quantity,
      font: "regular",
      size: SIZE.body,
      align: "right",
    });
    canvas.text({
      x: COLUMN.unitLeft,
      y: firstBaseline,
      text: line.unit,
      font: "regular",
      size: SIZE.body,
      grey: GREY.muted,
    });
    canvas.text({
      x: COLUMN.unitPriceRight,
      y: firstBaseline,
      text: line.unitPrice,
      font: "regular",
      size: SIZE.body,
      align: "right",
    });

    if (line.discount.length > 0) {
      canvas.text({
        x: COLUMN.discountRight,
        y: firstBaseline,
        text: line.discount,
        font: "regular",
        size: SIZE.body,
        align: "right",
        grey: GREY.muted,
      });
    }

    canvas.text({
      x: COLUMN.amountRight,
      y: firstBaseline,
      text: line.amount,
      font: "bold",
      size: SIZE.body,
      align: "right",
    });

    canvas.moveBy(height);
    canvas.rule(canvas.y + LEADING.rowPadding - 2);
    canvas.moveBy(-(LEADING.rowPadding - 2));
    canvas.moveBy(LEADING.row - 4);
  }

  canvas.moveBy(LEADING.block - LEADING.row + 4);
}

function totalRow(
  canvas: InvoicePdfCanvas,
  label: string,
  value: string,
  options: { readonly bold?: boolean; readonly grey?: number } = {},
): void {
  const bold = options.bold === true;

  canvas.text({
    x: 470,
    y: canvas.y,
    text: label,
    font: bold ? "bold" : "regular",
    size: bold ? SIZE.grandTotal : SIZE.totalLabel,
    align: "right",
    ...(options.grey === undefined ? {} : { grey: options.grey }),
  });
  canvas.text({
    x: CONTENT_RIGHT,
    y: canvas.y,
    text: value,
    font: bold ? "bold" : "regular",
    size: bold ? SIZE.grandTotal : SIZE.totalValue,
    align: "right",
  });
}

function drawTotals(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  const { labels, totals } = document;
  const rows =
    1 +
    (totals.hasDiscount ? 1 : 0) +
    (totals.hasTax ? 1 : 0) +
    1 +
    (totals.hasPayment ? 2 : 0);

  canvas.reserve(rows * LEADING.totalRow + LEADING.grandTotalRow + LEADING.block);

  totalRow(canvas, labels.subtotal, totals.subtotal);
  canvas.moveBy(LEADING.totalRow);

  if (totals.hasDiscount) {
    totalRow(canvas, labels.discount, totals.discount, { grey: GREY.muted });
    canvas.moveBy(LEADING.totalRow);
  }

  if (totals.hasTax) {
    totalRow(canvas, labels.tax, totals.tax);
    canvas.moveBy(LEADING.totalRow);
  }

  canvas.rule(canvas.y + 4);
  canvas.moveBy(LEADING.grandTotalRow);
  totalRow(canvas, labels.total, totals.total, { bold: true });
  canvas.moveBy(LEADING.grandTotalRow);

  if (totals.hasPayment) {
    totalRow(canvas, labels.amountPaid, totals.amountPaid, { grey: GREY.muted });
    canvas.moveBy(LEADING.totalRow);
    totalRow(canvas, labels.balanceDue, totals.balanceDue, { bold: true });
    canvas.moveBy(LEADING.grandTotalRow);
  }

  canvas.text({
    x: INVOICE_PDF_MARGIN,
    y: canvas.y,
    text: labels.currencyNote,
    font: "regular",
    size: SIZE.footer,
    grey: GREY.muted,
  });
  canvas.moveBy(LEADING.block);
}

function drawMemo(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  if (document.memo === null || document.memo.length === 0) {
    return;
  }

  const lines = invoicePdfWrap(document.memo, "regular", SIZE.body, CONTENT_RIGHT - INVOICE_PDF_MARGIN);

  canvas.reserve(LEADING.heading + lines.length * LEADING.body + LEADING.block);
  canvas.text({
    x: INVOICE_PDF_MARGIN,
    y: canvas.y,
    text: document.labels.memo,
    font: "bold",
    size: SIZE.heading,
    grey: GREY.muted,
  });
  canvas.moveBy(LEADING.heading);

  for (const line of lines) {
    canvas.text({ x: INVOICE_PDF_MARGIN, y: canvas.y, text: line, font: "regular", size: SIZE.body });
    canvas.moveBy(LEADING.body);
  }

  canvas.moveBy(LEADING.block - LEADING.body);
}

/**
 * The merchant's note, above the footer of the page the document ends on.
 *
 * It is drawn last, after the memo, so it lands where the reading finished rather than starting a page of
 * its own: bank details or a thank-you belong at the end of a document, not floating between two halves of a
 * table that broke. The width is the whole content column, because this is the one block on the page that is
 * a sentence rather than a column of facts.
 */
function drawFooterNote(canvas: InvoicePdfCanvas, document: InvoicePdfDocument): void {
  const note = document.branding.footerNote;

  if (note === null || note.length === 0) {
    return;
  }

  const lines = invoicePdfWrap(note, "regular", SIZE.identity, CONTENT_RIGHT - INVOICE_PDF_MARGIN);

  canvas.reserve(LEADING.heading + lines.length * LEADING.identity + LEADING.block);
  canvas.moveBy(LEADING.heading);

  for (const line of lines) {
    canvas.text({
      x: INVOICE_PDF_MARGIN,
      y: canvas.y,
      text: line,
      font: "regular",
      size: SIZE.identity,
      grey: GREY.muted,
    });
    canvas.moveBy(LEADING.identity);
  }
}

/**
 * Render one invoice document to PDF bytes.
 *
 * The whole layout runs before the first byte is written, because the cross reference table needs the
 * offset of every object and the footer needs the page count, and both are known only at the end. The same
 * is true of the logo's object number, which the first page's resources name before the image is written:
 * it is the object after the last page's stream, and the page count is known before either.
 */
export function renderInvoicePdf(document: InvoicePdfDocument): Uint8Array {
  const { labels } = document;
  const canvas = new InvoicePdfCanvas(document.number === null ? labels.draftStamp : null);

  drawHeader(canvas, document);
  drawParties(canvas, document);
  drawLines(canvas, document);
  drawTotals(canvas, document);
  drawMemo(canvas, document);
  drawFooterNote(canvas, document);

  canvas.footers(
    formatMessage("invoices.pdfGeneratedAt", { instant: document.generatedAt }),
    (page, pages) => formatMessage("invoices.pdfPageOf", { page, pages }),
  );

  const writer = new PdfWriter();
  const pagesObject = 2;
  const firstPageObject = 6;

  writer.add(`<< /Type /Catalog /Pages ${pagesObject} 0 R /Lang (en-US) >>`);

  // The pages object is written second and filled with the numbers its pages will get, which are fixed
  // before any of them is written: two objects per page, a page and its stream, starting at six.
  const streams = canvas.streams();
  const pageNumbers = streams.map((_, index) => firstPageObject + index * 2);

  // The logo's objects come after every page's pair, so their numbers are already known and the first page's
  // resources can name an object that is not written until the end of the file. A forward reference is
  // ordinary in PDF: the cross reference table is what resolves it, and that is written last.
  const logo = document.branding.logo;
  const imageObject = logo === null ? null : firstPageObject + streams.length * 2;
  const maskObject =
    imageObject !== null && logo !== null && logo.image.alpha !== null ? imageObject + 1 : null;

  writer.add(
    `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(" ")}] ` +
      `/Count ${streams.length} >>`,
  );
  writer.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  writer.add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const created = pdfDateOf(document.generatedAtEpochMs);
  const title = document.number === null ? labels.draftStamp : `${labels.title} ${document.number}`;

  writer.add(
    `<< /Title (${invoicePdfLiteral(title)}) /Producer (${invoicePdfLiteral(getMessage("invoices.pdfProducer"))}) ` +
      `/Creator (${invoicePdfLiteral(getMessage("invoices.pdfProducer"))}) ` +
      `/CreationDate (${created}) /ModDate (${created}) >>`,
  );

  for (const [index, content] of streams.entries()) {
    const pageNumber = firstPageObject + index * 2;
    // Only the first page carries the logo, so only its resources name an image and only its procedure set
    // asks for `/ImageC`: a page that draws no picture should not claim it can.
    const resources =
      imageObject !== null && index === 0
        ? `/Resources << /ProcSet [/PDF /Text /ImageC] /Font << /F1 3 0 R /F2 4 0 R >> ` +
          `/XObject << /${INVOICE_PDF_LOGO_NAME} ${imageObject} 0 R >> >>`
        : `/Resources << /ProcSet [/PDF /Text] /Font << /F1 3 0 R /F2 4 0 R >> >>`;

    writer.add(
      `<< /Type /Page /Parent ${pagesObject} 0 R /MediaBox [0 0 ${INVOICE_PDF_PAGE_WIDTH} ` +
        `${INVOICE_PDF_PAGE_HEIGHT}] ${resources} /Contents ${pageNumber + 1} 0 R >>`,
    );
    writer.add(streamObject(content));
  }

  if (logo !== null && imageObject !== null) {
    writer.add(imageStreamObject(logo.image, maskObject));

    if (logo.image.alpha !== null) {
      writer.add(maskStreamObject(logo.image, logo.image.alpha));
    }
  }

  const bytes = writer.bytes(1, 5);

  if (bytes.length > INVOICE_PDF_MAXIMUM_BYTES) {
    throw new AppError("PAYLOAD_TOO_LARGE", { cause: { rule: "invoice_pdf", reason: "too_large" } });
  }

  return bytes;
}
