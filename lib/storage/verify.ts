// path: lib/storage/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { createInMemoryAuditTrail, type AuditTrail } from "../auth/audit.ts";
import { adapterFor, StorageAdapterAlreadyRegisteredError, StorageAdapterRegistry } from "./registry.ts";
import {
  createFileSignedUrl,
  deleteObject,
  downloadObject,
  FILE_ACCESSED_AUDIT_ACTION,
  FILE_AUDIT_ENTITY,
  FILE_DELETED_AUDIT_ACTION,
  FILE_UPLOADED_AUDIT_ACTION,
  signedUrlTtlSeconds,
  uploadObject,
  validateBucket,
  validateObjectKey,
} from "./service.ts";
import {
  MAX_OBJECT_BYTES,
  SIGNED_URL_DEFAULT_TTL_SECONDS,
  SIGNED_URL_MAX_TTL_SECONDS,
  SIGNED_URL_MIN_TTL_SECONDS,
  STORAGE_ADAPTER_NAMES,
  STORAGE_ERROR_CODES,
  StorageError,
  isStorageError,
  type StorageAdapter,
  type StorageAdapterName,
  type StorageObjectRef,
  type StorageUploadInput,
} from "./types.ts";

/**
 * Storage port gate. Run with `node lib/storage/verify.ts`.
 *
 * The gate drives the real registry and the audited service layer against a fake adapter that
 * records every call, so the port's rules are proven without a network:
 *
 *   1. the adapter names are exactly `supabase` and `s3`, and registration rejects a second adapter
 *      under one name and an unknown name;
 *   2. `adapterFor` answers the registered adapter and answers `unavailable` for a provider with no
 *      adapter - a build without its storage wired fails loudly, never to disk;
 *   3. bucket, key and signed-URL lifetime validation refuses traversal and out-of-bounds values
 *      before the adapter is called, with the same rules `0057` puts on the record;
 *   4. each of the four operations runs the adapter and appends exactly one audit entry with the
 *      right action, entity and payload;
 *   5. a provider error propagates as a typed `StorageError`, and an audit sink that is down never
 *      fails the access it records;
 *   6. no file in lib/storage imports `node:fs` - server-local disk is never used for stored files.
 */

const repositoryRoot = new URL("../../", import.meta.url);

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

async function readRepositoryFile(repositoryPath: string): Promise<string> {
  return readFile(new URL(repositoryPath, repositoryRoot), "utf8");
}

const NOW = Date.parse("2026-11-03T09:00:00.000Z");
const COMPANY_ID = "018f2b8a-4444-4c2d-9c3e-000000000001";
const FILE_ID = "018f2b8a-9999-4c2d-9c3e-000000000001";
const ACTOR_ID = "018f2b8a-1111-4c2d-9c3e-000000000001";
const BUCKET = "kd-solution-it-files";
const KEY = `${COMPANY_ID}/kyc/passport.pdf`;

interface RecordedCall {
  readonly op: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A fake adapter that records every call and stores objects in a map. */
class FakeAdapter implements StorageAdapter {
  readonly name: StorageAdapterName;
  readonly calls: RecordedCall[] = [];
  private readonly objects = new Map<string, Uint8Array>();
  failWith: StorageError | null = null;

  constructor(name: StorageAdapterName) {
    this.name = name;
  }

  private guard(): void {
    if (this.failWith !== null) {
      throw this.failWith;
    }
  }

  async upload(input: StorageUploadInput): Promise<{ provider: StorageAdapterName; bucket: string; key: string; byteSize: number }> {
    this.calls.push({ op: "upload", input: { ...input, bytes: `<${input.bytes.length} bytes>` } });
    this.guard();
    this.objects.set(`${input.bucket}/${input.key}`, input.bytes);

    return { provider: this.name, bucket: input.bucket, key: input.key, byteSize: input.bytes.length };
  }

  async download(ref: StorageObjectRef): Promise<Uint8Array> {
    this.calls.push({ op: "download", input: { ...ref } });
    this.guard();

    const bytes = this.objects.get(`${ref.bucket}/${ref.key}`);

    if (bytes === undefined) {
      throw new StorageError("not_found", "the object does not exist");
    }

    return bytes;
  }

  async remove(ref: StorageObjectRef): Promise<void> {
    this.calls.push({ op: "remove", input: { ...ref } });
    this.guard();
    this.objects.delete(`${ref.bucket}/${ref.key}`);
  }

