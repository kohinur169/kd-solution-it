// path: lib/security/verify.ts
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { AppError } from "../errors/app-error.ts";
import {
  ALLOWED_RICH_TEXT_TAGS,
  decodeEntities,
  RICH_TEXT_POLICY,
  sanitizeRichText,
  stripMarkup,
  tokenizeRichText,
} from "./html.ts";
import { BLOCKED_HOST_SUFFIXES, isIpLiteral, isPublicAddress, isPublicHost, isPublicHostname } from "./host.ts";
import { escapeHtml, hasUnsafeCharacters, describeTextIssues, sanitizeFileName, sanitizeHeaderValue, sanitizeMultilineText, sanitizeSingleLineText, sanitizeSlug, TEXT_LIMITS } from "./text.ts";
import {
  assertOutboundUrl,
  checkOutboundUrl,
  createOutboundResolver,
  isLoopbackHost,
  OUTBOUND_PROVIDER_HOSTS,
  OUTBOUND_RULE,
  outboundPolicy,
  outboundRefusal,
  policyAllowsHost,
  requireOutboundUrl,
  type OutboundPolicy,
  type OutboundRejectionReason,
} from "./ssrf.ts";
import { isSafeRedirect, requireHttpUrl, sanitizeHttpUrl, sanitizeRelativePath } from "./url.ts";
import {
  buildContentSecurityPolicy,
  buildCspDirectives,
  createCspNonce,
  CSP_NONCE_PATTERN,
  FRAMEWORK_ASSET_PREFIXES,
  isCspNonce,
  isFrameworkAssetPath,
  type CspDirective,
} from "./csp.ts";
import {
  detectContentType,
  requireValidUpload,
  sha256Hex,
  sniffHead,
  UPLOAD_DATABASE_MAXIMUM_BYTES,
  UPLOAD_FIELD,
  UPLOAD_MAXIMUM_REASON_LENGTH,
  UPLOAD_PURPOSES,
  UPLOAD_POLICIES,
  UPLOAD_QUARANTINE_REASONS,
  UPLOAD_RULE,
  UPLOAD_SNIFF_BYTES,
  uploadRejection,
  validateUpload,
  type UploadPurpose,
  type UploadRejectionReason,
} from "./upload.ts";
import {
  headersFor,
  isSecurityHeaderName,
  SECURITY_HEADERS,
  SECURITY_HEADER_NAMES,
  type ResolvedHeader,
} from "./headers.ts";
import {
  decryptFile,
  encryptFile,
  encryptionAad,
  isEncryptionKey,
  isEncryptionKeyId,
  isFileEnvelope,
  isSecretEnvelope,
  openSecret,
  readFileEnvelopeInfo,
  sealSecret,
  secretEnvelopeKeyId,
  ENCRYPTION_AAD_PREFIX,
  ENCRYPTION_CHUNK_BYTES,
  ENCRYPTION_FILE_MAGIC,
  ENCRYPTION_IV_BYTES,
  ENCRYPTION_KEY_BYTES,
  ENCRYPTION_MAXIMUM_ENVELOPE_BYTES,
  ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES,
  ENCRYPTION_MAXIMUM_SCOPE_LENGTH,
  ENCRYPTION_MAXIMUM_SECRET_BYTES,
  ENCRYPTION_PURPOSES,
  ENCRYPTION_SECRET_PREFIX,
  ENCRYPTION_TAG_BYTES,
} from "./encryption.ts";
import {
  isPortalTokenCapability,
  isPortalTokenKind,
  mintPortalToken,
  openPortalToken,
  portalTokenDigest,
  PORTAL_TOKEN_CAPABILITIES,
  PORTAL_TOKEN_CAPABILITIES_BY_KIND,
  PORTAL_TOKEN_CLOCK_SKEW_SECONDS,
  PORTAL_TOKEN_DIGEST_PREFIX,
  PORTAL_TOKEN_ID_BYTES,
  PORTAL_TOKEN_KEY_BYTES,
  PORTAL_TOKEN_KINDS,
  PORTAL_TOKEN_MAXIMUM_KEYS,
  PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS,
  PORTAL_TOKEN_MAXIMUM_PAYLOAD_BYTES,
  PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS,
  PORTAL_TOKEN_PREFIX,
  PORTAL_TOKEN_PROBLEMS,
  PORTAL_TOKEN_SIGNATURE_BYTES,
  PORTAL_TOKEN_SIGNING_INFO,
  PORTAL_TOKEN_VERSION,
  type PortalTokenOpenOptions,
  type PortalTokenRequest,
} from "./portal-token.ts";
import {
  evaluateFraudSignals,
  fraudAuditEntry,
  fraudDecisionOf,
  isFraudPaymentMethod,
  isFraudProviderSignal,
  isFraudThreeDsOutcome,
  threeDsVerified,
  FRAUD_AUDIT_ACTION,
  FRAUD_CARD_FINGERPRINT_PATTERN,
  FRAUD_CURRENCY,
  FRAUD_DECISIONS,
  FRAUD_DEFAULT_POLICY,
  FRAUD_DETAILS,
  FRAUD_FAILURE_CODE,
  FRAUD_OUTCOMES,
  FRAUD_PAYMENT_METHODS,
  FRAUD_PROBLEMS,
  FRAUD_PROVIDER_SIGNALS,
  FRAUD_RULE,
  FRAUD_SIGNALS,
  FRAUD_THREE_DS_OUTCOMES,
  FRAUD_VELOCITY_LIMIT_MINIMUM,
  type FraudAttempt,
  type FraudDecision,
  type FraudPolicy,
  type FraudSignalLookups,
  type FraudVelocityReading,
  type FraudVelocitySubject,
} from "./fraud.ts";
import {
  auditEntryProblem,
  auditPayloadBytes,
  buildAuditEntry,
  createAuditWriter,
  isAuditSecretKey,
  readAuditIntegrityReport,
  readAuditMerkleRoot,
  redactAuditPayload,
  requireAuditEntry,
  verifyAuditChain,
  AUDIT_ACTION_PATTERN,
  AUDIT_ENTRY_PROBLEMS,
  AUDIT_ENTITY_TYPE_PATTERN,
  AUDIT_GENESIS_HASH,
  AUDIT_HASH_ARGUMENTS,
  AUDIT_HASH_FUNCTION,
  AUDIT_HASH_PATTERN,
  AUDIT_MAXIMUM_ACTION_LENGTH,
  AUDIT_MAXIMUM_ENTITY_TYPE_LENGTH,
  AUDIT_MAXIMUM_PAYLOAD_BYTES,
  AUDIT_MAXIMUM_PAYLOAD_DEPTH,
  AUDIT_MAXIMUM_USER_AGENT_LENGTH,
  AUDIT_MERKLE_FUNCTION,
  AUDIT_NEXT_LINK_FUNCTION,
  AUDIT_PLATFORM_CHAIN_ID,
  AUDIT_REDACTED,
  AUDIT_ROW_FIELDS,
  AUDIT_SECRET_KEY_FRAGMENTS,
  AUDIT_SEQUENCE_START,
  AUDIT_SIGNATURE_PATTERN,
  AUDIT_SIGNING_KEY_ID_PATTERN,
  AUDIT_TABLE,
  AUDIT_VERIFY_FUNCTION,
  type AuditEntry,
  type AuditEntryProblem,
  type AuditRpcClient,
  type AuditStoreClient,
} from "./audit.ts";
import {
  canonicalRateLimitAddress,
  consumeRateLimitBuckets,
  enforceRouteRateLimit,
  isRateLimitExemptRoute,
  isRateLimitReadMethod,
  normalizeRateLimitRoute,
  rateLimitAuditEntry,
  rateLimitBucketsFor,
  rateLimitClassForRoute,
  rateLimitHeaders,
  rateLimitScopeFor,
  RATE_LIMIT_AUDIT_ACTION,
  RATE_LIMIT_BUCKET_DIMENSIONS,
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_CLASS_POLICIES,
  RATE_LIMIT_COUNTER_FUNCTION,
  RATE_LIMIT_EXEMPT_ROUTES,
  RATE_LIMIT_KEY_HASH_PATTERN,
  RATE_LIMIT_MAXIMUM_SCOPE_LENGTH,
  RATE_LIMIT_MAXIMUM_WINDOW_SECONDS,
  RATE_LIMIT_MINIMUM_WINDOW_SECONDS,
  RATE_LIMIT_RULE,
  RATE_LIMIT_SCOPE_PATTERN,
  type RateLimitAuditEntry,
  type RateLimitAuditTrail,
  type RateLimitCounterClient,
  type RateLimitDependencies,
} from "./rate-limit.ts";
import {
  canonicalVelocityAddress,
  canonicalVelocitySubject,
  consumeVelocity,
  createVelocityReader,
  isVelocitySubject,
  sweepVelocityWindows,
  velocityAuditEntry,
  velocityCardFingerprint,
  velocityRetryAfter,
  velocityWindowStart,
  VELOCITY_AUDIT_ACTION,
  VELOCITY_CARD_FINGERPRINT_PATTERN,
  VELOCITY_CONSUME_FUNCTION,
  VELOCITY_DEFAULT_POLICY,
  VELOCITY_MAXIMUM_CARD_TOKEN_LENGTH,
  VELOCITY_MAXIMUM_LIMIT,
  VELOCITY_MAXIMUM_WINDOW_SECONDS,
  VELOCITY_MINIMUM_WINDOW_SECONDS,
  VELOCITY_PROBLEMS,
  VELOCITY_RETENTION_SECONDS,
  VELOCITY_RULE,
  VELOCITY_SUBJECTS,
  VELOCITY_TABLE,
  type VelocityAuditEntry,
  type VelocityAuditTrail,
  type VelocityCounterClient,
  type VelocityCounterOptions,
  type VelocityPolicy,
  type VelocityReading,
  type VelocitySweepClient,
  type VelocitySubjectKind,
} from "./velocity.ts";

/**
 * The gate behind the input sanitiser.
 *
 * `npm run check:security` runs it, and it is written as a corpus rather than as a smoke test: every
 * case below is a string that has defeated a sanitiser somewhere - the entity-encoded scheme in a
 * link, the comment that ends early, the `<img onerror>` with no closing tag, the metadata address,
 * the encoded `..`, the right-to-left override that makes a name display as something else. A
 * regression here is a stored XSS or an SSRF, which is why the corpus is long and why the gate exits
 * non-zero on one wrong answer.
 *
 * The last section reads the code rather than calling it: the tree is asserted to contain no second
 * escaping function and no `dangerouslySetInnerHTML` outside the one static theme script.
 */

const failures: string[] = [];
let checks = 0;

function expect(condition: boolean, description: string): void {
  checks += 1;

  if (!condition) {
    failures.push(description);
  }
}

function expectEqual<T>(actual: T, expected: T, description: string): void {
  checks += 1;

  if (actual !== expected) {
    failures.push(`${description} (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`);
  }
}

function expectRejects(action: () => void, description: string): void {
  checks += 1;

  try {
    action();
  } catch {
    return;
  }

  failures.push(description);
}

function expectThrows(action: () => void, description: string): AppError | null {
  checks += 1;

  try {
    action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }

    failures.push(`${description} (the rejection must be an AppError)`);

    return null;
  }

  failures.push(`${description} (nothing was rejected)`);

  return null;
}

/** ---- Text: one string, whatever a keyboard or a clipboard produced. */
function checkText(): void {
  expectEqual(sanitizeSingleLineText("e\u0301"), "\u00e9", "a combining accent is composed to one code point");
  expectEqual(sanitizeSingleLineText("abc\u0000def"), "abcdef", "the null byte is removed");
  expectEqual(sanitizeSingleLineText("a\r\nb"), "a b", "a line break becomes a space in a name");
  expectEqual(sanitizeSingleLineText("a\u2028b"), "a b", "the Unicode line separator too");
  expectEqual(sanitizeSingleLineText("\u0007bell\u001b[31m"), "bell[31m", "C0 controls are removed");
  expectEqual(sanitizeSingleLineText("a\u0085b"), "ab", "C1 controls are removed");
  expectEqual(sanitizeSingleLineText("abc\u202edef"), "abcdef", "a right-to-left override is removed");
  expectEqual(sanitizeSingleLineText("\u202eevil"), "evil", "so a string cannot start with one");
  expectEqual(sanitizeSingleLineText("a\u200bb\u200cc\u200dd"), "abcd", "zero-width characters are removed");
  expectEqual(sanitizeSingleLineText("\ufeffname"), "name", "a byte order mark is removed");
  expectEqual(sanitizeSingleLineText("soft\u00adhyphen"), "softhyphen", "a soft hyphen is removed");
  expectEqual(sanitizeSingleLineText("\u{e0041}\u{e0042}tag"), "tag", "the deprecated tag block is removed");
  expectEqual(sanitizeSingleLineText("non\ufffecharacter"), "noncharacter", "a non-character is removed");
  expectEqual(sanitizeSingleLineText("  a \t\t b  "), "a b", "whitespace is collapsed and trimmed");
  expectEqual(sanitizeSingleLineText("\u00a0padded\u00a0"), "padded", "a non-breaking space is whitespace too");

  const long = "a".repeat(300);
  expectEqual([...sanitizeSingleLineText(long)].length, TEXT_LIMITS.singleLine, "a name is bounded by the default ceiling");
  expectEqual([...sanitizeSingleLineText("x".repeat(50), 10)].length, 10, "and by the caller's ceiling");

  const emoji = "\u{1f600}".repeat(6);
  expectEqual([...sanitizeSingleLineText(emoji, 5)].length, 5, "the ceiling counts code points, so an emoji costs one");

  expectEqual(sanitizeMultilineText("a\n\nb"), "a\n\nb", "a note keeps its paragraph break");
  expectEqual(sanitizeMultilineText("a\n\n\n\n\nb"), "a\n\nb", "a run of blank lines collapses to one");
  expectEqual(sanitizeMultilineText("a\r\nb"), "a\nb", "a CRLF becomes one line break");
  expectEqual(sanitizeMultilineText("line   \nnext"), "line\nnext", "trailing spaces on a line go");

  const issues = describeTextIssues("a\u0000b\u0000c\u202ed", { maxLength: 3, multiline: false });

  expectEqual(issues.filter((issue) => issue.kind === "null_byte")[0]?.count, 2, "the issues count the null bytes");
  expectEqual(issues.some((issue) => issue.kind === "too_long"), true, "and report a value that is too long");
  expectEqual(issues.some((issue) => issue.kind === "bidi_control"), true, "and a bidirectional control");
  expectEqual(
    issues.every((issue) => !JSON.stringify(issue).includes("\u0000")),
    true,
    "an issue never carries the character it found",
  );
  expectEqual(hasUnsafeCharacters("ordinary name"), false, "ordinary text is not flagged");
  expectEqual(hasUnsafeCharacters("a\u0000b"), true, "and a null byte is");

  expectEqual(
    escapeHtml(`<script>alert("x")&'</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;&lt;/script&gt;",
    "every HTML metacharacter is escaped, both quote styles included",
  );
  expectEqual(escapeHtml("safe text"), "safe text", "and text without one is unchanged");

  expectEqual(sanitizeHeaderValue("Subject\r\nBcc: attacker@example.test"), "Subject Bcc: attacker@example.test", "a header value cannot carry a second header");
  expectEqual(sanitizeHeaderValue("a\u0000b"), "ab", "nor a null byte");

  const traversal = sanitizeFileName("../../etc/passwd");

  expectEqual(traversal.includes("/"), false, "a file name cannot carry a separator");
  expectEqual(traversal.includes(".."), false, "nor a parent directory");
  expectEqual(sanitizeFileName("C:\\Windows\\win.ini").includes("\\"), false, "nor a Windows separator");
  expectEqual(sanitizeFileName("CON.txt"), "_CON.txt", "a reserved device name is prefixed");
  expectEqual(sanitizeFileName("   "), "file", "an empty name becomes a name rather than an empty string");
  expectEqual(sanitizeFileName("%2e%2e/secret").includes(".."), false, "an encoded traversal is stripped");
  expectEqual(sanitizeFileName("invoice 2026-11.pdf"), "invoice 2026-11.pdf", "an ordinary name survives");

  expectEqual(sanitizeSlug("K.D. Trading Pvt. Ltd."), "k-d-trading-pvt-ltd", "a slug folds to ASCII words");
  expectEqual(sanitizeSlug("  --Hello   World--  "), "hello-world", "and trims and collapses its dashes");
  expectEqual(sanitizeSlug("a".repeat(200)).length, TEXT_LIMITS.slug, "and is bounded");
  expectEqual(sanitizeSlug("\u00c9t\u00e9"), "ete", "an accent is folded rather than dropped with the letter");
}

/** ---- Hosts: the destinations the platform must never dial. */
function checkHosts(): void {
  expectEqual(isPublicAddress("8.8.8.8"), true, "a public IPv4 address is reachable");
  expectEqual(isPublicAddress("10.1.2.3"), false, "a private range is not");
  expectEqual(isPublicAddress("172.16.5.4"), false, "nor 172.16/12");
  expectEqual(isPublicAddress("172.32.5.4"), true, "while 172.32 is outside it");
  expectEqual(isPublicAddress("127.0.0.1"), false, "loopback is not");
  expectEqual(isPublicAddress("169.254.169.254"), false, "the metadata service is the whole point");
  expectEqual(isPublicAddress("192.168.1.1"), false, "nor a home network");
  expectEqual(isPublicAddress("100.64.0.1"), false, "nor carrier grade NAT");
  expectEqual(isPublicAddress("0.0.0.0"), false, "nor the unspecified address");
  expectEqual(isPublicAddress("224.0.0.1"), false, "nor multicast");
  expectEqual(isPublicAddress("203.0.113.9"), false, "nor a documentation range");
  expectEqual(isPublicAddress("::1"), false, "IPv6 loopback is not reachable");
  expectEqual(isPublicAddress("::"), false, "nor the unspecified IPv6 address");
  expectEqual(isPublicAddress("fc00::1"), false, "nor a unique local address");
  expectEqual(isPublicAddress("fe80::1"), false, "nor a link local one");
  expectEqual(isPublicAddress("2001:db8::1"), false, "nor a documentation prefix");
  expectEqual(isPublicAddress("2606:4700:4700::1111"), true, "a public IPv6 address is");
  expectEqual(isPublicAddress("::ffff:127.0.0.1"), false, "an IPv4-mapped loopback is checked as IPv4");
  expectEqual(isPublicAddress("::ffff:8.8.8.8"), true, "and an IPv4-mapped public address as IPv4");
  expectEqual(isPublicAddress("payments"), false, "a bare word is not an address");

  expectEqual(isIpLiteral("10.0.0.1"), true, "an IPv4 literal is recognised");
  expectEqual(isIpLiteral("example.com"), false, "a name is not an address");

  expectEqual(isPublicHostname("example.com"), true, "a public name is reachable");
  expectEqual(isPublicHostname("api.stripe.com"), true, "and a real API host");
  expectEqual(isPublicHostname("localhost"), false, "localhost is not");
  expectEqual(isPublicHostname("redis.internal"), false, "nor an internal name");
  expectEqual(isPublicHostname("metadata.google.internal"), false, "nor the cloud metadata name");
  expectEqual(isPublicHostname("box.local"), false, "nor a mDNS name");
  expectEqual(isPublicHostname("payments"), false, "a single label is a service on the host, not a name on the internet");
  expectEqual(isPublicHostname("example"), false, "nor is a bare word");
  expectEqual(isPublicHostname("-example.com"), false, "a label cannot begin with a hyphen");
  expectEqual(isPublicHostname("example..com"), false, "nor be empty");
  expectEqual(isPublicHostname("xn--80ak6aa92e.com"), true, "a punycode name is a name");
  expectEqual(isPublicHost("192.168.0.1"), false, "a private literal is refused as a host");
  expectEqual(isPublicHost("example.com"), true, "and a public name accepted");
  expect(BLOCKED_HOST_SUFFIXES.includes(".internal"), "the suffix list includes the internal convention");
}

/** ---- URLs: what may be stored, fetched and redirected to. */
function checkUrls(): void {
  const publicPage = sanitizeHttpUrl("https://example.com/path?b=2&a=1");

  expectEqual(publicPage.ok, true, "an https URL is accepted");
  expectEqual(publicPage.value, "https://example.com/path?b=2&a=1", "and returned as the parser spells it");
  expectEqual(
    sanitizeHttpUrl("HTTPS://Example.COM:443/a").value,
    "https://example.com/a",
    "host case and the default port are canonicalised, so two spellings are one value",
  );

  expectEqual(sanitizeHttpUrl("javascript:alert(1)").reason, "unsupported_scheme", "a script URL is refused");
  expectEqual(sanitizeHttpUrl(" javaScript:alert(1)").reason, "unsupported_scheme", "and one with leading space");
  expectEqual(sanitizeHttpUrl("java\nscript:alert(1)").reason, "control_character", "and one split by a line break");
  expectEqual(sanitizeHttpUrl("java&#x61;script:alert(1)").ok, false, "and one written with an entity");
  expectEqual(sanitizeHttpUrl("data:text/html,<script>alert(1)</script>").reason, "unsupported_scheme", "a data URL is refused");
  expectEqual(sanitizeHttpUrl("vbscript:msgbox(1)").reason, "unsupported_scheme", "and a vbscript one");
  expectEqual(sanitizeHttpUrl("file:///etc/passwd").reason, "unsupported_scheme", "and a file URL");
  expectEqual(sanitizeHttpUrl("//evil.test/x").reason, "invalid_format", "a protocol relative URL has no scheme to allow");
  expectEqual(sanitizeHttpUrl("https://user:pass@example.com/").reason, "credentials", "credentials in a URL are refused");
  expectEqual(sanitizeHttpUrl("https://169.254.169.254/latest/meta-data/").reason, "private_host", "the metadata address is refused");
  expectEqual(sanitizeHttpUrl("https://127.0.0.1/admin").reason, "private_host", "so is loopback");
  expectEqual(sanitizeHttpUrl("https://redis.internal/").reason, "private_host", "and an internal name");
  expectEqual(sanitizeHttpUrl("https://example.com:8443/").reason, "unsupported_port", "a port nobody serves is refused");
  expectEqual(
    sanitizeHttpUrl("https://example.com:8443/", { allowedPorts: ["8443"] }).ok,
    true,
    "unless the caller allows that port",
  );
  expectEqual(sanitizeHttpUrl("https://example.com\\@evil.test/").reason, "backslash", "a backslash is refused");
  expectEqual(sanitizeHttpUrl("https://exa<mple.com/").reason, "markup_character", "so is markup");
  expectEqual(sanitizeHttpUrl("http://example.com/").reason, "unsupported_scheme", "http is refused by default");
  expectEqual(
    sanitizeHttpUrl("http://example.com/", { allowedProtocols: ["https:", "http:"] }).ok,
    true,
    "and allowed when a caller asks for it",
  );
  expectEqual(sanitizeHttpUrl("").reason, "empty", "an empty URL is refused");
  expectEqual(sanitizeHttpUrl("   ").reason, "empty", "so is whitespace");
  expectEqual(sanitizeHttpUrl("https://").reason, "invalid_format", "and a scheme with no host");
  expectEqual(sanitizeHttpUrl(`https://example.com/${"a".repeat(2_100)}`).reason, "too_long", "and one past the ceiling");

  const rejection = expectThrows(
    () => requireHttpUrl("https://169.254.169.254/", "webhookUrl"),
    "the throwing form refuses the metadata address",
  );

  expectEqual(rejection?.code, "VALIDATION_FAILED", "with the catalogue's validation code");
  expectEqual(rejection?.details[0]?.field, "webhookUrl", "and the field the caller named");
  expectEqual(rejection?.details[0]?.rule, "private_host", "and the reason a form can show");

  // ---- paths
  expectEqual(sanitizeRelativePath("/sessions").value, "/sessions", "a rooted path is accepted");
  expectEqual(sanitizeRelativePath("/a/../b").reason, "traversal", "a parent segment is refused");
  expectEqual(sanitizeRelativePath("/a/./b").reason, "traversal", "so is a current segment");
  expectEqual(sanitizeRelativePath("/%2e%2e/etc/passwd").ok, false, "an encoded traversal is refused");
  expectEqual(sanitizeRelativePath("/..%2fetc").ok, false, "and a half encoded one");
  expectEqual(sanitizeRelativePath("//evil.test/x").reason, "scheme", "a protocol relative path is refused");
  expectEqual(sanitizeRelativePath("/\\evil.test").reason, "backslash", "a backslash is refused");
  expectEqual(sanitizeRelativePath("sessions").reason, "not_rooted", "a path must be rooted");
  expectEqual(sanitizeRelativePath("javascript:alert(1)").ok, false, "a scheme is not a path");
  expectEqual(sanitizeRelativePath("/%00").reason, "control_character", "a null byte is refused");
  expectEqual(sanitizeRelativePath("/a?b=1").value, "/a?b=1", "a query survives the rebuild");
  expectEqual(sanitizeRelativePath("/").value, "/", "the root is a path");

  // ---- redirects
  expectEqual(isSafeRedirect("/sessions"), true, "a rooted path is a safe return");
  expectEqual(isSafeRedirect("https://evil.example.org/x", { allowedHosts: ["app.kdplatform.com"] }), false, "another host is not");
  expectEqual(
    isSafeRedirect("https://app.kdplatform.com/sessions", { allowedHosts: ["app.kdplatform.com"] }),
    true,
    "the platform's own host is",
  );
  expectEqual(isSafeRedirect("//evil.example.org", { allowedHosts: ["app.kdplatform.com"] }), false, "a protocol relative return is not");
  expectEqual(isSafeRedirect("javascript:alert(1)"), false, "and a script is never a destination");
}

/** ---- Rich text: rebuilt, not cleaned. */
function checkRichText(): void {
  expectEqual(sanitizeRichText("<p>Hello</p>"), "<p>Hello</p>", "a paragraph survives");
  expectEqual(sanitizeRichText("<p>a<script>alert(1)</script>b</p>"), "<p>ab</p>", "a script goes with its content");
  expectEqual(sanitizeRichText("<script>alert(1)</script>"), "", "and on its own leaves nothing");
  expectEqual(sanitizeRichText("<svg><script>alert(1)</script></svg>"), "", "an SVG is dropped whole");
  expectEqual(sanitizeRichText("<img src=x onerror=alert(1)>"), "", "an image with a handler is dropped");
  expectEqual(sanitizeRichText("<p onclick=\"alert(1)\">x</p>"), "<p>x</p>", "an event attribute is dropped");
  expectEqual(sanitizeRichText("<p style=\"background:url(javascript:alert(1))\">x</p>"), "<p>x</p>", "so is a style");
  expectEqual(sanitizeRichText("<div><p>x</p></div>"), "<p>x</p>", "an unknown tag goes and its content stays");
  expectEqual(sanitizeRichText("<a href=\"javascript:alert(1)\">x</a>"), "<a>x</a>", "a script link keeps its text and loses the href");
  expectEqual(sanitizeRichText("<a href=\"https://169.254.169.254/\">x</a>"), "<a>x</a>", "so does a link to the metadata service");

  const link = sanitizeRichText('<a href="https://example.com/x">x</a>');

  expectEqual(link, '<a href="https://example.com/x" rel="noopener noreferrer nofollow" target="_blank">x</a>', "a safe link carries rel and target");
  expectEqual(
    sanitizeRichText("<a href='https://example.com/?a=1&b=2'>x</a>").includes("&amp;"),
    true,
    "a query string is escaped, so it cannot become a second attribute",
  );
  expectEqual(sanitizeRichText("<a href=\"https://example.com\">a<a href=\"https://evil.test\">b</a></a>").split("<a ").length - 1, 1, "a nested link is not created");
  expectEqual(sanitizeRichText("<b>x</b><i>y</i>"), "<b>x</b><i>y</i>", "emphasis survives");
  expectEqual(sanitizeRichText("<p>a<b>b</p>c"), "<p>a<b>b</b></p>c", "an unclosed tag is closed where the input ends");
  expectEqual(sanitizeRichText("<p>1 > 2</p>"), "<p>1 &gt; 2</p>", "text is always escaped");
  expectEqual(sanitizeRichText("<p>&lt;script&gt;</p>"), "<p>&lt;script&gt;</p>", "an escaped script stays escaped");
  expectEqual(sanitizeRichText("<strong>a<!-- comment -->b</strong>"), "<strong>ab</strong>", "a comment is dropped");
  expectEqual(sanitizeRichText("<p>a<!-- unterminated"), "<p>a</p>", "an unterminated comment is dropped");
  expectEqual(sanitizeRichText("<<script>script>alert(1)<</script>/script>").includes("<script"), false, "the nested script trick produces no tag");
  expectEqual(sanitizeRichText("<p>unclosed"), "<p>unclosed</p>", "an unclosed paragraph is closed");
  expectEqual(sanitizeRichText("<p title=\"a>b\">x</p>"), "<p>x</p>", "a quoted bracket does not end the tag early");
  expectEqual(sanitizeRichText("plain text"), "plain text", "text without markup is text");
  expectEqual(sanitizeRichText("<p>a\u0000b</p>"), "<p>ab</p>", "a null byte never reaches the output");
  expectEqual(sanitizeRichText("<!doctype html><p>x</p>"), "<p>x</p>", "a doctype is dropped");

  const deep = `${"<blockquote>".repeat(40)}x${"</blockquote>".repeat(40)}`;

  expectEqual(
    sanitizeRichText(deep).split("<blockquote>").length - 1 <= RICH_TEXT_POLICY.maxDepth,
    true,
    "nesting is bounded by the policy",
  );

  const many = `${"<p>x</p>".repeat(RICH_TEXT_POLICY.maxNodes + 100)}`;

  expectEqual(
    sanitizeRichText(many).split("<p>").length - 1 <= RICH_TEXT_POLICY.maxNodes,
    true,
    "and so is the number of nodes",
  );

  expectEqual(stripMarkup("<p>Hello <strong>world</strong></p>"), "Hello world", "a summary is the text of the document");
  expectEqual(stripMarkup("<script>alert(1)</script>safe"), "safe", "and never the content of a script");
  expectEqual(decodeEntities("&amp;&lt;&#65;&#x42;&nbsp;"), "&<AB\u00a0", "the entity decoder understands the five, both numerics and nbsp");
  expectEqual(decodeEntities("&unknown;"), "&unknown;", "and leaves anything else literal");
  expectEqual(decodeEntities("&#0;"), "\ufffd", "a null character reference becomes the replacement character");

  expectEqual(tokenizeRichText("<p>x</p>").length, 3, "the tokeniser answers open, text and close");

  expect(RICH_TEXT_POLICY.allowedTags === ALLOWED_RICH_TEXT_TAGS, "the policy uses the published allowlist");
  expectEqual(RICH_TEXT_POLICY.allowedTags.includes("style"), false, "a style element is not allowed");
  expectEqual(RICH_TEXT_POLICY.allowedTags.includes("img"), false, "an image is not allowed, because it tracks");
  expectEqual(RICH_TEXT_POLICY.allowedTags.includes("script"), false, "and a script never is");
}

/** ---- The tree: one escaping function, one place that trusts markup. */


/* ------------------------------------------------------------------ 6. the destination rule */

/**
 * The SSRF corpus of STEP 058.
 *
 * The first half is the string: every address and every spelling that has been used to reach a
 * metadata service, a private range or the machine itself, plus the allowlist boundary that a suffix
 * comparison gets wrong. The second half is the half that matters - a name that is public as a string
 * and private as an address - because that is the case a sanitiser cannot see and this STEP exists to
 * decide.
 */
function checkOutboundStrings(): OutboundPolicy {
  const production = outboundPolicy({ projectUrl: "https://ref.supabase.co" });
  const development = outboundPolicy({ projectUrl: "http://127.0.0.1:54321", allowLoopback: true });

  expectEqual(production.allowLoopback, false, "a production policy allows no loopback");
  expectEqual(production.allowedPorts.length, 0, "and no port beside the scheme default");
  expect(production.allowedHosts.includes("ref.supabase.co"), "the project host is on the allowlist");
  expect(
    production.allowedHosts.includes(OUTBOUND_PROVIDER_HOSTS.challenge[0] ?? ""),
    "the challenge provider is on it",
  );
  expect(
    production.allowedHosts.includes(OUTBOUND_PROVIDER_HOSTS.breach[0] ?? ""),
    "and so is the breach corpus",
  );
  expectEqual(development.allowLoopback, true, "a development policy on loopback allows it");
  expect(
    development.allowedHosts.includes("127.0.0.1") === false,
    "and does not turn the address into an allowlist entry",
  );
  expectEqual(
    development.allowedHosts.length,
    production.allowedHosts.length - 1,
    "so its list holds the two providers and no project host",
  );
  expectEqual(development.allowedPorts[0], "54321", "the development port comes from the project URL");

  for (const entry of ["10.0.0.5", "169.254.169.254", "::1", "*.supabase.co", ".supabase.co", "localhost", "redis.internal", "payments", "ref.supabase.co:443", "ref.supabase.co/rest"]) {
    expectRejects(
      () => outboundPolicy({ projectUrl: "https://ref.supabase.co", extraHosts: [entry] }),
      `the allowlist refuses ${JSON.stringify(entry)} as an entry`,
    );
  }

  expectRejects(
    () => outboundPolicy({ projectUrl: "http://127.0.0.1:54321" }),
    "a loopback project URL is refused unless the policy says it is a development one",
  );

  expect(policyAllowsHost(production, "ref.supabase.co"), "a host matches itself");
  expect(policyAllowsHost(production, "a.challenges.cloudflare.com"), "and a name under it, on a dot boundary");
  expect(
    policyAllowsHost(production, "challenges.cloudflare.com.evil.gate") === false,
    "a name that merely ends with it does not",
  );
  expect(policyAllowsHost(production, "evilcloudflare.com") === false, "and neither does a name that runs into it");

  const refusals: readonly (readonly [string, OutboundRejectionReason, OutboundPolicy])[] = [
    ["http://ref.supabase.co/auth/v1/token", "unsupported_scheme", production],
    ["javascript:alert(1)", "unsupported_scheme", production],
    ["file:///etc/passwd", "unsupported_scheme", production],
    ["gopher://ref.supabase.co/", "unsupported_scheme", production],
    ["https://user:pass@ref.supabase.co/", "credentials", production],
    ["https://ref.supabase.co:8080/", "unsupported_port", production],
    ["https://127.0.0.1:5432/", "private_host", production],
    ["https://[::1]/", "private_host", production],
    ["https://[::ffff:127.0.0.1]/", "private_host", production],
    ["https://169.254.169.254/latest/meta-data/iam/security-credentials/", "private_host", production],
    ["https://10.0.0.5/", "private_host", production],
    ["https://192.168.1.1/", "private_host", production],
    ["https://172.16.0.1/", "private_host", production],
    ["https://redis.internal/", "private_host", production],
    ["https://metadata.google.internal/computeMetadata/v1/", "private_host", production],
    ["https://localhost/", "private_host", production],
    ["https://ref.supabase.co./rest/v1/", "private_host", production],
    ["https://evil.gate/", "host_not_allowed", production],
    ["https://ref.supabase.co.evil.gate/", "host_not_allowed", production],
    ["https://xn--80ak6aa92e.com/", "host_not_allowed", production],
    ["https://ref.supabase.co\\@evil.gate/", "backslash", production],
    ["//ref.supabase.co/rest/v1/", "invalid_format", production],
    ["not a url", "invalid_format", production],
    ["http://127.0.0.1:54321/auth/v1/token", "unsupported_scheme", production],
  ];

  for (const [value, reason, policy] of refusals) {
    const decision = checkOutboundUrl(value, policy);

    expect(decision.ok === false, `${JSON.stringify(value)} is not a destination`);

    if (!decision.ok) {
      expectEqual(decision.reason, reason, `and is refused as ${reason}`);
    }
  }

  const allowed: readonly (readonly [string, OutboundPolicy])[] = [
    ["https://ref.supabase.co/auth/v1/token", production],
    ["https://ref.supabase.co/rest/v1/users?select=id", production],
    ["https://sub.ref.supabase.co/rest/v1/users", production],
    ["https://challenges.cloudflare.com/turnstile/v0/siteverify", production],
    ["https://api.pwnedpasswords.com/range/ABCDE", production],
    ["http://127.0.0.1:54321/auth/v1/token", development],
    ["http://localhost:54321/rest/v1/users", development],
  ];

  for (const [value, policy] of allowed) {
    expect(checkOutboundUrl(value, policy).ok, `${JSON.stringify(value)} is a destination this policy allows`);
  }

  expect(
    checkOutboundUrl("HTTPS://REF.SUPABASE.CO/auth/v1/token", production).ok,
    "the host is compared lower cased",
  );
  expect(
    checkOutboundUrl("http://redis.internal/", development).ok === false,
    "a development policy still refuses a private name",
  );
  expect(
    checkOutboundUrl("https://10.0.0.5/", development).ok === false,
    "and still refuses a private address",
  );
  expect(
    checkOutboundUrl("http://127.0.0.1:6379/", development).ok === false,
    "and a loopback host on a port the project URL does not use",
  );
  expectEqual(isLoopbackHost("127.0.0.1"), true, "loopback is recognised as an address");
  expectEqual(isLoopbackHost("localhost"), true, "as a name");
  expectEqual(isLoopbackHost("::1"), true, "and as IPv6");
  expectEqual(isLoopbackHost("128.0.0.1"), false, "and a near miss is not loopback");

  return production;
}

/** The half that needs a resolver: a public name that answers with a private address. */
async function checkOutboundAddresses(policy: OutboundPolicy): Promise<void> {
  const answer = (addresses: readonly string[]) => () => Promise.resolve(addresses);

  const resolved = await assertOutboundUrl(
    "https://ref.supabase.co/auth/v1/token",
    policy,
    createOutboundResolver({ lookup: answer(["1.1.1.1", "93.184.216.34"]) }),
  );

  expect(resolved.ok, "a host whose every address is public is allowed");

  const metadata = await assertOutboundUrl(
    "https://ref.supabase.co/latest/meta-data/",
    policy,
    createOutboundResolver({ lookup: answer(["169.254.169.254"]) }),
  );

  expect(
    metadata.ok === false && metadata.reason === "private_address",
    "a name that resolves to the metadata service is refused",
  );

  const privateAddress = await assertOutboundUrl(
    "https://ref.supabase.co/",
    policy,
    createOutboundResolver({ lookup: answer(["10.0.0.5"]) }),
  );

  expect(
    privateAddress.ok === false && privateAddress.reason === "private_address",
    "and one that resolves into a private range",
  );

  const mixed = await assertOutboundUrl(
    "https://ref.supabase.co/",
    policy,
    createOutboundResolver({ lookup: answer(["1.1.1.1", "10.0.0.5"]) }),
  );

  expect(
    mixed.ok === false && mixed.reason === "private_address",
    "and so is a name that answers with one private address beside a public one",
  );

  const empty = await assertOutboundUrl(
    "https://ref.supabase.co/",
    policy,
    createOutboundResolver({ lookup: answer([]) }),
  );

  expect(
    empty.ok === false && empty.reason === "unresolvable",
    "a name with no address is not resolved by assumption",
  );

  const failing = await assertOutboundUrl(
    "https://ref.supabase.co/",
    policy,
    createOutboundResolver({ lookup: () => Promise.reject(new Error("ENOTFOUND")) }),
  );

  expect(failing.ok === false && failing.reason === "unresolvable", "a lookup that throws is a refusal, not a pass");

  let asked = 0;
  const unasked = await assertOutboundUrl(
    "https://evil.gate/",
    policy,
    createOutboundResolver({
      lookup: () => {
        asked += 1;

        return Promise.resolve(["1.1.1.1"]);
      },
    }),
  );

  expect(unasked.ok === false && unasked.reason === "host_not_allowed", "a host off the allowlist is refused");
  expectEqual(asked, 0, "before a lookup is made, because the query is a leak of its own");

  const cached = createOutboundResolver({ lookup: answer(["1.1.1.1"]) });

  await assertOutboundUrl("https://ref.supabase.co/one", policy, cached);
  await assertOutboundUrl("https://ref.supabase.co/two", policy, cached);

  expectEqual(cached.lookups(), 1, "one host is looked up once inside the cache window");

  let rebound = 0;
  const rebinding = createOutboundResolver({
    ttlMs: 0,
    lookup: () => {
      rebound += 1;

      return Promise.resolve(rebound === 1 ? ["1.1.1.1"] : ["10.0.0.5"]);
    },
  });

  expect(
    (await assertOutboundUrl("https://ref.supabase.co/", policy, rebinding)).ok,
    "the first answer of a rebinding zone is public",
  );

  const second = await assertOutboundUrl("https://ref.supabase.co/", policy, rebinding);

  expect(
    second.ok === false && second.reason === "private_address",
    "and the answer that changed to a private address is refused",
  );
  expectEqual(rebinding.lookups(), 2, "because the cache expired, not because the first verdict was kept");

  const bounded = createOutboundResolver({ limit: 1, lookup: answer(["1.1.1.1"]) });

  await assertOutboundUrl("https://ref.supabase.co/one", policy, bounded);
  await assertOutboundUrl("https://auth.ref.supabase.co/two", policy, bounded);

  expectEqual(bounded.lookups(), 2, "the cache is bounded, so a policy with many hosts cannot grow it without limit");

  const refusal = expectThrows(
    () => {
      throw outboundRefusal("private_host");
    },
    "a refusal is an application error",
  );

  expectEqual(refusal?.code, "VALIDATION_FAILED", "with the validation code");
  expectEqual(refusal?.details[0]?.field, "url", "naming the url field");
  expectEqual(refusal?.details[0]?.rule, OUTBOUND_RULE, "and the destination rule");

  let thrown: AppError | null = null;

  try {
    await requireOutboundUrl("https://169.254.169.254/", policy);
  } catch (error) {
    thrown = error as AppError;
  }

  expectEqual(thrown?.code, "VALIDATION_FAILED", "the throwing wrapper refuses a metadata URL with the validation code");
  expectEqual(
    (thrown?.cause as { reason?: string } | undefined)?.reason,
    "private_host",
    "and keeps the reason as evidence for the log, which the response never serialises",
  );
}

/* ------------------------------------------------------------------ 7. the policy */

/**
 * The Content Security Policy of STEP 059.
 *
 * A CSP is the one header where a small relaxation is invisible: add `'unsafe-inline'` to
 * `script-src` and every page still renders, every proof still passes, and the protection is gone.
 * This corpus therefore asserts the policy *negatively* as well as positively - that no directive
 * carries a wildcard, a bare scheme in `script-src`, `'unsafe-inline'` for scripts, or a directive
 * nobody reviewed - and it reads the tree to prove that the nonce the policy names is the nonce the
 * proxy minted and the layout used.
 */
function checkCsp(): void {
  const nonce = createCspNonce();

  expect(CSP_NONCE_PATTERN.test(nonce), "a minted nonce has the shape the pattern allows");
  expectEqual(nonce.length, 22, "and is 22 base64url characters, which is 128 bits");
  expectEqual(createCspNonce() === createCspNonce(), false, "two nonces are never the same one");
  expectEqual(isCspNonce(nonce), true, "and the value is recognised as a nonce");
  expectEqual(isCspNonce("short"), false, "a short value is not a nonce");
  expectEqual(isCspNonce(`${nonce}=`), false, "nor is a padded one");
  expectEqual(isCspNonce(`${"a".repeat(21)}!`), false, "nor one with a symbol");
  expectEqual(isCspNonce(""), false, "and an empty value is not a nonce");

  const production = buildCspDirectives({ nonce, development: false });
  const development = buildCspDirectives({ nonce, development: true });

  const sourceOf = (directives: readonly CspDirective[], name: string): readonly string[] =>
    directives.find((directive) => directive.name === name)?.values ?? [];

  expectEqual(
    production.map((directive) => directive.name).join(","),
    [
      "script-src",
      "style-src",
      "img-src",
      "font-src",
      "connect-src",
      "form-action",
      "base-uri",
      "object-src",
      "frame-src",
      "worker-src",
      "media-src",
      "manifest-src",
      "frame-ancestors",
      "upgrade-insecure-requests",
      "default-src",
    ].join(","),
    "the policy has exactly the directives this STEP reviewed, in order",
  );
  expectEqual(
    development.map((directive) => directive.name).includes("frame-ancestors"),
    false,
    "a development deployment is not told it may not be framed, because the preview embeds it",
  );
  expectEqual(
    development.map((directive) => directive.name).includes("upgrade-insecure-requests"),
    false,
    "and is not told to upgrade a plain http request, because it serves plain http",
  );

  const script = sourceOf(production, "script-src");

  expect(script.includes(`'nonce-${nonce}'`), "the script source list names this response's nonce");
  expect(script.includes("'strict-dynamic'"), "and carries the nonce onward to the chunks the bootstrap loads");
  expect(script.includes("'self'"), "with the same-origin fallback for a browser without strict-dynamic");
  expectEqual(script.includes("'unsafe-inline'"), false, "an inline script is never allowed without a nonce");
  expectEqual(script.includes("'unsafe-eval'"), false, "and a production policy never allows eval");
  expectEqual(script.includes("*"), false, "no script source is a wildcard");
  expectEqual(script.includes("http:"), false, "and no scheme source is allowed");
  expectEqual(script.includes("https:"), false, "in either spelling, because a scheme source is every host");
  expectEqual(sourceOf(development, "script-src").includes("'unsafe-eval'"), true, "a development policy allows eval for React Refresh");
  expectEqual(sourceOf(development, "script-src").includes("'unsafe-inline'"), false, "and still refuses an inline script without a nonce");

  expectEqual(sourceOf(production, "style-src").join(" "), "'self' 'unsafe-inline'", "styles allow an inline block and nothing else");
  expectEqual(sourceOf(production, "img-src").join(" "), "'self' data: blob:", "images come from this origin or from a data URL");
  expectEqual(sourceOf(production, "connect-src").join(" "), "'self'", "a production browser may only call this origin");
  expectEqual(sourceOf(development, "connect-src").join(" "), "'self' ws: wss:", "and a development one speaks to its own websocket");
  expectEqual(sourceOf(production, "default-src").join(" "), "'self'", "the fallback for every unlisted directive is this origin");

  for (const [name, expected] of [
    ["form-action", "'self'"],
    ["base-uri", "'none'"],
    ["object-src", "'none'"],
    ["frame-src", "'none'"],
    ["worker-src", "'none'"],
    ["media-src", "'none'"],
    ["frame-ancestors", "'none'"],
  ] as const) {
    expectEqual(sourceOf(production, name).join(" "), expected, `${name} is ${expected}`);
  }

  expectEqual(
    production.filter((directive) => directive.values.length === 0).map((directive) => directive.name).join(","),
    "upgrade-insecure-requests",
    "a directive without a source list is only the one that takes none",
  );

  const serialised = buildContentSecurityPolicy({ nonce, development: false });

  expectEqual(serialised, buildContentSecurityPolicy({ nonce, development: false }), "one input, one header, every time");
  expectEqual(serialised.includes("\n"), false, "the header is one line");
  expectEqual(serialised.split(`'nonce-${nonce}'`).length - 1, 1, "the nonce appears once");
  expect(serialised.endsWith("default-src 'self'"), "and the policy ends with its fallback");
  expectEqual(serialised.split(";").length, production.length, "one semicolon per directive, no empty ones");
  expectEqual(buildContentSecurityPolicy({ nonce: createCspNonce(), development: false }) === serialised, false, "a new nonce is a new policy");

  for (const bad of ["", "short", `${"a".repeat(21)}=`, `${"a".repeat(23)}`, "has a space in it here"]) {
    expectRejects(
      () => buildCspDirectives({ nonce: bad, development: false }),
      `a policy is not built for ${JSON.stringify(bad)} as a nonce`,
    );
  }
}

/** The tree: one writer of the header, one reader of the nonce, and the manifest agrees. */
async function checkCspWiring(): Promise<void> {
  const root = new URL("../../", import.meta.url);
  const cspSource = await readFile(new URL("./csp.ts", import.meta.url), "utf8");
  const proxySource = await readFile(new URL("proxy.ts", root), "utf8");
  const layoutSource = await readFile(new URL("app/layout.tsx", root), "utf8");

  expectEqual(cspSource.includes("import "), false, "the policy module imports nothing, so every runtime can load it");
  expectEqual(cspSource.includes('from "node:'), false, "including no Node builtin");
  expect(cspSource.includes("crypto.getRandomValues"), "the nonce comes from the platform's random source");

  expect(proxySource.startsWith("// path: proxy.ts"), "the proxy is the file the framework looks for");
  expect(proxySource.includes("export function proxy("), "and exports the function Next 16 expects");
  expect(proxySource.includes("requestHeaders.set(CSP_HEADER_NAME"), "the policy is set on the request, which is what the framework reads");
  expect(proxySource.includes("response.headers.set(CSP_HEADER_NAME"), "and on the response, which is what the browser enforces");
  expect(proxySource.includes("CSP_NONCE_HEADER_NAME, nonce"), "the nonce travels to the layout in its own header");
  expect(proxySource.includes("isFrameworkAssetPath(request.nextUrl.pathname)"), "the proxy asks whether the request is build output");
  expect(proxySource.includes("if (!asset)"), "and only a rendered response is given a policy");
  expect(
    FRAMEWORK_ASSET_PREFIXES.includes("/_next/static/") && FRAMEWORK_ASSET_PREFIXES.includes("/_next/image"),
    "because build output is a file, not a document",
  );
  expectEqual(isFrameworkAssetPath("/_next/static/chunks/app.js"), true, "a chunk is an asset");
  expectEqual(
    isFrameworkAssetPath("/missing.css"),
    false,
    "a path that is not build output is a document even when it looks like a file, because a missing one renders the 404 page",
  );
  expectEqual(isFrameworkAssetPath("/favicon.ico"), false, "and a public file is treated as one too");
  expectEqual(isFrameworkAssetPath("/_next/image?url=x"), true, "an optimized image is one");
  expectEqual(isFrameworkAssetPath("/signin"), false, "a page is not");
  expectEqual(isFrameworkAssetPath("/api/auth/signin"), false, "and neither is a route handler");
  expect(proxySource.includes("getServerConfig()"), "the development decision is read through the validated configuration");
  expectEqual(proxySource.includes("process.env"), false, "and never from a raw environment read");

  expect(layoutSource.includes('export const dynamic = "force-dynamic"'), "the layout is rendered per request, because a nonce is per response");
  expect(layoutSource.includes("(await headers()).get(CSP_NONCE_HEADER_NAME)"), "the layout reads the nonce the proxy minted");
  expect(layoutSource.includes("!isCspNonce(nonce)"), "and validates the value instead of trusting the header");
  expect(layoutSource.includes('throw new Error("the Content Security Policy nonce is missing'), "so a page whose script would be blocked is never rendered");
  expectEqual(layoutSource.split("<script").length - 1, 1, "the document has one hand written script tag");
  expect(layoutSource.includes("<script nonce={nonce}"), "and that tag carries the nonce");
  expect(layoutSource.includes("dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}"), "with the theme constant as its only content");

  const manifest = JSON.parse(await readFile(new URL("config/structure.json", root), "utf8")) as {
    readonly rootFiles: readonly string[];
  };

  expectEqual(manifest.rootFiles.includes("proxy.ts"), true, "the structure manifest lists the proxy as a root file");

  const scanned: string[] = [];

  for (const entry of ["app", "components", "lib", "scripts"]) {
    const entries = (await readdir(new URL(`${entry}/`, root), { recursive: true }))
      .map((name) => name.replaceAll("\\", "/"))
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));

    for (const name of entries) {
      if (name.endsWith("verify.ts")) {
        continue;
      }

      const source = await readFile(new URL(`${entry}/${name}`, root), "utf8");

      if (source.includes('"content-security-policy"')) {
        scanned.push(`${entry}/${name}`);
      }
    }
  }

  expectEqual(
    scanned.join(","),
    "lib/security/csp.ts",
    "no module writes the header by hand, and the constant lives in one file",
  );
}

