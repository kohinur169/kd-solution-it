// path: services/invoices/invoice-pdf-image.ts
import { inflateSync } from "node:zlib";
import { AppError } from "../../lib/errors/app-error.ts";

/**
 * The two image formats an invoice logo may be drawn from, and the reading of each.
 *
 * ## Why this module exists
 *
 * STEP 117's writer draws text only: `BT ... Tj ET` and nothing else. A merchant logo is pixels, and pixels
 * in a PDF are an image XObject - a stream of samples plus a dictionary that says how wide, how tall, how
 * many bits and which filter. So the writer needed a second kind of object, and the bytes a merchant uploads
 * are PNG, JPEG or WebP (`lib/security/upload.ts`'s `company_logo` policy) while a PDF wants raw samples or
 * a baseline JPEG. Something has to translate, and this is it.
 *
 * ## Why a decoder and not a package
 *
 * Rule 65 of the master prompt: `package.json` is integrator-owned, and a package request is a note in a
 * handoff, not an import. A logo is the simplest image problem there is - one picture, drawn once, on the
 * first page - so the reading is written here instead: PNG is zlib and five scanline filters, both of which
 * `node:zlib` and a hundred lines cover completely, and a baseline JPEG needs no decoding at all because
 * PDF's `DCTDecode` *is* the JPEG standard, so the file goes into the stream untouched and only its
 * dimensions and component count are read.
 *
 * ## What is refused, and why the refusal is honest
 *
 * A format this module cannot read is refused with a reason rather than drawn badly or skipped silently:
 * WebP (a VP8 bitstream, which is a video codec and not a hundred lines), an interlaced PNG (Adam7 reorders
 * the pixels into seven passes, and a logo has no business being interlaced), anything but a *baseline*
 * JPEG (progressive, arithmetic and lossless JPEGs are not what `DCTDecode` was written against), a
 * four-component JPEG (CMYK, whose colours a PDF reader would have to convert with an ICC profile nobody
 * uploaded), a bit depth this normaliser does not handle, and dimensions above a ceiling. Each refusal is a
 * reason the settings screen turns into one merchant sentence: export it as a PNG and try again.
 *
 * ## The pixel ceiling, which is a bomb guard and not a taste
 *
 * `company_logo` allows two megabytes, and two megabytes of PNG can *declare* twenty thousand pixels on a
 * side. The declaration is in the header, before any data is inflated, so the ceiling is checked there - and
 * the inflate itself is given `maxOutputLength` set to the exact number of bytes the declared geometry
 * needs, so a stream that inflates to more than its own header promised is refused instead of allocated.
 *
 * ## Sixteen bits
 *
 * A 16-bit channel is normalised to its high byte. A PDF supports sixteen bits per component and the
 * renderer could carry them, but a logo is brand colour and line art, every print pipeline in the world
 * hands a logo over in eight bits, and carrying sixteen would double the stream for a difference nobody can
 * see at 150 points wide. It is a deliberate reduction, recorded here rather than left as a surprise.
 */

/** The formats this module reads. WebP is a `company_logo` type and is refused, see above. */
export const INVOICE_PDF_IMAGE_FORMATS = ["png", "jpeg"] as const;

export type InvoicePdfImageFormat = (typeof INVOICE_PDF_IMAGE_FORMATS)[number];

/** Every way an image can be refused, in the vocabulary the service and the gate share. */
export const INVOICE_PDF_IMAGE_REFUSALS = [
  "not_an_image",
  "unsupported_bit_depth",
  "interlaced",
  "unsupported_jpeg",
  "too_many_pixels",
  "malformed",
] as const;

export type InvoicePdfImageRefusal = (typeof INVOICE_PDF_IMAGE_REFUSALS)[number];

/**
 * The most pixels a logo may declare. 2048 on a side is four times the resolution a 150 point box needs at
 * 300 dpi, and it bounds the normalised samples at about twelve megabytes before the deflate that follows.
 */
