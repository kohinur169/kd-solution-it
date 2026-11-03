// path: lib/storage/verify.ts
import process from "node:process";
import { readFile } from "node:fs/promises";
import { createInMemoryAuditTrail, type AuditTrail } from "../auth/audit.ts";
import { registerConfiguredAdapters } from "./adapters.ts";
import { storageErrorForStatus, type StorageFetch } from "./http.ts";
import { isAppError } from "../errors/app-error.ts";
import { ENCRYPTION_CHUNK_BYTES, isFileEnvelope, readFileEnvelopeInfo } from "../security/encryption.ts";
import { createHash } from "node:crypto";
import { adapterFor, StorageAdapterAlreadyRegisteredError, StorageAdapterRegistry } from "./registry.ts";
import {
  createFileEncryption,
  fileEncryptionKeyring,
  fileEncryptionScope,
  keyVersionOfKeyId,
  FILE_ENCRYPTION_ALGORITHM,
  FILE_ENCRYPTION_KEY_ID,
  FILE_ENCRYPTION_KEY_VERSION,
} from "./encryption.ts";
import { amzDates, awsUriEncode, createS3StorageAdapter, S3_ALGORITHM } from "./s3-adapter.ts";
import { createSupabaseStorageAdapter, SUPABASE_SIGNED_PATH_PREFIX } from "./supabase-adapter.ts";
import {
  createFileSignedUrl,
  deleteObject,
  downloadEncryptedObject,
  downloadObject,
  uploadEncryptedObject,
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

  /** Plant an object directly, for downloads the upload path did not write. */
  plant(bucket: string, key: string, bytes: Uint8Array): void {
    this.objects.set(`${bucket}/${key}`, bytes);
  }

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

interface QueuedAnswer {
  readonly status: number;
  readonly body?: string | Uint8Array;
  readonly headers?: Record<string, string>;
}

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fake transport that records every request and answers from a queue. */
function fakeTransport(queue: QueuedAnswer[]): { readonly calls: RecordedRequest[]; readonly fetch: StorageFetch } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: StorageFetch = (url, init) => {
    calls.push({ url, init });

    const next = queue.length > 0 ? (queue.shift() as QueuedAnswer) : { status: 200 };

    if (next.status === 204) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    const body = typeof next.body === "string" ? next.body : (next.body ?? new Uint8Array(0));

    return Promise.resolve(
      new Response(body as BodyInit, {
        status: next.status,
        ...(next.headers === undefined ? {} : { headers: next.headers }),
      }),
    );
  };

  return { calls, fetch: fetchImpl };
}

