// path: docs/planning/STEP_052_SUBSTEP_BREAKDOWN.md
# STEP 052 - Sub-step breakdown

STEP 052: **New device detection with email confirmation and 2FA step**
(`docs/final/STEP_PLAN_250.md` line 688), from `docs/final/FEATURE_LIST.md` section 22 line 244
("extra verification on a new device") and section 23 ("new device alert").

The schema has been ready since STEP 015: `device_proof_keys.trusted_at` is "null until the owner
confirms the new device by email and 2FA", and `email_send_logs.template_key` already carries the
`new_device_alert` activity email of section 23. STEP 049 wrote every row with `trusted_at` null and
handed the value to this STEP; STEP 051 bound sessions to those rows and reported `trusted` without
enforcing it. Nothing yet *asks* the owner, and nothing yet refuses an untrusted device.

## What "email confirmation" means here

Section 23 lists the new device alert among the *activity emails*: what the platform owes the owner
is that they find out. `email_send_logs` carries a template key, a recipient and a reference, and the
per-send body is the email system's job (STEP 227 renders `email_templates`); there is no field for a
per-send secret and inventing one would be a change to STEP 032's table for another STEP's worker.

So this STEP implements exactly what the feature list asks for and the schema can carry:

- **detection** - a session bound to a device whose `trusted_at` is null is a new device, and the
  platform records a challenge for it;
- **the alert** - one `new_device_alert` queue row names the device, the address, the agent and the
  instant, so the owner learns about it whether or not they are looking at the screen;
- **the 2FA step** - the device becomes trusted only when the person holding the session proves the
  second factor, which is the part that a stolen password cannot satisfy.

The conflict with the STEP title's "email confirmation" - a mailbox cannot confirm anything in this
platform, because no email can carry a code - is written into the handoff.

## Sub-step 1 - Read the contract

`FEATURE_LIST.md` section 22 and section 23, `MASTER_PROMPT.md`, the STEP 051 handoff (its "Next"
section hands this STEP the trust decision), `migrations/0009_device_proof_keys.sql`,
`migrations/0061_email_send_logs.sql`, `lib/auth/lock-alert.ts` (the shape a queued alert takes),
`lib/auth/two-factor-login.ts` and `lib/auth/totp.ts` (the second factor check), and
`lib/auth/device-enrolment.ts`.

## Sub-step 2 - Owned paths

New: `migrations/0090_device_trust_challenges.sql` (+ rollback), `lib/auth/device-trust.ts`,
`app/api/auth/devices/confirm/route.ts`, `app/(auth)/devices/confirm/page.tsx` and its client form,
the two documents.

Modified: `lib/auth/request-proof.ts` (`requireTrustedDevice`, the refusal the three dangerous
endpoints now make), `app/api/auth/session/rotate/route.ts` (detection and the answer's `deviceTrust`),
`app/api/auth/2fa/backup-codes/route.ts`, `app/api/office/2fa-reset-requests/decision/route.ts` and
`app/api/office/account-locks/unlock/route.ts` (they call it), `lib/auth/disclosure.ts`,
`lib/auth/device-proof-store.ts` (the browser reads the flag the binding answered),
`app/(auth)/signin/signin-form.tsx` (a new device lands on the confirmation), `lib/auth/verify.ts`,
`lib/auth/README.md` and `lib/i18n/strings/en.ts`.

`lib/auth/runtime.ts`, `app/api/auth/devices/route.ts` and the settings page were left alone on
purpose: the rotate route already holds `rest`, `audit`, `logger` and `masterKey`, so no runtime port
was needed, and the enrolment answer does not carry the flag - the binding is the request that knows
it.

## Sub-step 3 - Database: `0090_device_trust_challenges.sql`

One row per "this device wants to be trusted": the account, the device (through the composite key
`device_proof_keys (user_id, id)`, so a challenge can never name somebody else's device), the alert
it queued (`email_send_logs`, so the two facts cannot disagree), the attempt counter with its budget,
its window and its end. A partial unique index allows one live challenge per device, so a reload
cannot mint a second one; `dead ends` are `consumed_at` (the code was right) or `revoked_at` (a
later challenge replaced it). Everything else is the platform's standard row: audit columns, the
metadata trigger, RLS and default deny.

Rollback drops the table and nothing else. Proof: PGlite, forward, back, forward again, plus negative
controls on the unique index, the window ceiling, the composite device key and the attempt budget.

## Sub-step 4 - Core service `lib/auth/device-trust.ts`

- `NewDeviceNotifier` - the port the rotate route calls: queue one `new_device_alert` row for the
  account (recipient is the account's own address, reference `account`/user id) and answer an
  outcome, never an exception. It mirrors `lock-alert.ts`, including the "sender not configured"
  answer, so a deployment without SMTP still records the challenge.
- `challengeDeviceTrust` - create or reuse the live challenge of a device, link the alert row, and
  audit `device.trust_challenged`. Called only when a *new* session binds to an untrusted device.
- `confirmDeviceTrust` - the 2FA step and the write: the device must belong to the actor and be the
  one the session is bound to, the challenge must be live, the code must verify against the
  account's sealed TOTP secret, a wrong code spends an attempt and answers a form-shaped refusal, and
  success stamps `trusted_at`, consumes the challenge and audits `device.trusted`.
- `readDeviceTrust` - the two facts a screen needs: whether the row is trusted and whether a
  challenge is live.

## Sub-step 5 - Wiring

- The rotate route answers `deviceTrust: "trusted" | "untrusted"` on a `bound` answer - only a bind
  starts a session, so only a bind is a new device - and calls `challengeDeviceTrust` there.
- `POST /api/auth/devices/confirm` - bound session, `{deviceId, code}`, and the three answers:
  `trusted`, `already_trusted`, or a `422` naming the field and the rule.
- `lib/auth/disclosure.ts` classifies the route.

## Sub-step 6 - UI

`/devices/confirm` - the screen a new device lands on: the device label the account gave it, the
authenticator code field, one button, and one sentence per refusal (`invalid_code`,
`challenge_expired`, `attempts_exhausted`, `two_factor_required`). A confirmed device that opens the
page reads "this device is confirmed" instead of a form. The sign in form routes there when the
binding answer says the device is untrusted, on both the password step and the second factor step.
The device itself is never a field: the route reads it from the session and the form reads it from
the key this browser stored at enrolment, so a typed id cannot be confirmed. Desktop and mobile
widths checked at the same time as the other auth screens.

## Sub-step 7 - Security proof

`verifySensitiveRequest` keeps reporting `trusted` and does not refuse, because every key the
platform creates starts unconfirmed and the enrolment has to stay reachable from the device that has
to be confirmed. The refusal lives one line away, in `requireTrustedDevice`, and the three sensitive
endpoints call it: an unconfirmed device may not mint ten backup codes, approve a reset or unlock an
account. The refusal is `403 PERMISSION_DENIED`, not `401`, so a screen can act on it.
`checkDeviceTrust()` in `lib/auth/verify.ts` proves the detection, the alert, the reuse, the second
factor, the attempt budget, the window, the ownership rules, the audit entries and the routes that
carry all of it.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npm run lint`, `node lib/auth/verify.ts`, `node lib/i18n/verify.ts`,
`npm run verify`, the PGlite proof of `0090`, negative controls, then one commit
`STEP 052: New device detection with email confirmation and 2FA step`, pushed to
`arena/1dc51ec3-kd-solution-it`, with `docs/handoffs/STEP_052_COMPLETED.md`.
