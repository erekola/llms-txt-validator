// Round 3 (Tek-542), batch Fv: Codex's third-round verification found five confirmed npm-package
// findings in scope for this batch: V03-VN1, V03-VREG1, V03-VREG2, V03-VREG3/VN3 and V03-VN2
// (shortcut and collapsed references only). V10-P3-01 (package side) is the sixth. Every
// reproduction input below is the exact fixture from the verification round's reproduction notes,
// or the exact case named in its fix brief. Later cases were added to the same file: V13 D5-1
// (slashless user:password@host), Tek-745 and Tek-747 (the code span mask and the block reader
// against commonmark.js), Tek-749 (one reading of a fence) and the report-wording cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateLlmsTxt, summarizeChecks, validateHost, maskLocation } from "../src/index.js";
import type { FetchedLlmsTxt, LlmsCheck } from "../src/index.js";
import { assertLinear } from "./growth.js";

const cli = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

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
    cli,
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
    const res = spawnSync(process.execPath, [cli, input, "--json"]);
    assert.equal(res.status, 2, input);
    const out = JSON.parse(res.stdout.toString());
    assert.ok(typeof out.target === "string" && out.target.startsWith("***@"), input + " -> " + out.target);
    assert.doesNotMatch(res.stdout.toString(), /demo-secret|pw/, input);
  }
  const plain = JSON.parse(spawnSync(process.execPath, [cli, "path@2x.png", "--json"]).stdout.toString());
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
// Codex's exact generator (n reduced here for a fast unit test). The time itself is not asserted
// here: what the test pins is that the line the mapping reports is the real one, in a document with
// thousands of links and a long run of blank lines before them.
test("VREG3/VN3: in a many-link document a link entry that is not a link is named at its real line", () => {
  const n = 3000;
  const text = "# Example\n\n> Summary\n\n## Docs\n" + "\n".repeat(n * 8) + "- [a](https://a.com/)\n".repeat(n) + "- [b](https://example.com/b: notes)\n";
  const realLine = text.split("\n").findIndex((l) => l.startsWith("- [b]")) + 1;
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "warn");
  assert.equal(byId(checks, "links").detail, n + " links, all absolute URLs. 1 list line looks like a link entry but is not a Markdown link (line " + realLine + ")");
  assert.match(byId(checks, "sections").detail, /1 carrying a file list/);
});

