// path: lib/auth/README.md
# lib/auth/

Owner: STEP 037 (Supabase Auth client and server helpers with typed session access), extended by
STEPs 038-055. STEP 038 added signup, the setting registry, the Turnstile guard, the policy
catalog, the password verifier, the audit trail and the confirmation link; STEP 039 added sign in,
the attempt record and the device label; STEP 040 replaced the interim password shape with the
policy and the breach check. Later STEPs add the device proof key, the rotating token and the lock;
they do not add a second way to read a session, a second cookie or a second error vocabulary.

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
| password.ts | The password policy of section 22, and the scrypt verifier |
| breach-check.ts | The breached password range query, by SHA-1 prefix and never by password |
| audit.ts | The hash chain and the Ed25519 signature an audit entry is written with |
| registration.ts | Merchant signup: validate, challenge, provider account, rows, acceptances, audit |
| email-verification.ts | A followed confirmation link: token, verification instant, audit, cookie |
| device-context.ts | The device label of an agent, and the hash of an address nobody owns |
| login-attempts.ts | One attempt row in `public.login_attempts`, the record STEP 045 counts |
| signin.ts | Password sign in: challenge, exchange, account check, attempt, audit, cookie |
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
   `Domain`. A route builds its policy with `createAuthCookiePolicy(config, lifetime, masterKey)`,
   never with `createCookiePolicy` directly, because the prefix decision belongs to one function.
   The prefix is what makes a tossed parent domain cookie impossible. No other module writes a
   session cookie, and a new cookie is a new STEP. The payload carries an HMAC-SHA-256 signature
   whose key is derived from `ENCRYPTION_MASTER_KEY` with HKDF and its own info string, so a payload
   a browser wrote for itself is refused before it is decoded: a claim read from an unverified
   value is a claim whoever wrote the cookie chose.
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
23. Sign in answers one failure. A wrong password, an unknown address, an unconfirmed address, a
    closed account and a missing platform row all throw `credentialRejectionError()`, which is the
    only constructor of `AUTHENTICATION_REQUIRED` in this module, and the difference is recorded in
    `login_attempts` where only the platform can read it.
24. An attempt is a row before it is a decision. Every sign in writes `public.login_attempts` with
    the factor and the outcome, so STEP 045's lock survives a restart because it counts rows and
    not a number in memory. A refused attempt is recorded too, and a record that fails never changes
    the answer to the merchant.
25. A password is refused by rule, never by sentence. `password.ts` returns the first rule a value
    breaks and the failure detail carries `{field: "password", rule}`, so a form can point at the
    field and a log can count refusals without either recording what was typed. Twelve characters,
    three of four character kinds, six distinct characters, nothing from the person's address, name
    or business name, and no surrounding space.
26. A breached password is checked by prefix, never sent. `breach-check.ts` hashes with SHA-1
    because that is the corpus index, sends five hexadecimal characters to the range endpoint with
    `add-padding`, and reads the answer as text through the same transport with the ceiling this
    endpoint needs. A corpus that cannot answer is `DEPENDENCY_FAILED`: a check nobody performs is
    worse than no check, because someone believes in it.
27. The breach verdict is audited. `merchant.signed_up` carries `breach_check: "clear" | "skipped"`,
    so the database answers "was this password checked" without trusting a log line. The switch
    `password.breach_check.enabled` is seeded open by `0081`; closed outside production is skipped,
    closed inside production is refused.
28. The device is recorded, the proof key is not invented. `device-context.ts` derives a bounded
    label from a user agent, and the sign in reports `deviceProofRequired` from the live
    `device_proof_keys` rows. The key pair itself is STEP 049's browser work and the `sessions` row
    that binds it is STEP 051's, because `0009` needs a client public key and `0010` needs the key
    before a session can exist. A fabricated key would be a device the platform cannot verify.

29. An enrolment is two steps and the first one protects nothing. `startTotpEnrolment` seals a fresh
    secret into `users.totp_secret_ciphertext` with the associated data `users.totp:<id>` and leaves
    `totp_confirmed_at` null; only `confirmTotpEnrolment` accepts a code, stamps the instant and
    replaces `backup_code_hashes`. `hasConfirmedTwoFactor` is the only question the rest of the
    platform may ask, so an account with a secret nobody proved is never treated as protected.
