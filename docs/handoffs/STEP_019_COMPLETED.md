// path: docs/handoffs/STEP_019_COMPLETED.md
# STEP 019 Completed - Handoff

## STEP
- Number and title: STEP 019 - Migration for subscriptions and subscription charges table
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger and the gate conventions) and STEP 018 (`plans`, which a
  subscription references, and the price lists a charge reads instead of copying). STEP 020 adds the
  clients and services tables, and the billing STEPs 212-220 will drive these rows. The owner granted
  this STEP as one complete pass ("do STEP 019 completely, all at once, flawlessly") instead of five
  approvals, so the five sub-steps are recorded in `docs/planning/STEP_019_SUBSTEP_BREAKDOWN.md` and
  were executed together.

## Files
- Created:
  - migrations/0017_subscriptions.sql and 0017_subscriptions.down.sql - the subscription agreement
    with its cycle, its five status instants, its seven day warning window and the card mandate
    consent quartet, four indexes, trigger, RLS and default-deny policy.
  - migrations/0018_subscription_charges.sql and 0018_subscription_charges.down.sql - one row per
    collection attempt with the balance and card split, the closed failure vocabulary, the retry key
    of subscription, period and attempt number, four indexes, trigger, RLS and policy.
  - docs/planning/STEP_019_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_019_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows and two new rules: a subscription is the agreement and
    never the money, and a charge attempt is a row so a retry is a new row with a visible split.
    The numbering rule moved from 22 to 24 and the intro line now says eighteen files.
  - README.md - the database section describes the subscription, its one live agreement rule, the
    mandate consent and the two charge rules, added directly above the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0016`, every
  `lib/` module, `config/`, the environment contract, card tokens and mandates as card data (023),
  the balance ledger (025), invoices (021), the billing UI, the charge and warning jobs, the
  permissive RLS policies (035) and every code STEP. `package.json` is untouched because the
  migrations gate already covers new files.

## Database
- Migrations added (file names): `0017_subscriptions` and `0018_subscription_charges`, each with its
  `.down.sql`. Together they create two tables, 38 columns, 37 constraints, eight indexes and 30
  comments. The schema now holds eighteen tables, eighteen policies, nineteen triggers and four
  functions in `public`.
- Shape per table: `subscriptions` 20 columns, 19 constraints, four indexes, sixteen comments;
  `subscription_charges` 18 columns, 18 constraints, four indexes, fourteen comments.
- Money is `bigint` minor units with the three letter currency copied onto the charge row; the plan
  price is never stored on the subscription, because STEP 018 versions price lists.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All eighteen
  rollbacks ran in reverse dependency order on a populated database; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers and 0 functions in `public`, and the eighteen forward files
  applied again to a second empty database, recreating exactly eighteen tables, eighteen policies and
  nineteen triggers. The environment has no Docker and no Supabase CLI, so the server was a real
  PostgreSQL 16.2 started locally from the `pgserver` wheel with `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proof seeded synthetic plan codes, mandate
  sentences and amounts in throwaway local databases, and no card number, token or provider value was
  written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
