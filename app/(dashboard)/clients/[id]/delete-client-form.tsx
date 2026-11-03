// path: app/(dashboard)/clients/[id]/delete-client-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The removal of one client, from the edit screen.
 *
 * ## Why the confirmation is a state and not `window.confirm`
 *
 * A browser dialog blocks the page, cannot be styled or translated to the rest of the screen, and on
 * a phone it is easy to dismiss with the wrong gesture. The confirmation here is a second step in the
 * page itself: the first button reveals the question and the consequence in plain words, the second
 * performs it, and the way out is a button rather than a dismissed dialog. Nothing happens on the
 * first press, so a misplaced click costs a second click and not a client.
 *
 * ## Why it sends `DELETE` with the token and no body
 *
 * A removal is a mutation, so it carries the CSRF token like every other write of this block - the
 * service has no fields to change, so the request has no body and the token travels in the
 * `x-csrf-token` header. The service marks the row and keeps it (`0019`'s soft delete), which is why
 * the sentence says the client leaves the list rather than that it is erased.
 *
 * ## Why a failure stays on the page
 *
 * If the removal is refused - a stale session, the row already removed in another tab, the service
 * out - the client stays where it is and the sentence says so. Navigating away on a refusal is how a
 * merchant comes to believe a row was removed when it is still there, and the invoice written against
 * it would then be a surprise.
 */

const dangerButtonClasses =
  "w-fit rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-60";

const confirmButtonClasses =
  "w-fit rounded-md bg-destructive px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-60";

const cancelButtonClasses =
  "w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

interface DeleteClientFormProps {
  /** The row to remove; the id is the path and never a body field. */
  readonly clientId: string;
  /** The name shown in the question, so the merchant confirms the row they are looking at. */
  readonly clientName: string;
}

export function DeleteClientForm({ clientId, clientName }: DeleteClientFormProps): ReactNode {
  const router = useRouter();
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);

  async function remove(): Promise<void> {
    setBusy(true);
    setFailed(false);

    try {
      const response = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, {
        method: "DELETE",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        setFailed(true);

        return;
      }

      router.push("/clients");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="client-delete-heading"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h2 className="text-base font-semibold" id="client-delete-heading">
        {getMessage("clients.deleteHeading")}
      </h2>

      {confirming ? (
        <>
          <p className="text-sm text-muted-foreground">
            {getMessage("clients.deleteConfirm")} {clientName}
          </p>
          <p className="text-xs text-muted-foreground">{getMessage("clients.deleteConsequence")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={confirmButtonClasses}
              disabled={busy}
              onClick={() => {
                void remove();
              }}
              type="button"
            >
              {getMessage(busy ? "clients.deleting" : "clients.deleteConfirmButton")}
            </button>
            <button
              className={cancelButtonClasses}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setFailed(false);
              }}
              type="button"
            >
              {getMessage("clients.deleteCancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{getMessage("clients.deleteDescription")}</p>
          <button
            className={dangerButtonClasses}
            onClick={() => {
              setConfirming(true);
            }}
            type="button"
          >
            {getMessage("clients.deleteClient")}
          </button>
        </>
      )}

      {failed ? (
        <p className="text-sm text-destructive" role="alert">
          {getMessage("clients.deleteFailed")}
        </p>
      ) : null}
    </section>
  );
}
