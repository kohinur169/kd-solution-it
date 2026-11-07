# STEP 195 — Merchant dispute response form with 24 hour timezone aware deadline

Status: **complete**. One commit, `STEP 195: Merchant dispute response form with 24 hour timezone aware
deadline`, on `arena/ca936761-kd-solution-it`, branched from STEP 194's `e3760fd`. Typecheck, lint and build are
clean, and the STEP's own gate is `services/disputes/dispute-response-verify.ts` at **393 checks**,
mutation-checked with fourteen mutations, all red.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 195: Merchant dispute response form with 24 hour timezone aware deadline**
> Sub-step 4: the core service and logic for the merchant dispute response form and its deadline.

FEATURE_LIST §19: *"Dispute interface: list, status and document upload. Response deadline is 24 hours in the
merchant own time zone; super_admin can set the deadline to 48 hours when needed. The merchant writes the
dispute response and supplies the required documents. Every dispute action is audit logged."*

This STEP owns three of those sentences: the **24-hour window**, the **merchant's response**, and the
**super administrator's 48 hours**. The documents are STEP 197 (there is no upload in this build, and the form
says so), the evidence pack is STEP 197/198, the send is STEP 198, and the warnings are STEP 196.

Eight sub-steps, all done.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `migrations/0124_dispute_response.sql` | new | `disputes.response_saved_at`, `disputes_response_saved_check`, `disputes_guard_response()` and its trigger, the partial index `disputes_response_idx` |
| `migrations/0124_dispute_response.down.sql` | new | The rollback, in the only order that leaves no live trigger pointing at a dropped function |
| `services/disputes/dispute-deadline.ts` | new | The deadline arithmetic in a named zone: the instant, the local reading, the offset, the countdown and whether the zone moved its own clock inside the window. Imports nothing but the window constants, so the browser can run the same code |
| `services/disputes/dispute-response-fields.ts` | new | The two bodies: the response (trimming, CRLF folding, control characters, 20,000 characters) and the extension (24 or 48, whole hours, nothing else) |
| `services/disputes/dispute-response.ts` | new | The three acts: `readCompanyDispute`, `saveDisputeResponse`, `extendDisputeDeadline`, each guarded by role, tenant, state and version, each with one chain entry |
| `services/disputes/dispute-response-verify.ts` | new | The gate, 393 checks, over a fixture that carries `0124`'s trigger and `0039`'s deadline check, plus fourteen mutations |
| `services/disputes/dispute-fields.ts` | edited | The response bounds, the extension, `DISPUTE_DEADLINE_ROLES`, two audit actions and five refusal rules; `DISPUTE_DUE_SOON_HOURS` moved here so the list badge and the countdown read one number |
| `services/disputes/dispute.ts` | edited | The projection carries `response_text` and `response_saved_at`; `DISPUTE_DUE_SOON_HOURS` is imported rather than declared twice |
| `services/disputes/dispute-verify.ts` | edited | The fixture carries `0124`'s column, and the chain assertion moves 123 → 124 |
| `app/api/payments/disputes/[id]/response/route.ts` | new | `POST` — CSRF, the 32 KiB ceiling, the session, the parse, one service call |
| `app/api/office/disputes/[id]/deadline/route.ts` | new | `POST` — CSRF, the device proof over these exact bytes, the session, one service call |
| `app/(dashboard)/payments/disputes/[id]/page.tsx` | new | The merchant's answer page: the row, three states, the deadline on both clocks |
| `app/(dashboard)/payments/disputes/[id]/dispute-deadline-clock.tsx` | new | The client clock: the deadline in the browser's own zone, in UTC, with the countdown and the shifted-dial note |
| `app/(dashboard)/payments/disputes/[id]/dispute-response-form.tsx` | new | The client form: the textarea, the counter, the save, the refusal sentences |
| `app/(dashboard)/payments/disputes/page.tsx` | edited | Each row links to its answer page and marks a saved response |
| `app/(admin)/office/disputes/deadline-extension-form.tsx` | new | The office's one act on a row: extend to 48 hours, signed by the enrolled device |
| `app/(admin)/office/disputes/page.tsx` | edited | The extension panel on a row that can still take it |
| `lib/i18n/strings/en.ts` | edited | 52 strings in the existing `disputes` group, both screens |
| `lib/security/csrf.ts` | edited | The two new browser POSTs on `CSRF_PROTECTED_PATHS` |
| `lib/auth/verify.ts` | edited | The browser mutation inventory: 52 files / 72 call sites → 54 / 74, with the reason written beside it |
| `services/payments/refund-verify.ts`, `refund-execution-verify.ts`, `refund-fee-verify.ts` | edited | The migration-count assertions: the chain's head is 124 now, not 123 |
| `package.json` | edited | `check:dispute-response`, and one link in the `verify` chain |

