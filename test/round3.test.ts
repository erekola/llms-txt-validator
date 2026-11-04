// Round 3 (Tek-542), batch Fv: Codex's third-round verification found five confirmed npm-package
// findings in scope for this batch: V03-VN1, V03-VREG1, V03-VREG2, V03-VREG3/VN3 and V03-VN2
// (shortcut and collapsed references only). V10-P3-01 (package side) is the sixth. Every
// reproduction input below is the exact fixture from varmennus-V03.md / V03-vastaus.md, or the
// exact case named in korjausohje-3.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { validateLlmsTxt, summarizeChecks, validateHost, maskLocation } from "../src/index.js";
import type { FetchedLlmsTxt, LlmsCheck } from "../src/index.js";

const good = (text: string, extra: Partial<FetchedLlmsTxt> = {}) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false, ...extra });
const byId = (checks: LlmsCheck[], id: string): LlmsCheck => checks.find((c) => c.id === id)!;
const prefix = "# Example\n\n> Summary\n\n## Docs\n\n";

// --- V03-VN1: maskLocation must mask userinfo even when the scheme is not recognised, as long
// as an @ appears before the first /. Codex's exact CLI reproduction:
// llms-txt-validate 'AUDIT_USER:AUDIT_SECRET_64923@example.com/?token=TOPSECRET#FRAGMENTSECRET' --json
test("VN1: maskLocation masks an unrecognised-scheme userinfo when an @ precedes the first /", () => {
  assert.equal(
    maskLocation("AUDIT_USER:AUDIT_SECRET_64923@example.com/?token=TOPSECRET#FRAGMENTSECRET"),
    "***@example.com/?***"
  );
  // A leading digit in the would-be scheme.
  assert.equal(
    maskLocation("1user:AUDIT_SECRET_64923@example.com/?token=TOPSECRET#FRAGMENTSECRET"),
    "***@example.com/?***"
  );
  // A leading ASCII space (R1's own fixture prefixed by one space).
  assert.equal(
    maskLocation(" u:AUDIT_SECRET_64923@example.com/?token=TOPSECRET#FRAGMENTSECRET"),
    "***@example.com/?***"
  );
  // A literal ESC inside the would-be scheme.
  assert.equal(maskLocation("u\x1b:AUDIT_SECRET@example.com/"), "***@example.com/");
});

test("VN1: the CLI target field masks the same underscore-username case", () => {
  const res = spawnSync(process.execPath, [
    "dist/bin/cli.js",
    "AUDIT_USER:AUDIT_SECRET_64923@example.com/?token=TOPSECRET#FRAGMENTSECRET", "--json"
  ]);
  const out = JSON.parse(res.stdout.toString());
  assert.equal(out.error, "not a public domain name");
  assert.equal(out.target, "***@example.com/?***");
  assert.ok(!out.target.includes("AUDIT_SECRET"));
});

test("VN1: an @ with no / anywhere in the string is still read as a path, not userinfo", () => {
  // Regression guard: "path@2x.png" must stay unmasked (validate.test.ts already covers this
  // for maskLocation directly; this repeats the exact boundary this fix must not cross).
  assert.equal(maskLocation("path@2x.png"), "path@2x.png");
});

// V13 D5-1: with no slash at all, a ":" ahead of the last @ is user:password and is masked; an @
// with no ":" ahead of it (an asset name) stays as given.
test("V13 D5-1: a slashless user:password@host is masked, path@2x.png is not", () => {
  assert.equal(maskLocation("user_name:demo-secret@example.com"), "***@example.com");
  assert.equal(maskLocation("a_b:pw@example.com"), "***@example.com");
  assert.equal(maskLocation("1user:pw@example.com"), "***@example.com");
  assert.equal(maskLocation("user_name:pw@host?x=1"), "***@host?***");
  assert.equal(maskLocation("path@2x.png"), "path@2x.png");
  assert.equal(maskLocation("path/x@y"), "path/x@y");
});

test("V13 D5-1: the CLI --json target never carries the password of a slashless user:password@host", () => {
  for (const input of ["user_name:demo-secret@example.com", "a_b:pw@example.com", "1user:pw@example.com", "user_name:pw@host?x=1"]) {
    const res = spawnSync(process.execPath, ["dist/bin/cli.js", input, "--json"]);
    assert.equal(res.status, 2, input);
    const out = JSON.parse(res.stdout.toString());
    assert.ok(typeof out.target === "string" && out.target.startsWith("***@"), input + " -> " + out.target);
    assert.doesNotMatch(res.stdout.toString(), /demo-secret|pw/, input);
  }
  const plain = JSON.parse(spawnSync(process.execPath, ["dist/bin/cli.js", "path@2x.png", "--json"]).stdout.toString());
  assert.equal(plain.target, "path@2x.png");
});

