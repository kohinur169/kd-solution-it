// path: docs/handoffs/STEP_179_COMPLETED.md
# STEP 179 — Sales tax calculated automatically on United States invoices

**Status: COMPLETED**

## STEP

- Number and title: STEP 179 — Sales tax calculated automatically on United States invoices.
- Category: Sales Tax Collection With TaxCloud, STEPs 176-180. STEP 176 recorded the pages, STEP 177 built the connect flow and the ping, STEP 178 built the merchant's switch and the one decision, this STEP is the calculation itself, and STEP 180 renders the tax lines and the totals.
- Depends on: `docs/final/FEATURE_LIST.md` section 7 ("When enabled, sales tax is collected automatically on invoices", "Collection applies to United States transactions", "TaxCloud credentials are encrypted and only shown masked"); STEP 176's `lib/tax/taxcloud.ts` for the endpoint table, `taxCloudRequestOf`, `taxCloudPriceOf`, `taxCloudMinorOfAmount`, `taxCloudFailureOf` and `taxCloudProblemOf`; STEP 177's `lib/tax/taxcloud-connect.ts` for the connection row, the store, the sealer scopes and the one transport; STEP 178's `lib/tax/taxcloud-collection.ts` for `taxCloudCollectionGateOf` and `taxCloudUsableRowOf`; STEP 023's `migrations/0022_invoices.sql` and `migrations/0023_invoice_items.sql` for the money and quantity bounds and the total trigger; `services/products/price.ts` for `PRICE_SCALE` and the price ceiling.

## Owned paths, and the ones that stay shut

Owned and used: `lib/tax/` only, per `docs/final/STEP_PLAN_250.md:119` ("TaxCloud STEPs 176-180 own `lib/tax/` and tax settings").

- `lib/tax/taxcloud-invoice-tax.ts` — new, 876 lines. The validation, the two conversions, the cart body, the answer reader, `calculateInvoiceTax`, `completeInvoiceTaxOrder`, the retry schedule and the totals check.
- `lib/tax/taxcloud-invoice-tax-runtime.ts` — new, 37 lines. The production wiring: STEP 177's store, the real sealer, STEP 177's transport, the clock and the sleep.
- `lib/tax/taxcloud-invoice-tax-verify.ts` — new, 1180 lines, the gate, **284 checks**, eleven sections.
- `lib/tax/taxcloud-connect.ts` and `lib/tax/taxcloud-connect-verify.ts` — **edits inside this block's own directory**: the transport answer gained an optional `headers` field, filled and lower cased by `taxCloudFetchTransport`, so a `429` or `503` can honour the documented `Retry-After`. Two checks were added to STEP 177's gate, which now reads 346 rather than 344; STEP 177's handoff records that.
- `docs/handoffs/STEP_179_COMPLETED.md` — this file.

