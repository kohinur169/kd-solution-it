// path: docs/planning/STEP_051_SUBSTEP_BREAKDOWN.md
# STEP 051 - Sub-step breakdown

STEP 051: **Rotating session token with replay detection and session family revocation**
(`docs/final/STEP_PLAN_250.md` line 676), from `docs/final/FEATURE_LIST.md` section 22 line 244:
"rotating session token, cookie replay detection with revocation of the whole session family" and
"a cookie works only inside its own session".

The table STEP 015 built (`migrations/0010_sessions.sql`) already carries every column this STEP
needs: `token_hash` (unique), `family_id`, `rotated_from_session_id` (one child per parent),
`revocation_reason` from a closed vocabulary that already contains `ROTATED`, `REPLAY_DETECTED` and
`FAMILY_REVOKED`, and `replay_detected_at` with a check that forces it to be paired with a replay
revocation. What is missing is the code that uses it, one bound on how long a rotation chain may
live, and the browser that carries the token.

## Sub-step 1 - Read the contract (before any code)

- `FEATURE_LIST.md` section 22 line 244 (the seven session protections) and section 22's line on
  the session-bound cookie.
- `MASTER_PROMPT.md`: one STEP per chat, append-only migrations with a rollback, the handoff in the
  same commit, no secret in code or logs.
- `docs/handoffs/STEP_050_COMPLETED.md`: what the proof layer already guarantees, and its own note
  that "051 owns the `sessions` row and will bind `device_proof_key_id`".
- `migrations/0010_sessions.sql`, `lib/auth/cookies.ts`, `lib/auth/session.ts`,
  `lib/auth/request-actor.ts`, `lib/auth/types.ts`, `lib/auth/runtime.ts`, and the ten call sites of
  `readRequestActor`.
- Result recorded in the handoff: the gap is that no code has ever written a `sessions` row, so a
  cookie today is trusted until its provider token expires and cannot be revoked.

## Sub-step 2 - Owned paths

New:

- `migrations/0089_session_rotation.sql` and `migrations/0089_session_rotation.down.sql`
- `lib/auth/session-rotation.ts` - the token, the store, the resolve/rotate/revoke decisions
- `app/api/auth/session/rotate/route.ts` - the one endpoint that binds and rotates
- `components/auth/session-keeper.tsx` - the silent client that keeps a session rotating
- `docs/planning/STEP_051_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_051_COMPLETED.md`