export const INVOICE_PDF_IMAGE_MAXIMUM_PIXELS = 2_048 * 2_048;

/** The colour spaces a PDF image XObject of this module uses: three samples or one. */
export const INVOICE_PDF_IMAGE_COLOR_SPACES = ["rgb", "gray"] as const;

export type InvoicePdfImageColorSpace = (typeof INVOICE_PDF_IMAGE_COLOR_SPACES)[number];

/**
 * An image the writer can put in a stream.
 *
 * `filter` is the whole difference between the two formats: a JPEG's `samples` are the file, unmodified,
 * because `DCTDecode` decodes them; a PNG's `samples` are the pixels this module already decoded, which the
 * writer deflates and calls `FlateDecode`. `alpha`, when present, is one byte per pixel and becomes a soft
 * mask - a second, grey image of the same geometry that tells the reader where the logo is transparent.
 */
export interface InvoicePdfImage {
  readonly format: InvoicePdfImageFormat;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: InvoicePdfImageColorSpace;
  readonly bitsPerComponent: 8;
  readonly filter: "FlateDecode" | "DCTDecode";
  readonly samples: Uint8Array;
  readonly alpha: Uint8Array | null;
}

export type InvoicePdfImageVerdict =
  | { readonly ok: true; readonly image: InvoicePdfImage }
  | { readonly ok: false; readonly reason: InvoicePdfImageRefusal };

/** The PNG signature, which is eight bytes and not negotiable. */
const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG colour types, by the number of channels they carry before any palette is applied. */
const PNG_CHANNELS: Readonly<Record<number, number>> = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

/** The bit depths each colour type allows, which the standard fixes and a reader must not guess at. */
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = Object.freeze({
  0: Object.freeze([1, 2, 4, 8, 16]),
  2: Object.freeze([8, 16]),
  3: Object.freeze([1, 2, 4, 8]),
  4: Object.freeze([8, 16]),
  6: Object.freeze([8, 16]),
});

/**
 * Read one byte, answering zero past the end.
 *
 * `noUncheckedIndexedAccess` makes every index a `number | undefined`, and this module's job is to refuse
 * malformed input rather than to trust it, so the callers all measure first and read second. Where a read
 * *is* guarded, this keeps the arithmetic readable instead of a ladder of local variables.
 */
function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0;
}

function uint16At(bytes: Uint8Array, index: number): number {
  return (byteAt(bytes, index) << 8) | byteAt(bytes, index + 1);
}

function uint32At(bytes: Uint8Array, index: number): number {
  // Multiplication rather than a shift: a 32 bit shift would produce a negative number for any value whose
  // top bit is set, and a length that reads as negative is a length that passes a bounds check.
  return byteAt(bytes, index) * 0x100_0000 + ((byteAt(bytes, index + 1) << 16) >>> 0) +
    (byteAt(bytes, index + 2) << 8) + byteAt(bytes, index + 3);
}

/** Which format these bytes are, read from the signature and nothing else. */
export function sniffInvoicePdfImageFormat(bytes: Uint8Array): InvoicePdfImageFormat | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => byteAt(bytes, index) === value)) {
    return "png";
  }

  if (bytes.length >= 3 && byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8 && byteAt(bytes, 2) === 0xff) {
    return "jpeg";
  }

  return null;
}

/**
 * Read an image, or say why not.
 *
 * The declared content type has to agree with the signature: a file record whose type says `image/png` and
 * whose bytes are a JPEG is a record this module will not pretend to understand, and the disagreement is
 * itself the `not_an_image` refusal.
 */
export function inspectInvoicePdfImage(bytes: Uint8Array, contentType: string): InvoicePdfImageVerdict {
  const format = sniffInvoicePdfImageFormat(bytes);

  if (format === null || contentType !== (format === "png" ? "image/png" : "image/jpeg")) {
    return { ok: false, reason: "not_an_image" };
  }

  return format === "png" ? readPng(bytes) : readJpeg(bytes);
}

