# STEP 120 — Estimate digital signature capture with evidence record

Chat lines: *"ধাপ STEP 120 সেইম ৩ ভাগে ভাগ করো তারপর ১ম ভাগ শুরু করো"* (split STEP 120 into three parts the way
STEP 119 was split, then start part one); then, asked what STEP 120 is, *"STEP 120 is ONLY 'Estimate digital
signature capture with evidence record.'"*; then, after the missing-prerequisite report, the choice
*`part1_only`*; then *"ভাগ ২ শুরু করো"*; then, asked about part three and about three gates that were found
failing, the choices *`part3_now`* and *`fix_now`*.

Ownership: rule 53 grants STEPs 106‑126 `services/clients`, `services/products` and `services/invoices`;
`config/structure.json` assigns `app/(dashboard)` to "STEP 079‑126" and names estimates. Everything written
here is inside those paths plus `services/estimates`, `app/api/estimates` and the estimate screens. The three
gate files repaired in their own commit are named below, because repairing another module's gate is not
ownership of that module and should be readable as the exception it is.

## What this STEP is, and the four things it was told not to be

`FEATURE_LIST.md:174` requires a digital signature for a client's approval, and `:175` names what the evidence
must hold: *signer name, email, consent checkbox record, time, IP, geo location, device fingerprint, document
hash*. `0027_estimate_signatures.sql` already stores all eight, is tenant-isolated, is append-only, and is
audited through `estimate.signature_recorded` — so **this STEP needed no migration at all**. What it needed was
a service that could write that row honestly, a digest worth storing in it, and a way for a merchant to read it
back.

Four boundaries were set by the user and are enforced by the gate rather than by a comment:

- **No estimate numbering, no counter, no RPC, no generalising `0114`.** `0114_invoice_numbering.sql` is
  invoice-only and was not touched; `take_invoice_number` still has no caller in this build.
- **No issuance.** Nothing here writes `estimates.status`, `number`, `issued_at`, `accepted_at` or
  `voided_at`. The capture *requires* an open quote and never makes one.
- **No invented `sent` or `viewed`.** There is no send workflow, so there is no way for a quote to become open
  in production. This is reported as the missing prerequisite, not worked around.
- **No tokenized client page.** That is STEP 181/182. Consequently there is **no POST capture route**: a
  merchant-authenticated capture would store the merchant's address and agent as the signer's, which is not
  weaker evidence but false evidence. The capture is a service function until a workflow can carry the truth.

What was built instead is the whole of the record's own machinery — the digest that makes it mean something, the
append-only write, the merchant's read, and a panel that shows it — with the one missing input named rather
than faked.

## Files

Created — service (2, 903 lines):

| Path | Lines | What it is |
| --- | --- | --- |
| `services/estimates/estimate-signature-fields.ts` | 162 | The evidence vocabulary: the two decisions, the two statuses that accept one, the nine column limits read out of `0027`, the email and fingerprint shapes, the digest's length and pattern, the seven rules, the two audit names, and one guard. No imports, so a browser file may use it |
| `services/estimates/estimate-signature.ts` | 741 | `hashEstimateDocument`, its canonical encoder, `parseEstimateSignatureCapture`, `captureEstimateSignature`, `readEstimateSignature`, the row schema and the snapshot mapper |

Created — read side (2, 211 lines):

| Path | Lines | What it is |
| --- | --- | --- |
| `app/api/estimates/[id]/signature/route.ts` | 70 | `GET` only: the evidence of one of this merchant's quotes, or `{ status: "read", signature: null }` when nobody has decided |
| `app/(dashboard)/estimates/estimate-signature-panel.tsx` | 141 | The read-only panel: three states, the eight elements, the whole digest, not one control |

Modified (4):

