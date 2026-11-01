// path: lib/qr/qr.ts
/**
 * A QR Code encoder, byte mode, error correction level M, versions 1 to 10.
 *
 * The platform has to show a TOTP `otpauth://` URI as something an authenticator app can photograph,
 * and `package.json` is integrator owned, so a dependency is not an option and a third party image
 * service would mean handing an enrolment secret to a stranger. This file is the encoder,
 * implemented from ISO/IEC 18004 and kept as small as the two uses it has:
 *
 *   - one fixed error correction level, because the payload is a short URI shown on a screen and a
 *     scanner either sees the screen or does not; level M is the level the specification's own
 *     examples use and recovers about fifteen percent of a damaged symbol;
 *   - versions 1 to 10, which carry up to 216 bytes at this level - comfortably more than a
 *     `otpauth://` URI for a long email address - and no larger, because a version 11 table would
 *     be dead code for a payload that never grows;
 *   - one mask pattern, the first, which is legal and which keeps the file readable: every mask is
 *     decodable, the penalty rules only pick the one that scanners prefer, and the format bits below
 *     state which mask was used so no decoder has to guess.
 *
 * ## What the caller gets
 *
 * A square matrix of modules, `true` for dark. The quiet zone is not part of it; a renderer adds
 * that, because the width of the margin depends on the medium. `encodeQr` returns null when the
 * payload does not fit in version 10 at this level, and a caller must then show the URI as text
 * rather than a symbol that would be wrong.
 *
 * ## How it is proved
 *
 * The gate checks the structure a scanner relies on: the three finder patterns and their
 * separators, the timing patterns, the dark module, the version, the bit capacity, and the fifteen
 * format bits read back from both of their copies. The matrices themselves were compared module for
 * module against an independent encoder while this file was written, which is the part a structural
 * test cannot do; the comparison is recorded in the STEP handoff.
 */

/** The symbols this encoder produces: size in modules and the dark/light grid. */
export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

/** EC level M: two format bits 00, about fifteen percent recovery. */
const errorCorrectionBits = 0b00;

/** The mask this encoder applies, and therefore the mask the format bits name. */
const maskPattern = 0;

interface VersionTable {
  /** Data codewords the symbol carries before error correction. */
  readonly dataCodewords: number;
  /** Error correction codewords per block. */
  readonly eccPerBlock: number;
  /** Block groups, as [block count, data codewords per block]. */
  readonly groups: readonly (readonly [number, number])[];
  /** Alignment pattern centre coordinates, empty for version 1. */
  readonly alignment: readonly number[];
}

/** Versions 1 to 10 at error correction level M. */
const versionTable: readonly VersionTable[] = [
  { dataCodewords: 16, eccPerBlock: 10, groups: [[1, 16]], alignment: [] },
  { dataCodewords: 28, eccPerBlock: 16, groups: [[1, 28]], alignment: [6, 18] },
  { dataCodewords: 44, eccPerBlock: 26, groups: [[1, 44]], alignment: [6, 22] },
  { dataCodewords: 64, eccPerBlock: 18, groups: [[2, 32]], alignment: [6, 26] },
  { dataCodewords: 86, eccPerBlock: 24, groups: [[2, 43]], alignment: [6, 30] },
  { dataCodewords: 108, eccPerBlock: 16, groups: [[4, 27]], alignment: [6, 34] },
  { dataCodewords: 124, eccPerBlock: 18, groups: [[4, 31]], alignment: [6, 22, 38] },
  { dataCodewords: 154, eccPerBlock: 22, groups: [[2, 38], [2, 39]], alignment: [6, 24, 42] },
  { dataCodewords: 182, eccPerBlock: 22, groups: [[3, 36], [2, 37]], alignment: [6, 26, 46] },
  { dataCodewords: 216, eccPerBlock: 26, groups: [[4, 43], [1, 44]], alignment: [6, 28, 50] },
];

/* ------------------------------------------------------------------ Reed-Solomon over GF(256) */

const fieldPolynomial = 0x11d;

/** Log and antilog tables of GF(256) with the QR primitive polynomial. */
const exponentTable = new Uint8Array(512);
const logarithmTable = new Uint8Array(256);

