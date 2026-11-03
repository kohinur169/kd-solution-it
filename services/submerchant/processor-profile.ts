// path: services/submerchant/processor-profile.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { PlatformRole, RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { PLATFORM_PROVIDERS, type ProviderKey } from "../../lib/gateways/registry.ts";
import { BUSINESS_ADDRESS_FIELDS, REQUIRED_ADDRESS_FIELDS, type BusinessAddressField } from "../kyc/business-address-fields.ts";
import { COUNTRIES_TABLE } from "../kyc/business-address.ts";
import { BUSINESS_PROFILE_TABLE } from "../kyc/business-profile.ts";
import { MCC_CODES_TABLE } from "../kyc/merchant-category.ts";
import {
  BUSINESS_PROFILE_FIELDS,
  PROCESSOR_REQUIREMENTS,
  PROCESSOR_REQUIREMENT_LIST,
  REQUIRED_BUSINESS_FIELDS,
  type BusinessProfileField,
} from "../kyc/processor-fields.ts";

/**
 * The one-time profile, assembled for the processors of section 6.
 *
 * ## What this module owns
 *
 * Section 5 says the merchant sets their business information once on the platform and the same
 * information is sent to every connected processor. STEPs 080-082 stored those facts on the one
 * `business_profiles` row of `0103` (business fields of `processor-fields.ts`, the category code of
 * `0104`, the address and contact of `0105`). This file is the read side of that sentence: it reads
 * the row once, resolves the two reference names (the code's title from `0077`, the country's name
 * from `0076`), and answers the two questions every processor adapter asks - "what do you send me"
 * (`processorPayloadFor`) and "can you open an account for this merchant at all"
 * (`assertProvisionable`).
 *
 * ## Why the payload is computed per provider and not stored
 *
 * The per-processor requirement matrix of `services/kyc/processor-fields.ts` is code, because it is
 * a fact about this build. A stored payload would be a fact about one moment, and the first time a
 * provider changes what it asks for, every stored payload would be wrong while this computation
 * would be right. The provisioning job therefore calls this service at the moment it opens the
 * sub-merchant, and `0054`'s provision row records the result, not the input.
 *
 * ## Who may read it
 *
 * The owner reads their own company's profile - the review step of the wizard shows it. The office
 * roles that approve or underwrite (`super_admin`, `ceo`, `compliance_kyc`) read any one merchant's
 * profile by naming the company in `companyId`, and every such read is audit logged, because an
 * office read of a merchant's data is exactly the kind of event section 2 wants in the chain. The
 * background provisioning job does not come through HTTP at all: it calls this service with the
 * service role key and a company id, which is why the company is a parameter of the function and
 * never of a request body.
 *
 * ## What "ready" means
 *
 * Ready is derived from the values, never from a stamp: every business field some processor
 * requires, the category code, and the seven required address fields. The two completion instants
 * of `0103` and `0105` are reported beside it so a screen can show the wizard's own answer, but the
 * payload's readiness is the union of the processors' requirements - a profile that satisfies the
 * stamps but misses a field one adapter insists on is not ready to be sent, and the other way
 * round cannot happen, because both stamps are derived from the same values by the save services.
 */

/** The office roles that may read any merchant's profile, by naming the company. */
export const PROCESSOR_PROFILE_OFFICE_ROLES: readonly PlatformRole[] = Object.freeze([
  "super_admin",
  "ceo",
  "compliance_kyc",
] as const satisfies readonly PlatformRole[]);

/** Every role that may read a processor profile: the office roles, plus the owner of their own. */
export const PROCESSOR_PROFILE_READER_ROLES: readonly PlatformRole[] = Object.freeze([
  ...PROCESSOR_PROFILE_OFFICE_ROLES,
  "owner",
] as const satisfies readonly PlatformRole[]);

/** The audit action an office read of a merchant profile is recorded under. */
export const PROCESSOR_PROFILE_AUDIT_ACTION = "processor_profile.read_by_office";

/** The audit entity the read is recorded against: the business profile of the merchant read. */
export const PROCESSOR_PROFILE_AUDIT_ENTITY = "business_profile";