// --- V03-VREG1: a link reference definition is CommonMark-valid only in its own block, not
// inside a code span or as a paragraph continuation line, with a title that is quoted or
// absent; fence removal must not join lines across a fenced block. Codex's four exact cases.
test("VREG1: a definition with an unquoted trailing word is not a definition", () => {
  const text = prefix + "- [Guide][guide]\n\n[guide]: https://example.com/guide not-a-title\n";
  const checks = validateLlmsTxt(good(text));
  assert.match(byId(checks, "links").detail, /^no markdown links found/);
});

test("VREG1: a definition-shaped line inside an inline code span is literal code", () => {
  const text = prefix + "- [Guide][guide]\n\n`some code\n[guide]: https://example.com/guide\nend code`\n";
  const checks = validateLlmsTxt(good(text));
  assert.match(byId(checks, "links").detail, /^no markdown links found/);
});

test("VREG1: a definition-shaped line that continues open paragraph text is not a definition", () => {
  const text = prefix + "- [Guide][guide]\n\nA paragraph\n[guide]: https://example.com/guide\n";
  const checks = validateLlmsTxt(good(text));
  assert.match(byId(checks, "links").detail, /^no markdown links found/);
});

test("VREG1: fence removal does not join a link target across a fenced code block", () => {
  const text = prefix + "- [Guide](\n```\nanything\n```\n  https://example.com/guide\n  )\n";
  const checks = validateLlmsTxt(good(text));
  assert.match(byId(checks, "links").detail, /^no markdown links found/);
});

// --- V03-VREG2: codeSpanMask must not cross a block boundary (list item, heading, or a blank
// line made only of spaces/tabs), not only a literal blank line. Codex's exact fixture.
test("VREG2: backticks in two different list items do not hide a real link between them", () => {
  const text = "# Example\n\n> Summary\n\n## Docs\n\n- `literal\n- [Guide](https://example.com/guide)\n- literal`\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
  assert.equal(byId(checks, "links").detail, "1 link, all absolute URLs");
});

test("VREG2: a blank line made only of spaces still breaks a code span", () => {
  const text = "# Example\n\n> Summary\n\n## Docs\n\n`one\n   \ntwo` [Guide](https://example.com/guide)\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
});

test("VREG2: a heading between two backtick runs still breaks a code span", () => {
  const text = "# Example\n\n> Summary\n\n## Docs\n\n`literal\n## Heading\n[Guide](https://example.com/guide) literal`\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
});

// --- V03-VREG3/VN3: the link-to-line mapping must not restart its line scan for every link.
// Codex's exact generator (n reduced here for a fast unit test; the timed comparison itself is
// reported separately in korjaus-Fv.md, not asserted as a hard threshold in CI).
test("VREG3/VN3: a many-link document maps every link to a line without restarting the scan", () => {
  const n = 3000;
  const text = "# Example\n\n> Summary\n\n## Docs\n" + "\n".repeat(n * 8) + "- [a](https://a.com/)\n".repeat(n);
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
  assert.match(byId(checks, "sections").detail, /1 carrying a file list/);
});

test("VREG3/VN3: the mapped line index still matches the real position for a small document", () => {
  const text = prefix + "- [First](https://example.com/a)\n- [Second](https://example.com/b)\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "sections").status, "pass");
  assert.match(byId(checks, "sections").detail, /1 carrying a file list/);
});

// --- V03-VN2 (scope: shortcut and collapsed references only).
test("VN2: a shortcut reference, \"[label]\" alone, resolves against its definition", () => {
  const text = prefix + "- [Guide]\n\n[Guide]: https://example.com/guide\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
  assert.equal(byId(checks, "links").detail, "1 link, all absolute URLs");
});

test("VN2: a shortcut reference does not resolve the definition line against itself", () => {
  // The definition line "[guide]: ..." must not be read as its own shortcut use (the "[guide]"
  // in it is immediately followed by ":", not by nothing).
  const text = prefix + "- [Guide]\n\n[guide]: https://example.com/guide\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").detail, "1 link, all absolute URLs");
});

test("VN2: an unresolved shortcut reference is read as plain brackets", () => {
  const text = prefix + "- [Guide]\n";
  const checks = validateLlmsTxt(good(text));
  assert.match(byId(checks, "links").detail, /^no markdown links found/);
});

test("VN2: a collapsed reference, \"[label][]\", still resolves (regression guard)", () => {
  const text = prefix + "- [Guide][]\n\n[guide]: https://example.com/guide\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
});

