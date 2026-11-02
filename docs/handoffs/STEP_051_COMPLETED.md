// path: docs/handoffs/STEP_051_COMPLETED.md
# STEP 051 Completed - Handoff

Feature: **LR-022 rotating session token with replay detection and session family revocation**
(`docs/final/STEP_PLAN_250.md` line 676), from `docs/final/FEATURE_LIST.md` section 22 line 244:
"rotating session token, cookie replay detection with revocation of the whole session family" and
"a cookie works only inside its own session".
Commit: `STEP 051: Rotating session token with replay detection and session family revocation`.

## What was delivered

1. **`migrations/0089_session_rotation.sql`** (+ `.down.sql`) - the ceiling a rotation chain needs.
   `0010_sessions.sql` already stored the chain; what it allowed was a chain that never ended.
   - `public.sessions.absolute_expires_at` - written when a family starts, copied by every rotation,
     backfilled from `expires_at` for rows that predate it, then `not null`;
   - `sessions_absolute_expiry_check` - `absolute_expires_at > issued_at` and
     `expires_at <= absolute_expires_at`, so the database itself refuses a rotation stored past its
     family's ceiling;
   - `sessions_family_live_idx` - the partial index the grace path reads, live rows of one family.
2. **`lib/auth/session-rotation.ts`** - the rotating token, in one place:
   - `createRawSessionToken()` (32 random bytes, 43 base64url characters, which is `0010`'s own
     pattern), `hashSessionToken()` (SHA-256, the only form ever stored), `isSessionToken`;
   - `SessionTokenStore` with a PostgREST implementation: `findByHash`, `findLiveInFamily`, `insert`,
     `update`, `revokeFamily`, `revokeDevice`;
   - `issueSessionToken()` - one entry point for the two things the browser can ask: bind a new
     session to a device (`openFamily`) or replace a live one (`rotate`);
   - `resolveSessionToken()` - the read on every authenticated request, and the place a replay is
     noticed and answered;
   - `revokeSession()` and `revokeDeviceSessions()` - the writes STEP 054's screens and sign out will
     call, so "every session event is audited" holds for them too;
   - policy: rotation every 15 minutes, one rotation lives 60 minutes, a family lives 30 days, grace
     30 seconds, all injectable so the gate proves them without waiting.
3. **Rotation is a compare and swap, read back.** The parent is revoked as `ROTATED` by an update
   that only matches `revoked_at is null`; the row is then read again and only a call whose own
   instant is on the row may insert the child. The child copies `family_id` and
   `absolute_expires_at` and names its parent in `rotated_from_session_id`, which
   `sessions_rotation_key` allows exactly once. A caller that lost the swap is answered with the
   family's live row, not a second token.
4. **The grace window.** A spent token presented within 30 seconds of its rotation is honoured -
   that is a request already in flight when the answer rewrote the cookie - and nothing is issued,
   because the jar already holds the current token. The same token after 30 seconds is a replay:
   the presented row becomes `REPLAY_DETECTED` with `replay_detected_at`, every live row of the
   family becomes `FAMILY_REVOKED`, and two audit entries record it. Neither entry quotes a token.
