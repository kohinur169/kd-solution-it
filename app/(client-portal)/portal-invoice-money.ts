// path: app/(client-portal)/portal-invoice-money.ts
import { priceFromMinor } from "../../services/products/price.ts";
import { appConfig } from "../../config/app.ts";

/**
 * How a client facing money amount and quantity are printed.
 *
 * ## Why the amount is printed at the column's own scale
 *
 * The platform stores money in minor units at four decimal places (`PRICE_SCALE`), and an invoice line's
 * total is the product of a three decimal quantity and a four decimal price, so a real invoice can hold
 * a fraction of a cent that a two decimal print would silently drop. The invoice PDF prints
 * `priceFromMinor`, this page prints `priceFromMinor`, and the receipt prints it too - so a buyer who
 * compares the paper, the screen and the receipt sees one number three times rather than three numbers
 * that agree to the cent and differ in the last two places.
 *
 * ## Why the currency follows the amount
 *
 * `USD 12.3400` and `12.3400 USD` are both readable, and the platform's other screens put the amount
 * first, so this one does too. The code is printed rather than a symbol because the invoice is a document
 * a buyer may show to an accountant in a country whose symbol for `$` is not the dollar.
 *
 * ## Why this module is separate from the read model
 *
 * The read model imports `node:crypto` to digest the document, and a client component that imported it
 * would drag a Node builtin into the browser bundle. Money formatting is needed on both sides of that
 * line, so it lives here, with two dependencies that are themselves browser safe.
 */

/** `12.3400 USD`, from an exact count of minor units and the currency it is counted in. */
export function portalMoneyTextOf(currency: string, minor: string): string {
  const parsed = BigInt(minor);

  return `${priceFromMinor(parsed)} ${currency}`;
}

/** The one currency this platform prices in, so a page can refuse a document it cannot print. */
export const PORTAL_CURRENCY_CODE = appConfig.money.currencyCode;

/** The floor a partial payment is held to, as a decimal string, straight from the configuration. */
export const PORTAL_MINIMUM_PARTIAL_PAYMENT = appConfig.money.minimumPartialPayment;

/**
 * A line's quantity, printed without the padding the column stores.
 *
 * `numeric(12,3)` answers `"2.500"` for two and a half units, and a buyer reading `2.500 hours` is
 * reading the database's scale rather than the invoice's sentence. Trailing zeros and a trailing point
 * are removed, so the printed form is `2.5`. A quantity that is a whole number prints without a point at
 * all, which is why `"3.000"` becomes `"3"`.
 */
export function portalQuantityTextOf(quantity: string): string {
  const trimmed = quantity.trim();

  if (!/^\d+(?:[.]\d+)?$/u.test(trimmed)) {
    return trimmed;
  }

  const withoutZeros = trimmed.includes(".") ? trimmed.replace(/0+$/u, "").replace(/[.]$/u, "") : trimmed;

  return withoutZeros.length === 0 ? "0" : withoutZeros;
}
