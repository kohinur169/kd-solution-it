// path: docs/handoffs/STEP_076_COMPLETED.md
# STEP 076 - Audit log viewer with filters for office roles: completed

Branch `arena/1dc51ec3-kd-solution-it`. Commit `f529bf9`. Previous handoff:
`docs/handoffs/STEP_075_COMPLETED.md`.

## STEP

- **Number and title:** STEP 076 - Audit log viewer with filters for office roles
  (`docs/final/STEP_PLAN_250.md`, the STEP 076 block).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. Ninth STEP of the block.
- **Feature list:** section 1 - "Audit log entry on every mutation. Hash-chained append-only audit log
  with Ed25519 signing and Merkle root export." - and section 33 - "Security sensitive features are
  complete only after the audit log entries for their actions are verified in staging."
- **Depends on:** STEP 014 (`0013_audit_logs.sql` - the table, its eleven checks, the append-only
  trigger, the chain guard and the four indexes), STEP 034 (`0074_platform_and_audit_policies.sql` -
  the two select policies), STEP 036 (`0075_audit_chain_functions.sql` - the five functions), STEP 063
  (`lib/auth/audit.ts` - `PLATFORM_CHAIN_ID` and the signing trail), STEP 068 (the office shell), STEP
  069 (`lib/auth/rest.ts`'s `rpc`) and STEP 074/075 (the registry, service, runtime and gate patterns
  this STEP follows).

## Files

- **Created:** `migrations/0100_audit_log_range_indexes.sql`,
  `migrations/0100_audit_log_range_indexes.down.sql`, `lib/audit-log/registry.ts`,
  `lib/audit-log/service.ts`, `lib/audit-log/runtime.ts`, `lib/audit-log/verify.ts`,
  `app/(admin)/audit-log/page.tsx`, `app/(admin)/audit-log/audit-filter-form.tsx`,
  `app/(admin)/audit-log/audit-log-table.tsx`, `docs/planning/STEP_076_SUBSTEP_BREAKDOWN.md`,
  `docs/handoffs/STEP_076_COMPLETED.md`.
- **Modified:** `lib/i18n/strings/en.ts` (the `officeAudit` block and two `office.sectionAuditLog`
  strings), `components/office/navigation.ts` (the eleventh screen, with the role list imported rather
  than restated), `components/office/verify.ts` (eleven screens; the audit entry's roles compared with
  the registry; the two screen counts the role matrix produces), `lib/security/verify.ts` (the dotted
  action scan no longer reads `verify.ts` files, whose fixtures are names a gate is proving rather than
  names the tree records).
- **Owned paths touched:** `lib/audit-log/` (new), `app/(admin)/audit-log/` (new),
  `migrations/0100_*`, plus the copy, navigation and gate files a new screen always touches.

## Database

- **One migration, and it is two indexes.** `0013`'s four composite indexes are each led by an equality
  column - `(company_id, created_at desc)`, `(actor_user_id, created_at desc)`, `(action, created_at
  desc)`, `(entity_type, entity_id)` - which is the right shape for "this tenant", "this person", "this
  action" and "this row's history". The viewer asks two questions none of them can answer:
  - **`audit_logs_created_idx` on `(created_at desc)`** - the page a person lands on before typing
    anything, where no leading equality column exists and every `0013` index is unusable.
  - **`audit_logs_action_prefix_idx` on `(action text_pattern_ops, created_at desc)`** - the family
    filter. A btree on `action` under the default operator class can serve equality and range but not a
    `like 'session.%'` prefix, which is why the pair is repeated under the operator class a prefix is
    written against. It is additive: the equality index stays, because an exact action is still the
    cheaper lookup.
  - Both are partial on `deleted_at is null`, like their four predecessors, because
    `audit_logs_append_only` refuses every delete and the viewer never reads a removed row.
- **What this STEP deliberately does not add.** No table, no column, no policy, no data change. `0074`
  already grants the read to the three roles the screen's registry names, and the policies are the
  truth the screen agrees with rather than restates.
- **Rollback:** `0100_audit_log_range_indexes.down.sql` drops exactly the two indexes and leaves
  `0013`'s four, so the schema returns to the state STEP 075 shipped.
- **Migration number after this STEP:** `0101` is free.

## Environment

