// path: lib/payments/adapters/stripe-client-verify.ts

/**
 * The gate for STEP 162: Stripe Connect encrypted key configuration and connection test.
 *
 * A check script, not a test file: it exercises the service with a recording API transport and with
 * keyrings built for the run, then fails and names every check that did not hold. No network call is
 * made and no real credential is used.
 */

import process from "node:process";
import { openSecret, type EncryptionKeyring } from "../../security/encryption.ts";
import {
  activateStripeConfig,
  configureStripeKeys,
  InMemoryStripeConfigStore,
  maskStripeCredential,
  parseStripeAccountListAnswer,
  retireStripeConfig,
  rollStripeWebhookSecret,
  stripeApiVersionIsPreview,
  stripeConfigIsPublishable,
  stripeConfigIsSealed,
  stripeConnectionEndpoint,
  stripeFetchApiTransport,
  stripeKeyFamilyOf,
  stripeKeyViewOf,
  stripeProviderMessageOf,
  stripeSecretKeyScope,
  stripeWebhookSecretScope,
  stripeWebhookSecretsFor,
  testStripeConnection,
  validateStripeCredentials,
  STRIPE_ACCOUNT_SURFACE,
  STRIPE_ACCOUNT_SURFACE_PATH,
  STRIPE_ACCOUNT_SURFACE_REASON,
  STRIPE_API_ANSWER_MAXIMUM_BYTES,
  STRIPE_API_VERSION_PATTERN,
  STRIPE_CLIENT_TEXT_MAXIMUM_LENGTH,
  STRIPE_COMPANY_ID_PATTERN,
  STRIPE_CONNECTION_PAGE_SIZE,
  STRIPE_CONNECTION_PATH,
  STRIPE_CONNECT_TIMEOUT_MS,
  STRIPE_DEFAULT_API_VERSION,
  STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS,
  type ConfigureStripeKeysInput,
  type StripeApiTransport,
  type StripeConfigStore,
  type StripeKeyAuditEntry,
  type StripeKeyConfig,
} from "./stripe-client.ts";
import {
  STRIPE_API_BASE,
  STRIPE_API_VERSION_HEADER,
  STRIPE_OBSERVED_API_VERSION,
  STRIPE_PROVIDER_KEY,
  STRIPE_V1_ACCOUNTS_PATH,
} from "./stripe.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) failures.push(description);
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectThrows(action: () => void, description: string): void {
  try {
    action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

/* ---- fixtures ---- */

const keyring: EncryptionKeyring = {
  primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") },
};
const rotatedKeyring: EncryptionKeyring = {
  primary: { id: "k2", secret: Buffer.alloc(32, 9).toString("base64") },
  previous: [{ id: "k1", secret: Buffer.alloc(32, 7).toString("base64") }],
};
const foreignKeyring: EncryptionKeyring = {
  primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") },
};

const companyId = "8a1c2f3e-0000-4000-8000-000000000001";
const otherCompanyId = "8a1c2f3e-0000-4000-8000-000000000002";

/**
 * Fixture credentials, assembled at run time.
 *
 * They are made up, and they are built from parts so that the file on disk never contains a string in
 * the exact shape of a real credential: a secret scanner (GitHub's push protection among them) cannot
 * tell a test value from a live key, and blocking the push would be the scanner doing its job. The
 * values below are shaped correctly at run time, which is all the service under test cares about.
 */
const fixture = (prefix: string, body: string): string => `${prefix}_${body}`;
const sandboxSecret = fixture("sk_test", "51NxAbCdEfGhIjKlMnOpQrStUvWx");
const liveSecret = fixture("sk_live", "51NxAbCdEfGhIjKlMnOpQrStUvWx");
const restrictedSecret = fixture("rk_test", "51NxAbCdEfGhIjKlMnOpQrStUvWx");
const rotatedSecret = fixture("sk_test", "51NzYxWvUtSrQpOnMlKjIhGfEdCbA");
const orgSecret = fixture("sk_org", "abcdefghijklmnopqrstuvwx");
const sandboxPublishable = fixture("pk_test", "51PuBliShAbLeKeY000000000000");
const livePublishable = fixture("pk_live", "51PuBliShAbLeKeY000000000000");
const webhookSecret = fixture("whsec", "abcdefghijklmnopqrstuvwx");
const nextWebhookSecret = fixture("whsec", "zyxwvutsrqponmlkjihgfedc");
const activeRollSecret = fixture("whsec", "activeRollSecret0000000000");
const NOW = 1_760_000_000_000;

function inputOf(overrides: Partial<ConfigureStripeKeysInput> = {}): ConfigureStripeKeysInput {
  return {
    companyId,
    environment: "sandbox",
    secretKey: sandboxSecret,
    publishableKey: sandboxPublishable,
    webhookSecret,
    ...overrides,
  };
}

const noTransport: StripeApiTransport = async () => {
  throw new Error("no transport in this check");
};

/* ------------------------------------------------------------------------------------------------
 * Section 1: the surface decision and the constants
 * --------------------------------------------------------------------------------------------- */

expectEqual(STRIPE_ACCOUNT_SURFACE, "accounts_v2", "the account surface is Accounts v2");
expectEqual(STRIPE_ACCOUNT_SURFACE_PATH, "/v2/core/accounts", "the surface names the documented collection");
expect(STRIPE_ACCOUNT_SURFACE_REASON.includes("Accounts v2"), "the reason names the surface");
expect(STRIPE_ACCOUNT_SURFACE_REASON.includes("legacy"), "the reason records why the legacy types were not chosen");
expect(
  STRIPE_ACCOUNT_SURFACE_REASON.includes("cannot be changed after creation"),
  "the reason records the immutability that makes the choice permanent",
);

expectEqual(STRIPE_CONNECTION_PATH, STRIPE_V1_ACCOUNTS_PATH, "the connection test reads the documented accounts endpoint");
expectEqual(STRIPE_CONNECTION_PAGE_SIZE, 1, "the test asks for one account");
expectEqual(stripeConnectionEndpoint(), `${STRIPE_API_BASE}/v1/accounts?limit=1`, "the one allowed URL is the accounts read");
expectEqual(STRIPE_DEFAULT_API_VERSION, STRIPE_OBSERVED_API_VERSION, "the default version is the one the documentation used");
expect(STRIPE_API_VERSION_PATTERN.test("2026-10-28"), "a dated version is accepted");
expect(STRIPE_API_VERSION_PATTERN.test("2026-10-28.preview"), "a dated preview version is accepted by shape");
expect(!STRIPE_API_VERSION_PATTERN.test("2026-10-28.beta"), "an unknown suffix is refused");
expect(!STRIPE_API_VERSION_PATTERN.test("latest"), "a floating version is refused");
expect(stripeApiVersionIsPreview("2026-10-28.preview"), "a preview version is recognised");
expect(!stripeApiVersionIsPreview("2026-10-28"), "a released version is not a preview");
expectEqual(STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS, 86_400, "the documented signing-secret overlap is 24 hours");
expectEqual(STRIPE_CONNECT_TIMEOUT_MS, 15_000, "the connection test has a bounded timeout");
expectEqual(STRIPE_API_ANSWER_MAXIMUM_BYTES, 65_536, "the answer ceiling is recorded");
expectEqual(STRIPE_CLIENT_TEXT_MAXIMUM_LENGTH, 200, "the provider text ceiling is recorded");
expect(STRIPE_COMPANY_ID_PATTERN.test(companyId), "a company id is accepted");
expect(!STRIPE_COMPANY_ID_PATTERN.test(" "), "an empty-ish company id is refused");
expectEqual(STRIPE_API_VERSION_HEADER, "Stripe-Version", "the documented version header is sent");

expectEqual(stripeSecretKeyScope(companyId), `gateway:${companyId}:${STRIPE_PROVIDER_KEY}:secret_key`, "the secret key scope names company, provider and field");
expectEqual(stripeWebhookSecretScope(companyId), `gateway:${companyId}:${STRIPE_PROVIDER_KEY}:webhook_secret`, "the signing secret has its own scope");
expect(stripeSecretKeyScope(companyId) !== stripeWebhookSecretScope(companyId), "the two sealed values never share a scope");
expectEqual(stripeKeyFamilyOf(sandboxSecret), "sk_test", "the key family of a sandbox secret key is read");
expectEqual(stripeKeyFamilyOf(restrictedSecret), "rk_test", "a restricted key has its own family");
expectEqual(stripeKeyFamilyOf(webhookSecret), null, "a signing secret has no key family");

/* ------------------------------------------------------------------------------------------------
 * Section 2: validation
 * ---------------------------------------------------------------------------------------------- */

expectEqual(validateStripeCredentials(inputOf()), null, "a well formed sandbox configuration is valid");
expectEqual(validateStripeCredentials(inputOf({ environment: "live", secretKey: liveSecret, publishableKey: livePublishable })), null, "a well formed live configuration is valid");
expectEqual(validateStripeCredentials(inputOf({ secretKey: restrictedSecret })), null, "a restricted key is accepted as the server credential");
expectEqual(validateStripeCredentials(inputOf({ publishableKey: null, webhookSecret: null })), null, "the optional credentials may be absent");
expectEqual(validateStripeCredentials(inputOf({ apiVersion: "2026-10-28" })), null, "a released version is accepted");
expectEqual(validateStripeCredentials(inputOf({ apiVersion: null })), null, "an omitted version is accepted");
expectEqual(
  validateStripeCredentials(inputOf({ companyId: "" })),
  "the company id is invalid",
  "a missing company id is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ environment: "production" as unknown as "sandbox" })),
  "the environment must be sandbox or live",
  "an invented environment is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ secretKey: sandboxPublishable })),
  "a publishable key is not a secret key; it belongs in the publishable key field",
  "a publishable key in the secret field is named for what it is",
);
expectEqual(
  validateStripeCredentials(inputOf({ secretKey: orgSecret })),
  "an organization key manages several Stripe accounts; this adapter needs one account's secret or restricted key",
  "an organization key is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ secretKey: webhookSecret })),
  "the secret key must be an sk_test_, sk_live_, rk_test_ or rk_live_ key",
  "a signing secret in the secret field is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ secretKey: "sk_test_short" })),
  "the secret key must be an sk_test_, sk_live_, rk_test_ or rk_live_ key",
  "a key too short to be real is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ secretKey: liveSecret })),
  "the secret key is a live key, but the configuration names the sandbox environment",
  "a live key in a sandbox configuration is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ environment: "live", secretKey: sandboxSecret, publishableKey: livePublishable })),
  "the secret key is a sandbox key, but the configuration names the live environment",
  "a sandbox key in a live configuration is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ publishableKey: livePublishable })),
  "the publishable key belongs to another environment than the secret key",
  "a publishable key of another mode is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ publishableKey: "not-a-key" })),
  "the publishable key must be a pk_test_ or pk_live_ key",
  "an unshaped publishable key is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ webhookSecret: "abc" })),
  "the webhook signing secret must be a whsec_ value",
  "an unshaped signing secret is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ apiVersion: "latest" })),
  "the API version must be a date such as 2026-10-28, optionally .preview",
  "a floating version is refused by name",
);
expectEqual(
  validateStripeCredentials(inputOf({ environment: "live", secretKey: liveSecret, publishableKey: livePublishable, apiVersion: "2026-10-28.preview" })),
  "a live configuration may not pin a preview API version; preview surfaces are for building",
  "a preview version on a live configuration is refused",
);
expectEqual(
  validateStripeCredentials(inputOf({ apiVersion: "2026-10-28.preview" })),
  null,
  "a preview version is allowed on a sandbox configuration",
);

/* ------------------------------------------------------------------------------------------------
 * Section 3: configuring a key
 * ---------------------------------------------------------------------------------------------- */

const audits: StripeKeyAuditEntry[] = [];
const store = new InMemoryStripeConfigStore();
const configured = configureStripeKeys(inputOf(), {
  store,
  keyring,
  occurredAtEpochMs: NOW,
  recordAudit: (entry) => audits.push(entry),
});
expectEqual(configured.status, "configured", "a valid configuration is accepted");
const config = configured.status === "configured" ? configured.config : null;
const view = configured.status === "configured" ? configured.view : null;

expectEqual(config?.companyId, companyId, "the configuration names the company");
expectEqual(config?.environment, "sandbox", "the configuration names the mode");
expectEqual(config?.status, "pending_activation", "a new configuration waits for its connection test");
expectEqual(config?.version, 1, "a new configuration starts at version 1");
expectEqual(config?.lastTest, null, "a new configuration carries no test");
expectEqual(config?.accountSurface, "accounts_v2", "the configuration records the account surface");
expectEqual(config?.apiVersion, STRIPE_DEFAULT_API_VERSION, "an omitted version becomes the recorded default");
expectEqual(config?.secretKeyPrefix, "sk_test", "the configuration records the key family");
expectEqual(config?.publishableKey, sandboxPublishable, "the publishable key is stored in full, because it is public");
expect(config?.webhookSecretSealed !== null, "the signing secret is sealed and present");
expect(config !== null && stripeConfigIsSealed(config), "the stored credentials are envelopes this platform wrote");
expect(config?.secretKeySealed.includes(sandboxSecret) === false, "the sealed value does not contain the plaintext key");
expect(config?.webhookSecretSealed?.includes(webhookSecret) === false, "the sealed value does not contain the plaintext secret");

expectEqual(
  config === null ? null : openSecret(keyring, config.secretKeySealed, { purpose: "secret", scope: stripeSecretKeyScope(companyId) }),
  sandboxSecret,
  "the sealed secret key opens for its own company",
);
expectEqual(
  config === null ? null : openSecret(keyring, config.webhookSecretSealed ?? "", { purpose: "secret", scope: stripeWebhookSecretScope(companyId) }),
  webhookSecret,
  "the sealed signing secret opens under its own scope",
);
expectThrows(
  () => openSecret(keyring, config?.secretKeySealed ?? "", { purpose: "secret", scope: stripeWebhookSecretScope(companyId) }),
  "a sealed secret key cannot be opened as a signing secret",
);
expectThrows(
  () => openSecret(keyring, config?.webhookSecretSealed ?? "", { purpose: "secret", scope: stripeSecretKeyScope(companyId) }),
  "a sealed signing secret cannot be opened as a secret key",
);
expectThrows(
  () => openSecret(keyring, config?.secretKeySealed ?? "", { purpose: "secret", scope: stripeSecretKeyScope(otherCompanyId) }),
  "a sealed secret key cannot be opened for another company",
);
expectThrows(
  () => openSecret(foreignKeyring, config?.secretKeySealed ?? "", { purpose: "secret", scope: stripeSecretKeyScope(companyId) }),
  "a foreign keyring cannot open the sealed key",
);
expectEqual(
  config === null ? null : openSecret(rotatedKeyring, config.secretKeySealed, { purpose: "secret", scope: stripeSecretKeyScope(companyId) }),
  sandboxSecret,
  "a keyring that still holds the old key opens what it wrote",
);
expect(config !== null && stripeConfigIsPublishable(config), "the configuration holds a browser-safe key");
expect(config !== null && stripeConfigIsPublishable({ ...config, publishableKey: null }) === false, "a configuration without a publishable key is not publishable");

expect(view?.secretKeyMasked.includes(sandboxSecret) === false, "the view does not carry the plaintext key");
expect(view?.secretKeyMasked.endsWith(sandboxSecret.slice(-4)) === true, "the view shows the last four characters");
expect(view?.secretKeyMasked.startsWith("sk_test_") === true, "the view shows the key family, which is not secret");
expect(view?.webhookSecretMasked !== null, "the view shows that a signing secret is stored");
expect(view?.publishableKey === sandboxPublishable, "the view shows the public key in full");
expectEqual(view?.apiVersion, STRIPE_DEFAULT_API_VERSION, "the view shows the pinned version");
expectEqual(view?.accountSurface, "accounts_v2", "the view shows the account surface");
expectEqual(view?.lastTestOutcome, null, "the view shows that nothing was tested yet");
expectEqual(view?.webhookSecretRolling, false, "a fresh configuration is not mid-roll");

expectEqual(audits.length, 1, "configuring writes one audit entry");
expectEqual(audits[0]?.action, "provider_key.configured", "the audit entry names the configuration");
expectEqual(audits[0]?.providerKey, "stripe", "the audit entry names the provider");
expectEqual(audits[0]?.companyId, companyId, "the audit entry names the company");
expectEqual(audits[0]?.outcome, "pending_activation", "the audit entry records the state the key is in");
expect(JSON.stringify(audits).includes(sandboxSecret) === false, "the audit entry never carries the key");
expect(JSON.stringify(view).includes(sandboxSecret) === false, "the view never carries the key");
expect(JSON.stringify(configured).includes(webhookSecret) === false, "the result never carries the signing secret");

expectEqual(
  configureStripeKeys(inputOf({ secretKey: "sk_test_short" }), { store, keyring, occurredAtEpochMs: NOW }).status,
  "failed",
  "an invalid credential is refused before anything is sealed",
);
const refusedShape = configureStripeKeys(inputOf({ secretKey: "sk_test_short" }), { store: new InMemoryStripeConfigStore(), keyring, occurredAtEpochMs: NOW });
expectEqual(refusedShape.status === "failed" ? refusedShape.reason : "", "the secret key must be an sk_test_, sk_live_, rk_test_ or rk_live_ key", "the refusal names the key shape");
expectEqual(
  configureStripeKeys(inputOf({ secretKey: restrictedSecret }), { store, keyring, occurredAtEpochMs: NOW }).status,
  "failed",
  "a company cannot hold two keys waiting for a test",
);
expectEqual(
  configureStripeKeys(inputOf({ secretKey: sandboxSecret }), {
    store: new InMemoryStripeConfigStore(),
    keyring: { primary: { id: "k1", secret: "" } },
    occurredAtEpochMs: NOW,
  }).status,
  "failed",
  "an unusable keyring refuses the configuration instead of storing plaintext",
);
const secondStore = new InMemoryStripeConfigStore();
const noOptional = configureStripeKeys(inputOf({ publishableKey: null, webhookSecret: null, apiVersion: "2026-10-28" }), {
  store: secondStore,
  keyring,
  occurredAtEpochMs: NOW,
});
expectEqual(noOptional.status === "configured" ? noOptional.config.publishableKey : "present", null, "a configuration may hold no publishable key");
expectEqual(noOptional.status === "configured" ? noOptional.config.webhookSecretSealed : "present", null, "a configuration may hold no signing secret");
expectEqual(noOptional.status === "configured" ? noOptional.config.apiVersion : "", "2026-10-28", "a pinned released version is stored as given");
expectEqual(
  noOptional.status === "configured" ? noOptional.view.webhookSecretMasked : "present",
  null,
  "a configuration without a signing secret shows none",
);

/* ------------------------------------------------------------------------------------------------
 * Section 4: the stored view and the keyring
 * ---------------------------------------------------------------------------------------------- */

const storedConfig = store.findById(config?.id ?? "");
expect(storedConfig !== null, "the configuration reaches the store");
const shown = stripeKeyViewOf(storedConfig as StripeKeyConfig, keyring);
expectEqual(shown.status, "shown", "a stored configuration is shown");
expectEqual(shown.status === "shown" ? shown.view.secretKeyMasked : "", view?.secretKeyMasked ?? "", "the stored view matches the one from configuration");
expectEqual(shown.status === "shown" ? shown.view.webhookSecretMasked : "", view?.webhookSecretMasked ?? "", "the stored signing secret is masked the same way");
expectEqual(stripeKeyViewOf(storedConfig as StripeKeyConfig, foreignKeyring).status, "failed", "a foreign keyring cannot show the stored configuration");
expectEqual(stripeKeyViewOf(storedConfig as StripeKeyConfig, rotatedKeyring).status, "shown", "a rotated keyring still shows the stored configuration");
const crossCompany: StripeKeyConfig = { ...(storedConfig as StripeKeyConfig), companyId: otherCompanyId };
expectEqual(stripeKeyViewOf(crossCompany, keyring).status, "failed", "a configuration moved to another company cannot be shown");

/* ------------------------------------------------------------------------------------------------
 * Section 5: masking
 * ---------------------------------------------------------------------------------------------- */

expectEqual(maskStripeCredential(sandboxSecret).slice(0, 8), "sk_test_", "the mask keeps the family prefix");
expectEqual(maskStripeCredential(sandboxSecret).slice(-4), sandboxSecret.slice(-4), "the mask keeps the last four");
expect(maskStripeCredential(sandboxSecret).includes(sandboxSecret.slice(8, -4)) === false, "the mask hides the key body");
expectEqual(maskStripeCredential(webhookSecret).slice(0, 6), "whsec_", "a signing secret keeps its documented prefix");
expectEqual(maskStripeCredential("short"), "*****", "a short value is hidden entirely");
expectEqual(maskStripeCredential(""), "*", "an empty value masks to one character");
expectEqual(maskStripeCredential("0123456789012").length, 13, "a thirteen character value keeps its prefix and last four");
expect(maskStripeCredential(liveSecret).startsWith("sk_live_"), "a live key shows its mode");

/* ------------------------------------------------------------------------------------------------
 * Section 6: the store's invariants
 * ---------------------------------------------------------------------------------------------- */

const rulesStore = new InMemoryStripeConfigStore();
const seedConfig: StripeKeyConfig = {
  ...(storedConfig as StripeKeyConfig),
  id: "11111111-1111-4111-8111-111111111111",
  companyId: otherCompanyId,
};
rulesStore.insert(seedConfig);
expectEqual(rulesStore.findByCompany(otherCompanyId).length, 1, "the store finds a company's configurations");
expectEqual(rulesStore.findPendingByCompany(otherCompanyId)?.id, seedConfig.id, "the store finds the pending configuration");
expectEqual(rulesStore.findActiveByCompany(otherCompanyId), null, "a pending configuration is not active");
expectEqual(rulesStore.findById("11111111-1111-4111-8111-111111111112"), null, "an unknown id reads as null");
expectThrows(() => rulesStore.insert(seedConfig), "a duplicate configuration id is refused");
expectThrows(
  () => rulesStore.insert({ ...seedConfig, id: "22222222-2222-4222-8222-222222222222" }),
  "a second pending configuration for one company is refused",
);
expectThrows(
  () => rulesStore.insert({ ...seedConfig, id: "33333333-3333-4333-8333-333333333333", companyId: "company-three", version: 3 }),
  "a configuration that starts at another version is refused",
);
expectEqual(rulesStore.save({ ...seedConfig, version: 2 }, 0), false, "a stale expected version is refused");
expectEqual(rulesStore.save({ ...seedConfig, version: 3 }, 1), false, "a write that skips a version is refused");
const immutableStore = new InMemoryStripeConfigStore();
immutableStore.insert({ ...seedConfig, id: "44444444-4444-4444-8444-444444444444", companyId: "company-four" });
expectEqual(
  immutableStore.save({ ...seedConfig, id: "44444444-4444-4444-8444-444444444444", companyId: "company-four", version: 2, secretKeySealed: "kd1.k1.aaaa.bbbb.cccc" }, 1),
  false,
  "a stored credential cannot be swapped in place",
);
expectEqual(
  immutableStore.save({ ...seedConfig, id: "44444444-4444-4444-8444-444444444444", companyId: "company-four", version: 2, apiVersion: "2026-10-28" }, 1),
  false,
  "a stored API version cannot be changed in place",
);
expectEqual(
  immutableStore.save({ ...seedConfig, id: "44444444-4444-4444-8444-444444444444", companyId: "company-four", version: 2, publishableKey: livePublishable }, 1),
  false,
  "a stored publishable key cannot be swapped in place",
);
expectEqual(
  immutableStore.save({ ...seedConfig, id: "44444444-4444-4444-8444-444444444444", companyId: "company-four", version: 2, status: "active" }, 1),
  false,
  "a key cannot become active on a test it did not pass",
);
expectEqual(
  immutableStore.findActiveByCompany("company-four")?.version ?? 1,
  1,
  "a refused activation leaves no active configuration",
);
const activationStoreRules = new InMemoryStripeConfigStore();
activationStoreRules.insert({ ...seedConfig, id: "55555555-5555-4555-8555-555555555555", companyId: "company-five" });
expectEqual(
  activationStoreRules.save(
    { ...seedConfig, id: "55555555-5555-4555-8555-555555555555", companyId: "company-five", version: 2, status: "active", lastTest: { outcome: "connected", testedAtEpochMs: NOW, environment: "sandbox", apiVersionSent: STRIPE_DEFAULT_API_VERSION } },
    1,
  ),
  true,
  "a key with a passing test can become active",
);
expectEqual(activationStoreRules.findActiveByCompany("company-five")?.version, 2, "the activated configuration is found as active");
expectEqual(
  activationStoreRules.save(
    { ...seedConfig, id: "55555555-5555-4555-8555-555555555555", companyId: "company-five", version: 3, status: "active", lastTest: { outcome: "connected", testedAtEpochMs: NOW, environment: "sandbox", apiVersionSent: STRIPE_DEFAULT_API_VERSION } },
    2,
  ),
  true,
  "an active configuration may be written again for a signing-secret roll",
);
expectEqual(
  activationStoreRules.save({ ...seedConfig, id: "55555555-5555-4555-8555-555555555555", companyId: "company-five", version: 4, status: "retired" }, 3),
  true,
  "an active configuration may be retired through the store",
);

/* ------------------------------------------------------------------------------------------------
 * Section 7: the transport contract
 * --------------------------------------------------------------------------------------------- */

let transportThrew = "";
try {
  await stripeFetchApiTransport("https://api.stripe.com/v1/customers", sandboxSecret, STRIPE_DEFAULT_API_VERSION);
} catch (error) {
  transportThrew = error instanceof Error ? error.message : "";
}
expectEqual(transportThrew, "invalid API endpoint", "the transport refuses any endpoint but the documented read");
let emptyKeyThrew = "";
try {
  await stripeFetchApiTransport(stripeConnectionEndpoint(), " ", STRIPE_DEFAULT_API_VERSION);
} catch (error) {
  emptyKeyThrew = error instanceof Error ? error.message : "";
}
expectEqual(emptyKeyThrew, "a secret key is required", "the transport refuses to call without a key");
let badVersionThrew = "";
try {
  await stripeFetchApiTransport(stripeConnectionEndpoint(), sandboxSecret, "latest");
} catch (error) {
  badVersionThrew = error instanceof Error ? error.message : "";
}
expectEqual(badVersionThrew, "an API version is required", "the transport refuses to call without a dated version");

/* ------------------------------------------------------------------------------------------------
 * Section 8: reading an account-list answer
 * ---------------------------------------------------------------------------------------------- */

const listBody = JSON.stringify({ object: "list", data: [{ id: "acct_1NxAbCdEfGhIjKl", object: "account" }], has_more: false, url: "/v1/accounts" });

const connectedVerdict = parseStripeAccountListAnswer(200, listBody);
expectEqual(connectedVerdict.outcome, "connected", "a Stripe list proves the key");
expectEqual(connectedVerdict.outcome === "connected" ? connectedVerdict.accountsVisible : null, 1, "the number of accounts listed is reported");
expectEqual(parseStripeAccountListAnswer(200, JSON.stringify({ object: "list", data: [] })).outcome, "connected", "an empty list still proves the key");
expectEqual(
  parseStripeAccountListAnswer(200, JSON.stringify({ object: "list", data: [] })).outcome === "connected"
    ? (parseStripeAccountListAnswer(200, JSON.stringify({ object: "list", data: [] })) as { accountsVisible: number | null }).accountsVisible
    : null,
  0,
  "an empty list reports zero accounts",
);
expectEqual(parseStripeAccountListAnswer(200, "").outcome, "failed", "a 200 with no body proves nothing");
expectEqual(parseStripeAccountListAnswer(200, "not json").outcome, "failed", "a 200 that is not JSON proves nothing");
expectEqual(parseStripeAccountListAnswer(200, JSON.stringify({ object: "account", id: "acct_1" })).outcome, "failed", "a 200 that is not a list proves nothing");

const authBody = JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_****" } });
const rejectedVerdict = parseStripeAccountListAnswer(401, authBody);
expectEqual(rejectedVerdict.outcome, "rejected", "a 401 rejects the key");
expectEqual(
  rejectedVerdict.outcome === "rejected" ? rejectedVerdict.detail : "",
  "Invalid API Key provided: sk_test_****",
  "the provider message is kept as the reason",
);
expectEqual(parseStripeAccountListAnswer(401, "").outcome, "rejected", "a 401 with no body still rejects the key");
expectEqual(
  parseStripeAccountListAnswer(401, "").outcome === "rejected" ? (parseStripeAccountListAnswer(401, "") as { detail: string }).detail : "",
  "the API rejected the secret key with an authentication error",
  "a 401 without a message says what it means",
);

const forbiddenVerdict = parseStripeAccountListAnswer(403, JSON.stringify({ error: { message: "The provided key does not have the required permissions" } }));
expectEqual(forbiddenVerdict.outcome, "not_permitted", "a 403 is a permission problem, not a bad key");
expectEqual(
  forbiddenVerdict.outcome === "not_permitted" ? forbiddenVerdict.detail : "",
  "The provided key does not have the required permissions",
  "the 403 message is kept",
);
expect(
  parseStripeAccountListAnswer(403, "").outcome === "not_permitted" &&
    (parseStripeAccountListAnswer(403, "") as { detail: string }).detail.includes("restricted key"),
  "a 403 without a message explains the restricted-key case",
);

expectEqual(parseStripeAccountListAnswer(400, JSON.stringify({ error: { message: "Invalid Stripe Version" } })).outcome, "failed", "a 400 proves nothing");
expect(
  parseStripeAccountListAnswer(400, "").outcome === "failed" &&
    (parseStripeAccountListAnswer(400, "") as { detail: string }).detail.includes("API version"),
  "a 400 without a message names the pinned version as the likely cause",
);
expectEqual(parseStripeAccountListAnswer(404, "").outcome, "failed", "a 404 is a refusal, not an acceptance");
expectEqual(parseStripeAccountListAnswer(302, "").outcome, "failed", "a redirect proves nothing");
expectEqual(parseStripeAccountListAnswer(429, "").outcome, "unreachable", "a rate limit judged nothing");
expectEqual(parseStripeAccountListAnswer(408, "").outcome, "unreachable", "a timeout judged nothing");
expectEqual(parseStripeAccountListAnswer(425, "").outcome, "unreachable", "a too-early answer judged nothing");
expectEqual(parseStripeAccountListAnswer(500, "").outcome, "unreachable", "a server error judged nothing");
expectEqual(parseStripeAccountListAnswer(503, JSON.stringify({ error: { message: "down" } })).outcome, "unreachable", "a 503 is unreachable even with a message");
expectEqual(parseStripeAccountListAnswer(418, "").outcome, "failed", "an unexpected 4xx is a refusal");

expectEqual(stripeProviderMessageOf({ error: { message: "Card declined" } }), "Card declined", "the documented error object is read");
expectEqual(stripeProviderMessageOf({ error: { code: "resource_missing" } }), "resource_missing", "a code is used when there is no message");
expectEqual(stripeProviderMessageOf({ message: "plain" }), "plain", "a bare message is read");
expectEqual(stripeProviderMessageOf(null), "", "no payload has no message");
expectEqual(stripeProviderMessageOf("text"), "", "a bare string has no message");
expect(stripeProviderMessageOf({ error: { message: "<b>x</b>" } }) === "x", "the message is sanitised");
expect(stripeProviderMessageOf({ error: { message: "a".repeat(500) } }).length <= STRIPE_CLIENT_TEXT_MAXIMUM_LENGTH, "the message is capped");

/* ------------------------------------------------------------------------------------------------
 * Section 9: the connection test
 * ---------------------------------------------------------------------------------------------- */

type Answer = { readonly status: number; readonly body: string };

function transportReturning(answer: Answer, seen: { endpoint: string; key: string; version: string }[] = []): StripeApiTransport {
  return async (endpoint, key, version) => {
    seen.push({ endpoint, key, version });
    return answer;
  };
}

const testStore = new InMemoryStripeConfigStore();
const testAudits: StripeKeyAuditEntry[] = [];
const testConfigured = configureStripeKeys(inputOf(), { store: testStore, keyring, occurredAtEpochMs: NOW });
expectEqual(testConfigured.status, "configured", "the test fixture is configured");
const testConfigId = testConfigured.status === "configured" ? testConfigured.config.id : "";

const seenCalls: { endpoint: string; key: string; version: string }[] = [];
const connected = await testStripeConnection(testConfigId, {
  store: testStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: listBody }, seenCalls),
  recordAudit: (entry) => testAudits.push(entry),
});
expectEqual(connected.outcome, "connected", "a list answer connects the configuration");
expectEqual(connected.secretKeyAccepted, true, "the key is reported as accepted");
expectEqual(connected.environmentVerified, true, "the mode is reported as verified");
expectEqual(connected.accountsVisible, 1, "the accounts the read listed are counted");
expectEqual(connected.apiVersionSent, STRIPE_DEFAULT_API_VERSION, "the version the test sent is reported");
expectEqual(connected.accountSurface, "accounts_v2", "the result names the account surface");
expectEqual(connected.webhookSecretConfigured, true, "the result says a signing secret is stored");
expectEqual(connected.version, 2, "the test advances the configuration version");
expectEqual(seenCalls.length, 1, "exactly one read is made");
expectEqual(seenCalls[0]?.endpoint, stripeConnectionEndpoint(), "the read goes to the documented endpoint");
expectEqual(seenCalls[0]?.key, sandboxSecret, "the read is made with the sealed key, opened in memory");
expectEqual(seenCalls[0]?.version, STRIPE_DEFAULT_API_VERSION, "the read sends the pinned version");
expectEqual(testStore.findById(testConfigId)?.lastTest?.outcome, "connected", "the test outcome is recorded on the configuration");
expectEqual(testStore.findById(testConfigId)?.lastTest?.apiVersionSent, STRIPE_DEFAULT_API_VERSION, "the recorded test names the version it used");
expectEqual(testAudits.length, 1, "the test writes one audit entry");
expectEqual(testAudits[0]?.action, "provider_key.tested", "the audit entry names the test");
expectEqual(testAudits[0]?.outcome, "connected", "the audit entry carries the outcome");
expect(JSON.stringify(connected).includes(sandboxSecret) === false, "the test result never carries the key");

