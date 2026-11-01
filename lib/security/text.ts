// path: lib/security/text.ts
/**
 * Text that is safe to store, compare and print.
 *
 * ## Why a library and not a regex at each call site
 *
 * Rule 11 of the master prompt asks for every input to be sanitised against XSS, null bytes and
 * Unicode tricks, and by STEP 055 forty files had answered that question in their own way. The rules
 * are therefore written once, here, in the order that matters:
 *
 *   1. **Normalise first.** NFC, so two spellings of one accented name compare equal and a hash of a
 *      name is the hash of *the* name. Compatibility folding (NFKC) is deliberately not used: it
 *      rewrites the two characters "1/2" into one glyph, which changes what a person wrote and makes
 *      a search for their own text miss it. The one exception is `sanitizeSlug`, which is an
 *      identifier rather than a name.
 *   2. **Then remove what must never exist.** The null byte terminates strings in C and in more SQL
 *      drivers than anyone expects; C0 and C1 controls are the mechanism of header injection; the
 *      line and paragraph separators break log lines and JavaScript; the zero-width and
 *      bidirectional characters are how a string displays as something other than what it is.
 *   3. **Then bound it.** A ceiling in code points, not in UTF-16 units, so an emoji costs one rather
 *      than two and a limit means the same number of characters for every script.
 *
 * ## What this module does not do
 *
 * It does not escape for HTML: a value that is stored is stored as written, and escaping belongs to
 * the moment of output (`escapeHtml` is here for that, and the rich text serialiser always calls it).
 * It does not decide whether an input is *valid* - zod does that, with a rule a form can show - and it
 * never rejects silently: `describeTextIssues` says which class of character was found, so a screen
 * can explain the refusal without printing the character.
 */

/** The characters removed from every text, with the reason each is in the list. */
export const UNSAFE_CHARACTER_GROUPS = Object.freeze({
  /** U+0000 terminates a string in C and in several drivers; nothing legitimate contains it. */
  nullByte: "\u0000",
  /** Header injection: CR, LF and the two Unicode line separators. */
  lineBreaks: ["\r", "\n", "\u2028", "\u2029"],
  /** The rest of C0 and all of C1: terminals, log parsers and CSV writers disagree about them. */
  controls: "\u0001-\u001f\u007f-\u009f",
  /** Zero-width characters: invisible, uncopyable and a way to smuggle a second value. */
  invisible: ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad"],
  /** Bidirectional overrides: the Trojan Source class, where a comment hides a declaration. */
  bidi: ["\u061c", "\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"],
  /** Unicode non-characters and the deprecated tag block: never text, only a payload. */
  nonCharacters: "\ufdd0-\ufdef\ufffe\uffff",
  tagCharacters: "\u{e0000}-\u{e007f}",
} as const);

/** The ceilings this library applies when a caller names none. */
export const TEXT_LIMITS = Object.freeze({
  singleLine: 200,
  multiLine: 4_000,
  header: 200,
  fileName: 120,
  slug: 80,
});

/** Which class of character a value carried, for a message that names the class and nothing else. */
export type TextIssueKind =
  | "null_byte"
  | "control_character"
  | "line_break"
  | "invisible_character"
  | "bidi_control"
  | "non_character"
  | "too_long";

export interface TextIssue {
  readonly kind: TextIssueKind;
  /** How many code points of this class were found. */
  readonly count: number;
}

export interface TextPolicy {
  /** The ceiling in code points. */
  readonly maxLength: number;
  /** True for a value that may contain line breaks (a note), false for a name. */
  readonly multiline: boolean;
}

const controlPattern = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const invisiblePattern = /[\u200b\u200c\u200d\u2060\ufeff\u00ad]/u;
const bidiPattern = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const nonCharacterPattern = /[\ufdd0-\ufdef\ufffe\uffff]/u;
const tagCharacterPattern = /[\u{e0000}-\u{e007f}]/u;

/** Every character this module treats as unsafe, as one pattern per class. */
const issuePatterns: readonly { readonly kind: TextIssueKind; readonly pattern: RegExp }[] = [
  { kind: "null_byte", pattern: /\u0000/u },
  { kind: "line_break", pattern: /[\r\u2028\u2029]/u },
  { kind: "control_character", pattern: controlPattern },
  { kind: "invisible_character", pattern: invisiblePattern },
  { kind: "bidi_control", pattern: bidiPattern },
  { kind: "non_character", pattern: nonCharacterPattern },
];

function countMatches(value: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let count = 0;

  while (global.exec(value) !== null) {
    count += 1;

    // A zero-width match would loop forever; none of these patterns can match empty, but a future
    // one could, and an infinite loop in a sanitiser is a denial of service.
    if (global.lastIndex === 0) {
      break;
    }
  }

  return count;
}

/**
 * Which classes of unsafe character a value carries, and how many of each.
 *
 * Separate from the sanitiser so a caller can refuse a value instead of quietly changing it: a
 * password or an API key must not be "cleaned", it must be rejected. The list never contains the
 * character itself, so a message built from it cannot echo the payload.
 */
export function describeTextIssues(input: string, policy: TextPolicy): readonly TextIssue[] {
  const issues: TextIssue[] = [];

  for (const { kind, pattern } of issuePatterns) {
    const count = countMatches(input, pattern);

    if (count > 0) {
      issues.push({ kind, count });
    }
  }

  const tagCount = countMatches(input, tagCharacterPattern);

  if (tagCount > 0) {
    issues.push({ kind: "control_character", count: tagCount });
  }

  const length = [...input].length;

  if (length > policy.maxLength) {
    issues.push({ kind: "too_long", count: length - policy.maxLength });
  }

  return issues;
}

