# STEP 118 — Merchant logo and invoice branding settings applied to PDF

An invoice now carries the merchant's own mark and their own words: a logo, a name chosen between the
trading and the legal one, a tagline, an address, contact details, a tax id line, a closing note and one
accent colour. A merchant sets all of it on one screen, it is stored in one row, and the PDF writer that
STEP 117 built draws it. Nothing about an invoice's money, numbering or status changed, and an invoice
whose merchant never opened the screen prints exactly as it did before.

## STEP

`docs/final/FEATURE_LIST.md` line 184: *"Merchants can set their own logo and invoice branding."*

Three boundaries decided what this STEP does not touch. The platform's own logo (lines 19 and 258) is a
different asset belonging to the operator, and it is not drawn here. Branding is an owner-scope setting
(line 25), so the screen and both routes answer an owner of the company and nobody else. And the storage
category already exists: STEP 105 built `company_logo` in `lib/storage/branding.ts`, sealed and signed like
every other upload, so this STEP reuses it rather than inventing a second place for a merchant's picture.

## Files

Owned by this STEP under the File Ownership Rules (line 53: Business STEPs 106-126 own
`services/invoices/` and the invoice components).

New:

- `migrations/0116_invoice_branding.sql` and `.down.sql` — one row per company.
- `services/invoices/invoice-pdf-image.ts` (686 lines) — the PNG and JPEG reader the writer needed.
- `services/invoices/invoice-branding.ts` (1025 lines) — read, parse, save, upload, and the print bundle.
- `app/api/invoices/branding/route.ts` — `GET` the settings, `POST` a save.
- `app/api/invoices/branding/logo/route.ts` — `POST` a multipart logo upload.
- `app/(dashboard)/invoices/branding/page.tsx` and `branding-form.tsx` (739 lines) — the screen.

Modified:

- `services/invoices/invoice-pdf.ts` (+385) — the header became two columns, and the writer learned to draw
  an image, a colour and a closing note.
- `services/invoices/invoice-pdf-document.ts` (+12) — `readPrintableInvoice` now fills `branding`.
- `app/(dashboard)/invoices/invoice-screens.tsx` (+84) — `InvoiceBrandingScreen`, and a link to it from the
  invoice editor.
- `services/invoices/verify.ts` (+2150) — the gate: image fixtures, three new check functions.

Three files outside the invoice area had to change, and each for a reason that is not convenience:

- `lib/security/csrf.ts` (+2) — the protected-path list is the platform's, and a new mutating route that is
  not on it is a hole rather than a feature. It now holds 62 paths.
- `lib/i18n/strings/en.ts` (+47 keys) — every sentence on the screen and in a refusal is catalog copy.
- `lib/auth/verify.ts` (+9/-2) — that gate counts browser files that mutate and their call sites. The
  branding form is the first screen to send two kinds of mutation from one page, a JSON save and a multipart
  upload, so the counts moved to 42 files and 51 sites.

## Database

`public.invoice_branding`, one row per company, and the columns are the merchant's choices rather than a
copy of their profile:

`logo_file_id` (nullable, `references public.files (id)`), `show_logo`, `name_style` (`'trading'` or
`'legal'`), `show_address`, `show_contact`, `show_tax_id`, `show_website`, `tagline` (null, or 1 to 120
trimmed characters), `footer_note` (null, or 1 to 300 trimmed), `accent_colour` (null, or
`~ '^#[0-9a-f]{6}$'`), `version` (`> 0`), plus the platform's row metadata.

### The logo is a pointer, not bytes

The picture stays in object storage sealed with the merchant's own key, with a `files` row of purpose
`company_logo` recording its hash, its size and whether the platform verified it. The branding row says
*which* of those files prints. Two things follow. Switching back to an earlier logo is a settings change and
not a re-upload. And a rendered PDF is an object in storage, not a view of this row, so invoices already
sent keep the branding they were drawn with.

The name, the address and the contact details are deliberately *not* columns here. They live in
`business_profiles` and `companies`, where onboarding put them and where a merchant edits them. Duplicating
a fact is a way of promising two answers to one question, so the print path reads the profile at render time
and this row only says which parts of it to show.

### Guards

