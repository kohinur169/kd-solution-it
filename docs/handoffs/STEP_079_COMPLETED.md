// path: docs/handoffs/STEP_079_COMPLETED.md
# STEP 079 - Merchant onboarding wizard shell with saved progress: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `b4dc4f1`. Previous handoff:
`docs/handoffs/STEP_077_COMPLETED.md` (078 was completed before 077 in this branch; the plan order is
unchanged).

## STEP

- **Number and title:** STEP 079 - Merchant onboarding wizard shell with saved progress
  (`docs/final/STEP_PLAN_250.md`, the STEP 079 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs 079-099.
  First STEP of the block.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`. This STEP uses the first two and leaves `services/submerchant/` to the
  provisioning STEPs that follow.
- **Feature list:** section 5 - "Business information form follows the connected processor
  requirements and changes per processor... Merchant sets business information once on the platform.
  The same information is sent to every connected processor... Address verification uploads: utility
  bill issued within 3 months, bank statement, source of funds document... Merchant Category Code
  (MCC) dropdown or input in merchant onboarding and profile settings... Merchant website verification
  step: website or store link review for business authenticity."
- **Depends on:** STEP 001 (`0001_companies.sql` - the tenant root and `set_row_metadata`), STEP 003
  (`0003_users.sql` - the account a position names), STEP 039/051 (`readRequestActor`, the bound
  session reader `app/(dashboard)/onboarding/owner-actor.ts` uses), STEP 056/057 (`lib/auth/rest.ts`,
  the CSRF token), STEP 052 (`0010`-era session/device discipline this page follows with
  `SessionKeeper`), and STEP 068/077 (the screen, reader and gate patterns this STEP follows).

## Files

- **Created:** `migrations/0102_onboarding_progress.sql`,
  `migrations/0102_onboarding_progress.down.sql`, `services/kyc/onboarding-steps.ts`,
  `services/kyc/onboarding-progress.ts`, `services/kyc/verify.ts`,
  `app/api/onboarding/progress/route.ts`, `app/(dashboard)/onboarding/owner-actor.ts`,
  `app/(dashboard)/onboarding/step-copy.ts`, `app/(dashboard)/onboarding/onboarding-wizard.tsx`,
  `app/(dashboard)/onboarding/page.tsx`, `docs/planning/STEP_079_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_079_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `onboarding` block, 36 strings), `lib/security/csrf.ts`
  (one path on the protected list: `/api/onboarding/progress`), `lib/auth/verify.ts` (the CSRF gate's
  path resolver learned the third prefix; the session keeper count 6 -> 7; the browser mutation
  baselines 20 files / 23 sites -> 21 / 24), `app/(dashboard)/README.md` (what now exists in the
  merchant area, and the reader every later merchant screen imports).
- **Two foreign files were touched, and only as registrations.** A POST route has to be on
  `CSRF_PROTECTED_PATHS`, and `lib/auth/verify.ts` resolved only `auth/` and `office/` prefixes when
  it read each protected route from disk. Both edits are one path and one branch; the alternative -
  the platform's first server action, or a mutation handler outside `/api/` that the CSRF gate cannot
  see - would have been a weaker precedent than a registration.

## Database

- **One migration, `0102`, and it is one table plus its rule.**
  - `public.onboarding_progress`: `id`, `company_id` (the tenant), `updated_by` (who last saved),
    `current_step`, `completed_steps` (jsonb), `started_at`, and the six columns every table in this
    repository carries (`created_at`, `updated_at`, `deleted_at`, `version`, plus the FKs to
    `companies` and `users`).
  - `public.onboarding_completed_steps_valid(jsonb)` - `immutable`, plpgsql - is the check a `check`
    constraint cannot express: an array, every element one of the six step names, no duplicates.
  - `onboarding_progress_company_key` - unique on `(company_id)` partial on `deleted_at is null` -
    is the read the wizard makes and the rule that a second tab updates the position instead of
    forking it.
  - `onboarding_progress_set_row_metadata` moves `version` and `updated_at` on every update, and
    `onboarding_progress_default_deny` refuses every browser role: the service reads and writes with
    the service role key after taking the company from the session.
