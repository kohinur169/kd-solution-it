// path: docs/handoffs/STEP_044_COMPLETED.md
# STEP 044 Completed - Handoff

Feature: **two factor reset flow after email contact and document verification**
(`docs/final/STEP_PLAN_250.md` line 594), from section 22's recovery sentence.

## What was delivered

1. **A way back that is not a way in.** `/2fa/reset` is a screen for a merchant who kept neither the
   authenticator app nor the backup codes. It renders without a session - the person who needs it
   cannot sign in - and posts an address and a description to `POST /api/auth/2fa/reset`, which
   answers one `202` sentence in every case. `/2fa` and `/signin` link to it.
2. **Four situations, one answer.** An unknown address, a closed account, a deleted account, an
   account that never enrolled and a genuine request all answer `{ accepted: true }`; exactly one of
   them writes a row. The audit entry carries `reason_length` and never the reason or the address, and
   the route's log line carries neither.
3. **A queue with an order.** `/office/2fa-reset-requests` shows the live requests oldest first and is
   readable only by `super_admin`, `ceo`, `compliance_kyc` and `support`. The screen names the account
   by id: the office acts on ids, and a queue is the kind of screen that gets left open. The API
   selects no address at all.
4. **The contact is the evidence.** `POST /api/office/2fa-reset-requests/decision` carries three
   actions on one state machine: `contacted` moves a `pending` request and requires the document
   reference; `approve` moves a `contacted` request; `reject` records why. Anything else is
   `CONFLICT`, so an approval can never skip the record of what a human verified.
5. **The reset clears a factor, not an account.** Approval writes `totp_secret_ciphertext: null`,
   `totp_confirmed_at: null` and `backup_code_hashes: []` in one update - a confirmed row with no
   secret would violate `users_totp_confirmation_check`, and a cleared confirmation with the old
   hashes left behind would be ten working codes nobody knows about. Password, sessions and account
   status are untouched, and the merchant enrols again through STEP 041 after signing in.

## Migration

`migrations/0084_two_factor_reset_requests.sql` (forward) and `.down.sql` (rollback).

The table holds `id`, `company_id`, `user_id`, `status`, `reason`, `document_reference`,
`requested_ip`, `requested_user_agent`, `contacted_at`, `decided_at`, `decided_by`, `decision_note`
and the four metadata columns. Constraints worth naming:

- `two_factor_reset_requests_status_check`: `pending|contacted|approved|rejected|cancelled`;
- `two_factor_reset_requests_reason_check`: 10-1 000 characters, equal to its own trim;
- `two_factor_reset_requests_decision_check`: a `case status` form - `approved`/`rejected` require
  `decided_at` and `decided_by`; every other status requires both to be null. The first draft used
  `(status in ('approved','rejected')) = (decided_at is not null and decided_by is not null)`, and the
  PGlite proof caught it accepting a `decided_by` alone on a `contacted` row;
- `two_factor_reset_requests_contacted_check`: a `contacted_at` implies a `pending` or `contacted`
  status - a decided row cannot also be waiting;
- `two_factor_reset_requests_live_key`: a partial unique index on `(user_id)` for
  `status in ('pending','contacted')` and `deleted_at is null`, so one account has one live request.

**Rollback proof (PGlite 0.5.14, PostgreSQL engine, 33/33 checks):** the forward file applies; table,
RLS, default-deny policy and all 16 columns present; a `pending` request is accepted; a second live
request fails on `two_factor_reset_requests_live_key`; a short reason, a padded reason, an unknown
status, an approval without a decider, a decider without a decision, a contact instant on `pending`
and a malformed IP are all refused; `pending -> contacted` bumps `version` to 2; an approval is
accepted and frees the slot; the rollback applies, the table is gone, and the forward file applies
again.

## Files

| Path | Change |
| --- | --- |
| `migrations/0084_two_factor_reset_requests.sql`, `.down.sql` | new |
| `lib/auth/two-factor-reset.ts` | new: request, queue, decision |
| `app/api/auth/2fa/reset/route.ts` | new: the anonymous request |
| `app/api/office/2fa-reset-requests/route.ts` | new: the queue |
| `app/api/office/2fa-reset-requests/decision/route.ts` | new: the three office actions |
| `app/(auth)/2fa/reset/page.tsx`, `reset-request-form.tsx` | new |
| `app/office/2fa-reset-requests/page.tsx`, `office-reset-queue.tsx` | new |
| `app/(auth)/2fa/page.tsx`, `app/(auth)/signin/page.tsx` | the link to `/2fa/reset` |
| `lib/auth/verify.ts` | 84 new checks (912 -> 996) |
| `lib/auth/README.md` | rules 40-43 |
| `lib/i18n/strings/en.ts` | 57 strings in the `resetRequest` and `officeReset` groups |
| `app/(auth)/README.md`, `app/README.md` | what `/2fa/reset` and `app/office` are |
| `docs/planning/STEP_044_SUBSTEP_BREAKDOWN.md` | new |
| `docs/handoffs/STEP_044_COMPLETED.md` | this file |

## Behaviour proof (acceptance checklist)

1. The form is strict: the address is trimmed and lowercased, the reason has a ten character floor,
   and a field the merchant must not set is refused (proven on the schema).
