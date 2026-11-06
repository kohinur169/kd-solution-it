// path: lib/payments/ledger-accounts.ts

/**
 * The payment core's ledger account setup: the chart of accounts that every merchant reads and posts to.
 *
 * ## What the chart is
 *
 * Section 11 of the feature list says "every merchant has a full payment ledger" and "double-entry
 * method: every money movement writes a debit entry and a credit entry and the pair always balances to
 * zero." The chart of accounts is the vocabulary that makes those sentences true: eight closed account
 * codes, each with a kind and a normal side, and the pairing between them is not a convention but a
 * constraint. An asset or an expense is a debit account; a liability or an income is a credit account.
 * A row whose side is wrong silently inverts every balance that reads it, so the pairing is a rule the
 * gate proves, not a comment the reader trusts.
 *
 * The eight codes are closed on purpose: a ninth account is a new migration, which is what keeps
 * "the ledger covers these movements" a statement the database can hold.
 *
 * ## The two scopes
 *
 * The chart exists twice. The platform chart holds the accounts the platform owns: the fee it keeps,
 * the tax it collects for the state, the reserve it holds back, the chargeback loss and fee it eats,
 * and the subscription income it earns - six accounts, `company_id` null. The merchant chart holds the
 * accounts each merchant reads: the payable the platform owes them and the clearing account where their
 * money sits at the processor - two accounts, `company_id` set. The migration (0040) made this two-scope
 * design a database fact with two partial unique indexes, one per scope. This service is the code that
 * opens each scope's chart.
 *
 * A merchant's ledger statement reads entries from both scopes: a payment debits the merchant's
 * clearing account and credits the merchant's payable, while the platform fee debits the merchant's
 * payable and credits the platform's fee income. The entries are all scoped to the merchant - that is
 * what `ledger_entries.company_id` holds - even when the account they post to is a platform account.
 *
 * ## What this file is not
 *
 * It is not the posting service. It opens the accounts; it does not post entries against them. STEP 132
 * owns the posting. It is also not the ledger entries table - the migration (0041) already made the
 * append-only, balanced-group, reversal-mirror rules database facts. This file is the chart: the
 * definitions and the opening logic.
 */

import { randomUUID } from "node:crypto";
import { deepFreeze } from "../utils/freeze.ts";

/** The eight closed account codes of the section 11 chart. A ninth is a new migration. */
export type LedgerAccountCode =
  | "processor_clearing"
  | "merchant_payable"
  | "platform_fee_income"
  | "sales_tax_payable"
  | "reserve_held"
  | "chargeback_loss"
  | "chargeback_fee"
  | "subscription_income";

/** The four account kinds of double-entry bookkeeping. */
export type LedgerAccountKind = "asset" | "liability" | "income" | "expense";

/** The two sides of a double-entry row. */
export type LedgerAccountSide = "debit" | "credit";

/** The definition of one account in the chart, before it is opened. */
export interface LedgerAccountDefinition {
  readonly accountCode: LedgerAccountCode;
  readonly displayName: string;
  readonly accountKind: LedgerAccountKind;
  readonly normalSide: LedgerAccountSide;
}

/** A ledger account as the store holds it: the definition plus its identity and lifecycle. */
export interface LedgerAccount {
  readonly id: string;
  readonly companyId: string | null;
  readonly accountCode: LedgerAccountCode;
  readonly displayName: string;
  readonly accountKind: LedgerAccountKind;
  readonly normalSide: LedgerAccountSide;
  readonly isActive: boolean;
  readonly openedAt: string;
  readonly closedAt: string | null;
}

/**
 * The full chart of accounts: eight definitions, closed on purpose.
 *
 * The order is the order the migration names them, which is also the order a statement reads them in.
 * The kind and the normal side are the pairing the `ledger_accounts_pairing_check` constraint enforces
 * in the database - an asset or an expense is a debit account, a liability or an income is a credit
 * account - and the gate proves this list agrees with that rule.
 */
export const CHART_OF_ACCOUNTS: readonly LedgerAccountDefinition[] = deepFreeze([
  { accountCode: "processor_clearing", displayName: "Processor Clearing", accountKind: "asset", normalSide: "debit" },
  { accountCode: "merchant_payable", displayName: "Merchant Payable", accountKind: "liability", normalSide: "credit" },
  { accountCode: "platform_fee_income", displayName: "Platform Fee Income", accountKind: "income", normalSide: "credit" },
  { accountCode: "sales_tax_payable", displayName: "Sales Tax Payable", accountKind: "liability", normalSide: "credit" },
  { accountCode: "reserve_held", displayName: "Reserve Held", accountKind: "liability", normalSide: "credit" },
  { accountCode: "chargeback_loss", displayName: "Chargeback Loss", accountKind: "expense", normalSide: "debit" },
  { accountCode: "chargeback_fee", displayName: "Chargeback Fee", accountKind: "expense", normalSide: "debit" },
  { accountCode: "subscription_income", displayName: "Subscription Income", accountKind: "income", normalSide: "credit" },
]);

