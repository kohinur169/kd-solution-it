// path: app/(client-portal)/README.md
# app/(client-portal)

Owner: STEP 181-190 (client portal, payment pages and payment links).

STEP 181 built the invoice link, STEP 182 the estimate link, STEP 183 the card payment page, STEP 184 the
3D Secure step in front of it, STEP 185 the billing match that decides what a payment without a bank may do,
STEP 186 the handling of the provider's fraud signal, STEP 187 the card blacklist the platform checks before it
charges anything, STEP 188 the card and IP velocity limits that stop an attempt before a record exists, STEP 189
the part payment a payer may choose on the link.
The links are read-only without a token, and each STEP writes only what its own section asks for.

Reserved for tokenized client surfaces opened without a login: invoice links under
i/[token] and estimate links under e/[token]. A fully paid invoice link shows the receipt
and refuses further payment, and a partly paid invoice link accepts only the remainder.

## What STEP 181 built

- `i/[token]/page.tsx` - the invoice page: the document, its five client-facing states, the amount a
  partly paid link still accepts, the receipt, the buyer's confirmation and, for the invoice's own
  account, the delivery record. `force-dynamic` and `noindex`, because the page exists to show the
  money as it is now.
- `i/[token]/acceptance/route.ts` - the buyer's confirmation. CSRF token, byte ceiling, address, rate
  limit, then the service. No session is needed and none is trusted: the link is the credential.
- `i/[token]/fulfilment/route.ts` - the merchant's delivery record, through the same link. Owner role,
  the actor's company and the token's company must all agree.
- `portal-invoice-fields.ts` - the vocabulary: the five states, the fulfilment kinds and methods, the
  statement each kind asks for, the limits, the rules, the audit actions.
- `portal-invoice-money.ts` - money and quantity printing, at the column's own scale.
- `portal-invoice.ts` - the read model: token to view, five scoped reads, the payable state, the
  receipt, the release question and the document digest.
- `portal-invoice-evidence.ts` - the two writes and their parsers.
- `portal-rate-limit.ts` (STEP 182) - the portal's one counter module, on `rate_limit_windows`,
  with the confirmation's `portal_acceptance` policy and the signature's `portal_signature` policy. It
  replaced `portal-invoice-rate-limit.ts`, which STEP 182 deleted rather than leave beside it.
- `portal-invoice-runtime.ts` - the production wiring and the optional actor read.
- `portal-invoice-verify.ts` - the gate. It is not on the `verify` chain because `package.json` is not
  this block's file; run it with `node "app/(client-portal)/portal-invoice-verify.ts"`.

## What STEP 182 built

- `e/[token]/page.tsx` - the estimate page: the offer, its lifetime, its six client-facing states and the
  decision. Two writes happen as it is opened, both tolerant: an expired offer is voided with
  `void_reason = 'expired'`, and a `sent` offer becomes `viewed`. `force-dynamic` and `noindex`.
- `e/[token]/signature/route.ts` - the client's decision: accept with a typed signature, or decline. The
  same check order as the invoice confirmation - CSRF, byte ceiling, address, rate limit, body.
- `portal-estimate-fields.ts` - the vocabulary: six states, two decisions, three void reasons, the
  borrowed signature limits, the rules, the audit actions, the `portal_signature` policy, the consent key.
- `portal-estimate.ts` - the read model: token to view, three scoped reads, the state fold, the digest.
- `portal-estimate-decision.ts` - the writes: the expiry void, the view, and the decision, which records
  STEP 022's evidence and then applies the status it implies (`accepted`, or `void` + `declined`).
- `portal-estimate-verify.ts` - the gate, 232 checks. It is not on the `verify` chain for the same reason
  as the invoice gate; run it with `node "app/(client-portal)/portal-estimate-verify.ts"`.

## What STEP 183 built

