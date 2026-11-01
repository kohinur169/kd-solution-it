// path: docs/handoffs/STEP_030_COMPLETED.md
# STEP 030 Completed - Handoff

## STEP
- Number and title: STEP 030 - Migration for card blacklist and velocity counters tables
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 024 (the `payments`
  row that can be the source of a block), STEP 023 (the `payment_providers` catalogue), STEP 003
  (the people who block and release) and STEP 001 (the merchant every row belongs to). STEP 067
  is the velocity counter service, STEP 188 the payment page enforcement, STEP 035 the
  permissive policies, and STEP 147 onwards the adapters that return a card token or a provider
  fingerprint. The owner split this STEP into three sub-steps with an approval between each, and
  the plan is `docs/planning/STEP_030_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0055_card_blacklist.sql and 0055_card_blacklist.down.sql - the blocked card by
    the hash of its token or provider fingerprint, with its source, its provider, its reason,
    its release and its guard.
  - migrations/0056_velocity_counters.sql and 0056_velocity_counters.down.sql - the card and IP
    counter with its window, its count, the limit that applied and the instant of the breach.
  - docs/planning/STEP_030_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_030_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows for `0055` and `0056`, one new rule (a card is
    blocked by a hash and counted in a window), the numbering rule moved from 43 to 44, and the
    introduction now says fifty six files.
  - README.md - the database section describes the blacklist and the counters, directly above
    the `uuid_generate_v7()` bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered
  migration files in `migrations/` and the migrations index. Not touched: migrations `0001` to
  `0054`, every `lib/` module, `config/` (the velocity defaults belong to the configuration
  STEPs), the velocity service (067), the payment page (188), the adapters (147 onwards), the
  permissive RLS policies (035) and every code STEP. `package.json` and `migrations/verify.ts`
  are untouched; the gate needed no change for these two tables.

## Database
- Migrations added (file names): `0055_card_blacklist` and `0056_velocity_counters`, each with
  its `.down.sql`. Together they create two tables with 33 columns, 33 constraints, eight
  indexes, 35 comments, two functions and four triggers. The schema now holds fifty six tables,
  fifty six policies, one hundred four triggers and fifty three functions in `public`.
- Shape per table: `card_blacklist` 19 columns, 19 constraints, four indexes, 20 comments, two
  triggers; `velocity_counters` 14 columns, 14 constraints, four indexes, 15 comments, two
  triggers. Both are default-deny with their own policy.
- No card data is a column. `card_fingerprint` is 64 lower case hex, the SHA-256 of the card
  token or of the provider fingerprint, and `fingerprint_source` says which of the two the
  adapter returned; the proof reads the column list of both tables and compares it with the
  nineteen and fourteen names below, so a card number, an expiry, a CVV or a clear token would
  fail the proof if anyone added one.
- Both tables are platform scoped, the way the provider catalogue is: a nullable `company_id`
  with a `_platform_check check (company_id is null)`, because a card tested across ten
  merchants is one block and one counter, not ten.
- The blacklist has a life. `status` walks `active` to `released` once, a release records the
  person, the instant and the note, one active block exists per fingerprint through
  `card_blacklist_active_key`, and a released fingerprint is free for a new block.
- Neither row is soft deleted. Both guards refuse a change to `deleted_at` with their own
  message, because a deleted block would leave the list without a release and a deleted counter
  would free its window key for a fresh count of zero; an old window leaves by the physical
  delete of the sweep instead.
- A counter is one subject and one window. `num_nonnulls(card_fingerprint, ip_address) = 1`
  keeps a counter either a card counter or an IP counter, `ip_address` is a real `inet`,
  `window_seconds` runs from 1 to 2592000, and the two partial unique keys make the window
  unique per subject. `limit_value` is the configured limit the enforcement applied, because
  section 18 puts the defaults in `config/` and a setting changed later must not rewrite the
  record.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. The two
  rollbacks of this STEP returned the schema to fifty four tables, fifty four policies, one
  hundred triggers and fifty one functions, and the two files applied again to fifty six tables
  and fifty three functions; all fifty six rollbacks ran in reverse dependency order on a
  database with every migration applied and left 0 public tables, 0 policies, 0 triggers and 0
  functions in `public`.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proofs wrote synthetic card
  fingerprints, synthetic addresses from the documentation range and a synthetic provider
  transaction in throwaway local databases, and no real card token, card number, address or
  provider credential was written anywhere.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three scripts ran against the local PostgreSQL 16.2 with 63, 6 and 4 checks, and seven gate
probes; all of them passed and the proof scripts ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0056` applied in order and produced fifty six tables, fifty six
   policies, one hundred four triggers and fifty three functions, and both new tables matched
   their measured shapes exactly.
