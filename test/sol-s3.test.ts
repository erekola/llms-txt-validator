import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt } from "../src/index.js";

// Markdown parsing round S3 (outside audit 2026-11-05, decision P1, Tek-546). The hosted validator
// carries the same inputs and expectations in test/validator-sol-s3.test.ts in the turva-worker
// repo. Each test name starts with the audit item it covers.

type Check = { id: string; status: string; label: string; detail: string };

async function getChecks(text: string): Promise<Check[]> {
  return validateLlmsTxt({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false });
}

// ---- shared body: identical in the hosted test and in the package test ----
const NBSP = String.fromCodePoint(0xa0);
const IDEO = String.fromCodePoint(0x3000);
const SHARP = String.fromCodePoint(0x1e9e);
const H = "# Project\n> Summary\n\n## Docs\n";
const G = "- [Guide](https://example.com/a)\n";
const NOLINKS = "no markdown links found";

type Res = { h1: string; sum: string; sec: string; lnk: string; html: string; lnkDetail: string; secDetail: string; sumDetail: string };
async function res(text: string): Promise<Res> {
  const checks = await getChecks(text);
  const get = (id: string) => checks.find((c) => c.id === id)!;
  return {
    h1: get("h1-title").status,
    sum: get("summary").status,
    sec: get("sections").status,
    lnk: get("links").status,
    html: get("no-html").status,
    lnkDetail: get("links").detail,
    secDetail: get("sections").detail,
    sumDetail: get("summary").detail,
  };
}
type Want = Partial<Pick<Res, "h1" | "sum" | "sec" | "lnk" | "html">> & { lnkRe?: RegExp; lnkNot?: RegExp; secRe?: RegExp; sumRe?: RegExp };
async function expectAll(rows: [string, Want][]) {
  for (const [text, want] of rows) {
    const r = await res(text);
    const label = JSON.stringify(text);
    if (want.h1) assert.equal(r.h1, want.h1, "h1-title " + label);
    if (want.sum) assert.equal(r.sum, want.sum, "summary " + label);
    if (want.sec) assert.equal(r.sec, want.sec, "sections " + label + " " + r.secDetail);
    if (want.lnk) assert.equal(r.lnk, want.lnk, "links " + label + " " + r.lnkDetail);
    if (want.html) assert.equal(r.html, want.html, "no-html " + label);
    if (want.lnkRe) assert.match(r.lnkDetail, want.lnkRe, "links detail " + label);
    if (want.lnkNot) assert.doesNotMatch(r.lnkDetail, want.lnkNot, "links detail " + label);
    if (want.secRe) assert.match(r.secDetail, want.secRe, "sections detail " + label);
    if (want.sumRe) assert.match(r.sumDetail, want.sumRe, "summary detail " + label);
  }
}
const noLinks: Want = { lnk: "warn", lnkRe: /^no markdown links found/ };
const one: Want = { lnk: "pass", lnkRe: /^1 link, all absolute URLs$/, lnkNot: /not a Markdown link/ };

test("WL-11/LV-03: indented code inside a list item is not a file list", async () => {
  await expectAll([
    [H + "- Example\n\n      [Guide](https://example.com/guide)\n", { sec: "warn", lnk: "pass" }],
    [H + "-     [Guide](https://example.com/a)\n", { sec: "warn", lnk: "pass" }],
    [H + "1.      [Guide](https://example.com/a)\n", { sec: "warn", lnk: "pass" }],
    [H + "- item\n\n      [Guide](https://example.com/a)\n", { sec: "warn", lnk: "pass" }],
  ]);
});
test("WL-11/LV-03 control: a continuation paragraph, a lazy line and a loose code block stay as they were", async () => {
  await expectAll([
    [H + "- Example\n\n  [Guide](https://example.com/guide)\n", { sec: "pass", lnk: "pass" }],
    [H + "- item\n\n    [Guide](https://example.com/a)\n", { sec: "pass", lnk: "pass" }],
    [H + "- Example\n      text [Guide](https://example.com/a)\n", { sec: "pass", lnk: "pass" }],
    [H + "- a\n  - b\n\n      [Guide](https://example.com/a)\n", { sec: "pass", lnk: "pass" }],
    [H + "\n      [Guide](https://example.com/guide)\n", { sec: "warn", lnk: "pass" }],
  ]);
});

