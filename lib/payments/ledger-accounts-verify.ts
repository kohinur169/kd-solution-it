// path: lib/payments/ledger-accounts-verify.ts
import process from "node:process";
import {
  CHART_OF_ACCOUNTS,
  MERCHANT_ACCOUNT_CODES,
  NORMAL_SIDE_OF,
  PLATFORM_ACCOUNT_CODES,
  InMemoryLedgerAccountStore,
  openMerchantChart,
  openPlatformChart,
} from "./ledger-accounts.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  if (condition) {
    checks++;
  } else {
    failures.push(description);
  }
}

/* ---- scenario 1: the chart is closed ---- */

expect(CHART_OF_ACCOUNTS.length === 8, "the chart holds exactly eight codes");

const chartCodes = CHART_OF_ACCOUNTS.map((entry) => entry.accountCode);
expect(new Set(chartCodes).size === chartCodes.length, "no account code appears twice in the chart");

expect(
  CHART_OF_ACCOUNTS.every(
    (entry) =>
      entry.displayName === entry.displayName.trim() &&
      entry.displayName.length >= 1 &&
      entry.displayName.length <= 80,
  ),
  "every display name is trimmed and between 1 and 80 characters",
);

/* ---- scenario 2: the kind/side pairing ---- */

for (const entry of CHART_OF_ACCOUNTS) {
  expect(
    entry.normalSide === NORMAL_SIDE_OF[entry.accountKind],
    `${entry.accountCode} is a ${entry.accountKind} on the ${entry.normalSide} side, which is the pairing the database enforces`,
  );
}

/* ---- scenario 3: the platform chart ---- */

const platformStore = new InMemoryLedgerAccountStore();
const platformResult = openPlatformChart({ store: platformStore });

expect(platformResult.status === "opened", "the platform chart opens for the first time");
expect(platformResult.accounts.length === 6, "the platform chart holds six accounts");
expect(
  platformResult.accounts.every((account) => account.companyId === null),
  "every platform account has a null company id",
);

const platformCodes = platformResult.accounts.map((account) => account.accountCode);
expect(
  platformCodes.every((code) => PLATFORM_ACCOUNT_CODES.includes(code)),
  "every platform account code is in the platform account list",
);

expect(
  new Set(platformCodes).size === platformCodes.length,
  "no duplicate account codes in the platform chart",
);

/* ---- scenario 4: the merchant chart ---- */

const merchantStore = new InMemoryLedgerAccountStore();
const merchantResult = openMerchantChart("company-1", { store: merchantStore });

expect(merchantResult.status === "opened", "the merchant chart opens for the first time");
expect(merchantResult.accounts.length === 2, "the merchant chart holds two accounts");
expect(
  merchantResult.accounts.every((account) => account.companyId === "company-1"),
  "every merchant account is scoped to the company",
);

const merchantCodes = merchantResult.accounts.map((account) => account.accountCode);
expect(
  merchantCodes.every((code) => MERCHANT_ACCOUNT_CODES.includes(code)),
  "every merchant account code is in the merchant account list",
);

expect(
  new Set(merchantCodes).size === merchantCodes.length,
  "no duplicate account codes in the merchant chart",
);

/* ---- scenario 5: the two scopes cover the full chart ---- */

const allCodes = new Set([...PLATFORM_ACCOUNT_CODES, ...MERCHANT_ACCOUNT_CODES]);
expect(allCodes.size === 8, "the platform and merchant codes together are the eight chart codes");

const overlap = [...PLATFORM_ACCOUNT_CODES].filter((code) => MERCHANT_ACCOUNT_CODES.includes(code));
expect(overlap.length === 0, "no account code appears in both scopes");

/* ---- scenario 6: opening is idempotent ---- */

const platformAgain = openPlatformChart({ store: platformStore });
expect(platformAgain.status === "already_open", "opening the platform chart twice returns already_open");
expect(
  platformAgain.accounts.length === platformResult.accounts.length,
  "the second platform opening returns the same number of accounts",
);

const merchantAgain = openMerchantChart("company-1", { store: merchantStore });
expect(merchantAgain.status === "already_open", "opening the merchant chart twice returns already_open");
expect(
  merchantAgain.accounts.length === merchantResult.accounts.length,
  "the second merchant opening returns the same number of accounts",
);

/* ---- scenario 7: the store holds exactly what was opened ---- */

let platformCount = 0;
for (const entry of CHART_OF_ACCOUNTS) {
  if (platformStore.findByCode(null, entry.accountCode) !== null) {
    platformCount++;
  }
}
expect(platformCount === 6, "the platform store holds exactly six accounts");

let merchantCount = 0;
for (const entry of CHART_OF_ACCOUNTS) {
  if (merchantStore.findByCode("company-1", entry.accountCode) !== null) {
    merchantCount++;
  }
}
expect(merchantCount === 2, "the merchant store holds exactly two accounts");

/* ---- scenario 8: the accounts are active ---- */

expect(
  platformResult.accounts.every((account) => account.isActive === true && account.closedAt === null),
  "every platform account is active with no close instant",
);

expect(
  merchantResult.accounts.every((account) => account.isActive === true && account.closedAt === null),
  "every merchant account is active with no close instant",
);

/* ---- scenario 9: every account has a unique id ---- */

const platformIds = platformResult.accounts.map((account) => account.id);
expect(new Set(platformIds).size === platformIds.length, "every platform account has a unique id");

const merchantIds = merchantResult.accounts.map((account) => account.id);
expect(new Set(merchantIds).size === merchantIds.length, "every merchant account has a unique id");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(`payments ledger accounts gate failed with ${String(failures.length)} problem(s):\n`);
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write(
  `payments ledger accounts gate passed: ${checks} checks, a chart of eight closed account codes opened twice - once for the platform with the six accounts the platform owns and once per merchant with the two accounts each merchant reads - with the kind and side pairing enforced, no account opened twice in the same scope, and opening a chart that is already open returning the accounts it already has\n`,
);
