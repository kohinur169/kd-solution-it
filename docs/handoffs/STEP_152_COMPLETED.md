// path: docs/handoffs/STEP_152_COMPLETED.md
# STEP 152 — NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation

**Status: COMPLETED**

## STEP

- Number and title: STEP 152 — NMI sandbox end-to-end verification, response code mapping and transaction status sync per official documentation.
- Category: Five Payment Provider Adapters (NMI), STEP 147-152.
- Depends on (earlier STEPs in this category and their handoff files): STEP 147 (documentation verification record, `docs/final/PROVIDER_DOCS.md`), STEP 148 (encrypted key configuration and connection test), STEP 149 (Collect.js token rules), STEP 150 (Classic API transaction types and response parsing), STEP 151 (shared server payment module and the `transact.php` transport) — all handoffs present. Protocol details follow `docs/handoffs/STEP_117_151_REVIEW.md`, which supersedes the older NMI handoffs.

## Files

- Created:
  - `lib/payments/adapters/nmi-status-sync.ts` — the STEP 152 adapter service (response-code table, condition mapping, Query API client, optimistic status sync, sandbox cycle).
  - `lib/payments/adapters/nmi-status-sync-verify.ts` — the gate (411 checks).
  - `docs/handoffs/STEP_152_COMPLETED.md` — this handoff.
- Modified:
  - `package.json` — added the `check:payments-adapters-nmi-status-sync` script and its place in the `verify` chain.
  - `docs/final/PROVIDER_DOCS.md` — NMI section extended with the STEP 152 documentation URLs, the recorded response-code and Query API rules, and the sandbox note rows (void, status sync, sandbox cycle).
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/payments/adapters/` (one adapter file plus its gate, the same shape STEPs 147-151 used), and the two shared files the rules allow an adapter STEP to change — `package.json` (gate entry only) and `docs/final/PROVIDER_DOCS.md` (NMI section only, extended by adapter STEPs 147-169). No file of another STEP was edited. No migration, no `app/` route, no component, no `lib/env` change.

## Database

- Migrations added (file names): none. This STEP stores no new schema; the status vocabulary it maps onto is the one the committed `migrations/0037_payments.sql` constraint already enforces (`pending`, `authorized`, `captured`, `settled`, `failed`, `voided`, plus the refund and review statuses this STEP deliberately does not write).
- Rollback verified on clean database (yes/no, how): not applicable — no migration was added or changed.

## Environment

- Environment variables added to .env.example: none. The service reads no environment variable; the key store, encryption key and clock are passed in by the caller, exactly as STEPs 148 and 151 do.
- Secrets handled (names only, never values): the decrypted NMI private security key (`secretKey`) is used only as the `security_key` form field and is never returned, logged, audited or embedded in any result. The gate proves this with a value scan (`JSON.stringify(result).includes(privateKey) === false`) on the query result, the sync state, the audit entry and the sandbox report.

## Packages

- Package requests for the integrator (name, reason), or none: none. The Query API body is parsed by a small, documented `<nm_response>` reader in the adapter file, so no XML dependency was requested.

## Behaviour Proof (acceptance checklist)

The four behaviours in the STEP title were exercised with the documented NMI answers and a recording transport. `npm run check:payments-adapters-nmi-status-sync` runs them; all 411 checks pass.

1. **Response code mapping per the official documentation** (`https://docs.nmi.com/reference/response-codes`).
   - The table carries all 34 documented codes with their official descriptions: `100` approved; `200`-`264` declined; `300` rejected by the gateway; `400`, `410`, `411`, `440`, `441` processor/configuration errors; `460`, `461` declined. Observed: `100` → `approved`, `202` → `declined`, `300` → `rejected`, `420`/`430` → not final.
   - `420`, `421` (communication errors) and `430` (duplicate at the processor) are flagged `requiresReconciliation` and produce **no** status: observed `targetStatus === null` for `response=3, response_code=420` and for `response=3, response_code=430`.
   - An undocumented code (`999`), a missing code, an undocumented `response` value (`4`), an approval without `transactionid`, an approval carrying a decline code (`response=1, response_code=200`) and a decline carrying `response_code=100` are all observed as `unresolved` with `requiresReconciliation === true`.
   - Provider text (`responsetext`, Query API `<response_text>`) is sanitised before it leaves the service: control characters removed, `<`/`>` stripped, whitespace collapsed, capped at 200 characters. Observed: `"<script>alert(1)</script>"` → `"scriptalert(1)/script"`, a 500-character string → 200 characters.

