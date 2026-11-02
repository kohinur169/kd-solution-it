// path: app/(admin)/gateways/gateway-console.tsx
"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { deviceProofHeaders } from "@/lib/auth/device-proof-store";
import { rateLimitSentence } from "@/lib/auth/refusal-message";
import type { GatewayKeyView, GatewayView } from "@/lib/gateways/service";
import { getMessage } from "@/lib/i18n/messages";
import { csrfHeaders } from "@/lib/security/csrf-client";

/**
 * The gateway page's controls: store a key, test a key, enable a provider, disable a provider.
 *
 * ## What this component does and does not decide
 *
 * Every rule lives in `lib/gateways/service.ts`: the role, the freshness of the second factor, the
 * duplicate key, the passing test an enable needs. This component posts one action and renders the
 * answer. The rows arrive from the server component above, which already refused an account that may
 * not be here, so nothing below decides who may look - and after every successful action the router
 * is asked for a fresh render, because the row it changed is the server's to describe.
 *
 * ## The secret travels once
 *
 * The field is a password input with no `autoComplete`, and the value is not kept in state after the
 * request: the form is cleared on success, the message never contains it, and no response echoes it.
 * Section 6's promise is that a stored key is never shown again, and the smallest way to keep it is
 * to never hold it longer than the one request that stores it.
 *
 * ## Refusals are told apart
 *
 * `403` with `reauth_required` is STEP 053's window; `409` names the rule that refused - a duplicate
 * key, an adapter this build does not have, a test that has not passed, a provider with no active key
 * or a row that changed under the reader - and each of those is a different sentence because each is
 * a different thing for the operator to do next.
 */

type GatewayAction = "add_key" | "test_key" | "enable" | "disable";

interface RefusalDetail {
  readonly field?: unknown;
  readonly rule?: unknown;
}

/** The rule a `409` or `422` names, or null when the envelope carries none. */
function refusalRule(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const error = (payload as { readonly error?: unknown }).error;

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const details = (error as { readonly details?: unknown }).details;

  if (!Array.isArray(details) || details.length === 0) {
    return null;
  }

  const first = details[0] as RefusalDetail;

  return typeof first.rule === "string" ? first.rule : null;
}

/** The sentence for a refused action, in this screen's vocabulary. */
function messageForStatus(status: number, payload: unknown): string {
  if (status === 429) {
    return rateLimitSentence(payload);
  }

  if (status === 401) {
    return getMessage("officeGateways.signedOut");
  }

  if (status === 403) {
    return getMessage("officeGateways.reauthRequired");
  }

  const rule = refusalRule(payload);

  if (rule === "duplicate") {
    return getMessage("officeGateways.duplicateKey");
  }

  if (rule === "adapter_missing") {
    return getMessage("officeGateways.enableAdapterMissing");
  }

  if (rule === "test_required") {
    return getMessage("officeGateways.enableTestRequired");
  }

  if (rule === "key_required") {
    return getMessage("officeGateways.enableKeyRequired");
  }

  if (rule === "invalid_tail" || rule === "invalid_length" || rule === "invalid_format") {
    return getMessage("officeGateways.invalidSecret");
  }

  if (rule === "unknown_provider") {
    return getMessage("officeGateways.unknownProvider");
  }

  if (status === 409 || status === 404) {
    return getMessage("officeGateways.conflict");
  }

  return getMessage("officeGateways.failed");
}

/** One answer from the route: whether it worked, and what to say either way. */
interface ActionAnswer {
  readonly ok: boolean;
  readonly message: string;
  readonly testOk: boolean | null;
  readonly testDetail: string | null;
}

async function postAction(
  action: GatewayAction,
  fields: Readonly<Record<string, string>>,
): Promise<ActionAnswer> {
  const path = "/api/office/gateways";
  const body = JSON.stringify({ action, ...fields });
  const proof = await deviceProofHeaders("POST", path, body);

  if (proof === null) {
    return {
      ok: false,
      message: getMessage("device.proofRequired"),
      testOk: null,
      testDetail: null,
    };
  }

  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...proof, ...(await csrfHeaders()) },
    body,
  });

  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);

    return {
      ok: false,
      message: messageForStatus(response.status, payload),
      testOk: null,
      testDetail: null,
    };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (typeof payload !== "object" || payload === null) {
    return { ok: true, message: "", testOk: null, testDetail: null };
  }

  const answer = payload as { readonly testOk?: unknown; readonly testDetail?: unknown };

  return {
    ok: true,
    message: "",
    testOk: typeof answer.testOk === "boolean" ? answer.testOk : null,
    testDetail: typeof answer.testDetail === "string" ? answer.testDetail : null,
  };
}

const cardClasses =
  "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 text-foreground shadow-card sm:p-5";

const headerClasses = "flex flex-wrap items-center gap-x-3 gap-y-1";

const nameClasses = "text-lg font-semibold tracking-tight";

const badgeClasses =
  "rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide";

const bodyClasses = "text-sm text-muted-foreground";

const termClasses = "text-sm font-medium text-foreground";

