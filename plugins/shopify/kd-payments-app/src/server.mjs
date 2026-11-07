// path: plugins/shopify/kd-payments-app/src/server.mjs
import { createServer } from "node:http";
import process from "node:process";
import { loadConfiguration, ConfigError } from "./config.mjs";
import { createPlatformClient, parseApiKey, PlatformRefusal } from "./platform.mjs";
import {
  authorizeUrl,
  createState,
  exchangeCode,
  parseShopDomain,
  sameSignature,
  ShopifyError,
  SHOPIFY_RULES,
  verifyInstallQuery,
} from "./shopify.mjs";
import {
  createCsrfToken,
  createSessionStore,
  readSessionCookie,
  readSignedSessionId,
  sessionCookie,
  signSessionId,
} from "./session.mjs";
import { COPY, fill } from "./copy.mjs";
import { renderPage, SECURITY_HEADERS, STAGES } from "./screen.mjs";
import { CALLBACK_PATH, createOutcomeStore, handleCallback } from "./callback.mjs";
import {
  parseAmountMinor,
  parseOrderReference,
  paymentIdempotencyKeyOf,
  paymentViewOf,
  PaymentError,
  sessionPaymentOf,
  withPayment,
} from "./payments.mjs";

/**
 * The Shopify side of section 20: the install Shopify redirects into, the token exchange, and the credential login that
 * makes the connection active.
 *
 * ## The flow, in the order a merchant sees it
 *
 *   1. **Install.** Shopify sends the merchant's browser to `/auth/install?shop=...&hmac=...`. The query is verified
 *      against the app's client secret, a session is created, and the browser is redirected to the shop's own
 *      authorization URL with a state this app minted.
 *   2. **Consent.** The merchant approves the scopes on Shopify's page. Nothing of this app runs.
 *   3. **Callback.** Shopify redirects to `/auth/callback?code=...&shop=...&state=...&hmac=...`. The query is verified
 *      again, the state is compared with the session's, the code is exchanged server to server, and the resulting
 *      access token is kept **in this process's memory** under the session - never in a cookie, never in a page.
 *   4. **Credential login.** `/` now renders the login form. The merchant pastes their platform public API key; this
 *      server posts the shop and the token to the platform with that key, receives the connection, and **deletes the
 *      token from the session** because the platform is now the place it lives.
 *   5. **Later visits.** `/` shows nothing until the key is typed again; `/status` and `/disconnect` are forms for that,
 *      and the app keeps no key at all between requests.
 *
 * ## The four refusals worth naming
 *
 * A query that does not verify, a state that does not match, a token Shopify did not mint for this app, and a platform
 * refusal are all answered on the same page with a message a merchant can act on - and never with the value that was
 * refused.
 */

/** The largest form body this app reads: one key, one shop and one CSRF token. */
const MAXIMUM_FORM_BYTES = 4_096;

/** The paths this app answers. Everything else is a 404 and nothing else is routed. */
const PATHS = Object.freeze({
  home: "/",
  install: "/auth/install",
  callback: "/auth/callback",
  login: "/login",
  status: "/status",
  disconnect: "/disconnect",
  payments: "/payments",
  paymentsRefresh: "/payments/refresh",
  paymentCallback: CALLBACK_PATH,
  health: "/healthz",
});

/** A structured log line: one JSON object per event, and never a secret, a key or a token. */
function createLogger(write) {
  return (event, fields = {}) => {
    write(`${JSON.stringify({ event, at: new Date().toISOString(), ...fields })}\n`);
  };
}

/**
 * One notice from the catalog: a title, a detail, and the values their placeholders ask for.
 *
 * Every page of this app that says something uses this, so a sentence cannot be written at a call site - it can only be
 * chosen from `copy.mjs`. The values are escaped by the renderer, not here, so this function never decides about markup.
 */
function noticeOf(entry, kind = "error", values = {}) {
  return { kind, title: fill(entry.title, values), detail: fill(entry.detail, values) };
}