- `i/[token]/pay/page.tsx` - the payment page of section 18: the amount the link still takes, and the
  provider's hosted fields. The page holds no card input of its own and hands three empty containers to NMI's
  Collect.js script. `force-dynamic` and `noindex`.
- `i/[token]/pay/charge/route.ts` - the charge: CSRF, byte ceiling, address, rate limit, body, then the
  service. The body carries a Collect.js token and an idempotency key, and nothing else.
- `portal-payment-fields.ts` - the vocabulary: the two body fields, the card keys that must never appear in
  one, the token shapes, the `portal_payment` policy (5 attempts per address per ten minutes), the rules, the
  audit actions and the dollars-and-cents conversion.
- `portal-payment.ts` - the service: what the page shows (`preparePortalPayment`) and the one charge
  (`chargePortalPayment`), which refuses card data, spends nothing until the link and the amount are right,
  and never retries an unknown outcome.
- `portal-payment-processor.ts` - the composition a charge runs through: STEP 129's routing, a durable record
  (the recorder port), and STEP 151's provider execution. It also ships the in-memory recorder, which says
  `durable: false`.
- `portal-payment-runtime.ts` - the production wiring, which states plainly that the key store and the
  recorder are in memory in this build, so the page explains that card payment is not available yet instead
  of taking a card it cannot account for.
- `portal-payment-verify.ts` - the gate, 194 checks. Run it with
  `node "app/(client-portal)/portal-payment-verify.ts"`.

STEP 183 adds no migration: `0037` already carries the payment, its idempotency key, its status, its provider
transaction and the two card facts section 18 allows, and `0030` already carries the platform-scoped gateway
keys.

## What STEP 184 built

