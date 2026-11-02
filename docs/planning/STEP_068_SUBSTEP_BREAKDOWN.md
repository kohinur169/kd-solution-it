// path: docs/planning/STEP_068_SUBSTEP_BREAKDOWN.md
# STEP 068 - Sub-step breakdown

STEP 068: **Admin layout shell with sidebar, topbar and role based navigation**
(`docs/final/STEP_PLAN_250.md` line 884), from `docs/final/FEATURE_LIST.md` section 2 (the six office
roles, their separate dashboards, their permission sets and the approval chain) and section 22 (TOTP
is mandatory for every account that holds a role), the first STEP of the Office Dashboards and
Permissions block 068-078.

## What already exists, and what is missing

- `migrations/0004_role_assignments.sql` and `0005_office_permissions.sql` (STEPs 013-014) - the
  seven roles and the delegated permissions, with the platform office roles carrying no company.
- `lib/auth/` (STEPs 037-055) - `readRequestActor`, the actor record with its role list,
  `requireAnyRole`, `isTwoFactorEnrolmentRequired`, and three services that already enforce an
  office role list: `SESSION_MANAGEMENT_OFFICE_ROLES`, `TWO_FACTOR_RESET_OFFICE_ROLES`,
  `ACCOUNT_UNLOCK_OFFICE_ROLES`.
- `app/office/sessions/page.tsx` and `app/office/2fa-reset-requests/page.tsx` - the two office
  screens the authentication block built, each reading the session and its own service.
- `app/(admin)/` - an empty route group with a README: the reservation this STEP fills.
- `components/ui/theme-toggle.tsx`, `components/auth/session-keeper.tsx`, `styles/tokens.css` and
  `scripts/verify-shell.mjs` - the theme, the rotating session, the semantic tokens and the gate
  that refuses a colour literal under `app/` and `components/`.

What was missing is the frame: no office route had a sidebar, a topbar or a role based navigation,
and no single place asked whether the account in front of an office screen may see it - each screen
asked its own service, after it had already rendered its header.

## The decisions this STEP makes

1. **One gate, above every office page.** `app/(admin)/layout.tsx` decides who may be in the office
   at all. A page in the group contains no role check, and a later office STEP cannot forget one.
2. **The decision is a pure function.** `decideOfficeAccess` takes the three states of an account
   and answers one of five outcomes, in one order: no session is the sign in form; an account that
   cannot be read is an outage; an account without an office role is refused; an office account that
   still owes a second factor is STEP 041's enrolment; otherwise it enters with the screens its roles
   open. The gate exercises all five without a request.
3. **A merchant is refused before the second factor question.** Section 22 makes TOTP mandatory for
   every account that holds a role, but an `owner` has no business in the office to enrol into, and
   sending them to an office enrolment screen would suggest otherwise.
4. **One rule per screen, imported rather than restated.** `OFFICE_NAVIGATION` takes each screen's
   role list from the constant its service enforces. A copy would drift, and the drift would be a
   door that opens onto a refusal or a feature nobody can reach.
5. **The office roles are derived, not typed twice.** `OFFICE_ROLES` is `PLATFORM_ROLES` minus
   `owner`, in the order the migration lists, so a seventh office role would appear here by itself.
6. **Every link is a page that exists.** The gate resolves each navigation entry to a `page.tsx` in
   the app tree. The office STEPs after this one add their entry in the commit that adds their page;
   nothing in the sidebar is a promise.
7. **One landmark each, and nothing hidden.** One topbar, one navigation, one content landmark; the
   navigation is a single list reflowed at `lg` from a column to a sideways scrolling row, so no
   entry is duplicated for a phone, hidden behind a menu a keyboard cannot reach, or removed from
   the tab order. `aria-current="page"` is the only thing the browser decides, because only the
   browser knows its own address.
8. **The shell reads nothing.** The account is read once per request (`office-actor.ts`, memoised
   with `cache()`), the decision is a function, and the shell is a React tree with props. That is
   what lets the gate render it and check the markup.
9. **Colour only through tokens, both themes, both widths.** The shell uses `surface`, `foreground`,
   `muted-foreground`, `border`, `secondary` and the shared radius and shadow steps; every one of
   them is a `light-dark()` token, so there is no dark theme branch to forget. No width is fixed in
   pixels and `min-w-0` keeps a wide table from pushing the sidebar off a phone.
10. **A refusal has its own screen.** The two panels are rendered without the shell, so an account
    that was refused is never shown a navigation of destinations it cannot reach, and an outage is
    never dressed as an empty workspace.

## Owned paths

New: `app/(admin)/layout.tsx`, `app/(admin)/office-actor.ts`, `app/(admin)/admin/page.tsx`,
`components/office/navigation.ts`, `components/office/admin-shell.tsx`,
`components/office/office-nav.tsx`, `components/office/office-access-panel.tsx`,
`components/office/verify.ts`, `docs/planning/STEP_068_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_068_COMPLETED.md`.

