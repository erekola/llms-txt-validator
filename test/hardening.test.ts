import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLlmsTxt, summarizeChecks, validateHost, fetchLlmsTxt, findLinkRelations, maskLocation } from "../src/index.js";
import type { FetchRedirect, FetchedLlmsTxt, LlmsCheck } from "../src/index.js";
import { assertLinear } from "./growth.js";

// Regression tests for the 0.8.0 repairs. Each case gave the other answer in 0.7.4. The hosted validator at
// turva.dev/llms-txt-validator is canonical, and its own test file carries the same inputs for the link
// scan, the masking, the heading and head-scan rules. The path and option checks of fetchLlmsTxt exist only here.
// Cost tests time inputs that double in size and compare the ratio: a fixed number of milliseconds fails on a
// slow runner and lets a slow scan through.

const BS = String.fromCharCode(92);
const HEAD = "# Example\n\n> Summary.\n\n## Docs\n\n";
const good = (text: string) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false });
const run = (text: string): LlmsCheck[] => validateLlmsTxt(good(text));
const byId = (checks: LlmsCheck[], id: string): LlmsCheck => checks.find((c) => c.id === id)!;

type Stub = { urls: string[]; restore: () => void };
function stubFetch(handler: (url: string, call: number) => Response): Stub {
  const orig = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: unknown) => { urls.push(String(u)); return handler(String(u), urls.length); }) as typeof fetch;
  return { urls, restore: () => { globalThis.fetch = orig; } };
}
const notFound = () => new Response("", { status: 404, headers: { "content-type": "text/html" } });
async function validate(llms: string, home: string = ""): Promise<{ checks: LlmsCheck[]; raw: string }> {
  const stub = stubFetch((u) => {
    if (u === "https://example.com/llms.txt") return new Response(llms, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (u === "https://example.com/") return home === "" ? notFound() : new Response(home, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    throw new Error("unexpected fetch to " + u);
  });
  try {
    const r = await validateHost("example.com");
    return { checks: r.checks, raw: JSON.stringify(r) };
  } finally { stub.restore(); }
}

// ---- cost of the link scan ----

test("a text of image openers followed by angle-bracket targets is read in time that grows linearly", async () => {
  const doc = (n: number) => "# T\n\n## S\n\n" + "![".repeat(n) + "](<".repeat(n) + ">";
  const work = (s: string) => run(s);
  await assertLinear("13000 and 52000 openers", work, doc(13000), doc(52000));
  await assertLinear("6500 and 26000 openers", work, doc(6500), doc(26000));
});

test("a text of nested image openers is read in time that grows linearly", async () => {
  const doc = (d: number) => "![".repeat(d) + "]".repeat(d);
  const work = (s: string) => run(s);
  // Three doublings: each step stays well under the factor 4 a quadratic scan gives.
  await assertLinear("8192 and 16384 openers", work, doc(8192), doc(16384));
  await assertLinear("16384 and 32768 openers", work, doc(16384), doc(32768));
  await assertLinear("8192 and 32768 openers", work, doc(8192), doc(32768));
});

test("nested image openers with a collapsed reference after each closer are read in linear time", async () => {
  const doc = (d: number) => "![".repeat(d) + "]".repeat(d) + "[]".repeat(d);
  await assertLinear("8192 and 32768 openers", (s: string) => run(s), doc(8192), doc(32768));
});

test("images and reference images still hide the links inside their alt text", () => {
  const detail = (t: string) => byId(run(HEAD + t + "\n"), "links").detail;
  assert.equal(detail("- [Guide](https://example.com/guide) ![alt [inner](https://example.com/x)](https://example.com/i.png)"), "1 link, all absolute URLs");
  assert.equal(detail("- ![![a]](https://example.com/i.png) [Guide](https://example.com/guide)"), "1 link, all absolute URLs");
  assert.equal(detail("- ![alt [inner](https://example.com/x)][r] [Guide](https://example.com/guide)\n\n[r]: https://example.com/i.png"), "1 link, all absolute URLs");
  assert.equal(detail("- ![a] [Guide](https://example.com/guide)\n\n[a]: https://example.com/i.png"), "1 link, all absolute URLs");
  assert.equal(detail("- ![a [Guide](https://example.com/guide)"), "1 link, all absolute URLs");
});

test("many references to one long definition target do not scan it once per reference", async () => {
  const doc = (d: number, r: number) => "[a]: " + "a".repeat(d) + "\n" + "[a] ".repeat(r);
  // Four times the target length and four times the references: a scan per reference grows 16 times.
  await assertLinear("16384 x 4096 and 65536 x 16384", (s: string) => run(s), doc(16384, 4096), doc(65536, 16384));
});

test("the relative and hostless counts of the links check stay the same", () => {
  assert.match(byId(run(HEAD + "- [a](https://example.com/a)\n- [b](/b)\n- [c](https://)\n- [d](mailto:x@example.com)\n"), "links").detail, /^4 links, 1 relative and 2 that are not valid http or https URLs\./);
  assert.match(byId(run(HEAD + "- [a][r]\n- [b][r]\n- [c][r]\n\n[r]: /rel\n"), "links").detail, /^3 links, 3 relative\./);
});

// ---- a backslash before a line break, and a heading inside a raw HTML block ----

test("a backslash before a line break does not carry a link label past the end of its list item or heading", () => {
  const a = run(HEAD + "- [Guide" + BS + "\n- more](https://example.org/a)\n");
  assert.equal(byId(a, "links").status, "warn");
  assert.equal(byId(a, "sections").status, "warn");
  assert.equal(summarizeChecks(a), "valid with warnings");
  assert.equal(byId(run(HEAD + "- [Guide\n- more](https://example.org/a)\n"), "links").status, "warn");
  const b = run(HEAD + "- ![Alt" + BS + "\n- see [Real](https://example.org/b)](https://example.org/i.png)\n");
  assert.equal(byId(b, "links").status, "pass");
  assert.equal(byId(b, "links").detail, "1 link, all absolute URLs");
  const c = run(HEAD + "- [Guide" + BS + "\n## Next](https://example.org/a)\n");
  assert.equal(byId(c, "links").status, "warn");
  assert.equal(byId(c, "sections").status, "warn");
  // An escaped bracket and a backslash before an ordinary character keep their reading.
  assert.equal(byId(run(HEAD + "- [Guide " + BS + "] more](https://example.org/a)\n"), "links").detail, "1 link, all absolute URLs");
  assert.equal(byId(run(HEAD + "- [Gu" + BS + "ide](https://example.org/a)\n"), "links").detail, "1 link, all absolute URLs");
});

test("a heading inside a raw HTML block that CommonMark does not end there is no section", () => {
  const doc = (open: string, close: string) => "# T\n\n> s\n\n" + open + "\n## Docs\n" + close + "\n- [a](https://example.com/a)\n";
  for (const [open, close] of [["<?x", "?>"], ["<![CDATA[", "]]>"], ["<!DOCTYPE x", ">"], ["<!-- x", "-->"]] as const) {
    const checks = run(doc(open, close));
    assert.equal(byId(checks, "sections").status, "warn", open);
    assert.match(byId(checks, "sections").detail, /^no H2 sections found/, open);
    assert.equal(summarizeChecks(checks), "valid with warnings", open);
  }
  // A heading under a block of type 6 or 7 with no blank line is inside that block as well.
  const div = run("# T\n\n> s\n\n<div>\n## Docs\n\n- [a](https://example.com/a)\n");
  assert.equal(byId(div, "sections").status, "warn");
  // A heading after the block ends is a section, and a plain document is unchanged.
  const after = run("# T\n\n> s\n\n<?x\n?>\n\n## Docs\n\n- [a](https://example.com/a)\n");
  assert.equal(byId(after, "sections").status, "pass");
  assert.equal(summarizeChecks(after), "valid");
  const plain = run("# T\n\n> s\n\n## Docs\n\n- [a](https://example.com/a)\n");
  assert.equal(byId(plain, "sections").detail, "1 section, 1 carrying a file list");
  assert.equal(summarizeChecks(plain), "valid");
  // A setext heading inside such a block is no heading either.
  const setext = run("# T\n\n> s\n\n<?x\nDocs\n----\n?>\n- [a](https://example.com/a)\n");
  assert.equal(byId(setext, "sections").status, "warn");
});

// ---- the head scan ----

test("the head scan reads past <!--> and <!---> inside a script, as the HTML tokenizer does", () => {
  const link = '<link rel="describedby" href="/real">';
  for (const open of ["<!-->", "<!--->"]) {
    assert.equal(findLinkRelations("<head><script>" + open + "<script></script>" + link + "</head>", "").describedby, "/real", open);
    // The script ends at the first </script>, so a body start tag after it ends the head before the link.
    assert.equal(findLinkRelations("<head><script>" + open + "<script></script><body></script>" + link + "</head>", "").describedby, null, open);
  }
  // Unchanged: a real comment, an empty script and the double escape of a comment.
  assert.equal(findLinkRelations("<head><script><!-- x --></script>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><script>x</script>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><script><!-- <script></script> --></script>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><script><!-- <script></script>" + link + "</head>", "").describedby, null);
  assert.equal(findLinkRelations("<head><script><!-- <!--> <script></script>" + link + "</head>", "").describedby, "/real");
});

test("the head scan counts a template inside svg or math as an ordinary element, not as an HTML template", () => {
  const link = '<link rel="describedby" href="/real">';
  assert.equal(findLinkRelations("<head><template><svg><template></svg></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><math><template></math></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><svg><template/></svg></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><svg><template></template></svg></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><svg><template></svg></template><body></template>" + link + "</head>", "").describedby, null);
  // Unchanged: nested HTML templates count, and a template inside a foreignObject is an HTML template again.
  assert.equal(findLinkRelations("<head><template><template></template></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><p></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><svg><foreignObject><template></template></foreignObject></svg></template>" + link + "</head>", "").describedby, "/real");
  assert.equal(findLinkRelations("<head><template><template></template>" + link + "</head>", "").describedby, null);
});

// ---- invisible characters in a check's detail ----

const INVISIBLE: Array<[string, number]> = [
  ["LRM", 0x200E], ["RLM", 0x200F], ["ALM", 0x061C], ["LS", 0x2028], ["PS", 0x2029],
  ["ZWSP", 0x200B], ["ZWNJ", 0x200C], ["ZWJ", 0x200D], ["WJ", 0x2060], ["BOM", 0xFEFF],
  ["TAG A", 0xE0041], ["TAG begin", 0xE0001], ["TAG first", 0xE0000], ["TAG last", 0xE007F],
];
const ALREADY: Array<[string, number]> = [["LRE", 0x202A], ["RLO", 0x202E], ["RLI", 0x2067], ["PDI", 0x2069], ["C1", 0x85]];

test("each listed invisible character is absent from the detail and the JSON text, and the visible text stays", async () => {
  for (const [name, code] of [...INVISIBLE, ...ALREADY]) {
    const ch = String.fromCodePoint(code);
    const { checks, raw } = await validate("# A" + ch + "B\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
    const h1 = byId(checks, "h1-title");
    assert.equal(h1.status, "pass", name);
    assert.equal(h1.detail, '"# AB"', name);
    assert.ok(!h1.detail.includes(ch), name + " survives in the detail");
    assert.ok(!raw.includes(ch), name + " survives in the JSON text");
  }
});

test("every listed character is stripped together, inside a longer run of text", async () => {
  const all = [...INVISIBLE, ...ALREADY].map(([, c]) => String.fromCodePoint(c)).join("");
  const { checks } = await validate("# Title" + all + " and more\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
  assert.equal(byId(checks, "h1-title").detail, '"# Title and more"');
});

// ---- masking of an address that hides user information ----

test("maskLocation hides user information that holds a ? or a #, whether or not the URL parser reads the text as a URL", () => {
  const secrets = ["SECRETuser", "SECRETpw"];
  const written = [
    "https://SECRETuser:SECRETpw?x@example.com/a",
    "https://SECRETuser:SECRETpw#x@example.com/a",
    "https://SECRETuser:12?SECRETpw@example.com/a",
    "https://SECRETuser:SECRETpw?x/y@example.com/a",
    "//SECRETuser:SECRETpw?x@example.com/a",
    "u:SECRETuser:SECRETpw?x@host/p",
  ];
  for (const t of written) {
    for (const base of [undefined, "https://example.com/llms.txt"]) {
      const shown = maskLocation(t, base);
      for (const s of secrets) assert.ok(!shown.includes(s), t + " shows " + s + " as " + shown);
    }
  }
  // Without slashes a user name that is also a valid scheme name reads as the scheme, and the text after it is no
  // authority, so only "//***" is shown.
  assert.equal(maskLocation("SECRETuser:SECRETpw?x@example.com"), "//***");
  // A ? or # before the @ and before any slash is ambiguous: a URL parser reads the text after it as a query, a person
  // reads the text before the @ as user information. Only the scheme is shown then, no host.
  assert.equal(maskLocation("https://SECRETuser:SECRETpw?x@example.com/a"), "https://***");
  assert.equal(maskLocation("https://SECRETuser:SECRETpw?x@example.com/a?k=v#f"), "https://***");
  // A parsed address whose written form hid user information is masked from the written form.
  const parsed = new URL("https://SECRETuser:12?SECRETpw@example.com/a");
  assert.equal(maskLocation(parsed.href, undefined, "https://SECRETuser:12?SECRETpw@example.com/a"), "https://***");
});

test("maskLocation hides user information that follows a scheme the URL parser refuses", () => {
  const written = [
    "my_app://SECRETuser:SECRETpw@host/p",
    "1app://SECRETuser:SECRETpw@host/p",
    "ht tps://SECRETuser:SECRETpw@host/p",
    "ht" + String.fromCharCode(1) + "tps://SECRETuser:SECRETpw@host/x?t=1",
    "my_app://SECRETuser:SECRETpw@host/p?t=1#f",
  ];
  for (const t of written) {
    for (const base of [undefined, "https://example.com/llms.txt"]) {
      const shown = maskLocation(t, base);
      assert.ok(!shown.includes("SECRET"), t + " shows " + shown);
      assert.ok(shown.includes("***@host"), t + " shows " + shown);
    }
  }
  assert.equal(maskLocation("my_app://SECRETuser:SECRETpw@host/p"), "my_app://***@host/p");
  assert.equal(maskLocation("my_app://SECRETuser:SECRETpw?x@host/p"), "my_app://***");
  assert.equal(maskLocation("a:b://SECRETuser:SECRETpw@host/p"), "//***");
  assert.equal(maskLocation("ht" + String.fromCharCode(1) + "tps://SECRETuser:SECRETpw@host/x?t=1"), "ht" + String.fromCharCode(1) + "tps://***@host/x?***");
});

test("maskLocation keeps the shapes it did not touch", () => {
  assert.equal(maskLocation("https://user:pass@example.com/?q=1"), "https://example.com/?q=***");
  assert.equal(maskLocation("https://example.com/p?x=1#f"), "https://example.com/p?x=***");
  assert.equal(maskLocation("/p?mail=a@b.com"), "/p?***");
  assert.equal(maskLocation("p?mail=a@b.com"), "p?***");
  assert.equal(maskLocation("my_app://host/p"), "my_app://host/p");
  assert.equal(maskLocation("https://host/p?x=a@b"), "https://host/p?x=***");
  assert.equal(maskLocation("path@2x.png"), "path@2x.png");
  assert.equal(maskLocation("user_name:pw@host?x=1"), "***@host?***");
  // A scheme-less address with a port and an @ in its fragment, as typed on the command line, shows no host either.
  assert.equal(maskLocation("example.org:8443#a@b"), "//***");
});

test("a published describedby link with user information is shown masked, in all three odd shapes", async () => {
  for (const href of ["my_app://SECRETuser:SECRETpw@host/p?t=1", "https://SECRETuser:SECRETpw?x@example.com/p", "ht&#1;tps://SECRETuser:SECRETpw@host/x?t=1"]) {
    const { checks, raw } = await validate(HEAD + "- [Guide](https://example.com/guide)\n", '<!doctype html><html><head><link rel="describedby" href="' + href + '"></head><body></body></html>');
    assert.equal(byId(checks, "v2-describedby").status, "pass", href);
    assert.ok(!/secret/i.test(raw), href + " leaks into " + byId(checks, "v2-describedby").detail);
  }
});

test("every redirect refusal shows its Location masked, the too-many and bad-location answers included", async () => {
  const secretLocations = [
    "https://SECRETuser:SECRETpw?x@example.com/a",
    "https://SECRETuser:12?SECRETpw@example.com/x",
    "my_app://SECRETuser:SECRETpw@example.com/p",
  ];
  for (const loc of secretLocations) {
    const single = stubFetch(() => new Response(null, { status: 302, headers: { location: loc } }));
    try {
      const f = await fetchLlmsTxt("example.com") as FetchRedirect;
      assert.equal(f.redirect, true, loc);
      assert.ok(!f.location.includes("SECRET") && !f.location.includes("secret"), loc + " shows " + f.location);
    } finally { single.restore(); }
    // Four ordinary same-site redirects, then the fifth answer is refused as one hop too many.
    const chain = stubFetch((_u, call) => new Response(null, { status: 302, headers: { location: call <= 4 ? "https://example.com/hop" + call : loc } }));
    try {
      const f = await fetchLlmsTxt("example.com") as FetchRedirect;
      assert.equal(f.reason, "too-many", loc);
      assert.ok(!f.location.includes("SECRET") && !f.location.includes("secret"), loc + " shows " + f.location + " after too many hops");
    } finally { chain.restore(); }
  }
  const bad = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://SECRETuser:SECRETpw?x@example.com/a" } }));
  try {
    const f = await fetchLlmsTxt("example.com") as FetchRedirect;
    assert.equal(f.reason, "bad-location");
    assert.equal(f.location, "https://***");
  } finally { bad.restore(); }
});

test("the README examples of masking and of the option limits are what the code does", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.equal(maskLocation("https://user:pa?ss@example.com/"), "https://***");
  assert.ok(readme.includes("`https://user:pa?ss@example.com/`, `https://example.org?e=a@b.com` and `https:///host?e=a@b.com` are shown as `https://***`"));
  assert.equal(maskLocation("https://example.org?e=a@b.com"), "https://***");
  assert.equal(maskLocation("https:///host?e=a@b.com"), "https://***");
  assert.ok(readme.includes("`user:secret@host.example://dd`, where no slash follows the scheme colon, is shown as `//***`"));
  assert.equal(maskLocation("user:secret@host.example://dd"), "//***");
  assert.equal(maskLocation("my_app://user:secret@host/p"), "my_app://***@host/p");
  assert.equal(maskLocation("1app://user:secret@host/p"), "1app://***@host/p");
  assert.equal(maskLocation("ht tps://user:secret@host/p"), "ht tps://***@host/p");
  // The two maxima in the option table are the ones in the error messages.
  assert.ok(readme.includes("An integer from 1 to 2,097,152."));
  assert.ok(readme.includes("An integer from 1 to 2,147,483,647."));
});

test("the command line shows an address that hides user information behind a ? in an error report without it", () => {
  const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
  for (const [arg, shown] of [["https://SECRETuser:SECRETpw?x@example.com/", "https://***"], ["my_app://SECRETuser:SECRETpw@host/p", "my_app://***@host/p"]] as const) {
    const r = spawnSync(process.execPath, [cli, arg, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, arg);
    const report = JSON.parse(r.stdout) as { error: string; target: string };
    assert.equal(report.target, shown, arg);
    assert.ok(!/secret/i.test(r.stdout + r.stderr), arg + " leaks");
  }
});

// ---- invisible characters by Unicode class ----

// The stripped set is a Unicode class and not a list kept by hand: every format character (General_Category Cf), every
// Default_Ignorable_Code_Point, and the line and paragraph separators. Ordinary spaces are not in it.
const cp = (...codes: number[]) => String.fromCodePoint(...codes);
const MISSED: Array<[string, number]> = [
  ["function application", 0x2061], ["invisible times", 0x2062], ["invisible separator", 0x2063], ["invisible plus", 0x2064],
  ["soft hyphen", 0x00AD], ["variation selector 1", 0xFE00], ["variation selector 15", 0xFE0E], ["variation selector 16", 0xFE0F],
  ["variation selector 17", 0xE0100], ["variation selector 100", 0xE0163], ["variation selector 256", 0xE01EF],
  ["combining grapheme joiner", 0x034F], ["hangul choseong filler", 0x115F], ["hangul filler", 0x3164], ["halfwidth hangul filler", 0xFFA0],
  ["mongolian vowel separator", 0x180E], ["mongolian free variation selector", 0x180B], ["khmer inherent vowel", 0x17B4],
  ["interlinear annotation anchor", 0xFFF9], ["musical symbol begin beam", 0x1D173], ["unassigned default ignorable", 0x2065],
  ["arabic number sign", 0x0600], ["syriac abbreviation mark", 0x070F], ["inhibit symmetric swapping", 0x206A],
];

test("the invisible characters a closed list missed are absent from the detail, in the title and in the summary", async () => {
  for (const [name, code] of MISSED) {
    const ch = cp(code);
    const { checks, raw } = await validate("# A" + ch + "B\n\n> S" + ch + "T\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
    assert.equal(byId(checks, "h1-title").detail, '"# AB"', name);
    assert.equal(byId(checks, "summary").detail, '"> ST"', name);
    assert.ok(!raw.includes(ch), name + " survives in the JSON text");
  }
});

test("every format character and every default ignorable code point is stripped, whatever the code point", async () => {
  const klass = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u;
  const all: number[] = [];
  for (let c = 0; c <= 0x10FFFF; c++) if (c < 0xD800 || c > 0xDFFF) { if (klass.test(String.fromCodePoint(c))) all.push(c); }
  assert.ok(all.length > 4000, "the class holds " + all.length + " code points");
  for (let i = 0; i < all.length; i += 25) {
    const chunk = all.slice(i, i + 25);
    const { checks } = await validate("# A" + cp(...chunk) + "B\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
    assert.equal(byId(checks, "h1-title").detail, '"# AB"', "chunk starting at U+" + chunk[0]!.toString(16));
  }
});

test("ordinary text, accents, CJK, emoji bases, combining marks and the visible spaces stay in the detail", async () => {
  const kept = [
    "Plain title", "Caf" + cp(0xE9), "Cafe" + cp(0x301), cp(0x65E5, 0x672C, 0x8A9E, 0x306E, 0x30BF, 0x30A4, 0x30C8, 0x30EB), cp(0xDC, 0x6E, 0xEF, 0x63, 0xF6, 0x64, 0xE9),
    "smile " + cp(0x1F642), "thumbs " + cp(0x1F44D, 0x1F3FD), "flag " + cp(0x1F1EB, 0x1F1EE), "keycap 1" + cp(0x20E3),
    "A" + cp(0xA0) + "B", "A" + cp(0x2003) + "B", "A" + cp(0x2009) + "B", "A" + cp(0x200A) + "B", "A" + cp(0x202F) + "B", "A" + cp(0x205F) + "B", "A" + cp(0x3000) + "B", "A" + cp(0x2000) + "B",
    "Arabic " + cp(0x627, 0x644, 0x639, 0x631, 0x628, 0x64A, 0x629), "Hebrew " + cp(0x5E2, 0x5D1, 0x5E8, 0x5D9, 0x5EA),
  ];
  for (const text of kept) {
    const { checks } = await validate("# " + text + "\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
    assert.equal(byId(checks, "h1-title").detail, JSON.stringify("# " + text), text);
  }
});

test("an emoji sequence loses its joiners and its variation selector, and the emoji themselves stay", async () => {
  const cases: Array<[string, string]> = [
    [cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467), cp(0x1F468, 0x1F469, 0x1F467)],
    [cp(0x2764, 0xFE0F), cp(0x2764)],
    [cp(0x1F3F4, 0xE0067, 0xE0062, 0xE0065, 0xE006E, 0xE0067, 0xE007F), cp(0x1F3F4)],
    [cp(0x31, 0xFE0F, 0x20E3), cp(0x31, 0x20E3)],
    [cp(0x1F44D, 0x1F3FD), cp(0x1F44D, 0x1F3FD)],
  ];
  for (const [written, shown] of cases) {
    const { checks } = await validate("# " + written + "\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
    assert.equal(byId(checks, "h1-title").detail, JSON.stringify("# " + shown));
  }
});

// ---- ambiguous addresses ----

test("maskLocation shows only the scheme when a backslash, a ? or a # comes before the @ and before any slash", () => {
  const ambiguous = [
    "https://us" + BS + "er:SECRETpw@other.example/",
    "https://SECRETuser:SECRETpw" + BS + "x@other.example/",
    "https://other.example?e=a@b.com",
    "https://other.example#x@b.com",
    "https://other.example?e=a@b.com/path",
    "https://other.example" + BS + "p@b.com",
    "http://SECRETuser:SECRETpw?x@other.example/a?k=v#f",
    "https:" + BS + BS + "SECRETuser" + BS + ":SECRETpw@other.example/",
  ];
  for (const t of ambiguous) {
    for (const base of [undefined, "https://example.com/llms.txt"]) {
      const shown = maskLocation(t, base);
      assert.match(shown, /^https?:\/\/\*\*\*$/, t + " shows " + shown);
    }
  }
  assert.equal(maskLocation("//SECRETuser:SECRETpw?x@host/p"), "//***");
  // The same through the parsed form a redirect hands over: the written text decides.
  const written = "https://us" + BS + "er:SECRETpw@other.example/";
  assert.equal(maskLocation(new URL(written).href, undefined, written), "https://***");
  const query = "https://other.example?e=a@b.com";
  assert.equal(maskLocation(new URL(query).href, undefined, query), "https://***");
  // A slash before the @ is not ambiguous: it is a path.
  assert.equal(maskLocation("https://host.example/@name"), "https://host.example/@name");
  assert.equal(maskLocation("https://host.example/a/b?x=a@b"), "https://host.example/a/b?x=***");
  assert.equal(maskLocation("https://host.example/p#x@b"), "https://host.example/p");
  assert.equal(maskLocation("https://other.example/?e=a@b.com"), "https://other.example/?e=***");
});

test("a redirect to an ambiguous address names no host on any route, and the detail does not tell the reader to validate one", async () => {
  const locations = ["https://other.example?e=a@zzhost.example", "https://other.example#x@zzhost.example", "https://us" + BS + "er:SECRETpw@other.example/", "https://SECRETuser:SECRETpw" + BS + "x@other.example/"];
  for (const location of locations) {
    const single = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
    try {
      const f = await fetchLlmsTxt("example.com") as FetchRedirect;
      assert.equal(f.redirect, true, location);
      assert.equal(f.location, "https://***", location);
    } finally { single.restore(); }
    const chain = stubFetch((_u, call) => new Response(null, { status: 302, headers: { location: call <= 4 ? "https://example.com/hop" + call : location } }));
    try {
      const f = await fetchLlmsTxt("example.com") as FetchRedirect;
      assert.equal(f.reason, "too-many", location);
      assert.equal(f.location, "https://***", location);
    } finally { chain.restore(); }
    const again = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
    try {
      const r = await validateHost("example.com");
      const raw = JSON.stringify(r);
      assert.ok(!/secret/i.test(raw) && !raw.includes("zzhost"), location + " leaks into " + raw);
      assert.ok(!/validate that host/.test(raw), location + " tells the reader to validate a host");
      const detail = byId(r.checks, "http-status").detail;
      assert.match(detail, /^(redirects to https:\/\/\*\*\*, a different host that this report does not name\. llms\.txt is host-scoped, so find the host that this redirect points to and validate it directly|redirects to an unsupported target \(https:\/\/\*\*\*\)\. Only https redirects to the same site are followed|got a 302 redirect without a usable Location header)$/, location);
    } finally { again.restore(); }
  }
});

test("the off-host sentence of an ordinary redirect still names the host to validate", () => {
  const detail = byId(validateLlmsTxt({ redirect: true, reason: "off-host", status: 301, location: "https://other.example/llms.txt" }), "http-status").detail;
  assert.equal(detail, "redirects to https://other.example/llms.txt, a different host. llms.txt is host-scoped, so validate that host directly");
});

test("maskLocation shows only the scheme for a written start that is not exactly scheme, two slashes and a non-slash, when the text holds an @", () => {
  const base = "https://example.com/llms.txt";
  const odd: Array<[string, string]> = [
    ["https:///other.example?e=a@b.com", "https://***"],
    ["https:///other.example#frag@b.com", "https://***"],
    ["///other.example?e=a@b.com", "//***"],
    ["https:///SECRETuser:SECRETpw@host/p", "https://***"],
    ["https:////SECRETuser:SECRETpw@host/p", "https://***"],
    ["https:/SECRETuser:SECRETpw@host/p", "https://***"],
    ["https:SECRETuser:SECRETpw@host/p", "//***"],
    ["SECRETuser:SECRETpw@host/p", "//***"],
    ["//" + BS + "SECRETuser:SECRETpw@host/p", "//***"],
  ];
  for (const [text, shown] of odd) {
    for (const b of [undefined, base]) assert.equal(maskLocation(text, b), shown, text + " against " + b);
    const parsed = new URL(text, base).href;
    assert.equal(maskLocation(parsed, undefined, text), shown, text + " as written");
  }
  // A reference with no scheme and no leading // keeps its reading, and so does the ordinary two-slash form.
  assert.equal(maskLocation("/a@b"), "/a@b");
  assert.equal(maskLocation("docs/@name"), "docs/@name");
  assert.equal(maskLocation("https://host.example/@name"), "https://host.example/@name");
  assert.equal(maskLocation("https://host.example/a@b"), "https://host.example/a@b");
  // With no @ nothing changes: the parser normalises these as before.
  assert.equal(maskLocation("https:///x/y"), "https://x/y");
  assert.equal(maskLocation("https:path/x?y=1"), "https://path/x?y=***");
});

test("a redirect with three slashes or a scheme and no slashes names no wrong host and shows no secret, on every route", async () => {
  for (const location of ["https:///other.example?e=a@zzhost.example", "https:///other.example#frag@zzhost.example", "///other.example?e=a@zzhost.example", "https:SECRETuser:SECRETpw@zzhost.example/p", "https:/SECRETuser:SECRETpw@zzhost.example/p"]) {
    const single = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
    try {
      const r = await validateHost("example.com");
      const raw = JSON.stringify(r);
      assert.ok(!/secret/i.test(raw), location + " leaks into " + raw);
      assert.ok(!raw.includes("zzhost"), location + " names a host in " + raw);
      assert.ok(!/validate that host/.test(raw), location + " tells the reader to validate a host");
      const f = await fetchLlmsTxt("example.com") as FetchRedirect;
      assert.ok(!/secret|zzhost/i.test(f.location), location + " shows " + f.location);
    } finally { single.restore(); }
    const chain = stubFetch((_u, call) => new Response(null, { status: 302, headers: { location: call <= 4 ? "https://example.com/hop" + call : location } }));
    try {
      const f = await fetchLlmsTxt("example.com") as FetchRedirect;
      assert.equal(f.reason, "too-many", location);
      assert.ok(!/secret|zzhost/i.test(f.location), location + " shows " + f.location + " after too many hops");
    } finally { chain.restore(); }
  }
});

test("a raw HTML block opener inside a list item does not hide the column-0 heading after it, and one outside any item still does", () => {
  const head = "# Site\n\n> Summary line.\n\n";
  const sections = (body: string) => byId(run(head + body), "sections").detail;
  // The opener sits at or beyond the content offset of the open item, so CommonMark puts it inside the item,
  // and the heading at column 0 closes the item and the block and is a real section.
  const inside = [
    "- item [a](https://e.com/a)\n   <!-- c\n## Docs\n\n-->\n\n- [z](https://e.com/z)\n",
    "- item\n  <?x\n## Docs\n?>\n\n- [z](https://e.com/z)\n",
    "1. item\n\n   <div>\n## Docs\n\n- [z](https://e.com/z)\n",
    "10. item\n\n    <details>\n## Docs\n\n- [z](https://e.com/z)\n",
    "* item\n  <script>\n## Docs\n  </script>\n\n- [z](https://e.com/z)\n",
    "- item\n  - nested\n\n  <![CDATA[\n## Docs\n  ]]>\n\n- [z](https://e.com/z)\n",
  ];
  for (const body of inside) assert.match(sections(body), /^1 section/, JSON.stringify(body));
  // An opener after a blank line, indented at most three columns and outside every open item is a block of its own
  // and masks the heading inside it.
  const outside = [
    "- item\n\n<!-- c\n## Docs\n-->\n\n- [z](https://e.com/z)\n",
    "<!-- c\n## Docs\n-->\n\n- [z](https://e.com/z)\n",
    "text\n\n   <!-- c\n## Docs\n-->\n\n- [z](https://e.com/z)\n",
    "-   item\n\n   <!-- c\n## Docs\n\n-->\n\n- [z](https://e.com/z)\n",
  ];
  for (const body of outside) assert.match(sections(body), /^no H2 sections found/, JSON.stringify(body));
  // Directly under a paragraph line, a list item line or another block the structure is not certain, so the opener masks
  // nothing and the heading is read as before.
  const uncertain = [
    "-   item\n   <!-- c\n## Docs\n\n-->\n\n- [z](https://e.com/z)\n",
    "text\n   <!-- c\n## Docs\n-->\n\n- [z](https://e.com/z)\n",
  ];
  for (const body of uncertain) assert.match(sections(body), /^1 section/, JSON.stringify(body));
});

test("a raw HTML block opener under a list item line or a paragraph line masks nothing, so the heading after it is a section", () => {
  const head = "# Site\n\n> Summary line.\n\n";
  const sections = (body: string) => byId(run(head + body), "sections").detail;
  const tail = "\n\n## Docs\n\n- [z](https://e.com/z)\n";
  const sectionBodies = [
    '  - <p>\n<a href="x">\n<script>text' + tail,
    "> quote\n</pre>\n<br>\n <![CDATA[" + tail,
    "   +   <ul>\n</script>\n  <!--text" + tail,
    "1)   <h3>\n <img src=x>\n<textarea>" + tail,
    "  *  <?x?>\n</style>\n<textarea>" + tail,
    "> > <pre>x</pre>\n</pre>\n   <script> x" + tail,
    "1.\t<!--\n</script>\n<![CDATA[ x" + tail,
  ];
  for (const body of sectionBodies) assert.match(sections(body), /^1 section/, JSON.stringify(body));
  // After a blank line at the top level the same openers do mask: the block runs to its end marker or to the blank line.
  assert.match(sections("<script>text\n\n## Docs\n\n</script>\n\n- [z](https://e.com/z)\n"), /^no H2 sections found/);
  assert.match(sections("<div>\n## Docs\n\n- [z](https://e.com/z)\n"), /^no H2 sections found/);
  assert.match(sections("text\n\n<div>\n## Docs\n\n- [z](https://e.com/z)\n"), /^no H2 sections found/);
});

test("a raw HTML block of type 2, 3, 4 or 1 that ends on its own opener line masks nothing after it, and a multi-line comment still does", () => {
  const head = "# T\n\n> s\n\n";
  const sections = (body: string) => byId(run(head + body), "sections").detail;
  const tail = "\n\n## Docs\n\n- [z](https://e.com/z)\n";
  for (const opener of ["<!-->", "<!--->", "<?>", "<!X>", "<![CDATA[]]>", "<script></script>", "<pre>x</pre>", "<!---->", "<?x?>"]) {
    assert.match(sections(opener + tail), /^1 section/, JSON.stringify(opener));
  }
  assert.match(sections("<!--\n\n## Docs\n\n-->\n\n- [z](https://e.com/z)\n"), /^no H2 sections found/);
});

test("maskLocation shows only the scheme when a later :// follows the @, whatever the start", () => {
  const base = "https://example.com/llms.txt";
  const cases: Array<[string, string]> = [
    ["us:SECRETX@host.example://dd", "//***"],
    ["http:us%40er:SECRETX@host.example://dd", "//***"],
    ["ftp:us:SECRETX@host.example://x", "//***"],
    ["1app:us:SECRETX@host.example://dd", "//***"],
    ["http:/us:SECRETX@host.example://dd", "http://***"],
    ["https:///us:SECRETX@host.example://dd", "https://***"],
    ["//" + BS + "us:SECRETX@host.example://dd", "//***"],
  ];
  for (const [text, shown] of cases) {
    for (const b of [undefined, base]) assert.equal(maskLocation(text, b), shown, text + " against " + b);
    const parsed = new URL(text, base).href;
    assert.equal(maskLocation(parsed, undefined, text), shown, text + " as written");
  }
  // The ordinary forms keep their reading.
  assert.equal(maskLocation("https://us:SECRETX@host.example://dd"), "https://host.example//dd");
  assert.equal(maskLocation("/a@b"), "/a@b");
  assert.equal(maskLocation("docs/@name"), "docs/@name");
  assert.equal(maskLocation("https://host.example/@name"), "https://host.example/@name");
});

test("a redirect to a host the report does not name says how to find it, and a named host keeps its sentence", async () => {
  const detailFor = async (location: string) => {
    const stub = stubFetch(() => new Response(null, { status: 302, headers: { location } }));
    try { return byId((await validateHost("example.com")).checks, "http-status").detail; } finally { stub.restore(); }
  };
  assert.equal(await detailFor("https://other.example?e=a@zzhost.example"), "redirects to https://***, a different host that this report does not name. llms.txt is host-scoped, so find the host that this redirect points to and validate it directly");
  assert.equal(await detailFor("https://other.example/x"), "redirects to https://other.example/x, a different host. llms.txt is host-scoped, so validate that host directly");
});

// ---- opts.path of fetchLlmsTxt ----

const REFUSED_PATHS: Array<[string, unknown]> = [
  ["no leading slash", "x"],
  ["empty string", ""],
  ["a port", ":8443/x"],
  ["a longer host name", ".other.example/x"],
  ["a host after at", "@evil.example/x"],
  ["an address after at", "@127.0.0.1:1/x"],
  ["scheme-relative address", "//evil.example/x"],
  ["three slashes", "///evil.example"],
  ["slash and backslash", "/" + BS + "evil.example"],
  ["backslash first", BS + "evil.example"],
  ["two backslashes", BS + BS + "evil.example"],
  ["an absolute URL", "https://evil.example/x"],
  ["an absolute http URL", "http://evil.example/"],
  ["a query alone", "?q=1"],
  ["a fragment alone", "#f"],
  ["a leading space", " /llms.txt"],
  ["a line feed", "/a" + String.fromCharCode(10) + "b"],
  ["a carriage return", "/a" + String.fromCharCode(13) + "b"],
  ["a tab", "/a" + String.fromCharCode(9) + "b"],
  ["a NUL", "/a" + String.fromCharCode(0) + "b"],
  ["a DEL", "/a" + String.fromCharCode(127) + "b"],
  ["a tab after the slash", "/" + String.fromCharCode(9) + "/evil.example"],
  ["a number", 8443],
  ["an object", { toString: () => "/x" }],
];

test("opts.path must start with a single slash: a port, a host, a scheme or a control character is refused before any request", async () => {
  for (const [name, path] of REFUSED_PATHS) {
    const stub = stubFetch(() => notFound());
    try {
      await assert.rejects(fetchLlmsTxt("example.com", { path: path as string }), (e: unknown) => e instanceof TypeError && /opts\.path/.test(e.message), name);
      assert.deepEqual(stub.urls, [], name + " reached fetch");
    } finally { stub.restore(); }
  }
});

test("opts.path keeps the host and the port of the request whatever the path holds", async () => {
  const accepted: Array<[string, string]> = [
    ["/llms.txt", "https://example.com/llms.txt"],
    ["/", "https://example.com/"],
    ["/docs/llms.txt", "https://example.com/docs/llms.txt"],
    ["/a?x=1", "https://example.com/a?x=1"],
    ["/a b", "https://example.com/a%20b"],
    ["/@evil.example/x", "https://example.com/@evil.example/x"],
    ["/:8443/x", "https://example.com/:8443/x"],
    ["/x#frag", "https://example.com/x#frag"],
  ];
  for (const [path, expected] of accepted) {
    const stub = stubFetch(() => new Response("# Ex\n", { status: 200, headers: { "content-type": "text/plain" } }));
    try {
      const f = await fetchLlmsTxt("example.com", { path }) as FetchedLlmsTxt;
      assert.equal(f.status, 200, path);
      assert.equal(stub.urls.length, 1, path);
      const u = new URL(stub.urls[0]!);
      assert.equal(u.host, "example.com", path);
      assert.equal(u.username + u.password, "", path);
      assert.equal(u.protocol, "https:", path);
      assert.equal(new URL(expected).href, u.href, path);
    } finally { stub.restore(); }
  }
  // No path given: the default stays /llms.txt.
  const stub = stubFetch(() => new Response("# Ex\n", { status: 200, headers: { "content-type": "text/plain" } }));
  try {
    await fetchLlmsTxt("example.com");
    await fetchLlmsTxt("example.com", { path: undefined });
    assert.deepEqual(stub.urls, ["https://example.com/llms.txt", "https://example.com/llms.txt"]);
  } finally { stub.restore(); }
});

test("validateHost still pins its two reads to /llms.txt and /, whatever path the caller passes", async () => {
  const stub = stubFetch((u) => (u === "https://example.com/llms.txt" ? new Response("# Ex\n", { status: 200, headers: { "content-type": "text/plain" } }) : notFound()));
  try {
    await validateHost("example.com", { path: "/other" });
    assert.deepEqual(stub.urls, ["https://example.com/llms.txt", "https://example.com/"]);
  } finally { stub.restore(); }
});

// ---- opts.cap and opts.timeoutMs of fetchLlmsTxt ----

test("opts.cap must be an integer from 1 to 2 MiB: NaN, Infinity, zero, a negative, a fraction and a huge value are refused before any request", async () => {
  for (const cap of [NaN, Infinity, -Infinity, 0, -1, 1.5, 2097153, 4194304, 2 ** 31, Number.MAX_SAFE_INTEGER, "100", true, {}]) {
    const stub = stubFetch(() => new Response("# Ex\n", { status: 200, headers: { "content-type": "text/plain" } }));
    try {
      await assert.rejects(fetchLlmsTxt("example.com", { cap: cap as number }), (e: unknown) => e instanceof RangeError && /opts\.cap/.test(e.message) && /2097152/.test(e.message), String(cap));
      await assert.rejects(validateHost("example.com", { cap: cap as number }), (e: unknown) => e instanceof RangeError && /opts\.cap/.test(e.message), "validateHost " + String(cap));
      assert.deepEqual(stub.urls, [], String(cap) + " reached fetch");
    } finally { stub.restore(); }
  }
});

test("opts.cap still cuts the body where it says, and the default and the maximum are accepted", async () => {
  const body = "# Ex\n" + "x".repeat(5000);
  const stub = stubFetch(() => new Response(body, { status: 200, headers: { "content-type": "text/plain" } }));
  try {
    const cut1 = await fetchLlmsTxt("example.com", { cap: 1000 }) as FetchedLlmsTxt;
    assert.equal(cut1.truncated, true);
    assert.equal(cut1.bytes, 1000);
    const whole = await fetchLlmsTxt("example.com", { cap: 2097152 }) as FetchedLlmsTxt;
    assert.equal(whole.truncated, false);
    assert.equal(whole.bytes, Buffer.byteLength(body));
    const dflt = await fetchLlmsTxt("example.com") as FetchedLlmsTxt;
    assert.equal(dflt.truncated, false);
    const one = await fetchLlmsTxt("example.com", { cap: 1 }) as FetchedLlmsTxt;
    assert.equal(one.bytes, 1);
  } finally { stub.restore(); }
});

test("opts.timeoutMs must be an integer from 1 to 2147483647: NaN, Infinity, zero, a negative and a fraction are refused before any request", async () => {
  for (const t of [NaN, Infinity, -Infinity, 0, -1, 8000.5, 2147483648, "8000", true]) {
    const stub = stubFetch(() => new Response("# Ex\n", { status: 200, headers: { "content-type": "text/plain" } }));
    try {
      await assert.rejects(fetchLlmsTxt("example.com", { timeoutMs: t as number }), (e: unknown) => e instanceof RangeError && /opts\.timeoutMs/.test(e.message), String(t));
      assert.deepEqual(stub.urls, [], String(t) + " reached fetch");
    } finally { stub.restore(); }
  }
  const stub = stubFetch(() => new Response("# Ex\n", { status: 200, headers: { "content-type": "text/plain" } }));
  try {
    for (const t of [1, 8000, 2147483647]) assert.equal(((await fetchLlmsTxt("example.com", { timeoutMs: t })) as FetchedLlmsTxt).status, 200, String(t));
  } finally { stub.restore(); }
});

test("a host of the wrong shape is still refused with the old result, even beside invalid options", async () => {
  const stub = stubFetch(() => notFound());
  try {
    const f = await fetchLlmsTxt("127.0.0.1", { cap: NaN, path: "x" }) as FetchRedirect;
    assert.equal(f.reason, "unsafe-target");
    assert.deepEqual(stub.urls, []);
  } finally { stub.restore(); }
});
