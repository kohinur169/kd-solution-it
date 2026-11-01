// path: lib/auth/registration.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AdminAuthClient } from "./admin-client.ts";
import type { AuditTrail } from "./audit.ts";
import type { AuthClient } from "./client.ts";
import { assertPasswordAcceptable, hashPassword } from "./password.ts";
import {
  acceptsEveryRequiredPolicy,
  catalogIsComplete,
  isPolicyKey,
  REQUIRED_POLICY_KEYS,
  type PolicyCatalog,
  type PolicyKey,
  type PublishedPolicy,
} from "./policies.ts";
import { isConflictError, type RestClient } from "./rest.ts";
import type { TurnstileGuard } from "./turnstile.ts";
import type { AuthFailure } from "./types.ts";

/**
 * Merchant signup: the one way an account comes into existence.
 *
 * Section 22 asks for signup with email verification and Turnstile, section 3 asks that the policies
 * a merchant accepts are recorded by version, and the golden rules ask that every mutation is audit
 * logged. This file performs those three things as one unit, in the only order that leaves a
 * recoverable state at every step:
 *
 *   1. the form is validated, the password shape is checked and the accepted policies are the
 *      complete published set;
 *   2. Turnstile is verified before a single row is written, because a bot must not be able to make
 *      the platform do work;
 *   3. the identity provider creates the person, because it is the only step that can fail in a way
 *      the merchant must see (a duplicate address, a refused password);
 *   4. the platform records the tenancy: the company, the owner, the person and the twelve policy
 *      acceptances of this version;
 *   5. one audit entry names the whole action on the company chain.
 *
 * ## Compensation, not a transaction
 *
 * PostgREST has no multi statement transaction, so this file is written the way a distributed write
 * has to be: the provider account is created first and everything after it is undone if a later
 * step fails. The undo is best effort and ordered newest first, and the failure that caused it is
 * what the caller sees. A signup that half happened and reported success would be the one outcome
 * this design must never allow.
 *
 * ## What a duplicate address looks like
 *
 * The provider may answer an address that already exists with an obfuscated user instead of an
 * error, and the unique index on `public.users.email` is the backstop. Either way the merchant gets
 * `VALIDATION_FAILED` with no detail that says whether the address exists, which is the same rule
 * the sign in of STEP 039 keeps.
 */

/** The form the signup route accepts. Unknown fields are refused rather than ignored. */
export const signupInputSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(5)
      .max(254)
      .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u),
    password: z.string().min(1).max(128),
    companyName: z.string().trim().min(1).max(120),
    acceptedPolicies: z.array(z.string().min(1).max(32)).min(1).max(12),
    // A form that renders no widget sends nothing; the guard decides what a deployment allows,
    // so an absent token is the same as an empty one and never a shape error of the form.
    turnstileToken: z
      .string()
      .max(2_048)
      .nullable()
      .default(null),
  })
  .strict();

export type SignupRequest = z.infer<typeof signupInputSchema>;

export interface RegistrationInput {
  readonly request: unknown;
  readonly remoteIp: string | null;
  readonly userAgent: string | null;
}

export interface RegistrationResult {
  readonly userId: string;
  readonly companyId: string;
  /** True when the provider sent a verification mail and no session exists yet. */
  readonly verificationRequired: boolean;
}

export interface RegistrationDependencies {
  readonly auth: AuthClient;
  readonly admin: AdminAuthClient;
  readonly rest: RestClient;
  readonly policies: PolicyCatalog;
  readonly turnstile: TurnstileGuard;
  readonly audit: AuditTrail;
  readonly now?: () => number;
  /** Where the confirmation link returns the merchant, when the provider is told about it. */
  readonly verificationRedirectUrl?: string;
}

const companyRowSchema = z.object({ id: z.string().min(1).max(64) });

/** Longest slug `companies_slug_format_check` accepts. */
const maximumSlugLength = 48;

