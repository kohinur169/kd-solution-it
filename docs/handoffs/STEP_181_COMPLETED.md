// path: docs/handoffs/STEP_181_COMPLETED.md
# STEP 181 — Tokenized invoice page with paid state, receipt and buyer delivery/service-acceptance confirmation

**Status: COMPLETED**

## STEP

- Number and title: STEP 181 — Tokenized invoice page with paid state, receipt and buyer
  delivery/service-acceptance confirmation.
- Category: Client Portal, Payment Pages and Payment Links, STEPs 181-190, the first STEP of the block.
  STEP 182 builds the estimate link, STEP 183 the hosted payment page, and this STEP builds the page those
  two sit beside and the evidence a release waits for.
- Depends on: `docs/final/FEATURE_LIST.md` section 16 (“once an invoice is fully paid through its
  tokenized link, that link no longer accepts payment; opening it shows the paid state and the receipt”,
  “a partly paid invoice accepts only the remainder”, “minimum partial payment 20 USD”, USD only, “a paid
  invoice is locked”), section 18 (a settlement is released only when the platform holds fulfilment
  evidence) and section 22 line 242 (IP based rate limiting on the surfaces that decide something);
  `docs/final/STEP_PLAN_250.md:2325-2336`; STEP 037's CSRF pair and `/api/auth/csrf`, STEP 039's
  `readRequestActor`, STEP 055's counter table, STEP 056's token module (`lib/security/portal-token.ts`),
  STEP 023's `migrations/0022_invoices.sql` and `0023_invoice_items.sql`, STEP 024's `0037_payments.sql`,
  STEP 026's `0041_ledger_entries.sql` (`ledger_entries_sync_invoice`), STEP 022's
  `0027_estimate_signatures.sql` (the evidence shape and its append-only guard, which this STEP mirrors
  for an invoice), STEP 106's `INVOICE_MANAGE_ROLES` and `orderDocumentDetails`, and STEP 121's
  `mintPaymentLink` (`/i/{token}`, 22 character token id).

## Owned paths, and the ones that stay shut

Owned and used: `app/(client-portal)/`, `components/payments/`, and the append-only migration this STEP's
own feature needs, per `docs/final/STEP_PLAN_250.md:108` and `:120`.

- `migrations/0122_invoice_fulfilment_evidence.sql` — new, 485 lines. The two evidence tables, their
  indexes, their three guard triggers, the release question and the default-deny policies.
- `migrations/0122_invoice_fulfilment_evidence.down.sql` — new, 23 lines, the exact inverse.
- `app/(client-portal)/portal-invoice-fields.ts` — new, 360 lines. The vocabulary: five client states from
  seven, the payable states, the receipt's counted statuses, fulfilment kinds and methods, the statement
  each kind asks for, the limits, the patterns, the rules, the audit actions, the release blockers.
- `app/(client-portal)/portal-invoice-money.ts` — new, 61 lines. Money and quantity printing at the
  column's own scale, browser safe so a client component can import it.
- `app/(client-portal)/portal-invoice.ts` — new, 634 lines. The read model: token to view in five scoped
  reads, the state fold, the payable amount and its floor, the receipt, the release question and the
  canonical document digest.
- `app/(client-portal)/portal-invoice-evidence.ts` — new, 671 lines. The two writes and their parsers.
- `app/(client-portal)/portal-invoice-rate-limit.ts` — new, 186 lines. The confirmation's own counter.
- `app/(client-portal)/portal-invoice-runtime.ts` — new, 88 lines. The production wiring and the optional
  actor read.
- `app/(client-portal)/portal-invoice-verify.ts` — new, 1272 lines, the gate, **155 checks**.
- `app/(client-portal)/i/[token]/page.tsx` — new, 434 lines. The page.
- `app/(client-portal)/i/[token]/acceptance/route.ts` — new, 137 lines. The buyer's confirmation.
- `app/(client-portal)/i/[token]/fulfilment/route.ts` — new, 116 lines. The merchant's delivery record.
- `components/payments/invoice-paid-state.tsx` — new, 231 lines. Paid state and receipt.
- `components/payments/invoice-acceptance-card.tsx` / `invoice-acceptance-form.tsx` — new, 110 + 180
  lines. The buyer's section and its form.
