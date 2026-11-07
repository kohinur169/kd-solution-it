// path: docs/handoffs/STEP_183_COMPLETED.md
# STEP 183 — Payment page with provider hosted secure fields

**Status: COMPLETED**

## STEP

- Number and title: STEP 183 — Payment page with provider hosted secure fields.
- Category: Client Portal, Payment Pages and Payment Links, STEPs 181-190, the third STEP of the block.
  STEP 181 built the invoice link, STEP 182 the estimate link, STEP 183 the page that takes the card, and
  STEPs 184-189 build the risk rules, the part payment and the connection to the partial-payment service on
  top of it.
- Depends on: `docs/final/FEATURE_LIST.md` section 18 line 192 (“card number, expiry and CVV are entered only
  inside the provider hosted secure fields. Platform code and servers never read, store or track card data or
  keystrokes”) and section 6's NMI paragraph (Collect.js hosted fields, “which returns a payment token to the
  browser”, our code never reads or stores the card); `docs/final/STEP_PLAN_250.md:2350-2360`, and the two
  cross-STEP contracts that name this STEP: `:77` (“STEP 183 embeds hosted fields … provider adapters must not
  create duplicate page implementations, and page STEPs must not handle raw card data”) and `:120` (“STEP 130
  creates the idempotent payment operation, STEP 132 posts only confirmed money as balanced ledger entries,
  provider STEPs execute provider operations, STEP 183 supplies the hosted-fields page, and STEP 189 connects
  the invoice link to the same partial-payment service”); STEP 149's `generateCollectJsConfig`,
  `validateCollectJsToken` and `COLLECT_JS_SCRIPT_URL`, STEP 151's `processNmiPayment`, STEP 129's
  `routePayment`, STEP 152's `NmiKeyStore` interface, STEP 024's `0037_payments.sql`, STEP 030's
  `0030_provider_keys.sql`, and STEP 181's `openPortalInvoice`, money printer, refusal vocabulary, runtime
  and shared rate limiter.

## Owned paths, and the ones that stay shut

Owned and used: `app/(client-portal)/` and `components/payments/`.

- `app/(client-portal)/portal-payment-fields.ts` — new, 216 lines. The vocabulary: the body's two fields, the
  26 card keys that must never appear in one, the token shapes, the `portal_payment` policy (5 attempts per
  address per ten minutes), the eight refusals, the audit actions, and `portalPaymentChargeAmountOf`, which
  turns four-decimal minor units into the dollars and cents the provider takes - or refuses.
- `app/(client-portal)/portal-payment.ts` — new, 570 lines. The service: `preparePortalPayment` (what the page
  prints) and `chargePortalPayment` (the one charge), plus the depth-first card-field scanner and the strict
  body schema.
- `app/(client-portal)/portal-payment-processor.ts` — new, 292 lines. The composition a charge runs through:
  routing (STEP 129) → the recorder port → provider execution (STEP 151), and the in-memory recorder.
- `app/(client-portal)/portal-payment-runtime.ts` — new, 89 lines. The production wiring, and the statement of
  what it cannot do yet.
- `app/(client-portal)/portal-payment-verify.ts` — new, 1208 lines, the gate, **194 checks**.
- `app/(client-portal)/i/[token]/pay/page.tsx` — new, 229 lines. The payment page.
- `app/(client-portal)/i/[token]/pay/charge/route.ts` — new, 154 lines. The charge.
- `components/payments/card-payment-form.tsx` — new, 292 lines. The hosted fields and the button.
- `components/payments/portal-payment-refusal.ts` — new, 82 lines. The payment rules as sentences.
- `app/(client-portal)/i/[token]/page.tsx` — edited in two places only: a `Link` import and a “Pay by card”
  link inside `PaymentBlock`, so the payment page is reachable from the invoice it pays.
