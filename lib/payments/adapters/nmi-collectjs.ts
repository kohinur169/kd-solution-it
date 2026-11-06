// path: lib/payments/adapters/nmi-collectjs.ts

/**
 * The NMI adapter's Collect.js token integration: the service that generates the Collect.js configuration
 * for payment pages and validates the payment tokens Collect.js returns.
 *
 * ## What Collect.js is
 *
 * Section 17 says "card data is collected only through Collect.js hosted fields
 * (https://secure.nmi.com/token/Collect.js), which returns a payment token to the browser." Collect.js
 * is NMI's hosted field solution. The browser loads a script from NMI's servers. The script renders
 * secure input fields for card number, expiry, and CVV. When the user types into those fields, the
 * card data goes directly to NMI — the platform's servers never see it. NMI returns a payment token to
 * the browser. The browser sends the token to the platform, and the platform uses it for payment
 * through the NMI API.
 *
 * Section 18 says "platform code and servers never read, store or track card data or keystrokes." This
 * file is the core service for that boundary. It generates the configuration the browser needs to
 * initialize Collect.js and validates the token Collect.js returns. It never handles card data.
 *
 * ## What this file is not
 *
 * It is not the Collect.js script itself or the hosted field UI (that is a browser-side concern). It is
 * not the NMI API client that uses the token for payment (STEP 150 owns that). It is not the payment
 * page component. This file is the core service: the config generation, the token validation, and the
 * Collect.js URLs.
 */

/** The Collect.js script URL. Loaded by the browser to render the hosted fields. */
export const COLLECT_JS_SCRIPT_URL = "https://secure.nmi.com/token/Collect.js";

/** The token types Collect.js can return. */
export type CollectJsTokenType = "card" | "bank" | "crypto";

/** A validated Collect.js payment token. */
export interface CollectJsToken {
  readonly token: string;
  readonly type: CollectJsTokenType;
}

/** A Collect.js configuration for a payment page. */
export interface NmiCollectJsConfig {
  readonly companyId: string;
  /** Public tokenization key only; never use a private API security key here. */
  readonly apiKey: string;
  readonly environment: "sandbox" | "production";
  readonly collectJsScriptUrl: string;
}

/** The result of generating a Collect.js configuration. */
export type GenerateCollectJsConfigResult =
  | { status: "generated"; config: NmiCollectJsConfig }
  | { status: "failed"; reason: string };

/** Generate a Collect.js configuration for a payment page. */
export function generateCollectJsConfig(
  companyId: string,
  options: {
    readonly apiKey: string;
    readonly environment: "sandbox" | "production";
  },
): GenerateCollectJsConfigResult {
  // 1. Validate.
  if (companyId.trim().length === 0) {
    return { status: "failed", reason: "the company id must not be empty" };
  }
  if (options.apiKey.trim().length === 0) {
    return { status: "failed", reason: "the API key must not be empty" };
  }

  // 2. Return the configuration. The browser uses this to initialize Collect.js.
  return {
    status: "generated",
    config: {
      companyId,
      apiKey: options.apiKey,
      environment: options.environment,
      collectJsScriptUrl: COLLECT_JS_SCRIPT_URL,
    },
  };
}

/** The result of validating a Collect.js token. */
export type ValidateTokenResult =
  | { status: "valid"; token: CollectJsToken }
  | { status: "failed"; reason: string };

/** Validate a Collect.js payment token: check it is non-empty, long enough, and alphanumeric. */
export function validateCollectJsToken(
  token: string,
  type: CollectJsTokenType,
): ValidateTokenResult {
  // 1. The token must not be empty.
  if (token.trim().length === 0) {
    return { status: "failed", reason: "the Collect.js token must not be empty" };
  }

  // 2. The token must be at least 10 characters. NMI tokens are long enough to be meaningful.
  if (token.length < 10) {
    return { status: "failed", reason: "the Collect.js token is too short" };
  }

  // 3. The token must contain only letters, digits, underscores and hyphens (NMI publishes hyphenated examples).
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    return { status: "failed", reason: "the Collect.js token contains invalid characters" };
  }

  return { status: "valid", token: { token, type } };
}
