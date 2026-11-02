// path: docs/handoffs/STEP_036_COMPLETED.md
# STEP 036 Completed - Handoff

## STEP
- Number and title: STEP 036 - Audit hash chain function, initial reference seed for countries, MCC
  list and policy pages, and super_admin bootstrap.
- Category: Database Schema and Row Level Security (STEP 012-036); this is the last STEP of the
  category.
- Depends on (earlier STEPs in this category and their handoff files): STEP 013 (`audit_logs`, the
  canonical string this STEP makes executable, and the bootstrap grant `0004` names), STEP 004
  (`role_assignments`, the bootstrap grant), STEP 028 (`policy_acceptances`, the twelve policy keys),
  STEP 032 (`cms_pages`, the twelve policy keys and the published pair), STEP 033, 034 and 035 (the
  actor helpers and the completed policy layer this STEP extends with two reference tables).
  The split of this STEP into two sub-steps is `docs/planning/STEP_036_SUBSTEP_BREAKDOWN.md`:
  **036.1** the audit hash chain as seven functions, **036.2** the reference seeds and the first
  account.

## Files
- Created:
  - migrations/0075_audit_chain_functions.sql and its `.down.sql` - seven chain functions, no table.
  - migrations/0076_reference_countries.sql and its `.down.sql` - the `countries` table, its guard,
    three indexes, five policies and 250 seeded rows.
  - migrations/0077_reference_mcc_codes.sql and its `.down.sql` - the `mcc_codes` table, its guard,
    three indexes, five policies and 981 seeded rows.
  - migrations/0078_policy_pages_seed.sql and its `.down.sql` - the twelve policy pages of section 3
    in `cms_pages`, as drafts.
  - migrations/0079_super_admin_bootstrap.sql and its `.down.sql` - `audit_platform_chain()` and
    `bootstrap_super_admin()`, execute revoked from `public`.
  - docs/planning/STEP_036_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_036_COMPLETED.md.
- Modified:
  - migrations/README.md - five inventory rows (`0075` to `0079`), three new rules (54 the chain is
    computed here and signed outside, 55 a reference list is seeded and never deleted, 56 the
    bootstrap runs once and is signed before it writes), the numbering rule moved from 54 to 57, and
    the introduction now counts seventy nine files.
  - README.md - one database bullet describing the chain functions, the two reference seeds, the
    twelve policy pages and the bootstrap, directly above the STEP 035 bullet.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): the numbered
  migration files in `migrations/`, the migrations index, the planning and handoff folders, and the
  database section of the root `README.md`. Not touched: migrations `0001` to `0074`, every `lib/`,
  `app/`, `services/`, `components/` and `config/` file, `.env.example`, `package.json`,
  `package-lock.json` and `migrations/verify.ts`.

## Database
- Migrations added (file names): `0075_audit_chain_functions.sql`, `0076_reference_countries.sql`,
  `0077_reference_mcc_codes.sql`, `0078_policy_pages_seed.sql` and
  `0079_super_admin_bootstrap.sql`, five forward files and five rollbacks. The schema now holds 79
  migrations, 69 tables, 185 policies (69 of them deny and 116 permissive), 80 functions, 297
  indexes and 130 triggers in `public`. After 036.1 alone it held 76 functions and was otherwise
  unchanged; 0076 added one table, five policies, one function, four indexes and two triggers; 0077
  added the same again; 0078 added no object; 0079 added two functions.
