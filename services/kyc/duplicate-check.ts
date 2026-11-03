// path: services/kyc/duplicate-check.ts
import { z } from "zod";
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import type { RequestActor } from "../../lib/auth/types.ts";
import type { ErrorDetail } from "../../lib/errors/app-error.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { BUSINESS_PROFILE_TABLE } from "./business-profile.ts";

/**
 * Section 4's "One Person, One Account": the duplicate identity check that runs at signup, at KYC
 * submission and before sub-merchant creation, over the six signals section 4 names - email, phone,
 * identity document number hash, tax id, bank account fingerprint, and legal name with date of
 * birth.
 *
 * ## The shape
 *
 * `collectIdentitySignals` reads the applicant's own rows once per source table (users, the business
 * profile, the UBO records, the payout bank accounts) and turns them into signals. `checkDuplicateIdentity`
 * then asks each source table for live rows carrying the same value in ANY other company - one
 * bounded batch of independent selects, never a query per row of somebody else's data - and every
 * hit becomes one `duplicate_cases` row (`0110`): stage, signal, the matched company and user, status
 * `open` for compliance_kyc. A repeated check at the same stage converges on the existing open row
 * through the unique index instead of piling up cases. Every new case is audited
 * `duplicate_case.opened`.
 *
 * ## What a match means at each stage
 *
 *   - signup: the only signal present is the email (the address uniqueness of `0003` already answers
 *     it indistinguishably at the provider); `checkSignupIdentity` is the checker the signup flow
 *     calls - it records the case under the matched tenant, because a blocked applicant has no
 *     company of its own yet;
 *   - kyc_submission: `submitKyc` runs the check before the submission moves out of draft and
 *     conflicts `duplicate_identity` - the applicant is told an account already exists, never which
 *     signal matched;
 *   - provisioning: `runSubmerchantProvisioning` runs it before any provision row is written and
 *     answers `blocked: true` without creating one.
 *
 * The answer to the applicant never names the signal or the matched account: the case row holds that
 * for compliance, the applicant gets "an account already exists".
 */

/** The table of `0110`: one matched signal of one applicant at one stage. */
export const DUPLICATE_CASES_TABLE = "duplicate_cases";

/** The audit entity of a duplicate case row. */
export const DUPLICATE_CASE_ENTITY = "duplicate_case";

/** The audit action of a match being recorded for compliance review. */
export const DUPLICATE_CASE_OPENED_AUDIT_ACTION = "duplicate_case.opened";

/** The six signals of FEATURE_LIST section 4, in its own order. */
export const IDENTITY_SIGNALS = [
  "email",
  "phone",
  "identity_document_hash",
  "tax_id",
  "bank_account_fingerprint",
  "legal_name_with_dob",
] as const;

export type IdentitySignal = (typeof IDENTITY_SIGNALS)[number];

/** The three stages the check runs at. */
export const DUPLICATE_STAGES = ["signup", "kyc_submission", "provisioning"] as const;

export type DuplicateStage = (typeof DUPLICATE_STAGES)[number];

// The source tables of the signals. `users` and `payout_bank_accounts` have no exported constant of
// their own yet, so they are named here; the gate cross-checks them against the canonical names.
const USERS_TABLE = "users";
const UBO_RECORDS_TABLE = "ubo_records";
const PAYOUT_BANK_ACCOUNTS_TABLE = "payout_bank_accounts";

/** One signal the applicant carries, with the value to match and where it came from. */
export interface IdentitySignalValue {
  readonly signal: IdentitySignal;
  /** The email, phone, tax id, 64 hex hash, 64 hex fingerprint, or "<full name>|<date>". */
  readonly value: string;
}

/** One hit: a live row of another company carrying the same signal value. */
export interface DuplicateMatch {
  readonly signal: IdentitySignal;
  readonly matchedCompanyId: string | null;
  readonly matchedUserId: string | null;
}

export interface DuplicateCheckDependencies {
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

export interface DuplicateCheckResult {
  readonly blocked: boolean;
  readonly matches: readonly DuplicateMatch[];
}

const userRowSchema = z.object({
  id: z.string(),
  company_id: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  full_name: z.string(),
});

const profileSignalRowSchema = z.object({
  company_id: z.string(),
  contact_phone: z.string().nullable(),
  tax_id: z.string().nullable(),
  legal_name: z.string().nullable(),
});

const uboSignalRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  full_name: z.string(),
  date_of_birth: z.string(),
  id_document_sha256: z.string(),
});

const bankAccountSignalRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  account_fingerprint: z.string(),
});

const matchRowSchema = z.object({
  id: z.string(),
  company_id: z.string().nullable(),
});

const caseRowSchema = z.object({
  id: z.string(),
  company_id: z.string(),
  stage: z.string(),
  signal: z.string(),
  status: z.string(),
});