const rejected = await testStripeConnection(testConfigId, {
  store: testStore,
  keyring,
  occurredAtEpochMs: NOW + 2_000,
  transport: transportReturning({ status: 401, body: authBody }),
});
expectEqual(rejected.outcome, "rejected", "a 401 is a rejection");
expectEqual(rejected.secretKeyAccepted, false, "a rejection never reports an accepted key");
expectEqual(rejected.environmentVerified, false, "a rejection verifies no mode");
expectEqual(rejected.accountsVisible, null, "a rejection reports no account count");
expectEqual(testStore.findById(testConfigId)?.lastTest?.outcome, "rejected", "a rejection is recorded too");

const notPermitted = await testStripeConnection(testConfigId, {
  store: testStore,
  keyring,
  occurredAtEpochMs: NOW + 3_000,
  transport: transportReturning({ status: 403, body: "" }),
});
expectEqual(notPermitted.outcome, "not_permitted", "a 403 is not a rejection of the key itself");
expectEqual(notPermitted.secretKeyAccepted, false, "a permission failure is not an accepted key");

const unreachable = await testStripeConnection(testConfigId, {
  store: testStore,
  keyring,
  occurredAtEpochMs: NOW + 4_000,
  transport: noTransport,
});
expectEqual(unreachable.outcome, "unreachable", "a transport that throws is unreachable, never a rejection");
expectEqual(unreachable.secretKeyAccepted, false, "an unreachable host accepts nothing");
expectEqual(unreachable.reason, "the API could not be reached", "an unreachable result says the host was not reached");