/** The form body as a `URLSearchParams`, or a refusal if it is too large or is not a form at all. */
async function readForm(request) {
  const contentType = request.headers["content-type"] ?? "";

  if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new PlatformRefusal({ status: 415, field: null, rule: "content_type" });
  }

  const declared = request.headers["content-length"];
  const declaredLength = typeof declared === "string" ? Number.parseInt(declared, 10) : 0;

  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_FORM_BYTES) {
    throw new PlatformRefusal({ status: 413, field: null, rule: "body_too_large" });
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > MAXIMUM_FORM_BYTES) {
      throw new PlatformRefusal({ status: 413, field: null, rule: "body_too_large" });
    }

    chunks.push(chunk);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** One answer: a status, the security headers, and either a page or a small JSON body. */
function send(response, status, body, extraHeaders = {}) {
  const headers = {
    ...SECURITY_HEADERS,
    ...extraHeaders,
  };

  response.writeHead(status, headers);
  response.end(body);
}

/**
 * The application, as a function the gate can drive without a socket.
 *
 * Every dependency that touches the outside world - the clock, `fetch`, the log stream - is an argument, so the install,
 * the callback, the login and the refusals can all be exercised here in one process.
 */
export function createApp({ config, fetchImpl = fetch, now = () => Date.now(), write = () => {} }) {
  const log = createLogger(write);
  const sessions = createSessionStore({ ttlMs: config.sessionTtlMs, now });
  const platform = createPlatformClient({ baseUrl: config.platformBaseUrl, fetchImpl });
  const outcomes = createOutcomeStore({ now });

  /** The session a request names, or undefined. A cookie that does not verify names no session. */
  function sessionOf(request) {
    const cookie = readSessionCookie(request.headers.cookie);
    const id = cookie === undefined ? undefined : readSignedSessionId(cookie, config.sessionSecret);

    if (id === undefined) {
      return { id: undefined, record: undefined };
    }

    return { id, record: sessions.read(id) };
  }

  /** A session for a request that has none, with the cookie that names it. */
  function ensureSession(context) {
    if (context.record !== undefined && context.id !== undefined) {
      return context;
    }

    const id = sessions.create({ csrf: createCsrfToken(), shop: undefined, accessToken: null });

    return { id, record: sessions.read(id) };
  }

  /** The page, with the session's CSRF token and whatever the caller learned. */
  function page(context, values) {
    const shop = values.shop ?? context.record?.shop;

    return renderPage({
      stage: values.stage,
      shop,
      csrf: context.record?.csrf ?? "",
      notice: values.notice,
      connection: values.connection,
      payments: values.payments ?? context.record?.payments,
      // Only the outcomes of the shop this page is about: a callback for another shop is another merchant's business.
      outcomes: typeof shop === "string" && shop.length > 0 ? outcomes.forStore(shop) : undefined,
    });
  }

  /** A page and the cookie that keeps the session alive, so every answer renews the same identifier. */
  function sendPage(responseObject, context, status, values) {
    const cookie =
      context.id === undefined
        ? {}
        : {
            "set-cookie": sessionCookie({
              value: signSessionId(context.id, config.sessionSecret),
              maxAgeSeconds: config.sessionTtlSeconds,
            }),
          };

    send(responseObject, status, page(context, values), {
      "content-type": "text/html; charset=utf-8",
      ...cookie,
    });
  }

  /**
   * A failure page **with a live session behind it**.
   *
   * The forms on this page are the merchant's way out: "check the connection" after a refusal, or a reload after an
   * expired install. Rendering them with no CSRF token would make every one of them answer `403`, which is a dead end
   * disguised as an error message - so a failure page creates or renews the session exactly as `GET /` does, and the
   * cookie travels back with the answer.
   */
  function sendFailure(request, responseObject, status, notice) {
    const context = ensureSession(sessionOf(request));

    sendPage(responseObject, context, status, { stage: STAGES.installRequired, notice });
  }

  /** Whether a form's CSRF token matches the session's, in constant time. A form without a session never matches. */
  function csrfAccepted(context, form) {
    const presented = form.get("csrf") ?? "";

    return (
      context.record !== undefined &&
      typeof context.record.csrf === "string" &&
      sameSignature(presented, context.record.csrf)
    );
  }

  async function handle(request, responseObject) {
    const url = new URL(request.url ?? "/", config.appUrl);
    const method = (request.method ?? "GET").toUpperCase();
    let context = sessionOf(request);

    if (url.pathname === PATHS.health) {
      send(responseObject, 200, JSON.stringify({ status: "ok" }), { "content-type": "application/json" });

      return;
    }

    if (url.pathname === PATHS.paymentCallback) {
      // The platform's callback, arriving through Shopify's App Proxy. No session, no CSRF and no cookie: the caller is
      // a server, and the proof it carries is Shopify's signature over the proxy query.
      const answer = await handleCallback({
        request,
        secret: config.shopifyApiSecret,
        outcomes,
        now,
      });

      log("payment_callback", { status: answer.status, rule: answer.body.rule ?? undefined });

      send(responseObject, answer.status, JSON.stringify(answer.body), {
        "content-type": "application/json",
      });

      return;
    }

    if (url.pathname === PATHS.install) {
      if (method !== "GET") {
        send(responseObject, 405, "");

        return;
      }

      const verified = verifyInstallQuery({
        query: url.searchParams,
        secret: config.shopifyApiSecret,
        nowMs: now(),
      });
      context = ensureSession(context);
      const state = createState();

      sessions.update(context.id, { shop: verified.shop, state, accessToken: null });
      log("install_started", { shop: verified.shop });

      send(responseObject, 302, "", {
        location: authorizeUrl({
          shop: verified.shop,
          apiKey: config.shopifyApiKey,
          scopes: config.scopes,
          redirectUri: `${config.appUrl}${PATHS.callback}`,
          state,
        }),
        "set-cookie": sessionCookie({
          value: signSessionId(context.id, config.sessionSecret),
          maxAgeSeconds: config.sessionTtlSeconds,
        }),
      });

      return;
    }

    if (url.pathname === PATHS.callback) {
      if (method !== "GET") {
        send(responseObject, 405, "");

        return;
      }

      if (context.record === undefined) {
        log("callback_without_session", {});

        context = ensureSession(context);
        sendPage(responseObject, context, 400, {
          stage: STAGES.installRequired,
          notice: noticeOf(COPY.notices.installUnmatched),
        });

        return;
      }

      const verified = verifyInstallQuery({
        query: url.searchParams,
        secret: config.shopifyApiSecret,
        nowMs: now(),
      });
      const presentedState = url.searchParams.get("state") ?? "";

      if (!sameSignature(presentedState, String(context.record.state ?? ""))) {
        throw new ShopifyError(SHOPIFY_RULES.stateMismatch);
      }

      if (verified.shop !== context.record.shop) {
        throw new ShopifyError(SHOPIFY_RULES.stateMismatch);
      }

      const token = await exchangeCode({
        shop: verified.shop,
        apiKey: config.shopifyApiKey,
        apiSecret: config.shopifyApiSecret,
        code: url.searchParams.get("code") ?? "",
        fetchImpl,
      });

      // A new identifier once the session carries something worth stealing, which is what the token is.
      sessions.destroy(context.id);
      const rotatedId = sessions.create({
        csrf: createCsrfToken(),
        shop: verified.shop,
        state: null,
        accessToken: token.accessToken,
        accessTokenIssuedAt: now(),
      });
      log("install_completed", { shop: verified.shop, scope: token.scope });

      send(responseObject, 302, "", {
        location: PATHS.home,
        "set-cookie": sessionCookie({
          value: signSessionId(rotatedId, config.sessionSecret),
          maxAgeSeconds: config.sessionTtlSeconds,
        }),
      });

      return;
    }

    if (url.pathname === PATHS.home) {
      if (method !== "GET") {
        send(responseObject, 405, "");

        return;
      }

      context = ensureSession(context);

      if (context.record?.accessToken) {
        sendPage(responseObject, context, 200, { stage: STAGES.credentialsRequired });

        return;
      }

      const connection = context.record?.connection;

      sendPage(responseObject, context, 200, {
        stage: connection === undefined ? STAGES.installRequired : STAGES.connected,
        ...(connection === undefined ? {} : { connection }),
      });

      return;
    }

    const isFormPath =
      url.pathname === PATHS.login ||
      url.pathname === PATHS.status ||
      url.pathname === PATHS.disconnect ||
      url.pathname === PATHS.payments ||
      url.pathname === PATHS.paymentsRefresh;

    if (!isFormPath) {
      send(responseObject, 404, "");

      return;
    }

    if (method !== "POST") {
      send(responseObject, 405, "");

      return;
    }

    context = ensureSession(context);
    const form = await readForm(request);

    if (!csrfAccepted(context, form)) {
      log("csrf_refused", { path: url.pathname });
      sendPage(responseObject, context, 403, {
        stage: STAGES.installRequired,
        notice: noticeOf(COPY.notices.formExpired),
      });

      return;
    }

    const apiKey = parseApiKey(form.get("api_key") ?? "");

    if (apiKey === undefined) {
      log("credential_refused", { rule: "api_key_invalid" });
      sendPage(responseObject, context, 400, {
        stage: STAGES.credentialsRequired,
        notice: noticeOf(COPY.notices.keyInvalid),
      });

      return;
    }

    if (url.pathname === PATHS.login) {
      const accessToken = context.record.accessToken;
      const isFresh =
        typeof context.record.accessTokenIssuedAt === "number" &&
        now() - context.record.accessTokenIssuedAt <= config.sessionTtlMs;

      if (typeof accessToken !== "string" || !isFresh) {
        log("login_without_token", { shop: context.record.shop });

        sendPage(responseObject, context, 409, {
          stage: STAGES.installRequired,
          notice: noticeOf(COPY.notices.installExpired),
        });

        return;
      }

      const shop = parseShopDomain(String(context.record.shop ?? ""));
      const connection = await platform.connect({
        apiKey,
        shopDomain: shop,
        accessToken,
      });

      // The platform is now the only place the token lives. This process forgets it before it answers the page.
      sessions.update(context.id, { accessToken: null, accessTokenIssuedAt: null, connection });
      log("connection_activated", {
        shop,
        mode: typeof connection.mode === "string" ? connection.mode : undefined,
        reused: connection.reused === true,
      });

      sendPage(responseObject, context, 200, {
        stage: STAGES.connected,
        connection,
        notice: noticeOf(
          connection.reused === true ? COPY.notices.connectionReused : COPY.notices.connectionActivated,
          "ok",
        ),
      });

      return;
    }

    if (url.pathname === PATHS.payments || url.pathname === PATHS.paymentsRefresh) {
      const stated = (form.get("shop") ?? "").trim();
      const remembered = typeof context.record.shop === "string" ? context.record.shop : "";

      if (stated.length === 0 && remembered.length === 0) {
        // A payment is for a shop, and a session that never held one cannot name it. The page it lands on can.
        log("payment_without_shop", {});

        sendPage(responseObject, context, 409, {
          stage: STAGES.installRequired,
          notice: noticeOf(COPY.notices.paymentNeedsShop),
        });

        return;
      }

      const shop = parseShopDomain(stated.length > 0 ? stated : remembered);

      if (url.pathname === PATHS.payments) {
        // Both values are parsed before anything is sent, so a typo costs no call to the platform.
        const order = parseOrderReference(form.get("order") ?? "");
        const amountMinor = parseAmountMinor(form.get("amount") ?? "");
        const idempotencyKey = paymentIdempotencyKeyOf({ shop, orderId: order.orderId, amountMinor });
        const answer = await platform.createPayment({ apiKey, amountMinor, idempotencyKey });
        const payment = sessionPaymentOf({
          orderId: order.orderId,
          orderGid: order.orderGid,
          amountMinor,
          view: paymentViewOf(answer),
        });

        const payments = withPayment(context.record.payments, payment);

        sessions.update(context.id, { shop, payments });
        log("payment_created", { shop, payment: payment.view.id, status: payment.view.status });

        sendPage(responseObject, context, 200, {
          stage: STAGES.connected,
          shop,
          connection: context.record.connection,
          payments,
          notice: noticeOf(COPY.notices.paymentCreated, "ok"),
        });

        return;
      }

      // Refresh: ask the platform about every payment this session created, and keep the answers the platform gave.
      const payments = Array.isArray(context.record.payments) ? context.record.payments : [];
      const refreshed = [];

      for (const payment of payments) {
        const answer = await platform.readPayment({ apiKey, paymentId: payment.view.id });

        refreshed.push({ ...payment, view: paymentViewOf(answer) });
      }

      sessions.update(context.id, { shop, payments: refreshed });
      log("payments_refreshed", { shop, count: refreshed.length });

      sendPage(responseObject, context, 200, {
        stage: STAGES.connected,
        shop,
        connection: context.record.connection,
        payments: refreshed,
        notice: noticeOf(COPY.notices.statusesRefreshed, "ok"),
      });

      return;
    }

    if (url.pathname === PATHS.status || url.pathname === PATHS.disconnect) {
      const stated = (form.get("shop") ?? "").trim();
      const shop = parseShopDomain(stated.length > 0 ? stated : String(context.record.shop ?? ""));
      const connection =
        url.pathname === PATHS.status
          ? await platform.status({ apiKey, shopDomain: shop })
          : await platform.disconnect({ apiKey, shopDomain: shop });

      sessions.update(context.id, { shop, connection });

      sendPage(responseObject, context, 200, {
        stage: STAGES.connected,
        shop,
        connection,
        notice: noticeOf(
          url.pathname === PATHS.status ? COPY.notices.statusAnswered : COPY.notices.connectionRevoked,
          "ok",
        ),
      });

      return;
    }

    send(responseObject, 404, "");
  }

  /** The server's handler, with every failure turned into a page a merchant can read. */
  return async function handler(request, responseObject) {
    try {
      await handle(request, responseObject);
    } catch (error) {
      if (error instanceof ShopifyError) {
        log("shopify_refused", { rule: error.rule });

        sendFailure(
          request,
          responseObject,
          400,
          noticeOf(COPY.notices.installRefused, "error", { rule: error.rule }),
        );

        return;
      }

      if (error instanceof PaymentError) {
        log("payment_refused", { rule: error.rule });

        sendFailure(
          request,
          responseObject,
          400,
          noticeOf(COPY.notices.paymentRefused, "error", { rule: error.rule }),
        );

        return;
      }

      if (error instanceof PlatformRefusal) {
        log("platform_refused", { status: error.status, rule: error.rule });

        const notice =
          error.status === 0
            ? noticeOf(COPY.notices.platformUnreachable)
            : error.rule === null
              ? noticeOf(COPY.notices.platformRefused, "error", { status: error.status })
              : noticeOf(COPY.notices.platformRefusedWithRule, "error", {
                  status: error.status,
                  rule: error.rule,
                });

        sendFailure(request, responseObject, error.status === 0 ? 502 : error.status, notice);

        return;
      }

      log("unexpected_failure", { name: error instanceof Error ? error.name : "unknown" });

      sendFailure(request, responseObject, 500, noticeOf(COPY.notices.unexpected));
    }
  };
}

/** Start the server on the configured port and host. */
export async function start(configurationPath) {
  const config = await loadConfiguration(configurationPath);
  const app = createApp({
    config,
    write: (line) => {
      process.stdout.write(line);
    },
  });
  const server = createServer((request, response) => {
    void app(request, response);
  });

  server.listen(config.port, config.listenHost, () => {
    process.stdout.write(
      `${JSON.stringify({ event: "listening", port: config.port, host: config.listenHost })}\n`,
    );
  });

  return server;
}

/** The entry point: `node src/server.mjs [config.json]`. A configuration problem stops the app before a socket opens. */
if (process.argv[1] !== undefined && process.argv[1].endsWith("server.mjs")) {
  const configurationPath = process.argv[2] ?? "./config.json";

  start(configurationPath).catch((error) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration refused: ${error.field} (${error.rule})\n`);
      process.exitCode = 78;

      return;
    }

    process.stderr.write("the app could not start\n");
    process.exitCode = 1;
  });
}
