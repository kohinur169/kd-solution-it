// path: services/clients/clients.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import { isConflictError, type RestClient } from "../../lib/auth/rest.ts";
import { requireAnyRole, requireCompanyId } from "../../lib/auth/session.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { PlatformRole } from "../../lib/auth/types.ts";
import { AppError, type ErrorDetail } from "../../lib/errors/app-error.ts";
import { sanitizeMultilineText, sanitizeSingleLineText, TEXT_LIMITS } from "../../lib/security/text.ts";
import {
  CLIENT_ADDRESS_REQUIRED_TRIGGERS,
  CLIENT_COUNTRY_PATTERN,
  CLIENT_EMAIL_PATTERN,
  CLIENT_FIELDS,
  CLIENT_PHONE_PATTERN,
  CLIENT_POSTAL_CODE_PATTERN,
  type ClientField,
} from "./client-fields.ts";

/**
 * Section 15's client create and edit: the write and the read of one row of `0019`'s `clients`
 * table, validated with Zod on the server exactly as section 11 demands ("Zod validation on client
 * and server for every form and API").
 *
 * ## What this module owns
 *
 * The `clients` table is `0019`; `client-fields.ts` is the field list the form shares. This file is
 * the service over the table: `createClient`, `updateClient`, `deleteClient` and `getClient`, each
 * taking an already authenticated actor and reading the company from it - never from the body - so
 * an edited request cannot write another merchant's row. The read of many rows, and the search over
 * them, is `client-list.ts`. Every read and write is scoped by
 * `company_id=eq.<id>` in the query itself, because the service role bypasses RLS and the scoping
 * has to be in the statement.
 *
 * ## The validation, and where its sentences come from
 *
 * Every value goes through the section 55 sanitiser first (single line for the names, numbers and
 * address, multiline for the notes), then through one Zod schema whose ceilings and patterns are the
 * `0019` checks. A refusal is `VALIDATION_FAILED` with one `{field, rule}` detail per broken field,
 * so the form marks them all at once instead of one per round trip. The address rule of `0019` -
 * a city without a street line is a shifted CSV column - is a cross-field refinement on the same
 * schema. An empty optional field is stored as null, which is how a cleared box becomes a cleared
 * column.
 *
 * ## The uniqueness answer
 *
 * One email per merchant while the row is live (`clients_email_key` on `lower(email)`): a second
 * client with the same address answers `CONFLICT` naming the email field, which is what lets the
 * merchant see the collision instead of silently editing the first row.
 */

/** The table of `0019`. */
export const CLIENTS_TABLE = "clients";

/** The audit action of a create. */
export const CLIENT_CREATED_AUDIT_ACTION = "client.created";

/** The audit action of an edit. */
export const CLIENT_UPDATED_AUDIT_ACTION = "client.updated";

/** The audit action of a removal. */
export const CLIENT_DELETED_AUDIT_ACTION = "client.deleted";

/** The audit entity of all three. */
export const CLIENT_AUDIT_ENTITY = "client";

/** Only the owner of a business manages its clients (section 25). */
export const CLIENT_MANAGE_ROLES: readonly PlatformRole[] = Object.freeze(["owner"] as const satisfies readonly PlatformRole[]);

/** The values of one client, by field; a field never given is null. */
export type ClientValues = Readonly<Record<ClientField, string | null>>;

