import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt, summarizeChecks, normalizeHostInput, isValidPublicHost, fetchLlmsTxt, findLinkRelations, validateV2Discovery, validateHost, cut } from "../src/index.mjs";
import { execFileSync, spawnSync } from "node:child_process";

const good = (text, extra = {}) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false, ...extra });
const byId = (checks, id) => checks.find((c) => c.id === id);

test("a well-formed llms.txt is valid", () => {
  const text = "# Example\n\n> One line about the site.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(summarizeChecks(checks), "valid");
  assert.equal(checks.length, 8);
  for (const c of checks) assert.equal(c.status, "pass");
});

test("an off-host redirect fails the first check and stops", () => {
  const checks = validateLlmsTxt({ redirect: true, reason: "off-host", status: 301, location: "https://example.com/llms.txt" });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "fail");
  assert.match(checks[0].detail, /different host/);
  assert.equal(summarizeChecks(checks), "not valid");
});

test("a followed same-site redirect still validates and notes the hop", () => {
  const text = "# Example\n\n> One line.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
  const checks = validateLlmsTxt(good(text, { redirectedFrom: "https://example.com/llms.txt", finalUrl: "https://www.example.com/llms.txt" }));
  const http = byId(checks, "http-status");
  assert.equal(http.status, "pass");
  assert.match(http.detail, /followed a redirect/);
  assert.equal(summarizeChecks(checks), "valid");
});

test("non-200 fails and stops", () => {
  const checks = validateLlmsTxt({ status: 404, contentType: "", text: "", bytes: 0, truncated: false });
  assert.equal(checks.length, 1);
  assert.equal(summarizeChecks(checks), "not valid");
});

test("an HTML body fails as not-plain-text and stops after http-status", () => {
  const checks = validateLlmsTxt(good("<!doctype html><html><body>hi</body></html>"));
  assert.equal(byId(checks, "content-type").status, "fail");
  assert.equal(checks.length, 2);
});

test("missing H1 fails, missing summary warns", () => {
  const checks = validateLlmsTxt(good("Just some text\n\n## Section\n"));
  assert.equal(byId(checks, "h1-title").status, "fail");
  assert.equal(byId(checks, "summary").status, "warn");
  assert.equal(summarizeChecks(checks), "not valid");
});

test("relative links warn with a count", () => {
  const text = "# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n- [b](/relative)\n";
  const checks = validateLlmsTxt(good(text));
  const links = byId(checks, "links");
  assert.equal(links.status, "warn");
  assert.match(links.detail, /1 relative/);
  assert.equal(summarizeChecks(checks), "valid with warnings");
});

test("large but not truncated warns on size", () => {
  const text = "# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n" + "x".repeat(60000);
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "size").status, "warn");
});

test("truncated read warns on size", () => {
  const checks = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n", { truncated: true }));
  assert.equal(byId(checks, "size").status, "warn");
});

test("inline HTML warns", () => {
  const checks = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n<div>hi</div>\n"));
  assert.equal(byId(checks, "no-html").status, "warn");
});

test("host normalization and public-host gate", () => {
  assert.equal(normalizeHostInput("Example.com"), "example.com");
  assert.equal(normalizeHostInput("https://example.com/path"), "example.com");
  assert.equal(normalizeHostInput("ftp://example.com"), null);
  assert.equal(isValidPublicHost("example.com"), true);
  assert.equal(isValidPublicHost("127.0.0.1"), false);
  assert.equal(isValidPublicHost("intranet.local"), false);
});

function mkRedirect(status, location) {
  return { status, headers: { get: (k) => (k.toLowerCase() === "location" ? location : null) }, body: null };
}

function mkOk(text) {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  const body = { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {} }) };
  return { status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/plain; charset=utf-8" : null) }, body };
}

test("fetchLlmsTxt follows a same-site www redirect to 200", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => (u === "https://ex.com/llms.txt" ? mkRedirect(301, "https://www.ex.com/llms.txt") : mkOk("# Ex\n"));
  try {
    const f = await fetchLlmsTxt("ex.com");
    assert.equal(f.status, 200);
    assert.equal(f.redirectedFrom, "https://ex.com/llms.txt");
    assert.equal(f.finalUrl, "https://www.ex.com/llms.txt");
  } finally { globalThis.fetch = orig; }
});

