// path: app/(auth)/verify/page.tsx
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { getMessage } from "@/lib/i18n/messages";

export const metadata: Metadata = {
  title: getMessage("verify.title"),
};

const statuses = ["verified", "invalid", "unavailable"] as const;

type VerificationStatus = (typeof statuses)[number];

function isStatus(value: string): value is VerificationStatus {
  return statuses.some((status) => status === value);
}

function readStatus(value: string | string[] | undefined): VerificationStatus {
  if (typeof value === "string" && isStatus(value)) {
    return value;
  }

  return "invalid";
}

interface VerificationCopy {
  readonly title: string;
  readonly body: string;
  readonly tone: string;
}

function copyFor(status: VerificationStatus): VerificationCopy {
  if (status === "verified") {
    return {
      title: getMessage("verify.verifiedTitle"),
      body: getMessage("verify.verifiedBody"),
      tone: "border-success",
    };
  }

  if (status === "unavailable") {
    return {
      title: getMessage("verify.unavailableTitle"),
      body: getMessage("verify.unavailableBody"),
      tone: "border-warning",
    };
  }

  return {
    title: getMessage("verify.invalidTitle"),
    body: getMessage("verify.invalidBody"),
    tone: "border-destructive",
  };
}

export interface VerifyPageProperties {
  readonly searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>>;
}

/**
 * What the browser sees after following a confirmation link.
 *
 * The page shows one of three answers and never why a particular link failed: an expired link, a
 * used link and a link for another deployment all read the same, because a page that distinguishes
 * them would let a stranger probe for addresses. The session itself was set by the route handler
 * before this page was rendered; this page only reports the outcome.
 */
export default async function VerifyPage({ searchParams }: VerifyPageProperties): Promise<ReactNode> {
  const parameters = await searchParams;
  const status = readStatus(parameters["status"]);
  const copy = copyFor(status);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground sm:px-6">
      <section
        className={`w-full max-w-xl rounded-card border-l-4 ${copy.tone} border-y border-r border-border bg-surface p-6 shadow-card sm:p-8`}
      >
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {getMessage("verify.title")}
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl" role="status">
          {copy.title}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground sm:text-base">{copy.body}</p>
        <p className="mt-8 border-t border-border pt-4 text-sm">
          <Link className="font-semibold text-primary underline-offset-4 hover:underline" href="/">
            {getMessage("verify.home")}
          </Link>
        </p>
      </section>
    </main>
  );
}
