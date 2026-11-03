// path: docs/handoffs/STEP_098_COMPLETED.md
# STEP 098 - Duplicate identity check at signup, KYC and provisioning stages: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 098 code are in one commit, the
one whose message is "STEP 098: Duplicate identity check at signup, KYC and provisioning stages"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_097_COMPLETED.md`.

## STEP

- **Number and title:** STEP 098 - Duplicate identity check at signup, KYC and provisioning stages
  (`docs/final/STEP_PLAN_250.md`, the STEP 098 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Nineteenth STEP of the block.
- **Owned paths (File Ownership Rules):** "Onboarding and KYC STEPs 079-099 own
  `app/(dashboard)/onboarding/`, `services/kyc/` and `services/submerchant/`" - plus the block's
  owned `app/api/onboarding/` routes, its migrations, and the shared files the block extends (gate
  harnesses, `lib/i18n/strings/en.ts`, `app/(dashboard)/README.md`). This STEP used
  `services/kyc/duplicate-check.ts` (new), `services/kyc/kyc-capture.ts`, `services/submerchant/provision.ts`,
  the owned status screen, `en.ts`, one new migration pair, and the gate harness. No new route, no
  new page. `lib/auth/` and `app/api/auth/` untouched - see the ownership note below.
- **Feature list:** section 4 "One Person, One Account" - line 50 "Duplicate checks run at signup,
  at KYC submission and before sub-merchant creation"; line 51 the six signals (email, phone,
  identity document number hash, tax id, bank account fingerprint, legal name with date of birth);
  line 52 "A match blocks the new account and sends the case to compliance_kyc review. The applicant
  is informed that an account already exists."
- **Depends on:** STEP 028 (`0003` users with unique lowercase email, `0048`-`0051` KYC tables),
  STEP 082/083 (`0105` contact phone, `0103` tax id / legal name), STEP 046's `0046`
  `payout_bank_accounts.account_fingerprint`, STEP 094 (the provisioning job this check guards).

## Ownership boundary recorded (conflict note)

The title says the check runs "at signup", but the signup route (`app/api/auth/signup/route.ts`)
and `lib/auth/registration.ts` are owned by the auth STEPs 037-055, and "Never edit files owned by
another STEP" is absolute. What already exists there: `0003` makes email unique and the registration
answers every duplicate address indistinguishably (section 22), which is the signup-stage guard for
the only signal present at signup. This STEP therefore ships the signup-stage checker
(`checkSignupIdentity`) as an exported entry point for the auth-owned flow to call, and wires the
two stages this block owns - KYC submission and sub-merchant creation - directly. FEATURE_LIST scope
is fully implemented service-side; the one-line hook in the auth route is the auth block's to add.

## Migration added, and the rollback proof

- `migrations/0110_duplicate_cases.sql` (+ `.down.sql`): the `duplicate_cases` table - id (UUID v7),
  company_id (the tenant the case is filed under: the applicant's company, or the matched tenant at
  the signup stage), stage (signup / kyc_submission / provisioning), signal (the six section 4
  names), matched_company_id, matched_user_id, status (open / resolved) with reviewed_by,
  reviewed_at, resolution, created/updated/deleted_at, version. Checks tie resolved to its columns;
  the guard freezes tenant/stage/signal/match, walks open -> resolved only, locks resolved, refuses
  delete and soft delete. Partial unique index `duplicate_cases_open_unique` (company_id, stage,
  signal) where open; open queue index (created_at desc where open); per-company index; RLS
  default-deny. The down file drops table and guard function.
- `npm run -s check:migrations` passed: 3229 checks, **110 migrations, 84 tables**.

## Files

- **Created:** `services/kyc/duplicate-check.ts`, `migrations/0110_duplicate_cases.sql`,
  `migrations/0110_duplicate_cases.down.sql`, `docs/planning/STEP_098_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_098_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-capture.ts` (submitKyc runs the check),
  `services/submerchant/provision.ts` (provisioning runs it; `ProvisionRunSummary.blocked`),
  `services/kyc/verify.ts` (3703 -> 3773 checks),
  `app/(dashboard)/onboarding/status/status-form.tsx` (rule mapping),
  `lib/i18n/strings/en.ts` (1522 -> 1523 messages), `app/(dashboard)/README.md`.

## Behaviour

- **The checker** (`services/kyc/duplicate-check.ts`): `collectIdentitySignals` reads the
  applicant's own rows once per source table (users, business profile, UBO records, payout bank
  accounts) into the six signal values. `checkDuplicateIdentity` matches every signal in one
  `Promise.all` batch - each a single bounded select over live rows of the source table, with the
  applicant's own company filtered out in code - and for each matched signal records one open
  `0110` case (pre-reading the open case for tenant + stage + signal so a repeat converges) audited
  `duplicate_case.opened`. The result carries only `blocked` and the matches; applicant-facing
  answers never name the signal or the matched account.
- **At the KYC submission:** `submitKyc` runs the check at stage `kyc_submission` after the
  missing-documents/screening checks and before the conditional status update. A match throws
  CONFLICT `[{ field: "identity", rule: "duplicate_identity" }]`; the status screen maps the rule to
  "An account with these details already exists on the platform, so this submission was not sent."
  (section 4's sentence). The submission stays a draft; the cases sit in the compliance queue.
- **Before sub-merchant creation:** `runSubmerchantProvisioning` runs the check at stage
  `provisioning` after the approved-status check and before any provider read. A match returns
  `blocked: true` with `created: 0` and no provision row; the unblocked path answers `blocked:
  false` and provisions exactly as before.
- **At signup:** `checkSignupIdentity({ email })` validates the address, matches it against live
  users, records the case under the matched tenant (a blocked applicant has no company yet) with
  `actorUserId: null`, and answers blocked - ready for the auth-owned signup flow to call.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3773 checks (see
  `docs/planning/STEP_098_SUBSTEP_BREAKDOWN.md` 098.4: vocabulary; signal collection; no-match run
  writes nothing; full match run blocked with one open audited case per matchable signal, all naming
  the other company, the phone case naming the matched user; repeat converges; signup stage blocks /
  passes / refuses; submitKyc conflict leaves the draft untouched and the cases queued; provisioning
  blocked writes zero rows with a provisioning-stage case, unblocked run provisions two rows).
- `node lib/auth/verify.ts` - 2523 checks, baselines unchanged at 16 keepers / 29 mutation files /
  33 call sites (no new page, no new POST site, no auth file touched).
- `npm run -s check:i18n` - 1523/177/1; `npm run -s check:migrations` - 3229 checks, 110/84;
  `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify` exit 0 (all 10 gates +
  production build).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200 signed-out;
  `/api/jobs/health` 200 memory queue ok; `POST /api/onboarding/kyc-decide` and
  `POST /api/onboarding/kyc-submit` without a token -> 422 `csrf_token_invalid`;
  `/onboarding/status` and `/onboarding/kyc-review` 200 signed-out.

## Acceptance checklist

- The behaviours of the title were exercised through the gate harness at all three stages: signup
  (email match blocks and files the case under the matched tenant), KYC submission (a match conflicts
  `duplicate_identity`, blocks the submit, queues the case, and the applicant sees only "an account
  already exists"), and provisioning (a match blocks the run with zero rows written). Every match
  writes one open, audited `0110` case; repeated checks converge; no-match runs change nothing.
- One new migration with its rollback; RLS default-deny; no new route or page, so the CSRF list and
  auth baselines are unchanged; the one new UI sentence lives in en.ts.

## Notes for the next STEP

- The auth block should add the one-line `checkSignupIdentity` call to the signup flow
  (`lib/auth/registration.ts`, auth-owned) so the signup stage records its case at request time; the
  provider-level email uniqueness already answers duplicates indistinguishably.
- compliance_kyc reads the open queue from `duplicate_cases` (`status='open'`, oldest first) and
  resolves a case by the guarded open -> resolved walk; the office screen for it belongs to the
  office block (`app/(admin)/`), which this block does not touch.
- STEP 099 (suspension / reactivation / closure) can reuse `checkDuplicateIdentity` when an account
  is reactivated, and the `0110` history per company is already indexed.