`unique (company_id)` makes a save an upsert and a second row impossible. `unique (id, company_id)` is the
tenant key every scoped update is filtered by. `invoice_branding_guard_identity()` is a `before update`
trigger, `set search_path = ''`, that refuses a row changing its own id or company: a branding row that
moved company would print one merchant's logo on another merchant's invoice, and no caller is trusted with
that. `invoice_branding_set_row_metadata` is the platform's metadata trigger. Row level security is on with
`invoice_branding_default_deny (using (false) with check (false))`, so a connection that is not the
platform's own sees no row.

### Rollback

`0116_invoice_branding.down.sql` drops the policy, then the two triggers, then the table, then the function
that only its trigger used — the reverse of the forward order, because each belongs to the thing dropped
after it. It touches neither `files` nor `business_profiles`: a merchant's uploaded logos stay in storage
under their own keys with their own records, and their profile facts stay as they were. What a rollback
removes is the ability to say which of them an invoice prints.

There is no PostgreSQL and no Docker in this sandbox, so the migration is proved statically: the migrations
gate reports 3411 checks over 116 files and 89 tables, with every forward file transactional and
default-deny, and it is the gate that checks the rollback's ordering rather than a human reading it.

## Environment

Nothing new. The logo rides STEP 105's storage configuration — provider, bucket, `ENCRYPTION_MASTER_KEY`,
and the signed-URL ceiling — and the render path reuses STEP 117's `invoicePdfDependencies()` singleton
rather than minting a second storage runtime for the same process.

## Packages

None. The writer had to answer three questions about a merchant's picture — can it be drawn at all, what
are its dimensions, and what are its samples — and a reader that answers only those is smaller than the
review of a new dependency, which is the trade this repository makes every time.

What it deliberately does not do: no interlaced PNG, no progressive or arithmetic-coded JPEG, no WebP, and
no 16-bit output. Each of those is a refusal with a reason, not a crash and not a silent blank box.

## Behaviour Proof (acceptance checklist)

### The behaviours in the title, exercised in the gate (1442 checks)

`node services/invoices/verify.ts` builds real PNGs and JPEG marker streams by hand — `zlib.crc32`,
`deflateSync`, and the chunk and marker layouts from the specifications — and reads the rendered PDFs back
through the hand-rolled reader STEP 117 added, inflating each content stream to look at the operators
themselves.

- **A logo is drawn.** A 4×2 PNG arrives as `/q 4 0 0 2 54 694 cm /Im1 Do Q` inside a page whose resources
  name `/Im1`, with an image XObject of `/DeviceRGB`, `/BitsPerComponent 8` and `/FlateDecode` over the
  decoded samples. Object numbering is `6 + 2 × pageCount` for the image and the next for its mask.
- **A logo is never upscaled.** A 288×88 picture is drawn at 144×44 — `min(144/w, 44/h, 1)` — because a
  merchant's blurry logo enlarged is worse than the same logo small.
- **Transparency is real.** An RGBA logo carries a second object, an `/DeviceGray` `/SMask`, and a logo whose
  alpha channel is entirely 255 carries none, because a mask that says "all opaque" is 4 KB of nothing.
- **A JPEG is passed through.** Baseline 8-bit, 1 or 3 components, `/DCTDecode`, the file's own bytes after
  trimming anything past `FFD9`: re-encoding a photograph the merchant uploaded would be a second
  generation of loss for no gain.
- **Grey, indexed, 1-, 2-, 4- and 8-bit, `tRNS` in all three forms, split `IDAT`, and the `Up` and `Paeth`
  filters** all decode to the samples the specification says they mean. A 4-bit indexed row `[0x10, 0x32]`
  yields palette entries 1, 0, 3, 2; a Paeth row `[10,20,30,15,25,35]` over `[1..6]` at three bytes per
  pixel yields `11,22,33,26,47,68`.
- **Eleven PNG refusals and four JPEG refusals** each answer `VALIDATION_FAILED` with
  `{field: "logo", rule: "file_not_acceptable"}` and a `cause.reason` naming which one — `not_an_image`,
  `unsupported_bit_depth`, `interlaced`, `unsupported_jpeg`, `too_many_pixels`, `malformed`. A merchant is
  told their file cannot print; an invoice is never drawn with a hole in it.