- **Rollback:** `0102_onboarding_progress.down.sql` drops the policy, the trigger, the index, the
  table and the function it created, and touches nothing that belongs to `0001`, `0003` or any later
  file.
- **Proof on a real PostgreSQL (PGlite 0.5.14, `0102` applied over `0001` + `0003`): 29 checks.**
  The table, its RLS flag, its `using (false)` policy, its unique partial index, a valid insert with
  the defaults (first step, nothing finished, version 1, `started_at = created_at`), then the
  refusals: a seventh step name, a non-name element, a duplicate step, an unknown step, a finished
  list that is not an array, a second live row for one company, a row updated before it was created,
  and a company that does not exist. All six steps may be finished at once; an update moves
  `current_step`, `version` to 2 and `updated_at`; a soft-deleted row frees the company for a new
  one; the rollback removes the table and the function and leaves the companies in place; and the
  migration applies again cleanly. **Negative control:** with the completed-steps check replaced by
  `true`, the proof failed on the unknown-name case - so the proof is sensitive to the rule it
  claims.
- **Migration number after this STEP:** `0103` is free.

## Environment

- No new variable. The route and the page read through the authentication runtime, which already
  validates the seven boot variables.

## Packages

- **No dependency added, removed or changed.** `package.json` and `package-lock.json` are untouched.
  PGlite was installed with `--no-save` for the migration proof only and is not part of the build.
- **Package requests open for the owner:** `check:onboarding` (`node services/kyc/verify.ts`),
  `check:account-sessions`, `check:account-unlocks`, `check:audit-log`, `check:announcements`,
  `check:settings`, `check:countries`, `check:approvals`, `check:office`, `check:auth`,
  `check:security`, `check:gateways`, `check:permissions`.

## What was built

- **`services/kyc/onboarding-steps.ts`** - the vocabulary and nothing else: `ONBOARDING_STEPS` (the
  six, in section 5's order), `OnboardingStep`, `ONBOARDING_STEP_COUNT`, `ONBOARDING_START_STEP`,
  `ONBOARDING_OWNER_ROLES` (`owner`), the table and audit names, `isOnboardingStep`,
  `onboardingStepIndex` and `nextOnboardingStep`. It imports one type and nothing else, because the
  browser component imports it: a client component that imported the *service* would pull the
  PostgREST client and the audit signer into a merchant's bundle.
- **`services/kyc/onboarding-progress.ts`** - `readOnboardingProgress` and `saveOnboardingStep`, both
  behind `requireAnyRole(actor, ONBOARDING_OWNER_ROLES)` and `requireCompanyId(actor)` **before the
  first query**. The read is one row by `company_id=eq.<the session's company>&deleted_at=is.null&limit=1`,
  and a company with no row is an ordinary "nothing saved yet" rather than an error. The save
  validates the step (`VALIDATION_FAILED` naming `step`/`unknown_step`, with no query at all),
  inserts the first row, updates the position afterwards - filtered by the actor's company - and
  appends exactly one `onboarding.step_saved` entry naming the merchant, the step and the step it
  moved from. An unchanged save writes nothing and audits nothing; a racing first save loses the
  insert on `onboarding_progress_company_key` and becomes the update it would have been; and a row
  holding a step this build does not know is `INTERNAL_ERROR` rather than an empty wizard.
- **`app/api/onboarding/progress/route.ts`** - one POST, one field. CSRF token, then the declared
  length (1 KiB), then the session, then the parse, then the service; the body is read for `step` and
  never for a company. `405` for a GET, `no-store` on the answer.
- **`app/(dashboard)/onboarding/page.tsx`** - the shell screen in the merchant area: the four states
  (signed out, not a merchant, unavailable, ready), the progress line ("Step 3 of 6, 2 finished"),
  the last-saved instant, the six step cards and the position control. It mounts `SessionKeeper`,
  names no role, and prints every sentence from the catalog.
- **`app/(dashboard)/onboarding/onboarding-wizard.tsx`** - the client half: the six cards in order,
  each with its position, its state (`You are here`, `Finished`, `Not started`), what section 5 asks
  for, and one button that saves the position through `POST /api/onboarding/progress` with the CSRF
  token and re-reads the page from the server. Every refusal has its own sentence (`401`, `403`,
  `422 unknown_step`, `429`, or "nothing changed").
- **`app/(dashboard)/onboarding/owner-actor.ts`** - the merchant area's one account reader, memoised
  with `cache()`, the same shape as the office reader.
- **`app/(dashboard)/onboarding/step-copy.ts`** - the label and the description key of each step, and
  the three-way state of a card, typed as `MessagePath` so a catalog rename is a compile error.
- **`services/kyc/verify.ts`** - 345 checks: the vocabulary and its order, the refusals with zero
  queries and zero audit entries, the read scoped to the session's company (including a second tenant
  reading the same store), the validation refusals, the create, the update, the idempotent save, the
  racing insert, the unreadable row, the sources (route order, body field, size cap, no device proof,
  one endpoint in the client, no role literal on the page) and the catalog both ways.

