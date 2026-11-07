// path: app/(client-portal)/README.md
# app/(client-portal)

Owner: STEP 181-190 (client portal, payment pages and payment links).

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
- `portal-invoice-rate-limit.ts` - the confirmation's own counter, on `rate_limit_windows`.
- `portal-invoice-runtime.ts` - the production wiring and the optional actor read.
- `portal-invoice-verify.ts` - the gate. It is not on the `verify` chain because `package.json` is not
  this block's file; run it with `node "app/(client-portal)/portal-invoice-verify.ts"`.

Payment components live in `components/payments/` (invoice receipt, confirmation card and form,
delivery card and form, and the refusal vocabulary both forms share).
