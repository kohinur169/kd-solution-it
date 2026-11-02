// path: docs/handoffs/STEP_073_COMPLETED.md
# STEP 073 - Country enable and disable management screen: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_072_COMPLETED.md`.

## STEP

- **Number and title:** STEP 073 - Country enable and disable management screen
  (`docs/final/STEP_PLAN_250.md`, the STEP 073 block).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Sixth STEP of the block, and the first
  consumer of the approval chain STEP 072 finished.
- **Depends on:** STEP 012 (`set_row_metadata()`), STEP 036 (`0076_reference_countries.sql`, the list,
  the switch and the guard), STEP 050 (the device proof), STEP 052 (trusted devices), STEP 053
  (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`), STEP 057 (`lib/security/csrf.ts`),
  STEP 063 (the audit trail), STEP 068 (the office shell and its navigation), STEP 070 (`requestApproval`
  and the `country_enable` action) and STEP 072 (an approved request, and the sweep a lapsed one needs).

## Files

- **Created:** `migrations/0098_country_switch_authority.sql`,
  `migrations/0098_country_switch_authority.down.sql`, `lib/countries/registry.ts`,
  `lib/countries/service.ts`, `lib/countries/runtime.ts`, `lib/countries/verify.ts`,
  `app/api/office/countries/route.ts`, `app/(admin)/countries/page.tsx`,
  `app/(admin)/countries/country-switch-console.tsx`, `docs/planning/STEP_073_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_073_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `officeCountries` block, two `office.sectionCountries`
  strings and `officeApprovals.countriesSwitchLink`), `components/office/navigation.ts` (the eighth
  screen, with the role list imported rather than restated), `components/office/verify.ts` (eight
  screens; the switch's roles compared with section 3 and with the chain's two desks),
  `lib/security/csrf.ts` and `lib/auth/request-proof.ts` (the route on both lists),
  `lib/auth/verify.ts` (two baselines: fifteen browser files, seventeen call sites),
  `app/(admin)/ceo/page.tsx` (one link from the country counts to the switch), `app/(admin)/README.md`.
- **Owned paths touched:** `migrations/` (append only), `lib/countries/` (new), `app/api/office/countries/`,
  `app/(admin)/countries/`, plus the shell, copy and gate files a new screen always touches.

## Database

- **New file:** `0098_country_switch_authority.sql` and its rollback, the ninety-eighth migration,
  contiguous after `0097_approval_decision_indexes.sql`. It creates no table, so the default-deny rule of
  `0076` already covers the rows it adds columns to.
- **`countries.disabled_reason`** (`text`, nullable) with `countries_disabled_reason_check`: a reason only
  while the country is off, trimmed, ten to two hundred and eighty characters. The switch already had a
  boolean; a closed market without a sentence beside it makes the next person guess, and makes "we closed
  this because of a chargeback wave" indistinguishable from a mis-click.
- **`approval_requests.consumed_at`** (`timestamptz`) and **`consumed_by`** (`uuid`, foreign key to
  `users`), with `approval_requests_consumed_check`: the pair is written together, and only a row whose
  status is `approved` may carry one. This is the spend record: an approval that can be spent twice is
  not an authority.
- **`approval_requests_consumable_idx`**, partial on `(action_type, subject_id)` where `status =
  'approved' and consumed_at is null and deleted_at is null` - the one query the switch makes.
- **Why the spend lives on the request and not the country:** a column on `countries` naming its approval
  would have to be cleared when the market closes - otherwise the reference blocks the next opening - and
  clearing it is exactly what makes an approval spendable again. The spend is a fact about the decision,
  so it is recorded on the decision, once.
- **Rollback:** `0098_country_switch_authority.down.sql` drops the index, the two checks, the two spend
  columns and the reason column, in that order. No country changes state: `is_enabled` was already
  carrying the switch before this STEP, and every flip made after it is in the audit chain.

## Environment

- No new variable.

## Packages

- **No dependency added, removed or changed.** `package.json` is untouched.
- **Package requests still open for the owner:** `check:countries` (`node lib/countries/verify.ts`),
  `check:approvals`, `check:office`, `check:auth`, `check:security`, `check:gateways`,
  `check:permissions`.

## What was built

- **`lib/countries/registry.ts`** - `COUNTRY_SWITCH_ROLES` (the chief executive and the super
  administrator), `COUNTRY_ENABLE_ACTION`, `countrySwitchStateOf` (three states from two flags),
  `countryStateLabelKey`, `enableProblemOf` / `disableProblemOf` / `requestProblemOf` (the three
  refusals as pure functions), `COUNTRY_ENABLED_AUDIT_ACTION`, `COUNTRY_DISABLED_AUDIT_ACTION` and the
  reason's bounds.
