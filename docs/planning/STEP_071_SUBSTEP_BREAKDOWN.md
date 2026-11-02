// path: docs/planning/STEP_071_SUBSTEP_BREAKDOWN.md
# STEP 071 - Sub-step breakdown

STEP 071: **Permission delegation screen for super_admin** (`docs/final/STEP_PLAN_250.md` lines
920-930), from `docs/final/FEATURE_LIST.md` section 2 - "super_admin ... Delegates permissions to
office roles", and "Every permission grant, change and use is audit logged" - and the two migrations
of STEP 014 that were written for it.

## What already exists, and what is missing

- `migrations/0005_office_permissions.sql` (STEP 014) - the delegated-permission table: one row per
  grant, `permission` as a dotted key, `expires_at` for a temporary grant, `revoked_at` for one ended
  early, `reason`, the live unique index and a default-deny policy.
- `migrations/0006_delegations.sql` (STEP 014) - the *other* half: an office user handing an approval
  to a colleague for a window, with `ends_at` required and a delegation to oneself refused.
- `migrations/0004_role_assignments.sql` (STEP 013) - the seven roles, `owner` included.
- `lib/auth/step-up.ts` (STEP 053) - `requireFreshReauthentication`, the ten minute proof.
- `lib/auth/request-proof.ts`, `lib/security/csrf.ts` (STEPs 050-057) - the device proof and the CSRF
  guard, both keyed by path.
- `app/(admin)/` (STEPs 068-070) - the shell, `readOfficeActor`, `OFFICE_NAVIGATION` with six screens,
  and the house shape of an office service.

What was missing: the catalog. `office_permissions.permission` stores a string and checks only its
shape, so the database cannot tell `payout.release` from a typo, and nothing in the tree said which
authorities exist, which of them may be handed out, or who may hand them out.

## The decisions this STEP makes

1. **The screen manages `office_permissions`, not `delegations`.** Section 2's sentence is the super
   administrator delegating to office roles, which is a grant of a named authority. `0006_delegations`
   records a handover between two office users, which is the CEO's own act and stays with the CEO -
   `kyc.final_approval` is therefore deliberately *absent* from this catalog.
2. **A delegation never changes a role.** The holder keeps its role, its charter and its place in the
   office, and gains one action until an instant. A permanent authority is a role; this screen only
   writes windows, between seven and a hundred and eighty days, and refuses a grant without an end.
3. **Three permissions are never handed out.** Section 6 keeps gateway keys with the super
   administrator, section 2 keeps the platform's own settings there, and the lever that grants cannot
   grant itself - a delegation that can delegate itself is a grant nobody can track. The screen names
   all three in words instead of silently leaving them out.
4. **Cross-desk delegation is allowed on purpose.** `0005`'s own comment blesses it: a support agent
   temporarily allowed to release a small payout is one row, not a new role. So the receiver must hold
   an office role, and the desk it normally belongs to is shown as information rather than enforced.
5. **Every grant and every withdrawal is audited, with the reason as a length.** `permission.granted`
   and `permission.revoked` carry the key, the holder and the window; the sentence a person wrote stays
   out of the immutable trail, the same rule the approval queue follows.
6. **`revoked_by` needed a migration.** A row that cannot name the account that ended it is a row a
   person has to trust rather than check, so `0096` adds the column, its foreign key, a one-directional
   check (an account only on a revoked row, because rows revoked before this STEP have none), and the
   partial index the "ending within seven days" read needs.

## The sub-steps

1. **Read the sources.** FEATURE_LIST sections 2 and 24 (unlock), the STEP plan lines 920-930, the
   STEP 070 handoff, `0005`, `0006` and `0004`.
2. **Owned paths.** `migrations/` (append only), `lib/permissions/` (this STEP's module),
   `app/api/office/` (an office route), `app/(admin)/` (STEPs 068-078), the office navigation, and the
   one string catalog rule 1 requires.
3. **Database.** `0096_office_permission_revoked_by.sql` and its rollback: the column, the foreign key,
   the check, the partial expiry index, and a rollback that keeps every grant and every withdrawal.
4. **Catalog.** `lib/permissions/registry.ts`: sixteen keys in five desks, thirteen delegable, the three
   reserved, the four windows, the two reason bounds and the two normalizers (a key, an address).
5. **Service.** `lib/permissions/service.ts`: `listDelegations`, `grantPermission`, `revokePermission`
   and `effectivePermissionsOf`, with the role check, the freshness check, the target checks and the
   duplicate guard beside the write they protect.
6. **Runtime and route.** `lib/permissions/runtime.ts`, and `app/api/office/delegations/route.ts` with
   one POST, two actions, CSRF, the body bound, the session, the device proof and the parse in order.
7. **Screens.** `app/(admin)/delegations/page.tsx` with `delegation-console.tsx`: the live list, the
   grant form, the withdrawal form, the lapsed list, the history and the reserved three.
8. **Navigation.** The `delegations` entry carrying `PERMISSION_DELEGATION_ROLES`, and the STEP 068
   gate updated to seven screens and to the new role assertion.
9. **Proof and handoff.** `lib/permissions/verify.ts` (the catalog, the migration, forty refusal
   scenarios over an in-memory PostgREST, the three reads, the route and page contracts, and the copy),
   every gate in `npm run verify`, the handoff file and the commit.