2. **A card is blocked by a hash.** A block with a 64 hex fingerprint and the `fraud` reason
   waited as `active` at version 1, with the payment that led to it and the person who set it.
3. **No card data and no merchant scope.** The column lists of the two tables equal the nineteen
   and fourteen expected names exactly, so nothing card shaped is a column; a block attached to
   a merchant was refused by `card_blacklist_platform_check`; a fingerprint of three characters
   and an upper case fingerprint were refused by `card_blacklist_fingerprint_check`; a source of
   `pan` and a reason of `testing` were refused by their vocabularies, and an `other` reason
   without a note by `card_blacklist_note_check`.
4. **The release pair.** A release with no person, a release with no note and a status outside
   the two were each refused by name, and an expiry before the block and a block instant after
   the row were refused by the expiry and order checks.
5. **One active block.** The same fingerprint could not be blocked twice while the first row is
   active, and a block naming a payment that does not exist was refused by
   `card_blacklist_payment_fkey`.
6. **A block is frozen and released once.** Changing the fingerprint, the reason or the person
   was refused with "a card block keeps its fingerprint, its source and its reason"; the release
   moved the row to version 2 with its person, instant and note; rewriting it was refused with
   "a released card block is history" and reopening it with "a card block is released once and
   never reopened"; the released fingerprint could then be blocked again.
7. **A soft delete is refused.** Deleting an active block, deleting a released block and
   deleting a counter were each refused with "a card block ends by a release, not by a delete"
   or "a velocity counter is never deleted, only retired by the sweep".
8. **A counter has one subject.** A card counter started at zero and an IP counter stored a real
   address; two subjects and no subject were refused by `velocity_counters_subject_check`, a
   short fingerprint by `velocity_counters_fingerprint_check`, and a window of zero and a window
   of 2592001 seconds by `velocity_counters_window_check`.
9. **The counter fields are bounded.** A limit of zero and a negative count were refused, a
   breach recorded before the count reached the limit by `velocity_counters_exceeded_check`, and
   a window starting after the row by `velocity_counters_start_check`.
10. **One window per subject.** The same card in the same window was refused by
    `velocity_counters_card_key`, and the same address by `velocity_counters_ip_key`.
11. **A counter counts up and a breach is written once.** The count rose to 5 at version 2 and
    the breach was recorded at version 3; counting down was refused with "a velocity counter
    only counts up", clearing the breach with "a velocity breach is recorded once and never
    cleared", moving the last hit backwards with "the last hit of a velocity counter moves
    forward only", and changing the limit, the window or the address with "keeps its subject,
    its window and its limit".
12. **A window can still be retired.** A counter in an old window was removed by a physical
    delete, after which its window key was free for a new counter, which is the retention path
    of STEP 067's sweep.
13. **Every index answers its screen.** The active key over the fingerprint, the block history,
    the payment link, both subject window keys and the sweep over `window_start` were read from
    `pg_indexes.indexdef`.
14. **Row level security.** A plain role with table grants saw no block and no counter and could
    not write either ("new row violates row-level security policy"), while the owner read its
    own row.
15. **Every guard is load bearing.** With `card_blacklist_guard_state` dropped a released block
    was reopened and a block was soft deleted off the list, and with
    `velocity_counters_guard_count` dropped a counter counted down, cleared its breach and was
    soft deleted; restoring each guard refused the same writes again.
16. **Rollback and re-apply.** The two rollbacks returned the schema to fifty four tables, fifty
    four policies, one hundred triggers and fifty one functions, the two files applied again to
    fifty six and one hundred four, and all fifty six rollbacks emptied the `public` schema.

## Verification
- `npm run check:migrations`: `migrations gate passed: 1739 checks, 56 migrations, 56 tables,
  every forward file transactional and default-deny`, exit 0.
- `npm run verify`: exit 0. Structure gate 16 directories, 13 root files and 68 source files;
  config gate 10 sections and 28 values; i18n gate 36 messages; logger gate 117 checks; error
  gate 196 checks; lint gate 77 checks; shell gate 98 checks; jobs gate 110 checks; the
  migrations gate above; then the TypeScript typecheck, the linter and the production build,
  which compiled successfully and prerendered the three routes.
