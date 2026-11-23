import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLlmsTxt, validateHost, validateLlmsTxt } from "../src/index.js";
import type { ValidateHostOptions } from "../src/index.js";

// Regression tests for the validator items of the K2 reading of 2026-11-22 (decision Tek-898): n1, a setext H1 whose text
// renders nothing, n5, the read limit named in the home page note, and n6, null in the option types. Each case gave the
// other answer in 0.8.3. The hosted validator carries n1 in test/validator-mask-2026-11-23.test.ts of turva-worker; n5 and
// n6 exist only in the package, because the hosted route has no caller who sets a limit.

const BODY = "\n\n> Summary.\n\n## Docs\n\n- [A](https://example.com/a): one\n";
const good = (text: string) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false });
const h1 = (head: string) => validateLlmsTxt(good(head + BODY)).find((c) => c.id === "h1-title")!;

test("n1: a setext H1 whose text renders nothing fails, as the same text after # does", () => {
  for (const head of ["&#32;\n=====", "&#32;&#32;\n=====", "` `\n=====", "&#32;\n=", "  &#32;\n  ===  ", "&#x20;\n====="]) {
    const c = h1(head);
    assert.equal(c.status, "fail", JSON.stringify(head));
    assert.equal(c.detail, "the H1 has no text. The format requires the project name there", JSON.stringify(head));
  }
});

test("n1: the controls keep their answers", () => {
  assert.equal(h1("# &#32;").status, "fail");
  assert.equal(h1("# &#32;").detail, "the H1 has no text. The format requires the project name there");
  assert.equal(h1("# Example").status, "pass");
  assert.equal(h1("Example\n=====").status, "pass");
  assert.equal(h1("Example &#32;\n=====").status, "pass");
  assert.equal(h1("`code`\n=====").status, "pass");
  // A line of spaces is no first line, so the underline is the first line and is no title.
  const spaces = h1("   \n=====");
  assert.equal(spaces.status, "fail");
  assert.equal(spaces.detail, "the first non-empty line should be a markdown H1 (# Site name, or one line of text underlined with =)");
});

test("n1: nothing else moves for the same text", () => {
  const ids = (head: string) => validateLlmsTxt(good(head + BODY)).filter((c) => c.id !== "h1-title").map((c) => c.id + ":" + c.status);
  assert.deepEqual(ids("&#32;\n====="), ids("Example\n====="));
});

const PAGE = "# Title\n\n> Summary.\n\n## Docs\n\n- [A](https://example.com/a): one\n";
const LONG_HOME = "<!doctype html><html><head><title>x</title></head><body>" + "x".repeat(300000);

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname === "/") return new Response(LONG_HOME, { status: 200, headers: { "content-type": "text/html" } });
    return new Response(PAGE, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test("n5: the note about a cut home page names the read limit the caller set", async () => {
  const r = await withHome(() => validateHost("example.com", { cap: 1024 }));
  const d = r.checks.find((c) => c.id === "v2-describedby")!;
  assert.equal(d.status, "info");
  assert.ok(d.detail.includes("in the first 1024 bytes of the home page, the part that was read, or in the Link header"), d.detail);
  assert.ok(!d.detail.includes("256 KiB"), d.detail);
});

test("n5: the default limit is still named as 256 KiB", async () => {
  const r = await withHome(() => validateHost("example.com"));
  const d = r.checks.find((c) => c.id === "v2-describedby")!;
  assert.ok(d.detail.includes("in the first 256 KiB of the home page, the part that was read, or in the Link header"), d.detail);
  const e = await withHome(() => validateHost("example.com", { cap: 262144 }));
  assert.ok(e.checks.find((c) => c.id === "v2-describedby")!.detail.includes("in the first 256 KiB of the home page"));
});

test("n6: null is accepted by the option types for timeoutMs, cap and path, and means the default", async () => {
  const opts: ValidateHostOptions = { timeoutMs: null, cap: null, path: null };
  const f = await withHome(() => fetchLlmsTxt("example.com", opts));
  assert.ok(!("redirect" in f));
  assert.equal((f as { status: number }).status, 200);
});
