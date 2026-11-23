import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fetchLlmsTxt, maskLocation, validateHost } from "../src/index.js";
import type { FetchedLlmsTxt, FetchRedirect, LlmsCheck } from "../src/index.js";

// Regression tests for the two masking leaks of the C1c outside run and the K2 reading of 2026-11-22/23 (decision
// Tek-898). V1: a Location header reaches the code as one code unit per byte, so a leading U+3000, U+00A0 or U+200B
// written as UTF-8 bytes was not seen as an edge character and the followed address showed the password. K2-F1: a
// leading U+200E or U+00AD in front of "//user:password@host" was not removed either, so the CLI --json target showed
// the password. Each case gave the other answer in 0.8.3. The hosted validator carries the same cases in
// test/validator-mask-2026-11-23.test.ts of turva-worker. CANARY is a made-up value, no real secret. Characters outside
// printable ASCII are built with String.fromCharCode and String.fromCodePoint, so this file stays ASCII.

const BS = String.fromCharCode(92);
const CANARY = "CANARYPWD7f3a";
const byId = (checks: LlmsCheck[], id: string): LlmsCheck | undefined => checks.find((c) => c.id === id);
const PAGE = "# Title\n\n> Summary.\n\n## Docs\n\n- [A](https://example.com/a): one\n";
const cp = (n: number) => String.fromCodePoint(n);
// The way a header value arrives from fetch: one code unit per byte of the UTF-8 text.
const asHeader = (s: string) => Buffer.from(s, "utf8").toString("latin1");
// The address a report shows for a fetch result: the location of a refused redirect, or the final address of a followed
// one in the form validateHost prints it.
const shownOf = (f: FetchedLlmsTxt | FetchRedirect): string => {
  if ("redirect" in f) return (f as FetchRedirect).location;
  const done = f as FetchedLlmsTxt;
  return done.shownFinalUrl ?? done.finalUrl;
};
// What validateHost does with an address it refuses to read: it throws, and the message must not show the password.
async function validateOrMessage(text: string): Promise<string> {
  try { return JSON.stringify(await validateHost(text)); } catch (e) { return String((e as Error).message); }
}

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

// Every code point the edge trim is meant to remove: controls, separators, format characters and the default-ignorable
// code points, which are the ones a reader does not see. Surrogates are no characters.
const EDGE_RE = /^[\s\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}]$/u;
function invisibleCodePoints(): number[] {
  const out: number[] = [];
  for (let n = 0; n <= 0x10ffff; n++) {
    if (n >= 0xd800 && n <= 0xdfff) continue;
    if (EDGE_RE.test(String.fromCodePoint(n))) out.push(n);
  }
  return out;
}

