# turva-llms-txt-validator

Check a website's `llms.txt` from the command line, Node or CI. Get a clear result for each check, with readable output or JSON.

**Eight structure checks and two informational discovery checks.** The result describes the file's structure and the home page's discovery links. It does not measure overall agent readiness or predict AI-search citations.

[npm package](https://www.npmjs.com/package/turva-llms-txt-validator) · [Try it in your browser](https://turva.dev/llms-txt-validator) · [llms.txt guide](https://turva.dev/guides/llms-txt) · [All turva.dev tools](https://turva.dev/tools)

## Quick start

Requires **Node.js 22 or newer**. Run it without a global install:

```sh
npx --yes turva-llms-txt-validator example.com
```

Replace `example.com` with the domain you want to check. A domain, HTTP URL or HTTPS URL is accepted. Validation uses the host's `/llms.txt` and home page over HTTPS, regardless of the supplied path. If the address has a path other than `/` or `/llms.txt`, the result names that path first in an `info` line.

For repeated use, install the CLI globally:

```sh
npm install -g turva-llms-txt-validator
llms-txt-validate example.com
```

## Read the result

The summary comes last. Each preceding line reports one check. This shortened example uses the hosted validator's turva.dev result observed on 2026-09-09, formatted as the CLI prints it. The remaining passing checks are omitted here:

```text
https://turva.dev/llms.txt
  ok    File exists at /llms.txt (HTTP 200)
  ok    Response is plain text (text/plain)
  ok    Starts with an H1 title ("# turva.dev")
result: valid
```

A `warn` identifies something to review, such as a missing blockquote summary. It does not fail the command unless you add `--strict`. A `FAIL` means a structural requirement failed. Each line includes the observed detail.

The eight structure checks determine the summary:

| Summary | Meaning | Default exit code | With `--strict` |
| --- | --- | --- | --- |
| `valid` | No structure warnings or failures | `0` | `0` |
| `valid with warnings` | At least one warning, no failures | `0` | `1` |
| `not valid` | At least one failure | `1` | `1` |
| Input or fetch error | Validation could not complete | `2` | `2` |

The two discovery checks return `pass` or `info`. They never change the summary or exit code, including in strict mode. If the home page cannot be read, those checks report `info`. The file's structure result still stands.

Use JSON for automation and strict mode when warnings should fail a CI step:

```sh
npx --yes turva-llms-txt-validator example.com --json --strict
```

Completed validation returns `{ target, summary, checks }`. Each check contains `{ id, status, label, detail }`. The `input-path` check, which reports a path given with the domain and then ignored, also carries `value`, that path cut to 120 characters. With `--json`, an invalid domain or a failed fetch returns `{ "error": "...", "target": "..." }` and exits with code `2`. The target is the address given on the command line, with any password and query value masked. A user name is masked too, except in a value such as `user:secret@example.com`, where the part before the colon reads as a URL scheme and is shown as `user:***@example.com`. A value with no scheme and no slash is read as user information when a colon comes before its last `@`, so `user_name:secret@example.com` is shown as `***@example.com`. Without that colon, as in `path@2x.png` or an e-mail address, the value is shown as given and holds no password. A network error adds `code`, such as `EAI_AGAIN`. An unknown option, a second domain and a missing domain return `{ "error": "..." }` only, with no target, and also exit with code `2`. `--help` exits with code `0`, and `--version` or `-V` prints the installed version and exits with code `0`.

## What it checks

### File structure

| # | Check | Failure | Warning |
| --- | --- | --- | --- |
| 1 | `/llms.txt` returns HTTP 200 | Non-200 response, rejected or excessive redirects | none |
| 2 | Response is plain text | Body looks like an HTML page | The media type, read without its parameters, is neither `text/plain` nor `text/markdown` |
| 3 | First non-empty line is a Markdown H1, written `# Title` or as one line of text underlined with `=` | Missing H1, a title indented as a code block, or an H1 with no text | none |
| 4 | Blockquote summary follows the title | none | Missing summary, a blockquote block in which no line has text after the `>`, or a blockquote after other text but before the first H2, named by its line |
| 5 | H2 sections group the content | none | No H2 sections, no section with a Markdown link list, a heading between the title and the first H2, or a second H1 |
| 6 | Markdown links have names and absolute HTTP or HTTPS targets | none | Missing links, empty names, relative targets or targets that do not parse as HTTP or HTTPS URLs |
| 7 | File is small enough to read cheaply | none | Over 50 KB, or truncated at the 256 KB read limit |
| 8 | File contains no HTML markup | none | An opening tag with its closing `>`, a closing tag or an HTML comment is found anywhere in the file, including inside code spans and fenced code. An attribute name is any run of characters other than white space, quotes, `<`, `>`, `/` and `=` that holds a Unicode letter, a Unicode digit or the character `_`, so `<div @click="x">` warns. Autolinks such as `<https://example.com>` and prose such as `a <b + c` are not tags. A tag still open at the end of the file, such as `<div class="x"`, has no closing `>` and does not warn |

Links are read the way CommonMark reads them for the forms listed here. A link inside inline code, after an escaped bracket or in an image does not count, and a link in an ordered list, a target in angle brackets and a target with a title in double or single quotes do. A title in parentheses is not read, so `[Guide](https://example.org/guide (Overview))` is not collected. An unbracketed target ends at its first closing parenthesis, so `https://example.org/docs_(v2)` is read only up to `https://example.org/docs_(v2`. Write a target that contains parentheses in angle brackets. A link reference definition or label that spans several lines, and an image used as a reference, are not handled. A quote escaped with a backslash inside a link title, as in `[A](https://example.org/a "Ti\"tle\"")`, is not recognised, so that link is dropped. A title that spans a line break is dropped the same way. Nested brackets in a link label, as in `[A [x] B](https://example.org/a)`, drop the link. A heading is an H2 when `##` is followed by a space or a tab, or when it is one line of text underlined with hyphens. The text line must follow a blank line or the start of the file. A list item above a line of hyphens is not an H2, and neither is a line of hyphens after a blank line. A link in a four-space indented code block counts as a link, but such a block does not count as a file list under an H2. A backslash escape in a target is resolved before the URL test, so `https\://example.org/guide` is read as `https://example.org/guide`. A link label cannot span a blank line. A link on a line that continues a list item, such as the line after a bare `-`, counts as that item's link. After a bare marker the next line counts only when it is indented to the item's content column, which is 2 for `-` and 3 for `1.`, and a blank line right after a bare marker ends the item. After a blank line inside an item, a line counts only when it is indented to the content column, where the item's text starts, so `-   item` needs 4 columns. A code fence indented less than that column ends the item. A fence indented to it keeps the item open, and the line after the fence then counts only when it is indented to that column too. CR and CRLF line endings are read as LF. A setext title, which is a text line underlined with `=`, is read only when it is a single line.

Some failures stop the file checks early. For example, an HTML response is reported as a failed plain-text check rather than parsed as Markdown.

### Home-page discovery

These checks are labelled **v2** in the output. They look for link relations in the home page's HTML head or HTTP `Link` header.

| # | Check | Pass condition | Otherwise |
| --- | --- | --- | --- |
| 9 | Home page points to its llms.txt | `rel="describedby"` has a non-empty target | `info` |
| 10 | Home page points to a Markdown version | `rel="alternate"` has media type `text/markdown` and a non-empty target | `info` |

The validator detects these declarations without fetching their targets. It reads the first 65,536 UTF-16 code units of the head after comments and the contents of script, style, title and template elements have been set aside, and when a relation is missing from a longer head the result says that only that part was read. A target is shown with its credentials and fragment removed and its query values masked. It also does not follow the links inside `llms.txt`, crawl the site or test whether an AI agent can complete a task there.

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

Add this step to a GitHub Actions job that already has Node.js 22 or newer available. Replace `your-domain.com` with your domain:

```yaml
- name: Validate llms.txt
  run: npx --yes turva-llms-txt-validator your-domain.com --strict
```

The same command works in Woodpecker and other runners with Node installed. Omit `--strict` if warnings should remain advisory.

## Fetch limits and security

The default validation requests two documents: `https://<host>/llms.txt` and `https://<host>/`. Redirects may add requests, but linked pages and discovery targets are never fetched. The validator stores no results.

- Timeout: eight seconds per document, shared across its redirect chain.
- Read limit: 256 KB per response.
- Redirects: up to four hops, over HTTPS, to the same host or its `www`/apex equivalent. Off-site redirects, embedded credentials and unsupported ports are rejected. A redirect target is reported with its credentials and fragment removed and its query values masked, whether the redirect was followed or rejected.
- Host checks: IP literals, bracketed IPv6 addresses, localhost and the internal-use TLDs `localdomain`, `local`, `internal`, `home`, `lan`, `corp`, `test`, `invalid`, `arpa` and `onion` are rejected before a request is sent. An address that holds `@`, `?` or `#` is not repeated in the error message, because it can carry a user name, a password or a query value. One trailing dot on the host you give, as in `example.com.`, is removed first. Redirect targets are checked too.

**DNS resolution is not checked for private addresses.** A syntactically public domain can resolve to a private IP, so if you expose this package through a service that accepts untrusted domains, enforce private-address restrictions at the network layer. Local and CI runs use their own network policy. The hosted validator runs on the Cloudflare edge.

For vulnerability reporting and supported versions, see [SECURITY.md](https://github.com/erekola/llms-txt-validator/blob/main/SECURITY.md).

## Verify a release

GitHub Actions publishes every version from 0.1.3 on with npm trusted publishing, and each one carries a provenance attestation. To check one, install it in an empty directory and ask npm to verify the signatures. Replace the version with the one you want to check.

```sh
mkdir verify-llms && cd verify-llms && npm init -y && npm install turva-llms-txt-validator@0.3.18 --ignore-scripts && npm audit signatures
```

`npm audit signatures` checks the registry signature and the provenance attestation of each installed package that has one. The attestation of this package names three things to compare with what you expect: the repository `github.com/erekola/llms-txt-validator`, the workflow file `.github/workflows/publish.yml` and the commit that produced the tarball. The npm version page shows them under Provenance. Tag `v0.3.18` must point at that same commit, and `gh api repos/erekola/llms-txt-validator/commits/v0.3.17 --jq .sha` prints it. A mismatch is a reason not to use that version. Provenance proves where a release was built and from which commit. It does not prove that the code is safe, so reading the source and the dependencies stays your job.

## Hosted version and source

The [hosted validator](https://turva.dev/llms-txt-validator) accepts any public domain in the browser. It requests the same two documents, `/llms.txt` and the home page, and runs the same checks. Its source is in the [turva.dev Cloudflare Worker](https://github.com/erekola/turva-worker). The hosted validator is the canonical implementation: if results diverge, this package is updated to match it.

The hosted version also returns JSON with the same result shape for a completed validation. Its errors are shaped differently: an `error` field with HTTP status 400 and no `target`. The site-wide rate limiter can also answer HTTP 429 as plain text, with a `Retry-After` header, before the validator runs, and that answer is not JSON.

The JSON request:

```sh
curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"
```

In Windows PowerShell, use `curl.exe` if `curl` resolves to `Invoke-WebRequest`.

The package has no runtime dependencies. The repository's release workflow uses npm trusted publishing with provenance. See [SECURITY.md](https://github.com/erekola/llms-txt-validator/blob/main/SECURITY.md) for details and [CHANGELOG.md](https://github.com/erekola/llms-txt-validator/blob/main/CHANGELOG.md) for releases.

## Check HTML and Markdown content

[markdown-parity-check](https://github.com/erekola/markdown-parity-check) is a separate tool for a different question. This validator reads the structure of `llms.txt` and the home page's discovery links. The parity check compares the main content of one page's HTML and Markdown versions and reports changed text, numbers, links or blocks. It requires Node.js 22 or newer:

```sh
npx --yes markdown-parity-check --url https://example.com/page --format json
```

Replace the URL with your page. If Markdown is served at another address, add `--markdown-url https://example.com/page.md`. Its [browser version](https://turva.dev/markdown-parity-check) on turva.dev checks turva.dev's own pages only. See the [comparison README](https://github.com/erekola/markdown-parity-check) for local-file mode, exit codes and limits.

## License

[MIT](LICENSE). Built by [Erik Rekola](https://github.com/erekola) at [turva.dev](https://turva.dev).