  async createSignedUrl(input: { readonly bucket: string; readonly key: string; readonly expiresInSeconds: number }): Promise<{ url: string; expiresAt: string }> {
    this.calls.push({ op: "createSignedUrl", input: { ...input } });
    this.guard();

    return {
      url: `https://files.example.test/${input.bucket}/${input.key}?ttl=${input.expiresInSeconds}`,
      expiresAt: new Date(NOW + input.expiresInSeconds * 1000).toISOString(),
    };
  }
}

function deps(audit: AuditTrail = createInMemoryAuditTrail()): { readonly audit: AuditTrail; readonly now: () => number } {
  return { audit, now: () => NOW };
}

const access = { actorUserId: ACTOR_ID, companyId: COMPANY_ID, fileId: FILE_ID, purpose: "kyc_document" };

async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }

  return null;
}

function checkVocabulary(): void {
  expectEqual(STORAGE_ADAPTER_NAMES.join(","), "supabase,s3", "the adapter names are exactly supabase and s3");
  expectEqual(STORAGE_ERROR_CODES.join(","), "invalid_input,not_found,unavailable,conflict,provider_error", "the error vocabulary is closed");
  expectEqual(MAX_OBJECT_BYTES, 52_428_800, "the object ceiling is the 50 MB of 0057");
  expectEqual(SIGNED_URL_DEFAULT_TTL_SECONDS, 300, "a signed URL lives five minutes by default");
  expectEqual(SIGNED_URL_MAX_TTL_SECONDS, 900, "and at most fifteen minutes");
  expectEqual(SIGNED_URL_MIN_TTL_SECONDS, 1, "and at least one second");
  expect(isStorageError(new StorageError("not_found", "gone")), "a StorageError is recognised");
  expect(!isStorageError(new Error("gone")), "a plain Error is not a StorageError");
}

function checkRegistry(): void {
  const registry = new StorageAdapterRegistry();
  const supabase = new FakeAdapter("supabase");
  const s3 = new FakeAdapter("s3");

  registry.register(supabase);
  registry.register(s3);

  expectEqual(registry.size, 2, "two adapters register");
  expectEqual(registry.has("supabase"), true, "supabase is registered");
  expectEqual(adapterFor(registry, "s3"), s3, "adapterFor answers the asked provider");
  expectEqual(adapterFor(registry, "supabase"), supabase, "and the other one");

  let duplicate: unknown = null;

  try {
    registry.register(new FakeAdapter("s3"));
  } catch (error) {
    duplicate = error;
  }

  expect(duplicate instanceof StorageAdapterAlreadyRegisteredError, "a second adapter under one name throws");

  const empty = new StorageAdapterRegistry();
  const unavailable = rejectionOfSync(() => adapterFor(empty, "supabase"));
  expect(isStorageError(unavailable) && (unavailable as StorageError).code === "unavailable", "an unregistered provider answers unavailable");

  const badName = rejectionOfSync(() => adapterFor(registry, "gcs" as never));
  expect(isStorageError(badName) && (badName as StorageError).code === "invalid_input", "an unknown provider name is invalid input");
}

function rejectionOfSync(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  return null;
}

function checkValidation(): void {
  expectEqual(validateBucket(BUCKET), BUCKET, "a valid bucket passes");

  for (const bad of ["-bad", "a", "UPPER", "has_underscore", "", "x".repeat(64)]) {
    expect(isStorageError(rejectionOfSync(() => validateBucket(bad))), `bucket ${JSON.stringify(bad)} is refused`);
  }

  expectEqual(validateObjectKey(KEY), KEY, "a tenant scoped key passes");

  for (const bad of ["../escape", "a//b", "/abs", "a/", "ab", "a\\b", `${"x".repeat(513)}`, ".."]) {
    expect(isStorageError(rejectionOfSync(() => validateObjectKey(bad))), `key ${JSON.stringify(bad.slice(0, 12))} is refused`);
  }

  expectEqual(signedUrlTtlSeconds(undefined), SIGNED_URL_DEFAULT_TTL_SECONDS, "the default lifetime applies");
  expectEqual(signedUrlTtlSeconds(60), 60, "a custom lifetime inside the bounds passes");
  expectEqual(signedUrlTtlSeconds(SIGNED_URL_MAX_TTL_SECONDS), SIGNED_URL_MAX_TTL_SECONDS, "the ceiling passes");

  for (const bad of [0, -5, SIGNED_URL_MAX_TTL_SECONDS + 1, 1.5, Number.NaN]) {
    expect(isStorageError(rejectionOfSync(() => signedUrlTtlSeconds(bad))), `lifetime ${String(bad)} is refused`);
  }
}

