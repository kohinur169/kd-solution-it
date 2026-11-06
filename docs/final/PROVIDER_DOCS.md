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