Untouched, deliberately: `services/invoices/` (see "Not Run" — the invoice writer is not this block's, and the integration is a call from it), `app/`, `components/`, `package.json` (the gate runs by path, as every STEP since 170 does), `config/structure.json`, `migrations/`, `lib/payments/`.

## Database

**No migration.** The columns this STEP reads were created by earlier STEPs, and the rules it must agree with are already constraints:

| Rule | Where it is enforced | What this STEP does |
|---|---|---|
| The invoice's total is `subtotal - discount + tax` | `invoices_total_check` and the trigger in `migrations/0022_invoices.sql:40` | Returns `tax_minor` and nothing else; the database recomputes the total, so this module cannot disagree with the check. |
| A line's total is `((quantity * unit_price)::bigint - discount_minor)` | the stored column in `migrations/0023_invoice_items.sql:110` | Mirrors the same truncation in `taxCloudInvoiceTaxProblemOf` (`(quantityThousandths * unitPriceMinor) / 1000n`), and the gate reads the migration to prove the two agree. |
| A quantity is above zero and at most one million | `invoice_items_quantity_check` | The same bound in `TAXCLOUD_INVOICE_MAXIMUM_QUANTITY_THOUSANDTHS`, proven against the migration by the gate. |
| An invoice discount is at most the subtotal | `invoices_discount_check`, `migrations/0022_invoices.sql:110` | The same bound, computed as the sum of each line's net. |
| Nothing in this path writes a row | — | The module only ever calls `listByCompany`; the gate proves the row is byte identical after a calculation, so no audit entry is owed here and the invoice's own mutation carries its own. |

**A finding worth recording**: `migrations/` has **no TIC column** anywhere - not on `invoice_items`, not on `products`. TaxCloud's cart line takes an optional `tic` and documents `0` as the default. So `TaxCloudInvoiceLine.tic` is optional, is sent only when the caller supplies one (bounded to a whole number between zero and 99999), and is omitted otherwise; the gate proves the key is absent from the body rather than zero-filled, so a merchant who never assigns one is not silently recorded as assigning TIC 0. A product-level TIC belongs to a STEP that owns the products table.

## Environment

No variable is added. `taxcloud-invoice-tax-runtime.ts` reads the existing `ENCRYPTION_MASTER_KEY` through `openSecret`/`sealSecret` and nothing else; the module itself receives its store, sealer and transport as options and imports no environment reader, which the gate proves by scanning its own source.

## Packages

None. `package.json` is unchanged.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| When enabled, sales tax is calculated on an invoice | `calculateInvoiceTax` asks STEP 178's gate first and answers `calculated` with the per-line amounts and their sum in minor units. The gate proves a verified, switched-on merchant is priced with one call, and the request's URL, method, key header and body. |
| Only United States transactions | The country handed to the gate is the destination's. The gate proves a Canadian client reads `not_collected` with `outside_united_states`, that no call is made, and that a Toronto postal code is not reported as a malformed invoice. |
| Only when the merchant switched it on | A switched-off merchant and an unverified connection both answer `not_collected` with `switched_off` and `unverified`, and the gate proves no call is made and the sentence is STEP 178's own (`"The merchant has switched sales tax collection off."`). |
| The credentials stay sealed | The key and the connection ID are opened per call, never cached: the gate counts exactly two opens per calculation and four for two, proves a second call reopens them, and proves the result carries neither the key, the connection ID, nor a sealed box. |
| A retry cannot create a second cart | `cartId` is the invoice's id, which TaxCloud documents as an upsert. The gate proves two saves for one invoice send the same cart id twice and another invoice sends its own. |
| Money is exact in both directions | Prices and discounts go out as JSON numbers through STEP 176's `taxCloudPriceOf` (a sub-cent value is refused, not rounded, and the gate proves it), quantities go out as exact decimals (`1.001` round-trips, `2.5` is `2.5` - the gate proves six spellings), and the answer's `tax.amount` comes back through `taxCloudMinorOfAmount`, so the invoice's tax is four-decimal minor units. |
| The documented shape, not a guess | The cart body is the documented one: one item, `cartId`, `customerId`, `currency.currencyCode`, `destination`, `origin`, ordered `lineItems` with `index`, `itemId`, `price` and a fractional `quantity`, and `discounts` with `lineItemDiscounts` (amount, `cartItemIndex`) and `orderDiscount` (amount) only when there is a discount. The gate proves every key, that no discount field appears when nothing is discounted, that no exemption is claimed, and that a TIC appears only when assigned. |
| A wrong answer is a failure, not a wrong invoice | The reader refuses: no items, an empty list, a cart that is not ours, no line items, a line that is not an object, no item id, a fractional index, a line that was not sent, no tax, no amount, an amount that is not a number, an amount with five decimals, a negative amount, a duplicated line and fewer lines than were sent. It reads the cart with our id rather than the first in the list (proven with the foreign cart first). |
| The tax is the sum of the lines | `totalTaxMinor` is the sum, and `taxCloudInvoiceTaxTotalOf` refuses a total that is not that sum with `INTERNAL_ERROR`. The gate proves both. |
| A zero amount is a calculation | An exempt line priced at `0` answers `calculated` with a zero tax, not a refusal and not `not_collected`. |
| Refusals happen before the network | An empty invoice, a missing street or city, a state that is not a two letter code, a ZIP that is not five digits, a missing country, a zero or oversized quantity, a negative or oversized price, a discount past its line, an invoice discount past the subtotal, a duplicate line key and a TIC out of range all answer `refused` with the sentence naming the field, and the gate proves each one plus the call count of zero. |
| TaxCloud's refusals are read through STEP 176's table | `400`, `401`, `403`, `404` and `422` answer `rejected` with the table's `ErrorCode` (the gate compares a `403` against `taxCloudFailureOf(403)` rather than a hard-coded value), TaxCloud's own `detail` when it sends one, and the HTTP status. |
| An outage is not a refusal | `429`, `500`, `503` and a network failure answer `unavailable` with the attempt count: three attempts, the documented `Retry-After` honoured (seconds or an HTTP date), a doubling `250, 500` otherwise, every wait capped at three seconds, and a second attempt that succeeds producing a calculation. The gate proves the schedule by recording the sleeps, and proves a `Retry-After: 2` becomes 2000 ms and `900` becomes the 3000 ms ceiling. |
| The order is completed without duplicating | `completeInvoiceTaxOrder` sends `orderId`, `cartId` and an ISO `completedDate` to `POST /carts/orders`, both ids being the invoice's. A future instant and a zero instant are refused before the call, the ISO instant is proven in the body, and a `400`, `409` or `422` is read back through the documented `GET /orders/{orderId}` - an order that exists is answered `completed` with `alreadyExisted: true`, one that does not is `rejected` with the original status. The gate proves the read is a `GET` with no body, that it is retried twice before being given up, and that an unreadable read leaves the answer a rejection rather than a completion. |
| A stored connection that cannot be addressed is a failure | An id that is not a connection id makes STEP 176's builder refuse; the module turns that into `failed` with "the stored connection cannot be addressed" and makes no request. The gate proves both. |
| The split stays honest | The module writes no row and therefore audits nothing, and the gate proves the connection row is unchanged. The invoice's mutation is the one that is audited, by the STEP that owns it. |

## Security review for this STEP

- **Validation**: every value that reaches a request is bounded before it is used - identifiers by a character class and a length, addresses by field, money by the invoice's own ceilings, quantity by the migration's check, discounts by the line and the subtotal, a TIC by range. Every value that comes back from TaxCloud is type checked before it becomes money.
- **RLS**: the read is the merchant's own rows through the same server store STEP 178 uses; no merchant session is opened, and the module never writes.
- **Audit log entries**: none in this module, deliberately, because it mutates nothing. The gate proves the absence with a byte comparison rather than a comment.
- **Permission checks**: the caller's permission belongs to the invoice surface that calls this (its own STEP); this module computes for a company id it is given and reaches no route of its own.
- **Secrets**: opened per call, twice, never cached (proven by a counting sealer), never returned (proven by searching the serialised result for the key, the connection id and the box field names), and never in the body or the URL (proven on both).
- **Outbound**: one transport, STEP 177's, checkable in one place; the module builds no `fetch` of its own and the gate proves the word `fetch(` is absent.

## Verification

- `npm run typecheck` — clean.
- `npx eslint lib/tax/` — clean, no warnings.
- `node lib/tax/taxcloud-invoice-tax-verify.ts` — `taxcloud invoice tax gate passed: 284 checks`.
- `node --experimental-strip-types lib/tax/taxcloud-invoice-tax-verify.ts` — the same 284 checks.
- `node lib/tax/taxcloud-connect-verify.ts` — 346 checks (STEP 177's gate, two of them new).
- `node lib/tax/taxcloud-collection-verify.ts` — 215 checks (STEP 178's gate, untouched).
- `npm run check:structure` — 17 directories, 14 root files, **593** source files.
- `npm run build` — clean, every route compiled.
- `npm run verify` — **exit 0**: audit **3316** checks, structure 593 source files, lint **77** checks.
- Gate mutation proof: **39 of 39** mutations were caught, each applied to a `/tmp` copy of the module, run against the honest gate and restored in the same command. The mutations were: a retryable status that stops being retried; a third attempt; a doubled first wait; a grown wait ceiling; a currency that is not the platform's; a quantity read at the wrong scale; a quantity past one million; a price past the ceiling; an unchecked invoice id; an empty invoice that is priceable; an unchecked merchant address; an unchecked client address; a negative invoice discount; two lines sharing a key; a zero quantity; a discount past its line; an invoice discount past the subtotal; an unbounded TIC; a quantity rounded to cents; a cart id that is not the invoice's; a cart with no currency; a TIC never sent; a discounts object on every cart; a cart not matched to the invoice; a duplicated line accepted twice; a total that is the first line only; a cached plaintext key; a merchant switch that is ignored; a retryable status that is not retried; `Retry-After` ignored; a rejection reported as a failure; a future completion sent; a duplicate never read back; a read-back order reported as new; an order id that is not the invoice's; a total that does not add up accepted; a masked connection id used as the connection id; and a refusal with no reason.

## Not Run / Open

- **No route and no screen.** `app/` and `components/` are not this block's, and this block's precedent since STEP 170 is a `lib/` module with a gate. The view model a screen needs is `TaxCloudInvoiceTax` (per-line amounts with the documented rate as information) and the sentences that come with `not_collected`; STEP 180 renders the tax lines and the totals.
- **The invoice writer is not this block's.** `services/invoices/` belongs to its own STEPs, so nothing there is edited here. The integration is one call: on a draft being saved or issued, call `calculateInvoiceTax` with the invoice's lines and the two addresses, store `tax.totalTaxMinor` in `invoices.tax_minor` (lets the trigger recompute the total), and on issue call `completeInvoiceTaxOrder`. Both take the server store, because STEP 0073's merchant policy forbids a merchant session from updating a verified row.
- **Where the amounts land.** STEP 180 owns the stored tax line. This module hands over per-line amounts keyed by `itemId` and `index` precisely so that STEP can write one row per line without re-asking TaxCloud.
- **A merchant with no TIC gets the documented default.** Sending `0` for every line is what TaxCloud does when the field is absent; this module omits the field so the answer can never be read as "the merchant chose TIC 0". A product-level TIC needs a migration and a STEP that owns `products`.
- **Discounts are amounts, not percentages.** `invoices.discount_basis` may be `percent`, but the platform always resolves it to `discount_minor` before this module sees it, and TaxCloud accepts an amount discount. Sending a percentage would make TaxCloud recompute the platform's rounding, which is the one thing this STEP refuses to duplicate.
- **The rate is information.** `rate` is kept per line and never multiplied by anything; the invoice's tax is the sum of the amounts TaxCloud returned. A screen may print it; money may not come from it.
- **No polling and no webhook.** TaxCloud documents no callback, so a calculation is asked for at save and issue, and a recalculation is simply another `POST /carts` on the same `cartId`, which is an upsert. STEP 180 decides when the screen asks again.
- **Outage handling belongs to the caller.** `unavailable` is a distinct answer so the invoice surface can decide whether a draft may be saved with no tax line and retried, or whether the invoice must wait. This module never stores a zero in its place, which is the behaviour the block exists to prevent.
