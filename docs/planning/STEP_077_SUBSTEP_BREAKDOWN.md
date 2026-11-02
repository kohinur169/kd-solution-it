// path: docs/planning/STEP_077_SUBSTEP_BREAKDOWN.md
# STEP 077 - sub-step breakdown

STEP: **Session management screen with revoke actions** (FEATURE_LIST section 22, the revocation
sentences: "every live session is visible to its owner, who can end any of them; an office role with
the session permission can end one on a merchant's behalf; 'sign out everywhere else' ends every
session but the current one; the device label and its trust are shown; a self revocation is
`SIGNED_OUT`, an office revocation is `ADMIN_REVOKED`, and every session event is audited", plus
section 23's session events; STEP_PLAN_250 section 077).

The STEP is a screen over a rule that STEP 054 already wrote, so it is cut into five sub-steps in the
order the work is verifiable rather than the order it is described. The first sub-step is the one that
decides whether the other four are needed at all.

## Sub-step 1 - read what already exists, and find the actual hole

- `lib/auth/session-list.ts` (STEP 054): `SESSION_MANAGEMENT_OFFICE_ROLES` (super administrator, chief
  executive, compliance desk, support), `SESSION_LIST_LIMIT` 50, `listOwnSessions`,
  `revokeOwnSession` (`SIGNED_OUT`), `revokeOtherOwnSessions` ("sign out everywhere else"),
  `listAccountSessions` (role check, live filter, audit `session.list_read_by_office`) and
  `revokeAccountSession` (`ADMIN_REVOKED`, audit `session.revoked_by_office`).
- `app/(auth)/sessions/` - the owner's own screen, with `/api/auth/sessions` and
  `/api/auth/sessions/revoke` behind it: the whole merchant half of section 22 already works.
- `app/office/sessions/page.tsx` + `office-session-list.tsx` + `/api/office/sessions/revoke` - the
  office deep screen, ending a session with the CSRF token, the device proof and the fresh
  reauthentication.
- `components/office/navigation.ts` - the `sessions` entry, with the imported role list, pointing at
  `/office/sessions` **without an identifier**: pressing it always landed on "no account named".
- Conclusion: the rule, the acts, the reasons and the audit names all exist and are not rewritten. What
  is missing is the step before the deep screen - naming the account from the one thing a support
  ticket carries, an address - and a sidebar destination that is not a dead end. No table, no column,
  no policy, and no endpoint.

## Sub-step 2 - the database question, answered with "none"

- The lookup is `users.email` under `users_email_key` (`create unique index users_email_key on
  public.users (email)`, `0003`): one row or none, on an index, so an exact address is a read no
  wider than an identifier.
- The list is `sessions_user_idx` (`(user_id, revoked_at) where deleted_at is null`, `0010`), which is
  exactly the filter `listAccountSessions` sends.
- So this STEP adds **no migration**, and the set still ends at `0101`. `npm run check:migrations`
  proves the set; the gate asserts that `0102` is absent and that both indexes are where they were
  created.

## Sub-step 3 - the resolution module

- `app/(admin)/account-sessions/session-console.ts`:
  - `SESSION_SEARCH_MAXIMUM_LENGTH` (254) and `subjectKindOf` - identifier, address, empty, or a shape
    the screen refuses; the `0003` format check as a test rather than a constraint.
  - `readAccountSessions`: `requireAnyRole(SESSION_MANAGEMENT_OFFICE_ROLES)` **before the first
    query**, so an address cannot be probed; `VALIDATION_FAILED` with `{field: "account", rule}` for an
    empty or malformed search, with no query; one `users` read by `id=eq.` or `email=eq.` with
    `deleted_at=is.null&limit=1`; `null` when nothing carries it; then STEP 054's `listAccountSessions`
    unchanged; then the counts over its answer and the read instant.
- `components/office/sessions-verify.ts`: the shapes (254 accepted, 255 refused), the refusals reading
  nothing and auditing nothing, the two lookups, the deleted account, the snapshot over four live
  sessions (order, device flags, no `current`, counts, the single audit entry), and the sources.

## Sub-step 4 - the copy

- `lib/i18n/strings/en.ts`: the `officeAccountSessions` block, 48 keys - the search and its two
  refusals, the account, the counts sentence, the columns, the device standings, the two actions and
  their progress, and each refusal the route can answer with.
- The templated sentences are only ever rendered through `formatMessage`; the gate proves it.

## Sub-step 5 - the screen, the console, the sidebar and the gates

- `app/(admin)/account-sessions/page.tsx`: a plain `GET` form of one field back to the screen, so the
  search lives in the address; the seven states; the account, the counts and the console.
- `office-session-console.tsx`: one row per live session with its own button, and one panel that ends
  every session in turn behind a confirmation checkbox - one guarded POST per session, each its own
  audited act, and a partial run that says how far it got.
- `components/office/navigation.ts`: the `sessions` entry opens `/account-sessions`; the label, the
  description and the imported role list keep their shape, and the description now says the screen
  takes an address.
- `components/office/verify.ts`: one assertion that the entry opens the console (544 -> 545).
- `lib/auth/verify.ts`: the browser mutation baselines move to 20 files / 23 call sites, because this
  console is a new file that posts twice.
- `npm run verify`, `next build`, and a dev smoke on port 3105 (three redirects and one 422).

## What this STEP deliberately leaves out

- **No bulk endpoint.** Each revoke is its own audited act through STEP 054's route; making the batch
  one request would need a new endpoint and a new audit name, and the section asks for per-event
  auditability rather than a transaction.
- **No name search.** Finding people by name is a different permission from helping one person who
  wrote in, so the console takes an identifier or an exact address and nothing else.
- **No second session service.** The read, the write, the reasons and the audit names stay in
  `lib/auth/session-list.ts`; nothing in this STEP duplicates them.
- **No new migration.** The two indexes the screen reads already exist, so `0102` stays free for the
  next STEP that genuinely needs one.
- **No change to the merchant's own screen** (`app/(auth)/sessions/`) or to the office deep screen
  (`app/office/sessions?userId=`), which stay exactly as STEP 054 shipped them.
