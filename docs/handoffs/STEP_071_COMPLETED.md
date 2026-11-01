// path: docs/handoffs/STEP_071_COMPLETED.md
# STEP 071 - Permission delegation screen for super_admin: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_070_COMPLETED.md`.

## STEP

- **Number and title:** STEP 071 - Permission delegation screen for super_admin
  (`docs/final/STEP_PLAN_250.md` lines 920-930).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Fourth STEP of the block, and the
  first screen whose subject is a person's authority rather than a queue of work.
- **Depends on:** STEP 013 (`0004_role_assignments.sql`), STEP 014 (`0005_office_permissions.sql` and
  `0006_delegations.sql`), STEP 016 (`ACCOUNT_UNLOCK_OFFICE_ROLES`), STEP 050 (the device proof),
  STEP 052 (trusted devices), STEP 053 (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`),
  STEP 057 (`lib/security/csrf.ts`), STEP 063 (the audit trail), STEP 070 (the office screens pattern)
  and the handoffs of 014, 053, 063 and 070.

## Files

- **Created:** `migrations/0096_office_permission_revoked_by.sql`,
  `migrations/0096_office_permission_revoked_by.down.sql`, `lib/permissions/registry.ts`,
  `lib/permissions/service.ts`, `lib/permissions/runtime.ts`, `lib/permissions/verify.ts`,
  `app/api/office/delegations/route.ts`, `app/(admin)/delegations/page.tsx`,
  `app/(admin)/delegations/delegation-console.tsx`, `docs/planning/STEP_071_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_071_COMPLETED.md`.
- **Modified:** `components/office/navigation.ts` (one entry and the role constant it imports),
  `components/office/verify.ts` (seven screens instead of six, the new orders, the four-section `ceo`
  view unchanged, and the delegation role assertion), `app/(admin)/README.md` (the address table),
  `lib/i18n/strings/en.ts` (one block, 95 messages, plus the two `office.sectionDelegations` keys),
  `lib/auth/request-proof.ts` (one endpoint on `SENSITIVE_ENDPOINTS`), `lib/security/csrf.ts` (one path
  on `CSRF_PROTECTED_PATHS`), `lib/auth/verify.ts` (two baselines: thirteen browser files that mutate,
  fifteen call sites).
- **Owned paths touched:** `app/(admin)/` (STEPs 068-078), `app/api/office/` (an office route),
  `migrations/` (append only), `lib/permissions/` (this STEP's module), the two office components the
  navigation owns, and the one string catalog rule 1 requires. Nothing else.

## Database

- **New file:** `0096_office_permission_revoked_by.sql` and its rollback, the ninety-sixth migration,
  contiguous after `0095_approval_requests.sql`. It changes a table, it does not create one, so the
  default-deny rule of the migrations gate does not apply to it and nothing about RLS moves.
- **Column:** `office_permissions.revoked_by uuid` - the account that ended a delegation early, which
  the table did not record before.
- **Constraints:** `office_permissions_revoked_by_fkey` to `public.users (id)`, and
  `office_permissions_revoked_by_check` (`revoked_by is null or revoked_at is not null`).
  One directional on purpose: every new withdrawal writes both, and a row revoked before this STEP has
  no account to name, so a two-way check would refuse the migration on a database with history.
- **Index:** `office_permissions_expiry_idx` on `expires_at` where `revoked_at is null and deleted_at is
  null and expires_at is not null` - the shape the "ending within seven days" read has.
- **Rollback:** `0096_office_permission_revoked_by.down.sql` drops the index, the check, the foreign key
  and the column with `if exists` guards, and keeps every grant, every `revoked_at` and the audit chain,
  so no authority returns when it runs.

## Environment

- No new variable.

## Packages

- **No dependency added, removed or changed.** `package.json` is untouched.
- **Package request for the owner (open):** add to `scripts` in `package.json`:
  `"check:permissions": "node lib/permissions/verify.ts"`, beside the still-open requests for
  `check:office`, `check:auth`, `check:security`, `check:gateways` and `check:approvals`. Until then the
  gate is run by hand: `node lib/permissions/verify.ts`.

## What was built

- **`lib/permissions/registry.ts`** - the catalog the database cannot hold: sixteen keys in five desks
  (six compliance, four money, two support, one content, three platform), thirteen of them delegable and
  three reserved (`gateway.keys`, `platform.settings`, `delegation.grant`); each key's sentence, the desk
  that holds it by charter, the four windows (7, 30, 90, 180 days), the reason bounds (10 to 280
  characters), `PERMISSION_DELEGATION_ROLES` (one role), the key pattern `0005` itself enforces, and the
  two normalizers a grant needs - a key and an address.
- **`lib/permissions/service.ts`** - `listDelegations`, `grantPermission`, `revokePermission` and
  `effectivePermissionsOf`. A grant runs, in order: the delegation role, a fresh second factor, a known
  key, a delegable key, an address that means something, an active account behind it, not the caller
  themselves, an office role on the account, the key not already held live, a reason worth reading and
  one of the four windows - and only then the insert, the audit entry and the read-back view. A
  withdrawal is a conditional update on `revoked_at is.null` plus the version the read returned, read
  back afterwards, with a lapsed grant refused because the clock already ended it.
- **`lib/permissions/runtime.ts`** - `getPermissionRuntime()`, the `getAuthRuntime()` projection the page
  and the route share, so neither can write without the signed trail.
- **`app/api/office/delegations/route.ts`** - one POST, two actions (`grant` returns 201, `revoke` 200),
  no GET, CSRF first, a 4 KiB ceiling second, the session third, the device proof over the exact bytes
  fourth, the parse last, every failure through the one envelope, `no-store` on both answers.
- **`app/(admin)/delegations/page.tsx`** - the screen, inside the STEP 068 shell and without its own
  `<main>`: the live delegations with the window and the reason, the grant form with the five desks
  described above it, the lapsed list, the last twenty withdrawals with the account that ended each, and
  the three permissions the platform keeps, named rather than silently absent. A signed-out visitor, a
  role that may not be here and an unreadable store each get their own sentence.
- **`app/(admin)/delegations/delegation-console.tsx`** - the two forms. Both sign the body with
  `deviceProofHeaders("POST", "/api/office/delegations", body)` and send `csrfHeaders()`, and both map a
  refusal's rule to a sentence (a typo, a reserved key, a merchant account, the caller themselves, a
  duplicate, a stale address, a short reason, a window outside the four, a lapsed grant, a lost race)
  instead of printing a status code. Each form keeps its own message.
- **`components/office/navigation.ts`** - the `delegations` entry after `gateways`, carrying
  `PERMISSION_DELEGATION_ROLES`.
- **`lib/i18n/strings/en.ts`** - the `officeDelegations` block (95 messages) and `office.sectionDelegations`
  with its description.
- **`lib/permissions/verify.ts`** - the STEP gate: the catalog (sixteen keys, thirteen delegable, three
  reserved, sixteen distinct sentences, five desks), the migration text, the grant, withdrawal and read
  scenarios over an in-memory PostgREST (a grant that works, nine refusals, the duplicate, the lapsed row
  that blocks a new grant, three withdrawal paths including the one that matched no row, and the three
  reads), the route and page contracts, and the copy.

## Behaviour Proof (acceptance checklist)

- **Only the super administrator opens the screen.** `PERMISSION_DELEGATION_ROLES` is one role, the
  navigation imports it and the service checks it first, so the sidebar and the table cannot disagree.
  A CEO and a merchant are both refused, and the gate asserts both refusals through the service.
- **A grant is a window, never a role.** The form offers 7, 30, 90 and 180 days, the service refuses any
  other value, and the row it writes carries `expires_at` - a delegation without an end is not one this
  screen makes.
- **Nothing reserved is handed out.** `gateway.keys`, `platform.settings` and `delegation.grant` are
  refused with `not_delegable`, and the screen prints the three in words, so an operator is not left
  guessing why a permission they know about is missing from the form.
- **A merchant cannot receive office authority.** The account must hold a live office role; the merchant
  in the gate is refused with `not_office_staff`, and a suspended account with `account_inactive`.
- **Nobody hands themselves a permission.** The caller's own address answers `self`.
- **A typed permission is not a permission.** A misspelling is `unknown_permission`, and a row written
  before the catalog existed with a key the platform does not know is dropped by
  `effectivePermissionsOf` rather than returned.
- **One live grant per account and key.** A second grant answers `CONFLICT duplicate` - including when
  the existing grant has already lapsed, because a lapsed row still holds `office_permissions_live_key`.
- **A withdrawal ends the authority and keeps the record.** `revoked_at` and `revoked_by` are written,
  `permission.revoked` is appended, and the row moves to the history list instead of disappearing.
- **A withdrawal that matched nothing is not a success.** If the row moved between the read and the
  write, the read-back finds it still live and the answer is `CONFLICT`, not a silent no-op.
- **A lapsed grant is visible and no longer answers a check.** It is listed under "Ended by time" and
  `effectivePermissionsOf` drops it, so the screen and the permission check agree.
- **Every grant, change and use is audited.** `permission.granted` carries the key, the holder, the
  holder's roles, the window and the reason's length; `permission.revoked` carries the key, the holder
  and both instants. The reason text itself is never copied into the trail.
- **Desktop and mobile:** the lists are cards and definition lists inside the STEP 068 shell (no fixed
  width, no `<main>`, no page-level horizontal overflow), and the console's two forms are single-column
  at every width.

## Security proof

- **Authentication:** the page reads `readOfficeActor()` and the route reads `readRequestActor()`; an
  unknown or missing session never reaches the service.
- **Authorisation:** `requireAnyRole(actor, PERMISSION_DELEGATION_ROLES)` is the first statement of all
  four service functions, so no route, page or job can reach the table by a weaker path.
- **Fresh second factor:** `requireFreshReauthentication` inside `grantPermission` and
  `revokePermission` - handing an authority to a colleague is a sensitive act - and the route requires
  the device proof and a trusted device before it parses the body.
- **CSRF:** `/api/office/delegations` is on `CSRF_PROTECTED_PATHS`, the console sends `csrfHeaders()`,
  and the endpoint is on `SENSITIVE_ENDPOINTS` so the signed proof covers it.
- **Input validation:** the key must be in the catalog, the address is normalized to the shape
  `users_email_format_check` accepts, the reason is 10 to 280 characters after trimming, and the window
  must be one of the four; the body is capped at 4 KiB before parsing.
- **Row level security:** `office_permissions` is default deny since `0005`; every read and write goes
  through the service role, so a stolen browser token cannot enumerate who holds what.
- **No personal data in an error:** a refusal names a field and a rule and never echoes the address that
  was typed, the same rule the CEO home follows for a note.
- **Least privilege by construction:** the catalog is the only list of keys a write can name, and three
  of them cannot be written at all - so "can this be delegated" is a property of the code, not of an
  operator's care.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node lib/permissions/verify.ts` - **permission gate passed: 425 checks, 16 permissions,
  13 delegable, 3 reserved**.
- `node lib/auth/verify.ts` - **2415 checks** (was 2405: thirteen browser files that mutate, fifteen
  call sites).
- `node lib/security/verify.ts` - **2376 checks**.
- `node lib/approvals/verify.ts` - **326 checks**.
- `node lib/gateways/verify.ts` - **467 checks**.
- `node components/office/verify.ts` - **441 checks, 6 office roles, 7 screens, 7 roles decided**
  (was 427 / 6 screens).
- `npm run check:structure` - 17 directories, 14 root files, **207 source files** (was 200).
- `npm run check:migrations` - **2839 checks, 96 migrations, 76 tables** (was 2818 / 95 / 76), every
  forward file transactional and default deny.
- `npm run check:i18n` - **555 messages, 26 placeholders, 1 locale** (was 460 / 24).
- `npm run check:shell` - 293 checks, 72 files.
- `npm run check:env` - `.env.example` matches 16 manifest variables.
- `npm run verify` - the whole chain above, green (structure, env, config, i18n, logger, errors, lint,
  shell, jobs, migrations, typecheck, eslint, build).
- `npm run build` - compiles; `/delegations` and `/api/office/delegations` are dynamic.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders), `/delegations`
  answered `307` to `/signin` for an anonymous visitor, and `POST /api/office/delegations` answered
  `422 VALIDATION_FAILED` with the CSRF field on the details list - the guard refusing the call before
  the body is read.

