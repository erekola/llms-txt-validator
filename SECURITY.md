# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |

Fixes ship as a new release rather than as a patch to an older one, so the
latest published version is the supported one.

## Supply chain

The package is published to npm from GitHub Actions with npm trusted
publishing over OIDC. Since version 0.1.3, every release carries a provenance
attestation naming the repository, the workflow and the commit it was built
from, verifiable on the npm package page. Versions 0.1.1 and 0.1.2 were
published before trusted publishing was set up and carry no attestation;
check the version page on npmjs.com before relying on provenance for a given
version. No npm token is stored in this repository.

There are no runtime dependencies. The module reads its own package.json for
the version string and calls fetch, and nothing else.

## What the validator fetches

Two documents per run, the target site's /llms.txt and its home page (/),
both over https. The target has to be a public domain name, redirects are
followed only to the same host or its www/apex twin, each fetch times out
after 8 seconds and the read is capped at 256 KB. Nothing is stored.
README.md documents the rules in full, including what the host check does
and does not cover.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately
by emailing **info@turva.dev**.

Please do not open a public issue for security reports.

You can expect an initial response within one business day. If the issue is
confirmed, a fix will be prioritized and you'll be kept informed of progress.

## Verify a release

To check a release, install it in an empty directory with `npm install turva-llms-txt-validator@<version> --ignore-scripts` and run `npm audit signatures`. The provenance attestation must name the repository `github.com/erekola/llms-txt-validator`, the workflow file `.github/workflows/publish.yml` and a commit that the release tag `v<version>` also points at. `gh api repos/erekola/llms-txt-validator/commits/v<version> --jq .sha` prints the tag's commit. The npm version page shows the attestation's commit under Provenance. Provenance names the repository, the workflow and the commit that produced a release. It does not prove that the code is safe.
