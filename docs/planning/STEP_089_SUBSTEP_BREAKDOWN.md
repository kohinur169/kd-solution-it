// path: docs/planning/STEP_089_SUBSTEP_BREAKDOWN.md
# STEP 089 - Four-eye review flow for large and high-risk merchants: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 089.1 - Confirm there is no migration

- `0048_kyc_submissions.sql` already carries everything four-eye review needs: `high_risk`,
  `four_eye_required`, `first_reviewer_id`, `second_reviewer_id`, and the check
  `kyc_submissions_second_reviewer_check` that forces `second_reviewer_id` to be NOT NULL exactly
  when a four-eye row is decided (approved/rejected) and forces it to differ from
  `first_reviewer_id`. The comments on both flags match FEATURE_LIST section 5 / line 66.
- The one write this STEP adds is a conditional UPDATE of two flag columns on an existing row with
  a re-read race check, so a lost race writes nothing.
- **Proof:** `npm run -s check:migrations` stays at 105 migrations / 78 tables.

## 089.2 - Design decision: where the second reviewer is named

- `0048`'s check forces `second_reviewer_id` to stay NULL until the row is decided, so the second
  reviewer is named AT the decision, not when the row is opened. That decision write belongs to
  STEP 093 (whole-submission approve/reject). STEP 089 therefore owns: (a) risk marking - the
  compliance desk flags a submission high risk / four-eye before or during review - and (b) the
  exported guard `fourEyeProblems` that STEP 093's decision flow will call with both reviewer ids.
- The queue and detail already expose the flags, so the office can see which rows need four-eye.

## 089.3 - The service (`services/kyc/kyc-review.ts`)

- Queue row schema/select/interface now carry `highRisk` / `fourEyeRequired` (select gains
  `high_risk,four_eye_required`); the detail already carried them from 088.
- New audit action constant `KYC_RISK_MARK_AUDIT_ACTION = "kyc_review.risk_marked"`.
- `fourEyeProblems({ fourEyeRequired, firstReviewerId }, secondReviewerId)` - pure guard exported
  for STEP 093: returns `required` (field `second_reviewer_id`) when a four-eye row is being
  decided with no second reviewer, `same_reviewer` when the second equals the first, else `[]`.
  Unit-checked in the gate, including the distinct-reviewer pass.
- `markKycSubmissionRisk({ actor, submissionId, body })`: office roles only
  (`KYC_REVIEW_OFFICE_ROLES`), `submission_id` validated as a UUID before any query, one read, then
  CONFLICT `already_decided` unless the row is still in draft/submitted/in_review (decided rows are
  immutable). `four_eye_required = high_risk || four_eye_required` - marking high risk always
  forces four-eye. One conditional update (`id` + `company_id` + `status=eq.<current>` +
  `deleted_at=is.null`) with version+1, a re-read race check (CONFLICT `stale` when 0 rows or the
  version moved), one `kyc_review.risk_marked` audit entry whose payload records both resulting
  flags, then returns `readKycReviewDetail` so the panel re-renders from the source of truth.
  Clearing both flags is the same call with `high_risk: false, four_eye_required: false`.

## 089.4 - Route, CSRF, copy

- New `app/api/onboarding/kyc-risk-mark/route.ts`: POST only, chain CSRF -> 8 KiB content-length
  ceiling -> actor -> JSON parse -> Zod body (`submission_id` uuid, `high_risk` boolean,
  `four_eye_required` optional boolean) -> service, `no-store`. Registered in
  `lib/security/csrf.ts` (third onboarding POST path).
- `lib/i18n/strings/en.ts`: the `onboardingKycReview` block gains 9 keys (queue four-eye badge,
  risk heading, mark/clear buttons, busy/done states, second-reviewer hint, and the two rule
  messages `already_decided` / `same_reviewer`); 1417 -> 1426 messages, placeholders stay 162.

## 089.5 - UI

- `kyc-review/page.tsx`: queue rows render a four-eye badge from `queueFourEye` when the row is
  flagged.
- `kyc-review-queue.tsx`: `RISK_PATH` constant + a `markRisk(highRisk)` action that goes through
  the panel's existing shared `postJson` helper - still exactly one POST literal and one awaited
  CSRF spread, so the auth gate's 1:1 baselines (14/27/31) do not move. Risk mark/clear buttons
  show only while the submission is undecided; under the four-eye line the panel shows the
  `secondReviewerHint` telling the reviewer the decision will need a second, different reviewer.

## 089.6 - Verification

- `services/kyc/verify.ts`: 2439 -> 2509 checks. The seeded sub-reviewing row is now
  `high_risk + four_eye_required`, a new decided row (rejected) exercises the lock, and a new
  `checkKycReviewRisk()` covers: `fourEyeProblems` unit cases (required / same_reviewer /
  distinct-reviewer pass), role refusals with zero queries, non-uuid id -> 422 with zero queries,
  decided row -> CONFLICT `already_decided` with zero writes, high risk forcing four-eye even when
  the body says false, the conditional update carrying `status=eq.submitted`, version+1, exactly one
  `kyc_review.risk_marked` audit with `four_eye_required: true` in the payload, large-only
  (four-eye without high risk) marking, and clearing both flags. Source probes added for the new
  route, the csrf entry, the review-service exports, and the panel/page wiring.
- `node lib/auth/verify.ts` 2499 checks, baselines unchanged (14/27/31 - no new POST site).
- `npm run -s check:i18n` 1426/162; `npm run -s typecheck`, `npm run -s lint` clean;
  `npm run -s verify` exit 0 (9 gates + production build listing `/api/onboarding/kyc-risk-mark`).
- Dev smoke on port 3107 (`.env.local` from `.env.example`, removed afterwards): POST
  `/api/onboarding/kyc-risk-mark` without a CSRF token -> 422 `csrf_token_invalid` (the CSRF guard
  fires before the body ceiling and before any actor lookup).
