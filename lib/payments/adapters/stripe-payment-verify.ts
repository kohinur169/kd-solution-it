// path: lib/payments/adapters/stripe-payment-verify.ts

/**
 * The gate for STEP 164's charge and payout leg: destination charges with the platform fee split, the read
 * that decides whether a charge was paid, and the transfer that pays a connected account.
 *
 * A check script, not a test file: it exercises the documented bodies, the idempotency discipline, the
 * outcome mapping and the store's invariants against a recording transport. No network call is made and no
 * real credential is used.
 */

import process from "node:process";
import type { EncryptionKeyring } from "../../security/encryption.ts";
import {
  applyStripePaymentIntentRead,
  buildStripePaymentIntentBody,
  buildStripeTransferBody,
  carriesCardLikeText,
  createStripeCharge,
  createStripeTransfer,
  encodeStripeForm,
  InMemoryStripeAttemptStore,
  isStripePaymentPath,
  parseStripePaymentIntentAnswer,
  parseStripeTransferAnswer,
  readStripePaymentIntent,
  stripeAmountFromPlatformMinor,
  stripeBodyFingerprint,
  stripeDeclineCodeOf,
  stripeIdempotencyKeyFor,
  stripePaymentEndpointFor,
  stripePaymentFetchTransport,
  stripePaymentIntentReadPath,
  stripePaymentMessageOf,
  stripePaymentOutcomeOf,
  stripePlatformMinorFromAmount,
  STRIPE_ATTEMPT_OUTCOMES,
  STRIPE_CHARGE_TYPE,
  STRIPE_CHARGE_TYPE_REASON,
  STRIPE_CURRENCY_EXPONENTS,
  STRIPE_DESCRIPTION_MAXIMUM_LENGTH,
  STRIPE_IDEMPOTENCY_HEADER,
  STRIPE_IDEMPOTENCY_KEY_PATTERN,
  STRIPE_MAXIMUM_AMOUNT_MINOR,
  STRIPE_METADATA_MAXIMUM_ENTRIES,
  STRIPE_PAYMENT_INTENT_PATTERN,
  STRIPE_PAYMENT_INTENT_PREFIX,
  STRIPE_PAYMENT_INTENT_STATUSES,
  STRIPE_PAYMENT_INTENTS_PATH,
  STRIPE_TRANSFER_PATTERN,
  STRIPE_TRANSFER_PREFIX,
  STRIPE_TRANSFERS_PATH,
  validateMetadata,
  validateStripeChargeRequest,
  validateStripeTransferRequest,
  type StripeAttempt,
  type StripePaymentTransport,
  type StripeTransferRequest,
  type StripeChargeRequest,
} from "./stripe-payment.ts";
import { configureStripeKeys, type StripeConfigStore, type StripeKeyConfig } from "./stripe-client.ts";
import { STRIPE_ACCOUNT_ID_PATTERN, STRIPE_PROVIDER_KEY } from "./stripe.ts";
import { stripeAccountReadinessOf, type StripeAccountProvision } from "./stripe-accounts.ts";

/* ---- the check book ---- */

let checks = 0;
const failures: string[] = [];

function expect(condition: boolean, description: string): void {
  checks += 1;
  if (!condition) failures.push(description);
}

function expectEqual(actual: unknown, expected: unknown, description: string): void {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectThrows(action: () => void, description: string): void {
  try {
    action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

function asText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
}

async function expectRejects(action: () => Promise<unknown>, description: string): Promise<void> {
  try {
    await action();
  } catch {
    checks += 1;
    return;
  }
  checks += 1;
  failures.push(description);
}

/* ---- fixtures ---- */

const fixture = (prefix: string, body: string): string => `${prefix}_${body}`;
const sandboxSecret = fixture("sk_test", "51NxAbCdEfGhIjKlMnOpQrStUvWx");
const firstWebhookSecret = fixture("whsec", "abcdefghijklmnopqrstuvwx");
const companyId = "9b2d3e4f-0000-4000-8000-000000000001";
const otherCompanyId = "9b2d3e4f-0000-4000-8000-000000000002";
const NOW = 1_760_000_000_000;
const ACCOUNT_ID = "acct_1QxAbCdEfGhIjKlMnOpQ";
const PAYMENT_INTENT_ID = "pi_3QxAbCdEfGhIjKlMnOpQ";
const TRANSFER_ID = "tr_3QxAbCdEfGhIjKlMnR";
const IDEMPOTENCY_KEY = "stripe_charge_0123456789abcdef0123456789abcdef";
const TRANSFER_IDEMPOTENCY_KEY = "stripe_transfer_0123456789abcdef0123456789ab";

const keyring: EncryptionKeyring = { primary: { id: "k1", secret: Buffer.alloc(32, 7).toString("base64") } };
const foreignKeyring: EncryptionKeyring = { primary: { id: "k9", secret: Buffer.alloc(32, 11).toString("base64") } };

class MemoryConfigStore implements StripeConfigStore {
  private readonly configs = new Map<string, StripeKeyConfig>();
  insert(config: StripeKeyConfig): void {
    this.configs.set(config.id, config);
  }
  findById(id: string): StripeKeyConfig | null {
    return this.configs.get(id) ?? null;
  }
  findByCompany(target: string): StripeKeyConfig[] {
    return [...this.configs.values()].filter((config) => config.companyId === target);
  }
  findActiveByCompany(target: string): StripeKeyConfig | null {
    return this.findByCompany(target).find((config) => config.status === "active") ?? null;
  }
  findPendingByCompany(target: string): StripeKeyConfig | null {
    return this.findByCompany(target).find((config) => config.status === "pending_activation") ?? null;
  }
  save(next: StripeKeyConfig): boolean {
    this.configs.set(next.id, next);
    return true;
  }
}

function configStoreFor(overrides: Partial<StripeKeyConfig> = {}): { store: StripeConfigStore; config: StripeKeyConfig } {
  const store = new MemoryConfigStore();
  const configured = configureStripeKeys(
    { companyId, environment: "sandbox", secretKey: sandboxSecret, publishableKey: null, webhookSecret: firstWebhookSecret },
    { store, keyring, occurredAtEpochMs: NOW },
  );
  const base = configured.status === "configured" ? configured.config : null;
  if (base === null) throw new Error("the fixture configuration could not be built");
  const active: StripeKeyConfig = {
    ...base,
    ...overrides,
    status: "active",
    lastTest: { outcome: "connected", testedAtEpochMs: NOW, environment: "sandbox", apiVersionSent: base.apiVersion },
  };
  store.insert(active);
  return { store, config: active };
}

function provisionFor(overrides: Partial<StripeAccountProvision> = {}): StripeAccountProvision {
  return {
    id: "0b1c2d3e-0000-4000-8000-000000000020",
    companyId,
    environment: "sandbox",
    kycSubmissionId: "0c3e4f5a-0000-4000-8000-000000000010",
    accountId: ACCOUNT_ID,
    activeCapabilities: ["card_payments", "stripe_transfers"],
    requirements: { currentlyDue: 0, pastDue: 0, pendingVerification: 0, disabledReason: null, state: "ready" },
    requirementsCollector: "application",
    status: "created",
    reason: null,
    requiresReconciliation: false,
    version: 3,
    createdAtEpochMs: NOW - 86_400_000,
    updatedAtEpochMs: NOW - 3_600_000,
    ...overrides,
  };
}

const chargeRequest: StripeChargeRequest = {
  companyId,
  amountMinor: 10_000n * 100n,
  platformFeeMinor: 10_000n * 3n,
  currency: "usd",
  destinationAccountId: ACCOUNT_ID,
  description: "Invoice INV-1001",
  metadata: { invoice_id: "INV-1001" },
  idempotencyKey: IDEMPOTENCY_KEY,
};

const transferRequest: StripeTransferRequest = {
  companyId,
  amountMinor: 10_000n * 90n,
  currency: "usd",
  destinationAccountId: ACCOUNT_ID,
  transferGroup: "INV_1001",
  metadata: { payout_id: "po_1001" },
  idempotencyKey: TRANSFER_IDEMPOTENCY_KEY,
};

const intentAnswer = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: PAYMENT_INTENT_ID,
    object: "payment_intent",
    amount: 10000,
    currency: "usd",
    status: "requires_payment_method",
    application_fee_amount: 300,
    client_secret: `${PAYMENT_INTENT_ID}_secret_9f8e7d6c5b4a`,
    ...overrides,
  });

