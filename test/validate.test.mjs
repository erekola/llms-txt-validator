import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt, summarizeChecks, normalizeHostInput, isValidPublicHost } from "../src/index.mjs";

const good = (text, extra = {}) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false, ...extra });
const byId = (checks, id) => checks.find((c) => c.id === id);

test("a well-formed llms.txt is valid", () => {
  const text = "# Example\n\n> One line about the site.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(summarizeChecks(checks), "valid");
  assert.equal(checks.length, 8);
  for (const c of checks) assert.equal(c.status, "pass");
});

test("redirect fails the first check and stops", () => {
  const checks = validateLlmsTxt({ redirect: true, status: 301, location: "https://example.com/" });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "fail");
  assert.equal(summarizeChecks(checks), "not valid");
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
