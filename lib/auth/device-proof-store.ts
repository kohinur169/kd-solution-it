// path: lib/auth/device-proof-store.ts
import {
  DEFAULT_PROOF_KEY_ALGORITHM,
  generateProofKeyPair,
  isProofKeyAlgorithm,
  isStoredProofKey,
  publicProofKeyOf,
  type ProofKeyAlgorithm,
  type StoredProofKey,
} from "./proof-key.ts";

/**
 * Where this browser keeps its device proof key, and how it introduces itself to the platform.
 *
 * `generateProofKeyPair` already makes the private half non-extractable, which means the bytes exist
 * only inside WebCrypto for as long as the `CryptoKey` object lives. That object has to survive a
 * reload, and IndexedDB is the only storage a page can put a `CryptoKey` into: `localStorage` would
 * store a string, which is exactly the thing this design refuses to have.
 *
 * ## What is stored, and what it is worth to a thief
 *
 * The record holds the pair, the public key, the fingerprint and what the platform answered. A
 * `CryptoKey` restored from IndexedDB is usable only by the same origin, and the private half still
 * cannot be exported - so a copy of the database is a key an attacker can *use* on that machine
 * through the page, not a key they can carry elsewhere. That is also why STEP 050's signature is a
 * proof of device continuity rather than a bearer token on its own: it is checked *with* the session
 * cookie, never instead of it.
 *
 * ## One key per browser, and no interactive surface
 *
 * The store holds one record under one key. A merchant who signs in on a second browser gets a
 * second pair there, which is a second device row - that is the feature, not a bug. Nothing here
 * shows a message: STEP 049 runs the enrolment after a sign in that reported `deviceProofRequired`,
 * and a failure leaves the merchant signed in with the server asking again next time. The screen
 * that explains devices belongs to STEP 052 (new device confirmation) and STEP 054 (the list).
 */

const databaseName = "kd-device-proof";
const databaseVersion = 1;
const storeName = "keys";
const recordKey = "device";

/** The enrolment endpoint. Same origin, so the session cookie travels with the call. */
const enrolmentPath = "/api/auth/devices";

/** The largest answer this module will read from the endpoint. */
const maximumAnswerBytes = 4_096;

/** Why an enrolment did not happen. Never rendered; the caller only needs to know it can continue. */
export type DeviceProofFailureReason =
  | "unsupported"
  | "storage"
  | "network"
  | "refused"
  | "unreadable";

export type DeviceProofOutcome =
  | { readonly ok: true; readonly fingerprint: string; readonly trusted: boolean }
  | { readonly ok: false; readonly reason: DeviceProofFailureReason };

interface EnrolmentAnswer {
  readonly status: string;
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly algorithm: ProofKeyAlgorithm;
  readonly trusted: boolean;
}

/** True when this browser can hold a proof key at all. */
export function deviceProofSupported(): boolean {
  return (
    typeof globalThis.indexedDB !== "undefined" &&
    typeof globalThis.crypto === "object" &&
    typeof globalThis.crypto.subtle === "object" &&
    globalThis.isSecureContext
  );
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, databaseVersion);

    request.onupgradeneeded = (): void => {
      const database = request.result;

      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    };

    request.onsuccess = (): void => {
      resolve(request.result);
    };

    request.onerror = (): void => {
      reject(new Error("storage is unavailable"));
    };

    request.onblocked = (): void => {
      reject(new Error("storage is blocked"));
    };
  });
}

function runTransaction<TResult>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<TResult>,
): Promise<TResult> {
  return new Promise((resolve, reject) => {
    openDatabase()
      .then((database) => {
        const transaction = database.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));

        request.onsuccess = (): void => {
          resolve(request.result);
        };

        request.onerror = (): void => {
          reject(new Error("the request was refused"));
        };

        transaction.oncomplete = (): void => {
          database.close();
        };

        transaction.onabort = (): void => {
          database.close();
          reject(new Error("the transaction was aborted"));
        };
      })
      .catch(reject);
  });
}