2. **Transaction status sync** (Query API: `https://docs.nmi.com/reference/query`; conditions: `https://docs.nmi.com/docs/asyncstatus-polling`).
   - Condition mapping observed: `pending` → `authorized`, `pendingsettlement` → `captured`, `complete` → `settled`, `canceled` → `voided`, `failed` → `failed`, `in_progress` → `pending`, `abandoned` → `failed`, `unknown` (and any undocumented condition) → unresolved, nothing written.
   - The Query API XML is parsed for `transaction_id`, `condition`, `order_id`, `transaction_type` and every `<action>` (amount, type, success, date, `response_code`, `response_text`); XML entities are decoded. Observed on a settled two-action record: id `11223344`, condition `complete`, 2 actions, `"Approved & captured"` decoded.
   - A Query API `<error_response>` is reported as a gateway error with its code; an empty `<nm_response>` as not found; a body without the root element, an oversized body (over 256 KiB), a record without a numeric transaction id and a non-numeric id as unparsable (unknown, never a failure).
   - A record whose condition says money moved while its newest action says the action failed, and a newest action carrying `420`, are both observed as unresolved.
   - Forward-only transitions observed: `authorized → settled` synced; `settled → captured` (stale report) refused with the stored status named; `settled → settled` unchanged with no version bump and no audit entry; `captured → failed` refused; refund answers are `not_applicable` and leave the payment status and version untouched.
   - Optimistic locking observed: a second write from the same read is refused (`the transaction state changed while the status was syncing`), the winner is not overwritten, a company change is refused, a version jump is refused, an unknown id is refused.
   - Cross-tenant: a provider transaction id is scoped to its company by the store key; a sync for another company's transaction is refused and, in the reference store, two companies may hold the same provider transaction id without collision.
   - The query sends the decrypted `security_key` and the `transaction_id` to the sandbox endpoint for a sandbox key configuration and to the production endpoint for a production one; a lost query answer, an unparsable answer and a gateway query error are all `unresolved` with "reconcile before retrying" and leak no credential. The endpoint allowlist in the transport rejects any other URL, non-2xx answers are refused, and redirects are refused.

3. **Sandbox end-to-end verification** (test mode: `https://docs.nmi.com/docs/enable-test-mode-1`).
   - `runNmiSandboxCycle` runs the documented six steps in order — sale, authorization, capture of that auth, partial refund (`5.00` of a `10.00` sale), a second authorization and a void of it — through STEP 151's `processNmiPayment`, each exchanging the Collect.js token. Observed with a recording transport: report `verified`, 6 steps all approved, 6 POSTs all to `https://sandbox.nmi.com/api/transact.php`, payload types `sale,auth,capture,refund,auth,void`, capture sends `transactionid` of the auth, refund sends `transactionid` of the sale and `amount=5.00`, void sends the second auth's `transactionid` and no amount.
   - Guard rails observed: a production key configuration is `blocked` and no request is sent; a company without keys, an empty token, a malformed amount, a zero refund and an empty company id are all `blocked` before any request; every cycle request is wrapped so a non-sandbox endpoint throws.
   - A declined sale (`response=2, response_code=202`) is observed as `failed` with the remaining five steps `not_attempted`, the decline classified `declined` with its code. A rejected capture (`response=3, response_code=300`) stops the cycle after three calls with the later steps `not_attempted`. A lost answer (`transport throws`) is observed as `unknown`, one call only, with "reconcile before retrying" and nothing attempted afterwards.
   - The report carries the documentation URLs, the two sandbox endpoints and no credential and no Collect.js token.
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable — this STEP adds no UI.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: not applicable — this STEP adds no route, so there is no session, role or CSRF surface to exercise; those belong to the later STEP that exposes a sync route. The service-level checks a route will rely on were exercised: an empty company id and a non-numeric provider transaction id are rejected before any call, a provider transaction id is scoped to its company, another company's state is refused, a company's own key configuration is the only one read, and no credential appears in any returned value (the decrypted security key is sent only as the `security_key` form field).
- Security and audit: every applied status write hands one `NmiStatusAuditEntry` (`payment.nmi.status_synced`, company, provider transaction id, previous and new status, provider condition, response code, time) to the caller's audit writer, and no audit entry or result carries a credential, a card value or a Collect.js token. A refused, unchanged, unresolved or not-applicable sync writes no audit entry. No table was added, so no RLS policy is due from this STEP.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable — this STEP posts no ledger entry and moves no money. It only maps a gateway condition to a payment status; the ledger postings for confirmed money remain STEP 132's, gated by its own proofs.
- Provider sandbox cycle and documentation URLs where applicable:
  - Documentation read in this session: `https://docs.nmi.com/reference/response-codes`, `https://docs.nmi.com/reference/query`, `https://docs.nmi.com/reference/transactions-processing`, `https://docs.nmi.com/docs/processing`, `https://docs.nmi.com/docs/asyncstatus-polling`, `https://docs.nmi.com/docs/enable-test-mode-1`, `https://docs.nmi.com/docs/collectjs`.
  - Sandbox URLs: `https://sandbox.nmi.com/api/transact.php` (payments, STEP 151) and `https://sandbox.nmi.com/api/query.php` (status reads, this STEP). Production URLs: `https://secure.nmi.com/api/transact.php` and `https://secure.nmi.com/api/query.php`.
  - Sandbox result: **not run against NMI's live sandbox in this session.** No NMI sandbox account, security key or public tokenization key exists in this environment, and the environment has no outbound access to `sandbox.nmi.com`. Every step above was exercised with a recording transport that returns the documented sandbox answers, which proves the code path and the mapping, not the provider. The cycle is executable as written: with a sandbox key configuration and a Collect.js sandbox token, `runNmiSandboxCycle` submits the six transactions to the sandbox endpoint and returns the report to record here. Until the owner runs it, this STEP is **not** evidence of a completed provider sandbox cycle, and the same applies to STEP 151's transport. This is written into `docs/final/PROVIDER_DOCS.md` under Sandbox Notes.

