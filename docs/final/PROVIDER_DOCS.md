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
