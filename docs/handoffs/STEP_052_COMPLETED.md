// path: docs/handoffs/STEP_052_COMPLETED.md
# STEP 052 completed - New device detection with email confirmation and 2FA step

Branch `arena/1dc51ec3-kd-solution-it`, base `a662576` (STEP 051).
Source: `docs/final/STEP_PLAN_250.md` line 688; `docs/final/FEATURE_LIST.md` section 22 line 244
("extra verification on a new device") and section 23 ("new device alert").

## What the STEP title asks for, and what the platform could honestly build

The title says "email confirmation". This platform cannot confirm anything through a mailbox: a
confirmation needs a per-send secret, `email_send_logs` (`0061`) has no column for one - it carries a
template key, a recipient, a reference and the delivery state, and the body belongs to the template
system of STEP 227 - and `0061` was committed in STEP 032. Inventing `new_device_code` there would
have changed a closed table for another STEP's worker to honour, and a column nobody reads is worse
than no column at all.

So the STEP is the three things the schema can carry, which is also exactly what the feature list
asks for:

- **detection** - a session that starts on a device whose `device_proof_keys.trusted_at` is null is a
  new device;
- **the alert** - one `new_device_alert` queue row goes to the account's own address, so the owner
  finds out whether or not they are looking at the screen;
- **the second factor** - the device becomes trusted only when the person holding the session proves
  the authenticator code, which is the part a stolen password cannot supply.

The consequence is written down rather than hidden: a merchant who receives the alert and does
nothing leaves the device unconfirmed, and the platform keeps the three dangerous actions closed for
it. The merchant confirms with the app they already have, or resets it through STEP 044 and confirms
afterwards.

## Sub-steps, in order

1. **Read the contract.** `FEATURE_LIST` section 22 and section 23, the STEP 051 handoff (its "Next"
   hands this STEP the trust decision), `0009`, `0010`, `0061`, `lib/auth/lock-alert.ts`,
   `lib/auth/two-factor-login.ts`, `lib/auth/totp.ts` and `lib/auth/device-enrolment.ts`.
2. **Owned paths**, recorded in `docs/planning/STEP_052_SUBSTEP_BREAKDOWN.md` before any code.
3. **Schema** - `migrations/0090_device_trust_challenges.sql` and its rollback.
4. **Service** - `lib/auth/device-trust.ts`.
5. **Wiring** - the rotate route, `POST /api/auth/devices/confirm`, the disclosure table, the browser's
   binding outcome, the sign in redirect.
6. **Screen** - `/devices/confirm` and its client form.
7. **Security proof** - `requireTrustedDevice` and `checkDeviceTrust()`.
8. **Gates, commit, push, handoff** - this document.

## Database - `0090_device_trust_challenges.sql`

One row per "this device wants to be trusted":

| column | meaning |
| --- | --- |
| `id`, `company_id`, `user_id` | the account the challenge belongs to |
| `device_proof_key_id` | the device, through the composite key `(user_id, id) -> device_proof_keys`, so a challenge can never name somebody else's device |
| `alert_send_id` | the `email_send_logs` row that told the owner; nullable, because a deployment without a sending method still records the challenge |
| `attempts`, `max_attempts` | the budget: `attempts between 0 and 10`, `max_attempts between 1 and 10`, `attempts <= max_attempts` |
| `issued_at`, `expires_at` | the window: `expires_at > issued_at` and at most 24 hours |
| `consumed_at`, `revoked_at` | the two ends; XOR, and a consumed instant must fall inside the window |
| `created_at`, `updated_at`, `deleted_at`, `version` | the platform's standard row plus the `set_row_metadata` trigger |

