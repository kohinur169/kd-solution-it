// path: docs/handoffs/STEP_054_COMPLETED.md
# STEP 054 completed - Session list and instant revoke for owners and office roles

Branch `arena/1dc51ec3-kd-solution-it`, base `ab1a15a` (STEP 053, corrected).
Source: `docs/final/STEP_PLAN_250.md` line 712; `docs/final/FEATURE_LIST.md` section 22 line 244
("instant session revocation ... and audit logging of every session event") and section 2 (the role
list, and "every permission grant, change and use is audit logged").

## What the STEP asks for

Section 22 asks for a person to see the sessions their account is signed in on and to end one
immediately, and for every session event to reach the audit trail. Section 2 puts the same act in the
hands of the office roles, under the rule that a permission *use* is audited as well as a grant.

## Sub-steps, in order

1. **Read the contract** - section 22 line 244 and section 2, `0010_sessions.sql` (columns, indexes,
   the closed revocation vocabulary), `session-rotation.ts` (`revokeSession`,
   `revokeDeviceSessions`, `SessionTokenStore`), the STEP 053 handoff's "Next",
   `two-factor-reset.ts` (the office role list and the permission-inside-the-service pattern) and
   `app/office/2fa-reset-requests/page.tsx` (the four-state read).
2. **Owned paths**, recorded in `docs/planning/STEP_054_SUBSTEP_BREAKDOWN.md` before any code.
3. **Database** - none, and that is a decision: see below.
4. **Service** - `lib/auth/session-list.ts`.
5. **Wiring** - `GET`/`POST` for the owner, `GET`/`POST` for the office, the two signed-endpoint
   entries, the two classified surfaces.
6. **Screens** - `/sessions` and `/office/sessions`, desktop and mobile.
7. **Security proof** - `checkSessionList()` in `lib/auth/verify.ts` and the mutation controls below.
8. **Gates, commit, push, handoff** - this document.

## Database - none, deliberately

`0010_sessions.sql` already stores every fact the list shows and both reasons this STEP writes:

| what the STEP needs | where it already is |
| --- | --- |
| which account a session belongs to, and whether it is live | `sessions.user_id`, `sessions.revoked_at`, `sessions.deleted_at` |
| the device, and its label | `sessions.device_proof_key_id` -> `device_proof_keys.label` |
| when it started, was last seen, and expires | `sessions.issued_at`, `last_seen_at`, `expires_at` |
| the reason an owner ended it | `revocation_reason = 'SIGNED_OUT'` in the `0010` vocabulary |
| the reason an officer ended it | `revocation_reason = 'ADMIN_REVOKED'`, already in the same vocabulary |
| the read | `sessions_user_idx (user_id, revoked_at) where deleted_at is null` |

A migration that re-declared any of this would be the defect STEP 053 nearly shipped and `0091`
corrected. The read every list performs is the one `sessions_user_idx` was created for, so no index
was added either.

## Service - `lib/auth/session-list.ts`

- `listOwnSessions(actor)` - the caller's live sessions, newest first, each with the device label, the
  device's confirmation and revocation state, the three instants and whether it is the session asking.
  There is no account parameter: the filter is the actor's own `userId`.
- `revokeOwnSession({ actor, sessionId })` - one live row of the caller, `SIGNED_OUT`, audit
  `session.revoked_by_owner`, and `wasCurrent` so the screen can send the person to sign in again.
  An id that is not the caller's, or is already revoked, answers `RESOURCE_NOT_FOUND` - the two are
  indistinguishable on purpose.
- `revokeOtherOwnSessions({ actor })` - every live row except the one asking, `SIGNED_OUT`, audit
  `session.others_revoked` carrying `revoked_sessions`, and `0` (with no entry) when there is nothing
  to end.
- `listAccountSessions({ actor, userId })` - the office read, gated by
  `SESSION_MANAGEMENT_OFFICE_ROLES` **inside the service**, audited as `session.list_read_by_office`
  before the rows are returned.
- `revokeAccountSession({ actor, userId, sessionId })` - the office write: the row must belong to
  *that* account, `ADMIN_REVOKED`, audit `session.revoked_by_office` naming the officer as the actor
  and `subject_user_id` as the account.

`SESSION_MANAGEMENT_OFFICE_ROLES` is `super_admin`, `ceo`, `compliance_kyc`, `support` - the same list
the unlock and the 2FA reset already use, and `checkSessionList()` asserts the equality, so a fourth
list cannot appear without a gate failing.

## Wiring

