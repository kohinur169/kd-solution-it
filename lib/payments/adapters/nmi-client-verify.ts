// path: lib/payments/adapters/nmi-client-verify.ts
import process from "node:process";
import {
  InMemoryNmiKeyStore,
  configureNmiKeys,
  testNmiConnection,
  decryptKey,
  maskKey,
  type NmiConnectionTestResult,
} from "./nmi-client.ts";

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

const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const occurredAt = 1_000_000_000_000;

function successFn(): (apiKey: string, secretKey: string, environment: "sandbox" | "production") => NmiConnectionTestResult {
  return () => ({ status: "connected", message: "NMI API reachable" });
}

function failedFn(): (apiKey: string, secretKey: string, environment: "sandbox" | "production") => NmiConnectionTestResult {
  return () => ({ status: "failed", message: "Invalid API credentials" });
}

/* ---- scenario 1: configuring NMI keys encrypts and stores them ---- */

const store1 = new InMemoryNmiKeyStore();
const configured = configureNmiKeys(
  { companyId: "company-1", apiKey: "api-key-1234567890", secretKey: "secret-key-abcdefghij", environment: "sandbox" },
  { store: store1, encryptionKey, occurredAtEpochMs: occurredAt },
);

expect(configured.status === "configured", "configuring NMI keys succeeds");
if (configured.status === "configured") {
  expect(configured.config.companyId === "company-1", "the config carries the right company");
  expect(configured.config.environment === "sandbox", "the config carries the right environment");
  expect(configured.config.createdAtEpochMs === occurredAt, "the creation time is recorded");
  expect(configured.config.updatedAtEpochMs === occurredAt, "the update time is recorded");
}

/* ---- scenario 2: the stored keys are encrypted, not plaintext ---- */

if (configured.status === "configured") {
  expect(configured.config.apiKeyEncrypted !== "api-key-1234567890", "the stored API key is not plaintext");
  expect(configured.config.secretKeyEncrypted !== "secret-key-abcdefghij", "the stored secret key is not plaintext");
}

/* ---- scenario 3: the masked keys show only first and last chars ---- */

if (configured.status === "configured") {
  expect(configured.apiKeyMasked === "api-" + "*".repeat(10) + "7890", "the masked API key shows first and last chars");
  expect(configured.secretKeyMasked === "secr" + "*".repeat(13) + "ghij", "the masked secret key shows first and last chars");
}

/* ---- scenario 4: decrypting the stored keys returns the original plaintext ---- */

if (configured.status === "configured") {
  expect(decryptKey(configured.config.apiKeyEncrypted, encryptionKey) === "api-key-1234567890", "decrypting the API key returns the original");
  expect(decryptKey(configured.config.secretKeyEncrypted, encryptionKey) === "secret-key-abcdefghij", "decrypting the secret key returns the original");
}

/* ---- scenario 5: the config is stored and findable ---- */

if (configured.status === "configured") {
  expect(store1.findById(configured.config.id) !== null, "the config is stored in the store");
  expect(store1.findByCompany("company-1").length === 1, "the config is findable by company");
  expect(store1.findActiveByCompany("company-1")?.id === configured.config.id, "findActiveByCompany returns the config");
}

/* ---- scenario 6: testing the connection with valid keys ---- */

if (configured.status === "configured") {
  const test1 = testNmiConnection("company-1", {
    store: store1,
    encryptionKey,
    testConnection: successFn(),
    occurredAtEpochMs: occurredAt + 1_000,
  });

  expect(test1.status === "connected", "testing the connection with valid keys returns connected");
  if (test1.status === "connected") {
    expect(test1.message === "NMI API reachable", "the connection test carries the right message");
  }
}

/* ---- scenario 7: testing the connection with invalid keys ---- */

if (configured.status === "configured") {
  const test2 = testNmiConnection("company-1", {
    store: store1,
    encryptionKey,
    testConnection: failedFn(),
    occurredAtEpochMs: occurredAt + 1_000,
  });

  expect(test2.status === "failed", "testing the connection with invalid keys returns failed");
  if (test2.status === "failed") {
    expect(test2.message === "Invalid API credentials", "the failed connection test carries the right message");
  }
}

/* ---- scenario 8: testing the connection with no config ---- */

const store8 = new InMemoryNmiKeyStore();
const noConfig = testNmiConnection("company-1", {
  store: store8,
  encryptionKey,
  testConnection: successFn(),
  occurredAtEpochMs: occurredAt,
});
expect(noConfig.status === "rejected", "testing the connection with no config is rejected");

/* ---- scenario 9: empty apiKey is rejected ---- */