2. An unknown address, a suspended account, a deleted account and an account with no confirmed factor
   each answer `accepted: true` and write **no** row and **no** audit entry.
3. A genuine request writes one `pending` row with the address it came from and one audit entry
   `user.two_factor_reset_requested` carrying `reason_length` (and the gate asserts the payload has no
   `email` key).
4. A second request answers the same sentence, writes no second row and audits nothing - the route
   swallows the `CONFLICT` the live-key index raises.
5. The queue returns the live rows, keeps their statuses and reasons, selects no address, clamps a
   limit of 5 000 to 200 and a limit of 0 to 1, and refuses `finance_ops` with `PERMISSION_DENIED`.
6. `finance_ops` cannot decide; a malformed id and an unknown id are both `RESOURCE_NOT_FOUND`.
7. `approve` before `contacted` is `CONFLICT`; `contacted` with a blank document is
   `VALIDATION_FAILED` naming `documentReference` and changes nothing.
8. `contacted` records the instant and the reference and audits `user.two_factor_reset_contacted` with
   the office worker as actor; a second contact is `CONFLICT`.
9. `approve` on a contacted request clears the three columns, records who decided, leaves the account
   `active`, and audits `user.two_factor_reset` with `method: "office_reset"` and
   `document_reference_present: true`.
10. An approved request cannot be approved again or rejected afterwards; a decided request leaves the
    queue; the account has no factor to reset until it enrols, after which a new request is written.
11. `reject` without a note is `VALIDATION_FAILED` naming `note`; with a note it records who, when and
    why and audits `user.two_factor_reset_rejected`.

## Verification

- `node lib/auth/verify.ts`: **996 checks** (912 before this STEP). One deliberate mutation
  (`backup_code_hashes.length` expected 1 instead of 0) failed the gate, so the new checks bite.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **126 source files**, env,
  config, i18n **199 messages / 6 placeholders**, logger 117, errors 196, lint 77 checks / 26 rules,
  shell **174 checks / 35 files**, jobs 110, migrations **2 475 checks / 84 migrations / 72 tables**,
  type check, lint, build.
- Build output lists `/2fa/reset`, `/office/2fa-reset-requests`,
  `/api/auth/2fa/reset`, `/api/office/2fa-reset-requests` and
  `/api/office/2fa-reset-requests/decision`.
- `node migrations/verify.ts`: 2 475 checks, 84 migrations, 72 tables.
- `npx tsc --noEmit` and `npx eslint .` clean.
- Live probe on port 3000 (stopped afterwards) with a placeholder `.env.local`:
  - `GET /2fa/reset` 200 with the recovery title; `GET /office/2fa-reset-requests` 200 with the
    signed-out sentence; `GET /2fa` and `GET /signin` 200 and both carry the recovery link;
  - `POST /api/auth/2fa/reset` with a short reason -> `422 VALIDATION_FAILED`; with a 6 000 character
    body -> `413 PAYLOAD_TOO_LARGE`;
  - `POST /api/auth/2fa/reset` with a well formed body -> `502 DEPENDENCY_FAILED`, which is this
    sandbox having no Supabase project rather than a code path: validation ran first and the failure
    is mapped to the dependency code, never to a bad form;
  - `GET /api/office/2fa-reset-requests` and `POST .../decision` without a cookie -> `401
    AUTHENTICATION_REQUIRED` before any database call.

## Design notes worth keeping

- The request is anonymous and the answer is flat. Any difference between "we wrote a row" and "we
  did not" turns a recovery form into an account oracle, which section 22 forbids.
- Documents are a `document_reference` string, not an upload. STEP 100 owns the encrypted file
  pipeline; a half pipeline here would be a second place files live. The audit records that a
  reference existed and how long it was, never its text.
- The permission lives in `listTwoFactorResetRequests` and `decideTwoFactorReset`, so the page, the
  routes and any future caller share one rule instead of three.
- The office page is `force-dynamic` and reads the queue on the server, then a small client panel
  performs the actions: the repository forbids the `react-hooks/set-state-in-effect` shape of
  fetching on mount, and the reviewer of a queue should not see it open empty.
- A rejection tells the merchant the request was refused, not the reason; the note stays for the
  office and the audit.
- No `login_attempts` row is written anywhere on this path: none of these actions is a sign in, and
  counting them would let a stranger push an account toward the STEP 045 lock.

## Package request (still open, unchanged)

- add `"check:auth": "node lib/auth/verify.ts"` to `scripts`, and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`. No new dependency is needed through STEP 044.

## Seams for the next STEPs

- **045 (lock):** this path writes no attempts; the lock keeps counting real sign in attempts only.
- **046 (owner alert):** a new reset request is an event the owner should hear about; the audit action
  `user.two_factor_reset_requested` is the hook, and `0084` already carries `company_id`.
- **052/055 (notification and rate limit):** the merchant is told nothing by the platform yet. The
  rate limit of STEP 055 belongs in front of `POST /api/auth/2fa/reset`, which today is bounded only
  by its body size, the reason length and the one-live-request index.
- **100 (document upload):** `document_reference` becomes a foreign key or a signed link to an
  encrypted object; the decision shape does not change.
- **Retention:** decided requests stay in the table as history (the queue reads only live rows), and
  `deleted_at` exists for a future retention job.
