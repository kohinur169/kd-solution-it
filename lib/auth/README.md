// path: lib/auth/README.md
# lib/auth/

Owner: STEP 037 (Supabase Auth client and server helpers with typed session access), extended by
STEPs 038-055. Later STEPs add the routes, the pages, the device proof key, the rotating token
and the lock; they do not add a second way to read a session, a second cookie or a second error
vocabulary.

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

## Adding an operation

1. Add the method to the `AuthClient` or `AdminAuthClient` interface and its implementation,
   with the response schema beside the other zod schemas.
2. Return `AuthOutcome`, never a raw body and never an upstream message.
3. If the operation is anonymous and touches an email address, ask whether its answer could
   disclose whether an account exists. If it could, treat a rejection as accepted, the way
   `resendVerificationEmail` and `requestPasswordReset` do.
4. Add a check to `verify.ts` that proves the endpoint, the key and the failure mapping.
