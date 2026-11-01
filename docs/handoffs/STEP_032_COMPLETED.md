// path: docs/handoffs/STEP_032_COMPLETED.md
# STEP 032 Completed - Handoff

## STEP
- Number and title: STEP 032 - Migration for email settings, templates, send logs, support
  tickets, CMS and blog pages, company accounting and compliance calendar tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (the tenant
  root), STEP 003 (the people who open tickets and record money), STEP 004 (the role vocabulary
  the office screens use), STEP 013 (the append-only audit chain), STEP 016
  (`payment_providers`, the issuer of a processor bill), STEP 031 (`files`, which every
  attachment, cover and certificate points at) and STEP 0052 (`policy_acceptances`, whose twelve
  keys a CMS policy page reuses). STEP 221-227 own the email service, 228-229 support, 232-238
  the CMS and the blog, 239-243 the accounting screens, 074 the compliance calendar screen and
  035 the permissive policies. The owner split this STEP into five sub-steps with an approval
  between each, and the plan is `docs/planning/STEP_032_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0058_files_purposes.sql and its `.down.sql` - the two new file purposes
    (`cms_image`, `compliance_document`), in a file that creates no table.
  - migrations/0059_email_settings.sql to migrations/0068_compliance_items.sql, each with its
    `.down.sql` - ten tables: the sending method, the templates, the send log, the two support
    tables, the CMS page, the blog post, the company transaction, the processor bill and the
    compliance item.
  - docs/planning/STEP_032_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_032_COMPLETED.md.
- Modified:
  - migrations/README.md - eleven inventory rows (`0058` to `0068`), three new rules (email, the
    service level and the public pages, the platform book) and the numbering rule moved from 45
    to 48; the introduction now counts sixty eight files.
  - README.md - the database section describes the ten tables, directly above the
    `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/` and the migrations index. Not touched: migrations `0001` to
  `0057` (0058 alters the check of `0057` in a new file, which is the append-only way), every
  `lib/`, `app/` and `services/` file, `config/` (no email or accounting defaults are added
  here), `package.json` and `migrations/verify.ts`, which needed no change for these tables.

## Database
- Migrations added (file names): `0058` to `0068`, eleven forward files and eleven rollbacks.
  Together they create ten tables with 182 columns, 183 constraints, 33 indexes, 192 comments,
  ten guard functions and twenty triggers; the vocabulary file adds no object of its own. The
  schema now holds 68 migrations, 67 tables, 67 policies, 126 triggers, 64 functions and 273
  indexes in `public`.
- Shape per table, measured from the catalog after a clean apply: `email_settings` 28 columns,
  31 constraints, three indexes, two triggers, 29 comments; `email_templates` 12, 11, three,
  two, 13; `email_send_logs` 22, 22, four, two, 23; `support_tickets` 20, 19, four, two, 21;
  `support_ticket_messages` 14, 15, two, two, 15; `cms_pages` 16, 16, four, two, 17;
  `blog_posts` 17, 17, four, two, 18; `company_transactions` 16, 17, three, two, 17;
  `processor_bills` 18, 16, three, two, 19; `compliance_items` 19, 19, three, two, 20. Every one
  is default-deny with its own policy.
- `0058_files_purposes.sql` is the first file in the chain that alters an earlier table: it
  replaces `files_purpose_check` with the same five names plus `cms_image` and
  `compliance_document`, and its rollback restores the five. A rollback over a row that carries
  a new purpose is refused by the narrower check, which the down file states and the proof
  performs after removing its probe rows.
- Seven of the ten tables are platform rows with `company_id` null and their `_platform_check`;
  `email_send_logs` keeps a merchant id for a merchant email and null for a platform one, and
  the two support tables require it.
- One sending method is active at a time because `email_settings_active_key` is a partial unique
  index over the single value `active`, and an active row must carry a successful test
  (`email_settings_test_check`). The method owns its fields: the API pair is all present or all
  absent, the SMTP trio is all present or all absent, and the method decides which set may
  exist.
- The email credential is the ciphertext quartet - `credential_ciphertext` 16 to 8192
  characters, `credential_iv` 12 to 64, `credential_tag` 16 to 64, `encryption_key_version` 1 to
  999 and the fixed `aes-256-gcm` - so no plaintext column exists.
- The twenty activity emails of section 23 are a closed key list in `email_templates` and again
  in `email_send_logs`, because a send log must outlive a template edit; a duplicate provider
  message id is refused by `email_send_logs_message_key`.
- Support service level is stored, not claimed: `first_response_due_at` and `resolution_due_at`
  are columns, `first_responded_at`, `resolved_at` and `closed_at` are written once, and
  `first_response_on_time` is a stored generated column. A `payment_stuck` ticket whose deadline
  is later than `created_at + interval '72 hours'` is refused by
  `support_tickets_stuck_due_check`.
- `support_ticket_messages` is append only: the guard refuses every update and every delete and
  checks on insert that the ticket belongs to the same merchant. A message carries one
  attachment, a `files` row of the `support_attachment` purpose.
- `cms_pages` holds one live row per slug and one per policy key (both partial unique indexes),
  and a publication carries its instant and its person; `blog_posts` walks `draft` to
  `published` to `archived`, writes both instants once and refuses a delete of a published
  article.
- `company_transactions` ties its category to its direction, bounds the tax by the amount and is
  corrected by a reversing entry, never deleted. `processor_bills` is one per provider and
  period, its `variance_minor` is `generated always as (billed_minor - matched_minor) stored`,
  its matched amount only rises and its status walks `received` to `matched` or `disputed` and
  on to `paid`. `compliance_items` moves `expires_on` and `last_alert_at` forward only, keeps
  `renewed_at` on an archived row and is archived rather than deleted.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. Each sub-step
  ran the rollbacks of its own files and applied them again: `0058` to `0060` returned the
  schema to 57 tables, 57 policies, 106 triggers and 54 functions; `0061` to `0065` returned it
  to 59, 59, 110 and 56; `0066` to `0068` returned it to 64, 64, 120 and 61; and each group
  applied again to the counts its forward files produce, ending at 67 tables, 67 policies, 126
  triggers, 64 functions and 273 indexes. The full descending chain of all 68 rollbacks ran on a
  database with every migration applied and left 0 tables, 0 policies, 0 triggers and 0
  functions in `public`.

## Environment
- Environment variables added to .env.example: none. The email adapters of STEP 221-222 read the
  `SMTP_*` and provider variables STEP 004 already declared.
- Secrets handled (names only, never values): none. The proofs wrote synthetic credentials,
  synthetic certificates and a synthetic statement in throwaway local databases, and no real
  credential, certificate or provider document was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three proof scripts ran against the local PostgreSQL 16.2 with 66, 100 and 70 checks, and every
one of the 236 passed; each script ended with `PROOF COMPLETE: 0 FAIL`.

1. **Forward apply.** `0001` to `0068` applied in order and produced 67 tables, 67 policies, 126
   triggers, 64 functions and 273 indexes, and all ten new tables matched their measured shapes.
2. **The two purposes.** A `cms_image` file and a `compliance_document` file were accepted and a
   purpose outside the seven was refused by `files_purpose_check`; after the rollback of `0058`
   the same `cms_image` row was refused again.
3. **One sending method.** A second `active` row was refused by `email_settings_active_key`; an
   active row without a successful test was refused by `email_settings_test_check`; an active
   row without its instant, a disabled row without its instant and an activation before the row
   were each refused by name.
4. **The method owns its fields.** An SMTP row carrying API fields, an API row carrying SMTP
   fields and an SMTP row missing its user name were refused by the four method checks; an
   endpoint without https, a provider name with a capital, a port of zero and of 70000, a bad
   sender address, a bad reply-to and a sender name with a trailing space were each refused.
5. **The credential stays sealed.** A ciphertext of three characters, an iv of three, a tag of
   eight, a cipher other than AES-256-GCM and a key version of zero were refused.
6. **An active sender is frozen.** A host, sender or credential change while active, an
   activation instant rewritten, and a delete of the active row were refused with "a sending
   method is disabled before its connection changes" or "before it is deleted"; after the row
   was disabled the host change was accepted.
7. **Templates.** The welcome template was accepted, the same key and locale twice was refused,
   the same key in another locale was accepted, a twenty first key, a locale of two capitals, a
   subject with a trailing space and an empty body were refused, a repointed key and a moved
   locale were refused, and a soft delete was refused while `is_active = false` was accepted.
8. **The send log is history.** A queued row became `sent` with its message id; the same
   provider message id was refused a second row; a sent row moved back, a sent instant
   rewritten, a falling attempt count, a recipient rewritten and a delete were all refused; a
   failed row carried its reason and its retry instant and moved to `sent` on a retry.
9. **The send shapes.** A key outside the twenty, a recipient without a domain, a subject with a
   trailing space, an unknown status and provider, a sent row without a message id, a failed row
   without a reason, a dropped row without a reason, more attempts than the limit, a failed row
   under its limit without a retry instant, and a reference kind without its id were refused.
10. **The ticket and its promise.** A stuck payment ticket inside 72 hours was accepted and one
    due in 100 hours was refused; an opener of another merchant was refused with "a ticket
    opener belongs to the merchant of the ticket"; the category, priority, assignment pair,
    deadline order, resolved and closed pairs were each refused by name.
11. **The service level is measured, not claimed.** A first response inside its deadline stored
    `first_response_on_time` true and one after its deadline stored false, read back from the
    generated column; a subject, category or deadline rewrite was refused; a ticket back from
    resolved, a first response rewritten, a resolution instant rewritten and a delete were
    refused; an open ticket moved to `pending_merchant`.
12. **Messages are append only.** An inbound message with its attachment was accepted, an
    outbound email reply with its message id was accepted, and a message of another merchant, an
    email without its message id, an outbound without an author, a bad direction and channel, an
    empty body, a missing attachment, an edit and a delete were each refused.
13. **The public pages.** A draft and a published page were accepted; a published page without a
    person, a slug with a capital, a duplicate slug, a second page for one policy, a policy key
    outside the twelve, a third status, an eighty character SEO title, a slug rewrite and a
    policy key rewrite were refused; a published page could not be deleted until it was
    unpublished, after which the delete passed.
14. **The blog.** A draft with its author and cover was accepted and published; a post without
    an author, a duplicate slug, a published or archived post without its instant, a four
    hundred character excerpt and a missing cover were refused; a slug, an author and the
    publication instant were frozen; a published post could not be deleted; it was archived with
    its instant and could not return to `published`.
15. **The company book.** An income and an expense row were accepted; an income category on an
    expense, an expense category on an income, a third direction, a category outside the twelve,
    a zero amount, a tax larger than the amount, a negative tax, a lower case currency, a bad
    source, a trailing space and a merchant scope were refused; the amount, direction, date and
    recorder were frozen and a delete was refused.
16. **The processor bill.** A received bill stored its billed amount as the variance, and after
    it was disputed and matched with 60000 the variance became 40000; a second bill for the same
    provider and period, an inverted period, a lower case currency, negative amounts, a fourth
    status, a matched bill without its instant and a bad note were refused; a paid before
    matched, a falling matched amount, a rewritten match instant, a step back from matched and a
    delete were refused, and `paid` was reached from `matched`.
17. **The compliance calendar.** A tracked certificate was accepted with its document and owner;
    an unknown kind, an expiry before the issue, a three day and a four hundred day alert, an
    unknown status, a renewed item without its instant, an alert before the row and a bad note
    were refused; the kind and the issue date were frozen, a backward expiry was refused, a
    renewal moved the expiry forward, a backward alert was refused, and the renewed item was
    archived without losing its renewal instant.
18. **Row level security.** A plain role saw zero rows of `email_settings`, `email_templates`,
    `support_tickets`, `cms_pages` and `company_transactions`, and its inserts were refused by
    the policies; a ticket insert by a role the `users` policy hides is refused by the opener
    check first, which is the same fail-closed shape `files` has.
19. **Rollback and re-apply.** The three group rollbacks returned the schema to 57, then 59,
    then 64 tables with their policies, triggers and functions, each group applied again to its
    forward counts, and the full descending chain of all 68 rollbacks emptied the `public`
    schema.

## Verification
- `npm run check:migrations`: `migrations gate passed: 2100 checks, 68 migrations, 67 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0. Structure gate 16 directories, 13 root files and 68 source files;
  config gate 10 sections and 28 values; i18n gate 36 messages; logger gate 117 checks; error
  gate 196 checks; lint gate 77 checks; shell gate 98 checks; jobs gate 110 checks; the
  migrations gate above; then the TypeScript typecheck, the linter and the production build,
  which compiled successfully.
