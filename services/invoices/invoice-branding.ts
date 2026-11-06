// path: services/invoices/invoice-branding.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { formatMessage } from "../../lib/i18n/messages.ts";
import { sanitizeMultilineText, sanitizeSingleLineText } from "../../lib/security/text.ts";
import { sha256Hex } from "../../lib/security/upload.ts";
import {
  assertBrandingKeyForCompany,
  createBrandingDownloadUrl,
  uploadBrandingAsset,
} from "../../lib/storage/branding.ts";
import type { StorageFileEncryption } from "../../lib/storage/encryption.ts";
import {
  getFileRecord,
  listFileRecords,
  type FileRecord,
  type FileRecordDependencies,
} from "../../lib/storage/records.ts";
import { downloadEncryptedObject, type FileAccessContext } from "../../lib/storage/service.ts";
import { isStorageError, type StorageAdapter } from "../../lib/storage/types.ts";
import { INVOICE_PDF_ACCENT_PATTERN } from "./invoice-pdf.ts";
import { inspectInvoicePdfImage, type InvoicePdfImageRefusal } from "./invoice-pdf-image.ts";

/**
 * The merchant's invoice branding: section 16 line 184, "Merchants can set their own logo and invoice
 * branding", as a settings row, a logo, and the words a PDF prints.
 *
 * ## What this module owns, and what it only reads
 *
 * `0116` stores *choices*: which stored logo prints, which of the merchant's facts appear on a document that
 * leaves the building, the tagline, the note above the footer, the accent of the rule under the letterhead.
 * themselves - the name, the address, the tax id, the website - live on the `business_profiles` row of `0103`
 * as `0105` extended it, and this module reads them without copying them. A copy would be a second truth
 * that goes stale the day a merchant moves office, and an invoice printing an old address is a document a
 * client acts on. Reading at render time means a merchant who fixes their profile does not have to re-save
 * their branding for the next invoice to be right.
 *
 * The logo's bytes belong to STEP 105's storage category: `uploadBrandingAsset` validates the magic bytes
 * against the `company_logo` policy, seals them, records them and archives the merchant's previous verified
 * logos, so one merchant has one current logo. What this module adds is the two questions storage does not
 * ask - can these bytes be *printed*, and did the merchant choose them.
 *
 * ## Why "can it be printed" is asked at the moment of choosing
 *
 * A `company_logo` may be a WebP, which the web app can display and a PDF cannot draw: there is no way to put
 * a VP8 bitstream in an image XObject without a decoder nobody has. An interlaced PNG and a progressive JPEG
 * are refused for the same family of reasons. So the question is asked when the choice is made, with the
 * bytes in hand, and a merchant who uploads a WebP is told at once that their invoice logo did not change -
 * rather than discovering it a week later on a document already sent to a client. The renderer asks it again,
 * because a file can be replaced or quarantined between the two moments and a document must never be drawn
 * from bytes nobody checked.
 *
 * ## A merchant who has never opened this screen
 *
 * Still gets their name and address on their invoice. A missing row means the defaults, which is the answer
 * `invoice-numbering.ts` gives for a merchant who has never set a prefix: `0116`'s defaults say show the
 * address and show the contact, and a professional invoice names its seller whether or not the seller has
 * ever visited a settings page. What a missing row cannot supply is a logo, because a logo is a choice about
 * a file.
 *
 * ## Who may change it
 *
 * An `owner`. Branding is the merchant's own configuration - section 2's owner "manages own business ... and
 * branding" - and no office role has a reason to decide what a merchant's invoices look like. Every read is
 * scoped to the company from the session, every write is scoped to the row *and* the company, and the row
 * carries a version, so two people saving at once produce one `CONFLICT` rather than one silently
 * overwritten tagline.
 */

/** The table `0116` created. */
export const INVOICE_BRANDING_TABLE = "invoice_branding";

/** The audit action a save is recorded under. */
export const INVOICE_BRANDING_UPDATED_AUDIT_ACTION = "invoice.branding_updated";

/** The audit entity a save is recorded against. */
export const INVOICE_BRANDING_AUDIT_ENTITY = "invoice_branding";

/** Section 20's tenancy: the merchant owns their brand, and only an `owner` may change it. */
const BRANDING_ROLES = Object.freeze(["owner"] as const);

/** The storage purpose STEP 105 defined for a logo. */
export const COMPANY_LOGO_PURPOSE = "company_logo";

/** The two answers to "which name prints", each with its own fallback order. */
export const INVOICE_BRANDING_NAME_STYLES = ["trading", "legal"] as const;

export type InvoiceBrandingNameStyle = (typeof INVOICE_BRANDING_NAME_STYLES)[number];

