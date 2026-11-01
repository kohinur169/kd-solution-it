// path: lib/security/verify.ts
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
  await checkCspWiring();
  await checkSecurityHeaderWiring();
  await checkUploadWiring();
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