/**
 * The applicant's own signals, one bounded read per source table: the account users, the business
 * profile, the UBO records of the draft submission and the payout bank accounts.
 */
export async function collectIdentitySignals(
  companyId: string,
  rest: RestClient,
): Promise<readonly IdentitySignalValue[]> {
  const [users, profiles, ubos, accounts] = await Promise.all([
    rest.select(
      USERS_TABLE,
      `select=id,company_id,email,phone,full_name&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=10`,
      userRowSchema,
    ),
    rest.select(
      BUSINESS_PROFILE_TABLE,
      `select=company_id,contact_phone,tax_id,legal_name&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=1`,
      profileSignalRowSchema,
    ),
    rest.select(
      UBO_RECORDS_TABLE,
      `select=id,company_id,full_name,date_of_birth,id_document_sha256&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=100`,
      uboSignalRowSchema,
    ),
    rest.select(
      PAYOUT_BANK_ACCOUNTS_TABLE,
      `select=id,company_id,account_fingerprint&company_id=eq.${encodeURIComponent(companyId)}&deleted_at=is.null&limit=50`,
      bankAccountSignalRowSchema,
    ),
  ]);

  const signals: IdentitySignalValue[] = [];

  for (const user of users) {
    signals.push({ signal: "email", value: user.email });

    if (user.phone !== null && user.phone !== "") {
      signals.push({ signal: "phone", value: user.phone });
    }
  }

  const profile = profiles[0];

  if (profile !== undefined) {
    if (profile.contact_phone !== null && profile.contact_phone !== "") {
      signals.push({ signal: "phone", value: profile.contact_phone });
    }

    if (profile.tax_id !== null && profile.tax_id !== "") {
      signals.push({ signal: "tax_id", value: profile.tax_id });
    }
  }

  for (const ubo of ubos) {
    signals.push({ signal: "identity_document_hash", value: ubo.id_document_sha256 });
    signals.push({ signal: "legal_name_with_dob", value: `${ubo.full_name}|${ubo.date_of_birth}` });
  }

  for (const account of accounts) {
    signals.push({ signal: "bank_account_fingerprint", value: account.account_fingerprint });
  }

  return signals;
}

/** Ask one source table for live rows of other companies carrying `value` in `column`. */
async function findMatches(
  rest: RestClient,
  signal: IdentitySignal,
  table: string,
  column: string,
  value: string,
  extraColumn: string | null,
  extraValue: string | null,
  companyId: string,
): Promise<readonly DuplicateMatch[]> {
  const extra = extraColumn === null || extraValue === null ? "" : `&${extraColumn}=eq.${encodeURIComponent(extraValue)}`;
  const rows = await rest.select(
    table,
    `select=id,company_id&${column}=eq.${encodeURIComponent(value)}${extra}&deleted_at=is.null&limit=10`,
    matchRowSchema,
  );

  return rows
    .filter((row) => row.company_id !== null && row.company_id !== companyId)
    .map((row) => ({
      signal,
      matchedCompanyId: row.company_id,
      matchedUserId: table === USERS_TABLE ? row.id : null,
    }));
}

/** Insert one open case row for a matched signal, unless the same open case already exists. */
async function recordCase(
  companyId: string,
  stage: DuplicateStage,
  match: DuplicateMatch,
  actorUserId: string | null,
  sessionId: string | null,
  dependencies: DuplicateCheckDependencies,
): Promise<void> {
  const rest = dependencies.rest;
  const existing = await rest.select(
    DUPLICATE_CASES_TABLE,
    `select=id,company_id,stage,signal,status&company_id=eq.${encodeURIComponent(companyId)}&stage=eq.${encodeURIComponent(stage)}&signal=eq.${encodeURIComponent(match.signal)}&status=eq.open&deleted_at=is.null&limit=1`,
    caseRowSchema,
  );

  if (existing.length > 0) {
    return;
  }

  await rest.insert(DUPLICATE_CASES_TABLE, [
    {
      company_id: companyId,
      stage,
      signal: match.signal,
      matched_company_id: match.matchedCompanyId,
      matched_user_id: match.matchedUserId,
      status: "open",
    },
  ]);

  const after = await rest.select(
    DUPLICATE_CASES_TABLE,
    `select=id,company_id,stage,signal,status&company_id=eq.${encodeURIComponent(companyId)}&stage=eq.${encodeURIComponent(stage)}&signal=eq.${encodeURIComponent(match.signal)}&status=eq.open&deleted_at=is.null&limit=1`,
    caseRowSchema,
  );
  const row = after[0];

  try {
    await dependencies.audit.append({
      action: DUPLICATE_CASE_OPENED_AUDIT_ACTION,
      actorUserId,
      entityType: DUPLICATE_CASE_ENTITY,
      entityId: row?.id ?? null,
      companyId,
      sessionId,
      payload: {
        stage,
        signal: match.signal,
        matched_company_id: match.matchedCompanyId,
        matched_user_id: match.matchedUserId,
      },
    });
  } catch {
    // An audit sink that is down never fails the write it records.
  }
}