## Behaviour Proof (acceptance checklist)

| Section 5 / title requirement | Where it is satisfied | Proven by |
| --- | --- | --- |
| The wizard has the six steps of section 5, in order | `ONBOARDING_STEPS`, drawn by the client component | `services/kyc/verify.ts` (vocabulary, catalog, migration names) |
| A merchant can leave and come back to the same step | `current_step` in `0102`, written by `saveOnboardingStep` | gate (create, update, idempotence, race) + PGlite proof |
| Progress belongs to one company and cannot be pointed elsewhere | company from the session, filter on `company_id` | gate (refusals, cross-tenant read, insert/update queries) |
| A step the build does not know is refused, not stored | `VALIDATION_FAILED` `{field: "step", rule: "unknown_step"}` | gate (six rejected values, zero queries) |
| Reading is not an act; saving is audited | `onboarding.step_saved` per move, none per read | gate (one entry per create/update, none for a read) |
| The merchant area has one account reader | `owner-actor.ts` with `cache()` | gate (source checks) + the page mounting `SessionKeeper` |
| The screen works at desktop and mobile widths | single column, `sm:`/`lg:` padding, cards stacked | manual width check listed below |

## Security proof

- **The role and the company are asked before the first query**, so an office account or an owner
  without a company learns nothing about any merchant's row - the gate proves four offices, an owner
  with no company and an actor with no roles read nothing, write nothing and audit nothing.
- **The company is never read from the request.** The route reads only `step`; the service reads only
  `actor`, `step`, the address and the agent. The gate asserts both.
- **The write is CSRF-protected and listed** on `CSRF_PROTECTED_PATHS`; the gate asserts the token
  check runs before the session is read, which runs before the body is parsed, which runs before the
  service, and that the body is bounded at 1 KiB.
- **No device proof, and the reason is recorded.** A merchant who has just signed up has no confirmed
  device, so requiring one would block the first save of the wizard it is meant to open. The acts
  that change account security or another account's data keep STEP 050's proof; this one writes a
  position on the caller's own row. The gate asserts the route does *not* call
  `verifySensitiveRequest`, so the decision cannot drift unnoticed.
