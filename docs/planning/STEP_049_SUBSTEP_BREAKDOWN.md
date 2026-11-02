// path: docs/planning/STEP_049_SUBSTEP_BREAKDOWN.md
# STEP 049 - Sub-step breakdown

STEP 049: LR-022 device proof key generation and registration in browser.

Source of scope: `docs/final/STEP_PLAN_250.md` line 640, `docs/final/FEATURE_LIST.md` section 22
line 244 ("per-device proof key" inside LR-022), `docs/final/MASTER_PROMPT.md` rules 4, 5, 10, 11,
16, `migrations/0009_device_proof_keys.sql` (the table STEP 015 built for this), rule 28 of
`lib/auth/README.md` (which named the browser half as this STEP's), and
`docs/handoffs/STEP_048_COMPLETED.md`.

## Owned paths

| Path | Why this STEP owns it |
| --- | --- |
| `lib/auth/proof-key.ts` (new) | The isomorphic half: algorithms, strict base64url, the fingerprint, and key pair generation through WebCrypto. No DOM, no `node:crypto`, so the browser and the gate run the same code. |
| `lib/auth/device-proof-store.ts` (new) | The browser half: IndexedDB custody of the non-extractable private key, and the registration call. Browser only; nothing imports it on the server. |
| `lib/auth/device-enrolment.ts` (new) | The server half: `inspectProofKey` (a real cryptographic parse through `node:crypto`) and `enrolDeviceProofKey`, which owns the row, the cap, the race and the audit entry. |
| `app/api/auth/devices/route.ts` (new) | `POST /api/auth/devices`, the session-scoped boundary. |
| `app/(auth)/signin/signin-form.tsx` | The browser calls the enrolment after a sign in that reported `deviceProofRequired`, for both the single-factor and the second-factor path. |
| `lib/auth/disclosure.ts` | The new route is added to `SESSION_AUTH_SURFACES`; STEP 048's gate fails on an unclassified route, which is exactly the seam it documented. |
| `lib/auth/verify.ts` | New `checkDeviceProofKey()`, added to the run list. |
| `lib/auth/README.md` | Rules 63-66. |
| `docs/planning/STEP_049_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_049_COMPLETED.md` | This STEP's documents. |

No migration: `0009_device_proof_keys.sql` already has the fingerprint check, the public key check,
the algorithm check, the label check, the composite key the sessions table needs and the partial
unique index that lets a revoked key be replaced. Adding a column would be inventing a fact the
schema already stores. Nothing in `package.json`.

## Sub-steps, in order

1. **Recon.** Read the plan, section 22 line 244, `0009`, `0010` (the `device_proof_key_id` foreign
   key and why a key exists before a session), rule 28 of the auth README, the sign in service's
   `deviceProofRequired` and both routes that report it. Confirmed: the private half has never
   existed, so a session could not be device bound and no signature could ever be verified.
2. **`lib/auth/proof-key.ts`.** `PROOF_KEY_ALGORITHMS` (`ES256`, `ES384`, `EdDSA`), strict base64url
   in both directions (padding, `+` and `/` refused), `proofKeyFingerprint` as the base64url SHA-256
   of the canonical SPKI - the value `0009`'s `fingerprint` check expects - and
   `generateProofKeyPair()`, which asks WebCrypto for a **non-extractable** private key and exports
   only the public half.
3. **`lib/auth/device-enrolment.ts`.** `inspectProofKey` decodes the key, parses it with
   `createPublicKey`, refuses a curve that does not match the declared algorithm, re-exports SPKI as
   the canonical bytes and computes the fingerprint **on the server**. `enrolDeviceProofKey` reads
   the live keys of the account, retries as `already_enrolled` on the same fingerprint, enforces a
   cap of ten devices, inserts with `trusted_at` null (section 22 trusts a new device only after
   STEP 052's confirmation), audits, and turns a unique-index conflict into `already_enrolled`.
4. **`app/api/auth/devices/route.ts`.** Session scoped via `readRequestActor`; 4 KiB body ceiling;
   `201` for a new key, `200` for a re-enrolment; `cache-control: no-store`; one log line naming the
   device id and the algorithm, never the key.
5. **`lib/auth/device-proof-store.ts` + the sign in form.** The browser generates the pair once,
   keeps it in IndexedDB, and posts only the public half, before navigating away from the sign in
   that said `deviceProofRequired`. A failure is silent: the server asks again on the next sign in,
   and nothing about the merchant's session depends on the key until STEP 050 verifies a signature.
6. **`lib/auth/disclosure.ts`.** The route is classified as session scoped, with the sentence that
   says why its answers may name a device.
7. **`checkDeviceProofKey()`.** Real keys: generation, non-extractability, SPKI export, fingerprint
   length and pattern, `inspectProofKey` accepting a generated key and refusing garbage, a padded
   string, a P-384 key declared `ES256` and an Ed25519 key declared `ES256`; the service: one row
   with `trusted_at` null and the derived label, the audit entry, the idempotent re-enrolment, the
   ten device cap, the race, another account's identical fingerprint not interfering, and a revoked
   key being replaceable.
8. **Gates.** `tsc --noEmit`, `eslint .`, `node lib/auth/verify.ts`, `npm run verify`, negative
   controls, one commit, push, handoff, report.