## The deadline, in one paragraph

Section 19's window is **absolute hours**: `opened_at + 24h`, or `+ 48h` after an extension. It has to be,
because `0039`'s `disputes_due_check` refuses a deadline past `opened_at + make_interval(hours =>
response_window_hours)` — a spring-forward day cannot stretch the window to twenty-five real hours, and a
fall-back day must not shrink it to twenty-three. So **the zone is how the deadline is said, not how it is
counted**: `localDeadlineOf` prints the same instant in the merchant's own zone with its offset (`8 Nov 2026,
15:00 GMT+6`), and `localOffsetShiftOf` reports when the zone moved its own clock inside the window (the dial
reads 25 hours across a spring-forward, 23 across a fall-back, and the deadline did not move). The gate proves
the same instant comes out in Dhaka, New York, Kolkata and UTC, and pins both a spring-forward and a fall-back
window.

The merchant's zone is taken from the browser, not from the row: `business_profiles.country_code` is a country,
not a zone, and there is no timezone column anywhere in the chain (the migration deliberately adds none). The
server prints UTC, the client prints the device's zone beside it, and both lines are labelled.

## The three states a response can be in

| State | What the screen prints | What the service refuses |
| --- | --- | --- |
| Waiting | the form, the counter, the countdown | a body that is empty, too long or carries a control character |
| Sent (`submitted_at`) | "the response is fixed" — the textarea is disabled | `dispute_submitted`, and `0124`'s trigger refuses the write at the database as well |
| Decided (`resolved_at`) | "this dispute is decided" | `dispute_resolved` |
| Closed (`now > response_due_at`) | "the window has closed" | `dispute_deadline_passed` |

The refusals are asked in that order of strength, and every one of them is decided from the **row**, never from
anything the browser sent.

## What the gate proves

| Behaviour | Evidence |
| --- | --- |
| The response is written inside the window | a save six hours out succeeds, stamped with the platform's clock, version 2, one write on `disputes` and nothing else; one minute past the deadline is `CONFLICT`/`dispute_deadline_passed` with the row untouched and nothing logged |
| A sent or decided dispute takes no more words | `dispute_submitted` and `dispute_resolved`, both before the write, both with the fixture's `0124` trigger as the second line of defence |
| A merchant may edit until the window closes | a second save succeeds and moves the version again |
| Tenant scope is in the query | another merchant's dispute is `dispute_not_found`; a non-`owner` role is `PERMISSION_DENIED`; a session without a company writes nothing; a non-uuid id never reaches the database |
| Two tabs cannot both win | a save that another save beat is `dispute_moved` and logs nothing; the same on the office side |
| The extension goes one way | 24→48 moves the window **and** the deadline to `opened_at + 48h`; 24→24, 48→24, 48→48 and 12 are refused |
| One role, with a second factor | `finance_ops`, `ceo`, `compliance_kyc` and a `super_admin` without a satisfied second factor are all `PERMISSION_DENIED`, and none of them moved the row |
| A closed or sent window is never reopened | `dispute_deadline_passed` and `dispute_submitted`; a decided dispute is `dispute_deadline_not_extendable` |
| Every act is in the chain | `dispute.response_saved` (length, saved instant, deadline, window) and `dispute.deadline_extended` (from/to window, from/to deadline) — and `JSON.stringify(payload)` never contains the merchant's words |
| Nothing here writes money | one write, on `disputes`; no `payments`, no ledger, no insert of any kind; the fixture throws on any other table |
| The bodies are read once | trimming, CRLF folding, tabs and newlines kept, markup stored as text, bidi marks kept for RTL merchants, NUL refused, 20,000 in and 20,001 out; unknown keys, wrong types and 48.5 refused |
| The routes are boundaries | CSRF before the session before the service; the 32 KiB / 512 B ceilings; `no-store`; `force-dynamic`; the office route checks the device proof **before** it parses the body; the merchant route carries no proof; neither logs `responseText` |
| The screens exist at both widths | the clock is a client component reading `Intl…resolvedOption().timeZone`, prints local and UTC, ticks and clears its interval, `aria-labelledby` on the panel, `sm:grid-cols-` for the desk; the forms carry `csrfHeaders()`, `credentials: "same-origin"`, `cache: "no-store"` and `router.refresh()`; the office queue never prints `responseText` |
| Every message exists | every `disputes.*` key the six screens ask for is looked up in the catalogue, and the four placeholders the copy uses are asserted |

Fourteen mutations were run against the gate and all fourteen turned it red: the closed window no longer
refusing a save; the second factor check removed; the extension allowed to narrow; the merchant's words copied
into the audit payload; the deadline counted in local hours; an untrimmed response accepted; the read-back after
the write removed; the merchant read losing its tenant filter; a decided dispute accepting a response; a frozen
response being edited; the extension moving the window without the deadline; the merchant route losing its CSRF
guard; the office route losing the device proof; the extension offered on every row.

## Security

- **Validation** — both bodies are strictly parsed with zod (unknown key = refusal), the text is normalised and
  bounded by `disputes_response_check`'s own numbers, and every refusal is an `AppError` whose `details` carry
  `{ field, rule }` so the form maps one rule to one sentence. Ceilings: 32 KiB for a response (20,000 characters
  of escaping prose fits), 512 B for an extension.
- **RLS / tenancy** — only `public.disputes` is read or written. The merchant path carries `company_id=eq.<the
  session's company>` in the query; the office path is one role with no tenant, reading a row by id. No
  `service_role` key is touched by a route.
