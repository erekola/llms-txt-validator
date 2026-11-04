import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt, summarizeChecks } from "../src/index.js";

// Regression tests for 0.5.0 (Tek-730, 2026-10-31). The hosted validator carries the same cases in
// test/validator-tek730.test.ts in the turva-worker repo, together with the check that turva.dev's
// own served llms.txt gets no new warning; that check needs the Worker, so it is not repeated here.
// Two changes: the HTML check no longer reads code, and the links check warns on a list line that
// looks like a link entry but is not one.

const BS = String.fromCharCode(92);
const EN = String.fromCharCode(0x2013);
const EM = String.fromCharCode(0x2014);
const BULLET = String.fromCharCode(0x2022);
const base = "# Example\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
const good = (text: string) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false });
const run = (text: string) => validateLlmsTxt(good(text));
const status = (text: string, id: string) => run(text).find((c) => c.id === id)!.status;
const detail = (text: string, id: string) => run(text).find((c) => c.id === id)!.detail;
const add = (t: string) => base + "\n" + t + "\n";

test("A: angle brackets inside code no longer warn in the HTML check", () => {
  const pass = [
    "Fetch `https://fal.ai/models/<endpoint-id>/llms.txt` for the model.",
    "- `submit_<form>_form` submits the form",
    "Write " + BS + "<node-name" + BS + "> for the node.",
    "Write " + BS + "<div>x" + BS + "</div> in prose.",
    "``a ` <div>x</div> b``",
    "```html\n<div class=\"x\">hi</div>\n<!-- note -->\n```",
    "~~~\n</div>\n~~~",
    "<https://example.com> and <mailto:a@example.com>",
  ];
  for (const t of pass) assert.equal(status(add(t), "no-html"), "pass", t);
});

test("A: a real tag, a closing tag or a comment in prose still warns", () => {
  const warn = [
    "<div>hi</div>",
    "</div>",
    "<!-- note -->",
    "<br/>",
    "text `code` and <b>bold</b>",
    "a ` <div>x</div>",
    BS + BS + "<div>x</div>",
    "`one`\n\n<div>x</div>\n\n`two`",
    "`a\n\n<div>x</div>\n\nb`",
    "```\ncode\n```\n<div>x</div>",
    "<p\nid=a>",
  ];
  for (const t of warn) assert.equal(status(add(t), "no-html"), "warn", t);
});

test("A: an unclosed fence still hides its content, as the other checks read it", () => {
  assert.equal(status(add("```\n<div>x</div>"), "no-html"), "pass");
});

test("A: the blanking stays linear on a document of unmatched backticks and brackets", () => {
  const time = (s: string) => { const t = performance.now(); status(add(s), "no-html"); return performance.now() - t; };
  time("`".repeat(50) + " <b ");
  const small = time(("` <b " + BS + "<").repeat(2000));
  const large = time(("` <b " + BS + "<").repeat(16000));
  assert.ok(large < Math.max(small * 40, 1500), "8x the input took " + large + " ms against " + small + " ms");
});

test("B: a link entry with an unclosed destination warns in the links check", () => {
  const nbdev = base + "- [Blogging](https://nbdev.fast.ai/tutorials/blogging.html.md: Creating a blog with notebooks)\n";
  assert.equal(status(nbdev, "links"), "warn");
  assert.equal(detail(nbdev, "links"), "1 link, all absolute URLs. 1 list line looks like a link entry but is not a Markdown link (line 8)");
  assert.equal(run(nbdev).length, run(base).length);
});

test("B: an entry that starts with an en dash, an em dash or a bullet warns", () => {
  for (const mark of [EN, EM, BULLET]) {
    const t = base + mark + " [Saleor is composable](https://saleor.io/docs/composable)\n";
    assert.equal(status(t, "links"), "warn", mark);
    assert.match(detail(t, "links"), /1 list line opens with a dash or bullet that is not a Markdown list marker \(line 8\)$/, mark);
  }
  const two = base + EN + " [A](https://example.com/a)\n" + EN + " [B](https://example.com/b)\n";
  assert.equal(detail(two, "links"), "3 links, all absolute URLs. 2 list lines open with a dash or bullet that is not a Markdown list marker (lines 8, 9)");
});

test("B: the detail names the first five lines and counts the rest", () => {
  const many = base + Array.from({ length: 7 }, (_, i) => EN + " [E" + i + "](https://example.com/" + i + ")\n").join("");
  assert.match(detail(many, "links"), /7 list lines open with a dash or bullet that is not a Markdown list marker \(lines 8, 9, 10, 11, 12 and 2 more\)$/);
});

test("B: a valid entry, a numbered entry and a task box do not warn", () => {
  const ok = [
    "- [Name](https://example.com/n): notes after the link",
    "- [Name](https://example.com/n)",
    "* [Name](https://example.com/n \"title\")",
    "1. [Name](https://example.com/n)",
    "  - [Nested](https://example.com/n): indented",
    "- [x] a done task",
    "- [ ] an open task",
  ];
  for (const t of ok) {
    const text = base + t + "\n";
    assert.equal(status(text, "links"), "pass", t);
    assert.equal(summarizeChecks(run(text)), "valid", t);
  }
});

test("B: only lines under an H2 and outside fences are read", () => {
  const intro = "# Example\n\n> Summary.\n\n- " + "[Orphan](https://example.com/o: x)\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
  assert.equal(status(intro, "links"), "pass");
  const fenced = base + "\n```\n- [Blogging](https://example.com/b.md: notes)\n" + EN + " [X](https://example.com/x)\n```\n";
  assert.equal(status(fenced, "links"), "pass");
  const numbered = base + "1. [Bad](https://example.com/b: notes)\n";
  assert.equal(status(numbered, "links"), "warn");
});

test("B: an unclosed entry in a file with no other link is one warning, not a second check", () => {
  const lone = "# Example\n\n> Summary.\n\n## Docs\n\n- [Blogging](https://nbdev.fast.ai/b.md: notes)\n";
  assert.equal(detail(lone, "links"), "no markdown links found. 1 list line looks like a link entry but is not a Markdown link (line 7)");
});

// Tek-745 K10a (0.5.1): the note has two kinds. A look-alike marker is no list item whether or not its
// link parses, and when the link parses it is counted as a link, so "will not follow it" was wrong for it.
test("K10a: a look-alike marker with a link that parses is counted and named as a marker, not as a broken link", () => {
  const one = "# Example\n\n> Summary.\n\n## Docs\n\n" + EN + " [B](https://example.com/b)\n";
  assert.equal(status(one, "links"), "warn");
  assert.equal(detail(one, "links"), "1 link, all absolute URLs. 1 list line opens with a dash or bullet that is not a Markdown list marker (line 7)");
});

test("K10a: a file with both kinds gives both notes, the broken link first", () => {
  const both = base + "- [Bad](https://example.com/b: notes)\n" + EM + " [X](https://example.com/x)\n" + BULLET + " [Y](https://example.com/y)\n";
  assert.equal(status(both, "links"), "warn");
  assert.equal(detail(both, "links"),
    "3 links, all absolute URLs. 1 list line looks like a link entry but is not a Markdown link (line 8). 2 list lines open with a dash or bullet that is not a Markdown list marker (lines 9, 10)");
  const none = detail(base + "- [Bad](https://example.com/b: notes)\n" + EN + " [X](https://example.com/x)\n", "links");
  assert.doesNotMatch(none, /agent will not follow/);
});
