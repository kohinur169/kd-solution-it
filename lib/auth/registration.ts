// path: lib/auth/registration.ts
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AdminAuthClient } from "./admin-client.ts";
import type { AuditTrail } from "./audit.ts";
import type { AuthClient } from "./client.ts";
import type { BreachCheck, BreachVerdict } from "./breach-check.ts";
import { assertPasswordAcceptable, hashPassword, passwordRuleFailure } from "./password.ts";
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
 * ## What a duplicate address looks like, and what it must not look like
 *
 * Nothing. Section 22 line 243 asks that no answer says whether an account exists, and a duplicate
 * signup is the one place where the obvious answer - a conflict, "already registered" - is both a
 * leak and, in the order this file used to run, a catastrophe: the provider answers an existing
 * address with the *existing* person and an empty identity list, which reads exactly like a new
 * account with a pending confirmation. A registration that believed it would insert a company,
 * collide with `users_email_key`, and then compensate by soft closing and provider-deleting the
 * account of the merchant who was already registered.
 *
 * So a duplicate is recognised three times over, cheapest first, and every one of them answers the
 * same acceptance body a brand new address gets:
 *
 *   1. the provider says the address is in use (`user_already_exists`) - nothing was created;
 *   2. the provider hands back a person with no identity and no session (`existingAddress`) -
 *      nothing was created;
 *   3. the provider created a person, but `users_email_key` already holds that address - the
 *      person is the platform's existing account under another identifier, and `compensate()`
 *      will not touch a provider user whose identifier this platform never recorded.
 *
 * `RegistrationResult` is a union rather than a boolean for the same reason: a caller cannot read
 * a `companyId` off an answer that created nothing, because there is none to read.
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

/**
 * The two answers a signup can have.
 *
 * `created` is the account that now exists. `indistinguishable` is every path that must not say
 * what it found - an address already registered, a provider that refused it, a race that lost the
 * unique index - and it carries no identifier at all, so a route cannot accidentally log or return
 * one and undo the point of the union.
 */
export type RegistrationResult =
  | {
      readonly status: "created";
      readonly userId: string;
      readonly companyId: string;
      /** True when the provider sent a verification mail and no session exists yet. */
      readonly verificationRequired: boolean;
    }
  | { readonly status: "indistinguishable" };

/** The one answer a duplicate, a refusal and a lost race share. */
function indistinguishable(): RegistrationResult {
  return { status: "indistinguishable" };
}

export interface RegistrationDependencies {
  readonly auth: AuthClient;
  readonly admin: AdminAuthClient;
  readonly rest: RestClient;
  readonly policies: PolicyCatalog;
  readonly turnstile: TurnstileGuard;
  readonly breachCheck: BreachCheck;
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

  assertPasswordAcceptable(request.password, {
    email: request.email,
    companyName: request.companyName,
    fullName: request.fullName,
  });

  const challenge = await dependencies.turnstile.check({
    token: request.turnstileToken,
    remoteIp: input.remoteIp,
  });

  if (!challenge.ok) {
    throw turnstileError(challenge.failure);
  }

  // The corpus is asked after the challenge, so a bot cannot spend the platform's quota on it, and
  // before the provider, so a breached password never becomes an account.
  const breach = await dependencies.breachCheck.check(request.password);

  if (!breach.ok) {
    throw providerError(breach.failure);
  }

  if (breach.value === "breached") {
    throw passwordRuleFailure("breached");
  }

  const breachVerdict: BreachVerdict = breach.value;

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
    // "This address is taken" is not a failure the merchant may see: it is an acceptance that
    // happens to create nothing. Every other refusal - a weak password the local policy missed, an
    // upstream outage - keeps its own answer, because hiding those would hide real breakage.
    if (isAddressInUse(provider.failure)) {
      return indistinguishable();
    }

