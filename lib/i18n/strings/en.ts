// path: lib/i18n/strings/en.ts
import { deepFreeze } from "../../utils/freeze.ts";

/**
 * The English string catalog: the single home of every user facing string.
 *
 * English is the schema. This object is the source language, `TranslationCatalog` is derived
 * from it, and every future locale must satisfy that same shape. Message paths are generated
 * from these keys, so a typo in a key is a compile error rather than a blank line on a
 * screen.
 *
 * Rules for this file:
 * - one key per rendered sentence or label, named in camelCase, grouped by area;
 * - no markup, no HTML and no formatting, because presentation belongs to the component;
 * - placeholders are written `{name}` with a camelCase identifier and are only used through
 *   `formatMessage`, which refuses to render a half substituted sentence;
 * - no number, amount, date or limit lives here. Business values come from `config/app.ts`;
 *   this file only decides how a value is worded.
 */

const catalog = {
  locale: {
    /** BCP 47 language tag, used for `lang` on the document element. */
    code: "en",
    /** Human readable name of the language, for a future language picker. */
    name: "English",
    /** Writing direction of the language. */
    direction: "ltr",
  },
  brand: {
    name: "KD Solution IT",
    description:
      "Enterprise multi-tenant payment facilitator platform for Asian merchants with worldwide merchant country control.",
  },
  home: {
    eyebrow: "Foundation",
    facts: {
      currency:
        "Amounts are held in USD only, stored as numeric(18,4) and never calculated with floating point.",
      isolation:
        "Every tenant record is isolated by row level security and every mutation is audit logged.",
      storage: "Files are encrypted with AES-256-GCM before they reach object storage.",
    },
    structureGate:
      "The structure gate enforces {directories} canonical directories and {rootFiles} root files on every verification run.",
    healthLink: "Service health",
  },
  shell: {
    /** Skip link, announced to a screen reader before the header. */
    skipToContent: "Skip to content",
    /** Accessible name of the brand link in the header. */
    homeLink: "Go to the home page",
    /** Accessible name of the theme switcher group. */
    themeLabel: "Theme",
    themeSystem: "System",
    themeLight: "Light",
    themeDark: "Dark",
  },
  errors: {
    /** Every message states what the client can do next. None describes what the server saw. */
    validationFailed:
      "Some of the information sent could not be accepted. Check the highlighted fields and try again.",
    authenticationRequired: "Sign in to continue.",
    permissionDenied: "This account does not have permission to perform that action.",
    resourceNotFound: "The requested item could not be found.",
    methodNotAllowed: "This endpoint does not accept that request method.",
    conflict: "The item was changed by another request. Reload it and try again.",
    idempotencyConflict:
      "A request with this idempotency key was already processed with different details.",
    payloadTooLarge: "The request is larger than this endpoint accepts.",
    unsupportedMediaType: "This endpoint accepts JSON request bodies only.",
    rateLimited: "Too many requests. Wait a moment and try again.",
    accountLocked:
      "This account is locked after too many failed attempts. Signing in does not work until the lock ends, and the office unlocks it only after confirming it with the owner by email.",
    dependencyFailed: "A connected service did not answer correctly. Try again shortly.",
    serviceUnavailable: "The service is temporarily unavailable. Try again shortly.",
    timeout: "The request took too long to complete. Try again.",
    internal: "Something went wrong on our side. Quote the request id when you contact support.",
  },
  signup: {
    eyebrow: "Merchant account",
    title: "Create your merchant account",
    description:
      "One account for your business. We verify your email address before the dashboard opens, and creating the account records your acceptance of the policies that govern it.",
    fullNameLabel: "Your full name",
    emailLabel: "Work email",
    passwordLabel: "Password",
    passwordRulesTitle: "Your password must have",
    passwordRuleLength: "At least twelve characters.",
    passwordRuleKinds: "Three of four kinds: lower case, upper case, a digit, a symbol.",
    passwordRulePersonal: "Nothing from your email address, your name or your business name.",
    passwordRuleBreach: "No appearance in a known data breach.",
    passwordBreached:
      "That password has appeared in a known data breach. Choose one you have never used anywhere else.",
    passwordTooWeak: "That password does not meet the rules below. Choose a different one.",
    companyNameLabel: "Business name",
    policiesTitle: "Policies you accept",
    policiesNotice:
      "Creating the account records your acceptance of each policy below at the version published today, together with a hash of the text. A later version is a new acceptance.",
    policiesAccept: "I have read and accept every policy listed above.",
    turnstileNotice: "This form is protected by Cloudflare Turnstile.",
    submit: "Create account",
    submitting: "Creating account",
    successTitle: "Check your email",
    successBody:
      "We sent a confirmation link to {email}. Follow it to verify your address and open your account.",
    errorTitle: "The account could not be created",
    unreadableResponse: "The server answered with something this page cannot read. Try again.",
  },
  signin: {
    eyebrow: "Merchant account",
    title: "Sign in",
    description:
      "Use the work email and password of your merchant account. Every refusal on this page is the same sentence, because this page never says whether an address has an account.",
    emailLabel: "Work email",
    passwordLabel: "Password",
    turnstileNotice: "This form is protected by Cloudflare Turnstile.",
    submit: "Sign in",
    submitting: "Signing in",
    noAccount: "No account yet?",
    createAccount: "Create one",
    unreadableResponse: "The server answered with something this page cannot read. Try again.",
    secondFactorTitle: "Enter the code for this account",
    secondFactorBody:
      "The password was accepted and no session has been issued yet. Enter the six digit code from your authenticator app, or one of the backup codes you saved when two factor authentication was turned on.",
    secondFactorCodeLabel: "Authenticator code or backup code",
    secondFactorSubmit: "Verify and sign in",
    secondFactorSubmitting: "Verifying",
    lockedTitle: "Account locked",
    locked:
      "Too many failed attempts. This account cannot sign in for another {minutes} minutes. The office unlocks it only after confirming it with the owner by email.",
    secondFactorLocked:
      "Too many failed codes. This account cannot sign in for another {minutes} minutes. The office unlocks it only after confirming it with the owner by email.",
    secondFactorRejected:
      "That code was not accepted. Wait for the next one in the app, or use a backup code.",
    secondFactorExpired:
      "This sign in took too long to complete. Enter the password again to start a new one.",
    secondFactorRestart: "Start again",
  },
  verify: {
    title: "Email verification",
    verifiedTitle: "Your email address is verified",
    verifiedBody:
      "Your account is ready. This browser now holds the session the platform issued when you followed the link.",
    invalidTitle: "This link is no longer valid",
    invalidBody:
      "A confirmation link works once and expires. Ask for a new one from the sign in page, or create the account again if it was never confirmed.",
    unavailableTitle: "Verification is temporarily unavailable",
    unavailableBody:
      "The platform could not reach the identity provider. Follow the link again in a few minutes.",
    home: "Go to the home page",
  },
  twoFactor: {
    eyebrow: "Account security",
    title: "Two factor authentication",
    description:
      "Section 22 requires a second factor on every account that holds a role. An authenticator app holds the secret: it shows a six digit code that changes every thirty seconds, and this page never sees that secret again after enrolment.",
    startTitle: "Step one - add the account to your authenticator app",
    startBody:
      "Open your authenticator app, choose to add an account and scan the code below. If the app cannot use a camera, type the key instead.",
    startSubmit: "Create the key",
    starting: "Creating the key",
    qrAlt: "QR code that adds this account to an authenticator app",
    manualKeyLabel: "Key for manual entry",
    copyHint: "The key is shown once. It is stored encrypted and cannot be read back on this page.",
    confirmTitle: "Step two - confirm the code",
    confirmBody:
      "Enter the six digit code the app shows for this account. Confirming proves the app holds the key, and only then does the second factor protect the account.",
    codeLabel: "Six digit code",
    confirmSubmit: "Turn on two factor authentication",
    confirming: "Checking the code",
    backupTitle: "Save your backup codes",
    backupBody:
      "Each code signs you in once if you lose the authenticator app. They are shown only now: the platform keeps a verifier for each, never the code itself. Store them somewhere a stranger cannot reach.",
    backupCodesLabel: "Backup codes",
    backupWarning:
      "Keep these somewhere safe and offline. Anyone holding one of them can pass the second factor once.",
    done: "I have saved the codes",
    enrolledTitle: "Two factor authentication is on",
    home: "Go to the home page",
    settingsLink: "Backup code settings",
    enrolLink: "Set up two factor authentication",
    settingsTitle: "Two factor settings",
    settingsDescription:
      "Backup codes are the way in when the authenticator app is lost. Each one works once, and a fresh set replaces every code you already have, so the old ones stop working the moment the new ones are shown.",
    settingsStatusTitle: "Current state",
    settingsEnrolled: "Two factor authentication is on for this account.",
    settingsNotEnrolled:
      "Two factor authentication is not on for this account yet, so there is no code set to replace.",
    settingsEnrolLink: "Turn on two factor authentication",
    settingsCodesRemaining: "{count} backup codes remain.",
    settingsCodesNone:
      "No backup codes remain. Generate a fresh set now, or you will need the recovery process if the app is lost.",
    settingsStepUpTitle: "Confirm with the authenticator app",
    settingsStepUpBody:
      "Generating a set of codes is generating new ways into the account, so the platform asks for the current six digit code first. It is in the app under this account.",
    settingsSubmit: "Generate new backup codes",
    settingsSubmitting: "Generating codes",
    settingsReplacedTitle: "The previous set no longer works",
    settingsReplacedBody: "{count} codes were replaced. Any code you saved before now signs nobody in.",
    enrolledBody:
      "This account now needs the authenticator app, or one of the backup codes, to sign in. The next sign in from a new browser asks for the code.",
    alreadyEnrolled:
      "Two factor authentication is already on for this account. Replacing the authenticator app needs the recovery steps, not this page.",
    signInRequired: "Sign in to manage two factor authentication.",
    unreadableResponse: "The server answered with something this page cannot read. Try again.",
    codeRejected: "That code was not accepted. Wait for the next one in the app and enter it before it changes.",
  },
  resetRequest: {
    eyebrow: "Account recovery",
    title: "Recover an account without the app",
    description:
      "If the authenticator app is gone and the backup codes went with it, ask the office to reset the second factor. The office checks who you are first, because a reset is a way into an account.",
    stepsTitle: "What happens",
    stepContact:
      "Send the request below. It reaches the office with the address this account uses.",
    stepDocuments: "Reply to our email with the identity documents the office asks for.",
    stepReset:
      "After those documents are checked, the second factor is removed and the password alone signs you in.",
    stepEnrol:
      "Enrol the new phone from the two factor screen, so the account has two locks again.",
    emailLabel: "The address on the account",
    reasonLabel: "What happened",
    reasonHint: "Tell us what happened to the app and to the codes, in a sentence or two.",
    submit: "Ask for a reset",
    submitting: "Sending the request",
    acceptedTitle: "The request is with the office",
    acceptedBody:
      "If this address belongs to an account, the office now has the request. Watch that inbox for the next step: nothing changes on the account until the documents are checked.",
    invalid: "Check the address and describe what happened before sending.",
    failed: "The request could not be sent. Try again.",
    link: "Lost the app and the backup codes?",
    home: "Go to the home page",
  },
  officeReset: {
    eyebrow: "Platform office",
    title: "Two factor reset requests",
    description:
      "A merchant who lost both the app and the backup codes asks here. Record the contact first: the reset is the step that removes the second factor, and it needs a record of what you verified.",
    queueTitle: "Waiting for a decision",
    empty: "No request is waiting. A new one appears here when a merchant asks.",
    countLabel: "{count} requests waiting.",
    accountLabel: "Account",
    companyLabel: "Company",
    noCompany: "No company",
    reasonLabel: "What the merchant reported",
    documentLabel: "Verified documents",
    documentMissing: "No document recorded yet.",
    requestedAtLabel: "Requested",
    contactedAtLabel: "Contact recorded",
    statusPending: "Waiting for contact",
    statusContacted: "Contact recorded",
    contactTitle: "Record the contact",
    contactBody:
      "Write what you verified: the documents the merchant sent, and how you matched them to the account.",
    contactFieldLabel: "What you verified",
    contactSubmit: "Record the contact",
    approveTitle: "Reset the second factor",
    approveBody:
      "This clears the authenticator secret and every backup code on the account. The merchant then signs in with the password alone and enrols again from the two factor screen.",
    approveSubmit: "Reset the second factor",
    rejectTitle: "Reject the request",
    rejectBody: "Write why. The merchant is told the request was refused, not the reason.",
    noteFieldLabel: "Reason for the decision",
    rejectSubmit: "Reject the request",
    submitting: "Saving",
    contactedDone: "Contact recorded. The request is ready for the reset.",
    approvedDone: "The second factor was cleared. The merchant can sign in with the password alone.",
    rejectedDone: "The request was rejected.",
    failed: "The decision was not saved. Try again.",
    conflict: "This request changed while this screen was open. Read the queue again.",
    signedOut: "Sign in with an office account to see the queue.",
    forbidden: "This account cannot decide reset requests.",
    unavailable: "The queue could not be read. Try again.",
    cancel: "Cancel",
    home: "Go to the home page",
  },
  email: {
    lockAlert: {
      /** Subject of the section 23 alert of section 22: the owner is told their account locked. */
      subject: "Your account was locked for two hours after failed sign in attempts",
    },
    accountUnlock: {
      /** Subject of the section 23 confirmation: the office ended the lock and the account works. */
      subject: "Your account was unlocked. Sign in and check your recent activity",
    },
  },
  policies: {
    kyc_kyb: "KYC and KYB Policy",
    ubo: "UBO Policy",
    aml_cft: "AML and CFT Policy",
    sanctions_pep: "Sanctions and PEP Screening Policy",
    underwriting: "Underwriting and Risk Assessment Policy",
    merchant_acceptance: "Merchant Acceptance and Prohibited and Restricted Businesses Policy",
    chargeback: "Chargeback and Dispute Management Policy",
    refund_settlement: "Refund and Settlement Policy",
    fraud_risk: "Fraud and Risk Management Policy",
    data_privacy: "Data Privacy and Security Policy",
    pci_dss: "PCI-DSS Compliance Policy",
    automated_decision_review: "Automated Decision Review Policy",
  },
  errorScreen: {
    title: "Something went wrong",
    description:
      "This page could not be shown. Try again, and quote the reference below if the problem continues.",
    retry: "Try again",
    home: "Back to the home page",
    referenceLabel: "Reference",
  },
} as const;

export const en = deepFreeze(catalog);

/** The contract every locale must satisfy. English is the source language. */
export type TranslationCatalog = typeof en;
