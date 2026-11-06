# Payment Provider Documentation Notes

This file is created by STEP 147 and extended only by adapter STEPs (147-169). Each section records the documentation verification and sandbox notes for one provider.

---

## NMI (STEP 147)

### Documentation Sources

| Topic | URL | Status |
|---|---|---|
| NMI API Documentation | https://docs.nmi.com | Reviewed |
| Collect.js Hosted Fields | https://secure.nmi.com/token/Collect.js | Reviewed |
| NMI Gateway Integration | https://docs.nmi.com/gateway | Reviewed |
| Token-Based Payment Flow | https://docs.nmi.com | Reviewed |

### Review correction: Classic Payment API (2026-11-06)

- Transaction reference: https://docs.nmi.com/reference/transactions-processing
- Provider examples: https://docs.nmi.com/docs/payment-code-examples
- Classic processing response example: https://docs.nmi.com/docs/processing
- Collect.js token example: https://docs.nmi.com/docs/payer-authentication-3ds
- Sandbox endpoint: https://sandbox.nmi.com/api/transact.php; production endpoint: https://secure.nmi.com/api/transact.php.
- Classic requests are form encoded and use the private `security_key`, `payment_token`, `type=auth` for authorization and `transactionid` for follow-up transactions. Responses are URL encoded; `response=1` indicates approval, not `response_code=0`.
- The stored `apiKey` is the public tokenization key; `secretKey` is the private API security key. Only the public key may be used in frontend configuration. Existing configurations must be checked against these meanings.
- HTTP timeout, malformed response and network failures leave the outcome unknown. Reconcile before retrying. No sandbox transaction has been run in this review.

### Verified for STEP 152: response codes, Query API and status sync (2026-11-06)

Read in the STEP 152 coding session from NMI's own documentation:

- Response codes: https://docs.nmi.com/reference/response-codes
- Query API (Classic): https://docs.nmi.com/reference/query - `POST https://sandbox.nmi.com/api/query.php` with `security_key` and `transaction_id`, answered as `<nm_response>` XML; the transaction record carries the documented `condition`.
- Transaction processing: https://docs.nmi.com/reference/transactions-processing and https://docs.nmi.com/docs/processing
- Async transaction conditions: https://docs.nmi.com/docs/asyncstatus-polling - `pending` for a successful auth, `pendingsettlement` for a successful sale or credit, `complete` for a successful validate, `canceled` for a void, `failed` for a decline.
- Test mode: https://docs.nmi.com/docs/enable-test-mode-1 - every valid card is approved in test mode and nothing is sent to a processor.
- Sandbox query endpoint: https://sandbox.nmi.com/api/query.php; production query endpoint: https://secure.nmi.com/api/query.php.

Recorded rules from those pages:

- `response` is 1 approved, 2 declined, 3 an error in the transaction data or a system error. `response_code` is the detailed code: 100 approved, 200-264 declined, 300 rejected by the gateway, 400-461 processor, configuration and communication errors.
- `420`, `421` (communication errors) and `430` (duplicate at the processor) are not final outcomes: the charge may have been taken and the answer lost. They are reconciled, never retried.
- The Query API reports UTC and returns the transaction `condition` plus one `<action>` per step; a voided transaction is `canceled` and a settled one is `complete`.

### Verified for STEP 153: sub-merchant boarding and webhook signatures (2026-11-06)

Read in the STEP 153 coding session from NMI's own documentation:

- Create Merchant: https://docs.nmi.com/reference/create-merchant - `POST /v4/merchants` with `Content-Type: application/json` and the `Authorization` v4 API key; documented body `type`, `company`, `externalIdentifier`, `country`, `address1`, `address2`, `city`, `state`, `zip`, `url`, `timezone`, `firstName`, `lastName`, `email`, `phone`, `fax`, `language`, `username`, `accountInfo`; documented answer `{objectType: "merchant", id, status, parentAffiliateId, ...}`.
- v4 API overview: https://docs.nmi.com/reference/nmi-gateway-features - JSON requests, the `Authorization` header holds a v4 API key created in the Partner portal, sandbox base URL `https://sandbox.nmi.com/api`.
- Merchant information: https://docs.nmi.com/reference/get-specific-merchant-information - `GET /v4/merchants/{gateway_id}` re-reads the merchant after boarding.
- Merchant security keys: https://docs.nmi.com/reference/create-merchant-key - `POST /v4/merchants/{gateway_id}/security_keys` issues that merchant's own keys.
- Webhooks overview: https://docs.nmi.com/reference/overview - deliveries are `{event_id, event_type, event_body}`, the endpoint and signing key live under Settings > Webhooks, the header is `Webhook-Signature: t=<nonce>,s=<hex>` and the signature is `hash_hmac("sha256", nonce . "." . body, signingKey)`.
- Event pages: https://docs.nmi.com/reference/transaction-events, https://docs.nmi.com/reference/settlement-events, https://docs.nmi.com/reference/check-status, https://docs.nmi.com/reference/recurring-events, https://docs.nmi.com/reference/apple-pay (ACU summaries), https://docs.nmi.com/reference/chargeback-events - the 35 documented event names the adapter recognises.

Recorded rules from those pages:

- The created merchant's gateway id is the top level `id` of the answer, and the merchant starts in the provider status `pending`; `parentAffiliateId` names the affiliate it was boarded under.
- `t` is a nonce, not a timestamp, so the signature scheme carries no replay window of its own: de-duplication on `event_id` is the replay defence, which is what the adapter implements.
- The signature is over the raw, unparsed body - re-serialising the JSON changes the digest.

### Integration Notes