One cross-table script ran against the local PostgreSQL 16.2 with 48 checks; all passed and it ended
with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0018` applied in order and produced eighteen tables, eighteen
   policies and nineteen triggers.
2. **Both table shapes hold.** `subscriptions` reported 20 columns and 19 constraints,
   `subscription_charges` 18 and 18, each with four indexes, RLS on, one policy and one trigger.
   The comments were counted too, sixteen and fourteen, so every column is documented.
3. **A subscription opens as an agreement, not a bill.** A row stored as `pending`, version 1, with
   the mandate text, its version label, the acceptance instant and the address recorded together.
4. **One merchant, one live subscription.** A second agreement for the same merchant was refused by
   `subscriptions_live_key` rather than by code.
5. **The cycle is checked.** An unknown status, a period that ends before it starts and a due instant
   before the period starts were each refused by name.
6. **The seven day warning is a constraint.** A warning sent ten days before the due instant was
   refused by `subscriptions_warning_check`.
7. **Consent is a quartet.** Text without a version, padded text and a version that is not a label
   were each refused, so the database, not the form, decides what a valid consent looks like.
8. **The instant columns agree with the status.** A resume without a stop and a stopped status
   without a stop instant were refused. A cancellation is the only instant that must exist exactly
   when its status does.
9. **The first successful collection activates.** A charge summing the full amount activated the
   subscription, set `activated_at` and moved the version to 2.
10. **Balance first, card second.** A 19,800 charge used 6,000 from the balance and 13,800 from the
    card, and the row keeps both numbers.
11. **The split rule holds in both directions.** A succeeded charge whose shares did not add up and
    a failed charge that took money were both refused by `subscription_charges_split_check`.
12. **A failure names its cause.** A failed charge without a code, a succeeded charge with one, a
    code outside the vocabulary and a detail of 281 characters were each refused.
13. **An outcome instant means an outcome.** A pending charge carrying `completed_at` was refused.
14. **Small shapes are refused.** A zero amount, a negative balance share, a lower case currency and
    attempt number zero were refused by their own constraints.
15. **Retries are rows.** A repeated attempt number inside one cycle was refused by
    `subscription_charges_attempt_key`, and a charge for a subscription that does not exist was
    refused by the foreign key.
16. **Both sources failing stops the services.** Two failed attempts on the due date moved the
    subscription to `stopped` with `stopped_at` set; a successful retry moved it back to `active`
    and set `resumed_at`, which is section 13's restore.
17. **The history adds up.** After three attempts the reading returned three rows, 19,800 collected,
    6,000 from balances and 13,800 from cards.
18. **A warning inside the window moves the version.** A warning inside the current cycle's seven day
    window was accepted at version 5, and one sent earlier was refused.
19. **Cancelling frees the merchant and keeps the history.** A cancelled agreement allowed a second
    live subscription, and the cancelled row stayed readable.
20. **Row level security.** A plain role saw zero subscriptions and zero charges and could not insert
    a charge, while the owner saw two subscriptions and three charges.
21. **Rollback and re-apply.** The eighteen rollbacks emptied the `public` schema completely and the
    eighteen forward files rebuilt it on a second database.

## Verification
- `npm run check:migrations`: `migrations gate passed: 543 checks, 18 migrations, 18 tables, every
  forward file transactional and default-deny` (483 before this STEP).
- Gate mutation probes, each caught and reverted on the new files: removing `enable row level
  security` from `0017` ("table subscriptions must enable row level security in this file"),
  removing `company_id` from `0017` ("table subscriptions is missing the required column
  company_id"), inserting a `truncate` into `0018` ("a forward migration never drops or deletes
  rows") and moving `0018_subscription_charges.down.sql` away ("has no rollback file").
- Behaviour mutation probes, each restored afterwards: tightening `interval '7 days'` to
  `interval '0 days'` in the warning check made the cross-table proof stop with a
  `subscriptions_warning_check` violation on the accepted warning, and weakening the split rule to
  `balance + card <= amount` made it report "a successful charge whose split does not add up :: the
  write succeeded".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 543 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every new and changed file is ASCII (checked with
  `grep -c '[^ -~]'`).

## Errors Found And Corrected In This STEP
1. **A historical instant tied to the cycle.** `activated_at`, `stopped_at` and `cancelled_at` were
   first checked against `current_period_start`, so renewing the subscription moved the period and
   made an already valid activation illegal. The three checks now compare against `created_at` and
   the comment says "A historical instant, not a cycle fact."
2. **A proof that tested the warning window in the wrong order.** The successful warning was written
   after the cycle had been rolled forward, so the instant was 37 days before the new due date and
   the check refused it. The schema was right and the proof's ordering was wrong; the accepted
   instant moved inside the new window and the too-early probe stayed outside it.
3. **A constraint count written before it was measured.** The charge table was expected to hold
   nineteen constraints and holds eighteen; the proof expectation and the rollback file comment were
   corrected rather than the schema.
4. **Two placeholder and quoting faults in the proof harness.** A psycopg call used
   `format('public.%I', %s)` and was rejected; it now passes `'public.' || table` as a parameter.
   Leftover `if False` scaffolding in the resume case was removed so the case actually runs.

## Decisions And Limits Left For Later STEPs
- The subscription stores no price. It references `plans` and the current cycle; the amount lives on
  the charge row, so a price change never rewrites history and a dispute can be answered from the
  charge alone.
- `warning_sent_at` is one instant per subscription. A cycle that is renewed must clear it before the
  new warning is written, and the STEP that runs the job owns that sequence; the schema only refuses
  a warning earlier than seven days before the due date.
- The mandate quartet records consent, not a card. Card tokens, the provider mandate id and the
  card brand belong to STEP 023, which will reference `subscriptions.mandate_*` instead of inventing
  a second consent record.
- `subscription_charges` records money taken, not money held. The balance ledger (STEP 025) is the
  authority for what a merchant actually had, and the charge row stores the split that was attempted.
- Stopping and restoring services is a status change here; the enforcement that closes and reopens
  the merchant's services, and keeps login, billing and support open, runs in code and reads
  `stopped_at`.
- No invoice is created by this STEP. STEP 021 will read `subscription_charges` and the plan in force
  to build the invoice line, and the charge row is the link.
- RLS stays default-deny until STEP 035 grants the merchant their own subscription and the office
  the whole list.

## Next Chat Notes
- Next in this category is STEP 020 (clients, products and services tables). It does not reference
  the subscription; it will be referenced by invoices and by the entitlement checks.
- The live subscription index is partial, on `company_id where cancelled_at is null and deleted_at is
  null`. A query that filters by `company_id` without those predicates will not use it, and a soft
  delete frees the merchant exactly like a cancellation.
- `next_due_at` is the job's index (`subscriptions_due_idx` on `status in ('active','past_due')`).
  The warning job and the charge job must read it, never recompute a due date from the period, and a
  resume must move the cycle forward in the same statement that clears `stopped_at`.
- `attempt_number` is per period. A resumed subscription keeps counting inside its period, so a
  retry after a fix is the next number and never a re-use of one that already exists.
- `failure_detail` is a sentence for a person, at most 280 characters, and no card number, token or
  provider payload may ever be written there; the constraint makes a long payload impossible, not
  merely discouraged.