/**
 * The sanitiser.
 *
 * Removed, never escaped: this function answers a value that is safe to *store*, and escaping at
 * storage time is how a database ends up holding `O&#39;Brien`. The one lossy part is whitespace -
 * a run of tabs and newlines becomes one space in a single-line value, and a run of blank lines
 * becomes one blank line in a multi-line one - because a note with forty blank lines is a way to
 * push a log entry off a screen.
 */
export function sanitizeText(input: string, policy: TextPolicy): string {
  const normalized = input.normalize("NFC");
  const withoutTagCharacters = normalized.replace(/[\u{e0000}-\u{e007f}]/gu, "");
  const withoutNulls = withoutTagCharacters.replaceAll("\u0000", "");
  const withoutBidi = withoutNulls.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
  const withoutInvisible = withoutBidi.replace(/[\u200b\u200c\u200d\u2060\ufeff\u00ad]/gu, "");
  const withoutNonCharacters = withoutInvisible.replace(/[\ufdd0-\ufdef\ufffe\uffff]/gu, "");

  if (policy.multiline) {
    const withLineBreaks = withoutNonCharacters
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .replace(/[\u2028\u2029]/gu, "\n")
      .replace(controlPattern, "");

    return [...withLineBreaks
      .split("\n")
      .map((line) => line.replace(/[^\S\n]+/gu, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim()]
      .slice(0, policy.maxLength)
      .join("");
  }

  const collapsed = withoutNonCharacters
    .replace(/[\r\n\u2028\u2029]/gu, " ")
    .replace(controlPattern, "")
    .replace(/\s+/gu, " ")
    .trim();

  return [...collapsed].slice(0, policy.maxLength).join("");
}

/** A name, a title, a subject line: one line, no leading or trailing space. */
export function sanitizeSingleLineText(input: string, maxLength: number = TEXT_LIMITS.singleLine): string {
  return sanitizeText(input, { maxLength, multiline: false });
}

/** A note or a description: several lines, no runs of blank lines. */
export function sanitizeMultilineText(input: string, maxLength: number = TEXT_LIMITS.multiLine): string {
  return sanitizeText(input, { maxLength, multiline: true });
}

/**
 * A value that is about to become an email header.
 *
 * The same rules as a single line plus the two that matter for a header: a colon-and-space after the
 * address and any whitespace-only value are removed by the caller's validation, and the ceiling is
 * the header limit rather than the text one. This exists as its own function so that a call site
 * reads as "this goes into a header" rather than "this is 200 characters".
 */
export function sanitizeHeaderValue(input: string, maxLength: number = TEXT_LIMITS.header): string {
  return sanitizeText(input, { maxLength, multiline: false });
}

/** The extensions Windows refuses to treat as a name, whatever the extension is. */
const reservedFileStems = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/**
 * A file name that cannot escape its directory.
 *
 * Path traversal is not only `../`: a backslash is a separator on Windows, `%2e%2e` is a traversal
 * once something decodes it, and a leading dot hides the file. The name is reduced to characters that
 * mean one thing everywhere, the separators and the traversal markers are removed, a reserved stem is
 * prefixed, and an empty result becomes `file` rather than an empty string that a caller might pass
 * to `open`.
 */
export function sanitizeFileName(input: string, maxLength: number = TEXT_LIMITS.fileName): string {
  const collapsed = sanitizeText(input.normalize("NFKC"), { maxLength: maxLength * 2, multiline: false })
    .replace(/[/\\]/gu, "-")
    .replace(/[%]/gu, "")
    .replace(/[^\p{L}\p{N}._ -]/gu, "")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[.\s-]+/u, "")
    .replace(/[.\s]+$/u, "");

  const stem = collapsed.split(".", 1)[0]?.toLowerCase() ?? "";
  const prefixed = reservedFileStems.has(stem) ? `_${collapsed}` : collapsed;
  const bounded = [...prefixed].slice(0, maxLength).join("");

  return bounded.length === 0 ? "file" : bounded;
}

/**
 * A slug: the identifier in a URL, so ASCII only.
 *
 * Compatibility folding *is* right here: a slug of a company called "K.D. Trading" is
 * `k-d-trading`, and folding the fullwidth letters of a Japanese name to their ASCII equivalents is
 * how a URL stays readable. What is left is `a-z`, `0-9` and single dashes.
 */
export function sanitizeSlug(input: string, maxLength: number = TEXT_LIMITS.slug): string {
  const folded = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return folded.slice(0, maxLength).replace(/-+$/u, "");
}

const htmlEntities: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/**
 * The one escaping function of the platform.
 *
 * All five characters are escaped, including both quote styles, because an unquoted attribute and a
 * single-quoted attribute are both legal HTML and a text node is not the only place a value lands.
 * `/` is left alone: it is only special inside a `<script>` element, and no template in this platform
 * builds one from a value.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/gu, (character) => htmlEntities[character] ?? character);
}

/** True when a value carries a character this library would remove, for a refusal instead of a clean. */
export function hasUnsafeCharacters(input: string): boolean {
  return describeTextIssues(input, { maxLength: Number.MAX_SAFE_INTEGER, multiline: true }).length > 0;
}
