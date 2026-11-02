// path: docs/handoffs/STEP_069_COMPLETED.md
# STEP 069 - super_admin dashboard home and gateway management page with key test, enable and disable controls: completed

Branch `arena/1dc51ec3-kd-solution-it`. Previous handoff: `docs/handoffs/STEP_068_COMPLETED.md`
(commit `722cb21`).

## STEP

- **Number and title:** STEP 069 - super_admin dashboard home and gateway management page with key
  test, enable and disable controls (`docs/final/STEP_PLAN_250.md` lines 898-907).
- **Category:** Office Dashboards and Permissions, STEPs 068-078. This is the second STEP of the
  block and it fills the first two concrete screens inside the STEP 068 shell.
- **Depends on:** STEP 023 (`0029_payment_providers.sql`, `0030_provider_keys.sql`), STEP 028
  (`lib/auth/secrets.ts`), STEP 050 (the device proof), STEP 052 (trusted devices), STEP 053
  (`requireFreshReauthentication`), STEP 057 (`lib/security/csrf.ts`), STEP 063 (the audit trail),
  STEP 064 (`ENCRYPTION_MASTER_KEY` in the manifest), STEP 068 (the shell, `readOfficeActor`,
  `OFFICE_NAVIGATION`) and the handoffs of 023, 028, 053, 063, 064 and 068.

## Files

- **Created:** `migrations/0094_seed_payment_providers.sql`,
  `migrations/0094_seed_payment_providers.down.sql`, `lib/gateways/registry.ts`,
  `lib/gateways/service.ts`, `lib/gateways/runtime.ts`, `lib/gateways/verify.ts`,
  `app/(admin)/dashboard/page.tsx`, `app/(admin)/gateways/page.tsx`,
  `app/(admin)/gateways/gateway-console.tsx`, `app/api/office/gateways/route.ts`,
  `docs/planning/STEP_069_SUBSTEP_BREAKDOWN.md`, `docs/handoffs/STEP_069_COMPLETED.md`.
- **Modified:** `components/office/navigation.ts` (two entries and the two role constants they
  import), `components/office/verify.ts` (five screens instead of three, and the two new role
  assertions), `app/(admin)/README.md` (the address table), `lib/i18n/strings/en.ts` (two blocks,
  76 messages), `lib/auth/request-proof.ts` (one endpoint on `SENSITIVE_ENDPOINTS`),
  `lib/security/csrf.ts` (one path on `CSRF_PROTECTED_PATHS`), `lib/auth/verify.ts` (two baselines:
  eleven browser files that mutate, thirteen call sites).
