# STEP 190 — General payment link creation, hosted checkout page and merchant token revoke and reissue controls

Status: **complete**. One commit, `STEP 190: General payment link creation, hosted checkout page and merchant
token revoke and reissue controls`, on `arena/ca936761-kd-solution-it`, branched from STEP 189's `443f178`. All
gates green; the STEP's own gate is `portal-payment-link-verify.ts` at **254 checks**, mutation-checked.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 190 — General payment link creation, hosted checkout page and merchant token revoke and reissue controls**
> Sub-step 4: the core service and logic for general payment links, the hosted checkout they open, and the
> merchant's token revoke and reissue controls.

FEATURE_LIST line 182: *"Payment links and hosted checkout: a merchant can create a general payment link and
share it anywhere, when the service is in the merchant plan."* Line 116 adds the entitlement half: *"Sub-merchants
use the services included in their plan, such as invoicing, payment links …"*. Acceptance: a **general** link (not
tied to an invoice), opened as a **hosted checkout**, **revocable** and **reissuable** by the merchant, and a
payment through it carries **no invoice**.

Eight sub-steps, all done. Sub-step 3 is a checked **proof that no migration is needed**, not an assumption - it
is written out below, in the store's header and in the gate.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `app/(client-portal)/portal-payment-link-fields.ts` | new | The vocabulary: path, token kind and capability, plan service key, amount bounds, provider divisor, description/reference/lifetime limits, states, statuses, fifteen rules, seven audit actions, body ceiling, page size, rate limit (browser safe) |
| `app/(client-portal)/portal-payment-link-store.ts` | new | The row as a **port** plus the in-memory store (`durable: false`), with the `portal_payment_links` column list in the header |
| `app/(client-portal)/portal-payment-link.ts` | new | `createPortalPaymentLink`, `openPortalPaymentLink`, `revokePortalPaymentLink(ById)`, `reissuePortalPaymentLink(ById)`, `listPortalPaymentLinks`, and the amount/state/URL/body helpers |
| `app/(client-portal)/portal-payment-link-checkout.ts` | new | `chargePortalPaymentLink` and `preparePortalPaymentLinkCheckout` |
| `app/(client-portal)/portal-payment-link-runtime.ts` | new | The production wiring: a real `subscriptions` → `plan_entitlements` entitlement read, the in-memory store, the payment page's own processor and tokenization key |
| `app/(client-portal)/p/[token]/page.tsx` | new | The hosted checkout page |
| `app/(client-portal)/p/[token]/charge/route.ts` | new | The payer's charge endpoint |
| `app/api/payment-links/route.ts` | new | `POST` create, `GET` list |
| `app/api/payment-links/[id]/revoke/route.ts` | new | The revoke control |
| `app/api/payment-links/[id]/reissue/route.ts` | new | The reissue control |
| `app/(dashboard)/payments/links/page.tsx` | new | The console's shell |
| `app/(dashboard)/payments/links/payment-links-console.tsx` | new | The console: make, copy once, cancel, reissue |
| `app/(client-portal)/portal-payment-link-verify.ts` | new | The gate, 254 checks |
| `app/(client-portal)/portal-payment.ts` | edited | `PortalChargeRequest.invoiceId` is `string \| null`, with the STEP named in the comment |
| `app/(client-portal)/portal-payment-processor.ts` | edited | The recorder's `open` accepts a null invoice, and the gateway reference falls back to the link's company when there is no document number |
| `components/payments/portal-payment-refusal.ts` | edited | Twelve link and merchant-console rules added to the shared vocabulary (and to the sentence table the form passes) |
| `lib/i18n/strings/en.ts` | edited | 69 strings: the payer's page, twelve rules, and a `paymentLinks` group for the console |
| `app/(client-portal)/README.md` | edited | The "What STEP 190 built" section |

