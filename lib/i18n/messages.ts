// path: lib/i18n/messages.ts
import { en, type TranslationCatalog } from "./strings/en.ts";

export type { TranslationCatalog };

/** The locale used when a caller does not name one. */
export const DEFAULT_LOCALE = en.locale.code;

/** Locales shipped today. The platform is English only until a later STEP adds a language. */
export const SUPPORTED_LOCALES = [en.locale.code] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/**
 * Every dotted path in the catalog that points at a message.
 *
 * Derived recursively from the catalog, so any nesting depth is supported and a new group
 * needs no change here. The compiler then rejects a misspelled key at the call site.
 */
type CatalogPaths<TValue, TPrefix extends string = ""> = {
  [Key in keyof TValue & string]: TValue[Key] extends string
    ? `${TPrefix}${Key}`
    : CatalogPaths<TValue[Key], `${TPrefix}${Key}.`>;
}[keyof TValue & string];

export type MessagePath = CatalogPaths<TranslationCatalog>;

export type MessageParameters = Readonly<Record<string, string | number>>;

const interpolationPattern = /\{([a-zA-Z][a-zA-Z0-9]*)\}/gu;
const interpolationPresencePattern = /\{[a-zA-Z][a-zA-Z0-9]*\}/u;

function readTemplate(path: MessagePath, catalog: TranslationCatalog): string {
  let current: unknown = catalog;
  const segments = path.split(".");

  for (const [index, segment] of segments.entries()) {
    if (typeof current !== "object" || current === null) {
      throw new Error(
        `Message path "${path}" is not a message: "${segments.slice(0, index).join(".")}" is a string.`,
      );
    }

    // Object.hasOwn is the guard that makes this index access safe.
    const node = current as Record<string, unknown>;
    if (!Object.hasOwn(node, segment)) {
      throw new Error(`Unknown message path: "${path}".`);
    }

    current = node[segment];
  }

  if (typeof current !== "string") {
    throw new Error(`Message path "${path}" points at a group, not at a message.`);
  }

  return current;
}

/**
 * Reads a message that takes no parameters.
 *
 * Throws when the template still contains a placeholder: a caller that forgets to pass values
 * gets a defect instead of a sentence with `{count}` visible to a merchant.
 */
export function getMessage(
  path: MessagePath,
  catalog: TranslationCatalog = en,
): string {
  const template = readTemplate(path, catalog);

  if (interpolationPresencePattern.test(template)) {
    throw new Error(
      `Message "${path}" needs parameters; use formatMessage instead of getMessage.`,
    );
  }

  return template;
}

/**
 * Reads a message and fills its placeholders.
 *
 * The parameter set must match the template exactly. A missing parameter throws, and so does
 * an unused one, because both mean the caller and the copy have drifted apart. Numbers are
 * rendered with String(), so a caller passes an already formatted value when formatting
 * matters: this layer words messages, it does not format money or dates.
 */
export function formatMessage(
  path: MessagePath,
  parameters: MessageParameters,
  catalog: TranslationCatalog = en,
): string {
  const template = readTemplate(path, catalog);
  const missing: string[] = [];
  const substituted = new Set<string>();

  const rendered = template.replace(
    interpolationPattern,
    (match: string, name: string): string => {
      const value = parameters[name];

      if (value === undefined) {
        missing.push(name);
        return match;
      }

      substituted.add(name);
      return String(value);
    },
  );

  if (missing.length > 0) {
    throw new Error(`Message "${path}" is missing parameters: ${missing.join(", ")}.`);
  }

  const unused = Object.keys(parameters).filter((name) => !substituted.has(name));
  if (unused.length > 0) {
    throw new Error(`Message "${path}" received unused parameters: ${unused.join(", ")}.`);
  }

  return rendered;
}