type RecordedCall = {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly secretKey: string;
  readonly apiVersion: string;
  readonly idempotencyKey: string | null;
};

function recordingTransport(answerFor: (call: RecordedCall) => { readonly status: number; readonly body: string } | Promise<{ readonly status: number; readonly body: string }>): {
  readonly calls: RecordedCall[];
  readonly transport: StripePaymentTransport;
} {
  const calls: RecordedCall[] = [];
  const transport: StripePaymentTransport = async (call) => {
    const recorded: RecordedCall = {
      method: call.method,
      path: call.path,
      body: call.body,
      secretKey: call.secretKey,
      apiVersion: call.apiVersion,
      idempotencyKey: call.idempotencyKey,
    };
    calls.push(recorded);
    return answerFor(recorded);
  };
  return { calls, transport };
}

function throwingTransport(): { readonly calls: number; readonly transport: StripePaymentTransport } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    transport: async () => {
      state.calls += 1;
      throw new Error("the network is down");
    },
  };
}

/* ---- the documented vocabulary ---- */

expectEqual(STRIPE_CHARGE_TYPE, "destination", "the charge is a destination charge");
expect(
  STRIPE_CHARGE_TYPE_REASON.includes("STEP 163") && STRIPE_CHARGE_TYPE_REASON.includes("destination charges"),
  "the reason names STEP 163's responsibilities and the page's recommendation",
);
expectEqual(STRIPE_PAYMENT_INTENTS_PATH, "/v1/payment_intents", "the documented collection is used");
expectEqual(STRIPE_TRANSFERS_PATH, "/v1/transfers", "the documented transfer collection is used");
expectEqual(STRIPE_PAYMENT_INTENT_PREFIX, "pi_", "the documented intent prefix is kept");
expectEqual(STRIPE_TRANSFER_PREFIX, "tr_", "the documented transfer prefix is kept");
expectEqual(STRIPE_IDEMPOTENCY_HEADER, "Idempotency-Key", "the documented header name is used");
expectEqual(STRIPE_CURRENCY_EXPONENTS["usd"], 2, "USD counts in cents");
expectEqual(STRIPE_MAXIMUM_AMOUNT_MINOR, 99_999_999, "the amount bound is recorded");
expectEqual(STRIPE_DESCRIPTION_MAXIMUM_LENGTH, 200, "the documented description bound is recorded");
expectEqual(STRIPE_METADATA_MAXIMUM_ENTRIES, 20, "the metadata bound is recorded");
expectEqual(STRIPE_PROVIDER_KEY, "stripe", "the provider key is the registry key");
expect(Object.isFrozen(STRIPE_PAYMENT_INTENT_STATUSES), "the status vocabulary is frozen");
expect(Object.isFrozen(STRIPE_CURRENCY_EXPONENTS), "the currency exponents are frozen");
expect(Object.isFrozen(STRIPE_ATTEMPT_OUTCOMES), "the attempt outcome table is frozen");
expectEqual(STRIPE_PAYMENT_INTENT_STATUSES.length, 7, "the seven documented statuses are kept");
for (const status of ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "succeeded", "canceled"]) {
  expect(STRIPE_PAYMENT_INTENT_STATUSES.includes(status), `the documented status ${status} is kept`);
}
expectEqual(
  stripePaymentEndpointFor(STRIPE_PAYMENT_INTENTS_PATH),
  "https://api.stripe.com/v1/payment_intents",
  "a call goes to the documented base",
);
expectEqual(
  stripePaymentIntentReadPath(PAYMENT_INTENT_ID),
  `/v1/payment_intents/${PAYMENT_INTENT_ID}`,
  "the documented read path is built",
);

/* ---- the pattern guards ---- */