async function checkOperations(): Promise<void> {
  const adapter = new FakeAdapter("supabase");
  const audit = createInMemoryAuditTrail();
  const dependencies = deps(audit);

  // upload
  const bytes = new TextEncoder().encode("%PDF-1.4 fake");
  const stored = await uploadObject(adapter, { bucket: BUCKET, key: KEY, bytes, contentType: "application/pdf" }, access, dependencies);

  expectEqual(stored.provider, "supabase", "the upload answers the provider");
  expectEqual(stored.bucket, BUCKET, "the bucket");
  expectEqual(stored.key, KEY, "the key");
  expectEqual(stored.byteSize, bytes.length, "and the size");
  expectEqual(adapter.calls[0]?.op, "upload", "the adapter received the upload");
  expectEqual(audit.entries.length, 1, "one audit entry is written");
  expectEqual(audit.entries[0]?.action, FILE_UPLOADED_AUDIT_ACTION, "as file.uploaded");
  expectEqual(audit.entries[0]?.entityType, FILE_AUDIT_ENTITY, "against the file entity");
  expectEqual(audit.entries[0]?.entityId, FILE_ID, "naming the file row");
  expectEqual(audit.entries[0]?.actorUserId, ACTOR_ID, "and the actor");
  expectEqual(audit.entries[0]?.companyId, COMPANY_ID, "and the tenant");

  const uploadPayload = audit.entries[0]?.payload ?? {};
  expectEqual(uploadPayload["bucket"], BUCKET, "the payload names the bucket");
  expectEqual(uploadPayload["key"], KEY, "the key");
  expectEqual(uploadPayload["provider"], "supabase", "the provider");
  expectEqual(uploadPayload["byte_size"], bytes.length, "the size");
  expectEqual(uploadPayload["content_type"], "application/pdf", "the content type");
  expectEqual(uploadPayload["purpose"], "kyc_document", "the purpose");

  // upload validation happens before the adapter
  const before = adapter.calls.length;
  expect(isStorageError(await rejectionOf(() => uploadObject(adapter, { bucket: BUCKET, key: KEY, bytes: new Uint8Array(0), contentType: "application/pdf" }, access, dependencies))), "an empty object is refused");
  expect(isStorageError(await rejectionOf(() => uploadObject(adapter, { bucket: BUCKET, key: KEY, bytes: new Uint8Array(MAX_OBJECT_BYTES + 1), contentType: "application/pdf" }, access, dependencies))), "an over-ceiling object is refused");
  expect(isStorageError(await rejectionOf(() => uploadObject(adapter, { bucket: BUCKET, key: "../escape", bytes, contentType: "application/pdf" }, access, dependencies))), "a traversal key is refused");
  expect(isStorageError(await rejectionOf(() => uploadObject(adapter, { bucket: BUCKET, key: KEY, bytes, contentType: "not a mime" }, access, dependencies))), "a bad content type is refused");
  expectEqual(adapter.calls.length, before, "and the adapter was not called for any of them");

  // download
  const read = await downloadObject(adapter, { bucket: BUCKET, key: KEY }, access, dependencies);
  expectEqual(read.length, bytes.length, "the download returns the bytes");
  expectEqual(adapter.calls[1]?.op, "download", "the adapter received the download");
  expectEqual(audit.entries[1]?.action, FILE_ACCESSED_AUDIT_ACTION, "the access is audited as file.accessed");
  expectEqual((audit.entries[1]?.payload ?? {})["operation"], "download", "with operation download");
  expectEqual((audit.entries[1]?.payload ?? {})["byte_size"], bytes.length, "and the size read");

  // a missing object propagates as not_found
  const missing = await rejectionOf(() => downloadObject(adapter, { bucket: BUCKET, key: `${COMPANY_ID}/kyc/missing.pdf` }, access, dependencies));
  expect(isStorageError(missing) && (missing as StorageError).code === "not_found", "a missing object answers not_found");

  // a bad ref never reaches the adapter
  const callsBefore = adapter.calls.length;
  expect(isStorageError(await rejectionOf(() => downloadObject(adapter, { bucket: "NOPE", key: KEY }, access, dependencies))), "a bad bucket on a download is refused");
  expectEqual(adapter.calls.length, callsBefore, "and the adapter was not called");

  // signed URL
  const signed = await createFileSignedUrl(adapter, { bucket: BUCKET, key: KEY }, access, dependencies);
  expect(signed.url.includes(`ttl=${SIGNED_URL_DEFAULT_TTL_SECONDS}`), "the default lifetime is used");
  expectEqual(signed.expiresAt, new Date(NOW + SIGNED_URL_DEFAULT_TTL_SECONDS * 1000).toISOString(), "and the expiry instant answers");
  expectEqual((adapter.calls[adapter.calls.length - 1]?.input ?? {})["expiresInSeconds"], SIGNED_URL_DEFAULT_TTL_SECONDS, "the adapter received the default ttl");

  const custom = await createFileSignedUrl(adapter, { bucket: BUCKET, key: KEY, expiresInSeconds: 120 }, access, dependencies);
  expect(custom.url.includes("ttl=120"), "a custom lifetime is honoured");
  expectEqual((audit.entries[audit.entries.length - 1]?.payload ?? {})["operation"], "signed_url", "the signed url access is audited");
  expectEqual((audit.entries[audit.entries.length - 1]?.payload ?? {})["expires_in_seconds"], 120, "with the lifetime in the payload");

  const badTtl = await rejectionOf(() => createFileSignedUrl(adapter, { bucket: BUCKET, key: KEY, expiresInSeconds: SIGNED_URL_MAX_TTL_SECONDS + 1 }, access, dependencies));
  expect(isStorageError(badTtl) && (badTtl as StorageError).code === "invalid_input", "an over-ceiling lifetime is refused");

  // delete
  await deleteObject(adapter, { bucket: BUCKET, key: KEY }, access, dependencies);
  expectEqual(adapter.calls[adapter.calls.length - 1]?.op, "remove", "the adapter received the delete");
  expectEqual(audit.entries[audit.entries.length - 1]?.action, FILE_DELETED_AUDIT_ACTION, "audited as file.deleted");
  expect(isStorageError(await rejectionOf(() => downloadObject(adapter, { bucket: BUCKET, key: KEY }, access, dependencies))), "the deleted object no longer downloads");

  // provider errors propagate typed
  adapter.failWith = new StorageError("provider_error", "the provider answered 503");
  const failed = await rejectionOf(() => downloadObject(adapter, { bucket: BUCKET, key: KEY }, access, dependencies));
  expect(isStorageError(failed) && (failed as StorageError).code === "provider_error", "a provider error propagates as provider_error");
  adapter.failWith = null;

  // an audit sink that is down never fails the access
  const downAudit: AuditTrail = { append: () => Promise.reject(new Error("audit sink down")) };
  const storedAgain = await uploadObject(adapter, { bucket: BUCKET, key: KEY, bytes, contentType: "application/pdf" }, access, deps(downAudit));
  expectEqual(storedAgain.byteSize, bytes.length, "the upload succeeds with the audit sink down");
}

