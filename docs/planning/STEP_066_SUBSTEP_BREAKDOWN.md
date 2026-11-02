// path: docs/planning/STEP_066_SUBSTEP_BREAKDOWN.md
# STEP 066 - Sub-step breakdown

STEP 066: **Fraud signal evaluation service for payment attempts** (`docs/final/STEP_PLAN_250.md` line
861), from `docs/final/FEATURE_LIST.md` line 195 ("A provider fraud signal rejects the payment at once"),
line 196 (a blacklist entry is a card token or a provider fingerprint), line 197 ("Card and IP velocity
limits exist with defaults in config"), line 194 (the 3D Secure capture rule and the manual review it
sends), line 62 (unusually large transactions are held for review) and line 193 (3D Secure is requested on
every payment), inside the security block 056-067.

## What already exists, and what is missing

- `migrations/0037_payments.sql` (STEP 024) - the only place this platform already states a risk rule:
  `risk_decision in ('allow', 'review', 'reject')`, `risk_decision <> 'reject' or status = 'failed'`, and
  `payments_three_ds_capture_check`, which is the capture rule of section 18 in SQL.
- `migrations/0055_card_blacklist.sql` (STEP 030) - a block keyed on a 64 hex `card_fingerprint`, with an
  active/released lifecycle and an expiry.
- `migrations/0056_velocity_counters.sql` (STEP 030) - one counter per card or address and window, with
  `hit_count`, `limit_value >= 1`, and a breach recorded when the count reaches the limit.
- `lib/security/host.ts` (STEP 058) - `isIpLiteral`, the one function in the tree that decides whether a
  string is an address.
- `lib/security/audit.ts` (STEP 063) - the entry shape, the redaction pass and `auditEntryProblem`.

Nothing evaluates the five sentences. A payment service would have to decide, per attempt, whether a
provider verdict rejects, whether a card is blocked, whether a counter was breached, whether a capture is
allowed without 3D Secure, and what counts as "unusually large" - five decisions written where the money
moves, and five chances to write them differently in the next call site.

## The decisions this STEP makes

1. **One module, six signals, one decision.** `provider_signal`, `card_blacklist`, `card_velocity`,
   `ip_velocity`, `three_ds_verification`, `amount_review`, evaluated in that fixed order.
2. **Every signal is evaluated and the decision is the maximum.** Reject outranks review outranks allow.
   A short circuit would lose the record of what was checked, which is the reason the audit chain exists.
3. **The words are the schema's words.** `allow`, `review`, `reject` are `payments_risk_check`; the four
   3DS outcomes and the three payment methods are the `0037` literals too. The gate reads the migration
   and compares, so the service cannot drift from the row it fills in.
4. **The capture rule is stated twice and must agree.** `threeDsVerified` is
   `payments_three_ds_capture_check` in TypeScript, and `captureAllowed` is true only for `allow`, so a
   held payment moves no money and a cleared one still needs the 3DS rule to hold.
5. **Card velocity rejects, IP velocity reviews.** A card used at its limit is card testing; an address at
   its limit is often a household, an office or a carrier's NAT, and a person should look rather than the
   platform refuse a fourth family member.
6. **The velocity comparison is the counter's own.** `0056` records a breach when `hit_count` reaches
   `limit_value`, and the counter floor is one, so the module compares `hits >= limit` and refuses a
   reading with a limit below one. A second, stricter rule in the service would make the row and the
   decision disagree.
7. **Fail closed.** A failing lookup, a blacklist answer that is not a boolean and a reading that is not a
   count and a limit all raise `DEPENDENCY_FAILED` rather than clearing the signal.
8. **The trace is a closed vocabulary.** Fifteen detail words, no digits, so the audit payload cannot
   carry an amount, an address or a count by construction; the fingerprint travels as the hash `0055`
   already stores.
9. **Only a held or refused payment writes its own entry.** A cleared payment is audited by the payment
   row's own write; `fraudAuditEntry` returns null for it, the way STEP 062 audits refusals only.
10. **No clock, no randomness, no state.** A decision is a function of the attempt, the policy and two
    lookups, so the corpus runs without a database and the same attempt always decides the same way.

## Owned paths

New: `lib/security/fraud.ts`, `docs/planning/STEP_066_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_066_COMPLETED.md`.

Edited: `lib/security/verify.ts` (the corpus and the wiring), `lib/security/README.md`.

