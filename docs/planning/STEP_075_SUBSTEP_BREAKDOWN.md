// path: docs/planning/STEP_075_SUBSTEP_BREAKDOWN.md
# STEP 075 - sub-step breakdown

STEP: **Announcement composer, publish flow and popup component with per-user dismiss record**
(FEATURE_LIST section 24, the second sentence; STEP_PLAN_250 section 075).

The STEP is two surfaces and one rule, so it is cut into five sub-steps in the order the work is
verifiable rather than the order it is described.

## Sub-step 1 - read what already exists, and decide there is nothing to migrate

- `0007_announcements.sql`: the row, the draft/publish/expiry columns, the three levels and the three
  audiences.
- `0008_announcement_dismissals.sql`: one row per person per announcement, enforced by
  `announcement_dismissals_key`.
- `0073_office_and_secret_policies.sql`: the five policies - the super administrator's all, the
  audience read, and the two that let a person read and insert their own dismissal.
- Conclusion: no migration. `0100` stays free for the STEP that needs one, and the handoff records
  why the database part of this STEP is nothing.

## Sub-step 2 - the registry and the service

- `lib/announcements/registry.ts`: the writer, the three readers and the screen's union; the six office
  roles an `office` audience means (derived from `PLATFORM_ROLES`); four audit names; the levels,
  audiences and states with their label and hint keys; `announcementStateOf`; the visibility rule
  `isAnnouncementVisibleTo`; the title, body and expiry rules; the day-to-instant conversion.
- `lib/announcements/service.ts`: `listAnnouncements`, `saveAnnouncement`, `publishAnnouncement`,
  `withdrawAnnouncement`, `listActiveAnnouncements` and `dismissAnnouncement`.
- `lib/announcements/verify.ts`: the gate, over an in-memory PostgREST that also enforces `0008`'s
  unique index.

## Sub-step 3 - the copy

- `lib/i18n/strings/en.ts`: the `announcements` block (about seventy strings, composer and popup) and
  `office.sectionAnnouncements` with its description.
- `npm run check:i18n`.

## Sub-step 4 - the route

- `app/api/office/announcements/route.ts`: four actions - `save`, `publish`, `withdraw`, `dismiss` -
  CSRF first, the body capped at 16 KiB, the device proof over the exact bytes, then the service, which
  applies the role per action.
- `lib/security/csrf.ts` and `lib/auth/request-proof.ts`: the path on both lists.

## Sub-step 5 - the screen, the popup and the gates

- `app/(admin)/announcements/page.tsx` and `announcement-composer.tsx`.
- `components/announcements/announcement-popup.tsx`, mounted once by
  `components/office/admin-shell.tsx`, with `app/(admin)/office-announcements.ts` reading the list the
  layout passes down.
- `components/office/navigation.ts`: the tenth screen, with `ANNOUNCEMENT_SCREEN_ROLES` imported rather
  than restated.
- `components/office/verify.ts` and `lib/auth/verify.ts`: the counts that move when a screen and one
  browser file arrive.
- `npm run typecheck`, `npm run lint`, `npm run build`, the runtime smoke, the commit, this document and
  the handoff.