expect(STRIPE_PAYMENT_INTENT_PATTERN.test(PAYMENT_INTENT_ID), "a documented pi_ id is accepted");
expect(STRIPE_PAYMENT_INTENT_PATTERN.test(fixture("ch", "3QxAbCdEfGhIjKlMnOpQ")) === false, "a charge id is not an intent id");
expect(STRIPE_TRANSFER_PATTERN.test(TRANSFER_ID), "a documented tr_ id is accepted");
expect(STRIPE_TRANSFER_PATTERN.test(PAYMENT_INTENT_ID) === false, "an intent id is not a transfer id");
expect(STRIPE_IDEMPOTENCY_KEY_PATTERN.test(IDEMPOTENCY_KEY), "the derived idempotency key matches the documented shape");
expect(STRIPE_IDEMPOTENCY_KEY_PATTERN.test("short") === false, "a short idempotency key is refused");
expect(STRIPE_IDEMPOTENCY_KEY_PATTERN.test("a".repeat(256)) === false, "an over-long idempotency key is refused");
expect(STRIPE_IDEMPOTENCY_KEY_PATTERN.test("key with spaces here") === false, "an idempotency key with spaces is refused");
expect(STRIPE_IDEMPOTENCY_KEY_PATTERN.test("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "a V4 UUID is accepted");
expect(STRIPE_ACCOUNT_ID_PATTERN.test(ACCOUNT_ID), "the connected account id is accepted");

/* ---- the amount conversion ---- */

const conversion = stripeAmountFromPlatformMinor(29_000n, "usd");
expect(conversion.ok === true && conversion.amountMinor === 290, "29000 ten-thousandths is 290 cents");
const conversionOfUnit = stripeAmountFromPlatformMinor(10_000n, "USD");
expect(conversionOfUnit.ok === true && conversionOfUnit.amountMinor === 100, "one dollar is one hundred cents, case-insensitively");
const fractional = stripeAmountFromPlatformMinor(29_001n, "usd");
expect(fractional.ok === false, "an amount that is not a whole cent is refused");
expect(
  fractional.ok === false && fractional.reason === "the amount is not a whole number of the currency's smallest unit",
  "the refusal says why the amount is unusable",
);
const zero = stripeAmountFromPlatformMinor(0n, "usd");
expect(zero.ok === false && zero.reason === "the amount must be greater than zero", "a zero amount is refused");
const negative = stripeAmountFromPlatformMinor(-100n, "usd");
expect(negative.ok === false, "a negative amount is refused");
const unsupported = stripeAmountFromPlatformMinor(100n, "eur");
expect(unsupported.ok === false && unsupported.reason.includes("not supported"), "an unsupported currency is refused");
const tooLarge = stripeAmountFromPlatformMinor(BigInt(STRIPE_MAXIMUM_AMOUNT_MINOR + 1) * 100n, "usd");
expect(tooLarge.ok === false && tooLarge.reason === "the amount is too large", "an over-large amount is refused");
expectEqual(stripePlatformMinorFromAmount(290, "usd"), 29_000n, "the reverse conversion restores the platform's units");
expectEqual(stripePlatformMinorFromAmount(290, "eur"), null, "the reverse conversion refuses an unsupported currency");
expectEqual(stripePlatformMinorFromAmount(1.5, "usd"), null, "the reverse conversion refuses a fractional cent");

/* ---- the outcome mapping ---- */

expectEqual(stripePaymentOutcomeOf("succeeded"), "paid", "a succeeded intent is paid");
expectEqual(stripePaymentOutcomeOf("processing"), "pending", "a processing intent is money in flight");
expectEqual(stripePaymentOutcomeOf("requires_capture"), "pending", "a capturable intent is money in flight");
expectEqual(stripePaymentOutcomeOf("requires_action"), "requires_customer_action", "a 3DS intent needs the customer");
expectEqual(stripePaymentOutcomeOf("requires_payment_method"), "requires_customer_action", "a retryable intent needs the customer");
expectEqual(stripePaymentOutcomeOf("requires_confirmation"), "requires_customer_action", "an unconfirmed intent needs the customer");
expectEqual(stripePaymentOutcomeOf("canceled"), "failed", "a canceled intent is not paid");
expectEqual(stripePaymentOutcomeOf(" Succeeded "), "paid", "the status is read case-insensitively and trimmed");
expectEqual(stripePaymentOutcomeOf("something_new"), "unknown", "an unrecorded status is unknown, never a success");

/* ---- the charge request validation ---- */

expectEqual(validateStripeChargeRequest(chargeRequest), null, "a well formed charge request is accepted");
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, idempotencyKey: "short" }),
  "the idempotency key must be 16 to 255 characters of letters, digits, dashes or underscores",
  "a bad idempotency key is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, destinationAccountId: "cus_1QxAbCdEfGhIjKlMnOpQ" }),
  "the destination must be a connected account id",
  "a destination that is not a connected account is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, amountMinor: 0n }),
  "the amount must be greater than zero",
  "a zero charge is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, platformFeeMinor: -1n }),
  "the platform fee cannot be negative",
  "a negative fee is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, platformFeeMinor: chargeRequest.amountMinor }),
  "the platform fee must be smaller than the amount",
  "a fee equal to the amount is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, platformFeeMinor: 10_001n }),
  "the platform fee must be a whole number of the currency's smallest unit",
  "a fee with a fraction of a cent is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, description: "x".repeat(201) }),
  "the description is too long",
  "an over-long description is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, description: "4242424242424242" }),
  "a description must not carry card-like digits",
  "a card-shaped description is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, metadata: { invoice_id: `${PAYMENT_INTENT_ID}_secret_9f8e7d6c5b4a` } }),
  "a metadata value must not carry card-like digits",
  "a client secret in metadata is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, metadata: { "not allowed": "x" } }),
  "a metadata key must be 1 to 40 letters, digits or underscores",
  "a metadata key with a space is refused",
);
expectEqual(
  validateStripeChargeRequest({ ...chargeRequest, metadata: { invoice_id: "x".repeat(501) } }),
  "a metadata value is too long",
  "an over-long metadata value is refused",
);
const tooMuchMetadata: Record<string, string> = {};
for (let index = 0; index < 21; index += 1) tooMuchMetadata[`key_${index}`] = "value";
expectEqual(validateMetadata(tooMuchMetadata), "a request carries too many metadata entries", "too many metadata entries are refused");
expect(carriesCardLikeText("4000 0000 0000 0002"), "a spaced PAN is recognised as card-like");
expect(carriesCardLikeText("4000002500003155"), "an unspaced PAN is recognised as card-like");
expect(carriesCardLikeText(`${PAYMENT_INTENT_ID}_secret_abc12345`) === true, "a client secret is recognised");
expect(carriesCardLikeText("Invoice INV-1001") === false, "an invoice reference is not card-like");

/* ---- the charge body ---- */