/* ------------------------------------------------------------------ 8. the headers */

/**
 * The security headers of STEP 060.
 *
 * A header list is the easiest thing in a repository to weaken, because every weakening still renders
 * a page. So this half is written negatively where it can be: no value may carry a control character,
 * a wildcard or a non-ASCII byte; `strict-transport-security` may never be sent by a development
 * server; `x-frame-options` may not be sent where the preview embeds the platform; and no module
 * outside `lib/security/headers.ts` may name `strict-transport-security` at all. What is left is a
 * table a reader can check against the reasons in the file's header comment.
 */
function checkSecurityHeaders(): void {
  expect(Object.isFrozen(SECURITY_HEADERS), "the table is frozen, so a caller cannot edit a header at runtime");

  const names = SECURITY_HEADER_NAMES;

  expectEqual(new Set(names).size, names.length, "no header is listed twice");
  expectEqual(names.length, SECURITY_HEADERS.length, "the name list and the table agree");

  for (const header of SECURITY_HEADERS) {
    expect(/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(header.name), `${header.name} is a lower case header name`);
    expect(header.value.length > 0, `${header.name} has a value`);
    expect(header.value.length <= 512, `${header.name} has a value short enough to be a header`);
    expect(/^[\u0020-\u007e]+$/u.test(header.value), `${header.name} is printable ASCII, so no control character can split it`);
    expect(header.value.includes("\r") === false && header.value.includes("\n") === false, `${header.name} cannot split a response`);
    expect(header.value.includes("*") === false, `${header.name} is not a wildcard`);
    expect(header.scopes.length > 0, `${header.name} belongs on at least one kind of response`);
    expect(
      header.scopes.every((scope) => scope === "document" || scope === "asset"),
      `${header.name} has only scopes this module knows`,
    );
  }

  const document = headersFor({ development: false, scope: "document" });
  const documentValues = new Map(document.map((header) => [header.name, header.value]));
  const documentNames = document.map((header) => header.name);

  expectEqual(
    documentNames.join(","),
    [
      "x-content-type-options",
      "referrer-policy",
      "permissions-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "x-dns-prefetch-control",
      "x-permitted-cross-domain-policies",
      "strict-transport-security",
      "x-frame-options",
    ].join(","),
    "a production document carries exactly these headers, in this order",
  );

  const development = headersFor({ development: true, scope: "document" });

  expectEqual(
    development.map((header) => header.name).includes("strict-transport-security"),
    false,
    "a development server never sends hsts, because it speaks plain http",
  );
  expectEqual(
    development.map((header) => header.name).includes("x-frame-options"),
    false,
    "and never refuses to be framed, because the preview embeds it",
  );
  expectEqual(document.length - development.length, 2, "which is the whole difference between the two environments");
  expectEqual(
    development.every((header) => documentValues.get(header.name) === header.value),
    true,
    "and every other header is sent byte for byte in both",
  );

  expectEqual(documentValues.get("x-content-type-options"), "nosniff", "a document may not be sniffed into another type");
  expectEqual(documentValues.get("referrer-policy"), "no-referrer", "and never refers another origin to a tokenised URL");
  expectEqual(documentValues.get("cross-origin-opener-policy"), "same-origin", "and is isolated from a cross-origin opener");
  expectEqual(documentValues.get("cross-origin-resource-policy"), "same-origin", "and may not be embedded elsewhere");
  expectEqual(documentValues.get("x-dns-prefetch-control"), "off", "and does not resolve a host before a click");
  expectEqual(documentValues.get("x-permitted-cross-domain-policies"), "none", "and serves no cross domain policy file");
  expectEqual(documentValues.get("x-frame-options"), "DENY", "and is framed by nobody in production");
  expectEqual(
    documentValues.get("strict-transport-security"),
    "max-age=63072000; includeSubDomains",
    "hsts lasts two years and covers subdomains",
  );
  expectEqual(
    documentValues.get("strict-transport-security")?.includes("preload") ?? true,
    false,
    "but is not preloaded, which is a deployment decision rather than a header",
  );

  const permissions = documentValues.get("permissions-policy") ?? "";

  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "display-capture", "serial", "hid"]) {
    expect(permissions.includes(`${feature}=()`), `the browser feature ${feature} is denied to every origin`);
  }

  expectEqual(permissions.includes("*"), false, "no browser feature is granted to every origin");
  expectEqual(permissions.endsWith(","), false, "and the list does not end in a separator");

  const assetProduction = headersFor({ development: false, scope: "asset" });
  const assetDevelopment = headersFor({ development: true, scope: "asset" });

  expectEqual(
    assetProduction.map((header) => header.name).join(","),
    "x-content-type-options,cross-origin-resource-policy",
    "a static file carries the two headers that mean something for a file",
  );
  expectEqual(
    toComparable(assetDevelopment),
    toComparable(assetProduction),
    "and the environment cannot change them, which is why the proxy does not read the configuration for one",
  );
  expectEqual(assetProduction.length < document.length, true, "an asset deliberately carries a shorter set");
  expect(
    assetProduction.every((header) => documentValues.get(header.name) === header.value),
    "and every asset header is the same value the document sends",
  );

  expectEqual(
    toComparable(headersFor({ development: false, scope: "document" })),
    toComparable(document),
    "one scope and one environment, one answer, every time",
  );
  expect(Object.isFrozen(assetProduction), "the answer is frozen, because a caller must not edit a response's headers");

  expectEqual(isSecurityHeaderName("x-content-type-options"), true, "a header this table writes is recognised");
  expectEqual(isSecurityHeaderName("X-Frame-Options"), true, "in any case");
  expectEqual(isSecurityHeaderName("content-security-policy"), false, "and the policy is not one of them, because it is built per response");
  expectEqual(isSecurityHeaderName(""), false, "an empty name is not a header");
}

function toComparable(headers: readonly ResolvedHeader[]): string {
  return headers.map((header) => `${header.name}=${header.value}`).join("|");
}

/** The tree: one writer, no duplicate table, and the framework config does not carry a second copy. */
async function checkSecurityHeaderWiring(): Promise<void> {
  const root = new URL("../../", import.meta.url);
  const headersSource = await readFile(new URL("./headers.ts", import.meta.url), "utf8");
  const proxySource = await readFile(new URL("proxy.ts", root), "utf8");
  const configSource = await readFile(new URL("next.config.mjs", root), "utf8");

  expectEqual(headersSource.includes("import "), false, "the header table imports nothing, so any runtime can load it");
  expectEqual(headersSource.includes("process.env"), false, "and reads no environment of its own");

  expect(proxySource.includes("headersFor({ development, scope: asset ? \"asset\" : \"document\" })"), "the proxy resolves the scope of the response");
  expect(proxySource.includes("response.headers.set(header.name, header.value)"), "and writes every header the table answers");
  expect(proxySource.includes('matcher: ["/((?!_next/webpack-hmr).*)"]'), "it runs for every response, including a static file");
  expect(
    proxySource.includes("const development = asset ? false : getServerConfig().isDevelopment"),
    "and reads the configuration only where the environment can change an answer",
  );

  expectEqual(configSource.includes("headers"), false, "next.config.mjs carries no second header table");
  expect(configSource.includes("poweredByHeader: false"), "and still hides the framework's version");

  const scanned: string[] = [];

  for (const entry of ["app", "components", "lib", "scripts"]) {
    const entries = (await readdir(new URL(`${entry}/`, root), { recursive: true }))
      .map((name) => name.replaceAll("\\", "/"))
      .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"));

    for (const name of entries) {
      if (name.endsWith("verify.ts")) {
        continue;
      }

      const source = await readFile(new URL(`${entry}/${name}`, root), "utf8");

      if (source.includes("strict-transport-security")) {
        scanned.push(`${entry}/${name}`);
      }
    }
  }

  expectEqual(scanned.join(","), "lib/security/headers.ts", "no module writes a security header by hand");
}

/* ------------------------------------------------------------------ 9. the upload validator */

/** A minimal file of each accepted type, built from its signature so the corpus needs no fixture. */
function uploadSamples(): Readonly<Record<string, Uint8Array>> {
  const text = new TextEncoder();

  return {
    "application/pdf": new Uint8Array([...text.encode("%PDF-1.7\n"), 0x25, 0x25, 0x45, 0x4f, 0x46]),
    "image/jpeg": new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
    "image/png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
    "image/webp": new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
  };
}

/**
 * The upload validator of STEP 061.
 *
 * Two halves, and the second one is the one that cannot be faked: the signature corpus proves what a
 * type is, and the *disagreement* corpus proves what happens when the client's claim and the bytes are
 * different facts - which is the entire attack this validator exists for. The last section reads
 * `migrations/0057_files.sql` and asserts that the limits and purpose names here are the ones the
 * database already enforces, because a validator that is stricter than its row is a surprise and one
 * that is looser is a failed insert in production.
 */
function checkUploadValidator(): void {
  const samples = uploadSamples();

  expectEqual(UPLOAD_PURPOSES.length, 5, "the platform accepts five upload purposes");
  expectEqual(new Set(UPLOAD_PURPOSES).size, UPLOAD_PURPOSES.length, "and no purpose is listed twice");
  expectEqual(UPLOAD_PURPOSES.join(","), Object.keys(UPLOAD_POLICIES).join(","), "every purpose has a policy and no policy has no purpose");
  expect(Object.isFrozen(UPLOAD_POLICIES), "the policy table is frozen");

  for (const purpose of UPLOAD_PURPOSES) {
    const policy = UPLOAD_POLICIES[purpose];

    expectEqual(policy.purpose, purpose, `${purpose} names itself`);
    expect(policy.allowedTypes.length > 0, `${purpose} accepts at least one type`);
    expect(
      policy.allowedTypes.every((type) => /^[a-z]+\/[A-Za-z0-9.+-]+$/u.test(type)),
      `${purpose} accepts types the files_content_type_check of 0057 would accept`,
    );
    expect(
      policy.allowedTypes.every((type) => detectContentType(samples[type] ?? new Uint8Array()) === type),
      `${purpose} accepts only types this module can prove from the bytes`,
    );
    expectEqual(
      policy.allowedTypes.includes("image/svg+xml"),
      false,
      `${purpose} refuses an SVG, which is a document that can carry script`,
    );
    expect(policy.maximumBytes > 0, `${purpose} has a size limit`);
    expect(
      policy.maximumBytes <= UPLOAD_DATABASE_MAXIMUM_BYTES,
      `${purpose} never exceeds the 0057 row check`,
    );
    expect(Object.isFrozen(policy.allowedTypes), `${purpose} cannot have a type added at runtime`);
  }

  expectEqual(UPLOAD_POLICIES.kyc_document.maximumBytes, UPLOAD_DATABASE_MAXIMUM_BYTES, "a KYC scan may be as large as the row allows");
  expect(
    UPLOAD_POLICIES.company_logo.maximumBytes < UPLOAD_POLICIES.kyc_document.maximumBytes,
    "and a logo is smaller than a scan, because it is an icon rather than a document",
  );
  expect(
    UPLOAD_POLICIES.invoice_pdf.allowedTypes.join(",") === "application/pdf",
    "the invoice purpose accepts a PDF and nothing else, because the platform writes it",
  );

  // ---- the signatures
  for (const [type, sample] of Object.entries(samples)) {
    expectEqual(detectContentType(sample), type, `${type} is recognised from its own signature`);
    expectEqual(detectContentType(sniffHead(sample)), type, `and from the first ${UPLOAD_SNIFF_BYTES} bytes, which is all a route reads`);
  }

  expectEqual(detectContentType(new TextEncoder().encode("%PDF1.7")), null, "a bare %PDF is not a PDF header");
  expectEqual(detectContentType(new Uint8Array([0x25, 0x50, 0x44])), null, "a truncated signature proves nothing");
  expectEqual(detectContentType(new Uint8Array([0x00, 0xff, 0xd8, 0xff])), null, "a signature at the wrong offset is not a signature");
  expectEqual(
    detectContentType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20])),
    null,
    "a RIFF container that is not WebP is refused",
  );
  expectEqual(detectContentType(new Uint8Array()), null, "no bytes, no type");
  expectEqual(detectContentType(new TextEncoder().encode("<html><body>hi")), null, "markup is not a file type this platform accepts");

  // ---- the decisions
  const png = samples["image/png"] ?? new Uint8Array();
  const pdf = samples["application/pdf"] ?? new Uint8Array();
  const html = new TextEncoder().encode("<script>alert(1)</script>");

  const verified = validateUpload(
    { fileName: "scan.png", declaredType: "image/png", byteSize: png.length, head: png },
    "kyc_document",
  );

  expect(verified.ok && verified.verdict.decision === "verified", "a PNG declared as a PNG is verified");
  expectEqual(verified.ok && verified.verdict.quarantineReason, null, "and carries no quarantine reason");
  expectEqual(verified.ok && verified.verdict.contentType, "image/png", "and records the type the bytes proved");

  const declaredLoud = validateUpload(
    { fileName: "SCAN.PNG", declaredType: "  IMAGE/PNG  ", byteSize: png.length, head: png },
    "kyc_document",
  );

  expect(declaredLoud.ok && declaredLoud.verdict.decision === "verified", "a declared type is compared in one case");
  expectEqual(declaredLoud.ok && declaredLoud.verdict.fileName, "SCAN.PNG", "and a name keeps its case, because it is display only");

  const traversal = validateUpload(
    { fileName: "../../etc/passwd.png", declaredType: "image/png", byteSize: png.length, head: png },
    "company_logo",
  );

  expectEqual(traversal.ok && traversal.verdict.fileName.includes("/"), false, "a traversal in a name cannot survive the sanitiser");
  expectEqual(traversal.ok && traversal.verdict.fileName.includes(".."), false, "and neither may a parent segment");

  const mismatch = validateUpload(
    { fileName: "statement.png", declaredType: "application/pdf", byteSize: png.length, head: png },
    "kyc_document",
  );

  expect(mismatch.ok && mismatch.verdict.decision === "quarantined", "a PNG declared as a PDF is quarantined");
  expectEqual(
    mismatch.ok && mismatch.verdict.quarantineReason,
    UPLOAD_QUARANTINE_REASONS.typeMismatch,
    "because the claim and the bytes disagree",
  );
  expectEqual(mismatch.ok && mismatch.verdict.contentType, "image/png", "and the record keeps what the bytes are, not what was claimed");

  const active = validateUpload(
    { fileName: "invoice.pdf", declaredType: "application/pdf", byteSize: html.length, head: html },
    "invoice_pdf",
  );

  expect(active.ok && active.verdict.decision === "quarantined", "markup in place of a document is quarantined");
  expectEqual(
    active.ok && active.verdict.quarantineReason,
    UPLOAD_QUARANTINE_REASONS.activeContent,
    "with the reason that names what it is",
  );

  const unknown = validateUpload(
    { fileName: "note.pdf", declaredType: "application/pdf", byteSize: 12, head: new Uint8Array([0x1f, 0x8b, 0x08, 0x00]) },
    "invoice_pdf",
  );

  expect(unknown.ok && unknown.verdict.decision === "quarantined", "an unrecognised signature is quarantined rather than refused");
  expectEqual(
    unknown.ok && unknown.verdict.quarantineReason,
    UPLOAD_QUARANTINE_REASONS.unknownSignature,
    "with the reason a person reads in the file record",
  );

  const refused: readonly (readonly [string, UploadCandidateLike, UploadPurpose, UploadRejectionReason])[] = [
    ["an empty declared type", { fileName: "a.png", declaredType: "   ", byteSize: 10, head: png }, "company_logo", "type_missing"],
    ["an empty file", { fileName: "a.png", declaredType: "image/png", byteSize: 0, head: png }, "company_logo", "empty_file"],
    ["a file one byte over the logo limit", { fileName: "a.png", declaredType: "image/png", byteSize: UPLOAD_POLICIES.company_logo.maximumBytes + 1, head: png }, "company_logo", "too_large"],
    ["an SVG", { fileName: "logo.svg", declaredType: "image/svg+xml", byteSize: 200, head: png }, "company_logo", "type_not_allowed"],
    ["a PNG where only a PDF is allowed", { fileName: "i.png", declaredType: "image/png", byteSize: png.length, head: png }, "invoice_pdf", "type_not_allowed"],
    ["a zip archive", { fileName: "a.zip", declaredType: "application/zip", byteSize: 10, head: png }, "support_attachment", "type_not_allowed"],
    ["an HTML file", { fileName: "a.html", declaredType: "text/html", byteSize: html.length, head: html }, "support_attachment", "type_not_allowed"],
  ];

  for (const [label, candidate, purpose, reason] of refused) {
    const decision = validateUpload(candidate, purpose);

    expectEqual(decision.ok, false, `${label} is refused rather than quarantined`);

    if (!decision.ok) {
      expectEqual(decision.reason, reason, `and answers ${reason}`);
    }
  }

  const atTheLimit = validateUpload(
    { fileName: "logo.png", declaredType: "image/png", byteSize: UPLOAD_POLICIES.company_logo.maximumBytes, head: png },
    "company_logo",
  );

  expect(atTheLimit.ok && atTheLimit.verdict.decision === "verified", "a file exactly at the limit is accepted");
  expectEqual(atTheLimit.ok && atTheLimit.verdict.byteSize, UPLOAD_POLICIES.company_logo.maximumBytes, "and its size is recorded as counted");

  const longHead = validateUpload(
    { fileName: "scan.png", declaredType: "image/png", byteSize: 4_096, head: new Uint8Array([...png, ...new Uint8Array(2_048)]) },
    "kyc_document",
  );

  expect(longHead.ok && longHead.verdict.decision === "verified", "a signature at the start is enough however long the file is");
  expectEqual(longHead.ok && longHead.verdict.byteSize, 4_096, "and the counted size is what the record keeps");

  // ---- the hash the record stores
  const digest = sha256Hex(new TextEncoder().encode("abc"));

  expectEqual(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "the hash is the SHA-256 of the plaintext");
  expect(/^[0-9a-f]{64}$/u.test(digest), "in the lower case hex files_hash_check accepts");
  expectEqual(sha256Hex(pdf), sha256Hex(pdf), "and it is deterministic");
  expect(sha256Hex(pdf) !== sha256Hex(png), "two files do not share a digest");

  // ---- the reasons, as the database will store them
  for (const [name, reason] of Object.entries(UPLOAD_QUARANTINE_REASONS)) {
    expect(reason.length > 0 && reason.length <= UPLOAD_MAXIMUM_REASON_LENGTH, `${name} fits files_quarantine_reason_check`);
    expectEqual(reason, reason.trim(), `${name} is trimmed, because the row check demands it`);
  }

  expect(Object.isFrozen(UPLOAD_QUARANTINE_REASONS), "the reason list is frozen");

  // ---- the refusal factory and the throwing wrapper
  const factory = uploadRejection("too_large");

  expectEqual(factory.code, "VALIDATION_FAILED", "the refusal factory answers the validation code");
  expectEqual(
    (factory.cause as { reason?: string } | undefined)?.reason,
    "too_large",
    "and keeps the broken limit as evidence for the log",
  );

  const refusal = expectThrows(
    () => requireValidUpload({ fileName: "a.svg", declaredType: "image/svg+xml", byteSize: 10, head: png }, "company_logo"),
    "a route that calls the wrapper gets an application error",
  );

  expectEqual(refusal?.code, "VALIDATION_FAILED", "with the validation code");
  expectEqual(refusal?.details[0]?.field, UPLOAD_FIELD, "naming the file field");
  expectEqual(refusal?.details[0]?.rule, UPLOAD_RULE, "and the one upload rule");
  expectEqual(
    (refusal?.cause as { reason?: string } | undefined)?.reason,
    "type_not_allowed",
    "with the reason kept for the log and never serialised into the response",
  );

  const accepted = requireValidUpload(
    { fileName: "scan.pdf", declaredType: "application/pdf", byteSize: pdf.length, head: pdf },
    "kyc_document",
  );

  expectEqual(accepted.decision, "verified", "and an accepted upload comes back as a verdict the route can store");
}

