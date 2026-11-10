import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateHost } from "../src/index.js";
import { assertLinear } from "./growth.js";

// Search layer, discovery HTML and limits, round S3 (outside audit 2026-11-05, Tek-546). The hosted
// validator carries the same inputs and expectations in test/validator-sol-s3b.test.ts in the
// turva-worker repo. Each test name starts with the audit item it covers, except the cases of
// the discovery table, whose names start with the word "discovery".

type Check = { id: string; status: string; label: string; detail: string; value?: string };

async function runVia(typed: string, fetcher: (url: string, init?: RequestInit) => Response | Promise<Response>): Promise<{ error: string | null; target: string; summary: string; checks: Check[] }> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => fetcher(String(url), init)) as typeof fetch;
  try {
    const out = await validateHost(typed);
    return { error: null, target: out.target, summary: out.summary, checks: out.checks as Check[] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), target: "", summary: "", checks: [] };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---- shared body: identical in the hosted test and in the package test except one comment line in the scan cost section, which
// ---- names test/growth.ts in the package test, where the hosted test has the helper inline ----
type Routes = (url: string, init?: RequestInit) => Response | Promise<Response>;
type Run = { error: string | null; target: string; summary: string; checks: Check[]; log: string[] };

const GOOD = "# Example\n\n> Summary of the site.\n\n## Docs\n\n- [Guide](https://example.com/guide): the guide\n";
const resp = (text: string, status = 200, headers: Record<string, string> = {}) => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
const html = (text: string, status = 200, headers: Record<string, string> = {}) => new Response(text, { status, headers: { "content-type": "text/html", ...headers } });

async function run(typed: string, routes: Routes): Promise<Run> {
  const log: string[] = [];
  const out = await runVia(typed, (u, init) => {
    log.push(u);
    return routes(u, init);
  });
  return { ...out, log };
}

function plain(u: string): Response {
  if (u === "https://example.com/llms.txt") return resp(GOOD);
  if (u === "https://example.com/") return html("<head></head>");
  throw new Error("unexpected fetch to " + u);
}

// What the two v2 discovery checks report for a home page and a Link header.
async function rel(home: string, link = ""): Promise<{ describedby: string | null; markdown: string | null; detail: string }> {
  const r = await run("example.com", (u) => {
    if (u === "https://example.com/llms.txt") return resp(GOOD);
    if (u === "https://example.com/") return html(home, 200, link ? { link } : {});
    throw new Error("unexpected fetch to " + u);
  });
  assert.equal(r.error, null);
  const d = r.checks.find((c) => c.id === "v2-describedby")!;
  const m = r.checks.find((c) => c.id === "v2-markdown-alternate")!;
  return {
    describedby: d.status === "pass" ? d.detail.replace(/^.* to /, "") : null,
    markdown: m.status === "pass" ? m.detail.replace(/^.* to /, "") : null,
    detail: d.detail,
  };
}
const L = (h: string) => "<link rel=describedby href=" + h + ">";

// ---- LV-20: the typed address is parsed whole, only what is shown is cut ----
test("LV-20: an address longer than 300 characters is judged whole, as the package judges it", async () => {
  const cred = await run("example.com:" + "0".repeat(285) + "443@evil.com", plain);
  assert.match(cred.error || "", /public domain name/);
  assert.equal(cred.log.length, 0);
  const invalid = await run("example.com" + String.fromCodePoint(0xad).repeat(289) + ".invalid", plain);
  assert.match(invalid.error || "", /public domain name/);
  assert.equal(invalid.log.length, 0);
  const zwsp = await run("example.com" + String.fromCodePoint(0x200b).repeat(289) + ".invalid", plain);
  assert.match(zwsp.error || "", /public domain name/);
  assert.equal(zwsp.log.length, 0);
  const port = await run("example.com:" + "0".repeat(286) + "443", plain);
  assert.equal(port.error, null);
  assert.equal(port.target, "https://example.com/llms.txt");
  const path = await run("example.com/" + "a".repeat(300) + "/../llms.txt", plain);
  assert.equal(path.error, null);
  assert.equal(path.target, "https://example.com/llms.txt");
  assert.equal(path.checks.some((c) => c.id === "input-path"), false);
});

