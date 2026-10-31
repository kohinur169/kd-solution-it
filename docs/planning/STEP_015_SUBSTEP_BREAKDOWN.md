// path: docs/planning/STEP_015_SUBSTEP_BREAKDOWN.md
# STEP 015 - Sub-Step Breakdown

Working notes taken before any SQL was written. The proof belongs in
`docs/handoffs/STEP_015_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 015 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for sessions and device proof keys table".
- Category: Database Schema and Row Level Security (STEP 012-036). File Ownership Rules: a database
  STEP owns only its numbered migration files and the migrations index.
- Neighbours: STEP 013 created `users` (the account, credentials, TOTP); STEP 016 owns login
  attempts and account locks; STEP 017 owns the hash-chained audit log; STEP 035 adds the
  permissive RLS policies. None of them creates a session table, so the session state is here.

### Feature list sections that fix the shape
- Section 22, LR-022: "session-bound cookie (HttpOnly, Secure, SameSite Strict), per-device proof
  key, rotating session token, cookie replay detection with revocation of the whole session family,
  extra verification on a new device, reauthentication for sensitive actions, instant session
  revocation, and audit logging of every session event. A cookie works only inside its own session."
  Every clause of that sentence is a column or an index below.
- Section 22 also requires step-up reauthentication for gateway keys, payouts, KYC decisions and
  account unlocks, so a session records when it last satisfied 2FA and when it last reauthenticated.
- Section 23, activity emails: a "new device alert" is sent, which means the platform must know a
  device is new: the device key carries the first-seen instant and a trust instant that starts null.
- Section 27, cleanup: "Expired token and session cleanup" is a background job, so the expired rows
  must be findable by an index.
- Section 1: every table carries id UUID v7, company_id, created_at, updated_at, deleted_at,
  version, with RLS enabled and a default-deny policy.

### What exists today (measured before coding)
- Eight proven migrations (0001-0008): `companies`, `job_queue`, `users`, `role_assignments`,
  `office_permissions`, `delegations`, `announcements`, `announcement_dismissals`, plus
  `public.uuid_generate_v7()` and `public.set_row_metadata()`.
- `users` holds the account, the password hash, the email verification instant and the TOTP state;
  it holds no session state, which is why this STEP is the first place a login leaves a trace.
- The migrations gate (243 checks over eight migrations) already enforces numbering, rollback
  pairing, the six audit columns, RLS plus a default-deny policy and the transaction wrapper, so
  the new files inherit those rules automatically.

## 2. Design Decisions Taken Before Coding

1. **Two tables, two migrations.** `0009_device_proof_keys.sql` and `0010_sessions.sql`, the second
   referencing the first. Rollback runs in reverse, and each table has its own proof.
2. **A session is always bound to a device key.** `sessions.device_proof_key_id` is `not null`.
   LR-022 says the cookie only works inside the session and that a device proof is checked, so a
   session without a device is exactly the state an attacker wants; the login flow registers the
   key first and then creates the session, both inside the same transaction.
3. **The token is never stored.** `sessions.token_hash` holds a hash of the rotating token, is
   unique, and is checked for the base64url shape (`^[A-Za-z0-9_-]{43,128}$`). A database leak
   therefore yields no usable cookie, and a replayed value can be recognised without comparing
   plaintext.
4. **Rotation is a chain, and a chain has a family.** `family_id` is assigned when a session is
   created and copied by every rotation, which is what makes "revocation of the whole session
   family" a single `update ... where family_id = $1`. `rotated_from_session_id` points at the
   parent, and a partial unique index makes that parent referenced at most once: a second child is
   a fork, which is an attack or a bug, never a legitimate rotation.
5. **Replay detection is recorded, not inferred.** `replay_detected_at` is set when a token that
   was already rotated or revoked is presented, and a check requires the row to be revoked with
   `REPLAY_DETECTED` when that instant is present. The alert and the family revocation that follow
   are service behaviour; the database makes the state impossible to mislabel.
6. **Revocation has a closed vocabulary.** `SIGNED_OUT`, `ROTATED`, `REPLAY_DETECTED`,
   `FAMILY_REVOKED`, `ADMIN_REVOKED`, `PASSWORD_CHANGED`, `DEVICE_REVOKED`. `revoked_at` and
   `revocation_reason` are set together or not at all, enforced by one bi-conditional check, so a
   revoked row can always explain itself.
7. **A device key is a public key plus a fingerprint.** `public_key` is the base64url encoded
   public key, `fingerprint` is a hash the client and server agree on, `algorithm` is one of
   `ES256`, `ES384`, `EdDSA`. The pair `(user_id, fingerprint)` is unique, so the same browser
   cannot register twice, and `revoked_at` covers a lost device without deleting history.
8. **A new device is a device that is not trusted yet.** `trusted_at` starts null and is set only
   after the email confirmation plus 2FA that section 22 requires; `first_seen_at` is what the
   "new device" alert email reports. A check keeps `trusted_at >= first_seen_at`.
9. **Step-up lives on the session.** `mfa_verified_at` records the 2FA that opened the session and
   `reauthenticated_at` records the fresh reauthentication LR-022 demands before a sensitive action.
   Both are nullable timestamps, so the auth STEP compares them with a configured freshness window
   instead of inventing a boolean flag that cannot age.
10. **The session records where it came from.** `ip_address inet` and `user_agent` (at most 512
    characters) are nullable for a client that sends neither. They exist for the new-device alert
    and for anomaly review; they are personal data, so the STEP that writes them must also own their
    retention, and this note is the record of that decision.
11. **Expiry is absolute on the row.** `expires_at` is required and greater than `issued_at`;
    sliding renewal is a rotation, which already has a row. `last_seen_at` moves on activity and is
    never earlier than `issued_at`.
12. **Indexes follow the queries the plan names.** `sessions_token_hash_key` for lookup by cookie,
    `sessions_user_idx (user_id, revoked_at)` for the "your active sessions" screen, `sessions_family_idx
    (family_id)` for the family revocation, `sessions_expiry_idx (expires_at) where revoked_at is null`
    for the cleanup job, `sessions_device_idx (device_proof_key_id)` for revoking a lost device's
    sessions, and `device_proof_keys_user_key (user_id, fingerprint)` for enrolment.
13. **RLS on, default deny, nothing forced**, exactly as the other eight tables. STEP 035 adds the
    permissive policies, and the owner and the service role must keep writing.
14. **No new function and no extension.** The helpers from `0001` are reused; `inet` is a core type,
    and no hashing function is needed because the hash is computed by the application before it
    reaches this table.

## 3. The Schema This Produces

`public.device_proof_keys`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for office staff, references `companies(id)` |
| user_id | uuid | not null, references `users(id)` |
| fingerprint | text | not null, base64url, 43-128 characters |
| public_key | text | not null, base64url, 32-512 characters |
| algorithm | text | not null, default `ES256`, one of three values |
| label | text | null, at most 80 characters |
| first_seen_at | timestamptz | not null, default `now()` |
| last_seen_at | timestamptz | not null, default `now()`, never before `first_seen_at` |
| trusted_at | timestamptz | null until the new device is confirmed |
| revoked_at | timestamptz | null while the device is usable |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

`public.sessions`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for office staff, references `companies(id)` |
| user_id | uuid | not null, references `users(id)` |
| device_proof_key_id | uuid | not null, references `device_proof_keys(id)` |
| token_hash | text | not null, unique, base64url, never the token |
| family_id | uuid | not null, default `uuid_generate_v7()`, shared by every rotation |
| rotated_from_session_id | uuid | null, references `sessions(id)`, referenced at most once |
| issued_at | timestamptz | not null, default `now()` |
| expires_at | timestamptz | not null, greater than `issued_at` |
| last_seen_at | timestamptz | not null, default `now()`, never before `issued_at` |
| mfa_verified_at | timestamptz | null until 2FA is satisfied in this session |
| reauthenticated_at | timestamptz | null until a fresh reauthentication happens |
| ip_address | inet | null |
| user_agent | text | null, at most 512 characters |
| revoked_at | timestamptz | null while live |
| revocation_reason | text | null, one of seven values, set exactly with `revoked_at` |
| replay_detected_at | timestamptz | null, and never set without a `REPLAY_DETECTED` revocation |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

## 4. The Five Sub-Steps

Each sub-step ends with its own proof and a request for the owner's approval.

### 015.1 - Inventory, decisions and ownership (this document)
Read the STEP, section 22/23/27, the STEP 014 handoff and the eight existing migrations; measure
what exists; fix the schema above. No code.

### 015.2 - `0009_device_proof_keys.sql` and its rollback
Create the device key table with its constraints, the two indexes, the trigger, RLS and the
default-deny policy, plus comments. Proof on PostgreSQL 16.2: forward apply on a database that has
`0001`-`0008`, an office device and a merchant device, a duplicate fingerprint for one user
refused while the same fingerprint for another user is accepted, a bad algorithm refused, a
fingerprint outside the allowed shape refused, `trusted_at` before `first_seen_at` refused, the
version trigger moving the counter, and the rollback removing only this table.

### 015.3 - `0010_sessions.sql` and its rollback
Create the session table with its constraints, the six indexes, the trigger, RLS and the policy.
Proof: a valid session row; a duplicate token hash refused; an expiry before the issue refused; a
reason without a revocation refused and a revocation without a reason refused; an unknown reason
refused; a replay instant without a `REPLAY_DETECTED` revocation refused; a second rotation of the
same parent refused by the unique child index; a session for an unknown device refused by the
foreign key; rollback leaving the device table intact.

### 015.4 - Cross-table proof, RLS and the gate
Prove the family behaves as LR-022 needs: create a session, rotate it twice (three rows, one
family, one live), revoke the family with a single statement and show every row revoked; mark a
replayed token and show the check forces the right reason; prove a plain role sees zero rows in
both tables and cannot insert; roll all ten migrations back in reverse order on a populated
database; apply them again to a fresh one; run the gate and its mutation probes.

### 015.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, write
`docs/handoffs/STEP_015_COMPLETED.md`, commit as "STEP 015: Migration for sessions and device proof
keys table", push, and stop.

## 5. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0009_device_proof_keys.sql, .down.sql | created in 015.2 |
| migrations/0010_sessions.sql, .down.sql | created in 015.3 |
| migrations/README.md (the migrations index) | modified in 015.5 |
| README.md (the database section) | modified in 015.5 |
| docs/planning/STEP_015_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_015_COMPLETED.md | created in 015.5 |

No `package.json` change: the migrations gate already covers new files.

Not owned here, therefore untouched: every `lib/` module (including `lib/jobs/`), `config/`, the
environment contract, migrations `0001`-`0008`, login attempts and account locks (016), the audit
log (017), the permissive RLS policies (035), and every code STEP, including the auth STEPs
037-055 that will read and write these rows.

## 6. Open Points The Owner May Want To Change

1. **`device_proof_key_id` is `not null`.** A session without a device key would be a session with
   no device proof, which LR-022 forbids. The alternative is a nullable column with a short-lived
   "provisional" state, and that state is what an attacker would aim for.
2. **The raw IP address and user agent are stored**, because the new-device alert and the anomaly
   review need them. Hashing them would weaken that review; deleting them on a schedule belongs to
   the retention STEP and is recorded as a decision here.
3. **The revocation reason vocabulary has seven values.** A new reason is a migration that replaces
   one check constraint, which is the correct cost for a state that alerts people.
