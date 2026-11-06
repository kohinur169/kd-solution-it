// path: docs/handoffs/STEP_164_COMPLETED.md
# STEP 164 — Stripe Connect charges with platform fee split, payouts and signature verified idempotent webhooks

**Status: COMPLETED**

## STEP

- Number and title: STEP 164 — Stripe Connect charges with platform fee split, payouts and signature verified idempotent webhooks.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Stripe's fourth STEP: 161 read the documentation, 162 sealed the key, 163 created the `acct_`, this STEP spends and pays money and receives deliveries, and 165-169 close the sandbox cycle and the capability matrix.
- Depends on (earlier STEPs in this category and their handoff files): STEP 163 (`stripeAccountReadinessOf` gates every charge and transfer, `StripeAccountProvision` is the account of record), STEP 162 (`stripeConfigStore`, `stripeWebhookSecretsFor`, the sealed secret key and signing-secret roll), STEP 161 (`verifyStripeWebhookSignature`, `STRIPE_ACCOUNT_ID_PATTERN`, `sanitizeStripeText`, the status vocabulary), STEP 127 (`money.ts` — the ten-thousandth minor unit this STEP converts to cents), STEP 133 (`platform-fee.ts` — the fee this STEP splits), STEP 141 (the platform's payout decision this STEP's transfer leg executes), STEP 160 (`rainforest-webhook.ts` — the idempotency and fingerprint shape the receiver mirrors), and STEP 132, which posts the ledger entries from a confirmed payment and is deliberately not called here.

## Files

