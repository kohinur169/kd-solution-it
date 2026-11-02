// path: docs/handoffs/STEP_049_COMPLETED.md
# STEP 049 Completed - Handoff

Feature: **LR-022 device proof key generation and registration in browser**
(`docs/final/STEP_PLAN_250.md` line 652), from `docs/final/FEATURE_LIST.md` section 22 line 244
("per-device proof key" inside LR-022), on the table STEP 015 built
(`migrations/0009_device_proof_keys.sql`) and the seam STEP 048 closed.
Commit: `STEP 049: LR-022 device proof key generation and registration in browser`.

## What was delivered

1. **`lib/auth/proof-key.ts`** - the isomorphic half, written against WebCrypto only so the browser,
   the server and the gate run the same code:
   - `generateProofKeyPair()` asks `crypto.subtle.generateKey` for a pair whose private half is
     **non-extractable**, then exports only the SPKI public half;
   - `proofKeyFingerprint()` is the base64url SHA-256 of the canonical SPKI bytes, which is exactly
     the 43 character value in `0009`'s `^[A-Za-z0-9_-]{43,128}$` check;
   - `encodeBase64Url` / `decodeBase64Url` are strict both ways - padding, `+`, `/` and an impossible
     length are refused rather than repaired;
   - `proofKeyLabel`, `isPublicKeyShape`, `isStoredProofKey`, `publicProofKeyOf`, the algorithm list
     (`ES256`, `ES384`, `EdDSA`) and the column bounds, restated so a caller can refuse early.
2. **`lib/auth/device-proof-store.ts`** - the browser half. The pair lives in IndexedDB under one
   record (a `CryptoKey` cannot go into `localStorage` as bytes, which is the point of a
   non-extractable key). `enrolDeviceProofKey()` generates on first use, posts
   `{publicKey, algorithm}` to `/api/auth/devices`, and adopts the server's fingerprint, device id
   and trust flag. Every failure is a typed reason, never an exception the sign in has to survive.
3. **`lib/auth/device-enrolment.ts`** - the server half:
   - `inspectProofKey` decodes strictly, parses the DER with `createPublicKey`, **checks the curve
     against the declared algorithm** (P-256/ES256, P-384/ES384, Ed25519/EdDSA), re-exports SPKI and
     hashes the bytes it produced, not the bytes it received;
   - `enrolDeviceProofKey` reads the live keys of the account, answers `already_enrolled` for the same
     fingerprint (moving `last_seen_at`), enforces a ceiling of ten live devices (`CONFLICT`), inserts
     with `trusted_at` null, audits, and turns a `device_proof_keys_live_key` conflict into
     `already_enrolled` from the losing side.
4. **`app/api/auth/devices/route.ts`** - `POST` only, session scoped through `readRequestActor`,
   4 KiB body ceiling, `201` for a new key and `200` for a re-enrolment, `cache-control: no-store`,
   and one log line naming the device id and the algorithm.
5. **The browser actually does it.** `app/(auth)/signin/signin-form.tsx` reads the
   `deviceProofRequired` flag from both success answers - the single factor one and the one after a
   correct code - and enrols before navigating. The enrolment is awaited but never allowed to block
   or fail the sign in: a browser without WebCrypto, a storage that refuses or an endpoint that is
   down leaves the merchant signed in and the server asking again next time.
6. **The route is classified.** `lib/auth/disclosure.ts` lists `/api/auth/devices` in
   `SESSION_AUTH_SURFACES` with the sentence that says why its answers may name a device. STEP 048's
   gate failed on the unclassified route before this line existed, which is the seam working.
7. **`checkDeviceProofKey()`** - 76 new checks: base64url in both directions, a real generated pair
   (non-extractable private half, exportable public half), the fingerprint's length and pattern, the
   server accepting what the browser made for all three algorithms and refusing garbage, a padded
   string, a short string, an unknown algorithm and a curve that contradicts its algorithm; then the
   row, the label, the audit entry, the idempotent second call, another account's identical
   fingerprint, the ceiling, the race, the replaceable revoked key, the strict request shape, the
   label cut and the store's guard.

## State before the first edit