test("fetchLlmsTxt refuses an off-host redirect", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => mkRedirect(301, "https://evil.example/llms.txt");
  try {
    const f = await fetchLlmsTxt("ex.com");
    assert.equal(f.redirect, true);
    assert.equal(f.reason, "off-host");
  } finally { globalThis.fetch = orig; }
});

test("fetchLlmsTxt refuses a non-https redirect", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => mkRedirect(302, "http://ex.com/llms.txt");
  try {
    const f = await fetchLlmsTxt("ex.com");
    assert.equal(f.reason, "unsafe-target");
  } finally { globalThis.fetch = orig; }
});

test("fetchLlmsTxt caps redirect chains", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => mkRedirect(301, u === "https://ex.com/llms.txt" ? "https://www.ex.com/llms.txt" : "https://ex.com/llms.txt");
  try {
    const f = await fetchLlmsTxt("ex.com");
    assert.equal(f.reason, "too-many");
  } finally { globalThis.fetch = orig; }
});

// v2 discovery. These read the site rather than the file, so the point of every case
// below is the same one: whatever they report, the summary and the exit code must not
// move. A check that quietly turned every valid file into "valid with warnings" would
// have changed which files pass, which is a decision and not a measurement.

test("findLinkRelations reads both relations from a head", () => {
  const html = `<!doctype html><html><head>
    <link rel="canonical" href="https://ex.com/page" />
    <link rel="alternate" href="https://ex.com/page.md" type="text/markdown" />
    <link rel="describedby" href="/llms.txt" />
    </head><body><link rel="describedby" href="/decoy.txt"></body></html>`;
  const f = findLinkRelations(html, "");
  assert.equal(f.markdown, "https://ex.com/page.md");
  assert.equal(f.describedby, "/llms.txt");
});

test("findLinkRelations reads both relations from a Link header", () => {
  const hdr = '</openapi.json>; rel="service-desc"; type="application/json", </page.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"; type="text/plain"';
  const f = findLinkRelations("", hdr);
  assert.equal(f.markdown, "/page.md");
  assert.equal(f.describedby, "/llms.txt");
});

test("findLinkRelations does not accept an alternate of the wrong type", () => {
  const html = '<head><link rel="alternate" type="application/rss+xml" href="/feed.xml" /></head>';
  assert.equal(findLinkRelations(html, "").markdown, null);
  assert.equal(findLinkRelations("", '</feed.xml>; rel="alternate"; type="application/rss+xml"').markdown, null);
});

test("v2 checks are info when absent and never change the summary", () => {
  const text = "# Example\n\n> One line about the site.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
  const file = validateLlmsTxt(good(text));
  const both = file.concat(validateV2Discovery(findLinkRelations("<head></head>", "")));
  assert.equal(both.length, 10);
  assert.deepEqual(both.slice(8).map((c) => c.status), ["info", "info"]);
  assert.equal(summarizeChecks(both), "valid");
  assert.equal(summarizeChecks(file), summarizeChecks(both));
});

test("v2 checks pass when the relations are there, and say why when the page was not read", () => {
  const found = findLinkRelations('<head><link rel="describedby" href="/llms.txt"><link rel="alternate" type="text/markdown" href="/index.md"></head>', "");
  assert.deepEqual(validateV2Discovery(found).map((c) => c.status), ["pass", "pass"]);
  const unread = validateV2Discovery(null, "the home page returned HTTP 500, so this was not measured");
  assert.deepEqual(unread.map((c) => c.status), ["info", "info"]);
  for (const c of unread) assert.match(c.detail, /not measured/);
  assert.equal(summarizeChecks(unread), "valid");
});

// Adversarial inputs for the parser. The first two are the ones an independent
// review found on the day this shipped: a commented-out link element counted as
// published, and an unquoted href read as missing while its rel and type were read
// fine. Both would have reported a relation the site does not actually serve, or
// reported one without its target, which is the single thing a measurement of
// someone else's site may not do.

