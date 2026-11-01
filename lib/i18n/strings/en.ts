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
  device: {
    proofRequired:
      "This browser has not registered its device key yet. Sign in again on this browser, then repeat this action.",
    bindingFailed:
      "This browser could not finish setting up its device key, so the session cannot continue. Reload the page and sign in again.",
  },
  reauth: {
    eyebrow: "Confirm it is you",
    title: "Prove your second factor again",
    description:
      "This action changes something that needs a recent proof. Enter the code from your authenticator app, or one of your backup codes, to continue.",
    codeLabel: "Code from the authenticator app",
    codeHint: "The six digit code that changes every thirty seconds. A backup code works too.",
    submit: "Continue",
    submitting: "Checking",
    invalidCode: "That code was not accepted. Check the app and type the code it shows now.",
    locked: "Too many failed attempts. This account cannot continue for another {minutes} minutes.",
    twoFactorRequired:
      "This account has not finished setting up its authenticator app. Finish that first, then come back.",
    backupCodeUsed:
      "That backup code was accepted and is no longer usable. {remaining} codes are left.",
    failed: "The code could not be checked. Try again.",
    signedOut: "Sign in again to continue.",
    unavailable: "The session could not be read. Try again.",
    alreadyFreshTitle: "You are already confirmed",
    alreadyFreshBody:
      "Your second factor was proved a moment ago, so this action can continue without another code.",
    home: "Go to the home page",
  },
  deviceConfirm: {
    eyebrow: "New device",
    title: "Confirm this device",
    description:
      "This browser has not used your account before. Confirm it with the code from your authenticator app to keep using the account here. The account address was told about this sign in at the same time.",
    codeLabel: "Code from the authenticator app",
    codeHint: "The six digit code that changes every thirty seconds. A backup code works too.",
    submit: "Confirm this device",
    submitting: "Confirming",
    invalidCode: "That code was not accepted. Check the app and type the code it shows now.",
    expiredChallenge: "This confirmation expired. Sign in again to receive a new one.",
    attemptsExhausted:
      "Too many wrong codes for this confirmation. Sign in again to receive a new one.",
    twoFactorRequired:
      "This account has not finished setting up its authenticator app. Finish that first, then confirm this device.",
    failed: "The confirmation was not saved. Try again.",
    confirmedTitle: "This device is confirmed",
    confirmedBody:
      "The device was confirmed with your authenticator app. You can keep using the account here.",
    unknownDevice:
      "This browser is not registered as a device of this account. Sign in again on this browser.",
    signInRequired: "Sign in to confirm a device.",
    unavailable: "The device could not be read. Try again.",
    enrolLink: "Authenticator app",
    home: "Go to the home page",
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
  rateLimit: {
    wait: "Too many attempts from this network. Try again in {seconds} seconds.",
    waitWithMinutes: "Too many attempts from this network. Try again in {minutes} minutes.",
    unavailable: "The platform could not count this attempt, so it was not performed. Try again in a moment.",
  },
  sessions: {
    eyebrow: "Your account",
    title: "Signed in sessions",
    description:
      "Every session this account is signed in on, the device it belongs to and when it started. Ending one takes effect on that session's next request.",
    listTitle: "Live sessions",
    countLabel: "{count} sessions signed in.",
    empty: "No session is signed in. Signing in again creates one.",
    current: "This session",
    deviceUnknown: "Device not named",
    deviceConfirmed: "Confirmed device",
    deviceUnconfirmed: "Unconfirmed device",
    deviceDropped: "Device dropped",
    startedLabel: "Started",
    lastSeenLabel: "Last seen",
    expiresLabel: "Expires",
    revokeSubmit: "End this session",
    revokeCurrentSubmit: "Sign out this session",
    revokeOthersTitle: "End every other session",
    revokeOthersBody:
      "Every session except this one stops working on its next request. Use it after a device was lost.",
    revokeOthersSubmit: "End every other session",
    revokedDone: "The session ended. It cannot be used again.",
    revokedCurrentDone: "That was this session. Sign in again to continue.",
    othersRevoked: "{count} sessions ended.",
    othersNone: "No other session was signed in.",
    reauthRequired: "Prove your second factor again from the security screen, then try once more.",
    signedOut: "Sign in to see the sessions of your account.",
    unavailable: "Your sessions could not be read right now. Try again.",
    failed: "That did not work. Try again.",
    submitting: "Ending the session",
    home: "Go to the home page",
  },
  officeSessions: {
    eyebrow: "Platform office",
    title: "Sessions of one account",
    description:
      "Read the live sessions of one account and end any that should not be there. The merchant is signed out on that device at its next request, and the entry names you as the officer.",
    searchTitle: "Read one account",
    searchLabel: "Account id",
    searchSubmit: "Read sessions",
    listTitle: "Live sessions",
    missingAccount: "Name an account to read its sessions.",
    empty: "This account has no live session.",
    revokeSubmit: "End this session",
    revokedDone: "The session ended.",
    reauthRequired: "Prove your second factor again from the security screen, then try once more.",
    signedOut: "Sign in with an office account to read sessions.",
    forbidden: "This account cannot manage sessions.",
    unavailable: "The sessions could not be read. Try again.",
    failed: "That did not work. Try again.",
    submitting: "Ending the session",
    home: "Go to the home page",
  },
  office: {
    /** Eyebrow of every office screen: the platform side of the product. */
    eyebrow: "Platform office",
    workspaceTitle: "Office workspace",
    workspaceDescription:
      "Every office screen starts here. The roles this account holds decide which of them open, and nothing outside that list is offered.",
    rolesHeading: "Roles you hold",
    dutiesHeading: "What this role may do",
    sectionsHeading: "Where you can go",
    navLabel: "Office navigation",
    approvalChain:
      "A large action moves through three people: the one who requests it, then the chief executive, then the super administrator.",
    sectionWorkspace: "Workspace and roles",
    sectionWorkspaceDescription:
      "The roles this account holds, what each of them may do, and the office screens they open.",
    sectionSessions: "Account sessions",
    sectionSessionsDescription:
      "Read the live sessions of one account and end any that should not be there.",
    sectionTwoFactorResets: "Two factor reset queue",
    sectionTwoFactorResetsDescription:
      "Work the requests of merchants who lost the authenticator app and the backup codes with it.",
    roleSuperAdmin: "Super administrator",
    roleCeo: "Chief executive",
    roleComplianceKyc: "Compliance and KYC",
    roleFinanceOps: "Finance operations",
    roleSupport: "Support",
    roleBlogger: "Content and blog",
    charterSuperAdmin:
      "Full control of the platform: its name, logo, contact details and every general setting, and the permissions delegated to each office role.",
    charterCeo:
      "Approvals and the final KYC decision, the confirmation of a large super administrator action, and the country and pricing decisions taken with the super administrator.",
    charterComplianceKyc:
      "KYC review, underwriting criteria, manual payment review, dispute documents, and sanctions and PEP screening.",
    charterFinanceOps:
      "Reconciliation mismatches, failed payouts, settlement release, and the matching of each processor bill.",
    charterSupport:
      "Support tickets and merchant help. No gateway key, no payment data and no KYC decision.",
    charterBlogger:
      "Blog posts and public content only. No merchant, payment or KYC data.",
    accessDeniedTitle: "This account has no office access",
    accessDeniedBody:
      "An office screen needs an office role. Sign in with the account that holds one, or use the merchant area of your own account.",
    unavailableTitle: "The office could not be opened",
    unavailableBody:
      "The account behind this request could not be read just now, so nothing was shown. Try again in a moment.",
    homeLink: "Go to the home page",
    sectionDashboard: "Super admin dashboard",
    sectionDashboardDescription:
      "Where the platform stands today: the gateway summary of section 6, the roles you hold and how fresh your second factor is.",
    sectionGateways: "Payment gateways",
    sectionGatewaysDescription:
      "Add, test, enable and disable the five providers, with only the last four characters of every key.",
    sectionCeo: "CEO dashboard",
    sectionCeoDescription:
      "The approval queue of section 2, the country switch and the KYC decisions waiting for a final signature.",
  },
  officeDashboard: {
    eyebrow: "Platform office",
    title: "Super admin dashboard",
    description:
      "The state of the platform as the super administrator sees it: the gateways you control, the roles you hold, and how recently your second factor was proven.",
    accessHeading: "Your access",
    rolesLabel: "Roles you hold",
    secondFactorLabel: "Second factor",
    secondFactorFresh: "Proven at {at} UTC and valid until {until} UTC.",
    secondFactorStale:
      "Not proven in the last ten minutes. Prove it again before you add a key or change a provider.",
    reauthLink: "Prove the second factor again",
    gatewaysHeading: "Gateways",
    gatewaysSummary:
      "{total} providers: {enabled} enabled, {untested} never tested, {adapterless} with no adapter in this build.",
    gatewaysUnavailable: "The gateway summary could not be read just now. Try again in a moment.",
    gatewaysLink: "Open the gateway page",
    approvalHeading: "Approval chain",
    screensHeading: "Office screens",
    screensDescription: "Every screen your roles open, with what each of them is for.",
    home: "Go to the home page",
  },
  officeGateways: {
    eyebrow: "Platform office",
    title: "Payment gateways",
    description:
      "The five providers of section 6. Keys are encrypted before they are stored and never shown again, and a provider can only be enabled after its connection test passes.",
    addTitle: "Store a key",
    addDescription:
      "The key is sealed before it reaches the database. Only its last four characters stay readable, together with the time it changed.",
    modeLabel: "Mode",
    modeTest: "Sandbox",
    modeLive: "Live",
    labelLabel: "Key label",
    secretLabel: "Provider key",
    secretHint: "At least twelve characters, ending in four letters or digits.",
    addSubmit: "Store the key",
    addBusy: "Storing the key",
    storedDone: "The key is stored and disabled. Run its test to make it the active one.",
    keysHeading: "Keys",
    noKeys: "This provider holds no key yet.",
    lastFourLabel: "Last four characters",
    keyUpdatedLabel: "Last updated",
    keyStatusActive: "Active",
    keyStatusDisabled: "Disabled",
    neverTested: "Never tested",
    testSubmit: "Test the connection",
    testBusy: "Testing the connection",
    testPassed: "The connection test passed.",
    testFailed: "The connection test failed.",
    testDetailLabel: "What the test reported",
    enableSubmit: "Enable",
    disableSubmit: "Disable",
    enableBusy: "Changing the provider",
    enabledDone: "The provider is enabled.",
    disabledDone: "The provider is disabled, and its active keys are off with it.",
    enableAdapterMissing:
      "This build has no adapter for this provider, so it cannot be tested and cannot be enabled.",
    enableTestRequired: "Run the connection test first: a provider is never enabled without a passing test.",
    enableKeyRequired: "Store a key and pass its test before enabling this provider.",
    providerEnabled: "Enabled",
    providerDisabled: "Disabled",
    adapterInstalled: "Adapter installed",
    adapterMissing: "No adapter in this build",
    capabilitiesHeading: "Supports",
    capabilityAcceptance: "Payment acceptance",
    capabilityPayouts: "Payouts",
    capabilitySubmerchant: "Sub merchants",
    noCapability: "Nothing, according to this build",
    lastTestHeading: "Last test",
    lastTestPassed: "Passed",
    lastTestFailed: "Failed",
    lastTestNever: "This provider has never been tested.",
    enabledAtLabel: "Enabled at",
    duplicateKey: "That key is already stored for this provider.",
    invalidSecret:
      "That key cannot be stored: it needs at least twelve printable characters and a last four made of letters or digits.",
    invalidLabel: "Give the key a label of up to eighty characters.",
    unknownProvider: "This provider is not one this build knows, so nothing was stored.",
    reauthRequired:
      "Prove your second factor again from the security screen, then try once more.",
    forbidden: "This account cannot manage gateways.",
    signedOut: "Sign in with an office account to manage gateways.",
    unavailable: "The gateways could not be read just now. Try again in a moment.",
    failed: "That did not work. Try again.",
    conflict: "This changed while you were looking at it. Reload the page and try again.",
    home: "Go to the office workspace",
  },
  officeApprovals: {
    eyebrow: "Platform office",
    title: "CEO dashboard",
    description:
      "The chain of section 2 in one place: what is waiting for your decision, what is waiting for the last signature, and the two platform decisions the CEO makes.",
    queueHeading: "Waiting for the CEO",
    queueDescription:
      "Each row is one large action a colleague may not take alone. A decision here moves it to the super administrator, and nothing moves without both signatures.",
    queueEmpty: "Nothing is waiting for your decision.",
    nextHeading: "Waiting for the super administrator",
    nextEmpty: "Nothing is waiting for the last signature.",
    nextDescription:
      "Requests you have approved, and requests raised by the super administrator, until the chain's final signature arrives.",
    stageCeo: "With the CEO",
    stageFinal: "With the super administrator",
    expiredBadge: "Expired",
    actionPayoutRelease: "Payout release",
    actionReserveRelease: "Reserve release",
    actionPlatformFeeChange: "Platform fee change",
    actionCountryEnable: "Country enable",
    subjectLabel: "Subject",
    amountLabel: "Amount (in minor units)",
    requesterLabel: "Raised by",
    requesterUnknown: "an account that no longer exists",
    requestedAtLabel: "Raised at",
    expiresAtLabel: "Expires at",
    noteLabel: "Why it was raised",
    raiseHeading: "Raise a request",
    raiseDescription:
      "A request goes to the CEO first and needs the super administrator's signature after that. It expires in three days if nobody decides.",
    actionTypeLabel: "Action",
    subjectIdLabel: "Subject id",
    subjectLabelLabel: "What the CEO will read",
    amountLabelForm: "Amount in minor units (optional)",
    currencyLabel: "Currency",
    noteFieldLabel: "Why",
    noteHint: "At least ten characters. The CEO reads this before deciding.",
    raiseSubmit: "Send to the CEO",
    raiseBusy: "Sending the request",
    raisedDone: "The request is in the queue for the CEO.",
    cannotRaise: "Your roles cannot raise a request into this chain.",
    duplicateRequest: "That subject is already waiting for a decision.",
    amountPairProblem: "Give both an amount and a currency, or neither.",
    amountInvalid: "The amount must be a whole number above zero, in minor units.",
    unknownAction: "That action is not one of the four the chain carries.",
    countriesHeading: "Countries",
    countriesSummary: "{enabled} enabled, {disabled} disabled, {sanctioned} sanctioned and permanently off.",
    countriesNote:
      "Section 36 puts the country switch in the CEO's hands together with the super administrator's. A sanctioned country stays off whatever anybody decides.",
    kycHeading: "KYC final decisions",
    kycCount: "{count} submissions are reviewed by compliance and waiting for the final decision.",
    kycNote: "Section 2 gives the CEO the final KYC decision, and section 5 keeps four eye review for large merchants.",
    reauthRequired:
      "Prove your second factor again from the security screen, then try once more.",
    forbidden: "This account cannot open the approval queue.",
    signedOut: "Sign in with an office account to open the approval queue.",
    unavailable: "The approval queue could not be read just now. Try again in a moment.",
    failed: "That did not work. Try again.",
    conflict: "This changed while you were looking at it. Reload the page and try again.",
    home: "Go to the office workspace",
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
    newDevice: {
      /** Subject of the section 23 alert of section 22: an account was used from a new device. */
      subject: "A new device signed in to your account. Confirm it with your authenticator",
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
