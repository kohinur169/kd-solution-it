// path: app/(dashboard)/products/delete-catalogue-form.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";
import { CATALOGUE_PATHS, type CatalogueKind } from "@/services/products/catalogue-fields";

/**
 * The removal of one catalogue entry, from its edit screen.
 *
 * ## Why the confirmation is a state and not `window.confirm`
 *
 * A browser dialog blocks the page, cannot be styled or translated to the rest of the screen, and on
 * a phone it is easy to dismiss with the wrong gesture. The confirmation here is a second step in the
 * page itself: the first button reveals the question and the consequence in plain words, the second
 * performs it, and the way out is a button rather than a dismissed dialog. Nothing happens on the
 * first press, so a misplaced click costs a second click and not an entry.
 *
 * ## Why it sends `DELETE` with the token and no body
 *
 * A removal is a mutation, so it carries the CSRF token like every other write of this block - the
 * service has no fields to change, so the request has no body and the token travels in the
 * `x-csrf-token` header. The service marks the row and keeps it (`0020`/`0021` carry `deleted_at`
 * because an invoice line quotes this entry), which is why the sentence says the entry leaves the
 * catalogue rather than that it is erased.
 *
 * ## Why a failure stays on the page
 *
 * If the removal is refused - a stale session, the row already gone in another tab, the service out -
 * the entry stays on screen and the sentence says so. Navigating away on a refusal is how a merchant
 * comes to believe an entry was removed when it is still there, and the invoice written against it
 * would then be a surprise.
 */

const dangerButtonClasses =
  "w-fit rounded-md border border-destructive px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-60";

const confirmButtonClasses =
  "w-fit rounded-md bg-destructive px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-destructive disabled:opacity-60";

const cancelButtonClasses =
  "w-fit rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary";

interface DeleteCatalogueFormProps {
  readonly kind: CatalogueKind;
  /** The row to remove; the id is the path and never a body field. */
  readonly entryId: string;
  /** The name shown in the question, so the merchant confirms the row they are looking at. */
  readonly entryName: string;
}

export function DeleteCatalogueForm({
  kind,
  entryId,
  entryName,
}: DeleteCatalogueFormProps): ReactNode {
  const router = useRouter();
  const [confirming, setConfirming] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [failed, setFailed] = useState<boolean>(false);
  const listPath = `/${CATALOGUE_PATHS[kind]}`;

  async function remove(): Promise<void> {
    setBusy(true);
    setFailed(false);

    try {
      const response = await fetch(`/api/${CATALOGUE_PATHS[kind]}/${encodeURIComponent(entryId)}`, {
        method: "DELETE",
        headers: { ...(await csrfHeaders()) },
        credentials: "same-origin",
        cache: "no-store",
      });

      if (!response.ok) {
        setFailed(true);

        return;
      }

      router.push(listPath);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="catalogue-delete-heading"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h2 className="text-base font-semibold" id="catalogue-delete-heading">
        {getMessage("catalogue.deleteHeading")}
      </h2>

      {confirming ? (
        <>
          <p className="text-sm text-muted-foreground">
            {getMessage("catalogue.deleteConfirm")} {entryName}
          </p>
          <p className="text-xs text-muted-foreground">{getMessage("catalogue.deleteConsequence")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              className={confirmButtonClasses}
              disabled={busy}
              onClick={() => {
                void remove();
              }}
              type="button"
            >
              {getMessage(busy ? "catalogue.deleting" : "catalogue.deleteConfirmButton")}
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
              {getMessage("catalogue.deleteCancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{getMessage("catalogue.deleteDescription")}</p>
          <button
            className={dangerButtonClasses}
            onClick={() => {
              setConfirming(true);
            }}
            type="button"
          >
            {getMessage(kind === "product" ? "catalogue.deleteProduct" : "catalogue.deleteService")}
          </button>
        </>
      )}

      {failed ? (
        <p className="text-sm text-destructive" role="alert">
          {getMessage("catalogue.deleteFailed")}
        </p>
      ) : null}
    </section>
  );
}