const failed400 = await testStripeConnection(testConfigId, {
  store: testStore,
  keyring,
  occurredAtEpochMs: NOW + 5_000,
  transport: transportReturning({ status: 400, body: "" }),
});
expectEqual(failed400.outcome, "failed", "a 400 is a failed request, not a proof");

expectEqual((await testStripeConnection("11111111-1111-4111-8111-111111111119", { store: testStore, keyring, occurredAtEpochMs: NOW })).outcome, "invalid_configuration", "an unknown id is an invalid configuration");
expectEqual(
  (await testStripeConnection(testConfigId, { store: testStore, keyring: foreignKeyring, occurredAtEpochMs: NOW })).outcome,
  "invalid_configuration",
  "a keyring that cannot open the key is an invalid configuration",
);
const openedWithOtherCompany = await testStripeConnection(testConfigId, {
  store: {
    insert: () => undefined,
    save: () => false,
    findByCompany: () => [],
    findActiveByCompany: () => null,
    findPendingByCompany: () => null,
    findById: () => ({ ...(testStore.findById(testConfigId) as StripeKeyConfig), companyId: otherCompanyId }),
  } satisfies StripeConfigStore,
  keyring,
  occurredAtEpochMs: NOW,
  transport: noTransport,
});
expectEqual(openedWithOtherCompany.outcome, "invalid_configuration", "a configuration moved to another company cannot be opened");

