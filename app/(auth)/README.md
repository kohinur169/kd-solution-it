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
