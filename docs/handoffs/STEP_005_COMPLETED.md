// path: docs/handoffs/STEP_005_COMPLETED.md
# STEP 005 Completed - Handoff

## STEP
- Number and title: STEP 005 - Add central application config file with typed exports
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (structure
  gate and folder ownership), STEP 002 (strict TypeScript, `@/` alias, Node.js 26.13.0 LTS),
  STEP 003 (tokens, which read no configuration), STEP 004 (validated environment contract,
  `serverEnv()` and the boot gate). STEP 004's handoff stated that STEP 005 must build on
  `serverEnv()` instead of reading `process.env` again.
- Re-divided into five sub-steps before implementation. Analysis and definitions:
  docs/planning/STEP_005_SUBSTEP_BREAKDOWN.md. All five completed in this session:
  005.1 config boundary audit and value inventory, 005.2 pure typed configuration with
  invariants, 005.3 server derived configuration, 005.4 config gate and consumption proof,
  005.5 verification, handoff and commit.

## Files
- Created:
  - config/app.ts - `AppConfig`, the frozen `appConfig`, and `assertAppConfigInvariants()`.
  - config/server.ts - `ServerConfig`, `getServerConfig()` and the narrowed
    `StorageProvider` and `LogLevel` types.
  - config/verify.ts - the configuration gate executed by Node.js 26.
  - lib/utils/freeze.ts - `deepFreeze`, used by both configuration modules.
  - docs/planning/STEP_005_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_005_COMPLETED.md.
- Modified:
  - config/README.md - rewritten for the new modules and rules.
  - README.md - new "Application configuration" section.
  - package.json - `check:config` script added; `verify` now runs the config gate after the
    environment gate.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `config/`
  and the foundation `lib/` area (one utility module). `config/README.md` and
  `config/structure.json` were created by STEP 001 as folder documentation and as the folder
  map; the README was rewritten here because its content is this STEP's subject, and
  structure.json was not changed. Not touched: the environment contract (STEP 004), the root
  layout shell (STEP 010), the logger (STEP 007), the error format (STEP 008), the lint rule
  matrix (STEP 009), the job foundation (STEP 011), storage and upload limits (STEP 100-105),
  rate limits (STEP 056-067), plans and billing logic (STEP 212-220) and every migration
  (STEP 012+).

## Database
- Migrations added (file names): none. The settings that super_admin edits at runtime are
  database rows owned by later STEPs; this STEP holds code level defaults and hard limits.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. This STEP consumes the existing
  contract through `serverEnv()` and adds no variable, so `.env.example` is unchanged and the
  environment gate still reports 16 variables.
- Secrets handled (names only, never values): none reachable from `config/`. The three secret
  shaped values that matter to this STEP (database URL, service role key, encryption key) stay
  in `lib/env/server.ts`; `config/server.ts` exposes only the safe subset, and `config/verify.ts`
  fails on any key whose name looks like a credential.

## Packages
- Package requests for the integrator (name, reason), or none: none. `zod` 4.6.7 was already
  added by STEP 004 and is reused for the narrowed types. No other dependency was needed; the
  gate runs on Node.js 26 native TypeScript.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.
  1. Typed exports exist and are internally consistent: `npm run check:config` prints
     `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential
     shaped key`.
  2. Impossible configuration fails closed. Setting `lists.defaultPageSize` to 500 makes the
     module throw at import with
     `Invalid application configuration (1 problem(s)): lists.defaultPageSize (500) must not
     exceed lists.maximumPageSize (100)`, and the gate exits 1.
  3. Money cannot become a JavaScript number. Replacing `"100.0000"` with `100` is rejected
     twice: the compiler reports `error TS2322: Type 'number' is not assignable to type
     'string'` and the runtime invariant reports the same value as invalid. Both layers were
     observed before the file was restored.
  4. A credential shaped key is refused. Adding `paymentApiKey` to the configuration makes the
     gate exit 1 with
     `configuration must not expose a credential shaped key: paymentApiKey. Secrets belong in
     lib/env/server.ts.`
  5. Server configuration follows the environment. Two production starts were exercised on the
     production build. Defaults: `environment=production`, `storage=supabase`, `log-level=info`,
     `monitoring=false`, `app-url=https://app.example.test`. With
     `STORAGE_PROVIDER=s3`, `LOG_LEVEL=warn` and a `SENTRY_DSN` present:
     `storage=s3`, `log-level=warn`, `monitoring=true`. Neither run printed a secret.
  6. Application configuration reaches the browser without the server one. A client component
     rendered `appConfig.money.minimumPayoutAmount` as `100.0000`,
     `appConfig.lists.maximumPageSize` as `100` and
     `appConfig.security.loginLock.lockDurationMinutes` as `120`. The client chunk carrying
     those values was 3,870 bytes raw and contained 0 occurrences of
     `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_MASTER_KEY`, `storageProvider`, `isProduction`
     or `config/server`. The probe files were removed before the commit.
  7. A production build still needs no runtime secrets: `npm run build` with no environment
     exits 0. This is what forced the one design correction of this STEP, recorded below.