## Known limitation, recorded rather than hidden

- **`kyc.final_approval` is not in this catalog on purpose.** Section 2 keeps the final KYC decision with
  the CEO, and a super administrator who could hand it out would be overriding the role that signs. The
  CEO's own handover path is `0006_delegations`, which records a delegator and a delegate; it is not
  built yet and belongs to a later STEP.
- **A lapsed grant is not swept.** Expiry is derived at read time, exactly as the approval queue derives
  its own: the row keeps `revoked_at` null until somebody withdraws it, and the live unique key stops a
  replacement grant in the meantime. The screen says so in words, and the cleanup belongs with the job
  that sweeps the approval chain.
- **The reason is shown to the super administrator only.** It is not a secret, but it is a person's
  sentence about a colleague; nothing in this STEP copies it anywhere else, and the audit trail keeps its
  length rather than its text.
- **A `PERMISSION_DENIED` refusal arrives without its details.** The platform envelope keeps `details`
  only for `VALIDATION_FAILED`, so a step-up refusal reaches the console as a bare `403`; the console
  therefore words every `403` as "prove the second factor again", which is correct for every path the
  service can take today. Same limitation STEPs 069 and 070 recorded.

## Deployment checks a person runs

1. Apply `0096_office_permission_revoked_by.sql` and confirm
   `select column_name from information_schema.columns where table_name = 'office_permissions' and
   column_name = 'revoked_by'` returns one row, and that `office_permissions_expiry_idx` exists.
2. Sign in as the super administrator: `/delegations` opens with three empty lists and the three
   reserved permissions named at the bottom.
3. Delegate `kyc.review` to a compliance account for seven days: the grant appears under "Live
   delegations" with a warning badge, and `audit_logs` gains one `permission.granted` row whose payload
   holds `reason_length` and not the sentence.
4. Try the same key for the same account again: the form answers "already holds this permission".
5. Try `gateway.keys`: the service answers that the permission is not handed out from this screen.
6. Try a merchant's address: the form answers that the account holds no office role.
7. Withdraw the grant: the row moves to "Withdrawn recently", `revoked_by` names the super
   administrator, and `audit_logs` gains `permission.revoked`.
8. Sign in as the CEO: `/delegations` is not in the sidebar, and the page itself says the screen belongs
   to the super administrator.

## Next

STEP 072 - the CEO confirmation step for the large payout release, the platform fee change, the reserve
release and the country enable. It writes the decision pairs `0095` already constrains, on the route
shape STEP 070 established, and it is also where the expiry sweep for a lapsed request belongs. The seam
this STEP leaves: `effectivePermissionsOf` is the one function a later screen should call to ask what an
account may do, rather than reading `office_permissions` again.
