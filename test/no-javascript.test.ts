import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The source of this package is TypeScript, and the JavaScript in dist/ is built from it. A
// hand-written .js, .mjs or .cjs file outside node_modules, dist and .git would be source that the
// compiler does not check, and the publish workflow would not build it, so this test fails on
// the first one. The walker skips those three folders at any depth.

const SKIPPED = new Set(["node_modules", "dist", ".git"]);
const JAVASCRIPT = /\.(?:js|mjs|cjs)$/;

function findJavaScript(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findJavaScript(path));
    else if (JAVASCRIPT.test(entry.name)) found.push(path);
  }
  return found.sort();
}

test("the walker finds planted JavaScript names and skips node_modules, dist and .git at any depth", () => {
  const root = mkdtempSync(join(tmpdir(), "llms-txt-validator-js-walk-"));
  try {
    mkdirSync(join(root, "sub", "node_modules"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "sub", "dist"));
    mkdirSync(join(root, ".git"));
    for (const name of ["a.mjs", "sub/b.cjs", "sub/c.js", "sub/keep.ts", "sub/notes.json"]) writeFileSync(join(root, name), "");
    for (const name of ["node_modules/x.js", "dist/y.js", "sub/node_modules/z.js", "sub/dist/w.mjs", ".git/hook.js"]) writeFileSync(join(root, name), "");
    assert.deepEqual(findJavaScript(root), [join(root, "a.mjs"), join(root, "sub", "b.cjs"), join(root, "sub", "c.js")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the package source tree holds no .js, .mjs or .cjs file", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  // The walk must start at the package root: package.json and src/index.ts are there to be seen.
  assert.ok(readdirSync(root).includes("package.json"), "the walk does not start at the package root: " + root);
  assert.ok(readdirSync(join(root, "src")).includes("index.ts"), "src/index.ts is missing");
  const found = findJavaScript(root);
  assert.deepEqual(found, [], "JavaScript files in the source tree: " + found.join(", "));
});
