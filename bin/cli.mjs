#!/usr/bin/env node
// CLI for turva-llms-txt-validator. Exit codes: 0 = valid (or valid with
// warnings), 1 = not valid (or warnings with --strict), 2 = could not fetch
// or bad input. Same checks and JSON shape as the hosted validator:
// curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"
import { validateHost } from "../src/index.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const target = args.find((a) => !a.startsWith("--"));

if (!target || flags.has("--help")) {
  console.log("usage: llms-txt-validate <domain-or-url> [--json] [--strict]");
  console.log("  --json    print the result as JSON (same shape as the hosted validator)");
  console.log("  --strict  exit 1 on warnings too, for CI gates");
  process.exit(target ? 0 : 2);
}

const mark = { pass: "ok  ", warn: "warn", fail: "FAIL" };
try {
  const result = await validateHost(target);
  if (flags.has("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.target);
    for (const c of result.checks) console.log("  " + mark[c.status] + "  " + c.label + " (" + c.detail + ")");
    console.log("result: " + result.summary);
  }
  if (result.summary === "not valid") process.exit(1);
  if (result.summary === "valid with warnings" && flags.has("--strict")) process.exit(1);
  process.exit(0);
} catch (err) {
  console.error("error: " + (err && err.message ? err.message : String(err)));
  process.exit(2);
}