test("WL-12/LV-09: unbalanced parentheses in a destination are no link", async () => {
  await expectAll([
    [H + "- [Guide](https://example.com/a(b)\n", { ...noLinks, sec: "warn" }],
    [H + "- [Guide][g]\n\n[g]: https://example.com/a(b\n", { ...noLinks, sec: "warn" }],
    [H + "- [Guide][g]\n\n[g]: https://example.com/a(\n", { ...noLinks, sec: "warn" }],
    [H + "- [Guide][g]\n\n[g]: https://example.com/a)\n", { ...noLinks, sec: "warn" }],
  ]);
});
test("WL-12/LV-09 control: balanced, escaped and angle-bracket destinations stay links", async () => {
  await expectAll([
    [H + "- [Guide](https://example.com/a(b))\n", { ...one, sec: "pass" }],
    [H + "- [Guide](https://en.wikipedia.org/wiki/Foo_(bar))\n", { ...one, sec: "pass" }],
    [H + "- [Guide](<https://example.com/a(b>)\n", { ...one, sec: "pass" }],
    [H + "- [Guide](https://example.com/a(b(c)d))\n", { ...one, sec: "pass" }],
    [H + "- [Guide](https://example.com/a" + String.fromCharCode(92) + "(b)\n", { ...one, sec: "pass" }],
    [H + "- [Guide][g]\n\n[g]: https://example.com/a(b)\n", { ...one, sec: "pass" }],
  ]);
});