/** The one row every section 5 form writes, read here in full. */
const profileRowSchema = z.object({
  company_id: z.string(),
  legal_name: z.string().nullable(),
  trading_name: z.string().nullable(),
  business_type: z.string().nullable(),
  registration_number: z.string().nullable(),
  tax_id: z.string().nullable(),
  website: z.string().nullable(),
  business_description: z.string().nullable(),
  mcc_code: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  state_province: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  address_completed_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  updated_at: z.string(),
});

type ProfileRow = z.infer<typeof profileRowSchema>;

const mccTitleSchema = z.object({ code: z.string(), title: z.string() });
const countryNameSchema = z.object({ code: z.string(), name: z.string() });

/** The chosen category, with the published title resolved from `0077`. */
export interface ProcessorCategory {
  readonly code: string;
  readonly title: string | null;
}

/** One processor's coverage of the profile: what it asks for, and what is still missing. */
export interface ProcessorCoverageView {
  readonly provider: ProviderKey;
  readonly displayName: string;
  readonly required: readonly BusinessProfileField[];
  readonly optional: readonly BusinessProfileField[];
  readonly missing: readonly BusinessProfileField[];
}

/** The assembled one-time profile, as a screen or a job sees it. */
export interface ProcessorProfileSnapshot {
  readonly companyId: string;
  readonly saved: boolean;
  readonly savedAtEpochMs: number | null;
  /** `0103`'s completion instant for the business fields. */
  readonly completedAtEpochMs: number | null;
  /** `0105`'s completion instant for the address and contact. */
  readonly addressCompletedAtEpochMs: number | null;
  readonly business: Readonly<Record<BusinessProfileField, string | null>>;
  readonly category: ProcessorCategory | null;
  readonly address: Readonly<Record<BusinessAddressField, string | null>>;
  readonly countryName: string | null;
  readonly coverage: readonly ProcessorCoverageView[];
  /** The union of every processor's required business fields that are still empty. */
  readonly businessMissing: readonly BusinessProfileField[];
  readonly addressMissing: readonly BusinessAddressField[];
  /** Everything still missing, named `business.<field>`, `category.mcc_code` or `address.<field>`. */
  readonly blocking: readonly string[];
  readonly ready: boolean;
}

/**
 * What one processor is sent when a sub-merchant is opened at it: its required business fields plus
 * the optional ones the merchant filled in, the category, and the whole address and contact block -
 * section 5's "business address, person name, contact information" - with the country's name beside
 * its code, because providers ask for the name, not the ISO code.
 */
export interface ProcessorPayload {
  readonly provider: ProviderKey;
  readonly displayName: string;
  readonly business: Readonly<Partial<Record<BusinessProfileField, string>>>;
  readonly category: ProcessorCategory | null;
  readonly address: Readonly<Record<BusinessAddressField, string | null>>;
  readonly countryName: string | null;
  readonly missing: readonly string[];
  readonly ready: boolean;
}