// --- V10-P3-01 (package side): the typed-path note carries its value in a separate field,
// mirroring worker.ts's decision 19 (Tek-526), instead of building it into the sentence.
test("V10-P3-01: the input-path check's value and detail are separate fields", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "# Example\n\n> One line.\n\n## Docs\n\n- [G](https://ex.com/g)\n",
    { status: 200, headers: { "content-type": "text/plain" } }
  );
  try {
    const typed = await validateHost("https://ex.com/docs/llms.txt?key=secret");
    assert.equal(typed.checks[0]!.id, "input-path");
    assert.equal(typed.checks[0]!.value, "/docs/llms.txt");
    assert.equal(
      typed.checks[0]!.detail,
      "This path is not used, because the validator always reads /llms.txt at the root of the host."
    );
  } finally { globalThis.fetch = orig; }
});

// --- Tek-745 K9 (0.5.1): a backtick pair that crosses a block boundary no longer consumes its closer, so the
// closer can open a span of its own in its own block. Before, the scan jumped past the closer: a stray
// backtick in one block moved the mask by one run, a link inside the next real span counted as a link
// (C-01, a false pass) and a real link after a lone backtick in a list item could be read as code (N3, a
// false warn). The hosted validator carries the same cases in test/llms-validator-round3.test.ts.
const BSL = String.fromCharCode(92);
const p745 = "# T\n\n> Summary\n\n## Docs\n\n";
const linksCheck = (text: string) => { const c = byId(validateLlmsTxt(good(text)), "links"); return c.status + " | " + c.detail; };

// codeSpanMask is not exported, so the compiled module is copied next to itself, in dist/src, with one export
// added. It has to sit there because the module reads package.json relative to its own folder.
let maskCache: ((text: string) => Uint8Array) | null = null;
async function loadMask(): Promise<(text: string) => Uint8Array> {
  if (maskCache) return maskCache;
  const indexUrl = new URL("../src/index.js", import.meta.url);
  const copy = new URL("../src/index-with-mask-" + process.pid + ".mjs", import.meta.url);
  writeFileSync(copy, readFileSync(indexUrl, "utf8") + "\nexport { codeSpanMask };\n");
  try {
    const mod = await import(copy.href);
    maskCache = mod.codeSpanMask as (text: string) => Uint8Array;
    return maskCache;
  } finally {
    rmSync(copy, { force: true });
  }
}

test("Tek-745 C-01: a stray backtick in an earlier block does not move the mask onto the next real span", () => {
  const stray = linksCheck(p745 + "`\n\n`[Guide](https://example.com/guide)`\n");
  const control = linksCheck(p745 + "`[Guide](https://example.com/guide)`\n");
  assert.equal(control, "warn | no markdown links found");
  assert.equal(stray, control);
});

test("Tek-745 N3: a lone backtick at the end of one list item does not turn the next item's real span and text into code", () => {
  const text = "# T\n\n> s\n\n## Docs\n\n- [A](https://example.com/a) `\n- see `[B](/relative)` here\n";
  assert.equal(linksCheck(text), "pass | 1 link, all absolute URLs");
});

test("Tek-745: what must not change when the closer stays free", () => {
  // a real link after a lone backtick in another block still counts
  assert.equal(linksCheck(p745 + "- [A](https://example.com/a) `x\n\n[B](https://example.com/b) and `y`\n"), "pass | 2 links, all absolute URLs");
  // a real span inside one block still masks its link text
  assert.equal(linksCheck(p745 + "- [A](https://example.com/a) `[B](https://example.com/b)`\n"), "pass | 1 link, all absolute URLs");
  // a span across a soft line break inside one paragraph still masks
  assert.equal(linksCheck(p745 + "`one\n[B](https://example.com/b) two`\n"), "warn | no markdown links found");
  // an unclosed run stays literal
  assert.equal(linksCheck(p745 + "- [A](https://example.com/a) `x [B](https://example.com/b)\n"), "pass | 2 links, all absolute URLs");
  // a double-backtick span holds a single backtick and masks to its closing run
  assert.equal(linksCheck(p745 + "- [A](https://example.com/a) ``x`y [B](https://example.com/b)``\n- [C](https://example.com/c)\n"), "pass | 2 links, all absolute URLs");
  // VREG2: backticks in two list items still enclose no real link between them
  assert.equal(linksCheck(p745 + "- `literal\n- [Guide](https://example.com/guide)\n- literal`\n"), "pass | 1 link, all absolute URLs");
});

test("Tek-745: the mask itself, run by run", async () => {
  const codeSpanMask = await loadMask();
  const shown = (t: string) => Array.from(codeSpanMask(t), (v, i) => (v ? t[i] : "-")).join("");
  // the closer of a crossing pair opens its own span in its own block
  assert.equal(shown("a `\n\nb `c` d"), "-------`c`--");
  assert.equal(shown("`one\ntwo`"), "`one\ntwo`");
  assert.equal(shown("`one\n\ntwo`"), "----------");
  assert.equal(shown("``a`b`` c"), "``a`b``--");
  assert.equal(shown("x ` y"), "-----");
  // an escaped first backtick is literal, the rest of its run still opens
  assert.equal(shown(BSL + "``a` b"), "--`a`--");
});

