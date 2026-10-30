// path: docs/planning/STEP_007_SUBSTEP_BREAKDOWN.md
# STEP 007 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 007, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS
as the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 007 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 007 - Add structured logger with request context and redaction.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_006_COMPLETED.md. It records that copy lives in the
  string catalog and must not be pushed into log fields, that `config/server.ts` already
  exposes the validated `logLevel`, and that STEP 007 owns the logger while the error response
  format belongs to STEP 008.
- Ownership line from the File Ownership Rules: foundation STEPs 001-011 own root
  configuration, `config/` and `lib/` foundation files. This STEP creates `lib/logger/`, adds
  its gate script, and connects the one existing route handler (health) with a single line.

### Feature list and master prompt requirements
- MASTER_PROMPT rule 5: "TypeScript strict mode everywhere. No any types. No console.log; use
  structured logging." This STEP is where that rule gets something to use.
- MASTER_PROMPT rule 94: "No secret, key, token or credential may appear in code, commits,
  logs, error messages." Redaction is therefore part of the logger, not a caller habit.
- FEATURE_LIST section 29: every secret lives in environment variables and no secret may be
  written to any log.
- FEATURE_LIST section 32: "Structured logs carry request identifiers so any payment can be
  traced from request to ledger entry." A log line without a request id is not traceable.
- FEATURE_LIST section 33: typecheck, lint and build must pass for the touched area.
- FEATURE_LIST section 14: "Structured logging only" as a platform rule.

### What exists today (measured before coding)
- No `lib/logger/` directory exists, and nothing in the repository writes a structured line.
- `config/server.ts` reads `LOG_LEVEL` through the validated environment and exposes it as
  `logLevel` with the type `LogLevel = "debug" | "info" | "warn" | "error"`. The manifest
  declares the same four values, default `info`, so the logger adds no fifth level.
- `app/api/health/route.ts` is the only route handler: a synchronous `GET` that returns a JSON
  payload with no logging at all, which means a request today leaves no trace.
- `config/structure.json` lists `console.log` as a forbidden marker, so the logger itself must
  not contain that token. Output goes through `process.stdout` and `process.stderr`.
- There is no request id anywhere: no header is read, no context is propagated, and nothing
  correlates two lines written while serving the same request.

## 2. Design Decisions Taken Before Coding

1. **One line, one JSON object.** Every record is a single newline terminated JSON object.
   Log aggregators (Vercel, Netlify, a container runtime) split on newlines, so a pretty
   printed record becomes several useless fragments. A record that cannot be serialized is
   still a record: it is emitted with an omitted payload marker rather than thrown away.
2. **Levels are the four the environment already validates.** `debug`, `info`, `warn` and
   `error`, with numeric severity for filtering. There is no `fatal` and no `trace`, because a
   fifth level would have to be added to the environment contract owned by STEP 004. Filtering
   happens before any serialization or redaction work, so a suppressed line costs nothing.
3. **Two streams, on purpose.** `error` goes to `stderr`; `debug`, `info` and `warn` go to
   `stdout`. Hosting platforms capture the two separately, and an alert rule should be able to
   watch `stderr` without parsing a level field.
4. **Redaction is deny by default, not opt in.** The whole final record - base fields, child
   bindings, payload and nested objects - is walked once after merging. A key whose normalized
   form is a known secret name is replaced by `[REDACTED]`, and every string is also scanned
   for secret shaped values (bearer tokens, JWTs, provider keys, a password inside a
   connection string, a PEM private key, an AWS access key id). A caller cannot forget to
   redact, because the caller never performs redaction.
5. **Request context is ambient, not threaded by hand.** An `AsyncLocalStorage` store carries
   `requestId`, `tenantId`, `userId` and `route`. A function called ten frames deep and two
   `await`s later still writes the same request id without receiving it as an argument.
   Threading a context object through every signature is exactly what gets forgotten when the
   first helper is written in a hurry.
6. **The request id is validated before it is trusted.** An inbound `x-request-id` is accepted
   only when it matches a bounded safe alphabet; anything else is replaced by a generated
   UUID. A header value is attacker controlled input, so it cannot be pasted blindly into a log
   line.
7. **Bounded output.** Depth, array length, key count, string length and the final record size
   are all capped. A log call must never be able to write a megabyte, and a circular object
   must never turn a request into an exception.
8. **A logger never breaks the request it is describing.** The minimum level is resolved from
   the validated configuration, and if that read fails the logger falls back to `info`
   instead of throwing. Writing a line catches sink errors. Failures in observability must not
   become failures in serving.
9. **No dependency.** Node.js 26 has everything needed: `node:crypto` for the id,
   `node:async_hooks` for the context and `node:process` for the sinks. A logging library
   would add a transitive tree to a foundation file.
10. **No barrel file**, matching `config/` and `lib/i18n/`: consumers import
    `@/lib/logger/logger` (write) or `@/lib/logger/context` (wrap a request) explicitly.

## 3. Why Five Sub-Steps

The STEP has four separable concerns and one verification concern, and each has its own way of
being wrong:

