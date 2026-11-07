# STEP 189 — Part payment on invoice link limited to remaining amount

Status: **complete**. One commit, `STEP 189: Part payment on invoice link limited to remaining amount`, on
`arena/ca936761-kd-solution-it`, branched from STEP 188's `ab8a51a`. All gates green; the STEP's own gate is
`portal-part-payment-verify.ts` at **175 checks**, mutation-checked.

## STEP

From `docs/final/STEP_PLAN_250.md`:

> **STEP 189 — Part payment on invoice link limited to remaining amount**
> Sub-step 4: the core service and logic for part payment on the invoice link, limited to the remaining amount.

FEATURE_LIST section 18, last line: *"A partly paid invoice link accepts only the remaining amount."*
Section 16's floor (`money.minimumPartialPayment`, `20.0000`) is the second rule a part payment meets, and the
plan's own dependency note says STEP 189 *"connects the invoice link to the same partial-payment service"* -
STEP 124's - which is why the two rule words are asserted identical rather than re-invented.

Eight sub-steps, all done. Sub-step 3 is a checked **proof that no migration is needed**, not an assumption.

## Owned paths

| Path | State | What it holds |
| --- | --- | --- |
| `app/(client-portal)/portal-part-payment-fields.ts` | new | The vocabulary: the one body field, four rules, the printed forms, the shapes the page hands the form (browser safe) |
| `app/(client-portal)/portal-part-payment.ts` | new | The rules: limits, body split, the one amount resolution, the "has the document moved" question |
| `app/(client-portal)/portal-part-payment-verify.ts` | new | The gate, 175 checks |
| `app/(client-portal)/portal-payment.ts` | edited | The view's `partPayment`, the split before the strict parser, one resolution used by every charge, the audit's `part_payment` |
| `app/(client-portal)/portal-three-ds.ts` | edited | The amount split beside the postal code, the chosen amount sealed in the handle, the completion's re-check and re-post |
| `components/payments/card-payment-form.tsx` | edited | The amount field, its hint, the generic submit label |
| `components/payments/portal-payment-refusal.ts` | edited | Four rules to three sentences |
| `app/(client-portal)/i/[token]/pay/page.tsx` | edited | Passes the limits to the form |
| `app/(client-portal)/portal-payment-verify.ts` | edited | One assertion restated (see *Two previous gates*) |
| `app/(client-portal)/README.md` | edited | The STEP 189 section |
| `lib/i18n/strings/en.ts` | edited | Seven sentences and labels |

`services/invoices/`, `services/products/`, `lib/payments/`, `lib/security/` and `migrations/` are untouched:
STEP 124's service and the platform's price parser are imported, never edited.

## The database sub-step: none is needed, and here is the proof

- `0022` already carries `amount_paid_minor` (`numeric(18,4)`), the three money checks
  (`invoices_status_money_check`, `invoices_money_check`, `invoices_paid_check`) and
  `invoices_partial_minimum_check` - the partial floor, which STEP 124 already documented as a *backstop* at
  `$0.20` because it was written for a two-decimal habit. The service has been the authority on the twenty
  dollars since STEP 124, and this STEP's page is the second caller of that same rule, not a third copy.
- `0037` already carries `payments.amount_minor`, the column the part is recorded in.
- The twenty dollar floor is `config/app.ts`'s `money.minimumPartialPayment`, a configuration value, not a column.

The gate asserts `0123` is still the next free migration number: 122 committed, unchanged from STEP 188.

## The rules, and where each one lives

| Rule | Where | What it does |
| --- | --- | --- |
| The ceiling | `portalPartPaymentAmountOf` | `remaining = total - amount_paid_minor`, read from the invoice in **this** request; a larger amount is `exceeds_remaining` (`VALIDATION_FAILED`), never clamped |
| The floor | the same function | a payment that leaves the document open is a partial and must be `>= 20.0000`; the settling payment is not a partial and has no floor |
| The folding | `portalMinimumPartialMinor` (STEP 181) | a remainder at or below the floor folds into the remainder, so a small remainder is payable **only** whole - the same function the invoice page prints |
| The parser | `priceToMinor` (STEP 106's) | typed text in, minor units out; `1e3`, `12,50`, `-5` and a fifth decimal are refused, not coerced |
| The provider's cents | `portalPaymentChargeAmountOf` (STEP 183's) | a sub-cent amount cannot be charged exactly and is refused |
| Whose number it is | `portalPartPaymentAmountOf` | the document's own unwritable remainder is `CONFLICT` (STEP 183's answer, unchanged); a payer's own unwritable amount is `VALIDATION_FAILED` |