30. The TOTP arithmetic is RFC 6238 and nothing else. `totp.ts` is SHA-1, six digits, thirty seconds
    and a window of one step on either side, returning the step that matched so STEP 042 can refuse
    a replay of the same step. The secret is 160 bits of `randomBytes` in unpadded base32, which is
    the form every authenticator app reads.
31. A backup code is shown once and stored as a verifier. Ten codes of ten characters from an
    alphabet without `0`, `1`, `l` or `o`; `normalizeBackupCode` forgives case, spaces and the
    separator before `hashPassword` runs, so a person who types it loosely still gets in, and the
    column never holds a code that could be replayed.
32. The QR code is encoded here, not fetched. `lib/qr/` writes the symbol itself - byte mode, level M,
    versions 1 to 10, mask 0 - because a third party image service would receive the enrolment
    secret, and a dependency cannot be added without a package request. `lib/qr/path.ts` turns the
    matrix into one SVG path of horizontal runs, which the screen draws inside an `<svg>` it builds
    from numbers; no string of markup is ever injected, and `fill-symbol`/`fill-symbol-background`
    keep the symbol dark on light in both themes.

33. A password does not sign an enrolled account in. `signInMerchant` answers `signed_in` or
    `two_factor_required`, and the second shape carries no cookie and no `cookies` field at all:
    `user.signed_in` is written only after the code, because before it nothing has signed in. The
    provider's pair is sealed into one `auth_challenges` row and the browser holds a handle.
34. A challenge is a handle, a hash and a sealed pair. `two-factor-login.ts` stores the SHA-256 of
    32 random bytes, never the handle; the pair is AES-256-GCM under the master key with the
    challenge in the associated data; the lifetime is ten minutes and a success consumes the row, so
    one password entry produces one session.
35. Every refusal at the second factor is the same sentence. An unknown handle, an expired
    challenge, a consumed one, a wrong code and a spent backup code all answer
    `AUTHENTICATION_REQUIRED`, and each rejection is a `login_attempts` row with `factor = 'totp'`
    for the lock of STEP 045. Five rejections retire the challenge, so a stolen password has five
    guesses at a million.
36. Assurance is decided by the payload this platform signed. The provider's token says a password
    was checked; only this platform knows that a code was, so `completeTwoFactorChallenge` mints a
    cookie carrying `assuranceLevel: "aal2"` and `readSession` takes the higher of the payload and
    the claim. A backup code counts as a satisfied second factor, and spending it is audited.

37. A fresh set of backup codes is a step up, not a refresh. `regenerateBackupCodes` requires the
    session and the current TOTP code, because ten new codes are ten new ways into the account and a
    stolen session must not be able to mint them. A wrong code is `VALIDATION_FAILED` with
    `field: "code"`; an account without a confirmed factor is `CONFLICT`, and the screen offers
    enrolment instead.
38. The set is replaced whole, never appended to. `users.backup_code_hashes` is written in one
    update, so an old code stops working at that instant; a code the screen says is dead has to be
    dead. The audit entry records `issued` and `replaced` as counts, never a code, and the response is
    the only place a new code exists in clear.
39. The sealed box and the column it lives in are sized together. `isSecretBox` accepts a ciphertext
    up to the widest column any table gives a box (`auth-challenges` after `0083`, 16 384
    characters), because a box this module sealed must be a box this module can open: a smaller cap
    than the column turns a legitimate value into "not a box this build wrote", which is a refusal no
    operator can diagnose and no retry can fix. The gate seals a pair at the documented maxima and
    completes a sign in with it.

40. A recovery request is anonymous and answers one sentence. The merchant who lost the app cannot
    sign in - that is the premise - so `requestTwoFactorReset` takes an address and a reason and no
    session. An unknown address, a closed account, an account that never enrolled and a real request
    all answer `{ accepted: true }`; only one of them writes a row. The route is `202` in every case,
    and the audit entry records `reason_length`, never the reason and never the address.