test("a commented-out link element is not a published relation", () => {
  const html = '<head><!-- <link rel="alternate" type="text/markdown" href="/commented.md"> --><!--<link rel="describedby" href="/x.txt">--></head>';
  assert.deepEqual(findLinkRelations(html, ""), { describedby: null, markdown: null });
});

test("an unterminated comment hides the rest of the document", () => {
  const html = '<head><!-- <link rel="describedby" href="/x.txt"><link rel="alternate" type="text/markdown" href="/x.md">';
  assert.deepEqual(findLinkRelations(html, ""), { describedby: null, markdown: null });
});

// The shapes below were measured against parse5, a real HTML parser, on the day the
// comment stripping was rewritten. Both directions are wrong answers: counting a
// relation the page does not publish, and hiding one it does.
test("script and style are raw text, so a link element after them is published", () => {
  assert.equal(findLinkRelations('<head><script><!--\nvar x = 1;\n</script><link rel="describedby" href="/real">', "").describedby, "/real");
  assert.equal(findLinkRelations('<head><style><!-- .a{} </style><link rel="describedby" href="/real">', "").describedby, "/real");
  assert.equal(findLinkRelations('<head><script>var s = "<link rel=describedby href=/nope>";</script>', "").describedby, null);
  assert.equal(findLinkRelations('<head><script>var x = 1;<link rel="describedby" href="/nope">', "").describedby, null);
});

test("the strip is one pass, so a comment that mentions a script tag is only a comment", () => {
  const html = '<head><!-- put your <script> tag here --><link rel="alternate" type="text/markdown" href="/found"><script>var r = 1;</script></head>';
  assert.equal(findLinkRelations(html, "").markdown, "/found");
});

test("a link tag written inside a title is text, not markup", () => {
  assert.equal(findLinkRelations('<head><title>How to use <link rel=describedby> for llms.txt</title></head>', "").describedby, null);
  assert.equal(findLinkRelations('<head><title>How to use <link rel=describedby></title><link rel="describedby" href="/real"></head>', "").describedby, "/real");
});

// The tag scan is by index, not by /<link\b[^>]*>/g, because that regex is quadratic on
// input the target site controls. CodeQL reports the same shape as js/polynomial-redos.
test("unclosed tags do not slow the scan down", () => {
  const t0 = Date.now();
  assert.deepEqual(findLinkRelations("<link".repeat(52428), ""), { describedby: null, markdown: null });
  assert.deepEqual(findLinkRelations("<script".repeat(37449), ""), { describedby: null, markdown: null });
  assert.deepEqual(findLinkRelations("", "<".repeat(65536)), { describedby: null, markdown: null });
  assert.ok(Date.now() - t0 < 2000, "256 KB of unclosed tags must not take seconds");
  // "<link<link<link rel=..." is ONE tag whose NAME is "link<link<link", not a link
  // element, so nothing is published. A real link element after a closed tag is read.
  assert.equal(findLinkRelations('<head><link<link<link rel="describedby" href="/real">', "").describedby, null);
  assert.equal(findLinkRelations('<head><meta charset="utf-8"><link rel="describedby" href="/real">', "").describedby, "/real");
});

test("shapes a 200 000 input fuzz run against parse5 turned up (Tek-127)", () => {
  // A "<" that no letter follows is text, and the tag after it is still a tag.
  assert.equal(findLinkRelations('<head><<style><link rel="describedby" href="/x"></style>', "").describedby, null);
  assert.equal(findLinkRelations('<head><<link rel="describedby" href="/real">', "").describedby, null);
  // A ">" inside a quoted attribute value does not end the tag.
  assert.equal(findLinkRelations('<head><link data-x="a>b" rel="describedby" href="/q">', "").describedby, "/q");
  assert.equal(findLinkRelations('<head><link rel="describedby" href="/a>b">', "").describedby, "/a>b");
  // </script/> closes a raw text element as well.
  assert.equal(findLinkRelations('<head><script>var s = "x";</script/><link rel="describedby" href="/real">', "").describedby, "/real");
});