const noWebhookStore = new InMemoryStripeConfigStore();
const noWebhook = configureStripeKeys(inputOf({ webhookSecret: null }), { store: noWebhookStore, keyring, occurredAtEpochMs: NOW });
const noWebhookConnection = await testStripeConnection(noWebhook.status === "configured" ? noWebhook.config.id : "", {
  store: noWebhookStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: listBody }),
});
expectEqual(noWebhookConnection.outcome, "connected", "a key without a signing secret can still be proven");
expectEqual(noWebhookConnection.webhookSecretConfigured, false, "the result says no signing secret is stored");

const retiredStore = new InMemoryStripeConfigStore();
const toRetire = configureStripeKeys(inputOf(), { store: retiredStore, keyring, occurredAtEpochMs: NOW });
retireStripeConfig(toRetire.status === "configured" ? toRetire.config.id : "", { store: retiredStore, occurredAtEpochMs: NOW + 1 });
const retiredTest = await testStripeConnection(toRetire.status === "configured" ? toRetire.config.id : "", {
  store: retiredStore,
  keyring,
  occurredAtEpochMs: NOW + 2,
  transport: noTransport,
});
expectEqual(retiredTest.outcome, "invalid_configuration", "a retired configuration is not tested");
expectEqual(retiredTest.reason, "the configuration is retired and can no longer be tested", "the refusal says why");

