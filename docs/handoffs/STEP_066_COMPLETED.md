// path: docs/handoffs/STEP_066_COMPLETED.md
# STEP 066 - Fraud signal evaluation service for payment attempts: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_065_COMPLETED.md`
(commit `77afb7c`).

## What was asked

`docs/final/STEP_PLAN_250.md` line 861: a fraud signal evaluation service for payment attempts, the
thirteenth STEP of the security block 056-067. `docs/final/FEATURE_LIST.md` line 195 makes a provider
fraud signal reject a payment at once; line 196 makes a blacklist entry a card token or a provider
fingerprint; line 197 requires card and IP velocity limits; line 194 fixes what happens when 3D Secure was
not completed; line 62 holds unusually large transactions for review; line 193 requests 3D Secure on every
payment.

## What already existed

- `migrations/0037_payments.sql` (STEP 024) - `risk_decision in ('allow', 'review', 'reject')`,
  `risk_decision <> 'reject' or status = 'failed'`, and `payments_three_ds_capture_check`, which is the
  capture rule of section 18 already written in SQL;
- `migrations/0055_card_blacklist.sql` (STEP 030) - blocks keyed on a 64 hex fingerprint;
- `migrations/0056_velocity_counters.sql` (STEP 030) - one counter per card or address, `limit_value >= 1`,
  a breach recorded when the count reaches the limit;
- `lib/security/host.ts` (STEP 058) - `isIpLiteral`; `lib/security/audit.ts` (STEP 063) - the entry shape,
  the redaction pass and `auditEntryProblem`.

Nothing evaluated the five sentences; every payment call site would have had to.

## What was built

`lib/security/fraud.ts`, one evaluation with six signals and one decision.

- **The signals**, evaluated in this fixed order: `provider_signal` (a processor verdict: clear,
  suspicious, fraud), `card_blacklist` (the `0055` block), `card_velocity`, `ip_velocity`,
  `three_ds_verification` and `amount_review`.
- **The decision** is `allow`, `review` or `reject` - the words `payments_risk_check` stores - assembled
  as the maximum of the trace, never chosen inside a branch. `fraudDecisionOf` states the precedence on
  its own so it can be exercised without six signals.
- **Every signal is evaluated**, even after a reject, because the row has to say what was checked. The
  trace is the record; `reasons` is the ordered list of the details that fired.
- **The capture rule** is `payments_three_ds_capture_check` in TypeScript: `threeDsVerified` is true when
  3D Secure authenticated, or when the billing postal code *and* the payer IP country both matched. A
  review is a hold, so `captureAllowed` is true only for `allow`; after a manual review the caller checks
  `threeDsVerified` again before capturing, because the database will refuse the capture otherwise.