- **The words are the merchant's.** The header's left column is the logo, then the name in bold, then a
  wrapped tagline, then the address and contact details wrapped at 240 points. The right column is the
  title, the number and the status, right-aligned, exactly as STEP 117 drew them.
- **Each toggle does one thing.** `show_address` off drops the address lines and nothing else; `show_contact`
  off drops email, phone, website and the tax id line, because all four are contact; `show_tax_id` and
  `show_website` each put one line back; `name_style` picks the trading name and falls back to the legal one
  and then to whatever the company is called, and the other way round for `'legal'`.
- **One accent rule.** `#1f4e79` reaches the page as `0.12 0.31 0.47 RG` — three fractions of one, because
  that is what a PDF colour is — and it colours the rule under the letterhead. It appears once in the whole
  document. The rules inside the table stay grey, and the accent is never a fill, so it can never be the
  colour of a sentence a client has to read. A malformed accent draws the default grey rather than failing
  an invoice.
- **A closing note** is drawn after the memo, full width, on the last page only, wrapped rather than run off
  the edge; the part beyond 300 characters is cut, as every other text field is.
- **No branding is not a broken invoice.** A source with no logo, no tagline, no accent and no note produces
  the same layout and the same rule colours STEP 117 produced, and the same bytes for the same input: two
  renders of one document are byte-identical, which is what makes a rendered PDF a record.
- **A save is an upsert under an optimistic lock.** The first save inserts and audits; the second updates
  scoped to `id`, `company_id` and the version it read; a stale version answers
  `CONFLICT {field: "version", rule: "stale"}`, which is a field a form can point at. The audit records that
  a tagline and a note *exist* and not what they say, because an audit trail is read by more people than the
  settings screen is.
- **An upload is stored, verified, inspected, then adopted.** A PNG is sealed, marked verified, proved
  drawable, and written into the row with `show_logo` on. A WebP is stored and verified and then refused for
  print, and the merchant is told: the file is theirs, it simply cannot be drawn. Bytes declared `image/png`
  that sniff as JPEG are quarantined by the platform's own upload gate and never adopted. A file over the
  2 MiB policy ceiling is refused before it is read.
- **Tenancy.** An owner of one company reading another company's branding gets that company's defaults, not
  its row; a non-owner role is refused; the print path takes a company id and reads the row through the
  platform's scoped REST, so there is no path by which one merchant's logo reaches another's document.
- **The print path refuses honestly.** A logo that is pending or quarantined, a record whose purpose is not
  `company_logo`, a storage key that does not belong to the company, and bytes whose hash does not match
  their own record each answer with their own code — `CONFLICT`, `PERMISSION_DENIED`, `PERMISSION_DENIED`,
  `INTERNAL_ERROR` — rather than drawing an invoice with a picture missing from it.

### Seven defects found and fixed

1. **STEP 117 shipped a wrong label.** `drawHeader` printed the status line with `labels.numberLabel`, so a
   sent invoice read "Invoice number: Sent". It now reads `Status: Sent`. Found while splitting the header
   into two columns; fixed here and pinned by the gate, which asserts both lines separately.
2. **The documentation promised two accent rules.** Seven places — the renderer's module doc, two type docs,
   two function docs, the migration header and a catalog hint — said the accent coloured the header rule and
   the one above the table. Only the header rule takes it. All seven now say one rule under the letterhead,
   and the gate counts the accent's appearances in the document rather than trusting the prose.
3. **A lost race looked like a win.** The save re-read the row and compared versions: if the version had
   moved, the write must have landed. That is wrong, because whoever won the race moved it too. It now
   compares the values it sent against the row it read back (`writeLanded`), which is the check
   `invoice-pdf-document.ts` already makes for the same reason. The gate's race fixture — a second owner
   writing between this call's read and its write — fails against version comparison and passes against
   value comparison. A REST update that matched nothing still reports success, so the row read back is the
   only place a lost race is visible at all.
4. **A colour literal under `app/`.** The accent picker needs a value to open on, and `#1f4e79` in the form
   is exactly what STEP 003's shell gate refuses — correctly, because nothing in a screen should decide a
   colour. The default is now `INVOICE_BRANDING_DEFAULT_ACCENT` in the service, where it is data that goes
   into a `char(7)` column, and the screen hands it to the form as a prop.