- **036.1, the chain.** Seven functions, and no new table, because `audit_logs` already stores the
  chain. `audit_genesis_hash()` is the sixty-four zeros of a first row. `audit_canonical_json(jsonb)`
  writes an object with its keys in byte order and its separators compact, an array in stored order,
  and a scalar the way `jsonb` prints it. `audit_hash_v1(...)` renders the nine fields `0013` names
  with a vertical bar, with an empty segment for a null `actor_user_id`, `entity_type` or `entity_id`
  and with `created_at` as `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC, and returns the SHA-256 of the UTF-8
  bytes as 64 lower case hex. `audit_log_row_hash(public.audit_logs)` recomputes a stored row from
  its own columns. `audit_next_link(uuid)` returns the sequence and head hash a writer must extend.
  `audit_verify_chain(uuid, bigint, bigint)` walks a range in sequence order and returns
  `checked_rows`, `is_valid`, `first_broken_sequence`, `broken_reason` and the head it reached, and
  it names a missing row, a row that does not link to the hash before it, and a stored hash that does
  not match the canonical string. `audit_merkle_root(uuid, bigint, bigint)` returns the RFC 6962
  root of the row hashes, a leaf being SHA-256(0x00 || hash) and an internal node
  SHA-256(0x01 || left || right), an odd node paired with itself, and null for an empty range. No
  function signs: Ed25519 is not in the core and rule 9 forbids an extension, so `signature` and
  `signing_key_id` stay the service's job.
- **036.2, the countries.** `countries` holds the alpha-2, alpha-3 and numeric code, the English
  name, `is_sanctioned` with its `sanction_note`, and `is_enabled`; `company_id` is checked null
  because the list is the platform's. `countries_guard_state` refuses every delete and every soft
  delete, freezes both codes, the numeric code, the name, the sanction flag and its note, and so
  leaves `is_enabled` as the only column an office may change. `countries_sanctioned_disabled_check`
  refuses a row that is both sanctioned and enabled. The seed is 250 ISO 3166-1 rows, 246 enabled and
  four disabled with their note: Cuba, Iran, North Korea and Syria, the four countries on the United
  States comprehensive embargo list. Three indexes (unique `code`, unique `alpha3`, and the enabled
  dropdown in code order) and five policies.
- **036.2, the category codes.** `mcc_codes` holds a four digit `code` as text, the published
  `title`, `risk_tier` in `unassigned` / `low` / `medium` / `high`, and `is_active`. The guard
  freezes the code and the title and refuses every delete and soft delete, so a retired code keeps
  its row. The seed is 981 published codes, every one `unassigned` and active, with the three codes
  that begin with zero stored as text and the longest title at 142 characters.
- **036.2, the policy pages.** The twelve keys of section 3 are seeded into `cms_pages` as drafts,
  one row per key, with their slug, their title, the operative text of the policy and the SEO pair:
  `kyc_kyb`, `ubo`, `aml_cft`, `sanctions_pep`, `underwriting`, `merchant_acceptance`,
  `chargeback`, `refund_settlement`, `fraud_risk`, `data_privacy`, `pci_dss` and
  `automated_decision_review`. A page is published only with its person and its instant, and no
  person exists before the bootstrap, so draft is the only honest state here and the bootstrap is
  what publishes them.
- **036.2, the bootstrap.** `bootstrap_super_admin(p_user_id, p_email, p_full_name, p_password_hash,
  p_bootstrapped_at, p_payload, p_hash, p_signature, p_signing_key_id)` runs once per database. It
  refuses when a live `super_admin` exists, when the address is already used, when a value is not in
  the shape the table would accept, when the instant is in the future or older than five minutes,
  when the payload is not an object of at most 8192 bytes, when the hash is not the canonical one of
  the current head, and when the twelve policy pages are not all present as drafts. It writes one
  `users` row (verified, active, no company, no TOTP secret), one `role_assignments` row with
  `granted_by` null - the bootstrap grant `0004` names - publishes the twelve pages with that person
  as publisher, and writes one `audit_logs` row (`platform.super_admin_bootstrapped`, entity type
  `user`) on the platform chain. Execute is revoked from `public`, so the application role cannot
  call it; the owner of the database is the only caller.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 18.6 (the PGlite 0.5.14
  WebAssembly build of PostgreSQL 18.6, which is what this environment provides; the version string
  was read from `version()` and is recorded rather than assumed). The 79 rollbacks ran in descending
  order and left 0 tables, 0 policies, 0 functions, 0 indexes and 0 triggers in `public`; applying
  the 79 forward files again returned the same 69 tables, 185 policies, 80 functions, 297 indexes
  and 130 triggers, with the country seed, the category seed and the chain functions answering
  again. Each of the five new rollbacks was also run inside that chain, and the four earlier
  reference rollbacks of `0078` removed exactly the twelve rows the forward file wrote.

## Environment
- Environment variables added to .env.example: none. The chain reads nothing from the environment;
  `AUDIT_SIGNING_KEY` and `DATABASE_URL` already exist in the manifest and are still read only
  through it, by the service that signs.
- Secrets handled (names only, never values): none. The proof signed with a throwaway Ed25519 key
  pair generated inside the proof process, used a synthetic password hash, and wrote no real key,
  signature, credential or password anywhere. The seed carries no secret: a country note and a card
  network category description are public data.

## Packages
- Package requests for the integrator (name, reason), or none: none. `package.json` is unchanged.
  The proof harness (PGlite and a throwaway Ed25519 key pair) ran outside the repository and left no
  dependency, no lock file change and no test file in it.

## Behaviour Proof (acceptance checklist)
One proof script ran three databases against PostgreSQL 18.6 and asserted **91 checks; all 91
passed**. The first database took the 79 forward files on a clean schema, the second proved that a
refused bootstrap is atomic, and the third proved the second apply after a full rollback. Every role
test was spoken by `proof_app`, a `nologin` role with no `bypassrls` and only schema usage and table
grants.

1. **The canonical string, checked against another implementation.** `audit_canonical_json` matched
   an independent implementation for five payloads - nested objects with unsorted keys, arrays with
   nulls and booleans, an empty object, an empty array inside an object, and a string containing a
   quote, a backslash and a vertical bar - and kept the stored scale of `1.50`. `audit_hash_v1`
   produced the same 64 hex characters as SHA-256 of the canonical string assembled independently
   (`bff3232e...` for the fixed case), and the genesis hash read as sixty-four zeros.
2. **A chain written the way a service writes it.** Three rows were written one at a time, each
   taking its sequence and `prev_hash` from `audit_next_link()` and its hash from the independent
   implementation; each insert was accepted, a verification of the three returned
   `checked_rows = 3` and `is_valid = true`, `audit_next_link()` then returned sequence 4 with the
   head hash, and `audit_log_row_hash` recomputed the stored hash of row 2 exactly.
3. **A rewrite is named.** A fourth row was planted with a correct link and a wrong stored hash,
   which the `0013` insert trigger cannot refuse because it checks the link and not the hash; the
   verification returned `is_valid = false`, `first_broken_sequence = 4` and the reason "the stored
   hash does not match the canonical string of the row". A gap of ninety was refused with "audit
   chain ... expects sequence 5, got 90", and a row linked to the genesis instead of the head was
   refused with "does not link to the current head".
4. **The Merkle root.** The root of one row equalled its leaf, the root of three rows equalled the
   independent implementation (the odd node paired with itself), the root of the whole range matched
   as well, an empty range returned null, and a reversed range raised. A range that starts past the
   head is refused, and a chain with no rows yet verifies as valid with zero rows and the genesis as
   its head.
5. **The country seed.** 250 rows, 246 enabled, four sanctioned and noted, unique alpha-2, alpha-3
   and numeric codes, and every row inside its shape checks. Enabling a sanctioned country was
   refused by `countries_sanctioned_disabled_check`; renaming a country, changing the sanction flag,
   deleting a row and soft deleting a row were each refused by `countries_guard_state`; the switch
   itself was written and moved `version` to 2.
6. **The category seed.** 981 codes, all active and all `unassigned`, three of them beginning with
   zero, the longest title 142 characters, every code four digits. Changing a published title,
   deleting a row and soft deleting a row were refused by the guard; the risk tier was written and
   an unknown tier was refused; the longest title fits the 200 character check.
7. **The policy pages.** Twelve rows, twelve distinct policy keys, twelve distinct slugs, all drafts,
   each with a body of more than 400 characters and both SEO fields.
8. **A refused bootstrap writes nothing.** On the first database, a hash that was not the canonical
   one, a signature that was not 86 base64url characters, an upper case address, a padded name, a
   password hash of five characters, an instant an hour in the future, an array payload and a
   malformed signing key id were each refused with the message that names the argument. On the
   second database a page was removed first: the call was refused with "the twelve policy pages of
   section 3 must be present as drafts, found 11" and the read back showed 0 users, 0 role
   assignments, 0 audit rows and 0 published pages, so the account, the grant, the publication and
   the audit row are one transaction.
9. **The bootstrap, observed.** The call returned the account id it was given. The `users` row read
   as verified, active, company free and with `totp_confirmed_at` null. The `role_assignments` row
   read as `super_admin` with `granted_by` null and no company. All twelve pages read as published,
   with one distinct publisher, and that publisher was the new account. The audit row read as
   sequence 5 on the platform chain with `actor_user_id` null, `entity_type = user`, the account as
   its entity, the payload that was hashed, the head it was signed against and the key id; its
   Ed25519 signature verified over the 32 byte hash with the public half of the proof key pair, and
   `audit_verify_chain` from sequence 5 returned valid with that hash as the head. The chain still
   breaks exactly at the planted row 4 and nowhere else.
10. **Once means once.** A second call with a fresh id and hash was refused with "a live super_admin
    already exists: the bootstrap runs once per database". After the grant was revoked as the owner,
    the same address was refused with "an account already uses this email address". Execute was read
    back as not held by `public`, and the application role was refused when it tried to call the
    function.
11. **The policies of the two new tables, by role.** An anonymous caller read 0 countries and 0
    category codes. A merchant read the 246 enabled countries - no sanctioned row among them - and
    the 981 active codes, and its update of a switch touched 0 rows. Support read all 250 countries
    and all 981 codes and changed neither. Compliance read all 250 countries, set a risk tier on one
    code and flipped no switch. The chief executive flipped one switch and set no tier. `super_admin`
    read everything, set a tier and flipped a switch. The bootstrap was refused to the application
    role.
12. **The rollback and the second apply.** The 79 rollbacks ran in descending order without an error
    and left an empty `public`; the 79 forward files applied again returned the same catalog, the
    same 250 countries, the same 981 codes and a working genesis hash.

## Verification
- `npm run check:migrations`: "migrations gate passed: 2342 checks, 79 migrations, 69 tables, every
  forward file transactional and default-deny", exit 0.
- `npm run verify`: exit 0, with the structure, config, i18n, logger, error, lint, shell, jobs and
  migrations gates passing (structure 16 directories and 68 source files, env 16 variables, config
  10 sections and 28 values, i18n 36 messages, logger 117 checks, error 196 checks, lint 77 checks,
  shell 98 checks over 12 files, jobs 110 checks, migrations 2342 checks), followed by the
  TypeScript typecheck, `eslint .` and the production build, which compiled successfully and
  prerendered the three static pages with the two dynamic routes.
- Typecheck result: `tsc --noEmit`, exit 0.
- Lint result: `eslint .`, exit 0, no warning.
- Build result for the touched area: the production build passed. No `app/` or `lib/` file was
  touched by this STEP; the build is recorded because `npm run verify` runs it.
- Note on the runtime: this sandbox runs Node.js 22.22.3 while `.nvmrc` and the `engines` field pin
  26.13.0, so the install that makes the gates runnable used `--engine-strict=false` locally and
  `package.json` and `package-lock.json` were left untouched. The migration gate, the typecheck, the
  lint and the build are unaffected by that, and no file in the repository records the workaround.

## Next
- Next STEP number: STEP 037 - Supabase Auth client and server helpers with typed session access,
  the first STEP of the Authentication and Session Security category (STEP 037-055).
- Anything the next chat must know:
  - **The audit writer contract is fixed now.** To write a row: `select * from
    audit_next_link(chain_id)` for the sequence and `prev_hash`, then
    `select audit_hash_v1(chain_id, sequence, created_at, actor_user_id, action, entity_type,
    entity_id, payload, prev_hash)`, sign those 32 bytes with the Ed25519 key derived from
    `AUDIT_SIGNING_KEY`, and insert with that hash and signature. A migration may never add a second
    implementation of the canonical string; `migrations/README.md` rule 54 says so.
  - **The bootstrap runbook, for the go-live gate.** As the database owner:
    `select public.uuid_generate_v7();` for the account id, then
    `with head as (select * from public.audit_next_link(public.audit_platform_chain())), instant as
    (select clock_timestamp() as at) select instant.at::text, head.next_sequence, head.prev_hash,
    public.audit_hash_v1(public.audit_platform_chain(), head.next_sequence, instant.at, null,
    'platform.super_admin_bootstrapped', 'user', :user_id, :payload, head.prev_hash) from head,
    instant;`, sign the hash, and call `bootstrap_super_admin(...)` with the same instant. The call
    must happen within five minutes of the instant and while the twelve policy pages are still
    drafts. The account it creates has no TOTP secret, so section 22 needs the enrolment STEP before
    the go-live gate "first super_admin account created with 2FA enforced" can be ticked.
  - **`audit_verify_chain` and `audit_merkle_root` run as the caller.** They read `audit_logs` under
    its policies, so the export job and any integrity sweep must connect as the owner, otherwise a
    merchant session verifies its own visible rows only. That is deliberate: the functions leak no
    row content, but a verification that silently sees a subset must not be mistaken for a whole
    chain.
  - **The bootstrap publishes the twelve policy pages.** A page edit later is an ordinary CMS
    update, and the version a merchant accepts still has to be decided by the signup STEP: the page
    carries `version` as the optimistic counter, and `policy_acceptances.policy_version` is free
    text, so a policy version scheme is that STEP's decision and not this one's.
  - **`countries` and `mcc_codes` are seeded only.** Compliance sets the tiers, and the office flips
    the country switch; a change to a code, a name or a sanction flag is a new migration by design.
    `sanctioned` means the four United States comprehensive embargoes, and a wider list is a
    reviewed migration rather than a screen action.
  - **The seed rows carry no audit entry of their own.** They are written by the migration owner
    before any account exists, so there is no actor to name; the platform chain begins with the
    bootstrap row, and `migrations/README.md` rule 55 records that rather than leaving it implicit.
  - **No anonymous policy was created.** The public site and the signup form are rendered by the
    server, which reaches these tables as the owner; a future STEP that wants an anonymous read must
    add the policy deliberately and say why.
