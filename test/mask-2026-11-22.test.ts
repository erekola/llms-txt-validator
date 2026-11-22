import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLlmsTxt, fetchLlmsTxt, maskLocation } from "../src/index.js";
import type { FetchRedirect, LlmsCheck } from "../src/index.js";

// Regression tests for the repairs of an outside fuzz run of 0.8.0 on 2026-11-22 (V4-1, its base form, V4-3, CT-1).
// Each case gave the other answer in 0.8.0. The hosted validator at turva.dev/llms-txt-validator is canonical and its
// test file test/fuzz-2026-11-22.test.ts carries the same masking inputs. CANARY is a made-up value, no real secret.
// Characters outside printable ASCII are built with String.fromCharCode, so this file stays ASCII.

const BS = String.fromCharCode(92);
const BASE = "https://example.com/llms.txt";
const CANARY = "CANARYPWD7f3a";
const byId = (checks: LlmsCheck[], id: string): LlmsCheck => checks.find((c) => c.id === id)!;

test("V4-1: a backslash between a domain and a user name no longer shows the password before a # or a ?", () => {
  const cases: Array<[string, string]> = [
    ["CORP" + BS + "erik:pa#" + CANARY + "@example.com", "***@example.com"],
    ["CORP" + BS + "erik:" + CANARY + "#x@example.com", "***@example.com"],
    ["CORP" + BS + "erik:" + CANARY + "?x@example.com", "***@example.com"],
    ["CORP" + BS + "erik:" + CANARY + "@example.com", "***@example.com"],
    ["CORP" + BS + "erik:" + CANARY + "#x@example.com?q=1", "***@example.com?***"],
    // The minimal form of the fuzz run, and a single leading backslash, which is no authority start.
    [BS + ":" + CANARY + "#@p", BS + "***@p"],
    [BS + "erik:" + CANARY + "#x@example.com", BS + "***@example.com"],
    [BS + "erik:" + CANARY + "@example.com", BS + "***@example.com"],
  ];
  for (const [written, shown] of cases) {
    // With a base, a ? or # before the last @ shows only ***: the URL reading would put the rest into a query or a
    // fragment, and the text reading would show it as a host.
    const cutBeforeAt = /[?#]/.test(written.slice(0, written.lastIndexOf("@")));
    for (const base of [undefined, BASE]) {
      assert.equal(maskLocation(written, base), base && cutBeforeAt ? "***" : shown, JSON.stringify(written) + " with base " + base);
    }
  }
});

test("V4-1, base form: a scheme-less user:password@host resolved against a base is masked from the text, not shown in the path", () => {
  for (const written of ["user_name:" + CANARY + "@example.com", "user_name:" + CANARY + "#x@example.com", "user_name:" + CANARY + "?x@example.com", "1user:" + CANARY + "@example.com"]) {
    const shown = maskLocation(written, BASE);
    assert.ok(!shown.includes(CANARY), written + " shows " + shown);
    assert.equal(shown, /[?#]/.test(written) ? "***" : "***@example.com", written);
  }
  // A relative reference with no user information in it is still resolved against the base, as before.
  assert.equal(maskLocation("path@2x.png", BASE), "https://example.com/path@2x.png");
  assert.equal(maskLocation("/hop1", BASE), "https://example.com/hop1");
  assert.equal(maskLocation("p?mail=a@b.com", BASE), "https://example.com/p?mail=***");
  assert.equal(maskLocation("docs/@name", BASE), "https://example.com/docs/@name");
  assert.equal(maskLocation("//cdn.example.com/a@2x.png", BASE), "https://cdn.example.com/a@2x.png");
  // Found by the independent check before release: with no colon before the last @ the base reading stays, and a ? or
  // # before the colon keeps the text after it out of the query name of the resolved address.
  assert.equal(maskLocation("@scope/pkg", BASE), "https://example.com/@scope/pkg");
  assert.equal(maskLocation("a@b.com/x", BASE), "https://example.com/a@b.com/x");
  assert.equal(maskLocation("user?x:" + CANARY + "@example.com", BASE), "user?***");
  assert.equal(maskLocation("user#x:" + CANARY + "@example.com", BASE), "user");
  assert.equal(maskLocation("a/b?x=1", BASE), "https://example.com/a/b?x=***");
});

test("V4-1, base form: a fifth redirect to a scheme-less user:password@host is refused as too many without the password", async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: calls <= 4 ? "https://example.com/hop" + calls : "user_name:" + CANARY + "@example.com" } });
  }) as typeof fetch;
  try {
    const f = await fetchLlmsTxt("example.com") as FetchRedirect;
    assert.equal(f.reason, "too-many");
    assert.ok(!f.location.includes(CANARY), "too-many shows " + f.location);
    assert.equal(f.location, "***@example.com");
  } finally { globalThis.fetch = orig; }
});

