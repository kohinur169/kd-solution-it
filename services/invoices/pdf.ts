// path: services/invoices/pdf.ts

/**
 * A minimal, self-contained PDF writer.
 *
 * ## Why no library
 *
 * The platform carries four dependencies and `MASTER_PROMPT` makes `package.json` integrator-owned:
 * when a package is needed, the STEP writes a request into its handoff rather than editing the file.
 * A PDF library is a package. But a settlement statement is a table of text, and PDF is a
 * text-addressable format - a header, objects, a content stream of text operators, an xref table and
 * a trailer - so the statement can be written without one. This file is that writer: the standard
 * Helvetica fonts (built in, no embedding), a byte buffer with exact offsets, and an xref a reader
 * resolves.
 *
 * ## What it is not
 *
 * It is not a PDF engine. It writes text on A4 pages; it does not do vector graphics, images,
 * embedded fonts, forms, or anything a scanned document needs. A statement is text on pages, and
 * this is all a statement needs.
 *
 * ## The byte discipline
 *
 * PDF is bytes, not characters. Every string written here becomes one byte per character (Latin-1,
 * 0-255); a character the standard font cannot carry is written as `?`. The `/Length` of every
 * stream is the exact byte count of its content, and the xref records the exact byte offset of every
 * object - which is why the builder tracks `this.bytes.length` at the moment each object begins, and
 * why the content is written once and counted once.
 */

/** One A4 page: 595 by 842 points, the size every statement is laid out for. */
export const PDF_PAGE_WIDTH = 595;
export const PDF_PAGE_HEIGHT = 842;

/** A byte buffer that records where every object begins, so the xref can name it. */
class PdfBuilder {
  private bytes: number[] = [];
  private offsets: number[] = [];

  constructor() {
    this.write("%PDF-1.4\n");
  }

  /** Write a string as one byte per character, Latin-1, a character past 255 as `?`. */
  private write(text: string): void {
    for (const char of text) {
      const code = char.charCodeAt(0);
      this.bytes.push(code <= 255 ? code : 63);
    }
  }

  /** The byte length of a string under the same rule `write` uses: one byte per character. */
  private byteLength(text: string): number {
    return text.length;
  }

  /** Write one object: its number, its body, and the offset the xref will name. */
  object(num: number, body: string): void {
    this.offsets[num] = this.bytes.length;
    this.write(`${num} 0 obj\n${body}\nendobj\n`);
  }

  /** Write one stream object: a `/Length` that is the content's exact byte count. */
  stream(num: number, content: string): void {
    const length = this.byteLength(content);
    this.offsets[num] = this.bytes.length;
    this.write(`${num} 0 obj\n<< /Length ${length} >>\nstream\n`);
    this.write(content);
    this.write("\nendstream\nendobj\n");
  }

  /** The finished file: header, objects, xref, trailer. */
  build(): Uint8Array {
    const count = this.offsets.length;
    const xrefOffset = this.bytes.length;

    this.write("xref\n");
    this.write(`0 ${count}\n`);
    this.write("0000000000 65535 f \n");

    for (let num = 1; num < count; num += 1) {
      const offset = this.offsets[num] ?? 0;
      this.write(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }

    this.write("trailer\n");
    this.write(`<< /Size ${count} /Root 1 0 R >>\n`);
    this.write("startxref\n");
    this.write(`${xrefOffset}\n`);
    this.write("%%EOF\n");

    return Uint8Array.from(this.bytes);
  }
}

/** Format a coordinate the way PDF numbers are written: no trailing zeros. */
function coordinate(value: number): string {
  return String(parseFloat(value.toFixed(2)));
}

/** Escape a string for a PDF literal: backslash, then the two parentheses. */
export function pdfEscape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** The printed width of a string in a standard font, at the size it is drawn. */
function textWidth(text: string, size: number): number {
  return text.length * size * 0.5;
}

/**
 * One text element of a content stream: font, size, position, the words, and how they are placed.
 *
 * `Tm` sets the text matrix to an identity rotation translated to `(x, y)`, so each element is drawn
 * at an absolute point on the page regardless of what was drawn before it. Right-aligned text is
 * placed at `rightEdge - width`, the way a column of numbers is read.
 */
export function pdfTextOp(
  x: number,
  y: number,
  font: "F1" | "F2",
  size: number,
  text: string,
  align: "left" | "right" = "left",
  rightEdge?: number,
): string {
  const escaped = pdfEscape(text);

  if (align === "right" && rightEdge !== undefined) {
    const tx = rightEdge - textWidth(text, size);
    return `BT /${font} ${size} Tf 1 0 0 1 ${coordinate(tx)} ${coordinate(y)} Tm (${escaped}) Tj ET`;
  }

  return `BT /${font} ${size} Tf 1 0 0 1 ${coordinate(x)} ${coordinate(y)} Tm (${escaped}) Tj ET`;
}

/**
 * Assemble a multi-page PDF from content streams, one string per page.
 *
 * The object numbering is fixed so the xref is predictable: 1 the catalog, 2 the pages tree, 3 and 4
 * the two standard fonts, then one page object and one content stream per page, in order. Every
 * page shares the two fonts, so a statement of any length carries the same two font objects however
 * many pages it runs to.
 */
export function buildPdfDocument(pages: readonly string[]): Uint8Array {
  const builder = new PdfBuilder();
  const count = pages.length;

  builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");

  const kids = pages.map((_, index) => `${5 + index} 0 R`).join(" ");
  builder.object(2, `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`);

  builder.object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  builder.object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  for (let index = 0; index < count; index += 1) {
    const pageNum = 5 + index;
    const contentNum = 5 + count + index;

    builder.object(
      pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`,
    );
    builder.stream(contentNum, pages[index] ?? "");
  }

  return builder.build();
}

/** The bytes of a PDF as a Latin-1 string, the encoding the writer wrote them in. */
function latin1Of(bytes: Uint8Array): string {
  let out = "";

  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }

  return out;
}

/** Reverse `pdfEscape`: the parentheses first, then the backslashes they were written beside. */
function unescapePdf(text: string): string {
  return text.replaceAll("\\(", "(").replaceAll("\\)", ")").replaceAll("\\\\", "\\");
}

/**
 * Every literal string a content stream draws, in the order it is drawn.
 *
 * The gate uses this to read a statement back out of its own PDF: the movements, the totals, the
 * period - the words a person reads on the page, without a PDF reader.
 */
export function extractPdfText(pdf: Uint8Array): string[] {
  const text = latin1Of(pdf);
  const out: string[] = [];
  const pattern = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
  let match: RegExpExecArray | null = pattern.exec(text);

  while (match !== null) {
    out.push(unescapePdf(match[1] ?? ""));
    match = pattern.exec(text);
  }

  return out;
}
