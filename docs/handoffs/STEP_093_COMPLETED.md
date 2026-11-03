// path: docs/handoffs/STEP_093_COMPLETED.md
# STEP 093 - KYC approval and rejection decision flow with reasons: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 093 code are in one commit, the
one whose message is "STEP 093: KYC approval and rejection decision flow with reasons" (`git log -1`
on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_092_COMPLETED.md`.

## STEP

- **Number and title:** STEP 093 - KYC approval and rejection decision flow with reasons
  (`docs/final/STEP_PLAN_250.md`, the STEP 093 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Fifteenth STEP of the block.
- **Owned paths (File Ownership Rules):** the block's paths - `app/(dashboard)/onboarding/`,
  `services/kyc/`, the `app/api/onboarding/` routes the block owns, its migrations, and the shared
  files the block extends (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`, the gate harnesses,
  `app/(dashboard)/README.md`). `app/(admin)/`, `app/api/office/`, `components/office/`,
  `lib/settings/` untouched.
- **Feature list:** section 5 - a submission ends approved or rejected, a rejection carries its
  reason because the merchant reads it (line 71: every KYC decision is audit logged; line 66:
  large or high-risk merchants need two reviewers; line 67: final approval by CEO or super_admin
  triggers sub-merchant creation - the provisioning itself is STEP 094); section 2 - ceo holds
  "KYC final approval", compliance_kyc does "KYC review", support has "no KYC approval".
- **Depends on:** STEP 028 (`0048`'s decision shape), STEP 088 (the review queue/detail), STEP 089
  (`markKycSubmissionRisk` and the `fourEyeProblems` guard this flow calls), STEP 087 (the
  merchant status screen that shows the rejection reason).

## Migration added, and the rollback proof

- **None.** `0048_kyc_submissions.sql` was built with the whole decision shape: the status
  vocabulary, `first_reviewer_id`/`second_reviewer_id`, `reviewed_at`/`decided_at`,
  `decision_reason` with the trimmed 1..280 and rejected-requires-reason checks,
  `kyc_submissions_two_people_check`, the four-eye second-reviewer check, and the
  `kyc_submissions_guard_state` lock on decided rows. The server reads and writes with the
  PostgREST service role key, so RLS remains `0070`'s tenant isolation for direct owner access.
- `npm run -s check:migrations` passed unchanged: 3165 checks, **108 migrations, 82 tables**.

## Files

- **Created:** `app/api/onboarding/kyc-decide/route.ts` (POST),
  `docs/planning/STEP_093_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_093_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-review.ts` (`decideKycSubmission`,
  `decideKycSubmissionBodySchema`, `KYC_DECISION_AUDIT_ACTION`, `KYC_FINAL_APPROVAL_ROLES`),
  `lib/security/csrf.ts` (`/api/onboarding/kyc-decide`),
  `lib/i18n/strings/en.ts` (`onboardingKycReview` +8 keys; 1504 -> 1512 messages, 175 -> 176
  placeholders), `app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx` (decide section),
  `services/kyc/verify.ts` (3309 -> 3439 checks), `app/(dashboard)/README.md`.

## Behaviour

- **The decision** (`POST /api/onboarding/kyc-decide`, body `{ submission_id, decision:
  approve|reject, reason? }`): approval is the final approval of **ceo and super_admin**
  (`KYC_FINAL_APPROVAL_ROLES`) - FEATURE_LIST section 2 gives the ceo "KYC final approval" and
  section 5 ties final approval by CEO or super_admin to provisioning; rejection is the review
  office's work (super_admin/ceo/compliance_kyc), and support is refused outright. A rejection must
  carry the trimmed 1..280 reason `0048` demands on a rejected row, because the merchant reads it on
  their status screen. The submission must be `in_review` - opened first, so `first_reviewer_id` is
  set as `0048`'s reviewer check requires of a decided row (`not_in_review` otherwise); a decided
  row conflicts `already_decided`, since `0048`'s guard locks it as history.
- **Four eyes:** on a four-eye submission the decider is recorded as `second_reviewer_id`, and the
  `fourEyeProblems` guard refuses the first reviewer deciding alone (`same_reviewer`), matching
  `0048`'s two-people check at the database.
- **The write:** one conditional update by id + company + `status=eq.in_review` + current version
  over live rows, setting status, reason, `reviewed_at`, `decided_at`, `second_reviewer_id` and
  version+1; a re-read race check conflicts `stale`; one `kyc_review.decided` audit entry (a down
  audit sink never fails the decision) with the decision, reason and both reviewers; the full
  detail is the answer, `no-store`.
- **UI:** the review queue's detail panel (`/onboarding/kyc-review`) offers approve/reject on an
  open submission through the same single POST site and CSRF spread, posting to the one
  `/api/onboarding/kyc-decide` literal; `not_in_review` joined the rule map. The merchant surface
  needed no change: the status screen already shows `status` and the rejection reason - the merchant
  only ever sees verification status.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3439 checks (see
  `docs/planning/STEP_093_SUBSTEP_BREAKDOWN.md` 093.5 for the full list: role refusals with zero
  queries, six bad bodies, 404, `already_decided`/`not_in_review` conflicts, `same_reviewer`, the
  second-reviewer approval and the office rejection with their conditional queries and audits, the
  stale race, the down audit sink).
- `node lib/auth/verify.ts` - 2523 checks, baselines unchanged at 16 keepers / 29 mutation files /
  33 call sites; the new POST route is on the CSRF list and checks the token first.
- `npm run -s check:i18n` - 1512/176; `npm run -s check:migrations` - 3165 checks, 108/82 (no new
  migration); `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify` exit 0 (all gates
  + production build listing `/api/onboarding/kyc-decide`).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200 signed-out;
  `POST /api/onboarding/kyc-decide` without a token -> 422 `csrf_token_invalid`;
  `GET /api/onboarding/kyc-review` without a session -> 401; `/onboarding/kyc-review` 200 signed-out.

## Acceptance checklist

- The behaviour of the title was exercised through the gate harness: an in-review submission is
  approved by ceo/super_admin or rejected by the review office with a mandatory trimmed reason,
  four-eye rows need a second reviewer who is not the first, decided rows conflict, races conflict
  `stale`, and every KYC decision is audited under `kyc_review.decided`.
- Design decision recorded (FEATURE_LIST wins): "final approval" is ceo + super_admin only
  (section 2 line 20 and section 5 line 67); compliance_kyc may reject as review work. If the
  intent was that compliance_kyc may also approve, widen `KYC_FINAL_APPROVAL_ROLES` - one line.
- UI: the decide section reuses the queue panel's existing responsive classes, one POST site, one
  CSRF spread, all strings from the `onboardingKycReview` catalog, the templated done-line through
  `formatMessage`.

## Notes for the next STEP

- STEP 094 (automatic sub-merchant provisioning after final approval) hooks on the
  `approved` status this flow writes - `0054_submerchant_provisions` already holds the provision
  rows; the job should read decided submissions, not re-derive them.
- The merchant's rejection reason is already visible on `/onboarding/status`; if 094 needs to notify
  the merchant of approval, that is a merchant-notification STEP, not this one.
- `decideKycSubmission` returns the full detail, so the panel redraws from one call - the same shape
  `openKycReview` and `markKycSubmissionRisk` use.
