import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLlmsTxt, summarizeChecks, validateHost, findLinkRelations, isValidPublicHost } from "../src/index.mjs";

// Regression tests for 0.3.8 (Tek-496, outside audit 2026-09-26). The package mirrors the hosted
// validator at turva.dev/llms-txt-validator, whose worker.js carries the same cases in
// test/validator-tek496.test.mjs. Each case below gave the opposite result in 0.3.7.

const BS = String.fromCharCode(92);
const ESC = String.fromCharCode(27);
const base = "# Example\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
const good = (text, contentType = "text/plain; charset=utf-8") => ({ status: 200, contentType, text, bytes: Buffer.byteLength(text), truncated: false });
const status = (checks, id) => checks.find((c) => c.id === id).status;
const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));

test("H1: whitespace after the marker is allowed, a heading with no text is not", () => {
  for (const t of ["#  Example", "#\tExample", "# Example #", "   # Example"]) {
    assert.equal(status(validateLlmsTxt(good(base.replace("# Example", t))), "h1-title"), "pass", t);
  }
  for (const t of ["# ###", "#", "#   #  "]) {
    const checks = validateLlmsTxt(good(base.replace("# Example", t)));
    assert.equal(status(checks, "h1-title"), "fail", t);
    assert.match(checks.find((c) => c.id === "h1-title").detail, /has no text/, t);
  }
});

test("links: code, an escaped bracket and an image are not links", () => {
  for (const line of ["- `[Guide](https://example.com/guide)`", "- " + BS + "[Guide](https://example.com/guide)", "- ![Guide](https://example.com/guide)"]) {
    const checks = validateLlmsTxt(good(base.replace("- [Guide](https://example.com/guide)", line)));
    assert.equal(status(checks, "links"), "warn", line);
  }
});

test("links: an ordered list, a tab, a title and an angle target are links", () => {
  for (const line of ["1. [Guide](https://example.com/guide)", "-\t[Guide](https://example.com/guide)", "- [Guide](https://example.com/guide \"Guide\")", "- [Guide](<https://example.com/guide>)", "- [Guide](  https://example.com/guide  )", "- " + BS + "![Guide](https://example.com/guide)"]) {
    assert.equal(summarizeChecks(validateLlmsTxt(good(base.replace("- [Guide](https://example.com/guide)", line)))), "valid", line);
  }
});

test("links: one line ending may stand around the destination, a blank line may not", () => {
  const wrapped = validateLlmsTxt(good(base + "\nSee [the guide](https://example.com/guide\n) and [more](\nhttps://example.com/more).\n"));
  assert.match(wrapped.find((c) => c.id === "links").detail, /^3 links, all absolute URLs/);
  const broken = validateLlmsTxt(good(base + "\nSee [the guide](\n\nhttps://example.com/guide).\n"));
  assert.match(broken.find((c) => c.id === "links").detail, /^1 link, all absolute URLs/);
});

test("structure: a heading before the first H2 or a second H1 warns", () => {
  const checks = validateLlmsTxt(good(base.replace("## Docs", "### Extra heading\n\n## Docs")));
  assert.equal(status(checks, "sections"), "warn");
  assert.match(checks.find((c) => c.id === "sections").detail, /heading at line 5 is out of place/);
  assert.equal(status(validateLlmsTxt(good(base + "\n# Another\n")), "sections"), "warn");
  assert.equal(status(validateLlmsTxt(good(base + "\n### Sub\n\n- [B](https://example.com/b)\n")), "sections"), "pass");
});

test("links: a target the URL parser refuses is not an absolute URL", () => {
  for (const u of ["https://%", "https://example.com:99999/", "https://[", "https://user@", "https://example.com:bogus/"]) {
    assert.equal(status(validateLlmsTxt(good(base.replace("https://example.com/guide", u))), "links"), "warn", u);
  }
});

test("content type: the media type is compared whole", () => {
  for (const ct of ["application/x-text/plain", "text/markdownish", "application/json; x=text/plain"]) {
    assert.equal(status(validateLlmsTxt(good(base, ct)), "content-type"), "warn", ct);
  }
  assert.equal(status(validateLlmsTxt(good(base, "text/markdown; charset=utf-8")), "content-type"), "pass");
});

test("host: localhost.localdomain is not a public host", () => {
  assert.equal(isValidPublicHost("localhost.localdomain"), false);
  assert.equal(isValidPublicHost("example.com"), true);
});