| Path | Change |
| --- | --- |
| `services/estimates/estimates.ts` | 1 017 → 1 028. Two private functions became exports — `estimateSnapshotOf` and `readEstimateLines` — so the digest is built by the same reader and mapper `getEstimate` uses: one fact, one mapper |
| `services/estimates/verify.ts` | 3 443 → 4 920. Three new groups (`checkSignature`, `checkCapture`, `checkEvidence`), the fixture now models `estimate_signatures`, and `READING_ROUTES` names the reader each read route goes through |
| `app/(dashboard)/estimates/estimate-screens.tsx` | 308 → 352. The editor reads the evidence on the server, tolerantly, and renders the panel under the lines |
| `lib/i18n/strings/en.ts` | 2 677 → 2 700. Twenty-one keys in the `estimates` section, all of them used |

Repaired in their own commit (`4d02c67`), because all three failures predate this branch and none is STEP 120's:

| Path | What was wrong |
| --- | --- |
| `lib/security/verify.ts` | Claimed "exactly two modules encrypt anything" but tested it by searching for the string `aes-256-gcm`, which counted `lib/storage`'s two *readers* of the name as writers. It now counts `createCipheriv`/`createDecipheriv` callers, keeps the namers as a claim of their own, and checks that the name storage stores beside a sealed file is the cipher the encryption module runs |
| `components/office/verify.ts` | Claimed one file in the tree names the office roles, but three onboarding routes name `super_admin` in prose. Comments are now stripped before the search |
| `services/kyc/verify.ts` | Pinned the highest migration number at `0111`, which every later STEP moves. It is now a floor, so the claim stays "no migration KYC depends on has gone missing" |

## Database

**No migration was added, and `0027` was not touched.** It already holds the eight elements of `:175` plus
`signature_path`, is `using(false) with check(false)` behind one default-deny policy, is unique on
`(estimate_id)`, carries a composite foreign key to `(estimate_id, company_id)`, and has two triggers:
`estimate_signatures_guard_append_only` (refuses an update and a delete) and
`estimate_signatures_guard_decision` (refuses an insert unless the quote is `sent` or `viewed`).

The gate reads `0027`'s own text rather than trusting a constant: every length limit in the vocabulary is
extracted from the migration's `char_length(...) between N and M` and compared numerically, the email and
fingerprint shapes from its `~ '...'` patterns, the two decisions from its `decision in (...)`, the two open
statuses from its trigger body, and the two audit names from `0013`'s action and entity regexes.

### The fixture models the table, not just the service

`verify.ts` now models `estimate_signatures` the way it models the other three: every column check transcribed
from `0027`, the composite foreign key, and **both triggers** — including the decision trigger reading the
quote rather than the row, which is what makes a capture against a draft fail in the gate the way it fails in
PostgreSQL. A trigger's `raise exception` is mapped to `VALIDATION_FAILED` and a unique violation to
`CONFLICT`, because that is what `lib/auth/rest.ts` actually does: only `23505` or an HTTP 409 is a conflict,
and every other class-23 failure is invalid input. Getting that backwards would have let the service relabel a
closed quote as a taken one.

### The column names are the table's, proved both ways

A fixture mints its rows itself, so it never notices a column name that does not exist: a typo in the read's
column list, or a key in an insert the table does not have, is a statement PostgREST refuses **in production**
and nothing refuses here. That is a whole class of defect the fixture is structurally blind to, so the gate now
reads `0027`'s own `create table` and compares both sides of the service's queries against it:

- the read's 17 columns are all real columns, and all 18 of the table's columns are asked for except
  `deleted_at` — the one column the read filters on rather than reads;
- every key the insert sends is a real column, and so is every key of the stored row, which also pins the
  fixture's own defaults to the real table;
- neither `id` nor `version` is sent, because both are the column's default and an append-only row never
  moves off version one.

Both claims were **failure-probed** rather than trusted: renaming `signer_name` to `signed_by` in the column
list fails the gate with *"the read asks for "signed_by", a column `0027` actually has"*, and adding an
invented `signer_ip` to the insert payload fails it twice, once for the payload and once for the stored row.