/**
 * The reading the renderer calls, which turns a refusal into the failure a job records.
 *
 * The reason travels in the error's cause and never in its message: a merchant sees one sentence, and the
 * code in the audit entry is what support reads.
 */
export function decodeInvoicePdfImage(bytes: Uint8Array, contentType: string): InvoicePdfImage {
  const verdict = inspectInvoicePdfImage(bytes, contentType);

  if (!verdict.ok) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "logo", rule: "file_not_acceptable" }],
      cause: { rule: "invoice_pdf_image", reason: verdict.reason },
    });
  }

  return verdict.image;
}

/* ---- PNG ---- */

interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
}

/**
 * Split a PNG into its chunks.
 *
 * The CRC of each chunk is not recomputed. The bytes arrived through `downloadEncryptedObject`, which opened
 * an AES-256-GCM seal whose tag is the integrity check, and the file record's sha256 was compared against
 * them on the way out of storage in STEP 117 - a third hash over the same bytes would cost time and prove
 * nothing new. A chunk whose declared length runs past the end of the file *is* refused, because that is a
 * shape error and not a corruption question.
 */
function pngChunks(bytes: Uint8Array): readonly PngChunk[] | null {
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;

  while (offset + 8 <= bytes.length) {
    const length = uint32At(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;

    if (length > bytes.length - dataStart - 4) {
      return null;
    }

    const type = String.fromCharCode(
      byteAt(bytes, typeStart),
      byteAt(bytes, typeStart + 1),
      byteAt(bytes, typeStart + 2),
      byteAt(bytes, typeStart + 3),
    );

    chunks.push({ type, data: bytes.subarray(dataStart, dataStart + length) });
    offset = dataStart + length + 4;

    if (type === "IEND") {
      return chunks;
    }
  }

  return null;
}

function pngHeaderOf(chunks: readonly PngChunk[]): PngHeader | null {
  const header = chunks[0];

  if (header === undefined || header.type !== "IHDR" || header.data.length !== 13) {
    return null;
  }

  const data = header.data;
  const colorType = byteAt(data, 9);

  return {
    width: uint32At(data, 0),
    height: uint32At(data, 4),
    bitDepth: byteAt(data, 8),
    colorType,
    interlace: byteAt(data, 12),
  };
}

/** The Paeth predictor, which is the standard's own three comparisons and no more. */
function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);

  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) {
    return left;
  }

  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

/**
 * Undo the per-scanline filtering, in place into `out`.
 *
 * Every filter is a byte-wise prediction against the byte to the left, the row above, or both, and the
 * arithmetic wraps at 256 - which the `& 0xff` is, and which is why the standard says "modulo 256" rather
 * than "saturate". `bytesPerPixel` is at least one even for sub-byte depths, because a filter never predicts
 * from inside a byte that holds several pixels.
 */
function pngUnfilter(
  raw: Uint8Array,
  height: number,
  stride: number,
  bytesPerPixel: number,
): Uint8Array | null {
  if (raw.length !== height * (stride + 1)) {
    return null;
  }

  const out = new Uint8Array(height * stride);

  for (let row = 0; row < height; row += 1) {
    const filterType = byteAt(raw, row * (stride + 1));
    const sourceStart = row * (stride + 1) + 1;
    const targetStart = row * stride;

    if (filterType > 4) {
      return null;
    }

    for (let index = 0; index < stride; index += 1) {
      const rawByte = byteAt(raw, sourceStart + index);
      const left = index >= bytesPerPixel ? byteAt(out, targetStart + index - bytesPerPixel) : 0;
      const above = row === 0 ? 0 : byteAt(out, targetStart - stride + index);
      const upperLeft =
        row === 0 || index < bytesPerPixel ? 0 : byteAt(out, targetStart - stride + index - bytesPerPixel);

      let value = rawByte;

      if (filterType === 1) {
        value += left;
      } else if (filterType === 2) {
        value += above;
      } else if (filterType === 3) {
        value += (left + above) >> 1;
      } else if (filterType === 4) {
        value += paeth(left, above, upperLeft);
      }

      out[targetStart + index] = value & 0xff;
    }
  }

  return out;
}