/** The ceilings `0116`'s column checks enforce, so a refusal here is a refusal there too. */
export const INVOICE_BRANDING_LIMITS = Object.freeze({ tagline: 120, footerNote: 300 });

/**
 * The colour a merchant's accent starts at when they switch it on and have not picked one.
 *
 * This is data and not a design token: it is a value that goes into a `char(7)` column and onto a document,
 * chosen by a merchant rather than by the platform's palette, which is why it lives here and not in
 * `styles/tokens.css`. It is exported because the form is handed it as a prop - a colour literal under
 * `app/` is what STEP 003's shell gate refuses, and correctly: nothing in a screen should decide a colour.
 */
export const INVOICE_BRANDING_DEFAULT_ACCENT = "#1f4e79";

/** The defaults a merchant who has never opened the screen gets, which are `0116`'s column defaults. */
export const INVOICE_BRANDING_DEFAULTS = Object.freeze({
  logoFileId: null,
  showLogo: true,
  nameStyle: "trading" as InvoiceBrandingNameStyle,
  showAddress: true,
  showContact: true,
  showTaxId: false,
  showWebsite: false,
  tagline: null,
  footerNote: null,
  accentColour: null,
});

/** The merchant's settings, as the screen edits them and the renderer reads them. */
export interface InvoiceBrandingSettings {
  readonly logoFileId: string | null;
  readonly showLogo: boolean;
  readonly nameStyle: InvoiceBrandingNameStyle;
  readonly showAddress: boolean;
  readonly showContact: boolean;
  readonly showTaxId: boolean;
  readonly showWebsite: boolean;
  readonly tagline: string | null;
  readonly footerNote: string | null;
  readonly accentColour: string | null;
  /** Zero when no row exists yet, which is what a first save posts back. */
  readonly version: number;
  readonly updatedAtEpochMs: number;
}

/** The merchant's facts, read from `0103`/`0105` and `0001` and never copied into `0116`. */
export interface InvoiceBrandingIdentity {
  /** `companies.name`, which always exists and is the last resort for a merchant with no profile. */
  readonly companyName: string | null;
  readonly tradingName: string | null;
  readonly legalName: string | null;
  readonly taxId: string | null;
  readonly website: string | null;
  /** The address as printed lines, assembled from the profile's own columns. */
  readonly addressLines: readonly string[];
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * One logo this merchant has in storage, as the screen describes it.
 *
 * There is no file name: `0057` does not store the name a browser sent, because a name from a browser is not
 * a fact about an object. What identifies a logo to its merchant is the picture, the format, the size and
 * the day it was uploaded.
 */
export interface InvoiceBrandingLogo {
  readonly fileId: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** False when the format cannot be drawn on a PDF at all, which is why such an upload is not adopted. */
  readonly printable: boolean;
  readonly status: FileRecord["status"];
  readonly uploadedAtEpochMs: number;
}

/** Everything the branding screen needs, in one read. */
export interface InvoiceBrandingSnapshot {
  readonly settings: InvoiceBrandingSettings;
  readonly identity: InvoiceBrandingIdentity;
  /** The words the PDF prints with these settings and these facts: the screen's own preview. */
  readonly preview: InvoiceBrandingWords;
  /** The logo the settings name, or null when none is chosen. */
  readonly adoptedLogo: InvoiceBrandingLogo | null;
  /** The newest verified logo in storage, which is what an upload just produced. */
  readonly newestLogo: InvoiceBrandingLogo | null;
  /**
   * A short-lived URL of the newest verified logo, so the screen can show the picture rather than describe
   * it. Null when there is no logo or storage would not sign one: a preview the storage cannot serve is not
   * a reason the settings themselves cannot be edited.
   */
  readonly newestLogoUrl: string | null;
}

/** What an upload answered, which is more than the snapshot the screen reloads. */
export interface InvoiceLogoUploadResult {
  readonly snapshot: InvoiceBrandingSnapshot;
  /** True when the uploaded file became the invoice logo. */
  readonly adopted: boolean;
  /** Why it did not, when it did not: a format a PDF cannot draw, or bytes the platform quarantined. */
  readonly refusal: InvoicePdfImageRefusal | "quarantined" | null;
}

/**
 * The words and the colour a PDF prints, with the merchant's choices already applied to their facts.
 *
 * One function, called by the screen's read and by the render, so a preview and a document cannot disagree:
 * what the merchant sees on the screen is what the renderer is handed.
 */
export interface InvoiceBrandingWords {
  readonly name: string | null;
  readonly tagline: string | null;
  readonly address: string | null;
  readonly contact: string | null;
  readonly footerNote: string | null;
  readonly accentHex: string | null;
}

/** What the render path hands the renderer: the words, plus the logo's own bytes. */
export interface InvoicePrintBranding {
  readonly words: InvoiceBrandingWords;
  readonly logo: { readonly bytes: Uint8Array; readonly contentType: string } | null;
}

export interface InvoiceBrandingDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface InvoiceBrandingStorageDependencies extends InvoiceBrandingDependencies {
  readonly adapter: StorageAdapter;
  readonly encryption: StorageFileEncryption;
}

/** The row shape of `0116`, validated on every read. */
export const invoiceBrandingRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  logo_file_id: z.string().uuid().nullable(),
  show_logo: z.boolean(),
  name_style: z.enum(INVOICE_BRANDING_NAME_STYLES),
  show_address: z.boolean(),
  show_contact: z.boolean(),
  show_tax_id: z.boolean(),
  show_website: z.boolean(),
  tagline: z.string().nullable(),
  footer_note: z.string().nullable(),
  accent_colour: z.string().nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  version: z.number().int().positive(),
});

