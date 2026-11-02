// path: docs/handoffs/STEP_040_COMPLETED.md
# STEP 040 Completed - Handoff

## STEP
- Number and title: STEP 040 - Password policy enforcement and breached password check.
- Category: Authentication and Session Security (STEP 037-055).
- Depends on (earlier STEPs and their handoff files): STEP 006 (the catalog, which now carries the
  four rules and two refusal sentences), STEP 008 (the envelope and the detail shape
  `{field, rule}`), STEP 036 (`0080`, the setting registry this STEP seeds a row into), STEP 037 (the
  transport every upstream call goes through, including the one this STEP extends), STEP 038
  (signup, its form, and the interim password shape this STEP replaces), STEP 039 (the sign in that
  shares the hash functions and proves an existing verifier still verifies).
  The split of this STEP is `docs/planning/STEP_040_SUBSTEP_BREAKDOWN.md`: **040A** the policy,
  **040B** the breach check.

## Files
- Created:
  - `migrations/0081_password_breach_setting.sql` + `.down.sql` - seeds
    `password.breach_check.enabled = true` in the registry of `0080`, and retires it on rollback.
  - `lib/auth/breach-check.ts` - the SHA-1 prefix, the range parser, the three verdicts and the
    transport call that carries five characters and never a password.
  - `docs/planning/STEP_040_SUBSTEP_BREAKDOWN.md`, this file.
- Modified:
  - `lib/auth/password.ts` - `passwordRuleViolation`, `characterKindsIn`, the rule vocabulary and the
    full `assertPasswordAcceptable(password, context)`; `hashPassword` and `verifyPasswordHash`
    unchanged.
  - `lib/auth/http.ts` - `responseFormat: "text"` for the one endpoint that answers plain text.
  - `lib/auth/registration.ts` - the check after the challenge and before the provider, the breach
    refusal, and the verdict in the audit payload.
  - `lib/auth/runtime.ts` - the check, with its own response ceiling.
  - `app/api/auth/signup/route.ts` - passes the check.
  - `app/(auth)/signup/signup-form.tsx` - the four rules, and a refusal that names the rule.
  - `lib/auth/README.md`, `lib/auth/verify.ts` - rules 25-27 and the checks.
  - `lib/i18n/strings/en.ts` - the rule list and the two refusal sentences.
- Not touched: the sign in page, the recovery flow, the dashboard, `package.json`.

## Database
- Migration: `0081_password_breach_setting.sql` (forward) and `.down.sql`.
- Rollback verified on a clean database: **yes**, on PostgreSQL 18.6 (PGlite 0.5.14). The full chain
  (81 files) was applied, and then:
  - the seeded row reads `true`, `is_secret = false`, `jsonb_typeof(value) = 'boolean'`;
  - a second insert of the same key is refused by `platform_settings_key_key`;
  - the down file retires the row (`deleted_at` set, value `false`) and the live projection drops it;
  - re-applying the forward file inserts a fresh live row, because the unique index is partial over
    live rows, and a reader asking `deleted_at is null` sees `true` again.
- One real defect was found by that proof and fixed before the commit: the rollback first used
  `delete`, which the guard trigger of `0080` refuses with "a platform setting is disabled, never
  removed". The rollback now retires the row instead of disabling a guard for one statement, which
  keeps the registry's own rule intact.

## Environment
- No new variable. The breached password corpus needs no key, which is why the switch is a platform
  setting and not an environment entry.

## Packages
- No package was added or removed. Nothing is requested for this STEP.
- Still outstanding from STEP 037 and now covering four STEPs of code: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` in `package.json`, and insert
  `npm run check:auth` into `verify` immediately before `npm run check:lint`.

## Behaviour Proof (acceptance checklist)
1. The policy is enforced on the server and named rule by rule. Twelve to one hundred and twenty
   eight characters, no surrounding space, six distinct characters, three of the four character
   kinds, and no word of the address, the business name or the person's name; a detail is
   `{field: "password", rule}` and never a value.
2. The four rules are shown before anything is typed, in the signup form, in the catalog's words, and
   a refusal turns the rule into a sentence the merchant can act on - including the breach sentence,
   which is the only one that says "do not reuse that password anywhere".
3. Every verifier written by STEP 038 still verifies: the stored string carries its parameters and
   `verifyPasswordHash` accepts exactly those.
4. A breached password is refused before any row exists and before the provider is asked, with
   `VALIDATION_FAILED {field: "password", rule: "breached"}`.
5. Only five hexadecimal characters of the SHA-1 leave the process. The gate asserts the URL, that
   the suffix never appears in it, the `add-padding` header, the text format, the absent key, and
   that a padded zero count is `clear`.
6. The verdict is a fact: `merchant.signed_up` carries `breach_check: "clear" | "skipped"`, and a
   skipped check is still a signup, which the gate proves separately from a refusal.
7. The switch is seeded open by a migration. Closed outside production is `skipped`; closed inside
   production is a `DEPENDENCY_FAILED`, because a control nobody performs must not be reported as a
   control that passed.
8. A corpus outage and a body that is not a range are `DEPENDENCY_FAILED` and
   `malformed-response`, never a quiet pass.

## Verification
- Typecheck result: `npm run typecheck` passes with no output.
- Lint result: `npm run lint` and `npm run check:lint` pass; twenty-six rules as errors.
- Build result: `npm run build` succeeds with the same routes as STEP 039.
- Gate: `node lib/auth/verify.ts` prints `auth gate passed: 656 checks, cookie "__Host-kd_session",
  8 chunk ceiling` (602 after STEP 039, 54 added here).
- `npm run check:migrations` prints `2393 checks, 81 migrations, 70 tables` (2373 before).
- `npm run verify` exits 0 with every gate, the typecheck, the lint and the build in sequence.
- Live check against `npm run dev`: `/signup` answered `200` and rendered the four rules, and a weak
  body answered `422` with a catalogue detail, so the policy is enforced on the server and explained
  in the form.
- The corpus itself was **not** called from this sandbox: `api.pwnedpasswords.com` is outside the
  sandbox's egress allowlist. The range call is proven through the injected transport, which is the
  same `AuthHttp` the client and the Turnstile guard use, and the parser is proven against a real
  shaped answer including padding. The first deployment with outbound HTTPS performs the first live
  call.

## Next
- Next STEP number: STEP 041 - 2FA TOTP enrollment with QR code and backup codes.
- Anything the next chat must know:
  1. `assertPasswordAcceptable` now takes `{email, companyName?, fullName?}`. A caller that has a
     person's details must pass them, because the identity rules are most of the policy's value; the
     gate fails on the old single string signature.
  2. `passwordRuleFailure(rule)` is exported so a later flow (reset, change) refuses with the same
     vocabulary and the same field name. `breach-check.ts` is the model for that reuse: a service
     takes the check as a dependency and the gate injects `createFixedBreachCheck`.
  3. `http.ts` now has `responseFormat: "text"`. It exists for this endpoint; a JSON endpoint must
     keep the default, because a text parse of a JSON body would hide a malformed answer.
  4. TOTP of STEP 041 needs a secret in `users.totp_secret_ciphertext` (0003) sealed with
     `ENCRYPTION_MASTER_KEY`; `lib/auth/secrets.ts` already does AES-256-GCM with the setting key as
     associated data, so a second use of it should pass its own context string rather than reuse the
     setting one.
  5. The attempt table already accepts `factor = 'totp'` and the outcome `challenged`, so STEP 042
     needs no schema change and no new recorder.