const store9 = new InMemoryNmiKeyStore();
const emptyApiKey = configureNmiKeys(
  { companyId: "company-1", apiKey: " ", secretKey: "secret", environment: "sandbox" },
  { store: store9, encryptionKey, occurredAtEpochMs: occurredAt },
);
expect(emptyApiKey.status === "failed", "an empty API key is rejected");

/* ---- scenario 10: empty secretKey is rejected ---- */

const store10 = new InMemoryNmiKeyStore();
const emptySecretKey = configureNmiKeys(
  { companyId: "company-1", apiKey: "api", secretKey: "  ", environment: "sandbox" },
  { store: store10, encryptionKey, occurredAtEpochMs: occurredAt },
);
expect(emptySecretKey.status === "failed", "an empty secret key is rejected");

/* ---- scenario 11: empty company id is rejected ---- */

const store11 = new InMemoryNmiKeyStore();
const emptyCompany = configureNmiKeys(
  { companyId: " ", apiKey: "api", secretKey: "secret", environment: "sandbox" },
  { store: store11, encryptionKey, occurredAtEpochMs: occurredAt },
);
expect(emptyCompany.status === "failed", "an empty company id is rejected");

/* ---- scenario 12: multiple configs for different companies ---- */

const store12 = new InMemoryNmiKeyStore();
const c12a = configureNmiKeys(
  { companyId: "company-a", apiKey: "api-a", secretKey: "secret-a", environment: "sandbox" },
  { store: store12, encryptionKey, occurredAtEpochMs: occurredAt },
);
const c12b = configureNmiKeys(
  { companyId: "company-b", apiKey: "api-b", secretKey: "secret-b", environment: "production" },
  { store: store12, encryptionKey, occurredAtEpochMs: occurredAt },
);

expect(c12a.status === "configured" && c12b.status === "configured", "two configs are created for different companies");
expect(store12.findByCompany("company-a").length === 1, "company-a has one config");
expect(store12.findByCompany("company-b").length === 1, "company-b has one config");
expect(store12.findActiveByCompany("company-b")?.environment === "production", "company-b's active config is production");

/* ---- scenario 13: re-configuring replaces the old config ---- */

const store13 = new InMemoryNmiKeyStore();
const c13a = configureNmiKeys(
  { companyId: "company-1", apiKey: "api-old", secretKey: "secret-old", environment: "sandbox" },
  { store: store13, encryptionKey, occurredAtEpochMs: occurredAt },
);
const c13b = configureNmiKeys(
  { companyId: "company-1", apiKey: "api-new", secretKey: "secret-new", environment: "production" },
  { store: store13, encryptionKey, occurredAtEpochMs: occurredAt + 1_000 },
);

expect(c13a.status === "configured" && c13b.status === "configured", "two configs are created for the same company");
if (c13a.status === "configured" && c13b.status === "configured") {
  expect(store13.findActiveByCompany("company-1")?.id === c13b.config.id, "the most recent config is active");
  expect(store13.findActiveByCompany("company-1")?.environment === "production", "the active config has the new environment");
  expect(decryptKey(store13.findActiveByCompany("company-1")?.apiKeyEncrypted ?? "", encryptionKey) === "api-new", "the active config has the new API key");
}

/* ---- scenario 14: two configs have different ids ---- */

if (c12a.status === "configured" && c12b.status === "configured") {
  expect(c12a.config.id !== c12b.config.id, "two configs have different ids");
}

/* ---- scenario 15: maskKey handles short keys ---- */

expect(maskKey("short") === "*****", "a short key is fully masked");
expect(maskKey("") === "", "an empty key is fully masked");
expect(maskKey("exactly8") === "********", "an 8-char key is fully masked");
expect(maskKey("long-key-12345") === "long" + "*".repeat(6) + "2345", "a long key shows first and last 4");

/* ---- scenario 16: the connection test receives the decrypted keys ---- */

let receivedApiKey: string | null = null;
let receivedSecretKey: string | null = null;
let receivedEnv: string | null = null;

if (configured.status === "configured") {
  testNmiConnection("company-1", {
    store: store1,
    encryptionKey,
    testConnection: (apiKey, secretKey, env) => {
      receivedApiKey = apiKey;
      receivedSecretKey = secretKey;
      receivedEnv = env;
      return { status: "connected", message: "ok" };
    },
    occurredAtEpochMs: occurredAt + 1_000,
  });
}

expect(receivedApiKey === "api-key-1234567890", "the connection test receives the decrypted API key");
expect(receivedSecretKey === "secret-key-abcdefghij", "the connection test receives the decrypted secret key");
expect(receivedEnv === "sandbox", "the connection test receives the right environment");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments NMI client gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments NMI client gate passed: ${checks} checks, a service that stores NMI API keys AES-256-GCM encrypted at rest and tests the connection - the keys are encrypted before storage, decrypted for the connection test, shown masked for display, and the test function receives the decrypted keys and environment\n`,
);