test("LV-20 control: a short address with credentials is refused and a plain domain is read", async () => {
  const cred = await run("example.com:0443@evil.com", plain);
  assert.match(cred.error || "", /public domain name/);
  assert.equal(cred.log.length, 0);
  const ok = await run("example.com", plain);
  assert.equal(ok.error, null);
  assert.equal(ok.target, "https://example.com/llms.txt");
  assert.equal(ok.log.length, 2);
  const long = await run("example.com/?q=" + "x".repeat(400), plain);
  assert.equal(long.error, null);
  assert.equal(long.target, "https://example.com/llms.txt");
});

// ---- LV-22: a same-site redirect written with a trailing dot ----
async function redirectRun(location: string): Promise<Run> {
  let calls = 0;
  return run("example.com", (u) => {
    if (u.endsWith("/llms.txt")) {
      calls++;
      return calls === 1 ? new Response("", { status: 302, headers: { location } }) : resp(GOOD);
    }
    return html("<head></head>");
  });
}
test("LV-22: a redirect to the same site with a trailing dot in the host is followed", async () => {
  for (const location of ["https://example.com./llms.txt", "https://www.example.com./llms.txt"]) {
    const r = await redirectRun(location);
    assert.equal(r.error, null, location);
    assert.equal(r.summary, "valid", location);
    const s = r.checks.find((c) => c.id === "http-status")!;
    assert.equal(s.status, "pass", location);
    assert.match(s.detail, /followed a redirect/, location);
    assert.equal(r.log[1], location.replace("./", "/"), location);
  }
});

test("LV-22 control: other hosts, a second dot and the plain forms keep their verdicts", async () => {
  const off = await redirectRun("https://evil.example./llms.txt");
  assert.equal(off.checks.find((c) => c.id === "http-status")!.status, "fail");
  assert.match(off.checks.find((c) => c.id === "http-status")!.detail, /a different host/);
  const two = await redirectRun("https://example.com../llms.txt");
  assert.match(two.checks.find((c) => c.id === "http-status")!.detail, /unsupported target/);
  for (const location of ["https://example.com/llms.txt", "https://www.example.com/llms.txt"]) {
    const r = await redirectRun(location);
    assert.equal(r.summary, "valid", location);
    assert.match(r.checks.find((c) => c.id === "http-status")!.detail, /followed a redirect/, location);
  }
});