const body = buildStripePaymentIntentBody(chargeRequest);
expectEqual(body["amount"], "10000", "the body carries the amount in cents");
expectEqual(body["currency"], "usd", "the body carries the lower-case currency");
expectEqual(body["transfer_data[destination]"], ACCOUNT_ID, "the body names the destination the documented way");
expectEqual(body["application_fee_amount"], "300", "the body splits the platform fee the documented way");
expectEqual(body["automatic_payment_methods[enabled]"], "true", "the body enables automatic payment methods");
expectEqual(body["description"], "Invoice INV-1001", "the body carries the description");
expectEqual(body["metadata[invoice_id]"], "INV-1001", "the body carries metadata the documented way");
expect(Object.keys(body).includes("confirm") === false, "the body never confirms a payment server-side");
expect(Object.keys(body).includes("payment_method") === false, "the body never carries a payment method");
expect(JSON.stringify(body).includes("client_secret") === false, "the body never carries a client secret");
const bodyWithoutFee = buildStripePaymentIntentBody({ ...chargeRequest, platformFeeMinor: 0n });
expect(Object.keys(bodyWithoutFee).includes("application_fee_amount") === false, "a zero fee omits the application fee entirely");
const bodyWithoutDescription = buildStripePaymentIntentBody({ ...chargeRequest, description: null, metadata: {} });
expect(Object.keys(bodyWithoutDescription).includes("description") === false, "no description is sent when none is given");
const encoded = encodeStripeForm({ "metadata[invoice_id]": "INV 1001" });
expectEqual(encoded, "metadata%5Binvoice_id%5D=INV%201001", "the form encoding escapes brackets and spaces");

/* ---- the transport ---- */

expect(isStripePaymentPath(STRIPE_PAYMENT_INTENTS_PATH), "the intents collection is an allowed path");
expect(isStripePaymentPath(STRIPE_TRANSFERS_PATH), "the transfers collection is an allowed path");
expect(isStripePaymentPath(stripePaymentIntentReadPath(PAYMENT_INTENT_ID)), "one intent's read path is allowed");
expect(isStripePaymentPath("/v1/charges") === false, "an unrecorded collection is not allowed");
expect(isStripePaymentPath(`/v1/payment_intents/${PAYMENT_INTENT_ID}/confirm`) === false, "a sub-resource is not allowed");
expect(isStripePaymentPath("/v1/transfers/tr_abc/") === false, "a trailing path is not allowed");

