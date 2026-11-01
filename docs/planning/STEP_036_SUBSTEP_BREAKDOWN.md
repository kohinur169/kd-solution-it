// path: docs/planning/STEP_036_SUBSTEP_BREAKDOWN.md
# STEP 036 - Sub-Step Breakdown

STEP 036 is the last database STEP of the category, and its title names four unrelated looking
objects: an audit hash chain function, a reference seed for countries, a merchant category code
list with the policy pages, and a super_admin bootstrap. They belong to one STEP because they are
the four things a freshly migrated database cannot answer on its own: it cannot verify its own
audit chain, it has no country list and no category list to show a merchant, it has no policy page
for a merchant to accept, and it has no account with which to open the platform.

The owner split the STEP into **two sub-steps**, and this document is the record of that split:

- **036.1 - the audit hash chain as executable SQL.** The canonical string of `0013` becomes seven
  functions: canonical JSON, the v1 hash, the hash of a stored row, the next link of a chain, a
  verification of a chain range, the genesis hash and the Merkle root of a range. It creates no
  table.
- **036.2 - the reference seeds and the first account.** `countries` with 250 seeded rows,
  `mcc_codes` with 981, the twelve policy pages as CMS drafts, and `bootstrap_super_admin()` which
  publishes those pages and creates the one account that can open the platform.

