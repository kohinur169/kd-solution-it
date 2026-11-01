// path: docs/planning/STEP_013_SUBSTEP_BREAKDOWN.md
# STEP 013 - Sub-Step Breakdown

Working notes taken before any SQL was written. The proof itself lives in
`docs/handoffs/STEP_013_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 013 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for users and role assignment tables".
- Category: Database Schema and Row Level Security (STEP 012-036).
- File Ownership Rules: database STEPs own only their numbered migration files in `migrations/`,
  plus the migrations index.
- The next database STEPs decide what is *not* here: 014 office permissions, delegation,
  announcements; 015 sessions and device proof keys; 016 login attempts and account locks; 017 the
  audit log; 033-035 the permissive RLS policies for these tables; 036 the super_admin bootstrap.

### Feature list sections that fix the shape
- Section 2, roles and permissions: `super_admin`, `ceo`, `compliance_kyc`, `finance_ops`,
  `support`, `blogger`, `owner`, and `client` which is "tokenized link access only under i/[token]
  and e/[token], no login". "Every permission grant, change and use is audit logged." This is the
  vocabulary of the role column, and the reason `client` is not a row in `users`.
- Section 4, one person one account: "One person holds exactly one account. One owner holds
  exactly one business and one sub-merchant account." Duplicate signals are "email, phone, identity
  document number hash, tax id, bank account fingerprint, legal name with date of birth". Email and
  phone are identity columns here; the rest arrive with KYC (028).
- Section 5, signup and KYC: "Merchant signup with email verification", so a user has an email
  verification instant. The business profile and KYC fields belong to 028, not to `users`.
- Section 22, authentication and session security: "2FA TOTP is mandatory for every account
  holding role, with backup codes." "Failed attempt counters and lock state are stored in the
  database" (STEP 016 owns those). So the TOTP secret and the backup codes need a home in this
  STEP's tables, because no later migration STEP names them.
- Section 1, platform foundations: every table carries id UUID v7, company_id, created_at,
  updated_at, deleted_at, version, with RLS enabled and a default-deny policy.

### A documented conflict, resolved the way the rules say
`docs/planning/REVISED_FEATURE_LIST_V2.md` lists the office roles as `super_admin`, `ceo`,
`compliance_kyc`, `support` and `blogger`, and does not mention `finance_ops`. `FEATURE_LIST.md`
section 2 does list `finance_ops`. MASTER_PROMPT says "If anything in the STEP conflicts with
FEATURE_LIST.md, FEATURE_LIST.md wins and the conflict must be written into the handoff file", so
the role check includes `finance_ops` and the handoff records the difference. Removing a role later
is a new migration, which is the correct price for losing a documented permission set.

### What exists today (measured before coding)
- `migrations/0001_companies.sql` and `0002_job_queue.sql`, both proven on PostgreSQL 16.2, plus
  `migrations/verify.ts` (the gate: 63 checks over two migrations).
- `public.uuid_generate_v7()` and `public.set_row_metadata()` exist from `0001`; this STEP reuses
  them and redefines neither.
- `companies.company_id` is generated from `id`, so a child table points at `companies(id)`.
- No table references users yet, which is why this migration can land before sessions (015) and
  audit logs (017).
- `lib/errors/codes.ts`, `lib/logger/` and the catalog are untouched by this STEP; it adds no
  string and no code.

## 2. Design Decisions Taken Before Coding

1. **Two tables, two migrations.** `0003_users.sql` creates `users`; `0004_role_assignments.sql`
   creates `role_assignments`, which references `users`. Rollback then runs in reverse order and
   each table has its own file and its own proof.
2. **`users.company_id` is nullable.** Platform office staff (`super_admin`, `ceo`,
   `compliance_kyc`, `finance_ops`, `support`, `blogger`) do not belong to a merchant company; an
   `owner` does. A `not null` here would force office staff into a fake company, the same mistake
   `job_queue` avoids for platform work. The foreign key to `companies(id)` keeps a real tenant
   honest.
3. **No `roles` lookup table.** The seven roles are a closed vocabulary fixed by code and by the
   feature list; a table would imply the platform can invent a role at runtime, which nothing
   supports, and it would put a join in front of every permission check. The same reasoning
   already put the five job statuses in a check constraint instead of a table.
4. **`role_assignments` is an assignment, not a column on users.** One person holds one account
   but a role can be revoked and granted again, and section 2 requires that "every permission
   grant, change and use is audit logged". Rows with `granted_by`, `granted_at` and `revoked_at`
   are that history; a `role` column on `users` would overwrite it on every change.
5. **Owner and company travel together.** `check ((role = 'owner') = (company_id is not null))`
   means an owner assignment always names a company and a platform role never does. This is the
   one role rule that can be a table constraint, so it is one.
6. **Role scope is the assignment's `company_id`, not only the user's.** For an owner the two are
   equal; keeping the column on the assignment lets a STEP 035 policy scope by company without a
   join, and the feature list requires the column on every table anyway.
7. **One live assignment per user and role.** A partial unique index on `(user_id, role)` where
   `revoked_at is null and deleted_at is null` allows no duplicates, and allows a re-grant after a
   revocation without deleting history.
8. **Email is unique for ever, and stored lowercase.** `check (email = lower(email))` plus a full
   unique index on `email` (not partial) implements "one person holds exactly one account": a
   closed account keeps its address reserved, and a second signup with the same email fails at the
   database instead of being caught by application code that runs on one instance.
9. **Phone is optional but validated.** Section 4 treats phone as a duplicate signal, so it is a
   column; it is nullable because signup is email based, and it is checked against E.164 when
   present (`^\+[1-9][0-9]{7,14}$`).
10. **Credentials live on the row, never as plaintext.** `password_hash` is text with a length
    bound and no format check (the algorithm belongs to the auth STEP), `password_updated_at` is a
    timestamp a session STEP can compare against, and `email_verified_at` records verification.
11. **2FA state lives here, because no later migration names a home for it.** Section 22 makes TOTP
    mandatory for every role that can sign in. `totp_secret_ciphertext` holds the AES-256-GCM
    ciphertext (the key stays in the environment, never in the row), `totp_confirmed_at` is null
    until the first successful code, and a check refuses a confirmation without a secret.
    `backup_code_hashes` is a jsonb array of hashes, bounded to 20 entries, because the codes are a
    set, never queried by value, and replaced as a whole.
12. **`status` is the account state, not the company state.** `active`, `suspended`, `closed`. The
    login lock of section 22 is a separate table (STEP 016) and must not be confused with a
    suspension: a lock is temporary and self-clearing, a suspended account is an office decision.
13. **A user row exists only with a password.** `password_hash` is `not null`. Office invitations
    and any "pending user" concept belong to the STEP that introduces them (014 owns delegation,
    068-078 own the office), and a nullable password would create a user that cannot sign in and
    that every later query has to guard against.
14. **RLS on, default deny, like every table.** `users_default_deny` and
    `role_assignments_default_deny`. STEP 035 adds the permissive policies for office roles; this
    STEP proves the deny is real in the meantime.
15. **Indexes follow the queries the plan names.** `users_email_key` for signup and login,
    `users_company_idx (company_id, created_at desc)` for a company's people,
    `role_assignments_live_key (user_id, role) where live` for "does this user hold this role", and
    `role_assignments_company_role_idx (company_id, role) where live` for "who is the owner of this
    company" and "which office staff hold this role".

## 3. The Schema This Produces

`public.users`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for platform staff, references `companies(id)` |
| email | text | not null, lowercase, at most 254 characters, unique for ever |
| phone | text | null, E.164 when present |
| full_name | text | not null, trimmed, 1-120 characters |
| password_hash | text | not null, 20-255 characters, never plaintext |
| password_updated_at | timestamptz | not null, default `now()` |
| email_verified_at | timestamptz | null until verified |
| totp_secret_ciphertext | text | null, 1-512 characters |
| totp_confirmed_at | timestamptz | null, and never set without a secret |
| backup_code_hashes | jsonb | not null, default `[]`, an array of at most 20 strings |
| status | text | not null, default `active`, one of three values |
| created_at, updated_at | timestamptz | not null, default `now()` |
| deleted_at | timestamptz | null until closed |
| version | integer | not null, default 1, greater than 0 |

`public.role_assignments`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for a platform role, references `companies(id)` |
| user_id | uuid | not null, references `users(id)` |
| role | text | not null, one of the seven role names |
| granted_by | uuid | null, references `users(id)`; null only for a bootstrap grant |
| granted_at | timestamptz | not null, default `now()` |
| revoked_at | timestamptz | null while live, never before `granted_at` |
| created_at, updated_at, deleted_at, version | audit set | as everywhere else |

## 4. The Five Sub-Steps

### 013.1 - Inventory, decisions and ownership (this document)
Read the STEP, sections 2/4/5/22, the previous handoff and the current migrations; measure what
exists; fix the schema and the conflicts above. No code.

### 013.2 - `0003_users.sql` and its rollback
Create the `users` table with its constraints, the email and company indexes, the metadata
trigger, RLS and the default-deny policy, plus comments. Proof on PostgreSQL 16.2: forward apply
on a database that already has `0001` and `0002`, then two users (one office, one owner), a
duplicate email refused, an uppercase email refused, a bad phone refused, a confirmation without a
secret refused, a 21 element backup code array refused, the version trigger moving `version` to 2,
and the rollback removing only this table.

### 013.3 - `0004_role_assignments.sql` and its rollback
Create the assignment table with its constraints, the two live indexes, the trigger, RLS and the
policy, plus comments. Proof: an owner assignment without a company refused, a platform role with a
company refused, a duplicate live assignment refused, a re-grant after revocation accepted, a
revocation before the grant refused, an unknown role refused, and a grant for a user that does not
exist refused by the foreign key.

### 013.4 - Cross-table proof, RLS and the gate
Prove the shape works as a whole: an owner user with a `role_assignments` row scoped to its
company; a platform user with a platform role and a null company; the deny still real for a plain
role on both tables; `npm run check:migrations` covering four migrations; and the gate still fails
closed (a new mutation probe for the new tables). Then a full clean apply and rollback of all four
migrations.

### 013.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` with the two new files, add a short note to the root README database
section, run `npm run verify`, write `docs/handoffs/STEP_013_COMPLETED.md` including the
`finance_ops` conflict, commit as "STEP 013: Migration for users and role assignment tables",
push, and stop.

