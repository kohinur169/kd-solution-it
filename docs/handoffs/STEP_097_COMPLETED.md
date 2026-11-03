// path: docs/handoffs/STEP_097_COMPLETED.md
# STEP 097 - Extra document request flow from provider to merchant: completed

Branch `arena/bac4f52c-kd-solution-it`. This handoff and the STEP 097 code are in one commit, the
one whose message is "STEP 097: Extra document request flow from provider to merchant"
(`git log -1` on the branch shows its hash). Previous handoff: `docs/handoffs/STEP_095_COMPLETED.md`.

## STEP

- **Number and title:** STEP 097 - Extra document request flow from provider to merchant
  (`docs/final/STEP_PLAN_250.md`, the STEP 097 block).
- **Category:** Merchant Onboarding, Underwriting, KYC and Sub-Merchant Provisioning, STEPs
  079-099. Eighteenth STEP of the block.
- **Owned paths (File Ownership Rules):** "Onboarding and KYC STEPs 079-099 own
  `app/(dashboard)/onboarding/`, `services/kyc/` and `services/submerchant/`" - plus the block's
  owned `app/api/onboarding/` routes, its migrations, and the shared files the block extends (gate
  harnesses, `lib/i18n/strings/en.ts`, `app/(dashboard)/README.md`). This STEP used
  `services/kyc/kyc-capture.ts`, the owned `app/api/onboarding/kyc-document/` route (one field
  passed through, no new route), the owned documents screen, `en.ts`, one new migration pair, and
  the gate harness. `app/(admin)/`, `app/api/office/`, `components/office/`, `lib/settings/`,
  `lib/jobs/` untouched.
- **Feature list:** section 5 line 61 - address verification uploads include "any extra document a
  processor requests". (`0049` already carried that kind as the `processor_request` document type;
  this STEP adds the request itself and the answer flow.)
- **Depends on:** STEP 028 (`0048` submissions, `0049` documents), STEP 079+ (the documents step of
  the wizard and its pack), the jobs foundation (`lib/jobs/`, in-memory store in this build).
- **Note on sequencing:** STEP 096 (provisioning queue / office alert) was not part of this chat
  and remains unimplemented; nothing in this STEP depends on it.

## Migration added, and the rollback proof

- `migrations/0109_kyc_document_requests.sql` (+ `.down.sql`): the `kyc_document_requests` table -
  id (UUID v7), company_id, submission_id with the composite FK to `kyc_submissions (id,
  company_id)`, provider_id (adapter key pattern), document_label (1..120 trimmed), note (1..280
  trimmed, nullable), status (`open`/`fulfilled`/`cancelled`), fulfilled_by -> `kyc_documents (id)`,
  fulfilled_at, cancelled_at, created/updated/deleted_at, version. Checks tie each status to its
  columns; the guard trigger freezes merchant/submission/provider/label/note, walks
  open -> fulfilled/cancelled only, locks the end states, and refuses delete and soft delete. The
  partial unique index `kyc_document_requests_open_unique` gives one open ask per (company,
  submission, provider, label); the open and submission indexes serve the merchant list and the
  history. RLS enabled with the default-deny policy. The down file drops table and guard function.
- `npm run -s check:migrations` passed: 3197 checks, **109 migrations, 83 tables**, every forward
  file transactional and default-deny, every rollback dropping what its forward creates.

## Files

- **Created:** `migrations/0109_kyc_document_requests.sql`,
  `migrations/0109_kyc_document_requests.down.sql`,
  `docs/planning/STEP_097_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_097_COMPLETED.md`.
- **Modified:** `services/kyc/kyc-capture.ts` (request service + job + pack), `services/kyc/verify.ts`
  (3586 -> 3703 checks), `app/api/onboarding/kyc-document/route.ts` (passes `request_id`),
  `app/(dashboard)/onboarding/documents/documents-form.tsx` (open-asks section + request select),
  `lib/i18n/strings/en.ts` (1512 -> 1522 messages), `app/(dashboard)/README.md`.

## Behaviour

- **Recording the ask:** `createDocumentRequest` validates the payload (uuid company, provider from
  the registry's five keys, trimmed label 1..120, optional trimmed note 1..280) before any query;
  404 when the company does not exist; ensures the company's draft submission (a system draft has
  `submitted_by` null, which `0048` allows); returns the existing open row with `created: false`
  when the same submission + provider + label already has one - and a lost insert race converges on
  the winner's row the same way through `0109`'s unique index. Every created row is audited
  `kyc_document_request.created` with `actorUserId: null`, entity `kyc_document_request`.