5. **The first draft of the service was wrong about four library types**: `FileRecord` has no `file_name`;
   `SealedFile` exposes `envelope` and not `bytes`; one inspection call passed the same expression down both
   branches of a ternary; and two divergent write paths existed where one `writeRow` does. All four were
   caught by reading the libraries' own types before running anything, which is why the file was rewritten
   rather than patched.
6. **The decoder had three defects** the probe scripts found before the gate did: a palette index outside the
   palette was accepted instead of refused; an 8-bit mask was applied to 16-bit samples, corrupting them; and
   an alpha channel of all 255 produced a pointless mask object. The first two are correctness, the third is
   4 KB on every opaque logo.
7. **The screen offered an action that always fails.** The "print the newest logo" button appeared whenever
   the newest stored file was not the adopted one — including when the newest was a WebP, which the writer
   refuses. The save would have caught it (it re-proves printability whenever a logo is newly chosen or
   switched on), so no invoice could break, but a merchant would have been offered a button that ends in a
   refusal. The button now appears only for a file that can print, and the note beside it says why the
   newest one cannot.

### UI checks

There is no headless browser in this sandbox, so nothing here was clicked. The screen was proved three other
ways instead: by reading the classes it renders, by fetching the built page from a production server and
reading the HTML that came back, and by rendering the form itself with `react-dom/server` against four
snapshots built by hand.

- **Widths.** The layout is one column by default and two from `sm` up (`sm:grid-cols-2`, `sm:flex-row`), so
  a phone gets a single stack and a desktop gets the logo beside the settings. The preview panel and the
  logo box both sit inside `min-w-0` columns, which is what stops a long trading name from widening the page
  on a narrow screen.
- **The logo is fitted, never cropped:** `max-h-full max-w-full object-contain`.
- **Keyboard and names.** Every control is a real `input`, `select`, `button` or `textarea` with a `label`
  `htmlFor` it, so tab order, focus rings and accessible names come from the platform's form elements rather
  than from a `div` with an `onClick`. The two forms are siblings, so a merchant can tab from the file input
  to the upload button to the settings and back without leaving the keyboard.
- **Themes.** The screen holds no colour of its own — the shell gate scans 210 files under `app/` and
  `components/` for a colour literal or a palette step and finds none — so light and dark are the theme's
  business, and the one colour on the page that is not a token is the merchant's own logo.
- **States are announced.** A refusal is `role="alert"`, an upload's progress and result are `role="status"`,
  and both are catalog sentences.
- **The form, rendered directly in four states.** A signed-out page renders the refusal and not the form, so
  the form was rendered on its own: with a newer printable logo the "print the newest logo" button is offered;
  with a newer WebP it is not, while the screen still names the format and still renders every setting; with
  no newer logo, and with the newest already being the adopted one, it is not. That is the seventh defect
  below proved by the markup rather than by reading the condition it depends on.
- **The live render, signed out:** `GET /invoices/branding` answered `200` with the title "Invoice branding",
  the description "Your logo and your own details on the PDF a client receives.", and the alert "Sign in with
  a merchant account to write an invoice." The HTML contained no stack, no `AppError` and no internal name.
  A signed-out merchant sees one sentence, which is the house pattern for these screens: the page renders and
  says what is missing rather than redirecting or throwing.

### API checks (production build, `next start` on port 3118)

| Request | Answered | Why |
| --- | --- | --- |
| `GET /api/invoices/branding`, no session | `401 AUTHENTICATION_REQUIRED` | "Sign in to continue." |
| `POST /api/invoices/branding`, no token | `422 VALIDATION_FAILED` | `{field: "csrf"}` |
| `POST /api/invoices/branding`, valid token, no session | `401 AUTHENTICATION_REQUIRED` | the token passed, the session did not |
| `POST /api/invoices/branding`, cookie and header disagreeing | `422 VALIDATION_FAILED` | the double-submit pair must match |
| `POST /api/invoices/branding`, valid token, 9 KB body | `413 PAYLOAD_TOO_LARGE` | the declared length is checked before the session is read |
| `POST /api/invoices/branding/logo`, no token | `422 VALIDATION_FAILED` | `{field: "csrf"}` |
| `POST /api/invoices/branding/logo`, valid token, no session | `401 AUTHENTICATION_REQUIRED` | |
| `PUT /api/invoices/branding` | `405` | the route answers two methods |
| `GET /api/invoices/branding/logo` | `405` | an upload is not a read |
| `DELETE /api/invoices/branding/logo` | `405` | a logo is replaced or hidden, never deleted from here |
| `GET /invoices/branding`, signed out | `200` | the screen with one sentence in it |