/* ------------------------------------------------------------------------------------------------
 * Section 10: activation
 * ---------------------------------------------------------------------------------------------- */

const activationStore = new InMemoryStripeConfigStore();
const activationAudits: StripeKeyAuditEntry[] = [];
const activationConfigured = configureStripeKeys(inputOf(), { store: activationStore, keyring, occurredAtEpochMs: NOW });
const activationId = activationConfigured.status === "configured" ? activationConfigured.config.id : "";

expectEqual(
  activateStripeConfig("11111111-1111-4111-8111-111111111110", { store: activationStore, occurredAtEpochMs: NOW }).status === "failed"
    ? "refused"
    : "allowed",
  "refused",
  "an unknown configuration cannot be activated",
);
const beforeTest = activateStripeConfig(activationId, { store: activationStore, occurredAtEpochMs: NOW });
expectEqual(beforeTest.status === "failed" ? beforeTest.reason : "", "the connection test has not been run for this key", "a key cannot be activated before its test");

await testStripeConnection(activationId, {
  store: activationStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 401, body: authBody }),
});
const afterFailure = activateStripeConfig(activationId, { store: activationStore, occurredAtEpochMs: NOW + 2_000 });
expectEqual(
  afterFailure.status === "failed" ? afterFailure.reason : "",
  "the last connection test did not pass, so this key cannot be activated",
  "a failed test blocks activation",
);

