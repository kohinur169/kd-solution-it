// path: docs/handoffs/STEP_050_COMPLETED.md
# STEP 050 Completed - Handoff

Feature: **LR-022 request signature verification on sensitive endpoints**
(`docs/final/STEP_PLAN_250.md` line 656), from `docs/final/FEATURE_LIST.md` section 22 line 244
("per-device proof key" inside LR-022), on the key STEP 049 taught the browser to make
(`lib/auth/proof-key.ts`, `lib/auth/device-proof-store.ts`) and the table STEP 015 built
(`migrations/0009_device_proof_keys.sql`).
Commit: `STEP 050: LR-022 request signature verification on sensitive endpoints`.

## What was delivered

1. **`lib/auth/proof-key.ts`** - the signing half, beside STEP 049's generation half and written
   against WebCrypto only, so the browser signs and the server verifies with the same code:
   - `REQUEST_PROOF_HEADERS` names the four headers (`x-device-proof-key`, `-timestamp`, `-nonce`,
     `-signature`), `REQUEST_PROOF_VERSION` is `kd-proof-v1`, `REQUEST_PROOF_WINDOW_MS` is 120 000;
   - `requestProofMessage()` builds the canonical message: seven newline separated lines -
     version, upper cased method, pathname, body digest, timestamp, nonce, device row id;
   - `requestBodyDigest()` is the base64url SHA-256 of the body and `-` for an empty one, so a signed
     empty body and an unsigned body are different messages;
   - `signProofMessage()` and `verifyProofMessage()` handle all three algorithms the table allows
     (ES256/ES384 ECDSA with SHA-256/384 over raw `r||s`, EdDSA over Ed25519), and both refuse a
     signature that is not its own canonical base64url rather than repairing it;
   - `sha256Base64Url()`, the nonce/timestamp/device-key patterns and the 512 character signature
     ceiling restate `0088`'s checks so a caller can refuse before it queries.
2. **`lib/auth/request-proof.ts`** - the check itself:
   - `SENSITIVE_ENDPOINTS` lists the three endpoints (backup codes, the second factor reset
     decision, the account unlock) with the sentence that says why each is dangerous;
   - `isSensitivePath()` answers whether a path is on the list;
   - `verifySensitiveRequest({request, bodyText, actor}, {rest, audit})` runs one ordered pass -
     headers, URL, clock, device row, signature, nonce - and every refusal is the same
     `401 AUTHENTICATION_REQUIRED` with an empty detail list plus one best effort
     `user.request_proof_rejected` entry naming only the reason and the method;
   - the nonce is spent **last**, so a request with a bad signature cannot fill the table and a
     replay collides on `request_proof_nonces_device_nonce_key`;
   - `trusted_at` is reported as `trusted` and **not** enforced, because STEP 052 owns trust.
3. **Three routes rewired** - `app/api/auth/2fa/backup-codes/route.ts`,
   `app/api/office/2fa-reset-requests/decision/route.ts` and
   `app/api/office/account-locks/unlock/route.ts` now read the body **once**
   (`await request.text()`), read the actor, verify the proof against that exact string and only
   then `JSON.parse` it. The signature therefore covers the bytes the route acts on, and the
   duplicate actor and `getAuthRuntime()` blocks the old shapes had are gone.
4. **`lib/auth/device-proof-store.ts`** - `deviceProofHeaders(method, path, body)` returns the four
   headers for a request, or `null` when the browser has no WebCrypto, no key, no device id or the
   signing itself throws. It never throws at a caller: a merchant without a key gets a sentence, not
   a broken form.
5. **The two screens sign.** `app/office/2fa-reset-requests/office-reset-queue.tsx` and
   `app/(auth)/2fa/settings/backup-codes-form.tsx` build their body once, sign it, and send it. A
   `null` proof stops the request locally with `device.proofRequired` instead of spending a round
   trip on a request that would be refused.