Modified (this STEP's surface inside files owned by earlier STEPs, each named in the handoff):

- `lib/auth/types.ts` - `RequestActor.deviceProofKeyId`, `.sessionFamilyId`; the four new rejection
  reasons
- `lib/auth/cookies.ts` - the payload carries the platform session token
- `lib/auth/session.ts` - the authenticated state carries the payload's token
- `lib/auth/request-actor.ts` - the bound reader (`readBoundSession`) and `readRequestActor`
- `lib/auth/runtime.ts` - the session store in the runtime object
- `lib/auth/request-proof.ts` - the proof must name the device the session is bound to
- `lib/auth/device-proof-store.ts` - `bindSession()`
- `lib/auth/disclosure.ts` - the new route is classified
- `lib/auth/verify.ts` - `checkSessionRotation()`
- `lib/auth/README.md` - rules 71-74
- `app/(auth)/signin/signin-form.tsx` - bind before navigating
- `app/api/auth/devices/route.ts` - the one route that may run before binding
- `app/(auth)/2fa/settings/page.tsx`, `app/office/2fa-reset-requests/page.tsx` - mount the keeper,
  pass the session store
- the eight remaining `readRequestActor` call sites - pass the session store
- `lib/i18n/strings/en.ts` - the copy the new screen needs

## Sub-step 3 - Database: `0089_session_rotation.sql`

`0010` lets a rotation set any future `expires_at`, so a chain that rotates every fifteen minutes
could live for ever; that is the one hole section 22's "rotating" leaves open. The migration adds
`absolute_expires_at` to `public.sessions`:

- the column, backfilled from `expires_at` for every existing row, then `not null`;
- `sessions_absolute_expiry_check`: `absolute_expires_at > issued_at` and
  `expires_at <= absolute_expires_at`, so no rotation can be stored past the family's ceiling;
- `sessions_family_live_idx`, the partial index the grace path reads (`family_id`, live rows only);
- a comment on the column saying what the ceiling means.

Rollback drops the index, the constraint and the column, and nothing else. Proof: PGlite, forward,
back, forward again, plus negative controls (a dropped check, a loosened index) that must fail.

## Sub-step 4 - Core service `lib/auth/session-rotation.ts`

- `createSessionToken()` 32 random bytes as base64url (43 characters, which is `0010`'s
  `^[A-Za-z0-9_-]{43,128}$`), `hashSessionToken()` its SHA-256 (the only form ever stored).
- `SessionTokenStore` - `findByHash`, `findLiveInFamily`, `insert`, `update`, `revokeFamily` - with a
  PostgREST implementation built on the existing `RestClient`.
- `openSession()` - the first binding: a new row, a new family, `absolute_expires_at` from the
  policy, `mfa_verified_at` when the cookie is `aal2`.
- `rotateSession()` - compare and swap: the parent is revoked as `ROTATED` only while
  `revoked_at is null`, the update is read back to learn whether this call won, then the child is
  inserted with the parent's `family_id` and `rotated_from_session_id`.
- `resolveSessionToken()` - the reader's decision: live, inside the grace window, expired, revoked,
  replayed. A replay marks the presented row `REPLAY_DETECTED` and revokes the family.
- `revokeFamily()` - one update, audited as `session.family_revoked`.
- Policy constants: rotation interval 15 minutes, one rotation's life 60 minutes, absolute ceiling
  30 days, grace 30 seconds.

## Sub-step 5 - Wiring: the reader, the runtime and the route

- `readSession` is untouched (it proves the cookie); `readBoundSession` adds the row: it resolves
  the payload's token, overlays the actor with the row's `sessionId`, `deviceProofKeyId` and
  `sessionFamilyId`, and refuses everything a resolution rejects with the one
  `AUTHENTICATION_REQUIRED`.
- `readRequestActor` keeps its signature and calls `readBoundSession`; `allowUnbound` is the single,
  named exception used by the two routes that must run before a device exists.
- `POST /api/auth/session/rotate` - reads a small body naming the browser's `deviceId`, resolves the
  session, and answers one of: bound (new family), rotated (a new token), current (not due yet).
  Every answer that issues a token rewrites the cookie; a refusal is `401`.
- `getAuthRuntime()` gains `sessions`, and the ten call sites pass it.

## Sub-step 6 - The browser

- `bindSession(deviceId)` in `lib/auth/device-proof-store.ts`: one POST, cookies included, `null` on
  any failure.
- The sign in form calls it before navigating, on both success paths, after the enrolment of STEP
  049 - a session that cannot bind says so with `device.proofRequired` and does not navigate into a
  page that would refuse it.
- `components/auth/session-keeper.tsx` - a silent client component that calls the route on mount and
  every five minutes, mounted on the two authenticated pages. No visible text, so no new copy.
- Desktop and mobile widths re-checked for the two pages and the sign in form.

## Sub-step 7 - Security proof

- `lib/auth/request-proof.ts`: the proof must name the device the session row is bound to, so a
  sibling device of the same account cannot sign for this session.
- `checkSessionRotation()` in `lib/auth/verify.ts`: an in-memory `sessions` table that honours the
  unique token hash and the one-child-per-parent index, and checks for the token shape and hash, the
  binding, rotation, the interval, the grace window, replay, the whole family, the absolute ceiling,
  the device mismatch, the audit entries, and the route-vs-reader agreement.
- Audit: `session.bound`, `session.rotated`, `session.replay_detected`, `session.family_revoked`,
  each naming ids and instants and never a token.
- RLS: `0010` already enables it with `sessions_default_deny`; the new migration adds no policy.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npm run lint`, `node lib/auth/verify.ts`, `node lib/i18n/verify.ts`,
`npm run verify`, the PGlite proof of `0089` forward/back, negative controls on the gate, then one
commit `STEP 051: Rotating session token with replay detection and session family revocation`,
pushed to `arena/1dc51ec3-kd-solution-it`, with `docs/handoffs/STEP_051_COMPLETED.md`.
