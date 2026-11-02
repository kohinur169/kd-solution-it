// path: app/(admin)/delegations/delegation-console.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import { getMessage } from "@/lib/i18n/messages";
import {
  GRANT_DURATIONS,
  PERMISSION_REASON_MAXIMUM_LENGTH,
  PERMISSION_GROUPS,
  delegablePermissionKeysInGroup,
  permissionGroupLabelKey,
  permissionLabelKey,
} from "@/lib/permissions/registry";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The two acts of the delegation screen: hand a permission out, and take one back.
 *
 * ## Why one component holds both forms
 *
 * They write the same table through the same route and share the same five refusal sentences, so
 * splitting them would duplicate the signing, the CSRF header and the mapping of a `409` into words.
 * What they do not share is state: each form has its own message, so a successful grant never looks
 * like a successful withdrawal.
 *
 * ## What the browser is trusted with
 *
 * Nothing. The permission list arrives already narrowed to the keys this screen may hand out, the window
 * list is the catalog's, and every value is validated again in `lib/permissions/service.ts` behind the
 * device proof. A crafted request therefore reaches a refusal, not a grant: the component's only job is
 * to turn that refusal into a sentence a person can act on.
 */

/** One live delegation, as the withdrawal select needs it. */
export interface RevocableDelegation {
  readonly id: string;
  readonly label: string;
}

/** The rule and field a refusal named, or nulls when the envelope carries neither. */
function refusalOf(payload: unknown): { readonly field: string | null; readonly rule: string | null } {
  if (typeof payload !== "object" || payload === null) {
    return { field: null, rule: null };
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return { field: null, rule: null };
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return { field: null, rule: null };
  }

  const first = details[0] as { readonly field?: unknown; readonly rule?: unknown };

  return {
    field: typeof first.field === "string" ? first.field : null,
    rule: typeof first.rule === "string" ? first.rule : null,
  };
}

function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeDelegations.signedOut");
  }

  if (status === 403) {
    return getMessage("officeDelegations.reauthRequired");
  }

  const { field, rule } = refusalOf(payload);

  if (rule === "unknown_permission") {
    return getMessage("officeDelegations.unknownPermission");
  }

  if (rule === "not_delegable") {
    return getMessage("officeDelegations.notDelegable");
  }

  if (rule === "not_office_staff") {
    return getMessage("officeDelegations.notOfficeStaff");
  }

  if (rule === "self") {
    return getMessage("officeDelegations.selfGrant");
  }

  if (rule === "duplicate") {
    return getMessage("officeDelegations.duplicateGrant");
  }

  if (rule === "account_inactive") {
    return getMessage("officeDelegations.unknownAccount");
  }

  if (rule === "invalid_format" && field === "email") {
    return getMessage("officeDelegations.invalidEmail");
  }

  if (rule === "invalid_length") {
    return getMessage("officeDelegations.invalidLength");
  }

  if (rule === "invalid_range") {
    return getMessage("officeDelegations.invalidRange");
  }

  if (rule === "expired") {
    return getMessage("officeDelegations.expiredGrant");
  }

  if (status === 409) {
    return getMessage("officeDelegations.conflict");
  }

  return getMessage("officeDelegations.failed");
}

/** One answer from the route, reduced to what the form needs. */
type Answer = { readonly ok: boolean; readonly message: string | null };

/**
 * Send one signed body to the delegation route.
 *
 * The proof is asked for before the request, so a browser that holds no device proof is told so instead
 * of sending an unsigned body the route would refuse.
 */
async function sendDelegation(payload: Readonly<Record<string, unknown>>): Promise<Answer> {
  const serialized = JSON.stringify(payload);
  const proof = await deviceProofHeaders("POST", "/api/office/delegations", serialized);

  if (proof === null) {
    return { ok: false, message: getMessage("device.proofRequired") };
  }

  const response = await fetch("/api/office/delegations", {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body: serialized,
  });

  if (!response.ok) {
    const refusal: unknown = await response.json().catch(() => null);

    return { ok: false, message: messageForStatus(response.status, refusal) };
  }

  return { ok: true, message: null };
}

const formClasses = "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-card";

const fieldClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const labelClasses = "block text-sm font-medium text-foreground";

const hintClasses = "text-sm text-muted-foreground";

const buttonClasses =
  "mt-1 inline-flex w-fit items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const noteFieldClasses = `${fieldClasses} min-h-24`;