async function checkSources(): Promise<void> {
  const paths = ["lib/storage/types.ts", "lib/storage/registry.ts", "lib/storage/service.ts", "lib/storage/verify.ts", "lib/storage/README.md"];
  // The runtime files plus the README are the code that must never touch disk or the console;
  // the gate itself reads sources, so it is only scanned for the path comment and ASCII.
  const runtimePaths = paths.filter((path) => !path.endsWith("verify.ts"));

  for (const path of paths) {
    const source = await readRepositoryFile(path);
    expect(source.length > 0, `${path} exists`);
    expect(!/[^\u0009\u000a\u000d\u0020-\u007e]/u.test(source), `${path} is ASCII only`);
    expect(source.split("\n", 1)[0]?.trim() === `// path: ${path}`, `${path} starts with its path comment`);
  }

  for (const path of runtimePaths) {
    const source = await readRepositoryFile(path);
    expect(!source.includes("node:fs"), `${path} never imports node:fs - server-local disk is never used`);
    expect(!/console\.log\(/u.test(source), `${path} never writes to the console`);
  }

  const types = await readRepositoryFile("lib/storage/types.ts");
  for (const operation of ["upload(", "download(", "remove(", "createSignedUrl("]) {
    expect(types.includes(operation), `the adapter port declares ${operation}`);
  }
  expect(types.includes("interface StorageAdapter"), "the port is one interface");
  expect(types.includes("expiresInSeconds"), "the signed URL carries its lifetime");

  const service = await readRepositoryFile("lib/storage/service.ts");
  expect(service.includes('FILE_UPLOADED_AUDIT_ACTION = "file.uploaded"'), "the upload audit action is declared");
  expect(service.includes('FILE_ACCESSED_AUDIT_ACTION = "file.accessed"'), "the access audit action is declared");
  expect(service.includes('FILE_DELETED_AUDIT_ACTION = "file.deleted"'), "the delete audit action is declared");
  expect(service.includes("includes(\"..\")"), "the key validation refuses traversal segments");

  const registry = await readRepositoryFile("lib/storage/registry.ts");
  expect(registry.includes("getServerConfig().storageProvider"), "the active adapter comes from the environment configuration");
  expect(registry.includes('StorageError("unavailable"'), "an unwired provider answers unavailable");
}

async function main(): Promise<void> {
  checkVocabulary();
  checkRegistry();
  checkValidation();
  await checkOperations();
  await checkSources();

  if (failures.length > 0) {
    process.stderr.write(`storage gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `storage gate passed: ${checks} checks, ${STORAGE_ADAPTER_NAMES.length} adapter names, ` +
      `${STORAGE_ERROR_CODES.length} error codes, signed urls ${SIGNED_URL_DEFAULT_TTL_SECONDS}s default / ${SIGNED_URL_MAX_TTL_SECONDS}s max\n`,
  );
}

await main();
