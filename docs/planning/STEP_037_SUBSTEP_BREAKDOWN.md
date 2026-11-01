// path: docs/planning/STEP_037_SUBSTEP_BREAKDOWN.md
# STEP 037 - Supabase Auth client and server helpers with typed session access

This file is the working plan for STEP 037. It records the owned paths, the decision that the
two standard halves of the work are two sub-steps in one chat session, and the contract each
sub-step has to satisfy before the next one starts.

## 1. What the STEP has to deliver

FEATURE_LIST section 22 (LR-022) fixes the outcome: a session is a cookie plus a server side
record plus a device proof, and the platform must be able to answer "who is calling" from a
typed value rather than from a string dug out of a cookie at every call site. The plan file
(`docs/final/STEP_PLAN_250.md`, STEP 037) narrows this STEP to the client and the helpers; the
pages and the routes that use them belong to STEP 038 (signup), STEP 039 (login and device
registration), STEP 040 (password policy), STEP 041-044 (two factor and reset) and STEP 045-055
(lock, unlock, session rotation and step-up reauthentication).

So STEP 037 delivers three things and nothing else:

1. a typed Supabase Auth client for the server - the exchange of a password, an email token or a
   refresh token for a session, and the service role operations that later STEPs need;
2. a typed session reader - cookie to validated claims to a platform actor, with one rejection
   answer that never says why;
3. the gate that proves both, because the sandbox has no Supabase project and a helper that has
   never answered a request is not a helper.

`docs/planning/STEP_033_SUBSTEP_BREAKDOWN.md` and `STEP_034_SUBSTEP_BREAKDOWN.md` both state
that STEP 037 creates the Supabase Auth client and the typed session access that the two
database functions of `0069` read. That is the contract this STEP keeps: the actor snapshot this
module produces is the same shape those functions expect (a user id, a company id, a live role
list and a two factor timestamp).

## 2. Owned paths

| Path | Owner | This STEP |
| --- | --- | --- |
| `lib/auth/**` | STEP 037-055 | created here |
| `app/(auth)/**` | STEP 037-055 | not touched; no page exists yet (STEP 038) |
| `app/api/auth/**` | STEP 037-055 | not touched; no route exists yet (STEP 038, 039, 041) |
| `docs/planning/`, `docs/handoffs/` | every STEP, own file only | this file and the handoff |
| `lib/errors/**`, `lib/i18n/**` | STEP 006 and STEP 008 | **not edited**; the STEP maps onto existing codes |
| `lib/env/**`, `config/**` | STEP 004 and STEP 010 | **not edited**; no new variable is needed |
| `package.json` | integrator | **not edited**; the gate is run directly and the script request is in the handoff |

Two consequences are recorded here rather than discovered later:

- No new error code is introduced. `AUTHENTICATION_REQUIRED`, `VALIDATION_FAILED`,
  `RATE_LIMITED`, `DEPENDENCY_FAILED` and `TIMEOUT` already cover every failure this module can
  produce, and the catalog rule "a new situation gets a new code" does not apply to a situation
  the catalog already describes.
- No new environment variable is introduced. `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
  `SUPABASE_SERVICE_ROLE_KEY` were declared by STEP 004 and are already validated at boot.
- The module uses `fetch` against the Supabase Auth REST API instead of `@supabase/supabase-js`.
  The dependency is not installed, `package.json` is integrator owned, and the REST API is the
  same surface the SDK wraps. A transport that takes an injected `fetch` is also the only way to
  prove the client in a sandbox with no project, which is what the gate does.

## 3. Sub-step 1 - the contract and the transport

Files: `lib/auth/types.ts`, `lib/auth/config.ts`, `lib/auth/http.ts`, `lib/auth/failures.ts`,
`lib/auth/jwt.ts`.

Done when:

1. `types.ts` names every value that crosses the module boundary: the session, the user, the
   claims, the actor record, the request actor, the session state union and the failure union.
   Nothing in a later file invents its own inline shape.
2. `config.ts` derives the endpoints and the cookie policy from the validated environment. It
   refuses a non https project URL in production, a service role key in the anonymous slot, an
   anonymous key in the service role slot and two identical keys.
3. `http.ts` performs one request with a timeout, `redirect: "error"`, a response size ceiling
   and a JSON parse that cannot throw into the caller. It returns a discriminated result and it
   keeps no upstream message, because an upstream sentence is attacker controlled text.
4. `failures.ts` maps an upstream answer onto the catalog codes. A rejected credential is
   `AUTHENTICATION_REQUIRED` whatever the upstream reason was; that is the section 22 rule that
   an error never reveals whether an account exists.
5. `jwt.ts` reads the claims of the access token this server issued, and states in a comment
   where the signature is checked (Supabase) and why a claim is never the authority for a
   platform decision (the database row is).

## 4. Sub-step 2 - the session surface

Files: `lib/auth/cookies.ts`, `lib/auth/directory.ts`, `lib/auth/session.ts`,
`lib/auth/client.ts`, `lib/auth/admin-client.ts`, `lib/auth/README.md`, `lib/auth/verify.ts`.

Done when:

1. A session payload survives a round trip through one cookie, and through a chunked cookie
   when it does not fit, with `HttpOnly`, `Secure` outside development and `SameSite=Strict`
   exactly as LR-022 requires.
2. A cookie that is chunked out of order, truncated at a chunk boundary, longer than the chunk
   ceiling or carrying a token that is too long is rejected, not half read.
3. `directory.ts` turns a user id into an actor record through one primary key lookup, using the
   service role on the server only, and filters the role list to live grants of the seven roles
   of section 2.
4. `session.ts` answers with one of two values: an authenticated actor, or unauthenticated with
   a reason that is written to the log and never to a response. It also answers the two
   questions section 22 asks about an actor: is two factor enrolled, and does the actor hold a
   role that is allowed here.
5. `client.ts` covers sign up, password sign in, email token verification, verification resend,
   password recovery request, refresh and sign out; `admin-client.ts` covers create, update,
   delete, look up and revoke the sessions of a user. Neither exposes a method that returns an
   upstream sentence.
6. `verify.ts` exercises every rule above with a stub transport and an in memory directory, and
   prints one line with the check count. It is run with `node lib/auth/verify.ts`.

## 5. Gate and handoff

- `node lib/auth/verify.ts`, `npm run typecheck`, `npm run lint`, `npm run verify`.
- The handoff `docs/handoffs/STEP_037_COMPLETED.md` lists the owned files, the decisions, the
  proofs and the two integrator requests: the `check:auth` script line, and the runbook step that
  creates the Supabase Auth user of the bootstrap account with the same id as `public.users`.
