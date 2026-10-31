// path: docs/handoffs/STEP_028_COMPLETED.md
# STEP 028 Completed - Handoff

## STEP
- Number and title: STEP 028 - Migration for KYC submissions, documents, UBO records, sanctions
  screening records, policy acceptances and review decisions tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 027 (the bank account
  a paid payout names), STEP 025 (the ledger a settlement posts to), STEP 003 (the users who
  submit, review and decide) and STEP 001 (the merchant every row belongs to). STEP 029 is the
  sub-merchant provisioning STEP that reads an approved submission, STEP 035 the permissive
  policies, and STEP 038 the signup flow that writes a policy acceptance. The owner asked for
  this STEP directly; it was split into three sub-steps with an approval between each, and the
  plan is `docs/planning/STEP_028_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0048_kyc_submissions.sql and 0048_kyc_submissions.down.sql - the KYC cycle with
    its method and provider reference, its five statuses, one open cycle per merchant, the
    four-eye reviewer pair, the decision instants and reason, and its guard.
  - migrations/0049_kyc_documents.sql and 0049_kyc_documents.down.sql - the uploaded evidence
    as a storage key, a byte hash, a mime type and a size, with its six document types, the
    issue instant of the three month rule, the review pair and its rejection reason.
  - migrations/0050_ubo_records.sql and 0050_ubo_records.down.sql - the beneficial owners with
    their share in basis points, the 25 percent flag, the identity document hash and the sum
    guard of one submission.
  - migrations/0051_sanctions_screenings.sql and 0051_sanctions_screenings.down.sql - the
    screening with its three subject kinds, the four lists, the three results, the case note of
    a confirmed match and the SAR flag.
  - migrations/0052_policy_acceptances.sql and 0052_policy_acceptances.down.sql - the accepted
    policy version with the hash of the accepted text and the person who accepted it.
  - migrations/0053_review_decisions.sql and 0053_review_decisions.down.sql - the append only
    audit record with its subjects, its six decisions, its reason and its appeal chain.
  - docs/planning/STEP_028_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_028_COMPLETED.md.
- Modified:
  - migrations/verify.ts - rule 6 of the gate now reads the default-deny policy body and refuses
    one that does not refuse reads and writes alike; the header comment says so. The gate went
    from 1503 checks to 1646 checks with the six files, and the new rule alone added sixteen.
  - migrations/README.md - six inventory rows for `0048` to `0053`, two new rules (a KYC
    submission is a cycle and its evidence is a row; a screening is four lists and a result, and
    a decision is history), the numbering rule moved from 40 to 42, the introduction now says
    fifty three files, and the gate paragraph names the strengthened rule.
  - README.md - the database section describes the six tables, directly above the
    `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/`, the migrations gate and the two indexes. Not touched:
  migrations `0001` to `0047`, every `lib/` module, `config/`, the environment contract, the KYC
  screens, the Jumio, Didit and Sumsub adapters, the document storage adapter, the duplicate
  check service, the SAR export, the retention job, the permissive RLS policies (035) and every
  code STEP. `package.json` is untouched because the gate already covers new files.

## Database
- Migrations added (file names): `0048_kyc_submissions`, `0049_kyc_documents`,
  `0050_ubo_records`, `0051_sanctions_screenings`, `0052_policy_acceptances` and
  `0053_review_decisions`, each with its `.down.sql`. Together they create six tables with 94
  columns, 90 constraints, 26 indexes, 100 comments, six functions and thirteen triggers. The
  schema now holds fifty three tables, fifty three policies, ninety five triggers and forty
  seven functions in `public`.
- Shape per table: `kyc_submissions` 19 columns, 21 constraints, five indexes, 20 comments, two
  triggers; `kyc_documents` 18, 18, four, 19, two; `ubo_records` 15, 13, three, 16, three;
  `sanctions_screenings` 17, 13, six, 18, two; `policy_acceptances` 11, 10, three, 12, two;
  `review_decisions` 14, 15, five, 15, two.
- A submission is a cycle, not a column on the merchant: `kyc_submissions_open_key` is a partial
  unique index over `company_id` for `draft`, `submitted` and `in_review`, so a decided row frees
  the merchant for a new cycle while the old row stays as history.
- Four-eye review is a shape: `kyc_submissions_second_reviewer_check` requires a second reviewer
  on an approval or a rejection of a four-eye merchant, and
  `kyc_submissions_two_people_check` refuses the same person twice. A provider method carries the
  provider reference and a manual one carries none.
- A document is evidence, never the file: the row keeps `storage_key`, `content_sha256`,
  `content_type` and `byte_size`, a query over the columns finds no `file`, `content`, `data`,
  `bytes`, `path` or `blob`, a utility bill requires `issued_at` for the three month rule, and
  `kyc_documents_guard_state` freezes the key and the bytes after upload.
- A UBO is a share in basis points: `ownership_bps` runs from 1 to 10000, `is_significant` is
  true exactly at 2500 or above, and `ubo_records_guard_total` refuses a row that would take the
  live owners of one submission past 10000, which also catches restoring a removed owner.
- A screening names its lists and a decision is history: at least one of the four lists must be
  checked, a confirmed match carries its note, the SAR flag is never cleared, and
  `review_decisions_guard_state` refuses every change to a recorded decision while moving
  `appeal_state` from `none` to `open` and then to `upheld` or `overturned`.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All fifty three
  rollbacks ran in reverse dependency order on populated databases; afterwards the catalog
  reported 0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the fifty
  three forward files applied again to a second empty database, recreating exactly fifty three
  tables, fifty three policies, ninety five triggers and forty seven functions with no rows left
  behind. The rollbacks of this STEP alone, run newest first, returned the schema to fifty
  tables, fifty policies, eighty nine triggers and forty four functions.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs wrote synthetic document hashes,
  synthetic policy hashes, synthetic screening notes and synthetic names and countries in
  throwaway local databases, and no real identity document, screening result or policy text was
  written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three proof scripts ran against the local PostgreSQL 16.2 with 83, 60 and 3 checks, and two
detach scripts with 5 and 4 checks; all of them ended with `PROOF COMPLETE` and no failure.

1. **Forward apply.** `0001` to `0053` applied in order and produced fifty three tables, fifty
   three policies, ninety five triggers and forty seven functions, and every one of the six new
   tables matched its measured shape exactly.
2. **A submission is a cycle.** A draft carried the manual method, no instant and version 1; a
   second open submission for the same merchant was refused by `kyc_submissions_open_key` while
   another merchant kept its own; a submitted row needed both the instant and the person; the
   status, the method, the reviewer implication, the provider reference pair, the instant order
   and the expiry were each refused by name.
3. **Four-eye review cannot be one click.** A four-eye approval with one reviewer was refused by
   `kyc_submissions_second_reviewer_check`, one person signing twice had to be caught by
   `kyc_submissions_two_people_check`, and a real approval stored both reviewers and their two
   instants.
4. **A decided submission is history.** Rewriting the reason and undeciding the row were both
   refused with "a decided KYC submission is history", changing the merchant or the submitter
   with "a KYC submission keeps its merchant and who submitted it", and a rejection without its
   reason was refused by `kyc_submissions_reason_check`.
5. **A document is evidence.** A bank statement waited as `uploaded` with its size and version 1,
   a utility bill without its issue instant was refused, and the type vocabulary, the storage key
   without escapes or spaces, the 64 hex hash, the lower case mime type, the 1 byte floor, the
   50 megabyte ceiling, the expiry order, the review pair and the rejection reason were each
   refused by name.
6. **A document stays with its merchant.** A document filed under another merchant's submission
   and one naming a submission that does not exist were both refused by
   `kyc_documents_submission_fkey`, the bytes and the key were frozen after upload, and a
   reviewed document could not be rejected later with "a reviewed KYC document is history".
7. **The owners add up to one company.** An owner of 0 and an owner of 10001 basis points were
   refused, the share bounds were read from the constraint, a 10 percent owner marked significant
   and a quarter owner marked small were both refused, and the owners of one submission reached
   exactly 10000 before a seventh owner was refused and a removed owner freed its share for the
   corrected row.
8. **A screening is four lists.** A screening that checked no list, a company subject naming
   another merchant, an unknown subject kind, result or provider, a confirmed match without its
   note and a SAR case on a clear screening were each refused; the same screening recorded twice
   was refused by `sanctions_screenings_subject_key`.
9. **A screening is frozen but a case can grow.** Changing the result or dropping a checked list
   was refused with "a screening keeps its subject, its lists, its result and its instant",
   clearing the SAR flag with "a SAR case file is never closed by clearing the flag", and
   extending the case note moved the row to version 2 while the flag survived.
10. **A consent is a version.** An acceptance stored `pci_dss` `3.1.4` at version 1, a thirteenth
    policy key, a version that is not dotted numbers, a version with spaces, an upper case hash
    and an acceptance in the future were each refused, the same version could not be accepted
    twice while a new version was a second row, and a withdrawn acceptance freed its version.
11. **A decision is history.** An approval needed no reason while a rejection did, an overturn
    that appeals nothing was refused, an appeal that names itself, an appeal naming another
    merchant's decision and a second appeal against one decision were each refused, and a
    recorded decision could not change its outcome, its reason or be deleted.
12. **The appeal state moves forward.** A decision went from `none` to `open` at version 2 and to
    `upheld` at version 3, an appeal row carrying `open` was refused by
    `review_decisions_appeal_link_check`, and resetting a decided appeal was refused with "an
    appeal once recorded moves to upheld or overturned and no further".
13. **Every index answers its screen.** The partial keys and the ordering of
    `kyc_submissions_open_key`, `kyc_submissions_queue_idx`, `kyc_submissions_decided_idx`,
    `kyc_documents_submission_idx`, `kyc_documents_review_idx`, `kyc_documents_hash_idx`,
    `ubo_records_submission_idx`, `ubo_records_document_idx`,
    `sanctions_screenings_subject_idx`, `sanctions_screenings_match_idx`,
    `sanctions_screenings_sar_idx`, `policy_acceptances_version_key`,
    `policy_acceptances_policy_idx`, `review_decisions_history_idx`,
    `review_decisions_subject_idx` and `review_decisions_appeal_key` were read from
    `pg_indexes.indexdef`.
14. **Row level security.** A plain role with table grants saw no screening, no acceptance and no
    decision and could not write one ("new row violates row-level security policy"), while the
    owner still read its three rows.
15. **Every guard is load bearing.** With `kyc_submissions_guard_state` dropped a decided
    submission was rewritten; with `kyc_documents_guard_state` dropped a document swapped its
    bytes; with `ubo_records_guard_total` dropped the owners passed 100 percent; with
    `ubo_records_guard_state` dropped an owner changed its share; with
    `sanctions_screenings_guard_state` dropped a screening was rewritten and its SAR flag
    cleared; with `policy_acceptances_guard_state` dropped an accepted version was rewritten;
    with `review_decisions_guard_state` dropped a decision was rewritten and its appeal undone.
    Restoring a guard refused the write again.
16. **Rollback and re-apply.** The rollbacks of this STEP alone returned the schema to fifty
    tables, fifty policies, eighty nine triggers and forty four functions, the three tables and
    their six functions were gone, and applying the files again restored the full shape; all
    fifty three rollbacks emptied the `public` schema.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1646 checks, 53 migrations, 53 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0. Structure gate 16 directories, 13 root files and 68 source files;
  config gate 10 sections and 28 values; i18n gate 36 messages; logger gate 117 checks; the
  migrations gate above; then the TypeScript typecheck, the linter and the production build,
  which compiled successfully and prerendered the three routes.
- Gate probes: ten temporary edits were offered to the gate and all ten were caught - a missing
  `enable row level security`, a missing `commit;`, a default-deny policy reading `using (true)`,
  one writing `with check (true)`, an `id` without the shared UUID v7 default, and a forward file
  whose rollback was moved away. Two of them were caught only after rule 6 was strengthened in
  this STEP.
- Proof scripts: `/tmp/proof_0282.py` (83 checks), `/tmp/proof_0283.py` (60 checks),
  `/tmp/rls_0283.py` (3 checks), `/tmp/detach_0282.py` (5 checks) and `/tmp/detach_0283.py`
  (4 checks), each ending with `PROOF COMPLETE: 0 FAIL`; the shapes were read with
  `/tmp/measure_0282.py` and `/tmp/measure_0283.py` rather than counted by hand.

## Errors Found And Corrected In This STEP
1. **The database was read before it was written.** The first proof assumed a fresh merchant for
   every refused insert, and the second merchant already held an open draft, so the probes were
   refused by the open key rather than by the rule under test. The probes now use one merchant per
   lifecycle: a draft, a submitted row, an in-review row and a decided row, each named for the
   state it holds.
2. **A neighbouring trigger pre-empted a check.** An owner of 10001 basis points was refused by
   `ubo_records_guard_total` rather than by `ubo_records_share_check`, because a trigger runs
   before a check. The probe now expects the sum guard and reads the share bounds from
   `pg_get_constraintdef` instead of asserting a runtime error the trigger makes unreachable.
3. **The restore probe tested nothing.** Restoring a removed owner was first attempted while the
   owner was still live, which is a no-op; it was moved after the removal and the corrected row,
   where the restored share really does take the live total past 100 percent.
4. **A guard froze a state that had to move.** `review_decisions_guard_state` first refused every
   change once `appeal_state` left `none`, so `open` could never become `upheld`. It now allows
   exactly `open` to `upheld` or `overturned` and nothing else, and the comment says so.
5. **The gate did not read the policy body.** A default-deny policy whose `with check` was `true`
   passed the old rule 6, which only looked for the policy name. Rule 6 now matches the whole
   shape, and the two probes that used to slip through are caught.

## Decisions And Limits Left For Later STEPs
1. **Two references are polymorphic.** `sanctions_screenings.subject_id` and
   `review_decisions.subject_id` name a row in one of several tables, which no single foreign key
   can express; the columns carry a comment saying the writing service checks the reference, and
   `subject_kind` is a closed vocabulary so a wrong kind cannot pass silently. A company subject
   still proves itself with a check, because its table is the merchant itself.
2. **The permissive policies are STEP 035's job.** Every table here is default-deny, so nobody
   reads it yet. The SAR isolation of section 3 (only `compliance_kyc` and `super_admin`, never
   the merchant) is a read policy of STEP 035 over these same rows, not a column here.
3. **The file is not in the database.** `kyc_documents` keeps the key, the hash, the mime type and
   the size; the bucket and its signed links belong to the storage adapter of the code STEPS, and
   the three month rule of a utility bill is provable from `issued_at` but is not enforced against
   the wall clock, because a decision is never rewritten and a clock in a migration is a trap.
4. **The duplicate check is not this STEP.** Section 4's signals over email, phone, identity
   document hash, tax id, bank account fingerprint and legal name with date of birth are indexed
   where this STEP owns the hash (`ubo_records_document_idx`) and measured in the STEPS that own
   the other columns; the service that refuses a duplicate comes later.
5. **Seven year retention and the SAR export are later.** Nothing here deletes, and the export of
   a case file is a service, not a table.
6. **No audit-log write in this STEP.** Section 5 says every KYC decision is audit logged;
   `review_decisions` is that record at the database level, and the application audit stream is
   written by the code STEP that performs the decision.

## Next Chat Notes
1. Next is STEP 029 - Migration for sub-merchant provisioning records table. It reads an approved
   `kyc_submissions` row and should reference it through `kyc_submissions (id, company_id)`, the
   tenant key this STEP added.
2. Keep the three sub-steps and the approval between them, and ask the owner before starting.
3. Measure the shape with a script before writing the handoff numbers; the six tables of this STEP
   changed three numbers between the design document and the catalog.
4. `migrations/verify.ts` is now stricter than it was for `0001` to `0047`; run
   `npm run check:migrations` after any edit to an older file, because a policy body written as
   `using (true)` anywhere now fails the gate.
