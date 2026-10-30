// path: docs/planning/STEP_014_SUBSTEP_BREAKDOWN.md
# STEP 014 - Sub-Step Breakdown

The owner asked for this STEP to be written in one pass rather than sub-step by sub-step, so the
five parts below were executed in one turn. The proofs are in
`docs/handoffs/STEP_014_COMPLETED.md`.

## 1. Scope Confirmed From The Source Documents

- STEP 014 as written in `docs/final/STEP_PLAN_250.md`: "Migration for office permissions,
  delegation, announcements and announcement dismissals tables", in the Database Schema and Row
  Level Security category, which owns only numbered migration files and the migrations index.
- FEATURE_LIST.md section 2: "super_admin ... delegates permissions to office roles", "Every
  permission grant, change and use is audit logged", and the approval chain requester, then CEO,
  then super_admin.
- FEATURE_LIST.md section 24: "super_admin publishes announcements that appear as popups
  everywhere. A user can dismiss an announcement, and a dismissed announcement does not appear
  again for that user." Support tickets, the status page and platform settings are named in the
  same section but belong to STEPs 032, 230 and 068-078.
- What exists: eight proven migrations from STEPs 012 and 013, with `public.uuid_generate_v7()`,
  `public.set_row_metadata()`, `companies`, `job_queue`, `users` and `role_assignments`, and a
  static gate that already understands the conventions.

## 2. Decisions Taken Before Coding

1. **Four tables, four migrations.** `0005_office_permissions`, `0006_delegations`,
   `0007_announcements`, `0008_announcement_dismissals`, each with its own `.down.sql`. The order is
   the dependency order, and the rollback order is its reverse.
2. **A permission is a grant row, not a boolean on a user.** `office_permissions` mirrors
   `role_assignments`: `granted_by`, `granted_at`, `revoked_at`, one live grant per user and
   permission, and the revoked rows kept as history.
3. **Permission keys are dotted text.** `payout.release`, `kyc.decide`. The catalog belongs to the
   STEP that performs the action; the database enforces the shape and the length, exactly as it
   does for job names.
4. **A permission can expire.** `expires_at` makes a temporary delegation self clearing, which is
   what "super_admin delegates" needs in practice; a permanent grant simply leaves it null.
5. **A delegation is a bounded handover between two people.** `delegations` requires `ends_at`,
   refuses `delegator = delegate`, and is unique per pair and scope while live. It records the
   handover; it does not by itself grant a permission, and the STEP that performs an approval reads
   both tables.
6. **An announcement has no status column.** `published_at` null is the draft, set is published,
   `expires_at` is the automatic stop. A status keyword would let "published" and the instant
   disagree, and the popup query filters on the instant anyway.
7. **Audience is three values, not a role list.** `all`, `owners`, `office`. The shell renders the
   popup, so a new role must not silently inherit a banner written for merchants.
8. **A dismissal is unique, permanent and cheap to query.** One row per announcement and user,
   enforced by `announcement_dismissals_key`, with an index for "what has this person already
   closed". The row is never deleted; a dismissal is a fact.
9. **Tenancy follows the pattern already proven.** `company_id` is nullable only where the row can
   legitimately be platform wide (a platform permission, a platform scope delegation, a platform
   announcement, a dismissal by office staff), and every one of those columns is documented and
   carries the same foreign key.
10. **RLS on, default deny, nothing forced.** Four more `<table>_default_deny` policies; STEP 035
    adds the permissive policies, and the owner and the service role must still be able to write.
11. **No new function, no new extension.** The two helpers from `0001` are reused; a second
    definition would make the rollbacks ambiguous.

## 3. The Five Sub-Steps, Executed In One Pass

- **014.1 Inventory and ownership.** Read the STEP, sections 2 and 24, the STEP 013 handoff and the
  eight existing migrations; fixed the four tables and the decisions above.
- **014.2 Office permissions.** `0005_office_permissions.sql` plus its rollback: the grant table,
  three live indexes, the trigger, RLS and the policy.
- **014.3 Delegations.** `0006_delegations.sql` plus its rollback: the handover table with its
  window, two live indexes, the trigger, RLS and the policy.
- **014.4 Announcements and dismissals.** `0007` and `0008` with their rollbacks: the draft and
  publish instants, the published index, the unique dismissal pair, the trigger, RLS and the
  policies.
- **014.5 Proof, documentation and handoff.** A forward apply of all eight migrations on a clean
  database, every constraint exercised, RLS refused for a plain role on all four new tables, all
  eight rollbacks in reverse order leaving an empty schema, a second clean apply, the gate with its
  new mutation probes, `npm run verify`, this document and the handoff.

## 4. Files This STEP Owns

| Path | Action |
| --- | --- |
| migrations/0005_office_permissions.sql, .down.sql | created in 014.2 |
| migrations/0006_delegations.sql, .down.sql | created in 014.3 |
| migrations/0007_announcements.sql, .down.sql | created in 014.4 |
| migrations/0008_announcement_dismissals.sql, .down.sql | created in 014.4 |
| migrations/README.md (the migrations index) | modified in 014.5 |
| README.md (the database section) | modified in 014.5 |
| docs/planning/STEP_014_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_014_COMPLETED.md | created in 014.5 |

No `package.json` change: the migrations gate already covers new files.

Not owned here: every `lib/` module, `config/`, the environment contract, migrations `0001` to
`0004`, the permissive RLS policies (035), support tickets and the status page (032, 230), the
office dashboards (068-078) and every code STEP.

## 5. Open Points

1. `expires_at` on a permission is optional; a permanent delegation is a null.
2. Delegation scopes reuse the permission key shape rather than a separate vocabulary, so a scope
   that means an action uses the same dotted name as the permission it needs.
3. Announcement bodies are rendered as text, never as raw HTML; if rich copy is needed later, that
   is a sanitizer decision in the STEP that renders the popup, not a column change.