Clean tree at `2e013c6`, `HEAD` equal to `origin/arena/1dc51ec3-kd-solution-it`, every gate green, and
no dev server running. No pre-existing defect. The gap this STEP filled was the one the schema left
open by design: `0009` had a table, a composite foreign key into `sessions` and a comment about "the
private half never leaves the browser", and no browser in this repository had ever made one.

## Design notes worth keeping

- **Non-extractable is the whole feature.** A proof key that could be exported is a bearer token
  dressed as a device. A copy of the IndexedDB database is therefore a key an attacker can use only
  through the same origin, never bytes they can carry to another machine - which is why STEP 050 must
  verify the signature *in addition to* the cookie, never instead of it.
- **The server owns the fingerprint.** The browser computes one because it must store something
  stable, and the server recomputes it from the key it parsed and answers with its own. The field is
  not accepted as input at all (`deviceEnrolmentSchema` is strict), so a client cannot write its own
  identifier into a unique index.
- **A parsed key, not a pattern.** 122 characters of base64url is not a public key. `createPublicKey`
  plus a curve check is what makes STEP 050's verification meaningful, and it is also what refuses a
  P-384 key that claims to be ES256.
- **Enrolment is idempotent because browsers are not.** Two tabs, a retry after a lost answer and a
  cleared site data all produce a second call with the same or a new key; the first is
  `already_enrolled`, the second is a second device. Only a new key is a new device.
- **A ceiling exists because a table needs one.** Ten live devices, answered as `CONFLICT` rather
  than as a form problem, because the form was right and the account is full. A deployment may lower
  it (`maximumDevices`), which the gate uses.
- **Enrolling is not trusting.** Every row is written with `trusted_at` null and the response says
  `trusted: false`. Section 22's confirmation is STEP 052's, so nothing in this STEP makes a session
  stronger.

## Database

- Migrations added: **none**. `0009_device_proof_keys.sql` already carries the fingerprint check, the
  public key check, the algorithm check, the label check, the `(user_id, id)` composite key that
  `0010_sessions.sql` references and the partial unique index that lets a revoked key be replaced.
- Rollback verified on clean database: not applicable.

## Environment

- Environment variables added to `.env.example`: none.
- Secrets handled (names only, never values): none. The registration endpoint uses the existing
  service role client through `lib/auth/runtime.ts`.

## Packages

- No new dependency: WebCrypto, IndexedDB and `btoa`/`atob` are platform APIs, and `node:crypto`
  supplies the only server side parse.