- `components/payments/invoice-fulfilment-card.tsx` / `invoice-fulfilment-form.tsx` — new, 57 + 266 lines.
  The merchant's section and its form.
- `components/payments/portal-form-refusal.ts` — new, 101 lines. One rule to one sentence, for both forms.
- `lib/i18n/strings/en.ts` — extended with the `portal` group only (no existing key changed).
- `app/(client-portal)/README.md` — extended with what this STEP built.
- `docs/handoffs/STEP_181_COMPLETED.md` — this file.

Untouched, deliberately: `services/` (its invoice and estimate services are read, never edited),
`lib/auth/`, `lib/security/`, `lib/errors/`, `lib/i18n/messages.ts`, `app/(dashboard)/`, `app/api/`,
`components/` outside `components/payments/`, `package.json` (so the gate is not on the `verify` chain —
see “Not Run”), `config/` and every shipped migration.

## Database

**`0122`, an append-only migration with its rollback, because section 16 and 18 need evidence that does
not exist yet.** The inventory was checked first: `invoices` carries the money and the status but
`invoices_guard_paid()` freezes a paid row, so no fulfilment can be written onto it; `payments` is the
processor's record and not the delivery's; `invoice_events` is the merchant's timeline with a closed type
vocabulary; `estimate_signatures` is a quote's evidence and points at `estimates`. The next unused number
was 0121 (STEP 180), so this one is 0122.

| Object | Why it is needed |
|---|---|
| `public.invoice_fulfilment_evidence` | One live row per invoice: `kind` (`delivery` / `service`), `method` from a closed list of six, `occurred_at` (never after `recorded_at`), an optional reference and description, and the merchant account that recorded it. |
| `public.invoice_acceptances` | One row per invoice, append-only: the statement, the buyer's name and address, the consent wording and the box (forced true), the instant, `ip inet`, optional place and fingerprint, the browser string and the document digest. Composite foreign keys to `invoices (id, company_id)` and `invoice_fulfilment_evidence (id, company_id)`. |
| `invoice_fulfilment_evidence_guard()` + trigger | Refuses removal, refuses any change to the identity of a record, refuses to bring a replaced record back, and refuses to rewrite a record once a confirmation points at it. |
| `invoice_acceptances_guard_append_only()` + trigger | Refuses every update and every removal, exactly as `0027` does for a signature. |
| `invoice_acceptances_guard_evidence()` + trigger | On insert: refuses an invoice that does not exist in that company, a cancelled invoice, an invoice holding no money, evidence that is not the live record of that invoice, and a statement that contradicts the evidence kind. |
| `invoice_release_evidence_ok(uuid, uuid)` | The one question a release asks: paid, delivered or performed, confirmed with consent. Section 18's “payout remains blocked until valid evidence is recorded”, expressed once so no two release paths can disagree. |
| `invoice_fulfilment_evidence_live_key`, `invoice_acceptances_invoice_key` | One live record per invoice; one confirmation per invoice. A correction replaces rather than stacks. |
| RLS + `*_default_deny` | Every table in this repository carries its own default-deny policy in the file that creates it. |

**Rollback proof.** `0122_invoice_fulfilment_evidence.down.sql` drops the two tables and the four
functions this file created, in the reverse order of their dependencies, and touches no other object:
`invoices`, `invoice_items` and `payments` are exactly as they were, because this STEP appended evidence
beside them and never wrote onto them. `npm run check:migrations` reads both files and passes (**3572
checks, 122 migrations, 92 tables**), including its static rules: numbering contiguous, forward file
transactional, no `drop table` / `truncate` / `delete from` in a forward file, every created table
default-deny, and a rollback that drops exactly the tables its forward file creates.

**A transcript on PostgreSQL is owed.** This environment has no database, so the apply-and-rollback run is
not claimed: the migration is asserted from its text, from the static gate, and from the in-memory model
the gate below builds. The shipped definitions it references (`0022`, `0023`, `0037`, `0041`, `0027`) were
read from the completed migrations rather than guessed.

## Environment

No variable is added. `portal-invoice-runtime.ts` reuses the platform's rest client, audit trail and
`ENCRYPTION_MASTER_KEY` derived portal key ring (`masterKey()`), so a link minted by STEP 121 verifies here
without a second secret.