41. One account has one live request. `0084` puts a partial unique index on the live statuses
    (`pending`, `contacted`), and the service treats the resulting `CONFLICT` as the same accepted
    answer: a merchant who asks twice has still asked once, and the office already holds it.
42. A reset is decided in order, and the order is the evidence. `contacted` moves a `pending` request
    and requires a document reference; `approve` moves a `contacted` request and clears
    `totp_secret_ciphertext`, `totp_confirmed_at` and `backup_code_hashes` in one update; `reject`
    records a note. Everything else is `CONFLICT`, so an approval can never skip the record of what a
    human verified. The roles are `super_admin`, `ceo`, `compliance_kyc` and `support`, and the check
    lives in the service, not in the route or the page.
43. The reset clears a factor and nothing else. It leaves the password, the sessions and the account
    status alone: this is a second factor reset, not a suspension, and the merchant signs in with the
    password alone and enrols again through STEP 041. Documents are a reference string because the
    encrypted upload pipeline is STEP 100's; the audit records that a reference existed, not its text.

44. The lock is a row, not a memory. `account_locks` (`0012`) holds one row per lock, refuses a lock
    longer than two hours in a check, allows one open lock per account through a partial unique index,
    and closes a row exactly one way: an office unlock or the clock. Nothing about a lock lives in a
    process, so a restart cannot release one - which is the "survive server restarts" sentence of
    section 22 taken literally.
45. Two consecutive failures, counted per factor. `recordFailedSignIn` writes the attempt row and then
    counts the newest `login_attempts` rows of that account and that factor (`0085` indexes exactly
    that query). `account_locks.triggered_by` names which factor reached two, because `0012` says so.
    A success ends the streak; a `blocked` or `challenged` row neither counts nor ends it, and the
    second consecutive failure opens the lock.
46. The lock is asked after the password, never before it. A lock that answered before the credential
    check would confirm that an address has an account, so a wrong password on a locked account gets
    the one generic sentence and the attempt is recorded as `failed`. Once the password is right, the
    answer is `ACCOUNT_LOCKED` (423) with `retryAfterSeconds`: it tells the owner what happened and
    tells a stranger nothing. The provider session that exchange created is signed out again, because
    no sign in happened.
47. Failing closed on the read, best effort on the count. `readAccountLock` and
    `assertAccountUnlocked` propagate a storage failure, so "the database did not answer" can never be
    reported as "the account is open". `recordFailedSignIn` swallows one: the refusal it accompanies
    has already been decided, and a missing counter row must not turn "wrong password" into an
    outage sentence.
48. A lock is not cleared by anything a merchant can do. The module never writes `users`, so changing
    the password cannot touch a lock; an expired row is closed by the next failure before a new lock is
    written, because the live key would otherwise make the account unlockable by time and lockable by
    nothing. The office unlock is STEP 047's, through the `0012` columns this module never writes.