interface UploadCandidateLike {
  readonly fileName: string;
  readonly declaredType: string;
  readonly byteSize: number;
  readonly head: Uint8Array;
}

/** The tree, and the migration this module has to agree with. */
async function checkUploadWiring(): Promise<void> {
  const uploadSource = await readFile(new URL("./upload.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../migrations/0057_files.sql", import.meta.url), "utf8");

  expect(uploadSource.includes('from "node:crypto"'), "the digest comes from the platform's hash");
  expect(uploadSource.includes('from "./text.ts"'), "the file name is cleaned by the sanitiser of STEP 056 rather than a second rule");
  expectEqual(uploadSource.includes("node:fs"), false, "the validator never touches a path: it is given bytes");
  expectEqual(uploadSource.includes("fetch("), false, "and it makes no request");

  for (const purpose of UPLOAD_PURPOSES) {
    expect(migration.includes(`'${purpose}'`), `migration 0057 knows the purpose ${purpose}`);
  }

  expect(migration.includes("byte_size between 1 and 52428800"), "0057 states the row size check this module mirrors");
  expectEqual(UPLOAD_DATABASE_MAXIMUM_BYTES, 52_428_800, "and the constant is the same number");
  expect(migration.includes("content_type ~ '^[a-z]+/[A-Za-z0-9.+-]+$'"), "0057 states the content type shape");
  expect(migration.includes("char_length(quarantined_reason) between 1 and 280"), "and the reason length");
  expectEqual(UPLOAD_MAXIMUM_REASON_LENGTH, 280, "which is the constant here");
  expect(migration.includes("magic_byte_verified"), "the verdict this module produces is a column the row already has");
}

/** ---- Rate limiting: three buckets, one counter, one decision. */

interface RecordedCounterCall {
  readonly functionName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface FakeCounterOptions {
  /** A scope that refuses with the given delay, whatever the counter holds. */
  readonly refuse?: (scope: string) => number | null;
  /** A scope whose allowed answer carries this remaining count. */
  readonly remaining?: (scope: string) => number | null;
}

interface FakeCounter {
  readonly client: RateLimitCounterClient;
  readonly calls: RecordedCounterCall[];
}

/**
 * A counter that behaves like `public.consume_rate_limit` in memory: one fixed window per
 * `(scope, key)`, rewritten when the window lapses, refusing only once the limit is reached.
 *
 * The gate drives the real module against it, so the limit boundary is exercised as the database
 * implements it rather than asserted from a constant.
 */
function createFakeCounter(options: FakeCounterOptions = {}): FakeCounter {
  const rows = new Map<string, { start: number; hits: number; refused: boolean }>();
  const calls: RecordedCounterCall[] = [];
  const client: RateLimitCounterClient = {
    rpc(functionName, arguments_) {
      calls.push({ functionName, arguments: arguments_ });

      const scope = String(arguments_["p_scope"]);
      const keyHash = String(arguments_["p_key_hash"]);
      const limit = Number(arguments_["p_limit"]);
      const windowSeconds = Number(arguments_["p_window_seconds"]);
      const nowSeconds = Math.floor(Date.parse(String(arguments_["p_now"])) / 1_000);
      const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
      const retryAfter = Math.max(1, windowStart + windowSeconds - nowSeconds);
      const refused = options.refuse?.(scope) ?? null;

      if (refused !== null) {
        return Promise.resolve([
          { allowed: false, remaining: 0, retry_after_seconds: refused, first_refusal: true },
        ]);
      }

      const remaining = options.remaining?.(scope) ?? null;

      if (remaining !== null) {
        return Promise.resolve([
          { allowed: true, remaining, retry_after_seconds: 0, first_refusal: false },
        ]);
      }

      const id = `${scope}|${keyHash}`;
      const row = rows.get(id);

      if (row === undefined || row.start < windowStart) {
        rows.set(id, { start: windowStart, hits: 1, refused: false });

        return Promise.resolve([
          { allowed: true, remaining: Math.max(0, limit - 1), retry_after_seconds: 0, first_refusal: false },
        ]);
      }

      if (row.hits < limit) {
        row.hits += 1;

        return Promise.resolve([
          { allowed: true, remaining: Math.max(0, limit - row.hits), retry_after_seconds: 0, first_refusal: false },
        ]);
      }

      const first = !row.refused;

      row.refused = true;

      return Promise.resolve([
        { allowed: false, remaining: 0, retry_after_seconds: retryAfter, first_refusal: first },
      ]);
    },
  };

  return { client, calls };
}

async function expectThrowsAsync(
  action: () => Promise<unknown>,
  description: string,
): Promise<AppError | null> {
  checks += 1;

  try {
    await action();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }

    failures.push(`${description} (the rejection must be an AppError)`);

    return null;
  }

  failures.push(`${description} (nothing was rejected)`);

  return null;
}

const rateLimitTestUser = "018f2b8a-1111-4c2d-9c3e-0123456789ab";
const rateLimitSecondUser = "018f2b8a-2222-4c2d-9c3e-0123456789ab";
const rateLimitFixedNow = Date.parse("2026-11-01T10:00:30.000Z");
const rateLimitAddress = "203.0.113.9";

function rateLimitDependencies(
  counter: FakeCounter,
  audit?: RateLimitAuditTrail,
): RateLimitDependencies {
  return {
    rest: counter.client,
    ...(audit === undefined ? {} : { audit }),
    now: () => rateLimitFixedNow,
  };
}

function checkRateLimitTable(): void {
  expectEqual(RATE_LIMIT_CLASSES.length, 6, "the platform counts six classes of endpoint");
  expectEqual(new Set(RATE_LIMIT_CLASSES).size, RATE_LIMIT_CLASSES.length, "and no class is listed twice");
  expectEqual(
    RATE_LIMIT_CLASSES.join(","),
    Object.keys(RATE_LIMIT_CLASS_POLICIES).join(","),
    "every class has a policy and no policy has no class",
  );
  expect(Object.isFrozen(RATE_LIMIT_CLASS_POLICIES), "the policy table is frozen");
  expectEqual(RATE_LIMIT_BUCKET_DIMENSIONS.join(","), "ip,user,route", "a request is counted in three buckets");

  for (const limitClass of RATE_LIMIT_CLASSES) {
    const policy = RATE_LIMIT_CLASS_POLICIES[limitClass];

    expect(RATE_LIMIT_SCOPE_PATTERN.test(limitClass), `${limitClass} is a name the counter table can store`);
    expect(Object.isFrozen(policy), `the ${limitClass} policy cannot be edited at runtime`);
    expect(Object.isFrozen(policy.ip), `and neither can its ip bucket`);
    expect(Object.isFrozen(policy.route), `nor its route bucket`);

    if (policy.user === null) {
      continue;
    }

    expect(Object.isFrozen(policy.user), `the ${limitClass} user bucket cannot be edited either`);
  }

  for (const limitClass of RATE_LIMIT_CLASSES) {
    const policy = RATE_LIMIT_CLASS_POLICIES[limitClass];

    for (const bucket of [policy.ip, policy.route, policy.user]) {
      if (bucket === null) {
        continue;
      }

      expect(Number.isInteger(bucket.limit) && bucket.limit >= 1, `${limitClass} has a positive integer limit`);
      expect(bucket.limit <= 100_000, `${limitClass} does not allow an unbounded burst`);
      expect(
        Number.isInteger(bucket.windowSeconds) &&
          bucket.windowSeconds >= RATE_LIMIT_MINIMUM_WINDOW_SECONDS &&
          bucket.windowSeconds <= RATE_LIMIT_MAXIMUM_WINDOW_SECONDS,
        `${limitClass} uses a window the rate_limit_windows check accepts`,
      );
    }

    expect(policy.route.limit < policy.ip.limit, `${limitClass} limits one route more tightly than the whole class`);
  }

  expect(
    RATE_LIMIT_CLASS_POLICIES.office_write.route.limit < RATE_LIMIT_CLASS_POLICIES.office_read.route.limit,
    "a write is rarer than a read, so its route limit is lower",
  );
  expect(
    RATE_LIMIT_CLASS_POLICIES.office_write.ip.limit < RATE_LIMIT_CLASS_POLICIES.office_read.ip.limit,
    "and its address limit is lower too",
  );
  expectEqual(
    RATE_LIMIT_CLASS_POLICIES.webhook.user,
    null,
    "a provider webhook arrives before an account is known, so it has no user bucket",
  );
  expect(
    RATE_LIMIT_CLASSES.filter((limitClass) => RATE_LIMIT_CLASS_POLICIES[limitClass].user !== null).length === 5,
    "every other class counts the account as well as the address",
  );
  expect(
    RATE_LIMIT_CLASS_POLICIES.webhook.ip.limit > RATE_LIMIT_CLASS_POLICIES.authenticated.ip.limit,
    "a provider sends bursts, so the webhook address limit is the loosest",
  );
  expect(
    RATE_LIMIT_CLASSES.every(
      (limitClass) => RATE_LIMIT_CLASS_POLICIES[limitClass].route.limit >= RATE_LIMIT_CLASS_POLICIES.export.route.limit,
    ),
    "an export is the tightest route in the platform",
  );
  expectEqual(RATE_LIMIT_CLASS_POLICIES.export.route.windowSeconds, 300, "and it counts five minutes at a time");

  // The scope of every bucket is a name `rate_limit_windows_scope_check` accepts, and it is unique.
  const scopes: string[] = [];

  for (const dimension of RATE_LIMIT_BUCKET_DIMENSIONS) {
    for (const limitClass of RATE_LIMIT_CLASSES) {
      const scope = rateLimitScopeFor(dimension, limitClass);

      expect(RATE_LIMIT_SCOPE_PATTERN.test(scope), `${scope} matches the scope check of 0092`);
      expect(scope.length <= RATE_LIMIT_MAXIMUM_SCOPE_LENGTH, `${scope} fits the column`);
      expect(scope.startsWith(`${dimension}_`), `${scope} names its own bucket`);
      expect(scope.length <= RATE_LIMIT_MAXIMUM_SCOPE_LENGTH, `${scope} is inside the longest scope the table stores`);
      scopes.push(scope);
    }
  }

  expectEqual(scopes.length, 18, "three buckets on six classes are eighteen counters");
  expectEqual(new Set(scopes).size, scopes.length, "and no two buckets share a scope");
  expect(
    RATE_LIMIT_EXEMPT_ROUTES.length === 2 &&
      RATE_LIMIT_EXEMPT_ROUTES.every((route) => route.startsWith("/api/") && route.endsWith("health")),
    "the only routes never counted are the two liveness probes",
  );
  expectEqual(new Set(RATE_LIMIT_EXEMPT_ROUTES).size, RATE_LIMIT_EXEMPT_ROUTES.length, "and neither is listed twice");
}

function checkRateLimitAddresses(): void {
  expectEqual(canonicalRateLimitAddress("1.2.3.4"), "1.2.3.4", "an address has one spelling");
  expectEqual(canonicalRateLimitAddress(" 1.2.3.4 "), "1.2.3.4", "surrounding space is not part of it");
  expectEqual(
    canonicalRateLimitAddress("2001:DB8::1"),
    canonicalRateLimitAddress("2001:0db8:0000:0000:0000:0000:0000:0001"),
    "two spellings of one IPv6 address are one spelling here",
  );
  expectEqual(canonicalRateLimitAddress("2001:DB8::1"), "2001:db8::1", "the spelling is lower case and compressed");
  expectEqual(canonicalRateLimitAddress("::ffff:1.2.3.4"), "::ffff:102:304", "the IPv4 mapped form is canonicalised too");
  expectEqual(canonicalRateLimitAddress(""), null, "an empty value is not an address");
  expectEqual(canonicalRateLimitAddress("not-an-address"), null, "a host name is not an address");
  expectEqual(canonicalRateLimitAddress("1.2.3.4:8080"), null, "an address with a port is not an address");
  expectEqual(canonicalRateLimitAddress("fe80::1%eth0"), null, "nor is an address with a zone index");
  expectEqual(canonicalRateLimitAddress("1.2.3.4, 5.6.7.8"), null, "nor is a forwarding header");
  expectEqual(canonicalRateLimitAddress("01.2.3.4"), null, "nor is a padded octet, which net.isIP refuses");
}

function checkRateLimitRoutes(): void {
  expectEqual(normalizeRateLimitRoute("/api/office/sessions/"), "/api/office/sessions", "a trailing slash is not part of a route");
  expectEqual(normalizeRateLimitRoute("//api//office//"), "/api/office", "and neither is a doubled slash");
  expectEqual(normalizeRateLimitRoute("/api/public/pay?amount=1#top"), "/api/public/pay", "a query string and a fragment are not either");
  expectEqual(normalizeRateLimitRoute(""), "/", "an empty route is the root");
  expectEqual(normalizeRateLimitRoute("api/public/pay"), "/api/public/pay", "a route without its leading slash is repaired");
  expectEqual(normalizeRateLimitRoute("/"), "/", "and the root stays the root");

  expectEqual(rateLimitClassForRoute("/api/public/payments", "POST"), "public_api", "the merchant public API is its own class");
  expectEqual(rateLimitClassForRoute("/api/public", "GET"), "public_api", "and so is its root");
  expectEqual(rateLimitClassForRoute("/api/publicity", "GET"), "authenticated", "a path that merely starts the same way is not it");
  expectEqual(rateLimitClassForRoute("/api/webhooks/stripe", "POST"), "webhook", "a provider webhook is its own class");
  expectEqual(rateLimitClassForRoute("/api/webhooksomething", "POST"), "authenticated", "and a look alike is not");
  expectEqual(rateLimitClassForRoute("/api/office/sessions", "GET"), "office_read", "a GET under the office is a read");
  expectEqual(rateLimitClassForRoute("/api/office/sessions", "POST"), "office_write", "and a POST is a write");
  expectEqual(rateLimitClassForRoute("/api/office/sessions", "patch"), "office_write", "whatever case the method arrives in");
  expectEqual(rateLimitClassForRoute("/api/office/sessions", "HEAD"), "office_read", "a HEAD only reads");
  expectEqual(rateLimitClassForRoute("/api/office/reports/export", "GET"), "export", "an export under the office is still an export");
  expectEqual(rateLimitClassForRoute("/api/exports/ledger", "GET"), "export", "as is anything under the export prefix");
  expectEqual(rateLimitClassForRoute("/api/reports/export", "POST"), "export", "and anything that ends in the export word");
  expectEqual(rateLimitClassForRoute("/api/invoices", "POST"), "authenticated", "every other API route is the authenticated class");
  expectEqual(rateLimitClassForRoute("/dashboard", "GET"), null, "a page is not counted here");
  expectEqual(rateLimitClassForRoute("/", "GET"), null, "and neither is the root page");
  expectEqual(isRateLimitReadMethod("GET"), true, "GET reads");
  expectEqual(isRateLimitReadMethod("DELETE"), false, "DELETE writes");

  for (const exempt of RATE_LIMIT_EXEMPT_ROUTES) {
    expectEqual(isRateLimitExemptRoute(exempt), true, `${exempt} is a liveness probe`);
    expectEqual(rateLimitClassForRoute(exempt, "GET"), null, `${exempt} has no class`);
    expectEqual(rateLimitClassForRoute(`${exempt}?probe=1`, "GET"), null, `${exempt} stays exempt with a query string`);
    expectEqual(isRateLimitExemptRoute(`${exempt}/deep`), false, `${exempt} exempts exactly itself and nothing under it`);
  }
}

function checkRateLimitBuckets(): void {
  const office = rateLimitBucketsFor({
    route: "/api/office/sessions/revoke",
    method: "POST",
    clientAddress: rateLimitAddress,
    userId: rateLimitTestUser,
  });

  expect(office !== null, "an office write is counted");

  if (office === null) {
    return;
  }

  expectEqual(office.map((bucket) => bucket.dimension).join(","), "ip,user,route", "in all three buckets");
  expectEqual(office[0]?.scope, "ip_office_write", "the address bucket names its class");
  expectEqual(office[1]?.scope, "user_office_write", "the account bucket names its class");
  expectEqual(office[2]?.scope, "route_office_write", "and the route bucket names its class");
  expectEqual(office[0]?.limit, RATE_LIMIT_CLASS_POLICIES.office_write.ip.limit, "the address bucket carries the policy limit");
  expectEqual(office[1]?.limit, RATE_LIMIT_CLASS_POLICIES.office_write.user?.limit, "the account bucket too");
  expectEqual(office[2]?.limit, RATE_LIMIT_CLASS_POLICIES.office_write.route.limit, "and the route bucket");
  expect(office.every((bucket) => RATE_LIMIT_KEY_HASH_PATTERN.test(bucket.keyHash)), "every key is a hex SHA-256");
  expectEqual(new Set(office.map((bucket) => bucket.keyHash)).size, 3, "and the three keys are namespaced apart");

  const hook = rateLimitBucketsFor({
    route: "/api/webhooks/stripe",
    method: "POST",
    clientAddress: rateLimitAddress,
    userId: rateLimitTestUser,
  });

  expectEqual(hook?.map((bucket) => bucket.dimension).join(","), "ip,route", "a webhook is counted by address and route only");

  const again = rateLimitBucketsFor({
    route: "/api/office/sessions/revoke",
    method: "POST",
    clientAddress: rateLimitAddress,
    userId: rateLimitTestUser,
  });

  expectEqual(
    again?.map((bucket) => bucket.keyHash).join(","),
    office.map((bucket) => bucket.keyHash).join(","),
    "the same request produces the same keys",
  );

  const otherRoute = rateLimitBucketsFor({
    route: "/api/office/2fa-reset-requests",
    method: "POST",
    clientAddress: rateLimitAddress,
    userId: rateLimitTestUser,
  });

  expectEqual(otherRoute?.[0]?.keyHash, office[0]?.keyHash, "the address bucket is shared across the class");
  expect(otherRoute?.[2]?.keyHash !== office[2]?.keyHash, "the route bucket is not shared across the class");

  const otherUser = rateLimitBucketsFor({
    route: "/api/office/sessions/revoke",
    method: "POST",
    clientAddress: rateLimitAddress,
    userId: rateLimitSecondUser,
  });

  expectEqual(otherUser?.[1]?.keyHash === office[1]?.keyHash, false, "a second account has its own bucket");

  const sixthForm = rateLimitBucketsFor({
    route: "/api/public/pay",
    method: "POST",
    clientAddress: "2001:0db8:0000:0000:0000:0000:0000:0001",
    userId: rateLimitTestUser,
  });
  const sixthFormAgain = rateLimitBucketsFor({
    route: "/api/public/pay",
    method: "POST",
    clientAddress: "2001:DB8::1",
    userId: rateLimitTestUser,
  });

  expectEqual(sixthForm?.[0]?.keyHash, sixthFormAgain?.[0]?.keyHash, "one IPv6 address in two spellings is one bucket");
  expectEqual(sixthForm?.[2]?.keyHash, sixthFormAgain?.[2]?.keyHash, "on the route bucket as well");

  expectThrows(
    () => rateLimitBucketsFor({ route: "/api/office/sessions", method: "GET", clientAddress: rateLimitAddress }),
    "a class with a user bucket refuses a request with no account",
  );
  expectThrows(
    () =>
      rateLimitBucketsFor({
        route: "/api/office/sessions",
        method: "GET",
        clientAddress: rateLimitAddress,
        userId: "not-a-uuid",
      }),
    "and refuses an account id that is not one",
  );

  const noAddress = expectThrows(
    () => rateLimitBucketsFor({ route: "/api/office/sessions", method: "GET", clientAddress: null, userId: rateLimitTestUser }),
    "a request with no address cannot be counted",
  );
  expectEqual(noAddress?.code, "SERVICE_UNAVAILABLE", "and is refused rather than let through");

  const badAddress = expectThrows(
    () =>
      rateLimitBucketsFor({
        route: "/api/office/sessions",
        method: "GET",
        clientAddress: "1.2.3.4:8080",
        userId: rateLimitTestUser,
      }),
    "a value that is not an address cannot be counted either",
  );
  expectEqual(badAddress?.code, "SERVICE_UNAVAILABLE", "with the same code");

  expectEqual(
    rateLimitBucketsFor({
      route: "/api/health",
      method: "GET",
      clientAddress: rateLimitAddress,
      userId: rateLimitTestUser,
    }),
    null,
    "a liveness probe has no bucket",
  );
  expectEqual(
    rateLimitBucketsFor({ route: "/invoices", method: "GET", clientAddress: rateLimitAddress }),
    null,
    "and a page has none either",
  );
}

async function checkRateLimitDecision(): Promise<void> {
  const counter = createFakeCounter();
  const request = {
    route: "/api/office/sessions/revoke",
    method: "POST",
    clientAddress: rateLimitAddress,
    userId: rateLimitTestUser,
  } as const;

  const first = await consumeRateLimitBuckets(request, rateLimitDependencies(counter));

  expectEqual(first.allowed, true, "a first request is allowed");
  expectEqual(first.exempt, false, "and is not exempt");
  expectEqual(first.class, "office_write", "the class is the route's class");
  expectEqual(first.limit, 30, "the limit reported is the tightest bucket's");
  expectEqual(first.remaining, 29, "and so is the remaining count");
  expectEqual(first.retryAfterSeconds, 0, "an allowed request asks for no wait");
  expectEqual(first.refusedBuckets.length, 0, "and names no refusing bucket");
  expectEqual(counter.calls.length, 3, "the request was counted three times");
  expectEqual(counter.calls[0]?.functionName, RATE_LIMIT_COUNTER_FUNCTION, "through the counter function of 0092");
  expectEqual(counter.calls[0]?.arguments["p_scope"], "ip_office_write", "with the address scope");
  expectEqual(counter.calls[0]?.arguments["p_limit"], 60, "the policy limit");
  expectEqual(counter.calls[0]?.arguments["p_window_seconds"], 60, "the policy window");
  expectEqual(counter.calls[0]?.arguments["p_now"], "2026-11-01T10:00:30.000Z", "and the clock the caller supplied");
  expect(
    counter.calls.every((call) => RATE_LIMIT_KEY_HASH_PATTERN.test(String(call.arguments["p_key_hash"]))),
    "every key sent to the counter is a hex SHA-256",
  );

  let last = first;

  for (let index = 2; index <= 30; index += 1) {
    last = await consumeRateLimitBuckets(request, rateLimitDependencies(counter));
  }

  expectEqual(last.allowed, true, "the request that reaches the limit is allowed");
  expectEqual(last.remaining, 0, "and has no room left");

  const refused = await consumeRateLimitBuckets(request, rateLimitDependencies(counter));

  expectEqual(refused.allowed, false, "the next request is refused");
  expectEqual(refused.retryAfterSeconds, 30, "for the rest of the window");
  expectEqual(refused.refusedBuckets.join(","), "route", "the tightest bucket is the one that refused");
  expectEqual(refused.firstRefusalBuckets.join(","), "route", "and it is the first refusal of its window");
  expectEqual(refused.class, "office_write", "the class survives a refusal");

  const entries: RateLimitAuditEntry[] = [];
  const audit: RateLimitAuditTrail = {
    append(entry) {
      entries.push(entry);

      return Promise.resolve();
    },
  };
  const enforcing = createFakeCounter();
  const auditRequest = { ...request, route: "/api/office/2fa-reset-requests" } as const;

  for (let index = 1; index <= 30; index += 1) {
    await enforceRouteRateLimit(auditRequest, rateLimitDependencies(enforcing, audit));
  }

  expectEqual(entries.length, 0, "a request inside the limit writes no audit entry");

  const error = await expectThrowsAsync(
    () => enforceRouteRateLimit(auditRequest, rateLimitDependencies(enforcing, audit)),
    "a request past the limit is refused",
  );

  expectEqual(error?.code, "RATE_LIMITED", "with the code the catalog already carries");
  expectEqual(error?.status, 429, "which is a 429");
  expectEqual(error?.retryAfterSeconds, 30, "and carries the delay in retry-after");
  expectEqual(entries.length, 1, "the refusal is audited once");

  await expectThrowsAsync(
    () => enforceRouteRateLimit(auditRequest, rateLimitDependencies(enforcing, audit)),
    "and the next refusal is refused again",
  );

  expectEqual(entries.length, 1, "but the audit chain is not a copy of the attack");

  const pathCounter = createFakeCounter({ refuse: (scope) => (scope === "route_webhook" ? 15 : null) });
  const pathRefusal = await consumeRateLimitBuckets(
    { route: "/api/webhooks/stripe", method: "POST", clientAddress: rateLimitAddress },
    rateLimitDependencies(pathCounter),
  );

  expectEqual(pathRefusal.allowed, false, "one full bucket refuses the request");
  expectEqual(pathRefusal.refusedBuckets.join(","), "route", "and only that bucket names itself");
  expectEqual(pathRefusal.retryAfterSeconds, 15, "the wait is the refusing bucket's");
  expectEqual(
    pathCounter.calls.map((call) => String(call.arguments["p_scope"])).sort().join(","),
    "ip_webhook,route_webhook",
    "the other buckets were counted even though one refused",
  );

  const delayCounter = createFakeCounter({
    refuse: (scope) => (scope === "user_office_write" ? 12 : scope === "route_office_write" ? 40 : null),
  });
  const delay = await consumeRateLimitBuckets(request, rateLimitDependencies(delayCounter));

  expectEqual(delay.refusedBuckets.join(","), "user,route", "two refusing buckets are both named");
  expectEqual(delay.retryAfterSeconds, 40, "and the wait is the longest of them, not the first");

  const remainingCounter = createFakeCounter({
    remaining: (scope) =>
      scope === "ip_office_write" ? 5 : scope === "user_office_write" ? 2 : scope === "route_office_write" ? 7 : null,
  });
  const tightest = await consumeRateLimitBuckets(request, rateLimitDependencies(remainingCounter));

  expectEqual(tightest.allowed, true, "a request inside every limit is allowed");
  expectEqual(tightest.remaining, 2, "and reports the bucket that runs out first");

  const exemptCounter = createFakeCounter();
  const exempt = await consumeRateLimitBuckets(
    { route: "/api/health", method: "GET", clientAddress: rateLimitAddress, userId: rateLimitTestUser },
    rateLimitDependencies(exemptCounter),
  );

  expectEqual(exempt.exempt, true, "a liveness probe is exempt");
  expectEqual(exempt.allowed, true, "and allowed");
  expectEqual(exempt.buckets.length, 0, "without a counter");
  expectEqual(exemptCounter.calls.length, 0, "and without a query");
  expectEqual(exempt.limit, 0, "the reported limit is zero because nothing was counted");

  const notAnAddress = await expectThrowsAsync(
    () =>
      enforceRouteRateLimit(
        { route: "/api/office/sessions", method: "GET", clientAddress: null, userId: rateLimitTestUser },
        rateLimitDependencies(createFakeCounter()),
      ),
    "a request that cannot be counted is refused",
  );

  expectEqual(notAnAddress?.code, "SERVICE_UNAVAILABLE", "with the code of an uncountable request");

  const badAnswers: readonly unknown[] = [
    null,
    [],
    [{}],
    [{ allowed: "yes", remaining: 1, retry_after_seconds: 0, first_refusal: false }],
    [{ allowed: true, remaining: 1_000, retry_after_seconds: 0, first_refusal: false }],
    [{ allowed: true, remaining: 1, retry_after_seconds: 5, first_refusal: false }],
    [{ allowed: true, remaining: 1, retry_after_seconds: 0, first_refusal: true }],
    [{ allowed: false, remaining: 0, retry_after_seconds: 0, first_refusal: true }],
    [{ allowed: false, remaining: 0, retry_after_seconds: 90_000, first_refusal: true }],
    [{ allowed: false, remaining: -1, retry_after_seconds: 5, first_refusal: true }],
  ];

  for (const answer of badAnswers) {
    const broken = await expectThrowsAsync(
      () =>
        consumeRateLimitBuckets(request, {
          rest: { rpc: () => Promise.resolve(answer) },
          now: () => rateLimitFixedNow,
        }),
      `a counter answer of ${JSON.stringify(answer)} is a dependency failure`,
    );

    expectEqual(broken?.code, "DEPENDENCY_FAILED", "and never read as an allowance");
  }

  const unavailable = await expectThrowsAsync(
    () =>
      consumeRateLimitBuckets(request, {
        rest: { rpc: () => Promise.reject(new AppError("DEPENDENCY_FAILED")) },
        now: () => rateLimitFixedNow,
      }),
    "a counter that cannot answer refuses the request",
  );

  expectEqual(unavailable?.code, "DEPENDENCY_FAILED", "with the dependency code rather than a free pass");
}

function checkRateLimitReports(): void {
  const outcome = {
    route: "/api/office/sessions/revoke",
    method: "POST",
    class: "office_write" as const,
    exempt: false,
    allowed: false,
    limit: 30,
    remaining: 0,
    retryAfterSeconds: 30,
    buckets: [
      {
        dimension: "ip" as const,
        scope: "ip_office_write",
        keyHash: "a".repeat(64),
        limit: 60,
        windowSeconds: 60,
        allowed: true,
        remaining: 0,
        retryAfterSeconds: 0,
        firstRefusal: false,
      },
      {
        dimension: "route" as const,
        scope: "route_office_write",
        keyHash: "b".repeat(64),
        limit: 30,
        windowSeconds: 60,
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 30,
        firstRefusal: true,
      },
    ],
    refusedBuckets: ["route" as const],
    firstRefusalBuckets: ["route" as const],
  };
  const entry = rateLimitAuditEntry(outcome, {
    ipAddress: rateLimitAddress,
    userAgent: "probe/1.0",
    userId: rateLimitTestUser,
    companyId: null,
  });

  expect(entry !== null, "a first refusal produces an audit entry");

  if (entry !== null) {
    expectEqual(entry.action, RATE_LIMIT_AUDIT_ACTION, "with the action this module owns");
    expect(/^[a-z][a-z0-9]*([.][a-z0-9_]+)+$/u.test(entry.action), "which is a dotted action name");
    expect(entry.action.length <= 64, "inside the length the audit table accepts");
    expect(/^[a-z][a-z0-9_]*$/u.test(String(entry.entityType)), "and a lower snake entity type");
    expectEqual(entry.actorUserId, rateLimitTestUser, "it names the account");
    expectEqual(entry.ipAddress, rateLimitAddress, "and the address");
    expectEqual(entry.payload["route"], outcome.route, "the payload names the route");
    expectEqual(entry.payload["class"], "office_write", "and the class");
    expectEqual(entry.payload["rule"], RATE_LIMIT_RULE, "and the rule a screen can name");
    expectEqual(entry.payload["retry_after_seconds"], 30, "and the wait");
    expectEqual(String(entry.payload["buckets"]), "route", "and the bucket that refused");
    expectEqual(String(entry.payload["scopes"]), "route_office_write", "with the scope it is stored under");
    expect(
      (entry.payload["key_hashes"] as readonly string[]).every((hash) => RATE_LIMIT_KEY_HASH_PATTERN.test(hash)),
      "the payload carries key hashes, never the address as a key",
    );
    expect(new TextEncoder().encode(JSON.stringify(entry.payload)).length <= 8_192, "the payload fits the audit column");
  }

  expectEqual(
    rateLimitAuditEntry({ ...outcome, allowed: true, firstRefusalBuckets: [], refusedBuckets: [] }, { ipAddress: rateLimitAddress }),
    null,
    "an allowed request writes nothing",
  );
  expectEqual(
    rateLimitAuditEntry(
      { ...outcome, allowed: false, firstRefusalBuckets: [], buckets: [], refusedBuckets: ["route"] },
      { ipAddress: rateLimitAddress },
    ),
    null,
    "and a refusal that is not the first of its window writes nothing either",
  );

  const headers = rateLimitHeaders(outcome, rateLimitFixedNow);

  expectEqual(Object.keys(headers).sort().join(","), "ratelimit-limit,ratelimit-remaining,ratelimit-reset", "the rate limit headers are exactly these three");
  expectEqual(headers["ratelimit-limit"], "30", "the limit is the tightest bucket's");
  expectEqual(headers["ratelimit-remaining"], "0", "so is the remaining count");
  expectEqual(headers["ratelimit-reset"], "30", "and the reset is the seconds left in the window");
  expect(
    Object.keys(headers).every((name) => !SECURITY_HEADER_NAMES.includes(name)),
    "none of them is a security header of STEP 060",
  );
  expect(
    Object.values(headers).every((value) => /^[0-9]+$/u.test(value)),
    "and every value is a number a client can read",
  );

  for (const instant of ["2026-11-01T10:00:07.000Z", "2026-11-01T10:00:59.000Z", "2026-11-01T10:04:01.000Z"]) {
    const at = Date.parse(instant);
    const reset = Number(rateLimitHeaders(outcome, at)["ratelimit-reset"]);

    expectEqual(reset, 60 - (Math.floor(at / 1_000) % 60), `the reset at ${instant} is the seconds left in the window`);
    expect(reset >= 1 && reset <= 60, `and it never leaves the window at ${instant}`);
  }
  expectEqual(
    Object.keys(rateLimitHeaders({ ...outcome, exempt: true, buckets: [] }, rateLimitFixedNow)).length,
    0,
    "an exempt route writes no headers",
  );
}

