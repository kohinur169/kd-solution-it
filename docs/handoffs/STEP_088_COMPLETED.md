// path: docs/handoffs/STEP_088_COMPLETED.md
# STEP 088 - Compliance KYC review queue with document viewer: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 088 code are in one commit, the
one whose message is "STEP 088: Compliance KYC review queue with document viewer" (`git log -1` on
the branch shows its hash). Previous handoff: `docs/handoffs/STEP_087_COMPLETED.md`.

## STEP

- **Number and title:** STEP 088 - Compliance KYC review queue with document viewer
  (`docs/final/STEP_PLAN_250.md`, the STEP 088 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Tenth STEP of the block.
- **Owned paths (File Ownership Rules):** `app/(dashboard)/onboarding/`, `services/kyc/`,
  `services/submerchant/`, plus the `app/api/onboarding/` routes the block owns and the shared files
  it has been extending (`lib/security/csrf.ts`, `lib/i18n/strings/en.ts`, the gate harnesses).
  Because of that, the queue screen lives at `app/(dashboard)/onboarding/kyc-review/` even though its
  audience is the office; the service enforces the office roles, so the placement is a path
  convention, not a permission hole.
- **Feature list:** section 5 - compliance_kyc reviews the merchant's evidence; "the merchant only
  sees verification status"; "Every KYC decision is audit logged."; section 21 - the compliance
  desk's KYC review work.
- **Depends on:** STEP 028 (`0048`-`0051`), STEPs 084-087 (the merchant-side writes and the
  merchant-safe summary), STEP 083 (the office-read audit precedent of `processor_profile`).

## No migration - and why that needs no rollback proof

Everything the queue reads and both writes change already exists in `0048`/`0049` (statuses,
first_reviewer_id, document status/reviewed_at/reviewed_by/rejection_reason/version). Both writes
are conditional UPDATEs of existing rows with a re-read race check, so a lost race writes nothing.
No migration: `npm run -s check:migrations` stays at 105 migrations / 78 tables; no rollback proof
is required.

## Files

- **Created:** `services/kyc/kyc-review.ts` (the office side of the KYC tables),
  `app/api/onboarding/kyc-review/route.ts` (GET queue),
  `app/api/onboarding/kyc-review-submission/route.ts` (GET detail by id),
  `app/api/onboarding/kyc-review-open/route.ts` (POST open),
  `app/api/onboarding/kyc-document-review/route.ts` (POST accept/reject a document),
  `app/(dashboard)/onboarding/kyc-review/page.tsx`,
  `app/(dashboard)/onboarding/kyc-review/kyc-review-queue.tsx`,
  `docs/planning/STEP_088_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_088_COMPLETED.md`.
- **Modified:** `lib/security/csrf.ts` (the two POST paths), `lib/i18n/strings/en.ts` (new
  `onboardingKycReview` block, ~48 keys; 1357 -> 1417 messages, 134 -> 162 placeholders),
  `services/kyc/verify.ts` (2115 -> 2439 checks), `lib/auth/verify.ts` (baselines 14 keepers /
  27 mutation files / 31 call sites), `app/(dashboard)/README.md` (the kyc-review bullet).

## Behaviour

- **Queue** (`GET /api/onboarding/kyc-review`): office roles only (super_admin, ceo,
  compliance_kyc; everyone else PERMISSION_DENIED with zero queries). Returns every
  submitted/in_review submission, ordered by submitted_at, with per-row document/owner counts (by
  submission) and screening count (by company - `0051` has no submission column). Queue reads are
  deliberately cross-company; the gate asserts no queue query carries a company filter.
- **Detail / document viewer** (`GET .../kyc-review-submission?id=<uuid>`): the id is validated as a
  UUID before any query; the row is looked up by id, then every later query is scoped to the
  submission's own company. The office sees the verification method, provider reference, each
  document's storage key and SHA-256 (the record that binds row to bytes - the bytes themselves are
  the storage layer of STEPs 100-105), owners, and the screening rows with result/note/lists. Each
  read appends one `kyc_review.read_by_office` audit entry. The merchant's 087 summary still never
  carries any of that.
- **Open** (`POST .../kyc-review-open`): submitted -> in_review with first_reviewer_id, one
  conditional update (`status=eq.submitted`, version+1), re-read race check (409 stale), idempotent
  re-open by the same reviewer, audit `kyc_review.opened`. Drafts conflict with `not_submitted`.
- **Document decision** (`POST .../kyc-document-review`): accept/reject one document; reject requires
  a trimmed 1..280 reason (0049's own check); conditional on `status=eq.uploaded`; already-decided ->
  409 `already_reviewed`; audit `kyc_document.reviewed`. This file never writes approved/rejected on
  the submission - that is STEP 093.
- **Screen:** `/onboarding/kyc-review` renders the queue server-side and hands it to a client panel
  that loads a detail by GET and sends the two mutations through one shared POST helper (one POST
  literal, one awaited CSRF spread).

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 2439 checks: queue/detail/open/decision behavior incl. role
  refusals with zero queries, uuid-before-query, cross-company queue vs company-scoped detail,
  office-only fields, audit entries, conditional updates, race/idempotency/conflict cases, source
  probes and the `onboardingKycReview` catalog check.
- `node lib/auth/verify.ts` - 2495 checks (14/27/31 baselines; the new panel's single POST site and
  single awaited spread).
- `npm run -s check:i18n` - 1417 messages / 162 placeholders; `npm run -s lint` clean;
  `npm run -s typecheck` clean; `npm run -s verify` exit 0 (9 gates + production build listing
  `/onboarding/kyc-review` and the four new API routes).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `GET
  /onboarding/kyc-review` -> 200 signed-out sentence; POST `/api/onboarding/kyc-review-open` and
  `/kyc-document-review` without a token -> 422 `csrf_token_invalid`; GET queue/detail without a
  session -> 401.

## Notes for the next STEP

- STEP 089 (four-eye review) reads `four_eye_required`/`high_risk` off the same detail and adds the
  second reviewer on the decision - the detail already carries both flags.
- STEP 093 (approval/rejection with reasons) is the only place that may write `approved`/`rejected`;
  the 088 gate probes that `kyc-review.ts` never contains that literal. Keep it that way.
- When the storage STEPs (100-105) land, the viewer can render bytes by storage key; the row already
  carries key + hash, and the office can re-hash the stored object and compare.
- The queue screen sits under the onboarding block's owned path by rule; if the office area later
  grows its own KYC screens, move the page and keep the service where it is.
