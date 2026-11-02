// path: docs/handoffs/STEP_077_COMPLETED.md
# STEP 077 - Session management screen with revoke actions: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `efb9c91`. Previous handoff:
`docs/handoffs/STEP_078_COMPLETED.md` (077 was implemented after 078, which the plan numbers ahead of
it; the STEP order in `docs/final/STEP_PLAN_250.md` is unchanged).

## STEP

- **Number and title:** STEP 077 - Session management screen with revoke actions
  (`docs/final/STEP_PLAN_250.md`, the STEP 077 block).
- **Category:** Office Dashboards and Permissions, STEPs 068-078.
- **Feature list:** section 22 - "Instant session revocation: every live session is visible to its
  owner, who can end any of them; an office role with the session permission can end one on a
  merchant's behalf; 'sign out everywhere else' ends every session but the current one; the device
  label and its trust are shown; a self revocation is `SIGNED_OUT`, an office revocation is
  `ADMIN_REVOKED`, and every session event is audited." - plus section 23's session events.
- **Depends on:** STEP 054 (`lib/auth/session-list.ts` - `SESSION_MANAGEMENT_OFFICE_ROLES`,
  `listOwnSessions`, `revokeOwnSession`, `revokeOtherOwnSessions`, `listAccountSessions`,
  `revokeAccountSession`; `app/(auth)/sessions/`, `app/office/sessions/`,
  `app/api/auth/sessions/route.ts`, `app/api/auth/sessions/revoke/route.ts`,
  `app/api/office/sessions/route.ts`, `app/api/office/sessions/revoke/route.ts`), STEP 0010
  (`sessions` and its indexes), STEP 050 (the device proof), STEP 052 (trusted devices), STEP 053
  (`requireFreshReauthentication`), STEP 056 (`lib/auth/rest.ts`), STEP 057 (`lib/security/csrf.ts`),
  STEP 068 (the office shell) and STEP 076/078 (the screen and gate patterns this STEP follows).

## What was already there, and what this STEP adds

The rule of section 22 was shipped by STEP 054 and this STEP rewrote none of it:

- the owner's own screen at `app/(auth)/sessions/`, reading `listOwnSessions` and ending a session
  with `revokeOwnSession` (`SIGNED_OUT`) or every other session with `revokeOtherOwnSessions`, which
  is "sign out everywhere else" and keeps the current session;
- the office deep screen at `app/office/sessions?userId=<id>`, ending one session with
  `ADMIN_REVOKED` through `POST /api/office/sessions/revoke`, behind CSRF, the device proof and
  `requireFreshReauthentication`;
- the audit entries `session.list_read_by_office`, `session.revoked_by_office`,
  `session.revoked_by_owner` and `session.others_revoked`.

What was missing is the step a person actually takes first. The deep screen takes an identifier, and
a support worker holding a ticket has an address, not a uuid; the sidebar's `sessions` entry pointed
at that deep screen with no identifier, so every office role that pressed it landed on "no account
named". So this STEP adds the office console that turns an identifier **or an exact address** into the
account, shows its live sessions, and ends one or all of them through STEP 054's route - and points the
sidebar entry at it. `/office/sessions?userId=` still exists and is unchanged.

## Files

