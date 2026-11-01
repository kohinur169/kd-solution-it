// path: lib/auth/policies.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors/app-error.ts";
import type { AuthConfig } from "./config.ts";
import type { AuthHttp } from "./http.ts";
import { createRestClient } from "./rest.ts";

/**
 * The published policies a merchant accepts at signup.
 *
 * Section 3 publishes twelve policies and `0052` stores an acceptance as the key, the version and
 * the SHA-256 of the text the person read. The text itself is a CMS page (`cms_pages`), so the
 * version of an acceptance is the version of the page row and the hash is the hash of that page's
 * body. That is what "versioned policy acceptance" means here: the record names a version and a
 * digest, so an editor changing the wording creates a new version and a new acceptance rather than
 * quietly rewriting what a merchant agreed to.
 *
 * Two refusals matter:
 *
 *   - a page that is not published cannot be accepted, because a draft is text nobody stood behind
 *     yet (`0078` seeds drafts and `0079` publishes them);
 *   - a page that has no body cannot be hashed, which the schema already forbids but this module
 *     checks again so a corrupted row is a clear failure rather than a hash of nothing.
 */

/** The twelve policy keys of section 3, in the order `0052` lists them. */
export const POLICY_KEYS = [
  "kyc_kyb",
  "ubo",
  "aml_cft",
  "sanctions_pep",
  "underwriting",
  "merchant_acceptance",
  "chargeback",
  "refund_settlement",
  "fraud_risk",
  "data_privacy",
  "pci_dss",
  "automated_decision_review",
] as const;

export type PolicyKey = (typeof POLICY_KEYS)[number];

const policyKeySet: ReadonlySet<string> = new Set<string>(POLICY_KEYS);

export function isPolicyKey(value: unknown): value is PolicyKey {
  return typeof value === "string" && policyKeySet.has(value);
}

/** One published policy at the version a merchant is accepting. */
export interface PublishedPolicy {
  readonly key: PolicyKey;
  /** The version text recorded on the acceptance, taken from the page row version. */
  readonly version: string;
  /** Lower case hex SHA-256 of the page body the merchant accepted. */
  readonly documentSha256: string;
  readonly slug: string;
  readonly title: string;
}

export interface PolicyCatalog {
  /** Every requested key that is published, in the order of the request. A missing key is absent. */
  published(keys: readonly PolicyKey[]): Promise<readonly PublishedPolicy[]>;
}

const pageRowSchema = z.object({
  policy_key: z.string().min(1).max(32),
  slug: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  body: z.string().min(1),
  version: z.number().int().positive(),
});

/** The SHA-256 a `policy_acceptances.document_sha256` column holds. */
export function policyDocumentSha256(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The version text of a page row. `0052` accepts `1`, `1.0` and up to four dotted numbers. */
export function policyVersionText(rowVersion: number): string {
  return String(rowVersion);
}

export interface PolicyPage {
  readonly key: PolicyKey;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly version: number;
}

/** Shared mapping, so the REST catalog and the in memory one can never disagree. */
export function toPublishedPolicy(page: PolicyPage): PublishedPolicy {
  return {
    key: page.key,
    version: policyVersionText(page.version),
    documentSha256: policyDocumentSha256(page.body),
    slug: page.slug,
    title: page.title,
  };
}

function orderByRequest(
  keys: readonly PolicyKey[],
  pages: readonly PolicyPage[],
): readonly PublishedPolicy[] {
  const byKey = new Map<PolicyKey, PolicyPage>();

  for (const page of pages) {
    byKey.set(page.key, page);
  }

  const ordered: PublishedPolicy[] = [];

  for (const key of keys) {
    const page = byKey.get(key);

    if (page !== undefined) {
      ordered.push(toPublishedPolicy(page));
    }
  }

  return ordered;
}

export function createRestPolicyCatalog(config: AuthConfig, http: AuthHttp): PolicyCatalog {
  const rest = createRestClient(config, http);

  return {
    async published(keys: readonly PolicyKey[]): Promise<readonly PublishedPolicy[]> {
      if (keys.length === 0) {
        return [];
      }

      const list = keys.map((key) => encodeURIComponent(key)).join(",");
      const query =
        "select=policy_key,slug,title,body,version" +
        `&policy_key=in.(${list})&status=eq.published&deleted_at=is.null`;

      const rows = await rest.select("cms_pages", query, pageRowSchema);
      const pages: PolicyPage[] = [];

      for (const row of rows) {
        if (!isPolicyKey(row.policy_key)) {
          throw new AppError("DEPENDENCY_FAILED");
        }

        pages.push({
          key: row.policy_key,
          slug: row.slug,
          title: row.title,
          body: row.body,
          version: row.version,
        });
      }

      return orderByRequest(keys, pages);
    },
  };
}

/**
 * The catalog in memory, for the gate. It holds only published pages, because that is the state
 * the REST catalog can return: a draft is filtered by the query, not by the caller.
 */
export function createInMemoryPolicyCatalog(pages: readonly PolicyPage[]): PolicyCatalog {
  const byKey = new Map<PolicyKey, PolicyPage>();

  for (const page of pages) {
    byKey.set(page.key, page);
  }

  return {
    published(keys: readonly PolicyKey[]): Promise<readonly PublishedPolicy[]> {
      const found: PolicyPage[] = [];

      for (const key of keys) {
        const page = byKey.get(key);

        if (page !== undefined) {
          found.push(page);
        }
      }

      return Promise.resolve(orderByRequest(keys, found));
    },
  };
}

/** The twelve keys a signup must accept, which is every policy the platform publishes. */
export const REQUIRED_POLICY_KEYS: readonly PolicyKey[] = POLICY_KEYS;

/** True when the accepted list names every required key, once each. */
export function acceptsEveryRequiredPolicy(accepted: readonly PolicyKey[]): boolean {
  const seen = new Set<PolicyKey>(accepted);

  return (
    seen.size === accepted.length &&
    REQUIRED_POLICY_KEYS.every((key) => seen.has(key))
  );
}

/** True when the catalog answered with a row for every required key. */
export function catalogIsComplete(published: readonly PublishedPolicy[]): boolean {
  const found = new Set<PolicyKey>(published.map((policy) => policy.key));

  return REQUIRED_POLICY_KEYS.every((key) => found.has(key));
}

