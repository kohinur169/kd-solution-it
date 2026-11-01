// path: lib/logger/README.md
# lib/logger/

Owner: STEP 007 (structured logger with request context and redaction). Later STEPs add
fields, not streams.

| File | Purpose |
| --- | --- |
| levels.ts | The four levels, their severity, `parseLogLevel`, `resolveLogLevel` |
| serialize.ts | Turns any value into bounded JSON safe data, never throwing |
| redact.ts | Field name and value pattern redaction, applied to every record |
| context.ts | `AsyncLocalStorage` request context, request id validation and generation |
| logger.ts | `createLogger`, the shared `logger`, `child`, the four writing methods |
| verify.ts | The gate behind `npm run check:logger`, also part of `npm run verify` |

## Rules

1. Import `logger` from `@/lib/logger/logger`. Never write to `process.stdout`, to
   `process.stderr` or through `console`: a record that skips this module skips redaction and
   the request context.
2. One call, one event. Do not chain sentences into a message, and do not log inside a loop
   over rows: log the outcome once with counts.
3. Fields are data, not prose. `logger.info("invoice created", { invoiceId, amount })`, never a
   message with values glued into it. A field can then be filtered, aggregated and indexed.
4. Redaction is not a caller concern and must not be re-implemented. If a secret arrives in a
   field whose name is not on the list, add the name to `redact.ts`, do not mask at the call
   site.
5. Never log a payload that contains a secret just because it will be redacted. Redaction is a
   net, not a licence. A request body is logged as its validated shape, not as raw input.
6. Levels mean something: `debug` for development detail, `info` for a completed unit of work,
   `warn` for a degraded path that still succeeded, `error` for a failure that needs a human.
   A failed request writes one `error` line, not five.
7. Bind context instead of repeating it: `logger.child({ tenantId })` for a module or a job,
   `runWithRequestContext` for a request. The request id comes from the inbound
   `x-request-id` when it is safe, otherwise from `createRequestId()`.
8. A record is bounded on purpose. Serialization caps depth, array length, key count and string
   length, and the record itself is capped at 16 KiB with a `truncated: true` marker. Do not
   raise those numbers to fit one large payload; log an identifier and fetch the payload from
   the database.
9. Error objects are passed in `fields`: `{ error }`. The logger keeps the name, message, stack
   and one level of `cause`, and redacts each string like any other.
10. The gate must stay green after a change: `npm run check:logger` covers filtering, stream
    routing, the record shape, context propagation, redaction, serialization limits and the
    size ceiling.

## Adding a field

Use the name the rest of the platform uses for that identifier (`tenantId`, `invoiceId`,
`providerId`, `requestId`), and do not name a field after a secret unless it really is one. A
name that is on the sensitive list is redacted everywhere, silently, so a mistake there
produces `[REDACTED]` where a reader expected a value.

## Adding a level

Do not. The four levels come from the environment contract (`LOG_LEVEL`, STEP 004) and the
typed configuration (STEP 005). A fifth level starts in those files, then in `levels.ts`, then
in the sinks and the alert rules.
