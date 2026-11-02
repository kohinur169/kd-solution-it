// path: docs/planning/STEP_074_SUBSTEP_BREAKDOWN.md
# STEP 074 - sub-step breakdown

STEP: **Platform general settings screen with compliance calendar for renewals and expiry alerts**
(FEATURE_LIST section 3, section 24 and the section 27 job; STEP_PLAN_250 section 074).

The STEP is one screen with two halves and one database gap, so it is cut into five sub-steps in the
order the work is verifiable rather than the order it is described.

## Sub-step 1 - the database gap, closed by policy

- Read `0068_compliance_items.sql`, `0074_platform_and_audit_policies.sql`, `0080_platform_settings.sql`
  and `0081_password_breach_setting.sql` to see what already exists.
- Find the gap: `0074` grants `compliance_kyc` full control and the CEO a read of `compliance_items`, and
  nothing to `super_admin`, which section 2 makes the role with full control of everything.
- `0099_compliance_calendar_super_admin.sql`: one policy, `compliance_items_super_admin_all`, for the
  super administrator; its rollback drops exactly that policy and loses no row.
- `npm run check:migrations`.

## Sub-step 2 - the registry and the service

- `lib/settings/registry.ts`: the three role lists plus the screen's union, six audit names, ten setting
  fields with their kinds, lengths and defaults, the value rules, the day arithmetic, the six kinds, the
  four statuses, the three states, and the alert window's bounds.
- `lib/settings/service.ts`: read and save the platform information (per-key compare-and-set, audit only
  what changed, optional stale guard), read the calendar with its counts, file, renew, archive, and the
  section 27 check.
- `lib/settings/verify.ts`: the gate, over an in-memory PostgREST.

## Sub-step 3 - the copy

- `lib/i18n/strings/en.ts`: the `officeSettings` block (about eighty strings) and
  `office.sectionSettings` with its description.
- `npm run check:i18n`.

## Sub-step 4 - the two routes

- `app/api/office/settings/route.ts`: one action.
- `app/api/office/compliance-calendar/route.ts`: four actions.
- Both on `CSRF_PROTECTED_PATHS` and on `SENSITIVE_ENDPOINTS`, CSRF before the session and before the
  body, the body capped, the device proof over the exact bytes.

## Sub-step 5 - the screen, the sidebar and the gates

- `app/(admin)/settings/page.tsx`, `platform-settings-form.tsx`, `compliance-calendar-console.tsx`.
- `components/office/navigation.ts`: the ninth screen, with `PLATFORM_SETTINGS_SCREEN_ROLES` imported
  rather than restated.
- `components/office/verify.ts` and `lib/auth/verify.ts`: the counts that move when a screen and two
  browser files arrive.
- `npm run typecheck`, `npm run lint`, `npm run build`, the runtime smoke, the commit, this document and
  the handoff.