test("VREG3/VN3: the mapped line index still matches the real position for a small document", () => {
  const text = prefix + "- [First](https://example.com/a)\n- [Second](https://example.com/b)\n- [c](https://example.com/c: notes)\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "sections").status, "pass");
  assert.match(byId(checks, "sections").detail, /1 carrying a file list/);
  assert.equal(byId(checks, "links").detail, "2 links, all absolute URLs. 1 list line looks like a link entry but is not a Markdown link (line 9)");
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

// codeSpanMask and inlineBlockReader are not exported, so the compiled module is copied next to itself, in dist/src,
// with an export list added. It has to sit there because the module reads package.json relative to its own folder.
let maskCache: ((text: string) => Uint8Array) | null = null;
let readerCache: (() => (line: string) => number) | null = null;
async function loadMask(): Promise<(text: string) => Uint8Array> {
  if (maskCache) return maskCache;
  const indexUrl = new URL("../src/index.js", import.meta.url);
  const copy = new URL("../src/index-with-mask-" + process.pid + ".mjs", import.meta.url);
  writeFileSync(copy, readFileSync(indexUrl, "utf8") + "\nexport { codeSpanMask, inlineBlockReader };\n");
  try {
    const mod = await import(copy.href);
    maskCache = mod.codeSpanMask as (text: string) => Uint8Array;
    readerCache = mod.inlineBlockReader as () => (line: string) => number;
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

// The decision for a pair taken from the lines its two runs sit on, the block of every line read up front. Which block a
// line belongs to is the reader's, and the CM_LINKS table pins that against commonmark.js. This reference checks the scan
// around it, written the plain way with no counters and no pointers.
function referenceMask(text: string, makeReader: () => (line: string) => number): Uint8Array {
  const mask = new Uint8Array(text.length);
  const blockOf = makeReader();
  const blocks = new Int32Array(text.length);
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const block = blockOf(line);
    blocks.fill(block, lineStart, lineStart + line.length + 1);
    lineStart += line.length + 1;
  }
  const runs: { at: number; len: number; escaped: boolean }[] = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`" || blocks[i]! < 0) { i++; continue; }
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
    if (blocks[start] !== blocks[end - 1]) continue;
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

test("Tek-747: the block number on each run decides every pair as a plain scan does, on 3000 generated texts", async () => {
  const codeSpanMask = await loadMask();
  const parts = ["`", "``", "```", BSL + "`", "word", " ", "  ", "\t", "\n", "\n", "\n\n", "\n   \n", "\n# h\n", "\n## ", "\n- item ", "\n* ", "\n+ x", "\n1. n ", "\n12) m ", "\n    - indented ", "\n#nohash ", "\n2. n ", "\n14) ", "\n*\n", "\n-\n", "\n***\n", "\n===\n", "\n  2. k ", "`c`", "`d `", "[a](b)", "x"];
  const rnd = seeded(745);
  let withSpans = 0, crossing = 0;
  for (let n = 0; n < 3000; n++) {
    const count = 1 + Math.floor(rnd() * 24);
    let text = "";
    for (let i = 0; i < count; i++) text += parts[Math.floor(rnd() * parts.length)]!;
    const got = codeSpanMask(text), want = referenceMask(text, readerCache!);
    assert.deepEqual(Array.from(got), Array.from(want), "text " + JSON.stringify(text) + " (seed 745, case " + n + ")");
    if (got.some((v) => v === 1)) withSpans++;
    if (/`[^`]*\n[^`]*`/.test(text)) crossing++;
  }
  // the generator has to reach both outcomes, or the comparison proves nothing
  assert.ok(withSpans > 100 && crossing > 300, withSpans + " texts with a span, " + crossing + " with a backtick pair over a line break");
});

// A fixed time limit once passed here and failed on a slower CI runner, so growth is compared
// (test/growth.ts): lengths 1..K are opened in order, a blank line follows and they are
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
  const small = nested(96), large = nested(480);
  assert.ok(large.length > 200 * 1024 && large.length < 256 * 1024, "the large input is 256 KiB class: " + large.length);
  // every pair crosses, so nothing is masked and nothing is consumed
  assert.equal(codeSpanMask(large).some((v) => v === 1), false);
  // This test passes its own limit, sizes * 2 (about 48.7 for 24.3x the characters), because its input is quadratic in K:
  // 5x the pairs is 24.3x the characters, so the shared limit sizes ** 1.5 (about 120) would also let a rescan per
  // pair, which grows as sizes ** 1.5 (measured ratio about 78), pass. The current mask measures about 15 to 18.
  await assertLinear("nested pairs", codeSpanMask, small, large, 2 * (large.length / small.length));
});