/** One client as a screen sees it. */
export interface ClientSnapshot {
  readonly id: string;
  readonly companyId: string;
  readonly values: ClientValues;
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

export interface ClientDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/** The row shape of `0019`, validated on every read. */
export const clientRowSchema = z.object({
  id: z.string().uuid(),
  company_id: z.string().uuid(),
  name: z.string().min(1).max(120),
  company_name: z.string().max(160).nullable(),
  email: z.string().max(254).nullable(),
  phone: z.string().max(32).nullable(),
  address_line1: z.string().max(160).nullable(),
  address_line2: z.string().max(160).nullable(),
  city: z.string().max(80).nullable(),
  region: z.string().max(80).nullable(),
  postal_code: z.string().max(16).nullable(),
  country: z.string().max(2).nullable(),
  tax_id: z.string().max(32).nullable(),
  notes: z.string().max(2_000).nullable(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
  version: z.number().int().min(1),
});

type ClientRow = z.infer<typeof clientRowSchema>;

/** Empty text means "no value", and becomes null before any rule runs. */
const emptyToNull = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? null : value;

/** An optional single line field: absent, null or empty all become null; otherwise trimmed and bounded. */
const optionalLine = (max: number) =>
  z
    .preprocess(emptyToNull, z.string().trim().max(max).nullish())
    .transform((value) => (value === null || value === undefined ? null : value));

/** An optional pattern field, same normalisation. */
const optionalPattern = (pattern: RegExp, max: number) =>
  z
    .preprocess(emptyToNull, z.string().trim().max(max).regex(pattern).nullish())
    .transform((value) => (value === null || value === undefined ? null : value));

/** The shared field shape: the name is required, everything else is optional and clearable. */
const clientBaseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    company_name: optionalLine(160),
    email: optionalPattern(CLIENT_EMAIL_PATTERN, 254),
    phone: optionalPattern(CLIENT_PHONE_PATTERN, 32),
    address_line1: optionalLine(160),
    address_line2: optionalLine(160),
    city: optionalLine(80),
    region: optionalLine(80),
    postal_code: optionalPattern(CLIENT_POSTAL_CODE_PATTERN, 16),
    country: optionalPattern(CLIENT_COUNTRY_PATTERN, 2),
    tax_id: optionalLine(32),
    notes: z
      .preprocess(emptyToNull, z.string().trim().max(2_000).nullish())
      .transform((value) => (value === null || value === undefined ? null : value)),
  })
  .strict();

/** The address rule of `0019`, as a cross-field refinement: any other address field set needs line1. */
function requireAddressLine1<TValues extends Record<string, string | null>>(
  values: TValues,
  context: z.RefinementCtx,
): void {
  if (
    values["address_line1"] === null &&
    CLIENT_ADDRESS_REQUIRED_TRIGGERS.some((field) => values[field] !== null && values[field] !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      path: ["address_line1"],
      params: { rule: "address_requires_line1" },
    });
  }
}

/** The create body: the full row, address rule included. */
export const clientCreateSchema = clientBaseSchema.superRefine(requireAddressLine1);

/** The edit body: every field optional; a missing key leaves the column alone. The address rule runs on the merged values in `updateClient`. */
export const clientUpdateSchema = clientBaseSchema.partial();

/** Sanitise one raw value the way section 55 demands: single line, or multiline for the notes. */
function sanitizeValue(field: ClientField, raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (typeof raw !== "string") {
    return String(raw);
  }

  // the sanitiser strips control characters and collapses whitespace but never truncates to the
  // field ceiling: an over-ceiling value must reach the schema so it answers too_long, not a
  // silently shortened write. The 16 KiB body cap on the routes already bounds the input.
  return field === "notes" ? sanitizeMultilineText(raw, TEXT_LIMITS.multiLine) : sanitizeSingleLineText(raw, TEXT_LIMITS.multiLine);
}

/** Sanitise a raw body into the shape the schema validates, field by field. */
function sanitizeBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AppError("VALIDATION_FAILED", {
      details: [{ field: "client", rule: "invalid_format" }],
    });
  }

  const input = body as Record<string, unknown>;
  const cleaned: Record<string, unknown> = {};

  for (const field of CLIENT_FIELDS) {
    if (field in input) {
      cleaned[field] = sanitizeValue(field, input[field]);
    }
  }

  for (const key of Object.keys(input)) {
    if (!CLIENT_FIELDS.includes(key as ClientField)) {
      throw new AppError("VALIDATION_FAILED", {
        details: [{ field: key, rule: "unknown_field" }],
      });
    }
  }

  return cleaned;
}

/** Map one Zod issue to the `{field, rule}` detail the form renders. */
function detailOf(issue: z.ZodIssue): ErrorDetail {
  const field = issue.path.length > 0 ? String(issue.path[0]) : "client";

  if (issue.code === "too_small") {
    return { field, rule: issue.minimum === 1 ? "required" : "too_short" };
  }

  if (issue.code === "too_big") {
    return { field, rule: "too_long" };
  }

  if (issue.code === "custom") {
    const rule = (issue.params as { readonly rule?: unknown } | undefined)?.rule;

    return { field, rule: typeof rule === "string" ? rule : "invalid_format" };
  }

  return { field, rule: "invalid_format" };
}