`migrations/`, `lib/security/`, `lib/payments/`, `lib/auth/` and `services/` are untouched: STEP 058's token
module, STEP 037's CSRF, STEP 130's payment operation and STEP 183's processor are imported, never edited.

## The database sub-step: none is needed, and here is the proof

1. **No table for a link exists, and this STEP may not create one.** `migrations/` has 122 forward files; the gate
   reads every one of them and asserts none mentions `portal_payment_links`, and that the highest number is still
   `0122` - so `0123` stays free for the STEP that writes the table.
2. **A link's row is therefore a port**, exactly as STEP 183's payment recorder and STEP 186's blacklist queue
   are. `portal-payment-link-store.ts` carries the column list that table must have (`token_id`, `token_digest`,
   `reissue_count`, `expires_at`, `revoked_at`/`revoked_by_user_id`, `paid_at`/`payment_id`, the tenant and the
   row metadata) and the two indexes the controls need, so the STEP that owns migrations writes the table against
   a contract rather than a guess. The gate asserts the sketch is still in the file.
3. **Everything the money side needs already exists.** `0037`'s `payments.invoice_id` is nullable, which is what
   makes a link payment recordable at all; `payments_idempotency_fkey` still gets its key, from the form's own
   idempotency key.
4. **The entitlement needs no new table either.** `0017`'s `subscriptions` says which plan a company is on and
   `0015`'s `plan_entitlements` says which services a plan includes, keyed by the service string this STEP's
   vocabulary already names (`payment_links`). The runtime reads those two tables; it does not add a third.

## The three flows

### 1. Making a link

`createPortalPaymentLink` checks, in this order: the actor's role (`owner`, the same role that manages an
invoice), the tenant, the **entitlement** (absent ⇒ `503 payment_links_not_in_plan`; false ⇒ `403` with the same
rule), the **store's durability** (`503 payment_link_store_unavailable` - memory is not a place to mint a
credential), then the body: `amount`, `description`, `reference`, `expires_in_seconds`, strict, trimmed, bounded.

The amount goes through STEP 106's `priceToMinor`, then this feature's two bounds (`10_000` … `1_000_000_000`
platform minor units), then the provider's divisor (`100`): an amount the gateway cannot write is refused when the
merchant types it rather than when a payer tries to pay it. The token is minted **before** the row is written and
the row is written **before** the token is answered, so a link is never a URL that resolves to nothing.

The token carries the link's own row id, kind `payment_link` and capability `pay`; the row keeps
`portalTokenDigest(token)` and the token id, never the token. One audit entry, `portal.payment_link_created`,
carrying the amount, the token **id**, the expiry and the plan service, and never the token.

### 2. Opening it

`p/[token]` is a server-rendered, `force-dynamic` page; `openPortalPaymentLink` verifies the token with STEP 058's
`expect: { kind, capability }`, finds the row by its token id, and folds the state: paid ⇒ `link_paid`, revoked ⇒
`link_revoked`, past its clock ⇒ `link_expired`, and every token failure - forged, wrong kind, expired, or a
**reissued** link's old credential - is one `404 link_not_found`, because an answer that tells a visitor which of
the merchant's actions closed a link is a probe for which links exist.

The page then renders the amount, the merchant's note, the reference and the expiry, and the card form from
STEP 183's component - the platform's one card input, inside the provider's hosted fields.

**The bank's step is a stated gap, not a papered-over one.** A general link has no invoice and therefore no client
address, so `0037`'s `payments_three_ds_capture_check` accepts a captured link payment only when it was
authenticated. This build's 3D Secure port is `noPortalThreeDsPort` and its recorder is in memory, so the page
renders the payment page's own "bank confirmation is not switched on yet" panel and the charge route refuses by the
same fact (`503 three_ds_unavailable`). A form the page withheld cannot be reached by posting to the endpoint.
Adding the link's own 3D Secure step is named under *What is genuinely unfinished*.

### 3. Taking the money