/** The body a save posts. Zod on the server, as rule 10 requires, before any value is measured. */
export const invoiceBrandingInputSchema = z.object({
  logo_file_id: z.string().uuid().nullable(),
  show_logo: z.boolean(),
  name_style: z.enum(INVOICE_BRANDING_NAME_STYLES),
  show_address: z.boolean(),
  show_contact: z.boolean(),
  show_tax_id: z.boolean(),
  show_website: z.boolean(),
  tagline: z.string().nullable(),
  footer_note: z.string().nullable(),
  accent_colour: z.string().nullable(),
  version: z.number().int().min(0),
});

const BRANDING_COLUMNS =
  "select=id,company_id,logo_file_id,show_logo,name_style,show_address,show_contact,show_tax_id," +
  "show_website,tagline,footer_note,accent_colour,created_at,updated_at,version";

/** The profile columns an invoice prints. Selected, not `select=*`: rule 17, and a profile holds more. */
const PROFILE_COLUMNS =
  "select=legal_name,trading_name,tax_id,website,address_line1,address_line2,city,state_province," +
  "postal_code,country_code,contact_email,contact_phone";

const profileRowSchema = z.object({
  legal_name: z.string().nullable(),
  trading_name: z.string().nullable(),
  tax_id: z.string().nullable(),
  website: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  state_province: z.string().nullable(),
  postal_code: z.string().nullable(),
  country_code: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
});

const companyRowSchema = z.object({ name: z.string().min(1) });

function requireBrandingActor(actor: RequestActor): string {
  requireAnyRole(actor, BRANDING_ROLES);

  return requireCompanyId(actor);
}

function recordDepsOf(dependencies: InvoiceBrandingDependencies): FileRecordDependencies {
  return {
    rest: dependencies.rest,
    audit: dependencies.audit,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  };
}

function storageDepsOf(
  dependencies: InvoiceBrandingStorageDependencies,
): InvoiceBrandingStorageDependencies {
  return dependencies;
}

function accessOf(companyId: string, actorUserId: string | null, fileId: string): FileAccessContext {
  return { actorUserId, companyId, fileId, purpose: COMPANY_LOGO_PURPOSE };
}

/** An audit sink that is down never fails the write it records. */
function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    return audit.append(entry);
  } catch {
    return Promise.resolve();
  }
}

/**
 * A storage failure becomes the platform's own word for it.
 *
 * `unavailable` and `provider_error` are a dependency, not a defect and not the merchant's fault, so they
 * answer `DEPENDENCY_FAILED` - which a job records as its code and the panel shows as a failure to retry. A
 * missing object is a `404` in the same vocabulary the file records use. Anything else is rethrown unchanged,
 * because guessing at an error this module does not recognise would turn a bug into a plausible sentence.
 */
function classifyLogoStorageFailure(error: unknown): never {
  if (isStorageError(error) && (error.code === "unavailable" || error.code === "provider_error")) {
    throw new AppError("DEPENDENCY_FAILED", {
      cause: { rule: "invoice_branding", reason: `storage_${error.code}` },
    });
  }

  if (isStorageError(error) && error.code === "not_found") {
    throw new AppError("RESOURCE_NOT_FOUND", {
      cause: { rule: "invoice_branding", reason: "logo_not_found" },
    });
  }

  throw error;
}