- **Created:** `app/(admin)/account-sessions/session-console.ts`,
  `app/(admin)/account-sessions/page.tsx`, `app/(admin)/account-sessions/office-session-console.tsx`,
  `components/office/sessions-verify.ts`, `docs/planning/STEP_077_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_077_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `officeAccountSessions` block, 48 keys, and the
  `office.sectionSessionsDescription` sentence, which now says the screen takes an address),
  `components/office/navigation.ts` (the `sessions` entry's `href`: `/office/sessions` ->
  `/account-sessions`; its roles are still the imported `SESSION_MANAGEMENT_OFFICE_ROLES`),
  `components/office/verify.ts` (one assertion: the entry opens `/account-sessions`; checks 544 -> 545),
  `lib/auth/verify.ts` (the browser mutation baselines: 19 files / 21 call sites -> 20 / 23).
- **Owned paths touched:** `app/(admin)/account-sessions/` (new), `components/office/` (navigation and
  the new gate), plus the copy file a new screen always touches.

## Database

- **No migration.** This STEP reads two indexes that already exist, which is why the set still ends at
  `0101`:
  - `users_email_key` - `create unique index users_email_key on public.users (email)` in `0003` - is
    the address lookup: one row or none, on an index, whatever case the officer typed.
  - `sessions_user_idx` - `create index sessions_user_idx on public.sessions (user_id, revoked_at)
    where deleted_at is null` in `0010` - is the live-session read `listAccountSessions` performs.
- **No table, column, policy or data change.** The writes are STEP 054's `sessions.update` with
  `revoked_at` and `ADMIN_REVOKED`; `sessions` keeps `default_deny`.
- **Migration number after this STEP:** `0102` is still free.

## Environment

- No new variable. The page reads through the authentication runtime, which already validates the
  seven boot variables.

## Packages

- **No dependency added, removed or changed.** `package.json` and `package-lock.json` are untouched.
- **Package requests open for the owner:** `check:account-sessions`
  (`node components/office/sessions-verify.ts`), `check:account-unlocks`, `check:audit-log`,
  `check:announcements`, `check:settings`, `check:countries`, `check:approvals`, `check:office`,
  `check:auth`, `check:security`, `check:gateways`, `check:permissions`.

## What was built

- **`app/(admin)/account-sessions/session-console.ts`** - `SESSION_SEARCH_MAXIMUM_LENGTH` (254, the
  longest address the column holds), `subjectKindOf` (an identifier, an address, nothing, or a shape
  this screen refuses - the `0003` format check as a test rather than a constraint), `SessionSubject`,
  `SessionCounts`, `AccountSessionsSnapshot` and `readAccountSessions`, which asks
  `requireAnyRole(SESSION_MANAGEMENT_OFFICE_ROLES)` before its first query, resolves the account by
  `id=eq.` or `email=eq.` with `deleted_at=is.null&limit=1`, returns `null` when nothing carries the
  search, and otherwise hands the read to STEP 054's `listAccountSessions` unchanged and counts its
  answer. An empty or malformed search is `VALIDATION_FAILED` with `{field: "account", rule}` and reads
  nothing.
- **`app/(admin)/account-sessions/page.tsx`** - the shell screen: a plain `GET` form of one field
  (`q`) back to `/account-sessions`, so the search is in the address and can be handed on; the states
  are signed out, forbidden, empty (nothing searched yet), the wrong shape, no account, unavailable and
  ready; when ready it prints the account (name, address, identifier, company), the counts sentence and
  the console. The page names no role: the module does.
- **`app/(admin)/account-sessions/office-session-console.tsx`** - one row per live session (labelled
  device, standing, started, last seen, expires) with `End this session`, and one panel that ends every
  session in turn behind a confirmation checkbox. Each request is its own POST of
  `{userId, sessionId}` to `/api/office/sessions/revoke` with the CSRF token and the device proof;
  `403` with `reauth_required` links to `/reauth`, `403` without it is the role, `404` is a session
  somebody already ended, `429` carries its wait, and a failed bulk run says how many were ended
  rather than reporting success.
- **`components/office/sessions-verify.ts`** - 269 checks: the constants and the search shapes
  (including 254 accepted and 255 refused), the refusals with zero queries and zero audit entries, the
  resolution by identifier and by address (lower cased, `limit=1`, `deleted_at=is.null`, deleted
  accounts resolving to nothing), the snapshot over STEP 054's rows (order, device flags, no `current`
  row, counts, the single `session.list_read_by_office` entry), the sources (page, console, navigation
  and the deep screen it opens; no role literal in a screen; two fetch sites, both the revoke route; no
  new endpoint), the copy block both ways, and the two indexes that make a migration unnecessary.
- **`components/office/navigation.ts`** - the `sessions` entry now opens `/account-sessions`; its
  label, description and imported role list are unchanged in kind, and the description now says the
  screen takes an address.

## Behaviour Proof (acceptance checklist)

| Section 22 requirement | Where it is satisfied | Proven by |
| --- | --- | --- |
| The owner sees their own live sessions and ends any of them | `app/(auth)/sessions/` (STEP 054) with `listOwnSessions` and `revokeOwnSession` | STEP 054's gate; untouched here |
| "Sign out everywhere else" keeps the current session | `revokeOtherOwnSessions` behind `/api/auth/sessions/revoke` (STEP 054) | STEP 054's gate; untouched here |
| An office role ends a session on a merchant's behalf | `/account-sessions` -> `POST /api/office/sessions/revoke` -> `revokeAccountSession` | `sessions-verify` (sources, refusal and snapshot checks) |
| Device label and trust are shown | the console's device and standing columns, from `SessionView` | `sessions-verify` (`deviceLabel`, `deviceTrusted`, `deviceRevoked`) |
| A self revocation is `SIGNED_OUT`, an office one `ADMIN_REVOKED` | STEP 054's service writes both reasons | `sessions-verify` asserts the module writes neither and calls no update |
| Every session event audited | `session.list_read_by_office`, `session.revoked_by_office` (STEP 054), `session.revoked_by_owner`, `session.others_revoked` | `sessions-verify` (one entry per read, named officer and account) |
| The screen is usable at desktop and mobile widths | the shell page, the form stacking at `sm`, the table in an `overflow-x-auto` | manual width check listed below |

## Security proof

- **The role is asked before the first query**, with STEP 054's constant imported rather than
  restated, so "no account here carries that address" cannot be used to probe whether an address
  exists. The gate proves four refusals read nothing and audit nothing.
- **The screens hold no rule.** Neither the page nor the console names a role, a reason code or an
  update: the read is `listAccountSessions`, the write is STEP 054's route.
- **The write carries the three guards of STEPs 050, 053 and 057**: the device proof, the fresh
  reauthentication and the CSRF token, with the route's own 1024-byte body cap and rate limit.
- **No new endpoint.** `app/api/office/account-sessions` does not exist, and the gate asserts it.
- **The search is bounded and shaped** before it reaches the database: an identifier pattern, an
  address pattern and a 254 character ceiling.
- **The reads are indexed**: `users_email_key` for the lookup, `sessions_user_idx` for the list.

## Verification

- `node components/office/sessions-verify.ts` - **269 checks passed** (new).
- `node components/office/verify.ts` - **545 checks, 6 office roles, 12 screens, 7 roles decided**
  (was 544; one assertion added for the entry's new `href`).
- `node lib/auth/verify.ts` - **2455 checks**, browser mutation baselines now **20 files / 23 call
  sites** (was 19 / 21: this screen posts twice).
- `node lib/security/verify.ts` 2376, `node lib/audit-log/verify.ts` 735,
  `node lib/settings/verify.ts` 551, `node lib/announcements/verify.ts` 351,
  `node lib/approvals/verify.ts` 536, `node lib/countries/verify.ts` 467,
  `node lib/gateways/verify.ts` 467, `node lib/permissions/verify.ts` 425,
  `node lib/jobs/verify.ts` 110, `node lib/errors/verify.ts` 202 - all unchanged.
- `npm run -s verify` - **exit 0**: structure 248 files, env 16 variables, config 28 values, i18n 1052
  messages / 96 placeholders, logger 117, errors 202, lint rules 77, shell **383 checks / 97 files**,
  jobs 110, migrations **2942 checks / 101 migrations / 76 tables**, typecheck, eslint, and a clean
  `next build` with `/account-sessions` listed as dynamic.
- **Dev smoke** on port 3105: `/account-sessions`, `?q=ada%40example.test` and `?q=<uuid>` each answer
  **307 -> /signin** without a session; `POST /api/office/sessions/revoke` without a CSRF token answers
  **422** with `{field: "csrf", rule: "csrf_token_invalid"}`.
- Per-role screens after this STEP (the entry's roles did not change): super_admin 12, ceo 9,
  compliance_kyc 6, finance_ops 1, support 5, blogger 1, owner 0.

## Known limitation, recorded rather than hidden

- **The bulk action is one request per session, not one request.** Each revoke is its own audited act,
  so a batch is a sequence; if the third of five fails, the first two stay ended, the last two stay
  live, and the screen says "2 of 5" instead of claiming success. There is no endpoint that could make
  this one transaction without inventing a new audit entry, and this STEP adds no endpoint.
- **The search is an identifier or an exact address.** A name search is a different permission -
  finding people rather than helping one - and is deliberately not offered.
- **`current` is always false on this screen.** The office list is another account's sessions, so no
  row can be the officer's own device; STEP 054's own screen carries the "this device" marker.
- **The officer's own sessions are not on this screen.** An office role ends its own session on
  `/sessions`, the owner's screen, exactly as a merchant does.
- **`/office/sessions?userId=` is still reachable** and is unchanged; the sidebar no longer points at
  it because it needs an identifier the office usually does not have.

## Deployment checks a person runs

1. Apply nothing: this STEP adds no migration. Confirm `0101` is the newest applied file.
2. Sign in as `support` with a second factor, open **Account sessions** from the sidebar, and search
   the address of a seeded merchant: the account, its company and its live sessions appear.
3. End one session, then sign in as that merchant on the device: the next request signs it out. In the
   audit log, check `session.revoked_by_office` names the officer, the session and
   `reason: ADMIN_REVOKED`.
4. Search the same account again: `session.list_read_by_office` is appended with `live_sessions`.
5. Wait out the reauthentication window (STEP 053), then press **End every session**: the screen says
   the second factor must be confirmed and links to `/reauth`; confirm it and repeat, and the merchant
   is signed out everywhere with one audit entry per session.
6. Search an address nobody holds: the screen says so and appends no audit entry. Search `ada` (no
   at sign): the form refuses it without a request.
7. Sign in as `finance_ops`: the sidebar hides the entry, and opening `/account-sessions` by hand says
   the role may not manage sessions.
8. Check both widths: the form stacks under `sm`, and the table scrolls inside its own box rather
   than pushing the shell sideways.

## Next

- **STEP 079 - merchant onboarding wizard shell** (`docs/final/STEP_PLAN_250.md`), which owns
  `app/(dashboard)/onboarding/`. Nothing of it exists yet; `app/(dashboard)/` holds only its README,
  so 079 starts from the migration and service question the same way this STEP did.
- The other open requests are unchanged: the package scripts listed above, and the deployment checks
  of STEPs 074-078, which still need a real project.