// ---- discovery in the home page head ----
// [name, home page, Link header, describedby the check should report (null for none)]
const DISCOVERY: [string, string, string, string | null][] = [
  // LV-23 / WL-17 A: the comment close that changes the script state
  ["LV-23 comment closed by --> after a space", "<head><script><!-- -->\nconst s=\"<script>\";</script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-23 --> on its own line", "<head><script><!--\n-->var a=\"<script>\";</script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["WL-17 A", "<head><script><!--x-->var x=\"<script>\";</script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["WL-17 two comments", "<head><script><!--\n--><!--x--> var a=\"<script>\";</script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-23 control plain script", "<head><script>var a=1;</script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-23 control legacy shape", "<head><script><!-- var a=1; //--></script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-23 control nested script in a comment", "<head><script><!-- <script>x</script> --></script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  // LV-24 / WL-17 B: a name suffix does not end double escaping
  ["LV-24 </scriptX> stays double escaped", "<head><script><!--<script></scriptX></script>" + L("/fake") + "</script></head>", "", null],
  ["WL-17 B", "<head><script><!-- <script> </scriptX> </script>" + L("/fake.txt") + " --></script></head>", "", null],
  ["LV-24 control </script> ends double escaping", "<head><script><!--<script></script></script>" + L("/real") + "</head>", "", "/real"],
  ["LV-24 </script > ends double escaping", "<head><script><!--<script></script ></script>" + L("/real") + "</head>", "", "/real"],
  ["LV-24 </script/> ends double escaping", "<head><script><!--<script></script/></script>" + L("/real") + "</head>", "", "/real"],
  // LV-25 / WL-18: end tags with attributes
  ["LV-25 script end tag with an attribute", "<head><script>x</script data-x>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["WL-18 script end tag foo=bar", "<head><script>x</script foo=bar>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 template end tag with an attribute", "<head><template></template data-x>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 style end tag with an attribute", "<head><style>x</style foo>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["WL-18 style end tag foo=bar", "<head><style>x</style foo=bar>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["WL-18 title end tag with an attribute", "<head><title>x</title foo>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 a quoted > in an end tag attribute", "<head><script>x</script foo=\"a>b\">" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 </scriptx> does not close", "<head><script>x</scriptx>" + L("/fake") + "</script></head>", "", null],
  ["LV-25 two template end tags with attributes", "<head><template><template></template data-x></template data-y>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 control </script>", "<head><script>x</script>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 control </script/>", "<head><script>x</script/>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 control </style >", "<head><style>x</style >" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-25 control </templateX</template> is one unknown end tag", "<head><template></templateX</template>" + L("/fake") + "</head>", "", null],
  // LV-26 / U-8 / WL-16: quoted attribute text inside a template is not markup
  ["LV-26 title holds </template>", "<head><template><div title=\"</template>" + L("/fake") + "\"></div></template></head>", "", null],
  ["LV-26 title holds <template>", "<head><template><div title=\"<template>\"></div></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["U-8 title holds <!--", "<head><template><div title=\"<!--\"></div></template>" + L("/real") + "</head>", "", "/real"],
  ["WL-16 A", "<head><template><template data-x=\"</template>\"></template>" + L("/fake.txt") + "</template></head>", "", null],
  ["WL-16 B", "<head><template><div data-x=\"<script>\"></div></template>" + L("/live.txt") + "</head>", "", "/live.txt"],
  ["WL-16 nested template with a quoted close", "<head><template><template><div title=\"</template>\"></div></template>" + L("/fake") + "</template>" + L("/real") + "</head>", "", "/real"],
  ["LV-26 a quoted > in a template tag", "<head><template><div title=\"a>b\"></div></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-26 a template start tag with a quoted <", "<head><template><template data-x=\"<script>\"></template></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-26 a bogus comment holds a template start tag", "<head><template><!x \"<template>\"></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-26 control without attributes", "<head><template><div></div></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-26 control nested templates", "<head><template><template></template></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  // LV-27: foreign content inside a template
  ["LV-27 svg title/", "<head><template><svg><title/></svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 svg script/", "<head><template><svg><script/></svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 math style/", "<head><template><math><style/></math></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 svg with an unquoted slash value is open", "<head><template><svg a=b/><title/>x</svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 a self-closing svg opens no foreign content", "<head><template><svg/><title><template></title></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 title after the svg is raw text again", "<head><template><svg><title/></svg><title><template></title></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 foreignObject makes title raw text again", "<head><template><svg><foreignObject><title></template>" + L("/real") + "</head>", "", null],
  ["LV-27 svg desc is an integration point", "<head><template><svg><desc><title></template>" + L("/real") + "</head>", "", null],
  ["LV-27 svg title is an integration point", "<head><template><svg><title><title></template>" + L("/real") + "</head>", "", null],
  ["LV-27 math mi is an integration point", "<head><template><math><mi><title></template>" + L("/real") + "</head>", "", null],
  ["LV-27 math mtext is an integration point", "<head><template><math><mtext><style></template>" + L("/real") + "</head>", "", null],
  ["LV-27 annotation-xml text/html is an integration point", "<head><template><math><annotation-xml encoding=\"text/html\"><title></template>" + L("/real") + "</head>", "", null],
  ["LV-27 annotation-xml xhtml is an integration point", "<head><template><math><annotation-xml encoding=application/xhtml+xml><title></template>" + L("/real") + "</head>", "", null],
  ["LV-27 annotation-xml with another encoding is foreign", "<head><template><math><annotation-xml encoding=\"application/x-tex\"><title/></annotation-xml></math></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 a new svg inside an integration point is foreign again", "<head><template><svg><foreignObject><svg><title/></svg></foreignObject></svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 the integration point ends with its element", "<head><template><svg><foreignObject></foreignObject><title/></svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 control math title/", "<head><template><math><title/></math></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 control svg path", "<head><template><svg><path/></svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 control svg title element", "<head><template><svg><title>Icon</title></svg></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-27 control html title/ is raw text", "<head><template><title/></template>" + L("/fake") + "</head>", "", null],
  // LV-28: plaintext swallows the rest of the document
  ["LV-28 plaintext inside a template", "<head><template><plaintext></template>" + L("/fake") + "</head>", "", null],
  ["LV-28 plaintext with attributes", "<head><template><plaintext x=1></template>" + L("/fake") + "</head>", "", null],
  ["LV-28 control paragraph", "<head><template><p>x</p></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  ["LV-28 control plaintextx is an unknown tag", "<head><template><plaintextx></template>" + L("/llms.txt") + "</head>", "", "/llms.txt"],
  // LV-30: an anchored Link value describes another resource
  ["LV-30 anchor to another page", "<head></head>", "</llms.txt>; rel=describedby; anchor=\"https://other.example/page\"", null],
  ["LV-30 anchor, unquoted, to another page", "<head></head>", "</llms.txt>; rel=describedby; anchor=https://other.example/page", null],
  ["LV-30 anchor to a fragment of the home page", "<head></head>", "</llms.txt>; rel=describedby; anchor=\"#top\"", null],
  ["LV-30 anchor to the home page as /", "<head></head>", "</llms.txt>; rel=describedby; anchor=\"/\"", "/llms.txt"],
  ["LV-30 anchor to the home page, absolute", "<head></head>", "</llms.txt>; rel=describedby; anchor=\"https://example.com/\"", "/llms.txt"],
  ["LV-30 anchor to the home page without a slash", "<head></head>", "</llms.txt>; rel=describedby; anchor=\"https://example.com\"", "/llms.txt"],
  ["LV-30 empty anchor", "<head></head>", "</llms.txt>; rel=describedby; anchor=\"\"", "/llms.txt"],
  ["LV-30 no anchor", "<head></head>", "</llms.txt>; rel=describedby", "/llms.txt"],
  ["LV-30 the next unanchored value is used", "<head></head>", "</a.txt>; rel=describedby; anchor=\"https://x.example/\", </b.txt>; rel=describedby", "/b.txt"],
  // LV-29: white space outside the head does not count against the head cap
  ["LV-29 white space after </head>", "<head></head>" + " ".repeat(65536) + "<link rel=describedby href=/llms.txt><body>", "", "/llms.txt"],
  ["LV-29 white space before <head>", " ".repeat(65536) + "<head><link rel=describedby href=/llms.txt></head><body>", "", "/llms.txt"],
  ["LV-29 70000 line breaks after </head>", "<head></head>" + "\n".repeat(70000) + "<link rel=describedby href=/llms.txt><body>", "", "/llms.txt"],
  ["LV-29 control 65000 spaces after </head>", "<head></head>" + " ".repeat(65000) + "<link rel=describedby href=/llms.txt><body>", "", "/llms.txt"],
];
for (const [name, home, link, want] of DISCOVERY) {
  test("discovery " + name, async () => {
    const r = await rel(home, link);
    assert.equal(r.describedby, want);
  });
}

test("LV-30: an anchored markdown alternate is not used and an unanchored one is", async () => {
  const other = await rel("<head></head>", "</other.md>; rel=alternate; type=\"text/markdown\"; anchor=\"https://other.example/page\"");
  assert.equal(other.markdown, null);
  const home = await rel("<head></head>", "</index.md>; rel=alternate; type=\"text/markdown\"; anchor=\"/\"");
  assert.equal(home.markdown, "/index.md");
  const bare = await rel("<head></head>", "</index.md>; rel=alternate; type=\"text/markdown\"");
  assert.equal(bare.markdown, "/index.md");
});

test("LV-29: white space inside the head still counts against the cap", async () => {
  const r = await rel("<head>" + " ".repeat(65536) + "<link rel=describedby href=/llms.txt></head>");
  assert.equal(r.describedby, null);
  assert.match(r.detail, /in the first 65,536 characters of the head/);
});

// ---- scan cost on hostile home pages ----
// The head is read up to 65,536 characters, so both sizes below stay under that cap and the larger
// one is scanned whole. The time is compared between the two sizes (test/growth.ts), not against a limit.
test("LV-23 to LV-28: hostile heads are scanned in linear time", async () => {
  let cap = 16384;
  const fill = (unit: string, pre: string, post = "") => pre + unit.repeat(Math.floor((cap - pre.length - post.length) / unit.length)) + post;
  const build = (): [string, string][] => [
    ["script, escape with no close and many <", fill("<a", "<head><script><!--", "</script>" + L("/llms.txt"))],
    ["script, comment closes", fill("<!-- -->", "<head><script>", "</script>" + L("/llms.txt"))],
    ["script, comment opens", fill("<!-- ", "<head><script>", "</script>" + L("/llms.txt"))],
    ["script, double escape", fill("<!--<script></scriptX>", "<head><script>", "</script>" + L("/llms.txt"))],
    ["script, end tags without >", fill("</script ", "<head><script>")],
    ["style, end tags without >", fill("</style ", "<head><style>")],
    ["template, </templateX", fill("</templateX", "<head><template>")],
    ["template, tags with quotes", fill("<a title=\"</template>\">", "<head><template>", "</template>" + L("/llms.txt"))],
    ["template, open quote", fill("<a title=\"", "<head><template>")],
    ["template, nested templates", fill("<template a=\"<\">", "<head><template>", "</template>".repeat(10))],
    ["template, svg", fill("<svg><title/>", "<head><template>", "</template>" + L("/llms.txt"))],
    ["template, bogus comments", fill("<! \">", "<head><template>", "</template>" + L("/llms.txt"))],
  ];
  const small = build();
  cap = 61440;
  const large = build();
  for (let i = 0; i < small.length; i++) {
    await assertLinear(small[i]![0], (home) => rel(home), small[i]![1], large[i]![1]);
  }
});

// ---- LV-32: limits and error paths the README states ----
test("LV-32: the default read budget is 8 seconds", async () => {
  const seen: number[] = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => { seen.push(ms); return real.call(AbortSignal, ms); };
  try {
    const r = await run("example.com", plain);
    assert.equal(r.error, null);
  } finally {
    AbortSignal.timeout = real;
  }
  assert.ok(seen.length >= 2);
  assert.ok(seen[0]! > 7000 && seen[0]! <= 8000, String(seen[0]));
});
function chunked(n: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= n) { controller.close(); return; }
      const k = Math.min(16384, n - sent);
      controller.enqueue(new Uint8Array(k).fill(120));
      sent += k;
    },
  });
}
async function sizeCheck(body: string | ReadableStream<Uint8Array>): Promise<Check> {
  const r = await run("example.com", (u) => (u.endsWith("/llms.txt") ? new Response(body, { status: 200, headers: { "content-type": "text/plain" } }) : html("<head></head>")));
  assert.equal(r.error, null);
  return r.checks.find((c) => c.id === "size")!;
}
test("LV-32: a streamed file of exactly 256 KiB is read whole and one byte more is cut", async () => {
  const exact = await sizeCheck(chunked(262144));
  assert.equal(exact.status, "warn");
  assert.equal(exact.detail, "262144 bytes. Consider moving detail to llms-full.txt");
  const over = await sizeCheck(chunked(262145));
  assert.equal(over.status, "warn");
  assert.equal(over.detail, "over 256 KiB, read truncated");
});
test("LV-32: 51200 bytes is the last size that passes and 51201 warns", async () => {
  const pad = (n: number) => GOOD + "x".repeat(n - new TextEncoder().encode(GOOD).length);
  const at = await sizeCheck(pad(51200));
  assert.equal(at.status, "pass");
  assert.equal(at.detail, "51200 bytes");
  const over = await sizeCheck(pad(51201));
  assert.equal(over.status, "warn");
  assert.equal(over.detail, "51201 bytes. Consider moving detail to llms-full.txt");
});
test("LV-32: a home page that throws or answers 500 leaves the discovery checks at info and the result valid", async () => {
  for (const [name, home] of [["throws", (): Response => { throw new TypeError("network"); }], ["500", (): Response => html("x", 500)]] as [string, () => Response][]) {
    const r = await run("example.com", (u) => (u.endsWith("/llms.txt") ? resp(GOOD) : home()));
    assert.equal(r.error, null, name);
    assert.equal(r.summary, "valid", name);
    const v2 = r.checks.filter((c) => c.id.startsWith("v2-"));
    assert.equal(v2.length, 2, name);
    for (const c of v2) {
      assert.equal(c.status, "info", name);
      assert.match(c.detail, name === "500" ? /the home page returned HTTP 500, so this was not measured/ : /the home page could not be read, so this was not measured/, name);
    }
  }
});

// ---- package only ----
test("LV-32: the timeoutMs option aborts a read that never answers", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as typeof fetch;
  // AbortSignal.timeout does not hold the event loop open, and a stubbed fetch has no socket that does.
  // Node.js 22 then ends the test as pending before the timer fires, so a plain timer keeps the loop alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const started = Date.now();
    await assert.rejects(() => validateHost("example.com", { timeoutMs: 30 }), (e: unknown) => (e as { name?: string }).name === "TimeoutError");
    assert.ok(Date.now() - started < 3000);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = realFetch;
  }
});

