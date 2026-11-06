// path: docs/handoffs/STEP_168_COMPLETED.md
# STEP 168 — Airwallex payment acceptance integration

**Status: COMPLETED**

## STEP

- Number and title: STEP 168 — Airwallex payment acceptance integration.
- Category: Five Payment Provider Adapters (NMI, Payoneer, Rainforest, Stripe Connect, Airwallex), STEP 147-169. Airwallex's fourth STEP: 165 read the pages and recorded the sandbox notes, 166 sealed the credentials and proved them, 167 created the connected account and synced verification, this STEP takes the payment and confirms it without trusting the browser, and 169 closes the payouts, the webhooks and the capability matrix.
- Depends on (earlier STEPs in this category and their handoff files): STEP 165 (`airwallex.ts` — `AIRWALLEX_ENDPOINTS`, `AIRWALLEX_PAYMENT_INTENT_STATUSES`, `airwallexPaymentOutcomeOf`, `airwallexAmountFromPlatformMinor`, `airwallexPlatformMinorFromAmount`, `airwallexRequestIdFor`, `validateAirwallexPaymentIntentRequest`, `buildAirwallexPaymentIntentBody`, `sanitizeAirwallexText`), STEP 166 (`airwallex-client.ts` — the active configuration, `airwallexAccessTokenFor` and the in-memory token cache, `airwallexClientMessageOf`/`airwallexClientCodeOf`, `airwallexClientEndpoint`), STEP 167 (`airwallex-accounts.ts` — `airwallexAccountReadinessOf` and the connected-account record this STEP gates on), STEP 164 (`stripe-payment.ts` — the attempt-record shape this STEP mirrors: a pending row before the call, forward-only outcomes, an outcome table, a client secret handed out once, a read that settles an attempt and refuses a mismatch), and STEP 133/139 for the platform fee the attempt records.

## Files

- Created:
  - `lib/payments/adapters/airwallex-payment.ts` — payment acceptance. Holds the documented surface (`AIRWALLEX_PAYMENT_INTENT_CREATE_PATH`, `AIRWALLEX_PAYMENT_INTENT_PATH_PREFIX`, `AIRWALLEX_PAYMENT_INTENT_ID_PATTERN`, `AIRWALLEX_PAYMENT_INTENT_READ_PATH_PATTERN`, `AIRWALLEX_PAYMENT_ALLOWED_PATH_PATTERNS`, `isAirwallexPaymentPath`, `isAirwallexPaymentIntentId`, `airwallexPaymentIntentPath`, `AIRWALLEX_PAYMENT_TIMEOUT_MS`, `AIRWALLEX_PAYMENT_TEXT_MAXIMUM_LENGTH`, `AIRWALLEX_CLIENT_SECRET_MAXIMUM_LENGTH`), the request (`AirwallexChargeRequest`, `airwallexChargeRequestId`, `airwallexIntentRequestOf`, `validateAirwallexChargeRequest`, `airwallexChargeReferenceIsUsable`), the allowlisted transport (`AirwallexPaymentCall`, `airwallexPaymentFetchTransport`, which sends the documented `x-on-behalf-of`), the answer readers (`airwallexPaymentMessageOf`, `airwallexPaymentIntentIdOf`, `airwallexPaymentStatusOf`, `airwallexClientSecretOf`, `airwallexIntentAmountOf`, `parseAirwallexPaymentIntentAnswer`, `parseAirwallexPaymentReadAnswer`), the attempt record (`AirwallexPaymentAttempt`, `AIRWALLEX_ATTEMPT_OUTCOMES`, `AirwallexPaymentAttemptStore`, `InMemoryAirwallexPaymentAttemptStore`), the audit vocabulary, `createAirwallexCharge`, `readAirwallexPaymentIntent`, `applyAirwallexPaymentIntentRead`, `markAirwallexAttemptUnread`, and the fee/request-id helpers the screen will use.
  - `lib/payments/adapters/airwallex-payment-verify.ts` — the gate (249 checks, nine sections).
  - `docs/handoffs/STEP_168_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added `check:payments-adapters-airwallex-payment` and spliced it into the `verify` chain after `check:payments-adapters-airwallex-accounts`, before `typecheck`.
  - `docs/final/PROVIDER_DOCS.md` — one new bullet in the `## Airwallex (STEP 165)` section (the payment with its readiness gate, once-only client secret, duplicate handling and mismatch rule), the `request_id` rule re-worded to say this STEP sends the field, the platform-fee open question re-worded to say the fee is recorded but not sent, and the payment row extended plus one new `Not run` row for the intent read.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file with its gate — the STEP 154/157/161/162/163/164 shape), plus the two shared files an adapter STEP may change — `package.json` (one gate entry) and `docs/final/PROVIDER_DOCS.md` (the Airwallex section only). No migration, no `app/` route, no component, no `lib/env` change, no `services/` change, and no other STEP's file edited.

