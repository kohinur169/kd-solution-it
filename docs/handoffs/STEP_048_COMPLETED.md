// path: docs/handoffs/STEP_048_COMPLETED.md
# STEP 048 Completed - Handoff

Feature: **generic authentication error messages that reveal nothing about accounts**
(`docs/final/STEP_PLAN_250.md` line 640), from `docs/final/FEATURE_LIST.md` section 22 line 243
("Error messages never reveal whether an account exists") and lines 237-243 (a locked account is
told only after its password is proven).
Commit: `STEP 048: Generic authentication error messages that reveal nothing about accounts`.

## What was delivered

1. **`lib/auth/disclosure.ts`** - the contract every anonymous answer is checked against:
   `ANONYMOUS_AUTH_SURFACES` (the four stranger-facing routes, each with the codes it may answer
   and why the list ends there), `SESSION_AUTH_SURFACES` (the four second-factor routes, listed so
   "not classified" cannot be confused with "forgotten"), `FORBIDDEN_ON_ANONYMOUS_SURFACES`
   (`CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PERMISSION_DENIED`, `RESOURCE_NOT_FOUND`,
   `UNSUPPORTED_MEDIA_TYPE` - each describes a record), `anonymousRejection()` (a fresh
   `AUTHENTICATION_REQUIRED` per call), `isDisclosingDetail()` (the deny-list of detail rules that
   name an account), and the two constant acceptance bodies `SIGNUP_ACCEPTANCE` and
   `TWO_FACTOR_RESET_ACCEPTANCE`.
2. **Signup answers one body for every address.** `POST /api/auth/signup` now answers
   `201 {"status":"verification_required"}` for a new address, for an address that already exists,
   for a provider refusal and for a lost race. The `signed_up` variant is gone: a project that
   confirms addresses automatically would otherwise answer a new address differently from a
   registered one.
3. **The duplicate-address defect is fixed, and it was a destructive one.** `signUpWithPassword`
   dropped the provider's `identities` field, so the obfuscated duplicate - the *existing* person
   with an empty identity list and no session - read exactly like a new account awaiting a mail.
   Registration then created a company, collided with `users_email_key`, compensated, and in doing
   so **soft closed and provider-deleted the account of the merchant who was already registered**,
   answering `409 CONFLICT` on top. The platform could destroy a customer by receiving a second
   signup for their address.
4. **Three backstops, cheapest first, all ending in the same answer.** (a) the provider says the
   address is in use (`user_already_exists` / `email_exists`) - nothing was created; (b) the
   provider hands back a person with no identity (`identity === "existing"`) - nothing was created;
   (c) the platform's own `users_email_key` already holds the address - the company this attempt
   created is undone and nothing else is touched. `RegistrationResult` is now a union, so a route
   cannot read a `companyId` off an answer that created nothing.
5. **The compensation learned two guards.** `userRowWritten` - a `users` row is soft closed only if
   this request inserted it. `providerUserIsOurs` - a provider account is deleted only when the
   provider said it created one for this request (`identity === "new"`). An answer that lists no
   identity at all (`identity === "unknown"`) is indistinguishable from the obfuscated duplicate and
   is never deleted. Cost of being wrong: an unused, unconfirmed provider identity. Cost of the old
   behaviour: a customer's account.
6. **`SignUpResult.identity`** is `"new" | "existing" | "unknown"`, computed in `lib/auth/client.ts`
   from the provider answer (session present, empty identity list, missing identity list).
7. **`checkDisclosure()`** in the auth gate, 158 new checks in three layers:
   - *the contract*: every route under `app/api/auth` is read from disk and must be classified; no
     path twice; every catalogued code exists in `ERROR_CODES`; no forbidden code on an anonymous
     surface; the detail deny-list accepts form rules and refuses account rules;
   - *the answers*: the rendered envelope (`buildErrorEnvelope` at a fixed request id) is compared
     character for character - unknown address, wrong password, unconfirmed mail and a locked
     account with a wrong password all render the canonical refusal; a locked account with the
     *correct* password is the one answer that differs, which is exactly section 22 line 238;
   - *the signup*: all three duplicate paths answer `indistinguishable` and write nothing, the lost
     race never touches another party's `users` row, and a genuine outage still compensates and
     still reports itself.
