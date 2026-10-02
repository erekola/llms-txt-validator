import { test } from "node:test";
import assert from "node:assert/strict";
import { validateLlmsTxt, summarizeChecks } from "../src/index.mjs";

// Regression tests for 0.3.18 (Tek-562, outside review W30, 2026-10-02). An H2 is "##" followed by a
// space or a tab, or one line of paragraph text underlined with hyphens. The hosted validator carries
// the same cases in the turva-worker repo. Each positive case gave a "no H2 sections found" warning
// in 0.3.17, and the guards say what still is not an H2.

const good = (text) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false });
const run = (text) => validateLlmsTxt(good(text));
const status = (text, id) => run(text).find((c) => c.id === id).status;
const detail = (text, id) => run(text).find((c) => c.id === id).detail;

const head = "# Test\n\n> Summary\n\n";
const link = "- [Guide](https://turva.dev/guides/llms-txt)\n";

test("W30 F1: a tab after the two hashes is an H2", () => {
  const report = "# Test\n\n> Summary\n\n##\tLinks\n\n- [Guide](https://turva.dev/guides/llms-txt)\n";
  assert.equal(Buffer.byteLength(report), 74);
  assert.equal(status(report, "sections"), "pass");
  assert.match(detail(report, "sections"), /^1 section, 1 carrying a file list$/);
  assert.equal(summarizeChecks(run(report)), "valid");
  assert.equal(status(head + "## \tLinks\n\n" + link, "sections"), "pass");
});

test("W30 F1: a setext H2, one text line underlined with hyphens, is an H2", () => {
  const text = head + "Links\n-----\n\n" + link;
  assert.equal(status(text, "sections"), "pass");
  assert.match(detail(text, "sections"), /^1 section, 1 carrying a file list$/);
  assert.equal(summarizeChecks(run(text)), "valid");
  // One hyphen and trailing spaces are an underline too, and an indent of up to three spaces is fine.
  assert.equal(status(head + "Links\n-\n\n" + link, "sections"), "pass");
  assert.equal(status(head + "   Links\n  ---  \n\n" + link, "sections"), "pass");
});

test("W30 F1: the links under a setext H2 are that section's file list", () => {
  const text = head + "Docs\n----\n\n" + link + "\nOptional\n--------\n\nNo list here.\n";
  assert.match(detail(text, "sections"), /^2 sections, 1 carrying a file list$/);
  assert.equal(status(text, "sections"), "pass");
  // The underline is not content: the list and the next heading are read as before.
  const noList = head + "Docs\n----\n\nOnly a paragraph.\n";
  assert.equal(status(noList, "sections"), "warn");
  assert.match(detail(noList, "sections"), /^1 section but no file list/);
});

test("W30 F1: a setext H2 ends the late-summary search like an ATX one", () => {
  const text = "# Test\n\nIntro text.\n\nLinks\n-----\n\n> Not a summary.\n\n" + link;
  assert.match(detail(text, "summary"), /recommended by the format/);
});

test("W30 F1: what stays outside the H2 reading", () => {
  // A list item followed by hyphens is a list item and a thematic break.
  const listThenBreak = head + "- [Guide](https://example.org/a)\n---\n";
  assert.equal(status(listThenBreak, "sections"), "warn");
  assert.match(detail(listThenBreak, "sections"), /no H2 sections found/);
  // Hyphens after a blank line are a thematic break.
  const breakOnly = head + "\n---\n\n" + link;
  assert.match(detail(breakOnly, "sections"), /no H2 sections found/);
  // Two breaks in a row are not a setext heading with the text "---".
  assert.match(detail(head + "\n---\n---\n\n" + link, "sections"), /no H2 sections found/);
  // Text that follows other text without a blank line is a multi-line paragraph, not a one-line heading.
  assert.match(detail(head + "Intro\nLinks\n-----\n\n" + link, "sections"), /no H2 sections found/);
  // Inside a fence, in both ATX and setext form.
  const fencedAtx = head + "```\n##\tLinks\n```\n\n" + link;
  assert.match(detail(fencedAtx, "sections"), /no H2 sections found/);
  const fencedSetext = head + "```\nLinks\n-----\n```\n\n" + link;
  assert.match(detail(fencedSetext, "sections"), /no H2 sections found/);
  // A bare "##" and a deeper heading are not H2.
  assert.match(detail(head + "##\n\n" + link, "sections"), /no H2 sections found/);
  assert.match(detail(head + "###\tLinks\n\n" + link, "sections"), /no H2 sections found/);
  // Four spaces make an indented code block, and a quote or a list marker starts another block.
  assert.match(detail(head + "    Links\n-----\n\n" + link, "sections"), /no H2 sections found/);
  assert.match(detail(head + "> Links\n-----\n\n" + link, "sections"), /no H2 sections found/);
});

test("W30 F1: a setext line with a leading hash is still not an H1 or an H2", () => {
  const h1 = "#Project\n===\n\n> Summary\n\n## Docs\n\n" + link;
  assert.equal(status(h1, "h1-title"), "fail");
  const h2 = head + "#Docs\n-----\n\n" + link;
  assert.match(detail(h2, "sections"), /no H2 sections found/);
});
