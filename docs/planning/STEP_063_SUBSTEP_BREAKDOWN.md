// path: docs/planning/STEP_063_SUBSTEP_BREAKDOWN.md
# STEP 063 - Sub-step breakdown

STEP 063: **Audit log writer service with hash chaining** (`docs/final/STEP_PLAN_250.md` line 822), from
`docs/final/FEATURE_LIST.md` line 10 ("Audit log entry on every mutation. Hash-chained append-only audit
log with Ed25519 signing and Merkle root export"), line 288 ("Audit log integrity hash generation") and
line 323 ("Audit log integrity roots are exported on schedule so tampering can be detected"), inside the
security block 056-067. Golden rule 9 of `docs/final/MASTER_PROMPT.md`: every mutation writes an audit log
entry.

## What already exists, and what is missing

Three pieces were built before this STEP and none of them is rebuilt here:

- `migrations/0013_audit_logs.sql` - `public.audit_logs`: append-only by trigger, gapless per chain by
  trigger, `chain_id` generated from `company_id` (the zero uuid for the platform), `prev_hash`, `hash`,
  `signature`, `signing_key_id`, and the constraints that state the action, entity, payload, hash and
  signature shapes;
- `migrations/0075_audit_chain_functions.sql` - `public.audit_next_link`, `public.audit_hash_v1`,
  `public.audit_log_row_hash`, `public.audit_genesis_hash`, `public.audit_verify_chain` and
  `public.audit_merkle_root`;
- `lib/auth/audit.ts` - the writer of the authentication flows, with the Ed25519 signing helper.

What is missing is everything that is not an authentication flow, and the whole integrity half:

1. a writer that belongs to no feature - `lib/auth/audit.ts` needs `AuthConfig`, `AuthHttp` and the auth
   types, so a service outside `lib/auth/` cannot write an entry without importing that tree;
2. the policy of an entry - `0013` states the shapes in constraints, which report a failed insert with no
   useful message and, in the case of a payload carrying a token, do not report anything at all;
3. redaction - the table says "never a secret" and nothing enforced it, and a secret that enters an
   append-only chain can never be removed;
4. a caller for `audit_verify_chain` and `audit_merkle_root` - both were written in STEP 051's migration
   and had no reference in `lib/` or `app/`, so the tamper detection of section 31 had nothing producing
   a root.

## The decisions this STEP makes

1. **One write path, proved by the gate.** The writer makes the same three calls in the same order with
   the same arguments as `lib/auth/audit.ts`, and the gate reads both sources, parses the argument and
   column lists and compares them. When the auth flows move onto this writer, the auth module keeps only
   its key handling.
2. **The hash is never computed in TypeScript.** `0075` owns the canonical form; a second implementation
   would drift at the first timestamp or key-order change and the drift would surface as a chain that
   fails to verify months later. The gate asserts the module contains no hash function.
3. **The key never enters `lib/security`.** The signature arrives as a `signHash` function and
   `signAuditHash` satisfies it as it stands. A secret is read in one place, which is the auth
   configuration.
4. **Redaction happens at the door.** A payload key that names a credential is replaced with
   `[redacted]` before the size is measured and before the hash is asked for, so the hash covers what was
   stored. The vocabulary is a frozen list of key fragments, matched on a normalised key, and the check
   applies at every level of the payload.
5. **The rules of `0013` become reasons.** Every constraint that can be broken by a caller is named
   before the database sees it, as a machine reason in `cause` that is never serialised.
6. **A link is checked before it is used.** A chain that starts at one must point at the genesis hash, a
   chain that continues must not, the hash must be a hash and must differ from the previous one, the
   signature must be eighty-six base64url characters, and a failed insert is a failed write.
7. **An invalid chain never certifies anything.** The integrity report refuses to produce a root for a
   chain that does not verify, and refuses an empty range: publishing a root over a broken chain would
   certify the tampering instead of exposing it.
8. **The auth writer and this writer are the only two, and the gate says so.** It scans `lib/` and `app/`
   for inserts into the audit table and for dotted `action:` literals, so a third writer or a malformed
   action name fails the build rather than the reviewer.

## Owned paths

New: `lib/security/audit.ts`, `docs/planning/STEP_063_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_063_COMPLETED.md`.

Edited: `lib/security/verify.ts` (the corpus and the wiring), `lib/security/README.md`.

STEPs 056-067 own `lib/security/`, so nothing outside it is touched - including `lib/auth/audit.ts`,
which is read by the gate and not changed. No migration is added and `package.json` is not edited.

## Sub-step 1 - Read the rules and the previous handoff

`STEP_062_COMPLETED.md` (committed `0957941`), `STEP_PLAN_250.md` line 822, feature list lines 10, 288,
323 and 337, rule 9, the ownership rules at line 45, `0013`, `0075` and `lib/auth/audit.ts`.

## Sub-step 2 - Owned paths

Listed above.

## Sub-step 3 - Database

None, and deliberately so. `0013` already has the table with its constraints and its two triggers, and
`0075` already has the four functions this service calls - including the verify walk and the RFC 6962
root that had no caller. `0013` also states the decision that there is nothing to add: "Merkle roots are
derived from `chain_id`, `sequence` and `hash` by the export job; no roots are stored", so a table of
roots would contradict a committed migration. The gate compares the module's constants with the
constraint literals of `0013` and the parameter names of `0075`.

## Sub-step 4 - The core logic

`lib/security/audit.ts`:

- `AUDIT_ACTION_PATTERN`, `AUDIT_ENTITY_TYPE_PATTERN`, `AUDIT_HASH_PATTERN`, `AUDIT_SIGNATURE_PATTERN`,
  `AUDIT_SIGNING_KEY_ID_PATTERN`, `AUDIT_MAXIMUM_PAYLOAD_BYTES`, `AUDIT_MAXIMUM_USER_AGENT_LENGTH` and
  `AUDIT_GENESIS_HASH` - the constraints of `0013`, as constants;
- `AUDIT_HASH_ARGUMENTS`, `AUDIT_ROW_FIELDS` - the call and the row, in order, for the parity proof;
- `AUDIT_SECRET_KEY_FRAGMENTS`, `isAuditSecretKey`, `redactAuditPayload`, `auditPayloadBytes` - the
  redaction and the size;
- `auditEntryProblem`, `requireAuditEntry`, `buildAuditEntry` - the policy, the guard, and the prepared
  entry;
- `createAuditWriter` - the three calls, the link checks and the row;
- `verifyAuditChain`, `readAuditMerkleRoot`, `readAuditIntegrityReport` - the integrity service.

## Sub-step 5 - Routes and jobs

There is no route to connect. The fifteen `/api/auth/*` routes already write through
`lib/auth/audit.ts`, and every later mutation STEP (invoices, refunds, disputes, payouts, KYC decisions,
office actions) owns the handler that writes its own entry - the point of this STEP is that each of them
calls `createAuditWriter` instead of inventing a chain, and that the gate fails a third insert. The
integrity export of section 31 runs on the queue of STEP 011, which is not owned here; the service it will
call is `readAuditIntegrityReport`, and the gate proves it refuses a broken chain.

## Sub-step 6 - UI

Not applicable: nothing renders an audit entry yet. The office audit browser of the later office STEPs
reads the table directly, and the payload policy here (redaction, size) is what makes that view safe to
build. No screen gains a field or a string, so there is nothing to check at either width.

## Sub-step 7 - Security proof

`checkAuditPolicy`, `checkAuditRedaction`, `checkAuditEntry`, `checkAuditWriter`, `checkAuditIntegrity`
and `checkAuditWiring` in `lib/security/verify.ts`: the pattern equality with `0013`, an action corpus of
seven writable and thirteen unwritable names, the credential vocabulary and its negative list, redaction
in objects, arrays and nested objects with the caller's object untouched, the fourteen named entry
problems, a store that answers like `0075` and records what the writer asked, nine malformed heads and six
malformed hashes, a repeated hash, a short signature, a failing insert, the two chains, the integrity
corpus including a broken chain and an empty range, and the wiring (argument and column parity with the
auth writer, the constraint literals of `0013`, the four functions of `0075`, exactly two writers in the
tree, and every dotted action in the tree a name the column accepts).

Fourteen mutation controls, all caught: the credential vocabulary ignored, redaction stopping at the
first level, an action that need not be dotted, an entity type without an id accepted, the payload
ceiling removed, a chain allowed to start from a real hash, a hash allowed to repeat the previous one, an
unsigned row written, an invalid verdict believed, a root published over a broken chain, a root over
nothing published, every event put on the platform chain, the head assumed instead of read, and the key
id ignored.

## Sub-step 8 - Gates, commit, push, handoff

`npx tsc --noEmit`, `npx eslint app lib proxy.ts`, `node lib/security/verify.ts`,
`node lib/auth/verify.ts`, `npm run verify`, `npm run build`, one commit
`STEP 063: Audit log writer service with hash chaining` on `arena/1dc51ec3-kd-solution-it`, pushed, with
`docs/handoffs/STEP_063_COMPLETED.md`.