const SUPABASE_URL = "https://project-ref.supabase.co";
const SUPABASE_ENV = {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789abcdef0123456789",
  NODE_ENV: "test",
};
const S3_ENV = {
  S3_BUCKET: "kd-files",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const S3_HOST = "kd-files.s3.us-east-1.amazonaws.com";

function headerOf(request: RecordedRequest, name: string): string | undefined {
  const headers = new Headers(request.init.headers);

  return headers.get(name) ?? undefined;
}

async function checkSupabaseAdapter(): Promise<void> {
  const bytes = new TextEncoder().encode("%PDF-1.4 fake");
  const objectPath = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${COMPANY_ID}/kyc/passport.pdf`;

  // upload
  {
    const transport = fakeTransport([{ status: 200, body: JSON.stringify({ Key: `${BUCKET}/${KEY}` }) }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    const stored = await adapter.upload({ bucket: BUCKET, key: KEY, bytes, contentType: "application/pdf" });

    expectEqual(stored.provider, "supabase", "the supabase upload answers its provider");
    expectEqual(stored.byteSize, bytes.length, "and the size");
    expectEqual(transport.calls.length, 1, "one request is sent");
    expectEqual(transport.calls[0]?.url, objectPath, "the upload posts to the object endpoint");
    expectEqual(transport.calls[0]?.init.method, "POST", "with POST");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "apikey"), SUPABASE_ENV.SUPABASE_SERVICE_ROLE_KEY, "the apikey header carries the service role key");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "authorization"), `Bearer ${SUPABASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`, "and so does the bearer");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "content-type"), "application/pdf", "the content type is sent");
    expectEqual((transport.calls[0]?.init as { body?: unknown }).body, bytes, "the bytes are the body");
    expectEqual((transport.calls[0]?.init as { redirect?: string }).redirect, "error", "and redirects are refused");
  }

  // upload conflict
  {
    const transport = fakeTransport([{ status: 409, body: "duplicate" }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    const error = await rejectionOf(() => adapter.upload({ bucket: BUCKET, key: KEY, bytes, contentType: "application/pdf" }));
    expect(isStorageError(error) && (error as StorageError).code === "conflict", "a 409 answers conflict");
  }

  // download
  {
    const transport = fakeTransport([{ status: 200, body: bytes }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    const read = await adapter.download({ bucket: BUCKET, key: KEY });
    expectEqual(read.length, bytes.length, "the download returns the bytes");
    expectEqual(transport.calls[0]?.init.method, "GET", "with GET");
  }

  // download missing
  {
    const transport = fakeTransport([{ status: 404, body: "not found" }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    const error = await rejectionOf(() => adapter.download({ bucket: BUCKET, key: KEY }));
    expect(isStorageError(error) && (error as StorageError).code === "not_found", "a 404 answers not_found");
  }

  // remove
  {
    const transport = fakeTransport([{ status: 204 }, { status: 404, body: "not found" }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    await adapter.remove({ bucket: BUCKET, key: KEY });
    expectEqual(transport.calls[0]?.init.method, "DELETE", "the delete sends DELETE");
    const error = await rejectionOf(() => adapter.remove({ bucket: BUCKET, key: KEY }));
    expect(isStorageError(error) && (error as StorageError).code === "not_found", "a missing delete answers not_found");
  }

  // signed url
  {
    const signedPath = `/object/sign/${BUCKET}/${COMPANY_ID}/kyc/passport.pdf?token=abc123`;
    const transport = fakeTransport([{ status: 200, body: JSON.stringify({ signedURL: signedPath }) }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    const signed = await adapter.createSignedUrl({ bucket: BUCKET, key: KEY, expiresInSeconds: 300 });

    expectEqual(signed.url, `${SUPABASE_URL}/storage/v1${signedPath}`, "the signed path resolves against the project url");
    expectEqual(signed.expiresAt, new Date(NOW + 300_000).toISOString(), "and expires after the asked lifetime");
    expect(transport.calls[0]?.url.includes("/storage/v1/object/sign/") === true, "the sign endpoint is called");
    expectEqual(transport.calls[0]?.init.body, JSON.stringify({ expiresIn: 300 }), "with the lifetime in the body");
  }

  // a signed answer that is not a provider path is refused
  {
    const transport = fakeTransport([{ status: 200, body: JSON.stringify({ signedURL: "https://evil.example.test/x" }) }]);
    const adapter = createSupabaseStorageAdapter(SUPABASE_ENV, { fetch: transport.fetch, now: () => NOW });
    const error = await rejectionOf(() => adapter.createSignedUrl({ bucket: BUCKET, key: KEY, expiresInSeconds: 60 }));
    expect(isStorageError(error) && (error as StorageError).code === "provider_error", "an absolute signed answer is refused");
  }

  // a plain http endpoint is refused by the outbound policy before any request
  {
    const transport = fakeTransport([]);
    const adapter = createSupabaseStorageAdapter(
      { ...SUPABASE_ENV, SUPABASE_URL: "http://project-ref.supabase.co" },
      { fetch: transport.fetch, now: () => NOW },
    );
    const error = await rejectionOf(() => adapter.download({ bucket: BUCKET, key: KEY }));
    expect(isStorageError(error) && (error as StorageError).code === "unavailable", "a non-https endpoint answers unavailable");
    expectEqual(transport.calls.length, 0, "and no request is sent");
  }

  expect(SUPABASE_SIGNED_PATH_PREFIX === "/object/sign/", "the signed path prefix is declared");
  expectEqual(storageErrorForStatus(503).code, "provider_error", "a 5xx maps to provider_error");
  expectEqual(storageErrorForStatus(400).code, "invalid_input", "a 400 maps to invalid_input");
}

async function checkS3Adapter(): Promise<void> {
  const bytes = new TextEncoder().encode("%PDF-1.4 fake");
  const path = `${COMPANY_ID}/kyc/passport.pdf`;
  const objectUrl = `https://${S3_HOST}/${path}`;

  expectEqual(awsUriEncode("a b/c!"), "a%20b%2Fc%21", "awsUriEncode is RFC 3986 strict");
  expectEqual(amzDates(NOW).amzDate, "20261103T090000Z", "the amz date is derived from the instant");
  expectEqual(amzDates(NOW).dateStamp, "20261103", "and so is the date stamp");

  // upload signs the request with SigV4
  let firstAuthorization = "";
  {
    const transport = fakeTransport([{ status: 200 }, { status: 200 }]);
    const adapter = createS3StorageAdapter(S3_ENV, { fetch: transport.fetch, now: () => NOW });
    const stored = await adapter.upload({ bucket: "kd-files", key: KEY, bytes, contentType: "application/pdf" });
    await adapter.upload({ bucket: "kd-files", key: KEY, bytes, contentType: "application/pdf" });

    expectEqual(stored.provider, "s3", "the s3 upload answers its provider");
    expectEqual(transport.calls[0]?.url, objectUrl, "the upload targets the virtual-hosted url");
    expectEqual(transport.calls[0]?.init.method, "PUT", "with PUT");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "host"), S3_HOST, "the host header is signed");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "x-amz-date"), "20261103T090000Z", "the amz date header is sent");
    firstAuthorization = headerOf(transport.calls[0] as RecordedRequest, "authorization") ?? "";
    const expectedPrefix = `${S3_ALGORITHM} Credential=${S3_ENV.S3_ACCESS_KEY_ID}/20261103/us-east-1/s3/aws4_request, SignedHeaders=`;
    expect(firstAuthorization.startsWith(expectedPrefix), "the authorization header carries the credential scope");
    expect(/Signature=[0-9a-f]{64}$/u.test(firstAuthorization), "and a 64 hex signature");
    expectEqual(
      headerOf(transport.calls[1] as RecordedRequest, "authorization"),
      firstAuthorization,
      "the same input at the same instant signs identically",
    );
  }

  // the payload hash is the sha256 of the bytes
  {
    const transport = fakeTransport([{ status: 200 }]);
    const adapter = createS3StorageAdapter(S3_ENV, { fetch: transport.fetch, now: () => NOW });
    await adapter.upload({ bucket: "kd-files", key: KEY, bytes, contentType: "application/pdf" });
    const { createHash } = await import("node:crypto");
    const payloadHash = createHash("sha256").update(bytes).digest("hex");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "x-amz-content-sha256"), payloadHash, "the payload hash is the sha256 of the bytes");
    expectEqual(headerOf(transport.calls[0] as RecordedRequest, "content-type"), "application/pdf", "the content type is signed");
  }

  // download: bytes back, NoSuchKey mapped
  {
    const transport = fakeTransport([{ status: 200, body: bytes }, { status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" }]);
    const adapter = createS3StorageAdapter(S3_ENV, { fetch: transport.fetch, now: () => NOW });
    const read = await adapter.download({ bucket: "kd-files", key: KEY });
    expectEqual(read.length, bytes.length, "the s3 download returns the bytes");
    expectEqual(transport.calls[0]?.init.method, "GET", "with GET");

    const error = await rejectionOf(() => adapter.download({ bucket: "kd-files", key: KEY }));
    expect(isStorageError(error) && (error as StorageError).code === "not_found", "NoSuchKey answers not_found");
  }

  // remove
  {
    const transport = fakeTransport([{ status: 204 }]);
    const adapter = createS3StorageAdapter(S3_ENV, { fetch: transport.fetch, now: () => NOW });
    await adapter.remove({ bucket: "kd-files", key: KEY });
    expectEqual(transport.calls[0]?.init.method, "DELETE", "the delete sends DELETE");
  }

  // presigned url: no request is sent, the url carries the X-Amz parameters
  {
    const transport = fakeTransport([]);
    const adapter = createS3StorageAdapter(S3_ENV, { fetch: transport.fetch, now: () => NOW });
    const signed = await adapter.createSignedUrl({ bucket: "kd-files", key: KEY, expiresInSeconds: 120 });

    expectEqual(transport.calls.length, 0, "presigning sends no request");
    expect(signed.url.startsWith(`${objectUrl}?`), "the presigned url is the object url plus the query");
    expect(signed.url.includes(`X-Amz-Algorithm=${S3_ALGORITHM}`), "with the algorithm");
    expect(signed.url.includes("X-Amz-Expires=120"), "the asked lifetime");
    expect(signed.url.includes("X-Amz-SignedHeaders=host"), "host as the only signed header");
    expect(signed.url.includes(`X-Amz-Credential=${S3_ENV.S3_ACCESS_KEY_ID}%2F20261103%2Fus-east-1%2Fs3%2Faws4_request`), "the uri-encoded credential scope");
    expect(signed.url.includes("X-Amz-Date=20261103T090000Z"), "the amz date");
    expect(/[?&]X-Amz-Signature=[0-9a-f]{64}$/u.test(signed.url), "and the signature last");
    expect(!signed.url.includes(S3_ENV.S3_SECRET_ACCESS_KEY), "the secret never enters the url");
    expectEqual(signed.expiresAt, new Date(NOW + 120_000).toISOString(), "the expiry instant answers");
  }

  // only the configured bucket is served
  {
    const transport = fakeTransport([]);
    const adapter = createS3StorageAdapter(S3_ENV, { fetch: transport.fetch, now: () => NOW });
    const error = await rejectionOf(() => adapter.download({ bucket: "another-bucket", key: KEY }));
    expect(isStorageError(error) && (error as StorageError).code === "invalid_input", "another bucket is refused");
    expectEqual(transport.calls.length, 0, "before any request is built");
  }
}

function checkConfiguredRegistration(): void {
  const registry = new StorageAdapterRegistry();
  const transport = fakeTransport([]);
  const adapters = registerConfiguredAdapters(
    registry,
    { ...SUPABASE_ENV, STORAGE_PROVIDER: "supabase", ...S3_ENV },
    { fetch: transport.fetch, now: () => NOW },
  );

  expectEqual(adapters.length, 2, "both adapters are built");
  expectEqual(registry.size, 2, "and registered");
  expectEqual(registry.names().join(","), "supabase,s3", "under their provider names");
  expectEqual(adapterFor(registry, "s3").name, "s3", "adapterFor resolves the s3 one");
  expectEqual(adapterFor(registry, "supabase").name, "supabase", "and the supabase one");

  const supabaseOnly = new StorageAdapterRegistry();
  registerConfiguredAdapters(supabaseOnly, { ...SUPABASE_ENV, STORAGE_PROVIDER: "supabase" }, { fetch: transport.fetch, now: () => NOW });
  expectEqual(supabaseOnly.size, 1, "without the S3 fields only supabase registers");
  const unavailable = rejectionOfSync(() => adapterFor(supabaseOnly, "s3"));
  expect(isStorageError(unavailable) && (unavailable as StorageError).code === "unavailable", "and asking for s3 answers unavailable");

  const missing = rejectionOfSync(() =>
    registerConfiguredAdapters(new StorageAdapterRegistry(), { ...SUPABASE_ENV, STORAGE_PROVIDER: "s3" }),
  );
  expect(missing instanceof Error && /S3_BUCKET/u.test((missing as Error).message), "s3 without the S3 fields fails at wiring");

  const partial = rejectionOfSync(() =>
    registerConfiguredAdapters(new StorageAdapterRegistry(), { ...SUPABASE_ENV, S3_BUCKET: "kd-files" }),
  );
  expect(partial instanceof Error && /set together/u.test((partial as Error).message), "partial S3 fields fail at wiring");
}

const MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const ENCRYPTION_ENV = { ENCRYPTION_MASTER_KEY: MASTER_KEY };

function encryptionReason(error: unknown): string | null {
  if (isAppError(error) && error.cause !== null && typeof error.cause === "object" && "reason" in error.cause) {
    return String((error.cause as { readonly reason: unknown }).reason);
  }

  return null;
}

function checkEncryption(): void {
  const encryption = createFileEncryption(ENCRYPTION_ENV);
  const scope = { companyId: COMPANY_ID, purpose: "kyc_document" as const };
  const plaintext = new TextEncoder().encode("%PDF-1.4 fake kyc document");

  expectEqual(FILE_ENCRYPTION_ALGORITHM, "aes-256-gcm", "the only allowed cipher");
  expectEqual(FILE_ENCRYPTION_KEY_ID, "master-v1", "the master key id");
  expectEqual(FILE_ENCRYPTION_KEY_VERSION, 1, "and its version");
  expectEqual(keyVersionOfKeyId("master-v1"), 1, "the version of a key id");
  expectEqual(keyVersionOfKeyId("master-v999"), 999, "the ceiling version parses");
  expect(rejectionOfSync(() => keyVersionOfKeyId("master-v1000")) instanceof Error, "version 1000 is refused");
  expect(rejectionOfSync(() => keyVersionOfKeyId("master-x")) instanceof Error, "a key id without a version is refused");
  expect(rejectionOfSync(() => fileEncryptionKeyring({ ENCRYPTION_MASTER_KEY: "not-base64!!" })) instanceof Error, "a malformed master key is refused at the keyring");

  // scope
  expectEqual(fileEncryptionScope(scope), `file:${COMPANY_ID}:kyc_document`, "the scope binds tenant and purpose");
  expect(isStorageError(rejectionOfSync(() => fileEncryptionScope({ companyId: "not-a-uuid", purpose: "kyc_document" }))), "a malformed company id is refused");
  expect(isStorageError(rejectionOfSync(() => fileEncryptionScope({ companyId: COMPANY_ID, purpose: "evil" as never }))), "an unknown purpose is refused");

  // seal: envelope + quartet + hash
  const sealed = encryption.seal(plaintext, scope);
  expectEqual(new TextDecoder().decode(sealed.envelope.subarray(0, 4)), "KDF1", "the envelope carries the file magic");
  expect(isFileEnvelope(sealed.envelope), "the envelope is recognised without a key");
  expectEqual(sealed.algorithm, "aes-256-gcm", "the quartet algorithm");
  expectEqual(sealed.keyVersion, 1, "the quartet key version");
  expectEqual(Buffer.from(sealed.iv, "base64").length, 12, "the iv is the 12-byte base vector in base64");
  expectEqual(Buffer.from(sealed.tag, "base64").length, 16, "the tag is the 16-byte first-chunk tag in base64");
  expectEqual(sealed.plaintextSha256, createHashForTest(plaintext), "the hash is the sha256 of the plaintext");
  expectEqual(sealed.plaintextBytes, plaintext.length, "the plaintext size");
  expectEqual(sealed.ciphertextBytes, sealed.envelope.length, "the ciphertext size is the envelope");
  expect(sealed.envelope.length > plaintext.length, "the envelope is larger than the plaintext (header + tags)");

  // round trip
  const opened = encryption.open(sealed.envelope, scope);
  expectEqual(opened.length, plaintext.length, "the round trip returns the plaintext length");
  expectEqual(Buffer.from(opened).toString("utf8"), Buffer.from(plaintext).toString("utf8"), "the round trip returns the plaintext");

  // a second seal of the same plaintext differs (random base iv)
  expect(Buffer.from(encryption.seal(plaintext, scope).envelope).equals(Buffer.from(sealed.envelope)) === false, "two seals differ in the iv");

  // multi-chunk round trip
  const big = new Uint8Array(ENCRYPTION_CHUNK_BYTES + 100);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
  const bigSealed = encryption.seal(big, scope);
  const bigInfo = readFileEnvelopeInfo(bigSealed.envelope);
  expectEqual(bigInfo?.chunkCount, 2, "a file over one chunk seals two records");
  expectEqual(Buffer.from(encryption.open(bigSealed.envelope, scope)).equals(Buffer.from(big)), true, "the multi-chunk round trip returns the plaintext");

  // wrong tenant fails the tag
  const wrongTenant = encryption.seal(plaintext, { companyId: "018f2b8a-4444-4c2d-9c3e-000000000002", purpose: "kyc_document" });
  const crossTenant = rejectionOfSync(() => encryption.open(wrongTenant.envelope, scope));
  expect(encryptionReason(crossTenant) === "authentication_failed", "a ciphertext opened under another tenant fails the tag");
  const wrongPurpose = rejectionOfSync(() => encryption.open(sealed.envelope, { companyId: COMPANY_ID, purpose: "company_logo" }));
  expect(encryptionReason(wrongPurpose) === "authentication_failed", "a ciphertext opened under another purpose fails the tag");

  // tampering and truncation
  const tampered = Uint8Array.from(sealed.envelope);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
  expect(encryptionReason(rejectionOfSync(() => encryption.open(tampered, scope))) === "authentication_failed", "an edited byte fails the tag");
  const truncated = sealed.envelope.subarray(0, sealed.envelope.length - 5);
  expect(!isFileEnvelope(truncated), "a truncated envelope is not an envelope");
  expect(encryptionReason(rejectionOfSync(() => encryption.open(truncated, scope))) === "envelope_invalid", "a truncated envelope is refused");
  expect(encryptionReason(rejectionOfSync(() => encryption.open(plaintext, scope))) === "envelope_invalid", "plaintext that is not an envelope is refused");

  // size bounds
  expect(isStorageError(rejectionOfSync(() => encryption.seal(new Uint8Array(0), scope))), "an empty file is refused");
  expect(isStorageError(rejectionOfSync(() => encryption.seal(new Uint8Array(MAX_OBJECT_BYTES + 1), scope))), "an over-ceiling file is refused");
}

function createHashForTest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function checkEncryptedOperations(): Promise<void> {
  const encryption = createFileEncryption(ENCRYPTION_ENV);
  const adapter = new FakeAdapter("supabase");
  const audit = createInMemoryAuditTrail();
  const dependencies = { audit, now: () => NOW, encryption };
  const plaintext = new TextEncoder().encode("%PDF-1.4 fake kyc document");

  // encrypted upload: the adapter never sees the plaintext
  const result = await uploadEncryptedObject(
    adapter,
    { bucket: BUCKET, key: KEY, bytes: plaintext, contentType: "application/pdf" },
    access,
    dependencies,
  );
  expectEqual(result.stored.provider, "supabase", "the encrypted upload answers the provider");
  expectEqual(result.sealed.algorithm, "aes-256-gcm", "and the quartet");
  expectEqual((adapter.calls[0]?.input as { contentType?: string }).contentType, "application/octet-stream", "the envelope is uploaded as octet-stream");
  const uploadedBytes = (adapter.calls[0]?.input as { bytes?: string }).bytes;
  expectEqual(uploadedBytes, `<${result.sealed.ciphertextBytes} bytes>`, "the adapter received the envelope, not the plaintext");
  expect(result.sealed.ciphertextBytes > plaintext.length, "the envelope is bigger than the plaintext");
  expectEqual(audit.entries[0]?.action, FILE_UPLOADED_AUDIT_ACTION, "the encrypted upload is audited");
  const payload = audit.entries[0]?.payload ?? {};
  expectEqual(payload["encrypted"], true, "the audit says the object is encrypted");
  expectEqual(payload["encryption_algorithm"], "aes-256-gcm", "with the algorithm");
  expectEqual(payload["encryption_key_version"], 1, "the key version");
  expectEqual(payload["plaintext_sha256"], result.sealed.plaintextSha256, "and the plaintext hash");
  expectEqual(payload["byte_size"], result.sealed.ciphertextBytes, "the stored size is the ciphertext size");
  expectEqual(payload["content_type"], "application/pdf", "the real type stays in the record fields");

  // encrypted download: the adapter answers the envelope, the caller gets the plaintext
  const { stored } = result;
  void stored;
  const read = await downloadEncryptedObject(adapter, { bucket: BUCKET, key: KEY }, access, dependencies);
  expectEqual(Buffer.from(read).toString("utf8"), Buffer.from(plaintext).toString("utf8"), "the encrypted download decrypts to the plaintext");
  expectEqual((audit.entries[1]?.payload ?? {})["operation"], "download", "audited as a download");
  expectEqual((audit.entries[1]?.payload ?? {})["encrypted"], true, "audited as encrypted");

  // a stored object that is not an envelope is refused before decryption
  adapter.plant(BUCKET, KEY, plaintext);
  const notEnvelope = await rejectionOf(() => downloadEncryptedObject(adapter, { bucket: BUCKET, key: KEY }, access, dependencies));
  expect(isStorageError(notEnvelope) && (notEnvelope as StorageError).code === "provider_error", "a non-envelope object answers provider_error");

  // the tenant is required for the scope
  const noTenant = await rejectionOf(() =>
    uploadEncryptedObject(adapter, { bucket: BUCKET, key: KEY, bytes: plaintext, contentType: "application/pdf" }, { ...access, companyId: null }, dependencies),
  );
  expect(isStorageError(noTenant) && (noTenant as StorageError).code === "invalid_input", "an encrypted upload without a tenant is refused");
}

async function checkSources(): Promise<void> {
  const paths = [
    "lib/storage/types.ts",
    "lib/storage/registry.ts",
    "lib/storage/service.ts",
    "lib/storage/http.ts",
    "lib/storage/supabase-adapter.ts",
    "lib/storage/s3-adapter.ts",
    "lib/storage/adapters.ts",
    "lib/storage/encryption.ts",
    "lib/storage/verify.ts",
    "lib/storage/README.md",
  ];
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
  expect(service.includes("uploadEncryptedObject"), "the service seals before upload");
  expect(service.includes("downloadEncryptedObject"), "and opens after download");
  expect(service.includes("application/octet-stream"), "the envelope is uploaded as octet-stream");

  const registry = await readRepositoryFile("lib/storage/registry.ts");
  expect(registry.includes("getServerConfig().storageProvider"), "the active adapter comes from the environment configuration");
  expect(registry.includes('StorageError("unavailable"'), "an unwired provider answers unavailable");

  const supabase = await readRepositoryFile("lib/storage/supabase-adapter.ts");
  expect(supabase.includes("/storage/v1/object/"), "the supabase adapter speaks the storage rest api");
  expect(supabase.includes("/object/sign/"), "and signs through the sign endpoint");
  expect(supabase.includes("apikey"), "presenting the service role key as the apikey header");

  const s3 = await readRepositoryFile("lib/storage/s3-adapter.ts");
  expect(s3.includes("AWS4-HMAC-SHA256"), "the s3 adapter signs with SigV4");
  expect(s3.includes("node:crypto"), "using node:crypto, no sdk");
  expect(s3.includes("UNSIGNED-PAYLOAD"), "presigned urls sign no payload");
  expect(s3.includes("X-Amz-Signature"), "and carry the signature in the query");
  expect(s3.includes("requireConfiguredBucket"), "the s3 adapter pins the configured bucket");

  const wiring = await readRepositoryFile("lib/storage/adapters.ts");
  expect(wiring.includes("registerConfiguredAdapters"), "the wiring registers the configured adapters");
  expect(wiring.includes("serverEnv()"), "the default wiring reads the validated environment");

  const encryption = await readRepositoryFile("lib/storage/encryption.ts");
  expect(encryption.includes('"aes-256-gcm"'), "the cipher is fixed to aes-256-gcm");
  expect(encryption.includes("file:"), "the aad scope binds the file to tenant and purpose");
  expect(encryption.includes("ENCRYPTION_MASTER_KEY"), "the key comes from the environment");
  expect(encryption.includes("encryptFile"), "sealing delegates to the KDF1 envelope writer");
  expect(encryption.includes("decryptFile"), "opening delegates to the envelope reader");

  const http = await readRepositoryFile("lib/storage/http.ts");
  expect(http.includes('redirect: "error"'), "redirects are errors");
  expect(http.includes("checkOutboundUrl"), "every url is checked against the outbound policy");
}

async function main(): Promise<void> {
  checkVocabulary();
  checkRegistry();
  checkValidation();
  await checkOperations();
  await checkSupabaseAdapter();
  await checkS3Adapter();
  checkConfiguredRegistration();
  checkEncryption();
  await checkEncryptedOperations();
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
    `storage gate passed: ${checks} checks, ${STORAGE_ADAPTER_NAMES.length} adapter names (supabase + s3 wired), ` +
      `${STORAGE_ERROR_CODES.length} error codes, files sealed aes-256-gcm (${FILE_ENCRYPTION_KEY_ID}), ` +
      `signed urls ${SIGNED_URL_DEFAULT_TTL_SECONDS}s default / ${SIGNED_URL_MAX_TTL_SECONDS}s max\n`,
  );
}

await main();
