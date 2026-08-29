# turva-llms-txt-validator changelog

## 0.3.1 (2026-08-29)

A code scanning alert said the new section check runs in quadratic time on input the audited
site chooses, and it was right. The check tested every line with a regular expression that
rescanned the link target to the end of the line for each candidate on that line. A 300 kB
llms.txt built from a list marker and `[a](` repeated took 8 563 ms to read before and takes
17 ms now.

The link check had the same shape with a bound in place of a fix. Its pattern stopped a target
at 2 048 characters, which kept the pattern fast but dropped a longer target from the count, so
a file whose only link carries a very long URL was told it has no links at all. Both checks now
scan by index: every character is read once, there is no bound and no backtracking.

One behaviour changed with it. A link whose target is longer than 2 048 characters now counts
as a link. Fuzzing put both scans against the old patterns on 200 000 inputs each, and that is
the only difference either one produces.

## 0.3.0 (2026-08-29)

Six inputs that break the format used to pass. They fail or warn now, and the hosted
validator at turva.dev carries the same change, because it is the canonical copy and this
package mirrors it.

An indented line was read as a heading. The first non-empty line was trimmed before the H1
test, so `    # Site` passed as the title even though four spaces of indent make it a code
block. The line is now tested as markdown, with the three spaces CommonMark allows.

A section without a file list counted as a section. The check matched `## ` and the link
check scanned the whole file, so an H2 followed by a paragraph with a link in it satisfied
both. A section now counts when it carries a markdown list with a link in it, and the detail
line says how many of the sections do.

An entry with an empty name and a target with no host counted as a link. `[](https://x/y)`
gives an agent nothing to show and `https://` is a scheme without a host. Both warn now.

The v2 discovery checks claimed relations the page does not publish. The attribute readers
used `\b`, which matches inside `data-rel`, `data-type` and `data-href`, so a page could
pass on attributes a browser never reads. A relation without a target passed as a relation.
A media type only had to start with `text/markdown`, so `text/markdownish` passed. All three
are fixed, and a media type parameter such as `text/markdown;charset=utf-8` still passes.

Every one of the six carries a test with a positive control, and the six were run against
the old code first to prove they go red on it.

## 0.2.1 (2026-08-24)

The two v2 discovery checks now read the head a real HTML parser builds, and the code that
finds the link relations no longer uses regular expressions that a target site can make
quadratic.

Three code scanning alerts started this. One said the comment strip could leave a bare
`<!--` behind, and two said a character class that reads a tag's attributes runs in
quadratic time on input the target site chooses. All three were true. A page made of 256 KB
of unclosed `<script` tags took 2 383 ms to read before and takes 1 ms now.

The reader is one left to right scan by index. It removes comments and the content of the
script, style, title, noscript, noframes and template elements, and it stops where the head
ends: at the first text node or the first body level element, which is what the HTML parsing
spec describes in its "in head" and "after head" insertion modes. A `</head>` end tag does
not stop it, because a parser still puts link, meta, script, style, title and template into
the head element after one.

What this changes in a result: a link element that a parser moves into the body used to
count as a published relation and no longer does. Both checks stay information, never a
warning and never a failure, so the summary line and the `--strict` exit code are exactly
what they were in 0.2.0, and the eight structural checks on the llms.txt file did not move.

The behaviour was measured against parse5, a real HTML parser, on 200 000 generated
documents with four different seeds: identical on every input, in both directions. The
hosted validator at turva.dev/llms-txt-validator carries the same code and stays canonical.

## 0.2.0 (2026-08-24)

v2 of the llms.txt proposal was published on 2026-08-10. It left the file format
untouched and added discovery: a page names its markdown version with
`rel="alternate" type="text/markdown"` and the llms.txt that covers it with
`rel="describedby"`, either as HTML link elements or as a Link response header.

Two checks report those relations from the target site's home page. They report
`pass` when a relation is there and a new status, `info`, when it is not. Neither
is ever `warn` or `fail`, so the summary line and the `--strict` exit code are
exactly what they were in 0.1.8. The relations belong
to the site rather than to the file, and v2 is two weeks old, so scoring them as
warnings would have moved which files pass instead of measuring something new. How
common the relations are in the wild is not measured here and nothing claims it.

The fetch now reads two documents from the target, `/llms.txt` and `/`, each under
the same guards as before: https only, redirects only to the same host or its
www/apex twin, 8 second timeout, 256 KB cap. Nothing else is requested and the site
is still never crawled. `fetchLlmsTxt` takes `opts.path` and `opts.accept` for that
second read, and returns the response's Link header alongside the body.

The hosted validator at turva.dev/llms-txt-validator is canonical as always and
carries the same two checks.

## 0.1.8 (2026-08-04)

The 0.1.7 fix was incomplete. It bounded the label class and left the URL class
unbounded, and that class can still cross an opening bracket, so input shaped like
an unterminated link repeated over and over gave every position a fresh scan. 256 KB
of it took 6 410 ms after 0.1.7 and 6 182 ms before it, so that shape was never fixed.
CodeQL reopened the alert on the same line within the hour and it was right to.