- `lib/i18n/strings/en.ts` — extended with 35 `portal.*` keys. No existing key changed.
- `app/(client-portal)/README.md` — the STEP 183 section.
- `docs/handoffs/STEP_183_COMPLETED.md` — this file.

Untouched, deliberately: `lib/payments/` (every module there is read, never edited - routing, the adapters, the
key store interface), `migrations/` (**not one file added or edited**), `next.config.mjs` (a root foundation
file, and it sets no CSP - see the note below), `package.json` (so the gate is a script), and STEPs 181 and
182's modules apart from the one link in the invoice page.

## The database sub-step, and why there is no migration

The plan asks for the DB sub-step first. Reading the schema instead of writing one found every column:

| What the page needs | Where it already is |
| --- | --- |
| A payment with amount, method, status, provider transaction, failure code | `0037_payments.sql` |
| The idempotency key that makes a second submit one payment | `0037`'s `idempotency_key_id` + `payments_idempotency_key` unique index |
| The two card facts section 18 allows, required together, and no column for anything else | `0037`'s `card_brand`, `card_last_four`, `payments_card_pair_check` |
| The gateway keys, platform scoped and encrypted | `0030_provider_keys.sql` |
| No column for a PAN, an expiry or a CVV | checked by the gate, column by column |

The gate asserts each of those, including that the payments table has no card-number column, so “no migration”
is a checked claim rather than an assumption.

## The card boundary, which is what this STEP is

Everything the page does is built so that a card number cannot enter the platform:

1. **The browser.** The form renders three empty `<div>`s with the ids NMI's quick start documents
   (`#ccnumber`, `#ccexp`, `#cvv`). Collect.js replaces each with an iframe served from `secure.nmi.com`; the
   keystrokes stay in that document. There is no `<input>` in the form's markup at all (the gate strips the
   comments and asserts it), no keystroke handler, no `type="password"` field and no `autocomplete="cc-*"`
   target - a browser autofill into our DOM would put card data outside the provider's frames.
2. **The body.** Two fields, `collectjs_token` and `idempotency_key`, and a strict schema. A body carrying a
   card-shaped key is refused at any depth and in any spelling - `card_number`, `card-number`, `cardNumber`,
   `CardNumber`, `pan`, `cvv`, `cvc`, `expiry_month`, `account_number`, `pin`, and eighteen more - and the
   refusal names the *path* of the field, never its value. The gate proves both halves: the refusal, and that
   the refusal's details do not contain the digits that were posted.
3. **The token.** A card number pasted into the token box is refused before the provider sees it. STEP 149's
   validator accepts `[A-Za-z0-9_-]{10,}`, which happily accepts sixteen digits, so this STEP refuses a
   12-to-22-digit run (with or without spaces) as card data rather than forwarding it as a token.
4. **The audit.** A card-data refusal is written to the audit chain (`portal.payment_refused`) with the rule
   only, never the value, so an operator sees somebody posting card data at a page that never accepts it.

## What the page can and cannot do in this build, stated plainly

The page needs three things to take a card: the link's key ring (present, from the platform's master key), a
company's **public tokenization key**, and a **durable recorder** for the payment it charges. The last two do
not exist in this repository yet, and the runtime says so rather than pretending:

- **The key store is in memory and empty** (`portal-payment-runtime.ts`). `provider_keys` holds the gateway
  credentials in the database; the adapter that reads and decrypts them persistently is STEP 152's key
  management work, and `nmi-client.ts`'s `NmiKeyStore` is an interface with an in-memory implementation. So no
  company has a tokenization key configured, and the page says “Card payment is not available yet” instead of
  drawing fields that would fail at the gateway.
- **The recorder is in memory and therefore not durable.** Recording a payment in one process is not
  recording it, which is the same finding the STEP 117-151 review states for the whole payment core (“several
  payment-core implementations are in-memory reference stores … Do not execute real payments or payouts until
  these are designed and tested against the database”). `chargePortalPayment` refuses with
  `recorder_unavailable` when the operation says it is not durable, because charging a card and losing the
  record of it is worse than not taking the payment.

