// path: plugins/shopify/kd-payments-app/src/screen.mjs
import { COPY, fill } from "./copy.mjs";

/**
 * The app's one screen, rendered as text and escaped at the boundary.
 *
 * ## Why the page is built here rather than by a template engine
 *
 * The page has three states and four forms, and every value in it is either a catalog entry or a value the platform
 * answered. A template engine would add a dependency and a second escaping rule; `escapeHtml` applied to every
 * interpolated value is one rule that can be read in a dozen lines and checked by the gate. Nothing in this file reads
 * a request, decides anything or touches a secret: the shop's token never reaches a page and is not an argument.
 *
 * ## Why the copy is not in this file
 *
 * Every sentence comes from `copy.mjs`, so this module cannot invent one and a reviewer reads all of them in one place.
 * The renderer owns only markup: elements, classes, attributes and the order things appear in.
 *
 * ## Widths, focus and the small screen
 *
 * The layout is fluid rather than fixed: full width, a `46rem` ceiling, padding in `rem`, inputs at `width: 100%` with
 * `box-sizing: border-box`, and one `@media` rule that folds the definition list into a single column below thirty
 * rems. Focus is drawn rather than removed - `:focus-visible` gets a visible ring - and long values break rather than
 * overflow. Those are the facts the gate can check; they were not measured in a browser in this environment, and the
 * handoff says so.
 *
 * ## Why the credential form asks for the key every time
 *
 * The app stores no merchant credential. The key is typed, sent to the platform with the shop and the token, and
 * discarded - so the screen says so, and a merchant who wants to check or revoke a connection types it again. That is
 * the whole security story of the screen: **this process holds one Shopify token for at most the session's life and no
 * merchant key at all**.
 */

/** The five characters that may never appear raw inside a document this app writes. */
const HTML_ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** Escape a value for element text and for a quoted attribute, which is why both quote characters are in the map. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character] ?? character);
}

/** The stages one page can be in. */
export const STAGES = Object.freeze({
  installRequired: "install_required",
  credentialsRequired: "credentials_required",
  connected: "connected",
  failed: "failed",
});

/** The one stylesheet, inline and static, so the page has no external request and the CSP can stay narrow. */
const STYLE = [
  "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#0b1020;color:#e7ecff}",
  "main{max-width:46rem;margin:0 auto;padding:2rem 1.25rem}",
  "h1{font-size:1.4rem;margin:0 0 .25rem}",
  "h2{font-size:1.05rem;margin:2rem 0 .5rem}",
  "p{line-height:1.5;margin:.5rem 0}",
  "code{background:#17203c;padding:.1rem .35rem;border-radius:.25rem}",
  ".muted{color:#9aa6cc}",
  ".panel{background:#121a33;border:1px solid #22305a;border-radius:.6rem;padding:1rem;margin:1rem 0}",
  ".error{border-color:#7a2740;background:#2a1220}",
  ".ok{border-color:#1f6f4a;background:#0f2a20}",
  "label{display:block;margin:.75rem 0 .25rem;font-size:.9rem}",
  "input{width:100%;box-sizing:border-box;padding:.55rem .6rem;border-radius:.4rem;border:1px solid #2c3a67;",
  "background:#0b1020;color:#e7ecff;min-height:2.75rem}",
  "button{margin-top:.9rem;padding:.55rem .9rem;border-radius:.4rem;border:0;background:#3d6bff;color:#fff;",
  "font-weight:600;cursor:pointer;min-height:2.75rem}",
  "button.secondary{background:#2a3560}",
  "input:focus-visible,button:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}",
  "dl{display:grid;grid-template-columns:11rem 1fr;gap:.35rem 1rem;margin:.5rem 0 0}",
  "dt{color:#9aa6cc}",
  "dd{margin:0;word-break:break-word}",
  "@media (max-width:30rem){main{padding:1.25rem .9rem}dl{grid-template-columns:1fr;gap:0}",
  "dt{margin-top:.6rem}}",
].join("");

