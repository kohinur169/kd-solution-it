// path: docs/handoffs/STEP_185_COMPLETED.md
# STEP 185 — Postal code and IP country match rule with manual review routing

**Status: COMPLETED**

## STEP

- Number and title: STEP 185 — Postal code and IP country match rule with manual review routing.
- Category: Client Portal, Payment Pages and Payment Links (STEPs 181-190), the fifth STEP of the block. STEP
  183 built the card page, STEP 184 the bank's step and the capture rule it feeds; STEP 185 supplies the two
  facts that rule reads and the destination a failed match goes to.
- Depends on: `docs/final/FEATURE_LIST.md` section 18 line 194 ("when 3DS is not completed, capture happens only
  when billing postal code and payer IP country both match the invoice data. When either does not match, nothing
  is captured and the payment goes to manual review by compliance_kyc") and line 193; `docs/final/STEP_PLAN_250.md:2375-2384`;
  STEP 184's `portalThreeDsCaptureDecisionOf` and challenge record, STEP 066's `threeDsVerified`, STEP 024's
  `0037_payments.sql` (`postal_code_matched`, `ip_country_matched`, `under_review`, the index on it), STEP 019's
  `0019_clients.sql` (`postal_code`, `country`), STEP 181's `openPortalInvoice` and token read, and STEP 183's
  `parsePortalPaymentBody`.

## Owned paths

Owned and used: `app/(client-portal)/` and `components/payments/`.

- `app/(client-portal)/portal-billing-match-fields.ts` — new, 309 lines. The vocabulary of the match.
- `app/(client-portal)/portal-billing-match.ts` — new, 331 lines. The rule, the read, the evaluation and the
  routing.
- `app/(client-portal)/portal-billing-match-processor.ts` — new, 60 lines. The in-memory review queue and the
  absent resolver.
- `app/(client-portal)/portal-billing-match-runtime.ts` — new, 53 lines. The production wiring.
- `app/(client-portal)/portal-billing-match-verify.ts` — new, 1,225 lines. The gate, **148 checks**.
- `app/(client-portal)/portal-three-ds.ts` — edited, +60 lines: the body is split before STEP 183's parser, the
  facts are decided once when a challenge opens and stored on the record as `billingMatch`, and the review path
  now routes the payment as well as auditing it.
- `app/(client-portal)/portal-three-ds-runtime.ts` — edited: the flow now carries STEP 185's dependencies.
- `app/(client-portal)/portal-invoice.ts` — edited, +10 lines: `clientId` on the view, because the client record
  is the only place the invoice's billing facts live.
- `components/payments/card-payment-form.tsx` — edited, +45 lines: one labelled input for the payer's billing
  postal code, rendered only on the path that compares it.
- `app/(client-portal)/i/[token]/pay/page.tsx` — edited: `askForPostalCode={threeDsReady}`.
- `components/payments/portal-three-ds-refusal.ts` — edited: the unreadable-postal-code sentence.
- `lib/i18n/strings/en.ts` — 3 new `portal.*` keys.
- `app/(client-portal)/README.md` — the STEP 185 section.

Also edited, because a claim had to be restated rather than weakened: STEP 183's and STEP 184's gates
(`portal-payment-verify.ts` +2 checks, `portal-three-ds-verify.ts` two assertions). See "Two previous gates"
below.

Untouched: `migrations/`, `lib/security/` (`threeDsVerified` is imported, not restated), `lib/payments/`, and the
payments table, which the portal may not write.

## The database sub-step, and why there is no migration

| What the rule needs | Where it already is |
| --- | --- |
| The invoice's billing postal code and country | `0019_clients.sql`'s `postal_code`, `country` |
| The alphabet a postal code may take | `clients_postal_code_check` |
| The two facts on the payment | `0037`'s `postal_code_matched`, `ip_country_matched` |
| The state a reviewed payment holds | `payments_status_check`'s `under_review` |
| The decision it carries | `payments_risk_check`'s `review` |
| The desk's queue | `0037`'s partial index `where status = 'under_review'` |

The gate asserts each of those and asserts the postal alphabet this module compares is the one the client table
allows. This STEP adds no column, no table and no index, and the next free migration number (`0123`) is
untouched.

## The rule, exactly

`portalBillingMatchOf` is two comparisons and an `and`:

- **Postal code** — both sides normalised by `portalBillingPostalCodeKey` (trimmed, upper-cased, separators
  removed), so `SW1A 1AA`, `sw1a1aa` and `SW1A-1AA` are one place. Absent payer code → `postal_code_absent`;
  unreadable payer code → `postal_code_invalid` (refused before the flow starts, because a value the platform
  cannot compare is a value the payer believes it sent); no postal code on the client → `postal_code_unknown`;
  two different places → `postal_code_mismatch`.
- **Country** — the payer's country comes from a `PortalCountryResolver`, never from a header or a form field,
  because a payer who could choose their own country would make the second condition a formality. No resolver
  → `country_unresolved`; an address the resolver cannot place → `country_unknown`; no country on the client →
  `country_absent`; two different countries → `country_mismatch`.
- **Decision** — `capture` only when both matched, otherwise `review`. Every failure is a mismatch, never a
  pass: section 18's rule is a condition of capture, and a condition whose unknown answer counted as true would
  let through exactly the payment it was written to stop.

## The routing

`routePortalPaymentReview` writes the fact twice, on purpose: a queue record carrying `status: "under_review"`,
`risk_decision: "review"`, `review_owner: "compliance_kyc"`, the amount and both reasons — and two audit entries
(the decision, then the routing or the refusal to route). The queue is a port; the in-memory implementation says
`durable: false`, so every routing in this build is reported as refused and audited as such while the decision
not to capture stands regardless. A review that could not be queued is still a payment that was not captured.

## What is real, and what this build cannot do

**Real:** the postal comparison, the failure reasons, the read of the client record, the queue contract, the
audit chain, and the whole flow through STEP 184 — including the payoff, which the gate proves end to end: a
payment the bank did not authenticate is **captured** when both facts match, and **reviewed** when either does
not.

**Missing, named rather than imitated:**

| The missing piece | What it is | Owner |
| --- | --- | --- |
| IP → country | geolocation data or a lookup service; this repository has neither, and a prefix table in a portal file would be a second, unaccountable source of truth | infrastructure, wired through the one-line seam `resolver` in `portal-billing-match-runtime.ts` |
| A durable review queue | the `payments` row with `under_review` / `review`, written in the same transaction as the payment | STEP 130/132's payment operation (the portal may not write money rows) |

Because the resolver is absent, `ipCountryMatched` is always false in this build and the fallback capture of
section 18's second sentence cannot fire in production — every unverified payment is reviewed. The moment a
resolver is wired, nothing else changes.

## Two previous gates, restated rather than weakened

- STEP 183's gate said "the card form's markup holds no input element at all". That was the strongest way to say
  "no card field is an input", and it stops being true the moment a payer types a postal code. It is now stated
  as what it always meant: no *card* field is an input, the three card containers are still divs the provider
  draws into, and the only input in the form is the postal code — three checks where there was one.
- STEP 184's gate read two booleans off the challenge record. The record now carries the whole comparison
  (`billingMatch`), so the same two assertions read them out of it and one more checks the reasons. Nothing was
  loosened: the capture rule still reads exactly two booleans, and the reasons exist for the reviewer.

## What was exercised

`node "app/(client-portal)/portal-billing-match-verify.ts"` — 148 checks:

- **vocabulary**: the field name, the two length bounds, the postal alphabet (including a leading separator),
  the country shape, the desk, the status, the risk decision, three distinct audit actions;
- **normalisation**: five spellings of one place, five things that are not postal codes, three country shapes;
- **comparison**: matched, mismatched on each side, absent, unreadable, no client record, no resolver, unknown
  address, and all four combinations of the two facts against the decision;
- **the read**: the client's two columns, tenant scoping, no `select=*`, a missing client record answering null;
- **the evaluation**: the resolver asked about the payer's address, a resolver that throws failing closed, no
  resolver failing closed, a foreign country being a mismatch rather than an absence;
- **the routing**: a durable queue routing with the status, decision, owner, amount and reasons; two chain
  entries; a non-durable queue refusing for `queue_not_durable`; no queue refusing for `queue_unavailable`; the
  refusal audited with its rule;
- **the body split**: the postal code trimmed out, the remaining body unchanged, a card field still present for
  STEP 183's scan, three unreadable postal codes refused;
- **the flow, end to end through STEP 184**: capture on a full match (one provider call, basis `billing_match`,
  no review), review on a postal mismatch (nothing captured, one queued review naming the failing fact), review
  on a country mismatch, on an absent postal code, on an absent resolver, on a failing resolver, and on an
  unqueueable review; an unreadable postal code and a body carrying card data both stopping before the bank;
- **the sources**: tenant scoping and `deleted_at` in the query, the in-memory queue and absent resolver saying
  so, the form's labelled input, `autoComplete="postal-code"`, the sixteen character ceiling, the card fields
  still not inputs, the page passing `askForPostalCode`, and the three schema facts (`0037`'s two columns and
  its `under_review` index, `0019`'s postal alphabet).

Mutation-checked: making the decision always `capture` fails the gate with eleven problems, seven of them the
review decisions that stopped happening.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; the four portal payment routes are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-billing-match-verify.ts"` | **portal billing gate passed: 148 checks, one rule for the two facts, reviews routed to compliance_kyc, capture without a bank only when both match, no migration needed** |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | 271 checks |
| `node "app/(client-portal)/portal-payment-verify.ts"` | 196 checks |
| `node "app/(client-portal)/portal-invoice-verify.ts"` / `portal-estimate-verify.ts` | 155 / 232 checks |
| `npm run check:audit` | 3589 checks |
| `npm run check:structure` | 646 source files |
| `npm run check:i18n` | 2663 messages, 294 placeholders |
| `npm run check:migrations`, `check:errors`, `check:lint`, `check:config`, `check:env` | passed |

## Left for the STEPs after this one

- **STEP 186** rejects a payment on a provider fraud signal; `payments_risk_reject_check` already requires the
  rejection to sit on a failed payment, and this STEP's decision vocabulary is the one it extends.
- **STEP 187** adds the card blacklist by token or fingerprint; **STEP 188** the card and IP velocity limits
  beside the two counters this block already has.
- **STEP 189** connects the invoice link to the partial-payment service, at which point a challenge record must
  carry a chosen amount as well as the invoice's remaining due.
- **STEP 190** builds the general payment link over the same hosted fields, the same challenge form and the same
  billing match.
- The compliance screen that reads `payments where status = 'under_review'` is the office block's (STEPs
  068-078 own `app/(admin)/`); the queue contract and the audit vocabulary it needs are built here.