Looking for that blind spot found a real one. `ESTIMATE_SIGNATURE_COLUMNS` was written as a bare
`id,company_id,...` list, while every other column list in this family is built as `` `select=${[...]}` `` —
and `RestClient.select` puts its second argument straight after the `?`, so the evidence reads would have
asked PostgREST for **no column list at all** and received the whole row instead of the seventeen named
columns. Nothing in the gate could see it: the fixture answers from its own rows and only ever parses the
filters. It is fixed, the evidence list now joins the shared invariant that already covered the quote's and a
line's list, and one further assertion reads the **query the service actually sent** rather than the constant
— the string the fixture records is the string the real client would send, so it is the honest place to look.
Dropping the prefix now fails the gate in ten places, two of them those.

## Environment

No new variable. `ENCRYPTION_MASTER_KEY` and the rest are untouched; the evidence table needs no secret of its
own. `.env.local` was created from `.env.example` with `NODE_ENV=production` for the build and the probes, and
deleted afterwards.

## Packages

None added or changed. `package.json` is the integrator's and no STEP from 117 to 120 has touched it. The
digest uses `node:crypto`'s `createHash("sha256")`, which the platform already depends on.

## Behaviour Proof (acceptance checklist)

### The document hash (part one)

The field selection is one sentence: *every stored fact about the offer, in one canonical representation,
excluding the document's lifecycle and excluding any second spelling of a fact already present.*

- **In** (44 fields for a three-line quote): the ids, the currency, the three client snapshot columns, the
  expiry, the memo, the line count, then per line in position order its position, description, unit, quantity
  in thousandths, unit price, line discount, line total and its two catalogue ids, then the five totals and the
  two discount-basis columns.
- **Out**: `number`, `status`, `void_reason`, `issued_at`, `accepted_at`, `voided_at`,
  `converted_invoice_id`, `version`, both epochs, a line's own id and version, and every printed form.
- Three consequences the gate proves: excluding `number` makes the digest computable on a draft and **stable
  across issuing** (the gate issues the quote and re-hashes it); excluding printed forms means `"2.5"` and
  `"2.500"` hash identically, because every amount is re-expressed in its stored unit; excluding a line's id
  means removing and re-adding an identical line is the same offer.
- The encoding is self-delimiting — `name:tag:byteLength:value`, tags `N`/`S`/`I`, lengths counted in bytes by
  `TextEncoder` — and starts with its own version string, so a future change to the field selection cannot
  silently match a stored row. A decoder in the gate walks the bytes back and recovers all 44 names, tags and
  values.
- Adversarial cases: a pair of snapshots crafted to be equal under a naive `join("|")` differ here; a memo
  forged to read `total_minor:I:1:0` still leaves exactly one `total_minor` in the encoding.
- The golden digest of the gate's literal fixture quote is
  `559832bb2f137d1d9eb44f0bd5e25dea30f6b5bd4cee70dde57a208c6d7965ba`, pinned so a change to the field
  selection or the encoding fails loudly.
