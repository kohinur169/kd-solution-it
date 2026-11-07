KD Solution IT for Shopify
==========================

The Shopify side of section 20: a merchant installs this app, logs in with platform
credentials, and the shop's connection becomes active. The app is dependency free, runs on
Node 22 or newer, and talks to exactly two systems: Shopify's OAuth endpoints and the KD
Solution IT public API.

What it does
------------

1. Shopify calls GET /auth/install with shop, host, timestamp and hmac. The app verifies the
   signature with its client secret, refuses a missing, repeated, stale or future-dated
   parameter, creates a session, and redirects the browser to
   https://{shop}/admin/oauth/authorize with the requested scopes and a state it minted.
2. The merchant approves the scopes on Shopify's page.
3. Shopify calls GET /auth/callback with code, shop, state, timestamp and hmac. The app
   verifies the signature again, compares the state with the session's in constant time,
   checks that the shop is the one the install named, and exchanges the code for an access
   token server to server at https://{shop}/admin/oauth/access_token.
4. The access token is held in this process's memory under the session until the merchant
   logs in. It is never written to a cookie, a page, a log line or a disk.
5. GET / shows the credential login. The merchant pastes the public API key from the platform
   (Developers, then API credentials). The app posts { shop_domain, access_token } to
   POST /api/public/v1/stores/shopify/connection with that key, and the platform seals the
   token and answers the connection.
6. The app deletes the token from the session as soon as the platform has accepted it. From
   then on the platform holds it, and this app holds no merchant key at all.

Later visits can check the connection (POST /status) or revoke it (POST /disconnect), each
time with the key typed again, because nothing is stored between requests.

Configuration
-------------

Copy config.example.json to config.json beside the app, fill it in, and start it:

    node src/server.mjs /etc/kd-payments-app/config.json

config.json is a deployment artifact. It is never committed: it holds the app's client ID,
its client secret and the seed for the session cookie's signature. Every field is validated at
boot, and the app refuses to start on a URL that is not an https origin or a secret that is too
short. config.example.json carries no real value.

Fields:

    platformBaseUrl     https origin of the platform, no path and no query
    appUrl              https origin this app is published at
    shopifyApiKey       the app's client ID from the Shopify Partner dashboard
    shopifyApiSecret    the app's client secret (also the install-signature key)
    scopes              Admin API scopes to request, comma separated on the wire
    sessionSecret       32 or more random characters, the cookie signature seed
    sessionTtlSeconds   60 to 3600; how long an install's token is held in memory
    port, listenHost    where the app binds; 0.0.0.0 by default

Endpoints
---------

    GET  /auth/install    Shopify's install request; verifies and redirects
    GET  /auth/callback   Shopify's callback; verifies, exchanges the code
    GET  /                the credential login, the connection and the disconnect form
    POST /login           connect the shop to the merchant's account
    POST /status          ask the platform what the connection is
    POST /disconnect      revoke the connection
    GET  /healthz         liveness, JSON, no session

Security
--------

- Every Shopify parameter is trusted only after its HMAC verifies, compared in constant time.
- A repeated query parameter is refused rather than resolved, because one reading of
  shop=a&shop=b signs differently from another.
- The authorization code travels in the browser; the token never does. The exchange is a
  server-to-server POST with redirect: "error".
- The session cookie is signed, HttpOnly, Secure and SameSite=Lax, and its identifier is
  rotated the moment the session starts carrying a token.
- Every form carries a CSRF token compared in constant time against the session's.
- No merchant key is stored. The Shopify token lives in memory, and is removed as soon as the
  platform accepts it.
- The page is built with an escaping function applied to every interpolated value, and served
  with a content security policy, DENY framing, no referrer and no caching.
- Logs are one JSON object per event and carry a shop domain, a rule and a status: never a
  key, a token, a code or a signature.

What this package does not do yet
---------------------------------

- It is a standalone app, not an embedded one. App Store review requires App Bridge session
  tokens for an embedded app, so publishing this package as-is would need that work first.
- It does not answer Shopify's mandatory GDPR webhooks (customers/data_request,
  customers/redact, shop/redact), which App Store review also requires.
- It does not handle app/uninstalled. The platform's own DELETE remains the revocation path,
  and an uninstall that is not followed by a disconnect leaves a token Shopify will refuse.
- It is not published. Registering the app, listing it and getting it approved are release
  actions, not code.