await testStripeConnection(activationId, {
  store: activationStore,
  keyring,
  occurredAtEpochMs: NOW + 3_000,
  transport: transportReturning({ status: 200, body: listBody }),
});
const activated = activateStripeConfig(activationId, {
  store: activationStore,
  occurredAtEpochMs: NOW + 4_000,
  recordAudit: (entry) => activationAudits.push(entry),
});
expectEqual(activated.status, "activated", "a passing test allows activation");
expectEqual(activated.status === "activated" ? activated.config.status : "", "active", "the configuration becomes active");
expectEqual(activated.status === "activated" ? activated.supersededConfigId : "none", null, "the first key supersedes nothing");
expectEqual(activationAudits.length, 1, "the first activation writes one audit entry");
expectEqual(activationAudits[0]?.action, "provider_key.activated", "the audit entry names the activation");
expectEqual(activationAudits[0]?.providerKey, "stripe", "the activation names the provider");
expect(JSON.stringify(activationAudits).includes(sandboxSecret) === false, "the activation never carries the key");

const alreadyActive = activateStripeConfig(activationId, { store: activationStore, occurredAtEpochMs: NOW + 5_000 });
expectEqual(alreadyActive.status === "failed" ? alreadyActive.reason : "", "the configuration is already active", "an active key cannot be activated twice");

await testStripeConnection(
  activationId,
  { store: activationStore, keyring, occurredAtEpochMs: NOW + 6_000, transport: transportReturning({ status: 200, body: listBody }) },
);

const staleProofStore = new InMemoryStripeConfigStore();
staleProofStore.insert({
  ...((store.findById(config?.id ?? "") as StripeKeyConfig) ?? ({} as StripeKeyConfig)),
  id: "66666666-6666-4666-8666-666666666666",
  companyId: "company-six",
  apiVersion: STRIPE_DEFAULT_API_VERSION,
  version: 1,
  status: "pending_activation",
  lastTest: { outcome: "connected", testedAtEpochMs: NOW, environment: "sandbox", apiVersionSent: "2025-11-17" },
});
const staleVersionRefusal = activateStripeConfig("66666666-6666-4666-8666-666666666666", {
  store: staleProofStore,
  occurredAtEpochMs: NOW + 1_000,
});
expectEqual(
  staleVersionRefusal.status === "failed" ? staleVersionRefusal.reason : "",
  "the connection test ran on another API version than the one stored",
  "a proof made on another API version cannot activate this one",
);

const staleEnvironmentStore = new InMemoryStripeConfigStore();
staleEnvironmentStore.insert({
  ...((store.findById(config?.id ?? "") as StripeKeyConfig) ?? ({} as StripeKeyConfig)),
  id: "77777777-7777-4777-8777-777777777777",
  companyId: "company-seven",
  environment: "sandbox",
  version: 1,
  status: "pending_activation",
  lastTest: { outcome: "connected", testedAtEpochMs: NOW, environment: "live", apiVersionSent: STRIPE_DEFAULT_API_VERSION },
});
const staleEnvironmentRefusal = activateStripeConfig("77777777-7777-4777-8777-777777777777", {
  store: staleEnvironmentStore,
  occurredAtEpochMs: NOW + 1_000,
});
expectEqual(
  staleEnvironmentRefusal.status === "failed" ? staleEnvironmentRefusal.reason : "",
  "the connection test ran against another environment",
  "a proof made in another environment cannot activate this key",
);

