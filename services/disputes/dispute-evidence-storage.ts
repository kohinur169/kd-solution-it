// path: services/disputes/dispute-evidence-storage.ts
import type { AuditTrail } from "../../lib/auth/audit.ts";
import type { RestClient } from "../../lib/auth/rest.ts";
import { AppError } from "../../lib/errors/app-error.ts";
import { markFileVerified, newStorageKey, recordUploadedFile } from "../../lib/storage/records.ts";
import { DEFAULT_STORAGE_BUCKET } from "../../lib/storage/types.ts";
import { uploadEncryptedObject } from "../../lib/storage/service.ts";
import type { StorageFileEncryption } from "../../lib/storage/encryption.ts";
import type { StorageAdapter } from "../../lib/storage/types.ts";
import type { DisputeEvidenceStorage } from "./dispute-evidence.ts";

/**
 * The document port of the evidence pack, bound to the platform's own storage layer.
 *
 * ## Why this file exists at all
 *
 * `dispute-evidence.ts` holds the rule ("a supplied document is a PDF, JPEG or PNG whose bytes match the type
 * they claim, sealed before they leave the process, and recorded with its digest") and this file holds the
 * wiring. The split is the same one `lib/storage/kyc.ts` makes: a service that talks to a bucket directly
 * cannot be exercised without one, and a STEP that leaves the rule to the bucket cannot be exercised at all.
 *
 * ## The three writes, in this order
 *
 *   1. **The encrypted upload** - section 21: "Every file is AES-256-GCM encrypted before upload". The bytes
 *      are sealed for this tenant and the `dispute_document` purpose and only the envelope reaches the
 *      adapter, which is why a bucket leak is not a client's correspondence leak.
 *   2. **The `0057` row** - the ciphertext quartet, the plaintext digest, the size and the provider, written by
 *      `recordUploadedFile`. That row is what a download signs against later, and what proves the file
 *      existed before it was attached to a pack.
 *   3. **The verified status** - `markFileVerified` moves the record to `ready`, which is the only state a
 *      document a merchant attached should be in. A quarantined upload never reaches this module at all: the
 *      bytes are checked before they are handed here.
 *
 * ## What is copied and what is not
 *
 * The pack's document row copies the key and the digest and keeps the `files` id, so a reviewer's read is one
 * query; the ciphertext and the key material stay where the storage layer keeps them. No byte of a document
 * ever enters an audit entry, a view or a log line from this module.
 */

/** What one document write needs: the adapter, the seal, and the two stores the platform already has. */
export interface DisputeEvidenceStorageDependencies {
  readonly adapter: StorageAdapter;
  readonly encryption: StorageFileEncryption;
  readonly rest: RestClient;
  readonly audit: AuditTrail;
  readonly now?: () => number;
}

/**
 * Build the port a pack's documents are attached through.
 *
 * The key is `newStorageKey`'s - `<company>/dispute_document/<uuid>` - so the tenant prefix `0057` demands is
 * the one the storage layer already produces, and two uploads of the same file never fork the unique key
 * index. The digest the pack records is the one the seal computed over the plaintext, and this module refuses
 * to hand back a record whose digest disagrees with the one it was asked to store: two digests for one file is
 * the shape of a mix-up that would surface months later in a processor's review.
 */
export function createDisputeEvidenceStorage(
  dependencies: DisputeEvidenceStorageDependencies,
): DisputeEvidenceStorage {
  const audit = dependencies.audit;
  const now = dependencies.now;

  return {
    async put(input) {
      const key = newStorageKey(input.companyId, "dispute_document");
      const access = {
        actorUserId: input.actorUserId,
        companyId: input.companyId,
        purpose: "dispute_document",
      };
      const { stored, sealed } = await uploadEncryptedObject(
        dependencies.adapter,
        { bucket: DEFAULT_STORAGE_BUCKET, key, bytes: input.bytes, contentType: input.contentType },
        access,
        {
          encryption: dependencies.encryption,
          audit,
          ...(now === undefined ? {} : { now }),
        },
      );

      const recordDependencies = {
        rest: dependencies.rest,
        audit,
        ...(now === undefined ? {} : { now }),
      };

      const record = await recordUploadedFile(recordDependencies, {
        companyId: input.companyId,
        uploadedBy: input.actorUserId,
        purpose: "dispute_document",
        contentType: input.contentType,
        stored,
        sealed,
      });

      if (record.content_sha256 !== sealed.plaintextSha256) {
        // The record must describe the bytes that were sealed. A row that says otherwise is a row a processor
        // could be shown that is not the file the merchant supplied.
        throw new AppError("INTERNAL_ERROR");
      }

      const verified = await markFileVerified(recordDependencies, {
        companyId: input.companyId,
        fileId: record.id,
      });

      return { storageKey: verified.storage_key, fileId: verified.id };
    },
  };
}