- No new variable. The screen reads through the authentication runtime, which already validates the
  seven boot variables.

## Packages

- **No dependency added, removed or changed.** `package.json` and `package-lock.json` are untouched.
- **Package requests still open for the owner:** `check:audit-log` (`node lib/audit-log/verify.ts`),
  `check:announcements`, `check:settings`, `check:countries`, `check:approvals`, `check:office`,
  `check:auth`, `check:security`, `check:gateways`, `check:permissions`.

## What was built

- **`lib/audit-log/registry.ts`** - `AUDIT_LOG_READ_ROLES` and `AUDIT_LOG_SCREEN_ROLES` (`ceo`,
  `compliance_kyc`, `super_admin`, the three `0074` grants its select to); the page size 50, the offset
  ceiling 2000, the range ceiling 366 days, and the three preview ceilings (2000 characters of payload,
  160 of user agent, 12 of hash); the action-prefix and entity-type patterns; the closed filter set
  (`action`, `actorUserId`, `entityType`, `entityId`, `companyId`/`platformOnly`, `fromDay`, `toDay`);
  `parseAuditQuery`, which lower-cases and trims every value, refuses one that is not the shape its
  field declares and reports it as `{field, rule}` rather than approximating it, clamps the offset into
  the window and refuses a range that runs backwards or past a year; `startOfDayEpochMs`,
  `endOfDayExclusiveEpochMs` and `auditDayOf`; `hasAuditFilters`; and `auditQueryStringOf`, the one
  place a filter set becomes a URL.
- **`lib/audit-log/service.ts`** - `listAuditEntries`: one PostgREST query, ordered
  `created_at desc,sequence.desc`, asking for fifty-one rows so that "there is more" comes from the
  extra row rather than a second count; a projection that splits the action family, cuts the payload at
  the ceiling and says that it cut it, shortens the user agent, previews both hashes, and keeps the
  instant as text and as a number; then the chains the page touched. `verifyAuditChain`: one call to
  `audit_verify_chain` with `p_from_sequence` 1, whose answer is parsed as a schema - a chain that is
  not a uuid is `RESOURCE_NOT_FOUND` before the call, an empty answer or a wrong shape is
  `DEPENDENCY_FAILED`. Both entry points ask `requireAnyRole` first.
- **`lib/audit-log/runtime.ts`** - the PostgREST client and the clock, projected from the
  authentication runtime, so the screen verifies through the same client the trail writes with.