export interface ProcessorProfileDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The instant of a stored timestamp as epoch milliseconds, or null. A bad one is a defect. */
function epochMs(instant: string | null | undefined): number | null {
  if (instant === null || instant === undefined) {
    return null;
  }

  const parsed = Date.parse(instant);

  if (Number.isNaN(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function businessValuesOf(row: ProfileRow): Record<BusinessProfileField, string | null> {
  return {
    legal_name: row.legal_name ?? null,
    trading_name: row.trading_name ?? null,
    business_type: row.business_type ?? null,
    registration_number: row.registration_number ?? null,
    tax_id: row.tax_id ?? null,
    website: row.website ?? null,
    business_description: row.business_description ?? null,
  };
}

function addressValuesOf(row: ProfileRow): Record<BusinessAddressField, string | null> {
  return {
    address_line1: row.address_line1 ?? null,
    address_line2: row.address_line2 ?? null,
    city: row.city ?? null,
    state_province: row.state_province ?? null,
    postal_code: row.postal_code ?? null,
    country_code: row.country_code ?? null,
    contact_name: row.contact_name ?? null,
    contact_email: row.contact_email ?? null,
    contact_phone: row.contact_phone ?? null,
  };
}

/** One processor's view of the business values: what it requires and what is still empty. */
function coverageOf(
  provider: ProviderKey,
  business: Readonly<Record<BusinessProfileField, string | null>>,
): ProcessorCoverageView {
  const requirement = PROCESSOR_REQUIREMENTS[provider];

  return {
    provider: requirement.provider,
    displayName: requirement.displayName,
    required: requirement.required,
    optional: requirement.optional,
    missing: requirement.required.filter((field) => business[field] === null),
  };
}

/** Assemble the snapshot from the row and the two resolved reference names. Pure. */
function snapshotOf(
  companyId: string,
  row: ProfileRow | null,
  mccTitle: string | null,
  countryName: string | null,
): ProcessorProfileSnapshot {
  if (row === null) {
    const emptyBusiness = Object.fromEntries(
      BUSINESS_PROFILE_FIELDS.map((field) => [field, null]),
    ) as Record<BusinessProfileField, string | null>;
    const emptyAddress = Object.fromEntries(
      BUSINESS_ADDRESS_FIELDS.map((field) => [field, null]),
    ) as Record<BusinessAddressField, string | null>;
    const coverage = PROCESSOR_REQUIREMENT_LIST.map((requirement) => ({
      provider: requirement.provider,
      displayName: requirement.displayName,
      required: requirement.required,
      optional: requirement.optional,
      missing: [...requirement.required],
    }));
    const businessMissing = [...REQUIRED_BUSINESS_FIELDS];
    const addressMissing = [...REQUIRED_ADDRESS_FIELDS];

    return {
      companyId,
      saved: false,
      savedAtEpochMs: null,
      completedAtEpochMs: null,
      addressCompletedAtEpochMs: null,
      business: emptyBusiness,
      category: null,
      address: emptyAddress,
      countryName: null,
      coverage,
      businessMissing,
      addressMissing,
      blocking: [
        ...businessMissing.map((field) => `business.${field}`),
        "category.mcc_code",
        ...addressMissing.map((field) => `address.${field}`),
      ],
      ready: false,
    };
  }

  const business = businessValuesOf(row);
  const address = addressValuesOf(row);
  const coverage = PROCESSOR_REQUIREMENT_LIST.map((requirement) => coverageOf(requirement.provider, business));
  const businessMissing = REQUIRED_BUSINESS_FIELDS.filter((field) => business[field] === null);
  const addressMissing = REQUIRED_ADDRESS_FIELDS.filter((field) => address[field] === null);
  const category: ProcessorCategory | null =
    row.mcc_code === null ? null : { code: row.mcc_code, title: mccTitle };

  return {
    companyId,
    saved: true,
    savedAtEpochMs: epochMs(row.updated_at),
    completedAtEpochMs: epochMs(row.completed_at),
    addressCompletedAtEpochMs: epochMs(row.address_completed_at),
    business,
    category,
    address,
    countryName,
    coverage,
    businessMissing,
    addressMissing,
    blocking: [
      ...businessMissing.map((field) => `business.${field}`),
      ...(category === null ? ["category.mcc_code"] : []),
      ...addressMissing.map((field) => `address.${field}`),
    ],
    ready: businessMissing.length === 0 && addressMissing.length === 0 && category !== null,
  };
}

/** Read the one profile row of one company, bounded to a single live row. */
async function readProfileRow(companyId: string, rest: RestClient): Promise<ProfileRow | null> {
  const rows = await rest.select(
    BUSINESS_PROFILE_TABLE,
    `select=company_id,legal_name,trading_name,business_type,registration_number,tax_id,website,business_description,mcc_code,address_line1,address_line2,city,state_province,postal_code,country_code,contact_name,contact_email,contact_phone,address_completed_at,completed_at,updated_at&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
    profileRowSchema,
  );

  return rows[0] ?? null;
}

/** The published title of one code, from `0077`, or null when the code is not published. */
async function readMccTitle(code: string, rest: RestClient): Promise<string | null> {
  const rows = await rest.select(
    MCC_CODES_TABLE,
    `select=code,title&code=eq.${encodeURIComponent(code)}&deleted_at=is.null&limit=1`,
    mccTitleSchema,
  );

  return rows[0]?.title ?? null;
}

/** The name of one country, from `0076`, or null when no live row holds the code. */
async function readCountryName(code: string, rest: RestClient): Promise<string | null> {
  const rows = await rest.select(
    COUNTRIES_TABLE,
    `select=code,name&code=eq.${encodeURIComponent(code)}&deleted_at=is.null&limit=1`,
    countryNameSchema,
  );

  return rows[0]?.name ?? null;
}

/**
 * The one-time profile of one merchant, assembled from the single `business_profiles` row.
 *
 * The owner passes no `companyId` and gets their own company's; an office role must pass the
 * company they are reading, and a parameter that is not a UUID is a validation failure before any
 * query runs. An office read appends one audit entry; an owner read does not, because the merchant
 * is reading their own data, and an audit sink that is down never fails a read.
 */
export async function readProcessorProfile(
  input: { readonly actor: RequestActor; readonly companyId?: unknown },
  dependencies: ProcessorProfileDependencies,
): Promise<ProcessorProfileSnapshot> {
  const actor = input.actor;

  requireAnyRole(actor, PROCESSOR_PROFILE_READER_ROLES);

  let companyId: string;
  let officeRead = false;

  if (actor.roles.includes("owner")) {
    companyId = requireCompanyId(actor);

    if (input.companyId !== undefined && input.companyId !== companyId) {
      throw new AppError("PERMISSION_DENIED");
    }
  } else {
    officeRead = true;
    const parsed = z.string().uuid().safeParse(input.companyId);

    if (!parsed.success) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: "company_id", rule: "invalid_format" }],
      });
    }

    companyId = parsed.data;
  }

  const rest = dependencies.rest;
  const row = await readProfileRow(companyId, rest);
  const [mccTitle, countryName] = await Promise.all([
    row?.mcc_code !== null && row !== null
      ? readMccTitle(row.mcc_code, rest)
      : Promise.resolve(null),
    row?.country_code !== null && row !== null
      ? readCountryName(row.country_code, rest)
      : Promise.resolve(null),
  ]);

  const snapshot = snapshotOf(companyId, row, mccTitle, countryName);

  if (officeRead) {
    try {
      await dependencies.audit.append({
        action: PROCESSOR_PROFILE_AUDIT_ACTION,
        actorUserId: actor.userId,
        entityType: PROCESSOR_PROFILE_AUDIT_ENTITY,
        entityId: companyId,
        companyId,
        sessionId: actor.sessionId,
        payload: { company_id: companyId, processors: PLATFORM_PROVIDERS.length, ready: snapshot.ready },
      });
    } catch {
      // The audit sink failing must not fail a read; the save services hold the same rule.
    }
  }

  return snapshot;
}

/**
 * What one processor is sent for this merchant, computed from the snapshot and that provider's
 * requirement row. Pure: the same profile always produces the same payload, which is what makes the
 * provisioning job's retry safe.
 */
export function processorPayloadFor(
  snapshot: ProcessorProfileSnapshot,
  provider: ProviderKey,
): ProcessorPayload {
  const requirement = PROCESSOR_REQUIREMENTS[provider];
  const business: Partial<Record<BusinessProfileField, string>> = {};

  for (const field of [...requirement.required, ...requirement.optional]) {
    const value = snapshot.business[field];

    if (value !== null) {
      business[field] = value;
    }
  }

  const missing: string[] = [
    ...requirement.required
      .filter((field) => snapshot.business[field] === null)
      .map((field) => `business.${field}`),
    ...(snapshot.category === null ? ["category.mcc_code"] : []),
    ...REQUIRED_ADDRESS_FIELDS.filter((field) => snapshot.address[field] === null).map(
      (field) => `address.${field}`,
    ),
  ];

  return {
    provider: requirement.provider,
    displayName: requirement.displayName,
    business,
    category: snapshot.category,
    address: snapshot.address,
    countryName: snapshot.countryName,
    missing,
    ready: missing.length === 0,
  };
}

/**
 * Refuse to open a sub-merchant for a profile that is not complete: no row at all is
 * `RESOURCE_NOT_FOUND`, and a row with facts still missing is `VALIDATION_FAILED` naming every
 * missing fact, so the provisioning job's error says exactly what the merchant still has to fill
 * in rather than a generic failure.
 */
export function assertProvisionable(snapshot: ProcessorProfileSnapshot): void {
  if (!snapshot.saved) {
    throw new AppError("RESOURCE_NOT_FOUND");
  }

  if (snapshot.blocking.length > 0) {
    const details: readonly ErrorDetail[] = snapshot.blocking.map((field) => ({
      field,
      rule: "missing_required",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }
}