async function checkRateLimitWiring(): Promise<void> {
  const source = await readFile(new URL("./rate-limit.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../migrations/0092_rate_limit_windows.sql", import.meta.url), "utf8");
  const authSource = await readFile(new URL("../auth/rate-limit.ts", import.meta.url), "utf8");
  const catalogue = await readFile(new URL("../i18n/strings/en.ts", import.meta.url), "utf8");

  expect(source.includes(`"${RATE_LIMIT_COUNTER_FUNCTION}"`), "the module calls the counter function by its name");
  expect(authSource.includes(RATE_LIMIT_COUNTER_FUNCTION), "which is the same function the auth limiter calls");
  expectEqual(source.includes("insert into"), false, "and it never writes the counter itself");
  expectEqual(source.includes("update public.rate_limit_windows"), false, "or moves the row directly");
  expectEqual(source.includes("create table"), false, "no second table is created here");
  expectEqual(source.includes("from \"../auth"), false, "the module imports nothing from the auth tree, so there is no cycle");
  expectEqual(source.includes("x-forwarded-for"), false, "and it never reads a forwarding header");
  expectEqual(source.includes("x-real-ip"), false, "or the real ip header");
  expectEqual(source.includes("headers.get"), false, "because the trust rule of one address stays in one file");
  expect(source.includes("from \"node:net\""), "an address is recognised by the platform, not by a pattern here");
  expect(source.includes("from \"node:crypto\""), "the key is a SHA-256 from the platform's hash");

  expect(migration.includes("create table public.rate_limit_windows"), "0092 owns the counter table");
  expect(migration.includes("create function public.consume_rate_limit"), "and the one statement that moves it");
  expect(migration.includes(RATE_LIMIT_SCOPE_PATTERN.source), "the migration states the scope pattern this module generates");
  expect(migration.includes(RATE_LIMIT_KEY_HASH_PATTERN.source), "and the key shape");
  expect(
    migration.includes(`between ${RATE_LIMIT_MINIMUM_WINDOW_SECONDS} and ${RATE_LIMIT_MAXIMUM_WINDOW_SECONDS}`),
    "and the window bounds",
  );
  expect(migration.includes("constraint rate_limit_windows_scope_key_unique unique (scope, key_hash)"), "one row per bucket per subject");
  expect(migration.includes("first_refusal"), "the answer carries the flag the audit depends on");
  expect(RATE_LIMIT_SCOPE_PATTERN.source === "^[a-z][a-z0-9_]{1,39}$", "and the pattern is exactly the one written in the migration");
  expectEqual(RATE_LIMIT_MAXIMUM_SCOPE_LENGTH, 40, "forty characters is the longest scope the column stores");
  expectEqual(Object.keys(RATE_LIMIT_CLASS_POLICIES).length, 6, "the policy table matches the class count the gate asserts");

  const migrations = await readdir(new URL("../../migrations/", import.meta.url));
  let counterDefinitions = 0;

  for (const name of migrations.filter((entry) => entry.endsWith(".sql") && !entry.endsWith(".down.sql"))) {
    const text = await readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");

    if (text.includes("create function public.consume_rate_limit")) {
      counterDefinitions += 1;
    }
  }

  expectEqual(counterDefinitions, 1, "exactly one migration defines the counter, so there is no second counter to work under");

  expect(catalogue.includes("rateLimited:"), "the refusal has a sentence in the catalog");
  expect(catalogue.includes("rateLimit: {"), "and the screens have their own wording for the wait");

  const appRoot = new URL("../../", import.meta.url);
  const apiEntries = (await readdir(appRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.startsWith("app/api/") && entry.endsWith("/route.ts"));
  const apiRoutes = apiEntries.map((entry) => `/${entry.slice("app/".length, -"/route.ts".length)}`);

  expect(apiRoutes.length > 0, "the repository has API routes to classify");

  let unclassified = 0;

  for (const route of apiRoutes) {
    const limitClass = rateLimitClassForRoute(route, "POST");
    const exempt = isRateLimitExemptRoute(route);

    if (limitClass === null && !exempt) {
      unclassified += 1;
    }
  }

  expectEqual(unclassified, 0, "every route in app/api is counted by a class or is a liveness probe");
  expectEqual(
    apiRoutes.filter((route) => isRateLimitExemptRoute(route)).sort().join(","),
    [...RATE_LIMIT_EXEMPT_ROUTES].sort().join(","),
    "and the probes in the tree are exactly the exempt list",
  );
  expect(
    apiRoutes
      .filter((route) => route.startsWith("/api/office/"))
      .every((route) => rateLimitClassForRoute(route, "GET") === "office_read"),
    "every office route would be counted as a read on a GET",
  );
  expect(
    apiRoutes
      .filter((route) => route.startsWith("/api/office/"))
      .every((route) => rateLimitClassForRoute(route, "POST") === "office_write"),
    "and as a write on a POST",
  );
}

/** ---- Audit: one chain, one writer, and the proof that nobody edited it. */

interface RecordedAuditCall {
  readonly functionName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

interface FakeAuditStore {
  readonly client: AuditStoreClient;
  readonly calls: RecordedAuditCall[];
  readonly rows: (readonly Readonly<Record<string, unknown>>[])[];
  readonly tables: string[];
}

interface FakeAuditStoreOptions {
  readonly nextLink?: unknown;
  readonly hash?: unknown;
  readonly signature?: string;
  readonly failInsert?: boolean;
}

/** A store that answers like `0075` and records what the writer asked it. */
function createFakeAuditStore(options: FakeAuditStoreOptions = {}): FakeAuditStore {
  const calls: RecordedAuditCall[] = [];
  const rows: (readonly Readonly<Record<string, unknown>>[])[] = [];
  const tables: string[] = [];
  const client: AuditStoreClient = {
    rpc(functionName, arguments_) {
      calls.push({ functionName, arguments: arguments_ });

      if (functionName === "audit_next_link") {
        return Promise.resolve(
          "nextLink" in options ? options.nextLink : [{ next_sequence: 1, prev_hash: AUDIT_GENESIS_HASH }],
        );
      }

      if (functionName === "audit_hash_v1") {
        return Promise.resolve("hash" in options ? options.hash : "c".repeat(64));
      }

      return Promise.resolve(null);
    },
    insert(table, inserted) {
      calls.push({ functionName: "insert", arguments: { table } });
      tables.push(table);
      rows.push(inserted);

      return options.failInsert === true
        ? Promise.reject(new AppError("DEPENDENCY_FAILED"))
        : Promise.resolve();
    },
  };

  return { client, calls, rows, tables };
}

const auditCompanyId = "018f2b8a-3333-4c2d-9c3e-0123456789ab";
const auditEntityId = "018f2b8a-4444-4c2d-9c3e-0123456789ab";
const auditUserId = "018f2b8a-5555-4c2d-9c3e-0123456789ab";
const auditFixedNow = Date.parse("2026-11-01T10:00:00.000Z");

function auditTestEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    action: "invoice.sent",
    actorUserId: auditUserId,
    entityType: "invoice",
    entityId: auditEntityId,
    payload: { total: 100, currency: "usd" },
    companyId: auditCompanyId,
    ...overrides,
  };
}

function auditWriterFor(store: FakeAuditStore, signature = "s".repeat(86)): ReturnType<typeof createAuditWriter> {
  return createAuditWriter({
    store: store.client,
    signHash: () => signature,
    // Deliberately not the key of the first rotation, so a writer that ignored this option and
    // hard coded a key id would be caught by the row it wrote.
    signingKeyId: "audit-v2",
    now: () => auditFixedNow,
  });
}

function checkAuditPolicy(): void {
  expectEqual(AUDIT_ACTION_PATTERN.source, "^[a-z][a-z0-9]*([.][a-z0-9_]+)+$", "the action pattern is the dotted name audit_logs_action_check states");
  expectEqual(AUDIT_MAXIMUM_ACTION_LENGTH, 64, "with the length that check allows");
  expectEqual(AUDIT_ENTITY_TYPE_PATTERN.source, "^[a-z][a-z0-9_]*$", "the entity type pattern is the one audit_logs_entity_type_check states");
  expectEqual(AUDIT_MAXIMUM_ENTITY_TYPE_LENGTH, 48, "with its length");
  expectEqual(AUDIT_HASH_PATTERN.source, "^[0-9a-f]{64}$", "a hash is sixty-four lower case hex characters");
  expectEqual(AUDIT_SIGNATURE_PATTERN.source, "^[A-Za-z0-9_-]{86}$", "a signature is the base64url of sixty-four bytes");
  expectEqual(AUDIT_SIGNING_KEY_ID_PATTERN.source, "^[a-z0-9][a-z0-9-]{2,47}$", "a key id is the shape the column stores");
  expectEqual(AUDIT_MAXIMUM_PAYLOAD_BYTES, 8_192, "the payload ceiling is the one audit_logs_payload_check states");
  expectEqual(AUDIT_MAXIMUM_USER_AGENT_LENGTH, 512, "so is the user agent ceiling");
  expectEqual(AUDIT_GENESIS_HASH, "0".repeat(64), "the first row of a chain points at sixty-four zeros");
  expectEqual(AUDIT_GENESIS_HASH.length, 64, "which is a hash's length");
  expectEqual(AUDIT_PLATFORM_CHAIN_ID, "00000000-0000-0000-0000-000000000000", "the platform chain is the zero uuid");
  expectEqual(AUDIT_TABLE, "audit_logs", "the table is the append-only one");
  expectEqual(AUDIT_SEQUENCE_START, 1, "every chain starts at one");
  expectEqual(AUDIT_REDACTED, "[redacted]", "a redacted value is marked rather than removed");
  expectEqual(AUDIT_HASH_ARGUMENTS.length, 9, "audit_hash_v1 takes nine arguments");
  expectEqual(AUDIT_ROW_FIELDS.length, 16, "and a row writes sixteen columns");
  expect(Object.isFrozen(AUDIT_HASH_ARGUMENTS), "the argument list is frozen");
  expect(Object.isFrozen(AUDIT_ROW_FIELDS), "and so is the column list");
  expect(Object.isFrozen(AUDIT_SECRET_KEY_FRAGMENTS), "and the credential vocabulary");

  const validActions = [
    "a.b",
    "invoice.sent",
    "session.revoked_by_owner",
    "user.two_factor_reset_requested",
    "payments.settled",
    "security.rate_limited",
    "x.y",
  ];

  for (const action of validActions) {
    expect(AUDIT_ACTION_PATTERN.test(action) && action.length <= AUDIT_MAXIMUM_ACTION_LENGTH, `${action} is a writable action`);
  }

  const invalidActions = [
    "approve",
    "auth.",
    "auth..b",
    ".auth.b",
    "Auth.b",
    "auth.B",
    "auth.b-c",
    "auth. b",
    "1auth.b",
    "auth_b",
    "auth.b c",
    "",
    "a".repeat(70),
  ];

  for (const action of invalidActions) {
    expect(
      !AUDIT_ACTION_PATTERN.test(action) || action.length > AUDIT_MAXIMUM_ACTION_LENGTH,
      `${JSON.stringify(action)} is not a writable action`,
    );
  }
}

function checkAuditRedaction(): void {
  const secretKeys = [
    "password",
    "Password",
    "new_password",
    "passphrase",
    "client_secret",
    "apiKey",
    "api-key",
    "API_KEY",
    "private_key",
    "authorization",
    "x-auth-token",
    "token",
    "refresh_token",
    "cookie",
    "csrf",
    "proof_key",
    "otp",
    "totp_code",
    "backup_code",
    "card_number",
    "cvv",
    "signing_seed",
  ];

  for (const key of secretKeys) {
    expect(isAuditSecretKey(key), `${key} names a credential`);
  }

  const plainKeys = ["total", "amount", "action", "route", "limit", "score", "key_hashes", "scopes", "window_seconds", "currency", "email"];

  for (const key of plainKeys) {
    expect(!isAuditSecretKey(key), `${key} is a value, not a credential`);
  }

  const payload = {
    total: 100,
    password: "hunter2",
    nested: { apiKey: "sk_live_1", keep: "value" },
    list: [{ token: "t", amount: 5 }],
    Authorization: "Bearer abc",
  };
  const redacted = redactAuditPayload(payload);
  const rendered = JSON.stringify(redacted);

  expectEqual(redacted["total"], 100, "a plain value is kept");
  expectEqual(redacted["password"], AUDIT_REDACTED, "a password is replaced");
  expectEqual(redacted["Authorization"], AUDIT_REDACTED, "so is an authorisation header");
  expectEqual((redacted["nested"] as Record<string, unknown>)["apiKey"], AUDIT_REDACTED, "and a nested key");
  expectEqual((redacted["nested"] as Record<string, unknown>)["keep"], "value", "while its neighbour survives");
  expectEqual(((redacted["list"] as readonly Record<string, unknown>[])[0] ?? {})["token"], AUDIT_REDACTED, "and one inside an array");
  expectEqual(((redacted["list"] as readonly Record<string, unknown>[])[0] ?? {})["amount"], 5, "and only that one");
  expectEqual(payload.password, "hunter2", "the caller's object is not modified");
  expect(Object.isFrozen(redacted), "the redacted payload is frozen");
  expect(Object.isFrozen(redacted["nested"]), "and so is every nested object");
  expect(!rendered.includes("hunter2") && !rendered.includes("sk_live_1"), "no credential survives in the JSON");
  expectEqual(JSON.stringify(redactAuditPayload(payload)), rendered, "redaction is deterministic");
  expectEqual(JSON.stringify(redactAuditPayload(redacted)), rendered, "and idempotent");

  let deep: Record<string, unknown> = { value: 1 };

  for (let level = 0; level < AUDIT_MAXIMUM_PAYLOAD_DEPTH + 2; level += 1) {
    deep = { nested: deep };
  }

  const tooDeep = expectThrows(
    () => redactAuditPayload(deep),
    "a payload nested deeper than the ceiling is a mistake rather than a value",
  );

  expectEqual(tooDeep?.code, "INTERNAL_ERROR", "and is refused as one");
}

function checkAuditEntry(): void {
  const built = buildAuditEntry(
    auditTestEntry({
      ipAddress: "2001:DB8::1",
      userAgent: "  probe/1.0  ",
      payload: { total: 100, token: "t" },
      sessionId: null,
    }),
  );

  expectEqual(built.ipAddress, "2001:db8::1", "the address is stored in one spelling");
  expectEqual(built.userAgent, "probe/1.0", "the user agent is trimmed");
  expectEqual(built.payload["token"], AUDIT_REDACTED, "the payload is redacted on the way in");
  expectEqual(built.payload["total"], 100, "and its plain values are kept");
  expect(Object.isFrozen(built), "the entry is frozen");

  const problems: readonly (readonly [Partial<AuditEntry>, AuditEntryProblem])[] = [
    [{ action: "approve" }, "action_invalid"],
    [{ action: `${"a".repeat(30)}.${"b".repeat(40)}` }, "action_too_long"],
    [{ entityType: "Invoice" }, "entity_type_invalid"],
    [{ entityType: "i".repeat(49) }, "entity_type_too_long"],
    [{ entityId: null }, "entity_pair_invalid"],
    [{ entityType: null }, "entity_pair_invalid"],
    [{ entityId: "not-a-uuid" }, "entity_id_invalid"],
    [{ actorUserId: "nobody" }, "actor_invalid"],
    [{ companyId: "no-company" }, "company_invalid"],
    [{ sessionId: "session" }, "session_invalid"],
    [{ payload: [] as unknown as Readonly<Record<string, unknown>> }, "payload_not_object"],
    [{ payload: { note: "x".repeat(AUDIT_MAXIMUM_PAYLOAD_BYTES) } }, "payload_too_large"],
    [{ ipAddress: "1.2.3.4:8080" }, "address_invalid"],
    [{ userAgent: "" }, "user_agent_invalid"],
    [{ userAgent: "u".repeat(AUDIT_MAXIMUM_USER_AGENT_LENGTH + 1) }, "user_agent_invalid"],
  ];

  for (const [override, expected] of problems) {
    expectEqual(auditEntryProblem(auditTestEntry(override)), expected, `${expected} is named rather than left to the database`);
  }

  expectEqual(auditEntryProblem(auditTestEntry()), null, "a well formed entry has no problem");
  expectEqual(
    auditPayloadBytes({ a: 1, b: "two" }),
    new TextEncoder().encode(JSON.stringify({ a: 1, b: "two" })).length,
    "the payload is measured the way audit_logs_payload_check measures it",
  );
  expectEqual(requireAuditEntry(auditTestEntry()).action, "invoice.sent", "and passes the guard unchanged");
  expectEqual(
    new Set(AUDIT_ENTRY_PROBLEMS).size,
    AUDIT_ENTRY_PROBLEMS.length,
    "every problem reason is distinct",
  );
  expect(
    problems.every(([, reason]) => AUDIT_ENTRY_PROBLEMS.includes(reason)),
    "and every reason a check can name is in the export",
  );
}

async function checkAuditWriter(): Promise<void> {
  const store = createFakeAuditStore();
  const signed: string[] = [];
  const watching = createAuditWriter({
    store: store.client,
    signHash: (hash) => {
      signed.push(hash);

      return "s".repeat(86);
    },
    signingKeyId: "audit-v2",
    now: () => auditFixedNow,
  });
  const record = await watching.append(auditTestEntry({ payload: { total: 100, password: "hunter2" } }));

  expectEqual(store.calls.map((call) => call.functionName).join(","), "audit_next_link,audit_hash_v1,insert", "the writer asks the chain, asks the hash, then writes");
  expectEqual(store.calls[0]?.arguments["p_chain"], auditCompanyId, "the tenant is the chain");
  expectEqual(store.tables[0], AUDIT_TABLE, "and the row goes to the audit table");
  expectEqual(Object.keys(store.calls[1]?.arguments ?? {}).join(","), AUDIT_HASH_ARGUMENTS.join(","), "the hash is asked with the nine arguments, in order");
  expectEqual(store.calls[1]?.arguments["payload"] !== undefined, true, "with the payload as redacted");
  expectEqual(
    JSON.stringify(store.calls[1]?.arguments["payload"]),
    JSON.stringify({ total: 100, password: AUDIT_REDACTED }),
    "which no longer carries the credential",
  );
  const row = store.rows[0]?.[0] ?? {};
  expectEqual(Object.keys(row).join(","), AUDIT_ROW_FIELDS.join(","), "the row writes the sixteen columns in order");
  expectEqual(row["company_id"], auditCompanyId, "with the tenant");
  expectEqual(row["payload"] !== undefined ? JSON.stringify(row["payload"]) : "", JSON.stringify({ total: 100, password: AUDIT_REDACTED }), "the same redacted payload is stored");
  expectEqual(row["sequence"], 1, "at the head's next sequence");
  expectEqual(row["prev_hash"], AUDIT_GENESIS_HASH, "pointing at the genesis link of the first row");
  expectEqual(row["hash"], "c".repeat(64), "with the hash the database computed");
  expectEqual(row["signature"], "s".repeat(86), "and the signature over it");
  expectEqual(row["signing_key_id"], "audit-v2", "naming the key that signed");
  expectEqual(row["created_at"], "2026-11-01T10:00:00.000Z", "at the event instant");
  expectEqual(row["updated_at"], row["created_at"], "which is also the update instant");
  expectEqual(signed[0], "c".repeat(64), "the signer was given the hash that was stored");
  expectEqual(record.hash, "c".repeat(64), "and the record reports the link");
  expectEqual(record.chainId, auditCompanyId, "the chain it extended");
  expectEqual(record.sequence, 1, "the position it took");
  expectEqual(record.signingKeyId, "audit-v2", "and the key id, as configured rather than as assumed");

  const platformStore = createFakeAuditStore({ nextLink: [{ next_sequence: 9, prev_hash: "b".repeat(64) }] });

  await auditWriterFor(platformStore).append(auditTestEntry({ companyId: null, entityType: null, entityId: null, actorUserId: null }));

  expectEqual(platformStore.calls[0]?.arguments["p_chain"], AUDIT_PLATFORM_CHAIN_ID, "a platform event extends the platform chain");
  expectEqual(platformStore.rows[0]?.[0]?.["company_id"], null, "with no tenant");
  expectEqual(platformStore.rows[0]?.[0]?.["prev_hash"], "b".repeat(64), "and continues from the head it was given");

  const badLinks: readonly unknown[] = [
    null,
    [],
    [{}],
    [{ next_sequence: 0, prev_hash: AUDIT_GENESIS_HASH }],
    [{ next_sequence: 1.5, prev_hash: AUDIT_GENESIS_HASH }],
    [{ next_sequence: "1", prev_hash: AUDIT_GENESIS_HASH }],
    [{ next_sequence: 1, prev_hash: "XYZ" }],
    [{ next_sequence: 1, prev_hash: "b".repeat(64) }],
    [{ next_sequence: 2, prev_hash: AUDIT_GENESIS_HASH }],
  ];

  for (const nextLink of badLinks) {
    const brokenStore = createFakeAuditStore({ nextLink });
    const failure = await expectThrowsAsync(
      () => auditWriterFor(brokenStore).append(auditTestEntry()),
      `a head of ${JSON.stringify(nextLink)} is not a head this writer will extend`,
    );

    expectEqual(failure?.code, "DEPENDENCY_FAILED", "and no row is written");
    expectEqual(brokenStore.rows.length, 0, "with nothing inserted");
  }

  const badHashes: readonly unknown[] = [null, "", "XYZ", "c".repeat(63), "C".repeat(64), ["a".repeat(64), "b".repeat(64)]];

  for (const hash of badHashes) {
    const brokenStore = createFakeAuditStore({ hash });
    const failure = await expectThrowsAsync(
      () => auditWriterFor(brokenStore).append(auditTestEntry()),
      `a hash of ${JSON.stringify(hash)} is not a hash`,
    );

    expectEqual(failure?.code, "DEPENDENCY_FAILED", "and the write stops");
    expectEqual(brokenStore.rows.length, 0, "before anything is inserted");
  }

  const sameHashStore = createFakeAuditStore({
    nextLink: [{ next_sequence: 2, prev_hash: "c".repeat(64) }],
    hash: "c".repeat(64),
  });
  const repeated = await expectThrowsAsync(
    () => auditWriterFor(sameHashStore).append(auditTestEntry()),
    "a hash equal to the previous one is refused, as audit_logs_hash_differs_check refuses it",
  );

  expectEqual(repeated?.code, "DEPENDENCY_FAILED", "with the dependency code");

  const shortSignature = createFakeAuditStore();
  const unsigned = await expectThrowsAsync(
    () => auditWriterFor(shortSignature, "too-short").append(auditTestEntry()),
    "a signature that is not eighty-six base64url characters is a writer fault",
  );

  expectEqual(unsigned?.code, "INTERNAL_ERROR", "reported as one");
  expectEqual(shortSignature.rows.length, 0, "and the row is not written unsigned");

  const failingStore = createFakeAuditStore({ failInsert: true });
  const failed = await expectThrowsAsync(
    () => auditWriterFor(failingStore).append(auditTestEntry()),
    "an insert that fails is a failed write",
  );

  expectEqual(failed?.code, "DEPENDENCY_FAILED", "and the caller is told the mutation is not recorded");

  const refusingStore = createFakeAuditStore();
  const invalid = await expectThrowsAsync(
    () => auditWriterFor(refusingStore).append(auditTestEntry({ action: "approve" })),
    "an entry that cannot exist is refused before the chain is touched",
  );

  expectEqual(invalid?.code, "INTERNAL_ERROR", "with the internal code, because it is a bug not a request");
  expectEqual(refusingStore.calls.length, 0, "and nothing was asked of the database");

  const badKey = expectThrows(
    () => createAuditWriter({ store: createFakeAuditStore().client, signHash: () => "", signingKeyId: "A" }),
    "a key id the column would refuse is refused when the writer is built",
  );

  expectEqual(badKey?.code, "INTERNAL_ERROR", "as a configuration fault");

  const sequenceStore = createFakeAuditStore({ nextLink: [{ next_sequence: 2, prev_hash: "b".repeat(64) }] });

  await auditWriterFor(sequenceStore).append(auditTestEntry());
  await auditWriterFor(sequenceStore).append(auditTestEntry());

  expectEqual(sequenceStore.calls.length, 6, "a second append walks the chain again");
  expectEqual(sequenceStore.rows.length, 2, "and writes a second row");
}

async function checkAuditIntegrity(): Promise<void> {
  const validStore: AuditRpcClient = {
    rpc(functionName, arguments_) {
      if (functionName === AUDIT_VERIFY_FUNCTION) {
        return Promise.resolve([
          {
            chain_id: arguments_["p_chain"],
            checked_rows: 12,
            is_valid: true,
            first_broken_sequence: null,
            broken_reason: null,
            head_sequence: 12,
            head_hash: "d".repeat(64),
          },
        ]);
      }

      return Promise.resolve("e".repeat(64));
    },
  };

    const verification = await verifyAuditChain({ chainId: auditCompanyId }, { rest: validStore });

    expectEqual(verification.checkedRows, 12, "a valid chain reports how many rows were walked");
    expectEqual(verification.valid, true, "and that it is valid");
    expectEqual(verification.firstBrokenSequence, null, "with no break");
    expectEqual(verification.headSequence, 12, "and the head it read");

    const calls: Readonly<Record<string, unknown>>[] = [];
    const recording: AuditRpcClient = {
      rpc(functionName, arguments_) {
        calls.push(arguments_);

        return validStore.rpc(functionName, arguments_);
      },
    };

    await verifyAuditChain({ chainId: auditCompanyId, fromSequence: 5, toSequence: 9 }, { rest: recording });
    expectEqual(calls[0]?.["p_from_sequence"], 5, "a range walks from the sequence it was given");
    expectEqual(calls[0]?.["p_to_sequence"], 9, "to the one it was given");

    await verifyAuditChain({ chainId: auditCompanyId }, { rest: recording });
    expectEqual(calls[1]?.["p_from_sequence"], 1, "and the whole chain starts at one");
    expectEqual(calls[1]?.["p_to_sequence"], null, "and ends at the head");

    const broken: AuditRpcClient = {
      rpc: () =>
        Promise.resolve([
          {
            chain_id: auditCompanyId,
            checked_rows: 12,
            is_valid: false,
            first_broken_sequence: 7,
            broken_reason: "hash mismatch",
            head_sequence: 12,
            head_hash: "d".repeat(64),
          },
        ]),
    };
    const brokenVerification = await verifyAuditChain({ chainId: auditCompanyId }, { rest: broken });

    expectEqual(brokenVerification.valid, false, "a tampered chain is reported as invalid");
    expectEqual(brokenVerification.firstBrokenSequence, 7, "with the position of the break");
    expectEqual(brokenVerification.brokenReason, "hash mismatch", "and the reason it broke");

    const badVerifications: readonly unknown[] = [
      null,
      [],
      [{}],
      [{ checked_rows: -1, is_valid: true, first_broken_sequence: null, broken_reason: null, head_sequence: 1, head_hash: "d".repeat(64) }],
      [{ checked_rows: 1, is_valid: "yes", first_broken_sequence: null, broken_reason: null, head_sequence: 1, head_hash: "d".repeat(64) }],
      [{ checked_rows: 1, is_valid: true, first_broken_sequence: 1, broken_reason: null, head_sequence: 1, head_hash: "d".repeat(64) }],
      [{ checked_rows: 1, is_valid: false, first_broken_sequence: null, broken_reason: null, head_sequence: 1, head_hash: "d".repeat(64) }],
      [{ checked_rows: 1, is_valid: false, first_broken_sequence: 1, broken_reason: "", head_sequence: 1, head_hash: "d".repeat(64) }],
      [{ checked_rows: 1, is_valid: true, first_broken_sequence: null, broken_reason: null, head_sequence: 1, head_hash: "nope" }],
    ];

    for (const body of badVerifications) {
      const failure = await expectThrowsAsync(
        () => verifyAuditChain({ chainId: auditCompanyId }, { rest: { rpc: () => Promise.resolve(body) } }),
        `a verdict of ${JSON.stringify(body)} is not a verdict`,
      );

      expectEqual(failure?.code, "DEPENDENCY_FAILED", "and is refused rather than believed");
    }

    for (const range of [{ chainId: "not-a-chain" }, { chainId: auditCompanyId, fromSequence: 0 }, { chainId: auditCompanyId, fromSequence: 5, toSequence: 4 }]) {
      const failure = await expectThrowsAsync(
        () => verifyAuditChain(range, { rest: validStore }),
        `the range ${JSON.stringify(range)} cannot be walked`,
      );

      expectEqual(failure?.code, "INTERNAL_ERROR", "and is a caller fault");
    }

    expectEqual(await readAuditMerkleRoot({ chainId: auditCompanyId }, { rest: validStore }), "e".repeat(64), "the root of a range is returned");
    expectEqual(await readAuditMerkleRoot({ chainId: auditCompanyId }, { rest: { rpc: () => Promise.resolve(null) } }), null, "an empty range has no root");
    expectEqual(await readAuditMerkleRoot({ chainId: auditCompanyId }, { rest: { rpc: () => Promise.resolve("") } }), null, "and neither has a blank answer");
    const badRoot = await expectThrowsAsync(
      () => readAuditMerkleRoot({ chainId: auditCompanyId }, { rest: { rpc: () => Promise.resolve("not-a-root") } }),
      "a root that is not a hash is refused",
    );

    expectEqual(badRoot?.code, "DEPENDENCY_FAILED", "with the dependency code");

    const report = await readAuditIntegrityReport({ chainId: auditCompanyId, fromSequence: 1, toSequence: 12 }, { rest: validStore });

    expectEqual(report.root, "e".repeat(64), "the report carries the root");
    expectEqual(report.valid, true, "and the verdict");
    expectEqual(report.fromSequence, 1, "and the range it covers");
    expectEqual(report.toSequence, 12, "at both ends");
    expectEqual(report.headHash, "d".repeat(64), "and the head hash an operator compares");

    const brokenReport = await expectThrowsAsync(
      () => readAuditIntegrityReport({ chainId: auditCompanyId }, { rest: broken }),
      "a root is never published over a broken chain",
    );

    expectEqual(brokenReport?.code, "DEPENDENCY_FAILED", "the export fails instead");
    expectEqual(
      (brokenReport?.cause as Record<string, unknown> | undefined)?.["rule"],
      "audit_chain",
      "naming the chain as the reason",
    );
    expectEqual(
      (brokenReport?.cause as Record<string, unknown> | undefined)?.["broken_sequence"],
      7,
      "and where it broke",
    );

    const emptyRootStore: AuditRpcClient = {
      rpc(functionName) {
        if (functionName === AUDIT_VERIFY_FUNCTION) {
          return Promise.resolve([
            {
              checked_rows: 0,
              is_valid: true,
              first_broken_sequence: null,
              broken_reason: null,
              head_sequence: null,
              head_hash: null,
            },
          ]);
        }

        return Promise.resolve(null);
      },
    };
    const emptyReport = await expectThrowsAsync(
      () => readAuditIntegrityReport({ chainId: auditCompanyId }, { rest: emptyRootStore }),
      "a root over nothing certifies nothing",
    );

    expectEqual(emptyReport?.code, "DEPENDENCY_FAILED", "and the export fails rather than publishing one");
    expectEqual(
      (emptyReport?.cause as Record<string, unknown> | undefined)?.["rule"],
      "audit_root",
      "naming the root as the reason",
    );
}