- **The table is default-deny** and is read and written only through the service role key.
- **A rate-limit scope is not added.** `RATE_LIMITED_PATHS` names authentication endpoints and its
  scopes live in `lib/auth/rate-limit.ts` (STEP 055's file); this route is bounded by the CSRF token,
  the session, the step vocabulary and a 1 KiB body. If the owner wants the counter, the request is
  one entry in that file's two maps and one `enforceRateLimit` call here.

## Verification

- `node services/kyc/verify.ts` - **345 checks passed** (new).
- `node lib/auth/verify.ts` - **2459 checks**, browser mutation baselines **21 files / 24 call
  sites**, session keepers **7**.
- `node components/office/verify.ts` - 545 checks, 12 screens (unchanged).
- `node lib/security/verify.ts` 2376, `node lib/audit-log/verify.ts` 735,
  `node lib/settings/verify.ts` 551, `node lib/announcements/verify.ts` 351,
  `node lib/approvals/verify.ts` 536, `node lib/countries/verify.ts` 467,
  `node lib/gateways/verify.ts` 467, `node lib/permissions/verify.ts` 425,
  `node lib/jobs/verify.ts` 110, `node lib/errors/verify.ts` 202 - all unchanged.
- `npm run -s verify` - **exit 0**: structure 256 files, env 16 variables, config 28 values, i18n
  **1088 messages / 102 placeholders**, logger 117, errors 202, lint rules 77, shell **398 checks /
  102 files**, jobs 110, migrations **2974 checks / 102 migrations / 77 tables**, typecheck, eslint,
  and a clean `next build` listing `/onboarding` and `/api/onboarding/progress` as dynamic.
- **Dev smoke** on port 3105: `GET /onboarding` answers **200** and renders the signed-out sentence
  and the sign-in link (the page explains the state instead of redirecting), `GET /onboarding?step=address`
  answers **200**, `POST /api/onboarding/progress` without a CSRF token answers **422** with
  `{field: "csrf", rule: "csrf_token_invalid"}`, the same POST with a wrong token answers **422**, and
  `GET` on the route answers **405**.

## Known limitation, recorded rather than hidden

- **The shell saves the position, not the answers.** `completed_steps` is read by this screen and
  written by the STEPs that collect the data (080 onward): marking "address finished" from a shell
  with no address in it would be a false record for the compliance desk to read. The table carries
  the column now so those STEPs add data rather than a migration.
- **A save is a position and can be any step, including one already finished.** That is deliberate:
  a merchant who wants to correct their address sets the wizard to the address step, and nothing here
  claims the correction happened.
- **The wizard is reachable at `/onboarding` only.** The merchant dashboard shell (`app/(dashboard)`)
  does not exist yet - this is its first page - so the page renders its own chrome, exactly as
  `app/(auth)/sessions` and `app/office/sessions` do. A later STEP that builds the merchant shell can
  move the chrome up without touching the service or the route.
- **No office view of merchant progress in this STEP.** Section 5's underwriting screens read KYC
  submissions, and the progress row is a merchant draft; an office funnel over `current_step` would be
  its own read with its own permission, and is not part of this title.

## Deployment checks a person runs

1. Apply `0102` (`0102_onboarding_progress.sql`) and confirm the rollback runs clean on a scratch
   database - the PGlite transcript in this handoff is the same pair of files.
2. Sign in as a merchant owner and open `/onboarding`: the wizard shows six steps, "Step 1 of 6, 0
   finished" and "nothing is saved yet".
3. Press **Work on this step** on step 4: the page reloads with the fourth card marked "You are here",
   the progress line reads "Step 4 of 6", and the save instant appears in UTC.
4. Check the audit log for `onboarding.step_saved`: one row, naming the merchant company, the actor,
   `step: "website"`, `previous_step: "business"`, `created: true`, and the address the request came
   from.
5. Close the browser, sign in again and open `/onboarding`: the wizard opens on the step that was
   saved.
6. Sign in as an office account (`support`) and open `/onboarding`: the page says the wizard belongs to
   a merchant owner, with no step list and no button.
7. Check both widths: the cards stack under `sm`, the buttons stay reachable, and nothing scrolls
   sideways.

## Next

- **STEP 080 - Business information form driven by processor required fields**
  (`docs/final/STEP_PLAN_250.md`), which owns the `business` step this shell already marks and
  reserves: it writes the data and, with it, `completed_steps`.
- The other open requests are unchanged: the package scripts listed above, and the deployment checks
  of STEPs 074-078, which still need a real project.
