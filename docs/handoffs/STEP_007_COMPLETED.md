// path: docs/handoffs/STEP_007_COMPLETED.md
# STEP 007 Completed - Handoff

## STEP
- Number and title: STEP 007 - Add structured logger with request context and redaction
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 001 (structure gate,
  which lists `console.log` as a forbidden marker and therefore shaped this module's sinks),
  STEP 002 (strict TypeScript, `@/` alias, Node.js 26.13.0 LTS), STEP 004 (the `LOG_LEVEL`
  environment variable and its four values, validated at boot), STEP 005 (`getServerConfig()`,
  which exposes the validated `logLevel`) and STEP 006 (copy lives in the string catalog, so a
  log message is a technical identifier, not user facing text).
- Re-divided into five sub-steps before implementation; the analysis, the inventory and the
  ten design decisions are in docs/planning/STEP_007_SUBSTEP_BREAKDOWN.md. All five completed in
  this session: 007.1 contract and inventory, 007.2 record model and safe serialization,
  007.3 redaction, 007.4 logger core and request context, 007.5 gate, wiring, documentation and
  proof.

## Files
- Created:
  - lib/logger/levels.ts - the four levels, their severity, `parseLogLevel`, `resolveLogLevel`
    with an `info` fallback when configuration cannot be read.
  - lib/logger/serialize.ts - `serializeValue`, bounded JSON safe normalization.
  - lib/logger/redact.ts - field name and value pattern redaction, `REDACTED_MARKER`.
  - lib/logger/context.ts - `AsyncLocalStorage` request context, `runWithRequestContext`,
    `currentRequestContext`, `createRequestId`, `resolveRequestId`, `isSafeRequestId`.
  - lib/logger/logger.ts - `createLogger`, the shared `logger`, `child`, four writing methods,
    level filtering, stream routing, record assembly, size ceiling.
  - lib/logger/verify.ts - the gate behind `npm run check:logger`.
  - lib/logger/README.md - owner, rules, how to add a field, why a fifth level is refused.
  - docs/planning/STEP_007_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_007_COMPLETED.md.
- Modified:
  - app/api/health/route.ts - `GET` now receives the `Request`, opens a request context and
    writes exactly one `info` line per request. The response body, status and headers are
    unchanged.
  - package.json - `check:logger` added; `verify` now runs the logger gate after the i18n gate.
  - README.md - new "Structured logging" section; the commands table now lists every gate.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/logger/`
  plus the package script line, the root README and one logging line in the only existing route
  handler, which the STEP plan's sub-step 5 ("connect the API routes or background jobs")
  covers for a foundation STEP. Not touched: the environment contract (STEP 004), configuration
  values (STEP 005), the string catalog (STEP 006), the error response format and error code
  catalog (STEP 008), the lint rule matrix (STEP 009), the root layout shell and providers
  (STEP 010), the job foundation (STEP 011), every migration (STEP 012+) and the Sentry
  integration that will consume these records (STEP 244-250).

## Database
- Migrations added (file names): none.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. `LOG_LEVEL` already ships with the values
  `debug`, `info`, `warn` and `error` and the default `info`; this STEP consumes it and adds no
  fifth level. The environment gate still reports the same 16 variables.
- Secrets handled (names only, never values): the logger reads none. It is the component that
  guarantees other modules cannot write `ENCRYPTION_MASTER_KEY`, `AUDIT_SIGNING_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `DATABASE_URL`, `SENTRY_DSN` or
  `TURNSTILE_SECRET_KEY` into a record, by field name and by value shape.

## Packages
- Package requests for the integrator (name, reason), or none: none. The logger uses
  `node:async_hooks`, `node:crypto` and `node:process` only; a logging library would have added
  a transitive tree to a foundation file.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.

  **1. Structured output and levels.** `npm run check:logger` reports
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`.
  It parses every emitted line back from the capture sinks, so the assertions are made against
  the bytes a log aggregator would receive: one physical line per record, valid JSON, a
  parseable ISO `time`, the platform slug in `service`, an `environment` field, and the level
  and message of the call.

  **2. Filtering and stream routing.** At `warn`, `debug` and `info` produce nothing, `warn`
  reaches `stdout` and `error` reaches `stderr`. Proven live on the built server: with
  `LOG_LEVEL=debug` three requests produced three lines; restarting with `LOG_LEVEL=error`
  produced zero lines for the same two requests (`info lines written: 0`).

  **3. Request context.** Proven against a running `next start` on port 3102:
  - request with header `x-request-id: proxy-0123456789abcdef` produced
    `"requestId":"proxy-0123456789abcdef"` with `"route":"/api/health"`, `"method":"GET"`,
    `"environment":"production"`;
  - request with `x-request-id: bad id with spaces` produced a generated id
    (`"req_6e94639a-5564-4585-9a6a-91fbea9b6e38"`), not the header value;
  - request with no header produced another generated id
    (`"req_772cc032-b93b-4e0c-8484-730f5529c0eb"`).
  In the gate, four lines written across an `await`, a `setTimeout`, a nested scope and a child
  logger all carry the same id, one line picks up an explicitly nested id, and a line written
  outside any request has no `requestId` field at all. A payload cannot overwrite the ambient
  id, nor can a caller overwrite `level`, `time`, `message` or `service`.

  **4. Redaction.** The gate seeds nine secrets: a password, a bearer token, a JWT, a
  `sk_live_` key, a `whsec_` secret, an AWS key id, a connection string password, a PKCS#1
  private key block and a `password=` query fragment. None survives into the emitted line. Named
  fields (`password`, `token`, `authorization`, `cookie`, `api_key`, `serviceRoleKey`,
  `cardNumber`, `cvv`, `privateKey`, `credentials`, `key`, `dsn`) and nested fields are replaced
  by `[REDACTED]`; free text is masked in place, keeping the surrounding shape:
  `Bearer [REDACTED]` and `postgresql://app:[REDACTED]@db.internal:5432/postgres`. Ordinary text
  is untouched: `payment of 100.0000 USD for tenant_1` round trips unchanged.

  **5. Bounded records.** A circular reference becomes `[circular]` with `truncated: true`; a
  five megabyte payload (fifty arrays of fifty 2000 character strings, each string inside its
  own limit) is reduced to a record under 16 KiB that keeps `level`, `time`, `message` and says
  `"truncated":true`; a 3000 character string becomes
  `…[+1000 chars]`; a 60 item array becomes 50 items plus `[10 more items]`; depth beyond the
  limit becomes `[depth limit]`; `NaN` and `Infinity` become `"NaN"` and `"Infinity"`; a
  `bigint` becomes `"10n"`; a `Date` becomes ISO text; `undefined` fields are omitted and
  `undefined` array items become `null`; a `Map` becomes an object and a `Set` becomes an array;
  an `Error` keeps name, message, stack and one level of `cause`.

  **6. A logger never breaks its caller.** A sink whose `write` throws does not propagate; a
  configuration read that fails falls back to `info` and to `environment: "unknown"` instead of
  throwing (this is what the gate sees, since it runs without a validated environment).

  **7. The gate fails closed.** Five deliberate regressions, each applied, run and reverted:
  - redaction disabled (`isSensitiveFieldName` returns false) -> exit 1 with 8 problems, the
    first being `a normalized secret field name must be detected` and one being
    `a secret fragment survived redaction: hunter2-correct-horse-ba`;
  - `error` routed to `stdout` -> exit 1 with
    `only the error line must reach stderr (expected 1, received 0)`;
  - request id inheritance removed -> exit 1 with
    `four lines must carry the outer request id (expected 4, received 3)`;
  - record byte ceiling raised to infinity -> exit 1 with
    `an oversized record must respect the byte ceiling`;
  - level filtering removed -> exit 1 with `debug must be suppressed at warn`.
  Every one restored the green line above.

  **8. The health endpoint is unchanged for its callers.** `GET /api/health` on the built
  server still returns `{"status":"ok","service":"kd-solution-it","uptimeSeconds":0,
  "checkedAt":"2026-10-30T17:26:02.745Z"}` with `cache-control: no-store, max-age=0`,
  `content-type: application/json; charset=utf-8` and `x-content-type-options: nosniff`. The
  only difference is one line on the server side.
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable. This
  STEP changes no markup, no class and no token, and it adds no client JavaScript. The health
  route returns the same body and headers, so no screen can be affected.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: the
  success path was exercised live (three requests, three records). Validation failure,
  unauthorized and cross-tenant cases do not exist yet on this endpoint and belong to STEP 011
  (job foundation) and STEP 037+ (auth), not to a logging STEP.
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider
  is called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict` with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` and `verbatimModuleSyntax`; no `any` was introduced.
- Lint result: pass, `npm run lint` exits 0. `no-console` is an error in this repository and the
  logger writes through `process.stdout.write` and `process.stderr.write`, so the rule and the
  sink agree.
- Build result for the touched area: pass on Node.js 26.13.0. `npm run build` emits `○ /`,
  `○ /_not-found`, `ƒ /api/health`; the production server started and logged as recorded above.
- `npm run verify` now runs six gates plus typecheck, lint and build, and exits 0:
  `structure gate passed: 16 directories, 13 root files, 40 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential
  shaped key`,
  `i18n gate passed: 11 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No new dependency, so
  package-lock.json is unchanged.

## Next
- Next STEP number: STEP 008 - Add global error response format and error code catalog. Not
  started. This chat ends here as the owner asked, and STEP 008 needs the owner's consent.
- Anything the next chat must know:
  1. Import `logger` from `@/lib/logger/logger` and `runWithRequestContext` from
     `@/lib/logger/context`. Nothing writes to a stream directly, and `console` is blocked by
     lint.
  2. A route handler should wrap its body once in `runWithRequestContext(...)`, pass the
     inbound `x-request-id` when present, and let every nested call inherit it. The health route
     is the working example.
  3. `logger.child({ tenantId })` exists for a module or a job; the request context wins for
     `requestId`, `method`, `route`, `tenantId`, `userId` and `ip`, because a payload cannot
     overwrite those names.
  4. The record shape is `level`, `time`, `message`, `service`, `environment`, the request
     context, child bindings, then call fields. A new field needs no registration - but a field
     that holds a secret must be added to `sensitiveFieldNames` in `redact.ts`.
  5. Error handling in STEP 008 should log through `logger.error("...", { error })` once per
     failure and then return the standard error body. Do not log the response body twice, and
     do not put the error message into a user facing string without a catalog key (STEP 006).
  6. The Sentry integration (STEP 244-250) should consume these records rather than add a second
     logging path; the `environment`, `service` and `requestId` fields are already in place for
     release tracking and correlation.
  7. Still open for their owners: error format and codes (008), lint matrix (009), root layout
     shell and providers (010), job foundation (011, which should reuse
     `runWithRequestContext` for a job id), migrations (012+).
