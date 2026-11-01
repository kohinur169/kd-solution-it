// path: docs/planning/STEP_005_SUBSTEP_BREAKDOWN.md
# STEP 005 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 005, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS
as the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 005 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 005 - Add central application config file with typed exports.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_004_COMPLETED.md. It records that the validated
  environment contract exists, that `serverEnv()` and `clientEnv` are the only sanctioned way
  to read it, and that STEP 005 must build application configuration on top of those values
  instead of reading `process.env` again.

### Feature list sections that apply
- Section 1 Platform Foundations: USD only, money stored as numeric(18,4) and calculated only
  with a decimal library, English only.
- Section 10 Platform Fee, Settlement, Reserve and Payout: minimum payout 100 USD, 96 hour
  cooling period after a manually verified bank change.
- Section 11 Double-Entry Ledger and Reconciliation: a mismatch is resolved within 3 days.
- Section 12 Subscription Billing: warnings start 7 days before the due date.
- Section 16 Invoices: partial payments are accepted with a minimum of 20 USD.
- Section 19 Refunds and Disputes: the response deadline is 24 hours, extended to 48 hours by
  super_admin.
- Section 22 Authentication and Session Security: 2 consecutive failures lock the account for
  2 hours.
- Section 28 Performance and Low Load Rules: "Maximum page size for list APIs is set in
  config".
- Section 33 Release and Go-Live Gates: typecheck, lint and build must pass.

### File ownership check (STEP_PLAN_250.md, File Ownership Rules)
- Owned here: `config/` and the config related root configuration (npm script, verify chain,
  documentation of the folder).
- Not owned here, therefore untouched:
  - The environment contract itself: STEP 004. This STEP consumes `serverEnv()`, it does not
    re-validate or re-read `process.env`.
  - Root layout shell and providers: STEP 010.
  - Structured logger: STEP 007 (config exposes the configured level, the logger consumes it).
  - Error format: STEP 008.
  - Lint rule matrix: STEP 009.
  - Background job foundation: STEP 011 (job retry and concurrency values are that STEP's).
  - Storage adapter limits, uploaded file limits: STEP 100-105.
  - Rate limits and IP velocity defaults: STEP 056-067.
  - Plan, entitlement and subscription logic: STEP 212-220 (this STEP only holds the 7 day
    warning constant that the feature list fixes).
  - Every migration: STEP 012 and later. Business settings that super_admin edits at runtime
    are database rows in those STEPs; this file holds code level defaults and hard limits.

### What exists today (measured)
- `config/` contains only `structure.json` (the folder map from STEP 001) and `README.md`.
- There is no typed application configuration, so constants would otherwise be scattered: the
  only shared constants module is `lib/constants/platform.ts` (service slug and release
  stage).
- No code reads a business constant today, so nothing can regress by moving it now.

## 2. Design Decisions Taken Before Coding
1. Two modules, not one barrel. `config/app.ts` holds pure constants and imports nothing from
   the environment, so it is safe in a client bundle. `config/server.ts` derives values from
   `serverEnv()` and is server only. A barrel that re-exported both would make it possible to
   pull the environment into a client component by accident, so there is no barrel: every
   import names its side of the boundary.
2. Configuration never re-validates the environment. Every value in `config/server.ts` comes
   from `serverEnv()`, which STEP 004 already validated at boot.
3. No secret may reach the configuration object. `config/server.ts` exposes only a safe
   derived subset: environment name, environment flags, application URL, storage provider
   name, log level and whether monitoring is on. Keys, tokens, passwords and connection
   strings stay in `serverEnv()` at their point of use.
4. Money is never a JavaScript number in configuration. Amounts are strings with the exact
   numeric(18,4) scale, so a later STEP must parse them with the decimal library and can never
   inherit a floating point value.
5. The configuration is validated twice, at two different moments:
   - at module load, a pure invariant check runs so an impossible combination fails
     immediately and on every import;
   - as a gate, `npm run check:config` re-runs that check and additionally refuses any key
     whose name looks like a credential, which keeps the "no secret in config" rule from
     rotting as the file grows. It runs inside `npm run verify`.
6. Every value carries the feature list line that justifies it, so a later reviewer can tell a
   policy number from an invented one. Values the feature list does not fix are marked as
   platform defaults that a database setting overrides.

## 3. Why Five Sub-Steps

| Sub-step | Name | Proves |
| --- | --- | --- |
| 005.1 | Config boundary audit and value inventory | Every value has a source: feature list, environment or decision |
| 005.2 | Pure typed configuration with invariants | Constants are typed, frozen and internally consistent |
| 005.3 | Server derived configuration | Environment reaches config through `serverEnv()` only, no secret |
| 005.4 | Config gate and consumption proof | Invariants and the no-secret rule fail closed, both sides consume correctly |
| 005.5 | Verification, handoff and commit | Gates pass on Node 26, results recorded |

## 4. Sub-Step Detail

### Sub-step 005.1 - Config boundary audit and value inventory
Deliverables:
- The inventory table: value, where it comes from (feature list section, environment, or a
  documented platform default), and its type.
- The boundary decision: what belongs in `config/app.ts`, what belongs in `config/server.ts`,
  what stays in the environment, and what belongs to a later STEP's database settings.
Proof: the table is reproduced in the handoff.
Exit criteria: no value without a justification and no duplicated source of truth.

### Sub-step 005.2 - Pure typed configuration with invariants
Deliverables:
- `config/app.ts`: `AppConfig` interface, the frozen `appConfig` object, deep freeze, and
  `assertAppConfigInvariants()` covering pagination bounds, money scale, amount formats,
  login lock bounds, cooling period bounds, reconciliation bounds, dispute window ordering,
  billing warning and cache lifetimes.
Proof: a deliberately broken value makes the invariant throw at import time.
Exit criteria: the object is immutable and its invariants are impossible to bypass.

### Sub-step 005.3 - Server derived configuration
Deliverables:
- `config/server.ts`: `ServerConfig` and `getServerConfig()`, a lazily built and memoised
  value derived from `serverEnv()`, with narrowed types for the storage provider and the log
  level, environment flags, the public application URL and a monitoring flag. Lazy on
  purpose: a module level read would execute during `next build` and make a build machine
  need the runtime secrets again, which STEP 004 had just removed.
- A server-only guard so an accidental client import fails loudly instead of shipping an
  empty object.
Proof: typecheck enforces the narrowed types and no `any` appears.
Exit criteria: no secret crosses the boundary and `process.env` is not read here.

### Sub-step 005.4 - Config gate and consumption proof
Deliverables:
- `config/verify.ts`, executed directly by Node.js 26: re-runs the invariants, refuses
  credential shaped key names, and prints a summary. Wired as `npm run check:config` and into
  `npm run verify`.
- Consumption proof on both sides of the boundary with temporary probe files, removed before
  the commit: a server route reads `appConfig` and `serverConfig`, a client component reads
  `appConfig` only, and the client chunk is checked for secrets and for environment names.
- Documentation: `config/README.md` and the root README section.
Proof: the gate fails on an impossible value and on a credential shaped key; both consumers
render the expected values.
Exit criteria: one documented way to read configuration and two gates that defend it.

### Sub-step 005.5 - Verification, handoff and commit
Deliverables:
- `npm run verify` green on Node.js 26.13.0: structure gate, env gate, config gate,
  typecheck, lint, build.
- `docs/handoffs/STEP_005_COMPLETED.md` filled completely.
- One commit: "STEP 005: Add central application config file with typed exports", pushed to
  the session branch with the handoff in the same commit.