| method | path | what it does |
| --- | --- | --- |
| `GET` | `/api/auth/sessions` | the caller's own list; no account in the request |
| `POST` | `/api/auth/sessions/revoke` | `{ sessionId }` or `{ allOthers: true }`; signed, trusted device, **no** step-up |
| `GET` | `/api/office/sessions?userId=` | one account's list for an office role; role checked in the service |
| `POST` | `/api/office/sessions/revoke` | `{ userId, sessionId }`; signed, trusted device, **and** STEP 053's fresh window |

Both revoke paths join `SENSITIVE_ENDPOINTS` (STEP 050), so the browser signs the exact bytes it
sends; both owner paths join `SESSION_AUTH_SURFACES`, so no unclassified auth route exists. The two
shapes of the owner body are mutually exclusive: a body that both names a session and asks for "all
others" is `422`, not a guess.

## Screens

- `/sessions` - every live session, the current one marked, the device state as a badge, the three
  instants in UTC, a revoke per row and one "end every other session" form. Four states:
  signed out, unreadable, and the list (which may legitimately be a single row).
- `/office/sessions` - an account field, then the same rows with a revoke on each. Five states:
  signed out, forbidden, no account named, unreadable, ready. The page reads through the service, so
  it cannot be a weak path to the same data.
- Both keep `<SessionKeeper />`; the gate's keeper count went 4 -> 6.

## Security proof - `checkSessionList()`

116 new checks (auth gate 1891 -> 2007), against an in-memory `sessions` + `device_proof_keys` pair
that keeps the two properties the STEP rests on: a row belongs to one account, and a revoked row is
not live. Among them:

- the owner's list shows exactly the caller's live rows, marks the current one, resolves labels, and
  never selects `ip_address`, `user_agent`, `token_hash` or the fingerprint (asserted on the source and
  on the query the double received);
- an id belonging to another account, an already-revoked id and a non-identifier all answer
  `RESOURCE_NOT_FOUND`, and none of them touches another account's row;
- the owner's revoke writes `SIGNED_OUT` and `session.revoked_by_owner`; the sweep returns the count,
  writes `session.others_revoked`, leaves the asking session alive and writes nothing on a second run;
- a merchant and a `finance_ops` account are refused `PERMISSION_DENIED` on both office functions; the
  officer's read is audited with the officer as the actor; a session id paired with the wrong account
  ends nothing;
- both office reasons are asserted to be inside `SESSION_REVOCATION_REASONS`, i.e. inside the
  vocabulary `0010` closed, so a later STEP cannot invent a reason the migration would reject;
- the routes are read on disk: the owner's revoke must **not** call `requireFreshReauthentication`, the
  office one must, and both must call it before `JSON.parse(`.

### Mutation controls (each breaks exactly one check, then is restored)

| control | failing check |
| --- | --- |
| drop `user_id=eq.` from the list query | "another account's session is never listed" (4 checks) |
| office revoke writes `SIGNED_OUT` | "an office revoke is recorded as one" |
| owner revoke calls `requireFreshReauthentication` | "the owner's revoke is not gated on freshness" |

## Gates

`npm run verify` exit **0**: structure 156 sources, config 10 sections/28 values, i18n 291 messages/12
placeholders, logger 117, errors 202/15 codes, lint 77, shell 235, jobs 110, migrations 2714 checks/91
migrations/74 tables, `tsc --noEmit` clean, `next lint` clean, `next build` clean. `node lib/auth/verify.ts`
passes **2007 checks**. Route table now lists `/sessions`, `/office/sessions`,
`/api/auth/sessions`, `/api/auth/sessions/revoke`, `/api/office/sessions`,
`/api/office/sessions/revoke`, all dynamic.

## Deliberately not done

- **No rate limiting.** `/api/auth/sessions` and `/api/auth/sessions/revoke` are on STEP 055's list
  with the other auth endpoints; this STEP left the seam, not a limiter.
- **No address in the list.** `ip_address` and `user_agent` stay on the row for the audit; the screen
  names devices. A "recent activity" screen with addresses is a different STEP with its own retention
  decision.
- **No pagination.** `SESSION_LIST_LIMIT` is 50 and the count is shown; an account with more sessions
  than that is an incident, and the sweep still ends every one of them.
- **No email on a revoke.** The aware-owner alert for a new device is STEP 052's; revoking is done by
  the account itself or by an officer who already has the merchant in front of them.
- **No `0092`.** See the database section.

## Package request (unchanged, still open)

`"check:auth": "node lib/auth/verify.ts"` inside `verify` before `check:lint`. `package.json` is not
edited by a STEP; this note is the request.

## Next

STEP 055 - IP rate limiting on the auth endpoints, including the six this STEP and 052/053 added:
`/api/auth/devices`, `/api/auth/session/rotate`, `/api/auth/devices/confirm`,
`/api/auth/session/reauth`, `/api/auth/sessions`, `/api/auth/sessions/revoke`.