- Created:
  - `lib/payments/adapters/stripe-payment.ts` — the money movement. Records the documented surface (`STRIPE_PAYMENT_INTENTS_PATH = "/v1/payment_intents"`, `STRIPE_TRANSFERS_PATH = "/v1/transfers"`, the two id prefixes and patterns, `STRIPE_IDEMPOTENCY_HEADER = "Idempotency-Key"` and its key pattern), the settled charge type (`STRIPE_CHARGE_TYPE = "destination"` with `STRIPE_CHARGE_TYPE_REASON`), the documented statuses and `stripePaymentOutcomeOf`, the currency exponents and the exact conversion (`stripeAmountFromPlatformMinor`, `stripePlatformMinorFromAmount`), the request validators (`validateStripeChargeRequest`, `validateStripeTransferRequest`, `validateMetadata`, `carriesCardLikeText`), the body builders (`buildStripePaymentIntentBody`, `buildStripeTransferBody`, `encodeStripeForm`), the allowlisted `stripePaymentFetchTransport`, the answer readers (`parseStripePaymentIntentAnswer`, `parseStripeTransferAnswer`, `stripePaymentMessageOf`, `stripeDeclineCodeOf`), the `StripeAttempt` record with `InMemoryStripeAttemptStore` and `STRIPE_ATTEMPT_OUTCOMES`, `createStripeCharge`, `readStripePaymentIntent`, `applyStripePaymentIntentRead`, `createStripeTransfer`, `stripeBodyFingerprint` and `stripeIdempotencyKeyFor`.
  - `lib/payments/adapters/stripe-webhook.ts` — the receiver. Holds `STRIPE_EVENT_PATTERN`, `STRIPE_PAYMENT_EVENT_TYPES` (the three the destination-charges page names), `STRIPE_ACCOUNT_EVENT_TYPES`, `classifyStripeEventType`, `parseStripeEvent`, `verifyStripeDelivery` (current then previous secret, STEP 161's verifier), the `StripeWebhookRecord` with `InMemoryStripeWebhookStore`, `receiveStripeWebhook` and its `400`/`500`/`200` answers.
  - `lib/payments/adapters/stripe-payment-verify.ts` — the gate (258 checks).
  - `lib/payments/adapters/stripe-webhook-verify.ts` — the gate (119 checks, signing its own deliveries).
  - `docs/handoffs/STEP_164_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-stripe-payment` and `check:payments-adapters-stripe-webhook`, spliced into `verify` after `check:payments-adapters-stripe-accounts` and before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — the Stripe section gained the five pages read for this STEP (idempotent requests, destination charges, PaymentIntent lifecycle, separate charges and transfers, transfers/create), a "Verified for STEP 164" block, the resolution of the `Idempotency-Key` open question, a new open question about Payment Intents versus Checkout Sessions, five `Not run` sandbox rows, and the settled charge type in the capability matrix.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (two adapter files with their two gates), plus the two shared files an adapter STEP may change — `package.json` (two gate entries) and `docs/final/PROVIDER_DOCS.md` (the Stripe section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None. Two ports carry the state: `StripeAttemptStore` (one row per charge or transfer attempt, unique on `(companyId, kind, idempotencyKey)`, immutable amount, fee, currency, destination, kind, company and key, a version guard, a forward-only outcome table, a `created` row that must carry a `pi_`/`tr_` id and a row carrying an id that never changes its id) and `StripeWebhookStore` (one row per `(companyId, eventId)`, immutable event id and body fingerprint, a `stored` row that is the only entry point and a delivery count that moves one delivery at a time). Both have in-memory reference implementations that enforce what the real tables must enforce. The tables, their unique keys and their RLS belong to the STEP that persists them; no migration number was consumed and no rollback proof is owed.

## Environment

None read, none added. The secret key and the signing secret arrive through STEP 162's sealed configuration, never through a variable read by these files, and adapter STEPs do not own `lib/env`.

## Packages

None. `node:crypto` for the attempt id, the `Idempotency-Key` derivation and the body fingerprint, `lib/security/encryption.ts` to open the sealed credentials, and `fetch` for the three documented calls — no Stripe SDK, no new dependency.

## Behaviour Proof (acceptance checklist)

- **The amount unit is converted exactly once, and a wrong unit is refused rather than rounded.** A 2.90 USD platform amount (`29_000n` ten-thousandths) becomes `290` cents and back; a value that is not a whole cent, a zero, a negative, an unsupported currency and an over-large amount are each refused with their own reason before any call.
- **Only a ready account is charged.** `createStripeCharge` asks `stripeAccountReadinessOf` first and refuses an account that is not created, lacks `card_payments` or `stripe_transfers`, is blocked, or whose creation is unknown — with no call made; it also refuses a request naming another company or another connected account.
- **The request is validated before it is sent.** Idempotency key shape, destination pattern, amount, non-negative fee smaller than the amount and a whole number of cents, description length, and metadata key/value shape and count; a card-shaped description or metadata value is refused, which is the PCI barrier restated for this provider.
- **The body is the documented destination charge.** `amount`, `currency`, `transfer_data[destination]`, `application_fee_amount` and `automatic_payment_methods[enabled]`, with `confirm` and `payment_method` absent; a zero fee omits `application_fee_amount` entirely rather than sending `0`.
- **Idempotency is guarded twice.** The `Idempotency-Key` header is sent on every `POST` and never on a `GET`, and the `pending` attempt is written **before** the call: a replay of a created charge answers `already_created` with `requiresRead` and makes no call; a replay of an `unknown` attempt answers `in_flight`; a replay of a `declined` or `rejected` key is refused with "use a new idempotency key".
- **Every answer class is mapped.** `2XX` + `pi_` ⇒ `created` with the provider status, its platform outcome and the client secret (returned once); `402` ⇒ `declined` with the documented `decline_code`; `400`/`409`/`422` ⇒ `rejected`; `401`/`403`/`404`/`405`/`415`/`3xx` ⇒ `failed`; `408`/`425`/`429`/`5XX`, a thrown transport and a `2XX` naming no `pi_` id ⇒ `unknown` with `requiresReconciliation`.
- **Only a matching read is paid.** The read is a `GET` of the documented path with no idempotency key; `applyStripePaymentIntentRead` requires the same intent id and compares amount, currency and application fee in the platform's units, so a mismatch is `failed` with `requiresReconciliation` and never `paid`; a stale attempt is refused instead of overwritten; `processing` is `pending` and the customer-action statuses are not paid.
- **The payout leg is the documented transfer.** `amount`, `currency`, `destination`, `transfer_group` and metadata to `/v1/transfers` with its own `Idempotency-Key`; the answer's `tr_` id, amount, currency and destination are compared to the request, a mismatch is recorded as `failed` with reconciliation, and the documented insufficient-balance answer is reported as `insufficientFunds`; a replay answers `already_created` with no second transfer.
- **The client secret never lands in the record.** The attempt keeps `clientSecretIssued: true` only; the gate asserts the serialised record carries neither the value nor a `_secret_` fragment, and no audit entry carries a credential or a secret.
- **A delivery is verified before it is read.** The raw body and the `Stripe-Signature` header are checked with STEP 161's `t` + `v1` HMAC inside the documented 300-second tolerance, first against the current secret and then against the previous one only while STEP 162's 24-hour window is open; a wrong secret, a stale timestamp, a tampered body, a missing, oversized or unparsable header and a missing secret are each refused with `400`, and a keyring that cannot open the secret is `500`.
- **One event is applied once.** The record is written before the effect; a second delivery of a settled record answers `200` with `duplicate: true`, the effect does not run again and the delivery count moves; a second delivery of a `stored` record re-runs the effect, which is what a retry after `500` means; an effect that returns `skipped` or throws is answered `500` with `effect_failed`.
- **The record is not a body archive.** It keeps the event id, type, classification, object id and status, API version, livemode, a SHA-256 fingerprint of the body, the scheme, which secret verified it and the delivery count; the body, the signature header and the secret are never stored, and the secret role is recorded as `current`/`previous` only.
- **The documented event set.** `payment_intent.succeeded`, `payment_intent.processing` and `payment_intent.payment_failed` are `payment`; `account.updated` is `account` and can ask for a synchronisation; any other type is stored, acknowledged and never acted on.
- **UI** — not applicable: this STEP adds no screen, so no desktop or mobile width was checked. The payment page that consumes the client secret is STEP 183's.
- **Security** — validation happens before every call; the transport allowlists three paths, refuses redirects, bounds the timeout and refuses an oversized answer; credentials are opened per call and never returned; provider text is sanitised and capped; card-shaped values are refused; every outcome writes an audit entry that names the attempt, not the money; RLS and permission middleware were not touched, and no route or job was added, so no new surface exists to authorise.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint lib/payments/adapters/stripe-payment.ts lib/payments/adapters/stripe-payment-verify.ts lib/payments/adapters/stripe-webhook.ts lib/payments/adapters/stripe-webhook-verify.ts` — clean.
- `node lib/payments/adapters/stripe-payment-verify.ts` and `node --experimental-strip-types lib/payments/adapters/stripe-payment-verify.ts` — both pass. The verdict line:

  `payments Stripe Connect charges gate passed: 258 checks (the documented destination-charge body with its exact unit conversion and fee split, one Idempotency-Key per attempt with the store as the guard, an honest unknown that asks for reconciliation, a read that only pays a matching intent, and the documented transfer with its insufficient-balance answer)`

- `node lib/payments/adapters/stripe-webhook-verify.ts` and `node --experimental-strip-types lib/payments/adapters/stripe-webhook-verify.ts` — both pass. The verdict line:

  `payments Stripe Connect webhooks gate passed: 119 checks (the documented t and v1 signature checked before anything in the body is read, the previous secret accepted only inside its overlap window, one event applied once however often it is delivered, a failed effect answered with 500 so the retry repeats it, and a record that keeps a fingerprint instead of the body)`

- `npm run verify` — green end to end (every earlier gate, then `check:payments-adapters-stripe-payment` and `check:payments-adapters-stripe-webhook`, `typecheck`, `lint`, `build`, ending `✓ Compiled successfully`).
- No network call was made to Stripe and no real credential was used.

## Next

- STEP 165 — Airwallex documentation verification and sandbox notes: it reads the pages, records the rules and produces the same `partial` record this section does, with no credential.
- What this STEP hands to the Stripe sandbox cycle (STEPs 167-169) and to STEP 183's payment page: `createStripeCharge` with its `Idempotency-Key` guard, `readStripePaymentIntent` for the page's own status view, `applyStripePaymentIntentRead` as the only door to `paid`, `createStripeTransfer` for the payout leg, and `receiveStripeWebhook` with its `applyEvent` seam for the route that registers the endpoint.
- The open questions this STEP leaves are recorded in `PROVIDER_DOCS.md`: whether a released (non-preview) live version accepts the Accounts v2 surface, and whether STEP 183's screen is better served by a hosted Checkout Session than by the Payment Intents surface chosen here. The `Idempotency-Key` question is settled: the page was read and both spending calls send one.