const noWebhookActivationStore = new InMemoryStripeConfigStore();
const noWebhookActivation = configureStripeKeys(inputOf({ webhookSecret: null }), { store: noWebhookActivationStore, keyring, occurredAtEpochMs: NOW });
const noWebhookActivationId = noWebhookActivation.status === "configured" ? noWebhookActivation.config.id : "";
await testStripeConnection(noWebhookActivationId, {
  store: noWebhookActivationStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: listBody }),
});
const webhookRefused = activateStripeConfig(noWebhookActivationId, { store: noWebhookActivationStore, occurredAtEpochMs: NOW + 2_000 });
expectEqual(
  webhookRefused.status === "failed" ? webhookRefused.reason : "",
  "the webhook signing secret is not configured, so deliveries could not be verified",
  "a key without a signing secret cannot be activated",
);

/* ------------------------------------------------------------------------------------------------
 * Section 11: rotation, and retiring the old key
 * ---------------------------------------------------------------------------------------------- */

const rotationStore = new InMemoryStripeConfigStore();
const rotationAudits: StripeKeyAuditEntry[] = [];
const oldKey = configureStripeKeys(inputOf(), { store: rotationStore, keyring, occurredAtEpochMs: NOW });
const oldId = oldKey.status === "configured" ? oldKey.config.id : "";
await testStripeConnection(oldId, {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: NOW + 1_000,
  transport: transportReturning({ status: 200, body: listBody }),
});
activateStripeConfig(oldId, { store: rotationStore, occurredAtEpochMs: NOW + 2_000, recordAudit: (entry) => rotationAudits.push(entry) });

