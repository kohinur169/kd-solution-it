// path: app/(client-portal)/README.md
# app/(client-portal)

Owner: STEP 181-190 (client portal, payment pages and payment links).

STEP 181 built the invoice link, STEP 182 the estimate link, STEP 183 the card payment page, STEP 184 the
3D Secure step in front of it. The links are read-only without a token, and each STEP writes only what its own
section asks for.

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

STEP 182 adds no migration. `0025` already carries `void_reason`, `voided_at` and `accepted_at`; `0027`
already carries the eight pieces of evidence and the unique index that makes one signature per estimate;
`0118` already freezes a decided quote. The gate asserts all three instead of assuming them.

Payment components live in `components/payments/` (invoice receipt, confirmation card and form,
delivery card and form, the estimate decision card and form, the card payment form, the 3D Secure challenge
form, and the refusal vocabularies the forms share).