## Packages

None. `package.json` is unchanged — including the `verify` chain, which is why this STEP's gate is run by
hand (below). The STEP plan's file-ownership rules put root configuration and `package.json` with STEPs
001-011, so the gate was not added to the chain rather than editing another STEP's file.

## Behaviour Proof (acceptance checklist)

| Requirement | Evidence |
|---|---|
| A tokenized link opens the invoice with no login | `openPortalInvoice` reads the token through `openPortalToken` (signature, clock, kind and capability) and then five tenant-scoped reads. The gate proves a paid view end to end, proves every one of the five reads carries `company_id=eq.`, and proves a token naming another company finds nothing. |
| A fully paid link shows the paid state and the receipt | `portalInvoiceStateOf` folds `0022`'s seven statuses onto five; the paid view yields `paid`, no payable amount, `receipt.receivedMinor` equal to the invoice's own `amount_paid_minor`, and a refunded and net figure summed from the counted rows. The page renders the paid banner and the receipt card at both widths. |
| A fully paid link accepts no further payment | `portalPaymentViewOf` answers `open: false` with **no amount at all** for `paid` and for `void`, and the page prints the sentence that says so. The gate proves both. |
| A partly paid link accepts only the remainder | The gate proves `amountMinor = "600000"` against a 100.0000 invoice holding 40.0000, and that `release.blockers` names `invoice_not_paid`. |
| Minimum partial payment is 20 USD | `portalMinimumPartialMinor` reads `appConfig.money.minimumPartialPayment` (the same configuration `recordInvoicePayment` uses) and answers the remainder itself when the remainder is at or below the floor. Four cases proven: 100.0000 → 20.0000, 15.0000 → 15.0000, 20.0000 → 20.0000, 0 → nothing. `invoices_partial_minimum_check` and `ledger_entries_sync_invoice` hold the same floor in SQL. |
| USD only | The minimum is refused for a currency the platform cannot price, and every amount is printed with the invoice's own currency code. Money never becomes a float: `bigint` inside, exact decimal text on the view, `priceFromMinor` for the print. |
| A paid invoice is locked | Nothing in this STEP writes onto `invoices`. The page reads `paid_at`, `amount_paid_minor` and the receipt; the gate asserts the migration contains no `update public.invoices` and no `update public.payments`. |
| Fulfilment evidence is recorded by the merchant | `recordPortalInvoiceFulfilment` needs `INVOICE_MANAGE_ROLES` (owner), the actor's company, and the token's own company. Refusals proven: another company's owner, a member who may read invoices, a future instant, a method outside its kind, a correction after the buyer confirmed. A correction soft-deletes and re-inserts under the version it read. |
| The buyer confirms delivery or service acceptance | `capturePortalInvoiceAcceptance` recomputes the statement from the live evidence, computes the digest on the server, and stores the consent sentence read from the catalog. Refusals proven: an unpaid invoice, a cancelled one, an already confirmed one, a statement that contradicts the evidence, a stale evidence id, an unticked box, a body that brings its own `document_hash`. |
| The confirmation is evidence, not a form field | Append-only by trigger; one row per invoice; `ip inet` from the request, the browser string, the optional device fingerprint, and the document digest. The audit entry carries the digest, the statement and the evidence id — never the buyer's name, address or fingerprint. |
| The digest is the document the buyer saw | `portalInvoiceDocumentHashOf` = SHA-256 over a canonical encoding of identity, lines and totals. The gate proves it is unchanged when the status, the paid total, the receipt or a timestamp moves, and changed when a line amount or the client name moves. |

## Security verification

- **Validation, both sides.** `portalFulfilmentInputSchema` and `portalAcceptanceInputSchema` are strict
  zod objects, so an unknown key is named (`unknown_field`) rather than dropped; every text is trimmed and
  then measured, and refused rather than repaired when `sanitizeSingleLineText` /
  `sanitizeMultilineText` would change it. `0122` repeats every bound as a check constraint.
- **CSRF.** Both writes call `requireCsrfToken` before reading a body; the portal form gets its token from
  `/api/auth/csrf`, which needs no session. `CSRF_PROTECTED_PATHS` is unchanged, and the STEP 037 gate —
  which counts only `/api/` routes — stays green; `npm run check:audit` separately proves every mutating
  route either resolves an actor or is an explained exemption, and this route resolves the actor whose
  presence is optional (see below).
