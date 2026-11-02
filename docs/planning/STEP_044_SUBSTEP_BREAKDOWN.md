// path: docs/planning/STEP_044_SUBSTEP_BREAKDOWN.md
# STEP 044 sub-step breakdown

Feature: **two factor reset flow after email contact and document verification**
(`docs/final/STEP_PLAN_250.md` line 594), from section 22's recovery sentence.
Owner of the paths below: STEP 044 only (auth STEPs 037-055 own `app/(auth)/`, `app/api/auth/`,
`app/office`, `app/api/office`, `lib/auth/`, plus their own migration numbers).

## 1. Read the ground first, then check it

- `docs/final/FEATURE_LIST.md` section 22: an account with a second factor must have a way back; the
  merchant contacts the platform by email, supplies documents, the office resets the factor, and the
  merchant enrols again after signing in.
- `docs/final/MASTER_PROMPT.md` rules 1-17, `docs/handoffs/STEP_043_COMPLETED.md`, and the STEP 045
  body (the lock that follows this step) so nothing here pre-empts it.
- `git log`, `git status`, `git ls-remote`, every gate - all green at `aeb28a5` after the branch had to
  be recovered from `main` (stash, reset, reinstall, re-run).

## 2. Design decisions taken before writing code

| Question | Decision | Why |
| --- | --- | --- |
| Session for the request? | none | The person asking cannot sign in; that is the premise. |
| Answer for an unknown address? | the same `202` sentence | Otherwise the form is an account directory (section 22). |
| Two requests for one account? | one live row, same answer | A second ask is not a second case for the office. |
| Order of decisions? | `pending` -> `contacted` -> `approved`/`rejected` | The contact record is the evidence a human verified documents; an approval that skips it has none. |
| Documents? | a bounded `document_reference` string | The encrypted upload pipeline is STEP 100; storing a file half way would be a second pipeline. |
| Office roles? | `super_admin`, `ceo`, `compliance_kyc`, `support` | The roles that already decide KYC and merchant support questions. |
| What the reset clears? | `totp_secret_ciphertext`, `totp_confirmed_at`, `backup_code_hashes` | One update, so no instant where a confirmed row has no secret. |
| What it leaves alone? | password, sessions, account status | A factor reset is not a suspension. |

## 3. Owned paths

| Path | Why |
| --- | --- |
| `migrations/0084_two_factor_reset_requests.sql` + `.down.sql` | The request table, its live-key index, the decision constraint and RLS. |
| `lib/auth/two-factor-reset.ts` | `requestTwoFactorReset`, `listTwoFactorResetRequests`, `decideTwoFactorReset`. |
| `app/api/auth/2fa/reset/route.ts` | The anonymous request. |
| `app/api/office/2fa-reset-requests/route.ts` | The queue. |
| `app/api/office/2fa-reset-requests/decision/route.ts` | The three office actions. |
| `app/(auth)/2fa/reset/page.tsx`, `reset-request-form.tsx` | The merchant's screen. |
| `app/office/2fa-reset-requests/page.tsx`, `office-reset-queue.tsx` | The office screen. |
| `app/(auth)/2fa/page.tsx`, `app/(auth)/signin/page.tsx` | The link to the recovery screen. |
| `lib/auth/verify.ts` | `checkTwoFactorReset()` and its in-memory PostgREST. |
| `lib/auth/README.md`, `app/(auth)/README.md`, `app/README.md` | Rules 40-43 and the two new screens. |
| `lib/i18n/strings/en.ts` | The `resetRequest` and `officeReset` groups. |
| `docs/planning/STEP_044_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_044_COMPLETED.md` | This file and the handoff. |

## 4. Sub-steps, in the order they were done

1. **Migration first, with a rollback and a proof.** `0084` creates `two_factor_reset_requests`:
   statuses `pending|contacted|approved|rejected|cancelled`, a trimmed reason of 10-1000 characters,
   a `case status` decision constraint (a decided row names who and when; an undecided row names
   neither), a partial unique index on the two live statuses, the queue and user indexes, the
   `set_row_metadata` trigger and default-deny RLS. Proven on PGlite before any service code:
   33/33 checks, including both directions of the decision constraint and the forward file applying
   again after the rollback.
2. **The service, then the gate.** `requestTwoFactorReset` (anonymous, four indistinguishable
   answers), `listTwoFactorResetRequests` (live statuses only, no address selected, clamped limit),
   `decideTwoFactorReset` (role check first, strict transitions, one update that clears all three
   columns). `checkTwoFactorReset()` drives all of it through a miniature PostgREST that enforces the
   live-key index, then proves the four transitions, the refusals and the cleared columns.
3. **Routes.** One anonymous POST (`202`, no-store, 4 KiB body cap), one office GET and one office
   POST carrying three actions. Body caps and `no-store` on all three; the permission stays in the
   service.
4. **Screens.** `/2fa/reset` (server component, no data, one answer) and
   `/office/2fa-reset-requests` (server read of the queue, client panel for the three actions). Both
   carry the link back to the home page; `/2fa` and `/signin` link to the recovery screen.
5. **Strings, docs, gates, probe, commit.**

## 5. What the gate had to prove

- The form's shape: lowercased address, a ten character floor, no field the merchant must not set.
- Four addresses (unknown, closed, deleted, never enrolled) answer `accepted` and write nothing.
- One request writes one row and one audit entry, with `reason_length` and no address.
- A second request answers the same and writes nothing.
- The queue shows the live rows only, selects no address, clamps its limit, and refuses a role
  outside the office list.
- `approve` before `contacted` is `CONFLICT`; `contacted` without a document is `VALIDATION_FAILED`
  naming the field; a decided request cannot be decided twice.
- An approval clears exactly the three columns and leaves the account open, and is audited as
  `user.two_factor_reset` with `method: "office_reset"` and `document_reference_present: true`.
- After an approval the account has no factor to reset until it enrols again, and then the slot is
  free.
- A rejection demands a note, records who and why, and is audited.