## Database

None. The store is the `AirwallexPaymentAttemptStore` port with an in-memory reference implementation that enforces the invariants the real table must carry: a unique attempt id, a unique `request_id` per company, an immutable company, provider, mode, amount, fee, currency, acting account and request id, a version guard, forward-only attempt outcomes, a `created` row that must carry an intent id, an intent id that never changes once written, and a settlement that exists only on a created row. The table, its unique key and its RLS belong to the STEP that persists payments; no migration number was consumed and no rollback proof is owed.

## Environment

None read, none added. The credentials arrive through STEP 166's sealed configuration, the token through STEP 166's in-memory cache, and the encryption key through the environment-backed keyring; adapter STEPs do not own `lib/env` or `.env.example`.

## Packages

None. `node:crypto` for the attempt id, `lib/security/encryption.ts` to open the sealed credentials, `lib/utils/freeze.ts`, and `fetch` for the two documented calls — no Airwallex SDK, no new dependency, and no card-data library, because card data never reaches this platform.

## Behaviour Proof (acceptance checklist)

- **A payment is attempted only for a ready account and a valid request.** The connected account's readiness is checked first — a `SUBMITTED`, `ACTION_REQUIRED`, `SUSPENDED`, rejected, unknown or not-yet-created account is refused with the mapping's own sentence, an account belonging to another company is refused, and an account that does not exist is refused; none of them writes an attempt or makes a call. The request is then validated: an amount that is not a whole minor unit, a zero amount, an unsupported currency, a blank or over-long reference, a blank or over-long merchant order id, an over-long descriptor, an HTTP return URL, a bad metadata key, an over-long metadata value, a credential in metadata, a negative fee and a fee that is not smaller than the payment are each refused with their own reason. The page's own rules run before the platform's arithmetic, so a bad amount is reported as a bad amount rather than as an oversized fee.
- **The body is the page's.** Major-unit `amount` (`1_000_000n → 100`, the exact opposite of Stripe's minor-unit field), upper-case `currency`, `merchant_order_id`, the derived `request_id`, and `return_url`/`descriptor`/`metadata` only when given. The gate asserts the body carries **no** client secret, no card field, no token, and **no fee field**: STEP 165 never read how Airwallex lets a platform take its fee, so the fee is recorded on the attempt for the ledger and deliberately not sent.
- **The idempotency key is the body's `request_id`, derived once.** `airwallexRequestIdFor(companyId, reference)` gives a deterministic 43-character key that matches STEP 165's documented pattern and bound, differs per reference and per company, and a replay with the same reference answers `already_created` without a call.
- **The client secret is handed out once and stored nowhere.** `createAirwallexCharge` returns it to its caller, records only `clientSecretIssued`, and the gate asserts the stored record and the applied-read result carry neither the secret nor the access token.
- **A `409` is not a rejection.** STEP 165's documented meaning of a duplicate request is that the original exists, so the attempt is recorded as `unknown` with `requiresReconciliation` and audited as `duplicate`; a replay then answers `in_flight` instead of creating a second intent. Treating it as a refusal would claim that a payment which may exist does not.
- **Every answer class is mapped.** `2XX` with an intent id and a documented status is `created` (with the client secret when the answer carries one); `400`/`422` are `rejected` with the page's own code kept; `401`/`403`, the remaining refusals and redirects are `failed`, so nothing exists and the pending row stays; `409` is `duplicate`; a timeout class, `429`, a `5XX`, a thrown transport and a `2XX` naming no id or no recorded status are `unknown`. An unrecorded status is never `paid`.
- **The browser's word is never what settles money.** `readAirwallexPaymentIntent` reads the intent with the token and the acting account, and `applyAirwallexPaymentIntentRead` settles the attempt only when the answered **amount, in the platform's own units,** and **currency** match the attempt — a mismatch becomes `failed` with `requiresReconciliation` and is audited as `mismatch`, never `paid`. A read describing another intent is refused. `markAirwallexAttemptUnread` records an unread attempt as needing reconciliation while keeping the status it already had, so nothing is invented.
- **The three paths are the only ones callable.** Create and the id-shaped read; `confirm`, `cancel`, the transfer endpoints, a trailing slash, the bare prefix and an `acct_` id in the id position are all refused, and the transport refuses an unallowlisted path, a missing token, a missing version, an `x-on-behalf-of` that does not name a connected account, a POST without a body and a GET with one — all before any network call.
- **UI** — not applicable: this STEP adds no screen, so no desktop or mobile width was checked. The payment page that will mount Airwallex's own component receives the client secret this file hands out; a screen is not part of an adapter STEP.
- **Security** — the client secret and the access token are pass-throughs; the record keeps a boolean and nothing else; the audit vocabulary names six actions (`airwallex_payment.created`, `.duplicate`, `.rejected`, `.unknown`, `.settled`, `.read_failed`) carrying the provider key, the company, the attempt, the intent id, the mode, the outcome and the time; every provider message is sanitised and bounded; the amount arithmetic is exact (integers only, no floating point reaching a payment or a ledger); and the store enforces the rules a later table must repeat. No route, no job and no table, so the pre-existing RLS and permission middleware are untouched.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/payments/adapters/airwallex-payment.ts lib/payments/adapters/airwallex-payment-verify.ts` — clean.
- `node lib/payments/adapters/airwallex-payment-verify.ts` and `node --experimental-strip-types lib/payments/adapters/airwallex-payment-verify.ts` — both pass. The verdict line:

  `payments Airwallex payment gate passed: 249 checks (a payment is attempted only for an ACTIVE connected account and only with a validated amount, currency, reference and fee, the documented body carries major units and a derived request_id and no card data, secret or fee, the client secret is handed out once and stored nowhere, a 409 is recorded as a duplicate rather than a rejection, and only a matching SUCCEEDED read settles paid while a mismatch never does)`

- The gate was proved to bite: with the readiness gate removed and the mismatch rule broken, it failed 8 of 249 checks and exited 1; both mutations were reverted before the run above.
- `npm run verify` — the full chain, including this new gate and the build, exits 0.
- `npm run check:structure` — `structure gate passed: 17 directories, 14 root files, 567 source files checked`.
- `npm run check:audit` — `audit gate passed: 3218 checks, …`.

## Not Run / Open

- **Nothing reached Airwallex.** No sandbox client id, API key, connected account or PaymentIntent exists in this environment, so the create and the read were exercised only against recorded answers. Both sandbox rows stay `Not run` and STEP 165's record stays `partial`; the documented test cards remain unused.
- **The platform fee is not collected through Airwallex.** The pages read for STEP 165 name no fee parameter, so the fee is recorded on the attempt and the body carries none. The payments-for-platforms pages must be read before a fee can be collected through the provider rather than through the platform's own settlement.
- **The PaymentIntent id has no documented prefix**, so the pattern is prefix-free and an `acct_` id is refused by name; the record carries `providerKey`, because this platform also stores Stripe's `pi_` ids.
- **Webhook-driven settlement is STEP 169.** This STEP confirms a payment by reading the intent; the subscription that pushes the same state, and the account-status event names STEP 165 could not read, belong to the next STEP.
- **Persistence, the route and the page are later work.** The store is a port with an in-memory reference implementation; the table, its RLS policy, the charge route and the payment page arrive with the STEP that needs them, and none is claimed here.
