// path: docs/handoffs/STEP_063_COMPLETED.md
# STEP 063 - Audit log writer service with hash chaining: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_062_COMPLETED.md`
(commit `0957941`).

## What was asked

`docs/final/STEP_PLAN_250.md` line 822, the tenth STEP of the security block 056-067: an audit log writer
service with hash chaining. `docs/final/FEATURE_LIST.md` line 10 requires a hash-chained append-only audit
log with Ed25519 signing and Merkle root export on every mutation; line 288 requires integrity hash
generation; line 323 requires integrity roots to be exported on schedule so tampering can be detected.
Golden rule 9 of `docs/final/MASTER_PROMPT.md` is the same rule in one sentence.

## What already existed

- `migrations/0013_audit_logs.sql` - `public.audit_logs`, append-only and gapless by trigger, `chain_id`
  generated from `company_id`, with the constraints that state the action, entity, payload, hash,
  signature and user-agent shapes;
- `migrations/0075_audit_chain_functions.sql` - `audit_next_link`, `audit_hash_v1`,
  `audit_log_row_hash`, `audit_genesis_hash`, `audit_verify_chain`, `audit_merkle_root`;
- `lib/auth/audit.ts` - the writer of the authentication flows and the Ed25519 signing helper.

`audit_verify_chain` and `audit_merkle_root` had no reference anywhere in `lib/` or `app/`: the tamper
detection of section 31 had no caller.

## What was built

One new module, `lib/security/audit.ts`, and no new dependency, no migration and no new table.

- **A writer that belongs to no feature.** `createAuditWriter({ store, signHash, signingKeyId, now })`
  takes the three calls of the chain - `audit_next_link` for the head, `audit_hash_v1` for the canonical
  hash, then the insert - and depends on no auth type: `AuditStoreClient` is satisfied by the existing
  `RestClient` as it stands, and `signAuditHash` satisfies `signHash` as it stands. The records it
  returns are the link it extended: chain, sequence, previous hash, hash, signature, key id, instant.

