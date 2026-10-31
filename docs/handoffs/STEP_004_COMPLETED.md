// path: docs/handoffs/STEP_004_COMPLETED.md
# STEP 004 Completed - Handoff

## STEP
- Number and title: STEP 004 - Add environment variable schema with boot-time validation
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (structure
  gate, folder ownership), STEP 002 (strict TypeScript, `@/` alias, Node.js 26.13.0 LTS
  runtime, exact pinned dependencies), STEP 003 (token layer, which deliberately reads no
  environment). STEP 003's handoff recorded that no `.env.example` existed yet because this
  STEP owns it.
- Re-divided into five sub-steps before implementation. Analysis and definitions:
  docs/planning/STEP_004_SUBSTEP_BREAKDOWN.md. All five completed in this session:
  004.1 variable inventory and scope audit, 004.2 canonical manifest and meta validation,
  004.3 typed validation layer, 004.4 generated example file, parity check and boot wiring,
  004.5 verification, handoff and commit.

## Files
- Created:
  - lib/env/manifest.ts - the single source of truth for all 16 variables.
  - lib/env/schema.ts - meta validation of the manifest, the zod value schemas, per scope
    parsers and `EnvironmentValidationError`.
  - lib/env/server.ts - `serverEnv()` and `assertServerEnvironmentReady()`.
  - lib/env/client.ts - the static literal map of public variables, types only.
  - lib/env/boot.ts - the node only boot gate that both validates and ends the process.
  - lib/env/generate-example.ts - writes or checks `.env.example`, executed directly by
    Node.js 26.
  - lib/env/README.md - ownership, rules and commands.
  - instrumentation.ts - the Next.js server start hook.
  - .env.example - generated, 16 variables, placeholders only.
  - docs/planning/STEP_004_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_004_COMPLETED.md.
- Modified:
  - package.json, package-lock.json - `zod` 4.6.7 added as a runtime dependency; scripts
    `env:example` and `check:env` added; `verify` now runs `check:env` after
    `check:structure`; `"type": "module"` added so Node executes the TypeScript tooling
    without a module type warning.
  - tsconfig.json - `allowImportingTsExtensions` enabled for the Node executed tooling;
    everything else unchanged.
  - config/structure.json - `.env.example` and `instrumentation.ts` registered as root files.
  - README.md - new "Environment configuration" section.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): root
  configuration (`instrumentation.ts`, `.env.example`, package scripts, compiler option) and
  lib/ foundation files (`lib/env/`). Not touched: typed application config (STEP 005), the
  root layout shell (STEP 010), the structured logger (STEP 007, the boot failure line is
  written to standard error directly and is meant to be replaced by the logger), any Supabase
  or storage client, any provider adapter, the lint rule matrix (STEP 009) and every
  migration (STEP 012+).

## Database
- Migrations added (file names): none. STEP 004 is a configuration STEP, so it adds no migration
  and no table; the first migration arrives with STEP 012.
- Rollback verified on clean database (yes/no, how): not applicable, because nothing was applied.

## Environment
- Environment variables added to .env.example: 16, all generated from the manifest.
  | Variable | Scope | Requirement | Secret | Why it exists |
  | --- | --- | --- | --- | --- |
  | NODE_ENV | server | always (default development) | no | Runtime mode, and the value that decides which requirements apply |
  | APP_URL | server | always | no | Absolute links in email, payment pages and tokenized client links |
  | DATABASE_URL | server | always | yes | PostgreSQL connection string used by migrations and server queries |
  | SUPABASE_URL | server | always | no | Supabase project URL of this environment |
  | SUPABASE_ANON_KEY | server | always | no | Anonymous key, server read only |
  | SUPABASE_SERVICE_ROLE_KEY | server | always | yes | Service role key, server only, bypasses RLS |
  | ENCRYPTION_MASTER_KEY | server | always | yes | AES-256-GCM key for provider keys, email secrets and files |
  | AUDIT_SIGNING_KEY | server | always | yes | Ed25519 seed for the hash-chained audit log |
  | STORAGE_PROVIDER | server | optional (default supabase) | no | Selects the storage adapter |
  | S3_BUCKET | server | conditional on STORAGE_PROVIDER=s3 | no | Bucket for encrypted files |
  | S3_REGION | server | conditional | no | Bucket region |
  | S3_ACCESS_KEY_ID | server | conditional | yes | S3 writer identity |
  | S3_SECRET_ACCESS_KEY | server | conditional | yes | S3 writer secret |
  | SENTRY_DSN | server | optional | no | Error monitoring, off while empty |
  | LOG_LEVEL | server | optional (default info) | no | Minimum severity for the structured logger |
  | NEXT_PUBLIC_TURNSTILE_SITE_KEY | client | production | no | Turnstile widget site key, public by design |