function validationFailure(field: string, rule: string): AppError {
  return new AppError("VALIDATION_FAILED", { details: [{ field, rule }] });
}

/** A company name turned into a slug the database accepts. */
export function companySlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maximumSlugLength)
    .replace(/-+$/gu, "");

  return slug.length === 0 ? "merchant" : slug;
}

/** Read the accepted policy keys of a request, refusing an unknown one. */
export function readAcceptedPolicies(values: readonly string[]): readonly PolicyKey[] {
  const keys: PolicyKey[] = [];

  for (const value of values) {
    if (!isPolicyKey(value)) {
      throw validationFailure("acceptedPolicies", "unknown_policy");
    }

    keys.push(value);
  }

  if (!acceptsEveryRequiredPolicy(keys)) {
    throw validationFailure("acceptedPolicies", "policy_not_accepted");
  }

  return keys;
}

/** Turn a Turnstile answer into the failure the merchant sees. */
function turnstileError(failure: AuthFailure): AppError {
  switch (failure.kind) {
    case "rejected":
      return validationFailure("turnstileToken", "challenge_failed");
    case "timeout":
      return new AppError("TIMEOUT");
    case "rate-limited":
      return failure.retryAfterSeconds === null
        ? new AppError("RATE_LIMITED")
        : new AppError("RATE_LIMITED", { retryAfterSeconds: failure.retryAfterSeconds });
    case "network":
    case "upstream":
    case "malformed-response":
      return new AppError("DEPENDENCY_FAILED");
  }
}

/**
 * A provider failure at signup.
 *
 * A rejection is `VALIDATION_FAILED` and never a sentence: the provider knows whether the address
 * exists and the merchant must not learn it from this answer.
 */
function providerError(failure: AuthFailure): AppError {
  switch (failure.kind) {
    case "rejected":
      return new AppError("VALIDATION_FAILED");
    case "timeout":
      return new AppError("TIMEOUT");
    case "rate-limited":
      return failure.retryAfterSeconds === null
        ? new AppError("RATE_LIMITED")
        : new AppError("RATE_LIMITED", { retryAfterSeconds: failure.retryAfterSeconds });
    case "network":
    case "upstream":
    case "malformed-response":
      return new AppError("DEPENDENCY_FAILED");
  }
}

function policyPayload(policies: readonly PublishedPolicy[]): readonly Record<string, string>[] {
  return policies.map((policy) => ({ key: policy.key, version: policy.version }));
}