`below_minimum` and `exceeds_remaining` are STEP 124's strings, imported by the **gate** from
`services/invoices/invoice-status.ts` and compared with the page's vocabulary. They are spelled, not imported,
in the portal module, because that module is read by a client component and STEP 124's file reaches the REST
client and the audit trail - the same boundary `portalPaymentRefusalIsFinal` documents.

The two rules that describe **one form field** are the page's own names (`amount_invalid`, `amount_zero`) rather
than STEP 124's shared `invalid_format`, because the card form maps a rule to a sentence without knowing the
field: a shared word would tell a payer to fix their amount when the problem was their card token.

## One resolution, three callers

`portalPartPaymentAmountOf` is called by the plain charge, the 3D Secure start and (through the re-posted body)
the 3D Secure completion. Everything downstream carries its answer:

- the payment operation's `amountMinor` and the gateway's `chargeAmount`;
- the `payments` row the recorder opens;
- the captured/declined/unknown/velocity/blacklist audit payloads (`amount_minor`, plus `part_payment`);
- the 3D Secure *record* and the *sealed handle* (`amountMinor`), so the challenge and the capture are for the
  same number, and the completion's re-check is "can this amount still be taken" rather than "is it the whole".

An absent `amount` is the whole remainder - the request STEP 183 always sent - and the gate proves that path is
byte-identical in behaviour to before: one gateway call for `100.00`, `part_payment: false`.

## What a part payment does not do

It does not write `invoices.amount_paid_minor`. The page opens a `payments` row and settles it (STEP 130's
operation); the balance follows from STEP 132's ledger entries, which is the plan's own sentence: *"a
failed/pending attempt never reduces the invoice balance."* The gate asserts neither this STEP's service nor the
payment page contains a write to that column.

## The form

One new field, only when a legal choice exists (`partPayment.allowPartial`): a labelled `type="text"` input with
`inputMode="decimal"`, pre-filled with the whole remainder at the platform's four-decimal scale, the ceiling and
floor printed beside it, and the submit button labelled generically (`Pay now`) so it does not print a larger
number in the field's place. When the remainder is at or below the floor the field is absent and one sentence
says the whole amount is paid at once; when a choice exists and the payer clears the field, the button is
disabled rather than silently charging the whole remainder.

**Desktop and mobile widths.** The field, its hint and the button are the classes the form already had:
`fieldClasses` (a column), `hostClasses` (`h-10 w-full ... text-sm`), `hintClasses` (`text-xs`, wrapping),
`submitClasses` (`w-full ... sm:w-auto`). Nothing new introduces a fixed width, a `whitespace-nowrap` or a
`truncate`, so at 360 px the input is a full-width box and the two-sentence hint wraps to three or four lines,
and at 1440 px the same box sits in the form's single column with the hint on one line. `maxLength` (18) keeps a
pasted document out of the field on either width, and `inputMode="decimal"` gives a phone the numeric keypad.
The card containers, the postal field and the button are untouched.

## The gate

`node "app/(client-portal)/portal-part-payment-verify.ts"` — **175 checks**, driving the real
`chargePortalPayment`, `preparePortalPayment` and the real 3D Secure handle sealing through a fixture whose
transport records the amount the adapter actually sends:

