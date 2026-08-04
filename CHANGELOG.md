# turva-llms-txt-validator changelog

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
