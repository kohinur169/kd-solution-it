// path: docs/handoffs/STEP_068_COMPLETED.md
# STEP 068 - Admin layout shell with sidebar, topbar and role based navigation: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_067_COMPLETED.md`
(commits `76e32d6` and `4b8973b`).

## STEP

- **Number and title:** STEP 068 - Admin layout shell with sidebar, topbar and role based navigation
  (`docs/final/STEP_PLAN_250.md` line 884).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. This is the first STEP of the
  block, and it owns the frame every later office screen renders inside.
- **Depends on:** STEP 013 (`0004_role_assignments.sql`, the seven roles), STEP 014
  (`0005_office_permissions.sql`), STEP 010 (the root shell, the theme and `check:shell`), STEP 041
  (the two factor enrolment screen at `/2fa`), STEP 045 (the sign in screen at `/signin`), STEP 051
  (`readRequestActor` and the bound session), STEP 052 (`/office/sessions`), STEP 054
  (`/office/2fa-reset-requests`), STEP 062 (the role list constant of the sessions service) and the
  handoff files of 010, 013, 014, 041, 045, 051, 052, 054 and 067.

## Files

- **Created:** `app/(admin)/layout.tsx`, `app/(admin)/office-actor.ts`,
  `app/(admin)/admin/page.tsx`, `components/office/navigation.ts`,
  `components/office/admin-shell.tsx`, `components/office/office-nav.tsx`,
  `components/office/office-access-panel.tsx`, `components/office/verify.ts`,
  `docs/planning/STEP_068_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_068_COMPLETED.md`.