function parseBody(body: unknown, schema: z.ZodType): Record<string, string | null> {
  const cleaned = sanitizeBody(body);
  const parsed = schema.safeParse(cleaned);

  if (!parsed.success) {
    // one detail per field, first issue wins: a bad country is reported once, not per rule
    const seen = new Set<string>();
    const details: ErrorDetail[] = [];

    for (const issue of parsed.error.issues) {
      const detail = detailOf(issue);

      if (!seen.has(detail.field)) {
        seen.add(detail.field);
        details.push(detail);
      }
    }

    throw new AppError("VALIDATION_FAILED", { details });
  }

  return parsed.data as Record<string, string | null>;
}

function epochMs(instant: string): number {
  const parsed = Date.parse(instant);

  if (!Number.isFinite(parsed)) {
    throw new AppError("INTERNAL_ERROR");
  }

  return parsed;
}

function snapshotOf(row: ClientRow): ClientSnapshot {
  return {
    id: row.id,
    companyId: row.company_id,
    values: {
      name: row.name,
      company_name: row.company_name,
      email: row.email,
      phone: row.phone,
      address_line1: row.address_line1,
      address_line2: row.address_line2,
      city: row.city,
      region: row.region,
      postal_code: row.postal_code,
      country: row.country,
      tax_id: row.tax_id,
      notes: row.notes,
    },
    createdAtEpochMs: epochMs(row.created_at),
    updatedAtEpochMs: epochMs(row.updated_at),
  };
}

function requireClientActor(actor: RequestActor): string {
  requireAnyRole(actor, CLIENT_MANAGE_ROLES);

  return requireCompanyId(actor);
}

