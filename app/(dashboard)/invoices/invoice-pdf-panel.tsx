// path: app/(dashboard)/invoices/invoice-pdf-panel.tsx
"use client";

import { useState, type ReactNode } from "react";
import { formatMessage, getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import {
  INVOICE_PDF_NO_DOCUMENT,
  type InvoicePdfState,
} from "@/services/invoices/invoice-pdf-state";

/**
 * The invoice PDF panel of section 16: the state of a background render, and the two things a merchant
 * can do about it.
 *
 * ## Why the panel never waits
 *
 * Section 28 puts PDF generation in a job, so the honest interface is a state and a way to ask again -
 * not a spinner that holds the page while a document is drawn. The panel opens with the state the server
 * component read, a request answers `202` with the state it wrote, and "Check again" re-reads it. A
 * merchant who walks away comes back to a ready document rather than to a page that was still loading.
 *
 * ## Why the download is a plain link
 *
 * It is a `GET` of the merchant's own document, so there is nothing to defend with a token and nothing to
 * submit: an anchor the browser can follow, keep and open in a viewer. The route behind it answers the
 * bytes as an attachment, decrypted, and records the access.
 *
 * ## The four sentences
 *
 * Nothing rendered yet, queued, being made, and failed are four different facts and read as four
 * different sentences. A failure names the code it was recorded with, because a merchant quoting
 * `DEPENDENCY_FAILED` to support is a merchant who can be answered; the words of the failure itself never
 * leave the server.
 *
 * ## The width
 *
 * One column on a phone, the state and the controls side by side from `sm` up, and the controls wrap
 * rather than shrink, so "Download the PDF" is never a truncated tap target at 360px.
 */

const buttonClasses =
  "rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const primaryClasses =
  "rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-40";
const linkClasses =
  "rounded-md border border-border px-3 py-2 text-xs font-medium text-primary underline-offset-4 transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

export interface InvoicePdfPanelProps {
  readonly invoiceId: string;
  /** The state the server component read, so the panel opens already knowing. */
  readonly initial: InvoicePdfState;
  /** True when the invoice is still a draft, which is what the stamp on its PDF is for. */
  readonly draft: boolean;
  /** True when the server could not read the state at all, which is not the same as "none". */
  readonly readFailed: boolean;
}

interface StateBody {
  readonly state?: InvoicePdfState;
}

function stateOf(payload: unknown): InvoicePdfState | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const body = payload as StateBody;

  return typeof body.state === "object" && body.state !== null ? body.state : null;
}

/** The date half of an ISO instant, which is the scale a merchant reads a render at. */
function instantOf(iso: string | null): string {
  return iso === null ? "" : iso.slice(0, 16).replace("T", " ");
}

/** Asking for a first PDF and asking for another one are two different buttons, in words. */
function requestLabel(status: InvoicePdfState["status"], requesting: boolean): string {
  if (requesting) {
    return getMessage("invoices.pdfPanelRequesting");
  }

  return status === INVOICE_PDF_NO_DOCUMENT || status === "failed"
    ? getMessage("invoices.pdfPanelGenerate")
    : getMessage("invoices.pdfPanelRegenerate");
}

export function InvoicePdfPanel({
  invoiceId,
  initial,
  draft,
  readFailed,
}: InvoicePdfPanelProps): ReactNode {
  const [state, setState] = useState<InvoicePdfState>(initial);
  const [requesting, setRequesting] = useState(false);
  const [checking, setChecking] = useState(false);
  // A state the server could not read opens as an unread state, not as "nothing has been made": the
  // merchant is told the panel does not know, and the first button press is what finds out.
  const [error, setError] = useState<string | null>(
    readFailed ? getMessage("invoices.pdfPanelReadFailed") : null,
  );

  const busy = requesting || checking;
  const pending = state.status === "queued" || state.status === "rendering";

  async function request(): Promise<void> {
    setRequesting(true);
    setError(null);

    try {
      const response = await fetch(`/api/invoices/${invoiceId}/pdf`, {
        method: "POST",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      const next = stateOf(payload);

      if (!response.ok || next === null) {
        setError(getMessage("invoices.pdfPanelRequestFailed"));

        return;
      }

      setState(next);
    } catch {
      setError(getMessage("invoices.pdfPanelRequestFailed"));
    } finally {
      setRequesting(false);
    }
  }

  async function refresh(): Promise<void> {
    setChecking(true);
    setError(null);

    try {
      const response = await fetch(`/api/invoices/${invoiceId}/pdf`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload: unknown = await response.json().catch(() => null);
      const next = stateOf(payload);

      if (!response.ok || next === null) {
        setError(getMessage("invoices.pdfPanelReadFailed"));

        return;
      }

      setState(next);
    } catch {
      setError(getMessage("invoices.pdfPanelReadFailed"));
    } finally {
      setChecking(false);
    }
  }

  function sentence(): string {
    switch (state.status) {
      case INVOICE_PDF_NO_DOCUMENT:
        return getMessage("invoices.pdfPanelNone");
      case "queued":
        return getMessage("invoices.pdfPanelQueued");
      case "rendering":
        return getMessage("invoices.pdfPanelRendering");
      case "ready":
        return formatMessage("invoices.pdfPanelReady", { instant: instantOf(state.renderedAt) });
      case "failed":
        return getMessage("invoices.pdfPanelFailed");
      default:
        return getMessage("invoices.pdfPanelNone");
    }
  }

  return (
    <section
      aria-labelledby="invoice-pdf-title"
      className="flex flex-col gap-4 rounded-lg border border-border p-4 text-sm"
    >
      <div className="flex flex-col gap-1">
        <h2 id="invoice-pdf-title" className="text-base font-semibold">
          {getMessage("invoices.pdfPanelTitle")}
        </h2>
        <p className="text-xs text-muted-foreground">{getMessage("invoices.pdfPanelDescription")}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={state.status === "failed" ? "text-sm text-destructive" : "text-sm"} role="status">
            {sentence()}
          </p>

          {state.status === "ready" && state.byteSize !== null ? (
            <p className="text-xs text-muted-foreground">
              {formatMessage("invoices.pdfPanelSize", { bytes: state.byteSize })}
              {state.generation > 1
                ? ` ${formatMessage("invoices.pdfPanelGeneration", { generation: state.generation })}`
                : ""}
            </p>
          ) : null}

          {state.status === "failed" && state.lastErrorCode !== null ? (
            <p className="text-xs text-muted-foreground">
              {formatMessage("invoices.pdfPanelFailureReference", { code: state.lastErrorCode })}
            </p>
          ) : null}

          {draft ? <p className="text-xs text-muted-foreground">{getMessage("invoices.pdfPanelDraftNote")}</p> : null}

          {error !== null ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {state.ready ? (
            <a
              className={linkClasses}
              href={`/api/invoices/${invoiceId}/pdf/download`}
              download
              rel="noreferrer"
            >
              {getMessage("invoices.pdfPanelDownload")}
            </a>
          ) : null}

          {/* A render already in flight is not asked for again: the control that answers it is "check
              again", and the request behind this one would only be told the same thing. */}
          <button
            className={state.ready ? buttonClasses : primaryClasses}
            type="button"
            onClick={() => void request()}
            disabled={busy || pending}
          >
            {requestLabel(state.status, requesting)}
          </button>

          <button className={buttonClasses} type="button" onClick={() => void refresh()} disabled={busy}>
            {checking ? getMessage("invoices.pdfPanelRefreshing") : getMessage("invoices.pdfPanelRefresh")}
          </button>
        </div>
      </div>
    </section>
  );
}
