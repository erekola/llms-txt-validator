# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |

Fixes ship as a new release rather than as a patch to an older one, so the
latest published version is the supported one.

## Supply chain

The package is published to npm from GitHub Actions with npm trusted
publishing over OIDC. Every release carries a provenance attestation naming
the repository, the workflow and the commit it was built from, verifiable on
the npm package page. No npm token is stored in this repository.

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

You can expect an initial response within a few days. If the issue is
confirmed, a fix will be prioritized and you'll be kept informed of progress.