export function DelegationConsole({
  revocable,
}: {
  readonly revocable: readonly RevocableDelegation[];
}): ReactNode {
  const router = useRouter();
  const [permission, setPermission] = useState<string>(
    delegablePermissionKeysInGroup("kyc")[0] ?? "",
  );
  const [email, setEmail] = useState("");
  const [days, setDays] = useState<string>(String(GRANT_DURATIONS[1]?.days ?? 30));
  const [reason, setReason] = useState("");
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantMessage, setGrantMessage] = useState<string | null>(null);
  const [delegationId, setDelegationId] = useState<string>(revocable[0]?.id ?? "");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);

  async function grant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setGrantBusy(true);
    setGrantMessage(null);

    try {
      const answer = await sendDelegation({
        action: "grant",
        permission,
        email,
        days: Number.parseInt(days, 10),
        reason,
      });

      setGrantBusy(false);

      if (!answer.ok) {
        setGrantMessage(answer.message);

        return;
      }

      setEmail("");
      setReason("");
      setGrantMessage(getMessage("officeDelegations.grantedDone"));
      router.refresh();
    } catch {
      setGrantBusy(false);
      setGrantMessage(getMessage("officeDelegations.failed"));
    }
  }

  async function revoke(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setRevokeBusy(true);
    setRevokeMessage(null);

    try {
      const answer = await sendDelegation({ action: "revoke", delegationId });

      setRevokeBusy(false);

      if (!answer.ok) {
        setRevokeMessage(answer.message);

        return;
      }

      setRevokeMessage(getMessage("officeDelegations.revokedDone"));
      router.refresh();
    } catch {
      setRevokeBusy(false);
      setRevokeMessage(getMessage("officeDelegations.failed"));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        className={formClasses}
        onSubmit={(event): void => {
          void grant(event);
        }}
      >
        <label className={labelClasses}>
          {getMessage("officeDelegations.permissionFieldLabel")}
          <select
            className={fieldClasses}
            name="permission"
            onChange={(event): void => {
              setPermission(event.target.value);
            }}
            value={permission}
          >
            {PERMISSION_GROUPS.map((group) => {
              const keys = delegablePermissionKeysInGroup(group);

              if (keys.length === 0) {
                return null;
              }

              return (
                <optgroup key={group} label={getMessage(permissionGroupLabelKey(group))}>
                  {keys.map((key) => (
                    <option key={key} value={key}>
                      {getMessage(permissionLabelKey(key))}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
        <p className={hintClasses}>{getMessage("officeDelegations.permissionHint")}</p>

        <label className={labelClasses}>
          {getMessage("officeDelegations.emailFieldLabel")}
          <input
            autoComplete="off"
            className={fieldClasses}
            maxLength={254}
            name="email"
            onChange={(event): void => {
              setEmail(event.target.value);
            }}
            required
            type="email"
            value={email}
          />
        </label>
        <p className={hintClasses}>{getMessage("officeDelegations.emailHint")}</p>

        <label className={labelClasses}>
          {getMessage("officeDelegations.durationFieldLabel")}
          <select
            className={fieldClasses}
            name="days"
            onChange={(event): void => {
              setDays(event.target.value);
            }}
            value={days}
          >
            {GRANT_DURATIONS.map((duration) => (
              <option key={duration.days} value={String(duration.days)}>
                {getMessage(duration.labelKey)}
              </option>
            ))}
          </select>
        </label>
        <p className={hintClasses}>{getMessage("officeDelegations.durationHint")}</p>

        <label className={labelClasses}>
          {getMessage("officeDelegations.reasonFieldLabel")}
          <textarea
            className={noteFieldClasses}
            maxLength={PERMISSION_REASON_MAXIMUM_LENGTH}
            name="reason"
            onChange={(event): void => {
              setReason(event.target.value);
            }}
            required
            value={reason}
          />
        </label>
        <p className={hintClasses}>{getMessage("officeDelegations.reasonHint")}</p>

        <button className={buttonClasses} disabled={grantBusy} type="submit">
          {grantBusy
            ? getMessage("officeDelegations.grantBusy")
            : getMessage("officeDelegations.grantSubmit")}
        </button>

        {grantMessage === null ? null : (
          <p className="text-sm" role="status">
            {grantMessage}
          </p>
        )}
      </form>

      <form
        className={formClasses}
        onSubmit={(event): void => {
          void revoke(event);
        }}
      >
        {revocable.length === 0 ? (
          <p className={hintClasses}>{getMessage("officeDelegations.noLiveToRevoke")}</p>
        ) : (
          <>
            <p className={hintClasses}>{getMessage("officeDelegations.revokeDescription")}</p>
            <label className={labelClasses}>
              {getMessage("officeDelegations.revokeFieldLabel")}
              <select
                className={fieldClasses}
                name="delegationId"
                onChange={(event): void => {
                  setDelegationId(event.target.value);
                }}
                value={delegationId}
              >
                {revocable.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button className={buttonClasses} disabled={revokeBusy} type="submit">
              {revokeBusy
                ? getMessage("officeDelegations.revokeBusy")
                : getMessage("officeDelegations.revokeSubmit")}
            </button>
          </>
        )}

        {revokeMessage === null ? null : (
          <p className="text-sm" role="status">
            {revokeMessage}
          </p>
        )}
      </form>
    </div>
  );
}