function settingsOf(row: z.infer<typeof invoiceBrandingRowSchema> | null): InvoiceBrandingSettings {
  if (row === null) {
    return { ...INVOICE_BRANDING_DEFAULTS, version: 0, updatedAtEpochMs: 0 };
  }

  return {
    logoFileId: row.logo_file_id,
    showLogo: row.show_logo,
    nameStyle: row.name_style,
    showAddress: row.show_address,
    showContact: row.show_contact,
    showTaxId: row.show_tax_id,
    showWebsite: row.show_website,
    tagline: row.tagline,
    footerNote: row.footer_note,
    accentColour: row.accent_colour,
    version: row.version,
    updatedAtEpochMs: Date.parse(row.updated_at),
  };
}

async function readBrandingRow(
  rest: RestClient,
  companyId: string,
): Promise<z.infer<typeof invoiceBrandingRowSchema> | null> {
  const rows = await rest.select(
    INVOICE_BRANDING_TABLE,
    `${BRANDING_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null&limit=1`,
    invoiceBrandingRowSchema,
  );

  return rows[0] ?? null;
}

/**
 * The merchant's facts, as one read of the profile and one of the company.
 *
 * Two queries rather than one because the two tables have no join path this REST client can express - the
 * codebase embeds no resources anywhere - and both are single rows read by a scoped key.
 *
 * The address is assembled here, once, so the screen's preview and the renderer's block are built from the
 * same lines: the street, then the second line if there is one, then `city, state postal`, then the country.
 * The country prints as the ISO 3166 code the profile stores, deliberately: resolving a name is a third read
 * on every render, and two letters beside a postal code are not ambiguous on a document that also carries an
 * amount in dollars.
 */
export async function readInvoiceBrandingIdentity(
  rest: RestClient,
  companyId: string,
): Promise<InvoiceBrandingIdentity> {
  const profiles = await rest.select(
    "business_profiles",
    `${PROFILE_COLUMNS}&company_id=eq.${companyId}&deleted_at=is.null&limit=1`,
    profileRowSchema,
  );
  const companies = await rest.select(
    "companies",
    `select=name&id=eq.${companyId}&deleted_at=is.null&limit=1`,
    companyRowSchema,
  );
  const profile = profiles[0];
  const companyName = companies[0]?.name ?? null;

  if (profile === undefined) {
    return {
      companyName,
      tradingName: null,
      legalName: null,
      taxId: null,
      website: null,
      addressLines: [],
      email: null,
      phone: null,
    };
  }

  const addressLines = [profile.address_line1, profile.address_line2].filter(
    (line): line is string => line !== null && line.length > 0,
  );
  const cityLine = [profile.city, profile.state_province]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(", ");
  const postal = profile.postal_code ?? "";
  const cityPostal = `${cityLine}${cityLine.length > 0 && postal.length > 0 ? " " : ""}${postal}`.trim();

  if (cityPostal.length > 0) {
    addressLines.push(cityPostal);
  }

  if (profile.country_code !== null && profile.country_code.length > 0) {
    addressLines.push(profile.country_code.toUpperCase());
  }

  return {
    companyName,
    tradingName: profile.trading_name,
    legalName: profile.legal_name,
    taxId: profile.tax_id,
    website: profile.website,
    addressLines,
    email: profile.contact_email,
    phone: profile.contact_phone,
  };
}

/**
 * Apply the merchant's choices to the merchant's facts.
 *
 * The name falls back rather than failing: `trading` prefers the trading name and takes the legal one when
 * there is no trading name, `legal` does the reverse, and a merchant who stored neither still gets the
 * company name they were created with. An invoice with no seller on it is the one outcome this function must
 * never produce, and it cannot.
 *
 * The tax id is the only line carrying a label, and the label is catalog copy read through `formatMessage`:
 * rule 1 keeps English in the catalog, and the renderer prints lines it is given rather than sentences it
 * composes.
 */
export function invoiceBrandingWordsOf(
  identity: InvoiceBrandingIdentity,
  settings: InvoiceBrandingSettings,
): InvoiceBrandingWords {
  const name =
    settings.nameStyle === "legal"
      ? (identity.legalName ?? identity.tradingName ?? identity.companyName)
      : (identity.tradingName ?? identity.legalName ?? identity.companyName);

  const contact: string[] = [];

  if (settings.showContact) {
    if (identity.email !== null && identity.email.length > 0) {
      contact.push(identity.email);
    }

    if (identity.phone !== null && identity.phone.length > 0) {
      contact.push(identity.phone);
    }
  }

  if (settings.showWebsite && identity.website !== null && identity.website.length > 0) {
    contact.push(identity.website);
  }

  if (settings.showTaxId && identity.taxId !== null && identity.taxId.length > 0) {
    contact.push(formatMessage("invoices.brandingTaxIdLine", { taxId: identity.taxId }));
  }

  return {
    name: name === null || name.length === 0 ? null : name,
    tagline: settings.tagline,
    address:
      settings.showAddress && identity.addressLines.length > 0 ? identity.addressLines.join("\n") : null,
    contact: contact.length === 0 ? null : contact.join("\n"),
    footerNote: settings.footerNote,
    accentHex: settings.accentColour,
  };
}