So a payment page in this build shows the amount, explains the fields and answers honestly. The **flow itself**
- hosted fields, token, service-side verification, routing, provider execution, idempotency, the four provider
answers and the audit - is built and proven in `portal-payment-verify.ts`, and the gate runs it with a durable
recorder and a recording transport. Two named consumers turn it on, and neither is this STEP's file to write:

| The missing piece | What it is | Owner |
| --- | --- | --- |
| A durable `PortalPaymentRecorder` | a `payments` row plus its idempotency key, opened before the charge and settled after it, in one transaction | STEP 130/132's persistent payment operation (named by the review) |
| A persistent `NmiKeyStore` | `provider_keys`, decrypted with the master key, per company | STEP 152's key management |
| The invoice balance | the ledger postings that move `amount_paid_minor` | STEP 132, connected to this page by STEP 189 |

## The provider documentation read in this session

The plan requires a provider-touching session to read the provider's own documentation and record the URLs.
Read on 2026-11-07:

| URL | What it established |
| --- | --- |
| https://docs.nmi.com/docs/collectjs | Collect.js returns a `payment_token`; tokens are **single use** and destroyed after the first submission, and expire after 24 hours |
| https://docs.nmi.com/docs/quick-start-tutorial | the script tag is `https://secure.nmi.com/token/Collect.js` with `data-tokenization-key` and `data-variant="inline"`; the fields are `#ccnumber`, `#ccexp`, `#cvv`; the submit button's id tells Collect.js what submits the form; the token is added to the form submission; the documented minimum CSP allows `https://secure.nmi.com` for `script-src`, `connect-src` and `frame-src`, and `form-action 'self'`; “disable form submission until you have confirmed that the payment fields are successfully stored” |
| https://docs.nmi.com/docs/advanced-integrations | `CollectJS.configure({ paymentSelector, callback })`: the callback runs when the fields hold a stored card and receives the token, “takes the place of the default behaviour”, and posting the token to the server is the integration's responsibility; `CollectJS.clearInputs()`; the default field selectors |

Two consequences are written into the code: a spent token is cleared and the card re-asked for rather than
retried, and an unknown outcome is refused and reconciled rather than retried - a lost answer may have taken
the money, and a second charge would take it again.

**A note this STEP cannot act on:** the deployment sets no `Content-Security-Policy` header today (there is
none in `next.config.mjs`, which is a root foundation file owned by STEPs 001-011). When one is added it must
allow `https://secure.nmi.com` in `script-src`, `connect-src` and `frame-src`, or the hosted fields will not
load. `docs/final/PROVIDER_DOCS.md` is extended only by adapter STEPs 147-169, so these findings are recorded
here rather than there.

## The four provider answers, and why each becomes a different page

| The provider says | The record is settled | The client reads |
| --- | --- | --- |
| `response=1` with a transaction id | captured, with the transaction | “Payment received”, with the amount and the instant |
| `response=2` (a decline) | declined, with the response code | “The card was declined”, and the card is cleared |
| a transport error or an unreadable answer | unknown, marked for reconciliation | “Do not try again: the payment is being checked” |
| a rejected request (no key, nothing sent) | unknown, nothing was charged | “The payment provider is not reachable” |

The fourth is deliberately not a decline: a configuration refusal must never tell a payer their card was
refused.

## Idempotency, end to end

The page hands the form one fresh key per render, and the form sends it back with the token. The recorder opens
a record for the key and settles it with the outcome; a second submit with the same key finds the settled
record and answers the first result **without calling the provider again**. The gate proves it: two submits,
one provider call, the same `paymentId`, and two audit entries (both attempts are facts worth recording). A
different key is a different payment and a second call.

## What was exercised

