// path: app/(admin)/announcements/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getAnnouncementsRuntime } from "@/lib/announcements/runtime";
import { listAnnouncements, type AnnouncementAdminSnapshot } from "@/lib/announcements/service";
import { AppError } from "@/lib/errors/app-error";
import { getMessage } from "@/lib/i18n/messages";
import { readOfficeActor } from "../office-actor";
import { AnnouncementComposerConsole } from "./announcement-composer";

export const metadata: Metadata = {
  title: getMessage("announcements.title"),
  description: getMessage("announcements.description"),
};

/**
 * Section 24's announcement composer: what has been written, what is showing, and the form that
 * writes the next one.
 *
 * ## Four answers, as on every office screen
 *
 * "Nobody is signed in", "this account reads but does not write", "the announcements could not be
 * read" and the console itself. The layout above has already refused an account with no office role;
 * this page owns the narrower question - `ANNOUNCEMENT_READ_ROLES` - and renders the refusal itself so
 * a role outside that list is told why rather than shown an empty page.
 *
 * ## Why the write permission is not checked here
 *
 * `canManage` travels with the snapshot from the service, so the console hides what the service would
 * refuse and the page never restates a role list. The read role is checked here because there is no
 * snapshot to carry it: a refused read must not render a form.
 */
interface AnnouncementsState {
  readonly kind: "signed-out" | "forbidden" | "unavailable" | "ready";
  readonly snapshot: AnnouncementAdminSnapshot | null;
}

async function readState(): Promise<AnnouncementsState> {
  const actorState = await readOfficeActor();

  if (actorState.kind === "anonymous") {
    return { kind: "signed-out", snapshot: null };
  }

  if (actorState.kind !== "actor") {
    return { kind: "unavailable", snapshot: null };
  }

  try {
    const snapshot = await listAnnouncements({ actor: actorState.actor }, getAnnouncementsRuntime());

    return { kind: "ready", snapshot };
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }

    if (error.code === "AUTHENTICATION_REQUIRED") {
      return { kind: "signed-out", snapshot: null };
    }

    return { kind: error.code === "PERMISSION_DENIED" ? "forbidden" : "unavailable", snapshot: null };
  }
}

const pageClasses = "flex flex-col gap-8";

const headerClasses = "flex flex-col gap-2";

const eyebrowClasses = "text-xs font-semibold uppercase tracking-widest text-muted-foreground";

const titleClasses = "text-2xl font-semibold tracking-tight sm:text-3xl";

const descriptionClasses = "max-w-3xl text-sm text-muted-foreground sm:text-base";

const alertClasses = "text-sm text-destructive";

const homeLinkClasses =
  "w-fit rounded-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-primary";

export default async function AnnouncementsPage(): Promise<ReactNode> {
  const state = await readState();

  return (
    <div className={pageClasses}>
      <header className={headerClasses}>
        <p className={eyebrowClasses}>{getMessage("announcements.eyebrow")}</p>
        <h1 className={titleClasses}>{getMessage("announcements.title")}</h1>
        <p className={descriptionClasses}>{getMessage("announcements.description")}</p>
      </header>

      {state.kind !== "ready" ? (
        <p className={alertClasses} role="alert">
          {state.kind === "signed-out"
            ? getMessage("announcements.signedOut")
            : state.kind === "forbidden"
              ? getMessage("announcements.forbidden")
              : getMessage("announcements.unavailable")}
        </p>
      ) : null}

      {state.snapshot === null ? null : (
        <AnnouncementComposerConsole snapshot={state.snapshot} />
      )}

      <nav className="border-t border-border pt-4 text-sm">
        <Link className={homeLinkClasses} href="/admin">
          {getMessage("announcements.home")}
        </Link>
      </nav>
    </div>
  );
}
