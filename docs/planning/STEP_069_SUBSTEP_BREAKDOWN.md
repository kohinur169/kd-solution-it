// path: docs/planning/STEP_069_SUBSTEP_BREAKDOWN.md
# STEP 069 - Sub-step breakdown

STEP 069: **super_admin dashboard home and gateway management page with key test, enable and disable
controls** (`docs/final/STEP_PLAN_250.md` lines 898-907), from `docs/final/FEATURE_LIST.md` section 6
(the five providers, the gateway page, encrypted keys, the connection test that gates an enable) and
section 2 (the office roles and the approval chain), the second STEP of the Office Dashboards and
Permissions block 068-078.

## What already exists, and what is missing

- `migrations/0029_payment_providers.sql` (STEP 023) - the platform catalogue: the closed
  vocabulary `nmi|payoneer|rainforest|stripe_connect|airwallex`, the capability booleans, the panel
  order, `status disabled|enabled`, `enabled_at`, the test columns, and
  `payment_providers_test_check`, which makes "enabled without a passing test" impossible.
- `migrations/0030_provider_keys.sql` (STEP 023) - the sealed key: one column per part of an
  AES-256-GCM box, the fingerprint, the last four characters, `mode test|live`,
  `status active|disabled`, the rotation columns, the two partial unique indexes
  (`provider_keys_fingerprint_key`, `provider_keys_active_key`) and `provider_keys_guard_secret`,
  which freezes a key's identity.
- `migrations/0073_office_and_secret_policies.sql` line 209 and
  `migrations/0074_platform_and_audit_policies.sql` line 87 - the RLS policies: `provider_keys` is
  the super administrator's alone, `payment_providers` is theirs to write and readable by the CEO and
  finance operations.
- `lib/auth/secrets.ts` (STEP 028) - `sealSecret`/`openSecret`: AES-256-GCM with the master key from
  the environment, and additional authenticated data that binds a box to one row.
- `lib/auth/request-proof.ts`, `lib/auth/step-up.ts`, `lib/security/csrf.ts` (STEPs 050-057) - the
  device proof, the ten minute freshness window and the CSRF guard every sensitive mutation uses.
- `lib/auth/session-list.ts`, `lib/auth/two-factor-reset.ts` - the house shape of an office service:
  a role constant, `requireAnyRole`, `requireFreshReauthentication`, an audit entry per act.
- `app/(admin)/` (STEP 068) - the shell, `readOfficeActor`, `decideOfficeAccess` and
  `OFFICE_NAVIGATION`, which is the only place that knows a screen's address.

What was missing: no row in the catalogue (the five providers were a vocabulary, not data), no way to
store a key, no connection test, no switch, and no office home for the role that owns all three.

## The decisions this STEP makes

1. **The registry is code, the state is a row.** `lib/gateways/registry.ts` owns the five keys, their
   names, their capability matrix and their panel order, because section 6 asks for "one registry
   file listing all five" and forbids a provider without an adapter from being added.
   `0094_seed_payment_providers.sql` seeds the same five values into the table, because a provider
   carries state only a row can hold. The gateway gate compares the migration's `values` clause to
   the registry, key by key and boolean by boolean.
2. **A migration seeds the catalogue, and it is idempotent.** The unique index on `provider_key` is
   partial, so no `on conflict` target exists; the insert selects the rows that are not already
   there. The rollback refuses to remove a provider that is enabled or holds a key.
3. **A key is added disabled, and becomes active only through a passing test.** Two check
   constraints decide this: `provider_keys_test_check` (active requires a pass) and
   `provider_keys_active_key` (one active key per provider and mode). Activation therefore disables
   the key it replaces in the same call - a rotation, which is the only way a live credential moves.
4. **A failing test of the live key takes the provider off; a failing test of a candidate does not.**
   `payment_providers_test_check` cannot hold "enabled" and "test failed" at once, so the choice is
   forced. It is resolved in the honest direction: the credential routing uses is the one whose
   failure matters, and a sandbox candidate that did not pass must not stop a working gateway.
5. **Disabling a provider disables its active keys.** An active key is the credential routing would
   reach for, so a provider that is off holds none. Enabling therefore needs a fresh pass, which is
   section 6's rule applied to every enable rather than only to the first.
6. **The cipher is the platform's, not a fourth one.** `lib/auth/secrets.ts` already seals the
   Turnstile secret and every TOTP secret with AES-256-GCM under `ENCRYPTION_MASTER_KEY`, and
   `provider_keys` has exactly the three columns its box has. The box is bound to
   `provider_keys:<provider>:<mode>:<fingerprint>`, so a ciphertext copied between rows fails to open.
7. **The read never selects what it must not show.** The panel query names `key_last_four` and
   `updated_at` and does not name `key_ciphertext`, `key_iv`, `key_tag` or `key_fingerprint`. The gate
   asserts that against the query strings, so "a full key is never shown again" is a property of the
   select list rather than of a component's discretion.
8. **One route, four actions.** Adding, testing, enabling and disabling are transitions of one state
   machine; four endpoints would have been four copies of CSRF, body bound, session, device proof,
   role and freshness. The route is on `SENSITIVE_ENDPOINTS` and `CSRF_PROTECTED_PATHS`.
9. **The office home summarises section 6.** `/dashboard` is the super administrator's home: the
   gateway counts, the roles held, the freshness of the second factor read through the same pure
   function the service enforces, and the screens the roles open - which is the material STEP 070's
   approval queues will join.

## The sub-steps

1. **Read the sources.** FEATURE_LIST section 6 and section 2, the STEP plan lines 898-907, the STEP
   068 handoff, `0029`, `0030`, the two policy migrations, and the office services that already
   enforce a role list.
2. **Database.** `0094_seed_payment_providers.sql` and its rollback: the five rows, the section 6
   capability matrix, order 1 to 5, disabled, no test. No new table, no new policy, no new column.
3. **Registry.** `lib/gateways/registry.ts`: the five definitions, the mode vocabulary, the limits the
   columns impose, the role constants, and `ADAPTER_CONNECTION_TESTS`, the seam a later adapter
   registers its connection test in.
4. **Service.** `lib/gateways/service.ts`: `listGateways`, `addGatewayKey`, `testGatewayKey`,
   `setGatewayEnabled`, with the role check, the freshness check, the validation, the sealing, the
   version filtered writes and one audit entry per act.
5. **Runtime.** `lib/gateways/runtime.ts`: the PostgREST client, the audit trail, the sealer over
   `ENCRYPTION_MASTER_KEY` and the clock, wired once.
6. **Route.** `app/api/office/gateways/route.ts`: CSRF, body bound, session, device proof, parse,
   dispatch, plus the two registry entries the platform's gates require for a signed mutation.
7. **Screens.** `app/(admin)/gateways/page.tsx` with its client console, and
   `app/(admin)/dashboard/page.tsx`, both inside the STEP 068 shell, at desktop and phone widths.
8. **Navigation.** The two entries in `OFFICE_NAVIGATION` with the role constants imported from the
   service, and the STEP 068 gate updated to five screens and to the two new role assertions.
9. **Proof and handoff.** `lib/gateways/verify.ts` (467 checks over the real service and an in-memory
   PostgREST), the copy in the catalog, every gate in `npm run verify`, the handoff file and the
   commit.
