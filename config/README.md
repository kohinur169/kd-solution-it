// path: config/README.md
# config/

Owner: STEP 001-011 (foundation configuration), with STEP 005 owning the application
configuration modules.

| File | Purpose |
| --- | --- |
| app.ts | Pure typed application configuration: money rules, pagination, login lock, payouts, reconciliation, disputes, billing, caching and the job limits (attempts, backoff, timeout, worker slots, stall window). Frozen and invariant checked at import. Safe in a client bundle |
| server.ts | `getServerConfig()`: the safe, environment derived subset (environment name and flags, application URL, storage provider, log level, monitoring). Server only |
| verify.ts | The configuration gate behind `npm run check:config`, also part of `npm run verify` |
| structure.json | The canonical repository tree read by the structure gate |

## Rules

1. There is no barrel file. `@/config/app` is safe everywhere, `@/config/server` is server
   only. Naming the module at every import keeps the boundary visible.
2. Nothing in this folder reads `process.env`. Environment values arrive through
   `serverEnv()` from `lib/env/server.ts`, which validated them at boot.
3. No secret may be added here. Keys, tokens, passwords, signing keys and connection strings
   stay in `lib/env/server.ts` at their point of use. `config/verify.ts` fails on a
   credential shaped key name.
4. Money is a string with the numeric(18,4) scale, never a JavaScript number.
5. Every value carries either the feature list section that fixes it or a note that it is a
   platform default overridable by a database setting.
6. Configuration that super_admin edits at runtime is a database row, not a file. This folder
   holds code level defaults and hard limits.
7. `getServerConfig()` is called inside a request, a server component body or a job, never at
   module scope, so a production build never needs runtime secrets.
8. The `jobs` section is a hard limit, not a suggestion: a worker reads `workerConcurrency` and a
   retry reads `retryBaseDelaySeconds` and `retryMaxDelaySeconds` from here, so an operator cannot
   tune a deployment into a retry storm by editing a handler.