- **Velocity compares the counter's own way**: `hits >= limit`, because `0056` records a breach when
  `hit_count` reaches `limit_value`, and a reading whose limit is below one is not a reading this module
  acts on. A card at its limit rejects (card testing); an address at its limit reviews (a household, an
  office, a carrier's NAT).
- **Fail closed**: a lookup that throws, a blacklist answer that is not a boolean, and a reading that is
  not two non-negative whole numbers with a limit of at least one all raise `DEPENDENCY_FAILED` - the
  payment service retries or holds, and neither is what "the blacklist said the card is fine" would have
  caused.
- **The attempt is validated first**: a uuid company, USD, a positive `bigint` amount, the three payment
  methods, the three provider verdicts, the four 3DS outcomes, booleans where booleans belong, a 64 hex
  fingerprint for a card and *no* fingerprint for anything else, and a payer address that is an address
  (through STEP 058's `isIpLiteral`, not a second parser). A malformed attempt is `INTERNAL_ERROR` with
  `attempt_invalid`, because the caller built it.
- **The audit row**: `fraudAuditEntry` returns null for a cleared payment (its own row is the record) and
  an entry for a held or refused one, with the action `payment.fraud_evaluated`, the decision, the
  amount as a string (a `bigint` is not JSON), the method, the 3DS outcome, the fingerprint hash and the
  six-signal trace. The payload carries no address and no count; the address travels in the entry's own
  field, where the audit module canonicalises it.
- **No clock, no randomness, no state**: the same attempt always decides the same way.

## The one thing the corpus changed

The first draft computed `captureAllowed` as `allow && threeDsVerified`, and that conjunction was a guard
a mutant could delete without any answer changing: the 3DS rule is *one of the six signals*, so an `allow`
already implies it. The field is now `allow` alone, `threeDsVerified` is exported for the capture that
follows a manual review, and the gate proves the implication over all sixteen 3DS combinations rather
than asserting it once and hiding the redundancy.

## What was deliberately not connected

No route: the payment core of STEPs 127-146 evaluates an attempt before it writes the row whose
`risk_decision` column the decision fills, and that STEP owns the client that writes the payment. No
migration: the rule, the blacklist and the counters already exist, and database STEPs own `migrations/`.
No i18n string: the sentence a payer sees when a payment is held belongs to the payment page of section 18.
No page. `package.json` untouched.

## Database

None. No migration, no rollback to prove, no query in the module: the two lookups are injected and the gate
asserts the source mentions no supabase client and no REST client.

## Environment

None added. No secret is read, written or named by this module.

## Behaviour proof

The behaviours in the title, exercised:

| behaviour | exercised by | observed result |
| --- | --- | --- |
| a provider fraud signal rejects at once | provider verdicts clear, suspicious and fraud on an otherwise clean attempt | `allow`, `review`, `reject` respectively, with `captureAllowed` false for both of the last two |
| a blacklisted card is refused | the blacklist predicate answering true and false | `reject` with `blacklisted`, and `allow` with `not_listed` |
| velocity limits bite at the limit | counters at limit - 1, at the limit and above it, for the card and the address | card: allow, allow at limit - 1, `reject` at the limit; address: allow, `review` at the limit |
| 3D Secure decides capture | all sixteen combinations of the four outcomes and the two address matches | verified exactly when authenticated or both matched, and an `allow` never occurs without it |
| an unusually large payment is held | the amount at the threshold, one cent below, and with an operator threshold | `review` at and above, `allow` below, and the operator's number decides |
| everything at once | provider fraud, a blocked card, both counters over, no 3DS and a large amount | `reject`, with all six reasons in the trace in order |

UI: not applicable, nothing renders a decision in this STEP. API: not applicable, no route exists; the
service's success, refusal and dependency-failure paths are exercised directly. Money: no ledger entry is
written by this STEP - it decides whether a payment may proceed, and the money rules belong to the payment
core and the ledger of STEPs 127-146.

## Security proof

`node lib/security/verify.ts` - **2042 checks** (1763 before this STEP; +279), still 200 code point name
ceiling, 15 allowed tags. `checkFraudVocabulary`, `checkFraudAttempts`, `checkFraudSignals`,
`checkFraudLookups`, `checkFraudAudit` and `checkFraudWiring`:

- Vocabulary: the six signals and their order, the three outcomes, the three decisions, the fifteen
  details (all lower case words, none with a digit), the three problems, the default threshold, the frozen
  lists, the fingerprint pattern in five shapes, and the create-only guards.
- Rules: the 3DS truth table in sixteen combinations, the precedence rule in eight traces.
- Attempts: eighteen malformed attempts, two malformed policies, and two non-card payments whose
  blacklist and card velocity have no card.
- Signals: each of the six in each outcome, the velocity boundary on both sides for the card and the
  address, six 3DS cases, the amount at, below and above its threshold and with an operator's own number,
  one attempt where everything fires (the trace keeps all six, in order), and the sixteen-combination
  proof that `allow` implies a satisfied 3DS rule.
- Lookups: which subjects, in which order, how many times, for *this* card and not another; a bank
  transfer asks the blacklist nothing and reads one counter; eleven failure shapes (a throw, a
  non-boolean answer, a negative, fractional, infinite or NaN count, a limit below one, a fractional
  limit) all `DEPENDENCY_FAILED` with status 502.
- Audit: null for allow; the payload's eight fields plus the trace; the entity pair empty before the row
  exists and `payment` + uuid after; the address absent from the payload; the audit module's own
  `auditEntryProblem` clean for all three entries; the payload under the byte ceiling; and the redaction
  pass keeping the fingerprint, which is a hash and not a credential.
- Wiring: the address rule is STEP 058's, the module reads no environment variable, logs nothing, makes
  no request, holds no clock and no randomness, names no card number and no CVV, and the two lookups are
  the caller's; the signal order is asserted in the declaration and in the assembly; the `0037` literals
  for the decisions, the 3DS outcomes and the payment methods are compared with the constants; `0055`'s
  fingerprint check and `0056`'s count, limit, floor and breach comparison are compared with this
  module's rules; and exactly one module in the tree writes a fraud decision.

**Twenty-nine mutation controls, all caught:** a provider fraud signal demoted to a review; a suspicious
verdict ignored; a blacklisted card not rejected; the card velocity clearing at its limit; a card breach
only reviewing; an address breach rejecting; the address velocity clearing at its limit; the address pair
no longer verifying; the amount clearing at the threshold; a large amount not held; a review outranking a
reject; a cleared trace becoming a review; capture always allowed; a review captured; a card payment with
no fingerprint; a bank transfer carrying one; the currency unchecked; the payer address unchecked; a
negative count accepted; a limit below the floor accepted; a non-boolean blacklist answer accepted; a
failing blacklist clearing the card; a failing counter clearing the address; a cleared payment audited
too; an entry that never names the payment; the amount written as a number; a malformed attempt reported
as the client's fault; the default threshold replaced with zero; and a trace that keeps only the signals
that fired.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 2042 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |

`npm run verify` components: structure 17 directories, 14 root files, **176** sources (175 before);
config 10 checks / 28 keys, i18n 294, logger 117, errors 202 checks / 15 codes, lint 77 checks, shell 237,
jobs 110, migrations 2746 checks / 92 migrations / 75 tables - all unchanged.

## Files

New: `lib/security/fraud.ts`, `docs/planning/STEP_066_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_066_COMPLETED.md`.
Edited: `lib/security/verify.ts`, `lib/security/README.md` (a new section, "What a payment must pass, and
what the decision means", with the signal table, and a row in the module table).
No migration, no `package.json` change, no new dependency, no new root file, no test file, no i18n string.

## Package requests

Unchanged from STEP 065: `check:auth` and `check:security` are still not part of `npm run verify`; a
`minimatch` bump for the moderate advisory on the default branch; DOMPurify for the rich text allowlist; a
pinned-address dispatcher for the SSRF rule.

## Next

STEP 067 of `docs/final/STEP_PLAN_250.md`, the velocity counter service for card tokens and IP addresses,
which is the next entry of the security block and the source of the two `FraudSignalLookups` this STEP
consumes: `readVelocity({ kind: "card" | "ip", value })` answers `{ hits, limit }` from
`velocity_counters`, with the limit the counter row recorded. Nothing in this STEP is pending. The second
seam: the payment core of 127-146 writes `risk_decision` from `decision`, `failed` with
`FRAUD_FAILURE_CODE` for a reject, `under_review` for a hold, and appends `fraudAuditEntry` through the
audit writer of STEP 063.