{
  let value = 1;

  for (let index = 0; index < 255; index += 1) {
    exponentTable[index] = value;
    logarithmTable[value] = index;
    value <<= 1;

    if ((value & 0x100) !== 0) {
      value ^= fieldPolynomial;
    }
  }

  for (let index = 255; index < 512; index += 1) {
    exponentTable[index] = exponentTable[index - 255] as number;
  }
}

function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) {
    return 0;
  }

  return exponentTable[(logarithmTable[left] as number) + (logarithmTable[right] as number)] as number;
}

/** The generator polynomial of a given degree, highest term first, leading coefficient omitted. */
function generatorPolynomial(degree: number): Uint8Array {
  let polynomial = new Uint8Array([1]);

  for (let index = 0; index < degree; index += 1) {
    const next = new Uint8Array(polynomial.length + 1);
    const factor = exponentTable[index] as number;

    for (let position = 0; position < polynomial.length; position += 1) {
      next[position] = (next[position] as number) ^ (polynomial[position] as number);
      next[position + 1] =
        (next[position + 1] as number) ^ multiply(polynomial[position] as number, factor);
    }

    polynomial = next;
  }

  return polynomial.slice(1);
}

/** The error correction codewords of one block. */
function errorCorrection(data: readonly number[], eccCount: number): Uint8Array {
  const generator = generatorPolynomial(eccCount);
  const remainder = new Uint8Array(eccCount);

  for (const value of data) {
    const factor = value ^ (remainder[0] as number);

    remainder.copyWithin(0, 1);
    remainder[eccCount - 1] = 0;

    for (let index = 0; index < eccCount; index += 1) {
      remainder[index] = (remainder[index] as number) ^ multiply(generator[index] as number, factor);
    }
  }

  return remainder;
}

/* ------------------------------------------------------------------ the bit stream */

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let index = length - 1; index >= 0; index -= 1) {
      this.bits.push((value >>> index) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toBytes(): Uint8Array {
    const bytes = new Uint8Array(Math.ceil(this.bits.length / 8));

    for (const [index, bit] of this.bits.entries()) {
      if (bit === 1) {
        bytes[index >> 3] = (bytes[index >> 3] as number) | (0x80 >> (index & 7));
      }
    }

    return bytes;
  }
}

function characterCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function encodeData(text: string, table: VersionTable, version: number): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const buffer = new BitBuffer();

  buffer.push(0b0100, 4);
  buffer.push(bytes.length, characterCountBits(version));

  for (const byte of bytes) {
    buffer.push(byte, 8);
  }

  const capacityBits = table.dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - buffer.length);

  buffer.push(0, terminator);

  while (buffer.length % 8 !== 0) {
    buffer.push(0, 1);
  }

  const data = buffer.toBytes();
  const padded = new Uint8Array(table.dataCodewords);

  padded.set(data);

  const padBytes = [0xec, 0x11];

  for (let index = data.length, toggle = 0; index < padded.length; index += 1, toggle += 1) {
    padded[index] = padBytes[toggle % 2] as number;
  }

  return padded;
}

function interleave(data: Uint8Array, table: VersionTable): Uint8Array {
  const blocks: { data: number[]; ecc: Uint8Array }[] = [];
  let offset = 0;

  for (const [count, length] of table.groups) {
    for (let block = 0; block < count; block += 1) {
      const slice = Array.from(data.subarray(offset, offset + length));

      blocks.push({ data: slice, ecc: errorCorrection(slice, table.eccPerBlock) });
      offset += length;
    }
  }

  const longest = Math.max(...blocks.map((block) => block.data.length));
  const result: number[] = [];

  for (let index = 0; index < longest; index += 1) {
    for (const block of blocks) {
      const value = block.data[index];

      if (value !== undefined) {
        result.push(value);
      }
    }
  }

  for (let index = 0; index < table.eccPerBlock; index += 1) {
    for (const block of blocks) {
      result.push(block.ecc[index] as number);
    }
  }

  return Uint8Array.from(result);
}

/* ------------------------------------------------------------------ the matrix */