- **`lib/countries/service.ts`** - `listCountrySwitches` (the rows, the counts, and one decision per
  row), `enableCountry` (refuse, spend, flip, release on a lost race, audit), `disableCountry` (the
  sentence, the flip, the audit) and `requestCountryEnable` (the chain's own `requestApproval`, with one
  sweep when a lapsed request is what refused the ask).
- **`lib/countries/runtime.ts`** - the PostgREST client, the signed trail and the clock, in one place.
- **`app/api/office/countries/route.ts`** - three actions, CSRF first, the body capped at 4 KiB, the
  device proof over the exact bytes, then the service; every action answers the whole switch.
- **`app/(admin)/countries/page.tsx` and `country-switch-console.tsx`** - the counts, a search box and a
  state filter, the list of every country with its badges, and one panel for the selected country: the
  sanction note or the reason, the decision waiting or the decision ready to spend, and the single turn
  the state allows.
- **`lib/countries/verify.ts`** - the gate.

## Behaviour Proof (acceptance checklist)

- **The list is the platform's own.** Every seeded country is listed with its state, its sanction note
  and its reason; the counts (enabled, disabled, sanctioned, awaiting a signature, ready to open) are
  derived from the rows and asserted.
- **Only the two controllers.** `compliance_kyc`, `finance_ops`, `support`, `blogger`, `owner` and an
  account with no role are refused with `PERMISSION_DENIED` on the read, on both turns and on the ask.
  `super_admin` and `ceo` are accepted on all four.
- **A sanctioned country never opens.** The list offers no opening and no closing, `enableCountry`
  answers `CONFLICT sanctioned` before the first write, `disableCountry` answers the same, and the ask
  answers the same - each with nothing written, no decision spent and no audit entry.
- **An opening spends a decision.** Without an approved request the answer is `CONFLICT
  approval_required`; with one, the switch flips, `consumed_at` and `consumed_by` are written, the
  country's version moves by one, and `country.enabled` names the approval it spent.
- **One decision opens one market once.** A decision already spent is not an authority: the row is not
  offered an opening and the call is refused. A decision spent a moment before another operator's press
  answers `CONFLICT already_used`.
- **A lost flip gives the decision back.** If the switch moved under the caller, the answer is `CONFLICT
  stale`, the country is unchanged, and the decision is released - `consumed_at` and `consumed_by` are
  null again, asserted.
- **A closing needs a sentence.** Nine characters answer `VALIDATION_FAILED invalid_length` and nothing is
  written; a valid one closes the country, stores the trimmed sentence on the row, records the length -
  and never the text - in `country.disabled`, and moves the version by one.
- **An opening can be asked for, once.** Only the super administrator may raise it; the request lands as
  `pending_ceo` with the country's id, the subject type `country`, the label `Name (CC)` and no amount;
  a second ask while the first waits answers `CONFLICT duplicate`.
- **A lapsed request does not block a new one.** When the duplicate check is what refused the ask, one
  sweep of STEP 072's function expires the lapsed row (`approval.expired`) and the ask is tried again
  (`approval.requested`), both on the trail.
- **Desktop and mobile:** the console is one column below `lg` and two columns from `lg` upwards (list
  and panel, panel first on a phone so the selected country is in reach), inside the STEP 068 shell - no
  fixed width, no `<main>`, no page-level horizontal overflow.

## Security proof

- **Authentication:** the route reads `readRequestActor()`; the page reads `readOfficeActor()` and refuses
  on its own if it is ever rendered outside the group.
- **Authorisation:** `COUNTRY_SWITCH_ROLES` is checked in every service entry point before the first read
  or write, and the ask checks the chain's own `requesterRolesOf("country_enable")`. The navigation entry
  imports the same constant, so the sidebar cannot offer the screen to a role the service refuses.
- **Fresh second factor:** `requireFreshReauthentication` on both turns; a stale account reads the list
  (reading is not a turn) and is refused both turns with `reauth_required`.
- **CSRF and device proof:** `/api/office/countries` is on `CSRF_PROTECTED_PATHS` and on
  `SENSITIVE_ENDPOINTS`; the route checks the token before the session and before the body, and refuses
  an untrusted device.
- **Input validation:** the action, the country id, the reason's length and the note's length are checked
  against the same constants the columns use; the body is capped at 4 KiB.
- **Optimistic locking:** the flip is `where id = ... and version = ...` with a read-back, and the spend is
  `where id = ... and status = 'approved' and consumed_at is null` with its own read-back. The payload
  never writes `version`: `set_row_metadata()` owns it.
- **Row level security:** unchanged - `countries` is default deny since `0076`, with `super_admin` all and
  `ceo` update policies; every read and write here goes through the service role, and `0098` adds no
  policy because it adds no table.