- **the vocabulary**: the field name, the two shared rule strings (against STEP 124's own constants), the page's
  two own rule names, the floor read from config (`20.0000` = `200000`), the printed form and its round trip;
- **the limits**: a hundred dollar remainder (ceiling 100.0000, floor 20.0000, choice offered), exactly at the
  floor and below it (no choice), just above it (choice), a settled document (nothing), a currency with no floor
  (no choice);
- **the amount**: absent = the whole remainder; `50.00` = a part that leaves 50; `20`/`20.0000` = the floor
  accepted; `100` = the whole, not a partial; surrounding space trimmed; a fifteen dollar remainder payable whole
  below the floor but not `10.00` in part and not `20.00`;
- **fourteen refusals** in the order a payer acts on them - over the ceiling by one minor unit, far over, under
  the floor by one minor unit, a fraction of a cent, zero twice, empty, spaces, letters, an exponent, a comma, a
  negative, a fifth decimal, a sub-cent amount - each naming the field and the rule;
- **whose number it is**: an unwritable *remainder* is `CONFLICT` in STEP 183's rule, an unwritable *choice* is
  `VALIDATION_FAILED`;
- **the body**: the field taken out and trimmed, the rest left with STEP 183's two keys, an absent field not a
  failure, a non-object body not a failure, and five bad values refused (a JSON number, null, an object, a value
  past the ceiling, and a card number - refused by the card-data rule);
- **the page**: a `50.00` part is charged for `50.00` (gateway, record, chain and `part_payment: true`), no
  amount still charges `100.00`, a `75.00` part on a `75.00` remainder settles it, `120.00` and `10.00` and
  `50.0050` are refused with **no gateway call and no record**, an amount beside a card number is still
  `card_data_refused`, and an unwritable remainder is still a conflict;
- **the 3D Secure handle**: a sealed claim carries the *chosen* part and its invoice, and opens again;
- **the sentences**: three distinct sentences, no unfilled placeholder, the ceiling's sentence saying nothing was
  charged, the rule table and the hint's interpolation;
- **the sources**: one parser, one splitter, one resolution, resolved before the payment operation, the 3D
  Secure step splitting and re-checking, the form sending one field name and offering it only when legal, the
  floor read from STEP 181's folding, and **no write to `invoices.amount_paid_minor`** in either file.

Mutation-checked: removing the ceiling check **and** the floor check fails the gate with **14 problems**,
including *"a payer who names more than the invoice owes is refused (nothing was thrown)"*, *"and the gateway is
never asked (expected 0, got 1)"* and *"and no payment record is opened (expected 0, got 1)"* - money moving past
the ceiling. Restored; the gate back to 175.

## Two previous gates

- **STEP 183's** gate asserted the form holds exactly one `<input>` - STEP 185's postal code. STEP 189's amount is
  the second, so that one assertion was restated as what it has always meant: *the form's two inputs are the
  portal's own facts (the postal code and the amount), named for them and typed `text`*, beside the existing and
  unchanged assertions that no card field is an input and that the three containers are the provider's. Nothing
  was weakened: a card input would still fail three assertions.
- **STEP 184's** gate expected an unwritable remainder to answer `CONFLICT` - preserved deliberately (see "whose
  number it is"), and its stale-document scenario still refuses, because a remaining that fell below the chosen
  amount is a document that moved.

Both gates pass unchanged in count: 196 and 271.

## What is genuinely unfinished

1. **The `$0.20` database floor** still sits under the `$20.00` rule (STEP 124's finding). A database STEP that
   touches `0022`'s successors should carry `invoices_partial_minimum_check` up to `200000`.
2. **The ledger does not yet know about parts.** This page records a `payments` row; the invoice's balance moves
   through STEP 132's ledger sync. Until the durable recorder of STEP 130/132 is wired into
   `portal-payment-runtime.ts`, the runtime still says `durable: false` and the page refuses to charge at all -
   the same honest gap STEP 183 documented, and the reason the part-payment flow is proven in the gate rather
   than in a browser.
3. **A part payment has no UI on the invoice page.** The invoice page prints the remaining and the floor; only the
   pay page offers the choice. A later portal STEP may surface it on the document itself.

## Verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | compiled; `/i/[token]/pay/charge` still dynamic (`ƒ`) |
| `node "app/(client-portal)/portal-part-payment-verify.ts"` | **175 checks** |
| `node "app/(client-portal)/portal-payment-verify.ts"` | 196 checks |
| `node "app/(client-portal)/portal-three-ds-verify.ts"` | 271 checks |
| `node "app/(client-portal)/portal-velocity-verify.ts"` | 204 checks |
| `node "app/(client-portal)/portal-blacklist-verify.ts"` | 208 checks |
| `node "app/(client-portal)/portal-fraud-verify.ts"` | 267 checks |
| `node "app/(client-portal)/portal-billing-match-verify.ts"` | 148 checks |
| `node "app/(client-portal)/portal-invoice-verify.ts"` / `portal-estimate-verify.ts` | 155 / 232 checks |
| `npm run check:i18n` | 2677 messages, 296 placeholders, 1 locale (was 2670 / 294) |
| `npm run check:structure` | 661 source files (was 658) |
| `npm run check:audit` | 3694 checks (was 3673) |
| `npm run check:migrations` | 3572 checks, 122 migrations, 92 tables |
| `npm run check:config` | 10 sections, 32 values |
| `npm run check:errors` / `check:lint` / `check:env` | 202 / 77 / 16 checks |

## Left for the STEPs after this one

- STEP 190: the general payment link, the hosted checkout page, and the merchant's token revoke/reissue controls.
- The durable recorder and key store (`portal-payment-runtime.ts`) that turn the page on for real clients.