async function checkAuditWiring(): Promise<void> {
  const source = await readFile(new URL("./audit.ts", import.meta.url), "utf8");
  const authSource = await readFile(new URL("../auth/audit.ts", import.meta.url), "utf8");
  const logs = await readFile(new URL("../../migrations/0013_audit_logs.sql", import.meta.url), "utf8");
  const functions = await readFile(new URL("../../migrations/0075_audit_chain_functions.sql", import.meta.url), "utf8");

  expect(source.includes(`"${AUDIT_NEXT_LINK_FUNCTION}"`), "the writer asks the chain for its head");
  expect(source.includes(`"${AUDIT_HASH_FUNCTION}"`), "and the database for the hash");
  expect(source.includes(`"${AUDIT_VERIFY_FUNCTION}"`), "and verifies a range");
  expect(source.includes(`"${AUDIT_MERKLE_FUNCTION}"`), "and computes its root");
  expectEqual(source.includes("createHash"), false, "the module computes no hash of its own");
  expectEqual(source.includes("node:crypto"), false, "and holds no key: the signature arrives from outside");
  expectEqual(source.includes("process.env"), false, "so it never reads a secret");
  expectEqual(source.includes("from \"../auth"), false, "and depends on nothing in the auth tree");
  expect(source.includes("from \"./rate-limit.ts\""), "an address is the one spelling of STEP 062 rather than a second parser");
  expectEqual(source.split("store.insert(").length - 1, 1, "there is exactly one insert in the module");

  expect(authSource.includes(AUDIT_NEXT_LINK_FUNCTION), "the auth writer asks the same chain");
  expect(authSource.includes(AUDIT_HASH_FUNCTION), "for the same hash");
  expect(authSource.includes(AUDIT_PLATFORM_CHAIN_ID), "and knows the same platform chain");

  expect(
    authSource.indexOf(`"${AUDIT_NEXT_LINK_FUNCTION}"`) < authSource.indexOf(`"${AUDIT_HASH_FUNCTION}"`) &&
      authSource.indexOf(`"${AUDIT_HASH_FUNCTION}"`) < authSource.indexOf(`insert("${AUDIT_TABLE}"`),
    "in the same order: link, hash, insert",
  );
  expectEqual(
    objectKeysAfter(authSource, `rpc("${AUDIT_HASH_FUNCTION}", {`).join(","),
    AUDIT_HASH_ARGUMENTS.join(","),
    "the auth writer passes the same nine hash arguments in the same order",
  );
  expectEqual(
    objectKeysAfter(authSource, `insert("${AUDIT_TABLE}", [`).join(","),
    AUDIT_ROW_FIELDS.join(","),
    "and writes the same sixteen columns",
  );

  expect(
    logs.includes(`action ~ '${AUDIT_ACTION_PATTERN.source.replaceAll("[.]", "\\.")}'`),
    "0013 states the action pattern this module enforces, in the SQL spelling of the same expression",
  );
  expect(logs.includes(`char_length(action) <= ${AUDIT_MAXIMUM_ACTION_LENGTH}`), "and its length");
  expect(logs.includes(`entity_type ~ '${AUDIT_ENTITY_TYPE_PATTERN.source}'`), "and the entity type pattern");
  expect(logs.includes(`char_length(entity_type) <= ${AUDIT_MAXIMUM_ENTITY_TYPE_LENGTH}`), "and its length");
  expect(logs.includes(`octet_length(payload::text) <= ${AUDIT_MAXIMUM_PAYLOAD_BYTES}`), "and the payload ceiling");
  expect(logs.includes("jsonb_typeof(payload) = 'object'"), "the payload is an object");
  expect(logs.includes(`prev_hash ~ '${AUDIT_HASH_PATTERN.source}'`), "the previous hash is a hash");
  expect(logs.includes(`hash ~ '${AUDIT_HASH_PATTERN.source}'`), "and so is the hash");
  expect(logs.includes(`signature ~ '${AUDIT_SIGNATURE_PATTERN.source}'`), "and the signature is a signature");
  expect(logs.includes(`signing_key_id ~ '${AUDIT_SIGNING_KEY_ID_PATTERN.source}'`), "and the key id is one");
  expect(logs.includes(`char_length(user_agent) between 1 and ${AUDIT_MAXIMUM_USER_AGENT_LENGTH}`), "and the user agent ceiling");
  expect(logs.includes("before update or delete on public.audit_logs"), "the table refuses every change after the insert");
  expect(logs.includes("audit_logs_chain_key"), "and one position per chain");
  expect(logs.includes("audit_logs_hash_key"), "and one hash per row");

  expect(functions.includes(`create function public.${AUDIT_NEXT_LINK_FUNCTION}`), "0075 defines the next link");
  expect(functions.includes(`create function public.${AUDIT_HASH_FUNCTION}`), "and the canonical hash");
  expect(functions.includes(`create function public.${AUDIT_VERIFY_FUNCTION}`), "and the chain walk");
  expect(functions.includes(`create function public.${AUDIT_MERKLE_FUNCTION}`), "and the Merkle root");
  expect(functions.includes("repeat('0', 64)"), "the genesis link is the one this module assumes");

  for (const argument of AUDIT_HASH_ARGUMENTS) {
    expect(functions.includes(`  ${argument} `), `audit_hash_v1 takes ${argument}`);
  }

  for (const argument of ["p_chain", "p_from_sequence", "p_to_sequence"]) {
    expect(source.includes(argument), `the module names the ${argument} argument of the range functions`);
  }

  const appRoot = new URL("../../", import.meta.url);
  const entries = (await readdir(appRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => (entry.startsWith("lib/") || entry.startsWith("app/")) && (entry.endsWith(".ts") || entry.endsWith(".tsx")));

  const writers: string[] = [];
  const dottedActions: string[] = [];

  for (const entry of entries) {
    const text = await readFile(new URL(entry, appRoot), "utf8");

    if (
      !entry.endsWith("verify.ts") &&
      (text.includes(`insert("${AUDIT_TABLE}"`) || text.includes("insert(AUDIT_TABLE"))
    ) {
      writers.push(entry);
    }

    for (const match of text.matchAll(/action: "([A-Za-z0-9._-]+)"/gu)) {
      const action = match[1] ?? "";

      if (action.includes(".")) {
        dottedActions.push(action);
      }
    }
  }

  expectEqual(writers.sort().join(","), "lib/auth/audit.ts,lib/security/audit.ts", "exactly two modules append to the chain");
  expect(dottedActions.length >= 30, "the tree writes enough audit actions for the scan to mean something");
  expect(
    dottedActions.every((action) => AUDIT_ACTION_PATTERN.test(action) && action.length <= AUDIT_MAXIMUM_ACTION_LENGTH),
    "and every dotted action in the tree is a name the column accepts",
  );
}

/** The keys of the object literal a call is passed, in source order. */
function objectKeysAfter(source: string, callText: string): readonly string[] {
  const start = source.indexOf(callText);

  if (start < 0) {
    return [];
  }

  const rest = source.slice(start + callText.length);
  const end = rest.search(/^[ \t]*[\]}]/mu);
  const block = end < 0 ? rest : rest.slice(0, end);

  // A row is written with `key: value` and, where the variable has the column's name, with the
  // shorthand `key`, which the database receives identically.
  return [...block.matchAll(/^[ \t]+([a-z_]+)[ \t]*[:,]/gmu)].map((match) => String(match[1]));
}

/** ---- Encryption: one keyring, two envelopes, and the proof that neither can be edited. */

const encryptionKeyOne = { id: "k1", secret: randomBytes(ENCRYPTION_KEY_BYTES).toString("base64") };
const encryptionKeyTwo = { id: "k2", secret: randomBytes(ENCRYPTION_KEY_BYTES).toString("base64") };
const encryptionKeyring = { primary: encryptionKeyOne } as const;
const encryptionSecretContext = { purpose: "secret" as const, scope: "company:018f2b8a:taxcloud" };
const encryptionFileContext = { purpose: "file" as const, scope: "company:018f2b8a:file:018f2b8a" };

function encryptionBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

function flipped(bytes: Uint8Array, offset: number): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const value = copy[offset] ?? 0;

  copy[offset] = (value ^ 0xff) & 0xff;

  return copy;
}

function encryptionReason(error: AppError | null): string {
  const cause = error?.cause;

  return typeof cause === "object" && cause !== null && "reason" in cause
    ? String((cause as Record<string, unknown>)["reason"])
    : "";
}

function checkEncryptionKeys(): void {
  expectEqual(ENCRYPTION_KEY_BYTES, 32, "a key is thirty-two bytes");
  expectEqual(ENCRYPTION_IV_BYTES, 12, "an initialisation vector is twelve");
  expectEqual(ENCRYPTION_TAG_BYTES, 16, "and a tag sixteen");
  expectEqual(ENCRYPTION_SECRET_PREFIX, "kd1", "a stored secret says which envelope it is");
  expectEqual(ENCRYPTION_FILE_MAGIC, "KDF1", "and a stored file says so in its first four bytes");
  expectEqual(ENCRYPTION_AAD_PREFIX, "kd-aad-v1", "the context binding is versioned too");
  expectEqual(
    encryptionAad({ purpose: "secret", scope: "company:1" }).toString("utf8"),
    "kd-aad-v1|secret|company:1",
    "and states the purpose and the scope it binds a value to",
  );
  expectEqual(ENCRYPTION_PURPOSES.join(","), "secret,file", "there are exactly two purposes");
  expect(Object.isFrozen(ENCRYPTION_PURPOSES), "and the list cannot be extended at runtime");
  expectEqual(ENCRYPTION_CHUNK_BYTES, 65_536, "a file is sealed in sixty-four kilobyte chunks");
  expectEqual(
    ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES,
    52_428_800,
    "which is the ceiling the files table also states",
  );
  expectEqual(
    ENCRYPTION_MAXIMUM_ENVELOPE_BYTES,
    ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES +
      64 +
      Math.ceil(ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES / ENCRYPTION_CHUNK_BYTES) * ENCRYPTION_TAG_BYTES,
    "the envelope ceiling allows one tag per chunk and a header",
  );
  expect(
    ENCRYPTION_MAXIMUM_ENVELOPE_BYTES > ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES,
    "and is larger than the plaintext it carries",
  );

  expect(isEncryptionKey(encryptionKeyOne.secret), "a key read from the environment is a key");
  expect(isEncryptionKey(encryptionKeyOne.secret.replace(/=+$/u, "")), "in either base64 spelling");
  expectEqual(isEncryptionKey(randomBytes(31).toString("base64")), false, "thirty-one bytes is not a key");
  expectEqual(isEncryptionKey(randomBytes(33).toString("base64")), false, "nor is thirty-three");
  expectEqual(isEncryptionKey(""), false, "nor is nothing");
  expectEqual(isEncryptionKey("not a key!"), false, "nor is text that is not base64");
  expectEqual(isEncryptionKey(`${randomBytes(32).toString("base64")}AAAA`), false, "nor is a key with something appended");
  expectEqual(isEncryptionKey("A".repeat(42)), false, "nor is a key of the wrong length that still decodes");

  // A forty-three character base64 spelling carries two bits that no byte uses, so the same key has
  // a second spelling. Refusing it is what makes "almost the right key" a boot time failure.
  const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const canonicalKey = encryptionKeyOne.secret.replace(/=+$/u, "");
  const lastCharacter = canonicalKey.at(-1) ?? "";
  const lastIndex = base64Alphabet.indexOf(lastCharacter);
  const secondSpelling = [1, 2, 3]
    .map((delta) => `${canonicalKey.slice(0, -1)}${base64Alphabet[(lastIndex & 0x3c) | ((lastIndex + delta) & 3)] ?? lastCharacter}`)
    .find(
      (candidate) =>
        candidate !== canonicalKey &&
        Buffer.from(candidate, "base64").equals(Buffer.from(canonicalKey, "base64")),
    );

  expect(secondSpelling !== undefined, "a key of thirty-two bytes has a second base64 spelling");
  expectEqual(isEncryptionKey(secondSpelling ?? ""), false, "and that spelling is refused: almost the right key is a wrong key");

  for (const id of ["k1", "audit-v1", "2026-11", "a-b-c-1"]) {
    expect(isEncryptionKeyId(id), `${id} is a key id`);
  }

  for (const id of ["K1", "1", "a", "k_1", "k 1", "k1!", "a".repeat(33), ""]) {
    expectEqual(isEncryptionKeyId(id), false, `${JSON.stringify(id)} is not a key id`);
  }

  const unknownKey = expectThrows(
    () => openSecret(encryptionKeyring, sealSecret({ primary: encryptionKeyTwo }, "value", encryptionSecretContext), encryptionSecretContext),
    "a value sealed with a key the ring does not hold is not opened",
  );

  expectEqual(encryptionReason(unknownKey), "key_unknown", "and the reason is the missing key, not the value");

  expectThrows(
    () =>
      sealSecret(
        { primary: encryptionKeyOne, previous: [encryptionKeyTwo, { id: "k2", secret: encryptionKeyOne.secret }] },
        "value",
        encryptionSecretContext,
      ),
    "two keys with one id is a ring that cannot be resolved",
  );
  expectThrows(
    () => sealSecret({ primary: { id: "k1", secret: "short" } }, "value", encryptionSecretContext),
    "a key that is not thirty-two bytes is refused when it is used",
  );
  expectThrows(
    () => sealSecret({ primary: { id: "K1", secret: encryptionKeyOne.secret } }, "value", encryptionSecretContext),
    "and so is a key id that cannot be stored",
  );
  expectEqual(
    encryptionReason(
      expectThrows(
        () =>
          sealSecret(
            { primary: encryptionKeyOne, previous: Array.from({ length: 16 }, (_, index) => ({ id: `k${index + 10}`, secret: encryptionKeyOne.secret })) },
            "value",
            encryptionSecretContext,
          ),
        "a ring with more keys than a rotation needs is refused rather than searched",
      ),
    ),
    "keyring_invalid",
    "with the ring as the reason",
  );
}

function checkEncryptionSecrets(): void {
  const plaintexts = [
    "",
    "sk_live_9f2c",
    "\u09ac\u09be\u0982\u09b2\u09be \u099f\u09c7\u0995\u09cd\u09b8\u099f",
    "line one\nline two\ttabbed",
    "x".repeat(ENCRYPTION_MAXIMUM_SECRET_BYTES),
  ];

  for (const plaintext of plaintexts) {
    const envelope = sealSecret(encryptionKeyring, plaintext, encryptionSecretContext);

    expectEqual(isSecretEnvelope(envelope), true, "a sealed secret is a secret envelope");
    expectEqual(secretEnvelopeKeyId(envelope), "k1", "which names the key that sealed it");
    expectEqual(envelope.split(".").length, 5, "in five parts");
    expectEqual(envelope.split(".")[0], "kd1", "with the prefix of this format");
    expectEqual(envelope.split(".")[2]?.length, 16, "a twelve byte vector");
    expectEqual(envelope.split(".")[3]?.length, 22, "and a sixteen byte tag");
    expectEqual(openSecret(encryptionKeyring, envelope, encryptionSecretContext), plaintext, "and it opens to what was sealed");
  }

  const tooLarge = expectThrows(
    () => sealSecret(encryptionKeyring, "x".repeat(ENCRYPTION_MAXIMUM_SECRET_BYTES + 1), encryptionSecretContext),
    "a secret larger than a setting is refused",
  );

  expectEqual(encryptionReason(tooLarge), "secret_too_large", "rather than written into a column that cannot hold it");

  const sealed = sealSecret(encryptionKeyring, "same value", encryptionSecretContext);
  const distinct = new Set(Array.from({ length: 20 }, () => sealSecret(encryptionKeyring, "same value", encryptionSecretContext)));

  expectEqual(distinct.size, 20, "the same plaintext never produces the same envelope twice");
  const opens = Array.from({ length: 5 }, () => openSecret(encryptionKeyring, sealed, encryptionSecretContext));

  expect(opens.every((value) => value === "same value"), "and one envelope opens the same way every time");

  const wrongScope = expectThrows(
    () => openSecret(encryptionKeyring, sealed, { purpose: "secret", scope: "company:other:taxcloud" }),
    "an envelope moved to another scope does not open",
  );
  const wrongPurpose = expectThrows(
    () => openSecret(encryptionKeyring, sealed, { purpose: "file", scope: encryptionSecretContext.scope }),
    "nor does one moved to another purpose",
  );

  expectEqual(encryptionReason(wrongScope), "authentication_failed", "and both are the same refusal");
  expectEqual(encryptionReason(wrongPurpose), "authentication_failed", "with no hint which it was");

  const parts = sealed.split(".");
  const rebuild = (index: number, value: string): string => {
    const copy = [...parts];

    copy[index] = value;

    return copy.join(".");
  };

  expectEqual(isSecretEnvelope(rebuild(0, "kd2")), false, "a later format version is not read hopefully");
  expectEqual(isSecretEnvelope(rebuild(1, "K1")), false, "an envelope with an impossible key id is not an envelope");
  expectEqual(isSecretEnvelope(rebuild(2, "short")), false, "nor is one with a short vector");
  expectEqual(isSecretEnvelope(rebuild(3, "short")), false, "nor one with a short tag");
  expectEqual(isSecretEnvelope(rebuild(4, "!!")), false, "nor one whose ciphertext is not base64url");
  expectEqual(isSecretEnvelope(parts.slice(0, 4).join(".")), false, "nor one with a part missing");
  expectEqual(isSecretEnvelope(`v1.${parts.slice(2).join(".")}`), false, "and the format of STEP 045 is not this one");

  for (const index of [2, 3, 4]) {
    const tampered = rebuild(index, `${(parts[index] ?? "").slice(0, -1)}${(parts[index] ?? "").endsWith("A") ? "B" : "A"}`);
    let refused = !isSecretEnvelope(tampered);

    // A part whose spare bits changed is still a well formed envelope and fails the tag; a part that
    // is no longer canonical base64url is refused before a key is chosen. Both are refusals, and the
    // corpus counts one check either way so the gate's total does not depend on a random byte.
    if (!refused) {
      try {
        openSecret(encryptionKeyring, tampered, encryptionSecretContext);
      } catch {
        refused = true;
      }
    }

    expect(refused, `a changed part ${index} is refused, by the shape of the envelope or by its tag`);
  }

  const movedKey = rebuild(1, "k2");
  const movedFailure = expectThrows(
    () => openSecret({ primary: encryptionKeyTwo, previous: [encryptionKeyOne] }, movedKey, encryptionSecretContext),
    "an envelope relabelled with another key of the ring does not open",
  );

  expectEqual(encryptionReason(movedFailure), "authentication_failed", "because the key is not the one that sealed it");

  const rotated = openSecret({ primary: encryptionKeyTwo, previous: [encryptionKeyOne] }, sealed, encryptionSecretContext);

  expectEqual(rotated, "same value", "a ring with the old key as previous still opens what it sealed");
  expectEqual(
    secretEnvelopeKeyId(sealSecret({ primary: encryptionKeyTwo, previous: [encryptionKeyOne] }, "same value", encryptionSecretContext)),
    "k2",
    "and new values are sealed with the new key",
  );

  const contextRefusals: readonly unknown[] = [
    { purpose: "secret", scope: "" },
    { purpose: "secret", scope: "x".repeat(ENCRYPTION_MAXIMUM_SCOPE_LENGTH + 1) },
    { purpose: "secret", scope: "company|x" },
    { purpose: "secret", scope: "company\nx" },
    { purpose: "document", scope: "company:1" },
  ];

  for (const context of contextRefusals) {
    const failure = expectThrows(
      () => sealSecret(encryptionKeyring, "value", context as { purpose: "secret"; scope: string }),
      `the context ${JSON.stringify(context)} cannot name a place`,
    );

    expectEqual(encryptionReason(failure), "context_invalid", "and is refused rather than swapped");
  }
}

function checkEncryptionFiles(): void {
  const sizes = [0, 1, ENCRYPTION_CHUNK_BYTES - 1, ENCRYPTION_CHUNK_BYTES, ENCRYPTION_CHUNK_BYTES + 1, 2 * ENCRYPTION_CHUNK_BYTES + 7];

  for (const size of sizes) {
    const plaintext = encryptionBytes(size);
    const copied = Uint8Array.from(plaintext);
    const envelope = encryptFile(encryptionKeyring, plaintext, encryptionFileContext);
    const info = readFileEnvelopeInfo(envelope);
    const chunks = Math.max(1, Math.ceil(size / ENCRYPTION_CHUNK_BYTES));

    expectEqual(isFileEnvelope(envelope), true, `a sealed file of ${size} bytes is a file envelope`);
    expectEqual(envelope.byteLength, 26 + 2 + size + chunks * ENCRYPTION_TAG_BYTES, `the envelope of ${size} bytes is a header plus one tag per chunk`);
    expectEqual(info?.plaintextBytes, size, `and it states its plaintext size of ${size}`);
    expectEqual(info?.chunkCount, chunks, `in ${chunks} chunks`);
    expectEqual(info?.keyId, "k1", "sealed with the primary key");
    expectEqual(info?.chunkBytes, ENCRYPTION_CHUNK_BYTES, "and the chunk size this build writes");
    expect(sameBytes(decryptFile(encryptionKeyring, envelope, encryptionFileContext), plaintext), `and it opens to the bytes that were sealed (${size})`);
    expect(sameBytes(plaintext, copied), `while the caller's buffer is left alone (${size})`);
    expect(Buffer.from(envelope).toString("utf8", 0, 4) === ENCRYPTION_FILE_MAGIC, "the first four bytes are the magic");
  }

  expectEqual(isFileEnvelope(encryptionBytes(100)), false, "random bytes are not an envelope");
  expectEqual(isFileEnvelope(new Uint8Array(10)), false, "and neither is a short buffer");
  expectEqual(isFileEnvelope(new TextEncoder().encode("KDF1 but not really a file envelope at all")), false, "nor is text that starts with the magic");
  expectEqual(
    readFileEnvelopeInfo(encryptFile(encryptionKeyring, new Uint8Array(0), encryptionFileContext))?.chunkCount,
    1,
    "an empty file is one chunk with no ciphertext",
  );
  expectEqual(
    encryptFile(encryptionKeyring, new Uint8Array(0), encryptionFileContext).byteLength,
    26 + 2 + ENCRYPTION_TAG_BYTES,
    "and its envelope is a header and one tag",
  );

  const plaintext = encryptionBytes(2 * ENCRYPTION_CHUNK_BYTES + 10);
  const envelope = encryptFile(encryptionKeyring, plaintext, encryptionFileContext);
  const header = 26 + 2;
  const firstChunkTag = header;
  const secondChunkTag = header + ENCRYPTION_TAG_BYTES + ENCRYPTION_CHUNK_BYTES;
  const headerEdits: readonly (readonly [string, Uint8Array])[] = [
    ["the magic", (() => { const copy = Uint8Array.from(envelope); copy.set([0x4b, 0x44, 0x46, 0x32], 0); return copy; })()],
    ["the version", (() => { const copy = Uint8Array.from(envelope); copy[4] = 2; return copy; })()],
    ["the chunk size", flipped(envelope, 8)],
    ["the stated size", flipped(envelope, 12)],
  ];

  // The header is part of every chunk's association data, so an edited header would also fail the
  // tag. It is asserted here as a parse refusal, because that is the answer a caller needs: these
  // bytes are not an envelope this build wrote, and no key is looked up to find out.
  for (const [label, edited] of headerEdits) {
    expectEqual(isFileEnvelope(edited), false, `a file whose ${label} was changed is not an envelope`);
    expectEqual(readFileEnvelopeInfo(edited), null, `and has no envelope information for ${label}`);
  }

  const bodyEdits: readonly (readonly [string, Uint8Array])[] = [
    ["the base vector", flipped(envelope, 16)],
    ["the first tag", flipped(envelope, firstChunkTag)],
    ["the first ciphertext byte", flipped(envelope, firstChunkTag + ENCRYPTION_TAG_BYTES)],
    ["the second chunk tag", flipped(envelope, secondChunkTag)],
    ["the last byte", flipped(envelope, envelope.byteLength - 1)],
  ];

  for (const [label, edited] of bodyEdits) {
    const failure = expectThrows(
      () => decryptFile(encryptionKeyring, edited, encryptionFileContext),
      `a file whose ${label} was changed does not open`,
    );

    expectEqual(encryptionReason(failure), "authentication_failed", `${label} fails authentication`);
  }

  const withoutLastByte = envelope.subarray(0, envelope.byteLength - 1);

  expectThrows(
    () => decryptFile(encryptionKeyring, withoutLastByte, encryptionFileContext),
    "a truncated file does not open",
  );
  expectThrows(
    () => decryptFile(encryptionKeyring, envelope.subarray(0, header + ENCRYPTION_TAG_BYTES + ENCRYPTION_CHUNK_BYTES), encryptionFileContext),
    "and neither does one whose last chunk was dropped",
  );
  expectThrows(
    () => decryptFile(encryptionKeyring, Uint8Array.from([...envelope, 0]), encryptionFileContext),
    "nor one with a byte appended",
  );

  const recordBytes = ENCRYPTION_TAG_BYTES + ENCRYPTION_CHUNK_BYTES;
  const swapped = Uint8Array.from(envelope);
  const firstRecord = Uint8Array.from(envelope.subarray(header, header + recordBytes));
  const secondRecord = Uint8Array.from(envelope.subarray(header + recordBytes, header + 2 * recordBytes));

  // Whole records move, not bodies: a body moved without its tag fails for a reason that has nothing
  // to do with position, so only a whole record swap tests what the nonce is carrying.
  secondRecord.forEach((value, index) => {
    swapped[header + index] = value;
  });
  firstRecord.forEach((value, index) => {
    swapped[header + recordBytes + index] = value;
  });

  expect(
    sameBytes(decryptFile(encryptionKeyring, envelope, encryptionFileContext), plaintext),
    "the untouched envelope still opens after the swap was built from it",
  );

  const promoted = Buffer.from(
    Uint8Array.from(envelope.subarray(0, header + ENCRYPTION_TAG_BYTES + ENCRYPTION_CHUNK_BYTES)),
  );

  promoted.writeUInt32BE(ENCRYPTION_CHUNK_BYTES, 12);

  const promotedFailure = expectThrows(
    () => decryptFile(encryptionKeyring, promoted, encryptionFileContext),
    "a file whose last chunk was dropped and whose size was edited to match does not open",
  );

  expectEqual(
    encryptionReason(promotedFailure),
    "authentication_failed",
    "because the chunk that is now last never said it was",
  );

  const giant = new Uint8Array(ENCRYPTION_MAXIMUM_ENVELOPE_BYTES + 1);

  expectEqual(isFileEnvelope(giant), false, "a buffer of the largest size this module could produce is still not an envelope without a header");
  expect(
    giant.byteLength > ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES,
    "and that bound is larger than the plaintext ceiling, because it carries the tags",
  );

  const reordered = expectThrows(
    () => decryptFile(encryptionKeyring, swapped, encryptionFileContext),
    "two whole records in the wrong order do not open, because the nonce carries the position",
  );

  expectEqual(encryptionReason(reordered), "authentication_failed", "as an authentication failure");

  expectThrows(
    () => decryptFile(encryptionKeyring, envelope, { purpose: "file", scope: "company:other:file:1" }),
    "a file envelope moved to another scope does not open",
  );

  const unknownKey = expectThrows(
    () => decryptFile({ primary: encryptionKeyTwo }, envelope, encryptionFileContext),
    "and one sealed with a key the ring does not hold reports the missing key",
  );

  expectEqual(encryptionReason(unknownKey), "key_unknown", "rather than pretending the bytes are wrong");

  const declaredTooLarge = Uint8Array.from(encryptFile(encryptionKeyring, encryptionBytes(4), encryptionFileContext));

  // The stated size lives four bytes after the key id (10 + 2), and 0x04000000 is above the ceiling.
  declaredTooLarge[12] = 0x04;
  declaredTooLarge[13] = 0x00;
  declaredTooLarge[14] = 0x00;
  declaredTooLarge[15] = 0x00;

  expectEqual(isFileEnvelope(declaredTooLarge), false, "a file that claims more bytes than the ceiling allows is not an envelope");

  expectEqual(
    readFileEnvelopeInfo(encryptFile({ primary: encryptionKeyTwo, previous: [encryptionKeyOne] }, encryptionBytes(10), encryptionFileContext))?.keyId,
    "k2",
    "a file sealed during a rotation names the new key",
  );
  expect(
    sameBytes(
      decryptFile({ primary: encryptionKeyTwo, previous: [encryptionKeyOne] }, envelope, encryptionFileContext),
      plaintext,
    ),
    "and the old file still opens through the previous key",
  );
}

async function checkEncryptionWiring(): Promise<void> {
  const source = await readFile(new URL("./encryption.ts", import.meta.url), "utf8");
  const authSecrets = await readFile(new URL("../auth/secrets.ts", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../env/manifest.ts", import.meta.url), "utf8");
  const files = await readFile(new URL("../../migrations/0057_files.sql", import.meta.url), "utf8");

  expect(source.includes('"aes-256-gcm"'), "the module uses AES-256-GCM and nothing else");
  expectEqual(source.split('"aes-256-gcm"').length - 1, 4, "in exactly the four places it must: a cipher and a decipher for each half");
  expect(source.includes('from "node:crypto"'), "the primitive comes from the platform");
  expectEqual(source.includes("process.env"), false, "and the key never comes from the environment here");
  expectEqual(source.includes("console."), false, "nothing is logged, so no plaintext is");
  expectEqual(source.includes("createHash"), false, "this is encryption, not hashing");
  expectEqual(source.includes("export ") && source.includes("decryptFile"), true, "the file half is exported");
  expect(source.split(".fill(0)").length - 1 >= 5, "and every key buffer is zeroed on the way out");
  expectEqual(source.includes("node:fs"), false, "the module touches no file system: it is given bytes");
  expectEqual(source.includes("fetch("), false, "and makes no request");

  expect(authSecrets.includes('"aes-256-gcm"'), "the STEP 045 module still uses the same primitive");
  expect(authSecrets.includes('`v1.'), "with its own prefix");
  expectEqual(source.includes('"v1.'), false, "which this module never writes");
  expectEqual(
    isSecretEnvelope("v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA"),
    false,
    "and never reads as its own",
  );

  const encryptionKey = manifest.slice(manifest.indexOf('name: "ENCRYPTION_MASTER_KEY"'));

  expect(encryptionKey.startsWith('name: "ENCRYPTION_MASTER_KEY"'), "the environment declares the master key");
  expect(encryptionKey.includes('format: "base64Key"'), "as base64");
  expect(encryptionKey.includes("bytes: 32"), "of thirty-two bytes");
  expectEqual(ENCRYPTION_KEY_BYTES, 32, "which is the length this module decodes");
  expect(manifest.includes("Custodian is the CEO"), "and says in one sentence who holds it");

  expect(
    files.includes(`byte_size between 1 and ${ENCRYPTION_MAXIMUM_PLAINTEXT_BYTES}`),
    "the file ceiling is the one the files table states",
  );

  const roots = [new URL("../../lib/", import.meta.url), new URL("../../app/", import.meta.url)];
  const cryptoUsers: string[] = [];

  for (const root of roots) {
    const prefix = root.pathname.endsWith("/lib/") ? "lib/" : "app/";
    const entries = (await readdir(root, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"));

    for (const entry of entries) {
      const text = await readFile(new URL(entry, root), "utf8");

      if (!entry.endsWith("verify.ts") && text.includes("aes-256-gcm")) {
        cryptoUsers.push(`${prefix}${entry}`);
      }
    }
  }

  expectEqual(
    cryptoUsers.sort().join(","),
    "lib/auth/secrets.ts,lib/security/encryption.ts",
    "exactly two modules encrypt anything in this repository",
  );
}

/** ---- Portal tokens: one signed link, an expiry, and a revocation lookup. */

const portalMasterKey = randomBytes(PORTAL_TOKEN_KEY_BYTES).toString("base64");
const portalRetiredKey = randomBytes(PORTAL_TOKEN_KEY_BYTES).toString("base64");
const portalForeignKey = randomBytes(PORTAL_TOKEN_KEY_BYTES).toString("base64");
const portalKeys = { primary: portalMasterKey } as const;
const portalCompanyId = "018f2b8a-0000-4000-8000-0000000000c1";
const portalInvoiceId = "018f2b8a-0000-4000-8000-000000000011";
const portalEstimateId = "018f2b8a-0000-4000-8000-000000000012";
const portalNow = 1_800_000_000;
const portalBase64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The key the gate derives for itself, so the module's derivation is compared with one written twice. */
function portalSigningKey(master: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(master, "base64"), Buffer.alloc(0), PORTAL_TOKEN_SIGNING_INFO, PORTAL_TOKEN_KEY_BYTES),
  );
}

/** A payload this platform's writer would never produce, signed with a real key. */
function forgedPortalToken(payload: string, master: string = portalMasterKey, header: string = "kdpt1"): string {
  const payloadPart = Buffer.from(payload, "utf8").toString("base64url");
  const key = portalSigningKey(master);

  try {
    const signature = createHmac("sha256", key).update(`${header}.${payloadPart}`, "utf8").digest("base64url");

    return `${header}.${payloadPart}.${signature}`;
  } finally {
    key.fill(0);
  }
}

/** A claim the writer would produce, as text, so one field can be changed at a time. */
function portalPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: PORTAL_TOKEN_VERSION,
    kind: "invoice",
    companyId: portalCompanyId,
    resourceId: portalInvoiceId,
    capability: "pay",
    tokenId: "AAAAAAAAAAAAAAAAAAAAAA",
    issuedAt: portalNow,
    expiresAt: portalNow + 3_600,
    ...overrides,
  });
}

function portalMint(overrides: Partial<PortalTokenRequest> = {}, tokenId?: string): string {
  return mintPortalToken(
    {
      kind: "invoice",
      companyId: portalCompanyId,
      resourceId: portalInvoiceId,
      capability: "pay",
      lifetimeSeconds: 3_600,
      ...overrides,
    },
    tokenId === undefined ? { keys: portalKeys, now: portalNow } : { keys: portalKeys, now: portalNow, tokenId },
  );
}

/**
 * The minter with a request the compiler would refuse, because the refusals have to be exercised.
 *
 * A route validates a merchant's choice with Zod first, so these values can only arrive here - and
 * the service has to say no to them rather than trust its caller.
 */
function portalMintUnchecked(overrides: Record<string, unknown>): string {
  return mintPortalToken(
    {
      kind: "invoice",
      companyId: portalCompanyId,
      resourceId: portalInvoiceId,
      capability: "pay",
      lifetimeSeconds: 3_600,
      ...overrides,
    } as PortalTokenRequest,
    { keys: portalKeys, now: portalNow },
  );
}

function portalReason(error: AppError | null): string {
  return encryptionReason(error);
}

/** Why a link did not open, with every refusal described once. */
function portalOpenFailure(token: string, description: string, options: Partial<PortalTokenOpenOptions> = {}): string {
  return portalReason(
    expectThrows(() => openPortalToken(token, { keys: portalKeys, now: portalNow, ...options }), description),
  );
}

/** Another spelling of one base64url part, when its last character has spare bits. */
function secondSpelling(part: string): string | null {
  const bytes = Buffer.from(part, "base64url");
  const head = part.slice(0, -1);

  for (const character of portalBase64Alphabet) {
    const candidate = `${head}${character}`;

    if (candidate !== part && Buffer.from(candidate, "base64url").equals(bytes)) {
      return candidate;
    }
  }

  return null;
}

function checkPortalTokenKeys(): void {
  expectEqual(PORTAL_TOKEN_KEY_BYTES, 32, "a signing key is thirty-two bytes, like every key this platform derives");
  expectEqual(PORTAL_TOKEN_SIGNATURE_BYTES, 32, "the signature is HMAC-SHA-256, so thirty-two");
  expectEqual(PORTAL_TOKEN_ID_BYTES, 16, "a link id is sixteen random bytes");
  expectEqual(PORTAL_TOKEN_PREFIX, "kdpt", "a link announces itself with its own prefix");
  expectEqual(PORTAL_TOKEN_VERSION, 1, "at version one");
  expectEqual(PORTAL_TOKEN_SIGNING_INFO, "kd-portal-token:v1", "and derives its key under its own HKDF info string");
  expectEqual(PORTAL_TOKEN_DIGEST_PREFIX, "kdpd1", "a stored digest is not a link");
  expectEqual(PORTAL_TOKEN_MAXIMUM_PAYLOAD_BYTES, 512, "a payload is bounded before it is parsed, and that bounds the link");
  expectEqual(PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS, 300, "the shortest link lives five minutes");
  expectEqual(PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS, 2_592_000, "the longest lives thirty days");
  expectEqual(PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS / 86_400, 30, "which is thirty days, stated once");
  expectEqual(PORTAL_TOKEN_CLOCK_SKEW_SECONDS, 60, "one minute of clock skew is tolerated, no more");
  expectEqual(PORTAL_TOKEN_MAXIMUM_KEYS, 4, "a rotation may leave three retired keys behind");
  expectEqual(PORTAL_TOKEN_KINDS.join(","), "invoice,estimate,payment_link", "three kinds of link exist");
  expectEqual(PORTAL_TOKEN_CAPABILITIES.join(","), "view,pay,sign", "and three capabilities");
  expectEqual(PORTAL_TOKEN_CAPABILITIES_BY_KIND.invoice.join(","), "view,pay", "an invoice is read and paid");
  expectEqual(PORTAL_TOKEN_CAPABILITIES_BY_KIND.estimate.join(","), "view,sign", "an estimate is read and signed");
  expectEqual(PORTAL_TOKEN_CAPABILITIES_BY_KIND.payment_link.join(","), "view,pay", "a payment link is read and paid");
  expect(Object.isFrozen(PORTAL_TOKEN_KINDS), "the kinds cannot be extended at runtime");
  expect(Object.isFrozen(PORTAL_TOKEN_CAPABILITIES), "nor the capabilities");
  expect(Object.isFrozen(PORTAL_TOKEN_CAPABILITIES_BY_KIND.invoice), "nor the table that pairs them");
  expect(Object.isFrozen(PORTAL_TOKEN_PROBLEMS), "nor the list of refusals");
  expectEqual(PORTAL_TOKEN_PROBLEMS.length, 12, "there are twelve refusals");
  expectEqual(new Set(PORTAL_TOKEN_PROBLEMS).size, 12, "and no two of them are the same word");
  expect(isPortalTokenKind("invoice"), "an invoice is a kind");
  expect(isPortalTokenKind("estimate"), "and so is an estimate");
  expectEqual(isPortalTokenKind("receipt"), false, "a receipt is not");
  expectEqual(isPortalTokenKind(7), false, "and neither is a number");
  expect(isPortalTokenCapability("sign"), "a signature is a capability");
  expectEqual(isPortalTokenCapability("delete"), false, "deleting is not");

  const derived = portalSigningKey(portalMasterKey);
  const retired = portalSigningKey(portalRetiredKey);

  expectEqual(derived.byteLength, 32, "the signing key derived from the master key is thirty-two bytes");
  expectEqual(derived.equals(retired), false, "two master keys derive two signing keys");
  expectEqual(derived.equals(portalSigningKey(portalMasterKey)), true, "and one master key derives one, every time");
  expectEqual(derived.equals(Buffer.from(portalMasterKey, "base64")), false, "the master key itself never signs");

  derived.fill(0);
  retired.fill(0);
}