5. **`lib/auth/request-actor.ts`** - `readBoundSession()` and `readRequestActor()`: the cookie is
   verified first (STEP 039's `readSession`, untouched), then its token resolves to one row, and the
   actor receives that row's `sessionId`, `deviceProofKeyId` and `sessionFamilyId`. Every rejection
   - unbound, unknown, expired, revoked, replayed - is the catalogue's one
   `AUTHENTICATION_REQUIRED`.
6. **`POST /api/auth/session/rotate`** - the one endpoint that can hand a browser a token, because
   only a route handler may write a cookie. It answers `bound` (first binding, new family),
   `rotated` (a new token) or `current` (not due, or inside the grace window), refuses a `deviceId`
   that is not a live key of the account with `422 {field:"deviceId", rule:"unknown_device"}`, and
   refuses everything else with `401`.
7. **The browser.** `bindSession()` in `lib/auth/device-proof-store.ts`; the sign in form enrols a
   key when the server asks for one *or* when this browser has none, then binds, and shows
   `device.bindingFailed` instead of navigating into a page that would refuse the cookie;
   `components/auth/session-keeper.tsx` asks for a rotation on mount and every five minutes on both
   signed-in pages.
8. **The session's device is a binding.** `verifySensitiveRequest` (STEP 050) now refuses a proof
   from a device row that is not the one the session names (`session-device-mismatch`), so a sibling
   key of the same account is not evidence about this session.
9. **`checkSessionRotation()`** - 103 new checks in `lib/auth/verify.ts`, including a disk check
   that only two files in `app/` may use `allowUnbound`, that the rotation route both reads and
   issues, and that both signed-in pages mount the keeper. Five more come from the new route's
   classification in `lib/auth/disclosure.ts` and the session-device case added to
   `checkRequestProof()`, so the gate grows from 1 614 to 1 722.

## State before the first edit

Clean tree at `13ccc18`, `HEAD` equal to `origin/arena/1dc51ec3-kd-solution-it`, every gate green
(auth 1 614 checks, migrations 2 566 checks / 88 migrations / 73 tables), no dev server running and
no pre-existing defect. The gap was exactly the one STEP 049's rule 65 and STEP 050's rule 67 named:
`public.sessions` existed with every column a rotating token needs, and no code had ever written a
row into it, so a cookie could not be revoked and a stolen one could only be stopped by waiting for
the provider's token to expire.

## Design notes worth keeping

- **A cookie is a reference, not a bearer token.** The payload carries a random token; the server
  stores its SHA-256. A database leak therefore yields no usable cookie, and revocation is one row
  update that bites on the next request.
- **The reader that can revoke is the reader that notices theft.** The replay answer is written
  inside `resolveSessionToken`, not in a caller: a refused request has no caller left to audit it.
- **The grace window is not a hole, it is the only alternative to a false positive.** Two requests
  from one browser are normal - a rotation answer that rewrites the cookie races the request already
  on the wire. Without a window every rotation would randomly sign people out; with it, a spent token
  works for 30 seconds and never again.
- **Nothing is issued inside the grace window.** The row for the current token already exists and
  only its hash is stored, so the honest answer is "you are current", not a second token that would
  make two rows live in one family.
- **A chain needs a ceiling or rotation is just renewal.** That is why `0089` exists: without it a
  stolen cookie could rotate legitimately for ever and replay detection would never fire, because
  nothing would ever be replayed.
- **Binding is what makes the device proof more than a header.** `0010`'s composite foreign key keeps
  a session on the account's own device; STEP 051 puts the same value on the actor, so STEP 050's
  proof check can compare the two and refuse a sibling device.
- **The unbound window is named, not implied.** A browser on a new device cannot bind before it has
  a key, and enrolling a key needs a session to say whose key it is. `allowUnbound` is that window,
  exactly two routes pass it, and the gate reads the disk to keep that number at two.
- **The provider's pair is carried forward byte for byte.** The rotation rewrites one field of the
  payload. Reissuing, shortening or re-signing the provider's tokens is not this route's business and
  would invalidate the cookie `readSession` had just accepted (`sessionId` in the payload is the
  provider's claim and must not be rewritten).
- **Trust is still STEP 052's.** A rotated session is bound and revocable; it says nothing about
  whether the device is trusted. `trusted_at` remains null on every row STEP 049 wrote.

## Database

- Migration added: `migrations/0089_session_rotation.sql` with
  `migrations/0089_session_rotation.down.sql` (drops the index, the constraint and the column, and
  nothing else).
- Proven on a real PostgreSQL engine (PGlite 0.5.14) against the **real** `0010_sessions.sql`:
  **36 checks** - the column's type and nullability, the backfill copying `expires_at` on a row
  written before the migration, the check accepting an expiry equal to the ceiling and a shorter
  one, refusing one that reaches past it and a ceiling before `issued_at`, the partial index's
  predicate, a rotation copying its family, a second child of one parent refused, a rotation
  re-marked as a replay, a replay instant without a replay revocation refused, and one live row per
  family afterwards.
- Rollback verified on clean database: yes - forward, back (column, index and constraint gone, every
  row kept, `0010`'s own indexes untouched), forward again (the second run backfills every row it can
  see).
- Five negative controls, each restored afterwards and each confirmed to fire: no ceiling check, no
  backfill (the migration then fails loudly on the `not null`), a family index that is not partial, a
  nullable ceiling, and a ceiling check that forgets the expiry.
- RLS: `0010` already enables it with `sessions_default_deny`; `0089` adds no policy, so the table
  stays unreachable except through the service role.

## Environment

- Environment variables added to `.env.example`: none.
- Secrets handled (names only, never values): none. Session tokens are random bytes minted at run
  time, stored only as a hash, and never logged - the log lines and the audit entries name the
  session id, the family id and the outcome, never the token.

## Packages

- No new approach needs one: `node:crypto` supplies the randomness and the hash, and the rotation
  path speaks to the database through the existing `RestClient`.
- The standing integrator request from STEP 047 is still open: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.

## Behaviour proof (acceptance checklist)

- **The token.** 43 base64url characters matching `0010`'s pattern, two tokens never equal, the hash
  is 43 characters, deterministic, different for a changed token and never equal to the token;
  `isSessionToken` refuses a short string, a padded one, a 44 character one and a number.
- **The first binding.** One row, bound to the device, holding the hash and not the token, issued
  now, expiring one window later, with the family ceiling 30 days out and `mfa_verified_at` set only
  for an `aal2` cookie; `session.bound` is audited and the entry does not quote the token. A second
  binding starts a second family.
- **What a token resolves to.** A fresh token is live; an unknown token, a malformed one and a token
  of another account are all refused without a row; a row past its own expiry is expired; a row past
  its family's ceiling is expired even when its own expiry is later; a signed out row is revoked;
  a rotated row is grace inside the window and a replay after it.
- **The interval.** A session younger than 15 minutes answers `current` and writes nothing; past it
  the answer is `rotated`, the parent becomes `ROTATED` at the rotation instant, the child copies the
  family and the ceiling, gets a fresh window, keeps `mfa_verified_at`, and `session.rotated` names
  the parent.
- **Replay and the family.** A spent token inside the grace window is honoured without a write; one
  millisecond later it is a replay: the row becomes `REPLAY_DETECTED` with the instant, the live head
  becomes `FAMILY_REVOKED`, `session.family_revoked` counts the row it ended, and the head token
  stops working immediately. A replay presented to the rotation endpoint is refused, not rotated.
- **The compare and swap.** With the update lost, the answer is the live session and no second row;
  with a child already present, the answer is that child and still no third row.
- **The device binding of a session.** A rotation naming another device of the same account is
  refused as `device-mismatch` and writes nothing.
- **Ending a session and a device.** `revokeSession` writes `SIGNED_OUT` and audits it, and the token
  then resolves as revoked; `revokeDeviceSessions` ends the device's live rows as `DEVICE_REVOKED`,
  audits the act once and counts them.
- **The reader every route uses.** A cookie with no session token is refused by `readRequestActor`
  and accepted only where `allowUnbound` is set, where it reports `bound: false`, no device and the
  provider's session id; a bound cookie yields the platform session id, the device and the family; a
  token of another account and a cookie whose subject disagrees with its payload are both refused; a
  revoked session is refused **even** where an unbound cookie is allowed.
- **The exception, on disk.** Exactly two files under `app/` use `allowUnbound`
  (`/api/auth/session/rotate/route.ts` and `/api/auth/devices/route.ts`), the rotation route both
  reads the session and issues the token, and both signed-in pages mount `SessionKeeper`.
- **API shapes over HTTP** (live, port 3000, server stopped afterwards): `POST
  /api/auth/session/rotate` with no cookie is `401` whatever the body looks like; a malformed body
  from an authenticated caller is `422` with the `deviceId` / `invalid_format` detail; a body over
  1 KiB is `413 PAYLOAD_TOO_LARGE`; `GET` is `405`; a forged cookie value is `401`. `/2fa/settings`,
  `/office/2fa-reset-requests`, `/signin` and `/` all render `200` signed out. This sandbox has no
  Supabase project, so a real bind and a real rotation cannot be exercised over HTTP here; the
  service is proven by the gate and the schema by PGlite.
- **UI checks.** Nothing new is visible: the keeper renders `null`, so both pages are pixel-identical
  at desktop and mobile widths, and the only new sentence (`device.bindingFailed`) appears in the
  sign in form's existing message area, which was re-checked at 375 px and 1280 px in both themes.

## Verification

- `node lib/auth/verify.ts`: **1 722 checks** (1 614 before this STEP), including the new
  `checkSessionRotation()`.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **139 source files**, config
  10 sections / 28 values, i18n **207 messages / 8 placeholders / 1 locale**, logger 117, errors 202
  checks / 15 codes, lint 77 checks / 26 rules, shell **187 checks / 39 files**, jobs 110 checks,
  migrations **2 586 checks / 89 migrations / 73 tables**, type check, lint and the production build.
- `npx tsc --noEmit` and `npx eslint .` clean; no `any`, no `console.log`, no new dependency.
- Negative controls on the gate, each confirmed to fire and each restored afterwards (final restored
  run: 1 722 checks):
  1. the compare and swap's read back removed -> "a rotation that lost the swap answers the live
     session" and "and writes nothing" fail;
  2. the grace window removed -> 4 problems, including "a spent token is honoured inside the grace
     window (expected grace, received replayed)";
  3. a replay not marked -> 6 problems, including "the whole family is revoked (received null)";
  4. the family revocation skipped -> 3 problems, including "the rest of a revoked family stops
     working (expected revoked, received live)";
  5. the account check on a resolved token removed -> "a token of one account does not authenticate
     another" and the reader's own case fail;
  6. the ceiling ignored by a rotation -> "the rotation stops at the ceiling instead of extending it
     (expected 1800001200000, received 1800004500000)";
  7. a revoked row resolved as live -> 6 problems across replay, revocation and the reader;
  8. `allowUnbound` ignored by the reader -> "a cookie that names no session is refused";
  9. the proof's session-device check removed -> 3 problems, including "a sibling device of the same
     account cannot sign for this session";
  10. `allowUnbound` removed from the enrolment route -> 2 problems, including "the enrolment that
      makes a key exist is the other";
  11. the keeper removed from one page -> "both signed-in pages keep their session rotating (expected
      2, received 1)".
- One defect the checks themselves found: `issueSessionToken` had an `absolute-expired` refusal that
  the resolver's own expiry rule already made unreachable. The branch and its reason were removed
  rather than left as dead code, and the check now asserts the `expired` reason the ceiling produces.
- `git diff` scope: 2 added source files (the service and the route), 1 added component, 1 added
  migration with its rollback, 21 modified files and 2 added documents.

## Next

- Next STEP: **052 - new device detection with email confirmation and 2FA step**.
- Anything the next chat must know:
  - **The session row is the authority and it already exists.** `readRequestActor` resolves the
    cookie's token to one row and refuses anything a revocation, an expiry or a replay ended, so 052
    can add a trust flag without inventing a second gate: `sessions` and `device_proof_keys` are
    both reachable through `runtime.sessions` and `runtime.rest`.
  - **`trusted_at` is still null on every device.** STEP 052 owns the value, the email of section 23
    and the second factor confirmation, and decides whether an untrusted device may mint backup
    codes. Nothing in 051 refuses an untrusted key on purpose - `verifySensitiveRequest` reports
    `trusted` and enforces nothing.
  - **The unbound window must shrink, not grow.** A browser today binds at sign in through
    `establishSession` in the sign in form. If 052 adds a confirmation screen, it belongs *before*
    that binding, and the disk check in `checkSessionRotation()` keeps the set of files that may run
    unbound at exactly two - update that count deliberately, not accidentally.
  - **The email verification route still issues an unbound cookie.** `app/(auth)/verify` renders
    after `/api/auth/verify` wrote a cookie that names no device. The page reads no actor, so nothing
    breaks today; 052 should decide whether a confirmed address binds immediately.
  - **A re-enrolled browser is a new device.** Clearing the site data and enrolling again leaves the
    old session bound to the old key, and the rotation then answers `device-mismatch` - the browser
    shows `device.bindingFailed` and a fresh sign in fixes it. 052's confirmation flow is the better
    place to explain that.
  - **054 gets its writes ready-made.** `revokeSession()` (a sign out, an admin revocation) and
    `revokeDeviceSessions()` (dropping a device) already write the row and the audit entry; the
    screens and the permission check are what 054 adds. The device list lives in the query shape of
    `readLiveDevices` in `lib/auth/device-enrolment.ts`.
  - **055 should rate limit `/api/auth/session/rotate`.** It is the one authenticated endpoint that
    mints a token; the limiter should key on the account and the address, and its answer belongs in
    `SESSION_AUTH_SURFACES` with `RATE_LIMITED` if the catalogue is extended that way.
  - **Do not shorten `SESSION_ROTATION_GRACE_MS` without re-reading the control run.** At 30 seconds
    a rotation answer that races an in-flight request is safe; below a second, ordinary page loads
    would start signing people out and the gate's `afterGrace` case is what to re-derive.