- **Audit** — two actions, written through `appendTolerated` so a chain outage never drops a merchant's answer;
  the payload carries ids, lengths and instants, **never the words**.
- **Permissions** — `owner` (own company) for the read and the save; `super_admin` **and** a satisfied second
  factor for the extension, behind `requireTrustedDevice` on the route. Office roles other than `super_admin`
  read the queue (STEP 194) but cannot move a deadline.
- **Database, not convention** — `0124`'s `disputes_guard_response()` refuses a change to the pair once
  `submitted_at` or `resolved_at` is set, and `disputes_response_saved_check` keeps the words and the instant
  together inside the window. Both are re-implemented in the gate's fixture, so a service that skipped the
  service-level check would still fail the gate.

## Verification

| Gate | Result at this commit |
| --- | --- |
| `services/disputes/dispute-response-verify.ts` | **passed, 393 checks** (fourteen mutations, all red) |
| `services/disputes/dispute-verify.ts` | passed, 268 checks |
| `services/payments/refund-verify.ts` / `-execution-` / `-fee-` | passed, 259 / 141 / 213 checks |
| `scripts/verify-audit.mjs` | passed, 4100 checks |
| `scripts/verify-structure.mjs` | passed, 17 directories, 14 root files, 724 source files |
| `lib/i18n/verify.ts` | passed, 2950 messages, 309 placeholders |
| `scripts/verify-shell.mjs` | passed, 1078 checks, 342 files |
| `migrations/verify.ts` | passed, 3614 checks, **124 migrations**, 92 tables |
| `lib/errors/verify.ts` / `lib/logger/verify.ts` / `lib/jobs/verify.ts` / `config/verify.ts` / `lib/env` / `scripts/verify-lint-rules.mjs` | passed, 202 / 117 / 110 / 10-32 / 16 / 77 |
| `npm run verify` (whole chain, ending in `tsc`, `eslint .`, `next build`) | passed, compiled |
| **Pre-existing red (unchanged, unchanged reasons)** | `lib/auth/verify.ts` 1 (a fourth module dials), `lib/security/verify.ts` 3 (a probe's own literals, `nmi-client.ts` naming the algorithm), `components/office/verify.ts` 13 (`provisioningQueue` unaccounted for) |

Two exact-count assertions moved because this STEP legitimately adds what they count: `lib/auth/verify.ts`
52→54 browser files and 72→74 mutation call sites (the response form and the extension form), with the reason
written beside them. The migration-count assertions in the three refund gates and in the STEP 194 gate moved
123→124 for `0124`, which is this STEP's.

### Exercised on a running server

`next start` on `0.0.0.0:3100` with the placeholder environment (no database in this sandbox):

| Request | Answer |
| --- | --- |
| `POST /api/payments/disputes/<uuid>/response` (no token) | `422 {"field":"csrf","rule":"csrf_token_invalid"}` — the token is the first guard, before the session and before any row read |
| `POST /api/payments/disputes/<uuid>/response` (a token that does not match its cookie) | the same `422` with the same rule, so the guard compares and does not merely look |
| `POST /api/office/disputes/<uuid>/deadline` (no token) | `422` with the same rule: the device proof and the role are never reached without a session |
| `GET /payments/disputes/<uuid>` signed out | `200`, the page renders with the title *Answer this dispute* and the sentence *"Your session ended. Sign in again."* — a refusal, never an empty form |
| `GET /office/disputes` signed out | `307` to `/signin` from the office layout, the same answer `/office/refunds` gives |

The authenticated paths cannot be walked in this sandbox because there is no Supabase project to issue a
session; they are exercised end to end against the fixture in the gate, which carries `0124`'s trigger and
`0039`'s deadline check. The `.env.local` used for the smoke was deleted again, and `git status` is the STEP's
own file list.

## Carried gaps (not this STEP's, and named rather than hidden)

1. **No document upload.** §19's other half — "the merchant … supplies the required documents" — is STEP 197. The
   form says so in one sentence rather than pretending, and `dispute_response_idx` is the index 197's builder
   will read.
2. **No evidence pack and no send**, so `evidence_ready`/`submitted_at` are still false/null on every row this
   build can produce, and the "sent" state is proven by the gate's fixture rather than by a live act (STEP
   198).
3. **No scheduler.** The deadline is an instant and a printed countdown; nothing emails the merchant at T-4h
   (STEP 196) and nothing escalates after the window closes.
4. **The merchant's zone comes from the browser.** `business_profiles.country_code` is a country, and a country
   is not a zone (`America/Denver` and `America/Chicago` share one). The honest options were a stored zone the
   merchant chooses (a profile STEP's) or the device's own; this STEP takes the device's, prints UTC beside it,
   and says which is which.
5. **No navigation entry** for `/payments/disputes` or `/office/disputes` — the merchant area has no shell of its
   own in this build and the office catalogue treats `provisioningQueue` as unaccounted for already. The list
   page links into the answer page, which is the path a merchant actually needs.
6. **A late response is gone, not drafted.** A save past `response_due_at` is refused and nothing is written;
   there is no "late answer" store, because `0039` has no state for one and section 19 gives the processor the
   answer, not the platform.
7. **The four other providers** still have no dispute reader (STEP 194's gap), so their responses cannot arise
   yet. The form works on any `disputes` row regardless of which provider wrote it.