- **Modified:** `app/(admin)/README.md` (the reservation became the shell's documentation),
  `lib/i18n/strings/en.ts` (a new `office` block of 31 messages).
- **Owned paths touched:** `app/(admin)/` and the office components, which the File Ownership Rules
  give to STEPs 068-078, plus the one string catalog rule 1 requires. Nothing else.

## Database

- **Migrations added:** none. The seven roles are `0004_role_assignments.sql` (STEP 013) and the
  delegated permissions are `0005_office_permissions.sql` (STEP 014); this STEP reads them through
  `lib/auth` and writes neither. A table of its own would be a second answer to "which role is this
  account".
- **Rollback verified on clean database:** not applicable - no migration, and the migration gate
  still reports `2766 checks, 93 migrations, 75 tables, every forward file transactional and
  default-deny`.

## Environment

- **Environment variables added to `.env.example`:** none. `.env.example` still matches its 16
  manifest variables.
- **Secrets handled:** none. The shell reads no configuration, and the gate asserts that no file of
  this STEP reads an environment variable.

## Packages

- **Package requests for the integrator:** one, the same shape as the open `check:auth` and
  `check:security` requests: add `"check:office": "node components/office/verify.ts"` to
  `package.json` and call it from `npm run verify`, so the office shell gate runs beside the others
  instead of being remembered.
- Unchanged from STEP 067: a `minimatch` bump for the moderate advisory on the default branch,
  DOMPurify for the rich text allowlist, a pinned-address dispatcher for the SSRF rule, and the
  velocity defaults and retention moving into `config/`.

## What was built

### The decision, and why it is one function

`components/office/navigation.ts` holds the model. `decideOfficeAccess` takes the three states an
account can be in and answers one of five outcomes, in this order:

| the account | the outcome |
| --- | --- |
| no session (`anonymous`) | `sign-in`, and the layout redirects to `/signin` |
| a session that could not be read (`unavailable`) | `unavailable`, and the outage panel renders |
| an office role, plus `owner` or any other grant | `allowed`, with the roles and the screens |
| the `owner` role and nothing else | `denied`, and the refusal panel renders |
| an office role that still owes a second factor | `two-factor`, and the layout redirects to `/2fa` |

The merchant case is refused *before* the second factor question, because section 22 makes TOTP
mandatory for every account that holds a role but the office is not a place a merchant may enrol
into. `officeAccessRedirect` names the two destinations, so the layout and the page cannot disagree
about where a refusal goes.

### The navigation is the services' own rule

`OFFICE_NAVIGATION` has three screens, and each one takes its role list from the constant the
service behind it enforces - `SESSION_MANAGEMENT_OFFICE_ROLES` and
`TWO_FACTOR_RESET_OFFICE_ROLES` are imported, not restated. The workspace index is open to all six
office roles. `OFFICE_ROLES` is derived as `PLATFORM_ROLES` minus `owner`, in the migration's order.

| role | screens offered |
| --- | --- |
| `super_admin`, `ceo`, `compliance_kyc`, `support` | workspace, sessions, reset queue |
| `finance_ops`, `blogger` | workspace |
| `owner` | none - the office refuses the account before a screen is offered |

Only pages that exist are offered: `/admin` (this STEP), `/office/sessions` and
`/office/2fa-reset-requests` (the two office screens of STEPs 052 and 054). The gate resolves every
entry to a `page.tsx` in the app tree, so the office STEPs after this one add their entry in the
commit that adds their page, and the sidebar can never promise a 404.

### The shell

`app/(admin)/layout.tsx` is the gate and the frame; `components/office/admin-shell.tsx` is the
topbar (brand, "Platform office", the role chips of the account and the shared theme switcher), the
sidebar, and one content landmark. `components/office/office-nav.tsx` is the one client boundary:
the same list rendered once, a column from `lg` upwards and a sideways scrolling row below it, with
`aria-current="page"` on the entry that names the current path. `components/office/office-access-panel.tsx`
is the refusal and the outage, rendered *without* the shell so a refused account is never shown a
navigation of destinations it cannot reach.

`app/(admin)/office-actor.ts` reads the account once per request (`cache()`), keeps an
`AUTHENTICATION_REQUIRED` refusal apart from an outage, and rethrows anything that is not an
`AppError`. `app/(admin)/admin/page.tsx` is the workspace index: the roles the account holds, what
each of them may do (the charters of section 2, in the catalog), the screens they open, the approval
chain, and the way home.

`lib/i18n/strings/en.ts` gained the `office` block: 31 messages, ASCII, no placeholder, and the
i18n gate now counts **325 messages** (294 before).

## Behaviour Proof (acceptance checklist)

- **Behaviours named in the STEP title, exercised:**

| behaviour | how it was exercised | observed result |
| --- | --- | --- |
| a shell with a sidebar and a topbar | `AdminShell` rendered with `react-dom/server` for a super administrator and for a blogger | one `<header>`, one `<aside>`, one `<nav>`, one `<main>`; order header, nav, main; 28 rendered checks |
| role based navigation | the model executed for all seven roles, then the same two renders | a super administrator is offered `/office/sessions` and `/office/2fa-reset-requests`; a blogger is offered neither; both are offered the workspace index |
| the current page is announced | the same render, with the path `/admin` | exactly one entry carries `aria-current="page"`, and it is the workspace entry |
| nobody else enters the office | `decideOfficeAccess` for anonymous, unreadable, merchant, officer-without-a-second-factor and officer | `sign-in`, `unavailable`, `denied`, `two-factor`, `allowed` - in that order of precedence |
| the refusal is its own screen | both panels rendered | one main landmark, one heading, no navigation, one way home; the outage carries `role="alert"` and the refusal does not (10 rendered checks) |
| the live route | the dev server on port 3100 | `GET /admin` answered `307` with `location: /signin`; `GET /signin` answered `200`; `GET /office/sessions` answered `200` |

- **UI checks (desktop, mobile, keyboard, light and dark):**
  - *Widths:* one DOM serves both widths - the navigation is `flex ... overflow-x-auto` and becomes
    `lg:flex-col` in a `lg:w-64` sidebar, the body becomes `lg:flex-row`, the content column carries
    `min-w-0` so a wide table cannot push the sidebar off the screen, and the gate refuses an
    arbitrary width (`w-[`), an inline style, and any `hidden`, `aria-hidden` or `tabIndex` in the
    navigation. No pixel measurement was possible: this environment has no browser (the Playwright
    Chromium download is blocked), so the shell was rendered to HTML and its class contract was
    asserted rather than photographed. **That is the one item of the UI checklist this STEP could
    not prove visually**, and it is recorded here rather than claimed; the first STEP that runs in
    front of a browser should open `/admin` at 390 px and 1440 px and confirm what the markup says.
  - *Keyboard:* the rendered order is header, then navigation, then content; every destination is an
    `<a>`, the only button is the shared theme switcher, nothing sets `tabIndex`, no entry carries a
    handler, and the shell adds no focus trap. The skip link of the root layout still targets the
    wrapper around the shell.
  - *Light and dark:* every colour is a semantic token (`surface`, `foreground`, `muted-foreground`,
    `border`, `secondary`, `surface-foreground`) and every one of them is a `light-dark()` pair in
    `styles/tokens.css`, so there is no theme branch in the shell to forget. `npm run check:shell`
    scanned 62 files and found no colour literal and no palette step.
- **API checks:** not applicable - no route handler, and nothing in this STEP mutates. The one
  request the shell makes is `SessionKeeper`'s rotation, which is STEP 051's endpoint.
- **Money flow ledger proof:** not applicable - no money moves.
- **Provider sandbox cycle:** not applicable - no provider is touched.

## Security proof

`node components/office/verify.ts` - **385 checks**: the six office roles derived from the seven,
the three screens and the equality of their role lists with the auth module's constants, the role
matrix for all seven roles plus no role, the merchant grant, two roles and a duplicate, the five
outcomes of the decision in their order, the workspace view of one role, two roles and none, every
navigation entry and both redirect targets resolved to a real page, the layout's one gate and its
thinness (it names no role and compares none), the account reader's three states, the shell's
landmarks and widths, the navigation's single list and accessible name, the panel's own landmark,
and the single file in the tree that names an office role.

**Twenty-six mutation controls, all caught:** a hand written role list on the sessions entry; the
sessions entry borrowing the reset queue's rule; every screen offered to every account; every
account treated as an officer; the second factor asked before the office role; the second factor no
longer required; an anonymous request sent to a page that does not exist; the sessions entry
pointing at a page that does not exist; the workspace index moved off its page; the workspace view
built for an account with no office role; the sidebar dropping the screens beyond the first; the
shell losing its content landmark; the sidebar given a fixed pixel width; the content column no
longer able to shrink; the session no longer rotating; the current entry no longer announced; the
navigation hidden on a phone; a click handler added to the link list; the layout no longer asking
about the account; a refused account rendered inside the shell; an outage reported as signing out;
the refusal offering no way out; the navigation losing its accessible name; the list staying a row
on a wide screen; the enrolment redirect pointing at a page that does not exist; and two roles given
the same charter.

Four render proofs, executed through `esbuild` bundles and `react-dom/server`: the shell for a super
administrator and for a blogger (**28 checks**) and both panels (**10 checks**).

The gate's first pass had six survivors, and each one was a lesson worth keeping: it counted the
words `aria-current` and `<SessionKeeper` in a *docstring*, so deleting the attribute or the
component left the gate green. The assertions are now against code shapes (`{ "aria-current": "page"
as const }`, `<SessionKeeper />`, the exact decision call, the exact `allowed` branch), which is
also why the shell's and the account reader's prose no longer prints landmark tags.

## Verification

- **Typecheck:** `npx tsc --noEmit` - clean.
- **Lint:** `npx eslint .` - clean, 26 rules at error.
- **Build:** `npm run build` - exit 0, and the route table lists `/admin` as a dynamic route beside the existing
  routes.
- **Gates:** `npm run verify` exit 0 - structure 17 directories, 14 root files, **185** sources
  (177 before); env 16 variables; config 10 sections / 28 values; i18n **325** messages;
  logger 117; errors 202 checks / 15 codes; lint 77; shell **258** checks over **62** files (237 and
  54 before); jobs 110; migrations 2766 checks / 93 migrations / 75 tables. `node lib/security/verify.ts`
  2376 checks (unchanged), `node lib/auth/verify.ts` 2385 checks (unchanged), `node
  components/office/verify.ts` 385 checks (new).

## Next

- **Next STEP:** STEP 069, the super_admin dashboard home and the gateway management page with key
  test, enable and disable controls.
- **What the next chat must know:**
  - the shell is at `app/(admin)/layout.tsx` and gates every route in the group; a page under
    `app/(admin)/` needs no permission check of its own, and must not render a second main or
    navigation landmark;
  - a new office screen is three things in one commit: the page under `app/(admin)/<name>/page.tsx`,
    an entry in `OFFICE_NAVIGATION` in `components/office/navigation.ts` whose `roles` is the
    constant the service behind it enforces, and the catalog messages the entry and the page use.
    The gate fails if the entry points at a page that does not exist, which is the intended order;
  - a screen whose service has no role constant yet should get one there first, so the navigation
    imports a rule instead of inventing one;
  - the workspace index (`/admin`) is this STEP's page; the super administrator's dashboard home of
    STEP 069 goes beside it (`/dashboard`), not on top of it;
  - gateway keys are section 6's; `support` may never read one and `blogger` may never reach the
    page at all, which the navigation model already expresses;
  - the one unproven checklist item is the pixel check of the shell at both widths, which this
    environment could not perform.
