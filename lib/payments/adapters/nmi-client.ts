// path: lib/payments/adapters/nmi-client.ts

/**
 * The NMI adapter's encrypted key configuration and connection test: the service that stores NMI API
 * keys encrypted at rest and tests the connection to NMI's API.
 *
 * ## What the key configuration is
 *
 * Section 29 says "provider keys... entered in admin screens are AES-256-GCM encrypted at rest and shown
 * only masked." The configuration carries a public tokenization key and a private API security key. When the super admin enters them in the
 * gateway settings, the platform encrypts them with AES-256-GCM before storing. The plaintext keys never
 * rest in the database. When the platform needs to call NMI's API, it decrypts the keys in memory, uses
 * them for the call, and never writes them back in plaintext.
 *
 * The masked view is what the admin UI shows: the first and last four characters with the middle masked,
 * so the admin can confirm which key is stored without seeing the full secret.
 *
 * ## What the connection test is
 *
 * Before the NMI provider is enabled, the admin tests the connection. The test decrypts the stored keys
 * and calls NMI's API with them. A successful response means the keys are valid and the provider is ready
 * to use. A failed response means the keys are wrong or the API is unreachable.
 *
 * ## What this file is not
 *
 * It is not the NMI API client for making charges (STEP 149 owns that). It is not the gateway registry
 * provider declaration (STEP 147 owns the adapter file). It is not the API route or UI for entering keys.
 * This file is the core service: the encryption, the key store, the masking, and the connection test.
 */

import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** A NMI key configuration: the encrypted API and secret keys for a company. */
export interface NmiKeyConfig {
  readonly id: string;
  readonly companyId: string;
  /** Encrypted public tokenization key. */
  readonly apiKeyEncrypted: string;
  /** Encrypted private API security key. */
  readonly secretKeyEncrypted: string;
  readonly environment: "sandbox" | "production";
  readonly createdAtEpochMs: number;
  readonly updatedAtEpochMs: number;
}

/** What the store reads and writes: the NMI key configurations. The store is the caller's. */
export interface NmiKeyStore {
  /** Store a key configuration, replacing any configuration with the same id. */
  insert(config: NmiKeyConfig): void;
  /** The configuration an id already holds, or null when the configuration is new. */
  findById(id: string): NmiKeyConfig | null;
  /** Every configuration a company has. */
  findByCompany(companyId: string): NmiKeyConfig[];
  /** The active configuration a company has: the most recent one, or null when none exists. */
  findActiveByCompany(companyId: string): NmiKeyConfig | null;
}

/** The in-memory store: a reference implementation that keys on configuration id. */
export class InMemoryNmiKeyStore implements NmiKeyStore {
  private readonly configs = new Map<string, NmiKeyConfig>();

  insert(config: NmiKeyConfig): void {
    this.configs.set(config.id, config);
  }

  findById(id: string): NmiKeyConfig | null {
    return this.configs.get(id) ?? null;
  }

  findByCompany(companyId: string): NmiKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === companyId);
  }

  findActiveByCompany(companyId: string): NmiKeyConfig | null {
    const configs = this.findByCompany(companyId);
    configs.sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs);
    return configs[0] ?? null;
  }
}

/** Encrypt a plaintext key with AES-256-GCM. The output is base64 of IV + tag + ciphertext. */
export function encryptKey(plaintext: string, encryptionKey: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(encryptionKey, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a key encrypted by encryptKey. Returns the original plaintext. */
export function decryptKey(encrypted: string, encryptionKey: string): string {
  const data = Buffer.from(encrypted, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encryptedData = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, Buffer.from(encryptionKey, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString("utf8");
}

/** Mask a key for display: show the first and last four characters with the middle masked. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}`;
}

/** The result of configuring NMI keys. */
export type ConfigureNmiKeysResult =
  | { status: "configured"; config: NmiKeyConfig; apiKeyMasked: string; secretKeyMasked: string }
  | { status: "failed"; reason: string };

/** Configure NMI keys: validate, encrypt, store, return the masked view. */
export function configureNmiKeys(
  input: {
    readonly companyId: string;
    readonly apiKey: string;
    readonly secretKey: string;
    readonly environment: "sandbox" | "production";
  },
  options: {
    readonly store: NmiKeyStore;
    readonly encryptionKey: string;
    readonly occurredAtEpochMs: number;
  },
): ConfigureNmiKeysResult {
  // 1. Validate.
  if (input.companyId.trim().length === 0) {
    return { status: "failed", reason: "the company id must not be empty" };
  }
  if (input.apiKey.trim().length === 0) {
    return { status: "failed", reason: "the API key must not be empty" };
  }
  if (input.secretKey.trim().length === 0) {
    return { status: "failed", reason: "the secret key must not be empty" };
  }

  // 2. Encrypt the keys.
  const apiKeyEncrypted = encryptKey(input.apiKey, options.encryptionKey);
  const secretKeyEncrypted = encryptKey(input.secretKey, options.encryptionKey);

  // 3. Create and store the configuration.
  const now = options.occurredAtEpochMs;
  const config: NmiKeyConfig = {
    id: randomUUID(),
    companyId: input.companyId,
    apiKeyEncrypted,
    secretKeyEncrypted,
    environment: input.environment,
    createdAtEpochMs: now,
    updatedAtEpochMs: now,
  };
  options.store.insert(config);

  // 4. Return the masked view.
  return {
    status: "configured",
    config,
    apiKeyMasked: maskKey(input.apiKey),
    secretKeyMasked: maskKey(input.secretKey),
  };
}

/** The result of a connection test. */
export type NmiConnectionTestResult =
  | { status: "connected"; message: string }
  | { status: "failed"; message: string };

/** The connection test port: the function that calls NMI's API with the decrypted keys. */
export type NmiConnectionTestFn = (
  apiKey: string,
  secretKey: string,
  environment: "sandbox" | "production",
) => NmiConnectionTestResult;

/** The result of testing the NMI connection. */
export type TestNmiConnectionResult =
  | { status: "connected"; message: string }
  | { status: "failed"; message: string }
  | { status: "rejected"; reason: string };

/** Test the NMI connection: find the active config, decrypt the keys, call the test function. */
export function testNmiConnection(
  companyId: string,
  options: {
    readonly store: NmiKeyStore;
    readonly encryptionKey: string;
    readonly testConnection: NmiConnectionTestFn;
    readonly occurredAtEpochMs: number;
  },
): TestNmiConnectionResult {
  // 1. Find the active configuration.
  const config = options.store.findActiveByCompany(companyId);
  if (config === null) {
    return { status: "rejected", reason: "no NMI key configuration exists for this company" };
  }

  // 2. Decrypt the keys.
  let apiKey: string;
  let secretKey: string;
  try {
    apiKey = decryptKey(config.apiKeyEncrypted, options.encryptionKey);
    secretKey = decryptKey(config.secretKeyEncrypted, options.encryptionKey);
  } catch {
    return { status: "failed", message: "failed to decrypt the stored NMI keys" };
  }

  // 3. Call the connection test function.
  const result = options.testConnection(apiKey, secretKey, config.environment);

  return result;
}