- `i/[token]/pay/3ds/route.ts` - starting the bank's step: the same five checks as the charge, in the same
  order, plus the 3DS counter of its own. It answers either the money (a frictionless authentication charges
  through STEP 183's service) or the issuer's page, its request, a sealed handle and the return address.
- `i/[token]/pay/3ds/complete/route.ts` - the issuer's return. It reads `PaRes` and `MD` and nothing else,
  claims the challenge once, settles it, and answers a `303` to the result page - a bank's flow should not end
  in a JSON body. It requires the CSRF token exactly when the browser carries a session, because that is the
  authority a cross-site request could borrow and a cardholder mid-challenge has none.
- `i/[token]/pay/3ds/result/page.tsx` - what happened, in the portal's words. The `?state=` in the query picks
  the sentence; the client, the number and the amount are read from the invoice, so editing the query changes
  what a payer reads and never what they owe. `force-dynamic` and `noindex`.
- `portal-three-ds-fields.ts` - the vocabulary: the three challenge fields and the two result fields, the
  handle's purpose and context, its fifteen minute life, the `portal_3ds` policy, the ceilings, the rules, the
  audit actions, the four result states, and the outcome/decision/state mappings - with the capture decision
  delegating to STEP 066's `threeDsVerified` rather than restating section 18.
- `portal-three-ds.ts` - the flow: the four provider answers, the challenge record written before the payer
  leaves, the sealed handle, the single-use claim, section 18's capture rule, the charge through
  `chargePortalPayment`, and the review that captures nothing when authentication did not happen.
- `portal-three-ds-processor.ts` - the two pieces the flow runs on: the in-memory challenge recorder (which
  says `durable: false`) and `noPortalThreeDsPort`, the honest statement that this build has no operation to
  ask a bank to authenticate a card.
- `portal-three-ds-runtime.ts` - the production wiring: the real cipher (`lib/auth/secrets.ts` under the
  deployment's master key), STEP 183's payment dependencies, an in-memory recorder and no port.
- `components/payments/three-ds-challenge.tsx` - the form that hands the payer to their bank: three hidden
  fields and a button, auto-submitted, no card input of any kind.
- `components/payments/portal-three-ds-refusal.ts` - the bank's refusals as sentences.
- `portal-three-ds-verify.ts` - the gate, 271 checks. Run it with
  `node "app/(client-portal)/portal-three-ds-verify.ts"`.

The card form of STEP 183 gained one prop and one branch: it posts to whatever endpoint the page gives it, and
a `challenge` answer hands the payer to `ThreeDsChallenge` after clearing the spent token. The payment page
decides between `/pay/3ds` and `/pay/charge` by asking this step what the deployment can do, and shows a third
unavailable panel - "the bank confirmation step is not switched on yet" - when it cannot ask a bank, because
`payments_three_ds_capture_check` will not record a capture without it either.

STEP 184 adds no migration: `0037` already carries `three_ds_outcome` with its four values, the capture check
that names section 18's rule, `postal_code_matched`, `ip_country_matched` and the `under_review` status. The
gate asserts all five and asserts the next free migration number is untouched.

## What STEP 185 built

- `portal-billing-match-fields.ts` - the vocabulary: the body field the payer's postal code travels in, the
  alphabet `clients_postal_code_check` allows, the ISO country shape, one rule for the two facts, the review
  owner, the status and risk decision `0037` already accepts, and the audit actions.
- `portal-billing-match.ts` - the rule and the routing: `portalBillingMatchOf` (normalise, compare, both must
  match), `readPortalBillingFacts` (one tenant-scoped read of the client the invoice was issued to),
  `evaluatePortalBillingMatch` (the resolver's answer, failing closed), `routePortalPaymentReview` (the queue
  plus two chain entries), and `splitPortalBillingPostalField`, which takes the postal code out of the body so
  STEP 183's strict parser and card scan still see everything else.
- `portal-billing-match-processor.ts` - the in-memory review queue (`durable: false`) and
  `noPortalCountryResolver`, the honest absence of geolocation data in this build.
- `portal-billing-match-runtime.ts` - the production wiring: the platform's rows, its audit chain, no resolver
  and an in-memory queue.
- `portal-billing-match-verify.ts` - the gate, 148 checks. Run it with
  `node "app/(client-portal)/portal-billing-match-verify.ts"`.

The card form asks for one ordinary input - the payer's billing postal code, labelled, `autoComplete="postal-code"`,
bounded to sixteen characters - and sends it only on the path that compares it. STEP 184's flow reads the two
facts when it opens a challenge (`billingMatch` on the challenge record, replacing the two booleans it left
false), and its review path now routes the payment as well as audit it.

The payoff is section 18's second sentence, working: a payment the bank did not authenticate is **captured**
when the postal code and the country both match the invoice, and is otherwise **not captured** and queued for
`compliance_kyc`. Because this deployment has no country resolver, `ipCountryMatched` is false and every
unverified payment is reviewed - which is the honest reading of "where possible", not a silent pass.

STEP 185 adds no migration: `0037` already carries `postal_code_matched`, `ip_country_matched`,
`status = 'under_review'`, `risk_decision = 'review'` and the index on the status, and `0019` already carries
`clients.postal_code` and `clients.country`. The gate asserts each of those and the postal alphabet they share.

## What STEP 186 built

- `portal-fraud-fields.ts` - the vocabulary of section 18's fraud sentence: the four documented codes that name
  the card itself as the problem (`250` pick up, `251` lost, `252` stolen, `253` fraudulent), the four that ask
  the merchant to stop (`240`, `260`, `261`, `262`), the gateway's own words for each, the mapping from a code
  to `fraud`/`suspicious`/`clear`, the decision and the two values `0037` accepts (`failed` with
  `risk_decision = 'reject'`, `under_review` with `'review'`), the audit actions and the payload they carry.
- `portal-fraud.ts` - the consequences: `recordPortalProviderSignal`, `referPortalCard` and
  `handlePortalProviderSignal`, plus the `PortalCardReferralQueue` port a flagged card is referred to.
- `portal-fraud-processor.ts` - `createInMemoryCardReferralQueue`, the list this build has, saying
  `durable: false`.
- `portal-fraud-verify.ts` - the gate, 267 checks. Run it with
  `node "app/(client-portal)/portal-fraud-verify.ts"`.

The signal is read in `portal-payment-processor.ts`, where a charge's answer is parsed, and the outcome carries
it out of the processor: `failed` on `failed`/`risk_rejected` for a fraud signal, `under_review` for a
suspicious one. `chargePortalPayment` then refuses - `risk_rejected` for the first, `risk_suspicious` for the
second - and the card form ends the page on the first rather than inviting the payer to try the same card again.

The card's referral is a port because the blacklist is STEP 187's table: a referral that cannot be kept is
recorded as `card_referral_unavailable` and the rejection stands, which is the honest reading of a rule that
must not depend on a side effect. A retried attempt answers the same refusal, records nothing twice, and never
reaches the gateway a second time.

STEP 186 adds no migration: `0037` already carries `payments_risk_reject_check` (`risk_decision <> 'reject' or
status = 'failed'`), the three risk decisions, the `under_review` status and its index. The gate asserts each of
those rather than assuming them.

## What STEP 187 built

- `portal-blacklist-fields.ts` - the vocabulary of section 18's last clause, read out of `0055`: the two
  identifiers (`card_token`, `provider_fingerprint`), the six reasons, the two states, the sixty four character
  fingerprint `0055` stores, the note bounds, the rules a refusal names, and the Zod schemas a block and a
  release are validated with.
- `portal-blacklist.ts` - the list itself: `portalCardFingerprintOf` (SHA-256, one function for both sources),
  `readPortalCardBlock` (one platform-wide query, three answers - clear, blocked, unavailable),
  `checkPortalCardBlacklist`, `blockPortalCard` (a person, a reason, a life), `releasePortalCard` (the version it
  read, read back afterwards) and `createPortalCardBlockLookup`, which is the same list in the shape STEP 066's
  fraud evaluation asks for.
- `portal-blacklist-processor.ts` - the check the payment operation runs before the gateway, and the durable
  referral queue STEP 186 described.
- `portal-blacklist-verify.ts` - the gate, 208 checks. Run it with
  `node "app/(client-portal)/portal-blacklist-verify.ts"`.

A listed card is refused **before** a request is built: the record is settled `failed` with the code
`card_blacklisted` (the `risk_decision` that goes with it is `reject`, which `payments_risk_reject_check` allows
only on a failed payment), the chain gets `portal.card_blacklisted_refused` with the fingerprint, and the payer
gets the "this card cannot be used" sentence. A list that cannot be read refuses the same way rather than
charging a card nobody checked. STEP 186's referral is now wired to this table: with a compliance officer
configured it writes the block, and without one it writes `portal.card_block_requested` and answers
`actor_required`, because `card_blacklist.blacklisted_by` references `public.users` and a block is a person's
decision.

STEP 187 adds no migration: `0055` (STEP 030) already carries the table, the fingerprint alphabet, the two
sources, the six reasons, the unique active-block index and the release guard. The gate reads that migration and
asserts each of them, and asserts 0123 is still the next free number.

## What STEP 188 built

- `portal-velocity-fields.ts` - the vocabulary of section 18's velocity sentence: the two subjects, the defaults
  read out of `config/app.ts`, the three rules a refusal names (`velocity_card_limited`, `velocity_ip_limited`,
  `velocity_unavailable`), the audit action, the policy schema bounded by `0056`'s own checks, and the refusal
  payload.
- `portal-velocity.ts` - the counting: `consumePortalPaymentVelocity` hits STEP 067's `consume_velocity` once for
  the card and once for the address, breaches are written through STEP 067's own `velocityAuditEntry`, and
  `createPortalVelocityLookup` is the same counter in the shape STEP 066's fraud evaluation asks for.
- `portal-velocity-processor.ts` - the check the payment operation runs, with the operator's policy validated once
  at build time and STEP 067's defaults when there is none.
- `portal-velocity-verify.ts` - the gate, 204 checks. Run it with
  `node "app/(client-portal)/portal-velocity-verify.ts"`.

The three pre-charge checks now run in one documented order: **the list** is read first (STEP 187), then **the
counters** are hit (STEP 188), and only then is **a payment record opened** and the gateway asked. An unreadable
list or an unreadable counter refuses the attempt; a breach of either velocity limit refuses it with `429`,
`retry-after` and the rule that says which limit it was. A velocity refusal writes **no** payment record, because
a limit is about traffic and not about money - the counter holds the count and the chain holds the refusal
(`portal.payment_velocity_limited`) and STEP 067's own breach (`security.velocity_limited`, once per window).

STEP 188 adds no migration: `0056` (STEP 067) already carries `velocity_counters` with the subject, window, limit
and breach constraints and its two unique keys, and `0093` already carries `consume_velocity`, which counts a hit
up inside one statement and freezes the limit in the row. The gate reads both and asserts the six arguments and
the answer columns this page depends on, and asserts 0123 is still the next free number.

## What STEP 189 built

- `portal-part-payment-fields.ts` - the vocabulary of part payment: the one body field (`amount`), the four rules
  a chosen amount is refused with, the printed forms, and the shape the page hands the form. It is browser safe,
  because the card form reads it.
- `portal-part-payment.ts` - the rules: `portalPartPaymentLimitsOf` (the ceiling, the floor of a partial, whether
  a choice exists), `splitPortalPartPaymentAmountField` (the field out of the body, before STEP 183's strict
  parser), `portalPartPaymentAmountOf` (the one resolution every charge path uses) and
  `portalPartPaymentMovedOf` (STEP 184's question, asked about a part).
- `portal-part-payment-verify.ts` - the gate, 175 checks. Run it with
  `node "app/(client-portal)/portal-part-payment-verify.ts"`.

A payer may now pay **less than the remainder**, and never more: the remaining due is the ceiling and it is read
from the invoice in the request that charges, not from anything the browser sent. A payment that leaves the
document open is a **partial payment** and meets section 16's twenty dollar floor (`money.minimumPartialPayment`,
through the same folding `portalMinimumPartialMinor` gives the invoice page); the payment that settles the
document is not a partial and is taken at whatever the remainder is, which is what keeps a nine dollar remainder
payable at all. `below_minimum` and `exceeds_remaining` are **STEP 124's rule strings**, asserted equal by the
gate, so the link and the merchant's own record-a-payment screen refuse the same number with the same word.

An absent `amount` is the whole remainder - the request STEP 183 always sent - so nothing about the earlier STEPs
changed for a caller that sends none. The amount travels through the 3D Secure step in the sealed handle and
comes back in the completion's charge, so the challenge and the capture are for one number. A partial leaves the
invoice's balance to STEP 130's operation and STEP 132's ledger: this page writes `payments`, never
`invoices.amount_paid_minor`, and a failed or pending attempt therefore never reduces the balance.

STEP 189 adds no migration: `0022` already carries `amount_paid_minor`, the money checks and
`invoices_partial_minimum_check`, `0037` already carries `payments.amount_minor`, and the twenty dollar floor is
configuration rather than a column. The gate asserts 0123 is still the next free number.

## What STEP 190 built

- `portal-payment-link-fields.ts` - the vocabulary of a general link: the path (`/p`), the claim's kind
  (`payment_link`) and capability (`pay`), the plan service key (`payment_links`), the amount's two bounds
  (10,000 to 1,000,000,000 platform minor units, and the provider's 100 minor units per unit), the description's
  1-200 characters, the reference's 64, the lifetime (an hour to thirty days, a week by default), the four
  states a page prints and the three a row is stored with, fifteen rules, seven audit actions and the body
  ceiling. Browser safe, because the console and the refusal vocabulary read it.
- `portal-payment-link-store.ts` - the link's row as a **port**, with an in-memory implementation that says
  `durable: false` about itself. The header carries the `portal_payment_links` column list the STEP that owns the
  table must satisfy, so the table is written by a STEP that owns migrations rather than by this one.
- `portal-payment-link.ts` - `createPortalPaymentLink`, `openPortalPaymentLink`, `revokePortalPaymentLink`,
  `reissuePortalPaymentLink`, `revokePortalPaymentLinkById`, `reissuePortalPaymentLinkById`,
  `listPortalPaymentLinks`, and the amount, state and URL helpers the pages use.
- `portal-payment-link-checkout.ts` - `chargePortalPaymentLink` and `preparePortalPaymentLinkCheckout`: one card
  on a link, through STEP 183's processor, with `invoiceId: null` and no invoice or ledger path touched.
- `portal-payment-link-runtime.ts` - the production wiring: the **plan entitlement is real** (a `subscriptions`
  read for the company's live plan, then a `plan_entitlements` read for `payment_links`), the link store is the
  in-memory port, and the payment operation is the payment page's own.
- `p/[token]/page.tsx` - the hosted checkout, and `p/[token]/charge/route.ts` - the endpoint its form posts to.
- `../api/payment-links/route.ts` (make and list), `../api/payment-links/[id]/revoke/route.ts` and
  `../api/payment-links/[id]/reissue/route.ts` - the merchant's three endpoints, CSRF-checked and `no-store`.
- `../(dashboard)/payments/links/` - the console: make a link, copy its URL once it exists, cancel it, reissue it.
- `portal-payment-link-verify.ts` - the gate, 254 checks. Run it with
  `node "app/(client-portal)/portal-payment-link-verify.ts"`.

A merchant makes a link for **an amount and a sentence** rather than for a document, and the token carries the
link's own row, the `payment_link` kind and the `pay` capability - never an invoice's. The row keeps the token's
**digest and id**, never the token, so the response is the one moment the URL can be read; a merchant who loses it
**reissues**, which rotates the token id and leaves the old URL resolving to nothing at all. A revoked link answers
the same "cannot be opened" sentence as a forged one, because an answer that says which of the merchant's actions
closed a link is a probe for which links exist.

The feature is an **entitlement**: a creation with no way to answer the plan question is `503`, and a plan without
`payment_links` is `403`, both with `payment_links_not_in_plan`. A link takes **one payment**: the row's status is
the guard, `markPaid` returns `conflict` to the loser and the capture entry records
`duplicate_link_payment: true` rather than hiding a second charge. A failed, declined or flagged attempt leaves the
link `active`, because the merchant has not been paid.

A link payment has **no invoice**, so `payments.invoice_id` stays null and no invoice balance or ledger posting is
touched; the gateway's reference is the link's own id. The three pre-charge checks of STEPs 186-188 run unchanged,
because the checkout calls the same processor, and a link payment must be **authenticated**: `0037`'s
`payments_three_ds_capture_check` accepts a capture without 3D Secure only when a postal code and an IP country
were matched against a client, and a general link has no client to match. The hosted page and the charge route
therefore both render and refuse on the same readiness fact, and the link's own 3D Secure step is named in the
handoff as the next STEP's work rather than papered over.

STEP 190 adds **no migration**, and the proof is written in three places: the store's header (the table sketch),
the gate (the highest migration is still 122 and no file in `migrations/` names `portal_payment_links`), and this
paragraph. A link's row is a port exactly as STEP 183's recorder and STEP 186's queue are, so `0123` stays free for
the STEP that writes the table.

STEP 182 adds no migration. `0025` already carries `void_reason`, `voided_at` and `accepted_at`; `0027`
already carries the eight pieces of evidence and the unique index that makes one signature per estimate;
`0118` already freezes a decided quote. The gate asserts all three instead of assuming them.

Payment components live in `components/payments/` (invoice receipt, confirmation card and form,
delivery card and form, the estimate decision card and form, the card payment form, the 3D Secure challenge
form, and the refusal vocabularies the forms share).