function logoOf(record: FileRecord): InvoiceBrandingLogo {
  return {
    fileId: record.id,
    contentType: record.content_type,
    byteSize: record.byte_size,
    // The cheap half of the printable question, asked of the content type alone: a WebP cannot be drawn and
    // needs no bytes to prove it. The expensive half - interlacing, a progressive scan, a bit depth - is
    // asked of the bytes when a logo is adopted, and again when it is rendered.
    printable: record.content_type === "image/png" || record.content_type === "image/jpeg",
    status: record.status,
    uploadedAtEpochMs: Date.parse(record.created_at),
  };
}

/**
 * The branding screen's one read.
 *
 * The settings, the facts, the words those two produce, and the merchant's logos: the newest verified one in
 * storage, and the one the settings actually name. They are usually the same file, and they are worth
 * holding apart when they are not - a merchant who uploaded a WebP, or whose logo was archived by a later
 * upload, is a merchant the screen has to be able to tell the truth to.
 */
export async function readInvoiceBranding(
  input: { readonly actor: RequestActor },
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<InvoiceBrandingSnapshot> {
  const companyId = requireBrandingActor(input.actor);

  return snapshotOf(companyId, dependencies);
}

async function snapshotOf(
  companyId: string,
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<InvoiceBrandingSnapshot> {
  const row = await readBrandingRow(dependencies.rest, companyId);
  const settings = settingsOf(row);
  const identity = await readInvoiceBrandingIdentity(dependencies.rest, companyId);
  // `listFileRecords` answers newest first, so the first verified row is the merchant's current logo.
  const records = await listFileRecords(recordDepsOf(dependencies), {
    companyId,
    purpose: COMPANY_LOGO_PURPOSE,
  });
  const logos = records.map(logoOf);
  const newestLogo = logos.find((logo) => logo.status === "ready") ?? null;
  const adoptedId = settings.logoFileId;
  const adoptedLogo =
    adoptedId === null ? null : (logos.find((logo) => logo.fileId === adoptedId) ?? null);

  return {
    settings,
    identity,
    preview: invoiceBrandingWordsOf(identity, settings),
    adoptedLogo,
    newestLogo,
    newestLogoUrl: await logoPreviewUrl(companyId, newestLogo, dependencies),
  };
}

/**
 * A signed URL for the preview image, or null.
 *
 * A preview is the one part of this screen that storage can fail without the screen failing: the settings,
 * the facts and the words are all read from the database, and a merchant whose object store is having a bad
 * minute can still edit every one of them. So a signing failure answers null and the form shows the description
 * of the logo instead of its picture. The URL is short-lived by design - STEP 100's default of five minutes -
 * and the response carrying it is `no-store`.
 */
async function logoPreviewUrl(
  companyId: string,
  logo: InvoiceBrandingLogo | null,
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<string | null> {
  if (logo === null) {
    return null;
  }

  try {
    const signed = await createBrandingDownloadUrl(storageDepsOf(dependencies), {
      companyId,
      fileId: logo.fileId,
    });

    return signed.url;
  } catch {
    return null;
  }
}

/** A validated save body: the settings the row will carry, and the version the caller read them from. */
export interface ParsedInvoiceBranding {
  readonly settings: Omit<InvoiceBrandingSettings, "version" | "updatedAtEpochMs">;
  readonly expectedVersion: number;
}

/**
 * Validate a branding body.
 *
 * Zod decides the shape, then every text value goes through the section 55 sanitiser before it is measured
 * against `0116`'s own ceilings - so a refusal names a field the form can mark, and a column check never has
 * to. Problems are collected rather than thrown at the first, because a merchant fixing a tagline and a
 * colour should be told about both in one round trip.
 *
 * An empty string is a deliberate clear and answers null rather than a `required` error: turning a tagline
 * off is done by emptying the box, and a screen that refuses an empty box cannot be used to remove anything.
 */
export function parseInvoiceBrandingInput(body: unknown): ParsedInvoiceBranding {
  const parsed = invoiceBrandingInputSchema.safeParse(body ?? {});

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.length === 0 ? "branding" : String(issue.path[0]),
        rule: "invalid_format",
      })),
    });
  }

  const problems: ErrorDetail[] = [];
  const value = parsed.data;
  const tagline = textOrNull(value.tagline, false);

  if (tagline !== null && tagline.length > INVOICE_BRANDING_LIMITS.tagline) {
    problems.push({ field: "tagline", rule: "too_long" });
  }

  const footerNote = textOrNull(value.footer_note, true);

  if (footerNote !== null && footerNote.length > INVOICE_BRANDING_LIMITS.footerNote) {
    problems.push({ field: "footer_note", rule: "too_long" });
  }

  const accent = accentOrNull(value.accent_colour);

  if (accent === null && value.accent_colour !== null && value.accent_colour.trim().length > 0) {
    problems.push({ field: "accent_colour", rule: "invalid_format" });
  }

  if (problems.length > 0) {
    throw new AppError("VALIDATION_FAILED", { details: problems });
  }

  return {
    settings: {
      logoFileId: value.logo_file_id,
      showLogo: value.show_logo,
      nameStyle: value.name_style,
      showAddress: value.show_address,
      showContact: value.show_contact,
      showTaxId: value.show_tax_id,
      showWebsite: value.show_website,
      tagline,
      footerNote,
      accentColour: accent,
    },
    expectedVersion: value.version,
  };
}