test("input error: a user name, a password or a query value never reaches the message", async () => {
  const marker = "m" + Math.random().toString(36).slice(2);
  for (const input of ["https://u:" + marker + "@example.com/?token=" + marker, "https://127.0.0.1/?k=" + marker, "localhost#" + marker]) {
    await assert.rejects(validateHost(input), (err) => !err.message.includes(marker) && /not a public domain name/.test(err.message), input);
  }
  await assert.rejects(validateHost("bad host"), /not a public domain name: bad host/);
});

test("discovery: a shown target is masked and carries no control character", async () => {
  const marker = "m" + Math.random().toString(36).slice(2);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith("/llms.txt")
    ? new Response(base, { headers: { "content-type": "text/plain" } })
    : new Response("<head><link rel=\"describedby\" href=\"https://u:" + marker + "@example.com/llms.txt?token=" + marker + "#" + marker + "\"><link rel=\"alternate\" type=\"text/markdown\" href=\"/index.md" + ESC + "[2J\"></head>", { headers: { "content-type": "text/html" } });
  try {
    const result = await validateHost("example.com");
    assert.ok(!JSON.stringify(result).includes(marker));
    assert.ok(!result.checks.some((c) => c.detail.includes(ESC)));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("discovery: a head read in part says so", () => {
  const links = "<link rel=\"describedby\" href=\"/llms.txt\">";
  const found = findLinkRelations("<html><head><meta content=\"" + "x".repeat(65536) + "\">" + links + "</head></html>", "");
  assert.equal(found.describedby, null);
  assert.equal(found.headCut, true);
  assert.deepEqual(findLinkRelations("<head>" + links + "</head>", ""), { describedby: "/llms.txt", markdown: null });
});

test("CLI: an unknown option, a second target and a missing target stop with exit 2, as JSON under --json", () => {
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  const typo = run("example.com", "--strcit", "--json");
  assert.equal(typo.status, 2);
  assert.match(JSON.parse(typo.stdout).error, /unknown option/);
  const two = run("a.example", "b.example", "--json");
  assert.equal(two.status, 2);
  assert.match(JSON.parse(two.stdout).error, /one domain or URL at a time/);
  const none = run("--json");
  assert.equal(none.status, 2);
  assert.match(JSON.parse(none.stdout).error, /no domain or URL given/);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: llms-txt-validate/);
});

test("CLI: --version and -V print the installed version and exit 0 (V-04)", () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  for (const flag of ["--version", "-V"]) {
    const result = run(flag);
    assert.equal(result.status, 0, flag);
    assert.equal(result.stdout.trim(), pkg.version, flag);
    assert.equal(result.stderr, "", flag);
  }
  // A target is not required with --version, unlike the ordinary run, and no network call is
  // made: validateHost would need a live fetch, and this exits before that path is reached.
  assert.equal(run("--version", "--strict").status, 0);
});

test("CLI: a network error under --json carries target and code, error unchanged (V-05)", () => {
  // A stubbed fetch stands in for a real DNS failure: it is deterministic and does not wait
  // out the real 8 second fetch timeout the way an actual unreachable host would.
  const mock = new URL("fixtures/mock-network-error.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--import", mock, cli, "example.com", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error, "fetch failed");
  assert.equal(parsed.target, "example.com");
  assert.equal(parsed.code, "EAI_AGAIN");
});

test("CLI: an input error under --json still carries no code field (V-05)", () => {
  const result = spawnSync(process.execPath, [cli, "not a host", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.error, "not a public domain name: not a host");
  assert.equal(parsed.target, "not a host");
  assert.equal("code" in parsed, false);
});

test("CLI: the target field under --json masks a user name, a password and a query (V-05)", () => {
  const result = spawnSync(process.execPath, [cli, "https://user:supersecret@nonexistent.invalid.test/?token=abc", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const parsed = JSON.parse(result.stdout);
  assert.doesNotMatch(result.stdout, /supersecret|user:|abc/);
  assert.match(parsed.target, /nonexistent\.invalid\.test/);
});

// Tek-564 (outside re-check W36 to W44, V1): a second H1 written as a setext heading, one text
// line over a run of "=", warns like "# Second title" does, with the same detail and the line of
// the text. Before 0.3.19 only the "#" form was read after the title.
const sectionsOf = (text) => validateLlmsTxt(good(text)).find((c) => c.id === "sections");
const setextBetween = base.replace("## Docs", "Second title\n============\n\n## Docs");
const atxBetween = base.replace("## Docs", "# Second title\n\n## Docs");
const setextAfter = base + "\nSecond title\n============\n";
const atxAfter = base + "\n# Second title\n";

test("Tek-564: a setext second H1 between the title and the first H2 warns and names its text line", () => {
  const s = sectionsOf(setextBetween);
  assert.equal(s.status, "warn");
  assert.match(s.detail, /heading at line 5 is out of place/);
  assert.equal(summarizeChecks(validateLlmsTxt(good(setextBetween))), "valid with warnings");
});

test("Tek-564: a setext second H1 after the last section warns and names its text line", () => {
  const s = sectionsOf(setextAfter);
  assert.equal(s.status, "warn");
  assert.match(s.detail, /heading at line 9 is out of place/);
  assert.equal(summarizeChecks(validateLlmsTxt(good(setextAfter))), "valid with warnings");
});

test("Tek-564: the ATX and the setext form give the same check status and the same detail", () => {
  for (const [atx, setext] of [[atxBetween, setextBetween], [atxAfter, setextAfter]]) {
    const a = sectionsOf(atx);
    const s = sectionsOf(setext);
    assert.equal(s.status, a.status);
    assert.equal(s.detail, a.detail);
    assert.equal(a.status, "warn");
  }
});

test("Tek-564: a setext second H1 ends the section before it, like an ATX one", () => {
  const withList = base + "\nSecond title\n============\n\n- [More](https://example.com/more)\n";
  assert.equal(sectionsOf(withList).detail.startsWith("1 section, 1 carrying a file list"), true);
  const noList = "# Example\n\n> Summary.\n\n## Docs\n\nSecond title\n============\n\n- [Guide](https://example.com/guide)\n";
  const atxNoList = "# Example\n\n> Summary.\n\n## Docs\n\n# Second title\n\n- [Guide](https://example.com/guide)\n";
  assert.equal(sectionsOf(noList).detail, sectionsOf(atxNoList).detail);
  assert.match(sectionsOf(noList).detail, /but no file list under any of them/);
});

test("Tek-564: the limits stay, a multi-line setext heading and setext text that starts with # are not an H1", () => {
  for (const extra of ["Line one\nSecond title\n============\n", "#Second title\n============\n", "- item\nSecond title\n============\n", "> quote\nSecond title\n============\n"]) {
    const s = sectionsOf(base + "\n" + extra);
    assert.equal(s.status, "pass", extra);
    assert.ok(!/out of place/.test(s.detail), extra);
  }
  // The underline alone is never a heading, and a fenced pair is code.
  assert.equal(sectionsOf(base + "\n============\n").status, "pass");
  assert.equal(sectionsOf(base + "\n```\nSecond title\n============\n```\n").status, "pass");
  // A setext title is still the title, and nothing after it is out of place.
  const setextTitle = "Example\n=======\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
  assert.equal(summarizeChecks(validateLlmsTxt(good(setextTitle))), "valid");
});

test("Tek-564: a second setext H1 right under a setext title, with no blank line, is out of place", () => {
  const s = sectionsOf("Example\n=======\nSecond title\n============\n\n## Docs\n\n- [Guide](https://example.com/guide)\n");
  assert.equal(s.status, "warn");
  assert.match(s.detail, /heading at line 3 is out of place/);
});

test("Tek-564: a thematic break, an HTML block or a link reference definition over = is not a second H1", () => {
  for (const extra of ["---\n============\n", "***\n============\n", "___\n============\n", "<div>\n============\n", "<!-- c -->\n============\n", "[a]: https://example.com/x\n============\n"]) {
    const s = sectionsOf(base + "\n" + extra);
    assert.equal(s.status, "pass", extra);
    assert.ok(!/out of place/.test(s.detail), extra);
  }
  // An autolink is paragraph text, so an autolink line over a run of "=" is still a second H1.
  assert.equal(sectionsOf(base + "\n<https://example.com/x>\n============\n").status, "warn");
});

// Tek-565 (outside review W46): a four-space line that does not continue a paragraph is indented
// code, so the next unindented "Title" over "===" is a second H1 even after it. The six fixtures
// are the W46 cases, with the line of the text each must name.
const w46 = {
  f1: ["# Site\n\n> Summary\n\nSecond title\n===\n\n## Docs\n- [Doc](https://turva.dev)\n", 5],
  f2: ["# Site\n\n> Summary\n\n    code\nSecond title\n===\n\n## Docs\n- [Doc](https://turva.dev)\n", 6],
  f3: ["# Site\n\n> Summary\n\n    code\n# Second title\n\n## Docs\n- [Doc](https://turva.dev)\n", 6],
  f4: ["# Site\n\n> Summary\n\n## Docs\n- [Doc](https://turva.dev)\n\n---\n\nSecond title\n===\n", 10],
  f5: ["# Site\n\n> Summary\n\n## Docs\n- [Doc](https://turva.dev)\n\n---\n\n    code\nSecond title\n===\n", 11],
  f6: ["# Site\n\n> Summary\n\n## Docs\n- [Doc](https://turva.dev)\n\n---\n\n    code\n# Second title\n", 11]
};

test("Tek-565: a second H1 after an indented code line warns like the ATX form, at the same line", () => {
  for (const [name, [text, line]] of Object.entries(w46)) {
    const s = sectionsOf(text);
    assert.equal(s.status, "warn", name);
    assert.match(s.detail, new RegExp("heading at line " + line + " is out of place"), name);
    assert.equal(summarizeChecks(validateLlmsTxt(good(text))), "valid with warnings", name);
  }
});

test("Tek-565: a four-space line inside a paragraph or a list item is not indented code", () => {
  // Paragraph continuation: the accepted Tek-564 limit stays.
  const para = "# Site\n\n> Summary\n\nPara text\n    continued\nTitle\n===\n\n## Docs\n- [Doc](https://turva.dev)\n";
  const s = sectionsOf(para);
  assert.equal(s.status, "pass");
  assert.ok(!/out of place/.test(s.detail));
  assert.equal(summarizeChecks(validateLlmsTxt(good(para))), "valid");
  // A list item keeps its blank and indented lines, so "    code" there is a continuation paragraph.
  const list = base + "\n    code\nTitle\n===\n";
  const l = sectionsOf(list);
  assert.equal(l.status, "pass");
  assert.ok(!/out of place/.test(l.detail));
  // Inside a block quote (lazy continuation), an HTML block or after a link reference definition an
  // indented line continues the block, so the old reading stays until the next blank line.
  for (const extra of ["> quote\nTitle\n===\n    code\nTitle\n===", "> quote\nTitle\n===\n\tcode\nTitle\n===", "> quote\nTitle\n===\n    - sub\nTitle\n===", "<div>\n---\n\tcode\nTitle\n===", "[a]: https://example.com/x\n===\n    code\nTitle\n==="]) {
    const q = sectionsOf(base + "\n" + extra);
    assert.equal(q.status, "pass", extra);
    assert.ok(!/out of place/.test(q.detail), extra);
  }
  // An HTML block of type 1 to 5 runs past blank lines to its end marker.
  for (const extra of ["# T\n\n## Docs\n- [Doc](https://turva.dev)\n\n<!-- a\n\n    b\nTitle\n===\n-->\n", "# T\n\n## Docs\n- [Doc](https://turva.dev)\n\n<pre>\n\n    x\nTitle\n===\n</pre>\n"]) {
    const q = sectionsOf(extra);
    assert.ok(!/out of place/.test(q.detail), extra);
  }
});

test("CLI: --strict exits 1 for a second H1 after an indented code line and 0 for a clean file (Tek-565)", () => {
  const mock = new URL("fixtures/mock-llms-txt.mjs", import.meta.url).href;
  const run = (body, ...flags) => spawnSync(process.execPath, ["--import", mock, cli, "example.com", ...flags], { encoding: "utf8", env: { ...process.env, LLMS_TXT_BODY: body } });
  for (const name of ["f2", "f5"]) {
    assert.equal(run(w46[name][0], "--strict").status, 1, name);
    assert.equal(run(w46[name][0]).status, 0, name);
  }
  const para = "# Site\n\n> Summary\n\nPara text\n    continued\nTitle\n===\n\n## Docs\n- [Doc](https://turva.dev)\n";
  assert.equal(run(para, "--strict").status, 0);
});