Edited: `app/(admin)/README.md` (the reservation became the shell's documentation) and
`lib/i18n/strings/en.ts` (the `office` block: 31 messages).

Office STEPs 068-078 own `app/(admin)/` and the office components, so nothing outside those and the
one string catalog is touched. No migration (the roles and the permissions are STEPs 013-014's), no
route handler (nothing here mutates), no `package.json` change.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_067_COMPLETED.md` (committed `4b8973b`), `STEP_PLAN_250.md` line 884 and the block 068-078,
`FEATURE_LIST.md` sections 1, 2, 22 and 24, `MASTER_PROMPT.md` rules 1, 5, 7, 14 and the acceptance
checklist for UI STEPs, `0004`, `0005`, `0010`, `lib/auth/types.ts`, `lib/auth/session.ts`,
`lib/auth/request-actor.ts`, `lib/auth/session-list.ts`, `lib/auth/two-factor-reset.ts`,
`app/layout.tsx`, `app/office/sessions/page.tsx`, `components/ui/theme-toggle.tsx`,
`styles/tokens.css`, `scripts/verify-shell.mjs` and `config/structure.json`.

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

None. The seven roles are `role_assignments` (STEP 013), the delegations are `office_permissions`
(STEP 014), and this STEP decides navigation from the same two tables through `lib/auth`. A new
table here would be a second answer to "which role is this account", and the handoff records that
the office STEPs 071-073 continue from those two tables.

## Sub-step 4 - The core logic

- `components/office/navigation.ts` - the model: `OFFICE_ROLES` (derived), `isOfficeRole`,
  `OFFICE_HOME_PATH` / `OFFICE_SIGN_IN_PATH` / `OFFICE_TWO_FACTOR_PATH`, the `OFFICE_NAVIGATION`
  catalog of three screens with their imported role lists, `officeRoleLabelKey`,
  `officeRoleCharterKey`, `officeRolesOf`, `hasOfficeRole`, `officeSectionsFor`,
  `officeSectionByKey`, `officeSectionByHref`, the `OfficeActorState` and `OfficeAccessDecision`
  types, `decideOfficeAccess`, `officeAccessRedirect` and `officeWorkspaceOf`.
- `app/(admin)/office-actor.ts` - the account of one request, read once, with an outage kept apart
  from anonymity.
- `app/(admin)/layout.tsx` - the gate and the shell.
- `app/(admin)/admin/page.tsx` - the workspace index: the roles held, what each may do, and the
  screens they open.
- `components/office/admin-shell.tsx` - topbar, sidebar, one content landmark, the rotating session
  and the shared theme switcher.
- `components/office/office-nav.tsx` - the one client boundary: the same list in two shapes, with
  `aria-current` for the entry that names the current page.
- `components/office/office-access-panel.tsx` - the refusal and the outage, without the shell.

## Sub-step 5 - Routes and jobs

The group's first route is `/admin` (the workspace index). No route handler and no job: nothing here
mutates, and the office screens that do (sessions, resets, unlocks) already have their handlers in
`app/api/office/` from STEPs 052-054.

## Sub-step 6 - UI

Desktop and mobile are one DOM: a topbar, a sidebar that becomes a sideways scrolling row below
`lg`, and a content column that may shrink. Keyboard order is the document order - topbar, then
navigation, then content - and every control is a link or the shared theme switcher, so there is no
trap, no hidden entry and no handler. Both themes come from the token layer with no conditional
class. What was observed, and what was not, is written in the handoff.

## Sub-step 7 - Security proof

`components/office/verify.ts` (385 checks) executes the model against every role and reads every new
component: the six office roles derived from the seven; the three screens and their imported role
lists; the role matrix for all seven roles plus no role, the merchant grant, two roles and a
duplicate; the five outcomes of the decision in their order, including the merchant who owes a
second factor; the workspace view of one role, two roles and none; every navigation entry resolved
to a real `page.tsx`; the two redirect targets resolved as pages; the layout's one gate and its
thinness; the account reader's three states; the shell's landmarks, widths and tokens; the
navigation's single list, accessible name and `aria-current`; the panel's own landmark and way out;
the page's model; and the single file in the tree that names an office role.

Twenty-six mutation controls, all caught, and four render proofs: the shell rendered for a super
administrator and for a blogger (28 checks: one landmark each, the landmark order, the role chips,
the role filtered links, exactly one `aria-current` on the right entry, the responsive class set, no
inline style and no colour literal) and both panels rendered (10 checks).

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint .`, `node components/office/verify.ts`,
`node lib/security/verify.ts`, `node lib/auth/verify.ts`, `npm run verify`, `npm run build`, the dev
server transcript for the three routes, one commit
`STEP 068: Admin layout shell with sidebar, topbar and role based navigation` on
`arena/1dc51ec3-kd-solution-it`, pushed, with `docs/handoffs/STEP_068_COMPLETED.md`.