test("V1: a Location written as UTF-8 bytes with an invisible first character is masked like the same Location without it", async () => {
  const leads = [0x3000, 0xa0, 0x200b, 0x200e, 0xad, 0x2028, 0xfeff, 0x2003, 0x2060, 0x180e].map(cp);
  for (const lead of leads) {
    const loc = asHeader(lead + "/" + BS + "erik:" + CANARY + "@example.com/p");
    const r = await withRedirects([loc], () => validateHost("example.com"));
    const status = byId(r.checks, "http-status")!;
    assert.equal(status.status, "pass", JSON.stringify(lead));
    assert.equal(status.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to https://example.com/***", JSON.stringify(lead));
    assert.ok(!JSON.stringify(r).includes(CANARY), JSON.stringify(lead));
    const f = await withRedirects([loc], () => fetchLlmsTxt("example.com")) as FetchedLlmsTxt;
    assert.equal(f.shownFinalUrl, "https://example.com/***", JSON.stringify(lead));
  }
});

test("V1: a refused Location written as UTF-8 bytes with an invisible first character does not show the password", async () => {
  for (const lead of [0x3000, 0xa0, 0x200e, 0xad].map(cp)) {
    for (const tail of ["https://user:" + CANARY + "@other.example/x", "//user:" + CANARY + "@other.example/x", "http://user:" + CANARY + "@example.com/x"]) {
      const f = await withRedirects([asHeader(lead + tail)], () => fetchLlmsTxt("example.com"));
      assert.ok(!shownOf(f).includes(CANARY), JSON.stringify(lead + tail) + " -> " + shownOf(f));
    }
  }
});

test("V1: a Location that is not valid UTF-8 is read as it arrived and still followed", async () => {
  const r = await withRedirects(["/caf" + String.fromCharCode(0xe9) + "/x"], () => validateHost("example.com"));
  const status = byId(r.checks, "http-status")!;
  assert.equal(status.status, "pass");
  assert.equal(status.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to https://example.com/caf%C3%A9/x");
  // An invalid byte before the first or after the last ASCII character is read as an edge character, so the address is
  // shown as the masked form, still followed.
  const e = await withRedirects([String.fromCharCode(0xe9) + "/x"], () => validateHost("example.com"));
  assert.equal(byId(e.checks, "http-status")!.detail, "HTTP 200, followed a redirect from https://example.com/llms.txt to https://example.com/***");
});

// QA-1 of the same round: a Location with a multi-byte invisible lead and also one byte that is not valid UTF-8 fell back to
// the form as it arrived, where the lead is not an edge character, and the password was shown.
test("V1: an invalid UTF-8 byte in the Location does not bring the password back behind a multi-byte invisible lead", async () => {
  const bad = String.fromCharCode(0xff);
  for (const lead of [0x3000, 0xa0, 0x200b, 0x200e, 0xad, 0xfeff, 0x2060, 0xe0001, 0x3164, 0x2800].map(cp)) {
    const form = "//user:" + CANARY + "@example.com/x";
    const heads = [asHeader(lead) + asHeader(form) + bad, bad + asHeader(lead) + asHeader(form), asHeader(lead) + bad + asHeader(form), asHeader(lead + form) + String.fromCharCode(0xc3)];
    for (const loc of heads) {
      const f = await withRedirects([loc], () => fetchLlmsTxt("example.com"));
      assert.ok(!shownOf(f).includes(CANARY), JSON.stringify(loc) + " -> " + shownOf(f));
      const r = await withRedirects([loc], () => validateHost("example.com"));
      assert.ok(!JSON.stringify(r).includes(CANARY), JSON.stringify(loc));
    }
  }
});

test("K2-F1: maskLocation removes every invisible character at the start of //user:password@host", () => {
  const cps = invisibleCodePoints();
  assert.ok(cps.length > 4000, "the property classes are present in this runtime: " + cps.length);
  for (const n of cps) {
    for (const form of ["//user:" + CANARY + "@host.example", "//user:" + CANARY + "@host.example/p"]) {
      assert.ok(!maskLocation(cp(n) + form).includes(CANARY), "lead U+" + n.toString(16));
      assert.ok(!maskLocation(form + cp(n)).includes(CANARY), "trail U+" + n.toString(16));
    }
  }
});

test("K2-F1: the --json report of a rejected address does not show the password behind an invisible first character", () => {
  const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));
  for (const n of [0x200e, 0xad, 0x2060, 0x80, 0x7f, 0x61c, 0x2066, 0x200d, 0xe0001, 0x3164, 0x2800]) {
    const arg = cp(n) + "//user:" + CANARY + "@host.example";
    const r = spawnSync(process.execPath, [cli, arg, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 2, "U+" + n.toString(16));
    assert.ok(!(r.stdout + r.stderr).includes(CANARY), "U+" + n.toString(16) + " " + r.stdout);
    assert.equal(JSON.parse(r.stdout).target, "//***@host.example", "U+" + n.toString(16));
  }
});

// A light absolute check: the password is in no output string, whatever invisible characters surround the user
// information. The generator is seeded, so a failure repeats. The heavier run is the script under the work folder of the
// C1c masking round.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const FORMS = [
  "//user:" + CANARY + "@host.example",
  "//user:" + CANARY + "@host.example/p?x=1",
  "https:/user:" + CANARY + "@example.com/p",
  "https://user:" + CANARY + "@example.com/p",
  "user_name:" + CANARY + "@example.com",
  ":" + CANARY + "@example.com",
  "CORP" + BS + "erik:" + CANARY + "@example.com",
  "/" + BS + "erik:" + CANARY + "@example.com/p",
  BS + BS + "erik:" + CANARY + "@example.com/p",
  "my_app:/user:" + CANARY + "@example.com",
  "user?x:" + CANARY + "@example.com",
];
const INVISIBLE = [0x3000, 0xa0, 0x200b, 0x200e, 0x200f, 0xad, 0x2028, 0x2029, 0xfeff, 0x2003, 0x2060, 0x180e, 0x61c, 0x202e, 0x3164, 0x2800, 0xfe0f, 0xe0001, 0x80, 0x7f, 0x85, 0x1680].map(cp);

test("oracle: the password is in no output whatever invisible characters surround the user information", async () => {
  const next = rng(20261123);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)]!;
  let checked = 0;
  for (let i = 0; i < 700; i++) {
    const form = pick(FORMS);
    const lead = Array.from({ length: Math.floor(next() * 3) }, () => pick(INVISIBLE)).join("");
    const trail = Array.from({ length: Math.floor(next() * 2) }, () => pick(INVISIBLE)).join("");
    const text = lead + form + trail;
    const where = JSON.stringify(text);
    // The masking function, on the text as written.
    assert.ok(!maskLocation(text).includes(CANARY), "mask " + where);
    // The address typed as the argument.
    const typed = await withRedirects([], () => validateOrMessage(text));
    assert.ok(!typed.includes(CANARY), "argument " + where);
    // The address as a Location, as real characters (single byte where it fits) and as UTF-8 bytes.
    // The byte form again with one byte that is not valid UTF-8 at the start, between the lead and the form, or at the end.
    const bytes = asHeader(text);
    const noisy = [asHeader(lead) + String.fromCharCode(0xff) + asHeader(form + trail), String.fromCharCode(0xff) + bytes, bytes + String.fromCharCode(0xff)];
    for (const loc of [text, bytes, ...noisy]) {
      if ([...loc].some((c) => c.charCodeAt(0) > 0xff)) continue;
      const r = await withRedirects([loc], () => validateHost("example.com"));
      assert.ok(!JSON.stringify(r).includes(CANARY), "redirect " + JSON.stringify(loc));
      const f = await withRedirects([loc], () => fetchLlmsTxt("example.com"));
      assert.ok(!shownOf(f).includes(CANARY), "shown " + JSON.stringify(loc));
      checked++;
    }
  }
  assert.ok(checked > 600, "checked " + checked);
});
