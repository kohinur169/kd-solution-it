// path: lib/payments/adapters/nmi-collectjs-verify.ts
import process from "node:process";
import {
  generateCollectJsConfig,
  validateCollectJsToken,
  COLLECT_JS_SCRIPT_URL,
  COLLECT_JS_TOKEN_URL,
} from "./nmi-collectjs.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (condition) {
    checks++;
  } else {
    failures.push(description);
  }
}

/* ---- scenario 1: generating a Collect.js config with valid input ---- */

const config1 = generateCollectJsConfig("company-1", { apiKey: "api-key-123", environment: "sandbox" });

expect(config1.status === "generated", "generating a Collect.js config with valid input succeeds");
if (config1.status === "generated") {
  expect(config1.config.companyId === "company-1", "the config carries the right company");
  expect(config1.config.apiKey === "api-key-123", "the config carries the right API key");
  expect(config1.config.environment === "sandbox", "the config carries the right environment");
}

/* ---- scenario 2: the config carries the correct Collect.js URLs ---- */

if (config1.status === "generated") {
  expect(config1.config.collectJsScriptUrl === COLLECT_JS_SCRIPT_URL, "the config carries the Collect.js script URL");
  expect(config1.config.collectJsScriptUrl === "https://secure.nmi.com/token/Collect.js", "the script URL is the NMI Collect.js URL");
  expect(config1.config.collectJsTokenUrl === COLLECT_JS_TOKEN_URL, "the config carries the Collect.js token URL");
}

/* ---- scenario 3: the config URLs are the same for sandbox and production ---- */

const config3 = generateCollectJsConfig("company-1", { apiKey: "api-key-123", environment: "production" });
if (config3.status === "generated" && config1.status === "generated") {
  expect(config3.config.collectJsScriptUrl === config1.config.collectJsScriptUrl, "the script URL is the same for sandbox and production");
  expect(config3.config.collectJsTokenUrl === config1.config.collectJsTokenUrl, "the token URL is the same for sandbox and production");
  expect(config3.config.environment === "production", "the production config carries the production environment");
}

/* ---- scenario 4: empty company id is rejected ---- */

const emptyCompany = generateCollectJsConfig(" ", { apiKey: "api-key", environment: "sandbox" });
expect(emptyCompany.status === "failed", "an empty company id is rejected");

/* ---- scenario 5: empty API key is rejected ---- */

const emptyApiKey = generateCollectJsConfig("company-1", { apiKey: "  ", environment: "sandbox" });
expect(emptyApiKey.status === "failed", "an empty API key is rejected");

/* ---- scenario 6: validating a valid token returns valid ---- */

const validToken = validateCollectJsToken("tok_1234567890abcdef", "card");
expect(validToken.status === "valid", "a valid Collect.js token is accepted");
if (validToken.status === "valid") {
  expect(validToken.token.token === "tok_1234567890abcdef", "the validated token carries the right token string");
  expect(validToken.token.type === "card", "the validated token carries the right type");
}

/* ---- scenario 7: validating a bank token ---- */

const bankToken = validateCollectJsToken("bank_token_abcdef123456", "bank");
expect(bankToken.status === "valid", "a valid bank token is accepted");
if (bankToken.status === "valid") {
  expect(bankToken.token.type === "bank", "the bank token carries the right type");
}

/* ---- scenario 8: validating a crypto token ---- */

const cryptoToken = validateCollectJsToken("crypto_token_1234567890", "crypto");
expect(cryptoToken.status === "valid", "a valid crypto token is accepted");
if (cryptoToken.status === "valid") {
  expect(cryptoToken.token.type === "crypto", "the crypto token carries the right type");
}

/* ---- scenario 9: an empty token is rejected ---- */

const emptyToken = validateCollectJsToken("  ", "card");
expect(emptyToken.status === "failed", "an empty token is rejected");

/* ---- scenario 10: a too-short token is rejected ---- */

const shortToken = validateCollectJsToken("short", "card");
expect(shortToken.status === "failed", "a too-short token is rejected");

/* ---- scenario 11: a token with invalid characters is rejected ---- */

const badChars = validateCollectJsToken("tok_with_spaces!", "card");
expect(badChars.status === "failed", "a token with invalid characters is rejected");

/* ---- scenario 12: a token with special characters is rejected ---- */

const specialChars = validateCollectJsToken("tok_with_dashes-12345", "card");
expect(specialChars.status === "failed", "a token with dashes is rejected");

/* ---- scenario 13: multiple configs for different companies ---- */

const configA = generateCollectJsConfig("company-a", { apiKey: "api-a", environment: "sandbox" });
const configB = generateCollectJsConfig("company-b", { apiKey: "api-b", environment: "production" });

expect(configA.status === "generated" && configB.status === "generated", "two configs are generated for different companies");
if (configA.status === "generated" && configB.status === "generated") {
  expect(configA.config.companyId === "company-a", "config A carries the right company");
  expect(configB.config.companyId === "company-b", "config B carries the right company");
}

/* ---- scenario 14: the config is deterministic for the same input ---- */

const configDup1 = generateCollectJsConfig("company-1", { apiKey: "api-key", environment: "sandbox" });
const configDup2 = generateCollectJsConfig("company-1", { apiKey: "api-key", environment: "sandbox" });

if (configDup1.status === "generated" && configDup2.status === "generated") {
  expect(configDup1.config.apiKey === configDup2.config.apiKey, "the API key is the same for the same input");
  expect(configDup1.config.collectJsScriptUrl === configDup2.config.collectJsScriptUrl, "the script URL is the same for the same input");
}

/* ---- scenario 15: the Collect.js constants are correct ---- */

expect(COLLECT_JS_SCRIPT_URL === "https://secure.nmi.com/token/Collect.js", "the Collect.js script URL constant is correct");
expect(COLLECT_JS_TOKEN_URL === "https://secure.nmi.com/token/Collect.js", "the Collect.js token URL constant is correct");

/* ---- scenario 16: a 10-character token is accepted ---- */

const minToken = validateCollectJsToken("1234567890", "card");
expect(minToken.status === "valid", "a 10-character token is accepted");

/* ---- scenario 17: a 9-character token is rejected ---- */

const belowMin = validateCollectJsToken("123456789", "card");
expect(belowMin.status === "failed", "a 9-character token is rejected");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments NMI Collect.js gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments NMI Collect.js gate passed: ${checks} checks, a service that generates the Collect.js configuration for payment pages and validates the payment tokens Collect.js returns - the config carries the company, API key, environment, and Collect.js URLs, the token validation accepts valid alphanumeric tokens of 10+ characters for card, bank, and crypto types, and invalid tokens are rejected\n`,
);
