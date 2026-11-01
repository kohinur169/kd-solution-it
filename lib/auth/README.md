// path: lib/auth/README.md
# lib/auth/

Owner: STEP 037 (Supabase Auth client and server helpers with typed session access), extended by
STEPs 038-055. STEP 038 added signup, the setting registry, the Turnstile guard, the policy
catalog, the password verifier, the audit trail and the confirmation link. Later STEPs add the
sign in page, the device proof key, the rotating token and the lock; they do not add a second way
to read a session, a second cookie or a second error vocabulary.

| File | Purpose |
| --- | --- |
| types.ts | The session, the user, the claims, the actor record, the request actor, the state and failure unions |
| config.ts | Endpoints and key policy derived from the validated environment, `getAuthConfig`, URL builders |
| http.ts | The one transport: timeout, bounded body, `redirect: "error"`, no key in a URL |
| failures.ts | Upstream answer to catalogue code, and the single generic sign in rejection |
| jwt.ts | Typed claims of an access token this server issued, and the freshness rule |
| cookies.ts | `__Host-kd_session` cookie: naming, encoding, chunking, attributes, clearing, strict parsing |
| directory.ts | The actor port, its Supabase/PostgREST implementation and an in memory one |
| session.ts | `readSession`, `requireActor`, role and company requirements, the 2FA questions |
| client.ts | Sign up, password sign in, email token, resend, recovery, refresh, sign out, get user |
| admin-client.ts | Service role create, update, delete, read and revoke sessions of one account |
| client-address.ts | The request address and agent, refusing anything that is not an address |
| rest.ts | The serviceless PostgREST client: select, insert, insert returning, update, rpc |
| secrets.ts | AES-256-GCM sealing of a stored secret, bound to its setting key |
| settings.ts | `platform_settings`: a JSON value or a secret, never both |
| turnstile.ts | The Cloudflare Turnstile guard: enabled, secret, siteverify, one verdict |
| policies.ts | The twelve policy keys, the published catalog and the text hash of a page |
| password.ts | The scrypt verifier, and the interim password shape STEP 040 replaces |
| audit.ts | The hash chain and the Ed25519 signature an audit entry is written with |
| registration.ts | Merchant signup: validate, challenge, provider account, rows, acceptances, audit |
| email-verification.ts | A followed confirmation link: token, verification instant, audit, cookie |
| runtime.ts | The one place the real implementations are assembled per process |
| verify.ts | The gate behind `node lib/auth/verify.ts` |

## The two values that matter

`SessionState` is the answer to "who is calling", and it has exactly two cases:

```ts
const state = await readSession(request.headers.get("cookie"), { directory, cookiePolicy });
const actor = requireActor(state); // throws AUTHENTICATION_REQUIRED, never returns undefined
```

`RequestActor` is what a handler then uses: `userId`, `companyId`, `roles`, `sessionId`,
`assuranceLevel`, `emailVerified`, `twoFactorSatisfied`, `twoFactorEnrolmentRequired`.

The token is evidence. The actor record read from `public.users` and `public.role_assignments` is
the authority. A permission check uses the record, never a claim.

## Rules

1. A route, a server component or a job never parses a cookie, decodes a token or reads
   `users` itself. It calls `readSession`, and it uses `requireActor` before anything else.
2. The claims are used for three things: the subject of the lookup, the expiry, and the
   assurance level. A role, a company or a permission never comes from a claim.
3. Every rejection is one answer, `AUTHENTICATION_REQUIRED`. The reason is written to the log
   and never to a response, and `failures.ts` is the only place that decides this.
4. A token never appears in a URL, a log line, an error message or a detail. The transport sends
   the key as a header, the failure type has no message field, and the cookie is HttpOnly.
5. The cookie is `__Host-kd_session` outside development and `kd_session` there, written only by
   `cookies.ts` with `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` in the secure case and no
   `Domain`. A route builds its policy with `createAuthCookiePolicy(config, lifetime)`, never with
   `createCookiePolicy` directly, because the prefix decision belongs to one function. The prefix
   is what makes a tossed parent domain cookie impossible. No other module writes a session
   cookie, and a new cookie is a new STEP.
6. There is no browser client, by design. STEP 004 keeps `SUPABASE_URL` and the keys on the
   server, so the browser talks to the platform's own routes and only ever holds an opaque
   session cookie.