// The old decision, kept here as the reference the block counters are compared with.
function crossesBlockBoundary(text: string, start: number, end: number): boolean {
  const inner = text.slice(start, end);
  if (/\n[ \t]*\n/.test(inner)) return true;
  const lines = inner.split("\n");
  for (let i = 1; i < lines.length; i++) {
    if (/^ {0,3}(#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t])/.test(lines[i]!)) return true;
  }
  return false;
}
// The same scan as codeSpanMask with the new rule (a crossing pair consumes nothing) but the decision
// taken by the old function for every candidate, written the plain way with no counters and no pointers.
function referenceMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  const runs: { at: number; len: number; escaped: boolean }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") { i++; continue; }
    let j = i;
    while (j < text.length && text[j] === "`") j++;
    let n = 0;
    for (let b = i - 1; b >= 0 && text[b] === BSL; b--) n++;
    runs.push({ at: i, len: j - i, escaped: n % 2 === 1 });
    i = j;
  }
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k]!;
    const len = r.escaped ? r.len - 1 : r.len;
    if (len <= 0) continue;
    let m = k + 1;
    while (m < runs.length && runs[m]!.len !== len) m++;
    if (m === runs.length) continue;
    const start = r.escaped ? r.at + 1 : r.at;
    const end = runs[m]!.at + runs[m]!.len;
    if (crossesBlockBoundary(text, start, end)) continue;
    mask.fill(1, start, end);
    k = m;
  }
  return mask;
}

// mulberry32, so a failure is reproducible from the seed in its message
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("Tek-745: the block counters decide every pair as the old function did, on 3000 generated texts", async () => {
  const codeSpanMask = await loadMask();
  const parts = ["`", "``", "```", BSL + "`", "word", " ", "  ", "\t", "\n", "\n", "\n\n", "\n   \n", "\n# h\n", "\n## ", "\n- item ", "\n* ", "\n+ x", "\n1. n ", "\n12) m ", "\n    - indented ", "\n#nohash ", "[a](b)", "x"];
  const rnd = seeded(745);
  let withSpans = 0, crossing = 0;
  for (let n = 0; n < 3000; n++) {
    const count = 1 + Math.floor(rnd() * 24);
    let text = "";
    for (let i = 0; i < count; i++) text += parts[Math.floor(rnd() * parts.length)]!;
    const got = codeSpanMask(text), want = referenceMask(text);
    assert.deepEqual(Array.from(got), Array.from(want), "text " + JSON.stringify(text) + " (seed 745, case " + n + ")");
    if (got.some((v) => v === 1)) withSpans++;
    if (/`[^`]*\n[^`]*`/.test(text)) crossing++;
  }
  // the generator has to reach both outcomes, or the comparison proves nothing
  assert.ok(withSpans > 100 && crossing > 300, withSpans + " texts with a span, " + crossing + " with a backtick pair over a line break");
});

// A fixed time limit once passed here and failed on a slower CI runner (mds/gotchas.md 2026-09-27
// (jatko 3)), so growth is compared: lengths 1..K are opened in order, a blank line follows and they are
// closed in reverse, so every one of the K pairs spans most of the document and crosses a block
// boundary. The mask with block counters grows with the input; calling the old function for each pair
// grew about three to four times faster than the input.
test("Tek-745: the mask stays linear when many nested pairs all cross a block boundary", async () => {
  const codeSpanMask = await loadMask();
  const nested = (K: number) => {
    let s = "# T\n\n> s\n\n## Docs\n\n";
    for (let L = 1; L <= K; L++) s += "`".repeat(L) + " ";
    s += "\n\n";
    for (let L = K; L >= 1; L--) s += "`".repeat(L) + " ";
    return s + "\n";
  };
  const best = (text: string) => {
    let min = Infinity;
    for (let r = 0; r < 15; r++) {
      const started = process.hrtime.bigint();
      for (let i = 0; i < 10; i++) codeSpanMask(text);
      min = Math.min(min, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return min;
  };
  const small = nested(96), large = nested(480);
  assert.ok(large.length > 200 * 1024 && large.length < 256 * 1024, "the large input is 256 KiB class: " + large.length);
  // every pair crosses, so nothing is masked and nothing is consumed
  assert.equal(codeSpanMask(large).some((v) => v === 1), false);
  best(large);
  const ratio = best(large) / best(small);
  const sizes = large.length / small.length;
  assert.ok(ratio < sizes * 1.5, sizes.toFixed(1) + "x the input took " + ratio.toFixed(1) + "x as long");
});