await expectRejects(
  () =>
    stripePaymentFetchTransport({
      method: "POST",
      path: "/v1/charges",
      contentType: "application/x-www-form-urlencoded",
      body: "amount=1",
      secretKey: sandboxSecret,
      apiVersion: "2026-10-28.preview",
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  "the transport refuses a call to a path that is not allowed",
);
await expectRejects(
  () =>
    stripePaymentFetchTransport({
      method: "POST",
      path: STRIPE_PAYMENT_INTENTS_PATH,
      contentType: "application/x-www-form-urlencoded",
      body: "amount=1",
      secretKey: "",
      apiVersion: "2026-10-28.preview",
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  "the transport refuses to call without a secret key",
);
await expectRejects(
  () =>
    stripePaymentFetchTransport({
      method: "POST",
      path: STRIPE_PAYMENT_INTENTS_PATH,
      contentType: "application/x-www-form-urlencoded",
      body: "amount=1",
      secretKey: sandboxSecret,
      apiVersion: "",
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  "the transport refuses to call without a dated API version",
);
await expectRejects(
  () =>
    stripePaymentFetchTransport({
      method: "POST",
      path: STRIPE_PAYMENT_INTENTS_PATH,
      contentType: "application/x-www-form-urlencoded",
      body: "",
      secretKey: sandboxSecret,
      apiVersion: "2026-10-28.preview",
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  "the transport refuses to post without a body",
);

/* ---- reading a charge answer ---- */

const createdRead = parseStripePaymentIntentAnswer(200, intentAnswer({ status: "succeeded" }));
expectEqual(createdRead.outcome, "created", "a documented answer is read as created");
expect(createdRead.outcome === "created" && createdRead.paymentIntentId === PAYMENT_INTENT_ID, "the intent id is read");
expect(createdRead.outcome === "created" && createdRead.paymentOutcome === "paid", "a succeeded answer is paid");
expect(createdRead.outcome === "created" && createdRead.amountMinor === 10000, "the amount is read back");
expect(createdRead.outcome === "created" && createdRead.feeMinor === 300, "the application fee is read back");
expect(
  createdRead.outcome === "created" && createdRead.clientSecret === `${PAYMENT_INTENT_ID}_secret_9f8e7d6c5b4a`,
  "the client secret is read for the page and for nothing else",
);
const requiresAction = parseStripePaymentIntentAnswer(200, intentAnswer());
expect(requiresAction.outcome === "created" && requiresAction.paymentOutcome === "requires_customer_action", "an intent awaiting the customer is not paid");

const declined = parseStripePaymentIntentAnswer(
  402,
  JSON.stringify({ error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." } }),
);
expectEqual(declined.outcome, "declined", "a documented card error is a decline, not a bad request");
expect(declined.outcome === "declined" && declined.declineCode === "insufficient_funds", "the decline code is kept");
expectEqual(stripeDeclineCodeOf(JSON.parse('{"error":{"code":"card_declined"}}')), "card_declined", "the error code is readable");
expectEqual(stripeDeclineCodeOf(JSON.parse('{"error":{"message":"no code"}}')), null, "no code means null");

const rejected = parseStripePaymentIntentAnswer(400, JSON.stringify({ error: { message: "Amount must be at least 50 cents" } }));
expectEqual(rejected.outcome, "rejected", "a 400 is a rejection");
expect(rejected.outcome === "rejected" && rejected.detail === "Amount must be at least 50 cents", "the provider's message is kept");
expectEqual(parseStripePaymentIntentAnswer(409, "{}").outcome, "rejected", "a 409 is a rejection");
expectEqual(parseStripePaymentIntentAnswer(422, "{}").outcome, "rejected", "a 422 is a rejection");
expectEqual(parseStripePaymentIntentAnswer(401, "{}").outcome, "failed", "a 401 is a failure");
expectEqual(parseStripePaymentIntentAnswer(403, "{}").outcome, "failed", "a 403 is a failure");
expectEqual(parseStripePaymentIntentAnswer(404, "{}").outcome, "failed", "a 404 is a failure");
expectEqual(parseStripePaymentIntentAnswer(302, "").outcome, "failed", "a redirect proves nothing");
expectEqual(parseStripePaymentIntentAnswer(429, "{}").outcome, "unknown", "a rate limit is unknown, because a charge may exist");
expectEqual(parseStripePaymentIntentAnswer(500, "{}").outcome, "unknown", "a server error is unknown");
expectEqual(parseStripePaymentIntentAnswer(503, "{}").outcome, "unknown", "an unavailable API is unknown");
expectEqual(parseStripePaymentIntentAnswer(408, "{}").outcome, "unknown", "a timeout is unknown");
expectEqual(parseStripePaymentIntentAnswer(200, JSON.stringify({ id: fixture("ch", "3QxAbCdEfGhIjKlMnOpQ") })).outcome, "unknown", "a 2XX naming no intent is unknown");
expectEqual(parseStripePaymentIntentAnswer(200, "not json").outcome, "unknown", "a 2XX with an unreadable body is unknown");
expect(stripePaymentMessageOf(JSON.parse('{"error":{"message":"  bad key  "}}')).length > 0, "the message reader returns text");
expectEqual(stripePaymentMessageOf(null), "", "the message reader returns the empty string for nothing");

/* ---- creating a charge ---- */

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer({ status: "requires_payment_method" }) }));
  const audits: string[] = [];
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
    recordAudit: (entry) => audits.push(entry.action),
  });
  expectEqual(result.status, "created", "a charge is created when the account is ready");
  expect(result.status === "created" && result.clientSecret === `${PAYMENT_INTENT_ID}_secret_9f8e7d6c5b4a`, "the client secret is handed to the caller");
  expect(result.status === "created" && result.attempt.providerId === PAYMENT_INTENT_ID, "the intent id is recorded");
  expect(result.status === "created" && result.attempt.clientSecretIssued === true, "the record knows a secret was issued");
  expect(
    result.status === "created" && asText(result.attempt).includes("_secret_") === false,
    "the record never stores the client secret",
  );
  expect(result.status === "created" && result.attempt.status === "created", "the attempt is recorded as created");
  expect(result.status === "created" && result.attempt.settlement === null, "an unconfirmed intent is not settled");
  expect(result.status === "created" && result.attempt.environment === "sandbox", "the environment is recorded");
  expectEqual(calls.length, 1, "one call is made");
  expectEqual(calls[0]?.method, "POST", "the call is a POST");
  expectEqual(calls[0]?.path, STRIPE_PAYMENT_INTENTS_PATH, "the call goes to the documented collection");
  expectEqual(calls[0]?.idempotencyKey, IDEMPOTENCY_KEY, "the documented idempotency header is sent");
  expectEqual(calls[0]?.secretKey, sandboxSecret, "the sealed key is opened for the call");
  expect(calls[0]?.body.includes("transfer_data%5Bdestination%5D=acct_") === true, "the call body names the destination");
  expectEqual(audits.join(","), "stripe_charge.created", "one audit entry is written for a created charge");
  expectEqual(store.findActiveByCompany(companyId)?.environment, "sandbox", "the fixture configuration is the active one");
}

{
  const { store } = configStoreFor();
  let callCount = 0;
  const transport: StripePaymentTransport = async () => {
    callCount += 1;
    return { status: 200, body: intentAnswer() };
  };
  const attemptStore = new InMemoryStripeAttemptStore();
  const options = { provision: provisionFor(), configStore: store, keyring, attemptStore, occurredAtEpochMs: NOW, transport };
  const first = await createStripeCharge(chargeRequest, options);
  expectEqual(first.status, "created", "the first charge is created");
  const replay = await createStripeCharge(chargeRequest, options);
  expectEqual(replay.status, "already_created", "a replay of the same key asks for a read instead of charging");
  expect(replay.status === "already_created" && replay.requiresRead === true, "the replay says a read is required");
  expect(replay.status === "already_created" && replay.attempt.providerId === PAYMENT_INTENT_ID, "the replay carries the recorded intent");
  expectEqual(callCount, 1, "the replay makes no second call");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 500, body: '{"error":{"message":"internal"}}' }));
  const audits: string[] = [];
  const options = {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
    recordAudit: (entry: { readonly action: string }) => audits.push(entry.action),
  };
  const first = await createStripeCharge(chargeRequest, options);
  expectEqual(first.status, "unknown", "a 5XX is an unknown charge, not a failure");
  expect(first.status === "unknown" && first.requiresReconciliation === true, "an unknown charge asks for reconciliation");
  expect(first.status === "unknown" && first.attempt.status === "unknown", "the attempt is recorded as unknown");
  const second = await createStripeCharge(chargeRequest, options);
  expectEqual(second.status, "in_flight", "a second attempt with the same key refuses to charge twice");
  expectEqual(calls.length, 1, "the in-flight refusal makes no call");
  expectEqual(audits.join(","), "stripe_charge.unknown", "the unknown outcome is audited once");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({
    status: 402,
    body: '{"error":{"type":"card_error","decline_code":"insufficient_funds","message":"Your card has insufficient funds."}}',
  }));
  const options = {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  };
  const declined = await createStripeCharge(chargeRequest, options);
  expectEqual(declined.status, "declined", "a decline is reported as a decline");
  expect(declined.status === "declined" && declined.declineCode === "insufficient_funds", "the decline code reaches the caller");
  const retry = await createStripeCharge(chargeRequest, options);
  expectEqual(retry.status, "failed", "a declined key is not reused");
  expect(retry.status === "failed" && retry.reason.includes("did not succeed"), "the refusal says to use a new key");
  expectEqual(calls.length, 1, "the declined retry makes no call");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 400, body: '{"error":{"message":"bad request"}}' }));
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(result.status, "rejected", "a 400 is a rejection");
  expect(result.status === "rejected" && result.attempt.status === "rejected", "the attempt is recorded as rejected");
  expectEqual(calls.length, 1, "a rejection made the call it reports");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor({ status: "pending", accountId: null, activeCapabilities: [], requirements: null }),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(result.status, "failed", "an uncreated account cannot take a charge");
  expect(result.status === "failed" && result.reason === "the account has not been created", "the refusal names the reason");
  expectEqual(calls.length, 0, "no call is made for an unready account");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor({ activeCapabilities: ["card_payments"], requirements: null }),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(result.status, "failed", "an account without the transfers capability cannot be charged");
  expectEqual(calls.length, 0, "no call is made when a capability is missing");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(
    { ...chargeRequest, companyId: otherCompanyId },
    {
      provision: provisionFor(),
      configStore: store,
      keyring,
      attemptStore: new InMemoryStripeAttemptStore(),
      occurredAtEpochMs: NOW,
      transport,
    },
  );
  expectEqual(result.status, "failed", "a charge cannot name another company");
  expectEqual(calls.length, 0, "no call is made across companies");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(
    { ...chargeRequest, destinationAccountId: "acct_1QxAbCdEfGhIjKlMnZZZ" },
    {
      provision: provisionFor(),
      configStore: store,
      keyring,
      attemptStore: new InMemoryStripeAttemptStore(),
      occurredAtEpochMs: NOW,
      transport,
    },
  );
  expectEqual(result.status, "failed", "a charge cannot name another connected account");
  expect(result.status === "failed" && result.reason === "the destination is not this company's connected account", "the refusal says why");
  expectEqual(calls.length, 0, "no call is made to a foreign account");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(
    { ...chargeRequest, amountMinor: 1n },
    {
      provision: provisionFor(),
      configStore: store,
      keyring,
      attemptStore: new InMemoryStripeAttemptStore(),
      occurredAtEpochMs: NOW,
      transport,
    },
  );
  expectEqual(result.status, "failed", "an invalid request is refused before the call");
  expectEqual(calls.length, 0, "an invalid request makes no call");
}

