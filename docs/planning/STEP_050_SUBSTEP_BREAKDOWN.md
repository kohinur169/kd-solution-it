// path: docs/planning/STEP_050_SUBSTEP_BREAKDOWN.md
# STEP 050 - Sub-step breakdown

STEP 050: LR-022 request signature verification on sensitive endpoints.

Source of scope: `docs/final/STEP_PLAN_250.md` line 664, `docs/final/FEATURE_LIST.md` section 22
line 244 ("session-bound cookie ... per-device proof key ... a cookie works only inside its own
session"), `docs/final/MASTER_PROMPT.md` rules 4, 5, 9, 10, 11, 16,
`migrations/0009_device_proof_keys.sql` + `0010_sessions.sql` (the row and the binding),
`docs/handoffs/STEP_049_COMPLETED.md` (which named this STEP and left the signing half unbuilt).

## Owned paths

| Path | Why this STEP owns it |
| --- | --- |
| `migrations/0088_request_proof_nonces.sql` / `.down.sql` (new) | The replay guard: one row per accepted nonce, unique per device. |
| `lib/auth/proof-key.ts` | The isomorphic signing half: the canonical request message, the body digest, `signProofMessage`, `verifyProofMessage` and the header contract. |
| `lib/auth/request-proof.ts` (new) | The server half: the registry of sensitive endpoints and `verifySensitiveRequest`, which reads the headers, rebuilds the message, verifies it against the enrolled key and spends the nonce. |
| `app/api/auth/2fa/backup-codes/route.ts` | Sensitive: minting ten new ways in. |
| `app/api/office/2fa-reset-requests/decision/route.ts` | Sensitive: approving a reset removes a second factor. |
| `app/api/office/account-locks/unlock/route.ts` | Sensitive: section 22 names account unlocks explicitly. |
| `lib/auth/device-proof-store.ts` | The browser side: `deviceProofHeaders()` builds the four headers for one call. |
| `app/office/2fa-reset-requests/office-reset-queue.tsx`, `app/(auth)/2fa/settings/backup-codes-form.tsx` | The two screens that call a sensitive endpoint now sign with them. |
| `lib/i18n/strings/en.ts` | One sentence for a browser that has no key to sign with. |
| `lib/auth/verify.ts` | New `checkRequestProof()`. |
| `lib/auth/README.md` | Rules 67-70. |
| `docs/planning/STEP_050_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_050_COMPLETED.md` | This STEP's documents. |

Nothing in `package.json`.

## The shape of a proof

Four headers, one canonical message, one signature:

```
x-device-proof-key        the device row id
x-device-proof-timestamp  epoch milliseconds, digits only
x-device-proof-nonce      base64url, 16 random bytes
x-device-proof-signature  base64url of the signature
```

The message is six newline separated lines, so no field can be shifted into another:

```
kd-proof-v1
<METHOD>
<path>            (pathname only; a proof-carrying request with a query string is refused)
<sha256 of the raw body, base64url | "-" for an empty body>
<timestamp>
<nonce>
<device row id>
```

The signature is over those bytes: ES256/ES384 through ECDSA with SHA-256/SHA-384, EdDSA through
Ed25519 - the same three algorithms `0009` allows, verified with the `public_key` and `algorithm` of
the row the header names.

## Sub-steps, in order

1. **Recon.** Read the plan, section 22, `0009`, `0010`, the 049 handoff, the three candidate routes
   and the two client screens that call them. Confirmed: no nonce storage exists anywhere, and every
   sensitive route today trusts the cookie alone.
2. **Migration `0088`.** `request_proof_nonces`: the device, the nonce, the method, the path, the
   signed instant and the instant the row stops being useful, with a unique index on
   `(device_proof_key_id, nonce)` as the replay guard, a cleanup index on `expires_at`, the row
   metadata trigger, RLS and the default-deny policy. Rollback drops the table and nothing else;
   PGlite proof and negative controls before it is committed.
3. **`lib/auth/proof-key.ts`.** `requestProofMessage`, `sha256Base64Url`, `signProofMessage` (the
   browser half, on the non-extractable key), `verifyProofMessage` (the server half, importing the
   stored SPKI), the header names, the nonce pattern and the 120 second window.
4. **`lib/auth/request-proof.ts`.** `SENSITIVE_ENDPOINTS` (method plus path plus why) and
   `verifySensitiveRequest`: refuse a query string, refuse a path that is not registered, refuse a
   timestamp outside the window, read the live key **of the actor's own account**, verify the
   signature, then insert the nonce - a conflict there is a replay. Every refusal is one `401`
   `AUTHENTICATION_REQUIRED` and one `user.request_proof_rejected` audit entry whose payload carries
   the reason and never the signature.
5. **The three routes.** Each reads the raw body once, resolves the actor, verifies the proof, and
   only then parses the body - so a tampered body fails the signature before any parser sees it.
6. **The browser.** `deviceProofHeaders()` signs one call; the office queue and the backup code
   screen use it. A browser with no key shows one sentence (`device.proofRequired`) instead of
   sending a request that would be refused.
7. **`checkRequestProof()`.** Real signatures for all three algorithms, tampering with every field of
   the message, the known digest vector of the empty string, the window on both sides, a foreign
   device, a revoked device, an untrusted device (allowed, reported), the replay of one nonce, the
   registry against the route files on disk, and the audit entry of every refusal.
8. **Gates.** `tsc --noEmit`, `eslint .`, `node lib/auth/verify.ts`, `npm run verify`, live probes,
   negative controls, one commit, push, handoff, report.