/** The record this browser holds, or null. A record this module does not understand is discarded. */
export async function readStoredDeviceProofKey(): Promise<StoredProofKey | null> {
  if (!deviceProofSupported()) {
    return null;
  }

  try {
    const stored: unknown = await runTransaction("readonly", (store) => store.get(recordKey));

    if (isStoredProofKey(stored)) {
      return stored;
    }

    if (stored !== undefined) {
      await clearStoredDeviceProofKey();
    }

    return null;
  } catch {
    return null;
  }
}

/** Forget this browser's key. The platform's row is untouched: revoking a device is STEP 054's. */
export async function clearStoredDeviceProofKey(): Promise<void> {
  if (!deviceProofSupported()) {
    return;
  }

  try {
    await runTransaction("readwrite", (store) => store.delete(recordKey));
  } catch {
    // A store that refuses a delete is a store that will refuse the next write too; the caller
    // that needed the value gone already has its answer.
  }
}

async function writeStoredDeviceProofKey(key: StoredProofKey): Promise<void> {
  await runTransaction("readwrite", (store) => store.put(key, recordKey));
}

/** The pair this browser will use, generated on first call and kept afterwards. */
export async function loadOrCreateDeviceProofKey(
  algorithm: ProofKeyAlgorithm = DEFAULT_PROOF_KEY_ALGORITHM,
): Promise<StoredProofKey> {
  const stored = await readStoredDeviceProofKey();

  if (stored !== null) {
    return stored;
  }

  const generated = await generateProofKeyPair(algorithm);
  const created: StoredProofKey = {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    publicKeyBase64Url: generated.publicKeyBase64Url,
    fingerprint: generated.fingerprint,
    algorithm: generated.algorithm,
    deviceId: null,
    trusted: false,
    createdAtEpochMs: Date.now(),
  };

  await writeStoredDeviceProofKey(created);

  return created;
}

/** Read the answer the endpoint sent, refusing anything this module cannot use. */
function readEnrolmentAnswer(payload: unknown): EnrolmentAnswer | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const { status, deviceId, fingerprint, algorithm, trusted } = candidate;

  if (
    typeof status !== "string" ||
    typeof deviceId !== "string" ||
    deviceId.length === 0 ||
    deviceId.length > 64 ||
    typeof fingerprint !== "string" ||
    fingerprint.length < 43 ||
    fingerprint.length > 128 ||
    typeof trusted !== "boolean" ||
    !isProofKeyAlgorithm(algorithm)
  ) {
    return null;
  }

  return { status, deviceId, fingerprint, algorithm, trusted };
}

/**
 * Register this browser's public key, generating the pair if this is its first visit.
 *
 * The stored record is updated with the device id and the trust flag the server answered, and with
 * the server's fingerprint - the server computes it from the canonical encoding, and the browser
 * adopting that value keeps one number in two places instead of two numbers that agree by luck.
 */
export async function enrolDeviceProofKey(): Promise<DeviceProofOutcome> {
  if (!deviceProofSupported()) {
    return { ok: false, reason: "unsupported" };
  }

  let key: StoredProofKey;

  try {
    key = await loadOrCreateDeviceProofKey();
  } catch {
    return { ok: false, reason: "storage" };
  }

  let response: Response;

  try {
    response = await fetch(enrolmentPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publicProofKeyOf(key)),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  const text = await response.text().catch(() => "");

  if (!response.ok) {
    return { ok: false, reason: "refused" };
  }

  if (text.length > maximumAnswerBytes) {
    return { ok: false, reason: "unreadable" };
  }

  let payload: unknown;

  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, reason: "unreadable" };
  }

  const answer = readEnrolmentAnswer(payload);

  if (answer === null) {
    return { ok: false, reason: "unreadable" };
  }

  const updated: StoredProofKey = {
    ...key,
    fingerprint: answer.fingerprint,
    algorithm: answer.algorithm,
    deviceId: answer.deviceId,
    trusted: answer.trusted,
  };

  try {
    await writeStoredDeviceProofKey(updated);
  } catch {
    // The pair is already enrolled and the platform has the row; a failed write of the answer means
    // the next sign in asks again, which is the same answer a browser without storage gets.
    return { ok: true, fingerprint: answer.fingerprint, trusted: answer.trusted };
  }

  return { ok: true, fingerprint: answer.fingerprint, trusted: answer.trusted };
}