8. **The 2FA reset route answers the shared constant.** `app/api/auth/2fa/reset/route.ts` no longer
   builds its own `{ status: "accepted" }`; it returns `TWO_FACTOR_RESET_ACCEPTANCE`, so the body the
   gate checks is the body the platform ships.

## State before the first edit

No pre-existing defect in the repository: clean tree at `bba4f7b`, `HEAD` equal to
`origin/arena/1dc51ec3-kd-solution-it`, every gate green, and the dev server of STEP 047 stopped.
The defect this STEP fixes was found by reading the code, not by running it: recon of the four
anonymous surfaces showed sign-in and 2FA reset already answered one sentence (STEPs 039, 043 and
046 built that), and signup did not.

## Design notes worth keeping

- **A leak is a property of a set of answers, not of one.** No single route can be reviewed into
  safety, so the catalogue is data and the gate reads the folder. A route added later fails the
  build until someone decides which column it belongs in.
- **One refusal instance per call.** `anonymousRejection()` builds a new `AppError` because a shared
  instance carries `details` and a `cause` from whoever built it first; the gate asserts two calls
  are not the same object.
- **The provider's obfuscation is a signal, not a truth.** `identity` is three-valued precisely so
  that "the provider told us nothing" is a value the caller must handle, not a `false` that reads
  like "this address is new".
- **The platform asks itself before it asks the provider about a write.** The email lookup runs after
  the provider call (so both paths pay the same round trip) and before `insertCompany` (so the
  answer costs one index lookup instead of a company to undo). `users_email_key` is a full unique
  index, not a partial one, so a closed account keeps its address reserved and the lookup asks the
  same question the index will.
- **Hidden answers are not removed answers.** `ACCOUNT_LOCKED`, the second-factor challenge and every
  transport failure stay exactly as they were; what this STEP removed is the ability of a stranger
  to provoke them without proving the password.
- **An unrelated provider refusal is still reported.** Only an address-in-use code is absorbed; a
  weak password the local policy missed, or an upstream outage, keeps its own answer, because
  hiding real breakage behind "check your email" is a different bug.

## Database

- Migrations added: **none**. This STEP changes answers, not tables; `users_email_key` (`0003`) is
  the backstop it relies on and it is unchanged.
- Rollback verified on clean database: not applicable.

## Environment

- Environment variables added to `.env.example`: none.
- Secrets handled (names only, never values): none new; the signup path still uses the provider
  service key and the Turnstile secret through `lib/auth/runtime.ts`.

## Packages

