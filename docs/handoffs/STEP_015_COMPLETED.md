// path: docs/handoffs/STEP_015_COMPLETED.md
# STEP 015 Completed - Handoff

## STEP
- Number and title: STEP 015 - Migration for sessions and device proof keys table
- Category: Database Schema and Row Level Security (STEP 012-036)
- Depends on (earlier STEPs in this category and their handoff files): STEP 012 (`companies`, the
  UUID v7 function, the row metadata trigger, the migrations gate and its conventions), STEP 013
  (`users`, whose account a session signs in as) and STEP 014 (the live-row unique index pattern
  this STEP follows for device enrolment). The owner asked for this STEP in five sub-STEPS, one
  approval at a time; the plan is `docs/planning/STEP_015_SUBSTEP_BREAKDOWN.md`.

## Files
- Created:
  - migrations/0009_device_proof_keys.sql and 0009_device_proof_keys.down.sql - one enrolled device
    per row: the public half of a proof key, its fingerprint and algorithm, the first-seen, trusted
    and revoked instants, four indexes, trigger, RLS and default-deny policy.
  - migrations/0010_sessions.sql and 0010_sessions.down.sql - the session table: token hash, family
    and rotation parent, step-up instants, request context, a closed revocation vocabulary and a
    replay marker, seven indexes, trigger, RLS and policy.
  - docs/planning/STEP_015_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_015_COMPLETED.md.
- Modified:
  - migrations/README.md - two inventory rows, and two new rules: a session token is stored as a
    hash with one row per rotation sharing a family, and a session may only name a device of its
    own account through a composite key.
  - README.md - the database section describes the session layer of section 22.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): numbered migration
  files in `migrations/` and the migrations index. Not touched: migrations `0001` to `0008`, every
  `lib/` module, `config/`, the environment contract, the catalog, the logger, the error catalog,
  the lint matrix, the shell, login attempts and account locks (016), the audit log (017), the
  permissive RLS policies (035) and every code STEP including 037-055, which will read and write
  these rows. `package.json` is untouched because the migrations gate already covers new files.

## Database
- Migrations added (file names): `0009_device_proof_keys` and `0010_sessions`, each with its
  `.down.sql`. Together they create two tables, 36 columns, 31 constraints, eleven indexes, two
  triggers, two policies and 25 comments, and the schema now holds ten tables in total.
- Shape: `device_proof_keys` has 15 columns, 13 constraints, four indexes and ten comments;
  `sessions` has 21 columns, 18 constraints, seven indexes and fifteen comments.
- Rollback verified on clean database (yes/no, how): **yes**, on PostgreSQL 16.2. All ten rollbacks
  ran in reverse dependency order on a populated database; afterwards the catalog reported 0 public
  tables, 0 policies, 0 functions in `public` and 0 custom triggers, and the ten forward files
  applied again to a second empty database, recreating exactly ten tables and ten policies. The
  environment has no Docker and no Supabase CLI, so the server was a real PostgreSQL 16.2 started
  locally from the `pgserver` wheel with `psycopg` as the client.

## Environment
- Environment variables added to .env.example: none.
- Secrets handled (names only, never values): none. The proof seeded synthetic password hashes,
  synthetic base64url keys and synthetic addresses in throwaway local databases.

## Packages
- Package requests for the integrator (name, reason), or none: none.

## Behaviour Proof (acceptance checklist)
Three throwaway scripts ran against the local PostgreSQL 16.2 and each ended with `PROOF COMPLETE`;
no check failed. They covered:

1. **Forward apply.** `0001` to `0010` applied in order on a clean database and produced exactly ten
   tables, ten policies and ten triggers.
2. **Device enrolment.** A merchant device stored with the `ES256` default, `trusted_at` null and
   `version` 1; trusting it later moved the version to 2 through the trigger.
3. **A device belongs to one account.** The same fingerprint enrolled under a second account is a
   different device; a duplicate live fingerprint under the same account is refused by
   `device_proof_keys_live_key`; a revoked key frees the pair for a fresh enrolment while the
   revoked row stays as history.
4. **Device input is checked.** `RS256` refused by `device_proof_keys_algorithm_check`; a short
   fingerprint and one padded with `=` refused by `device_proof_keys_fingerprint_check`; a short
   public key refused by `device_proof_keys_public_key_check`; a padded label refused by
   `device_proof_keys_label_check`; `trusted_at` or `revoked_at` before `first_seen_at` refused by
   their checks; an unknown account refused by `device_proof_keys_user_fkey`.
5. **A session cannot point at someone else's device.** With the composite key in place the write is
   refused by `sessions_user_device_fkey`; weakening that key back to a plain device reference makes
   the same proof fail, which is how the gap was found.
6. **Token handling.** A duplicate `token_hash` is refused by `sessions_token_hash_key`, and an
   `expires_at` at or before `issued_at` is refused by `sessions_expiry_check`.
7. **Revocation explains itself.** `revoked_at` without a reason and a reason without `revoked_at`
   are both refused by `sessions_revocation_pair_check`; `TIMEOUT` is refused by
   `sessions_revocation_reason_check`, so the vocabulary is closed.
