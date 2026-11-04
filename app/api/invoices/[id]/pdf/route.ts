// path: app/api/invoices/[id]/pdf/route.ts
import { after, NextResponse } from "next/server";
import { readRequestActor } from "@/lib/auth/request-actor";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { withErrorResponse } from "@/lib/errors/respond";
import { getJobRuntime } from "@/lib/jobs/runtime";
import { logger } from "@/lib/logger/logger";
import { requireCsrfToken } from "@/lib/security/csrf";
import {
  readInvoicePdfState,
  requestInvoicePdf,
  type InvoicePdfState,
} from "@/services/invoices/invoice-pdf-document";

export const dynamic = "force-dynamic";

interface PdfStateBody {
  readonly state: InvoicePdfState;
}

interface PdfRequestBody {
  readonly status: "accepted";
  /** True when a render was already queued or running and this request added no work. */
  readonly deduplicated: boolean;
  readonly state: InvoicePdfState;
}

/**
 * The rendered PDF of one invoice: its state, and the request that makes one.
 *
 * ## Why a read and a write share a path
 *
 * They address the same object - this invoice's document - and the write answers with what the read
 * would, so a screen that asked for a render shows the new state without a second round trip.
 *
 * ## Why the POST answers 202 and not the document
 *
 * Section 28 is the rule: "Request handlers validate, write minimal rows and enqueue." This handler
 * reads the session, writes one row of `0115` and puts a job on the queue, which is milliseconds; the
 * render, the encryption and the upload are the job's, and a request that waited for them would hold a
 * serverless invocation open for the length of a document. `202` says exactly that: accepted, not done.
 *
 * ## Why the queue is ticked after the response
 *
 * The durable worker belongs to the deployment STEPs, and until it runs there would be a row that says
 * `queued` and nothing that ever moves it. `after` is the platform's own post-response hook: the
 * merchant already has their answer, and one claimed job runs on the way out. It is one job, not a
 * loop, so a request can never become a worker; when the deployment STEPs start the real worker this
 * tick becomes a redundancy rather than the only thing that renders.
 *
 * ## The order of the checks
 *
 * CSRF first, then the session, then the path's id, then the service - which applies the `owner` role,
 * scopes the invoice to the caller's company and refuses a document row another request is already
 * rendering.
 */
export const GET = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<PdfStateBody>> => {
    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const invoiceId = decodeURIComponent((await context.params).id);
    const state = await readInvoicePdfState(
      { actor, invoiceId },
      { rest: runtime.rest, audit: runtime.audit },
    );

    return NextResponse.json({ state }, { status: 200, headers: { "cache-control": "no-store" } });
  },
);

export const POST = withErrorResponse(
  async (
    request: Request,
    context: { readonly params: Promise<{ readonly id: string }> },
  ): Promise<NextResponse<PdfRequestBody>> => {
    requireCsrfToken(request, { secure: getAuthRuntime().cookiePolicy.secure });

    const runtime = getAuthRuntime();
    const actor = await readRequestActor(request.headers.get("cookie"), {
      directory: runtime.directory,
      cookiePolicy: runtime.cookiePolicy,
      sessions: runtime.sessions,
      audit: runtime.audit,
    });
    const invoiceId = decodeURIComponent((await context.params).id);

    if (invoiceId.length === 0 || invoiceId.length > 64) {
      throw new AppError("VALIDATION_FAILED", { details: [{ field: "id", rule: "invalid_format" }] });
    }

    const jobs = getJobRuntime();
    const result = await requestInvoicePdf(
      { actor, invoiceId },
      { rest: runtime.rest, audit: runtime.audit, registry: jobs.registry, queue: jobs.queue },
    );

    logger.info("invoice pdf render requested", {
      userId: actor.userId,
      invoiceId,
      documentId: result.state.documentId,
      status: result.state.status,
      deduplicated: result.deduplicated,
    });

    try {
      after(async () => {
        const ran = await jobs.worker.runOnce();

        logger.info("invoice pdf queue tick", {
          ran: ran.ran,
          status: ran.status,
          jobId: ran.jobId,
        });
      });
    } catch {
      // Outside a request scope there is nothing to defer to; the job stays queued for the worker.
    }

    return NextResponse.json(
      { status: "accepted", deduplicated: result.deduplicated, state: result.state },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  },
);