6. **`migrations/0088_request_proof_nonces.sql`** (+ `.down.sql`) - the nonce table: `id` v7 uuid,
   `company_id` nullable, `user_id`, `device_proof_key_id`, the `nonce` with
   `^[A-Za-z0-9_-]{16,64}$`, `method` in `POST/PATCH/PUT/DELETE`, `path` with
   `^/[A-Za-z0-9/_.-]{1,200}$`, `signed_at`, `expires_at` bounded to `signed_at + interval '10
   minutes'`, the **unique** `(device_proof_key_id, nonce)` index that *is* the replay guard, the
   composite `(user_id, device_proof_key_id)` foreign key into `device_proof_keys (user_id, id)`,
   the expiry and user indexes, `set_row_metadata`, RLS and `request_proof_nonces_default_deny`.
7. **`checkRequestProof()`** - 108 new checks in `lib/auth/verify.ts`, described under Behaviour
   proof. It includes a **disk** check: every path in `SENSITIVE_ENDPOINTS` must be a route file
   that calls `verifySensitiveRequest`, and every route that calls it must be listed.

## State before the first edit

Clean tree at `6c6b3af`, `HEAD` equal to `origin/arena/1dc51ec3-kd-solution-it`, every gate green
(auth 1 506 checks, migrations 2 535 checks / 87 migrations / 72 tables), no dev server running and
no pre-existing defect. STEP 049's own rule 65 said what was missing: a key existed and nothing used
it, so an untrusted device was still able to mint backup codes with a stolen cookie.

## Design notes worth keeping

- **The cookie says which account, the signature says which device.** The private half cannot be
  exported (STEP 049), so a copied cookie on another machine has nothing to sign with. This is the
  single sentence that makes the whole feature worth its cost.
- **A proof is evidence beside the session, never instead of it.** `verifySensitiveRequest` runs
  *after* `readRequestActor`; a request with no session never reaches the proof check at all, and a
  request with a session but no proof is refused by it. Neither half can substitute for the other.
- **One sentence for every refusal.** Nine internal reasons, one public answer. These endpoints are
  not anonymous, so this is not about hiding an account - it is about not telling an attacker which
  part of the proof to fix. The reason lives in the audit trail, where only the platform reads it,
  and the nonce and the signature never reach it.
- **The message is versioned on its own first line.** `kd-proof-v1` means a later revision can sign
  differently without reinterpreting an old signature as a new one.
- **A query string is refused, not ignored.** The pathname is signed; a request that carries
  `?a=b` has parameters nobody signed. `query-not-signed` was a deliberate choice over extending the
  message, because an empty and a non-empty query must not verify as the same request.
- **Two independent layers bound a replay.** The clock (120 s, both sides) stops an old capture by
  itself; the unique nonce index stops the same capture inside the window. Neither is enough alone,
  and `0088` additionally refuses a timestamp that claims a window longer than ten minutes.
- **The nonce is spent last.** It is the only write. A bad signature must not be able to fill the
  table, and a good one must not be able to spend its nonce twice - the insert before the endpoint
  work gives both.
- **One read of the body.** Every route calls `await request.text()` once and parses that string.
  Reading twice would compute a digest over different bytes if the stream were reassembled, and the
  signature would be over a body the handler did not act on.
- **Trust is reported, not required.** A row from STEP 049 has `trusted_at` null; refusing it would
  refuse every key the platform itself created. The outcome carries `trusted` and STEP 052 decides.
- **The list is data, and the gate reads the disk.** Adding an endpoint is one entry in
  `SENSITIVE_ENDPOINTS` and one call in the route; forgetting either fails the gate, which is what
  makes the registry a boundary rather than a comment.

## Database

- Migration added: `migrations/0088_request_proof_nonces.sql`, with
  `migrations/0088_request_proof_nonces.down.sql` dropping the table only (rollback file present and
  transactional, as the migrations gate requires).
