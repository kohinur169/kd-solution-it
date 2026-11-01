// path: docs/planning/STEP_017_SUBSTEP_BREAKDOWN.md
# STEP 017 - Sub-Step Breakdown

Working notes taken before any SQL was written. The proof belongs in
`docs/handoffs/STEP_017_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

### STEP 017 as written in docs/final/STEP_PLAN_250.md
- Title: "Migration for audit logs append-only hash chain table".
- Category: Database Schema and Row Level Security (STEP 012-036). A database STEP owns only its
  numbered migration files and the migrations index.
- Neighbours: STEP 013 created `users`, STEP 015 `sessions`, STEP 016 `login_attempts` and
  `account_locks`. This STEP is the log every one of them will write into.

### Feature list lines that fix the shape
- Section 1: "Audit log entry on every mutation. Hash-chained append-only audit log with Ed25519
  signing and Merkle root export."
- Section 2: "Every permission grant, change and use is audit logged."
- Section 22: "Every unlock is audit logged" and "audit logging of every session event".
- Sections 3, 11, 13, 21 and 30 repeat it for KYC decisions, refunds and disputes, reconciliation
  mismatches, file access, API calls and key rotation.
- Section 27 lists "Audit log integrity hash generation" as a scheduled job.
- Section 31: "Audit log integrity roots are exported on schedule so tampering can be detected."
- Section 37: a security sensitive feature is complete only after its audit entries are verified.
- Every table carries id UUID v7, company_id, created_at, updated_at, deleted_at, version, with RLS
  enabled and a default-deny policy.

### What exists today (measured before coding)
- Twelve proven migrations (`0001`-`0012`) and 363 gate checks over twelve tables.
- Nothing records "who did what" yet: `login_attempts` records attempts, `account_locks` records
  locks, `sessions` records sign-ins, and each of them is a fact about one feature, not a log.

### What the gate will and will not accept (read from migrations/verify.ts)
- Forbidden in a forward file: the three placeholder markers the gate lists, a `drop table`, a
  `truncate`, a `delete from`, non-ASCII text, a missing `begin;`/`commit;` pair, a missing path
  comment, a table without the six required columns, RLS or its default-deny policy.
- Not forbidden: a trigger body that raises an exception, and a `create function`. The words
  "before update or delete on" do not match the `delete from` pattern, so an append-only guard is
  expressible.

## 2. Design Decisions Taken Before Coding

1. **One table, `public.audit_logs`, exactly as the title says.** Merkle roots are a derived export
   (section 31 and the job list in section 27), so the table stores the chain the roots are computed
   from: `chain_id`, `sequence`, `hash`. A roots table would be a second STEP's scope.
2. **Each tenant has its own chain.** `chain_id` is a generated column,
   `coalesce(company_id, '00000000-0000-0000-0000-000000000000')`, so a merchant's chain is
   independent of every other tenant and platform rows (company_id null) share one platform chain.
   A single global chain would serialise every write in the system behind one head.
3. **`sequence` is per chain and gapless.** `unique (chain_id, sequence)` is the rule; a duplicate
   sequence is refused by the index, so two concurrent writers cannot both take the same slot and
   the loser retries.
4. **The chain is guarded in the database, not only in code.** A before-insert trigger refuses a row
   whose `sequence` is not the chain head plus one, or whose `prev_hash` is not the head's `hash`.
   The first row of a chain must point at the genesis hash of sixty-four zeros. The service may
   still compute the same thing; the trigger makes a service bug impossible to store.
5. **The table is append-only, enforced.** A before-update and before-delete trigger raises an
   exception, so an audit row cannot be edited or removed even by the table owner. The six audit
   columns stay because every table carries them and because the gate requires them; `deleted_at`
   is unreachable by design and the table comment says so.
6. **Every entry is signed.** `signature` holds the base64url Ed25519 signature of the 32 byte hash
   (86 characters), and `signing_key_id` names the key that produced it, so a rotated key does not
   make old entries unverifiable. Both are `not null`: an unsigned audit entry is not an audit
   entry, and the signing key is configuration, not a schema object.
7. **The hash is over a canonical string, defined here once.** The service computes
   `sha256("v1|" + chain_id + "|" + sequence + "|" + created_at + "|" + actor_user_id + "|" +
   action + "|" + entity_type + "|" + entity_id + "|" + payload + "|" + prev_hash)`, lower case hex.
   The database cannot recompute it, so it guarantees the parts it can: the shape, the link to the
   previous hash, and that the row cannot change afterwards. The definition is written in the table
   comment and in the handoff, because a second definition would break every later verification.
8. **What was done is queryable, not buried in JSON.** `action` is a dotted key such as
   `session.revoked` or `payout.released`; `entity_type` and `entity_id` name the subject; `payload`
   is a JSON object holding the before and after values, bounded in size. A log that can only be
   read as prose is a log nobody checks.
9. **Who did it can be a person or the system.** `actor_user_id` is nullable and the null value
   means "the platform did this", which is what a scheduled job or a webhook handler is. An FK keeps
   a named actor honest.
10. **Context is recorded with the row.** `session_id`, `ip_address` and `user_agent` answer "from
    where" for the events section 22 cares about, and are nullable because a background job has no
    browser.
11. **Payloads never carry secrets.** The check bounds the size; the rule that no secret is written
    is a code rule, stated in the comment and enforced by the logger's redaction in the STEP that
    writes entries.
12. **RLS on, default deny, nothing forced**, as on the previous twelve tables. STEP 035 grants
    read access to office roles; nothing grants update or delete, and the trigger would refuse them
    anyway.
13. **Rollback drops the table and the two guard functions.** The gate requires the down file to
    drop the table its forward file creates; the functions are dropped in the same file so a
    rollback leaves the schema exactly as it was.

## 3. The Schema This Produces

`public.audit_logs`

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | primary key, default `uuid_generate_v7()` |
| company_id | uuid | null for platform events, otherwise the tenant |
| chain_id | uuid | generated stored, `coalesce(company_id, 00000000-0000-0000-0000-000000000000)` |
| sequence | bigint | not null, greater than zero, gapless per chain |
| actor_user_id | uuid | null means the platform acted |
| action | text | not null, dotted key, at most 64 characters |
| entity_type | text | null, lower snake, at most 48 characters |
| entity_id | uuid | null, the subject of the action |
| payload | jsonb | not null, a JSON object, at most 8192 bytes of text |
| session_id | uuid | null, references `sessions(id)` |
| ip_address | inet | null |
| user_agent | text | null, at most 512 characters |
| prev_hash | text | not null, 64 lower case hex, the previous row's hash or the genesis zeros |
| hash | text | not null, unique, 64 lower case hex, never equal to `prev_hash` |
| signature | text | not null, base64url Ed25519 signature, 86 characters |
| signing_key_id | text | not null, which key signed, so rotation does not break old rows |
| created_at | timestamptz | not null, default `now()`, the event instant |
| updated_at, deleted_at, version | audit set | present because every table has them; unreachable behind the append-only guard |

Indexes: `audit_logs_chain_key` unique `(chain_id, sequence)`, `audit_logs_hash_key` unique `(hash)`,
`audit_logs_company_idx` `(company_id, created_at desc)`, `audit_logs_actor_idx`
`(actor_user_id, created_at desc)`, `audit_logs_action_idx` `(action, created_at desc)`,
`audit_logs_entity_idx` `(entity_type, entity_id)`, `audit_logs_session_idx` `(session_id)`.

## 4. The Five Sub-Steps

Each sub-step ends with its own proof and a request for the owner's approval.

### 017.1 - Inventory, decisions and ownership (this document)
Read sections 1, 2, 22, 27, 31 and 37, the gate's own rules, the STEP 016 handoff and the twelve
existing migrations; measure what exists; fix the schema above. No code.

### 017.2 - `0013_audit_logs.sql` and its rollback, with the shape proof
Create the table with its format checks, its seven indexes, the append-only guard, the chain guard,
RLS and the default-deny policy, plus comments. Proof on PostgreSQL 16.2: forward apply on a
database that has `0001`-`0012`; a genesis row and a second row; an unknown action shape, an
over-long payload, an over-long user agent, a bad hash shape, a signature of the wrong length and an
unknown actor each refused by name; the append-only guard refusing an edit and a removal; the
rollback removing the table and both functions and nothing else.

### 017.3 - Chain and signature proof
Prove the chain itself: three entries link head to tail; a wrong `prev_hash` is refused by the
trigger; a repeated `sequence` is refused by `audit_logs_chain_key`; a first row that does not point
at the genesis zeros is refused; a fork (a second row after the same parent) is refused; a duplicate
`hash` is refused; and the documented verification query returns clean on an untouched chain and
finds the break after a deliberate hole is simulated on a scratch copy.

### 017.4 - Cross-table proof, RLS and the gate
Write real events from the previous STEPs into the log: a session revocation, an account unlock and
a permission grant, each with its actor, its entity and its context; prove the payload holds the
before and after values and no secret; prove a plain role sees nothing and cannot insert, update or
remove; roll all thirteen migrations back in reverse and apply them again on a fresh database; run
the gate and its mutation probes.

### 017.5 - Documentation, full verification, commit and handoff
Update `migrations/README.md` and the root README database section, run `npm run verify`, write
`docs/handoffs/STEP_017_COMPLETED.md`, commit as "STEP 017: Migration for audit logs append-only
hash chain table", push, and stop.

## 5. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0013_audit_logs.sql, .down.sql | created in 017.2 |
| migrations/README.md (the migrations index) | modified in 017.5 |
| README.md (the database section) | modified in 017.5 |
| docs/planning/STEP_017_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_017_COMPLETED.md | created in 017.5 |

No `package.json` change: the migrations gate already covers new files.

Not owned here, therefore untouched: every `lib/` module (including `lib/logger/`), `config/`, the
environment contract, migrations `0001`-`0012`, the Merkle root export job and its schedule
(section 27/31 belong to the jobs STEPs), the permissive RLS policies (035), the Ed25519 key
material itself (configuration and secrets, never a migration), and every code STEP, including the
audit writer that will use the canonical string defined above.

## 6. Open Points The Owner May Want To Change

1. **`signature` and `signing_key_id` are `not null`.** The alternative is a nullable signature with
   a check that the two are set together, which allows unsigned rows in a table whose whole purpose
   is evidence.
2. **One chain per tenant, plus one platform chain**, rather than one global chain. A global chain is
   simpler to reason about and serialises every audit write in the platform behind one head.
3. **The chain is enforced by a trigger and a unique index**, so a forked or out-of-order write is
   refused at the point of writing instead of being caught later by the verification query.
