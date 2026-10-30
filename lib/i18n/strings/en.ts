// path: lib/i18n/strings/en.ts
import { deepFreeze } from "../../utils/freeze.ts";

/**
 * The English string catalog: the single home of every user facing string.
 *
 * English is the schema. This object is the source language, `TranslationCatalog` is derived
 * from it, and every future locale must satisfy that same shape. Message paths are generated
 * from these keys, so a typo in a key is a compile error rather than a blank line on a
 * screen.
 *
 * Rules for this file:
 * - one key per rendered sentence or label, named in camelCase, grouped by area;
 * - no markup, no HTML and no formatting, because presentation belongs to the component;
 * - placeholders are written `{name}` with a camelCase identifier and are only used through
 *   `formatMessage`, which refuses to render a half substituted sentence;
 * - no number, amount, date or limit lives here. Business values come from `config/app.ts`;
 *   this file only decides how a value is worded.
 */

const catalog = {
  locale: {
    /** BCP 47 language tag, used for `lang` on the document element. */
    code: "en",
    /** Human readable name of the language, for a future language picker. */
    name: "English",
    /** Writing direction of the language. */
    direction: "ltr",
  },
  brand: {
    name: "KD Solution IT",
    description:
      "Enterprise multi-tenant payment facilitator platform for Asian merchants with worldwide merchant country control.",
  },
  home: {
    eyebrow: "Foundation",
    facts: {
      currency:
        "Amounts are held in USD only, stored as numeric(18,4) and never calculated with floating point.",
      isolation:
        "Every tenant record is isolated by row level security and every mutation is audit logged.",
      storage: "Files are encrypted with AES-256-GCM before they reach object storage.",
    },
    structureGate:
      "The structure gate enforces {directories} canonical directories and {rootFiles} root files on every verification run.",
    healthLink: "Service health",
  },
} as const;

export const en = deepFreeze(catalog);

/** The contract every locale must satisfy. English is the source language. */
export type TranslationCatalog = typeof en;