const inputClasses =
  "mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary";

const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60";

const secondaryButtonClasses =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-4 py-2 text-sm font-semibold text-foreground transition-opacity hover:opacity-80 disabled:opacity-60";

const dangerButtonClasses =
  "inline-flex items-center justify-center rounded-lg border border-destructive px-4 py-2 text-sm font-semibold text-destructive transition-opacity hover:opacity-80 disabled:opacity-60";

const tagListClasses = "flex flex-wrap gap-2";

const listClasses = "flex flex-col gap-2";

const rowClasses = "flex flex-col gap-2 rounded-lg border border-border bg-background p-3";

const messageClasses = "text-sm";

/** One instant, printed the same way on every office screen: UTC, minute precision. */
function formatInstant(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const capabilityLabels = [
  ["acceptance", "officeGateways.capabilityAcceptance"],
  ["payouts", "officeGateways.capabilityPayouts"],
  ["submerchant", "officeGateways.capabilitySubmerchant"],
] as const;

function KeyRow({
  gateway,
  record,
}: {
  readonly gateway: GatewayView;
  readonly record: GatewayKeyView;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  async function test(): Promise<void> {
    setBusy(true);
    setMessage(null);
    setDetail(null);

    try {
      const answer = await postAction("test_key", { keyId: record.id });

      setBusy(false);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      if (answer.testOk === true) {
        setMessage(getMessage("officeGateways.testPassed"));
        router.refresh();

        return;
      }

      setMessage(getMessage("officeGateways.testFailed"));
      setDetail(answer.testDetail);
      router.refresh();
    } catch {
      setBusy(false);
      setMessage(getMessage("officeGateways.failed"));
    }
  }

  return (
    <li className={rowClasses}>
      <div className={headerClasses}>
        <span className={badgeClasses}>
          {record.mode === "live"
            ? getMessage("officeGateways.modeLive")
            : getMessage("officeGateways.modeTest")}
        </span>
        <span className={badgeClasses}>
          {record.status === "active"
            ? getMessage("officeGateways.keyStatusActive")
            : getMessage("officeGateways.keyStatusDisabled")}
        </span>
        <span className={bodyClasses}>{record.label}</span>
      </div>

      <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className={bodyClasses}>{getMessage("officeGateways.lastFourLabel")}</dt>
        <dd className="font-mono text-xs sm:text-sm">{`****${record.lastFour}`}</dd>
        <dt className={bodyClasses}>{getMessage("officeGateways.keyUpdatedLabel")}</dt>
        <dd className="text-xs sm:text-sm">{formatInstant(record.updatedAtEpochMs)}</dd>
      </dl>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          className={secondaryButtonClasses}
          disabled={busy}
          onClick={(): void => {
            void test();
          }}
          type="button"
        >
          {busy ? getMessage("officeGateways.testBusy") : getMessage("officeGateways.testSubmit")}
        </button>
        {gateway.adapterInstalled ? null : (
          <span className={bodyClasses}>{getMessage("officeGateways.adapterMissing")}</span>
        )}
      </div>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
      {detail === null ? null : (
        <p className={bodyClasses}>{`${getMessage("officeGateways.testDetailLabel")}: ${detail}`}</p>
      )}
    </li>
  );
}

function ProviderCard({ gateway }: { readonly gateway: GatewayView }): ReactNode {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [mode, setMode] = useState("test");
  const [busy, setBusy] = useState<GatewayAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function add(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy("add_key");
    setMessage(null);

    try {
      const answer = await postAction("add_key", {
        providerKey: gateway.providerKey,
        mode,
        label,
        secret,
      });

      setBusy(null);

      if (!answer.ok) {
        setMessage(answer.message);

        return;
      }

      setLabel("");
      setSecret("");
      setMessage(getMessage("officeGateways.storedDone"));
      router.refresh();
    } catch {
      setBusy(null);
      setMessage(getMessage("officeGateways.failed"));
    }
  }

  async function turn(enabling: boolean): Promise<void> {
    setBusy(enabling ? "enable" : "disable");
    setMessage(null);

    try {
      const answer = await postAction(enabling ? "enable" : "disable", {
        providerKey: gateway.providerKey,
      });

      setBusy(null);

      setMessage(
        answer.ok
          ? getMessage(enabling ? "officeGateways.enabledDone" : "officeGateways.disabledDone")
          : answer.message,
      );

      if (answer.ok) {
        router.refresh();
      }
    } catch {
      setBusy(null);
      setMessage(getMessage("officeGateways.failed"));
    }
  }

  const supported = capabilityLabels.filter(([key]) => gateway.capabilities[key]);

  return (
    <li className={cardClasses}>
      <header className={headerClasses}>
        <h2 className={nameClasses}>{gateway.displayName}</h2>
        <span className={badgeClasses}>
          {gateway.status === "enabled"
            ? getMessage("officeGateways.providerEnabled")
            : getMessage("officeGateways.providerDisabled")}
        </span>
        <span className={badgeClasses}>
          {gateway.adapterInstalled
            ? getMessage("officeGateways.adapterInstalled")
            : getMessage("officeGateways.adapterMissing")}
        </span>
      </header>

      <div>
        <p className={termClasses}>{getMessage("officeGateways.capabilitiesHeading")}</p>
        <ul className={`mt-1 ${tagListClasses}`}>
          {supported.length === 0 ? (
            <li className={bodyClasses}>{getMessage("officeGateways.noCapability")}</li>
          ) : (
            supported.map(([key, messageKey]) => (
              <li className={badgeClasses} key={key}>
                {getMessage(messageKey)}
              </li>
            ))
          )}
        </ul>
      </div>

      <div>
        <p className={termClasses}>{getMessage("officeGateways.lastTestHeading")}</p>
        <p className={`mt-1 ${bodyClasses}`}>
          {gateway.lastTestedAtEpochMs === null
            ? getMessage("officeGateways.lastTestNever")
            : `${gateway.lastTestOk === true ? getMessage("officeGateways.lastTestPassed") : getMessage("officeGateways.lastTestFailed")} - ${formatInstant(gateway.lastTestedAtEpochMs)}`}
        </p>
        {gateway.lastTestDetail === null ? null : (
          <p className={bodyClasses}>{gateway.lastTestDetail}</p>
        )}
        {gateway.enabledAtEpochMs === null ? null : (
          <p className={bodyClasses}>
            {`${getMessage("officeGateways.enabledAtLabel")}: ${formatInstant(gateway.enabledAtEpochMs)}`}
          </p>
        )}
      </div>

      <div>
        <h3 className={termClasses}>{getMessage("officeGateways.keysHeading")}</h3>
        {gateway.keys.length === 0 ? (
          <p className={`mt-1 ${bodyClasses}`}>{getMessage("officeGateways.noKeys")}</p>
        ) : (
          <ul className={`mt-2 ${listClasses}`}>
            {gateway.keys.map((record) => (
              <KeyRow gateway={gateway} key={record.id} record={record} />
            ))}
          </ul>
        )}
      </div>

      <form
        className="flex flex-col gap-2 border-t border-border pt-4"
        onSubmit={(event): void => {
          void add(event);
        }}
      >
        <p className={termClasses}>{getMessage("officeGateways.addTitle")}</p>
        <p className={bodyClasses}>{getMessage("officeGateways.addDescription")}</p>
        <label className="mt-2 block">
          <span className={bodyClasses}>{getMessage("officeGateways.labelLabel")}</span>
          <input
            className={inputClasses}
            maxLength={80}
            name="label"
            onChange={(event): void => {
              setLabel(event.target.value);
            }}
            required
            type="text"
            value={label}
          />
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeGateways.modeLabel")}</span>
          <select
            className={inputClasses}
            name="mode"
            onChange={(event): void => {
              setMode(event.target.value);
            }}
            value={mode}
          >
            <option value="test">{getMessage("officeGateways.modeTest")}</option>
            <option value="live">{getMessage("officeGateways.modeLive")}</option>
          </select>
        </label>
        <label className="block">
          <span className={bodyClasses}>{getMessage("officeGateways.secretLabel")}</span>
          <input
            autoComplete="off"
            className={inputClasses}
            maxLength={512}
            name="secret"
            onChange={(event): void => {
              setSecret(event.target.value);
            }}
            required
            type="password"
            value={secret}
          />
        </label>
        <p className={bodyClasses}>{getMessage("officeGateways.secretHint")}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button className={primaryButtonClasses} disabled={busy !== null} type="submit">
            {busy === "add_key" ? getMessage("officeGateways.addBusy") : getMessage("officeGateways.addSubmit")}
          </button>
          {gateway.status === "enabled" ? (
            <button
              className={dangerButtonClasses}
              disabled={busy !== null}
              onClick={(): void => {
                void turn(false);
              }}
              type="button"
            >
              {busy === "disable" ? getMessage("officeGateways.enableBusy") : getMessage("officeGateways.disableSubmit")}
            </button>
          ) : (
            <button
              className={secondaryButtonClasses}
              disabled={busy !== null}
              onClick={(): void => {
                void turn(true);
              }}
              type="button"
            >
              {busy === "enable" ? getMessage("officeGateways.enableBusy") : getMessage("officeGateways.enableSubmit")}
            </button>
          )}
        </div>
      </form>

      {message === null ? null : (
        <p className={messageClasses} role="status">
          {message}
        </p>
      )}
    </li>
  );
}

/**
 * The five provider cards.
 *
 * The list is the registry's, in the order the migration gives them, and the screen adds nothing to
 * it: a provider this build does not know cannot be drawn here, which is section 6's rule about an
 * adapter in code, visible in the one place an operator would look for it.
 */
export function GatewayConsole({
  gateways,
}: {
  readonly gateways: readonly GatewayView[];
}): ReactNode {
  return (
    <ul className="flex flex-col gap-4">
      {gateways.map((gateway) => (
        <ProviderCard gateway={gateway} key={gateway.id} />
      ))}
    </ul>
  );
}