// --- Tek-747: the block reading of codeSpanMask against commonmark.js 0.31.2, the CommonMark reference implementation.
// Every count below is what that parser gave on 2026-11-04 for the document with @ replaced by one absolute link. Where
// micromark differs, on "01.", the reference implementation decides, and it compares the start number as a number.
const CM_LINKS: [string, number][] = [
  // A heading line is a block of its own, so its backtick does not pair with the next line.
  ["## a ` @\nc ` d\n", 1],
  ["## a `\n` @ `\n", 0],
  ["### a ` b\n@ `\n", 1],
  ["## a `b` @\nc\n", 1],
  ["a `\n## b` @\n", 1],
  ["a\n## b ` @\nc ` d\n", 1],
  // An empty item cannot interrupt a paragraph. A lone hyphen there is a setext underline, and an empty item inside an open list is a real item.
  ["a `@\n* \nc` d\n", 0],
  ["a `@\n+\nc` d\n", 0],
  ["a `@\n1.\nc` d\n", 0],
  ["a `@\n1. \nc` d\n", 0],
  ["a `@\n- \nc` d\n", 1],
  ["a `@\n-\nc` d\n", 1],
  ["- a `@\n*\nc` d\n", 1],
  ["* a `@\n*\n* c` d\n", 1],
  ["a\n\n*\n`@\nb` c\n", 0],
  // An ordered item that does not start at 1 cannot interrupt a paragraph, unless a line indented less than the open item closes that item.
  ["a `@\n2. c` d\n", 0],
  ["a `@\n14) c` d\n", 0],
  ["a `@\n0. c` d\n", 0],
  ["a `@\n1. c` d\n", 1],
  ["a `@\n01. c` d\n", 1],
  ["1. a `@\n2. c` d\n", 1],
  ["- a `@\n2. c` d\n", 1],
  ["- a `@\n  2. c` d\n", 0],
  ["- a\n\nb `@\n2. c` d\n", 0],
  ["1. a\n\n   b `@\n2. c` d\n", 1],
  ["1. a\nb `@\n2. c` d\n", 1],
  ["1. 2. a `@\n   3. c` d\n", 1],
  ["- a\n  - b `@\n  2. c` d\n", 1],
  ["2. a `@\n3. c` d\n", 1],
  ["-   a `@\n  2. c` d\n", 1],
  ["-\ta `@\n  2. c` d\n", 1],
  ["-      a `b\n  c` @ `\n", 0],
  // A thematic break and a setext underline end a paragraph. "=" under a lazy line does not, and with no paragraph open it is text.
  ["a `@\n***\nc` d\n", 1],
  ["a `@\n- - -\nc` d\n", 1],
  ["a `@\n===\nc` d\n", 1],
  ["a `@\n---\nc` d\n", 1],
  ["- a `@\n===\nc` d\n", 0],
  ["- a `@\n---\nc` d\n", 1],
  ["a\n\n===\n`@\nb` c\n", 0],
  // A fence the caller does not blank stays one block, and so does a run of indented code, so a backtick fence hides what it
  // holds. An item closes with its fence. An empty item ends at a blank line. Then tab stops and the five-column rule.
  ["- e:\n    ```md\n    # t\n    - @\n    ```\n", 0],
  ["- i:\n    ```sh\n    # c\n    curl @\n    ```\n", 0],
  ["- e:\t\n\t```md\n\t# t\n\t@\n\t```\n", 0],
  ["- e:\n    ```\n    a\n\n    @\n    ```\n", 0],
  ["1. e:\n    ```\n    2. a\n    @\n    ```\n", 0],
  ["- e:\n    ```\n    a\nb ` @\n\nc`\n", 1],
  ["- e:\n    ````\n    ```\n    @\n    ````\n", 0],
  ["a\n\n    ```\n    @\n    ```\n", 0],
  ["a\n\n    `b\n    @\n    c`\n", 0],
  ["*\n\n   + `\n    ##   `@`\n", 1],
  ["1.\n\n   a `@\n2. b` c\n", 0],
  ["1.    a `@\n  \t1. c` d\n", 0],
  ["-\ta `@\n    1. c` d\n", 1],
  ["-     a `b\n  c` @ `\n", 0],
  ["-    a `@\n  2. c` d\n", 1],
  ["- e:\n    ```\n    ``` x\n    ` @\n\n    `\n    ```\n", 0],
  ["- e:\n    ```\n        ```\n    ` @\n\n    `\n    ```\n", 0],
  ["    a\n# h ` @\n    b `\n", 1],
  ["*\n  a\n\n  b `@\n2. c` d\n", 1],
  // A fence line is masked whole, whatever closes the fence and whichever character it uses, and it holds no run.
  ["- e:\n    ~~~\n    # t\n    @\n    ~~~\n", 0],
  ["- e:\n    ~~~\n    @\n    ~~~\n", 0],
  ["- e:\n    ```\n    # t\n    @\n- b\n", 0],
  ["- e:\n    ```\n    @\n    ````\n", 0],
  ["- e:\n    ```\n    ```js\n    @\n    ```\n", 0],
  ["- ```md\n  # t\n  @\n  ```\n", 0],
  ["- ``` @\n  a\n  ```\n", 0],
  ["- e:\n    ```\n    `\n    ```\n  @\n    ```\n    `\n    ```\n", 1],
  ["- a\n\n  *\n\n  b `@\n2. c` d\n", 1],
  ["- e:\n    ~~~\n    ```\n    @\n    ~~~\n", 0],
  ["- e:\n    ```\n     ```\n  @\n", 1],
  // What did not change.
  ["a `@\nb` c\n", 0],
  ["a `\n\nb` @\n", 1],
  ["- `literal\n- @\n- literal`\n", 1],
  ["`one\n# two` @\n", 1],
  ["    `a\n@ b`\n", 1],
];

test("Tek-747: the link count equals the CommonMark reference on every line form of the three differences", () => {
  for (const [body, want] of CM_LINKS) {
    const text = "# T\n\n> s\n\n## Docs\n\n" + body.replaceAll("@", "[l](https://example.com/a)");
    const detail = byId(validateLlmsTxt(good(text)), "links").detail;
    const m = /^(\d+) links?/.exec(detail);
    assert.equal(m ? Number(m[1]) : 0, want, JSON.stringify(body) + " read as: " + detail);
  }
});