test("V4-1: the command line --json target hides the password of a DOMAIN-backslash-user value", () => {
  const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
  const arg = "CORP" + BS + "erik:pa#" + CANARY + "@example.com";
  const r = spawnSync(process.execPath, [cli, arg, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  const report = JSON.parse(r.stdout) as { error: string; target: string };
  assert.equal(report.target, "***@example.com");
  assert.ok(!(r.stdout + r.stderr).includes(CANARY) && !(r.stdout + r.stderr).includes(":pa"), "leaks: " + r.stdout + r.stderr);
});

test("V4-3: a leading space or C0 control character no longer hides an ambiguous scheme start", () => {
  for (const lead of [" ", "  ", String.fromCharCode(1), String.fromCharCode(0), String.fromCharCode(31) + " "]) {
    for (const base of [undefined, BASE]) {
      const shown = maskLocation(lead + "https:/user:" + CANARY + "@@example.com", base);
      assert.equal(shown, "https://***", JSON.stringify(lead) + " with base " + base);
    }
  }
  // Trailing spaces and controls go the same way, and a written form passed with a parsed address is read alike.
  assert.equal(maskLocation("https:/user:" + CANARY + "@example.com " + String.fromCharCode(2), BASE), "https://***");
  const parsed = new URL("https:/user:" + CANARY + "@example.com/a", BASE).href;
  assert.equal(maskLocation(parsed, undefined, " https:/user:" + CANARY + "@example.com/a"), "https://***");
  // Characters inside the text stay, as before.
  assert.equal(maskLocation("ht" + String.fromCharCode(1) + "tps://SECRETuser:SECRETpw@host/x?t=1"), "ht" + String.fromCharCode(1) + "tps://***@host/x?***");
});

test("third and fourth independent checks: a Unicode space before the scheme, a refused scheme word with a slash, and an authority the parser refuses", () => {
  for (const base of [undefined, BASE]) {
    for (const lead of [0xa0, 0x2003, 0x3000, 0x200b, 0xfeff, 0x85, 0xfffd]) {
      assert.equal(maskLocation(String.fromCharCode(lead) + "https:/user:" + CANARY + "@example.com", base), "https://***", lead.toString(16));
    }
    assert.equal(maskLocation(String.fromCharCode(0xa0) + "https://user:" + CANARY + "@example.com/p", base), "https://example.com/p");
    assert.equal(maskLocation(String.fromCharCode(0x2003) + "https://user:" + CANARY + "@example.com/p?q=1", base), "https://example.com/p?q=***");
    assert.equal(maskLocation("my_app:/user:" + CANARY + "@example.com", base), "my_app://***");
    assert.equal(maskLocation("my_app:" + BS + "user:" + CANARY + "@example.com", base), "my_app://***");
    assert.equal(maskLocation("ht tps:/user:" + CANARY + "@example.com", base), "//***");
    assert.equal(maskLocation("https://user:pa/ss?" + CANARY + "@example.com/x", base), "https://***");
    assert.equal(maskLocation("https://example.com:99999/a?x@b", base), "https://***");
    assert.equal(maskLocation("https://example.com:99999/a@b", base), "https://***@b");
  }
  // Unchanged: an address the parser reads, an invalid scheme with two slashes, and a relative path.
  assert.equal(maskLocation("https://example.com/@team/x"), "https://example.com/@team/x");
  assert.equal(maskLocation("my_app://SECRETuser:SECRETpw@host/p"), "my_app://***@host/p");
  assert.equal(maskLocation("/docs/a@2x.png", BASE), "https://example.com/docs/a@2x.png");
});

test("CT-1: the content-type check lowercases ASCII only and trims HTTP white space only", () => {
  const check = (contentType: string) => byId(validateLlmsTxt({ status: 200, contentType, text: "# Example\n\n> Summary.\n", bytes: 22, truncated: false }), "content-type");
  for (const ok of ["text/plain", "TEXT/Plain; charset=utf-8", " text/markdown", "text/plain\t", "text/markdown ; charset=utf-8"]) {
    assert.equal(check(ok).status, "pass", JSON.stringify(ok));
  }
  const bad = [
    String.fromCharCode(0xa0) + "text/plain",
    "text/mar" + String.fromCharCode(0x212a) + "down",
    String.fromCharCode(0xfeff) + "text/plain",
    String.fromCharCode(0x3000) + "text/markdown",
    "text/plain" + String.fromCharCode(0x0b),
    "text/markdown" + String.fromCharCode(0x0c),
  ];
  for (const t of bad) assert.equal(check(t).status, "warn", JSON.stringify(t));
});