/**
 * The six platform account codes: the accounts the platform owns.
 *
 * These are the fee income, the tax payable, the reserve, the chargeback loss and fee, and the
 * subscription income. They live in the platform chart (`company_id` null) and every merchant's
 * ledger posts to them.
 */
export const PLATFORM_ACCOUNT_CODES: readonly LedgerAccountCode[] = deepFreeze([
  "platform_fee_income",
  "sales_tax_payable",
  "reserve_held",
  "chargeback_loss",
  "chargeback_fee",
  "subscription_income",
]);

/**
 * The two merchant account codes: the accounts each merchant reads.
 *
 * These are the payable the platform owes the merchant and the clearing account where the merchant's
 * money sits at the processor. They live in the merchant chart (`company_id` set) and are opened when
 * the merchant is provisioned.
 */
export const MERCHANT_ACCOUNT_CODES: readonly LedgerAccountCode[] = deepFreeze([
  "processor_clearing",
  "merchant_payable",
]);

/** The kind-to-side pairing: an asset or expense is debit, a liability or income is credit. */
export const NORMAL_SIDE_OF: Readonly<Record<LedgerAccountKind, LedgerAccountSide>> = deepFreeze({
  asset: "debit",
  expense: "debit",
  liability: "credit",
  income: "credit",
});

/** What the service reads and writes: the chart rows. The store is the caller's. */
export interface LedgerAccountStore {
  /** The account a company's scope already holds for this code, or null when it is new. */
  findByCode(companyId: string | null, accountCode: LedgerAccountCode): LedgerAccount | null;
  /** Store an opened account. */
  insert(account: LedgerAccount): void;
}

/** The result of opening a chart: the accounts that were opened, or the ones that were already there. */
export type LedgerAccountOpeningResult =
  | { status: "opened"; accounts: readonly LedgerAccount[] }
  | { status: "already_open"; accounts: readonly LedgerAccount[] };

/** The in-memory store: a reference implementation that keys on scope:code. */
export class InMemoryLedgerAccountStore implements LedgerAccountStore {
  private readonly accounts = new Map<string, LedgerAccount>();

  findByCode(companyId: string | null, accountCode: LedgerAccountCode): LedgerAccount | null {
    return this.accounts.get(this.compoundKey(companyId, accountCode)) ?? null;
  }

  insert(account: LedgerAccount): void {
    this.accounts.set(this.compoundKey(account.companyId, account.accountCode), account);
  }

  private compoundKey(companyId: string | null, accountCode: LedgerAccountCode): string {
    return companyId === null ? `platform:${accountCode}` : `${companyId}:${accountCode}`;
  }
}

/** Open the platform chart: the six accounts the platform owns. */
export function openPlatformChart(options: { readonly store: LedgerAccountStore }): LedgerAccountOpeningResult {
  return openChart(null, PLATFORM_ACCOUNT_CODES, options.store);
}

/** Open a merchant's chart: the two accounts each merchant reads. */
export function openMerchantChart(companyId: string, options: { readonly store: LedgerAccountStore }): LedgerAccountOpeningResult {
  return openChart(companyId, MERCHANT_ACCOUNT_CODES, options.store);
}

/** Open a chart: check first, then insert. Idempotent. */
function openChart(
  companyId: string | null,
  codes: readonly LedgerAccountCode[],
  store: LedgerAccountStore,
): LedgerAccountOpeningResult {
  const definitions = codes.map((code) => definitionOf(code));
  const existing = definitions.map((def) => store.findByCode(companyId, def.accountCode));

  if (existing.every((account) => account !== null)) {
    return {
      status: "already_open",
      accounts: existing.filter((account): account is LedgerAccount => account !== null),
    };
  }

  const accounts = definitions.map((def) => ({
    id: randomUUID(),
    companyId,
    accountCode: def.accountCode,
    displayName: def.displayName,
    accountKind: def.accountKind,
    normalSide: def.normalSide,
    isActive: true,
    openedAt: new Date().toISOString(),
    closedAt: null,
  }));

  for (const account of accounts) {
    store.insert(account);
  }

  return { status: "opened", accounts };
}

/** Look up a definition by code. The closed type prevents an unknown code from reaching here. */
function definitionOf(code: LedgerAccountCode): LedgerAccountDefinition {
  const definition = CHART_OF_ACCOUNTS.find((entry) => entry.accountCode === code);
  if (definition === undefined) {
    throw new Error(`unknown ledger account code: ${code}`);
  }
  return definition;
}
