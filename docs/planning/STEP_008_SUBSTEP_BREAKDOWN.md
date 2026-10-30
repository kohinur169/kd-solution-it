// path: docs/planning/STEP_008_SUBSTEP_BREAKDOWN.md
# STEP 008 - Re-divided Into Five Sub-Steps

Owner instruction for this STEP: implement STEP 008, split it into five sub-steps first,
implement them one by one, keep the project production ready and keep Node.js 26.13.0 LTS as
the runtime that proves every gate.

## 1. Scope Confirmed From The Source Documents

### STEP 008 as written in docs/final/STEP_PLAN_250.md
- Number and title: STEP 008 - Add global error response format and error code catalog.
- Category: Foundation and Configuration (STEP 001-011).
- Previous handoff read: docs/handoffs/STEP_007_COMPLETED.md. It records that a failure is
  logged once through `logger.error("...", { error })`, that a user facing message must be a
  catalog key rather than a string in code, and that the request context already carries a
  `requestId` the envelope can hand back to a client.
- STEP 006 handoff assigned this STEP the error copy: "Error response format: STEP 008 (its
  messages will be keys into this catalog)." So this STEP adds an `errors` group to
  `lib/i18n/strings/en.ts` and nothing else in that file.

### Feature list and master prompt requirements
- MASTER_PROMPT rule 9: no secret, key, token or credential may appear in code, commits, logs,
  error messages or handoff files. An error message is therefore an output that needs a policy.
- MASTER_PROMPT rule 10: every form and API input is validated with Zod on client and server, so
  the validation failure shape is part of this contract.
- FEATURE_LIST section 20: API keys "never appear in UI, logs or error messages".
- FEATURE_LIST section 22: "Error messages never reveal whether an account exists". The
  authentication code must be identical for an unknown account and a wrong password.
- FEATURE_LIST section 27: background jobs fail and are retried by limit, so an error code needs
  a machine readable retry signal, not a sentence.
- FEATURE_LIST section 32: monitoring consumes the structured log; the error envelope and the
  log line must agree on the code and the request id.
- FEATURE_LIST section 33: typecheck, lint and build must pass for the touched area.

### What exists today (measured before coding)
- No `lib/errors/` directory, no error class, no code catalog, no envelope. The only route
  handler, `app/api/health/route.ts`, cannot fail in practice and has no try/catch, so an
  unexpected throw would reach Next.js and be answered with its default page, not with JSON.
- The string catalog has 11 messages and none for errors.
- The logger (STEP 007) can write the record, but nothing calls it on a failure path.
- A `requestId` exists only inside `AsyncLocalStorage`; nothing can be quoted by a merchant in a
  support message yet.

## 2. Design Decisions Taken Before Coding

1. **One envelope, one shape.** Every failed API call answers with
   `{"error": {"code", "message", "requestId", "retryable", "details"?, "retryAfterSeconds"?}}`.
   No `success` flag, no second shape for validation, no bare string. A client writes one
   branch, not five.
2. **The catalog is the contract.** `lib/errors/codes.ts` maps each code to its HTTP status,
   its catalog key and whether the caller may retry. A code cannot exist without all three, and
   a new code is one entry plus one catalog line.
3. **Codes are stable public identifiers.** `SCREAMING_SNAKE_CASE`, never renamed after release,
   because a store integration will branch on them. A new situation gets a new code.
4. **Copy lives in the STEP 006 catalog, typed by `MessagePath`.** A typo in a key is a compile
   error. Every message is safe to show a merchant: it states what the client can do and never
   what the server saw.
5. **Two outcomes, not a class hierarchy.** A known failure is an `AppError` carrying a code; an
   unknown throw is `INTERNAL_ERROR`. Behaviour follows the code, not the subtype, so nobody has
   to read five class names to know the status.
6. **The raw error never leaves the server.** An unknown failure returns the catalog's internal
   message, never `error.message`, never a stack, never a driver message. The internal detail
   goes to the structured log only.
7. **Validation is machine readable, not prose.** A `ZodError` becomes `VALIDATION_FAILED` (422)
   with `details: [{"field": "email", "rule": "invalid_format"}]`. The field path is useful to a
   form; the rejected value is not included, because a value can be a password or a card number.
8. **Details are sanitized, not trusted.** Only `field` and `rule` survive, each matched against
   a strict alphabet and a length ceiling. Nothing echoes a request body.
9. **Retry is a field, not a guess.** `retryable` and `retryAfterSeconds` describe whether and
   when to try again, and a delay also becomes a `retry-after` header. A background job (STEP
   011) can branch on the field without parsing English.
10. **Failure logging is exactly one line.** 5xx logs at `error` with the `Error` object, 4xx
    logs at `warn` without a stack. The request id comes from the STEP 007 context, so the log
    line and the envelope carry the same value.
11. **Account existence is never revealed.** Both an unknown account and a wrong password use
    `AUTHENTICATION_REQUIRED` with one identical message (FEATURE_LIST section 22), and the
    catalog gate keeps that message shared.
