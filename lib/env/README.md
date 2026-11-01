// path: lib/env/README.md
# lib/env/

Owner: STEP 004 (environment variable schema with boot-time validation).

| File | Purpose |
| --- | --- |
| manifest.ts | The single source of truth: every variable with scope, format, requirement, secret flag, description and placeholder |
| schema.ts | Meta validation of the manifest, the zod value schemas and the per scope parsers |
| server.ts | `serverEnv()` and `assertServerEnvironmentReady()`: validated once per process, typed, fail closed |
| client.ts | The static literal map of public variables, parity checked against the manifest at import time |
| generate-example.ts | Writes or checks `.env.example`; run directly by Node.js 26 |

## Rules

1. A variable is added in `manifest.ts` only. Then run `npm run env:example` and commit the
   regenerated `.env.example`. `npm run check:env` runs inside `npm run verify`, so a
   manifest and an example file that disagree fail the build gate.
2. Application code reads environment values through `serverEnv()` or `clientEnv` and never
   through `process.env`. The single exception is `NODE_ENV`, which the parsers read to
   determine the active environment.
3. Secrets never leave the server. `lib/env/server.ts` must not be imported from a client
   component, and a returned value must never be logged, returned in a response or embedded
   in an error message. `EnvironmentValidationError` carries variable names and rules only.
4. A browser visible variable must be named `NEXT_PUBLIC_*`, declared with `scope: "client"`
   in the manifest, and read as a static literal in `lib/env/client.ts`. The manifest check
   rejects any other combination.
5. A required variable is required because the platform cannot work without it. Use
   `requirement: "optional"` with a `default` for behaviour that has a safe fallback, and
   `requirement: "conditional"` with `requiredWhen` when another variable switches it on.
6. Real values live only in `.env.local` during development and in the hosting platform's
   environment settings in staging and production. `.env.example` carries placeholders only.

## Commands

| Command | Effect |
| --- | --- |
| npm run env:example | Regenerates `.env.example` from the manifest |
| npm run check:env | Fails when `.env.example` differs from the manifest |

## Boot behaviour

`instrumentation.ts` calls `assertServerEnvironmentReady()` when a server instance starts.
A missing or malformed variable aborts the start with a message that lists the variable
names and the broken rules. During `next build` the check is skipped, so a build machine
never needs runtime secrets.