function checkPortalTokenMint(): void {
  const token = portalMint();
  const parts = token.split(".");

  expectEqual(parts.length, 3, "a link is a header, a payload and a signature");
  expectEqual(parts[0], "kdpt1", "the header names the format and the version");
  expect(
    token.length <= 5 + 1 + Math.ceil(PORTAL_TOKEN_MAXIMUM_PAYLOAD_BYTES / 3) * 4 + 1 + 43,
    "a link is a header, a bounded payload and a signature, and nothing else",
  );
  expectEqual(portalMint() === token, false, "two links for one invoice are two links, because the id is random");

  const claim = openPortalToken(portalMint({}, `${"B".repeat(21)}Q`), { keys: portalKeys, now: portalNow });

  expectEqual(claim.tokenId, `${"B".repeat(21)}Q`, "a caller that writes the row first chooses the link id");
  expectEqual(claim.version, PORTAL_TOKEN_VERSION, "the claim carries its version");
  expectEqual(claim.kind, "invoice", "the kind it was minted for");
  expectEqual(claim.companyId, portalCompanyId, "the company it belongs to");
  expectEqual(claim.resourceId, portalInvoiceId, "the resource it opens");
  expectEqual(claim.capability, "pay", "and what the holder may do");
  expectEqual(claim.issuedAt, portalNow, "the instant it was issued");
  expectEqual(claim.expiresAt, portalNow + 3_600, "and the instant it expires");
  expectEqual(Object.keys(claim).length, 8, "a claim has exactly these eight fields");
  expectEqual(portalTokenDigest(token).startsWith("kdpd1."), true, "a digest says which kind of value it is");

  for (const [kind, capability] of [
    ["invoice", "view"],
    ["invoice", "pay"],
    ["estimate", "sign"],
    ["estimate", "view"],
    ["payment_link", "pay"],
    ["payment_link", "view"],
  ] as const) {
    const minted = portalMint({ kind, capability, resourceId: kind === "estimate" ? portalEstimateId : portalInvoiceId });

    expectEqual(openPortalToken(minted, { keys: portalKeys, now: portalNow }).capability, capability, `${kind} may carry ${capability}`);
  }

  const minimum = portalMint({ lifetimeSeconds: PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS });
  const maximum = portalMint({ lifetimeSeconds: PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS });

  expectEqual(
    openPortalToken(minimum, { keys: portalKeys, now: portalNow }).expiresAt,
    portalNow + PORTAL_TOKEN_MINIMUM_LIFETIME_SECONDS,
    "the shortest lifetime that is allowed is allowed",
  );
  expectEqual(
    openPortalToken(maximum, { keys: portalKeys, now: portalNow + PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS - 1 }).expiresAt,
    portalNow + PORTAL_TOKEN_MAXIMUM_LIFETIME_SECONDS,
    "and the longest survives until its last second",
  );

  for (const lifetimeSeconds of [0, -1, 299, 2_592_001, 3_600.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectEqual(
      portalReason(
        expectThrows(
          () => portalMint({ lifetimeSeconds }),
          `${JSON.stringify(lifetimeSeconds)} is not a lifetime this platform mints`,
        ),
      ),
      "request_invalid",
      `and ${JSON.stringify(lifetimeSeconds)} is a request failure, not a link`,
    );
  }

  for (const [overrides, description] of [
    [{ kind: "receipt" }, "an unknown kind"],
    [{ capability: "delete" }, "an unknown capability"],
    [{ kind: "invoice", capability: "sign" }, "an invoice that may be signed"],
    [{ kind: "estimate", capability: "pay", resourceId: portalEstimateId }, "an estimate that may be paid"],
    [{ companyId: "not-a-uuid" }, "a company id that is not a uuid"],
    [{ resourceId: "" }, "an empty resource id"],
    [{ companyId: portalCompanyId.toUpperCase() }, "an upper case uuid"],
  ] as readonly (readonly [Record<string, unknown>, string])[]) {
    expectEqual(
      portalReason(expectThrows(() => portalMintUnchecked(overrides), `${description} is refused when a link is minted`)),
      "request_invalid",
      `and ${description} is a request failure`,
    );
  }

  for (const tokenId of ["A".repeat(21), "A".repeat(23), "AAAAAAAAAAAAAAAAAAAAAB", "not a link id at all!"]) {
    expectEqual(
      portalReason(expectThrows(() => portalMint({}, tokenId), `${JSON.stringify(tokenId)} is not a link id`)),
      "request_invalid",
      `and ${JSON.stringify(tokenId)} cannot be minted into a link`,
    );
  }

  expectEqual(
    portalReason(
      expectThrows(
        () => mintPortalToken(
          { kind: "invoice", companyId: portalCompanyId, resourceId: portalInvoiceId, capability: "pay", lifetimeSeconds: 3_600 },
          { keys: { primary: randomBytes(31).toString("base64") }, now: portalNow },
        ),
        "a master key that is not thirty-two bytes mints nothing",
      ),
    ),
    "key_invalid",
    "which is a key failure",
  );
  expectEqual(
    portalReason(
      expectThrows(
        () => mintPortalToken(
          { kind: "invoice", companyId: portalCompanyId, resourceId: portalInvoiceId, capability: "pay", lifetimeSeconds: 3_600 },
          { keys: { primary: portalMasterKey, previous: [portalRetiredKey, portalForeignKey, portalRetiredKey] }, now: portalNow },
        ),
        "the same master key twice in one ring is a ring that cannot be resolved",
      ),
    ),
    "keyring_invalid",
    "which is a ring failure",
  );
  expectEqual(
    portalReason(
      expectThrows(
        () => mintPortalToken(
          { kind: "invoice", companyId: portalCompanyId, resourceId: portalInvoiceId, capability: "pay", lifetimeSeconds: 3_600 },
          {
            keys: {
              primary: portalMasterKey,
              previous: [portalRetiredKey, portalForeignKey, randomBytes(32).toString("base64"), randomBytes(32).toString("base64")],
            },
            now: portalNow,
          },
        ),
        "a ring larger than a rotation needs is refused rather than searched",
      ),
    ),
    "keyring_invalid",
    "with the ring as the reason",
  );
  expectEqual(
    portalReason(
      expectThrows(
        () =>
          mintPortalToken(
            { kind: "invoice", companyId: portalCompanyId, resourceId: portalInvoiceId, capability: "pay", lifetimeSeconds: 3_600 },
            { keys: portalKeys, now: 1.5 },
          ),
        "a clock that is not a whole second mints nothing",
      ),
    ),
    "request_invalid",
    "and that is a request failure",
  );
  expectEqual(
    portalReason(
      expectThrows(
        () =>
          mintPortalToken(
            { kind: "invoice", companyId: portalCompanyId, resourceId: portalInvoiceId, capability: "pay", lifetimeSeconds: 3_600 },
            { keys: portalKeys, now: 4_102_444_800 - 100 },
          ),
        "a link that would expire past the range of a timestamp is refused",
      ),
    ),
    "request_invalid",
    "rather than written with an expiry it cannot name",
  );

  const mintedByPrimary = portalMint();

  expectEqual(
    portalOpenFailure(mintedByPrimary, "a link minted by the primary key does not open with a retired one", {
      keys: { primary: portalForeignKey },
    }),
    "signature_invalid",
    "the primary key is the only one that mints",
  );
  expectEqual(
    openPortalToken(mintedByPrimary, { keys: { primary: portalForeignKey, previous: [portalMasterKey] }, now: portalNow }).kind,
    "invoice",
    "while a retired key still verifies what it signed during a rotation",
  );
}

function checkPortalTokenOpen(): void {
  const token = portalMint({ lifetimeSeconds: 3_600 });

  expectEqual(openPortalToken(token, { keys: portalKeys, now: portalNow + 3_599 }).kind, "invoice", "a link opens until its last second");
  expectEqual(portalOpenFailure(token, "a link does not open at the instant it expires", { now: portalNow + 3_600 }), "token_expired", "and not at the instant it expires");
  expectEqual(portalOpenFailure(token, "a link does not open after it expires", { now: portalNow + 90_000 }), "token_expired", "nor afterwards");

  const future = forgedPortalToken(portalPayload({ issuedAt: portalNow + 61, expiresAt: portalNow + 61 + 3_600 }));

  expectEqual(
    portalOpenFailure(future, "a link issued further ahead than the skew is not yet valid"),
    "token_not_yet_valid",
    "a link issued in the future is refused until the skew covers it",
  );
  expectEqual(
    openPortalToken(forgedPortalToken(portalPayload({ issuedAt: portalNow + 60, expiresAt: portalNow + 60 + 3_600 })), {
      keys: portalKeys,
      now: portalNow,
    }).kind,
    "invoice",
    "and one minute of skew is tolerated",
  );

  const [header = "", payloadPart = "", signaturePart = ""] = token.split(".");
  const editedPayload = `${payloadPart.slice(0, 10)}${payloadPart[10] === "A" ? "B" : "A"}${payloadPart.slice(11)}`;

  expectEqual(
    portalOpenFailure(`${header}.${editedPayload}.${signaturePart}`, "one edited payload character is refused"),
    "signature_invalid",
    "an edited payload fails the signature",
  );
  expectEqual(
    portalOpenFailure(`${header}.${payloadPart}.${secondSpelling(signaturePart) ?? signaturePart}`, "a second spelling of the signature is refused"),
    "token_invalid",
    "a signature with spare bits set in its last character is not the signature this platform wrote",
  );
  expectEqual(
    portalOpenFailure(`${header}.${payloadPart}.${portalMint().split(".")[2] ?? ""}`, "a signature from another link is refused"),
    "signature_invalid",
    "a signature belongs to the payload it was computed over",
  );

  const payloadOnlySignature = (() => {
    const key = portalSigningKey(portalMasterKey);
    const signature = createHmac("sha256", key).update(payloadPart, "utf8").digest("base64url");

    key.fill(0);

    return signature;
  })();

  expectEqual(
    portalOpenFailure(`${header}.${payloadPart}.${payloadOnlySignature}`, "a signature that does not cover the header is refused"),
    "signature_invalid",
    "the header is signed too, so a token cannot be relabelled",
  );

  expectEqual(portalOpenFailure(`kdpt2.${payloadPart}.${signaturePart}`, "a link of a later version is refused as such"), "token_version", "a later version is named rather than forged");
  expectEqual(portalOpenFailure(`kdpt01.${payloadPart}.${signaturePart}`, "a version written with a leading zero is not this version"), "token_version", "and a spelled out version is not this one either");
  expectEqual(portalOpenFailure(`KDPT1.${payloadPart}.${signaturePart}`, "an upper case header is not a header"), "token_invalid", "the format is one case");

  for (const [broken, description] of [
    ["", "an empty string"],
    [".", "a single dot"],
    [`${header}.${payloadPart}`, "two parts instead of three"],
    [`${header}.${payloadPart}.${signaturePart}.extra`, "four parts instead of three"],
    [`${header}..${signaturePart}`, "an empty payload"],
    [`${header}.${payloadPart}.`, "an empty signature"],
    [`${header}.${payloadPart}!.${signaturePart}`, "a payload character that is not base64url"],
    [`${header}.${payloadPart}.${signaturePart}!`, "a signature character that is not base64url"],
    [forgedPortalToken("not json at all"), "a payload that is not JSON"],
    ["x".repeat(2_000), "a string longer than a link"],
  ] as const) {
    expectEqual(portalOpenFailure(broken, `${description} is not a link`), "token_invalid", `${description} is refused as malformed`);
  }

  expectEqual(
    portalOpenFailure(`${header}.${payloadPart}.${Buffer.from(Buffer.from(signaturePart, "base64url").subarray(0, 31)).toString("base64url")}`, "a thirty-one byte signature is refused"),
    "token_invalid",
    "a signature is exactly thirty-two bytes",
  );
  expectEqual(
    portalOpenFailure(`${header}.${payloadPart}.${Buffer.concat([Buffer.from(signaturePart, "base64url"), Buffer.from([0])]).toString("base64url")}`, "a thirty-three byte signature is refused"),
    "token_invalid",
    "neither longer nor shorter",
  );

  for (const [payload, description, reason] of [
    [portalPayload({ version: 2 }), "a payload that says version two", "token_invalid"],
    [portalPayload({ kind: "receipt" }), "an unknown kind", "token_invalid"],
    [portalPayload({ capability: "delete" }), "an unknown capability", "token_invalid"],
    [portalPayload({ kind: "invoice", capability: "sign" }), "an invoice that may be signed", "token_invalid"],
    [portalPayload({ companyId: "not-a-uuid" }), "a company id that is not a uuid", "token_invalid"],
    [portalPayload({ resourceId: portalCompanyId.toUpperCase() }), "an upper case uuid", "token_invalid"],
    [portalPayload({ tokenId: "A".repeat(21) }), "a link id of the wrong length", "token_invalid"],
    [portalPayload({ tokenId: "AAAAAAAAAAAAAAAAAAAAAB" }), "a link id in its second spelling", "token_invalid"],
    [JSON.stringify({ ...JSON.parse(portalPayload()) as Record<string, unknown>, extra: "field" }), "a claim with an extra field", "token_invalid"],
    [JSON.stringify({ version: 1, kind: "invoice" }), "a claim missing six fields", "token_invalid"],
    [portalPayload({ issuedAt: "1800000000" }), "a timestamp as a string", "token_invalid"],
    [portalPayload({ issuedAt: 1_800_000_000.5 }), "a timestamp with a fraction", "token_invalid"],
    [portalPayload({ expiresAt: portalNow - 1 }), "an expiry before the issue", "lifetime_invalid"],
    [portalPayload({ expiresAt: portalNow }), "an expiry at the issue", "lifetime_invalid"],
    [portalPayload({ expiresAt: portalNow + 299 }), "a lifetime below the floor", "lifetime_invalid"],
    [portalPayload({ expiresAt: portalNow + 2_592_001 }), "a lifetime above the ceiling", "lifetime_invalid"],
  ] as const) {
    expectEqual(portalOpenFailure(forgedPortalToken(payload), `${description} is refused`), reason, `a signed ${description} is refused as ${reason}`);
  }

  const reordered = JSON.stringify(
    (({ tokenId, kind, capability, companyId, resourceId, issuedAt, expiresAt }) => ({
      tokenId,
      kind,
      capability,
      companyId,
      resourceId,
      issuedAt,
      expiresAt,
      version: 1,
    }))(JSON.parse(portalPayload()) as Record<string, never>),
  );

  expectEqual(
    portalOpenFailure(forgedPortalToken(reordered), "a claim in another field order is refused"),
    "token_invalid",
    "one payload has one spelling, so one link has one signature",
  );
  expectEqual(
    portalOpenFailure(forgedPortalToken(` ${portalPayload()}`), "a claim with leading whitespace is refused"),
    "token_invalid",
    "and whitespace is a second spelling too",
  );
  expectEqual(
    portalOpenFailure(forgedPortalToken(portalPayload({ padding: "x".repeat(600) })), "a payload past the ceiling is refused"),
    "payload_too_large",
    "a payload is bounded before it is parsed, and says so",
  );

  expectEqual(openPortalToken(token, { keys: portalKeys, now: portalNow, expect: { kind: "invoice" } }).kind, "invoice", "a reader may require the kind it expected");
  expectEqual(
    openPortalToken(token, {
      keys: portalKeys,
      now: portalNow,
      expect: { kind: "invoice", companyId: portalCompanyId, resourceId: portalInvoiceId, capability: "pay" },
    }).resourceId,
    portalInvoiceId,
    "and every claim it was promised",
  );

  for (const [expectation, description] of [
    [{ kind: "estimate" }, "another kind"],
    [{ companyId: "018f2b8a-0000-4000-8000-0000000000ff" }, "another company"],
    [{ resourceId: portalEstimateId }, "another resource"],
    [{ capability: "view" }, "another capability"],
  ] as const) {
    expectEqual(portalOpenFailure(token, `${description} in the expectation does not match`, { expect: expectation }), "audience_mismatch", `a link does not open when ${description} was expected`);
  }

  expectEqual(portalOpenFailure(token, "a foreign key does not open a link", { keys: { primary: portalForeignKey } }), "signature_invalid", "a link opens only with the key that signed it");
  expectEqual(
    portalOpenFailure(token, "a ring larger than a rotation needs opens nothing", {
      keys: {
        primary: portalMasterKey,
        previous: [portalRetiredKey, portalForeignKey, randomBytes(32).toString("base64"), randomBytes(32).toString("base64")],
      },
    }),
    "keyring_invalid",
    "the ring is refused before the token is read",
  );
  expectEqual(portalOpenFailure(token, "a ring with one key twice opens nothing", { keys: { primary: portalMasterKey, previous: [portalMasterKey] } }), "keyring_invalid", "nor is a duplicated ring resolved");
  expectEqual(portalOpenFailure(token, "a short master key opens nothing", { keys: { primary: "AAAA" } }), "key_invalid", "and a key of the wrong length is a key failure");
  expectEqual(
    expectThrows(() => openPortalToken(token, { keys: portalKeys, now: 1.5 }), "a clock that is not a whole second opens nothing")?.code,
    "INTERNAL_ERROR",
    "a caller's bad clock is this platform's failure, not the visitor's",
  );
  expectEqual(
    expectThrows(() => openPortalToken(token, { keys: portalKeys, now: portalNow + 3_600 }), "an expired link")?.code,
    "RESOURCE_NOT_FOUND",
    "while a link that does not open is the visitor's not found, whatever the reason",
  );
  expectEqual(
    expectThrows(() => openPortalToken(token, { keys: portalKeys, now: portalNow + 3_600 }), "an expired link")?.status,
    404,
    "with the status of a page that is not there",
  );

  const first = portalMint({}, `${"C".repeat(21)}Q`);
  const second = portalMint({}, `${"D".repeat(21)}Q`);

  expectEqual(portalTokenDigest(first) === portalTokenDigest(first), true, "a digest is the same every time it is computed");
  expectEqual(portalTokenDigest(first) === portalTokenDigest(second), false, "two links have two digests");
  expectEqual(portalTokenDigest(first).length, PORTAL_TOKEN_DIGEST_PREFIX.length + 1 + 43, "a digest is a prefix and one SHA-256 in base64url");
  expectEqual(portalTokenDigest(first).includes(first.slice(6, 60)), false, "and it does not carry the link it names");
  expectEqual(
    portalReason(expectThrows(() => portalTokenDigest("not a link"), "a string that is not a link has no digest")),
    "token_invalid",
    "so only something this platform could have written is named",
  );
  expectEqual(
    portalReason(expectThrows(() => portalTokenDigest(`${first.split(".")[0]}.${first.split(".")[1]}`), "a link without a signature has no digest")),
    "token_invalid",
    "and a link without its signature is not one",
  );
}

function checkPortalTokenRevocation(): void {
  const token = portalMint({}, `${"E".repeat(21)}Q`);
  const other = portalMint({}, `${"F".repeat(21)}Q`);
  const seen: string[] = [];
  const revocations = {
    isRevoked: (tokenId: string): boolean => {
      seen.push(tokenId);

      return tokenId === `${"E".repeat(21)}Q`;
    },
  };

  expectEqual(openPortalToken(other, { keys: portalKeys, now: portalNow, revocations }).tokenId, `${"F".repeat(21)}Q`, "a link that was not revoked opens");
  expectEqual(seen.join(","), `${"F".repeat(21)}Q`, "and the lookup is asked about that link's id alone");
  expectEqual(portalOpenFailure(token, "a revoked link is refused", { revocations }), "token_revoked", "a revoked link is refused");
  expectEqual(seen.at(-1), `${"E".repeat(21)}Q`, "with the id the caller minted");

  const quiet = { calls: 0, isRevoked: (): boolean => { quiet.calls += 1; return true; } };
  const [header = "", payloadPart = "", signaturePart = ""] = token.split(".");
  const edited = `${header}.${payloadPart.slice(0, 10)}${payloadPart[10] === "A" ? "B" : "A"}${payloadPart.slice(11)}.${signaturePart}`;

  expectEqual(portalOpenFailure(edited, "an edited link is refused before the lookup", { revocations: quiet }), "signature_invalid", "an edited link never reaches the revocation store");
  expectEqual(quiet.calls, 0, "so the store is not a probe for which ids exist");
  expectEqual(portalOpenFailure(token, "an expired link is refused before the lookup is believed", { now: portalNow + 3_600, revocations: quiet }), "token_expired", "an expired link is refused by the clock");
  expectEqual(quiet.calls, 0, "and the store is not asked about a link that is out of date");
  expectEqual(portalOpenFailure(token, "a link with a foreign key is refused before the lookup", { keys: { primary: portalForeignKey }, revocations: quiet }), "signature_invalid", "a foreign signature is refused");
  expectEqual(quiet.calls, 0, "and the store is not asked about a link that platform never signed");

  expectEqual(openPortalToken(token, { keys: portalKeys, now: portalNow }).tokenId, `${"E".repeat(21)}Q`, "a link opens when the caller offers no revocation list");
}

async function checkPortalTokenWiring(): Promise<void> {
  const source = await readFile(new URL("./portal-token.ts", import.meta.url), "utf8");

  expect(source.includes('from "node:crypto"'), "the primitives come from the platform");
  expect(source.includes("createHmac"), "the signature is an HMAC");
  expect(source.includes("hkdfSync"), "the key is derived from the master key, never read from the environment");
  expectEqual(source.includes("timingSafeEqual"), true, "and compared in constant time");
  expectEqual(source.split("timingSafeEqual").length - 1, 2, "once in the import and once in the comparison");
  expectEqual(source.includes("process.env"), false, "the module reads no environment variable itself");
  expectEqual(source.includes("console."), false, "and logs nothing, so no link reaches a log");
  expectEqual(source.includes("fetch("), false, "and makes no request");
  expectEqual(source.includes("createCipheriv"), false, "a link is signed, not encrypted: it carries nothing secret");
  expectEqual(source.includes("createDecipheriv"), false, "and nothing is decrypted to read it");
  expect(source.includes("readonly now: number"), "the clock is passed in, so the gate can stand on the boundary");
  expectEqual(source.includes("new Date("), false, "no date is formatted either");
  expectEqual(source.includes("Math.random"), false, "and the link id comes from the platform's random source");
  expectEqual(source.includes("setCookie"), false, "a link is not a session: it sets nothing");
  expect(source.includes('from "./encryption.ts"'), "it asks the encryption module for the key format and the canonical base64 rule");
  expect(source.includes("decodeCanonicalBase64Url"), "so there is one canonical rule in the tree");
  expect(source.includes("isEncryptionKey"), "and one definition of a thirty-two byte key");
  expect(source.split(".fill(0)").length - 1 >= 2, "every derived key is wiped on the way out");
  expectEqual(source.includes("supabase"), false, "the module asks no database: the revocation lookup is the caller's");
  expectEqual(source.includes('from "../auth/'), false, "and borrows nothing from the authentication tree");
  expect(source.includes("strict()"), "the payload schema refuses a field the signature covers and no reader uses");

  const importCount = source.split('import {').length - 1;

  expectEqual(importCount, 6, "the module imports six things: a buffer, the primitives, the schema, the errors, the freeze helper and the encryption module");

  for (const problem of PORTAL_TOKEN_PROBLEMS) {
    expect(source.includes(`"${problem}"`), `${problem} is a reason this module can give`);
  }

  const roots = [new URL("../../lib/", import.meta.url), new URL("../../app/", import.meta.url)];
  const signingUsers: string[] = [];

  for (const root of roots) {
    const prefix = root.pathname.endsWith("/lib/") ? "lib/" : "app/";
    const entries = (await readdir(root, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"));

    for (const entry of entries) {
      const text = await readFile(new URL(entry, root), "utf8");

      if (!entry.endsWith("verify.ts") && text.includes(PORTAL_TOKEN_SIGNING_INFO)) {
        signingUsers.push(`${prefix}${entry}`);
      }
    }
  }

  expectEqual(signingUsers.sort().join(","), "lib/security/portal-token.ts", "exactly one module derives the portal signing key");

  const tokenUsers: string[] = [];

  for (const root of roots) {
    const prefix = root.pathname.endsWith("/lib/") ? "lib/" : "app/";
    const entries = (await readdir(root, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"));

    for (const entry of entries) {
      const text = await readFile(new URL(entry, root), "utf8");

      if (!entry.endsWith("verify.ts") && text.includes(`${PORTAL_TOKEN_PREFIX}${PORTAL_TOKEN_VERSION}.`)) {
        tokenUsers.push(`${prefix}${entry}`);
      }
    }
  }

  expectEqual(tokenUsers.sort().join(","), "lib/security/portal-token.ts", "and exactly one module writes a link");
}

/** ---- Fraud: five sentences of section 18, six signals, one decision. */

const fraudCompanyId = "018f2b8a-0000-4000-8000-0000000000c2";
const fraudPaymentId = "018f2b8a-0000-4000-8000-0000000000d2";
const fraudActorId = "018f2b8a-0000-4000-8000-0000000000e2";
const fraudFingerprint = "0123456789abcdef".repeat(4);
const fraudOtherFingerprint = "fedcba9876543210".repeat(4);
const fraudIpAddress = "203.0.113.9";

function fraudAttempt(overrides: Partial<FraudAttempt> = {}): FraudAttempt {
  return {
    companyId: fraudCompanyId,
    amountMinor: 4_999n,
    currency: "USD",
    paymentMethod: "card",
    providerSignal: "clear",
    threeDsOutcome: "authenticated",
    postalCodeMatched: false,
    ipCountryMatched: false,
    cardFingerprint: fraudFingerprint,
    ipAddress: fraudIpAddress,
    ...overrides,
  };
}

interface FraudLookupCalls {
  readonly fingerprints: string[];
  readonly subjects: FraudVelocitySubject[];
}

function fraudLookups(
  options: {
    readonly blocked?: boolean;
    readonly card?: FraudVelocityReading;
    readonly ip?: FraudVelocityReading;
    readonly calls?: FraudLookupCalls;
    readonly blacklist?: () => Promise<boolean>;
    readonly velocity?: (subject: FraudVelocitySubject) => Promise<FraudVelocityReading>;
  } = {},
): FraudSignalLookups {
  return {
    isCardBlocked: async (fingerprint: string): Promise<boolean> => {
      options.calls?.fingerprints.push(fingerprint);

      return options.blacklist === undefined ? options.blocked ?? false : options.blacklist();
    },
    readVelocity: async (subject: FraudVelocitySubject): Promise<FraudVelocityReading> => {
      options.calls?.subjects.push(subject);

      if (options.velocity !== undefined) {
        return options.velocity(subject);
      }

      return subject.kind === "card" ? options.card ?? { hits: 1, limit: 4 } : options.ip ?? { hits: 1, limit: 9 };
    },
  };
}

async function fraudDecide(
  overrides: Partial<FraudAttempt> = {},
  options: { readonly policy?: FraudPolicy; readonly lookups?: FraudSignalLookups } = {},
): Promise<FraudDecision> {
  const lookups = options.lookups ?? fraudLookups();

  return options.policy === undefined
    ? evaluateFraudSignals(fraudAttempt(overrides), { lookups })
    : evaluateFraudSignals(fraudAttempt(overrides), { lookups, policy: options.policy });
}

/** One refusal of an attempt, counted whether or not it was refused. */
async function expectFraudRefusal(
  overrides: Partial<FraudAttempt>,
  description: string,
  options: { readonly policy?: FraudPolicy; readonly lookups?: FraudSignalLookups } = {},
): Promise<AppError | null> {
  checks += 1;

  try {
    await fraudDecide(overrides, options);
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }

    failures.push(`${description} (the rejection must be an AppError)`);

    return null;
  }

  failures.push(`${description} (nothing was rejected)`);

  return null;
}

function fraudSignalsOf(decision: FraudDecision): string {
  return decision.signals.map((result) => `${result.signal}:${result.outcome}`).join(",");
}

function checkFraudVocabulary(): void {
  expectEqual(FRAUD_RULE, "fraud", "the module states the rule a failure came from");
  expectEqual(FRAUD_CURRENCY, "USD", "the platform charges in dollars, so a threshold is a number of cents");
  expectEqual(FRAUD_AUDIT_ACTION, "payment.fraud_evaluated", "a decision that is not an allow is audited as one action");
  expect(AUDIT_ACTION_PATTERN.test(FRAUD_AUDIT_ACTION), "and that action is in the shape the audit table stores");
  expect(AUDIT_ACTION_PATTERN.test("payment.fraud_evaluated"), "which the pattern agrees with");
  expect(FRAUD_AUDIT_ACTION.length <= AUDIT_MAXIMUM_ACTION_LENGTH, "and inside the action ceiling");
  expectEqual(FRAUD_FAILURE_CODE, "risk_rejected", "a rejected payment carries one failure code");
  expectEqual(FRAUD_FAILURE_CODE.length <= 64, true, "which fits `payments_failure_code_check`");
  expectEqual(FRAUD_FAILURE_CODE.trim(), FRAUD_FAILURE_CODE, "and is already trimmed, as that check requires");
  expectEqual(FRAUD_PROVIDER_SIGNALS.join(","), "clear,suspicious,fraud", "a provider says one of three things");
  expectEqual(FRAUD_THREE_DS_OUTCOMES.join(","), "authenticated,attempted,not_completed,not_requested", "3D Secure has four outcomes");
  expectEqual(FRAUD_PAYMENT_METHODS.join(","), "card,bank_transfer,e_wallet", "and a payment has three methods");
  expectEqual(
    FRAUD_SIGNALS.join(","),
    "provider_signal,card_blacklist,card_velocity,ip_velocity,three_ds_verification,amount_review",
    "six signals are evaluated, in this order",
  );
  expectEqual(FRAUD_OUTCOMES.join(","), "clear,review,reject", "a signal clears, reviews or rejects");
  expectEqual(FRAUD_DECISIONS.join(","), "allow,review,reject", "and the decision is the three words the payments table stores");
  expectEqual(FRAUD_DETAILS.length, 15, "there are fifteen details a signal may report");
  expectEqual(new Set(FRAUD_DETAILS).size, 15, "and no two of them are the same word");
  expectEqual(FRAUD_DETAILS.every((detail) => /^[a-z]+(_[a-z]+)*$/u.test(detail)), true, "every detail is lower case words and nothing else");
  expectEqual(FRAUD_DETAILS.every((detail) => !/[0-9]/u.test(detail)), true, "so no detail can carry a number, an amount or a count");
  expectEqual(FRAUD_PROBLEMS.join(","), "attempt_invalid,policy_invalid,lookup_failed", "three things can stop an evaluation");
  expectEqual(FRAUD_DEFAULT_POLICY.reviewAmountMinor, 1_000_000n, "ten thousand dollars is the default hold threshold");
  expect(Object.isFrozen(FRAUD_DEFAULT_POLICY), "and the default cannot be changed at runtime");
  expect(Object.isFrozen(FRAUD_SIGNALS), "the signal list cannot be extended");
  expect(Object.isFrozen(FRAUD_DETAILS), "nor the vocabulary");
  expect(Object.isFrozen(FRAUD_DECISIONS), "nor the decision words");
  expectEqual(FRAUD_VELOCITY_LIMIT_MINIMUM, 1, "a velocity limit is at least one, the floor the counter table states");

  expectEqual(FRAUD_CARD_FINGERPRINT_PATTERN.test(fraudFingerprint), true, "a sixty-four character hex fingerprint is one");
  expectEqual(FRAUD_CARD_FINGERPRINT_PATTERN.test(fraudFingerprint.toUpperCase()), false, "an upper case one is not");
  expectEqual(FRAUD_CARD_FINGERPRINT_PATTERN.test(fraudFingerprint.slice(0, 63)), false, "nor is sixty-three characters");
  expectEqual(FRAUD_CARD_FINGERPRINT_PATTERN.test(`${fraudFingerprint}0`), false, "nor sixty-five");
  expectEqual(FRAUD_CARD_FINGERPRINT_PATTERN.test("0".repeat(64)), true, "and a fingerprint may begin with a zero");

  expectEqual(isFraudProviderSignal("fraud"), true, "a provider fraud signal is one");
  expectEqual(isFraudProviderSignal("blocked"), false, "and an invented verdict is not");
  expectEqual(isFraudProviderSignal(1), false, "nor is a number");
  expectEqual(isFraudThreeDsOutcome("not_completed"), true, "a 3DS outcome that failed is one");
  expectEqual(isFraudThreeDsOutcome("declined"), false, "and a word the table does not store is not");
  expectEqual(isFraudPaymentMethod("bank_transfer"), true, "a bank transfer is a method");
  expectEqual(isFraudPaymentMethod("crypto"), false, "and an unsupported method is not");

  for (const outcome of FRAUD_THREE_DS_OUTCOMES) {
    for (const [postalCodeMatched, ipCountryMatched] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const expected = outcome === "authenticated" || (postalCodeMatched && ipCountryMatched);

      expectEqual(
        threeDsVerified({ threeDsOutcome: outcome, postalCodeMatched, ipCountryMatched }),
        expected,
        `${outcome} with postal ${postalCodeMatched} and country ${ipCountryMatched} is ${expected ? "verified" : "unverified"}`,
      );
    }
  }

  const clear = { signal: "amount_review", outcome: "clear", detail: "amount_within_limits" } as const;
  const review = { signal: "ip_velocity", outcome: "review", detail: "ip_over_limit" } as const;
  const reject = { signal: "provider_signal", outcome: "reject", detail: "provider_fraud" } as const;

  expectEqual(fraudDecisionOf([]), "allow", "no signal at all is an allow");
  expectEqual(fraudDecisionOf([clear]), "allow", "a clear signal is an allow");
  expectEqual(fraudDecisionOf([review]), "review", "one review is a review");
  expectEqual(fraudDecisionOf([reject]), "reject", "one reject is a reject");
  expectEqual(fraudDecisionOf([clear, review]), "review", "a review among clears is a review");
  expectEqual(fraudDecisionOf([review, reject]), "reject", "and a reject outranks a review whatever the order");
  expectEqual(fraudDecisionOf([reject, review, clear]), "reject", "the highest outcome wins");
  expectEqual(fraudDecisionOf([clear, clear, clear]), "allow", "and clears alone are an allow");
}

async function checkFraudAttempts(): Promise<void> {
  const decision = await fraudDecide();

  expectEqual(decision.decision, "allow", "an ordinary authenticated card payment is allowed");
  expectEqual(decision.captureAllowed, true, "and may be captured now");
  expectEqual(decision.reasons.length, 0, "with nothing to report");
  expectEqual(
    fraudSignalsOf(decision),
    "provider_signal:clear,card_blacklist:clear,card_velocity:clear,ip_velocity:clear,three_ds_verification:clear,amount_review:clear",
    "every signal is evaluated and cleared",
  );
  expectEqual(decision.signals.length, FRAUD_SIGNALS.length, "the trace names every signal once");
  expectEqual(decision.signals.map((result) => result.signal).join(","), FRAUD_SIGNALS.join(","), "in the declared order");
  expect(Object.isFrozen(decision), "the decision cannot be edited by a caller");
  expect(Object.isFrozen(decision.signals), "nor its trace");

  for (const [overrides, description] of [
    [{ companyId: "not-a-uuid" }, "a company id that is not a uuid"],
    [{ currency: "EUR" }, "a currency that is not dollars"],
    [{ currency: "usd" }, "a currency in lower case"],
    [{ amountMinor: 0n }, "an amount of zero"],
    [{ amountMinor: -1n }, "a negative amount"],
    [{ amountMinor: 5 as unknown as bigint }, "an amount that is not a bigint"],
    [{ paymentMethod: "crypto" as FraudAttempt["paymentMethod"] }, "an unsupported payment method"],
    [{ providerSignal: "blocked" as FraudAttempt["providerSignal"] }, "an invented provider verdict"],
    [{ threeDsOutcome: "declined" as FraudAttempt["threeDsOutcome"] }, "an invented 3DS outcome"],
    [{ postalCodeMatched: "yes" as unknown as boolean }, "a postal code result that is not a boolean"],
    [{ ipCountryMatched: 1 as unknown as boolean }, "and a country result that is not one"],
    [{ cardFingerprint: null }, "a card payment with no fingerprint to check"],
    [{ cardFingerprint: fraudFingerprint.toUpperCase() }, "a fingerprint in upper case"],
    [{ cardFingerprint: "abc" }, "a fingerprint of three characters"],
    [{ paymentMethod: "bank_transfer" as const }, "a bank transfer that carries a card fingerprint"],
    [{ ipAddress: "not-an-ip" }, "a payer address that is not an address"],
    [{ ipAddress: "" }, "and no payer address at all"],
    [{ ipAddress: "203.0.113.9/24" }, "a network instead of an address"],
  ] as readonly (readonly [Partial<FraudAttempt>, string])[]) {
    expectEqual(
      encryptionReason(await expectFraudRefusal(overrides, `${description} is refused`)),
      "attempt_invalid",
      `and ${description} is an attempt failure`,
    );
  }

  expectEqual(
    (await expectFraudRefusal({ currency: "EUR" }, "a currency that is not dollars is refused"))?.code,
    "INTERNAL_ERROR",
    "a malformed attempt is this platform's fault, not the client's",
  );
  expectEqual(
    encryptionReason(await expectFraudRefusal({}, "a negative threshold is refused", { policy: { reviewAmountMinor: -1n } })),
    "policy_invalid",
    "a policy cannot hold every payment",
  );
  expectEqual(
    encryptionReason(
      await expectFraudRefusal({}, "a threshold that is not a bigint is refused", {
        policy: { reviewAmountMinor: 10 as unknown as bigint },
      }),
    ),
    "policy_invalid",
    "and a threshold that is not a number of cents is not a threshold",
  );

  const nonCard = await fraudDecide({ paymentMethod: "bank_transfer", cardFingerprint: null });

  expectEqual(nonCard.decision, "allow", "a bank transfer with authenticated 3DS is allowed");
  expectEqual(nonCard.signals[1]?.detail, "no_card", "the blacklist has no card to check");
  expectEqual(nonCard.signals[2]?.detail, "no_card", "and the card velocity has no card either");
}

async function checkFraudSignals(): Promise<void> {
  expectEqual((await fraudDecide({ providerSignal: "suspicious" })).decision, "review", "a suspicious provider verdict holds the payment");
  expectEqual((await fraudDecide({ providerSignal: "suspicious" })).reasons.join(","), "provider_suspicious", "saying why");
  expectEqual((await fraudDecide({ providerSignal: "fraud" })).decision, "reject", "a provider fraud signal rejects it");
  expectEqual((await fraudDecide({ providerSignal: "fraud" })).captureAllowed, false, "with no capture");
  expectEqual((await fraudDecide({ providerSignal: "fraud" })).signals[0]?.outcome, "reject", "as a reject in the first signal");

  const blocked = await fraudDecide({}, { lookups: fraudLookups({ blocked: true }) });

  expectEqual(blocked.decision, "reject", "a blacklisted card is rejected");
  expectEqual(blocked.reasons.join(","), "blacklisted", "by name");
  expectEqual(blocked.captureAllowed, false, "and nothing is captured");
  expectEqual((await fraudDecide({}, { lookups: fraudLookups({ blocked: false }) })).signals[1]?.detail, "not_listed", "a card that is not listed clears");

  const cardAtLimit = await fraudDecide({}, { lookups: fraudLookups({ card: { hits: 4, limit: 4 } }) });

  expectEqual(cardAtLimit.decision, "reject", "a card that reached its limit is rejected");
  expectEqual(cardAtLimit.reasons.join(","), "card_over_limit", "as a card velocity breach");
  expectEqual(
    (await fraudDecide({}, { lookups: fraudLookups({ card: { hits: 3, limit: 4 } }) })).decision,
    "allow",
    "one hit below the limit is still allowed",
  );
  expectEqual(
    (await fraudDecide({}, { lookups: fraudLookups({ card: { hits: 5, limit: 4 } }) })).signals[2]?.detail,
    "card_over_limit",
    "and one above it is not",
  );

  const ipAtLimit = await fraudDecide({}, { lookups: fraudLookups({ ip: { hits: 10, limit: 10 } }) });

  expectEqual(ipAtLimit.decision, "review", "an address that reached its limit is held for review, not refused");
  expectEqual(ipAtLimit.reasons.join(","), "ip_over_limit", "as an address velocity breach");
  expectEqual(ipAtLimit.captureAllowed, false, "so nothing is captured before a person looks");
  expectEqual(
    (await fraudDecide({}, { lookups: fraudLookups({ ip: { hits: 9, limit: 10 } }) })).decision,
    "allow",
    "one hit below the address limit is allowed",
  );

  const threeDsCases = [
    [{ threeDsOutcome: "authenticated" as const }, "allow", "three_ds_authenticated"],
    [{ threeDsOutcome: "not_completed" as const, postalCodeMatched: true, ipCountryMatched: true }, "allow", "three_ds_verified_by_billing"],
    [{ threeDsOutcome: "attempted" as const, postalCodeMatched: true, ipCountryMatched: true }, "allow", "three_ds_verified_by_billing"],
    [{ threeDsOutcome: "not_completed" as const, postalCodeMatched: true, ipCountryMatched: false }, "review", "three_ds_unverified"],
    [{ threeDsOutcome: "not_completed" as const, postalCodeMatched: false, ipCountryMatched: true }, "review", "three_ds_unverified"],
    [{ threeDsOutcome: "not_requested" as const }, "review", "three_ds_unverified"],
  ] as const;

  for (const [overrides, expected, detail] of threeDsCases) {
    const caseDecision = await fraudDecide(overrides);

    expectEqual(caseDecision.decision, expected, `3DS ${overrides.threeDsOutcome} with the addresses it had is ${expected}`);
    expectEqual(caseDecision.signals[4]?.detail, detail, `and the 3DS signal says ${detail}`);
  }

  const verifiedWithoutThreeDs = await fraudDecide({
    threeDsOutcome: "not_completed",
    postalCodeMatched: true,
    ipCountryMatched: true,
  });

  expectEqual(verifiedWithoutThreeDs.captureAllowed, true, "a payment verified by both addresses may be captured without 3DS");

  const amountAtThreshold = await fraudDecide({ amountMinor: 1_000_000n });

  expectEqual(amountAtThreshold.decision, "review", "an amount at the threshold is held");
  expectEqual(amountAtThreshold.reasons.join(","), "amount_over_review", "as an unusually large transaction");
  expectEqual(amountAtThreshold.captureAllowed, false, "and not captured");
  expectEqual((await fraudDecide({ amountMinor: 999_999n })).decision, "allow", "one cent below it is allowed");
  expectEqual(
    (await fraudDecide({ amountMinor: 1_000_000n }, { policy: { reviewAmountMinor: 2_000_000n } })).decision,
    "allow",
    "and the operator's threshold decides, not the default",
  );
  expectEqual(
    (await fraudDecide({ amountMinor: 0n + 2_000_000n }, { policy: { reviewAmountMinor: 2_000_000n } })).decision,
    "review",
    "which bites at its own value",
  );

  const everything = await fraudDecide(
    { providerSignal: "fraud", amountMinor: 9_000_000n, threeDsOutcome: "not_completed" },
    { lookups: fraudLookups({ blocked: true, card: { hits: 9, limit: 2 }, ip: { hits: 9, limit: 2 } }) },
  );

  expectEqual(everything.decision, "reject", "when several signals fire the decision is the highest");
  expectEqual(
    everything.reasons.join(","),
    "provider_fraud,blacklisted,card_over_limit,ip_over_limit,three_ds_unverified,amount_over_review",
    "while the trace keeps every one of them, in order",
  );

  const threeDsCombinations = [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const;

  const allowedDecisions = await Promise.all(
    FRAUD_THREE_DS_OUTCOMES.flatMap((outcome) =>
      threeDsCombinations.map(async ([postalCodeMatched, ipCountryMatched]) => ({
        outcome,
        postalCodeMatched,
        ipCountryMatched,
        decision: await fraudDecide({ threeDsOutcome: outcome, postalCodeMatched, ipCountryMatched }),
      })),
    ),
  );

  for (const entry of allowedDecisions) {
    expectEqual(
      entry.decision.decision === "allow",
      threeDsVerified(fraudAttempt({ threeDsOutcome: entry.outcome, postalCodeMatched: entry.postalCodeMatched, ipCountryMatched: entry.ipCountryMatched })),
      `an allow with ${entry.outcome} and postal ${entry.postalCodeMatched} means the 3DS rule was satisfied`,
    );
  }
}

async function checkFraudLookups(): Promise<void> {
  const calls: FraudLookupCalls = { fingerprints: [], subjects: [] };

  await fraudDecide({}, { lookups: fraudLookups({ calls }) });

  expectEqual(calls.fingerprints.join(","), fraudFingerprint, "the blacklist is asked once, about this attempt's card");
  expectEqual(calls.subjects.length, 2, "and the counters are asked twice");
  expectEqual(calls.subjects[0]?.kind, "card", "first about the card");
  expectEqual(calls.subjects[0]?.value, fraudFingerprint, "by its fingerprint");
  expectEqual(calls.subjects[1]?.kind, "ip", "then about the address");
  expectEqual(calls.subjects[1]?.value, fraudIpAddress, "by the address");

  const nonCardCalls: FraudLookupCalls = { fingerprints: [], subjects: [] };

  await fraudDecide({ paymentMethod: "bank_transfer", cardFingerprint: null }, { lookups: fraudLookups({ calls: nonCardCalls }) });

  expectEqual(nonCardCalls.fingerprints.length, 0, "a bank transfer asks the blacklist nothing");
  expectEqual(nonCardCalls.subjects.length, 1, "and reads one counter, not two");
  expectEqual(nonCardCalls.subjects[0]?.kind, "ip", "the address one");

  const otherCalls: FraudLookupCalls = { fingerprints: [], subjects: [] };

  await fraudDecide({ cardFingerprint: fraudOtherFingerprint }, { lookups: fraudLookups({ calls: otherCalls }) });

  expectEqual(otherCalls.fingerprints.join(","), fraudOtherFingerprint, "a second attempt is asked about its own card, not the first one");
  expectEqual(otherCalls.fingerprints.includes(fraudFingerprint), false, "so one card's list is never consulted for another");

  const failing = await expectFraudRefusal({}, "a blacklist that throws stops the evaluation", {
    lookups: fraudLookups({
      blacklist: async () => {
        throw new Error("the blacklist is down");
      },
    }),
  });

  expectEqual(encryptionReason(failing), "lookup_failed", "and the reason is the lookup, not the card");
  expectEqual(failing?.code, "DEPENDENCY_FAILED", "which is a dependency failure");
  expectEqual(failing?.status, 502, "reported as a bad gateway rather than a refusal of the payment");
  expectEqual(
    encryptionReason(
      await expectFraudRefusal({}, "a blacklist that answers with a non-boolean stops the evaluation", {
        lookups: fraudLookups({ blacklist: async () => "no" as unknown as boolean }),
      }),
    ),
    "lookup_failed",
    "an answer that is not a boolean is not an answer",
  );

  for (const [reading, description] of [
    [{ hits: -1, limit: 5 }, "a negative count"],
    [{ hits: 1.5, limit: 5 }, "a fractional count"],
    [{ hits: Number.NaN, limit: 5 }, "a count that is not a number"],
    [{ hits: 1, limit: 0 }, "a limit below the counter's floor"],
    [{ hits: 1, limit: -5 }, "a negative limit"],
    [{ hits: 1, limit: 2.5 }, "a fractional limit"],
    [{ hits: Number.POSITIVE_INFINITY, limit: 5 }, "a count that is infinite"],
  ] as readonly (readonly [FraudVelocityReading, string])[]) {
    expectEqual(
      encryptionReason(
        await expectFraudRefusal({}, `${description} is not a reading`, {
          lookups: fraudLookups({ velocity: async () => reading }),
        }),
      ),
      "lookup_failed",
      `${description} is a dependency failure`,
    );
  }

  expectEqual(
    encryptionReason(
      await expectFraudRefusal({}, "a counter that throws stops the evaluation", {
        lookups: fraudLookups({
          velocity: async () => {
            throw new Error("the counters are down");
          },
        }),
      }),
    ),
    "lookup_failed",
    "a counter that cannot be read cannot be cleared",
  );
  expectEqual(
    (await fraudDecide({}, { lookups: fraudLookups({ card: { hits: 0, limit: 1 }, ip: { hits: 0, limit: 1 } }) })).decision,
    "allow",
    "a counter at zero with a limit of one is still clear",
  );
  expectEqual(
    (await fraudDecide({}, { lookups: fraudLookups({ card: { hits: Number.MAX_SAFE_INTEGER, limit: 1 } }) })).decision,
    "reject",
    "and a count at the safe integer ceiling is read rather than refused",
  );
}

async function checkFraudAudit(): Promise<void> {
  const allowed = await fraudDecide();

  expectEqual(fraudAuditEntry(fraudAttempt(), allowed), null, "a cleared payment writes no fraud entry of its own");

  const reviewed = await fraudDecide({ amountMinor: 4_000_000n });
  const entry = fraudAuditEntry(fraudAttempt({ amountMinor: 4_000_000n }), reviewed);

  expect(entry !== null, "a held payment writes one");
  expectEqual(entry?.action, FRAUD_AUDIT_ACTION, "with the action this module owns");
  expectEqual(entry?.payload["decision"], "review", "the decision");
  expectEqual(entry?.payload["capture_allowed"], false, "whether money may move");
  expectEqual(entry?.payload["amount_minor"], "4000000", "the amount as a string, because a bigint is not JSON");
  expectEqual(entry?.payload["payment_method"], "card", "the method");
  expectEqual(entry?.payload["currency"], "USD", "and the currency");
  expectEqual(entry?.payload["three_ds_outcome"], "authenticated", "the 3DS outcome it decided on");
  expectEqual(entry?.payload["card_fingerprint"], fraudFingerprint, "and the fingerprint, so an investigation can ask about the card");
  expectEqual((entry?.payload["signals"] as readonly unknown[]).length, FRAUD_SIGNALS.length, "every signal is in the payload");
  expectEqual((entry?.payload["reasons"] as readonly unknown[]).join(","), "amount_over_review", "with the reasons");
  expectEqual(entry?.entityType, null, "with no entity, because the attempt is evaluated before its row exists");
  expectEqual(entry?.entityId, null, "so the pair is empty rather than half filled");
  expectEqual(entry?.companyId, fraudCompanyId, "and the company it belongs to");
  expectEqual(JSON.stringify(entry?.payload).includes(fraudIpAddress), false, "the payload carries no address, only the audit row's own field");
  expectEqual(JSON.stringify(entry?.payload).includes("rejected_by"), false, "and no invented key");

  const withPayment = fraudAuditEntry(fraudAttempt({ amountMinor: 4_000_000n }), reviewed, {
    paymentId: fraudPaymentId,
    actorUserId: fraudActorId,
    ipAddress: fraudIpAddress,
    userAgent: "Mozilla/5.0 (compatible; KD test)",
    sessionId: null,
  });

  expectEqual(withPayment?.entityType, "payment", "a decision about a row that exists names it");
  expectEqual(withPayment?.entityId, fraudPaymentId, "by id");
  expectEqual(withPayment?.actorUserId, fraudActorId, "and keeps the actor");
  expectEqual(withPayment?.ipAddress, fraudIpAddress, "and the address in the field the audit table expects");

  const rejected = await fraudDecide({ providerSignal: "fraud" });
  const rejectedEntry = fraudAuditEntry(fraudAttempt({ providerSignal: "fraud" }), rejected, { paymentId: fraudPaymentId });

  expectEqual(rejectedEntry?.payload["decision"], "reject", "a rejected payment is recorded as one");
  expectEqual(rejectedEntry?.payload["capture_allowed"], false, "with no capture");
  expectEqual((rejectedEntry?.payload["reasons"] as readonly unknown[]).join(","), "provider_fraud", "and the reason");

  for (const candidate of [entry, withPayment, rejectedEntry]) {
    expect(candidate !== null && auditEntryProblem(candidate) === null, "the entry passes the audit module's own validation");
  }

  expect(auditPayloadBytes(entry?.payload ?? {}) < AUDIT_MAXIMUM_PAYLOAD_BYTES, "and fits the payload ceiling with room to spare");

  const redacted = redactAuditPayload(entry?.payload ?? {});

  expectEqual(redacted["card_fingerprint"], fraudFingerprint, "the redaction pass keeps the fingerprint: it is not a credential");
  expectEqual(redacted["decision"], "review", "and keeps the decision");
  expectEqual(JSON.stringify(redacted).includes(AUDIT_REDACTED), false, "nothing in the payload is a secret");
  expect(buildAuditEntry(entry as AuditEntry).payload["signals"] !== undefined, "and the audit module builds it without complaint");
}

async function checkFraudWiring(): Promise<void> {
  const source = await readFile(new URL("./fraud.ts", import.meta.url), "utf8");
  const payments = await readFile(new URL("../../migrations/0037_payments.sql", import.meta.url), "utf8");
  const blacklist = await readFile(new URL("../../migrations/0055_card_blacklist.sql", import.meta.url), "utf8");
  const velocity = await readFile(new URL("../../migrations/0056_velocity_counters.sql", import.meta.url), "utf8");

  expect(source.includes('from "./host.ts"'), "the address rule is STEP 058's, not a second parser");
  expect(source.includes("isIpLiteral"), "which is the one function that decides an address");
  expect(source.includes('from "../errors/app-error.ts"'), "a failure is an AppError");
  expectEqual(source.includes("console."), false, "nothing is logged, so no attempt is");
  expectEqual(source.includes("process.env"), false, "the module reads no environment variable");
  expectEqual(source.includes("fetch("), false, "and makes no request");
  expectEqual(source.includes("Date.now"), false, "and holds no clock: a decision is a function of its inputs");
  expectEqual(source.includes("Math.random"), false, "nor randomness");
  expectEqual(source.includes("aes-256-gcm"), false, "a fingerprint is never computed here: it arrives hashed");
  expectEqual(source.includes("supabase"), false, "and the two lookups are the caller's, not this module's client");
  expectEqual(source.includes("card_number"), false, "no card number is named, because none may arrive");
  expectEqual(source.includes("cvv"), false, "and no CVV either");
  expectEqual(source.includes("card_fingerprint"), true, "the fingerprint is the one card value this module knows");

  for (const signal of FRAUD_SIGNALS) {
    expect(source.includes(`"${signal}"`), `${signal} is a signal in the source`);
  }

  for (let index = 1; index < FRAUD_SIGNALS.length; index += 1) {
    const previous = FRAUD_SIGNALS[index - 1] ?? "";
    const current = FRAUD_SIGNALS[index] ?? "";

    expect(
      source.indexOf(`  "${previous}",\n`) < source.indexOf(`  "${current}",\n`),
      `${previous} is declared before ${current}`,
    );
  }

  const assembly = [
    "providerSignalResult(attempt)",
    "cardBlacklistResult(attempt, blocked)",
    "cardVelocityResult(attempt, cardReading)",
    "ipVelocityResult(ipReading)",
    "threeDsResult(attempt)",
    "amountResult(attempt, policy)",
  ];

  for (let index = 1; index < assembly.length; index += 1) {
    const previous = assembly[index - 1] ?? "";
    const current = assembly[index] ?? "";

    expect(source.indexOf(previous) < source.indexOf(current), `the assembly evaluates ${previous} before ${current}`);
  }

  expect(payments.includes("risk_decision in ('allow', 'review', 'reject')"), "the payments table states the three decisions");
  expect(
    payments.includes(`risk_decision in (${FRAUD_DECISIONS.map((decision) => `'${decision}'`).join(", ")})`),
    "and they are the words this module returns",
  );
  expect(payments.includes("three_ds_outcome = 'authenticated'"), "the table states the 3DS capture rule");
  expect(payments.includes("(postal_code_matched and ip_country_matched)"), "as both addresses matching");
  expect(
    payments.includes(`three_ds_outcome in (${FRAUD_THREE_DS_OUTCOMES.map((outcome) => `'${outcome}'`).join(", ")})`),
    "and the four outcomes this module reads",
  );
  expect(
    payments.includes(`payment_method in (${FRAUD_PAYMENT_METHODS.map((method) => `'${method}'`).join(", ")})`),
    "with the three payment methods it accepts",
  );
  expect(payments.includes("risk_decision <> 'reject' or status = 'failed'"), "a reject only ever sits on a failed payment");

  expect(blacklist.includes("card_fingerprint ~ '^[0-9a-f]{64}$'"), "the blacklist stores the same 64 hex fingerprint");
  expectEqual(FRAUD_CARD_FINGERPRINT_PATTERN.source, "^[0-9a-f]{64}$", "which is this module's pattern, spelled once");
  expect(velocity.includes("hit_count integer not null default 0"), "the counters store a count");
  expect(velocity.includes("limit_value integer not null"), "and the limit they applied");
  expect(velocity.includes("limit_value >= 1"), "with a floor of one, which this module enforces on a reading");
  expect(velocity.includes("hit_count >= limit_value"), "and a breach recorded when the count reaches the limit, which is the comparison here");

  const roots = [new URL("../../lib/", import.meta.url), new URL("../../app/", import.meta.url)];
  const decisionWriters: string[] = [];

  for (const root of roots) {
    const prefix = root.pathname.endsWith("/lib/") ? "lib/" : "app/";
    const entries = (await readdir(root, { recursive: true }))
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"));

    for (const entry of entries) {
      const text = await readFile(new URL(entry, root), "utf8");

      if (!entry.endsWith("verify.ts") && text.includes("payment.fraud_evaluated")) {
        decisionWriters.push(`${prefix}${entry}`);
      }
    }
  }

  expectEqual(decisionWriters.sort().join(","), "lib/security/fraud.ts", "one module in the tree decides a payment's risk");
}

/** ---- Velocity: one card and one address, counted by the database and never by the service. */

const velocityCardToken = "tok_visa_4242_opaque";
const velocityFingerprint = velocityCardFingerprint(velocityCardToken);
const velocitySecondToken = "tok_mastercard_5555_opaque";
const velocityFixedNow = Date.parse("2026-11-01T10:00:30.000Z");
const velocityAddress = "203.0.113.9";

interface FakeVelocityCounterState {
  hits: number;
  limit: number;
  windowStart: string;
  windowSeconds: number;
}

interface FakeVelocityCounter {
  readonly client: VelocityCounterClient;
  readonly calls: Record<string, unknown>[];
  readonly keys: () => number;
}

/**
 * The counter of `0093`, kept in a map: the same window alignment, the same frozen limit, the same
 * answer. The SQL itself is replayed against a real Postgres in the STEP's handoff; this fake exists
 * so the service can be proved to read that shape and to refuse every other.
 */
function velocityCounter(): FakeVelocityCounter {
  const rows = new Map<string, FakeVelocityCounterState>();
  const calls: Record<string, unknown>[] = [];

  return {
    calls,
    keys: (): number => rows.size,
    client: {
      rpc: async (functionName: string, arguments_: Readonly<Record<string, unknown>>): Promise<unknown> => {
        if (functionName !== VELOCITY_CONSUME_FUNCTION) {
          throw new AppError("DEPENDENCY_FAILED");
        }

        calls.push({ ...arguments_ });

        const nowMs = Date.parse(String(arguments_["p_now"]));
        const windowSeconds = Number(arguments_["p_window_seconds"]);
        const limit = Number(arguments_["p_limit"]);
        const subject = String(arguments_["p_subject"]);
        const value = String(subject === "card" ? arguments_["p_card_fingerprint"] : arguments_["p_ip_address"]);
        const windowStart = velocityWindowStart(nowMs, windowSeconds);
        const key = `${subject}:${value}:${windowSeconds}:${windowStart}`;
        const existing = rows.get(key);
        const hits = (existing?.hits ?? 0) + 1;
        const appliedLimit = existing?.limit ?? limit;
        const state: FakeVelocityCounterState = {
          hits,
          limit: appliedLimit,
          windowStart: new Date(windowStart * 1_000).toISOString(),
          windowSeconds,
        };

        rows.set(key, state);

        return [
          {
            counter_hits: state.hits,
            counter_limit: state.limit,
            counter_window_start: state.windowStart,
            counter_window_seconds: state.windowSeconds,
            counter_exceeded: state.hits >= state.limit,
            counter_first_breach: state.hits === state.limit,
          },
        ];
      },
    },
  };
}

/** A client that answers whatever a test tells it to, or fails. */
function velocityAnswering(answer: unknown): VelocityCounterClient {
  return {
    rpc: async (): Promise<unknown> => answer,
  };
}

function velocityFailing(): VelocityCounterClient {
  return {
    rpc: async (): Promise<unknown> => {
      throw new Error("connection reset");
    },
  };
}

function velocityOptions(client: VelocityCounterClient, policy?: VelocityPolicy): VelocityCounterOptions {
  return policy === undefined
    ? { rest: client, now: (): number => velocityFixedNow }
    : { rest: client, now: (): number => velocityFixedNow, policy };
}

/** One good answer of `0093`, which each malformed-answer case then breaks in one field. */
function velocityRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    counter_hits: 1,
    counter_limit: 5,
    counter_window_start: "2026-11-01T10:00:00.000Z",
    counter_window_seconds: 3_600,
    counter_exceeded: false,
    counter_first_breach: false,
    ...overrides,
  };
}

function velocityReasonOf(error: AppError | null): string | undefined {
  return (error?.cause as { reason?: string } | undefined)?.reason;
}

function checkVelocityVocabulary(): void {
  expectEqual(VELOCITY_SUBJECTS.join(","), "card,ip", "a velocity counter has two subjects");
  expectEqual(VELOCITY_RULE, "velocity", "and one rule name");
  expectEqual(VELOCITY_CONSUME_FUNCTION, "consume_velocity", "the counting function is the migration's");
  expectEqual(VELOCITY_TABLE, "velocity_counters", "and the table is STEP 056's");
  expectEqual(VELOCITY_AUDIT_ACTION, "security.velocity_limited", "a breach has one audit action");
  expect(AUDIT_ACTION_PATTERN.test(VELOCITY_AUDIT_ACTION), "which is the audit module's action shape");
  expect(VELOCITY_AUDIT_ACTION.length <= AUDIT_MAXIMUM_ACTION_LENGTH, "and fits its ceiling");
  expect(Object.isFrozen(VELOCITY_SUBJECTS), "the subject list is frozen");
  expect(Object.isFrozen(VELOCITY_DEFAULT_POLICY), "and the default policy is frozen, so nothing edits a default");
  expectEqual(VELOCITY_DEFAULT_POLICY.card.limit, 5, "five attempts on one card");
  expectEqual(VELOCITY_DEFAULT_POLICY.card.windowSeconds, 3_600, "inside an hour");
  expectEqual(VELOCITY_DEFAULT_POLICY.ip.limit, 20, "twenty attempts from one address");
  expectEqual(VELOCITY_DEFAULT_POLICY.ip.windowSeconds, 3_600, "inside the same hour");
  expectEqual(VELOCITY_RETENTION_SECONDS, VELOCITY_MAXIMUM_WINDOW_SECONDS, "a window is kept as long as the widest window can be");
  expectEqual(VELOCITY_MINIMUM_WINDOW_SECONDS, 1, "the narrowest window is a second");
  expectEqual(VELOCITY_MAXIMUM_WINDOW_SECONDS, 2_592_000, "the widest is thirty days, as 0056 states");
  expectEqual(VELOCITY_MAXIMUM_LIMIT, 1_000_000, "and a limit is a small integer");
  expectEqual(VELOCITY_CARD_FINGERPRINT_PATTERN.source, "^[0-9a-f]{64}$", "the fingerprint is the one 0055 stores");
  expectEqual(VELOCITY_PROBLEMS.length, 5, "five reasons a hit cannot be counted");
  expectEqual(new Set<string>(VELOCITY_PROBLEMS).size, VELOCITY_PROBLEMS.length, "each of them once");
  expect(Object.isFrozen(VELOCITY_PROBLEMS), "and the list is frozen");
  expect(VELOCITY_PROBLEMS.every((problem) => /^[a-z][a-z0-9_]*$/u.test(problem)), "each spelled as a machine reason");

  for (const subject of VELOCITY_SUBJECTS) {
    expect(isVelocitySubject(subject), `${subject} is a subject`);
  }

  expectEqual(isVelocitySubject("email"), false, "an address book is not a subject this counter has");
  expectEqual(isVelocitySubject(undefined), false, "and neither is nothing");

  // ---- the window, as 0093 aligns it
  expectEqual(velocityWindowStart(Date.parse("2026-11-01T10:00:00.000Z"), 3_600), Date.parse("2026-11-01T10:00:00.000Z") / 1_000, "the top of the hour starts a window");
  expectEqual(velocityWindowStart(Date.parse("2026-11-01T10:59:59.999Z"), 3_600), Date.parse("2026-11-01T10:00:00.000Z") / 1_000, "the last millisecond of it is still in it");
  expectEqual(velocityWindowStart(Date.parse("2026-11-01T11:00:00.000Z"), 3_600), Date.parse("2026-11-01T11:00:00.000Z") / 1_000, "and the next millisecond starts the next one");
  expectEqual(velocityWindowStart(Date.parse("2026-11-01T10:00:30.000Z"), 60), Date.parse("2026-11-01T10:00:00.000Z") / 1_000, "a minute window aligns to the minute");
  expectEqual(velocityWindowStart(Date.parse("2026-11-01T10:00:30.900Z"), 1), Date.parse("2026-11-01T10:00:30.000Z") / 1_000, "a one second window to the second");

  // ---- the wait, always positive because a caller reports it
  expectEqual(velocityRetryAfter(velocityFixedNow, Date.parse("2026-11-01T10:00:00.000Z") / 1_000, 3_600), 3_570, "the wait is what is left of the window");
  expectEqual(velocityRetryAfter(Date.parse("2026-11-01T10:59:59.500Z"), Date.parse("2026-11-01T10:00:00.000Z") / 1_000, 3_600), 1, "the last millisecond waits one second, never zero");
  expectEqual(velocityRetryAfter(Date.parse("2026-11-01T10:00:00.000Z"), Date.parse("2026-11-01T10:00:00.000Z") / 1_000, 3_600), 3_600, "and a hit at the first instant waits the whole window");
  expectEqual(velocityRetryAfter(Date.parse("2026-11-01T11:00:05.000Z"), Date.parse("2026-11-01T10:00:00.000Z") / 1_000, 3_600), 1, "an instant past the window still waits a second rather than none");

  // ---- the fingerprint
  expectEqual(velocityFingerprint, velocityFingerprint, "the same token hashes to the same fingerprint");
  expect(VELOCITY_CARD_FINGERPRINT_PATTERN.test(velocityFingerprint), "which is the 64 hex digits 0056 enforces");
  expect(velocityFingerprint !== velocityCardFingerprint(velocitySecondToken), "and two tokens are two cards");
  expectEqual(velocityFingerprint.includes(velocityCardToken), false, "the token itself is nowhere in the fingerprint");

  for (const [name, refused] of [
    ["a card number", "4242424242424242"],
    ["a fifteen digit card number", "424242424242424"],
    ["a nineteen digit card number", "4242424242424242424"],
    ["an empty token", ""],
    ["a token with a space", "tok 4242"],
    ["a token with a leading space", " tok_visa"],
    ["a token with a trailing space", "tok_visa "],
    ["a token past the ceiling", "t".repeat(VELOCITY_MAXIMUM_CARD_TOKEN_LENGTH + 1)],
    ["a token with a newline", "tok\nvisa"],
    ["a token with a non-ASCII character", "tok\u00e9"],
  ] as const) {
    const refusal = expectThrows(() => velocityCardFingerprint(refused), `${name} is refused rather than hashed`);

    expectEqual(refusal?.code, "INTERNAL_ERROR", `${name} is a wiring mistake, not a payer's fault`);
    expectEqual(velocityReasonOf(refusal), "subject_invalid", `${name} is refused as an invalid subject`);
  }

  expectEqual(
    velocityCardFingerprint("t".repeat(VELOCITY_MAXIMUM_CARD_TOKEN_LENGTH)).length,
    64,
    "a token exactly at the ceiling is still hashed",
  );

  // ---- the subject in the form the row stores
  expectEqual(canonicalVelocitySubject({ kind: "card", value: velocityCardToken }).value, velocityFingerprint, "a token becomes its fingerprint");
  expectEqual(
    canonicalVelocitySubject({ kind: "card", value: velocityFingerprint }).value,
    velocityFingerprint,
    "and a caller that already hashed the token names the same card",
  );
  expectEqual(canonicalSubjectKind(canonicalVelocitySubject({ kind: "card", value: velocityCardToken })), "card", "the kind travels with the value");
  expectEqual(canonicalVelocityAddress("203.0.113.9"), velocityAddress, "an address is kept as it is written");
  expectEqual(canonicalVelocityAddress("2001:0DB8:0:0:0:0:0:1"), canonicalVelocityAddress("2001:db8::1"), "two spellings of an address are one subject");
  expectEqual(canonicalVelocitySubject({ kind: "ip", value: "2001:0db8:0:0::1" }).value, "2001:db8::1", "and the stored value is the canonical one");

  const unknownSubject = expectThrows(
    () => canonicalVelocitySubject({ kind: "email" as VelocitySubjectKind, value: "a@b.example" }),
    "a kind that is not card or ip is refused",
  );

  expectEqual(velocityReasonOf(unknownSubject), "subject_invalid", "as an invalid subject");
  expectEqual(velocityReasonOf(expectThrows(() => canonicalVelocityAddress("not-an-address"), "a string that is not an address is refused")), "subject_invalid", "and neither is it counted");
  expectEqual(velocityReasonOf(expectThrows(() => canonicalVelocityAddress(""), "nor an empty one")), "subject_invalid", "which is a refusal rather than a free pass");
}

/** The kind of a canonical subject, as a string, so a check can compare it. */
function canonicalSubjectKind(subject: { readonly kind: string }): string {
  return subject.kind;
}

async function checkVelocityConsumption(): Promise<void> {
  const counter = velocityCounter();
  const first = await consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(counter.client));

  expectEqual(counter.calls.length, 1, "one hit is one call");
  expectEqual(
    JSON.stringify(counter.calls[0]),
    JSON.stringify({
      p_subject: "card",
      p_card_fingerprint: velocityFingerprint,
      p_ip_address: null,
      p_limit: 5,
      p_window_seconds: 3_600,
      p_now: "2026-11-01T10:00:30.000Z",
    }),
    "and the call is the six arguments 0093 declares, with the fingerprint rather than the token",
  );
  expectEqual(first.hits, 1, "the first hit counts one");
  expectEqual(first.limit, 5, "against the default limit of the card rule");
  expectEqual(first.kind, "card", "the reading names the subject kind");
  expectEqual(first.value, velocityFingerprint, "and the canonical value, not the token");
  expectEqual(first.windowStart, Date.parse("2026-11-01T10:00:00.000Z") / 1_000, "the window is the one the database answered");
  expectEqual(first.windowSeconds, 3_600, "with its length");
  expectEqual(first.exceeded, false, "one hit is not a breach");
  expectEqual(first.firstBreach, false, "nor the first breach");
  expectEqual(first.retryAfterSeconds, 3_570, "and the wait is the rest of the window");
  expectEqual(Object.keys(first).sort().join(","), "exceeded,firstBreach,hits,kind,limit,retryAfterSeconds,value,windowSeconds,windowStart", "the reading is exactly nine fields");

  const second = await consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(counter.client));
  const third = await consumeVelocity({ kind: "card", value: velocityFingerprint }, velocityOptions(counter.client));

  expectEqual(second.hits, 2, "the second hit counts two");
  expectEqual(third.hits, 3, "and a caller that hands over the fingerprint counts the same card");
  expectEqual(counter.keys(), 1, "one card is one row in the window");

  // ---- the limit the row applied wins over the policy the caller now has
  const changed = await consumeVelocity(
    { kind: "card", value: velocityCardToken },
    velocityOptions(counter.client, { card: { limit: 9, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } }),
  );

  expectEqual(changed.hits, 4, "the fourth hit counts four");
  expectEqual(changed.limit, 5, "and is held to the limit the window was opened with");
  expectEqual(changed.exceeded, false, "which it has not reached");

  const reached = await consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(counter.client));

  expectEqual(reached.hits, 5, "the fifth hit counts five");
  expectEqual(reached.limit, 5, "against the frozen limit");
  expect(reached.exceeded, "which it has now reached");
  expect(reached.firstBreach, "and this is the hit that reached it");

  const past = await consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(counter.client));

  expectEqual(past.hits, 6, "the sixth hit keeps counting");
  expect(past.exceeded, "it is past the limit");
  expectEqual(past.firstBreach, false, "but the first breach stays the first");

  // ---- a second window is a second counter
  const nextWindow = velocityCounter();
  const beforeRoll = await consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(nextWindow.client));
  const rollOptions: VelocityCounterOptions = { rest: nextWindow.client, now: (): number => Date.parse("2026-11-01T11:00:01.000Z") };
  const afterRoll = await consumeVelocity({ kind: "card", value: velocityCardToken }, rollOptions);

  expectEqual(beforeRoll.windowStart, Date.parse("2026-11-01T10:00:00.000Z") / 1_000, "the first window is this hour");
  expectEqual(afterRoll.windowStart, Date.parse("2026-11-01T11:00:00.000Z") / 1_000, "the next hour is the next window");
  expectEqual(afterRoll.hits, 1, "and starts again at one");
  expectEqual(nextWindow.keys(), 2, "so one card is one row per window");

  // ---- an address counter, and the one spelling of an address
  const addresses = velocityCounter();
  const ipOptions = velocityOptions(addresses.client, { card: { limit: 5, windowSeconds: 3_600 }, ip: { limit: 3, windowSeconds: 1_800 } });
  const ipFirst = await consumeVelocity({ kind: "ip", value: velocityAddress }, ipOptions);
  const ipSecond = await consumeVelocity({ kind: "ip", value: "2001:0db8:0:0:0:0:0:1" }, ipOptions);
  const ipThird = await consumeVelocity({ kind: "ip", value: "2001:db8::1" }, ipOptions);

  expectEqual(
    JSON.stringify(addresses.calls[0]),
    JSON.stringify({
      p_subject: "ip",
      p_card_fingerprint: null,
      p_ip_address: velocityAddress,
      p_limit: 3,
      p_window_seconds: 1_800,
      p_now: "2026-11-01T10:00:30.000Z",
    }),
    "an address counter sends the address and no card",
  );
  expectEqual(ipFirst.hits, 1, "the address counts from one");
  expectEqual(ipFirst.limit, 3, "under the address rule");
  expectEqual(ipFirst.windowSeconds, 1_800, "with its own window length");
  expectEqual(ipSecond.value, "2001:db8::1", "the second spelling is stored canonically");
  expectEqual(ipThird.hits, 2, "and both spellings are the same counter");
  expectEqual(addresses.keys(), 2, "which is one row for the address plus one for the IPv6 address");

  // ---- the policy is held to the bounds of 0056
  for (const [name, policy] of [
    ["a limit of zero", { card: { limit: 0, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } }],
    ["a negative limit", { card: { limit: -1, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } }],
    ["a fractional limit", { card: { limit: 1.5, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } }],
    ["a limit past the ceiling", { card: { limit: VELOCITY_MAXIMUM_LIMIT + 1, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } }],
    ["a window of zero", { card: { limit: 5, windowSeconds: 0 }, ip: { limit: 20, windowSeconds: 3_600 } }],
    ["a window past thirty days", { card: { limit: 5, windowSeconds: VELOCITY_MAXIMUM_WINDOW_SECONDS + 1 }, ip: { limit: 20, windowSeconds: 3_600 } }],
    ["a fractional window", { card: { limit: 5, windowSeconds: 1.5 }, ip: { limit: 20, windowSeconds: 3_600 } }],
  ] as const) {
    const refusal = await expectThrowsAsync(
      () => consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(velocityCounter().client, policy)),
      `${name} is refused`,
    );

    expectEqual(refusal?.code, "INTERNAL_ERROR", `${name} is a wiring mistake, not a payer's fault`);
    expectEqual(velocityReasonOf(refusal), "policy_invalid", `${name} is refused as an invalid policy`);
  }

  const missingRule = await expectThrowsAsync(
    () => consumeVelocity({ kind: "ip", value: velocityAddress }, velocityOptions(velocityCounter().client, { card: { limit: 5, windowSeconds: 3_600 } } as unknown as VelocityPolicy)),
    "a policy with no rule for the subject is refused",
  );

  expectEqual(velocityReasonOf(missingRule), "policy_invalid", "rather than defaulting to zero, which would refuse every payment");

  // ---- the clock
  for (const [name, clock] of [
    ["a clock that answers nothing", (): number => Number.NaN],
    ["a clock before the epoch", (): number => -1],
    ["a fractional clock", (): number => 1.5],
    ["a clock that throws", (): number => {
      throw new Error("no clock");
    }],
  ] as const) {
    const refusal = await expectThrowsAsync(
      () => consumeVelocity({ kind: "card", value: velocityCardToken }, { rest: velocityCounter().client, now: clock }),
      `${name} is refused`,
    );

    expectEqual(velocityReasonOf(refusal), "clock_invalid", `${name} cannot place a window`);
  }

  // ---- a failed call is a refusal, never a free first attempt
  const offline = await expectThrowsAsync(
    () => consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(velocityFailing())),
    "a counter that cannot be called is a dependency failure",
  );

  expectEqual(offline?.code, "DEPENDENCY_FAILED", "so the payment is not treated as the first attempt of the window");
  expectEqual(velocityReasonOf(offline), "response_invalid", "and the reason is kept for the log");

  // ---- an answer in any other shape is a dependency failure
  for (const [name, answer] of [
    ["no row", []],
    ["two rows", [velocityRow(), velocityRow()]],
    ["a scalar", 1],
    ["a string", "ok"],
    ["null", null],
    ["a row with no count", [velocityRow({ counter_hits: undefined })]],
    ["a count of zero", [velocityRow({ counter_hits: 0 })]],
    ["a fractional count", [velocityRow({ counter_hits: 1.5 })]],
    ["a count that is text", [velocityRow({ counter_hits: "1" })]],
    ["a limit of zero", [velocityRow({ counter_limit: 0 })]],
    ["a limit past the ceiling", [velocityRow({ counter_limit: VELOCITY_MAXIMUM_LIMIT + 1 })]],
    ["a window of zero seconds", [velocityRow({ counter_window_seconds: 0 })]],
    ["a window longer than thirty days", [velocityRow({ counter_window_seconds: VELOCITY_MAXIMUM_WINDOW_SECONDS + 1 })]],
    ["a different window length than the one asked for", [velocityRow({ counter_window_seconds: 1_800 })]],
    ["a window that is not this window", [velocityRow({ counter_window_start: "2026-11-01T09:00:00.000Z" })]],
    ["a window that is not a timestamp", [velocityRow({ counter_window_start: "yesterday" })]],
    ["a window that is a Date rather than the JSON a client answers", [velocityRow({ counter_window_start: new Date("2026-11-01T10:00:00.000Z") })]],
    ["a window in the future", [velocityRow({ counter_window_start: "2026-11-01T11:00:00.000Z" })]],
    ["a verdict that is text", [velocityRow({ counter_exceeded: "false" })]],
    ["a first breach that is missing", [velocityRow({ counter_first_breach: undefined })]],
    ["a breach the count does not support", [velocityRow({ counter_hits: 4, counter_exceeded: true })]],
    ["a count at the limit that is not a breach", [velocityRow({ counter_hits: 5, counter_limit: 5, counter_exceeded: false })]],
    ["a first breach that is not the first", [velocityRow({ counter_hits: 4, counter_first_breach: true })]],
    ["a first breach the count does not support", [velocityRow({ counter_hits: 5, counter_limit: 5, counter_exceeded: true, counter_first_breach: false })]],
  ] as const) {
    const refusal = await expectThrowsAsync(
      () => consumeVelocity({ kind: "card", value: velocityCardToken }, velocityOptions(velocityAnswering(answer))),
      `an answer with ${name} is refused`,
    );

    expectEqual(refusal?.code, "DEPENDENCY_FAILED", `an answer with ${name} is a dependency failure`);
    expectEqual(velocityReasonOf(refusal), "response_invalid", `and an answer with ${name} is recorded as an invalid response`);
  }
}