- Gate probes: seven temporary edits were offered to the gate and all seven were caught - a
  missing `enable row level security`, a missing `commit;`, a default-deny policy reading
  `using (true)`, one writing `with check (true)`, an `id` without the shared UUID v7 default, a
  removed required column (`deleted_at`) and a forward file whose rollback was moved away.
- Proof scripts: `/tmp/proof_030.py` (63 checks), `/tmp/detach_030.py` (6 checks) and
  `/tmp/rls_030.py` (4 checks), each ending with `PROOF COMPLETE: 0 FAIL`; the shapes were read
  with `/tmp/measure_0302.py` rather than counted by hand.

## Errors Found And Corrected In This STEP
1. **The payment seed was missing its instants.** A `payments` row seeded as `captured` was
   refused by `payments_authorized_instant_check`, because a captured payment needs its
   authorization instant. The seed now writes an authorized payment with `authorized_at`, which
   is enough for the block to point at it.
2. **A neighbouring check pre-empted the one under test.** The window-start probe set a last hit
   inside the row but before the window, so `velocity_counters_hit_order_check` refused first.
   The probe now passes a last hit inside the new window, and the start check is the refusal
   that fires.
3. **The restore probe tested a column the guard does not freeze.** After reopening a released
   block with the guard dropped, the followed-up write set the note, which an active row may
   change. The probe now changes the reason, which the guard freezes, and the restored guard
   refuses it.
4. **The soft delete was a hole, found by the 030.3 line by line audit.** Both guards froze
   every field except `deleted_at`, so an active block could be deleted off the list without the
   release record, and a counter could be deleted to free its window key for a fresh count of
   zero - the velocity limit bypassed. Each guard now refuses a change to `deleted_at` with its
   own message ("a card block ends by a release, not by a delete", "a velocity counter is never
   deleted, only retired by the sweep"), the column comments and the file headers name the rule,
   the proof and both detach probes were extended, and retention of an old window is the
   physical delete of STEP 067's sweep.
5. **The handoff claimed rollbacks on populated databases.** The two rollbacks of this STEP ran
   on a database with every migration applied but no rows, and the full descending chain ran the
   same way. The sentence now says so, because a handoff must not claim a test that did not run.
6. **The claim that no card data is a column was not proven.** It is now a check: the proof
   reads both column lists from `information_schema` and compares them with the nineteen and
   fourteen expected names, so a card number, an expiry, a CVV or a clear token would fail it.

## Decisions And Limits Left For Later STEPs
1. **The service and its windows are not here.** STEP 067 reads and increments these counters
   and owns the window arithmetic and the sweep; this STEP only refuses a counter that shrinks,
   a breach that is cleared, a subject that changes, a last hit that moves backwards and a row
   that is deleted.
2. **The enforcement is not here.** STEP 188 compares a card and an address against the
   blacklist and the counters on the payment page; the query plan is its job, the shapes and the
   indexes are here.
3. **The defaults live in `config/`.** `limit_value` is required and supplied by the
   enforcement, so a migration never guesses a number the owner changes in settings.
4. **The chargeback thresholds of section 18 are later.** The rate, the minimum transaction
   count and the graduated warning, reserve and suspension action are settings and a job over
   `disputes`, not columns of these tables.
5. **The permissive policies are STEP 035's job.** Both tables are default-deny, so nobody reads
   them yet; the office read of the blacklist and the enforcement read of the counters are that
   STEP's policies.
6. **No retention column and no audit write.** Section 13's seven years is a job over the same
   rows, and any trim of them is a physical delete, because neither table sets `deleted_at`; an
   entry added or released is written to `audit_logs` by the service that performs it, not by a
   trigger here.

## Next Chat Notes
1. Next is STEP 031 - Migration for files and storage records table. It owns the storage side of
   the document rows STEP 028 wrote, so read section 21 of the feature list and keep the bucket
   key, the hash and the metadata apart from the service that signs a link.
2. Keep the sub-steps and the approval between them, and ask the owner before starting.
3. Measure the shape with a script before writing the handoff numbers; this STEP's own design
   document was right this time, but two earlier STEPs were one column off.
4. `npm run check:migrations` now catches a missing required column and a default-deny policy
   that does not refuse reads and writes, so run it after any edit to an older migration.
