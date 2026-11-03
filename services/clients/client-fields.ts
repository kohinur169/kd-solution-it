// path: services/clients/client-fields.ts

/**
 * The fields of one client row (`0019`), in their own module so the form can import the list and
 * the ceilings without pulling the service's server-only imports into the browser bundle - the same
 * split `services/kyc/kyc-document-types.ts` makes for the document types.
 *
 * The ceilings mirror the `0019` checks one to one; the gate of `services/clients/verify.ts` reads
 * the migration and asserts every limit appears there, so the two cannot drift.
 */

/** Every column a merchant can fill on a client, in form order. */
export const CLIENT_FIELDS = [
  "name",
  "company_name",
  "email",
  "phone",
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
  "tax_id",
  "notes",
] as const;

/** One field of a client row. */
export type ClientField = (typeof CLIENT_FIELDS)[number];

/** The fields that make up the billing address; `0019` requires line1 once any of these is set. */
export const CLIENT_ADDRESS_FIELDS = [
  "address_line1",
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
] as const;

/** The fields other than line1 whose presence demands line1 (`clients_address_complete_check`). */
export const CLIENT_ADDRESS_REQUIRED_TRIGGERS = [
  "address_line2",
  "city",
  "region",
  "postal_code",
  "country",
] as const;

/** The character ceilings of `0019`, one per field. `null` means the field is required. */
export const CLIENT_FIELD_LIMITS: Readonly<Record<ClientField, { readonly min: number | null; readonly max: number }>> =
  Object.freeze({
    name: Object.freeze({ min: 1, max: 120 }),
    company_name: Object.freeze({ min: null, max: 160 }),
    email: Object.freeze({ min: null, max: 254 }),
    phone: Object.freeze({ min: null, max: 32 }),
    address_line1: Object.freeze({ min: null, max: 160 }),
    address_line2: Object.freeze({ min: null, max: 160 }),
    city: Object.freeze({ min: null, max: 80 }),
    region: Object.freeze({ min: null, max: 80 }),
    postal_code: Object.freeze({ min: null, max: 16 }),
    country: Object.freeze({ min: null, max: 2 }),
    tax_id: Object.freeze({ min: null, max: 32 }),
    notes: Object.freeze({ min: null, max: 2_000 }),
  });

/** The shape of an email address, the same expression `clients_email_check` uses. */
export const CLIENT_EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$/u;

/** The shape of a phone number, the same expression `clients_phone_check` uses. */
export const CLIENT_PHONE_PATTERN = /^[+]?[0-9][0-9 ().-]{4,30}$/u;

/** The shape of a postal code, the same expression `clients_postal_code_check` uses. */
export const CLIENT_POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,14}[A-Za-z0-9]$/u;

/** The shape of a country, the same expression `clients_country_check` uses: ISO 3166-1 alpha-2. */
export const CLIENT_COUNTRY_PATTERN = /^[A-Z]{2}$/u;
