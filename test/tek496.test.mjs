import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