8. **Replay is a state, not a guess.** A replay instant on a live session, and a replay filed as a
   `ROTATED` revocation, are both refused by `sessions_replay_check`; a real replay is stored as
   `REPLAY_DETECTED` with its instant.
9. **Rotation is a chain.** A rotation keeps `family_id` and names its parent, a second rotation of
   the same parent is refused by `sessions_rotation_key`, and three rotations of one login leave one
   live row.
10. **Family revocation.** Setting revoked and revoked `FAMILY_REVOKED` on the family left zero live
    rows and three explained rows in one statement.
11. **A replayed cookie ends the family.** Marking the first token as replayed and ending the family
    left live 0, family ended 1 and replays 1 for that family.
12. **A lost device ends its sessions.** Revoking the device and its sessions (`DEVICE_REVOKED`) left
    no live session for it, and the other device's session untouched.
13. **Step-up cannot be claimed early.** `mfa_verified_at` before `issued_at` is refused by
    `sessions_mfa_verified_check`; a user agent over 512 characters is refused by
    `sessions_user_agent_check`; no live session carried a `reauthenticated_at` it had not earned.
14. **Cleanup query and history.** The expired session lookup found exactly the live expired row,
    deleting it left the four historical rows intact, and a signed-out session stays as history.
15. **Row level security.** A plain role with select and insert grants saw zero rows in both tables
    and could not insert (`new row violates row-level security policy`), while the owner saw every
    row (4 sessions, 3 devices).
16. **Rollback and re-apply.** The ten rollbacks emptied the `public` schema completely and the ten
    forward files rebuilt it on a second database.

## Verification
- `npm run check:migrations`: `migrations gate passed: 303 checks, 10 migrations, 10 tables, every
  forward file transactional and default-deny` (243 before this STEP).
- Gate mutation probes, each caught and reverted: removing `enable row level security` from either
  file, removing `company_id` from either file, inserting a `truncate`, and removing a rollback file.
  The gate is back to 303.
- `npm run verify`: exit 0. Structure 16 directories, 13 root files, 68 source files; config 10
  sections and 28 values; i18n 36 messages; logger 117 checks; errors 196 checks and 14 codes; lint
  77 checks and 26 rules with 11 probes; shell 98 checks over 12 files; jobs 110 checks and 4 slots;
  migrations 303 checks; `Compiled successfully`. The route table is unchanged.
- No `TODO`, `FIXME` or `XXX` was added; every SQL and doc file is ASCII.

## Errors Found And Corrected In This STEP
1. **The public key check could not match anything.** `public_key ~ '^[A-Za-z0-9_-]{32,512}$'` is
   accepted at DDL time but every insert fails, because PostgreSQL regular expressions cap a
   repetition count at 255 (`invalid repetition count(s)`). The check became a charset test plus
   `char_length(public_key) between 32 and 512`, and the proof now inserts a real key.
2. **A session could name another account's device.** The first design referenced
   `device_proof_keys (id)` only, so an application bug could bind one user's session to another
   user's device key. The fix is a unique `(user_id, id)` index on the device table and a composite
   foreign key `(user_id, device_proof_key_id)` on the session table. A mutation probe that weakens
   the key back to the plain reference makes the cross-table proof fail, so the rule is enforced by
   the database and policed by the proof.
3. **Enumeration expectations were wrong before they were measured.** The device table has 13
   constraints, not 14, and the first proof run reported the difference rather than hiding it.

## Decisions And Limits Left For Later STEPs
- Stepping up is a timestamp, not a flag: `mfa_verified_at` and `reauthenticated_at` are compared
  with the freshness window the auth STEP owns. Nothing in this STEP picks that window.
- Ending a family, retiring a device and marking a replay are statements, not triggers. The STEP
  that implements login and rotation (037-055) issues them; this schema makes the states expressible
  and the invalid ones unrepresentable.
- `ip_address` and `user_agent` are personal data. The STEP that writes them owns their retention.
- Login attempts, the two hour lock and its unlock audit live in STEP 016; the hash chained audit log
  of every session event lives in STEP 017; the permissive RLS policies for merchants and office
  users arrive in STEP 035. This STEP deliberately leaves all three alone.
- The expired session cleanup query is indexed (`sessions_expiry_idx`) but not scheduled; the job
  that deletes rows belongs to the queue STEPs, and deletion stays out of migrations by rule 5.

## Next Chat Notes
- Next in this category is STEP 016 (login attempts and account locks). It should count failures by
  account and by address, and keep the lock in a table that survives restarts, exactly as section 22
  demands; the session rows here are already the place a successful login is recorded.
- A login flow transaction will want to create the device row, the session row and the audit row
  together. Until STEP 017 exists there is nothing to chain into.
- `sessions.family_id` is generated by the database for the first row and copied for rotations.
  Code that copies it must never generate a new one for a rotation, or the family rule silently
  stops working.
- Do not add a second unique index on `token_hash`: the existing `sessions_token_hash_key` is the
  guard, and a duplicate would only slow the hot path.