test("Tek-747: the mask itself on the three differences", async () => {
  const codeSpanMask = await loadMask();
  const shown = (t: string) => Array.from(codeSpanMask(t), (v, i) => (v ? t[i] : "-")).join("");
  // a heading line is a block of its own
  assert.equal(shown("## a `\nb` c"), "-----------");
  // an empty item and an ordered item that does not start at 1 continue the paragraph
  assert.equal(shown("a `b\n*\nc` d"), "--`b\n*\nc`--");
  assert.equal(shown("a `b\n2. c` d"), "--`b\n2. c`--");
  // a lone hyphen is a setext underline, so the paragraph ends there
  assert.equal(shown("a `b\n-\nc` d"), "-----------");
  // the next item of an open list is a new block, and a marker indented into the open item is not
  assert.equal(shown("1. a `b\n2. c` d"), "---------------");
  assert.equal(shown("- a `b\n  2. c` d"), "----`b\n  2. c`--");
});

test("Tek-747: the block reader stays linear on nested markers and a deep item stack", async () => {
  const codeSpanMask = await loadMask();
  const fill = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  const shapes: [string, (n: number) => string][] = [
    ["one line of nested bullets", (n) => fill("- ", n) + "x\n"],
    ["one line of nested ordered items", (n) => fill("1. ", n) + "x\n"],
    ["a deep item stack and indented lines", (n) => { let s = fill("- ", n / 2) + "x\n"; while (s.length < n) s += " ".repeat(200) + "y `\n"; return s; }],
    ["marker-shaped lines in one paragraph", (n) => "x\n" + fill("14) a ` b\n", n)],
  ];
  for (const [name, make] of shapes) {
    await assertLinear(name, codeSpanMask, make(16 * 1024), make(128 * 1024));
  }
});

test("Tek-747: the report's sentences are separated by a period, checked as the exact wording of each row", () => {
  const report = (f: Parameters<typeof validateLlmsTxt>[0], id: string): string => byId(validateLlmsTxt(f), id).detail;
  const head = "# T\n\n> s\n\n## Docs\n\n";
  const link = "- [a](https://example.com/a)\n";
  const rows: [string, string, string][] = [
    ["h1-title", "#\n\n> s\n\n## Docs\n\n" + link, "the H1 has no text. The format requires the project name there"],
    ["sections", "# T\n\n> s\n\n[a](https://example.com/a)\n", "no H2 sections found. Sections are the convention for grouping links"],
    ["sections", head + "[a](https://example.com/a)\n", "1 section but no file list under any of them. The format puts a section's links in a markdown list"],
    ["sections", "# T\n\n### Early\n\n> s\n\n## Docs\n\n" + link, "1 section, 1 carrying a file list. The heading at line 3 is out of place, because the format has one H1 and no other heading before the first H2"],
    ["links", head + "- [](https://example.com/a)\n", "1 link, 1 with an empty link name. An entry needs a name an agent can show"],
    ["links", head + link + "- [b](/rel)\n", "2 links, 1 relative. Absolute URLs travel better when the file is read out of context"],
    ["links", head + link + "- [b](https://example.com/b: notes)\n", "1 link, all absolute URLs. 1 list line looks like a link entry but is not a Markdown link (line 8)"],
    ["links", head + link + "\u2013 [b](https://example.com/b)\n", "2 links, all absolute URLs. 1 list line opens with a dash or bullet that is not a Markdown list marker (line 8)"],
    ["no-html", head + link + "\n<div>x</div>\n", "HTML tags found. llms.txt should be plain markdown"],
  ];
  for (const [id, text, want] of rows) assert.equal(report(good(text), id), want);
  assert.equal(report(good(head + link, { bytes: 200000 }), "size"), "200000 bytes. Consider moving detail to llms-full.txt");
  assert.equal(report({ redirect: true, reason: "off-host", status: 301, location: "https://other.example/llms.txt" }, "http-status"), "redirects to https://other.example/llms.txt, a different host. llms.txt is host-scoped, so validate that host directly");
  assert.equal(report({ redirect: true, reason: "unsafe-target", status: 301, location: "http://example.com/llms.txt" }, "http-status"), "redirects to an unsupported target (http://example.com/llms.txt). Only https redirects to the same site are followed");
  assert.equal(report({ redirect: true, reason: "too-many", status: 301, location: "" }, "http-status"), "too many redirects. The llms.txt is not served at a stable URL");
});

