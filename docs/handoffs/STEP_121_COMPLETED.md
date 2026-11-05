# STEP 121 — Estimate accept conversion to invoice with payment link generation

**Status:** complete. Gate `services/estimates/estimate-conversion-verify.ts` — **147 checks in 11 groups**.
**Plan entry:** `STEP_PLAN_250.md:1526-1541`. **Feature:** `FEATURE_LIST.md:177`.

---

## What this STEP is

`FEATURE_LIST` section 16 line 177: "when an estimate is accepted it converts automatically into an invoice
**and a payment link is generated**." Nothing in the repository did that. `0025` had reserved the column for
it and `lib/security/portal-token.ts` could already sign a link, but no code joined the two.

This STEP adds the conversion service, the migration that makes the conversion recordable at all, and the
gate that proves both — and nothing else. There is no route and no screen, which is deliberate: see
"Scope decisions" below.

---

## The finding this STEP is built on

`0025` has a defect that made its own reserved column unusable, and it is worth stating plainly because the
whole STEP exists in its shadow.

`0025` declares `estimates.converted_invoice_id`, gives it `estimates_invoice_fkey` to `invoices (id)`, states
its pairing in `estimates_conversion_check` (`converted_invoice_id is null or status = 'accepted'`), and adds
`estimates_invoice_key` — a **unique partial index** on the column where it is not null. Its own comment says
the column is "the conversion, written once". Every one of those is the shape of a column meant to be filled.

Then `0025`'s `estimates_guard_terminal` trigger (BEFORE UPDATE) refuses every change to a decided quote:

```sql
if old.status in ('accepted', 'void')
   and (to_jsonb(new) - 'updated_at' - 'version')
       is distinct from (to_jsonb(old) - 'updated_at' - 'version') then
  raise exception 'a decided estimate is locked' using errcode = 'check_violation';
```

`converted_invoice_id` is not excluded. The two rules leave **no reachable state**:

- `estimates_conversion_check` requires `status = 'accepted'` before the column may be non-null;
- `estimates_guard_terminal` forbids writing any column of an `accepted` row except the metadata pair.

So an accepted quote can never record the invoice it became. The feature is unimplementable, not merely
unimplemented, and no later STEP could have fixed it from the outside without encountering the same wall.

**`0118` repairs the trigger, not `0025`.** A shipped migration is a record of what ran; this repository keeps
migrations immutable once pushed. `0118` replaces the function in place with `create or replace`, which keeps
the trigger binding, the search path and the comment, and narrows the exception to exactly one column.

### What the new guard permits, and what it still refuses

The column is added to the two metadata columns in the frozen comparison — and `0118` adds three rules so
"written once" is *true* rather than merely *permitted*:

| Rule | Refuses |
| --- | --- |
| `old.status <> 'accepted'` | converting a **void** quote |
| `old.converted_invoice_id is not null` | a **second** conversion, or replacing the invoice |
| `new.converted_invoice_id is null` | **clearing** a conversion, i.e. detaching the invoice from the quote |

Rule 2 is the important one. A bare exclusion would have made `converted_invoice_id` the single field of a
decided quote any caller could rewrite, and a second request could repoint an accepted offer at a different
invoice. With it, the first writer wins — the same outcome `estimates_invoice_key` already gives a race, and
the same outcome a sequential retry deserves.

Everything else about a decided quote is still frozen, and `estimates_accepted_instant_check`,
`estimates_conversion_check`, `estimates_invoice_key` and all of `invoices` are untouched.

---

## The four writes, and why the order is the order

A conversion is four facts that cannot be written atomically. Each later step compensates the earlier one.

1. **The number is taken first** — `takeInvoiceNumber`, whose own doc says it is "called by the issue path
   (STEP 116)". It had **zero production callers**; this is its first. Taking it first means a later failure
   spends a number that is never printed, which is the safe direction. `0114`'s series advances; that is the
   cost of a retry and it is the correct one, because an invoice row must never exist for a moment without a
   number it could be issued under.