`node "app/(client-portal)/portal-payment-verify.ts"` — 194 checks over a fake PostgREST, a real
`InMemoryNmiKeyStore` configured through STEP 149's own `configureNmiKeys`, and a recording transport that
answers the way NMI's Classic API documents:

- the amount: `1000000 → "100.00"`, `2000 → "0.20"`, and a sub-cent amount refused rather than rounded;
- the body: the two fields, trimmed, plus eleven refusals - card number, nested cvv, `CardNumber`, an expiry,
  a spaced PAN in the token, a digit-run token, empty, short, spaced, an own `amount_minor`, a non-uuid key, an
  over-long token - and the proof that no refusal carries the digits;
- the page: amount, printed amount, charge amount, public key, script URL, environment, a fresh key per render,
  and the three states that offer no form (no gateway key, non-durable recorder, no operation at all);
- the page's refusals: settled invoice, cancelled invoice, draft, a sub-cent total, a link without `pay`;
- the charge: one provider call, at the sandbox endpoint, as a `sale`, for `100.00`, with the token and the
  invoice number, carrying no other field - and the record settled with the transaction, one audit entry,
  naming the payment and hashing the key rather than storing it;
- the repeat: same key → same payment, one call; new key → new payment, second call;
- the provider's other answers: decline (audited with the code), lost answer (unknown, reconcile, record
  settled unknown), no key (refused before anything is sent), a routing rule pointing at a provider without
  hosted fields (refused, nothing sent), a non-durable recorder (refused, nothing sent);
- the payer-side refusals: the merchant's own session, card data in the body (nothing sent, audited without
  the value), a settled invoice, a link that does not verify;
- the counter: allowed, refused once and audited with a hash, and a counter that cannot answer failing closed;
- the sources: CSRF before the counter before the body, the byte ceiling twice, `force-dynamic`, `noindex`, a
  page and a form with no input element of their own, the tokenization key as a `data-` attribute, the script
  mounted by the form, `clearInputs`, no console logging, no note-to-self;
- the schema: five payment columns, no card-number column, the card pair check, the platform-scoped encrypted
  keys - the proof that no migration is needed.

The gate was mutation-checked: disabling the card-field scan makes it fail with seven problems, five of which
name the refusals that stopped happening and two of which are the audit entries that were never written.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/i/[token]/pay` and `/i/[token]/pay/charge` are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-payment-verify.ts"` | **portal payment gate passed: 194 checks, 26 card keys refused, one payment per idempotency key, no card data in any body, no migration needed** |
| `node "app/(client-portal)/portal-invoice-verify.ts"` | portal invoice gate passed: 155 checks |
| `node "app/(client-portal)/portal-estimate-verify.ts"` | portal estimate gate passed: 232 checks |
| `npm run check:audit` | audit gate passed: 3498 checks |
| `npm run check:structure` | structure gate passed: 631 source files |
| `npm run check:i18n` | i18n gate passed: 2630 messages |
| `npm run check:migrations` | migrations gate passed: 3572 checks, 122 migrations, 92 tables |
| `npm run check:errors`, `check:lint` | passed |

## Left for the STEPs after this one

- **STEP 184** adds 3DS: `payments.three_ds_outcome` and `payments_three_ds_capture_check` already exist, so
  the page will hand the authentication result to the same charge path rather than to a second one.
- **STEP 185** adds the postal-code and IP-country rule, which is the other half of that same check.
- **STEP 186** turns a fraud signal into an immediate rejection - `payments_risk_reject_check` already refuses
  a `reject` decision on anything but a failed payment.
- **STEP 188** adds the card and IP velocity limits beside this page's five-attempt counter.
- **STEP 189** connects the invoice link to the partial-payment service and lets the payer choose an amount
  between the floor and the remaining due; this page takes the remaining due exactly, and the button says so.
- **STEP 190** builds the general payment link and its hosted checkout over this page's fields, which is why
  the form takes its amount, its key and its configuration as props rather than reading them itself.
