// path: docs/handoffs/STEP_037_COMPLETED.md
# STEP 037 Completed - Handoff

## STEP
- Number and title: STEP 037 - Supabase Auth client and server helpers with typed session access.
- Category: Authentication and Session Security (STEP 037-055); this is the first STEP of the
  category.
- Depends on (earlier STEPs in this category and their handoff files): STEP 004 (`SUPABASE_URL`,
  `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` declared and validated at boot, and the rule
  that the browser never receives a server variable), STEP 006 (the English catalog every error
  message comes from), STEP 008 (the error code catalog and the response envelope this module maps
  onto without adding a code), STEP 013 (`public.users` and `public.role_assignments`, the two
  tables the actor record is read from), STEP 015 (`public.sessions`, which STEP 051 fills),
  STEP 033 (the actor helpers and the seven role vocabulary), STEP 035 (`current_actor_roles()` and
  the policy layer), STEP 036 (`public.bootstrap_super_admin()`, the first account whose provider
  identity has to match the row it wrote).
  The split of this STEP into two sub-steps is `docs/planning/STEP_037_SUBSTEP_BREAKDOWN.md`:
  **037.1** the contract and the transport, **037.2** the session surface.

## Files
- Created:
  - lib/auth/types.ts - the session, the user, the claims, the actor record, the request actor, the
    state union, the failure union and the seven role vocabulary, all frozen.
  - lib/auth/config.ts - `buildAuthConfig`, `getAuthConfig`, the endpoint table, the key policy and
    the URL builders for one grant and one admin user.
  - lib/auth/http.ts - the one transport: timeout, body ceiling, `redirect: "error"`, `credentials:
    omit`, key as a header, JSON parse that cannot throw, failure with no message field.
  - lib/auth/failures.ts - upstream answer to `AuthFailure`, `toAuthAppError`, the single generic
    `credentialRejectionError`, and the machine code reader that refuses a sentence.
  - lib/auth/jwt.ts - typed claims of an access token this server issued, the freshness rule with
    clock skew, and the comment that states where the signature is checked and why a claim is
    never a permission.
  - lib/auth/cookies.ts - the `__Host-kd_session` cookie: policy, canonical encoding, numbered
    chunks, attribute set, clearing and a parser that refuses a gap.
  - lib/auth/directory.ts - the `ActorDirectory` port, its PostgREST implementation (one primary
    key lookup, embedded live grants, service role on the server only) and an in memory one.
  - lib/auth/session.ts - `readSession`, `requireActor`, `requireAnyRole`, `requireCompanyId`,
    `hasRole`, `hasAnyRole`, `isTwoFactorEnrolmentRequired`, `hasSatisfiedTwoFactor`.
  - lib/auth/client.ts - sign up, password sign in, email token verification, resend, password
    recovery, refresh, sign out and get user, all on the anonymous key.
  - lib/auth/admin-client.ts - service role create, update, delete, read one and revoke every
    session of one account, with no list-all-accounts method.
  - lib/auth/verify.ts - the gate, run with `node lib/auth/verify.ts`.
  - lib/auth/README.md - the module contract and the fourteen rules later STEPs keep.
  - docs/planning/STEP_037_SUBSTEP_BREAKDOWN.md and docs/handoffs/STEP_037_COMPLETED.md.
- Modified:
  - README.md - one new `## Authentication and sessions` section above the database section,
    describing the reader, the claim and authority split, the configuration refusals, the transport
    guarantees, the cookie and its prefix, the failure mapping, the two clients and the gate.
- Owned paths touched (must match the File Ownership Rules in STEP_PLAN_250.md): `lib/auth/**` (the
  STEP 037-055 owned folder), `docs/planning/` (this STEP's own file), `docs/handoffs/` (this STEP's
  own file) and the root `README.md`. Not touched: `app/(auth)/**` and `app/api/auth/**`, because
  the pages and routes belong to STEP 038, 039, 041 and 042 and none of them exists yet;
  `lib/errors/**`, `lib/i18n/**`, `lib/env/**`, `config/**`, `migrations/**`, `.env.example`,
  `package.json` and `package-lock.json`.

