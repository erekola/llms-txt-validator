#!/usr/bin/env node
// CLI for turva-llms-txt-validator. Exit codes: 0 = valid (or valid with
// warnings), 1 = not valid (or warnings with --strict), 2 = could not fetch
// or bad input. The two v2 discovery checks and the input-path note carry status
// "info" and move no exit code, by design. Same checks and JSON shape as the hosted validator:
// curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"
import { validateHost, stripControls } from "../src/index.mjs";

const USAGE = [
  "usage: llms-txt-validate <domain-or-url> [--json] [--strict]",
  "  --json    print the result as JSON (same shape as the hosted validator)",
  "  --strict  exit 1 on warnings too, for CI gates",
  "  --help    print this help"
];
const KNOWN = new Set(["--json", "--strict", "--help", "-h"]);

// The arguments are read strictly since 0.3.8 (Tek-496). An unknown flag such as a misspelled
// --strcit used to be ignored, so a CI step ran without the gate it asked for, and a second
// target was dropped without a word. Both now stop with exit 2, and every input error is JSON
// when --json was given, the missing target included.
const args = process.argv.slice(2);
const json = args.includes("--json");
const flags = args.filter((a) => a.startsWith("-") && a !== "-");
const targets = args.filter((a) => !(a.startsWith("-") && a !== "-"));

function fail(message) {
  if (json) console.log(JSON.stringify({ error: message }, null, 2));
  else {
    console.error("error: " + message);
    console.error(USAGE[0]);
  }
  process.exit(2);
}

if (flags.includes("--help") || flags.includes("-h")) {
  for (const line of USAGE) console.log(line);
  process.exit(0);
}
const unknown = flags.find((f) => !KNOWN.has(f));
if (unknown) fail("unknown option " + JSON.stringify(stripControls(unknown).slice(0, 40)));
if (targets.length === 0 || targets[0].trim() === "") fail("no domain or URL given");
if (targets.length > 1) fail("one domain or URL at a time, got " + targets.length);

const mark = { pass: "ok  ", warn: "warn", fail: "FAIL", info: "info" };
try {
  const result = await validateHost(targets[0]);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Details reach this point without control characters (validateHost strips them), so a
    // published link cannot write an escape sequence to the terminal.
    console.log(result.target);
    for (const c of result.checks) console.log("  " + mark[c.status] + "  " + c.label + " (" + c.detail + ")");
    console.log("result: " + result.summary);
  }
  if (result.summary === "not valid") process.exit(1);
  if (result.summary === "valid with warnings" && flags.includes("--strict")) process.exit(1);
  process.exit(0);
} catch (err) {
  const message = stripControls(err && err.message ? err.message : String(err));
  // The hosted validator answers every failure as JSON when JSON was asked for, so a CI
  // step that parses --json output gets {"error": ...} here too instead of an empty stdout
  // and a plain-text stderr (round 16 S3-3). The exit code is unchanged.
  if (json) console.log(JSON.stringify({ error: message }, null, 2));
  else console.error("error: " + message);
  process.exit(2);
}
