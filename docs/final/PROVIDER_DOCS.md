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

The record these notes produce is `partial`, never `verified`: `calculatePayoneerStatus` requires the whole five
step cycle to be present and passed before a record can read as verified.

### Capability Matrix

- Charges: No
- Payouts: Yes
- Connected accounts: No (Payoneer pays registered payees; it does not create sub-merchants)

