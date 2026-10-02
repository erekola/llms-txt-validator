import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt, summarizeChecks, findLinkRelations, maskLocation } from "../src/index.mjs";

// Regression tests for 0.3.16 (Tek-560, outside review 2026-10-02, items V01 to V04, V06, V07, V08
// and V10). The hosted validator carries the same cases in test/validator-tek560.test.mjs in the
// turva-worker repo. Each case below gave the opposite result in 0.3.15, except the guards that
// say what still holds.

const BS = String.fromCharCode(92);
const base = "# Example\n\n> Summary.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
const good = (text) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false });
const run = (text) => validateLlmsTxt(good(text));
const status = (text, id) => run(text).find((c) => c.id === id).status;
const detail = (text, id) => run(text).find((c) => c.id === id).detail;

test("V01: a link label cannot cross a blank line", () => {
  const split = base.replace("[Guide](", "[Gu\n\nide](");
  assert.equal(status(split, "links"), "warn");
  assert.equal(status(split, "sections"), "warn");
  // One line break inside a label is still a link.
  const wrapped = base.replace("[Guide](", "[Gu\nide](");
  assert.equal(summarizeChecks(run(wrapped)), "valid");
  // A line of spaces counts as blank.
  assert.equal(status(base.replace("[Guide](", "[Gu\n  \t\nide]("), "links"), "warn");
});

test("V02: a backslash escape in the destination is unescaped before the absolute URL test", () => {
  const esc = base.replace("https://example.com/guide", "https" + BS + "://example.com/guide");
  assert.equal(status(esc, "links"), "pass");
  assert.equal(summarizeChecks(run(esc)), "valid");
  // A backslash before a letter is not an escape and stays in the destination.
  const plain = base.replace("https://example.com/guide", "https://example.com/gu" + BS + "ide");
  assert.equal(status(plain, "links"), "pass");
  // A relative destination is still relative.
  assert.equal(status(base.replace("https://example.com/guide", BS + "/guide"), "links"), "warn");
});

test("V03: CR-only and CRLF line endings read like LF", () => {
  assert.equal(summarizeChecks(run(base.replace(/\n/g, "\r"))), "valid");
  assert.equal(summarizeChecks(run(base.replace(/\n/g, "\r\n"))), "valid");
  const cr = run(base.replace(/\n/g, "\r"));
  assert.match(cr.find((c) => c.id === "h1-title").detail, /Example/);
  assert.doesNotMatch(cr.find((c) => c.id === "h1-title").detail, /Summary/);
});

test("V04A: a setext H1 is an H1, and the summary is read after its underline", () => {
  for (const t of ["Example\n=", "Example\n=======", "  Example\n===  "]) {
    const text = base.replace("# Example", t);
    assert.equal(status(text, "h1-title"), "pass", t);
    assert.equal(status(text, "summary"), "pass", t);
    assert.equal(summarizeChecks(run(text)), "valid", t);
  }
  // A setext H2 (dashes) is not an H1, and neither is a list item or a heading over an underline.
  for (const t of ["Example\n---", "- Example\n=", "> Example\n=", "## Example\n="]) {
    assert.equal(status(base.replace("# Example", t), "h1-title"), "fail", t);
  }
  // An underline after a blank line is not an underline.
  assert.equal(status(base.replace("# Example", "Example\n\n="), "h1-title"), "fail");
  assert.match(detail(base.replace("# Example", "Example"), "h1-title"), /underlined with =/);
});

test("V04B: a link on a continuation line counts as the list item's link", () => {
  for (const item of ["-\n  [Guide](https://example.com/guide)", "- Read the\n  [Guide](https://example.com/guide)", "- Read the\n[Guide](https://example.com/guide)", "1.\n   [Guide](https://example.com/guide)", "- Read\n\n  [Guide](https://example.com/guide)"]) {
    const text = base.replace("- [Guide](https://example.com/guide)", item);
    assert.equal(status(text, "sections"), "pass", item);
  }
  // No open item: a paragraph after a blank line, a heading, a quote or a rule ends the item.
  for (const item of ["- Read\n\n[Guide](https://example.com/guide)", "- Read\n### More\n[Guide](https://example.com/guide)", "- Read\n> [Guide](https://example.com/guide)", "- Read\n---\n[Guide](https://example.com/guide)", "[Guide](https://example.com/guide)"]) {
    const text = base.replace("- [Guide](https://example.com/guide)", item);
    assert.equal(status(text, "sections"), "warn", item);
  }
});

test("V06: the HTML check needs a real tag", () => {
  const add = (t) => base + "\n" + t + "\n";
  for (const t of ["For the calculation, a <b + c.", "if n <b1 + 2", "a <b + c > d", "x <3 and 2> y", "<https://example.com>", "<mailto:a@example.com>", "a < b and c > d"]) {
    assert.equal(status(add(t), "no-html"), "pass", t);
  }
  for (const t of ["<b>bold</b>", "<br/>", "<br />", "</div>", "<!-- x -->", "<div class=\"x\">", "<a href=x>", "<img src='x'/>", "<p\nid=a>"]) {
    assert.equal(status(add(t), "no-html"), "warn", t);
  }
});