| Sub-step | Concern | Wrong without it |
| --- | --- | --- |
| 007.1 | Contract and inventory | A logger that redacts nothing, or five levels nobody validated |
| 007.2 | Record model and safe serialization | A circular object or a 4 MB payload kills the request |
| 007.3 | Redaction | A password or an API key lands in a log that ops can read |
| 007.4 | Logger core and request context | Untraceable lines, no way to filter, two formats for one event |
| 007.5 | Gate, wiring, docs and proof | A library with no caller, and no evidence any of it works |

## 4. The Five Sub-Steps

### 007.1 - Contract, inventory and ownership notes
- Read the FEATURE_LIST sections 14, 29, 32 and 33, the MASTER_PROMPT rules and the STEP 006
  handoff (done above).
- Inventory what exists: no logger, no request id, `logLevel` already validated, the health
  route unlogged, `console.log` a forbidden marker.
- Fix the contract: record shape, field order, level names and severity, sink routing, caps,
  redaction policy, context shape, and the API surface (`createLogger`, `logger`, `child`,
  `runWithRequestContext`, `currentRequestContext`, `resolveRequestId`).
- Deliverable: this document.

### 007.2 - Record model and safe serialization
- `lib/logger/levels.ts`: the level list, severity, `isLogLevel`, `parseLogLevel`,
  `resolveLogLevel` (validated configuration first, `info` as the safe fallback), and the
  `minimumSeverity` helper used by filtering.
- `lib/logger/serialize.ts`: `toJsonSafe` normalization with explicit limits - circular
  references, depth, array length, key count, string length - plus `Error`, `Date`, `bigint`,
  `Map`, `Set`, function and symbol handling, so a payload either becomes plain JSON data or a
  readable marker.
- Proof: the gate in 007.5 exercises every branch.

### 007.3 - Redaction
- `lib/logger/redact.ts`: `redactValue` walks a normalized record and returns a redacted copy.
  Key rule: normalized key name matched against a secret name set. Value rule: string patterns
  for bearer tokens, JWTs, provider secret keys, AWS access key ids, PEM private key headers,
  the password inside a URL with credentials, and the `key=value` form of an authorization
  header.
- The redaction marker is a constant (`[REDACTED]`), so a test and a human read the same thing.
- Proof: the gate feeds real shaped secrets and asserts that neither the key nor a fragment of
  the value appears in the emitted line.

### 007.4 - Logger core and request context
- `lib/logger/context.ts`: the `RequestContext` shape, an `AsyncLocalStorage` store,
  `runWithRequestContext`, `currentRequestContext`, `createRequestId`, `resolveRequestId` with
  the safe alphabet, and `bindRequestContext`.
- `lib/logger/logger.ts`: `createLogger(options)` with injectable sinks and level (the gate
  uses them), the shared `logger`, `child`, the four level methods, field ordering, error
  serialization with `cause`, level filtering, and a size guard that replaces an oversized
  payload with an omitted marker instead of truncating JSON into an unparseable line.
- Proof: the gate asserts filtering, stream routing, ordering, context propagation across
  `await` and timers, child binding inheritance, and that `error` objects keep their name and
  message but not their secrets.

### 007.5 - Gate, wiring, documentation and proof
- `lib/logger/verify.ts`: `npm run check:logger`, added to `npm run verify` after the i18n
  gate. It runs the logger through a real scenario, captures both streams, parses every line
  as JSON and fails on the first broken rule. It also fails when a known secret value survives
  redaction, when a line is not single line JSON, when `error` reaches stdout, or when a
  request id is lost across an asynchronous boundary.
- Wiring: the health route emits exactly one line per request through the request context
  helper. Its response body, status and headers do not change.
- Documentation: `lib/logger/README.md` and a root README section.
- Proof: `npm run verify` on Node.js 26.13.0, a `next start` runtime check of the emitted line
  for a real `/api/health` request, then one commit, push and the completed handoff.

## 5. Files This STEP Owns

| File | Status |
| --- | --- |
| lib/logger/levels.ts | created in 007.2 |
| lib/logger/serialize.ts | created in 007.2 |
| lib/logger/redact.ts | created in 007.3 |
| lib/logger/context.ts | created in 007.4 |
| lib/logger/logger.ts | created in 007.4 |
| lib/logger/verify.ts | created in 007.5 |
| lib/logger/README.md | created in 007.5 |
| package.json (scripts only) | modified in 007.5, as the integrator owned file |
| app/api/health/route.ts (one logging line) | modified in 007.5 |
| README.md (logging section) | modified in 007.5 |
| docs/planning/STEP_007_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_007_COMPLETED.md | created in 007.5 |

Not owned here, therefore untouched: the environment contract (STEP 004), configuration values
(STEP 005), the string catalog (STEP 006), the error response format and error code catalog
(STEP 008), the lint rule matrix (STEP 009), the root layout shell and providers (STEP 010),
the job foundation (STEP 011), every migration (STEP 012 and later), and the Sentry integration
that will consume these records (STEP 244-250).