12. **HTTP only, no UI.** `app/error.tsx`, `app/global-error.tsx` and the visual error screen
    belong to STEP 010. This STEP builds the contract those screens will render.
13. **The wrapper is the only entry point.** `withErrorResponse` wraps a route handler, catches a
    synchronous throw and an asynchronous rejection alike, establishes a request context when
    the route did not, and returns the handler's own response untouched on success.
14. **No dependency.** Zod 4 is already installed for validation; the envelope, the catalog and
    the gate are plain TypeScript on Node.js 26.

## 3. Why Five Sub-Steps

| Sub-step | Concern | Wrong without it |
| --- | --- | --- |
| 008.1 | Contract and inventory | An envelope invented per route, codes with no status or no message |
| 008.2 | Code catalog, error class, catalog copy | A code that compiles but has no user facing text or wrong status |
| 008.3 | Envelope, normalization, sanitization | A stack or a rejected password value in a response |
| 008.4 | Wrapper, logging, health wiring | A thrown route answered by an HTML page, or logged twice |
| 008.5 | Gate, docs, proof | A contract nobody verified, and a shape that drifts on the first route |

## 4. The Five Sub-Steps

### 008.1 - Contract, inventory and ownership notes
- Read FEATURE_LIST sections 20, 22, 27, 32 and 33, MASTER_PROMPT rules 9, 10 and 14, and the
  STEP 007 handoff (done above).
- Inventory: no error module, no catalog copy, one route handler, no failure logging.
- Fix the contract: envelope shape and field order, code list with status, message key, retry
  flag, details policy, header set, logging level policy, wrapper behaviour.
- Deliverable: this document.

### 008.2 - Code catalog, error class and catalog copy
- `lib/errors/codes.ts`: `ERROR_CODES` frozen record, `ErrorCode` type, `ErrorDefinition`,
  `isErrorCode`, `getErrorDefinition`, plus the credential free status range assertion.
- `lib/errors/app-error.ts`: `AppError` with `code`, optional `details` and
  `retryAfterSeconds`, `isAppError`, and `toAppError` for unknown input.
- `lib/i18n/strings/en.ts`: an `errors` group with one message per code, no placeholders.
- Proof: the gate resolves every key and compares statuses.

### 008.3 - Envelope, normalization and sanitization
- `lib/errors/respond.ts`: `buildErrorEnvelope`, `sanitizeDetails`, `normalizeError`
  (`ZodError` to validation, `AppError` passthrough, anything else to internal),
  `toErrorResponse` with the header set.
- Rules: no stack, no raw message, no request echo, bounded fields.
- Proof: the gate feeds an `Error`, a thrown string, a thrown `null`, a circular object and a
  `ZodError`, and inspects the exact JSON.

### 008.4 - Wrapper, failure logging and wiring
- `withErrorResponse(handler, options)`: catches sync and async, keeps a successful response
  byte for byte, establishes a request context when absent, logs once (5xx `error`, 4xx `warn`),
  returns the envelope, and never throws.
- Wire `app/api/health/route.ts` through the wrapper. Its success response does not change.
- Proof: the gate captures the logger output and counts one line per failure.

### 008.5 - Gate, documentation, runtime proof and handoff
- `lib/errors/verify.ts`: `npm run check:errors`, added to `npm run verify` after the logger
  gate. It checks the catalog invariants, every outcome above, the header set, and that no
  secret, stack or internal text can reach the envelope.
- Documentation: `lib/errors/README.md` and a root README section.
- Runtime proof: build, start, and exercise a real throwing route (temporarily, then reverted)
  to show the envelope and the single log line; confirm the healthy path is unchanged.
- Finish with `npm run verify` on Node.js 26.13.0, one commit, push and the completed handoff.

## 5. Files This STEP Owns

| File | Status |
| --- | --- |
| lib/errors/codes.ts | created in 008.2 |
| lib/errors/app-error.ts | created in 008.2 |
| lib/errors/respond.ts | created in 008.3 and 008.4 |
| lib/errors/verify.ts | created in 008.5 |
| lib/errors/README.md | created in 008.5 |
| lib/i18n/strings/en.ts (the `errors` group only) | modified in 008.2, as assigned by the STEP 006 handoff |
| app/api/health/route.ts (wrapped in the standard handler) | modified in 008.4 |
| package.json (scripts only) | modified in 008.5 |
| README.md (error response section) | modified in 008.5 |
| docs/planning/STEP_008_SUBSTEP_BREAKDOWN.md | this document |
| docs/handoffs/STEP_008_COMPLETED.md | created in 008.5 |

Not owned here, therefore untouched: the environment contract (STEP 004), configuration values
(STEP 005), the rest of the string catalog (STEP 006), the logger internals (STEP 007), the lint
rule matrix (STEP 009), `app/error.tsx`, `app/global-error.tsx`, the root layout and providers
(STEP 010), the job foundation (STEP 011, which will consume `retryable`), every migration
(STEP 012+) and the Sentry integration (STEP 244-250).