test("three shapes an independent fuzz round found", () => {
  // After </head> the parser is in "after head", where noscript opens the body.
  assert.equal(findLinkRelations('<head></head><noscript><link rel=describedby href=/a></noscript><link rel=describedby href=/z>', "").describedby, null);
  // "</templateX" is not an end tag: the name runs on to the next ">".
  assert.equal(findLinkRelations('<head><template></templateX</template><link rel=describedby href=/z></head>', "").describedby, null);
  // Inside a script, <!-- and a nested <script> mean </script> ends the escape, not the element.
  assert.equal(findLinkRelations('<head><script><!-- <script>x</script> --></script><link rel=describedby href=/real>', "").describedby, "/real");
  // A million characters of "</templateX" used to take 15 seconds; it is linear now.
  const t0 = Date.now();
  assert.equal(findLinkRelations('<head><template>' + "</templateX".repeat(95000), "").describedby, null);
  assert.ok(Date.now() - t0 < 2000, "an unclosed template must not take seconds");
});

test("a link element inside a template is inert, not published", () => {
  assert.equal(findLinkRelations('<head><template><link rel="describedby" href="/inert"></template></head>', "").describedby, null);
  assert.equal(findLinkRelations('<head><template><link rel="describedby" href="/inert"></template><link rel="describedby" href="/real"></head>', "").describedby, "/real");
});

test("an empty comment is not an unterminated one", () => {
  assert.equal(findLinkRelations('<head><!--><link rel="describedby" href="/after">', "").describedby, "/after");
  assert.equal(findLinkRelations('<head><!---><link rel="describedby" href="/after">', "").describedby, "/after");
  assert.equal(findLinkRelations('<head><!----><link rel="describedby" href="/after">', "").describedby, "/after");
  assert.equal(findLinkRelations('<head><!-- x --!><link rel="describedby" href="/after">', "").describedby, "/after");
});

test("an unquoted href is read, not reported as missing", () => {
  const f = findLinkRelations("<head><link rel=alternate type=text/markdown href=/noquotes.md></head>", "");
  assert.equal(f.markdown, "/noquotes.md");
});

test("the parser survives the shapes a real page throws at it", () => {
  assert.equal(findLinkRelations('<head><link rel="alternate" type="text/markdown; charset=utf-8" href="/a.md"></head>', "").markdown, "/a.md");
  assert.equal(findLinkRelations('<head><link rel="alternate stylesheet" type="text/css" href="/a.css"></head>', "").markdown, null);
  assert.equal(findLinkRelations('<head><link rel="DescribedBy" HREF="/LLMS.txt"></head>', "").describedby, "/LLMS.txt");
  // No </head> at all: the body is scanned rather than reporting nothing found.
  assert.equal(findLinkRelations('<link rel="describedby" href="/llms.txt">', "").describedby, "/llms.txt");
  // A comma inside the URL of a Link header must not split the header value.
  const hdr = '</a,b.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"';
  const f = findLinkRelations("", hdr);
  assert.equal(f.markdown, "/a,b.md");
  assert.equal(f.describedby, "/llms.txt");
});

