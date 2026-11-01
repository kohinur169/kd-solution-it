// path: docs/handoffs/STEP_008_COMPLETED.md
# STEP 008 Completed - Handoff

## STEP
- Number and title: STEP 008 - Add global error response format and error code catalog
- Category: Foundation and Configuration (STEP 001-011)
- Depends on (earlier STEPs in this category and their handoff files): STEP 002 (strict
  TypeScript, `@/` alias, Node.js 26.13.0 LTS), STEP 004 (the validated environment, so a
  failure path never re-reads it), STEP 005 (`appConfig`, untouched here), STEP 006 (the string
  catalog, which owns the message behind every code and whose handoff assigned this STEP the
  `errors` group), STEP 007 (the logger, which writes the one line a failure produces and
  redacts the raw value).
- Re-divided into five sub-steps before implementation; the analysis, the inventory and the
  fourteen design decisions are in docs/planning/STEP_008_SUBSTEP_BREAKDOWN.md. All five
  completed in this session: 008.1 contract and inventory, 008.2 code catalog, error class and
  catalog copy, 008.3 envelope, normalization and sanitization, 008.4 wrapper, logging and
  wiring, 008.5 gate, documentation, runtime proof and handoff.

## Files
- Created:
  - lib/errors/codes.ts - `ERROR_CODES` (14 codes), `ErrorCode`, `ERROR_CODE_NAMES`,
    `isErrorCode`, `getErrorDefinition`, `INTERNAL_ERROR_CODE`.
  - lib/errors/app-error.ts - `AppError` with `code`, `details`, `retryAfterSeconds`, `status`
    and `retryable`; `isAppError`, `toAppError`, `validationError`, `rateLimited`;
    `ErrorDetail`.
  - lib/errors/respond.ts - `normalizeError`, `sanitizeDetails`, `buildErrorEnvelope`,
    `toErrorResponse`, `withErrorResponse`.
  - lib/errors/verify.ts - the gate behind `npm run check:errors`.
  - lib/errors/README.md - the envelope, ten rules, how to add a code, client behaviour.
  - docs/planning/STEP_008_SUBSTEP_BREAKDOWN.md, docs/handoffs/STEP_008_COMPLETED.md.
