// path: lib/i18n/verify.ts
import process from "node:process";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./messages.ts";
import { en } from "./strings/en.ts";

/**
 * String catalog gate. Run with `npm run check:i18n`, and inside `npm run verify`.
 *
 * Executed directly by Node.js 26 against the same TypeScript catalog the application
 * imports. It defends four rules that are cheap to check and expensive to notice later:
 *
 *   1. no message is empty or padded with whitespace, because that renders a blank label;
 *   2. a placeholder is well formed and a stray brace is a defect, not a character;
 *   3. content is English only (MASTER_PROMPT rule 1): anything outside printable ASCII must
 *      be one of the typographic characters deliberately allowed below;
 *   4. the locale metadata is consistent with the locales the application ships.
 */

interface CatalogMessage {
  readonly path: string;
  readonly value: string;
}

const placeholderPattern = /\{[a-zA-Z][a-zA-Z0-9]*\}/gu;
const bracePattern = /[{}]/u;
const repeatedWhitespacePattern = /\s{2,}/u;

/**
 * Typographic characters allowed in English copy: en dash, em dash, curly quotes, ellipsis,
 * bullet and middle dot. Everything else outside printable ASCII fails the gate, so a stray
 * translation cannot enter through a copy paste.
 */
const allowedNonAsciiCharacters = new Set([
  "\u2013",
  "\u2014",
  "\u2018",
  "\u2019",
  "\u201C",
  "\u201D",
  "\u2026",
  "\u2022",
  "\u00B7",
]);

function collectMessages(
  value: unknown,
  path: string,
  messages: CatalogMessage[],
  failures: string[],
): void {
  if (typeof value === "string") {
    messages.push({ path, value });
    return;
  }

  if (Array.isArray(value) || value === null || typeof value !== "object") {
    failures.push(`${path} must be a string`);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectMessages(child, path.length === 0 ? key : `${path}.${key}`, messages, failures);
  }
}

function checkMessage(message: CatalogMessage, failures: string[]): void {
  const { path, value } = message;

  if (value.trim().length === 0) {
    failures.push(`${path} must not be empty`);
    return;
  }

  if (value !== value.trim()) {
    failures.push(`${path} must not start or end with whitespace`);
  }

  if (repeatedWhitespacePattern.test(value)) {
    failures.push(`${path} must not contain repeated whitespace or a line break`);
  }

  const withoutPlaceholders = value.replace(placeholderPattern, "");
  if (bracePattern.test(withoutPlaceholders)) {
    failures.push(`${path} contains a malformed placeholder`);
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint > 126 && !allowedNonAsciiCharacters.has(character)) {
      failures.push(
        `${path} contains a non English character (U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`,
      );
    }
  }
}

function main(): void {
  const failures: string[] = [];
  const messages: CatalogMessage[] = [];

  collectMessages(en, "", messages, failures);

  for (const message of messages) {
    checkMessage(message, failures);
  }

  if (en.locale.code !== DEFAULT_LOCALE) {
    failures.push(
      `locale.code "${en.locale.code}" must match DEFAULT_LOCALE "${DEFAULT_LOCALE}"`,
    );
  }
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(en.locale.code)) {
    failures.push(`locale.code "${en.locale.code}" is not listed in SUPPORTED_LOCALES`);
  }
  if (en.locale.direction !== "ltr") {
    failures.push('locale.direction must be "ltr" for the English catalog');
  }

  if (failures.length > 0) {
    process.stderr.write(`i18n gate failed with ${failures.length} problem(s):\n`);
    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }
    process.exitCode = 1;
    return;
  }

  const placeholderCount = messages.reduce(
    (total, message) => total + (message.value.match(placeholderPattern)?.length ?? 0),
    0,
  );

  process.stdout.write(
    `i18n gate passed: ${messages.length} messages, ${placeholderCount} placeholders, ` +
      `${SUPPORTED_LOCALES.length} locale (${en.locale.code}, ${en.locale.direction})\n`,
  );
}

main();