## Database
- Migrations added (file names): none. This STEP is the client and the reader; the tables it reads
  (`public.users`, `public.role_assignments`) and the table STEP 051 writes (`public.sessions`) were
  created by STEP 013, 013 and 015. The schema is unchanged at 79 migrations, 69 tables, 185
  policies, 80 functions, 297 indexes and 130 triggers.
- Rollback verified on clean database (yes/no, how): not applicable, no migration. `npm run
  check:migrations` is green at 2,342 checks over the same 79 migrations.

## Environment
- Environment variables added to .env.example: none. The module consumes `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `NODE_ENV`, all declared by STEP 004, and it
  reads them only through `serverEnv()` inside `getAuthConfig()`. `npm run check:env` is unchanged
  and green.
- Secrets handled (names only, never values): `SUPABASE_ANON_KEY` (presented as the `apikey` header
  for the browser path), `SUPABASE_SERVICE_ROLE_KEY` (presented only by `admin-client.ts` and
  `directory.ts`, never in a URL, never in a failure, never returned). No secret appears in a log
  line, an error, a response or a cookie: the cookie carries only the two opaque tokens of one
  session, which is what LR-022 requires of it.

## Packages
- Package requests for the integrator (name, reason), or none: **no package**. The module calls the
  Supabase Auth REST API with the platform's `fetch`, which is the surface `@supabase/supabase-js`
  wraps; the dependency is not installed and the SDK's browser session store is the thing this
  STEP replaces.
- One **script request** for the integrator, because `package.json` is integrator owned: add
  `"check:auth": "node lib/auth/verify.ts"` to `scripts` and insert `npm run check:auth` into the
  `verify` chain before `check:lint`, so the auth gate runs with the other eleven gates. Until that
  line exists the gate is run directly and the command is recorded in `lib/auth/README.md` and the
  root README.
- One **runbook addition** for the integrator, recorded here because it is the only way the first
  account can sign in: `0079_super_admin_bootstrap()` writes a `public.users` row with a
  caller-chosen id and a password hash, and it cannot create a Supabase Auth user. The operator must
  therefore create the provider user with the same id - `POST /auth/v1/admin/users` with
  `{ id, email, password, email_confirm: true }`, which is exactly what
  `createAuthAdminClient().createUser` sends - or the bootstrap account exists in the database and
  has no provider identity, so `039` cannot sign it in. The invariant is `claims.subject ===
  public.users.id`, there is no mapping table, and the runbook step keeps it true.

## Behaviour Proof (acceptance checklist)
- Behaviours named in the STEP title, exercised manually, with observed results. The proof is
  `node lib/auth/verify.ts`, **302 checks, 0 failed**, against an injected transport and an in memory
  directory, because this environment has no Supabase project and a helper that never answered a
  request would not be a helper:
  - **Configuration.** The endpoint table is derived from the origin; the configuration and its
    endpoint table are frozen; a non https project URL is refused outside a loopback development
    environment, and so are a path, a query, an embedded credential and a value that is not an
    absolute URL; two identical keys are refused, a secret key in the anonymous slot is refused, a
    publishable key in the service role slot is refused, a short key is refused and an untrimmed key
    is refused; `secureCookies` is false only for `development`.
  - **Claims.** Subject, session id, assurance level, email, methods, expiry and remaining lifetime
    are read; an `aal2` token reports `aal2`; a token without optional claims is accepted; an
    unknown claim does not break a token; an empty token, a two segment token, a payload that is not
    JSON, a missing subject, a subject longer than an identifier, an unknown assurance level, an
    oversized token and a missing expiry are all refused; a token inside the clock skew window is
    already treated as expired.
  - **Cookie.** A small session fits one cookie that carries `__Host-kd_session`, `HttpOnly`,
    `Secure`, `SameSite=Strict`, `Path=/`, a `Max-Age` equal to the session lifetime and no
    `Domain`; the value round trips the user, the session, the access token and the refresh token;
    the development policy drops the prefix and the Secure flag; the policy lifetime caps the cookie
    and a session expiring sooner shortens it; a large token pair is split into numbered chunks and
    reassembled byte for byte; a gap, a whole cookie beside chunks, a foreign cookie, a tampered
    value, a non payload value and an empty header are refused; clearing expires the whole cookie
    and every chunk with the attributes they were written with; an unsafe name, a policy without a
    lifetime, a payload outside the schema and a `__Host-` name without the Secure flag are refused.
  - **Failures.** A success is not a failure; a wrong password, an unconfirmed address and an
    unknown account all classify as `rejected` and all map to `AUTHENTICATION_REQUIRED`, while a
    rejected registration maps to `VALIDATION_FAILED`; a `429` keeps its `retry-after` and the
    catalogue answer carries it; a `429` without a delay gets the documented sixty seconds; `5xx`
    and an unexpected status are `upstream` and answer `DEPENDENCY_FAILED`; a timeout answers
    `TIMEOUT`; a network or malformed answer answers `DEPENDENCY_FAILED`; a sentence is never
    accepted as an upstream code; the sign in rejection is the generic one, answers 401, carries a
    code and never a sentence, and no upstream code reaches the failure a caller reads.
  - **Transport.** A redirect is an error and never a hop; no process cookie jar is attached; the
    key travels as the `apikey` header and never in a URL; a bearer is sent when given; a body is
    JSON and a bodyless call sends no content type; the platform is identified in `x-client-info`;
    `retry-after` is read; a bodyless answer is null; a timeout, a socket failure and a caller
    cancellation are distinguished; a body that is not JSON, a declared length over the ceiling and
    an actual length over the ceiling are refused.
  - **Directory.** Live grants only, deduplicated and sorted, with revoked, deleted and unknown
    roles dropped; the lookup is one request naming its columns, filtered on the primary key with
    `limit=1`, never `select=*` and never a credential column, presented with the service role key
    as `apikey` and as bearer; a subject that is not a uuid sends no query; no row is no actor; two
    rows, an outage, a rejected key, an unknown status and an unparseable timestamp are platform
    failures, not an empty role list.
  - **Session.** A valid session authenticates with the subject, the company, the session, the roles,
    the verified flag and the two factor flags; `hasRole`, `hasAnyRole`, `requireAnyRole` and
    `requireCompanyId` answer as documented, with `PERMISSION_DENIED` and not `401`; an `aal2`
    session satisfies the second factor while an `aal1` session of a TOTP enrolled account does not;
    a role holder without a confirmed TOTP must enrol and may not act; a missing cookie, a broken
    cookie, a broken token, an expired token, a cookie naming one user with another user's token, a
    cookie naming another session, an unknown subject, a suspended account, a closed account and a
    deleted account each answer `unauthenticated` with their own reason and every one of them throws
    the same `AUTHENTICATION_REQUIRED`; a directory failure propagates as its own code instead of
    signing the merchant out; an account with no role needs no second factor.
  - **Clients.** The password grant, the refresh grant and the sign up URL (including the redirect),
    the verify body, the logout bearer, the user read and the anonymous key on every browser path
    call are asserted on the recorded request; a wrong password and an unknown address fail
    identically; a rate limited sign in is a rate limit; a registration returns the platform account
    id and no session when confirmation is required, and a session when it is not; a registration
    answer without an id is a failure; a resend and a recovery never disclose whether an address
    exists while a rate limit still reaches the caller; signing out an expired session is a
    successful sign out; an account without an email is not a platform account. The admin client
    sends the platform chosen id, the confirmation flag and the name as metadata, uses the service
    role key as `apikey` and as bearer, updates only the changed field, refuses an update with no
    change and an identifier that is not an account id, deletes one account, revokes every session of
    one account with `scope=global`, reads one account, and exposes five operations with no way to
    page through every account.
- UI checks (desktop, mobile, keyboard, light and dark) where applicable: not applicable, this STEP
  renders nothing. `app/(auth)/` and `app/api/auth/` are untouched, and `npm run build` still
  produces the same three routes.
- API checks (success, validation failure, unauthorized, cross-tenant) where applicable: no route
  exists yet. The unauthorized behaviour is proven at the module boundary: every rejection reason
  answers one 401 code, a missing role answers 403, and a directory outage answers 502/504 instead
  of 401. Cross tenant isolation is unchanged from STEP 033 and 035, because this module reads
  `users` and `role_assignments` with the service role on the server and hands the actor's company
  to the caller rather than letting a route choose one.
- Money flow ledger proof (balanced debit and credit) where applicable: none, no money table is
  touched.
- Provider sandbox cycle and documentation URLs where applicable: no live project is reachable from
  this environment, so no sandbox cycle was run; the endpoints and payloads are the documented
  Supabase Auth REST surface (`/auth/v1/token`, `/signup`, `/verify`, `/resend`, `/recover`,
  `/logout`, `/user`, `/admin/users`, and `/rest/v1/users` through PostgREST), and the whole client
  is exercised against scripted answers that use that surface's shapes.

## Verification
- Typecheck result: `npm run typecheck` passes with no output.
- Lint result: `npm run lint` passes with no output; `npm run check:lint` is green, so the matrix
  still requires all twenty-six rules as errors.
- Build result for the touched area: `npm run build` compiles successfully in about 1.6 s and emits
  the same three routes; `npm run verify` exits 0 with every gate, the typecheck, the lint and the
  build in sequence.
- Gate: `node lib/auth/verify.ts` prints `auth gate passed: 302 checks, cookie
  "__Host-kd_session", 8 chunk ceiling`.
- Structure gate: green, and every new file starts with its `// path:` comment; the six new modules
  are ASCII only and carry no unfinished-work marker of any kind.

