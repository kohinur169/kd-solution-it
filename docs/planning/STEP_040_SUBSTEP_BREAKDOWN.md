// path: docs/planning/STEP_040_SUBSTEP_BREAKDOWN.md
# STEP 040 - Password policy enforcement and breached password check

Owner: STEP 040 of `docs/final/STEP_PLAN_250.md` (lines 544-555).
Feature anchors: `docs/final/FEATURE_LIST.md` line 55 (signup with breach password check),
line 232 (strong password policy and breached password check), line 245 (the same form runs
Turnstile).

## 1. What the STEP has to deliver

1. A policy, not a hint. The interim shape of STEP 038 (length, one repeated character, the address)
   becomes the policy of section 22, and every rule has a machine name a form and a log can share.
2. No password in a breach corpus is accepted. The check is a k-anonymity range query: five
   characters of the SHA-1 leave the process, the suffixes come back, and the comparison happens on
   this server.
3. The verdict is a fact in the database. The signup audit entry records `clear` or `skipped`, so
   "was this password checked" is answerable without a log line.
4. The switch is a platform setting, seeded open by a migration, so a deployment has the check on
   the day it starts and an operator who closes it is refusing a control on purpose.

## 2. Owned paths

| Path | Change |
| --- | --- |
| `migrations/0081_password_breach_setting.sql` + `.down.sql` | New: seeds `password.breach_check.enabled` |
| `lib/auth/password.ts` | Rewritten policy, verifier untouched |
| `lib/auth/breach-check.ts` | New: the range query, its parser and its three verdicts |
| `lib/auth/http.ts` | Extended: `responseFormat: "text"` for the one plain text endpoint |
| `lib/auth/registration.ts` | Extended: breach check before the provider, verdict in the audit payload |
| `lib/auth/runtime.ts` | Extended: the check and its own response ceiling |
| `app/api/auth/signup/route.ts` | Extended: passes the check |
| `app/(auth)/signup/signup-form.tsx`, `lib/i18n/strings/en.ts` | Extended: the rule list and two sentences |
| `lib/auth/README.md`, `lib/auth/verify.ts` | Extended: rules 25-27 and the checks |
| `docs/planning/STEP_040_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_040_COMPLETED.md` | New |

Not touched: the sign in page, the dashboard, the recovery flow (STEP 041+), `package.json`.

## 3. Sub-step 040A - the policy

1. `passwordRuleViolation` returns the first rule a value breaks, so the order of the checks is the
   order a person reads them, and `assertPasswordAcceptable` keeps its name so no caller can hold on
   to the old, weaker check.
2. The rules: twelve to one hundred and twenty eight characters, no surrounding space, six distinct
   characters, three of the four character kinds, and no word of the address, the business name or
   the person's name.
3. `hashPassword` and `verifyPasswordHash` are unchanged, which is why every verifier written by
   STEP 038 still verifies: the parameters travel inside the stored string.

## 4. Sub-step 040B - the breach check

1. `breachHashParts` gives the five character prefix and the remainder; only the prefix is sent.
2. `readBreachRange` parses `SUFFIX:COUNT` lines case insensitively, treats a zero count as the
   padding it is, refuses a body that is not a range at all, and bounds the number of lines.
3. `createBreachCheck` reads the switch, calls the range endpoint as plain text through the shared
   transport with `add-padding`, and answers `clear`, `breached` or `skipped`.
4. `registration.ts` calls it after the challenge and before the provider, refuses a breach as
   `VALIDATION_FAILED {field: "password", rule: "breached"}`, and records the verdict.
5. The signup form renders the four rules and turns a `password` detail into the sentence that names
   it, so a refusal explains itself without the server describing the value.

## 5. Gate and handoff

- `node lib/auth/verify.ts`: the rules one by one, the parser (breach, padding, empty, garbage), the
  five transport facts of the range call, the three verdicts, and the signup paths for a breach and
  for a skipped check.
- `npm run check:migrations` and a real database proof of `0081`: the seeded row, the JSON type, the
  guard, and the rollback.
- `npm run verify`, then the commit and `docs/handoffs/STEP_040_COMPLETED.md`.