// LV-32: the command line, as a subprocess with a stubbed fetch (test/fixtures/mock-llms-txt.ts).
const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
const mock = new URL("fixtures/mock-llms-txt.js", import.meta.url).href;
const cliRun = (body: string, ...flags: string[]) => spawnSync(process.execPath, ["--import", mock, cli, "example.com", ...flags], { encoding: "utf8", env: { ...process.env, LLMS_TXT_BODY: body } });
const VALID_BODY = GOOD;
const WARN_BODY = "# Example\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
const FAIL_BODY = "no heading in this file\n";

test("LV-32: the CLI prints the result line and exits 0 for valid and for valid with warnings", () => {
  const valid = cliRun(VALID_BODY);
  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /^result: valid$/m);
  const warn = cliRun(WARN_BODY);
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /^result: valid with warnings$/m);
});

test("LV-32: the CLI exits 1 for not valid, with and without --strict, and 1 for warnings only with --strict", () => {
  const fail = cliRun(FAIL_BODY);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /^result: not valid$/m);
  assert.equal(cliRun(FAIL_BODY, "--strict").status, 1);
  assert.equal(cliRun(WARN_BODY, "--strict").status, 1);
  assert.equal(cliRun(VALID_BODY, "--strict").status, 0);
});

test("LV-32: --json for a completed validation has target, summary and checks and no result line", () => {
  const out = cliRun(WARN_BODY, "--json");
  assert.equal(out.status, 0);
  const json = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(json).sort(), ["checks", "summary", "target"]);
  assert.equal(json.target, "https://example.com/llms.txt");
  assert.equal(json.summary, "valid with warnings");
  assert.ok(Array.isArray(json.checks) && json.checks.length >= 10);
  assert.ok(json.checks.every((c: Check) => typeof c.id === "string" && typeof c.status === "string" && typeof c.detail === "string"));
  assert.ok(!/result:/.test(out.stdout));
  assert.equal(cliRun(FAIL_BODY, "--json").status, 1);
});
