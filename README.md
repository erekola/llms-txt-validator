# turva-llms-txt-validator

Validate a site's llms.txt structure from the command line, from Node, or in CI. Seven checks, each reported as pass, warn or fail, with a one-line detail. No score on purpose: a structure check can say what is there and what is missing, and a number on top of seven checks would look like an agent-readiness score without measuring one.

This is the open-source form of the hosted validator at [turva.dev/llms-txt-validator](https://turva.dev/llms-txt-validator), which runs the same logic inside the open [turva.dev Cloudflare Worker](https://github.com/erekola/turva-worker). The hosted validator stays canonical: if the two ever disagree, the hosted one wins and this package gets the fix.

## Install

    npm install -g turva-llms-txt-validator

Or run it without installing:

    npx turva-llms-txt-validator example.com

## CLI

    llms-txt-validate example.com
    llms-txt-validate example.com --json
    llms-txt-validate example.com --strict

Exit codes: 0 valid (warnings allowed), 1 not valid (with --strict, warnings also exit 1), 2 fetch or input error. Only the target site's /llms.txt is fetched over https, following a redirect only to the same host or its www/apex twin (an off-site or unsafe redirect fails the first check), the fetch times out after 8 seconds and the read is capped at 256 KB. Nothing is stored.

## The seven checks

| # | Check | fail | warn |
|---|-------|------|------|
| 1 | File exists at /llms.txt, HTTP 200 (a same-site www/apex redirect is followed) | non-200, or an off-site or unsafe redirect | |
| 2 | Response is plain text | body looks like HTML | content-type is not text/plain or text/markdown |
| 3 | Starts with a single H1 title | first non-empty line is not a markdown H1 | |
| 4 | Blockquote summary after the title | | missing one-line summary |
| 5 | H2 sections group the content | | no H2 sections |
| 6 | Markdown links an agent can follow | | no links, or relative links |
| 7 | Small enough to be cheap to read | | over 50 KB, or read truncated at 256 KB |

An eighth signal, inline HTML in the file, is reported in the same list as a warning.

## Node API

    import { validateHost } from "turva-llms-txt-validator";

    const result = await validateHost("example.com");
    console.log(result.summary);
    for (const c of result.checks) console.log(c.status, c.label, c.detail);

The summary is one of valid, valid with warnings, or not valid. The result object is { target, summary, checks }, the same shape the hosted validator returns as JSON:

    curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"

## CI

GitHub Actions:

    - name: Validate llms.txt
      run: npx turva-llms-txt-validator your-domain.com --strict

Woodpecker or any other runner: the same npx line works anywhere Node 18.17 or newer is present.

## Why these checks

The llms.txt format is a plain text map of a site for AI agents: an H1 title, a one-line blockquote summary, and H2 sections of markdown links. The checks test exactly that structure and nothing else. What the format is and why it matters is written out at [llms.txt explained](https://turva.dev/guides/llms-txt), and the free tools this package belongs to are collected at [turva.dev/tools](https://turva.dev/tools).

## License

MIT. Source at [github.com/erekola/llms-txt-validator](https://github.com/erekola/llms-txt-validator), mirrored at [codeberg.org/erekola/llms-txt-validator](https://codeberg.org/erekola/llms-txt-validator). Published to npm from GitHub Actions with provenance, a signed attestation of where and how the package was built, verifiable on the npm package page.