- Modified:
  - lib/i18n/strings/en.ts - a new `errors` group with 14 messages (catalog total is now 25).
    This is the only change in that file, and the STEP 006 handoff assigned the error copy here.
  - app/api/health/route.ts - the handler is now wrapped in `withErrorResponse` and no longer
    opens its own context; the success body and headers are unchanged.
  - package.json - `check:errors` added; `verify` now runs the error gate after the logger gate.
  - README.md - new "Error responses" section and the commands table.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/errors/`,
  the `errors` group of the string catalog, the package script line, the root README, and the one
  existing route handler, which the STEP plan's sub-step 5 covers. Not touched: the environment
  contract (STEP 004), configuration values (STEP 005), the rest of the catalog (STEP 006), the
  logger internals (STEP 007), the lint rule matrix (STEP 009), `app/error.tsx`,
  `app/global-error.tsx`, the root layout and providers (STEP 010), the job foundation
  (STEP 011), every migration (STEP 012+) and the Sentry integration (STEP 244-250).

## Database
- Migrations added (file names): none.
- Rollback verified on clean database (yes/no, how): not applicable, no migration.

## Environment
- Environment variables added to .env.example: none. The environment gate still reports the same
  16 variables.
- Secrets handled (names only, never values): the module reads none, and it is the component that
  guarantees an outgoing error body cannot carry `ENCRYPTION_MASTER_KEY`, `AUDIT_SIGNING_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` or a provider key.

## Packages
- Package requests for the integrator (name, reason), or none: none. Zod 4 is already installed
  for validation and is the only import; the envelope and the gate are plain TypeScript.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually on Node.js 26.13.0.

  **1. The catalog is complete and self consistent.** `npm run check:errors` reports
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`. It resolves every `messageKey` through `getMessage`, refuses a status outside 4xx and
  5xx, refuses a duplicate message, refuses a placeholder, refuses internal vocabulary (`sql`,
  `postgres`, `stack`, `exception`, `secret`, `token`, `password`, `credential`) in copy, and
  checks that the authentication message names neither an account nor an existence.

  **2. The envelope on a real server.** A `next start` build was exercised with five modes
  through one temporarily modified health handler (the modification was reverted before commit),
  each request carrying `x-request-id: proxy-0123456789abcdef`:
  - healthy: `200` with the unchanged body
    `{"status":"ok","service":"kd-solution-it","uptimeSeconds":0,"checkedAt":"..."}`, headers
    `cache-control: no-store, max-age=0`, `content-type: application/json; charset=utf-8`,
    `x-content-type-options: nosniff`;
  - `AppError("SERVICE_UNAVAILABLE")`: `503` with
    `{"error":{"code":"SERVICE_UNAVAILABLE","message":"The service is temporarily unavailable. Try again shortly.","requestId":"proxy-0123456789abcdef","retryable":true}}`
    plus `x-request-id` in the headers;
  - `AppError("RATE_LIMITED", { retryAfterSeconds: 30 })`: `429` with the catalog message,
    `"retryable":true`, `"retryAfterSeconds":30` and a `retry-after: 30` header;
  - `new Error("database failure for postgresql://app:<secret>@db.internal:5432/postgres with
    sk_live_<secret>")`: `500` with
    `{"error":{"code":"INTERNAL_ERROR","message":"Something went wrong on our side. Quote the
    request id when you contact support.","requestId":"proxy-0123456789abcdef","retryable":false}}`;
    the body contains neither secret, and `grep` for both secret fragments over the whole server
    log file returned `0`;
  - a Zod failure for `{ email: "not-an-email" }`: `422` with
    `"details":[{"field":"email","rule":"invalid_format"}]` and the rejected value absent.

  **3. One log line per failure, at the right level.** The same run produced exactly five
  structured lines: one `info` for the healthy request, `error` for the `503`, `warn` for the
  `429`, `error` for the `500` and `warn` for the `422`. Each carries `requestId`,
  `method: "GET"`, `route: "/api/health"`, `code` and `status`. The `500` line keeps the raw
  error for the engineer, with the STEP 007 redaction applied:
  `database failure for postgresql://app:[REDACTED]@db.internal:5432/postgres with [REDACTED]`.

  **4. Unknown and malformed throws are handled.** The gate feeds an `Error`, a template string,
  `null`, `undefined`, an object and a circular object into `toErrorResponse`. Every one returns
  a `500` with the catalog message, no stack, no `at ` frame, and no echo of the thrown value.

  **5. Validation details are machine readable and safe.** A Zod failure returns one detail per
  issue with a field path (`email`, `items[0].price`) and a rule name, and never the value. The
  sanitizer replaces a hostile field (`<script>alert(1)</script>`) with `unknown`, a hostile rule
  (`DROP TABLE users`) with `invalid`, an over long field or rule with the same markers, and caps
  the list at 25 entries.

  **6. The wrapper is the single entry point.** A successful handler response passes through
  with its status, body and own headers unchanged. A synchronous throw and an asynchronous
  rejection both become the envelope. Handler arguments are forwarded
  (`POST:abc`). A safe inbound `x-request-id` is reused in both the body and the header, an
  unsafe one (`bad id with spaces`) is replaced by a generated `req_...`, and a handler that does
  not open a context itself still sees `route` and `method` from the wrapper
  (`/api/probe|PUT`).

  **7. The gate fails closed.** Six deliberate regressions, each applied, run and reverted:
  - raw cause message echoed into the envelope -> exit 1 with
    `an unknown failure must return the catalog message (expected "...", received "connection
    failed for postgresql://app:sup3rs3cret@...")`, `a secret from a thrown value must not be
    echoed` and `the raw error message must not be echoed`;
  - detail sanitizer bypassed -> exit 1 with
    `a hostile field must be replaced (expected "unknown", received "<script>alert(1)</script>")`;
  - client faults logged at `error` -> exit 1 with
    `one client fault must be logged at warn on stdout (expected 1, received 0)`;
  - authentication message changed to `No account exists with those details.` -> exit 1 with
    `the authentication message must not hint at whether an account exists`;
  - `RESOURCE_NOT_FOUND` status changed to `200` -> exit 1 with
    `RESOURCE_NOT_FOUND must map to a 4xx or 5xx status` and
    `a known failure must use its catalog status (expected 404, received 200)`;
  - the wrapper's `try`/`catch` removed -> the gate aborts with the uncaught `AppError`, exit 1.
  Restoring each mutation returns the green line in item 1.

- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable. This
  STEP adds no component, no markup and no client JavaScript. The visual error screen
  (`app/error.tsx`, `app/global-error.tsx`) is owned by STEP 010 and will render this envelope.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: success
  (healthy `200`), validation failure (`422` with details) and server failure (`500`) were
  exercised on a running production build. Unauthorized (`401`) and cross-tenant requests are
  covered in process by the gate (`PERMISSION_DENIED` 403, `AUTHENTICATION_REQUIRED` 401) but
  have no endpoint yet; they belong to STEP 037+ (auth) and STEP 079+ (tenant scoping).
- Money flow ledger proof (balanced debit and credit) where applicable: not applicable, this
  STEP moves no money.
- Provider sandbox cycle and documentation URLs where applicable: not applicable, no provider is
  called.

## Verification
- Typecheck result: pass, `npm run typecheck` exits 0 under `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` and `verbatimModuleSyntax`. No `any` was introduced.
- Lint result: pass, `npm run lint` exits 0.
- Build result for the touched area: pass on Node.js 26.13.0; the route table is unchanged
  (`○ /`, `○ /_not-found`, `ƒ /api/health`) and the production server answered all five probe
  modes as recorded above.
- `npm run verify` now runs seven gates plus typecheck, lint and build, and exits 0:
  `structure gate passed: 16 directories, 13 root files, 46 source files checked`,
  `check:env passed: .env.example matches 16 manifest variables`,
  `config gate passed: 9 sections, 22 values (5 money entries, all strings), no credential shaped
  key`,
  `i18n gate passed: 25 messages, 2 placeholders, 1 locale (en, ltr)`,
  `logger gate passed: 117 checks, 15 records parsed, 4 levels, 9 secret fragments absent`,
  `error gate passed: 196 checks, 14 codes, all statuses in 4xx or 5xx, no secret or stack in any
  envelope`, then build.
- Runtime: Node.js 26.13.0, npm 10.9.8, engine-strict. No new dependency, so package-lock.json is
  unchanged.

## Next
- Next STEP number: STEP 009 - Add lint rules for strict typing and English-only source guard.
  Not started. This chat ends here as the owner asked, and STEP 009 needs the owner's consent.
- Anything the next chat must know:
  1. A route is wrapped once: `export const GET = withErrorResponse(handler)`. Do not write a
     `NextResponse.json({ error: ... })` by hand anywhere; the envelope, the headers and the log
     line come from `lib/errors/respond.ts`.
  2. Throw `new AppError("CODE")` or a `ZodError`. `validationError(details)` and
     `rateLimited(seconds)` are the two helpers. The `message` of a thrown error is never
     returned, so do not spend effort on its wording.
  3. Codes live in `lib/errors/codes.ts` with a status, a catalog key and a retry flag. Adding
     one is two edits: the catalog entry and the `errors` message in
     `lib/i18n/strings/en.ts`. Never rename a released code.
  4. `details` is `{ field, rule }` only. A STEP that validates input should throw the Zod error
     rather than build details by hand, so the field path stays consistent with the schema.
  5. `retryable` and `retryAfterSeconds` are the job foundation's input (STEP 011): a retry loop
     branches on the flag, never on the message text.
  6. The wrapper opens the request context, so a route no longer calls
     `runWithRequestContext` itself. Logging inside a route still sees `requestId`, `route` and
     `method`.
  7. STEP 009 will add lint guards for strict typing and English-only source. The error copy is
     already catalog based, so an English literal in `lib/errors/` would be a defect for that
     STEP to catch.
  8. Still open for their owners: lint matrix (009), error screens and providers (010), job
     foundation (011, which should consume `retryable`), migrations (012+), and the `401`/`403`
     endpoints themselves (auth STEPs 037-055).
