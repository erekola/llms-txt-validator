# turva-llms-txt-validator

Validate a site's llms.txt structure from the command line, from Node or in CI. Eight structure checks, each reported as pass, warn or fail with a one-line detail, and two v2 discovery checks reported as information. No score on purpose: a structure check can say what is there and what is missing, and a number on top of ten checks would look like an agent-readiness score without measuring one.

This is the open-source form of the hosted validator at [turva.dev/llms-txt-validator](https://turva.dev/llms-txt-validator), which runs the same logic inside the open [turva.dev Cloudflare Worker](https://github.com/erekola/turva-worker). The hosted validator stays canonical: if the two ever disagree, the hosted one wins and this package gets the fix.

## Install

    npm install -g turva-llms-txt-validator

Or run it without installing:

    npx turva-llms-txt-validator example.com

## CLI

    llms-txt-validate example.com
    llms-txt-validate example.com --json
    llms-txt-validate example.com --strict

Exit codes: 0 valid (warnings allowed), 1 not valid (with --strict, warnings also exit 1), 2 fetch or input error. The two v2 checks are reported as information and move no exit code. Two documents are fetched from the target site over https, its /llms.txt and its home page, each following a redirect only to the same host or its www/apex twin (an off-site or unsafe redirect fails the first check), each fetch times out after 8 seconds and each read is capped at 256 KB. Nothing else is requested, the site is never crawled and nothing is stored.

The target has to be a public domain name: an IP literal, a bracketed IPv6 address, localhost and the internal-use TLDs local, internal, home, lan, corp, test and invalid are all refused before any request goes out, and every redirect hop is checked by the same rule. Names are not resolved here, so a public name that points at a private address is stopped by the network the fetch runs on rather than by this code. On the hosted validator that network is the Cloudflare edge, which does not route to private address space.

## The checks

| # | Check | fail | warn |
|---|-------|------|------|
| 1 | File exists at /llms.txt, HTTP 200 (a same-site www/apex redirect is followed) | non-200, or an off-site or unsafe redirect | |
| 2 | Response is plain text | body looks like HTML | content-type is not text/plain or text/markdown |
| 3 | Starts with an H1 title | first non-empty line is not a markdown H1, indentation included, since four spaces make it a code block | |
| 4 | Blockquote summary after the title | | missing one-line summary |
| 5 | H2 sections group the content | | no H2 sections, or no section carrying a markdown file list |
| 6 | Markdown links an agent can follow | | no links, an empty link name, a scheme without a host, or relative links |
| 7 | Small enough to be cheap to read | | over 50 KB, or read truncated at 256 KB |
| 8 | No HTML markup in the file | | HTML tags found |

Two more checks read the site's home page for the link relations v2 of the format recommends. They describe the site rather than the file, so they carry the status `pass` when the relation is there and `info` when it is not, never `warn` and never `fail`, and they leave both the summary line and the `--strict` exit code alone. v2 is two weeks old at the time of writing, so warning about these would turn valid files into files with warnings for following the version of the format they were written against.

| # | Check | pass | info |
|---|-------|------|------|
| 9 | Home page points to its llms.txt (v2) | `rel="describedby"` with a target, found in the head or the Link header | not found, no target on the relation, or the home page could not be read |
| 10 | Home page points to a markdown version (v2) | `rel="alternate"` with the media type `text/markdown` and a target, found in the head or the Link header | not found, no target on the relation, a different media type, or the home page could not be read |

## Node API

    import { validateHost } from "turva-llms-txt-validator";

    const result = await validateHost("example.com");
    console.log(result.summary);
    for (const c of result.checks) console.log(c.status, c.label, c.detail);

The summary is one of valid, valid with warnings, or not valid, and the two v2 checks never change it. The result object is { target, summary, checks }, the same shape the hosted validator returns as JSON:

    curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"

## CI

GitHub Actions:

    - name: Validate llms.txt
      run: npx turva-llms-txt-validator your-domain.com --strict

Woodpecker or any other runner: the same npx line works anywhere Node 18.17 or newer is present.

## Why these checks

The llms.txt format is a plain text map of a site for AI agents: an H1 title, a one-line blockquote summary and H2 sections of markdown links. v2 of the proposal, published in August 2026, left that format alone and added two link relations so an agent can find a page's markdown version and its llms.txt without guessing. The first eight checks test the structure and nothing else, and the last two report those two relations. What the format is and why it matters is written out at [llms.txt explained](https://turva.dev/guides/llms-txt), and the free tools this package belongs to are collected at [turva.dev/tools](https://turva.dev/tools).

## License

MIT. Source at [github.com/erekola/llms-txt-validator](https://github.com/erekola/llms-txt-validator). Published to npm from GitHub Actions with provenance, a signed attestation of where and how the package was built, verifiable on the npm package page.
