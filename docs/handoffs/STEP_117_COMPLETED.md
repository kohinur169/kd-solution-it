# STEP 117 — Invoice PDF generation as a background job

**Status: complete.** `FEATURE_LIST.md` §16 line 173 names *"PDF invoice generation"*; §28 line 295 fixes the
terms it is built on: *"PDF generation, email, webhook processing and sub-merchant provisioning run as
background jobs. Request handlers validate, write minimal rows and enqueue."* This STEP is both halves: a PDF
writer that adds **no dependency**, and a request handler that does nothing but validate, write one row and
enqueue. It is also the platform's **first real job** — until now `lib/jobs/` had a registry, a queue and a
worker with nothing registered on them (`registerJob` had zero production callers).

## STEP

- Number and title: STEP 117 — Invoice PDF generation as a background job
- Category: Business STEPs 106-126
- Depends on: STEP 011 (`lib/jobs/` queue, worker, registry — read, **not** modified), STEP 012 (the jobs
  queue tables), STEP 100-105 (`lib/storage/`: adapter interface, AES-256-GCM sealing, the file record
  service, and the `invoice_pdf` upload purpose which already existed — read, **not** modified), STEP 112
  (`0022` invoices and lines), STEP 114 (the integer totals that are printed), STEP 115 (`0114` numbering: an
  invoice with no number prints a `DRAFT` watermark instead of a number), STEP 039 (the disclosure table,
  which is why a CSRF failure here is `VALIDATION_FAILED` and never `PERMISSION_DENIED`). Handoffs 112, 114
  and 115 read; 011 and 100-105 read for the contracts they publish.

## Files

- **Created:**
  - `migrations/0115_invoice_documents.sql` + `.down.sql` — the document row, its RLS and its state guard.
  - `services/invoices/invoice-pdf.ts` — the writer. PDF 1.4, US Letter 612×792, the two base Helvetica
    fonts, `deflateSync` streams, a byte-exact xref table, money printed from integer minor units only.
  - `services/invoices/invoice-pdf-state.ts` — the state vocabulary alone (the four row statuses, the
    `"none"` state, `InvoicePdfState`). **Imports nothing**, because the browser imports it.
  - `services/invoices/invoice-pdf-document.ts` — the service: request and enqueue, the job handler that
    claims, renders, seals and uploads, the state read, the bytes read, the storage key, the three audits.
  - `app/api/invoices/[id]/pdf/route.ts` — `POST` (ask for a render → `202`) and `GET` (read the state).
  - `app/api/invoices/[id]/pdf/download/route.ts` — `GET`, the decrypted bytes as an attachment.
  - `app/(dashboard)/invoices/invoice-pdf-panel.tsx` — the client panel: ask, check again, download, and the
    sentence that says which of five states the document is in.
- **Modified:** `app/(dashboard)/invoices/invoice-screens.tsx` (reads the state beside the invoice and renders
  the panel), `lib/security/csrf.ts` (+1 path `/api/invoices/[id]/pdf`: 59 → **60**),
  `lib/i18n/strings/en.ts` (+56 messages: 2017 → **2073**, +8 placeholders: 227 → **235**),
  `lib/auth/verify.ts` (the two counts this STEP moves — browser-mutation files 40 → **41**, call sites
  48 → **49** — and the one-door fix in *Verification* below), `services/invoices/verify.ts` (the gate:
  631 → **1024** checks).
- **Owned paths touched:** `services/invoices/**`, `app/api/invoices/**`, the invoice components under
  `app/(dashboard)/invoices/**`, and this STEP's own migration — matching *"Business STEPs 106-126 own
  services/clients/, services/products/, services/invoices/ and invoice components."* `lib/security/csrf.ts`,
  `lib/i18n/strings/en.ts` and `lib/auth/verify.ts` belong to other STEPs and are edited on the precedent
  STEP 115 set: a new browser-facing POST must be on the protected list, its sentences must exist in `en`,
  and the auth gate counts both.

## Database