- Gate probe: the first file written was the alter-only `0058`, offered to the gate before any
  other file existed, and it passed with 57 tables unchanged, which settled the risk the
  breakdown named.
- Proof scripts: `/tmp/proof_0322.py` (66 checks), `/tmp/proof_0323.py` (100 checks) and
  `/tmp/proof_0324.py` (70 checks), each ending with `PROOF COMPLETE: 0 FAIL`, plus the full
  descending rollback chain above.

## Errors Found And Corrected In This STEP
1. **The two method checks did not hold their rule.** The API and SMTP field checks were
   biconditionals over the method and a whole field group, and a half present group made the
   right side false, so an `api` row with a lone `smtp_host` and an `smtp` row with a lone
   `api_provider` were both accepted. They are now four checks: each group all present or all
   absent, and the method deciding which group may exist. `email_settings` moved from 29
   constraints to 31 and both refusals are proven.
2. **The renewal pair blocked the archive.** `compliance_items_renewed_check` was the
   biconditional `(status = 'renewed') = (renewed_at is not null)`, so archiving a renewed item
   failed although the guard allows the move - the same family as the quarantine reason of STEP
   031. It is split into a required check and a scope check, and the table moved from 18
        constraints to 19.
3. **The expiry guard compared the wrong way.** The first draft refused `new.expires_on <=
   old.expires_on`, which also refuses every update that leaves the expiry alone, including the
   status walk the guard exists to allow. It is now `<`, and both directions are proven.
