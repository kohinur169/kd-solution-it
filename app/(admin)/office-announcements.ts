// path: app/(admin)/office-announcements.ts
import { cache } from "react";
import { getAnnouncementsRuntime } from "@/lib/announcements/runtime";
import { listActiveAnnouncements, type AnnouncementPopupView } from "@/lib/announcements/service";
import { AppError } from "@/lib/errors/app-error";
import { readOfficeActor } from "./office-actor";

/**
 * The announcements the popup shows to this office account, read once per request.
 *
 * ## Why the popup is read here and not by the shell
 *
 * The shell is a React tree with props: it has the roles and the screens, and nothing else. The popup
 * query needs more than the roles - it needs the company the person acts for and the dismissal rows
 * of that person - so it is read where every other office read happens, from the cached account, and
 * handed down.
 *
 * ## Why an outage hides the banner instead of failing the page
 *
 * An announcement is a courtesy laid over a screen that does real work. If the announcement table
 * cannot be read, an officer should still be able to approve a payout; a popup that turned a database
 * hiccup into a 500 on every office page would make the courtesy the outage. So an `AppError` answers
 * an empty list and the defect that is not an `AppError` still propagates, exactly as the office
 * account reader does with the same two kinds of failure.
 *
 * ## Why `cache()`
 *
 * The layout renders the account once and asks this module once; a screen that ever needs the same
 * list shares the answer instead of repeating the query.
 */

export const readOfficeAnnouncements = cache(async (): Promise<readonly AnnouncementPopupView[]> => {
  const state = await readOfficeActor();

  if (state.kind !== "actor") {
    return [];
  }

  try {
    return await listActiveAnnouncements({ actor: state.actor }, getAnnouncementsRuntime());
  } catch (error) {
    if (error instanceof AppError) {
      return [];
    }

    throw error;
  }
});
