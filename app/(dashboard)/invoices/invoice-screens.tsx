// path: app/(dashboard)/invoices/invoice-screens.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import {
  getInvoice,
  listInvoiceClientOptions,
  type InvoiceClientOptions,
  type InvoiceSnapshot,
} from "@/services/invoices/invoices";
import { readOwnerActor } from "../onboarding/owner-actor";
import { InvoiceForm } from "./invoice-form";
import { InvoiceLineEditor } from "./invoice-line-editor";

/**
 * Section 16's invoice create screen.
 *
 * ## Why the client list is read here and not in the browser
 *
 * The selector needs the merchant's own client book, and the scope that makes that true - the company
 * from the session, the role, the live rows only - lives in the service. Reading it on the server means
 * the page cannot be tricked into offering another merchant's clients, and the form opens with its
 * options already there instead of an empty box that fills a second later.
 *
 * ## Why the four refusals are kept apart
 *
 * Signed out, not an owner, the book unavailable, and a book with no clients in it are four different
 * facts. A page that printed "no clients" for an outage would tell a merchant their book was erased, and
 * a page that printed the form to a visitor with no session would invite a post with nothing behind it.
 * Each state is worded as itself, and none of them restates a role: the service decides who may read.
 *
 * ## The width
 *
 * One column, capped at `max-w-3xl`, `px-4` on a phone growing to `px-8` on a desktop. The line editor
 * inside it puts a quantity and a price side by side only from `sm` up, because at 360px two columns of
 * money are two columns of clipped text.
 */

type ScreenState =
  | { readonly kind: "signed-out" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly options: InvoiceClientOptions };

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export function invoiceMetadata(): Metadata {
  return {
    title: getMessage("invoices.newTitle"),
    description: getMessage("invoices.newDescription"),
  };
}

/**
 * The due date the form opens with: thirty days from today, as a `yyyy-mm-dd` date box value.
 *
 * Computed on the server so the page renders deterministically and the merchant on a phone whose clock
 * is wrong still sees the date the server believes. The form treats it as an initial value; changing it
 * is the browser's own state afterwards.
 */
function defaultDueDate(): string {
  return new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
}

async function readScreenState(): Promise<ScreenState> {
  const actorState = await readOwnerActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out" };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable" };
  }

  const runtime = getAuthRuntime();

  try {
    const options = await listInvoiceClientOptions({ actor: actorState.actor }, { rest: runtime.rest });

    return { kind: "ready", options };
  } catch (error) {
    if (error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out" };
    }

    if (error instanceof AppError && error.code === "PERMISSION_DENIED") {
      return { kind: "forbidden" };
    }

    return { kind: "unavailable" };
  }
}

function refusalSentence(state: ScreenState): string {
  if (state.kind === "signed-out") {
    return getMessage("invoices.signedOut");
  }

  if (state.kind === "forbidden") {
    return getMessage("invoices.forbidden");
  }

  return getMessage("invoices.unavailable");
}

/**
 * One draft, with its line editor.
 *
 * ## Why the refusal states are the create screen's own
 *
 * Signed out, not an owner, the store unavailable and the invoice genuinely not there are four different
 * facts, and `getInvoice` answers the middle two with the same codes the create path does. Rather than
 * restating the wording, this screen reuses `refusalSentence` - a merchant who has reached this page by a
 * shared link and has no session is told to sign in, not told their invoice does not exist.
 *
 * ## Why a sent invoice renders the editor at all
 *
 * A draft is the only thing this STEP can edit, but an invoice that has been sent is not a 404 - it
 * exists, and its lines are visible. The pages differ only in whether the controls are offered, which the
 * editor decides from the status rather than this screen hiding the document.
 */
export async function InvoiceEditorScreen({
  invoiceId,
}: {
  readonly invoiceId: string;
}): Promise<ReactNode> {
  const actorState = await readOwnerActor();
  let state: { readonly kind: "ready"; readonly invoice: InvoiceSnapshot } | { readonly kind: string } = {
    kind: "unavailable",
  };

  if (actorState.kind === "anonymous") {
    state = { kind: "signed-out" };
  } else if (actorState.kind === "actor") {
    const runtime = getAuthRuntime();

    try {
      state = {
        kind: "ready",
        invoice: await getInvoice(
          { actor: actorState.actor, invoiceId },
          { rest: runtime.rest, audit: runtime.audit },
        ),
      };
    } catch (error) {
      state =
        error instanceof AppError && error.code === "AUTHENTICATION_REQUIRED"
          ? { kind: "signed-out" }
          : error instanceof AppError && error.code === "PERMISSION_DENIED"
            ? { kind: "forbidden" }
            : error instanceof AppError && error.code === "RESOURCE_NOT_FOUND"
              ? { kind: "not-found" }
              : { kind: "unavailable" };
    }
  }

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("invoices.editorEyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("invoices.editTitle")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("invoices.editDescription")}</p>
        </header>

        {"invoice" in state && state.invoice !== undefined ? (
          <>
            <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("invoices.clientLabel")}</dt>
                <dd className="font-medium">{state.invoice.client.name}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("invoices.editorStatus")}</dt>
                <dd className="font-medium">{state.invoice.status}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("invoices.editorDueDate")}</dt>
                <dd className="font-medium">{state.invoice.dueAt.slice(0, 10)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("invoices.total")}</dt>
                <dd className="font-medium">{state.invoice.totals.total}</dd>
              </div>
            </dl>
            <InvoiceLineEditor invoice={state.invoice} />
          </>
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {refusalSentence(state as ScreenState)}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          <Link className={linkClasses} href="/invoices/new">
            {getMessage("invoices.editorNewInvoice")}
          </Link>
          <Link className={linkClasses} href="/clients">
            {getMessage("invoices.clientsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("invoices.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}

export async function InvoiceCreateScreen(): Promise<ReactNode> {
  const state = await readScreenState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("invoices.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {getMessage("invoices.newTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">{getMessage("invoices.newDescription")}</p>
        </header>

        {state.kind === "ready" ? (
          state.options.clients.length === 0 ? (
            <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <p className="text-sm" role="alert">
                {getMessage("invoices.clientNone")}
              </p>
              <Link className={linkClasses} href="/clients/new">
                {getMessage("invoices.clientAddLink")}
              </Link>
            </section>
          ) : (
            <InvoiceForm
              clients={state.options.clients}
              clientsTruncated={state.options.truncated}
              defaultDueDate={defaultDueDate()}
            />
          )
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {refusalSentence(state)}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          {state.kind === "signed-out" ? (
            <Link className={linkClasses} href="/signin">
              {getMessage("catalogue.signInLink")}
            </Link>
          ) : null}
          <Link className={linkClasses} href="/clients">
            {getMessage("invoices.clientsLink")}
          </Link>
          <Link className={linkClasses} href="/products">
            {getMessage("invoices.productsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("invoices.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
