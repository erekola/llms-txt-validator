import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The README's release check and install pin name a version. Each one must be the version in
// package.json, because 0.3.18 shipped with commits/v0.3.17 in the release check and a reader
// following it would have rejected the correct release (Tek-564, outside re-check W36 to W44).
// The test also demands at least one mention of each form, so it cannot pass on an empty match.

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const forms = [
  ["Tag `vX.Y.Z`", /Tag `v(\d+\.\d+\.\d+)`/g],
  ["commits/vX.Y.Z", /commits\/v(\d+\.\d+\.\d+)/g],
  ["turva-llms-txt-validator@X.Y.Z", /turva-llms-txt-validator@(\d+\.\d+\.\d+)/g],
];

test("README: every tag, commit and install version is the package.json version", () => {
  for (const [name, pattern] of forms) {
    const found = [...readme.matchAll(pattern)].map((m) => m[1]);
    assert.ok(found.length > 0, "README names no version in the form " + name);
    for (const v of found) assert.equal(v, pkg.version, "README names " + v + " in the form " + name + ", package.json is " + pkg.version);
  }
});