- One design correction was found and fixed during the session, and it changes how later
  STEPs must call this module:
  - The first implementation exported `serverConfig` as a module level constant. During
    `next build`, Next collects page data by importing route modules, so the constant
    executed and the build failed with
    `Failed to collect configuration for /config-probe: Environment validation failed (server
    environment: production): 7 problem(s)`. That would have made every build machine carry
    runtime secrets, contradicting STEP 004. Fixed by exporting `getServerConfig()`, which
    builds once and memoises on first use inside a request, a server component body or a job.
    Re-verified: build with no environment exits 0, and the same build serves the correct
    values when started with a complete environment.
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: this STEP ships no
  interface; the probes used for proof were removed. The browser based visual checks for the
  page remain pending and owned by STEP 010, as recorded in STEP 003.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: no
  route was added or changed. `/` and `/api/health` behaved as before (200), unknown path 404.
  The four API cases still begin at STEP 011, the first STEP with a validated handler.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money. It fixes the money scale and the minimum amounts that the ledger and
  the invoice flows will read later.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider
  is called.

## Configuration inventory (value, source, type)
| Value | Source | Type |
| --- | --- | --- |
| platform.name, platform.serviceSlug, platform.releaseStage | lib/constants/platform.ts (STEP 002) | string |
| platform.defaultLocale | FEATURE_LIST section 1 (English only) | "en" |
| money.currencyCode, money.precision, money.scale | FEATURE_LIST section 1 (USD, numeric(18,4)) | "USD", 18, 4 |
| money.minimumPartialPayment | FEATURE_LIST section 16 (20 USD) | string "20.0000" |
| money.minimumPayoutAmount | FEATURE_LIST section 10 (100 USD) | string "100.0000" |
| lists.defaultPageSize (25), lists.maximumPageSize (100) | FEATURE_LIST section 28 (pagination, maximum page size in config) | number |
| lists.importBatchSize (500) | Platform default for FEATURE_LIST section 15 CSV import reporting | number |
| security.loginLock.consecutiveFailureLimit (2), lockDurationMinutes (120) | FEATURE_LIST section 22 | number |
| payouts.bankChangeCoolingPeriodHours | FEATURE_LIST section 10 (96 hours) | number |
| payouts.defaultSettlementHoldDays (2) | Platform default until super_admin sets hold days | number |
| reconciliation.mismatchResolutionDays | FEATURE_LIST section 11 (3 days) | number |
| disputes.responseWindowHours (24), extendedResponseWindowHours (48) | FEATURE_LIST section 19 | number |
| billing.subscriptionWarningDays | FEATURE_LIST section 12 (7 days) | number |
| caching.publicPageRevalidateSeconds (300), dashboardSummarySeconds (30) | FEATURE_LIST section 28; platform defaults | number |
| server: environment, isProduction, isDevelopment, isTest, appUrl | serverEnv() (STEP 004) | string, boolean |
| server: storageProvider, logLevel, monitoringEnabled | serverEnv(), narrowed; monitoring from the presence of SENTRY_DSN | union, boolean |

## Verification
- Typecheck result: pass. `npm run typecheck` exits 0 with the strict matrix.
- Lint result: pass. `npm run lint` exits 0.
- Build result for the touched area: pass. `npm run build` on Node.js 26.13.0 emits the route
  table `○ /`, `○ /_not-found`, `ƒ /api/health`.
- `npm run verify` now runs four gates and exits 0:
  `structure gate passed: 16 directories, 13 root files, 30 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential
  shaped key`, then typecheck, lint and build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. tsconfig.json was not rewritten.

## Next
- Next STEP number: STEP 006 - Add English string catalog structure lib/i18n/strings/en.ts.
  Not started. This chat ends here as the owner asked, and STEP 006 needs the owner's consent.
- Anything the next chat must know:
  1. Import configuration by side: `@/config/app` anywhere, `@/config/server` on the server
     only. There is no barrel, deliberately.
  2. Call `getServerConfig()` inside a request handler, a server component body or a job. Never
     at module scope: Next imports route modules during `next build`, so a module level call
     would demand runtime secrets on the build machine (this exact failure happened and is
     recorded above).
  3. Never add a secret to `config/`. `config/verify.ts` rejects credential shaped key names,
     and secrets belong in `lib/env/server.ts` at their point of use.
  4. Money stays a string with 4 decimals. Use the decimal library for arithmetic; a
     JavaScript number for money is a defect even if the invariant would catch the obvious
     case.
  5. Values that super_admin edits at runtime (platform fee, hold days, reserve terms, plan
     prices) are database settings owned by their STEPs. `appConfig` holds defaults and hard
     limits only, and a runtime setting overrides it.
  6. STEP 006 moves the English copy that still sits in `app/layout.tsx` and `app/page.tsx`
     into `lib/i18n/strings/en.ts`. Configuration is not a home for user facing text: only
     `platform.name` is displayed, and it is a brand name, not translatable copy.
  7. Adding a configuration value means adding an invariant for it when a relationship exists
     (bounds, ordering, format), then running `npm run check:config`. A value without a rule is
     a value nobody will notice going wrong.
  8. `lib/utils/freeze.ts` is the shared deep freeze helper. Reuse it instead of writing a
     second one; `Object.freeze` alone is shallow and is not enough for configuration.
  9. Still open for their owners: string catalog (006), logger (007), error format (008), lint
     matrix (009), root layout shell and providers (010), job foundation (011), migrations
     (012+).