- The standing integrator request from STEP 047 is still open: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` and insert `npm run check:auth` into
  `verify` immediately before `npm run check:lint`.

## Behaviour proof (acceptance checklist)

- **The browser half, run under Node's WebCrypto.** `generateProofKeyPair()` (the module the browser
  loads) produces a pair whose `privateKey.extractable` is false and whose `publicKey.extractable` is
  true; the exported SPKI is 122 base64url characters; the fingerprint is 43 characters and matches
  `0009`'s pattern; `usages` includes `sign`.
- **One fingerprint, two sides.** `inspectProofKey(publicKeyBase64Url, "ES256")` returns the same
  `fingerprint` the browser computed and the canonical encoding it received.
- **All three algorithms.** ES384 and EdDSA pairs generated through the shared module are accepted as
  themselves and refused as ES256.
- **Refusals.** Non-DER bytes, a padded string, a 31 character string, an algorithm outside the
  column and a non-string are all `null` from `inspectProofKey`, which the service turns into one
  `422 VALIDATION_FAILED` with `{field: "publicKey", rule: "invalid_key"}` - a rule that names the
  field and never the value.
- **The row.** One row, `trusted_at` null, `label` "Chrome on macOS" from the agent, the account's id
  and company, the canonical public key, the server's fingerprint, the declared algorithm.
- **The audit entry.** `user.device_enrolled` with `entityType: "device_proof_key"`, the device id,
  `trusted: false`, the algorithm and the label - and the payload does not contain any part of the
  key.
- **Idempotence.** The second call for the same key answers `already_enrolled`, writes no second row,
  moves `last_seen_at` and appends `user.device_proof_refreshed`.
- **Isolation.** The same fingerprint under another account neither blocks this account's enrolment
  nor is modified by it.
- **The ceiling.** With a ceiling of one, a second key is `409 CONFLICT`, writes no row and no audit
  entry.
- **The race.** With the read blinded so the service does not see the row, the insert collides with
  `device_proof_keys_live_key` and the answer is `already_enrolled` with one row.
- **A revoked key is replaceable** and the revoked row stays as history.
- **The request shape** is strict: a third field is refused, and the exact object the browser sends
  is accepted.
- **API shapes over HTTP** (live, port 3000, server stopped afterwards): no cookie `401
  AUTHENTICATION_REQUIRED`; `GET` `405`; malformed JSON `422` with the `publicKey` / `invalid_key`
  detail; a 5 000 character body `413 PAYLOAD_TOO_LARGE`; `/signin` still renders `200` with the new
  client module. This sandbox has no Supabase project, so a real enrolment cannot be exercised over
  HTTP here - the service is proven by the gate.
- **UI checks.** No new copy and no new screen: enrolment is silent by design, and the network panel
  shows one `POST /api/auth/devices` after a sign in that reported `deviceProofRequired`. The sign in
  form was re-checked at desktop and mobile widths and its layout is unchanged.

## Verification

- `node lib/auth/verify.ts`: **1 506 checks** (1 428 before this STEP), including the new
  `checkDeviceProofKey()`.
- `npm run verify`: exit 0 - structure 16 directories / 13 root files / **135 source files**, config 10
  sections / 28 values, i18n **205 messages / 8 placeholders** (unchanged: this STEP adds no copy),
  logger 117, errors 202 checks / 15 codes, lint 77 checks / 26 rules, shell 178 checks / 37 files,
  jobs 110 checks, migrations **2 535 checks / 87 migrations / 72 tables**, type check, lint, and the
  production build.
- `npx tsc --noEmit` and `npx eslint .` clean; no `any`, no `console.log`, no new dependency.
- Negative controls, each restored afterwards, each confirmed to fire:
  - `extractable: true` in `generateProofKeyPair` -> "the private half cannot be exported (expected
    false, received true)";
  - the curve check removed from `inspectProofKey` -> 4 problems (a P-384 key accepted as ES256, an
    Ed25519 key accepted as ES256, and the service accepting the mismatch);
  - the device ceiling removed -> 4 problems (`nothing was rejected`, a second row, a second audit
    entry);
  - `revoked_at=is.null` dropped from the live-key query -> 2 problems (a revoked key reported as
    already enrolled, and its row not replaced).
- `git diff` scope: 3 added source files, 1 added route, 4 modified files, 2 added documents.

## Next

- Next STEP: **050 - LR-022 request signature verification on sensitive endpoints**.
- Anything the next chat must know:
  - **The signing half does not exist yet, and its home is `lib/auth/proof-key.ts`.**
    `loadOrCreateDeviceProofKey()` returns the non-extractable private key and the algorithm;
    `algorithmParameters` there already carries the `sign` parameters for all three algorithms
    (`{name: "ECDSA", hash: "SHA-256"}` etc.), and an ES256 signature is 64 bytes of `r||s`, which
    base64url encodes to 86 characters. The server side needs `inspectProofKey` plus the stored
    `public_key` and `algorithm` of the row the request names.
  - **A signature is not a credential on its own.** It is evidence about the device *in addition to*
    the session cookie, and STEP 049's own rule 65 is why: an enrolment is untrusted (`trusted_at`
    null) until STEP 052.
  - **The device is named by `deviceId` in the browser store** (`StoredProofKey.deviceId`, filled
    from the enrolment answer), so a signature envelope can name the row without a second lookup by
    fingerprint.
  - **051** owns the `sessions` row and will bind `device_proof_key_id`; `0010`'s composite foreign
    key already enforces that a session may only name a device of its own account.
  - **052** owns `trusted_at`, the new device alert email (section 23) and the confirmation step; the
    service already reports `trusted: false` and the audit entry records `trusted: false`.
  - **054** owns the device list and revoke; the query shape it needs is in `readLiveDevices`
    (`user_id`, live only), and revoking a row frees its fingerprint for a replacement row.
  - **055** should include `/api/auth/devices` in the limiter: it is in the disclosure catalogue
    (`SESSION_AUTH_SURFACES`), every anonymous list already carries `RATE_LIMITED`, and this route's
    list would too.
  - **No copy was added**, so `lib/i18n/strings/en.ts` needs nothing for this STEP; if 052 wants a
    sentence about a new device, that is where it goes.