// --- Tek-749: one reading of a fence. fenceMask takes its fences from inlineBlockReader. Each row is a body under one H2, with the link
// count and the number of sections carrying a file list that commonmark.js 0.31.2 gave on 2026-11-04, @ being one absolute link.
// Before this, a closing line at 0 to 3 columns of a fence fenceMask had not seen opened a new fence and hid the rest of the file.
const FENCE_ROWS: [string, number, number][] = [
  ["- ```\n  a\n  ```\n- @\n", 1, 1],
  ["- a\n    ```\n    b\n  ```\n- @\n", 1, 1],
  ["- a\n\t```\n\tb\n  ```\n- @\n", 1, 1],
  ["- a\n  ```\n  b\n- @\n", 1, 1],
  ["1. a\n   ```\n   b\n2. @\n", 1, 1],
  ["- a\n  ```\n  ## x\n  ```\n- @\n", 1, 1],
  ["- a\n    ```\n    ## x\n    - @\n    ```\n", 0, 0],
  ["- ```\n  ## x\n  @\n  ```\n", 0, 0],
  ["- a\n    ```\n    b\n\n@\n", 1, 0],
  ["- a\n    ~~~\n    b\n  ~~~\n- @\n", 1, 1],
  ["- a\n    ```\n    b\n```\n- @\n", 0, 0],
  ["- a\n  - b\n      ```\n      c\n    ```\n- @\n", 1, 1],
  ["- a\n\n      ```\n      b\n- @\n", 1, 1],
  ["```\na\n```\n- @\n", 1, 1],
  ["  ```\n  a\n  ```\n- @\n", 1, 1],
  ["- @\n```\n- not\n", 1, 1],
  ["- a\n  - b\n    ```\n    x\n    ```\n  @\n", 1, 1],
  ["- a\n  - b\n\n  @\n", 1, 1],
  ["- a\n\n  *\n\n  @\n", 1, 1],
  ["- a\n  ```\n  b\n  ```\n@\n", 1, 0],
  ["- a\n  - b\n\n@\n", 1, 0],
  ["1. a\n   - b\n     ```\n     c\n     ```\n   @\n", 1, 1],
  ["- a\n  - b\n\n    c\n\n  - @\n", 1, 1],
  ["- a\n  - b\n    ```\n    c\n    ```\n- d\n\n  @\n", 1, 1],
  ["-   x\n```\n```\n    ```\n  @\n    ```\n", 1, 0],
  ["-\n    ```\n    ```\n\n  @\n", 1, 1],
  ["- a\n    ```js `x`\n    @\n", 1, 1],
  ["- a\n```\n```\n  `@\n2. b`\n", 0, 0],
  ["-   a\n- b\n\n  @\n", 1, 1],
  ["- a\n\nb\n\n  - c\n\n  @\n", 1, 0],
  ["*\n\n  @\n", 1, 0],
  ["- a\n    ```\n    b\n ```\n- @\n", 0, 0],
  ["  7. a\n\t + n\n     ~~~~\n     ~~~~\n         ```sh\n        @\n", 1, 1],
];

test("Tek-749: the links and sections checks read a fence and a nested item the way the reference does", () => {
  for (const [body, links, lists] of FENCE_ROWS) {
    const checks = validateLlmsTxt(good("# T\n\n> s\n\n## Docs\n\n" + body.replace("@", "[l](https://example.com/a)")));
    const l = /^(\d+) links?/.exec(byId(checks, "links").detail);
    assert.equal(l ? Number(l[1]) : 0, links, "links of " + JSON.stringify(body));
    const s = /^1 section, (\d+) carrying/.exec(byId(checks, "sections").detail);
    assert.equal(s ? Number(s[1]) : 0, lists, "sections of " + JSON.stringify(body));
  }
  const html = validateLlmsTxt(good("# T\n\n> s\n\n## Docs\n\n- a\n    ```sh\n    echo '<endpoint-id>'\n    # c\n    ```\n- [l](https://example.com/a)\n"));
  assert.equal(byId(html, "no-html").status, "pass", "angle brackets inside a fence in a list item are not markup");
  assert.equal(byId(html, "links").detail, "1 link, all absolute URLs");
  // One read of the raw lines: a second read of the blanked text would not pair these backticks, and the tag would read as markup.
  assert.equal(byId(validateLlmsTxt(good("# T\n\n> s\n\n## Docs\n\n- [k](https://example.com/k)\n\n```\n```\n  `<div>\n2. b`\n")), "no-html").status, "pass");
});