- **The job:** `kyc.document_request`, idempotency key `kyc.document_request:<company>:<provider>:<label>`,
  so a repeated provider delivery returns the first job. `registerKycDocumentRequestJob` registers
  once; `enqueueDocumentRequest({registry, queue}, payload)` validates, registers and enqueues.
  The payment block's webhook pipeline calls the enqueue when a delivery asks for an extra document
  (the same split STEP 095 made: ingestion endpoint is another block's, the job + helper ship here).
- **The merchant side:** `readKycPack` now includes `openRequests` - the company's open asks over
  live rows - and the documents step renders them ("Extra documents a processor asked for": label,
  asking provider, note). When the merchant picks the `processor_request` type, a select lists the
  open asks and the chosen id rides the multipart upload as `request_id`.
- **Answering:** `saveKycDocument` resolves the request before any write: only a
  `processor_request` document may answer (VALIDATION_FAILED `request_document_type`), the request
  must exist for this merchant (404), still be open (CONFLICT `not_open`) and belong to the same
  submission (CONFLICT `submission_mismatch`). The document is recorded as usual (key + hash, never
  bytes), the upload audit names the `request_id`, and then `markRequestFulfilled` applies one
  conditional update (`id + company + status=open + version + live row`) setting
  `status=fulfilled`, `fulfilled_by` = the new document's id (found by its unique storage key),
  `fulfilled_at`, `version+1`; the re-read race check conflicts `stale`; the fulfill is audited
  `kyc_document_request.fulfilled`. A fulfilled ask drops out of the pack's open list.

## Verification (all exit 0)

- `node services/kyc/verify.ts` - 3703 checks (see
  `docs/planning/STEP_097_SUBSTEP_BREAKDOWN.md` 097.4: validation with zero queries; unknown
  company 404; create + idempotent re-delivery + lost insert race; pack listing only open asks;
  the answering upload (conditional update asserted, version 2, fulfilled_by, two audits in order,
  pack updated); wrong type / bad id / unknown id / closed ask / foreign submission refusing before
  any write; fulfill race `stale` with no audit; register-once, enqueue dedup, bad enqueue, handler
  run).
- `node lib/auth/verify.ts` - 2523 checks, baselines unchanged at 16 keepers / 29 mutation files /
  33 call sites (no new page, no new POST site).
- `npm run -s check:i18n` - 1522 messages / 177 placeholders / 1 locale; `npm run -s
  check:migrations` - 3197 checks, 109/83; `npm run -s typecheck`, `npm run -s lint` clean;
  `npm run -s verify` exit 0 (all 10 gates + production build).
- Dev smoke (port 3107, `.env.local` from `.env.example`, removed afterwards): `/` 200 signed-out;
  `/api/jobs/health` 200 with the memory queue `ok`; `POST /api/onboarding/kyc-decide` without a
  token -> 422 `csrf_token_invalid`; `/onboarding/kyc-review` and `/onboarding/documents` 200
  signed-out.

## Acceptance checklist

- The behaviour of the title was exercised through the gate harness: a processor ask is recorded as
  an open `0109` row on the merchant's draft submission (idempotent per provider + label, audited),
  the merchant's documents step lists the open asks, and an upload carrying the request's id - a
  `processor_request` document only - fulfills it through one version-conditional update naming the
  document, audited, with races and misuse conflicting before any write. The recording runs as the
  idempotent `kyc.document_request` background job.
- One new migration with its rollback; RLS default-deny; no new route, so CSRF list and auth
  baselines unchanged; all UI copy in en.ts.

## Notes for the next STEP

- The payment block's webhook ingestion should call `enqueueDocumentRequest` when a processed,
  signature-verified delivery of an ask type arrives and resolves the merchant - the idempotency
  key makes redelivery safe, and the job handler is `createDocumentRequestJobHandler`.
- The office review queue (`/onboarding/kyc-review`) lists documents; a fulfilled request's
  `fulfilled_by` points at the answering document row, so the reviewer sees which upload answered
  which ask without a new screen.
- STEP 096 (provisioning queue + office alert when no master account is connected) is still open;
  it reads `0054`'s queue index, untouched by this STEP.