- **Documented limit:** this is the digest of the *offer*, not of a rendered PDF. No estimate PDF exists in
  this build (STEP 117's writer draws invoices). Byte-level provenance needs that render first, and it must
  arrive as a **second digest with its own meaning**, never as a quiet change to this one.

### The capture (part two)

- Eight elements written, in one insert, with the digest computed by the service and never accepted from a
  caller: the schema is `.strict()`, so a body offering `document_hash` is refused with `unknown_field` on
  `document_hash`. So are `status` and `signed_at` — the instant is the platform's clock.
- **Evidence is refused, never repaired.** Seventeen element-level refusals are asserted one by one: a name
  too short, too long or holding a line break; an address too short, too long or not an address; a consent of
  nothing, too long, or one the column would store trimmed; an address that is not one, that carries a port,
  or that is empty; a place too long; a fingerprint too short, too long or holding a space; a storage key too
  long. Surrounding space *is* trimmed, because that changes no meaning. The one normalised value is the user
  agent, which is not one of the eight: it never reaches the evidence row, and it is cut to the audit chain's
  own `AUDIT_MAXIMUM_USER_AGENT_LENGTH` so the entry is never one the chain would refuse — a refusal there is
  swallowed by `appendTolerated`, and a signature with no chain link is a weaker record.
- Three reads in a proved order — is this quote open, has it been decided, what does it offer — then one
  insert, then one audit entry. The gate asserts the order because checking "already decided" before reading
  the lines is the cheaper order.
- A draft, an accepted and a void quote each refuse with `status`/`already_changed`, write nothing, attempt no
  insert and earn no audit entry. `viewed` accepts exactly as `sent` does.
- After a successful capture the quote row is byte-for-byte what it was: still `sent`, still `Q-2026-0001`,
  `accepted_at` null, `converted_invoice_id` null, version unmoved. A `declined` decision is stored as
  `declined` and **voids nothing** — turning a declined quote void is STEP 182's, and creating the invoice is
  STEP 121's.
- One decision per quote: a second signer meets `estimate_id`/`already_used` and the first row is untouched; a
  racing unique violation is worded the same way rather than passed through bare.
- An unknown quote and another merchant's quote are both `RESOURCE_NOT_FOUND` with `cause.reason`
  `not_found` — never a 403 and never somebody else's document.
- **No actor.** The signer is a client and rule 14 says clients use tokenized links only, so there is no
  session and no role to check. The audit entry carries `actorUserId: null` with the merchant's `companyId`
  and the *signer's* address and agent, and its payload holds field facts and the digest only: the gate
  asserts the chain contains no signer name, no email, no place and no fingerprint, because personal data
  belongs in the one table section 16 built for it.
- `canonicalRateLimitAddress` canonicalises the address, which is the same function `buildAuditEntry` uses, so
  the evidence row and the audit entry spell one address one way — proved with an IPv6 address that arrives as
  `2001:0DB8:0000::0001` and is stored as `2001:db8::1` in both.
- The snapshot deliberately carries **no `version`**: an append-only row offers no optimistic lock, and
  printing one invites an edit the trigger refuses. A decision outside the two is `INTERNAL_ERROR` on
  `decision`, because guessing which one a signer made would be a lie.

### The read side (part three)

- `GET /api/estimates/{id}/signature` answers 200 with `signature: null` for an undecided quote, because
  undecided is the normal state of a quote and not a missing resource; a quote that is not there, or that
  belongs to another merchant, is a 404 about the quote.
- It is a read: no CSRF token, no audit entry, no log line, `no-store`, and the company from the session and
  never from the path, the query or a header.
- The panel has **three** states, and the third is the point: "no signature yet", the record, and "the
  evidence could not be read". Collapsing the last into the first is how an outage becomes a merchant
  believing a client's decision was lost — and believing it in a dispute.
- It is read-only in fact, not in comment: the gate asserts no `<button`, `<form`, `<input`, `<select`,
  `<textarea`, `useState`, `onClick` and no `fetch(`, and that the panel is not a client component at all.
- All eight elements are printed, the digest whole and never truncated, wrapped in a monospace face rather
  than cut to fit a column; an element that was not captured is named "Not recorded" rather than left blank;
  and a stored signature image is named in a sentence without printing its storage key.
- The screen reads the evidence on the server (so the session's scope never travels to the browser) and never
  fetches its own route.

### Gate

`npx --yes tsx services/estimates/verify.ts` — **1 572 checks in 16 groups**, run twice for stability:
`checkVocabulary, checkCreate, checkDiscount, checkValidation, checkConflict, checkTenancy, checkBoundaries,
checkLines, checkRoutes, checkCompensation, checkSources, checkSignature, checkCapture, checkUi,
checkEvidence, checkMigration`.

### API checks (production build, `next start` on port 3125)

| Probe | Answer |
| --- | --- |
| `GET /api/estimates/{uuid}/signature`, no session | `401` with `{"error":{"code":"AUTHENTICATION_REQUIRED","message":"Sign in to continue.",...,"retryable":false}}` and `cache-control: no-store, max-age=0` |
| The same with a percent-encoded id | `401` — the decode path does not turn a spelling into a crash |
| `POST` to the same path | `405` — the route exports no mutation, and the server says so |
| `GET /estimates/{uuid}`, no session | `200`, 16 439 bytes, the signed-out sentence, and **no trace of the panel**: a signed-out visitor is shown no evidence |

### Panel render checks (`renderToStaticMarkup`, in-repo probe, removed after the run)

A source assertion cannot catch a `getMessage` key that does not exist at runtime, so the panel was rendered
in five states and the HTML read: `none`, `recorded`, `recorded` with a stored image, `declined` with two
absent elements, and `unreadable`. **41 checks, all passing** — including that the whole 64-character digest
appears, that `2026-11-05T12:34:56.000Z` prints as `2026-11-05 12:34:56`, that the outage state is an
`role="alert"` and never borrows the absence sentence, that a declined record words a refusal and names both
absent elements, and that a stored image is named without its key.

## Verification

| Gate | Result |
| --- | --- |
| `services/estimates` | 1 572 checks, 16 groups |
| `services/invoices` | 1 442 checks |
| `lib/auth` | 2 774 checks |
| `migrations` | 3 433 checks, 117 migrations, 89 tables |
| `lib/security` | 2 378 checks (repaired) |
| `components/office` | 545 checks (repaired) |
| `services/kyc` | 4 142 checks (repaired) |
| `services/clients` · `services/products` | 520 · 1 029 checks |
| `lib/audit-log` · `lib/announcements` · `lib/approvals` | 735 · 351 · 536 checks |
| `lib/countries` · `lib/gateways` · `lib/permissions` · `lib/settings` | 467 · 467 · 425 · 551 checks |
| `lib/storage` · `lib/logger` · `lib/jobs` · `lib/errors` · `config` | 433 · 117 · 110 · 202 · 10 sections |
| `scripts/verify-structure.mjs` | 17 directories, 14 root files, **440** source files |
| `scripts/verify-shell.mjs` | 759 checks, 225 files, no colour literal |
| `scripts/verify-lint-rules.mjs` | 77 checks, 26 rules, 11 failure probes fired |
| `lib/i18n` | **2 253** messages, 248 placeholders, 1 locale |
| `npm run typecheck` · `npm run lint` | 0 · 0 |
| `npm run build` | exit 0; `/api/estimates/[id]/signature` in the route list |

Commits: `f3e5037` (parts one and two), `4d02c67` (the three gate repairs), and the part-three commit that
adds the route, the panel, the screen wiring, the copy and this file.

## Next

**STEP 121 — Estimate to invoice conversion with payment link.** It is the natural reader of this record: an
accepted signature is the fact that authorises the conversion, and `converted_invoice_id` is already a column
on the quote.

The prerequisite that blocks the capture's *production* use, stated once and not worked around:

1. **Nothing can make a quote open.** `0027`'s trigger requires `sent` or `viewed`, and no send workflow
   exists (STEP 116 in the plan, never implemented). Until one does, `captureEstimateSignature` has no
   reachable caller, and the panel will truthfully show "no signature has been recorded" for every quote.
2. **No token, so no capture route.** STEP 181/182 issue the tokenized client link. The route that records a
   decision must be authenticated by that token and must take the signer's address and agent from *their*
   request. Building it merchant-authenticated would store false evidence, so it was not built.
3. **The digest is the offer's, not a PDF's.** If an estimate PDF is ever rendered, its byte digest is a
   second column with a second name. Do not reuse this one.

Standing debts carried forward, unchanged: no PostgreSQL or Docker in this sandbox, so every migration claim
here is static (read out of the SQL text) and a real forward-plus-rollback transcript is still owed; and no
headless browser, so nothing was ever clicked — the `curl` probes and the `renderToStaticMarkup` probe above
are the substitute on offer, and a signed-in render of `/estimates/{id}` showing a real evidence row is still
owed to whoever has credentials.
