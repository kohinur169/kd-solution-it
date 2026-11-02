// path: docs/planning/STEP_079_SUBSTEP_BREAKDOWN.md
# STEP 079 - sub-step breakdown

STEP: **Merchant onboarding wizard shell with saved progress** (FEATURE_LIST section 5, the
statements "Business information form follows the connected processor requirements", "Merchant sets
business information once on the platform. The same information is sent to every connected
processor", "Merchant Category Code (MCC) dropdown or input in merchant onboarding and profile
settings" and "Merchant website verification step"; STEP_PLAN_250 section 079).

This is the first STEP of the merchant area and the first of the onboarding block, so it is cut into
six sub-steps: the owned paths and the hole first, then the database, then the service, the route,
the screen, and the proof.

## Sub-step 1 - the owned paths, and what already exists

- File Ownership Rules: onboarding STEPs own `app/(dashboard)/onboarding/`, `services/kyc/` and
  `services/submerchant/`. This STEP uses the first two.
- `app/(dashboard)/` held only its README; `services/` held only its README. There is no merchant
  shell, no merchant reader and no merchant service yet.
- What exists and is reused rather than rebuilt: `0001_companies.sql` (the tenant and
  `set_row_metadata`), `0003_users.sql` (the account a save names), `readRequestActor`
  (`lib/auth/request-actor.ts`), `lib/auth/rest.ts`, `lib/auth/audit.ts` and the CSRF token of
  STEP 057. `0048_kyc_submissions.sql` is the *submission* the wizard eventually feeds; it is not the
  wizard's own progress and is untouched.
- Conclusion: a table for the position, a service for the merchant's own row, one guarded route, one
  screen, one gate.

## Sub-step 2 - the database

- `migrations/0102_onboarding_progress.sql`: the table (`company_id`, `updated_by`, `current_step`,
  `completed_steps`, `started_at` plus the six columns every table carries), the immutable
  `onboarding_completed_steps_valid(jsonb)` function its check calls, the unique partial index
  `onboarding_progress_company_key`, the metadata trigger and the default-deny policy.
- `migrations/0102_onboarding_progress.down.sql`: drops exactly those five things.
- `npm run check:migrations`, then a PGlite run of `0001` + `0003` + `0102` + its rollback: 29 checks,
  including nine refusals and a negative control with the check replaced by `true`.

## Sub-step 3 - the vocabulary and the service

- `services/kyc/onboarding-steps.ts`: the six steps in section 5's order, the owner role, the table
  and audit names, and the three predicates. One type import and nothing else, because the browser
  imports this file.
- `services/kyc/onboarding-progress.ts`: `readOnboardingProgress` (one scoped read, "nothing saved
  yet" when the company has no row) and `saveOnboardingStep` (validate, then insert or update, then
  one audit entry; nothing at all when the step did not move). Both open with
  `requireAnyRole(ONBOARDING_OWNER_ROLES)` and `requireCompanyId(actor)`.

## Sub-step 4 - the route

- `app/api/onboarding/progress/route.ts`: CSRF token, declared length cap, session, parse, service.
  The body is read for `step` and never for a company; the answer is `{status: "saved", companyId,
  currentStep, savedAtEpochMs}` with `no-store`.
- Registration: the path on `CSRF_PROTECTED_PATHS` (`lib/security/csrf.ts`) and the CSRF gate's route
  resolver taught the third prefix (`lib/auth/verify.ts`). No rate-limit scope: those live in the
  auth STEPs' file and this route is bounded by the token, the session and a 1 KiB body.

## Sub-step 5 - the screen

- `app/(dashboard)/onboarding/page.tsx`: the four states, the progress line, the last-saved instant,
  the six cards, `SessionKeeper`, and links to the sign in page, the session list and the home page.
- `onboarding-wizard.tsx`: the cards and the one control, with a sentence for each refusal.
- `step-copy.ts`: the label and description key of each step and the three card states, typed as
  `MessagePath`.
- `owner-actor.ts`: the merchant area's one cached account reader.
- Copy: the `onboarding` block in `lib/i18n/strings/en.ts`, 36 strings.

## Sub-step 6 - the proof

- `services/kyc/verify.ts`: 345 checks over the service's own store - the vocabulary, the refusals,
  the scoped read (including a second tenant on the same data), the validation refusals, create,
  update, idempotence, the racing insert, the unreadable row, and the sources.
- `npm run verify`, `next build`, and a dev smoke on port 3105: the page answers 200 with the
  signed-out sentence, the route answers 422 without a CSRF token and 405 for a GET.
- Then one commit, the push, and this handoff with the breakdown beside it.

## What this STEP deliberately leaves out

- **No form data.** Every field section 5 describes belongs to the STEP that builds its step (080
  business information, 081 category code, 082 address and contact, 083 the one-time profile). The
  shell stores the position and reads the finished list so those STEPs add data, not a migration.
- **No claim that a step is finished.** `completed_steps` is written by the STEP that validates the
  data; a button in the shell that said "finished" would be a false record.
- **No merchant dashboard shell.** `app/(dashboard)/` has no layout yet, so this page renders its own
  chrome, the way the two existing session lists do; a later STEP can lift it.
- **No office view over the position.** An office funnel over merchant drafts is a different read
  with a different permission, and section 5's office screens read submissions.
- **No device proof and no second factor on the save.** A merchant who has just signed up has no
  confirmed device, and the write is a position on their own company's row; the acts that change
  account security keep STEP 050's proof.