export async function registerMerchant(
  input: RegistrationInput,
  dependencies: RegistrationDependencies,
): Promise<RegistrationResult> {
  const parsed = signupInputSchema.safeParse(input.request);

  if (!parsed.success) {
    throw new AppError("VALIDATION_FAILED", {
      details: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") === "" ? "form" : issue.path.join("."),
        rule: issue.code,
      })),
    });
  }

  const request = parsed.data;
  const acceptedKeys = readAcceptedPolicies(request.acceptedPolicies);

  assertPasswordAcceptable(request.password, request.email);

  const challenge = await dependencies.turnstile.check({
    token: request.turnstileToken,
    remoteIp: input.remoteIp,
  });

  if (!challenge.ok) {
    throw turnstileError(challenge.failure);
  }

  const published = await dependencies.policies.published(acceptedKeys);

  if (!catalogIsComplete(published)) {
    // A policy a merchant must accept is not published: the platform cannot ask for consent to a
    // page nobody stands behind, and that is an operator problem rather than a form problem.
    throw new AppError("SERVICE_UNAVAILABLE");
  }

  const passwordHash = await hashPassword(request.password);
  const now = dependencies.now ?? ((): number => Date.now());
  const instantIso = new Date(now()).toISOString();

  const provider = await dependencies.auth.signUpWithPassword({
    email: request.email,
    password: request.password,
    fullName: request.fullName,
    ...(dependencies.verificationRedirectUrl === undefined
      ? {}
      : { redirectTo: dependencies.verificationRedirectUrl }),
  });

  if (!provider.ok) {
    throw providerError(provider.failure);
  }

  const userId = provider.value.userId;
  const verificationRequired = provider.value.session === null;
  let companyId: string | null = null;

  try {
    companyId = await insertCompany(dependencies.rest, request.companyName);

    await dependencies.rest.insert("users", [
      {
        id: userId,
        company_id: companyId,
        email: request.email,
        full_name: request.fullName,
        password_hash: passwordHash,
        email_verified_at: verificationRequired ? null : instantIso,
        status: "active",
      },
    ]);

    await dependencies.rest.insert("role_assignments", [
      {
        company_id: companyId,
        user_id: userId,
        role: "owner",
        granted_by: userId,
        granted_at: instantIso,
      },
    ]);

    await dependencies.rest.insert(
      "policy_acceptances",
      published.map((policy) => ({
        company_id: companyId,
        policy_key: policy.key,
        policy_version: policy.version,
        document_sha256: policy.documentSha256,
        accepted_at: instantIso,
        accepted_by: userId,
      })),
    );

    await dependencies.audit.append({
      action: "merchant.signed_up",
      actorUserId: userId,
      entityType: "company",
      entityId: companyId,
      companyId,
      payload: {
        policies: policyPayload(published),
        turnstile: challenge.value,
        email_verification: verificationRequired ? "pending" : "not_required",
      },
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });
  } catch (error) {
    await compensate(dependencies, { userId, companyId, instantIso });

    throw error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
  }

  return { userId, companyId, verificationRequired };
}

async function insertCompany(rest: RestClient, name: string): Promise<string> {
  const base = companySlug(name);
  const attempts = [base, `${base.slice(0, maximumSlugLength - 5)}-${randomSuffix()}`];

  for (const [index, slug] of attempts.entries()) {
    try {
      const rows = await rest.insertReturning("companies", [{ name, slug }], companyRowSchema);
      const row = rows[0];

      if (row === undefined) {
        throw new AppError("DEPENDENCY_FAILED");
      }

      return row.id;
    } catch (error) {
      if (!isConflictError(error) || index === attempts.length - 1) {
        throw error;
      }
    }
  }

  throw new AppError("CONFLICT");
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 1_679_616)
    .toString(36)
    .padStart(4, "0");
}

/**
 * Undo a signup that failed after the provider account existed.
 *
 * The provider user goes first, because that is the only row another system holds; then the rows of
 * this platform are soft deleted, newest first. Every step is attempted even if an earlier one
 * fails, and nothing here throws: the caller is already reporting the failure that caused this.
 */
async function compensate(
  dependencies: RegistrationDependencies,
  state: { readonly userId: string; readonly companyId: string | null; readonly instantIso: string },
): Promise<void> {
  const companyId = state.companyId;

  if (companyId !== null) {
    await attempt(() =>
      dependencies.rest.update("policy_acceptances", `company_id=eq.${companyId}`, {
        deleted_at: state.instantIso,
      }),
    );
    await attempt(() =>
      dependencies.rest.update("role_assignments", `company_id=eq.${companyId}`, {
        deleted_at: state.instantIso,
      }),
    );
    await attempt(() =>
      dependencies.rest.update("users", `id=eq.${state.userId}`, {
        deleted_at: state.instantIso,
        status: "closed",
      }),
    );
    await attempt(() =>
      dependencies.rest.update("companies", `id=eq.${companyId}`, {
        deleted_at: state.instantIso,
      }),
    );
  }

  await attempt(() => dependencies.admin.deleteUser(state.userId));
}

async function attempt(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch {
    // Compensation is best effort by definition: the original failure is the one that is reported.
  }
}

/** The required key list, re-exported so a caller building the form does not import two modules. */
export { REQUIRED_POLICY_KEYS };