{
  const store = new MemoryConfigStore();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(result.status, "failed", "no active configuration means no charge");
  expect(result.status === "failed" && result.reason.includes("no active Stripe key configuration"), "the refusal names the configuration");
  expectEqual(calls.length, 0, "no call is made without a configuration");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring: foreignKeyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(result.status, "failed", "a keyring that cannot open the sealed key cannot charge");
  expect(result.status === "failed" && result.reason.includes("cannot be opened"), "the refusal names the sealed key");
  expectEqual(calls.length, 0, "no call is made with an unopenable key");
}

{
  const { store } = configStoreFor();
  const thrown = throwingTransport();
  const audits: string[] = [];
  const result = await createStripeCharge(chargeRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport: thrown.transport,
    recordAudit: (entry) => audits.push(entry.outcome),
  });
  expectEqual(result.status, "unknown", "a transport that throws is an unknown charge");
  expectEqual(thrown.calls, 1, "the transport was attempted once");
  expectEqual(audits.join(","), "unknown", "the thrown call is audited as unknown");
}

/* ---- reading a charge back ---- */

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer({ status: "succeeded" }) }));
  const read = await readStripePaymentIntent(PAYMENT_INTENT_ID, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(read.status, "read", "one intent is read");
  expect(read.status === "read" && read.outcome === "paid", "a read succeeded intent is paid");
  expect(read.status === "read" && read.clientSecret !== null, "a read carries the secret the page needs");
  expectEqual(calls[0]?.method, "GET", "the read is a GET");
  expectEqual(calls[0]?.idempotencyKey, null, "no idempotency key is sent on a GET");
  expectEqual(calls[0]?.path, stripePaymentIntentReadPath(PAYMENT_INTENT_ID), "the read uses the documented path");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: intentAnswer() }));
  const bad = await readStripePaymentIntent("ch_3QxAbCdEfGhIjKlMnOpQ", {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(bad.status, "failed", "an id that is not a pi_ id is refused");
  expectEqual(calls.length, 0, "an unusable id makes no call");
}

{
  const { store } = configStoreFor();
  const { transport } = recordingTransport(() => ({ status: 404, body: '{"error":{"message":"No such payment_intent"}}' }));
  const missing = await readStripePaymentIntent(PAYMENT_INTENT_ID, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(missing.status, "failed", "a 404 read reports failure, not a status");
}

{
  const { store } = configStoreFor();
  const thrown = throwingTransport();
  const unreachable = await readStripePaymentIntent(PAYMENT_INTENT_ID, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport: thrown.transport,
  });
  expectEqual(unreachable.status, "failed", "an unreachable API reports failure");
  expect(unreachable.status === "failed" && unreachable.reason.includes("unknown"), "the failure says the status is unknown");
}

/* ---- applying a read ---- */

function attemptFor(status: "created" = "created"): StripeAttempt {
  return {
    id: "0f1e2d3c-0000-4000-8000-000000000030",
    kind: "charge",
    companyId,
    environment: "sandbox",
    idempotencyKey: IDEMPOTENCY_KEY,
    amountMinor: chargeRequest.amountMinor,
    feeMinor: chargeRequest.platformFeeMinor,
    currency: "usd",
    destinationAccountId: ACCOUNT_ID,
    providerId: status === "created" ? PAYMENT_INTENT_ID : null,
    providerStatus: "requires_payment_method",
    status,
    settlement: null,
    clientSecretIssued: true,
    reason: null,
    requiresReconciliation: false,
    version: 1,
    createdAtEpochMs: NOW,
    updatedAtEpochMs: NOW,
  };
}

function storeWith(attempt: StripeAttempt): InMemoryStripeAttemptStore {
  const store = new InMemoryStripeAttemptStore();
  store.insert({ ...attempt, status: "pending", providerId: null, clientSecretIssued: false });
  store.save({ ...attempt, version: 2 }, 1);
  return store;
}

{
  const attempt = attemptFor();
  const store = storeWith(attempt);
  const applied = applyStripePaymentIntentRead(
    store.findById(attempt.id) ?? attempt,
    {
      status: "read",
      paymentIntentId: PAYMENT_INTENT_ID,
      providerStatus: "succeeded",
      outcome: "paid",
      amountMinor: 10000,
      currency: "usd",
      feeMinor: 300,
      clientSecret: `${PAYMENT_INTENT_ID}_secret_9f8e7d6c5b4a`,
    },
    { occurredAtEpochMs: NOW, attemptStore: store },
  );
  expectEqual(applied.status, "applied", "a matching read is applied");
  expect(applied.status === "applied" && applied.settlement === "paid", "a matching succeeded read is paid");
  expect(applied.status === "applied" && applied.attempt.settlement === "paid", "the attempt records the settlement");
  expectEqual(store.findById(attempt.id)?.settlement, "paid", "the store holds the settlement");
}

{
  const attempt = attemptFor();
  const store = storeWith(attempt);
  const applied = applyStripePaymentIntentRead(
    store.findById(attempt.id) ?? attempt,
    {
      status: "read",
      paymentIntentId: PAYMENT_INTENT_ID,
      providerStatus: "succeeded",
      outcome: "paid",
      amountMinor: 9999,
      currency: "usd",
      feeMinor: 300,
      clientSecret: null,
    },
    { occurredAtEpochMs: NOW, attemptStore: store },
  );
  expectEqual(applied.status, "applied", "a mismatched read is applied as a failure");
  expect(applied.status === "applied" && applied.settlement === "failed", "an amount mismatch is never paid");
  expect(applied.status === "applied" && applied.attempt.requiresReconciliation === true, "an amount mismatch asks for reconciliation");
}

{
  const attempt = attemptFor();
  const store = storeWith(attempt);
  const wrongFee = applyStripePaymentIntentRead(
    store.findById(attempt.id) ?? attempt,
    {
      status: "read",
      paymentIntentId: PAYMENT_INTENT_ID,
      providerStatus: "succeeded",
      outcome: "paid",
      amountMinor: 10000,
      currency: "usd",
      feeMinor: 250,
      clientSecret: null,
    },
    { occurredAtEpochMs: NOW, attemptStore: store },
  );
  expect(wrongFee.status === "applied" && wrongFee.settlement === "failed", "a fee mismatch is never paid");
}

{
  const attempt = attemptFor();
  const store = storeWith(attempt);
  const wrongCurrency = applyStripePaymentIntentRead(
    store.findById(attempt.id) ?? attempt,
    {
      status: "read",
      paymentIntentId: PAYMENT_INTENT_ID,
      providerStatus: "succeeded",
      outcome: "paid",
      amountMinor: 10000,
      currency: "eur",
      feeMinor: 300,
      clientSecret: null,
    },
    { occurredAtEpochMs: NOW, attemptStore: store },
  );
  expect(wrongCurrency.status === "applied" && wrongCurrency.settlement === "failed", "a currency mismatch is never paid");
}

{
  const attempt = attemptFor();
  const store = storeWith(attempt);
  const other = applyStripePaymentIntentRead(
    store.findById(attempt.id) ?? attempt,
    {
      status: "read",
      paymentIntentId: "pi_3QxAbCdEfGhIjKlMnZZZ",
      providerStatus: "succeeded",
      outcome: "paid",
      amountMinor: 10000,
      currency: "usd",
      feeMinor: 300,
      clientSecret: null,
    },
    { occurredAtEpochMs: NOW, attemptStore: store },
  );
  expectEqual(other.status, "failed", "a read of another intent is refused");
  expect(other.status === "failed" && other.reason === "the read describes another payment intent", "the refusal says why");
}

{
  const attempt = attemptFor();
  const store = storeWith(attempt);
  const pendingRead = applyStripePaymentIntentRead(
    store.findById(attempt.id) ?? attempt,
    {
      status: "read",
      paymentIntentId: PAYMENT_INTENT_ID,
      providerStatus: "processing",
      outcome: "pending",
      amountMinor: 10000,
      currency: "usd",
      feeMinor: 300,
      clientSecret: null,
    },
    { occurredAtEpochMs: NOW, attemptStore: store },
  );
  expect(pendingRead.status === "applied" && pendingRead.settlement === "pending", "a processing read is pending, not paid");
  const stale = applyStripePaymentIntentRead(attempt, {
    status: "read",
    paymentIntentId: PAYMENT_INTENT_ID,
    providerStatus: "succeeded",
    outcome: "paid",
    amountMinor: 10000,
    currency: "usd",
    feeMinor: 300,
    clientSecret: null,
  }, { occurredAtEpochMs: NOW, attemptStore: store });
  expectEqual(stale.status, "failed", "applying a read to hours-old state is refused instead of overwriting");
}

/* ---- the store's invariants ---- */

{
  const store = new InMemoryStripeAttemptStore();
  const pending: StripeAttempt = { ...attemptFor(), status: "pending", providerId: null, clientSecretIssued: false };
  store.insert(pending);
  expectThrows(() => store.insert(pending), "the store refuses a duplicate id");
  expectThrows(
    () => store.insert({ ...pending, id: "0f1e2d3c-0000-4000-8000-000000000031" }),
    "the store refuses a second attempt on the same idempotency key",
  );
  expectEqual(store.findByIdempotencyKey(companyId, "charge", IDEMPOTENCY_KEY)?.id, pending.id, "the key finds the attempt");
  expectEqual(store.findByIdempotencyKey(otherCompanyId, "charge", IDEMPOTENCY_KEY), null, "the key is scoped to the company");
  expectEqual(store.findByIdempotencyKey(companyId, "transfer", IDEMPOTENCY_KEY), null, "the key is scoped to the kind");

  const created: StripeAttempt = { ...pending, status: "created", providerId: PAYMENT_INTENT_ID, version: 2 };
  expectEqual(store.save(created, 1), true, "a forward move is saved");
  expectEqual(store.save({ ...created, amountMinor: 1n, version: 3 }, 2), false, "the amount never changes");
  expectEqual(store.save({ ...created, status: "declined", version: 3 }, 2), false, "a created row never leaves created");
  expectEqual(
    store.save({ ...created, providerId: "pi_3QxAbCdEfGhIjKlMnZZZ", version: 3 }, 2),
    false,
    "a recorded provider id never changes",
  );
  expectEqual(store.save({ ...created, status: "created", providerId: null, version: 3 }, 2), false, "a created row keeps its id");
  expectEqual(store.save({ ...created, settlement: "paid", version: 3 }, 2), true, "a created row records its settlement");
  expectEqual(store.save({ ...created, settlement: "failed", version: 4 }, 2), false, "a stale version is refused");

  const otherAttempt: StripeAttempt = { ...pending, id: "0f1e2d3c-0000-4000-8000-000000000032", idempotencyKey: `${IDEMPOTENCY_KEY}_b` };
  store.insert(otherAttempt);
  expectEqual(store.save({ ...otherAttempt, status: "unknown", version: 2 }, 1), true, "a pending row may become unknown");
  expectEqual(store.save({ ...otherAttempt, status: "created", providerId: null, version: 2 }, 1), false, "a pending row cannot jump to created without an id");
  expectEqual(store.save({ ...otherAttempt, companyId: otherCompanyId, status: "unknown", version: 2 }, 1), false, "the company never changes");
  expectEqual(store.save({ ...otherAttempt, kind: "transfer", status: "unknown", version: 2 }, 1), false, "the kind never changes");
  expectEqual(store.save({ ...otherAttempt, currency: "eur", status: "unknown", version: 2 }, 1), false, "the currency never changes");
  expectEqual(store.save({ ...otherAttempt, idempotencyKey: "another_key_0123456789abcdef", status: "unknown", version: 2 }, 1), false, "the key never changes");
}

/* ---- the payout leg ---- */

expectEqual(validateStripeTransferRequest(transferRequest), null, "a well formed transfer request is accepted");
expectEqual(
  validateStripeTransferRequest({ ...transferRequest, transferGroup: "not allowed" }),
  "the transfer group must be 1 to 64 letters, digits, dashes or underscores",
  "a bad transfer group is refused",
);
expectEqual(
  validateStripeTransferRequest({ ...transferRequest, amountMinor: 0n }),
  "the amount must be greater than zero",
  "a zero transfer is refused",
);
const transferBody = buildStripeTransferBody(transferRequest);
expectEqual(transferBody["amount"], "9000", "the transfer body carries the amount in cents");
expectEqual(transferBody["currency"], "usd", "the transfer body carries the currency");
expectEqual(transferBody["destination"], ACCOUNT_ID, "the transfer body names the destination");
expectEqual(transferBody["transfer_group"], "INV_1001", "the transfer body names the documented group");
expectEqual(transferBody["metadata[payout_id]"], "po_1001", "the transfer body carries metadata");

const transferAnswer = JSON.stringify({
  id: TRANSFER_ID,
  object: "transfer",
  amount: 9000,
  currency: "usd",
  destination: ACCOUNT_ID,
  transfer_group: "INV_1001",
  reversed: false,
});
const createdTransfer = parseStripeTransferAnswer(200, transferAnswer);
expect(createdTransfer.outcome === "created" && createdTransfer.transferId === TRANSFER_ID, "a transfer answer is read");
expect(createdTransfer.outcome === "created" && createdTransfer.amountMinor === 9000, "the transfer amount is read");
const insufficient = parseStripeTransferAnswer(
  400,
  JSON.stringify({ error: { code: "balance_insufficient", message: "Insufficient funds in Stripe account." } }),
);
expectEqual(insufficient.outcome, "rejected", "an insufficient balance is a rejection");
expect(insufficient.outcome === "rejected" && insufficient.insufficientFunds === true, "the insufficient balance is named");
expectEqual(parseStripeTransferAnswer(401, "{}").outcome, "failed", "a 401 transfer is a failure");
expectEqual(parseStripeTransferAnswer(500, "{}").outcome, "unknown", "a 5XX transfer is unknown");
expectEqual(parseStripeTransferAnswer(200, JSON.stringify({ id: PAYMENT_INTENT_ID })).outcome, "unknown", "a transfer answer naming no tr_ id is unknown");

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: transferAnswer }));
  const attemptStore = new InMemoryStripeAttemptStore();
  const options = { provision: provisionFor(), configStore: store, keyring, attemptStore, occurredAtEpochMs: NOW, transport };
  const created = await createStripeTransfer(transferRequest, options);
  expectEqual(created.status, "created", "a transfer is created for a ready account");
  expect(created.status === "created" && created.attempt.providerId === TRANSFER_ID, "the transfer id is recorded");
  expect(created.status === "created" && created.attempt.kind === "transfer", "the record is a transfer");
  expect(created.status === "created" && created.attempt.settlement === "pending", "a transfer is money in flight");
  expectEqual(calls[0]?.path, STRIPE_TRANSFERS_PATH, "the transfer is posted to the documented collection");
  expectEqual(calls[0]?.idempotencyKey, TRANSFER_IDEMPOTENCY_KEY, "the transfer sends its idempotency key");
  const replay = await createStripeTransfer(transferRequest, options);
  expectEqual(replay.status, "already_created", "a transfer replay does not transfer twice");
  expectEqual(calls.length, 1, "the transfer replay makes no call");
}

