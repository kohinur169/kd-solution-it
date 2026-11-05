// path: app/(dashboard)/estimates/estimate-screens.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { SessionKeeper } from "@/components/auth/session-keeper";
import { getAuthRuntime } from "@/lib/auth/runtime";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { ESTIMATE_EXPIRY_MAXIMUM_DAYS } from "@/services/estimates/estimate-fields";
import { getEstimate, type EstimateSnapshot } from "@/services/estimates/estimates";
import {
  listInvoiceClientOptions,
  type InvoiceClientOptions,
} from "@/services/invoices/invoices";
import { readOwnerActor } from "../onboarding/owner-actor";
import { EstimateForm } from "./estimate-form";
import { EstimateLineEditor } from "./estimate-line-editor";

/**
 * Section 16's estimate screens: the create form and the editor of one draft.
 *
 * ## Why the client list is read here and not in the browser
 *
 * The selector needs the merchant's own client book, and the scope that makes that true - the company from
 * the session, the role, the live rows only - lives in the service. Reading it on the server means the page
 * cannot be tricked into offering another merchant's clients, and the form opens with its options already
 * there instead of an empty box that fills a second later. The reader is the invoice form's, because which
 * clients a merchant may offer is one fact about their book and not two.
 *
 * ## Why the refusals are kept apart
 *
 * Signed out, not an owner, the store unavailable, a quote that is not there, and a book with no clients in
 * it are five different facts. A page that printed "no clients" for an outage would tell a merchant their
 * book was erased, and a page that printed the form to a visitor with no session would invite a post with
 * nothing behind it. Each state is worded as itself, and none of them restates a role: the service decides
 * who may read.
 *
 * ## Why the three dates are computed here
 *
 * The expiry box has a floor, a ceiling and a default, and all three are functions of what day it is. They
 * are computed on the server so the page renders deterministically - a browser that computed them would
 * disagree with the server's own clock, and a hydration mismatch on a date is a form that opens on one day
 * and saves another. A phone whose clock is wrong is still offered the day the server believes.
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
  | { readonly kind: "not-found" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "ready"; readonly options: InvoiceClientOptions };

const linkClasses =
  "w-fit rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export function estimateMetadata(): Metadata {
  return {
    title: getMessage("estimates.newTitle"),
    description: getMessage("estimates.newDescription"),
  };
}

/** A `yyyy-mm-dd` box value this many days ahead of the server's today. */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The earliest day an offer can stand on, which is tomorrow.
 *
 * `0025` requires `expires_at` and the service requires it to be strictly ahead of now. A date box value is
 * midnight UTC of the day picked, and midnight today has already passed, so today is not offerable: the
 * shortest lifetime a quote can have is the rest of today plus all of tomorrow.
 */
function minimumExpiryDate(): string {
  return dayFromNow(1);
}

/** The expiry the form opens with: a fortnight, which is how long an offer usually stands. */
function defaultExpiryDate(): string {
  return dayFromNow(14);
}

/**
 * The latest day the box offers, which is `ESTIMATE_EXPIRY_MAXIMUM_DAYS` from today.
 *
 * The service refuses an expiry more than that many days ahead of the instant it is written, measured to
 * the instant rather than to the day. A day picked at its midnight is always behind the same day measured
 * from the current hour, so the box's ceiling is one the service accepts - and the day after it is one the
 * service refuses, which is why the bound is on the box and not only in the sentence under it.
 */
function maximumExpiryDate(): string {
  return dayFromNow(ESTIMATE_EXPIRY_MAXIMUM_DAYS);
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
    return getMessage("estimates.signedOut");
  }

  if (state.kind === "forbidden") {
    return getMessage("estimates.forbidden");
  }

  if (state.kind === "not-found") {
    return getMessage("estimates.notFound");
  }

  return getMessage("estimates.unavailable");
}

/**
 * One quote, with its line editor.
 *
 * ## Why a sent quote renders the editor at all
 *
 * A draft is the only thing this STEP can edit, but a quote that has been sent is not a 404 - it exists,
 * and its lines are what a client is being asked to accept. The page differs only in whether the controls
 * are offered, which the editor decides from the status rather than this screen hiding the document. A
 * merchant who followed a link to a quote they already sent sees the quote and the sentence that says why
 * nothing on it can move.
 */
export async function EstimateEditorScreen({
  estimateId,
}: {
  readonly estimateId: string;
}): Promise<ReactNode> {
  const actorState = await readOwnerActor();
  let state: { readonly kind: "ready"; readonly estimate: EstimateSnapshot } | ScreenState = {
    kind: "unavailable",
  };

  if (actorState.kind === "anonymous") {
    state = { kind: "signed-out" };
  } else if (actorState.kind === "actor") {
    const runtime = getAuthRuntime();

    try {
      const estimate = await getEstimate(
        { actor: actorState.actor, estimateId },
        { rest: runtime.rest, audit: runtime.audit },
      );

      state = { kind: "ready", estimate };
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
          <p className="text-sm font-medium text-muted-foreground">{getMessage("estimates.editorEyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{getMessage("estimates.editTitle")}</h1>
          <p className="text-sm text-muted-foreground">{getMessage("estimates.editDescription")}</p>
        </header>

        {"estimate" in state && state.kind === "ready" ? (
          <>
            <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("estimates.clientLabel")}</dt>
                <dd className="font-medium">{state.estimate.client.name}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("estimates.editorStatus")}</dt>
                <dd className="font-medium">{state.estimate.status}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("estimates.editorExpiryDate")}</dt>
                <dd className="font-medium">{state.estimate.expiresAt.slice(0, 10)}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-xs text-muted-foreground">{getMessage("estimates.total")}</dt>
                <dd className="font-medium">{state.estimate.totals.total}</dd>
              </div>
            </dl>
            <EstimateLineEditor estimate={state.estimate} />
          </>
        ) : (
          <p className="text-sm text-destructive" role="alert">
            {refusalSentence(state)}
          </p>
        )}

        <nav className="flex flex-col gap-2 border-t border-border pt-4 text-sm">
          <Link className={linkClasses} href="/estimates/new">
            {getMessage("estimates.editorNewEstimate")}
          </Link>
          <Link className={linkClasses} href="/clients">
            {getMessage("estimates.clientsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("estimates.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}

/** Section 16's estimate create screen. */
export async function EstimateCreateScreen(): Promise<ReactNode> {
  const state = await readScreenState();

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground sm:px-6 lg:px-8">
      {/* Section 22's rotating token: the page asks for a rotation, and the server decides. */}
      <SessionKeeper />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">{getMessage("estimates.eyebrow")}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {getMessage("estimates.newTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">{getMessage("estimates.newDescription")}</p>
        </header>

        {state.kind === "ready" ? (
          state.options.clients.length === 0 ? (
            <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <p className="text-sm" role="alert">
                {getMessage("estimates.clientNone")}
              </p>
              <Link className={linkClasses} href="/clients/new">
                {getMessage("estimates.clientAddLink")}
              </Link>
            </section>
          ) : (
            <EstimateForm
              clients={state.options.clients}
              clientsTruncated={state.options.truncated}
              defaultExpiryDate={defaultExpiryDate()}
              maximumExpiryDate={maximumExpiryDate()}
              minimumExpiryDate={minimumExpiryDate()}
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
            {getMessage("estimates.clientsLink")}
          </Link>
          <Link className={linkClasses} href="/products">
            {getMessage("estimates.productsLink")}
          </Link>
          <Link className={linkClasses} href="/">
            {getMessage("estimates.homeLink")}
          </Link>
        </nav>
      </div>
    </main>
  );
}