The URL class is now bounded to 2 048 characters, which is longer than any link this
tool has any business reading, and the worst case drops to 172 ms. Behaviour is
identical to 0.1.6, measured across 200 000 fuzzed inputs on both the match count and
every captured URL.

## 0.1.7 (2026-08-04)

A ReDoS in the markdown link scan, reported by CodeQL against this package and
present in the hosted validator in the same words. The label class could cross an
opening bracket, so a run of unmatched `[` characters made the engine restart from
every position. 256 KB of them, which is this tool's own read cap, took 17,2 seconds
of CPU in one regex; after the fix the same input takes 0,5 ms. The input is fully
attacker controlled, because the validator fetches whatever URL it is given.

The label class now excludes the opening bracket as well, which makes the scan linear.
Behaviour is unchanged and that was measured rather than reasoned: across 200 000
fuzzed inputs the match count and every captured URL are identical, and the only
capture group that differs is the one this file never reads.

The CI workflow also declares `permissions: contents: read`, which it did not before.

Fixed in the hosted validator first, as the parity rule requires.

## 0.1.6 (2026-08-01)

Two corrections found by an audit of the hosted validator, mirrored here because
the hosted version is canonical.

The redirect chain now has one timeout budget instead of one per hop. `timeoutMs`
meant 8 seconds per redirect, so a file behind the maximum five hops could take
five times the value the caller passed. The budget is now taken once before the
loop and each hop gets what is left of it.

The check list said "Starts with a single H1 title". The check has never counted
H1 headings; it tests that the first non-empty line is one. The wording now says
what the code does. No behaviour change in that check.

## 0.1.5 (2026-07-26)

Documentation only. The README now states what the host check covers and
what it does not: IP literals, bracketed IPv6, ports, credentials and the
internal-use TLDs are refused before any request goes out, and every
redirect hop is checked by the same rule, but names are not resolved here,
so a public name pointing at a private address is stopped by the network
the fetch runs on rather than by this code. The repository also gained a
SECURITY.md covering the supported version, the trusted-publishing supply
chain and where to report a vulnerability. It stays out of the npm
tarball, which carries src, bin, README.md and LICENSE. No check logic
changes: src/index.mjs is identical to 0.1.4.

Correction 2026-08-16: the entry above overstates what the README says. The
README's host paragraph names IP literals, bracketed IPv6, localhost and the
internal-use TLDs; it does not name ports or credentials, although the code
refuses both (src/index.mjs rejects any port other than 443 or 80, rejects a
username or password, and re-checks every redirect hop by the same rule). The
published 0.1.5 tarball's README reads the same as the one on disk, so this
was wrong on the day it was written rather than gone stale. The README
paragraph is deliberately not being widened to match: it describes the check
as a host-shape check, which is what the code is, and claiming more there is
the direction this project avoids.

## 0.1.4 (2026-07-24)

VERSION is now read from package.json at module load, so the exported
VERSION and the HTTP User-Agent can no longer drift from the published
version (0.1.1 and 0.1.3 both shipped with a stale hardcoded string).
README and the package description now say eight checks, matching the
hosted validator page. The no-html check moved from a footnote into the
checks table as row 8. Bugs URL moved to GitHub issues (the repository
has been GitHub-canonical since 2026-07-21), and the README no longer
names a Codeberg mirror (the mirrors were removed 2026-07-24 after
Codeberg's Terms of Use change). No check logic changes.

## 0.1.3 (2026-07-21)

First release published from GitHub Actions with OIDC trusted publishing,
so npm carries a provenance attestation of where and how the package was
built. The repository URL moved to GitHub, which had become the canonical
host for the source. No check logic changes: src/index.mjs is identical
to 0.1.2, and only the version field, the repository URL and one README
sentence differ. The exported VERSION string still read 0.1.2 here, which
is the drift 0.1.4 removed.

## 0.1.2 (2026-07-21)

Check 1 now follows a redirect when the target is the same host or its
www/apex twin. Before this, a site that keeps llms.txt at the apex and
redirects www to it failed the first check even though the file was
there. The original rule refused every redirect, and that was an SSRF
control as much as a reading of the spec, so the follow is fenced in:
https only, no port, no credentials in the URL, a public hostname, at
most four hops, and the twin test on every hop. An off-site target, an
unsafe target, a missing Location header and a malformed one all still
fail the check. Four unit tests cover the new paths with a stubbed
fetch. The hosted validator at turva.dev/llms-txt-validator got the same
change the same day and stays canonical. The exported VERSION string,
which had read 0.1.0 since the first release, was corrected here.

## 0.1.1 (2026-07-18)

Restores the llms-txt-validate CLI command. npm rejected the ./-prefixed bin
path at publish time and stripped the bin mapping from 0.1.0, so 0.1.0
installs without the command. No code changes.

## 0.1.0 (2026-07-18)

First release. The seven structural checks of the hosted validator at
turva.dev/llms-txt-validator, extracted as an ES module with a CLI
(llms-txt-validate), a node:test suite, and the same JSON result shape as the
hosted endpoint.