`chargePortalPaymentLink` runs STEP 183's processor, so STEP 186's fraud signal, STEP 187's card blacklist and
STEP 188's card and address counters fire unchanged and in the same order. The differences are the document and
the record:

- `invoiceId: null` and `number: null`, so `payments.invoice_id` stays null and **no invoice balance and no ledger
  posting is touched**;
- the gateway's reference falls back to the link's company (the processor edit), because there is no document
  number;
- on capture the row moves to `paid` through `markPaid`, whose guard is the status: the loser of a race gets
  `conflict`, the payment is still recorded, and the entry carries `duplicate_link_payment: true` rather than
  hiding a second charge. The link's one-payment rule is that write, not a read-then-write in the service;
- a declined, flagged, blacklisted, rate-limited or unknown attempt leaves the link `active`, because the merchant
  has not been paid and the payer may try another card.

## The merchant's two controls

`revokePortalPaymentLink` retires the token in circulation: `owner` only, the merchant's own link only, and only
from `active`. The store's revoke is guarded on the token id the caller read, so a reissue racing a revoke is a
`conflict` rather than a revocation of a credential nobody holds. The digest is dropped with the state, because no
token is in circulation any more.

`reissuePortalPaymentLink` rotates the credential of a link that is **not** in circulation - revoked or expired -
and refuses a live one (its URL may already be shared) and a paid one (the money moved; a second credential for the
same request would be a way to charge it twice). The new token names the same row under a **new** token id, so the
old URL resolves to nothing at all, and `reissue_count` records how many credentials the request has had. Both
controls answer the new URL exactly once, like a creation.