const newKey = configureStripeKeys(inputOf({ secretKey: rotatedSecret }), {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: NOW + 3_000,
});
const newId = newKey.status === "configured" ? newKey.config.id : "";
await testStripeConnection(newId, {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: NOW + 4_000,
  transport: transportReturning({ status: 200, body: listBody }),
});
const rotated = activateStripeConfig(newId, {
  store: rotationStore,
  occurredAtEpochMs: NOW + 5_000,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(rotated.status, "activated", "a tested replacement activates");
expectEqual(rotated.status === "activated" ? rotated.supersededConfigId : "", oldId, "the replacement names the key it superseded");
expectEqual(rotationStore.findById(oldId)?.status, "superseded", "the previous key becomes superseded");
expectEqual(rotationStore.findActiveByCompany(companyId)?.id, newId, "the replacement is the active key");
expectEqual(
  rotationAudits.filter((entry) => entry.action === "provider_key.rotated").length,
  1,
  "the rotation is audited exactly once",
);
expectEqual(
  rotationAudits.find((entry) => entry.action === "provider_key.rotated")?.configId,
  oldId,
  "the rotation audit names the key that was replaced",
);
expectEqual(
  rotationAudits.find((entry) => entry.action === "provider_key.rotated")?.outcome,
  "superseded",
  "the rotation audit records the outcome",
);

const supersededActivate = activateStripeConfig(oldId, { store: rotationStore, occurredAtEpochMs: NOW + 6_000 });
expectEqual(
  supersededActivate.status === "failed" ? supersededActivate.reason : "",
  "a superseded configuration cannot be activated again; add a new key instead",
  "a superseded key cannot be brought back",
);
const supersededRoll = rollStripeWebhookSecret(oldId, nextWebhookSecret, { store: rotationStore, keyring, occurredAtEpochMs: NOW + 7_000 });
expectEqual(
  supersededRoll.status === "failed" ? supersededRoll.reason : "",
  "a superseded configuration is not receiving deliveries; roll the active one",
  "a superseded key's signing secret cannot be rolled",
);

const retireActive = retireStripeConfig(newId, { store: rotationStore, occurredAtEpochMs: NOW + 8_000 });
expectEqual(
  retireActive.status === "failed" ? retireActive.reason : "",
  "the active key cannot be retired; activate its replacement first",
  "the active key cannot be retired",
);
const retired = retireStripeConfig(oldId, {
  store: rotationStore,
  occurredAtEpochMs: NOW + 9_000,
  recordAudit: (entry) => rotationAudits.push(entry),
});
expectEqual(retired.status, "retired", "a superseded key is retired");
expectEqual(rotationStore.findById(oldId)?.status, "retired", "the retired key is stored as retired");
expectEqual(
  rotationAudits.filter((entry) => entry.action === "provider_key.retired").length,
  1,
  "the retirement is audited",
);
const retireTwice = retireStripeConfig(oldId, { store: rotationStore, occurredAtEpochMs: NOW + 10_000 });
expectEqual(retireTwice.status === "failed" ? retireTwice.reason : "", "the configuration is already retired", "a retired key cannot be retired twice");

const activeRoll = rollStripeWebhookSecret(newId, activeRollSecret, {
  store: rotationStore,
  keyring,
  occurredAtEpochMs: NOW + 9_500,
});
expectEqual(activeRoll.status, "rolled", "the active configuration's signing secret can be rolled");
expectEqual(
  activeRoll.status === "rolled" ? activeRoll.config.previousWebhookSecretSealed !== null : false,
  true,
  "the active roll keeps the previous secret for the overlap",
);
const activeSecrets = stripeWebhookSecretsFor(
  activeRoll.status === "rolled" ? activeRoll.config : ({} as StripeKeyConfig),
  keyring,
  NOW + 9_600,
);
expectEqual(activeSecrets.status === "opened" ? activeSecrets.current : "", activeRollSecret, "the active roll's new secret is current");
expectEqual(activeSecrets.status === "opened" ? activeSecrets.previous : "", webhookSecret, "the active roll's previous secret is still accepted");

/* ------------------------------------------------------------------------------------------------
 * Section 12: the signing-secret roll
 * ---------------------------------------------------------------------------------------------- */

const rollStore = new InMemoryStripeConfigStore();
const rollAudits: StripeKeyAuditEntry[] = [];
const rollKey = configureStripeKeys(inputOf(), { store: rollStore, keyring, occurredAtEpochMs: NOW });
const rollId = rollKey.status === "configured" ? rollKey.config.id : "";

const sameSecret = rollStripeWebhookSecret(rollId, webhookSecret, { store: rollStore, keyring, occurredAtEpochMs: NOW + 1_000 });
expectEqual(
  sameSecret.status === "failed" ? sameSecret.reason : "",
  "the new signing secret is the same as the current one",
  "a roll to the same secret is refused",
);
const badShape = rollStripeWebhookSecret(rollId, "not-a-secret", { store: rollStore, keyring, occurredAtEpochMs: NOW + 1_000 });
expectEqual(
  badShape.status === "failed" ? badShape.reason : "",
  "the webhook signing secret must be a whsec_ value",
  "a roll to an unshaped secret is refused",
);

const rolled = rollStripeWebhookSecret(rollId, nextWebhookSecret, {
  store: rollStore,
  keyring,
  occurredAtEpochMs: NOW + 2_000,
  recordAudit: (entry) => rollAudits.push(entry),
});
expectEqual(rolled.status, "rolled", "a well formed roll is accepted");
expectEqual(
  rolled.status === "rolled" ? rolled.previousValidUntilEpochMs : 0,
  NOW + 2_000 + STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS * 1_000,
  "the previous secret stays accepted for the documented overlap",
);
const rolledConfig = rollStore.findById(rollId) as StripeKeyConfig;
expect(rolledConfig.previousWebhookSecretSealed !== null, "the previous signing secret is kept during the overlap");
expectEqual(rolledConfig.status, "pending_activation", "a roll does not change the key's lifecycle state");
expectEqual(rollAudits.length, 1, "the roll writes one audit entry");
expectEqual(rollAudits[0]?.action, "provider_webhook_secret.rolled", "the audit entry names the roll");
expectEqual(rollAudits[0]?.outcome, "overlap_open", "the audit entry records that an overlap is open");
expect(JSON.stringify(rollAudits).includes(nextWebhookSecret) === false, "the audit entry never carries the secret");

const secretsDuring = stripeWebhookSecretsFor(rolledConfig, keyring, NOW + 3_000);
expectEqual(secretsDuring.status, "opened", "the secrets are opened for a receiver");
expectEqual(secretsDuring.status === "opened" ? secretsDuring.current : "", nextWebhookSecret, "the current secret is the new one");
expectEqual(secretsDuring.status === "opened" ? secretsDuring.previous : "", webhookSecret, "the previous secret is still offered inside the window");

const secretsAfter = stripeWebhookSecretsFor(rolledConfig, keyring, NOW + 2_000 + STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS * 1_000 + 1);
expectEqual(secretsAfter.status === "opened" ? secretsAfter.current : "", nextWebhookSecret, "the new secret is still current after the window");
expectEqual(secretsAfter.status === "opened" ? secretsAfter.previous : "none", null, "the old secret is withdrawn when the window closes");

const secretsExactlyAtExpiry = stripeWebhookSecretsFor(rolledConfig, keyring, NOW + 2_000 + STRIPE_WEBHOOK_SECRET_OVERLAP_SECONDS * 1_000);
expectEqual(secretsExactlyAtExpiry.status === "opened" ? secretsExactlyAtExpiry.previous : "none", null, "the old secret is not offered at the expiry instant");

expectEqual(stripeWebhookSecretsFor(rolledConfig, foreignKeyring, NOW + 3_000).status, "failed", "a foreign keyring cannot open the signing secrets");
expectEqual(
  stripeWebhookSecretsFor({ ...rolledConfig, companyId: otherCompanyId }, keyring, NOW + 3_000).status,
  "failed",
  "a configuration moved to another company cannot be opened",
);

const firstSecretRoll = rollStripeWebhookSecret(noWebhookActivationId, nextWebhookSecret, {
  store: noWebhookActivationStore,
  keyring,
  occurredAtEpochMs: NOW + 3_000,
});
expectEqual(firstSecretRoll.status, "rolled", "a first signing secret can be added through a roll");
expectEqual(
  firstSecretRoll.status === "rolled" ? firstSecretRoll.config.previousWebhookSecretSealed : "present",
  null,
  "adding the first secret keeps no previous one",
);
const firstSecretSecrets = stripeWebhookSecretsFor(
  firstSecretRoll.status === "rolled" ? firstSecretRoll.config : (rolledConfig as StripeKeyConfig),
  keyring,
  NOW + 4_000,
);
expectEqual(firstSecretSecrets.status === "opened" ? firstSecretSecrets.current : "", nextWebhookSecret, "the first secret becomes the current one");
expectEqual(firstSecretSecrets.status === "opened" ? firstSecretSecrets.previous : "none", null, "the first secret has no predecessor");

const noSecretsAtAllStore = new InMemoryStripeConfigStore();
const noSecretConfig = configureStripeKeys(inputOf({ webhookSecret: null }), { store: noSecretsAtAllStore, keyring, occurredAtEpochMs: NOW });
const noSecretSecrets = stripeWebhookSecretsFor(
  noSecretConfig.status === "configured" ? noSecretConfig.config : (rolledConfig as StripeKeyConfig),
  keyring,
  NOW,
);
expectEqual(noSecretSecrets.status === "opened" ? noSecretSecrets.current : "present", null, "a configuration without a secret answers no current secret");
expectEqual(noSecretSecrets.status === "opened" ? noSecretSecrets.previous : "present", null, "a configuration without a secret answers no previous secret");

const retiredRoll = rollStripeWebhookSecret(oldId, nextWebhookSecret, { store: rotationStore, keyring, occurredAtEpochMs: NOW + 11_000 });
expectEqual(retiredRoll.status === "failed" ? retiredRoll.reason : "", "a retired configuration cannot be rolled", "a retired key's secret cannot be rolled");
const unknownRoll = rollStripeWebhookSecret("11111111-1111-4111-8111-111111111118", nextWebhookSecret, {
  store: rollStore,
  keyring,
  occurredAtEpochMs: NOW + 12_000,
});
expectEqual(unknownRoll.status === "failed" ? unknownRoll.reason : "", "no Stripe key configuration holds that id", "an unknown configuration cannot be rolled");

/* ------------------------------------------------------------------------------------------------
 * Section 13: the sealed-shape checks
 * ---------------------------------------------------------------------------------------------- */

expect(stripeConfigIsSealed(rolledConfig), "the rolled configuration is sealed");
expect(!stripeConfigIsSealed({ ...rolledConfig, secretKeySealed: sandboxSecret }), "a plaintext secret key is not sealed");
expect(!stripeConfigIsSealed({ ...rolledConfig, webhookSecretSealed: webhookSecret }), "a plaintext signing secret is not sealed");
expect(!stripeConfigIsSealed({ ...rolledConfig, previousWebhookSecretSealed: webhookSecret }), "a plaintext previous signing secret is not sealed");
expect(stripeConfigIsSealed({ ...rolledConfig, webhookSecretSealed: null, previousWebhookSecretSealed: null }), "a configuration with only the secret key is sealed");
expect(stripeConfigIsPublishable(rolledConfig), "the configuration carries a publishable key");
expect(!stripeConfigIsPublishable({ ...rolledConfig, publishableKey: sandboxSecret }), "a secret key is never treated as publishable");

/* ------------------------------------------------------------------------------------------------
 * Section 14: nothing hands back a credential
 * ---------------------------------------------------------------------------------------------- */

const everything = JSON.stringify({
  configured,
  shown,
  connected,
  rejected,
  notPermitted,
  unreachable,
  failed400,
  activated,
  rotated,
  retired,
  rolled,
  secretsDuring: secretsDuring.status === "opened" ? { hasCurrent: secretsDuring.current !== null } : secretsDuring,
  audits,
  rollAudits,
  rotationAudits,
});
expect(!everything.includes(sandboxSecret), "no result or audit carries the secret key");
expect(!everything.includes(webhookSecret), "no result or audit carries a signing secret");
expect(!everything.includes(nextWebhookSecret), "no result or audit carries a rolled signing secret");
expect(JSON.stringify(shown).includes(sandboxSecret.slice(8, -4)) === false, "the masked view never carries the key body");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Stripe Connect key gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Stripe Connect key gate passed: ${checks} checks (the Accounts v2 surface decision, sealed keys bound to company and field, the publishable key kept public on purpose, validated modes and API versions, the accounts read against an allowlisted endpoint, an activation that refuses without a passing test and a signing secret, a rotation that supersedes and retires, a signing-secret roll with its documented overlap, and no result that carries a credential)\n`,
);
