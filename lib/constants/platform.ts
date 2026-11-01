// path: lib/constants/platform.ts

/**
 * Technical platform identifiers shared by server code, route handlers and scripts.
 * Display copy never lives here: user facing text belongs to the string catalog that
 * STEP 006 creates in lib/i18n/strings/en.ts. Only values that must never be translated
 * or localized are allowed in this module.
 */
export const PLATFORM_SERVICE_SLUG = "kd-solution-it";

/** Release stage of this repository, compared against the STEP plan during reviews. */
export const PLATFORM_RELEASE_STAGE = "foundation";