test("LV-01: a thematic break, a definition or an HTML line over === is no setext title", async () => {
  await expectAll([
    ["---\n===\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
    ["[a]: https://example.com\n===\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
    ["<div>\n===\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
  ]);
});
test("LV-01 control: a text line over === is still the title", async () => {
  await expectAll([
    ["Project\n===\n> Summary\n\n## Docs\n" + G, { h1: "pass" }],
    ["My [site] notes\n===\n> Summary\n\n## Docs\n" + G, { h1: "pass" }],
    ["Project\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
  ]);
});

test("LV-04 regression: fenced code inside list containers is no link", async () => {
  await expectAll([
    [H + "- ```\n  [Guide](https://example.com/a)\n  ```\n", noLinks],
    [H + "-   item\n    ~~~\n    [Guide](https://example.com/a)\n    ~~~\n", noLinks],
    [H + G + "  - nested\n    ~~~\n    [X](rel)\n    ~~~\n", one],
  ]);
});
test("LV-12 regression: a rejected code span closer can open the next span", async () => {
  await expectAll([
    [H + G + "\n`unclosed\n\n`[Literal](relative)`\n", one],
    [H + G + "\n`a\n\n`b` tail [Real](relative) `c`\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
  ]);
});

test("LV-05/U-7: a bracket inside a code span neither closes nor breaks a link", async () => {
  await expectAll([
    [H + "- [not a `link](https://example.com/a`)\n", { ...noLinks, sec: "warn" }],
    [H + "- [`Array[T]` reference](https://example.org/a)\n", { ...one, sec: "pass" }],
    [H + "- [`a]` reference](https://example.org/a)\n", { ...one, sec: "pass" }],
    [H + "- [x `a](https://example.com/b` y](https://example.com/c)\n", { ...one, sec: "pass" }],
    [H + G + "\n`example\n2. [Example](relative)\nend`\n", one],
  ]);
});
test("LV-05/U-7 control: ordinary links and a link after a code span are unchanged", async () => {
  await expectAll([
    [H + "- [not a link](https://example.com/a)\n", { ...one, sec: "pass" }],
    [H + "- [`Array` reference](https://example.org/a)\n", { ...one, sec: "pass" }],
    [H + "- `[a](b)` and [c](https://example.com/c)\n", { ...one, sec: "pass" }],
    [H + "- [a](https://example.com/b) and `x`\n", { ...one, sec: "pass" }],
  ]);
});

test("LV-06: a link label does not cross a heading, a list item or a quote", async () => {
  await expectAll([
    [H + "- [B\n## fake\n](https://example.com/b)\n", { ...noLinks, sec: "warn" }],
    [H + "- [B\n- item\n](https://example.com/b)\n", noLinks],
    [H + "- [B\n> q\n](https://example.com/b)\n", noLinks],
    [H + "- [B\n---\n](https://example.com/b)\n", noLinks],
    [H + "- [B\n```\n](https://example.com/b)\n", noLinks],
    [H + G + "- [B\n## fake\n](https://example.com/b)\n- [C](https://example.com/c)\n", { lnk: "warn", lnkRe: /^2 links, all absolute URLs\. 1 list line looks like a link entry/ }],
  ]);
});
test("LV-06 control: a soft break and a non-interrupting line stay inside the label", async () => {
  await expectAll([
    [H + "- [B\ncontinued](https://example.com/b)\n", { ...one, sec: "pass" }],
    [H + "[B\n2. x\n](https://example.com/b)\n", one],
    [H + "[B\n-x\n](https://example.com/b)\n", one],
  ]);
});

test("LV-07: an empty destination is a relative link, also in a paragraph", async () => {
  await expectAll([
    [H + G + "- [Bad]()\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/, lnkNot: /not a Markdown link/ }],
    [H + G + "- [Bad](<>)\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/, lnkNot: /not a Markdown link/ }],
    [H + G + "\nSee [Bad]() for more.\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
    [H + G + "\nSee [Bad](<>) for more.\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
    [H + "- [Bad]()\n", { lnk: "warn", lnkRe: /^1 links, 1 relative/, lnkNot: /not a Markdown link/ }],
  ]);
});
test("LV-07 control: a fragment link is relative as before", async () => {
  await expectAll([
    [H + G + "- [Bad](#x)\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
  ]);
});

test("LV-08: a link inside image description text is no link", async () => {
  await expectAll([
    [H + "- ![alt [Guide](https://example.com/a)](https://example.com/img.png)\n", { ...noLinks, sec: "warn" }],
    [H + "- ![see [Guide]](https://example.com/img.png)\n", noLinks],
    [H + "- ![a][r]\n\n[r]: https://example.com/img.png\n", noLinks],
  ]);
});
test("LV-08 control: an image inside a link and an image without a target read as before", async () => {
  await expectAll([
    [H + "- [a ![i](https://example.com/i.png)](https://example.com/a)\n", { ...one, sec: "pass" }],
    [H + "- ![alt text](https://example.com/img.png)\n", noLinks],
    [H + "- ![alt [Guide](https://example.com/a)]\n", one],
  ]);
});

test("LV-10: a definition is read where CommonMark reads one", async () => {
  await expectAll([
    [H + "- [Guide][g]\n\n> [g]: https://example.com/a\n", one],
    [H + "- [Guide][g]\n\n---\n[g]: https://example.com/a\n", one],
    [H + "- [Guide][g]\n\n>\n[g]: https://example.com/a\n", one],
    [H + "- [Guide][g]\n- [g]: https://example.com/a\n", one],
    [H + "- [Guide][g]\n\n> [x]: https://example.com/x\n> [g]: https://example.com/a\n", one],
  ]);
});
test("LV-10: a line that continues a paragraph or a list item is no definition", async () => {
  await expectAll([
    [H + "- [Guide][g]\n\nparagraph\n[x]: bad bare\n[g]: https://example.com/a\n", noLinks],
    [H + "- [Guide][g]\n- item\n  [g]: https://example.com/a\n", noLinks],
    [H + "- [A][a]\n- [B][b]\n[a]: https://example.com/a\n[b]: https://example.com/b\n", noLinks],
  ]);
});
test("LV-10 control: a definition after a paragraph, after a blank line and in a run of definitions", async () => {
  await expectAll([
    [H + "- [Guide][g]\n\nparagraph\n[g]: https://example.com/a\n", noLinks],
    [H + "- [Guide][g]\n\n[g]: https://example.com/a\n", one],
    [H + "- [A][a]\n- [B][b]\n\n[a]: https://example.com/a\n[b]: https://example.com/b\n", { lnk: "pass", lnkRe: /^2 links, all absolute URLs$/ }],
    [H + "- [Guide][g]\n\n## Heading\n[g]: https://example.com/a\n", one],
  ]);
});

test("LV-11: a shortcut reference is found after punctuation and after a failed inline attempt", async () => {
  await expectAll([
    [H + "- Documentation: [Guide]: overview\n\n[Guide]: https://example.com/a\n", one],
    [H + "- [Guide](not a link)\n\n[Guide]: https://example.com/a\n", one],
  ]);
});
test("LV-11 control: a definition line does not resolve against itself", async () => {
  await expectAll([
    [H + "- [Guide]\n\n[Guide]: https://example.com/a\n", one],
    [H + "[Guide]: https://example.com/a\n", noLinks],
  ]);
});

test("LV-13: a quote ends a paragraph for code span pairing", async () => {
  await expectAll([
    [H + G + "\n`before\n> [Bad](relative) after`\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
    [H + G + "\nparagraph `before\n> [Bad](relative) after`\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
  ]);
});
test("LV-13 control: inside one quote a span still pairs, and the 1. and newline boundaries are unchanged", async () => {
  await expectAll([
    [H + G + "\n> `a\n> [Bad](relative) b`\n", one],
    [H + G + "\n`example\n1. [Example](relative)\nend`\n", { lnk: "warn", lnkRe: /^2 links, 1 relative/ }],
    [H + G + "\n`example\nplain [Example](relative)\nend`\n", one],
  ]);
});

test("LV-15: markup that renders no text passes no title, name or summary check", async () => {
  await expectAll([
    ["# &#32;\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
    [H + "- [&#32;](https://example.com/a)\n", { lnk: "warn", lnkRe: /empty link name/ }],
    [H + "- [` `](https://example.com/a)\n", { lnk: "warn", lnkRe: /empty link name/ }],
    ["# Project\n>>\n\n## Docs\n" + G, { sum: "warn" }],
    ["# Project\n> >\n\n## Docs\n" + G, { sum: "warn" }],
    ["# Project\n> &#32;\n\n## Docs\n" + G, { sum: "warn" }],
  ]);
});
test("LV-15 control: visible text through a reference, a code span or a nested quote still counts", async () => {
  await expectAll([
    ["# &amp; Project\n> Summary\n\n## Docs\n" + G, { h1: "pass" }],
    [H + "- [`code` name](https://example.com/a)\n", { ...one, sec: "pass" }],
    ["# Project\n> > text\n\n## Docs\n" + G, { sum: "pass" }],
    ["# Project\n>\n\n## Docs\n" + G, { sum: "warn" }],
    [H + "- [](https://example.com/a)\n", { lnk: "warn", lnkRe: /empty link name/ }],
  ]);
});

test("LV-16: Unicode white space is no Markdown blank line", async () => {
  await expectAll([
    [NBSP + "\n# Project\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
    [IDEO + "\n# Project\n> Summary\n\n## Docs\n" + G, { h1: "fail" }],
    ["# Project\n" + NBSP + "\n> Summary\n\n## Docs\n" + G, { sum: "warn", sumRe: /comes after other text/ }],
    [H + "- [Guide](https://example.com/a" + NBSP + "b)\n", { ...one, sec: "pass" }],
    [H + "- [Guide](https://example.com/a" + IDEO + "b)\n", { ...one, sec: "pass" }],
    [H + "- [Guide][a" + NBSP + "b]\n\n[a b]: https://example.com/a\n", noLinks],
    [H + "- [Guide][a  b]\n\n[a b]: https://example.com/a\n", one],
  ]);
});
test("LV-16 control: an ASCII control character ends a destination", async () => {
  await expectAll([
    [H + "- [Guide](https://example.com/a" + String.fromCharCode(12) + "b)\n", noLinks],
    [H + "- [Guide](https://example.com/a" + String.fromCharCode(11) + "b)\n", noLinks],
  ]);
});
test("LV-16 control: spaces, tabs and CRLF are blank lines", async () => {
  await expectAll([
    ["   \n# Project\n> Summary\n\n## Docs\n" + G, { h1: "pass", sum: "pass" }],
    ["\t\n# Project\n> Summary\n\n## Docs\n" + G, { h1: "pass", sum: "pass" }],
    ["# Project\r\n> Summary\r\n\r\n## Docs\r\n" + G.replace(/\n/g, "\r\n"), { h1: "pass", sum: "pass", sec: "pass", lnk: "pass" }],
  ]);
});

test("LV-17: link labels match by Unicode case folding", async () => {
  await expectAll([
    [H + "- [Guide][" + SHARP + "]\n\n[SS]: https://example.com/a\n", one],
    [H + "- [Guide][ss]\n\n[" + SHARP + "]: https://example.com/a\n", one],
  ]);
});
test("LV-17 control: ASCII case and different labels", async () => {
  await expectAll([
    [H + "- [Guide][GUIDE]\n\n[guide]: https://example.com/a\n", one],
    [H + "- [Guide][a]\n\n[b]: https://example.com/a\n", noLinks],
  ]);
});

test("LV-18: a destination is not decoded like an HTML attribute", async () => {
  const rel = { lnk: "warn", lnkRe: /^1 links, 1 relative/ };
  await expectAll([
    [H + "- [Guide](https&#58//example.com/a)\n", rel],
    [H + "- [Guide](https&#x3a//example.com/a)\n", rel],
    [H + "- [Guide](https&#00000058;//example.com/a)\n", rel],
    [H + "- [Guide](https&#x000003a;//example.com/a)\n", rel],
    [H + "- [Guide][g]\n\n[g]: https&#58//example.com/a\n", rel],
  ]);
});
test("LV-18 control: complete character references still decode", async () => {
  await expectAll([
    [H + "- [Guide](https&#58;//example.com/a)\n", one],
    [H + "- [Guide](https&#x3a;//example.com/a)\n", one],
    [H + "- [Guide](https&colon;//example.com/a)\n", one],
    [H + "- [Guide](https://example.com/a?x=1&amp;y=2)\n", one],
  ]);
});

test("LV-19: lines inside a raw HTML block supply no Markdown structure", async () => {
  await expectAll([
    [H + "<div>\n- [Guide](https://example.com/a)\n</div>\n", { ...noLinks, sec: "warn", html: "warn" }],
    [H + "<!--\n- [Guide](https://example.com/a)\n-->\n", { ...noLinks, sec: "warn", html: "warn" }],
    [H + "<pre>\n[Guide](https://example.com/a)\n</pre>\n", { ...noLinks, html: "warn" }],
  ]);
});
test("LV-19 control: a blank line ends the block, and a type 7 tag inside a paragraph is no block", async () => {
  await expectAll([
    [H + "<div>\n\n- [Guide](https://example.com/a)\n\n</div>\n", { ...one, sec: "pass", html: "warn" }],
    [H + "Intro\n<span>\n- [Guide](https://example.com/a)\n", { ...one, sec: "pass", html: "warn" }],
    [H + "Intro <span>x</span> text\n- [Guide](https://example.com/a)\n", { ...one, sec: "pass", html: "warn" }],
  ]);
});
