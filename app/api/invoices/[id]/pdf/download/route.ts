// path: app/api/invoices/[id]/pdf/download/route.ts
import { NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { withErrorResponse } from "@/lib/errors/respond";
import { logger } from "@/lib/logger/logger";
import {
  invoicePdfDependencies,
  readInvoicePdfBytes,
} from "@/services/invoices/invoice-pdf-document";

export const dynamic = "force-dynamic";

/**
 * The bytes of one invoice's rendered PDF.
 *
 * ## Why this is a route and not a signed URL
 *
 * Section 21 stores every file sealed with AES-256-GCM, so the object a provider holds is an envelope:
 * a signed URL to it would hand a merchant ciphertext. The bytes are decrypted here, inside the
 * request, under the tenant and purpose they were sealed for, and the read is audited by the storage
 * layer as `file.accessed` on the way out.
 *
 * ## Why attachment and never inline
 *
 * `lib/security/upload.ts` leaves the rule behind: whatever serves a stored file sends
 * `content-disposition: attachment` and keeps `nosniff`. A PDF is a document a reader will execute the
 * moment it is displayed, and this platform's answer to that is to let the merchant's own viewer open
 * it, never a frame of ours. The file name is the merchant's invoice number through the file name
 * sanitiser and then a header-safe filter, because a `Content-Disposition` is a header and a quote
 * inside a name is how one is injected.
 *
 * ## Why a document that is not ready is a 404
 *
 * There are no bytes to serve. The state endpoint is where a screen learns whether a render is queued,
 * running or failed; this route answers the one question it can, which is whether the document exists.
 */
export const GET = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<Response> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const invoiceId = decodeURIComponent((await context.params).id);
    const download = await readInvoicePdfBytes({ actor, invoiceId }, invoicePdfDependencies());

    logger.info("invoice pdf downloaded", {
      userId: actor.userId,
      invoiceId,
      fileId: download.fileId,
      byteSize: download.byteSize,
      generation: download.generation,
    });

    // A response body must be backed by its own `ArrayBuffer`: the bytes the storage layer decrypted
    // may be a window into a larger pooled allocation, and handing that window to the platform would
    // let a later read of the pool reach into a document on its way to a merchant.
    return new NextResponse(download.bytes.slice(), {
      status: 200,
      headers: {
        "content-type": download.contentType,
        "content-disposition": `attachment; filename="${download.fileName}"`,
        "content-length": download.byteSize.toString(),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
);