- **`app/(admin)/audit-log/page.tsx`** - the five answers (`signed-out`, `forbidden`, `unavailable`,
  `ready`, and the check's own `none`/`failed`/`ready`); the filter form; the refused values printed as
  sentences beside the rows that were read; the page of rows with its "read at" instant; the two
  pagination links; and the chain section, which offers one check per chain on the page and prints what
  came back - how many rows were walked, the head, or the first break and the function's reason.
- **`app/(admin)/audit-log/audit-filter-form.tsx`** - a plain GET form with a hint under every field,
  a clear link that appears only when something is filtered, and no hidden offset: pressing the button
  is a new question, and a new question starts at the newest end.
- **`app/(admin)/audit-log/audit-log-table.tsx`** - eight columns, identifiers shortened to eight
  characters, hashes to twelve, the payload folded into a `details` element printed as text inside
  `pre`, and a note when the payload was cut.
- **`lib/audit-log/verify.ts`** - the gate.

## Behaviour Proof (acceptance checklist)

- **Three roles read, four do not.** `superAdmin`, `ceo` and the compliance desk read the page and run
  the check; `finance_ops`, `support`, `blogger`, `owner` and an account with no role are refused with
  `PERMISSION_DENIED` **before any request is made** - the gate asserts the query count and the call
  count stay zero for each of them.
- **A page is fifty rows and knows where it ends.** Sixty rows: the first page carries fifty, names
  offset 50, and has no previous; the page at 50 carries ten and names 0; the page at 5 carries fifty
  and names both. Exactly fifty rows do **not** promise another page.
- **A filter is applied whole or not at all.** Every field is refused on its own bad value with the
  field and the rule; a range that runs backwards drops its end, one longer than a year drops its
  start, and a day that does not exist (`2026-02-30`) is refused rather than normalised into March -
  which is why the end of the day is written from the validated start plus a day, not from the
  normalising helper.
- **An empty form is the newest rows of every chain**, and the platform's own chain is
  `company_id is null`, spelled `company=platform` in the URL and never an equality with the zero uuid.
- **The query is the filter, exactly.** The gate reads the PostgREST string: `action=like.<prefix>*`,
  `actor_user_id=eq.<uuid>`, `entity_type=eq.`, `entity_id=eq.`, `company_id=eq.|is.null`,
  `created_at=gte.`/`created_at=lt.`, `order=created_at.desc,sequence.desc`, `limit=51`, `offset=`.
- **The round trip is lossless.** A filter set written into a URL and read back is the same filter set
  with the same offset and no refusal.
- **The viewer only reads.** The store the gate runs over records every write it is asked for and all
  of them stay empty; the service's source is scanned for `.insert(`, `insertReturning(` and
  `.update(`, and each must be absent.
- **The chain check is `0075`'s answer, not this module's arithmetic.** The gate asserts the call is
  `audit_verify_chain` with `p_chain` and `p_from_sequence: 1`, that a bigint answered as text is read
  as a number, that an invalid chain is read as holding a break with its reason, that a chain identifier
  that is not a uuid never reaches the function, and that an empty or malformed answer is an outage.
- **Every sentence is in the catalog, both ways.** Every `officeAudit.*` key the code names exists, and
  every key the catalog holds is printed somewhere - the gate proves neither direction has drifted.

## Security proof

- **The read is the policy's.** `0074` grants `audit_logs_office_select` to exactly the three roles the
  registry names; the service asks the same list before its first query. A screen that restated them
  could hide a screen the service would serve, so the page holds no role list at all.
- **Nothing can be written from this screen, by construction.** `0013`'s `audit_logs_append_only`
  refuses every update and every removal whatever role asks, no policy grants an insert, and the module
  has no writer. The screen also carries no mutation: every control is a link or a GET form, so there is
  no CSRF token to own and no request body to validate.
- **No secret reaches the page.** The projection selects the seventeen columns the screen prints or
  checks and never `payload` wholesale: the payload is the row's own jsonb document, written by the
  service that recorded the event, and it is printed as text inside `pre` - never as markup, because
  `dangerouslySetInnerHTML` appears nowhere in the module.
- **A verification stamp is generated, not read.** The two `created_at` bounds are built from a
  validated calendar day and a millisecond count, so the only user-controlled part of the query string
  is escaped through `encodeURIComponent`.
- **The gate's own store speaks five operators** - `eq`, `is.null`, `like`, `gte`, `lt` - and throws on
  any other, so a query the real PostgREST would refuse cannot pass here as a pass.

## Verification

Every gate, run in this order after the last edit:

- `npm run typecheck` - clean.
- `npx eslint .` - clean.
- `node lib/audit-log/verify.ts` - **audit log gate passed: 735 checks, 3 read roles, 50 rows a page**
  (new).
- `node components/office/verify.ts` - **526 checks, 6 office roles, 11 screens, 7 roles decided** (was
  508 / 6 / 10 / 7).
- `node lib/auth/verify.ts` - 2455 checks, 18 browser files that mutate, 20 call sites (unchanged: the
  screen adds no route).
- `node lib/security/verify.ts` - 2376 checks (unchanged after the scan's `verify.ts` exclusion).
- `node lib/settings/verify.ts` - 551 checks.
- `node lib/announcements/verify.ts` - 351 checks.
- `node lib/approvals/verify.ts` - 536 checks.
- `node lib/gateways/verify.ts` - 467 checks.
- `node lib/countries/verify.ts` - 467 checks.
- `node lib/permissions/verify.ts` - 425 checks.
- `node lib/jobs/verify.ts` - 110 checks.
- `npm run check:migrations` - **2922 checks, 100 migrations, 76 tables** (was 2902 / 99 / 76).
- `npm run check:i18n` - **938 messages, 76 placeholders, 1 locale** (was 868 / 58).
- `npm run check:structure` - 17 directories, 14 root files, **240 source files** (was 233).
- `npm run check:shell` - **357 checks, 89 files** (was 351 / 86).
- `npm run check:env`, `check:config`, `check:logger`, `check:errors`, `check:lint`, `check:jobs` -
  green.
- `npm run build` - compiles; `/audit-log` is dynamic beside the other office screens.
- **Runtime smoke:** with a local `.env.local` (git ignored, development placeholders) and
  `npm run dev -- --port 3105`, `/audit-log`, `/audit-log?action=session.&company=platform&offset=50`
  and `/audit-log?verify=00000000-0000-0000-0000-000000000000` each answered `307` to `/signin` for an
  anonymous visitor, and `POST /audit-log` answered `307` rather than an error. The server log shows no
  render error on any of the four.
- `npm run verify` - the whole sweep above, exit 0.

## Known limitation, recorded rather than hidden

- **A signed in pass was not exercised in this sandbox.** There is no browser and no session here, so
  the behaviour proof above is the gate's, over the real service code; the deployment checks below are
  the pass a person runs against a seeded project. The gate covers the twenty behaviours the screen
  claims, but "a person can press it at two widths" is a browser fact it cannot prove.
- **An offset is a window, not a position.** The log only grows at its head, so rows written between
  two page loads shift the page under a reader. That is honest for an append-only log and it is why the
  offset stops at 2000; a viewer that wanted stable pages would need a read transaction per page, which
  the platform's PostgREST access cannot express.
- **No free text search, by decision.** The filter set is the keys a row was recorded under. A payload
  substring search over jsonb would be a sequential scan of the platform's whole history on every
  keystroke; the STEP that needs it needs a search index, not a LIKE.
- **The chain check is one chain at a time.** The page offers a check for each chain its rows belong
  to, and `audit_merkle_root` of `0075` is an export rather than a screen; a periodic "verify every
  chain and record the result" job belongs to the STEP that owns that schedule.
- **`broken_reason` is the function's own text.** It is printed as the string `audit_verify_chain`
  returns, not reworded from the catalog, because rewording a reason the database produced would hide
  which branch refused. The sentence around it is the catalog's, and a null reason prints the
  catalog's "the function gave no reason".
- **A `PERMISSION_DENIED` refusal still arrives without its details** in a response envelope, as in
  STEPs 069-075; this screen has no route, so it renders the sentence directly from the code it maps.

## Deployment checks a person runs

1. Confirm `0100` is applied: `pg_indexes` lists `audit_logs_created_idx` and
   `audit_logs_action_prefix_idx`, both partial on `deleted_at is null`, and `0013`'s four indexes are
   still there.
2. Sign in as the super administrator and open `/audit-log`: the newest fifty rows appear, newest
   first, each with its action, actor, entity, chain, sequence, hash and payload.
3. Type `session.` into "Action starts with" and press "Apply the filters": only the `session` family
   is listed, the URL carries `action=session.`, and the platform's chain is offered for a check.
4. Press "Check this chain": the panel reports how many rows were walked and the head it ended at. On a
   seeded project with a tampered row it names the first break and the function's reason instead.
5. Type `acme` into "Company": the form reports that the field was not used and lists the rows it did
   read - the value is dropped, not interpreted.
6. Type `2026-02-30` into "From": the same treatment, with the sentence about a day that exists.
7. Press "Older rows" twice and then "Newer rows": the offsets move in fifties, the position line reads
   the rows on screen, and clearing the filters returns to offset 0.
8. Sign in as `ceo` and then as `compliance_kyc`: both open the screen, and the sidebar offers it. Sign
   in as `support` and then `finance_ops`: no sidebar entry, and `/audit-log` shows the refusal.
9. Open `/audit-log` at 375 pixels wide: the table scrolls inside its frame, the filter fields stack one
   per row, and the payload folds and unfolds.
10. Section 33's staging requirement: pick one mutation of this build (for example
    `announcement.published` from STEP 075), confirm its row here through the matching filter, and check
    its chain - the entry exists, it is chained, and the chain holds.

## Next

STEP 077 - session management with revoke actions. The seams this STEP leaves: `lib/audit-log/registry.ts`
is the shape a read-only screen's filters take when every value has to be refused rather than
approximated, `auditQueryStringOf` is the one place a filter becomes a URL, and
`lib/audit-log/service.ts` shows how a page answers "is there more" without a second count query - the
same question a session list of unknown length asks. `AUDIT_LOG_READ_ROLES` is also the fourth list of
readers this block has produced, and the session screen's revoke is a mutation, so it takes the CSRF and
request-proof path the announcements route took rather than the read path here.