2. **The invoice is created as a draft** through `createInvoice` — the one function that knows what an invoice
   row needs: the client from the book rather than the body, the sanitised name, the due date, and the lines
   in a single insert. It also writes its own compensating removal, so a failing create needs nothing from
   this module.
3. **The invoice is issued in one statement.** `0022`'s `invoices_issue_check` allows a number and an issue
   instant only on a non-`draft` status, so status, number and instant travel together. Writing the number
   first would be refused by the database, because the row would be a draft carrying a number for as long as
   the statements are apart. `invoices_guard_paid` locks only `paid` rows, so draft → sent is permitted.
4. **The quote records the invoice last** — the fact that makes the conversion real. Scoped to
   `status=eq.accepted&converted_invoice_id=is.null`, so two racing requests cannot both succeed even
   independently of the index.

The payment link is minted after all four, because a link to an invoice that does not exist cannot be
honoured. It needs no compensation: a token is a signature, not a row.

### Compensation, both directions

| Failure | Compensation |
| --- | --- |
| The issue update throws | The draft is voided; the quote stays unconverted so a retry can try again. |
| The issue did not land (silent match-nothing) | Re-read proves it; void, then `DEPENDENCY_FAILED`. |
| The conversion record throws | The **issued** invoice is voided; the caller gets `CONFLICT`. |

The last row is a real trap the gate caught. The first version of `voidDraft` scoped its update to
`status=eq.draft` — correct before the issue, useless after it. A PostgREST update scoped to a status the row
is no longer in matches nothing and **still reports success**, so the invoice silently stayed `sent` while the
quote stayed unconverted: an orphaned payable invoice the merchant would find in its book. The fix was to name
the status the row is actually in, which is why `voidInvoice` now takes `fromStatus`. Reproduced as a mutation
before fixing.

---

## The payment link

`lib/security/portal-token.ts` (STEP 056) is **consumed, never edited** — `services/estimates/` does not own
`lib/security/`. Its doctrine, which this STEP follows rather than re-derives:

- a link is **signed, not encrypted** — an invoice id is not a password; the signature stops invention;
- a **lifetime in seconds, never an expiry date**, enforced at mint *and* at read; the clock is always passed in;
- **a link is not stored**. What is left behind is the invoice and the **token id**, which is the name a
  revocation row is found by — which is why the service chooses the id (`randomBytes(16).toString("base64url")`)
  and passes it as `tokenId`: a caller that must later revoke a link has to know its name before it exists;
- `PORTAL_TOKEN_CAPABILITIES_BY_KIND` **refuses** a kind paired with another kind's verb, at mint and at read.

Minted: `kind: "invoice"`, `capability: "pay"`. Not `payment_link` — that is STEP 190's general link, gated on
a merchant plan. An estimate's capability is `sign`, so a payment link for a quote would be refused at the
mint; the gate asserts that pairing is still what the module says.

**The link is opened again immediately** with the expectations it was minted under. The mint is the only place
a wrong kind, a wrong pairing or an out-of-band lifetime could slip through, and a link that cannot be opened
is worse than no link — the merchant would already have sent it.

| Constant | Value | Why |
| --- | --- | --- |
| `ESTIMATE_PAYMENT_LINK_LIFETIME_SECONDS` | `2_592_000` (30 d) | the module's ceiling; the invoice's `due_at` is the deadline, not a second one |
| `ESTIMATE_PAYMENT_LINK_PATH_PREFIX` | `/i/` | section 2: `i/[token]` and `e/[token]`, no login |
| `ESTIMATE_PAYMENT_LINK_ID_BYTES` | `16` | 22 canonical base64url characters, the module's own size |

URL base is `APP_URL` — the manifest's one canonical base, whose own doc names "tokenized client links".
There is no other base-URL variable in the project. Measured: the token is **360 characters** against the
module's 732 ceiling, so a link fits comfortably in an email.

---

## Decisions taken (user-selected, in order)

Three forks were put to the user before any code was written, then one more when the schema wall was found.

