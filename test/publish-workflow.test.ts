import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// publish.yml is the one workflow that holds id-token: write, so its shape is part of the
// supply chain (audit round 24, V1-4 and V1-5, Tek-778). The test reads the file as text, because
// the package has no YAML parser, and checks four things: the OIDC permission belongs to the
// publish job alone, publish needs build which needs test, every action is pinned by commit SHA,
// and every npm publish path starts with ./ (npm reads dir/name.tgz as a GitHub shorthand).
// The last test runs the same checks on broken copies of the file, so they cannot pass on nothing.

const workflow = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");

type Job = { name: string; lines: string[] };

function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));
}

// Splits the text under the top-level "jobs:" key into jobs: a job starts at a line indented by
// exactly two spaces that ends in a colon.
function jobsOf(text: string): { head: string[]; jobs: Job[] } {
  const lines = codeLines(text);
  const start = lines.findIndex((l) => l === "jobs:");
  assert.ok(start > 0, "publish.yml has no top-level jobs: key");
  const head = lines.slice(0, start);
  const jobs: Job[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) jobs.push({ name: m[1] as string, lines: [] });
    else jobs[jobs.length - 1]?.lines.push(l);
  }
  return { head, jobs };
}

function needsOf(job: Job): string[] {
  const line = job.lines.find((l) => /^ {4}needs:/.test(l));
  if (!line) return [];
  return (line.split(":")[1] ?? "").replace(/[\[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

// The permission keys of a job-level "permissions:" block (four-space indent, entries at six).
function permissionsOf(job: Job): string[] {
  const i = job.lines.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  if (i < 0) return [];
  const keys: string[] = [];
  for (const l of job.lines.slice(i + 1)) {
    const m = /^ {6}([a-z-]+):/.exec(l);
    if (!m) break;
    keys.push(m[1] as string);
  }
  return keys;
}

function check(text: string): string[] {
  const problems: string[] = [];
  const { head, jobs } = jobsOf(text);
  const names = jobs.map((j) => j.name);
  for (const n of ["test", "build", "publish"]) if (!names.includes(n)) problems.push("no job named " + n);
  const byName = (n: string) => jobs.find((j) => j.name === n);

  if (head.some((l) => /id-token/.test(l))) problems.push("id-token appears at workflow level");
  for (const j of jobs) {
    const has = j.lines.some((l) => /id-token\s*:/.test(l));
    if (has && j.name !== "publish") problems.push("id-token appears in job " + j.name);
  }
  const pub = byName("publish");
  if (pub) {
    const perms = permissionsOf(pub);
    if (perms.join(",") !== "id-token") problems.push("publish job permissions are [" + perms.join(",") + "], expected only id-token");
    if (!pub.lines.some((l) => /^\s+(?:- )?id-token:\s*write\b/.test(l))) problems.push("publish job does not hold id-token: write");
    if (pub.lines.some((l) => /uses:\s*actions\/checkout@/.test(l))) problems.push("publish job has a checkout");
    if (pub.lines.some((l) => /\bnpm (?:ci|install|test|run)\b/.test(l))) problems.push("publish job runs an install, test or script");
  }
  if (pub && !needsOf(pub).includes("build")) problems.push("publish does not need build");
  const build = byName("build");
  if (build && !needsOf(build).includes("test")) problems.push("build does not need test");
  for (const n of ["test", "build"]) {
    const j = byName(n);
    if (j && permissionsOf(j).join(",") !== "contents") problems.push("job " + n + " permissions are not contents: read only");
  }

  const all = codeLines(text);
  const uses = all.filter((l) => /\buses:/.test(l));
  if (uses.length === 0) problems.push("no uses: lines found");
  for (const l of uses) if (!/uses:\s*[\w.\/-]+@[0-9a-f]{40}(?:\s|$)/.test(l)) problems.push("uses: not pinned by SHA: " + l.trim());

  const publishes = all.filter((l) => /\bnpm publish\b/.test(l));
  if (publishes.length === 0) problems.push("no npm publish found");
  for (const l of publishes) if (!/\bnpm publish\s+"?\.\//.test(l)) problems.push("npm publish path does not start with ./: " + l.trim());
  return problems;
}

test("publish.yml: id-token only in publish, publish needs build needs test, SHA pins, ./ publish path", () => {
  assert.deepEqual(check(workflow), []);
});

test("publish.yml checks fail on broken copies", () => {
  const mutations: [string, (t: string) => string, RegExp][] = [
    ["workflow-level id-token", (t) => t.replace("permissions:\n  contents: read\n\njobs:", "permissions:\n  id-token: write\n  contents: read\n\njobs:"), /workflow level/],
    ["id-token in build", (t) => t.replace(/(  build:\n(?:.*\n)*?    permissions:\n      contents: read)/, "$1\n      id-token: write"), /id-token appears in job build/],
    ["publish without id-token", (t) => t.replace(/      id-token: write.*\n/, "      contents: read\n"), /publish job permissions|does not hold/],
    ["publish does not need build", (t) => t.replace("  publish:\n    needs: build", "  publish:\n    needs: test"), /publish does not need build/],
    ["build does not need test", (t) => t.replace("  build:\n    needs: test", "  build:\n    needs: []"), /build does not need test/],
    ["tag instead of SHA", (t) => t.replace(/actions\/setup-node@[0-9a-f]{40} # v7\.1\.0/, "actions/setup-node@v7"), /not pinned by SHA/],
    ["publish path without ./", (t) => t.replace('"./release-pack/$TARBALL"', '"release-pack/$TARBALL"'), /does not start with \.\//],
    ["checkout in publish", (t) => t.replace("  publish:\n    needs: build\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    permissions:\n      id-token: write   # required: lets the job mint the OIDC token for npm\n    steps:\n", "  publish:\n    needs: build\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    permissions:\n      id-token: write\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n"), /publish job has a checkout/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const broken = mutate(workflow);
    assert.notEqual(broken, workflow, "mutation did not change the text: " + label);
    const problems = check(broken);
    assert.ok(problems.some((p) => expected.test(p)), label + ": expected a problem matching " + expected + ", got " + JSON.stringify(problems));
  }
});