- Proven on a real PostgreSQL engine (PGlite 0.5.14) before commit: **27 checks**, including the
  unique index refusing the same nonce on the same device while allowing it on another device, the
  expiry ceiling refusing `+ interval '11 minutes'` and accepting `+ interval '10 minutes'`, the
  composite foreign key refusing a device of another account while a device id from another account
  with a mismatched `user_id` is refused, the method and path checks, the default deny policy, and
  the down file leaving no table behind.
- Rollback verified on clean database: yes - forward, back and forward again on the same engine.

## Environment

- Environment variables added to `.env.example`: none.
- Secrets handled (names only, never values): none. The check uses the existing service role client
  through `lib/auth/runtime.ts`, exactly as the routes it guards already did.

## Packages

- No new dependency: `crypto.subtle` is the platform API on both sides of the wire.
- The standing integrator request from STEP 047 is still open: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.

## Behaviour proof (acceptance checklist)

- **The message.** `requestProofMessage` joins exactly seven lines, the version first and the device
  row id last; the same parts in a different order produce a different message; a body digest of `-`
  and a digest of the empty string are not the same message.
- **The digest.** `requestBodyDigest("")` is `-`, the digest of any other body is 43 characters of
  base64url, and two different bodies never share one.
- **Sign and verify, all three algorithms.** A pair generated by STEP 049's own
  `generateProofKeyPair` signs a message that verifies; the same signature does not verify against
  another message, another key, another algorithm or a signature with one character changed.
- **The happy path.** A correctly signed request to a listed endpoint returns the device id, the
  algorithm, `trusted: false`, the signed time and the nonce, and writes one nonce row with the
  method and the path.
- **Replay.** The same envelope sent twice is refused `AUTHENTICATION_REQUIRED` with `details: []`,
  the audit entry names `replayed`, the payload does not quote the nonce, and one nonce row exists.
- **The window, both sides.** A request 119 999 ms old, and one exactly 120 000 ms old, are
  accepted; 120 001 ms old and 120 001 ms in the future are refused as `stale-timestamp`.
- **The device.** An id that no row carries is `unknown-device`; a device of another account is
  `unknown-device`, not somebody else's key; a revoked device is `unknown-device`; an untrusted but
  live device is accepted and reported `trusted: false`.
- **Tampering.** A body altered after signing, a path the caller did not sign, a message signed over
  a different method and a timestamp the caller did not sign are all `signature`; the audit entry
  names the signature and never the nonce, the signature or the key.
- **The URL.** A request carrying `?force=true` is `query-not-signed` and is refused before any
  query; a listed path reached by `PUT` is `method-mismatch`.
- **Headers.** Each of the four headers, removed one at a time, is `missing-header`; a malformed
  device id, a non-string timestamp, a 15 character nonce and an over-long signature are
  `malformed-header` and are refused before any query.
- **The registry and the disk.** Every `SENSITIVE_ENDPOINTS` entry has a route file on disk that
  calls `verifySensitiveRequest`, and every route that calls it is listed - so a new endpoint cannot
  quietly skip the check and a listed endpoint cannot quietly drop it.
- **The browser call.** `deviceProofHeaders("POST", path, body)` returns the four headers, the
  signature is base64url of 86 characters for ES256, and the envelope it produces verifies through
  the server check with no transformation in between.
- **API shapes over HTTP** (live, port 3000, server stopped afterwards): each of the three routes
  answers `401 AUTHENTICATION_REQUIRED` without a cookie - *with or without* the four headers, which
  shows the session read runs first - and `405` on `GET`.
- **UI checks.** The backup codes form and the office reset queue send the same body they display;
  when `deviceProofHeaders` returns `null` the screen shows `device.proofRequired` and sends nothing.
  No new screen, and no layout change.

## Verification