test("V07: a template marker inside a comment or a raw text element does not count", () => {
  const link = '<link rel="describedby" href="/live.txt">';
  // A "</template>" written inside a comment inside the template does not close it.
  assert.deepEqual(findLinkRelations("<head><template><!--</template>" + link.replace("live", "fake") + "--></template></head>", ""), { describedby: null, markdown: null });
  // A "</template>" inside a script inside the template does not close it either, and the link after the real end is found.
  assert.equal(findLinkRelations("<head><template><script>\"</template>\"</script></template>" + link + "</head>", "").describedby, "/live.txt");
  // Nested templates still count.
  assert.equal(findLinkRelations("<head><template><template></template>" + link.replace("live", "fake") + "</template>" + link + "</head>", "").describedby, "/live.txt");
});

test("V07: the template scan stays linear on hostile input", () => {
  // Both sizes stay under the 65,536 character head read, so the larger one is not cut before the scan.
  const time = (s) => { const t = performance.now(); findLinkRelations("<head><template>" + s, ""); return performance.now() - t; };
  for (const unit of ["</templateX", "<template>", "<style>", "<!--", "<template><style>"]) {
    const n = Math.floor(14000 / unit.length);
    time(unit.repeat(n));
    const small = time(unit.repeat(n));
    const large = time(unit.repeat(n * 4));
    assert.ok(large / Math.max(small, 1) < 20, unit + " scaled " + (large / Math.max(small, 1)).toFixed(1) + "x for 4x the input");
  }
});

test("V08: maskLocation keeps its output and runs in linear time on many query keys", () => {
  assert.equal(maskLocation("https://u:p@h.example/p?b=1&a=2&b=3&c#f"), "https://h.example/p?b=***&a=***&c=***");
  assert.equal(maskLocation("https://h.example/?"), "https://h.example/?");
  assert.equal(maskLocation("https://h.example/"), "https://h.example/");
  assert.equal(maskLocation("https://h.example/?a=1&&b"), "https://h.example/?a=***&b=***");
  const many = "https://h.example/?" + Array.from({ length: 8000 }, (_, i) => "k" + i + "=v").join("&");
  const t = performance.now();
  const out = maskLocation(many);
  const ms = performance.now() - t;
  assert.equal(out, "https://h.example/?" + Array.from({ length: 8000 }, (_, i) => "k" + i + "=***").join("&"));
  assert.ok(ms < 1000, "8000 keys took " + ms.toFixed(0) + " ms");
});

test("V10: an empty blockquote is not a summary", () => {
  for (const q of [">", ">   ", ">\t", "  >"]) {
    const text = base.replace("> Summary.", q);
    assert.equal(status(text, "summary"), "warn", JSON.stringify(q));
    assert.match(detail(text, "summary"), /recommended by the format/, JSON.stringify(q));
  }
  assert.equal(status(base.replace("> Summary.", ">Summary."), "summary"), "pass");
  assert.equal(status(base, "summary"), "pass");
});

test("F1: a blockquote block is the summary when any of its lines has text", () => {
  const withQuote = (q) => base.replace("> Summary.", q);
  for (const q of [">\n> Real summary", "> \n> Real summary", ">\n>\n> Real summary", "  >\n  > Real summary", "> Real summary\n>"]) {
    assert.equal(status(withQuote(q), "summary"), "pass", JSON.stringify(q));
    assert.match(detail(withQuote(q), "summary"), /Real summary/, JSON.stringify(q));
  }
  // A block whose every line is empty still warns, and it is not called a late blockquote.
  for (const q of [">", ">\n>", "> \n>\t\n>"]) {
    assert.equal(status(withQuote(q), "summary"), "warn", JSON.stringify(q));
    assert.match(detail(withQuote(q), "summary"), /recommended by the format/, JSON.stringify(q));
  }
  // A text blockquote after a blank line and an empty one is a different block and is named late.
  const late = withQuote(">\n\n> Later");
  assert.equal(status(late, "summary"), "warn");
  assert.match(detail(late, "summary"), /comes after other text/);
});

test("F2: an empty list marker takes only an indented continuation, and a fence closes the item", () => {
  const item = (t) => base.replace("- [Guide](https://example.com/guide)", t);
  for (const t of ["-\n  [Guide](https://example.com/guide)", "-\n\t[Guide](https://example.com/guide)", "- Read\n[Guide](https://example.com/guide)", "- Read\nthe [Guide](https://example.com/guide)", "-\n  Read the\n[Guide](https://example.com/guide)"]) {
    assert.equal(status(item(t), "sections"), "pass", JSON.stringify(t));
  }
  for (const t of ["-\n[Guide](https://example.com/guide)", "-\n [Guide](https://example.com/guide)", "-\n\n  [Guide](https://example.com/guide)", "- \n[Guide](https://example.com/guide)", "1.\n[Guide](https://example.com/guide)", "- Read\n```\nx\n```\n[Guide](https://example.com/guide)"]) {
    assert.equal(status(item(t), "sections"), "warn", JSON.stringify(t));
  }
  // A fence indented to the item content column is inside the item, so the item stays open after it.
  for (const t of ["- x\n  ```\n  y\n  ```\n  [Guide](https://example.com/guide)", "1. x\n   ```\n   y\n   ```\n   [Guide](https://example.com/guide)"]) {
    assert.equal(status(item(t), "sections"), "pass", JSON.stringify(t));
  }
});