Every one of these produced exactly one structured log line — a `warn` for a rejection with its code and
status, and no stack, no body and no merchant detail in the response.

Two things about this sandbox, stated plainly. `GET /api/auth/csrf` answers `502 DEPENDENCY_FAILED` here,
because minting a token is rate limited and the rate-limit store needs a database this sandbox does not
have; that is the platform failing honestly, not this STEP. The tokens above were therefore minted locally
against the scheme the server verifies — 43 base64url characters, sent as both the cookie and the header,
compared in constant time — so the probes exercise the real check. And a *successful* save or upload, and a
cross-tenant attempt, cannot be exercised live without a session: both are proved in the gate against the
fake REST, where the cross-tenant case is an owner of one company reading another's branding and getting
defaults rather than a row.

## Verification

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `npm run lint` | clean |
| `npm run build` | clean; `/invoices/branding`, `/api/invoices/branding`, `/api/invoices/branding/logo` all registered dynamic, and re-run after the last change to the form |
| `node services/invoices/verify.ts` | **1442 checks** (STEP 117 ended at 1024) |
| `node lib/auth/verify.ts` | 2741 checks, 42 browser files mutating across 51 call sites |
| `node lib/storage/verify.ts` | 433 checks |
| `npm run check:migrations` | 3411 checks, 116 migrations, 89 tables |
| `npm run check:i18n` | 2120 messages, 238 placeholders, 1 locale |
| `npm run check:structure` | 17 directories, 419 source files |
| `npm run check:shell` | 719 checks, 210 files, no colour literal, no palette step |
| `npm run check:errors` | 202 checks, 15 codes, no secret or stack in any envelope |
| `npm run check:logger` | 117 checks, 9 secret fragments absent |
| `npm run check:lint` | 77 checks, 26 rules as errors, 11 failure probes fired |
| `npm run check:jobs` | 110 checks |
| `npm run check:config` / `check:env` | 10 sections, 28 values / 16 manifest variables |

One commit, `STEP 118: Merchant logo and invoice branding settings applied to PDF`, 16 files, +5870/-37.

## Next

- **The render is still not driven by a durable worker.** STEP 117's note stands: `JobWorker.start()` has no
  caller and the route uses `after(… runOnce())`. Branding reaches that render through one call,
  `readInvoicePrintBranding({companyId}, dependencies)`, which returns the words and the logo bytes together
  or throws; whoever builds the worker does not need to know how a logo is stored.
- **WebP is a policy the writer does not share.** `UPLOAD_POLICIES.company_logo` accepts png, jpeg and webp;
  the PDF writer accepts png and jpeg, because a WebP's payload is a VP8 video frame and decoding one is a
  codec, not a reader. So a WebP is stored, verified, shown to the merchant as their newest file, marked not
  printable, and never offered for adoption. If the platform wants WebP logos on invoices it needs a
  transcode step at upload or a decoder in the writer; either is its own STEP.
- **16-bit samples are normalised to the high byte.** The writer emits `/BitsPerComponent 8`, so a 16-bit PNG
  prints slightly posterised rather than refusing to print. The module doc says so, and the gate pins the
  high bytes (`18,154,17,85,153,221`).
- **The gate's JPEG fixtures are marker streams, not photographs.** They are built as `SOI`, `APP0`, `SOF0`,
  `DHT`, `SOS`, `EOI` with the geometry and component count a real file would carry, which is everything this
  writer reads: it passes a JPEG's bytes through untouched, so there is nothing to decode. They are not
  decodable images, and a later STEP that needs a real photograph in the gate would have to commit a binary
  fixture rather than build one.
- **A second locale** needs the 47 new `invoices.branding*` keys, including the one with a parameter
  (`brandingTaxIdLine`), which `getMessage` refuses to print with the hole in it — the guard that makes a
  placeholder impossible to forget.
- **The accent is one rule by design.** If a merchant asks for more colour, the honest answer is that a
  document a client has to read stays grey, and the accent stays the one line that says whose invoice it is.
