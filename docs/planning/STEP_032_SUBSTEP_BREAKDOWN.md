// path: docs/planning/STEP_032_SUBSTEP_BREAKDOWN.md
# STEP 032 - Sub-Step Breakdown

This document is sub-step 032.1. It reads the plan, the feature list, the master prompt and the
STEP 031 handoff, measures the schema, fixes the design of the ten tables and the one vocabulary
extension this STEP owns, and then stops for the owner's permission before any SQL is written.
The proof belongs in `docs/handoffs/STEP_032_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 032 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for email settings, templates, send logs, support tickets, CMS and blog
  pages, company accounting and compliance calendar tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- The plan's own sub-steps 4 to 7 (service, API, UI, security review) do not apply to a
  migration STEP, the way STEP 031 read them: the services are STEP 221-243, the screens are
  the same STEPs, and the policies of STEP 035 come next.
- Neighbours: STEP 001 the tenant root, STEP 003 the user, STEP 013 the append-only audit chain,
  STEP 004 the role vocabulary (`super_admin`, `ceo`, `finance_ops`, `compliance_kyc`,
  `support`, `blogger`), STEP 014 the announcements, STEP 016 `payment_providers` for a
  processor bill, STEP 017 the subscription charges a company income row records, STEP 031 the
  `files` row every attachment and document points at, and STEP 0052 `policy_acceptances` whose
  twelve policy keys the CMS policy pages share.
- The STEPs that build on these tables: 221-227 email, 228-229 support, 230 the status page (not
  here), 232-238 CMS and blog, 239-243 company accounting and finance screens, and 074 the
  compliance calendar screen.

### Feature list lines that fix the shape
- Section 23: "super_admin configures email sending by SMTP and by API provider. One sending
  method is active at a time."
- Section 23: "Activating a new configuration requires a successful test email first."
- Section 23: "Email secrets are encrypted and never shown in full after saving."
- Section 23: "Email templates are editable by super_admin." The same section lists the twenty
  activity emails: welcome and verification, password reset, login lock alert, new device alert,
  KYC submitted, approved and rejected, invoice sent, payment received and failed, refund and
  dispute updates, payout sent, settlement released, subscription warnings, service stop and
  restore notices, support replies and account unlock confirmation.
- Section 23: "Every send is logged with template, recipient, status and provider message id.
  Failed sends are retried by background job with a retry limit."
- Section 24: "Support tickets: merchants create tickets, attach files, and receive replies by
  email. Support assigns tickets and changes status."
- Section 24: "Support service level: monetary urgent matters receive a first response within
  one business day. A merchant with a stuck payment receives an answer within 72 hours.
  Service level compliance is recorded."
- Section 25: "Blog posts can be created, edited and published." "Every public page is editable
  through the CMS." "SEO metadata and sitemap are generated for public pages."
- Section 3: "Policies, each as a CMS editable page with versioned merchant acceptance at
  signup", and the twelve names that `policy_acceptances` already closes.
- Section 3: "Cyber insurance record and PCI attestation renewal tracking in a compliance
  calendar with expiry alerts", and section 27 lists "Compliance calendar expiry alerts for
  annual renewals" as a job.
- Section 26: "The platform company has its own accounting area covering company income and
  expenses, processor bill matching, tax calculation and reports", reachable only by
  `super_admin`, `ceo` and `finance_ops`.

### What exists today (measured before writing this document)
- 57 migrations, 57 tables, 57 policies, 106 triggers, 54 functions and 240 indexes in `public`;
  `npm run check:migrations` passes 1770 checks.
- `announcements` (0007) and `announcement_dismissals` (0008) already cover the announcement
  bullet of section 24, so this STEP adds nothing for it.
- `files` (0057) closes five purposes: `kyc_document`, `company_logo`, `invoice_pdf`,
  `dispute_document` and `support_attachment`. It has no purpose for a CMS image or a compliance
  document, which is the one gap this STEP must close before a table can point at a file.
- `policy_acceptances` (0052) closes twelve policy keys: `kyc_kyb`, `ubo`, `aml_cft`,
  `sanctions_pep`, `underwriting`, `merchant_acceptance`, `chargeback`, `refund_settlement`,
  `fraud_risk`, `data_privacy`, `pci_dss` and `automated_decision_review`.
- `provider_keys` (0030) fixes the secret shape this STEP reuses for an email credential:
  `key_ciphertext` 16 to 8192 characters, `key_iv` 12 to 64, `key_tag` 16 to 64,
  `encryption_key_version` 1 to 999 and `aes-256-gcm` as the only cipher.
- Money everywhere is `*_minor bigint` with `currency text` and a three letter upper case check;
  no floating point column exists in the schema.
- The static gate demands of every created table: `id` defaulted to `public.uuid_generate_v7()`,
  `company_id`, `created_at`, `updated_at`, `deleted_at` and `version`, row level security
  enabled in the same file and a `<table>_default_deny` policy that refuses reads and writes; a
  `<name>.down.sql` that drops exactly the tables its forward file creates; a first line
  `-- path: migrations/<name>`; `begin;` and `commit;`; ASCII only and no `TODO`, `FIXME` or
  `XXX`. A forward file with no table is legal, which is what the vocabulary file below uses.

## 2. Decisions This STEP Makes

1. **Ten tables and one vocabulary file, in eleven numbered files, `0058` to `0068`.** STEP 023
   created eight tables in one commit and STEP 028 six, so ten is within the house scale; the
   owner chose the five sub-step split so each group is proven on its own.
2. **The `files` purpose vocabulary is extended by a new migration, not by editing `0057`.**
   `0058_files_purposes.sql` replaces `files_purpose_check` with the same five names plus
   `cms_image` and `compliance_document`, and its down restores the five. Migrations are append
   only, and this is the first file in the chain that alters an earlier table. The gate is
   proven to accept a forward file that creates no table before the file is written; the
   fallback if it does not is to fold each new name into the file that first uses it.
3. **A platform table carries `company_id` null and says so.** `email_settings`,
   `email_templates`, `cms_pages`, `blog_posts`, `company_transactions`, `processor_bills` and
   `compliance_items` are platform rows, each with a `<table>_platform_check check (company_id
   is null)`, the pattern of `provider_keys` and `card_blacklist`. `email_send_logs` keeps a
   real `company_id` for a merchant email and null for a platform one. `support_tickets` and
   `support_ticket_messages` are merchant rows and require it.
4. **One sending method is active at a time, as a database rule.** A partial unique index on
   `status` where `status = 'active'` makes a second active row impossible; `draft` and
   `disabled` rows may exist beside it.
5. **Activation is evidence, the way an active provider key is.** `email_settings_test_check`
   refuses `active` without `last_test_ok` true and `last_tested_at`, mirroring
   `provider_keys_test_check`; section 23's "requires a successful test email first" is a check,
   not a form rule.
6. **`api_provider` is a shape checked name, not a closed list.** Section 23 names no API email
   provider, so the column is `^[a-z][a-z0-9_]{2,31}$` and STEP 222 closes the list when the
   provider is chosen; a closed list invented here would be a guess in a migration. The owner
   approved this reading.
7. **The email credential is the ciphertext quartet, never a plaintext column.**
   `credential_ciphertext`, `credential_iv`, `credential_tag`, `encryption_key_version` and a
   fixed `aes-256-gcm` algorithm; "never shown in full after saving" is then a property of the
   schema, not of a screen.
8. **A method stores only its own fields.** `email_settings_api_fields_check` ties
   `api_provider` and `api_endpoint` to `method = 'api'` and
   `email_settings_smtp_fields_check` ties `smtp_host`, `smtp_port` and `smtp_username` to
   `method = 'smtp'`, so a row cannot be half SMTP and half API.
9. **The twenty activity emails are a closed vocabulary.** `email_templates_template_key_check`
   lists the twenty keys section 23 names, one row per key per locale, and a template is retired
   with `is_active = false`, never deleted, because a send log points at its key.
10. **A send log is history.** It freezes its template key, recipient, subject, provider and
    queued instant; the status walks `queued` to `sent`, `failed` or `dropped`, a failed send
    may still become `sent` on a retry and may become `dropped` when the retry limit is reached;
    `attempts` only rises and never passes `max_attempts`; and the guard refuses a delete,
    because an email that was sent is a record of a message that left the platform.
11. **A duplicate provider message id is refused.** A partial unique index over `provider` and
    `provider_message_id` where the id is not null keeps a webhook or a retry from logging the
    same delivery twice.
12. **Support service level is recorded as instants, not as a claim.**
    `first_response_due_at` and `resolution_due_at` are stored, `first_responded_at`,
    `resolved_at` and `closed_at` are written once, and `first_response_on_time` is a stored
    generated column, so the metric of section 24 is computed by the database and cannot drift
    from the row.
13. **A stuck payment ticket must promise its answer inside 72 hours.**
    `support_tickets_stuck_due_check` refuses `category = 'payment_stuck'` whose
    `first_response_due_at` is later than `created_at + interval '72 hours'`; the one business
    day promise is the default the service writes, not a check, because a business calendar is a
    setting.
14. **One attachment per message, through `files`.** `support_ticket_messages.file_id` points at
    a `files` row of the `support_attachment` purpose, and a second attachment is a second
    message; section 24 asks that attachments exist, and a join table here would be an eleventh
    table for a list no screen in STEP 228-229 shows.
15. **A support message is append only.** The guard refuses every update and every delete, so a
    reply cannot be edited after it was sent by email.
16. **A CMS page is one row per public page, and a policy page carries its policy key.**
    `slug` is unique among live rows, `policy_key` reuses the twelve keys of
    `policy_acceptances` and is unique among live rows, so one policy cannot have two pages and
    a typo cannot invent a thirteenth policy.
17. **A blog post is its own table, not a CMS page.** Section 25 gives a post an author, a cover
    image, an excerpt and an archive state, which a general page does not have; the status walks
    `draft` to `published` to `archived` and never back.
18. **Company money is `bigint` minor units and a three letter currency**, the convention of
    every other money table; `tax_minor` is bounded by `amount_minor`, and no float exists.
19. **A company transaction is corrected, never deleted.** The guard refuses a change to the
    direction, the category, the amounts, the currency, the date and the source, and refuses a
    delete with "a company transaction is corrected by a reversing entry, never deleted",
    because section 26 reports are built on this table.
20. **A processor bill is one per provider and period, and its variance is generated.**
    `variance_minor` is a stored generated column `billed_minor - matched_minor`; the matched
    amount only rises as the matching proceeds; the status walks `received` to `matched` or
    `disputed`, `disputed` to `matched`, and either to `paid`.
21. **The compliance calendar stores the promise, not an alert.** `kind` is a closed vocabulary,
    `expires_on` must be after `issued_on` and may only move forward on a renewal,
    `alert_days` runs from 7 to 365, and `last_alert_at` only moves forward; the job of section
    27 reads `(status, expires_on)` and writes that instant.
22. **Every table carries a comment on itself and on every column**, `set_row_metadata`, row
    level security and its own default-deny policy; the seven tables with a rule the schema
    alone cannot hold a guard too. Nothing is left to a service to remember.

## 3. The Schema This Produces

### `0058_files_purposes.sql` (no table)
Drops `files_purpose_check` and adds it back with the same five names plus `cms_image` and
`compliance_document`; it also rewrites the column comment to name the seven. The down file
drops the seven name check and restores the five name one, so a rollback chain still ends at the
schema STEP 031 left.

### `0059_email_settings.sql`
`id`, `company_id`, `method`, `api_provider`, `api_endpoint`, `smtp_host`, `smtp_port`,
`smtp_secure`, `smtp_username`, `credential_ciphertext`, `credential_iv`, `credential_tag`,
`encryption_algorithm`, `encryption_key_version`, `from_address`, `from_name`, `reply_to`,
`status`, `activated_at`, `disabled_at`, `last_tested_at`, `last_test_ok`, `last_test_detail`,
`created_by` and the four audit columns: 28 columns.

Checks: the primary key; three foreign keys (`companies`, `users` for the creator); the platform
scope; the method vocabulary `smtp` and `api`; the provider shape; the API pair all present or
all absent, the SMTP trio all present or all absent, and the method that decides which set a row
may carry; the https endpoint, the hostname shape and the port range; the ciphertext
bounds, the fixed algorithm and the key version; the sender address, name and reply-to shapes;
the status vocabulary with its two instants; the successful test an active row needs; the detail
length and the three row metadata checks.

Guard: `email_settings_guard_state` freezes the method, the provider, the endpoint, the host,
the port, the username, the sender identity and the credential quartet once the row is `active`;
a change needs the row disabled first. It also freezes `activated_at` and refuses a delete of an
active row.

Indexes: the partial unique `email_settings_active_key` over `status` where `status = 'active'`,
and `email_settings_status_idx` for the settings screen: one plus the primary key.

### `0060_email_templates.sql`
`id`, `company_id`, `template_key`, `locale`, `subject`, `body`, `is_active`, `created_by` and
the four audit columns: 12 columns.

Checks: the primary key; two foreign keys; the platform scope; the twenty key vocabulary; the
locale shape; the subject and body bounds with the trim rule; the three row metadata checks.

Guard: `email_templates_guard_state` freezes the key and the locale, so a row is the template of
one event, and refuses a delete, so a template is retired with `is_active` instead.

Indexes: the unique `email_templates_key` over key and locale, and `email_templates_active_idx`
over the live templates: one plus the primary key.

### `0061_email_send_logs.sql`
`id`, `company_id`, `template_key`, `recipient_email`, `recipient_user_id`, `subject`, `status`,
`provider`, `provider_message_id`, `attempts`, `max_attempts`, `failure_reason`, `queued_at`,
`sent_at`, `failed_at`, `next_retry_at`, `reference_kind`, `reference_id` and the four audit
columns: 22 columns.

Checks: the primary key; two foreign keys (`companies` nullable and the recipient in `users`);
the twenty key vocabulary repeated, because a send log outlives a template edit; the recipient
address shape; the subject bound; the status vocabulary; the provider vocabulary `smtp` and
`api`; the sent pair and the failed pair; the attempt bounds with `attempts <= max_attempts`;
the retry instant a failed row under its limit needs; the provider message id shape; the
reference pair; the three row metadata checks.

Guard: `email_send_logs_guard_state` freezes the template key, the recipient, the subject, the
provider and the queued instant, walks the status as decision 10 describes, keeps `attempts`
rising, freezes `sent_at` and `failed_at` once set and refuses a delete.

Indexes: the partial unique `email_send_logs_message_key` over provider and message id, the
retry sweep `email_send_logs_retry_idx` over `(status, next_retry_at)` where the row failed and
is not deleted, and the merchant history `email_send_logs_company_idx` over
`(company_id, created_at desc)`: three plus the primary key.

### `0062_support_tickets.sql`
`id`, `company_id`, `opened_by`, `subject`, `category`, `priority`, `status`, `assigned_to`,
`assigned_at`, `first_response_due_at`, `first_responded_at`, `first_response_on_time`,
`resolution_due_at`, `resolved_at`, `closed_at`, `resolution_summary` and the four audit
columns: 20 columns.

Checks: the primary key; three foreign keys; the subject bound; the category, priority and
status vocabularies; the assignment pair; the three instants after `created_at`; the 72 hour
promise of a stuck payment; the resolved and closed pairs; the summary bound; the three row
metadata checks. `first_response_on_time` is `boolean generated always as (...) stored`.

Guard: `support_tickets_guard_state` freezes the merchant, the opener, the subject, the category
and the first response due instant, walks the status forward `open` to `pending_merchant` to
`resolved` to `closed`, writes the answer, resolution and close instants once, and refuses a
delete because a ticket is closed, never deleted.

Indexes: `support_tickets_company_idx` over `(company_id, status, created_at desc)` for the
merchant list, `support_tickets_assignee_idx` over `(assigned_to, status)` for the office queue,
and `support_tickets_due_idx` over `first_response_due_at` where the answer is still owed: three
plus the primary key.

### `0063_support_ticket_messages.sql`
`id`, `company_id`, `ticket_id`, `author_user_id`, `direction`, `channel`, `body`, `file_id`,
`email_message_id`, `sent_at` and the four audit columns: 14 columns.

Checks: the primary key; four foreign keys (`companies`, `support_tickets`, `users`, `files`);
the direction and channel vocabularies; the body bound; the email message id shape with the rule
that an email message needs it; the rule that an outbound message has an author; the three row
metadata checks.

Guard: `support_ticket_messages_guard_state` refuses every update and every delete on insert and
on update, and the insert also checks that the ticket belongs to the same merchant.

Indexes: `support_ticket_messages_ticket_idx` over `(ticket_id, created_at)`: one plus the
primary key.

### `0064_cms_pages.sql`
`id`, `company_id`, `slug`, `title`, `body`, `policy_key`, `status`, `seo_title`,
`seo_description`, `published_at`, `published_by`, `created_by` and the four audit columns:
16 columns.

Checks: the primary key; three foreign keys; the platform scope; the slug shape and bound; the
title and body bounds; the twelve policy keys, nullable; the status vocabulary; the published
pair; the SEO bounds; the three row metadata checks.

Guard: `cms_pages_guard_state` freezes the slug and the policy key, refuses a delete of a
published page, and refuses a `published` row without its instant and its person, which the
check already holds so the guard covers the update path.

Indexes: the partial unique `cms_pages_slug_key`, the partial unique `cms_pages_policy_key`, and
`cms_pages_published_idx` over `(status, published_at desc)`: three plus the primary key.

### `0065_blog_posts.sql`
`id`, `company_id`, `slug`, `title`, `excerpt`, `body`, `cover_file_id`, `status`, `author_id`,
`seo_title`, `seo_description`, `published_at`, `archived_at` and the four audit columns:
17 columns.

Checks: the primary key; two foreign keys (`files` for the cover, `users` for the author); the
platform scope; the slug shape; the title, excerpt and body bounds; the status vocabulary; the
published pair and the archived pair; the SEO bounds; the three row metadata checks.

Guard: `blog_posts_guard_state` freezes the slug and the author, walks `draft` to `published`
to `archived` and never back, writes the two instants once and refuses a delete of a published
post.

Indexes: the partial unique `blog_posts_slug_key`, `blog_posts_published_idx` over
`(status, published_at desc)` and `blog_posts_author_idx` over `(author_id, created_at desc)`:
three plus the primary key.

### `0066_company_transactions.sql`
`id`, `company_id`, `direction`, `category`, `amount_minor`, `tax_minor`, `currency`,
`occurred_on`, `source`, `description`, `reference`, `recorded_by` and the four audit columns:
16 columns.

Checks: the primary key; two foreign keys; the platform scope; the direction vocabulary
`income` and `expense`; the income category list and the expense category list, each tied to its
direction; the positive amount and the bounded tax; the currency shape; the source vocabulary;
the description bound; the reference shape; the three row metadata checks.

Guard: `company_transactions_guard_state` freezes the direction, the category, the two amounts,
the currency, the date and the source, and refuses a delete with the reversing entry message.

Indexes: `company_transactions_date_idx` over `(occurred_on desc)`,
`company_transactions_category_idx` over `(direction, category, occurred_on desc)`: two plus the
primary key.

### `0067_processor_bills.sql`
`id`, `company_id`, `provider_id`, `period_start`, `period_end`, `currency`, `billed_minor`,
`matched_minor`, `variance_minor`, `status`, `note`, `document_file_id`, `matched_at`,
`matched_by` and the four audit columns: 18 columns.

Checks: the primary key; four foreign keys (`companies`, `payment_providers`, `files`, `users`);
the platform scope; the period order; the currency shape; the two amounts; the status
vocabulary; the matched pair; the note bound; the three row metadata checks.
`variance_minor` is `bigint generated always as (billed_minor - matched_minor) stored`.

Guard: `processor_bills_guard_state` freezes the provider, the period, the currency and the
billed amount, keeps `matched_minor` rising, walks the status as decision 20 describes, and
refuses a delete.

Indexes: the unique `processor_bills_period_key` over provider and both period ends, and
`processor_bills_status_idx` over `(status, period_end desc)`: two plus the primary key.

### `0068_compliance_items.sql`
`id`, `company_id`, `kind`, `title`, `issuer`, `reference`, `issued_on`, `expires_on`,
`alert_days`, `status`, `document_file_id`, `owner_id`, `last_alert_at`, `renewed_at`, `note`
and the four audit columns: 19 columns.

Checks: the primary key; three foreign keys (`companies`, `files`, `users`); the platform scope;
the kind vocabulary; the title, issuer and reference bounds; the expiry after the issue; the
alert range 7 to 365; the status vocabulary; the renewal instant, required by the renewed state
and legal on an archived row; the alert order; the note bound; the three row metadata checks.

Guard: `compliance_items_guard_state` freezes the kind, the issuer and the issued date, moves
`expires_on` and `last_alert_at` forward only, walks `active` to `expired` or `renewed`, and any
state to `archived`, and refuses a delete.

Indexes: `compliance_items_expiry_idx` over `(status, expires_on)` for the alert job and
`compliance_items_kind_idx` over `(kind, expires_on)`: two plus the primary key.

## 4. The Sub-Steps

### 032.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list, the master prompt and the STEP 031 handoff; measured the
schema; fixed the design above. No file outside this document is touched. It stops for
permission.

### 032.2 - `0058`, `0059` and `0060`
The purpose extension, `email_settings` and `email_templates`: eleven forward and down files in
total for the STEP, three of them here, with a gate probe of the alter-only file before anything
else, a forward apply of `0001` to `0060` and a proof of every rule of the three.

### 032.3 - `0061` to `0065`
The send log, the two support tables, the CMS page and the blog post, with the same proof
discipline: the status walks, the frozen fields, the append-only messages, the duplicate message
id, the 72 hour promise, the two unique keys and the RLS of each table.

### 032.4 - `0066` to `0068`
The company transaction, the processor bill and the compliance item, with the generated
variance, the income and expense category pairing, the forward only expiry and the alert
instants.

### 032.5 - The docs, the verification and the commit
Ten inventory rows and three new rules in `migrations/README.md` (the numbering rule moves from
45 to 48), the database section of `README.md`, one measurement pass for every number in the
handoff, `npm run verify`, the single commit "STEP 032: Migration for email settings, templates,
send logs, support tickets, CMS and blog pages, company accounting and compliance calendar
tables", the push and `docs/handoffs/STEP_032_COMPLETED.md`.

## 5. Files This STEP Owns
- `migrations/0058_files_purposes.sql` and its `.down.sql`.
- `migrations/0059_email_settings.sql` to `migrations/0068_compliance_items.sql`, each with its
  `.down.sql`.
- `migrations/README.md` (the inventory rows, the new rules and the numbering rule).
- `README.md` (the database section only).
- `docs/planning/STEP_032_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_032_COMPLETED.md`.

Nothing else. No `lib/`, `app/`, `services/`, `config/`, `package.json` or earlier migration is
touched, and `migrations/verify.ts` needs no change.

## 6. What This STEP Deliberately Leaves Out
1. **The status page and its incidents.** Section 24 asks for them, but the STEP title does not
   and STEP 230 owns the surface; a status table would be an eleventh table with no proof of its
   shape in this STEP.
2. **The business calendar.** The one business day promise of a monetary urgent ticket is a
   setting the service computes into `first_response_due_at`; a holiday table belongs to the
   jobs and settings STEPs of section 27.
3. **The sitemap and the SEO rendering.** Section 25 asks for generated metadata; the columns
   are here, the generation is STEP 237.
4. **The retry worker.** Section 23's retry is STEP 227; this STEP only stores the attempt
   count, the limit and the next retry instant it reads.
5. **The alert job and the accounting service.** Section 27's compliance alert job and section
   26's reports are STEP 074 and 239-243; the indexes here are what they will read.
6. **The permissive policies.** Every table is default-deny until STEP 035 and the office
   permission model of STEP 005 decide who reads what.
7. **The email provider list and the sending adapters.** STEP 221-222 own them; this STEP stores
   one active configuration and no protocol.
8. **Any seed row.** No template body, no CMS page and no compliance item is inserted by a
   migration; the screens of 224, 238 and 074 write them, and a migration that seeded a legal
   page would freeze words that a lawyer must approve.

## 7. Risks To Prove In 032.2
1. **An alter-only forward file.** `0058` creates no table, so the gate's table loop never runs
   for it; the statements after the transaction wrapper must still be more than two, which the
   drop and the add are. If the gate or a proof expects a table, the fallback of decision 2 is
   the fold into the file that first uses each name.
2. **A stored generated column on a checked table.** `first_response_on_time` and
   `variance_minor` are `generated always as ... stored`; the gate parses table bodies and the
   proof reads `information_schema`, so both must accept the syntax before the later files copy
   it.
3. **The index count.** Every number in the handoff is measured from the catalog at the end of
   032.5, never predicted from this document.

## 8. Corrections From The 032.2 Proof
1. **The two method checks did not hold the rule they claimed.**
   `email_settings_api_fields_check` and `email_settings_smtp_fields_check` were biconditionals
   over the method and a whole field group, and a group that was only half present made the
   right side false, so an `api` row with a lone `smtp_host`, and an `smtp` row with a lone
   `api_provider`, were both accepted. They are now four checks: the API pair is all present or
   all absent, the SMTP trio is all present or all absent, and
   `email_settings_method_api_check` and `email_settings_method_smtp_check` say that the method
   decides which set a row may carry at all. The table moved from 29 constraints to 31, and
   both new refusals are proven.
2. **The instant check compares against `created_at`, not against the wall clock.** A probe that
   passed `now()` from the client before the insert was refused by
   `email_settings_instant_check`, and the constraint was right: the instants may not precede
   the row. The proof now passes `created_at = now()` with them, so the check under test is the
   one that fires.
3. **A narrower check cannot be rolled back over rows it refuses.** The `0058` rollback replaces
   the seven name purpose check with the five name one, so a database holding a `cms_image` row
   refuses the rollback. That is the honest outcome and the down file says it; the proof removes
   the two probe rows first, exactly as an operator would.

## 9. Corrections From The 032.3 Proof
1. **A guard that reads another table fails closed for a role the policies hide it from.** The
   ticket guard looks up the opener in `public.users` to place them in the merchant, and the
   default-deny policy of `users` hides every row from a plain role, so such a role is
   refused by the guard message rather than by the ticket policy. That is the safe direction -
   the write never happens - and STEP 035 gives the office roles their `users` policy; the
   probe records the behaviour instead of pretending the policy spoke first.
   `support_ticket_messages` and `files` have the same shape for the same reason.
2. **A BEFORE trigger speaks before a CHECK.** A status walk probe that also nulled the archive
   instant was refused by the freeze rule ("a post archive instant is recorded once") before the
   walk was reached. The walk is now proven by changing the status alone, which is also how the
   service performs it; the lesson is that a probe changes one thing per write.
3. **An instant check compares against `created_at`, and a defaulted column is later than a
   client clock.** The send log compares `sent_at`, `failed_at` and `next_retry_at` against
   `created_at`, and `queued_at` defaults to `now()` inside the insert, so a probe that passes a
   Python timestamp captured before the insert is refused by the instant check. The probes pass
   `created_at` with their instants and the check under test is the one that fires.

## 10. Corrections From The 032.4 Proof
1. **The renewal pair blocked the archive.** `compliance_items_renewed_check` was the
   biconditional `(status = 'renewed') = (renewed_at is not null)`, so archiving a renewed item
   failed although the guard allows the move: the instant stayed set while the state moved on.
   This is the same shape as the quarantine reason of `files` in STEP 031, and it is split the
   same way: `compliance_items_renewed_required_check` requires the instant for the renewed
   state, and `compliance_items_renewed_scope_check` allows it on `renewed` or `archived` only,
   because it is the history of the renewal. The table moved from 18 constraints to 19.
2. **The expiry guard was written with the wrong comparison.** The first draft refused
   `new.expires_on <= old.expires_on`, which sounds like "moves forward only" but also refuses
   every update that leaves the expiry alone, including the status walk the guard exists to
   allow. It is now `<`, and both directions are proven: a backward expiry is refused and a
   status change that keeps the expiry passes.
3. **A probe must send the column it probes.** The merchant scope probe passed `company_id` to
   a helper whose insert did not carry the column, so a platform row was written and the probe
   reported a success instead of a refusal. The insert now sends `company_id`, and the platform
   check is the refusal that fires.