- Migrations added: `0115_invoice_documents.sql` (+ `.down.sql`).
- **Rollback verified on a clean database: no — and it must not be reported as yes.** This sandbox has no
  PostgreSQL and no Docker, so the migration has never been executed. What `npm run check:migrations` proves
  statically, at **3379 checks / 115 migrations / 88 tables**: numbering contiguous, the `.down.sql` pairing
  present, both files `begin;` … `commit;` and ASCII only, the forward file never `drop table`/`truncate`/
  `delete from`, the new table carries `id`/`company_id`/`created_at`/`updated_at`/`deleted_at`/`version`
  with a UUID v7 default, RLS enabled with a default-deny policy in the same file, and the rollback drops the
  table then the function. **It still has to be run against PostgreSQL, forward and back, before this ships.**

### One row per invoice, and the state lives in the row

`invoice_documents` holds **one live row per invoice** — a partial unique index on `invoice_id where
deleted_at is null` — plus `unique (id, company_id)` and a composite foreign key to `invoices (id,
company_id)`, so a document can never point at another merchant's invoice even by accident of two ids. RLS is
`using (false)` / `with check (false)`: the service reaches the table through the service-role client and
scopes every query by hand, exactly as the invoice tables do.

| Column group | Columns | Why |
| --- | --- | --- |
| Identity | `id`, `company_id`, `invoice_id`, `document_type` (`'invoice_pdf'`) | immutable; the guard refuses any change |
| Progress | `status`, `generation`, `attempts`, `job_id` | `queued → rendering → ready \| failed`, `failed → queued` |
| The four file facts | `file_id`, `byte_size`, `content_sha256`, `rendered_at` | written **only** on the transition into `ready` |
| Diagnosis | `last_error_code`, `requested_by`, `queued_at` | a code, never a provider message |

`byte_size between 1 and 26214400` is a column check; the index is `(status, queued_at)` because the worker
asks exactly that question.

### Why the guard is a trigger and not a column check

One invariant moved during this STEP, and the move matters. `rendered_at >= queued_at` written as a column
check makes **re-rendering illegal**: a merchant asking for a second PDF re-queues a row whose `rendered_at`
is still the first render's, which is earlier than the new `queued_at`, and Postgres refuses a legitimate
request. The invariant now lives in `invoice_documents_guard_state()` and is asserted **only on the
transition that arrives at `ready`** — where it means what it says: a document cannot claim to have been
drawn before it was asked for. The same trigger also enforces: identity immutable; `attempts` never
decreases; the four file facts change only when arriving at `ready`; `generation` rises only into `ready`; a
fresh request clears `attempts` and `last_error_code`; and the walk `queued→rendering|failed`,
`rendering→ready|failed`, `failed→queued|rendering`, `ready→queued`. There is deliberately **no**
`queued→ready` edge — a document that was never claimed was never drawn.

## Environment

- Environment variables added to `.env.example`: **none**. The service reads only variables that already
  exist (`STORAGE_PROVIDER`, the `S3_*` set, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `ENCRYPTION_MASTER_KEY`) through `lib/storage/`'s own constructors.
- Secrets handled (names only, never values): `ENCRYPTION_MASTER_KEY` reaches the bytes only through
  `createFileEncryption`, and the storage adapter credentials only through `lib/storage`'s adapters. Nothing
  new is read from `process.env` directly, and the failure audit records an **error code only** — a provider
  message can carry a URL with a signature in it, so it never reaches the audit trail or a response.

## Packages