/** Scale a sample of `bitDepth` bits to eight, by repeating its bits rather than by shifting zeros in. */
function toEightBits(value: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return value;
  }

  if (bitDepth === 16) {
    // The high byte: see the module's note on sixteen bits.
    return value >> 8;
  }

  const maximum = (1 << bitDepth) - 1;

  return maximum === 0 ? 0 : Math.round((value * 255) / maximum);
}

/**
 * Read one sample of `bitDepth` bits out of a filtered row, at a sample ordinal.
 *
 * Sub-byte depths pack several samples into a byte, most significant first, so the ordinal decides both the
 * byte and the shift inside it.
 */
function sampleAt(row: Uint8Array, ordinal: number, bitDepth: number): number {
  if (bitDepth >= 8) {
    const byteIndex = ordinal * (bitDepth >> 3);

    return bitDepth === 16 ? uint16At(row, byteIndex) : byteAt(row, byteIndex);
  }

  const bitIndex = ordinal * bitDepth;
  const shift = 8 - bitDepth - (bitIndex % 8);

  return (byteAt(row, Math.floor(bitIndex / 8)) >> shift) & ((1 << bitDepth) - 1);
}

function readPng(bytes: Uint8Array): InvoicePdfImageVerdict {
  const chunks = pngChunks(bytes);

  if (chunks === null) {
    return { ok: false, reason: "malformed" };
  }

  const header = pngHeaderOf(chunks);

  if (header === null) {
    return { ok: false, reason: "malformed" };
  }

  // Compression and filter method are both fixed at zero by the standard, so a PNG that declares anything
  // else is not a PNG this reader can be asked to guess at.
  const ihdr = chunks[0];

  if (
    ihdr === undefined ||
    byteAt(ihdr.data, 10) !== 0 ||
    byteAt(ihdr.data, 11) !== 0 ||
    header.width === 0 ||
    header.height === 0
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (header.interlace !== 0) {
    return { ok: false, reason: "interlaced" };
  }

  const channels = PNG_CHANNELS[header.colorType];
  const depths = PNG_BIT_DEPTHS[header.colorType];

  if (channels === undefined || depths === undefined || !depths.includes(header.bitDepth)) {
    return { ok: false, reason: "unsupported_bit_depth" };
  }

  // The ceiling is checked on the declared geometry, before a single byte is inflated.
  if (header.width * header.height > INVOICE_PDF_IMAGE_MAXIMUM_PIXELS) {
    return { ok: false, reason: "too_many_pixels" };
  }

  const palette = chunks.find((chunk) => chunk.type === "PLTE")?.data;

  if (header.colorType === 3 && (palette === undefined || palette.length < 3)) {
    return { ok: false, reason: "malformed" };
  }

  const transparent = chunks.find((chunk) => chunk.type === "tRNS")?.data ?? null;
  const compressed: Uint8Array[] = [];

  for (const chunk of chunks) {
    if (chunk.type === "IDAT") {
      compressed.push(chunk.data);
    }
  }

  if (compressed.length === 0) {
    return { ok: false, reason: "malformed" };
  }

  const stride = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const bytesPerPixel = Math.max(1, Math.ceil((channels * header.bitDepth) / 8));
  const needed = header.height * (stride + 1);

  let inflated: Uint8Array;

  try {
    // `maxOutputLength` is the exact size the header promised, so a stream that inflates to more is refused
    // by zlib instead of being allocated.
    inflated = new Uint8Array(inflateSync(Buffer.concat(compressed.map((part) => Buffer.from(part))), {
      maxOutputLength: needed,
    }));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const filtered = pngUnfilter(inflated, header.height, stride, bytesPerPixel);

  if (filtered === null) {
    return { ok: false, reason: "malformed" };
  }

  const { width, height, bitDepth, colorType } = header;
  const pixels = width * height;
  const hasAlphaChannel = colorType === 4 || colorType === 6;
  const outChannels = colorType === 0 || colorType === 4 ? 1 : 3;
  const samples = new Uint8Array(pixels * outChannels);
  const alpha = hasAlphaChannel || transparent !== null ? new Uint8Array(pixels) : null;

  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const rowStart = Math.floor(pixel / width) * stride;
    const ordinalInRow = (pixel % width) * channels;

    if (colorType === 3) {
      const index = sampleAt(filtered.subarray(rowStart, rowStart + stride), ordinalInRow, bitDepth);
      const paletteEntry = index * 3;

      // An index past the end of the palette is a broken file, and reading zeros for it would print a black
      // rectangle where a logo belongs. Refusing is the honest answer: the merchant re-exports it.
      if (palette === undefined || paletteEntry + 2 >= palette.length) {
        return { ok: false, reason: "malformed" };
      }

      samples[pixel * 3] = byteAt(palette, paletteEntry);
      samples[pixel * 3 + 1] = byteAt(palette, paletteEntry + 1);
      samples[pixel * 3 + 2] = byteAt(palette, paletteEntry + 2);

      if (alpha !== null) {
        alpha[pixel] = transparent === null ? 255 : (pixelAlphaOf(transparent, index) ?? 255);
      }

      continue;
    }

    const row = filtered.subarray(rowStart, rowStart + stride);
    const first = toEightBits(sampleAt(row, ordinalInRow, bitDepth), bitDepth);

    if (outChannels === 1) {
      samples[pixel] = first;

      if (colorType === 4) {
        const second = toEightBits(sampleAt(row, ordinalInRow + 1, bitDepth), bitDepth);

        if (alpha !== null) {
          alpha[pixel] = second;
        }
      } else if (alpha !== null && transparent !== null && transparent.length >= 2) {
        // A grey PNG names one transparent value: samples equal to it are clear and everything else is not.
        const transparentValue = uint16At(transparent, 0);

        alpha[pixel] =
          bitDepth === 16 && first === (transparentValue >> 8)
            ? 0
            : bitDepth !== 16 && sampleAt(row, ordinalInRow, bitDepth) === transparentValue
              ? 0
              : 255;
      } else if (alpha !== null) {
        alpha[pixel] = 255;
      }

      continue;
    }

    const second = toEightBits(sampleAt(row, ordinalInRow + 1, bitDepth), bitDepth);
    const third = toEightBits(sampleAt(row, ordinalInRow + 2, bitDepth), bitDepth);

    samples[pixel * 3] = first;
    samples[pixel * 3 + 1] = second;
    samples[pixel * 3 + 2] = third;

    if (alpha === null) {
      continue;
    }

    if (colorType === 6) {
      alpha[pixel] = toEightBits(sampleAt(row, ordinalInRow + 3, bitDepth), bitDepth);
    } else if (transparent !== null && transparent.length >= 6) {
      const matches =
        toEightBits(uint16At(transparent, 0), bitDepth === 16 ? 16 : 8) === first &&
        toEightBits(uint16At(transparent, 2), bitDepth === 16 ? 16 : 8) === second &&
        toEightBits(uint16At(transparent, 4), bitDepth === 16 ? 16 : 8) === third;

      alpha[pixel] = matches ? 0 : 255;
    } else {
      alpha[pixel] = 255;
    }
  }

  // A mask that is 255 everywhere says nothing, and carrying it would double the objects and the bytes for
  // a logo that has no transparent pixel at all - so it is dropped rather than written.
  const mask = alpha !== null && alpha.every((value) => value === 255) ? null : alpha;

  return {
    ok: true,
    image: {
      format: "png",
      width,
      height,
      colorSpace: outChannels === 1 ? "gray" : "rgb",
      bitsPerComponent: 8,
      filter: "FlateDecode",
      samples,
      alpha: mask,
    },
  };
}

/** The alpha of one palette index from a `tRNS` chunk, which may be shorter than the palette. */
function pixelAlphaOf(transparent: Uint8Array, index: number): number | undefined {
  return index < transparent.length ? byteAt(transparent, index) : undefined;
}

/* ---- JPEG ---- */

/** Markers that stand alone, with no length and no payload. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7);
}

/** The frame markers, minus the three that are not frames (DHT, JPG, DAC). */
function isFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Read a baseline JPEG's geometry and hand the file through untouched.
 *
 * Nothing here decodes a pixel, because nothing has to: PDF's `DCTDecode` is the JPEG standard, so the
 * stream is the file. What is read is the frame header - the precision, the dimensions and the component
 * count - because the dictionary has to say them and because a four-component file is CMYK, which a reader
 * would have to convert with a colour profile nobody supplied.
 */
function readJpeg(bytes: Uint8Array): InvoicePdfImageVerdict {
  let offset = 2;
  let frame: { readonly width: number; readonly height: number; readonly components: number } | null = null;

  while (offset + 2 <= bytes.length) {
    if (byteAt(bytes, offset) !== 0xff) {
      return { ok: false, reason: "malformed" };
    }

    let marker = byteAt(bytes, offset + 1);

    // A marker may be preceded by any number of fill bytes, all of them 0xff.
    while (marker === 0xff && offset + 2 < bytes.length) {
      offset += 1;
      marker = byteAt(bytes, offset + 1);
    }

    offset += 2;

    if (marker === 0x00 || isStandaloneMarker(marker)) {
      if (marker === 0xd9) {
        break;
      }

      continue;
    }

    if (offset + 2 > bytes.length) {
      return { ok: false, reason: "malformed" };
    }

    const length = uint16At(bytes, offset);

    if (length < 2 || offset + length > bytes.length) {
      return { ok: false, reason: "malformed" };
    }

    if (isFrameMarker(marker)) {
      // Baseline only. Progressive (C2), lossless (C3) and arithmetic (C9) frames are not what a PDF
      // reader's DCTDecode was written against, and a logo has no reason to be any of them.
      if (marker !== 0xc0) {
        return { ok: false, reason: "unsupported_jpeg" };
      }

      const precision = byteAt(bytes, offset + 2);
      const height = uint16At(bytes, offset + 3);
      const width = uint16At(bytes, offset + 5);
      const components = byteAt(bytes, offset + 7);

      if (precision !== 8 || width === 0 || height === 0) {
        return { ok: false, reason: "unsupported_jpeg" };
      }

      frame = { width, height, components };
      break;
    }

    // A scan before any frame means the walk lost the structure.
    if (marker === 0xda) {
      return { ok: false, reason: "malformed" };
    }

    offset += length;
  }

  if (frame === null) {
    return { ok: false, reason: "malformed" };
  }

  if (frame.width * frame.height > INVOICE_PDF_IMAGE_MAXIMUM_PIXELS) {
    return { ok: false, reason: "too_many_pixels" };
  }

  if (frame.components !== 1 && frame.components !== 3) {
    return { ok: false, reason: "unsupported_jpeg" };
  }

  return {
    ok: true,
    image: {
      format: "jpeg",
      width: frame.width,
      height: frame.height,
      colorSpace: frame.components === 1 ? "gray" : "rgb",
      bitsPerComponent: 8,
      filter: "DCTDecode",
      samples: trimToJpegEnd(bytes),
      alpha: null,
    },
  };
}

/**
 * Cut anything after the end-of-image marker.
 *
 * A camera or an editor may append a thumbnail or padding after `ffd9`, and a stream whose `/Length` is
 * longer than the JPEG inside it is a stream some readers choke on. The scan is backwards because the
 * marker is at the end and the file may be two megabytes of entropy data.
 */
function trimToJpegEnd(bytes: Uint8Array): Uint8Array {
  for (let index = bytes.length - 2; index >= 2; index -= 1) {
    if (byteAt(bytes, index) === 0xff && byteAt(bytes, index + 1) === 0xd9) {
      return bytes.subarray(0, index + 2);
    }
  }

  return bytes;
}
