// path: components/announcements/announcement-popup.tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { REAUTHENTICATION_REQUIRED_RULE } from "@/lib/auth/step-up";
import type { AnnouncementPopupView } from "@/lib/announcements/service";
import { formatMessage, getMessage, type MessagePath } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The popup section 24 asks for: one announcement at a time, closed for good by the person reading it.
 *
 * ## One at a time, newest first
 *
 * The server sends at most `ANNOUNCEMENT_POPUP_LIMIT` announcements, newest first, already filtered
 * to the ones this person has not dismissed. This component shows the first and keeps the rest in a
 * queue: dismissing the visible one advances to the next, so a person who dismisses three banners
 * never sees three overlays at once - and never sees the one they closed again.
 *
 * ## Dismissal is a write, and the answer decides what happens
 *
 * The button posts the announcement's id. Only a successful answer removes it from the screen: a
 * refusal keeps the banner and says why, because hiding it locally would promise a rule the database
 * has not recorded. `router.refresh()` then re-reads the server's answer, so the next page load and
 * this one agree.
 *
 * ## Why it is not a modal
 *
 * A banner must not trap the keyboard: the office behind it keeps working, and a person may read the
 * page and come back. So the dialog is not a modal one, it takes focus when it appears (so a screen
 * reader announces it) and not after that, Escape closes it the same way the button does, and the
 * layout is a card at the bottom of the viewport - full width on a phone, a fixed column from `sm`
 * upwards - which never covers the topbar or the navigation.
 *
 * ## Why the queue is state and not a re-render
 *
 * The announcements arrive as props from the server. Which of them this person has closed *since this
 * page was rendered* is browser state; the durable record is the row the POST writes. The two are
 * kept apart deliberately, so a failed write can never look like a dismissal.
 */

interface DismissAnswer {
  readonly ok: boolean;
  readonly message: string;
}

/** The sentence for a refusal, from the shared message of the shared error envelope. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("announcements.signedOut");
  }

  const error =
    typeof payload === "object" && payload !== null
      ? (payload as { readonly error?: unknown }).error
      : null;
  const details =
    typeof error === "object" && error !== null
      ? (error as { readonly details?: unknown }).details
      : null;
  const rule =
    Array.isArray(details) && details.length > 0
      ? (details[0] as { readonly rule?: unknown }).rule
      : null;

  if (status === 403) {
    return getMessage(
      rule === REAUTHENTICATION_REQUIRED_RULE
        ? "announcements.reauthRequired"
        : "announcements.forbidden",
    );
  }

  if (status === 404) {
    return getMessage("announcements.missing");
  }

  if (status === 409) {
    return getMessage("announcements.conflict");
  }

  return getMessage("announcements.failed");
}

async function postDismiss(announcementId: string): Promise<DismissAnswer> {
  const path = "/api/office/announcements";
  const body = JSON.stringify({ action: "dismiss", announcementId });
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return { ok: false, message: getMessage("device.proofRequired") };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);

    return { ok: false, message: messageForStatus(response.status, payload) };
  }

  return { ok: true, message: "" };
}

const overlayClasses =
  "fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-4 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96 sm:px-0 sm:pb-6";

const cardClasses =
  "flex w-full max-w-md flex-col gap-3 rounded-xl border border-l-4 border-border bg-surface p-4 text-foreground shadow-card sm:p-5";

const headerClasses = "flex flex-wrap items-center gap-2";

const badgeClasses = "text-xs font-semibold uppercase tracking-widest";

const counterClasses = "text-xs text-muted-foreground";

const titleClasses = "text-lg font-semibold tracking-tight";

const bodyClasses = "whitespace-pre-line text-sm text-muted-foreground";

const footerClasses = "flex flex-wrap items-center justify-between gap-2";

const noteClasses = "text-xs text-muted-foreground";

const buttonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const messageClasses = "text-sm text-destructive";

const levelBorderClasses: Readonly<Record<string, string>> = {
  info: "border-l-primary",
  warning: "border-l-warning",
  critical: "border-l-destructive",
};

const levelTextClasses: Readonly<Record<string, string>> = {
  info: "text-primary",
  warning: "text-warning",
  critical: "text-destructive",
};

export function AnnouncementPopup({
  announcements,
}: {
  readonly announcements: readonly AnnouncementPopupView[];
}): ReactNode {
  const router = useRouter();
  const [closedIds, setClosedIds] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastDismissed, setLastDismissed] = useState("");
  const dismissRef = useRef<HTMLButtonElement | null>(null);

  const remaining = announcements.filter((announcement) => !closedIds.includes(announcement.id));
  const current = remaining[0] ?? null;
  const currentId = current?.id ?? null;

  // Focus moves to the button once, when a new banner appears, so a keyboard user lands on the
  // decision rather than behind it.
  useEffect(() => {
    if (currentId !== null) {
      dismissRef.current?.focus();
    }
  }, [currentId]);

  if (current === null) {
    return (
      <p aria-live="polite" className="sr-only" role="status">
        {lastDismissed}
      </p>
    );
  }

  const headingId = `announcement-title-${current.id}`;
  const bodyId = `announcement-body-${current.id}`;
  const position = closedIds.length + 1;

  async function dismiss(announcementId: string): Promise<void> {
    setBusy(true);
    setMessage(null);

    try {
      const answer = await postDismiss(announcementId);

      setBusy(false);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      setClosedIds((previous) => [...previous, announcementId]);
      setLastDismissed(getMessage("announcements.popupDismissed"));
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("announcements.failed"));
    }
  }

  return (
    <div className={overlayClasses}>
      <div
        aria-describedby={bodyId}
        aria-labelledby={headingId}
        className={`${cardClasses} ${levelBorderClasses[current.level] ?? "border-l-primary"}`}
        onKeyDown={(event): void => {
          if (event.key === "Escape") {
            event.preventDefault();
            void dismiss(current.id);
          }
        }}
        role="dialog"
      >
        <div className={headerClasses}>
          <span className={`${badgeClasses} ${levelTextClasses[current.level] ?? "text-primary"}`}>
            {getMessage(current.levelLabelKey as MessagePath)}
          </span>
          <span className={counterClasses}>{getMessage("announcements.popupLabel")}</span>
          {announcements.length > 1 ? (
            <span className={counterClasses}>
              {formatMessage("announcements.popupCounter", {
                index: position,
                total: announcements.length,
              })}
            </span>
          ) : null}
        </div>

        <p className={titleClasses} id={headingId}>
          {current.title}
        </p>
        <p className={bodyClasses} id={bodyId}>
          {current.body}
        </p>

        <div className={footerClasses}>
          <span className={noteClasses}>{getMessage("announcements.popupLevelNote")}</span>
          <button
            className={buttonClasses}
            disabled={busy}
            onClick={(): void => {
              void dismiss(current.id);
            }}
            ref={dismissRef}
            type="button"
          >
            {busy ? getMessage("announcements.popupDismissBusy") : getMessage("announcements.popupDismiss")}
          </button>
        </div>

        {message === null ? null : (
          <p className={messageClasses} role="alert">
            {message}
          </p>
        )}

        <p aria-live="polite" className="sr-only" role="status">
          {lastDismissed}
        </p>
      </div>
    </div>
  );
}
