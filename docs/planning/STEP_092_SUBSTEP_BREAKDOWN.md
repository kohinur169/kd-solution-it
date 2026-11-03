// path: docs/planning/STEP_092_SUBSTEP_BREAKDOWN.md
# STEP 092 - Unusual large transaction hold and review trigger: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 092.1 - The database part: `0108_payment_holds.sql` (+ rollback)

- FEATURE_LIST line 62: the underwriting criteria include "holding unusually large transactions for
  review", set by the compliance team. STEP 090 stored the switch and the threshold on the `0106`
  criteria row (`large_transaction_hold_enabled`, `large_transaction_hold_threshold`). This file
  gives the held transactions their own home: `payment_holds` - one row per held transaction with
  `company_id` FK, nullable trimmed `reference` (the payment's id / idempotency key, 1..120),
  `amount numeric(18,4)` checked `(0, 100000000000000]`, `status` in held/released/rejected, `held_at`,
  `reviewed_by` FK users, `reviewed_at`, `decision_reason`, timestamps, `deleted_at`, `version`.
- Decision checks: `held` rows carry no reviewer fields, decided rows must set `reviewed_by` +
  `reviewed_at`, a rejection must carry a trimmed 1..280 reason, `reviewed_at >= held_at`,
  `version > 0`. Guard trigger refuses deletes and soft deletes and freezes `company_id`.
  Indexes: partial `(held_at) where status='held' and deleted_at is null` for the queue, and
  `(company_id, held_at desc)` for the merchant list. RLS: default deny; owner reads own company's
  rows; the four office read roles (ceo/compliance_kyc/finance_ops/super_admin) read the whole
  queue; only compliance_kyc + super_admin write. No seed - rows are born from the trigger.
- Rollback drops the table, the guard function and the index. `npm run -s check:migrations`:
  107 -> 108 migrations, 81 -> 82 tables, 3165 checks.

## 092.2 - The criteria read (`services/kyc/underwriting.ts`)

- New export `readLargeTransactionHold(rest)` -> `{ enabled, threshold } | null`, reading the same
  `0106` row `readStartingMonthlyLimit` reads (assert count == 1). Null when the criteria row is
  missing, so the trigger answers RESOURCE_NOT_FOUND instead of silently holding nothing.

## 092.3 - The service (`services/kyc/payment-hold.ts`)

- Money math as in `merchant-limit.ts`: integer minor units (scale 10^4) in BigInt, money pattern
  `^\d{1,14}(\.\d{1,4})?$`, ceiling 1e14 USD; no float anywhere (the gate probes for that).
- `holdLargeTransaction` - the per-transaction trigger the payment core will call: owner-only,
  company from the session, amount validated before any query (VALIDATION_FAILED `amount`
  invalid_format / out_of_range), criteria read (404 when missing); switch off or amount below the
  threshold -> `{ held: false }` with no write; a `reference` (trimmed, <= 120) makes it idempotent
  - a repeated reference answers with the existing hold instead of a second row; otherwise one
  insert (status `held`, `held_at` now, version 1), a re-read of the merchant's newest hold, and one
  `payment_hold.created` audit entry (a down audit sink never fails the write).
- `readPaymentHoldQueue` - office read roles only, deliberately cross-company (no company filter),
  `order=held_at.asc&limit=200`, one `payment_hold.read_by_office` audit per read with the waiting
  count.
- `readMerchantPaymentHolds` - owner-only, own company, `order=held_at.desc&limit=100`
  (FEATURE_LIST line 277: a merchant sees their own holds).
- `decidePaymentHold` - manage roles (compliance_kyc/super_admin; manual payment review is the
  compliance desk's work, FEATURE_LIST line 21): hold id validated as UUID before any query, body
  `{ decision: release|reject, reason? }` with reject requiring the trimmed 1..280 reason (the same
  rule `0049` sets), 404 for an unknown id, CONFLICT `already_decided` for a decided hold, one
  conditional update by id + `status=eq.held` + current version + live rows with version+1, reviewer
  and instant and reason, re-read race check (CONFLICT `stale`), one `payment_hold.decided` audit,
  the fresh hold as the answer.

## 092.4 - Routes and CSRF

- `GET /api/onboarding/payment-holds` (the office queue, no-store, no query-string company),
  `POST /api/onboarding/payment-hold-decide` (CSRF token first, 8 KiB ceiling, session, JSON parse,
  service, `logger.info`, no-store), `GET /api/onboarding/merchant-holds` (the merchant's own list,
  no-store). The POST path is added to `lib/security/csrf.ts`. Each route is a single-method file so
  the auth gate's token-first probe holds per file.

## 092.5 - UI

- `app/(dashboard)/onboarding/payment-holds/page.tsx` + `payment-holds-panel.tsx`: the office queue
  screen (SessionKeeper, four-state read - signed-out / forbidden / unavailable / ready - via
  `readOwnerActor` + `readPaymentHoldQueue`), one row per held transaction (status, company,
  amount, reference, held-at, decision + reason once decided) with release/reject buttons and a
  reason input; the panel posts through one `postJson` helper to the single
  `/api/onboarding/payment-hold-decide` literal with `csrfHeaders`, maps 401/403/429/422 rules
  (`required`, `invalid_format`, `already_decided`, `stale`) to copy, and refreshes the list.
- New `onboardingPaymentHolds` block in `lib/i18n/strings/en.ts` (31 keys; templated lines
  `companyLine`/`amountLine`/`referenceLine`/`heldAtLine`/`decidedLine`/`reasonShownLine` rendered
  through `formatMessage`); i18n gate 1473 -> 1504 messages, 169 -> 175 placeholders.

## 092.6 - Verification

- `services/kyc/verify.ts`: 3021 -> 3309 checks. The fake store grew `holdRows` (last positional
  arg of `createBusinessDatabase`, via the new `holdDatabaseOf` helper), a select branch with an
  optional company scope (the queue read is deliberately unscoped), eq filters on id/status/reference
  (+ `is.null`), `order=held_at.asc|desc`, limit; an insert branch; and an update branch conditional
  on id + status + version with a `holdRace` flag. New `checkPaymentHolds` covers: owner-only and
  read/manage role refusals with zero queries, companyless owner, six malformed amounts, below-
  threshold and disabled switch (no write), missing criteria 404, at/above threshold hold (one
  insert, re-read, `payment_hold.created` audit with amount), audit-sink-down still holds,
  reference idempotency (no second insert/audit, `reference=eq.` pinned), queue cross-company
  oldest-first with the read audit and waiting count, merchant list own-company newest-first,
  non-uuid id and four bad bodies before any query, unknown id 404, `already_decided` with no write,
  release (conditional query, reviewer, version bump, `payment_hold.decided` audit) and reject
  (trimmed reason), stale race. Plus `checkPaymentHoldSources` (routes/service/migration/page/panel
  probes, ASCII, path comments, CSRF list, folder checks) and `checkPaymentHoldCatalog` (the
  `onboardingPaymentHolds` block: >= 30 keys, every key used, no missing key, templated keys through
  `formatMessage`). Migration-set expectation moved to 0108 present / 0109 absent / max 108.
- `node lib/auth/verify.ts`: 2515 -> 2519 checks, baselines 15 -> 16 keepers, 28 -> 29 browser
  mutation files, 32 -> 33 call sites (the new page + panel).
- `npm run -s check:i18n` 1504/175; `npm run -s check:migrations` 108/82 (3165 checks);
  `npm run -s typecheck`, `npm run -s lint` clean; `npm run -s verify` exit 0 (all gates + production
  build listing `/api/onboarding/payment-holds`, `/api/onboarding/payment-hold-decide`,
  `/api/onboarding/merchant-holds`).
- Dev smoke on port 3107: `/` 200 signed-out; `GET /api/onboarding/payment-holds` and
  `GET /api/onboarding/merchant-holds` without a session -> 401; `POST /api/onboarding/payment-hold-decide`
  without a token -> 422 `csrf_token_invalid`; `/onboarding/payment-holds` 200 signed-out.
