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

### Capability Matrix

- Charges: Yes
- Payouts: No (NMI is payments only)
- Connected accounts: Yes (creates sub-merchants)