STEPs 056-067 own `lib/security/`, so nothing outside it is touched. No migration (the two tables and the
rule already exist, and database STEPs own `migrations/`), no route (the payment core is STEPs 127-146 and
the portal is 181-190), no i18n string (nothing renders a decision), `package.json` untouched.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_065_COMPLETED.md` (committed `77afb7c`), `STEP_PLAN_250.md` line 861, feature list lines 62, 193-197,
master prompt rules 9, 14 and 17, the ownership rules at line 45, `0037_payments.sql`,
`0055_card_blacklist.sql`, `0056_velocity_counters.sql`, `lib/security/host.ts` and `lib/security/audit.ts`.

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

None. The risk rule is already a column with a check, the blacklist and the counters are already tables,
and the thresholds belong to a setting an operator edits - not to this STEP. The gate asserts the
agreement with the three migrations instead of adding a fourth source of truth.

## Sub-step 4 - The core logic

`lib/security/fraud.ts`:

- `FRAUD_RULE`, `FRAUD_AUDIT_ACTION`, `FRAUD_CURRENCY`, `FRAUD_FAILURE_CODE`, `FRAUD_PROVIDER_SIGNALS`,
  `FRAUD_THREE_DS_OUTCOMES`, `FRAUD_PAYMENT_METHODS`, `FRAUD_SIGNALS`, `FRAUD_OUTCOMES`, `FRAUD_DECISIONS`,
  `FRAUD_DETAILS`, `FRAUD_PROBLEMS`, `FRAUD_DEFAULT_POLICY`, `FRAUD_CARD_FINGERPRINT_PATTERN`,
  `FRAUD_VELOCITY_LIMIT_MINIMUM` - the vocabularies and the defaults;
- `FraudAttempt`, `FraudPolicy`, `FraudVelocitySubject`, `FraudVelocityReading`, `FraudSignalLookups`,
  `FraudSignalResult`, `FraudDecision`, `FraudAuditEntry`, `FraudAuditContext` - the inputs and outputs;
- `isFraudProviderSignal`, `isFraudThreeDsOutcome`, `isFraudPaymentMethod` - the vocabularies as guards;
- `threeDsVerified`, `fraudDecisionOf` - the two rules stated on their own, so they can be exercised
  without building a whole evaluation;
- `evaluateFraudSignals` - the one call a payment makes;
- `fraudAuditEntry` - the row a held or refused payment appends.

## Sub-step 5 - Routes and jobs

None to connect. The caller is the payment core of STEPs 127-146, which evaluates an attempt before it
writes the row whose `risk_decision` column the decision fills, and the portal pages of 181-190, which
show the outcome. The lookups are injected precisely so those STEPS own their clients: the blacklist read
belongs to the STEP that owns the card, the counter read to STEP 067, which is the velocity counter service
and the next entry of this block.

## Sub-step 6 - UI

Not applicable: nothing renders a decision yet, and the words a client reads when a payment is held belong
to the payment page of section 18, which is a later STEP's page with its own catalogue entries.

## Sub-step 7 - Security proof

`checkFraudVocabulary`, `checkFraudAttempts`, `checkFraudSignals`, `checkFraudLookups`, `checkFraudAudit`
and `checkFraudWiring` in `lib/security/verify.ts`: the vocabularies and their frozen lists; the fifteen
details as lower case words with no digit; the fingerprint pattern in five shapes; the 3DS truth table in
all sixteen combinations; the precedence rule in eight traces; eighteen malformed attempts and two
malformed policies; two non-card payments; every signal in each of its three outcomes with the boundaries
a limit has on both sides; six 3DS cases; the amount threshold at, below and above its value and with an
operator's own number; one attempt where every signal fires; the sixteen-combination proof that an
`allow` always means the 3DS rule was satisfied; the lookups (which subjects, how many times, for this
card and not another, and eleven failure shapes that must not clear a signal); the audit entry (null for
allow, the payload, the entity pair in both shapes, the address left out of the payload, the audit
module's own validation, the redaction pass keeping the fingerprint); and the wiring (the address rule of
STEP 058, no environment read, no log, no request, no clock, no randomness; the signal order in the source
and in the assembly; and the `0037`, `0055` and `0056` literals compared with the constants).

Twenty-nine mutation controls, all caught: a provider fraud signal demoted to a review; a suspicious
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

One thing the corpus changed: the first draft decided `captureAllowed` as `allow && threeDsVerified`, but
the 3DS rule is one of the six signals, so the second half of that conjunction could never be false when
the first was true - a guard a mutant could delete without an answer changing. It is now `allow` alone,
`threeDsVerified` is exported for the capture that follows a manual review, and the gate proves the
implication over all sixteen 3DS combinations instead of asserting it in one conjunction nobody could
observe.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, `npm run build`, one commit
`STEP 066: Fraud signal evaluation service for payment attempts` on `arena/1dc51ec3-kd-solution-it`,
pushed, with `docs/handoffs/STEP_066_COMPLETED.md`.
