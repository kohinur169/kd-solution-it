// path: docs/handoffs/STEP_186_COMPLETED.md
# STEP 186 — Provider fraud signal rejection handling

**Status: COMPLETED**

## STEP

- Number and title: STEP 186 — Provider fraud signal rejection handling.
- Category: Client Portal, Payment Pages and Payment Links (STEPs 181-190), the sixth STEP of the block. STEP
  183 built the card page, STEP 184 the bank's step, STEP 185 the capture rule for a payment the bank did not
  authenticate; STEP 186 is what the page does when the gateway itself says the card is the problem.
- Depends on: `docs/final/FEATURE_LIST.md` section 18 line 195 ("a provider fraud signal rejects the payment at
  once; card blacklist entries use card token or provider card fingerprint"); `docs/final/STEP_PLAN_250.md:2386-2397`;
  STEP 066's `lib/security/fraud.ts` (`FraudProviderSignal`, `FRAUD_FAILURE_CODE = 'risk_rejected'`);
  STEP 024's `0037_payments.sql` (`payments_risk_reject_check`, `risk_decision`, `under_review`); STEP 183's
  `portal-payment.ts` / `portal-payment-processor.ts`; STEP 185's review owner (`compliance_kyc`).

## Owned paths

Owned and used: `app/(client-portal)/`, `components/payments/`, `lib/i18n/strings/en.ts` (messages only).

- `app/(client-portal)/portal-fraud-fields.ts` — new, 164 lines. The vocabulary of section 18's fraud sentence.
- `app/(client-portal)/portal-fraud.ts` — new, 247 lines. The consequences: the signal entry, the referral and
  the one call that does both.
- `app/(client-portal)/portal-fraud-processor.ts` — new, 41 lines. `createInMemoryCardReferralQueue`, saying
  `durable: false`.
- `app/(client-portal)/portal-fraud-verify.ts` — new, 1,017 lines. The gate, **267 checks**.
- `app/(client-portal)/portal-payment-processor.ts` — edited, +56 lines: the signal is read from
  `executed.responseCode` **before** the decline is written; `settle` may now record `failed`/`under_review`;
  a duplicate key that already settled as one of those answers `refused_by_risk` with `replayed: true`.
- `app/(client-portal)/portal-payment.ts` — edited, +56 lines: the `refused_by_risk` outcome, the `replayed`
  flag that keeps a retry from writing its consequences twice, and the two refusals.
- `app/(client-portal)/portal-payment-runtime.ts` — edited, +4 lines: the referral queue is wired.
- `app/(client-portal)/i/[token]/pay/charge/route.ts` — edited, documentation only: the two statuses and rules a
  flagged card answers with.
- `components/payments/portal-form-refusal.ts` — edited, +38 lines: `portalRefusalOf` returns the rule as well
  as its sentence, so a form can act on one refusal instead of only printing it.
- `components/payments/portal-payment-refusal.ts` — edited, +17 lines: the two `risk_*` sentences and
  `portalPaymentRefusalIsFinal`.
- `components/payments/card-payment-form.tsx` — edited, +39 lines: the risk refusal ends the page rather than
  re-offering the same card.
- `lib/i18n/strings/en.ts` — 2 new `portal.*` keys (`ruleRiskRejected`, `ruleRiskSuspicious`).
- `app/(client-portal)/README.md` — the STEP 186 section.

Untouched: `migrations/`, `lib/security/` (`FRAUD_FAILURE_CODE` is imported, not restated), `lib/payments/`
(the adapter's `NMI_RESPONSE_CODES` is read, not edited), and the `payments` table, which the portal may not
write.

## The database sub-step, and why there is no migration

| What the rejection needs | Where it already is |
| --- | --- |
| A failed payment carrying a risk rejection | `payments_risk_reject_check` (`risk_decision <> 'reject' or status = 'failed'`) |
| The three decisions it chooses between | `payments_risk_check` (`allow`, `review`, `reject`) |
| The state a held payment holds | `payments_status_check`'s `under_review` |
| The desk's queue | `0037`'s partial index `where status = 'under_review'` |
| The failure code | `payments.failure_code`, already carrying STEP 066's `risk_rejected` |

The gate reads `0037_payments.sql` and asserts each of those (the constraint's exact text, the decision list,
the `under_review` status, the index), so the proof is a check rather than a claim. This STEP adds no column, no
table and no index, and the next free migration number (**0123**) is untouched.

## The signal, exactly

Section 18 does not say what a "provider fraud signal" is, so this STEP defines it from the gateway's own
documented answer table rather than from a guess:

| Codes | Meaning | What happens |
| --- | --- | --- |
| `250`, `251`, `252`, `253` | pick up card, lost card, stolen card, fraudulent card | **fraud** — rejected at once, `failed` + `risk_rejected` + `risk_decision = 'reject'`, card referred to the blacklist |
| `240`, `260`, `261`, `262` | call issuer, declined with further instructions, stop all / this recurring | **suspicious** — nothing captured, `under_review` + `risk_decision = 'review'`, routed to `compliance_kyc` |
| everything else, including `200`, `201`, `202`, `203`, `204`, `220`, `300` | ordinary declines and gateway rejections | **clear** — the ordinary path, and a decline stays a decline |

`portalProviderFraudSignalOf` is that table and nothing more. Four things follow from it:

1. **A decline is not fraud.** Treating `200` as fraud would refuse honest payers and fill a blacklist with
   noise, so the gate proves that four ordinary declines stay `card_declined` and refer nothing.
2. **The meanings travel with the codes.** `PORTAL_FRAUD_CODE_MEANINGS` reads each description out of the
   adapter's `NMI_RESPONSE_CODES`, and the gate asserts the two agree, so a portal file cannot quietly disagree
   with the adapter about what `253` means.
3. **The decision is the table's, not the caller's.** `portalFraudDecisionOf` maps `fraud → reject`,
   `suspicious → review`, `clear → null` — `null` rather than `"allow"`, so "nothing to do" cannot be mistaken
   for "cleared".
4. **The record and the answer are one fact.** The signal is read in the processor, where the charge's answer is
   parsed, and it travels out as an outcome. The gate checks the thrown refusal *and* the settled record for the
   same attempt, because a payment written as failed but answered as captured is a page that lies.

## The rejection and the review

- **Reject** — `PortalPaymentRecorder.settle` is called with `outcome: "failed"`, `code: "risk_rejected"`, no
  transaction id; two audit entries are written (`portal.provider_signal_recorded`, then
  `portal.payment_rejected` carrying the rule, `card_referred` and `retry_permitted: false`); the card's token is
  referred; and `chargePortalPayment` throws `422` with the rule `risk_rejected`.
- **Review** — settled `under_review` with `risk_suspicious`, one `portal.payment_risk_review` entry naming
  `review_owner: "compliance_kyc"`, no referral (a card that raised a question is not a card to blacklist), and
  `409` with the rule `risk_suspicious`.
- **Replay** — a second attempt with the same idempotency key answers the same refusal with `replayed: true`; the
  gateway is not asked again and no chain entry is written twice.

## The referral, and what this build cannot do

The blacklist is STEP 187's table, so this STEP refuses to write it: a flagged card is **referred** through a
`PortalCardReferralQueue` port. The only implementation here keeps referrals in one process and says
`durable: false`, so:

- the rejection stands either way — the money not moving does not depend on a list accepting a row;
- the referral is reported honestly: `refused` / `queue_not_durable` when the queue is the in-memory one,
  `refused` / `queue_unavailable` when a page has no queue at all, and the audit entry then says
  `card_referred: false` with `referral_rule: card_referral_unavailable`;
- what travels is the **token** this platform saw, plus the business, the invoice, the payment, the signal, the
  response code and the instant — never a card number, and no invented fingerprint. Section 18 allows exactly
  "card token or provider card fingerprint"; the fingerprint is the gateway's to give, and nothing here
  pretends to derive one.

**Real:** the code table and its agreement with the adapter, the decision, the settlement of the record, the two
refusals, the chain entries, the referral contract, the replay behaviour, and the whole path through
`chargePortalPayment` over the real processor and the real adapter.

| The missing piece | What it is | Owner |
| --- | --- | --- |
| The durable blacklist row | `card_blacklist` written by token or fingerprint, with its own RLS and revocation | **STEP 187** |
| A durable referral writer | a queue implementation that stores what it is told | STEP 187, through the same port |
| The compliance screen | the office reading `payments where status = 'under_review'` | the office block (`app/(admin)/`) |

## What was exercised

`node "app/(client-portal)/portal-fraud-verify.ts"` — 267 checks:

- **vocabulary**: the four codes, the four suspicious ones, the failure code being STEP 066's own constant, the
  decision/status pairs `0037` accepts, the desk, the payload's `retry_permitted: false`, three distinct audit
  actions, and every code's meaning asserted equal to `NMI_RESPONSE_CODES`, whose category is `declined`;
- **the signal**: each of the four answering `fraud`, each suspicious one answering `suspicious`, eleven
  ordinary codes answering `clear`, a padded code, an absent one, an empty one, and `2501` (which starts with
  `250` and is not it);
- **the payload**: a rejection's `failed`/`reject`/`risk_rejected` with the gateway's own words, a hold's
  `under_review`/`review`/`compliance_kyc` and no failure code, and no key of either naming card data;
- **the rejection through the real charge path**, for all four codes: one gateway call, `failed` with
  `risk_rejected`, no transaction id, nothing saying captured, the signal and the rejection each in the chain
  once, the referral reported unavailable with its rule, and no review entry;
- **the suspicious codes**: `409` with `risk_suspicious`, `under_review`, the review routed to compliance, and
  no referral at all;
- **ordinary declines**: four codes staying `card_declined`, written as `declined`, referring nothing and
  writing no risk entry;
- **an approval**: still captured with the fraud path wired, with nothing referred and no risk entry;
- **the referral**: the token, the business, the invoice, the signal, the code and the instant, plus
  `card_referred: true` and the id in the chain; and the honest `queue_not_durable` / `queue_unavailable`
  answers, with the rejection standing in both;
- **a broken audit sink**: the decision and the referral still happen, three append attempts and no throw;
- **the replay**: the same key answered with the same rule, one gateway call, one signal entry, one rejection;
- **the sentences**: a rejection sentence that says nothing was charged, a review sentence that says the payment
  is under review, distinct from each other, and neither printing a code a payer cannot act on;
- **the sources and the schema**: the signal read before the decline is written, the `replayed` guard, the
  runtime wiring the in-memory queue, that queue saying `durable: false`, `portalPaymentRefusalIsFinal`
  agreeing with `PORTAL_FRAUD_RULES.rejected`, and `0037`'s constraint, decision list, `under_review` status and
  index — with STEP 187 named as the owner of the list.

Mutation-checked: making the four fraud codes answer `clear` fails the gate with **66 problems**, including the
rejections that turned back into ordinary declines.

## The form

One UI change, because a refusal a payer can immediately undo is not a refusal: `portalRefusalOf` now returns the
rule beside its sentence, and the card form ends the page on `risk_rejected` — the sentence stays as an alert,
the fields are gone, and there is no button to press. A `risk_suspicious` refusal keeps the form, because a
reviewed payment may legitimately be retried with another card. Everything is a single column of existing
classes, so it holds at mobile and desktop widths unchanged.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; the four portal payment routes are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-fraud-verify.ts"` | **portal fraud gate passed: 267 checks, 250/251/252/253 reject at once with risk_rejected, 240/260/261/262 held for compliance_kyc, referrals honest about the missing list, no migration needed** |
| `node "app/(client-portal)/portal-payment-verify.ts"` | 196 checks |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | 271 checks |
| `node "app/(client-portal)/portal-billing-match-verify.ts"` | 148 checks |
| `node "app/(client-portal)/portal-invoice-verify.ts"` / `portal-estimate-verify.ts` | 155 / 232 checks |
| `npm run check:audit` | 3617 checks |
| `npm run check:structure` | 650 source files |
| `npm run check:i18n` | 2665 messages, 294 placeholders |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:errors`, `check:lint`, `check:config`, `check:env` | passed (202 / 77 / 10 sections / 16 vars) |

## Left for the STEPs after this one

- **STEP 187** owns the list this STEP refers to: the `card_blacklist` table by token or fingerprint, and a
  `PortalCardReferralQueue` implementation that is `durable: true`. Nothing in this STEP needs to change for it;
  the runtime line that wires the in-memory queue is the seam.
- **STEP 188** adds card and IP velocity limits; the signal counters here (`under_review`, `failed`) are the rows
  those limits will read.
- **STEP 189** connects the invoice link to the partial-payment service, at which point an amount is chosen before
  the charge and a rejection must name the amount it refused.
- **STEP 190** builds the general payment link over the same hosted fields, the same refusal vocabulary and the
  same risk handling.
- The desk that reads `payments where status = 'under_review'` is the office block's screen (STEPs 068-078 own
  `app/(admin)/`); the queue contract, the owner and the chain vocabulary it needs are built here.