test("F3: the HTML check reads any non-space attribute name", () => {
  const add = (t) => base + "\n" + t + "\n";
  for (const t of ["<div @click=\"x\">", "<div *ngIf=\"x\">", "<div class=a\"b\">", "<div class=a'b'>", "<div :class=\"x\" #slot>", "<div v-on:click.prevent=\"x\">", "<a title=\"1 > 2\">", "<input disabled>"]) {
    assert.equal(status(add(t), "no-html"), "warn", t);
  }
  for (const t of ["For the calculation, a <b + c.", "a <b + c > d", "a <b * c > d", "x <3 and 2> y", "<https://example.com>"]) {
    assert.equal(status(add(t), "no-html"), "pass", t);
  }
  // A tag still open at the end of the file has no closing bracket and does not warn.
  assert.equal(status(base + "\n<div class=\"x\"", "no-html"), "pass");
  // The scan stays linear on a long run of attributes with no closing bracket.
  const time = (s) => { const t = performance.now(); status(base + "\n" + s, "no-html"); return performance.now() - t; };
  for (const unit of ["<a b ", "<a b=\"x\" c='y ", "<a @b=x\"y\" ", "<a +++ ", "<a b=\"<a b='"]) {
    time(unit.repeat(2000));
    const small = time(unit.repeat(10000));
    const large = time(unit.repeat(40000));
    assert.ok(large / Math.max(small, 1) < 20, JSON.stringify(unit) + " scaled " + (large / Math.max(small, 1)).toFixed(1) + "x for 4x the input");
  }
});

test("V08: maskLocation output is unchanged for repeated keys and fast on 32000 keys", () => {
  assert.equal(maskLocation("https://h.example/?a=1&b=2&a=3&%61=4"), "https://h.example/?a=***&b=***");
  const many = "https://h.example/?" + Array.from({ length: 32000 }, (_, i) => "k" + i + "=v").join("&");
  const t = performance.now();
  const out = maskLocation(many);
  const ms = performance.now() - t;
  assert.equal(out, "https://h.example/?" + Array.from({ length: 32000 }, (_, i) => "k" + i + "=***").join("&"));
  assert.ok(ms < 1000, "32000 keys took " + ms.toFixed(0) + " ms");
});

test("V-1: the HTML check reads a Unicode letter or digit in an attribute name", () => {
  const add = (t) => base + "\n" + t + "\n";
  for (const t of ["<p ä=\"x\">", "<p data-ñ=1>", "<p é>", "<p ٣=\"x\">", "<p 名前=\"x\">"]) {
    assert.equal(status(add(t), "no-html"), "warn", t);
  }
  for (const t of ["a <b + c > d", "a <b ! ? > d", "a <é> b"]) {
    assert.equal(status(add(t), "no-html"), "pass", t);
  }
  const time = (s) => { const t = performance.now(); status(base + "\n" + s, "no-html"); return performance.now() - t; };
  for (const unit of ["<a ä ", "<a ä=\"x\" c='y ", "<a @ä=x\"y\" ", "<a ", "<a b=\"<a b='"]) {
    time(unit.repeat(2000));
    const small = time(unit.repeat(10000));
    const large = time(unit.repeat(40000));
    assert.ok(large / Math.max(small, 1) < 20, JSON.stringify(unit) + " scaled " + (large / Math.max(small, 1)).toFixed(1) + "x for 4x the input");
  }
});

test("V-2: the line after a fence needs the item's content column, and the column is the real content start", () => {
  const item = (t) => base.replace("- [Guide](https://example.com/guide)", t);
  const link = "[Guide](https://example.com/guide)";
  // (a) A lazy continuation cannot follow a fence, even one that sits inside the item.
  assert.equal(status(item("- item\n  ```\n  x\n  ```\n" + link), "sections"), "warn");
  assert.equal(status(item("- item\n  ```\n  x\n  ```\n  " + link), "sections"), "pass");
  // (b) "-   item" has its content at column 4, so 2 columns of indent are not inside the item.
  assert.equal(status(item("-   item\n  ```\n  x\n  ```\n  " + link), "sections"), "warn");
  assert.equal(status(item("-   item\n\n  " + link), "sections"), "warn");
  assert.equal(status(item("-   item\n\n    " + link), "sections"), "pass");
  assert.equal(status(item("- item\n\n  " + link), "sections"), "pass");
  // A bare marker takes a continuation only at its content column, which is 3 for "1.".
  assert.equal(status(item("1.\n  " + link), "sections"), "warn");
  assert.equal(status(item("1.\n   " + link), "sections"), "pass");
  // A lazy continuation of a plain item is unchanged.
  assert.equal(status(item("-   item\n" + link), "sections"), "pass");
});
