// Round 3 (Tek-542), batch Fv: Codex's third-round verification found five confirmed npm-package
// findings in scope for this batch: V03-VN1, V03-VREG1, V03-VREG2, V03-VREG3/VN3 and V03-VN2
// (shortcut and collapsed references only). V10-P3-01 (package side) is the sixth. Every
// reproduction input below is the exact fixture from varmennus-V03.md / V03-vastaus.md, or the
// exact case named in korjausohje-3.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { validateLlmsTxt, summarizeChecks, validateHost, maskLocation } from "../src/index.mjs";

const good = (text, extra = {}) => ({ status: 200, contentType: "text/plain; charset=utf-8", text, bytes: Buffer.byteLength(text), truncated: false, ...extra });
const byId = (checks, id) => checks.find((c) => c.id === id);
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
    "bin/cli.mjs",
    "AUDIT_USER:AUDIT_SECRET_64923@example.com/?token=TOPSECRET#FRAGMENTSECRET", "--json"
  ]);
  const out = JSON.parse(res.stdout.toString());
  assert.equal(out.error, "not a public domain name");
  assert.equal(out.target, "***@example.com/?***");
  assert.ok(!out.target.includes("AUDIT_SECRET"));
});

test("VN1: an @ with no / anywhere in the string is still read as a path, not userinfo", () => {
  // Regression guard: "path@2x.png" must stay unmasked (validate.test.mjs already covers this
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
    const res = spawnSync(process.execPath, ["bin/cli.mjs", input, "--json"]);
    assert.equal(res.status, 2, input);
    const out = JSON.parse(res.stdout.toString());
    assert.ok(typeof out.target === "string" && out.target.startsWith("***@"), input + " -> " + out.target);
    assert.doesNotMatch(res.stdout.toString(), /demo-secret|pw/, input);
  }
  const plain = JSON.parse(spawnSync(process.execPath, ["bin/cli.mjs", "path@2x.png", "--json"]).stdout.toString());
  assert.equal(plain.target, "path@2x.png");
});

// --- V03-VREG1: a link reference definition is CommonMark-valid only in its own block, not
// inside a code span or as a paragraph continuation line, with a title that is quoted or
// absent; fence removal must not join lines across a fenced block. Codex's four exact cases.
test("VREG1: a definition with an unquoted trailing word is not a definition", () => {
  const text = prefix + "- [Guide][guide]\n\n[guide]: https://example.com/guide not-a-title\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").detail, "no markdown links found");
});

test("VREG1: a definition-shaped line inside an inline code span is literal code", () => {
  const text = prefix + "- [Guide][guide]\n\n`some code\n[guide]: https://example.com/guide\nend code`\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").detail, "no markdown links found");
});

test("VREG1: a definition-shaped line that continues open paragraph text is not a definition", () => {
  const text = prefix + "- [Guide][guide]\n\nA paragraph\n[guide]: https://example.com/guide\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").detail, "no markdown links found");
});

test("VREG1: fence removal does not join a link target across a fenced code block", () => {
  const text = prefix + "- [Guide](\n```\nanything\n```\n  https://example.com/guide\n  )\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").detail, "no markdown links found");
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
  assert.equal(byId(checks, "links").detail, "no markdown links found");
});

test("VN2: a collapsed reference, \"[label][]\", still resolves (regression guard)", () => {
  const text = prefix + "- [Guide][]\n\n[guide]: https://example.com/guide\n";
  const checks = validateLlmsTxt(good(text));
  assert.equal(byId(checks, "links").status, "pass");
});

// --- V10-P3-01 (package side): the typed-path note carries its value in a separate field,
// mirroring worker.js's decision 19 (Tek-526), instead of building it into the sentence.
test("V10-P3-01: the input-path check's value and detail are separate fields", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "# Example\n\n> One line.\n\n## Docs\n\n- [G](https://ex.com/g)\n",
    { status: 200, headers: { "content-type": "text/plain" } }
  );
  try {
    const typed = await validateHost("https://ex.com/docs/llms.txt?key=secret");
    assert.equal(typed.checks[0].id, "input-path");
    assert.equal(typed.checks[0].value, "/docs/llms.txt");
    assert.equal(
      typed.checks[0].detail,
      "This path is not used, because the validator always reads /llms.txt at the root of the host."
    );
  } finally { globalThis.fetch = orig; }
});
