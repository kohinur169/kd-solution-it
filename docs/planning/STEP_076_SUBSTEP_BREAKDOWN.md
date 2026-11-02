// path: docs/planning/STEP_076_SUBSTEP_BREAKDOWN.md
# STEP 076 - sub-step breakdown

STEP: **Audit log viewer with filters for office roles** (FEATURE_LIST section 1, "audit log entry on
every mutation, hash chained, Ed25519 signed, Merkle root export", and section 33's sentence that a
security sensitive feature is complete only after its audit entries are verified; STEP_PLAN_250
section 076).

The STEP is one screen over a table that already exists and may not be written, so it is cut into five
sub-steps in the order the work is verifiable rather than the order it is described.

## Sub-step 1 - read what already exists, and decide what the database is missing

- `0013_audit_logs.sql`: the table - the eleven checks, `audit_logs_append_only` refusing every update
  and every removal, the chain guard, the four composite indexes and `default_deny`.
- `0074_platform_and_audit_policies.sql`: `audit_logs_office_select` (super administrator, chief
  executive, compliance desk) and `audit_logs_merchant_select` (a company's own rows).
- `0075_audit_chain_functions.sql`: `audit_next_link`, `audit_hash_v1`, `audit_log_row_hash`,
  `audit_verify_chain` and `audit_merkle_root` - the arithmetic this STEP calls rather than copies.
- Conclusion: no table, no column, no policy. Two access paths are missing and the viewer takes both -
  "the newest rows, whatever they are" and "every action in this family" - so `0100` adds two partial
  indexes and nothing else.

## Sub-step 2 - the migration and its rollback

- `migrations/0100_audit_log_range_indexes.sql`: `audit_logs_created_idx` on `(created_at desc)` and
  `audit_logs_action_prefix_idx` on `(action text_pattern_ops, created_at desc)`, both partial on
  `deleted_at is null`.
- `migrations/0100_audit_log_range_indexes.down.sql`: drops exactly those two, leaves `0013`'s four.
- `npm run check:migrations`.

## Sub-step 3 - the registry, the service and the gate

- `lib/audit-log/registry.ts`: the three read roles and the screen's union; the page size, the offset
  ceiling, the range ceiling and the three preview ceilings; the action and entity type patterns; the
  closed filter set; `parseAuditQuery`, which refuses a value rather than approximating it; the two day
  converters, written from `lib/settings`' validated day rather than from the normalising helper of
  `lib/announcements`; and `auditQueryStringOf`, the one place a filter becomes a URL.
- `lib/audit-log/service.ts`: `listAuditEntries` (one page, one extra row to know whether there is
  more, a payload preview cut at the ceiling, the chains the page touched) and `verifyAuditChain` (one
  call to `audit_verify_chain`, one answer, no arithmetic).
- `lib/audit-log/runtime.ts`: the PostgREST client and the clock, projected from the authentication
  runtime.
- `lib/audit-log/verify.ts`: the gate, over an in-memory PostgREST that speaks the five operators the
  module's queries use and records any write it is asked for.

## Sub-step 4 - the copy

- `lib/i18n/strings/en.ts`: the `officeAudit` block (about sixty strings) and `office.sectionAuditLog`
  with its description.
- `npm run check:i18n`.

## Sub-step 5 - the screen, the sidebar and the gates

- `app/(admin)/audit-log/page.tsx`: the five answers, the filter form, the refusals, the page of rows,
  the two pagination links and the chain check the address bar can ask for.
- `app/(admin)/audit-log/audit-filter-form.tsx`: a plain GET form, so a filter is a URL.
- `app/(admin)/audit-log/audit-log-table.tsx`: the rows, the short identifiers, the twelve character
  hashes and the payload folded into a `details` element.
- `components/office/navigation.ts`: the eleventh screen, with `AUDIT_LOG_SCREEN_ROLES` imported
  rather than restated.
- `components/office/verify.ts`: ten screens become eleven, and the entry's roles are compared with the
  registry.
- `lib/security/verify.ts`: the dotted action scan skips `verify.ts` files, because a gate's fixture is
  not a name the column must accept - the prefix `session.` the viewer's filter tests is exactly such a
  fixture.
- `npm run verify`, the dev smoke, one commit and the handoff.

## What this STEP deliberately leaves out

- **No API route.** Every question the screen asks is a GET: the filters are the address bar and the
  chain check is a link. A route would add a CSRF token and a request proof to a read that changes
  nothing, which is the shape the platform reserves for mutations.
- **No free text search.** `payload` is a jsonb document; a substring scan over it would be a
  sequential scan of the whole platform's history on every keystroke. The filter set is the keys a row
  was recorded under.
- **No Merkle root screen.** `audit_merkle_root` of `0075` is a periodic export, not a viewer question;
  the STEP that publishes it owns its screen.