/** Sanitise, then treat an empty result as the clear it is. */
function textOrNull(input: string | null, multiline: boolean): string | null {
  if (input === null) {
    return null;
  }

  const cleaned = multiline ? sanitizeMultilineText(input) : sanitizeSingleLineText(input);

  return cleaned.length === 0 ? null : cleaned;
}

/**
 * The accent colour, lowercased and checked against the renderer's own pattern.
 *
 * Lowercasing is a tolerance and not a rewrite: a colour picker hands a merchant `#1F4E79`, the merchant
 * means the colour, and `0116`'s check stores it lowercase. Anything that is not six hexadecimal digits after
 * the sanitiser answers null, which the caller turns into a field error rather than a quiet default.
 */
function accentOrNull(input: string | null): string | null {
  if (input === null) {
    return null;
  }

  const cleaned = sanitizeSingleLineText(input).toLowerCase();

  if (cleaned.length === 0) {
    return null;
  }

  return INVOICE_PDF_ACCENT_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * Save the merchant's brand.
 *
 * An insert when the merchant has never saved and a version-scoped update when they have, because the row is
 * created on the first save rather than at sign-up. Rule 13's optimistic locking is the version in the
 * filter, and a caller who posts a version the row has outgrown is answered `CONFLICT` before anything is
 * written: two owners of one account find out, instead of one of them losing a tagline.
 *
 * A chosen logo is proven printable before the row is written - when it is newly chosen, or when it is being
 * switched on after being off, which are the two moments a merchant commits to printing it. Re-proving it on
 * every unrelated save would download and decode a two megabyte image because somebody edited a tagline.
 */
export async function updateInvoiceBranding(
  input: { readonly actor: RequestActor; readonly values: ParsedInvoiceBranding },
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<InvoiceBrandingSnapshot> {
  const companyId = requireBrandingActor(input.actor);
  const row = await readBrandingRow(dependencies.rest, companyId);
  const current = settingsOf(row);
  const { settings, expectedVersion } = input.values;

  if (expectedVersion !== current.version) {
    throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
  }

  const commitsToLogo = settings.logoFileId !== null && settings.showLogo;
  const newlyChosen = commitsToLogo && settings.logoFileId !== current.logoFileId;
  const switchedOn = commitsToLogo && !current.showLogo;

  if (newlyChosen || switchedOn) {
    await assertLogoPrintable(
      companyId,
      // The null check above is what makes this a string.
      settings.logoFileId as string,
      input.actor.userId,
      dependencies,
    );
  }

  const values: Readonly<Record<string, unknown>> = {
    logo_file_id: settings.logoFileId,
    show_logo: settings.showLogo,
    name_style: settings.nameStyle,
    show_address: settings.showAddress,
    show_contact: settings.showContact,
    show_tax_id: settings.showTaxId,
    show_website: settings.showWebsite,
    tagline: settings.tagline,
    footer_note: settings.footerNote,
    accent_colour: settings.accentColour,
  };

  await writeRow(
    companyId,
    row,
    { actorUserId: input.actor.userId, sessionId: input.actor.sessionId ?? null },
    dependencies,
    values,
    {
      logo_file_id: settings.logoFileId,
      show_logo: settings.showLogo,
      name_style: settings.nameStyle,
      show_address: settings.showAddress,
      show_contact: settings.showContact,
      show_tax_id: settings.showTaxId,
      show_website: settings.showWebsite,
      // A tagline and a note are the merchant's own words, so the audit records that they exist and not what
      // they say: an audit trail is read by more people than the settings screen is.
      has_tagline: settings.tagline !== null,
      has_footer_note: settings.footerNote !== null,
      accent_colour: settings.accentColour,
    },
  );

  if (row !== null) {
    const after = await readBrandingRow(dependencies.rest, companyId);

    // A version that moved is not proof this write landed: whoever won the race moved it too. What proves it
    // is the row now holding the values this call sent, which is the same check `invoice-pdf-document.ts`
    // makes for the same reason. A REST update that matched nothing still reports success, so the row read
    // back is the only place a lost race is visible at all.
    if (after === null || !writeLanded(after, values)) {
      throw new AppError("CONFLICT", { details: [{ field: "version", rule: "stale" }] });
    }
  }

  return snapshotOf(companyId, dependencies);
}

/**
 * Store one logo and, when it can be printed, make it the invoice logo.
 *
 * The storage half is STEP 105's `uploadBrandingAsset`: magic bytes against the `company_logo` policy, a
 * sealed upload, the `0057` record, and the archiving of this merchant's previous verified logos. What is
 * added here is the invoice's own question - can these bytes be drawn? A WebP is stored, because the web app
 * can use it, and is *not* adopted, so the merchant's invoice logo stays a file that prints and the answer
 * says why. A quarantined upload is not adopted either: bytes whose declared type did not match their own
 * signature are exactly the bytes that must never reach a client's document.
 */
export async function uploadInvoiceLogo(
  input: {
    readonly actor: RequestActor;
    readonly fileName: string;
    readonly declaredType: string;
    readonly bytes: Uint8Array;
  },
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<InvoiceLogoUploadResult> {
  const companyId = requireBrandingActor(input.actor);

  const uploaded = await uploadBrandingAsset(storageDepsOf(dependencies), {
    companyId,
    uploadedBy: input.actor.userId,
    fileName: input.fileName,
    declaredType: input.declaredType,
    bytes: input.bytes,
  });

  if (uploaded.verdict.decision !== "verified") {
    return {
      snapshot: await snapshotOf(companyId, dependencies),
      adopted: false,
      refusal: "quarantined",
    };
  }

  // The plaintext bytes are the ones the merchant sent: what storage holds is the sealed envelope, and the
  // question "can this be drawn" is a question about the picture.
  const verdict = inspectInvoicePdfImage(input.bytes, uploaded.verdict.contentType);

  if (!verdict.ok) {
    return {
      snapshot: await snapshotOf(companyId, dependencies),
      adopted: false,
      refusal: verdict.reason,
    };
  }

  const row = await readBrandingRow(dependencies.rest, companyId);
  const current = settingsOf(row);

  await writeRow(
    companyId,
    row,
    { actorUserId: input.actor.userId, sessionId: input.actor.sessionId ?? null },
    dependencies,
    {
      logo_file_id: uploaded.record.id,
      show_logo: true,
      name_style: current.nameStyle,
      show_address: current.showAddress,
      show_contact: current.showContact,
      show_tax_id: current.showTaxId,
      show_website: current.showWebsite,
      tagline: current.tagline,
      footer_note: current.footerNote,
      accent_colour: current.accentColour,
    },
    { logo_file_id: uploaded.record.id, show_logo: true, adopted_on_upload: true },
  );

  return {
    snapshot: await snapshotOf(companyId, dependencies),
    adopted: true,
    refusal: null,
  };
}

/**
 * Did the write land?
 *
 * Compared column by column as the wire carries them, where a null and an absent value are the same fact:
 * the row read back has to hold what this call sent. A version is not the test, because every writer bumps
 * it - including the one this call lost to.
 */
function writeLanded(
  row: z.infer<typeof invoiceBrandingRowSchema>,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const wire = row as unknown as Readonly<Record<string, unknown>>;

  return Object.entries(values).every(
    ([column, value]) => String(wire[column] ?? "") === String(value ?? ""),
  );
}

/** The one write path: an insert when there is no row, a version-scoped update when there is, then the audit. */
async function writeRow(
  companyId: string,
  row: z.infer<typeof invoiceBrandingRowSchema> | null,
  actor: { readonly actorUserId: string | null; readonly sessionId: string | null },
  dependencies: InvoiceBrandingDependencies,
  values: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (row === null) {
    await dependencies.rest.insert(INVOICE_BRANDING_TABLE, [{ company_id: companyId, ...values }]);
  } else {
    // Scoped to the company as well as the id and the version: a REST update that matched nothing still
    // reports success, so the scope is what makes a write to another merchant's row impossible.
    await dependencies.rest.update(
      INVOICE_BRANDING_TABLE,
      `id=eq.${row.id}&company_id=eq.${companyId}&deleted_at=is.null&version=eq.${row.version}`,
      values,
    );
  }

  await appendTolerated(dependencies.audit, {
    action: INVOICE_BRANDING_UPDATED_AUDIT_ACTION,
    actorUserId: actor.actorUserId,
    entityType: INVOICE_BRANDING_AUDIT_ENTITY,
    entityId: row?.id ?? null,
    companyId,
    sessionId: actor.sessionId,
    payload,
  });
}

/**
 * Prove a chosen logo can be drawn, with the bytes in hand.
 *
 * The record is read scoped to this company, its purpose has to be the logo purpose, its key has to be this
 * merchant's own logo key, and its status has to be one the platform verified: a `pending` or `quarantined`
 * file is refused here so it can never be adopted, which is the same reason the render refuses it later. Then
 * the bytes are downloaded, their length and hash compared against the record, and handed to the reader that
 * will have to draw them.
 */
async function assertLogoPrintable(
  companyId: string,
  fileId: string,
  actorUserId: string | null,
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<void> {
  const { record, bytes } = await readLogoBytes(companyId, fileId, actorUserId, dependencies);
  const verdict = inspectInvoicePdfImage(bytes, record.content_type);

  if (!verdict.ok) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "logo", rule: "file_not_acceptable" }],
      cause: { rule: "invoice_branding", reason: verdict.reason },
    });
  }
}