async function appendTolerated(audit: AuditTrail, entry: Parameters<AuditTrail["append"]>[0]): Promise<void> {
  try {
    await audit.append(entry);
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/** Create one client of the actor's own company. A duplicate email answers `CONFLICT`. */
export async function createClient(
  input: { readonly actor: RequestActor; readonly body: unknown },
  dependencies: ClientDependencies,
): Promise<ClientSnapshot> {
  const companyId = requireClientActor(input.actor);
  const values = parseBody(input.body, clientCreateSchema);

  const newRow = {
    company_id: companyId,
    name: values["name"] ?? "",
    company_name: values["company_name"] ?? null,
    email: values["email"] ?? null,
    phone: values["phone"] ?? null,
    address_line1: values["address_line1"] ?? null,
    address_line2: values["address_line2"] ?? null,
    city: values["city"] ?? null,
    region: values["region"] ?? null,
    postal_code: values["postal_code"] ?? null,
    country: values["country"] ?? null,
    tax_id: values["tax_id"] ?? null,
    notes: values["notes"] ?? null,
  };

  let inserted: ClientRow;

  try {
    const [row] = await dependencies.rest.insertReturning(CLIENTS_TABLE, [newRow], clientRowSchema);

    if (row === undefined) {
      throw new AppError("INTERNAL_ERROR", { cause: { rule: "client", reason: "insert_returned_no_row" } });
    }

    inserted = row;
  } catch (error) {
    if (isConflictError(error)) {
      throw new AppError("CONFLICT", {
        details: [{ field: "email", rule: "already_used" }],
      });
    }

    throw error;
  }

  await appendTolerated(dependencies.audit, {
    action: CLIENT_CREATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: CLIENT_AUDIT_ENTITY,
    entityId: inserted.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { fields: CLIENT_FIELDS.filter((field) => values[field] !== null) },
  });

  return snapshotOf(inserted);
}

/** Read one live client of the actor's own company, or `RESOURCE_NOT_FOUND`. */
export async function getClient(
  input: { readonly actor: RequestActor; readonly clientId: string },
  dependencies: ClientDependencies,
): Promise<ClientSnapshot> {
  const companyId = requireClientActor(input.actor);

  if (!z.string().uuid().safeParse(input.clientId).success) {
    throw new AppError("VALIDATION_FAILED", { details: [{ field: "clientId", rule: "invalid_format" }] });
  }

  const rows = await dependencies.rest.select(
    CLIENTS_TABLE,
    `id=eq.${input.clientId}&company_id=eq.${companyId}&deleted_at=is.null`,
    clientRowSchema,
  );
  const row = rows[0];

  if (row === undefined) {
    throw new AppError("RESOURCE_NOT_FOUND", { cause: { rule: "client", reason: "not_found" } });
  }

  return snapshotOf(row);
}

/**
 * Edit one live client of the actor's own company. The body names the fields it changes and touches
 * nothing else; the address rule is re-checked on the merged values, because clearing line1 while
 * the stored row still has a city is refused exactly like setting a city with no line1. The update
 * is scoped to the row and the company, and the row is re-read afterwards - a PostgREST update that
 * matched nothing still reports success, so the re-read is what turns a missing row into a 404.
 */
export async function updateClient(
  input: { readonly actor: RequestActor; readonly clientId: string; readonly body: unknown },
  dependencies: ClientDependencies,
): Promise<ClientSnapshot> {
  const companyId = requireClientActor(input.actor);
  const current = await getClient({ actor: input.actor, clientId: input.clientId }, dependencies);
  const patch = parseBody(input.body, clientUpdateSchema);

  const merged: Record<string, string | null> = { ...current.values };

  for (const field of CLIENT_FIELDS) {
    if (patch[field] !== undefined) {
      merged[field] = patch[field];
    }
  }

  const mergedCheck = clientBaseSchema.superRefine(requireAddressLine1).safeParse(merged);

  if (!mergedCheck.success) {
    throw new AppError("VALIDATION_FAILED", { details: mergedCheck.error.issues.map(detailOf) });
  }

  const values: Record<string, unknown> = {};

  for (const field of CLIENT_FIELDS) {
    if (patch[field] !== undefined) {
      values[field] = patch[field];
    }
  }

  if (Object.keys(values).length > 0) {
    await dependencies.rest.update(
      CLIENTS_TABLE,
      `id=eq.${input.clientId}&company_id=eq.${companyId}&deleted_at=is.null`,
      values,
    );
  }

  const updated = await getClient({ actor: input.actor, clientId: input.clientId }, dependencies);

  await appendTolerated(dependencies.audit, {
    action: CLIENT_UPDATED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: CLIENT_AUDIT_ENTITY,
    entityId: updated.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { fields: Object.keys(values) },
  });

  return updated;
}

/**
 * Remove one live client of the actor's own company.
 *
 * ## Why this is a soft delete
 *
 * Section 15 asks for delete and `0019` already decided what it means: `deleted_at` marks the row and
 * nothing is ever removed. The reason is written into that migration and holds here - an invoice sent
 * last year names the client it was sent to, so the record has to stay explainable. The partial unique
 * index `clients_email_key` stops counting a deleted row, which is what lets a merchant remove a
 * mistyped entry and reuse the address, and every read of this module carries `deleted_at=is.null`,
 * so a deleted client leaves the list, the edit screen and the search at once.
 *
 * ## Why it reads before it writes, and re-reads after
 *
 * The read is the 404: it answers `RESOURCE_NOT_FOUND` for a foreign, deleted or unknown id, so a
 * second removal is refused rather than silently repeated, and another merchant's row is
 * indistinguishable from one that does not exist. The write itself is scoped to the row and the
 * company exactly as `updateClient` is, and the re-read is the proof that the row is now gone from
 * the live set - a PostgREST update that matched nothing still reports success.
 *
 * ## Why the audit entry names the row and not its values
 *
 * A removal is the most consequential thing a merchant does to this table, so it is audited with the
 * id, the name the row carried and the instant - enough to reconstruct what was removed without
 * copying a client's address, tax identifier or notes into the log.
 */
export async function deleteClient(
  input: { readonly actor: RequestActor; readonly clientId: string },
  dependencies: ClientDependencies,
): Promise<ClientSnapshot> {
  const companyId = requireClientActor(input.actor);
  const current = await getClient({ actor: input.actor, clientId: input.clientId }, dependencies);
  const instant = new Date(dependencies.now?.() ?? Date.now()).toISOString();

  await dependencies.rest.update(
    CLIENTS_TABLE,
    `id=eq.${current.id}&company_id=eq.${companyId}&deleted_at=is.null`,
    { deleted_at: instant },
  );

  // The row must now be outside the live set. A row that is still readable means the update matched
  // nothing, which is a race with another writer and not a successful removal.
  const stillLive = await dependencies.rest.select(
    CLIENTS_TABLE,
    `id=eq.${current.id}&company_id=eq.${companyId}&deleted_at=is.null`,
    clientRowSchema,
  );

  if (stillLive.length > 0) {
    throw new AppError("CONFLICT", { details: [{ field: "client", rule: "already_changed" }] });
  }

  await appendTolerated(dependencies.audit, {
    action: CLIENT_DELETED_AUDIT_ACTION,
    actorUserId: input.actor.userId,
    entityType: CLIENT_AUDIT_ENTITY,
    entityId: current.id,
    companyId,
    sessionId: input.actor.sessionId ?? null,
    payload: { name: current.values.name, deleted_at: instant },
  });

  return current;
}