## Verification

- Typecheck result: `npx tsc --noEmit` — exit 0, no errors (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Lint result: `npx eslint .` — exit 0, no findings (including `npm run check:lint`, which checks the rule matrix itself).
- Build result for the touched area: `npm run build` (inside `npm run verify`) — exit 0, the Next.js production build completes for the whole application.
- `npm run verify` — exit 0: audit, structure, env, config, i18n, logger, errors, lint matrix, shell, jobs, migrations, invoice/estimate/settlement gates, the payment core gates, the NMI gates including the new `check:payments-adapters-nmi-status-sync` (411 checks), typecheck, lint and build.

## Next

- Next STEP number: STEP 153 — "NMI sub-merchant provisioning through the gateway with signature verified idempotent webhooks".
- Anything the next chat must know:
  - This STEP owns `lib/payments/adapters/nmi-status-sync.ts` only. STEP 153 must not edit it; it reuses `NMI_RESPONSE_CODES`, `assessNmiTransactResponse` and `applyNmiStatusAssessment` if it needs the same mapping, and it owns its own adapter file for sub-merchant provisioning and the webhook contract.
  - The status vocabulary this STEP writes is the committed `payments.status` constraint (`pending`, `authorized`, `captured`, `settled`, `failed`, `voided`). Refund statuses and `under_review` are not written here: the refunded total belongs to the refund service (STEP 191+) and a review status is a platform decision.
  - `NmiTransactionStateStore`, `InMemoryNmiTransactionStateStore` and `InMemoryNmiKeyStore` are reference stores, not PostgreSQL transactions. The optimistic write is proven at store level only; a database adapter still needs an atomic, row-locked update and real concurrency proof before this is production persistence. Nothing here executes a real payment or payout.
  - The sync is not exposed by any route and no background job calls it yet: a later API/job STEP owns the caller, the audit writer behind `recordAudit` and the scheduling. Date-driven reconciliation (for example a daily status sweep of unsettled transactions) has no owner yet and must be scheduled through STEP 011/012's queue when it is added.
  - The live NMI sandbox cycle is still outstanding (see Behaviour Proof). It requires a sandbox security key plus a public tokenization key configured through the gateway settings, and a Collect.js sandbox payment token.
  - The `NMI_STATUS_SYNC_DOCUMENTATION_URLS` list and the sandbox note rows in `docs/final/PROVIDER_DOCS.md` are the record the provider documentation rule requires; extend them, do not replace them.