1. **Scope — service only.** No route, no UI. Justification: the trigger (a quote becomes *accepted*) arrives
   from STEP 182's tokenized estimate page, so **nothing in production can set `estimates.status='accepted'`
   today** (no `'accepted'` literal exists anywhere in `services/estimates/`). A merchant route would render
   its empty state. The expected caller is STEP 182, calling this function **unchanged**.
2. **Issue — `issued`.** `takeInvoiceNumber`'s first production caller. The user's reason, in the fork's own
   words: otherwise "the link is generated but the client cannot pay until the invoice is issued" — line 177
   would stay half-done.
3. **Due date — the quote's `expires_at`, floored.** A client who accepted an offer valid until the 14th is
   not asked to pay later because the merchant converted it on the 21st. `0022` forbids `due_at < issued_at`
   and `due_at` is NOT NULL, so a quote that expired before conversion is floored at
   `issued_at + 1 day` — never dated in the past.
4. **The guard — migration `0118`.** Offered three options (repair in `0118` / don't record on the quote at
   all / stop and report). User chose `0118`.

### What was deliberately *not* done

- **No `payment_links` / portal-token store table.** The module states a link "is not stored"; a store belongs
  to STEP 190, which owns "revoke and reissue controls". Minting statelessly is the module's own design.
- **No route, no CSRF path, no i18n keys, no UI.** No new user-facing string exists, so `en.ts` is unchanged
  (2253 messages, as before).
- **No relaxation of `0022` or `0025`.** Both files are byte-identical; `0118` replaces one trigger function.
- **`invoice_events` not used.** Its `type` check has no `converted` member, and widening it is a schema
  change with no requirement behind it. The audit entry is the record (rule 9).
- **`createInvoice` not modified.** Reused as-is, so the invoice it writes is the invoice every other STEP
  writes.

---

## Files

| File | Lines | What it is |
| --- | --- | --- |
| `migrations/0118_estimate_conversion_lock.sql` | 103 | `create or replace` of `estimates_guard_terminal`, with the three once-only rules |
| `migrations/0118_estimate_conversion_lock.down.sql` | 43 | restores `0025`'s body verbatim; drops nothing, creates nothing |
| `services/estimates/estimate-conversion-fields.ts` | 132 | vocabulary only — no imports, no `async`, no `throw`, no client |
| `services/estimates/estimate-conversion.ts` | 455 | `convertEstimateToInvoice` and the two compensations |
| `services/estimates/estimate-conversion-verify.ts` | 1 583 | the gate: **147 checks, 11 groups** |
| `package.json` | — | `check:estimates` added, wired into the `verify` chain |

`0025`, `0022`, `0114`, `lib/security/portal-token.ts`, `services/invoices/invoices.ts` and
`services/estimates/estimates.ts` are **unmodified**.

### The service's public surface

```ts
convertEstimateToInvoice(
  input: { actor: RequestActor; estimateId: string },
  dependencies: EstimateConversionDependencies,   // rest, audit, now?, portalTokenKeys, appUrl
): Promise<EstimateConversionSnapshot>             // { estimate, invoice, paymentLink }
```

`EstimatePaymentLink` is `{ token, tokenId, url, expiresAtEpochMs }`. No field of any snapshot is a `bigint` —
JSON cannot carry one — so money crosses as the minor-unit text `InvoiceSnapshot` already uses.

The create body is built from the quote by printing every amount back into the text the create form would
have typed: `priceFromMinor` for money, `basisPointsToPercent` for a percentage. The invoice is therefore
built by **the same parser every other invoice is**, rather than by a second path that could disagree about a
rounding rule. `0026` mirroring `0023` column for column is what makes that a faithful translation.

---

## Verification

Full sweep, all green, nothing excluded:

