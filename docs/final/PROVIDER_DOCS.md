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

### Open Questions (recorded, not assumed)

- **The webhook signature scheme is not yet read.** The Webhooks page points to a "Verify webhooks" recipe, and that recipe answers *not found* at both `/recipes/verify-webhooks-1` and `/recipes/verify-webhooks` in this environment. The header names, the signed content, the digest algorithm and the replay tolerance must be read from it before STEP 160 implements verification, and until then no Rainforest signature may be trusted.
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

The record these notes produce is `partial`, never `verified`: `calculateRainforestStatus` requires the
whole five step cycle to be present and passed before a record can read as verified.

### Capability Matrix

- Charges: Yes (card and ACH payins)
- Payouts: No (deposits to merchants are Rainforest's, not this platform's payouts)
- Connected accounts: Yes (Rainforest onboards and underwrites the merchant; a sub-merchant is `merchant_application` + `merchant`)
