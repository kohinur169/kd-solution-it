// path: services/kyc/business-address-fields.ts

/**
 * The field list of the address and contact section of section 5, in its own module so the client
 * form can import it without pulling the server-side service (and its database client) into the
 * browser bundle. `services/kyc/business-address.ts` re-exports everything here and is the only
 * module that reads or writes the columns themselves.
 *
 * ## Why the list is shared
 *
 * The form renders one input per field in this order, the service validates the same nine keys, and
 * the gate walks the same list - one list, three readers, no drift.
 */

/** Every address and contact field the section stores, in the form's order. */
export const BUSINESS_ADDRESS_FIELDS = [
  "address_line1",
  "address_line2",
  "city",
  "state_province",
  "postal_code",
  "country_code",
  "contact_name",
  "contact_email",
  "contact_phone",
] as const;

/** One field of the address and contact section. */
export type BusinessAddressField = (typeof BUSINESS_ADDRESS_FIELDS)[number];

/** The fields the address step needs before it counts as finished: everything but the two optional lines. */
export const REQUIRED_ADDRESS_FIELDS: readonly BusinessAddressField[] = Object.freeze(
  BUSINESS_ADDRESS_FIELDS.filter((field) => field !== "address_line2" && field !== "state_province"),
);

/** The optional fields: stored when given, never demanded. */
export const OPTIONAL_ADDRESS_FIELDS: readonly BusinessAddressField[] = Object.freeze(
  BUSINESS_ADDRESS_FIELDS.filter((field) => !REQUIRED_ADDRESS_FIELDS.includes(field)),
);

/** The ceilings the form and the sanitiser share. */
export const ADDRESS_FIELD_LIMITS = Object.freeze({
  address_line1: 120,
  address_line2: 120,
  city: 80,
  state_province: 80,
  postal_code: 12,
  country_code: 2,
  contact_name: 120,
  contact_email: 254,
  contact_phone: 33,
} as const);
