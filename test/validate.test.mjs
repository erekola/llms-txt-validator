import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt, summarizeChecks, normalizeHostInput, isValidPublicHost, fetchLlmsTxt } from "../src/index.mjs";

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
