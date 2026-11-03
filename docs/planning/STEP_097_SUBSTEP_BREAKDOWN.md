// path: docs/planning/STEP_097_SUBSTEP_BREAKDOWN.md
# STEP 097 - Extra document request flow from provider to merchant: sub-steps

The STEP is one commit. The order below is the order it was built and verified in, so a later STEP
that touches this area can read which slice owns what.

## 097.1 - The database part: `0109_kyc_document_requests.sql` plus its rollback

- FEATURE_LIST section 5 line 61: "Address verification uploads: utility bill issued within 3
  months, bank statement, source of funds document, and any extra document a processor requests."
  `0049` already carries that last kind as the `processor_request` document type; 0109 stores the
  REQUEST: one row per ask, hanging off the merchant's draft submission through the same composite
  foreign key `0049` uses, with `provider_id` (the processor's adapter key), `document_label` (the
  ask in the provider's own words, 1..120 trimmed), `note` (optional instruction, 1..280 trimmed) and
  a closed status walk `open -> fulfilled | cancelled` with the end states locked by the guard
  trigger. `fulfilled_by` names the `kyc_documents` row that answered, paired with `fulfilled_at`.
- One open ask per (submission, provider, label): the partial unique index
  `kyc_document_requests_open_unique` makes a repeated provider delivery converge on the first row.
  The open index `(company_id, created_at desc) where status='open'` is the merchant's todo list;
  the submission index keeps the history. Guard refuses every delete and soft delete and freezes
  merchant, submission, provider, label and note. RLS default-deny; the app reads through the
  service role key.
- `npm run -s check:migrations`: 3165 -> 3197 checks, **108 -> 109 migrations, 82 -> 83 tables**.
  The rollback file drops the table and the guard function.

## 097.2 - The service (`services/kyc/kyc-capture.ts`, the owner of the 0048-0109 tables)

- Constants: `COMPANIES_TABLE`, `KYC_DOCUMENT_REQUESTS_TABLE`, `KYC_DOCUMENT_REQUEST_ENTITY`,
  `KYC_DOCUMENT_REQUEST_CREATED_AUDIT_ACTION = "kyc_document_request.created"`,
  `KYC_DOCUMENT_REQUEST_FULFILLED_AUDIT_ACTION = "kyc_document_request.fulfilled"`,
  `KYC_DOCUMENT_REQUEST_JOB = "kyc.document_request"`; `documentRequestJobPayloadSchema` =
  `{ company_id: uuid, provider_id: one of PROVIDER_KEYS, document_label: 1..120 trimmed, note?:
  1..280 trimmed }`; `documentRequestIdempotencyKey` = `kyc.document_request:<company>:<provider>:<label>`.
- `createDocumentRequest(input, deps)`: validates before any query; proves the merchant exists
  (404); ensures the draft submission (a system draft carries `submitted_by: null`, which `0048`'s
  check allows for drafts); answers an existing open ask for the same submission + provider + label
  with `created: false` (no insert, no audit); otherwise inserts the `open` row, and a lost insert
  race converges on the winner's row through the unique index; audits `created` with `actorUserId:
  null`.
- The upload path: `KycDocumentInput` gains `request_id`; `parseKycDocumentInput` validates it as a
  uuid (field `request_id`, rule `invalid_format`). `saveKycDocument` resolves the request BEFORE
  any write (`resolveRequestForUpload`): only a `processor_request` document may answer
  (VALIDATION_FAILED `request_document_type`), the request must exist for this merchant (404), still
  be `open` (CONFLICT `not_open`) and belong to the same submission (CONFLICT
  `submission_mismatch`). After the document insert the request is fulfilled by
  `markRequestFulfilled`: one conditional update `id + company + status=open + version + live row`
  setting `status/fulfilled_by/fulfilled_at/version+1`, re-read race check CONFLICT `stale`, audit
  `fulfilled`. The document row is found by its unique storage key.
- `readKycPack` additionally selects the company's open requests (company-scoped, `status=eq.open`,
  live, ordered, limited) into `KycPackSnapshot.openRequests`, so the documents step shows the asks.
- Job machinery: `createDocumentRequestJobHandler(depsOf)`, `registerKycDocumentRequestJob`
  (no-op when registered), `enqueueDocumentRequest({registry, queue}, payload)` - validates,
  registers, enqueues with the per-ask idempotency key. The payment block's webhook pipeline calls
  the enqueue when a delivery asks for an extra document, the same split STEP 095 made for sync.

## 097.3 - The route, the form and the copy

- `app/api/onboarding/kyc-document/route.ts` passes `request_id: formText(form, "request_id")`
  through - no new route, so the CSRF list and the auth baselines (16/29/33) are unchanged.
- `documents-form.tsx`: a new "Extra documents a processor asked for" section lists the open asks
  (label, asking provider, note); when the chosen type is `processor_request` and asks are open, a
  select "Answering a request" appears and the chosen id is appended to the multipart form as
  `request_id`. New rule sentences map `not_open`, `submission_mismatch`, `request_document_type`
  and `stale`.
- `lib/i18n/strings/en.ts`: ten new `onboardingDocuments` keys (heading, empty line, asked-by line
  with `{provider}`, select label/placeholder/hint, four rule sentences). The i18n gate grows
  1512/176 -> 1522/177; the documents catalog check requires every key to be used by the screen.

## 097.4 - The gate (`services/kyc/verify.ts`)

- The fake store learned the `companies` read, a `kyc_document_requests` select branch (generic eq
  filters, order, limit, defaults), insert branch (with `requestInsertConflict` simulating the lost
  unique race with the winner's row present) and a version-conditional update branch (with
  `requestRace`); the shared KYC eq-filter list gained `storage_key`.
- `checkMigrationSet` now expects 0109 and max 109.
- `checkDocumentRequests()` (3586 -> 3703 checks): validation refusals run zero queries; unknown
  company 404 writes nothing; create happy path (open row on the seeded draft, one `created` audit
  with null actor); repeat delivery returns the existing row without insert or audit; lost insert
  race converges; the pack lists only open asks over live rows; the answering upload fulfills the
  request (conditional update asserted, version 2, `fulfilled_by` = the document, two audits in
  order, pack no longer lists it); wrong type / bad id / unknown id / closed ask / foreign
  submission all refuse before any write; lost race on the fulfill write conflicts `stale` with no
  fulfill audit; job register-once, enqueue dedup to the same job id, bad enqueue VALIDATION_FAILED,
  and the handler run records the ask.
- `checkDocumentRequestsSources()` scans the capture service, route, form and migration pair.