/** A panel with a title and a body, so a notice and a form render the same way. */
function panel({ kind, title, body }) {
  const className = kind === undefined ? "panel" : `panel ${kind}`;

  return `<section class="${className}"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** The credential form: the only place a key is typed, and it is never given a value. */
function credentialForm({ csrf, shop, label, hint, action, submit }) {
  return [
    `<form method="post" action="${escapeHtml(action)}" autocomplete="off">`,
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
    `<input type="hidden" name="shop" value="${escapeHtml(shop)}">`,
    `<label for="api_key">${escapeHtml(label)}</label>`,
    `<input id="api_key" name="api_key" type="password" autocomplete="off" spellcheck="false" required>`,
    `<p class="muted">${escapeHtml(hint)}</p>`,
    `<button type="submit">${escapeHtml(submit)}</button>`,
    "</form>",
  ].join("");
}

/** The connection the platform answered, as a definition list. No field of it is a secret. */
function connectionList(connection) {
  const rows = [
    [COPY.fields.shop, connection.store_domain],
    [COPY.fields.status, connection.status],
    [COPY.fields.connectedAt, connection.connected_at ?? COPY.fields.notYet],
    [COPY.fields.storeId, connection.external_store_id ?? COPY.fields.assignedOnConnect],
    [COPY.fields.tokenEnding, connection.store_token_last_four],
    [COPY.fields.mode, connection.mode ?? COPY.fields.notReported],
  ];

  return [
    "<dl>",
    ...rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`),
    "</dl>",
  ].join("");
}

/**
 * The page.
 *
 * `notice` is the one thing this app says about the last form: a success message, or the platform's `{field, rule}`
 * pair rendered as the two machine words it is. `connection` is present only when the platform answered with one.
 */
export function renderPage({ stage, shop, csrf, notice, connection }) {
  const sections = [];

  if (notice !== undefined) {
    sections.push(
      panel({
        kind: notice.kind,
        title: notice.title,
        body: `<p>${escapeHtml(notice.detail)}</p>`,
      }),
    );
  }

  if (stage === STAGES.installRequired) {
    sections.push(
      panel({
        title: COPY.install.title,
        body:
          `<p>${escapeHtml(COPY.install.waiting)}</p>` +
          `<p class="muted">${escapeHtml(COPY.install.already)}</p>` +
          [
            '<form method="post" action="/status" autocomplete="off">',
            `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`,
            `<label for="shop">${escapeHtml(COPY.install.shopLabel)}</label>`,
            '<input id="shop" name="shop" type="text" ' +
              `placeholder="${escapeHtml(COPY.install.shopPlaceholder)}" ` +
              'autocomplete="off" spellcheck="false" required>',
            `<label for="api_key">${escapeHtml(COPY.install.keyLabel)}</label>`,
            '<input id="api_key" name="api_key" type="password" autocomplete="off" spellcheck="false" required>',
            `<button type="submit">${escapeHtml(COPY.install.submit)}</button>`,
            "</form>",
          ].join(""),
      }),
    );
  }

  if (stage === STAGES.credentialsRequired) {
    sections.push(
      panel({
        title: COPY.credentials.title,
        body:
          `<p>${escapeHtml(fill(COPY.credentials.body, { shop: shop ?? "" }))}</p>` +
          credentialForm({
            csrf,
            shop: shop ?? "",
            label: COPY.credentials.keyLabel,
            hint: COPY.credentials.hint,
            action: "/login",
            submit: COPY.credentials.submit,
          }),
      }),
    );
  }

  if (stage === STAGES.connected) {
    sections.push(
      panel({
        title: COPY.connected.title,
        body: connection === undefined ? `<p>${escapeHtml(COPY.connected.answer)}</p>` : connectionList(connection),
      }),
    );
    sections.push(
      panel({
        title: COPY.connected.disconnectTitle,
        body:
          `<p>${escapeHtml(COPY.connected.disconnectBody)}</p>` +
          credentialForm({
            csrf,
            shop: shop ?? "",
            label: COPY.connected.keyLabel,
            hint: COPY.credentials.hint,
            action: "/disconnect",
            submit: COPY.connected.submit,
          }),
      }),
    );
  }

  const shopLine =
    shop === undefined || shop.length === 0
      ? `<p class="muted">${escapeHtml(COPY.noShop)}</p>`
      : `<p class="muted">${escapeHtml(COPY.shopPrefix)} <code>${escapeHtml(shop)}</code></p>`;

  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(COPY.brand)}</title>`,
    `<style>${STYLE}</style>`,
    "</head><body><main>",
    `<h1>${escapeHtml(COPY.brand)}</h1>`,
    shopLine,
    ...sections,
    `<p class="muted">${escapeHtml(COPY.footer)}</p>`,
    "</main></body></html>",
  ].join("");
}

/** The five headers every answer carries, so a page is never framed, sniffed, cached or referred from. */
export const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});
