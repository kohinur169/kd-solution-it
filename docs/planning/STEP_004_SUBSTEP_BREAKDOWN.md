// path: docs/planning/STEP_004_SUBSTEP_BREAKDOWN.md
# STEP 004 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 004, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS
as the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 004 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 004 - Add environment variable schema with boot-time validation.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_003_COMPLETED.md. It records that the token
  layer and the Tailwind pipeline read no environment, and that no `.env.example` exists
  yet because STEP 004 owns it.

### Feature list sections that apply
- Section 29 Production Environments and Secrets: ".env.example lists every required
  environment variable by name with a short description and no real values. The application
  refuses to start when a required variable is missing." Also: three separated environments,
  every secret only in the hosting platform's environment variables, provider and email
  secrets encrypted at rest.
- Section 30 External Services Setup: the variables a live platform needs (Supabase project,
  object storage adapters, Turnstile, Sentry, payment providers, TaxCloud, KYC providers).
- Section 33 Release and Go-Live Gates: production environment variables verified before
  go-live.
- MASTER_PROMPT rules: "Every STEP that adds an environment variable must add it to
  .env.example with a description and must read it through the validated environment schema
  only", "No secret, key, token or credential may appear in code, commits, logs, error
  messages or handoff files", Zod validation on the server, structured logging only.

### File ownership check (STEP_PLAN_250.md, File Ownership Rules)
- Owned here: root configuration and lib/ foundation files, so `.env.example`,
  `instrumentation.ts`, `lib/env/`, the environment related npm scripts and the compiler
  option that the environment tooling needs.
- Not owned here, therefore untouched:
  - Central typed application config exports: STEP 005. This STEP produces only the raw,
    validated environment values; it builds no application configuration object.
  - Root layout shell and providers: STEP 010.
  - Structured logger: STEP 007. The boot failure message is written to standard error
    directly and STEP 007 replaces that path with the logger.
  - Supabase client, database access, provider adapters, email, storage adapters: their own
    STEPs. Only the variable names they will consume are declared here.
  - Lint rule matrix: STEP 009.
  - Every migration: STEP 012 and later.

### What exists today (measured)
- No environment schema, no `.env.example`, no `instrumentation.ts`, no zod dependency, and
  no code reads `process.env` anywhere except the Next.js build time values that the
  framework sets itself.
- The previous STEPs therefore cannot leak a secret through this layer: there was no layer.

## 2. Design Decisions Taken Before Coding
1. One contract file, `lib/env/manifest.ts`, is the single source of truth: name, scope,
   format, requirement, default, secret flag, description and a safe placeholder for every
   variable. The zod schema, the typed accessors and `.env.example` are all derived from it,
   so the example file cannot drift from the validator.
2. `.env.example` is generated, never hand written: `npm run env:example` writes it and
   `npm run check:env` fails when the committed file differs from what the manifest
   produces. The check runs inside `npm run verify`.
3. Boot-time validation happens in `instrumentation.ts`, the Next.js server start hook, and
   it is skipped during the production build phase so a build machine never needs runtime
   secrets. Missing or invalid values abort the start with a message that names variables
   and rules only, never values.
4. Validation fails closed and fails early: `serverEnv()` validates once per process,
   memoises the result and throws on every later access if it failed.
5. Client exposure is explicit. Only variables whose scope is `client` may be named
   `NEXT_PUBLIC_*`, only those are read through a static literal map, and the map is checked
   against the manifest at import time so a variable can never be "added" by accident.
6. Node.js 26 can execute TypeScript directly, so the generator script is TypeScript as
   well. One language, one type contract, no duplicated JavaScript copy of the manifest.
7. Conditional secrets are declarative: the four Amazon S3 variables are required exactly
   when `STORAGE_PROVIDER` is `s3`, expressed in the manifest rather than in an if-statement
   somewhere in application code.

## 3. Why Five Sub-Steps

| Sub-step | Name | Proves |
| --- | --- | --- |
| 004.1 | Variable inventory and scope audit | Every variable has a reason, a scope and a rule |
| 004.2 | Canonical manifest and meta validation | The contract file is itself validated before use |
| 004.3 | Typed validation layer | Server and client values are typed, parsed once, fail closed |
| 004.4 | Generated example file, parity check and boot wiring | The document and the validator cannot drift, start aborts on bad env |
| 004.5 | Verification, handoff and commit | Every failure mode exercised, results recorded |

## 4. Sub-Step Detail

### Sub-step 004.1 - Variable inventory and scope audit
Deliverables:
- The inventory of the 16 variables this STEP introduces: 8 always required, 2 with safe
  defaults, 1 optional monitoring value, 4 conditional storage values, 1 client value.
- For each one: scope (server or client), format, requirement, secret flag and the feature
  list line that justifies it.
Proof: the inventory table is reproduced in the handoff.
Exit criteria: no variable without a justification, no secret shaped value in an example.

### Sub-step 004.2 - Canonical manifest and meta validation
Deliverables:
- `lib/env/manifest.ts`: `ENVIRONMENTS`, the variable definitions as a `const` array and the
  derived types.
- A zod meta schema in `lib/env/schema.ts` that validates the manifest itself: unique names,
  client scope only on `NEXT_PUBLIC_*`, server scope never on it, enum needs values, key
  formats need a byte count, descriptions long enough to be useful.
Proof: a deliberately broken manifest item is rejected by the meta schema in this session.
Exit criteria: the manifest is data that is validated, not data that is trusted.

### Sub-step 004.3 - Typed validation layer
Deliverables:
- `lib/env/schema.ts`: per format zod value schemas, requirement resolution per environment,
  conditional requirement evaluation, and `EnvironmentValidationError` that carries variable
  names and rules only.
- `lib/env/server.ts`: `serverEnv()` (validated once, memoised, typed, conditional values
  typed as possibly absent) and `assertServerEnvironmentReady()`.
- `lib/env/client.ts`: the static literal map of public variables, parity checked against the
  manifest at import time.
Proof: typecheck passes with the derived types and no `any`.
Exit criteria: a caller cannot reach an unvalidated value.

### Sub-step 004.4 - Generated example file, parity check and boot wiring
Deliverables:
- `lib/env/generate-example.ts`, executed directly by Node.js 26: writes or checks
  `.env.example` from the manifest.
- `.env.example` committed, no real values, grouped by requirement with a description per
  variable.
- `instrumentation.ts`: boot validation, skipped during the build phase, nodejs runtime
  only.
- npm scripts `env:example` and `check:env`, with `check:env` wired into `verify`.
- `config/structure.json` gains `.env.example` and `instrumentation.ts` as root files.
Proof: editing `.env.example` by hand makes `check:env` fail; regenerating makes it pass.
Exit criteria: the documented example and the running validator are the same thing.

### Sub-step 004.5 - Verification, handoff and commit
Deliverables:
- Seven failure and success scenarios exercised on Node.js 26.13.0:
  1. boot without an environment file fails and names the missing variables;
  2. boot with an invalid value fails with the format rule, not the value;
  3. boot with `STORAGE_PROVIDER=s3` and no S3 values fails with the conditional rule;
  4. boot with a complete valid environment succeeds and serves the page;
  5. production build succeeds without runtime secrets;
  6. `check:env` fails on a hand edited example and passes after regeneration;
  7. no secret value appears in any error message or in the committed tree.
- `docs/handoffs/STEP_004_COMPLETED.md`, one commit, push.
