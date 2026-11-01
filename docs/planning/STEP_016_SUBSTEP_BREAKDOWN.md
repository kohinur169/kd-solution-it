// path: docs/planning/STEP_016_SUBSTEP_BREAKDOWN.md
# STEP 016 - Sub-Step Breakdown

Working notes taken before any SQL was written. The proof belongs in
`docs/handoffs/STEP_016_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 016 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for login attempts and account locks table".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 013 created `users` (account, password hash, TOTP state); STEP 015 created
  `sessions` and `device_proof_keys`; STEP 017 owns the hash-chained audit log. This STEP stores
  the two things section 22 requires to survive a restart: the failed attempt record and the lock.

### Feature list section 22, the sentences this STEP must make true
- "Login lock: 2 consecutive failed password or failed 2FA attempts lock the account for 2 hours."
- "During the lock, a correct password does not log in, password reset is disabled, and changing
  the password does not clear the lock."
- "The owner receives an email alert when the lock starts."
- "Unlock is done only by an office role with unlock permission and only after contact with the
  owner is confirmed by email. Every unlock is audit logged."
- "Failed attempt counters and lock state are stored in the database and survive server restarts."
- "IP based rate limiting applies on authentication endpoints."
- "Error messages never reveal whether an account exists."
- Section 23: the activity emails include the login lock alert and the account unlock confirmation.
- Section 1: every table carries id UUID v7, company_id, created_at, updated_at, deleted_at,
  version, with RLS enabled and a default-deny policy.

### What exists today (measured before coding)
- Ten proven migrations (`0001`-`0010`) and 303 gate checks over ten tables.
- `users` holds `password_hash`, `totp_secret_ciphertext`, `totp_confirmed_at`,
  `backup_code_hashes` and `status`, and deliberately holds no lock state: STEP 013's comment says
  "the login lock is deliberately not here: a lock is temporary and self clearing, a suspension is
  an office decision. STEP 016 owns the lock table."
- `sessions` records a successful login; nothing records a failed one.

## 2. Design Decisions Taken Before Coding

1. **Two tables, two migrations.** `0011_login_attempts.sql` is the event record (the counters),
   `0012_account_locks.sql` is the state. The counters are append-only facts; the lock is one row
   that opens and closes. Deriving the counters from the event table means a restart changes
   nothing: the count is a query, not a number in memory.
2. **Counters are computed, never stored as a number.** "2 consecutive failures" is the count of
   `failed` attempts for the account since the last `succeeded` attempt, which the index
   `(user_id, created_at desc)` answers. A stored counter is a second source of truth that drifts
   when a retry is lost.
3. **One row per attempt, with a closed vocabulary.** `factor` is `password` or `totp`; `outcome` is
   `failed`, `succeeded`, `blocked` (credentials were right but the account is locked, which section
   22 requires to be refused) or `challenged` (Turnstile or the IP rate limit refused before any
   credential was checked). Nothing else can be written, so a report can group by outcome.
4. **A failed attempt on an address that has no account is still recorded, without the address.**
   `user_id` is null for an unknown address, and `email_hash` holds a hash of the submitted address
   in hex, so repeated probing of one address can be throttled without storing that address in
   plaintext. A check requires at least one of the two, so an attempt always names what was tried.
   This is also what lets the API keep its promise never to reveal whether an account exists.
5. **The address is part of the row.** `ip_address` is `not null`, because IP rate limiting is a
   requirement and an attempt without an origin cannot be limited. `user_agent` is optional and
   bounded at 512 characters, for the alert email and for review.
6. **`created_at` is the attempt instant.** The audit columns already carry it, and a second
   `attempted_at` column would be two truths about one moment. The table comment says so.
7. **The lock has a fixed shape, not a free one.** `locked_at` defaults to `now()`, `expires_at`
   defaults to `now() + interval '2 hours'`, and a check refuses anything longer than two hours
   from `locked_at`. The policy in section 22 is therefore a constraint, not a comment.
8. **The lock closes exactly one way, and the way is recorded.** An office unlock sets
   `unlocked_at`, `unlocked_by` and `unlock_note`; expiry sets `expired_at`. Checks make the
   closures mutually exclusive, require a reason and an officer for an unlock, require
   `unlocked_at >= locked_at`, and require `expired_at >= expires_at` (a lock cannot expire before
   it expires).
9. **An unlock needs the owner contact first.** A check refuses `unlocked_at` unless
   `owner_contact_confirmed_at` is set, so the sentence "only after contact with the owner is
   confirmed by email" is enforced by the database rather than by a careful code path.
10. **The lock alert is recorded.** `owner_alerted_at` holds when the lock email was sent, so a
    missing alert is visible instead of assumed, and the retry job can find rows where it is null.
11. **One open lock per account.** `account_locks_live_key` is a partial unique index on `user_id`
    where `expired_at is null and unlocked_at is null and deleted_at is null`, so two concurrent
    lock writers cannot produce two open locks.
12. **Nothing here clears a lock as a side effect.** A password change updates `users`; this schema
    gives it no path to `account_locks`, which is how "changing the password does not clear the
    lock" and "password reset is disabled during the lock" stay true.
13. **RLS on, default deny, nothing forced**, as on the previous ten tables; STEP 035 adds the
    permissive policies and the auth STEPs use the service role.
14. **No new function and no extension.** The helpers from `0001` are reused, and the hash in
    `email_hash` is computed by the application, never by the database (a database that can hash a
    submitted address is a database that can be asked to match one).

## 3. The Schema This Produces

`public.login_attempts`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | the account's tenant when it is known, else null |
| user_id | uuid | the account when it is known, else null (unknown address) |
| email_hash | text | lowercase hex, 64 characters, null when the account is known |
| factor | text | `password` or `totp` |
| outcome | text | `failed`, `succeeded`, `blocked` or `challenged` |
| ip_address | inet | not null, the origin of the attempt |
| user_agent | text | null, at most 512 characters |
| created_at | timestamptz | not null, default `now()`, the attempt instant |
| updated_at, deleted_at, version | audit set | as everywhere else |

`public.account_locks`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | the account's tenant |
| user_id | uuid | not null, the locked account |
| triggered_by | text | `password` or `totp`, which factor reached two failures |
| locked_at | timestamptz | not null, default `now()` |
| expires_at | timestamptz | not null, default `now() + 2 hours`, never later than `locked_at + 2 hours` |
| owner_alerted_at | timestamptz | null until the lock alert email is sent |
| owner_contact_confirmed_at | timestamptz | null until the office confirms contact with the owner |
| unlocked_at | timestamptz | null while locked; set by the office |
| unlocked_by | uuid | null while locked; the officer who unlocked |
| unlock_note | text | null, at most 280 characters |
| expired_at | timestamptz | null while locked; set when the two hours ran out |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

## 4. The Five Sub-Steps

Each sub-step ends with its own proof and a request for the owner's approval.

### 016.1 - Inventory, decisions and ownership (this document)
Read section 22, section 23, the STEP 015 handoff and the ten existing migrations; measure what
exists; fix the schema above. No code.

### 016.2 - `0011_login_attempts.sql` and its rollback
Create the event table with its four indexes, trigger, RLS and default-deny policy, plus comments.
Proof on PostgreSQL 16.2: forward apply on a database that has `0001`-`0010`; one row per outcome;
an unknown factor, an unknown outcome, an empty identity (no account and no hash), a malformed hash,
an empty address and an over-long user agent each refused by name; the counter query returning the
consecutive failures since the last success; the per-address and per-IP queries reading their
indexes; the rollback removing only this table.

### 016.3 - `0012_account_locks.sql` and its rollback
Create the lock table with its checks, the live unique index, the expiry index, trigger, RLS and
policy. Proof: a two hour lock; a longer window refused; an unlock without an officer refused; an
unlock without owner contact refused; two closures at once refused; an expiry before the expiry
instant refused; a second open lock for the same account refused while a closed one is fine;
rollback leaving the attempts table intact.

### 016.4 - Cross-table proof, RLS and the gate
Prove section 22 end to end in data: two consecutive password failures, then a lock; the correct
password during the lock recorded as `blocked` and no session created; a password change on `users`
leaving the lock untouched; the alert instant and the owner contact before an office unlock; the
open lock count back to zero after unlock; an expiry path; the counter reset after a success; RLS
on both tables for a plain role; all twelve migrations rolled back in reverse and re-applied; the
gate and its mutation probes.

### 016.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, write
`docs/handoffs/STEP_016_COMPLETED.md`, commit as "STEP 016: Migration for login attempts and
account locks table", push, and stop.

## 5. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0011_login_attempts.sql, .down.sql | created in 016.2 |
| migrations/0012_account_locks.sql, .down.sql | created in 016.3 |
| migrations/README.md (the migrations index) | modified in 016.5 |
| README.md (the database section) | modified in 016.5 |
| docs/planning/STEP_016_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_016_COMPLETED.md | created in 016.5 |

No `package.json` change: the migrations gate already covers new files.

Not owned here, therefore untouched: every `lib/` module (including `lib/jobs/`), `config/`, the
environment contract, migrations `0001`-`0010`, the audit log (017), the permissive RLS policies
(035), the notification templates (the email STEPs), and every code STEP, including the auth STEPs
037-055 that will write these rows.

## 6. Open Points The Owner May Want To Change

1. **`email_hash` for an unknown address.** It is a hash, never the address, and it exists only so
   one address cannot be probed without a cost. The alternative is to record the IP alone, which
   loses per-identity throttling on addresses that do not exist.
2. **`expired_at` is an explicit column.** The alternative is to treat `expires_at < now()` as
   expired and never write it, which makes "is this account locked" depend on a clock comparison
   only and makes the unique open lock unenforceable in the database.
3. **The vocabularies have fixed sizes**: two factors, four outcomes, two lock triggers. A new value
   is a migration that replaces one check constraint.
