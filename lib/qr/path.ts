// path: lib/qr/path.ts
import type { QrMatrix } from "./qr.ts";

/**
 * A QR module matrix as a drawing instruction, not as a picture.
 *
 * The enrolment screen has to show a symbol that stays sharp at any size, and it has to do so
 * without `dangerouslySetInnerHTML` and without an `<img>` of a generated document. The answer is
 * the smallest thing both a browser and an image renderer understand: one SVG path of horizontal
 * runs, plus the extent it is drawn into. React draws it as `<path>`, a printable page draws it as
 * `<svg>`, and neither receives a string it must trust.
 *
 * A run is one row of consecutive dark modules, so a version 10 symbol - several thousand modules -
 * becomes a few hundred instructions instead of several thousand elements.
 *
 * The quiet zone is part of the extent rather than the caller's padding: four modules is what the
 * specification asks for, and a symbol glued to an edge does not scan.
 */

export interface QrPathOptions {
  /** Side of one module in the drawing's units. Four is enough for a screen. */
  readonly moduleSize?: number;
  /** Modules of margin on every side. The specification asks for four. */
  readonly quietZone?: number;
}

export interface QrPath {
  /** Side of the whole drawing, quiet zone included, in the drawing's units. */
  readonly extent: number;
  /** The `d` attribute of the path, relative-free and ending in a closed subpath per run. */
  readonly data: string;
}

const defaultModuleSize = 4;
const defaultQuietZone = 4;

export function qrPath(matrix: QrMatrix, options: QrPathOptions = {}): QrPath {
  const moduleSize = options.moduleSize ?? defaultModuleSize;
  const quietZone = options.quietZone ?? defaultQuietZone;
  const runs: string[] = [];

  for (const [row, line] of matrix.modules.entries()) {
    let column = 0;

    while (column < line.length) {
      if (line[column] !== true) {
        column += 1;

        continue;
      }

      const start = column;

      while (column < line.length && line[column] === true) {
        column += 1;
      }

      const x = (start + quietZone) * moduleSize;
      const y = (row + quietZone) * moduleSize;
      const width = (column - start) * moduleSize;

      runs.push(`M${x} ${y}h${width}v${moduleSize}h-${width}z`);
    }
  }

  return {
    extent: (matrix.size + quietZone * 2) * moduleSize,
    data: runs.join(""),
  };
}
