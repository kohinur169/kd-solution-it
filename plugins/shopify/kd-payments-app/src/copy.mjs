// path: plugins/shopify/kd-payments-app/src/copy.mjs

/**
 * Every sentence the app says to a merchant, in one object.
 *
 * MASTER_PROMPT rule 1 puts user-facing strings in one catalog, and the platform keeps its own in
 * `lib/i18n/strings/en.ts`. This app is a separate deployment and cannot import that module - it has no Next.js, no
 * TypeScript and no build step - so it carries its own catalog instead of scattering sentences across the renderer
 * and the request handler. That is the same choice the WooCommerce plugin makes by routing its strings through
 * `esc_html__`.
 *
 * Two properties follow, and the gate pins both: a sentence lives **here** and nowhere else, so a renderer cannot
 * invent copy, and every notice is data - a title, a detail and, where a value is needed, a `{placeholder}` that
 * `fill` substitutes. Nothing here is built from a request value, so no catalog entry can carry anything private.
 *
 * The values are plain text. Markup is the renderer's business, and escaping happens once, at the boundary.
 */

/** The app's catalog. One locale, because the app ships in English. */
export const COPY = Object.freeze({
  brand: "KD Solution IT for Shopify",
  shopPrefix: "Shop",
  noShop: "No shop in this session yet.",
  footer: "This app stores no merchant key, and the shop token only until the login finishes.",

  install: Object.freeze({
    title: "Install the app from your Shopify admin",
    waiting: "This app answers Shopify's install request, and there is nothing to do on this page until one arrives.",
    already: "Already installed? Type the shop domain and your platform API key to see the connection.",
    shopLabel: "Shop domain",
    shopPlaceholder: "your-shop.myshopify.com",
    keyLabel: "Platform API key",
    submit: "Check the connection",
  }),

  credentials: Object.freeze({
    title: "The app is installed. Log in with your platform credentials.",
    body:
      "Shopify approved {shop} and this app is holding its access token for the next few minutes. The key below " +
      "connects that shop to your merchant account, and it is the only thing that can: Shopify knows the shop, and " +
      "the key says whose shop it is.",
    keyLabel: "Public API key",
    hint: "Developers, then API credentials, then copy the key once. This app keeps no copy of it.",
    submit: "Connect the shop",
  }),

  connected: Object.freeze({
    title: "Connected",
    answer: "The platform answered with the row it holds.",
    disconnectTitle: "Disconnect",
    disconnectBody:
      "A revocation is final: connecting the same shop again is a support action, and the payments already carried " +
      "stay readable.",
    keyLabel: "Public API key",
    submit: "Revoke this connection",
  }),

  /** The six terms of the connection view, and the three stand-ins for a value the platform did not send. */
  fields: Object.freeze({
    shop: "Shop",
    status: "Status",
    connectedAt: "Connected at",
    storeId: "Store id",
    tokenEnding: "Token ending",
    mode: "Mode",
    notYet: "not yet",
    assignedOnConnect: "assigned on connect",
    notReported: "not reported",
  }),

  /** Every notice the app can show: a title and a detail, with placeholders where a value belongs. */
  notices: Object.freeze({
    formExpired: Object.freeze({
      title: "That form has expired",
      detail: "This page has been open a while. Reload it and try again.",
    }),
    keyInvalid: Object.freeze({
      title: "That is not a platform API key",
      detail:
        "Copy the key from Developers, then API credentials. It looks like kd_live_example_ followed by 64 characters.",
    }),
    installExpired: Object.freeze({
      title: "That install has expired",
      detail:
        "The shop's access token is no longer held by this app. Install the app again from your Shopify admin.",
    }),
    installUnmatched: Object.freeze({
      title: "That install could not be matched",
      detail: "The session this app started has expired. Install the app again from your Shopify admin.",
    }),
    connectionActivated: Object.freeze({
      title: "The shop is connected",
      detail: "The platform holds the shop's access token from here on. This app kept no copy and holds no key of yours.",
    }),
    connectionReused: Object.freeze({
      title: "This shop was already connected",
      detail: "The platform holds the shop's access token from here on. This app kept no copy and holds no key of yours.",
    }),
    statusAnswered: Object.freeze({
      title: "This shop's connection",
      detail: "The platform answered with the row it holds.",
    }),
    connectionRevoked: Object.freeze({
      title: "The connection is revoked",
      detail:
        "The platform keeps the row and refuses to reactivate it, which is what a final revocation means.",
    }),
    installRefused: Object.freeze({
      title: "Shopify's install request was not accepted",
      detail:
        "The request failed the {rule} check, so nothing was connected. Install the app again from your Shopify admin.",
    }),
    platformUnreachable: Object.freeze({
      title: "The platform did not accept that",
      detail: "The platform could not be reached. Nothing was changed, so it is safe to try again.",
    }),
    platformRefused: Object.freeze({
      title: "The platform did not accept that",
      detail: "The platform answered {status}. Nothing was changed.",
    }),
    platformRefusedWithRule: Object.freeze({
      title: "The platform did not accept that",
      detail: "The platform answered {status} ({rule}). Nothing was changed.",
    }),
    unexpected: Object.freeze({
      title: "The app could not finish that",
      detail: "Nothing was changed. Try again, and if it keeps happening contact support.",
    }),
  }),
});

/**
 * Substitute `{name}` placeholders in one catalog entry.
 *
 * A missing value becomes the empty string rather than the literal `{name}`: a page that says "the check" is better
 * than one that says "the {rule} check", and a silent hole is what the gate exists to catch anyway.
 */
export function fill(template, values = {}) {
  return String(template).replace(/\{([a-z]+)\}/gu, (_match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : "",
  );
}
