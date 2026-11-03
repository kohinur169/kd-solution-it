// path: docs/handoffs/STEP_087_COMPLETED.md
# STEP 087 - KYC submission summary and status screen for merchant: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 087 code are in one commit, the
one whose message is "STEP 087: KYC submission summary and status screen for merchant"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_086_COMPLETED.md`.

## STEP

- **Number and title:** STEP 087 - KYC submission summary and status screen for merchant
  (`docs/final/STEP_PLAN_250.md`, the STEP 087 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Ninth STEP of the block.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`, plus the `app/api/onboarding/` routes the onboarding block owns and the
  shared files this block has been extending (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`,
  the two gate harnesses).
- **Feature list:** section 5 - "Automatic verification that is incomplete or unsuccessful moves to
  Manual review without telling the merchant which method was used. The merchant only sees
  verification status." and "Every KYC decision is audit logged." `0048`'s own comment repeats it:
  "the merchant only ever reads `status`".
- **Depends on:** STEP 084 (pack, routes, upload/UBO/screening), STEP 085-086 (date rules),
  STEP 028 (`0048` kyc_submissions with status vocabulary draft/submitted/in_review/approved/
  rejected, submitted_at/submitted_by, decided_at, decision_reason, version, and the guard that
  freezes the submitter and locks decided rows).

## No migration - and why that needs no rollback proof

`0048` already stores everything the screen reads and the submit writes; the submit is an UPDATE
of the draft row (status, submitted_at, submitted_by, version), never a new table or column, and
the update is conditional on the row still being the draft, so a lost race writes nothing. No
migration: `npm run -s check:migrations` stays at 105 migrations / 78 tables; there is no
partial-write path, so no rollback proof is required.

## Files

- **Created:** `app/api/onboarding/kyc-submit/route.ts`,
  `app/(dashboard)/onboarding/status/page.tsx`, `app/(dashboard)/onboarding/status/status-form.tsx`,
  `docs/planning/STEP_087_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_087_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-capture.ts` (`readKycSummary`, `submitKyc`,
  `KYC_SUBMIT_AUDIT_ACTION`, `KycSummarySnapshot`; `submissionDetailRowSchema` deliberately does not
  select the method or provider reference; the pack from 084 no longer answers `method`; document
  rows/selects gained `rejection_reason`), `lib/security/csrf.ts` (the submit path),
  `app/(dashboard)/onboarding/documents/page.tsx` (link to the status screen),
  `documents-form.tsx` (per-status document labels + rejection reason line),
  `lib/i18n/strings/en.ts` (new `onboardingStatus` block, ~34 keys; 4 keys in `onboardingDocuments`;
  1319 -> 1357 messages, 127 -> 134 placeholders), `services/kyc/verify.ts` (1916 -> 2115 checks),
  `lib/auth/verify.ts` (baselines 13 keepers / 26 mutation files / 30 call sites),
  `app/(dashboard)/README.md` (the status bullet).

## Behaviour

- **Summary (merchant-safe):** `readKycSummary` answers the latest submission's id, status,
  submitted/decided instants and decision reason; slimmed document rows (type, review status,
  rejection reason, dates, size - never storage key, never hash); counts of documents, owners,
  significant owners and screened subjects; the `missing` list; and `canSubmit`. It carries no
  verification method, no provider reference and no screening result - the gate serializes a
  summary and asserts none of those strings appear. Every query is scoped to the session's
  company. Role refusals read nothing.
- **Submit:** `POST /api/onboarding/kyc-submit` (empty body, company from the session) ->
  `submitKyc`: no submission or missing documents/screening -> 422 naming the field; status not
  draft -> 409 `already_submitted`; otherwise one conditional update to `submitted` with
  submitted_at/submitted_by and version+1, a re-read that turns a lost race into 409 `stale`, one
  audit entry `kyc_submission.submitted`, and the fresh summary as the answer. 0048's guard makes
  the decided rows untouchable.
- **Screen:** `/onboarding/status` renders the status banner (per-status copy; approved green,
  rejected with the office's reason), the instants, the counts, the missing list and the submit
  button (only when `canSubmit`). The documents page links to it; it links back to the documents
  step. The documents list now shows accepted/rejected and the rejection reason.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 2115 checks: summary refusals and reads (empty/seeded/decided),
  merchant-safety probes on the serialized summary and on the pack (no `method`), company scoping,
  submit refusals (no submission, no screening, foreign company, double submit -> CONFLICT with
  no second write), the happy path (status/submitted_at/submitted_by/version=2, the conditional
  update query, the audit entry, the returned summary), source probes for route/page/form, and the
  `onboardingStatus` catalog check.
- `node lib/auth/verify.ts` - 2487 checks; baselines 13/26/30, one POST and one awaited CSRF
  spread in the new form.
- `npm run -s check:i18n` - 1357 messages / 134 placeholders; `npm run -s lint` clean;
  `npm run -s typecheck` clean; `npm run -s verify` exit 0 (9 gates + production build listing
  `/onboarding/status` and `/api/onboarding/kyc-submit`).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `GET
  /onboarding/status` -> 200 with the signed-out sentence; POST `/api/onboarding/kyc-submit`
  without a token -> 422 `csrf_token_invalid`; GET on the route -> 405.

## Notes for the next STEP

- STEP 088 (compliance KYC review queue with document viewer) is the office side of the same rows:
  it may read `verification_method`/`provider_reference`/reviewer ids (office roles), but must keep
  them off any merchant surface - the 087 probes (serialized summary, pack without `method`) are
  the pattern to reuse.
- The submit transition is the only merchant write on `kyc_submissions`; 088/093 will add
  in_review/approved/rejected from the office side with the same conditional-update shape.
- `readKycSummary` reads the latest submission regardless of status; history rows (a rejected
  cycle) stay readable as history, which is what the audit reads - do not delete them.