- **The policy of an entry**, in the order a caller trips it: dotted action of at most 64 characters,
  entity type of at most 48, entity type and entity id together or neither, uuid columns, an address of
  family 4 or 6 (in the one spelling of STEP 062's rule, not a second parser), a user agent of 1 to 512
  characters, a payload that is an object of at most 8 192 bytes. Each becomes a named reason in `cause`,
  never a sentence a client reads.

- **Redaction at the door.** A payload key that names a credential - `password`, `passphrase`, `secret`,
  `token`, `apiKey`, `private_key`, `authorization`, `cookie`, `csrf`, `proof_key`, `otp`, `backup_code`,
  `card_number`, `cvv`, `seed` - is replaced with `[redacted]` before the size is measured and before the
  hash is asked for, at every level of the payload, on a normalised key (so `apiKey`, `api-key` and
  `API_KEY` are one key). The chain is append-only and permanent: this is the only moment the mistake is
  still cheap.

- **The link is checked before it is used.** A chain that starts at position one must point at the
  genesis hash and a chain that continues must not; the hash must be a hash and must differ from the
  previous one (as `audit_logs_hash_differs_check` requires); the signature must be eighty-six base64url
  characters; a failing insert is a failed write. Every one of those stops the entry, so a mutation is
  never reported as recorded when it was not.

- **The integrity half.** `verifyAuditChain` walks a range and returns the verdict, the first broken
  position and the reason; `readAuditMerkleRoot` returns the RFC 6962 root over the stored row hashes;
  `readAuditIntegrityReport` is what the scheduled export records, and it **refuses to publish**: a root
  over a broken chain would certify the tampering, and a root over an empty range certifies nothing, so
  both are `DEPENDENCY_FAILED` with the chain, position and reason in `cause` where an operator's log
  finds them.

- **No hash and no key in `lib/security`.** The canonical v1 form lives in `0075`; a TypeScript
  implementation would drift at the first timestamp or key-order change and the drift would surface as a
  chain that fails to verify months later. The gate asserts the module contains no hash function and no
  `node:crypto` import, and that the key arrives as a function.

## One write path, proved rather than claimed

The gate reads `lib/auth/audit.ts`, parses the object it passes to `audit_hash_v1` and the object it
inserts, and compares both with this module's `AUDIT_HASH_ARGUMENTS` (nine arguments, in order) and
`AUDIT_ROW_FIELDS` (sixteen columns, in order). It also asserts the call order is link, hash, insert, and
that the two modules are the only files in `lib/` and `app/` that insert into the audit table. A third
writer, or a column added to one and not the other, fails `npm run verify`.

It also scans the tree for every dotted `action: "..."` literal and asserts each one is a name
`audit_logs_action_check` accepts - so a typo like `invoice.Sent` fails the build instead of the insert.

## What was deliberately not connected

No route is wired, and for the same reason as the two STEPs before it: the fifteen `/api/auth/*` routes
already write through `lib/auth/audit.ts`, and every mutation STEP that is coming (invoices, refunds,
disputes, payouts, KYC decisions, office actions) owns the handler that writes its own entry. The point of
this STEP is that each of them calls `createAuditWriter` instead of inventing a chain, and that the gate
fails a third insert. The section 31 export runs on the queue of STEP 011, which is not owned here; the
service it will call is `readAuditIntegrityReport`.

No i18n string was added: nothing renders an audit entry yet, and the two sentences this STEP could
produce - a refusal to a caller and a tamper alert to an operator - are a log line and a job failure, not
a screen. A screen that shows a chain verdict needs its own sentence when it exists.

## Security proof

`node lib/security/verify.ts` - **1268 checks** (970 before this STEP; +298), still 200 code point name
ceiling, 15 allowed tags.

- The pattern equality with `0013`: seven writable actions and thirteen unwritable ones, the entity type,
  hash, signature and key-id shapes, the payload and user-agent ceilings, the genesis hash and the
  platform chain.
- The credential vocabulary against a positive list of twenty-three key spellings and a negative list of
  eleven plain keys; redaction inside objects, arrays and nested objects; the caller's object untouched;
  the result frozen and idempotent; no credential surviving in the JSON; a payload nested too deeply
  refused.
- Fourteen named entry problems, each triggered once, plus the size measured the way the column measures
  it.
- A store that answers like `0075` and records every call: the three calls in order, the nine hash
  arguments in order, the sixteen columns in order, the redacted payload reaching both the hash function
  and the row, the genesis link, the platform chain, the tenant chain, the signer receiving the hash that
  was stored, and the configured key id rather than an assumed one.
- Nine malformed heads, six malformed hashes, a repeated hash, a short signature, a failing insert, an
  invalid entry that never reaches the database, and a writer built with an unusable key id.
- The integrity corpus: a valid walk, a broken walk with its position and reason, nine malformed verdicts,
  three impossible ranges, a root, an empty range, a malformed root, a report that carries the range and
  the head, and the two refusals - a broken chain and an empty range.

Fourteen mutation controls, all caught: the credential vocabulary ignored, redaction stopping at the first
level, an action that need not be dotted, an entity type without an id accepted, the payload ceiling
removed, a chain allowed to start from a real hash, a hash allowed to repeat the previous one, an unsigned
row written, an invalid verdict believed, a root published over a broken chain, a root over nothing
published, every event put on the platform chain, the head assumed instead of read, and the key id
ignored. One control is worth recording: the key-id mutant first survived because the corpus signed with
`audit-v1`, which is exactly the string a lazy implementation would hard code; the test writer now signs
with `audit-v2`, so an implementation that ignores the option is caught by the row it writes.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx eslint app lib proxy.ts` | clean |
| `node lib/security/verify.ts` | 1268 checks |
| `node lib/auth/verify.ts` | 2385 checks (unchanged) |
| `npm run verify` | exit 0 |
| `npm run build` | exit 0 |

`npm run verify` components: structure 17 directories, 14 root files, **173** sources (172 before);
config 10 checks / 28 keys, i18n 294, logger 117, errors 202 checks / 15 codes, lint 77 checks, shell 237,
jobs 110, migrations 2746 checks / 92 migrations / 75 tables - all unchanged.

## Files

New: `lib/security/audit.ts`, `docs/planning/STEP_063_SUBSTEP_BREAKDOWN.md`,
`docs/handoffs/STEP_063_COMPLETED.md`.
Edited: `lib/security/verify.ts`, `lib/security/README.md` (a new section, "How an entry enters the audit
chain", and a row in the module table).
No migration, no `package.json` change, no new dependency, no new root file, no test file, no i18n string.

## Package requests

Unchanged from STEP 062: `check:auth` and `check:security` are still not part of `npm run verify`; a
`minimatch` bump for the moderate advisory on the default branch; DOMPurify for the rich text allowlist; a
pinned-address dispatcher for the SSRF rule.

## Next

STEP 064 of `docs/final/STEP_PLAN_250.md`, the AES-256-GCM encryption service for secrets and files, which
is the next entry of the security block. Nothing in this STEP is pending. Two seams for later STEPs: every
mutation STEP writes its entry through `createAuditWriter` (the entry shape is `lib/auth/audit.ts`'s, so
nothing has to be reshaped), and the section 27 and 31 export job records `readAuditIntegrityReport`
rather than a root it computed itself.
