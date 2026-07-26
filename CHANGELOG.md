# turva-llms-txt-validator changelog

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