interface FakeVelocityAuditTrail {
  readonly trail: VelocityAuditTrail;
  readonly entries: VelocityAuditEntry[];
}

function velocityAuditTrail(): FakeVelocityAuditTrail {
  const entries: VelocityAuditEntry[] = [];

  return {
    entries,
    trail: {
      append: async (entry: VelocityAuditEntry): Promise<void> => {
        entries.push(entry);
      },
    },
  };
}

async function checkVelocityAudit(): Promise<void> {
  const counter = velocityCounter();
  const audit = velocityAuditTrail();
  const reader = createVelocityReader({
    ...velocityOptions(counter.client),
    audit: audit.trail,
    auditContext: { actorUserId: "018f2b8a-3333-4c2d-9c3e-0123456789ab", ipAddress: velocityAddress },
  });

  const readings: FraudVelocityReading[] = [];

  for (let index = 0; index < 6; index += 1) {
    readings.push(await reader({ kind: "card", value: velocityCardToken }));
  }

  expectEqual(readings.map((reading) => reading.hits).join(","), "1,2,3,4,5,6", "the reader counts every attempt");
  expectEqual(readings.map((reading) => reading.limit).join(","), "5,5,5,5,5,5", "against the limit the window applies");
  expectEqual(readings[0] === undefined ? "" : Object.keys(readings[0]).sort().join(","), "hits,limit", "and answers STEP 066's two fields and nothing else");
  expectEqual(audit.entries.length, 1, "six attempts write one audit entry");

  const entry = audit.entries[0];

  expectEqual(entry?.action, VELOCITY_AUDIT_ACTION, "which is the velocity breach action");
  expectEqual(entry?.payload["rule"], VELOCITY_RULE, "naming the rule");
  expectEqual(entry?.payload["subject"], "card", "and the subject kind");
  expectEqual(entry?.payload["card_fingerprint"], velocityFingerprint, "with the fingerprint, so an operator can find the card");
  expectEqual(entry?.payload["hits"], 5, "the count that reached the limit");
  expectEqual(entry?.payload["limit"], 5, "the limit it reached");
  expectEqual(entry?.payload["window_start"], "2026-11-01T10:00:00.000Z", "the window it happened in");
  expectEqual(entry?.payload["window_seconds"], 3_600, "and its length");
  expectEqual(entry?.payload["retry_after_seconds"], 3_570, "with the wait the caller was told");
  expectEqual(entry?.companyId, null, "the counter is the platform's, so the entry is on the platform chain");
  expectEqual(entry?.entityType, null, "a window is not an entity");
  expectEqual(entry?.entityId, null, "so it has no entity id");
  expectEqual(entry?.actorUserId, "018f2b8a-3333-4c2d-9c3e-0123456789ab", "and it carries the attempt's actor");
  expectEqual(entry?.ipAddress, velocityAddress, "and the payer's address from the caller");
  expectEqual(entry?.sessionId, null, "a session that was not given is null rather than absent");
  expectEqual(entry?.userAgent, null, "and so is the agent");
  expectEqual(JSON.stringify(entry?.payload ?? {}).includes("velocity_counters"), false, "the payload names no table");
  expectEqual(entry === undefined ? true : auditEntryProblem(entry) === null, true, "and the entry passes the audit module's own validation");

  // ---- an address breach names the address in the entry, not in the payload
  const addressCounter = velocityCounter();
  const addressAudit = velocityAuditTrail();
  const addressReader = createVelocityReader({
    rest: addressCounter.client,
    now: (): number => velocityFixedNow,
    policy: { card: { limit: 5, windowSeconds: 3_600 }, ip: { limit: 2, windowSeconds: 3_600 } },
    audit: addressAudit.trail,
  });

  await addressReader({ kind: "ip", value: velocityAddress });
  await addressReader({ kind: "ip", value: velocityAddress });

  const addressEntry = addressAudit.entries[0];

  expectEqual(addressAudit.entries.length, 1, "the second attempt from one address is a breach of a limit of two");
  expectEqual(addressEntry?.payload["subject"], "ip", "the entry names the address subject");
  expectEqual(addressEntry?.payload["card_fingerprint"], null, "with no card");
  expectEqual(addressEntry?.ipAddress, velocityAddress, "and the address in the entry's own field");
  expectEqual(JSON.stringify(addressEntry?.payload ?? {}).includes("113.9"), false, "the payload does not repeat the address");
  expectEqual(addressEntry === undefined ? true : auditEntryProblem(addressEntry) === null, true, "the address entry is valid too");

  // ---- the entry factory itself
  const reading: VelocityReading = {
    kind: "card",
    value: velocityFingerprint,
    hits: 5,
    limit: 5,
    windowStart: Date.parse("2026-11-01T10:00:00.000Z") / 1_000,
    windowSeconds: 3_600,
    exceeded: true,
    retryAfterSeconds: 3_570,
    firstBreach: true,
  };

  expectEqual(JSON.stringify(velocityAuditEntry(reading)), JSON.stringify(velocityAuditEntry(reading)), "the factory is a function of the reading");
  expectEqual(velocityAuditEntry({ ...reading, firstBreach: false }), null, "and writes nothing for a hit that is not the first breach");
  expectEqual(velocityAuditEntry({ ...reading, hits: 6, firstBreach: false }), null, "nor for the hit after it");
  expectEqual(velocityAuditEntry(reading, { ipAddress: velocityAddress })?.ipAddress, velocityAddress, "the caller's address is carried when it is given");

  // ---- a trail that fails never fails the payment
  const failingCounter = velocityCounter();
  const failingTrail: VelocityAuditTrail = {
    append: async (): Promise<void> => {
      throw new Error("audit store offline");
    },
  };
  const failingReader = createVelocityReader({
    rest: failingCounter.client,
    now: (): number => velocityFixedNow,
    policy: { card: { limit: 1, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } },
    audit: failingTrail,
  });

  const survived = await failingReader({ kind: "card", value: velocityCardToken });

  expectEqual(survived.hits, 1, "the counter moved before the audit entry was written");
  expectEqual(survived.limit, 1, "so the reading stands even when the audit writer is down");

  // ---- and no trail at all is no audit entry, not a failure
  const quietReader = createVelocityReader({
    rest: velocityCounter().client,
    now: (): number => velocityFixedNow,
    policy: { card: { limit: 1, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 3_600 } },
  });

  expectEqual((await quietReader({ kind: "card", value: velocityCardToken })).hits, 1, "a reader without a trail still counts");
}