- **None requested.** No `pdfkit`, no `puppeteer`, no `@react-pdf/*`: `package.json` is integrator-owned and
  is **unchanged** by this STEP. The writer is hand-rolled on `node:buffer`, `node:crypto` and `node:zlib`,
  which keeps a headless Chromium out of a Vercel/Netlify function (§28's whole point) and keeps the output
  byte-reproducible — the gate asserts xref offsets and a trailer `/ID`, which a library that embeds a
  timestamp in every object would make impossible.

## Behaviour Proof (acceptance checklist)

### The behaviours in the title, exercised in the gate (1024 checks)

| Behaviour | Proof |
| --- | --- |
| It is a **PDF** | The gate reads the bytes back with its own reader: `%PDF-1.4` header, every xref entry a 20-byte `000000000n 65535 f`-shaped record whose offset really lands on its `N 0 obj`, the trailer `/ID` equal to the sha256 of everything before `startxref`, streams that inflate, and the drawn text extracted from the content stream and compared word for word. |
| **Generation** | `INV-00042` for "Acme Ltd", two lines `2.5 @ $125.00` and `1 @ $99.00 − $5.00`: line totals `312.50` and `94.00`, subtotal `406.50`, discount `50.81`, tax `35.57`, **total `391.26`**. Unit prices that are not whole cents print four decimals; `2.500` prints as `2.5`. `/CreationDate` is `D:20261104090000Z` and the footer says `Generated 2026-11-04 09:00 UTC`, `Page 1 of 1`. |
| Integer money | Minor units are 1/10 000 of a dollar throughout; `centsOf` rounds **half away from zero**; nothing but the coordinate formatter `points()` calls `Math.round`, and the gate now proves that is the only rounding in the file. A 2 × "10" harness prints `20.00`, not `200.00`. |
| **As a background job** | The request returns with the row still `queued` and the store untouched. A **real** `JobWorker` over a real `InMemoryJobQueue` then claims it, and the gate asserts the walk it left behind: `rendering` with `attempts: 1` and a `job_id`, then `ready` with a `generation`, the four file facts, sealed bytes in the adapter, a `files` row marked verified, and the previous file archived. |
| It retries | The clock is **not** frozen (`let clock = NOW` + `advance(ms)`), so a failing render is observed going to `retrying` with a backoff and then to `failed` with `last_error_code` set and a code-only audit entry — and the handler rethrows, which is what lets the worker own the retry. |
| It does not double-render | The idempotency key is `invoice.pdf.render:{documentId}:{documentVersion}`. A second request while `queued` returns `deduplicated: true` and enqueues nothing; a request that arrives after a competing write is detected by `writeLanded` (not by version equality) and re-enqueues with the **re-read** version. |
| A draft is visibly a draft | With `number: null` every page carries a 76pt bold 45° `DRAFT` stamp and the number line prints `Not issued yet`. |
| The ceiling holds | A document over `INVOICE_PDF_MAXIMUM_BYTES` (26 214 400) is refused as `PAYLOAD_TOO_LARGE` **before** upload, and `validateUpload(…, "invoice_pdf")` runs on the way in as well. |
| The download is the document | `readInvoicePdfBytes` refuses a non-`ready` row with `RESOURCE_NOT_FOUND / pdf_not_ready`, refuses a file whose purpose is not `invoice_pdf` with `PERMISSION_DENIED`, and refuses a length or sha256 mismatch with `INTERNAL_ERROR / content_mismatch` — so a truncated or substituted object is never served. |
| Cross-tenant | Every read and write is scoped `id=eq.…&company_id=eq.…`; a stranger's invoice is a `404`, and a storage key that does not belong to the invoice or the company raises `PERMISSION_DENIED` (`assertInvoicePdfKeyForInvoice`). |

### Five defects found and fixed, each proved by disabling the fix

1. **The job was never claimable.** `InMemoryJobQueue.enqueue` stamps `availableAtEpochMs` with `Date.now()`
   unless `options.now` is given, while the worker reserves with the **injected** clock — with a gate clock
   set in the past the job was available in the future forever, and the worker reported `ran: false`. The
   service now forwards the caller's clock into `enqueueJob`. This is not a gate artefact: any deployment
   that injects a clock would have hit it.
2. **Stale detection compared versions.** `after.version === row.version` cannot tell "my write landed" from
   "a competing write landed", so a lost race looked like success and the render was silently skipped.
   Replaced by `writeLanded(row, values)`, which compares each written column through `sameWire`.
3. **`rendered_at >= queued_at` as a column check made re-rendering illegal** (see *Database* above).
4. **The panel pulled the server into the browser.** It imported a constant from
   `services/invoices/invoice-pdf-document.ts`, which transitively imports `node:zlib`, the file encryption
   and both storage adapters — i.e. the master-key code path would have been in the client bundle. The pure
   vocabulary moved to `invoice-pdf-state.ts` and the gate now enforces an **allowlist of the panel's import
   specifiers**: importing the service or the renderer from a client file fails the gate.
5. **A dead escape branch and a wrong expectation of mine.** `invoicePdfLiteral` had an octal-escape path
   that `encodeByte` can never reach (everything outside the printable/CP1252 sets already becomes `0x3f`,
   so a control byte legitimately arrives as `?`); it was removed rather than left as decoration. And two
   assertions I first wrote were scoped too widely — one blamed the whole renderer for the one legitimate
   `Math.round`, one compared CSRF ordering across two different route handlers — both narrowed to the slice
   that actually carries the rule.

### UI checks

Responsive read from classes (no headless browser in this sandbox): the panel is one column on a phone and
`sm:flex-row sm:items-start sm:justify-between` from `sm` up, with the controls **wrapping rather than
shrinking** so "Download the PDF" is never a truncated tap target at 360px. Keyboard: the section is
`aria-labelledby="invoice-pdf-title"`, the state sentence is `role="status"`, a failure is `role="alert"`,
and every control carries `focus-visible:ring-2 focus-visible:ring-primary` with `disabled:opacity-40` while
a request is in flight. Light and dark: theme tokens only (`border`, `foreground`, `muted`, `primary`,
`primary-foreground`, `destructive`) — no literal colour, which `check:shell` enforces. **The panel never
polls**: §28 put the work in a job, so the honest interface is a state and a "Check again" button, and a
merchant who walks away comes back to a ready document instead of a page that was still loading. The
download is a plain anchor, not a form — it is a `GET` of the merchant's own document.

### API checks (production build, `next start` on port 3117)

| Case | Answer |
| --- | --- |
| POST `/api/invoices/{id}/pdf`, no CSRF cookie or header | `422` `VALIDATION_FAILED {field:"csrf", rule:"csrf_token_invalid"}` |
| POST, valid double submit (`__Host-kd_csrf` + `x-csrf-token`), no session | `401` `AUTHENTICATION_REQUIRED` |
| GET `/api/invoices/{id}/pdf`, no session | `401` `AUTHENTICATION_REQUIRED` |
| GET, **no CSRF token at all**, no session | `401` — so the read deliberately requires no token and still requires a session |
| GET `/api/invoices/{id}/pdf/download`, no session | `401` `AUTHENTICATION_REQUIRED` |
| DELETE on the request route / POST on the download route | `405`, empty body |

All six were observed over real HTTP with `.env.example` placeholders and **no database reachable**, which is
itself the proof of the ordering §39 and §28 require: CSRF costs a string comparison, the session is next,
and a forged or anonymous request never reaches a query. The server logged exactly four structured
`request rejected` warnings with `requestId`, `method`, `route`, `code` and `status` — no stack, no secret.

| Case that needs a database | Proof |
| --- | --- |
| Success (`202` + the state it wrote) | Gate: `requestInvoicePdf` returns `deduplicated: false` with a `queued` row and an `invoice.pdf.requested` audit; the worker then produces the `ready` row above. Not exercised over HTTP — there is no PostgreSQL here. |
| Cross-tenant read and write | Gate (`404` for the scoped miss, `PERMISSION_DENIED` for a foreign storage key). Not exercisable over HTTP without two merchants' sessions. |
| Download bytes | Gate: the decrypted bytes equal the rendered bytes, length and sha256 re-checked. |
| Id too long | Route checks `1..64` after the session; gate-proven, not HTTP-probed (the probe would need a session first). |

**Money flow ledger proof:** not applicable — a PDF is a document. No ledger entry is posted and no amount
changes; the printed totals are **derived from `0022`'s integer columns** and never recomputed from floats.

**Provider sandbox cycle:** not applicable — no external provider is touched. Storage runs against the gate's
in-memory adapter here; a real Supabase or S3 cycle is a deployment task, not a code gap.

## Verification

- Typecheck `npx tsc --noEmit` — **0 errors**. Lint `npm run lint` — **0 problems**. `npm run build` — clean,
  with `/api/invoices/[id]/pdf` and `/api/invoices/[id]/pdf/download` both registered as **dynamic**
  (confirmed in `.next/app-path-routes-manifest.json`).
- Gates, all green: invoice **1024** (was 631), auth **2728 checks / 0 problems**, migrations **3379 / 115 /
  88** (was 3347 / 114 / 87), i18n **2073 / 235 / 1**, structure **413** source files (was 407), storage
  **433**, jobs **110**, env **16**, config **10 / 28**, logger **117 / 15 / 4 / 9**, errors **202 / 15**,
  lint-rules **77 / 26 / 11 / 1**, shell **706 / 206**, CSRF paths **60** (was 59; STEP 115's handoff
  recorded 60, so its count was off by one — the true previous value is 59), auth browser-mutation files
  **41** / call sites **49** (was 40 / 48).
- **The STEP-115 inherited miss is fixed, not retained.** `lib/auth/verify.ts`'s one-door check — the list of
  modules allowed to dial out — failed on `lib/storage/http.ts` from STEP 105 onward, and STEP 115's handoff
  recorded it as a baseline. A permanently red gate is worse than the gap it reports, because it teaches the
  next chat to ignore red. The list now names all four doors (`auth/device-proof-store.ts`, `auth/http.ts`,
  `security/csrf-client.ts`, `storage/http.ts`) **and** eight new assertions hold `storage/http.ts` to the
  guarantees that earned it a place: `checkOutboundUrl(url, policy)` before `fetchImpl(decision.target.url`,
  `redirect: "error"`, `AbortSignal.timeout(`, the canonical `decision.target.url` as the dialled URL,
  `outboundPolicy({ projectUrl, extraHosts, allowLoopback })`, loopback only when `nodeEnv !== "production"`,
  and no `logger` import. The auth gate is at **0 problems** for the first time since STEP 105.

## Next

- **Next STEP number: 118** — Merchant logo and invoice branding settings applied to PDF.
- **The next chat must know:**
  1. **The migration is unproven against a real database.** Run `0115` and its rollback on clean PostgreSQL
     and record the transcript, including the guard's refusals. Nothing else in this STEP is outstanding.
  2. **Nothing calls the render yet.** STEP 116 (status workflow) does not exist in this repository, so no
     code path asks for a PDF when an invoice is issued. When STEP 116 lands, the issue path must take the
     number (STEP 115) **and then** call `requestInvoicePdf` — in that order, because a document rendered
     before the number exists is a `DRAFT`. Until then the only caller is the merchant's button.
  3. **No durable worker exists.** `JobWorker.start()` has **zero callers**; the route runs one job with
     `after(… runOnce())`, so a render happens when a request triggers it and only one job per request. A
     deployment STEP must own a long-lived worker process (and its health check, §249). Do not add a second
     scheduling mechanism inside `services/invoices/`.
  4. **The writer draws text only.** There is no image XObject support, and the fonts are the base-14
     Helvetica pair with `WinAnsiEncoding` — no embedding. STEP 118's merchant logo therefore needs new
     machinery in `invoice-pdf.ts`: an `/XObject` dictionary with `Do` in the content stream, and a decision
     between a JPEG (`DCTDecode`) and a flattened RGB bitmap (`FlateDecode`). A brand *font* would need real
     font embedding or a path-drawn wordmark; it cannot be "typed". Keep the xref arithmetic exact — the gate
     checks every offset.
  5. **Do not import a service module into a client file.** The vocabulary lives in
     `services/invoices/invoice-pdf-state.ts` for exactly that reason, and the gate enforces an allowlist on
     the panel's import specifiers. `invoice-pdf-document.ts` transitively imports `node:zlib`, the file
     encryption and both storage adapters.
  6. Storage needs no new purpose: `UPLOAD_POLICIES.invoice_pdf` (`application/pdf`, 26 214 400) already
     existed, and keys are `${companyId}/invoice_pdf/${invoiceId}/${uuid}.pdf`. A new render **archives** the
     superseded file rather than deleting it, tolerantly — an archive failure must not fail a good render.
  7. The idempotency key is deliberately `invoice.pdf.render:{documentId}:{documentVersion}`, **not** the
     invoice id: a re-request that bumps the row version is a new intent and must enqueue. Do not simplify it.
  8. `readPdfPanelState` falls back to the `"none"` state with `version: null` when the state cannot be read,
     so a deployment that has not run `0115` still renders the invoice editor instead of failing the page.
     The panel then opens saying it does not know, and the first button press finds out.