- **Audit:** one entry per turn - `country.enabled` with the code, the name, the approval id and the
  instant it was confirmed; `country.disabled` with the code, the name and the length of the reason,
  never its text.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node lib/countries/verify.ts` - **country gate passed: 467 checks, 2 controller roles, 3 states,
  2 audit names** (new).
- `node components/office/verify.ts` - **462 checks, 6 office roles, 8 screens, 7 roles decided** (was
  441 / 6 / 7 / 7).
- `node lib/auth/verify.ts` - **2425 checks** (fifteen browser files that mutate, seventeen call sites;
  was 2415 / 14 / 16).
- `node lib/security/verify.ts` - 2376 checks.
- `node lib/approvals/verify.ts` - 536 checks, 4 actions, 6 statuses, 2 signer roles.
- `node lib/gateways/verify.ts` - 467 checks.
- `node lib/permissions/verify.ts` - 425 checks.
- `npm run check:migrations` - **2882 checks, 98 migrations, 76 tables** (was 2859 / 97 / 76).
- `npm run check:i18n` - **653 messages, 36 placeholders, 1 locale** (was 582 / 26).
- `npm run check:structure` - 17 directories, 14 root files, **215 source files** (was 208).
- `npm run check:shell` - **311 checks, 76 files** (was 300 / 73).
- `npm run check:env` - `.env.example` matches 16 manifest variables.
- `npm run verify` - the whole chain above, green.
- `npm run build` - compiles; `/countries` and `/api/office/countries` are both dynamic.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders), `/countries`
  answered `307` to `/signin` for an anonymous visitor, and `POST /api/office/countries` with
  `{"action":"enable","countryId":"x"}` answered `422 VALIDATION_FAILED` with the CSRF field on the
  details list - the guard refusing before the body is read.

## Known limitation, recorded rather than hidden

- **A closing does not go through the chain.** `0095` closes its action vocabulary at four, and
  `country_disable` is not one of them. That is deliberate and this STEP records the reasoning rather
  than the omission: opening a market is the act the chain exists for, while a sanctions listing, a
  processor outage or a fraud wave is a reason to stop selling today. A closing is still the two
  controllers' act, still needs a fresh second factor and a written reason, and is still audited - but it
  does not queue behind two signatures. A later STEP that wants the chain on the way down adds the fifth
  action to `0095`'s check and to `lib/approvals/registry.ts`, in that order.
- **A country cannot be added or removed here.** `0076`'s guard refuses both: the list is a reference
  list, and a new country is a new migration.
- **The decision is taken on `/ceo`, not here.** The switch screen reads the queue and links to it; the
  two signatures stay on the screen that owns them. The panel therefore says which desk a waiting
  request is on rather than offering a second place to sign.
- **The sweep still has no timer.** `requestCountryEnable` runs `expireLapsedApprovals` once when a
  lapsed request is what refused the ask, so an operator is never blocked by a row nobody swept; the
  scheduled sweep STEP 072 asked for is still owed to whatever owns background work.
- **A `PERMISSION_DENIED` refusal still arrives without its details** in the response envelope, so a
  step-up refusal reaches the console as a bare `403` and the console words a `403` with the
  `reauth_required` rule when the envelope carries it, and as "this screen is not yours" otherwise.
  Unchanged from STEPs 069-072.

## Deployment checks a person runs

1. Apply `0098_country_switch_authority.sql`; confirm `countries.disabled_reason` exists, that
   `approval_requests` has `consumed_at` and `consumed_by`, and that
   `approval_requests_consumable_idx` is listed in `pg_indexes`.
2. Sign in as the super administrator and open `/countries`: the list shows 250 rows, four of them
   sanctioned and off, and the counts add up.
3. Pick a sanctioned country: no button is offered and the sanction sentence is shown.
4. Pick a closed country and send an opening request with a note; `/ceo` shows it at the CEO's desk.
5. Approve it as the CEO, confirm it as the super administrator, then return to `/countries`: the panel
   says an approved decision is ready, and pressing "Open the country" flips the row, moves the counts,
   and clears the pending badge.
6. Check `approval_requests` for that country: `consumed_at` and `consumed_by` are set, and the row's
   `country.enabled` audit entry names it.
7. Close an open country with a nine character reason - refused; with a full sentence - the row turns
   off, `disabled_reason` holds the sentence, and `country.disabled` records its length only.
8. Sign in as `compliance_kyc` and open `/countries`: the refusal panel, and no sidebar entry.

## Next

STEP 074 - general settings and the compliance calendar. The seam: the two path lists this STEP
extended (`CSRF_PROTECTED_PATHS`, `SENSITIVE_ENDPOINTS`) are what make a new mutating route protected,
the office navigation adds one entry per screen with its service's role constant, and
`lib/countries/service.ts` is the model for a screen that reads through a service rather than a table.
