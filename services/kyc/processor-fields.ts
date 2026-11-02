// path: services/kyc/processor-fields.ts
import { PLATFORM_PROVIDERS, type ProviderKey } from "../../lib/gateways/registry.ts";

/**
 * Which business facts each of the five section 6 processors asks for, and therefore which fields the
 * section 5 form has to collect.
 *
 * ## Why the matrix is here and not in the form
 *
 * Section 5 says the form "follows the connected processor requirements and changes per processor".
 * A form that hard coded its fields would be right for whichever processor was read last and wrong
 * for the other four; a form that asked the database would be asking a question that is a fact about
 * *this build*, not about a row somebody edited. The matrix is therefore code, beside the adapter
 * registry of section 6, and the five keys are imported from `lib/gateways/registry.ts` rather than
 * written again - the same list `0029` closed in SQL and `0094` seeded.
 *
 * ## Required and optional, per processor
 *
 * `required` is what that processor will not open an account without; `optional` is what it accepts
 * when the merchant has it and does not ask for when they do not (a trading name, usually). The form
 * marks a field as required when **any** processor on the platform requires it, because section 5
 * says one profile is sent to every connected processor: a profile that satisfies one adapter and
 * not the next is a merchant who is approved for acceptance and blocked for payouts.
 *
 * ## Where the numbers come from, and what they are not
 *
 * Each entry is the business-information subset of that provider's own onboarding requirements - the
 * legal name, the entity type, the registration number, the tax id, the website and what the business
 * sells - and nothing about addresses, contact people, category codes or documents, which are the
 * later steps of this section (STEPs 081, 082 and the document steps). The adapter STEPs (147-169)
 * read that provider's live documentation when they are written; this file is the *platform's* stored
 * shape, and it stays true even when a provider adds a field an adapter must send: the adapter maps
 * the field it needs from the columns the merchant filled here.
 */

/** Every business fact the section 5 form stores, in the order the form asks for them. */
export const BUSINESS_PROFILE_FIELDS = [
  "legal_name",
  "trading_name",
  "business_type",
  "registration_number",
  "tax_id",
  "website",
  "business_description",
] as const;

/** One field of the business profile. */
export type BusinessProfileField = (typeof BUSINESS_PROFILE_FIELDS)[number];

/** One processor's view of the form: what it insists on, and what it takes when offered. */
export interface ProcessorRequirement {
  readonly provider: ProviderKey;
  readonly displayName: string;
  readonly required: readonly BusinessProfileField[];
  readonly optional: readonly BusinessProfileField[];
}

/**
 * The five of section 6, each with the business facts it asks for.
 *
 * NMI opens a gateway sub-merchant on a legal name, an entity type, a website for a card-not-present
 * merchant and a description of what is sold. Rainforest and Airwallex additionally require the
 * company registration number, and Rainforest the tax id. Stripe Connect requires the tax id and the
 * website. Payoneer is payouts only, so it asks for the payee's legal name, entity type and tax id
 * and neither a website nor a description.
 *
 * `trading_name` is optional with all five: every adapter sends it when it exists and none refuses a
 * merchant who trades under their registered name.
 */
export const PROCESSOR_REQUIREMENTS: Readonly<Record<ProviderKey, ProcessorRequirement>> = Object.freeze({
  nmi: Object.freeze({
    provider: "nmi",
    displayName: "NMI",
    required: Object.freeze([
      "legal_name",
      "business_type",
      "website",
      "business_description",
    ] as const satisfies readonly BusinessProfileField[]),
    optional: Object.freeze(["trading_name"] as const satisfies readonly BusinessProfileField[]),
  }),
  payoneer: Object.freeze({
    provider: "payoneer",
    displayName: "Payoneer",
    required: Object.freeze([
      "legal_name",
      "business_type",
      "tax_id",
    ] as const satisfies readonly BusinessProfileField[]),
    optional: Object.freeze(["trading_name"] as const satisfies readonly BusinessProfileField[]),
  }),
  rainforest: Object.freeze({
    provider: "rainforest",
    displayName: "Rainforest",
    required: Object.freeze([
      "legal_name",
      "business_type",
      "registration_number",
      "tax_id",
      "website",
    ] as const satisfies readonly BusinessProfileField[]),
    optional: Object.freeze([
      "trading_name",
      "business_description",
    ] as const satisfies readonly BusinessProfileField[]),
  }),
  stripe_connect: Object.freeze({
    provider: "stripe_connect",
    displayName: "Stripe Connect",
    required: Object.freeze([
      "legal_name",
      "business_type",
      "tax_id",
      "website",
    ] as const satisfies readonly BusinessProfileField[]),
    optional: Object.freeze([
      "trading_name",
      "business_description",
    ] as const satisfies readonly BusinessProfileField[]),
  }),
  airwallex: Object.freeze({
    provider: "airwallex",
    displayName: "Airwallex",
    required: Object.freeze([
      "legal_name",
      "trading_name",
      "business_type",
      "registration_number",
      "website",
    ] as const satisfies readonly BusinessProfileField[]),
    optional: Object.freeze([
      "tax_id",
      "business_description",
    ] as const satisfies readonly BusinessProfileField[]),
  }),
});

/** The five requirements in the registry's own order, which is the order the form lists them. */
export const PROCESSOR_REQUIREMENT_LIST: readonly ProcessorRequirement[] = Object.freeze(
  PLATFORM_PROVIDERS.map((provider) => PROCESSOR_REQUIREMENTS[provider.key]),
);

/**
 * Every field some processor requires, in the form's order.
 *
 * Computed from the matrix rather than written out, so removing a processor from the registry of
 * section 6 narrows the form with it instead of leaving a field nobody asks for.
 */
export const REQUIRED_BUSINESS_FIELDS: readonly BusinessProfileField[] = Object.freeze(
  BUSINESS_PROFILE_FIELDS.filter((field) =>
    PROCESSOR_REQUIREMENT_LIST.some((requirement) => requirement.required.includes(field)),
  ),
);

/** The fields no processor insists on: stored when the merchant gives them, never demanded. */
export const OPTIONAL_BUSINESS_FIELDS: readonly BusinessProfileField[] = Object.freeze(
  BUSINESS_PROFILE_FIELDS.filter((field) => !REQUIRED_BUSINESS_FIELDS.includes(field)),
);

/** The requirement of one processor. */
export function processorRequirementOf(provider: ProviderKey): ProcessorRequirement {
  return PROCESSOR_REQUIREMENTS[provider];
}