- Secrets handled (names only, never values): ENCRYPTION_MASTER_KEY, AUDIT_SIGNING_KEY,
  SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY. No value
  appears in the repository, in this handoff, in a build artifact or in an error message; the
  only values used in this session were generated test placeholders passed inline to a
  process and never written to a committed file.

## Packages
- Package requests for the integrator (name, reason), or none:
  - zod 4.6.7 - runtime dependency. MASTER_PROMPT requires Zod validation on every input;
    the environment contract is the first input of the process.
  - No other package was added. The manifest, the generator and the check are plain
    TypeScript executed by Node.js 26, so no runner, no ts-node and no build tool were needed.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0 with `next start`
  against the production build. Each case below is an observed result, not an intention.
  1. No environment at all: the process exits 1, nothing listens on the port, and the boot
     line names the seven missing required variables
     (`APP_URL is required in production; DATABASE_URL is required in production; ... ;
     AUDIT_SIGNING_KEY is required in production`).
  2. Malformed values: exit 1 with exactly one accurate rule per variable and no duplicate
     "is required" noise - `APP_URL must be an absolute http or https URL`,
     `DATABASE_URL must be a PostgreSQL connection string`,
     `ENCRYPTION_MASTER_KEY must be base64 that decodes to exactly 32 bytes`,
     `SUPABASE_ANON_KEY must be at least 32 characters long`.
  3. Conditional secrets: `STORAGE_PROVIDER=s3` without the four S3 values exits 1 with
     `S3_ACCESS_KEY_ID`, `S3_BUCKET`, `S3_REGION` and `S3_SECRET_ACCESS_KEY` each reported as
     required. The same environment with all four present starts and serves 200.
  4. Unsupported environment: `NODE_ENV=staging` is rejected with
     `NODE_ENV must be one of development, test, production`, so a typo cannot silently fall
     back to development behaviour.
  5. Value confidentiality: the failing values (`not-a-url`, `mysql://...`, `not-base64`,
     `short`) appear 0 times in the boot output. Validation errors carry names and rules only.
  6. Public variable timing: a build made without `NEXT_PUBLIC_TURNSTILE_SITE_KEY` can never
     start in production, and the message says why:
     `NEXT_PUBLIC_TURNSTILE_SITE_KEY is required in production and must be present when the
     application is built`.
  7. Happy path with a complete environment: `GET /` 200, `GET /api/health` 200, unknown path
     404, and a probe page proved the accessors end to end -
     `serverEnv().APP_URL` rendered `https://app.example.test` and
     `serverEnv().STORAGE_PROVIDER` rendered the default `supabase` (the variable was not set
     at all), while `clientEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY` rendered the inlined build
     value. The probe files were removed before the commit.
  8. Example file parity: appending a hand written variable to `.env.example` makes
     `npm run check:env` exit 1 with
     "check:env failed: .env.example differs from lib/env/manifest.ts. Run `npm run
     env:example`"; regenerating restores the file byte for byte and the check exits 0.
  9. Production build does not need runtime secrets: `npm run build` with no environment
     variables present exits 0 and emits the route table `○ /`, `○ /_not-found`,
     `ƒ /api/health`.
  10. Client bundle hygiene: after the fix described below, the client chunk that carries the
      inlined public value is 438 bytes raw / 337 bytes gzipped and contains 0 occurrences of
      `SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_MASTER_KEY`, `AUDIT_SIGNING_KEY`, `zod` or any
      zod message.
- Two defects were found and fixed in this session, both recorded because they are the kind
  that would otherwise reach production:
  1. A failing boot gate left a half prepared server listening. The first implementation threw
     from `instrumentation.ts`; Next.js logged the error and kept serving, answering 500 to
     every page and 200 to `/api/health`, which would keep the instance inside a load
     balancer's healthy pool. Fixed by ending the process with exit code 1 from
     `lib/env/boot.ts`; re-verified: exit 1 and 0 listeners on the port.
  2. The first `lib/env/client.ts` imported the shared schema, which pulled zod and the whole
     manifest - including the names of the secret variables - into a client bundle (the
     affected chunk was 115,101 bytes raw). Fixed by making the client module dependency
     free: types only, a static literal map guarded by a `satisfies` completeness check, and
     validation of public values moved to the server boot gate. Chunk size and content
     verified as measure 10 above.
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: this STEP ships no
  interface. The only visible surface touched is a boot failure line on standard error. The
  browser based visual checks for the page remain pending and owned by STEP 010, as recorded
  in STEP 003.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: `/`
  200, `/api/health` 200 and unknown path 404 were exercised with a complete environment.
  Validation failure of an API input, unauthorized access and cross-tenant access still do
  not apply: no route in the tree accepts input, a credential or a tenant scope. They become
  mandatory at STEP 011, the first STEP with a validated handler.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider
  is called.

## Verification
- Typecheck result: pass. `npm run typecheck` exits 0 with the STEP 002 strict matrix,
  including `noPropertyAccessFromIndexSignature`, which forced bracket access on
  `process.env` in three files.
- Lint result: pass. `npm run lint` exits 0.
- Build result for the touched area: pass. `npm run build` on Node.js 26.13.0 compiles, runs
  TypeScript, generates the three routes above. `npm run verify` (structure gate, `check:env`,
  typecheck, lint, build) exits 0.
- Structure gate: `structure gate passed: 16 directories, 13 root files, 26 source files
  checked`.
- Environment gate: `check:env passed: .env.example matches 16 manifest variables`.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict install. tsconfig.json was not rewritten
  by the build.

## Next
- Next STEP number: STEP 005 - Add central application config file with typed exports.
  Not started. This chat ends here as the owner asked, and STEP 005 needs the owner's
  permission.
- Anything the next chat must know:
  1. Read environment values through `serverEnv()` or `clientEnv` only. `process.env` is
     allowed in exactly two places: the parsers in `lib/env/schema.ts` (to resolve NODE_ENV)
     and `lib/env/client.ts` (the inlined public literal map).
  2. STEP 005 sits on top of this contract. Application configuration should be built from
     `serverEnv()` values, typed, frozen at module load, and must not re-validate or re-read
     the environment itself.
  3. Adding a variable is a three step change: add it to `lib/env/manifest.ts`, run
     `npm run env:example`, commit both. `npm run verify` fails when the two disagree.
  4. A public variable must be added in the manifest with `scope: "client"`, named
     `NEXT_PUBLIC_*`, and read in `lib/env/client.ts`. Missing that literal read is a
     compile time error; the module must stay free of imports other than types.
  5. `serverEnv()` used inside a page or route that Next renders at build time would demand
     the environment on the build machine. Mark such a route `export const dynamic =
     "force-dynamic"` or read the value inside a request handler, as the probe in this
     session demonstrated.
  6. The boot gate exits the process. In any environment that cannot tolerate an exit during
     start-up, the environment must be complete before the platform is deployed; there is no
     partial mode by design.
  7. The boot failure line is `level=fatal event=boot.environment_rejected` written directly
     to standard error. STEP 007 replaces that path with the structured logger; until then it
     must not gain fields that could carry values.
  8. `instrumentation.ts` must stay Edge-safe: no Node APIs in that file. Node only work
     lives in `lib/env/boot.ts`, imported dynamically inside the `NEXT_RUNTIME === "nodejs"`
     branch, because Next compiles the hook for both runtimes and rejects Node APIs in the
     Edge build.
  9. package.json is now `"type": "module"`. Config files are already `.mjs`, and the
     TypeScript tooling runs through Node 26 native type stripping.
  10. Not touched by this STEP and still open for their owners: typed central config (005),
      string catalog (006), logger (007), error format (008), lint matrix (009), root layout
      shell and providers (010), job foundation (011), migrations (012+).