function createGrid(size: number): { modules: boolean[][]; reserved: boolean[][] } {
  return {
    modules: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
    reserved: Array.from({ length: size }, () => Array.from({ length: size }, () => false)),
  };
}

/** Write one module. A coordinate outside the symbol is a programming error and is ignored. */
function setModule(grid: boolean[][], row: number, column: number, value: boolean): void {
  const line = grid[row];

  if (line === undefined || column < 0 || column >= line.length) {
    return;
  }

  line[column] = value;
}

/** True when a module is part of a function pattern and must not carry data. */
function isReserved(grid: boolean[][], row: number, column: number): boolean {
  return grid[row]?.[column] === true;
}

function placeFinder(modules: boolean[][], reserved: boolean[][], row: number, column: number): void {
  for (let offsetRow = -1; offsetRow <= 7; offsetRow += 1) {
    for (let offsetColumn = -1; offsetColumn <= 7; offsetColumn += 1) {
      const targetRow = row + offsetRow;
      const targetColumn = column + offsetColumn;

      if (
        targetRow < 0 ||
        targetColumn < 0 ||
        targetRow >= modules.length ||
        targetColumn >= modules.length
      ) {
        continue;
      }

      const inRing =
        offsetRow >= 0 && offsetRow <= 6 && offsetColumn >= 0 && offsetColumn <= 6 &&
        (offsetRow === 0 || offsetRow === 6 || offsetColumn === 0 || offsetColumn === 6 ||
          (offsetRow >= 2 && offsetRow <= 4 && offsetColumn >= 2 && offsetColumn <= 4));

      setModule(modules, targetRow, targetColumn, inRing);
      setModule(reserved, targetRow, targetColumn, true);
    }
  }
}

function placeAlignment(modules: boolean[][], reserved: boolean[][], centers: readonly number[]): void {
  for (const row of centers) {
    for (const column of centers) {
      // The three corners are already the finder patterns.
      if (
        (row === 6 && column === 6) ||
        (row === 6 && column === modules.length - 7) ||
        (row === modules.length - 7 && column === 6)
      ) {
        continue;
      }

      for (let offsetRow = -2; offsetRow <= 2; offsetRow += 1) {
        for (let offsetColumn = -2; offsetColumn <= 2; offsetColumn += 1) {
          const isDark =
            Math.max(Math.abs(offsetRow), Math.abs(offsetColumn)) !== 1;

          setModule(modules, row + offsetRow, column + offsetColumn, isDark);
          setModule(reserved, row + offsetRow, column + offsetColumn, true);
        }
      }
    }
  }
}

function placeTiming(modules: boolean[][], reserved: boolean[][]): void {
  const size = modules.length;

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;

    setModule(modules, 6, index, dark);
    setModule(reserved, 6, index, true);
    setModule(modules, index, 6, dark);
    setModule(reserved, index, 6, true);
  }
}

function formatBits(mask: number): number {
  const data = (errorCorrectionBits << 3) | mask;
  const shifted = data << 10;
  let remainder = shifted;

  for (let index = 14; index >= 10; index -= 1) {
    if (((remainder >>> index) & 1) === 1) {
      remainder ^= 0x537 << (index - 10);
    }
  }

  return ((data << 10) | remainder) ^ 0x5412;
}

function versionBits(version: number): number {
  let remainder = version << 12;

  for (let index = 17; index >= 12; index -= 1) {
    if (((remainder >>> index) & 1) === 1) {
      remainder ^= 0x1f25 << (index - 12);
    }
  }

  return (version << 12) | remainder;
}

function placeFormat(modules: boolean[][], reserved: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);

  const place = (row: number, column: number, bit: boolean): void => {
    setModule(modules, row, column, bit);
    setModule(reserved, row, column, true);
  };

  for (let index = 0; index < 15; index += 1) {
    const bit = ((bits >>> index) & 1) === 1;

    // The vertical copy runs up the column beside the top left finder and then below it.
    if (index < 6) {
      place(index, 8, bit);
    } else if (index < 8) {
      place(index + 1, 8, bit);
    } else {
      place(size - 15 + index, 8, bit);
    }

    // The horizontal copy runs along the row beside it, then across the top right corner.
    if (index < 8) {
      place(8, size - 1 - index, bit);
    } else if (index < 9) {
      place(8, 7, bit);
    } else {
      place(8, 14 - index, bit);
    }
  }

  // The dark module, always adjacent to the bottom left finder and never part of the format.
  place(size - 8, 8, true);
}

