// path: docs/planning/STEP_054_SUBSTEP_BREAKDOWN.md
# STEP 054 - Sub-step breakdown

STEP 054: **Session list and instant revoke for owners and office roles**
(`docs/final/STEP_PLAN_250.md` line 712), from `docs/final/FEATURE_LIST.md` section 22 line 244
("instant session revocation ... and audit logging of every session event") and section 2 (the role
list and "every permission grant, change and use is audit logged").

## What already exists, and what is missing

The storage is complete, and this STEP adds no table and no column:

- `public.sessions` (`0010`) carries one row per rotation, `family_id`, the device, `issued_at`,
  `last_seen_at`, `expires_at`, and the revocation pair (`revoked_at` + a closed vocabulary of
  reasons: `SIGNED_OUT`, `ROTATED`, `REPLAY_DETECTED`, `FAMILY_REVOKED`, `ADMIN_REVOKED`,
  `PASSWORD_CHANGED`, `DEVICE_REVOKED`).
- `sessions_user_idx` is `(user_id, revoked_at) where deleted_at is null` - exactly the read a list
  of one account's live sessions performs - so no index is added.
- `SessionTokenStore` already has `revokeFamily` and `revokeDevice`, and `lib/auth/session-rotation.ts`
  exports `revokeSession` and `revokeDeviceSessions`.

What is missing is the part a person sees and the part an officer uses: a read that names the device
of each live session, a revoke that a browser can call on its own account, an office revoke for a
merchant's account, the screens, and the audit entries that say who ended what.

## The decisions this STEP makes

1. **Two reasons, not one.** An owner ending a session from the list is `SIGNED_OUT`; an office role
   ending somebody else's is `ADMIN_REVOKED`. Both are in the vocabulary `0010` already closed, so the
   column needs no change and a reader can tell the two apart from the row alone.
2. **The list names devices, not addresses.** `ip_address` and `user_agent` are personal data whose
   retention `0010` leaves to the STEP that writes them, so the owner sees the device label, when the
   session started, when it was last seen and whether the device is confirmed - not a raw address.
3. **The owner's revoke is signed but not stepped up; the office one is both.** Ending one's own
   session is a defensive action: the person is trying to close a door, and making them fetch the
   authenticator first keeps the door open longer. It stays on STEP 050's list of endpoints that need
   a device proof, and STEP 052's device trust, because those two say *which browser is asking*
   without adding a wait. `POST /api/office/sessions/revoke` additionally calls STEP 053's
   `requireFreshReauthentication`, because signing a merchant out of every device is an act on
   somebody else's account - exactly the case section 22 names for the step-up.
4. **The current session can be ended, and the answer says so.** Ending it is a legitimate choice and
   the next request is refused by the same reader that refuses any spent token; the screen redirects
   to the sign in instead of pretending the browser is still signed in.
5. **Office roles are the three that already handle merchants.** `super_admin`, `ceo`,
   `compliance_kyc` and `support` - the same list the unlock and the 2FA reset use, because a fourth
   list would be a fourth place the rule lives.

## Sub-step 1 - Read the contract

`FEATURE_LIST.md` section 22 line 244 and section 2, `0010_sessions.sql` (columns, indexes and the
revocation vocabulary), `lib/auth/session-rotation.ts` (`revokeSession`, `revokeDeviceSessions`,
`SessionTokenStore`), the STEP 053 handoff's "Next", `lib/auth/two-factor-reset.ts` (the office role
list and the "permission inside the service" pattern) and the office queue screen.

## Sub-step 2 - Owned paths

New: `lib/auth/session-list.ts`, `app/api/auth/sessions/route.ts`,
`app/api/auth/sessions/revoke/route.ts`, `app/api/office/sessions/route.ts`,
`app/api/office/sessions/revoke/route.ts`, `app/(dashboard)/sessions/page.tsx` and its client form,
`app/office/sessions/page.tsx` and its client form, this document and the handoff.

Modified: `lib/auth/session-rotation.ts` (a read of one account's live sessions),
`lib/auth/request-proof.ts` (the two revoke endpoints join `SENSITIVE_ENDPOINTS`),
`lib/auth/disclosure.ts`, `lib/auth/verify.ts`, `lib/auth/README.md`, `lib/i18n/strings/en.ts`.

## Sub-step 3 - Database

None. The schema is complete: `0010` already stores every fact the list shows, its revocation
vocabulary already contains both reasons this STEP writes, and `sessions_user_idx` already serves the
read. A migration that only re-declared what exists would be the mistake STEP 053 nearly shipped.

## Sub-step 4 - Core service `lib/auth/session-list.ts`

- `listOwnSessions` - the live sessions of the caller, newest first, each with its device label, the
  device's confirmation state, `issuedAt`, `lastSeenAt`, `expiresAt` and whether it is the session
  asking.
- `revokeOwnSession` - one row, only if it is the caller's and live; `SIGNED_OUT`; audit
  `session.revoked_by_owner`. Answers whether it was the current session, so the screen can redirect.
- `revokeOtherOwnSessions` - every live row of the caller except the one asking; audit
  `session.others_revoked` with the count.
- `listAccountSessions` / `revokeAccountSession` - the office half, gated by
  `SESSION_MANAGEMENT_OFFICE_ROLES` inside the service (not in the route, not in the page), writing
  `ADMIN_REVOKED` and auditing `session.revoked_by_office` with the officer, the account and the
  reason.

## Sub-step 5 - Wiring

- `GET /api/auth/sessions` - the caller's list.
- `POST /api/auth/sessions/revoke` - `{ sessionId }` or `{ allOthers: true }`, signed with the device
  key and refused for an unconfirmed device.
- `GET /api/office/sessions?userId=` - the office read, role-gated inside the service.
- `POST /api/office/sessions/revoke` - the office write: the same proof, plus STEP 053's fresh
  window.
- `lib/auth/disclosure.ts` classifies the two signed endpoints.

## Sub-step 6 - UI

- `/sessions` - the owner's screen: one row per session, the current one marked, a revoke button on
  each, and one "end every other session" button.
- `/office/sessions?userId=` - the officer's screen for one account, with the same rows and a revoke
  per row. Desktop and mobile widths checked with the existing auth screens.

## Sub-step 7 - Security proof

`checkSessionList()` in `lib/auth/verify.ts`: the ownership rule, the role gate, the two revocation
reasons, the audit entries, the "current session" answer, the request-proof listing, the routes'
order of checks, and the service's refusal to revoke a row that is not the caller's or not live.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npm run lint`, `node lib/auth/verify.ts`, `node lib/i18n/verify.ts`,
`npm run verify`, mutation controls, then one commit
`STEP 054: Session list and instant revoke for owners and office roles`, pushed to
`arena/1dc51ec3-kd-solution-it`, with `docs/handoffs/STEP_054_COMPLETED.md`.