4. **A guard that reads another table fails closed for a role the policies hide it from.** The
   ticket guard looks the opener up in `public.users`, and the default-deny policy there hides
   every row from a plain role, so such a role is refused by the guard message rather than by
   the ticket policy. That is the safe direction and STEP 035 gives the office roles their
   `users` policy; the proof records the behaviour instead of claiming the policy spoke first.
5. **A probe must send the column it probes.** The merchant scope probe passed `company_id` to a
   helper whose insert did not carry the column, so a platform row was written and the probe
   reported a success. The insert now sends `company_id` and the platform check is the refusal.
6. **An instant check compares against `created_at`.** Every probe that passes an instant now
   passes `created_at` with it, so the check under test is the one that fires rather than
   `*_instant_check`.

## Decisions And Limits Left For Later STEPs
1. **The services are not here.** STEP 221-222 configure and test the sender, 224 edits the
   templates, 225 wires the activity events, 226 writes the log and 227 retries the failures;
   this STEP stores the row each of them reads.
2. **`api_provider` is a shape, not a list.** Section 23 names no API email provider, so the
   column is a shape checked name and STEP 222 closes the list when it chooses one.
3. **The business calendar is a setting.** The one business day promise for a monetary urgent
   ticket is computed into `first_response_due_at` by the service; only the 72 hour promise is a
   check, because section 24 states it in hours.
