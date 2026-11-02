// path: docs/handoffs/STEP_074_COMPLETED.md
# STEP 074 - Platform general settings screen with compliance calendar for renewals and expiry alerts: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `2baf867`. Previous handoff:
`docs/handoffs/STEP_073_COMPLETED.md`.

## STEP

- **Number and title:** STEP 074 - Platform general settings screen with compliance calendar for
  renewals and expiry alerts (`docs/final/STEP_PLAN_250.md`, the STEP 074 block).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Seventh STEP of the block.
- **Feature list:** section 3 ("appointed responsible compliance officer recorded in platform settings"
  and "cyber insurance record and PCI attestation renewal tracking in a compliance calendar with expiry
  alerts"), section 24 ("super_admin sets the platform logo and all platform information from settings")
  and the section 27 job ("compliance calendar expiry alerts for annual renewals").
- **Depends on:** STEP 012 (`set_row_metadata()`), STEP 036 (`0074_platform_and_audit_policies.sql` and
  the policy shape), STEP 038 (`0068_compliance_items.sql`, the state machine and the stamping guard),
  STEP 044 (`0080_platform_settings.sql`, the key registry), STEP 050 (the device proof), STEP 052
  (trusted devices), STEP 053 (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`), STEP 057
  (`lib/security/csrf.ts`), STEP 063 (the audit trail), STEP 068 (the office shell) and STEP 073 (the
  screen this one sits beside, and the runtime pattern it copies).

## Files

- **Created:** `migrations/0099_compliance_calendar_super_admin.sql`,
  `migrations/0099_compliance_calendar_super_admin.down.sql`, `lib/settings/registry.ts`,
  `lib/settings/service.ts`, `lib/settings/runtime.ts`, `lib/settings/verify.ts`,
  `app/api/office/settings/route.ts`, `app/api/office/compliance-calendar/route.ts`,
  `app/(admin)/settings/page.tsx`, `app/(admin)/settings/platform-settings-form.tsx`,
  `app/(admin)/settings/compliance-calendar-console.tsx`,
  `docs/planning/STEP_074_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_074_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `officeSettings` block and two `office.sectionSettings`
  strings), `components/office/navigation.ts` (the ninth screen, with the role list imported rather than
  restated), `components/office/verify.ts` (nine screens; the settings entry's roles compared with the
  registry's union), `lib/security/csrf.ts` and `lib/auth/request-proof.ts` (both routes on both lists),
  `lib/auth/verify.ts` (two baselines: seventeen browser files, nineteen call sites).
- **Owned paths touched:** `migrations/` (append only), `lib/settings/` (new),
  `app/api/office/settings/`, `app/api/office/compliance-calendar/`, `app/(admin)/settings/`, plus the
  shell, copy and gate files a new screen always touches.

## Database

- **New file:** `0099_compliance_calendar_super_admin.sql` and its rollback, the ninety-ninth migration,
  contiguous after `0098_country_switch_authority.sql`. It creates no table and adds no column, so
  `0068`'s default deny still covers every row.
- **The gap it closes.** `0074` gave `compliance_items` two policies - `compliance_items_compliance_kyc_all`
  and `compliance_items_ceo_select` - and nothing to `super_admin`. Section 2 makes the super
  administrator the role with full control of everything, and this STEP is the screen where that role
  works the calendar, so the absent policy would have turned "full control" into "the desk files it and
  the owner of the platform cannot". `compliance_items_super_admin_all` is one `for all to public`
  policy with `using` and `with check` of `public.current_actor_has_role('super_admin')`, which is the
  same shape every other super administrator policy in the schema has.
- **What it does not touch.** `card_blacklist`, `company_transactions` and `processor_bills` carry the
  same missing-policy shape for the same role. They are deliberately left alone: none of them has a
  super administrator screen yet, and a policy added before the screen it protects is a grant nobody
  tests. The migration's header records that decision and names the three tables.
- **Rollback:** `0099_compliance_calendar_super_admin.down.sql` drops the policy it added and nothing
  else. No row is created, changed or removed by either direction.
- **The substrate this STEP builds on rather than repeats:** `0068` is the calendar table, its guard
  (`active` walks to `expired`, `renewed` or `archived`; a renewal is a new row; `last_alert_at` moves
  forward only; delete is refused) and its expiry index; `0080` and `0081` are the key registry (key
  pattern, frozen keys, no delete, unique live row per key) and its guard.

## Environment

- No new variable.

## Packages

- **No dependency added, removed or changed.** `package.json` and `package-lock.json` are untouched.
- **Package requests still open for the owner:** `check:settings` (`node lib/settings/verify.ts`),
  `check:countries`, `check:approvals`, `check:office`, `check:auth`, `check:security`, `check:gateways`,
  `check:permissions`.
- **The one dependency question this STEP answers without a package:** dates are counted as whole UTC
  days through integer arithmetic in `lib/settings/registry.ts` (`dayNumberOf`, `calendarDayOf`,
  `daysUntil`), so no date library is needed for a calendar of ten-day and one-year windows. A later STEP
  that needs civil-calendar arithmetic across zones (a billing period, a merchant's local month) is the
  one that should ask for a package.

## What was built

- **`lib/settings/registry.ts`** - `PLATFORM_INFORMATION_ROLES` (the super administrator),
  `COMPLIANCE_CALENDAR_MANAGE_ROLES` (the super administrator and the compliance desk),
  `COMPLIANCE_CALENDAR_READ_ROLES` (those two and the CEO) and `PLATFORM_SETTINGS_SCREEN_ROLES` (their
  union, which is what the sidebar reads); six audit names (`platform.settings_updated`,
  `compliance.item_added`, `compliance.item_renewed`, `compliance.item_archived`,
  `compliance.item_expired`, `compliance.alert_sent`); ten setting fields in two blocks - the platform's
  name, legal name, logo path, support email, support phone, website and address, then section 3's
  appointed officer's name, address and the day of appointment - each with its kind, its length, whether
  it is required and what it holds before anybody saves; `settingValueProblemOf`, the one value rule;
  `isCalendarDay`, `dayNumberOf`, `calendarDayOf` and `daysUntil`; the six kinds, four statuses and three
  states with their label keys; and the bounds `0068` enforces.
- **`lib/settings/service.ts`** - `readPlatformInformation` (one query, defaults filled in, the newest
  save named), `savePlatformInformation` (validate every value, refuse an unknown key, write only what
  changed as a compare-and-set on the version it read, refuse a stale form, audit once by key),
  `readComplianceCalendar` (the rows in expiry order, the four counts, `canManage`),
  `addComplianceItem`, `renewComplianceItem` (new row first, then the old one closed as `renewed`),
  `archiveComplianceItem` and `runComplianceCalendarCheck` (expire what lapsed, stamp what is inside its
  own window once, count what moved under it as skipped).
- **`lib/settings/runtime.ts`** - the PostgREST client, the signed trail and the clock, projected from
  the authentication runtime rather than built a second time.
- **`app/api/office/settings/route.ts`** - one action, `save`, CSRF first, the body capped at 8 KiB, the
  device proof over the exact bytes, then the service; every key is checked against the registry, so a
  stale form from an older build cannot write a setting this build does not read.
- **`app/api/office/compliance-calendar/route.ts`** - four actions - `add`, `renew`, `archive`, `check` -
  in the same order of checks, the body capped at 4 KiB, the alert window defaulted to the platform's
  thirty days, and the dates, lengths and window checked against `0068`'s own constants.
- **`app/(admin)/settings/page.tsx`** - the two halves read under their own roles, five answers
  (signed out, neither half, unavailable, ready), and each half rendered only when it answered.
- **`app/(admin)/settings/platform-settings-form.tsx`** - the ten fields in two blocks, one save button,
  the instant the page was rendered sent with the save so a second tab cannot silently overwrite, and a
  refusal worded by the rule and the field's own kind.
- **`app/(admin)/settings/compliance-calendar-console.tsx`** - today, the three counts, the check button
  with its answer, the list ordered by expiry, one panel per item (renew with a new expiry, archive) and
  the filing form; `canManage` hides what the service would refuse.
- **`lib/settings/verify.ts`** - the gate.

## Behaviour Proof (acceptance checklist)

- **The platform information is the super administrator's alone.** `ceo`, `compliance_kyc`,
  `finance_ops`, `support`, `blogger`, `owner` and an account with no role are refused with
  `PERMISSION_DENIED` on the read and on the save; `super_admin` is accepted. A control-account read
  proves the query filters `is_secret=eq.false`, so no secret row is ever loaded into a form.
- **A fresh deployment reads ten defaults.** No row exists, `savedAtEpochMs` is null, every field is
  `isSet: false`, the name shows `KD Solution IT` and the logo shows `/brand/logo.svg`, and the screen
  says so in a sentence rather than pretending somebody chose it.
- **Only what changed is written.** Saving the value a row already holds writes nothing and audits
  nothing; changing one field writes one row and one audit entry whose `changed_keys` is exactly that
  key; a change to any `compliance.officer_*` key sets `officer_changed` true; the untouched row keeps
  its version. No update payload ever carries `version`, which the gate proves from the store's record
  of every payload's columns.
- **Every value is checked before it is written.** An unknown key answers `VALIDATION_FAILED
  unknown_key`; an address without an at sign `invalid_format`; an empty required field `required`; 281
  characters of address `too_long`; a logo path that climbs out of the site `invalid_format` (twice over:
  the field's pattern and `requireRelativePath`); `2026-02-30` as the appointment day `invalid_date`.
- **A stale form is a conflict, not an overwrite.** A form older than the newest save answers `CONFLICT
  stale`; a save that another writer overtook between the read and the write answers the same; a form at
  least as new goes through.
- **The calendar is the platform's own book.** Every query filters `company_id=is.null` and
  `deleted_at=is.null`; rows come back ordered by expiry, the nearest lapse first; the counts
  (overdue, due, never warned about, active) are derived from the rows and asserted; the CEO's view has
  `canManage: false`, the desk's `true`.
- **Filing, renewing and archiving follow `0068`.** A filed item starts `active`, trims its text, stores
  an empty reference as null and records the officer as `owner_id`; a renewal files a new period that
  begins on the day the old one ended, closes the old row as `renewed` with its instant, and audits both
  ids; a row that is already renewed or archived answers `CONFLICT closed`; archiving marks rather than
  deletes and a second archive answers `CONFLICT already_archived`.
- **The section 27 check keeps its promises.** Over three active rows it expires the lapsed one, stamps
  `last_alert_at` on the one inside its window and leaves the one that is months away alone, auditing
  one `compliance.item_expired` and one `compliance.alert_sent` with the days remaining; a second run
  expires nothing and warns about nothing, because the stamp moves forward only; a row a person moved
  between the read and the write is counted in `skipped` and not claimed.
- **Desktop and mobile:** the console is one column below `lg` and two columns from `lg` upwards (list
  and panel, the panel first on a phone), the list scrolls inside its card rather than the page, and the
  form's fields are one per row on a phone and two from `sm` upwards - inside the STEP 068 shell, no
  fixed width, no `<main>`, no page-level horizontal overflow.

## Security proof

- **Authentication:** both routes read `readRequestActor()`; the page reads the cached `readOfficeActor()`
  and renders its own refusal if it is ever reached outside the group.
- **Authorisation:** `requireAnyRole` with the registry's own lists in every entry point before the first
  read or write - `PLATFORM_INFORMATION_ROLES` on the read and the save,
  `COMPLIANCE_CALENDAR_READ_ROLES` on the read, `COMPLIANCE_CALENDAR_MANAGE_ROLES` on the four writes. The
  sidebar entry imports `PLATFORM_SETTINGS_SCREEN_ROLES`, and the office gate compares it with the union
  of the two halves, so the shell cannot offer a screen a section would refuse.
- **Fresh second factor:** `requireFreshReauthentication` on every write (the save, the filing, the
  renewal, the archiving and the check); reading is not a write and a stale account may still read.
- **CSRF and device proof:** both paths are on `CSRF_PROTECTED_PATHS` and on `SENSITIVE_ENDPOINTS`; each
  route checks the token before the session and before the body, caps the body, and refuses an unproven
  device.
- **Input validation:** every value against the kind's rule and the field's length, the kind against the
  six, both dates against a real calendar and against each other, the alert window against `0068`'s
  seven and three hundred and sixty-five, every string against its column's ceiling.
- **Optimistic locking:** per-key and per-row compare-and-set on the version that was read, with a
  read-back that distinguishes a landed write from a lost race; `version` is never in a payload.
- **Row level security:** `platform_settings` is `super_admin` only since `0080`; `compliance_items` is
  the desk's and the CEO's read since `0074`, and `0099` adds the super administrator's own policy, so
  what the service allows and what the database allows agree.
- **Audit:** one entry per action, never more: `platform.settings_updated` with the keys that changed and
  the officer flag, `compliance.item_added` with the kind and the two dates,
  `compliance.item_renewed` with the replacement's id and both expiries, `compliance.item_archived` with
  the status it left, `compliance.item_expired` with the days overdue, and `compliance.alert_sent` with
  the days remaining. No value of a setting is ever written to the trail; only its key.
- **Secrets:** nothing here reads or writes a secret row. The screen renders its values into HTML, which
  is exactly why `is_secret` rows are excluded by the query rather than filtered in the application.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node lib/settings/verify.ts` - **settings gate passed: 551 checks, 10 setting fields, 6 kinds,
  6 audit names** (new).
- `node components/office/verify.ts` - **485 checks, 6 office roles, 9 screens, 7 roles decided** (was
  462 / 6 / 8 / 7).
- `node lib/auth/verify.ts` - **2445 checks** (seventeen browser files that mutate, nineteen call sites;
  was 2425 / 15 / 17).
- `node lib/security/verify.ts` - 2376 checks.
- `node lib/jobs/verify.ts` - 110 checks.
- `node lib/gateways/verify.ts` - 467 checks.
- `node lib/approvals/verify.ts` - 536 checks.
- `node lib/permissions/verify.ts` - 425 checks.
- `node lib/countries/verify.ts` - 467 checks.
- `npm run check:migrations` - **2902 checks, 99 migrations, 76 tables** (was 2882 / 98 / 76).
- `npm run check:i18n` - **790 messages, 51 placeholders, 1 locale** (was 653 / 36).
- `npm run check:structure` - 17 directories, 14 root files, **224 source files** (was 215).
- `npm run check:shell` - **331 checks, 81 files** (was 311 / 76).
- `npm run check:env`, `check:config`, `check:logger`, `check:errors`, `check:lint`, `check:jobs` - green.
- `npm run build` - compiles; `/settings`, `/api/office/settings` and `/api/office/compliance-calendar`
  are all dynamic.
- **Runtime smoke:** with the local `.env.local` (git ignored, development placeholders) and
  `npm run dev -- -p 3104`, `/settings` answered `307` to `/signin` for an anonymous visitor, and both
  `POST /api/office/settings` (`{"action":"save","values":{}}`) and
  `POST /api/office/compliance-calendar` (`{"action":"check"}`) answered `422 VALIDATION_FAILED` with the
  CSRF field on the details list - the guard refusing before the body is read.

## Known limitation, recorded rather than hidden

- **The expiry alert is stamped and audited, not sent.** `runComplianceCalendarCheck` does the two
  things this module owns - the state the calendar reaches and the record that a warning was due - and
  stops there. The platform still has no mail transport: `email_send_logs` exists, `lib/jobs` has no
  database store, and inventing a fourth sender here would be a fourth place to send mail from. What is
  needed to close it: a job registered with `registerJob` (section 27's scheduler), a store for
  `lib/jobs` beyond memory, and a sender that reads `last_alert_at` - each of which is its own STEP. The
  handoff names it so the omission is a decision with a date rather than a gap nobody noticed.
- **The check is a button before it is a timer.** The screen offers "Run the check" to the two desks that
  may write, because a deployment without a scheduler has to be able to do what the job will do. The
  gate proves the function; the schedule that calls it is still owed.
- **The logo is a path, not an upload.** `platform.logo_path` holds a rooted path such as
  `/brand/logo.svg`, because the platform's own content policy allows images from `'self'`, `data:` and
  `blob:` and a remote URL would be a broken image in every browser. An operator places the file in
  `public/brand/`; section 32's file storage is the STEP that can replace the path with an upload.
- **The officer's name and address start empty.** Both are required when submitted, and both default to
  nothing, because a fresh deployment has not appointed anybody yet and inventing a name would be worse
  than an empty field the screen explains.
- **The calendar is the platform's own.** `0068` allows a `company_id`, and every query here filters
  `company_id=is.null`: a merchant's own insurance certificate is that merchant's document, and the desk
  screen is not the place it would be read.
- **A `PERMISSION_DENIED` refusal still arrives without its details** in the response envelope, as in
  STEPs 069-073; the console therefore words a `403` as "prove your second factor again" only when the
  envelope carries `reauth_required`.

## Deployment checks a person runs

1. Apply `0099_compliance_calendar_super_admin.sql`; confirm `pg_policies` lists
   `compliance_items_super_admin_all` on `compliance_items` with both `using` and `with check`.
2. Sign in as the super administrator and open `/settings`: the platform information shows the defaults,
   the sentence about defaults, and the empty calendar.
3. Change the platform name and the appointed officer's name and address, save, and confirm
   `platform_settings` holds those keys with `updated_by` set and `version` at 1, and that
   `platform.audit_logs` (or the audit table of the deployment) holds one `platform.settings_updated`
   entry naming exactly the changed keys.
4. Save again without changing anything: no new row, no new audit entry, no version movement.
5. File the cyber insurance policy and the PCI attestation with their issue and expiry days: both appear
   in the list, ordered by expiry, with their state badges.
6. Press "Run the check": the counts change, a lapsed row turns `expired`, a row inside its window gets
   `last_alert_at`, and the trail holds one `compliance.item_expired` and one `compliance.alert_sent`.
7. Press it a second time: nothing expires, nothing is stamped, nothing is recorded.
8. Renew the attestation with the next year's expiry: a new `active` row appears with `issued_on` equal to
   the old expiry, the old row turns `renewed` with `renewed_at`, and one `compliance.item_renewed` entry
   names both ids.
9. Sign in as the CEO and open `/settings`: the calendar is readable, the forms are absent, and the
   sentence says why. Sign in as `compliance_kyc`: the calendar works and the platform information is not
   offered. Sign in as `support`: no sidebar entry, and `/settings` shows the refusal panel.

## Next

STEP 075 - announcements. The seams this STEP leaves: `lib/settings/runtime.ts` is the one-line pattern
for a runtime that needs the store, the trail and a clock;
`app/api/office/compliance-calendar/route.ts` is the model for a route with several actions that answers
the whole screen; `lib/settings/verify.ts` is the model for a gate over an in-memory PostgREST that also
records every update payload; and the two path lists this STEP extended are what make a new mutating
route protected. The alert delivery named above is still the open thread for whichever STEP owns jobs.
