// path: services/products/catalogue-fields.ts

/**
 * What a product and a service have in common, in one module.
 *
 * Section 15 asks for both catalogues in one sentence and `0020`/`0021` give them the same money rules
 * and the same closed unit list; only the identity of a row differs - a product is known by a SKU and
 * counts in `item`, a service is known by a code and is billed by `hour`. So the vocabulary lives here
 * once: the field lists, the ceilings the migrations check, the currency and unit lists, and the two
 * table names. Both services import it, both forms import it, and the gate reads the migrations to
 * prove the numbers below still match the checks in SQL.
 *
 * Nothing here imports a server-only module: the browser needs these lists to draw the form, exactly
 * as `services/clients/client-fields.ts` is imported by the client form.
 */

/** The two catalogues of section 15. */
export const CATALOGUE_KINDS = ["product", "service"] as const;

/** One catalogue. */
export type CatalogueKind = (typeof CATALOGUE_KINDS)[number];

/** The tables of `0020` and `0021`. */
export const CATALOGUE_TABLES: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "products",
  service: "services",
});

/**
 * The column that names a row, which is the one thing the two tables spell differently.
 *
 * A product is identified by a stock keeping code, a service by a service code; `0020` calls the
 * column `sku` and `0021` calls it `code`, and both allow the same 48 characters with the same shape.
 */
export const CATALOGUE_CODE_COLUMN: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "sku",
  service: "code",
});

/** The default unit of each catalogue, as the two migrations declare it. */
export const CATALOGUE_DEFAULT_UNIT: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "item",
  service: "hour",
});

/** The writable columns of a catalogue row, in form order. The code column is named separately. */
export const CATALOGUE_FIELDS = ["name", "description", "unit_price", "unit"] as const;

/** One writable column, as the form and the service both spell it. */
export type CatalogueField = (typeof CATALOGUE_FIELDS)[number];

/**
 * The closed unit list of `0020` and `0021`.
 *
 * One list for both tables on purpose: the invoice prints the quantity and this word together, so
 * "2 hour" has to be spelled the same way whichever catalogue row produced the line.
 */
export const CATALOGUE_UNITS = ["item", "unit", "hour", "day", "week", "month", "project"] as const;

/** One unit. */
export type CatalogueUnit = (typeof CATALOGUE_UNITS)[number];

/**
 * The currencies a catalogue row may carry.
 *
 * `0020` and `0021` check three upper case letters, and the platform itself is USD only
 * (FEATURE_LIST section 1, and `config/app.ts` refuses anything else), so the form offers the one
 * currency the platform can actually charge in rather than a list it would then have to police. A
 * later STEP that adds a currency adds it here and in `config/app.ts` together.
 */
export const CATALOGUE_CURRENCIES = ["USD"] as const;

/** One currency. */
export type CatalogueCurrency = (typeof CATALOGUE_CURRENCIES)[number];

/** The character ceilings of `0020` and `0021`, one per field. `name` is the required one. */
export const CATALOGUE_FIELD_LIMITS: Readonly<
  Record<"name" | "code" | "description", { readonly min: number | null; readonly max: number }>
> = Object.freeze({
  name: Object.freeze({ min: 1, max: 160 }),
  code: Object.freeze({ min: null, max: 48 }),
  description: Object.freeze({ min: null, max: 2_000 }),
});

/** The shape of a code, the same expression `products_sku_check` and `services_code_check` use. */
export const CATALOGUE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u;

/** The shape of a currency, the same expression the two `*_currency_check` constraints use. */
export const CATALOGUE_CURRENCY_PATTERN = /^[A-Z]{3}$/u;

/** True when a value is one of the two catalogues. */
export function isCatalogueKind(value: string): value is CatalogueKind {
  return (CATALOGUE_KINDS as readonly string[]).includes(value);
}

/** True when a value is one of the seven units. */
export function isCatalogueUnit(value: string): value is CatalogueUnit {
  return (CATALOGUE_UNITS as readonly string[]).includes(value);
}

/**
 * The path segment and screen folder of one catalogue.
 *
 * A product and a service are one shape with two names, so a screen is written once and mounted at
 * both paths; this map is what keeps the two spellings in one place instead of in a conditional in
 * every file.
 */
export const CATALOGUE_PATHS: Readonly<Record<CatalogueKind, string>> = Object.freeze({
  product: "products",
  service: "services",
});
