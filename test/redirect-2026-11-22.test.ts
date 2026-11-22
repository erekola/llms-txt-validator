import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchLlmsTxt, validateHost, validateLlmsTxt, enteredPath } from "../src/index.js";
import type { FetchedLlmsTxt, FetchRedirect, LlmsCheck } from "../src/index.js";

// Regression tests for the leaks an independent rerun against 0.8.1 found on 2026-11-22 (n1, n7, n8, n9 and the test
// gap n18): a followed redirect, the unused typed path, the host named in an error and the unknown-option error. Each
// case gave the other answer in 0.8.2. The hosted validator carries the same cases in test/redirect-2026-11-22.test.ts
// of turva-worker. CANARY is a made-up value, no real secret. Characters outside printable ASCII are built with
// String.fromCharCode, so this file stays ASCII.

const BS = String.fromCharCode(92);
const CANARY = "CANARYPWD7f3a";
const byId = (checks: LlmsCheck[], id: string): LlmsCheck | undefined => checks.find((c) => c.id === id);
const PAGE = "# Title\n\n> Summary.\n\n## Docs\n\n- [A](https://example.com/a): one\n";

// Answers each request with the next Location of the list, and with the page once the list is used up.
async function withRedirects<T>(locations: string[], fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  const queue = [...locations];
  globalThis.fetch = (async () => {
    const loc = queue.shift();
    if (loc !== undefined) return new Response(null, { status: 302, headers: { location: loc } });
    return new Response(PAGE, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }) as typeof fetch;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

const HIDING = [
  "user_name:" + CANARY + "@example.com",
  ":" + CANARY + "@e.com",
  "CORP" + BS + "erik:" + CANARY + "@example.com",
  "my_app:/user:" + CANARY + "@example.com",
  "https:/user:" + CANARY + "@example.com",
  "user?x:" + CANARY + "@example.com",
  String.fromCharCode(0xa0) + "https://user:" + CANARY + "@example.com/p",
];

test("n1: a followed same-host redirect whose Location reads as user information shows the host and /*** only", async () => {
  // A later query or fragment keeps the hidden path, so the mark stays.
  for (const loc of HIDING) {
    for (const after of [[], ["?q=1"], ["#f"]]) {
      const r = await withRedirects([loc, ...after], () => validateHost("example.com"));
      const status = byId(r.checks, "http-status")!;
      assert.equal(status.status, "pass", JSON.stringify(loc));
      assert.equal(status.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to https://example.com/***", JSON.stringify(loc) + " " + JSON.stringify(after));
      assert.ok(!JSON.stringify(r).includes(CANARY), JSON.stringify(loc) + " " + JSON.stringify(after));
    }
  }
});

test("F1: a later .. or ../x keeps the mark while hidden segments stay, and clears it once none do", async () => {
  const cases: Array<[string[], string]> = [
    [["https:/user:" + CANARY + "@example.com/q/r/s", ".."], "https://example.com/***"],
    [["user_name:" + CANARY + "@example.com/q/r", "../x"], "https://example.com/***"],
    [["user_name:" + CANARY + "@example.com/q/r", "next"], "https://example.com/***"],
    [["user_name:" + CANARY + "@example.com/q", "../../../.."], "https://example.com/"],
    // A relative path that replaces the only hidden segment leaves nothing of it.
    [["user_name:" + CANARY + "@example.com", "next"], "https://example.com/next"],
  ];
  for (const [locs, shown] of cases) {
    const r = await withRedirects(locs, () => validateHost("example.com"));
    assert.equal(byId(r.checks, "http-status")!.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to " + shown, JSON.stringify(locs));
    assert.ok(!JSON.stringify(r).includes(CANARY), JSON.stringify(locs));
  }
});

test("n1: a later Location that keeps nothing of the hidden address clears the mark", async () => {
  const cases: Array<[string, string]> = [
    ["/x?k=v", "https://example.com/x?k=***"],
    ["https://www.example.com/llms.txt", "https://www.example.com/llms.txt"],
    ["//example.com/llms.txt", "https://example.com/llms.txt"],
  ];
  for (const loc of HIDING) {
    for (const [after, shown] of cases) {
      const r = await withRedirects([loc, after], () => validateHost("example.com"));
      assert.equal(byId(r.checks, "http-status")!.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to " + shown, JSON.stringify(loc) + " " + after);
      assert.ok(!JSON.stringify(r).includes(CANARY), JSON.stringify(loc) + " " + after);
    }
  }
});

test("n1: fetchLlmsTxt returns shownFinalUrl for such a chain, and finalUrl as the parser resolved it", async () => {
  const f = await withRedirects(["user_name:" + CANARY + "@example.com"], () => fetchLlmsTxt("example.com")) as FetchedLlmsTxt;
  assert.equal(f.status, 200);
  assert.equal(f.shownFinalUrl, "https://example.com/***");
  assert.equal(f.finalUrl, "https://example.com/user_name:" + CANARY + "@example.com");
});

test("n18: a followed redirect that hides nothing is shown as before, with no shownFinalUrl", async () => {
  const cases: Array<[string[], string]> = [
    [["/docs/llms.txt"], "https://example.com/docs/llms.txt"],
    [["/docs/llms.txt", "next"], "https://example.com/docs/next"],
    [["/x?k=v"], "https://example.com/x?k=***"],
    [["https://www.example.com/llms.txt"], "https://www.example.com/llms.txt"],
    [["https://example.com./llms.txt"], "https://example.com/llms.txt"],
    [["/team@example.com"], "https://example.com/team@example.com"],
  ];
  for (const [locs, shown] of cases) {
    const f = await withRedirects(locs, () => fetchLlmsTxt("example.com")) as FetchedLlmsTxt;
    assert.equal(f.shownFinalUrl, undefined, JSON.stringify(locs));
    assert.equal(byId(validateLlmsTxt(f), "http-status")!.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to " + shown, JSON.stringify(locs));
  }
});

test("n1: a refused Location after a hiding hop is read without the hidden address as its base", async () => {
  // The hidden part spans two segments, so each later one-segment path keeps part of it and the mark stays.
  const f = await withRedirects(["user_name:" + CANARY + "@example.com/q/r", "a", "b", "c", "d"], () => fetchLlmsTxt("example.com")) as FetchRedirect;
  assert.equal(f.reason, "too-many");
  assert.equal(f.location, "d");
});

test("n1: a hand-built input with shownFinalUrl shows it, one without it shows finalUrl masked", () => {
  const base = { status: 200, contentType: "text/plain", text: PAGE, bytes: PAGE.length, truncated: false, redirectedFrom: "https://example.com/llms.txt" };
  assert.equal(byId(validateLlmsTxt({ ...base, finalUrl: "https://example.com/x", shownFinalUrl: "https://example.com/***" }), "http-status")!.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to https://example.com/***");
  assert.equal(byId(validateLlmsTxt({ ...base, finalUrl: "https://example.com/x?k=v" }), "http-status")!.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to https://example.com/x?k=***");
});

test("n7: a typed path that holds user information the parser moved is shown as /***", async () => {
  assert.equal(enteredPath("https://corp.example" + BS + "erik:" + CANARY + "@host.example"), "/***");
  assert.equal(enteredPath("corp.example" + BS + "erik:" + CANARY + "@host.example"), "/***");
  // Controls: a path with no @, and a path in which a / stands before the @, are shown as typed.
  assert.equal(enteredPath("example.com/docs/llms.txt"), "/docs/llms.txt");
  assert.equal(enteredPath("https://example.com/team@example.com"), "/team@example.com");
  assert.equal(enteredPath("https://example.com/llms.txt"), "");
  const r = await withRedirects([], () => validateHost("https://corp.example" + BS + "erik:" + CANARY + "@host.example"));
  assert.equal(byId(r.checks, "input-path")!.value, "/***");
  assert.ok(!JSON.stringify(r).includes(CANARY));
});

test("n8: a refused typed address is named by its host only when that host follows the last @", async () => {
  const refused = async (typed: string): Promise<string> => {
    try { await validateHost(typed); } catch (e) { return (e as Error).message; }
    throw new Error("not refused: " + typed);
  };
  assert.equal(await refused("//CANARYUSER?@example.com"), "not a public domain name");
  assert.equal(await refused("CANARYUSER#:" + CANARY + "@example.com"), "not a public domain name");
  assert.equal(await refused("https://CANARYUSER:443#@example.com"), "not a public domain name");
  // Controls: a host before a ? with no @, and a typed value with no @, ? or #, are named as before.
  assert.equal(await refused("intra.local?x=1"), "not a public domain name: intra.local");
  assert.equal(await refused("intra.local"), "not a public domain name: intra.local");
});

test("n9: an unknown option is named by its dashes and name only", () => {
  const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
  const cases: Array<[string, string]> = [
    ["-u:" + CANARY + "@example.com", 'unknown option "-u" (the rest of the argument is not shown)'],
    ["--json=" + CANARY, 'unknown option "--json" (the rest of the argument is not shown)'],
    ["--jsonx", 'unknown option "--jsonx"'],
  ];
  for (const [arg, message] of cases) {
    const r = spawnSync(process.execPath, [cli, arg, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, arg);
    assert.equal(JSON.parse(r.stdout).error, message, arg);
    assert.ok(!(r.stdout + r.stderr).includes(CANARY), arg);
  }
});