- **Owned paths touched:** `app/(admin)/` (STEPs 068-078), `app/api/office/` (an office route),
  `migrations/` (append only), `lib/gateways/` (this STEP's module), the two office components the
  navigation owns, and the one string catalog rule 1 requires. Nothing else.

## Database

- **New file:** `0094_seed_payment_providers.sql` and its rollback. It seeds the five section 6
  providers into `public.payment_providers`: NMI (acceptance and sub merchants), Payoneer (payouts),
  Rainforest (acceptance and sub merchants), Stripe Connect (all three) and Airwallex (all three), in
  panel order 1 to 5, disabled, with no test result.
- **Why a seed and not a service:** the five are a fact about this build, so they ship with it. The
  insert is idempotent because `payment_providers_key_key` is a partial unique index and no
  `on conflict` target exists; it selects the rows that are not already there.
- **Rollback:** deletes the five platform rows, and refuses to delete an enabled provider or one that
  holds a key. A rollback undoes a deployment, not an operator's work.
- **No table, column, index, policy or function is added.** `0073` line 209 (`provider_keys` is the
  super administrator's) and `0074` line 87 (the provider catalogue) already cover both tables.
- **Constraints this STEP relies on, unchanged:** `payment_providers_test_check` (an enabled provider
  must have passed a test), `provider_keys_test_check` (an active key must have passed one),
  `provider_keys_active_key` (one active key per provider and mode), `provider_keys_guard_secret`
  (a key keeps its identity) and `set_row_metadata` (the version increment).

## Environment

No new variable. `ENCRYPTION_MASTER_KEY` (already required, 32 bytes base64) is the only key this
STEP reads, and it is read at the moment a secret is sealed or opened, never held.

## Packages

No package was added or changed. `package.json` is integrator owned, so the request is here:

- `"check:gateways": "node lib/gateways/verify.ts"`, appended to the `verify` chain after
  `check:office`. Until then the gate runs with `node lib/gateways/verify.ts`.
- Still open from earlier handoffs: `"check:office"`, `"check:auth"`, `"check:security"`, the
  `minimatch` bump, DOMPurify, the pinned-address dispatcher and the velocity defaults.

## What was built

### The registry (`lib/gateways/registry.ts`)

The five providers with their capability matrix, the panel order, the two modes, the limits the
columns impose (80 character label, 280 character detail, 12 character secret floor because a shorter
ciphertext could not be stored) and two role constants: `GATEWAY_MANAGEMENT_ROLES` and
`OFFICE_DASHBOARD_ROLES`, both `super_admin`. `ADAPTER_CONNECTION_TESTS` is the seam: a provider's
adapter STEP adds one entry and nothing else changes.

### The service (`lib/gateways/service.ts`)

`listGateways` reads the catalogue and every key in two queries, groups them in memory and never
selects a sealed column. `addGatewayKey` seals the secret under a box bound to
`provider_keys:<provider>:<mode>:<fingerprint>`, refuses a duplicate fingerprint, and stores the row
disabled. `testGatewayKey` opens the secret, asks the registry's tester, and writes the verdict across
the key and - when the key is the live credential - the provider. `setGatewayEnabled` asks three
questions on the way on (adapter, passing test, active key) and none on the way off. Every write
filters on the version it read and reads the row back, so a stale screen ends as `CONFLICT`.

### The route (`app/api/office/gateways/route.ts`)

One POST, four actions. CSRF first, then the declared length, then the session, then the device proof
over the exact bytes, then the parse, then the service. The path is on `SENSITIVE_ENDPOINTS` and on
`CSRF_PROTECTED_PATHS`, so the platform's two registries name it and their gates check it.

### The screens

`/gateways` lists the five providers with their capability badges, adapter state, last test and keys
(each showing only its last four characters and the time it changed), one add key form per provider,
a test button per key and the enable or disable switch. `/dashboard` is the super administrator's
home: the gateway counts, the roles held, the freshness of the second factor and the screens those
roles open. Both are inside the STEP 068 shell and use only semantic colour tokens, so both themes
and both widths come from the shell.

## Behaviour Proof (acceptance checklist)

| requirement (section 6) | how it is met | proof |
| --- | --- | --- |
| super_admin only | `GATEWAY_MANAGEMENT_ROLES` checked inside the service, not in the route | the gate refuses `ceo` and `owner` on the read and on every mutation |
| 2FA and fresh reauthentication | `requireFreshReauthentication` in `requireGatewayOperator`, before any read | a stale proof answers `PERMISSION_DENIED` with `reauth_required` on add and on test |
| keys added, tested, enabled and disabled without code change or redeploy | four actions, all row writes | the gate drives all four against an in-memory PostgREST |
| AES-256-GCM, key only in the environment | `lib/auth/secrets.ts` under `ENCRYPTION_MASTER_KEY`, AAD bound to provider, mode and fingerprint | the gate asserts the three stored parts and the exact AAD context |
| the full key is never shown again | the read does not name the ciphertext, the vector, the tag or the fingerprint | the gate asserts that against every query the read issues |
| a provider cannot be enabled when its test fails | `CONFLICT test_required`, and `payment_providers_test_check` behind it | the gate enables only after a passing test and refuses a keyless pass and an untested provider |
| a provider without an adapter cannot be added | the registry is the authority; unknown keys are refused `unknown_provider`, and an enable without a reachable tester is `adapter_missing` | the gate proves nothing can be enabled in this build, because no adapter is installed |
| routing rules decide the provider; an unmatched payment is rejected | not this STEP - the routing rules arrive with the adapters (STEPs 147-169) | - |
| country availability follows the platform switch | not this STEP - the switch is STEP 073 | - |

Runtime smoke test (dev server, port 3100): `/dashboard`, `/gateways` and `/admin` answered `307` to
`/signin` for an anonymous request, and `POST /api/office/gateways` answered `422` with
`{ field: "csrf", rule: "csrf_token_invalid" }`, which is the CSRF guard refusing before anything
else runs.

## Security proof

- **The order of the checks** is CSRF, body bound, session, device proof, parse, service. A refusal
  names a field and a rule and never echoes the value, so a pasted key cannot appear in a response.
- **The proof is a signature over these bytes**: the route reads the body once as text and verifies
  before it parses, and `requireTrustedDevice` refuses a device nobody confirmed.
- **The role and the freshness are in the service**, so a second caller cannot reach a weaker path,
  and the page asks the same role constant the navigation imports.
- **Every mutation is audited**: `gateway.key_added`, `gateway.key_tested`,
  `gateway.provider_enabled`, `gateway.provider_disabled`, each with the officer, the session, the
  platform chain and a payload that never contains the secret (the gate asserts that).
- **A read is not audited**, and deliberately: a super administrator opening their own configuration
  page is not a security event, and every change is. The read is still a permission.
- **Row level security** is `0073` line 209 and `0074` line 87, both unchanged: `provider_keys` is
  writable and readable by `super_admin` alone, and the catalogue is readable by the CEO and finance
  operations as section 6 implies and writable by nobody else.
- **Optimistic locking**: every write filters on `version` and reads the row back, so a second
  operator's save ends as `CONFLICT` instead of being overwritten, and the gate simulates exactly
  that race.
- **No secret reaches a log**: the route logs the action, the provider, the state and the officer;
  the logger's redaction list is unchanged and the payload of the audit entry carries the last four
  characters only.

## Verification

All commands were run at the commit that follows this file, on Node 22 with the dev server stopped.

| command | result |
| --- | --- |
| `npm run check:structure` | passed: 17 directories, 14 root files, 193 source files |
| `npm run check:env` | passed: `.env.example` matches 16 manifest variables |
| `npm run check:config` | passed: 10 sections, 28 values |
| `npm run check:i18n` | passed: 405 messages, 20 placeholders, 1 locale |
| `npm run check:logger` | passed: 117 checks |
| `npm run check:errors` | passed: 202 checks, 15 codes |
| `npm run check:lint` | passed: 77 checks, 26 rules |
| `npm run check:shell` | passed: 271 checks, 66 files scanned |
| `npm run check:jobs` | passed: 110 checks |
| `npm run check:migrations` | passed: 2786 checks, 94 migrations, 75 tables |
| `npm run typecheck` | clean |
| `npm run lint` | clean |
| `npm run build` | exit 0; `/dashboard`, `/gateways` and `/api/office/gateways` are dynamic routes |
| `node lib/auth/verify.ts` | passed: 2395 checks |
| `node lib/security/verify.ts` | passed: 2376 checks |
| `node components/office/verify.ts` | passed: 413 checks, 6 office roles, 5 screens |
| `node lib/gateways/verify.ts` | passed: 467 checks, 5 providers, 2 modes, 0 adapters installed |

## Known limitation, recorded rather than hidden

The error envelope keeps `details` only for `VALIDATION_FAILED` (`lib/errors/respond.ts`), so a
`PERMISSION_DENIED` step-up refusal arrives without its `reauth_required` rule. The gateway console
therefore treats `403` as "prove the second factor again", which is the only `403` a screen this deep
in the office can produce for an account that may see it. `app/office/sessions/office-session-list.tsx`
reads `payload.details`, a field the envelope never carries, so its `reauth_required` branch is dead
code today. Fixing that means changing a platform owned error contract, which is not this STEP's
file, so it is written here as a request to the errors owner: either emit `details` for
`PERMISSION_DENIED` or give the step-up refusal its own code.

## Deployment checks a person runs

1. Apply `0094` and confirm five rows: `select provider_key, status from payment_providers where
   company_id is null order by display_order;` - five, all `disabled`.
2. Sign in as a `super_admin` with a confirmed device, open `/gateways`: the five providers appear,
   and `Enable` on any of them answers "this build has no adapter for this provider", because the
   adapter STEPs (147-169) have not landed yet.
3. Store a sandbox key, then press `Test the connection`: the row records "No adapter is installed
   for this provider, so its connection cannot be tested." and stays disabled.
4. Confirm the stored row holds no plaintext: `select key_last_four, key_fingerprint, status from
   provider_keys;` - four characters, sixty-four hexadecimal digits, `disabled`.

## Next

STEP 070: **CEO dashboard home with approval queues**. It reuses `OFFICE_NAVIGATION` (one entry plus
its `page.tsx` in the same commit), `decideOfficeAccess`, and the audit and step-up helpers this STEP
used; its role constant belongs to the approval service it builds, and the gateway page stays the
super administrator's.