The proof of both sub-steps is one script, and its results are written into
`docs/handoffs/STEP_036_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 036 as written in docs/final/STEP_PLAN_250.md
- Title: "Audit hash chain function, initial reference seed for countries, MCC list and policy
  pages, and super_admin bootstrap".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files in `migrations/`, the migrations index, the handoff and planning folders
  and one bullet in the root README; no `lib/`, `app/` or `services/` file.
- Neighbours: STEP 035 closed the policy layer, so this STEP adds no policy for an existing table
  except the ones its own tables need; STEP 037 opens the authentication category and reads the
  account this STEP can create.

### The rules that fix the shape
- `MASTER_PROMPT.md` rule 1: English only, ASCII in code and seeds. Rule 5: TypeScript strict and no
  `any`, which no migration touches. Rule 8: row level security on every table with a default-deny
  policy. Rule 9: `migrations/README.md` rule 9 in turn forbids a migration from creating an
  extension, a role or a schema, which is why the Ed25519 signature cannot be produced here and why
  the role of the bootstrap is a row and not a Postgres role.
- `migrations/README.md` rule 1: a committed migration is never edited. Rule 5: a forward migration
  never drops a table, truncates or deletes rows, which is why a seed is inserted and removed only
  by the rollback of the file that wrote it. Rule 18: the canonical hash string is defined once, in
  `0013`; this STEP is what makes that sentence executable rather than descriptive.
- FEATURE_LIST section 1 requires a "hash-chained append-only audit log with Ed25519 signing and
  Merkle root export"; section 3 requires a country switch that keeps sanctioned countries disabled
  for ever and twelve policy pages; section 5 requires the Merchant Category Code in onboarding and
  in profile settings and MCC based risk tiers; section 33 makes the first super_admin account with
  2FA enforced a go-live gate.

### What existed before this STEP (measured)
- 74 migrations, 67 tables, 175 policies, 69 functions, 289 indexes, 126 triggers. The whole 74
  file forward chain applies on a clean database and the whole reverse chain leaves an empty
  schema.
- `0013_audit_logs.sql` states the canonical string, the per-tenant chain, the signature shape and
  the Merkle root export as comments and constraints. No function computes any of it.
- `0004_role_assignments.sql` already names the bootstrap: "`granted_by` is null for the bootstrap
  grant of STEP 036".
- `0064_cms_pages.sql` closes the twelve `policy_key` values and allows one live page per key, with
  no rows; `0052_policy_acceptances.sql` closes the same twelve keys for the acceptance record.
- No table in the schema holds a country list or a merchant category code list: `clients.country`,
  `routing_rules.country_code`, `payouts.destination_country`, `payout_bank_accounts.country` and
  `ubo_records.country` are two-letter codes with a shape check and no reference behind them.

## 2. The Two Sub-Steps

### 036.1 - The audit hash chain (migration `0075_audit_chain_functions.sql`)
1. `public.audit_genesis_hash()` returns the sixty-four zeros a first row carries.
2. `public.audit_canonical_json(jsonb)` writes keys in byte order, no whitespace, arrays in order,
   and every scalar in the form `jsonb` prints. Recursive, `immutable`, `strict`.
3. `public.audit_hash_v1(chain, sequence, created_at, actor_user_id, action, entity_type,
   entity_id, payload, prev_hash)` builds the nine segments of `0013` with a vertical bar, renders
   the instant as `YYYY-MM-DDTHH:MM:SS.ffffffZ`, and returns the SHA-256 of the UTF-8 bytes as 64
   lower case hex.
4. `public.audit_log_row_hash(public.audit_logs)` recomputes a stored row from its own columns, so a
   verification never trusts the stored `hash`.
5. `public.audit_next_link(uuid)` returns the sequence and the head hash the next row must carry.
6. `public.audit_verify_chain(uuid, bigint, bigint)` walks a range in sequence order and returns
   `checked_rows`, `is_valid`, the `first_broken_sequence`, a `broken_reason`, and the head it
   reached. It reports a missing row, a row that does not link to the hash before it, and a stored
   hash that does not match the canonical string.
7. `public.audit_merkle_root(uuid, bigint, bigint)` returns the RFC 6962 root of the row hashes of a
   range: a leaf is SHA-256(0x00 || hash) and an internal node SHA-256(0x01 || left || right), and
   an odd node is paired with itself. An empty range returns null rather than a made up root.

### 036.2 - The reference seeds and the first account (migrations `0076` to `0079`)
1. `0076_reference_countries.sql`: the `countries` table, `countries_guard_state`, three indexes,
   five policies and 250 ISO 3166-1 rows. Cuba, Iran, North Korea and Syria carry the sanction flag,
   a note and `is_enabled = false`.
2. `0077_reference_mcc_codes.sql`: the `mcc_codes` table, `mcc_codes_guard_state`, three indexes,
   five policies and 981 published codes, every one `risk_tier = 'unassigned'`.
3. `0078_policy_pages_seed.sql`: the twelve policy pages of section 3 in `cms_pages`, as drafts,
   each with its slug, its title, its body and its SEO pair.
4. `0079_super_admin_bootstrap.sql`: `public.audit_platform_chain()` and
   `public.bootstrap_super_admin(..)`, the once-only first run described in decision 8 below.

## 3. Decisions This STEP Makes

1. **The canonical string is computed by the database, once.** The table can refuse an edit, but
   only a recomputation of the hash detects one. Putting the string in a function means the service
   writer, the verification job and the export job cannot disagree about it, and the proof compares
   the function with an independent implementation in another language.
2. **A null field is an empty segment, and the instant is ISO 8601 UTC with six digits.** `0013`
   names the fields and the order but not the rendering, and a hash is only reproducible when the
   rendering is fixed. `actor_user_id`, `entity_type` and `entity_id` are nullable, so each
   contributes an empty segment and the segment count never changes. The timestamp is written as
   `2026-11-01T08:00:00.123456Z`, which is the microsecond precision the column stores.
3. **Canonical JSON is byte order, compact, and printed the way `jsonb` prints a scalar.** Key names
   on this platform are ASCII lower snake case, so byte order and code unit order agree. Numbers
   keep the scale `jsonb` stores, so `1.50` is hashed as `1.50`.
4. **Nothing signs in SQL.** Ed25519 is not in the PostgreSQL core, and rule 9 forbids an extension,
   so `signature` and `signing_key_id` stay the service's job with `AUDIT_SIGNING_KEY`. The database
   guarantees the shape, the link and the hash; the signature is the second, independent proof.
5. **Verification and the Merkle root are part of the same file.** Section 27 schedules "audit log
   integrity hash generation" and section 31 exports integrity roots, and both need the same
   definition of the root. RFC 6962 domain separation is used because it stops an internal node from
   being passed off as a leaf, and an odd node is paired with itself, which is stated in the file
   because the alternative, promoting the odd node, would produce a different root for the same
   rows.
6. **A reference list is seeded, frozen and never deleted.** Both new tables check `company_id is
   null`, because a country and a card network category belong to the platform. The guard freezes
   the codes, the names and the sanction flag and refuses a delete and a soft delete; the columns
   the office may change are the country switch, the risk tier and the active flag. A change to the
   list is a new migration, which is the review it deserves.
7. **Four comprehensive embargoes are disabled in the seed and cannot be enabled.** Cuba, Iran,
   North Korea and Syria are the four countries on the United States comprehensive embargo list.
   `is_sanctioned` is frozen by the guard, `countries_sanctioned_disabled_check` refuses a row that
   is both sanctioned and enabled, and every other country is enabled at seed time so the platform
   can serve the Asian market it is built for. A country the office disables is a switch that is
   off, and its row stays.
8. **The bootstrap signs before it writes, and runs once.** A caller cannot sign a hash it does not
   know, and the database cannot sign, so the operator: takes an account id from
   `uuid_generate_v7()`, asks `audit_next_link()` for the head and `audit_hash_v1()` for the hash of
   the row it is about to write, signs those 32 bytes, and calls the function with the id, the
   instant, the payload, the hash and the signature. The function recomputes the hash from the same
   inputs, refuses a mismatch, refuses a second live `super_admin`, refuses an address that already
   exists, and then writes the account, the role grant with `granted_by` null, the published policy
   pages and one audit row in one transaction. Execute is revoked from `public`, because a signed in
   merchant must not be able to call it.
9. **The bootstrap publishes the twelve policy pages.** A page is published only with its person and
   its instant, and before the first account there is no person. Seeding the pages as drafts and
   publishing them in the bootstrap keeps both rules: section 3 needs the pages live before a
   signup can accept them, and a published page always names who published it.
10. **The bootstrap creates no TOTP secret, no company, no plan and no session.** Section 22 keeps
    two factor enrolment mandatory at first sign in, and `users.totp_confirmed_at` stays null here
    because no human has enrolled yet; the authentication STEP reads that column as the gate. The
    account is marked email verified because the operator holds the database credential, which is a
    stronger proof than an email link, and that choice is recorded rather than assumed.
11. **The new tables carry their policies in the file that creates them.** STEP 035 left every table
    answering a caller except `job_queue`, and a STEP that added two deny-only tables would undo
    that. `countries` grants `super_admin` full control, `ceo` the switch, four office roles the
    read, and a signed in person the enabled list; `mcc_codes` grants `super_admin` full control,
    `compliance_kyc` the tier, the office the read, and a signed in person the active codes.
12. **No anonymous read is created on either list.** The public site and the signup form are
    rendered by the server, which reaches the tables as the owner, so an anonymous policy would be
    a surface with no feature behind it. This keeps the rule STEP 035 set.
13. **The seeds are data in the migration, not files removed later.** A country or a category code
    that the platform later retires keeps its row, and the forward file never deletes; the rollback
    of the file that wrote the rows is the only place they are removed.

## 4. The Measurement After Each Sub-Step

| After | Migrations | Tables | Policies | Functions | Indexes | Triggers |
| --- | --- | --- | --- | --- | --- | --- |
| STEP 035 | 74 | 67 | 175 | 69 | 289 | 126 |
| 036.1 | 75 | 67 | 175 | 76 | 289 | 126 |
| 036.2 | 79 | 69 | 185 | 80 | 297 | 130 |

The six indexes of 036.2 are three per table, and the count includes the two primary key entries
the two new tables add.

## 5. Files This STEP Owns

- `migrations/0075_audit_chain_functions.sql`, `0076_reference_countries.sql`,
  `0077_reference_mcc_codes.sql`, `0078_policy_pages_seed.sql`,
  `0079_super_admin_bootstrap.sql`, each with its `.down.sql`.
- `migrations/README.md` (five inventory rows, three new rules, the numbering rule moved).
- `docs/planning/STEP_036_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_036_COMPLETED.md`.
- The database section of the root `README.md`, one bullet.
- Not touched: `0001` to `0074`, every `lib/`, `app/`, `services/`, `components/` and `config/`
  file, `.env.example`, `package.json`, `package-lock.json` and `migrations/verify.ts`.

## 6. What This STEP Deliberately Leaves Out

1. **The audit writer.** A service that calls `audit_next_link`, hashes and signs is STEP 056 to
   STEP 067 work, and the bootstrap proves the contract it will use.
2. **The export job.** Section 31 schedules the Merkle root export; this STEP provides the root and
   the verification it will use, and the job itself belongs to STEP 027's queue consumers.
3. **The country and category screens.** The office screens are STEP 068-078 and the onboarding
   screen is STEP 079-099; this STEP provides the rows and the policies they read.
4. **Every country of the world as a merchant country control.** The switch is here; which countries
   a merchant may register from is an underwriting decision made through it.
5. **A risk tier for any category code.** Section 5 gives that decision to the compliance team, and
   guessing 981 tiers in a migration would be an unreviewed underwriting decision.
6. **The policy page versions.** `policy_acceptances` stores a version text and a text hash; which
   version a page is at, and how a page edit produces a new version, is the CMS and signup STEPs'
   decision.
7. **Two factor enrolment for the bootstrap account.** Section 22 requires it at first sign in, and
   STEP 041 builds the enrolment.
8. **A second super_admin.** Office management is STEP 068-078; this STEP creates exactly one
   account and refuses a second bootstrap.

## 7. Risks To Prove

1. **A hash that only the database can reproduce.** The canonical JSON and the v1 hash are compared
   with an independent implementation written for the proof, for objects, arrays, nulls, escapes, a
   vertical bar inside a string and a number with a scale.
2. **A chain that hides a rewrite.** A row is planted with a correct link and a wrong hash, which
   the insert trigger cannot refuse, and the verification must name that sequence.
3. **A gap and a fork.** The two shapes the `0013` trigger must refuse are exercised directly.
4. **A Merkle root that is not the one an auditor computes.** The root of one row, of three, and of
   the whole chain is compared with the independent implementation.
5. **An embargo that a screen could lift.** Enabling a sanctioned country, changing its flag,
   renaming a country, deleting one and soft deleting one are each exercised as the table owner,
   because the owner bypasses row level security and only the guard and the check constraints are
   left to refuse.
6. **An account created twice, or half created.** A second run, a duplicate address, a forged hash,
   a bad signature and a missing policy page are each exercised, and the transaction is read back to
   prove that a refused run wrote nothing.
7. **A list that answers the wrong role.** Each role reads and writes the new tables as a role with
   no `bypassrls`, and the anonymous caller reads nothing.
8. **A rollback that leaves a table behind.** The 79 rollbacks run in descending order to an empty
   schema, and the 79 forward files are applied again to the same catalog.