/**
 * Run the duplicate check for one applicant company at one stage. Every signal of the applicant is
 * matched against live rows of other companies in one bounded batch; every matched signal is recorded
 * as an open `0110` case (converging on an existing open case at the same stage) and audited. The
 * result says only whether the applicant is blocked - never which signal matched.
 */
export async function checkDuplicateIdentity(
  input: { readonly companyId: string; readonly stage: DuplicateStage; readonly actor?: RequestActor | null },
  dependencies: DuplicateCheckDependencies,
): Promise<DuplicateCheckResult> {
  const rest = dependencies.rest;
  const signals = await collectIdentitySignals(input.companyId, rest);

  const perSignal = await Promise.all(
    signals.map(async (entry): Promise<readonly DuplicateMatch[]> => {
      switch (entry.signal) {
        case "email":
          return findMatches(rest, "email", USERS_TABLE, "email", entry.value, null, null, input.companyId);
        case "phone":
          return [
            ...(await findMatches(rest, "phone", USERS_TABLE, "phone", entry.value, null, null, input.companyId)),
            ...(await findMatches(rest, "phone", BUSINESS_PROFILE_TABLE, "contact_phone", entry.value, null, null, input.companyId)),
          ];
        case "tax_id":
          return findMatches(rest, "tax_id", BUSINESS_PROFILE_TABLE, "tax_id", entry.value, null, null, input.companyId);
        case "identity_document_hash":
          return findMatches(rest, "identity_document_hash", UBO_RECORDS_TABLE, "id_document_sha256", entry.value, null, null, input.companyId);
        case "bank_account_fingerprint":
          return findMatches(rest, "bank_account_fingerprint", PAYOUT_BANK_ACCOUNTS_TABLE, "account_fingerprint", entry.value, null, null, input.companyId);
        case "legal_name_with_dob": {
          const separator = entry.value.indexOf("|");
          const name = separator === -1 ? entry.value : entry.value.slice(0, separator);
          const dob = separator === -1 ? "" : entry.value.slice(separator + 1);

          return findMatches(rest, "legal_name_with_dob", UBO_RECORDS_TABLE, "full_name", name, "date_of_birth", dob, input.companyId);
        }
      }
    }),
  );

  const matches: DuplicateMatch[] = [];
  const seen = new Set<string>();

  for (const entry of perSignal.flat()) {
    const key = `${entry.signal}:${entry.matchedCompanyId ?? ""}:${entry.matchedUserId ?? ""}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    matches.push({ signal: entry.signal, matchedCompanyId: entry.matchedCompanyId, matchedUserId: entry.matchedUserId });
  }

  const actorUserId = input.actor?.userId ?? null;
  const sessionId = input.actor?.sessionId ?? null;

  for (const match of matches) {
    // The case is filed under the applicant's company; at the signup stage the applicant has none
    // yet, so the matched tenant carries the case.
    const caseCompanyId = input.stage === "signup" && match.matchedCompanyId !== null ? match.matchedCompanyId : input.companyId;

    await recordCase(caseCompanyId, input.stage, match, actorUserId, sessionId, dependencies);
  }

  return { blocked: matches.length > 0, matches };
}

/**
 * The signup-stage check: the only section 4 signal present before an account exists is the email
 * (the address uniqueness of `0003` already answers it indistinguishably at the provider). A match
 * records the case under the matched tenant - the blocked applicant has no company of its own - and
 * answers blocked, so the signup flow can refuse without naming what matched.
 */
export async function checkSignupIdentity(
  input: { readonly email: unknown },
  dependencies: DuplicateCheckDependencies,
): Promise<DuplicateCheckResult> {
  const parsed = z
    .object({
      email: z
        .string()
        .trim()
        .toLowerCase()
        .min(5)
        .max(254)
        .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u),
    })
    .safeParse(input);

  if (!parsed.success) {
    const details: readonly ErrorDetail[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join("."),
      rule: "invalid_format",
    }));

    throw new AppError("VALIDATION_FAILED", { details });
  }

  const rest = dependencies.rest;
  const rows = await rest.select(
    USERS_TABLE,
    `select=id,company_id&email=eq.${encodeURIComponent(parsed.data.email)}&deleted_at=is.null&limit=1`,
    matchRowSchema,
  );
  const row = rows[0];

  if (row === undefined || row.company_id === null) {
    return { blocked: false, matches: [] };
  }

  const match: DuplicateMatch = { signal: "email", matchedCompanyId: row.company_id, matchedUserId: row.id };

  await recordCase(row.company_id, "signup", match, null, null, dependencies);

  return { blocked: true, matches: [match] };
}

/** The rule the applicant-facing answers use when a match blocks: generic, never the signal. */
export const DUPLICATE_IDENTITY_RULE = "duplicate_identity";