interface FakeVelocitySweep {
  readonly client: VelocitySweepClient;
  readonly calls: { table: string; column: string; before: string }[];
}

function velocitySweeper(answer: number | (() => Promise<number>)): FakeVelocitySweep {
  const calls: { table: string; column: string; before: string }[] = [];

  return {
    calls,
    client: {
      deleteBefore: async (table: string, column: string, before: string): Promise<number> => {
        calls.push({ table, column, before });

        return typeof answer === "function" ? answer() : answer;
      },
    },
  };
}

async function checkVelocitySweep(): Promise<void> {
  const sweeper = velocitySweeper(3);
  const removed = await sweepVelocityWindows({ client: sweeper.client, now: (): number => velocityFixedNow });

  expectEqual(removed, 3, "the sweep answers what it removed");
  expectEqual(sweeper.calls.length, 1, "in one statement");
  expectEqual(sweeper.calls[0]?.table, VELOCITY_TABLE, "on the velocity table");
  expectEqual(sweeper.calls[0]?.column, "window_start", "by the window it starts at");
  expectEqual(sweeper.calls[0]?.before, "2026-10-02T10:00:30.000Z", "and everything older than the retention, which is thirty days");
  expectEqual(
    Date.parse(sweeper.calls[0]?.before ?? "") === velocityFixedNow - VELOCITY_RETENTION_SECONDS * 1_000,
    true,
    "the cutoff is the clock minus the retention, to the millisecond",
  );

  const shortRetention = await expectThrowsAsync(
    () => sweepVelocityWindows({ client: velocitySweeper(0).client, retentionSeconds: 60, now: (): number => velocityFixedNow }),
    "a retention shorter than the window it would delete is refused",
  );

  expectEqual(velocityReasonOf(shortRetention), "retention_invalid", "because deleting a live counter is the limit bypassed");
  expectEqual(shortRetention?.code, "INTERNAL_ERROR", "and it is a configuration mistake");

  const wideWindow = await expectThrowsAsync(
    () =>
      sweepVelocityWindows({
        client: velocitySweeper(0).client,
        policy: { card: { limit: 5, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: 86_400 } },
        retentionSeconds: 3_600,
        now: (): number => velocityFixedNow,
      }),
    "a retention shorter than the widest window in force is refused",
  );

  expectEqual(velocityReasonOf(wideWindow), "retention_invalid", "whatever the rule that has the wide window");

  const atTheWidest = await sweepVelocityWindows({
    client: velocitySweeper(0).client,
    policy: { card: { limit: 5, windowSeconds: 3_600 }, ip: { limit: 20, windowSeconds: VELOCITY_MAXIMUM_WINDOW_SECONDS } },
    retentionSeconds: VELOCITY_MAXIMUM_WINDOW_SECONDS,
    now: (): number => velocityFixedNow,
  });

  expectEqual(atTheWidest, 0, "the widest window is kept for its whole length and no longer");

  for (const [name, retention] of [
    ["a retention of zero", 0],
    ["a negative retention", -1],
    ["a fractional retention", 1.5],
  ] as const) {
    const refusal = await expectThrowsAsync(
      () => sweepVelocityWindows({ client: velocitySweeper(0).client, retentionSeconds: retention, now: (): number => velocityFixedNow }),
      `${name} is refused`,
    );

    expectEqual(velocityReasonOf(refusal), "retention_invalid", `${name} is a configuration mistake`);
  }

  const offline = await expectThrowsAsync(
    () =>
      sweepVelocityWindows({
        client: velocitySweeper(async (): Promise<number> => {
          throw new Error("connection reset");
        }).client,
        now: (): number => velocityFixedNow,
      }),
    "a sweep that cannot reach the store is a dependency failure",
  );

  expectEqual(offline?.code, "DEPENDENCY_FAILED", "rather than a sweep that removed nothing and said nothing");

  for (const [name, answer] of [
    ["a fractional count", 1.5],
    ["a negative count", -1],
    ["a count that is not a number", Number.NaN],
  ] as const) {
    const refusal = await expectThrowsAsync(
      () => sweepVelocityWindows({ client: velocitySweeper(answer).client, now: (): number => velocityFixedNow }),
      `${name} from the store is refused`,
    );

    expectEqual(velocityReasonOf(refusal), "response_invalid", `${name} is not a sweep result`);
  }

  const noClock = await expectThrowsAsync(
    () => sweepVelocityWindows({ client: velocitySweeper(0).client, now: (): number => Number.NaN }),
    "a sweep with no clock is refused",
  );

  expectEqual(velocityReasonOf(noClock), "clock_invalid", "because the cutoff would be meaningless");
}

async function checkVelocityWiring(): Promise<void> {
  const source = await readFile(new URL("./velocity.ts", import.meta.url), "utf8");
  const fraud = await readFile(new URL("./fraud.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../../migrations/0093_velocity_counter_consume.sql", import.meta.url), "utf8");
  const rollback = await readFile(new URL("../../migrations/0093_velocity_counter_consume.down.sql", import.meta.url), "utf8");
  const counters = await readFile(new URL("../../migrations/0056_velocity_counters.sql", import.meta.url), "utf8");
  const securityRoot = new URL("./", import.meta.url);
  const securityFiles = (await readdir(securityRoot)).filter((name) => name.endsWith(".ts"));

  expectEqual(source.split("\n")[0], "// path: lib/security/velocity.ts", "the module states its own path on its first line");
  expect(securityFiles.includes("velocity.ts"), "and it is one file in the security tree");
  expect(source.includes('from "./rate-limit.ts"'), "the address rule is STEP 062's, not a second parser");
  expect(source.includes("canonicalRateLimitAddress"), "which is the one function that decides an address");
  expect(source.includes('from "./fraud.ts"'), "and the counter speaks STEP 066's contract by importing its type");
  expectEqual(fraud.includes('from "./velocity.ts"'), false, "while the fraud module knows nothing of this one, so the arrow has one direction");
  expect(fraud.includes("readVelocity"), "the contract STEP 066 declares is the one this module fills");
  expect(source.includes('from "node:crypto"'), "a fingerprint is hashed here");
  expect(source.includes("createHash"), "with the platform's one digest");
  expectEqual(source.includes("console."), false, "nothing is logged, so no card and no address is");
  expectEqual(source.includes("process.env"), false, "the module reads no environment variable");
  expectEqual(source.includes("fetch("), false, "and makes no request");
  expectEqual(source.includes("supabase"), false, "the client is the caller's");
  expectEqual(source.includes("Math.random"), false, "and nothing is random");
  expectEqual(source.includes("card_number"), false, "no card number is named, because none may arrive");
  expectEqual(source.includes("cvv"), false, "and no CVV either");
  expectEqual(/:\s*any\b/u.test(source), false, "the module writes no any");
  expect(source.includes("velocityCardFingerprint"), "the fingerprint a payment page needs is exported, so hashing happens in one file");
  expect(source.includes("VELOCITY_DEFAULT_POLICY"), "the defaults are declared once");
  expectEqual(source.includes("delete from"), false, "the service writes no SQL of its own");
  expectEqual(source.includes("on conflict"), false, "the counting is the function's, not a statement assembled here");

  // ---- the migration and its rollback
  expectEqual((migration.match(/create function public\.consume_velocity/gu) ?? []).length, 1, "0093 defines the counting function once");
  expectEqual((migration.match(/on conflict \(card_fingerprint, window_start, window_seconds\)/gu) ?? []).length, 1, "with one branch for the card index");
  expectEqual((migration.match(/on conflict \(ip_address, window_start, window_seconds\)/gu) ?? []).length, 1, "and one for the address index");
  expect(migration.includes("where card_fingerprint is not null and deleted_at is null"), "each naming the partial index it infers");
  expect(migration.includes("where ip_address is not null and deleted_at is null"), "exactly as 0056 declares it");
  expectEqual((migration.match(/hit_count = counter_row\.hit_count \+ 1/gu) ?? []).length, 2, "both branches count one hit and not a count the caller sent");
  expectEqual((migration.match(/greatest\(counter_row\.last_hit_at, excluded\.last_hit_at\)/gu) ?? []).length, 2, "and move the last hit forward only");
  expectEqual((migration.match(/counter_row\.hit_count \+ 1 >= counter_row\.limit_value/gu) ?? []).length, 2, "writing the breach on the hit that reaches the limit");
  expectEqual((migration.match(/when counter_row\.exceeded_at is null/gu) ?? []).length, 2, "and only when no breach was written before");
  expectEqual((migration.match(/v_hits = v_limit;/gu) ?? []).length, 1, "the first breach is the count equal to the limit, so it happens once");
  expectEqual((migration.match(/v_hits >= v_limit,/gu) ?? []).length, 1, "and exceeded is the count reaching it");
  expectEqual(migration.includes("set search_path = ''"), true, "the function cannot be redirected by a caller's search path");
  expectEqual((migration.match(/public\./gu) ?? []).length >= 2, true, "every object it names is schema qualified");
  expectEqual(migration.includes("limit_value = "), false, "the update never rewrites the limit, which 0056 freezes");
  expectEqual(migration.includes("window_start = "), false, "nor the window");
  expectEqual(migration.includes("deleted_at = "), false, "nor retires a counter, which is the sweep's job");
  expectEqual(migration.includes("delete from"), false, "and a forward migration deletes no row");
  expectEqual(migration.includes("truncate"), false, "nor empties a table");
  expectEqual(rollback.includes("drop function if exists public.consume_velocity"), true, "the rollback removes exactly the function");
  expectEqual(rollback.includes(VELOCITY_TABLE), false, "and leaves the windows, which are 0056's record");

  // ---- the constants are the schema's, spelled once
  expectEqual(
    counters.includes(`window_seconds between ${VELOCITY_MINIMUM_WINDOW_SECONDS} and ${VELOCITY_MAXIMUM_WINDOW_SECONDS}`),
    true,
    "0056 states the window bounds, which this module's ceiling repeats",
  );
  expectEqual(counters.includes("^[0-9a-f]{64}$"), true, "but it is the table's pattern");
  expectEqual(counters.includes("company_id is null"), true, "the counter is the platform's, as the entry this module writes states");
  expectEqual(counters.includes("hit_count >= limit_value"), true, "and a breach is the count reaching the limit, which is the comparison here");

  // ---- one function counts velocity in the whole repository
  const migrationRoot = new URL("../../migrations/", import.meta.url);
  const definers: string[] = [];

  for (const file of (await readdir(migrationRoot)).filter((name) => name.endsWith(".sql"))) {
    const text = file.endsWith(".down.sql") ? "" : await readFile(new URL(file, migrationRoot), "utf8");

    if (text.includes("function public.consume_velocity")) {
      definers.push(file);
    }
  }

  expectEqual(definers.join(","), "0093_velocity_counter_consume.sql", "one migration in the tree defines the counter");

  const readers: string[] = [];

  for (const file of securityFiles) {
    if (file === "velocity.ts" || file === "verify.ts") {
      continue;
    }

    const text = await readFile(new URL(file, securityRoot), "utf8");

    if (text.includes("consume_velocity")) {
      readers.push(file);
    }
  }

  expectEqual(readers.length, 0, "and one module calls it, because two counters for one card would be two answers");
}

async function checkTree(): Promise<void> {
  const securityRoot = new URL("./", import.meta.url);
  const securityFiles = (await readdir(securityRoot)).filter((name) => name.endsWith(".ts"));

  expectEqual(securityFiles.includes("text.ts"), true, "the text rules are one file");
  expectEqual(securityFiles.includes("host.ts"), true, "the host rules are one file");
  expectEqual(securityFiles.includes("url.ts"), true, "the URL rules are one file");
  expectEqual(securityFiles.includes("html.ts"), true, "the rich text rules are one file");
  expectEqual(securityFiles.includes("ssrf.ts"), true, "the destination rule is one file");

  const htmlSource = await readFile(new URL("./html.ts", import.meta.url), "utf8");
  const urlSource = await readFile(new URL("./url.ts", import.meta.url), "utf8");

  expect(htmlSource.includes('from "./text.ts"'), "the rich text serialiser escapes through the text module");
  expect(htmlSource.includes('from "./url.ts"'), "and validates every link through the URL module");
  expect(urlSource.includes('from "./host.ts"'), "the URL module asks the host module about destinations");
  expect(urlSource.includes("node:crypto") === false, "the URL module needs no hashing");
  expectEqual(htmlSource.includes("dangerouslySetInnerHTML"), false, "the sanitiser never writes markup into a component");

  const ssrfSource = await readFile(new URL("./ssrf.ts", import.meta.url), "utf8");

  expect(ssrfSource.includes('from "node:dns/promises"'), "the destination rule resolves, because the string is not the answer");
  expect(ssrfSource.includes('from "./url.ts"'), "it asks the URL module what the string is");
  expect(ssrfSource.includes('from "./host.ts"'), "and the host module what an address is");
  expectEqual(ssrfSource.includes("network: ["), false, "so no address range is written a second time here");
  expectEqual(ssrfSource.includes("fetch("), false, "and it never dials: it decides, and the transport dials");

  const appRoot = new URL("../../", import.meta.url);
  const appEntries = (await readdir(appRoot, { recursive: true }))
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => (entry.startsWith("app/") || entry.startsWith("components/")) && (entry.endsWith(".ts") || entry.endsWith(".tsx")));

  let trustedMarkup = 0;

  for (const entry of appEntries) {
    const source = await readFile(new URL(entry, appRoot), "utf8");
    const uses = source.split("dangerouslySetInnerHTML=").length - 1;

    // The theme script of the root layout is a constant in this repository, not an input: it is the one
    // place the platform writes markup from a string, and it is asserted to be that and nothing else.
    if (uses > 0 && entry !== "app/layout.tsx") {
      failures.push(`unexpected dangerouslySetInnerHTML in ${entry}`);
    }

    trustedMarkup += uses;

    if (uses > 0) {
      expect(source.includes("__html: THEME_SCRIPT"), `${entry} writes only the static theme script`);
    }
  }

  checks += 1;

  if (trustedMarkup !== 1) {
    failures.push(`exactly one component writes markup from a string (found ${trustedMarkup})`);
  } else {
    checks += 1;
  }
}

async function main(): Promise<void> {
  checkText();
  checkHosts();
  checkUrls();
  checkRichText();
  const outbound = checkOutboundStrings();

  await checkOutboundAddresses(outbound);
  checkCsp();
  checkSecurityHeaders();
  checkUploadValidator();
  checkRateLimitTable();
  checkRateLimitAddresses();
  checkRateLimitRoutes();
  checkRateLimitBuckets();
  checkRateLimitReports();
  checkAuditPolicy();
  checkAuditRedaction();
  checkAuditEntry();
  checkEncryptionKeys();
  checkEncryptionSecrets();
  checkEncryptionFiles();
  checkPortalTokenKeys();
  checkPortalTokenMint();
  checkPortalTokenOpen();
  checkPortalTokenRevocation();
  checkFraudVocabulary();
  await checkCspWiring();
  await checkSecurityHeaderWiring();
  await checkUploadWiring();
  await checkRateLimitDecision();
  await checkRateLimitWiring();
  await checkAuditWriter();
  await checkAuditIntegrity();
  await checkAuditWiring();
  await checkEncryptionWiring();
  await checkPortalTokenWiring();
  await checkFraudAttempts();
  await checkFraudSignals();
  await checkFraudLookups();
  await checkFraudAudit();
  await checkFraudWiring();
  checkVelocityVocabulary();
  await checkVelocityConsumption();
  await checkVelocityAudit();
  await checkVelocitySweep();
  await checkVelocityWiring();
  await checkTree();

  if (failures.length > 0) {
    process.stderr.write(`security gate failed with ${failures.length} problem(s):\n`);

    for (const failure of failures) {
      process.stderr.write(`  - ${failure}\n`);
    }

    process.exitCode = 1;

    return;
  }

  process.stdout.write(
    `security gate passed: ${checks} checks, ${TEXT_LIMITS.singleLine} code point name ceiling, ` +
      `${ALLOWED_RICH_TEXT_TAGS.length} allowed tags\n`,
  );
}

await main();