test("validateHost cannot be pointed at another path by its caller options", async () => {
  const orig = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (u) => {
    asked.push(String(u));
    return new Response("# Example\n\n> One line.\n\n## Docs\n\n- [G](https://ex.com/g)\n", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    await validateHost("ex.com", { path: "/somewhere-else", accept: "text/html" });
    assert.equal(asked[0], "https://ex.com/llms.txt", "the first read is pinned to /llms.txt");
    assert.equal(asked[1], "https://ex.com/", "the second read is pinned to the home page");
  } finally { globalThis.fetch = orig; }
});

// Kuusi virhehyvaksyntaa, mitattu 2026-08-29. Jokainen naista palautti aiemmin passin,
// eli validaattori sanoi kelvolliseksi tiedoston joka rikkoo formaattia. Jokaisella on
// tassa myos positiivikontrolli, jotta testi ei voi menna vihreaksi siksi etta tarkistus
// on aina punainen (mds/gotchas.md 2026-08-10 (jatko 1)).
test("an indented code block is not the H1", () => {
  const bad = validateLlmsTxt(good("    # Site\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n"));
  assert.equal(byId(bad, "h1-title").status, "fail");
  const okay = validateLlmsTxt(good("   # Site\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n"));
  assert.equal(byId(okay, "h1-title").status, "pass", "three spaces is still a heading");
});

test("a section needs a file list, not a paragraph with a link in it", () => {
  const bad = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\nRead [a](https://a.example/x) first.\n"));
  assert.equal(byId(bad, "sections").status, "warn");
  assert.match(byId(bad, "sections").detail, /no file list/);
  const okay = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n"));
  assert.equal(byId(okay, "sections").status, "pass");
  assert.match(byId(okay, "sections").detail, /1 carrying a file list/);
});

test("an entry with an empty link name is not a usable link", () => {
  const bad = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [](https://a.example/x)\n"));
  assert.equal(byId(bad, "links").status, "warn");
  assert.match(byId(bad, "links").detail, /empty link name/);
  const okay = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n"));
  assert.equal(byId(okay, "links").status, "pass");
});

test("a scheme without a host is not an absolute link", () => {
  const bad = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [a](https://)\n"));
  assert.equal(byId(bad, "links").status, "warn");
  assert.match(byId(bad, "links").detail, /no host/);
  const okay = validateLlmsTxt(good("# T\n\n> s\n\n## L\n\n- [a](https://a.example/x)\n"));
  assert.equal(byId(okay, "links").status, "pass");
});

test("data-rel and data-href are not the link relations", () => {
  const f = findLinkRelations('<html><head><link data-rel="describedby" data-href="/llms.txt"><link data-rel="alternate" data-type="text/markdown" data-href="/a.md"></head></html>', "");
  assert.equal(f.describedby, null);
  assert.equal(f.markdown, null);
  const real = findLinkRelations('<html><head><link rel="describedby" href="/llms.txt"><link rel="alternate" type="text/markdown" href="/a.md"></head></html>', "");
  assert.equal(real.describedby, "/llms.txt");
  assert.equal(real.markdown, "/a.md");
});

test("a relation without a target, and a media type that only starts right, are not relations", () => {
  const noHref = findLinkRelations('<html><head><link rel="describedby"></head></html>', "");
  assert.equal(noHref.describedby, null);
  const nearlyMarkdown = findLinkRelations('<html><head><link rel="alternate" type="text/markdownish" href="/a.md"></head></html>', "");
  assert.equal(nearlyMarkdown.markdown, null);
  const withParam = findLinkRelations('<html><head><link rel="alternate" type="text/markdown;charset=utf-8" href="/a.md"></head></html>', "");
  assert.equal(withParam.markdown, "/a.md", "a media type parameter is still text/markdown");
});

test("a cut never ends in a lone high surrogate", () => {
  const s = "a".repeat(79) + "\u{1F600}" + "b".repeat(20);
  assert.equal(cut(s, 80), "a".repeat(79), "the cut lands inside the pair, so the pair is dropped whole");
  assert.equal(cut(s, 81), "a".repeat(79) + "\u{1F600}", "a cut after the pair keeps it");
  assert.equal(cut("abc", 80), "abc");
  assert.ok(Buffer.from(cut(s, 80), "utf8").toString("utf8") === cut(s, 80), "the result round-trips as UTF-8");
  const h1 = "# " + "x".repeat(78) + "\u{1F600}y\n\n> s\n\n## D\n\n- [a](https://example.com/a)\n";
  const detail = byId(validateLlmsTxt(good(h1)), "h1-title").detail;
  assert.ok(!/[\uD800-\uDBFF]$/.test(JSON.parse(detail)), "the H1 detail is cut on a code point boundary");
});

test("the CLI answers an error as JSON when --json was asked for", () => {
  const cli = new URL("../bin/cli.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [cli, "not a host", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "", "nothing on stderr in JSON mode");
  const body = JSON.parse(r.stdout);
  assert.match(body.error, /not a public domain name/);
  const plain = spawnSync(process.execPath, [cli, "not a host"], { encoding: "utf8" });
  assert.equal(plain.status, 2);
  assert.equal(plain.stdout, "");
  assert.match(plain.stderr, /^error: not a public domain name/);
});
