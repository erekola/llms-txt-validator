# turva-llms-txt-validator

A command-line tool and TypeScript library that checks a website's `llms.txt`. It runs eight structure checks and two informational discovery checks and prints the result as readable text or JSON.

The result describes the file's structure and the home page's discovery links. It does not measure overall agent readiness or predict AI-search citations.

Links: [npm package](https://www.npmjs.com/package/turva-llms-txt-validator), [try it in your browser](https://turva.dev/llms-txt-validator), [llms.txt guide](https://turva.dev/guides/llms-txt) and [all turva.dev tools](https://turva.dev/tools).

## Quick start

The package needs **Node.js 22 or newer**. It is MIT licensed and has no runtime dependencies.

Run it without installing anything:

```sh
npx --yes turva-llms-txt-validator example.com
```

Install the CLI globally for repeated use:

```sh
npm install -g turva-llms-txt-validator
llms-txt-validate example.com
```

Add it to a project as a library:

```sh
npm install turva-llms-txt-validator
```

## Command line

```text
llms-txt-validate <domain-or-url> [--json] [--strict]
llms-txt-validate --help
llms-txt-validate --version
```

A domain, an HTTP URL or an HTTPS URL is accepted. Validation always uses the host's `/llms.txt` and home page over HTTPS, regardless of the supplied path. If the address has a path other than `/` or `/llms.txt`, the result names that path first in an `info` line.

| Option | Effect |
| --- | --- |
| `--json` | Print the result as JSON instead of text. |
| `--strict` | Exit with code `1` when the summary is `valid with warnings`. |
| `--help`, `-h` | Print usage and exit with code `0`. |
| `--version`, `-V` | Print the installed version and exit with code `0`. |

### Read the result

This is the first part of the CLI output for `turva.dev` on 2026-10-21. The remaining checks are omitted here:

```text
https://turva.dev/llms.txt
  ok    File exists at /llms.txt (HTTP 200)
  ok    Response is plain text (text/plain)
  ok    Starts with an H1 title ("# turva.dev")
  ok    Blockquote summary after the title ("> Agent-readiness audits and advisory for product teams.")
  ok    H2 sections group the content (9 sections, 5 carrying a file list)
  ok    Markdown links an agent can follow (83 links, all absolute URLs)
  ok    Small enough to be cheap to read (11358 bytes)
```

The summary comes last, as `result: valid` for this run. Each preceding line reports one check. A `warn` identifies something to review, such as a missing blockquote summary. It does not fail the command unless you add `--strict`. A `FAIL` means a structural requirement failed. Each line includes the observed detail.

### Exit codes

The eight structure checks determine the summary:

| Summary | Meaning | Default exit code | With `--strict` |
| --- | --- | --- | --- |
| `valid` | No structure warnings or failures | `0` | `0` |
| `valid with warnings` | At least one warning, no failures | `0` | `1` |
| `not valid` | At least one failure | `1` | `1` |
| Input or fetch error | Validation could not complete | `2` | `2` |

The two discovery checks return `pass` or `info`. They never change the summary or exit code, including in strict mode. If the home page cannot be read, those checks report `info`. The file's structure result still stands.

### JSON output

```sh
npx --yes turva-llms-txt-validator example.com --json --strict
```

Completed validation returns `{ target, summary, checks }`, where `target` is `https://<host>/llms.txt`. Each check contains `{ id, status, label, detail }`. Read `id` and `status` in a script, because the wording of `detail` can change between versions. The `input-path` check, which reports a path given with the domain and then ignored, also carries `value`, that path cut to 120 characters.

The validator removes C0 and C1 control characters, bidirectional controls and invisible characters from the `detail` text, which can quote the checked site. The invisible characters are chosen by Unicode class, not from a list: every format character, which is General_Category Cf, every Default_Ignorable_Code_Point and the line and paragraph separators U+2028 and U+2029. That covers the zero-width characters, the left-to-right and right-to-left marks, the Arabic letter mark, the word joiner and the invisible math operators, the soft hyphen, the byte-order mark, the variation selectors, the combining grapheme joiner, the Hangul fillers and the tag characters U+E0000 to U+E007F. Spaces stay: the no-break space and U+2000 to U+200A. The zero-width non-joiner and joiner go too, so a quoted Persian, Malayalam or Devanagari word loses its joining marks and reads without them. The Arabic number signs U+0600 to U+0605 go as well. Until 0.8.0 only the bidi controls and the C0 and C1 controls were removed, and the invisible characters stayed in the text and in the JSON. An emoji sequence in quoted text loses its zero-width joiners and its variation selector: a family emoji reads as its members side by side, a heart written with U+FE0F shows in text style, a keycap sequence loses the selector, and a tag flag shows as its black flag. The emoji themselves, skin tone modifiers, regional indicators and combining marks stay.

With `--json`, an invalid domain or a failed fetch returns `{ "error": "...", "target": "..." }` and exits with code `2`. A network error adds `code`, such as `EAI_AGAIN`. An unknown option, a second domain and a missing domain return `{ "error": "..." }` only, with no target, and also exit with code `2`.

In an error report the `target` is the address given on the command line. When it parses as a URL with a host, the user name and password are removed and each query value becomes `***`. Other values follow these cases:

- In a value such as `user:secret@example.com` or `example.org:8443#a@b`, the part before the colon reads as a URL scheme and no authority follows it, so only `//***` is shown.
- A value with no scheme and no slash is read as user information when a colon comes before its last `@`, so `user_name:secret@example.com` is shown as `***@example.com`.
- Without that colon, as in `path@2x.png` or an e-mail address, the value is shown as given and holds no password.
- An address that holds an `@` shows only `***`, with the scheme in front when a slash follows its colon and with no host, when a URL parser and a person would read it differently. That covers a backslash, a `?` or a `#` before the `@` and before any `/`, and a start that is not exactly a scheme, two slashes and a character other than a slash. `https://user:pa?ss@example.com/`, `https://example.org?e=a@b.com` and `https:///host?e=a@b.com` are shown as `https://***`. `user:secret@host.example://dd`, where no slash follows the scheme colon, is shown as `//***`. A redirect to such an address is reported as "a different host that this report does not name". A `/` before the `@` makes it a path, and a relative reference such as `/a@b` or `docs/@name` is masked as before.
- Text before `://` that a URL parser does not accept as a scheme, such as `my_app://user:secret@host/p`, `1app://user:secret@host/p` or `ht tps://user:secret@host/p`, is masked from the text: everything up to the last `@` is shown as `***`.

## What it checks

### File structure

| # | Check | Failure | Warning |
| --- | --- | --- | --- |
| 1 | `/llms.txt` returns HTTP 200 | Non-200 response, rejected or excessive redirects | none |
| 2 | Response is plain text | Body looks like an HTML page | The media type, read without its parameters, is neither `text/plain` nor `text/markdown` |
| 3 | First non-empty line is a Markdown H1, written `# Title` or as one line of text underlined with `=` | Missing H1, a title indented as a code block, or an H1 with no text | none |
| 4 | Blockquote summary follows the title | none | Missing summary, a blockquote block in which no line has text after the `>`, or a blockquote after other text but before the first H2, named by its line |
| 5 | H2 sections group the content | none | No H2 sections, no section with a Markdown link list, a heading between the title and the first H2, or a second H1 |
| 6 | Markdown links have names and absolute HTTP or HTTPS targets | none | Missing links, empty names, relative targets or targets that do not parse as HTTP or HTTPS URLs, or a list line under an H2 of one of two kinds. The first kind looks like a link entry but is not a Markdown link, such as an unclosed destination in `- [Name](https://example.com/a.md: notes)`. The second kind opens with an en dash, an em dash or a bullet instead of a list marker, whether or not its link parses. The detail has one sentence per kind, each with its count and the first five line numbers |
| 7 | File is small enough to read cheaply | none | Over 50 KiB, which is 51,200 bytes, or truncated at the 256 KiB read limit |
| 8 | File contains no HTML markup | none | An opening tag with its closing `>`, a closing tag or an HTML comment is found in the prose. Inline code spans, fenced code and backslash-escaped angle brackets such as `\<node-name\>` are not read, so `<endpoint-id>` in a code span does not warn. An attribute name is any run of characters other than white space, quotes, `<`, `>`, `/` and `=` that holds a Unicode letter, a Unicode digit or the character `_`, so `<div @click="x">` warns. Autolinks such as `<https://example.com>` and prose such as `a <b + c` are not tags. A tag still open at the end of the file, such as `<div class="x"`, has no closing `>` and does not warn |

Some failures stop the file checks early. For example, an HTML response is reported as a failed plain-text check rather than parsed as Markdown.

### How links, headings and list items are read

Links are read the way CommonMark reads them for the forms listed here.

- A link inside inline code, after an escaped bracket or in an image does not count.
- Inline code pairs only inside one block, the way CommonMark reads blocks. A blank line, a heading, a list item, a block quote line, a thematic break and a setext underline each end a block. The lines of one block quote belong to one block. An empty quote line ends it, and a lazy line after a quote line goes on with it. A backtick pair inside one quote is therefore inline code, and a pair across the edge of a quote is not. An empty list item or a numbered item that does not start at 1 does not end a paragraph, unless the line closes an open list item. A backtick pair across such a line is therefore inline code. The content of a quote is not read further. Raw HTML blocks are not blocks for the HTML check, so there a backtick pair across one is still inline code. The links check treats the lines of an HTML block as blank and the block as the end of the paragraph before it.
- A fence inside a list item counts as a fence, closed or not, in either fence character. It may sit on the marker line or up to three columns past the item's content column. It ends when the item closes. Four or more columns past that column is indented code.
- A link in an ordered list, a target in angle brackets and a target with a title in double or single quotes do count.
- A title in parentheses is not read, so `[Guide](https://example.org/guide (Overview))` is not collected.
- An unbracketed target keeps balanced parentheses, so `https://example.org/docs_(v2)` is read whole. A target with an unbalanced parenthesis is not a link, and neither is a reference definition whose destination is unbalanced. Write a target with an unbalanced parenthesis in angle brackets or escape the parenthesis. The nesting depth is not limited, where CommonMark stops at 32.
- A link reference definition or label that spans several lines is not handled. A reference image whose label has a definition is skipped like an inline image. An empty target, `[Guide]()` or `[Guide](<>)`, is a link with an empty target and counts as a relative link.
- A link written inside the description text of an image, as in `![alt [Guide](https://example.org/a)](https://example.org/img.png)`, does not count. An image without a target (`![alt [Guide](https://example.org/a)]`) is read the way CommonMark reads it: the inner link counts.
- A pair of brackets inside a code span, as in `` [`Array[T]` reference](https://example.org/a) ``, neither closes nor opens a label. A link label ends where its paragraph ends. A line that can interrupt the paragraph, such as a heading, a bullet, a number starting at 1, a quote or a fence, therefore means there is no link. A backslash at the end of a line is a hard line break and escapes nothing, so the label does not continue into the next line: `- [Guide\` followed by `- more](https://example.org/a)` is two list items and no link. Until 0.8.0 the label continued into the next list item or heading.
- A shortcut reference `[Guide]` counts after a colon in the same line and after an inline target that did not parse, as in `[Guide](not a link)`. A `[Guide]:` at the start of a definition line does not resolve against itself.
- A link reference definition opens only where a block starts. It can open, for example, after a blank line, a heading, a fence or a thematic break. It can also open at the start of a quote, as a list item or right after another definition. A line that continues a paragraph or a list item is not a definition. A definition indented four columns or more inside a list item is not read. A link written in the destination of a definition line is still counted as a link.
- Labels match by Unicode case folding. Character references in a target need their semicolon: `https&#58;//example.org` decodes, `https&#58//example.org` stays as written. A no-break or ideographic space is part of a target. Only an ASCII space, a tab or another control character ends one.
- In this validator a raw HTML block is one of types 1 to 7 of CommonMark, and it is read only where its start is certain. The opener must be on the first line, after a blank line, or after a heading that itself stood at such a place. It must be indented at most three columns and stand outside every open list item. Under a paragraph line, a quote line, a list item line or another HTML line the opener hides nothing, and the lines after it keep their ordinary reading. The lines of a block hold no links, definitions, list items or headings for the checks. A `## Docs` line inside such a block is part of the block and no H2 section. Examples are the line between `<?x` and `?>` and the line directly under a `<div>` that stands after a blank line, with no blank line between them. Until 0.8.0 such a line counted as a section. The no-HTML check still reads them. A fence opener inside an HTML block is still read as a fence.
- A title, a link name or a summary whose text is only character references to white space, code spans of white space or empty quote markers counts as empty: `# &#32;`, `` [` `](https://example.org/a) ``, `>>` and `> >`. A line with only a no-break or ideographic space is not a blank line.
- A quote escaped with a backslash inside a link title, as in `[A](https://example.org/a "Ti\"tle\"")`, is not recognised, so that link is dropped. A title that spans a line break is dropped the same way.
- Nested brackets in a link label, as in `[A [x] B](https://example.org/a)`, drop the link. A link label cannot span a blank line.
- A backslash escape in a target is resolved before the URL test, so `https\://example.org/guide` is read as `https://example.org/guide`.
- CR and CRLF line endings are read as LF. A setext title, which is a text line underlined with `=`, is read only when it is a single line.

A heading is an H2 when `##` is followed by a space or a tab, or when it is one line of text underlined with hyphens. The text line must follow a blank line or the start of the file. A list item above a line of hyphens is not an H2, and neither is a line of hyphens after a blank line. A line inside a raw HTML block is not a heading either.

A link in a four-space indented code block counts as a link unless a backtick pair encloses it. Such a block does not count as a file list under an H2, inside a list item (five or more spaces after the marker, or six columns after a blank line under `- item`) or outside one.

A link on a line that continues a list item, such as the line after a bare `-`, counts as that item's link:

- After a bare marker the next line counts only when it is indented to the item's content column, which is 2 for `-` and 3 for `1.`. A blank line right after a bare marker ends the item.
- After a blank line inside an item, a line counts only when it is indented to the content column, where the item's text starts, so `-   item` needs 4 columns.
- A code fence indented less than that column ends the item. A fence indented to it keeps the item open, and a lazy continuation cannot follow a fence, so the line after it needs the indent too.
- In a nested list, the content column of any item still open is enough for a line after a blank line or a fence.

### Home-page discovery

These checks are labelled **v2** in the output. They look for link relations in the home page's HTML head or HTTP `Link` header.

| # | Check | Pass condition | Otherwise |
| --- | --- | --- | --- |
| 9 | Home page points to its llms.txt | `rel="describedby"` has a non-empty target | `info` |
| 10 | Home page points to a Markdown version | `rel="alternate"` has media type `text/markdown` and a non-empty target | `info` |

The validator detects these declarations without fetching their targets. It reads the first 65,536 UTF-16 code units of the head after comments and the contents of script, style, title, noscript, noframes and template elements have been set aside. When a relation is missing from a longer head, the result says that only that part was read. Inside a script, `<!-->` and `<!--->` end the comment escape at once, as the HTML tokenizer reads them, and a `<template>` inside `<svg>` or `<math>` is an ordinary element that opens no template level. Until 0.8.0 both shapes made the scan skip a relation that the parser puts in the head, or read one that it moves into the body.

The home page itself is read up to 256 KiB. When a relation is missing, the info text names at most one of the two limits. If the head is longer than 65,536 characters, it names that limit, "in the first 65,536 characters of the head, the part that was read, or in the Link header", even when the page was also cut at 256 KiB. If the head is within the limit and the page was cut at 256 KiB, it says "in the first 256 KiB of the home page, the part that was read, or in the Link header". With neither limit reached it says "in the head or the Link header". A relation found in the part that was read is reported as found. A target is shown with its credentials and fragment removed and its query values masked.

A `Link` header value that has an `anchor` parameter is used only when the anchor is empty or resolves to the home page address. This is because an anchored value describes another resource.

The validator does not follow the links inside `llms.txt`, crawl the site or test whether an AI agent can complete a task there.

## Use from Node and TypeScript

The package is an ES module written in TypeScript. It ships its type declarations, so no `@types` package is needed.

```ts
import { validateHost } from "turva-llms-txt-validator";
import type { ValidationResult, LlmsCheck } from "turva-llms-txt-validator";

const result: ValidationResult = await validateHost("example.com");
console.log(result.summary);

const problems: LlmsCheck[] = result.checks.filter(
  (check) => check.status === "warn" || check.status === "fail",
);
for (const check of problems) {
  console.log(check.status, check.label, check.detail);
}
```

`validateHost(input, options?)` returns a `Promise<ValidationResult>`. The result has `target`, `summary` and `checks`. `summary` is one of `"valid"`, `"valid with warnings"` and `"not valid"`, typed as `ChecksSummary`. Each `LlmsCheck` has `id`, `status`, `label` and `detail`, and an optional `value`. `status` is a `CheckStatus`, one of `"pass"`, `"warn"`, `"fail"` and `"info"`. The optional second argument is typed as `ValidateHostOptions`.

`validateHost` rejects on invalid input or a failed `/llms.txt` fetch. Structural failures are returned in `checks` with the summary `not valid`.

The package also exports the helper functions and types behind `validateHost`, such as `fetchLlmsTxt`, `validateLlmsTxt` and `maskLocation`. The hosted validator keeps its own copies of the same logic. These exports are not documented here as a stable interface. Treat `validateHost` and the types above as the supported surface.

### Options for library callers

`validateHost(input, options)` and `fetchLlmsTxt(host, options)` take the same `ValidateHostOptions`. The command line sets none of them.

| Option | Meaning | Accepted values |
| --- | --- | --- |
| `timeoutMs` | Time budget for one document, shared across its redirect chain. The default is `8000`. | An integer from 1 to 2,147,483,647. |
| `cap` | Read limit in bytes per response. The default is `262144`, which is 256 KiB. | An integer from 1 to 2,097,152. |
| `userAgent` | Value of the `user-agent` request header. | A string that the platform accepts as a header value. |
| `accept` | Value of the `accept` request header, read by `fetchLlmsTxt`. | A string that the platform accepts as a header value. |
| `path` | Path and query of the request, read by `fetchLlmsTxt`. The default is `/llms.txt`. | A string that starts with a single `/`. |

`validateHost` pins its two reads to `/llms.txt` and `/`, each with its own `accept` value, so it ignores `path` and `accept`.

A call rejects before any request is sent when an option is outside these values. `undefined` and `null` mean the default for `timeoutMs`, `cap` and `path`. `timeoutMs` and `cap` reject with a `RangeError`: `NaN`, `Infinity`, `0`, a negative number, a fraction, a string and a value above the maximum are all refused. Until 0.8.0, `NaN` and `Infinity` as `cap` switched the read limit off, and a `cap` of several megabytes could end in an internal `RangeError`. The maximum of `cap` is there because the HTML check reads the whole body with one pattern, and a body of several megabytes of attribute-like text made it run out of stack.

`path` rejects with a `TypeError` when it does not start with a single `/` or holds a C0 control character or DEL. C1 control characters are accepted. This covers an empty string, `x`, `:8443/x`, `@host/x`, `//host/x`, a backslash right after the slash, an absolute URL and a query or fragment alone. Such a path could change the port or the host of the request. A path that starts with a single `/` can carry only a path and a query, and the request keeps the host that was checked.

The size note of check 7 says "over 256 KiB, read truncated" whatever `cap` is, because the check only reads whether the body was cut.

The package calls the `fetch` of the process it runs in. A replaced global `fetch`, a proxy or disabled certificate checks in that process change what the guarantees on this page mean.

## Use in CI

Add this step to a GitHub Actions job that already has Node.js 22 or newer available. Replace `your-domain.com` with your domain:

```yaml
- name: Validate llms.txt
  run: npx --yes turva-llms-txt-validator your-domain.com --strict
```

Any CI runner with Node.js 22 or newer can run the same command. Omit `--strict` if warnings should remain advisory.

## Fetch limits and security

The default validation requests two documents: `https://<host>/llms.txt` and `https://<host>/`. Redirects may add requests, but linked pages and discovery targets are never fetched. The validator stores no results.

- Timeout: eight seconds per document, shared across its redirect chain.
- Read limit: 256 KiB, which is 262,144 bytes, per response by default. A file cut there gets the size note "over 256 KiB, read truncated". A library caller can change the limit, see the options above.
- Redirects: up to four hops, over HTTPS, to the same host or its `www`/apex equivalent. Off-site redirects, embedded credentials and unsupported ports are rejected. A redirect target is reported with its credentials and fragment removed and its query values masked, whether the redirect was followed or rejected.
- Host checks: IP literals, bracketed IPv6 addresses, localhost and the internal-use TLDs `localdomain`, `local`, `internal`, `home`, `lan`, `corp`, `test`, `invalid`, `arpa` and `onion` are rejected before a request is sent. An address that holds `@`, `?` or `#` is not repeated in the error message, because it can carry a user name, a password or a query value. One trailing dot on the host you give, as in `example.com.`, is removed first. Redirect targets are checked too, and one trailing dot on a redirect target is removed the same way.

**DNS resolution is not checked for private addresses.** A syntactically public domain can resolve to a private IP, so if you expose this package through a service that accepts untrusted domains, enforce private-address restrictions at the network layer. Local and CI runs use their own network policy. The hosted validator runs on the Cloudflare edge.

For vulnerability reporting and supported versions, see [SECURITY.md](https://github.com/erekola/llms-txt-validator/blob/main/SECURITY.md).

## Release process

The source is TypeScript under `src/` and `bin/`, compiled with `tsc` to `dist/`. The tarball ships only `dist/src/index.js`, `dist/src/index.d.ts`, `dist/bin/cli.js`, the README, the license, the third-party notices and `package.json`, which npm always includes. `dist/` is generated, and `npm pack` builds it through the `prepack` script.

GitHub Actions tests Node.js 22, 24 and 26 on Ubuntu and Node.js 22 on Windows. A version tag starts the release workflow, `.github/workflows/publish.yml`. It runs the type check and the tests, and it fails when the tag and `package.json` name different versions. It then publishes with npm trusted publishing over OIDC and creates the GitHub release from the CHANGELOG section. npm writes a provenance attestation. No npm token is stored in the repository or in the workflow.

## From JavaScript to TypeScript

Up to 0.3.21 the package was plain JavaScript modules, starting with `src/index.mjs`. Version 0.4.0, released on 21 October 2026, ports it to TypeScript compiled to `dist/`, and the entry point moved to `dist/src/index.js` behind the same `exports` name. The compiled library has the same 12 493 JavaScript tokens as 0.3.21, apart from the relative path to `package.json`. A differential run fed both versions 4 160 000 generated `llms.txt` inputs and 832 000 HTML heads and found no difference. The CLI kept its flags, its output and its exit codes.

The strict type check found two inputs that could leave `undefined` in a check's detail. Neither `fetchLlmsTxt` nor `validateHost` produces them, and 0.4.1 fixed both. Each release is described in [CHANGELOG.md](https://github.com/erekola/llms-txt-validator/blob/main/CHANGELOG.md).

## Verify a release

GitHub Actions publishes every version from 0.1.3 on with npm trusted publishing, and each one carries a provenance attestation. To check one, install it in an empty directory and ask npm to verify the signatures. Replace the version with the one you want to check.

```sh
mkdir verify-llms && cd verify-llms && npm init -y && npm install turva-llms-txt-validator@0.8.0 --ignore-scripts && npm audit signatures
```

`npm audit signatures` checks the registry signature and the provenance attestation of each installed package that has one. The attestation of this package names three things to compare with what you expect: the repository `github.com/erekola/llms-txt-validator`, the workflow file `.github/workflows/publish.yml` and the commit that produced the tarball. The npm version page shows them under Provenance.

Tag `v0.8.0` must point at that same commit, and `gh api repos/erekola/llms-txt-validator/commits/v0.8.0 --jq .sha` prints it. A mismatch is a reason not to use that version. Provenance proves which workflow built a release and from which commit. It does not prove that the code is safe, so reading the source and the dependencies stays your job.

## Development

```sh
git clone https://github.com/erekola/llms-txt-validator.git
cd llms-txt-validator
npm ci --ignore-scripts
npm run typecheck
npm test
```

`npm test` builds `dist/` first and then runs the tests against the compiled output. `npm run build` compiles without testing. `npm run typecheck` runs `tsc --noEmit`. The npm page shows this README from the tarball, so a change to it reaches npm only with a new version.

## Hosted version and source

The [hosted validator](https://turva.dev/llms-txt-validator) accepts any public domain in the browser. For any host other than turva.dev itself it requests the same two documents, `/llms.txt` and the home page. For turva.dev it validates the site's own files directly, without a request. The hosted validator reads www.turva.dev the same way and reports https://turva.dev/llms.txt as the target. This package requests www.turva.dev as typed, follows its redirect and reports https://www.turva.dev/llms.txt. It runs the same checks. Its source is in the [turva.dev Cloudflare Worker](https://github.com/erekola/turva-worker). The hosted validator is the canonical implementation: if results diverge, this package is updated to match it.

The hosted version also returns JSON with the same result shape for a completed validation. Its errors are shaped differently: an `error` field, plus a `docs` link when the `url` parameter is missing, with HTTP status 400 and no `target`. The site-wide rate limiter can also answer HTTP 429 as plain text, with a `Retry-After` header, before the validator runs, and that answer is not JSON.

The JSON request:

```sh
curl -H "Accept: application/json" "https://turva.dev/llms-txt-validator?url=example.com"
```

In Windows PowerShell, use `curl.exe` if `curl` resolves to `Invoke-WebRequest`.

## Check HTML and Markdown content

[markdown-parity-check](https://github.com/erekola/markdown-parity-check) is a separate tool for a different question. This validator reads the structure of `llms.txt` and the home page's discovery links. The parity check compares the main content of one page's HTML and Markdown versions and reports changed text, numbers, links or blocks. It requires Node.js 22 or newer:

```sh
npx --yes markdown-parity-check --url https://example.com/page --format json
```

Replace the URL with your page. If Markdown is served at another address, add `--markdown-url https://example.com/page.md`. Its [browser version](https://turva.dev/markdown-parity-check) on turva.dev checks turva.dev's own pages only. See the [comparison README](https://github.com/erekola/markdown-parity-check) for local-file mode, exit codes and limits.

## License

[MIT](LICENSE). Built by [Erik Rekola](https://github.com/erekola) at [turva.dev](https://turva.dev).