- Card data is collected only through Collect.js hosted fields (https://secure.nmi.com/token/Collect.js), which returns a payment token to the browser.
- The platform never reads, stores, or tracks card data. All card input happens inside the provider-hosted Collect.js fields.
- The payment token from Collect.js is used for payment through the NMI API exactly as the official NMI documentation describes.
- The NMI gateway handles payment processing as documented by NMI.

### Sandbox Notes

| Test | Result | Details |
|---|---|---|
| Token generation via Collect.js | Pending | To be tested in NMI sandbox |
| Charge via NMI API | Pending | To be tested in NMI sandbox |
| Refund via NMI API | Pending | To be tested in NMI sandbox |
| Capture via NMI API | Pending | To be tested in NMI sandbox |
| Void via NMI API | Pending | To be tested in NMI sandbox |
| Status sync via Query API | Pending | To be tested in NMI sandbox with a real sandbox security key |
| Sub-merchant boarding via `POST /v4/merchants` | Not run | Implemented as `provisionNmiSubmerchant` in `lib/payments/adapters/nmi-submerchant.ts`; no NMI sandbox v4 API key exists in this environment, so no merchant was boarded. Exercised against a recording transport with the documented answer only. |
| Webhook signature verification and replay defence | Not run | Implemented as `verifyNmiWebhookSignature` and `receiveNmiWebhook`; exercised with locally signed deliveries only, because a sandbox webhook needs a registered endpoint and a signing key this environment does not have. |
| Documented sandbox cycle (sale, auth, capture, partial refund, auth, void) | Not run | Implemented as `runNmiSandboxCycle` in `lib/payments/adapters/nmi-status-sync.ts`; no NMI sandbox credentials exist in this environment, so no live transaction was submitted. Exercised against a recording transport only. |

### Capability Matrix

- Charges: Yes
- Payouts: No (NMI is payments only)
- Connected accounts: Yes (creates sub-merchants)

## Payoneer (STEP 154)

Payoneer is a payouts-only provider for this platform: it accepts no card payments and creates no
sub-merchant. The provider matrix in `lib/gateways/registry.ts` records it as `-P-` (no acceptance, payouts, no
sub-merchants). The service that records a verification is `lib/payments/adapters/payoneer.ts`.

### Documentation Sources (read in the STEP 154 session, 2026-11-06)

| Topic | URL | What it established |
|---|---|---|
| Developer platform index | https://www.payoneer.com/developers-docs/ | The product families; payouts live under Mass Payout, and the program-scope API reference is the separate reference document. |
| Mass Payout product index | https://www.payoneer.com/developers-docs/mass-payout/ | The three payout pages: payee onboarding, submit mass payout, and the China SAFE variant. |
| Submit mass payout | https://www.payoneer.com/developers-docs/mass-payout/mass-submit-payout/ | `POST /v4/programs/{program_id}/masspayouts`, the `Payments` array fields, the 500 payout limit, pre-deposited funds and asynchronous processing. |
| Payee onboarding | https://www.payoneer.com/developers-docs/mass-payout/mass-payee-onboarding/ | `POST /v4/programs/{program_id}/payees/registration-link` and its redirect URL, `already_have_an_account`, prefill and `lock_type`, and the payee status endpoint. |
| Payout status query | https://www.payoneer.com/developers-docs/business-funding/business-funding-getting-started/ | `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status` and its `result` fields, including `load_date` present only once the status is `Transferred`. |
| Program API reference | https://developer.payoneer.com/docs/mass-payouts-and-services.html | The endpoint catalogue, the token management APIs, payee and payout submission groups, the webhook catalogue, and the reference tables. |
| White-label payouts guide V4 | https://developer.payoneer.com/docs/white-label-payouts-v4.html | The integration flow and the IPCN notification sections. |
| Sandbox environment and communication security | https://developer.payoneer.com/psd2/get-started | The sandbox and production authorization hosts (`login.sandbox.payoneer.com`, `login.payoneer.com`) and the TLS 1.2 requirement. |

### Recorded Rules

- Sandbox API base `https://api.sandbox.payoneer.com`; production `https://api.payoneer.com`. Sandbox and production credentials differ, so moving to production changes the base URL and the credentials only.
- Authorization hosts `https://login.sandbox.payoneer.com` and `https://login.payoneer.com`; calls carry an OAuth2 bearer token, and the token management APIs cover access tokens, application tokens, refresh and revoke.
- Communications require TLS 1.2 or better.
- Mass payout is `POST /v4/programs/{program_id}/masspayouts` with a `Payments` array; each payment carries `client_reference_id`, `payee_id`, `amount`, `currency` and `description`. One call carries at most 500 payouts, and the program must already hold deposited funds.
- Payout processing is asynchronous: the platform follows a payout through the status endpoint or the IPCN notifications, never through the submit answer alone.
- Payee onboarding is `POST /v4/programs/{program_id}/payees/registration-link`, which answers a URL the payee is redirected to. `payee_id` is the platform's own identifier and is what every later payout names. The link can pre-fill payee data and lock fields with `lock_type`, and `already_have_an_account` links an existing Payoneer account instead of a sign-up.
- A payee must be `Active` before it can receive payments; the status is read with `GET /v4/programs/{program_id}/payees/{ClientPayeeID}/status` or notified by webhook.
- Payout status is `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status`, answered with `status`, `amount`, `currency`, `target_amount`, `target_currency`, `payee_id`, `payout_id`, `scheduled_payout_date` and `load_date`.
- Webhook consumer URLs are configured per notification in the Settings tab of the Payoneer Admin Console. The documented notifications cover payee approved and declined, payout request received and accepted, account or card loaded, sent to bank, failed bank transfer, payout canceled, and account funded.
- A failed notification delivery is retried; the published integration guide documents five additional attempts before an email is sent to a pre-configured address in the client's organization.
- The reference publishes error, field-validation, payee-declined, pending-payout and cancel-payout reason tables; STEP 156 must map against those tables rather than inventing status strings.

### Verified for STEP 155: credential shape and the token grant (2026-11-06)

- The Payoneer credential set this platform stores is the OAuth2 client id, the client secret and the program id, plus the environment. Sandbox and production credentials differ (see the sandbox environment page recorded above).
- The connection test performs the OAuth2 **client-credentials grant** against `https://login.sandbox.payoneer.com/oauth2/token` or `https://login.payoneer.com/oauth2/token`. A token answer proves the client id and secret; it does **not** prove the program id, because no program-level probe is published on the pages read. The test therefore reports `programVerified: false` and the first program-scope read in STEP 156 confirms the program.
- The request encoding and the answer field used here are the standard client-credentials grant (`application/x-www-form-urlencoded` with `grant_type=client_credentials`, `client_id`, `client_secret`; the token read from `access_token`, with `token` accepted as an alias). Payoneer's token-management section is present in the reference but its text is script-rendered and was not readable in this session, so this standard shape is recorded as **to be confirmed** on the first sandbox token call rather than claimed as provider-specific documentation.
- The credentials are sealed with the platform's single encryption module (`lib/security/encryption.ts`) under the scope `gateway:<companyId>:payoneer:<client_id|client_secret>`, so a sealed value cannot be opened for another company, another provider or the other credential.

### Verified for STEP 156: bank linking, payouts and status handling (2026-11-06)

- Automatic bank linking is **Register Payee with token**: `POST https://api.sandbox.payoneer.com/v4/programs/{program_id}/payees/register-payee-with-token` (production: `https://api.payoneer.com`). The published body is `payee_id`, `payee { type, company { name, url, legal_type, incorporated_address_1, incorporated_address_2, incorporated_city, incorporated_state, incorporated_zipcode, incorporated_country } }` and `payout_method { type: "BANKTRANSFER", bank_account_type, country, currency }`; the answer carries the payee reference and a registration token or link the payee continues with. The adapter's provider bank reference is the Payoneer **payee id**, which is what every payout names.
- Payout submission is `POST /v4/programs/{program_id}/masspayouts` with a `Payments` array of at most **500** instructions. Each instruction carries `client_reference_id`, `payee_id`, `amount`, `currency`, `description` and, when the platform sends the bank details with the payment (the published "One Step Payments" shape), `payout_method_details { payee, payout_method { bank_account_type, currency, country, details { bank_name, account_name, account_number, account_type, routing_number } } }`.
- The published validation answer "lists the specific `client_reference_id` values that failed", so an instruction is only refused when the answer names it; the listed entry's message is what the merchant's failure notice says.
- Payout status is `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status`, answered with `result.status` and `result.load_date`. **`Transferred` is the only status value the pages read publish**, and it is the only one the adapter maps to success. `load_date` must be present beside it; `Transferred` without it is treated as unknown rather than assumed.
- Payout notifications are the documented names: `Request received`, `Request accepted`, `Account/card loaded`, `Sent to bank`, `Failed bank transfer`, `Payout canceled`, `Account funded`. The adapter maps loaded to success, failed bank transfer and canceled to failed, and the three request/acknowledgement states to pending; `Sent to bank` stays pending because the funds can still be returned. Any other name is unknown.
- The notification signing scheme is still **unverified** (see STEP 154's open questions), so the adapter refuses every notification that is not passed through a caller-supplied verifier; until the scheme is read, payouts are followed by the status query, which needs no signature.
- The documented account type of the published payout example is `C` for a US routing-number account; the adapter sends it only in that shape and sends no account type for a SWIFT account, because no SWIFT example is published.

### Open Questions (recorded, not assumed)

- **Webhook signing is not yet read.** The API reference lists a Webhooks Security section, but its text is rendered by script and was not readable in this session. The exact header and digest must be read from that section before STEP 157 implements verification, and until then no Payoneer signature may be trusted. (A third-party SDK describes an `Authorization: hmacauth <AppName>:<Signature>:<Nonce>:<Timestamp>` header with HMAC-SHA256 over app name, method, URL, timestamp, nonce and body digest; that is **not** first-party and is recorded here only so nobody mistakes it for verified documentation.)
- **Token lifetime is not stated** on the pages read; STEP 155 must treat expiry as unknown and refresh from the token answer rather than assuming a fixed lifetime.
- **No sandbox credentials exist** in this environment: Payoneer issues them during account setup, so no sandbox call was executed and nothing below is claimed as passed.

### Sandbox Notes

| Step | Call | Result | Details |
|---|---|---|---|
| Create a registration link | `POST /v4/programs/{program_id}/payees/registration-link` | Not run | No Payoneer sandbox credentials exist in this environment. |
| Read the payee status | `GET /v4/programs/{program_id}/payees/{payee_id}/status` | Not run | No Payoneer sandbox credentials exist in this environment. |
| Submit a single payout | `POST /v4/programs/{program_id}/masspayouts` | Not run | No Payoneer sandbox credentials exist in this environment. |
| Read the payout status to `Transferred` | `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status` | Not run | No Payoneer sandbox credentials exist in this environment. |
| Receive and verify a signed IPCN | `POST /ipcn/{notification}` | Not run | No endpoint is registered and the signing scheme is not yet read (see open questions). |

Added by STEP 156 (same reason: no Payoneer sandbox credential exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Register the merchant as a payee (automatic bank link) | `POST /v4/programs/{program_id}/payees/register-payee-with-token` | Not run | Implemented as `registerPayoneerPayee`; exercised against recorded answers only. No payee was created at Payoneer. |
| Submit one payout instruction | `POST /v4/programs/{program_id}/masspayouts` | Not run | Implemented as `submitPayoneerPayout` with a client-reference idempotency store; no money was instructed. |
| Read the payout status to `Transferred` | `GET /v4/programs/{program_id}/payouts/{client_reference_id}/status` | Not run | Implemented as `readPayoneerPayoutStatus`; only a recorded `Transferred` answer with `load_date` maps to success. |
| Apply a payout notification through a verifier | `POST /ipcn/{notification}` | Not run | Implemented as `applyPayoneerPayoutNotification`, which refuses every delivery while no verifier exists. |

Added by STEP 164 (same reason: no sandbox key, connected account or signing secret exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Charge a customer with the platform fee | `POST /v1/payment_intents` | Not run | Implemented as `createStripeCharge`; exercised against a recording transport only. The documented test cards (4242…4242 succeeds, 4000…3155 needs authentication, 4000…9995 is declined) are recorded and unused. |
| Confirm the charge without trusting the browser | `GET /v1/payment_intents/{id}` | Not run | Implemented as `readStripePaymentIntent` and `applyStripePaymentIntentRead`; no intent exists to read. |
| Pay the merchant's balance out | `POST /v1/transfers` | Not run | Implemented as `createStripeTransfer`; no connected account has a balance, so the documented `balance_insufficient` path was produced by a fixture, not by Stripe. |
| Receive a signed delivery | the endpoint's raw body plus `Stripe-Signature` | Not run | Implemented as `receiveStripeWebhook`; every delivery in the gate was signed with a fixture secret, and no endpoint is registered with Stripe. |
| Replay a delivery | the same `evt_` id twice | Not run | The duplicate path was exercised locally; no real retry was received. |

The record these notes produce is `partial`, never `verified`: `calculatePayoneerStatus` requires the whole five
step cycle to be present and passed before a record can read as verified.

### Capability Matrix

- Charges: No
- Payouts: Yes
- Connected accounts: No (Payoneer pays registered payees; it does not create sub-merchants)

## Rainforest (STEP 157)

Rainforest is an acceptance and sub-merchant provider for this platform: it processes card and ACH
payins for the platform's merchants, onboards those merchants and runs the KYC/KYB underwriting, and it
is not used for this platform's payouts. The provider matrix in `lib/gateways/registry.ts` records it as
`acceptance: true, payouts: false, submerchant: true`. The service that records a verification is
`lib/payments/adapters/rainforest.ts`.

### Documentation Sources (read in the STEP 157 session, 2026-11-06)

All pages are on Rainforest's own documentation host, `docs.rainforestpay.com`. The index at
`https://docs.rainforestpay.com/llms.txt` is how the pages were found, and each page below was read in
its published markdown form.

| Topic | URL | What it established |
|---|---|---|
| Rainforest overview | https://docs.rainforestpay.com/docs/overview.md | The platform/merchant/user model, that Rainforest performs KYC/KYB and answers approved, declined or manual review, and the payin/refund/deposit vocabulary. |
| API keys | https://docs.rainforestpay.com/docs/api-keys.md | That an API key is a long-lived server credential that must never reach the browser, and the permission model: `resource:action`, Rainforest groups and constrained statements. |
| Authentication | https://docs.rainforestpay.com/reference/authentication.md | Bearer authentication, the `apikey_` production and `sbx_apikey_` sandbox key prefixes, and the documented sandbox call URL `https://api.sandbox.rainforestpay.com/v1/`. |
| Moving to production | https://docs.rainforestpay.com/docs/moving-to-production.md | The sandbox and production base URLs, separate data/keys/ids per environment, and the `sbx_` sandbox id prefix. |
| API version upgrades | https://docs.rainforestpay.com/docs/api-version-upgrades.md | The `Rainforest-Api-Version` header, the current version `2024-10-16`, the older versions, and that a request below the platform minimum fails with 400. |
| Process payins via API | https://docs.rainforestpay.com/docs/process-payins-via-api.md | The two-call payin flow (payin config, then `POST /v1/payins`), `method_type` `CARD`/`ACH`, the method field requirements, and the Rainforest approval the direct API integration needs. |
| Onboarding merchants via API | https://docs.rainforestpay.com/docs/onboarding-merchants-via-api.md | The API onboarding sequence (deposit method config, deposit method, merchant with `deposit_routes`, application update, submit), the required fields per merchant type, and `validation_errors`. |
| Understanding payins | https://docs.rainforestpay.com/docs/understanding-payins.md | The payin status table, real-time card authorisation, ACH settlement without one, T+1 and T+4 deposit timing, and `SUCCEEDED` as funds available to deposit. |
| Payin webhooks | https://docs.rainforestpay.com/docs/payin-webhooks.md | The `payin.{status}` event names, the `{data, event_type}` payload, and the payin fields including `idempotency_key`, minor-unit amounts and USD-only `currency_code`. |
| Merchant webhooks | https://docs.rainforestpay.com/docs/merchant-webhooks.md | The `merchant.{status}` event names, the merchant status vocabulary, and `merchant.active` as the ready-to-process notification. |
| Merchant application webhooks | https://docs.rainforestpay.com/docs/merchant-application-webhooks.md | The `merchant_application.{status}` event names and the application status vocabulary, including `COMPLETED` and `DECLINED`. |
| Webhooks | https://docs.rainforestpay.com/docs/webhooks-and-notifications.md | Per-endpoint signing keys, the four source addresses, the ~28 hour retry schedule, `message.attempt.exhausted`, and portal replay. |
| On-premises webhook integration | https://docs.rainforestpay.com/docs/on-premises-webhook-integration.md | That webhooks are at-least-once, that the resource id plus `event_type` is the idempotency key, and that the signature must be validated at the final destination. |
| Test accounts and cards | https://docs.rainforestpay.com/docs/test-accounts-and-cards.md | The sandbox test cards and ACH accounts: an approved card leaves the payin `PROCESSING`, an unlisted card is `FAILED`, and any valid sandbox account is approved. |
| Going live | https://docs.rainforestpay.com/docs/going-live.md | The three launch phases, and that production access, a production merchant, a default billing profile and a residuals account are Rainforest-side prerequisites. |

### Recorded Rules

- The API is bearer authenticated: `Authorization: Bearer <api_key>`, production keys prefixed `apikey_`, sandbox keys prefixed `sbx_apikey_`. A key is a server credential and must never reach the browser, a log line, a record or a handoff file.
- Bases are `https://api.sandbox.rainforestpay.com` and `https://api.rainforestpay.com` under `/v1`. Sandbox and production hold separate data, keys and ids, and sandbox ids carry the `sbx_` prefix.
- Every request may select the API version with `Rainforest-Api-Version`; the current version is `2024-10-16` (older: `2023-12-01`, `2023-01-01`), webhook payload shapes follow the platform's minimum version, and a request below that minimum fails with 400.
- API key permissions are statements of `resource:action` permissions or a Rainforest group such as `group#all` or `group#payment_component`, optionally constrained by resource fields such as `merchant_id`; multiple statements are OR'd.
- A payin is two calls: `POST /v1/payin_configs` (merchant, idempotency key, amount, currency) and `POST /v1/payins` against that config with `method_type` `CARD` or `ACH`. Both require the merchant to be `ACTIVE`; `amount` is in minor units and `currency_code` is documented as USD only.
- Sending raw card or bank account data through the API is a direct-to-API integration that requires Rainforest approval, and an ACH `account_number` is sent encrypted with RSA-OAEP-SHA256. The components exist so sensitive data never reaches the platform's servers, so this platform never accepts, logs or stores a raw card number.
- A card payin is authorised in real time and then sits in `PROCESSING` until it becomes `SUCCEEDED` (funds available to deposit; T+1 standard for card, T+4 for ACH). An ACH payin has no real-time authorisation and can be returned after processing, so a processing ACH payin is not settled money.
- Payin statuses: `CREATED`, `PRESENTING`, `AUTHORIZED`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `RETURNED`, `CANCELED`, `IN_REVIEW`, with events named `payin.{status}` in lower case.
- Merchant statuses: `PENDING`, `ONBOARDING`, `ACTIVE`, `SUSPENDED`, `DEACTIVATED`, `CANCELED`. Application statuses: `CREATED`, `IN_PROGRESS`, `PROCESSING`, `NEEDS_INFORMATION`, `IN_REVIEW`, `COMPLETED`, `DECLINED`, with `merchant_application.{status}` events.
- API onboarding runs: deposit method config, ACH deposit method with `account_holder_type` `BUSINESS`, merchant with `deposit_routes` naming that deposit method, application update, then submit. Required for every merchant type: `name`, `dba_name`, `legal_name`, `merchant_type`, `mcc`, `email`, `website`, `phone_number`, `average_ticket`, `high_ticket`, `average_monthly_volume`, the address block, `owner_1` and (except for an individual) `tax_id`.
- Every webhook delivery is `{ data, event_type }` where `event_type` is `{resource}.{status}` and `data` carries the same fields the resource's GET endpoint returns.
- Each endpoint has its own signing key, shown beside the endpoint in the platform portal. Webhooks come from `44.228.126.217`, `50.112.21.217`, `52.24.126.164` and `54.148.139.208`.
- Delivery is retried for approximately 28 hours (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h); any 2XX inside 15 seconds acknowledges; an exhausted attempt is reported as `message.attempt.exhausted`; an endpoint failing for 5 consecutive days is disabled.
- Webhooks are at-least-once and can be replayed from the portal, so a consumer is idempotent on the resource id and `event_type`.

### Verified for STEP 158: credential shape and the connection test (2026-11-06)

- The credential set this platform stores is the **API key** plus the environment. It is sealed with the
  platform's single encryption module (`lib/security/encryption.ts`) under the scope
  `gateway:<companyId>:rainforest:api_key`, so a sealed value cannot be opened for another company or
  another provider.
- The documented key prefix is checked against the named environment **before** anything is sealed: a
  production key (`apikey_`) in a sandbox configuration, or a sandbox key (`sbx_apikey_`) in a production
  one, is refused. The prefix is the documentation's only way to tell the two apart, and a mismatched pair
  would send the wrong key to the wrong base URL and report a rejection that says nothing about the key the
  admin meant to configure.
- The masked view shows the documented prefix and only the last four characters of the key, with the stars
  capped at twelve; a stored key's view is built by opening and immediately masking, so the screen never
  receives a full credential.
- The connection test performs the documented authenticated read
  `GET https://api.sandbox.rainforestpay.com/v1/api_keys` (production: `https://api.rainforestpay.com`) with
  `Authorization: Bearer <api_key>`, `Accept: application/json` and the **`Rainforest-Api-Version: 2024-10-16`
  header sent explicitly**, because the platform's minimum version is a portal setting the docs do not
  expose. Redirects are refused, the timeout is 15 seconds and an answer over 64 KiB is refused.
- What each answer means: a `2XX` with a parseable body is **connected** — the key authenticated against that
  environment, and because sandbox and production keys and data are separate, the environment is proven too;
  only the **number** of keys the read listed is reported, never a key. `401` and `403` are **rejected** with
  the documented `errors` message sanitised. A `400` is **failed**, not rejected: the documented cause is a
  request the API refused (an API version below the platform minimum), so the key was not judged. Redirects,
  `404`, `409`, `415` and `422` are **failed**; `408`, `425`, `429` and every `5xx` are **unreachable**; a
  thrown transport is **unreachable** and never repeats the thrown text; a `2XX` with an empty or unparseable
  body proves nothing and is **failed**.
- The outcome is recorded on the key as `lastTest { outcome, testedAtEpochMs, environment }` with a
  version-guarded write, and **activation refuses unless that record says `connected` for the key's own
  environment** — which is how "a provider cannot be enabled when its connection test fails" becomes a
  property of the code. The reference store enforces the same rule, so a caller that bypasses the service
  cannot activate an unproven key either.
- Rotation runs in the documented order: add the replacement key while the old one serves traffic → run its
  connection test → activate it (the old key becomes `superseded` and stays readable through the window) →
  retire the old key. Every step writes an audit entry (`provider_key.configured`, `provider_key.tested`,
  `provider_key.activated`, `provider_key.rotated`, `provider_key.retired`), and none of them carries a key.
- **The connection test was not run against Rainforest**: no sandbox account or API key exists in this
  environment, so the request shape and the outcome table were exercised against a recording transport only.
  It does not prove payments or merchants — that is STEP 159 and STEP 160, and they may only run once a key
  is active.

### Verified for STEP 159: payment acceptance through the component (2026-11-06)

- **The acceptance path is the component path, not the API path.** `POST /v1/payins` with a card or a bank
  account is the direct-to-API flow, which the documentation gates behind Rainforest approval (see open
  questions) and which would put the platform's servers inside cardholder-data scope. STEP 159 therefore
  builds the three documented component steps and nothing else: create the payin config
  (`POST /v1/payin_configs`), create the session (`POST /v1/sessions`), and read the outcome
  (`GET /v1/payins/{payin_id}`) that the component's `approved` event hands back as `payin_id`.
- **No input type in the adapter can carry a card or a bank account number.** The payin config body is built
  from a fixed documented field list — `merchant_id`, `idempotency_key`, `amount`, `currency_code` and, when
  supplied, `billing_contact`, `amount_splits` and `metadata` — and the gate asserts that a built body holds
  no card, card-number, CVV, account-number, routing-number or IBAN field and no card-number text. Anything
  sensitive is collected by the component in the browser, which is what the documentation means by
  "without exposing your platform to the sensitive payment data".
- **The payin config is validated against the documented field rules.** `amount` is minor units with the
  documented minimum of 1 and a ceiling of the largest integer the provider's `integer` field carries
  safely; `currency_code` is the platform's single currency, USD; the merchant id must carry the documented
  `mid_`/`sbx_mid_` prefix; at most one `PLATFORM` split is allowed, each `MERCHANT` split must name a valid
  and unique merchant, and the splits may not add up past the payin; metadata is non-sensitive and capped
  (20 keys, key shape, 200 characters per value). A `billing_contact` is only sent when it is valid, and its
  documented keys are `name`, `postal_code`, `country`, `state`, `email` and `phone` — the component asks the
  user for whatever the config does not pre-fill, and a card payin needs the postal code while an ACH payin
  needs the name.
- **Creation is idempotent and never sends twice.** The submission row (one per company and idempotency key,
  company/key/merchant/amount/currency immutable, forward-only outcome, version-guarded) is stored **before**
  the call. A replay answers from the store; a replay with another amount, merchant or currency is refused
  because the same key with different details is a mistake, not a retry; an in-flight duplicate answers
  `unknown` without a provider call. A payin config may back **one successful payin** and may be reused to
  retry after a failure, which is what the caller's retry loop relies on.
- **The creation answer table.** `2XX` naming a documented `cfg_`/`sbx_cfg_` id is `created`. `400`, `409` and
  `422` are the documented validation answers and are `rejected` with the `errors[].field` and
  `errors[].message` carried sanitised. `401`, `403`, `404`, `405`, `415` and any redirect prove no config was
  created and are `failed`. `408`, `425`, `429`, every `5XX`, a thrown transport, and a `2XX` without a usable
  config id are `unknown` with `requiresReconciliation` — the config may exist, and replaying the same key is
  how the caller settles it.
- **The session is scoped down to one merchant and one permission group.** The body is
  `{ttl, statements: [{permissions: ["group#payment_component"], constraints: {merchant: {merchant_id}}}]}`,
  straight from the session reference: the documented maximum lifetime is 86,400 seconds, this adapter
  defaults to 3,600 and refuses anything under 60 or over the maximum, and it never asks for `group#all`
  because a browser credential must do the one thing the page needs. The `session_key` (`sessionkey_…`) is
  returned to the caller — the documentation says a session is designed to be transmitted to the front-end —
  and is **never** written to the submission store, an audit entry or an error message; the gate asserts
  that. A session answer without a usable key fails; a `400`/`422` is `rejected`; anything else fails, which
  is safe to retry because a session moves no money.
- **The component contract is published as data, not rendered here.** `rainforestPaymentComponentFor`
  returns the documented element `<rainforest-payment session-key="…" payin-config-id="…">`, the bundle of
  the environment (`https://static.rainforestpay.com/sandbox.payment.js`, production
  `https://static.rainforestpay.com/payment.js`), and refuses to build half a contract from a session key or
  config id of the wrong shape. A Content Security Policy must allow `*.rainforestpay.com` in `script-src`
  and `frame-src` for the component to load; STEP 183 renders it.
- **Reading a payin has exactly one success.** Only the documented `SUCCEEDED` status — funds available to
  deposit — maps to `succeeded`, and only when the amount and the currency the provider reports equal the
  ones the platform created the config for. A mismatch is `unknown` with `requiresReconciliation`, never a
  success, because a payin that settled another amount is a person's problem, not a ledger entry. `CREATED`,
  `PRESENTING`, `AUTHORIZED`, `PROCESSING` and `IN_REVIEW` are `pending`; `FAILED`, `RETURNED` and `CANCELED`
  are `failed` with the provider's `refusal_code` and its `detailed_refusal_desc` (preferred) or `refusal_desc`,
  sanitised and capped. The 23 documented refusal codes are recorded verbatim, and a code Rainforest has not
  published is carried as text with `refusalCodeKnown: false` rather than being treated as known.
- **A read never produces evidence that no money moved.** An undocumented status, a missing `data`, an empty
  or unparseable body, a `404`, and every non-`2XX` answer or thrown transport are `unknown` with
  `requiresReconciliation`. That is the platform's rule from STEP 130/132: only a success may post, and an
  unreadable answer may not be recorded as a failure.
- **This is not the payment core.** The adapter writes no payment record, no ledger entry and no invoice; the
  core has no acceptance port yet, so the adapter publishes the provider-side contract
  (`succeeded`/`pending`/`failed`/`unknown`) that the route or job maps onto STEP 130's payment and STEP 132's
  ledger. It is not the webhook receiver either — delivery verification and `payin.processing` /
  `payin.failed` are STEP 160's.
- **None of it ran against Rainforest.** No sandbox account or API key exists in this environment, so the
  creation, session and read paths were exercised against recording transports only (440 checks in
  `lib/payments/adapters/rainforest-payment-verify.ts`). No payin was taken, no session was issued and no
  card was ever collected.

### Verified for STEP 160: sub-merchant onboarding and signature-verified idempotent webhooks (2026-11-06)

- **The onboarding path is the component path, for the same reason the payin path is.** Rainforest publishes
  two onboarding integrations. The direct-to-API one (`docs/onboarding-merchants-via-api.md`) is gated behind
  Rainforest approval and its payload carries `encrypted_tax_id`, `owner_1.encrypted_ssn` and the deposit
  method's `account_number` and `routing_number`. The component one
  (`docs/onboarding-merchants-via-component.md`) is four documented steps: create the merchant
  (`POST /v1/merchants`), create a session with `group#merchant_onboarding_component` constrained to that
  merchant, render `<rainforest-merchant-onboarding session-key merchant-id merchant-application-id
  terms-and-conditions-url>` with `https://static.rainforestpay.com/sandbox.merchant.js` (production
  `https://static.rainforestpay.com/merchant.js`), and read the decision from the
  `merchant_application.*` / `merchant.*` webhooks. That is what this STEP implements.
- **No sensitive onboarding field can reach the platform.** The merchant body is built from a fixed
  documented field list — `name`, `dba_name`, `legal_name`, `merchant_type`, `mcc`, `email`, `website`,
  `phone_number`, `average_ticket`, `high_ticket`, `average_monthly_volume` and a `billing_contact` address —
  and the gate asserts that a built body carries no tax identifier, no `encrypted_tax_id`, no `owner_*`, no
  SSN, no deposit route, no account number, no routing number, no IBAN and no card number. The eight
  documented merchant types, the four digit MCC, the https website and the volume ordering are validated
  before a call is made.
- **One merchant per company, and a created merchant is final.** The attempt is stored before the call. A row
  that carries a provider merchant id answers `already_created` with no provider call; a `pending` row answers
  `in_flight`; a `rejected` or `unknown` row **without** a merchant id is reopened and retried, because neither
  created anything Rainforest could duplicate. The create answer table: `2XX` with a `mid_`/`sbx_mid_` id is
  `created` (an application id that does not parse is recorded as absent with `requiresReconciliation`, never
  invented); `400`/`409`/`422` are `rejected` with the sanitised provider message; `401`/`403`/`404`/`405`/`415`
  and redirects are `failed`; `408`/`425`/`429`/`5XX`, a thrown transport and a `2XX` without a merchant id are
  `unknown` with `requiresReconciliation`.
- **The onboarding session is scoped exactly like the payment one.** The body is
  `{ttl, statements: [{permissions: ["group#merchant_onboarding_component"], constraints: {merchant: {merchant_id}}}]}`,
  with the documented example lifetime of 24 hours as the onboarding default and the documented 86,400 second
  maximum. A payment session cannot ask for the onboarding group and an onboarding session cannot ask for the
  payment group: the group is chosen from a two-value purpose table, and both gates assert the two never cross.
  The session key goes to the browser and is never stored or audited.
- **Signature verification comes before anything else, and the receiver refuses when it cannot verify.** The
  "Verify Webhooks" recipe is still unpublished (see open questions), so `receiveRainforestWebhook` requires a
  verifier and ships `refuseRainforestWebhookVerifier` as the default: with no verifier configured, every
  delivery is refused `401` and nothing is stored. The header names, signed content and encoding are a
  *scheme value* rather than constants in the comparison, so confirming the recipe changes one table. The
  reference verifier is HMAC-SHA256 over the versioned `v1,<base64>` signature list with a ±300 second
  timestamp tolerance, using the raw body (never a re-serialised payload) and `timingSafeEqual`; it is
  exported together with `RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED = false` and
  `RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION`, so the state of the integration is visible without reading code.
- **Idempotency uses the documented pair.** The key is the resource id from `data` plus `event_type`, exactly
  as Rainforest's on-premises guide says. The first delivery inserts a `received` row and applies the event;
  every later delivery of that pair — including a manual portal replay, which the documentation says
  redelivers events you may already have processed, and including the same event under a new message id — is
  answered `duplicate` without applying anything.
- **An event's own numbers are never the money.** A `payin.*` delivery is applied by re-reading the payin
  through STEP 159's `readRainforestPayin`, with the amount and currency the platform expects from its own
  record; only the documented `SUCCEEDED` at that amount and currency is `succeeded`. A delivery the platform
  cannot tie to a known payin, a read that returns another amount, another currency, an undocumented status,
  a `404` or an unreachable API are all `unknown` — never a success and never a failure. `merchant_application.*`
  maps through the recorded application vocabulary (`COMPLETED` → approved, `DECLINED` → declined, everything
  else pending) and `merchant.*` through the merchant vocabulary (`ACTIVE` → processes, `SUSPENDED`/
  `DEACTIVATED`/`CANCELED` → blocked, `PENDING`/`ONBOARDING` → waiting); an unpublished value is `unknown`.
- **The receiver answers the way the retry schedule requires.** Any `2XX` stops the documented retry schedule,
  so an applied event and a duplicate both answer `200` with `{received: true}`; a signature failure is `401`,
  an unreadable envelope is `400`, and a failure to record or apply is `500` so Rainforest retries. The
  documented 15 second acknowledgement budget is recorded as `RAINFOREST_WEBHOOK_ACK_SECONDS`. The stored
  delivery keeps a SHA-256 hash of the raw body and never the body or the signature.
- **A documented resource this receiver does not act on is acknowledged and ignored** — `deposit.*`,
  `refund.*`, `message.attempt.exhausted` and the rest still answer `200`, so an endpoint subscribed to all
  events never accumulates failures.
- **None of it ran against Rainforest.** No sandbox account, API key or signing key exists in this environment,
  so the onboarding flow and every webhook path were exercised against recording transports and self-signed
  deliveries only (260 + 193 checks). No merchant was created, no session was issued and no real signature was
  verified.

### Open Questions (recorded, not assumed)

- **The webhook signature scheme is still not read.** The Webhooks page points to a "Verify webhooks" recipe, and that recipe answers *not found* at `/recipes/verify-webhooks-1` and `/recipes/verify-webhooks` in this environment. STEP 160 therefore did not guess it into the code: the receiver refuses every delivery until a verifier is configured (`refuseRainforestWebhookVerifier` is the default), the header names, signed content and encoding are a scheme value, and the reference HMAC verifier is exported with `RAINFOREST_WEBHOOK_SIGNATURE_CONFIRMED = false` and `RAINFOREST_WEBHOOK_SIGNATURE_ASSUMPTION`. The recipe must be read before a production endpoint is enabled; until then no Rainforest signature may be trusted, and the reference scheme must be checked against a real delivery.
- **The direct-to-API approval is not public.** Both the payin guide and the onboarding guide say the feature requires Rainforest approval. STEPs 159 and 160 must not assume it, and the PCI rule holds either way: no raw card number and no raw bank account number reaches this platform's servers or database.
- **The platform's minimum API version is a portal setting** the documentation does not expose, so STEP 158 must send the `Rainforest-Api-Version` header explicitly rather than relying on a default.
- **No sandbox account exists here.** Sandbox keys are created in the Sandbox Platform Portal, so no sandbox call was executed, no webhook endpoint was registered and nothing below is claimed as passed.

### Sandbox Notes

| Step | Call | Result | Details |
|---|---|---|---|
| Authenticate a sandbox key | `GET /v1/api_keys` | Not run | No Rainforest sandbox account or API key exists in this environment. |
| Onboard a merchant to `ACTIVE` | `POST /v1/merchants` | Not run | No Rainforest sandbox account or API key exists in this environment. |
| Create a payin config | `POST /v1/payin_configs` | Not run | No Rainforest sandbox account or API key exists in this environment. |
| Process a card payin to `SUCCEEDED` | `POST /v1/payins` | Not run | No Rainforest sandbox account or API key exists in this environment. |
| Receive and verify a signed webhook | `POST /webhooks/rainforest` | Not run | No endpoint is registered and the signing recipe is not readable (see open questions). |

Added by STEP 158 (same reason: no Rainforest sandbox account or API key exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Test a sealed key against the API | `GET /v1/api_keys` | Not run | Implemented as `testRainforestConnection`; exercised against a recording transport only. No key was sent to Rainforest. |
| Activate a key after a passing test | none (a state transition) | Not run | Implemented as `activateRainforestConfig`; no configuration is active in any real environment. |

Added by STEP 159 (same reason: no Rainforest sandbox account or API key exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Create a payin config for a merchant | `POST /v1/payin_configs` | Not run | Implemented as `createRainforestPayinConfig` with a stored, version-guarded idempotency record; exercised against a recording transport only. No config exists at Rainforest. |
| Create the component session | `POST /v1/sessions` | Not run | Implemented as `createRainforestSession`; the `group#payment_component` statement scoped to one merchant was exercised against a recording transport. No session key was issued by Rainforest. |
| Render the component and take a payin | `<rainforest-payment>` in the browser | Not run | The contract is built by `rainforestPaymentComponentFor`; the page itself is STEP 183. No card was collected and no bundle was loaded. |
| Read a payin to its documented outcome | `GET /v1/payins/{payin_id}` | Not run | Implemented as `readRainforestPayin`; the whole status and refusal table was exercised against recorded answers only. No payin exists. |

Added by STEP 160 (same reason: no Rainforest sandbox account, API key or signing key exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Create a merchant for a company | `POST /v1/merchants` | Not run | Implemented as `provisionRainforestMerchant` with a stored, version-guarded one-per-company record; exercised against a recording transport only. No merchant exists at Rainforest. |
| Start onboarding and render the component | `POST /v1/sessions` + `<rainforest-merchant-onboarding>` | Not run | Implemented as `startRainforestOnboarding` and `rainforestOnboardingComponentFor`; the scoped session and the component contract were exercised against a recording transport. No session key was issued by Rainforest and no component was rendered. |
| Receive and verify a signed webhook | `POST /webhooks/rainforest` | Not run | Implemented as `receiveRainforestWebhook` with a pluggable verifier; exercised with self-signed deliveries only, because no portal signing key exists here and the recipe is unread. |
| Survive a replay of the same event | `POST /webhooks/rainforest` (replay) | Not run | Implemented as the resource-id-plus-event-type idempotency record; a replayed delivery was exercised locally. No real replay was received. |

Added by STEP 164 (same reason: no sandbox key, connected account or signing secret exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Charge a customer with the platform fee | `POST /v1/payment_intents` | Not run | Implemented as `createStripeCharge`; exercised against a recording transport only. The documented test cards (4242…4242 succeeds, 4000…3155 needs authentication, 4000…9995 is declined) are recorded and unused. |
| Confirm the charge without trusting the browser | `GET /v1/payment_intents/{id}` | Not run | Implemented as `readStripePaymentIntent` and `applyStripePaymentIntentRead`; no intent exists to read. |
| Pay the merchant's balance out | `POST /v1/transfers` | Not run | Implemented as `createStripeTransfer`; no connected account has a balance, so the documented `balance_insufficient` path was produced by a fixture, not by Stripe. |
| Receive a signed delivery | the endpoint's raw body plus `Stripe-Signature` | Not run | Implemented as `receiveStripeWebhook`; every delivery in the gate was signed with a fixture secret, and no endpoint is registered with Stripe. |
| Replay a delivery | the same `evt_` id twice | Not run | The duplicate path was exercised locally; no real retry was received. |

The record these notes produce is `partial`, never `verified`: `calculateRainforestStatus` requires the
whole five step cycle to be present and passed before a record can read as verified.

### Capability Matrix

- Charges: Yes (card and ACH payins)
- Payouts: No (deposits to merchants are Rainforest's, not this platform's payouts)
- Connected accounts: Yes (Rainforest onboards and underwrites the merchant; a sub-merchant is `merchant_application` + `merchant`)

---

## Stripe Connect (STEP 161)

Stripe is the fourth provider in the adapter set, and the first whose documentation publishes the webhook
signature scheme in full. Section 6 asks it for connected sub-merchant account creation, charges and
payouts. STEP 161 records the documentation and the sandbox notes; key configuration and the connection
test are STEP 162, onboarding and charges 163-166, and the sandbox cycle and capability matrix 167-169.

### Documentation Sources (read in the STEP 161 session, 2026-11-06)

| Topic | URL | Status |
|---|---|---|
| How Connect works | https://docs.stripe.com/connect/how-connect-works | Reviewed |
| Accounts v2 (recommended account surface) | https://docs.stripe.com/connect/accounts-v2 | Reviewed |
| Connected account types (legacy, deprecated) | https://docs.stripe.com/connect/accounts | Reviewed |
| Account capabilities | https://docs.stripe.com/connect/account-capabilities | Reviewed |
| Charge types | https://docs.stripe.com/connect/charges | Reviewed |
| API keys and sandbox versus live mode | https://docs.stripe.com/keys | Reviewed |
| Webhook endpoints and delivery behaviour | https://docs.stripe.com/webhooks | Reviewed |
| Webhook signature verification (manual) | https://docs.stripe.com/webhooks#verify-manually | Reviewed |
| Account updates, requirements and future requirements | https://docs.stripe.com/connect/handle-verification-updates | Reviewed |
| Testing Connect | https://docs.stripe.com/connect/testing | Reviewed |
| Accounts v1 and v2 request shapes | https://docs.stripe.com/api/accounts/create | Reviewed |
| Configure connected accounts (responsibilities, dashboard, requirement collection) | https://docs.stripe.com/connect/accounts-v2/connected-account-configuration | Reviewed in STEP 163 |
| Create an account link | https://docs.stripe.com/api/account_links/create | Reviewed in STEP 163 |
| Idempotent requests (`Idempotency-Key`) | https://docs.stripe.com/api/idempotent_requests | Reviewed in STEP 164 |
| Destination charges (Payment Element flow) | https://docs.stripe.com/connect/destination-charges | Reviewed in STEP 164 |
| PaymentIntent lifecycle and statuses | https://docs.stripe.com/payments/paymentintents/lifecycle | Reviewed in STEP 164 |
| Separate charges and transfers | https://docs.stripe.com/connect/separate-charges-and-transfers | Reviewed in STEP 164 |
| Create a transfer | https://docs.stripe.com/api/transfers/create | Reviewed in STEP 164 |

Nothing in this section was read from anywhere else: the pages above are `docs.stripe.com` only, and
`STRIPE_DOCUMENTATION_HOSTS` holds that one host so a record naming any other host is refused.

### Recorded Rules

- **New connected accounts use Accounts v2** (`POST /v2/core/accounts`) with configurations — `merchant`
  (which carries `card_payments` and `stripe_balance.payouts`), `customer`, and `recipient` (which carries
  `stripe_balance.stripe_transfers`) — or Accounts v1 with **controller properties**. Standard, Express and
  Custom are the legacy type model; the page tells new platforms not to start there, and an account's type
  cannot be changed after creation. This is recorded as `STRIPE_RECORDED_RULES` entry 1 rather than a
  footnote, because it changes what every later Stripe STEP calls.
- **`card_payments` must be `active`** before the connected account may accept payments, and `card_payments`
  is requested together with `transfers`. Sandboxes do not always enforce capabilities, so a sandbox payment
  succeeding is not proof that the gate works in live mode.
- **The charge type decides the money's path**: a direct charge lands in the connected account's balance and
  makes it merchant of record; a destination charge lands in the platform's balance, transfers a portion on,
  and puts refunds and chargebacks on the platform; separate charges and transfers allow one payment to fund
  several connected accounts. The platform's model — a merchant accepts, the platform pays out under STEPs
  133-141 — must pick one of these explicitly in the adapter STEP.
- **Sandbox and live are separate modes**: separate keys (`sk_test_`/`sk_live_`, `rk_test_`/`rk_live_`,
  `pk_test_`/`pk_live_`, plus `sk_org_`), separate objects, no cross-reading. Only a publishable key may
  reach a browser; only a server key may call the API.
- **Webhook signing secrets are not API keys**: each endpoint has its own `whsec_` secret, it differs between
  sandbox and live, and it can be rolled with the previous secret valid for up to 24 hours — during which one
  signature is generated per secret.
- **The signature scheme is published and implemented**: `Stripe-Signature: t=<unix seconds>,v1=<hex
  HMAC-SHA256>` (Stripe adds a `v0` signature for test events, which must be ignored), signed content
  `<t>.<raw body>`, key = the endpoint's `whsec_` secret, constant-time comparison, default tolerance five
  minutes, and `0` disables the recency check so it is refused. Unlike Rainforest's unread recipe, nothing
  here is an assumption.
- **Delivery is at-least-once and unordered**: up to 16 event destinations per account, live retries for
  three days, sandbox retries three times, order not guaranteed, duplicates tracked by event id, `2xx`
  returned quickly, redirects and `4xx`/`5xx` treated as failures, TLS 1.2 or higher required, and manual
  resend available for 15 days in the Dashboard and 30 with the CLI.
- **Requirements are read, not guessed**: `requirements` and `future_requirements` carry `currently_due`,
  `eventually_due`, `past_due`, `pending_verification`, `disabled_reason`, `current_deadline` and an `errors`
  array of `{code, requirement, reason}`; `account.updated` reports changes; `controller.requirement_collection`
  decides whether Stripe (`stripe`) or the platform (`application`) collects them.
- **No raw card data reaches this platform**, exactly as for NMI and Rainforest: card data stays inside
  Stripe's own interfaces, and this platform handles ids, amounts and statuses.

### Verified for STEP 161: the account model, the vocabularies and the published signature (2026-11-06)

Delivered by this STEP, with no network call and no credential:

- `lib/payments/adapters/stripe.ts` — the record module in the STEP 157 shape: `STRIPE_PROVIDER_KEY`
  ("stripe"), the eleven documentation sources above, `STRIPE_RECORDED_RULES` (15 rules) and
  `STRIPE_OPEN_QUESTIONS` (5), the documented key shapes and their `sandbox`/`live` environment, the
  capability vocabulary (`active|inactive|pending|unrequested`, where only `active` allows the action and an
  unrecorded value is `null`), the requirement fields and `stripeOnboardingStateOf` (`ready`/`waiting`/
  `blocked`), the three charge types with their merchant-of-record and losses facts, the recorded event types
  and `parseStripeEventType`, the five-step sandbox cycle, `sanitizeStripeText`, and the record, store,
  validation, `calculateStripeStatus` and `recordStripeVerification` machinery with an audit entry.
- **The signature verifier is real, not a placeholder.** `verifyStripeWebhookSignature(rawBody, header,
  { secret, toleranceSeconds, nowSeconds })` parses `t` and every `v1` entry, drops `v0` and unknown schemes,
  rebuilds `<t>.<rawBody>`, MACs it with HMAC-SHA256, compares in constant time, then applies the tolerance
  (refusing `0`). It refuses a wrong secret, a one-byte body change, a stale or future timestamp, a missing
  header, an empty body, a missing secret, an oversized body, and a `v0`-only delivery; it accepts two `v1`
  signatures during a secret rollout. A refusal never repeats the secret.
- **`calculateStripeStatus` cannot be talked into `verified`**: pages verified but no sandbox step run is
  `partial`; four of five steps is `partial`; steps without any page read is `partial`; nothing at all is
  `not_verified`. `verified` requires every page verified **and** all five cycle steps passed.
- **The sandbox cycle is recorded, step by step**: `key_auth` (`GET /v1/accounts`), `connected_account_create`
  (`POST /v2/core/accounts`), `hosted_onboarding` (`POST /v1/account_links`), `test_payment`
  (`POST /v1/payment_intents`), `signed_webhook` (`POST /webhooks/stripe`).
- **None of it ran against Stripe.** No Stripe account, sandbox key or `whsec_` secret exists in this
  environment, so every cycle step is `not_tested` with the reason recorded, `STRIPE_SESSION_STATUS` is
  `partial` by construction, and the gate asserts that the session record cannot read as `verified`.

### Verified for STEP 162: encrypted keys, the connection test and the signing-secret roll (2026-11-06)

Delivered by this STEP in `lib/payments/adapters/stripe-client.ts`, with no network call and no credential:

- **Both decisions STEP 161 left open are now made in code.** `STRIPE_ACCOUNT_SURFACE = "accounts_v2"` with
  `STRIPE_ACCOUNT_SURFACE_REASON` and `STRIPE_ACCOUNT_SURFACE_PATH = "/v2/core/accounts"`, so STEP 163 creates
  connected accounts through Accounts v2 configurations and never through the legacy Standard/Express/Custom
  types. The API version is **configuration, not a constant**: `STRIPE_DEFAULT_API_VERSION` is the dated value
  the documentation examples carried, every configuration stores the version it will send, the connection test
  sends it as `Stripe-Version`, and a `live` configuration may not pin a `.preview` version
  (`validateStripeCredentials` refuses it by name).
- **Two credentials are sealed and one deliberately is not.** The secret (or restricted) key is sealed under
  `gateway:<companyId>:stripe:secret_key`; the webhook signing secret under
  `gateway:<companyId>:stripe:webhook_secret`; the publishable key is stored as text because it is designed to
  ship to a browser, and the settings view shows it in full so the checkout step has a source. Sealing a
  publishable key would be theatre, and a `pk_` value in the secret field is refused with a message that says
  exactly that. A sealed value opens only under its own scope: the secret key cannot be opened as a signing
  secret, for another company, or with a foreign keyring.
- **The mode is cross-checked before anything is sealed.** A live key in a sandbox configuration, a sandbox key
  in a live one, and a publishable key of another mode are all refused, because the connection test against the
  wrong mode would report a rejection that says nothing about the key the operator meant to store. An
  organization key (`sk_org_`) is refused too: it manages several Stripe accounts, and this adapter is bound to
  one company.
- **The connection test is the documented read** `GET /v1/accounts?limit=1` — the same endpoint STEP 163 uses —
  against `https://api.stripe.com`, with `Authorization: Bearer`, `Accept: application/json` and the pinned
  `Stripe-Version`. The transport allowlists that one URL, refuses to run without a key or a dated version,
  refuses redirects, bounds the timeout at 15 s and the answer at 64 KiB.
- **The answer table distinguishes outcomes the way Stripe's does**: `401` is `rejected` (the documented
  authentication error); `403` is `not_permitted` — the key authenticated but a restricted key lacks the
  accounts permission, so the operator is told to fix permissions rather than replace the key; `400` is
  `failed` with the pinned version named as the likely cause; `3xx`, other `4xx` and a `200` that is not a
  Stripe list prove nothing; `408`/`425`/`429`/`5xx` and an unreachable host are `unreachable`. Only a `2XX`
  carrying `object: "list"` and a `data` array reports `secretKeyAccepted` and `environmentVerified`.
- **A provider cannot be enabled on a test it did not pass.** `activateStripeConfig` refuses without a recorded
  `connected` test, refuses a test made in another environment or on another API version, and refuses a
  configuration with no webhook signing secret — a provider that could take money while its deliveries cannot be
  verified would leave every payment in an unknown state. Activation supersedes the previous key, audits
  `provider_key.activated` and `provider_key.rotated`, and `retireStripeConfig` removes the old key afterwards.
- **The signing-secret roll has its documented overlap.** `rollStripeWebhookSecret` keeps the previous secret
  for `STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS` (24 hours), refuses a roll to the same value, and audits
  `provider_webhook_secret.rolled`. `stripeWebhookSecretsFor` opens the current secret and, only while the
  window is open, the previous one — which is what STEP 164's receiver will feed to
  `verifyStripeWebhookSignature`, because that verifier already reads every `v1` signature in the header.
- **None of it ran against Stripe.** No Stripe account, sandbox key or `whsec_` value exists in this
  environment, so the connection test was exercised against a recording transport only, and every row below is
  `Not run`.

### Verified for STEP 163: connected account creation after KYC approval (2026-11-06)

Delivered by this STEP in `lib/payments/adapters/stripe-accounts.ts`, with no network call and no credential:

- **The configuration the pages fix is now recorded in code.** Accounts v2 requires
  `defaults.responsibilities` and `dashboard` to be chosen when the merchant configuration is added, and the
  configuration page says neither can be changed afterwards. This platform sets
  `fees_collector: application`, `losses_collector: application` and `dashboard: none`:
  `STRIPE_PLATFORM_RESPONSIBILITIES`, `STRIPE_PLATFORM_DASHBOARD` and their reasons. The page's own
  restriction (`losses_collector: application` requires `fees_collector: application`) is enforced by
  `validateStripeResponsibilities`, and its derivation of requirement collection is implemented as
  `stripeRequirementsCollectorOf` — the platform collects when `losses_collector` is `application` **and**
  `dashboard` is `none`, which is this configuration. That is consistent with the flow: the company was
  already KYC-approved here, and Stripe's `requirements` hash is the delta left to satisfy.
- **One account per company, created only after approval, never twice.** `provisionStripeAccount` refuses a
  submission that is not `approved`, refuses an approval that belongs to another company, refuses an
  approval naming no submission, validates the profile, requires an active configuration proven on the
  Accounts v2 surface, writes the `pending` row **before** the call, and answers `already_created` from the
  record on a replay — so a retry cannot create a second `acct_`.
- **The create body carries business identity only.** `POST https://api.stripe.com/v2/core/accounts` with
  `contact_email`, `display_name`, `dashboard`, `identity` (registered name, country, entity type),
  `configuration.merchant.capabilities.card_payments.requested`,
  `configuration.recipient.capabilities.stripe_balance.stripe_transfers.requested` (STEP 161 recorded that
  `card_payments` is requested together with transfers), `defaults` (currency, responsibilities, locale) and
  `include: ["configuration.merchant", "identity", "requirements"]`. No tax identifier, owner, date of birth,
  SSN, bank account number, routing number or IBAN appears — the input type has no field for any of them, and
  the gate asserts that a built body carries none of their shapes.
- **The verdicts are honest.** `400`/`409`/`422` are `rejected` with the provider's message and may be
  reopened; `401`/`403`/`404`/`405`/`415`/redirects are `failed`; a timeout-class code, `429`, any `5XX`, a
  thrown transport or a `2XX` that names no `acct_` id are `unknown` with `requiresReconciliation`, and a
  second attempt over an `unknown` row answers `in_flight` instead of creating another account.
- **The documented onboarding link.** `createStripeOnboardingLink` posts the form-encoded body the documented
  example sends (`account`, `type`, `refresh_url`, `return_url`) to `/v1/account_links`, refuses a link type
  this record does not name, refuses a non-HTTPS return or refresh URL, requires a created account, keeps the
  documented `expires_at` (and falls back to the documented 300-second lifetime only when the answer omits
  it), and refuses any answer whose `url` is not an absolute HTTPS URL.
- **Readiness is derived, not asserted.** `stripeAccountReadinessOf` lets an account accept payments only when
  it exists and both `card_payments` and `stripe_transfers` are `active`, and calls it onboarded only when
  this platform — the requirements collector — has nothing outstanding.
- **None of it ran against Stripe.** No Stripe account, sandbox key or `acct_` id exists in this environment,
  so every call was exercised against a recording transport and every row below is `Not run`.

### Verified for STEP 164: destination charges, payouts and signature-verified idempotent webhooks (2026-11-06)

Delivered by this STEP in `lib/payments/adapters/stripe-payment.ts` and
`lib/payments/adapters/stripe-webhook.ts`, with no network call and no credential:

- **The charge type is settled: destination charges.** STEP 163 fixed
  `fees_collector`/`losses_collector` to `application` with `dashboard: none`, and the configuration page
  says that pair is the recommended configuration for destination charges, so
  `STRIPE_CHARGE_TYPE = "destination"` with its reason. The body is the page's own:
  `amount`, `currency`, `transfer_data[destination]` and `application_fee_amount`. The page's effect is
  recorded beside it: the full amount transfers to the connected account on capture and the application fee
  transfers back to the platform, and because this platform collects the fees (`fees_collector:
  application`), the fee it sets must also cover Stripe's processing fee.
- **The amount unit is converted exactly once.** `lib/payments/money.ts` counts ten-thousandths of a
  currency unit while Stripe counts the smallest unit (cents for USD), so
  `stripeAmountFromPlatformMinor` divides by `10 ** (MONEY_SCALE - exponent)` and refuses anything that is
  not a whole cent instead of rounding. A 2.90 USD fee is `29_000n` in the platform's scale and `290` to
  Stripe; the gate asserts both directions, so the hundred-fold charge bug cannot arrive by accident.
- **`Idempotency-Key` is now read and sent — and the two guards work together.** The page documents the
  header on `POST` only (no effect on `GET`/`DELETE`), up to 255 characters, no sensitive data, keys pruned
  after at least 24 hours. `stripe-payment.ts` sends `stripeIdempotencyKeyFor(...)` on every `POST` and
  never on a `GET`, and the stored `pending` attempt written **before** the call is the guard that survives
  key pruning: a replay answers `already_created` (charge) or `already_created` (transfer) without a call.
- **Only a matching read is paid.** `readStripePaymentIntent` performs the documented
  `GET /v1/payment_intents/{id}`, and `applyStripePaymentIntentRead` compares the answer's amount, currency
  and application fee against the attempt in the platform's own units. Only `succeeded` with all three
  matching is `paid`; a mismatch is `failed` with `requiresReconciliation`. The lifecycle page's mapping is
  kept: `processing` and `requires_capture` are pending, `requires_action`, `requires_confirmation` and
  `requires_payment_method` need the customer, `canceled` is not paid, and an unrecorded status is `unknown`.
- **The client secret is never stored.** The page says a client secret "can complete the charge" and must not
  be logged, embedded in URLs or exposed to anyone but the customer, so it is returned to the caller once,
  the record keeps only `clientSecretIssued: true`, and the gate asserts that the serialised record carries
  neither the value nor a `_secret_` fragment. The same rule refuses a card-shaped description or metadata
  value (`carriesCardLikeText`), which is the PCI barrier of the Rainforest section restated for this
  provider.
- **The payout leg is a documented transfer.** `POST /v1/transfers` with `amount`, `currency`,
  `destination`, `transfer_group` and metadata, carrying its own `Idempotency-Key`; the answer's `tr_` id,
  amount, currency and destination are compared to the request, and the page's own warning is recorded — a
  transfer made before an asynchronous payment fails debits the platform's balance and must be reversed
  manually — which is why the group is required and the amount is immutable. The page's documented failure,
  an insufficient platform balance, is reported as `insufficientFunds` from the `balance_insufficient` code.
- **The webhook receiver verifies before it reads.** `receiveStripeWebhook` takes the raw body and the
  signature header, opens the company's sealed signing secrets, and verifies STEP 161's `t` + `v1` HMAC
  (300-second tolerance) against the current secret, or the previous one only while STEP 162's 24-hour
  overlap window is open. Nothing in the body is parsed before that; a refusal is `400` with a named error
  and an audit entry, and an unopenable secret is `500` because that is this platform's outage, not a bad
  delivery.
- **Idempotency is the event's own id.** The `evt_` id is unique per company; the record is written before
  the effect runs, a second delivery of a settled record answers `200` with `duplicate: true` and repeats
  nothing, and a second delivery of a record still `stored` re-runs the effect — which is what a retry after
  a `500` means. The record keeps the event id, type, object id, API version, the delivery count and a
  SHA-256 fingerprint of the body; the body, the signature and the secret are never stored.
- **The three payment events the page names, plus `account.updated`.** `payment_intent.succeeded`,
  `payment_intent.processing` and `payment_intent.payment_failed` are classified `payment`;
  `account.updated` is `account` and asks for a synchronisation; every other type is stored, acknowledged and
  never acted on, because an endpoint receives types this integration did not ask for.
- **None of it ran against Stripe.** No sandbox key, connected account or `whsec_` secret exists here, so
  every call was exercised against a recording transport and every delivery was signed by the gate itself.

### Open Questions (recorded, not assumed)

- **The account surface is settled (STEP 162): Accounts v2.** `STRIPE_ACCOUNT_SURFACE` and
  `STRIPE_ACCOUNT_SURFACE_REASON` in `stripe-client.ts` record the choice; Accounts v1 with controller
  properties is kept in the sources only as the documented alternative for features v2 does not cover.
- **The API version is settled as configuration (STEP 162).** It is stored per configuration, sent as
  `Stripe-Version`, defaulted to `2026-10-28.preview` (the only version the documentation review observed), and
  a `live` configuration may not pin a preview value. Which released version operations pins when the live
  account is connected remains an operational decision, recorded on the configuration rather than in code.
- **The pinned version and the Accounts v2 surface are not yet proven together in live mode (STEP 163).** Every
  documented v2 example carried a preview version (`2026-10-28.preview`), while STEP 162 forbids a preview pin on a
  live configuration. The sandbox cycle must confirm that the released version a live key pins accepts
  `POST /v2/core/accounts`; if it does not, the refusal surfaces as a `400` (`failed`) from
  `parseStripeAccountAnswer`, never as a silent success.
- **Stripe's idempotency header is settled (STEP 164).** `docs.stripe.com/api/idempotent_requests` was read:
  the header applies to `POST` only, may be up to 255 characters, must not carry sensitive data, and keys are
  pruned after at least 24 hours. Both spending calls send one and neither `GET` does, and the stored attempt
  remains the guard that outlives the pruning. What is *not* proven is the API's own replay behaviour against a
  real account, because no key exists here.
- **Payment Intents were chosen over Checkout Sessions for a reason that may be revisited (STEP 164).** The
  lifecycle page recommends Checkout Sessions over Payment Intents "for most integrations" because the Intent
  API needs more code. This adapter uses Payment Intents because the fee split is explicit
  (`transfer_data[destination]` plus `application_fee_amount`), the platform's own payment page (STEP 183) owns
  the Elements mount, and the same read serves the webhook receiver. If STEP 183 finds that a hosted Checkout
  Session fits its screen better, that is a surface change recorded against this STEP, not a new charge type.
- **A `whsec_` value carries no mode**, so the signing secret's mode cannot be checked from its shape; it is
  bound to the configuration's declared environment only. A sandbox secret pasted into a live configuration
  would fail on the first delivery rather than at configuration time, and that limit is recorded here.
- **The event subscription set is decided with the receiver**, because the documentation recommends
  subscribing only to the events the integration needs. `account.updated` is the recorded one for account and
  requirement changes; the payment events are recorded but not yet subscribed.
- **The webhook source addresses were not read.** Stripe publishes them on `docs.stripe.com/ips`, a page this
  session did not read, so IP allowlisting is recorded as available and unverified. Signature verification
  stands on its own meanwhile.
- **No sandbox exists here**, so no account was created, no test payment taken, no delivery signed by Stripe.

### Sandbox Notes

| Step | Call | Result | Details |
|---|---|---|---|
| Authenticate a sandbox key | `GET /v1/accounts` | Not run | No Stripe account or sandbox key exists in this environment. |
| Create a connected account | `POST /v2/core/accounts` | Not run | No Stripe account or sandbox key exists in this environment. |
| Onboard the merchant through a hosted link | `POST /v1/account_links` | Not run | No connected account exists to link, and no sandbox key was available. |
| Take a test payment | `POST /v1/payment_intents` | Not run | No sandbox key exists; the documented test cards and tokens are recorded but unused. |
| Receive and verify a signed delivery | `POST /webhooks/stripe` | Not run | No endpoint is registered and no `whsec_` secret exists; the verifier was exercised with self-computed signatures only. |

Added by STEP 162 (same reason: no Stripe account, sandbox key or signing secret exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Configure a sealed key pair | none (a local state transition) | Not run | Implemented as `configureStripeKeys`; the secret key and signing secret were sealed with a keyring built for the gate, and no real credential was stored. |
| Prove the key against the API | `GET /v1/accounts?limit=1` | Not run | Implemented as `testStripeConnection`; exercised against a recording transport only. No key was sent to Stripe. |
| Activate after a passing test | none (a state transition) | Not run | Implemented as `activateStripeConfig`; the refusal table was exercised locally, and no configuration is active in a real environment. |
| Roll the signing secret with its overlap | none (a state transition) | Not run | Implemented as `rollStripeWebhookSecret` and `stripeWebhookSecretsFor`; no real `whsec_` value exists to roll. |
| Rotate the key and retire the old one | none (state transitions) | Not run | Implemented as `activateStripeConfig` plus `retireStripeConfig`; no second real key exists. |

Added by STEP 163 (same reason: no Stripe account or sandbox key exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Create the connected account for an approved company | `POST /v2/core/accounts` | Not run | Implemented as `provisionStripeAccount`; exercised against a recording transport only, so no `acct_` id exists. |
| Issue the hosted onboarding link | `POST /v1/account_links` | Not run | Implemented as `createStripeOnboardingLink`; no account exists to link and no link was issued by Stripe. |
| Satisfy the requirements Stripe reports | the `requirements` hash in the account answer | Not run | Summarised by `parseStripeAccountAnswer` into `ready`/`waiting`/`blocked`; no real requirements were collected because no account exists. |
| Settle an unknown creation outcome | a replay of `POST /v2/core/accounts` | Not run | The `in_flight` and `requiresReconciliation` paths were exercised locally; no real ambiguous outcome was produced. |

Added by STEP 164 (same reason: no sandbox key, connected account or signing secret exists here):

| Step | Call | Result | Details |
|---|---|---|---|
| Charge a customer with the platform fee | `POST /v1/payment_intents` | Not run | Implemented as `createStripeCharge`; exercised against a recording transport only. The documented test cards (4242…4242 succeeds, 4000…3155 needs authentication, 4000…9995 is declined) are recorded and unused. |
| Confirm the charge without trusting the browser | `GET /v1/payment_intents/{id}` | Not run | Implemented as `readStripePaymentIntent` and `applyStripePaymentIntentRead`; no intent exists to read. |
| Pay the merchant's balance out | `POST /v1/transfers` | Not run | Implemented as `createStripeTransfer`; no connected account has a balance, so the documented `balance_insufficient` path was produced by a fixture, not by Stripe. |
| Receive a signed delivery | the endpoint's raw body plus `Stripe-Signature` | Not run | Implemented as `receiveStripeWebhook`; every delivery in the gate was signed with a fixture secret, and no endpoint is registered with Stripe. |
| Replay a delivery | the same `evt_` id twice | Not run | The duplicate path was exercised locally; no real retry was received. |

The record these notes produce is `partial`, never `verified`: `calculateStripeStatus` requires all five
step ids to be present and passed before a record can read as verified, and the gate asserts it.

### Capability Matrix

- Charges: Yes, destination charges (`transfer_data[destination]` with `application_fee_amount`; separate charges and transfers remain available)
- Payouts: Yes (the platform's own payout path stays STEPs 133-141; Connect payouts are the connected account's)
- Connected accounts: Yes (Accounts v2 configurations, or Accounts v1 with controller properties)
- Refunds and disputes: Yes, on the balance the charge type names
- Tokenised card capture: Yes (`pk_` publishable key with Stripe.js or Elements; no raw card number here)

---

## Airwallex (STEP 165)

### Documentation Sources (read in the STEP 165 session, 2026-11-06)

| Topic | URL | Status |
|---|---|---|
| API reference and the two API hosts | https://www.airwallex.com/docs/api/introduction | Reviewed |
| API access token and how it is obtained | https://www.airwallex.com/docs/api/authentication/api_access_token | Reviewed |
| Sandbox environment, and what it does not cover | https://www.airwallex.com/docs/developer-tools/sandbox-environment | Reviewed |
| Webhook delivery, headers and signature scheme | https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events | Reviewed |
| Connected accounts overview | https://www.airwallex.com/docs/connected-accounts/overview | Reviewed |
| Native API onboarding and the account lifecycle | https://www.airwallex.com/docs/connected-accounts/onboarding/kyc-and-onboarding/native-api | Reviewed |
| PaymentIntents guide: create, client secret, idempotency | https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api | Reviewed |
| Payment statuses and the webhook each emits | https://www.airwallex.com/docs/payments/reference/payment-statuses | Reviewed |
| Transfer statuses and `PAID`'s late failure | https://www.airwallex.com/docs/payouts/transfers/create-a-transfer/transfer-statuses | Reviewed |
| Sandbox test cards and the required test cases | https://www.airwallex.com/docs/payments/test-and-go-live/test-card-numbers | Reviewed |
| Versioning, from the machine-readable specification | https://github.com/airwallex/airwallex-openapi | Reviewed |

Two hosts are recorded and no others: `www.airwallex.com` for the documentation and `github.com` for the
published specification. `docs.airwallex.com` — a host people type, on which no page lives — and
`api-demo.airwallex.com` — a host a community specification names and no page does — are **refused by name**
in `AIRWALLEX_REFUSED_HOSTS`, so a source or a base URL naming either is rejected rather than accepted as
close enough.

### Recorded Rules

The sixteen rules `AIRWALLEX_RECORDED_RULES` carries, each with the page that produced it. The five that
change how the adapter must be written:

- **The token is short-lived and reused.** `POST /api/v1/authentication/login` with `x-client-id` and
  `x-api-key` headers answers `201` with `token` and `expires_at`; the token "is valid for 30 minutes and can
  be reused until it expires. Do not call the authentication endpoint before each request." A receiver of
  this record therefore refreshes one minute early (`AIRWALLEX_TOKEN_REFRESH_SKEW_SECONDS = 60`) and never
  logs in per call.
- **Amounts are major units.** The Payments guide: "`amount`: The amount to charge specified in major units as
  defined by ISO 4217. For example, $9.99 is represented as `9.99`." This platform stores ten-thousandths, so
  `airwallexAmountFromPlatformMinor` divides by `10 ** MONEY_SCALE` and renders an exact decimal, and the gate
  asserts `99_900n → 9.99` and `1_000_000n → 100.00` in both directions. A cents-style value would be wrong by
  a factor of a hundred here, in the opposite direction from Stripe's.
- **The idempotency key is `request_id`, in the body.** "Your unique idempotency key (v4 UUID) used to prevent
  duplicate transactions by ensuring that retried API calls with the same ID are only processed once." The
  transfers changelog adds a documented `409 Conflict` while a duplicate is being processed. STEP 168 must send
  the field, not a header.
- **The client secret lives 60 minutes and is never logged.** "Never log the `client_secret` in plain text
  server logs." It cannot be refreshed or extended, so an expired checkout creates a new PaymentIntent.
- **A payout's `PAID` is not final.** A paid transfer "may subsequently fail if it is rejected by the local
  clearing system or the recipient bank", moving to `FAILED`. `airwallexTransferOutcomeOf` reports `PAID` as
  `paid` **and** `provisional: true`, and `airwallexTransferCanStillFail` is what STEP 169 must ask before it
  lets a payout ledger call a payment final.

Two more worth naming: `acct_` is **the same prefix Stripe uses**, so an account id alone is never proof of a
provider (`airwallexAccountIdCollidesWithStripe`), and a failed PaymentIntent has **no failure status** — it
returns to `REQUIRES_PAYMENT_METHOD`, so `payment_intent.payment_failed` and the last payment attempt are the
only failure signals.

### Verified for STEP 165: documentation and sandbox notes (2026-11-06)

Delivered by this STEP in `lib/payments/adapters/airwallex.ts`, with no network call and no credential:

- **The two hosts, and a lookalike refused.** `AIRWALLEX_PRODUCTION_BASE`, `AIRWALLEX_SANDBOX_BASE`,
  `airwallexEnvironmentOfBase` and `isAirwallexApiBase`; the file host is recorded separately because the
  documentation uploads files to `files.sandbox.airwallex.com`, not to the API host.
- **Credentials are validated by bounds, because no prefix is documented.** `validateAirwallexCredentials`
  checks a client id (8-128), an API key (16-256), the base URL and a date version;
  `carriesAirwallexKeyShapedText` refuses a JWT access token, a pasted `x-api-key` header or a `Bearer` value in
  a field meant for a stored credential. The consequence is recorded, not hidden: **the mode cannot be inferred
  from a key**, and STEP 166 therefore stores the mode beside the sealed credential and takes it from the base
  URL, exactly as that note asked.
- **Versioning is date-based and pinned.** `x-api-version`, `AIRWALLEX_API_VERSION_PATTERN`,
  `AIRWALLEX_OBSERVED_API_VERSIONS` (`2024-02-22`, `2024-09-27`, `2025-06-30`, `2026-05-29`, `2026-08-21`) and a
  default of `2026-05-29` — the reference FAQ's stated latest — with the `2026-08-21` example recorded beside it
  as an open question STEP 166's bounded probe is built to answer on evidence.
- **Every documented status is mapped.** The six PaymentIntent statuses plus `CANCELLED` (seven values),
  `airwallexPaymentOutcomeOf` with `SUCCEEDED` as the only `paid`, the four documented attempt statuses, and
  `airwallexIntentHasFailureStatus` which records that `FAILED` is not an Intent status at all.
- **Transfers are mapped with their finality.** `AIRWALLEX_TRANSFER_STATUSES` (eleven values, approvals
  included), `airwallexTransferOutcomeOf`, `airwallexTransferCanStillFail` and the terminal list holding
  `CANCELLED` only — deliberately not `PAID`.
- **Connected accounts are recorded from the native-API page.** `AIRWALLEX_ACCOUNT_ID_PATTERN` for the
  documented `acct_…` id, the five statuses `CREATED`/`SUBMITTED`/`ACTIVE`/`ACTION_REQUIRED`/`SUSPENDED`,
  `airwallexOnboardingStateOf` (`ready`/`waiting`/`blocked`), `validateAirwallexAccountRequest` which requires
  both agreement flags, and `buildAirwallexConnectedAccountBody` for the two documented shapes: an individual
  body carrying `legal_entity_type: INDIVIDUAL` (observed), and a business body carrying **no**
  `legal_entity_type` because the business enum was not observed and the documented business example omits it.
- **The PaymentIntent body and its idempotency key.** `buildAirwallexPaymentIntentBody` in the page's shape
  (`amount` in major units, upper-case `currency`, `merchant_order_id`, `request_id`, optional `return_url`,
  `descriptor`, `metadata`) with no card field and no secret anywhere, and `airwallexRequestIdFor` deriving a
  deterministic 43-character `kd-…` id that fits inside the documented 64.
- **The documented webhook scheme, implemented.** `verifyAirwallexWebhookSignature` computes
  HMAC-SHA256 over `x-timestamp` **as received** concatenated with the raw body, compares in constant time,
  then applies a tolerance — 300 seconds, which is **this platform's choice** because the page names none. It
  refuses a tampered body, another secret, a stale timestamp, a malformed timestamp, an upper-case or truncated
  hex digest, an empty body, an empty secret, a zero tolerance and an oversized delivery, and no refusal carries
  the secret, the signature or the body.
- **Events are read, and no name is invented.** `parseAirwallexEvent` reads the page's envelope
  (`id`/`name`/`account_id`/`org_id`/`data.object`/`created_at`/`version`), `AIRWALLEX_EVENT_NAMES` records the
  ten payment intent, three payment attempt and eleven transfer events, and the **account** group is left empty
  because the account-status webhook page was not read — recorded as an open question rather than guessed.
- **The sandbox gap is stated, not papered over.** `AIRWALLEX_SANDBOX_LIMITS` records that the sandbox covers
  "all products … except Connected Account APIs", that those need Airwallex Sales or the Simulation APIs, that
  `x-on-behalf-of` is how a platform calls for a connected account, that sandbox entity names must be
  "New Business Sandbox" or "Sandbox Business", and that sandbox files are deleted after 90 days.
- **None of it ran against Airwallex.** No sandbox account, client id, API key or webhook secret exists in this
  environment, so no token was obtained, no account created, no payment taken, no transfer sent and no delivery
  signed by Airwallex. `AIRWALLEX_SESSION_STATUS` is `partial` and `calculateAirwallexStatus` cannot say
  otherwise: it needs all five documented steps verified, with evidence, and none is.
- **STEP 166 stores the credentials sealed and proves them with the two documented calls.**
  `lib/payments/adapters/airwallex-client.ts` seals the client id, the API key and (when given) the webhook
  signing secret under per-company AES-256-GCM scopes, shows only the last four characters afterwards, and calls
  `POST /api/v1/authentication/login` for a token then `GET /api/v1/balances/current` with it before it says
  `connected`. Because no prefix is documented, the mode is taken from the documented host, and the recorded test
  names the host and the version it proved, so activation can refuse a test made anywhere else. The token lives
  in an in-memory cache only — never in the record, the view or an audit entry. The gate
  (`airwallex-client-verify.ts`) runs 323 checks against recorded answers; no call reached Airwallex.
- **STEP 167 creates the account, submits it and reads it back.** `lib/payments/adapters/airwallex-accounts.ts`
  refuses to act without an `approved` KYC submission for the same company, validates the page's own create rules
  (both agreement flags `true`, a primary contact email, a two-letter upper-case country code, a named individual
  or business), writes a `pending` row before the call so a crash cannot create a second account, and answers
  `already_created` / `in_flight` to a replay instead of asking Airwallex again. Only `CREATED` and
  `ACTION_REQUIRED` accounts are submitted; every read records just the five documented statuses, refuses one it
  does not know rather than storing it, and marks a `404` or an unsettled answer `requiresReconciliation`. The
  readiness rule is `ACTIVE` alone, and `acct_` is never treated as proof of ownership because Stripe uses the
  same prefix. The gate (`airwallex-accounts-verify.ts`) runs 266 checks against recorded answers; no call
  reached Airwallex.
- **The version question is answered by evidence, not by guessing.** `probeAirwallexApiVersions` tries the pin
  and every recorded version **newer** than it — `2026-05-29` then `2026-08-21` — reports which one the account
  accepted, and **never rewrites the stored pin**, so whichever answer the account gives, the change is an
  operator's decision recorded against a real answer.

### Open Questions (recorded, not assumed)

- **The credential shape is unknown beyond its bounds.** No page documents a prefix or a checksum for a client id
  or an API key, so the mode cannot be derived from the key; STEP 166 stores the mode beside the sealed
  credential and takes it from the base URL.
- **Which version to pin is still unsettled in the documentation, though no longer unanswerable.** The
  reference FAQ says the latest version is `2026-05-29`; the published OpenAPI repository demonstrates
  `2026-08-21`. The pin stays `2026-05-29` and STEP 166's bounded probe reports what the account accepts, but the
  probe has never run against Airwallex, so the account's answer is still unknown here.
- **The business `legal_entity_type` enum was not observed.** The business create example carries none, so this
  record sends none; STEP 167 revisits it only with a page that lists the values.
- **The transfer `request_id` bound is uncertain.** The PaymentIntent page caps `request_id` at 64; a community
  note claims 10-50 for transfers with a `request_id_duplicate` rejection. Only the documented `409` is recorded
  as fact, and the derived id is 43 characters, inside both.
- **The webhook timestamp tolerance is this platform's choice**, not Airwallex's: `300` seconds, matching the
  Stripe receiver, recorded so nobody later mistakes it for a provider number.
- **The account-status webhook names were not read**, so no account event name is recorded and STEPs 167-169
  must read that page before subscribing.
- **The connected-account sandbox gap stands.** Until Airwallex Sales grants connected-account access or a
  Simulation API run is recorded as its own evidence, STEP 169's account steps are `partial` by definition.
- **The platform's own fee on a connected account's payment was not read.** The pages read here describe payment
  intents and transfers separately; STEP 168 must read the payments-for-platforms pages before deciding how the
  platform's fee is collected.

### Sandbox Notes

| Step | Call | Result | Details |
|---|---|---|---|
| Obtain and reuse an access token | `POST /api/v1/authentication/login` | Not run | No Airwallex sandbox account, client id or API key exists in this environment. The documented 201 shape, the 30-minute lifetime and the expiry skew are recorded and gated, not exercised. STEP 166 implements the call and its token cache, and gates them against recorded answers only. |
| Prove a configuration with an authenticated read | `GET /api/v1/balances/current` | Not run | No credential exists, so the read that turns a token into a proof never reached Airwallex. STEP 166 requires both calls before it reports `connected`, and only the balance **count** is kept. |
| Create one connected account after approval | `POST /api/v1/accounts/create` | Not run | The sandbox does not offer the Connected Account APIs without Airwallex Sales, and no credential exists anyway. The documented body, `acct_` id and five statuses are recorded. STEP 167 implements the call, the approval gate and the single-attempt rule, and gates them against recorded answers only. |
| Submit the account for verification | `POST /api/v1/accounts/{id}/submit` | Not run | No account exists to submit; `SUBMITTED`, `ACTION_REQUIRED` and `SUSPENDED` are recorded with their RFI meaning. STEP 167 implements the submit and refuses it for any status but `CREATED` or `ACTION_REQUIRED`, gated only against recorded answers. |
| Read the account's verification status | `GET /api/v1/accounts/{id}` | Not run | No account exists to read. STEP 167 implements the read that records the documented status, maps it to `ready`/`waiting`/`blocked`, and flags a `404` or an unsettled answer for reconciliation; it has never seen a real one. |
| Take a payment with a documented test card | `POST /api/v1/pa/payment_intents/create` | Not run | No credential exists. The required test cases and cards (`4035501000000008` succeeds, `4012000300000013` fails 3DS, `5307837360544518` with `80.51` is insufficient funds) are recorded and unused. |
| Pay out to a beneficiary | `POST /api/v1/transfers/create` | Not run | No balance, beneficiary or credential exists; the eleven statuses and `PAID`'s late failure are recorded. |
| Verify and deduplicate a delivery | the endpoint's raw body plus `x-timestamp`/`x-signature` | Not run | No webhook subscription exists; the verifier was exercised only with self-computed signatures in the gate. |

The record these notes produce is `partial`, never `verified`: `calculateAirwallexStatus` requires all five step
ids to be recorded as `verified` **with evidence**, and the gate asserts that a record claiming more than its
steps prove is refused.

### Capability Matrix

- Connected accounts: Yes (native API create, update, submit and read; embedded component and hosted flow also documented)
- Payments: Yes (PaymentIntents with the client secret handed to Airwallex's own component; no raw card data here)
- Payouts: Yes (Transfers to a beneficiary; `PAID` is provisional until its late-failure window closes)
- Refunds: Yes (documented refund create and the `refund.accepted` event)
- Webhooks: Yes (`x-timestamp` + `x-signature`, per-URL secret, 200 required or the delivery is retried)
- Hosted components: Yes (hosted payment page, drop-in element, embedded elements, embedded KYC)
- Sandbox for connected accounts: **No** without Airwallex Sales or the Simulation APIs — recorded as this
  provider's one matrix gap
