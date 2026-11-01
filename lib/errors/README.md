// path: lib/errors/README.md
# lib/errors/

Owner: STEP 008 (global error response format and error code catalog). Later STEPs add codes
and call the wrapper; they do not invent a second shape.

| File | Purpose |
| --- | --- |
| codes.ts | The code catalog: status, catalog message key and retry flag per code |
| app-error.ts | `AppError`, `toAppError`, `validationError`, `rateLimited` and the detail shape |
| respond.ts | Envelope builder, sanitizer, normalization, `toErrorResponse`, `withErrorResponse` |
| verify.ts | The gate behind `npm run check:errors`, also part of `npm run verify` |

## The envelope

Every failed API call answers with the same JSON object:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Some of the information sent could not be accepted. ...",
    "requestId": "req_01H...",
    "retryable": false,
    "details": [{ "field": "items[0].price", "rule": "invalid_type" }]
  }
}
```

`details` appears only for `VALIDATION_FAILED`, and `retryAfterSeconds` only for a retryable
code. The HTTP status comes from the code, never from the caller. Headers are always
`application/json; charset=utf-8`, `cache-control: no-store, max-age=0`,
`x-content-type-options: nosniff` and `x-request-id`; a retry delay also sets `retry-after`.

## Rules

1. A route is wrapped once: `export const GET = withErrorResponse(handler)`. The wrapper opens
   the request context, catches a synchronous throw and an asynchronous rejection, logs exactly
   one line and returns the envelope. A route never writes an error body itself.
2. Throw an `AppError` with a code for a failure you understand:
   `throw new AppError("RESOURCE_NOT_FOUND")`. For validation, throw a `ZodError` or
   `validationError(details)`. Anything else is `INTERNAL_ERROR`.
3. Never put a sentence in a thrown error. The message a client reads comes from
   `lib/i18n/strings/en.ts` through the code. A string at the throw site is internal
   information.
4. Never put a value in a detail. `details` carries a field path and a rule name only, because
   the rejected value can be a password, a card number or an API key.
5. Use the code that describes the cause, not the nearest one. `PERMISSION_DENIED` (403) is not
   `AUTHENTICATION_REQUIRED` (401), and `CONFLICT` (409) is not `VALIDATION_FAILED` (422).
6. `AUTHENTICATION_REQUIRED` is deliberately identical for an unknown account and a wrong
   password (FEATURE_LIST section 22). Do not add a hint at the call site.
7. `retryable` and `retryAfterSeconds` are for a machine: a job or a client decides from them
   whether to try again, and a delay also becomes the `retry-after` header.
8. A secret never appears in an error message. The message text is catalog copy, the details are
   field names, and the raw thrown value reaches the structured log only, where STEP 007 redacts
   it.
9. Logging happens in `toErrorResponse`, once per failure: `error` for a 5xx with the thrown
   value, `warn` for a 4xx. Do not log again in the route.
10. The gate must stay green: `npm run check:errors` verifies the catalog invariants, every
    status, the envelope fields, the header set, sanitization, and that no secret, stack or raw
    message can reach a body.

## Adding a code

1. Add the entry to `ERROR_CODES` in `codes.ts` with a status, a message key and a retry flag.
2. Add the message to the `errors` group in `lib/i18n/strings/en.ts`. It states what the client
   can do next and nothing about the server. The key is typed, so a mismatch fails the build.
3. Run `npm run check:errors`. It refuses a duplicate message, a status outside 4xx and 5xx, a
   missing key and internal vocabulary in the copy.
4. Codes are never renamed after release. A new situation gets a new code.

## Client behaviour

A client branches on `code`, shows `message`, and quotes `requestId` to support. A store
integration retries only when `retryable` is true, after `retryAfterSeconds` when present.