/** The record and the plaintext bytes of one logo, with every check the read path owes. */
async function readLogoBytes(
  companyId: string,
  fileId: string,
  actorUserId: string | null,
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<{ readonly record: FileRecord; readonly bytes: Uint8Array }> {
  let record: FileRecord;

  try {
    record = await getFileRecord(recordDepsOf(dependencies), { companyId, fileId });
  } catch (error) {
    classifyLogoStorageFailure(error);
  }

  if (record.purpose !== COMPANY_LOGO_PURPOSE) {
    throw new AppError("PERMISSION_DENIED", {
      cause: { rule: "invoice_branding", reason: "not_a_logo" },
    });
  }

  if (record.status === "pending" || record.status === "quarantined") {
    // Bytes the platform has not verified, or verified and doubted, never reach a client's document.
    throw new AppError("CONFLICT", {
      details: [{ field: "logo", rule: "file_not_acceptable" }],
      cause: { rule: "invoice_branding", reason: `logo_${record.status}` },
    });
  }

  try {
    assertBrandingKeyForCompany(record.storage_key, companyId);
  } catch {
    throw new AppError("PERMISSION_DENIED", {
      cause: { rule: "invoice_branding", reason: "logo_key_mismatch" },
    });
  }

  let bytes: Uint8Array;

  try {
    bytes = await downloadEncryptedObject(
      dependencies.adapter,
      { bucket: record.storage_bucket, key: record.storage_key },
      accessOf(companyId, actorUserId, record.id),
      dependencies,
    );
  } catch (error) {
    classifyLogoStorageFailure(error);
  }

  if (bytes.length !== record.byte_size || sha256Hex(bytes) !== record.content_sha256) {
    // The seal opened, so these are this tenant's bytes, but they are not the bytes the record describes.
    throw new AppError("INTERNAL_ERROR", {
      cause: { rule: "invoice_branding", reason: "content_mismatch" },
    });
  }

  return { record, bytes };
}

/**
 * The branding one render prints.
 *
 * Called by the job handler with a company and no actor, because a job has no session: the payload carries
 * the company the invoice belongs to and the render reads that company's own rows. The logo is downloaded and
 * its hash checked here, and its bytes are handed to the renderer un-decoded - deciding what a PDF can hold is
 * the renderer's job, and deciding it twice would produce two answers.
 *
 * A logo the merchant chose and the render cannot read is a failure, not a document without its logo: the job
 * records the code, the panel shows it, and the merchant either replaces the file or turns the logo off.
 * Silently dropping a chosen element would be the worse lie.
 */
export async function readInvoicePrintBranding(
  input: { readonly companyId: string },
  dependencies: InvoiceBrandingStorageDependencies,
): Promise<InvoicePrintBranding> {
  const row = await readBrandingRow(dependencies.rest, input.companyId);
  const settings = settingsOf(row);
  const identity = await readInvoiceBrandingIdentity(dependencies.rest, input.companyId);
  const words = invoiceBrandingWordsOf(identity, settings);

  if (!settings.showLogo || settings.logoFileId === null) {
    return { words, logo: null };
  }

  const { record, bytes } = await readLogoBytes(input.companyId, settings.logoFileId, null, dependencies);

  return { words, logo: { bytes, contentType: record.content_type } };
}