- **Identity.** A buyer has no account and the link is the credential. The confirmation route still reads
  whatever session the request carries, and the service refuses a session belonging to the invoice's own
  company: a seller cannot confirm their own delivery (`self_confirmation`). Without that read a merchant
  could open their own release gate.
- **Authorization.** The delivery route takes `owner`, the actor's company, and the token's company, and
  refuses unless all three agree; the page shows the delivery card only to the same test.
- **Rate limiting.** The confirmation is counted on `rate_limit_windows` through `consume_rate_limit`
  under its own scope, ten attempts per address per ten minutes, keyed by
  `sha256("portal_acceptance\n" + canonical address)` so the address never reaches the table. A counter
  that cannot answer is `DEPENDENCY_FAILED`, never a pass. The first refusal of a window is audited once.
- **Injection.** No SQL is composed from input: every read and write goes through the rest client's
  parameter-encoded query builder over a fixed column list, and the one `in.(...)` list is a closed
  constant. No `dangerouslySetInnerHTML` anywhere in the new components; every sentence is printed as
  text, and the memo and address are printed as text with `whitespace-pre-line`.
- **SSRF and headers.** Nothing in this STEP fetches a URL. The browser string is trimmed to 400
  characters before it is stored and is never rendered on the page.
- **Disclosure.** A bad signature, an expired token, a revoked token, a soft-deleted invoice and a status
  the fold does not know all answer the same `RESOURCE_NOT_FOUND` and the same sentence; the reason
  travels in `cause` for the log only.
- **Audit.** Three new actions — `portal.invoice_fulfilment_recorded`,
  `portal.invoice_fulfilment_corrected`, `portal.invoice_accepted` — each written once per fact, with the
  facts and the digest but not the buyer's words. A sink that is down never fails the write it records.

## Gates run

| Command | Result |
|---|---|
| `node "app/(client-portal)/portal-invoice-verify.ts"` | **portal invoice gate passed: 155 checks, 7 statuses folded, 2 evidence tables, one confirmation per invoice** |
| `npm run typecheck` | clean (`tsc --noEmit`, strict, no `any`) |
| `npm run lint` | clean (`eslint .`) |
| `npm run build` | compiled; `/i/[token]`, `/i/[token]/acceptance` and `/i/[token]/fulfilment` are dynamic routes |
| `npm run check:migrations` | **3572 checks, 122 migrations, 92 tables** |
| `npm run check:audit` | **3407 checks** |
| `npm run check:structure` | **17 directories, 14 root files, 614 source files** |
| `npm run check:i18n` | **2534 messages, 281 placeholders, 1 locale** |

## Not Run, and why

- **The `verify` chain.** The gate is not on it: `package.json` belongs to STEPs 001-011, and this STEP's
  file-ownership rules forbid editing it. The gate is run by the command in the table above, and the
  README of `app/(client-portal)/` names it for the next STEP.
- **A live page against a database.** This environment has no PostgreSQL and no Supabase project, so the
  page cannot be rendered against real rows and no screenshot is claimed. What was checked instead: the
  build, the gate's in-memory model of the five reads and the two writes, and the layout at its three
  breakpoints by construction — one column with entry cards below `sm` (360px), a table and a three column
  totals row from `sm` up, and `max-w-3xl` with `px-4`/`px-6` padding up to `lg`. Every table on the page
  has a card list beside it rather than horizontal scrolling.
- **`npm install` under the sandbox Node.** The repository pins `engines.node >= 26.13.0` with
  `engine-strict=true`; the sandbox runs Node 22, so installation used
  `npm install --engine-strict=false`. Neither `package.json` nor `.npmrc` was edited.

## Next STEP

STEP 182 — the tokenized estimate page under `e/[token]` — reuses the shape this STEP establishes: the
token vocabulary in `portal-invoice-fields.ts`, the money printer, the optional actor read, the refusal
vocabulary both forms share, and the gate's in-memory PostgREST. What it must **not** reuse is
`invoice_acceptances`: a quote's decision is already `0027`'s table, and a signature has its own guard.
