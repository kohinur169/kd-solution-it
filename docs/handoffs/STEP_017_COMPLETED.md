// path: docs/handoffs/STEP_017_COMPLETED.md
# STEP 017 Completed - Handoff

## STEP
- Number and title: STEP 017 - Migration for audit logs append-only hash chain table
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger and the gate conventions), STEP 013 (`users`, the
  actor), STEP 015 (`sessions`, an entity the log names) and STEP 016 (`account_locks`, whose
  unlocks section 22 requires to be logged). The owner asked for this STEP in five sub-STEPS, one
  approval at a time; the plan is `docs/planning/STEP_017_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0013_audit_logs.sql and 0013_audit_logs.down.sql - the audit table with its generated
    chain, gapless sequence, hash link, Ed25519 signature columns, seven query indexes, the
    append-only guard, the chain guard, RLS and the default-deny policy.
  - docs/planning/STEP_017_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_017_COMPLETED.md.
- Modified:
  - migrations/README.md - one inventory row and two new rules: the log is append-only and hash
    chained with one canonical hash string, and every row is signed while Merkle roots are derived
    by the export job.
  - README.md - the database section describes the audit log.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0012`, every
  `lib/` module including `lib/logger/`, `config/`, the environment contract, the Merkle export job
  and its schedule, the permissive RLS policies (035), any signing key material (configuration and
  secrets, never a migration) and every code STEP. `package.json` is untouched because the
  migrations gate already covers new files.

## Database
- Migration added (file name): `0013_audit_logs`, with its `.down.sql`. It creates one table with 20
  columns, 19 constraints, seven indexes plus its primary key, eighteen comments, two guard
  functions, two triggers and one policy; the schema now holds thirteen tables, thirteen policies,
  fourteen triggers and four functions in `public`.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All thirteen
  rollbacks ran in reverse dependency order on a populated database; afterwards the catalog reported
  0 public tables, 0 policies, 0 triggers in `public` and 0 functions in `public`, and the thirteen
  forward files applied again to a second empty database, recreating exactly thirteen tables,
  thirteen policies and fourteen triggers. The environment has no Docker and no Supabase CLI, so the
  server was a real PostgreSQL 16.2 started locally from the `pgserver` wheel with `psycopg` as the
  client.

## The Canonical Hash String (authoritative, do not redefine)
```
v1|<chain_id>|<sequence>|<created_at>|<actor_user_id>|<action>|<entity_type>|<entity_id>|<payload>|<prev_hash>
```
- `created_at` is formatted as `YYYY-MM-DDTHH:MM:SS.ffffffZ` in UTC, with six fractional digits.
- `actor_user_id`, `entity_type` and `entity_id` are the empty string when null.
- `payload` is `json.dumps` with sorted keys and the separators `,` and `:` (no spaces).
- The digest is `sha256` over the UTF-8 bytes, written as 64 lower case hex characters.
- The signature is Ed25519 over the 32 raw digest bytes, base64url without padding, 86 characters.
- `signing_key_id` is a lower case slug such as `audit-2026-01`; it names the key, never stores it.

The Merkle convention for the export job: leaf = `bytes.fromhex(hash)`, parent =
`sha256(left || right)`, an odd level duplicates its last leaf, the root is the final hex string.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none persisted. The proof generated a throwaway Ed25519
  key in memory to sign and verify three entries; no key, seed or signature from it is stored in the
  repository.

## Packages
- Package requests for the integrator (name, reason), or none: none. The proof used the vendored
  `cryptography` wheel in its own throwaway virtual environment; the application's dependencies are
  unchanged.

## Behaviour Proof (acceptance checklist)
Three throwaway scripts ran against the local PostgreSQL 16.2 with 34, 18 and 18 checks; all passed
and each ended with `PROOF COMPLETE`.

1. **Forward apply.** `0001` to `0013` applied in order and produced thirteen tables, thirteen
   policies and fourteen triggers.
2. **The chain starts correctly.** The first row of a tenant chain points at the genesis hash of
   sixty-four zeros, `chain_id` is generated from `company_id`, and a platform row (company_id null)
   gets the zero uuid chain of its own.
3. **The link is enforced on write.** A first row that does not start at sequence 1, a first row
   that points at a real hash, a skipped sequence, a forked sequence and a row that links to the
   wrong parent are each refused by the guard, with the expected sequence in the message.
4. **One position per chain.** `audit_logs_chain_key` is unique on `(chain_id, sequence)` and
   `audit_logs_hash_key` is unique on `hash`; a hash that already exists in another chain is refused.
5. **The shape is checked.** An action that is not a dotted key, an over-long action, an entity type
   without an entity id, a payload that is not an object, a payload over 8192 bytes, a hash that is
   not lower case hex, a signature of the wrong length, a signing key that is not a slug, an actor
   who does not exist and a 513 character user agent were each refused by name.
