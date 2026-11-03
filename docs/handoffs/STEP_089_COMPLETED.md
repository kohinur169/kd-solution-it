// path: docs/handoffs/STEP_089_COMPLETED.md
# STEP 089 - Four-eye review flow for large and high-risk merchants: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 089 code are in one commit, the
one whose message is "STEP 089: Four-eye review flow for large and high-risk merchants" (`git log -1`
on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_088_COMPLETED.md`.

## STEP

- **Number and title:** STEP 089 - Four-eye review flow for large and high-risk merchants
  (`docs/final/STEP_PLAN_250.md`, the STEP 089 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Eleventh STEP of the block.
- **Owned paths (File Ownership Rules):** same as 088 - `app/(dashboard)/onboarding/`,
  `services/kyc/`, the `app/api/onboarding/` routes the block owns, and the shared files it extends
  (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`, the gate harnesses, `app/(dashboard)/README.md`).
- **Feature list:** line 66 - "Large or high-risk merchants require two reviewers (four-eye
  review)"; section 5 - the compliance KYC review; "Every KYC decision is audit logged."
- **Depends on:** STEP 088 (the review queue/detail that expose the flags), STEP 028 (`0048`,
  which already carries the four-eye columns and the `kyc_submissions_second_reviewer_check`).

## No migration - and why that needs no rollback proof

`0048` already carries `high_risk`, `four_eye_required`, `first_reviewer_id`, `second_reviewer_id`
and the check that forces a decided four-eye row to name a second reviewer different from the
first. The only write this STEP adds is a conditional UPDATE of the two flag columns with a re-read
race check, so a lost race writes nothing. No migration: `npm run -s check:migrations` stays at
105 migrations / 78 tables; no rollback proof is required.

## Design decision (fixed for the block)

`0048`'s check forces `second_reviewer_id` to stay NULL until the row is decided, so the second
reviewer is named AT the decision - and the whole-submission decision is STEP 093. STEP 089 owns the
two halves that make four-eye possible before that: the risk mark (compliance flags a submission
high risk / four-eye) and the exported `fourEyeProblems` guard that STEP 093's decision flow will
call with both reviewer ids. 088's rule still holds: this code never writes approved/rejected on a
submission.

## Files

- **Created:** `app/api/onboarding/kyc-risk-mark/route.ts`,
  `docs/planning/STEP_089_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_089_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-review.ts` (queue rows carry `highRisk`/`fourEyeRequired`;
  `KYC_RISK_MARK_AUDIT_ACTION`; exported `fourEyeProblems`; `markKycSubmissionRisk`),
  `app/api/...` none beyond the new route; `lib/security/csrf.ts` (the new POST path),
  `lib/i18n/strings/en.ts` (`onboardingKycReview` +9 keys; 1417 -> 1426 messages, 162 placeholders),
  `app/(dashboard)/onboarding/kyc-review/page.tsx` (four-eye badge on queue rows),
  `app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx` (risk mark/clear through the existing
  single `postJson`, second-reviewer hint), `services/kyc/verify.ts` (2439 -> 2509 checks),
  `app/(dashboard)/README.md` (kyc-review bullet gains the 089 sentence).

## Behaviour

- **Risk mark** (`POST /api/onboarding/kyc-risk-mark`, body `{submission_id uuid, high_risk bool,
  four_eye_required? bool}`): office roles only; uuid validated before any query; the row must still
  be draft/submitted/in_review - a decided row conflicts with `already_decided` and zero writes;
  marking `high_risk: true` always forces `four_eye_required` (even if the body says false); one
  conditional update (`id` + `company_id` + `status=eq.<current>` + `deleted_at=is.null`) with
  version+1, re-read race check (CONFLICT `stale`), one `kyc_review.risk_marked` audit entry
  recording both resulting flags, then the response is the full re-read detail. Clearing is the
  same call with both flags false.
- **Guard for 093** (`fourEyeProblems({ fourEyeRequired, firstReviewerId }, secondReviewerId)`):
  `required` when a four-eye decision has no second reviewer, `same_reviewer` when second equals
  first, else clean - matching the two clauses of `0048`'s
  `kyc_submissions_second_reviewer_check`.
- **Screen:** the queue badges four-eye rows; the panel shows mark-high-risk / clear buttons only
  while the submission is undecided, and under a four-eye row a hint that the decision will need a
  second, different reviewer. All mutations still go through the panel's one shared POST helper.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 2509 checks: the new `checkKycReviewRisk()` (guard unit cases,
  role refusals with zero queries, uuid-before-query, decided-row lock with zero writes, high risk
  forcing four-eye, conditional `status=eq.submitted` update, version+1, one audit with the flags in
  the payload, large-only four-eye, clearing both flags) plus source probes for the route, csrf
  entry, service exports and panel/page wiring.
- `node lib/auth/verify.ts` - 2499 checks; baselines unchanged at 14 keepers / 27 mutation files /
  31 call sites (the risk mark reuses the panel's single POST literal).
- `npm run -s check:i18n` - 1426 messages / 162 placeholders; `npm run -s typecheck` and
  `npm run -s lint` clean; `npm run -s verify` exit 0 (9 gates + production build listing
  `/api/onboarding/kyc-risk-mark`).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): POST
  `/api/onboarding/kyc-risk-mark` without a token -> 422 `csrf_token_invalid`.

## Notes for the next STEP

- STEP 093 (approve/reject) must call `fourEyeProblems` with the submission's
  `fourEyeRequired`/`firstReviewerId` and the chosen `secondReviewerId` before writing the decision,
  and must keep refusing to write a decision without it - `0048`'s check would reject the row
  anyway, but the service should fail with a clean 422, not a database error.
- The risk mark is reversible until the decision; after the decision the flags are locked with the
  row (`already_decided`).
- 088's note stands: this service still never contains the approved/rejected write - that literal
  belongs to 093 alone.
