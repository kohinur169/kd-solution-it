// path: docs/planning/STEP_093_SUBSTEP_BREAKDOWN.md
# STEP 093 - KYC approval and rejection decision flow with reasons: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 093.1 - The database part: none - `0048` already carries the decision shape

- FEATURE_LIST section 5: a submission ends `approved` or `rejected`, a rejection carries its reason
  because the merchant reads it, every KYC decision is audit logged, and large or high-risk merchants
  need two reviewers. STEP 028's `0048_kyc_submissions.sql` was built with exactly that shape:
  `status in ('draft','submitted','in_review','approved','rejected')`, `first_reviewer_id` /
  `second_reviewer_id`, `reviewed_at` / `decided_at`, `decision_reason` with the trimmed 1..280 check
  and the rejected-requires-reason check, `kyc_submissions_two_people_check` (second != first),
  `kyc_submissions_second_reviewer_check` (four-eye decided rows must name a second reviewer), and
  `kyc_submissions_guard_state` locking a decided row as history. The server reads and writes with the
  PostgREST service role key, so RLS stays as `0070`'s tenant isolation for direct owner access.
- So this STEP adds **no migration**: `npm run -s check:migrations` stays at 108 migrations / 82
  tables / 3165 checks, and the gate's migration-set expectation stays at 0108 max.

## 093.2 - The service (`services/kyc/kyc-review.ts`)

- `KYC_DECISION_AUDIT_ACTION = "kyc_review.decided"` - every KYC decision is audit logged (section 5).
- `KYC_FINAL_APPROVAL_ROLES = ["ceo", "super_admin"]` - section 2 gives the ceo "KYC final approval"
  and section 5 says final approval by CEO or super_admin is what triggers sub-merchant
  provisioning; compliance_kyc does the KYC review (so it may reject), support has no KYC approval.
- `decideKycSubmissionBodySchema` (exported): `{ submission_id: uuid, decision: "approve"|"reject",
  reason?: trimmed 1..280 }`; a rejection without a reason is `VALIDATION_FAILED` `reason required`,
  the same rule `0049` uses for documents.
- `decideKycSubmission`: body parsed before any query; approval requires the final-approval roles,
  rejection the office review roles (both refused with zero queries); the submission is read by id
  (404 when unknown) and scoped to its own company; `approved`/`rejected` conflict `already_decided`,
  anything but `in_review` conflicts `not_in_review` (opening first sets `first_reviewer_id`, which
  `0048`'s reviewer check requires of a decided row). Four eyes: the decider is recorded as the
  second reviewer, and `fourEyeProblems` refuses the first reviewer deciding alone (`same_reviewer`,
  which `0048`'s two-people check also enforces). One conditional update by id + company +
  `status=eq.in_review` + current version + live rows, setting status, reason, `reviewed_at`,
  `decided_at`, `second_reviewer_id`, version+1; re-read race check (`stale`); one tolerated
  `kyc_review.decided` audit with the decision, reason and both reviewers; the full detail as the
  answer.

## 093.3 - Route and CSRF

- `POST /api/onboarding/kyc-decide` (single-method file): CSRF token first, 8 KiB body ceiling,
  session, JSON parse, `decideKycSubmission`, `logger.info`, `no-store`. The path is added to
  `lib/security/csrf.ts`.

## 093.4 - UI

- `app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx`: on an `in_review` detail the panel
  now shows a "Decide this submission" section with approve/reject buttons posting
  `{ submission_id, decision, reason? }` through the existing single `postJson` POST site to the one
  new `/api/onboarding/kyc-decide` literal (so the auth gate's baselines stay 16/29/33); the reason
  input is shared, `not_in_review` joins the rule map, the decided status line uses the new
  `statusApproved`/`statusRejected` keys.
- `lib/i18n/strings/en.ts`: `onboardingKycReview` block +8 keys (`statusApproved`, `statusRejected`,
  `decisionHeading`, `approveButton`, `rejectSubmissionButton`, `decideBusy`, templated
  `decidedDone`, `ruleNotInReview`); i18n gate 1504 -> 1512 messages, 175 -> 176 placeholders.
- The merchant side needed no change: STEP 087's status screen already reads `status` and shows the
  `decision_reason` on a rejection - the merchant only ever sees verification status (section 5).

## 093.5 - Verification

- `services/kyc/verify.ts`: 3309 -> 3439 checks. The fake store's submission update branch grew a
  version filter (rows seeded without `version` answer with the default 1) and a `submissionRace`
  flag; `SubmissionRowShape` grew `second_reviewer_id` / `reviewed_at`. New `checkKycDecision`
  covers: the final-approval role list; approval refused for compliance_kyc/finance_ops/support/
  blogger/owner/nobody and rejection refused for the non-office roles, all with zero queries; six
  bad bodies (non-uuid id, missing id, unknown decision, reject without/blank/over-280 reason) with
  zero queries; unknown id 404; `already_decided` and `not_in_review` conflicts with no writes; the
  first reviewer refused as second (`same_reviewer`); a second-reviewer approval (conditional query
  with `status=eq.in_review` + `version=eq.1`, `second_reviewer_id` set, version bump, decided_at,
  one `kyc_review.decided` audit with decision + second reviewer); an office rejection after open
  (trimmed reason stored and audited, no second reviewer when not four-eye, version 3 after open +
  decide); super_admin approval with an optional note; the stale race (conflict, no audit); the
  down-audit-sink decision still recorded. `checkKycDecisionSources` covers the route (POST only,
  token first, bounded, no-store, service, logged, CSRF list, folder), the service's named rules,
  and the panel's single decide literal / one POST site / new copy keys. `checkKycSources` now
  expects the service to write `approved`; `checkReviewCatalog` adds `decidedDone` to the templated
  list.
- `node lib/auth/verify.ts`: 2519 -> 2523 checks, baselines unchanged at 16 keepers / 29 mutation
  files / 33 call sites (the panel still has one POST site).
- `npm run -s check:i18n` 1512/176; `npm run -s check:migrations` 108/82 (3165 checks, no new
  migration); `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify` exit 0 (all gates
  + production build listing `/api/onboarding/kyc-decide`).
- Dev smoke on port 3107: `/` 200 signed-out; `POST /api/onboarding/kyc-decide` without a token ->
  422 `csrf_token_invalid`; `GET /api/onboarding/kyc-review` without a session -> 401;
  `/onboarding/kyc-review` 200 signed-out.