{
  const { store } = configStoreFor();
  const { transport } = recordingTransport(() => ({
    status: 200,
    body: JSON.stringify({ id: TRANSFER_ID, amount: 1, currency: "usd", destination: ACCOUNT_ID }),
  }));
  const mismatched = await createStripeTransfer(transferRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(mismatched.status, "created", "a transfer that names a different amount still exists");
  expect(mismatched.status === "created" && mismatched.attempt.requiresReconciliation === true, "a mismatched transfer asks for reconciliation");
  expect(mismatched.status === "created" && mismatched.attempt.settlement === "failed", "a mismatched transfer is not trusted");
}

{
  const { store } = configStoreFor();
  const { transport } = recordingTransport(() => ({
    status: 400,
    body: JSON.stringify({ error: { code: "balance_insufficient", message: "Insufficient funds in Stripe account." } }),
  }));
  const insufficientFunds = await createStripeTransfer(transferRequest, {
    provision: provisionFor(),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(insufficientFunds.status, "rejected", "an insufficient balance is reported as a rejection");
  expect(insufficientFunds.status === "rejected" && insufficientFunds.insufficientFunds === true, "the insufficient balance reaches the caller");
}

{
  const { store } = configStoreFor();
  const { calls, transport } = recordingTransport(() => ({ status: 200, body: transferAnswer }));
  const unready = await createStripeTransfer(transferRequest, {
    provision: provisionFor({ status: "unknown", accountId: null, activeCapabilities: [], requirements: null }),
    configStore: store,
    keyring,
    attemptStore: new InMemoryStripeAttemptStore(),
    occurredAtEpochMs: NOW,
    transport,
  });
  expectEqual(unready.status, "failed", "an account with an unknown creation cannot be paid");
  expectEqual(calls.length, 0, "no transfer is attempted for an unready account");
}

/* ---- the derived key and the fingerprint ---- */

const derived = stripeIdempotencyKeyFor(companyId, "charge", "INV-1001");
expect(STRIPE_IDEMPOTENCY_KEY_PATTERN.test(derived), "the derived key matches the documented shape");
expectEqual(derived, stripeIdempotencyKeyFor(companyId, "charge", "INV-1001"), "the derived key is deterministic");
expect(derived !== stripeIdempotencyKeyFor(companyId, "charge", "INV-1002"), "a different reference derives a different key");
expect(derived !== stripeIdempotencyKeyFor(companyId, "transfer", "INV-1001"), "a different kind derives a different key");
expectEqual(stripeBodyFingerprint("{}"), stripeBodyFingerprint("{}"), "the fingerprint is stable");
expect(stripeBodyFingerprint("{}") !== stripeBodyFingerprint("{\"a\":1}"), "a different body has a different fingerprint");
expectEqual(stripeBodyFingerprint("{}").length, 64, "the fingerprint is a SHA-256 hex digest");
expectEqual(stripeAccountReadinessOf(provisionFor()).canAcceptPayments, true, "the fixture account is ready");

/* ---- the verdict ---- */

if (failures.length > 0) {
  process.stderr.write(
    `payments Stripe Connect charges gate failed: ${failures.length} of ${checks} checks\n${failures
      .map((failure) => `  - ${failure}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `payments Stripe Connect charges gate passed: ${checks} checks (the documented destination-charge body with its exact unit conversion and fee split, one Idempotency-Key per attempt with the store as the guard, an honest unknown that asks for reconciliation, a read that only pays a matching intent, and the documented transfer with its insufficient-balance answer)\n`,
);