4. **One attachment per message.** `support_ticket_messages.file_id` points at one `files` row;
   a second attachment is a second message, and a join table would be an eleventh table no
   screen of 228-229 shows.
5. **The status page is STEP 230's.** Section 24 asks for it and the STEP title does not, so no
   incident table is created here.
6. **The sitemap and the SEO rendering are STEP 237's.** The columns are stored and the
   generation is not.
7. **The compliance alert job is STEP 074's.** `compliance_items_expiry_idx` over `(status,
   expires_on)` is what it reads, and `last_alert_at` is the instant it writes.
8. **The accounting screens are 239-243.** `company_transactions` and `processor_bills` are the
   book they read; the metrics of section 26 are queries, not columns.
9. **No row is seeded.** No template body, CMS page or compliance item is inserted by a
   migration, because a migration that seeded a legal page would freeze words a lawyer must
   approve.
10. **Every table is default-deny until STEP 035.** Nobody but the service role reads them yet;
    the office permissions of STEP 005 and the policies of STEP 035 decide the rest.

## Next Chat Notes
1. Next is STEP 033 - RLS default-deny policies for tenant tables batch one. It reads the tables
   created so far, so the section 2 role vocabulary and the office permissions of STEP 005 are
   the sources to follow.
2. Keep the sub-steps and the approval between them, and ask the owner before starting.
3. Measure every shape with a script before writing the handoff numbers; this STEP caught one
   constraint count, one guard comparison and two rule shapes that way.
4. The gate accepts a forward file that creates no table (`0058` is the precedent), so a
   vocabulary change can be its own numbered file instead of an edit to an earlier migration.