## Next
- Next STEP number: STEP 038 - the signup route and page, the first caller of this module.
- Anything the next chat must know:
  1. `readSession` needs two things a route must build once: an `ActorDirectory`
     (`createSupabaseActorDirectory(getAuthConfig(), createAuthHttpForConfig(getAuthConfig()))`) and
     a cookie policy (`createAuthCookiePolicy(getAuthConfig(), lifetime)`). The policy is the only
     place the `__Host-` prefix is decided, so never call `createCookiePolicy` from a route.
  2. The id invariant is not optional. STEP 038 creates the `public.users` row with the identifier
     the provider returned, which is what makes `claims.subject` usable as a key. The bootstrap
     account needs the provider user created with the id `0079` wrote, and the runbook step is in
     the packages section above.
  3. With email confirmation enabled, Supabase answers a duplicate address with an obfuscated user
     object rather than an error. STEP 038 must create the platform row from a real provider
     identifier and must not create a second row for an existing address; the `users` table has a
     unique lowercase email and will refuse the insert, which is the backstop and not the design.
  4. The cookie is written only after a successful exchange and cleared with `clearSessionCookies`
     using `sessionCookieChunkCount` of the incoming header, so a sign out expires every chunk the
     browser holds.
  5. The server side session row, the device proof key, the rotation, the replay detection and the
     family revocation are STEP 049 to 051. `readSession` today checks the token, its freshness, the
     cookie to token binding and the platform account state; STEP 051 inserts the row check between
     the token check and the directory lookup, and nothing else in the module changes.
  6. Two factor is a claim plus a row: `twoFactorSatisfied` is `aal2`, `twoFactorEnrolmentRequired`
     is "holds a role and has no confirmed TOTP". STEP 041 turns the second into an enrolment
     screen and STEP 053 reuses `hasSatisfiedTwoFactor` for step-up.
  7. The gate is not yet in `npm run verify`. Add the `check:auth` script line before the next
     authentication STEP so a regression in this module fails the standard command.
