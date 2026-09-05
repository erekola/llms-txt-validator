# turva-llms-txt-validator

Check a website's `llms.txt` from the command line, Node or CI. Get a clear result for each check, with readable output or JSON.

**Eight structure checks and two informational discovery checks.** The result describes the file's structure and the home page's discovery links. It does not measure overall agent readiness or predict AI-search citations.

[Try it in your browser](https://turva.dev/llms-txt-validator) · [llms.txt guide](https://turva.dev/guides/llms-txt) · [All turva.dev tools](https://turva.dev/tools)

## Quick start

Requires **Node.js 18.17 or newer**. Run it without a global install:

```sh
npx turva-llms-txt-validator example.com
```

Replace `example.com` with the domain you want to check. A domain or HTTP(S) URL is accepted, and validation uses the host's `/llms.txt` and home page over HTTPS, regardless of the supplied path.

For repeated use, install the CLI globally:

```sh
npm install -g turva-llms-txt-validator
llms-txt-validate example.com
```

## Read the result

Each check has a status, a label and a short explanation. The eight structure checks determine the summary:

| Summary | Meaning | Default exit code | With `--strict` |
| --- | --- | --- | --- |
| `valid` | No structure warnings or failures | `0` | `0` |
| `valid with warnings` | At least one warning, no failures | `0` | `1` |
| `not valid` | At least one failure | `1` | `1` |
| Input or fetch error | Validation could not complete | `2` | `2` |

The two discovery checks return `pass` or `info`. They never change the summary or exit code, including in strict mode. If the home page cannot be read, those checks report `info`, and the file's structure result still stands.

Use JSON for automation and strict mode when warnings should fail a CI step:

```sh
npx turva-llms-txt-validator example.com --json --strict
```

Completed validation returns `{ target, summary, checks }`. Each check contains `{ id, status, label, detail }`. With `--json`, input and fetch errors return `{ "error": "..." }` and exit with code `2`.

## What it checks

### File structure

| # | Check | Failure | Warning |
| --- | --- | --- | --- |
| 1 | `/llms.txt` returns HTTP 200 | Non-200 response, rejected or excessive redirects | none |
| 2 | Response is plain text | Body looks like an HTML page | Content type is neither `text/plain` nor `text/markdown` |
| 3 | First non-empty line is a Markdown H1 | Missing H1, including a title indented as a code block | none |
| 4 | Blockquote summary follows the title | none | Missing summary |
| 5 | H2 sections group the content | none | No H2 sections, or no section contains a Markdown link list |
| 6 | Markdown links have names and absolute HTTP(S) targets | none | Missing links, empty names, relative targets or unsupported targets |
| 7 | File is small enough to read cheaply | none | Over 50 KB, or truncated at the 256 KB read limit |
| 8 | File contains no HTML markup | none | HTML tags found |

Some failures stop the file checks early. For example, an HTML response is reported as a failed plain-text check rather than parsed as Markdown.

### Home-page discovery

These checks are labelled **v2** in the output. They look for link relations in the home page's HTML head or HTTP `Link` header.

| # | Check | Pass condition | Otherwise |
| --- | --- | --- | --- |
| 9 | Home page points to its llms.txt | `rel="describedby"` has a non-empty target | `info` |
| 10 | Home page points to a Markdown version | `rel="alternate"` has media type `text/markdown` and a non-empty target | `info` |

The validator detects these declarations without fetching their targets. It also does not follow the links inside `llms.txt`, crawl the site or test whether an AI agent can complete a task there.

## Use from Node

Install the package in your project:

```sh
npm install turva-llms-txt-validator
```

Use an ES module, for example `validate.mjs`:

```js
import { validateHost } from "turva-llms-txt-validator";

const result = await validateHost("example.com");

console.log(result.summary);
for (const check of result.checks) {
  console.log(check.status, check.label, check.detail);
}
```

`validateHost` rejects on invalid input or a failed `/llms.txt` fetch. Structural failures are returned in `checks` with the summary `not valid`.

## Use in CI

Add this step to a GitHub Actions job that already has Node.js 18.17 or newer available. Replace `your-domain.com` with your domain:

```yaml
- name: Validate llms.txt
  run: npx turva-llms-txt-validator your-domain.com --strict
```

The same command works in Woodpecker and other runners with Node installed. Omit `--strict` if warnings should remain advisory.

## Fetch limits and security

The default validation requests two documents: `https://<host>/llms.txt` and `https://<host>/`. Redirects may add requests, but linked pages and discovery targets are never fetched. The validator stores no results.

- **Timeout:** eight seconds per document, shared across its redirect chain.
- **Read limit:** 256 KB per response.
- **Redirects:** up to four hops, over HTTPS, to the same host or its `www`/apex equivalent. Off-site redirects, embedded credentials and unsupported ports are rejected.
- **Host checks:** IP literals, bracketed IPv6 addresses, localhost, and the internal-use TLDs `local`, `internal`, `home`, `lan`, `corp`, `test` and `invalid` are rejected before a request is sent. Redirect targets are checked too.

**DNS resolution is not checked for private addresses.** A syntactically public domain can resolve to a private IP, so if you expose this package through a service that accepts untrusted domains, enforce private-address restrictions at the network layer. Local and CI runs use their own network policy, and the hosted validator runs on the Cloudflare edge.

For vulnerability reporting and supported versions, see [SECURITY.md](SECURITY.md).

## Hosted version and source

This package follows the validation logic used by the [hosted validator](https://turva.dev/llms-txt-validator), whose source is in the [turva.dev Cloudflare Worker](https://github.com/erekola/turva-worker). The hosted validator is the canonical implementation: if results diverge, this package is updated to match it.

The hosted version also returns JSON with the same result shape:

```sh
curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"
```

In Windows PowerShell, use `curl.exe` if `curl` resolves to `Invoke-WebRequest`.

The package has no runtime dependencies. The repository's release workflow uses npm trusted publishing with provenance. See [SECURITY.md](SECURITY.md) for details and [CHANGELOG.md](CHANGELOG.md) for releases.

## License

[MIT](LICENSE). Built by [Erik Rekola](https://github.com/erekola) at [turva.dev](https://turva.dev).
