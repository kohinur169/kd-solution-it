// path: app/(auth)/README.md
# app/(auth)

Owner: STEP 037-055 (authentication, two factor and login lock).

Reserved for signup with email verification and Turnstile, login, two factor
authentication with backup codes, password reset and the locked account notice.

Nothing in this route group may reveal whether an account exists, and every screen is
served with the LR-022 session cookie rules from the feature list.

/2fa is the TOTP enrolment screen of STEP 041: one button starts the enrolment, the answer carries
the secret, the `otpauth://` URI and the drawing of the symbol, and the code that confirms it turns
the enrolment into a second factor and answers the ten backup codes once. The routes behind it are
`/api/auth/2fa/enroll` and `/api/auth/2fa/confirm`, both of which require the step 039 session and
neither of which answers a question about an account that is not the caller's own.

The sign in screen now has a second stage. A password that the platform accepts on an account with a
confirmed second factor answers `two_factor_required` and writes no cookie; the screen asks for the
code from the authenticator app, or a backup code, and posts it with the challenge handle to
`/api/auth/2fa/verify`, which is the only writer of the session cookie on that path. `/2fa` is the
enrolment screen and `/api/auth/2fa/verify` is the sign in step: different routes, different
prerequisites.

/2fa/settings is the two factor settings screen of STEP 043: it shows whether the second factor is on,
how many backup codes remain, and a form that replaces the whole set. The page reads the session and
the account on the server (it is `force-dynamic`), so it renders three states - signed out,
unavailable, ready - rather than a loading shell; the only client action posts to
`/api/auth/2fa/backup-codes` with the current authenticator code.

/2fa/reset is the recovery screen of STEP 044, for a merchant who kept neither the app nor the backup
codes. It renders without a session - the person who needs it cannot sign in - and posts an address and
a description to `/api/auth/2fa/reset`, which answers one `202` sentence whether or not the address has
an account. `/2fa` and `/signin` both link to it, and the office side lives in `app/office`.

The sign in screen now answers the lock of STEP 045. `POST /api/auth/signin` and
`POST /api/auth/2fa/verify` answer `423 ACCOUNT_LOCKED` with `retryAfterSeconds` - and the form prints
the remaining minutes instead of asking for the password again - only once the password is known to be
right, so the lock never becomes an oracle for whether an address has an account. A wrong password on
a locked account keeps the one generic sentence.
