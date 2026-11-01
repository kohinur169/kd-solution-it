// path: docs/planning/STEP_030_SUBSTEP_BREAKDOWN.md
# STEP 030 - Sub-Step Breakdown

This document is sub-step 030.1. It reads the plan, the feature list and the STEP 029 handoff,
measures the schema, fixes the design of the two tables this STEP owns, and then stops for the
owner's permission before any SQL is written. The proof belongs in
`docs/handoffs/STEP_030_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 030 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for card blacklist and velocity counters tables".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 024 created `payments`, which carries `card_brand` and `card_last_four` and
  nothing else about a card; STEP 023 created `payment_providers`; STEP 003 `users` (the person
  who blocks and the person who releases). STEP 067 is the velocity counter service, STEP 188
  the enforcement on the payment page, STEP 035 the permissive policies, and STEP 147 onwards
  the adapters that hand back a card token or a provider fingerprint.

### Feature list lines that fix the shape
- Section 18: "Card blacklist entries use card token or provider card fingerprint."
- Section 18: "Card and IP velocity limits exist with defaults in config."
- Section 18: "Card number, expiry and CVV are entered only inside the provider hosted secure
  fields. Platform code and servers never read, store or track card data or keystrokes."
- Section 18: "Chargeback handling follows international card network rules", with thresholds
  configured by super_admin; that is a later STEP and is not a column here.
- Section 3 and section 21 of the plan: `super_admin` and `compliance_kyc` own the security
  decisions, and section 13 keeps data for seven years.
- Every table carries `id` UUID v7, `company_id`, `created_at`, `updated_at`, `deleted_at`,
  `version`, RLS and a default-deny policy.

### What exists today (measured before writing this document)
- 54 migrations, 54 tables, 54 policies, 100 triggers and 51 functions in `public`; the gate
  reports 1677 checks. STEP 029 closed with commit `1930c5d`.
- `payments` has `card_brand`, `card_last_four`, `three_ds_outcome`, `postal_code_matched`,
  `ip_country_matched` and no token, no fingerprint and no card number, which is exactly the
  section 18 promise; the blacklist therefore cannot point at a payment's card by anything but a
  fingerprint the adapter hands back.
- The platform scope precedent exists three times: `payment_providers`, `provider_keys` and
  `routing_rules` all carry a nullable `company_id` and a `_platform_check check (company_id is
  null)`, because the row belongs to the platform rather than to a merchant. `num_nonnulls` is
  already used by `invoice_items` and `estimate_items` to mean "exactly one of these two".
- Nothing in `config/` carries a velocity default yet; the feature list says the defaults live
  there, so this STEP stores the limit a decision used and no default.

## 2. Decisions This STEP Makes

1. **A fingerprint, never a card.** `card_blacklist.card_fingerprint` is 64 lower case hex, the
   SHA-256 of either the provider card token or the provider card fingerprint, and
   `fingerprint_source` records which of the two the adapter returned. No PAN, no expiry, no CVV
   and no clear token is a column, which keeps the section 18 promise and still lets the payment
   page match a returning card by hashing what the adapter hands back.
2. **The blacklist is the platform's, not a merchant's.** Like the provider catalogue, the row
   carries a nullable `company_id` that `card_blacklist_platform_check` forces to null: a card
   used for testing across ten merchants is one entry, not ten, and a merchant cannot read or
   change the platform blacklist. STEP 035 adds the read policy.
3. **A block has a life.** `status` is `active` or `released`, one way, and a released row keeps
   its person, its instant and its note, so history answers who lifted a block and why. The
   guard freezes the fingerprint, its source, the reason, the person and the instant of the
   block, and it refuses every change to a released row.
4. **The reason is a closed vocabulary with a note where it is not enough.** `fraud`,
   `card_testing`, `chargeback`, `stolen_card`, `compliance` and `other`; `other` requires the
   free text note, and a release always requires its own note.
5. **A block may come from a payment.** `source_payment_id` points at the `payments` row whose
   card was blocked, and it is optional because a block can come from a dispute, from a partner
   or from a person reading an alert. A temporary block carries `expires_at`, which must be
   after the block, and a block without one is permanent until a person releases it.
6. **One live block per fingerprint.** `card_blacklist_active_key` is a partial unique index
   over `card_fingerprint` for `active` rows, so a card cannot be blocked twice by two people
   while a released row leaves room for a new block.
7. **A velocity counter has exactly one subject.** `velocity_counters` carries
   `card_fingerprint` and `ip_address` and `num_nonnulls(...) = 1` says one of them is set, so a
   counter is either a card counter or an IP counter and never both. `ip_address` is a real
   `inet`, which keeps CIDR questions answerable; the card side is the same hex fingerprint the
   blacklist uses.
8. **A counter is a window, not a running total.** `window_start` and `window_seconds` name the
   window (the seconds bounded from 1 to 30 days), `hit_count` counts inside it, and the pair is
   unique per subject, so the same second cannot create two counters for one card.
9. **The limit that fired is stored.** `limit_value` is the configured limit the enforcement
   used at that moment and `exceeded_at` is the instant the count first reached it. Config can
   change tomorrow; the row still says which limit was breached, which is what an investigation
  reads.
10. **A counter only grows and a limit only fires once.** The guard freezes the subject, the
    window and the limit, allows `hit_count` to rise and never to fall, allows `exceeded_at` to
    be set once and never cleared, and keeps `last_hit_at` moving forward.
11. **No default lives in the database.** Section 18 puts the velocity defaults in `config/`, so
    `limit_value` is required and supplied by the enforcement code; a migration has no business
    guessing a number that the owner changes in settings.
12. **Neither row is soft deleted.** The soft delete marker exists for the repository's rule and
the guards refuse to set it: a deleted block would leave the list without the person, instant
and note a release records, and a deleted counter would free its window key for a fresh count
    of zero, which is the velocity limit bypassed. A released block is therefore history, and an
    old window leaves by the physical delete of STEP 067's sweep.

## 3. The Schema This Produces

### `0055_card_blacklist.sql`
`company_id` (always null), `card_fingerprint`, `fingerprint_source`, `provider_id`,
`reason`, `note`, `status`, `source_payment_id`, `blacklisted_by`, `blacklisted_at`,
`released_by`, `released_at`, `release_note`, `expires_at` and the four audit columns
`created_at`, `updated_at`, `deleted_at` and `version`: 19 columns.

Checks: the primary key, five foreign keys (`companies`, `payment_providers`, `payments` and two
into `users`), the platform scope, the 64 hex fingerprint, the source, reason and
status vocabularies, the release pair of person and instant, the release note, the note shape,
the expiry after the block, the instant order and the three row metadata checks.
Guard: `card_blacklist_guard_state` freezes the block and walks `active` to `released`.
Indexes: `card_blacklist_active_key` (partial unique over the fingerprint),
`card_blacklist_history_idx` (blocked instant, newest first) and
`card_blacklist_payment_idx` (the blocks that came from one payment): three plus the primary
key.

### `0056_velocity_counters.sql`
`company_id` (always null), `card_fingerprint`, `ip_address`, `window_start`, `window_seconds`,
`hit_count`, `limit_value`, `exceeded_at`, `last_hit_at` and the four audit columns: 14 columns.

Checks: the primary key, the company foreign key, the platform scope, the one subject rule, the
fingerprint shape, the window bounds, the count and limit floors, the exceeded rule (an exceeded
instant requires the count to have reached the limit), the window starts no later than the row,
the last hit inside the window and the three row metadata checks.
Guard: `velocity_counters_guard_count` freezes the subject, the window and the limit, and lets
only the count rise, the breach fire once and the last hit move forward.
Indexes: `velocity_counters_card_key` and `velocity_counters_ip_key` (both partial unique over
subject, window start and window seconds), and `velocity_counters_sweep_idx` (window start, for
the physical delete that retires old windows): three plus the primary key.

Both tables are default-deny with their own policy, and both carry `set_row_metadata`.

## 4. The Sub-Steps

### 030.1 - Inventory, decisions and ownership (this document)
Read the plan, the feature list and the STEP 029 handoff; measured the schema; fixed the design
above. No file outside this document is touched. It stops for permission.

### 030.2 - `0055_card_blacklist.sql` and `0056_velocity_counters.sql` with their rollbacks
The two tables, their foreign keys, checks, guards, indexes and comments, RLS and the policies,
then a forward apply of `0001` to `0056` and a rollback that leaves the schema exactly where
STEP 029 left it.

### 030.3 - The proof, the docs, the verification and the commit
The behaviour proof of every rule (the fingerprint, the platform scope, the block life, the
release pair, the expiry, the one subject rule, the window uniqueness, the rising count, the one
breach, RLS and both rollbacks), the gate and behaviour probes, the two README patches,
`npm run verify`, the handoff file and the single commit "STEP 030: Migration for card blacklist
and velocity counters tables" with its push.

## 5. Files This STEP Owns
- `migrations/0055_card_blacklist.sql` and `0055_card_blacklist.down.sql`
- `migrations/0056_velocity_counters.sql` and `0056_velocity_counters.down.sql`
- `migrations/README.md` (two inventory rows and one rule)
- `README.md` (one STEP bullet)
- `docs/planning/STEP_030_SUBSTEP_BREAKDOWN.md` and `docs/handoffs/STEP_030_COMPLETED.md`
- Not owned and not touched: `0001` to `0054`, every `lib/` module, `config/` (the velocity
  defaults belong to the configuration STEPs), the velocity service (067), the payment page
  enforcement (188), the adapters (147 onwards), the permissive RLS policies (035) and every
  code STEP.

## 6. What This STEP Deliberately Leaves Out
- The counter service and its window arithmetic: STEP 067 reads and increments these rows; this
  STEP only forbids a counter that shrinks or a breach that is cleared.
- The enforcement on the payment page: STEP 188 compares a card and an IP against the blacklist
  and the counters; the queries are its job, the shapes are here.
- The velocity defaults: `config/` owns them, and the row records the limit that was applied.
- The chargeback rate thresholds of section 18 and the graduated action: those are settings and
  a job over `disputes`, not columns of these two tables.
- Card data: no PAN, expiry, CVV or clear token is a column here, because section 18 forbids the
  platform from reading or storing it at all.

## 7. Corrections From The 030.3 Audit

The line by line check of the two files, the two README patches and this document found three
things, and all three are corrected:

1. **The soft delete was a hole.** Both guards froze every field except `deleted_at`, so an
   active block could be deleted off the list without a release, and a counter could be deleted
   to free its window key for a fresh count of zero. Each guard now refuses a change to
   `deleted_at` with its own message, the two column comments and the file headers say so, and
   the sweep of STEP 067 retires a window with a physical delete instead. Decision 12 above is
   the corrected rule.
2. **The sweep index comment promised a soft delete.** It now names the physical delete, because
   a frozen marker would never be set.
3. **One paragraph was indented one step too far** in section 3, and is now aligned with its
   neighbours.