| Gate | Result |
| --- | --- |
| `services/estimates/estimate-conversion-verify.ts` | **147 checks, 11 groups** |
| `services/estimates/verify.ts` | 1583 checks (unchanged) |
| `services/invoices/verify.ts` | 1442 checks (unchanged) |
| `services/kyc/verify.ts` | 4142 checks |
| `lib/auth` · `lib/security` · `components/office` | 2774 · 2378 · 545 |
| `lib/audit-log` · `settings` · `approvals` · `permissions` | 735 · 551 · 536 · 425 |
| `services/clients` · `services/products` | 520 · 1029 |
| `lib/countries` · `gateways` · `storage` · `announcements` | 467 · 467 · 433 · 351 |
| `lib/errors` · `logger` · `jobs` | 202 · 117 · 110 |
| `migrations/verify.ts` | **3453 checks, 118 migrations, 89 tables** |
| `check:structure` | 17 directories, 14 root files, **443** source files |
| `check:i18n` | 2253 messages, 248 placeholders (unchanged — no new string) |
| `check:shell` · `check:lint` · `check:config` · `check:env` | 759 · 77 · 10 · 16 |
| `typecheck` · `lint` · `build` | 0 · 0 · exit 0 |

### The gate proves failure, not just success

Two mutations were applied to confirm the gate bites, and both were reverted:

1. **Skip the issue** (write the draft and stop): the gate fails with **5 problems**, including
   `conversion threw instead of recording a failure: DEPENDENCY_FAILED` — and every other group still
   reports, which is what `group()` isolation exists for.
2. **Un-repair the guard** (restore `0025`'s comparison): the gate fails with
   `the new guard excludes the conversion column from the frozen comparison, on both sides`.

Mutation 2 initially **passed**, and that is the most valuable thing this STEP learned. The first assertion
was a bare `includes(...)` on the exclusion fragment, which still matched after only the `old` side had been
reverted — the string was present on one side of `is distinct from`. The assertion now spans **both** sides of
the comparison on one exact line pair. A gate that greps a fragment measures the presence of a substring, not
the behaviour of a trigger.

### Two production observations the gate produced

- **`services/clients/clients.ts` reads without `select=`.** `getClient` calls `RestClient.select` with
  `id=eq.…&company_id=eq.…&deleted_at=is.null` and no column list, so PostgREST answers `*`. It is STEP 106's
  code, correct because `clientRowSchema` is a `z.object` that tolerates extra keys, but it is the same shape
  that was a real defect in STEP 120 (`ESTIMATE_SIGNATURE_COLUMNS` lacked the prefix). Recorded, not changed:
  `services/clients/` is not owned here, and `rule 17` ("selected columns only") makes it a candidate for a
  later hardening pass. The fixture models PostgREST's actual behaviour (`*`) rather than inventing a rule.
- **`invoices_guard_paid` locks only `paid`.** Confirmed from `0022:51-68`, which is why the draft → sent
  transition is legal for this STEP and why the compensation can still void an issued invoice.

### What a fixture still cannot see

- **No PostgreSQL.** A forward-and-rollback transcript of `0118` is **owed**. The migration is asserted from
  its SQL text, and the fixture reimplements `to_jsonb` comparison semantics rather than executing them.
- **No headless browser.** No UI was added, so nothing is owed here beyond the standing debt.
- The trigger's real behaviour under a concurrent UPDATE — the fixture serialises everything. The unique
  index is the backstop in production and is asserted from the migration text.

---

## Next

- **STEP 122** (`:1538`) is recurring invoice configuration, the next Business entry.
- **The conversion is unreachable end to end until STEP 182** can accept a quote on the tokenized page.
  `convertEstimateToInvoice` is the function it should call, unchanged.
- **`i/[token]` (STEP 181) is the page a generated link opens.** `app/(client-portal)/` holds only a
  README, so a link minted today resolves to nothing. The URL is correct by design; the page is missing.
- **STEP 116 was never implemented.** This STEP issues an invoice as a side effect of converting; the general
  status workflow (sent → viewed → overdue, void with a reason) is still absent, and `takeInvoiceNumber` now
  has exactly one caller instead of zero.
- **STEP 124/127** own settlement: `invoices_status_money_check` already models `partially_paid` and
  `invoices_partial_minimum_check` enforces the 20 USD floor, but nothing writes those statuses yet.
- **A revocation store is still owed.** `paymentLink.tokenId` is returned precisely so a later STEP can
  record it; `PortalTokenRevocations` is the seam and no implementation exists.
