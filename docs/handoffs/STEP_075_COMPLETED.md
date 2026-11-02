// path: docs/handoffs/STEP_075_COMPLETED.md
# STEP 075 - Announcement composer, publish flow and popup component with per-user dismiss record: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `fe93288`. Previous handoff:
`docs/handoffs/STEP_074_COMPLETED.md`.

## STEP

- **Number and title:** STEP 075 - Announcement composer, publish flow and popup component with
  per-user dismiss record (`docs/final/STEP_PLAN_250.md`, the STEP 075 block).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Eighth STEP of the block.
- **Feature list:** section 24 - "Announcements: super_admin publishes announcements that appear as
  popups everywhere. A user can dismiss an announcement, and a dismissed announcement does not appear
  again for that user."
- **Depends on:** STEP 014 (`0007_announcements.sql`, `0008_announcement_dismissals.sql` - the two
  tables, their indexes, their triggers and their `default_deny`), STEP 034
  (`0073_office_and_secret_policies.sql` - the five policies), STEP 050 (the device proof), STEP 052
  (trusted devices), STEP 053 (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`), STEP 057
  (`lib/security/csrf.ts`), STEP 063 (the audit trail), STEP 068 (the office shell) and STEP 074 (the
  runtime and gate patterns this STEP copies).

## Files

- **Created:** `lib/announcements/registry.ts`, `lib/announcements/service.ts`,
  `lib/announcements/runtime.ts`, `lib/announcements/verify.ts`,
  `app/api/office/announcements/route.ts`, `app/(admin)/announcements/page.tsx`,
  `app/(admin)/announcements/announcement-composer.tsx`, `app/(admin)/office-announcements.ts`,
  `components/announcements/announcement-popup.tsx`,
  `docs/planning/STEP_075_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_075_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `announcements` block and two `office.sectionAnnouncements`
  strings), `components/office/navigation.ts` (the tenth screen, with the role list imported rather
  than restated), `components/office/admin-shell.tsx` (one prop and one mount of the popup),
  `app/(admin)/layout.tsx` (reads the popup list and passes it down), `components/office/verify.ts` (ten
  screens; the announcements entry's roles compared with the registry), `lib/security/csrf.ts` and
  `lib/auth/request-proof.ts` (the route on both lists), `lib/auth/verify.ts` (two baselines: eighteen
  browser files, twenty call sites).
- **Owned paths touched:** `lib/announcements/` (new), `app/api/office/announcements/`,
  `app/(admin)/announcements/`, `components/announcements/` (new), plus the shell, copy and gate files a
  new screen always touches.

## Database

- **No migration, and that is the finding rather than an omission.** The database part of this STEP was
  built by STEP 014 and STEP 034 and is complete for what section 24 asks:
  - `0007_announcements.sql` is the row - `title` (1..140, trimmed), `body` (1..5000, trimmed), `level`
    (`info|warning|critical`), `audience` (`all|owners|office`), `published_at` nullable, `expires_at`,
    `created_by`, `announcements_expiry_check` (an expiry is after its publish instant),
    `announcements_published_idx`, the `set_row_metadata` trigger and `default_deny`.
  - `0008_announcement_dismissals.sql` is the per-person record - `announcement_id`, `user_id`,
    `dismissed_at`, the **unique index `announcement_dismissals_key` on the pair**, the user index and
    `default_deny`.
  - `0073_office_and_secret_policies.sql` is the five policies - `announcements_super_admin_all`,
    `announcements_audience_select` (published, not expired, the company, and the three audiences with
    the six office roles spelled out), `announcement_dismissals_super_admin_all`,
    `announcement_dismissals_self_select` and `announcement_dismissals_self_insert`.
- **What this STEP deliberately does not add.** No column (a `status` keyword beside `published_at`
  would let the two disagree, which is precisely what `0007`'s header argues against), no table (the
  dismissal record is `0008`), no policy (the five above are exactly the rules the service applies),
  and no index (the popup query is `announcements_published_idx`, and the dismissal lookup is
  `announcement_dismissals_user_idx`).
- **Migration number after this STEP:** `0100` stays free.

## Environment

- No new variable.

## Packages

- **No dependency added, removed or changed.** `package.json` and `package-lock.json` are untouched.
- **Package requests still open for the owner:** `check:announcements`
  (`node lib/announcements/verify.ts`), `check:settings`, `check:countries`, `check:approvals`,
  `check:office`, `check:auth`, `check:security`, `check:gateways`, `check:permissions`.

## What was built

- **`lib/announcements/registry.ts`** - `ANNOUNCEMENT_MANAGE_ROLES` (`super_admin`),
  `ANNOUNCEMENT_READ_ROLES` (`ceo`, `support`, `super_admin`), `ANNOUNCEMENT_SCREEN_ROLES` (the read
  list, which is what the sidebar reads), `ANNOUNCEMENT_OFFICE_AUDIENCE_ROLES` (the six platform roles,
  derived from `PLATFORM_ROLES`); four audit names (`announcement.saved`, `announcement.published`,
  `announcement.withdrawn`, `announcement.dismissed`); the three levels, three audiences and three
  states with their label and hint keys; `announcementStateOf`; `isAnnouncementVisibleTo` (the audience
  rule the service applies because every query goes through the service role); the title, body and
  expiry rules; `endOfDayEpochMs` and `calendarDayOf`; and the bounds 0007 enforces.
- **`lib/announcements/service.ts`** - `listAnnouncements` (the composer's list with four counts and
  `canManage`), `saveAnnouncement` (create a draft, or rewrite one that has never been published),
  `publishAnnouncement` (stamps the instant once), `withdrawAnnouncement` (writes the expiry, which is
  the column `0007` created for it), `listActiveAnnouncements` (the popup query: published, not ended,
  in this person's audience, not dismissed, newest first, capped at three) and `dismissAnnouncement`
  (one row per person, and a duplicate read as "already dismissed" rather than as a failure).
- **`lib/announcements/runtime.ts`** - the PostgREST client, the signed trail and the clock, projected
  from the authentication runtime.
- **`app/api/office/announcements/route.ts`** - four actions, CSRF before the session and the body, the
  body capped at 16 KiB, the device proof over the exact bytes, then the service, which applies the
  role per action: three writes for the super administrator, `dismiss` for any person.
- **`app/(admin)/announcements/page.tsx` and `announcement-composer.tsx`** - the counts, the list of
  every announcement with its state badge, and one panel: the form for a new draft or a draft being
  edited, the words of a published one, and the one action its state allows.
- **`components/announcements/announcement-popup.tsx`** - one banner at a time from a queue, the
  emphasis drawn with semantic tokens, focus landing on the button, Escape closing it the same way,
  and the dismissal posting before anything disappears from the screen.
- **`app/(admin)/office-announcements.ts`** - the cached read of the popup list, which answers an empty
  list on an `AppError` so a courtesy banner can never close the office.
- **`lib/announcements/verify.ts`** - the gate.

## Behaviour Proof (acceptance checklist)

- **The writer is one role, the readers are three.** `compliance_kyc`, `finance_ops`, `owner` and an
  account with no role are refused the composer with `PERMISSION_DENIED`; `super_admin`, `ceo` and
  `support` read it; only `super_admin` writes, publishes and withdraws, and `canManage` is false for
  the other two so the screen offers them no button.
- **A draft is invisible.** `listActiveAnnouncements` never returns a row with no `published_at`, and
  `dismissAnnouncement` answers `RESOURCE_NOT_FOUND` for one - a draft that was never shown cannot be
  closed by somebody who should not know it exists.
- **Publishing is once.** The first publish stamps `published_at`, moves the version by one and records
  `announcement.published` with the level, the audience and the expiry; a second answers `CONFLICT
  published`, and an edit after publication is the same conflict - the words people read are not
  rewritten under them.
- **A lapsed draft cannot be published.** A draft whose stored expiry is already behind the clock
  answers `VALIDATION_FAILED invalid_range` rather than becoming a banner that ends as it appears.
- **Withdrawing stops it without deleting it.** The expiry is written, the row turns `ended`, the entry
  records `days_live`, a second withdrawal answers `CONFLICT ended`, and a draft answers `CONFLICT
  not_published`.
- **The audience rule is the three of `0007`.** Office staff see the office audience and everybody's; a
  merchant sees the merchant audience and everybody's but never an office-only banner; a row written
  for another company is invisible; an ended banner stops for everybody.
- **One page load carries at most three banners**, newest first, and a person who has dismissed one
  does not see it again while everybody else still does.
- **A dismissal is one row.** The first call writes `announcement_id`, `user_id`, the dismissing
  person's company and the instant, and records `announcement.dismissed`; a second call answers
  `recorded: false`, writes nothing, records nothing, and leaves exactly one row - the unique index is
  the rule and the service reads its conflict as "already true".
- **The form and the list cannot disagree.** Every successful write answers the whole snapshot and the
  console refreshes from the server; the id a create produced is found by diffing the snapshot the
  press started from, so a filled form never turns into a second copy.
- **Desktop and mobile:** the composer is one column below `lg` and two columns from `lg` upwards (list
  and panel), the list scrolls inside its card, and the popup is a full-width card at the bottom of a
  phone and a fixed 24rem column from `sm` upwards - inside the STEP 068 shell, no fixed page width, no
  `<main>` in a page, no colour literal.

## Security proof

- **Authentication:** the route reads `readRequestActor()`; the page reads `readOfficeActor()`; the
  popup list is read from the same cached account.
- **Authorisation:** `requireAnyRole` in every service entry point - the manage list on the three
  writes, the read list on the composer, and `PLATFORM_ROLES` on the popup and the dismissal (so a
  client token link, which holds no role, is refused). The sidebar entry imports
  `ANNOUNCEMENT_SCREEN_ROLES`, and the office gate compares it with the registry, so the shell cannot
  offer the screen to a role the service refuses.
- **Fresh second factor:** `requireFreshReauthentication` on save, publish and withdraw; reading the
  composer and dismissing a banner are not.
- **CSRF and device proof:** `/api/office/announcements` is on `CSRF_PROTECTED_PATHS` and on
  `SENSITIVE_ENDPOINTS`; the token is checked before the session and before the body, the body is
  capped, and an unproven browser is refused.
- **Input validation:** title and body against the column's own bounds after trimming, the level and
  the audience against the closed vocabularies, the expiry against a real calendar day, the future and
  a year, and every identifier against `^[A-Za-z0-9-]{1,64}$`.
- **Optimistic locking:** every write is `where id = ... and version = ...` with a read-back, and no
  payload ever carries `version`.
- **Row level security:** unchanged and already correct - `0073` gives the super administrator the
  writes, the audience the read and a person their own dismissal row; this STEP adds no policy because
  the five in place are the rules it applies.
- **Audit:** four names, one entry per action. `announcement.saved` names `created`, the level, the
  audience and whether the headline moved (never the text); `announcement.published` names the level,
  the audience and the expiry; `announcement.withdrawn` names the level, the audience and `days_live`;
  `announcement.dismissed` names the level and the audience. No announcement text is ever written to
  the trail.
- **Markup:** the body is rendered as text (`whitespace-pre-line`), never as HTML, which is what
  `0007`'s column comment requires.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node lib/announcements/verify.ts` - **announcements gate passed: 351 checks, 3 levels, 3 audiences,
  4 audit names** (new).
- `node components/office/verify.ts` - **508 checks, 6 office roles, 10 screens, 7 roles decided** (was
  485 / 6 / 9 / 7).
- `node lib/auth/verify.ts` - **2455 checks** (eighteen browser files that mutate, twenty call sites;
  was 2445 / 17 / 19).
- `node lib/settings/verify.ts` - 551 checks.
- `node lib/security/verify.ts` - 2376 checks.
- `node lib/jobs/verify.ts` - 110 checks.
- `node lib/gateways/verify.ts` - 467 checks.
- `node lib/approvals/verify.ts` - 536 checks.
- `node lib/permissions/verify.ts` - 425 checks.
- `node lib/countries/verify.ts` - 467 checks.
- `npm run check:migrations` - 2902 checks, 99 migrations, 76 tables (unchanged: this STEP adds none).
- `npm run check:i18n` - **868 messages, 58 placeholders, 1 locale** (was 790 / 51).
- `npm run check:structure` - 17 directories, 14 root files, **233 source files** (was 224).
- `npm run check:shell` - **351 checks, 86 files** (was 331 / 81).
- `npm run check:env`, `check:config`, `check:logger`, `check:errors`, `check:lint`, `check:jobs` - green.
- `npm run build` - compiles; `/announcements` and `/api/office/announcements` are both dynamic.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders) and
  `npm run dev -- -p 3105`, `/announcements` answered `307` to `/signin` for an anonymous visitor, and
  `POST /api/office/announcements` answered `422 VALIDATION_FAILED` with the CSRF field on the details
  list for both a `save` and a `dismiss` body - the guard refusing before the body is read. `/settings`
  still answered `307`, so the previous screen is unaffected.

## Known limitation, recorded rather than hidden

- **"Everywhere" is, today, the office.** The popup is mounted by the STEP 068 office shell, which is
  the only shell in the tree; the merchant area has no shell yet. The component takes a list and posts
  to a path, so the STEP that builds the merchant shell mounts the same component and adds the address
  its popup posts to. The service call behind that address - `dismissAnnouncement` - already accepts
  any person with a role, which is why nothing in it changes.
- **Dismissal requires a proven device, because the route does.** `dismiss` shares
  `/api/office/announcements` with the three composer writes, and that path is on
  `SENSITIVE_ENDPOINTS` like every office mutation. A merchant's popup will need its own path so that
  a dismissal does not demand a device the merchant has not enrolled - the reason the popup's call
  site is one function and one path constant.
- **The composer writes platform-wide announcements.** `0007` allows `company_id`, and the visibility
  rule honours it, but the form has no company picker and both queries read `company_id=is.null`, so a
  company-targeted row is out of this STEP's screens. A later STEP that wants one adds the picker; the
  service already resolves the rule for it.
- **A withdrawal is an expiry, not a retraction.** The row keeps `published_at` and gains an
  `expires_at` of now, which is what `0007` designed the column for; there is therefore no way to say
  "withdrawn" apart from "lapsed" beyond the audit entry that recorded the withdrawal.
- **No scheduler anywhere in this STEP.** Nothing needs one: an expiry is a column comparison and a
  dismissal is a row. The section 27 check of STEP 074 is still the only job-shaped function, and it is
  still a button.
- **A `PERMISSION_DENIED` refusal still arrives without its details** in the response envelope, as in
  STEPs 069-074; the popup therefore words a `403` as "prove your second factor again" only when the
  envelope carries `reauth_required`.

## Deployment checks a person runs

1. Confirm `0073` is applied: `pg_policies` lists `announcements_super_admin_all`,
   `announcements_audience_select`, `announcement_dismissals_self_select` and
   `announcement_dismissals_self_insert`, and `pg_indexes` lists `announcement_dismissals_key` as
   unique.
2. Sign in as the super administrator, open `/announcements`, write a headline and a message, save:
   the list shows one draft and the panel switches to editing it.
3. Press "Publish it": the row turns "Showing", `announcements.published_at` is set, and one
   `announcement.published` entry is on the audit trail.
4. Open any other office screen: the banner appears at the bottom of the viewport, in the emphasis of
   its level, with its headline and message as text.
5. Press "Dismiss": `announcement_dismissals` gains one row for this user and this announcement, one
   `announcement.dismissed` entry is recorded, and the banner is gone from every office page.
6. Reload: it does not come back. Sign in as a second office account: it is still shown there.
7. Return to `/announcements` and press "Stop showing it": the row turns "Ended", and the second
   account sees it no more.
8. Sign in as `support`: the composer is read-only (no form, no buttons, the sentence says why), and
   the sidebar still offers the screen. Sign in as `compliance_kyc`: no sidebar entry, and
   `/announcements` shows the refusal.

## Next

STEP 076 - the audit log viewer. The seams this STEP leaves: `lib/announcements/verify.ts` records every
update payload and enforces `0008`'s unique index in its fake store, which is the pattern for a gate
over a table with a rule the service has to read as a value; `app/(admin)/office-announcements.ts` is
the cached reader that answers an empty list on an `AppError`, which is how a courtesy read is kept
from becoming an outage; and `ANNOUNCEMENT_AUDIT_ACTIONS` is the fourth list of audit names this block
has produced, which is what the viewer STEPs 076 and 078 will read from one place.
