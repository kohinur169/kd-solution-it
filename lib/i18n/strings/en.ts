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
  shell: {
    /** Skip link, announced to a screen reader before the header. */
    skipToContent: "Skip to content",
    /** Accessible name of the brand link in the header. */
    homeLink: "Go to the home page",
    /** Accessible name of the theme switcher group. */
    themeLabel: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
  },
  errors: {
    /** Every message states what the client can do next. None describes what the server saw. */
    validationFailed:
      "Some of the information sent could not be accepted. Check the highlighted fields and try again.",
    authenticationRequired: "Sign in to continue.",
    permissionDenied: "This account does not have permission to perform that action.",
    resourceNotFound: "The requested item could not be found.",
    methodNotAllowed: "This endpoint does not accept that request method.",
    conflict: "The item was changed by another request. Reload it and try again.",
    idempotencyConflict:
      "A request with this idempotency key was already processed with different details.",
    payloadTooLarge: "The request is larger than this endpoint accepts.",
    unsupportedMediaType: "This endpoint accepts JSON request bodies only.",
    rateLimited: "Too many requests. Wait a moment and try again.",
    dependencyFailed: "A connected service did not answer correctly. Try again shortly.",
    serviceUnavailable: "The service is temporarily unavailable. Try again shortly.",
    timeout: "The request took too long to complete. Try again.",
    internal: "Something went wrong on our side. Quote the request id when you contact support.",
  },
  errorScreen: {
    title: "Something went wrong",
    description:
      "This page could not be shown. Try again, and quote the reference below if the problem continues.",
    retry: "Try again",
    home: "Back to the home page",
    referenceLabel: "Reference",
  },
} as const;

export const en = deepFreeze(catalog);

/** The contract every locale must satisfy. English is the source language. */
export type TranslationCatalog = typeof en;