    throw providerError(provider.failure);
  }

  if (provider.value.identity === "existing") {
    return indistinguishable();
  }

  const userId = provider.value.userId;
  const verificationRequired = provider.value.session === null;
  // Deleting a provider account is only safe when the provider said it created one for us. An
  // answer that lists no identity at all cannot be told apart from the obfuscated duplicate, and
  // the identifier in it may belong to a merchant who registered months ago.
  const providerUserIsOurs = provider.value.identity === "new";

  // The provider created a person. Whether the platform already holds that address decides the
  // rest, and the question is asked before a company exists so the answer costs one index lookup
  // instead of a company that would have to be undone.
  if (await emailIsRegistered(dependencies.rest, request.email)) {
    return indistinguishable();
  }

  let companyId: string | null = null;
  let userRowWritten = false;

  try {
    companyId = await insertCompany(dependencies.rest, request.companyName);

    try {
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
      userRowWritten = true;
    } catch (error) {
      // Anything but a conflict is an outage: the outer handler compensates and reports it.
      if (!isConflictError(error)) {
        throw error;
      }

      // `users_email_key` (or the primary key) refused the row: the address the provider just
      // created is one this platform already holds under another identifier. Nothing of ours was
      // written, and the provider user cannot be proven ours, so the compensation touches only the
      // company, and the answer says nothing about what happened.
      await compensate(dependencies, {
        userId,
        companyId,
        instantIso,
        userRowWritten: false,
        providerUserIsOurs,
      });

      return indistinguishable();
    }

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
        breach_check: breachVerdict,
        email_verification: verificationRequired ? "pending" : "not_required",
      },
      ipAddress: input.remoteIp,
      userAgent: input.userAgent,
    });
  } catch (error) {
    await compensate(dependencies, {
      userId,
      companyId,
      instantIso,
      userRowWritten,
      providerUserIsOurs,
    });

    throw error instanceof AppError ? error : new AppError("INTERNAL_ERROR");
  }

  return { status: "created", userId, companyId, verificationRequired };
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

const emailRowSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * Whether the platform already holds this address, soft deleted rows included.
 *
 * `users_email_key` is a full unique index, not a partial one, so a closed account keeps its
 * address reserved. Asking the question the index asks keeps the answer consistent with the
 * database instead of being a second opinion that disagrees with it in the one case that matters.
 */
async function emailIsRegistered(rest: RestClient, email: string): Promise<boolean> {
  const rows = await rest.select(
    "users",
    `select=id&email=eq.${encodeURIComponent(email)}&limit=1`,
    emailRowSchema,
  );

  return rows.length > 0;
}

/**
 * The upstream codes that mean "this address already has an identity".
 *
 * The provider is asked to confirm the address by mail, so it answers a duplicate with an
 * obfuscated person rather than an error; a project with confirmations switched off gets the error.
 * Both paths end in the same acceptance, and the list is the documented vocabulary rather than a
 * guess at the sentence, which the client never keeps anyway.
 */
const ADDRESS_IN_USE_CODES: readonly string[] = ["user_already_exists", "email_exists"];

function isAddressInUse(failure: AuthFailure): boolean {
  return (
    failure.kind === "rejected" &&
    failure.code !== null &&
    ADDRESS_IN_USE_CODES.includes(failure.code.toLowerCase())
  );
}

/**
 * Undo a signup that failed after the provider answered.
 *
 * The rows of this platform are soft deleted, newest first. Every step is attempted even if an
 * earlier one fails, and nothing here throws: the caller is already reporting the failure that
 * caused this.
 *
 * ## The guard
 *
 * Two flags decide what may be undone, and both are facts this file established rather than
 * assumptions about a database it cannot see:
 *
 *   - `userRowWritten` - the platform claimed the person. Until that row exists the identifier is
 *     not the platform's, so another party's row is never soft closed. When the insert was refused
 *     by `users_email_key`, the identifier belongs to a merchant who registered earlier.
 *   - `providerUserIsOurs` - the provider said it created an identity for this request. When the
 *     answer lists no identity at all, it cannot be told apart from the obfuscated duplicate that
 *     carries the existing merchant's identifier, and deleting that account to tidy up a duplicate
 *     is the one mistake this file must not make. The cost of being wrong here is an unused,
 *     unconfirmed provider identity; the cost of the alternative is a customer's account.
 */
async function compensate(
  dependencies: RegistrationDependencies,
  state: {
    readonly userId: string;
    readonly companyId: string | null;
    readonly instantIso: string;
    readonly userRowWritten: boolean;
    readonly providerUserIsOurs: boolean;
  },
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

    if (state.userRowWritten) {
      await attempt(() =>
        dependencies.rest.update("users", `id=eq.${state.userId}`, {
          deleted_at: state.instantIso,
          status: "closed",
        }),
      );
    }

    await attempt(() =>
      dependencies.rest.update("companies", `id=eq.${companyId}`, {
        deleted_at: state.instantIso,
      }),
    );
  }

  if (state.providerUserIsOurs) {
    await attempt(() => dependencies.admin.deleteUser(state.userId));
  }
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