## 5. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0003_users.sql | created in 013.2 |
| migrations/0003_users.down.sql | created in 013.2 |
| migrations/0004_role_assignments.sql | created in 013.3 |
| migrations/0004_role_assignments.down.sql | created in 013.3 |
| migrations/README.md (the migrations index) | modified in 013.5 |
| README.md (the database section) | modified in 013.5 |
| docs/planning/STEP_013_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_013_COMPLETED.md | created in 013.5 |

No `package.json` change: the migrations gate already exists and covers new files automatically.

Not owned here, therefore untouched: `lib/` in full, `config/`, the environment contract,
`migrations/0001` and `0002`, the permissive RLS policies (STEP 035), sessions (015), login
attempts and locks (016), the audit log (017), KYC tables (028) and every code STEP.

## 6. Open Points The Owner May Want To Change

1. **2FA state on `users`**: the TOTP ciphertext, the confirmation instant and the backup code
   hashes. Recommended, because no later migration STEP names a table for them and section 22
   makes TOTP mandatory. The alternative is a later STEP adding a `user_second_factors` table.
2. **`finance_ops` stays in the role check** even though REVISED_FEATURE_LIST_V2 omits it, because
   FEATURE_LIST.md wins and the handoff must record the conflict. Removing it later is a new
   migration.
3. **Email uniqueness is global and permanent**, including closed accounts, from section 4's "one
   person, one account".
4. **`password_hash is not null`**: no invite-only user rows in this STEP.

## 7. Outcome

All five sub-steps were implemented in order with the owner's approval. The design held, with one
thing the proof corrected: an early "unknown role" probe supplied a company and was refused by the
owner scope check first, so the probe was rewritten with no company to reach
`role_assignments_role_check`. The final proof shows each rule firing from the constraint that owns
it.

The role vocabulary keeps `finance_ops`, per FEATURE_LIST.md section 2, and the difference from
REVISED_FEATURE_LIST_V2 is recorded in the handoff as the rules require. The 2FA columns stayed on
`users`, as recommended, because no later migration STEP names a home for them. See
`docs/handoffs/STEP_013_COMPLETED.md` for the transcripts.