6. **The table is append-only.** An update and a removal are both refused with
   `public.audit_logs is append-only: UPDATE is not permitted`, including when the table owner
   issues them, and every row survived both attempts.
7. **The hash is real.** Three entries were signed with a generated Ed25519 key, the stored hash
   matched the hash recomputed from the stored columns through the canonical string, and all three
   signatures verified against the hash. A signature does not verify against another entry's hash.
8. **Verification finds nothing when nothing is wrong, and something when it is.** The documented
   chain query returned zero breaks on the live table and exactly one on a deliberately broken copy,
   so the check has discriminating power.
9. **Merkle roots behave.** The root over the three leaves changed when a fourth entry was appended,
   and was reproducible for the same leaves.
10. **Tampering is visible and cannot be repaired.** A changed payload produced a different hash, the
    recomputed root differed, and the in-place repair of the row was refused by the append-only
    guard.
11. **Real events from earlier STEPs fit.** A `session.revoked`, an `account.unlock` and a
    `permission.granted` were written with their real actor, entity and payload; every entity named
    by the log existed in its own table, the session event carried its `session_id`, and each
    payload held the before and after values.
12. **No secret is logged.** None of the payloads contains the words password, secret, token, bearer
    or totp, and the scan that looks for them returned zero.
13. **Row level security.** A plain role saw no row, its insert was refused by the policy, and its
    update touched zero rows because it cannot see one; the owner's update was then refused by the
    append-only guard.
14. **Rollback and re-apply.** The thirteen rollbacks emptied the `public` schema completely and the
    thirteen forward files rebuilt it on a second database.

## Verification
- `npm run check:migrations`: `migrations gate passed: 393 checks, 13 migrations, 13 tables, every
  forward file transactional and default-deny` (363 before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security`, removing
  `company_id`, inserting a `truncate`, and removing the rollback file. The gate is back to 393.
- Behaviour mutation probes, each caught and reverted: removing the append-only trigger made the
  shape proof fail with "an edit of an audit row :: the write succeeded"; opening the default-deny
  policy to `using (true)` made the cross-table proof fail with "a plain role sees no audit row".
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 393 checks; `Compiled successfully`. The route table is unchanged.
- No placeholder marker was added; every SQL and doc file is ASCII.

## Errors Found And Corrected In This STEP
1. **A stored generated column is empty inside a before-insert trigger.** The chain guard first read
   `new.chain_id` and therefore treated every row as the first row of a new chain, so the second
   insert in a chain failed with "starts at sequence 1, not 2". The guard now derives the chain from
   `company_id` exactly as the generated column does, and the comment in the function says why.
2. **Two guards can refuse the same write, and the first one wins.** Several negative probes aimed at
   a uniqueness or format rule were actually stopped by the chain guard, because the probe did not
   sit on the head of its chain. Each probe now satisfies the chain rule so that the refusal names
   the constraint under test; where a rule is unreachable behind the guard (a malformed `prev_hash`,
   a duplicate sequence), the proof asserts the catalog definition instead of claiming a refusal it
   cannot obtain.
3. **A probe that "succeeded" had changed nothing.** Updating the table as a plain role reported
   success because row level security hides every row, so zero rows were touched. The proof now
   asserts `rowcount == 0` for that case and keeps the owner's update as the case that proves the
   append-only guard.

## Decisions And Limits Left For Later STEPs
- Signing keys are configuration and secrets, never schema. `signing_key_id` exists so a rotation
  leaves old rows verifiable; the key material and the rotation procedure belong to the security
  STEPs, and section 30 requires that rotation to be audit logged too.
- Merkle roots are exported by a job (sections 27 and 31); this table stores the leaves. A roots
  table, if one is ever needed, is a new migration in the STEP that owns that job.
- The audit writer is a code STEP. It must use the canonical string above verbatim, take the chain
  head under its own serialisation (the guard does not lock, it only refuses a wrong row, and a race
  is resolved by `audit_logs_chain_key`), and never write a secret into `payload`.
- Reading the log is granted in STEP 035; until then only the service role and the owner see rows.
- `deleted_at` is present because every table carries the audit columns. It is unreachable by
  design; retention of audit rows is governed by section 31 and must never be implemented as a
  delete on this table without a new decision.

## Next Chat Notes
- Next in this category is STEP 018 (plans, plan entitlements and pricing versions). It is ordinary
  schema work, but from now on every mutation it enables must produce an entry here.
- The chain guard does not take a lock. Two concurrent writers can both pass the check; the loser
  fails on `audit_logs_chain_key` and must retry. That is deliberate: an audit insert must never
  block behind another tenant's write.
- `sequence` is derived from the head, so a writer must read the head and insert in the same
  transaction. Reading it in one transaction and inserting in another is a bug even when the guard
  accepts it.
- The verification query and the Merkle convention are written in this handoff and in the migration;
  any tool that reimplements them must match exactly, including the six fractional digits and the
  empty string for a null actor.