Both controls exist in two forms: one that names the **token** (the link's own surfaces) and one that names the
**row id** (the console). The console lists rows, and a row never carries a token, so an id-keyed control is the
only one a merchant can use after the creation's response is gone. The id-keyed form reads the row company-scoped,
so another merchant's id is `404` rather than `403`, and then both forms call the same inner function: one state
check, one guarded write, one audit entry.

The console at `/payments/links` makes a link, shows its URL once with a copy button, lists the merchant's links
with their state and dates, offers **cancel** behind an inline confirmation (the URL stops working immediately),
and offers **reissue** on a cancelled or expired row. Every control re-reads the list, and every refusal is read
from the platform's error envelope and worded by the same module the payer's page uses.

## Security

| Concern | Where it is answered |
| --- | --- |
| Validation | The body is strict, trimmed and bounded (`2_048` bytes, checked against the declared length **and** the bytes); the amount is a price parser plus two bounds plus the provider's divisor; the description is 1-200, the reference ≤ 64, the lifetime 3 600-2 592 000 s. A refusal names a field and a rule and never the value. |
| Permission | `owner` on all five merchant operations; the tenant from the session, never from the body; the payer's route reads the actor *optionally* and refuses a merchant paying its own link (`self_payment`). |
| Tenancy | Reads are company-scoped in the store; a cross-tenant token is `PERMISSION_DENIED` on the merchant path and a cross-tenant id is `RESOURCE_NOT_FOUND`, so the two cannot be told apart by probing. |
| CSRF | `requireCsrfToken` on all four mutating routes, before the body is read. The payer's form works without a session on STEP 037's double-submit token. |
| Credentials | Only the digest is stored; the token is answered once, at creation and at reissue; no audit payload, log line or list row carries it. The gate asserts the created entry names `token_id` and has no `token` key. |
| Card data | No route and no page accepts a card field: the body goes through STEP 183's parser, which refuses 26 card keys with `card_data_refused`, and the gate proves a body with `card_number` is refused **and audited** with no gateway call. |
| Rate limits | The link's own counter, `portal_payment_link`, 5 attempts / 600 s per address, spent by attempts and answered with `retry-after`. |
| Audit | Seven actions (`portal.payment_link_created/revoked/reissued/captured/declined/refused/unknown`), all under entity `payment_link`, written tolerantly: a chain that is down never fails the payment it records. |
| RLS | Untouched, because no table is added. The entitlement read is through the platform's own REST client, which is already tenant-safe. |
| Failure mode | An unreadable entitlement is "not entitled"; an absent entitlement dependency is `503`; a non-durable store refuses to mint; a forbidden link is one `404` for every cause. |

## The gate

`node "app/(client-portal)/portal-payment-link-verify.ts"` - **254 checks**, in ten sections:

- **the vocabulary**: path, kind, capability, service key, entity, currency, body ceiling, page size, the rate
  limit's three values, the provider divisor, both amount bounds, the lifetime's three numbers, the description and
  reference limits, four fields in order, four printed states against three stored ones, fifteen distinct rules;
- **the amount**: three parses, six refusals (empty, letters, two dots, zero, below a dollar, above a hundred
  thousand), and the URL built with and without an origin;
- **creation**: staff refused, an actor with no company refused, no entitlement dependency ⇒ `503`, a false
  entitlement ⇒ `403`, a non-durable store ⇒ `503`, eight bad bodies each with their own field and rule, an unknown
  field refused, then a good creation whose token is opened again and checked claim by claim (`kind`, `capability`,
  `resourceId` = the link, `companyId`, `tokenId`), whose row holds the digest and not the token, and whose single
  entry names the token id and the plan service;
- **opening**: the live view, a token that does not verify, an **invoice-kind** token over the same row, and a link
  past its lifetime - which answers `404` because its token expired with it, while the row is still `active` and
  the state function still says `expired`;
- **revoking**: staff, another merchant's token (`PERMISSION_DENIED`) and another merchant's id
  (`RESOURCE_NOT_FOUND`), the successful revoke (status, digest dropped, payer told `link_revoked`, a second revoke
  a `link_not_active` conflict), the entry's payload, and the console's id-keyed revoke;
- **reissuing**: a live link refused, a non-durable store refused, a revoked link reissued (new id, new token,
  `previousTokenId`, count 1, fresh lifetime), the old URL resolving to nothing, the new one live, the entry's
  payload, and a **paid** link refused with the same answer for the token and the row id;
- **the list**: one tenant only, newest first, a ceiling no caller can raise past the constant, and staff refused;
- **the checkout**: a capture (`invoiceId: null`, `125.00`, the idempotency key, `duplicate: false`, the row
  `paid`, the entry's payment/transaction/key-hash), a second payer refused with **no further gateway call**, a
  merchant paying their own link (refused, audited, nothing sent), a revoked link, a card number in the body
  (`card_data_refused`, audited, nothing sent), no processor (`provider_unavailable`, link still live), a decline
  (code in the chain, link still live), four provider outcomes (risk reject, risk review, blacklist, unknown), a
  velocity breach (`429 velocity_card_limited`), and an amount the gateway cannot write
  (`amount_unrepresentable`, nothing sent);
- **the page**: the prepared view (tokenization key, environment, unavailability null, no partial payment, the
  amount as ceiling, a fresh idempotency key), the two unavailability panels, and twelve rules that each resolve to
  a real sentence;
- **the sources**: the store's table sketch and its `durable: false`, no `invoice_id` in a link's files, the
  checkout's `invoiceId: null`, four routes with CSRF + `no-store` + the actor from the session, the rate limit and
  the authentication refusal in the charge route, the form and `force-dynamic` in the page, both controls and the
  clipboard in the console, eighteen catalog keys, the README section, and the migration proof (highest is 122, no
  file names `portal_payment_links`).

**Mutation-checked.** Removing the store-durability refusal in `createPortalPaymentLink` and changing the
checkout's `invoiceId: null` to the link's id fails the gate with **2 problems**: *"and a store that cannot survive
a deploy mints nothing (nothing was thrown)"* and *"with no invoice, because a general link has none (expected null,
got …)"*. Both restored; the gate back to 254.

## Two previous gates

- **STEP 183's** gate still asserts one payment per idempotency key and no card data in any body: unchanged, 196
  checks, because the link's checkout is a second *caller* of that operation and not a second operation.
- **STEP 184's** gate still asserts the one capture rule shared with the schema: unchanged, 271 checks.

## Desktop and mobile widths

The hosted page and the console use only the classes the portal already uses: a `max-w-2xl` / `max-w-3xl` column
with `px-4 py-6 sm:px-6 sm:py-10`, cards that are `flex-col` with `p-4 sm:p-6`, and `flex-wrap` on every row of
chips and buttons, so at 360 px nothing is clipped: the console's form is one column, the list row stacks its
description, amount, state, dates and buttons, the URL panel's `break-all` wraps a long token instead of pushing
the page sideways, and the copy button sits under it. At 1440 px the same column is centred, the amount and the
description sit on one line, and the buttons sit to the right of the row. No fixed width, no `whitespace-nowrap`
and no `truncate` is introduced anywhere; the card container, the hosted fields and the submit button are STEP
183's unchanged, which is what keeps the checkout's card area the same size on both widths.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/p/[token]`, `/p/[token]/charge` and `/payments/links` are dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-payment-link-verify.ts"` | **254 checks** |
| `node "app/(client-portal)/portal-payment-verify.ts"` | 196 checks |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | 271 checks |
| `node "app/(client-portal)/portal-part-payment-verify.ts"` | 175 checks |
| `node "app/(client-portal)/portal-velocity-verify.ts"` | 204 checks |
| `node "app/(client-portal)/portal-blacklist-verify.ts"` | 208 checks |
| `node "app/(client-portal)/portal-fraud-verify.ts"` | 267 checks |
| `node "app/(client-portal)/portal-billing-match-verify.ts"` | 148 checks |
| `node "app/(client-portal)/portal-invoice-verify.ts"` / `portal-estimate-verify.ts` | 155 / 232 checks |
| `npm run check:i18n` | 2746 messages, 298 placeholders, 1 locale (was 2677 / 296) |
| `npm run check:structure` | 674 source files (was 661) |
| `npm run check:audit` | 3785 checks (was 3694) |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:config` | 10 sections, 32 values |
| `npm run check:errors` / `check:lint` / `check:env` | 202 / 77 / 16 checks |
| `npm run check:logger` / `check:shell` / `check:jobs` | 117 / 991 / 110 checks |

## What is genuinely unfinished

1. **The link's 3D Secure step.** A link payment must be authenticated (`0037`'s capture check, above), and STEP
   184's flow is invoice-scoped: it opens an invoice, seals the amount in the handle and compares the payer's postal
   code against the client's address. A link has no client, so the bank step for links needs its own start and
   completion over the same port and recorder - then the page and the charge route stop refusing and the hosted
   checkout takes a card for real. Until then both say so honestly.
2. **The durable link store.** `portal_payment_links` is not in `migrations/`, so the runtime's store is in memory
   and says `durable: false`; the services refuse to mint, revoke or reissue on it. The table sketch in
   `portal-payment-link-store.ts` is the contract for the STEP that writes it, and nothing else in this STEP
   changes when it lands.
3. **The durable payment recorder and key store** (STEP 183's gap, still open): `portal-payment-runtime.ts` wires
   the in-memory recorder and an empty key store, so no merchant has a tokenization key and the hosted page renders
   its "not available" panel for that reason too.
4. **A compliance referral from a link payment.** STEP 186 writes a referral against a document; a link has none,
   so a flagged link payment writes its own refusal entry with `referral_owner: null`. A referral that names a
   link rather than an invoice is a table decision, not this STEP's.
5. **A navigation entry for `/payments/links`.** The dashboard's navigation is a shared component this STEP does
   not own, so the console is reachable by URL only.

## Left for the STEPs after this one

- STEP 191: refund request and approval flow, which is where a `duplicate_link_payment` becomes a refund.
- The link's 3D Secure step and the `portal_payment_links` table.