- No new dependency. The integrator package request from STEP 047 stands and is still open:
  add `"check:auth": "node lib/auth/verify.ts"` to `scripts` and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`. The auth gate is not part of `npm run verify`
  until that lands, so it is run explicitly.

## Behaviour proof (acceptance checklist)

- **A stranger cannot learn whether an address exists.** Unknown address, wrong password,
  unconfirmed mail and a locked account reached with a wrong password all render the identical
  envelope: `401`, `AUTHENTICATION_REQUIRED`, catalog sentence, no details. Proven by comparing
  `JSON.stringify(buildErrorEnvelope(error, "disclosure-gate-request"))`, not by comparing codes.
- **A lock is a real answer, and only the password holder gets it.** The same lock table, the same
  fixture: the correct password is `423 ACCOUNT_LOCKED` with `retryAfterSeconds`, the wrong password
  is the canonical refusal (also proven in STEP 045's checks, which stay green).
- **A duplicate signup writes nothing.** `identity === "existing"`: zero rest calls, zero audit
  entries, zero provider deletions. Provider `user_already_exists`: zero rest calls. Platform holds
  the address: one `select`, no `insert`, no `insertReturning`, no `deleteUser`.
- **A lost race cleans up after itself, and only itself.** `users` insert refused with `CONFLICT`:
  answer `indistinguishable`, the company this attempt created is soft deleted, the provider user
  this request minted is deleted, and no `users` row is updated.
- **A genuine failure still fails loudly.** `role_assignments` insert fails: `DEPENDENCY_FAILED`, the
  recorded person is soft closed, the provider account this request created is deleted, and the
  route's log line records the failure. With `identity === "unknown"` the same failure deletes
  nothing, which is the guard, not a regression.
- **Every route is classified.** Removing `/api/auth/verify` from the catalogue fails the build with
  "the auth route /api/auth/verify is classified as anonymous or as session scoped".
- **API shapes.** Signup: `201` + `{"status":"verification_required"}` (one body), `422` for a form
  problem with field details, `413` past 8 KiB, `429`/`502`/`503` for transport. 2FA reset: `202` +
  `{"status":"accepted"}` for every address (four addresses proven in STEP 043's checks).
- **UI checks.** No UI change was needed: `app/(auth)/signup/signup-form.tsx` renders the success
  card for any `201` and already says "check your email", which is now literally true for every
  address. Desktop and mobile widths re-checked against the running build; no layout or copy change.

## Verification

- `node lib/auth/verify.ts`: **1 428 checks** (1 266 before this STEP), including the new
  `checkDisclosure()` and the reshaped `checkRegistration()` fixtures.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **131 source files**, config
  10 sections / 28 values, i18n **205 messages / 8 placeholders**, logger 117, errors 202 checks /
  15 codes, lint 77 checks / 26 rules, shell 176 checks / 36 files, jobs 110 checks, migrations
  **2 535 checks / 87 migrations / 72 tables**, type check, lint, production build.
- `npx tsc --noEmit` and `npx eslint .` clean; no `any`, no `console.log`, no new dependency, no new
  i18n message (every answer already existed in the catalog).
- Negative controls, each restored afterwards, each confirmed to fire:
  - removing the `/api/auth/verify` surface -> 1 problem (route unclassified);
  - deleting unconditionally in `compensate()` -> 1 problem ("a provider account the platform cannot
    prove it created is never deleted", expected 0, received 1);
  - giving `anonymousRejection()` a detail -> 1 problem ("a refusal carries no detail");
  - throwing instead of answering `indistinguishable` for `identity === "existing"` -> 2 readable
    problems ("a duplicate signup answers instead of throwing: it answered AUTHENTICATION_REQUIRED"
    and the status comparison), with no stack trace.
- `git diff` scope: 6 modified files, 2 added files, no touched file outside this STEP's owned paths.

## Next

- Next STEP: **049 - LR-022 device proof key generation and registration in browser**.
- Anything the next chat must know:
  - `lib/auth/disclosure.ts` is the contract for anonymous answers. A new route under
    `app/api/auth` fails `checkDisclosure()` until it is added to `ANONYMOUS_AUTH_SURFACES` or
    `SESSION_AUTH_SURFACES`, and a new code on an anonymous surface must be in `ERROR_CODES`.
  - `RegistrationResult` is a union (`created` / `indistinguishable`). Read `.status` first; the gate
    helper `expectCreated()` is the pattern for a check that wants the identifiers.
  - **Password reset (a later STEP) must reuse this contract.** `client.requestPasswordReset`
    already silences a rejection; the route that will call it must answer the same body for every
    address and be added to the catalogue, and it must respect section 22's "reset is disabled
    during a lock" - `assertAccountUnlocked` is the call.
  - **A known residue, recorded on purpose:** when the provider creates a person but the platform's
    `users` insert fails for a non-conflict reason while the provider answer listed no identity, the
    provider identity is left in place (`identity === "unknown"`). It is unconfirmed and unusable;
    an operations sweep that reconciles provider users with `public.users` can collect it, but
    deleting it automatically is the mistake this STEP removed.
  - **053 (step-up reauthentication):** the guard belongs in front of the office services, which is
    where 047 put the permission check; nothing in this STEP needs strengthening for it.
  - **055 (IP rate limiting):** the limiter wraps the four anonymous surfaces listed in
    `disclosure.ts` - that list is now the definitive inventory, and `RATE_LIMITED` is already in
    every one of their code lists.