- `node lib/auth/verify.ts`: **1 614 checks** (1 506 before this STEP), including the new
  `checkRequestProof()`.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **136 source files**, config
  10 sections / 28 values, i18n **206 messages / 8 placeholders / 1 locale**, logger 117, errors 202
  checks / 15 codes, lint 77 checks / 26 rules, shell 178 checks / 37 files, jobs 110 checks,
  migrations **2 566 checks / 88 migrations / 73 tables**, type check, lint and the production build.
- `npx tsc --noEmit` and `npx eslint .` clean; no `any`, no `console.log`, no new dependency.
- Negative controls in the gate, each confirmed to fire and each restored afterwards (final restored
  run: 1 614 checks):
  - the clock check widened to a year -> 6 problems ("a request -120001 milliseconds from now is
    refused", "the entry names the clock as the reason", and the same on the future side);
  - a nonce conflict answered with the outcome instead of a refusal -> 4 problems ("a replayed
    request is refused (nothing was rejected)", "a replay is audited as a rejected proof");
  - `user_id` dropped from the device query -> "another account's device is refused (nothing was
    rejected)";
  - the unlock route's `verifySensitiveRequest` call removed -> "/api/office/account-locks/unlock
    calls the proof check";
  - every signature accepted (`|| true`) -> 10 problems across the four tampered cases and the
    other-key case;
  - the `query-not-signed` refusal removed -> 2 problems ("a request with a query string is
    refused", "the entry names the unsigned query").
- Negative controls on the migration (PGlite, each restored from a pristine copy): a non-unique
  index, no `+ interval '10 minutes'` ceiling, a plain single-column device foreign key and a loose
  path pattern each failed exactly the named check, then 27/27 passed again.
- `git diff` scope: 2 added source files, 1 added migration with its rollback, 3 rewired routes, 2
  changed screens, 3 modified library files, 2 added documents.

## Next

- Next STEP: **051 - rotating session token, replay detection and family revocation**, which binds
  `sessions.device_proof_key_id` (`0010`'s composite foreign key already enforces that a session may
  only name a device of its own account).
- Anything the next chat must know:
  - **The protocol is fixed now.** Headers `x-device-proof-key`, `-timestamp` (13 digit epoch ms),
    `-nonce` (base64url of 16 random bytes, `^[A-Za-z0-9_-]{16,64}$`), `-signature`; the message is
    seven lines, version `kd-proof-v1` first; `REQUEST_PROOF_WINDOW_MS` is 120 s on both sides and
    `0088` caps the stored expiry at ten minutes. Anything that signs must use
    `requestProofMessage()` - never a hand built string.
  - **Body text, once.** A route that needs a proof must `await request.text()` once, hand that
    string to `verifySensitiveRequest` and `JSON.parse` the same string. Reading again invalidates
    the digest.
  - **Adding an endpoint is two edits and one gate.** `SENSITIVE_ENDPOINTS` in
    `lib/auth/request-proof.ts`, the call in the route, and `checkRequestProof()` proves the pair.
  - **`trusted_at` is still STEP 052's.** The check reports `trusted` in its outcome and enforces
    nothing; when 052 lands the trust step, decide there whether an untrusted key may mint backup
    codes - do not add the rule to `verifySensitiveRequest` without an equivalent gate check.
  - **054 revokes, it does not delete.** `0088`'s composite foreign key into
    `device_proof_keys (user_id, id)` has no cascade, and revoking a device is `revoked_at`, not a
    row delete: the spent nonces stay as history, and a revoked device is refused at the row lookup
    (`unknown-device`) before any nonce is read. A hard delete would fail on that key, which is the
    constraint doing its job.
  - **055 should rate limit the three guarded routes by address *and* device id.** The headers are
    refused cheaply before any query, so a limiter can key on `x-device-proof-key` without trusting
    it, exactly as `/api/auth/devices` is planned to be limited.
  - **No new screen and one new sentence.** `lib/i18n/strings/en.ts` gained only
    `device.proofRequired`; the copy avoids the word "token" because the i18n gate and the error
    gate both treat it as a secret shaped word.