49. The owner is alerted through the email queue, not by this module. `lib/auth/lock-alert.ts` runs
    once per lock that starts, resolves the owner of the company (`role_assignments` with `role =
    'owner'` and `0012`'s company scope), and writes one `email_send_logs` row (`0061`) with
    `template_key = 'login_lock_alert'`, the sending method the office made active in
    `email_settings` (`0059`), and `reference_kind = 'account'`. It sends nothing: SMTP, the
    templates and the retry sweep are section 23, STEP 221 to STEP 230.
50. One alert per lock, claimed in the database. `0086` points the lock at that row
    (`account_locks.alert_send_id`) and stamps `owner_alerted_at` in one update that only matches
    while the column is still null; the claim is read back afterwards, and a call that lost the race
    marks its own row `dropped` so the owner gets one email and the log still tells the whole story.
    A unique index refuses two locks that claim one email, and a check refuses a lock that says it
    alerted its owner without naming the email that did it.
51. No owner, no sender, no email - and still a lock. A platform account has no merchant owner and a
    platform without a configured sending method has no way to send, so those are answers
    (`no_owner`, `sender_not_configured`) with a log line for the office, not reasons to fail the
    sign in. The notifier never throws, and the lock service catches it as well, because the refusal
    the stranger is owed has already been decided. `owner_alerted_at` means "the platform took
    responsibility for telling the owner": delivery, its attempts and its provider message id stay in
    `email_send_logs.status`, one place and one truth.
52. The alert is audited, the address is not. `user.login_lock_alerted` records the send id, the
    template, the factor, the lock window and that the recipient was the owner. It does not record
    the address: the audit chain is forever, and an address that must be erasable later does not
    belong in it.

53. The unlock is a service, not a route. `unlockAccountLock` decides everything section 22 asks for:
    the role, the second factor, the contact confirmation, whether the lock is still open, the note
    and the audit entry. `app/api/office/account-locks/unlock` reads a body and a cookie and calls it,
    so the screen of STEP 078 and the step-up guard of STEP 053 get the same guards as the endpoint and
    cannot get a weaker copy of them.
54. Who may end a lock, and who may not. `ACCOUNT_UNLOCK_OFFICE_ROLES` is `super_admin`, `ceo`,
    `compliance_kyc` and `support`: the office roles that talk to a merchant. `owner` is not in it -
    the owner of a locked company cannot unlock themselves, which is the whole point of the office
    having the key - and neither are `finance_ops` (money, not access) and `blogger` (content only).
    The actor must also have answered a second factor, because section 22 makes TOTP mandatory for
    every role holding account.
55. The contact is a field and a column, and the note is a constraint. The caller confirms the owner
    was reached, the update stamps `owner_contact_confirmed_at`, `0012` refuses an unlock without that
    instant and `0087` refuses an unlock without `unlock_note`. A code path added later cannot close a
    lock quietly, and the officer's note is the only free text the row keeps - the audit chain stores
    its length, never its words.
56. One conditional update, a read back, then the audit. The write only matches a row that is still
    open, so a second officer and the clock cannot both win; the read back turns a lost race into
    `CONFLICT` instead of a success that never happened. A lock whose two hours are over is `CONFLICT`
    even when its row was never closed, because the sign in service already treats it as open.
57. The unlock is not a third way out of a lock. It closes the row and writes nothing else: the
    failures in `login_attempts` remain, `users` is untouched, and the next successful sign in is what
    ends that streak. Section 22 lists an office unlock after contact and the clock, and this module
    adds neither a counter reset nor a password change.
58. The merchant is told, through the email queue. Section 23 lists "account unlock confirmation"
    among the automatic activity emails, so the unlock writes one `email_send_logs` row with
    `template_key = 'account_unlock'` to the address of the account that was locked, using the same
    queue as the lock alert of STEP 046. It is queued last and caught: a platform with no sender, an
    account with no address and a queue that refuses the row are logged answers, and an unlock never
    fails because its confirmation could not be queued.
59. One sentence for every anonymous refusal. `lib/auth/disclosure.ts` names the refusal
    (`AUTHENTICATION_REQUIRED`, 401, no details) and `anonymousRejection()` builds a fresh instance
    of it, so a wrong password, an address the platform has no row for, an unconfirmed mail and a
    followed link that has expired all render the same envelope. A surface that answers one of them
    differently - a `409`, a "no such account", a field named `email` with the rule `not_found` - has
    turned the sign in form into an account directory.
60. The catalogue is the contract, and the gate reads the folder. `ANONYMOUS_AUTH_SURFACES` lists
    every stranger-facing route with the codes it may answer; `SESSION_AUTH_SURFACES` lists the rest
    so "not classified" is distinguishable from "forgotten". `checkDisclosure()` compares both lists
    against the files under `app/api/auth`, refuses a code the catalog does not know and refuses
    `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `PERMISSION_DENIED`, `RESOURCE_NOT_FOUND` and
    `UNSUPPORTED_MEDIA_TYPE` on an anonymous surface, because each of those five describes a record.
61. A fact about an account is only the account holder's. `ACCOUNT_LOCKED` and the second factor
    challenge are real answers and stay: section 22 line 238 requires a locked account with the
    right password to be told so. What section 22 line 243 forbids is a stranger learning it, so the
    lock answer is computed only after the password has been proven, and the same locked account
    with a wrong password renders the canonical refusal. `verify.ts` compares the rendered envelopes
    rather than the codes, so a detail added later fails the gate.
62. Signup accepts every address the same way, and creates nothing for one that exists. The provider
    hides a duplicate by answering the existing person with an empty identity list (in
    `SignUpResult.identity` that is `existing`, and the identifier in it is somebody else's); a
    project with confirmations off answers a refusal code instead. Both, plus the platform's own
    `users_email_key`, end in `{ status: "indistinguishable" }` and `201`
    `{"status":"verification_required"}` with no company, no person and no audit entry. The
    compensation learned two guards on the way: it never soft closes a `users` row this request did
    not insert, and it never deletes a provider account the provider did not say it created, so a
    duplicate cannot close, delete or otherwise disturb the account it collided with.
63. The private half never leaves the browser. `generateProofKeyPair` asks WebCrypto for a key
    pair whose private half is **non-extractable**, exports only the SPKI public half and posts that;
    no route in this platform accepts a private key, and the pair is kept in IndexedDB because
    `localStorage` keeps strings - which is the one thing this design must not have. Section 22's
    proof key is therefore a key the browser can use and a machine cannot carry away.
64. The server computes the fingerprint it stores. `inspectProofKey` refuses a string that is not
    its own canonical base64url, parses the DER with `createPublicKey`, checks the curve against the
    declared algorithm (P-256 for ES256, P-384 for ES384, Ed25519 for EdDSA), re-exports SPKI and
    hashes *those* bytes. A client-supplied fingerprint is not even an input field:
    `deviceEnrolmentSchema` is strict, so a third field is refused rather than ignored.
65. Enrolling a device is not trusting it. Every row this platform writes has `trusted_at` null;
    section 22 trusts a new device only after the email and second factor confirmation of STEP 052.
    An enrolment therefore adds a key and changes nothing about the session that made the call,
    which is why STEP 050 has to verify a signature before any endpoint acts on one.
66. Enrolment is idempotent, bounded and audited. The same live fingerprint answers
    `already_enrolled` and moves `last_seen_at`; a race with `device_proof_keys_live_key` resolves the
    same way from the losing side; past ten live devices the answer is `CONFLICT` and nothing is
    written; and every written or refreshed row appends `user.device_enrolled` or
    `user.device_proof_refreshed` with the algorithm and the device label, never the key.
67. A proof is evidence beside the session, never instead of it. `verifySensitiveRequest` runs
    after `readRequestActor`: a request without a session is refused by the session read, and a
    request with one but without a proof is refused by the proof check. The six refusal reasons
    (`missing-header`, `malformed-header`, `query-not-signed`, `path-not-sensitive`,
    `method-mismatch`, `stale-timestamp`, `unknown-device`, `signature`, `replayed`) all answer the
    same `AUTHENTICATION_REQUIRED` with an empty detail list and one `user.request_proof_rejected`
    entry naming only the reason and the method - the nonce, the signature and the key never reach
    the audit trail.
68. The message is the contract. `requestProofMessage` joins seven newline separated lines:
    `kd-proof-v1`, the upper cased method, the pathname, the body digest, the timestamp, the nonce
    and the device row id. The version line means a later revision can sign differently without
    reinterpreting an old signature; the pathname is signed without its query, so a request that
    carries one is refused as `query-not-signed` rather than verified against the wrong path; and
    the body is covered by its base64url SHA-256 (`-` for an empty body), which is why every route
    reads the body once with `await request.text()` and parses that same string afterwards.
69. Five minutes of clock, two of them real. A signature is accepted when its timestamp is within
    `REQUEST_PROOF_WINDOW_MS` (120 s) of the server clock on both sides, and the nonce table
    refuses a nonce past `signed_at + interval '10 minutes'`, so a timestamp cannot be stretched
    into a long lived replay window. The unique index on `(device_proof_key_id, nonce)` is the
    replay guard: the insert happens before any endpoint work, and a conflict is the refusal.
70. The registry is the boundary, and the gate reads the disk. `SENSITIVE_ENDPOINTS` lists the
    method and path of every endpoint that requires a proof, and `checkRequestProof()` compares it
    with the routes that import `verifySensitiveRequest`: a listed endpoint whose file does not
    call it, and a route that calls it without being listed, both fail. Adding an endpoint is
    therefore a change in one file, proved by a check, not by memory.
71. A cookie is a reference, not a bearer token. After STEP 051 the payload carries a 32 byte
    random `sessionToken`, the server stores only its SHA-256 in `public.sessions.token_hash`, and
    every authenticated request resolves it to exactly one row. The signature proves the platform
    wrote the cookie; the row proves the session is still the session the platform last issued, so
    revoking one (054) and ending a family after a theft both take effect on the next request.
72. A session is bound to the device it was issued for. `0010` makes `device_proof_key_id` required
    and its composite foreign key keeps the device on the same account;
    `POST /api/auth/session/rotate` writes that row after the enrolment of STEP 049, and
    `verifySensitiveRequest` refuses a proof whose device row is not the one the session names
    (`session-device-mismatch`). A sibling key of the same account is therefore not evidence about
    this session.
73. Rotation is a compare and swap, and the grace window is why it is safe. The parent is revoked
    as `ROTATED` by an update that only matches `revoked_at is null`, the row is read back to learn
    whether this call won, and only the winner inserts a child that copies `family_id` and
    `absolute_expires_at`. A spend token presented again inside `SESSION_ROTATION_GRACE_MS` is
    honoured without issuing anything - the request was already in flight when the answer rewrote
    the cookie - and the same token after it is a replay: the row becomes `REPLAY_DETECTED`, every
    live row of the family becomes `FAMILY_REVOKED`, and `session.replay_detected` plus
    `session.family_revoked` record it. Neither entry ever quotes a token.
74. A rotation chain has a ceiling. `0089` added `absolute_expires_at`, written when a family starts
    and copied by every rotation, with a check that refuses a row whose own expiry reaches past it.
    `openSession` and `rotateSession` compute each expiry as the earlier of the rotation window and
    the ceiling, so a browser that keeps a stolen cookie rotating cannot extend a login for ever.
    A rotation past the ceiling is refused as `expired`, not silently renewed.
75. A new device is detected where a session starts, and nowhere else. `device_proof_keys.trusted_at`
    is the flag: STEP 049 writes every enrolment with it null, STEP 051 binds a session to that row
    and reports the flag without enforcing it, and `lib/auth/device-trust.ts` - the sibling of the
    lock alert, one table over - is the module that turns the flag over. The detection runs in
    `POST /api/auth/session/rotate` only when the answer is `bound` - the request that starts a
    session - so rotating an existing session is the same machine asking again and never becomes a
    second email.
76. The alert is a queue row, not a mail client. `challengeDeviceTrust` writes one
    `email_send_logs` row with `template_key = 'new_device_alert'`, `reference_kind = 'account'` and
    the account's own address, in the shape `lock-alert.ts` already uses, and the section 23 worker
    of STEP 227 does the rest. `0090`'s unique index on the alert and its partial unique index on one
    live challenge per device are what make "one alert per new device" true even when two requests
    read the same empty table: the loser's row is marked `dropped` with a reason.
77. The step that trusts a device is the second factor, not another email. `email_send_logs` has no
    field for a per-send secret and `0060`/`0061` are closed, so the platform does not pretend to
    mail a code it could not mail: `POST /api/auth/devices/confirm` takes the authenticator code,
    verifies it against the sealed secret (`twoFactorContext`), and only then stamps `trusted_at`
    and consumes the challenge. A wrong code spends an attempt of the five `0090` allows; an
    expired challenge, an exhausted budget and an account that never finished its enrolment are
    three different `422` rules because each asks the person for something different.
78. The session must be bound to the device it is confirming. `sessions.device_proof_key_id` is
    compared with the device in the body before the code is read, so a session on a trusted machine
    cannot be used to trust a machine somebody else holds; the refusal is `403`, which a screen can
    act on, and a `401` would read as "sign in again" and change nothing.
79. An unconfirmed device gets no dangerous action. `verifySensitiveRequest` still reports
    `trusted` rather than refusing - every key the platform creates starts unconfirmed, and the
    enrolment has to be reachable from the device that has to be confirmed - and
    `requireTrustedDevice` turns the report into the refusal at the three endpoints that hand out a
    way in: ten fresh backup codes, an approved reset and an unlock.
80. Freshness is two instants on the session, not a flag in a cookie. `sessions.mfa_verified_at`
    (`0010`) records when the second factor was satisfied at sign in, and `sessions.reauthenticated_at`
    - the column `0010` already carried and STEP 053 fills, bounded above by `0091` - records when it
    was proved again inside the session. `readStepUpState` takes the later of the two and the proof
    counts for `STEP_UP_WINDOW_MS` (ten minutes), so a merchant who signed in a minute ago is not
    asked for the same code twice while a session left open all afternoon cannot unlock an account.
    Both instants are carried onto the actor by `readBoundSession`, which is the only place that
    reads the row, so the guard itself does no I/O and the gate can hold its edges.
81. The step-up proof is the second factor, not the password again. The session already proved the
    password; the authenticator code is the part a stolen password and a stolen cookie both cannot
    supply, and it is verified against the sealed secret in `users`. A backup code is accepted for
    exactly the case section 22 built them for, and using one spends it. `POST /api/auth/session/reauth`
    is therefore a signed endpoint of STEP 050's list and refuses an unconfirmed device of STEP 052
    before it reads a code.
82. One guard, one call, and an answer a screen can act on. `requireFreshReauthentication` answers
    `403 PERMISSION_DENIED` with `{ field: "session", rule: "reauth_required" }` - not `401`, which
    would send the person to a sign in form that changes nothing - and the endpoints of section 22's
    list call it after the proof and the device trust, so a session that may not act here at all never
    learns how fresh it is. `POST /api/office/account-locks/unlock` is the first caller; gateway keys,
    payouts and KYC decisions call the same line when their STEPs arrive.
83. A rotation carries the proof. `rotate` copies `mfa_verified_at` and `reauthenticated_at` into the
    child row, so replacing a token fifteen minutes after a step-up cannot undo the step-up itself -
    the freshness belongs to the login, not to one rotation of it. The lock of section 22 is asked
    before the code, so a locked account cannot be used to test one. The instant is bounded from both
    sides, in two files: `0010` refuses one that predates `issued_at`, `0091` one that reaches past
    `expires_at`, and the family ceiling of `0089` follows from the row's own.
84. A session list is filtered by the actor, never by the request. `listOwnSessions` takes the
    `userId` from the session that asked, so `GET /api/auth/sessions` has nothing in it a caller could
    point at another account; the office read takes an account id and checks the role inside the
    service, not in the route and not in the page, so a second caller cannot reach a weaker version of
    it. Reading somebody else's sessions is a use of a permission and writes
    `session.list_read_by_office` before the rows are returned.
85. Two reasons, and the row says which. The owner ends a session with `SIGNED_OUT`, an office role
    with `ADMIN_REVOKED` - both already in `0010`'s closed vocabulary, so an incident can tell "the
    account closed this door" from "the platform did" without reading two entries. `revoked_at` is the
    only thing that ends a session: every reader in the platform, `readRequestActor` first, treats a
    revoked row as gone, so a revoke takes effect on the next request and not on a later sweep.
86. Closing a door never waits, opening one always does. `POST /api/auth/sessions/revoke` is signed by
    STEP 050's proof and refuses an unconfirmed device of STEP 052, but it does **not** call
    `requireFreshReauthentication`: a person who thinks their laptop was stolen must be able to end
    that session without fetching an authenticator first. The office half -
    `POST /api/office/sessions/revoke` - does call it, because signing a merchant out of every device is
    an act on somebody else's account, which is the case section 22 names.

## Adding an operation

1. Add the method to the `AuthClient` or `AdminAuthClient` interface and its implementation,
   with the response schema beside the other zod schemas.
2. Return `AuthOutcome`, never a raw body and never an upstream message.
3. If the operation is anonymous and touches an email address, ask whether its answer could
   disclose whether an account exists. If it could, treat a rejection as accepted, the way
   `resendVerificationEmail` and `requestPasswordReset` do, and add the path to
   `ANONYMOUS_AUTH_SURFACES` in `disclosure.ts` with the codes it may answer. `checkDisclosure()`
   fails on an unclassified route, so this is a step, not a suggestion.
4. Add a check to `verify.ts` that proves the endpoint, the key and the failure mapping.