7. `SUPABASE_SERVICE_ROLE_KEY` is presented only by `admin-client.ts` and `directory.ts`. It
   bypasses row level security, so it is never the anonymous key, never travels in a URL and is
   never returned to a caller.
8. The admin client has no list-all-accounts method. A caller that needs an account names it.
9. Every upstream call goes through `createAuthHttp`. A `fetch` written in a feature file loses
   the timeout, the body ceiling and the redirect refusal, which is exactly the three things an
   identity provider call must not lose.
10. A rejected sign in, an unknown address and an unconfirmed address produce the same failure
    kind and the same catalogue code. `credentialRejectionError()` is the only way to answer a
    failed sign in, which is how the rule survives later handlers.
11. `claims.subject` equals `public.users.id`. STEP 038 creates the platform row with the
    identifier the provider returned, and the bootstrap runbook creates the provider user with
    the identifier `0079` already wrote. There is no mapping table.
12. A registration answer is not an account. A project with email confirmation enabled answers a
    duplicate address with an obfuscated user, so STEP 038 creates the platform row from the
    provider's real identifier and never from a made up one; a plain sign up followed by a row
    insert would otherwise fail the `users_email_format_check` of `0003` only by luck.
13. The module never throws a raw `Error` at a caller. Configuration mistakes throw at boot, a
    transport or database problem throws an `AppError` with a catalogue code, and a session
    problem returns `unauthenticated`.
14. The gate must stay green: `node lib/auth/verify.ts` drives every branch through the injected
    transport. The `check:auth` script line is an integrator request in the STEP 037 handoff.
15. Signup records acceptances, it does not infer them. `policy_acceptances` gets one row per
    policy in `POLICY_KEYS`, carrying the published page's `version` and the SHA-256 of its body,
    and a catalog that is not complete stops the signup with `SERVICE_UNAVAILABLE` rather than
    writing a partial set. A policy list that is shorter than the catalog is a `VALIDATION_FAILED`
    detail, never a silent default.
16. Turnstile is closed by default. `turnstile.enabled` is seeded `false`, and the guard refuses a
    verification request when the switch is off outside development, so a deployment that forgot the
    secret fails loudly instead of accepting every token. The secret lives in `platform_settings`
    sealed with `ENCRYPTION_MASTER_KEY`, never in an environment variable.
17. A secret is sealed and opened by `secrets.ts` only: AES-256-GCM, a random 12 byte vector, the
    setting key as associated data, and a failure that is `INTERNAL_ERROR` rather than a partial
    value. A row whose parts are not a box (a truncated vector, a short tag) is `DEPENDENCY_FAILED`,
    because a damaged row is a database problem and a wrong key is a deployment problem.
18. An audit entry is written before the session cookie. `email-verification.ts` records
    `user.email_verified` first and encodes the cookie second, so a session cannot exist that no
    entry names.
19. The chain is not retried. `audit_next_link` and `audit_hash_v1` and the insert guard of `0013`
    agree on the sequence, so a failed insert means another writer won the link; the caller
    compensates and rethrows instead of writing a sequence the chain would refuse.
20. Signup compensates in the reverse order of its writes. A failure after the provider account
    exists soft deletes the rows it created and deletes that account through the admin client, then
    rethrows the original error. A signup that answers success with a half written company is worse
    than a signup that fails.
21. Registration never discloses whether an address exists. A provider rejection at signup becomes
    the same `VALIDATION_FAILED` detail as a form problem, and the route answers `201` with the same
    body whether or not a mail was sent.
22. A route does not assemble clients. `getAuthRuntime()` builds the real implementations once per
    process and the gate replaces the object with doubles, which is why the same service is provable
    without a project, a database or a network.

## Adding an operation

1. Add the method to the `AuthClient` or `AdminAuthClient` interface and its implementation,
   with the response schema beside the other zod schemas.
2. Return `AuthOutcome`, never a raw body and never an upstream message.
3. If the operation is anonymous and touches an email address, ask whether its answer could
   disclose whether an account exists. If it could, treat a rejection as accepted, the way
   `resendVerificationEmail` and `requestPasswordReset` do.
4. Add a check to `verify.ts` that proves the endpoint, the key and the failure mapping.