Indexes: `device_trust_challenges_live_device_key` (unique partial, one live challenge per device),
`device_trust_challenges_alert_key` (unique partial, one challenge per alert),
`device_trust_challenges_user_idx` (a person's live challenges, newest first),
`device_trust_challenges_expiry_idx` (the sweep). Default-deny RLS, one policy, no grants.

The rollback drops the table only: the trust already granted and the alerts already sent survive it.

Proof: PGlite 0.5.14 (wasm PostgreSQL 18.6) - forward, 47 checks (columns, the live-device and alert
uniqueness, the ownership key, the window ceiling, the attempt budget, consumption and revocation,
the four indexes, row level security and the rollback), rollback, forward again, plus five negative
controls (no live-device index, a non-partial challenge index, no window ceiling, a plain device
reference, no attempt budget) that each make the harness fail.

## Service - `lib/auth/device-trust.ts`

| export | what it decides |
| --- | --- |
| `challengeDeviceTrust` | create or reuse the live challenge of a device, queue one alert for it, audit `device.trust_challenged`. Outcomes are values: `challenged`, `already_open`, `already_trusted`, `no_device`, `failed` |
| `confirmDeviceTrust` | the second factor and the write. Ownership, then the session binding, then the live challenge, then the code, then `trusted_at` |
| `readDeviceTrust` | the facts a screen needs: trusted or not, when, whether a challenge is live, how many attempts remain |
| `requireTrustedDevice` (in `request-proof.ts`) | the refusal the dangerous endpoints make |

The alert follows `lock-alert.ts` exactly: the active `email_settings.method`, `getMessage`,
a `queued` row with `max_attempts`, and a lost race marked `dropped` with a reason. Nothing throws:
a queue that is down, a sender that is not configured, an account with no address and an audit chain
that refuses are all logged and answered as values, because a device nobody could be told about is
still a device to confirm.

The confirmation is a state machine with four refusals, each asking the person for something
different:

| refusal | rule | what it means |
| --- | --- | --- |
| wrong code | `invalid_code` | look at the app again; one of five attempts is spent |
| window ended | `challenge_expired` | sign in again to receive a new challenge |
| budget spent | `attempts_exhausted` | sign in again; the right code is refused too |
| no second factor | `two_factor_required` | finish the enrolment first, then confirm |

A session bound to a different device answers `403 PERMISSION_DENIED` before the code is read, so a
trusted machine cannot be used to trust a machine somebody else holds.

## Wiring

- `POST /api/auth/session/rotate` - on a `bound` answer only (a bind starts a session; a rotation is
  the same machine asking again) it calls `challengeDeviceTrust` and answers
  `deviceTrust: "trusted" | "untrusted"`. Nothing is refused there: a session that cannot exist yet
  cannot be asked to prove itself.
- `POST /api/auth/devices/confirm` - `{deviceId, code}`, session first then body, `200 trusted`,
  `200 already_trusted`, `422` with a field and a rule, `403` for another device, `413` past 1 KiB.
- `lib/auth/disclosure.ts` - the route joins `SESSION_AUTH_SURFACES`.
- `lib/auth/device-proof-store.ts` - `bindSession()` reports the flag the server answered.
- `app/(auth)/signin/signin-form.tsx` - an untrusted binding lands on `/devices/confirm`, from both
  the password step and the second factor step.
- `app/(auth)/devices/confirm/page.tsx` - a server component: the device comes from
  `sessions.device_proof_key_id`, never from a query string, and the form reads the id from the key
  the browser stored at enrolment.

## Security decision - who is refused

`verifySensitiveRequest` (STEP 050) now reports `trusted` and still does not refuse, because every key
the platform creates starts unconfirmed and the enrolment route has to stay reachable from the device
that has to be confirmed. The refusal is one line away, in `requireTrustedDevice`, and the three
endpoints that hand out a way in call it:

- `POST /api/auth/2fa/backup-codes` - ten fresh codes are ten ways in;
- `POST /api/office/2fa-reset-requests/decision` - an approval clears somebody's second factor;
- `POST /api/office/account-locks/unlock` - an unlock ends the lock that stopped a password guess.

The code is `403 PERMISSION_DENIED`, not `401`: the caller proved an account and a device, and a `401`
would read as "sign in again", which would change nothing.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `node lib/auth/verify.ts` | **1808 checks** (was 1724); `checkDeviceTrust()` adds 84 |
| `node lib/i18n/verify.ts` | 227 messages, 8 placeholders, 1 locale |
| `npm run check:migrations` | 2617 checks, 90 migrations, 74 tables |
| `npm run check:structure` | 16 directories, 13 root files, 143 source files |
| `npm run check:shell` | 198 checks, 42 files |
| `npm run verify` | exit 0 |
| PGlite proof of `0090` | forward/back/forward, 47 checks, 5 negative controls |

Mutation controls, each applied to the working tree, run, and restored: no alert queued, wrong
template key, no attempt spent, no session-binding check, challenge not consumed, no budget check,
code not verified, untrusted device allowed, sensitive route unguarded, rotation stops detecting,
confirmation forgets the session device, confirmation trusts before reading the code - **12 of 12
fired**. The first three route checks were too weak to catch their mutation (a substring search also
matched the `import` line); the gate now strips imports before searching, and all three fire.

Live probe on `npm run dev`: `GET /devices/confirm` answers `200` and the signed-out sentence;
`POST /api/auth/devices/confirm` answers `401` without a cookie, and `413` past 1 KiB;
`POST /api/auth/session/rotate` answers `401` without a cookie. The server was stopped afterwards.

## Deliberately not done

- **A code by email.** See the top of this document. The 2FA step is the authenticator, not a link.
- **An email template row.** `0060`/`0061` are closed and `new_device_alert` is already in the
  template check; the body of the mail is STEP 227's to render.
- **Enforcement inside `verifySensitiveRequest`.** A refusal there would break the enrolment path and
  every endpoint that reports the flag without acting on it.
- **A banner on the settings page.** The sign in redirect covers the flow that produces an untrusted
  device; a signed-in browser cannot become untrusted without a new sign in.
- **`package.json`.** Unchanged (see the request below).

## Package request (unchanged, still open)

`package.json` is the integrator's file, so this is a request and not an edit:

```json
"check:auth": "node lib/auth/verify.ts"
```

and `npm run check:auth` inside `verify`, before `check:lint`. Until it lands the auth gate is run by
hand, which is how every STEP since 050 has run it.

## Next

- **STEP 053 - step-up reauthentication** (`sessions.reauthenticated_at`). The seam: `confirmDeviceTrust`
  already reads the second factor for one action, and a step-up would reuse the same verification with a
  short window rather than a new mechanism.
- **STEP 054 - session and device list with revoke.** `revokeDeviceSessions` exists; `readDeviceTrust`
  returns the per-device facts a list needs.
- **STEP 055 - IP rate limiting.** `/api/auth/devices/confirm` is a code-guessing surface and needs the
  same bound as `/api/auth/2fa/verify`; `0090`'s five-attempt budget is the second line, not the first.