function placeVersion(modules: boolean[][], reserved: boolean[][], version: number): void {
  if (version < 7) {
    return;
  }

  const size = modules.length;
  const bits = versionBits(version);

  for (let index = 0; index < 18; index += 1) {
    const bit = ((bits >>> index) & 1) === 1;
    const row = Math.floor(index / 3);
    const column = size - 11 + (index % 3);

    setModule(modules, row, column, bit);
    setModule(reserved, row, column, true);
    setModule(modules, column, row, bit);
    setModule(reserved, column, row, true);
  }
}

function placeData(
  modules: boolean[][],
  reserved: boolean[][],
  codewords: Uint8Array,
  mask: number,
): void {
  const size = modules.length;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let upward = true;
  let column = size - 1;

  while (column > 0) {
    // Column six is the vertical timing pattern; the pair to its left is skipped as a whole.
    if (column === 6) {
      column -= 1;
    }

    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;

      for (const offset of [0, 1]) {
        const targetColumn = column - offset;

        if (isReserved(reserved, row, targetColumn)) {
          continue;
        }

        const bit =
          bitIndex < totalBits
            ? ((codewords[bitIndex >> 3] as number) >>> (7 - (bitIndex & 7))) & 1
            : 0;

        bitIndex += 1;

        const flip = mask === 0 && (row + targetColumn) % 2 === 0;

        setModule(modules, row, targetColumn, flip ? bit === 0 : bit === 1);
      }
    }

    upward = !upward;
    column -= 2;
  }
}

/** Bits of one byte in the order the matrix carries them. */
export function bitsOf(bytes: Uint8Array): readonly number[] {
  const bits: number[] = [];

  for (const byte of bytes) {
    for (let index = 7; index >= 0; index -= 1) {
      bits.push((byte >>> index) & 1);
    }
  }

  return bits;
}

/** The smallest version that carries `byteLength` bytes of byte mode data at level M, or null. */
export function smallestVersion(byteLength: number): number | null {
  for (const [index, table] of versionTable.entries()) {
    const version = index + 1;
    const bits = 4 + characterCountBits(version) + byteLength * 8;

    if (bits <= table.dataCodewords * 8) {
      return version;
    }
  }

  return null;
}

/** The interleaved codewords of a payload, or null when it does not fit version 10 at level M. */
export function encodeQrCodewords(text: string): { version: number; codewords: Uint8Array } | null {
  const byteLength = new TextEncoder().encode(text).length;
  const version = smallestVersion(byteLength);

  if (version === null) {
    return null;
  }

  const table = versionTable[version - 1] as VersionTable;

  return { version, codewords: interleave(encodeData(text, table, version), table) };
}

/** Encode text as a QR symbol, or null when it does not fit version 10 at level M. */
export function encodeQr(text: string): QrMatrix | null {
  const byteLength = new TextEncoder().encode(text).length;
  const version = smallestVersion(byteLength);

  if (version === null) {
    return null;
  }

  const table = versionTable[version - 1] as VersionTable;
  const data = encodeData(text, table, version);
  const codewords = interleave(data, table);
  const size = 17 + version * 4;
  const { modules, reserved } = createGrid(size);

  placeFinder(modules, reserved, 0, 0);
  placeFinder(modules, reserved, 0, size - 7);
  placeFinder(modules, reserved, size - 7, 0);
  placeTiming(modules, reserved);

  if (table.alignment.length > 0) {
    placeAlignment(modules, reserved, table.alignment);
  }

  placeFormat(modules, reserved, maskPattern);
  placeVersion(modules, reserved, version);
  placeData(modules, reserved, codewords, maskPattern);

  return { version, size, modules };
}

/** The module grid as rows of "1" and "0", for a test that compares two encoders. */
export function qrRows(matrix: QrMatrix): readonly string[] {
  return matrix.modules.map((row) => row.map((dark) => (dark ? "1" : "0")).join(""));
}

