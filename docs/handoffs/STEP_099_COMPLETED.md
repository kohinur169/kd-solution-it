// path: docs/handoffs/STEP_099_COMPLETED.md
# STEP 099 - Merchant suspension, reactivation and account closure flow with saved card token deletion and chargeback-period fund hold: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 099 code are in one commit, the
one whose message is "STEP 099: Merchant suspension, reactivation and account closure flow with
saved card token deletion and chargeback-period fund hold" (`git log -1` on the branch shows its
hash). Previous handoff: `docs/handoffs/STEP_098_COMPLETED.md`.

## STEP

- **Number and title:** STEP 099 - Merchant suspension, reactivation and account closure flow with
  saved card token deletion and chargeback-period fund hold (`docs/final/STEP_PLAN_250.md`, the STEP
  099 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Twentieth and last STEP of the block.
- **Owned paths (File Ownership Rules):** "Onboarding and KYC STEPs 079-099 own
  `app/(dashboard)/onboarding/`, `services/kyc/` and `services/submerchant/`" - plus the block's
  owned `app/api/onboarding/` routes, its migrations, and the shared files the block extends (gate
  harnesses, `lib/security/csrf.ts`, `lib/auth/verify.ts`, `lib/i18n/strings/en.ts`,
  `app/(dashboard)/README.md`). This STEP used all of those; `lib/auth/` itself and `app/(admin)/`
  were not touched - the suspension writes the `0003` `users.status` column (a shared table the
  auth session reads), not an auth file.
- **Feature list:** section 13 "Suspension, Reactivation and Account Closure" - line 152 suspended
  merchant submits required documents and returns to active after compliance review; line 154 on
  closure the remaining money goes to the bank after the hold period and the chargeback-liability
  funds stay held until the chargeback period ends; line 155 saved card tokens deleted at once;
  line 156 closed and suspended data and sub-merchant records retained 7 years. (Line 153, the
  unpaid-billing stop/pay flow, belongs to the plan-and-billing block 212-220 and is noted below.)
- **Depends on:** STEP 012 (`0001`/`0003` - the status column the session reads), STEP 016's session
  authority, STEP 028 (`0048`-`0051`), STEP 027 (`0046`), STEP 026 (`0040`/`0041`/`0043`/`0045`),
  STEP 090 (`0106` hold days and reserve percent), STEP 094/095 (`0054`), STEP 098 (`0110`),
  STEP 097 (`0109`).

## Migration added, and the rollback proof

- `migrations/0111_merchant_account_events.sql` (+ `.down.sql`): the append-only `merchant_account_events`
  log - id (UUID v7), company_id, event (`suspended`, `reactivation_requested`, `reactivated`,
  `closure_requested`, `closed`, `card_tokens_deleted`), reason (closed vocabulary, suspension only),
  detail (1..280 trimmed), required_documents (JSON array, max 10, suspension only),
  actor_user_id (null only for the system event), kyc_submission_id (composite tenant FK,
  reactivation request only), payout_bank_account_id + hold_release_at + chargeback_hold_release_at
  (closure only, chargeback instant strictly after the payout instant), and the six audit columns.
  The guard refuses every update, delete and soft delete - the 7 year retention is structural. The
  down file drops the table, its guard, policies and indexes and deletes the seeded setting.
- The same file seeds `platform_settings` `chargeback.hold_days` = 180 (the card network chargeback
  window), the period section 13 line 154 names.
- `npm run -s check:migrations` passed: 3261 checks, **111 migrations, 85 tables**.

## Files

- **Created:** `services/kyc/account-lifecycle.ts`, `services/submerchant/card-tokens.ts`,
  `migrations/0111_merchant_account_events.sql` + `.down.sql`, five routes under
  `app/api/onboarding/account-*/route.ts`, `app/(dashboard)/onboarding/account/{page.tsx,account-form.tsx}`,
  `app/(dashboard)/onboarding/account-review/{page.tsx,account-review-queue.tsx}`,
  `docs/planning/STEP_099_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_099_COMPLETED.md`.
- **Modified:** `services/submerchant/provision-sync.ts` (registers the token-deletion job),
  `lib/security/csrf.ts` (five paths), `lib/auth/verify.ts` (counts 29->31 files, 33->35 call sites,
  16->18 keepers), `lib/i18n/strings/en.ts` (1523 -> 1608 messages: `onboardingAccount`,
  `onboardingAccountReview`, `onboardingStatus.accountLink`), `app/(dashboard)/onboarding/status/page.tsx`
  (nav link), `services/kyc/verify.ts` (3773 -> 4142 checks), `app/(dashboard)/README.md`.

## Behaviour

- **Suspension** (`POST /api/onboarding/account-suspend`, office roles): records the `0111`
  `suspended` event with the reason and the required reactivation documents, and sets every live
  owner user of the company to `suspended` in `0003` - which is what locks their sessions on the next
  request, because `lib/auth/session.ts` reads that column per request. A repeat conflicts.
- **Reactivation** (`POST /api/onboarding/account-reactivate-request` by the owner, then
  `POST /api/onboarding/account-reactivate-decide` by the office): the merchant uploads and submits
  the required documents through the normal KYC flow (a new draft submission), requests reactivation,
  which names that submission in the `reactivation_requested` event; the office accepts only when
  the submission is `approved` and none of its documents is rejected, and the owners return to
  `active`.
- **Closure** (`POST /api/onboarding/account-close-request` by the owner, then
  `POST /api/onboarding/account-close` by the office): records `closed` with the verified payout
  bank account, `hold_release_at` = now + the merchant risk tier's `hold_days` (section 10's hold
  period) and `chargeback_hold_release_at` = now + `chargeback.hold_days` (180 days by default);
  places the chargeback-liability reserve (`extra_reserve_percent` of the remaining
  `merchant_payable` balance) as a `0043` `holds` row of reason `closure` with `release_due_at` =
  the chargeback instant; enqueues the delayed `merchant_account.closure_payout` job which writes
  the `0045` payout row for the rest to the verified bank after the hold period; restricts every
  verified `0054` sub-merchant provision (charges and payouts off) and queues
  `submerchant.delete_card_tokens` per provision at once, which records the `card_tokens_deleted`
  event (the provider call itself belongs to the adapter STEPs, like STEP 094's creation call); sets
  the owners to `closed`. Nothing is ever deleted - the log, the hold, the provisions and the users
  row all stay, which is the 7 year retention.
- **Screens:** `/onboarding/account` (merchant: state, reason, required documents, reactivation and
  closure request, the closure schedule when closed) and `/onboarding/account-review` (office queue
  with accept-reactivation / close per row and the suspend form).

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 4142 checks; see
  `docs/planning/STEP_099_SUBSTEP_BREAKDOWN.md` 099.5 for the full scenario list, including the
  closure arithmetic (80 USD balance, 10% high-tier reserve -> 8 USD closure hold until the 180 day
  instant, 72 USD payout delayed 30 days) and the two enqueued jobs with their idempotency keys.
- `node lib/auth/verify.ts` - 2543 checks (every POST route is on the CSRF list exactly, token checked
  once and before the session; 31 mutation files / 35 call sites / 18 keepers).
- `npm run -s check:i18n` - 1608 messages / 183 placeholders / 1 locale; `npm run -s check:migrations` -
  3261 checks, 111 migrations, 85 tables; `npm run -s typecheck`, `npm run -s lint` clean;
  `npm run -s verify` exit 0 (all gates plus the production build).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200;
  `/api/jobs/health` 200; all five new routes answer 422 `csrf_token_invalid` without a token;
  `/onboarding/account`, `/onboarding/account-review` and `/onboarding/status` 200 signed-out.

## Acceptance checklist

- The behaviours of the title were exercised through the gate harness end to end: suspend (users
  locked, event + audit), submit documents + request reactivation, office reactivation (refused on
  unapproved submission or rejected document, accepted otherwise), closure request, and closure with
  the chargeback-period hold placed, the remainder payout scheduled after the hold period, the
  sub-merchant restricted and the saved card token deletion queued and recorded at once. Repeats of
  every action conflict instead of writing twice.
- One new migration with its rollback; RLS default-deny; five new routes all on the CSRF list; the
  new copy lives in en.ts; no auth file touched.

## Notes for the next STEP

- Section 13 line 153 (a merchant stopped for unpaid billing can log in and pay, services re-enable
  on success) belongs to the plan-and-billing block 212-220; its suspension reason `billing` and its
  reactivation are already representable in `0111`, and the billing block can call
  `suspendMerchant` / `decideReactivation` from `services/billing/`.
- The chargeback program of section 12 (graduated action ending in suspension) is the dispute block
  191-199's; it can suspend with reason `chargeback_program` through the same route.
- Reactivation deliberately does not re-run STEP 098's duplicate identity check: the account already
  exists, and the check guards new accounts at signup, KYC submission and provisioning. The `0110`
  history per company stays indexed.
- The `merchant_account.closure_payout` row is written `requested`; its approval and processing
  belong to the finance flow of the payment STEPs 127-146, which will also own the balance view the
  closure read approximates from `merchant_payable` entries.
- Next STEP: 100 (storage adapter interface), which starts the storage block `lib/storage/`.
